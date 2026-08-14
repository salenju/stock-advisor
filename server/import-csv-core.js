// CSV 导入核心逻辑（可复用模块）：命令行脚本与 HTTP 接口共用。
// 导入规则：
//   1. 精确匹配：CSV 代码 === holdings.code（如 07709、005827）
//   2. 数字归一化匹配：提取 holdings.code 中的数字与 CSV 代码比较（hk00700 → 700）
// 幂等：每条记录以 (code, 操作, 日期, 数量, 价格) 为唯一键，holdings 中已存在则忽略，否则插入。

// 解析 CSV 文本（支持 BOM、引号包裹、逗号分隔），返回二维数组
export function parseCsvText(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  return lines.map((line) => {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (const ch of line) {
      if (ch === '"') { inQuotes = !inQuotes; continue; }
      if (ch === ',' && !inQuotes) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur);
    return out;
  });
}

// 从代码中提取数字部分（用于归一化匹配）：去前缀字母、去前导零（01810→1810、hk00700→700）
function digitsOf(code) {
  const d = String(code || '').replace(/\D/g, '');
  return d.replace(/^0+(?=\d)/, '') || d;
}

// 日期归一化为 YYYY-MM-DD（补前导零），保证幂等匹配时格式一致
function normalizeDate(date) {
  const s = String(date || '').trim();
  const m = s.match(/^(\d{4})[\-\/\.](\d{1,2})[\-\/\.](\d{1,2})$/);
  if (!m) return s;
  return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
}

// 生成唯一 id（与 server.js 的 pid 风格一致）
function pid() {
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// 买入记录归一化（参照 server.js normalizePurchase）
function normalizePurchase(b) {
  const buyPrice = Number(b.buyPrice);
  const buyQuantity = Number(b.buyQuantity);
  if (!(buyPrice > 0) || !(buyQuantity > 0)) {
    throw new Error(`买入价/买入数量必须为正：${JSON.stringify(b)}`);
  }
  return {
    id: pid(),
    buyPrice,
    buyQuantity,
    buyTime: b.buyTime,
    targetProfitRate: Number(b.targetProfitRate) || 0,
    stopLossRate: Number(b.stopLossRate) || 0,
  };
}

// 按 LIFO 计算卖出成本（参照 server.js applyTransaction）
function computeSellCost(h, qty, sellPrice) {
  const sorted = [...(h.purchases || [])].sort((a, b) =>
    String(b.buyTime).localeCompare(String(a.buyTime))
  );
  let remaining = qty;
  let totalCost = 0;
  for (const p of sorted) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, Number(p.buyQuantity) || 0);
    totalCost += take * (Number(p.buyPrice) || 0);
    remaining -= take;
  }
  if (remaining > 0) {
    throw new Error(`卖出数量(${qty})超过持仓数量，无法匹配成本`);
  }
  const costPrice = totalCost / qty;
  const profit = (sellPrice - costPrice) * qty;
  const returnRate = costPrice > 0 ? ((sellPrice - costPrice) / costPrice) * 100 : 0;
  return { costPrice, profit, returnRate };
}

