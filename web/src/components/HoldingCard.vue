<script setup>
import { ref } from 'vue';
import {
  fmtMoney, fmtPrice, fmtQty, fmtPct, fmt, profitCls,
  regionBadge, strategyBadge, triggerBadge,
} from '../composables/useFormat.js';
import PurchaseTable from './PurchaseTable.vue';

const props = defineProps({
  holding: { type: Object, required: true },
});

const emit = defineEmits(['open-txn', 'open-add-buy', 'edit-buy', 'delete-buy']);

const expanded = ref(false);
function toggleExpand() {
  expanded.value = !expanded.value;
}
</script>

<template>
  <div class="overflow-hidden rounded-xl border border-base-300 bg-base-100">
    <!-- 卡片头：汇总信息 -->
    <div class="flex flex-wrap items-center justify-between gap-3 p-4">
      <div class="flex items-center gap-3">
        <button
          @click="toggleExpand"
          class="flex h-7 w-7 items-center justify-center opacity-60 transition hover:opacity-100"
          :title="expanded ? '收起明细' : '展开明细'"
        >
          <svg
            class="h-4 w-4 transition-transform"
            :class="expanded ? 'rotate-90' : ''"
            viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
          ><path d="M7 5l6 5-6 5" /></svg>
        </button>
        <div>
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-semibold">{{ holding.name }}</span>
            <span class="badge badge-s text-white" :class="holding.status === '持有' ? 'badge-success' : 'badge-error'">{{ holding.status }}</span>
            <span class="badge badge-s text-white" :class="regionBadge(holding.region).cls">{{ regionBadge(holding.region).text }}</span>
            <span class="badge badge-s badge-primary text-white">{{ holding.type }}</span>
            <span class="badge badge-s text-white" :class="strategyBadge(holding.strategy).cls">{{ strategyBadge(holding.strategy).text }}</span>
            <span class="badge badge-s text-white" :class="triggerBadge(holding.triggerState).cls">{{ triggerBadge(holding.triggerState).text }}</span>
          </div>
          <div class="mt-1 font-mono text-xs opacity-60">{{ holding.code }}</div>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <button @click="emit('open-add-buy')" class="btn btn-success btn-xs">+ 买入记录</button>
        <button @click="emit('open-txn', 'SELL')" class="btn btn-error btn-xs">+ 卖出记录</button>
      </div>
    </div>

    <!-- 汇总指标 -->
    <div class="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-base-300 px-4 py-4 sm:grid-cols-3 lg:grid-cols-6">
      <div>
        <div class="text-xs opacity-60">市值 / 数量</div>
        <div class="mt-0.5 tabular-nums">{{ fmtMoney(holding.marketValue) }} <span class="opacity-40">/</span> {{ fmtQty(holding.buyQuantity) }}</div>
      </div>
      <div>
        <div class="text-xs opacity-60">成本 / 现价</div>
        <div class="mt-0.5 tabular-nums">{{ fmtPrice(holding.avgCost) }} <span class="opacity-40">/</span> {{ fmtPrice(holding.currentPrice) }}</div>
      </div>
      <div>
        <div class="text-xs opacity-60">今日收益 / 收益率</div>
        <div class="mt-0.5 tabular-nums font-medium" :class="profitCls(holding.todayProfit)">
          {{ fmtMoney(holding.todayProfit) }} <span class="opacity-40">/</span> {{ fmtPct(holding.todayReturnRate) }}
        </div>
      </div>
      <div>
        <div class="text-xs opacity-60">持仓收益 / 收益率</div>
        <div class="mt-0.5 tabular-nums font-medium" :class="profitCls(holding.holdingProfit)">
          {{ fmtMoney(holding.holdingProfit) }} <span class="opacity-40">/</span> {{ fmtPct(holding.holdingReturnRate) }}
        </div>
      </div>
      <div>
        <div class="text-xs opacity-60">止盈% / 止损%</div>
        <div class="mt-0.5 tabular-nums font-medium">
          <span :class="profitCls(holding.targetProfitRate)">+{{ fmt(holding.targetProfitRate) }}%</span>
          <span class="opacity-40"> / </span>
          <span :class="profitCls(-(Number(holding.stopLossRate) || 0))">-{{ fmt(holding.stopLossRate) }}%</span>
        </div>
      </div>
      <div>
        <div class="text-xs opacity-60">补仓% / 补仓价</div>
        <div class="mt-0.5 tabular-nums">
          <span :class="profitCls(1)">-{{ fmt(holding.refillDropRate) }}%</span>
          <span class="opacity-40"> &nbsp;/&nbsp; </span>
          {{ fmtPrice(holding.refillPrice) }}
        </div>
      </div>
    </div>

    <!-- 买入明细（可折叠） -->
    <div v-if="expanded" class="border-t border-base-300">
      <PurchaseTable
        :holding="holding"
        @edit="(p) => emit('edit-buy', p)"
        @delete="(p) => emit('delete-buy', p)"
      />
    </div>
  </div>
</template>
