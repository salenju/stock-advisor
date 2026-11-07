<script setup>
// 加仓测算：① 已知买入数量 → 算新的持仓成本；② 已知目标成本 → 反推需要买多少。
// 纯前端试算，不写账本；实际下单后在持仓卡片里「+ 买入记录」补录即可。
import { ref, computed, watch } from 'vue';
import { useHoldings } from '../composables/useHoldings.js';
import { projectByQuantity, quantityForTargetCost } from '../core/plan.js';
import { fmtMoney, fmtPrice, fmtQty } from '../composables/useFormat.js';

const { holdings } = useHoldings();

const MODES = [
  { value: 'qty', label: '按买入数量' },
  { value: 'cost', label: '按目标成本' },
];
const QTY_PRESETS = [100, 500, 1000];
// 一手股数：A股 / 场内基金 100 股，港股每手不同、美股 1 股起
const LOT_100_REGIONS = ['sh', 'sz', '沪', '深', 'A股', 'A股(沪)', 'A股(深)'];

const mode = ref('qty');
const selectedId = ref('');
const price = ref('');
const quantity = ref('');
const targetCost = ref('');
const fee = ref('');

// 只列还有剩余仓位的标的（已清仓的没有成本可摊薄）
const options = computed(() => (holdings.value || []).filter((h) => Number(h.remainingQty) > 0));
const allCount = computed(() => (holdings.value || []).length);
const current = computed(() => options.value.find((h) => h.id === selectedId.value) || null);

const curQty = computed(() => Number(current.value?.remainingQty) || 0);
const curCost = computed(() => Number(current.value?.remainingCost) || 0);
const curAvg = computed(() => Number(current.value?.avgCost) || 0);
const curPrice = computed(() => {
  const p = Number(current.value?.currentPrice);
  return p > 0 ? p : null;
});
const currency = computed(() => current.value?.currencyCode || '');
const lotSize = computed(() => (LOT_100_REGIONS.includes(String(current.value?.region || '')) ? 100 : 1));

function pick(id) {
  const item = options.value.find((h) => h.id === id);
  if (!item) return;
  selectedId.value = id;
  const p = Number(item.currentPrice);
  price.value = p > 0 ? String(p) : '';
  quantity.value = '';
  targetCost.value = '';
  fee.value = '';
}

// 首次加载 / 选中的标的被删或清仓后，自动落到第一只
watch(
  options,
  (list) => {
    if (!list.length) {
      selectedId.value = '';
      return;
    }
    if (!list.some((h) => h.id === selectedId.value)) pick(list[0].id);
  },
  { immediate: true }
);

function fillCurrentPrice() {
  if (curPrice.value) price.value = String(curPrice.value);
}
function setQty(n) {
  quantity.value = String(n);
}

const qtyResult = computed(() =>
  projectByQuantity({
    currentQty: curQty.value,
    currentCost: curCost.value,
    price: price.value,
    quantity: quantity.value,
    fee: fee.value,
  })
);

const costResult = computed(() =>
  quantityForTargetCost({
    currentQty: curQty.value,
    currentCost: curCost.value,
    price: price.value,
    targetCost: targetCost.value,
    fee: fee.value,
    lotSize: lotSize.value,
  })
);

const qtyHint = computed(() => {
  if (!current.value) return '';
  if (!(Number(price.value) > 0)) return '填写买入价（默认带出现价）';
  if (!(Number(quantity.value) > 0)) return '填写计划买入数量后自动测算';
  return '';
});
const costHint = computed(() => {
  if (!current.value) return '';
  if (!(Number(price.value) > 0)) return '填写买入价（默认带出现价）';
  if (!(Number(targetCost.value) > 0)) return '填写目标成本后自动测算';
  return '';
});

const signed = (v, digits = 2) => `${v > 0 ? '+' : ''}${Number(v).toFixed(digits)}`;
</script>

