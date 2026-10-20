import { concat, encodeString, encodeUint32 } from '../ssh/utils.ts';

export async function generatePrivateKey(): Promise<string> {
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const seed = Uint8Array.from(atob(jwk.d!.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));
  const blob = concat(encodeString('ssh-ed25519'), encodeString(publicKey));
  const check = crypto.getRandomValues(new Uint8Array(4));
  const body = concat(check, check, encodeString('ssh-ed25519'), encodeString(publicKey),
    encodeString(concat(seed, publicKey)), encodeString('EdgeSSH'));
  // OpenSSH 未加密块按 8 字节对齐，标准递增填充可被 ssh-keygen 与现有解析器共同读取。
  const padding = Uint8Array.from({ length: 8 - body.length % 8 }, (_, index) => index + 1);
  const raw = concat(new TextEncoder().encode('openssh-key-v1\0'), encodeString('none'), encodeString('none'),
    encodeString(''), encodeUint32(1), encodeString(blob), encodeString(concat(body, padding)));
  seed.fill(0);
  const base64 = btoa(String.fromCharCode(...raw));
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${base64.match(/.{1,70}/g)!.join('\n')}\n-----END OPENSSH PRIVATE KEY-----`;
}
