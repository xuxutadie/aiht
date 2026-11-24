import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { DomainError } from '../src/contracts.js';
import { createTestD1, createTestAdmin, createAuthorizedTestUser } from './helpers.js';

const profile = (suffix = '00') => ({ name: '验收同学', phone: `139000000${suffix}`, region: '测试地区', school: '测试学校', grade: '小学五年级' });
const answers = { theme: '人机共生', subject: 'AI帮助老人', scene: '敬老院' };
function fixture(t) {
  const db = createTestD1();
  t.after(() => db.close());
  return { db, store: new Store(db) };
}
async function account(store, suffix) { return createAuthorizedTestUser(store, profile(suffix)); }
async function confirmedPlan(store, user) {
  const plan = await store.createPlan(user.id, '人机共生', answers);
  return store.savePlan(user.id, plan.id, { title: plan.title, answers, step: 5, confirmed: true });
}
async function reserve(store, user, plan, key = crypto.randomUUID()) {
  return store.reserveGeneration(user.id, plan.id, key, '绘图提示词', { ratio: '16:9' }, plan.revision);
}
const artifact = () => ({ id: crypto.randomUUID(), image_path: `artworks/${crypto.randomUUID()}.png`, mime: 'image/png', width: 32, height: 32, description: '测试作品说明', reflection: '' });
const codeIs = code => error => error instanceof DomainError && error.code === code;

test('首次注册原子赠送10点，公开资料不含密码且手机号唯一', async t => {
  const { store } = fixture(t);
  const user = await account(store, '01');
  assert.equal(user.credits, 10);
  assert.equal(user.available_credits, 10);
  assert.equal(user.password_hash, undefined);
  assert.equal((await store.findUserByPhone(user.phone)).password_hash, 'test-password-hash');
  await assert.rejects(account(store, '01'), codeIs('phone_registered'));
  assert.equal((await store.ledger(user.id)).filter(entry => entry.kind === 'grant').length, 1);
});

test('管理员只能初始化一个；会话过期和删除后失效', async t => {
  const { store } = fixture(t);
  assert.equal(await store.hasAdmin(), false);
  const admin = await store.createUser(profile('02'), 'hash', 'admin');
  assert.equal(await store.hasAdmin(), true);
  await assert.rejects(store.createUser(profile('03'), 'hash', 'admin'), codeIs('setup_complete'));
  await store.createSession(admin.id, 'current-session-hash', Math.floor(Date.now() / 1000) + 60);
  await store.createSession(admin.id, 'expired-session-hash', 1);
  assert.equal((await store.getUserBySession('current-session-hash')).id, admin.id);
  assert.equal(await store.getUserBySession('expired-session-hash'), null);
  await store.deleteSession('current-session-hash');
  assert.equal(await store.getUserBySession('current-session-hash'), null);
});

test('管理员零余额也可以连续生成超过10张作品，成功和重复回调均不扣点', async t => {
  const { store } = fixture(t);
  const admin = await createTestAdmin(store);
  assert.equal(admin.unlimited_credits, true);
  assert.deepEqual([admin.credits, admin.reserved_credits, admin.available_credits], [0, 0, 0]);
  assert.equal((await store.ledger(admin.id))[0].delta, 0);
  const plan = await confirmedPlan(store, admin);
  for (let i = 0; i < 12; i += 1) {
    const key = `admin-free-${i}`;
    const job = await reserve(store, admin, plan, key);
    assert.equal(job.unlimited_credits, true);
    assert.equal((await reserve(store, admin, plan, key)).id, job.id);
    assert.equal((await store.getUser(admin.id)).reserved_credits, 0);
    const claimed = await store.claimJob(job.id);
    assert.equal(claimed.reservation_active, 1);
    assert.equal(claimed.unlimited_credits, true);
    const completed = await store.completeGeneration(job.id, artifact());
    assert.equal((await store.completeGeneration(job.id, artifact())).id, completed.id);
    assert.equal((await store.getJobInternal(job.id)).reservation_active, 0);
  }
  const current = await store.getUser(admin.id);
  assert.deepEqual([current.credits, current.reserved_credits], [0, 0]);
  assert.equal((await store.listArtworks(admin.id)).length, 12);
  const entries = await store.ledger(admin.id);
  assert.equal(entries.filter(entry => entry.kind === 'reserve' && entry.note === '管理员无限算力，无需预留点数').length, 12);
  assert.equal(entries.filter(entry => entry.kind === 'consume' && entry.delta === 0).length, 12);
});