<template>
  <div class="space-y-4">
    <div v-if="!options.length" class="rounded-xl border border-dashed border-base-300 p-10 text-center text-xs leading-relaxed text-muted">
      <template v-if="allCount">
        加仓测算只列「还有剩余仓位」的标的。<br />
        当前 {{ allCount }} 只持仓都还没有剩余仓位（未录入买入记录或已清仓），数据在「持仓总览」里。
      </template>
      <template v-else>
        还没有持仓数据，先到「持仓总览」添加一只股票
      </template>
    </div>

    <template v-else>
      <!-- 选择标的 + 当前状态 -->
      <div class="rounded-xl border border-base-300 bg-base-100 p-3 sm:p-4">
        <label class="block text-sm">
          <span class="mb-1 block text-xs text-muted">选择标的（只列还有持仓的）</span>
          <select v-model="selectedId" @change="pick(selectedId)" class="select select-bordered select-sm w-full sm:max-w-sm">
            <option v-for="h in options" :key="h.id" :value="h.id">{{ h.name }} · {{ h.code }}</option>
          </select>
        </label>

        <div v-if="current" class="mt-3 grid grid-cols-3 gap-2 text-xs">
          <div class="rounded-lg bg-base-200/70 px-2.5 py-2">
            <div class="opacity-60">持仓数量</div>
            <div class="mt-0.5 text-sm font-medium tabular-nums">{{ fmtQty(curQty) }}</div>
          </div>
          <div class="rounded-lg bg-base-200/70 px-2.5 py-2">
            <div class="opacity-60">当前成本</div>
            <div class="mt-0.5 text-sm font-medium tabular-nums">{{ fmtPrice(curAvg) }}</div>
          </div>
          <div class="rounded-lg bg-base-200/70 px-2.5 py-2">
            <div class="opacity-60">现价</div>
            <div class="mt-0.5 text-sm font-medium tabular-nums">{{ curPrice == null ? '—' : fmtPrice(curPrice) }}</div>
          </div>
        </div>
      </div>

      <!-- 测算参数 -->
      <div class="rounded-xl border border-base-300 bg-base-100 p-3 sm:p-4">
        <div class="grid grid-cols-2 gap-2 sm:max-w-md">
          <label class="block text-sm">
            <span class="mb-1 block text-xs text-muted">买入价</span>
            <div class="flex gap-1">
              <input
                v-model="price"
                type="number"
                step="0.01"
                min="0"
                inputmode="decimal"
                class="input input-bordered input-sm w-full tabular-nums"
                :placeholder="curPrice == null ? '手动填写' : String(curPrice)"
              />
              <button
                v-if="curPrice != null"
                @click="fillCurrentPrice"
                class="btn btn-sm btn-outline shrink-0 px-2 text-xs"
                title="填入当前现价"
              >现价</button>
            </div>
          </label>
          <label class="block text-sm">
            <span class="mb-1 block text-xs text-muted">手续费（可选）</span>
            <input
              v-model="fee"
              type="number"
              step="0.01"
              min="0"
              inputmode="decimal"
              class="input input-bordered input-sm w-full tabular-nums"
              placeholder="0"
            />
          </label>
        </div>

        <!-- 测算方式 -->
        <div class="mt-3 flex flex-wrap gap-1.5">
          <button
            v-for="m in MODES" :key="m.value"
            @click="mode = m.value"
            class="chip px-3 py-1 text-xs font-medium"
            :class="mode === m.value
              ? 'bg-primary text-white shadow-sm'
              : 'border border-base-300 bg-base-100 text-base-content/70 hover:bg-base-200'"
          >{{ m.label }}</button>
        </div>

        <!-- 方式一：按数量算成本 -->
        <template v-if="mode === 'qty'">
          <label class="mt-3 block text-sm">
            <span class="mb-1 block text-xs text-muted">计划买入数量</span>
            <input
              v-model="quantity"
              type="number"
              step="1"
              min="0"
              inputmode="numeric"
              class="input input-bordered w-full tabular-nums sm:max-w-[14rem]"
              placeholder="如 500"
            />
          </label>
          <div class="mt-1.5 flex flex-wrap gap-1.5">
            <button
              v-for="n in QTY_PRESETS" :key="n"
              @click="setQty(n)"
              class="chip border border-base-300 px-2.5 py-1 text-xs hover:bg-base-200"
            >{{ n }} 股</button>
          </div>

          <p v-if="qtyHint" class="mt-3 text-xs text-muted">{{ qtyHint }}</p>
          <p v-else-if="!qtyResult.ok" class="mt-3 text-xs text-error">{{ qtyResult.reason }}</p>
          <div v-else class="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div class="rounded-lg bg-base-200/70 px-2.5 py-2">
              <div class="text-[11px] text-muted">新成本</div>
              <div class="mt-0.5 text-base font-semibold tabular-nums">{{ fmtPrice(qtyResult.newAvg) }}</div>
              <div class="text-[11px] tabular-nums" :class="qtyResult.delta < 0 ? 'text-success' : 'text-error'">
                {{ signed(qtyResult.delta, 3) }}<span v-if="qtyResult.deltaPct != null">（{{ signed(qtyResult.deltaPct) }}%）</span>
              </div>
            </div>
            <div class="rounded-lg bg-base-200/70 px-2.5 py-2">
              <div class="text-[11px] text-muted">新持仓数量</div>
              <div class="mt-0.5 text-sm font-medium tabular-nums">{{ fmtQty(qtyResult.newQty) }}</div>
            </div>
            <div class="rounded-lg bg-base-200/70 px-2.5 py-2">
              <div class="text-[11px] text-muted">需投入</div>
              <div class="mt-0.5 text-sm font-medium tabular-nums">{{ currency }} {{ fmtMoney(qtyResult.invest) }}</div>
            </div>
            <div class="rounded-lg bg-base-200/70 px-2.5 py-2">
              <div class="text-[11px] text-muted">新持仓总成本</div>
              <div class="mt-0.5 text-sm font-medium tabular-nums">{{ currency }} {{ fmtMoney(qtyResult.newCost) }}</div>
            </div>
          </div>
        </template>

        <!-- 方式二：按目标成本反推数量 -->
        <template v-else>
          <label class="mt-3 block text-sm">
            <span class="mb-1 block text-xs text-muted">目标成本（想摊薄到的单位成本）</span>
            <input
              v-model="targetCost"
              type="number"
              step="0.01"
              min="0"
              inputmode="decimal"
              class="input input-bordered w-full tabular-nums sm:max-w-[14rem]"
              :placeholder="curAvg > 0 ? `当前 ${fmtPrice(curAvg)}` : '如 9.50'"
            />
          </label>

          <p v-if="costHint" class="mt-3 text-xs text-muted">{{ costHint }}</p>
          <p v-else-if="!costResult.ok" class="mt-3 text-xs text-error">{{ costResult.reason }}</p>
          <div v-else class="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div class="rounded-lg bg-base-200/70 px-2.5 py-2">
              <div class="text-[11px] text-muted">建议买入</div>
              <div class="mt-0.5 text-base font-semibold tabular-nums">
                {{ fmtQty(costResult.suggestedQty) }} 股
                <span v-if="costResult.suggestedLots" class="text-xs font-normal text-subtle">（{{ costResult.suggestedLots }} 手）</span>
              </div>
            </div>
            <div class="rounded-lg bg-base-200/70 px-2.5 py-2">
              <div class="text-[11px] text-muted">需投入</div>
              <div class="mt-0.5 text-sm font-medium tabular-nums">{{ currency }} {{ fmtMoney(costResult.suggestedInvest) }}</div>
            </div>
            <div class="rounded-lg bg-base-200/70 px-2.5 py-2">
              <div class="text-[11px] text-muted">取整后成本</div>
              <div class="mt-0.5 text-sm font-medium tabular-nums">{{ fmtPrice(costResult.suggestedAvg) }}</div>
            </div>
            <div class="rounded-lg bg-base-200/70 px-2.5 py-2">
              <div class="text-[11px] text-muted">理论数量</div>
              <div class="mt-0.5 text-sm font-medium tabular-nums">{{ fmtQty(costResult.needQty) }} 股</div>
            </div>
          </div>
        </template>
      </div>

      <p class="text-xs leading-relaxed text-muted">
        测算口径：新成本 =（现有剩余总成本 + 买入价 × 数量 + 手续费）÷ 新持仓数量，与页面显示的成本一致（手续费已摊入成本）。
        {{ lotSize > 1 ? '建议买入按 100 股一手向上取整。' : '建议买入按整股向上取整。' }}
        这里只做试算、不改动账本；实际下单后在持仓卡片里「+ 买入记录」录入即可。
      </p>
    </template>
  </div>
</template>
