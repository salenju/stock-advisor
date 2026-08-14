# 持仓管理API

<cite>
**本文引用的文件**
- [server/server.js](file://server/server.js)
- [server/store.js](file://server/store.js)
- [server/strategy.js](file://server/strategy.js)
- [data/holdings.json](file://data/holdings.json)
- [config.json](file://config.json)
- [web/src/composables/useHoldings.js](file://web/src/composables/useHoldings.js)
</cite>

## 目录
1. [简介](#简介)
2. [项目结构](#项目结构)
3. [核心组件](#核心组件)
4. [架构总览](#架构总览)
5. [详细接口说明](#详细接口说明)
6. [依赖关系分析](#依赖关系分析)
7. [性能与一致性](#性能与一致性)
8. [故障排查指南](#故障排查指南)
9. [结论](#结论)
10. [附录：数据模型与字段说明](#附录数据模型与字段说明)

## 简介
本文件为 Stock Advisor 的“持仓管理”后端 API 文档，覆盖所有与持仓相关的 HTTP 端点，包括：
- GET /api/holdings：获取持仓列表（含派生计算字段）
- POST /api/holdings：创建新持仓（支持一次性录入多条买入记录）
- PATCH /api/holdings/:id：更新持仓级配置（如日涨跌告警阈值等）
- POST /api/holdings/:id/purchases：追加买入记录
- PATCH /api/holdings/:id/purchases/:pid：修改某条买入记录的止盈/止损比例、价格、数量、时间等
- DELETE /api/holdings/:id/purchases/:pid：删除某条买入记录
- POST /api/holdings/:id/transactions：提交一笔交易（兼容旧接口，内部统一为买入或卖出）
- POST /api/import-csv：批量导入 CSV 买卖记录（按代码匹配，幂等插入）
- POST /api/test-feishu：测试飞书推送（用于验证通知通道）

每个接口均提供请求方法、URL 模式、参数说明、响应格式、成功与错误示例，并附带数据模型、状态管理与策略配置的详细说明。

## 项目结构
后端采用 Node.js 原生 http 模块实现路由与业务逻辑，数据持久化到 data/holdings.json，前端通过 Vue 组合式函数调用这些接口。

```mermaid
graph TB
Client["客户端/前端"] --> Server["HTTP 服务器<br/>server/server.js"]
Server --> Store["存储层<br/>server/store.js"]
Server --> Strategy["策略引擎<br/>server/strategy.js"]
Store --> DataFile["数据文件<br/>data/holdings.json"]
Server --> Notifier["通知器<br/>notifier.js(外部)"]
```

图表来源
- [server/server.js:567-594](file://server/server.js#L567-L594)
- [server/store.js:40-70](file://server/store.js#L40-L70)

章节来源
- [server/server.js:1-100](file://server/server.js#L1-L100)
- [server/store.js:1-71](file://server/store.js#L1-L71)

## 核心组件
- 路由与处理器：集中处理 /api/* 请求，解析 JSON 体，调用业务函数，返回标准 JSON。
- 存储层：内存缓存 + 串行写盘，避免并发冲突；首次加载或文件被外部修改时重新读盘。
- 策略引擎：基于多次买入记录评估止盈/止损与补仓信号，供调度器使用。
- 数据模型：持仓对象包含基本信息、多次买入记录、卖出记录、派生计算字段、策略与告警配置。

章节来源
- [server/server.js:409-565](file://server/server.js#L409-L565)
- [server/store.js:40-70](file://server/store.js#L40-L70)
- [server/strategy.js:34-90](file://server/strategy.js#L34-L90)

## 架构总览
```mermaid
sequenceDiagram
participant C as "客户端"
participant S as "HTTP 服务器"
participant ST as "存储层"
participant D as "数据文件"
C->>S : GET /api/holdings
S->>ST : loadHoldings()
ST->>D : 读取 holdings.json
D-->>ST : 原始数组
ST-->>S : 内存缓存数组
S->>S : withDerived() 计算派生字段
S-->>C : { data : [...] }
```

图表来源
- [server/server.js:410-414](file://server/server.js#L410-L414)
- [server/store.js:40-58](file://server/store.js#L40-L58)

## 详细接口说明

### 通用约定
- 内容类型：application/json; charset=utf-8
- 成功响应：{ data: ... }
- 失败响应：{ error: "..." }
- 状态码：200/201/400/404/500/502 等

### 1) 获取持仓列表
- 方法：GET
- URL：/api/holdings
- 请求体：无
- 响应：
  - 200：{ data: Array<HoldingWithDerived> }
  - 500：{ error: "..." }
- 说明：返回所有持仓，并对每条持仓应用 withDerived 计算派生字段（成本、市值、收益、今日盈亏、均价、最近买入价、目标/止损加权值等）。

章节来源
- [server/server.js:410-414](file://server/server.js#L410-L414)
- [server/server.js:146-245](file://server/server.js#L146-L245)

### 2) 创建新持仓（买入建仓）
- 方法：POST
- URL：/api/holdings
- 请求体：
  - 必填：name, code, region, type
  - 可选：purchases[]（可空，允许先建仓后补明细）、strategy、snapshotDate、snapshotProfit、snapshotReturnRate、position、refillDropRate、refillPrice、nextStrategy、dailyDropAlertPct、dailyRiseAlertPct
- 响应：
  - 201：{ data: HoldingWithDerived }
  - 400：{ error: "缺少字段: ..." | "买入价/买入数量必须为正" }
- 行为：
  - 校验必填字段
  - purchases 中每条记录需满足 buyPrice > 0 且 buyQuantity > 0
  - 生成唯一 id、默认 status=持有、初始化策略与告警字段
  - 保存后返回带派生字段的完整持仓

章节来源
- [server/server.js:302-344](file://server/server.js#L302-L344)
- [server/server.js:437-450](file://server/server.js#L437-L450)
- [server/server.js:286-300](file://server/server.js#L286-L300)

### 3) 更新持仓级配置（日涨跌告警阈值等）
- 方法：PATCH
- URL：/api/holdings/:id
- 路径参数：id（持仓ID）
- 请求体（部分更新）：
  - dailyDropAlertPct：数值或 null（设为 null 表示不告警）
  - dailyRiseAlertPct：数值或 null
- 响应：
  - 200：{ data: HoldingWithDerived }
  - 404：{ error: "持仓不存在" }
- 行为：
  - 仅更新传入字段
  - 重置 dailyAlertSentDate，使下次触发立即推送

章节来源
- [server/server.js:452-465](file://server/server.js#L452-L465)

### 4) 追加买入记录
- 方法：POST
- URL：/api/holdings/:id/purchases
- 路径参数：id（持仓ID）
- 请求体：
  - buyPrice：正数
  - buyQuantity：正数
  - buyTime 或 date：日期字符串（默认当天）
  - targetProfitRate、stopLossRate：数值（默认 0）
- 响应：
  - 200：{ data: HoldingWithDerived }
  - 400：{ error: "买入价/买入数量必须为正" }
  - 404：{ error: "持仓不存在" }
- 行为：
  - 新增一条买入记录
  - 同步更新 cost、buyQuantity、avgCost、lastBuyPrice、加权目标/止损
  - 重置 triggerState 与 notifiedAt

章节来源
- [server/server.js:467-488](file://server/server.js#L467-L488)
- [server/server.js:286-300](file://server/server.js#L286-L300)
- [server/server.js:247-284](file://server/server.js#L247-L284)

### 5) 修改某条买入记录（止盈/止损比例、价格、数量、时间）
- 方法：PATCH
- URL：/api/holdings/:id/purchases/:pid
- 路径参数：id（持仓ID），pid（买入记录ID）
- 请求体（部分更新）：
  - buyPrice、buyQuantity、buyTime、targetProfitRate、stopLossRate
- 响应：
  - 200：{ data: HoldingWithDerived }
  - 404：{ error: "持仓不存在" | "买入记录不存在" }
- 行为：
  - 仅更新传入字段
  - 同步更新汇总字段

章节来源
- [server/server.js:490-513](file://server/server.js#L490-L513)
- [server/server.js:247-284](file://server/server.js#L247-L284)

### 6) 删除某条买入记录
- 方法：DELETE
- URL：/api/holdings/:id/purchases/:pid
- 路径参数：同上
- 响应：
  - 200：{ data: HoldingWithDerived }
  - 404：{ error: "持仓不存在" | "买入记录不存在" }
- 行为：
  - 删除指定买入记录
  - 若该持仓无剩余买入记录，status 置为“已卖出”

章节来源
- [server/server.js:515-527](file://server/server.js#L515-L527)

### 7) 提交交易（兼容旧接口）
- 方法：POST
- URL：/api/holdings/:id/transactions
- 路径参数：id（持仓ID）
- 请求体：
  - type：BUY 或 SELL
  - price：正数
  - quantity：正数
  - date：可选，默认当天
- 响应：
  - 200：{ data: HoldingWithDerived }
  - 400：{ error: "quantity / price 必须为正" | "卖出数量超过持仓数量" | "type 必须为 BUY 或 SELL" }
  - 404：{ error: "持仓不存在" }
- 行为：
  - BUY：新增买入记录，status 置为“持有”
  - SELL：新增卖出记录，按 LIFO 计算成本，更新 status 为“全部卖出”或“持有”
  - 同步更新汇总字段，重置触发态

章节来源
- [server/server.js:346-407](file://server/server.js#L346-L407)
- [server/server.js:529-543](file://server/server.js#L529-L543)

### 8) 批量导入 CSV 买卖记录
- 方法：POST
- URL：/api/import-csv
- 请求体：
  - csv：CSV 文本
  - createMissing：布尔（是否自动新建缺失的持仓）
- 响应：
  - 200：{ data: { added, skipped, created, createdCodes, missing, errors, total } }
  - 400：{ error: "缺少 csv 内容" | "..." }
- 行为：
  - 按代码匹配现有持仓，已有明细忽略（幂等）
  - 支持数字归一化匹配
  - 可自动创建缺失持仓（createMissing=true）

章节来源
- [server/server.js:416-435](file://server/server.js#L416-L435)
- [server/import-csv-core.js:130-156](file://server/import-csv-core.js#L130-L156)
- [server/import-csv-core.js:170-247](file://server/import-csv-core.js#L170-L247)

### 9) 测试飞书推送
- 方法：POST
- URL：/api/test-feishu
- 请求体：无
- 响应：
  - 200：{ ok: true, data: ... }
  - 502：{ error: "飞书推送失败：..." }
- 用途：验证飞书机器人是否正常

章节来源
- [server/server.js:545-562](file://server/server.js#L545-L562)

## 依赖关系分析
```mermaid
graph LR
A["server/server.js"] --> B["server/store.js"]
A --> C["server/strategy.js"]
B --> D["data/holdings.json"]
E["web/src/composables/useHoldings.js"] --> A
```

图表来源
- [server/server.js:567-594](file://server/server.js#L567-L594)
- [server/store.js:40-70](file://server/store.js#L40-L70)
- [web/src/composables/useHoldings.js:15-29](file://web/src/composables/useHoldings.js#L15-L29)

章节来源
- [server/server.js:409-565](file://server/server.js#L409-L565)
- [server/store.js:40-70](file://server/store.js#L40-L70)
- [web/src/composables/useHoldings.js:67-130](file://web/src/composables/useHoldings.js#L67-L130)

## 性能与一致性
- 内存缓存：loadHoldings 仅在首次或文件 mtime 变化时重读磁盘，减少 I/O。
- 串行写盘：saveHoldings 使用 Promise 链串行写入，避免并发覆盖。
- 派生计算：withDerived 在每次返回列表时计算，保证前端展示一致。
- 建议：
  - 高频更新场景下，尽量合并请求（如批量导入）
  - 合理设置刷新间隔，避免频繁拉取
  - 对大文件读写进行监控，必要时分片或归档

[本节为通用指导，无需具体文件引用]

## 故障排查指南
- 400 错误：检查请求体字段是否齐全、数值是否为正、JSON 是否合法
- 404 错误：确认 ID 是否存在（持仓或买入记录）
- 500 错误：查看服务端日志，定位异常堆栈
- 502 错误：检查飞书 webhook 与 secret 配置是否正确
- 数据不一致：确认是否手动修改了 holdings.json，导致缓存失效

章节来源
- [server/server.js:567-594](file://server/server.js#L567-L594)
- [server/store.js:62-70](file://server/store.js#L62-L70)

## 结论
本 API 提供了完整的持仓生命周期管理能力，支持多次买入、卖出、策略配置与告警阈值设置，并通过派生字段简化前端展示。结合串行写盘与内存缓存，保证了高并发下的数据一致性与性能。建议在生产环境配合定时任务与通知机制，形成闭环的投资辅助流程。

[本节为总结性内容，无需具体文件引用]

## 附录：数据模型与字段说明

### 持仓对象（Holding）
- 基本信息
  - id：字符串，唯一标识
  - name：品种名称
  - code：代码（支持数字归一化匹配）
  - region：市场区域（如 sh/hk/美股）
  - type：资产类型（股票/基金等）
  - strategy：投资策略（long/mid/short/highrisk）
  - snapshotDate/snapshotProfit/snapshotReturnRate：快照信息
  - position：初始仓位（可选）
- 交易明细
  - purchases[]：多次买入记录（见下）
  - sells[]：卖出记录（见下）
- 策略与告警
  - refillDropRate：补仓跌幅阈值（百分比）
  - refillPrice：补仓目标价
  - nextStrategy：下一阶段策略
  - dailyDropAlertPct/dailyRiseAlertPct：日涨跌告警阈值（百分比，null 表示不告警）
  - dailyAlertSentDate：当日告警发送标记
- 派生字段（由 withDerived 计算）
  - cost：剩余成本（总买入成本 - 已卖出部分成本）
  - buyQuantity：未卖出数量
  - sellQuantity：累计卖出数量
  - unsoldQuantity：未卖出数量（冗余）
  - avgCost：均价（剩余成本/未卖出数量）
  - lastBuyPrice：最近一次买入价
  - marketValue：当前市值（currentPrice * 未卖出数量）
  - holdingProfit：持仓总收益（未实现 + 已实现）
  - holdingReturnRate：持仓收益率
  - todayProfit/todayReturnRate：今日盈亏与收益率
  - targetProfitRate/stopLossRate：按成本加权的持仓级目标/止损
  - dropRate：较最近买入价的跌幅
  - transactions：合并后的交易流水（含买入与卖出）

### 买入记录（Purchase）
- id：唯一标识
- buyPrice：买入价（正数）
- buyQuantity：买入数量（正数）
- buyTime：买入日期（YYYY-MM-DD）
- targetProfitRate：该笔目标止盈（百分比）
- stopLossRate：该笔止损（百分比）

### 卖出记录（Sell）
- id：唯一标识
- sellPrice：卖出价
- sellQuantity：卖出数量
- sellDate：卖出日期
- costPrice：卖出部分的成本价（LIFO 计算）
- profit：该笔盈利
- returnRate：该笔收益率

### 状态与触发
- status：持有/全部卖出/已卖出
- triggerState：IDLE/SELL/BUY（由策略引擎评估）
- notifiedAt：上次通知时间

章节来源
- [server/server.js:302-344](file://server/server.js#L302-L344)
- [server/server.js:146-245](file://server/server.js#L146-L245)
- [server/server.js:247-284](file://server/server.js#L247-L284)
- [server/strategy.js:34-90](file://server/strategy.js#L34-L90)
- [data/holdings.json:1-462](file://data/holdings.json#L1-L462)