import { loadConfig } from './config.js';
import { runOnce, startScheduler } from './scheduler.js';
import { startServer } from './server.js';

const cfg = await loadConfig();
console.log(`股票秘书启动，刷新间隔 ${cfg.schedule.intervalSeconds} 秒`);

// 启动前端页面 + 接口（默认 http://127.0.0.1:3000）
startServer(cfg);

// 启动行情抓取 / 策略 / 推送调度
if (process.env.ONCE) {
  await runOnce(cfg);
  process.exit(0);
}
startScheduler(cfg);
