import { loadHoldings, saveHoldings } from './store.js';
import { fetchPrices } from './provider/tencent.js';
import { fetchFundNavs } from './provider/fund.js';
import { evaluate } from './strategy.js';
import { sendCard } from './notifier.js';

// 各市场对应时区（用于判断交易时段）
const REGION_TZ = {
  hk: 'Asia/Hong_Kong',
  sh: 'Asia/Shanghai',
  sz: 'Asia/Shanghai',
  us: 'America/New_York',
};

// 取某时区下的本地 周几/时/分
function marketLocal(date, tz) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return {
    isWeekend: get('weekday') === 'Sat' || get('weekday') === 'Sun',
    h: parseInt(get('hour'), 10),
    m: parseInt(get('minute'), 10),
  };
}

function inRange(h, m, sH, sM, eH, eM) {
  const t = h * 60 + m;
  return t >= sH * 60 + sM && t <= eH * 60 + eM;
}

// 判断某市场此刻是否处于交易时段（简化：未含法定节假日）
function isMarketOpen(region, date) {
  const { isWeekend, h, m } = marketLocal(date, REGION_TZ[region]);
  if (isWeekend) return false;
  if (region === 'sh' || region === 'sz')
    return inRange(h, m, 9, 30, 11, 30) || inRange(h, m, 13, 0, 15, 0);
  if (region === 'hk')
    return inRange(h, m, 9, 30, 12, 0) || inRange(h, m, 13, 0, 16, 0);
  if (region === 'us') return inRange(h, m, 9, 30, 16, 0);
  return false;
}

// 是否有任一持仓市场当前处于交易时段
function anyMarketOpen(holdings, now) {
  return holdings
    .filter((h) => h.status === '持有')
    .some((h) => isMarketOpen(h.region, now));
}

export { isMarketOpen, anyMarketOpen };

// 根据是否交易时段选择刷新间隔（秒）
function pickInterval(cfg, open) {
  return open
    ? cfg.schedule.intervalSeconds
    : cfg.schedule.offHoursIntervalSeconds ?? 300;
}

export async function runOnce(cfg) {
  const holdings = await loadHoldings();
  const active = holdings.filter((h) => h.status === '持有');
  const now = new Date();
  const open = anyMarketOpen(holdings, now);
  const mode = open ? '交易时段' : '非交易时段(降频)';

  // 按类型分流：基金走东方财富净值 API，股票走腾讯行情 API
  const isFund = (h) => h.type && h.type.includes('基金');
  const stockCodes = active.filter((h) => !isFund(h)).map((h) => h.region + h.code);
  const fundCodes = active.filter((h) => isFund(h)).map((h) => h.code);

  const [stockPrices, fundPrices] = await Promise.all([
    fetchPrices(stockCodes).catch((e) => {
      console.error('[stock-fetch]', e.message);
      return {};
    }),
    fetchFundNavs(fundCodes).catch((e) => {
      console.error('[fund-fetch]', e.message);
      return {};
    }),
  ]);
  const prices = { ...stockPrices, ...fundPrices };

  let changed = false;
  for (const h of active) {
    const key = isFund(h) ? h.code : h.region + h.code;
    const q = prices[key];
    if (!q || q.price == null) {
      console.warn(`[skip] ${h.code} 无行情`);
      continue;
    }
    h.currentPrice = q.price;
    h.prevClose = q.prevClose;
    h.lastUpdated = now.toISOString();

    // ---------- 日涨跌告警（DAILY_DROP / DAILY_RISE）----------
    const todayDate = now.toISOString().slice(0, 10);
    const todayReturnRate = q.prevClose > 0 ? ((q.price - q.prevClose) / q.prevClose) * 100 : 0;

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
          currentPrice: q.price,
          advice: `今日${dailyTrigger === 'DAILY_RISE' ? '涨幅' : '跌幅'} ${change}，超出告警阈值，请注意风险。`,
          summary: `今日${change} · 阈值触发`,
        }).catch((e) => console.error('[notify-daily]', e.message));
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
      currentPrice: price,
      advice: r.advice,
      summary,
    }).catch((e) => console.error('[notify]', e.message));

    h.triggerState = r.trigger;
    h.notifiedAt = now.toISOString();
    changed = true;
  }

  if (changed) await saveHoldings(holdings);
  console.log(
    `[tick] ${now.toISOString()} [${mode}] 持仓 ${active.length} 只，已更新状态`
  );
  return open;
}

export function startScheduler(cfg) {
  const loop = () => {
    runOnce(cfg)
      .then((open) => {
        const interval = pickInterval(cfg, open);
        setTimeout(loop, interval * 1000);
      })
      .catch(() => setTimeout(loop, cfg.schedule.intervalSeconds * 1000));
  };
  loop();
}
