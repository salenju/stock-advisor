<script setup>
import { ref, nextTick } from 'vue';
import {
  fmtMoney, fmtPrice, fmtQty, fmtPct, fmt, profitCls,
  regionBadge, strategyBadge, triggerBadge,
} from '../composables/useFormat.js';
import { useHoldings } from '../composables/useHoldings.js';
import PurchaseTable from './PurchaseTable.vue';

const props = defineProps({
  holding: { type: Object, required: true },
});

const emit = defineEmits(['open-txn', 'open-add-buy', 'edit-buy', 'delete-buy']);

const { updateHolding } = useHoldings();

const expanded = ref(false);
function toggleExpand() {
  expanded.value = !expanded.value;
}

// ---------- 日涨跌告警行内编辑 ----------
const editingAlert = ref(false);
const editDrop = ref('');
const editRise = ref('');
const alertMsg = ref('');
const dropInput = ref(null);

function startEditAlert() {
  editDrop.value = props.holding.dailyDropAlertPct != null ? String(props.holding.dailyDropAlertPct) : '';
  editRise.value = props.holding.dailyRiseAlertPct != null ? String(props.holding.dailyRiseAlertPct) : '';
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
  try {
    await updateHolding(props.holding.id, body);
    editingAlert.value = false;
    alertMsg.value = '';
  } catch (e) {
    alertMsg.value = e.message;
  }
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
        <!-- <button @click="emit('open-txn', 'BUY')" class="btn btn-success btn-xs">买入</button> -->
        <button @click="emit('open-add-buy')" class="btn btn-success btn-xs">+ 买入记录</button>
        <button @click="emit('open-txn', 'SELL')" class="btn btn-error btn-xs">卖出</button>
      </div>
    </div>

    <!-- 汇总指标 -->
    <div class="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-base-300 px-4 py-4 sm:grid-cols-4 lg:grid-cols-7">
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
      <div>
        <div class="text-xs opacity-60">
          日跌告警 / 日涨告警
          <button v-if="!editingAlert" @click="startEditAlert" class="ml-1 align-middle text-primary hover:text-primary/70" title="设置告警阈值">✎</button>
        </div>
        <div v-if="editingAlert" class="mt-0.5 flex flex-wrap items-center gap-1">
          <input ref="dropInput" v-model="editDrop" type="number" step="0.1" class="input input-bordered input-xs w-14 tabular-nums" placeholder="跌%" @keyup.enter="saveAlert" @keyup.escape="cancelAlert" />
          <span class="opacity-40">/</span>
          <input v-model="editRise" type="number" step="0.1" class="input input-bordered input-xs w-14 tabular-nums" placeholder="涨%" @keyup.enter="saveAlert" @keyup.escape="cancelAlert" />
          <button @click="saveAlert" class="text-success hover:text-success/70 font-bold text-sm leading-none" title="保存">✓</button>
          <button @click="cancelAlert" class="text-error hover:text-error/70 font-bold text-sm leading-none" title="取消">✕</button>
          <span v-if="alertMsg" class="text-xs text-error">{{ alertMsg }}</span>
        </div>
        <div v-else class="mt-0.5 tabular-nums">
          <span v-if="holding.dailyDropAlertPct != null || holding.dailyRiseAlertPct != null">
            <span class="text-success">-{{ fmt(holding.dailyDropAlertPct) }}%</span> / <span class="text-error">+{{ fmt(holding.dailyRiseAlertPct) }}%</span>
          </span>
          <span v-else class="opacity-40">未设置</span>
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
