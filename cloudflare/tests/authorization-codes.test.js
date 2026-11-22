import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Store } from '../src/store.js';
import { sha256 } from '../src/crypto.js';
import worker from '../src/index.js';
import { COOKIE_NAME } from '../src/contracts.js';
import { AihtRuntimeServices } from '../src/runtime-services.js';
import { createTestD1 } from './helpers.js';

const profile = suffix => ({ name: '授权码验收学生', phone: `199000003${suffix}`, region: '测试地区', school: '测试学校', grade: '小学五年级' });
const codeIs = code => error => error.code === code && error.status === 400;
async function fixture(t) {
  const db = createTestD1();
  t.after(() => db.close());
  const store = new Store(db);
  const admin = await store.createUser(profile('00'), 'test-only-hash', 'admin');
  return { db, store, admin };
}
async function issue(f, count = 1) { return f.store.createAuthorizationCodes(f.admin.id, count); }
async function register(f, code, suffix = '01', changes = {}) {
  return f.store.createUser({ ...profile(suffix), ...changes }, 'test-only-hash', 'student', code);
}

test('授权码生成八位安全数字且数据库只有摘要，历史不会再返回完整码', async t => {
  const f = await fixture(t);
  const codes = await issue(f, 100);
  assert.equal(codes.length, 100);
  assert.equal(new Set(codes.map(item => item.code)).size, 100);
  for (const code of codes) {
    assert.match(code.code, /^[1-9][0-9]{7}$/u);
    assert.equal(code.code_hint, code.code.slice(-4));
    assert.equal(code.status, 'unused');
    assert.equal(code.used_by, null);
    assert.equal(code.used_at, null);
    const row = await f.db.prepare('SELECT * FROM authorization_codes WHERE id = ?').bind(code.id).first();
    assert.equal(row.code_hash, await sha256(code.code));
    assert.equal(row.created_by, f.admin.id);
    assert.equal(row.code, undefined);
    assert.equal(JSON.stringify(row).includes(code.code), false);
  }
  const history = await f.store.listAuthorizationCodes(f.admin.id);
  assert.equal(history.codes.length, 50);
  assert.equal(history.codes.some(item => 'code' in item || 'code_hash' in item), false);
  assert.equal(history.codes[0].id, codes.at(-1).id);
});

test('授权码仅能注册一次，注册与赠送流水同步，登录资料不泄露授权码', async t => {
  const f = await fixture(t);
  const [code] = await issue(f);
  const user = await register(f, ` ${code.code} `);
  assert.equal(user.credits, 10);
  assert.equal(user.role, 'student');
  assert.equal(user.authorization_code, undefined);
  assert.equal((await f.store.ledger(user.id)).filter(row => row.kind === 'grant').length, 1);
  await assert.rejects(register(f, code.code, '02'), codeIs('invalid_authorization_code'));
  const listed = await f.store.listAuthorizationCodes(f.admin.id);
  assert.equal(listed.codes[0].status, 'used');
  assert.equal(listed.codes[0].used_by, user.id);
  assert.equal(listed.codes[0].used_at, user.created_at);
});

test('随机拒绝采样与碰撞均有限重试，整批失败不留下未展示的码', async t => {
  const f = await fixture(t);
  const random = t.mock.method(crypto, 'getRandomValues', array => { array[0] = 0; return array; });
  const [first] = await issue(f);
  assert.equal(first.code, '10000000');
  const draws = [4294967295, 0, 1];
  random.mock.mockImplementation(array => { array[0] = draws.shift(); return array; });
  const [second] = await issue(f);
  assert.equal(second.code, '10000001');
  assert.equal(draws.length, 0);
  random.mock.mockImplementation(array => { array[0] = 0; return array; });
  await assert.rejects(issue(f), error => error.code === 'authorization_code_generation_failed');
  await assert.rejects(issue(f, 2), error => error.code === 'authorization_code_generation_failed');
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM authorization_codes').first('n'), 2);
});

