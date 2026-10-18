// 检查脚本用的最小静态服务器：把 dist/ 按 GitHub Pages 的方式托管。
// 纯静态项目没有后端，check 脚本只需要「把构建产物发出去」这一件事。
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.csv': 'text/csv; charset=utf-8',
};

/**
 * 托管一个目录（默认 dist/）。
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export async function serveDist(root = 'dist', { host = '127.0.0.1', port = 0 } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (path.endsWith('/')) path += 'index.html';
      // 去掉 ../ 之类的越界路径，只允许读取 root 下的文件
      const safe = normalize(path).replace(/^(\.\.[/\\])+/, '');
      const file = join(root, safe);
      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404');
    }
  });

  await new Promise((r) => server.listen(port, host, r));
  return {
    url: `http://${host}:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}
