// 场外基金净值适配器（东方财富数据源）
// 接口：https://api.fund.eastmoney.com/f10/lsjz?callback=jQuery&fundCode=005827&pageIndex=1&pageSize=2
// 返回 JSONP，解析出当日与上一交易日净值
const BASE = 'https://api.fund.eastmoney.com/f10/lsjz';

export async function fetchFundNavs(codes) {
  if (!codes.length) return {};
  const result = {};

  // 逐个查询（东方财富接口单次只支持一个基金）
  for (const code of codes) {
    try {
      const url = `${BASE}?callback=jQuery&fundCode=${code}&pageIndex=1&pageSize=2`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Referer': 'https://fund.eastmoney.com/',
        },
      });
      if (!res.ok) {
        console.warn(`[fund] ${code} http ${res.status}`);
        continue;
      }

      let text = await res.text();
      // 去掉 JSONP 包裹：jQuery(...)
      const m = text.match(/jQuery\((.+)\)$/);
      if (!m) {
        console.warn(`[fund] ${code} 解析失败`);
        continue;
      }
      const data = JSON.parse(m[1]);
      const list = data?.Data?.LSJZList;
      if (!list || list.length === 0) {
        console.warn(`[fund] ${code} 无净值数据`);
        continue;
      }

      // list[0] = 最新净值, list[1] = 上一交易日净值
      const latest = list[0];
      const prev = list[1];
      const price = parseFloat(latest.DWJZ);
      const prevClose = prev ? parseFloat(prev.DWJZ) : null;

      if (!Number.isNaN(price)) {
        result[code] = { price, prevClose: prevClose || null };
      }
    } catch (e) {
      console.warn(`[fund] ${code} ${e.message}`);
    }
  }

  return result;
}
