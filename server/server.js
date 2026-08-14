import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';
import { loadHoldings, saveHoldings } from './store.js';
import { sendCard } from './notifier.js';
import { importCsvText } from './import-csv-core.js';
import { currencyOf, currencyCode } from './currency.js';
import { getRates } from './provider/fx.js';
import { buildTrend, filterByDays } from './trend.js';

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

function pid() {
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// 单条买入记录派生（基于当前价）
function derivePurchase(p, currentPrice) {
  const price = Number(currentPrice);
  const buyPrice = Number(p.buyPrice) || 0;
  const qty = Number(p.buyQuantity) || 0;
  const cost = buyPrice * qty;
  const hasPrice = price != null && !Number.isNaN(price);
  const marketValue = hasPrice ? price * qty : null;
  const profit = hasPrice ? price * qty - cost : null;
  const returnRate =
    hasPrice && buyPrice > 0 ? ((price - buyPrice) / buyPrice) * 100 : null;
  // 止盈价 = 买入价 * (1 + 止盈%)；止损价 = 买入价 * (1 - 止亏%)
  const targetPrice =
    buyPrice > 0 && p.targetProfitRate != null
      ? buyPrice * (1 + Number(p.targetProfitRate) / 100)
      : null;
  const stopLossPrice =
    buyPrice > 0 && p.stopLossRate != null
      ? buyPrice * (1 - Number(p.stopLossRate) / 100)
      : null;
  return {
    ...p,
    cost,
    marketValue,
    profit,
    returnRate,
    targetPrice,
    stopLossPrice,
  };
}

// 卖出记录派生字段
function deriveSell(s) {
  const qty = Number(s.sellQuantity) || 0;
  const sellPrice = Number(s.sellPrice) || 0;
  const costPrice = Number(s.costPrice) || 0;
  const cost = costPrice * qty;
  const amount = sellPrice * qty;
  const profit = Number(s.profit) ?? ((sellPrice - costPrice) * qty);
  const returnRate = Number(s.returnRate) ?? (costPrice > 0 ? ((sellPrice - costPrice) / costPrice) * 100 : 0);
  return {
    type: 'SELL',
    id: s.id,
    buyTime: s.sellDate || s.sellTime, // 统一用 buyTime 作为日期字段
    buyPrice: sellPrice,
    buyQuantity: qty,
    cost,
    marketValue: amount,
    profit,
    returnRate,
    targetProfitRate: null,
    stopLossRate: null,
    targetPrice: null,
    stopLossPrice: null,
  };
}

// 派生展示字段（汇总 + 每次买入明细 + 今日/持仓收益）
function withDerived(h) {
  const price = h.currentPrice;
  const prevClose = h.prevClose;
  const currency = currencyOf(h.region); // 按地区映射币种（A股人民币/港股港币/美股美元）

  const purchases = (h.purchases || [])
    .map((p) => derivePurchase(p, price))
    .sort((a, b) => String(b.buyTime || '').localeCompare(String(a.buyTime || '')));

  const sells = (h.sells || [])
    .map((s) => deriveSell(s))
    .sort((a, b) => String(b.buyTime || '').localeCompare(String(a.buyTime || '')));

  // 合并买入/卖出记录统一展示（买入收益置 null → 前端显示 "-- / --"）
  const transactions = [
    ...purchases.map((p) => ({ ...p, type: 'BUY', profit: null, returnRate: null })),
    ...sells,
  ].sort((a, b) => String(b.buyTime || '').localeCompare(String(a.buyTime || '')));

  const totalCost = purchases.reduce((s, p) => s + p.cost, 0);
  const totalQuantity = purchases.reduce((s, p) => s + Number(p.buyQuantity) || 0, 0);
  const totalSoldQty = sells.reduce((s, sel) => s + (Number(sel.buyQuantity) || 0), 0);
  const totalSoldCost = sells.reduce((s, sel) => s + (Number(sel.cost) || 0), 0);
  const unsoldQuantity = Math.max(totalQuantity - totalSoldQty, 0);
  // 剩余仓位成本 = 总买入成本 - 已卖出部分的成本
  const remainingCost = Math.max(totalCost - totalSoldCost, 0);
  const avgCost = unsoldQuantity > 0 ? remainingCost / unsoldQuantity : 0;

  // 已实现盈利 = 所有卖出记录的 profit 之和
  const realizedProfit = sells.reduce((s, sel) => s + (Number(sel.profit) || 0), 0);
  // 未实现盈利 = (现价 - 均价) * 未卖出数量
  const unrealizedProfit =
    price != null && unsoldQuantity > 0 && avgCost > 0
      ? (Number(price) - avgCost) * unsoldQuantity
      : null;

  const marketValue =
    price != null ? Number(price) * unsoldQuantity : null;

  // 需求 3.2：持仓收益 = 未实现 + 已实现
  const holdingProfit =
    unrealizedProfit != null
      ? unrealizedProfit + realizedProfit
      : realizedProfit !== 0
        ? realizedProfit
        : null;
  const holdingReturnRate =
    totalCost > 0 && holdingProfit != null
      ? (holdingProfit / totalCost) * 100
      : null;

  // 需求 3.1：今日收益仅用未卖出数量
  const todayProfit =
    price != null && prevClose != null && unsoldQuantity > 0
      ? (Number(price) - Number(prevClose)) * unsoldQuantity
      : null;
  const todayReturnRate =
    price != null && prevClose != null && Number(prevClose) > 0
      ? ((Number(price) - Number(prevClose)) / Number(prevClose)) * 100
      : null;

  // 最近买入价（按买入时间取最新一条）
  const lastBuyPrice =
    purchases.length > 0
      ? [...purchases].sort((a, b) => String(b.buyTime).localeCompare(String(a.buyTime)))[0].buyPrice
      : 0;

  // 持仓级止盈/止亏 = 按成本加权的买入记录均值
  const wTarget =
    totalCost > 0
      ? purchases.reduce((s, p) => s + (Number(p.targetProfitRate) || 0) * p.cost, 0) / totalCost
      : 0;
  const wStop =
    totalCost > 0
      ? purchases.reduce((s, p) => s + (Number(p.stopLossRate) || 0) * p.cost, 0) / totalCost
      : 0;

  return {
    ...h,
    currency,                          // CNY / HKD / USD（按地区映射）
    currencyCode: currencyCode(currency),
    purchases,
    transactions,                    // 前端表用此字段展示（含买入+卖出）
    cost: remainingCost,
    buyQuantity: unsoldQuantity,
    sellQuantity: totalSoldQty,
    unsoldQuantity,
    avgCost,
    lastBuyPrice,
    marketValue,
    holdingProfit,
    holdingReturnRate,
    todayProfit,
    todayReturnRate,
    targetProfitRate: Number(h.targetProfitRate ?? wTarget) || wTarget,
    stopLossRate: Number(h.stopLossRate ?? wStop) || wStop,
    dropRate:
      price != null && lastBuyPrice > 0
        ? ((lastBuyPrice - price) / lastBuyPrice) * 100
        : null,
  };
}

// 由买入/卖出记录反推剩余持仓的成本/数量/均价（落盘前同步）
function syncFromPurchases(h) {
  const totalBuy = (h.purchases || []).reduce(
    (s, p) => s + (Number(p.buyPrice) || 0) * (Number(p.buyQuantity) || 0), 0
  );
  const totalBuyQty = (h.purchases || []).reduce(
    (s, p) => s + (Number(p.buyQuantity) || 0), 0
  );
  // 扣除已卖出部分的成本（每笔 sell 的 costPrice 是在卖出时按 LIFO 计算的均价）
  const totalSellCost = (h.sells || []).reduce(
    (s, sel) => s + (Number(sel.costPrice) || 0) * (Number(sel.sellQuantity) || 0), 0
  );
  const totalSellQty = (h.sells || []).reduce(
    (s, sel) => s + (Number(sel.sellQuantity) || 0), 0
  );
  const remainingCost = Math.max(totalBuy - totalSellCost, 0);
  const remainingQty = Math.max(totalBuyQty - totalSellQty, 0);
  const avgCost = remainingQty > 0 ? remainingCost / remainingQty : 0;

  const lastBuyPrice =
    (h.purchases || []).length > 0
      ? [...h.purchases].sort((a, b) => String(b.buyTime).localeCompare(String(a.buyTime)))[0].buyPrice
      : 0;
  const totalC = totalBuy || 1;
  const wTarget = (h.purchases || []).reduce(
    (s, p) => s + (Number(p.targetProfitRate) || 0) * (Number(p.buyPrice) * Number(p.buyQuantity)), 0
  ) / totalC;
  const wStop = (h.purchases || []).reduce(
    (s, p) => s + (Number(p.stopLossRate) || 0) * (Number(p.buyPrice) * Number(p.buyQuantity)), 0
  ) / totalC;
  h.cost = remainingCost;
  h.buyQuantity = remainingQty;
  h.lastBuyPrice = lastBuyPrice;
  h.avgCost = avgCost;
  if (wTarget) h.targetProfitRate = +wTarget.toFixed(2);
  if (wStop) h.stopLossRate = +wStop.toFixed(2);
  return h;
}

function normalizePurchase(b, id) {
  const buyPrice = Number(b.buyPrice);
  const buyQuantity = Number(b.buyQuantity);
  if (!(buyPrice > 0) || !(buyQuantity > 0)) {
    throw new Error('买入价/买入数量必须为正');
  }
  return {
    id: id || pid(),
    buyPrice,
    buyQuantity,
    buyTime: b.buyTime || b.date || new Date().toISOString().slice(0, 10),
    targetProfitRate: Number(b.targetProfitRate) || 0,
    stopLossRate: Number(b.stopLossRate) || 0,
  };
}

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
    snapshotDate: b.snapshotDate || today,
    snapshotProfit: Number(b.snapshotProfit) || 0,
    snapshotReturnRate: Number(b.snapshotReturnRate) || 0,
    position: Number(b.position) || 0,
    purchases,
    sells: [],                      // 卖出记录（独立于买入记录）
    // 补仓计划（持仓级）
    refillDropRate: Number(b.refillDropRate) || 0,
    refillPrice: Number(b.refillPrice) || 0,
    nextStrategy: b.nextStrategy || '',
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

// 应用一笔买入/卖出交易
function applyTransaction(h, txn) {
  const qty = Number(txn.quantity);
  const price = Number(txn.price);
  if (!qty || !price) throw new Error('quantity / price 必须为正');

  if (txn.type === 'BUY') {
    h.purchases = h.purchases || [];
    h.purchases.push(
      normalizePurchase({
        buyPrice: price,
        buyQuantity: qty,
        buyTime: txn.date,
        targetProfitRate: h.targetProfitRate || 0,
        stopLossRate: h.stopLossRate || 0,
      })
    );
    h.status = '持有';
  } else if (txn.type === 'SELL') {
    // 需求 1：不修改买入记录，添加一条卖出记录
    h.sells = h.sells || [];
    // LIFO 计算卖出部分的成本
    const sorted = [...(h.purchases || [])].sort((a, b) =>
      String(b.buyTime).localeCompare(String(a.buyTime))
    );
    let remaining = qty;
    let totalCost = 0;
    for (const p of sorted) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, Number(p.buyQuantity) || 0);
      totalCost += take * (Number(p.buyPrice) || 0);
      remaining -= take;
    }
    if (remaining > 0) throw new Error('卖出数量超过持仓数量');

    const costPrice = totalCost / qty;
    const profit = (price - costPrice) * qty;
    const returnRate = costPrice > 0 ? ((price - costPrice) / costPrice) * 100 : 0;
    h.sells.push({
      id: pid(),
      sellPrice: price,
      sellQuantity: qty,
      sellDate: txn.date || new Date().toISOString().slice(0, 10),
      costPrice,
      profit,
      returnRate,
    });

    // 更新持仓状态
    const totalBought = (h.purchases || []).reduce((s, p) => s + (Number(p.buyQuantity) || 0), 0);
    const totalSold = (h.sells || []).reduce((s, sel) => s + (Number(sel.sellQuantity) || 0), 0);
    h.status = totalSold >= totalBought ? '全部卖出' : '持有';
  } else {
    throw new Error('type 必须为 BUY 或 SELL');
  }

  syncFromPurchases(h);
  // 交易后重置触发态，下一轮重新评估
  h.triggerState = 'IDLE';
  h.notifiedAt = null;
  return h;
}

