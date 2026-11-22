import { DomainError, textValue } from './contracts.js';
import { hashPassword, verifyPassword } from './crypto.js';
import { getImageStorage } from './image-storage.js';

const INTERNAL_ORIGIN = 'https://aiht-runtime.internal';
const MAX_CREDENTIAL_BYTES = 4096;
const unavailable = () => new DomainError(503, 'runtime_unavailable', '服务暂时不可用，请稍后再试或联系管理员。');
const json = (status, value) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

async function readSmallJson(message) {
  if ((message.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new DomainError(415, 'json_required', '请求必须使用JSON格式。');
  }
  const declared = message.headers.get('Content-Length');
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > MAX_CREDENTIAL_BYTES)) {
    throw new DomainError(413, 'body_too_large', '提交内容过多，请适当精简。');
  }
  const reader = message.body?.getReader();
  const chunks = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_CREDENTIAL_BYTES) {
          await reader.cancel();
          throw new DomainError(413, 'body_too_large', '提交内容过多，请适当精简。');
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes) || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new DomainError(400, 'invalid_json', '提交内容格式不正确。');
  }
}

// 通过私有DO绑定执行较重运算，公共HTTP入口不暴露这些路由。
// 不使用DO持久存储保存密码或图片；密码只在当前任务中使用，图片仍在D1。
export class AihtRuntimeServices {
  constructor(_state, env) {
    this.env = env;
    this.passwordTail = Promise.resolve();
  }

  runPassword(operation) {
    // 同一密码服务内串行派生，避免多个scrypt工作集同时占用隔离实例内存。
    const result = this.passwordTail.then(operation);
    this.passwordTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async fetch(request) {
    try {
      const url = new URL(request.url);
      if (request.method === 'POST' && ['/hash', '/verify'].includes(url.pathname)) {
        const body = await readSmallJson(request);
        const result = await this.runPassword(async () => url.pathname === '/hash'
          ? { encoded: await hashPassword(body.password) }
          : { valid: await verifyPassword(body.password, body.encoded) });
        return json(200, result);
      }
      if (request.method === 'GET' && url.pathname === '/image') {
        const key = textValue(url.searchParams.get('key'), '图片编号', 4096, false);
        const object = await getImageStorage(this.env).get(key);
        if (!object) throw new DomainError(404, 'image_missing', '图片文件暂不可用，请联系老师恢复。');
        const headers = new Headers({ 'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream', 'Cache-Control': 'private, no-store' });
        if (Number.isSafeInteger(object.size) && object.size >= 0) headers.set('Content-Length', String(object.size));
        // 直接转发分片流，不在DO或公共Worker里把完整图片读入内存。
        return new Response(object.body, { status: 200, headers });
      }
      throw new DomainError(404, 'not_found', '内部服务路径不存在。');
    } catch (error) {
      const safe = error instanceof DomainError ? error : unavailable();
      return json(safe.status, { error: { code: safe.code, message: safe.message } });
    }
  }
}

function service(env, name) {
  const namespace = env.RUNTIME_SERVICES;
  if (!namespace || typeof namespace.idFromName !== 'function' || typeof namespace.get !== 'function') throw unavailable();
  try { return namespace.get(namespace.idFromName(name)); }
  catch { throw unavailable(); }
}

async function internalFetch(env, name, path, init) {
  try { return await service(env, name).fetch(new Request(INTERNAL_ORIGIN + path, init)); }
  catch (error) {
    if (error instanceof DomainError) throw error;
    // 原始异常可能带请求凭据，只向公共HTTP层交付固定错误。
    throw unavailable();
  }
}

async function runtimeJson(response) {
  let data;
  try { data = await readSmallJson(response); }
  catch { throw unavailable(); }
  if (!response.ok) {
    if (data.error && typeof data.error.code === 'string' && typeof data.error.message === 'string') {
      throw new DomainError(response.status, data.error.code, data.error.message);
    }
    throw unavailable();
  }
  return data;
}

export async function hashInRuntime(env, password) {
  const response = await internalFetch(env, 'password-service', '/hash', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
  });
  const result = await runtimeJson(response);
  if (typeof result.encoded !== 'string' || !/^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{64}$/u.test(result.encoded)) throw unavailable();
  return result.encoded;
}

export async function verifyInRuntime(env, password, encoded) {
  const response = await internalFetch(env, 'password-service', '/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password, encoded }),
  });
  const result = await runtimeJson(response);
  if (typeof result.valid !== 'boolean') throw unavailable();
  return result.valid;
}

export async function getRuntimeImage(env, key) {
  key = textValue(key, '图片编号', 4096, false);
  const response = await internalFetch(env, `image-service:${key}`, `/image?key=${encodeURIComponent(key)}`, { method: 'GET' });
  if (!response.ok) { await runtimeJson(response); throw unavailable(); }
  const size = response.headers.get('Content-Length');
  return {
    body: response.body,
    size: size !== null && /^\d+$/u.test(size) && Number.isSafeInteger(Number(size)) ? Number(size) : undefined,
    httpMetadata: { contentType: response.headers.get('Content-Type') || 'application/octet-stream' },
  };
}
