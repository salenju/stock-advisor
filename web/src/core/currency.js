// 币种相关纯函数：地区 → 币种、外币金额换算人民币、按币种分组汇总。
// 无副作用、无状态，供 server.js / trend.js / 测试复用。
import { normalizeRegion } from './provider/tencent.js';

// 地区前缀 → 币种（人民币/港币/美元）
const REGION_CURRENCY = { sh: 'CNY', sz: 'CNY', hk: 'HKD', us: 'USD' };

export function currencyOf(region) {
  return REGION_CURRENCY[normalizeRegion(region)] || 'CNY';
}

// 币种显示代码（卡片金额前缀，如 HKD / USD / CNY）
export const CURRENCY_CODE = { CNY: 'CNY', HKD: 'HKD', USD: 'USD' };

export function currencyCode(currency) {
  return CURRENCY_CODE[currency] || '';
}

// 把金额按币种汇率换算成人民币；非法值按 0 处理
export function fxToCNY(amount, currency, rates) {
  const v = Number(amount);
  if (!Number.isFinite(v)) return 0;
  const r = rates?.[currency];
  return r ? v * r : 0;
}

/**
 * 对一批持仓的某个金额字段做「按币种分组 + 人民币汇总」。
 * @param {Array} holdings 持仓数组（含 currency 与目标字段）
 * @param {string} metricKey 金额字段名：cost / marketValue / todayProfit / holdingProfit
 * @param {Object} rates { CNY:1, HKD, USD }
 * @returns {{ byCurrency: Object<string,number>, totalCNY: number }}
 *    byCurrency: 各币种本地金额小计（仅含实际出现的币种）；totalCNY: 全部换算人民币后的合计
 */
export function breakdownByCurrency(holdings, metricKey, rates) {
  const byCurrency = {};
  for (const h of holdings) {
    const v = Number(h?.[metricKey]);
    if (v == null || !Number.isFinite(v)) continue;
    const c = h.currency || 'CNY';
    byCurrency[c] = (byCurrency[c] || 0) + v;
  }
  let totalCNY = 0;
  for (const [c, sum] of Object.entries(byCurrency)) {
    totalCNY += fxToCNY(sum, c, rates);
  }
  return { byCurrency, totalCNY };
}
