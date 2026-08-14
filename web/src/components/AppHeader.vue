<script setup>
import RefreshRing from './RefreshRing.vue';

defineProps({
  lastUpdated: { type: String, default: '' },
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' },
  countdown: { type: Number, default: 0 },
  isDark: { type: Boolean, default: true },
  testing: { type: Boolean, default: false },
  testMsg: { type: String, default: '' },
  ringC: { type: Number, required: true },
  ringOffset: { type: Number, required: true },
});

const emit = defineEmits(['toggle-theme', 'refresh', 'test-feishu', 'add', 'import-csv']);
</script>

<template>
  <header class="sticky top-0 z-10 border-b border-base-300 bg-base-100/80 backdrop-blur">
    <div class="mx-auto flex max-w-7xl flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:py-4">
      <div class="min-w-0">
        <h1 class="text-lg font-semibold tracking-tight sm:text-xl">📈 股票秘书</h1>
        <p class="mt-0.5 truncate text-xs opacity-60">
          持仓 · 实时行情 · 飞书阈值提醒
          <span v-if="lastUpdated" class="ml-2 hidden sm:inline">· 更新于 {{ lastUpdated }}</span>
          <span v-if="loading" class="ml-2 text-info">刷新中…</span>
          <span class="ml-2 inline-flex items-center gap-1 opacity-60">
            · {{ countdown }} 秒后刷新
            <RefreshRing :ring-c="ringC" :offset="ringOffset" />
          </span>
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-1.5 sm:gap-2">
        <span v-if="error" class="w-full text-xs text-error sm:w-auto">{{ error }}</span>
        <button
          @click="emit('toggle-theme')"
          :title="isDark ? '切换到浅色' : '切换到深色'"
          class="btn btn-ghost btn-circle btn-xs sm:btn-sm"
        >{{ isDark ? '☀️' : '🌙' }}</button>
        <button
          @click="emit('import-csv')"
          class="btn btn-xs text-white sm:btn-sm"
          style="background-color: #f40; border-color: #f40;"
          title="导入 CSV 买卖记录"
        >导入 CSV</button>
        <button @click="emit('refresh')" class="btn btn-info btn-xs sm:btn-sm">刷新</button>
        <button
          @click="emit('test-feishu')"
          :disabled="testing"
          :title="testing ? '发送中…' : '向飞书机器人发送一条测试消息'"
          class="btn btn-warning btn-xs sm:btn-sm"
        >{{ testing ? '发送中…' : '测试飞书' }}</button>
        <button @click="emit('add')" class="btn btn-primary btn-xs sm:btn-sm">+ 添加持仓</button>
        <span
          v-if="testMsg"
          class="text-xs"
          :class="testMsg.includes('✓') ? 'text-success' : 'text-error'"
        >{{ testMsg }}</span>
      </div>
    </div>
  </header>
</template>
