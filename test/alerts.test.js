// 提醒层（页面通知 / 飞书定时推送共用）+ 飞书消息构造 单元测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALERT_KIND,
  buildAlerts,
  selectNewAlerts,
  markAlertsSent,
  summarize,
} from '../web/src/core/alerts.js';
import { signFeishu, buildFeishuCard, assertWebhook } from '../scripts/feishu.mjs';
import { parseFundNavText, parseFundNavSeries } from '../web/src/core/provider/eastmoney.js';

function H(over = {}) {
  return {
    id: 'h1',
    name: '测试标的',
    code: '600519',
    status: '持有',
    region: 'sh',
    type: '股票',
    costMethod: 'FIFO',
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

// ---------- 阈值 → 提醒 ----------

test('止盈命中 → PROFIT 提醒，key 稳定可用于去重', () => {
  const alerts = buildAlerts([H({ targetProfitRate: 20, currentPrice: 12 })], { nearThresholdPct: 2 });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, ALERT_KIND.PROFIT);
  assert.equal(alerts[0].key, 'h1|PROFIT');
  assert.match(alerts[0].title, /止盈/);
  assert.ok(alerts[0].body.length > 0);
  assert.equal(alerts[0].price, 12);
});

test('移动止盈命中 → TRAILING 提醒（从峰值回撤超过阈值）', () => {
  const alerts = buildAlerts(
    [H({ trailingStopPct: 5, peakReturnRate: 30, currentPrice: 12 })], // 收益率 20%，峰值 30%，回撤 10%
    { nearThresholdPct: 2 }
  );
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, ALERT_KIND.TRAILING);
});

test('任一买入记录触及止损 → STOPLOSS 提醒', () => {
  const h = H({ currentPrice: 9, purchases: [{ id: 'p1', buyPrice: 10, buyQuantity: 100, buyTime: '2026-01-01', stopLossRate: 10 }] });
  const alerts = buildAlerts([h], { nearThresholdPct: 2 });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, ALERT_KIND.STOPLOSS);
});

test('跌幅达到补仓线 → REFILL 提醒', () => {
  const alerts = buildAlerts([H({ refillDropRate: 10, currentPrice: 9 })], { nearThresholdPct: 2 });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, ALERT_KIND.REFILL);
});

test('日涨 / 日跌告警按昨收计算，阈值可分别为空', () => {
  const rise = buildAlerts([H({ prevClose: 10, currentPrice: 11, dailyRiseAlertPct: 5 })], {});
  assert.equal(rise.length, 1);
  assert.equal(rise[0].kind, ALERT_KIND.DAILY_RISE);
  assert.ok(Math.abs(rise[0].changePct - 10) < 1e-9);

  const drop = buildAlerts([H({ prevClose: 10, currentPrice: 9, dailyDropAlertPct: 5 })], {});
  assert.equal(drop.length, 1);
  assert.equal(drop[0].kind, ALERT_KIND.DAILY_DROP);

  // 没配阈值就不提醒
  assert.equal(buildAlerts([H({ prevClose: 10, currentPrice: 11 })], {}).length, 0);
});

test('同一持仓可以同时命中策略与日涨跌（两条独立提醒）', () => {
  const h = H({ targetProfitRate: 20, currentPrice: 12, prevClose: 10, dailyRiseAlertPct: 5 });
  const kinds = buildAlerts([h], { nearThresholdPct: 2 }).map((a) => a.kind);
  assert.deepEqual(kinds.sort(), [ALERT_KIND.DAILY_RISE, ALERT_KIND.PROFIT].sort());
});

test('已清仓 / 无行情 / 价格为 0 的持仓一律跳过', () => {
  assert.equal(buildAlerts([H({ status: '全部卖出', targetProfitRate: 20, currentPrice: 30 })], {}).length, 0);
  assert.equal(buildAlerts([H({ currentPrice: null, targetProfitRate: 20 })], {}).length, 0);
  assert.equal(buildAlerts([H({ currentPrice: 0, targetProfitRate: 20 })], {}).length, 0);
  assert.equal(buildAlerts([], {}).length, 0);
});

// ---------- 去重 ----------

