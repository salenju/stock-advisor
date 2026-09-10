// 汇率配置：币种 → 兑人民币汇率。
//
// 取值优先级（高 → 低）：
//   1. 环境变量 FX_USD_CNY / FX_HKD_CNY（最高，方便临时覆盖）
//   2. 自动更新缓存（fx.autoUpdate !== false 且缓存未过期，见 provider/fx-live.js）
//   3. config.json 的 fx.rates
//   4. 内置兜底默认值
//
// 说明：自动更新默认开启，每日刷新一次并写入 data/fx-cache.json。
// 若希望始终使用 config.json 里的手工汇率，把 config.fx.autoUpdate 设为 false。

export const CURRENCIES = ['CNY', 'HKD', 'USD'];

// 内置兜底默认值（人民币为基准 = 1）
const DEFAULTS = { CNY: 1, USD: 7.0, HKD: 0.9 };

// 自动更新写入的行情汇率（进程内缓存）
const live = { rates: null, fetchedAt: 0 };

// 缓存有效期：超过则回退到 config（避免长期使用过期汇率）
const LIVE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

export function setLiveRates(rates, fetchedAt = Date.now()) {
  if (rates && Number(rates.USD) > 0 && Number(rates.HKD) > 0) {
    live.rates = { USD: Number(rates.USD), HKD: Number(rates.HKD) };
    live.fetchedAt = Number(fetchedAt) || Date.now();
  }
}

export function getLiveRates() {
  if (!live.rates) return null;
  if (Date.now() - live.fetchedAt > LIVE_MAX_AGE_MS) return null;
  return { ...live.rates, fetchedAt: live.fetchedAt };
}

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

function liveUsable(cfg) {
  if (cfg?.fx?.autoUpdate === false) return null;
  return getLiveRates();
}

export function getRates(cfg) {
  const fxCfg = cfg?.fx?.rates || {};
  const l = liveUsable(cfg);
  const usd = num(process.env.FX_USD_CNY, l ? l.USD : num(fxCfg.USD_CNY, DEFAULTS.USD));
  const hkd = num(process.env.FX_HKD_CNY, l ? l.HKD : num(fxCfg.HKD_CNY, DEFAULTS.HKD));
  return { CNY: 1, USD: usd, HKD: hkd };
}

// 汇率来源与更新时间（供 /api/holdings、/api/health 展示，避免"用的是哪套汇率"说不清）
export function fxInfo(cfg) {
  const fxCfg = cfg?.fx?.rates || {};
  const envUsed = num(process.env.FX_USD_CNY, 0) > 0 || num(process.env.FX_HKD_CNY, 0) > 0;
  const l = liveUsable(cfg);
  const cfgUsed = num(fxCfg.USD_CNY, 0) > 0 || num(fxCfg.HKD_CNY, 0) > 0;
  const source = envUsed ? 'env' : l ? 'live' : cfgUsed ? 'config' : 'default';
  const updatedAt = l ? new Date(l.fetchedAt).toISOString() : null;
  return {
    rates: getRates(cfg),
    source,
    updatedAt,
    autoUpdate: cfg?.fx?.autoUpdate !== false,
  };
}
