# 股票秘书

## 需求
- 记录：
股票/基金名称、状态（持有/已卖出）、地区（港股/美股/A股）、仓位、持仓盈亏、类型（股票/股票型基金/债券型基金/货币型基金/ETF）、基准日收益与收益率、预期止盈收益率/%、买入时间/价格/数量、成本、最近一次购买价格、补仓降幅/%、下阶段策略、补仓价格
- 实时获取对应股票的价格信息，快达到阈值的时候触发飞书机器人提醒我购买或卖出，并把买点或卖点一起发给飞书机器人

---

## 运行说明

环境：Node.js >= 18（已验证 v18.20.2 / v22）。

### 一键启动（推荐）

```bash
cd 股票秘书
# 1. 复制配置模板并填入你的飞书机器人 webhook 与 secret
cp config.example.json config.json
# 2. 启动

./start.sh               # 生产模式 → http://127.0.0.1:3000（后端托管前端 + 行情调度）
./start.sh dev           # 开发模式 → http://localhost:5173（后端 + Vite HMR，/api 代理到 :3000）
```

脚本会自动检查 Node.js 版本、安装依赖、构建前端（`web/` 有改动时会自动重建），一行命令跑起全部。

### 停止服务

```bash
# 前台启动的服务：直接按 Ctrl+C 即可停止

# 若服务已在后台运行（如终端已关闭），查找并终止进程：
ps aux | grep "stock-advisor\|server/index.js"
kill <PID>                     # 替换为实际的进程 ID

# 或在确认无其他同名进程后快速终止：
pkill -f "stock-advisor"       # 停止所有关联进程（慎用，避免误杀）
pkill -f "server/index.js"     # 或按脚本名精准停止
```

### 安装为 App（PWA）

页面内置了 Web App Manifest + Service Worker，可像原生 App 一样安装到桌面 / 手机主屏，以独立窗口打开，断网也能打开界面看最近一次数据。

- **Android / Chrome / Edge（桌面端）**：地址栏右侧出现「安装」图标，或点页面顶部「📲 安装 App」按钮 → 确认安装。
- **iOS Safari**：点底部「分享」→「添加到主屏幕」→「添加」（页面顶部也会自动给出图文引导）。
- **微信等内置浏览器**：一般不支持安装，请用系统浏览器打开。

注意：
- 浏览器要求**安全上下文**才能安装：`http://localhost` 或 **HTTPS** 可以；`http://<局域网IP>` 不行（需自备 HTTPS 反代）。
- Service Worker 只在生产构建（`npm run build` / `./start.sh`）后注册；`./start.sh dev` 开发模式不注册，避免缓存干扰热更新。
- `/api/*` 接口请求不经过缓存，始终拉取实时行情与持仓；离线时仅能打开界面并展示最近一次缓存数据。

相关文件：`web/public/manifest.webmanifest`（应用清单）、`web/public/sw.js`（离线缓存）、`web/public/icon*.png|svg`（图标）。

### 分步手动操作

```bash
cd 股票秘书
npm install          # 安装前端依赖（vue / vite / tailwind / echarts）
npm run build        # 构建前端到 dist/（Node 服务会托管它）
npm start            # 常驻运行：托管前端 + 行情调度（每 20 秒一轮）
ONCE=1 node server/index.js   # 只跑一轮调度，便于本地验证

# 开发模式（带热更新）：另开一个终端跑后端，再跑 Vite 开发服务器
npm start            # 终端 A：后端 + API（:3000）
npm run dev          # 终端 B：Vite 开发服务器（:5173，/api 代理到 :3000）
```

### 一键导入 CSV 买卖记录

前端页面顶部「**导入 CSV**」按钮即可一键导入：选择 CSV 文件 → 勾选「自动新建持仓」（可选）→ 开始导入，实时展示导入结果。

命令行方式同样可用：

