// 账本与派生计算单元测试：成本法 / 手续费 / 分红 / 送转 / 历史成本沿用 / 迁移
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregate,
  computePositions,
  applyTransaction,
  normalizePurchase,
  recomputeSells,
  unitCostOf,
  dateKey,
  isActive,
} from '../server/derive.js';
import { migrateHolding } from '../server/store.js';

// 构造一个最小持仓
function H(over = {}) {
  return {
    id: 'h1',
    name: '测试标的',
    code: '600519',
    status: '持有',
    region: 'sh',
    type: '股票',
    costMethod: 'LIFO',
    purchases: [],
    sells: [],
    dividends: [],
    splits: [],
    currentPrice: null,
    prevClose: null,
    ...over,
  };
}

const BUY = (buyPrice, buyQuantity, buyTime, fee = 0, id = undefined) => ({
  id: id || `p-${buyTime}-${buyPrice}`,
  buyPrice,
  buyQuantity,
  buyTime,
  fee,
  targetProfitRate: 0,
  stopLossRate: 0,
});

test('dateKey：归一化 ISO 时间戳 / 斜杠 / 点号日期', () => {
  assert.equal(dateKey('2026-08-05'), '2026-08-05');
  assert.equal(dateKey('2026-08-05T12:33:00.000Z'), '2026-08-05');
  assert.equal(dateKey('2026/8/5'), '2026-08-05');
  assert.equal(dateKey('2026.8.5'), '2026-08-05');
  assert.equal(dateKey(''), '');
});

test('缺失利润字段的卖出记录不会产生 NaN（回归：Number(x) ?? fallback 失效）', () => {
  const h = H({
    purchases: [BUY(10, 100, '2026-01-01')],
    // 故意不写 costPrice / profit，模拟手工编辑或旧数据
    sells: [{ id: 's1', sellPrice: 12, sellQuantity: 50, sellDate: '2026-02-01' }],
  });
  const d = aggregate(h);
  assert.equal(d.sells[0].profit, 100, '应按批次成本 10 补算 (12-10)*50');
  assert.equal(d.realizedProfit, 100);
  assert.ok(Number.isFinite(d.cost));
  assert.ok(Number.isFinite(d.avgCost));
  for (const [k, v] of Object.entries(d)) {
    if (typeof v === 'number') assert.ok(!Number.isNaN(v), `${k} 不应为 NaN`);
  }
});

// 浮点比较辅助
function near(actual, expected, eps = 1e-6) {
  assert.ok(
    Math.abs(Number(actual) - Number(expected)) < eps,
    `期望 ${expected}，实际 ${actual}`
  );
}

test('手续费：买入费计入成本与均价，卖出费从盈亏中扣除', () => {
  const h = H({
    purchases: [BUY(10, 100, '2026-01-01', 5)],
  });
  near(unitCostOf(h.purchases[0]), 10.05);

  const d1 = aggregate(h);
  near(d1.cost, 1005);
  near(d1.avgCost, 10.05);

  applyTransaction(h, { type: 'SELL', price: 12, quantity: 50, date: '2026-02-01', fee: 2 });
  const d2 = aggregate(h);
  // (12 - 10.05) * 50 - 2 = 95.5
  near(d2.sells[0].profit, 95.5);
  near(d2.cost, 502.5); // 1005 - 10.05*50
  assert.equal(d2.unsoldQuantity, 50);
  near(d2.feesTotal, 7); // 买入 5 + 卖出 2
});

test('分红：计入已实现收益，不影响剩余成本', () => {
  const h = H({ purchases: [BUY(10, 100, '2026-01-01')] });
  applyTransaction(h, { type: 'DIVIDEND', amount: 30, fee: 3, date: '2026-02-01' });
  const d = aggregate(h);
  assert.equal(d.dividendTotal, 27);
  assert.equal(d.realizedProfit, 27);
  assert.equal(d.cost, 1000, '分红不应改变持仓成本');
  assert.equal(d.holdingProfit, 27, '无现价时持仓收益 = 已实现');
});

test('送转/拆股：数量按比例放大、均价下降、成本总额不变', () => {
  const h = H({ purchases: [BUY(10, 100, '2026-01-01')] });
  applyTransaction(h, { type: 'SPLIT', ratio: 2, date: '2026-02-01' });
  const d = aggregate(h);
  assert.equal(d.unsoldQuantity, 200);
  near(d.cost, 1000);
  near(d.avgCost, 5);
});

