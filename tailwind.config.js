/** @type {import('tailwindcss').Config} */
export default {
  // 前端源码在 web/ 子目录，Vite 以 web 为 root 构建
  // darkMode: 'class' → 通过 <html class="dark"> 切换深/浅色主题
  darkMode: 'class',
  content: ['./web/index.html', './web/src/**/*.{vue,js}'],
  theme: {
    extend: {},
  },
  plugins: [],
};