```bash
npm run import:csv               # 仅导入 CSV 中能匹配到现有持仓的记录
npm run import:csv:new           # 匹配不到时自动新建持仓（例如小米 1810）
node server/import-csv.js <csv>  # 导入指定路径的 CSV
```

CSV 需包含列：`代码`、`操作`、`日期`、`数量`、`价格`。可选列：`手续费`、`分红金额`、`送转比例`、`名称`、`地区`、`类型`。

- `操作` 支持：**买入 / 卖出 / 分红 / 送转**（送股、转增、拆股同义）
- 买入 → 追加到 `purchases[]`；卖出 → 追加到 `sells[]`（按持仓的成本法自动算成本与盈亏）
- 分红 → 追加到 `dividends[]`（填「分红金额」列）；送转 → 追加到 `splits[]`（填「送转比例」列）
- 导入后自动重算汇总字段（成本、数量、均价、最近买入价、状态）
- **幂等**：以 `(代码, 操作, 日期, 数量/金额/比例, 价格)` 为唯一键，重复导入自动跳过

---

## 配置（config.json）

| 配置项 | 说明 |
| --- | --- |
| `schedule.intervalSeconds` | 交易时段刷新间隔（默认 20 秒） |
| `schedule.offHoursIntervalSeconds` | 非交易时段自动降频（默认 300 秒），任一持仓市场开盘即恢复 20 秒 |
| `schedule.marketHolidays` | 各市场法定节假日（`{ "sh": ["2026-10-01"], "hk": [], "us": [] }`），命中则视为休市不轮询 |
| `schedule.snapshot` / `snapshotAt` | 是否记录每日快照 / 记录时间（北京时间，默认 16:10） |
| `schedule.dailyReport` / `dailyReportAt` | 是否推送收盘日报 / 推送时间（默认 16:15） |
| `server.host` / `server.port` | 监听地址与端口（**默认 127.0.0.1 仅本机可访问**） |
| `auth.token` | 非空时所有接口需鉴权（见下方「安全」） |
| `feishu.webhook` / `feishu.secret` | 飞书自定义机器人地址与签名密钥 |
| `notify.cooldownSeconds` | 同一品种提醒冷却（默认 3600 秒，防刷屏） |
| `notify.nearThresholdPct` | 距阈值多近算"快达到"（默认 2%） |
| `notify.maxDailyMovePct` | 单日涨跌幅超过该值视为行情异常跳过（默认 50%） |
| `fx.autoUpdate` / `fx.updateHour` | 是否每日自动更新汇率 / 更新时刻（默认 8 点，北京时间） |
| `fx.rates` | 兜底汇率（`USD_CNY`、`HKD_CNY`）；`autoUpdate: false` 时始终使用这里的值 |
| `backup.enabled` / `backup.keep` | 交易数据变更时自动备份 / 保留份数（默认 30 份，存在 `data/backups/`） |
| `logging.enabled` / `logging.dir` / `logging.keepDays` | 日志落盘开关 / 目录 / 保留天数（默认 `logs/`，14 天） |

### 安全（重要）

- `config.json` 与 `data/*.json` 含**飞书密钥与个人投资明细**，已在 `.gitignore` 中排除，请勿提交到仓库。
  仓库内只保留模板 `config.example.json` 与 `data/holdings.example.json`。
- 默认监听 `127.0.0.1`（仅本机可访问）。若需局域网/公网访问：
  1. 设置 `config.json` 的 `auth.token` 为一段随机字符串；
  2. 设置 `server.host` 为 `0.0.0.0`；
  3. 浏览器首次访问 `http://<host>:<port>/?token=<你的token>` 完成登录（会写入 localStorage 并自动从地址栏移除）。
  - 所有接口都会校验 `Authorization: Bearer <token>` / `x-auth-token` / `?token=`；未携带返回 401。
  - `/api/health` 保持公开，便于监控，且不包含持仓明细。

### 汇率配置（环境变量优先）

