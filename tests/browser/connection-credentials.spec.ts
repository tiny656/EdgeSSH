import { test, expect, type Page } from '@playwright/test';

const keyId = '00000000-0000-4000-8000-000000000099';
const privateKey = '-----BEGIN OPENSSH PRIVATE KEY-----\ntest-only-encrypted-key\n-----END OPENSSH PRIVATE KEY-----';
const passphrase = 'test-only-host-passphrase';
const fingerprint = `SHA256:${'A'.repeat(43)}`;
const changedFingerprint = `SHA256:${'B'.repeat(43)}`;
type Credentials = { privateKey?: string; keychainId?: string; keyPassphrase?: string };

async function fixture(page: Page, credentials: Credentials = { keychainId: keyId, keyPassphrase: passphrase },
  result: 'ready' | 'changed-key' | 'closed' = 'ready') {
  const host = {
    id: 'alpha', name: 'Tokyo production', host: '192.0.2.10', port: 22, username: 'deploy',
    group: '测试主机', authMethod: 'publickey', keychainId: credentials.keychainId,
    initialCommand: '', termType: 'xterm-256color', encoding: 'utf-8',
    fingerprint: result === 'changed-key' ? fingerprint : '',
    location: null, system: null, hasCredential: true, updatedAt: 1,
  };
  const connections: any[] = [];
  const decisions: any[] = [];
  const writes: any[] = [];
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === '/api/auth/me') return route.fulfill({ json: { account: { username: 'Administrator' }, provider: 'cloudflare' } });
    if (path === '/api/hosts' && method === 'GET') return route.fulfill({ json: { hosts: [host] } });
    if (path.endsWith('/credentials')) return route.fulfill({ json: credentials });
    if (path.startsWith('/api/hosts') && (method === 'POST' || method === 'PUT')) {
      writes.push(route.request().postDataJSON());
      return route.fulfill({ json: { host } });
    }
    if (path === '/api/keychain') return route.fulfill({ json: { keys: [{ id: keyId, name: 'Saved key', publicKey: '', fingerprint, updatedAt: 1 }] } });
    if (path === '/api/session') return route.fulfill({ json: { ticket: 'test-ticket', sessionId: crypto.randomUUID() } });
    if (path === '/api/snippets') return route.fulfill({ json: { snippets: [] } });
    if (path === '/api/forwarding') return route.fulfill({ json: { available: false, trustedAvailable: true } });
    if (path === '/api/forward-rules') return route.fulfill({ json: { rules: [] } });
    return route.fulfill({ json: {} });
  });
  await page.routeWebSocket('**/api/ssh?*', (ws) => {
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'connect') {
        connections.push(message);
        if (result === 'closed') { void ws.close({ code: 1000 }); return; }
        if (result === 'changed-key') {
          ws.send(JSON.stringify({ type: 'host_key', trusted: false, fingerprint: changedFingerprint, expectedFingerprint: fingerprint }));
        } else ws.send(JSON.stringify({ type: 'ready' }));
      } else if (message.type === 'host_key_decision') {
        decisions.push(message);
        if (message.accept) ws.send(JSON.stringify({ type: 'ready' }));
      }
    });
  });
  await page.goto('/');
  await expect(page.locator('#host-list')).toContainText(host.name);
  return { connections, decisions, writes };
}

test('从密钥链切换到填写私钥后，测试与保存使用同一份新凭据', async ({ page }) => {
  const f = await fixture(page);
  await page.getByRole('button', { name: '编辑 Tokyo production' }).click();
  const dialog = page.getByRole('dialog', { name: '编辑主机', exact: true });
  await dialog.locator('[name="authMethod"]').selectOption('publickey');
  await dialog.locator('[name="privateKey"]').fill(privateKey);
  await dialog.locator('[name="keyPassphrase"]').fill('replacement-passphrase');
  await dialog.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(dialog.locator('#host-form-error')).toContainText('SSH 认证成功');
  expect(f.connections[0]).toMatchObject({ privateKey, keyPassphrase: 'replacement-passphrase' });
  expect(f.connections[0].keychainId).toBeUndefined();
  await dialog.getByRole('button', { name: '加密保存', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(f.writes[0]).toMatchObject({ privateKey, keyPassphrase: 'replacement-passphrase' });
  expect(f.writes[0].keychainId).toBeUndefined();
});

for (const credential of [{ privateKey }, { keychainId: keyId }]) {
  test(`编辑${credential.keychainId ? '密钥链' : '直接私钥'}主机时，留空测试沿用已保存的口令`, async ({ page }) => {
    const f = await fixture(page, { ...credential, keyPassphrase: passphrase });
    await page.getByRole('button', { name: '编辑 Tokyo production' }).click();
    const dialog = page.getByRole('dialog', { name: '编辑主机', exact: true });
    await dialog.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(dialog.locator('#host-form-error')).toContainText('SSH 认证成功');
    expect(f.connections[0]).toMatchObject({ ...credential, keyPassphrase: passphrase });
    expect(f.writes).toHaveLength(0);
  });
}

test('快速连接成功后保存私钥口令，改用无口令私钥时明确清除旧口令', async ({ page }) => {
  const f = await fixture(page);
  await page.locator('#quick-connect').click();
  await page.locator('#host').fill('192.0.2.20');
  await page.getByRole('radio', { name: '上传私钥', exact: true }).check();
  await page.locator('#private-key').fill(privateKey);
  await page.locator('#key-passphrase').fill(passphrase);
  await page.locator('#connect-button').click();
  await expect.poll(() => f.writes.length).toBe(1);
  expect(f.connections[0]).toMatchObject({ privateKey, keyPassphrase: passphrase });
  expect(f.writes[0]).toMatchObject({ privateKey, keyPassphrase: passphrase });

  await page.locator('#panel-toggle').click();
  await page.locator('#connect-button').click();
  await expect(page.locator('#connect-button')).toHaveAttribute('data-action', 'connect');
  await page.locator('#private-key').fill(privateKey.replace('encrypted-key', 'unencrypted-key'));
  await page.locator('#key-passphrase').fill('');
  await page.locator('#connect-button').click();
  await expect.poll(() => f.writes.length).toBe(2);
  expect(f.writes[1].keyPassphrase).toBe('');
});

test('连接测试拒绝与填写指纹不符的主机，不继续认证', async ({ page }) => {
  const f = await fixture(page, { keychainId: keyId }, 'changed-key');
  await page.getByRole('button', { name: '编辑 Tokyo production' }).click();
  const dialog = page.getByRole('dialog', { name: '编辑主机', exact: true });
  await dialog.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(dialog.locator('#host-form-error')).toContainText('指纹不匹配');
  expect(f.connections[0].expectedFingerprint).toBe(fingerprint);
  expect(f.decisions.some((message) => message.accept)).toBe(false);
});

test('连接测试在认证前正常关闭时立即报告失败并恢复按钮', async ({ page }) => {
  await fixture(page, { keychainId: keyId }, 'closed');
  await page.getByRole('button', { name: '编辑 Tokyo production' }).click();
  const dialog = page.getByRole('dialog', { name: '编辑主机', exact: true });
  await dialog.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(dialog.locator('#host-form-error')).toContainText('认证完成前被关闭');
  await expect(dialog.getByRole('button', { name: '测试连接', exact: true })).toBeEnabled();
});