test('管理员失败、冻结、过时恢复及人工核对保留任务状态而不动点数', async t => {
  const { db, store } = fixture(t);
  const admin = await createTestAdmin(store);
  const plan = await confirmedPlan(store, admin);
  const failed = await reserve(store, admin, plan);
  await store.failGeneration(failed.id, '明确失败', false);
  await store.failGeneration(failed.id, '迟到通知', false);
  const unknown = await reserve(store, admin, plan);
  await store.claimJob(unknown.id);
  await store.failGeneration(unknown.id, '上游结果未知', true);
  const stale = await reserve(store, admin, plan);
  await db.prepare('UPDATE jobs SET updated_at = ? WHERE id = ?').bind('2020-01-01T00:00:00.000Z', stale.id).run();
  await store.markStaleJobsUncertain(new Date(Date.now() - 600000).toISOString());
  assert.equal((await store.getJob(admin.id, failed.id)).status, 'failed');
  assert.equal((await store.getJobInternal(failed.id)).storage_reservation_bytes, 0);
  assert.equal((await store.getJobInternal(stale.id)).reservation_active, 1);
  assert.deepEqual((await store.listUncertainJobs()).map(job => job.unlimited_credits), [true, true]);
  for (const [job, consume] of [[unknown, true], [stale, false]]) {
    await store.resolveUncertainJob(job.id, consume, admin.id, '已核对');
    await assert.rejects(store.resolveUncertainJob(job.id, consume, admin.id, '重复核对'), codeIs('job_already_resolved'));
    assert.equal((await store.getJob(admin.id, job.id)).status, 'settled');
    assert.equal((await store.getJobInternal(job.id)).storage_reservation_bytes, 0);
  }
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM audit').first()).n, 2);
  assert.deepEqual([(await store.getUser(admin.id)).credits, (await store.getUser(admin.id)).reserved_credits], [0, 0]);
  assert.ok((await store.ledger(admin.id)).every(entry => entry.delta === 0 && entry.balance_after === 0));
});

test('旧管理员有限任务仍按旧规则结算，新增无限任务不会占用旧任务的预留', async t => {
  const { db, store } = fixture(t);
  const admin = await createTestAdmin(store);
  const plan = await confirmedPlan(store, admin);
  const legacy = await reserve(store, admin, plan);
  // 模拟部署前已经占掉最后一点的真实旧任务；历史流水不带无限标记。
  await db.prepare('UPDATE users SET credits = 1, reserved_credits = 1 WHERE id = ?').bind(admin.id).run();
  await db.prepare("UPDATE ledger SET note = '已预留1点算力，生成成功后扣除', balance_after = 1 WHERE job_id = ? AND kind = 'reserve'").bind(legacy.id).run();
  const fresh = await reserve(store, admin, plan);
  assert.equal(fresh.unlimited_credits, true);
  assert.equal((await store.getJob(admin.id, legacy.id)).unlimited_credits, false);
  await store.claimJob(fresh.id);
  await store.completeGeneration(fresh.id, artifact());
  assert.deepEqual([(await store.getUser(admin.id)).credits, (await store.getUser(admin.id)).reserved_credits], [1, 1]);
  await store.claimJob(legacy.id);
  await store.completeGeneration(legacy.id, artifact());
  assert.deepEqual([(await store.getUser(admin.id)).credits, (await store.getUser(admin.id)).reserved_credits], [0, 0]);
});

test('方案归属隔离；修改内容清除确认并递增revision', async t => {
  const { store } = fixture(t);
  const user = await account(store, '04');
  const other = await account(store, '05');
  const plan = await confirmedPlan(store, user);
  await assert.rejects(store.getPlan(other.id, plan.id), codeIs('not_found'));
  const changed = await store.savePlan(user.id, plan.id, { title: plan.title, answers: { ...answers, scene: '公园' }, step: 3, confirmed: true });
  assert.equal(changed.confirmed, false);
  assert.ok(changed.revision > plan.revision);
  const switched = await store.savePlan(user.id, plan.id, { title: changed.title, answers: changed.answers, step: 4, confirmed: false });
  assert.equal(switched.revision, changed.revision);
});

