---
kind: build_system
name: 基于 Vite + Node.js 的全栈构建与一键启动流程
category: build_system
scope:
    - '**'
source_files:
    - package.json
    - start.sh
    - vite.config.js
    - tailwind.config.js
    - postcss.config.js
    - server/server.js
---

## 1. 构建系统与工具链

项目采用 **Vite（前端）+ Node.js（后端）** 的单仓库全栈架构，所有构建脚本集中在根目录的 `package.json` 和 `start.sh` 中：

- **包管理器**：pnpm（存在 `pnpm-lock.yaml`），但 `start.sh` 在依赖缺失时回退调用 `npm install`。
- **Node 版本要求**：`engines.node >= 18`，由 `start.sh` 在启动前通过 `node -v` 校验并拒绝低版本。
- **前端框架**：Vue 3 + Vite，源码位于 `web/` 子目录，构建产物输出到项目根 `dist/`。
- **CSS 工具链**：Tailwind CSS + PostCSS + Autoprefixer + DaisyUI（自定义 light/dark 主题 `stocklight`/`stockdark`）。
- **后端运行时**：纯 Node.js HTTP 服务（无 Express/Koa），直接托管 `dist/` 静态资源并提供 REST API。

## 2. 关键文件

| 文件 | 作用 |
|---|---|
| `package.json` | 定义入口 `server/index.js`、脚本 `dev/build/start/import:csv*`、依赖及 Node 版本约束 |
| `start.sh` | 一键启动脚本，支持 `prod`（默认）与 `dev` 两种模式 |
| `vite.config.js` | 配置 `root: 'web'`、`outDir: '../dist'`、开发代理 `/api → :3000` |
| `tailwind.config.js` | Tailwind/DaisyUI 主题配置（light/dark 双主题） |
| `postcss.config.js` | PostCSS 插件管线（tailwindcss → autoprefixer） |
| `server/server.js` | 生产模式下静态资源托管（`serveStatic` 函数，SPA 兜底至 `index.html`） |
| `server/index.js` | 后端主入口（被 `npm start` 执行） |

## 3. 构建与运行流程

### 开发模式（`./start.sh dev` 或 `npm run dev`）
1. 检查 Node ≥ 18，若 `node_modules` 不存在则执行 `npm install`。
2. 后台启动后端 `node server/index.js`（监听 `:3000`）。
3. 前台启动 Vite 开发服务器（`npx vite --host`，监听 `:5173`）。
4. Vite 通过 `proxy['/api']` 将 API 请求转发到 `http://127.0.0.1:3000`，实现热更新联调。
5. 进程退出时通过 `trap cleanup EXIT INT TERM` 同时终止前后端。

### 生产模式（`./start.sh` 或 `npm start`）
1. 检查 Node ≥ 18 与依赖。
2. 若 `dist/` 不存在则执行 `npm run build`（即 `vite build`，产出到 `../dist`）。
3. 执行 `node server/index.js`，后端直接 serve `dist/` 下的静态文件（`text/html; charset=utf-8` 等 MIME 类型），非 `/api` 路径未命中时回退到 `index.html` 以支持 SPA 路由。
4. 统一对外暴露 `http://127.0.0.1:3000`，前端页面与后端 API 同源访问。

## 4. 约定与约束

- **源码/产物分离**：前端源码严格放在 `web/`，构建产物固定输出到根 `dist/`，后端通过相对路径 `join(__dirname, '..', 'dist')` 定位，不可随意改动目录结构。
- **API 前缀**：所有后端接口统一使用 `/api/*` 路径，由 `server/server.js` 中的 `handleApi` 集中路由；前端开发期通过 Vite proxy 透明转发。
- **单仓单端口**：生产环境前后端共用同一 Node 进程与端口（3000），无需 Nginx 反向代理即可部署。
- **CSV 导入工具**：提供两个 npm script——`import:csv`（常规导入）与 `import:csv:new`（带 `--create-missing` 参数创建缺失持仓），由 `server/import-csv.js` 驱动。
- **无 Docker/CI**：仓库未发现 `Dockerfile`、`.github/workflows`、Makefile 等 CI/容器化配置，部署依赖手动执行 `start.sh`。
- **MIME 白名单**：静态资源仅声明了 `.html/.js/.css/.json/.svg/.png/.jpg/.ico/.woff/.woff2` 的 Content-Type，其他扩展名降级为 `application/octet-stream`。