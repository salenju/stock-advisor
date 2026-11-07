#!/usr/bin/env node
// 定时提醒：GitHub Actions 每 N 分钟跑一次 → 读你自己的私有仓库数据 → 拉行情 → 判阈值 → 命中才推飞书。
//
// 为什么放在 Actions 里：纯静态站没有后端，浏览器关掉就没人盯着。
// 这个脚本充当「无人值守的那双眼睛」，而数据仍然只待在你自己的私有仓库里。
//
// 需要的环境变量（Secrets / Variables）：
//   DATA_TOKEN       必填，能读写数据仓库的令牌（Contents: Read and write）
//   DATA_OWNER       必填，数据仓库的 owner
//   DATA_REPO        必填，数据仓库名
//   DATA_PATH        可选，数据文件路径，默认 stock-advisor-data.json
//   DATA_BRANCH      可选，分支，默认 main
//   DATA_PASSPHRASE  可选，页面里填过的加密口令（启用端到端加密时必填）
//   FEISHU_WEBHOOK   必填，飞书自定义机器人地址
//   FEISHU_SECRET    可选，机器人开启「签名校验」时必填
//   NOTIFY_COOLDOWN_HOURS 可选，同一提醒的冷却小时数，默认 12
//   NOTIFY_DRY_RUN   可选，'true' 时只打印卡片、不发消息、不写状态
//
// 退出码：0 = 正常（包含"没有命中"），1 = 配置或运行出错（Actions 会标红）。
import { migrateHoldings } from '../web/src/core/schema.js';
import { fetchPrices, toTencentCode } from '../web/src/core/provider/tencent.js';
import { parseFundNavText } from '../web/src/core/provider/eastmoney.js';
import { applyQuotes } from '../web/src/core/quote.js';
import { unwrapPayload } from '../web/src/core/sync-payload.js';
import { buildAlerts, today } from '../web/src/core/alerts.js';
import { buildFeishuCard, sendFeishu } from './feishu.mjs';

const API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const STATE_FILE = 'notify-state.json';
const STATE_KEEP_DAYS = 7;

function env(name, fallback = '') {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function required(name) {
  const v = env(name);
  if (!v) throw new Error(`缺少环境变量 ${name}（见 docs/飞书定时提醒配置.md）`);
  return v;
}

function log(...args) {
  console.log(...args);
}

// ---------- GitHub 数据仓库读写（只用一个文件当数据库） ----------

function ghHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': API_VERSION,
  };
}

function normalizePath(p) {
  const parts = String(p || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s && s !== '.');
  if (parts.some((s) => s === '..')) throw new Error('数据文件路径不能包含 ".."');
  return parts.join('/') || 'stock-advisor-data.json';
}

