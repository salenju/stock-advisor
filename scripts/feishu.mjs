// 飞书自定义机器人：签名、卡片构造、发送。
//
// 只做「把提醒变成一条飞书消息」这一件事，便于单独测试（不读环境变量、不发真实请求也能测卡片）。
// 官方文档：https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot
import crypto from 'node:crypto';
import { ALERT_LABEL, ALERT_KIND } from '../web/src/core/alerts.js';

// 只允许飞书/Lark 官方域名，避免把 webhook 环境变量写错指向别处
const ALLOWED_HOSTS = new Set(['open.feishu.cn', 'open.larksuite.com']);

export function assertWebhook(url) {
  let u;
  try {
    u = new URL(String(url || ''));
  } catch {
    throw new Error('FEISHU_WEBHOOK 不是合法 URL');
  }
  if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname)) {
    throw new Error(`FEISHU_WEBHOOK 必须指向 ${[...ALLOWED_HOSTS].join(' / ')} 的 https 地址`);
  }
  return u.toString();
}

/**
 * 飞书签名：base64( HMAC-SHA256( key = `${timestamp}\n${secret}`, msg = '' ) )
 * 启用签名校验的机器人必须带 timestamp + sign，否则返回 19021。
 */
export function signFeishu(timestamp, secret) {
  const stringToSign = `${timestamp}\n${secret}`;
  return crypto.createHmac('sha256', stringToSign).update('').digest('base64');
}

const SELL_KINDS = new Set([ALERT_KIND.PROFIT, ALERT_KIND.TRAILING, ALERT_KIND.STOPLOSS]);
const BUY_KINDS = new Set([ALERT_KIND.REFILL]);

/** 标题颜色：卖点红、买点绿、其余蓝 */
function headerTemplate(alerts) {
  if (alerts.some((a) => SELL_KINDS.has(a.kind))) return 'red';
  if (alerts.some((a) => BUY_KINDS.has(a.kind))) return 'green';
  return 'blue';
}

/**
 * 构造 interactive 卡片。
 * @param {{alerts:Array, date?:string, title?:string, footer?:string, maxItems?:number}} p
 */
export function buildFeishuCard({ alerts = [], date = '', title, footer, maxItems = 8 } = {}) {
  const list = alerts || [];
  const head = list.slice(0, maxItems);
  const elements = head.map((a) => ({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: `**${ALERT_LABEL[a.kind] || a.kind}｜${a.name}**${a.code ? `（${a.code}）` : ''}\n${a.body || ''}`,
    },
  }));

  if (list.length > head.length) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `…另有 ${list.length - head.length} 条提醒未展开` },
    });
  }

  const noteText = [date ? `判定时间：${date}` : '', footer].filter(Boolean).join(' · ');
  if (noteText) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: noteText }] });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      template: headerTemplate(list),
      title: { tag: 'plain_text', content: title || `股票秘书 · ${list.length} 条策略提醒` },
    },
    elements,
  };
}

/**
 * 发送卡片。
 * @param {{webhook:string, secret?:string, card:object, dryRun?:boolean, timeoutMs?:number}} p
 * @returns {Promise<{ok:boolean, code?:number, msg?:string, skipped?:boolean}>}
 */
export async function sendFeishu({ webhook, secret, card, dryRun = false, timeoutMs = 15000 }) {
  const url = assertWebhook(webhook);
  const body = { msg_type: 'interactive', card };

  if (secret) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    body.timestamp = timestamp;
    body.sign = signFeishu(timestamp, secret);
  }

  if (dryRun) {
    return { ok: true, skipped: true, code: 0, msg: 'dry-run：未真正发送', payload: body };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new Error(`请求飞书失败：${e.message}`);
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* 非 JSON 响应按失败处理 */
  }
  const code = data?.code ?? data?.StatusCode;
  const msg = data?.msg || data?.StatusMessage || '';

  if (!res.ok || (code !== undefined && Number(code) !== 0)) {
    throw new Error(`飞书返回 ${res.status}${code !== undefined ? ` / code ${code}` : ''}${msg ? `：${msg}` : ''}`);
  }
  return { ok: true, code: Number(code) || 0, msg: msg || 'success' };
}
