<script setup>
// 「数据」面板：数据放在哪、怎么备份、怎么换设备。
//
// 两种存放位置：
//   local  —— 只写进这台设备的浏览器（IndexedDB），不经过任何服务器。
//   github —— 同样写本机，但额外加密同步到**你自己的私有仓库**，多设备共享。
//
// 本地模式的代价是「清缓存 / 换浏览器 / 换设备」数据就没了，
// 所以这里把「导出备份」做成一等公民，并在久未备份时主动提醒。
import { ref, computed, watch } from 'vue';
import {
  currentMode,
  setMode,
  MODE_LABEL,
  localStore,
  resetLocalCache,
  githubSync,
} from '../services/dataSource.js';
import { downloadText, downloadCsv } from '../core/csv.js';
import { useHoldings } from '../composables/useHoldings.js';
import GitHubSyncPanel from './GitHubSyncPanel.vue';

const props = defineProps({
  show: { type: Boolean, default: false },
});
const emit = defineEmits(['close', 'changed']);

const { exportCsv } = useHoldings();

const mode = ref(currentMode());
const isLocal = computed(() => mode.value === 'local');
const isGithub = computed(() => mode.value === 'github');
// 两种模式都以本机 IndexedDB 为工作副本，备份/导入/回滚都适用
const info = ref(null);
const backups = ref([]);
const csvMsg = ref('');
const msg = ref('');
const err = ref('');
const busy = ref('');

// 导入
const bundle = ref(null);
const fileName = ref('');
const importMode = ref('merge');
const confirmClear = ref('');

const REMIND_DAYS = 7;

const daysSinceExport = computed(() => {
  const t = info.value?.lastExportAt;
  if (!t) return null;
  return Math.floor((Date.now() - new Date(t).getTime()) / 86400000);
});
const needExportRemind = computed(() => {
  const d = daysSinceExport.value;
  return d === null || d >= REMIND_DAYS;
});

function fmtSize(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
function fmtTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}

function reset() {
  msg.value = '';
  err.value = '';
  csvMsg.value = '';
  busy.value = '';
  bundle.value = null;
  fileName.value = '';
  importMode.value = 'merge';
  confirmClear.value = '';
}

async function refresh() {
  try {
    info.value = await localStore.storageInfo();
    backups.value = await localStore.listBackups();
  } catch (e) {
    err.value = e.message;
  }
}

watch(
  () => props.show,
  (v) => {
    if (v) {
      mode.value = currentMode();
      reset();
      refresh();
    }
  }
);

// ---------- 导出 ----------
async function exportBundle() {
  busy.value = '导出中…';
  err.value = '';
  try {
    const b = await localStore.exportBundle();
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    downloadText(`stock-advisor-backup-${stamp}.json`, JSON.stringify(b, null, 2), 'application/json');
    await localStore.markExported();
    msg.value = `已导出 ${b.holdings.length} 条持仓、${b.snapshots.length} 条快照的完整备份`;
    await refresh();
  } catch (e) {
    err.value = e.message;
  } finally {
    busy.value = '';
  }
}

async function exportCsvScope(scope) {
  try {
    await exportCsv(scope);
    csvMsg.value = 'CSV 已开始下载';
  } catch (e) {
    csvMsg.value = e.message;
  }
}

// ---------- 导入 ----------
function pickFile(e) {
  const f = e.target.files?.[0];
  if (!f) return;
  fileName.value = f.name;
  err.value = '';
  const reader = new FileReader();
  reader.onload = () => {
    try {
      bundle.value = localStore.parseBundle(String(reader.result || ''));
    } catch (ex) {
      bundle.value = null;
      err.value = ex.message;
    }
  };
  reader.readAsText(f, 'utf-8');
  e.target.value = ''; // 允许重复选择同一文件
}

async function doImport() {
  if (!bundle.value) return;
  const tip = importMode.value === 'replace'
    ? `确认用文件里的 ${bundle.value.holdings.length} 条持仓「覆盖」本地数据？`
    : `确认把文件里的 ${bundle.value.holdings.length} 条持仓「合并」进本地数据？`;
  if (!confirm(`${tip}\n（执行前会自动留一份本地备份，可在下方回滚）`)) return;
  busy.value = '导入中…';
  err.value = '';
  try {
    const r = await localStore.importBundle(bundle.value, importMode.value);
    resetLocalCache(); // 存储已被外部改写，丢弃内存缓存，避免继续用旧数据
    msg.value = `导入完成：新增 ${r.added} 只，更新 ${r.updated} 只，当前共 ${r.total} 只`;
    bundle.value = null;
    fileName.value = '';
    await refresh();
    emit('changed');
    // JSON 导入绕过 dataSource，直接改了本地存储：云同步模式下显式补一次自动上传
    if (isGithub) githubSync.scheduleAutoPush('导入备份');
  } catch (e) {
    err.value = e.message;
  } finally {
    busy.value = '';
  }
}

