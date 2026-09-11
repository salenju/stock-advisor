// 交易与持仓的统一派生计算（唯一口径）。
//
// 背景：原先 server.js（withDerived/syncFromPurchases）、strategy.js（agg）、
// import-csv-core.js（computeSellCost/syncFromPurchases）各自实现了一套聚合逻辑，
// 改口径需要改三处，容易出现不一致。本模块把口径收敛为一处，三边共用。
//
// 成本口径（重要）：
//   历史卖出记录的 costPrice / profit 是「录入时点」按当时的持仓批次算出来的，
//   是账本事实，默认原样沿用（不会因为之后补录了某笔买入而被改写）。
//   只有显式要求重算（computePositions(h, {recompute:true})）或历史值缺失时才重算。
//   剩余持仓的成本按「买入总成本 − 已卖出记录的合计成本」闭合，保证与明细自洽。
import { currencyOf, currencyCode } from './currency.js';

// ---------- 基础工具 ----------

export function newId(prefix = 'p') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

const EPS = 1e-9;

// 日期归一化为 YYYY-MM-DD，兼容 ISO 带时间戳 / 2026/1/3 / 2026.1.3。
// 统一后字符串排序 == 时间排序，避免 'ISO 时间戳' 与 '短日期' 混存导致排序错乱。
export function dateKey(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (!m) return s.slice(0, 10);
  return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
}

export const byDateDesc = (a, b) => dateKey(b?.buyTime).localeCompare(dateKey(a?.buyTime));
export const byDateAsc = (a, b) => dateKey(a?.buyTime).localeCompare(dateKey(b?.buyTime));

export const COST_METHODS = ['LIFO', 'FIFO', 'WAC'];
export const COST_METHOD_LABEL = { LIFO: '后进先出', FIFO: '先进先出', WAC: '移动加权平均' };

export function normalizeCostMethod(m) {
  const s = String(m || '').toUpperCase();
  return COST_METHODS.includes(s) ? s : 'LIFO';
}

// 持仓是否仍为"在仓"（未知/空状态按在仓处理，兼容旧数据）
export function isActive(h) {
  const s = String(h?.status ?? '').trim();
  return !s || s === '持有';
}

// 已清仓判定（兼容旧值 '已卖出'）
export function isFullyClosed(h) {
  const s = String(h?.status ?? '').trim();
  return s === '全部卖出' || s === '已卖出';
}

// ---------- 记录归一化 ----------

// 买入记录归一化。fee = 该笔手续费（本地币种），计入成本。
export function normalizePurchase(b, id) {
  const buyPrice = num(b.buyPrice);
  const buyQuantity = num(b.buyQuantity);
  if (!(buyPrice > 0) || !(buyQuantity > 0)) {
    throw new Error('买入价/买入数量必须为正');
  }
  return {
    id: id || newId('p'),
    buyPrice,
    buyQuantity,
    buyTime: dateKey(b.buyTime || b.date) || new Date().toISOString().slice(0, 10),
    fee: num(b.fee),
    targetProfitRate: num(b.targetProfitRate),
    stopLossRate: num(b.stopLossRate),
  };
}

// 含费单位成本：手续费按数量摊入
export function unitCostOf(p) {
  const qty = num(p.buyQuantity);
  if (!(qty > 0)) return 0;
  return num(p.buyPrice) + num(p.fee) / qty;
}

// 送转/拆股：对买入日 <= 送转日的批次按比例放大数量（成本金额不变 → 单位成本下降）
function applySplits(lots, splits) {
  let out = lots;
  for (const sp of splits || []) {
    const d = dateKey(sp.date);
    const ratio = num(sp.ratio);
    if (!(ratio > 0) || ratio === 1) continue;
    out = out.map((l) =>
      l.date && d && l.date <= d
        ? { ...l, qty: l.qty * ratio, remain: l.remain * ratio, unitCost: l.unitCost / ratio }
        : l
    );
  }
  return out;
}

