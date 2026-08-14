---
kind: external_dependency
name: 前端构建与开发服务器（Vite）
slug: vite
category: external_dependency
category_hints:
    - framework_behavior
scope:
    - '**'
source_files:
    - package.json
    - vite.config.js
    - tailwind.config.js
    - postcss.config.js
    - start.sh
---

前端基于 Vue3 + Vite + TailwindCSS 构建，源码位于 `web/`，生产模式经 `npm run build` 输出至 `dist/`，由 Node 后端托管；开发模式通过 `npx vite --host` 启动热更新服务（:5173），并自动将 `/api` 请求代理到后端 :3000。