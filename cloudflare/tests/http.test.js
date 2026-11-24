import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { Store } from '../src/store.js';
import { handleQueue } from '../src/queue.js';
import { ProviderError } from '../src/provider.js';
import { createTestD1 } from './helpers.js';
import { AihtRuntimeServices } from '../src/runtime-services.js';

const ORIGIN = 'https://studio.test';
const PASSWORD = 'LocalTest2026!';
const PROFILE = { name: '云端验收学生', phone: '19900000202', region: '测试地区', school: '测试学校', grade: '小学五年级' };
const ANSWERS = {
  competition_name: '可编辑创意练习', competition_theme: '人机共生', requirements: '通过画面说明技术如何帮助人。',
  task_understanding: '画出机器人帮助老人，并说明人与机器如何合作。', theme: '温暖的未来', reason: '希望老人得到更好的照顾。',
  message: '人与机器和谐相处', message_detail: '机器人扶着轮椅旁的老人', subject: '友善的机器人和老人', scene: '敬老院花园',
  action: '照顾轮椅上的老人', details: '远处也有机器人协助人类', ratio: '16:9', style: '动漫', style_reason: '亲切明亮',
  innovation_type: '新的故事', innovation: '未来敬老院中的互相陪伴', innovation_visible: '机器人的照护行动',
};

function createBucket() {
  const objects = new Map();
  return {
    objects,
    async put(key, body, options = {}) {
      const data = body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
      objects.set(key, { data, httpMetadata: options.httpMetadata || {} });
    },
    async get(key) {
      const value = objects.get(key);
      return value ? { ...value, body: new Response(value.data).body, size: value.data.byteLength,
        arrayBuffer: async () => value.data.buffer.slice(value.data.byteOffset, value.data.byteOffset + value.data.byteLength) } : null;
    },
    async delete(key) { objects.delete(key); },
  };
}

function environment(t) {
  const DB = createTestD1();
  t.after(() => DB.close());
  const sent = [];
  const env = {
    DB, sent, IMAGE_STORAGE: createBucket(), ADMIN_SETUP_TOKEN: 'test-bootstrap-token-only',
    CONFIG_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
    GENERATION_QUEUE: { async send(body) { sent.push(body); } },
    ASSETS: { async fetch() { return new Response('<h1>作品创作台</h1>', { headers: { 'Content-Type': 'text/html' } }); } },
  };
  const instances = new Map();
  env.RUNTIME_SERVICES = {
    idFromName: name => name,
    get(id) {
      if (!instances.has(id)) instances.set(id, new AihtRuntimeServices({}, env));
      return { fetch: request => instances.get(id).fetch(request) };
    },
  };
  return env;
}

async function call(env, path, { method = 'GET', body, cookie, origin = ORIGIN } = {}) {
  const headers = new Headers();
  if (cookie) headers.set('Cookie', cookie);
  if (body !== undefined) { headers.set('Content-Type', 'application/json'); headers.set('Origin', origin); }
  const response = await worker.fetch(new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil() {} });
  return { response, status: response.status, data: response.headers.get('Content-Type')?.includes('json') ? await response.json() : null };
}

const cookieOf = result => result.response.headers.get('Set-Cookie')?.split(';', 1)[0];
async function setup(env) {
  return call(env, '/api/setup', { method: 'POST', body: { name: '验收管理员', phone: '19900000201', password: PASSWORD, setup_token: env.ADMIN_SETUP_TOKEN } });
}
async function student(env, overrides = {}) {
  const store = new Store(env.DB);
  const admin = await store.first("SELECT id FROM users WHERE role = 'admin'");
  const [{ code }] = await store.createAuthorizationCodes(admin.id);
  return call(env, '/api/register', { method: 'POST', body: { ...PROFILE, password: PASSWORD, authorization_code: code, ...overrides } });
}
async function prepareGeneration(env) {
  const admin = await setup(env);
  assert.equal(admin.status, 200);
  const adminCookie = cookieOf(admin);
  const configured = await call(env, '/api/admin/settings', { method: 'PUT', cookie: adminCookie,
    body: { model: 'doubao-seedream-5-0-flash-260915', base_url: 'https://ark.cn-beijing.volces.com/api/v3', watermark: true, api_key: 'fake-test-api-key-123456789' } });
  assert.equal(configured.status, 200);
  const registered = await student(env);
  const cookie = cookieOf(registered);
  const created = await call(env, '/api/plans', { method: 'POST', cookie, body: { title: ANSWERS.theme, answers: ANSWERS } });
  assert.equal(created.status, 201);
  const planId = created.data.plan.id;
  const saved = await call(env, `/api/plans/${planId}`, { method: 'PUT', cookie, body: { title: ANSWERS.theme, answers: ANSWERS, step: 5, confirmed: true } });
  assert.equal(saved.status, 200);
  const requestKey = crypto.randomUUID();
  const generated = await call(env, '/api/generate', { method: 'POST', cookie, body: { plan_id: planId, request_key: requestKey } });
  assert.equal(generated.status, 202);
  return { adminCookie, cookie, user: registered.data.user, planId, job: generated.data.job, requestKey };
}

