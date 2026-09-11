// 浏览器本地存储层（本地数据模式的唯一持久化入口）。
//
// 设计目标：**数据只存在这台设备的浏览器里，永不外传**。
//   - 优先 IndexedDB（容量大、异步不阻塞）；不可用时（隐私模式等）退化为 localStorage
//   - 自动版本快照：交易数据一变就留一份旧版本，最多 30 份，可回滚（对应服务端的 data/backups/）
//   - 全量导出/导入 JSON：换设备、换浏览器、清缓存前自救
//
// 本层不含业务计算，只负责「存、取、备份、导入导出」。
import { migrateHoldings, dataSignature, SCHEMA_VERSION } from '../core/schema.js';
import { upsertSnapshotInList } from '../core/snapshot.js';
import { DEFAULT_RATES } from '../core/rates.js';

const DB_NAME = 'stock-advisor';
const DB_VERSION = 1;
const KV = 'kv';
const BACKUPS = 'backups';
const MAX_BACKUPS = 30;
const BUNDLE_VERSION = 1;
const LS_PREFIX = 'stock-advisor:';

const KEY_HOLDINGS = 'holdings';
const KEY_SNAPSHOTS = 'snapshots';
const KEY_SETTINGS = 'settings';
const KEY_META = 'meta';

export const DEFAULT_SETTINGS = {
  fx: { rates: { ...DEFAULT_RATES }, updatedAt: null },
  notify: { nearThresholdPct: 2, maxDailyMovePct: 50 },
  schedule: { snapshot: true, snapshotAt: '16:10' },
};

// ---------- 底层：IndexedDB（优先） ----------

let dbPromise = null;
let driver = 'unknown';

function idbUsable() {
  try {
    return typeof indexedDB !== 'undefined' && !!indexedDB;
  } catch {
    return false;
  }
}

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV);
      if (!db.objectStoreNames.contains(BACKUPS)) db.createObjectStore(BACKUPS, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
  }).catch((e) => {
    dbPromise = null;
    throw e;
  });
  return dbPromise;
}

// 事务完成后 resolve 出「请求对象」；取结果统一走 resultOf()。
// 注意：不能在这里就把 out.result 当成值返回 —— 空结果（undefined）会被
// 误判成"还没取到"，从而把 IDBRequest 对象本身当成数据返回（写库时报不可克隆）。
function tx(db, store, mode, run) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let req;
    try {
      req = run(s);
    } catch (e) {
      reject(e);
      return;
    }
    t.oncomplete = () => resolve(req);
    t.onerror = () => reject(t.error || new Error('事务失败'));
    t.onabort = () => reject(t.error || new Error('事务中止'));
  });
}

const resultOf = (req) => (req && typeof req === 'object' && 'result' in req ? req.result : req);

async function idbGet(store, key) {
  const db = await openDB();
  return resultOf(await tx(db, store, 'readonly', (s) => s.get(key)));
}
async function idbPut(store, value, key) {
  const db = await openDB();
  return resultOf(await tx(db, store, 'readwrite', (s) => (key === undefined ? s.put(value) : s.put(value, key))));
}
async function idbAll(store) {
  const db = await openDB();
  return resultOf(await tx(db, store, 'readonly', (s) => s.getAll())) || [];
}
async function idbDel(store, key) {
  const db = await openDB();
  await tx(db, store, 'readwrite', (s) => s.delete(key));
}
async function idbClear(store) {
  const db = await openDB();
  await tx(db, store, 'readwrite', (s) => s.clear());
}

// ---------- 底层：localStorage（降级） ----------

function lsGet(key, d) {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    return raw ? JSON.parse(raw) : d;
  } catch {
    return d;
  }
}
function lsSet(key, v) {
  try {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(v));
    return true;
  } catch {
    return false;
  }
}
function lsDel(key) {
  try {
    localStorage.removeItem(LS_PREFIX + key);
  } catch {
    /* 忽略 */
  }
}

// ---------- 通用读写（自动选择驱动） ----------

async function readKey(key, fallback) {
  if (driver === 'idb') return (await idbGet(KV, key)) ?? fallback;
  return lsGet(key, fallback);
}
async function writeKey(key, value) {
  if (driver === 'idb') return idbPut(KV, plain(value), key);
  return lsSet(key, value);
}

