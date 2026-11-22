import { BASE_URL_DEFAULT, MODEL_DEFAULT, DomainError } from './contracts.js';
import * as zlib from 'node:zlib';

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
// base64最多膨胀至原图的4/3，另留64KiB给单图JSON外壳与用量信息；图片本身仍限20MiB。
export const MAX_RESPONSE_BYTES = 4 * Math.ceil(MAX_IMAGE_BYTES / 3) + 64 * 1024;
const TIMEOUT_MS = 180000;
const RATIO_SIZES = { '1:1': '2048x2048', '4:3': '2368x1776', '3:4': '1776x2368', '16:9': '2816x1584', '9:16': '1584x2816' };
const HK_RATIO_SIZES = { '1:1': '1024x1024', '4:3': '1024x768', '3:4': '768x1024', '16:9': '1280x720', '9:16': '720x1280' };
const HK_BASE_URL = 'https://api.openai-hk.com/v1';
const DOWNLOAD_HOST = /^(?:[a-z0-9-]+\.)+tos(?:-s)?-cn-[a-z0-9-]+\.volces\.com$/;

export class ProviderError extends Error {
  constructor(message, uncertain = false, requestId = '') {
    super(message);
    this.uncertain = Boolean(uncertain);
    this.requestId = requestId;
  }
}

function validateKey(value) {
  if (typeof value !== 'string' || value.length < 16 || value.length > 512 || /[^\x21-\x7e]/.test(value)) throw new DomainError(400, 'invalid_settings', 'API 密钥格式不正确，请粘贴完整密钥（16 至 512 个可见字符）。');
  return value;
}

function normalizeBase(value) {
  if (typeof value === 'string' && !/[^\x21-\x7e]/.test(value)) {
    if (/^https:\/\/ark\.cn-beijing\.volces\.com(?:\/(?:api\/v3\/?)?)?$/.test(value)) return { provider: 'ark', base_url: BASE_URL_DEFAULT };
    if (/^https:\/\/api\.openai-hk\.com(?:\/(?:v1\/?)?)?$/.test(value)) return { provider: 'openai-hk', base_url: HK_BASE_URL };
  }
  throw new DomainError(400, 'invalid_settings', '接口地址必须使用火山方舟或 OpenAI-HK 的指定 HTTPS 地址。');
}

export function validateSettings(payload, current = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new DomainError(400, 'invalid_settings', '出图设置格式不正确。');
  const field = (name, fallback) => Object.hasOwn(payload, name) ? payload[name] : (Object.hasOwn(current, name) ? current[name] : fallback);
  const connection = normalizeBase(field('base_url', BASE_URL_DEFAULT));
  const model = field('model', connection.provider === 'openai-hk' ? 'gpt-image-2' : MODEL_DEFAULT);
  const watermark = field('watermark', true);
  const quality = field('quality', 'low');
  if (Object.hasOwn(payload, 'provider') && payload.provider !== connection.provider) throw new DomainError(400, 'invalid_settings', '服务商与接口地址不一致。');
  const validModel = connection.provider === 'openai-hk' ? model === 'gpt-image-2' : typeof model === 'string' && /^doubao-seedream-5-0-flash(?:-[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(model);
  if (typeof model !== 'string' || model.length > 128 || /[^\x21-\x7e]/.test(model) || !validModel) throw new DomainError(400, 'invalid_settings', connection.provider === 'openai-hk' ? 'OpenAI-HK 当前仅支持 gpt-image-2 图片模型。' : '火山方舟当前仅支持 Seedream 5.0 Flash 图片模型。');
  if (typeof watermark !== 'boolean') throw new DomainError(400, 'invalid_settings', '水印设置必须为开启或关闭。');
  if (!['low', 'medium', 'high'].includes(quality)) throw new DomainError(400, 'invalid_settings', '图片画质必须为 low、medium 或 high。');
  const newKey = Object.hasOwn(payload, 'api_key') ? payload.api_key : '';
  if (typeof newKey !== 'string') validateKey(newKey);
  // 服务商变化时必须由管理员重新填写，绝不自动将旧服务商密钥发给另一家。
  if (normalizeBase(current.base_url ?? BASE_URL_DEFAULT).provider !== connection.provider && !newKey) throw new DomainError(400, 'invalid_settings', '切换绘图服务商时，请重新填写该服务商的 API 密钥。');
  const apiKey = newKey ? validateKey(newKey) : (current.api_key || '');
  if (apiKey) validateKey(apiKey);
  return { model, base_url: connection.base_url, watermark, api_key: apiKey, provider: connection.provider, quality };
}

export function publicSettings(config = {}) {
  const key = typeof config.api_key === 'string' ? config.api_key : '';
  const connection = normalizeBase(config.base_url || BASE_URL_DEFAULT);
  return { configured: Boolean(key), model: config.model || (connection.provider === 'openai-hk' ? 'gpt-image-2' : MODEL_DEFAULT), base_url: connection.base_url, watermark: config.watermark ?? true, key_hint: key ? `••••${key.slice(-4)}` : '', provider: connection.provider, quality: config.quality || 'low' };
}

export async function configFingerprint(rawConfig) {
  const config = validateSettings({}, rawConfig);
  const serialized = JSON.stringify([config.base_url, config.model, Boolean(config.watermark), config.quality || 'low', config.api_key || '']);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
  return Buffer.from(digest).toString('hex');
}

export function validateDownloadUrl(value, provider = 'ark') {
  if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x20\\]/.test(value)) throw new Error('图片下载链接不合法。');
  const url = new URL(value);
  // 按实际服务商隔离下载白名单；不扩展到任意图片主机、字面IP、私网或本机。
  const allowedHost = provider === 'openai-hk' ? url.hostname === 'myfile.addmao.com' : provider === 'ark' && DOWNLOAD_HOST.test(url.hostname);
  if (url.protocol !== 'https:' || !allowedHost || url.username || url.password || (url.port && url.port !== '443') || url.hash) throw new Error('图片下载地址不在允许范围。');
  return url.href;
}

function dimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > 50000000) throw new Error('图片像素范围不合法。');
  return { width, height };
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

function crc32(bytes) {
  // 优先使用运行时的原生校验；兼容未提供 crc32 的模拟器，不为此添加依赖。
  if (typeof zlib.crc32 === 'function') {
    try { return zlib.crc32(bytes); } catch { /* 旧兼容运行时使用同一算法的查表实现。 */ }
  }
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ CRC_TABLE[(value ^ byte) & 0xff];
  return (value ^ 0xffffffff) >>> 0;
}

const ascii = bytes => String.fromCharCode(...bytes);

function inspectPng(bytes, view) {
  let position = 8;
  let sizeInfo = null;
  let hasData = false;
  while (position + 12 <= bytes.length) {
    const size = view.getUint32(position);
    const kind = ascii(bytes.subarray(position + 4, position + 8));
    const end = position + 12 + size;
    if (end > bytes.length) throw new Error('PNG 数据不完整。');
    const content = bytes.subarray(position + 8, position + 8 + size);
    if (crc32(bytes.subarray(position + 4, position + 8 + size)) !== view.getUint32(position + 8 + size)) throw new Error('PNG 校验错误。');
    if (!sizeInfo) {
      if (kind !== 'IHDR' || size !== 13) throw new Error('PNG 缺少尺寸信息。');
      sizeInfo = dimensions(view.getUint32(position + 8), view.getUint32(position + 12));
      const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[content[9]]?.includes(content[8]) || content[10] || content[11] || ![0, 1].includes(content[12])) throw new Error('PNG 头部不合法。');
    } else if (kind === 'IHDR') throw new Error('PNG 头部重复。');
    if (kind === 'IDAT' && size) hasData = true;
    if (kind === 'IEND') {
      if (size || !hasData || end !== bytes.length) throw new Error('PNG 数据不完整。');
      return sizeInfo;
    }
    position = end;
  }
  throw new Error('PNG 缺少结束标记。');
}

function inspectJpeg(bytes, view) {
  if (bytes.length < 4 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) throw new Error('JPEG 数据不完整。');
  let position = 2;
  let sizeInfo = null;
  const frameMarkers = [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf];
  while (position < bytes.length) {
    if (bytes[position] !== 0xff) throw new Error('JPEG 段结构不合法。');
    while (position < bytes.length && bytes[position] === 0xff) position += 1;
    if (position >= bytes.length) break;
    const marker = bytes[position++];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (position + 2 > bytes.length) break;
    const size = view.getUint16(position);
    if (size < 2 || position + size > bytes.length) throw new Error('JPEG 数据不完整。');
    if (frameMarkers.includes(marker)) {
      if (size < 8) throw new Error('JPEG 尺寸信息不完整。');
      sizeInfo = dimensions(view.getUint16(position + 5), view.getUint16(position + 3));
    }
    if (marker === 0xda) {
      if (!sizeInfo || size < 6) throw new Error('JPEG 缺少尺寸信息。');
      return sizeInfo;
    }
    position += size;
  }
  throw new Error('JPEG 缺少图像数据。');
}

