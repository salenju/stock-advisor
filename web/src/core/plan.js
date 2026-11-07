// 加仓测算（纯函数，无副作用）。
//
// 成本口径与 core/derive.js 保持一致：
//   持仓成本 = 剩余批次的「买入价 × 数量 + 手续费」之和，手续费已摊入单位成本，
//   页面展示的「成本」= 剩余总成本 / 剩余数量。
// 因此按「总成本加权」测算出来的新成本，与实际录入一笔买入记录后的显示值一致。

const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

const EPS = 1e-9;

/** 平均成本 = 总成本 / 数量（数量为 0 时返回 0） */
export function avgCostOf(cost, qty) {
  const q = Math.max(num(qty), 0);
  return q > EPS ? Math.max(num(cost), 0) / q : 0;
}

/**
 * 已知「计划买入数量」，测算买入后的持仓成本。
 *
 * @param {Object} p
 * @param {number} p.currentQty   当前剩余持仓数量
 * @param {number} p.currentCost  当前剩余持仓总成本（含已摊入的手续费）
 * @param {number} p.price        买入价
 * @param {number} p.quantity     计划买入数量
 * @param {number} [p.fee]        本次买入手续费（计入成本）
 * @returns {{ok:true, oldQty:number, oldCost:number, oldAvg:number,
 *            addQty:number, addFee:number, invest:number,
 *            newQty:number, newCost:number, newAvg:number,
 *            delta:number, deltaPct:number|null} | {ok:false, reason:string}}
 */
export function projectByQuantity({ currentQty, currentCost, price, quantity, fee = 0 } = {}) {
  const qty0 = Math.max(num(currentQty), 0);
  const cost0 = Math.max(num(currentCost), 0);
  const p = num(price);
  const addQty = num(quantity);
  const addFee = Math.max(num(fee), 0);

  if (!(p > 0)) return { ok: false, reason: '买入价需大于 0' };
  if (!(addQty > 0)) return { ok: false, reason: '计划买入数量需大于 0' };

  const oldAvg = avgCostOf(cost0, qty0);
  const invest = p * addQty + addFee;
  const newQty = qty0 + addQty;
  const newCost = cost0 + invest;
  const newAvg = avgCostOf(newCost, newQty);
  const delta = newAvg - oldAvg;
  const deltaPct = oldAvg > EPS ? (delta / oldAvg) * 100 : null;

  return {
    ok: true,
    oldQty: qty0,
    oldCost: cost0,
    oldAvg,
    addQty,
    addFee,
    invest,
    newQty,
    newCost,
    newAvg,
    delta,
    deltaPct,
  };
}

/**
 * 已知「目标成本」，反推需要买入的数量。
 *
 * 推导（含手续费 f）：
 *   (成本 + 价格 × q + f) / (数量 + q) = 目标成本
 *   ⇒ q = (数量 × (目标成本 − 当前成本价) − f) / (买入价 − 目标成本)
 * 因此：
 *   - 想摊低成本，买入价必须低于目标成本；
 *   - 想拉高成本，买入价必须高于目标成本。
 * 再按手数向上取整给出可下单的股数（A股/场内基金一手 100，港股/美股按 1）。
 *
 * @param {Object} p
 * @param {number} p.currentQty    当前剩余持仓数量
 * @param {number} p.currentCost   当前剩余持仓总成本（含手续费）
 * @param {number} p.price         买入价
 * @param {number} p.targetCost    目标成本（单位成本）
 * @param {number} [p.fee]         本次买入手续费
 * @param {number} [p.lotSize]     一手股数（1 = 按整股取整）
 * @returns {{ok:true, oldQty:number, oldCost:number, oldAvg:number, targetAvg:number,
 *            needQty:number, invest:number, newQty:number, newCost:number, newAvg:number,
 *            lotSize:number, suggestedQty:number, suggestedLots:number|null,
 *            suggestedAvg:number, suggestedInvest:number} | {ok:false, reason:string}}
 */
export function quantityForTargetCost({
  currentQty,
  currentCost,
  price,
  targetCost,
  fee = 0,
  lotSize = 1,
} = {}) {
  const qty0 = Math.max(num(currentQty), 0);
  const cost0 = Math.max(num(currentCost), 0);
  const p = num(price);
  const target = num(targetCost);
  const addFee = Math.max(num(fee), 0);
  const lot = Math.max(Math.floor(num(lotSize, 1)), 1);

  if (!(p > 0)) return { ok: false, reason: '买入价需大于 0' };
  if (!(target > 0)) return { ok: false, reason: '目标成本需大于 0' };
  if (!(qty0 > EPS)) return { ok: false, reason: '当前没有持仓，无法反推加仓数量' };

  const oldAvg = avgCostOf(cost0, qty0);
  if (Math.abs(target - oldAvg) < 1e-6) {
    return { ok: false, reason: '目标成本与当前成本一致，无需买入' };
  }

  const denom = p - target;
  if (Math.abs(denom) < EPS) {
    return { ok: false, reason: '买入价等于目标成本，无论买多少都到不了该成本' };
  }

  const numerator = qty0 * (target - oldAvg) - addFee;
  const needQty = numerator / denom;

  if (!(needQty > 0)) {
    let reason;
    if (target < oldAvg) {
      reason =
        numerator > 0
          ? '手续费相对目标降幅过大，无法靠加仓摊薄到该成本'
          : '目标成本低于当前成本时，买入价必须低于目标成本才能摊薄';
    } else {
      reason =
        numerator < 0
          ? '手续费相对目标降幅过大，无法靠加仓拉高到该成本'
          : '目标成本高于当前成本时，买入价必须高于目标成本才能拉高';
    }
    return { ok: false, reason };
  }

  const newQty = qty0 + needQty;
  const newCost = cost0 + p * needQty + addFee;

  // 向上取整到整股 / 整手：多买一点只会更接近甚至越过目标，不会差一点点
  const suggestedQty = lot > 1 ? Math.ceil(needQty / lot - 1e-9) * lot : Math.ceil(needQty - 1e-9);
  const suggestedInvest = p * suggestedQty + addFee;
  const suggestedAvg = avgCostOf(cost0 + suggestedInvest, qty0 + suggestedQty);

  return {
    ok: true,
    oldQty: qty0,
    oldCost: cost0,
    oldAvg,
    targetAvg: target,
    needQty,
    invest: p * needQty + addFee,
    newQty,
    newCost,
    newAvg: avgCostOf(newCost, newQty),
    lotSize: lot,
    suggestedQty,
    suggestedLots: lot > 1 ? suggestedQty / lot : null,
    suggestedAvg,
    suggestedInvest,
  };
}
