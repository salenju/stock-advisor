// 收益趋势：基于「腾讯日K线 / 东财基金净值」历史收盘价 + 交易记录，逐日重放计算。
// 口径与 server.js 的 withDerived 完全一致：
//   持仓收益(t) = Σ 市值(t) − 累计买入成本(≤t) + 累计卖出金额(≤t)     （折算人民币）
//   今日收益(t) = (当日收盘 − 前收盘) × 当日持仓数量                    （折算人民币）
// 历史日期统一按「当前配置汇率」折算人民币（v1 约定，见 docs/自测清单.md）。
import { getRates } from './provider/fx.js';
import { fxToCNY, currencyOf } from './currency.js';
import { normalizeRegion, toTencentCode } from './provider/tencent.js';

const KLINE_BASE = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';
const FUND_NAV_URL = (code) => `https://fund.eastmoney.com/pingzhongdata/${code}.js`;
const CACHE_TTL_MS = 10 * 60 * 1000; // K线缓存 10 分钟

// code → { fetchedAt, bars: [{date, close}] }
const klineCache = new Map();

// 抓取单只标的历史收盘价（日线，前复权）
// 返回 [{date:'YYYY-MM-DD', close:number}]；失败/无数据返回 []
async function fetchCloses(code) {
  const cached = klineCache.get(code);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.bars;

  let bars = [];
  const url = `${KLINE_BASE}?param=${encodeURIComponent(code)},day,,,365,qfq`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://gu.qq.com' } });
    if (res.ok) {
      const json = await res.json();
      const day = json?.data?.[code]?.day;
      if (Array.isArray(day)) {
        bars = day
          .filter((r) => Array.isArray(r) && r[0] && Number.isFinite(parseFloat(r[2])))
          .map((r) => ({ date: String(r[0]).slice(0, 10), close: parseFloat(r[2]) }));
      }
    }
  } catch (e) {
    console.warn(`[trend] kline ${code} 失败: ${e.message}`);
  }

  // 腾讯无K线（场外基金等）→ 回退东财历史净值（需裸 6 位代码，去掉市场前缀）
  if (!bars.length && /^\d{6}$/.test(code.replace(/\D/g, ''))) {
    bars = await fetchFundNavs(code.replace(/^[A-Za-z]+/, ''));
  }

  if (bars.length) klineCache.set(code, { fetchedAt: Date.now(), bars });
  return bars;
}

// 东财基金历史净值（复权净值序列）
async function fetchFundNavs(code) {
  try {
    const res = await fetch(FUND_NAV_URL(code), {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://fundf10.eastmoney.com/' },
    });
    if (!res.ok) return [];
    const text = await res.text();
    const m = text.match(/Data_netWorthTrend\s*=\s*(\[[\s\S]*?\]);/);
    if (!m) return [];
    const arr = JSON.parse(m[1]);
    return arr
      .filter((r) => r && r.x && Number.isFinite(Number(r.y)))
      .map((r) => ({ date: new Date(r.x).toISOString().slice(0, 10), close: Number(r.y) }));
  } catch (e) {
    console.warn(`[trend] fund nav ${code} 失败: ${e.message}`);
    return [];
  }
}

/**
 * 纯函数：由「持仓交易记录 + 各标的收盘价序列」计算逐日收益序列。
 * @param {Array} holdings 持仓数组（含 id/region/currency/purchases/sells）
 * @param {Object} closesByCode { 行情代码: [{date, close}] } —— 未覆盖的标的不参与计算
 * @param {Object} rates 汇率 { CNY:1, HKD, USD }
 * @param {Object} [opts] { maxDays?: number } 仅取最近 N 个日期
 * @returns {{ dates: string[], holdingProfit: number[], todayProfit: number[], marketValue: number[], skipped: string[] }}
 */
