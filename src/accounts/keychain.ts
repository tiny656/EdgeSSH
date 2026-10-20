import type { Env } from '../types.ts';
import { SSHAuth } from '../ssh/auth';
import { decryptHost, encryptHost } from './crypto.ts';
import { generatePrivateKey } from './key-generation.ts';
import { APIError, json, readJSON } from './http.ts';

interface KeyPayload { name: string; publicKey: string; privateKey: string; fingerprint: string }
interface KeyRow { id: string; encrypted_payload: string; updated_at: number }

export async function readKeychainKey(env: Env, accountId: string, id: string): Promise<KeyPayload> {
  const row = await env.DB.prepare('SELECT encrypted_payload FROM keychain WHERE id = ? AND account_id = ?')
    .bind(id, accountId).first<KeyRow>();
  if (!row) throw new APIError('密钥不存在，请重新选择密钥链。', 404);
  return decryptHost<KeyPayload>(row.encrypted_payload, env.ENCRYPTION_KEY, accountId, `keychain:${id}`);
}

function metadata(id: string, payload: KeyPayload, updatedAt: number) {
  const { privateKey, ...safe } = payload;
  return { ...safe, id, updatedAt };
}

export async function keychainRoute(request: Request, env: Env, accountId: string, pathname: string): Promise<Response> {
  if (pathname === '/api/keychain/generate') {
    if (request.method !== 'POST') throw new APIError('不支持此请求方法。', 405);
    const body = await readJSON(request, 1024);
    if (Object.keys(body).length) throw new APIError('生成密钥的请求必须为空对象。');
    const privateKey = await generatePrivateKey();
    // 生成只填入编辑器，用户确认保存前不写数据库。
    return json({ privateKey, ...await SSHAuth.publicKeyInfo(privateKey) });
  }
  const match = /^\/api\/keychain(?:\/([a-f0-9-]{36})(?:\/(private-key))?)?$/.exec(pathname);
  if (!match) throw new APIError('接口不存在。', 404);
  const [, id, action] = match;
  if (!id && request.method === 'GET') {
    const rows = await env.DB.prepare('SELECT id, encrypted_payload, updated_at FROM keychain WHERE account_id = ? ORDER BY updated_at DESC, id')
      .bind(accountId).all<KeyRow>();
    return json({ keys: await Promise.all(rows.results.map(async (row) => metadata(row.id,
      await decryptHost<KeyPayload>(row.encrypted_payload, env.ENCRYPTION_KEY, accountId, `keychain:${row.id}`), row.updated_at))) });
  }
  const previous = id ? await readKeychainKey(env, accountId, id) : undefined;
  // 私钥只在用户明确导出时返回；列表、保存响应和主机凭据接口均只提供引用。
  if (action === 'private-key' && request.method === 'POST') return json({ privateKey: previous!.privateKey });
  if (action) throw new APIError('不支持此请求方法。', 405);
  if (id && request.method === 'DELETE') {
    const hosts = await env.DB.prepare('SELECT id, encrypted_payload FROM hosts WHERE account_id = ?').bind(accountId).all<KeyRow>();
    const references = await Promise.all(hosts.results.map((host) =>
      decryptHost<{ keychainId?: string }>(host.encrypted_payload, env.ENCRYPTION_KEY, accountId, host.id)));
    if (references.some((host) => host.keychainId === id)) throw new APIError('此密钥仍被主机使用，请先修改或删除关联主机。', 409);
    await env.DB.prepare('DELETE FROM keychain WHERE id = ? AND account_id = ?').bind(id, accountId).run();
    return json({ ok: true });
  }
  if (id ? request.method !== 'PUT' : request.method !== 'POST') throw new APIError('不支持此请求方法。', 405);
  const body = await readJSON(request);
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 80 || /[\x00-\x1f\x7f]/.test(body.name)) throw new APIError('密钥名称不能为空，且不能超过 80 个字符或包含控制字符。');
  if (body.generate !== undefined && (body.generate !== true || id || body.privateKey || body.publicKey)) throw new APIError('生成密钥的请求无效。');
  const privateKey = body.generate ? await generatePrivateKey() : body.privateKey ?? previous?.privateKey;
  if (typeof privateKey !== 'string' || !privateKey.trim() || privateKey.length > 65536) throw new APIError('请填写不超过 64 KiB 的未加密 OpenSSH 私钥。');
  let info;
  try { info = await SSHAuth.publicKeyInfo(privateKey); }
  catch { throw new APIError('私钥无效，仅支持未设口令的 OpenSSH Ed25519、RSA 或 ECDSA 私钥。'); }
  if (body.publicKey !== undefined && typeof body.publicKey !== 'string') throw new APIError('公钥格式无效。');
  const suppliedPublicKey = typeof body.publicKey === 'string' ? body.publicKey.trim() : '';
  if (suppliedPublicKey.length > 16384 || /[\x00-\x1f\x7f]/.test(suppliedPublicKey) || (suppliedPublicKey && suppliedPublicKey.split(/\s+/).slice(0, 2).join(' ') !== info.publicKey)) {
    throw new APIError('公钥与私钥不匹配。留空可从私钥自动提取公钥。');
  }
  const payload: KeyPayload = { name: body.name.trim(), privateKey: privateKey.trim(), ...info,
    publicKey: suppliedPublicKey || info.publicKey };
  const keyId = id ?? crypto.randomUUID();
  const encrypted = await encryptHost(payload, env.ENCRYPTION_KEY, accountId, `keychain:${keyId}`);
  const now = Date.now();
  const result = id
    ? await env.DB.prepare('UPDATE keychain SET encrypted_payload = ?, updated_at = ? WHERE id = ? AND account_id = ?').bind(encrypted, now, id, accountId).run()
    : await env.DB.prepare(`INSERT INTO keychain(id, account_id, encrypted_payload, updated_at)
      SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM keychain WHERE account_id = ?) < 100`).bind(keyId, accountId, encrypted, now, accountId).run();
  if (!result.meta.changes) throw new APIError(id ? '密钥不存在，请刷新列表。' : '最多保存 100 个密钥。', id ? 404 : 409);
  return json({ key: metadata(keyId, payload, now) }, id ? 200 : 201);
}
