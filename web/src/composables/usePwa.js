import { ref, computed } from 'vue';

/**
 * PWA 安装能力封装。
 *
 * - Chrome / Edge / Android：浏览器触发 `beforeinstallprompt`，可调起系统安装弹窗。
 * - iOS Safari：没有安装提示 API，只能引导用户「分享 → 添加到主屏幕」。
 * - 已在独立窗口运行（已安装）或浏览器不支持时，不展示安装入口。
 *
 * @example
 * const { canInstall, showIosGuide, init, install } = usePwa();
 * onMounted(init);
 * // 按钮：v-if="canInstall" @click="install"
 */
const deferredPrompt = ref(null);       // 浏览器缓存的安装事件（只能使用一次）
const isStandalone = ref(false);        // 是否已作为 App（独立窗口）运行
const isIosDevice = ref(false);         // 是否 iOS/iPadOS
const dismissKey = 'pwa-ios-tip-dismissed';
const tipDismissed = ref(false);
let bound = false;

function detectStandalone() {
  const mm = window.matchMedia?.('(display-mode: standalone)').matches;
  const iosStandalone = window.navigator.standalone === true; // iOS Safari 专有
  isStandalone.value = Boolean(mm || iosStandalone);
}

function detectIos() {
  const ua = window.navigator.userAgent || '';
  const iPadOs = window.navigator.platform === 'MacIntel' && window.navigator.maxTouchPoints > 1;
  isIosDevice.value = /iphone|ipad|ipod/i.test(ua) || iPadOs;
}

function init() {
  if (bound || typeof window === 'undefined') return;
  bound = true;

  detectStandalone();
  detectIos();
  tipDismissed.value = localStorage.getItem(dismissKey) === '1';

  // 已安装（独立窗口）时隐藏入口
  window.matchMedia?.('(display-mode: standalone)')?.addEventListener?.('change', detectStandalone);

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();               // 拦截默认迷你提示条，改由页面按钮触发
    deferredPrompt.value = e;
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt.value = null;
    isStandalone.value = true;
  });
}

/** 调起浏览器原生安装弹窗；无可用事件时返回 false（需走 iOS 手动引导） */
async function install() {
  const prompt = deferredPrompt.value;
  if (!prompt) return false;
  try {
    prompt.prompt();
    const { outcome } = await prompt.userChoice;
    deferredPrompt.value = null;      // 事件不可复用
    return outcome === 'accepted';
  } catch {
    return false;
  }
}

function dismissIosTip() {
  tipDismissed.value = true;
  localStorage.setItem(dismissKey, '1');
}

export function usePwa() {
  const canInstall = computed(() => !!deferredPrompt.value && !isStandalone.value);
  // iOS 无原生入口：未安装且未关闭过引导时，展示「添加到主屏幕」提示
  const showIosGuide = computed(
    () => isIosDevice.value && !isStandalone.value && !tipDismissed.value && !deferredPrompt.value
  );

  return {
    isStandalone,
    isIosDevice,
    canInstall,
    showIosGuide,
    init,
    install,
    dismissIosTip,
  };
}
