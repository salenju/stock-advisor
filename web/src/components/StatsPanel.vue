<script setup>
// 复盘页：收益归因（已清仓战绩 / 胜率 / 年度已实现）+ 每日快照
import { ref, computed, onMounted } from 'vue';
import { useHoldings } from '../composables/useHoldings.js';
import { fmtMoney, fmtPct, fmtDate, fmt, profitCls } from '../composables/useFormat.js';

const { stats, statsLoading, snapshots, fetchStats, fetchSnapshots, exportCsv } = useHoldings();

const exportMsg = ref('');
const exporting = ref('');

async function doExport(scope, label) {
  exporting.value = scope;
  exportMsg.value = '';
  try {
    await exportCsv(scope);
    exportMsg.value = `${label}已导出 ✓`;
  } catch (e) {
    exportMsg.value = e.message;
  } finally {
    exporting.value = '';
    setTimeout(() => (exportMsg.value = ''), 5000);
  }
}

const summary = computed(() => stats.value?.summary || null);
const items = computed(() => stats.value?.items || []);
const closedItems = computed(() => items.value.filter((i) => i.fullyClosed));
const snapshotsDesc = computed(() => [...(snapshots.value || [])].reverse());

const cards = computed(() => {
  const s = summary.value;
  if (!s) return [];
  return [
    { label: '累计已实现收益(CNY)', value: fmtMoney(s.totalRealizedCNY), cls: profitCls(s.totalRealizedCNY) },
    { label: '已清仓笔数', value: String(s.closedCount ?? 0) },
    { label: '胜率', value: s.winRate == null ? '—' : `${fmt(s.winRate)}%`, cls: profitCls(s.winRate != null ? s.winRate - 50 : null) },
    { label: '盈亏比', value: s.profitFactor == null ? '—' : fmt(s.profitFactor), cls: profitCls(s.profitFactor != null ? s.profitFactor - 1 : null) },
    { label: '平均持有天数', value: s.avgHoldDays == null ? '—' : `${s.avgHoldDays} 天` },
    { label: '累计分红(CNY)', value: fmtMoney(s.dividendTotalCNY), cls: profitCls(s.dividendTotalCNY) },
  ];
});

onMounted(() => {
  fetchStats();
  fetchSnapshots('all');
});
</script>

