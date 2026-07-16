// 腾讯财经行情适配器（免 Key、支持批量、覆盖 A股/港股/美股）
// 接口：https://qt.gtimg.cn/q=sh600519,hk00700,usAAPL
// 返回文本如：v_sh600519="1~贵州茅台~600519~当前价~昨收~今开~...";
const BASE = 'https://qt.gtimg.cn/q=';

export async function fetchPrices(codes) {
  if (!codes.length) return {};
  const url = BASE + codes.join(',');
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Referer': 'https://finance.qq.com',
    },
  });
  if (!res.ok) throw new Error(`tencent http ${res.status}`);

  const buf = await res.arrayBuffer();
  let text;
  try {
    text = new TextDecoder('gbk').decode(buf);
  } catch {
    text = new TextDecoder('utf-8').decode(buf);
  }

  const result = {};
  for (const line of text.split(';')) {
    const m = line.match(/v_([A-Za-z0-9]+)="(.*)"/);
    if (!m) continue;
    const code = m[1];
    const parts = m[2].split('~');
    const price = parseFloat(parts[3]); // 第 3 段为当前价（A股/港股/美股通用）
    const prevClose = parseFloat(parts[4]); // 第 4 段为昨收（用于计算今日涨跌）
    if (!Number.isNaN(price)) {
      result[code] = {
        price,
        prevClose: Number.isNaN(prevClose) ? null : prevClose,
      };
    }
  }
  return result;
}