function inspectWebp(bytes, view) {
  if (bytes.length < 26 || view.getUint32(4, true) + 8 !== bytes.length) throw new Error('WebP 数据不完整。');
  let position = 12;
  let canvas = null;
  let sizeInfo = null;
  while (position + 8 <= bytes.length) {
    const kind = ascii(bytes.subarray(position, position + 4));
    const size = view.getUint32(position + 4, true);
    const end = position + 8 + size;
    if (end + (size % 2) > bytes.length) throw new Error('WebP 数据不完整。');
    const offset = position + 8;
    if (kind === 'VP8X' && size === 10) {
      if (bytes[offset] & 2) throw new Error('不支持动画 WebP。');
      const width = bytes[offset + 4] + (bytes[offset + 5] << 8) + (bytes[offset + 6] << 16) + 1;
      const height = bytes[offset + 7] + (bytes[offset + 8] << 8) + (bytes[offset + 9] << 16) + 1;
      canvas = dimensions(width, height);
    } else if (kind === 'VP8 ' && size >= 10 && bytes[offset + 3] === 0x9d && bytes[offset + 4] === 1 && bytes[offset + 5] === 0x2a) {
      sizeInfo = dimensions(view.getUint16(offset + 6, true) & 0x3fff, view.getUint16(offset + 8, true) & 0x3fff);
    } else if (kind === 'VP8L' && size >= 5 && bytes[offset] === 0x2f) {
      const bits = view.getUint32(offset + 1, true);
      if (bits >>> 29) throw new Error('WebP 版本不受支持。');
      sizeInfo = dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    position = end + (size % 2);
  }
  if (!sizeInfo || position !== bytes.length || (canvas && (canvas.width !== sizeInfo.width || canvas.height !== sizeInfo.height))) throw new Error('WebP 缺少尺寸信息。');
  return sizeInfo;
}

export function inspectImage(data) {
  if (!(data instanceof Uint8Array) || !data.length || data.length > MAX_IMAGE_BYTES) throw new Error('图片为空或超过大小限制。');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length >= 8 && ascii(data.subarray(0, 8)) === '\x89PNG\r\n\x1a\n') return { mime: 'image/png', ...inspectPng(data, view) };
  if (data[0] === 0xff && data[1] === 0xd8) return { mime: 'image/jpeg', ...inspectJpeg(data, view) };
  if (data.length >= 12 && ascii(data.subarray(0, 4)) === 'RIFF' && ascii(data.subarray(8, 12)) === 'WEBP') return { mime: 'image/webp', ...inspectWebp(data, view) };
  throw new Error('未收到受支持的图片格式。');
}

function safeRequestId(headers, secret) {
  for (const header of ['X-Request-Id', 'X-Tt-Logid', 'X-Tt-Request-Id']) {
    const value = headers.get(header) || '';
    if (value.length >= 1 && value.length <= 160 && !/[^A-Za-z0-9_.:-]/.test(value) && (!secret || !value.includes(secret))) return value;
  }
  return '';
}

async function readLimited(response, maximum) {
  const length = response.headers.get('Content-Length');
  if (length && (!/^\d+$/.test(length) || Number(length) > maximum)) throw new Error('响应长度不合法或超过限制。');
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const parts = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) { await reader.cancel().catch(() => {}); throw new Error('响应超过限制。'); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
  return result;
}

function decodeImageBase64(encoded, allowDataUri = false) {
  let mime = '';
  if (typeof encoded === 'string' && encoded.startsWith('data:') && allowDataUri) {
    const prefix = /^data:(image\/(?:png|jpeg|webp));base64,/.exec(encoded);
    if (!prefix) throw new Error('图片编码前缀不合法。');
    mime = prefix[1];
    encoded = encoded.slice(prefix[0].length);
  }
  if (typeof encoded !== 'string' || encoded.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3) || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || /[^A-Za-z0-9+/=]/.test(encoded)) throw new Error('图片编码不合法或超过限制。');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  if ((encoded.endsWith('==') && alphabet.indexOf(encoded.at(-3)) % 16 !== 0) || (encoded.endsWith('=') && !encoded.endsWith('==') && alphabet.indexOf(encoded.at(-2)) % 4 !== 0)) throw new Error('图片编码不合法。');
  const bytes = Buffer.from(encoded, 'base64');
  return { data: bytes, mime };
}

