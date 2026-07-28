import crypto from 'node:crypto';

// 构造飞书 interactive 卡片消息
export function buildCard(payload) {
  // 日涨跌告警
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

  const isBuy = payload.trigger === 'BUY';
  const title = isBuy ? '【买点提醒 · 补仓】' : '【卖点提醒 · 止盈】';
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
  const { webhook, secret } = cfg.feishu;
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