export function buildTrendSeries(holdings, closesByCode, rates, opts = {}) {
  const byId = new Map(holdings.map((h) => [h.id, h]));
  const skipped = [];

  // 每只持仓：code → bars
  const barMap = new Map();
  for (const h of holdings) {
    const code = toTencentCode(h.region, h.code);
    const bars = closesByCode[code] || [];
    if (!bars.length) {
      skipped.push(`${h.name}(${code})`);
      continue;
    }
    barMap.set(h.id, {
      h,
      code,
      bars: [...bars].sort((a, b) => a.date.localeCompare(b.date)),
    });
  }

  // 日期轴：所有参与标的价格日期的并集（升序）
  const axis = new Set();
  for (const { bars } of barMap.values()) for (const b of bars) axis.add(b.date);
  let dates = [...axis].sort();
  if (opts.maxDays && dates.length > opts.maxDays) dates = dates.slice(-opts.maxDays);

  // 日期 → 指数下标（便于二分/向前找最近收盘）
  const idx = new Map(dates.map((d, i) => [d, i]));

  // key 可为字段名或 (x)=>number 计算函数
  const sum = (arr, key) =>
    arr.reduce(
      (s, x) => s + (typeof key === 'function' ? Number(key(x)) || 0 : Number(x[key]) || 0),
      0
    );

  const holdingProfit = new Array(dates.length).fill(0);
  const todayProfit = new Array(dates.length).fill(0);
  const marketValue = new Array(dates.length).fill(0);

  for (const { h, bars } of barMap.values()) {
    const currency = currencyOf(h.region);
    const buys = h.purchases || [];
    const sells = h.sells || [];

    // 每个日期对应的最近收盘价（向前取），没有则跳过该日期
    let bi = 0; // bars 游标
    let prevClose = null;
    let lastBar = null;
    for (let i = 0; i < dates.length; i++) {
      const date = dates[i];
      // 推进到 ≤ date 的最近一根K线
      while (bi < bars.length && bars[bi].date <= date) {
        prevClose = lastBar ? lastBar.close : null; // 前一根收盘（计算今日收益用）
        lastBar = bars[bi];
        bi++;
      }
      if (!lastBar || lastBar.date > date) continue; // 该日期前还没有K线

      const qty = sum(buys.filter((p) => String(p.buyTime || '').slice(0, 10) <= date), 'buyQuantity')
        - sum(sells.filter((s) => String(s.sellDate || '').slice(0, 10) <= date), 'sellQuantity');
      if (qty <= 0) continue;

      const buyCost = sum(buys.filter((p) => String(p.buyTime || '').slice(0, 10) <= date), (p) => Number(p.buyPrice) * Number(p.buyQuantity));
      const sellAmount = sum(sells.filter((s) => String(s.sellDate || '').slice(0, 10) <= date), (s) => Number(s.sellPrice) * Number(s.sellQuantity));

      const mv = lastBar.close * qty;                       // 本地币种市值
      const hp = mv - buyCost + sellAmount;                  // 本地币种持仓收益
      marketValue[i] += fxToCNY(mv, currency, rates);
      holdingProfit[i] += fxToCNY(hp, currency, rates);
      // 今日收益：仅在该标的有当日K线时计算（(当日-前收)×数量）
      if (lastBar.date === date) {
        if (prevClose != null) {
          todayProfit[i] += fxToCNY((lastBar.close - prevClose) * qty, currency, rates);
        }
      }
    }
  }

  return { dates, holdingProfit, todayProfit, marketValue, skipped };
}

// 区间过滤：只保留最近 N 天（按自然日）内的点
export function filterByDays(dates, holdingProfit, todayProfit, marketValue, days) {
  if (!days || days <= 0) return { dates, holdingProfit, todayProfit, marketValue };
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (days - 1));
  cutoff.setHours(0, 0, 0, 0);
  const cut = cutoff.toISOString().slice(0, 10);
  const keep = [];
  for (let i = 0; i < dates.length; i++) if (dates[i] >= cut) keep.push(i);
  return {
    dates: keep.map((i) => dates[i]),
    holdingProfit: keep.map((i) => holdingProfit[i]),
    todayProfit: keep.map((i) => todayProfit[i]),
    marketValue: keep.map((i) => marketValue[i]),
  };
}

// 对外入口：给一批持仓计算趋势序列（网络拉取 + 缓存）
export async function buildTrend(holdings, cfg) {
  const rates = getRates(cfg);
  const closesByCode = {};
  const active = holdings.filter((h) => h.status === '持有' || !h.status);
  for (const h of active) {
    const code = toTencentCode(h.region, h.code);
    closesByCode[code] = await fetchCloses(code);
  }
  const series = buildTrendSeries(active, closesByCode, rates);
  series.rates = rates;
  return series;
}
