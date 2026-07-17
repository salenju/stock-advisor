<script setup>
import { ref, watch } from 'vue';
import { INVEST_STRATEGIES, REGION_OPTIONS, TYPE_OPTIONS } from '../constants/options.js';
import { useHoldings } from '../composables/useHoldings.js';

const props = defineProps({
  show: { type: Boolean, default: false },
});
const emit = defineEmits(['close']);

const { addHolding } = useHoldings();

const form = ref(blankForm());
const formError = ref('');

function blankForm() {
  return {
    name: '', code: '', region: 'hk', type: '股票', strategy: 'long',
    buyPrice: '', buyQuantity: '', buyTime: '',
    targetProfitRate: '', stopLossRate: '',
    refillDropRate: '', refillPrice: '',
    position: '', nextStrategy: '', snapshotProfit: '', snapshotReturnRate: '',
  };
}

// 每次打开重置表单
watch(
  () => props.show,
  (v) => {
    if (v) {
      form.value = blankForm();
      formError.value = '';
    }
  }
);

async function submitAdd() {
  formError.value = '';
  const b = {
    name: form.value.name.trim(),
    code: form.value.code.trim(),
    region: form.value.region,
    type: form.value.type,
    strategy: form.value.strategy,
    purchases: [
      {
        buyPrice: form.value.buyPrice,
        buyQuantity: form.value.buyQuantity,
        buyTime: form.value.buyTime,
        targetProfitRate: form.value.targetProfitRate,
        stopLossRate: form.value.stopLossRate,
      },
    ],
    refillDropRate: form.value.refillDropRate,
    refillPrice: form.value.refillPrice,
    position: form.value.position,
    nextStrategy: form.value.nextStrategy,
    snapshotProfit: form.value.snapshotProfit,
    snapshotReturnRate: form.value.snapshotReturnRate,
  };
  try {
    await addHolding(b);
    emit('close');
  } catch (e) {
    formError.value = e.message;
  }
}
</script>

<template>
  <dialog class="modal" :class="{ 'modal-open': show }">
    <div class="modal-box">
      <h2 class="mb-4 text-lg font-semibold">添加持仓</h2>
      <div class="grid grid-cols-2 gap-3">
        <label class="col-span-2 text-sm">
          <span class="mb-1 block opacity-60">名称</span>
          <input v-model="form.name" class="input input-bordered w-full" placeholder="如 腾讯控股" />
        </label>
        <label class="col-span-2 text-sm">
          <span class="mb-1 block opacity-60">代码</span>
          <input v-model="form.code" class="input input-bordered w-full" placeholder="如 00700" />
        </label>
        <label class="text-sm">
          <span class="mb-1 block opacity-60">地区</span>
          <select v-model="form.region" class="select select-bordered w-full">
            <option v-for="r in REGION_OPTIONS" :key="r.value" :value="r.value">{{ r.label }}</option>
          </select>
        </label>
        <label class="text-sm">
          <span class="mb-1 block opacity-60">类型</span>
          <select v-model="form.type" class="select select-bordered w-full">
            <option v-for="t in TYPE_OPTIONS" :key="t" :value="t">{{ t }}</option>
          </select>
        </label>
        <label class="col-span-2 text-sm">
          <span class="mb-1 block opacity-60">投资策略</span>
          <select v-model="form.strategy" class="select select-bordered w-full">
            <option v-for="s in INVEST_STRATEGIES" :key="s.value" :value="s.value">{{ s.label }}</option>
          </select>
        </label>
        <label class="text-sm">
          <span class="mb-1 block opacity-60">买入价</span>
          <input v-model="form.buyPrice" type="number" step="0.01" class="input input-bordered w-full" />
        </label>
        <label class="text-sm">
          <span class="mb-1 block opacity-60">买入数量</span>
          <input v-model="form.buyQuantity" type="number" step="1" class="input input-bordered w-full" />
        </label>
        <label class="text-sm">
          <span class="mb-1 block opacity-60">买入日期</span>
          <input v-model="form.buyTime" type="date" class="input input-bordered w-full" />
        </label>
        <label class="text-sm">
          <span class="mb-1 block opacity-60">止盈收益率 %</span>
          <input v-model="form.targetProfitRate" type="number" step="0.1" class="input input-bordered w-full" />
        </label>
        <label class="text-sm">
          <span class="mb-1 block opacity-60">止损收益率 %</span>
          <input v-model="form.stopLossRate" type="number" step="0.1" class="input input-bordered w-full" />
        </label>
        <label class="text-sm">
          <span class="mb-1 block opacity-60">补仓降幅 %</span>
          <input v-model="form.refillDropRate" type="number" step="0.1" class="input input-bordered w-full" />
        </label>
        <label class="text-sm">
          <span class="mb-1 block opacity-60">补仓价格</span>
          <input v-model="form.refillPrice" type="number" step="0.01" class="input input-bordered w-full" />
        </label>
        <label class="text-sm">
          <span class="mb-1 block opacity-60">仓位(参考)</span>
          <input v-model="form.position" type="number" step="1" class="input input-bordered w-full" />
        </label>
        <label class="col-span-2 text-sm">
          <span class="mb-1 block opacity-60">下阶段策略</span>
          <input v-model="form.nextStrategy" class="input input-bordered w-full" />
        </label>
      </div>
      <p v-if="formError" class="mt-3 text-sm text-error">{{ formError }}</p>
      <div class="modal-action">
        <button @click="emit('close')" class="btn">取消</button>
        <button @click="submitAdd" class="btn btn-primary">保存</button>
      </div>
    </div>
    <form class="modal-backdrop" @click="emit('close')"></form>
  </dialog>
</template>
