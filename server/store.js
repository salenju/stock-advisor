import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(__dirname, '..', 'data', 'holdings.json');

// 内存缓存：调度器与 HTTP 接口共用同一份持仓，避免并发读写冲突
let cache = null;
let writeChain = Promise.resolve();

export async function loadHoldings() {
  if (!cache) {
    const raw = await readFile(DATA_FILE, 'utf-8');
    cache = JSON.parse(raw);
  }
  return cache;
}

// 串行写盘，防止调度器与接口同时写造成互相覆盖
export async function saveHoldings(holdings) {
  const data = holdings ?? cache;
  writeChain = writeChain
    .then(() => writeFile(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8'))
    .catch((e) => console.error('[store] save error', e.message));
  return writeChain;
}
