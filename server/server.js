import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';
import { loadHoldings, saveHoldings } from './store.js';
import { sendCard } from './notifier.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Vite 打包产物目录（npm run build 生成）
const DIST = join(__dirname, '..', 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// 托管前端静态产物：先尝试精确文件路径，否则回退到 index.html（SPA 兜底）
async function serveStatic(res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = join(DIST, normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
  try {
    const st = await stat(filePath);
    if (st.isFile()) {
      const body = await readFile(filePath);
      res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
      return res.end(body);
    }
  } catch {
    // 文件不存在，回退到 index.html
  }
  const html = await readFile(join(DIST, 'index.html'));
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

// 派生展示字段（收益率/跌幅等，便于前端直接渲染）
function withDerived(h) {
  const avgCost = h.buyQuantity > 0 ? h.cost / h.buyQuantity : 0;
  const returnRate =
    h.currentPrice != null && avgCost > 0
      ? ((h.currentPrice - avgCost) / avgCost) * 100
      : null;
  const dropRate =
    h.currentPrice != null && h.lastBuyPrice > 0
      ? ((h.lastBuyPrice - h.currentPrice) / h.lastBuyPrice) * 100
      : null;
  return { ...h, avgCost, returnRate, dropRate };
}

function createHolding(b) {
  const today = new Date().toISOString().slice(0, 10);
  const required = ['name', 'code', 'region', 'type', 'cost', 'buyPrice', 'buyQuantity', 'targetProfitRate', 'refillDropRate', 'refillPrice'];
  for (const k of required) {
    if (b[k] === undefined || b[k] === '' || Number.isNaN(Number(b[k])) && k !== 'name' && k !== 'code' && k !== 'region' && k !== 'type')
      throw new Error(`缺少或非法字段: ${k}`);
  }
  return {
    id: 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: b.name,
    code: b.code,
    status: '持有',
    region: b.region,
    type: b.type,
    snapshotDate: b.snapshotDate || today,
    snapshotProfit: Number(b.snapshotProfit) || 0,
    snapshotReturnRate: Number(b.snapshotReturnRate) || 0,
    position: Number(b.position) || 0,
    profit: 0,
    cost: Number(b.cost),
    buyTime: b.buyTime || today,
    buyPrice: Number(b.buyPrice),
    buyQuantity: Number(b.buyQuantity),
    lastBuyPrice: Number(b.lastBuyPrice ?? b.buyPrice),
    targetProfitRate: Number(b.targetProfitRate),
    refillDropRate: Number(b.refillDropRate),
    refillPrice: Number(b.refillPrice),
    nextStrategy: b.nextStrategy || '',
    currentPrice: null,
    lastUpdated: null,
    triggerState: 'IDLE',
    notifiedAt: null,
  };
}

// 应用一笔买入/卖出交易，更新持仓数量、成本、最近买入价、状态
function applyTransaction(h, txn) {
  const qty = Number(txn.quantity);
  const price = Number(txn.price);
  if (!qty || !price) throw new Error('quantity / price 必须为正');
  if (txn.type === 'BUY') {
    h.cost = (h.cost || 0) + price * qty;
    h.buyQuantity = (h.buyQuantity || 0) + qty;
    h.lastBuyPrice = price;
    h.status = '持有';
    if (txn.date) h.buyTime = txn.date;
  } else if (txn.type === 'SELL') {
    const sold = Math.min(qty, h.buyQuantity || 0);
    h.cost = Math.max(0, (h.cost || 0) - price * sold);
    h.buyQuantity = Math.max(0, (h.buyQuantity || 0) - qty);
    if (h.buyQuantity <= 0) h.status = '已卖出';
  } else {
    throw new Error('type 必须为 BUY 或 SELL');
  }
  // 交易后重置触发态，下一轮重新评估
  h.triggerState = 'IDLE';
  h.notifiedAt = null;
  return h;
}

async function handleApi(req, res, url, cfg) {
  // 列表
  if (req.method === 'GET' && url.pathname === '/api/holdings') {
    const list = await loadHoldings();
    return sendJSON(res, 200, { data: list.map(withDerived) });
  }

  // 新建持仓（买入建仓）
  if (req.method === 'POST' && url.pathname === '/api/holdings') {
    const body = await readBody(req);
    let h;
    try {
      h = createHolding(body);
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
    const list = await loadHoldings();
    list.push(h);
    await saveHoldings(list);
    return sendJSON(res, 201, { data: withDerived(h) });
  }

  // 对已有持仓追加买入/卖出记录
  const m = url.pathname.match(/^\/api\/holdings\/([^/]+)\/transactions$/);
  if (req.method === 'POST' && m) {
    const list = await loadHoldings();
    const h = list.find((x) => x.id === m[1]);
    if (!h) return sendJSON(res, 404, { error: '持仓不存在' });
    const body = await readBody(req);
    try {
      applyTransaction(h, body);
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
    await saveHoldings(list);
    return sendJSON(res, 200, { data: withDerived(h) });
  }

  // 发送一条测试消息到飞书机器人
  if (req.method === 'POST' && url.pathname === '/api/test-feishu') {
    try {
      const data = await sendCard(cfg, {
        trigger: 'BUY',
        name: '测试品种',
        code: 'TEST',
        region: '港股',
        type: '股票',
        currentPrice: '—',
        advice: '这是一条来自「股票秘书」的测试消息，用于验证飞书机器人推送是否正常。',
        summary: '测试消息',
      });
      return sendJSON(res, 200, { ok: true, data });
    } catch (e) {
      return sendJSON(res, 502, { error: '飞书推送失败：' + e.message });
    }
  }

  return sendJSON(res, 404, { error: 'not found' });
}

export function startServer(cfg) {
  const port = cfg.server?.port ?? 3000;
  const host = cfg.server?.host ?? '127.0.0.1';

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname.startsWith('/api/')) {
        return await handleApi(req, res, url, cfg);
      }
      // 前端静态产物（GET 任意非 /api 路径）
      if (req.method === 'GET') {
        return await serveStatic(res, url);
      }
      res.writeHead(404);
      res.end('not found');
    } catch (e) {
      console.error('[server]', e.message);
      if (!res.headersSent) sendJSON(res, 500, { error: e.message });
    }
  });

  server.listen(port, host, () => {
    console.log(`前端页面已启动: http://${host}:${port}`);
  });
  return server;
}