const testImage = { data: new Uint8Array([137, 80, 78, 71]), mime: 'image/png', width: 32, height: 32, usage: { generated_images: 1 }, upstream_request_id: 'test-request-only' };
function message(jobId) { return { body: { job_id: jobId }, ack() { this.acked = true; }, retry() { throw new Error('付费生成任务不得自动重试'); } }; }

test('管理员 API 公开无限算力并成功绘图不扣点，汇总只计算学生余额', async t => {
  const env = environment(t);
  const f = await prepareGeneration(env);
  const admin = (await call(env, '/api/me', { cookie: f.adminCookie })).data.user;
  assert.equal(admin.unlimited_credits, true);
  assert.equal(f.user.unlimited_credits, false);
  // 历史管理员可能保留数字余额，但不能并入学生算力统计。
  await env.DB.prepare('UPDATE users SET credits = 7 WHERE id = ?').bind(admin.id).run();
  const overview = await call(env, '/api/admin/overview', { cookie: f.adminCookie });
  assert.equal(overview.data.stats.remaining_credits, 10);
  const plan = (await call(env, '/api/plans', { method: 'POST', cookie: f.adminCookie, body: { title: ANSWERS.theme, answers: ANSWERS } })).data.plan;
  await call(env, `/api/plans/${plan.id}`, { method: 'PUT', cookie: f.adminCookie, body: { title: ANSWERS.theme, answers: ANSWERS, step: 5, confirmed: true } });
  const generated = await call(env, '/api/generate', { method: 'POST', cookie: f.adminCookie, body: { plan_id: plan.id, request_key: crypto.randomUUID() } });
  assert.equal(generated.status, 202);
  assert.equal(generated.data.job.unlimited_credits, true);
  assert.equal(generated.data.user.reserved_credits, 0);
  await handleQueue({ messages: [message(generated.data.job.id)] }, env, async () => testImage);
  const refreshed = await call(env, `/api/jobs/${generated.data.job.id}`, { cookie: f.adminCookie });
  assert.equal(refreshed.data.job.status, 'succeeded');
  assert.equal(refreshed.data.user.credits, 7);
  assert.equal(refreshed.data.user.unlimited_credits, true);
});

test('切换服务商必须重新填写密钥，拒绝时保留原有加密配置', async t => {
  const env = environment(t);
  const { adminCookie } = await prepareGeneration(env);
  const store = new Store(env.DB);
  const previous = await store.getSettings();
  const denied = await call(env, '/api/admin/settings', { method: 'PUT', cookie: adminCookie,
    body: { base_url: 'https://api.openai-hk.com', model: 'gpt-image-2', api_key: '', quality: 'low', watermark: true } });
  assert.equal(denied.status, 400);
  assert.deepEqual(await store.getSettings(), previous);
});

