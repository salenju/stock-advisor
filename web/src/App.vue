<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';

const holdings = ref([]);
const lastUpdated = ref('');
const loading = ref(false);
const error = ref('');

// ---------- 主题切换 ----------
const isDark = ref(true);
function applyTheme() {
  document.documentElement.classList.toggle('dark', isDark.value);
}
function initTheme() {
  const saved = localStorage.getItem('theme');
  // 默认深色（与历史行为一致）
  isDark.value = saved ? saved === 'dark' : true;
  applyTheme();
}
function toggleTheme() {
  isDark.value = !isDark.value;
  localStorage.setItem('theme', isDark.value ? 'dark' : 'light');
  applyTheme();
}

// 自动刷新间隔（与后端调度一致：20 秒）
const REFRESH_MS = 20000;
const countdown = ref(REFRESH_MS / 1000); // 距下次刷新秒数
// 环形进度：随倒计时从满圈递减到空圈
const RING_C = 2 * Math.PI * 7;
const progress = computed(() => countdown.value / (REFRESH_MS / 1000));
const ringOffset = computed(() => RING_C * (1 - progress.value));
let tick = null;

async function fetchHoldings() {
  loading.value = true;
  error.value = '';
  try {
    const res = await fetch('/api/holdings');
    const json = await res.json();
    holdings.value = json.data || [];
    lastUpdated.value = new Date().toLocaleTimeString('zh-CN');
    countdown.value = REFRESH_MS / 1000; // 刷新后重置倒计时
  } catch (e) {
    error.value = '获取持仓失败：' + e.message;
  } finally {
    loading.value = false;
  }
}

function refreshNow() {
  fetchHoldings();
}

// ---------- 测试飞书推送 ----------
const testing = ref(false);
const testMsg = ref('');
let testMsgTimer = null;
async function testFeishu() {
  testing.value = true;
  testMsg.value = '';
  try {
    const res = await fetch('/api/test-feishu', { method: 'POST' });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || '发送失败');
    testMsg.value = '已发送测试消息到飞书 ✓';
  } catch (e) {
    testMsg.value = e.message;
  } finally {
    testing.value = false;
    clearTimeout(testMsgTimer);
    testMsgTimer = setTimeout(() => (testMsg.value = ''), 6000);
  }
}

onMounted(() => {
  initTheme();
  fetchHoldings();
  // 1 秒心跳：倒计时递减，归零即触发刷新（单一定时器，避免多定时器漂移）
  tick = setInterval(() => {
    countdown.value -= 1;
    if (countdown.value <= 0) fetchHoldings();
  }, 1000);
});
onUnmounted(() => clearInterval(tick));

// ---------- 格式化 ----------
const fmt = (v, d = 2) =>
  v == null || Number.isNaN(v) ? '—' : Number(v).toFixed(d);
const fmtPct = (v) => (v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(2) + '%');
const fmtMoney = (v) => (v == null ? '—' : Number(v).toFixed(2));

