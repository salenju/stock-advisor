<script setup>
import { ref, computed } from 'vue';
import HoldingCard from './HoldingCard.vue';

const props = defineProps({
  holdings: { type: Array, default: () => [] },
  fxRates: { type: Object, default: () => ({ CNY: 1 }) },
});

const emit = defineEmits(['open-txn', 'open-add-buy', 'edit-buy', 'delete-buy', 'delete-txn']);

// 把事件带上对应的持仓对象向上透传
function forward(event, holding, payload) {
  emit(event, holding, payload);
}

// ---------- 排序 ----------
const SORTS = [
  { value: 'default', label: '默认顺序' },
  { value: 'marketValue', label: '市值' },
  { value: 'holdingProfit', label: '持仓收益' },
  { value: 'holdingReturnRate', label: '持仓收益率' },
  { value: 'todayReturnRate', label: '今日涨跌' },
  { value: 'realizedProfit', label: '已实现收益' },
  { value: 'name', label: '名称' },
];
const sortKey = ref('default');
const sortDesc = ref(true);

// 金额类指标按人民币折算后再比较，避免混币种时排序错乱
function sortValue(h) {
  const k = sortKey.value;
  if (k === 'name') return h.name || '';
  if (k === 'marketValue') return toCNY(h.marketValue, h.currency);
  if (k === 'holdingProfit') return toCNY(h.holdingProfit, h.currency);
  if (k === 'realizedProfit') return toCNY(h.realizedProfit, h.currency);
  const v = Number(h[k]);
  return Number.isFinite(v) ? v : null;
}

function toCNY(v, currency) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const r = Number(props.fxRates?.[currency]);
  return n * (r > 0 ? r : 1);
}

const sorted = computed(() => {
  if (sortKey.value === 'default') return props.holdings;
  const arr = [...props.holdings];
  arr.sort((a, b) => {
    const va = sortValue(a);
    const vb = sortValue(b);
    // null 值统一排到末尾
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === 'string') return sortDesc.value ? vb.localeCompare(va) : va.localeCompare(vb);
    return sortDesc.value ? vb - va : va - vb;
  });
  return arr;
});

function resetSort() {
  sortKey.value = 'default';
  sortDesc.value = true;
}
</script>

<template>
  <div>
    <!-- 排序工具条 -->
    <div v-if="holdings.length > 1" class="mb-3 flex flex-wrap items-center gap-2 text-xs">
      <span class="opacity-60">排序：</span>
      <select v-model="sortKey" class="select select-bordered select-xs">
        <option v-for="s in SORTS" :key="s.value" :value="s.value">{{ s.label }}</option>
      </select>
      <button
        v-if="sortKey !== 'default'"
        @click="sortDesc = !sortDesc"
        class="rounded-full border border-base-300 px-2.5 py-1 font-medium opacity-70 hover:opacity-100"
        :title="sortDesc ? '当前：从高到低' : '当前：从低到高'"
      >{{ sortDesc ? '↓ 高→低' : '↑ 低→高' }}</button>
      <button
        v-if="sortKey !== 'default'"
        @click="resetSort"
        class="rounded-full border border-base-300 px-2.5 py-1 opacity-60 hover:opacity-100"
      >清除排序</button>
      <span class="opacity-40">共 {{ holdings.length }} 只</span>
    </div>

    <div class="space-y-4">
      <HoldingCard
        v-for="h in sorted"
        :key="h.id"
        :holding="h"
        @open-txn="(type) => forward('open-txn', h, type)"
        @open-add-buy="forward('open-add-buy', h)"
        @edit-buy="(p) => forward('edit-buy', h, p)"
        @delete-buy="(p) => forward('delete-buy', h, p)"
        @delete-txn="(p) => forward('delete-txn', h, p)"
      />

      <div
        v-if="!holdings.length"
        class="rounded-xl border border-dashed border-base-300 p-10 text-center opacity-40"
      >
        暂无持仓，点击右上角「添加持仓」开始记录
      </div>
    </div>
  </div>
</template>
