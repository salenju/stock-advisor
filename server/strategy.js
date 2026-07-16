// 策略引擎：基于成本判断卖点（止盈），基于最近买入价判断买点（补仓）
// nearPct：距离阈值多近算"快达到"（百分比）
export function evaluate(h, nearPct) {
  const price = h.currentPrice;
  if (price == null) return { trigger: 'NONE' };

  // 卖点：收益率 = (当前价 - 买入均价) / 买入均价，基于成本
  const avgCost = h.cost / h.buyQuantity;
  const returnRate = ((price - avgCost) / avgCost) * 100;
  if (returnRate >= h.targetProfitRate - nearPct) {
    return {
      trigger: 'SELL',
      returnRate,
      advice:
        `当前价 ${price}，收益率 ${returnRate.toFixed(2)}%，已接近预期止盈 ` +
        `${h.targetProfitRate}%，建议择机卖出。下阶段：${h.nextStrategy}`,
    };
  }

  // 买点：较最近买入价跌幅 或 触及补仓价
  const dropRate = ((h.lastBuyPrice - price) / h.lastBuyPrice) * 100;
  if (price <= h.refillPrice || dropRate >= h.refillDropRate - nearPct) {
    return {
      trigger: 'BUY',
      dropRate,
      advice:
        `当前价 ${price}，较最近买入价 ${h.lastBuyPrice} 下跌 ${dropRate.toFixed(2)}%，` +
        `接近补仓价 ${h.refillPrice}（降幅 ${h.refillDropRate}%），建议补仓。` +
        `下阶段：${h.nextStrategy}`,
    };
  }

  return { trigger: 'NONE' };
}