test('20个并发请求最多预留10点，真正耗尽与全额预留分别提示', async t => {
  const { store } = fixture(t);
  const user = await account(store, '06');
  const plan = await confirmedPlan(store, user);
  const attempts = await Promise.allSettled(Array.from({ length: 20 }, () => reserve(store, user, plan)));
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 10);
  assert.equal(attempts.filter(item => item.status === 'rejected' && item.reason.code === 'insufficient_credits').length, 10);
  const pending = await store.getUser(user.id);
  assert.deepEqual([pending.credits, pending.reserved_credits, pending.available_credits], [10, 10, 0]);
  await assert.rejects(reserve(store, user, plan), error => codeIs('insufficient_credits')(error) && error.message.includes('预留'));
  for (const item of attempts.filter(item => item.status === 'fulfilled')) {
    await store.claimJob(item.value.id);
    await store.completeGeneration(item.value.id, artifact());
  }
  await assert.rejects(reserve(store, user, plan), error => codeIs('insufficient_credits')(error) && error.message.includes('请联系管理员进行补充算力'));
});

test('同一请求号并发只预留一次；修改方案后仍能找回原任务', async t => {
  const { store } = fixture(t);
  const user = await account(store, '07');
  const plan = await confirmedPlan(store, user);
  const jobs = await Promise.all(Array.from({ length: 12 }, () => reserve(store, user, plan, 'same-request')));
  assert.equal(new Set(jobs.map(job => job.id)).size, 1);
  assert.equal(jobs.filter(job => job.newly_created).length, 1);
  assert.equal(jobs.filter(job => !job.newly_created).length, 11);
  assert.equal(JSON.stringify(jobs).includes('newly_created'), false);
  assert.equal((await store.getUser(user.id)).reserved_credits, 1);
  await store.savePlan(user.id, plan.id, { title: '已修改的主题', answers: { theme: '另一个想法' }, step: 1, confirmed: false });
  const recovered = await reserve(store, user, plan, 'same-request');
  assert.equal(recovered.id, jobs[0].id);
  assert.equal(recovered.newly_created, false);
  const second = await confirmedPlan(store, user);
  await assert.rejects(reserve(store, user, second, 'same-request'), codeIs('request_conflict'));
});

test('预占原子检查revision，旧方案不会创建任务或占用点数', async t => {
  const { store } = fixture(t);
  const user = await account(store, '08');
  const plan = await confirmedPlan(store, user);
  const changed = await store.savePlan(user.id, plan.id, { title: plan.title, answers: { ...answers, scene: '公园' }, step: 4, confirmed: false });
  await assert.rejects(reserve(store, user, plan), error => ['plan_changed', 'plan_unconfirmed'].includes(error.code));
  assert.equal((await store.getUser(user.id)).reserved_credits, 0);
  assert.ok(changed.revision > plan.revision);
  assert.equal((await store.ledger(user.id)).length, 1);
});

test('Queue领取只有一次；成功回调并发只产生一张作品并扣1点', async t => {
  const { store } = fixture(t);
  const user = await account(store, '09');
  const plan = await confirmedPlan(store, user);
  const job = await reserve(store, user, plan);
  const claims = await Promise.all(Array.from({ length: 8 }, () => store.claimJob(job.id)));
  assert.equal(claims.filter(Boolean).length, 1);
  const claimed = claims.find(Boolean);
  assert.equal(claimed.prompt, '绘图提示词');
  assert.deepEqual(claimed.options, { ratio: '16:9' });
  assert.deepEqual(claimed.answers, answers);
  const results = await Promise.all(Array.from({ length: 5 }, () => store.completeGeneration(job.id, artifact())));
  assert.equal(new Set(results.map(item => item.id)).size, 1);
  const current = await store.getUser(user.id);
  assert.deepEqual([current.credits, current.reserved_credits], [9, 0]);
  assert.equal((await store.listArtworks(user.id)).length, 1);
  assert.equal((await store.ledger(user.id)).filter(entry => entry.kind === 'consume').length, 1);
  assert.equal(await store.claimJob(job.id), null);
});