test('HK配置规范化保存且公开结果脱敏，旧排队任务不切换到新服务商', async t => {
  const env = environment(t);
  const f = await prepareGeneration(env);
  const saved = await call(env, '/api/admin/settings', { method: 'PUT', cookie: f.adminCookie,
    body: { base_url: 'https://api.openai-hk.com', model: 'gpt-image-2', api_key: 'hk-local-fake-secret-123456789', quality: 'low', watermark: true } });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.provider, 'openai-hk');
  assert.equal(saved.data.base_url, 'https://api.openai-hk.com/v1');
  assert.equal(saved.data.quality, 'low');
  assert.equal(JSON.stringify(saved.data).includes('hk-local-fake-secret'), false);
  let chargedCalls = 0;
  await handleQueue({ messages: [message(f.job.id)] }, env, async () => { chargedCalls += 1; return testImage; });
  const store = new Store(env.DB);
  assert.equal(chargedCalls, 0);
  assert.equal((await store.getJob(f.user.id, f.job.id)).status, 'failed');
  assert.equal((await store.getUser(f.user.id)).available_credits, 10);
  assert.equal((await store.listArtworks(f.user.id)).length, 0);

  const accepted = await call(env, '/api/generate', { method: 'POST', cookie: f.cookie,
    body: { plan_id: f.planId, request_key: crypto.randomUUID() } });
  assert.equal(accepted.status, 202);
  const internal = await store.getJobInternal(accepted.data.job.id);
  assert.equal(internal.options.base_url, 'https://api.openai-hk.com/v1');
  assert.match(internal.options.config_fingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(internal.options).includes('hk-local-fake-secret'), false);
  const generated = async config => { chargedCalls += 1; assert.equal(config.provider, 'openai-hk'); return testImage; };
  await handleQueue({ messages: [message(accepted.data.job.id), message(accepted.data.job.id)] }, env, generated);
  assert.equal(chargedCalls, 1);
  assert.equal((await store.getUser(f.user.id)).credits, 9);
});

test('同一服务商更换密钥或清晰度时，旧排队任务在调用模型前释放预留', async t => {
  const env = environment(t);
  const f = await prepareGeneration(env);
  await call(env, '/api/admin/settings', { method: 'PUT', cookie: f.adminCookie,
    body: { api_key: 'replacement-fake-secret-only', quality: 'high' } });
  let called = false;
  await handleQueue({ messages: [message(f.job.id)] }, env, async () => { called = true; return testImage; });
  assert.equal(called, false);
  const user = await new Store(env.DB).getUser(f.user.id);
  assert.equal(user.credits, 10);
  assert.equal(user.reserved_credits, 0);
});

test('云端首次初始化必须提供部署口令，不能由第一个访问者抢占管理员', async t => {
  const env = environment(t);
  const bootstrap = await call(env, '/api/bootstrap');
  assert.equal(bootstrap.data.setup_required, true);
  assert.equal(bootstrap.data.setup_token_required, true);
  const denied = await call(env, '/api/setup', { method: 'POST', body: { name: '错误初始化', phone: '19900000201', password: PASSWORD } });
  assert.equal(denied.status, 403);
  assert.equal(await new Store(env.DB).hasAdmin(), false);
  const admin = await setup(env);
  assert.equal(admin.status, 200);
  assert.equal(admin.data.user.role, 'admin');
  assert.match(admin.response.headers.get('Set-Cookie'), /HttpOnly/i);
  assert.match(admin.response.headers.get('Set-Cookie'), /Secure/i);
  assert.match(admin.response.headers.get('Set-Cookie'), /SameSite=Strict/i);
  assert.equal(JSON.stringify(admin.data).includes('password_hash'), false);
});

test('未配置初始化口令时关闭公开初始化入口', async t => {
  const env = environment(t);
  delete env.ADMIN_SETUP_TOKEN;
  const result = await setup(env);
  assert.equal(result.status, 503);
  assert.equal(await new Store(env.DB).hasAdmin(), false);
});

test('注册和重复登录只赠送一次10点，退出后会话失效', async t => {
  const env = environment(t);
  await setup(env);
  const first = await student(env);
  assert.equal(first.data.user.credits, 10);
  assert.equal(first.data.user.available_credits, 10);
  const cookie = cookieOf(first);
  assert.equal((await call(env, '/api/me', { cookie })).status, 200);
  const again = await call(env, '/api/login', { method: 'POST', body: { phone: PROFILE.phone, password: PASSWORD } });
  assert.equal(again.data.user.credits, 10);
  assert.equal((await new Store(env.DB).ledger(first.data.user.id)).filter(row => row.kind === 'grant').length, 1);
  await call(env, '/api/logout', { method: 'POST', cookie, body: {} });
  assert.equal((await call(env, '/api/me', { cookie })).status, 401);
});

test('跨站写请求和学生后台访问被拒绝', async t => {
  const env = environment(t);
  await setup(env);
  const registered = await student(env);
  const cookie = cookieOf(registered);
  assert.equal((await call(env, '/api/plans', { method: 'POST', cookie, origin: 'https://other.test', body: {} })).status, 403);
  assert.equal((await call(env, '/api/admin/settings', { cookie })).status, 403);
  assert.equal((await call(env, '/api/admin/overview', { cookie })).status, 403);
});

