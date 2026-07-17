<script setup>
import { fmtMoney, profitCls } from '../composables/useFormat.js';

defineProps({
  count: { type: Number, default: 0 },
  totalCost: { type: Number, default: 0 },
  totalMarket: { type: Number, default: 0 },
  totalTodayProfit: { type: Number, default: 0 },
  totalHoldingProfit: { type: Number, default: 0 },
});
</script>

<template>
  <div class="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
    <div class="rounded-xl border border-base-300 bg-base-100 p-4">
      <div class="text-xs opacity-60">持仓数</div>
      <div class="mt-1 text-2xl font-semibold">{{ count }}</div>
    </div>
    <div class="rounded-xl border border-base-300 bg-base-100 p-4">
      <div class="text-xs opacity-60">总成本</div>
      <div class="mt-1 text-2xl font-semibold">{{ fmtMoney(totalCost) }}</div>
    </div>
    <div class="rounded-xl border border-base-300 bg-base-100 p-4">
      <div class="text-xs opacity-60">总市值</div>
      <div class="mt-1 text-2xl font-semibold">{{ fmtMoney(totalMarket) }}</div>
    </div>
    <div class="rounded-xl border border-base-300 bg-base-100 p-4">
      <div class="text-xs opacity-60">今日收益</div>
      <div class="mt-1 text-2xl font-semibold tabular-nums" :class="profitCls(totalTodayProfit)">
        {{ fmtMoney(totalTodayProfit) }}
      </div>
    </div>
    <div class="rounded-xl border border-base-300 bg-base-100 p-4">
      <div class="text-xs opacity-60">持仓收益</div>
      <div class="mt-1 text-2xl font-semibold tabular-nums" :class="profitCls(totalHoldingProfit)">
        {{ fmtMoney(totalHoldingProfit) }}
      </div>
    </div>
  </div>
</template>