test('明确失败释放预留；重复与迟到失败回调不影响已结算余额', async t => {
  const { store } = fixture(t);
  const user = await account(store, '10');
  const plan = await confirmedPlan(store, user);
  const job = await reserve(store, user, plan);
  await Promise.all(Array.from({ length: 5 }, () => store.failGeneration(job.id, '请求未被接受', false)));
  assert.deepEqual([(await store.getUser(user.id)).credits, (await store.getUser(user.id)).reserved_credits], [10, 0]);
  assert.equal((await store.ledger(user.id)).filter(entry => entry.kind === 'release').length, 1);
  assert.equal(await store.completeGeneration(job.id, artifact()), null);
  assert.equal((await store.listArtworks(user.id)).length, 0);
});

test('未知结果冻结1点；管理员结算受权限保护且仅扣一次', async t => {
  const { store } = fixture(t);
  const user = await account(store, '11');
  const admin = await createTestAdmin(store);
  const plan = await confirmedPlan(store, user);
  const job = await reserve(store, user, plan);
  await store.failGeneration(job.id, '上游超时', true);
  await store.failGeneration(job.id, '迟到的明确失败', false);
  assert.equal((await store.getUser(user.id)).reserved_credits, 1);
  assert.equal((await store.listUncertainJobs()).length, 1);
  await assert.rejects(store.resolveUncertainJob(job.id, true, user.id, '测试核对结果'), codeIs('admin_required'));
  const attempts = await Promise.allSettled(Array.from({ length: 4 }, () => store.resolveUncertainJob(job.id, true, admin.id, '已核对成功出图')));
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
  const current = await store.getUser(user.id);
  assert.deepEqual([current.credits, current.reserved_credits], [9, 0]);
  assert.equal((await store.getJob(user.id, job.id)).status, 'settled');
  assert.equal((await store.ledger(user.id)).filter(entry => entry.kind === 'manual_consume').length, 1);
});

test('仅过时任务转未知，保留预留，不影响新任务或重复记录', async t => {
  const { db, store } = fixture(t);
  const user = await account(store, '13');
  const plan = await confirmedPlan(store, user);
  const old = await reserve(store, user, plan);
  await store.claimJob(old.id);
  const fresh = await reserve(store, user, plan);
  await db.prepare('UPDATE jobs SET updated_at = ? WHERE id = ?').bind('2020-01-01T00:00:00.000Z', old.id).run();
  await store.markStaleJobsUncertain(new Date(Date.now() - 600000).toISOString());
  await store.markStaleJobsUncertain(new Date(Date.now() - 600000).toISOString());
  assert.equal((await store.getJob(user.id, old.id)).status, 'uncertain');
  assert.equal((await store.getJob(user.id, fresh.id)).status, 'queued');
  assert.equal((await store.getUser(user.id)).reserved_credits, 2);
  assert.equal((await store.ledger(user.id)).filter(entry => entry.kind === 'freeze').length, 1);
});

test('作品和上游追踪归属隔离，私有用量不进入公开Job', async t => {
  const { store } = fixture(t);
  const user = await account(store, '14');
  const other = await account(store, '15');
  const plan = await confirmedPlan(store, user);
  const job = await reserve(store, user, plan);
  await store.claimJob(job.id);
  await store.recordProviderResult(job.id, 'request-123', { output_tokens: 10, secret: '不要保存' });
  const work = await store.completeGeneration(job.id, artifact());
  await assert.rejects(store.getArtwork(other.id, work.id), codeIs('not_found'));
  await assert.rejects(store.updateArtwork(other.id, work.id, '', '越权写入'), codeIs('not_found'));
  const saved = await store.updateArtwork(user.id, work.id, '观察结果', '我的作品说明');
  assert.equal(saved.reflection, '观察结果');
  assert.equal((await store.getJob(user.id, job.id)).usage, undefined);
  assert.equal((await store.getJob(user.id, job.id)).upstream_request_id, 'request-123');
  assert.deepEqual((await store.getJobInternal(job.id)).usage, { output_tokens: 10 });
});

