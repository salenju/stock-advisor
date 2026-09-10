// 策略 / 统计 / 快照 单元测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, updatePeak } from '../server/strategy.js';
import { buildStats } from '../server/stats.js';
import { buildSnapshot, mergeSnapshots } from '../server/snapshot.js';

function H(over = {}) {
  return {
    id: 'h1',
    name: '测试标的',
    code: '600519',
    status: '持有',
    region: 'sh',
    type: '股票',
    costMethod: 'LIFO',
    purchases: [{ id: 'p1', buyPrice: 10, buyQuantity: 100, buyTime: '2026-01-01', fee: 0, targetProfitRate: 0, stopLossRate: 0 }],
    sells: [],
    dividends: [],
    splits: [],
    currentPrice: 10,
    prevClose: 10,
    refillDropRate: 0,
    refillPrice: 0,
    targetProfitRate: 0,
    stopLossRate: 0,
    ...over,
  };
}

// ---------- 策略 ----------

test('价格缺失或为 0（停牌/行情异常）时不触发任何提醒', () => {
  assert.equal(evaluate(H({ currentPrice: null }), 2).trigger, 'NONE');
  assert.equal(evaluate(H({ currentPrice: 0 }), 2).trigger, 'NONE');
  assert.equal(evaluate(H({ currentPrice: -1 }), 2).trigger, 'NONE');
  assert.equal(evaluate(H({ currentPrice: NaN }), 2).trigger, 'NONE');
});

test('已清仓持仓不再触发提醒', () => {
  const h = H({
    status: '全部卖出',
    purchases: [{ id: 'p1', buyPrice: 10, buyQuantity: 100, buyTime: '2026-01-01', fee: 0 }],
    sells: [{ id: 's1', sellPrice: 20, sellQuantity: 100, sellDate: '2026-02-01', costPrice: 10, profit: 1000 }],
    currentPrice: 30,
  });
  assert.equal(evaluate(h, 2).trigger, 'NONE');
});

test('止盈：收益率接近目标即触发 SELL/PROFIT（含 nearPct 容差）', () => {
  const h = H({ targetProfitRate: 20, currentPrice: 12 }); // 收益率 20%
  const r = evaluate(h, 2);
  assert.equal(r.trigger, 'SELL');
  assert.equal(r.reason, 'PROFIT');

  // 18% 收益率，容差 2% → 仍在触发区
  assert.equal(evaluate(H({ targetProfitRate: 20, currentPrice: 11.8 }), 2).reason, 'PROFIT');
  // 17% 收益率，容差 2% → 不触发
  assert.equal(evaluate(H({ targetProfitRate: 20, currentPrice: 11.7 }), 2).trigger, 'NONE');
});

test('止损：任一买入记录亏损达该笔止损线即触发 SELL/STOPLOSS', () => {
  const h = H({
    purchases: [{ id: 'p1', buyPrice: 20, buyQuantity: 100, buyTime: '2026-01-01', fee: 0, stopLossRate: 10 }],
    currentPrice: 18.1, // -9.5%
  });
  const r = evaluate(h, 2);
  assert.equal(r.trigger, 'SELL');
  assert.equal(r.reason, 'STOPLOSS');
});

test('补仓：较最近买入价下跌达补仓降幅即触发 BUY', () => {
  const h = H({ refillDropRate: 10, currentPrice: 9.1 }); // 下跌 9%
  const r = evaluate(h, 2);
  assert.equal(r.trigger, 'BUY');
  assert.ok(r.dropRate >= 9);

  // 触及补仓价也触发
  const h2 = H({ refillPrice: 9, currentPrice: 8.9 });
  assert.equal(evaluate(h2, 2).trigger, 'BUY');
});

test('移动止盈：记录峰值收益率，从峰值回撤达阈值触发 SELL/TRAILING', () => {
  const h = H({ trailingStopPct: 5, currentPrice: 12 }); // 收益率 20%
  assert.equal(updatePeak(h), true);
  assert.equal(h.peakReturnRate, 20);

  // 再创新高时更新
  h.currentPrice = 13;
  assert.equal(updatePeak(h), true);
  assert.equal(h.peakReturnRate, 30);

  // 回落到 16%（回撤 14%）→ 触发
  h.currentPrice = 11.6;
  const r = evaluate(h, 2);
  assert.equal(r.trigger, 'SELL');
  assert.equal(r.reason, 'TRAILING');

  // 仅回撤 3%（27%）→ 不触发
  h.currentPrice = 12.7;
  assert.equal(evaluate(h, 2).trigger, 'NONE');
});

test('未启用移动止盈时不维护峰值', () => {
  const h = H({ trailingStopPct: null, currentPrice: 12 });
  assert.equal(updatePeak(h), false);
  assert.equal(h.peakReturnRate ?? null, null);
});

// ---------- 统计 ----------

