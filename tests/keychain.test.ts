import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { decryptHost, encryptHost } from '../src/accounts/crypto.ts';
import { MISSING_SSH_KEYGEN, encryptedKeyFixture, hasSshKeygen } from './fixtures/encrypted-keys.ts';

const bundle = await build({
  stdin: { contents: `export * from './src/accounts/keychain.ts'; export * from './src/accounts/hosts.ts';
    export * from './src/accounts/key-generation.ts'; export * from './src/types.ts';
    export * from './src/ssh/auth.ts'; export * from './src/backend/durable-object.ts'; export * from './src/backend/session.ts';`,
  resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' },
  plugins: [{ name: 'no-real-sockets', setup(build) {
    build.onResolve({ filter: /^cloudflare:sockets$/ }, () => ({ path: 'sockets', namespace: 'test' }));
    build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export function connect() { throw Error("Real sockets forbidden"); }' }));
  } }], bundle: true, format: 'esm', platform: 'neutral', write: false,
});
const { keychainRoute, readKeychainKey, generatePrivateKey, hostsRoute, parseConnectMessage, SSHAuth, SSHSessionDO, SSHSession } =
  await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of ['0001_accounts.sql', '0005_keychain.sql', '0005_keychain.sql']) sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  const prepare = (sql: string) => {
    let params: any[] = [];
    const query = sqlite.prepare(sql);
    const statement = {
      bind(...values: any[]) { params = values; return statement; },
      async first() { return query.get(...params) ?? null; },
      async all() { return { results: query.all(...params) }; },
      async run() { return { meta: { changes: Number(query.run(...params).changes) } }; },
    };
    return statement;
  };
  const keyInfoCalls: { objectId: string; accountId: string | null }[] = [];
  const env = {
    ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'), DB: { prepare },
    SSH_SESSIONS: {
      idFromName(name: string) { return name; },
      get(objectId: string) {
        return { async fetch(request: Request): Promise<Response> {
          keyInfoCalls.push({ objectId, accountId: request.headers.get('x-account-id') });
          const object = new SSHSessionDO({ getWebSockets: () => [] }, env);
          return object.fetch(request);
        } };
      },
    },
  };
  const request = async (method = 'GET', id = '', body?: unknown, owner = 'owner') => {
    const path = `/api/keychain${id ? `/${id}` : ''}`;
    return keychainRoute(new Request(`https://example.com${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    }), env, owner, path);
  };
  const create = async () => (await (await request('POST', '', { name: '测试密钥', generate: true })).json()).key;
  return { sqlite, env, request, create, keyInfoCalls };
}

test('生成 OpenSSH Ed25519 私钥可被现有认证器解析并签名', async () => {
  const privateKey = await generatePrivateKey();
  const info = await SSHAuth.publicKeyInfo(privateKey);
  assert.match(info.publicKey, /^ssh-ed25519 [A-Za-z0-9+/=]+$/);
  assert.match(info.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
  const sessionId = crypto.getRandomValues(new Uint8Array(32));
  const packet = await SSHAuth.buildPublicKeyAuthRequest('root', privateKey, sessionId);
  const publicBlob = Buffer.from(info.publicKey.split(' ')[1], 'base64');
  const publicKey = await crypto.subtle.importKey('raw', publicBlob.subarray(-32), 'Ed25519', false, ['verify']);
  const signatureLength = 4 + 4 + 'ssh-ed25519'.length + 4 + 64;
  const sessionPrefix = Buffer.alloc(4); sessionPrefix.writeUInt32BE(sessionId.length);
  const data = Buffer.concat([sessionPrefix, sessionId, packet.subarray(0, -signatureLength)]);
  assert.equal(await crypto.subtle.verify('Ed25519', publicKey, packet.subarray(-64), data), true);
  assert.notEqual(await generatePrivateKey(), privateKey);
});

test('真实 workerd 支持 Ed25519 生成、OpenSSH 认证和密文往返', async () => {
  const result = await build({ stdin: { contents: `
    import { generatePrivateKey } from './src/accounts/key-generation.ts';
    import { SSHAuth } from './src/ssh/auth.ts';
    import { encryptHost, decryptHost } from './src/accounts/crypto.ts';
    export default { async fetch() {
      const privateKey = await generatePrivateKey();
      const info = await SSHAuth.publicKeyInfo(privateKey);
      const secret = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
      const encrypted = await encryptHost({ privateKey }, secret, 'owner', 'keychain:test');
      const decoded = await decryptHost(encrypted, secret, 'owner', 'keychain:test');
      const packet = await SSHAuth.buildPublicKeyAuthRequest('root', decoded.privateKey, new Uint8Array(32));
      return Response.json({ ...info, roundtrip: decoded.privateKey === privateKey, signed: packet.length > 100 });
    } };`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, format: 'esm', platform: 'neutral', write: false });
  const mf = new Miniflare({ workers: [{ config: {
    type: 'worker', name: 'keychain-test', compatibilityDate: '2026-07-01',
    manifest: { mainModule: 'worker.js', modulesRoot: process.cwd(), modules: { 'worker.js': { type: 'esm', contents: result.outputFiles[0].text } } },
  } }] });
  try {
    const response = await mf.dispatchFetch('https://test.example');
    assert.equal(response.status, 200);
    const data = await response.json() as any;
    assert.equal(data.roundtrip, true); assert.equal(data.signed, true);
    assert.match(data.publicKey, /^ssh-ed25519 /); assert.match(data.fingerprint, /^SHA256:/);
  } finally { await mf.dispose(); }
});

test('单独生成匹配的公私钥但不保存，确认后可加密入库', async (context) => {
  const f = fixture(); context.after(() => f.sqlite.close());
  const response = await f.request('POST', 'generate', {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const pair = await response.json();
  assert.match(pair.privateKey, /BEGIN OPENSSH PRIVATE KEY/);
  assert.deepEqual(await SSHAuth.publicKeyInfo(pair.privateKey), { publicKey: pair.publicKey, fingerprint: pair.fingerprint });
  assert.deepEqual(await (await f.request()).json(), { keys: [] });
  const saved = await (await f.request('POST', '', { name: '确认保存', privateKey: pair.privateKey, publicKey: pair.publicKey })).json();
  assert.equal(saved.key.privateKey, undefined);
  assert.equal((await readKeychainKey(f.env, 'owner', saved.key.id)).privateKey, pair.privateKey);
  await assert.rejects(f.request('GET', 'generate'), /不支持/);
  await assert.rejects(f.request('POST', 'generate', { name: '不需要名称' }), /空对象/);
});

test('密钥链生成、导出、保留私钥编辑、加密与账户隔离', async (context) => {
  const f = fixture(); context.after(() => f.sqlite.close());
  const key = await f.create();
  assert.equal(key.privateKey, undefined);
  const payload = await readKeychainKey(f.env, 'owner', key.id);
  assert.match(payload.privateKey, /BEGIN OPENSSH PRIVATE KEY/);
  const encrypted = f.sqlite.prepare('SELECT encrypted_payload FROM keychain WHERE id = ?').get(key.id)!.encrypted_payload as string;
  assert.equal(encrypted.includes('OPENSSH'), false);
  assert.equal(encrypted.includes(key.name), false);
  await assert.rejects(decryptHost(encrypted, f.env.ENCRYPTION_KEY, 'owner', key.id));
  await assert.rejects(readKeychainKey(f.env, 'other', key.id), /不存在/);
  for (const method of ['PUT', 'DELETE', 'POST']) await assert.rejects(f.request(method, `${key.id}${method === 'POST' ? '/private-key' : ''}`, { name: 'x' }, 'other'), /不存在/);
  assert.deepEqual(await (await f.request('GET', '', undefined, 'other')).json(), { keys: [] });
  assert.equal((await (await f.request('POST', `${key.id}/private-key`)).json()).privateKey, payload.privateKey);
  await f.request('PUT', key.id, { name: '重命名', publicKey: key.publicKey });
  assert.equal((await readKeychainKey(f.env, 'owner', key.id)).privateKey, payload.privateKey);
  const listed = await (await f.request()).json();
  assert.equal(listed.keys[0].name, '重命名'); assert.equal(listed.keys[0].privateKey, undefined);
  await f.request('DELETE', key.id);
  assert.deepEqual(await (await f.request()).json(), { keys: [] });
});

test('导入校验私钥与公钥的一致性并支持自动提取', async (context) => {
  const f = fixture(); context.after(() => f.sqlite.close());
  const privateKey = await generatePrivateKey();
  const info = await SSHAuth.publicKeyInfo(privateKey);
  const imported = await (await f.request('POST', '', { name: '导入', privateKey, publicKey: info.publicKey + ' user@host' })).json();
  assert.equal(imported.key.publicKey, info.publicKey + ' user@host');
  assert.equal((await (await f.request('POST', '', { name: '自动', privateKey })).json()).key.publicKey, info.publicKey);
  const other = await SSHAuth.publicKeyInfo(await generatePrivateKey());
  for (const body of [
    { name: '', privateKey }, { name: 'x', privateKey: 'invalid' }, { name: 'x', privateKey: 'x'.repeat(65537) },
    { name: 'x', privateKey, publicKey: other.publicKey }, { name: 'x', privateKey, publicKey: `${info.publicKey}\n${other.publicKey}` },
    { name: 'x', generate: true, privateKey }, { name: 'x', privateKey, publicKey: 123 },
  ]) await assert.rejects(f.request('POST', '', body));
});

test('密钥链配额在 SQL 中执行，已有密钥可继续编辑', async (context) => {
  const f = fixture(); context.after(() => f.sqlite.close());
  const key = await f.create();
  const encrypted = f.sqlite.prepare('SELECT encrypted_payload FROM keychain LIMIT 1').get()!.encrypted_payload;
  for (let i = 1; i < 100; i++) f.sqlite.prepare('INSERT INTO keychain VALUES (?, ?, ?, ?)').run(crypto.randomUUID(), 'owner', encrypted, i);
  await assert.rejects(f.request('POST', '', { name: '超额', generate: true }), /最多/);
  assert.equal((await f.request('PUT', key.id, { name: '仍可编辑' })).status, 200);
});

test('连接报文允许密钥引用但拒绝混合凭据', () => {
  const input = { type: 'connect', host: '8.8.8.8', port: 22, username: 'root', authMethod: 'publickey', keychainId: crypto.randomUUID() };
  assert.equal(parseConnectMessage(input).keychainId, input.keychainId);
  assert.equal(parseConnectMessage({ ...input, mode: 'forward' }).mode, 'forward');
  for (const bad of [{ privateKey: 'anything' }, { password: '' }, { keychainId: 'bad' }, { authMethod: 'password' }]) assert.throws(() => parseConnectMessage({ ...input, ...bad }));
});

test('主机仅保存密钥引用、凭据接口不泄露私钥，引用中的密钥不可删除', async (context) => {
  const f = fixture(); context.after(() => f.sqlite.close());
  const key = await f.create();
  const id = crypto.randomUUID();
  const old = { name: '主机', group: '个人', host: '8.8.8.8', port: 22, username: 'root', authMethod: 'password', password: 'old', initialCommand: '', termType: 'xterm', encoding: 'utf-8', fingerprint: '', location: { country: 'Test' } };
  f.sqlite.prepare('INSERT INTO hosts VALUES (?, ?, ?, ?)').run(id, 'owner', await encryptHost(old, f.env.ENCRYPTION_KEY, 'owner', id), 1);
  const route = async (method: string, path: string, body?: unknown) => hostsRoute(new Request(`https://example.com${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  }), f.env, 'owner', path);
  const result = await route('PUT', `/api/hosts/${id}`, { ...old, password: undefined, authMethod: 'publickey', keychainId: key.id });
  assert.equal((await result.json()).host.keychainId, key.id);
  assert.deepEqual(await (await route('POST', `/api/hosts/${id}/credentials`)).json(), { keychainId: key.id });
  await route('PUT', `/api/hosts/${id}`, { ...old, password: undefined, authMethod: 'publickey' });
  await assert.rejects(f.request('DELETE', key.id), /仍被主机/);
  await assert.rejects(route('PUT', `/api/hosts/${id}`, { ...old, authMethod: 'publickey', keychainId: crypto.randomUUID() }), /不存在/);
  await route('PUT', `/api/hosts/${id}`, old);
  await f.request('DELETE', key.id);
});

test('主机只对同一凭据保留口令，更换私钥或密钥引用时清除旧口令', async (context) => {
  if (!hasSshKeygen()) return context.skip(MISSING_SSH_KEYGEN);
  const f = fixture(); context.after(() => f.sqlite.close());
  const original = encryptedKeyFixture('ed25519Ctr');
  const replacement = encryptedKeyFixture('ecdsaCtr');
  const importKey = async (name: string, key: typeof original) =>
    (await (await f.request('POST', '', { name, privateKey: key.pem, passphrase: key.passphrase })).json()).key;
  const first = await importKey('原密钥', original);
  const second = await importKey('新密钥', replacement);
  const id = crypto.randomUUID();
  const base = { name: '主机', group: '个人', host: '8.8.8.8', port: 22, username: 'root', authMethod: 'publickey', initialCommand: '', termType: 'xterm', encoding: 'utf-8', fingerprint: '', location: { country: 'Test' } };
  const inline = { privateKey: original.pem, keyPassphrase: original.passphrase };
  const reference = { keychainId: first.id, keyPassphrase: original.passphrase };
  const cases = [
    { label: '保留原私钥', previous: inline, update: {}, expected: original.passphrase },
    { label: '提交同一私钥', previous: inline, update: { privateKey: original.pem }, expected: original.passphrase },
    { label: '更换私钥', previous: inline, update: { privateKey: replacement.pem }, expected: undefined },
    { label: '私钥改为密钥引用', previous: inline, update: { keychainId: second.id }, expected: undefined },
    { label: '保留同一密钥引用', previous: reference, update: { keychainId: first.id }, expected: original.passphrase },
    { label: '更换密钥引用', previous: reference, update: { keychainId: second.id }, expected: undefined },
    { label: '显式清除口令', previous: reference, update: { keychainId: first.id, keyPassphrase: '' }, expected: undefined },
    { label: '更新口令', previous: inline, update: { privateKey: replacement.pem, keyPassphrase: replacement.passphrase }, expected: replacement.passphrase },
  ];
  for (const { label, previous, update, expected } of cases) {
    f.sqlite.prepare('INSERT OR REPLACE INTO hosts VALUES (?, ?, ?, ?)').run(id, 'owner',
      await encryptHost({ ...base, ...previous }, f.env.ENCRYPTION_KEY, 'owner', id), 1);
    const path = `/api/hosts/${id}`;
    await hostsRoute(new Request(`https://example.com${path}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...base, ...update }),
    }), f.env, 'owner', path);
    const response = await hostsRoute(new Request(`https://example.com${path}/credentials`, { method: 'POST' }),
      f.env, 'owner', `${path}/credentials`);
    assert.equal((await response.json()).keyPassphrase, expected, label);
  }
});

test('DO 只按票据工作区解密密钥并交给既有 SSH 会话', async (context) => {
  const f = fixture(); context.after(() => f.sqlite.close());
  const key = await f.create();
  const originalStart = SSHSession.prototype.start;
  const configs: any[] = [];
  SSHSession.prototype.start = async function() { configs.push(this.config); };
  context.after(() => { SSHSession.prototype.start = originalStart; });
  for (const owner of ['owner', 'other']) {
    const state = { getWebSockets: () => [], storage: { get: async () => owner } };
    const object = new SSHSessionDO(state, f.env);
    let connected = false;
    object.openVerifiedAddress = async () => { connected = true; return {}; };
    const messages: any[] = [];
    const ws = { readyState: WebSocket.OPEN, deserializeAttachment: () => ({ role: 'main', phase: 'waiting' }), serializeAttachment: () => {}, send: (message: string) => messages.push(JSON.parse(message)), close: () => {} };
    await object.webSocketMessage(ws, JSON.stringify({ type: 'connect', host: '8.8.8.8', port: 22, username: 'root', authMethod: 'publickey', keychainId: key.id }));
    assert.equal(connected, owner === 'owner');
    if (owner === 'other') {
      assert.match(messages.at(-1).message, /密钥不存在/);
      assert.equal(messages.at(-1).retryable, false);
    }
  }
  assert.equal(configs.length, 1);
  assert.equal(configs[0].privateKey, (await readKeychainKey(f.env, 'owner', key.id)).privateKey);
});

/** 导出走的是 action 路径，fixture 里的 request 助手不带 action，这里自己拼。 */
async function exportKey(env: any, id: string) {
  const path = `/api/keychain/${id}/private-key`;
  const response = await keychainRoute(new Request(`https://example.com${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
  }), env, 'owner', path);
  return await response.json() as any;
}

test('加密私钥经 DO 校验后保存：支持重命名与导出，错误口令保留中文提示', async (context) => {
  const f = fixture(); context.after(() => f.sqlite.close());
  if (!hasSshKeygen()) return context.skip(MISSING_SSH_KEYGEN);
  const { pem, passphrase, fingerprint } = encryptedKeyFixture('ed25519Ctr');
  const created = await f.request('POST', '', { name: '加密密钥', privateKey: pem, passphrase });
  const { key } = await created.json();
  const { id } = key;
  assert.equal(key.fingerprint, fingerprint);
  assert.deepEqual(f.keyInfoCalls, [{ objectId: 'keychain-validation:owner', accountId: 'owner' }]);

  await f.request('PUT', id, { name: '重命名加密密钥' });
  assert.equal(f.keyInfoCalls.length, 2);
  assert.equal((await readKeychainKey(f.env, 'owner', id)).passphrase, passphrase);
  await assert.rejects(f.request('PUT', id, { name: '错误口令', passphrase: 'definitely-wrong' }), /私钥口令不正确/);
  assert.equal(f.keyInfoCalls.length, 3);

  // 列表与保存响应都不能把口令或私钥回给浏览器。
  const list = await (await f.request('GET')).json();
  assert.equal('passphrase' in (list as any).keys[0], false);
  assert.equal(JSON.stringify(list).includes(passphrase), false);
  assert.equal(JSON.stringify(list).includes(pem), false);

  // 导出的加密私钥若没有口令，用户拿到的文件根本无法使用。
  const exported = await exportKey(f.env, id);
  assert.equal(exported.privateKey, pem);
  assert.equal(exported.passphrase, passphrase);
});

test('未加密私钥导出时不带口令字段', async (context) => {
  const f = fixture(); context.after(() => f.sqlite.close());
  const key = await f.create();
  const exported = await exportKey(f.env, key.id);
  assert.match(exported.privateKey, /^-----BEGIN OPENSSH PRIVATE KEY-----/);
  assert.equal('passphrase' in exported, false);
  assert.equal(f.keyInfoCalls.length, 0);
});
