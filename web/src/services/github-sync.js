// GitHub 仓库云同步：把私有仓库里的一个文件当作「数据库」。
//
// 分工：
//   github-api.js  —— 只会读写文件（含 sha 乐观锁）
//   sync-payload.js—— 只会把备份包加密/解密成文本
//   本文件         —— 同步策略：何时拉、何时推、怎么合并、怎么处理冲突
//
// 数据流（三端一致）：
//   本地 IndexedDB  ──exportBundle()──▶  bundle  ──wrapForUpload(口令)──▶  密文文本  ──PUT──▶  仓库文件
//   本地 IndexedDB  ◀──importBundle()── bundle  ◀──unwrapPayload(口令)──  密文文本  ◀──GET──  仓库文件
//
// 冲突策略：以 localStore 的 meta.updatedAt 与远程信封 savedAt 比较。
//   - 两边都有改动 → 先拉后推（merge 语义：按 region|code 合并，字段更完整的记录胜出）
//   - 只有一边变了   → 只做对应方向
//   - 远程 sha 变了但本地没改 → 直接拉取覆盖
//   sha 不匹配（别人刚推过）时自动重试一次，避免把别人的提交顶掉。

import * as local from '../store/localStore.js';
import * as gh from './github-api.js';
import { unwrapPayload, wrapForUpload, cryptoAvailable } from '../core/sync-payload.js';

const CONFIG_KEY = 'stock-advisor:github-config';
const STATE_KEY = 'stock-advisor:github-state';

export const DEFAULT_CONFIG = {
  owner: '',
  repo: '',
  path: 'stock-advisor-data.json',
  branch: 'main',
  token: '',
  passphrase: '',
  autoPush: true,
};

/** 读取本地保存的 GitHub 配置（token 与口令都只存在这台设备） */
export function loadConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** 合并保存配置；passphrase 传 undefined 表示不改动 */
export function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch };
  localStorage.setItem(CONFIG_KEY, JSON.stringify(next));
  return next;
}

export function clearConfig() {
  localStorage.removeItem(CONFIG_KEY);
  localStorage.removeItem(STATE_KEY);
}