async function handleApi(req, res, url, cfg) {
  // 列表（含币种字段与汇率配置）
  if (req.method === 'GET' && url.pathname === '/api/holdings') {
    const list = await loadHoldings();
    return sendJSON(res, 200, {
      data: list.map(withDerived),
      fx: { rates: getRates(cfg), source: 'config/env' },
    });
  }

  // 收益趋势（逐日重放计算，历史收盘价来自腾讯K线/东财净值，按配置汇率折算人民币）
  // range: day(今天) | 7d(近7天) | 30d(近30天) | all(全部)
  if (req.method === 'GET' && url.pathname === '/api/trend') {
    const range = url.searchParams.get('range') || '30d';
    const days = { day: 2, '7d': 7, '30d': 30, all: 0 }[range] ?? 30;
    const list = await loadHoldings();
    const active = list.filter((h) => h.status === '持有');
    const series = await buildTrend(active, cfg);
    const filtered = filterByDays(
      series.dates, series.holdingProfit, series.todayProfit, series.marketValue, days
    );
    return sendJSON(res, 200, {
      ...filtered,
      currency: 'CNY',
      rates: series.rates,
      skipped: series.skipped,
      range,
    });
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
      result = importCsvText(list, csv, { createMissing: !!body.createMissing });
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

  // 更新持仓级字段（日涨跌告警阈值等）
  let m = url.pathname.match(/^\/api\/holdings\/([^/]+)$/);
  if (req.method === 'PATCH' && m) {
    const list = await loadHoldings();
    const h = list.find((x) => x.id === m[1]);
    if (!h) return sendJSON(res, 404, { error: '持仓不存在' });
    const body = await readBody(req);
    if (body.dailyDropAlertPct !== undefined) h.dailyDropAlertPct = body.dailyDropAlertPct != null ? Number(body.dailyDropAlertPct) : null;
    if (body.dailyRiseAlertPct !== undefined) h.dailyRiseAlertPct = body.dailyRiseAlertPct != null ? Number(body.dailyRiseAlertPct) : null;
    // 重置每日告警标记，让下次触发立即推送
    h.dailyAlertSentDate = null;
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
    h.triggerState = 'IDLE';
    h.notifiedAt = null;
    await saveHoldings(list);
    return sendJSON(res, 200, { data: withDerived(h) });
  }

  // 修改某条买入记录的止盈/止亏比例
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
    if (body.buyTime !== undefined && body.buyTime) p.buyTime = body.buyTime;
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
    if (h.purchases.length === 0) h.status = '已卖出';
    await saveHoldings(list);
    return sendJSON(res, 200, { data: withDerived(h) });
  }

  // 对已有持仓追加买入/卖出记录（兼容旧接口）
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
      console.error('[server]', e.message);
      if (!res.headersSent) sendJSON(res, 500, { error: e.message });
    }
  });

  server.listen(port, host, () => {
    console.log(`前端页面已启动: http://${host}:${port}`);
  });
  return server;
}
