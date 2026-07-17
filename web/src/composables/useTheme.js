import { ref } from 'vue';

const isDark = ref(true);

function applyTheme() {
  document.documentElement.dataset.theme = isDark.value ? 'stockdark' : 'stocklight';
  document.documentElement.classList.toggle('dark', isDark.value);
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
