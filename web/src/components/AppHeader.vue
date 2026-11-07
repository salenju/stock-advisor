<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import RefreshRing from './RefreshRing.vue';
import AppIcon from './AppIcon.vue';

defineProps({
  lastUpdated: { type: String, default: '' },
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' },
  countdown: { type: Number, default: 0 },
  isDark: { type: Boolean, default: true },
  canInstall: { type: Boolean, default: false },
  mode: { type: String, default: 'local' },
  modeLabel: { type: String, default: '' },
  modeTitle: { type: String, default: '' },
  ringC: { type: Number, required: true },
  ringOffset: { type: Number, required: true },
});

const emit = defineEmits(['toggle-theme', 'refresh', 'add', 'import-csv', 'install', 'open-data']);

// 手机上按钮太多会挤成两三行，把低频操作收进「更多」菜单。
// 桌面端（sm 及以上）仍然全部平铺，菜单不参与布局。
const moreOpen = ref(false);
const moreRef = ref(null);

function fire(name) {
  moreOpen.value = false;
  emit(name);
}

function onDocClick(e) {
  if (!moreOpen.value) return;
  if (moreRef.value && !moreRef.value.contains(e.target)) moreOpen.value = false;
}
function onKeydown(e) {
  if (e.key === 'Escape') moreOpen.value = false;
}

onMounted(() => {
  document.addEventListener('click', onDocClick, true);
  document.addEventListener('keydown', onKeydown);
});
onUnmounted(() => {
  document.removeEventListener('click', onDocClick, true);
  document.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <header class="sticky top-0 z-20 border-b border-base-300 bg-base-100/90 backdrop-blur">
    <!-- 顶部留白适配 iPhone 刘海（PWA 全屏时尤其重要） -->
    <div class="mx-auto max-w-7xl px-3 py-2.5 sm:px-6 sm:py-4" style="padding-top: max(0.625rem, env(safe-area-inset-top))">
      <div class="flex items-center justify-between gap-2">
        <div class="min-w-0 flex-1">
          <h1 class="flex items-center gap-1.5 text-base font-semibold tracking-tight sm:text-xl">
            <AppIcon name="chart" :size="18" class="text-primary" />
            <span class="truncate">股票秘书</span>
            <span
              v-if="modeLabel"
              class="inline-flex shrink-0 items-center gap-1 rounded-full bg-base-200 px-2 py-0.5 text-[10px] font-medium sm:text-[11px]"
              :title="modeTitle || modeLabel"
            >
              <AppIcon :name="mode === 'github' ? 'cloud' : 'lock'" :size="11" />
              {{ modeLabel }}
            </span>
          </h1>
          <p class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted sm:text-xs">
            <span class="hidden sm:inline">持仓 · 实时行情 · 复盘统计</span>
            <span v-if="lastUpdated" class="hidden sm:inline">· 更新于 {{ lastUpdated }}</span>
            <span v-if="loading" class="text-info">刷新中…</span>
            <span class="inline-flex items-center gap-1">
              · {{ countdown }}s
              <RefreshRing :ring-c="ringC" :offset="ringOffset" />
            </span>
          </p>
        </div>

        <!-- 主操作：手机与桌面都显示 -->
        <div class="flex shrink-0 items-center gap-1.5">
          <button
            @click="emit('refresh')"
            class="btn btn-sm px-2.5 sm:px-4"
            :disabled="loading"
            title="立即刷新行情"
          >刷新</button>
          <button
            @click="emit('open-data')"
            class="btn btn-sm gap-1.5 px-2.5 sm:px-4"
            title="数据存放位置、云同步、导出备份、导入与回滚"
          >
            <AppIcon name="database" :size="16" />
            <span>数据</span>
          </button>
          <button @click="emit('add')" class="btn btn-primary btn-sm px-2.5 sm:px-4">+ 添加</button>

          <!-- 次级操作：手机收进菜单；桌面平铺 -->
          <div class="hidden items-center gap-1.5 sm:flex">
            <button
              v-if="canInstall"
              @click="emit('install')"
              class="btn btn-accent btn-sm gap-1.5"
              title="把「股票秘书」安装到桌面 / 主屏幕，像 App 一样打开"
            >
              <AppIcon name="install" :size="16" />
              <span>安装 App</span>
            </button>
            <button
              @click="emit('toggle-theme')"
              :title="isDark ? '切换到浅色模式' : '切换到深色模式'"
              :aria-label="isDark ? '切换到浅色模式' : '切换到深色模式'"
              class="btn btn-ghost btn-circle btn-sm hit-area"
            >
              <AppIcon :name="isDark ? 'sun' : 'moon'" :size="18" />
            </button>
            <button
              @click="emit('import-csv')"
              class="btn btn-sm gap-1.5"
              title="导入 CSV 买卖记录"
            >
              <AppIcon name="upload" :size="16" />
              <span>导入 CSV</span>
            </button>
          </div>

          <!-- 手机端「更多」 -->
          <div ref="moreRef" class="relative sm:hidden">
            <button
              @click="moreOpen = !moreOpen"
              class="btn btn-ghost btn-sm px-2"
              :class="{ 'btn-active': moreOpen }"
              title="更多操作"
              aria-label="更多操作"
            >⋯</button>
            <ul
              v-if="moreOpen"
              class="absolute right-0 top-full z-30 mt-1 w-40 overflow-hidden rounded-lg border border-base-300 bg-base-100 py-1 text-sm shadow-xl"
            >
              <li v-if="canInstall">
                <button @click="fire('install')" class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-base-200">
                  <AppIcon name="install" :size="16" /> 安装 App
                </button>
              </li>
              <li>
                <button @click="fire('toggle-theme')" class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-base-200">
                  <AppIcon :name="isDark ? 'sun' : 'moon'" :size="16" />
                  {{ isDark ? '浅色模式' : '深色模式' }}
                </button>
              </li>
              <li>
                <button @click="fire('import-csv')" class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-base-200">
                  <AppIcon name="upload" :size="16" /> 导入 CSV
                </button>
              </li>
            </ul>
          </div>
        </div>
      </div>

      <!-- 错误：单独一行，避免挤坏按钮 -->
      <p v-if="error" class="mt-1.5 text-[11px] leading-snug text-error sm:text-xs">{{ error }}</p>
    </div>
  </header>
</template>
