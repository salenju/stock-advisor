import { ref, computed } from 'vue';
import { REFRESH_MS } from '../constants/options.js';

// 模块级单例状态：所有组件共享同一份持仓数据
const holdings = ref([]);
const lastUpdated = ref('');
const loading = ref(false);
const error = ref('');

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

// ---------- 概览汇总 ----------
const totalCost = computed(() =>
  holdings.value.reduce((s, h) => s + (Number(h.cost) || 0), 0)
);
const totalMarket = computed(() =>
  holdings.value.reduce((s, h) => s + (h.marketValue != null ? Number(h.marketValue) : 0), 0)
);
const totalHoldingProfit = computed(() =>
  holdings.value.reduce((s, h) => s + (h.holdingProfit != null ? Number(h.holdingProfit) : 0), 0)
);
const totalTodayProfit = computed(() =>
  holdings.value.reduce((s, h) => s + (h.todayProfit != null ? Number(h.todayProfit) : 0), 0)
);

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
    totalCost,
    totalMarket,
    totalHoldingProfit,
    totalTodayProfit,
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