test('限流按原子窗口累计，设置只接受加密结构持久保存', async t => {
  const { store } = fixture(t);
  assert.equal(await store.getSettings(), null);
  const encrypted = { model: 'model', base_url: 'https://example.com', watermark: true, encrypted_key: { iv: 'iv', ciphertext: 'encrypted' } };
  await store.saveSettings(encrypted);
  assert.deepEqual(await store.getSettings(), encrypted);
  await store.checkRateLimit('hashed-ip:test', 2, 60);
  await store.checkRateLimit('hashed-ip:test', 2, 60);
  await assert.rejects(store.checkRateLimit('hashed-ip:test', 2, 60), codeIs('rate_limited'));
  await store.cleanupRateLimits();
});

test('结算中的SQL约束失败整体回滚，不丢失预留或重复扣点', async t => {
  const { store } = fixture(t);
  const user = await account(store, '16');
  const plan = await confirmedPlan(store, user);
  const first = await reserve(store, user, plan);
  const second = await reserve(store, user, plan);
  await store.claimJob(first.id);
  await store.claimJob(second.id);
  const sameArtifact = artifact();
  await store.completeGeneration(first.id, sameArtifact);
  const before = await store.getUser(user.id);
  const entries = await store.ledger(user.id);
  await assert.rejects(store.completeGeneration(second.id, sameArtifact));
  assert.deepEqual(await store.getUser(user.id), before);
  assert.deepEqual(await store.ledger(user.id), entries);
  assert.equal((await store.getJob(user.id, second.id)).status, 'running');
  await store.failGeneration(second.id, '图片已返回，但结算状态需要核对。', true);
  assert.deepEqual([(await store.getUser(user.id)).credits, (await store.getUser(user.id)).reserved_credits], [9, 1]);
});

test('人工确认未出图只释放预留；普通用户不能管理员读取别人的图片', async t => {
  const { store } = fixture(t);
  const user = await account(store, '17');
  const admin = await createTestAdmin(store);
  const plan = await confirmedPlan(store, user);
  const job = await reserve(store, user, plan);
  await store.failGeneration(job.id, '结果未知', true);
  await store.resolveUncertainJob(job.id, false, admin.id, '核对确认没有出图');
  const current = await store.getUser(user.id);
  assert.deepEqual([current.credits, current.reserved_credits], [10, 0]);
  const successful = await reserve(store, user, plan);
  await store.claimJob(successful.id);
  const work = await store.completeGeneration(successful.id, artifact());
  await assert.rejects(store.getArtworkForAdmin(user.id, work.id), codeIs('admin_required'));
  assert.equal((await store.getArtworkForAdmin(admin.id, work.id)).id, work.id);
  await assert.rejects(store.saveSettings({ api_key: 'plaintext-must-not-be-stored' }), codeIs('invalid_settings'));
});

test('投递报错仅冻结未领取任务，不影响已running或succeeded的消费', async t => {
  const { store } = fixture(t);
  const user = await account(store, '19');
  const plan = await confirmedPlan(store, user);
  const queued = await reserve(store, user, plan);
  await store.failGeneration(queued.id, '投递结果未知', true, true);
  assert.equal((await store.getJob(user.id, queued.id)).status, 'uncertain');
  const running = await reserve(store, user, plan);
  await store.claimJob(running.id);
  const beforeJob = await store.getJob(user.id, running.id);
  const beforeUser = await store.getUser(user.id);
  const beforeLedger = await store.ledger(user.id);
  await store.failGeneration(running.id, '消息已被消费，但send返回超时', true, true);
  assert.deepEqual(await store.getJob(user.id, running.id), beforeJob);
  assert.deepEqual(await store.getUser(user.id), beforeUser);
  assert.deepEqual(await store.ledger(user.id), beforeLedger);
  await store.completeGeneration(running.id, artifact());
  const succeeded = await store.getJob(user.id, running.id);
  await store.failGeneration(running.id, '迟到的投递超时', true, true);
  assert.deepEqual(await store.getJob(user.id, running.id), succeeded);
  const settled = await store.getUser(user.id);
  assert.deepEqual([settled.credits, settled.reserved_credits], [9, 1]);
});
