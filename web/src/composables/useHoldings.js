import { ref, computed } from 'vue';
import { REFRESH_MS } from '../constants/options.js';
import {
  dataSource,
  currentMode,
  setMode,
  isLocalMode,
  MODE_LABEL,
  getAuthToken,
  setAuthToken,
  apiFetch,
} from '../services/dataSource.js';
import { downloadCsv } from '../core/csv.js';

// 鉴权工具与统一 fetch 已迁到 dataSource（两种模式共用），这里再导出以保持调用方不变
export { getAuthToken, setAuthToken, apiFetch, currentMode, setMode, isLocalMode, MODE_LABEL };

// 模块级单例状态：所有组件共享同一份持仓数据
const holdings = ref([]);
const lastUpdated = ref('');
const loading = ref(false);
const error = ref('');

// 汇率配置（服务端模式来自 /api/holdings 的 fx；本地模式来自本地设置）
const fxRates = ref({ CNY: 1 });
const fxInfo = ref({ source: '', updatedAt: null });

// 与后端 server/provider/fx.js 内置值一致的兜底汇率
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

// 最近一次行情拉取的诊断信息（本地模式会填 quote）
const quoteInfo = ref(null);

async function fetchHoldings() {
  loading.value = true;
  error.value = '';
  try {
    const json = await dataSource().list();
    holdings.value = json.data || [];
    if (json.fx?.rates) {
      fxRates.value = json.fx.rates;
      fxInfo.value = {
        source: json.fx.source || '',
        sourceLabel: json.fx.sourceLabel || '',
        updatedAt: json.fx.updatedAt || null,
      };
    }
    if (json.quote) quoteInfo.value = json.quote;
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
    const json = await dataSource().stats();
    stats.value = json.data;
  } catch (e) {
    error.value = e.message;
  } finally {
    statsLoading.value = false;
  }
}

async function fetchSnapshots(range = 'all') {
  try {
    const json = await dataSource().snapshots(range);
    snapshots.value = json.data || [];
  } catch (e) {
    error.value = e.message;
  }
}

// 导出 CSV：拿到文本后在前端触发下载（两种模式行为一致）
async function exportCsv(scope = 'trades') {
  const text = await dataSource().exportCsv(scope);
  downloadCsv(`stock-advisor-${scope}-${new Date().toISOString().slice(0, 10)}.csv`, text);
}

/** CSV 导入（本地模式在浏览器内直接完成） */
async function importCsv(csv, opts) {
  const json = await dataSource().importCsv(csv, opts);
  await fetchHoldings();
  return json.data;
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

// ---------- 写操作：统一提交后刷新列表 ----------
async function addHolding(b) {
  await dataSource().create(b);
  await fetchHoldings();
}

// 统一交易提交：支持 BUY / SELL / DIVIDEND / SPLIT（含手续费）
async function submitTransaction(txn) {
  await dataSource().addTransaction(txn.id, {
    type: txn.type,
    price: txn.price,
    quantity: txn.quantity,
    date: txn.date || undefined,
    fee: txn.fee,
    amount: txn.amount,
    ratio: txn.ratio,
    note: txn.note,
  });
  await fetchHoldings();
}

async function savePurchase(form) {
  const { id, pid, buyPrice, buyQuantity, buyTime, targetProfitRate, stopLossRate, fee } = form;
  const body = { buyPrice, buyQuantity, buyTime, targetProfitRate, stopLossRate, fee };
  if (pid) await dataSource().patchPurchase(id, pid, body);
  else await dataSource().addPurchase(id, body);
  await fetchHoldings();
}

async function deletePurchase(h, p) {
  if (!confirm(`确认删除 ${h.name} 的该笔买入记录？`)) return false;
  try {
    await dataSource().deletePurchase(h.id, p.id);
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
    await dataSource().deleteTransaction(holdingId, txn.id);
    await fetchHoldings();
    return true;
  } catch (e) {
    alert(e.message);
    return false;
  }
}

// 更新持仓级字段（告警阈值 / 成本法 / 移动止盈 / 补仓计划 等）
async function updateHolding(id, body) {
  await dataSource().patch(id, body);
  await fetchHoldings();
}

// 用当前成本法重算历史卖出成本（会改写历史，需二次确认）
async function recomputeHolding(id, name) {
  const backupNote = isLocalMode()
    ? '本地模式会在改动前自动留一份版本快照，可在「数据」面板回滚。'
    : '请先确认已备份 data/holdings.json。';
  if (!confirm(`确认按当前成本法重算「${name}」的历史卖出成本？\n这会改写已记录的卖出成本与盈亏，${backupNote}`)) return false;
  try {
    await dataSource().recompute(id);
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
    quoteInfo,
    fxRates,
    fxInfo,
    mode: currentMode,
    modeLabel: MODE_LABEL,
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
    importCsv,
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
