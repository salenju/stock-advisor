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

## 双数据模式（2026-09-11，Phase 1 完成）
- 用户目标是**砍掉后端**：数据只存本地浏览器 + 导出/导入 JSON，追求绝对隐私；同时要能部署到 GitHub Pages（纯静态）。
- **单一事实来源**：纯逻辑全部放 `web/src/core/`（`derive.js`/`currency.js`/`stats.js`/`strategy.js`/`snapshot.js`(纯函数)/`import-csv-core.js`/`provider/tencent.js`/`csv.js`/`rates.js`/`quote.js`/`market.js`/`schema.js`）。
  `server/` 下同名文件已改为**再导出**（`export * from '../web/src/core/xxx.js'`），`server/scheduler.js` 的交易时段函数、`server/store.js` 的 `migrateHolding`/指纹、`server/server.js` 的 `createHolding`/CSV、`server/snapshot.js` 的 `buildSnapshot`/`mergeSnapshots` 都改为引用 core，**改口径只需改一处**。`server/` → `web/` 的依赖方向是刻意的（server 最终要被删除）。
- `web/src/store/localStore.js`：IndexedDB（不可用降级 localStorage），`kv` + `backups` 两个 store；`saveHoldings` 写入前对**写入前的状态**做「变更指纹不同才备份」（最多 30 份，可回滚）；`exportBundle/importBundle`（merge 按 `region+code` 取记录更完整的一方 / replace），`parseBundle` 兼容裸数组（`data/holdings.json`）。
- `web/src/services/dataSource.js`：门面 `localSource` / `serverSource`，业务代码只调 `dataSource().list()/create()/patch()/...`。模式优先级：`?mode=local|server`（会被记住并清理 URL）> localStorage > `VITE_DATA_MODE`。
- 行情前端化（已实测）：腾讯 `qt.gtimg.cn` 与 `web.ifzq.gtimg.cn` 返回 `Access-Control-Allow-Origin: *`，可直接 fetch（GBK 用 `TextDecoder('gbk')`）；基金改走 `fund.eastmoney.com/pingzhongdata/{code}.js` 的 `<script>` 注入（东财 `api.fund.eastmoney.com` 无 CORS，不能用）。汇率源 `api.frankfurter.app`→301→`api.frankfurter.dev/v1` 与 `open.er-api.com` 都带 CORS。
- **IndexedDB 两个坑（都踩过并修了）**：① `tx()` 不能把 `req.result === undefined` 当成"没取到"否则会把 IDBRequest 对象当数据返回（报 `IDBRequest object could not be cloned`）；② 写入前必须 `JSON.parse(JSON.stringify(v))` 剥离 Vue 响应式 Proxy（否则报 `#<Object> could not be cloned`）。
- 本地模式不支持：收益趋势（K 线重放，Phase 2）、飞书推送、无人值守定时任务；已用"打开页面时补记当日快照"做补偿。
- 验证：`npm test`（52 项，server 侧再导出后全绿）、`npm run check:local`（`local-mode-check.mjs`，无头 Chrome 跑导入→双行情链路→持久化→导出→备份回滚→切回服务端，9 项全过）、`npm run check:layout`。
- 收尾提醒：`./start.sh` 或已有的 node 进程需**重启**才用上新代码。

## 仓库与数据入库策略（2026-09-11）
- 远端：`https://github.com/salenju/stock-advisor.git`，当前分支 `feat/optimization-p0-p2`（已推送）。
- `.gitignore` 已把 **`data/` 整目录**忽略（写法为 `data/*` + `!data/holdings.example.json`；不能用 `data/` 目录模式，否则「例外文件」无法重新纳入），另 `config.json`、`logs/`、`dist/` 也忽略。
- ⚠️ 历史遗留：`data/holdings-0724备份.json`、`data/holdings-备份20260728.json`、`data/买入-卖出记录 - Sheet1.csv` 曾被提交（提交 `4231b0d`、`1f433ae`），**已在工作区 `git rm --cached` 取消跟踪（未提交）**，但它们在 **git 历史和远端分支上仍然存在**。若仓库要公开（GitHub Pages 免费版需公开仓库），必须重写历史（`git filter-repo --invert-paths --path ...`）或直接删除重建仓库。
- 用户偏好：个人数据一律不入库，数据放本地、靠导出/导入 JSON 迁移。

## GitHub Pages 部署（2026-09-11 打通）
- 结论：**纯静态可部署**（因为没有后端依赖，靠本地数据模式）。已补齐三处硬阻塞并实测通过。
- `vite.config.js` 加了 `base: process.env.VITE_BASE || '/'`（子路径部署/自定义域名只改环境变量，不改代码）。
- `web/index.html`、`web/public/manifest.json` 内部链接**全部改为相对路径**（`manifest.json`/`icon.svg`/`./`/`./?tab=stats`），`sw.js` 用 `new URL(self.registration.scope).pathname` 推导 BASE，`main.js` 用 `import.meta.env.BASE_URL` 注册 SW（不传 scope，默认即部署目录）。→ 根路径与 `/<repo>/` 子路径都能用，同一份代码。
- 清单从 `manifest.webmanifest` **改名为 `manifest.json`**：GitHub Pages 等静态托管不能自定义 MIME，`.webmanifest` 有被当成 octet-stream 的风险（Chrome 也接受 application/json 的清单）。`server/server.js` 的 NO_CACHE 已同时包含两个名字。
- 新增 `.github/workflows/pages.yml`：pnpm（仓库只有 pnpm-lock.yaml，无 package-lock.json）→ `pnpm test` → `pnpm run build`（注入 `VITE_DATA_MODE=local` 与 `VITE_BASE=/${{ github.event.repository.name }}/`）→ upload-pages-artifact → deploy-pages。仓库需在 Settings → Pages 把 Source 设为 GitHub Actions。
- 新增 `pages-check.mjs`（`npm run check:pages`）：用 VITE_BASE 构建 → 拷到 /tmp/gh-pages-preview/<repo>/ → 最小 Node 静态服务 → 无头 Chrome 校验「资源无 404 / manifest 解析 / installabilityErrors 为空 / SW 作用域 = /<repo>/」。当前全绿。
- 注意：GH Pages 免费需公开仓库，但仓库内无个人数据（config.json、data/*.json 已 gitignore），持仓只在访客浏览器；每个访客是独立空库；本地模式下趋势图与飞书不可用。

## PWA（2026-09-11 新增）
- 手写 PWA，未引入 `vite-plugin-pwa`：`web/public/{manifest.json,sw.js,icon.svg,icon-maskable.svg,icon-192.png,icon-512.png,icon-maskable-512.png,apple-touch-icon.png,favicon-32.png}`。
- SW 策略：导航网络优先（离线回退 shell）；静态资源缓存优先；`/api/*` 不接管。仅在 `import.meta.env.PROD` 注册。
- 安装入口：`web/src/composables/usePwa.js` + `AppHeader.vue` 的「📲 安装 App」按钮 + `App.vue` 的 iOS 引导条；页签支持 `?tab=stats` 深链（也是 manifest 快捷方式）。
- 后端 `serveStatic` 已补 `.webmanifest` MIME，`/sw.js`、`/manifest.webmanifest`、`/index.html` 为 no-cache，`/assets/*` 为 immutable。
- 验证手段：`puppeteer-core` + Chrome（`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`）+ CDP `Page.getAppManifest` / `Page.getInstallabilityErrors`。改后端代码后**必须重启 node 服务**才生效（静态文件从磁盘读，接口/头信息在内存）。
