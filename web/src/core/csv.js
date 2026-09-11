// CSV 导出（交易明细 / 归因统计 / 每日快照）。
//
// 前后端共享：server.js 的 /api/export 与前端「本地数据模式」都调用这里，
// 保证两种模式下载到的 CSV 完全一致。
import { withDerived, dateKey } from './derive.js';
import { buildStats } from './stats.js';

export function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header, rows) {
  // 加 BOM 便于 Excel 正确识别中文
  return '\uFEFF' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}

/** 全部买入 / 卖出 / 分红流水，按日期升序 */
export function buildTradesCsv(holdings) {
  const header = ['代码', '名称', '地区', '类型', '操作', '日期', '价格', '数量', '手续费', '成本价', '盈亏', '收益率%'];
  const rows = [];
  for (const h of holdings) {
    const d = withDerived(h);
    for (const p of d.purchases) {
      rows.push([h.code, h.name, h.region, h.type, '买入', dateKey(p.buyTime), p.buyPrice, p.buyQuantity, p.fee || 0, '', '', '']);
    }
    for (const s of d.sells) {
      rows.push([h.code, h.name, h.region, h.type, '卖出', s.buyTime, s.buyPrice, s.buyQuantity, s.fee || 0, s.cost, s.profit, s.returnRate]);
    }
    for (const v of d.dividends) {
      rows.push([h.code, h.name, h.region, h.type, '分红', v.buyTime, '', '', v.fee || 0, '', v.profit, '']);
    }
  }
  rows.sort((a, b) => String(a[5]).localeCompare(String(b[5])));
  return toCsv(header, rows);
}

/** 收益归因统计（已清仓战绩 / 胜率 / 已实现收益） */
export function buildStatsCsv(holdings, rates) {
  const stats = buildStats(holdings, rates);
  const header = ['代码', '名称', '状态', '成本法', '买入成本(CNY)', '卖出金额(CNY)', '手续费', '分红', '已实现盈亏(CNY)', '已实现收益率%', '首次买入', '最后卖出', '持有天数'];
  const rows = stats.items.map((i) => [
    i.code, i.name, i.status, i.costMethod, i.buyCostCNY, i.sellAmountCNY,
    i.feesTotal, i.dividend, i.realizedProfitCNY, i.realizedReturnRate,
    i.firstBuy || '', i.lastSell || '', i.holdDays ?? '',
  ]);
  return toCsv(header, rows);
}

/** 每日快照 */
export function buildSnapshotsCsv(snapshots) {
  return toCsv(
    ['日期', '在仓品种', '总成本(CNY)', '总市值(CNY)', '持仓收益(CNY)', '未实现(CNY)', '累计已实现(CNY)', '今日收益(CNY)'],
    (snapshots || []).map((s) => [s.date, s.activeCount, s.cost, s.marketValue, s.holdingProfit, s.unrealizedProfit, s.realizedProfit, s.todayProfit])
  );
}

/**
 * 统一入口，与后端 /api/export 的 scope 参数保持一致。
 * @param {'trades'|'stats'|'snapshots'} scope
 */
export function buildCsv(scope, { holdings = [], snapshots = [], rates = { CNY: 1 } } = {}) {
  if (scope === 'stats') return buildStatsCsv(holdings, rates);
  if (scope === 'snapshots') return buildSnapshotsCsv(snapshots);
  return buildTradesCsv(holdings);
}

/** 触发浏览器下载一段文本（浏览器环境专用） */
export function downloadText(filename, text, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 下载 CSV（buildCsv 的输出带 BOM，下载后 Excel 可直接识别中文） */
export function downloadCsv(filename, text) {
  downloadText(filename, text, 'text/csv;charset=utf-8');
}
