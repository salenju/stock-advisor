// 腾讯财经行情适配器（免 Key、支持批量、覆盖 A股/港股/美股）
// 接口：https://qt.gtimg.cn/q=sh600519,hk00700,usAAPL
// 返回文本如：v_sh600519="1~贵州茅台~600519~当前价~昨收~今开~...";
const BASE = 'https://qt.gtimg.cn/q=';

// 地区别名 → 行情前缀。
// 兼容旧数据/CSV 导入里存的中文地区标签（港股/美股/沪/深），以及新数据的前缀值（hk/us/sh/sz）。
const REGION_ALIAS = {
  hk: 'hk', 港股: 'hk', 港: 'hk',
  us: 'us', 美股: 'us', 美: 'us',
  sh: 'sh', 沪: 'sh', A股: 'sh',
  sz: 'sz', 深: 'sz',
};

export function normalizeRegion(region) {
  const r = String(region || '').trim();
  return REGION_ALIAS[r] || r;
}

// 去掉代码开头的市场前缀（仅当后面跟数字，如 hk00700 → 00700），美股字母代码如 SKHY 不受影响
function stripCodePrefix(code) {
  return String(code || '').replace(/^(sh|sz|hk|us)(?=\d)/i, '');
}

// 把 (地区, 代码) 转成腾讯行情代码：
//   港股补零到 5 位（1810 → hk01810）；A股 6 位原样（sh600519）；美股字母原样（usAAPL）
export function toTencentCode(region, code) {
  const prefix = normalizeRegion(region);
  const c = stripCodePrefix(code).trim();
  if (prefix === 'hk') return 'hk' + c.padStart(5, '0');
  return prefix + c;
}

// 解析腾讯行情响应文本（已解码）：提取各代码的现价与昨收
// 返回 { code: { price, prevClose } }，无法解析的代码被跳过
export function parseTencentText(text) {
  const result = {};
  for (const line of String(text).split(';')) {
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

  return parseTencentText(text);
}
