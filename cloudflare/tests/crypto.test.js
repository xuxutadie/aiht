import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, sha256, constantTimeEqual, encryptSecret, decryptSecret } from '../src/crypto.js';

const masterKey = Buffer.alloc(32, 7).toString('base64');

test('继续验证 Python 生成的 scrypt 密码，含中文', async () => {
  const encoded = 'scrypt$16384$8$1$000102030405060708090a0b0c0d0e0f$e6651149ac08bc28f91427044cf88e553c8c12d6bdca642b984e6f1bffb1ef7b';
  assert.equal(await verifyPassword('测试密码123!', encoded), true);
  assert.equal(await verifyPassword('测试密码124!', encoded), false);
  assert.equal(await verifyPassword('测试密码123!', encoded.replace('$16384$', '$32768$')), false);
});

test('新密码使用独立随机盐，保留相同格式并允许完整 Unicode 字符', async () => {
  const first = await hashPassword('创作密码🖼️123');
  const second = await hashPassword('创作密码🖼️123');
  assert.match(first, /^scrypt\$16384\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
  assert.notEqual(first, second);
  assert.equal(await verifyPassword('创作密码🖼️123', first), true);
  await assert.rejects(hashPassword('short'), error => error.code === 'invalid_password');
  await assert.rejects(hashPassword('password\ud800'), error => error.code === 'invalid_password');
  assert.equal(await verifyPassword('password123', 'scrypt$16384$8$1$zz$aa'), false);
});

test('摘要与常时比较返回稳定结果', async () => {
  assert.equal(await sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(constantTimeEqual('same', 'same'), true);
  assert.equal(constantTimeEqual('same', 'diff'), false);
  assert.equal(constantTimeEqual('same', 'different'), false);
});

test('API 密钥经随机 nonce 加密，篡改和错误主密钥无法解密', async () => {
  const original = 'integration-test-secret-only';
  const first = await encryptSecret(original, masterKey);
  const second = await encryptSecret(original, masterKey);
  assert.notEqual(JSON.stringify(first), JSON.stringify(second));
  assert.equal(JSON.stringify(first).includes(original), false);
  assert.equal(await decryptSecret(JSON.parse(JSON.stringify(first)), masterKey), original);
  await assert.rejects(decryptSecret(first, Buffer.alloc(32, 8).toString('base64')));
  await assert.rejects(decryptSecret({ ...first, ciphertext: Buffer.alloc(20).toString('base64') }, masterKey));
  await assert.rejects(encryptSecret(original, 'invalid-key'));
});
