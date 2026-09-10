<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { REFRESH_MS, REGION_LABEL } from './constants/options.js';
import { useTheme } from './composables/useTheme.js';
import { useHoldings, apiFetch, getAuthToken, setAuthToken } from './composables/useHoldings.js';

import AppHeader from './components/AppHeader.vue';
import OverviewCards from './components/OverviewCards.vue';
import AllocationChart from './components/AllocationChart.vue';
import TrendPanel from './components/TrendPanel.vue';
import HoldingList from './components/HoldingList.vue';
import StatsPanel from './components/StatsPanel.vue';
import AddHoldingModal from './components/AddHoldingModal.vue';
import TransactionModal from './components/TransactionModal.vue';
import BuyRecordModal from './components/BuyRecordModal.vue';
import ImportCsvModal from './components/ImportCsvModal.vue';

const { isDark, initTheme, toggleTheme } = useTheme();
const {
  holdings, lastUpdated, loading, error, countdown,
  fxRates, fxInfo,
  totalCost, totalMarket, totalHoldingProfit, totalTodayProfit, totalRealizedProfit,
  costByCurrency, marketByCurrency, todayProfitByCurrency, holdingProfitByCurrency, realizedProfitByCurrency,
  fetchHoldings, refreshNow, startAutoRefresh, stopAutoRefresh, deletePurchase, deleteTransaction,
} = useHoldings();

// ---------- 页签 ----------
const tab = ref('holdings');

// ---------- 接口鉴权（仅在收到 401 提示时出现）----------
const tokenInput = ref(getAuthToken());
const needToken = computed(() => /未授权/.test(error.value));
function saveToken() {
  setAuthToken(tokenInput.value);
  refreshNow();
}

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
    const res = await apiFetch('/api/test-feishu', { method: 'POST' });
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
const showImport = ref(false);
const txn = ref({ id: '', name: '', type: 'BUY', price: '', quantity: '', date: '' });
const buyForm = ref({ id: '', name: '', pid: '', buyPrice: '', buyQuantity: '', buyTime: '', targetProfitRate: '', stopLossRate: '', fee: '' });

function openTxn(h, type) {
  txn.value = { id: h.id, name: h.name, type, price: '', quantity: '', date: '' };
  showTxn.value = true;
}
function openAddBuy(h) {
  buyForm.value = { id: h.id, name: h.name, pid: '', buyPrice: '', buyQuantity: '', buyTime: '', targetProfitRate: '', stopLossRate: '', fee: '' };
  showBuy.value = true;
}
function openEditBuy(h, p) {
  buyForm.value = {
    id: h.id, name: h.name, pid: p.id,
    buyPrice: p.buyPrice, buyQuantity: p.buyQuantity, buyTime: p.buyTime,
    targetProfitRate: p.targetProfitRate, stopLossRate: p.stopLossRate, fee: p.fee || '',
  };
  showBuy.value = true;
}
async function handleDeleteBuy(h, p) {
  await deletePurchase(h, p);
}
async function handleDeleteTxn(h, p) {
  await deleteTransaction(h.id, p);
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

// 汇率来源提示文案
const fxNote = computed(() => {
  const src = { env: '环境变量', live: '自动更新', config: 'config.json', default: '内置默认值' }[fxInfo.value.source] || fxInfo.value.source;
  if (!src) return '';
  const day = fxInfo.value.updatedAt ? String(fxInfo.value.updatedAt).slice(0, 10) : '';
  return `汇率来源：${src}${day ? `（${day}）` : ''}`;
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
      @import-csv="showImport = true"
    />

    <main class="mx-auto max-w-7xl px-3 py-4 sm:px-6 sm:py-6">
      <!-- 鉴权提示（仅 401 时出现） -->
      <div v-if="needToken" class="mb-4 rounded-xl border border-warning/50 bg-warning/10 p-3 text-xs">
        <div class="mb-2 opacity-80">该服务已启用接口鉴权，请填入 config.json 中设置的 <code>auth.token</code>：</div>
        <div class="flex flex-wrap items-center gap-2">
          <input v-model="tokenInput" type="password" class="input input-bordered input-xs w-56" placeholder="auth.token" @keyup.enter="saveToken" />
          <button @click="saveToken" class="btn btn-xs btn-primary">保存并刷新</button>
        </div>
      </div>

      <!-- 页签 -->
      <div class="mb-4 flex items-center gap-1.5">
        <button
          @click="tab = 'holdings'"
          class="rounded-full px-3.5 py-1.5 text-sm font-medium transition"
          :class="tab === 'holdings' ? 'bg-sky-600 text-white shadow-sm' : 'border border-base-300 bg-base-100 text-base-content/70 hover:bg-base-200'"
        >持仓总览</button>
        <button
          @click="tab = 'stats'"
          class="rounded-full px-3.5 py-1.5 text-sm font-medium transition"
          :class="tab === 'stats' ? 'bg-sky-600 text-white shadow-sm' : 'border border-base-300 bg-base-100 text-base-content/70 hover:bg-base-200'"
        >复盘统计</button>
        <span v-if="fxNote" class="ml-auto hidden text-xs opacity-50 sm:inline">{{ fxNote }}</span>
      </div>

      <template v-if="tab === 'holdings'">
        <OverviewCards
          :count="filteredHoldings.length"
          :total-cost="totalCost"
          :total-market="totalMarket"
          :total-today-profit="totalTodayProfit"
          :total-holding-profit="totalHoldingProfit"
          :total-realized-profit="totalRealizedProfit"
          :cost-by-currency="costByCurrency"
          :market-by-currency="marketByCurrency"
          :today-profit-by-currency="todayProfitByCurrency"
          :holding-profit-by-currency="holdingProfitByCurrency"
          :realized-profit-by-currency="realizedProfitByCurrency"
          :fx-rates="fxRates"
        />

        <AllocationChart :holdings="filteredHoldings" :is-dark="isDark" :fx-rates="fxRates" />

        <TrendPanel :is-dark="isDark" />

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
          :fx-rates="fxRates"
          @open-txn="openTxn"
          @open-add-buy="openAddBuy"
          @edit-buy="openEditBuy"
          @delete-buy="handleDeleteBuy"
          @delete-txn="handleDeleteTxn"
        />

        <p class="mt-4 text-xs opacity-50">
          每 {{ REFRESH_MS / 1000 }} 秒自动刷新（顶部倒计时）持仓与实时行情，点「刷新」可立即更新。
          收益为正显示红色、为负显示绿色（A股习惯）。
        </p>
      </template>

      <StatsPanel v-else />
    </main>

    <AddHoldingModal :show="showAdd" @close="showAdd = false" />
    <TransactionModal :show="showTxn" :txn="txn" @close="showTxn = false" />
    <BuyRecordModal :show="showBuy" :buy-form="buyForm" @close="showBuy = false" />
    <ImportCsvModal :show="showImport" @close="showImport = false" />
  </div>
</template>
