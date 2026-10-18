// 云同步单测：加密信封往返 + GitHub Contents API 客户端（stub fetch）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bytesToBase64,
  base64ToBytes,
  textToBase64,
  base64ToText,
  isEnvelope,
  wrapForUpload,
  unwrapPayload,
  cryptoAvailable,
  ENVELOPE_KIND,
} from '../web/src/core/sync-payload.js';
import { normalizePath, readFile, writeFile, testConnection } from '../web/src/services/github-api.js';

const BUNDLE = {
  app: 'stock-advisor',
  kind: 'full-backup',
  version: 1,
  schemaVersion: 3,
  exportedAt: '2026-01-01T00:00:00.000Z',
  holdings: [
    { id: 'h1', region: 'sh', code: '600519', name: '贵州茅台', purchases: [{ id: 'p1', buyPrice: 1500 }] },
    { id: 'h2', region: 'us', code: 'AAPL', name: '苹果', purchases: [] },
  ],
  snapshots: [{ date: '2026-01-01', total: 100 }],
  settings: { fx: { rates: { CNY: 1, USD: 7.1 } } },
  meta: { updatedAt: '2026-01-01T00:00:00.000Z' },
};

// ---------- base64 编解码 ----------

test('base64：字节与文本往返（含中文与 emoji）', () => {
  const text = '贵州茅台 📈 AAPL\n第二行';
  const b64 = textToBase64(text);
  assert.equal(base64ToText(b64), text);

  const bytes = new Uint8Array([0, 1, 127, 128, 255]);
  assert.deepEqual([...base64ToBytes(bytesToBase64(bytes))], [...bytes]);
});

test('base64：大文本分块编码不炸栈（>64KB）', () => {
  const big = 'A'.repeat(200000);
  const b64 = textToBase64(big);
  assert.equal(base64ToText(b64).length, big.length);
});

test('base64：忽略换行（GitHub 返回的 content 带 \\n）', () => {
  const b64 = textToBase64('hello world');
  const wrapped = b64.slice(0, 4) + '\n' + b64.slice(4);
  assert.equal(base64ToText(wrapped), 'hello world');
});

// ---------- 信封 ----------

test('cryptoAvailable：Node 里可用的 WebCrypto', () => {
  assert.equal(cryptoAvailable(), true);
});

test('明文信封：不填口令时仍是可识别信封，且能原样读回', async () => {
  const text = await wrapForUpload(BUNDLE, '');
  const obj = JSON.parse(text);
  assert.equal(obj.kind, ENVELOPE_KIND);
  assert.equal(obj.encrypted, false);
  assert.ok(isEnvelope(obj));

  const { bundle, encrypted } = await unwrapPayload(text, '');
  assert.equal(encrypted, false);
  assert.deepEqual(bundle.holdings, BUNDLE.holdings);
});

test('密文信封：加密后不含明文关键词，正确口令能还原', async () => {
  const text = await wrapForUpload(BUNDLE, 'my-passphrase');
  assert.equal(text.includes('贵州茅台'), false);
  assert.equal(text.includes('600519'), false);

  const obj = JSON.parse(text);
  assert.equal(obj.encrypted, true);
  assert.equal(obj.kdf.algo, 'PBKDF2-SHA256');
  assert.equal(obj.cipher.algo, 'AES-GCM');

  const { bundle, encrypted } = await unwrapPayload(text, 'my-passphrase');
  assert.equal(encrypted, true);
  assert.deepEqual(bundle.holdings, BUNDLE.holdings);
  assert.equal(bundle.settings.fx.rates.USD, 7.1);
});

test('密文信封：错口令 / 空口令都给出可读错误', async () => {
  const text = await wrapForUpload(BUNDLE, 'right-pass');
  await assert.rejects(() => unwrapPayload(text, 'wrong-pass'), /解密失败：加密口令不正确/);
  await assert.rejects(() => unwrapPayload(text, ''), /已加密，请先填写加密口令/);
});

test('同一份数据两次加密得到不同密文（随机 salt/iv）', async () => {
  const a = await wrapForUpload(BUNDLE, 'p');
  const b = await wrapForUpload(BUNDLE, 'p');
  assert.notEqual(a, b);
  assert.deepEqual((await unwrapPayload(a, 'p')).bundle.holdings, (await unwrapPayload(b, 'p')).bundle.holdings);
});

test('兼容裸备份 JSON 与裸 holdings 数组（用户手工放进仓库）', async () => {
  const bare = await unwrapPayload(JSON.stringify(BUNDLE));
  assert.equal(bare.encrypted, false);
  assert.deepEqual(bare.bundle.holdings, BUNDLE.holdings);

  const arr = await unwrapPayload(JSON.stringify(BUNDLE.holdings));
  assert.equal(Array.isArray(arr.bundle), true);
  assert.equal(arr.bundle.length, 2);
});

test('坏文件给出可读错误而不是崩溃', async () => {
  await assert.rejects(() => unwrapPayload('not json'), /不是合法 JSON/);
  await assert.rejects(
    () => unwrapPayload(JSON.stringify({ kind: ENVELOPE_KIND, encrypted: false, payload: '{{{' })),
    /payload 不是合法 JSON/
  );
});

// ---------- 路径规范化 ----------

