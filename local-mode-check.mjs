// 本地数据模式端到端检查：导入 → 行情直连 → 持久化 → 导出备份 → 版本快照回滚 → 切回服务端模式
import puppeteer from 'puppeteer-core';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { startServer } from './server/server.js';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const fixture = '/tmp/stock-local-import.json';
// 样例：一只场外基金（走东财 script 注入）+ 一只 A 股（走腾讯 fetch，验证 GBK 解码与 CORS）
const fixtureData = JSON.parse(readFileSync('data/holdings.example.json', 'utf-8'));
fixtureData.push({
  id: 'h_example_0002',
  name: '示例·贵州茅台',
  code: '600519',
  status: '持有',
  region: 'sh',
  type: '股票',
  costMethod: 'LIFO',
  purchases: [
    { id: 'p_example_0002', buyPrice: 1500, buyQuantity: 100, buyTime: '2026-01-13', fee: 10, targetProfitRate: 20, stopLossRate: 20 },
  ],
  sells: [],
  dividends: [],
  splits: [],
  currentPrice: null,
  prevClose: null,
});
writeFileSync(fixture, JSON.stringify(fixtureData, null, 2));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = startServer({
  server: { port: 0, host: '127.0.0.1' },
  auth: { token: '' },
  fx: { rates: {} },
  notify: {},
  schedule: {},
});
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });

const errors = [];
const logs = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 160));
  else if (/\[quote\]|\[pwa\]/.test(m.text())) logs.push(m.type() + ': ' + m.text().slice(0, 160));
});
page.on('dialog', (d) => d.accept().catch(() => {}));

try {
  const client = await page.createCDPSession();
  mkdirSync('/tmp/stock-dl', { recursive: true });
  await client
    .send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: '/tmp/stock-dl' })
    .catch(() => {});
} catch {
  /* 忽略 */
}

async function clickByText(scope, text) {
  const handle = await page.evaluateHandle(
    (scope, text) => {
      const root = document.querySelector(scope);
      if (!root) return null;
      return [...root.querySelectorAll('button')].find((b) => b.innerText.trim().includes(text)) || null;
    },
    scope,
    text
  );
  const el = handle.asElement();
  if (!el) throw new Error(`找不到按钮「${text}」（scope=${scope}）`);
  await el.click();
}
const panelText = () => page.$eval('dialog.modal-open', (el) => el.innerText);
const has = (t, s) => (t.includes(s) ? 'OK' : 'FAIL');

// ---------- 1. 以本地模式启动 ----------
await page.goto(`${base}/?mode=local`, { waitUntil: 'networkidle0', timeout: 60000 });
await sleep(1500);
let headerText = await page.$eval('header', (el) => el.innerText);
console.log('1) 模式徽标「本地数据」:', has(headerText, '本地数据'));
console.log('   服务端专属按钮「测试飞书」已隐藏:', headerText.includes('测试飞书') ? 'FAIL' : 'OK');

// ---------- 2. 数据面板 ----------
await page.click('header button[title*="数据存放位置"]');
await page.waitForSelector('dialog.modal-open', { timeout: 5000 });
let p = await panelText();
console.log('2) 存储驱动 IndexedDB:', has(p, 'IndexedDB'), '| 首次提示需导出备份:', has(p, '该导出备份了'));

// ---------- 3. 导入示例数据（合并） ----------
const input = await page.$('dialog.modal-open input[type=file]');
await input.uploadFile(fixture);
await page.waitForFunction(
  () => document.querySelector('dialog.modal-open').innerText.includes('解析成功'),
  { timeout: 5000 }
);
await clickByText('dialog.modal-open', '开始导入');
await sleep(3000);
p = await panelText();
console.log('3) 导入结果文本:', (p.match(/(导入完成|不是合法|找不到|失败|错误)[^\n]*/) || ['（无结果）'])[0]);
console.log('   面板尾部:', p.split('\n').slice(-6).join(' | '));
console.log('   写入后概览含「2 只」:', has(p, '2 只'));

