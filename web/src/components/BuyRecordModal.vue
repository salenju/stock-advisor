<script setup>
import { ref, watch } from 'vue';
import { useHoldings } from '../composables/useHoldings.js';
import BaseModal from './BaseModal.vue';

const props = defineProps({
  show: { type: Boolean, default: false },
  buyForm: {
    type: Object,
    default: () => ({ id: '', name: '', pid: '', buyPrice: '', buyQuantity: '', buyTime: '', targetProfitRate: '', stopLossRate: '' }),
  },
});
const emit = defineEmits(['close']);

const { savePurchase } = useHoldings();

const buyPrice = ref('');
const buyQuantity = ref('');
const buyTime = ref('');
const targetProfitRate = ref('');
const stopLossRate = ref('');
const fee = ref('');
const buyError = ref('');

watch(
  () => props.show,
  (v) => {
    if (v) {
      buyPrice.value = props.buyForm.buyPrice;
      buyQuantity.value = props.buyForm.buyQuantity;
      buyTime.value = props.buyForm.buyTime;
      targetProfitRate.value = props.buyForm.targetProfitRate;
      stopLossRate.value = props.buyForm.stopLossRate;
      fee.value = props.buyForm.fee ?? '';
      buyError.value = '';
    }
  }
);

async function submitBuy() {
  buyError.value = '';
  try {
    await savePurchase({
      id: props.buyForm.id,
      pid: props.buyForm.pid,
      buyPrice: buyPrice.value,
      buyQuantity: buyQuantity.value,
      buyTime: buyTime.value,
      targetProfitRate: targetProfitRate.value,
      stopLossRate: stopLossRate.value,
      fee: fee.value,
    });
    emit('close');
  } catch (e) {
    buyError.value = e.message;
  }
}
</script>

<template>
  <BaseModal
    :show="show"
    :title="`${buyForm.pid ? '修改买入记录' : '添加买入记录'} · ${buyForm.name}`"
    subtitle="同一股票可记录多次买入，各自设置不同的止盈/止损比例"
    @close="emit('close')"
  >
      <div class="space-y-3">
        <label class="block text-sm">
          <span class="mb-1 block text-muted">买入价</span>
          <input v-model="buyPrice" type="number" step="0.01" class="input input-bordered w-full" />
        </label>
        <label class="block text-sm">
          <span class="mb-1 block text-muted">买入数量</span>
          <input v-model="buyQuantity" type="number" step="1" class="input input-bordered w-full" />
        </label>
        <label class="block text-sm">
          <span class="mb-1 block text-muted">买入日期</span>
          <input v-model="buyTime" type="date" class="input input-bordered w-full" />
        </label>
        <label class="block text-sm">
          <span class="mb-1 block text-muted">手续费（可选，计入成本）</span>
          <input v-model="fee" type="number" step="0.01" class="input input-bordered w-full" placeholder="0" />
        </label>
        <label class="block text-sm">
          <span class="mb-1 block text-muted">止盈收益率 %</span>
          <input v-model="targetProfitRate" type="number" step="0.1" class="input input-bordered w-full" />
        </label>
        <label class="block text-sm">
          <span class="mb-1 block text-muted">止损收益率 %</span>
          <input v-model="stopLossRate" type="number" step="0.1" class="input input-bordered w-full" />
        </label>
      </div>
      <p v-if="buyError" class="mt-3 text-sm text-error">{{ buyError }}</p>
    <template #footer>
      <button @click="emit('close')" class="btn btn-sm btn-ghost">取消</button>
      <button @click="submitBuy" class="btn btn-sm btn-primary">保存</button>
    </template>
  </BaseModal>
</template>
