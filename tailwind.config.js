import daisyui from "daisyui";

/** @type {import('tailwindcss').Config} */
export default {
  // 前端源码在 web/ 子目录，Vite 以 web 为 root 构建
  // darkMode: 'class' → 通过 <html class="dark"> 切换深/浅色主题
  darkMode: "class",
  content: ["./web/index.html", "./web/src/**/*.{vue,js}"],
  theme: {
    extend: {},
  },
  plugins: [daisyui],
  daisyui: {
    // 自定义主题：每个对象定义一个命名主题，第一个为默认主题
    // 色板来自产品规范：white/black 作基底，primary/success/warning/danger/info 作功能色
    themes: [
      {
        stocklight: {
          primary: "#5548ff",
          secondary: "#3369ff", // 未指定，取同色板 info 蓝作对比
          accent: "#21a470", // 未指定，取同色板 success 绿作点缀
          neutral: "#171717",
          "base-100": "#ffffff", // white
          "base-200": "#f6f6f6",
          "base-300": "#e8e8e8",
          "base-content": "#171717", // black
          info: "#3369ff",
          success: "#21a470",
          warning: "#f98c1f",
          error: "#ea423b", // danger === error
        },
      },
      {
        stockdark: {
          primary: "#5548ff",
          secondary: "#3369ff",
          accent: "#21a470",
          neutral: "#2a2a2a",
          "base-100": "#171717", // black
          "base-200": "#222222",
          "base-300": "#2e2e2e",
          "base-content": "#ffffff", // white
          info: "#3369ff",
          success: "#21a470",
          warning: "#f98c1f",
          error: "#ea423b", // danger === error
        },
      },
    ],
    // 当 <html class="dark"> 时自动使用 stockdark（与 App.vue 的 toggleTheme 配合）
    darkTheme: "stockdark",
  },
};
