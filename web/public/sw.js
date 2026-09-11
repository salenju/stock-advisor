/* 股票秘书 Service Worker
 * 目标：让应用可「安装」（PWA）并在离线/弱网时仍能打开界面。
 * 策略：
 *  - 导航请求（HTML）：网络优先，失败回退缓存的 app shell（离线可打开）。
 *  - 静态资源（/assets/*、图标、manifest）：缓存优先（Vite 产物带 hash，天然可长缓存）。
 *  - 接口请求（/api/*）：一律走网络，不缓存（行情/持仓需实时，且带鉴权）。
 */
const VERSION = 'v1';
const SHELL_CACHE = `stock-shell-${VERSION}`;
const ASSET_CACHE = `stock-assets-${VERSION}`;

const SHELL_URLS = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL_CACHE && k !== ASSET_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

// 判断是否是可长期缓存的静态资源
function isStaticAsset(url) {
  return (
    url.pathname.startsWith('/assets/') ||
    /\.(?:js|css|woff2?|ttf|png|jpg|jpeg|svg|ico|webp|webmanifest)$/i.test(url.pathname)
  );
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // 只处理同源请求；接口请求不接管
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // 页面导航：网络优先，离线回退 app shell
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put('/index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('/index.html').then((cached) => cached || caches.match('/')))
    );
    return;
  }

  // 静态资源：缓存优先，后台更新
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const network = fetch(request)
          .then((res) => {
            if (res && res.ok) {
              const copy = res.clone();
              caches.open(ASSET_CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
            }
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
  }
});

// 允许页面触发「立即应用新版本」
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
