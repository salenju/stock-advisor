// 纯格式化函数与徽章映射，无副作用、无状态，便于复用与单测
import { INVEST_STRATEGIES, REGION_LABEL } from '../constants/options.js';

export function fmt(v, d = 2) {
  return v == null || Number.isNaN(v) ? '—' : Number(v).toFixed(d);
}

export function fmtMoney(v) {
  return v == null || Number.isNaN(v)
    ? '—'
    : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtPrice(v) {
  return v == null || Number.isNaN(v)
    ? '—'
    : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtQty(v) {
  return v == null || Number.isNaN(v)
    ? '—'
    : Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export function fmtPct(v) {
  return v == null ? '—' : (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%';
}

export function fmtDate(v) {
  return v ? String(v).slice(0, 10) : '—';
}

// 收益红绿：为正用红色（涨），为负用绿色（跌）—— 与 A股习惯一致
export function profitCls(v) {
  return v == null
    ? 'text-base-content/40'
    : v >= 0
    ? 'text-error'
    : 'text-success';
}

export function triggerBadge(state) {
  if (!state || state === 'IDLE') return { text: '待观察', cls: 'badge badge-info' };
  if (state.includes('BUY')) return { text: '买点', cls: 'badge badge-success' };
  if (state.includes('SELL')) return { text: '卖点', cls: 'badge badge-error' };
  if (state.includes('NEAR')) return { text: '临近阈值', cls: 'badge badge-warning' };
  return { text: state, cls: 'badge badge-info' };
}

// 地区别名 → 规范前缀（兼容 CSV 导入的历史中文标签：港股/美股/沪/深/A股）
const REGION_ALIAS = {
  hk: 'hk', 港股: 'hk', 港: 'hk',
  us: 'us', 美股: 'us', 美: 'us',
  sh: 'sh', 沪: 'sh', A股: 'sh',
  sz: 'sz', 深: 'sz',
};

// 地区徽章：仅使用规范色，不出现派生色
export function regionBadge(region) {
  const key = REGION_ALIAS[region] || region;
  const map = {
    hk: { text: '港股', cls: 'badge badge-warning' },
    us: { text: '美股', cls: 'badge badge-info' },
    sh: { text: 'A股', cls: 'badge badge-primary' },
    sz: { text: 'A股', cls: 'badge badge-success' },
  };
  return map[key] || { text: REGION_LABEL[key] || region, cls: 'badge badge-info' };
}

export function strategyBadge(s) {
  return (
    INVEST_STRATEGIES.find((x) => x.value === s) || {
      text: REGION_LABEL[s] || s || '未设置',
      cls: 'badge badge-info',
    }
  );
}
