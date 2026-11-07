<script setup>
// 统一弹窗外壳。
//
// 用原生 <dialog>.showModal()，而不是切 CSS 类名，好处是浏览器直接提供：
//   - 焦点陷阱（Tab 不会跑到背景页面）
//   - ESC 关闭、背景惰性（inert）
//   - ::backdrop 遮罩
// 关闭后把焦点还给打开它的元素；关闭状态的弹窗由 style.css 移出渲染与无障碍树。
import { ref, watch, onMounted, nextTick } from 'vue';

let seq = 0;

const props = defineProps({
  show: { type: Boolean, default: false },
  title: { type: String, default: '' },
  size: { type: String, default: 'md' }, // md | lg | xl
  closable: { type: Boolean, default: true }, // 忙碌中可禁止 ESC / 遮罩 / ×
});
const emit = defineEmits(['close']);

const titleId = `modal-title-${++seq}`;
const dialogEl = ref(null);
const boxEl = ref(null);
const opened = ref(false);
const SIZE = { md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-3xl' };

let lastFocus = null;

function open() {
  const d = dialogEl.value;
  if (!d || !d.isConnected || d.open) return;
  lastFocus = document.activeElement;
  opened.value = true;
  // 极老的浏览器没有 showModal()，退化成属性打开（仍能显示，只是没有焦点陷阱）
  if (typeof d.showModal === 'function') d.showModal();
  else d.setAttribute('open', '');
  // 焦点落在弹窗容器上（读屏会念标题），而不是第一个输入框（手机上会直接弹键盘）
  nextTick(() => boxEl.value?.focus({ preventScroll: true }));
}

function close() {
  const d = dialogEl.value;
  if (!d?.open) return;
  if (typeof d.close === 'function') d.close();
  else d.removeAttribute('open');
}

watch(
  () => props.show,
  (v) => (v ? open() : close())
);
onMounted(() => {
  if (props.show) open();
});

// 所有关闭路径（ESC / × / 遮罩 / 父组件收起）都从这里统一收口
function onNativeClose() {
  opened.value = false;
  lastFocus?.focus?.({ preventScroll: true });
  lastFocus = null;
  if (props.show) emit('close');
}

function onCancel(e) {
  if (!props.closable) e.preventDefault();
}

function onBackdrop() {
  if (props.closable) emit('close');
}
</script>

<template>
  <dialog
    ref="dialogEl"
    class="modal"
    :class="{ 'modal-open': opened }"
    :aria-labelledby="title ? titleId : undefined"
    @close="onNativeClose"
    @cancel="onCancel"
  >
    <div ref="boxEl" class="modal-box outline-none" :class="SIZE[size] || SIZE.md" tabindex="-1">
      <header v-if="title || $slots.header" class="mb-3 flex items-start justify-between gap-3">
        <slot name="header">
          <div class="min-w-0">
            <h2 :id="titleId" class="text-lg font-semibold">{{ title }}</h2>
            <p v-if="$slots.subtitle" class="mt-0.5 text-xs text-muted">
              <slot name="subtitle" />
            </p>
          </div>
        </slot>
        <button
          v-if="closable"
          type="button"
          class="hit-area -mr-1 -mt-1 shrink-0 rounded-full p-1.5 text-base-content/70 transition hover:bg-base-200 hover:text-base-content"
          aria-label="关闭"
          title="关闭"
          @click="emit('close')"
        >
          <svg class="h-5 w-5" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M5 5l10 10M15 5L5 15" />
          </svg>
        </button>
      </header>

      <slot />

      <div v-if="$slots.footer" class="modal-action">
        <slot name="footer" />
      </div>
    </div>
    <div class="modal-backdrop" @click="onBackdrop"></div>
  </dialog>
</template>