// 写入 IndexedDB 前必须先剥离 Vue 响应式代理：结构化克隆不认识 Proxy，
// 会报 "could not be cloned"。顺带也保证存进去的一定是纯数据。
function plain(v) {
  if (v === undefined || v === null) return v;
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return v;
  }
}

/** 初始化存储驱动（幂等）。IndexedDB 不可用时自动降级并返回实际驱动名 */
export async function initStore() {
  if (driver !== 'unknown') return driver;
  if (!idbUsable()) {
    driver = 'ls';
    return driver;
  }
  try {
    await openDB();
    driver = 'idb';
  } catch {
    driver = 'ls';
  }
  return driver;
}

export function storeDriver() {
  return { idb: 'IndexedDB', ls: 'localStorage（降级）' }[driver] || '未初始化';
}

// ---------- 持仓 ----------

/** 读取持仓（含旧版本迁移，返回的数组可直接使用） */
export async function loadHoldings() {
  await initStore();
  const raw = await readKey(KEY_HOLDINGS, []);
  const { list, changed } = migrateHoldings(raw);
  if (changed) await writeKey(KEY_HOLDINGS, list);
  return list;
}

// 上次写入的指纹：用于「只在交易数据真的变了才备份」
async function loadMeta() {
  return (
    (await readKey(KEY_META, null)) || { backupSignature: null, lastExportAt: null, updatedAt: null }
  );
}
async function saveMeta(meta) {
  await writeKey(KEY_META, { ...(await loadMeta()), ...meta });
}

/**
 * 保存持仓：先为「写入前的状态」留一份备份（数据没变则跳过），再落盘。
 * @param {Array} list 新的持仓列表（会先被迁移规整）
 * @param {string} [reason] 备份原因（展示用）
 */
export async function saveHoldings(list, reason = '数据变更') {
  await initStore();
  const { list: next } = migrateHoldings(list);
  const prev = await readKey(KEY_HOLDINGS, null);
  if (prev && Array.isArray(prev)) await backupIfChanged(prev, reason);
  await writeKey(KEY_HOLDINGS, next);
  await saveMeta({ updatedAt: new Date().toISOString() });
  return next;
}

// ---------- 自动备份 ----------

async function addBackup(record) {
  const rec = plain(record);
  if (driver === 'idb') {
    await idbPut(BACKUPS, rec);
    const all = await idbAll(BACKUPS);
    const sorted = (all || []).sort((a, b) => String(b.id).localeCompare(String(a.id)));
    for (const old of sorted.slice(MAX_BACKUPS)) await idbDel(BACKUPS, old.id).catch(() => {});
  } else {
    const all = lsGet('backups', []);
    all.push(rec);
    all.sort((a, b) => String(b.id).localeCompare(String(a.id)));
    lsSet('backups', all.slice(0, MAX_BACKUPS));
  }
}

async function backupIfChanged(prevList, reason) {
  const sig = dataSignature(prevList);
  const meta = await loadMeta();
  if (meta.backupSignature === sig) return false;
  const [snapshots, settings] = await Promise.all([readKey(KEY_SNAPSHOTS, []), readKey(KEY_SETTINGS, null)]);
  await addBackup({
    id: `${new Date().toISOString()}-${Math.random().toString(36).slice(2, 6)}`,
    at: new Date().toISOString(),
    reason,
    signature: sig,
    count: (prevList || []).length,
    holdings: prevList,
    snapshots: snapshots || [],
    settings: settings || null,
  });
  await saveMeta({ backupSignature: sig });
  return true;
}

/** 手动备份当前状态（导入/覆盖前的安全网） */
export async function createBackup(reason = '手动备份') {
  await initStore();
  const holdings = await loadHoldings();
  const snapshots = await readKey(KEY_SNAPSHOTS, []);
  const settings = await readKey(KEY_SETTINGS, null);
  await addBackup({
    id: `${new Date().toISOString()}-${Math.random().toString(36).slice(2, 6)}`,
    at: new Date().toISOString(),
    reason,
    signature: dataSignature(holdings),
    count: holdings.length,
    holdings,
    snapshots,
    settings,
  });
  return true;
}

