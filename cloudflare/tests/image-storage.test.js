import test from 'node:test';
import assert from 'node:assert/strict';
import { D1ImageStorage } from '../src/image-storage.js';
import { Store } from '../src/store.js';
import { IMAGE_CHUNK_BYTES, IMAGE_STORAGE_BUDGET, MAX_IMAGE_BYTES, newId } from '../src/contracts.js';
import { createTestD1, createTestAdmin, createAuthorizedTestUser } from './helpers.js';

async function fixture(t) {
  const db = createTestD1();
  t.after(() => db.close());
  const store = new Store(db);
  const user = await createAuthorizedTestUser(store, { name: '分片图片验收', phone: '19900000401', region: '测试地区', school: '测试学校', grade: '小学五年级' }, 'test-hash');
  const answers = { theme: '人机共生' };
  let plan = await store.createPlan(user.id, answers.theme, answers);
  plan = await store.savePlan(user.id, plan.id, { title: plan.title, answers, step: 5, confirmed: true });
  const job = await store.reserveGeneration(user.id, plan.id, newId(), '测试绘图提示', {}, plan.revision);
  await store.claimJob(job.id);
  const artworkId = newId();
  const key = `artworks/${user.id}/${artworkId}.png`;
  const options = { httpMetadata: { contentType: 'image/png' }, customMetadata: { job_id: job.id, artwork_id: artworkId } };
  return { db, store, user, plan, job, key, options, images: new D1ImageStorage(db) };
}

test('D1分片精确还原图片，单行不超过1MiB，预留转换为实际预算', async t => {
  const f = await fixture(t);
  const data = Buffer.alloc(IMAGE_CHUNK_BYTES * 2 + 31, 173);
  data[data.length - 1] = 39;
  await f.images.put(f.key, data, f.options);
  const meta = await f.db.prepare('SELECT * FROM image_objects WHERE object_key = ?').bind(f.key).first();
  assert.equal(meta.completed, 1);
  assert.equal(meta.chunk_count, 3);
  assert.equal(meta.byte_size, data.length);
  assert.equal((await f.store.getJobInternal(f.job.id)).storage_reservation_bytes, 0);
  const maximum = await f.db.prepare('SELECT MAX(LENGTH(body_base64)) AS largest FROM image_chunks').first('largest');
  assert.ok(maximum <= 1024 * 1024);
  const object = await f.images.get(f.key);
  assert.equal(object.size, data.length);
  assert.equal(object.httpMetadata.contentType, 'image/png');
  assert.deepEqual(Buffer.from(await object.arrayBuffer()), data);
});

test('完成对象幂等复用，禁止用不同图片覆盖；删除会级联清理分片', async t => {
  const f = await fixture(t);
  const data = Buffer.from('明确标记的测试图片字节');
  await f.images.put(f.key, data, f.options);
  await f.images.put(f.key, data, f.options);
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM image_objects').first('n'), 1);
  await assert.rejects(f.images.put(f.key, Buffer.from('另外一张'), f.options));
  await f.images.delete(f.key);
  assert.equal(await f.images.get(f.key), null);
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM image_chunks').first('n'), 0);
});

test('只允许已领取的本人任务写图，不接受伪造归属或超出上限的图片', async t => {
  const f = await fixture(t);
  const otherKey = `artworks/${'a'.repeat(32)}/${f.options.customMetadata.artwork_id}.png`;
  await assert.rejects(f.images.put(otherKey, Buffer.from('测试'), f.options));
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM image_objects').first('n'), 0);
  await assert.rejects(f.images.put(f.key, new Uint8Array(MAX_IMAGE_BYTES + 1), f.options));
  await f.store.failGeneration(f.job.id, '测试任务已明确失败', false);
  await assert.rejects(f.images.put(f.key, Buffer.from('测试'), f.options));
});