// 同步汇总字段（参照 server.js syncFromPurchases）
function syncFromPurchases(h) {
  const totalBuy = (h.purchases || []).reduce(
    (s, p) => s + (Number(p.buyPrice) || 0) * (Number(p.buyQuantity) || 0), 0
  );
  const totalBuyQty = (h.purchases || []).reduce(
    (s, p) => s + (Number(p.buyQuantity) || 0), 0
  );
  const totalSellCost = (h.sells || []).reduce(
    (s, sel) => s + (Number(sel.costPrice) || 0) * (Number(sel.sellQuantity) || 0), 0
  );
  const totalSellQty = (h.sells || []).reduce(
    (s, sel) => s + (Number(sel.sellQuantity) || 0), 0
  );
  const remainingCost = Math.max(totalBuy - totalSellCost, 0);
  const remainingQty = Math.max(totalBuyQty - totalSellQty, 0);

  h.cost = remainingCost;
  h.buyQuantity = remainingQty;
  h.position = remainingCost;
  h.avgCost = remainingQty > 0 ? remainingCost / remainingQty : 0;
  h.lastBuyPrice =
    h.purchases.length > 0
      ? [...h.purchases].sort((a, b) => String(b.buyTime).localeCompare(String(a.buyTime)))[0].buyPrice
      : 0;
  // 止盈/止损按成本加权
  let wTarget = 0;
  let wStop = 0;
  if (totalBuy > 0) {
    for (const p of h.purchases || []) {
      const w = (Number(p.buyPrice) || 0) * (Number(p.buyQuantity) || 0);
      wTarget += (Number(p.targetProfitRate) || 0) * w;
      wStop += (Number(p.stopLossRate) || 0) * w;
    }
    wTarget /= totalBuy;
    wStop /= totalBuy;
  }
  h.targetProfitRate = Number(h.targetProfitRate ?? wTarget) || wTarget;
  h.stopLossRate = Number(h.stopLossRate ?? wStop) || wStop;
  // 持仓状态
  const totalBought = (h.purchases || []).reduce((s, p) => s + (Number(p.buyQuantity) || 0), 0);
  const totalSold = (h.sells || []).reduce((s, sel) => s + (Number(sel.sellQuantity) || 0), 0);
  h.status = totalBought === 0 ? (h.status || '持有') : totalSold >= totalBought ? '全部卖出' : '持有';
  h.triggerState = 'IDLE';
  h.notifiedAt = null;
  return h;
}

// 新建持仓（参照 server.js createHolding）
function createHolding(name, code, region, type) {
  const today = new Date().toISOString().slice(0, 10);
  return {
    id: 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: String(name || code).trim(),
    code: String(code).trim(),
    status: '持有',
    region: region || '',
    type: type || '',
    strategy: '',
    snapshotDate: today,
    snapshotProfit: 0,
    snapshotReturnRate: 0,
    position: 0,
    purchases: [],
    sells: [],
    refillDropRate: 0,
    refillPrice: 0,
    nextStrategy: '',
    currentPrice: null,
    prevClose: null,
    lastUpdated: null,
    triggerState: 'IDLE',
    notifiedAt: null,
  };
}

/**
 * 把 CSV 文本按「代码」导入到 holdings 数组（原地修改 holdings）。
 * @param {Array} holdings 现有持仓数组（会被修改）
 * @param {string} csvText CSV 文本内容
 * @param {{ createMissing?: boolean }} [opts]
 * @returns {{ added:number, skipped:number, created:number, createdCodes:Array, missing:Array, errors:Array, total:number }}
 *   - added: 新插入的明细条数；skipped: holdings 中已存在的明细条数（忽略）
 *   - created: 自动新建的持仓只数（仅 createMissing 时）
 *   - missing: 匹配不到持仓且未自动新建的记录
 *   - errors: 导入出错（如卖出数量超持仓）的记录
 * @throws 当 CSV 缺少必需列时抛错
 */