汇率取值优先级：**环境变量** `FX_USD_CNY` / `FX_HKD_CNY` → **自动更新缓存**（`data/fx-cache.json`，7 天内有效）→ `config.json` 的 `fx.rates` → 内置默认值。页面顶部会显示当前汇率来源与更新日期。

> 自动更新每日从两个免 Key 公开源（frankfurter / open.er-api）互备拉取，任一成功即写入缓存；两个都失败则沿用旧值并记日志。

---

## 功能一览

### 持仓与交易
- 多市场（A股/港股/美股）股票与场外基金，多次买入 / 卖出记录
- **手续费**：买入费计入成本与均价，卖出费从盈亏中扣除
- **分红**：计入已实现收益，不影响持仓成本
- **送转 / 拆股**：份额折算、均价下降、成本总额不变
- **成本法可选**：LIFO（默认）/ FIFO / WAC 移动加权平均；切换后可显式「重算历史成本」
- 历史卖出成本按"录入时点"封存，补录买入不会篡改已记录的真实盈亏

### 行情与提醒
- 腾讯财经行情（免 Key，批量，覆盖 A股/港股/美股）+ 东财基金净值
- 交易时段 20s / 非交易时段 300s 自适应降频，支持配置各市场法定节假日
- 止盈（成本加权）、止损（按笔）、补仓（降幅/目标价）、**移动止盈**（峰值回撤）、日涨跌告警
- 行情防御：停牌/缺失价格不判断、单日异常波动跳过，避免错误提醒
- 飞书 interactive 卡片推送 + 冷却去重 + **每日收盘日报**

### 复盘与统计
- **每日快照**：收盘后落盘组合状态，收益趋势按快照优先
- **收益归因**：已清仓战绩、胜率、盈亏比、平均持有天数、年度已实现收益、最佳/最差 Top3
- **组合分布饼图**：按市场 / 类型 / 品种查看市值结构
- **持仓排序**：按市值、收益率、今日涨跌等排序（金额类按人民币折算比较）
- **CSV 导出**：交易明细 / 归因统计 / 每日快照

