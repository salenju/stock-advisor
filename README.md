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

相关文件：`web/public/manifest.json`（应用清单，用 `.json` 而非 `.webmanifest` 是为了兼容 GitHub Pages 等对 MIME 不可控的静态托管）、`web/public/sw.js`（离线缓存）、`web/public/icon*.png|svg`（图标）。

### 部署到 GitHub Pages（纯静态）

因为前端自带「本地数据模式」（数据存访问者的浏览器），**不需要任何后端**，可以直接部署到 GitHub Pages。

**前提**：用本地数据模式 + 子路径 base 构建（项目站点地址是 `https://<user>.github.io/<repo>/`，base 必须是 `/<repo>/`）。

```bash
# 本地等价命令（构建到 dist/ 后把 dist 内容推到 gh-pages 分支即可）
VITE_DATA_MODE=local VITE_BASE=/<你的仓库名>/ npm run build
npm run check:pages   # 本地模拟 /<repo>/ 子路径部署并自动校验（资源 404 / manifest / 可安装 / SW 作用域）
```

**自动部署**：仓库已内置 `.github/workflows/pages.yml`，推送到 `main`/`master` 即自动构建并发布。只需在仓库里做一次设置：

> **Settings → Pages → Source 选「GitHub Actions」**

工作流会自动注入 `VITE_BASE=/${{ github.event.repository.name }}/` 与 `VITE_DATA_MODE=local`，所以**不需要改代码**。

注意：

- 免费账号的 Pages 要求**仓库公开**。本方案下仓库里没有任何个人数据（`config.json`、`data/*.json` 已在 `.gitignore`），持仓只存在访问者自己的浏览器里，因此公开仓库**不会泄露隐私**。
- 用**自定义域名**时把工作流里的 `VITE_BASE` 改成 `/`（或删掉该行）。
- 每个访问者的浏览器都是**独立的一份空数据**：适合自己用（打开后用「🗄 数据」导入自己的备份）；别人看到的是空库，不会看到你的持仓。
- 本地数据模式下**收益趋势图与飞书推送不可用**（依赖后端的 K 线重放与推送通道），页面会给出说明。
- 子路径部署下 PWA 依旧可安装：`manifest.json` 与图标都用相对路径、Service Worker 作用域为 `/<repo>/` —— 已由 `npm run check:pages` 实测验证。

### 数据放在哪：两种数据模式

页面顶部会显示当前模式，点「**🗄 数据**」按钮可随时切换（切换会整页刷新；两种模式的数据相互独立，切换不会删除任何数据）。

| 模式 | 数据位置 | 能力 |
| --- | --- | --- |
| **本地数据**（推荐，隐私最好） | 只在这台设备的浏览器（IndexedDB），不经过任何服务器 | 持仓 / 交易 / 复盘统计 / CSV 导入导出 / **实时行情（浏览器直连腾讯·东财）** / JSON 备份导出导入 / 自动版本快照回滚 |
| **服务端数据** | 后端服务的 `data/holdings.json` | 上述全部 **+ 飞书推送 + 无人值守的每日快照与收盘日报 + 历史收益趋势** |

**本地模式的隐私承诺**：数据只写进本机浏览器，不上传任何地方。代价是「清浏览器数据 / 换浏览器 / 换设备」会丢数据，因此请在「🗄 数据」面板定期导出 JSON 备份（超过 7 天未导出会主动提醒）。

三种进入本地模式的方式（优先级从高到低）：

```bash
# 1. 网址后面加 ?mode=local 打开一次（会被记住，之后 URL 里的参数自动移除）
http://127.0.0.1:3000/?mode=local

# 2. 页面右上角「🗄 数据」→ 选择「🔒 本地数据」

# 3. 构建期指定（用于把纯静态站点部署到 GitHub Pages 等）
VITE_DATA_MODE=local npm run build
```

**从服务端搬到本地**：在服务端模式导出 `data/holdings.json` → 切到本地模式 → 「🗄 数据」→ 选择该文件 → 按「合并」导入（裸数组格式会自动识别）。

**本地模式暂不支持**：收益趋势图（历史 K 线重放，Phase 2 迁移）；飞书提醒按钮会自动隐藏。

