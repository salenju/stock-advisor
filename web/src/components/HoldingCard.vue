<script setup>
import { ref, computed, nextTick } from 'vue';
import {
  fmtMoney, fmtPrice, fmtQty, fmtPct, fmt, profitCls,
  regionBadge, strategyBadge, triggerBadge,
} from '../composables/useFormat.js';
import { useHoldings } from '../composables/useHoldings.js';
import { COST_METHODS } from '../constants/options.js';
import PurchaseTable from './PurchaseTable.vue';

const props = defineProps({
  holding: { type: Object, required: true },
});

const emit = defineEmits(['open-txn', 'open-add-buy', 'edit-buy', 'delete-buy', 'delete-txn']);

const { updateHolding, recomputeHolding } = useHoldings();

const expanded = ref(false);
function toggleExpand() {
  expanded.value = !expanded.value;
}

const costMethodLabel = computed(() => {
  const m = COST_METHODS.find((x) => x.value === props.holding.costMethod);
  return m ? m.short : props.holding.costMethod || 'LIFO';
});

// ---------- 日涨跌告警 + 移动止盈 行内编辑 ----------
const editingAlert = ref(false);
const editDrop = ref('');
const editRise = ref('');
const editTrailing = ref('');
const editCostMethod = ref('LIFO');
const alertMsg = ref('');
const dropInput = ref(null);

function startEditAlert() {
  editDrop.value = props.holding.dailyDropAlertPct != null ? String(props.holding.dailyDropAlertPct) : '';
  editRise.value = props.holding.dailyRiseAlertPct != null ? String(props.holding.dailyRiseAlertPct) : '';
  editTrailing.value = props.holding.trailingStopPct != null ? String(props.holding.trailingStopPct) : '';
  editCostMethod.value = props.holding.costMethod || 'LIFO';
  alertMsg.value = '';
  editingAlert.value = true;
  nextTick(() => dropInput.value?.focus());
}

function cancelAlert() {
  editingAlert.value = false;
  alertMsg.value = '';
}

async function saveAlert() {
  const body = {};
  body.dailyDropAlertPct = editDrop.value !== '' ? Number(editDrop.value) : null;
  body.dailyRiseAlertPct = editRise.value !== '' ? Number(editRise.value) : null;
  body.trailingStopPct = editTrailing.value !== '' ? Number(editTrailing.value) : null;
  body.costMethod = editCostMethod.value;
  try {
    await updateHolding(props.holding.id, body);
    editingAlert.value = false;
    alertMsg.value = '';
  } catch (e) {
    alertMsg.value = e.message;
  }
}

async function onClickRecompute() {
  await recomputeHolding(props.holding.id, props.holding.name);
}
</script>