test('成本法：LIFO / FIFO / WAC 卖出成本各不相同且符合定义', () => {
  const mk = (method) =>
    H({
      costMethod: method,
      purchases: [BUY(10, 100, '2026-01-01', 0, 'p1'), BUY(20, 100, '2026-02-01', 0, 'p2')],
    });

  const lifo = mk('LIFO');
  applyTransaction(lifo, { type: 'SELL', price: 30, quantity: 100, date: '2026-03-01' });
  assert.equal(lifo.sells[0].costPrice, 20, 'LIFO 应取最新买入批次');
  assert.equal(lifo.sells[0].profit, 1000);

  const fifo = mk('FIFO');
  applyTransaction(fifo, { type: 'SELL', price: 30, quantity: 100, date: '2026-03-01' });
  assert.equal(fifo.sells[0].costPrice, 10, 'FIFO 应取最早买入批次');
  assert.equal(fifo.sells[0].profit, 2000);

  const wac = mk('WAC');
  applyTransaction(wac, { type: 'SELL', price: 30, quantity: 100, date: '2026-03-01' });
  assert.equal(wac.sells[0].costPrice, 15, 'WAC 应取移动加权均价');
  assert.equal(wac.sells[0].profit, 1500);
});

test('历史卖出成本沿用：补录买入不会改写已录入的卖出盈亏', () => {
  const h = H({ purchases: [BUY(10, 100, '2026-01-01')] });
  applyTransaction(h, { type: 'SELL', price: 15, quantity: 100, date: '2026-01-20' });
  assert.equal(h.sells[0].costPrice, 10);
  assert.equal(h.sells[0].profit, 500);

  // 之后补录一笔更晚日期的买入（LIFO 会优先消耗它，但历史不应被改写）
  h.purchases.push(normalizePurchase({ buyPrice: 5, buyQuantity: 100, buyTime: '2026-01-25' }));
  const d = aggregate(h);
  assert.equal(d.sells[0].costPrice, 10, '历史成本应保持不变');
  assert.equal(d.sells[0].profit, 500);
  assert.equal(d.realizedProfit, 500);

  // 显式重算才会改写（属用户主动操作）
  recomputeSells(h);
  assert.equal(h.sells[0].costPrice, 5, 'recompute 后按当前成本法重算');
});

test('卖出数量超过持仓时拒绝写入', () => {
  const h = H({ purchases: [BUY(10, 100, '2026-01-01')] });
  assert.throws(
    () => applyTransaction(h, { type: 'SELL', price: 12, quantity: 101, date: '2026-02-01' }),
    /超过持仓/
  );
  assert.equal(h.sells.length, 0, '非法记录不应落盘');
});

test('买入数量非法时抛错', () => {
  assert.throws(() => normalizePurchase({ buyPrice: 10, buyQuantity: 0 }), /必须为正/);
  assert.throws(() => normalizePurchase({ buyPrice: -1, buyQuantity: 10 }), /必须为正/);
});

test('汇总字段闭合：剩余成本 = 买入成本 − 已卖出成本', () => {
  const h = H({
    purchases: [BUY(10, 100, '2026-01-01', 0, 'p1'), BUY(20, 100, '2026-02-01', 0, 'p2')],
  });
  applyTransaction(h, { type: 'SELL', price: 25, quantity: 150, date: '2026-03-01' });
  const pos = computePositions(h);
  assert.equal(pos.buyQty, 200);
  assert.equal(pos.soldQty, 150);
  assert.equal(Number(pos.remainingCost.toFixed(6)), Number((pos.buyCost - pos.soldCost).toFixed(6)));
  assert.equal(Number(pos.avgCost.toFixed(6)), Number((pos.remainingCost / 50).toFixed(6)));
});

test('isActive：持有 / 空状态算在仓，已清仓不算', () => {
  assert.equal(isActive({ status: '持有' }), true);
  assert.equal(isActive({ status: '' }), true);
  assert.equal(isActive({}), true);
  assert.equal(isActive({ status: '全部卖出' }), false);
  assert.equal(isActive({ status: '已卖出' }), false);
});

test('迁移：旧扁平结构 → purchases，并补齐新字段', () => {
  const legacy = {
    id: 'old1',
    name: '老数据',
    status: '已卖出',
    region: '港股',
    buyPrice: 3.5,
    buyQuantity: 200,
    buyTime: '2020-05-06',
    targetProfitRate: 20,
  };
  const out = migrateHolding(legacy);
  assert.equal(out.purchases.length, 1);
  assert.equal(out.purchases[0].buyPrice, 3.5);
  assert.equal(out.purchases[0].fee, 0, '旧数据补 fee=0');
  assert.deepEqual(out.dividends, []);
  assert.deepEqual(out.splits, []);
  assert.equal(out.costMethod, 'LIFO');
  assert.equal(out.trailingStopPct, null);
  assert.equal(out.status, '全部卖出', "'已卖出' 归一为 '全部卖出'");

  // 已是新结构时不应产生新对象（避免无谓写盘）
  const stable = migrateHolding(out);
  assert.equal(stable, out);
});
