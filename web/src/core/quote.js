// 前端行情（本地数据模式）。
//
// 数据源与后端保持一致：
//   股票/ETF → 腾讯 qt.gtimg.cn 实时报价（实测返回 Access-Control-Allow-Origin: *，可直接 fetch）
//   场外基金 → 东方财富 pingzhongdata/{code}.js 净值序列
//
// 为什么基金要用 <script> 加载：api.fund.eastmoney.com 不返回 CORS 头，
// 浏览器 fetch 会被拦；而 pingzhongdata 的 Content-Type 是 application/javascript，
// 通过 script 标签注入不受同源策略限制（它同时给出历史净值，Phase 2 的趋势图也能复用）。
import { fetchPrices, toTencentCode } from './provider/tencent.js';
import { updatePeak } from './strategy.js';

const FUND_TTL_MS = 10 * 60 * 1000; // 基金净值 10 分钟缓存（一日一更，不必频繁拉）
const KLINE_TTL_MS = 10 * 60 * 1000;

// code → { fetchedAt, bars: [{date, close}] }
const fundCache = new Map();

/** 是否为场外基金（与 server/scheduler.js 的判断一致） */
export function isFundHolding(h) {
  return String(h?.type || '').includes('基金');
}

/** 行情缓存 key：基金用裸代码，股票用腾讯代码 */
export function quoteKey(h) {
  return isFundHolding(h) ? String(h.code) : toTencentCode(h.region, h.code);
}

function loadScript(src, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    const cleanup = () => {
      clearTimeout(timer);
      el.remove();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('加载超时'));
    }, timeoutMs);
    el.onload = () => {
      cleanup();
      resolve();
    };
    el.onerror = () => {
      cleanup();
      reject(new Error('加载失败'));
    };
    document.head.appendChild(el);
  });
}

/**
 * 拉取基金历史净值序列（script 注入东财 pingzhongdata）。
 * @param {string} code 6 位基金代码
 * @returns {Promise<Array<{date:string, close:number}>>} 按日期升序
 */
export async function loadFundNavSeries(code) {
  const hit = fundCache.get(code);
  if (hit && Date.now() - hit.fetchedAt < FUND_TTL_MS) return hit.bars;
  try {
    window.Data_netWorthTrend = undefined; // 清掉上一支的全局变量，避免读到旧数据
    await loadScript(`https://fund.eastmoney.com/pingzhongdata/${code}.js`);
    const arr = window.Data_netWorthTrend;
    const bars = Array.isArray(arr)
      ? arr
          .filter((r) => r && r.x && Number.isFinite(Number(r.y)))
          .map((r) => ({ date: new Date(Number(r.x)).toISOString().slice(0, 10), close: Number(r.y) }))
          .sort((a, b) => a.date.localeCompare(b.date))
      : [];
    if (bars.length) fundCache.set(code, { fetchedAt: Date.now(), bars });
    else console.warn(`[quote] 基金 ${code} 未取到净值序列`);
    return bars;
  } catch (e) {
    console.warn(`[quote] 基金 ${code} 净值加载失败：${e.message}`);
    return [];
  }
}

/** 基金最新净值与上一交易日净值 → { price, prevClose } */
async function fetchFundLatest(codes) {
  const out = {};
  for (const code of codes) {
    const bars = await loadFundNavSeries(code);
    if (bars.length) {
      out[code] = {
        price: bars[bars.length - 1].close,
        prevClose: bars.length > 1 ? bars[bars.length - 2].close : null,
      };
    }
  }
  return out;
}

/**
 * 拉取一批持仓的最新行情。
 * @returns {Promise<{prices:Object, errors:string[], fundFailed:string[]}>}
 */
export async function fetchQuotes(holdings) {
  const errors = [];
  const list = (holdings || []).filter((h) => h?.code && h?.region);
  const stockCodes = list.filter((h) => !isFundHolding(h)).map((h) => toTencentCode(h.region, h.code));
  const fundCodes = [...new Set(list.filter(isFundHolding).map((h) => String(h.code)))];

  const [stockPrices, fundPrices] = await Promise.all([
    fetchPrices(stockCodes).catch((e) => {
      errors.push(`股票行情：${e.message}`);
      return {};
    }),
    fetchFundLatest(fundCodes).catch((e) => {
      errors.push(`基金净值：${e.message}`);
      return {};
    }),
  ]);

  return { prices: { ...stockPrices, ...fundPrices }, errors, fundFailed: [] };
}

/**
 * 把行情写入持仓（原地修改）。含后端同款防御：
 *   ① 无行情 / 价格 ≤ 0（停牌、字段缺失）跳过
 *   ② 单日涨跌幅超过阈值（多为错价）跳过
 * @param {Array} holdings
 * @param {Object} prices { 行情代码: {price, prevClose} }
 * @param {{nowIso?:string, maxMovePct?:number}} [opts]
 * @returns {{changed:boolean, quoteOk:number, quoteFail:number, lastError:string|null}}
 */
export function applyQuotes(holdings, prices, opts = {}) {
  const nowIso = opts.nowIso || new Date().toISOString();
  const maxMove = Number(opts.maxMovePct) > 0 ? Number(opts.maxMovePct) : 50;
  let changed = false;
  let quoteOk = 0;
  let quoteFail = 0;
  let lastError = null;

  for (const h of holdings || []) {
    const q = prices?.[quoteKey(h)];
    if (!q || !(Number(q.price) > 0)) {
      quoteFail += 1;
      continue;
    }
    const prevClose = Number(q.prevClose);
    const moveRate = prevClose > 0 ? ((Number(q.price) - prevClose) / prevClose) * 100 : 0;
    if (prevClose > 0 && Math.abs(moveRate) > maxMove) {
      quoteFail += 1;
      lastError = `${h.code} 单日波动 ${moveRate.toFixed(2)}% 超阈值 ${maxMove}%，已跳过`;
      continue;
    }

    quoteOk += 1;
    h.currentPrice = Number(q.price);
    h.prevClose = prevClose > 0 ? prevClose : null;
    h.lastUpdated = nowIso;
    // 移动止盈基准：记录持仓期最高收益率
    if (updatePeak(h)) changed = true;
  }

  return { changed, quoteOk, quoteFail, lastError };
}

/** 只拉指定持仓的行情并写入（供"刷新"按钮使用） */
export async function refreshQuotes(holdings, opts = {}) {
  const { prices, errors } = await fetchQuotes(holdings);
  const res = applyQuotes(holdings, prices, opts);
  return { ...res, errors };
}
