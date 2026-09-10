<script setup>
// 组合分布饼图：按市场 / 类型 / 单品种看市值结构（统一折算人民币）
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import * as echarts from 'echarts/core';
import { PieChart } from 'echarts/charts';
import { TooltipComponent, LegendComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([PieChart, TooltipComponent, LegendComponent, CanvasRenderer]);

const props = defineProps({
  holdings: { type: Array, default: () => [] },
  isDark: { type: Boolean, default: false },
  fxRates: { type: Object, default: () => ({ CNY: 1 }) },
});

const MODES = [
  { value: 'region', label: '按市场' },
  { value: 'type', label: '按类型' },
  { value: 'name', label: '按品种' },
];
const mode = ref('region');

const REGION_LABEL = { hk: '港股', us: '美股', sh: 'A股-沪', sz: 'A股-深' };
const REGION_ALIAS = { 港股: 'hk', 美股: 'us', 沪: 'sh', 深: 'sz', A股: 'sh' };
const PALETTE = ['#3b82f6', '#ef4444', '#f59e0b', '#10b981', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#64748b'];

function toCNY(v, currency) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const r = Number(props.fxRates?.[currency]);
  return n * (r > 0 ? r : 1);
}

// 在仓持仓的市值（人民币）
const rows = computed(() =>
  props.holdings
    .filter((h) => h.status === '持有' || !h.status)
    .map((h) => ({ h, cny: toCNY(h.marketValue, h.currency) }))
    .filter((x) => x.cny > 0)
);

const slices = computed(() => {
  const by = new Map();
  for (const { h, cny } of rows.value) {
    let key;
    if (mode.value === 'region') {
      const r = REGION_ALIAS[h.region] || h.region || '其他';
      key = REGION_LABEL[r] || r;
    } else if (mode.value === 'type') {
      key = h.type || '未分类';
    } else {
      key = h.name || h.code;
    }
    by.set(key, (by.get(key) || 0) + cny);
  }
  const total = [...by.values()].reduce((s, v) => s + v, 0);
  return [...by.entries()]
    .map(([name, value]) => ({ name, value: +value.toFixed(2), pct: total > 0 ? (value / total) * 100 : 0 }))
    .sort((a, b) => b.value - a.value);
});

const totalCNY = computed(() => slices.value.reduce((s, x) => s + x.value, 0));
const hasData = computed(() => slices.value.length > 0);

const chartEl = ref(null);
let chart = null;

const fmtMoney = (v) =>
  (Number(v) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function render() {
  if (!chart) return;
  const dark = props.isDark;
  const textColor = dark ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.7)';
  chart.setOption(
    {
      backgroundColor: 'transparent',
      color: PALETTE,
      tooltip: {
        trigger: 'item',
        formatter: (p) => `${p.name}<br/>¥${fmtMoney(p.value)}（${p.percent}%）`,
      },
      legend: {
        type: 'scroll',
        orient: 'vertical',
        right: 0,
        top: 'middle',
        textStyle: { color: textColor, fontSize: 11 },
        itemWidth: 10,
        itemHeight: 10,
      },
      series: [
        {
          type: 'pie',
          radius: ['42%', '68%'],
          center: ['34%', '50%'],
          avoidLabelOverlap: true,
          itemStyle: { borderColor: dark ? '#1f2937' : '#fff', borderWidth: 2 },
          label: { show: false },
          emphasis: { label: { show: true, fontSize: 12, color: textColor, formatter: '{b}\n{d}%' } },
          data: slices.value.map((s) => ({ name: s.name, value: s.value })),
        },
      ],
    },
    true
  );
}

function onResize() {
  chart?.resize();
}

watch(slices, () => nextTick(render));
watch(() => props.isDark, () => render());

onMounted(() => {
  chart = echarts.init(chartEl.value);
  window.addEventListener('resize', onResize);
  render();
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
  chart?.dispose();
  chart = null;
});
</script>

<template>
  <div class="mb-4 rounded-xl border border-base-300 bg-base-100 p-3 sm:mb-6 sm:p-4">
    <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
      <div>
        <div class="text-sm font-semibold">组合分布</div>
        <div class="text-xs opacity-50">按市值（折合人民币 ¥{{ fmtMoney(totalCNY) }}）</div>
      </div>
      <div class="flex flex-wrap items-center gap-1.5">
        <button
          v-for="m in MODES" :key="m.value"
          @click="mode = m.value"
          class="rounded-full px-3 py-1 text-xs font-medium transition"
          :class="mode === m.value
            ? 'bg-sky-600 text-white shadow-sm'
            : 'border border-base-300 bg-base-100 text-base-content/70 hover:bg-base-200'"
        >{{ m.label }}</button>
      </div>
    </div>
    <div class="relative">
      <div ref="chartEl" class="h-64 w-full" :class="{ 'opacity-0': !hasData }"></div>
      <div v-if="!hasData" class="absolute inset-0 flex items-center justify-center text-xs opacity-50">
        暂无在仓市值可展示
      </div>
    </div>
  </div>
</template>
