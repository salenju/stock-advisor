<script setup>
import {
  fmt, fmtDate, fmtPrice, fmtQty, fmtMoney, fmtPct, profitCls,
} from '../composables/useFormat.js';

const props = defineProps({
  holding: { type: Object, required: true },
});

const emit = defineEmits(['edit', 'delete', 'delete-txn']);

const TYPE_META = {
  BUY: { text: '买入', cls: 'badge-success' },
  SELL: { text: '卖出', cls: 'badge-error' },
  DIVIDEND: { text: '分红', cls: 'badge-warning' },
  SPLIT: { text: '送转', cls: 'badge-info' },
};

function meta(t) {
  return TYPE_META[t] || { text: t, cls: 'badge-info' };
}
</script>

<template>
  <div class="overflow-x-auto">
    <table class="table w-full text-sm">
      <thead>
        <tr class="text-xs uppercase opacity-60">
          <th>日期</th>
          <th class="text-center">类型</th>
          <th class="text-right">价格</th>
          <th class="text-right">数量</th>
          <th class="text-right">手续费</th>
          <th class="text-right">成本</th>
          <th class="text-right">市值/成交额</th>
          <th class="text-right">收益 / 收益率</th>
          <th class="text-center">止盈 %</th>
          <th class="text-center">止损 %</th>
          <th class="text-center">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="p in holding.transactions" :key="p.id">
          <td>{{ fmtDate(p.buyTime) }}</td>
          <td class="text-center">
            <span class="badge badge-s text-white" :class="meta(p.type).cls">{{ meta(p.type).text }}</span>
          </td>
          <td class="text-right tabular-nums">
            <template v-if="p.type === 'SPLIT'">×{{ fmt(p.ratio) }}</template>
            <template v-else>{{ fmtPrice(p.buyPrice) }}</template>
          </td>
          <td class="text-right tabular-nums">{{ p.type === 'SPLIT' ? '—' : fmtQty(p.buyQuantity) }}</td>
          <td class="text-right tabular-nums opacity-70">{{ p.fee ? fmtMoney(p.fee) : '—' }}</td>
          <td class="text-right tabular-nums">{{ p.type === 'SPLIT' ? '—' : fmtMoney(p.cost) }}</td>
          <td class="text-right tabular-nums">{{ fmtMoney(p.marketValue) }}</td>
          <td class="text-right tabular-nums font-medium" :class="profitCls(p.profit)">
            <!-- 需求 2.2：买入显示 "-- / --" -->
            <template v-if="p.type === 'BUY' || p.type === 'SPLIT'">-- / --</template>
            <template v-else>
              {{ fmtMoney(p.profit) }} <span class="opacity-40">/</span> {{ fmtPct(p.returnRate) }}
            </template>
          </td>
          <td class="text-center text-xs font-medium">
            <template v-if="p.type === 'BUY'">
              <span :class="profitCls(p.targetProfitRate)">+{{ fmt(p.targetProfitRate) }}%</span>
            </template>
            <template v-else>—</template>
          </td>
          <td class="text-center text-xs font-medium">
            <template v-if="p.type === 'BUY'">
              <span :class="profitCls(-(Number(p.stopLossRate) || 0))">-{{ fmt(p.stopLossRate) }}%</span>
            </template>
            <template v-else>—</template>
          </td>
          <td class="text-center">
            <div class="flex justify-center gap-1">
              <template v-if="p.type === 'BUY'">
                <button @click="emit('edit', p)" class="btn btn-info btn-xs">修改</button>
                <button @click="emit('delete', p)" class="btn btn-error btn-xs">删除</button>
              </template>
              <template v-else>
                <button
                  @click="emit('delete-txn', p)"
                  class="btn btn-ghost btn-xs text-error"
                  :title="`删除该笔${meta(p.type).text}记录`"
                >删除</button>
              </template>
            </div>
          </td>
        </tr>
        <tr v-if="!holding.transactions || !holding.transactions.length">
          <td colspan="11" class="text-center opacity-40">暂无交易记录</td>
        </tr>
      </tbody>
    </table>
  </div>
  <div v-if="holding.nextStrategy" class="px-4 py-3 text-xs opacity-60">
    下阶段策略：{{ holding.nextStrategy }}
  </div>
</template>