// 按成本法从批次中扣减数量（只动数量，用于沿用历史成本时保持剩余批次正确）
function consumeQty(lots, qty, method) {
  if (!(qty > 0)) return;
  if (method === 'WAC') {
    const avail = lots.reduce((s, l) => s + l.remain, 0);
    if (avail <= EPS) return;
    const take = Math.min(qty, avail);
    for (const l of lots) {
      if (l.remain > EPS) l.remain -= take * (l.remain / avail);
    }
    return;
  }
  const order = [...lots]
    .filter((l) => l.remain > EPS)
    .sort((a, b) => (method === 'FIFO' ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date)));
  let need = qty;
  for (const l of order) {
    if (need <= EPS) break;
    const take = Math.min(need, l.remain);
    l.remain -= take;
    need -= take;
  }
}

// 按成本法从批次中取成本（用于重算/新卖出）
function consumeCost(lots, qty, method) {
  let cost = 0;
  let insufficient = false;
  if (method === 'WAC') {
    const availQty = lots.reduce((s, l) => s + l.remain, 0);
    const availCost = lots.reduce((s, l) => s + l.remain * l.unitCost, 0);
    if (qty > availQty + EPS) {
      insufficient = true;
      cost = availCost;
    } else {
      const unit = availQty > EPS ? availCost / availQty : 0;
      cost = unit * qty;
    }
  } else {
    const order = [...lots]
      .filter((l) => l.remain > EPS)
      .sort((a, b) => (method === 'FIFO' ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date)));
    let need = qty;
    for (const l of order) {
      if (need <= EPS) break;
      const take = Math.min(need, l.remain);
      cost += take * l.unitCost;
      need -= take;
    }
    if (need > EPS) insufficient = true;
  }
  consumeQty(lots, qty, method);
  return { cost, insufficient };
}

/**
 * 账本结算：剩余持仓 + 每笔卖出的成本 / 盈亏。纯函数，不修改入参。
 *
 * @param {Object} h 持仓（含 purchases / sells / splits / dividends / costMethod）
 * @param {{ recompute?: boolean }} [opts] recompute=true 时用当前成本法重算全部卖出成本
 * @returns {{
 *   method: string,
 *   lots: Array,                  // 剩余批次
 *   buyQty: number, buyCost: number, buyFee: number,
 *   soldQty: number, soldCost: number, sellFee: number,
 *   remainingQty: number, remainingCost: number, avgCost: number,
 *   realizedProfit: number, dividendTotal: number, feesTotal: number,
 *   sellResults: Array,           // [{ id, costPrice, profit, returnRate, insufficient, source }]
 *   totals: Object,               // 分币种无关的合计，便于统计模块复用
 * }}
 */
