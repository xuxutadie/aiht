import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { brotliCompressSync, gzipSync } from 'node:zlib';
const assets = new URL('../.wrangler/frontend-assets/', import.meta.url);
const digest = text => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

test('云端首屏内嵌打包资源，精确CSP哈希匹配且保留旧入口资源', async t => {
  // npm pretest已先构建；并行用例只读取产物，避免重写其他测试正在导入的安全策略。
  const html = await readFile(new URL('index.html', assets), 'utf8');
  assert.doesNotMatch(html, /<script\b[^>]*\bsrc\s*=/iu);
  assert.doesNotMatch(html, /<link\b[^>]*\brel\s*=\s*["']stylesheet["']/iu);
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/giu)];
  const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/giu)];
  assert.equal(scripts.length, 1);
  assert.equal(styles.length, 1);
  assert.doesNotMatch(scripts[0][1], /\bimport\s*\(/u);

  const policy = await import(`../.wrangler/frontend-policy.js?test=${Date.now()}`);
  assert.equal(policy.FRONTEND_SCRIPT_HASH, digest(scripts[0][1]));
  assert.equal(policy.FRONTEND_STYLE_HASH, digest(styles[0][1]));
  const worker = (await import('../src/index.js')).default;
  const response = await worker.fetch(new Request('https://xqd-ai.cn/'), {
    ASSETS: { fetch: async () => new Response(html, { headers: { 'Content-Type': 'text/html' } }) },
  });
  const csp = response.headers.get('Content-Security-Policy');
  assert.ok(csp.includes(`script-src 'self' ${policy.FRONTEND_SCRIPT_HASH}`));
  assert.ok(csp.includes(`style-src 'self' ${policy.FRONTEND_STYLE_HASH}`));
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/iu);

  const retained = ['favicon.svg', 'styles.css', 'app.js', 'api.js', 'ui.js', 'auth.js', 'authorization-codes.js', 'workspace.js', 'artworks.js', 'admin.js', 'steps.js', 'credits.js'];
  for (const name of retained) {
    assert.deepEqual(await readFile(new URL(name, assets)), await readFile(new URL(`../../public/${name}`, import.meta.url)));
  }
  assert.deepEqual((await readdir(assets)).sort(), ['index.html', ...retained].sort());
  const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.workers_dev, true);
  // 备案审核期间保持自定义域名暂停，构建不能意外恢复域名路由。
  assert.deepEqual(config.routes, []);
  assert.equal(config.assets.directory, '.wrangler/frontend-assets');
  assert.equal(config.build.command, 'npm run build');

  const bytes = Buffer.byteLength(html);
  assert.ok(bytes < 120_000, `首屏HTML过大：${bytes}字节`);
  assert.ok(gzipSync(html).byteLength < 35_000, '首屏gzip压缩体积超出预算');
  t.diagnostic(JSON.stringify({ bytes, gzip_bytes: gzipSync(html).byteLength, brotli_bytes: brotliCompressSync(html).byteLength }));
});
