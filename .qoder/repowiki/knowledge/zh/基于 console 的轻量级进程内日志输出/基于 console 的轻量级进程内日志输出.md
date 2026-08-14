---
kind: logging_system
name: 基于 console 的轻量级进程内日志输出
category: logging_system
scope:
    - '**'
source_files:
    - server/index.js
    - server/server.js
    - server/scheduler.js
    - server/provider/fund.js
    - server/import-csv.js
    - server/notifier.js
---

## 1. 使用的系统/方案

本项目**没有引入任何第三方日志库**（`package.json` 中无 `winston`、`pino`、`bunyan`、`log4js`、`morgan` 等依赖），后端所有日志均通过 Node.js 内置的 `console.log` / `console.warn` / `console.error` 直接输出到标准输出。前端（Vue 单页）未包含服务端日志逻辑，仅作为静态页面由 Express-less 的 `http` 模块托管。

## 2. 关键文件与位置

- `server/index.js`：应用启动入口，打印启动信息并调度服务/定时任务。
- `server/server.js`：HTTP 服务器，统一捕获请求异常后以 `console.error('[server]', ...)` 输出；监听成功时 `console.log` 输出访问地址。
- `server/scheduler.js`：行情抓取与策略评估循环，使用 `[stock-fetch]`、`[fund-fetch]`、`[skip]`、`[notify-daily]`、`[notify]`、`[tick]` 等前缀区分来源。
- `server/provider/fund.js`：基金净值拉取，使用 `[fund]` 前缀记录 HTTP 状态码、解析失败、无数据等警告。
- `server/import-csv.js`：CSV 导入脚本，使用大量 `console.log` 输出导入统计（总数、新增、跳过、新建持仓、错误明细）并以 `═══════` 分隔块。
- `server/notifier.js`：飞书推送模块本身不输出日志，调用方在 `scheduler.js` 中以 `.catch((e) => console.error('[notify]', e.message))` 处理异常。

## 3. 架构与约定

- **无集中 logger 实例**：每个模块自行决定何时调用 `console.*`，不存在统一的 logger 初始化或配置入口。
- **结构化字段通过字符串拼接实现**：日志采用“标签前缀 + 消息”的形式，如 `[stock-fetch] ${e.message}`、`[fund] ${code} http ${res.status}`、`[tick] ${now.toISOString()} [${mode}] 持仓 ${active.length} 只，已更新状态`，便于在 stdout 中按前缀过滤。
- **日志级别语义化使用**：
  - `console.log`：业务运行态信息（启动、tick 周期汇总、导入统计、成功提示）。
  - `console.warn`：可恢复的异常情况（基金无净值、某品种无行情、HTTP 非 200）。
  - `console.error`：不可恢复的错误（网络抓取失败、飞书推送失败、HTTP 500 异常）。
- **进程内唯一输出通道**：所有日志最终都进入进程 stdout，由外部容器/进程管理器（如 systemd、Docker、PM2）负责落盘或转发，代码层不做文件写入。
- **无日志级别开关**：当前代码中没有环境变量控制日志级别或关闭日志，所有 `console.*` 调用在生产与开发模式下均生效。

## 4. 约定与约束

- **约定**：各模块在输出日志时习惯用方括号包裹来源标识（如 `[stock-fetch]`、`[fund-fetch]`、`[notify]`、`[server]`、`[fund]`），以便运维人员通过 `grep` 快速定位问题来源。
- **约束**：由于没有日志框架，无法实现结构化 JSON 日志、按级别路由到不同 sink、异步缓冲或采样降级；所有日志均为同步阻塞式输出，在高并发请求下可能影响性能（但本服务为低频后台任务型应用，影响有限）。
- **外部集成点**：日志消费完全依赖宿主环境——若部署到 Docker，stdout 即容器日志；若部署到云平台，需由平台采集 stdout 到日志服务。代码中不包含任何日志轮转、文件大小限制或敏感信息脱敏逻辑。
- **前端侧**：前端 Vue 应用不涉及服务端日志输出，仅通过浏览器控制台调试，不在本仓库范围内产生持久化日志。

总结：这是一个极简的“console 直出”日志实践，适合个人工具类项目；若未来需要多环境分级、结构化日志或集中收集，建议引入 `pino`/`winston` 并在 `server/index.js` 中集中初始化。