// 汇率配置（静态）：币种 → 兑人民币汇率。
// 汇率变化不大，不做高频抓取，按以下优先级取值：
//   1. 环境变量：FX_USD_CNY、FX_HKD_CNY（如 FX_USD_CNY=7.1）
//   2. config.json 的 fx.rates（如 { "USD_CNY": 7.1, "HKD_CNY": 0.9 }）
//   3. 内置兜底默认值
// 如需更新汇率：改环境变量或 config.json 后重启即可。

export const CURRENCIES = ['CNY', 'HKD', 'USD'];

// 内置兜底默认值（人民币为基准 = 1）
const DEFAULTS = { CNY: 1, USD: 7.0, HKD: 0.9 };

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

export function getRates(cfg) {
  const fxCfg = cfg?.fx?.rates || {};
  const usd = num(process.env.FX_USD_CNY, num(fxCfg.USD_CNY, DEFAULTS.USD));
  const hkd = num(process.env.FX_HKD_CNY, num(fxCfg.HKD_CNY, DEFAULTS.HKD));
  return { CNY: 1, USD: usd, HKD: hkd };
}
