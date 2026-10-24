import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SSHAuth } from '../src/ssh/auth.ts';
import { parseConnectMessage } from '../src/types.ts';
import { KEY_VARIANTS, MISSING_SSH_KEYGEN, encryptedKeyFixture, generateEncryptedKey, hasSshKeygen, type KeyVariant } from './fixtures/encrypted-keys.ts';

/**
 * 加密私钥回归测试。
 *
 * 夹具在运行时由 ssh-keygen 现生成（详见 ./fixtures/encrypted-keys.ts），期望指纹同样取自
 * ssh-keygen -l 的输出，因此这里校验的是「与 OpenSSH 官方实现一致」，而不是与本项目的历史
 * 输出一致。环境缺少 ssh-keygen 时跳过并写明原因，不让安全检查静默变成空转。
 */

(Object.keys(KEY_VARIANTS) as KeyVariant[]).forEach((variant) => {
  const { label } = KEY_VARIANTS[variant];
  // 惰性生成：用到才调 ssh-keygen，这样 skip 的用例不会白白付出密钥生成开销。
  const key = () => encryptedKeyFixture(variant);

  test(`加密私钥（${label}）: 正确口令可解出公钥且指纹与 ssh-keygen 一致`, async (context) => {
    if (!hasSshKeygen()) return context.skip(MISSING_SSH_KEYGEN);
    const info = await SSHAuth.publicKeyInfo(key().pem, key().passphrase);
    assert.equal(info.fingerprint, key().fingerprint);
  });

  test(`加密私钥（${label}）: 口令错误应明确报错而不是给出错误公钥`, async (context) => {
    if (!hasSshKeygen()) return context.skip(MISSING_SSH_KEYGEN);
    await assert.rejects(() => SSHAuth.publicKeyInfo(key().pem, 'definitely-wrong'), /Incorrect private key passphrase/);
  });

  test(`加密私钥（${label}）: 未提供口令应提示需要口令`, async (context) => {
    if (!hasSshKeygen()) return context.skip(MISSING_SSH_KEYGEN);
    await assert.rejects(() => SSHAuth.publicKeyInfo(key().pem), /provide its passphrase/i);
  });

  test(`加密私钥（${label}）: 行尾含空白也能解析`, async (context) => {
    if (!hasSshKeygen()) return context.skip(MISSING_SSH_KEYGEN);
    // 真实环境里有工具导出的 PEM 行尾带空格/制表符，曾经因此被拒。
    const polluted = key().pem.split('\n').map((line) => (line.startsWith('-----') ? line : `${line}  `)).join('\n');
    const info = await SSHAuth.publicKeyInfo(polluted, key().passphrase);
    assert.equal(info.fingerprint, key().fingerprint);
  });

  test(`加密私钥（${label}）: 能生成完整的公钥认证请求`, async (context) => {
    if (!hasSshKeygen()) return context.skip(MISSING_SSH_KEYGEN);
    const sessionId = new Uint8Array(32).fill(7);
    const request = await SSHAuth.buildPublicKeyAuthRequest('root', key().pem, sessionId, undefined, key().passphrase);
    assert.ok(request.length > 0, 'request should not be empty');
  });
});

test('parseConnectMessage 放行私钥口令', (context) => {
  if (!hasSshKeygen()) return context.skip(MISSING_SSH_KEYGEN);
  const parsed = parseConnectMessage({
    type: 'connect', host: 'host.example.com', port: 22, username: 'root',
    authMethod: 'publickey', privateKey: encryptedKeyFixture('ed25519Ctr').pem, keyPassphrase: encryptedKeyFixture('ed25519Ctr').passphrase,
  });
  assert.equal(parsed.keyPassphrase, encryptedKeyFixture('ed25519Ctr').passphrase);
});

test('parseConnectMessage 拒绝口令认证下夹带私钥口令', () => {
  assert.throws(() => parseConnectMessage({
    type: 'connect', host: 'host.example.com', port: 22, username: 'root',
    authMethod: 'password', password: 'pw', keyPassphrase: 'anything',
  }), /requires public-key authentication/);
});

test('私钥段填充长度在 1~16 之间变化时都能正确解析', async (context) => {
  if (!hasSshKeygen()) return context.skip(MISSING_SSH_KEYGEN);
  // 回归防线：填充长度曾被写死为不超过 7（块大小按 8 算），而 AES 加密密钥的块大小是 16，
  // 于是填充为 8~16 字节的私钥被误判成格式损坏——多数 RSA 私钥正落在这个区间。
  // 注释长度每多一个字节，私钥段长度就 +1、填充长度就 -1，因此遍历注释长度即可
  // 确定性地覆盖全部填充取值，不依赖运气。
  for (let extra = 0; extra < 16; extra++) {
    const { pem, passphrase, fingerprint } = generateEncryptedKey('ed25519Ctr', 'x'.repeat(extra));
    const info = await SSHAuth.publicKeyInfo(pem, passphrase);
    assert.equal(info.fingerprint, fingerprint, `注释长度 ${extra} 时解析结果不符`);
  }
});

test('parseConnectMessage 校验私钥口令长度上限', (context) => {
  if (!hasSshKeygen()) return context.skip(MISSING_SSH_KEYGEN);
  assert.throws(() => parseConnectMessage({
    type: 'connect', host: 'host.example.com', port: 22, username: 'root',
    authMethod: 'publickey', privateKey: encryptedKeyFixture('ed25519Ctr').pem, keyPassphrase: 'x'.repeat(1025),
  }), /Invalid private key passphrase/);
});
