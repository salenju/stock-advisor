---
kind: dependency_management
name: 基于 pnpm + Node.js 的依赖管理
category: dependency_management
scope:
    - '**'
source_files:
    - package.json
    - pnpm-lock.yaml
    - .gitignore
    - start.sh
---

## 1. 使用的系统/工具

本项目采用 **pnpm** 作为包管理器，配合 **Node.js >= 18**（通过 `package.json` 的 `engines.node` 字段声明）进行依赖管理。前端构建使用 Vite 5，后端为纯 Node.js 脚本，两者共享根目录下的单一 `package.json` 与 `pnpm-lock.yaml`。

## 2. 关键文件

- `package.json`：声明项目元信息、运行脚本、运行时依赖与开发依赖，并通过 `engines.node: ">=18"` 约束 Node 版本。
- `pnpm-lock.yaml`：pnpm v9 lockfile（`lockfileVersion: '9.0'`），锁定所有直接及间接依赖的确切版本与 integrity hash，确保跨环境可重现安装。
- `node_modules/`：pnpm 默认安装的依赖目录（非 vendored 模式）。
- `.gitignore`：忽略 `node_modules/` 与 `dist/`，不提交依赖树。
- `vite.config.js` / `tailwind.config.js` / `postcss.config.js`：仅配置构建工具行为，不包含依赖声明。

## 3. 架构与约定

- **单仓单 manifest**：整个仓库只有一个 `package.json`，同时管理服务端（`server/index.js` 等）与前端（`web/src` Vue 3 SPA）的依赖，没有子模块或 workspace 划分。
- **依赖分类清晰**：
  - `dependencies` 仅包含运行时依赖 `vue@^3.4.0`，用于服务端渲染或 API 响应。
  - `devDependencies` 包含构建期依赖：`vite`、`@vitejs/plugin-vue`、`tailwindcss`、`autoprefixer`、`postcss`、`daisyui`、`puppeteer-core`（用于截图/抓取场景）。
- **语义化版本范围**：所有依赖均使用 `^` 前缀的 caret range（如 `^3.4.0`、`^5.4.0`），允许小版本/补丁自动升级，由 lockfile 固定实际安装版本。
- **无私有仓库/镜像配置**：仓库中未发现 `.npmrc`、`.pnpmrc`、`registry` 或 `authToken` 相关配置，表明依赖全部从公共 npm registry 拉取。
- **无 vendoring**：未使用 `pnpm pack` 产物或自定义 vendor 目录，依赖以标准 `node_modules` 形式存在。
- **启动脚本**：`start.sh` 负责拉起服务，但依赖安装本身由 pnpm 完成；`package.json` 中的 `scripts` 提供 `start`、`dev`、`build`、`preview`、`import:csv` 等命令。

## 4. 约定与约束

- **Node 版本约束**：通过 `engines.node: ">=18"` 强制要求 Node.js 18+，避免低版本兼容问题。
- **Lockfile 必须提交**：`pnpm-lock.yaml` 已纳入版本控制，保证团队成员与 CI 安装完全一致的依赖树。
- **禁止裸 `npm install`**：仓库使用 pnpm 管理，应通过 `pnpm install` 安装依赖，否则无法生成/校验 lockfile。
- **运行时与构建时依赖分离**：只有 `vue` 进入 `dependencies`，其余均为 `devDependencies`，生产部署时可通过 `--prod` 或 pnpm 的 production-only 安装减少体积。
- **无 monorepo/workspace**：当前仓库未使用 pnpm workspace，前后端共用同一份依赖列表；若未来拆分需引入 workspace 配置。
- **无私有源/认证**：未发现任何私有 npm registry 或 token 配置，所有第三方包均来自公共 npm 源。
