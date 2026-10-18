// 数据源门面：把两种「数据存放位置」收敛到同一组接口。
//
// 本项目是纯静态站点（GitHub Pages 直出）：没有后端，也不请求任何自有服务器。
//
//   local  模式：数据只存本机 IndexedDB（web/src/store/localStore.js），
//                计算走前后端共享的 web/src/core/*，实时行情由浏览器直连腾讯/东财
//   github 模式：同上（本机 IndexedDB 是工作副本），另外把整包数据加密后
//                同步到**你自己的 GitHub 私有仓库**里的一个文件。
//                好处：多设备共享同一份数据，且仓库是私有的 → 不对外泄露。
//                实现见 services/github-sync.js。
//
// 切换方式（优先级从高到低）：
//   1. 地址栏 ?mode=local / github  （会被记住）
//   2. 数据面板里的开关（写入 localStorage）
//   3. 构建期环境变量 VITE_DATA_MODE=local|github
import {
  withDerived,
  isActive,
  applyTransaction,
  normalizePurchase,
  normalizeCostMethod,
  recomputeSells,
  syncFromPurchases,
  COST_METHODS,
} from '../core/derive.js';
import { createHolding, dataSignature } from '../core/schema.js';
import { buildStats } from '../core/stats.js';
import { buildCsv } from '../core/csv.js';
import { getRates, ratesInfo } from '../core/rates.js';
import { importCsvText } from '../core/import-csv-core.js';
import { buildSnapshot, upsertSnapshotInList } from '../core/snapshot.js';
import { refreshQuotes } from '../core/quote.js';
import { anyMarketOpen, beijingNow, parseHHMM } from '../core/market.js';
import * as local from '../store/localStore.js';
import * as ghSync from './github-sync.js';

const MODE_KEY = 'stock-advisor:data-mode';
export const MODES = ['local', 'github'];

export const MODE_LABEL = {
  local: '本地数据（仅存这台设备）',
  github: 'GitHub 私有仓库（多设备同步）',
};

/** 头部徽标用的短标签 */
export const MODE_BADGE = {
  local: '🔒 本地数据',
  github: '☁️ 云同步',
};

/** 解析当前数据模式（并把 ?mode= 的选择记住） */
export function resolveMode() {
  try {
    const q = new URLSearchParams(window.location.search).get('mode');
    if (MODES.includes(q)) {
      localStorage.setItem(MODE_KEY, q);
      // 记住后从地址栏抹掉，避免以后永远被 URL 覆盖
      const u = new URL(window.location.href);
      u.searchParams.delete('mode');
      window.history.replaceState({}, '', u.toString());
      return q;
    }
    const saved = localStorage.getItem(MODE_KEY);
    if (MODES.includes(saved)) return saved;
  } catch {
    /* 隐私模式等场景忽略 */
  }
  return import.meta.env.VITE_DATA_MODE === 'github' ? 'github' : 'local';
}

let cachedMode = null;

export function currentMode() {
  if (!cachedMode) cachedMode = resolveMode();
  return cachedMode;
}

export function setMode(m) {
  if (!MODES.includes(m)) return currentMode();
  cachedMode = m;
  try {
    localStorage.setItem(MODE_KEY, m);
  } catch {
    /* 忽略 */
  }
  return m;
}

// =====================================================================
// 本地数据模式
// =====================================================================

// 内存缓存：与 localStore 之间的写穿缓存，避免每次操作都重读存储
let cache = null;
let snapshotChecked = false;
// 上一次落盘时的「交易数据指纹」：行情/提醒状态等易变字段已被剥离，
// 只有真正的持仓/交易改动才会改变它，用来判断这次写盘是否值得推送到云端。
let lastSavedSignature = null;

async function loadLocal() {
  if (!cache) {
    cache = await local.loadHoldings();
    lastSavedSignature = dataSignature(cache);
  }
  return cache;
}

/** 外部直接改过本地存储（导入 / 回滚 / 清空）后，丢弃内存缓存，强制下次重新读取 */
export function resetLocalCache() {
  cache = null;
  snapshotChecked = false;
  lastSavedSignature = null;
}

/**
 * 写盘并按需自动上传。
 * @param {string} reason 备份/提交信息
 * @param {{push?: boolean}} [opts] push=false 用于纯行情刷新：只写本机，不产生云端提交
 */
async function persistLocal(reason, { push = true } = {}) {
  const before = lastSavedSignature;
  cache = await local.saveHoldings(cache, reason);
  const signature = dataSignature(cache);
  lastSavedSignature = signature;

  // github 模式下，只有交易数据真的变了才把整包推到私有仓库（节流 1.5s）；
  // 行情刷新（currentPrice/lastUpdated 等易变字段）不会改变指纹，因此不会刷出一堆 commit。
  // local 模式下 scheduleAutoPush 内部会直接返回，不做任何事。
  if (push && signature !== before && currentMode() === 'github') ghSync.scheduleAutoPush(reason);
  return cache;
}

function findHolding(id) {
  const h = (cache || []).find((x) => x.id === id);
  if (!h) throw new Error('持仓不存在');
  return h;
}

