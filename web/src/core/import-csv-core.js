// CSV 导入核心逻辑（可复用模块）：命令行脚本与 HTTP 接口共用。
//
// 导入规则：
//   1. 精确匹配：CSV 代码 === holdings.code（如 07709、005827）
//   2. 数字归一化匹配：提取 holdings.code 中的数字与 CSV 代码比较（hk00700 → 700）
// 幂等：每条记录以 (code, 操作, 日期, 数量, 价格) 为唯一键，holdings 中已存在则忽略，否则插入。
//
// 支持的「操作」列取值：买入 / 卖出 / 分红 / 送转（送股、拆股同义）。
// 台账口径统一由 derive.js 提供，避免导入路径与页面录入路径算出不同结果。
import { applyTransaction, normalizeCostMethod, dateKey } from './derive.js';

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

// 新建持仓（与 server.js createHolding 对齐的最小字段集）
function createHolding(name, code, region, type, costMethod) {
  const today = new Date().toISOString().slice(0, 10);
  return {
    id: 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: String(name || code).trim(),
    code: String(code).trim(),
    status: '持有',
    region: region || '',
    type: type || '',
    strategy: '',
    costMethod: normalizeCostMethod(costMethod),
    snapshotDate: today,
    snapshotProfit: 0,
    snapshotReturnRate: 0,
    position: 0,
    purchases: [],
    sells: [],
    dividends: [],
    splits: [],
    refillDropRate: 0,
    refillPrice: 0,
    nextStrategy: '',
    trailingStopPct: null,
    peakReturnRate: null,
    dailyDropAlertPct: null,
    dailyRiseAlertPct: null,
    dailyAlertSentDate: null,
    currentPrice: null,
    prevClose: null,
    lastUpdated: null,
    triggerState: 'IDLE',
    notifiedAt: null,
  };
}

// 操作列 → 交易类型
function parseOper(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (s.includes('卖')) return 'SELL';
  if (s.includes('分红') || s.includes('红利') || s.includes('派息')) return 'DIVIDEND';
  if (s.includes('送转') || s.includes('送股') || s.includes('转增') || s.includes('拆')) return 'SPLIT';
  if (s.includes('买')) return 'BUY';
  return null;
}

// 幂等键：(类型, 日期, 数量/金额/比例, 价格)
function existingKey(h, oper, rec) {
  if (oper === 'DIVIDEND') {
    return (h.dividends || []).some(
      (x) => dateKey(x.date) === rec.date && Math.abs(Number(x.amount) - rec.amount) < 1e-9
    );
  }
  if (oper === 'SPLIT') {
    return (h.splits || []).some(
      (x) => dateKey(x.date) === rec.date && Math.abs(Number(x.ratio) - rec.ratio) < 1e-9
    );
  }
  const list = oper === 'BUY' ? h.purchases : h.sells;
  return (list || []).some((x) => {
    const xPrice = oper === 'BUY' ? Number(x.buyPrice) : Number(x.sellPrice);
    const xQty = oper === 'BUY' ? Number(x.buyQuantity) : Number(x.sellQuantity);
    const xDate = oper === 'BUY' ? x.buyTime : x.sellDate;
    return (
      Math.abs(Number(xPrice) - rec.price) < 1e-9 &&
      Math.abs(Number(xQty) - rec.qty) < 1e-9 &&
      dateKey(xDate) === rec.date
    );
  });
}

/**
 * 把 CSV 文本按「代码」导入到 holdings 数组（原地修改 holdings）。
 * @param {Array} holdings 现有持仓数组（会被修改）
 * @param {string} csvText CSV 文本内容
 * @param {{ createMissing?: boolean, costMethod?: string }} [opts]
 * @returns {{ added:number, skipped:number, created:number, createdCodes:Array, missing:Array, errors:Array, total:number }}
 */
export function importCsvText(holdings, csvText, opts = {}) {
  const { createMissing = false, costMethod } = opts;
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
  const iDate = colIndex(['买入日期', '卖出日期', '交易日期', '日期']);
  const iQty = colIndex(['买入数量', '卖出数量', '数量']);
  const iPrice = colIndex(['买入价', '卖出价', '价格']);
  const iFee = colIndex(['手续费', '佣金', '费用']);
  const iAmount = colIndex(['分红金额', '金额']);
  const iRatio = colIndex(['送转比例', '送股比例', '拆分比例', '比例']);
  if (iCode < 0 || iOper < 0 || iDate < 0) {
    throw new Error(`CSV 表头缺少必需列（需包含：代码 / 操作 / 日期）。当前表头：${header.join(',')}`);
  }

  // 解析 CSV 数据行（按操作类型分别校验必需字段）
  const records = [];
  for (const r of rows.slice(1)) {
    const code = String(r[iCode] || '').trim();
    const oper = parseOper(r[iOper]);
    const date = dateKey(r[iDate]);
    if (!code || !oper || !date) continue;
    const rec = {
      seq: r[iSeq]?.trim(),
      name: r[iName]?.trim(),
      code,
      region: r[iRegion]?.trim(),
      type: r[iType]?.trim(),
      oper,
      date,
      qty: Number(r[iQty]),
      price: Number(r[iPrice]),
      fee: iFee >= 0 ? Number(r[iFee]) || 0 : 0,
      amount: iAmount >= 0 ? Number(r[iAmount]) || 0 : 0,
      ratio: iRatio >= 0 ? Number(r[iRatio]) || 0 : 0,
    };
    if ((oper === 'BUY' || oper === 'SELL') && (!(rec.qty > 0) || !(rec.price > 0))) continue;
    if (oper === 'DIVIDEND' && !(rec.amount > 0)) continue;
    if (oper === 'SPLIT' && !(rec.ratio > 0)) continue;
    records.push(rec);
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
      const newH = createHolding(rec.name, rec.code, rec.region, rec.type, costMethod);
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
    if (existingKey(h, rec.oper, rec)) {
      skipped++;
      continue;
    }
    try {
      // 统一走 derive 的交易应用：买入/卖出/分红/送转口径与页面录入完全一致
      if (rec.oper === 'DIVIDEND') {
        applyTransaction(h, { type: 'DIVIDEND', amount: rec.amount, fee: rec.fee, date: rec.date });
      } else if (rec.oper === 'SPLIT') {
        applyTransaction(h, { type: 'SPLIT', ratio: rec.ratio, date: rec.date });
      } else {
        applyTransaction(h, {
          type: rec.oper,
          price: rec.price,
          quantity: rec.qty,
          fee: rec.fee,
          date: rec.date,
        });
      }
      added++;
    } catch (e) {
      errors.push({ rec, message: e.message });
    }
  }

  return { added, skipped, created, createdCodes, missing, errors, total: records.length };
}