/** 备份列表（新的在前，不含数据本体，避免把大对象塞进 UI） */
export async function listBackups() {
  await initStore();
  const all = driver === 'idb' ? await idbAll(BACKUPS) : lsGet('backups', []);
  return (all || [])
    .map((b) => ({
      id: b.id,
      at: b.at,
      reason: b.reason,
      count: b.count,
      snapshots: (b.snapshots || []).length,
      size: JSON.stringify(b.holdings || []).length,
    }))
    .sort((a, b) => String(b.id).localeCompare(String(a.id)));
}

export async function getBackup(id) {
  await initStore();
  if (driver === 'idb') return (await idbGet(BACKUPS, id)) || null;
  return (lsGet('backups', []) || []).find((b) => b.id === id) || null;
}

export async function deleteBackup(id) {
  await initStore();
  if (driver === 'idb') return idbDel(BACKUPS, id);
  const all = (lsGet('backups', []) || []).filter((b) => b.id !== id);
  return lsSet('backups', all);
}

/** 回滚到某个备份（回滚前会先给当前状态留一份备份，避免"回滚错了"没得救） */
export async function restoreBackup(id) {
  const b = await getBackup(id);
  if (!b) throw new Error('备份不存在');
  await createBackup('回滚前自动备份');
  await writeKey(KEY_HOLDINGS, b.holdings || []);
  await writeKey(KEY_SNAPSHOTS, b.snapshots || []);
  if (b.settings) await writeKey(KEY_SETTINGS, b.settings);
  await saveMeta({ backupSignature: b.signature || null, updatedAt: new Date().toISOString() });
  return { holdings: (b.holdings || []).length, snapshots: (b.snapshots || []).length };
}

// ---------- 快照 ----------

export async function loadSnapshots() {
  await initStore();
  return (await readKey(KEY_SNAPSHOTS, [])) || [];
}

export async function saveSnapshots(list) {
  await initStore();
  const sorted = [...(list || [])].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  await writeKey(KEY_SNAPSHOTS, sorted);
  return sorted;
}

/** 按日期 upsert（同一天重复收盘检测时覆盖，保证幂等） */
export async function upsertSnapshot(record) {
  const list = await loadSnapshots();
  return saveSnapshots(upsertSnapshotInList(list, record));
}

// ---------- 设置 ----------

export async function loadSettings() {
  await initStore();
  const s = await readKey(KEY_SETTINGS, null);
  return {
    ...DEFAULT_SETTINGS,
    ...(s || {}),
    fx: { ...DEFAULT_SETTINGS.fx, ...(s?.fx || {}) },
    notify: { ...DEFAULT_SETTINGS.notify, ...(s?.notify || {}) },
    schedule: { ...DEFAULT_SETTINGS.schedule, ...(s?.schedule || {}) },
  };
}

export async function saveSettings(patch) {
  await initStore();
  const cur = await loadSettings();
  const next = {
    ...cur,
    ...patch,
    fx: { ...cur.fx, ...(patch?.fx || {}) },
    notify: { ...cur.notify, ...(patch?.notify || {}) },
    schedule: { ...cur.schedule, ...(patch?.schedule || {}) },
  };
  await writeKey(KEY_SETTINGS, next);
  return next;
}

// ---------- 导出 / 导入 ----------

/**
 * 全量导出（用于换设备 / 备份自救）。
 * 不含任何服务端才有的东西（token、飞书密钥），只有你的持仓数据。
 */
export async function exportBundle() {
  await initStore();
  const [holdings, snapshots, settings, meta] = await Promise.all([
    loadHoldings(),
    readKey(KEY_SNAPSHOTS, []),
    loadSettings(),
    loadMeta(),
  ]);
  return {
    app: 'stock-advisor',
    kind: 'full-backup',
    version: BUNDLE_VERSION,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    holdings,
    snapshots: snapshots || [],
    settings,
    meta: { lastExportAt: meta.lastExportAt, updatedAt: meta.updatedAt },
  };
}

/** 标记"刚刚导出过"（用于提醒用户定期备份） */
export async function markExported() {
  await saveMeta({ lastExportAt: new Date().toISOString() });
}

