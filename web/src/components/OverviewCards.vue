<script setup>
import { computed } from 'vue';
import { fmtMoney, fmt, profitCls } from '../composables/useFormat.js';

const props = defineProps({
  count: { type: Number, default: 0 },
  totalCost: { type: Number, default: 0 },        // 人民币合计
  totalMarket: { type: Number, default: 0 },
  totalTodayProfit: { type: Number, default: 0 },
  totalHoldingProfit: { type: Number, default: 0 },
  totalRealizedProfit: { type: Number, default: 0 },
  costByCurrency: { type: Object, default: () => ({}) },       // 分币种小计
  marketByCurrency: { type: Object, default: () => ({}) },
  todayProfitByCurrency: { type: Object, default: () => ({}) },
  holdingProfitByCurrency: { type: Object, default: () => ({}) },
  realizedProfitByCurrency: { type: Object, default: () => ({}) },
  fxRates: { type: Object, default: () => ({ CNY: 1 }) },      // 汇率配置
});

const CURRENCY_LABEL = { CNY: '人民币', HKD: '港币', USD: '美元' };
const CURRENCY_CODE = { CNY: 'CNY', HKD: 'HKD', USD: 'USD' };

// 生成分币种小结行：[{ c, label, text }]
function bdLines(bd) {
  return Object.entries(bd || {})
    .filter(([, v]) => v != null && Number.isFinite(Number(v)))
    .map(([c, v]) => {
      const rate = Number(props.fxRates[c]);
      const hasRate = rate > 0 && c !== 'CNY';
      return {
        c,
        label: CURRENCY_LABEL[c] || c,
        text: hasRate
          ? `${CURRENCY_CODE[c] || ''} ${fmtMoney(v)} ≈ CNY ${fmtMoney(v * rate)}`
          : `${CURRENCY_CODE[c] || ''} ${fmtMoney(v)}`,
      };
    });
}

// 组装单个指标的 tip 内容：标题 + 小计行 + 汇率脚注
function buildTip(title, bd) {
  const lines = bdLines(bd);
  if (!lines.length) return { title, lines: [{ c: 'empty', label: '', text: '暂无数据' }], rates: '' };
  const hasRate = Number(props.fxRates.USD) > 0 || Number(props.fxRates.HKD) > 0;
  const rates = hasRate
    ? `按配置汇率：USD/CNY=${fmt(props.fxRates.USD, 4)}、HKD/CNY=${fmt(props.fxRates.HKD, 4)}`
    : '';
  return { title, lines, rates };
}

const costTip = computed(() => buildTip('总成本', props.costByCurrency));
const marketTip = computed(() => buildTip('总市值', props.marketByCurrency));
const todayTip = computed(() => buildTip('今日收益', props.todayProfitByCurrency));
const holdingTip = computed(() => buildTip('持仓收益', props.holdingProfitByCurrency));
const realizedTip = computed(() => buildTip('累计已实现收益', props.realizedProfitByCurrency));
</script>

