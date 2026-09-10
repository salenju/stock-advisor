import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';
import { loadHoldings, saveHoldings, storeInfo } from './store.js';
import { sendCard } from './notifier.js';
import { importCsvText } from './import-csv-core.js';
import { getRates, fxInfo } from './provider/fx.js';
import { buildTrend, filterByDays } from './trend.js';
import {
  withDerived,
  syncFromPurchases,
  applyTransaction,
  normalizePurchase,
  normalizeCostMethod,
  recomputeSells,
  dateKey,
  isActive,
  COST_METHODS,
} from './derive.js';
import { buildStats } from './stats.js';
import { loadSnapshots, mergeSnapshots } from './snapshot.js';
import { runtime } from './runtime.js';
import { logger, loggerInfo } from './logger.js';

// 投资策略枚举：集中定义，后续新增/修改策略只需在此处增删条目。
// 每个条目含 value（落盘值）/ label（展示文案）/ cls（标签配色）。
export const INVEST_STRATEGIES = [
  { value: 'long', label: '长期持有', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-600/20 dark:text-emerald-400' },
  { value: 'mid', label: '中线持有', cls: 'bg-sky-100 text-sky-700 dark:bg-sky-600/20 dark:text-sky-400' },
  { value: 'short', label: '短线持有', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-600/20 dark:text-amber-400' },
  { value: 'highrisk', label: '高风险博弈', cls: 'bg-rose-100 text-rose-700 dark:bg-rose-600/20 dark:text-rose-400' },
];

const __dirname = dirname(fileURLToPath(import.meta.url));
// Vite 打包产物目录（npm run build 生成）
const DIST = join(__dirname, '..', 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// 托管前端静态产物：先尝试精确文件路径，否则回退到 index.html（SPA 兜底）
async function serveStatic(res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = join(DIST, normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
  try {
    const st = await stat(filePath);
    if (st.isFile()) {
      const body = await readFile(filePath);
      res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
      return res.end(body);
    }
  } catch {
    // 文件不存在，回退到 index.html
  }
  const html = await readFile(join(DIST, 'index.html'));
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

// 读取请求原始文本（供 CSV 等非 JSON 载荷使用）
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ---------- 鉴权 ----------
// config.auth.token 非空时，所有写接口与读取接口都要求携带 token，
// 防止同局域网/公网下他人随意读取或篡改你的投资数据。
// 支持三种携带方式：Authorization: Bearer <token> / x-auth-token 头 / ?token=<token>
function authOk(req, url, cfg) {
  const expect = String(cfg?.auth?.token || '').trim();
  if (!expect) return true;
  const h = req.headers || {};
  const bearer = String(h.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const header = String(h['x-auth-token'] || '').trim();
  const query = String(url.searchParams.get('token') || '').trim();
  return bearer === expect || header === expect || query === expect;
}

// ---------- CSV 导出 ----------

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(header, rows) {
  // 加 BOM 便于 Excel 正确识别中文
  return '\uFEFF' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}

function buildTradesCsv(holdings) {
  const header = ['代码', '名称', '地区', '类型', '操作', '日期', '价格', '数量', '手续费', '成本价', '盈亏', '收益率%'];
  const rows = [];
  for (const h of holdings) {
    const d = withDerived(h);
    for (const p of d.purchases) {
      rows.push([h.code, h.name, h.region, h.type, '买入', dateKey(p.buyTime), p.buyPrice, p.buyQuantity, p.fee || 0, '', '', '']);
    }
    for (const s of d.sells) {
      rows.push([h.code, h.name, h.region, h.type, '卖出', s.buyTime, s.buyPrice, s.buyQuantity, s.fee || 0, s.cost, s.profit, s.returnRate]);
    }
    for (const v of d.dividends) {
      rows.push([h.code, h.name, h.region, h.type, '分红', v.buyTime, '', '', v.fee || 0, '', v.profit, '']);
    }
  }
  rows.sort((a, b) => String(a[5]).localeCompare(String(b[5])));
  return toCsv(header, rows);
}

function buildStatsCsv(holdings, rates) {
  const stats = buildStats(holdings, rates);
  const header = ['代码', '名称', '状态', '成本法', '买入成本(CNY)', '卖出金额(CNY)', '手续费', '分红', '已实现盈亏(CNY)', '已实现收益率%', '首次买入', '最后卖出', '持有天数'];
  const rows = stats.items.map((i) => [
    i.code, i.name, i.status, i.costMethod, i.buyCostCNY, i.sellAmountCNY,
    i.feesTotal, i.dividend, i.realizedProfitCNY, i.realizedReturnRate,
    i.firstBuy || '', i.lastSell || '', i.holdDays ?? '',
  ]);
  return toCsv(header, rows);
}

// ---------- 持仓构造 ----------

function createHolding(b) {
  const today = new Date().toISOString().slice(0, 10);
  const required = ['name', 'code', 'region', 'type'];
  for (const k of required) {
    if (!b[k] || !String(b[k]).trim()) throw new Error(`缺少字段: ${k}`);
  }

  // 允许「先建仓、后补买入记录」：purchases 可空，买入价/数量由「买入记录」补充
  let purchases = [];
  if (Array.isArray(b.purchases) && b.purchases.length) {
    purchases = b.purchases.map((p) => normalizePurchase(p));
  }

  const h = {
    id: 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: String(b.name).trim(),
    code: String(b.code).trim(),
    status: '持有',
    region: b.region,
    type: b.type,
    strategy: b.strategy || '',
    costMethod: normalizeCostMethod(b.costMethod),
    snapshotDate: b.snapshotDate || today,
    snapshotProfit: Number(b.snapshotProfit) || 0,
    snapshotReturnRate: Number(b.snapshotReturnRate) || 0,
    position: Number(b.position) || 0,
    purchases,
    sells: [],                      // 卖出记录（独立于买入记录）
    dividends: [],                  // 现金分红记录
    splits: [],                     // 送转 / 拆股记录
    // 补仓计划（持仓级）
    refillDropRate: Number(b.refillDropRate) || 0,
    refillPrice: Number(b.refillPrice) || 0,
    nextStrategy: b.nextStrategy || '',
    // 移动止盈：持仓期最高收益率回撤该幅度即提醒（null=关闭）
    trailingStopPct: b.trailingStopPct != null ? Number(b.trailingStopPct) : null,
    peakReturnRate: null,
    // 日涨跌飞书告警阈值（百分比，为空=不告警）
    dailyDropAlertPct: b.dailyDropAlertPct != null ? Number(b.dailyDropAlertPct) : null,
    dailyRiseAlertPct: b.dailyRiseAlertPct != null ? Number(b.dailyRiseAlertPct) : null,
    dailyAlertSentDate: null,
    currentPrice: null,
    prevClose: null,
    lastUpdated: null,
    triggerState: 'IDLE',
    notifiedAt: null,
  };
  return syncFromPurchases(h);
}

async function handleApi(req, res, url, cfg) {
  // 健康检查：公开（便于监控），不含个人持仓明细
  if (req.method === 'GET' && url.pathname === '/api/health') {
    const list = await loadHoldings().catch(() => []);
    const fx = fxInfo(cfg);
    return sendJSON(res, 200, {
      ok: true,
      uptimeMs: Date.now() - runtime.startedAt,
      node: process.version,
      holdings: { total: list.length, active: list.filter(isActive).length },
      tick: {
        lastAt: runtime.lastTickAt,
        mode: runtime.lastTickMode,
        durationMs: runtime.lastTickMs,
        quoteOk: runtime.lastTickQuoteOk,
        quoteFail: runtime.lastTickQuoteFail,
      },
      quotes: { ok: runtime.quoteOk, fail: runtime.quoteFail, lastError: runtime.lastQuoteError },
      push: { lastAt: runtime.lastPushAt, ok: runtime.lastPushOk, error: runtime.lastPushError },
      fx: { source: runtime.fxSource || fx.source, updatedAt: runtime.fxUpdatedAt || fx.updatedAt, error: runtime.fxError, rates: fx.rates },
      daily: { snapshotDate: runtime.lastSnapshotDate, reportDate: runtime.lastReportDate },
      store: storeInfo(),
      logging: loggerInfo(),
    });
  }

  // 其余接口统一鉴权
  if (!authOk(req, url, cfg)) {
    return sendJSON(res, 401, { error: '未授权：请在 config.json 配置 auth.token 并在请求中携带' });
  }

  // 列表（含币种字段与汇率配置）
  if (req.method === 'GET' && url.pathname === '/api/holdings') {
    const list = await loadHoldings();
    const fx = fxInfo(cfg);
    return sendJSON(res, 200, {
      data: list.map(withDerived),
      fx: { rates: fx.rates, source: fx.source, updatedAt: fx.updatedAt, autoUpdate: fx.autoUpdate },
      costMethods: COST_METHODS,
    });
  }

  // 收益趋势（逐日重放计算，历史收盘价来自腾讯K线/东财净值，按配置汇率折算人民币）
  // 每日快照优先覆盖同日期（真实记录），K线重放补齐其余日期。
  // range: day(今天) | 7d(近7天) | 30d(近30天) | all(全部)
  if (req.method === 'GET' && url.pathname === '/api/trend') {
    const range = url.searchParams.get('range') || '30d';
    const days = { day: 2, '7d': 7, '30d': 30, all: 0 }[range] ?? 30;
    const list = await loadHoldings();
    const active = list.filter(isActive);
    const series = await buildTrend(active, cfg);
    const snaps = await loadSnapshots().catch(() => []);
    const merged = mergeSnapshots(series, snaps);
    const filtered = filterByDays(
      merged.dates, merged.holdingProfit, merged.todayProfit, merged.marketValue, days
    );
    return sendJSON(res, 200, {
      ...filtered,
      currency: 'CNY',
      rates: series.rates,
      skipped: series.skipped,
      snapshots: snaps.length,
      range,
    });
  }

  // 每日快照列表
  if (req.method === 'GET' && url.pathname === '/api/snapshots') {
    const snaps = await loadSnapshots();
    const range = url.searchParams.get('range') || 'all';
    const days = { '30d': 30, '90d': 90, '365d': 365, all: 0 }[range] ?? 0;
    let out = snaps;
    if (days > 0) {
      const cut = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      out = snaps.filter((s) => s.date >= cut);
    }
    return sendJSON(res, 200, { data: out, total: snaps.length });
  }

  // 收益归因统计（已清仓表现 / 胜率 / 年度已实现收益）
  if (req.method === 'GET' && url.pathname === '/api/stats/closed') {
    const list = await loadHoldings();
    const stats = buildStats(list, getRates(cfg));
    return sendJSON(res, 200, { data: stats });
  }

  // CSV 导出：scope=trades(交易明细) | stats(收益归因) | snapshots(每日快照)
  if (req.method === 'GET' && url.pathname === '/api/export') {
    const scope = url.searchParams.get('scope') || 'trades';
    const list = await loadHoldings();
    let csv;
    if (scope === 'stats') csv = buildStatsCsv(list, getRates(cfg));
    else if (scope === 'snapshots') {
      const snaps = await loadSnapshots();
      csv = toCsv(
        ['日期', '在仓品种', '总成本(CNY)', '总市值(CNY)', '持仓收益(CNY)', '未实现(CNY)', '累计已实现(CNY)', '今日收益(CNY)'],
        snaps.map((s) => [s.date, s.activeCount, s.cost, s.marketValue, s.holdingProfit, s.unrealizedProfit, s.realizedProfit, s.todayProfit])
      );
    } else csv = buildTradesCsv(list);
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="stock-advisor-${scope}-${new Date().toISOString().slice(0, 10)}.csv"`,
    });
    return res.end(csv);
  }

  // 导入 CSV 买卖记录（按「代码」匹配，已有明细忽略，缺失插入）
  // body: { csv: string, createMissing?: boolean }
  if (req.method === 'POST' && url.pathname === '/api/import-csv') {
    const raw = await readRawBody(req);
    let body = {};
    if (raw) {
      try { body = JSON.parse(raw); } catch { /* 忽略，视为空 */ }
    }
    const csv = typeof body.csv === 'string' ? body.csv : '';
    if (!csv.trim()) return sendJSON(res, 400, { error: '缺少 csv 内容' });
    const list = await loadHoldings();
    let result;
    try {
      result = importCsvText(list, csv, {
        createMissing: !!body.createMissing,
        costMethod: normalizeCostMethod(body.costMethod),
      });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
    await saveHoldings(list);
    return sendJSON(res, 200, { data: result });
  }

  // 新建持仓（买入建仓）
  if (req.method === 'POST' && url.pathname === '/api/holdings') {
    const body = await readBody(req);
    let h;
    try {
      h = createHolding(body);
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
    const list = await loadHoldings();
    list.push(h);
    await saveHoldings(list);
    return sendJSON(res, 201, { data: withDerived(h) });
  }

  // 更新持仓级字段（告警阈值 / 成本法 / 移动止盈 / 补仓计划 / 下阶段策略）
  let m = url.pathname.match(/^\/api\/holdings\/([^/]+)$/);
  if (req.method === 'PATCH' && m) {
    const list = await loadHoldings();
    const h = list.find((x) => x.id === m[1]);
    if (!h) return sendJSON(res, 404, { error: '持仓不存在' });
    const body = await readBody(req);
    const numOrNull = (v) => (v != null && v !== '' ? Number(v) : null);
    if (body.dailyDropAlertPct !== undefined) h.dailyDropAlertPct = numOrNull(body.dailyDropAlertPct);
    if (body.dailyRiseAlertPct !== undefined) h.dailyRiseAlertPct = numOrNull(body.dailyRiseAlertPct);
    if (body.trailingStopPct !== undefined) {
      h.trailingStopPct = numOrNull(body.trailingStopPct);
      // 关闭或调整移动止盈时重置峰值基准，避免沿用旧的最高点
      if (!(Number(h.trailingStopPct) > 0)) h.peakReturnRate = null;
    }
    if (body.costMethod !== undefined) h.costMethod = normalizeCostMethod(body.costMethod);
    if (body.refillDropRate !== undefined) h.refillDropRate = Number(body.refillDropRate) || 0;
    if (body.refillPrice !== undefined) h.refillPrice = Number(body.refillPrice) || 0;
    if (body.nextStrategy !== undefined) h.nextStrategy = String(body.nextStrategy || '');
    if (body.targetProfitRate !== undefined) h.targetProfitRate = Number(body.targetProfitRate) || 0;
    if (body.stopLossRate !== undefined) h.stopLossRate = Number(body.stopLossRate) || 0;
    if (body.strategy !== undefined) h.strategy = String(body.strategy || '');
    // 重置每日告警标记，让下次触发立即推送
    h.dailyAlertSentDate = null;
    syncFromPurchases(h);
    await saveHoldings(list);
    return sendJSON(res, 200, { data: withDerived(h) });
  }

  // 用当前成本法重算历史卖出成本（口径变更后使用；会改写历史成本，需显式调用）
  m = url.pathname.match(/^\/api\/holdings\/([^/]+)\/recompute$/);
  if (req.method === 'POST' && m) {
    const list = await loadHoldings();
    const h = list.find((x) => x.id === m[1]);
    if (!h) return sendJSON(res, 404, { error: '持仓不存在' });
    recomputeSells(h);
    await saveHoldings(list);
    return sendJSON(res, 200, { data: withDerived(h) });
  }

  // 对已有持仓追加买入记录
  m = url.pathname.match(/^\/api\/holdings\/([^/]+)\/purchases$/);
  if (req.method === 'POST' && m) {
    const list = await loadHoldings();
    const h = list.find((x) => x.id === m[1]);
    if (!h) return sendJSON(res, 404, { error: '持仓不存在' });
    const body = await readBody(req);
    let p;
    try {
      p = normalizePurchase({ ...body, buyTime: body.buyTime || body.date });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
    h.purchases = h.purchases || [];
    h.purchases.push(p);
    h.status = '持有';
    syncFromPurchases(h);
    await saveHoldings(list);
    return sendJSON(res, 200, { data: withDerived(h) });
  }

  // 修改某条买入记录（价格/数量/日期/手续费/止盈止损）
  m = url.pathname.match(/^\/api\/holdings\/([^/]+)\/purchases\/([^/]+)$/);
  if (req.method === 'PATCH' && m) {
    const list = await loadHoldings();
    const h = list.find((x) => x.id === m[1]);
    if (!h) return sendJSON(res, 404, { error: '持仓不存在' });
    const p = (h.purchases || []).find((x) => x.id === m[2]);
    if (!p) return sendJSON(res, 404, { error: '买入记录不存在' });
    const body = await readBody(req);
    if (body.buyPrice !== undefined) {
      const v = Number(body.buyPrice);
      if (v > 0) p.buyPrice = v;
    }
    if (body.buyQuantity !== undefined) {
      const v = Number(body.buyQuantity);
      if (v > 0) p.buyQuantity = v;
    }
    if (body.buyTime !== undefined && body.buyTime) p.buyTime = dateKey(body.buyTime);
    if (body.fee !== undefined) p.fee = Number(body.fee) || 0;
    if (body.targetProfitRate !== undefined) p.targetProfitRate = Number(body.targetProfitRate) || 0;
    if (body.stopLossRate !== undefined) p.stopLossRate = Number(body.stopLossRate) || 0;
    syncFromPurchases(h);
    await saveHoldings(list);
    return sendJSON(res, 200, { data: withDerived(h) });
  }

  // 删除某条买入记录
  if (req.method === 'DELETE' && m) {
    const list = await loadHoldings();
    const h = list.find((x) => x.id === m[1]);
    if (!h) return sendJSON(res, 404, { error: '持仓不存在' });
    const before = (h.purchases || []).length;
    h.purchases = (h.purchases || []).filter((x) => x.id !== m[2]);
    if (h.purchases.length === before) return sendJSON(res, 404, { error: '买入记录不存在' });
    syncFromPurchases(h);
    if (h.purchases.length === 0) h.status = '全部卖出';
    await saveHoldings(list);
    return sendJSON(res, 200, { data: withDerived(h) });
  }

  // 追加交易（BUY / SELL / DIVIDEND / SPLIT）
  m = url.pathname.match(/^\/api\/holdings\/([^/]+)\/transactions$/);
  if (req.method === 'POST' && m) {
    const list = await loadHoldings();
    const h = list.find((x) => x.id === m[1]);
    if (!h) return sendJSON(res, 404, { error: '持仓不存在' });
    const body = await readBody(req);
    try {
      applyTransaction(h, body);
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
    await saveHoldings(list);
    return sendJSON(res, 200, { data: withDerived(h) });
  }

  // 修改交易记录（卖出手续费 / 分红金额 / 送转比例 / 日期 / 备注）
  m = url.pathname.match(/^\/api\/holdings\/([^/]+)\/transactions\/([^/]+)$/);
  if (req.method === 'PATCH' && m) {
    const list = await loadHoldings();
    const h = list.find((x) => x.id === m[1]);
    if (!h) return sendJSON(res, 404, { error: '持仓不存在' });
    const id = m[2];
    const body = await readBody(req);
    const sell = (h.sells || []).find((x) => x.id === id);
    const div = (h.dividends || []).find((x) => x.id === id);
    const split = (h.splits || []).find((x) => x.id === id);
    if (!sell && !div && !split) return sendJSON(res, 404, { error: '交易记录不存在' });
    if (sell) {
      if (body.fee !== undefined) sell.fee = Number(body.fee) || 0;
      if (body.price !== undefined && Number(body.price) > 0) sell.sellPrice = Number(body.price);
      if (body.quantity !== undefined && Number(body.quantity) > 0) sell.sellQuantity = Number(body.quantity);
      if (body.date !== undefined && body.date) sell.sellDate = dateKey(body.date);
    }
    if (div) {
      if (body.amount !== undefined && Number(body.amount) > 0) div.amount = Number(body.amount);
      if (body.fee !== undefined) div.fee = Number(body.fee) || 0;
      if (body.date !== undefined && body.date) div.date = dateKey(body.date);
      if (body.note !== undefined) div.note = String(body.note || '');
    }
    if (split) {
      if (body.ratio !== undefined && Number(body.ratio) > 0) split.ratio = Number(body.ratio);
      if (body.date !== undefined && body.date) split.date = dateKey(body.date);
      if (body.note !== undefined) split.note = String(body.note || '');
    }
    syncFromPurchases(h);
    await saveHoldings(list);
    return sendJSON(res, 200, { data: withDerived(h) });
  }

  // 删除交易记录（卖出 / 分红 / 送转）
  if (req.method === 'DELETE' && m) {
    const list = await loadHoldings();
    const h = list.find((x) => x.id === m[1]);
    if (!h) return sendJSON(res, 404, { error: '持仓不存在' });
    const id = m[2];
    const before = (h.sells || []).length + (h.dividends || []).length + (h.splits || []).length;
    h.sells = (h.sells || []).filter((x) => x.id !== id);
    h.dividends = (h.dividends || []).filter((x) => x.id !== id);
    h.splits = (h.splits || []).filter((x) => x.id !== id);
    const after = (h.sells || []).length + (h.dividends || []).length + (h.splits || []).length;
    if (after === before) return sendJSON(res, 404, { error: '交易记录不存在' });
    syncFromPurchases(h);
    await saveHoldings(list);
    return sendJSON(res, 200, { data: withDerived(h) });
  }

  // 发送一条测试消息到飞书机器人
  if (req.method === 'POST' && url.pathname === '/api/test-feishu') {
    try {
      const data = await sendCard(cfg, {
        trigger: 'BUY',
        name: '测试品种',
        code: 'TEST',
        region: '港股',
        type: '股票',
        currentPrice: '—',
        advice: '这是一条来自「股票秘书」的测试消息，用于验证飞书机器人推送是否正常。',
        summary: '测试消息',
      });
      return sendJSON(res, 200, { ok: true, data });
    } catch (e) {
      return sendJSON(res, 502, { error: '飞书推送失败：' + e.message });
    }
  }

  return sendJSON(res, 404, { error: 'not found' });
}

export function startServer(cfg) {
  const port = cfg.server?.port ?? 3000;
  const host = cfg.server?.host ?? '127.0.0.1';
  const token = String(cfg?.auth?.token || '').trim();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname.startsWith('/api/')) {
        return await handleApi(req, res, url, cfg);
      }
      // 前端静态产物（GET 任意非 /api 路径）
      if (req.method === 'GET') {
        return await serveStatic(res, url);
      }
      res.writeHead(404);
      res.end('not found');
    } catch (e) {
      logger.error('[server]', e.message);
      if (!res.headersSent) sendJSON(res, 500, { error: e.message });
    }
  });

  server.listen(port, host, () => {
    const authNote = token
      ? '已启用接口鉴权（auth.token）'
      : '未启用接口鉴权（如需局域网/公网访问，请在 config.json 设置 auth.token）';
    logger.info(`前端页面已启动: http://${host}:${port}`);
    logger.info(`安全提示：${authNote}`);
  });
  return server;
}
