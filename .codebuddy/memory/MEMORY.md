# 项目长期记忆 · stock-advisor（股票秘书）

## 当前架构（2026-10-18：纯静态收尾完成）
- **没有后端**：`server/`、`start.sh`、`config.example.json`、REST 接口、飞书推送、定时调度、历史收益趋势图已全部删除；`npm start` / `npm run import:csv` 脚本一并移除。
- 前端：Vue 3 + Vite，`vite.config.js` 以 `web` 为 root，产物输出到根 `dist/`，由 GitHub Pages 等静态托管直接发布。
- 数据模式只有两种（`web/src/services/dataSource.js` 门面）：
  - `local`：只写浏览器 IndexedDB；
  - `github`：本机 IndexedDB 为工作副本 + 加密同步到用户自己的私有仓库。
  - 已删除 `serverSource`、`getAuthToken/setAuthToken/apiFetch`、`trend()/testFeishu()/health()`；`MODES = ['local','github']`，默认 `local`（`VITE_DATA_MODE` 只区分 `github`）。
- **单一事实来源**：纯逻辑都在 `web/src/core/`（`derive/currency/stats/strategy/snapshot/import-csv-core/provider/tencent/csv/rates/quote/market/schema/sync-payload`），`node:test` 直接 import 这些文件。
- 命令：`npm run dev` / `build` / `preview`；检查脚本 `check:local|sync|pages|layout`（`scripts/static-server.mjs` 托管 `dist/`，不再启动 Node 服务）。

## 项目约定
- 按钮统一走 daisyUI 语义色（`btn-primary` / `btn-info` / `btn-success` / `btn-warning` / `btn-accent`），`web/src/style.css` 里全局 `.btn { color:#fff }` 使按钮默认白字；若用 `btn-outline`，daisyUI 的 `.btn-outline.btn-*` 会覆盖成彩色文字+彩色边框+透明底。
- 导出/下载全部在前端完成：`web/src/core/csv.js` 生成文本 + 页面触发下载，不存在下载接口。
- 写操作没有鉴权概念（数据在用户自己的浏览器/仓库里）。

## 本地存储与云同步
- `web/src/store/localStore.js`：IndexedDB（不可用降级 localStorage），`kv` + `backups` 两个 store；`saveHoldings` 写入前对**写入前的状态**做「变更指纹不同才备份」（最多 30 份，可回滚）；`exportBundle/importBundle`（merge 按 `region+code` 取记录更完整的一方 / replace），`parseBundle` 兼容裸数组（旧版 `data/holdings.json`）。
- **IndexedDB 两个坑（都踩过并修了）**：① `tx()` 不能把 `req.result === undefined` 当成"没取到"否则会把 IDBRequest 对象当数据返回（报 `IDBRequest object could not be cloned`）；② 写入前必须 `JSON.parse(JSON.stringify(v))` 剥离 Vue 响应式 Proxy（否则报 `#<Object> could not be cloned`）。
- 云同步：`github-api.js` 用文件 `sha` 做乐观锁；`sync-payload.js` 可选 AES-GCM（PBKDF2-SHA256，20 万次迭代）；公开仓库会被配置面板拦下；冲突时提示先拉取合并。
- 行情前端化（已实测）：腾讯 `qt.gtimg.cn` 与 `web.ifzq.gtimg.cn` 返回 `Access-Control-Allow-Origin: *`，可直接 fetch（GBK 用 `TextDecoder('gbk')`）；基金走 `fund.eastmoney.com/pingzhongdata/{code}.js` 的 `<script>` 注入（东财 `api.fund.eastmoney.com` 无 CORS）。汇率源 `api.frankfurter.dev/v1` 与 `open.er-api.com` 都带 CORS。
- 纯静态下**不支持**：收益趋势（K 线重放）、飞书推送、无人值守定时任务；已用「打开页面时补记当日快照」补偿每日快照。

## 仓库与数据入库策略
- 远端：`https://github.com/salenju/stock-advisor.git`。
- `.gitignore` 把 **`data/` 整目录**忽略（写法 `data/*` + `!data/holdings.example.json`；不能用 `data/` 目录模式，否则例外文件无法重新纳入），另 `logs/`、`dist/` 也忽略。
- ⚠️ 历史遗留：`data/holdings-0724备份.json`、`data/holdings-备份20260728.json`、`data/买入-卖出记录 - Sheet1.csv` 曾出现在提交 `4231b0d`、`1f433ae` 中。工作区已取消跟踪，但 **git 历史与远端分支仍有**。仓库要公开（Pages 免费版需公开）时，必须重写历史（`git filter-repo --invert-paths --path ...`）或重建仓库。
- 用户偏好：个人数据一律不入库，数据放本地、靠导出/导入 JSON 迁移。

## GitHub Pages 部署
- `vite.config.js`：`base: process.env.VITE_BASE || '/'`（子路径/自定义域名只改环境变量）。
- `web/index.html`、`web/public/manifest.json` 内部链接全为相对路径；`sw.js` 用 `new URL(self.registration.scope).pathname` 推导 BASE；`main.js` 用 `import.meta.env.BASE_URL` 注册 SW。根路径与 `/<repo>/` 共用一份代码。
- 清单是 `manifest.json`（不用 `.webmanifest`：静态托管不能自定义 MIME，Chrome 接受 application/json）。
- `.github/workflows/pages.yml`：pnpm（仓库只有 pnpm-lock.yaml）→ `pnpm test` → `pnpm run build`（注入 `VITE_DATA_MODE=local` 与 `VITE_BASE=/${{ github.event.repository.name }}/`）→ upload-pages-artifact → deploy-pages。仓库需在 Settings → Pages 把 Source 设为 GitHub Actions。
- `pages-check.mjs`（`npm run check:pages`）：用 VITE_BASE 构建 → 拷到 `/tmp/gh-pages-preview/<repo>/` → 最小静态服务 → 无头 Chrome 校验「无 404 / manifest 解析 / installabilityErrors 为空 / SW 作用域 = /<repo>/」。当前全绿。
- Pages 免费版需公开仓库，但仓库内无个人数据；每个访客是独立空库。

## PWA
- 手写 PWA，未引入 `vite-plugin-pwa`：`web/public/{manifest.json,sw.js,icon.svg,icon-maskable.svg,icon-*.png,apple-touch-icon.png,favicon-32.png}`。
- SW 策略（VERSION `v3`）：导航网络优先（离线回退 shell）；同源静态资源缓存优先；跨域行情请求不接管。仅在 `import.meta.env.PROD` 注册。
- 安装入口：`composables/usePwa.js` + `AppHeader.vue` 的「📲 安装 App」按钮 + `App.vue` 的 iOS 引导条；`?tab=stats` 深链也是 manifest 快捷方式。
- 验证手段：`puppeteer-core` + Chrome（`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`）+ CDP `Page.getAppManifest` / `Page.getInstallabilityErrors`。

## 测试现状
- `npm test`：61 项（账本/成本法、策略、统计、快照、CSV 导入、行情解析、云同步信封与 API）。
- `check:local`：导入 → 双行情链路 → 持久化 → 导出 → 备份回滚 → 模式面板（无「服务端数据」选项）。
- `check:sync`：假 GitHub 仓库跑通配置→上传→自动推送→换设备拉取→错口令→明文→公开仓库拦截。
- `check:layout`：390/375/320px 三档无溢出。