const numOrNull = (v) => (v != null && v !== '' ? Number(v) : null);

// 每日快照补记：页面打开时若已过快照时间且当天还没记录，就用当前（最后已知）价格补一条。
// 浏览器做不到"到点自动执行"，这是无人值守能力被削弱后的补偿方案。
async function maybeSnapshot(settings) {
  if (snapshotChecked) return;
  snapshotChecked = true;
  if (settings?.schedule?.snapshot === false) return;
  const bj = beijingNow();
  const target = parseHHMM(settings?.schedule?.snapshotAt, '16:10');
  if (bj.minutes < target) return;
  const list = await local.loadSnapshots();
  if (list.some((s) => s.date === bj.date)) return;
  const snap = buildSnapshot(await loadLocal(), getRates(settings), bj.date);
  await local.saveSnapshots(upsertSnapshotInList(list, snap));
}

const localSource = {
  mode: 'local',

  async list() {
    const settings = await local.loadSettings();
    const list = await loadLocal();

    // 行情：浏览器直连（腾讯实时报价 / 东财基金净值）
    let quote = null;
    if (list.length) {
      const open = anyMarketOpen(list.filter(isActive));
      quote = await refreshQuotes(list, { maxMovePct: settings?.notify?.maxDailyMovePct });
      quote.open = open;
      // 行情只写本机：价格是易变数据，推到云端既没意义又会刷屏提交
      if (quote.quoteOk > 0) await persistLocal('行情更新', { push: false });
    }
    await maybeSnapshot(settings).catch(() => {});

    return {
      data: list.map(withDerived),
      fx: { ...ratesInfo(settings), autoUpdate: false },
      costMethods: COST_METHODS,
      quote,
      mode: currentMode(),
    };
  },

  async create(body) {
    const h = createHolding(body);
    cache = [...(cache || []), h];
    await persistLocal('新建持仓');
    return { data: withDerived(h) };
  },

  async patch(id, body) {
    const h = findHolding(id);
    if (body.dailyDropAlertPct !== undefined) h.dailyDropAlertPct = numOrNull(body.dailyDropAlertPct);
    if (body.dailyRiseAlertPct !== undefined) h.dailyRiseAlertPct = numOrNull(body.dailyRiseAlertPct);
    if (body.trailingStopPct !== undefined) {
      h.trailingStopPct = numOrNull(body.trailingStopPct);
      // 关闭或调整移动止盈时重置峰值基准，避免沿用旧的最高点
      if (!(Number(h.trailingStopPct) > 0)) h.peakReturnRate = null;
    }
    if (body.costMethod !== undefined) h.costMethod = normalizeCostMethod(body.costMethod);
    if (body.refillDropRate !== undefined) h.refillDropRate = Number(body.refillDropRate) || 0;
    if (body.refillPrice !== undefined) h.refillPrice = Number(body.refillPrice) || 0;
    if (body.nextStrategy !== undefined) h.nextStrategy = String(body.nextStrategy || '');
    if (body.targetProfitRate !== undefined) h.targetProfitRate = Number(body.targetProfitRate) || 0;
    if (body.stopLossRate !== undefined) h.stopLossRate = Number(body.stopLossRate) || 0;
    if (body.strategy !== undefined) h.strategy = String(body.strategy || '');
    h.dailyAlertSentDate = null; // 重置告警标记，让阈值改动立即生效
    syncFromPurchases(h);
    await persistLocal('更新持仓');
    return { data: withDerived(h) };
  },

  async recompute(id) {
    const h = findHolding(id);
    recomputeSells(h);
    await persistLocal('重算历史成本');
    return { data: withDerived(h) };
  },

  async addPurchase(id, body) {
    const h = findHolding(id);
    const p = normalizePurchase({ ...body, buyTime: body.buyTime || body.date });
    h.purchases = h.purchases || [];
    h.purchases.push(p);
    h.status = '持有';
    syncFromPurchases(h);
    await persistLocal('追加买入记录');
    return { data: withDerived(h) };
  },

  async patchPurchase(id, pid, body) {
    const h = findHolding(id);
    const p = (h.purchases || []).find((x) => x.id === pid);
    if (!p) throw new Error('买入记录不存在');
    if (body.buyPrice !== undefined) {
      const v = Number(body.buyPrice);
      if (v > 0) p.buyPrice = v;
    }
    if (body.buyQuantity !== undefined) {
      const v = Number(body.buyQuantity);
      if (v > 0) p.buyQuantity = v;
    }
    if (body.buyTime !== undefined && body.buyTime) p.buyTime = String(body.buyTime).slice(0, 10);
    if (body.fee !== undefined) p.fee = Number(body.fee) || 0;
    if (body.targetProfitRate !== undefined) p.targetProfitRate = Number(body.targetProfitRate) || 0;
    if (body.stopLossRate !== undefined) p.stopLossRate = Number(body.stopLossRate) || 0;
    syncFromPurchases(h);
    await persistLocal('修改买入记录');
    return { data: withDerived(h) };
  },

  async deletePurchase(id, pid) {
    const h = findHolding(id);
    const before = (h.purchases || []).length;
    h.purchases = (h.purchases || []).filter((x) => x.id !== pid);
    if (h.purchases.length === before) throw new Error('买入记录不存在');
    syncFromPurchases(h);
    if (h.purchases.length === 0) h.status = '全部卖出';
    await persistLocal('删除买入记录');
    return { data: withDerived(h) };
  },

  async addTransaction(id, txn) {
    const h = findHolding(id);
    applyTransaction(h, txn);
    await persistLocal('追加交易');
    return { data: withDerived(h) };
  },

  async patchTransaction(id, tid, body) {
    const h = findHolding(id);
    const sell = (h.sells || []).find((x) => x.id === tid);
    const div = (h.dividends || []).find((x) => x.id === tid);
    const split = (h.splits || []).find((x) => x.id === tid);
    if (!sell && !div && !split) throw new Error('交易记录不存在');
    if (sell) {
      if (body.fee !== undefined) sell.fee = Number(body.fee) || 0;
      if (body.price !== undefined && Number(body.price) > 0) sell.sellPrice = Number(body.price);
      if (body.quantity !== undefined && Number(body.quantity) > 0) sell.sellQuantity = Number(body.quantity);
      if (body.date !== undefined && body.date) sell.sellDate = String(body.date).slice(0, 10);
    }
    if (div) {
      if (body.amount !== undefined && Number(body.amount) > 0) div.amount = Number(body.amount);
      if (body.fee !== undefined) div.fee = Number(body.fee) || 0;
      if (body.date !== undefined && body.date) div.date = String(body.date).slice(0, 10);
      if (body.note !== undefined) div.note = String(body.note || '');
    }
    if (split) {
      if (body.ratio !== undefined && Number(body.ratio) > 0) split.ratio = Number(body.ratio);
      if (body.date !== undefined && body.date) split.date = String(body.date).slice(0, 10);
      if (body.note !== undefined) split.note = String(body.note || '');
    }
    syncFromPurchases(h);
    await persistLocal('修改交易记录');
    return { data: withDerived(h) };
  },

  async deleteTransaction(id, tid) {
    const h = findHolding(id);
    const before = (h.sells || []).length + (h.dividends || []).length + (h.splits || []).length;
    h.sells = (h.sells || []).filter((x) => x.id !== tid);
    h.dividends = (h.dividends || []).filter((x) => x.id !== tid);
    h.splits = (h.splits || []).filter((x) => x.id !== tid);
    const after = (h.sells || []).length + (h.dividends || []).length + (h.splits || []).length;
    if (after === before) throw new Error('交易记录不存在');
    syncFromPurchases(h);
    await persistLocal('删除交易记录');
    return { data: withDerived(h) };
  },

  async stats() {
    const settings = await local.loadSettings();
    return { data: buildStats(await loadLocal(), getRates(settings)) };
  },

  async snapshots(range = 'all') {
    const snaps = await local.loadSnapshots();
    const days = { '30d': 30, '90d': 90, '365d': 365, all: 0 }[range] ?? 0;
    let out = snaps;
    if (days > 0) {
      const cut = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      out = snaps.filter((s) => s.date >= cut);
    }
    return { data: out, total: snaps.length };
  },

  async exportCsv(scope) {
    const [settings, holdings, snapshots] = await Promise.all([
      local.loadSettings(),
      loadLocal(),
      local.loadSnapshots(),
    ]);
    return buildCsv(scope, { holdings, snapshots, rates: getRates(settings) });
  },

  async importCsv(csv, opts = {}) {
    const list = await loadLocal();
    const result = importCsvText(list, csv, {
      createMissing: !!opts.createMissing,
      costMethod: normalizeCostMethod(opts.costMethod),
    });
    await persistLocal('CSV 导入');
    return { data: result };
  },
};

