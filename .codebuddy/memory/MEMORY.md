# 项目长期记忆 · stock-advisor（股票秘书）

## 技术栈与结构
- 后端：纯 Node.js（`server/`，ESM，无框架），入口 `server/index.js`，HTTP 服务与接口在 `server/server.js`（`startServer(cfg)`）。
- 前端：Vue 3 + Vite，源码在 `web/`，`vite.config.js` 以 `web` 为 root，产物输出到根 `dist/`，由后端静态托管（SPA 兜底到 index.html）。
- 样式：Tailwind + daisyUI，自定义双主题 `stocklight` / `stockdark`（`tailwind.config.js`，`darkMode: 'class'`）。切主题由 `web/src/composables/useTheme.js` 同时设 `data-theme` 与 `html.dark`。
- 启动：`./start.sh`（生产，后端托管 dist，:3000）/ `./start.sh dev`（后端 + Vite HMR，:5173）。也支持 `npm run build` / `npm start`。
- 配置：`config.json`（由 `config.example.json` 复制），`server/config.js` 只从文件读取，**没有环境变量覆盖端口**。

## 项目约定
- 按钮统一走 daisyUI 语义色（`btn-primary` / `btn-info` / `btn-success` / `btn-warning` / `btn-accent`），`web/src/style.css` 里全局 `.btn { color:#fff }` 使按钮默认白字；若用 `btn-outline`，daisyUI 的 `.btn-outline.btn-*` 会覆盖成彩色文字+彩色边框+透明底。
- 复盘的导出/下载走 `GET /api/export?scope=trades|stats|snapshots`（带鉴权）。
- 写操作接口受 `auth.token` 保护，token 存浏览器 localStorage；`/api/health` 公开。

## PWA（2026-09-11 新增）
- 手写 PWA，未引入 `vite-plugin-pwa`：`web/public/{manifest.webmanifest,sw.js,icon.svg,icon-maskable.svg,icon-192.png,icon-512.png,icon-maskable-512.png,apple-touch-icon.png,favicon-32.png}`。
- SW 策略：导航网络优先（离线回退 shell）；静态资源缓存优先；`/api/*` 不接管。仅在 `import.meta.env.PROD` 注册。
- 安装入口：`web/src/composables/usePwa.js` + `AppHeader.vue` 的「📲 安装 App」按钮 + `App.vue` 的 iOS 引导条；页签支持 `?tab=stats` 深链（也是 manifest 快捷方式）。
- 后端 `serveStatic` 已补 `.webmanifest` MIME，`/sw.js`、`/manifest.webmanifest`、`/index.html` 为 no-cache，`/assets/*` 为 immutable。
- 验证手段：`puppeteer-core` + Chrome（`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`）+ CDP `Page.getAppManifest` / `Page.getInstallabilityErrors`。改后端代码后**必须重启 node 服务**才生效（静态文件从磁盘读，接口/头信息在内存）。