test('缺码、格式错误、未生成码均拒绝，不创建学生或赠送流水', async t => {
  const f = await fixture(t);
  for (const code of [undefined, null, '', '  ']) await assert.rejects(register(f, code), codeIs('authorization_code_required'));
  for (const code of [12345678, '01234567', '1234567', '123456789', '１２３４５６７８', '12aa5678', '12345678']) {
    await assert.rejects(register(f, code), codeIs('invalid_authorization_code'));
  }
  assert.equal((await f.store.listUsers()).length, 1);
  assert.equal(await f.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE kind = 'grant'").first('n'), 1);
});

test('无效资料、重复手机号和流水写入异常不会消费授权码，事务失败不残留用户', async t => {
  const f = await fixture(t);
  const [first, second] = await issue(f, 2);
  await register(f, first.code);
  await assert.rejects(register(f, second.code), error => error.code === 'phone_registered');
  await assert.rejects(register(f, second.code, '02', { school: '' }), error => error.status === 400);
  assert.equal((await f.store.listAuthorizationCodes(f.admin.id)).codes[0].status, 'unused');
  await f.db.exec("CREATE TRIGGER fail_student_grant BEFORE INSERT ON ledger WHEN NEW.user_id != '" + f.admin.id + "' BEGIN SELECT RAISE(ABORT, '测试赠送流水失败'); END;");
  await assert.rejects(register(f, second.code, '02'));
  assert.equal(await f.store.findUserByPhone(profile('02').phone), null);
  const row = await f.db.prepare('SELECT used_by, used_at FROM authorization_codes WHERE id = ?').bind(second.id).first();
  assert.deepEqual(row, { used_by: null, used_at: null });
  await f.db.exec('DROP TRIGGER fail_student_grant');
  assert.equal((await register(f, second.code, '02')).credits, 10);
});

test('20人并发使用同一授权码只注册一人且只产生一条赠送', async t => {
  const f = await fixture(t);
  const [code] = await issue(f);
  const attempts = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => register(f, code.code, String(i + 1).padStart(2, '0'))));
  const passed = attempts.filter(result => result.status === 'fulfilled');
  assert.equal(passed.length, 1);
  assert.equal(attempts.filter(result => result.status === 'rejected' && result.reason.code === 'invalid_authorization_code').length, 19);
  assert.equal((await f.store.listUsers()).length, 2);
  assert.equal((await f.store.ledger(passed[0].value.id)).length, 1);
});

test('分页按ID倒序，游标无重叠，累计生成数量不受单批100上限影响', async t => {
  const f = await fixture(t);
  await issue(f, 100);
  await issue(f, 3);
  let before = null;
  const seen = [];
  do {
    const page = await f.store.listAuthorizationCodes(f.admin.id, { limit: 17, before });
    seen.push(...page.codes.map(item => item.id));
    before = page.next_cursor;
  } while (before !== null);
  assert.equal(seen.length, 103);
  assert.equal(new Set(seen).size, 103);
  assert.deepEqual(seen, [...seen].sort((a, b) => b - a));
  for (const count of [0, -1, 101, 1.5, '1', null]) await assert.rejects(issue(f, count), codeIs('invalid_authorization_code_count'));
  for (const options of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { before: 0 }, { before: -1 }, { before: Number.MAX_SAFE_INTEGER + 1 }]) {
    await assert.rejects(f.store.listAuthorizationCodes(f.admin.id, options), codeIs('invalid_pagination'));
  }
});

test('普通账号不能生成或查看授权码，数据库约束禁止用码人和时间不同步', async t => {
  const f = await fixture(t);
  const [code] = await issue(f);
  const user = await register(f, code.code);
  await assert.rejects(f.store.createAuthorizationCodes(user.id), error => error.status === 403);
  await assert.rejects(f.store.listAuthorizationCodes(user.id), error => error.status === 403);
  const [unused] = await issue(f);
  await assert.rejects(f.db.prepare('UPDATE authorization_codes SET used_by = ? WHERE id = ?').bind(user.id, unused.id).run());
  await assert.rejects(f.db.prepare('UPDATE authorization_codes SET used_at = ? WHERE id = ?').bind(new Date().toISOString(), unused.id).run());
});

