// 收益归因统计：把"历史战绩"算出来（已清仓交易的表现、胜率、持有天数、年度已实现收益）。
// 全部为本地计算，无外部依赖。
import { aggregate, dateKey } from './derive.js';
import { currencyOf, currencyCode, fxToCNY } from './currency.js';

const DAY_MS = 86400000;

function daysBetween(a, b) {
  const x = Date.parse(`${a}T00:00:00Z`);
  const y = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return Math.max(0, Math.round((y - x) / DAY_MS));
}

const round2 = (v) => (Number.isFinite(Number(v)) ? +Number(v).toFixed(2) : null);

/**
 * 构建收益归因统计。
 * @param {Array} holdings 全部持仓
 * @param {Object} rates { CNY:1, USD, HKD }
 */
export function buildStats(holdings, rates) {
  const items = [];
  const byYearMap = new Map();

  const addYear = (date, cny) => {
    const y = String(date || '').slice(0, 4);
    if (!/^\d{4}$/.test(y) || !Number.isFinite(cny)) return;
    const rec = byYearMap.get(y) || { year: y, realizedProfit: 0, tradeCount: 0 };
    rec.realizedProfit += cny;
    rec.tradeCount += 1;
    byYearMap.set(y, rec);
  };

  for (const h of holdings || []) {
    const sells = h.sells || [];
    const dividends = h.dividends || [];
    if (!sells.length && !dividends.length) continue;

    const agg = aggregate(h);
    const currency = currencyOf(h.region);

    const buyDates = (h.purchases || []).map((p) => dateKey(p.buyTime)).filter(Boolean).sort();
    const sellDates = sells.map((s) => dateKey(s.sellDate)).filter(Boolean).sort();
    const firstBuy = buyDates[0] || null;
    const lastSell = sellDates[sellDates.length - 1] || null;

    const sellAmount = agg.sells.reduce((s, x) => s + Number(x.marketValue || 0), 0);
    const fullyClosed = agg.remainingQty <= 1e-9 && agg.buyQty > 0;

    // 年度已实现（卖出 + 分红，人民币口径）
    for (const s of agg.sells) addYear(s.buyTime, fxToCNY(s.profit, currency, rates));
    for (const d of agg.dividends) addYear(d.buyTime, fxToCNY(d.profit, currency, rates));

    items.push({
      id: h.id,
      name: h.name,
      code: h.code,
      region: h.region,
      type: h.type,
      status: h.status,
      fullyClosed,
      currency,
      currencyCode: currencyCode(currency),
      costMethod: agg.costMethod,
      buyCost: round2(agg.buyCost),
      buyCostCNY: round2(fxToCNY(agg.buyCost, currency, rates)),
      sellAmount: round2(sellAmount),
      sellAmountCNY: round2(fxToCNY(sellAmount, currency, rates)),
      feesTotal: round2(agg.feesTotal),
      dividend: round2(agg.dividendTotal),
      dividendCNY: round2(fxToCNY(agg.dividendTotal, currency, rates)),
      realizedProfit: round2(agg.realizedProfit),
      realizedProfitCNY: round2(fxToCNY(agg.realizedProfit, currency, rates)),
      realizedReturnRate:
        agg.buyCost > 0 ? round2((agg.realizedProfit / agg.buyCost) * 100) : null,
      remainingQty: round2(agg.remainingQty),
      remainingCost: round2(agg.remainingCost),
      firstBuy,
      lastSell,
      holdDays: firstBuy && lastSell ? daysBetween(firstBuy, lastSell) : null,
      tradeCount: (h.purchases || []).length + sells.length + dividends.length,
      sells: agg.sells.map((s) => ({
        date: s.buyTime,
        price: s.buyPrice,
        quantity: s.buyQuantity,
        costPrice: round2(s.costPrice),
        fee: round2(s.fee),
        profit: round2(s.profit),
        returnRate: round2(s.returnRate),
      })),
      dividends: agg.dividends.map((d) => ({
        date: d.buyTime,
        amount: round2(d.marketValue),
        fee: round2(d.fee),
        note: d.note || '',
      })),
    });
  }

  // 按已实现盈亏排序（人民币口径）
  items.sort((a, b) => (b.realizedProfitCNY || 0) - (a.realizedProfitCNY || 0));

  const closed = items.filter((i) => i.fullyClosed);
  const wins = closed.filter((i) => i.realizedProfit > 0);
  const losses = closed.filter((i) => i.realizedProfit < 0);
  const sum = (arr, k) => arr.reduce((s, x) => s + (Number(x[k]) || 0), 0);
  const grossWin = sum(wins, 'realizedProfitCNY');
  const grossLoss = Math.abs(sum(losses, 'realizedProfitCNY'));
  const holdDaysArr = closed.map((i) => i.holdDays).filter((d) => d != null);

  const byHoldDays = {};
  for (const i of closed) {
    if (i.holdDays == null) continue;
    const key = i.holdDays <= 30 ? '≤1月' : i.holdDays <= 180 ? '1-6月' : i.holdDays <= 365 ? '6-12月' : '>1年';
    const rec = byHoldDays[key] || { bucket: key, count: 0, realizedProfitCNY: 0 };
    rec.count += 1;
    rec.realizedProfitCNY += Number(i.realizedProfitCNY) || 0;
    byHoldDays[key] = rec;
  }

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      totalRealizedCNY: round2(sum(items, 'realizedProfitCNY')),
      closedCount: closed.length,
      openWithSellsCount: items.length - closed.length,
      winCount: wins.length,
      lossCount: losses.length,
      winRate: closed.length ? round2((wins.length / closed.length) * 100) : null,
      avgWinCNY: wins.length ? round2(grossWin / wins.length) : null,
      avgLossCNY: losses.length ? round2(-grossLoss / losses.length) : null,
      grossWinCNY: round2(grossWin),
      grossLossCNY: round2(-grossLoss),
      profitFactor: grossLoss > 0 ? round2(grossWin / grossLoss) : null,
      avgHoldDays: holdDaysArr.length
        ? Math.round(holdDaysArr.reduce((s, d) => s + d, 0) / holdDaysArr.length)
        : null,
      dividendTotalCNY: round2(sum(items, 'dividendCNY')),
    },
    byHoldDays: Object.values(byHoldDays).sort((a, b) => b.count - a.count),
    byYear: [...byYearMap.values()]
      .map((r) => ({ ...r, realizedProfit: round2(r.realizedProfit) }))
      .sort((a, b) => String(a.year).localeCompare(String(b.year))),
    best: closed.slice(0, 3),
    worst: closed.slice(-3).reverse(),
    items,
  };
}
