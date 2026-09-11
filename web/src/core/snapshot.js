// 每日快照：把组合状态按日落盘，作为「真实历史记录」。
//
// 本文件只放纯函数（buildSnapshot / mergeSnapshots / upsertInList），
// server/snapshot.js 与前端 localStore 共用，保证快照口径一致。
// 为什么需要：K 线重放依赖第三方接口，接口挂了就没有历史；
// 快照记录的是当日实际收盘状态，比"用今天的交易记录回溯重算"更可信。
import { withDerived, isActive } from './derive.js';
import { fxToCNY } from './currency.js';

function r2(v) {
  return Number.isFinite(Number(v)) ? +Number(v).toFixed(2) : 0;
}

/**
 * 计算某日的组合快照（人民币口径）。
 * @param {Array} holdings 全部持仓
 * @param {Object} rates { CNY:1, USD, HKD }
 * @param {string} date YYYY-MM-DD
 */
export function buildSnapshot(holdings, rates, date) {
  let marketValue = 0;
  let holdingProfit = 0;
  let unrealizedProfit = 0;
  let todayProfit = 0;
  let cost = 0;
  let realizedProfit = 0; // 累计已实现（含已清仓部分与分红）
  let activeCount = 0;
  const byCurrency = {};

  for (const h of holdings || []) {
    const d = withDerived(h);
    realizedProfit += fxToCNY(d.realizedProfit, d.currency, rates);
    if (!isActive(h) || !(d.unsoldQuantity > 0)) continue;
    activeCount++;
    const bucket = (byCurrency[d.currency] = byCurrency[d.currency] || {
      cost: 0,
      marketValue: 0,
      holdingProfit: 0,
      todayProfit: 0,
    });
    bucket.cost += Number(d.cost) || 0;
    bucket.marketValue += Number(d.marketValue) || 0;
    bucket.holdingProfit += Number(d.holdingProfit) || 0;
    bucket.todayProfit += Number(d.todayProfit) || 0;

    cost += fxToCNY(d.cost, d.currency, rates);
    marketValue += fxToCNY(d.marketValue, d.currency, rates);
    holdingProfit += fxToCNY(d.holdingProfit, d.currency, rates);
    unrealizedProfit += fxToCNY(d.unrealizedProfit, d.currency, rates);
    todayProfit += fxToCNY(d.todayProfit, d.currency, rates);
  }

  return {
    date,
    activeCount,
    cost: r2(cost),
    marketValue: r2(marketValue),
    holdingProfit: r2(holdingProfit),
    unrealizedProfit: r2(unrealizedProfit),
    realizedProfit: r2(realizedProfit),
    todayProfit: r2(todayProfit),
    currency: 'CNY',
    rates: { USD: rates?.USD ?? null, HKD: rates?.HKD ?? null },
    byCurrency,
    createdAt: new Date().toISOString(),
  };
}

/** 按日期 upsert（同一天重复收盘检测时覆盖，保证幂等）；返回新数组 */
export function upsertSnapshotInList(list, record) {
  const out = [...(list || [])];
  const i = out.findIndex((s) => s.date === record.date);
  if (i >= 0) out[i] = record;
  else out.push(record);
  out.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return out;
}

/**
 * 把快照并入趋势序列：同一日期以快照为准（真实记录），
 * 无快照的日期沿用 K 线重放结果。
 */
export function mergeSnapshots(series, snaps) {
  if (!snaps || !snaps.length) return series;
  const snapMap = new Map(snaps.map((s) => [String(s.date), s]));
  const baseMap = { holdingProfit: new Map(), todayProfit: new Map(), marketValue: new Map() };
  series.dates.forEach((d, i) => {
    baseMap.holdingProfit.set(d, series.holdingProfit[i]);
    baseMap.todayProfit.set(d, series.todayProfit[i]);
    baseMap.marketValue.set(d, series.marketValue[i]);
  });
  const dates = [...new Set([...series.dates, ...snaps.map((s) => String(s.date))])].sort();
  const col = (key) =>
    dates.map((d) => {
      const s = snapMap.get(d);
      if (s && Number.isFinite(Number(s[key]))) return Number(s[key]);
      const v = baseMap[key].get(d);
      return Number.isFinite(Number(v)) ? Number(v) : 0;
    });
  return {
    dates,
    holdingProfit: col('holdingProfit'),
    todayProfit: col('todayProfit'),
    marketValue: col('marketValue'),
  };
}