// =====================================================================
// GitHub 私有仓库模式
// =====================================================================
// 数据仍然是本机 IndexedDB 的工作副本（所以离线可用、读取零延迟），
// 区别在于每次改动会节流推送到你自己的私有仓库，换设备/换浏览器时拉一次就回来了。
// 所有读写文件、加密、冲突处理都在 services/github-sync.js 里，这里只做薄包装。
const githubSource = {
  ...localSource,
  mode: 'github',

  async list() {
    const out = await localSource.list();
    return { ...out, mode: 'github' };
  },

  // 云同步专用的额外能力（DataModal 用）
  async syncPull() {
    const r = await ghSync.pull();
    resetLocalCache();
    return r;
  },
  async syncPush(reason = '手动同步') {
    return ghSync.push({ reason, force: true });
  },
  async syncNow() {
    const r = await ghSync.syncNow();
    resetLocalCache();
    return r;
  },
  syncState: ghSync.syncState,
};

// =====================================================================
// 门面
// =====================================================================

const SOURCES = { local: localSource, github: githubSource };

/** 当前模式对应的数据源 */
export function dataSource() {
  return SOURCES[currentMode()] || localSource;
}

// 数据面板 / 备份导出用的本地存储工具（两种模式都写本机 IndexedDB）
export { local as localStore };
// 云同步工具的再导出，供组件直接调用（配置、测试连接等）
export { ghSync as githubSync };
