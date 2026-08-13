// 一键导入脚本：把 CSV 买入/卖出记录按「代码」匹配导入到 data/holdings.json
//
// 用法：
//   node server/import-csv.js                                   # 导入 data/买入-卖出记录 - Sheet1.csv
//   node server/import-csv.js <csv 路径>                        # 导入指定 CSV
//   node server/import-csv.js --create-missing                 # 匹配不到时自动新建持仓
//
// 匹配规则：
//   1. 精确匹配：CSV 代码 === holdings.code（如 07709、005827）
//   2. 数字归一化匹配：提取 holdings.code 中的数字与 CSV 代码比较（hk00700 → 700）
//
// 幂等：每条记录以 (code, 操作, 日期, 数量, 价格) 为唯一键，holdings 中已存在则忽略，否则插入。

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { importCsvText } from './import-csv-core.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const DATA_FILE = join(DATA_DIR, 'holdings.json');
const DEFAULT_CSV = join(DATA_DIR, '买入-卖出记录 - Sheet1.csv');

// 若默认路径不存在，自动在 data 目录里找一个非 holdings 的 .csv
function resolveCsvPath(explicit) {
  if (explicit) return explicit;
  if (existsSync(DEFAULT_CSV)) return DEFAULT_CSV;
  try {
    const csv = readdirSync(DATA_DIR).find(
      (f) => f.toLowerCase().endsWith('.csv') && !f.toLowerCase().includes('holdings')
    );
    if (csv) return join(DATA_DIR, csv);
  } catch { /* ignore */ }
  return DEFAULT_CSV;
}

function main() {
  const args = process.argv.slice(2);
  const createMissing = args.includes('--create-missing');
  const csvPath = resolveCsvPath(args.find((a) => !a.startsWith('--')));

  if (!existsSync(csvPath)) {
    console.error(`❌ CSV 不存在：${csvPath}`);
    process.exit(1);
  }

  const csvText = readFileSync(csvPath, 'utf-8');
  const holdings = JSON.parse(readFileSync(DATA_FILE, 'utf-8'));
  const result = importCsvText(holdings, csvText, { createMissing });

  // 写盘
  writeFileSync(DATA_FILE, JSON.stringify(holdings, null, 2), 'utf-8');

  // 汇总
  console.log('══════════════════════════════════════════');
  console.log(`CSV 记录总数：${result.total}`);
  console.log(`成功导入：${result.added} 条`);
  console.log(`重复跳过：${result.skipped} 条`);
  if (result.created > 0) {
    console.log(`自动新建持仓：${result.created} 只`);
    for (const h of result.createdCodes) {
      console.log(`  + 新建 ${h.name}（代码=${h.code}，地区=${h.region || '—'}，类型=${h.type || '—'}）`);
    }
  }
  if (result.missing.length) {
    console.log(`\n⚠️ 匹配不到持仓（${result.missing.length} 条）${createMissing ? '：' : '，可用 --create-missing 自动新建：'}`);
    for (const m of result.missing) {
      console.log(`  - [${m.oper}] ${m.name || m.code} 代码=${m.code} 日期=${m.date} 数量=${m.qty} 价格=${m.price}`);
    }
  }
  if (result.errors.length) {
    console.log(`\n❌ 导入出错（${result.errors.length} 条）：`);
    for (const e of result.errors) {
      console.log(`  - ${e.message}（记录：${e.rec.code} ${e.rec.date}）`);
    }
  }
  console.log('══════════════════════════════════════════');
  console.log(`已保存到：${DATA_FILE}`);
}

try {
  main();
} catch (e) {
  console.error('❌ 导入失败：', e.message);
  process.exit(1);
}