test('收益归因：已清仓笔数 / 胜率 / 持有天数 / 年度已实现', () => {
  const holdings = [
    {
      id: 'h1', name: '已清仓盈利', code: '600001', status: '全部卖出', region: 'sh', type: '股票',
      costMethod: 'LIFO',
      purchases: [{ id: 'p1', buyPrice: 10, buyQuantity: 100, buyTime: '2026-01-01', fee: 0 }],
      sells: [{ id: 's1', sellPrice: 12, sellQuantity: 100, sellDate: '2026-03-01', fee: 0, costPrice: 10, profit: 200 }],
      dividends: [], splits: [],
    },
    {
      id: 'h2', name: '已清仓亏损', code: '600002', status: '全部卖出', region: 'sh', type: '股票',
      costMethod: 'LIFO',
      purchases: [{ id: 'p2', buyPrice: 10, buyQuantity: 100, buyTime: '2026-02-01', fee: 0 }],
      sells: [{ id: 's2', sellPrice: 9, sellQuantity: 100, sellDate: '2026-02-20', fee: 0, costPrice: 10, profit: -100 }],
      dividends: [], splits: [],
    },
    {
      id: 'h3', name: '部分卖出', code: '600003', status: '持有', region: 'sh', type: '股票',
      costMethod: 'LIFO',
      purchases: [{ id: 'p3', buyPrice: 10, buyQuantity: 100, buyTime: '2026-01-01', fee: 0 }],
      sells: [{ id: 's3', sellPrice: 11, sellQuantity: 50, sellDate: '2026-04-01', fee: 0, costPrice: 10, profit: 50 }],
      dividends: [], splits: [],
    },
  ];
  const stats = buildStats(holdings, { CNY: 1, USD: 7, HKD: 0.9 });

  assert.equal(stats.summary.totalRealizedCNY, 150); // 200 - 100 + 50
  assert.equal(stats.summary.closedCount, 2);
  assert.equal(stats.summary.openWithSellsCount, 1);
  assert.equal(stats.summary.winCount, 1);
  assert.equal(stats.summary.lossCount, 1);
  assert.equal(stats.summary.winRate, 50);
  assert.equal(stats.summary.profitFactor, 2); // 200 / 100
  assert.equal(stats.items.length, 3);
  assert.equal(stats.byYear.length, 1);
  assert.equal(stats.byYear[0].year, '2026');

  const h1 = stats.items.find((i) => i.id === 'h1');
  assert.equal(h1.holdDays, 59); // 2026-01-01 → 2026-03-01
  assert.equal(h1.realizedReturnRate, 20);
  assert.equal(h1.fullyClosed, true);
  // best/worst 按人民币已实现排序
  assert.equal(stats.best[0].id, 'h1');
  assert.equal(stats.worst[0].id, 'h2');
});

test('收益归因：外币持仓按汇率折算人民币', () => {
  const hk = {
    id: 'hk1', name: '港股', code: '00700', status: '全部卖出', region: 'hk', type: '股票',
    costMethod: 'LIFO',
    purchases: [{ id: 'p1', buyPrice: 100, buyQuantity: 100, buyTime: '2026-01-01', fee: 0 }],
    sells: [{ id: 's1', sellPrice: 110, sellQuantity: 100, sellDate: '2026-02-01', fee: 0, costPrice: 100, profit: 1000 }],
    dividends: [], splits: [],
  };
  const stats = buildStats([hk], { CNY: 1, USD: 7, HKD: 0.9 });
  assert.equal(stats.items[0].realizedProfitCNY, 900); // 1000 HKD × 0.9
  assert.equal(stats.items[0].currency, 'HKD');
});

// ---------- 快照 ----------

test('组合快照：人民币汇总 + 分币种明细 + 累计已实现', () => {
  const holdings = [
    {
      id: 'h1', name: 'A股', code: '600001', status: '持有', region: 'sh', type: '股票',
      costMethod: 'LIFO', currentPrice: 12, prevClose: 11,
      purchases: [{ id: 'p1', buyPrice: 10, buyQuantity: 100, buyTime: '2026-01-01', fee: 0 }],
      sells: [], dividends: [], splits: [],
    },
    {
      id: 'h2', name: '港股', code: '00700', status: '持有', region: 'hk', type: '股票',
      costMethod: 'LIFO', currentPrice: 200, prevClose: 195,
      purchases: [{ id: 'p2', buyPrice: 150, buyQuantity: 10, buyTime: '2026-01-01', fee: 0 }],
      sells: [], dividends: [], splits: [],
    },
  ];
  const rates = { CNY: 1, USD: 7, HKD: 0.9 };
  const snap = buildSnapshot(holdings, rates, '2026-09-10');

  assert.equal(snap.date, '2026-09-10');
  assert.equal(snap.activeCount, 2);
  assert.equal(snap.cost, 1000 + 1500 * 0.9);          // 2350
  assert.equal(snap.marketValue, 1200 + 2000 * 0.9);   // 3000
  assert.equal(snap.todayProfit, 100 * 1 + 5 * 10 * 0.9); // 100 + 45
  assert.equal(snap.currency, 'CNY');
  assert.ok(snap.byCurrency.CNY && snap.byCurrency.HKD);
  assert.equal(snap.byCurrency.CNY.marketValue, 1200);
  assert.equal(snap.byCurrency.HKD.marketValue, 2000);
});

test('快照合并：同一日期以快照为准，快照独有的日期被补入', () => {
  const series = {
    dates: ['2026-09-08', '2026-09-09', '2026-09-10'],
    holdingProfit: [1, 2, 3],
    todayProfit: [10, 20, 30],
    marketValue: [100, 200, 300],
  };
  const snaps = [
    { date: '2026-09-09', holdingProfit: 999, todayProfit: 888, marketValue: 777 },
    { date: '2026-09-11', holdingProfit: 5, todayProfit: 50, marketValue: 500 },
  ];
  const merged = mergeSnapshots(series, snaps);
  assert.deepEqual(merged.dates, ['2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11']);
  assert.deepEqual(merged.holdingProfit, [1, 999, 3, 5]);
  assert.deepEqual(merged.todayProfit, [10, 888, 30, 50]);
  assert.deepEqual(merged.marketValue, [100, 777, 300, 500]);
});

test('快照合并：无快照时原样返回', () => {
  const series = { dates: ['d1'], holdingProfit: [1], todayProfit: [1], marketValue: [1] };
  assert.equal(mergeSnapshots(series, []), series);
});