<template>
  <div class="mb-4 grid grid-cols-1 gap-3 min-[400px]:grid-cols-2 sm:mb-6 sm:grid-cols-3 sm:gap-4 lg:grid-cols-6">
    <div class="rounded-xl border border-base-300 bg-base-100 p-3 sm:p-4">
      <div class="text-xs opacity-60">持仓数</div>
      <div class="mt-1 text-xl font-semibold sm:text-2xl">{{ count }}</div>
    </div>

    <div class="relative min-w-0 rounded-xl border border-base-300 bg-base-100 p-3 sm:p-4">
      <div class="text-xs opacity-60">总成本（折合人民币）</div>
      <div class="mt-1 truncate text-xl font-semibold tabular-nums sm:text-2xl" :title="'CNY ' + fmtMoney(totalCost)">{{ fmtMoney(totalCost) }}</div>
      <details class="dropdown dropdown-end absolute right-2 top-2">
        <summary class="cursor-pointer rounded-full px-1 text-sm opacity-40 transition hover:opacity-100" title="按币种查看小计">ⓘ</summary>
        <div class="dropdown-content z-10 mt-1 w-64 max-w-[calc(100vw-2rem)] rounded-lg border border-base-300 bg-base-100 p-3 text-xs shadow-lg">
          <div class="mb-1.5 font-semibold">{{ costTip.title }}</div>
          <div v-for="line in costTip.lines" :key="line.c" class="flex items-baseline justify-between gap-2 py-0.5">
            <span class="shrink-0 opacity-70">{{ line.label }}</span><span class="truncate tabular-nums">{{ line.text }}</span>
          </div>
          <div v-if="costTip.rates" class="mt-1.5 border-t border-base-300 pt-1.5 opacity-60">{{ costTip.rates }}</div>
        </div>
      </details>
    </div>

    <div class="relative min-w-0 rounded-xl border border-base-300 bg-base-100 p-3 sm:p-4">
      <div class="text-xs opacity-60">总市值（折合人民币）</div>
      <div class="mt-1 truncate text-xl font-semibold tabular-nums sm:text-2xl" :title="'CNY ' + fmtMoney(totalMarket)">{{ fmtMoney(totalMarket) }}</div>
      <details class="dropdown dropdown-end absolute right-2 top-2">
        <summary class="cursor-pointer rounded-full px-1 text-sm opacity-40 transition hover:opacity-100" title="按币种查看小计">ⓘ</summary>
        <div class="dropdown-content z-10 mt-1 w-64 max-w-[calc(100vw-2rem)] rounded-lg border border-base-300 bg-base-100 p-3 text-xs shadow-lg">
          <div class="mb-1.5 font-semibold">{{ marketTip.title }}</div>
          <div v-for="line in marketTip.lines" :key="line.c" class="flex items-baseline justify-between gap-2 py-0.5">
            <span class="shrink-0 opacity-70">{{ line.label }}</span><span class="truncate tabular-nums">{{ line.text }}</span>
          </div>
          <div v-if="marketTip.rates" class="mt-1.5 border-t border-base-300 pt-1.5 opacity-60">{{ marketTip.rates }}</div>
        </div>
      </details>
    </div>

    <div class="relative min-w-0 rounded-xl border border-base-300 bg-base-100 p-3 sm:p-4">
      <div class="text-xs opacity-60">今日收益（折合人民币）</div>
      <div class="mt-1 truncate text-xl font-semibold tabular-nums sm:text-2xl" :class="profitCls(totalTodayProfit)" :title="'CNY ' + fmtMoney(totalTodayProfit)">
        {{ fmtMoney(totalTodayProfit) }}
      </div>
      <details class="dropdown dropdown-end absolute right-2 top-2">
        <summary class="cursor-pointer rounded-full px-1 text-sm opacity-40 transition hover:opacity-100" title="按币种查看小计">ⓘ</summary>
        <div class="dropdown-content z-10 mt-1 w-64 max-w-[calc(100vw-2rem)] rounded-lg border border-base-300 bg-base-100 p-3 text-xs shadow-lg">
          <div class="mb-1.5 font-semibold">{{ todayTip.title }}</div>
          <div v-for="line in todayTip.lines" :key="line.c" class="flex items-baseline justify-between gap-2 py-0.5">
            <span class="shrink-0 opacity-70">{{ line.label }}</span><span class="truncate tabular-nums">{{ line.text }}</span>
          </div>
          <div v-if="todayTip.rates" class="mt-1.5 border-t border-base-300 pt-1.5 opacity-60">{{ todayTip.rates }}</div>
        </div>
      </details>
    </div>

    <div class="relative min-w-0 rounded-xl border border-base-300 bg-base-100 p-3 sm:p-4">
      <div class="text-xs opacity-60">持仓收益（折合人民币）</div>
      <div class="mt-1 truncate text-xl font-semibold tabular-nums sm:text-2xl" :class="profitCls(totalHoldingProfit)" :title="'CNY ' + fmtMoney(totalHoldingProfit)">
        {{ fmtMoney(totalHoldingProfit) }}
      </div>
      <details class="dropdown dropdown-end absolute right-2 top-2">
        <summary class="cursor-pointer rounded-full px-1 text-sm opacity-40 transition hover:opacity-100" title="按币种查看小计">ⓘ</summary>
        <div class="dropdown-content z-10 mt-1 w-64 max-w-[calc(100vw-2rem)] rounded-lg border border-base-300 bg-base-100 p-3 text-xs shadow-lg">
          <div class="mb-1.5 font-semibold">{{ holdingTip.title }}</div>
          <div v-for="line in holdingTip.lines" :key="line.c" class="flex items-baseline justify-between gap-2 py-0.5">
            <span class="shrink-0 opacity-70">{{ line.label }}</span><span class="truncate tabular-nums">{{ line.text }}</span>
          </div>
          <div v-if="holdingTip.rates" class="mt-1.5 border-t border-base-300 pt-1.5 opacity-60">{{ holdingTip.rates }}</div>
        </div>
      </details>
    </div>
    <div class="relative min-w-0 rounded-xl border border-base-300 bg-base-100 p-3 sm:p-4">
      <div class="text-xs opacity-60">累计已实现收益（含分红）</div>
      <div class="mt-1 truncate text-xl font-semibold tabular-nums sm:text-2xl" :class="profitCls(totalRealizedProfit)" :title="'CNY ' + fmtMoney(totalRealizedProfit)">
        {{ fmtMoney(totalRealizedProfit) }}
      </div>
      <details class="dropdown dropdown-end absolute right-2 top-2">
        <summary class="cursor-pointer rounded-full px-1 text-sm opacity-40 transition hover:opacity-100" title="按币种查看小计">ⓘ</summary>
        <div class="dropdown-content z-10 mt-1 w-64 max-w-[calc(100vw-2rem)] rounded-lg border border-base-300 bg-base-100 p-3 text-xs shadow-lg">
          <div class="mb-1.5 font-semibold">{{ realizedTip.title }}</div>
          <div v-for="line in realizedTip.lines" :key="line.c" class="flex items-baseline justify-between gap-2 py-0.5">
            <span class="shrink-0 opacity-70">{{ line.label }}</span><span class="truncate tabular-nums">{{ line.text }}</span>
          </div>
          <div v-if="realizedTip.rates" class="mt-1.5 border-t border-base-300 pt-1.5 opacity-60">{{ realizedTip.rates }}</div>
        </div>
      </details>
    </div>
  </div>
</template>
