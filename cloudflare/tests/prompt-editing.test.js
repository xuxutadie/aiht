import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeAnswers, missingFields, buildPrompt, buildPreview } from '../src/plans.js';
import worker from '../src/index.js';
import { Store } from '../src/store.js';
import { COOKIE_NAME } from '../src/contracts.js';
import { sha256, encryptSecret } from '../src/crypto.js';
import { handleQueue } from '../src/queue.js';
import { createTestD1, createAuthorizedTestUser } from './helpers.js';

const ORIGIN = 'https://studio.test';
const complete = () => ({
  task_understanding: '画出人与机器和谐相处', theme: '人机共生', reason: '希望老人得到照顾',
  message: '技术帮助更多人', message_detail: '机器人陪伴轮椅上的老人', subject: '机器人和老人',
  scene: '敬老院花园', action: '照顾轮椅上的老人', details: '周围也有机器人帮助人类',
  ratio: '16:9', style: '动漫', style_reason: '亲切清楚', innovation_type: '新的故事',
  innovation: '未来生活具象化', innovation_visible: '机器人具体的照顾行动',
});
const custom = '敬老院花园里，机器人蹲下为轮椅上的老人整理毯子；周围有其他机器人助人。温暖动漫画面，16:9。';
const codeIs = code => error => error.code === code;

async function fixture(t) {
  const DB = createTestD1();
  t.after(() => DB.close());
  const store = new Store(DB);
  const user = await createAuthorizedTestUser(store, { name: '取景验收学生', phone: '19900000401', region: '测试地区', school: '测试学校', grade: '小学五年级' }, 'test-password-hash');
  const token = '07'.repeat(32);
  await store.createSession(user.id, await sha256(token), Math.floor(Date.now() / 1000) + 3600);
  const sent = [];
  const env = { DB, CONFIG_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), GENERATION_QUEUE: { async send(message) { sent.push(message); } }, IMAGE_STORAGE: { async put() {} } };
  await store.saveSettings({ model: 'doubao-seedream-5-0-flash-260915', base_url: 'https://ark.cn-beijing.volces.com/api/v3', watermark: true,
    encrypted_key: await encryptSecret('prompt-edit-test-key-only', env.CONFIG_ENCRYPTION_KEY) });
  async function call(path, method = 'GET', body) {
    const headers = { Cookie: `${COOKIE_NAME}=${token}` };
    if (body !== undefined) Object.assign(headers, { Origin: ORIGIN, 'Content-Type': 'application/json' });
    const response = await worker.fetch(new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil() {} });
    return { status: response.status, data: await response.json() };
  }
  const plan = await store.createPlan(user.id, '人机共生', complete());
  const save = (answers, confirmed = false) => call(`/api/plans/${plan.id}`, 'PUT', { answers, confirmed, step: 4 });
  return { store, user, env, sent, call, plan, save };
}

test('旧草稿与自动取景保持原必填和原模板，新增选项可选择', () => {
  const original = complete();
  assert.deepEqual(missingFields(original), []);
  assert.equal(buildPrompt({ ...original, subject_framing: '自动', scene_distance: '自动' }), buildPrompt(original));
  for (const value of ['全身', '半身', '特写']) {
    assert.ok(buildPrompt({ ...original, subject_framing: value }).includes(value));
  }
  for (const value of ['远景', '中景', '近景']) {
    assert.ok(buildPrompt({ ...original, scene_distance: value }).includes(value));
  }
  for (const bad of [{ subject_framing: '其他' }, { scene_distance: '100米' }]) {
    assert.throws(() => sanitizeAnswers(bad), codeIs('invalid_choice'));
  }
});

test('手改提示词4000字边界有效，仍拒绝未完成框架与空白正文', () => {
  assert.equal(buildPrompt({ ...complete(), custom_prompt: '字'.repeat(4000) }).length, 4000);
  assert.throws(() => sanitizeAnswers({ custom_prompt: '字'.repeat(4001) }), codeIs('answer_too_long'));
  assert.equal(sanitizeAnswers({ custom_prompt: ' \n ' }).custom_prompt, '');
  assert.throws(() => buildPrompt({ ...complete(), custom_prompt: ' ' }), codeIs('empty_prompt'));
  assert.throws(() => buildPrompt({ ...complete(), message: '', custom_prompt: custom }), codeIs('incomplete_plan'));
  for (const bad of [123, '\u0000', '\ud800']) assert.throws(() => sanitizeAnswers({ custom_prompt: bad }));
});

test('自动模板过长不阻止合法手改，恢复前明确提示精简原答案', () => {
  const answers = { ...complete(), custom_prompt: custom };
  for (const field of ['theme', 'subject', 'scene', 'action', 'details', 'message', 'message_detail', 'innovation']) answers[field] = '字'.repeat(600);
  assert.equal(buildPrompt(answers), custom);
  const preview = buildPreview(answers);
  assert.equal(preview.prompt, custom);
  assert.equal(preview.template_prompt, '');
  assert.match(preview.template_error, /精简/);
  assert.deepEqual(preview.missing, []);
  delete answers.custom_prompt;
  assert.throws(() => buildPrompt(answers), codeIs('prompt_too_long'));
});

