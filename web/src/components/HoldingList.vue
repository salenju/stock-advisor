<script setup>
import HoldingCard from './HoldingCard.vue';

defineProps({
  holdings: { type: Array, default: () => [] },
});

const emit = defineEmits(['open-txn', 'open-add-buy', 'edit-buy', 'delete-buy']);

// 把事件带上对应的持仓对象向上透传
function forward(event, holding, payload) {
  emit(event, holding, payload);
}
</script>

<template>
  <div class="space-y-4">
    <HoldingCard
      v-for="h in holdings"
      :key="h.id"
      :holding="h"
      @open-txn="(type) => forward('open-txn', h, type)"
      @open-add-buy="forward('open-add-buy', h)"
      @edit-buy="(p) => forward('edit-buy', h, p)"
      @delete-buy="(p) => forward('delete-buy', h, p)"
    />

    <div
      v-if="!holdings.length"
      class="rounded-xl border border-dashed border-base-300 p-10 text-center opacity-40"
    >
      暂无持仓，点击右上角「添加持仓」开始记录
    </div>
  </div>
</template>
