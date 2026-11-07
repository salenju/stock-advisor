// 加仓测算单测：按数量算新成本 / 按目标成本反推数量 / 边界与手数取整
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avgCostOf, projectByQuantity, quantityForTargetCost } from '../web/src/core/plan.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test('avgCostOf：总成本 / 数量', () => {
  assert.equal(avgCostOf(10000, 1000), 10);
  assert.equal(avgCostOf(10000, 0), 0);
  assert.equal(avgCostOf(null, 100), 0);
  assert.equal(avgCostOf(100, -5), 0);
});

test('projectByQuantity：加仓摊薄成本', () => {
  const r = projectByQuantity({ currentQty: 1000, currentCost: 10000, price: 8, quantity: 500 });
  assert.equal(r.ok, true);
  assert.equal(r.oldAvg, 10);
  assert.equal(r.invest, 4000);
  assert.equal(r.newQty, 1500);
  assert.equal(r.newCost, 14000);
  assert.ok(near(r.newAvg, 14000 / 1500));
  assert.ok(near(r.delta, 14000 / 1500 - 10));
  assert.ok(r.deltaPct < 0);
});

test('projectByQuantity：手续费计入成本', () => {
  const r = projectByQuantity({ currentQty: 1000, currentCost: 10000, price: 8, quantity: 500, fee: 5 });
  assert.equal(r.invest, 4005);
  assert.ok(near(r.newAvg, 14005 / 1500));
});

test('projectByQuantity：空仓按新建仓算（含费均价）', () => {
  const r = projectByQuantity({ currentQty: 0, currentCost: 0, price: 10, quantity: 100, fee: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.oldAvg, 0);
  assert.equal(r.deltaPct, null);
  assert.ok(near(r.newAvg, 10.05));
});

test('projectByQuantity：非法输入返回原因', () => {
  assert.equal(projectByQuantity({ currentQty: 100, currentCost: 1000, price: 0, quantity: 100 }).ok, false);
  assert.equal(projectByQuantity({ currentQty: 100, currentCost: 1000, price: 10, quantity: 0 }).ok, false);
});

test('quantityForTargetCost：摊薄到目标成本', () => {
  const r = quantityForTargetCost({
    currentQty: 1000,
    currentCost: 10000,
    price: 8,
    targetCost: 9,
  });
  assert.equal(r.ok, true);
  assert.ok(near(r.needQty, 1000));
  assert.ok(near(r.newAvg, 9));
  assert.equal(r.suggestedQty, 1000);
  assert.ok(near(r.suggestedAvg, 9));
});

test('quantityForTargetCost：手续费需要多买一点', () => {
  const r = quantityForTargetCost({
    currentQty: 1000,
    currentCost: 10000,
    price: 8,
    targetCost: 9,
    fee: 5,
  });
  assert.ok(near(r.needQty, 1005));
  assert.ok(near(r.newAvg, 9));
  assert.ok(near(r.newCost, 18045));
});

test('quantityForTargetCost：按 100 股一手向上取整', () => {
  const r = quantityForTargetCost({
    currentQty: 1000,
    currentCost: 10000,
    price: 8,
    targetCost: 9,
    fee: 5,
    lotSize: 100,
  });
  assert.equal(r.suggestedQty, 1100);
  assert.equal(r.suggestedLots, 11);
  assert.ok(r.suggestedAvg < 9); // 多买必然更低于目标
  assert.ok(near(r.suggestedInvest, 8 * 1100 + 5));
});

test('quantityForTargetCost：拉高成本需买在目标价之上', () => {
  const r = quantityForTargetCost({
    currentQty: 1000,
    currentCost: 10000,
    price: 12,
    targetCost: 11,
  });
  assert.equal(r.ok, true);
  assert.ok(near(r.needQty, 1000));
  assert.ok(near(r.newAvg, 11));
});

test('quantityForTargetCost：无解场景给出原因', () => {
  // 买入价高于目标成本 → 无法摊薄
  const a = quantityForTargetCost({ currentQty: 1000, currentCost: 10000, price: 9.5, targetCost: 9 });
  assert.equal(a.ok, false);
  assert.match(a.reason, /低于目标成本/);

  // 买入价等于目标成本 → 永远到不了
  const b = quantityForTargetCost({ currentQty: 1000, currentCost: 10000, price: 9, targetCost: 9 });
  assert.equal(b.ok, false);
  assert.match(b.reason, /等于目标成本/);

  // 目标与当前一致 → 无需买入
  const c = quantityForTargetCost({ currentQty: 1000, currentCost: 10000, price: 8, targetCost: 10 });
  assert.equal(c.ok, false);
  assert.match(c.reason, /一致/);

  // 空仓
  const d = quantityForTargetCost({ currentQty: 0, currentCost: 0, price: 8, targetCost: 9 });
  assert.equal(d.ok, false);
  assert.match(d.reason, /没有持仓/);

  // 拉高成本但买价偏低
  const e = quantityForTargetCost({ currentQty: 1000, currentCost: 10000, price: 10.5, targetCost: 11 });
  assert.equal(e.ok, false);
  assert.match(e.reason, /高于目标成本/);
});
