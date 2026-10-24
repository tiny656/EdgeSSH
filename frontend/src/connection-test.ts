import { api } from './cloud-api';

export interface TestConnectionInput {
  host: string;
  port: number;
  username: string;
  authMethod: 'password' | 'publickey';
  password?: string;
  privateKey?: string;
  keychainId?: string;
  keyPassphrase?: string;
  fingerprint?: string;
}

export interface TestConnectionResult {
  ok: boolean;
  message: string;
  fingerprint?: string;
}

interface ServerMessage {
  type?: string;
  message?: string;
  fingerprint?: string;
  trusted?: boolean;
  expectedFingerprint?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Worker 侧下发的失败原因都是英文原始错误信息，这里给出可读的中文映射，
 * 无法识别时回落到原始报文，避免丢失排查线索。
 */
function describeFailure(message: ServerMessage): string {
  const raw = message.message ?? '';
  const lower = raw.toLowerCase();
  if (lower.includes('authentication failed')) {
    return '认证失败：请检查用户名、凭据，以及服务器是否启用了对应的认证方式。';
  }
  if (lower.includes('host key mismatch') || lower.includes('host key changed') || lower.includes('fingerprint')) {
    return '主机指纹不匹配：请核对服务器指纹与高级设置里的主机指纹。';
  }
  if (lower.includes('enotfound') || lower.includes('dns') || lower.includes('getaddrinfo')) {
    return '主机地址无法解析：请检查域名或 IP 是否正确。';
  }
  if (lower.includes('econnrefused') || lower.includes('connection refused')) {
    return '连接被拒绝：目标端口未开放或服务未运行。';
  }
  if (lower.includes('timed out') || lower.includes('timeout') || lower.includes('etimedout')) {
    return '连接超时：目标主机不可达，请检查防火墙与安全组。';
  }
  if (lower.includes('incorrect private key passphrase') || lower.includes('bad password')) {
    return '私钥口令不正确：请检查「私钥口令」是否填写无误。';
  }
  if (lower.includes('private key') || lower.includes('unsupported')) {
    return `凭据格式不正确：${raw}`;
  }
  if (lower.includes('keychain') || lower.includes('密钥')) {
    return `密钥链读取失败：${raw}`;
  }
  return raw ? `连接失败：${raw}` : '连接失败，请检查主机信息与凭据后重试。';
}

/**
 * 保存前的连通性探测，与“加密保存”完全解耦：不写入 D1、不写入本地历史，
 * 只用一次性的会话票据走标准 /api/ssh 握手。
 *
 * 关键点：connect 报文带 mode:'forward'，服务端在收到 USERAUTH_SUCCESS 后
 * 直接下发 { type:'ready' } 并跳过 pty/shell 请求（见 session.ts 的
 * SSH_MSG_USERAUTH_SUCCESS 分支），因此测试不会在服务器上开启终端会话，
 * 仅留下一次登录审计记录。
 */
export async function testConnection(
  input: TestConnectionInput,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<TestConnectionResult> {
  if (location.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
    return { ok: false, message: '发送 SSH 凭据前必须使用 HTTPS。' };
  }

  const ticket = await api<{ ticket: string; sessionId: string }>('/api/session', 'POST', {});
  const url = new URL('/api/ssh', location.origin);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('ticket', ticket.ticket);
  url.searchParams.set('session', ticket.sessionId);

  const config: Record<string, unknown> = {
    type: 'connect',
    mode: 'forward',
    host: input.host,
    port: input.port,
    username: input.username,
    authMethod: input.authMethod,
  };
  if (input.authMethod === 'password') config.password = input.password ?? '';
  else if (input.keychainId) config.keychainId = input.keychainId;
  else config.privateKey = input.privateKey ?? '';
  if (input.authMethod === 'publickey' && input.keyPassphrase) config.keyPassphrase = input.keyPassphrase;
  if (input.fingerprint) config.expectedFingerprint = input.fingerprint;

  return await new Promise<TestConnectionResult>((resolve) => {
    const socket = new WebSocket(url);
    let settled = false;
    let serverFingerprint: string | undefined;

    const finish = (result: TestConnectionResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(1000, 'Connection test finished'); } catch { /* already closed */ }
      resolve(result);
    };

    const timer = setTimeout(
      () => finish({ ok: false, message: `连接测试超时（${Math.round(timeoutMs / 1000)} 秒），请检查网络可达性与防火墙设置。` }),
      timeoutMs,
    );

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify(config));
    });

    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      let message: ServerMessage;
      try { message = JSON.parse(event.data) as ServerMessage; } catch { return; }

      if (message.type === 'host_key') {
        serverFingerprint = message.fingerprint;
        if (input.fingerprint && message.fingerprint !== input.fingerprint) {
          finish({ ok: false, message: '主机指纹不匹配：请核对服务器指纹与高级设置里的主机指纹。', fingerprint: serverFingerprint });
          return;
        }
        // 测试只是核对，不会真正落下 shell；这里接受指纹以便握手继续，
        // 并把真实指纹带回给调用方展示。
        if (message.trusted === false && message.fingerprint) {
          socket.send(JSON.stringify({ type: 'host_key_decision', accept: true, fingerprint: message.fingerprint }));
        }
        return;
      }
      if (message.type === 'ready') {
        finish({
          ok: true,
          message: serverFingerprint && !input.fingerprint ? 'SSH 认证成功，请核对下方指纹后保存。' : 'SSH 认证成功，可以保存这台主机。',
          fingerprint: serverFingerprint,
        });
        return;
      }
      if (message.type === 'error') {
        finish({ ok: false, message: describeFailure(message), fingerprint: serverFingerprint });
      }
    });

    socket.addEventListener('close', (event) => {
      finish({ ok: false, message: `SSH 连接在认证完成前被关闭（代码 ${event.code}），请重试。` });
    });

    socket.addEventListener('error', () => {
      finish({ ok: false, message: 'WebSocket 连接失败，请检查 Worker 部署与登录状态。' });
    });
  });
}