test('预览返回当前手改文本和独立模板；清空可存草稿但不能确认', async t => {
  const f = await fixture(t);
  const answers = { ...complete(), subject_framing: '半身', scene_distance: '近景', custom_prompt: custom };
  assert.equal((await f.save(answers)).status, 200);
  const preview = await f.call(`/api/plans/${f.plan.id}/preview`, 'POST', {});
  assert.equal(preview.status, 200);
  assert.equal(preview.data.prompt, custom);
  assert.equal(preview.data.prompt_mode, 'custom');
  assert.ok(preview.data.template_prompt.includes('半身'));
  assert.ok(preview.data.template_prompt.includes('近景'));
  assert.notEqual(preview.data.template_prompt, custom);
  assert.deepEqual(preview.data.missing, []);
  const blank = { ...answers, custom_prompt: ' \n ' };
  assert.equal((await f.save(blank)).status, 200);
  const emptyPreview = await f.call(`/api/plans/${f.plan.id}/preview`, 'POST', {});
  assert.equal(emptyPreview.status, 200);
  assert.equal(emptyPreview.data.prompt, '');
  assert.equal(emptyPreview.data.prompt_mode, 'custom');
  assert.ok(emptyPreview.data.template_prompt.includes('近景'));
  assert.ok(emptyPreview.data.missing.includes('手动改写提示词'));
  const confirmation = await f.save(blank, true);
  assert.equal(confirmation.status, 400);
  assert.equal(confirmation.data.error.code, 'empty_prompt');
  assert.equal((await f.store.getUser(f.user.id)).credits, 10);
});

test('移除手改字段恢复模板，缺项不能利用手改提示词确认', async t => {
  const f = await fixture(t);
  const incomplete = { ...complete(), subject: '', custom_prompt: custom };
  assert.equal((await f.save(incomplete)).status, 200);
  const preview = await f.call(`/api/plans/${f.plan.id}/preview`, 'POST', {});
  assert.equal(preview.data.prompt, '');
  assert.equal(preview.data.template_prompt, '');
  assert.ok(preview.data.missing.includes('画面主角'));
  assert.equal((await f.save(incomplete, true)).status, 400);
  assert.equal((await f.save(complete())).status, 200);
  const restored = await f.call(`/api/plans/${f.plan.id}/preview`, 'POST', {});
  assert.equal(restored.data.prompt_mode, 'template');
  assert.equal(restored.data.prompt, restored.data.template_prompt);
});

test('手改文本冻结进任务并传给模拟Provider，排队后修改与同号恢复均不重绘扣点', async t => {
  const f = await fixture(t);
  const answers = { ...complete(), subject_framing: '全身', scene_distance: '中景', custom_prompt: custom };
  const saved = await f.save(answers, true);
  assert.equal(saved.status, 200);
  assert.equal(saved.data.plan.confirmed, true);
  const requestKey = crypto.randomUUID();
  const submitted = await f.call('/api/generate', 'POST', { plan_id: f.plan.id, request_key: requestKey });
  assert.equal(submitted.status, 202);
  assert.equal(f.sent.length, 1);
  const frozen = await f.store.getJobInternal(submitted.data.job.id);
  assert.equal(frozen.prompt, custom);
  assert.equal(frozen.answers.custom_prompt, custom);
  const changed = await f.save({ ...answers, custom_prompt: '修改后的第二稿' }, true);
  assert.equal(changed.data.plan.confirmed, false);
  const recovered = await f.call('/api/generate', 'POST', { plan_id: f.plan.id, request_key: requestKey });
  assert.equal(recovered.data.job.id, submitted.data.job.id);
  assert.equal(f.sent.length, 1);
  const refused = await f.call('/api/generate', 'POST', { plan_id: f.plan.id, request_key: crypto.randomUUID() });
  assert.equal(refused.status, 409);
  const prompts = [];
  const generate = async (_config, prompt) => { prompts.push(prompt); return { data: new Uint8Array([137, 80, 78, 71]), mime: 'image/png', width: 1, height: 1, usage: { generated_images: 1 }, upstream_request_id: 'prompt-edit-test' }; };
  const message = () => ({ body: { job_id: submitted.data.job.id }, ack() {} });
  await handleQueue({ messages: [message(), message()] }, f.env, generate);
  assert.deepEqual(prompts, [custom]);
  assert.equal((await f.store.getJobInternal(submitted.data.job.id)).prompt, custom);
  const user = await f.store.getUser(f.user.id);
  assert.deepEqual([user.credits, user.reserved_credits], [9, 0]);
  const artworks = await f.store.listArtworks(f.user.id);
  assert.equal(artworks.length, 1);
  assert.equal(artworks[0].prompt, custom);
});
