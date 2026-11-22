import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { generateImage, validateSettings, publicSettings, inspectImage, validateDownloadUrl, ProviderError, MAX_IMAGE_BYTES } from '../src/provider.js';
import * as provider from '../src/provider.js';

const key = 'integration-test-secret-only';
const config = { api_key: key, model: 'doubao-seedream-5-0-flash-260915', base_url: 'https://ark.cn-beijing.volces.com/api/v3', watermark: true };
const hkConfig = { api_key: 'hk-integration-new-secret-only', model: 'gpt-image-2', base_url: 'https://api.openai-hk.com/v1', watermark: true, quality: 'low' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const response = () => new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }], usage: { generated_images: 1, total_tokens: 23, secret: key, output_tokens: '44' } }), { headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'request-safe-1' } });

test('设置只接受官方接口与模型，空 key 保留原值，公开结果脱敏', () => {
  const result = validateSettings({ api_key: '', watermark: false }, config);
  assert.equal(result.api_key, key);
  assert.equal(result.watermark, false);
  for (const base_url of ['http://ark.cn-beijing.volces.com', 'https://127.0.0.1', 'https://ark.cn-beijing.volces.com.evil.test/api/v3']) assert.throws(() => validateSettings({ base_url }, config));
  assert.throws(() => validateSettings({ model: 'other-model' }, config));
  assert.throws(() => validateSettings({ api_key: 'bad\r\nkey' }, config));
  assert.throws(() => validateSettings({ api_key: `${key}\n` }, config));
  assert.throws(() => validateSettings({ model: `${config.model}\n` }, config));
  for (const field of ['api_key', 'model', 'base_url', 'watermark']) assert.throws(() => validateSettings({ [field]: null }, config));
  assert.throws(() => validateSettings({ watermark: 'false' }, config));
  const safe = publicSettings(result);
  assert.equal(safe.configured, true);
  assert.equal(safe.key_hint, '••••only');
  assert.equal(JSON.stringify(safe).includes(key), false);
});

test('单次请求使用官方单图参数，收录数字用量与安全请求号', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls += 1;
    assert.equal(url, `${config.base_url}/images/generations`);
    assert.equal(options.headers.Authorization, `Bearer ${key}`);
    assert.equal(options.redirect, 'manual');
    const payload = JSON.parse(options.body);
    assert.equal(payload.size, '2816x1584');
    assert.equal(payload.response_format, 'url');
    assert.equal(payload.layer_decomposition, false);
    assert.equal(Object.hasOwn(payload, 'quality'), false);
    return response();
  });
  const result = await generateImage(config, '人与机器共同照顾老人', { ratio: '16:9' });
  assert.equal(calls, 1);
  assert.deepEqual([result.mime, result.width, result.height], ['image/png', 1, 1]);
  assert.deepEqual(result.usage, { generated_images: 1, total_tokens: 23 });
  assert.equal(result.upstream_request_id, 'request-safe-1');
});

test('HK设置规范化固定地址、模型和画质，并拒绝地址伪装及服务商冲突', () => {
  for (const base_url of ['https://api.openai-hk.com', 'https://api.openai-hk.com/', 'https://api.openai-hk.com/v1', 'https://api.openai-hk.com/v1/']) {
    const result = validateSettings({ ...hkConfig, base_url });
    assert.equal(result.base_url, hkConfig.base_url);
    assert.equal(result.provider, 'openai-hk');
    assert.equal(result.quality, 'low');
  }
  for (const base_url of ['http://api.openai-hk.com', 'https://api.openai-hk.com.evil.test/v1', 'https://api.openai-hk.com/v1?x=1', 'https://api.openai-hk.com/v1#x', 'https://user@api.openai-hk.com/v1', 'https://api.openai-hk.com:444/v1', 'https://api.openai-hk.com/v1/images/generations']) assert.throws(() => validateSettings({ ...hkConfig, base_url }));
  for (const model of ['gpt-image-1', 'gpt-image-2-extra', config.model]) assert.throws(() => validateSettings({ ...hkConfig, model }));
  for (const quality of ['auto', 'LOW', '', null, false]) assert.throws(() => validateSettings({ ...hkConfig, quality }));
  for (const quality of ['low', 'medium', 'high']) assert.equal(validateSettings({ ...hkConfig, quality }).quality, quality);
  for (const providerName of ['ark', 'other', null]) assert.throws(() => validateSettings({ ...hkConfig, provider: providerName }));
  assert.equal(validateSettings({ ...hkConfig, provider: 'openai-hk' }).provider, 'openai-hk');
  assert.equal(validateSettings({}, config).provider, 'ark');
});

