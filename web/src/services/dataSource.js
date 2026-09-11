// 数据源门面：把「服务端模式」与「本地数据模式」收敛到同一组接口。
//
// 为什么需要它：Phase 1 的目标是「砍掉后端，数据只存浏览器」，但改造期间必须
// 随时有一个能跑的版本。因此业务代码（useHoldings / 组件）只依赖这里的方法，
// 两种模式通过 mode 切换，互不影响。
//
//   server 模式：沿用原来的一套 REST 调用（后端 Node 服务提供数据与实时行情）
//   local  模式：数据存本机 IndexedDB（web/src/store/localStore.js），
//                计算走前后端共享的 web/src/core/*，实时行情由浏览器直连腾讯/东财
//
// 切换方式（优先级从高到低）：
//   1. 地址栏 ?mode=local / ?mode=server  （会被记住）
//   2. 数据面板里的开关（写入 localStorage）
//   3. 构建期环境变量 VITE_DATA_MODE=local
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
import { createHolding } from '../core/schema.js';
import { buildStats } from '../core/stats.js';
import { buildCsv } from '../core/csv.js';
import { getRates, ratesInfo } from '../core/rates.js';
import { importCsvText } from '../core/import-csv-core.js';
import { buildSnapshot, upsertSnapshotInList } from '../core/snapshot.js';
import { refreshQuotes } from '../core/quote.js';
import { anyMarketOpen, beijingNow, parseHHMM } from '../core/market.js';
import * as local from '../store/localStore.js';

const MODE_KEY = 'stock-advisor:data-mode';
export const MODES = ['local', 'server'];

export const MODE_LABEL = {
  local: '本地数据（仅存这台设备）',
  server: '服务端数据（后端接口）',
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
  return import.meta.env.VITE_DATA_MODE === 'local' ? 'local' : 'server';
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

export function isLocalMode() {
  return currentMode() === 'local';
}

// =====================================================================
// 服务端模式
// =====================================================================

const TOKEN_KEY = 'stock-advisor-token';
let authToken = '';
try {
  authToken = localStorage.getItem(TOKEN_KEY) || '';
  // 支持用 ?token=xxx 一次性登录：写入本地后从地址栏抹掉，避免泄露到历史记录
  const u = new URL(window.location.href);
  const t = u.searchParams.get('token');
  if (t) {
    authToken = t;
    localStorage.setItem(TOKEN_KEY, t);
    u.searchParams.delete('token');
    window.history.replaceState({}, '', u.toString());
  }
} catch {
  // 隐私模式等场景忽略
}

export function getAuthToken() {
  return authToken;
}

export function setAuthToken(t) {
  authToken = String(t || '').trim();
  try {
    if (authToken) localStorage.setItem(TOKEN_KEY, authToken);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // 忽略
  }
}

function withToken(headers = {}) {
  return authToken ? { ...headers, Authorization: `Bearer ${authToken}` } : headers;
}

/** 统一请求封装：自动带鉴权头，401 给出可操作提示 */
export async function apiFetch(url, init = {}) {
  const res = await fetch(url, { ...init, headers: withToken(init.headers) });
  if (res.status === 401) {
    throw new Error('未授权：请在 config.json 设置 auth.token，并访问 http://<host>:<port>/?token=<你的token> 完成一次登录');
  }
  return res;
}

async function jsonOf(res) {
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `请求失败（${res.status}）`);
  return json;
}

const serverSource = {
  mode: 'server',
  async list() {
    return jsonOf(await apiFetch('/api/holdings'));
  },
  async create(body) {
    return jsonOf(await apiFetch('/api/holdings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
  },
  async patch(id, body) {
    return jsonOf(await apiFetch(`/api/holdings/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
  },
  async recompute(id) {
    return jsonOf(await apiFetch(`/api/holdings/${id}/recompute`, { method: 'POST' }));
  },
  async addPurchase(id, body) {
    return jsonOf(await apiFetch(`/api/holdings/${id}/purchases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
  },
  async patchPurchase(id, pid, body) {
    return jsonOf(await apiFetch(`/api/holdings/${id}/purchases/${pid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
  },
  async deletePurchase(id, pid) {
    return jsonOf(await apiFetch(`/api/holdings/${id}/purchases/${pid}`, { method: 'DELETE' }));
  },
  async addTransaction(id, txn) {
    return jsonOf(await apiFetch(`/api/holdings/${id}/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(txn),
    }));
  },
  async patchTransaction(id, tid, body) {
    return jsonOf(await apiFetch(`/api/holdings/${id}/transactions/${tid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
  },
  async deleteTransaction(id, tid) {
    return jsonOf(await apiFetch(`/api/holdings/${id}/transactions/${tid}`, { method: 'DELETE' }));
  },
  async stats() {
    return jsonOf(await apiFetch('/api/stats/closed'));
  },
  async snapshots(range = 'all') {
    return jsonOf(await apiFetch(`/api/snapshots?range=${range}`));
  },
  async trend(range = '30d') {
    return jsonOf(await apiFetch(`/api/trend?range=${range}`));
  },
  async exportCsv(scope) {
    const res = await apiFetch(`/api/export?scope=${scope}`);
    if (!res.ok) {
      let msg = '导出失败';
      try {
        msg = (await res.json()).error || msg;
      } catch {
        /* 忽略 */
      }
      throw new Error(msg);
    }
    return res.text();
  },
  async importCsv(csv, opts = {}) {
    const body = { csv, ...opts };
    return jsonOf(await apiFetch('/api/import-csv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
  },
  async testFeishu() {
    return jsonOf(await apiFetch('/api/test-feishu', { method: 'POST' }));
  },
  async health() {
    return jsonOf(await apiFetch('/api/health'));
  },
};

// =====================================================================
// 本地数据模式
// =====================================================================

// 内存缓存：与 localStore 之间的写穿缓存，避免每次操作都重读存储
let cache = null;
let snapshotChecked = false;

async function loadLocal() {
  if (!cache) cache = await local.loadHoldings();
  return cache;
}

/** 外部直接改过本地存储（导入 / 回滚 / 清空）后，丢弃内存缓存，强制下次重新读取 */
export function resetLocalCache() {
  cache = null;
  snapshotChecked = false;
}

async function persistLocal(reason) {
  cache = await local.saveHoldings(cache, reason);
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
      if (quote.quoteOk > 0) await persistLocal('行情更新');
    }
    await maybeSnapshot(settings).catch(() => {});

    return {
      data: list.map(withDerived),
      fx: { ...ratesInfo(settings), autoUpdate: false },
      costMethods: COST_METHODS,
      quote,
      mode: 'local',
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

  // 收益趋势依赖历史 K 线重放（Phase 2 迁到前端）；本地模式先给出明确的"暂不支持"
  async trend() {
    const err = new Error('本地数据模式暂不支持收益趋势（历史 K 线重放将在下一阶段迁移）');
    err.unsupported = true;
    throw err;
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

  async testFeishu() {
    throw new Error('本地数据模式下没有服务端推送，飞书提醒请使用「服务端数据」模式或命令行脚本');
  },

  async health() {
    const settings = await local.loadSettings();
    const list = await loadLocal();
    return {
      ok: true,
      mode: 'local',
      holdings: { total: list.length, active: list.filter(isActive).length },
      store: await local.storageInfo(),
      fx: ratesInfo(settings),
    };
  },
};

// =====================================================================
// 门面
// =====================================================================

/** 当前模式对应的数据源 */
export function dataSource() {
  return currentMode() === 'local' ? localSource : serverSource;
}

// 数据面板 / 备份导出用的本地存储工具（仅本地模式有意义）
export { local as localStore };
