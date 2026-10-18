// 云同步载荷：把「完整备份包」包装成可以安全推到远程仓库的文件内容。
//
// 为什么要有这一层：
//   - GitHub 仓库是「外部存储」，一旦泄露（仓库被改成公开、token 泄露、CI 日志）
//     数据就等于公开了。因此这里提供**可选**的端到端加密：加密只发生在本机浏览器，
//     远程仓库里存的是密文，GitHub 自己也读不出来。
//   - 加密用一个独立的口令（passphrase），与 GitHub token 分离：
//     token 撤销即可断掉访问，口令泄露只影响这一份密文。
//
// 文件格式（JSON，带 kind 以便将来识别与升级）：
//   明文：{ kind:'stock-advisor-sync', version:1, encrypted:false, savedAt, payload:<bundle 对象的 JSON 字符串> }
//   密文：{ kind, version:1, encrypted:true, savedAt,
//           kdf:{ algo:'PBKDF2-SHA256', iterations, salt },
//           cipher:{ algo:'AES-GCM', iv, data } }
//
// 本文件刻意不依赖任何浏览器存储 / DOM / Vue，便于在 Node 里直接单测。

export const ENVELOPE_KIND = 'stock-advisor-sync';
export const PAYLOAD_VERSION = 1;
// PBKDF2 迭代次数：兼顾手机端（约 100~300ms）与暴力破解成本
export const KDF_ITERATIONS = 200000;
export const KDF_ALGO = 'PBKDF2-SHA256';
export const CIPHER_ALGO = 'AES-GCM';

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/** 字节数组 → base64（分块拼接，避免大文件触达参数上限） */
export function bytesToBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** base64 → 字节数组 */
export function base64ToBytes(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** 文本 → base64（UTF-8，用于 GitHub Contents API 的 content 字段） */
export function textToBase64(text) {
  return bytesToBase64(utf8Encoder.encode(String(text)));
}

/** base64 → 文本（UTF-8，解码 GitHub Contents API 的 content 字段） */
export function base64ToText(b64) {
  return utf8Decoder.decode(base64ToBytes(b64));
}

/** 是不是本模块写出的信封格式 */
export function isEnvelope(obj) {
  return !!obj && typeof obj === 'object' && obj.kind === ENVELOPE_KIND;
}

async function deriveKey(passphrase, salt, iterations) {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    utf8Encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * 把 bundle 包装成要上传的文本。
 * @param {Object} bundle localStore.exportBundle() 的结果
 * @param {string} [passphrase] 非空则 AES-GCM 加密；为空则明文（仍带信封头，便于识别）
 * @returns {Promise<string>} 可直接写入仓库文件的文本
 */
export async function wrapForUpload(bundle, passphrase) {
  const payload = JSON.stringify(bundle);
  const savedAt = new Date().toISOString();

  if (!passphrase) {
    return JSON.stringify(
      { kind: ENVELOPE_KIND, version: PAYLOAD_VERSION, encrypted: false, savedAt, payload },
      null,
      2
    );
  }

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, KDF_ITERATIONS);
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, utf8Encoder.encode(payload));

  return JSON.stringify(
    {
      kind: ENVELOPE_KIND,
      version: PAYLOAD_VERSION,
      encrypted: true,
      savedAt,
      kdf: { algo: KDF_ALGO, iterations: KDF_ITERATIONS, salt: bytesToBase64(salt) },
      cipher: {
        algo: CIPHER_ALGO,
        iv: bytesToBase64(iv),
        data: bytesToBase64(new Uint8Array(cipherBuf)),
      },
    },
    null,
    2
  );
}

/**
 * 解析远程文件内容。
 * 兼容三种情况：本模块的信封（明文/密文）、裸备份 JSON、裸 holdings 数组。
 * @param {string} text 远程文件原文
 * @param {string} [passphrase] 密文时必填
 * @returns {Promise<{bundle:Object, encrypted:boolean}>}
 */
export async function unwrapPayload(text, passphrase) {
  let obj;
  try {
    obj = JSON.parse(String(text ?? ''));
  } catch {
    throw new Error('远程文件不是合法 JSON（可能被手工改坏了）');
  }

  if (!isEnvelope(obj)) {
    // 兼容：用户可能直接把导出的备份文件放进了仓库
    return { bundle: obj, encrypted: false };
  }

  if (!obj.encrypted) {
    try {
      return { bundle: JSON.parse(obj.payload), encrypted: false };
    } catch {
      throw new Error('远程文件格式错误：payload 不是合法 JSON');
    }
  }

  if (!passphrase) throw new Error('这份云端数据已加密，请先填写加密口令');
  if (!obj.kdf?.salt || !obj.cipher?.iv || !obj.cipher?.data) {
    throw new Error('远程密文缺少 salt/iv/data，无法解密');
  }

  const iterations = Number(obj.kdf.iterations) || KDF_ITERATIONS;
  const key = await deriveKey(passphrase, base64ToBytes(obj.kdf.salt), iterations);
  let plainBuf;
  try {
    plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(obj.cipher.iv) },
      key,
      base64ToBytes(obj.cipher.data)
    );
  } catch {
    throw new Error('解密失败：加密口令不正确，或云端文件已损坏');
  }
  try {
    return { bundle: JSON.parse(utf8Decoder.decode(plainBuf)), encrypted: true };
  } catch {
    throw new Error('解密成功但内容不是合法 JSON');
  }
}

/** 本机 WebCrypto 是否可用于加密（部分环境只提供 getRandomValues） */
export function cryptoAvailable() {
  return typeof crypto !== 'undefined' && !!crypto.subtle && typeof crypto.getRandomValues === 'function';
}