test('后台绘图密钥只加密保存且不回传明文', async t => {
  const env = environment(t);
  const { adminCookie } = await prepareGeneration(env);
  const stored = await new Store(env.DB).getSettings();
  assert.equal(JSON.stringify(stored).includes('fake-test-api-key'), false);
  const result = await call(env, '/api/admin/settings', { cookie: adminCookie });
  assert.equal(result.data.configured, true);
  assert.equal(JSON.stringify(result.data).includes('fake-test-api-key'), false);
  assert.match(result.data.key_hint, /6789$/);
});

test('方案和作品按账号隔离，未确认方案不能发起队列任务', async t => {
  const env = environment(t);
  await setup(env);
  const a = await student(env);
  const b = await student(env, { name: '第二位验收学生', phone: '19900000203' });
  const created = await call(env, '/api/plans', { method: 'POST', cookie: cookieOf(a), body: { title: ANSWERS.theme, answers: ANSWERS } });
  const id = created.data.plan.id;
  assert.equal((await call(env, `/api/plans/${id}`, { cookie: cookieOf(b) })).status, 404);
  assert.equal((await call(env, `/api/plans/${id}/preview`, { method: 'POST', cookie: cookieOf(a), body: {} })).status, 200);
  const rejected = await call(env, '/api/generate', { method: 'POST', cookie: cookieOf(a), body: { plan_id: id, request_key: crypto.randomUUID() } });
  assert.equal(rejected.status, 409);
  assert.equal(env.sent.length, 0);
});

test('队列成功持久保存图片并只消耗1点，重复投递不再调用模型', async t => {
  const env = environment(t);
  const { cookie, user, job, adminCookie } = await prepareGeneration(env);
  assert.equal((await call(env, '/api/me', { cookie })).data.user.reserved_credits, 1);
  let generated = 0;
  const first = message(job.id);
  const duplicate = message(job.id);
  const generator = async () => { generated += 1; return testImage; };
  await handleQueue({ messages: [first] }, env, generator);
  await handleQueue({ messages: [duplicate] }, env, generator);
  assert.equal(generated, 1);
  assert.equal(first.acked, true);
  const me = (await call(env, '/api/me', { cookie })).data.user;
  assert.deepEqual([me.credits, me.reserved_credits, me.available_credits], [9, 0, 9]);
  const works = (await call(env, '/api/artworks', { cookie })).data.artworks;
  assert.equal(works.length, 1);
  const image = await call(env, `/api/artworks/${works[0].id}/download`, { cookie });
  assert.equal(image.status, 200);
  assert.equal(image.response.headers.get('Content-Type'), 'image/png');
  assert.deepEqual(new Uint8Array(await image.response.arrayBuffer()), testImage.data);
  assert.match(image.response.headers.get('Cache-Control'), /private|no-store/);
  const other = await student(env, { name: '其他同学', phone: '19900000204' });
  assert.equal((await call(env, `/api/artworks/${works[0].id}/image`, { cookie: cookieOf(other) })).status, 404);
  assert.equal((await call(env, `/api/artworks/${works[0].id}/image`, { cookie: adminCookie })).status, 200);
  assert.equal((await new Store(env.DB).ledger(user.id)).filter(row => row.kind === 'consume').length, 1);
});

test('明确失败释放算力，不保存作品，不由队列自动再试', async t => {
  const env = environment(t);
  const { cookie, job } = await prepareGeneration(env);
  const entry = message(job.id);
  await handleQueue({ messages: [entry] }, env, async () => { throw new ProviderError('验收明确失败', false); });
  const user = (await call(env, '/api/me', { cookie })).data.user;
  assert.deepEqual([user.credits, user.reserved_credits, user.available_credits], [10, 0, 10]);
  assert.equal((await call(env, `/api/jobs/${job.id}`, { cookie })).data.job.status, 'failed');
  assert.equal(entry.acked, true);
  assert.equal(env.IMAGE_STORAGE.objects.size, 0);
});

