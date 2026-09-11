// 汇率解析（前端本地数据模式）。
//
// 与 server/provider/fx.js 的语义保持一致：汇率来自「本地设置」，
// 缺失/非法时回落到内置默认值。实时汇率抓取（frankfurter / er-api）在 Phase 2 接入。
export const CURRENCIES = ['CNY', 'HKD', 'USD'];

// 内置兜底默认值（人民币为基准 = 1）
export const DEFAULT_RATES = { CNY: 1, USD: 7.0, HKD: 0.9 };

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

/** 把任意来源的汇率对象规整为 { CNY:1, USD, HKD } */
export function normalizeRates(input) {
  const r = input || {};
  return {
    CNY: 1,
    USD: num(r.USD, DEFAULT_RATES.USD),
    HKD: num(r.HKD, DEFAULT_RATES.HKD),
  };
}

/** 读取本地设置中的汇率（settings.fx.rates） */
export function getRates(settings) {
  return normalizeRates(settings?.fx?.rates);
}

/** 汇率来源说明（前端只区分「自定义」与「默认」） */
export function ratesInfo(settings) {
  const custom = settings?.fx?.rates || {};
  const used = num(custom.USD, 0) > 0 || num(custom.HKD, 0) > 0;
  return {
    rates: getRates(settings),
    source: used ? 'local' : 'default',
    sourceLabel: used ? '本地设置' : '内置默认值',
    updatedAt: settings?.fx?.updatedAt || null,
  };
}
