import { loadHoldings, saveHoldings } from './store.js';
import { fetchPrices, toTencentCode } from './provider/tencent.js';
import { fetchFundNavs } from './provider/fund.js';
import { evaluate, updatePeak } from './strategy.js';
import { sendCard } from './notifier.js';
import { getRates } from './provider/fx.js';
import { refreshLiveRates } from './provider/fx-live.js';
import { buildSnapshot, upsertSnapshot, loadSnapshots, loadDailyState, saveDailyState } from './snapshot.js';
import { logger } from './logger.js';
import { runtime, markPush } from './runtime.js';
import { isActive } from './derive.js';
import { isMarketOpen, anyMarketOpen, beijingNow, parseHHMM } from '../web/src/core/market.js';

// 交易时段判断 + 北京时间工具已抽到前后端共享模块（web/src/core/market.js），
// 前端「本地数据模式」用的是同一份实现，保证"是否开盘"的判定一致。
export { isMarketOpen, anyMarketOpen };

// 根据是否交易时段选择刷新间隔（秒）
function pickInterval(cfg, open) {
  return open
    ? cfg.schedule.intervalSeconds
    : cfg.schedule.offHoursIntervalSeconds ?? 300;
}

// ---------- 主循环 ----------

export async function runOnce(cfg) {
  const t0 = Date.now();
  const okBase = runtime.quoteOk;
  const failBase = runtime.quoteFail;
  const holdings = await loadHoldings();
  const active = holdings.filter(isActive);
  const now = new Date();
  const holidays = cfg.schedule?.marketHolidays;
  const open = anyMarketOpen(holdings, now, holidays);
  const mode = open ? '交易时段' : '非交易时段(降频)';

  // 按类型分流：基金走东方财富净值 API，股票走腾讯行情 API
  const isFund = (h) => h.type && h.type.includes('基金');
  const stockCodes = active.filter((h) => !isFund(h)).map((h) => toTencentCode(h.region, h.code));
  const fundCodes = active.filter((h) => isFund(h)).map((h) => h.code);

  const [stockPrices, fundPrices] = await Promise.all([
    fetchPrices(stockCodes).catch((e) => {
      logger.error('[stock-fetch]', e.message);
      runtime.quoteFail += 1;
      runtime.lastQuoteError = `股票行情：${e.message}`;
      return {};
    }),
    fetchFundNavs(fundCodes).catch((e) => {
      logger.error('[fund-fetch]', e.message);
      runtime.quoteFail += 1;
      runtime.lastQuoteError = `基金净值：${e.message}`;
      return {};
    }),
  ]);
  const prices = { ...stockPrices, ...fundPrices };

  // 异常波动阈值：单日涨跌幅超过该值视为行情源异常，跳过本轮判断
  const maxMove = Number(cfg.notify?.maxDailyMovePct) > 0 ? Number(cfg.notify.maxDailyMovePct) : 50;

  let changed = false;
  for (const h of active) {
    const key = isFund(h) ? h.code : toTencentCode(h.region, h.code);
    const q = prices[key];
    // 防御①：无行情 / 价格为 0（停牌、字段缺失）一律跳过，避免用 0 价触发错误提醒
    if (!q || !(Number(q.price) > 0)) {
      runtime.quoteFail += 1;
      logger.warn(`[skip] ${h.code} 无有效行情（停牌或行情源异常）`);
      continue;
    }
    // 防御②：单日涨跌幅异常（多为行情源错价）时跳过判断
    const prevClose = Number(q.prevClose);
    const moveRate = prevClose > 0 ? ((Number(q.price) - prevClose) / prevClose) * 100 : 0;
    if (prevClose > 0 && Math.abs(moveRate) > maxMove) {
      runtime.quoteFail += 1;
      runtime.lastQuoteError = `${h.code} 单日波动 ${moveRate.toFixed(2)}% 超阈值 ${maxMove}%，已跳过`;
      logger.warn(`[skip] ${h.code} 单日波动 ${moveRate.toFixed(2)}% 超过 ${maxMove}%，疑似错价`);
      continue;
    }

    runtime.quoteOk += 1;
    h.currentPrice = Number(q.price);
    h.prevClose = prevClose > 0 ? prevClose : null;
    h.lastUpdated = now.toISOString();

    // 移动止盈基准：记录持仓期最高收益率
    if (updatePeak(h)) changed = true;

    // ---------- 日涨跌告警（DAILY_RISE / DAILY_DROP）----------
    const todayDate = now.toISOString().slice(0, 10);
    const todayReturnRate = h.prevClose > 0 ? ((h.currentPrice - h.prevClose) / h.prevClose) * 100 : 0;

    if (h.dailyDropAlertPct != null || h.dailyRiseAlertPct != null) {
      let dailyTrigger = null;
      if (h.dailyRiseAlertPct != null && todayReturnRate >= h.dailyRiseAlertPct) {
        dailyTrigger = 'DAILY_RISE';
      } else if (h.dailyDropAlertPct != null && todayReturnRate <= -Math.abs(h.dailyDropAlertPct)) {
        dailyTrigger = 'DAILY_DROP';
      }
      if (dailyTrigger && h.dailyAlertSentDate !== todayDate) {
        const change = dailyTrigger === 'DAILY_RISE' ? `+${todayReturnRate.toFixed(2)}%` : `${todayReturnRate.toFixed(2)}%`;
        await sendCard(cfg, {
          name: h.name, region: h.region, type: h.type, code: h.code,
          trigger: dailyTrigger,
          currentPrice: h.currentPrice,
          advice: `今日${dailyTrigger === 'DAILY_RISE' ? '涨幅' : '跌幅'} ${change}，超出告警阈值，请注意风险。`,
          summary: `今日${change} · 阈值触发`,
        })
          .then(() => markPush(true))
          .catch((e) => {
            markPush(false, e.message);
            logger.error('[notify-daily]', e.message);
          });
        h.dailyAlertSentDate = todayDate;
        changed = true;
      }
    }

    const r = evaluate(h, cfg.notify.nearThresholdPct);
    if (r.trigger === 'NONE') {
      if (h.triggerState !== 'IDLE') {
        h.triggerState = 'IDLE';
        changed = true;
      }
      continue;
    }

    // 冷却：同一触发态且在冷却窗口内则跳过，避免刷屏
    const inCooldown =
      h.notifiedAt &&
      h.triggerState === r.trigger &&
      now.getTime() - new Date(h.notifiedAt).getTime() <
        cfg.notify.cooldownSeconds * 1000;
    if (inCooldown) continue;

    const summary = `成本 ${h.cost}，仓位 ${h.position}`;
    await sendCard(cfg, {
      name: h.name,
      region: h.region,
      type: h.type,
      code: h.code,
      trigger: r.trigger,
      reason: r.reason,
      currentPrice: h.currentPrice,
      advice: r.advice,
      summary,
    })
      .then(() => markPush(true))
      .catch((e) => {
        markPush(false, e.message);
        logger.error('[notify]', e.message);
      });

    h.triggerState = r.trigger;
    h.notifiedAt = now.toISOString();
    changed = true;
  }

  if (changed) await saveHoldings(holdings);

  runtime.lastTickAt = now.toISOString();
  runtime.lastTickMode = mode;
  runtime.lastTickMs = Date.now() - t0;
  runtime.lastTickQuoteOk = runtime.quoteOk - okBase;
  runtime.lastTickQuoteFail = runtime.quoteFail - failBase;
  logger.info(
    `[tick] ${now.toISOString()} [${mode}] 持仓 ${active.length} 只，行情成功 ${runtime.lastTickQuoteOk}，耗时 ${runtime.lastTickMs}ms`
  );

  // 每日快照 / 日报 / 汇率刷新（北京时间定时，幂等去重）
  await runDailyJobs(cfg, holdings, now);

  return open;
}

