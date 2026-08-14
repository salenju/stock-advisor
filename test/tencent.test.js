// 腾讯行情模块单测：代码规范化 + 响应解析
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toTencentCode, normalizeRegion, parseTencentText } from '../server/provider/tencent.js';

test('normalizeRegion：中文标签与前缀值均归一', () => {
  assert.equal(normalizeRegion('港股'), 'hk');
  assert.equal(normalizeRegion('美股'), 'us');
  assert.equal(normalizeRegion('沪'), 'sh');
  assert.equal(normalizeRegion('深'), 'sz');
  assert.equal(normalizeRegion('A股'), 'sh');
  assert.equal(normalizeRegion('hk'), 'hk');
  assert.equal(normalizeRegion('us'), 'us');
  assert.equal(normalizeRegion(''), '');
});

test('toTencentCode：港股补零到5位（中文标签/前缀均可）', () => {
  assert.equal(toTencentCode('港股', '1810'), 'hk01810');
  assert.equal(toTencentCode('hk', '1810'), 'hk01810');
  assert.equal(toTencentCode('港股', '01810'), 'hk01810');
  assert.equal(toTencentCode('hk', '07709'), 'hk07709');
});

test('toTencentCode：剥离代码自带前缀', () => {
  assert.equal(toTencentCode('hk', 'hk00700'), 'hk00700');
  assert.equal(toTencentCode('sh', 'sh600519'), 'sh600519');
});

test('toTencentCode：A股6位/美股字母原样', () => {
  assert.equal(toTencentCode('sh', '600519'), 'sh600519');
  assert.equal(toTencentCode('sz', '000001'), 'sz000001');
  assert.equal(toTencentCode('美股', 'SKHY'), 'usSKHY');
  assert.equal(toTencentCode('us', 'AAPL'), 'usAAPL');
});

test('parseTencentText：解析现价与昨收，跳过无效行', () => {
  const text =
    'v_sh600519="1~贵州茅台~600519~1341.99~1355.29~1355.00~...";' +
    'v_hk01810="100~小米集团-W~01810~25.620~25.880~25.860~...";' +
    'v_usSKHY="200~SK海力士~SKHY.OQ~167.86~165.67~169.32~...";';
  const r = parseTencentText(text);
  assert.equal(r.sh600519.price, 1341.99);
  assert.equal(r.sh600519.prevClose, 1355.29);
  assert.equal(r.hk01810.price, 25.62);
  assert.equal(r.hk01810.prevClose, 25.88);
  assert.equal(r.usSKHY.price, 167.86);
});

test('parseTencentText：空/无效文本返回空对象', () => {
  assert.deepEqual(parseTencentText(''), {});
  assert.deepEqual(parseTencentText('var x=1;'), {});
});