<template>
  <div class="space-y-4">
    <!-- 导出 -->
    <div class="flex flex-wrap items-center gap-2">
      <button @click="doExport('trades', '交易明细')" class="btn btn-sm btn-outline btn-primary" :disabled="exporting === 'trades'">导出交易明细 CSV</button>
      <button @click="doExport('stats', '归因统计')" class="btn btn-sm btn-outline btn-info" :disabled="exporting === 'stats'">导出归因统计 CSV</button>
      <button @click="doExport('snapshots', '每日快照')" class="btn btn-sm btn-outline btn-success" :disabled="exporting === 'snapshots'">导出每日快照 CSV</button>
      <button @click="fetchStats(); fetchSnapshots('all')" class="btn btn-sm btn-ghost" :disabled="statsLoading">↻ 刷新</button>
      <span v-if="exportMsg" class="text-xs text-success">{{ exportMsg }}</span>
    </div>

    <!-- 汇总卡片 -->
    <div v-if="cards.length" class="grid grid-cols-2 gap-3 lg:grid-cols-6">
      <div v-for="c in cards" :key="c.label" class="rounded-xl border border-base-300 bg-base-100 p-3">
        <div class="text-xs opacity-60">{{ c.label }}</div>
        <div class="mt-1 truncate text-lg font-semibold tabular-nums" :class="c.cls">{{ c.value }}</div>
      </div>
    </div>
    <div v-else class="rounded-xl border border-dashed border-base-300 p-10 text-center text-xs opacity-50">
      {{ statsLoading ? '统计加载中…' : '暂无卖出记录，还没有可复盘的战绩' }}
    </div>

    <!-- 年度已实现收益 -->
    <div v-if="stats && stats.byYear && stats.byYear.length" class="rounded-xl border border-base-300 bg-base-100 p-3 sm:p-4">
      <div class="mb-2 text-sm font-semibold">年度已实现收益（含分红，折合人民币）</div>
      <div class="flex flex-wrap gap-6">
        <div v-for="y in stats.byYear" :key="y.year" class="text-xs">
          <span class="opacity-60">{{ y.year }}：</span>
          <b class="tabular-nums" :class="profitCls(y.realizedProfit)">¥{{ fmtMoney(y.realizedProfit) }}</b>
          <span class="opacity-50">（{{ y.tradeCount }} 笔）</span>
        </div>
      </div>
    </div>

    <!-- 最佳 / 最差 -->
    <div v-if="stats && (stats.best?.length || stats.worst?.length)" class="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div class="rounded-xl border border-base-300 bg-base-100 p-3 sm:p-4">
        <div class="mb-2 text-sm font-semibold">表现最好 Top3</div>
        <div v-for="i in stats.best" :key="i.id" class="flex items-baseline justify-between gap-2 py-0.5 text-xs">
          <span class="truncate">{{ i.name }}</span>
          <span class="shrink-0 tabular-nums">
            <b :class="profitCls(i.realizedProfitCNY)">¥{{ fmtMoney(i.realizedProfitCNY) }}</b>
            <span class="opacity-50"> / {{ fmtPct(i.realizedReturnRate) }}</span>
          </span>
        </div>
        <div v-if="!stats.best?.length" class="text-xs opacity-40">暂无</div>
      </div>
      <div class="rounded-xl border border-base-300 bg-base-100 p-3 sm:p-4">
        <div class="mb-2 text-sm font-semibold">表现最差 Top3</div>
        <div v-for="i in stats.worst" :key="i.id" class="flex items-baseline justify-between gap-2 py-0.5 text-xs">
          <span class="truncate">{{ i.name }}</span>
          <span class="shrink-0 tabular-nums">
            <b :class="profitCls(i.realizedProfitCNY)">¥{{ fmtMoney(i.realizedProfitCNY) }}</b>
            <span class="opacity-50"> / {{ fmtPct(i.realizedReturnRate) }}</span>
          </span>
        </div>
        <div v-if="!stats.worst?.length" class="text-xs opacity-40">暂无</div>
      </div>
    </div>

    <!-- 持有周期分布 -->
    <div v-if="stats && stats.byHoldDays && stats.byHoldDays.length" class="rounded-xl border border-base-300 bg-base-100 p-3 sm:p-4">
      <div class="mb-2 text-sm font-semibold">已清仓持有周期分布</div>
      <div class="flex flex-wrap gap-6">
        <div v-for="b in stats.byHoldDays" :key="b.bucket" class="text-xs">
          <span class="opacity-60">{{ b.bucket }}：</span>
          <b class="tabular-nums" :class="profitCls(b.realizedProfitCNY)">¥{{ fmtMoney(b.realizedProfitCNY) }}</b>
          <span class="opacity-50">（{{ b.count }} 笔）</span>
        </div>
      </div>
    </div>

    <!-- 明细表 -->
    <div v-if="items.length" class="rounded-xl border border-base-300 bg-base-100">
      <div class="border-b border-base-300 px-3 py-2 text-sm font-semibold sm:px-4">
        标的收益归因（{{ items.length }} 个，已清仓 {{ closedItems.length }} 个）
      </div>
      <div class="overflow-x-auto">
        <table class="table table-sm w-full text-xs">
          <thead>
            <tr class="opacity-60">
              <th>名称</th>
              <th class="text-center">状态</th>
              <th class="text-center">成本法</th>
              <th class="text-right">买入成本(CNY)</th>
              <th class="text-right">卖出金额(CNY)</th>
              <th class="text-right">分红</th>
              <th class="text-right">已实现(CNY)</th>
              <th class="text-right">收益率</th>
              <th class="text-right">持有天数</th>
              <th class="text-center">首次买入</th>
              <th class="text-center">最后卖出</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="i in items" :key="i.id">
              <td class="max-w-[10rem] truncate">{{ i.name }}<span class="ml-1 opacity-40">{{ i.code }}</span></td>
              <td class="text-center">
                <span class="badge badge-s badge-outline">{{ i.fullyClosed ? '已清仓' : '部分卖出' }}</span>
              </td>
              <td class="text-center opacity-70">{{ i.costMethod }}</td>
              <td class="text-right tabular-nums">{{ fmtMoney(i.buyCostCNY) }}</td>
              <td class="text-right tabular-nums">{{ fmtMoney(i.sellAmountCNY) }}</td>
              <td class="text-right tabular-nums">{{ fmtMoney(i.dividend) }}</td>
              <td class="text-right tabular-nums font-medium" :class="profitCls(i.realizedProfitCNY)">{{ fmtMoney(i.realizedProfitCNY) }}</td>
              <td class="text-right tabular-nums" :class="profitCls(i.realizedReturnRate)">{{ fmtPct(i.realizedReturnRate) }}</td>
              <td class="text-right tabular-nums">{{ i.holdDays ?? '—' }}</td>
              <td class="text-center opacity-70">{{ fmtDate(i.firstBuy) }}</td>
              <td class="text-center opacity-70">{{ fmtDate(i.lastSell) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 每日快照 -->
    <div class="rounded-xl border border-base-300 bg-base-100">
      <div class="border-b border-base-300 px-3 py-2 text-sm font-semibold sm:px-4">
        每日快照（{{ snapshots.length }} 天）
      </div>
      <div v-if="!snapshots.length" class="px-4 py-6 text-center text-xs opacity-50">
        还没有快照记录。调度器会在每个交易日 16:10 后自动记录一份（可在 config.json 的 schedule.snapshotAt 调整）。
      </div>
      <div v-else class="max-h-80 overflow-auto">
        <table class="table table-sm w-full text-xs">
          <thead class="sticky top-0 bg-base-100">
            <tr class="opacity-60">
              <th>日期</th>
              <th class="text-right">在仓</th>
              <th class="text-right">总成本(CNY)</th>
              <th class="text-right">总市值(CNY)</th>
              <th class="text-right">持仓收益</th>
              <th class="text-right">今日收益</th>
              <th class="text-right">累计已实现</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in snapshotsDesc" :key="s.date">
              <td>{{ s.date }}</td>
              <td class="text-right tabular-nums">{{ s.activeCount }}</td>
              <td class="text-right tabular-nums">{{ fmtMoney(s.cost) }}</td>
              <td class="text-right tabular-nums">{{ fmtMoney(s.marketValue) }}</td>
              <td class="text-right tabular-nums" :class="profitCls(s.holdingProfit)">{{ fmtMoney(s.holdingProfit) }}</td>
              <td class="text-right tabular-nums" :class="profitCls(s.todayProfit)">{{ fmtMoney(s.todayProfit) }}</td>
              <td class="text-right tabular-nums" :class="profitCls(s.realizedProfit)">{{ fmtMoney(s.realizedProfit) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
