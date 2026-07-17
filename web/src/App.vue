<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { REFRESH_MS } from './constants/options.js';
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
        :count="holdings.length"
        :total-cost="totalCost"
        :total-market="totalMarket"
        :total-today-profit="totalTodayProfit"
        :total-holding-profit="totalHoldingProfit"
      />

      <HoldingList
        :holdings="holdings"
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