function triggerBadge(state) {
  if (!state || state === 'IDLE')
    return { text: '待观察', cls: 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300' };
  if (state.includes('BUY'))
    return {
      text: '买点',
      cls: 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-600/30 dark:bg-emerald-600/20 dark:text-emerald-400 dark:ring-emerald-600/40',
    };
  if (state.includes('SELL'))
    return {
      text: '卖点',
      cls: 'bg-rose-100 text-rose-700 ring-1 ring-rose-600/30 dark:bg-rose-600/20 dark:text-rose-400 dark:ring-rose-600/40',
    };
  if (state.includes('NEAR'))
    return {
      text: '临近阈值',
      cls: 'bg-amber-100 text-amber-700 ring-1 ring-amber-500/30 dark:bg-amber-500/20 dark:text-amber-400 dark:ring-amber-500/40',
    };
  return { text: state, cls: 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300' };
}

const regionLabel = { hk: '港股', us: '美股', sh: 'A股', sz: 'A股' };

// ---------- 添加持仓 ----------
const showAdd = ref(false);
const form = ref({
  name: '', code: '', region: 'hk', type: '股票',
  buyPrice: '', buyQuantity: '', cost: '',
  targetProfitRate: '', refillDropRate: '', refillPrice: '',
  nextStrategy: '', snapshotProfit: '', snapshotReturnRate: '', position: '',
});
const formError = ref('');

function resetForm() {
  form.value = {
    name: '', code: '', region: 'hk', type: '股票',
    buyPrice: '', buyQuantity: '', cost: '',
    targetProfitRate: '', refillDropRate: '', refillPrice: '',
    nextStrategy: '', snapshotProfit: '', snapshotReturnRate: '', position: '',
  };
  formError.value = '';
}
function autoCost() {
  const p = parseFloat(form.value.buyPrice);
  const q = parseFloat(form.value.buyQuantity);
  if (p && q) form.value.cost = (p * q).toFixed(2);
}

async function submitAdd() {
  formError.value = '';
  const b = {
    name: form.value.name.trim(),
    code: form.value.code.trim(),
    region: form.value.region,
    type: form.value.type,
    buyPrice: form.value.buyPrice,
    buyQuantity: form.value.buyQuantity,
    cost: form.value.cost || (parseFloat(form.value.buyPrice) * parseFloat(form.value.buyQuantity)).toFixed(2),
    targetProfitRate: form.value.targetProfitRate,
    refillDropRate: form.value.refillDropRate,
    refillPrice: form.value.refillPrice,
    nextStrategy: form.value.nextStrategy,
    snapshotProfit: form.value.snapshotProfit,
    snapshotReturnRate: form.value.snapshotReturnRate,
    position: form.value.position,
  };
  try {
    const res = await fetch('/api/holdings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(b),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || '添加失败');
    showAdd.value = false;
    resetForm();
    await fetchHoldings();
  } catch (e) {
    formError.value = e.message;
  }
}

// ---------- 买卖交易 ----------
const showTxn = ref(false);
const txn = ref({ id: '', name: '', type: 'BUY', price: '', quantity: '', date: '' });
const txnError = ref('');

function openTxn(h, type) {
  txn.value = { id: h.id, name: h.name, type, price: '', quantity: '', date: '' };
  txnError.value = '';
  showTxn.value = true;
}
async function submitTxn() {
  txnError.value = '';
  try {
    const res = await fetch(`/api/holdings/${txn.value.id}/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: txn.value.type,
        price: txn.value.price,
        quantity: txn.value.quantity,
        date: txn.value.date || undefined,
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || '交易失败');
    showTxn.value = false;
    await fetchHoldings();
  } catch (e) {
    txnError.value = e.message;
  }
}
</script>

<template>
  <div class="min-h-full bg-slate-50 text-slate-800 dark:bg-slate-950 dark:text-slate-200">
    <!-- 顶部栏 -->
    <header class="sticky top-0 z-10 border-b border-slate-200 bg-white/80 backdrop-blur dark:border-slate-800 dark:bg-slate-950/80">
      <div class="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
        <div>
          <h1 class="text-xl font-semibold tracking-tight text-slate-900 dark:text-white">📈 股票秘书</h1>
          <p class="mt-0.5 text-xs text-slate-500 dark:text-slate-500">
            持仓 · 实时行情 · 飞书阈值提醒
            <span v-if="lastUpdated" class="ml-2">· 更新于 {{ lastUpdated }}</span>
            <span v-if="loading" class="ml-2 text-sky-500 dark:text-sky-400">刷新中…</span>
            <span class="ml-2 inline-flex items-center gap-1 text-slate-500 dark:text-slate-600">
              · {{ countdown }} 秒后刷新
              <svg class="h-4 w-4 -rotate-90" viewBox="0 0 16 16">
                <circle cx="8" cy="8" r="7" fill="none" stroke="rgb(203 213 225)" stroke-width="2" class="dark:stroke-slate-700" />
                <circle
                  cx="8" cy="8" r="7" fill="none" stroke="rgb(14 165 233)" stroke-width="2"
                  stroke-linecap="round"
                  :stroke-dasharray="RING_C"
                  :stroke-dashoffset="ringOffset"
                />
              </svg>
            </span>
          </p>
        </div>
        <div class="flex items-center gap-2">
          <span v-if="error" class="text-xs text-rose-600 dark:text-rose-400">{{ error }}</span>
          <button
            @click="toggleTheme"
            :title="isDark ? '切换到浅色' : '切换到深色'"
            class="rounded-md border border-slate-300 px-2.5 py-1.5 text-sm text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >{{ isDark ? '☀️' : '🌙' }}</button>
          <button
            @click="refreshNow"
            class="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >刷新</button>
          <button
            @click="testFeishu"
            :disabled="testing"
            :title="testing ? '发送中…' : '向飞书机器人发送一条测试消息'"
            class="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >{{ testing ? '发送中…' : '测试飞书' }}</button>
          <button
            @click="showAdd = true"
            class="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500"
          >+ 添加持仓</button>
          <span
            v-if="testMsg"
            class="text-xs"
            :class="testMsg.includes('✓') ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'"
          >{{ testMsg }}</span>
        </div>
      </div>
    </header>

    <main class="mx-auto max-w-7xl px-6 py-6">
      <!-- 概览卡片 -->
      <div class="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div class="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/60">
          <div class="text-xs text-slate-500">持仓数</div>
          <div class="mt-1 text-2xl font-semibold text-slate-900 dark:text-white">{{ holdings.length }}</div>
        </div>
        <div class="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/60">
          <div class="text-xs text-slate-500">总成本</div>
          <div class="mt-1 text-2xl font-semibold text-slate-900 dark:text-white">
            {{ fmtMoney(holdings.reduce((s, h) => s + (Number(h.cost) || 0), 0)) }}
          </div>
        </div>
        <div class="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/60">
          <div class="text-xs text-slate-500">总数量</div>
          <div class="mt-1 text-2xl font-semibold text-slate-900 dark:text-white">
            {{ fmt(holdings.reduce((s, h) => s + (Number(h.buyQuantity) || 0), 0), 0) }}
          </div>
        </div>
        <div class="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/60">
          <div class="text-xs text-slate-500">触发中</div>
          <div class="mt-1 text-2xl font-semibold text-slate-900 dark:text-white">
            {{ holdings.filter((h) => h.triggerState && h.triggerState !== 'IDLE').length }}
          </div>
        </div>
      </div>

      <!-- 持仓表格 -->
      <div class="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
        <table class="w-full min-w-[1100px] border-collapse text-sm">
          <thead class="bg-slate-100 text-left text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-900 dark:text-slate-400">
            <tr>
              <th class="px-4 py-3">名称 / 代码</th>
              <th class="px-4 py-3">地区</th>
              <th class="px-4 py-3">类型</th>
              <th class="px-4 py-3">状态</th>
              <th class="px-4 py-3 text-right">成本</th>
              <th class="px-4 py-3 text-right">均价</th>
              <th class="px-4 py-3 text-right">数量</th>
              <th class="px-4 py-3 text-right">实时价</th>
              <th class="px-4 py-3 text-right">收益率</th>
              <th class="px-4 py-3 text-center">触发态</th>
              <th class="px-4 py-3 text-right">止盈%</th>
              <th class="px-4 py-3 text-right">补仓%</th>
              <th class="px-4 py-3 text-center">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-200 dark:divide-slate-800">
            <tr v-for="h in holdings" :key="h.id" class="hover:bg-slate-50 dark:hover:bg-slate-900/40">
              <td class="px-4 py-3">
                <div class="font-medium text-slate-900 dark:text-white">{{ h.name }}</div>
                <div class="text-xs text-slate-500">{{ h.code }}</div>
              </td>
              <td class="px-4 py-3 text-slate-700 dark:text-slate-300">{{ regionLabel[h.region] || h.region }}</td>
              <td class="px-4 py-3 text-slate-700 dark:text-slate-300">{{ h.type }}</td>
              <td class="px-4 py-3">
                <span
                  class="rounded px-2 py-0.5 text-xs"
                  :class="h.status === '持有' ? 'bg-sky-100 text-sky-700 dark:bg-sky-600/20 dark:text-sky-400' : 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300'"
                >{{ h.status }}</span>
              </td>
              <td class="px-4 py-3 text-right tabular-nums text-slate-700 dark:text-slate-300">{{ fmtMoney(h.cost) }}</td>
              <td class="px-4 py-3 text-right tabular-nums text-slate-700 dark:text-slate-300">{{ fmtMoney(h.avgCost) }}</td>
              <td class="px-4 py-3 text-right tabular-nums text-slate-700 dark:text-slate-300">{{ fmt(h.buyQuantity, 0) }}</td>
              <td class="px-4 py-3 text-right tabular-nums font-medium text-slate-900 dark:text-white">{{ fmtMoney(h.currentPrice) }}</td>
              <td
                class="px-4 py-3 text-right tabular-nums font-medium"
                :class="(h.returnRate ?? 0) >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'"
              >{{ fmtPct(h.returnRate) }}</td>
              <td class="px-4 py-3 text-center">
                <span class="rounded px-2 py-0.5 text-xs" :class="triggerBadge(h.triggerState).cls">
                  {{ triggerBadge(h.triggerState).text }}
                </span>
              </td>
              <td class="px-4 py-3 text-right tabular-nums text-slate-400 dark:text-slate-400">{{ fmt(h.targetProfitRate) }}</td>
              <td class="px-4 py-3 text-right tabular-nums text-slate-400 dark:text-slate-400">{{ fmt(h.refillDropRate) }}</td>
              <td class="px-4 py-3 text-center">
                <div class="flex justify-center gap-1">
                  <button
                    @click="openTxn(h, 'BUY')"
                    class="rounded bg-emerald-100 px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-200 dark:bg-emerald-600/20 dark:text-emerald-400 dark:hover:bg-emerald-600/30"
                  >买入</button>
                  <button
                    @click="openTxn(h, 'SELL')"
                    class="rounded bg-rose-100 px-2 py-1 text-xs font-medium text-rose-700 hover:bg-rose-200 dark:bg-rose-600/20 dark:text-rose-400 dark:hover:bg-rose-600/30"
                  >卖出</button>
                </div>
              </td>
            </tr>
            <tr v-if="!holdings.length">
              <td colspan="13" class="px-4 py-10 text-center text-slate-400 dark:text-slate-500">
                暂无持仓，点击右上角「添加持仓」开始记录
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p class="mt-4 text-xs text-slate-400 dark:text-slate-600">每 {{ REFRESH_MS / 1000 }} 秒自动刷新（顶部倒计时）持仓与实时行情，点「刷新」可立即更新。</p>
    </main>

    <!-- 添加持仓弹窗 -->
    <div v-if="showAdd" class="fixed inset-0 z-20 flex items-center justify-center bg-black/40 p-4" @click.self="showAdd = false">
      <div class="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl dark:border-slate-800 dark:bg-slate-900">
        <h2 class="mb-4 text-lg font-semibold text-slate-900 dark:text-white">添加持仓</h2>
        <div class="grid grid-cols-2 gap-3">
          <label class="col-span-2 text-sm">
            <span class="mb-1 block text-slate-500">名称</span>
            <input v-model="form.name" class="input" placeholder="如 腾讯控股" />
          </label>
          <label class="col-span-2 text-sm">
            <span class="mb-1 block text-slate-500">代码</span>
            <input v-model="form.code" class="input" placeholder="如 00700" />
          </label>
          <label class="text-sm">
            <span class="mb-1 block text-slate-500">地区</span>
            <select v-model="form.region" class="input">
              <option value="hk">港股</option>
              <option value="us">美股</option>
              <option value="sh">A股(沪)</option>
              <option value="sz">A股(深)</option>
            </select>
          </label>
          <label class="text-sm">
            <span class="mb-1 block text-slate-500">类型</span>
            <select v-model="form.type" class="input">
              <option>股票</option>
              <option>股票型基金</option>
              <option>债券型基金</option>
              <option>货币型基金</option>
              <option>ETF</option>
            </select>
          </label>
          <label class="text-sm">
            <span class="mb-1 block text-slate-500">买入价</span>
            <input v-model="form.buyPrice" type="number" step="0.01" class="input" @input="autoCost" />
          </label>
          <label class="text-sm">
            <span class="mb-1 block text-slate-500">买入数量</span>
            <input v-model="form.buyQuantity" type="number" step="1" class="input" @input="autoCost" />
          </label>
          <label class="text-sm">
            <span class="mb-1 block text-slate-500">成本（自动计算，可改）</span>
            <input v-model="form.cost" type="number" step="0.01" class="input" />
          </label>
          <label class="text-sm">
            <span class="mb-1 block text-slate-500">预期止盈收益率 %</span>
            <input v-model="form.targetProfitRate" type="number" step="0.1" class="input" />
          </label>
          <label class="text-sm">
            <span class="mb-1 block text-slate-500">补仓降幅 %</span>
            <input v-model="form.refillDropRate" type="number" step="0.1" class="input" />
          </label>
          <label class="text-sm">
            <span class="mb-1 block text-slate-500">补仓价格</span>
            <input v-model="form.refillPrice" type="number" step="0.01" class="input" />
          </label>
          <label class="col-span-2 text-sm">
            <span class="mb-1 block text-slate-500">下阶段策略</span>
            <input v-model="form.nextStrategy" class="input" />
          </label>
        </div>
        <p v-if="formError" class="mt-3 text-sm text-rose-600 dark:text-rose-400">{{ formError }}</p>
        <div class="mt-5 flex justify-end gap-2">
          <button @click="showAdd = false" class="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">取消</button>
          <button @click="submitAdd" class="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500">保存</button>
        </div>
      </div>
    </div>

    <!-- 买卖交易弹窗 -->
    <div v-if="showTxn" class="fixed inset-0 z-20 flex items-center justify-center bg-black/40 p-4" @click.self="showTxn = false">
      <div class="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl dark:border-slate-800 dark:bg-slate-900">
        <h2 class="mb-1 text-lg font-semibold text-slate-900 dark:text-white">
          {{ txn.type === 'BUY' ? '买入' : '卖出' }} · {{ txn.name }}
        </h2>
        <p class="mb-4 text-xs text-slate-500">对已有持仓追加交易，系统自动重算成本/数量/最近买入价/状态</p>
        <div class="space-y-3">
          <label class="block text-sm">
            <span class="mb-1 block text-slate-500">价格</span>
            <input v-model="txn.price" type="number" step="0.01" class="input" />
          </label>
          <label class="block text-sm">
            <span class="mb-1 block text-slate-500">数量</span>
            <input v-model="txn.quantity" type="number" step="1" class="input" />
          </label>
          <label class="block text-sm">
            <span class="mb-1 block text-slate-500">日期（可选）</span>
            <input v-model="txn.date" type="date" class="input" />
          </label>
        </div>
        <p v-if="txnError" class="mt-3 text-sm text-rose-600 dark:text-rose-400">{{ txnError }}</p>
        <div class="mt-5 flex justify-end gap-2">
          <button @click="showTxn = false" class="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">取消</button>
          <button
            @click="submitTxn"
            class="rounded-md px-4 py-2 text-sm font-medium text-white"
            :class="txn.type === 'BUY' ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-rose-600 hover:bg-rose-500'"
          >确认{{ txn.type === 'BUY' ? '买入' : '卖出' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.input {
  width: 100%;
  border-radius: 0.5rem;
  border: 1px solid rgb(203 213 225);
  background-color: #fff;
  padding: 0.5rem 0.75rem;
  font-size: 0.875rem;
  color: rgb(15 23 42);
  outline: none;
}
.input:focus {
  border-color: rgb(14 165 233);
  box-shadow: 0 0 0 2px rgb(14 165 233 / 0.25);
}
.dark .input {
  border-color: rgb(51 65 85);
  background-color: rgb(15 23 42);
  color: rgb(226 232 240);
}
</style>
