---
kind: external_dependency
name: 飞书自定义机器人（HMAC-SHA256 签名）
slug: feishu-custom-bot
category: external_dependency
category_hints:
    - vendor_identity
    - auth_protocol
scope:
    - '**'
source_files:
    - server/notifier.js
    - config.json
---

通过 `server/notifier.js` 向飞书自定义机器人推送交互式富文本卡片消息，使用 HMAC-SHA256 签名机制进行鉴权。webhook 地址与 secret 在 `config.json` 中配置；同一品种提醒有默认 3600 秒冷却防刷屏。