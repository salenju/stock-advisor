<script setup>
import { ref, computed, watch } from 'vue';
import { INVEST_STRATEGIES, REGION_OPTIONS, TYPE_OPTIONS } from '../constants/options.js';
import { useHoldings } from '../composables/useHoldings.js';
import BaseModal from './BaseModal.vue';

// 新建 / 编辑合用一个表单：传 holding 即为编辑模式
const props = defineProps({
  show: { type: Boolean, default: false },
  /** 要编辑的持仓（不传 = 新建） */
  holding: { type: Object, default: null },
});
const emit = defineEmits(['close']);

const { addHolding, updateHolding } = useHoldings();

const isEdit = computed(() => !!props.holding?.id);

const form = ref(blankForm());
const formError = ref('');
const saving = ref(false);

const str = (v) => (v == null ? '' : String(v));

function blankForm() {
  return {
    name: '', code: '', region: 'hk', type: '股票', strategy: 'long',
    targetProfitRate: '', stopLossRate: '',
    refillDropRate: '', refillPrice: '',
    nextStrategy: '',
    dailyDropAlertPct: '', dailyRiseAlertPct: '',
  };
}

function fillForm(h) {
  return {
    name: str(h.name),
    code: str(h.code),
    region: h.region || 'hk',
    type: h.type || '股票',
    strategy: h.strategy || 'long',
    targetProfitRate: str(h.targetProfitRate),
    stopLossRate: str(h.stopLossRate),
    refillDropRate: str(h.refillDropRate),
    refillPrice: str(h.refillPrice),
    nextStrategy: str(h.nextStrategy),
    dailyDropAlertPct: h.dailyDropAlertPct == null ? '' : str(h.dailyDropAlertPct),
    dailyRiseAlertPct: h.dailyRiseAlertPct == null ? '' : str(h.dailyRiseAlertPct),
  };
}

// 每次打开重置表单（编辑模式下用当前持仓回填）
watch(
  [() => props.show, () => props.holding],
  ([show]) => {
    if (!show) return;
    form.value = props.holding ? fillForm(props.holding) : blankForm();
    formError.value = '';
    saving.value = false;
  },
  { immediate: true }
);

// 代码 / 市场 / 类型决定行情怎么拉（腾讯代码前缀、基金或股票通道），
// 改动后必须让下一轮刷新用新标的重新取价。
const identityChanged = computed(() => {
  const h = props.holding;
  if (!h) return false;
  return (
    form.value.code.trim() !== str(h.code) ||
    form.value.region !== h.region ||
    form.value.type !== h.type
  );
});

async function submit() {
  if (saving.value) return;
  formError.value = '';
  const f = form.value;
  const name = f.name.trim();
  const code = f.code.trim();
  if (!name) {
    formError.value = '请填写名称';
    return;
  }
  if (!code) {
    formError.value = '请填写代码';
    return;
  }

  const basic = {
    name,
    code,
    region: f.region,
    type: f.type,
    strategy: f.strategy,
    targetProfitRate: f.targetProfitRate,
    stopLossRate: f.stopLossRate,
    refillDropRate: f.refillDropRate,
    refillPrice: f.refillPrice,
    nextStrategy: f.nextStrategy,
    dailyDropAlertPct: f.dailyDropAlertPct === '' ? null : f.dailyDropAlertPct,
    dailyRiseAlertPct: f.dailyRiseAlertPct === '' ? null : f.dailyRiseAlertPct,
  };

  saving.value = true;
  try {
    if (isEdit.value) {
      await updateHolding(props.holding.id, basic);
    } else {
      // 建仓阶段只登记股票信息，买入价/数量后续由「买入记录」补充
      await addHolding({ ...basic, purchases: [] });
    }
    emit('close');
  } catch (e) {
    formError.value = e.message;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <BaseModal :show="show" :title="isEdit ? '编辑持仓信息' : '添加持仓'" @close="emit('close')">
    <div class="grid grid-cols-2 gap-3">
        <label class="col-span-2 text-sm">
          <span class="mb-1 block text-muted">名称</span>
          <input v-model="form.name" class="input input-bordered w-full" placeholder="如 腾讯控股" />
        </label>
        <label class="col-span-2 text-sm">
          <span class="mb-1 block text-muted">代码</span>
          <input v-model="form.code" class="input input-bordered w-full" placeholder="如 00700" />
        </label>
        <label class="text-sm">
          <span class="mb-1 block text-muted">地区</span>
          <select v-model="form.region" class="select select-bordered w-full">
            <option v-for="r in REGION_OPTIONS" :key="r.value" :value="r.value">{{ r.label }}</option>
          </select>
        </label>
        <label class="text-sm">
          <span class="mb-1 block text-muted">类型</span>
          <select v-model="form.type" class="select select-bordered w-full">
            <option v-for="t in TYPE_OPTIONS" :key="t" :value="t">{{ t }}</option>
          </select>
        </label>
        <label class="col-span-2 text-sm">
          <span class="mb-1 block text-muted">投资策略</span>
          <select v-model="form.strategy" class="select select-bordered w-full">
            <option v-for="s in INVEST_STRATEGIES" :key="s.value" :value="s.value">{{ s.label }}</option>
          </select>
        </label>
        <label class="text-sm">
          <span class="mb-1 block text-muted">止盈收益率 %</span>
          <input v-model="form.targetProfitRate" type="number" step="0.1" class="input input-bordered w-full" />
        </label>
        <label class="text-sm">
          <span class="mb-1 block text-muted">止损收益率 %</span>
          <input v-model="form.stopLossRate" type="number" step="0.1" class="input input-bordered w-full" />
        </label>
        <label class="text-sm">
          <span class="mb-1 block text-muted">补仓降幅 %</span>
          <input v-model="form.refillDropRate" type="number" step="0.1" class="input input-bordered w-full" />
        </label>
        <label class="text-sm">
          <span class="mb-1 block text-muted">补仓价格</span>
          <input v-model="form.refillPrice" type="number" step="0.01" class="input input-bordered w-full" />
        </label>
        <label class="text-sm">
          <span class="mb-1 block text-muted">日跌告警 %</span>
          <input v-model="form.dailyDropAlertPct" type="number" step="0.1" class="input input-bordered w-full" placeholder="留空=不告警" />
        </label>
        <label class="text-sm">
          <span class="mb-1 block text-muted">日涨告警 %</span>
          <input v-model="form.dailyRiseAlertPct" type="number" step="0.1" class="input input-bordered w-full" placeholder="留空=不告警" />
        </label>
        <label class="col-span-2 text-sm">
          <span class="mb-1 block text-muted">下阶段策略</span>
          <input v-model="form.nextStrategy" class="input input-bordered w-full" />
        </label>
      <p v-if="identityChanged" class="col-span-2 rounded-lg bg-info/10 px-3 py-2 text-xs text-base-content/70">
        代码 / 地区 / 类型改动后，下一轮刷新会按新标的重取行情（旧价格会被丢弃）；已录入的买入、卖出记录金额不会自动换算。
      </p>
      <p v-if="formError" class="col-span-2 text-sm text-error">{{ formError }}</p>
    </div>
    <template #footer>
      <button @click="emit('close')" class="btn btn-sm btn-ghost">取消</button>
      <button @click="submit" class="btn btn-sm btn-primary" :disabled="saving">
        {{ saving ? '保存中…' : isEdit ? '保存修改' : '保存' }}
      </button>
    </template>
  </BaseModal>
</template>
