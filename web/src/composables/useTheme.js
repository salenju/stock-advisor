import { ref } from 'vue';

const isDark = ref(true);

// 浏览器/系统 UI 的主题色需与页面底色保持一致（移动端地址栏、状态栏）
function syncThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', isDark.value ? '#171717' : '#ffffff');
}

function applyTheme() {
  document.documentElement.dataset.theme = isDark.value ? 'stockdark' : 'stocklight';
  document.documentElement.classList.toggle('dark', isDark.value);
  syncThemeColor();
}

function initTheme() {
  const saved = localStorage.getItem('theme');
  // 默认深色（与历史行为一致）
  isDark.value = saved ? saved === 'dark' : true;
  applyTheme();
}

function toggleTheme() {
  isDark.value = !isDark.value;
  localStorage.setItem('theme', isDark.value ? 'dark' : 'light');
  applyTheme();
}

export function useTheme() {
  return { isDark, initTheme, toggleTheme };
}
