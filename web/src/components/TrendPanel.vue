<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { dataSource } from '../services/dataSource.js';

echarts.use([LineChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

const props = defineProps({
  isDark: { type: Boolean, default: false },
});

// ---------- 区间过滤 ----------
const RANGES = [
  { value: 'day', label: '今天' },
  { value: '7d', label: '近7天' },
  { value: '30d', label: '近30天' },
  { value: 'all', label: '全部' },
];
const range = ref('30d');
const loading = ref(false);
const error = ref('');
const unsupported = ref(''); // 本地数据模式下暂未迁移的能力说明
const data = ref(null);

const chartEl = ref(null);
let chart = null;

// 是否有可渲染的数据点
const hasData = computed(() => !!(data.value && data.value.dates && data.value.dates.length));

const fmtMoney = (v) =>
  (Number(v) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// 区间小结
const summary = computed(() => {
  if (!data.value || !data.value.dates.length) return null;
  const hp = data.value.holdingProfit;
  const start = Number(hp[0]) || 0;
  const end = Number(hp[hp.length - 1]) || 0;
  const todaySum = (data.value.todayProfit || []).reduce((s, v) => s + (Number(v) || 0), 0);
  return { start, end, delta: end - start, todaySum };
});

async function load() {
  loading.value = true;
  error.value = '';
  unsupported.value = '';
  try {
    data.value = await dataSource().trend(range.value);
  } catch (e) {
    // 本地数据模式尚未迁移「历史 K 线重放」，给出明确说明而不是报错
    if (e.unsupported) unsupported.value = e.message;
    else error.value = e.message;
  } finally {
    loading.value = false;
  }
}

function render() {
  if (!chart || !data.value || !data.value.dates.length) return;
  const d = data.value;
  const dark = props.isDark;
  const textColor = dark ? 'rgba(255,255,255,0.75)' : 'rgba(0,0,0,0.65)';
  const axisColor = dark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.25)';
  const splitColor = dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';

  chart.setOption(
    {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        valueFormatter: (v) => '¥' + fmtMoney(v),
      },
      legend: {
        data: ['持仓收益', '今日收益'],
        top: 0,
        textStyle: { color: textColor },
        itemWidth: 14,
        itemHeight: 8,
      },
      grid: { left: 8, right: 16, top: 36, bottom: 8, containLabel: true },
      xAxis: {
        type: 'category',
        data: d.dates,
        boundaryGap: false,
        axisLine: { lineStyle: { color: axisColor } },
        axisLabel: { color: textColor, fontSize: 10 },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: textColor, fontSize: 10, formatter: (v) => (Number(v) / 10000).toFixed(1) + '万' },
        splitLine: { lineStyle: { color: splitColor } },
      },
      series: [
        {
          name: '持仓收益',
          type: 'line',
          data: d.holdingProfit,
          smooth: true,
          symbol: 'none',
          lineStyle: { width: 2, color: '#ef4444' },
          areaStyle: { opacity: 0.08, color: '#ef4444' },
          itemStyle: { color: '#ef4444' },
        },
        {
          name: '今日收益',
          type: 'line',
          data: d.todayProfit,
          smooth: true,
          symbol: 'none',
          lineStyle: { width: 1.5, type: 'dashed', color: '#3b82f6' },
          itemStyle: { color: '#3b82f6' },
        },
      ],
    },
    true
  );
}

function onResize() {
  chart?.resize();
}

watch(range, () => load().then(render));
watch(() => props.isDark, () => render());
watch(data, () => nextTick(render));

onMounted(() => {
  chart = echarts.init(chartEl.value);
  window.addEventListener('resize', onResize);
  load();
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
  chart?.dispose();
  chart = null;
});
</script>

<template>
  <div class="mb-4 rounded-xl border border-base-300 bg-base-100 p-3 sm:mb-6 sm:p-4">
    <!-- 头部：标题 + 区间过滤 -->
    <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
      <div>
        <div class="text-sm font-semibold">收益趋势分析</div>
        <div class="text-xs opacity-50">折合人民币；同一日期优先用当日收盘快照，其余按 K 线重放补齐</div>
      </div>
      <div class="flex flex-wrap items-center gap-1.5">
        <button
          v-for="r in RANGES" :key="r.value"
          @click="range = r.value"
          class="rounded-full px-3 py-1 text-xs font-medium transition"
          :class="range === r.value
            ? 'bg-sky-600 text-white shadow-sm'
            : 'border border-base-300 bg-base-100 text-base-content/70 hover:bg-base-200'"
        >{{ r.label }}</button>
        <button @click="load" class="rounded-full border border-base-300 px-3 py-1 text-xs font-medium opacity-60 hover:opacity-100" title="刷新">↻</button>
      </div>
    </div>

    <!-- 区间小结 -->
    <div v-if="summary" class="mb-3 flex flex-wrap gap-4 text-xs">
      <span class="opacity-70">区间持仓收益：<b class="tabular-nums">¥{{ fmtMoney(summary.start) }} → ¥{{ fmtMoney(summary.end) }}</b>
        <span class="tabular-nums" :class="summary.delta >= 0 ? 'text-error' : 'text-success'">（{{ summary.delta >= 0 ? '+' : '' }}{{ fmtMoney(summary.delta) }}）</span>
      </span>
      <span class="opacity-70">区间今日收益合计：<b class="tabular-nums" :class="summary.todaySum >= 0 ? 'text-error' : 'text-success'">¥{{ fmtMoney(summary.todaySum) }}</b></span>
    </div>

    <div class="relative">
      <!-- 图表容器常驻，确保 echarts.init 拿到稳定 DOM；无数据时用覆盖层提示 -->
      <div ref="chartEl" class="h-80 w-full" :class="{ 'opacity-0': !hasData }"></div>
      <div v-if="loading && !data" class="absolute inset-0 flex items-center justify-center text-xs opacity-50">趋势加载中…</div>
      <div v-else-if="unsupported" class="absolute inset-0 flex items-center justify-center px-6 text-center text-xs opacity-70">
        {{ unsupported }}
      </div>
      <div v-else-if="error" class="absolute inset-0 flex items-center justify-center text-xs text-error">{{ error }}</div>
      <div v-else-if="!hasData" class="absolute inset-0 flex items-center justify-center text-xs opacity-50">暂无趋势数据（历史行情不可用或当前无持仓）</div>
    </div>

    <div v-if="data && data.skipped && data.skipped.length" class="mt-2 border-t border-base-300 pt-2 text-[11px] opacity-50">
      以下标的历史行情暂不可用，未计入趋势：{{ data.skipped.join('、') }}
    </div>
  </div>
</template>
