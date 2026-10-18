// GitHub Contents API 的最小客户端。
//
// 用途：把「一个文件」当成数据库读写。仓库可以是**私有**的，
// token 只留在本机浏览器里，因此数据不会出现在公开的地方。
//
// 只依赖 fetch，不依赖 DOM/存储层，方便单测（测试里 stub global fetch）。
//
// 用到的接口：
//   GET    /repos/{owner}/{repo}/contents/{path}?ref={branch}
//   PUT    /repos/{owner}/{repo}/contents/{path}
//   DELETE /repos/{owner}/{repo}/contents/{path}
// 参考：https://docs.github.com/en/rest/repos/contents

import { base64ToText, textToBase64 } from '../core/sync-payload.js';

const API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';

/** 配置缺字段时抛出可读错误 */
export function assertConfig(cfg) {
  const missing = [];
  if (!cfg?.owner) missing.push('用户名/组织');
  if (!cfg?.repo) missing.push('仓库名');
  if (!cfg?.token) missing.push('访问令牌');
  if (missing.length) throw new Error(`GitHub 配置不完整：缺少 ${missing.join('、')}`);
  return cfg;
}

/** 仓库文件路径规范化：去掉开头斜杠、折叠重复斜杠、禁止 .. 逃逸 */
export function normalizePath(p) {
  const raw = String(p ?? '').trim().replace(/\\/g, '/');
  const parts = raw.split('/').filter((s) => s && s !== '.');
  if (parts.some((s) => s === '..')) throw new Error('文件路径不能包含 ".."');
  const cleaned = parts.join('/');
  return cleaned || 'stock-advisor-data.json';
}

function friendlyError(status, body, res) {
  const msg = body?.message || '';
  if (status === 401) return '访问令牌无效或已过期，请重新生成（Fine-grained token 需勾选该仓库的 Contents: Read and write）';
  if (status === 403) {
    const remaining = res?.headers?.get?.('x-ratelimit-remaining');
    if (remaining === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
      const when = reset ? new Date(reset).toLocaleTimeString('zh-CN') : '稍后';
      return `GitHub API 触发了限流（每小时 5000 次），请等到 ${when} 再试`;
    }
    return `没有权限：请确认令牌具备该仓库的 Contents 读写权限${msg ? `（${msg}）` : ''}`;
  }
  if (status === 404) return '仓库或文件不存在：请检查用户名、仓库名、分支名和路径，私有仓库还需令牌有该仓库的访问权';
  if (status === 409) return '远程文件已被其他设备改动，需要先拉取合并';
  if (status === 422) return `请求被 GitHub 拒绝${msg ? `：${msg}` : ''}（常见原因是提交信息为空或 sha 不匹配）`;
  return `GitHub 返回 ${status}${msg ? `：${msg}` : ''}`;
}

async function ghFetch(cfg, path, init = {}) {
  assertConfig(cfg);
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${cfg.token}`,
      'X-GitHub-Api-Version': API_VERSION,
      ...(init.body ? { 'Content-Type': 'application/json' } : null),
      ...init.headers,
    },
  });

  let body = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!res.ok) {
    const err = new Error(friendlyError(res.status, body, res));
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

/**
 * 读取远程文件。
 * @returns {Promise<{sha:string, text:string, size:number, htmlUrl:string}|null>} 文件不存在返回 null
 */
export async function readFile(cfg, { path, branch } = {}) {
  const filePath = normalizePath(path ?? cfg?.path);
  const ref = branch || cfg?.branch || '';
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const apiPath = `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${encodeURI(filePath)}${query}`;

  let body;
  try {
    body = await ghFetch(cfg, apiPath, { method: 'GET' });
  } catch (err) {
    if (err.status === 404) return null;
    // 404 之外的错误也可能来自「仓库/分支不存在」，这里统一抛出更清晰的提示
    throw err;
  }

  if (Array.isArray(body)) throw new Error(`路径 ${filePath} 是一个目录，请指向具体文件`);
  if (body?.type && body.type !== 'file') throw new Error(`路径 ${filePath} 不是文件（${body.type}）`);

  let text = '';
  if (body?.encoding === 'base64' && typeof body.content === 'string') {
    text = base64ToText(body.content);
  } else if (typeof body?.content === 'string') {
    text = body.content;
  } else if (typeof body?.download_url === 'string') {
    // 超大文件（>1MB）GitHub 不返回 content，只能走 download_url
    const dl = await fetch(body.download_url, { headers: { Authorization: `Bearer ${cfg.token}` } });
    text = await dl.text();
  }

  return { sha: body.sha, text, size: body.size ?? text.length, htmlUrl: body.html_url };
}

/**
 * 写入（新建或更新）远程文件。必须带 sha 才能覆盖已有文件（GitHub 用它做乐观锁）。
 * @returns {Promise<{sha:string, commit:string}>}
 */
export async function writeFile(cfg, { path, branch, text, sha, message } = {}) {
  const filePath = normalizePath(path ?? cfg?.path);
  const apiPath = `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${encodeURI(filePath)}`;
  const body = {
    message: message || `update ${filePath} @ ${new Date().toISOString()}`,
    content: textToBase64(text),
  };
  if (sha) body.sha = sha;
  const ref = branch || cfg?.branch;
  if (ref) body.branch = ref;

  const res = await ghFetch(cfg, apiPath, { method: 'PUT', body: JSON.stringify(body) });
  return { sha: res?.content?.sha || '', commit: res?.commit?.sha || '' };
}

/** 删除远程文件（用于关闭云同步时清理） */
export async function deleteFile(cfg, { path, branch, sha, message } = {}) {
  const filePath = normalizePath(path ?? cfg?.path);
  if (!sha) throw new Error('删除文件需要已知的 sha，请先读取一次');
  const apiPath = `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${encodeURI(filePath)}`;
  const body = { message: message || `delete ${filePath}`, sha };
  const ref = branch || cfg?.branch;
  if (ref) body.branch = ref;
  return ghFetch(cfg, apiPath, { method: 'DELETE', body: JSON.stringify(body) });
}

/** 校验令牌有效性 + 是否能访问该仓库（配置页「测试连接」用） */
export async function testConnection(cfg) {
  assertConfig(cfg);
  const path = `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`;
  const repo = await ghFetch(cfg, path, { method: 'GET' });
  const file = await readFile(cfg, { path: cfg.path, branch: cfg.branch });
  return {
    repo: repo.full_name,
    private: !!repo.private,
    defaultBranch: repo.default_branch,
    canPush: !!repo.permissions?.push,
    fileExists: !!file,
    fileSize: file?.size ?? 0,
  };
}