export function isConfigured(cfg = loadConfig()) {
  return !!(cfg.owner && cfg.repo && cfg.token);
}

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(STATE_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveState(patch) {
  const next = { ...loadState(), ...patch };
  localStorage.setItem(STATE_KEY, JSON.stringify(next));
  return next;
}

export function syncState() {
  const s = loadState();
  return {
    lastSyncAt: s.lastSyncAt || null,
    lastDirection: s.lastDirection || null,
    lastSha: s.lastSha || null,
    lastError: s.lastError || null,
  };
}

/** 把错误记到 state 里再抛出，让 UI 能显示「上次同步失败」 */
function recordError(err) {
  saveState({ lastError: err?.message || String(err) });
  throw err;
}

/**
 * 拉取远程 → 合并进本地。
 * @returns {Promise<{added:number, updated:number, total:number, savedAt:string|null, encrypted:boolean}>}
 */
export async function pull(cfg = loadConfig()) {
  const filePath = gh.normalizePath(cfg.path);
  let remote;
  try {
    remote = await gh.readFile(cfg, { path: filePath, branch: cfg.branch });
  } catch (err) {
    recordError(err);
  }

  if (!remote) {
    saveState({ lastSyncAt: new Date().toISOString(), lastDirection: 'pull-empty', lastError: null });
    return { added: 0, updated: 0, total: 0, savedAt: null, encrypted: false, empty: true };
  }

  let bundle;
  let encrypted = false;
  try {
    const unwrapped = await unwrapPayload(remote.text, cfg.passphrase);
    bundle = unwrapped.bundle;
    encrypted = unwrapped.encrypted;
  } catch (err) {
    recordError(err);
  }

  const result = await local.importBundle(bundle, 'merge');
  saveState({
    lastSyncAt: new Date().toISOString(),
    lastDirection: 'pull',
    lastSha: remote.sha,
    lastError: null,
    remoteSavedAt: bundle?.savedAt || null,
  });
  return { ...result, savedAt: remote.savedAt, encrypted };
}

/**
 * 本地 → 远程推送。
 * @param {{reason?:string, force?:boolean}} opts
 */
export async function push(opts = {}, cfg = loadConfig()) {
  const { reason = '数据变更', force = false } = opts;
  if (!isConfigured(cfg)) throw new Error('请先配置 GitHub 仓库与访问令牌');
  if (cfg.passphrase && !cryptoAvailable()) {
    throw new Error('当前环境不支持 WebCrypto，无法加密上传；请清空加密口令或换用 https 访问');
  }

  const filePath = gh.normalizePath(cfg.path);
  const bundle = await local.exportBundle();
  const text = await wrapForUpload(bundle, cfg.passphrase);

  // 先读一次拿 sha（GitHub 覆盖文件必须带 src sha）
  let current = null;
  try {
    current = await gh.readFile(cfg, { path: filePath, branch: cfg.branch });
  } catch (err) {
    recordError(err);
  }

  const message = `stock-advisor: ${reason} @ ${new Date().toISOString()}`;

  const attempt = async (sha) => gh.writeFile(cfg, { path: filePath, branch: cfg.branch, text, sha, message });

  let written;
  try {
    written = await attempt(current?.sha);
  } catch (err) {
    // sha 过期（别人刚推过）→ 重新读一次再试一次；仍失败就把错误抛给 UI
    if (err.status === 409 || err.status === 422) {
      if (!force) {
        const fresh = await gh.readFile(cfg, { path: filePath, branch: cfg.branch }).catch(() => null);
        if (fresh?.text && fresh.text !== text) {
          const e = new Error('远程已有更新，请先「从云端拉取」合并后再上传');
          e.conflict = true;
          recordError(e);
        }
        written = await attempt(fresh?.sha).catch((e2) => recordError(e2));
      } else {
        const fresh = await gh.readFile(cfg, { path: filePath, branch: cfg.branch }).catch(() => null);
        written = await attempt(fresh?.sha).catch((e2) => recordError(e2));
      }
    } else {
      recordError(err);
    }
  }

  saveState({
    lastSyncAt: new Date().toISOString(),
    lastDirection: 'push',
    lastSha: written?.sha || null,
    lastError: null,
  });
  return { sha: written?.sha || '', commit: written?.commit || '', savedAt: bundle.exportedAt };
}

/**
 * 智能双向同步：
 *   - 远端 sha 与上次同步记录不同（其他设备改过）→ 先拉后推，避免覆盖别人的改动
 *   - 远程比本地新 → 先拉后推（合并后统一写回）
 *   - 本地比远程新 → 直接推
 *   - 从未同步过   → 先试拉（仓库里已有数据就合并进来），再推
 */
export async function syncNow(cfg = loadConfig()) {
  if (!isConfigured(cfg)) throw new Error('请先配置 GitHub 仓库与访问令牌');

  const remote = await gh.readFile(cfg, { path: gh.normalizePath(cfg.path), branch: cfg.branch }).catch((err) => {
    if (err.status === 404) return null;
    recordError(err);
  });

  if (!remote) {
    const pushed = await push({ reason: '首次上传' }, cfg);
    return { direction: 'push', ...pushed, pulled: null };
  }

  const remoteAt = (() => {
    try {
      const obj = JSON.parse(remote.text);
      return obj.savedAt || null;
    } catch {
      return null;
    }
  })();

  const localInfo = await local.storageInfo();
  const localAt = localInfo.updatedAt || null;
  const remoteIsNewer = remoteAt && (!localAt || new Date(remoteAt) > new Date(localAt));
  // 远端 sha 与上次同步记录的不一致 → 云端一定有了本机没合并过的版本。
  // 此时即使本机时间更晚也要先拉后推，否则会把别人的改动覆盖掉。
  const lastSha = loadState().lastSha;
  const remoteChanged = !!remote.sha && !!lastSha && remote.sha !== lastSha;

  if (remoteChanged || remoteIsNewer) {
    const pulled = await pull(cfg);
    const pushed = await push({ reason: '合并云端新数据' }, cfg);
    return { direction: 'merge', ...pushed, pulled };
  }

  const pushed = await push({ reason: '同步到云端' }, cfg);
  return { direction: 'push', ...pushed, pulled: null };
}

/** 配置页「测试连接」 */
export async function testConnection(cfg = loadConfig()) {
  const res = await gh.testConnection(cfg);
  return res;
}

// —— 自动推送（防抖）—————————————————————————————————————
// 本地每次写操作后调用；只有「停止操作 AUTO_PUSH_DELAY_MS」后才推一次，
// 避免连续编辑 / CSV 导入 / 行情刷新刷出一堆提交。
// 页面隐藏或关闭前会尽量补推一次（不保证一定送达，重要改动请手动点「上传到云端」）。
function envMs(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// 直接写 import.meta.env.VITE_xxx，Vite 构建时才能静态替换（可选链不会被替换）
export const AUTO_PUSH_DELAY_MS = envMs(import.meta.env.VITE_AUTO_PUSH_DELAY_MS, 3 * 60 * 1000);
const REMOTE_POLL_MS = envMs(import.meta.env.VITE_REMOTE_POLL_MS, 60 * 1000);

let autoTimer = null;
let autoQueue = Promise.resolve();
let pendingReason = '数据变更';

/** 串行排队一次推送（失败只记日志，不打断用户操作） */
function enqueuePush(reason) {
  const cfg = loadConfig();
  if (!cfg.autoPush || !isConfigured(cfg)) return autoQueue;
  autoQueue = autoQueue
    .then(() => push({ reason }, loadConfig()))
    .catch((err) => {
      console.warn('[github-sync] 自动上传失败：', err?.message || err);
    });
  return autoQueue;
}

export function scheduleAutoPush(reason = '数据变更') {
  const cfg = loadConfig();
  if (!cfg.autoPush || !isConfigured(cfg)) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

  pendingReason = reason;
  if (autoTimer) clearTimeout(autoTimer);
  autoTimer = setTimeout(() => {
    autoTimer = null;
    enqueuePush(pendingReason);
  }, AUTO_PUSH_DELAY_MS);
}

/** 立刻推掉待上传的改动；没有待推内容时什么都不做 */
export function flushAutoPush() {
  if (!autoTimer) return autoQueue;
  clearTimeout(autoTimer);
  autoTimer = null;
  return enqueuePush(pendingReason);
}

/** 取消待执行的自动推送（例如切换数据模式时） */
export function cancelAutoPush() {
  if (autoTimer) clearTimeout(autoTimer);
  autoTimer = null;
}

// —— 监听云端是否有其他设备的更新 ————————————————————————
/**
 * 定时读取云端文件的 sha，与上次同步记录的 sha 比较；不同则回调。
 * 只读，不改任何数据；未配置 / 离线 / 页面隐藏时跳过本轮。
 * @param {(info: { sha: string, savedAt: string|null }) => void} onRemoteChange
 * @returns {() => void} 停止监听
 */
export function startRemoteWatch(onRemoteChange) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};

  let stopped = false;
  let timer = null;
  let inFlight = false;

  const check = async () => {
    if (stopped || inFlight) return;
    if (document.visibilityState === 'hidden') return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    if (!isConfigured()) return; // 还没填仓库/令牌：不打扰，等配置好后的下一轮
    inFlight = true;
    try {
      const cfg = loadConfig();
      const remote = await gh.readFile(cfg, { path: gh.normalizePath(cfg.path), branch: cfg.branch });
      const lastSha = loadState().lastSha;
      // 只有「同步过一次」之后才知道自己是哪一版；首次上传/拉取前不提示
      if (remote?.sha && lastSha && remote.sha !== lastSha) {
        let savedAt = null;
        try {
          savedAt = JSON.parse(remote.text)?.savedAt || null; // 密文信封解析不出，属正常
        } catch {
          /* ignore */
        }
        onRemoteChange({ sha: remote.sha, savedAt });
      }
    } catch {
      // 网络抖动 / 令牌过期：静默，下一轮再试
    } finally {
      inFlight = false;
    }
  };

  const loop = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      timer = null;
      await check();
      loop();
    }, REMOTE_POLL_MS);
  };

  const onVisible = () => {
    if (document.visibilityState === 'visible') check();
  };

  check();
  loop();
  document.addEventListener('visibilitychange', onVisible);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
