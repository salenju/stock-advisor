// 集成测试：启动真实 HTTP 服务（端口 0），只读请求 /api/holdings 与 /api/trend。
// 网络侧（腾讯K线/东财净值）用 mock 的 global fetch 打桩，测试可离线、确定性。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/server.js';

// 打桩：按 URL 路由返回 K线 JSON 或 基金净值 JS；本地服务器请求透传
function installFetchMock(t) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('http://127.0.0.1')) return original(u, init); // 测试自身请求
    if (u.includes('ifzq.gtimg.cn')) {
      const param = new URL(u).searchParams.get('param') || '';
      const code = param.split(',')[0];
      // 场外基金无K线 → 空数组，触发东财净值回退
      if (code === 'sh005827') {
        return { ok: true, json: async () => ({ code: 0, data: { [code]: { day: [] } } }) };
      }
      const day = code.startsWith('us')
        ? [['2026-08-14', '160', '167.5', '170', '158', '1000']] // 美股仅当日（贴近真实）
        : [
            ['2026-08-10', '20', '21', '21.5', '19.5', '100'],
            ['2026-08-11', '21', '22', '22.5', '20.5', '100'],
            ['2026-08-12', '22', '23', '23.5', '21.5', '100'],
            ['2026-08-13', '23', '24', '24.5', '22.5', '100'],
            ['2026-08-14', '24', '25', '25.5', '23.5', '100'],
          ];
      return { ok: true, json: async () => ({ code: 0, data: { [code]: { day } } }) };
    }
    if (u.includes('fund.eastmoney.com')) {
      const js =
        'var Data_netWorthTrend = [' +
        [169, 170, 171, 172, 173].map((d, i) =>
          `{"x":${d * 86400000 * 1000},"y":${1.5 + i * 0.01}}`
        ).join(',') +
        '];';
      return { ok: true, text: async () => js };
    }
    throw new Error(`mock fetch 未覆盖的 URL: ${u}`);
  };
  t.after(() => { globalThis.fetch = original; });
}

// 启动服务并等待 listen 完成，返回 base URL
async function startTestServer(t, cfg) {
  const server = startServer(cfg);
  t.after(() => new Promise((r) => server.close(r)));
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('GET /api/holdings：返回币种字段与汇率配置', async (t) => {
  const cfg = {
    server: { host: '127.0.0.1', port: 0 },
    fx: { rates: { USD_CNY: 7.0, HKD_CNY: 0.9 } },
    notify: {},
    schedule: {},
  };
  const { base } = await startTestServer(t, cfg);

  const res = await fetch(`${base}/api/holdings`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(json.fx?.rates, '响应应包含 fx.rates');
  assert.equal(json.fx.rates.USD, 7.0);
  assert.equal(json.fx.rates.HKD, 0.9);
  assert.ok(Array.isArray(json.data) && json.data.length > 0);
  for (const h of json.data) {
    assert.ok(['CNY', 'HKD', 'USD'].includes(h.currency), `${h.name} 应有 currency`);
    assert.ok(typeof h.currencyCode === 'string');
  }
  const xm = json.data.find((h) => h.name.includes('小米'));
  assert.ok(xm, '数据中应包含小米');
  assert.equal(xm.currency, 'HKD');
  assert.equal(xm.currencyCode, 'HKD');
});

test('GET /api/trend：返回逐日序列（K线/净值已打桩）', async (t) => {
  installFetchMock(t);
  const cfg = {
    server: { host: '127.0.0.1', port: 0 },
    fx: { rates: { USD_CNY: 7.0, HKD_CNY: 0.9 } },
    notify: {},
    schedule: {},
  };
  const { base } = await startTestServer(t, cfg);

  const res = await fetch(`${base}/api/trend?range=7d`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.currency, 'CNY');
  assert.equal(json.range, '7d');
  assert.ok(json.dates.length > 0, '应有趋势日期');
  assert.equal(json.dates.length, json.holdingProfit.length);
  assert.equal(json.dates.length, json.todayProfit.length);
  assert.equal(json.dates.length, json.marketValue.length);
  assert.ok(json.rates, '应返回汇率');
  // 打桩的 K线收盘价 + 交易记录，持仓收益应为有限数值
  for (const v of json.holdingProfit) assert.ok(Number.isFinite(v));
});

test('GET /api/trend?range=all：不过滤', async (t) => {
  installFetchMock(t);
  const cfg = {
    server: { host: '127.0.0.1', port: 0 },
    fx: { rates: { USD_CNY: 7.0, HKD_CNY: 0.9 } },
    notify: {},
    schedule: {},
  };
  const { base } = await startTestServer(t, cfg);
  const res = await fetch(`${base}/api/trend?range=all`);
  const json = await res.json();
  assert.equal(json.range, 'all');
  assert.ok(json.dates.length > 0);
});
