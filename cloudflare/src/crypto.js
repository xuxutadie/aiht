import { scrypt, randomBytes, timingSafeEqual, createHash, webcrypto } from 'node:crypto';
import { DomainError } from './contracts.js';

const subtle = (globalThis.crypto || webcrypto).subtle;
const validPassword = value => typeof value === 'string' && [...value].length >= 8 && [...value].length <= 128 && !/[\uD800-\uDFFF]/u.test(value);

function derivePassword(password, salt) {
  return new Promise((resolve, reject) => scrypt(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }, (error, result) => error ? reject(error) : resolve(result)));
}

export async function hashPassword(password) {
  if (!validPassword(password)) throw new DomainError(400, 'invalid_password', '密码长度须为8至128个字符。');
  const salt = randomBytes(16);
  const digest = await derivePassword(password, salt);
  return `scrypt$16384$8$1$${salt.toString('hex')}$${digest.toString('hex')}`;
}

export async function verifyPassword(password, encoded) {
  if (!validPassword(password) || typeof encoded !== 'string' || encoded.length > 300) return false;
  const match = /^scrypt\$16384\$8\$1\$([a-fA-F0-9]{32})\$([a-fA-F0-9]{64})$/.exec(encoded);
  if (!match) return false;
  try {
    const digest = await derivePassword(password, Buffer.from(match[1], 'hex'));
    return timingSafeEqual(digest, Buffer.from(match[2], 'hex'));
  } catch { return false; }
}

export async function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

export function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // 长度本身不作为秘密；内容只交给运行时常时比较。
  return left.length === right.length && timingSafeEqual(left, right);
}

function decodeBase64(value, maximum) {
  if (typeof value !== 'string' || value.length > maximum || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('加密配置格式不正确。');
  const result = Buffer.from(value, 'base64');
  if (result.toString('base64') !== value) throw new Error('加密配置格式不正确。');
  return result;
}

async function importMasterKey(value) {
  const bytes = decodeBase64(value, 44);
  if (bytes.length !== 32) throw new Error('云端配置主密钥必须为32字节。');
  return subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(text, key) {
  if (typeof text !== 'string' || text.length > 4096) throw new Error('加密内容格式不正确。');
  const imported = await importMasterKey(key);
  const iv = randomBytes(12);
  const encrypted = await subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, imported, new TextEncoder().encode(text));
  return { version: 1, algorithm: 'AES-GCM', iv: iv.toString('base64'), ciphertext: Buffer.from(encrypted).toString('base64') };
}

export async function decryptSecret(payload, key) {
  if (!payload || payload.version !== 1 || payload.algorithm !== 'AES-GCM') throw new Error('加密配置版本不正确。');
  const iv = decodeBase64(payload.iv, 16);
  const ciphertext = decodeBase64(payload.ciphertext, 22000);
  if (iv.length !== 12 || ciphertext.length < 16) throw new Error('加密配置不完整。');
  const imported = await importMasterKey(key);
  const decrypted = await subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, imported, ciphertext);
  return new TextDecoder('utf-8', { fatal: true }).decode(decrypted);
}
