import { readFile, writeFile, stat, mkdir, readdir, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { migrateHolding, dataSignature } from '../web/src/core/schema.js';

// schema（旧版本迁移 / 变更指纹）已抽到前后端共享模块：web/src/core/schema.js
// 本地数据模式（浏览器 IndexedDB）用的是同一份实现，保证两种模式数据形态一致。
export { migrateHolding };

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const DATA_FILE = join(DATA_DIR, 'holdings.json');
const BACKUP_DIR = join(DATA_DIR, 'backups');
const SIG_FILE = join(BACKUP_DIR, '.last-signature');

// 备份配置（由 configureStore 从 config.json 注入）
let backupOptions = { enabled: true, keep: 30 };

export function configureStore(cfg) {
  const b = cfg?.backup || {};
  backupOptions = {
    enabled: b.enabled !== false,
    keep: Number(b.keep) > 0 ? Number(b.keep) : 30,
  };
}

// 内存缓存：调度器与 HTTP 接口共用同一份持仓，避免并发读写冲突
let cache = null;
// 缓存对应的文件修改时间（毫秒）。用于判断外部是否手动改过文件。
let cacheMtime = 0;
let writeChain = Promise.resolve();

// 取文件当前的 mtime（毫秒）；文件不存在时返回 0
async function getMtime() {
  try {
    const s = await stat(DATA_FILE);
    return s.mtimeMs;
  } catch {
    return 0;
  }
}

// ---------- 自动备份 ----------

// 交易数据指纹：剥离运行时易变字段（行情/提醒状态）后取哈希，
// 用于「只有交易数据真的变了才产生一份备份」。实现与前端共享，结果一致。
const signatureOf = dataSignature;

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// 清理旧备份：按文件名倒序保留最新 keep 份
async function pruneBackups(keep) {
  try {
    const files = (await readdir(BACKUP_DIR))
      .filter((f) => /^holdings-\d{8}-\d{6}\.json$/.test(f))
      .sort()
      .reverse();
    for (const f of files.slice(keep)) {
      await unlink(join(BACKUP_DIR, f)).catch(() => {});
    }
  } catch {
    // 目录不存在等情况忽略
  }
}

// 写盘前把"当前磁盘内容"另存为备份（即上一次的良好版本）。
// 仅当交易数据相对上次备份发生变化时才落一份，避免行情刷新产生海量备份。
async function backupBeforeWrite() {
  if (!backupOptions.enabled) return;
  try {
    const cur = await readFile(DATA_FILE, 'utf-8');
    const sig = signatureOf(JSON.parse(cur));
    const last = await readFile(SIG_FILE, 'utf-8').catch(() => '');
    if (sig === last.trim()) return;

    await mkdir(BACKUP_DIR, { recursive: true });
    await writeFile(join(BACKUP_DIR, `holdings-${stamp()}.json`), cur, 'utf-8');
    await writeFile(SIG_FILE, sig, 'utf-8');
    await pruneBackups(backupOptions.keep);
  } catch (e) {
    // 首次运行尚无数据文件属正常情况，其余错误显式告警（不阻塞主流程）
    if (e.code !== 'ENOENT') console.error('[store] 备份失败:', e.message);
  }
}

// ---------- 迁移 ----------
// migrateHolding 由 web/src/core/schema.js 提供（本文件顶部已再导出）。

export async function loadHoldings() {
  const mtime = await getMtime();
  // 仅在「首次加载」或「文件被外部修改过」时重新读盘，否则复用内存缓存
  if (!cache || mtime > cacheMtime) {
    const raw = await readFile(DATA_FILE, 'utf-8');
    let list = JSON.parse(raw);
    let changed = false;
    list = list.map((h) => {
      const m = migrateHolding(h);
      if (m !== h) changed = true;
      return m;
    });
    cache = list;
    cacheMtime = mtime;
    if (changed) await saveHoldings(list);
  }
  return cache;
}

// 串行写盘，防止调度器与接口同时写造成互相覆盖
export async function saveHoldings(holdings) {
  const data = holdings ?? cache;
  writeChain = writeChain
    .then(() => backupBeforeWrite())
    .then(() => writeFile(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8'))
    // 写盘后同步 mtime，避免把「自己刚写的」误判成外部改动而重复重载
    .then(async () => { cacheMtime = await getMtime(); })
    .catch((e) => console.error('[store] save error', e.message));
  return writeChain;
}

// 供 /api/health 与测试使用
export function storeInfo() {
  return { dataFile: DATA_FILE, backupDir: BACKUP_DIR, ...backupOptions };
}
