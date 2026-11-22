// 真实本地workerd/D1验收；临时Worker不发布、不读取部署凭据、不调用绘图接口。
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temporary = await mkdtemp(join(tmpdir(), 'aiht-workerd-authorization-'));
const bundlePath = join(temporary, 'authorization-fixture.mjs');
await build({
  stdin: { resolveDir: root, sourcefile: 'authorization-fixture.js', contents: `
    import { Store } from './src/store.js';
    export default { async fetch(request, env) {
      const store = new Store(env.DB);
      const body = await request.json();
      try {
        const path = new URL(request.url).pathname;
        if (path === '/setup') return Response.json(await store.createUser(body, 'test-hash', 'admin'));
        if (path === '/issue') return Response.json(await store.createAuthorizationCodes(body.adminId, body.count));
        if (path === '/register') return Response.json(await store.createUser(body.profile, 'test-hash', 'student', body.code));
        return new Response('没有测试接口', { status: 404 });
      } catch (error) {
        return Response.json({ error: { code: error.code || 'internal_error' } }, { status: error.status || 500 });
      }
    }};
  ` },
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', external: ['node:*'], outfile: bundlePath,
});
const runtime = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'local-authorization-check',
  modules: true, scriptPath: bundlePath, compatibilityDate: '2026-11-14', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'] }] }));
try {
  const db = await runtime.getD1Database('DB');
  try { assert.equal(await db.prepare('SELECT 1 AS value').first('value'), 1); }
  catch (error) { throw new Error('本地D1基础查询未通过，真实D1授权码验收尚未执行。', { cause: error }); }
  const schema = (await readFile(join(root, 'schema.sql'), 'utf8')).replace(/^--.*$/gmu, '');
  // D1已经强制开启外键，不接受在隐式事务中重设SQLite的foreign_keys开关。
  await db.batch(schema.split(';').map(sql => sql.trim()).filter(sql => sql && !/^PRAGMA foreign_keys\s*=/iu.test(sql)).map(sql => db.prepare(sql)));
  async function call(path, body) {
    const response = await runtime.dispatchFetch('http://local.test' + path, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
    return { status: response.status, data: await response.json() };
  }
  const profile = index => ({ name: '本地并发验收', phone: `199000098${String(index).padStart(2, '0')}`, region: '测试', school: '测试学校', grade: '小学五年级' });
  const admin = await call('/setup', profile(99));
  assert.equal(admin.status, 200);
  const issued = await call('/issue', { adminId: admin.data.id, count: 4 });
  assert.equal(issued.status, 200);
  assert.equal(issued.data.length, 4);
  const [shared, duplicatePhone, failedGrant, invalidProfile] = issued.data;
  const attempts = await Promise.all(Array.from({ length: 25 }, (_, i) => call('/register', { profile: profile(i), code: shared.code })));
  const winners = attempts.filter(result => result.status === 200);
  assert.equal(winners.length, 1);
  assert.equal(attempts.filter(result => result.status === 400 && result.data.error.code === 'invalid_authorization_code').length, 24);
  const winner = winners[0].data;
  assert.equal(winner.credits, 10);
  assert.equal((await call('/register', { profile: { ...profile(31), phone: winner.phone }, code: duplicatePhone.code })).data.error.code, 'phone_registered');
  assert.equal((await call('/register', { profile: { ...profile(32), school: '' }, code: invalidProfile.code })).status, 400);
  assert.equal((await call('/register', { profile: profile(33) })).data.error.code, 'authorization_code_required');
  assert.equal((await call('/register', { profile: profile(33), code: 'invalid' })).data.error.code, 'invalid_authorization_code');
  // 让事务第二步真实SQL失败，验证第一步新建用户也一并回滚。
  await db.prepare("CREATE TRIGGER fail_test_grant BEFORE INSERT ON ledger WHEN EXISTS (SELECT 1 FROM users WHERE users.id = NEW.user_id AND users.phone = '19900009834') BEGIN SELECT RAISE(ABORT, '测试流水失败'); END").run();
  assert.equal((await call('/register', { profile: profile(34), code: failedGrant.code })).status, 500);
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM users WHERE phone = '19900009834'").first('n'), 0);
  for (const item of [duplicatePhone, failedGrant, invalidProfile]) {
    const row = await db.prepare('SELECT used_by,used_at FROM authorization_codes WHERE id = ?').bind(item.id).first();
    assert.equal(row.used_by, null);
    assert.equal(row.used_at, null);
  }
  await db.prepare('DROP TRIGGER fail_test_grant').run();
  assert.equal((await call('/register', { profile: profile(34), code: failedGrant.code })).status, 200);
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE kind = 'grant'").first('n'), 3);
  assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM authorization_codes WHERE used_by IS NOT NULL').first('n'), 2);
  console.log(JSON.stringify({ runtime: 'workerd', database: 'local-D1', concurrent_attempts: 25, registered_from_shared_code: 1,
    invalid_shared_code: 24, duplicate_phone_preserves_code: true, invalid_profile_preserves_code: true,
    failed_ledger_rolls_back_user_and_code: true, paid_api_calls: 0 }));
} finally { await runtime.dispose(); }
