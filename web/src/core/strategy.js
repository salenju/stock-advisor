// 策略引擎：基于持仓（多次买入/卖出记录）判断卖点（止盈/移动止盈/止损）与买点（补仓）。
//
// 口径统一：聚合逻辑来自 derive.js（与前端展示、CSV 导入同一实现）。
// 阈值语义：
//   nearPct            距离阈值多近算"快达到"（百分比）
//   trailingStopPct    移动止盈回撤阈值：从持仓期最高收益率回撤该幅度即触发
import { computePositions } from './derive.js';

// 触发类型（供前端与通知模块共用，避免散落的字符串字面量）
export const TRIGGER = {
  NONE: 'NONE',
  BUY: 'BUY',
  SELL_PROFIT: 'SELL',
  SELL_STOPLOSS: 'SELL',
  SELL_TRAILING: 'SELL',
  DAILY_RISE: 'DAILY_RISE',
  DAILY_DROP: 'DAILY_DROP',
};

/**
 * 判断单只持仓的触发状态。
 * @param {Object} h 持仓（需含 currentPrice / avgCost / cost / 买入记录等）
 * @param {number} nearPct 临近阈值
 * @returns {{ trigger:'NONE'|'BUY'|'SELL', reason?:'PROFIT'|'STOPLOSS'|'TRAILING',
 *             returnRate?:number, dropRate?:number, advice?:string }}
 */
export function evaluate(h, nearPct = 2) {
  const price = Number(h.currentPrice);
  // 防御：无价 / 非正价（停牌、行情源异常、字段缺失）一律不参与判断，
  // 避免 price=0 被当成真实价格触发错误的买卖点提醒。
  if (!Number.isFinite(price) || price <= 0) return { trigger: 'NONE' };

  const pos = computePositions(h);
  // 已清仓（含全部卖出后）不再提示
  if (pos.remainingQty <= 0) return { trigger: 'NONE' };

  const avgCost = pos.avgCost;
  const returnRate = avgCost > 0 ? ((price - avgCost) / avgCost) * 100 : 0;
  const near = Math.abs(Number(nearPct) || 0);
  const next = h.nextStrategy || '—';

  // ---------- 卖点①：达到预期止盈（成本加权） ----------
  const wTarget = Number(h.targetProfitRate) || 0;
  if (wTarget > 0 && returnRate >= wTarget - near) {
    return {
      trigger: 'SELL',
      reason: 'PROFIT',
      returnRate,
      advice:
        `当前价 ${price}，持仓收益率 ${returnRate.toFixed(2)}%，已接近预期止盈 ` +
        `${wTarget.toFixed(2)}%，建议择机卖出。下阶段：${next}`,
    };
  }

  // ---------- 卖点②：移动止盈（从最高收益率回撤） ----------
  const trailing = Number(h.trailingStopPct) || 0;
  const peak = h.peakReturnRate != null ? Number(h.peakReturnRate) : null;
  if (trailing > 0 && peak != null && peak > 0 && returnRate <= peak - trailing) {
    return {
      trigger: 'SELL',
      reason: 'TRAILING',
      returnRate,
      advice:
        `当前价 ${price}，持仓收益率 ${returnRate.toFixed(2)}%，自持仓期最高 ${peak.toFixed(2)}% ` +
        `回撤 ${(peak - returnRate).toFixed(2)}%，达到移动止盈阈值 ${trailing}%，建议锁定利润。` +
        `下阶段：${next}`,
    };
  }

  // ---------- 卖点③：任一买入记录触发止损（跌幅达到该笔止亏比例） ----------
  for (const p of h.purchases || []) {
    const bp = Number(p.buyPrice) || 0;
    if (bp <= 0) continue;
    const pr = ((price - bp) / bp) * 100;
    const s = Number(p.stopLossRate) || 0;
    if (s > 0 && pr <= -s + near) {
      return {
        trigger: 'SELL',
        reason: 'STOPLOSS',
        returnRate: pr,
        advice:
          `当前价 ${price}，买入价 ${bp}（${p.buyTime || '—'}）已亏损 ${Math.abs(pr).toFixed(2)}%，` +
          `触及该笔止损线 ${s}%，建议止损。下阶段：${next}`,
      };
    }
  }

  // ---------- 买点：较最近买入价跌幅 或 触及补仓价 ----------
  const lastBuy = [...(h.purchases || [])].sort((a, b) =>
    String(b.buyTime).localeCompare(String(a.buyTime))
  )[0];
  const lastBuyPrice = lastBuy ? Number(lastBuy.buyPrice) || 0 : 0;
  const dropRate = lastBuyPrice > 0 ? ((lastBuyPrice - price) / lastBuyPrice) * 100 : 0;
  const refillPrice = Number(h.refillPrice) || 0;
  const refillDropRate = Number(h.refillDropRate) || 0;
  if (
    (refillPrice > 0 && price <= refillPrice) ||
    (refillDropRate > 0 && dropRate >= refillDropRate - near)
  ) {
    return {
      trigger: 'BUY',
      dropRate,
      advice:
        `当前价 ${price}，较最近买入价 ${lastBuyPrice} 下跌 ${dropRate.toFixed(2)}%，` +
        `接近补仓价 ${h.refillPrice || '—'}（降幅 ${h.refillDropRate || '—'}%），建议补仓。` +
        `下阶段：${next}`,
    };
  }

  return { trigger: 'NONE' };
}

/**
 * 更新持仓期最高收益率（移动止盈的基准）。
 * 只在移动止盈启用时维护，避免无用写入。
 * @returns {boolean} 是否发生变化（需落盘）
 */
export function updatePeak(h) {
  if (!(Number(h.trailingStopPct) > 0)) return false;
  const price = Number(h.currentPrice);
  if (!Number.isFinite(price) || price <= 0) return false;
  const pos = computePositions(h);
  if (pos.remainingQty <= 0 || !(pos.avgCost > 0)) return false;
  const rate = ((price - pos.avgCost) / pos.avgCost) * 100;
  const peak = h.peakReturnRate != null ? Number(h.peakReturnRate) : null;
  if (peak == null || rate > peak) {
    h.peakReturnRate = +rate.toFixed(4);
    return true;
  }
  return false;
}