/** 校验导入文件结构，返回规整后的 bundle */
export function parseBundle(text) {
  let obj;
  try {
    obj = typeof text === 'string' ? JSON.parse(text) : text;
  } catch {
    throw new Error('不是合法的 JSON 文件');
  }
  // 兼容两种历史格式：完整备份包 / 裸 holdings 数组（服务端 data/holdings.json）
  if (Array.isArray(obj)) {
    return { app: 'stock-advisor', kind: 'holdings-only', holdings: obj, snapshots: [], settings: null };
  }
  const holdings = obj?.holdings ?? obj?.data?.holdings ?? obj?.data;
  if (!Array.isArray(holdings)) throw new Error('文件里找不到 holdings 数组');
  return {
    app: obj.app || 'unknown',
    kind: obj.kind || 'holdings-only',
    exportedAt: obj.exportedAt || null,
    holdings,
    snapshots: Array.isArray(obj.snapshots) ? obj.snapshots : [],
    settings: obj.settings || null,
  };
}

// 合并策略：以 region+code 为业务主键；同一品种取「交易记录更完整」的一方，
// 双方独有的品种都保留。这样既能补全，又不会把精心录入的明细覆盖掉。
function richness(h) {
  return (
    (h?.purchases?.length || 0) + (h?.sells?.length || 0) + (h?.dividends?.length || 0) + (h?.splits?.length || 0)
  );
}
function bizKey(h) {
  return `${String(h?.region || '').trim()}|${String(h?.code || '').trim()}`;
}

/**
 * 导入数据。
 * @param {Object} bundle parseBundle 的结果
 * @param {'replace'|'merge'} mode
 */
export async function importBundle(bundle, mode = 'merge') {
  await initStore();
  // 覆盖/合并前先给现状留一份备份（导入错了可以回滚）
  await createBackup(`导入前自动备份（${mode === 'replace' ? '覆盖' : '合并'}）`);

  const incoming = migrateHoldings(bundle.holdings).list;

  if (mode === 'replace') {
    await writeKey(KEY_HOLDINGS, incoming);
    if (bundle.snapshots?.length) await saveSnapshots(bundle.snapshots);
    if (bundle.settings) await writeKey(KEY_SETTINGS, bundle.settings);
  } else {
    const local = await loadHoldings();
    const byKey = new Map(local.map((h) => [bizKey(h), h]));
    let added = 0;
    let updated = 0;
    for (const inc of incoming) {
      const key = bizKey(inc);
      const cur = byKey.get(key);
      if (!cur) {
        byKey.set(key, inc);
        added += 1;
      } else if (richness(inc) > richness(cur)) {
        byKey.set(key, inc);
        updated += 1;
      }
    }
    await writeKey(KEY_HOLDINGS, [...byKey.values()]);
    if (bundle.snapshots?.length) {
      const cur = await loadSnapshots();
      const dates = new Set(cur.map((s) => s.date));
      await saveSnapshots([...cur, ...bundle.snapshots.filter((s) => !dates.has(s.date))]);
    }
    if (bundle.settings) {
      const cur = await loadSettings();
      await writeKey(KEY_SETTINGS, { ...cur, ...bundle.settings });
    }
    await saveMeta({ updatedAt: new Date().toISOString() });
    return { mode, added, updated, total: byKey.size };
  }

  await saveMeta({ updatedAt: new Date().toISOString() });
  return { mode, added: incoming.length, updated: 0, total: incoming.length };
}

// ---------- 维护 ----------

export async function clearAll() {
  await initStore();
  if (driver === 'idb') {
    await idbClear(KV).catch(() => {});
    await idbClear(BACKUPS).catch(() => {});
  } else {
    [KEY_HOLDINGS, KEY_SNAPSHOTS, KEY_SETTINGS, KEY_META, 'backups'].forEach(lsDel);
  }
  await saveMeta({ backupSignature: null, lastExportAt: null, updatedAt: null });
  return true;
}

/** 存储概览（供数据面板展示） */
export async function storageInfo() {
  await initStore();
  const [holdings, snapshots, meta, backups] = await Promise.all([
    readKey(KEY_HOLDINGS, []),
    readKey(KEY_SNAPSHOTS, []),
    loadMeta(),
    listBackups(),
  ]);
  let usedBytes = null;
  try {
    const est = await navigator.storage?.estimate?.();
    usedBytes = est?.usage ?? null;
  } catch {
    /* 忽略 */
  }
  return {
    driver: storeDriver(),
    holdingsCount: (holdings || []).length,
    snapshotsCount: (snapshots || []).length,
    backups: backups.length,
    lastExportAt: meta.lastExportAt,
    updatedAt: meta.updatedAt,
    usedBytes,
  };
}
