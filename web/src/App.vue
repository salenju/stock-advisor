<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { REFRESH_MS, REGION_LABEL } from './constants/options.js';
import { useTheme } from './composables/useTheme.js';
import { useHoldings } from './composables/useHoldings.js';

import AppHeader from './components/AppHeader.vue';
import OverviewCards from './components/OverviewCards.vue';
import HoldingList from './components/HoldingList.vue';
import AddHoldingModal from './components/AddHoldingModal.vue';
import TransactionModal from './components/TransactionModal.vue';
import BuyRecordModal from './components/BuyRecordModal.vue';

const { isDark, initTheme, toggleTheme } = useTheme();
const {
  holdings, lastUpdated, loading, error, countdown,
  totalCost, totalMarket, totalHoldingProfit, totalTodayProfit,
  fetchHoldings, refreshNow, startAutoRefresh, stopAutoRefresh, deletePurchase,
} = useHoldings();

// ---------- 倒计时环形 ----------
const RING_C = 2 * Math.PI * 7;
const progress = computed(() => countdown.value / (REFRESH_MS / 1000));
const ringOffset = computed(() => RING_C * (1 - progress.value));

// ---------- 测试飞书推送 ----------
const testing = ref(false);
const testMsg = ref('');
let testMsgTimer = null;
async function testFeishu() {
  testing.value = true;
  testMsg.value = '';
  try {
    const res = await fetch('/api/test-feishu', { method: 'POST' });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || '发送失败');
    testMsg.value = '已发送测试消息到飞书 ✓';
  } catch (e) {
    testMsg.value = e.message;
  } finally {
    testing.value = false;
    clearTimeout(testMsgTimer);
    testMsgTimer = setTimeout(() => (testMsg.value = ''), 6000);
  }
}

// ---------- 弹窗状态 ----------
const showAdd = ref(false);
const showTxn = ref(false);
const showBuy = ref(false);
const txn = ref({ id: '', name: '', type: 'BUY', price: '', quantity: '', date: '' });
const buyForm = ref({ id: '', name: '', pid: '', buyPrice: '', buyQuantity: '', buyTime: '', targetProfitRate: '', stopLossRate: '' });

function openTxn(h, type) {
  txn.value = { id: h.id, name: h.name, type, price: '', quantity: '', date: '' };
  showTxn.value = true;
}
function openAddBuy(h) {
  buyForm.value = { id: h.id, name: h.name, pid: '', buyPrice: '', buyQuantity: '', buyTime: '', targetProfitRate: '', stopLossRate: '' };
  showBuy.value = true;
}
function openEditBuy(h, p) {
  buyForm.value = {
    id: h.id, name: h.name, pid: p.id,
    buyPrice: p.buyPrice, buyQuantity: p.buyQuantity, buyTime: p.buyTime,
    targetProfitRate: p.targetProfitRate, stopLossRate: p.stopLossRate,
  };
  showBuy.value = true;
}
async function handleDeleteBuy(h, p) {
  await deletePurchase(h, p);
}

// ---------- 多选标签过滤 ----------
const FILTER_GROUPS = [
  {
    label: '类型',
    key: 'type',
    options: ['股票', '股票型基金', '债券型基金', '货币型基金', 'ETF'],
  },
  {
    label: '市场',
    key: 'region',
    options: ['hk', 'us', 'sh', 'sz'],
    text: (v) => REGION_LABEL[v] || v,
  },
];
const activeFilters = ref({ type: [], region: [] });
function toggleFilter(groupKey, value) {
  const arr = activeFilters.value[groupKey];
  const idx = arr.indexOf(value);
  if (idx >= 0) arr.splice(idx, 1);
  else arr.push(value);
}
function isFilterActive(groupKey, value) {
  return activeFilters.value[groupKey].includes(value);
}
function clearFilters() {
  activeFilters.value = { type: [], region: [] };
}
const hasActiveFilters = computed(
  () => activeFilters.value.type.length > 0 || activeFilters.value.region.length > 0
);
// 地区中文名 → 短代码映射（数据中两种格式混用）
const REGION_SHORT = { 港股: 'hk', 美股: 'us', 沪: 'sh', 深: 'sz', A股: 'sh' };
function normRegion(r) {
  return REGION_SHORT[r] || r;
}
const filteredHoldings = computed(() => {
  const { type: ft, region: fr } = activeFilters.value;
  if (!ft.length && !fr.length) return holdings.value;
  return holdings.value.filter((h) => {
    if (ft.length && !ft.includes(h.type)) return false;
    if (fr.length && !fr.includes(normRegion(h.region))) return false;
    return true;
  });
});

onMounted(() => {
  initTheme();
  fetchHoldings();
  startAutoRefresh();
});
onUnmounted(() => {
  stopAutoRefresh();
  clearTimeout(testMsgTimer);
});
</script>

<template>
  <div class="min-h-full bg-base-200 text-base-content">
    <AppHeader
      :last-updated="lastUpdated"
      :loading="loading"
      :error="error"
      :countdown="countdown"
      :is-dark="isDark"
      :testing="testing"
      :test-msg="testMsg"
      :ring-c="RING_C"
      :ring-offset="ringOffset"
      @toggle-theme="toggleTheme"
      @refresh="refreshNow"
      @test-feishu="testFeishu"
      @add="showAdd = true"
    />

    <main class="mx-auto max-w-7xl px-6 py-6">
      <OverviewCards
        :count="filteredHoldings.length"
        :total-cost="totalCost"
        :total-market="totalMarket"
        :total-today-profit="totalTodayProfit"
        :total-holding-profit="totalHoldingProfit"
      />

      <!-- 多选标签过滤 -->
      <div class="mb-4 flex flex-wrap items-center gap-2">
        <template v-for="g in FILTER_GROUPS" :key="g.key">
          <span class="text-xs font-medium opacity-60">{{ g.label }}：</span>
          <button
            v-for="opt in g.options" :key="opt"
            @click="toggleFilter(g.key, opt)"
            class="rounded-full px-2.5 py-1 text-xs font-medium transition"
            :class="isFilterActive(g.key, opt)
              ? 'bg-sky-600 text-white shadow-sm'
              : 'border border-base-300 bg-base-100 text-base-content/70 hover:bg-base-200'"
          >{{ g.text ? g.text(opt) : opt }}</button>
        </template>
        <button
          v-if="hasActiveFilters"
          @click="clearFilters"
          class="rounded-full px-2.5 py-1 text-xs font-medium text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20"
        >清除过滤</button>
      </div>

      <HoldingList
        :holdings="filteredHoldings"
        @open-txn="openTxn"
        @open-add-buy="openAddBuy"
        @edit-buy="openEditBuy"
        @delete-buy="handleDeleteBuy"
      />

      <p class="mt-4 text-xs opacity-50">每 {{ REFRESH_MS / 1000 }} 秒自动刷新（顶部倒计时）持仓与实时行情，点「刷新」可立即更新。收益为正显示红色、为负显示绿色（A股习惯）。</p>
    </main>

    <AddHoldingModal :show="showAdd" @close="showAdd = false" />
    <TransactionModal :show="showTxn" :txn="txn" @close="showTxn = false" />
    <BuyRecordModal :show="showBuy" :buy-form="buyForm" @close="showBuy = false" />
  </div>
</template>
