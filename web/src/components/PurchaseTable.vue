<script setup>
import { computed } from 'vue';
import {
  fmt, fmtDate, fmtPrice, fmtQty, fmtMoney, fmtPct, profitCls,
} from '../composables/useFormat.js';

const props = defineProps({
  holding: { type: Object, required: true },
});

const emit = defineEmits(['edit', 'delete', 'delete-txn', 'recompute']);

// 剩余批次成本合计 vs 持仓成本：
// 不一致 = 卖出成本是按「旧成本法」记的（比如切到 FIFO 但没重算），这时逐笔收益加总也对不上
const lotCostMismatch = computed(() => {
  const sum = Number(props.holding.lotsCostTotal);
  const total = Number(props.holding.remainingCost);
  if (!Number.isFinite(sum) || !Number.isFinite(total)) return 0;
  return Math.abs(sum - total);
});
// WAC 没有批次概念（按移动平均扣减），不做这个校验
const showMismatch = computed(
  () => props.holding.costMethod !== 'WAC' && lotCostMismatch.value > 0.02
);

const TYPE_META = {
  BUY: { text: '买入', cls: 'badge-success' },
  SELL: { text: '卖出', cls: 'badge-error' },
  DIVIDEND: { text: '分红', cls: 'badge-warning' },
  SPLIT: { text: '送转', cls: 'badge-info' },
};

function meta(t) {
  return TYPE_META[t] || { text: t, cls: 'badge-info' };
}

/** 该行要展示的收益口径：买入 = 剩余仓位的浮动收益，卖出 = 已实现收益 */
function profitOf(p) {
  return p.type === 'BUY' ? p.remainProfit : p.profit;
}
function returnRateOf(p) {
  return p.type === 'BUY' ? p.remainReturnRate : p.returnRate;
}
/** 买入且已全部卖出 */
function soldOut(p) {
  return p.type === 'BUY' && p.remainQty != null && p.remainQty <= 0;
}
</script>

