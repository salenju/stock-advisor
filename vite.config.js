import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 前端（Vue3 + Vite）源码放在 web/ 子目录，打包产物输出到项目根 dist/，
// 由后端 Node 服务（server/server.js）统一托管。
// 开发时 `npm run dev` 启动 Vite 开发服务器并代理 /api 到本地后端（:3000）。
export default defineConfig({
  root: 'web',
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
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
});
