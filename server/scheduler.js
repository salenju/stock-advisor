import { loadHoldings, saveHoldings } from './store.js';
import { fetchPrices } from './provider/tencent.js';
import { evaluate } from './strategy.js';
import { sendCard } from './notifier.js';

// 各市场对应时区（用于判断交易时段）
const REGION_TZ = {
  'A股': 'Asia/Shanghai',
  '港股': 'Asia/Hong_Kong',
  '美股': 'America/New_York',
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
  if (region === 'A股')
    return inRange(h, m, 9, 30, 11, 30) || inRange(h, m, 13, 0, 15, 0);
  if (region === '港股')
    return inRange(h, m, 9, 30, 12, 0) || inRange(h, m, 13, 0, 16, 0);
  if (region === '美股') return inRange(h, m, 9, 30, 16, 0);
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

  const prices = await fetchPrices(active.map((h) => h.code)).catch((e) => {
    console.error('[fetch]', e.message);
    return {};
  });

  let changed = false;
  for (const h of active) {
    const q = prices[h.code];
    if (!q || q.price == null) {
      console.warn(`[skip] ${h.code} 无行情`);
      continue;
    }
    h.currentPrice = q.price;
    h.prevClose = q.prevClose;
    h.lastUpdated = now.toISOString();

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
