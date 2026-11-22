import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptSecret } from '../src/crypto.js';
import { ProviderError } from '../src/provider.js';
import { processQueueMessage, sweepStaleJobs } from '../src/queue.js';

const jobId = '0123456789abcdef0123456789abcdef';
const image = { data: Uint8Array.from([1, 2, 3]), mime: 'image/png', width: 1, height: 1, usage: { generated_images: 1 }, upstream_request_id: 'queue-request-id' };

async function runtime() {
  const masterKey = Buffer.alloc(32, 9).toString('base64');
  const settings = { model: 'doubao-seedream-5-0-flash-260915', base_url: 'https://ark.cn-beijing.volces.com/api/v3', watermark: true, encrypted_key: await encryptSecret('integration-test-secret-only', masterKey) };
  const state = { status: 'queued', credits: 1, reserved: 1, generated: 0, saved: 0, completed: 0, acked: 0, traces: [], failures: [] };
  const store = {
    async claimJob() { if (state.status !== 'queued') return null; state.status = 'running'; return { id: jobId, user_id: 'test-user', prompt: '主题', options: { ratio: '1:1' }, answers: { theme: '主题' } }; },
    async getSettings() { return settings; },
    async recordProviderResult(id, requestId, usage) { state.traces.push({ id, requestId, usage }); },
    async completeGeneration(id, artifact) { assert.equal(state.saved, 1); state.completed += 1; state.status = 'succeeded'; state.credits -= 1; state.reserved -= 1; return artifact; },
    async failGeneration(id, message, uncertain) { state.failures.push({ id, message, uncertain }); if (state.status !== 'running') return; state.status = uncertain ? 'uncertain' : 'failed'; if (!uncertain) state.reserved -= 1; },
  };
  const env = { CONFIG_ENCRYPTION_KEY: masterKey, IMAGE_STORAGE: { async put(path, bytes, options) { assert.match(path, /^artworks\/test-user\/[a-f0-9]{32}\.png$/); assert.equal(options.httpMetadata.contentType, 'image/png'); assert.deepEqual(bytes, image.data); state.saved += 1; return { key: path }; } } };
  const message = () => ({ body: { job_id: jobId }, ack() { state.acked += 1; } });
  const generate = async () => { state.generated += 1; return image; };
  return { state, store, env, message, generate, settings };
}

test('成功保存D1图片后结算，重复投递只调用模型和扣点一次', async () => {
  const setup = await runtime();
  await Promise.all([processQueueMessage(setup.message(), setup.store, setup.env, setup.generate), processQueueMessage(setup.message(), setup.store, setup.env, setup.generate)]);
  assert.deepEqual([setup.state.generated, setup.state.saved, setup.state.completed, setup.state.credits, setup.state.reserved, setup.state.acked], [1, 1, 1, 0, 0, 2]);
  assert.equal(setup.state.traces[0].requestId, image.upstream_request_id);
});

test('重复消息不将其他仍在运行的任务抢改为待核对', async () => {
  const setup = await runtime(); setup.state.status = 'running';
  await processQueueMessage(setup.message(), setup.store, setup.env, setup.generate);
  assert.deepEqual([setup.state.generated, setup.state.status, setup.state.failures.length, setup.state.acked], [0, 'running', 0, 1]);
});

test('明确模型失败释放预留，不确定失败保留预留；都确认消息且不自动再请求', async () => {
  for (const uncertain of [false, true]) {
    const setup = await runtime();
    const generate = async () => { setup.state.generated += 1; throw new ProviderError('测试生成失败', uncertain, 'error-request-id'); };
    await processQueueMessage(setup.message(), setup.store, setup.env, generate);
    await processQueueMessage(setup.message(), setup.store, setup.env, generate);
    assert.deepEqual([setup.state.generated, setup.state.saved, setup.state.completed, setup.state.credits, setup.state.reserved, setup.state.acked], [1, 0, 0, 1, uncertain ? 1 : 0, 2]);
    assert.equal(setup.state.failures[0].uncertain, uncertain);
    assert.equal(setup.state.traces[0].requestId, 'error-request-id');
  }
});