export function computePositions(h, opts = {}) {
  const method = normalizeCostMethod(h.costMethod);
  const recompute = !!opts.recompute;

  // 1) 买入 → 批次（单位成本含手续费摊入）
  let lots = (h.purchases || []).map((p) => ({
    id: p.id,
    date: dateKey(p.buyTime),
    buyPrice: num(p.buyPrice),
    unitCost: unitCostOf(p),
    qty: num(p.buyQuantity),
    remain: num(p.buyQuantity),
    fee: num(p.fee),
    targetProfitRate: num(p.targetProfitRate),
    stopLossRate: num(p.stopLossRate),
  }));
  const buyFeeRaw = lots.reduce((s, l) => s + l.fee, 0);

  // 2) 送转 / 拆股：数量按比例放大、单位成本等比缩小（成本金额不变）
  lots = applySplits(lots, h.splits);

  // 买入侧合计（送转后口径：数量为拆股后份额，成本金额不变）
  const buyQty = lots.reduce((s, l) => s + l.qty, 0);
  const buyCost = lots.reduce((s, l) => s + l.qty * l.unitCost, 0);
  const buyFee = buyFeeRaw;

  // 3) 卖出结算
  //    WAC 用「移动平均」的账本口径（按金额闭环），LIFO/FIFO 用批次队列
  const sellResults = [];
  let soldQty = 0;
  let soldCost = 0;
  let sellFee = 0;
  let sellRealized = 0;
  let runningQty = buyQty;
  let runningCost = buyCost;

  for (const s of h.sells || []) {
    const qty = num(s.sellQuantity);
    const price = num(s.sellPrice);
    const fee = num(s.fee);
    if (!(qty > 0)) {
      sellResults.push({ id: s.id, costPrice: 0, profit: 0, returnRate: 0, insufficient: false, source: 'skip' });
      continue;
    }

    const storedCost = Number(s.costPrice);
    const hasStored = s.costPrice != null && Number.isFinite(storedCost) && storedCost >= 0;
    let costPrice;
    let profit;
    let insufficient = false;
    let source;

    if (!recompute && hasStored) {
      // 沿用录入时点的历史成本（账本事实）
      costPrice = storedCost;
      const sp = Number(s.profit);
      profit = Number.isFinite(sp) ? sp : (price - costPrice) * qty - fee;
      if (method !== 'WAC') consumeQty(lots, qty, method); // 只扣数量，保持剩余批次
      source = 'stored';
    } else if (method === 'WAC') {
      // 移动加权平均：以账本剩余金额/数量为单价
      if (qty > runningQty + EPS) {
        insufficient = true;
        costPrice = qty > 0 ? runningCost / qty : 0;
      } else {
        costPrice = runningQty > EPS ? runningCost / runningQty : 0;
      }
      profit = (price - costPrice) * qty - fee;
      source = 'recomputed';
    } else {
      const r = consumeCost(lots, qty, method);
      costPrice = qty > 0 ? r.cost / qty : 0;
      profit = (price - costPrice) * qty - fee;
      insufficient = r.insufficient;
      source = 'recomputed';
    }

    soldQty += qty;
    soldCost += costPrice * qty;
    sellFee += fee;
    sellRealized += profit;
    // 账本口径的剩余（WAC 用；同时用于一致性展示）
    runningQty = Math.max(runningQty - qty, 0);
    runningCost = Math.max(runningCost - costPrice * qty, 0);
    sellResults.push({
      id: s.id,
      costPrice,
      profit,
      returnRate: costPrice > 0 ? ((price - costPrice) / costPrice) * 100 : 0,
      insufficient,
      source,
    });
  }

  // 4) 剩余持仓：按「买入 − 已卖出」闭合，与明细自洽
  const remainingQty = Math.max(buyQty - soldQty, 0);
  const remainingCost = Math.max(buyCost - soldCost, 0);
  const avgCost = remainingQty > EPS ? remainingCost / remainingQty : 0;

  // 5) 分红计入已实现收益（amount = 本次现金分红总额，本地币种）
  const dividendTotal = (h.dividends || []).reduce((s, d) => s + num(d.amount) - num(d.fee), 0);

  return {
    method,
    lots: lots.map((l) => ({ ...l, remainQty: Math.max(l.remain, 0) })),
    buyQty,
    buyCost,
    buyFee,
    soldQty,
    soldCost,
    sellFee,
    remainingQty,
    remainingCost,
    avgCost,
    realizedProfit: sellRealized + dividendTotal,
    dividendTotal,
    sellResults,
    feesTotal: buyFee + sellFee,
    totals: {
      buyCost,
      buyFee,
      soldCost,
      sellFee,
      sellRealized,
      dividendTotal,
      feesTotal: buyFee + sellFee,
    },
  };
}

// 成本加权止盈/止损（口径与旧实现一致：覆盖全部买入记录，不限于剩余批次）
function weightedRates(purchases, totalCost) {
  if (!(totalCost > 0)) return { target: 0, stop: 0 };
  let target = 0;
  let stop = 0;
  for (const p of purchases) {
    const w = num(p.buyPrice) * num(p.buyQuantity);
    target += num(p.targetProfitRate) * w;
    stop += num(p.stopLossRate) * w;
  }
  return { target: target / totalCost, stop: stop / totalCost };
}

// 显式值优先，否则用成本加权的均值（兼容旧行为：0/空视为未设置）
function pickRate(explicit, weighted) {
  const n = Number(explicit);
  return Number.isFinite(n) && n !== 0 ? n : weighted;
}

// 持仓状态判定：
//   - 有剩余 → 持有
//   - 有买入但剩余为 0 → 全部卖出
//   - 无买入记录 → 保持原状态（支持"先建仓、后补买入记录"）
function statusOf(h, pos) {
  if (pos.remainingQty > EPS) return '持有';
  if (pos.buyQty > 0) return '全部卖出';
  return h.status || '持有';
}

/**
 * 持仓聚合（唯一口径）：剩余持仓的成本/数量/均价 + 各口径收益 + 交易列表。
 * @param {Object} h 持仓
 * @param {number|null} [currentPrice] 不传则用 h.currentPrice
 */
