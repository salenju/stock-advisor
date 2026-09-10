// 结构化日志：同时输出到控制台与按天滚动的日志文件（logs/app-YYYY-MM-DD.log）。
// 解决原先只有 console 的问题——进程重启后"为什么没提醒"无从追溯。
import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
let opts = { enabled: true, dir: join(__dirname, '..', 'logs'), keepDays: 14 };
let lastPruneDay = '';

export function configureLogger(cfg) {
  const l = cfg?.logging || {};
  opts = {
    enabled: l.enabled !== false,
    dir: join(__dirname, '..', l.dir || 'logs'),
    keepDays: Number(l.keepDays) > 0 ? Number(l.keepDays) : 14,
  };
}

function day(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function fmtArgs(args) {
  return args
    .map((a) => {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

async function prune() {
  const today = day();
  if (lastPruneDay === today) return;
  lastPruneDay = today;
  try {
    const files = (await readdir(opts.dir)).filter((f) => /^app-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort();
    const cutoff = new Date(Date.now() - opts.keepDays * 86400000).toISOString().slice(0, 10);
    for (const f of files) {
      if (f.slice(4, 14) < cutoff) await unlink(join(opts.dir, f)).catch(() => {});
    }
  } catch {
    // 首次运行目录不存在等，忽略
  }
}

function write(level, args) {
  const line = `${new Date().toISOString()} [${level}] ${fmtArgs(args)}`;
  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN') console.warn(line);
  else console.log(line);
  if (!opts.enabled) return;
  mkdir(opts.dir, { recursive: true })
    .then(() => appendFile(join(opts.dir, `app-${day()}.log`), line + '\n', 'utf-8'))
    .then(prune)
    .catch(() => {});
}

export const logger = {
  info: (...args) => write('INFO', args),
  warn: (...args) => write('WARN', args),
  error: (...args) => write('ERROR', args),
};

export function loggerInfo() {
  return { ...opts };
}