// ---------- 每日任务：快照 / 日报 / 汇率 ----------

async function runDailyJobs(cfg, holdings, now) {
  const sched = cfg.schedule || {};
  const state = await loadDailyState();
  const bj = beijingNow(now);

  // 汇率：每日刷新一次
  if (cfg.fx?.autoUpdate !== false) {
    const fxTarget = parseHHMM(`${String(cfg.fx?.updateHour ?? 8).padStart(2, '0')}:00`, '08:00');
    if (bj.minutes >= fxTarget && state.fxDate !== bj.date) {
      const r = await refreshLiveRates();
      state.fxDate = bj.date;
      if (r.ok) {
        runtime.fxUpdatedAt = r.updatedAt;
        runtime.fxSource = 'live';
        runtime.fxError = null;
        logger.info(`[fx] 汇率已更新 USD/CNY=${r.rates.USD.toFixed(4)} HKD/CNY=${r.rates.HKD.toFixed(4)}`);
      } else {
        runtime.fxError = r.error;
        logger.warn('[fx] 汇率更新失败，沿用现有配置：', r.error);
      }
      await saveDailyState(state);
    }
  }

  // 每日快照
  if (sched.snapshot !== false) {
    const target = parseHHMM(sched.snapshotAt, '16:10');
    if (bj.minutes >= target && state.snapshotDate !== bj.date) {
      const rates = getRates(cfg);
      const snap = buildSnapshot(holdings, rates, bj.date);
      await upsertSnapshot(snap);
      state.snapshotDate = bj.date;
      runtime.lastSnapshotDate = bj.date;
      await saveDailyState(state);
      logger.info(`[snapshot] 已记录 ${bj.date} 组合快照：市值 ${snap.marketValue}，持仓收益 ${snap.holdingProfit}`);
    }
  }

  // 每日收盘日报（飞书）
  if (sched.dailyReport !== false) {
    const target = parseHHMM(sched.dailyReportAt, '16:15');
    if (bj.minutes >= target && state.reportDate !== bj.date) {
      const rates = getRates(cfg);
      const snap = buildSnapshot(holdings, rates, bj.date);
      const snaps = await loadSnapshots();
      await sendCard(cfg, {
        trigger: 'DAILY_REPORT',
        date: bj.date,
        snapshot: snap,
        history: snaps.slice(-5),
        summary: `${bj.date} 收盘日报`,
      })
        .then(() => markPush(true))
        .catch((e) => {
          markPush(false, e.message);
          logger.error('[notify-daily-report]', e.message);
        });
      state.reportDate = bj.date;
      runtime.lastReportDate = bj.date;
      await saveDailyState(state);
      logger.info(`[report] 已推送 ${bj.date} 收盘日报`);
    }
  }
}

export function startScheduler(cfg) {
  const loop = () => {
    runOnce(cfg)
      .then((open) => {
        const interval = pickInterval(cfg, open);
        setTimeout(loop, interval * 1000);
      })
      .catch((e) => {
        logger.error('[tick] 调度异常：', e.message);
        setTimeout(loop, cfg.schedule.intervalSeconds * 1000);
      });
  };
  loop();
}
