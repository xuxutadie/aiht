import test from 'node:test';
import assert from 'node:assert/strict';
import { AihtRuntimeServices, hashInRuntime, verifyInRuntime, getRuntimeImage } from '../src/runtime-services.js';
import worker from '../src/index.js';

const PASSWORD = 'RuntimeTest2026!';
function environment(extra = {}) {
  const instances = new Map();
  const calls = [];
  const env = { ...extra };
  env.RUNTIME_SERVICES = {
    idFromName(name) { return name; },
    get(id) {
      if (!instances.has(id)) instances.set(id, new AihtRuntimeServices({}, env));
      return { async fetch(request) { calls.push({ id, method: request.method, url: request.url }); return instances.get(id).fetch(request); } };
    },
  };
  return { env, instances, calls };
}

test('没有私有计算绑定时返回503，不能在HTTP里退回昂贵密码计算', async () => {
  for (const run of [() => hashInRuntime({}, PASSWORD), () => verifyInRuntime({}, PASSWORD, 'hash'), () => getRuntimeImage({}, 'artworks/a.png')]) {
    await assert.rejects(run, error => error.status === 503 && error.code === 'runtime_unavailable');
  }
});

test('内部Namespace完成密码摘要与校验，凭据始终放请求体而不进URL', async () => {
  const { env, calls } = environment();
  const encoded = await hashInRuntime(env, PASSWORD);
  assert.match(encoded, /^scrypt\$16384\$8\$1\$/u);
  assert.equal(await verifyInRuntime(env, PASSWORD, encoded), true);
  assert.equal(await verifyInRuntime(env, 'wrong-password', encoded), false);
  assert.equal(await verifyInRuntime(env, PASSWORD, 'invalid'), false);
  assert.equal(new Set(calls.map(call => call.id)).size, 1);
  assert.equal(calls.every(call => !call.url.includes(PASSWORD) && !call.url.includes(encoded)), true);
});

test('多个密码任务串行执行，失败不会堵住后续请求', async () => {
  const runtime = new AihtRuntimeServices({}, {});
  let active = 0, maximum = 0;
  const original = runtime.runPassword.bind(runtime);
  runtime.runPassword = operation => original(async () => {
    active += 1; maximum = Math.max(maximum, active);
    try { return await operation(); } finally { active -= 1; }
  });
  const send = password => runtime.fetch(new Request('https://aiht-runtime.internal/hash', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
  }));
  const responses = await Promise.all([send('bad'), send(PASSWORD), send(PASSWORD), send(PASSWORD)]);
  assert.equal(responses[0].status, 400);
  assert.equal(responses.slice(1).every(response => response.status === 200), true);
  assert.equal(maximum, 1);
});

test('内部凭据请求限制4KiB且拒绝非JSON，未知路由404', async () => {
  const runtime = new AihtRuntimeServices({}, {});
  const large = await runtime.fetch(new Request('https://aiht-runtime.internal/hash', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'x'.repeat(4200) }),
  }));
  assert.equal(large.status, 413);
  assert.equal((await runtime.fetch(new Request('https://aiht-runtime.internal/hash', { method: 'POST', body: '{}' }))).status, 415);
  assert.equal((await runtime.fetch(new Request('https://aiht-runtime.internal/hash'))).status, 404);
  assert.equal((await runtime.fetch(new Request('https://aiht-runtime.internal/private'))).status, 404);
});

test('图片以流经过私有DO转发，保留大小和MIME，缺失图片404', async () => {
  const pieces = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
  const requested = [];
  const { env, calls } = environment({ IMAGE_STORAGE: {
    async get(key) {
      requested.push(key);
      if (key === 'missing') return null;
      return { body: new ReadableStream({ start(controller) { for (const piece of pieces) controller.enqueue(piece); controller.close(); } }),
        size: 4, httpMetadata: { contentType: 'image/png' } };
    },
  } });
  const object = await getRuntimeImage(env, 'artworks/student/image.png');
  assert.equal(object.size, 4);
  assert.equal(object.httpMetadata.contentType, 'image/png');
  assert.ok(object.body instanceof ReadableStream);
  assert.deepEqual([...new Uint8Array(await new Response(object.body).arrayBuffer())], [1, 2, 3, 4]);
  assert.equal(calls[0].method, 'GET');
  assert.equal(requested[0], 'artworks/student/image.png');
  await assert.rejects(getRuntimeImage(env, 'missing'), error => error.status === 404 && error.code === 'image_missing');
});

test('内部服务传输失败只回安全503，不暴露原始异常', async () => {
  const secret = 'example-password-must-not-appear';
  const env = { RUNTIME_SERVICES: { idFromName: value => value, get: () => ({ fetch() { throw new Error(secret); } }) } };
  await assert.rejects(() => hashInRuntime(env, PASSWORD), error => error.status === 503 && !error.message.includes(secret));
});

test('公共HTTP路由不会把外部请求转发至私有计算接口', async () => {
  let privateCalls = 0;
  const env = {
    RUNTIME_SERVICES: { idFromName: name => name, get: () => ({ fetch() { privateCalls += 1; throw new Error('不应调用'); } }) },
    ASSETS: { fetch: async () => new Response('页面不存在', { status: 404 }) },
  };
  for (const path of ['/hash', '/verify']) {
    const response = await worker.fetch(new Request(`https://studio.test${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://studio.test' }, body: JSON.stringify({ password: PASSWORD }),
    }), env);
    assert.equal(response.status, 405);
  }
  const image = await worker.fetch(new Request('https://studio.test/image?key=artworks/student/image.png'), env);
  assert.equal(image.status, 404);
  assert.equal(privateCalls, 0);
});
