// 收益趋势单测：逐日重放算法 + 区间过滤（纯函数，无网络）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTrendSeries, filterByDays } from '../server/trend.js';

const RATES = { CNY: 1, USD: 7.0, HKD: 0.9 };

// 构造单只持仓
function holding(over = {}) {
  return {
    id: 'h1',
    name: '测试',
    code: '600519',
    region: 'sh',
    status: '持有',
    purchases: [],
    sells: [],
    ...over,
  };
}

// 由收盘价数组生成 bars（日期从 start 起连续）
function bars(start, closes) {
  const base = new Date(start + 'T00:00:00Z');
  return closes.map((c, i) => {
    const d = new Date(base.getTime() + i * 86400000);
    return { date: d.toISOString().slice(0, 10), close: c };
  });
}

test('单只A股：持仓收益/今日收益逐日正确', () => {
  const h = holding({
    purchases: [{ buyPrice: 10, buyQuantity: 100, buyTime: '2026-08-01' }],
  });
  const closes = { sh600519: bars('2026-08-01', [11, 12, 10, 13, 14]) };
  const r = buildTrendSeries([h], closes, RATES);

  assert.deepEqual(r.dates, ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05']);
  assert.deepEqual(r.holdingProfit, [100, 200, 0, 300, 400]);
  assert.deepEqual(r.todayProfit, [0, 100, -200, 300, 100]); // 首日无前收为 0
  assert.deepEqual(r.marketValue, [1100, 1200, 1000, 1300, 1400]);
});

test('港股：按汇率折算人民币', () => {
  const h = holding({
    id: 'h2',
    name: '港标',
    code: '00700',
    region: 'hk',
    purchases: [{ buyPrice: 20, buyQuantity: 100, buyTime: '2026-08-01' }],
  });
  const closes = { hk00700: bars('2026-08-01', [22, 24]) };
  const r = buildTrendSeries([h], closes, RATES);
  assert.deepEqual(r.holdingProfit, [180, 360]); // (2200-2000)*0.9 / (2400-2000)*0.9
  assert.deepEqual(r.todayProfit, [0, 180]);     // (24-22)*100*0.9
});

test('卖出记录：数量/已实现收益按日生效', () => {
  const h = holding({
    purchases: [{ buyPrice: 10, buyQuantity: 200, buyTime: '2026-08-01' }],
    sells: [{ sellPrice: 15, sellQuantity: 50, sellDate: '2026-08-03' }],
  });
  const closes = { sh600519: bars('2026-08-01', [10, 10, 10, 10]) };
  const r = buildTrendSeries([h], closes, RATES);
  // 08-01/02: qty=200 mv=2000 cost=2000 hp=0；08-03 起: qty=150 mv=1500 cost=2000 已实现=750 → hp=250
  assert.deepEqual(r.holdingProfit, [0, 0, 250, 250]);
  assert.deepEqual(r.marketValue, [2000, 2000, 1500, 1500]);
});

test('无K线标的进入 skipped，不影响其它标的', () => {
  const h1 = holding({
    id: 'a',
    purchases: [{ buyPrice: 10, buyQuantity: 100, buyTime: '2026-08-01' }],
  });
  const h2 = holding({
    id: 'b',
    name: '无历史',
    code: 'SKHY',
    region: 'us',
    purchases: [{ buyPrice: 100, buyQuantity: 10, buyTime: '2026-08-01' }],
  });
  const closes = { sh600519: bars('2026-08-01', [11, 12]) };
  const r = buildTrendSeries([h1, h2], closes, RATES);
  assert.deepEqual(r.skipped, ['无历史(usSKHY)']);
  assert.deepEqual(r.holdingProfit, [100, 200]);
});

test('收盘价向前沿用：非交易日期沿用最近收盘', () => {
  const h = holding({
    purchases: [{ buyPrice: 10, buyQuantity: 100, buyTime: '2026-08-01' }],
  });
  // 只有 08-01 与 08-03 有K线（08-02 无）
  const closes = { sh600519: [bars('2026-08-01', [11]), bars('2026-08-03', [13])].flat() };
  const r = buildTrendSeries([h], closes, RATES);
  assert.deepEqual(r.dates, ['2026-08-01', '2026-08-03']);
  // 08-03 的持仓收益按收盘 13 计算
  assert.deepEqual(r.holdingProfit, [100, 300]);
  assert.deepEqual(r.todayProfit, [0, 200]); // (13-11)*100
});

test('maxDays 截断最近 N 个日期', () => {
  const h = holding({
    purchases: [{ buyPrice: 10, buyQuantity: 100, buyTime: '2026-08-01' }],
  });
  const closes = { sh600519: bars('2026-08-01', [11, 12, 13, 14]) };
  const r = buildTrendSeries([h], closes, RATES, { maxDays: 2 });
  assert.deepEqual(r.dates, ['2026-08-03', '2026-08-04']);
  assert.deepEqual(r.holdingProfit, [300, 400]);
});

test('filterByDays：按自然日窗口过滤', () => {
  const dates = ['2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31'];
  const hp = [1, 2, 3, 4];
  // 用固定“今天”不好测（依赖系统时间），验证 days<=0 返回全部
  const all = filterByDays(dates, hp, [0, 0, 0, 0], [0, 0, 0, 0], 0);
  assert.deepEqual(all.dates, dates);
  // 验证数组长度一致
  const r = filterByDays(dates, hp, [0, 0, 0, 0], [0, 0, 0, 0], 30);
  assert.equal(r.dates.length, r.holdingProfit.length);
});