export async function generateImage(rawConfig, prompt, options = {}) {
  let config;
  try { config = validateSettings({}, rawConfig); }
  catch { throw new ProviderError('出图配置无法使用，请联系管理员检查设置。'); }
  if (!config.api_key) throw new ProviderError('请先由管理员配置绘图 API 密钥。');
  if (typeof prompt !== 'string' || !prompt.trim() || [...prompt].length > 16000 || /[\uD800-\uDFFF]/u.test(prompt)) throw new ProviderError('创作提示词为空或过长，请检查创作方案。');
  if (!options || typeof options !== 'object' || Array.isArray(options) || !Object.hasOwn(RATIO_SIZES, options.ratio ?? '1:1')) throw new ProviderError('画面比例不受支持，请重新选择。');
  // 各服务商只发送其文档支持的字段，避免把方舟专属开关误传给HK。
  const payload = config.provider === 'openai-hk'
    ? { model: config.model, prompt, n: 1, size: HK_RATIO_SIZES[options.ratio ?? '1:1'], quality: config.quality, response_format: 'b64_json' }
    : { model: config.model, prompt, size: RATIO_SIZES[options.ratio ?? '1:1'], output_format: 'png', response_format: 'url', watermark: config.watermark, layer_decomposition: false };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let requestId = '';
  try {
    // 付费请求只发一次。重定向、异常或超时均不重新提交给绘图模型。
    const response = await fetch(`${config.base_url}/images/generations`, { method: 'POST', redirect: 'manual', signal: controller.signal, headers: { Authorization: `Bearer ${config.api_key}`, 'Content-Type': 'application/json', Accept: 'application/json, image/png, image/jpeg, image/webp' }, body: JSON.stringify(payload) });
    requestId = safeRequestId(response.headers, config.api_key);
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status >= 400 && response.status < 500) {
        const messages = { 401: '出图密钥无效，请联系管理员检查配置。', 403: '出图权限不足，请联系管理员检查模型权限。', 429: '出图服务当前繁忙或暂不可用，请联系老师。' };
        throw new ProviderError(messages[response.status] || '出图服务未接受本次请求，请检查方案或联系管理员。', false, requestId);
      }
      throw new ProviderError('出图服务暂时异常，本次生成状态待管理员核对。', true, requestId);
    }
    const isBinaryImage = (response.headers.get('Content-Type') || '').toLowerCase().startsWith('image/');
    const raw = await readLimited(response, isBinaryImage ? MAX_IMAGE_BYTES : MAX_RESPONSE_BYTES);
    let imageData;
    let declaredMime = '';
    let usage = {};
    if (isBinaryImage) imageData = raw;
    else {
      const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('响应格式不正确。');
      if (result.error) throw new ProviderError('出图服务未能生成本次图片，请检查方案或联系管理员。', false, requestId);
      if (!Array.isArray(result.data) || result.data.length !== 1 || !result.data[0] || typeof result.data[0] !== 'object' || Array.isArray(result.data[0])) throw new Error('单图响应结构不正确。');
      if (result.usage && typeof result.usage === 'object' && !Array.isArray(result.usage)) {
        for (const name of ['generated_images', 'input_images', 'input_tokens', 'output_tokens', 'total_tokens']) {
          const value = result.usage[name];
          if (Number.isSafeInteger(value) && value >= 0 && value <= 1e12) usage[name] = value;
        }
      }
      const entry = result.data[0];
      if (entry.b64_json) ({ data: imageData, mime: declaredMime } = decodeImageBase64(entry.b64_json, config.provider === 'openai-hk'));
      else if (entry.url) {
        const url = validateDownloadUrl(entry.url, config.provider);
        const downloaded = await fetch(url, { redirect: 'manual', signal: controller.signal, headers: { Accept: 'image/png, image/jpeg, image/webp' } });
        if (!downloaded.ok) throw new Error('图片下载未完成。');
        imageData = await readLimited(downloaded, MAX_IMAGE_BYTES);
      } else throw new Error('响应中没有图片。');
    }
    const imageInfo = inspectImage(imageData);
    if (declaredMime && declaredMime !== imageInfo.mime) throw new Error('图片编码声明与实际格式不一致。');
    return { data: imageData, ...imageInfo, usage, upstream_request_id: requestId };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('图片响应未能安全保存，本次生成状态待管理员核对。', true, requestId);
  } finally { clearTimeout(timer); }
}
