# 股票秘书

## 需求
- 记录：
股票/基金名称
状态：持有/已卖出
地区: 港股/美股/A股
仓位
持仓盈亏
类型:股票/股票型基金/债券型基金/货币型基金/ETF
截止/7/5收益
截止7/5收益率
预期止盈收益率/%
买入时间
买入价格
买入数量
成本
最近一次购买价格
补仓降幅/%
下阶段策略
补仓价格
- 实时获取对应股票的价格信息，快达到阈值的时候触发飞书机器人提醒我购买或卖出，并把买点或卖点一起发给飞书机器人

---

## 运行说明

环境：Node.js >= 18（已验证 v18.20.2）。

### 一键启动（推荐）

```bash
cd 股票秘书
# 1. 填入你的飞书机器人 webhook 与 secret（config.json）
# 2. 启动

./start.sh               # 生产模式 → http://127.0.0.1:3000（后端托管前端 + 行情调度）
./start.sh dev           # 开发模式 → http://localhost:5173（后端 + Vite HMR，/api 代理到 :3000）
```

脚本会自动检查 Node.js 版本、安装依赖、构建前端（生产模式），一行命令跑起全部。

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

### 分步手动操作

```bash
cd 股票秘书
npm install          # 安装前端依赖（vue / vite / tailwind）
npm run build        # 构建前端到 dist/（Node 服务会托管它）
# 1. 填入你的飞书机器人 webhook 与 secret（config.json）
# 2. 启动后访问 http://127.0.0.1:3000 在前端页面录入/管理持仓（也可手改 data/holdings.json）
npm start            # 常驻运行：托管前端 + 行情调度（每 20 秒一轮）
ONCE=1 node server/index.js   # 只跑一轮调度，便于本地验证

# 开发模式（带热更新）：另开一个终端跑后端，再跑 Vite 开发服务器
npm start            # 终端 A：后端 + API（:3000）
npm run dev          # 终端 B：Vite 开发服务器（:5173，/api 代理到 :3000）
# 开发时浏览器打开 http://localhost:5173
```

### 一键导入 CSV 买卖记录

前端页面顶部「**导入 CSV**」按钮即可一键导入：选择 CSV 文件 → 勾选「自动新建持仓」（可选）→ 开始导入，实时展示导入结果。

命令行方式同样可用：

```bash
npm run import:csv               # 仅导入 CSV 中能匹配到现有持仓的记录
npm run import:csv:new           # 匹配不到时自动新建持仓（例如小米 1810）
node server/import-csv.js <csv>  # 导入指定路径的 CSV
```

CSV 需包含列：`代码`、`操作`（买入/卖出）、`买入日期`、`买入数量`、`买入价`。匹配规则：

1. **精确匹配**：CSV 代码 === `holdings.code`（如 `07709`、`005827`）
2. **数字归一化**：提取 `holdings.code` 中的数字比对（`hk00700` → `700`）

- 买入 → 追加到该持仓 `purchases[]`（止盈/止损沿用持仓当前值）
- 卖出 → 追加到 `sells[]`，按 LIFO 自动计算成本均价、盈亏、收益率
- 导入后自动重算汇总字段（成本、数量、均价、最近买入价、状态）
- **幂等**：以 `(代码, 操作, 日期, 数量, 价格)` 为唯一键，重复导入自动跳过

> 建议导入前先备份 `data/holdings.json`。已内置：`data/holdings-before-import.json`。

### 配置（config.json）
- `schedule.intervalSeconds`：交易时段刷新间隔（默认 20 秒）
- `schedule.offHoursIntervalSeconds`：非交易时段自动降频（默认 300 秒），任一持仓市场开盘即恢复 20 秒
- `feishu.webhook` / `feishu.secret`：飞书自定义机器人地址与签名密钥（已启用 secret）
- `notify.cooldownSeconds`：同一品种提醒冷却（默认 3600 秒，防刷屏）
- `notify.nearThresholdPct`：距阈值多近算"快达到"（默认 2%）

### 目录
- `server/provider/tencent.js`：腾讯财经行情（免 Key，批量，覆盖 A股/港股/美股）
- `server/strategy.js`：止盈（基于成本）/ 补仓（基于最近买入价）阈值判断
- `server/notifier.js`：飞书推送（interactive 富文本卡片 + HMAC-SHA256 签名）
- `server/scheduler.js`：抓取 → 判断 → 推送 主循环
- `server/server.js`：HTTP 服务（托管前端 dist/ + 持仓/交易 REST 接口）
- `web/`：前端源码（Vue3 + Vite + TailwindCSS，`npm run build` 打包到 `dist/`）
- `vite.config.js` / `tailwind.config.js` / `postcss.config.js`：前端构建配置
- 设计文档见 `docs/`（需求 / 计划 / 技术设计）

### 前端页面
启动后浏览器打开 `http://127.0.0.1:3000`：
- 表格展示全部持仓（含实时价、收益率、触发态，每 20 秒自动刷新）
- 「添加持仓」新建一笔建仓记录
- 每行「买入 / 卖出」按钮，对已有持仓追加交易（自动重算成本、数量、最近买入价、状态）

### REST 接口
- `GET /api/holdings`：列表（含派生字段 收益率/跌幅）
- `POST /api/holdings`：新建持仓（买入建仓）
- `POST /api/holdings/:id/transactions`：对指定持仓追加 `{type:'BUY'|'SELL', price, quantity, date?}` 交易
- `POST /api/import-csv`：批量导入 CSV 买卖记录，`{csv: string, createMissing?: boolean}`，返回导入统计（新增/忽略/新建持仓/匹配不到/出错）
- `POST /api/test-feishu`：发送一条测试卡片消息到飞书机器人（前端「测试飞书」按钮调用；需已在 config.json 配置真实 webhook/secret，否则返回 502）

- 技术栈：
- 前端：Vue3 + Vite + TailwindCSS（源码在 `web/`，构建产物 `dist/`）
- 后端：Node.js（内置 http，零运行时依赖）+ 本地 JSON 存储
- 行情源：腾讯财经（免 Key）
- 推送：飞书自定义机器人（HMAC-SHA256 签名）