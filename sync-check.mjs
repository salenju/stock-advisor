// GitHub 私有仓库云同步端到端检查（不需要真的连 GitHub）。
//
// 做法：在浏览器里拦截 https://api.github.com/* 的请求，用内存里的一个「假仓库」
// 应答 Contents API（含 CORS 预检与 sha 乐观锁）。这样就能真实验证：
//   1. 配置面板能保存配置、测通连接，并拦住「公开仓库」
//   2. 云同步模式下新增持仓 → 自动上传**密文**到「仓库」（1.5s 节流）
//   3. 换一台设备（全新浏览器 profile）→ 从云端拉取 → 数据完整恢复
//   4. 加密口令错误时给出明确提示，且不会污染本机数据
//   5. 不填口令时上传明文信封（供用户自救）
//
// 跑法：npm run check:sync
import puppeteer from 'puppeteer-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from './server/server.js';
import { textToBase64, base64ToText, unwrapPayload } from './web/src/core/sync-payload.js';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PASSPHRASE = 'e2e-passphrase-42';
const OWNER = 'salenju';
const REPO = 'stock-data-private';
const HOLDING_NAME = '云同步测试股';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures += 1;
}

// ---------------- 假仓库：一个文件 + 自增 sha，模拟 GitHub Contents API ----------------
function makeFakeRepo({ isPrivate = true } = {}) {
  const state = { file: null, seq: 0, isPrivate, requests: [] };
  const nextSha = () => `sha${++state.seq}`;

  const handle = (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    state.requests.push(`${method} ${url}`);
    const u = new URL(url);

    // 浏览器带 Authorization + PUT 时一定先发 OPTIONS 预检
    if (method === 'OPTIONS') return json(204, {});

    const repoMatch = u.pathname.match(/^\/repos\/([^/]+)\/([^/]+)$/);
    if (repoMatch && method === 'GET') {
      return json(200, {
        full_name: `${repoMatch[1]}/${repoMatch[2]}`,
        private: state.isPrivate,
        default_branch: 'main',
        permissions: { push: true },
      });
    }

    const contentMatch = u.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/);
    if (contentMatch) {
      if (method === 'GET') {
        if (!state.file) return json(404, { message: 'Not Found' });
        return json(200, {
          type: 'file',
          sha: state.file.sha,
          size: state.file.text.length,
          encoding: 'base64',
          content: textToBase64(state.file.text),
        });
      }
      if (method === 'PUT') {
        const body = JSON.parse(init.body || '{}');
        // GitHub 的乐观锁：覆盖已存在的文件必须带正确 sha
        if (state.file && body.sha !== state.file.sha) return json(409, { message: 'sha does not match' });
        if (!state.file && body.sha) return json(409, { message: 'sha given for new file' });
        state.file = { sha: nextSha(), text: base64ToText(body.content) };
        return json(200, { content: { sha: state.file.sha }, commit: { sha: `commit${state.seq}` } });
      }
      if (method === 'DELETE') {
        state.file = null;
        return json(200, {});
      }
    }
    return json(404, { message: `unhandled ${method} ${u.pathname}` });
  };

  return { state, handle };
}

function json(status, body) {
  return { status, text: async () => (status === 204 ? '' : JSON.stringify(body)) };
}

async function attachFakeGithub(page, repo) {
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    const url = req.url();
    try {
      if (url.startsWith('https://api.github.com/')) {
        const res = repo.handle(url, { method: req.method(), body: req.postData() });
        return await req.respond({
          status: res.status,
          headers: {
            'content-type': 'application/json',
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'GET, PUT, DELETE, OPTIONS',
            'access-control-allow-headers': 'Authorization, Accept, Content-Type, X-GitHub-Api-Version',
            'access-control-max-age': '600',
          },
          body: await res.text(),
        });
      }
      // 行情源一律返回空，避免测试依赖外网（界面显示 "—"，不影响同步断言）
      if (/gtimg\.cn|eastmoney\.com/.test(url)) {
        return await req.respond({ status: 200, headers: { 'access-control-allow-origin': '*' }, body: '' });
      }
      await req.continue();
    } catch {
      /* 请求可能已被处理/取消 */
    }
  });
}