test('升级SQL可重复执行且保留原账号、方案、图片及余额', async t => {
  const f = await fixture(t);
  const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const upgrade = readFileSync(new URL('../upgrade-authorization-codes.sql', import.meta.url), 'utf8');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS authorization_codes/u);
  const before = await f.store.getUser(f.admin.id);
  let plan = await f.store.createPlan(f.admin.id, '升级保留方案', { theme: '原有数据' });
  plan = await f.store.savePlan(f.admin.id, plan.id, { title: plan.title, answers: plan.answers, step: 5, confirmed: true });
  const job = await f.store.reserveGeneration(f.admin.id, plan.id, 'upgrade-keep-image', '测试图片', {}, plan.revision);
  await f.store.claimJob(job.id);
  const artwork = await f.store.completeGeneration(job.id, { id: 'upgrade-keep-artwork', image_path: 'artworks/keep.png', mime: 'image/png', width: 1, height: 1 });
  await f.db.prepare('INSERT INTO image_objects (object_key,job_id,mime,byte_size,encoded_size,chunk_count,metadata_json,sha256,completed,created_at) VALUES (?,?,?,1,4,1,?,?,1,?)')
    .bind(artwork.image_path, job.id, 'image/png', '{}', 'test-only-hash', before.created_at).run();
  await f.db.prepare('INSERT INTO image_chunks (object_key,chunk_index,body_base64) VALUES (?,0,?)').bind(artwork.image_path, 'YQ==').run();
  const balance = await f.store.getUser(f.admin.id);
  await f.db.exec('DROP TABLE authorization_codes');
  await f.db.exec(upgrade);
  await f.db.exec(upgrade);
  assert.deepEqual(await f.store.getUser(f.admin.id), balance);
  assert.equal((await f.store.getPlan(f.admin.id, plan.id)).title, plan.title);
  assert.deepEqual(await f.store.getArtwork(f.admin.id, artwork.id), artwork);
  assert.equal(await f.db.prepare('SELECT body_base64 FROM image_chunks WHERE object_key = ?').bind(artwork.image_path).first('body_base64'), 'YQ==');
  assert.equal((await issue(f)).length, 1);
});

test('HTTP管理员鉴权、分页校验与注册授权码契约完整，角色字段不能提权', async t => {
  const f = await fixture(t);
  const token = '09'.repeat(32);
  await f.store.createSession(f.admin.id, await sha256(token), Math.floor(Date.now() / 1000) + 3600);
  const env = { DB: f.db };
  const runtime = new AihtRuntimeServices({}, env);
  env.RUNTIME_SERVICES = { idFromName: name => name, get: () => ({ fetch: request => runtime.fetch(request) }) };
  async function call(path, method = 'GET', body, cookie) {
    const headers = { Origin: 'https://studio.test', 'Content-Type': 'application/json' };
    if (cookie) headers.Cookie = cookie;
    const response = await worker.fetch(new Request('https://studio.test' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    return { status: response.status, data: await response.json(), cookie: response.headers.get('Set-Cookie')?.split(';', 1)[0] };
  }
  const adminCookie = `${COOKIE_NAME}=${token}`;
  assert.equal((await call('/api/admin/authorization-codes')).status, 401);
  assert.equal((await call('/api/admin/authorization-codes', 'POST', { count: 1 })).status, 401);
  const generated = await call('/api/admin/authorization-codes', 'POST', { count: 2 }, adminCookie);
  assert.equal(generated.status, 201);
  assert.equal(generated.data.codes.length, 2);
  for (const count of [null, 0, 101, '2', 1.5]) {
    assert.equal((await call('/api/admin/authorization-codes', 'POST', { count }, adminCookie)).status, 400);
  }
  for (const query of ['?limit=0', '?limit=101', '?limit=1.5', '?before=-1', '?before=0', '?before=9007199254740992', '?before=abc']) {
    assert.equal((await call('/api/admin/authorization-codes' + query, 'GET', undefined, adminCookie)).status, 400);
  }
  const listed = await call('/api/admin/authorization-codes?limit=1', 'GET', undefined, adminCookie);
  assert.equal(listed.status, 200);
  assert.equal(listed.data.codes.length, 1);
  assert.equal(typeof listed.data.next_cursor, 'number');
  assert.equal(listed.data.codes[0].code, undefined);
  const body = { ...profile('01'), password: 'TestOnly2026!', role: 'admin', credits: 900 };
  assert.equal((await call('/api/register', 'POST', body)).data.error.code, 'authorization_code_required');
  assert.equal((await call('/api/register', 'POST', { ...body, authorization_code: '123' })).data.error.code, 'invalid_authorization_code');
  const student = await call('/api/register', 'POST', { ...body, authorization_code: generated.data.codes[0].code });
  assert.equal(student.status, 200);
  assert.equal(student.data.user.role, 'student');
  assert.equal(student.data.user.credits, 10);
  assert.equal((await call('/api/admin/authorization-codes', 'GET', undefined, student.cookie)).status, 403);
  assert.equal((await call('/api/admin/authorization-codes', 'POST', { count: 1 }, student.cookie)).status, 403);
  const login = await call('/api/login', 'POST', { phone: body.phone, password: body.password });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.id, student.data.user.id);
});
