// 提醒事件层：把「持仓 + 阈值」变成一组可展示、可去重、可分发的提醒。
//
// 为什么单独一层：
//   同一个提醒要发到两个完全不同的地方——浏览器通知（页面里）和飞书（GitHub Actions 定时跑）。
//   判定口径必须只有一份，否则两处提示会对不上。所以这里只做纯计算，不碰 DOM / Notification / fetch。
//
// 去重语义（两端一致）：
//   同一只持仓 + 同一种提醒，**同一天只提醒一次**；
//   页面用本地 localStorage 记录，Actions 脚本用数据仓库里的 notify-state.json 记录（按小时冷却）。
import { evaluate } from './strategy.js';
import { isActive } from './derive.js';
import { beijingNow } from './market.js';

export const ALERT_KIND = {
  PROFIT: 'PROFIT',
  TRAILING: 'TRAILING',
  STOPLOSS: 'STOPLOSS',
  REFILL: 'REFILL',
  DAILY_RISE: 'DAILY_RISE',
  DAILY_DROP: 'DAILY_DROP',
};

export const ALERT_LABEL = {
  PROFIT: '止盈',
  TRAILING: '移动止盈',
  STOPLOSS: '止损',
  REFILL: '补仓',
  DAILY_RISE: '日涨告警',
  DAILY_DROP: '日跌告警',
};

// 策略引擎的 reason → 提醒类型
const SELL_REASON_KIND = {
  PROFIT: ALERT_KIND.PROFIT,
  TRAILING: ALERT_KIND.TRAILING,
  STOPLOSS: ALERT_KIND.STOPLOSS,
};

/** 北京时间当天（YYYY-MM-DD），去重与展示都以它为准 */
export function today(now = new Date()) {
  return beijingNow(now).date;
}

function makeAlert(h, kind, body, extra = {}) {
  const name = h?.name || h?.code || '未知标的';
  return {
    key: `${h?.id || h?.code || 'unknown'}|${kind}`,
    holdingId: h?.id || null,
    name,
    code: String(h?.code || ''),
    region: String(h?.region || ''),
    kind,
    label: ALERT_LABEL[kind] || kind,
    title: `${ALERT_LABEL[kind] || kind} · ${name}`,
    body: String(body || ''),
    price: extra.price ?? null,
    ...extra,
  };
}

/**
 * 扫描全部持仓，产出当前命中的提醒（不含去重，去重交给 selectNewAlerts）。
 * @param {Array} holdings 持仓数组（需已带 currentPrice）
 * @param {{nearThresholdPct?:number}} [opts]
 * @returns {Array<{key:string,holdingId:string,name:string,code:string,region:string,
 *                  kind:string,label:string,title:string,body:string,price:number|null}>}
 */
export function buildAlerts(holdings, opts = {}) {
  const nearRaw = Number(opts.nearThresholdPct);
  const near = Number.isFinite(nearRaw) && nearRaw >= 0 ? nearRaw : 2;
  const out = [];

  for (const h of holdings || []) {
    if (!h || !isActive(h)) continue; // 已清仓不再提醒
    const price = Number(h.currentPrice);
    if (!Number.isFinite(price) || price <= 0) continue; // 停牌/行情缺失

    // ---- ①②③ 策略阈值（止盈 / 移动止盈 / 止损 / 补仓），口径来自 strategy.js ----
    const ev = evaluate(h, near);
    if (ev.trigger === 'SELL' && SELL_REASON_KIND[ev.reason]) {
      out.push(makeAlert(h, SELL_REASON_KIND[ev.reason], ev.advice, { price, returnRate: ev.returnRate }));
    } else if (ev.trigger === 'BUY') {
      out.push(makeAlert(h, ALERT_KIND.REFILL, ev.advice, { price, dropRate: ev.dropRate }));
    }

    // ---- ④ 日涨跌告警：与策略引擎无关，只看相对昨收的涨跌幅 ----
    const prevClose = Number(h.prevClose);
    if (!Number.isFinite(prevClose) || prevClose <= 0) continue;
    const changePct = ((price - prevClose) / prevClose) * 100;

    const rise = Number(h.dailyRiseAlertPct);
    if (rise > 0 && changePct >= rise) {
      out.push(
        makeAlert(
          h,
          ALERT_KIND.DAILY_RISE,
          `当前价 ${price}，较昨收 ${prevClose} 上涨 ${changePct.toFixed(2)}%，已达到日涨告警阈值 ${rise}%。`,
          { price, changePct }
        )
      );
    }

    const drop = Number(h.dailyDropAlertPct);
    if (drop > 0 && changePct <= -drop) {
      out.push(
        makeAlert(
          h,
          ALERT_KIND.DAILY_DROP,
          `当前价 ${price}，较昨收 ${prevClose} 下跌 ${Math.abs(changePct).toFixed(2)}%，已达到日跌告警阈值 ${drop}%。`,
          { price, changePct }
        )
      );
    }
  }

  return out;
}

/** 过滤掉「今天已经提醒过」的项 */
export function selectNewAlerts(alerts, sent = {}, day = today()) {
  const seen = sent || {};
  return (alerts || []).filter((a) => a?.key && seen[a.key] !== day);
}

/**
 * 记录已提醒：只保留当天的记录（跨天自动清空，不会无限增长）。
 * @returns {Object<string,string>} 新的 sent 映射 {key: 'YYYY-MM-DD'}
 */
export function markAlertsSent(sent = {}, alerts = [], day = today()) {
  const next = {};
  for (const [k, v] of Object.entries(sent || {})) {
    if (v === day) next[k] = v;
  }
  for (const a of alerts || []) {
    if (a?.key) next[a.key] = day;
  }
  return next;
}

/** 把提醒列表压成一句话（通知标题/日志用） */
export function summarize(alerts) {
  const list = alerts || [];
  if (!list.length) return '无提醒';
  if (list.length === 1) return list[0].title;
  return `${list.length} 条提醒：${list.map((a) => `${a.name}·${a.label}`).join('、')}`;
}