// ---------- 备份（版本快照）----------
async function restore(id) {
  if (!confirm('确认回滚到这份备份？当前数据会先被自动备份一份。')) return;
  busy.value = '回滚中…';
  try {
    const r = await localStore.restoreBackup(id);
    resetLocalCache();
    msg.value = `已回滚：持仓 ${r.holdings} 条、快照 ${r.snapshots} 条`;
    await refresh();
    emit('changed');
    // 回滚同样绕过 dataSource，云同步模式下显式补一次自动上传
    if (isGithub) githubSync.scheduleAutoPush('回滚版本');
  } catch (e) {
    err.value = e.message;
  } finally {
    busy.value = '';
  }
}

async function removeBackup(id) {
  if (!confirm('删除这份备份？')) return;
  await localStore.deleteBackup(id);
  await refresh();
}

async function backupNow() {
  await localStore.createBackup('手动备份');
  msg.value = '已创建一份手动备份';
  await refresh();
}

// ---------- 清空 ----------
async function clearAll() {
  if (confirmClear.value !== '清空') return;
  if (!confirm('再次确认：清空本地所有持仓、快照与备份？此操作不可撤销。')) return;
  busy.value = '清空中…';
  try {
    await localStore.clearAll();
    resetLocalCache();
    msg.value = '本地数据已清空';
    confirmClear.value = '';
    await refresh();
    emit('changed');
  } catch (e) {
    err.value = e.message;
  } finally {
    busy.value = '';
  }
}

// ---------- 模式切换 ----------
function switchMode(m) {
  if (m === mode.value) return;
  if (m === 'github' && !githubSync.isConfigured()) {
    // 还没配置就切过去会得到一个空壳：提醒先填仓库，但仍允许进入（配置面板就在下面）
    if (!confirm('切换到「GitHub 私有仓库」需要先填写仓库与令牌。\n现在就切过去并开始配置？')) return;
  }
  setMode(m);
  const label = MODE_LABEL[m];
  if (!confirm(`切换到「${label}」？页面会重新加载。\n两种模式共用同一份本机数据，切换不会删除任何数据。`)) {
    setMode(mode.value); // 用户取消 → 把模式改回去，别留下"已切换但没刷新"的怪状态
    return;
  }
  window.location.reload();
}

function close() {
  if (busy.value) return;
  emit('close');
}
</script>