export function aggregate(h, currentPrice) {
  const price = currentPrice !== undefined ? currentPrice : h.currentPrice;
  const hasPrice = price != null && Number.isFinite(Number(price)) && Number(price) > 0;
  const pos = computePositions(h);

  // 卖出明细（沿用重算/历史成本结果）
  const sellById = new Map(pos.sellResults.map((r) => [r.id, r]));
  const sells = (h.sells || []).map((s) => {
    const r = sellById.get(s.id) || {};
    const qty = num(s.sellQuantity);
    const costPrice = num(r.costPrice);
    return {
      type: 'SELL',
      id: s.id,
      buyTime: dateKey(s.sellDate || s.sellTime),
      buyPrice: num(s.sellPrice),
      buyQuantity: qty,
      fee: num(s.fee),
      cost: costPrice * qty,
      costPrice,
      marketValue: num(s.sellPrice) * qty,
      profit: num(r.profit),
      returnRate: num(r.returnRate),
      targetProfitRate: null,
      stopLossRate: null,
      targetPrice: null,
      stopLossPrice: null,
    };
  });

  // 每次买入明细（基于当前价派生浮动盈亏）
  const purchases = (h.purchases || []).map((p) => {
    const buyPrice = num(p.buyPrice);
    const qty = num(p.buyQuantity);
    const fee = num(p.fee);
    const cost = buyPrice * qty + fee;
    const unitCost = qty > 0 ? cost / qty : 0;
    const marketValue = hasPrice ? Number(price) * qty : null;
    const profit = hasPrice ? Number(price) * qty - cost : null;
    const returnRate =
      hasPrice && unitCost > 0 ? ((Number(price) - unitCost) / unitCost) * 100 : null;
    return {
      ...p,
      buyTime: dateKey(p.buyTime),
      fee,
      cost,
      unitCost,
      marketValue,
      profit,
      returnRate,
      targetPrice:
        buyPrice > 0 && p.targetProfitRate != null
          ? buyPrice * (1 + num(p.targetProfitRate) / 100)
          : null,
      stopLossPrice:
        buyPrice > 0 && p.stopLossRate != null
          ? buyPrice * (1 - num(p.stopLossRate) / 100)
          : null,
    };
  });

  // 分红流水（并入统一交易列表）
  const dividends = (h.dividends || []).map((d) => ({
    type: 'DIVIDEND',
    id: d.id,
    buyTime: dateKey(d.date),
    buyPrice: null,
    buyQuantity: null,
    fee: num(d.fee),
    cost: 0,
    marketValue: num(d.amount),
    profit: num(d.amount) - num(d.fee),
    returnRate: null,
    note: d.note || '',
    targetProfitRate: null,
    stopLossRate: null,
    targetPrice: null,
    stopLossPrice: null,
  }));

  // 送转 / 拆股流水（并入统一交易列表，便于在明细里看到）
  const splits = (h.splits || []).map((sp) => ({
    type: 'SPLIT',
    id: sp.id,
    buyTime: dateKey(sp.date),
    buyPrice: null,
    buyQuantity: null,
    ratio: num(sp.ratio),
    fee: 0,
    cost: 0,
    marketValue: null,
    profit: null,
    returnRate: null,
    note: sp.note || '',
    targetProfitRate: null,
    stopLossRate: null,
    targetPrice: null,
    stopLossPrice: null,
  }));

  const transactions = [
    ...purchases.map((p) => ({ ...p, type: 'BUY', profit: null, returnRate: null })),
    ...sells,
    ...dividends,
    ...splits,
  ].sort(byDateDesc);

  // 收益口径：持仓收益 = 未实现 + 已实现（含分红）
  const unrealizedProfit =
    hasPrice && pos.remainingQty > 0 && pos.avgCost > 0
      ? (Number(price) - pos.avgCost) * pos.remainingQty
      : null;
  const marketValue = hasPrice ? Number(price) * pos.remainingQty : null;
  const holdingProfit =
    unrealizedProfit != null
      ? unrealizedProfit + pos.realizedProfit
      : pos.realizedProfit !== 0
        ? pos.realizedProfit
        : null;
  const holdingReturnRate =
    pos.buyCost > 0 && holdingProfit != null ? (holdingProfit / pos.buyCost) * 100 : null;

  const prevClose = Number(h.prevClose);
  const todayProfit =
    hasPrice && prevClose > 0 && pos.remainingQty > 0
      ? (Number(price) - prevClose) * pos.remainingQty
      : null;
  const todayReturnRate =
    hasPrice && prevClose > 0 ? ((Number(price) - prevClose) / prevClose) * 100 : null;

  const lastBuy = [...(h.purchases || [])].sort(byDateDesc)[0];
  const lastBuyPrice = lastBuy ? num(lastBuy.buyPrice) : 0;

  const weighted = weightedRates(h.purchases || [], pos.buyCost);
  const currentReturnRate =
    pos.avgCost > 0 && hasPrice
      ? ((Number(price) - pos.avgCost) / pos.avgCost) * 100
      : pos.buyCost > 0
        ? (pos.realizedProfit / pos.buyCost) * 100
        : null;

  return {
    costMethod: pos.method,
    purchases,
    sells,
    dividends,
    splits,
    transactions,
    cost: pos.remainingCost,
    remainingQty: pos.remainingQty,
    remainingCost: pos.remainingCost,
    buyQty: pos.buyQty,
    soldQtyTotal: pos.soldQty,
    buyQuantity: pos.remainingQty,
    sellQuantity: pos.soldQty,
    unsoldQuantity: pos.remainingQty,
    avgCost: pos.avgCost,
    lastBuyPrice,
    position: pos.remainingCost,
    marketValue,
    unrealizedProfit,
    realizedProfit: pos.realizedProfit,
    dividendTotal: pos.dividendTotal,
    feesTotal: pos.feesTotal,
    buyCostTotal: pos.buyCost,
    buyCost: pos.buyCost,
    soldCostTotal: pos.soldCost,
    holdingProfit,
    holdingReturnRate,
    todayProfit,
    todayReturnRate,
    currentReturnRate,
    targetProfitRate: pickRate(h.targetProfitRate, weighted.target),
    stopLossRate: pickRate(h.stopLossRate, weighted.stop),
    dropRate:
      hasPrice && lastBuyPrice > 0 ? ((lastBuyPrice - Number(price)) / lastBuyPrice) * 100 : null,
    peakReturnRate: h.peakReturnRate != null ? Number(h.peakReturnRate) : null,
    trailingStopPct: h.trailingStopPct != null ? Number(h.trailingStopPct) : null,
    status: statusOf(h, pos),
    // 明细与卖出记录不一致（如手工改过文件）时置 true，便于前端提示
    inconsistentSell: pos.sellResults.some((r) => r.insufficient),
  };
}

