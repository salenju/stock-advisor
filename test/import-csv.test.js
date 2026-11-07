// CSV 导入回归单测：匹配规则 + 幂等性
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importCsvText, parseCsvText } from '../web/src/core/import-csv-core.js';
import { buildImportTemplateCsv, IMPORT_TEMPLATE_HEADER } from '../web/src/core/csv.js';

// 现网 CSV 表头格式
const CSV_HEADER = '序号,股票/基金名称,代码,地区,类型,操作,买入日期,买入数量,买入价';

function makeHolding(over = {}) {
  return {
    id: 'h' + Math.random().toString(36).slice(2, 8),
    name: '测试持仓',
    code: '1810',
    status: '持有',
    region: 'hk',
    type: '股票',
    purchases: [],
    sells: [],
    ...over,
  };
}

test('parseCsvText：支持 BOM/引号/空行', () => {
  const rows = parseCsvText('\uFEFF' + CSV_HEADER + '\n1,小米,1810,港股,,买入,2026/5/5,1400,30.7\n\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[1][1], '小米');
});

test('精确匹配：导入现有持仓的买卖记录', () => {
  const holdings = [makeHolding()];
  const csv = CSV_HEADER + '\n1,小米集团-W,1810,港股,,买入,2026/5/5,1400,30.7';
  const r = importCsvText(holdings, csv, {});
  assert.equal(r.added, 1);
  assert.equal(r.missing.length, 0);
  assert.equal(holdings[0].purchases.length, 1);
});

test('数字归一化匹配：CSV 补零代码也能匹配', () => {
  const holdings = [makeHolding({ code: '01810' })]; // 持仓是补零格式
  const csv = CSV_HEADER + '\n1,小米,1810,港股,,买入,2026/5/5,1400,30.7';
  const r = importCsvText(holdings, csv, {});
  assert.equal(r.added, 1);
});

test('幂等：重复导入同一 CSV 不产生重复明细', () => {
  const holdings = [makeHolding()];
  const csv = CSV_HEADER + '\n1,小米,1810,港股,,买入,2026/5/5,1400,30.7';
  const r1 = importCsvText(holdings, csv, {});
  const r2 = importCsvText(holdings, csv, {}); // 同一数组连续导入
  assert.equal(r1.added, 1);
  assert.equal(r2.added, 0);
  assert.equal(r2.skipped, 1);
  assert.equal(holdings[0].purchases.length, 1);
});

test('卖出超过持仓报错', () => {
  const holdings = [makeHolding()];
  const csv = CSV_HEADER + '\n1,小米,1810,港股,,卖出,2026/5/5,1000,30.7';
  const r = importCsvText(holdings, csv, {});
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].message, /超过持仓/);
});

test('createMissing：匹配不到时自动新建持仓（中文地区原样保留）', () => {
  const holdings = [];
  const csv = CSV_HEADER + '\n1,腾讯控股,00700,港股,股票,买入,2026/5/5,100,380.5';
  const r = importCsvText(holdings, csv, { createMissing: true });
  assert.equal(r.created, 1);
  assert.equal(holdings.length, 1);
  assert.equal(holdings[0].code, '00700');
  assert.equal(holdings[0].region, '港股');
  assert.equal(holdings[0].purchases.length, 1);
});

test('缺少必需列时抛错', () => {
  const holdings = [makeHolding()];
  assert.throws(() => importCsvText(holdings, '名称,代码\n1,2'), /缺少必需列/);
});

test('导入模板：表头被识别，示例行可完整导入（含分红金额 / 送转比例列）', () => {
  const holdings = [];
  const csv = buildImportTemplateCsv();
  assert.deepEqual(parseCsvText(csv)[0], IMPORT_TEMPLATE_HEADER);
  const r = importCsvText(holdings, csv, { createMissing: true });
  assert.equal(r.errors.length, 0);
  assert.equal(r.added, 5);
  assert.equal(r.created, 2);
  assert.equal(holdings[0].purchases.length, 1);
  assert.equal(holdings[0].sells.length, 1);
  assert.equal(holdings[0].dividends.length, 1);
  assert.equal(holdings[0].splits.length, 1);
});

test('同一代码：只追加明细，原有记录不被覆盖', () => {
  const holdings = [
    makeHolding({
      purchases: [{ id: 'p1', buyPrice: 10, buyQuantity: 100, buyTime: '2026-01-01', fee: 0 }],
    }),
  ];
  const csv = CSV_HEADER + '\n1,小米,1810,港股,,买入,2026/5/5,1400,30.7';
  const r = importCsvText(holdings, csv, {});
  assert.equal(r.added, 1);
  assert.equal(holdings[0].purchases.length, 2);
  assert.equal(holdings[0].purchases[0].buyTime, '2026-01-01');
});

test('不同代码：未勾选自动新建时原数据完全不变，只报 missing', () => {
  const holdings = [makeHolding()];
  const before = JSON.stringify(holdings);
  const csv = CSV_HEADER + '\n1,腾讯控股,00700,港股,股票,买入,2026/5/5,100,380.5';
  const r = importCsvText(holdings, csv, {});
  assert.equal(r.added, 0);
  assert.equal(r.missing.length, 1);
  assert.equal(holdings.length, 1);
  assert.equal(JSON.stringify(holdings), before);
});
