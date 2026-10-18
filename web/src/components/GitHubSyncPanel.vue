<script setup>
// GitHub 私有仓库云同步配置面板。
//
// 设计要点（安全）：
//   - 仓库必须是**私有**的：数据进了公开仓库就等于公开了，这里会主动检测并拦住。
//   - 访问令牌用 Fine-grained PAT，只给这一个仓库的 Contents 读写权限，最小化风险。
//   - 令牌与加密口令都只存在本机 localStorage，不上传任何地方；口令不会发给 GitHub。
//   - 口令是可选的：填了就先在本机 AES-GCM 加密再上传，GitHub 上只有密文。
//     代价是口令忘了就解不开（没有找回途径），所以面板里反复提示。
import { ref, computed, watch } from 'vue';
import { githubSync, resetLocalCache } from '../services/dataSource.js';
import { useHoldings } from '../composables/useHoldings.js';

const props = defineProps({
  show: { type: Boolean, default: false },
});
const emit = defineEmits(['changed']);

const { fetchHoldings } = useHoldings();

const cfg = ref(githubSync.loadConfig());
const state = ref(githubSync.syncState());
const busy = ref('');
const msg = ref('');
const err = ref('');
const testResult = ref(null);
const showToken = ref(false);
const showPassphrase = ref(false);
const dirty = ref(false);

// 首次配置向导：三个步骤的完成状态，给用户明确的下一步
const stepRepo = computed(() => !!(cfg.value.owner && cfg.value.repo));
const stepToken = computed(() => !!cfg.value.token);
const stepTested = computed(() => !!testResult.value);
const ready = computed(() => stepRepo.value && stepToken.value);

const filePath = computed(() => githubSync.loadConfig().path || 'stock-advisor-data.json');

function fmtTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}

function loadAll() {
  cfg.value = githubSync.loadConfig();
  state.value = githubSync.syncState();
}

watch(
  () => props.show,
  (v) => {
    if (!v) return;
    loadAll();
    msg.value = '';
    err.value = '';
    testResult.value = null;
    dirty.value = false;
  },
  { immediate: true }
);

function onEdit() {
  dirty.value = true;
  testResult.value = null;
  err.value = '';
  msg.value = '';
}

function save() {
  try {
    githubSync.saveConfig({
      owner: cfg.value.owner.trim(),
      repo: cfg.value.repo.trim(),
      path: cfg.value.path.trim() || 'stock-advisor-data.json',
      branch: cfg.value.branch.trim() || 'main',
      token: cfg.value.token.trim(),
      passphrase: cfg.value.passphrase, // 空字符串表示不加密
      autoPush: !!cfg.value.autoPush,
    });
    dirty.value = false;
    msg.value = '配置已保存到本机浏览器';
    loadAll();
  } catch (e) {
    err.value = e.message;
  }
}

async function test() {
  save();
  busy.value = '测试连接中…';
  err.value = '';
  msg.value = '';
  testResult.value = null;
  try {
    const r = await githubSync.testConnection(githubSync.loadConfig());
    testResult.value = r;
    if (!r.private) {
      err.value = `警告：仓库 ${r.repo} 是「公开」的。请把仓库改成 Private，否则你的持仓数据会对外可见。`;
    } else {
      msg.value = `连接成功：${r.repo}（私有）· 默认分支 ${r.defaultBranch} · ${r.fileExists ? '云端已有数据文件' : '云端还没有数据文件（首次同步会创建）'}`;
    }
  } catch (e) {
    err.value = e.message;
  } finally {
    busy.value = '';
  }
}

async function pushNow() {
  save();
  busy.value = '上传中…';
  err.value = '';
  msg.value = '';
  try {
    const r = await githubSync.push({ reason: '手动上传', force: true }, githubSync.loadConfig());
    state.value = githubSync.syncState();
    msg.value = `已上传到 ${cfg.value.owner}/${cfg.value.repo} · ${cfg.value.path}${r.sha ? `（${r.sha.slice(0, 7)}）` : ''}`;
    dirty.value = false;
  } catch (e) {
    err.value = e.message;
  } finally {
    busy.value = '';
  }
}

