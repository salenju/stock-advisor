// 持仓数据 schema：新建默认值、旧版本迁移、变更指纹。
//
// 前后端共享：server/store.js（文件存储）与 web/src/store/localStore.js（浏览器存储）
// 都从这里取迁移与指纹逻辑，保证「本地模式」和「服务端模式」的数据形态完全一致。
import { normalizeCostMethod, normalizePurchase, syncFromPurchases, newId } from './derive.js';

// 当前数据结构版本（迁移函数会把旧数据补齐到该版本）
export const SCHEMA_VERSION = 3;

// 运行时易变字段：不参与「交易数据是否变化」的判定，
// 否则每轮行情刷新都会产生一份备份（20 秒一份，很快撑爆存储）。
export const VOLATILE_KEYS = new Set([
  'currentPrice',
  'prevClose',
  'lastUpdated',
  'triggerState',
  'notifiedAt',
  'dailyAlertSentDate',
  'peakReturnRate',
]);

// ---------- 迁移 ----------

// 旧版持仓为扁平结构（单条买入）；迁移为「多次买入记录」模型。
// 迁移在首次加载时执行，之后始终以 purchases 模型持久化。
// 同时补齐后续版本新增字段（backwards-compatible，只增不改语义）。
export function migrateHolding(h) {
  let out = h;

  // v1 → v2：扁平买入 → purchases[]
  if (!Array.isArray(out.purchases)) {
    const p = {
      id: 'p' + (out.id || 'x') + '0',
      buyPrice: Number(out.buyPrice) || 0,
      buyQuantity: Number(out.buyQuantity) || 0,
      buyTime: out.buyTime || out.snapshotDate || new Date().toISOString().slice(0, 10),
      // 旧版仅有全局止盈(targetProfitRate)；止亏缺省 0（不触发止损）
      targetProfitRate: Number(out.targetProfitRate) || 0,
      stopLossRate: Number(out.stopLossRate) || 0,
      fee: 0,
    };
    out = { ...out, purchases: [p] };
  }

  // v2 → v3：手续费 / 分红 / 送转 / 成本法 / 移动止盈
  let changed =
    out.purchases.some((p) => p.fee == null) ||
    !Array.isArray(out.sells) ||
    !Array.isArray(out.dividends) ||
    !Array.isArray(out.splits) ||
    out.costMethod == null ||
    out.trailingStopPct === undefined;

  if (changed) {
    out = {
      ...out,
      purchases: out.purchases.map((p) => ({ ...p, fee: Number(p.fee) || 0 })),
      sells: (out.sells || []).map((s) => ({ ...s, fee: Number(s.fee) || 0 })),
      dividends: out.dividends || [],
      splits: out.splits || [],
      costMethod: out.costMethod || 'LIFO',
      trailingStopPct: out.trailingStopPct ?? null,
      peakReturnRate: out.peakReturnRate ?? null,
    };
  }

  // 统一历史状态值：'已卖出' → '全部卖出'
  if (out.status === '已卖出') {
    out = { ...out, status: '全部卖出' };
    changed = true;
  }

  return changed ? out : h;
}

/** 迁移整个列表；返回 { list, changed } */
export function migrateHoldings(list) {
  let changed = false;
  const out = (Array.isArray(list) ? list : []).map((h) => {
    const m = migrateHolding(h);
    if (m !== h) changed = true;
    return m;
  });
  return { list: out, changed };
}

// ---------- 新建 ----------

/**
 * 由表单/导入数据构造一条完整的持仓记录。
 * 允许「先建仓、后补买入记录」：purchases 可空。
 * @param {Object} b 至少包含 name / code / region / type
 */
export function createHolding(b = {}) {
  const today = new Date().toISOString().slice(0, 10);
  for (const k of ['name', 'code', 'region', 'type']) {
    if (!b[k] || !String(b[k]).trim()) throw new Error(`缺少字段: ${k}`);
  }

  let purchases = [];
  if (Array.isArray(b.purchases) && b.purchases.length) {
    purchases = b.purchases.map((p) => normalizePurchase(p));
  }

  const h = {
    id: newId('h'),
    name: String(b.name).trim(),
    code: String(b.code).trim(),
    status: '持有',
    region: b.region,
    type: b.type,
    strategy: b.strategy || '',
    costMethod: normalizeCostMethod(b.costMethod),
    snapshotDate: b.snapshotDate || today,
    snapshotProfit: Number(b.snapshotProfit) || 0,
    snapshotReturnRate: Number(b.snapshotReturnRate) || 0,
    position: Number(b.position) || 0,
    purchases,
    sells: [], // 卖出记录（独立于买入记录）
    dividends: [], // 现金分红记录
    splits: [], // 送转 / 拆股记录
    // 补仓计划（持仓级）
    refillDropRate: Number(b.refillDropRate) || 0,
    refillPrice: Number(b.refillPrice) || 0,
    nextStrategy: b.nextStrategy || '',
    // 移动止盈：持仓期最高收益率回撤该幅度即提醒（null=关闭）
    trailingStopPct: b.trailingStopPct != null ? Number(b.trailingStopPct) : null,
    peakReturnRate: null,
    // 日涨跌告警阈值（百分比，为空=不告警）
    dailyDropAlertPct: b.dailyDropAlertPct != null ? Number(b.dailyDropAlertPct) : null,
    dailyRiseAlertPct: b.dailyRiseAlertPct != null ? Number(b.dailyRiseAlertPct) : null,
    dailyAlertSentDate: null,
    currentPrice: null,
    prevClose: null,
    lastUpdated: null,
    triggerState: 'IDLE',
    notifiedAt: null,
  };
  return syncFromPurchases(h);
}

// ---------- 变更指纹 ----------

// 纯 JS 哈希（FNV-1a + djb2 双通道），浏览器与 Node 结果一致，
// 用途仅为「判断交易数据有没有变」，不用于安全目的。
function hashString(s) {
  let h1 = 0x811c9dc5;
  let h2 = 5381;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = (Math.imul(h2, 33) ^ c) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0') + '-' + s.length.toString(16);
}

/** 交易数据指纹：剥离易变字段（行情/提醒状态）后取哈希 */
export function dataSignature(list) {
  const stripped = (list || []).map((h) => {
    const o = {};
    for (const [k, v] of Object.entries(h || {})) {
      if (!VOLATILE_KEYS.has(k)) o[k] = v;
    }
    return o;
  });
  return hashString(JSON.stringify(stripped));
}
