// 策略引擎：基于多次买入记录判断止盈/止损（卖点）与补仓（买点）
// nearPct：距离阈值多近算"快达到"（百分比）

// 聚合买入记录
function agg(h) {
  const purchases = h.purchases || [];
  let totalCost = 0;
  let totalQty = 0;
  for (const p of purchases) {
    const qty = Number(p.buyQuantity) || 0;
    totalCost += (Number(p.buyPrice) || 0) * qty;
    totalQty += qty;
  }
  const avgCost = totalQty > 0 ? totalCost / totalQty : 0;
  const lastBuyPrice =
    purchases.length > 0
      ? [...purchases].sort((a, b) => String(b.buyTime).localeCompare(String(a.buyTime)))[0].buyPrice
      : 0;
  // 止盈/止亏按成本加权
  let wTarget = 0;
  let wStop = 0;
  if (totalCost > 0) {
    for (const p of purchases) {
      const w = (Number(p.buyPrice) || 0) * (Number(p.buyQuantity) || 0);
      wTarget += (Number(p.targetProfitRate) || 0) * w;
      wStop += (Number(p.stopLossRate) || 0) * w;
    }
    wTarget /= totalCost;
    wStop /= totalCost;
  }
  return { totalCost, totalQty, avgCost, lastBuyPrice, wTarget, wStop };
}

export function evaluate(h, nearPct) {
  const price = h.currentPrice;
  if (price == null) return { trigger: 'NONE' };
  const { totalCost, avgCost, lastBuyPrice, wTarget, wStop } = agg(h);

  const returnRate = avgCost > 0 ? ((price - avgCost) / avgCost) * 100 : 0;

  // 卖点①：达到预期止盈（按成本加权）
  if (wTarget > 0 && returnRate >= wTarget - nearPct) {
    return {
      trigger: 'SELL',
      reason: 'PROFIT',
      returnRate,
      advice:
        `当前价 ${price}，持仓收益率 ${returnRate.toFixed(2)}%，已接近预期止盈 ` +
        `${wTarget.toFixed(2)}%，建议择机卖出。下阶段：${h.nextStrategy || '—'}`,
    };
  }

  // 卖点②：任一买入记录触发止损（跌幅达到该笔止亏比例）
  if (wStop > 0) {
    for (const p of h.purchases || []) {
      const bp = Number(p.buyPrice) || 0;
      if (bp <= 0) continue;
      const pr = ((price - bp) / bp) * 100;
      const s = Number(p.stopLossRate) || 0;
      if (s > 0 && pr <= -s + nearPct) {
        return {
          trigger: 'SELL',
          reason: 'STOPLOSS',
          returnRate: pr,
          advice:
            `当前价 ${price}，买入价 ${bp}（${p.buyTime || '—'}）已亏损 ${Math.abs(pr).toFixed(2)}%，` +
            `触及该笔止损线 ${s}%，建议止损。下阶段：${h.nextStrategy || '—'}`,
        };
      }
    }
  }

  // 买点：较最近买入价跌幅 或 触及补仓价
  const dropRate = lastBuyPrice > 0 ? ((lastBuyPrice - price) / lastBuyPrice) * 100 : 0;
  if (
    (h.refillPrice && price <= Number(h.refillPrice)) ||
    (h.refillDropRate && dropRate >= Number(h.refillDropRate) - nearPct)
  ) {
    return {
      trigger: 'BUY',
      dropRate,
      advice:
        `当前价 ${price}，较最近买入价 ${lastBuyPrice} 下跌 ${dropRate.toFixed(2)}%，` +
        `接近补仓价 ${h.refillPrice || '—'}（降幅 ${h.refillDropRate || '—'}%），建议补仓。` +
        `下阶段：${h.nextStrategy || '—'}`,
    };
  }

  return { trigger: 'NONE' };
}