async function ghRead(cfg, path) {
  const apiPath = `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${encodeURI(path)}`;
  const query = cfg.branch ? `?ref=${encodeURIComponent(cfg.branch)}` : '';
  const res = await fetch(`${API}${apiPath}${query}`, {
    headers: { ...ghHeaders(cfg.token), Accept: 'application/vnd.github+json' },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`读取 ${cfg.owner}/${cfg.repo}/${path} 失败：HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  const text = json?.content ? Buffer.from(json.content, json.encoding || 'base64').toString('utf8') : '';
  return { text, sha: json.sha };
}

async function ghWrite(cfg, path, text, message) {
  const apiPath = `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${encodeURI(path)}`;
  const body = {
    message,
    content: Buffer.from(text, 'utf8').toString('base64'),
  };
  const existing = await ghRead(cfg, path);
  if (existing) body.sha = existing.sha;
  if (cfg.branch) body.branch = cfg.branch;

  const res = await fetch(`${API}${apiPath}`, {
    method: 'PUT',
    headers: { ...ghHeaders(cfg.token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    throw new Error(`写入 ${path} 失败：HTTP ${res.status} ${raw.slice(0, 200)}`);
  }
  return res.json();
}

// ---------- 行情 ----------

const isFund = (h) => String(h?.type || '').includes('基金');
/** 与 core/quote.js 的 quoteKey 保持一致：基金用裸代码，股票用腾讯代码 */
const quoteKeyOf = (h) => (isFund(h) ? String(h.code) : toTencentCode(h.region, h.code));

/** 场外基金：东财 pingzhongdata 里的净值序列（Node 里直接按文本抓，不需要注入 script） */
async function fetchFundNav(code) {
  const res = await fetch(`https://fund.eastmoney.com/pingzhongdata/${encodeURIComponent(code)}.js`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) return null;
  const text = await res.text();
  return parseFundNavText(text);
}

async function collectPrices(holdings) {
  const prices = {};

  const stockCodes = [...new Set(holdings.filter((h) => !isFund(h)).map((h) => toTencentCode(h.region, h.code)))];
  if (stockCodes.length) {
    try {
      Object.assign(prices, await fetchPrices(stockCodes));
    } catch (e) {
      log(`⚠️ 股票行情拉取失败：${e.message}`);
    }
  }

  const fundCodes = [...new Set(holdings.filter(isFund).map((h) => String(h.code)))];
  for (const code of fundCodes) {
    try {
      const nav = await fetchFundNav(code);
      if (nav) prices[code] = nav;
      else log(`⚠️ 基金 ${code} 未取到净值`);
    } catch (e) {
      log(`⚠️ 基金 ${code} 净值拉取失败：${e.message}`);
    }
  }

  return prices;
}

// ---------- 冷却（Actions 每次都是全新环境，状态只能落在数据仓库里） ----------

function pruneState(sent, now) {
  const minTs = now - STATE_KEEP_DAYS * 86400000;
  const next = {};
  for (const [k, v] of Object.entries(sent || {})) {
    const ts = Date.parse(v);
    if (Number.isFinite(ts) && ts >= minTs) next[k] = v;
  }
  return next;
}

function pickFresh(alerts, sent, cooldownMs, now) {
  return (alerts || []).filter((a) => {
    const ts = Date.parse(sent?.[a.key] || '');
    return !Number.isFinite(ts) || now - ts >= cooldownMs;
  });
}

// ---------- 主流程 ----------

async function main() {
  const now = Date.now();
  const dryRun = env('NOTIFY_DRY_RUN') === 'true' || process.argv.includes('--dry-run');

  const cfg = {
    token: required('DATA_TOKEN'),
    owner: required('DATA_OWNER'),
    repo: required('DATA_REPO'),
    branch: env('DATA_BRANCH', 'main'),
  };
  const dataPath = normalizePath(env('DATA_PATH', 'stock-advisor-data.json'));
  const passphrase = env('DATA_PASSPHRASE');
  const webhook = required('FEISHU_WEBHOOK');
  const secret = env('FEISHU_SECRET');
  const cooldownMs = Math.max(0, Number(env('NOTIFY_COOLDOWN_HOURS', '12')) || 12) * 3600000;

  log(`→ 读取数据：${cfg.owner}/${cfg.repo} · ${dataPath} @ ${cfg.branch}`);
  const remote = await ghRead(cfg, dataPath);
  if (!remote) {
    throw new Error(`数据文件不存在：${dataPath}。请先在页面「🗄 数据 → 上传到云端」创建它`);
  }

  const { bundle, encrypted } = await unwrapPayload(remote.text, passphrase);
  log(`  已解密：${encrypted ? '是（AES-GCM）' : '否（明文信封）'}`);

  const { list: holdings } = migrateHoldings(bundle?.holdings || []);
  if (!holdings.length) {
    log('  没有持仓，结束');
    return;
  }

  log(`→ 拉取行情：${holdings.length} 只`);
  const prices = await collectPrices(holdings);
  const settings = bundle?.settings || {};
  const quote = applyQuotes(holdings, prices, {
    nowIso: new Date(now).toISOString(),
    maxMovePct: settings?.notify?.maxDailyMovePct,
  });
  log(`  行情成功 ${quote.quoteOk} / 失败 ${quote.quoteFail}${quote.lastError ? `（${quote.lastError}）` : ''}`);

  const near = settings?.notify?.nearThresholdPct;
  const alerts = buildAlerts(holdings, { nearThresholdPct: near === 0 || near ? near : 2 });
  log(`  命中阈值：${alerts.length} 条`);
  if (!alerts.length) return;

  const statePath = dataPath.includes('/')
    ? `${dataPath.slice(0, dataPath.lastIndexOf('/') + 1)}${STATE_FILE}`
    : STATE_FILE;

  let sent = {};
  try {
    const stateRemote = await ghRead(cfg, statePath);
    if (stateRemote?.text) sent = JSON.parse(stateRemote.text)?.sent || {};
  } catch (e) {
    log(`  状态文件读取失败（按无状态继续）：${e.message}`);
  }

  sent = pruneState(sent, now);
  const fresh = pickFresh(alerts, sent, cooldownMs, now);
  log(`  冷却内跳过：${alerts.length - fresh.length} 条，待推送：${fresh.length} 条`);
  if (!fresh.length) return;

  const card = buildFeishuCard({
    alerts: fresh,
    date: `${today(new Date(now))} ${new Date(now).toISOString().slice(11, 16)} UTC`,
    footer: '股票秘书 · GitHub Actions 定时检查',
  });

  const result = await sendFeishu({ webhook, secret, card, dryRun });
  log(`→ 飞书：${result.skipped ? 'dry-run 未发送' : '已发送'}（${result.msg}）`);
  if (dryRun) {
    log(JSON.stringify(card, null, 2));
    return;
  }

  // 只在真的发出去之后写状态，避免"发了却没记录"或"没发却占冷却"
  for (const a of fresh) sent[a.key] = new Date(now).toISOString();
  try {
    await ghWrite(
      cfg,
      statePath,
      JSON.stringify({ updatedAt: new Date(now).toISOString(), sent }, null, 2),
      `notify: ${fresh.length} 条提醒 @ ${new Date(now).toISOString()}`
    );
    log(`  状态已写入 ${statePath}`);
  } catch (e) {
    log(`⚠️ 状态写入失败（下次可能重复提醒）：${e.message}`);
  }
}

main().catch((e) => {
  console.error(`✖ ${e.message}`);
  process.exitCode = 1;
});