// ---------------- 页面辅助 ----------------
async function clickText(page, text, { exact = true } = {}) {
  const ok = await page.evaluate(
    (text, exact) => {
      const btn = [...document.querySelectorAll('button')].find((b) => {
        const t = b.innerText.trim();
        return exact ? t === text : t.includes(text);
      });
      if (!btn || btn.disabled) return false;
      btn.click();
      return true;
    },
    text,
    exact
  );
  if (!ok) throw new Error(`点击失败：「${text}」不存在或被禁用`);
  await sleep(250);
}

async function fillConfig(page, { passphrase, owner = OWNER, repo = REPO }) {
  await page.evaluate(
    (owner, repo, pass) => {
      const setVal = (el, v) => {
        const proto = Object.getPrototypeOf(el);
        Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const ins = [...document.querySelectorAll('dialog.modal-open input')];
      const by = (re) => ins.find((i) => re.test(i.placeholder || ''));
      setVal(by(/salenju/), owner);
      setVal(by(/stock-data/), repo);
      setVal(by(/github_pat_/), 'github_pat_fake_token_for_e2e');
      setVal(by(/留空/), pass);
    },
    owner,
    repo,
    passphrase
  );
  await sleep(200);
}

async function openDataPanel(page) {
  await clickText(page, '数据', { exact: false });
  await sleep(350);
}

// 直接从 IndexedDB 读取持仓（不依赖页面模块，dist 里没有源码路径）
async function readLocalHoldings(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('stock-advisor');
        req.onerror = () => resolve({ error: 'IndexedDB 打不开' });
        req.onsuccess = () => {
          const db = req.result;
          try {
            const g = db.transaction('kv', 'readonly').objectStore('kv').get('holdings');
            g.onsuccess = () => resolve({ list: g.result || [] });
            g.onerror = () => resolve({ error: String(g.error) });
          } catch (e) {
            resolve({ error: String(e.message) });
          }
        };
      })
  );
}

function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  // 记下失败请求的真实 URL：只看到 "Failed to load resource: 404" 是查不出元凶的
  page.on('response', (res) => {
    if (res.status() < 400) return;
    // 探测「云端是否已有数据文件」用的 GET 在文件不存在时必然 404，
    // 这是 readFile() 的正常返回（null），不是错误
    if (res.status() === 404 && res.url().startsWith('https://api.github.com/')) return;
    errors.push(`http ${res.status()}: ${res.url()}`);
  });
  // favicon / manifest 之类的探测失败不影响功能，单独归类，避免误报成 bug
  const isNoise = (e) => /favicon|\.map$|apple-touch-icon/.test(e);
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // 这些 console 文本只带状态码、不带 URL，交给上面的 response 监听补全
    if (/Failed to load resource/.test(m.text())) return;
    if (isNoise(m.text())) return;
    errors.push('console: ' + m.text().slice(0, 200));
  });
  page.on('dialog', (d) => d.accept().catch(() => {}));
  return errors;
}

async function newCleanPage(browser, base, repo) {
  // 先关掉同一个浏览器里的旧页面：旧页面的 IndexedDB 连接会让下面的
  // deleteDatabase 永远卡在 onblocked，新页面的 openDB 也随之挂起
  // （表现为「上传中…」卡死、云端一个请求都没有）。
  for (const p of await browser.pages()) {
    if (!p.isClosed()) await p.close().catch(() => {});
  }
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const errors = watchErrors(page);
  await attachFakeGithub(page, repo);
  await page.goto(`${base}/?mode=github`, { waitUntil: 'networkidle2' });
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        localStorage.clear();
        const req = indexedDB.deleteDatabase('stock-advisor');
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      })
  );
  await page.goto(`${base}/?mode=github`, { waitUntil: 'networkidle2' });
  await sleep(400);
  return { page, errors };
}

// ============================ 主流程 ============================
console.log('构建 dist（服务端托管的是 dist，不是源码）…');
execFileSync('npm', ['run', 'build'], { stdio: 'ignore' });