test('中途写入失败不公开残图，人工释放只清理未完成分片', async t => {
  const f = await fixture(t);
  const prepare = f.db.prepare;
  let writes = 0;
  f.db.prepare = query => {
    const statement = prepare(query);
    return { ...statement, bind(...args) {
      const bound = statement.bind(...args);
      return { ...bound, async run() {
        if (query.startsWith('INSERT INTO image_chunks') && ++writes === 2) throw new Error('测试分片写入中断');
        return bound.run();
      } };
    } };
  };
  await assert.rejects(f.images.put(f.key, new Uint8Array(IMAGE_CHUNK_BYTES + 3), f.options));
  f.db.prepare = prepare;
  assert.equal(await f.images.get(f.key), null);
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM image_chunks').first('n'), 1);
  await f.store.failGeneration(f.job.id, '图片保存结果待核对', true);
  assert.equal((await f.store.getUser(f.user.id)).reserved_credits, 1);
  const admin = await createTestAdmin(f.store);
  await f.store.resolveUncertainJob(f.job.id, false, admin.id, '已核对只有未完成分片');
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM image_objects').first('n'), 0);
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM image_chunks').first('n'), 0);
  assert.equal((await f.store.getUser(f.user.id)).credits, 10);
});

test('存储预算包含其他任务预留，满额时不创建新任务或改变算力', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 9; i += 1) await f.store.reserveGeneration(f.user.id, f.plan.id, newId(), '测试', {}, f.plan.revision);
  const other = await createAuthorizedTestUser(f.store, { name: '第二位测试同学', phone: '19900000403', region: '测试', school: '测试', grade: '小学五年级' }, 'test-hash');
  let plan = await f.store.createPlan(other.id, '测试', { theme: '测试' });
  plan = await f.store.savePlan(other.id, plan.id, { title: '测试', answers: plan.answers, step: 5, confirmed: true });
  await f.store.reserveGeneration(other.id, plan.id, newId(), '测试', {}, plan.revision);
  const before = await f.store.getUser(other.id);
  const entries = (await f.store.ledger(other.id)).length;
  await assert.rejects(f.store.reserveGeneration(other.id, plan.id, newId(), '测试', {}, plan.revision), error => error.code === 'storage_capacity');
  assert.deepEqual(await f.store.getUser(other.id), before);
  assert.equal((await f.store.ledger(other.id)).length, entries);
  const reserved = await f.db.prepare('SELECT SUM(storage_reservation_bytes) AS n FROM jobs').first('n');
  assert.ok(reserved <= IMAGE_STORAGE_BUDGET);
  const admin = await createTestAdmin(f.store);
  let adminPlan = await f.store.createPlan(admin.id, '管理员测试', { theme: '测试' });
  adminPlan = await f.store.savePlan(admin.id, adminPlan.id, { title: '管理员测试', answers: adminPlan.answers, step: 5, confirmed: true });
  await assert.rejects(f.store.reserveGeneration(admin.id, adminPlan.id, newId(), '测试', {}, adminPlan.revision), error => error.code === 'storage_capacity');
  assert.equal((await f.store.ledger(admin.id)).length, 1);
  await f.store.failGeneration(f.job.id, '测试明确失败释放空间', false);
  assert.ok(await f.store.reserveGeneration(other.id, plan.id, newId(), '重新可用', {}, plan.revision));
});

test('20MiB上限图片分片写入和流读取各少于50次D1查询', async t => {
  const f = await fixture(t);
  let queries = 0;
  const prepare = f.db.prepare;
  f.db.prepare = query => { queries += 1; return prepare(query); };
  const data = new Uint8Array(MAX_IMAGE_BYTES);
  data[data.length - 1] = 211;
  await f.images.put(f.key, data, f.options);
  assert.ok(queries < 40, `写入使用${queries}次查询`);
  queries = 0;
  const object = await f.images.get(f.key);
  const received = new Uint8Array(await object.arrayBuffer());
  assert.equal(received.length, MAX_IMAGE_BYTES);
  assert.equal(received[received.length - 1], 211);
  assert.ok(queries < 40, `读取使用${queries}次查询`);
});
