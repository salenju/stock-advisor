// 子路径部署检查（模拟 GitHub Pages 项目站点 http://host/<repo>/）
//
// 做三件事：① 用 VITE_BASE=/<repo>/、VITE_DATA_MODE=local 构建
//           ② 把 dist 放到 <tmp>/<repo>/ 下用最小静态服务托管
//           ③ 无头 Chrome 打开，校验资源无 404、manifest 可解析、可安装、SW 作用域正确
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFile, rm, mkdir, cp } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const REPO = 'stock-advisor';
const PREVIEW = '/tmp/gh-pages-preview';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.csv': 'text/csv; charset=utf-8',
};

// ---------- ① 构建 ----------
console.log(`构建中（VITE_BASE=/${REPO}/，VITE_DATA_MODE=local）…`);
execFileSync('npm', ['run', 'build'], {
  env: { ...process.env, VITE_BASE: `/${REPO}/`, VITE_DATA_MODE: 'local' },
  stdio: 'inherit',
});

// ---------- ② 摆成 Pages 的目录结构 ----------
await rm(PREVIEW, { recursive: true, force: true });
await mkdir(join(PREVIEW, REPO), { recursive: true });
await cp('dist', join(PREVIEW, REPO), { recursive: true });

const server = http.createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path.endsWith('/')) path += 'index.html';
  const file = join(PREVIEW, path);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/${REPO}/`;
console.log('预览地址:', base);

// ---------- ③ 浏览器校验 ----------
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});
const page = await browser.newPage();
const bad = [];
const errors = [];
page.on('response', (r) => {
  if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`);
});
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 140));
});
page.on('requestfailed', (r) => bad.push(`FAILED ${r.url()} ${r.failure()?.errorText}`));

const client = await page.createCDPSession();
await client.send('Page.enable');

await page.goto(base, { waitUntil: 'networkidle0', timeout: 60000 });
await new Promise((r) => setTimeout(r, 2500));

const manifest = await client.send('Page.getAppManifest');
const installability = await client.send('Page.getInstallabilityErrors');
const app = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.getRegistration().catch(() => null);
  return {
    rendered: /持仓总览/.test(document.body.innerText),
    localBadge: /本地数据/.test(document.querySelector('header').innerText),
    swScope: reg?.scope || null,
    swActive: reg?.active?.state || null,
    swController: !!navigator.serviceWorker.controller,
  };
});

const ok = (b) => (b ? 'OK' : 'FAIL');
console.log('\n=== 子路径部署检查结果 ===');
console.log('页面渲染（持仓总览）:', ok(app.rendered));
console.log('默认进入本地数据模式:', ok(app.localBadge));
console.log('资源 404/失败:', bad.length ? `FAIL → ${bad.slice(0, 5).join(' | ')}` : 'OK（无）');
console.log('manifest 地址:', manifest.url);
console.log('manifest 解析错误:', manifest.errors?.length ? `FAIL → ${JSON.stringify(manifest.errors)}` : 'OK（无）');
console.log('可安装性:', installability.installabilityErrors?.length
  ? `FAIL → ${JSON.stringify(installability.installabilityErrors)}`
  : 'OK（无错误）');
console.log('Service Worker 作用域:', app.swScope, ok(app.swScope === base));
console.log('  状态:', app.swActive, '| 已接管页面:', app.swController);
console.log('控制台错误:', errors.length ? errors.slice(0, 5) : '无');

await browser.close();
server.close();
process.exit(0);
