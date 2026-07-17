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

const emit = defineEmits(['toggle-theme', 'refresh', 'test-feishu', 'add']);
</script>

<template>
  <header class="sticky top-0 z-10 border-b border-base-300 bg-base-100/80 backdrop-blur">
    <div class="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
      <div>
        <h1 class="text-xl font-semibold tracking-tight">📈 股票秘书</h1>
        <p class="mt-0.5 text-xs opacity-60">
          持仓 · 实时行情 · 飞书阈值提醒
          <span v-if="lastUpdated" class="ml-2">· 更新于 {{ lastUpdated }}</span>
          <span v-if="loading" class="ml-2 text-info">刷新中…</span>
          <span class="ml-2 inline-flex items-center gap-1 opacity-60">
            · {{ countdown }} 秒后刷新
            <RefreshRing :ring-c="ringC" :offset="ringOffset" />
          </span>
        </p>
      </div>
      <div class="flex items-center gap-2">
        <span v-if="error" class="text-xs text-error">{{ error }}</span>
        <button
          @click="emit('toggle-theme')"
          :title="isDark ? '切换到浅色' : '切换到深色'"
          class="btn btn-ghost btn-circle btn-sm"
        >{{ isDark ? '☀️' : '🌙' }}</button>
        <button @click="emit('refresh')" class="btn btn-info btn-sm">刷新</button>
        <button
          @click="emit('test-feishu')"
          :disabled="testing"
          :title="testing ? '发送中…' : '向飞书机器人发送一条测试消息'"
          class="btn btn-warning btn-sm"
        >{{ testing ? '发送中…' : '测试飞书' }}</button>
        <button @click="emit('add')" class="btn btn-primary btn-sm">+ 添加持仓</button>
        <span
          v-if="testMsg"
          class="text-xs"
          :class="testMsg.includes('✓') ? 'text-success' : 'text-error'"
        >{{ testMsg }}</span>
      </div>
    </div>
  </header>
</template>
