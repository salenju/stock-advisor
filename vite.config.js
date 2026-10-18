import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 前端（Vue3 + Vite）源码放在 web/ 子目录，打包产物输出到项目根 dist/，
// 由 GitHub Pages 等静态托管直接发布（项目里没有任何后端进程）。
export default defineConfig({
  root: 'web',
  // base：部署在子路径时用它指定前缀，例如 GitHub Pages 项目站点是 /<repo>/。
  // 本地开发与自定义域名保持默认 '/'；CI 里通过 VITE_BASE 注入。
  base: process.env.VITE_BASE || '/',
  plugins: [vue()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          // echarts 体积大且独立，单独拆包，避免阻塞首屏
          echarts: ['echarts/core', 'echarts/charts', 'echarts/components', 'echarts/renderers'],
        },
      },
    },
  },
  server: {
    // host: true 绑定 0.0.0.0，支持通过本机 IP（局域网）访问，启动日志会打印 Network 地址
    host: true,
    port: 5173,
  },
});
