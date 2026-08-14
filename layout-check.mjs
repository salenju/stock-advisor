// 移动端布局度量检查：检测水平溢出、头部按钮边界、概览卡片、图表渲染
import puppeteer from 'puppeteer-core';
import { startServer } from './server/server.js';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const cfg = {
  server: { host: '127.0.0.1', port: 0 },
  fx: { rates: { USD_CNY: 7.0, HKD_CNY: 0.9 } },
  notify: {},
  schedule: {},
};

const server = startServer(cfg);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});
const page = await browser.newPage();

async function check(width, label) {
  await page.setViewport({ width, height: 844, deviceScaleFactor: 1 });
  await page.goto(base, { waitUntil: 'networkidle0', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 4000));
  const r = await page.evaluate(() => {
    const doc = document.documentElement;
    const overflowX = doc.scrollWidth - window.innerWidth;
    const buttons = [...document.querySelectorAll('header button')].map((b) => {
      const r = b.getBoundingClientRect();
      return { text: b.textContent.trim().slice(0, 12), left: Math.round(r.left), right: Math.round(r.right), inView: r.right <= window.innerWidth + 1 && r.left >= -1 };
    });
    const cards = [...document.querySelectorAll('main .rounded-xl')].filter((c) => c.getBoundingClientRect().width > 100).slice(0, 12).map((c) => {
      const r = c.getBoundingClientRect();
      const cs = getComputedStyle(c);
      return { w: Math.round(r.width), l: Math.round(r.left), r: Math.round(r.right), grid: cs.display === 'grid' ? getComputedStyle(c).gridTemplateColumns.split(' ').length : null, overflow: r.right > window.innerWidth + 1 };
    });
    // 概览卡片里的金额是否溢出
    const valueOverflows = [...document.querySelectorAll('main div')]
      .filter((d) => d.scrollWidth > d.clientWidth + 2 && d.clientWidth > 0 && d.clientWidth < 300)
      .slice(0, 6)
      .map((d) => ({ text: d.textContent.trim().slice(0, 24), cw: d.clientWidth, sw: d.scrollWidth }));
    // 图表 canvas
    const canvases = [...document.querySelectorAll('canvas')].map((c) => ({ w: c.width, h: c.height }));
    return {
      overflowX,
      buttons,
      cards,
      valueOverflows,
      canvases,
    };
  });
  const badButtons = r.buttons.filter((b) => !b.inView);
  const badCards = r.cards.filter((c) => c.overflow);
  console.log(`\n=== ${label} (${width}px) ===`);
  console.log('横向溢出(px):', r.overflowX);
  console.log('头部按钮数:', r.buttons.length, '越界按钮:', badButtons.length ? JSON.stringify(badButtons) : '无');
  console.log('概览/持仓卡片:', r.cards.map((c) => `${c.w}px`).join(', '), '越界:', badCards.length ? '有!' : '无');
  console.log('金额文本溢出(截断/超宽):', r.valueOverflows.length ? JSON.stringify(r.valueOverflows) : '无');
  console.log('canvas(图表):', JSON.stringify(r.canvases));
  return !r.overflowX && !badButtons.length && !badCards.length;
}

let ok = true;
ok = (await check(390, 'iPhone 14')) && ok;
ok = (await check(375, 'iPhone SE')) && ok;
ok = (await check(320, '超窄屏')) && ok;

await browser.close();
server.close();
console.log('\n结论:', ok ? '✅ 全部通过' : '❌ 存在问题');
process.exit(ok ? 0 : 1);
