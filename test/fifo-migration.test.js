// 一次性 FIFO 迁移单测：切成本法 + 重算历史卖出成本，且不改写入参
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertAllToFifo } from '../web/src/core/fifo-migration.js';
import { aggregate } from '../web/src/core/derive.js';

function near(actual, expected, eps = 1e-6) {
  assert.ok(
    Math.abs(Number(actual) - Number(expected)) < eps,
    `期望 ${expected}，实际 ${actual}`
  );
}

// 小米实测案例：5 笔买入共 2800 股，卖出 1600 @30.88，LIFO 记的成本 45,728
function xiaomi(over = {}) {
  return {
    id: 'h1',
    name: '小米集团',
    code: '01810',
    region: 'hk',
    status: '持有',
    costMethod: 'LIFO',
    purchases: [
      { id: 'p1', buyPrice: 30.7, buyQuantity: 1400, buyTime: '2026-05-05', fee: 0 },
      { id: 'p2', buyPrice: 31.72, buyQuantity: 400, buyTime: '2026-05-11', fee: 0 },
      { id: 'p3', buyPrice: 23.9, buyQuantity: 200, buyTime: '2026-07-03', fee: 0 },
      { id: 'p4', buyPrice: 27.84, buyQuantity: 400, buyTime: '2026-07-21', fee: 0 },
      { id: 'p5', buyPrice: 27.46, buyQuantity: 400, buyTime: '2026-09-07', fee: 0 },
    ],
    sells: [
      {
        id: 's1',
        sellPrice: 30.88,
        sellQuantity: 1600,
        sellDate: '2026-11-06',
        fee: 0,
        costPrice: 28.58,
        profit: 3680,
        returnRate: 8.05,
      },
    ],
    dividends: [],
    splits: [],
    currentPrice: 30.38,
    prevClose: 30.5,
    ...over,
  };
}

test('convertAllToFifo：LIFO 账本按 FIFO 重算（小米案例）', () => {
  const h = xiaomi();
  const { list, changed } = convertAllToFifo([h]);

  assert.equal(changed, true);
  const out = list[0];
  assert.equal(out.costMethod, 'FIFO');

  // FIFO 卖 1600 = 1400×30.70 + 200×31.72 = 49,324
  near(out.sells[0].costPrice, 49324 / 1600);
  near(out.sells[0].profit, 49408 - 49324); // 84
  near(out.sells[0].returnRate, ((30.88 - 49324 / 1600) / (49324 / 1600)) * 100);

  // 剩余 1200 股：200@31.72 + 200@23.90 + 400@27.84 + 400@27.46 = 33,244
  const d = aggregate(out);
  near(d.remainingCost, 33244);
  near(d.remainingQty, 1200);
  near(d.avgCost, 33244 / 1200);
  // 批次合计与持仓成本必须闭合（否则前端会提示「对不上」）
  near(d.lotsCostTotal, d.remainingCost);

  // 入参不被改写
  assert.equal(h.costMethod, 'LIFO');
  assert.equal(h.sells[0].profit, 3680);
  assert.equal(h.sells[0].costPrice, 28.58);
});

test('convertAllToFifo：已经是 FIFO 且账本一致时返回原对象', () => {
  const first = convertAllToFifo([xiaomi()]);
  const second = convertAllToFifo(first.list);
  assert.equal(second.changed, false);
  assert.equal(second.list[0], first.list[0], '不应产生新对象，避免无谓写盘');
});

test('convertAllToFifo：没有卖出记录时只切成本法', () => {
  const h = xiaomi({ sells: [] });
  const { list, changed } = convertAllToFifo([h]);
  assert.equal(changed, true);
  assert.equal(list[0].costMethod, 'FIFO');
  assert.deepEqual(list[0].sells, []);
  near(aggregate(list[0]).remainingCost, 82568);
});

test('convertAllToFifo：空列表 / 异常输入安全', () => {
  assert.deepEqual(convertAllToFifo([]), { list: [], changed: false });
  assert.deepEqual(convertAllToFifo(null), { list: [], changed: false });
});
