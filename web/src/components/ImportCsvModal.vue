<script setup>
import { ref, watch } from 'vue';
import { useHoldings, apiFetch } from '../composables/useHoldings.js';

const props = defineProps({
  show: { type: Boolean, default: false },
});
const emit = defineEmits(['close', 'imported']);

const { fetchHoldings } = useHoldings();

const fileName = ref('');
const csvText = ref('');
const createMissing = ref(false);
const importing = ref(false);
const error = ref('');
const result = ref(null);

// 每次打开重置
watch(
  () => props.show,
  (v) => {
    if (v) {
      fileName.value = '';
      csvText.value = '';
      createMissing.value = false;
      importing.value = false;
      error.value = '';
      result.value = null;
    }
  }
);

function handleFile(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  fileName.value = file.name;
  const reader = new FileReader();
  reader.onload = () => {
    csvText.value = String(reader.result || '');
    error.value = '';
    result.value = null;
  };
  reader.readAsText(file, 'utf-8');
  // 允许重复选择同一文件
  e.target.value = '';
}

async function submit() {
  if (!csvText.value.trim()) {
    error.value = '请先选择 CSV 文件';
    return;
  }
  importing.value = true;
  error.value = '';
  result.value = null;
  try {
    const res = await apiFetch('/api/import-csv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csv: csvText.value, createMissing: createMissing.value }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || '导入失败');
    result.value = json.data;
    await fetchHoldings();
    emit('imported');
  } catch (e) {
    error.value = e.message;
  } finally {
    importing.value = false;
  }
}

function close() {
  if (importing.value) return; // 导入中不允许关闭
  emit('close');
}
</script>

<template>
  <dialog class="modal" :class="{ 'modal-open': show }">
    <div class="modal-box max-w-2xl">
      <h2 class="mb-4 text-lg font-semibold">导入 CSV 买卖记录</h2>

      <!-- 未导入：文件选择 -->
      <template v-if="!result">
        <div class="space-y-4">
          <label
            class="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-base-300 p-8 text-center transition hover:border-primary"
          >
            <span class="mb-1 text-3xl">📄</span>
            <span class="text-sm font-medium">{{ fileName || '点击选择 CSV 文件' }}</span>
            <span class="mt-1 text-xs opacity-50">支持 代码 / 操作(买入·卖出·分红·送转) / 日期 / 数量 / 价格 / 手续费 等列</span>
            <input type="file" accept=".csv,text/csv" class="hidden" @change="handleFile" />
          </label>

          <label class="flex items-start gap-2 text-sm">
            <input v-model="createMissing" type="checkbox" class="checkbox checkbox-primary checkbox-sm mt-0.5" />
            <span>
              匹配不到现有持仓时自动新建持仓
              <span class="block text-xs opacity-50">例如 CSV 里的小米（1810）在 holdings 中不存在，勾选后会自动创建</span>
            </span>
          </label>

          <p class="rounded-lg bg-base-200 px-3 py-2 text-xs opacity-70">
            导入规则：按「代码」匹配现有持仓；<b>已存在相同明细（日期/数量/价格）的记录会忽略</b>，缺失的才插入。
          </p>
          <p v-if="error" class="text-sm text-error">{{ error }}</p>
        </div>
        <div class="modal-action">
          <button @click="close" class="btn btn-sm btn-info">取消</button>
          <button @click="submit" class="btn btn-sm btn-primary" :disabled="importing">
            {{ importing ? '导入中…' : '开始导入' }}
          </button>
        </div>
      </template>

      <!-- 已导入：结果展示 -->
      <template v-else>
        <div class="space-y-3">
          <div class="grid grid-cols-3 gap-2 text-center">
            <div class="rounded-lg bg-success/10 p-3">
              <div class="text-xl font-semibold text-success">{{ result.added }}</div>
              <div class="text-xs opacity-60">新增明细</div>
            </div>
            <div class="rounded-lg bg-base-200 p-3">
              <div class="text-xl font-semibold">{{ result.skipped }}</div>
              <div class="text-xs opacity-60">已存在·忽略</div>
            </div>
            <div class="rounded-lg bg-info/10 p-3">
              <div class="text-xl font-semibold text-info">{{ result.total }}</div>
              <div class="text-xs opacity-60">CSV 总记录</div>
            </div>
          </div>

          <div v-if="result.created > 0" class="rounded-lg bg-primary/10 p-3 text-sm">
            <div class="mb-1 font-medium">自动新建持仓（{{ result.created }} 只）</div>
            <ul class="list-inside list-disc space-y-0.5 text-xs opacity-80">
              <li v-for="h in result.createdCodes" :key="h.id">{{ h.name }}（代码={{ h.code }}）</li>
            </ul>
          </div>

          <div v-if="result.missing.length" class="rounded-lg bg-warning/10 p-3 text-sm">
            <div class="mb-1 font-medium text-warning">匹配不到持仓（{{ result.missing.length }} 条）</div>
            <ul class="max-h-28 list-inside list-disc space-y-0.5 overflow-y-auto text-xs opacity-80">
              <li v-for="(m, i) in result.missing" :key="i">
                [{{ { BUY: '买入', SELL: '卖出', DIVIDEND: '分红', SPLIT: '送转' }[m.oper] || m.oper }}] {{ m.name || m.code }}（{{ m.date }} 数量={{ m.qty }} 价格={{ m.price }}）
              </li>
            </ul>
            <p v-if="!createMissing" class="mt-1 text-xs opacity-60">可重新勾选「自动新建持仓」后再导入。</p>
          </div>

          <div v-if="result.errors.length" class="rounded-lg bg-error/10 p-3 text-sm">
            <div class="mb-1 font-medium text-error">导入出错（{{ result.errors.length }} 条）</div>
            <ul class="max-h-28 list-inside list-disc space-y-0.5 overflow-y-auto text-xs opacity-80">
              <li v-for="(e, i) in result.errors" :key="i">{{ e.message }}（记录：{{ e.rec.code }} {{ e.rec.date }}）</li>
            </ul>
          </div>
        </div>
        <div class="modal-action">
          <button @click="close" class="btn btn-sm btn-primary">完成</button>
        </div>
      </template>
    </div>
    <form class="modal-backdrop" @click="close"></form>
  </dialog>
</template>
