import crypto from 'node:crypto';

// 金额格式化（卡片内用）
function money(v) {
  const n = Number(v);
  return Number.isFinite(n)
    ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '—';
}

function signed(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return (n > 0 ? '+' : '') + money(n);
}

// 分币种明细行
function byCurrencyLines(byCurrency) {
  const entries = Object.entries(byCurrency || {});
  if (!entries.length) return '（暂无在仓品种）';
  return entries
    .map(([c, v]) => `${c}：市值 ${money(v.marketValue)}，持仓收益 ${signed(v.holdingProfit)}，今日 ${signed(v.todayProfit)}`)
    .join('\n');
}

// 构造飞书 interactive 卡片消息
export function buildCard(payload) {
  // ---------- 每日收盘日报 ----------
  if (payload.trigger === 'DAILY_REPORT') {
    const s = payload.snapshot || {};
    return {
      msg_type: 'interactive',
      card: {
        config: { wide_screen_mode: true },
        header: {
          title: { tag: 'plain_text', content: `【收盘日报 · ${payload.date}】` },
          template: Number(s.todayProfit) >= 0 ? 'red' : 'green',
        },
        elements: [
          {
            tag: 'div',
            fields: [
              { is_short: true, text: { tag: 'lark_md', content: `**总市值(CNY)**\n${money(s.marketValue)}` } },
              { is_short: true, text: { tag: 'lark_md', content: `**持仓收益(CNY)**\n${signed(s.holdingProfit)}` } },
              { is_short: true, text: { tag: 'lark_md', content: `**今日收益(CNY)**\n${signed(s.todayProfit)}` } },
              { is_short: true, text: { tag: 'lark_md', content: `**累计已实现(CNY)**\n${signed(s.realizedProfit)}` } },
              { is_short: true, text: { tag: 'lark_md', content: `**在仓品种**\n${s.activeCount ?? 0} 只` } },
              { is_short: true, text: { tag: 'lark_md', content: `**总成本(CNY)**\n${money(s.cost)}` } },
            ],
          },
          { tag: 'hr' },
          { tag: 'div', text: { tag: 'lark_md', content: `**分币种**\n${byCurrencyLines(s.byCurrency)}` } },
          {
            tag: 'note',
            elements: [{ tag: 'plain_text', content: `股票秘书 · ${payload.summary || payload.date}` }],
          },
        ],
      },
    };
  }

  // ---------- 日涨跌告警 ----------
  if (payload.trigger === 'DAILY_RISE' || payload.trigger === 'DAILY_DROP') {
    const isRise = payload.trigger === 'DAILY_RISE';
    return {
      msg_type: 'interactive',
      card: {
        config: { wide_screen_mode: true },
        header: {
          title: { tag: 'plain_text', content: `【日涨跌告警 · ${isRise ? '大涨' : '大跌'}】` },
          template: isRise ? 'red' : 'yellow',
        },
        elements: [
          {
            tag: 'div',
            fields: [
              { is_short: true, text: { tag: 'lark_md', content: `**品种**\n${payload.name}` } },
              { is_short: true, text: { tag: 'lark_md', content: `**代码**\n${payload.code}` } },
              { is_short: true, text: { tag: 'lark_md', content: `**市场/类型**\n${payload.region} / ${payload.type}` } },
              { is_short: true, text: { tag: 'lark_md', content: `**当前价**\n${payload.currentPrice}` } },
            ],
          },
          { tag: 'hr' },
          {
            tag: 'div',
            text: { tag: 'lark_md', content: `**详情**\n${payload.advice}` },
          },
          {
            tag: 'note',
            elements: [
              { tag: 'plain_text', content: `股票秘书 · ${payload.summary}` },
            ],
          },
        ],
      },
    };
  }

  // ---------- 买点 / 卖点 ----------
  const isBuy = payload.trigger === 'BUY';
  const titleMap = {
    PROFIT: '【卖点提醒 · 止盈】',
    TRAILING: '【卖点提醒 · 移动止盈】',
    STOPLOSS: '【卖点提醒 · 止损】',
  };
  const title = isBuy ? '【买点提醒 · 补仓】' : titleMap[payload.reason] || '【卖点提醒 · 止盈】';
  const template = isBuy ? 'green' : 'red';

  return {
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: title },
        template,
      },
      elements: [
        {
          tag: 'div',
          fields: [
            { is_short: true, text: { tag: 'lark_md', content: `**品种**\n${payload.name}` } },
            { is_short: true, text: { tag: 'lark_md', content: `**代码**\n${payload.code}` } },
            { is_short: true, text: { tag: 'lark_md', content: `**市场/类型**\n${payload.region} / ${payload.type}` } },
            { is_short: true, text: { tag: 'lark_md', content: `**当前价**\n${payload.currentPrice}` } },
          ],
        },
        { tag: 'hr' },
        {
          tag: 'div',
          text: { tag: 'lark_md', content: `**操作建议**\n${payload.advice}` },
        },
        {
          tag: 'note',
          elements: [
            { tag: 'plain_text', content: `股票秘书 · ${payload.summary}` },
          ],
        },
      ],
    },
  };
}

// 飞书自定义机器人推送（支持 secret 签名）
export async function sendCard(cfg, payload) {
  const { webhook, secret } = cfg.feishu || {};
  if (!webhook) throw new Error('未配置 feishu.webhook');
  const body = buildCard(payload);

  if (secret) {
    const timestamp = Math.floor(Date.now() / 1000);
    const stringToSign = `${timestamp}\n${secret}`;
    const sign = crypto
      .createHmac('sha256', stringToSign)
      .update('')
      .digest('base64');
    body.timestamp = timestamp;
    body.sign = sign;
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.code !== 0) throw new Error(`feishu error ${JSON.stringify(data)}`);
      return data;
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}
