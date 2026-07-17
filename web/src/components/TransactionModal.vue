<script setup>
import { ref, watch } from 'vue';
import { useHoldings } from '../composables/useHoldings.js';

const props = defineProps({
  show: { type: Boolean, default: false },
  txn: { type: Object, default: () => ({ id: '', name: '', type: 'BUY', price: '', quantity: '', date: '' }) },
});
const emit = defineEmits(['close']);

const { submitTransaction } = useHoldings();

const price = ref('');
const quantity = ref('');
const date = ref('');
const txnError = ref('');

watch(
  () => props.show,
  (v) => {
    if (v) {
      price.value = '';
      quantity.value = '';
      date.value = '';
      txnError.value = '';
    }
  }
);

async function submitTxn() {
  txnError.value = '';
  try {
    await submitTransaction({
      id: props.txn.id,
      type: props.txn.type,
      price: price.value,
      quantity: quantity.value,
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
      <h2 class="mb-1 text-lg font-semibold">
        {{ txn.type === 'BUY' ? '买入' : '卖出' }} · {{ txn.name }}
      </h2>
      <p class="mb-4 text-xs opacity-60">对已有持仓追加交易，系统自动重算成本/数量/最近买入价/状态</p>
      <div class="space-y-3">
        <label class="block text-sm">
          <span class="mb-1 block opacity-60">价格</span>
          <input v-model="price" type="number" step="0.01" class="input input-bordered w-full" />
        </label>
        <label class="block text-sm">
          <span class="mb-1 block opacity-60">数量</span>
          <input v-model="quantity" type="number" step="1" class="input input-bordered w-full" />
        </label>
        <label class="block text-sm">
          <span class="mb-1 block opacity-60">日期（可选）</span>
          <input v-model="date" type="date" class="input input-bordered w-full" />
        </label>
      </div>
      <p v-if="txnError" class="mt-3 text-sm text-error">{{ txnError }}</p>
      <div class="modal-action">
        <button @click="emit('close')" class="btn">取消</button>
        <button
          @click="submitTxn"
          class="btn"
          :class="txn.type === 'BUY' ? 'btn-success' : 'btn-error'"
        >确认{{ txn.type === 'BUY' ? '买入' : '卖出' }}</button>
      </div>
    </div>
    <form class="modal-backdrop" @click="emit('close')"></form>
  </dialog>
</template>
