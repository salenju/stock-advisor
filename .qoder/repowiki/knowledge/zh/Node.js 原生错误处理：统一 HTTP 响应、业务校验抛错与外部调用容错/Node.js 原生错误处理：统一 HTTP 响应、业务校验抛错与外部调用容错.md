---
kind: error_handling
name: Node.js 原生错误处理：统一 HTTP 响应、业务校验抛错与外部调用容错
category: error_handling
scope:
    - '**'
source_files:
    - server/server.js
    - server/import-csv-core.js
    - server/notifier.js
    - server/scheduler.js
    - server/provider/tencent.js
    - server/provider/fund.js
    - server/index.js
---

## 1. 整体方案

本项目为纯 Node.js + Vue 全栈工程，后端使用原生 `http` 模块自建 HTTP 服务，未引入 Express/Koa 等框架，因此**没有全局中间件式错误处理**。错误处理采用「函数内抛错 + 路由层捕获并转 JSON 响应」的轻量模式，配合调度器中的 `.catch` 静默降级。

- **HTTP 层**：`server.js` 中 `startServer` 的 `createServer` 回调包裹了最外层 `try/catch`，将未捕获异常转为 `{ error }` 的 500 JSON 响应；所有业务路由在各自分支内用 `try/catch` 捕获参数校验错误，返回 400/404。
- **业务层**：参数校验（如买入价/数量必须为正、必需字段缺失、卖出超持仓）通过 `throw new Error('...')` 抛出，由上层路由捕获后以 `sendJSON(res, 400, { error: e.message })` 返回。
- **外部调用层**：行情抓取 (`provider/tencent.js`, `provider/fund.js`) 和飞书推送 (`notifier.js`) 出错时，不向上抛错，而是 `console.warn/error` 后继续运行或重试。
- **调度器**：`scheduler.js` 使用 `Promise.catch` 兜底单次 tick 失败，保证定时循环不因单个品种失败而中断。

## 2. 关键文件与职责

| 文件 | 错误处理职责 |
|---|---|
| `server/server.js` | 全局 catch → 500；各 `/api/*` 路由捕获校验错误 → 400/404；`readBody` 解析失败 → reject(`invalid json`)；`handleApi` 末尾兜底 404 |
| `server/import-csv-core.js` | CSV 表头校验、买入/卖出数据校验直接 `throw new Error`；逐行导入用 try/catch 收集到 `errors[]` 数组，不中断批量导入 |
| `server/notifier.js` | 飞书推送实现 3 次重试（指数退避），仅最后一次失败才抛出；HTTP 非 200 或 `data.code !== 0` 时主动 `throw new Error` |
| `server/provider/tencent.js` | `res.ok` 为假时 `throw new Error`；编码解码失败回退 UTF-8 |
| `server/provider/fund.js` | 逐个基金查询，每个失败 `console.warn` 后 continue，不影响其他基金 |
| `server/scheduler.js` | `fetchPrices` / `fetchFundNavs` 用 `.catch` 降级为空对象；飞书通知失败 `console.error` 后继续；`startScheduler` 顶层 `.catch` 保证循环不断 |
| `server/index.js` | 进程入口，无额外错误处理 |

## 3. 架构与约定

### 3.1 错误分类与传播路径

1. **客户端输入错误**（4xx）：由 `server.js` 中各路由分支显式判断并返回。例如：
   - `POST /api/holdings`：`createHolding` 抛错 → 400 `{ error: '缺少字段: ...' }`
   - `PATCH /api/holdings/:id`：找不到持仓 → 404 `{ error: '持仓不存在' }`
   - `POST /api/import-csv`：CSV 缺少必需列 → 400 `{ error: 'CSV 表头缺少必需列...' }`
   - `POST /api/test-feishu`：飞书推送失败 → 502 `{ error: '飞书推送失败：...' }`

2. **服务端内部错误**（5xx）：由 `createServer` 外层 `catch` 统一捕获，返回 500 `{ error: e.message }`，并 `console.error('[server]', e.message)`。

3. **可恢复的外部错误**：行情 API 失败、飞书推送失败被降级为日志 + 空结果，不阻断主流程。

### 3.2 批量导入的「部分成功」语义

`importCsvText` 对每行记录单独 try/catch，将失败记录以 `{ rec, message }` 形式推入 `errors` 数组，最终返回 `{ added, skipped, created, createdCodes, missing, errors, total }`。HTTP 层将其原样返回给前端，前端可展示哪些行导入成功、哪些失败。**这是本仓库唯一显式的「结构化错误聚合」模式**。

### 3.3 重试策略

仅 `notifier.js` 的 `sendCard` 实现了重试：最多 3 次，间隔 `attempt * 1 秒`，仅当最后一次仍失败才向上抛出。其余外部调用（腾讯行情、东方财富净值）均无重试，失败即跳过。

### 3.4 无自定义 Error 子类

代码中全部使用原生 `Error` 实例，未定义任何自定义错误类型（如 `ValidationError`、`NotFoundError`）。错误区分依赖字符串消息内容，而非类型判别。

## 4. 约定与约束

- **HTTP 响应格式统一**：所有 JSON 响应通过 `sendJSON(res, code, obj)` 发送，错误响应体固定为 `{ error: string }`（除 502 飞书测试接口外）。
- **参数校验集中化**：`normalizePurchase`、`createHolding`、`applyTransaction` 等核心函数负责校验，失败即抛错，调用方只关心业务结果。
- **调度器健壮性优先**：`scheduler.js` 中任何单点失败都被 `.catch` 吞掉，确保定时任务不因个别品种行情拉取失败而停止。
- **无 panic/recover**：Node.js 环境未使用 `process.on('uncaughtException')` 或 `try/catch` 之外的恢复机制。
- **无全局错误码枚举**：错误码直接使用 HTTP 状态码（400/404/500/502），未在应用层定义业务错误码。
- **日志级别**：外部调用失败使用 `console.warn`（可恢复）、`console.error`（不可恢复但已降级），业务错误使用 `console.log` 带 ❌ 前缀（见 `import-csv.js` 命令行脚本）。