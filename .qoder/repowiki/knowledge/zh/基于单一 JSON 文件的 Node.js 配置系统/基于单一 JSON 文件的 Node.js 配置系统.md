---
kind: configuration_system
name: 基于单一 JSON 文件的 Node.js 配置系统
category: configuration_system
scope:
    - '**'
source_files:
    - config.json
    - server/config.js
    - server/index.js
    - server/server.js
    - server/scheduler.js
    - server/notifier.js
    - vite.config.js
    - start.sh
---

## 1. 使用的系统与方式

本项目采用**极简的纯 JSON 配置文件 + 运行时环境变量**的组合方式，没有引入任何第三方配置库（如 dotenv、config、nconf 等）。

- 核心配置文件：项目根目录 `config.json`，以扁平 JSON 对象描述所有运行期参数。
- 加载器：`server/config.js` 通过 Node `fs/promises.readFile` 从 `__dirname` 上一级读取 `config.json` 并 `JSON.parse`，暴露 `loadConfig()` 异步函数。
- 启动入口：`server/index.js` 在进程启动时 `await loadConfig()` 一次，将配置对象透传给 `startServer(cfg)` 与 `startScheduler(cfg)`。
- 环境变量：仅使用 `process.env.ONCE` 切换单次执行模式（调用 `runOnce` 后立即退出），用于一次性拉取行情；其他行为全部由 `config.json` 驱动。
- 构建/部署脚本：`start.sh` 根据传入参数选择开发模式（`dev`，启动 Vite 热更新 + 后端）或生产模式（默认 `prod`，先 `npm run build` 再 `npm start`），不注入额外环境变量。

## 2. 关键文件与包

| 文件 | 作用 |
|---|---|
| `config.json` | 唯一的外部配置源，定义 schedule / server / feishu / notify 四个顶层段 |
| `server/config.js` | 配置加载器，读取 `config.json` 并解析为 JS 对象 |
| `server/index.js` | 应用入口，加载配置后启动 HTTP 服务与调度器 |
| `server/server.js` | 消费 `cfg.server.host`、`cfg.server.port` 监听端口，托管前端静态资源 |
| `server/scheduler.js` | 消费 `cfg.schedule.intervalSeconds`、`cfg.schedule.offHoursIntervalSeconds`、`cfg.notify.cooldownSeconds`、`cfg.notify.nearThresholdPct` |
| `server/notifier.js` | 消费 `cfg.feishu.webhook`、`cfg.feishu.secret` 发送飞书卡片 |
| `vite.config.js` | 前端构建配置，将 `/api` 代理到 `http://127.0.0.1:3000`（开发模式） |
| `start.sh` | 一键启动脚本，决定 dev/prod 两种运行路径 |

## 3. 架构与设计约定

### 配置结构
`config.json` 按功能域分块组织：
- `schedule`：定时任务刷新间隔。交易时段用 `intervalSeconds`（默认 20s），非交易时段用 `offHoursIntervalSeconds`（默认 300s），由 `scheduler.js` 的 `pickInterval` 根据市场开闭状态动态切换。
- `server`：HTTP 服务监听地址与端口，`server.js` 中 `startServer` 使用 `cfg.server?.port ?? 3000`、`cfg.server?.host ?? '127.0.0.1'` 作为默认值。
- `feishu`：飞书机器人 Webhook URL 与签名密钥，供 `notifier.js` 推送告警卡片。
- `notify`：通知冷却窗口 `cooldownSeconds`（秒）与“接近阈值”百分比 `nearThresholdPct`，用于避免重复推送。

### 加载时机与作用域
- 配置在进程启动时**只读入一次**（`server/index.js` 顶层 `await loadConfig()`），之后以普通对象形式在各模块间传递，不存在运行时重新加载机制。
- 前端（Vite）与后端共享同一份 `config.json` 概念：后端直接读取它；前端通过 `vite.config.js` 的 proxy 把 `/api/*` 请求转发到后端，间接依赖后端读取的配置。

### 环境区分策略
- **开发 vs 生产**：由 `start.sh` 的命令行参数控制，而非 `.env` 文件。开发模式启动 Vite 5173 端口并代理 `/api` 到 3000；生产模式先构建前端到 `dist/`，再由 `npm start`（即 `node server/index.js`）托管静态资源。
- **单次执行 vs 常驻**：设置 `ONCE=1` 环境变量可让进程执行一轮行情抓取后立即退出，便于 cron 或系统计划任务调用。

### 默认值与容错
- 服务器 host/port 使用可选链 + 空值合并提供默认值，保证即使 `config.json` 缺失对应字段也能启动。
- 调度器对行情 API 调用失败做 `catch` 降级，不会中断整个循环。

## 4. 约定与约束

- **单一配置源**：所有运行期参数集中在 `config.json`，代码中未出现分散的 `process.env.*` 读取（除 `ONCE` 外），新增配置项应优先写入该文件。
- **配置即明文**：`config.json` 中包含飞书 webhook 与 secret，仓库内存在占位符 `REPLACE_WITH_YOUR_SECRET`，实际部署时应替换为真实值；当前仓库未使用 `.env` 或外部密钥管理服务。
- **无配置校验层**：`loadConfig()` 不做 schema 校验，错误会在首次访问对应字段时抛出（如 `cfg.schedule.intervalSeconds` 为 undefined 时 `pickInterval` 返回 NaN）。建议后续增加基础校验。
- **不可热重载**：修改 `config.json` 需重启进程才能生效，因为配置仅在启动时读取一次。
- **前端与后端配置解耦**：前端通过 Vite proxy 访问后端 API，不直接读取 `config.json`；后端负责统一对外暴露 REST 接口，前端仅消费数据。
- **启动脚本约定**：`./start.sh`（默认 prod）、`./start.sh dev` 是官方推荐的启动方式，不建议绕过脚本直接 `node server/index.js` 以免遗漏依赖检查与构建步骤。