test('normalizePath：去前导斜杠、折叠空段、默认文件名', () => {
  assert.equal(normalizePath('/data/x.json'), 'data/x.json');
  assert.equal(normalizePath('a//b/./c.json'), 'a/b/c.json');
  assert.equal(normalizePath(''), 'stock-advisor-data.json');
  assert.equal(normalizePath(undefined), 'stock-advisor-data.json');
  assert.equal(normalizePath('a\\b.json'), 'a/b.json');
});

test('normalizePath：拒绝 .. 逃逸', () => {
  assert.throws(() => normalizePath('../secret.json'), /不能包含 ".."/);
});

// ---------- GitHub API 客户端（stub fetch） ----------

function stubFetch(handler) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

const CFG = { owner: 'salenju', repo: 'stock-data', path: 'stock-advisor-data.json', branch: 'main', token: 't0ken' };

test('readFile：解码 base64 内容并带出 sha', async () => {
  const content = textToBase64(JSON.stringify(BUNDLE));
  const stub = stubFetch(async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () => JSON.stringify({ sha: 'abc123', size: 42, type: 'file', encoding: 'base64', content }),
  }));
  try {
    const file = await readFile(CFG, { path: CFG.path, branch: 'main' });
    assert.equal(file.sha, 'abc123');
    assert.deepEqual(JSON.parse(file.text).holdings.length, 2);
    assert.match(stub.calls[0].url, /\/repos\/salenju\/stock-data\/contents\/stock-advisor-data\.json\?ref=main$/);
    assert.equal(stub.calls[0].init.headers.Authorization, 'Bearer t0ken');
  } finally {
    stub.restore();
  }
});

test('readFile：404 → null（首次上传时文件还不存在）', async () => {
  const stub = stubFetch(async () => ({
    ok: false,
    status: 404,
    headers: new Headers(),
    text: async () => JSON.stringify({ message: 'Not Found' }),
  }));
  try {
    assert.equal(await readFile(CFG, { path: 'x.json' }), null);
  } finally {
    stub.restore();
  }
});

test('readFile：401 → 提示令牌无效；403 限流 → 提示等到重置', async () => {
  let stub = stubFetch(async () => ({
    ok: false, status: 401, headers: new Headers(), text: async () => JSON.stringify({ message: 'Bad credentials' }),
  }));
  try {
    await assert.rejects(() => readFile(CFG, { path: 'x.json' }), /访问令牌无效或已过期/);
  } finally {
    stub.restore();
  }

  const reset = Math.floor(Date.now() / 1000) + 600;
  stub = stubFetch(async () => ({
    ok: false,
    status: 403,
    headers: new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }),
    text: async () => JSON.stringify({ message: 'API rate limit exceeded' }),
  }));
  try {
    await assert.rejects(() => readFile(CFG, { path: 'x.json' }), /触发了限流/);
  } finally {
    stub.restore();
  }
});

test('writeFile：把文本编码成 base64 并回传 sha（覆盖时必须带 sha）', async () => {
  const stub = stubFetch(async () => ({
    ok: true,
    status: 201,
    headers: new Headers(),
    text: async () => JSON.stringify({ content: { sha: 'newsha' }, commit: { sha: 'c1' } }),
  }));
  try {
    const r = await writeFile(CFG, { path: 'x.json', text: '{"a":1}', sha: 'old', message: 'm' });
    assert.equal(r.sha, 'newsha');
    assert.equal(r.commit, 'c1');
    const body = JSON.parse(stub.calls[0].init.body);
    assert.equal(base64ToText(body.content), '{"a":1}');
    assert.equal(body.sha, 'old');
    assert.equal(body.branch, 'main');
    assert.equal(body.message, 'm');
  } finally {
    stub.restore();
  }
});

test('writeFile：首次创建不带 sha 字段', async () => {
  const stub = stubFetch(async () => ({
    ok: true, status: 201, headers: new Headers(), text: async () => JSON.stringify({ content: { sha: 's1' } }),
  }));
  try {
    await writeFile(CFG, { path: 'x.json', text: '{}' });
    assert.equal('sha' in JSON.parse(stub.calls[0].init.body), false);
  } finally {
    stub.restore();
  }
});

test('配置不完整时直接抛出可读错误（不发请求）', async () => {
  const stub = stubFetch(async () => { throw new Error('不该发请求'); });
  try {
    await assert.rejects(() => readFile({ owner: 'a', repo: '', token: '' }, { path: 'x' }), /GitHub 配置不完整：缺少 仓库名、访问令牌/);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('testConnection：报告仓库是否私有、文件是否存在', async () => {
  let n = 0;
  const stub = stubFetch(async () => {
    n += 1;
    const payload = n === 1
      ? { full_name: 'salenju/stock-data', private: true, default_branch: 'main', permissions: { push: true } }
      : { sha: 'f1', size: 100, type: 'file', encoding: 'base64', content: textToBase64('{}') };
    return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(payload) };
  });
  try {
    const r = await testConnection(CFG);
    assert.equal(r.private, true);
    assert.equal(r.canPush, true);
    assert.equal(r.defaultBranch, 'main');
    assert.equal(r.fileExists, true);
  } finally {
    stub.restore();
  }
});
