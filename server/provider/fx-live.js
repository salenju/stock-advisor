// 汇率自动更新：每日拉取一次 USD→CNY / USD→HKD，推导 HKD→CNY。
//
// 为什么需要：原先 USD_CNY=7.0、HKD_CNY=0.9 写死在配置里，长期下来港美股的
// 人民币折算收益会系统性偏差（人民币汇率年度波动几个百分点是常态）。
//
// 采用两个免 Key 的公开接口做互备，任一成功即写入缓存 data/fx-cache.json。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setLiveRates } from './fx.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = join(__dirname, '..', '..', 'data', 'fx-cache.json');

// 主源：ECB 参考汇率（frankfurter）
const SOURCE_A = 'https://api.frankfurter.app/latest?from=USD&to=CNY,HKD';
// 备源：open.er-api（免费、无需 Key）
const SOURCE_B = 'https://open.er-api.com/v6/latest/USD';

async function fetchJson(url, timeoutMs = 8000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`http ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// 返回 { USD, HKD }（均为兑人民币）；两个源都失败时抛错
export async function fetchLiveRates() {
  const errors = [];

  try {
    const j = await fetchJson(SOURCE_A);
    const usd = Number(j?.rates?.CNY);
    const hkd = Number(j?.rates?.HKD);
    if (usd > 0 && hkd > 0) return { USD: usd, HKD: usd / hkd };
    errors.push('frankfurter 返回字段异常');
  } catch (e) {
    errors.push(`frankfurter: ${e.message}`);
  }

  try {
    const j = await fetchJson(SOURCE_B);
    const usd = Number(j?.rates?.CNY);
    const hkd = Number(j?.rates?.HKD);
    if (usd > 0 && hkd > 0) return { USD: usd, HKD: usd / hkd };
    errors.push('open.er-api 返回字段异常');
  } catch (e) {
    errors.push(`open.er-api: ${e.message}`);
  }

  throw new Error('汇率源均不可用：' + errors.join(' | '));
}

// 启动时载入磁盘缓存（避免重启后立刻跑一次网络请求）
export async function loadFxCache() {
  try {
    const raw = await readFile(CACHE_FILE, 'utf-8');
    const j = JSON.parse(raw);
    setLiveRates(j.rates, j.fetchedAt ? Date.parse(j.fetchedAt) : Date.now());
    return j;
  } catch {
    return null;
  }
}

/**
 * 刷新汇率（供调度器调用，一天一次）。
 * @returns {{ok:boolean, rates?:Object, error?:string, updatedAt?:string}}
 */
export async function refreshLiveRates() {
  try {
    const rates = await fetchLiveRates();
    const fetchedAt = Date.now();
    const updatedAt = new Date(fetchedAt).toISOString();
    setLiveRates(rates, fetchedAt);
    await mkdir(dirname(CACHE_FILE), { recursive: true }).catch(() => {});
    await writeFile(
      CACHE_FILE,
      JSON.stringify({ rates, fetchedAt, updatedAt }, null, 2),
      'utf-8'
    ).catch(() => {});
    return { ok: true, rates, updatedAt };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
