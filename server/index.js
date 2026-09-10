import { loadConfig } from './config.js';
import { runOnce, startScheduler } from './scheduler.js';
import { startServer } from './server.js';
import { configureStore } from './store.js';
import { configureLogger, logger } from './logger.js';
import { loadFxCache } from './provider/fx-live.js';
import { fxInfo } from './provider/fx.js';

const cfg = await loadConfig();

// 先注入配置（备份策略 / 日志目录），再做任何读写
configureStore(cfg);
configureLogger(cfg);

// 载入上次的汇率缓存（避免重启后立刻打一次网络请求）
await loadFxCache();

logger.info(`股票秘书启动，刷新间隔 ${cfg.schedule.intervalSeconds} 秒`);

const fx = fxInfo(cfg);
logger.info(
  `汇率来源 ${fx.source}：USD/CNY=${fx.rates.USD}，HKD/CNY=${fx.rates.HKD}` +
    (fx.updatedAt ? `（更新于 ${fx.updatedAt}）` : '')
);

// 启动前安全体检：监听非回环地址却没设 token 时明确告警
const host = cfg.server?.host || '127.0.0.1';
const token = String(cfg.auth?.token || '').trim();
if (!token && host !== '127.0.0.1' && host !== 'localhost') {
  logger.warn(
    `⚠️ 服务监听 ${host}:${cfg.server?.port ?? 3000} 且未设置 auth.token，` +
      `局域网内任何人都能读取/修改你的投资数据。请在 config.json 设置 auth.token，或把 host 改回 127.0.0.1。`
  );
}

// 启动前端页面 + 接口（默认 http://127.0.0.1:3000）
startServer(cfg);

// 启动行情抓取 / 策略 / 推送调度
if (process.env.ONCE) {
  await runOnce(cfg);
  process.exit(0);
}
startScheduler(cfg);
