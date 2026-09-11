// 各市场交易时段判断（时区感知 + 周末 + 法定节假日）。
// server/scheduler.js 与前端「本地数据模式」共用，保证"是否开盘"判断一致。
import { normalizeRegion } from './provider/tencent.js';

// 各市场对应时区
export const REGION_TZ = {
  hk: 'Asia/Hong_Kong',
  sh: 'Asia/Shanghai',
  sz: 'Asia/Shanghai',
  us: 'America/New_York',
};

// 取某时区下的本地 周几/时/分/日期
function marketLocal(date, tz) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return {
    isWeekend: get('weekday') === 'Sat' || get('weekday') === 'Sun',
    h: parseInt(get('hour'), 10),
    m: parseInt(get('minute'), 10),
    date: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

function inRange(h, m, sH, sM, eH, eM) {
  const t = h * 60 + m;
  return t >= sH * 60 + sM && t <= eH * 60 + eM;
}

// 该市场当日是否为休市日（法定节假日，形如 { sh: ['2026-10-01'] }）
export function isHoliday(region, dateStr, holidays) {
  const list = holidays?.[region];
  return Array.isArray(list) && list.includes(dateStr);
}

/**
 * 判断某市场此刻是否处于交易时段。
 * @param {string} region 地区前缀（hk/sh/sz/us，兼容中文标签）
 * @param {Date} date
 * @param {Object} [holidays] { sh:[], sz:[], hk:[], us:[] } 休市日 YYYY-MM-DD 列表
 */
export function isMarketOpen(region, date, holidays) {
  const r = normalizeRegion(region); // 兼容中文地区标签（港股→hk 等）
  const tz = REGION_TZ[r];
  if (!tz) return false;
  const { isWeekend, h, m, date: localDate } = marketLocal(date, tz);
  if (isWeekend) return false;
  if (isHoliday(r, localDate, holidays)) return false;
  if (r === 'sh' || r === 'sz') return inRange(h, m, 9, 30, 11, 30) || inRange(h, m, 13, 0, 15, 0);
  if (r === 'hk') return inRange(h, m, 9, 30, 12, 0) || inRange(h, m, 13, 0, 16, 0);
  if (r === 'us') return inRange(h, m, 9, 30, 16, 0);
  return false;
}

/** 是否有任一（在仓）持仓的市场当前处于交易时段 */
export function anyMarketOpen(holdings, now = new Date(), holidays) {
  return (holdings || []).some((h) => isMarketOpen(h.region, now, holidays));
}

/** 北京时间（用于"每日快照 / 日报"的定时判定） */
export function beijingNow(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10),
  };
}

/** 'HH:MM' → 分钟数；非法时回落到 fallback（默认 23:59） */
export function parseHHMM(s, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  if (!m) return parseHHMM(fallback, '23:59');
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}