/**
 * 展示用派生（在落盘字段基础上补充展示字段 + 币种）。不写盘。
 */
export function withDerived(h) {
  const currency = currencyOf(h.region);
  const agg = aggregate(h);
  return {
    ...h,
    ...agg,
    currency,
    currencyCode: currencyCode(currency),
  };
}

/**
 * 落盘前同步：把重算结果写回持仓的汇总字段与卖出明细。
 * 用于新建 / 追加交易 / 修改 / 删除买入记录 / CSV 导入后。
 */
export function syncFromPurchases(h) {
  const agg = aggregate(h);
  const pos = computePositions(h);
  h.cost = agg.cost;
  h.buyQuantity = agg.buyQuantity;
  h.position = agg.position;
  h.avgCost = agg.avgCost;
  h.lastBuyPrice = agg.lastBuyPrice;
  if (agg.targetProfitRate) h.targetProfitRate = +agg.targetProfitRate.toFixed(2);
  if (agg.stopLossRate) h.stopLossRate = +agg.stopLossRate.toFixed(2);
  h.status = agg.status;
  // 仅在历史值缺失/非法时补齐卖出明细，不改写已录入的历史成本
  const byId = new Map(pos.sellResults.map((r) => [r.id, r]));
  for (const s of h.sells || []) {
    const r = byId.get(s.id);
    if (!r) continue;
    if (!Number.isFinite(Number(s.costPrice)) || s.costPrice == null) {
      s.costPrice = +Number(r.costPrice).toFixed(6);
    }
    if (!Number.isFinite(Number(s.profit)) || s.profit == null) {
      s.profit = +Number(r.profit).toFixed(6);
    }
    if (!Number.isFinite(Number(s.returnRate)) || s.returnRate == null) {
      s.returnRate = +Number(r.returnRate).toFixed(6);
    }
  }
  h.triggerState = 'IDLE';
  h.notifiedAt = null;
  return h;
}

