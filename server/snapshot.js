// 每日快照：把组合状态按日落盘，作为「真实历史记录」。
//
// 为什么需要：
//   1. 收益趋势原先完全依赖「第三方 K 线实时重放」，接口一挂就没有历史；
//   2. 没有快照就无法稳定产出月度/年度报表；
//   3. 快照记录的是当日实际收盘状态，比"用今天的交易记录回溯重算"更可信。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { withDerived, isActive } from './derive.js';
import { fxToCNY } from './currency.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAP_FILE = join(__dirname, '..', 'data', 'snapshots.json');
const STATE_FILE = join(__dirname, '..', 'data', 'daily-state.json');

// ---------- 每日任务状态（幂等去重，进程重启后不重复推送）----------

const DEFAULT_STATE = { snapshotDate: null, reportDate: null, fxDate: null };
let stateCache = null;

export async function loadDailyState() {
  if (stateCache) return stateCache;
  try {
    const raw = await readFile(STATE_FILE, 'utf-8');
    stateCache = { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch {
    stateCache = { ...DEFAULT_STATE };
  }
  return stateCache;
}

export async function saveDailyState(state) {
  stateCache = { ...DEFAULT_STATE, ...(state || stateCache) };
  await mkdir(dirname(STATE_FILE), { recursive: true }).catch(() => {});
  await writeFile(STATE_FILE, JSON.stringify(stateCache, null, 2), 'utf-8').catch(() => {});
  return stateCache;
}

// 测试用：重置内存中的状态缓存
export function resetDailyStateCache() {
  stateCache = null;
}

function r2(v) {
  return Number.isFinite(Number(v)) ? +Number(v).toFixed(2) : 0;
}

export async function loadSnapshots() {
  try {
    const raw = await readFile(SNAP_FILE, 'utf-8');
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function saveSnapshots(list) {
  await mkdir(dirname(SNAP_FILE), { recursive: true }).catch(() => {});
  await writeFile(SNAP_FILE, JSON.stringify(list, null, 2), 'utf-8');
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

// 按日期 upsert（同一天重复收盘检测时覆盖，保证幂等）
export async function upsertSnapshot(record) {
  const list = await loadSnapshots();
  const i = list.findIndex((s) => s.date === record.date);
  if (i >= 0) list[i] = record;
  else list.push(record);
  list.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  await saveSnapshots(list);
  return record;
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

export function snapshotFile() {
  return SNAP_FILE;
}