> 代码结构：前后端共享的口径与算法统一放在 `web/src/core/`（成本法/统计/快照/CSV/交易时段/行情/schema 迁移），
> `server/` 下的同名模块已改为**再导出**，避免两份实现分叉；浏览器端持久化在 `web/src/store/localStore.js`，
> 双模式门面在 `web/src/services/dataSource.js`，数据面板在 `web/src/components/DataModal.vue`。

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

- `config.json` 与整个 `data/` 目录含**飞书密钥与个人投资明细**（持仓、交易、快照、备份），已在 `.gitignore` 中**整目录排除**，
  仓库内只保留模板 `config.example.json` 与 `data/holdings.example.json`。
- 如果曾经把 `data/` 里的文件提交过，`.gitignore` 不会把它们从**历史**里删掉，需要额外处理（见下方「数据与隐私」）。
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

### 数据与隐私
- **两种数据模式**：本地（浏览器 IndexedDB，零上传）／服务端（`data/holdings.json`，支持飞书与无人值守任务）
- **一键导出/导入 JSON 全量备份**，导入支持「合并（按市场+代码去重）」与「覆盖」两种策略
- **自动版本快照**：交易数据每次变化前自动留一份旧版本（最多 30 份），可在数据面板回滚
- 超过 7 天未导出备份会自动提醒；清空本地数据需二次确认
- 实时行情由浏览器直连（腾讯报价 + 东财基金净值），持仓数据不经过任何第三方

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
npm test              # node:test 单元 + 集成测试（52 项）
npm run check:local   # 本地数据模式端到端检查（无头 Chrome：导入→行情→持久化→导出→回滚→切模式）
npm run check:pages   # 子路径部署检查（VITE_BASE=/<repo>/ 构建 + 模拟 GitHub Pages 托管 + 可安装性）
npm run check:layout  # 移动端布局度量检查（无头 Chrome）
```

> `check:*` 需要本机安装 Chrome（脚本内路径为 macOS 默认位置）并能访问行情接口。

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
    ↑ 其中 derive/currency/stats/strategy/snapshot(纯函数)/import-csv-core/
      provider/tencent 已迁到 web/src/core/，server 下仅作再导出（避免口径分叉）

web/src/                Vue3 + Vite + Tailwind 前端（构建产物 dist/）
├── App.vue             页签（持仓总览 / 复盘统计）+ 过滤 + 弹窗编排
├── core/               ★ 前后端共享的纯逻辑（浏览器与 Node 均可用）
│   ├── derive.js       账本唯一口径：成本法/手续费/分红/送转/持仓聚合
│   ├── stats.js        收益归因统计
│   ├── strategy.js     策略阈值：止盈/止损/补仓/移动止盈
│   ├── snapshot.js     每日快照生成与合并（纯函数）
│   ├── market.js       各市场交易时段判断（时区/周末/节假日）
│   ├── rates.js        汇率解析（本地设置）
│   ├── quote.js        前端行情：腾讯实时报价 + 东财基金净值（script 注入）
│   ├── schema.js       持仓 schema：新建默认值 / 旧版本迁移 / 变更指纹
│   ├── csv.js          CSV 生成与下载
│   ├── import-csv-core.js CSV 导入核心
│   └── provider/tencent.js 腾讯行情（CORS 已实测可用，浏览器可直连）
├── store/localStore.js ★ 本地数据模式的持久化：IndexedDB + 自动版本快照 + 导入导出
├── services/dataSource.js ★ 双模式门面（local / server），业务代码只依赖它
├── composables/        useHoldings（数据与鉴权）/ useFormat / useTheme / usePwa
├── constants/options.js 枚举（策略/地区/类型/成本法/交易类型）
└── components/         概览卡、分布饼图、趋势、持仓列表/卡片、明细表、
                        复盘统计、新增持仓、交易、买入记录、CSV 导入、数据面板

data/                   holdings.json（个人数据，不入库）+ snapshots.json
                        + backups/（自动备份）+ fx-cache.json + daily-state.json
docs/                   需求 / 计划 / 技术设计 / 盈亏计算规则 / 自测清单 / 优化建议
```

- 技术栈：
  - 前端：Vue3 + Vite + TailwindCSS + ECharts（源码在 `web/`，构建产物 `dist/`）
  - 后端：Node.js（内置 http，零运行时依赖）+ 本地 JSON 存储
  - 行情源：腾讯财经（免 Key）+ 东方财富基金净值
  - 推送：飞书自定义机器人（HMAC-SHA256 签名）
