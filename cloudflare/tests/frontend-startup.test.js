import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import vm from 'node:vm';

const apiSource = readFileSync(new URL('../../public/api.js', import.meta.url), 'utf8');
const { api, post } = await import(`data:text/javascript;base64,${Buffer.from(apiSource).toString('base64')}`);

function browserNetwork(t, fetchResponse) {
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  const events = [];
  globalThis.fetch = fetchResponse;
  globalThis.window = { dispatchEvent(event) { events.push(event.type); } };
  t.after(() => { globalThis.fetch = previousFetch; globalThis.window = previousWindow; });
  return events;
}

// 测试自身设上限，避免旧实现的挂起 Promise 让回归检查也永久等待。
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('测试上限已到，请求没有及时退出')), 300);
    })]);
  } finally { clearTimeout(timer); }
}

test('启动请求即使 fetch 不响应取消，也会退出等待并取消网络请求', async t => {
  let signal;
  const events = browserNetwork(t, async (_path, options) => {
    signal = options.signal;
    return new Promise(() => {});
  });
  await assert.rejects(bounded(api('/api/bootstrap', { timeoutMs: 20 })), error => {
    assert.equal(error.code, 'REQUEST_TIMEOUT');
    assert.match(error.message, /连接较慢/);
    return true;
  });
  assert.equal(signal.aborted, true);
  assert.deepEqual(events, []);
});

test('响应头已到但 JSON 正文挂起时仍能超时退出', async t => {
  let signal;
  browserNetwork(t, async (_path, options) => {
    signal = options.signal;
    return { ok: true, status: 200, json: () => new Promise(() => {}) };
  });
  await assert.rejects(bounded(api('/api/bootstrap', { timeoutMs: 20 })), { code: 'REQUEST_TIMEOUT' });
  assert.equal(signal.aborted, true);
});

test('已经超时的 401 正文晚到时，不会误报会话失效', async t => {
  let completeBody;
  const body = new Promise(resolve => { completeBody = resolve; });
  const events = browserNetwork(t, async () => ({ ok: false, status: 401, json: () => body }));
  await assert.rejects(bounded(api('/api/bootstrap', { timeoutMs: 20 })), { code: 'REQUEST_TIMEOUT' });
  completeBody({ error: { message: '已过期', code: 'session_expired' } });
  await delay(0);
  assert.deepEqual(events, []);
});

test('调用方取消请求后，晚到的 401 不会误报会话失效', async t => {
  let completeBody;
  const body = new Promise(resolve => { completeBody = resolve; });
  const controller = new AbortController();
  const events = browserNetwork(t, async () => ({ ok: false, status: 401, json: () => body }));
  const pending = api('/api/bootstrap', { timeoutMs: 100, signal: controller.signal });
  controller.abort();
  completeBody({ error: { message: '已过期', code: 'session_expired' } });
  await assert.rejects(bounded(pending), { code: 'REQUEST_CANCELLED' });
  assert.deepEqual(events, []);
});

test('成功请求清理计时器，timeoutMs 不传给 fetch', async t => {
  let options;
  browserNetwork(t, async (_path, supplied) => {
    options = supplied;
    return new Response(JSON.stringify({ user: null, setup_required: false }));
  });
  assert.deepEqual(await api('/api/bootstrap', { timeoutMs: 20 }), { user: null, setup_required: false });
  assert.equal('timeoutMs' in options, false);
  await delay(35);
  assert.equal(options.signal.aborted, false);
});

test('网络错误保留清楚提示，不会误报会话失效', async t => {
  const events = browserNetwork(t, async () => { throw new TypeError('网络离线'); });
  await assert.rejects(api('/api/bootstrap', { timeoutMs: 20 }), { code: 'NETWORK_ERROR' });
  assert.deepEqual(events, []);
});

test('非 JSON 结果保留错误类型', async t => {
  browserNetwork(t, async () => new Response('<html>网关错误</html>'));
  await assert.rejects(api('/api/bootstrap', { timeoutMs: 20 }), { code: 'INVALID_RESPONSE', status: 200 });
});

