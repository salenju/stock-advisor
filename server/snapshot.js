// 每日快照：把组合状态按日落盘，作为「真实历史记录」。
//
// 为什么需要：
//   1. 收益趋势原先完全依赖「第三方 K 线实时重放」，接口一挂就没有历史；
//   2. 没有快照就无法稳定产出月度/年度报表；
//   3. 快照记录的是当日实际收盘状态，比"用今天的交易记录回溯重算"更可信。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildSnapshot, mergeSnapshots } from '../web/src/core/snapshot.js';

// buildSnapshot / mergeSnapshots 已抽到前后端共享模块（快照口径必须一致），
// 本文件只保留「文件读写 + 每日任务状态」部分。
export { buildSnapshot, mergeSnapshots };

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

export function snapshotFile() {
  return SNAP_FILE;
}