<template>
  <dialog class="modal" :class="{ 'modal-open': show }">
    <div class="modal-box max-w-3xl">
      <div class="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 class="text-lg font-semibold">数据与备份</h2>
          <p class="mt-0.5 text-xs opacity-60">
            当前模式：<b>{{ MODE_LABEL[mode] }}</b>
            <span v-if="isLocal">· 数据只存在这台设备的浏览器里，不会上传到任何服务器</span>
            <span v-else-if="isGithub">· 本机留一份，加密同步到你自己的私有仓库</span>
          </p>
        </div>
        <button @click="close" class="rounded px-1.5 text-xl leading-none opacity-60 hover:opacity-100" title="关闭">×</button>
      </div>

      <!-- 数据模式 -->
      <section class="mb-4 rounded-xl border border-base-300 p-3">
        <div class="mb-2 text-sm font-medium">数据存放位置</div>
        <div class="grid gap-2 sm:grid-cols-2">
          <button
            @click="switchMode('local')"
            class="rounded-lg border p-3 text-left text-xs transition"
            :class="isLocal ? 'border-primary bg-primary/10' : 'border-base-300 hover:bg-base-200'"
          >
            <div class="text-sm font-semibold">🔒 本地数据</div>
            <div class="mt-1 opacity-70">存在本机浏览器（IndexedDB），零服务器、零上传，隐私最好；但换设备要手动导出导入。</div>
            <div v-if="isLocal" class="mt-1 font-medium text-primary">当前使用中</div>
          </button>
          <button
            @click="switchMode('github')"
            class="rounded-lg border p-3 text-left text-xs transition"
            :class="isGithub ? 'border-primary bg-primary/10' : 'border-base-300 hover:bg-base-200'"
          >
            <div class="text-sm font-semibold">☁️ GitHub 私有仓库</div>
            <div class="mt-1 opacity-70">本机照常离线可用，改动自动加密同步到<b>你自己的私有仓库</b>，手机电脑都能接着用。</div>
            <div v-if="isGithub" class="mt-1 font-medium text-primary">当前使用中</div>
            <div v-else-if="!githubSync.isConfigured()" class="mt-1 text-[11px] opacity-50">未配置</div>
          </button>
        </div>
        <p v-if="isGithub && !githubSync.isConfigured()" class="mt-2 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
          当前是云同步模式，但还没有配置仓库。请在下方填写「用户名 / 仓库名 / 令牌」，否则数据只存在本机。
        </p>
      </section>

      <!-- GitHub 云同步配置（仅在云同步模式下显示） -->
      <GitHubSyncPanel :show="isGithub" @changed="refresh" />

      <!-- 本机数据：备份 / 导入 / 存储概览 -->
      <!-- 概览 -->
      <section v-if="info" class="mb-4 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <div class="rounded-lg bg-base-200 p-2">
          <div class="opacity-60">持仓</div>
          <div class="text-base font-semibold tabular-nums">{{ info.holdingsCount }} 只</div>
        </div>
        <div class="rounded-lg bg-base-200 p-2">
          <div class="opacity-60">快照</div>
          <div class="text-base font-semibold tabular-nums">{{ info.snapshotsCount }} 条</div>
        </div>
        <div class="rounded-lg bg-base-200 p-2">
          <div class="opacity-60">版本备份</div>
          <div class="text-base font-semibold tabular-nums">{{ info.backups }} 份</div>
        </div>
        <div class="rounded-lg bg-base-200 p-2">
          <div class="opacity-60">存储驱动</div>
          <div class="text-base font-semibold">{{ info.driver }}</div>
        </div>
      </section>

      <!-- 备份提醒 -->
      <div v-if="needExportRemind" class="mb-4 rounded-xl border border-warning/50 bg-warning/10 p-3 text-xs">
        <b>该导出备份了。</b>
        <template v-if="isGithub">
          <span v-if="daysSinceExport === null">云同步会保存数据，但导出一份本地存档更保险（令牌失效 / 仓库被删都能救回来）。</span>
          <span v-else>距离上次导出已 {{ daysSinceExport }} 天，建议导出一份留档。</span>
        </template>
        <template v-else>
          <span v-if="daysSinceExport === null">本设备还没有导出过备份，清浏览器数据 / 换设备会导致数据丢失。</span>
          <span v-else>距离上次导出已 {{ daysSinceExport }} 天，建议导出一份留档。或者切到「GitHub 私有仓库」模式自动备份。</span>
        </template>
      </div>

      <!-- 导出 -->
      <section class="mb-4 rounded-xl border border-base-300 p-3">
        <div class="mb-2 text-sm font-medium">导出</div>
        <div class="flex flex-wrap items-center gap-2">
          <button @click="exportBundle" class="btn btn-sm btn-primary" :disabled="!!busy">导出完整备份（JSON）</button>
          <button @click="exportCsvScope('trades')" class="btn btn-sm btn-outline btn-info">交易明细 CSV</button>
          <button @click="exportCsvScope('stats')" class="btn btn-sm btn-outline btn-success">归因统计 CSV</button>
          <button @click="exportCsvScope('snapshots')" class="btn btn-sm btn-outline">每日快照 CSV</button>
        </div>
        <p class="mt-2 text-xs opacity-60">
          完整备份包含持仓、快照与汇率设置，是换设备 / 重装系统的唯一恢复途径；CSV 仅供 Excel 查看。
          <span v-if="info?.lastExportAt">上次导出：{{ fmtTime(info.lastExportAt) }}</span>
        </p>
        <p v-if="csvMsg" class="mt-1 text-xs text-success">{{ csvMsg }}</p>
      </section>

      <!-- 导入 -->
      <section class="mb-4 rounded-xl border border-base-300 p-3">
        <div class="mb-2 text-sm font-medium">导入</div>
        <label class="flex cursor-pointer items-center justify-center rounded-lg border-2 border-dashed border-base-300 p-4 text-center transition hover:border-primary">
          <span class="text-xs">{{ fileName || '点击选择备份 JSON' }}</span>
          <input type="file" accept=".json,application/json" class="hidden" @change="pickFile" />
        </label>

        <div v-if="bundle" class="mt-3 space-y-2 text-xs">
          <div class="rounded-lg bg-base-200 p-2">
            文件解析成功：<b>{{ bundle.holdings.length }}</b> 条持仓
            <span v-if="bundle.snapshots.length">、{{ bundle.snapshots.length }} 条快照</span>
            <span v-if="bundle.exportedAt">（导出于 {{ fmtTime(bundle.exportedAt) }}）</span>
          </div>
          <div class="flex flex-wrap items-center gap-3">
            <label class="flex items-center gap-1.5">
              <input v-model="importMode" type="radio" value="merge" class="radio radio-primary radio-xs" />
              <span>合并（按 市场+代码 去重，记录更完整的一方优先）</span>
            </label>
            <label class="flex items-center gap-1.5">
              <input v-model="importMode" type="radio" value="replace" class="radio radio-error radio-xs" />
              <span>覆盖（用文件完全替换本地数据）</span>
            </label>
          </div>
          <button @click="doImport" class="btn btn-sm btn-info" :disabled="!!busy">开始导入</button>
        </div>
      </section>

      <!-- 版本备份时间线 -->
      <section class="mb-4 rounded-xl border border-base-300 p-3">
        <div class="mb-2 flex items-center justify-between">
          <div class="text-sm font-medium">自动版本快照（最多保留 30 份）</div>
          <button @click="backupNow" class="btn btn-xs btn-ghost">立即备份</button>
        </div>
        <p class="mb-2 text-xs opacity-60">每次交易数据变化前自动留一份，可回滚。回滚本身也会先备份当前状态。</p>
        <div v-if="backups.length" class="max-h-64 space-y-1.5 overflow-y-auto pr-1">
          <div
            v-for="b in backups"
            :key="b.id"
            class="flex items-center justify-between gap-2 rounded-lg bg-base-200 px-2.5 py-1.5 text-xs"
          >
            <div class="min-w-0">
              <div class="truncate">{{ fmtTime(b.at) }}</div>
              <div class="truncate opacity-60">{{ b.reason }} · {{ b.count }} 只 · {{ fmtSize(b.size) }}</div>
            </div>
            <div class="flex shrink-0 gap-1">
              <button @click="restore(b.id)" class="btn btn-xs btn-warning" :disabled="!!busy">回滚</button>
              <button @click="removeBackup(b.id)" class="btn btn-xs btn-ghost">删除</button>
            </div>
          </div>
        </div>
        <div v-else class="rounded-lg border border-dashed border-base-300 p-4 text-center text-xs opacity-50">
          还没有备份（首次修改数据后会自动生成）
        </div>
      </section>

      <!-- 危险区 -->
      <section class="mb-4 rounded-xl border border-error/40 p-3">
        <div class="mb-2 text-sm font-medium text-error">危险操作</div>
        <p class="mb-2 text-xs opacity-70">
          清空本设备浏览器里的全部持仓、快照与备份（不可撤销，建议先导出备份）。
          <span v-if="isGithub" class="text-warning">注意：这只清本机，云端仓库里的文件不会被删除；下次拉取会把数据带回来。</span>
          输入「清空」以确认：
        </p>
        <div class="flex flex-wrap items-center gap-2">
          <input v-model="confirmClear" class="input input-bordered input-xs w-32" placeholder="清空" />
          <button @click="clearAll" class="btn btn-xs btn-error" :disabled="confirmClear !== '清空' || !!busy">清空本地数据</button>
        </div>
      </section>

      <!-- 反馈 -->
      <p v-if="msg" class="mb-2 rounded-lg bg-success/10 px-3 py-2 text-xs text-success">{{ msg }}</p>
      <p v-if="err" class="mb-2 rounded-lg bg-error/10 px-3 py-2 text-xs text-error">{{ err }}</p>

      <div class="modal-action">
        <span v-if="busy" class="mr-auto text-xs opacity-60">{{ busy }}</span>
        <button @click="close" class="btn btn-sm btn-primary" :disabled="!!busy">关闭</button>
      </div>
    </div>
    <form class="modal-backdrop" @click="close"></form>
  </dialog>
</template>
