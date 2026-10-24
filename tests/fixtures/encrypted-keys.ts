/**
 * 运行时生成「带口令的 OpenSSH 私钥」测试夹具。
 *
 * 为什么不把私钥固化成仓库里的文件：那等于向版本库提交一份私钥（哪怕只是一次性的），
 * 既会触发 secret scanning，也容易被后来者误当成真实凭据。这里改为每次运行时用 OpenSSH
 * 自带的 ssh-keygen 现场生成一把用完即弃的密钥——口令随机生成，私钥只留在内存里，
 * 生成用的临时目录用完立即删除。
 *
 * 环境没有 ssh-keygen 时，用例会 skip 并写明原因——宁可不跑，也不能让安全检查变成空转。
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface GeneratedKey { label: string; pem: string; passphrase: string; fingerprint: string }

/**
 * 覆盖各种组合：ctr（OpenSSH 默认）与 cbc 两种模式，以及 RSA/Ed25519/ECDSA 三种密钥类型。
 * 之所以覆盖多种长度：私钥段末尾填充的长度取决于内容长度，RSA 与 Ed25519 恰好落在不同的
 * 填充区间，只测一种会漏掉「填充超过某个长度就解析失败」这类缺陷。
 */
export const KEY_VARIANTS = {
  rsaCtr: { label: 'RSA-2048 · aes256-ctr', args: ['-t', 'rsa', '-b', '2048', '-Z', 'aes256-ctr'] },
  rsaCbc: { label: 'RSA-2048 · aes256-cbc', args: ['-t', 'rsa', '-b', '2048', '-Z', 'aes256-cbc'] },
  ed25519Ctr: { label: 'ED25519 · aes256-ctr', args: ['-t', 'ed25519', '-Z', 'aes256-ctr'] },
  ecdsaCtr: { label: 'ECDSA-256 · aes256-ctr', args: ['-t', 'ecdsa', '-b', '256', '-Z', 'aes256-ctr'] },
} as const;

export type KeyVariant = keyof typeof KEY_VARIANTS;

export const MISSING_SSH_KEYGEN = '环境缺少 ssh-keygen，无法现生成加密私钥';

export function hasSshKeygen(): boolean {
  try { execFileSync('ssh-keygen', ['-?'], { stdio: 'ignore' }); return true; }
  // 只有「找不到命令」才算没有；退出码非 0（打印用法、本机不支持某 cipher）不影响可用性本身。
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
}

/**
 * @param comment 可选注释。注释长度会改变私钥段长度、进而改变末尾填充长度，
 *   测试正是靠它确定性地覆盖 1~16 各种填充。
 */
export function generateEncryptedKey(variant: KeyVariant, comment?: string): GeneratedKey {
  const { label, args } = KEY_VARIANTS[variant];
  // 口令随机，避免任何形式的复用；execFileSync 不走 shell，特殊字符也不会被解释。
  const passphrase = randomBytes(12).toString('base64');
  const directory = mkdtempSync(join(tmpdir(), 'edgessh-test-key-'));
  const file = join(directory, 'id');
  try {
    const command = [...args, ...(comment === undefined ? [] : ['-C', comment]), '-N', passphrase, '-f', file, '-q'];
    execFileSync('ssh-keygen', command, { stdio: 'ignore' });
    const pem = readFileSync(file, 'utf8').trim();
    if (!pem.includes('BEGIN OPENSSH PRIVATE KEY')) throw new Error(`ssh-keygen 未产出私钥：${label}`);
    // 指纹由工具给出，不依赖被测实现自证。
    const output = execFileSync('ssh-keygen', ['-l', '-f', `${file}.pub`], { encoding: 'utf8' });
    const fingerprint = /SHA256:[A-Za-z0-9+/]+/.exec(output)?.[0];
    if (!fingerprint) throw new Error(`ssh-keygen -l 未给出指纹：${output.trim()}`);
    return { label, pem, passphrase, fingerprint };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const cache = new Map<string, GeneratedKey>();

/** 同一 variant 只生成一次：多个用例共用同一把一次性强密钥，节省密钥生成开销。 */
export function encryptedKeyFixture(variant: KeyVariant): GeneratedKey {
  const cached = cache.get(variant);
  if (cached) return cached;
  const generated = generateEncryptedKey(variant);
  cache.set(variant, generated);
  return generated;
}