async function pullNow() {
  const ok = confirm(
    '从云端拉取会把云端数据「合并」进本机（按 市场+代码 去重，交易记录更完整的一方优先）。\n本机多出来的持仓不会被删除。继续？'
  );
  if (!ok) return;
  save();
  busy.value = '拉取中…';
  err.value = '';
  msg.value = '';
  try {
    const r = await githubSync.pull(githubSync.loadConfig());
    if (r.empty) {
      msg.value = '云端还没有数据文件，请先点「上传到云端」创建';
    } else {
      resetLocalCache();
      await fetchHoldings();
      emit('changed');
      msg.value = `拉取完成：新增 ${r.added} 只、更新 ${r.updated} 只，本机现有 ${r.total} 只${r.encrypted ? '（已解密）' : ''}`;
    }
    state.value = githubSync.syncState();
  } catch (e) {
    err.value = e.message;
  } finally {
    busy.value = '';
  }
}

async function syncBoth() {
  save();
  busy.value = '双向同步中…';
  err.value = '';
  msg.value = '';
  try {
    const r = await githubSync.syncNow(githubSync.loadConfig());
    resetLocalCache();
    await fetchHoldings();
    emit('changed');
    const pulled = r.pulled ? `云端新增 ${r.pulled.added} 只、更新 ${r.pulled.updated} 只；` : '';
    msg.value = `同步完成：${pulled}已写回云端（${r.direction === 'merge' ? '合并后上传' : '本地覆盖上传'}）`;
    state.value = githubSync.syncState();
  } catch (e) {
    err.value = e.message;
  } finally {
    busy.value = '';
  }
}

function forget() {
  if (!confirm('删除本机保存的 GitHub 配置与令牌？（云端文件不会动，下次需要重新填写）')) return;
  githubSync.clearConfig();
  loadAll();
  testResult.value = null;
  msg.value = '已清除本机的 GitHub 配置';
}
</script>