const server = startServer({
  server: { port: 0, host: '127.0.0.1' },
  auth: { token: '' },
  fx: { rates: {} },
  notify: {},
  schedule: {},
});
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

const profiles = [
  mkdtempSync(path.join(tmpdir(), 'stock-sync-a-')),
  mkdtempSync(path.join(tmpdir(), 'stock-sync-b-')),
];
const browsers = [];

async function launch(profile) {
  const b = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    userDataDir: profile,
    protocolTimeout: 120_000,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  browsers.push(b);
  return b;
}

try {
  // ============ 设备 A：配置 → 上传 → 新增持仓 → 自动推送 ============
  console.log('\n— 设备 A：配置云同步并上传 —');
  const browserA = await launch(profiles[0]);
  const repo = makeFakeRepo({ isPrivate: true });
  const { page: pageA, errors: errorsA } = await newCleanPage(browserA, base, repo);

  const badge = await pageA.$eval('header h1', (el) => el.innerText).catch(() => '');
  check('头部显示云同步徽标', /云同步/.test(badge), badge.replace(/\n/g, ' '));

  await openDataPanel(pageA);
  const panelOpen = await pageA.evaluate(() => document.body.innerText.includes('同步到 GitHub 私有仓库'));
  check('数据面板出现「同步到 GitHub 私有仓库」区块', panelOpen);

  await fillConfig(pageA, { passphrase: PASSPHRASE });
  await clickText(pageA, '测试连接');
  await sleep(900);
  const afterTest = await pageA.evaluate(() => document.body.innerText);
  check('测试连接成功并识别为私有仓库', /连接成功/.test(afterTest) && /（私有）/.test(afterTest));

  await clickText(pageA, '上传到云端');
  await sleep(1200);
  const afterPush = await pageA.evaluate(() => document.body.innerText);
  check('首次上传成功', /已上传到/.test(afterPush), (afterPush.match(/已上传到[^\n]*/) || [''])[0]);
  check('云端文件已创建', !!repo.state.file, repo.state.file ? `${repo.state.file.text.length} 字节` : '无');
  check('云端是密文（不含持仓明文）', !!repo.state.file && !repo.state.file.text.includes(HOLDING_NAME));

  const zero = await unwrapPayload(repo.state.file.text, PASSPHRASE).catch((e) => ({ error: e.message }));
  check('云端密文可用口令解开', !!zero.bundle, zero.error || `${zero.bundle?.holdings?.length ?? 0} 条持仓`);
  check('令牌没有写进云端文件', !!repo.state.file && !repo.state.file.text.includes('github_pat_'));

  // 关闭面板，用真实 UI 新增一条持仓
  await clickText(pageA, '关闭');
  await clickText(pageA, '+ 添加', { exact: false });
  await sleep(300);
  await pageA.evaluate((name) => {
    const ins = [...document.querySelectorAll('dialog.modal-open input')];
    const setVal = (el, v) => {
      const proto = Object.getPrototypeOf(el);
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setVal(ins.find((i) => /腾讯控股/.test(i.placeholder || '')), name);
    setVal(ins.find((i) => /00700/.test(i.placeholder || '')), '000001');
  }, HOLDING_NAME);
  await sleep(200);
  await clickText(pageA, '保存');
  await sleep(3400); // 1.5s 自动上传节流 + 请求往返

  const localA = await readLocalHoldings(pageA);
  check('新增持仓已写入本机', (localA.list?.length ?? 0) === 1, `${localA.list?.length ?? 0} 只`);

  const afterAuto = await unwrapPayload(repo.state.file.text, PASSPHRASE).catch(() => ({ bundle: null }));
  const autoCount = afterAuto.bundle?.holdings?.length ?? -1;
  check('改动后自动上传到云端', autoCount === 1, `云端 ${autoCount} 条`);
  check('云端记录的名称正确', !!afterAuto.bundle?.holdings?.some((h) => h.name === HOLDING_NAME));

  check('设备 A 无页面错误', errorsA.length === 0, errorsA.slice(0, 3).join(' | '));

  // ============ 设备 B：全新环境，从云端恢复 ============
  console.log('\n— 设备 B：全新环境，从云端恢复 —');
  const browserB = await launch(profiles[1]);
  const { page: pageB, errors: errorsB } = await newCleanPage(browserB, base, repo);

  const emptyB = await readLocalHoldings(pageB);
  check('设备 B 初始为空（模拟新手机）', (emptyB.list?.length ?? -1) === 0, `${emptyB.list?.length} 只`);

  await openDataPanel(pageB);
  await fillConfig(pageB, { passphrase: PASSPHRASE });
  await clickText(pageB, '从云端拉取');
  await sleep(1600);

  const afterPull = await pageB.evaluate(() => document.body.innerText);
  check('设备 B 拉取成功提示', /拉取完成/.test(afterPull), (afterPull.match(/拉取完成[^\n]*/) || [''])[0]);

  const restored = await readLocalHoldings(pageB);
  check('设备 B 数据已恢复', (restored.list?.length ?? 0) === 1, `${restored.list?.length ?? 0} 只`);
  check('恢复的持仓名称正确', !!restored.list?.some((h) => h.name === HOLDING_NAME));

  // 错误口令：应报错且不动本机数据
  console.log('\n— 设备 B：错误口令 —');
  await fillConfig(pageB, { passphrase: 'totally-wrong-pass' });
  await clickText(pageB, '从云端拉取');
  await sleep(1400);
  const badMsg = await pageB.evaluate(() => document.body.innerText);
  check('错误口令给出「解密失败」提示', /解密失败/.test(badMsg));
  const afterBad = await readLocalHoldings(pageB);
  check('错误口令没有破坏本机数据', (afterBad.list?.length ?? 0) === 1, `${afterBad.list?.length ?? 0} 只`);
  check(
    '设备 B 除口令错误外无页面错误',
    errorsB.filter((e) => !/解密失败|401|Failed to fetch/.test(e)).length === 0,
    errorsB.slice(0, 3).join(' | ')
  );

  // ============ 明文模式（不填口令） ============
  console.log('\n— 明文模式（不填口令）—');
  const repo2 = makeFakeRepo({ isPrivate: true });
  const { page: pageC } = await newCleanPage(browserB, base, repo2);
  await openDataPanel(pageC);
  await fillConfig(pageC, { passphrase: '' });
  await clickText(pageC, '测试连接'); // 「上传到云端」要求先测通连接
  await sleep(900);
  await clickText(pageC, '上传到云端');
  await sleep(1400);
  const plain = repo2.state.file ? JSON.parse(repo2.state.file.text) : null;
  check('不填口令时上传的是明文信封', !!plain && plain.encrypted === false && typeof plain.payload === 'string');
  const plainBundle = plain ? JSON.parse(plain.payload) : null;
  check('明文信封保留了可自救的持仓数据', Array.isArray(plainBundle?.holdings));

  // ============ 公开仓库告警 ============
  console.log('\n— 公开仓库告警 —');
  const repo3 = makeFakeRepo({ isPrivate: false });
  const { page: pageD } = await newCleanPage(browserB, base, repo3);
  await openDataPanel(pageD);
  await fillConfig(pageD, { passphrase: 'p' });
  await clickText(pageD, '测试连接');
  await sleep(1000);
  const pubMsg = await pageD.evaluate(() => document.body.innerText);
  check('公开仓库时给出明确警告', /公开/.test(pubMsg) && /Private/.test(pubMsg), (pubMsg.match(/警告[^\n]*/) || [''])[0].slice(0, 80));
  const syncDisabled = await pageD.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === '双向同步');
    return !!b && b.disabled;
  });
  check('公开仓库时「双向同步」被禁用（防误传）', syncDisabled);
} catch (e) {
  console.error('\n✗ 运行异常：', e.stack || e.message);
  failures += 1;
} finally {
  for (const b of browsers) await b.close().catch(() => {});
  server.close?.();
  for (const p of profiles) rmSync(p, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? '✓ 全部通过' : `✗ ${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