export function importCsvText(holdings, csvText, opts = {}) {
  const { createMissing = false } = opts;
  const rows = parseCsvText(csvText);
  if (!rows.length) return { added: 0, skipped: 0, created: 0, createdCodes: [], missing: [], errors: [], total: 0 };

  const header = rows[0];
  const colIndex = (names) => header.findIndex((h) => names.includes(String(h).trim()));
  const iSeq = colIndex(['序号']);
  const iName = colIndex(['股票/基金名称', '名称']);
  const iCode = colIndex(['代码']);
  const iRegion = colIndex(['地区']);
  const iType = colIndex(['类型']);
  const iOper = colIndex(['操作']);
  const iDate = colIndex(['买入日期', '卖出日期', '日期']);
  const iQty = colIndex(['买入数量', '卖出数量', '数量']);
  const iPrice = colIndex(['买入价', '卖出价', '价格']);
  if (iCode < 0 || iOper < 0 || iDate < 0 || iQty < 0 || iPrice < 0) {
    throw new Error(`CSV 表头缺少必需列（需包含：代码 / 操作 / 日期 / 数量 / 价格）。当前表头：${header.join(',')}`);
  }

  // 解析 CSV 数据行
  const records = [];
  for (const r of rows.slice(1)) {
    const code = String(r[iCode] || '').trim();
    const oper = String(r[iOper] || '').trim();
    const date = String(r[iDate] || '').trim();
    const qty = Number(r[iQty]);
    const price = Number(r[iPrice]);
    if (!code || !oper || !date || !(qty > 0) || !(price > 0)) continue; // 跳过空行/非法行
    records.push({
      seq: r[iSeq]?.trim(),
      name: r[iName]?.trim(),
      code,
      region: r[iRegion]?.trim(),
      type: r[iType]?.trim(),
      oper: oper.includes('卖') ? 'SELL' : 'BUY',
      date: normalizeDate(date),
      qty,
      price,
    });
  }

  // 建立代码 → 持仓映射（含数字归一化兜底）
  const byExact = new Map();
  const byDigits = new Map();
  for (const h of holdings) {
    byExact.set(String(h.code), h);
    const d = digitsOf(h.code);
    if (d && !byDigits.has(d)) byDigits.set(d, h);
  }
  const resolveHolding = (code) => {
    if (byExact.has(code)) return byExact.get(code);
    const d = digitsOf(code);
    return d ? byDigits.get(d) : undefined;
  };

  // 幂等：holdings 中已有同 (日期,数量,价格) 的记录则忽略
  const existingKey = (h, oper, date, qty, price) => {
    const list = oper === 'BUY' ? h.purchases : h.sells;
    return (list || []).some((x) => {
      const xPrice = oper === 'BUY' ? Number(x.buyPrice) : Number(x.sellPrice);
      const xQty = oper === 'BUY' ? Number(x.buyQuantity) : Number(x.sellQuantity);
      const xDate = oper === 'BUY' ? x.buyTime : x.sellDate;
      return (
        Math.abs(Number(xPrice) - price) < 1e-9 &&
        Math.abs(Number(xQty) - qty) < 1e-9 &&
        String(xDate) === String(date)
      );
    });
  };

  let added = 0;
  let skipped = 0;
  let created = 0;
  const createdCodes = [];
  const missing = [];
  const errors = [];
  const seenCreatedCode = new Set();

  for (const rec of records) {
    let h = resolveHolding(rec.code);
    // 匹配不到时，若允许则按「地区/类型」新建持仓
    if (!h && createMissing) {
      const newH = createHolding(rec.name, rec.code, rec.region, rec.type);
      holdings.push(newH);
      byExact.set(String(rec.code), newH);
      const d = digitsOf(rec.code);
      if (d && !byDigits.has(d)) byDigits.set(d, newH);
      if (!seenCreatedCode.has(String(rec.code))) {
        seenCreatedCode.add(String(rec.code));
        createdCodes.push(newH);
        created++;
      }
      h = newH;
    }
    if (!h) {
      missing.push(rec);
      continue;
    }
    if (existingKey(h, rec.oper, rec.date, rec.qty, rec.price)) {
      skipped++;
      continue;
    }
    try {
      if (rec.oper === 'BUY') {
        h.purchases = h.purchases || [];
        h.purchases.push(
          normalizePurchase({
            buyPrice: rec.price,
            buyQuantity: rec.qty,
            buyTime: rec.date,
            targetProfitRate: h.targetProfitRate || 0,
            stopLossRate: h.stopLossRate || 0,
          })
        );
      } else {
        h.sells = h.sells || [];
        const { costPrice, profit, returnRate } = computeSellCost(h, rec.qty, rec.price);
        h.sells.push({
          id: pid(),
          sellPrice: rec.price,
          sellQuantity: rec.qty,
          sellDate: rec.date,
          costPrice,
          profit,
          returnRate,
        });
      }
      syncFromPurchases(h);
      added++;
    } catch (e) {
      errors.push({ rec, message: e.message });
    }
  }

  return { added, skipped, created, createdCodes, missing, errors, total: records.length };
}
