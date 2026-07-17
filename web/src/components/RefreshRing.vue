<script setup>
// 倒计时环形进度：随倒计时从满圈递减到空圈
const props = defineProps({
  ringC: { type: Number, required: true }, // 周长 2πr
  offset: { type: Number, required: true }, // 描边偏移
});
</script>

<template>
  <svg class="h-4 w-4 -rotate-90" viewBox="0 0 16 16">
    <circle
      cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="2"
      class="text-base-content opacity-20"
    />
    <circle
      cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="2"
      class="text-primary"
      stroke-linecap="round"
      :stroke-dasharray="ringC"
      :stroke-dashoffset="offset"
    />
  </svg>
</template>
