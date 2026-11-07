// 东方财富场外基金净值（pingzhongdata）解析。
//
// 页面里是用 <script> 注入拿到的全局变量（api.fund.eastmoney.com 没有 CORS 头），
// Actions 定时任务是在 Node 里直接抓同一份 JS 文本再解析——两种取法共用这里的解析逻辑，
// 保证「页面看到的净值」和「飞书提醒用的净值」是同一个数。

/** 从 pingzhongdata 文本里取出净值序列 [{date, close}]（升序） */
export function parseFundNavSeries(text) {
  const m = String(text ?? '').match(/Data_netWorthTrend\s*=\s*(\[[\s\S]*?\])\s*;/);
  if (!m) return [];
  let arr;
  try {
    arr = JSON.parse(m[1]);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((r) => {
      const ts = Number(r?.x);
      const close = Number(r?.y);
      if (!Number.isFinite(ts) || !Number.isFinite(close)) return null;
      return { date: new Date(ts).toISOString().slice(0, 10), close };
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 最新净值 + 上一交易日净值（用于计算当日涨跌）。
 * @returns {{price:number, prevClose:number|null}|null} 无有效数据返回 null
 */
export function parseFundNavText(text) {
  const bars = parseFundNavSeries(text);
  if (!bars.length) return null;
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  if (!Number.isFinite(last.close) || last.close <= 0) return null;
  return {
    price: last.close,
    prevClose: prev && prev.close > 0 ? prev.close : null,
  };
}
