---
kind: frontend_style
name: 基于 Tailwind + DaisyUI 的响应式主题化 UI 风格体系
category: frontend_style
scope:
    - '**'
source_files:
    - tailwind.config.js
    - web/src/style.css
    - web/src/composables/useTheme.js
    - web/src/App.vue
    - web/src/components/HoldingCard.vue
    - postcss.config.js
    - vite.config.js
---

## 1. 采用的样式系统

前端位于 `web/` 子目录，使用 **Vue 3 + Vite** 构建，样式方案为 **Tailwind CSS + DaisyUI** 组合：
- `postcss.config.js` 启用 `tailwindcss` 与 `autoprefixer`。
- `tailwind.config.js` 通过 `daisyui` 插件加载组件库，并定义了两个自定义主题 `stocklight`（浅色）和 `stockdark`（深色），作为默认主题与 `darkTheme`。
- `web/src/style.css` 仅引入 `@tailwind base/components/utilities`，并补充少量全局样式（细滚动条、`.btn` 白字、`.btn-ghost` 在浅色背景下的可读性补偿）。
- `vite.config.js` 将 `root` 设为 `web`，构建产物输出到根目录 `dist/`，由后端 Node 服务统一托管；开发时 `/api` 代理到 `http://127.0.0.1:3000`。

## 2. 关键文件与包

| 文件 | 作用 |
|---|---|
| `tailwind.config.js` | Tailwind 配置与 DaisyUI 主题色板（primary=#5548ff、success=#21a470、warning=#f98c1f、error=#ea423b、info=#3369ff） |
| `web/src/style.css` | Tailwind 入口 + 全局滚动条与按钮微调 |
| `web/src/composables/useTheme.js` | 主题切换逻辑，通过 `<html>` 的 `data-theme` 与 `class="dark"` 切换 `stocklight` / `stockdark`，状态持久化到 `localStorage.theme` |
| `web/src/App.vue` | 应用根组件，使用 DaisyUI 语义类名（`bg-base-200`、`text-base-content`、`max-w-7xl`、`rounded-xl`、`badge-*`、`btn-*`、`input-*`）组织布局 |
| `web/src/components/*.vue` | 业务组件，全部基于 Tailwind 原子类 + DaisyUI 组件类编写 |
| `postcss.config.js` | PostCSS 管线（tailwindcss → autoprefixer） |
| `vite.config.js` | Vite 构建配置（root=web，outDir=../dist，dev proxy） |

## 3. 架构与设计约定

- **原子类优先**：所有布局、间距、颜色、圆角、阴影等视觉表现均通过 Tailwind 原子类完成，未见独立 BEM/SCSS 模块。
- **DaisyUI 语义类**：卡片用 `card`/`bg-base-100`/`border-base-300`，按钮用 `btn btn-success`/`btn-error`/`btn-xs`，标签用 `badge badge-s badge-primary`，输入框用 `input input-bordered input-xs`。这些类名直接映射到 DaisyUI 主题变量，从而随主题自动适配深浅色。
- **主题策略**：`useTheme.js` 在初始化时读取 `localStorage.theme`，默认深色；切换时在 `document.documentElement` 上设置 `data-theme="stocklight|stockdark"` 并 toggle `dark` class。`tailwind.config.js` 中 `darkMode: 'class'` + `daisyui.darkTheme: 'stockdark'` 使 `<html class="dark">` 时自动应用深色主题。
- **设计令牌集中管理**：品牌主色 `#5548ff`、成功绿 `#21a470`、警告橙 `#f98c1f`、错误红 `#ea423b`、信息蓝 `#3369ff` 均在 `tailwind.config.js` 的 DaisyUI themes 中统一定义，组件不出现硬编码色值。
- **响应式布局**：通过 Tailwind 断点（如 `sm:grid-cols-4 lg:grid-cols-7`）、弹性布局（`flex flex-wrap gap-2`）实现自适应网格与换行。
- **全局样式最小化**：`style.css` 仅处理浏览器滚动条样式与 `.btn`/`.btn-ghost` 的可读性补丁，其余全部走原子类。

## 4. 约定与约束

- 新增页面或组件必须通过 Tailwind 原子类 + DaisyUI 语义类实现样式，不得新建独立 CSS 文件（除 `style.css` 外）。
- 主题色变更应修改 `tailwind.config.js` 中的 DaisyUI theme 色板，而非在组件内写死 hex 值。
- 主题切换必须通过 `useTheme()` composable 操作 `data-theme` 与 `class="dark"`，以保证 DaisyUI 的 `darkTheme` 机制生效。
- 构建产物统一输出至根目录 `dist/`，由后端 `server/server.js` 托管，前端源码始终位于 `web/` 下。
- 开发环境通过 Vite 的 `proxy '/api'` 转发到本地 `:3000` 后端，避免跨域问题。