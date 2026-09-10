<script setup>
import { ref, watch, computed } from 'vue';
import { useHoldings } from '../composables/useHoldings.js';
import { TXN_TYPES } from '../constants/options.js';

const props = defineProps({
  show: { type: Boolean, default: false },
  txn: { type: Object, default: () => ({ id: '', name: '', type: 'BUY', price: '', quantity: '', date: '' }) },
});
const emit = defineEmits(['close']);

const { submitTransaction } = useHoldings();

const type = ref('BUY');
const price = ref('');
const quantity = ref('');
const fee = ref('');
const amount = ref('');
const ratio = ref('');
const note = ref('');
const date = ref('');
const txnError = ref('');

watch(
  () => props.show,
  (v) => {
    if (v) {
      type.value = props.txn.type || 'BUY';
      price.value = '';
      quantity.value = '';
      fee.value = '';
      amount.value = '';
      ratio.value = '';
      note.value = '';
      date.value = '';
      txnError.value = '';
    }
  }
);

const HINT = {
  BUY: '添加一笔买入记录（手续费会计入成本，拉低持仓均价）',
  SELL: '添加一笔卖出记录（按当前成本法自动计算本笔成本与盈亏）',
  DIVIDEND: '添加一笔现金分红（计入已实现收益，不改变持仓成本）',
  SPLIT: '送转 / 拆股：每 1 份变成 ratio 份（如 10 送 5 填 1.5，1 拆 2 填 2）',
};

const currentType = computed(() => TXN_TYPES.find((t) => t.value === type.value) || TXN_TYPES[0]);
const needPriceQty = computed(() => type.value === 'BUY' || type.value === 'SELL');

async function submitTxn() {
  txnError.value = '';
  try {
    await submitTransaction({
      id: props.txn.id,
      type: type.value,
      price: price.value,
      quantity: quantity.value,
      fee: fee.value,
      amount: amount.value,
      ratio: ratio.value,
      note: note.value,
      date: date.value,
    });
    emit('close');
  } catch (e) {
    txnError.value = e.message;
  }
}
</script>

<template>
  <dialog class="modal" :class="{ 'modal-open': show }">
    <div class="modal-box">
      <h2 class="mb-1 text-lg font-semibold">添加交易 · {{ txn.name }}</h2>
      <p class="mb-4 text-xs opacity-60">{{ HINT[type] }}</p>

      <!-- 交易类型 -->
      <div class="mb-4 flex flex-wrap gap-1.5">
        <button
          v-for="t in TXN_TYPES" :key="t.value"
          @click="type = t.value"
          class="rounded-full px-3 py-1 text-xs font-medium transition"
          :class="type === t.value
            ? 'bg-sky-600 text-white shadow-sm'
            : 'border border-base-300 bg-base-100 text-base-content/70 hover:bg-base-200'"
        >{{ t.label }}</button>
      </div>

      <div class="space-y-3">
        <template v-if="needPriceQty">
          <label class="block text-sm">
            <span class="mb-1 block opacity-60">{{ type === 'BUY' ? '买入' : '卖出' }}价格</span>
            <input v-model="price" type="number" step="0.01" class="input input-bordered w-full" />
          </label>
          <label class="block text-sm">
            <span class="mb-1 block opacity-60">数量</span>
            <input v-model="quantity" type="number" step="1" class="input input-bordered w-full" />
          </label>
        </template>

        <label v-if="type === 'DIVIDEND'" class="block text-sm">
          <span class="mb-1 block opacity-60">分红金额（税前总额，本地币种）</span>
          <input v-model="amount" type="number" step="0.01" class="input input-bordered w-full" />
        </label>

        <label v-if="type === 'SPLIT'" class="block text-sm">
          <span class="mb-1 block opacity-60">送转比例（每 1 份 → 多少份）</span>
          <input v-model="ratio" type="number" step="0.01" class="input input-bordered w-full" placeholder="如 1.5 / 2" />
        </label>

        <label v-if="type !== 'SPLIT'" class="block text-sm">
          <span class="mb-1 block opacity-60">
            手续费{{ type === 'DIVIDEND' ? ' / 红利税（可选）' : '（可选）' }}
          </span>
          <input v-model="fee" type="number" step="0.01" class="input input-bordered w-full" placeholder="0" />
        </label>

        <label class="block text-sm">
          <span class="mb-1 block opacity-60">日期（可选）</span>
          <input v-model="date" type="date" class="input input-bordered w-full" />
        </label>

        <label v-if="type === 'DIVIDEND' || type === 'SPLIT'" class="block text-sm">
          <span class="mb-1 block opacity-60">备注（可选）</span>
          <input v-model="note" type="text" class="input input-bordered w-full" placeholder="如：中期分红" />
        </label>
      </div>

      <p v-if="txnError" class="mt-3 text-sm text-error">{{ txnError }}</p>
      <div class="modal-action">
        <button @click="emit('close')" class="btn btn-sm btn-info">取消</button>
        <button @click="submitTxn" class="btn btn-sm" :class="currentType.cls">
          确认{{ currentType.label }}
        </button>
      </div>
    </div>
    <form class="modal-backdrop" @click="emit('close')"></form>
  </dialog>
</template>