/**
 * 用当前成本法重算全部卖出成本（口径变更后使用）。
 * 注意：会改写历史卖出记录的成本/盈亏，属于显式操作。
 */
export function recomputeSells(h) {
  const pos = computePositions(h, { recompute: true });
  const byId = new Map(pos.sellResults.map((r) => [r.id, r]));
  for (const s of h.sells || []) {
    const r = byId.get(s.id);
    if (!r) continue;
    s.costPrice = +Number(r.costPrice).toFixed(6);
    s.profit = +Number(r.profit).toFixed(6);
    s.returnRate = +Number(r.returnRate).toFixed(6);
  }
  syncFromPurchases(h);
  return h;
}

// ---------- 交易应用 ----------

/**
 * 应用一笔交易。支持 BUY / SELL / DIVIDEND / SPLIT。
 * @param {Object} h 持仓（原地修改）
 * @param {{ type:string, price?:number, quantity?:number, date?:string,
 *           fee?:number, amount?:number, ratio?:number, note?:string }} txn
 */
export function applyTransaction(h, txn) {
  const type = String(txn.type || '').toUpperCase();
  const date = dateKey(txn.date) || new Date().toISOString().slice(0, 10);

  if (type === 'BUY') {
    const qty = num(txn.quantity);
    const price = num(txn.price);
    if (!(qty > 0) || !(price > 0)) throw new Error('quantity / price 必须为正');
    h.purchases = h.purchases || [];
    h.purchases.push(
      normalizePurchase({
        buyPrice: price,
        buyQuantity: qty,
        buyTime: date,
        fee: txn.fee,
        targetProfitRate: h.targetProfitRate || 0,
        stopLossRate: h.stopLossRate || 0,
      })
    );
    h.status = '持有';
  } else if (type === 'SELL') {
    const qty = num(txn.quantity);
    const price = num(txn.price);
    if (!(qty > 0) || !(price > 0)) throw new Error('quantity / price 必须为正');
    // 先按当前账本校验数量，再落记录（避免写入非法记录）
    const posBefore = computePositions(h);
    if (qty > posBefore.remainingQty + EPS) throw new Error('卖出数量超过持仓数量');
    h.sells = h.sells || [];
    // 用所选成本法计算本笔成本，并直接写入记录（成为后续沿用的历史成本）
    const r = consumeCost(posBefore.lots.map((l) => ({ ...l, remain: l.remainQty ?? l.remain })), qty, posBefore.method);
    const costPrice = qty > 0 ? r.cost / qty : 0;
    h.sells.push({
      id: newId('s'),
      sellPrice: price,
      sellQuantity: qty,
      sellDate: date,
      fee: num(txn.fee),
      costPrice: +costPrice.toFixed(6),
      profit: +((price - costPrice) * qty - num(txn.fee)).toFixed(6),
      returnRate: +(costPrice > 0 ? ((price - costPrice) / costPrice) * 100 : 0).toFixed(6),
    });
  } else if (type === 'DIVIDEND') {
    const amount = num(txn.amount);
    if (!(amount > 0)) throw new Error('分红金额必须为正');
    h.dividends = h.dividends || [];
    h.dividends.push({
      id: newId('d'),
      date,
      amount,
      fee: num(txn.fee),
      note: txn.note || '',
    });
  } else if (type === 'SPLIT') {
    const ratio = num(txn.ratio);
    if (!(ratio > 0) || ratio === 1) throw new Error('送转比例必须为正且不为 1');
    h.splits = h.splits || [];
    h.splits.push({ id: newId('sp'), date, ratio, note: txn.note || '' });
  } else {
    throw new Error('type 必须为 BUY / SELL / DIVIDEND / SPLIT');
  }

  h.triggerState = 'IDLE';
  h.notifiedAt = null;
  syncFromPurchases(h);
  return h;
}