<template>
  <div>
    <!-- 切过成本法但历史卖出成本没重算时的提示 -->
    <div
      v-if="showMismatch"
      class="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-warning/40 bg-warning/10 px-3 py-2 text-[11px]"
    >
      <span class="font-medium text-warning">
        剩余批次成本合计 {{ fmtMoney(holding.lotsCostTotal) }} 与持仓成本 {{ fmtMoney(holding.remainingCost) }} 对不上
      </span>
      <span class="text-muted">历史卖出成本是按旧成本法记录的，所以「谁先卖」的归属还没生效。</span>
      <button
        @click="emit('recompute')"
        class="btn btn-xs btn-warning"
        title="按当前成本法重算历史卖出成本（会改写历史记录，操作前自动备份）"
      >按当前成本法重算</button>
    </div>

    <p class="border-b border-base-300 px-3 py-1.5 text-[11px] text-muted">
      买入行的「当前收益 / 收益率」按现价计算，只统计该笔尚未卖出的数量，用来判断这一次买入值不值得继续拿。
    </p>

    <!-- 手机：卡片式列表（表格 11 列在手机上要横滚才能看到收益） -->
    <ul class="divide-y divide-base-300 sm:hidden">
      <li v-for="p in holding.transactions" :key="p.id" class="px-3 py-2.5">
        <div class="flex items-center gap-2 text-xs">
          <span class="font-medium tabular-nums">{{ fmtDate(p.buyTime) }}</span>
          <span class="badge badge-s text-white" :class="meta(p.type).cls">{{ meta(p.type).text }}</span>
          <span class="ml-auto flex gap-1">
            <template v-if="p.type === 'BUY'">
              <button @click="emit('edit', p)" class="btn btn-info btn-xs">修改</button>
              <button @click="emit('delete', p)" class="btn btn-error btn-xs">删除</button>
            </template>
            <button
              v-else
              @click="emit('delete-txn', p)"
              class="btn btn-ghost btn-xs text-error"
              :title="`删除该笔${meta(p.type).text}记录`"
            >删除</button>
          </span>
        </div>

        <div class="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs">
          <span class="tabular-nums text-muted">
            <template v-if="p.type === 'SPLIT'">×{{ fmt(p.ratio) }}</template>
            <template v-else>{{ fmtPrice(p.buyPrice) }} × {{ fmtQty(p.buyQuantity) }}</template>
          </span>
          <span
            v-if="p.type === 'BUY' && p.remainQty > 0 && p.remainQty < p.buyQuantity"
            class="tabular-nums text-subtle"
          >剩 {{ fmtQty(p.remainQty) }}</span>
          <span
            v-if="p.type === 'BUY' && p.remainQty > 0 && p.remainMarketValue != null"
            class="ml-auto tabular-nums text-muted"
          >
            市值 {{ fmtMoney(p.remainMarketValue) }}
          </span>
        </div>

        <div class="mt-1 flex items-baseline justify-between gap-2 text-xs">
          <span class="text-muted">
            {{ p.type === 'BUY' ? '当前收益' : p.type === 'SELL' ? '已实现' : p.type === 'DIVIDEND' ? '分红金额' : '送转比例' }}
          </span>
          <span class="tabular-nums font-medium" :class="profitCls(profitOf(p))">
            <template v-if="p.type === 'SPLIT'">—</template>
            <template v-else-if="soldOut(p)"><span class="text-subtle">已全部卖出</span></template>
            <template v-else-if="p.type === 'DIVIDEND'">{{ fmtMoney(p.marketValue) }}</template>
            <template v-else-if="profitOf(p) == null">—</template>
            <template v-else>
              {{ fmtMoney(profitOf(p)) }}
              <span class="text-subtle">/</span>
              {{ fmtPct(returnRateOf(p)) }}
            </template>
          </span>
        </div>

        <div v-if="p.type !== 'SPLIT'" class="mt-0.5 text-[11px] text-subtle">
          成本 {{ fmtMoney(p.cost) }}
          <template v-if="p.type === 'BUY' && p.remainQty > 0 && p.remainQty < p.buyQuantity">
            · 剩 {{ fmtMoney(p.remainCost) }}
          </template>
          <template v-if="p.type === 'BUY'">
            · 止盈 +{{ fmt(p.targetProfitRate) }}% · 止损 -{{ fmt(p.stopLossRate) }}%
          </template>
        </div>
      </li>
      <li v-if="!holding.transactions || !holding.transactions.length" class="px-3 py-6 text-center text-xs text-muted">
        暂无交易记录
      </li>
    </ul>

    <!-- 桌面 / 平板：表格 -->
    <div class="hidden overflow-x-auto sm:block">
      <table class="table w-full text-sm">
        <thead>
          <tr class="text-xs uppercase text-muted">
            <th>日期</th>
            <th class="text-center">类型</th>
            <th class="text-right">价格</th>
            <th class="text-right">数量</th>
            <th class="text-right">当前收益 / 收益率</th>
            <th class="text-right">手续费</th>
            <th class="text-right">成本</th>
            <th class="text-right">剩余市值 / 成交额</th>
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
            <td class="text-right tabular-nums">
              <template v-if="p.type === 'SPLIT'">—</template>
              <template v-else>
                {{ fmtQty(p.buyQuantity) }}
                <span
                  v-if="p.type === 'BUY' && p.remainQty > 0 && p.remainQty < p.buyQuantity"
                  class="block text-[11px] text-subtle"
                >剩 {{ fmtQty(p.remainQty) }}</span>
              </template>
            </td>
            <td class="text-right tabular-nums font-medium" :class="profitCls(profitOf(p))">
              <template v-if="p.type === 'SPLIT'">— / —</template>
              <template v-else-if="soldOut(p)">
                <span class="text-subtle">已全部卖出</span>
              </template>
              <template v-else-if="profitOf(p) == null">
                <span class="text-subtle">— / —</span>
              </template>
              <template v-else>
                {{ fmtMoney(profitOf(p)) }} <span class="text-subtle">/</span> {{ fmtPct(returnRateOf(p)) }}
              </template>
            </td>
            <td class="text-right tabular-nums text-muted">{{ p.fee ? fmtMoney(p.fee) : '—' }}</td>
            <td class="text-right tabular-nums">
              <template v-if="p.type === 'SPLIT'">—</template>
              <template v-else>
                {{ fmtMoney(p.cost) }}
                <span
                  v-if="p.type === 'BUY' && p.remainQty > 0 && p.remainQty < p.buyQuantity"
                  class="block text-[11px] text-subtle"
                >剩 {{ fmtMoney(p.remainCost) }}</span>
              </template>
            </td>
            <td class="text-right tabular-nums">
              <template v-if="p.type === 'BUY'">
                {{ p.remainQty > 0 && p.remainMarketValue != null ? fmtMoney(p.remainMarketValue) : '—' }}
              </template>
              <template v-else>{{ fmtMoney(p.marketValue) }}</template>
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
            <td colspan="11" class="text-center text-muted">暂无交易记录</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <div v-if="holding.nextStrategy" class="border-t border-base-300 px-3 py-2 text-xs text-muted sm:px-4">
    下阶段策略：{{ holding.nextStrategy }}
  </div>
</template>
