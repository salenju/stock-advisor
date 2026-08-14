// 币种模块单测：地区→币种、汇率换算、分币种汇总
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currencyOf, currencyCode, fxToCNY, breakdownByCurrency } from '../server/currency.js';

const RATES = { CNY: 1, USD: 7.0, HKD: 0.9 };

test('currencyOf：按地区映射币种', () => {
  assert.equal(currencyOf('sh'), 'CNY');
  assert.equal(currencyOf('sz'), 'CNY');
  assert.equal(currencyOf('hk'), 'HKD');
  assert.equal(currencyOf('us'), 'USD');
  assert.equal(currencyOf('港股'), 'HKD'); // 中文标签兼容
  assert.equal(currencyOf('美股'), 'USD');
  assert.equal(currencyOf(''), 'CNY');     // 未知地区兜底人民币
});

test('currencyCode：币种显示代码', () => {
  assert.equal(currencyCode('CNY'), 'CNY');
  assert.equal(currencyCode('HKD'), 'HKD');
  assert.equal(currencyCode('USD'), 'USD');
  assert.equal(currencyCode('XXX'), '');
});

test('fxToCNY：汇率换算与边界', () => {
  assert.equal(fxToCNY(100, 'CNY', RATES), 100);
  assert.equal(fxToCNY(100, 'USD', RATES), 700);
  assert.equal(fxToCNY(100, 'HKD', RATES), 90);
  assert.equal(fxToCNY(null, 'USD', RATES), 0);
  assert.equal(fxToCNY(undefined, 'USD', RATES), 0);
  assert.equal(fxToCNY('abc', 'USD', RATES), 0);
  assert.equal(fxToCNY(100, 'XXX', RATES), 0); // 未知币种无汇率按 0
});

test('breakdownByCurrency：分币种小计 + 人民币合计', () => {
  const holdings = [
    { currency: 'CNY', marketValue: 1000 },
    { currency: 'HKD', marketValue: 2000 },
    { currency: 'USD', marketValue: 300 },
    { currency: 'CNY', marketValue: null },   // 无市值跳过
    { currency: 'USD', marketValue: undefined },
  ];
  const r = breakdownByCurrency(holdings, 'marketValue', RATES);
  assert.deepEqual(r.byCurrency, { CNY: 1000, HKD: 2000, USD: 300 });
  assert.ok(Math.abs(r.totalCNY - (1000 + 2000 * 0.9 + 300 * 7.0)) < 1e-9); // = 1000+1800+2100=4900
});

test('breakdownByCurrency：空输入与字段缺失', () => {
  assert.deepEqual(breakdownByCurrency([], 'cost', RATES), { byCurrency: {}, totalCNY: 0 });
  assert.deepEqual(breakdownByCurrency([{ currency: 'CNY' }], 'cost', RATES), { byCurrency: {}, totalCNY: 0 });
});
