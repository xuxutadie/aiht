// 单独运行的本地workerd验收：仅使用Wrangler已安装的开发工具，不发布测试入口。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temporary = await mkdtemp(join(tmpdir(), 'aiht-workerd-check-'));
const bundlePath = join(temporary, 'local-fixture.mjs');
await build({
  stdin: {
    resolveDir: root, sourcefile: 'local-fixture.js', contents: `
      import { Store } from './src/store.js';
      import { D1ImageStorage } from './src/image-storage.js';
      import { newId, MAX_IMAGE_BYTES } from './src/contracts.js';
      import { getRuntimeImage } from './src/runtime-services.js';
      import { configFingerprint } from './src/provider.js';
      import { encryptSecret } from './src/crypto.js';
      import { handleQueue } from './src/queue.js';
      export { AihtRuntimeServices } from './src/runtime-services.js';
      async function localStudent(store, profile) {
        const existing = await store.first("SELECT id FROM users WHERE role = 'admin'");
        const admin = existing || await store.createUser({name:'本地验收管理员',phone:'19900009999'},'test-only-hash','admin');
        const [{ code }] = await store.createAuthorizationCodes(admin.id);
        return store.createUser(profile, 'test-only-hash', 'student', code);
      }
      export default { async fetch(_request, env) {
        const store = new Store(env.DB);
        if (new URL(_request.url).pathname === '/hk') {
          const config = {base_url:'https://api.openai-hk.com/v1',model:'gpt-image-2',quality:'low',watermark:true,api_key:'hk-workerd-fake-key-only'};
          const masterKey = 'CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk=';
          await store.saveSettings({base_url:config.base_url,model:config.model,quality:config.quality,watermark:true,encrypted_key:await encryptSecret(config.api_key,masterKey)});
          const user = await localStudent(store, {name:'仅本地HK验收',phone:'19900009902',region:'测试',school:'测试',grade:'测试'});
          let plan = await store.createPlan(user.id,'模拟HK任务',{theme:'模拟'});
          plan = await store.savePlan(user.id,plan.id,{title:plan.title,answers:plan.answers,step:5,confirmed:true});
          const job = await store.reserveGeneration(user.id,plan.id,newId(),'模拟创作方案',{ratio:'16:9',model:config.model,base_url:config.base_url,config_fingerprint:await configFingerprint(config)},plan.revision);
          const previousFetch = globalThis.fetch;
          let mockedRequests = 0;
          const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
          globalThis.fetch = async (url,init) => {
            if (url !== 'https://api.openai-hk.com/v1/images/generations') throw new Error('测试禁止访问外网');
            const body = JSON.parse(init.body);
            if (body.model !== 'gpt-image-2' || body.n !== 1 || body.size !== '1280x720' || body.quality !== 'low' || body.response_format !== 'b64_json' || 'watermark' in body || 'layer_decomposition' in body) throw new Error('HK单图参数不正确');
            mockedRequests += 1;
            return new Response(JSON.stringify({data:[{b64_json:'data:image/png;base64,'+png}],usage:{total_tokens:5}}),{headers:{'Content-Type':'application/json'}});
          };
          try {
            const message = () => ({body:{job_id:job.id},ack(){}});
            await handleQueue({messages:[message(),message()]},{...env,CONFIG_ENCRYPTION_KEY:masterKey});
            const account = await store.getUser(user.id);
            const completed = await store.getJob(user.id,job.id);
            return Response.json({mockedRequests,status:completed.status,credits:account.credits,reserved_credits:account.reserved_credits,artworks:(await store.listArtworks(user.id)).length});
          } finally { globalThis.fetch = previousFetch; }
        }
        const user = await localStudent(store, {name:'仅本地分片验收',phone:'19900009901',region:'测试',school:'测试',grade:'测试'});
        const answers = {theme:'明确标记的模拟数据'};
        let plan = await store.createPlan(user.id, answers.theme, answers);
        plan = await store.savePlan(user.id, plan.id, {title:plan.title, answers, step:5, confirmed:true});
        const job = await store.reserveGeneration(user.id, plan.id, newId(), '不调用绘图接口', {}, plan.revision);
        await store.claimJob(job.id);
        const id = newId();
        const key = 'artworks/' + user.id + '/' + id + '.png';
        // 二进制边界样本只验证存储，不代表可展示的真实PNG，也不经过付费模型。
        const bytes = new Uint8Array(MAX_IMAGE_BYTES).fill(17);
        bytes[0] = 137; bytes[bytes.length - 1] = 39;
        await new D1ImageStorage(env.DB).put(key, bytes, {httpMetadata:{contentType:'image/png'}, customMetadata:{job_id:job.id,artwork_id:id}});
        await store.completeGeneration(job.id, {id,image_path:key,mime:'image/png',width:100,height:100,description:'本地验收',reflection:''});
        const image = await getRuntimeImage(env, key);
        return new Response(image.body, {headers:{'Content-Type':image.httpMetadata.contentType,'Content-Length':String(image.size)}});
      }};
    `,
  },
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2022',
  external: ['node:*'], outfile: bundlePath,
});
const runtime = new Miniflare(convertV4MiniflareOptions({
  workers: [{ name: 'local-storage-check', modules: true, scriptPath: bundlePath,
  compatibilityDate: '2026-11-14', compatibilityFlags: ['nodejs_compat'],
  d1Databases: ['DB'],
  durableObjects: { RUNTIME_SERVICES: { className: 'AihtRuntimeServices', useSQLite: true } },
  }],
}));
try {
  const db = await runtime.getD1Database('DB');
  const schema = (await readFile(join(root, 'schema.sql'), 'utf8')).replace(/^--.*$/gmu, '');
  // D1已经强制开启外键，不能在其隐式事务中重设该SQLite开关。
  await db.batch(schema.split(';').map(sql => sql.trim()).filter(sql => sql && !/^PRAGMA foreign_keys\s*=/iu.test(sql)).map(sql => db.prepare(sql)));
  const response = await runtime.dispatchFetch('http://local.test/storage-roundtrip');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'image/png');
  const actual = Buffer.from(await response.arrayBuffer());
  const expected = Buffer.alloc(20 * 1024 * 1024, 17);
  expected[0] = 137; expected[expected.length - 1] = 39;
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(actual.length, expected.length);
  assert.equal(digest(actual), digest(expected));
  const row = await db.prepare('SELECT COUNT(*) AS chunks, MAX(LENGTH(body_base64)) AS maximum FROM image_chunks').first();
  assert.equal(row.chunks, 27);
  assert.ok(row.maximum <= 1024 * 1024);
  const user = await db.prepare("SELECT credits, reserved_credits FROM users WHERE phone = '19900009901'").first();
  assert.equal(user.credits, 9);
  assert.equal(user.reserved_credits, 0);
  console.log(JSON.stringify({runtime:'workerd',bytes:actual.length,chunks:row.chunks,maximum_row_bytes:row.maximum,sha256_match:true,credits:user.credits,reserved_credits:user.reserved_credits,paid_api_calls:0}));
  const hkResponse = await runtime.dispatchFetch('http://local.test/hk');
  const hk = await hkResponse.json();
  assert.equal(hkResponse.status,200);
  assert.deepEqual(hk,{mockedRequests:1,status:'succeeded',credits:9,reserved_credits:0,artworks:1});
  console.log(JSON.stringify({runtime:'workerd',provider:'openai-hk',...hk,paid_api_calls:0}));
} finally {
  await runtime.dispose();
}
