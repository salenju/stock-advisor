import { createApp } from 'vue';
import App from './App.vue';
import './style.css';

createApp(App).mount('#app');

// ---------- PWA：注册 Service Worker ----------
// 仅生产构建注册：开发环境下 SW 会缓存模块、干扰 Vite HMR。
// 页面需要通过 http(s) 访问（localhost 视为安全上下文），file:// 打开无法安装。
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      // 用 BASE_URL 拼路径：根路径部署得到 '/sw.js'，子路径部署（GitHub Pages 的 /<repo>/）
      // 得到 '/<repo>/sw.js'；不传 scope，默认就是 sw.js 所在目录（与部署路径一致）
      const swUrl = `${import.meta.env.BASE_URL}sw.js`;
      const reg = await navigator.serviceWorker.register(swUrl, { updateViaCache: 'none' });
      // 发现新版本：让等待中的 SW 立即接管，随后刷新一次页面
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            sw.postMessage('SKIP_WAITING');
          }
        });
      });
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloaded) return;
        reloaded = true;
        window.location.reload();
      });
      // 回到页面时检查更新（用户可能长时间挂着不刷新）
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    } catch (e) {
      console.warn('[pwa] Service Worker 注册失败：', e?.message || e);
    }
  });
}
