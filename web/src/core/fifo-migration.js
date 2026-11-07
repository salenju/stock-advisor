// 一次性数据迁移：把历史持仓统一成「券商口径」FIFO，并按 FIFO 重算历史卖出成本。
//
// 为什么必须连重算一起做：
//   项目早期默认 LIFO，历史卖出的 costPrice / profit 是按 LIFO 落盘的账本事实。
//   只把 costMethod 改成 FIFO，剩余批次的归属会变，但「卖出成本」还是旧值，
//   于是「剩余批次成本合计」与「持仓成本」、「逐笔买入收益」与「持仓浮动收益」都会对不上。
//
// 纯函数，不碰存储；由 store/localStore.js 的 loadHoldings() 在首次读取时调用一次。
import { recomputeSells } from './derive.js';

const sellSig = (sells) =>
  JSON.stringify((sells || []).map((s) => [s.costPrice, s.profit, s.returnRate]));

/**
 * 全部持仓 → FIFO + 按 FIFO 重算历史卖出成本。
 * 不修改入参（返回的对象是新引用）。
 *
 * @param {Array} list 持仓列表
 * @returns {{ list: Array, changed: boolean }}
 */
export function convertAllToFifo(list) {
  let anyChanged = false;

  const out = (list || []).map((h) => {
    // 深一点地复制需要被 recomputeSells 改写的部分（sells），避免污染入参
    const next = { ...h, costMethod: 'FIFO', sells: (h.sells || []).map((s) => ({ ...s })) };
    const methodChanged = h.costMethod !== 'FIFO';
    const before = sellSig(next.sells);

    recomputeSells(next); // 内部会重写 sells[].costPrice/profit/returnRate 并 syncFromPurchases

    const dataChanged = sellSig(next.sells) !== before;
    if (!methodChanged && !dataChanged) return h; // 已经是 FIFO 且账本一致 → 保持原对象

    anyChanged = true;
    return next;
  });

  return { list: out, changed: anyChanged };
}
