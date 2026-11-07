// 浏览器桌面通知（页面级提醒）。
//
// 能力边界（重要，UI 文案里也要体现）：
//   - 只能在本页开着的时候触发：纯静态站没有后台进程，标签页关了就没有提醒；
//     要做到「人不在也收到」，用 GitHub Actions 定时任务推送飞书（见 docs/飞书定时提醒配置.md）。
//   - 需要 HTTPS（GitHub Pages 满足）且用户授权；iOS 只对「已添加到主屏幕」的 PWA 生效。
//   - 去重：同一持仓 + 同一种提醒，当天只发一次（记录在 localStorage，跨天自动清空）。
import { ref, computed } from 'vue';
import { loadSettings, saveSettings } from '../store/localStore.js';
import { buildAlerts, selectNewAlerts, markAlertsSent, today, summarize } from '../core/alerts.js';

const LS_SENT = 'stock-advisor:notify-sent';
const LS_TIP = 'stock-advisor:notify-tip-dismissed';

export function notifySupported() {
  try {
    return typeof Notification !== 'undefined';
  } catch {
    return false;
  }
}

function currentPermission() {
  if (!notifySupported()) return 'unsupported';
  return Notification.permission || 'default';
}

// ---------- 模块级单例状态（App / 数据面板共用一份） ----------
const permission = ref(currentPermission());
const enabled = ref(true); // 对应 settings.notify.browser
const nearPct = ref(2);
const alerts = ref([]); // 最近命中的提醒，供页面内兜底展示
const flash = ref(''); // 一次性提示（"已推送 N 条通知"之类）
const tipDismissed = ref(readTipDismissed());
const ready = ref(false);

const tipVisible = computed(
  () => !tipDismissed.value && enabled.value && permission.value === 'default'
);

function readSent() {
  try {
    return JSON.parse(localStorage.getItem(LS_SENT) || '{}') || {};
  } catch {
    return {};
  }
}
function writeSent(map) {
  try {
    localStorage.setItem(LS_SENT, JSON.stringify(map));
  } catch {
    /* 隐私模式：忽略，退化为每次都提醒 */
  }
}
function readTipDismissed() {
  try {
    return localStorage.getItem(LS_TIP) === '1';
  } catch {
    return false;
  }
}

function iconUrl() {
  const base = (import.meta.env && import.meta.env.BASE_URL) || '/';
  return `${base}icon-192.png`;
}

/** 读取设置 + 刷新权限状态（幂等，可在挂载时调用） */
export async function initNotify() {
  if (ready.value) {
    permission.value = currentPermission();
    return;
  }
  try {
    const s = await loadSettings();
    enabled.value = s?.notify?.browser !== false; // 默认开；未授权时静默
    nearPct.value = Number(s?.notify?.nearThresholdPct) >= 0 ? Number(s.notify.nearThresholdPct) : 2;
  } catch {
    /* 读设置失败：用默认值继续 */
  }
  permission.value = currentPermission();
  ready.value = true;
}

/** 请求通知权限（必须由用户点击触发） */
export async function requestNotifyPermission() {
  if (!notifySupported()) return 'unsupported';
  let next = 'denied';
  try {
    next = await Notification.requestPermission();
  } catch {
    next = Notification.permission || 'denied';
  }
  permission.value = next;
  if (next === 'granted') await setEnabled(true);
  return next;
}

export async function setEnabled(on) {
  enabled.value = !!on;
  try {
    await saveSettings({ notify: { browser: !!on } });
  } catch {
    /* 存不上也不影响本次会话 */
  }
}

function pushOne(a) {
  try {
    const n = new Notification(a.title, {
      body: a.body,
      tag: a.key, // 同一提醒重复出现时替换而不是堆叠
      icon: iconUrl(),
      badge: iconUrl(),
      silent: false,
    });
    // 点击通知：把窗口拉到前台（部分浏览器只允许 focus）
    n.onclick = () => {
      try {
        window.focus();
        n.close();
      } catch {
        /* 忽略 */
      }
    };
    return true;
  } catch {
    // iOS 未安装到主屏等环境：构造函数直接抛错，退回页内提示
    return false;
  }
}

function deliver(list) {
  if (permission.value !== 'granted') return 0;
  const head = list.slice(0, 3);
  let sent = 0;
  for (const a of head) if (pushOne(a)) sent += 1;
  if (list.length > head.length) {
    const rest = list.slice(head.length);
    if (pushOne({ key: 'digest', title: `还有 ${rest.length} 条提醒`, body: summarize(rest) })) sent += 1;
  }
  return sent;
}

/**
 * 检查并推送提醒（由页面刷新行情后调用）。
 * @param {Array} holdings 带 currentPrice 的持仓列表
 * @returns {Promise<Array>} 本轮新增的提醒
 */
export async function checkAlerts(holdings) {
  if (!ready.value) await initNotify();
  if (!enabled.value) return [];
  if (!Array.isArray(holdings) || !holdings.length) return [];

  const day = today();
  const all = buildAlerts(holdings, { nearThresholdPct: nearPct.value });
  if (!all.length) {
    // 条件全部解除：把页面上的提醒条一并收掉
    if (alerts.value.length) alerts.value = [];
    return [];
  }

  const fresh = selectNewAlerts(all, readSent(), day);
  // 只在有「今天还没提醒过」的新命中时才刷新提醒条：
  // 这样用户点 × 关掉之后，只要条件没变化就不会被同一个提醒反复弹出。
  if (fresh.length) alerts.value = fresh.slice(0, 5);
  if (!fresh.length) return [];

  const sent = deliver(fresh);
  writeSent(markAlertsSent(readSent(), fresh, day));
  flash.value = sent ? `已推送 ${sent} 条通知` : '';
  if (flash.value) setTimeout(() => (flash.value = ''), 6000);
  return fresh;
}

/** 手动发一条测试通知（验证权限与系统通知开关） */
export function sendTestNotification() {
  if (permission.value !== 'granted') return false;
  return pushOne({
    key: `test|${Date.now()}`,
    title: '测试提醒 · 股票秘书',
    body: '能看到这条说明桌面通知可用。价格触及止盈/止损/补仓阈值时会收到同类提醒。',
  });
}

export function clearAlerts() {
  alerts.value = [];
}

export function dismissTip() {
  tipDismissed.value = true;
  try {
    localStorage.setItem(LS_TIP, '1');
  } catch {
    /* 忽略 */
  }
}

/** 供「数据」面板重置提示（调试/手滑关掉后想再看到） */
export function resetTip() {
  tipDismissed.value = false;
  try {
    localStorage.removeItem(LS_TIP);
  } catch {
    /* 忽略 */
  }
}

export function useNotify() {
  return {
    permission,
    enabled,
    alerts,
    flash,
    tipVisible,
    supported: notifySupported(),
    initNotify,
    requestNotifyPermission,
    setEnabled,
    checkAlerts,
    sendTestNotification,
    clearAlerts,
    dismissTip,
    resetTip,
  };
}
