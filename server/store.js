import { readFile, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(__dirname, '..', 'data', 'holdings.json');

// 内存缓存：调度器与 HTTP 接口共用同一份持仓，避免并发读写冲突
let cache = null;
// 缓存对应的文件修改时间（毫秒）。用于判断外部是否手动改过文件。
let cacheMtime = 0;
let writeChain = Promise.resolve();

// 取文件当前的 mtime（毫秒）；文件不存在时返回 0
async function getMtime() {
  try {
    const s = await stat(DATA_FILE);
    return s.mtimeMs;
  } catch {
    return 0;
  }
}

// 旧版持仓为扁平结构（单条买入）；迁移为「多次买入记录」模型。
// 迁移会在首次加载时写入磁盘，之后始终以 purchases 模型持久化。
function migrate(h) {
  if (Array.isArray(h.purchases)) return h;
  const p = {
    id: 'p' + (h.id || 'x') + '0',
    buyPrice: Number(h.buyPrice) || 0,
    buyQuantity: Number(h.buyQuantity) || 0,
    buyTime: h.buyTime || h.snapshotDate || new Date().toISOString().slice(0, 10),
    // 旧版仅有全局止盈(targetProfitRate)；止亏缺省 0（不触发止损）
    targetProfitRate: Number(h.targetProfitRate) || 0,
    stopLossRate: Number(h.stopLossRate) || 0,
  };
  return { ...h, purchases: [p] };
}

export async function loadHoldings() {
  const mtime = await getMtime();
  // 仅在「首次加载」或「文件被外部修改过」时重新读盘，否则复用内存缓存
  if (!cache || mtime > cacheMtime) {
    const raw = await readFile(DATA_FILE, 'utf-8');
    let list = JSON.parse(raw);
    let changed = false;
    list = list.map((h) => {
      if (!Array.isArray(h.purchases)) {
        changed = true;
        return migrate(h);
      }
      return h;
    });
    cache = list;
    cacheMtime = mtime;
    if (changed) await saveHoldings(list);
  }
  return cache;
}

// 串行写盘，防止调度器与接口同时写造成互相覆盖
export async function saveHoldings(holdings) {
  const data = holdings ?? cache;
  writeChain = writeChain
    .then(() => writeFile(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8'))
    // 写盘后同步 mtime，避免把「自己刚写的」误判成外部改动而重复重载
    .then(async () => { cacheMtime = await getMtime(); })
    .catch((e) => console.error('[store] save error', e.message));
  return writeChain;
}