test('切换服务商须显式填写密钥，同服务商空密钥才保留，公开配置只给脱敏信息', () => {
  for (const api_key of [undefined, '']) {
    const payload = { base_url: hkConfig.base_url, model: hkConfig.model };
    if (api_key !== undefined) payload.api_key = api_key;
    assert.throws(() => validateSettings(payload, config));
    assert.throws(() => validateSettings({ base_url: config.base_url, model: config.model, ...('api_key' in payload ? { api_key } : {}) }, hkConfig));
  }
  assert.equal(validateSettings(hkConfig, config).api_key, hkConfig.api_key);
  assert.equal(validateSettings({ api_key: '' }, hkConfig).api_key, hkConfig.api_key);
  assert.equal(validateSettings({ ...hkConfig, api_key: key }, config).api_key, key);
  const safe = publicSettings(hkConfig);
  assert.equal(safe.provider, 'openai-hk');
  assert.equal(safe.quality, 'low');
  assert.equal(safe.key_hint, '••••only');
  assert.equal(JSON.stringify(safe).includes(hkConfig.api_key), false);
  assert.equal(publicSettings().provider, 'ark');
  assert.equal(publicSettings().quality, 'low');
});

test('配置指纹先验证规范化，密钥、服务商、模型、水印或画质变化均失配', async () => {
  const expected = createHash('sha256').update(JSON.stringify([hkConfig.base_url, hkConfig.model, true, 'low', hkConfig.api_key])).digest('hex');
  assert.equal(await provider.configFingerprint(hkConfig), expected);
  const { quality: _quality, ...legacyHkConfig } = hkConfig;
  assert.equal(await provider.configFingerprint({ ...legacyHkConfig, base_url: 'https://api.openai-hk.com/' }), expected);
  assert.equal(await provider.configFingerprint({ ...hkConfig, base_url: 'https://api.openai-hk.com', quality: 'low' }), expected);
  for (const changed of [{ ...hkConfig, api_key: 'hk-different-secret-only' }, { ...hkConfig, watermark: false }, { ...hkConfig, quality: 'high' }, config, { ...config, model: 'doubao-seedream-5-0-flash-other' }]) assert.notEqual(await provider.configFingerprint(changed), expected);
  const arkFingerprint = await provider.configFingerprint(config);
  assert.equal(await provider.configFingerprint({ ...config, base_url: 'https://ark.cn-beijing.volces.com/' }), arkFingerprint);
  assert.notEqual(await provider.configFingerprint({ ...config, model: 'doubao-seedream-5-0-flash-other' }), arkFingerprint);
  await assert.rejects(provider.configFingerprint({ ...hkConfig, base_url: 'https://evil.test' }));
});

test('HK请求固定一张图及各比例尺寸，只发送HK支持的参数', async t => {
  const sizes = { '1:1': '1024x1024', '4:3': '1024x768', '3:4': '768x1024', '16:9': '1280x720', '9:16': '720x1280' };
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls += 1;
    assert.equal(url, 'https://api.openai-hk.com/v1/images/generations');
    assert.equal(options.headers.Authorization, `Bearer ${hkConfig.api_key}`);
    assert.equal(options.redirect, 'manual');
    const payload = JSON.parse(options.body);
    assert.deepEqual(Object.keys(payload).sort(), ['model', 'n', 'prompt', 'quality', 'response_format', 'size']);
    assert.equal(payload.n, 1);
    assert.equal(payload.response_format, 'b64_json');
    assert.equal(payload.quality, 'medium');
    assert.equal(payload.size, sizes[payload.prompt]);
    return response();
  });
  for (const ratio of Object.keys(sizes)) assert.equal((await generateImage({ ...hkConfig, quality: 'medium' }, ratio, { ratio })).mime, 'image/png');
  assert.equal(calls, 5);
});

