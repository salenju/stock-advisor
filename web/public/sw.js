/* 股票秘书 Service Worker
 * 目标：让应用可「安装」（PWA）并在离线/弱网时仍能打开界面。
 *
 * 路径策略：所有内部路径都用 self.registration.scope 拼出来，
 * 因此同一个 sw.js 既能跑在根路径（后端托管 dist），
 * 也能跑在子路径（GitHub Pages 的 /<repo>/）下。
 *
 * 缓存策略：
 *  - 导航请求（HTML）：网络优先，失败回退缓存的 app shell（离线可打开）。
 *  - 静态资源（assets/*、图标、manifest）：缓存优先（Vite 产物带 hash，天然可长缓存）。
 *  - 接口请求（/api/*）：一律走网络，不缓存（行情/持仓需实时，且带鉴权）。
 */
const VERSION = 'v2';
/** 部署根路径，形如 '/' 或 '/stock-advisor/' */
const BASE = new URL(self.registration.scope).pathname;
const SHELL_CACHE = `stock-shell-${VERSION}`;
const ASSET_CACHE = `stock-assets-${VERSION}`;

const url = (p) => BASE + String(p).replace(/^\//, '');

const SHELL_URLS = [url(''), url('index.html'), url('manifest.json'), url('icon.svg')];

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

// 判断是否是可长期缓存的静态资源（只接管部署根路径下的资源）
function isStaticAsset(u) {
  if (!u.pathname.startsWith(BASE)) return false;
  return (
    u.pathname.startsWith(url('assets/')) ||
    /\.(?:js|css|woff2?|ttf|png|jpg|jpeg|svg|ico|webp|json)$/i.test(u.pathname)
  );
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const u = new URL(request.url);
  // 只处理同源请求；接口请求不接管
  if (u.origin !== self.location.origin) return;
  if (u.pathname.startsWith(`${BASE}api/`)) return;

  // 页面导航：网络优先，离线回退 app shell
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(url('index.html'), copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(url('index.html')).then((cached) => cached || caches.match(url(''))))
    );
    return;
  }

  // 静态资源：缓存优先，后台更新
  if (isStaticAsset(u)) {
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
