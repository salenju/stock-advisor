import { ref, computed } from 'vue';
import { REFRESH_MS } from '../constants/options.js';

// 模块级单例状态：所有组件共享同一份持仓数据
const holdings = ref([]);
const lastUpdated = ref('');
const loading = ref(false);
const error = ref('');

// 汇率配置（来自后端 /api/holdings 的 fx.rates，前端不抓汇率，直接用后端配置值）
const fxRates = ref({ CNY: 1 });

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
    const res = await fetch('/api/holdings');
    const json = await res.json();
    holdings.value = json.data || [];
    if (json.fx?.rates) fxRates.value = json.fx.rates;
    lastUpdated.value = new Date().toLocaleTimeString('zh-CN');
    countdown.value = REFRESH_MS / 1000; // 刷新后重置倒计时
  } catch (e) {
    error.value = '获取持仓失败：' + e.message;
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

// ---------- 概览汇总（全部按汇率换算成人民币） ----------
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

// ---------- 按币种小计（供概览卡片 tip 弹层展示） ----------
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

// ---------- 写操作：统一 fetch 后刷新列表 ----------
async function addHolding(b) {
  const res = await fetch('/api/holdings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(b),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || '添加失败');
  await fetchHoldings();
}

async function submitTransaction(txn) {
  const res = await fetch(`/api/holdings/${txn.id}/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: txn.type,
      price: txn.price,
      quantity: txn.quantity,
      date: txn.date || undefined,
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || '交易失败');
  await fetchHoldings();
}

async function savePurchase(form) {
  const { id, pid, buyPrice, buyQuantity, buyTime, targetProfitRate, stopLossRate } = form;
  const res = await fetch(`/api/holdings/${id}/purchases${pid ? '/' + pid : ''}`, {
    method: pid ? 'PATCH' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ buyPrice, buyQuantity, buyTime, targetProfitRate, stopLossRate }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || (pid ? '修改失败' : '添加失败'));
  await fetchHoldings();
}

async function deletePurchase(h, p) {
  if (!confirm(`确认删除 ${h.name} 的该笔买入记录？`)) return false;
  try {
    const res = await fetch(`/api/holdings/${h.id}/purchases/${p.id}`, { method: 'DELETE' });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || '删除失败');
    await fetchHoldings();
    return true;
  } catch (e) {
    alert(e.message);
    return false;
  }
}

// 更新持仓级字段（日涨跌告警阈值等）
async function updateHolding(id, body) {
  const res = await fetch(`/api/holdings/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || '更新失败');
  await fetchHoldings();
}

export function useHoldings() {
  return {
    holdings,
    lastUpdated,
    loading,
    error,
    countdown,
    fxRates,
    totalCost,
    totalMarket,
    totalHoldingProfit,
    totalTodayProfit,
    costByCurrency,
    marketByCurrency,
    todayProfitByCurrency,
    holdingProfitByCurrency,
    fetchHoldings,
    refreshNow,
    startAutoRefresh,
    stopAutoRefresh,
    addHolding,
    submitTransaction,
    savePurchase,
    deletePurchase,
    updateHolding,
  };
}