// ---------- 4. 关闭面板，列表渲染 ----------
await clickByText('dialog.modal-open', '关闭');
await page.waitForFunction(
  () => document.body.innerText.includes('易方达蓝筹') && document.body.innerText.includes('贵州茅台'),
  { timeout: 5000 }
);
console.log('4) 持仓列表已渲染导入的品种: OK');

// ---------- 5. 行情直连（基金走东财 script 注入，股票走腾讯 fetch + GBK 解码） ----------
await clickByText('header', '刷新');
await sleep(8000);
const priceOf = (name) =>
  page.evaluate((name) => {
    const text = document.body.innerText;
    const i = text.indexOf(name);
    if (i < 0) return null;
    const m = text.slice(i, i + 500).match(/成本 \/ 现价[\s\S]{0,40}/);
    return m ? m[0].replace(/\n/g, ' ') : null;
  }, name);
const fundSeg = await priceOf('示例·易方达蓝筹精选');
const stockSeg = await priceOf('示例·贵州茅台');
const filled = (s) => !!s && /\d/.test(s) && !/—/.test(s.split('/')[1] || '');
console.log('5) 基金净值（东财）:', filled(fundSeg) ? `OK → ${fundSeg}` : `未取到 → ${fundSeg}`);
console.log('   股票行情（腾讯/GBK）:', filled(stockSeg) ? `OK → ${stockSeg}` : `未取到 → ${stockSeg}`);
console.log('   quote 日志:', logs.length ? logs : '（无）');

// ---------- 6. 重新加载：验证持久化 ----------
await page.reload({ waitUntil: 'networkidle0', timeout: 60000 });
await sleep(1500);
const persisted = await page.evaluate(() => document.body.innerText.includes('易方达蓝筹'));
console.log('6) 刷新页面后数据仍在（IndexedDB 持久化）:', persisted ? 'OK' : 'FAIL');

// ---------- 7. 导出完整备份 ----------
await page.click('header button[title*="数据存放位置"]');
await page.waitForSelector('dialog.modal-open', { timeout: 5000 });
await clickByText('dialog.modal-open', '导出完整备份');
await page.waitForFunction(
  () => /已导出/.test(document.querySelector('dialog.modal-open').innerText),
  { timeout: 10000 }
);
p = await panelText();
console.log('7) 导出备份:', (p.match(/已导出[^\n]*/) || ['（无）'])[0]);

// ---------- 8. 自动版本快照 + 回滚 ----------
await clickByText('dialog.modal-open', '立即备份');
await page.waitForFunction(
  () => /已创建一份手动备份/.test(document.querySelector('dialog.modal-open').innerText),
  { timeout: 5000 }
);
const backupRows = await page.$$eval('dialog.modal-open .max-h-64 > div', (els) => els.length);
console.log('8) 版本快照条目数:', backupRows);
await clickByText('dialog.modal-open', '回滚');
await page.waitForFunction(
  () => /已回滚/.test(document.querySelector('dialog.modal-open').innerText),
  { timeout: 10000 }
);
p = await panelText();
console.log('   回滚:', (p.match(/已回滚[^\n]*/) || ['（无）'])[0]);

// ---------- 9. 切回服务端模式（验证双模式可来回切换） ----------
await clickByText('dialog.modal-open', '服务端数据');
await page.waitForFunction(() => /服务端数据/.test(document.querySelector('header').innerText), { timeout: 15000 });
await sleep(2500);
const serverText = await page.$eval('header', (el) => el.innerText);
console.log('9) 切换回服务端模式:', has(serverText, '服务端数据'), '| 「测试飞书」按钮恢复:', serverText.includes('测试飞书') ? 'OK' : 'FAIL');
const serverList = await page.$eval('main', (el) => el.innerText);
console.log(
  '   服务端模式数据与本地库隔离（不含本地导入的「示例·贵州茅台」）:',
  serverList.includes('示例·贵州茅台') ? 'FAIL（串数据了）' : 'OK'
);

// ---------- 10. 汇总 ----------
console.log('\n页面错误:', errors.length ? errors.slice(0, 5) : '无');

await browser.close();
server.close();
process.exit(0);
