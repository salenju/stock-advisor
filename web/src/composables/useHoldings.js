import { ref, computed } from 'vue';
import { REFRESH_MS } from '../constants/options.js';

// 模块级单例状态：所有组件共享同一份持仓数据
const holdings = ref([]);
const lastUpdated = ref('');
const loading = ref(false);
const error = ref('');

// ---------- 接口鉴权（对应后端 config.auth.token）----------
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

// 统一请求封装：自动带上鉴权头，401 时给出可操作提示
export async function apiFetch(url, init = {}) {
  const res = await fetch(url, { ...init, headers: withToken(init.headers) });
  if (res.status === 401) {
    throw new Error('未授权：请在 config.json 设置 auth.token，并访问 http://<host>:<port>/?token=<你的token> 完成一次登录');
  }
  return res;
}

// 汇率配置（来自后端 /api/holdings 的 fx，前端不抓汇率）
const fxRates = ref({ CNY: 1 });
const fxInfo = ref({ source: '', updatedAt: null });

// 与 server/provider/fx.js 内置值一致的兜底汇率
const DEFAULT_RATES = { CNY: 1, USD: 7.0, HKD: 0.9 };

// 取汇率（含兜底）
function rates() {
  const r = fxRates.value || {};
  return {
    CNY: 1,
    USD: Number(r.USD) > 0 ? Number(r.USD) : DEFAULT_RATES.USD,
    HKD: Number(r.HKD) > 0 ? Number(r.HKD) : DEFAULT_RATES.HKD,
  };
}

// 单笔金额按币种换算人民币（null/非法按 0）
function fxToCNY(v, currency) {
  const n = Number(v);
  return Number.isFinite(n) ? n * (rates()[currency] || 1) : 0;
}

// 自动刷新倒计时（秒）
const countdown = ref(REFRESH_MS / 1000);

let tick = null;

async function fetchHoldings() {
  loading.value = true;
  error.value = '';
  try {
    const res = await apiFetch('/api/holdings');
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || '获取持仓失败');
    holdings.value = json.data || [];
    if (json.fx?.rates) {
      fxRates.value = json.fx.rates;
      fxInfo.value = { source: json.fx.source || '', updatedAt: json.fx.updatedAt || null };
    }
    lastUpdated.value = new Date().toLocaleTimeString('zh-CN');
    countdown.value = REFRESH_MS / 1000; // 刷新后重置倒计时
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

function refreshNow() {
  fetchHoldings();
}

// 启动自动刷新：单一定时器，1 秒心跳递减，归零即刷新，避免多定时器漂移
function startAutoRefresh() {
  stopAutoRefresh();
  countdown.value = REFRESH_MS / 1000;
  tick = setInterval(() => {
    countdown.value -= 1;
    if (countdown.value <= 0) fetchHoldings();
  }, 1000);
}

function stopAutoRefresh() {
  if (tick) {
    clearInterval(tick);
    tick = null;
  }
}

// ---------- 复盘数据（收益归因 / 每日快照）----------
const stats = ref(null);
const statsLoading = ref(false);
const snapshots = ref([]);

async function fetchStats() {
  statsLoading.value = true;
  try {
    const res = await apiFetch('/api/stats/closed');
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || '获取统计失败');
    stats.value = json.data;
  } catch (e) {
    error.value = e.message;
  } finally {
    statsLoading.value = false;
  }
}