test('D1图片写入或成功结算结果无法确认时冻结，绝不重发收费请求', async () => {
  for (const stage of ['r2', 'settlement']) {
    const setup = await runtime();
    if (stage === 'r2') setup.env.IMAGE_STORAGE.put = async () => { throw new Error('模拟写入中断'); };
    else setup.store.completeGeneration = async () => { throw new Error('模拟数据库响应丢失'); };
    await processQueueMessage(setup.message(), setup.store, setup.env, setup.generate);
    await processQueueMessage(setup.message(), setup.store, setup.env, setup.generate);
    assert.deepEqual([setup.state.generated, setup.state.credits, setup.state.reserved, setup.state.status, setup.state.acked], [1, 1, 1, 'uncertain', 2]);
  }
});

test('结算已经成功但响应丢失，也不能二次扣点或重新生图', async () => {
  const setup = await runtime();
  const complete = setup.store.completeGeneration;
  setup.store.completeGeneration = async (...args) => { await complete(...args); throw new Error('响应丢失'); };
  await processQueueMessage(setup.message(), setup.store, setup.env, setup.generate);
  await processQueueMessage(setup.message(), setup.store, setup.env, setup.generate);
  assert.deepEqual([setup.state.generated, setup.state.credits, setup.state.reserved, setup.state.status], [1, 0, 0, 'succeeded']);
});

test('配置不能解密时不调用模型且释放预留；非法消息直接确认', async () => {
  const setup = await runtime(); setup.env.CONFIG_ENCRYPTION_KEY = '';
  await processQueueMessage(setup.message(), setup.store, setup.env, setup.generate);
  assert.deepEqual([setup.state.generated, setup.state.status, setup.state.reserved, setup.state.acked], [0, 'failed', 0, 1]);
  await processQueueMessage({ body: { job_id: '../not-an-id' }, ack() { setup.state.acked += 1; } }, setup.store, setup.env, setup.generate);
  assert.equal(setup.state.acked, 2);
});

test('领取状态不确定时不抢改任务，后续由定时核对处理', async () => {
  const setup = await runtime(); setup.store.claimJob = async () => { throw new Error('数据库网络故障'); };
  await processQueueMessage(setup.message(), setup.store, setup.env, setup.generate);
  assert.deepEqual([setup.state.generated, setup.state.failures.length, setup.state.acked], [0, 0, 1]);
});

test('定时维护仅核对十分钟前的任务，并清理限流记录', async () => {
  const calls = [];
  const timestamp = Date.parse('2026-11-14T12:00:00.000Z');
  await sweepStaleJobs({ async markStaleJobsUncertain(cutoff) { calls.push(cutoff); }, async cleanupRateLimits() { calls.push('cleaned'); } }, timestamp);
  assert.deepEqual(calls, ['2026-11-14T11:50:00.000Z', 'cleaned']);
});

test('指纹损坏或旧任务遇到HK配置时，发送收费请求前释放预留', async () => {
  for (const mode of ['invalid-fingerprint', 'legacy-hk']) {
    const f = await runtime();
    if (mode === 'legacy-hk') {
      f.settings.base_url = 'https://api.openai-hk.com/v1';
      f.settings.model = 'gpt-image-2';
      f.settings.quality = 'low';
    } else {
      const claim = f.store.claimJob;
      f.store.claimJob = async (...args) => {
        const job = await claim(...args);
        if (job) job.options.config_fingerprint = '';
        return job;
      };
    }
    await processQueueMessage(f.message(), f.store, f.env, f.generate);
    assert.equal(f.state.generated, 0);
    assert.equal(f.state.status, 'failed');
    assert.equal(f.state.credits, 1);
    assert.equal(f.state.reserved, 0);
  }
});