test('selectNewAlerts：当天已提醒过的不重复推送，换一天重新提醒', () => {
  const alerts = buildAlerts([H({ targetProfitRate: 20, currentPrice: 12 })], {});
  const sent = markAlertsSent({}, alerts, '2026-11-07');

  assert.equal(selectNewAlerts(alerts, sent, '2026-11-07').length, 0);
  assert.equal(selectNewAlerts(alerts, sent, '2026-11-08').length, 1);
});

test('markAlertsSent 只保留当天记录（跨天自动清空，不会越积越大）', () => {
  const old = { 'h1|PROFIT': '2026-11-06', 'h2|REFILL': '2026-11-06' };
  const alerts = buildAlerts([H({ targetProfitRate: 20, currentPrice: 12 })], {});
  const next = markAlertsSent(old, alerts, '2026-11-07');

  assert.deepEqual(next, { 'h1|PROFIT': '2026-11-07' });
});

test('summarize 把多条提醒压成一句话', () => {
  assert.equal(summarize([]), '无提醒');
  const alerts = buildAlerts([H({ targetProfitRate: 20, currentPrice: 12 })], {});
  assert.match(summarize(alerts), /测试标的/);
});

// ---------- 飞书 ----------

test('飞书签名：key 为 "timestamp\\n secret"，空消息体的 HMAC-SHA256 base64', () => {
  const sign = signFeishu('1700000000', 'my-secret');
  assert.match(sign, /^[A-Za-z0-9+/]{43}=$/); // 32 字节 → 44 字符 base64
  assert.equal(sign, signFeishu('1700000000', 'my-secret')); // 确定性
  assert.notEqual(sign, signFeishu('1700000001', 'my-secret')); // 时间戳参与签名
});

test('飞书卡片：卖点为红色标题、条数写进标题、最多展开 8 条', () => {
  const alerts = buildAlerts([H({ targetProfitRate: 20, currentPrice: 12 })], {});
  const card = buildFeishuCard({ alerts, date: '2026-11-07 08:30 UTC', footer: 'GitHub Actions' });

  assert.equal(card.header.template, 'red');
  assert.match(card.header.title.content, /1 条策略提醒/);
  assert.ok(card.elements.some((e) => e.tag === 'note'));

  const many = Array.from({ length: 11 }, (_, i) => ({ ...alerts[0], key: `k${i}` }));
  const big = buildFeishuCard({ alerts: many });
  assert.ok(big.elements.some((e) => String(e.text?.content || '').includes('另有 3 条')));
});

test('飞书买点用绿色标题', () => {
  const alerts = buildAlerts([H({ refillDropRate: 10, currentPrice: 9 })], {});
  assert.equal(buildFeishuCard({ alerts }).header.template, 'green');
});

// ---------- 基金净值（Actions 定时任务用的解析） ----------

test('parseFundNavText：取最新净值与上一交易日净值（按日期排序，不依赖原始顺序）', () => {
  const js = `var ishb=false;
var Data_netWorthTrend = [{"x":1767225600000,"y":1.5},{"x":1767312000000,"y":1.62}];`;
  const r = parseFundNavText(js);
  assert.deepEqual(r, { price: 1.62, prevClose: 1.5 });

  // 少一天时 prevClose 为 null
  const one = parseFundNavText('var Data_netWorthTrend = [{"x":1767225600000,"y":1.5}];');
  assert.deepEqual(one, { price: 1.5, prevClose: null });
});

test('parseFundNavText：无数据 / 格式损坏一律返回 null，交给上层跳过', () => {
  assert.equal(parseFundNavText(''), null);
  assert.equal(parseFundNavText('var somethingElse = 1;'), null);
  assert.equal(parseFundNavText('var Data_netWorthTrend = [{"x":1,"y":0}];'), null);
  assert.equal(parseFundNavText('var Data_netWorthTrend = [oops];'), null);
  assert.deepEqual(parseFundNavSeries(''), []);
});

test('webhook 只接受飞书 / Lark 官方 https 地址', () => {
  assert.match(
    assertWebhook('https://open.feishu.cn/open-apis/bot/v2/hook/xxx'),
    /open\.feishu\.cn/
  );
  assert.throws(() => assertWebhook('http://open.feishu.cn/open-apis/bot/v2/hook/x'), /https/);
  assert.throws(() => assertWebhook('https://evil.example.com/hook'), /open\.feishu\.cn/);
  assert.throws(() => assertWebhook('not-a-url'), /合法 URL/);
});
