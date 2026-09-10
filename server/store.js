import { readFile, writeFile, stat, mkdir, readdir, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import crypto from 'node:crypto';

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

// 运行时易变字段：不参与"交易数据是否变化"的判断，
// 否则每轮行情刷新都会产生一份备份（20s 一份，很快撑爆磁盘）。
const VOLATILE_KEYS = new Set([
  'currentPrice',
  'prevClose',
  'lastUpdated',
  'triggerState',
  'notifiedAt',
  'dailyAlertSentDate',
  'peakReturnRate',
]);

// 交易数据指纹：剥离易变字段后取 md5
function signatureOf(list) {
  const stripped = (list || []).map((h) => {
    const o = {};
    for (const [k, v] of Object.entries(h || {})) {
      if (!VOLATILE_KEYS.has(k)) o[k] = v;
    }
    return o;
  });
  return crypto.createHash('md5').update(JSON.stringify(stripped)).digest('hex');
}

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

// 旧版持仓为扁平结构（单条买入）；迁移为「多次买入记录」模型。
// 迁移会在首次加载时写入磁盘，之后始终以 purchases 模型持久化。
// 同时补齐后续版本新增字段（backwards-compatible，只增不改语义）。
export function migrateHolding(h) {
  let out = h;

  // v1 → v2：扁平买入 → purchases[]
  if (!Array.isArray(out.purchases)) {
    const p = {
      id: 'p' + (out.id || 'x') + '0',
      buyPrice: Number(out.buyPrice) || 0,
      buyQuantity: Number(out.buyQuantity) || 0,
      buyTime: out.buyTime || out.snapshotDate || new Date().toISOString().slice(0, 10),
      // 旧版仅有全局止盈(targetProfitRate)；止亏缺省 0（不触发止损）
      targetProfitRate: Number(out.targetProfitRate) || 0,
      stopLossRate: Number(out.stopLossRate) || 0,
      fee: 0,
    };
    out = { ...out, purchases: [p] };
  }

  // v2 → v3：手续费 / 分红 / 送转 / 成本法 / 移动止盈
  let changed =
    out.purchases.some((p) => p.fee == null) ||
    !Array.isArray(out.sells) ||
    !Array.isArray(out.dividends) ||
    !Array.isArray(out.splits) ||
    out.costMethod == null ||
    out.trailingStopPct === undefined;

  if (changed) {
    out = {
      ...out,
      purchases: out.purchases.map((p) => ({ ...p, fee: Number(p.fee) || 0 })),
      sells: (out.sells || []).map((s) => ({ ...s, fee: Number(s.fee) || 0 })),
      dividends: out.dividends || [],
      splits: out.splits || [],
      costMethod: out.costMethod || 'LIFO',
      trailingStopPct: out.trailingStopPct ?? null,
      peakReturnRate: out.peakReturnRate ?? null,
    };
  }

  // 统一历史状态值：'已卖出' → '全部卖出'
  if (out.status === '已卖出') {
    out = { ...out, status: '全部卖出' };
    changed = true;
  }

  return changed ? out : h;
}

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