### 可安装（PWA）
- 支持安装到桌面 / 手机主屏，独立窗口运行，见「[安装为 App（PWA）](#安装为-apppwa)」
- Service Worker 缓存界面外壳与静态资源（离线可打开），`/api/*` 始终走网络取实时数据
- 主题色跟随深/浅色主题，`?tab=stats` 可直达复盘页（已注册为应用快捷方式）

### 运维
- 自动备份（交易数据变更时写入 `data/backups/`，默认保留 30 份）
- 日志落盘（`logs/app-YYYY-MM-DD.log`，按天滚动、超期自动清理）
- 健康检查 `GET /api/health`（行情成功率、上次 tick、推送状态、汇率来源、备份配置）

---

## REST 接口

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/health` | 健康检查（公开，不含持仓明细） |
| `GET /api/holdings` | 列表（含币种、汇总、交易流水、汇率来源） |
| `GET /api/trend?range=day\|7d\|30d\|all` | 收益趋势（快照优先 + K线重放补齐，折人民币） |
| `GET /api/snapshots?range=30d\|90d\|365d\|all` | 每日快照列表 |
| `GET /api/stats/closed` | 收益归因统计（已清仓 / 胜率 / 年度已实现 / Top3） |
| `GET /api/export?scope=trades\|stats\|snapshots` | 导出 CSV（带鉴权头下载） |
| `POST /api/holdings` | 新建持仓（可带 `costMethod`、`trailingStopPct` 等） |
| `PATCH /api/holdings/:id` | 更新持仓级字段（告警阈值、移动止盈、成本法、补仓计划、下阶段策略） |
| `POST /api/holdings/:id/purchases` | 追加买入记录（含 `fee`） |
| `PATCH /api/holdings/:id/purchases/:pid` | 修改买入记录 |
| `DELETE /api/holdings/:id/purchases/:pid` | 删除买入记录 |
| `POST /api/holdings/:id/transactions` | 追加交易 `{type: BUY\|SELL\|DIVIDEND\|SPLIT, price, quantity, fee, amount, ratio, date, note}` |
| `PATCH /api/holdings/:id/transactions/:tid` | 修改交易（手续费 / 分红金额 / 送转比例 / 日期 / 备注） |
| `DELETE /api/holdings/:id/transactions/:tid` | 删除卖出 / 分红 / 送转记录 |
| `POST /api/holdings/:id/recompute` | 按当前成本法重算历史卖出成本（⚠️ 会改写历史） |
| `POST /api/import-csv` | 批量导入 CSV，`{csv, createMissing, costMethod}` |
| `POST /api/test-feishu` | 发送测试卡片到飞书机器人 |

---

## 自动化测试

```bash
npm test        # node:test 单元 + 集成测试（52 项）
```

覆盖：行情代码规范化/解析、币种换算与分币种汇总、收益趋势逐日重放、CSV 导入匹配与幂等、真实 HTTP 接口（K线/净值打桩）、账本口径（手续费/分红/送转/三种成本法/历史成本沿用/NaN 防御）、策略阈值（含移动止盈与异常价防御）、收益归因与快照合并、旧数据迁移。手动 UI 检查清单见 `docs/自测清单.md`。

---

## 目录

```
server/
├── index.js            入口：装配配置、日志、汇率缓存，启动服务与调度
├── derive.js           ★ 账本唯一口径：成本法/手续费/分红/送转/持仓聚合/交易应用
├── strategy.js         策略引擎：止盈/止损/补仓/移动止盈 + 异常价防御
├── scheduler.js        调度主循环：抓行情 → 判断 → 推送 → 快照/日报/汇率
├── server.js           HTTP 服务：静态托管 + REST 接口 + 鉴权
├── store.js            存储：内存缓存 + 串行写盘 + 自动备份 + 字段迁移
├── snapshot.js         每日快照：生成/落盘/并入趋势 + 每日任务状态
├── stats.js            收益归因统计
├── notifier.js         飞书卡片（买点/卖点/日涨跌/收盘日报）+ 签名重试
├── logger.js           结构化日志（控制台 + 按天滚动文件）
├── runtime.js          进程内运行状态（供 /api/health）
├── currency.js         币种换算纯函数
├── trend.js            收益趋势（K线/净值 + 逐日重放）
├── config.js           配置加载
├── import-csv.js       CSV 导入命令行
├── import-csv-core.js  CSV 导入核心（与 HTTP 接口共用）
└── provider/           行情与汇率数据源
    ├── tencent.js      腾讯行情（A股/港股/美股，免 Key）
    ├── fund.js         东财基金净值
    ├── fx.js           汇率取值优先级
    └── fx-live.js      汇率自动更新（双源互备 + 缓存）

web/src/                Vue3 + Vite + Tailwind 前端（构建产物 dist/）
├── App.vue             页签（持仓总览 / 复盘统计）+ 过滤 + 弹窗编排
├── composables/        useHoldings（数据与鉴权）/ useFormat / useTheme
├── constants/options.js 枚举（策略/地区/类型/成本法/交易类型）
└── components/         概览卡、分布饼图、趋势、持仓列表/卡片、明细表、
                        复盘统计、新增持仓、交易、买入记录、CSV 导入

data/                   holdings.json（个人数据，不入库）+ snapshots.json
                        + backups/（自动备份）+ fx-cache.json + daily-state.json
docs/                   需求 / 计划 / 技术设计 / 盈亏计算规则 / 自测清单 / 优化建议
```

- 技术栈：
  - 前端：Vue3 + Vite + TailwindCSS + ECharts（源码在 `web/`，构建产物 `dist/`）
  - 后端：Node.js（内置 http，零运行时依赖）+ 本地 JSON 存储
  - 行情源：腾讯财经（免 Key）+ 东方财富基金净值
  - 推送：飞书自定义机器人（HMAC-SHA256 签名）
