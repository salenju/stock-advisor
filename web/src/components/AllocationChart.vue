<script setup>
// 组合分布饼图：按市场 / 类型 / 单品种看市值结构（统一折算人民币）
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import * as echarts from 'echarts/core';
import { PieChart } from 'echarts/charts';
import { TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

// 图例不用 echarts 自带的：用小号 canvas 渲染的图例读屏不可见，
// 这里改用下方 HTML 列表（可选中、可读、能跟饼图共用同一套颜色）。
echarts.use([PieChart, TooltipComponent, CanvasRenderer]);

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

/** 饼图与列表共用同一套颜色 */
function colorOf(i) {
  return PALETTE[i % PALETTE.length];
}

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

// canvas 图表对读屏不可见：给一段等价的文字摘要
const chartSummary = computed(() => {
  if (!slices.value.length) return '组合分布：暂无在仓市值可展示';
  const parts = slices.value.map((s) => `${s.name} ${s.pct.toFixed(1)}%（¥${fmtMoney(s.value)}）`);
  return `组合分布饼图，按市值折合人民币共 ¥${fmtMoney(totalCNY.value)}：${parts.join('，')}`;
});

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
      series: [
        {
          type: 'pie',
          radius: ['46%', '70%'],
          center: ['50%', '50%'],
          avoidLabelOverlap: true,
          itemStyle: { borderColor: dark ? '#1f2937' : '#fff', borderWidth: 2 },
          label: { show: false },
          emphasis: { scale: false, label: { show: true, fontSize: 12, color: textColor, formatter: '{b}\n{d}%' } },
          data: slices.value.map((s, i) => ({ name: s.name, value: s.value, itemStyle: { color: colorOf(i) } })),
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
        <div class="text-xs text-muted">按市值（折合人民币 ¥{{ fmtMoney(totalCNY) }}）</div>
      </div>
      <div class="flex flex-wrap items-center gap-1.5">
        <button
          v-for="m in MODES" :key="m.value"
          @click="mode = m.value"
          class="chip px-3 py-1 text-xs font-medium"
          :class="mode === m.value
            ? 'bg-primary text-white shadow-sm'
            : 'border border-base-300 bg-base-100 text-base-content/70 hover:bg-base-200'"
        >{{ m.label }}</button>
      </div>
    </div>
    <!-- 桌面：饼图 + 右侧明细两栏；手机：上下排列 -->
    <div class="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_17rem] lg:items-center">
      <div class="relative">
        <div
          ref="chartEl"
          class="h-48 w-full sm:h-56 lg:h-60"
          :class="{ 'opacity-0': !hasData }"
          role="img"
          :aria-label="chartSummary"
        ></div>
        <div v-if="!hasData" class="absolute inset-0 flex items-center justify-center text-xs text-muted">
          暂无在仓市值可展示
        </div>
      </div>

      <ul v-if="hasData" class="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs lg:max-h-56 lg:grid-cols-1 lg:overflow-y-auto lg:pr-1">
        <li v-for="(s, i) in slices" :key="s.name" class="flex min-w-0 items-center gap-1.5">
          <span class="h-2 w-2 shrink-0 rounded-full" :style="{ backgroundColor: colorOf(i) }"></span>
          <span class="truncate text-muted">{{ s.name }}</span>
          <span class="ml-auto shrink-0 tabular-nums">{{ s.pct.toFixed(1) }}%</span>
        </li>
      </ul>
    </div>
  </div>
</template>