test('真实 401 仍会通知会话失效', async t => {
  const events = browserNetwork(t, async () => new Response(JSON.stringify({ error: { message: '请重新登录', code: 'unauthorized' } }), { status: 401 }));
  await assert.rejects(api('/api/bootstrap', { timeoutMs: 20 }), { code: 'unauthorized', status: 401 });
  assert.deepEqual(events, ['session-expired']);
});

test('写请求保持单次发送，不擅自设置超时或重试', async t => {
  const calls = [];
  browserNetwork(t, async (path, options) => {
    calls.push({ path, options });
    await delay(30);
    return new Response(JSON.stringify({ job: { id: '仅供测试的任务' } }));
  });
  const result = await post('/api/generate', { request_key: '仅供测试的请求' });
  assert.equal(result.job.id, '仅供测试的任务');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.signal, undefined);
  assert.equal('timeoutMs' in calls[0].options, false);
});

test('初始连接失败后连续点击重新连接，只执行一次重连', async () => {
  const source = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '');
  const rendered = [];
  let calls = 0;
  let resolveRetry;
  const root = { replaceChildren(...nodes) { rendered.push(nodes); } };
  const context = vm.createContext({
    document: { querySelector: () => root, documentElement: { style: { setProperty() {} } } },
    window: { addEventListener() {} },
    createCreditReminder: () => ({ update() {}, reset() {} }),
    el: (tag, attrs, ...children) => ({ tag, attrs, children }),
    notice: text => ({ text }),
    button: (label, click) => ({ label, click, disabled: false }),
    authScreen: () => ({ kind: '登录界面' }),
    api: (_path, options) => {
      assert.equal(options?.timeoutMs, 15000);
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('连接较慢'));
      return new Promise(resolve => { resolveRetry = resolve; });
    },
  });
  vm.runInContext(source, context);
  await delay(0);
  const retry = rendered.at(-1)[0].children.at(-1);
  assert.equal(retry.label, '重新连接');
  const first = retry.click({ currentTarget: retry });
  const second = retry.click({ currentTarget: retry });
  assert.equal(calls, 2);
  assert.equal(retry.disabled, true);
  resolveRetry({ generation_configured: false, user: null, setup_required: false });
  await Promise.all([first, second]);
  assert.equal(rendered.at(-1)[0].kind, '登录界面');
});

test('旧启动请求超时后才返回成功结果，不覆盖已重连的登录页面', async t => {
  let completeOldBody;
  const oldBody = new Promise(resolve => { completeOldBody = resolve; });
  let requests = 0;
  browserNetwork(t, async () => {
    requests += 1;
    if (requests === 1) return { ok: true, status: 200, json: () => oldBody };
    return new Response(JSON.stringify({ generation_configured: false, user: null, setup_required: false }));
  });
  const rendered = [];
  const root = { replaceChildren(...nodes) { rendered.push(nodes); } };
  const source = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '');
  const context = vm.createContext({
    document: { querySelector: () => root, documentElement: { style: { setProperty() {} } } },
    window: { addEventListener() {} },
    createCreditReminder: () => ({ update() {}, reset() {} }),
    el: (tag, attrs, ...children) => ({ tag, attrs, children }),
    notice: text => ({ text }),
    button: (label, click) => ({ label, click, disabled: false }),
    authScreen: () => ({ kind: '登录界面' }),
    // 缩短等待时间，保留实际 API 封装和页面的完整重连流程。
    api: (path, options) => api(path, { ...options, timeoutMs: 20 }),
  });
  vm.runInContext(source, context);
  await delay(35);
  const retry = rendered.at(-1)[0].children.at(-1);
  await retry.click({ currentTarget: retry });
  assert.equal(rendered.at(-1)[0].kind, '登录界面');
  const completedRenders = rendered.length;
  completeOldBody({ generation_configured: true, user: { id: '旧请求用户' } });
  await delay(0);
  assert.equal(rendered.length, completedRenders);
  assert.equal(rendered.at(-1)[0].kind, '登录界面');
  assert.equal(requests, 2);
});