test('HK兼容裸Base64及严格图片data URI，拒绝伪装前缀、MIME冲突和非图片', async t => {
  for (const encoded of [png.toString('base64'), `data:image/png;base64,${png.toString('base64')}`]) {
    const mocked = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ data: [{ b64_json: encoded }] })));
    assert.equal((await generateImage(hkConfig, '主题')).width, 1);
    mocked.mock.restore();
  }
  for (const encoded of [`data:image/jpeg;base64,${png.toString('base64')}`, `data:image/svg+xml;base64,${png.toString('base64')}`, `data:image/png;charset=utf-8;base64,${png.toString('base64')}`, `data:image/png;base64,\n${png.toString('base64')}`, ` data:image/png;base64,${png.toString('base64')}`, `data:image/png;base64,${Buffer.from('<html>wrong</html>').toString('base64')}`]) {
    const mocked = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ data: [{ b64_json: encoded }] })));
    await assert.rejects(generateImage(hkConfig, '主题'), error => error instanceof ProviderError && error.uncertain);
    mocked.mock.restore();
  }
});

test('HK支持JPEG与WebP的严格data URI，仅记录有界数字用量', async t => {
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 2, 0, 3, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0, 0, 0xff, 0xd9]);
  const webp = Buffer.alloc(26);
  webp.write('RIFF', 0); webp.writeUInt32LE(18, 4); webp.write('WEBPVP8L', 8); webp.writeUInt32LE(5, 16); webp[20] = 0x2f; webp.writeUInt32LE(0x4002, 21);
  for (const [mime, bytes] of [['image/jpeg', jpeg], ['image/webp', webp]]) {
    const mocked = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ data: [{ b64_json: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}` }], usage: { input_tokens: 12, output_tokens: 34, total_tokens: 46, input_images: -1, generated_images: 1e13, nested: { api_key: hkConfig.api_key } } })));
    const image = await generateImage(hkConfig, '主题');
    assert.equal(image.mime, mime);
    assert.deepEqual(image.usage, { input_tokens: 12, output_tokens: 34, total_tokens: 46 });
    mocked.mock.restore();
  }
});

test('HK回退下载仅允许文档图片主机，与Ark下载范围隔离且不携带密钥', async t => {
  const allowed = 'https://myfile.addmao.com/20260427/image.png';
  assert.equal(validateDownloadUrl(allowed, 'openai-hk'), allowed);
  assert.throws(() => validateDownloadUrl(allowed));
  assert.throws(() => validateDownloadUrl('https://image.tos-cn-beijing.volces.com/image.png', 'openai-hk'));
  for (const url of ['https://myfile.addmao.com.evil.test/image.png', 'https://sub.myfile.addmao.com/image.png', 'http://myfile.addmao.com/image.png', 'https://a:b@myfile.addmao.com/image.png', 'https://myfile.addmao.com:444/image.png', 'https://myfile.addmao.com./image.png', 'https://127.0.0.1/image.png']) assert.throws(() => validateDownloadUrl(url, 'openai-hk'));
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls += 1;
    if (calls === 1) return new Response(JSON.stringify({ data: [{ url: allowed }] }));
    assert.equal(url, allowed);
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.redirect, 'manual');
    return new Response(png);
  });
  assert.equal((await generateImage(hkConfig, '主题')).width, 1);
  assert.equal(calls, 2);
});

test('HK非法下载、重定向、错误及响应超限不重复提交付费请求', async t => {
  for (const url of ['https://image.tos-cn-beijing.volces.com/image.png', 'https://evil.test/image.png']) {
    let calls = 0;
    const mocked = t.mock.method(globalThis, 'fetch', async () => { calls += 1; return new Response(JSON.stringify({ data: [{ url }] })); });
    await assert.rejects(generateImage(hkConfig, '主题'), error => error.uncertain);
    assert.equal(calls, 1);
    mocked.mock.restore();
  }
  let calls = 0;
  const redirected = t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return calls === 1 ? new Response(JSON.stringify({ data: [{ url: 'https://myfile.addmao.com/image.png' }] })) : new Response('', { status: 302, headers: { Location: 'https://evil.test/image.png' } });
  });
  await assert.rejects(generateImage(hkConfig, '主题'), error => error.uncertain);
  assert.equal(calls, 2);
  redirected.mock.restore();
  for (const status of [401, 429, 503]) {
    let requests = 0;
    const mocked = t.mock.method(globalThis, 'fetch', async () => { requests += 1; return new Response(hkConfig.api_key, { status }); });
    await assert.rejects(generateImage(hkConfig, '主题'), error => error.uncertain === (status === 503) && !error.message.includes(hkConfig.api_key));
    assert.equal(requests, 1);
    mocked.mock.restore();
  }
  t.mock.method(globalThis, 'fetch', async () => new Response('x', { headers: { 'Content-Length': String(4 * Math.ceil(MAX_IMAGE_BYTES / 3) + 64 * 1024 + 1) } }));
  await assert.rejects(generateImage(hkConfig, '主题'), error => error.uncertain);
});

test('明确 4xx 不扣点，5xx 和网络不确定不重试也不泄露正文', async t => {
  for (const status of [400, 401, 403, 429, 500, 503, 302]) {
    let calls = 0;
    const mocked = t.mock.method(globalThis, 'fetch', async () => { calls += 1; return new Response(key, { status, headers: { 'X-Request-Id': 'trace-id' } }); });
    await assert.rejects(generateImage(config, '主题', {}), error => error instanceof ProviderError && error.uncertain === !(status >= 400 && status < 500) && error.requestId === 'trace-id' && !error.message.includes(key));
    assert.equal(calls, 1);
    mocked.mock.restore();
  }
  t.mock.method(globalThis, 'fetch', async () => { throw new Error(key); });
  await assert.rejects(generateImage(config, '主题', {}), error => error.uncertain && !error.message.includes(key));
});

test('响应声明过大、流超限、非法图片或多图均进入待核对', async t => {
  const variants = [
    () => new Response('x', { headers: { 'Content-Type': 'image/png', 'Content-Length': String(MAX_IMAGE_BYTES + 1) } }),
    () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_IMAGE_BYTES + 1)); controller.close(); } }), { headers: { 'Content-Type': 'image/png' } }),
    () => new Response(JSON.stringify({ data: [{ b64_json: '%%%%' }] })),
    () => new Response(JSON.stringify({ data: [{}, {}] })),
  ];
  for (const variant of variants) {
    const mocked = t.mock.method(globalThis, 'fetch', async () => variant());
    await assert.rejects(generateImage(config, '主题', {}), error => error.uncertain === true);
    mocked.mock.restore();
  }
});

function pngChunk(kind, content) {
  const chunk = Buffer.alloc(content.length + 12);
  chunk.writeUInt32BE(content.length);
  chunk.write(kind, 4);
  content.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, chunk.length - 4)), chunk.length - 4);
  return chunk;
}

test('Ark与HK均兼容大于15MiB且小于20MiB的合法PNG base64响应及JSON膨胀', async t => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2048, 0); header.writeUInt32BE(2048, 4); header[8] = 8; header[9] = 6;
  // 每行首字节为PNG filter=0，level=0确保这是有效且足够大的真实PNG，而非伪造尺寸头。
  const rawPixels = Buffer.alloc(2048 * (1 + 2048 * 4));
  const largePng = Buffer.concat([png.subarray(0, 8), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(rawPixels, { level: 0 })), pngChunk('IEND', Buffer.alloc(0))]);
  assert.ok(largePng.length > 15 * 1024 * 1024 && largePng.length < MAX_IMAGE_BYTES);
  for (const service of [config, hkConfig]) {
    const body = JSON.stringify({ data: [{ b64_json: `${service === hkConfig ? 'data:image/png;base64,' : ''}${largePng.toString('base64')}` }] });
    assert.ok(Buffer.byteLength(body) > MAX_IMAGE_BYTES);
    const mocked = t.mock.method(globalThis, 'fetch', async () => new Response(body, { headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) } }));
    const result = await generateImage(service, '主题', { ratio: '1:1' });
    assert.deepEqual([result.width, result.height, result.data.byteLength], [2048, 2048, largePng.length]);
    mocked.mock.restore();
  }
});

test('JSON膨胀余量有界，图片URL下载仍受20MiB声明和流式上限约束', async t => {
  const jsonLimit = 4 * Math.ceil(MAX_IMAGE_BYTES / 3) + 64 * 1024;
  const tooLargeJson = t.mock.method(globalThis, 'fetch', async () => new Response('x', { headers: { 'Content-Type': 'application/json', 'Content-Length': String(jsonLimit + 1) } }));
  await assert.rejects(generateImage(config, '主题', {}), error => error.uncertain === true);
  tooLargeJson.mock.restore();
  for (const declarationOnly of [true, false]) {
    let calls = 0;
    const mocked = t.mock.method(globalThis, 'fetch', async () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({ data: [{ url: 'https://image.tos-cn-beijing.volces.com/image.png' }] }));
      if (declarationOnly) return new Response('x', { headers: { 'Content-Length': String(MAX_IMAGE_BYTES + 1), 'Content-Type': 'image/png' } });
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_IMAGE_BYTES + 1)); controller.close(); } }), { headers: { 'Content-Type': 'image/png' } });
    });
    await assert.rejects(generateImage(config, '主题', {}), error => error.uncertain === true);
    assert.equal(calls, 2);
    mocked.mock.restore();
  }
});

test('只下载官方 HTTPS 公网域名，拒绝本机、私网、凭据、重定向与非标准端口', async t => {
  for (const url of ['http://a.tos-cn-beijing.volces.com/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://10.0.0.1/x', 'https://[::1]/x', 'https://[::ffff:127.0.0.1]/x', 'https://2130706433/x', 'https://a.tos-cn-beijing.volces.com:444/x', 'https://name:pass@a.tos-cn-beijing.volces.com/x', 'https://a.tos-cn-beijing.volces.com.evil.test/x']) assert.throws(() => validateDownloadUrl(url));
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls += 1;
    if (calls === 1) return new Response(JSON.stringify({ data: [{ url: 'https://image.tos-cn-beijing.volces.com/private.png' }] }));
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.redirect, 'manual');
    return new Response(png, { headers: { 'Content-Type': 'image/png' } });
  });
  assert.equal((await generateImage(config, '主题', {})).width, 1);
  assert.equal(calls, 2);
});

test('PNG 校验真实结构，不相信 MIME 或图片扩展名', () => {
  assert.deepEqual(inspectImage(png), { mime: 'image/png', width: 1, height: 1 });
  const corrupt = Buffer.from(png); corrupt[20] ^= 1;
  assert.throws(() => inspectImage(corrupt));
  assert.throws(() => inspectImage(png.subarray(0, -12)));
  assert.throws(() => inspectImage(Buffer.from('<html>not an image</html>')));
});

test('JPEG和WebP读取真实尺寸，拒绝截断与不支持的WebP版本', () => {
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 2, 0, 3, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0, 0, 0xff, 0xd9]);
  assert.deepEqual(inspectImage(jpeg), { mime: 'image/jpeg', width: 3, height: 2 });
  assert.throws(() => inspectImage(jpeg.subarray(0, -1)));
  const webp = Buffer.alloc(26);
  webp.write('RIFF', 0); webp.writeUInt32LE(18, 4); webp.write('WEBPVP8L', 8); webp.writeUInt32LE(5, 16); webp[20] = 0x2f; webp.writeUInt32LE(0x4002, 21);
  assert.deepEqual(inspectImage(webp), { mime: 'image/webp', width: 3, height: 2 });
  assert.throws(() => inspectImage(webp.subarray(0, -1)));
  webp.writeUInt32LE(0xe0004002, 21);
  assert.throws(() => inspectImage(webp));
});