async function fetchSnapshots(range = 'all') {
  try {
    const res = await apiFetch(`/api/snapshots?range=${range}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || '获取快照失败');
    snapshots.value = json.data || [];
  } catch (e) {
    error.value = e.message;
  }
}

// 导出 CSV（带鉴权头，用 blob 下载）
async function exportCsv(scope = 'trades') {
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
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `stock-advisor-${scope}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------- 概览汇总（全部按汇率换算成人民币）----------
const totalCost = computed(() =>
  holdings.value.reduce((s, h) => s + fxToCNY(h.cost, h.currency), 0)
);
const totalMarket = computed(() =>
  holdings.value.reduce((s, h) => s + fxToCNY(h.marketValue, h.currency), 0)
);
const totalHoldingProfit = computed(() =>
  holdings.value.reduce((s, h) => s + fxToCNY(h.holdingProfit, h.currency), 0)
);
const totalTodayProfit = computed(() =>
  holdings.value.reduce((s, h) => s + fxToCNY(h.todayProfit, h.currency), 0)
);
const totalRealizedProfit = computed(() =>
  holdings.value.reduce((s, h) => s + fxToCNY(h.realizedProfit, h.currency), 0)
);

// ---------- 按币种小计（供概览卡片 tip 弹层展示）----------
function breakdownByCurrency(key) {
  const by = {};
  for (const h of holdings.value) {
    const v = Number(h[key]);
    if (h[key] == null || !Number.isFinite(v)) continue;
    const c = h.currency || 'CNY';
    by[c] = (by[c] || 0) + v;
  }
  return by;
}
const costByCurrency = computed(() => breakdownByCurrency('cost'));
const marketByCurrency = computed(() => breakdownByCurrency('marketValue'));
const todayProfitByCurrency = computed(() => breakdownByCurrency('todayProfit'));
const holdingProfitByCurrency = computed(() => breakdownByCurrency('holdingProfit'));
const realizedProfitByCurrency = computed(() => breakdownByCurrency('realizedProfit'));

// ---------- 写操作：统一 fetch 后刷新列表 ----------
async function addHolding(b) {
  const res = await apiFetch('/api/holdings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(b),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || '添加失败');
  await fetchHoldings();
}

// 统一交易提交：支持 BUY / SELL / DIVIDEND / SPLIT（含手续费）
async function submitTransaction(txn) {
  const res = await apiFetch(`/api/holdings/${txn.id}/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: txn.type,
      price: txn.price,
      quantity: txn.quantity,
      date: txn.date || undefined,
      fee: txn.fee,
      amount: txn.amount,
      ratio: txn.ratio,
      note: txn.note,
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || '交易失败');
  await fetchHoldings();
}

async function savePurchase(form) {
  const { id, pid, buyPrice, buyQuantity, buyTime, targetProfitRate, stopLossRate, fee } = form;
  const res = await apiFetch(`/api/holdings/${id}/purchases${pid ? '/' + pid : ''}`, {
    method: pid ? 'PATCH' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ buyPrice, buyQuantity, buyTime, targetProfitRate, stopLossRate, fee }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || (pid ? '修改失败' : '添加失败'));
  await fetchHoldings();
}

async function deletePurchase(h, p) {
  if (!confirm(`确认删除 ${h.name} 的该笔买入记录？`)) return false;
  try {
    const res = await apiFetch(`/api/holdings/${h.id}/purchases/${p.id}`, { method: 'DELETE' });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || '删除失败');
    await fetchHoldings();
    return true;
  } catch (e) {
    alert(e.message);
    return false;
  }
}

// 删除交易记录（卖出 / 分红 / 送转）
async function deleteTransaction(holdingId, txn) {
  const label = txn.type === 'DIVIDEND' ? '分红' : txn.type === 'SPLIT' ? '送转' : '卖出';
  if (!confirm(`确认删除该笔${label}记录（${txn.buyTime}）？`)) return false;
  try {
    const res = await apiFetch(`/api/holdings/${holdingId}/transactions/${txn.id}`, { method: 'DELETE' });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || '删除失败');
    await fetchHoldings();
    return true;
  } catch (e) {
    alert(e.message);
    return false;
  }
}

// 更新持仓级字段（告警阈值 / 成本法 / 移动止盈 / 补仓计划 等）
async function updateHolding(id, body) {
  const res = await apiFetch(`/api/holdings/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || '更新失败');
  await fetchHoldings();
}

// 用当前成本法重算历史卖出成本（会改写历史，需二次确认）
async function recomputeHolding(id, name) {
  if (!confirm(`确认按当前成本法重算「${name}」的历史卖出成本？\n这会改写已记录的卖出成本与盈亏，请先确认已备份 data/holdings.json。`)) return false;
  try {
    const res = await apiFetch(`/api/holdings/${id}/recompute`, { method: 'POST' });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || '重算失败');
    await fetchHoldings();
    return true;
  } catch (e) {
    alert(e.message);
    return false;
  }
}

export function useHoldings() {
  return {
    holdings,
    lastUpdated,
    loading,
    error,
    countdown,
    fxRates,
    fxInfo,
    totalCost,
    totalMarket,
    totalHoldingProfit,
    totalTodayProfit,
    totalRealizedProfit,
    costByCurrency,
    marketByCurrency,
    todayProfitByCurrency,
    holdingProfitByCurrency,
    realizedProfitByCurrency,
    stats,
    statsLoading,
    snapshots,
    fetchHoldings,
    fetchStats,
    fetchSnapshots,
    exportCsv,
    refreshNow,
    startAutoRefresh,
    stopAutoRefresh,
    addHolding,
    submitTransaction,
    savePurchase,
    deletePurchase,
    deleteTransaction,
    updateHolding,
    recomputeHolding,
  };
}