<template>
  <div class="overflow-hidden rounded-xl border border-base-300 bg-base-100">
    <!-- 卡片头：汇总信息 -->
    <div class="flex flex-wrap items-center justify-between gap-3 px-3 py-3 sm:p-4">
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
            <span class="badge badge-s badge-neutral" :title="`成本核算方法：${costMethodLabel}`">{{ costMethodLabel }}</span>
            <span v-if="holding.inconsistentSell" class="badge badge-s badge-error" title="卖出记录与买入明细无法完全匹配（可能手工改过文件），建议核对">明细异常</span>
          </div>
          <div class="mt-1 font-mono text-xs opacity-60">{{ holding.code }}</div>
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <button @click="emit('open-add-buy')" class="btn btn-success btn-xs">+ 买入记录</button>
        <button @click="emit('open-txn', 'SELL')" class="btn btn-error btn-xs">+ 卖出记录</button>
        <button @click="emit('open-txn', 'DIVIDEND')" class="btn btn-warning btn-xs">+ 分红</button>
        <button @click="emit('open-txn', 'SPLIT')" class="btn btn-info btn-xs">+ 送转</button>
      </div>
    </div>

    <!-- 汇总指标：极窄屏(<360px)单列，常规手机双列，桌面自适应 -->
    <div class="grid grid-cols-1 gap-x-3 gap-y-3 border-t border-base-300 px-3 py-3 min-[360px]:grid-cols-2 sm:grid-cols-4 sm:gap-x-4 sm:px-4 sm:py-4 lg:grid-cols-7">
      <div class="min-w-0">
        <div class="text-xs opacity-60">市值 / 数量</div>
        <div class="mt-0.5 truncate text-xs tabular-nums sm:text-sm">{{ holding.currencyCode }} {{ fmtMoney(holding.marketValue) }} <span class="opacity-40">/</span> {{ fmtQty(holding.buyQuantity) }}</div>
      </div>
      <div class="min-w-0">
        <div class="text-xs opacity-60">成本 / 现价</div>
        <div class="mt-0.5 truncate text-xs tabular-nums sm:text-sm">{{ holding.currencyCode }} {{ fmtPrice(holding.avgCost) }} <span class="opacity-40">/</span> {{ fmtPrice(holding.currentPrice) }}</div>
      </div>
      <div class="min-w-0">
        <div class="text-xs opacity-60">今日收益 / 收益率</div>
        <div class="mt-0.5 truncate text-xs tabular-nums font-medium sm:text-sm" :class="profitCls(holding.todayProfit)">
          {{ holding.currencyCode }} {{ fmtMoney(holding.todayProfit) }} <span class="opacity-40">/</span> {{ fmtPct(holding.todayReturnRate) }}
        </div>
      </div>
      <div class="min-w-0">
        <div class="text-xs opacity-60">持仓收益 / 收益率</div>
        <div class="mt-0.5 truncate text-xs tabular-nums font-medium sm:text-sm" :class="profitCls(holding.holdingProfit)">
          {{ holding.currencyCode }} {{ fmtMoney(holding.holdingProfit) }} <span class="opacity-40">/</span> {{ fmtPct(holding.holdingReturnRate) }}
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
          {{ holding.currencyCode }} {{ fmtPrice(holding.refillPrice) }}
        </div>
      </div>
      <div>
        <div class="text-xs opacity-60">
          告警设置
          <button v-if="!editingAlert" @click="startEditAlert" class="ml-1 align-middle text-primary hover:text-primary/70" title="设置日涨跌告警 / 移动止盈 / 成本法">✎</button>
        </div>
        <div v-if="editingAlert" class="mt-0.5 flex flex-wrap items-center gap-1">
          <input ref="dropInput" v-model="editDrop" type="number" step="0.1" class="input input-bordered input-xs w-14 tabular-nums" placeholder="跌%" @keyup.enter="saveAlert" @keyup.escape="cancelAlert" />
          <span class="opacity-40">/</span>
          <input v-model="editRise" type="number" step="0.1" class="input input-bordered input-xs w-14 tabular-nums" placeholder="涨%" @keyup.enter="saveAlert" @keyup.escape="cancelAlert" />
          <input v-model="editTrailing" type="number" step="0.1" class="input input-bordered input-xs w-16 tabular-nums" placeholder="回撤%" title="移动止盈：从持仓期最高收益率回撤该幅度即提醒" @keyup.enter="saveAlert" @keyup.escape="cancelAlert" />
          <select v-model="editCostMethod" class="select select-bordered select-xs tabular-nums">
            <option v-for="m in COST_METHODS" :key="m.value" :value="m.value">{{ m.short }}</option>
          </select>
          <button @click="saveAlert" class="text-success hover:text-success/70 font-bold text-sm leading-none" title="保存">✓</button>
          <button @click="cancelAlert" class="text-error hover:text-error/70 font-bold text-sm leading-none" title="取消">✕</button>
          <span v-if="alertMsg" class="text-xs text-error">{{ alertMsg }}</span>
        </div>
        <div v-else class="mt-0.5 tabular-nums text-xs">
          <span v-if="holding.dailyDropAlertPct != null || holding.dailyRiseAlertPct != null">
            <span class="text-success">-{{ fmt(holding.dailyDropAlertPct) }}%</span> / <span class="text-error">+{{ fmt(holding.dailyRiseAlertPct) }}%</span>
          </span>
          <span v-else class="opacity-40">日涨跌未设置</span>
          <span class="opacity-40"> · </span>
          <span v-if="Number(holding.trailingStopPct) > 0" :title="`持仓期最高收益率 ${fmt(holding.peakReturnRate)}%`">
            移动止盈 {{ fmt(holding.trailingStopPct) }}%
          </span>
          <span v-else class="opacity-40">移动止盈关</span>
        </div>
      </div>
    </div>

    <!-- 次要指标：已实现收益 / 分红 / 手续费 -->
    <div class="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-base-300 px-3 py-2 text-xs sm:px-4">
      <span class="opacity-70">
        已实现收益：
        <b class="tabular-nums" :class="profitCls(holding.realizedProfit)">{{ holding.currencyCode }} {{ fmtMoney(holding.realizedProfit) }}</b>
      </span>
      <span class="opacity-70">累计分红：<b class="tabular-nums">{{ holding.currencyCode }} {{ fmtMoney(holding.dividendTotal) }}</b></span>
      <span class="opacity-70">手续费合计：<b class="tabular-nums">{{ holding.currencyCode }} {{ fmtMoney(holding.feesTotal) }}</b></span>
      <span v-if="Number(holding.trailingStopPct) > 0" class="opacity-70">
        峰值收益率：<b class="tabular-nums">{{ fmt(holding.peakReturnRate) }}%</b>
      </span>
      <span v-if="holding.costMethod === 'WAC' || holding.costMethod === 'FIFO'" class="opacity-70">
        <button @click="onClickRecompute" class="text-primary hover:underline" title="按当前成本法重算历史卖出成本（会改写历史记录）">按当前成本法重算历史成本</button>
      </span>
    </div>

    <!-- 买入明细（可折叠） -->
    <div v-if="expanded" class="border-t border-base-300">
      <PurchaseTable
        :holding="holding"
        @edit="(p) => emit('edit-buy', p)"
        @delete="(p) => emit('delete-buy', p)"
        @delete-txn="(p) => emit('delete-txn', p)"
      />
    </div>
  </div>
</template>