test('未知结果冻结1点，人工核对只允许结算一次', async t => {
  const env = environment(t);
  const { adminCookie, cookie, job } = await prepareGeneration(env);
  await handleQueue({ messages: [message(job.id)] }, env, async () => { throw new ProviderError('验收结果未知', true, 'test-unknown-only'); });
  let user = (await call(env, '/api/me', { cookie })).data.user;
  assert.deepEqual([user.credits, user.reserved_credits], [10, 1]);
  const overview = await call(env, '/api/admin/overview', { cookie: adminCookie });
  assert.equal(overview.data.uncertain_jobs[0].upstream_request_id, 'test-unknown-only');
  const request = { method: 'POST', cookie: adminCookie, body: { consume: false, reason: '已核对测试服务没有成功出图' } };
  assert.equal((await call(env, `/api/admin/jobs/${job.id}/resolve`, request)).status, 200);
  assert.equal((await call(env, `/api/admin/jobs/${job.id}/resolve`, request)).status, 409);
  user = (await call(env, '/api/me', { cookie })).data.user;
  assert.deepEqual([user.credits, user.reserved_credits], [10, 0]);
});

test('相同请求号在改稿后仍找回原任务，不创建新的收费任务', async t => {
  const env = environment(t);
  const { cookie, user, planId, job, requestKey } = await prepareGeneration(env);
  const store = new Store(env.DB);
  const edited = { ...ANSWERS, message: '改稿后的表达' };
  await call(env, `/api/plans/${planId}`, { method: 'PUT', cookie, body: { title: ANSWERS.theme, answers: edited, step: 2, confirmed: false } });
  const recovered = await call(env, '/api/generate', { method: 'POST', cookie, body: { plan_id: planId, request_key: requestKey } });
  assert.equal(recovered.status, 202);
  assert.equal(recovered.data.job.id, job.id);
  assert.equal((await store.getUser(user.id)).reserved_credits, 1);
});

test('队列投递无法确认时保留算力，不把它当成明确失败返还', async t => {
  const env = environment(t);
  const prepared = await prepareGeneration(env);
  const store = new Store(env.DB);
  await store.failGeneration(prepared.job.id, '取消测试中的前一任务', false);
  env.GENERATION_QUEUE.send = async () => { throw new Error('测试网络断开'); };
  const result = await call(env, '/api/generate', { method: 'POST', cookie: prepared.cookie, body: { plan_id: prepared.planId, request_key: crypto.randomUUID() } });
  assert.ok(result.status === 202 || result.status === 503);
  const user = await store.getUser(prepared.user.id);
  assert.deepEqual([user.credits, user.reserved_credits], [10, 1]);
});

test('并发相同请求号只由创建者发送一次队列消息', async t => {
  const env = environment(t);
  const prepared = await prepareGeneration(env);
  const before = env.sent.length;
  const options = { method: 'POST', cookie: prepared.cookie, body: { plan_id: prepared.planId, request_key: crypto.randomUUID() } };
  const [a, b] = await Promise.all([call(env, '/api/generate', options), call(env, '/api/generate', options)]);
  assert.equal(a.status, 202);
  assert.equal(b.status, 202);
  assert.equal(a.data.job.id, b.data.job.id);
  assert.equal(env.sent.length, before + 1);
});

test('队列已领取后producer才报错，不冻结正在执行的任务', async t => {
  const env = environment(t);
  const prepared = await prepareGeneration(env);
  const store = new Store(env.DB);
  await store.failGeneration(prepared.job.id, '结束前置测试任务', false);
  env.GENERATION_QUEUE.send = async body => {
    assert.ok(await store.claimJob(body.job_id));
    throw new Error('测试投递响应丢失');
  };
  const result = await call(env, '/api/generate', { method: 'POST', cookie: prepared.cookie, body: { plan_id: prepared.planId, request_key: crypto.randomUUID() } });
  assert.equal(result.status, 202);
  assert.equal(result.data.job.status, 'running');
  const user = await store.getUser(prepared.user.id);
  assert.deepEqual([user.credits, user.reserved_credits], [10, 1]);
});

test('正式默认D1图片存储可经鉴权下载，无需R2绑定', async t => {
  const env = environment(t);
  delete env.IMAGE_STORAGE;
  const prepared = await prepareGeneration(env);
  await handleQueue({ messages: [message(prepared.job.id)] }, env, async () => testImage);
  const works = (await call(env, '/api/artworks', { cookie: prepared.cookie })).data.artworks;
  assert.equal(works.length, 1);
  const image = await call(env, `/api/artworks/${works[0].id}/image`, { cookie: prepared.cookie });
  assert.equal(image.status, 200);
  assert.deepEqual(new Uint8Array(await image.response.arrayBuffer()), testImage.data);
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM image_objects WHERE completed = 1').first('n'), 1);
  assert.equal((await new Store(env.DB).getUser(prepared.user.id)).credits, 9);
});