<template>
  <section v-if="show" class="mb-4 rounded-xl border border-base-300 p-3">
    <div class="mb-2 flex items-center justify-between gap-2">
      <div class="text-sm font-medium">☁️ 同步到 GitHub 私有仓库</div>
      <span
        v-if="ready"
        class="rounded-full px-2 py-0.5 text-[11px]"
        :class="state.lastError ? 'bg-error/15 text-error' : 'bg-success/15 text-success'"
      >{{ state.lastError ? '上次同步失败' : state.lastSyncAt ? '已配置' : '待首次同步' }}</span>
    </div>

    <p class="mb-3 text-xs opacity-70">
      把持仓数据存进<b>你自己的私有仓库</b>里的一个文件，手机和电脑登录同一个仓库即可共享；
      别人看不到，也不需要任何第三方服务器。令牌与口令只存在这台设备的浏览器里。
    </p>

    <!-- 三步引导 -->
    <ol class="mb-3 space-y-1 text-[11px] opacity-60">
      <li :class="stepRepo ? 'text-success' : ''">① 填入仓库的 用户名 / 仓库名</li>
      <li :class="stepToken ? 'text-success' : ''">② 生成 Fine-grained 令牌（仅勾选该仓库的 Contents: Read and write）</li>
      <li :class="stepTested ? 'text-success' : ''">③ 点「测试连接」确认仓库是私有的、令牌能用</li>
    </ol>

    <!-- 表单 -->
    <div class="grid gap-2 text-xs sm:grid-cols-2">
      <label class="block">
        <span class="mb-0.5 block opacity-70">用户名 / 组织</span>
        <input v-model="cfg.owner" @input="onEdit" class="input input-bordered input-sm w-full" placeholder="例如 salenju" autocomplete="off" />
      </label>
      <label class="block">
        <span class="mb-0.5 block opacity-70">私有仓库名</span>
        <input v-model="cfg.repo" @input="onEdit" class="input input-bordered input-sm w-full" placeholder="例如 stock-data" autocomplete="off" />
      </label>
      <label class="block">
        <span class="mb-0.5 block opacity-70">文件路径</span>
        <input v-model="cfg.path" @input="onEdit" class="input input-bordered input-sm w-full" placeholder="stock-advisor-data.json" autocomplete="off" />
      </label>
      <label class="block">
        <span class="mb-0.5 block opacity-70">分支</span>
        <input v-model="cfg.branch" @input="onEdit" class="input input-bordered input-sm w-full" placeholder="main" autocomplete="off" />
      </label>

      <label class="block sm:col-span-2">
        <span class="mb-0.5 block opacity-70">访问令牌（Fine-grained PAT，只存本机）</span>
        <div class="flex gap-1.5">
          <input
            v-model="cfg.token"
            @input="onEdit"
            :type="showToken ? 'text' : 'password'"
            class="input input-bordered input-sm w-full font-mono"
            placeholder="github_pat_..."
            autocomplete="off"
            spellcheck="false"
          />
          <button @click="showToken = !showToken" class="btn btn-xs btn-ghost shrink-0">{{ showToken ? '隐藏' : '显示' }}</button>
        </div>
      </label>

      <label class="block sm:col-span-2">
        <span class="mb-0.5 block opacity-70">加密口令（可选，强烈建议填）</span>
        <div class="flex gap-1.5">
          <input
            v-model="cfg.passphrase"
            @input="onEdit"
            :type="showPassphrase ? 'text' : 'password'"
            class="input input-bordered input-sm w-full"
            placeholder="留空 = 明文存储（仅靠仓库私有性保护）"
            autocomplete="new-password"
          />
          <button @click="showPassphrase = !showPassphrase" class="btn btn-xs btn-ghost shrink-0">{{ showPassphrase ? '隐藏' : '显示' }}</button>
        </div>
        <span class="mt-1 block text-[11px] text-warning">
          填了口令后，GitHub 上只有密文（AES-GCM），但要记住口令——忘记后无法恢复，只能重新上传。
        </span>
      </label>

      <label class="flex items-center gap-2 sm:col-span-2">
        <input v-model="cfg.autoPush" @change="onEdit" type="checkbox" class="checkbox checkbox-primary checkbox-xs" />
        <span>数据有改动时自动上传（合并 1.5 秒内的连续操作，避免刷出一堆提交）</span>
      </label>
    </div>

    <!-- 操作 -->
    <div class="mt-3 flex flex-wrap items-center gap-2">
      <button @click="save" class="btn btn-sm" :disabled="!!busy || !dirty">保存配置</button>
      <button @click="test" class="btn btn-sm btn-info" :disabled="!!busy || !ready">测试连接</button>
      <button @click="syncBoth" class="btn btn-sm btn-primary" :disabled="!!busy || !ready || !testResult || !testResult.private">双向同步</button>
      <button @click="pushNow" class="btn btn-sm btn-outline btn-primary" :disabled="!!busy || !ready || !testResult || !testResult.private">上传到云端</button>
      <button @click="pullNow" class="btn btn-sm btn-outline" :disabled="!!busy || !ready">从云端拉取</button>
      <button @click="forget" class="btn btn-sm btn-ghost text-error" :disabled="!!busy">清除本机配置</button>
      <span v-if="busy" class="text-xs opacity-60">{{ busy }}</span>
    </div>

    <!-- 状态 -->
    <div v-if="state.lastSyncAt || state.lastError" class="mt-2 rounded-lg bg-base-200 px-3 py-2 text-[11px] leading-relaxed">
      <div>上次同步：{{ fmtTime(state.lastSyncAt) }} <span v-if="state.lastDirection">（{{ state.lastDirection }}）</span></div>
      <div v-if="!state.lastError" class="opacity-70">云端文件：<code>{{ cfg.owner }}/{{ cfg.repo }} · {{ filePath }}</code></div>
      <div v-if="state.lastError" class="text-error">上次失败：{{ state.lastError }}</div>
    </div>

    <p v-if="msg" class="mt-2 rounded-lg bg-success/10 px-3 py-2 text-xs text-success">{{ msg }}</p>
    <p v-if="err" class="mt-2 rounded-lg bg-error/10 px-3 py-2 text-xs text-error">{{ err }}</p>

    <!-- 详细帮助 -->
    <details class="mt-3 text-[11px] opacity-70">
      <summary class="cursor-pointer select-none">怎么生成令牌？（30 秒）</summary>
      <ol class="ml-4 mt-1.5 list-decimal space-y-0.5 leading-relaxed">
        <li>打开 <a class="link" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token</a></li>
        <li>Repository access 选 <b>Only select repositories</b>，只勾选这个私有仓库</li>
        <li>Permissions → Repository permissions → <b>Contents</b> 设为 <b>Read and write</b></li>
        <li>生成后复制 <code>github_pat_...</code> 填到上面（只显示一次）</li>
        <li>如果仓库还不存在：先在 GitHub 上建一个 <b>Private</b> 空仓库，并勾选初始化 README</li>
      </ol>
    </details>
  </section>
</template>
