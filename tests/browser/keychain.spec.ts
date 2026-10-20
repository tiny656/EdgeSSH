import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';

const keyId = '00000000-0000-4000-8000-000000000099';
const key = { id: keyId, name: 'Production Ed25519', publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEdgeSSHTestOnly user@host', fingerprint: `SHA256:${'A'.repeat(43)}`, updatedAt: 1792340000000 };
const generated = { privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\ntest-only-generated-key\n-----END OPENSSH PRIVATE KEY-----', publicKey: key.publicKey };
const savedHost = { id: '00000000-0000-4000-8000-000000000001', name: 'Tokyo production', group: '生产环境', host: '192.0.2.10', port: 22, username: 'deploy', authMethod: 'publickey', keychainId: keyId, initialCommand: '', termType: 'xterm-256color', encoding: 'utf-8', fingerprint: '', location: null, system: null, hasCredential: true, updatedAt: 1 };

async function fixture(page: Page, empty = false) {
  let keys = empty ? [] : [key];
  let hosts = [savedHost];
  const writes: Array<{ path: string; method: string; body: any }> = [];
  const connections: any[] = [];
  const sockets: WebSocketRoute[] = [];
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (value: string) => { (window as any).copied = value; } } });
  });
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    const body = route.request().postDataJSON();
    if (method !== 'GET') writes.push({ path, method, body });
    if (path === '/api/auth/me') return route.fulfill({ json: { account: { username: 'Administrator' }, provider: 'cloudflare' } });
    if (path === '/api/keychain' && method === 'GET') return route.fulfill({ json: { keys } });
    if (path === '/api/keychain/generate') return route.fulfill({ json: generated });
    if (path.startsWith('/api/keychain')) {
      if (path.endsWith('/private-key')) return route.fulfill({ json: { privateKey: 'test-only-private-key' } });
      if (method === 'DELETE') { keys = []; return route.fulfill({ json: { ok: true } }); }
      const updated = { ...key, name: body.name }; keys = [updated]; return route.fulfill({ json: { key: updated } });
    }
    if (path.endsWith('/credentials')) return route.fulfill({ json: { keychainId: keyId } });
    if (path === '/api/hosts' && method === 'GET') return route.fulfill({ json: { hosts } });
    if (path.startsWith('/api/hosts') && body) { const host = { ...savedHost, ...body }; hosts = [host]; return route.fulfill({ json: { host } }); }
    if (path === '/api/session') return route.fulfill({ json: { ticket: 'test-ticket', sessionId: crypto.randomUUID() } });
    if (path === '/api/snippets') return route.fulfill({ json: { snippets: [] } });
    if (path === '/api/forwarding') return route.fulfill({ json: { available: false, trustedAvailable: true } });
    if (path === '/api/forward-rules') return route.fulfill({ json: { rules: [] } });
    return route.fulfill({ json: {} });
  });
  await page.routeWebSocket('**/api/ssh?*', (ws) => {
    sockets.push(ws);
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'connect') { connections.push(message); ws.send(JSON.stringify({ type: 'ready' })); }
    });
  });
  await page.goto('/');
  await expect(page.locator('#host-list')).toContainText('Tokyo production');
  return { writes, connections, sockets };
}

test('默认直接导入，生成填入公私钥后单独保存、复制、编辑与删除', async ({ page }, testInfo) => {
  const f = await fixture(page, true);
  await page.locator('#rail-keychain').click();
  await expect(page.locator('.keychain-list')).toHaveText('暂无密钥');
  await page.getByRole('button', { name: '新建密钥', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建密钥', exact: true });
  await dialog.getByLabel('名称', { exact: true }).fill('Production Ed25519');
  await expect(dialog.locator('select')).toHaveCount(0);
  await expect(dialog.locator('[name="privateKey"]')).toBeVisible();
  await expect(dialog.locator('[name="publicKey"]')).toBeVisible();
  await expect(dialog.locator('[name="privateKey"]')).toHaveValue('');
  await dialog.getByRole('button', { name: '生成', exact: true }).click();
  await expect(dialog.locator('[name="privateKey"]')).toHaveValue(generated.privateKey);
  await expect(dialog.locator('[name="publicKey"]')).toHaveValue(generated.publicKey);
  await expect(dialog.getByLabel('名称', { exact: true })).toHaveValue('Production Ed25519');
  expect(f.writes.filter((call) => call.path === '/api/keychain')).toHaveLength(0);
  await expect(page.locator('.keychain-row')).toHaveCount(0);
  await page.screenshot({ path: `deliverables/keychain-generated-${testInfo.project.name}.png`, fullPage: true });
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.keychain-row')).toHaveCount(1);
  expect(f.writes.find((call) => call.path === '/api/keychain')!.body).toEqual({ name: 'Production Ed25519', ...generated });
  await page.getByRole('button', { name: '复制公钥 Production Ed25519' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).copied)).toBe(key.publicKey);
  await page.getByRole('button', { name: '编辑密钥 Production Ed25519' }).click();
  const editor = page.getByRole('dialog', { name: '编辑密钥', exact: true });
  await expect(editor.locator('[name="privateKey"]')).toHaveValue('');
  await editor.getByLabel('名称', { exact: true }).fill('<script>renamed</script>');
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.keychain-row strong')).toHaveText('<script>renamed</script>');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '删除密钥 <script>renamed</script>' }).click();
  await expect(page.locator('.keychain-list')).toHaveText('暂无密钥');
});

test('导入私钥文件与公钥，导出需用户确认', async ({ page }, testInfo) => {
  const f = await fixture(page, true);
  await page.locator('#rail-keychain').click();
  await page.getByRole('button', { name: '新建密钥', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建密钥', exact: true });
  await dialog.getByLabel('名称', { exact: true }).fill(key.name);
  await dialog.locator('[name="file"]').setInputFiles({ name: 'id_ed25519', mimeType: 'text/plain', buffer: Buffer.from('test-only-import-key') });
  await expect(dialog.locator('[name="privateKey"]')).toHaveValue('test-only-import-key');
  await dialog.getByLabel('公钥', { exact: true }).fill(key.publicKey);
  await page.screenshot({ path: `deliverables/keychain-import-${testInfo.project.name}.png`, fullPage: true });
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(f.writes.find((call) => call.path === '/api/keychain')!.body.privateKey).toBe('test-only-import-key');
  page.once('dialog', (dialog) => dialog.accept());
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: `下载私钥 ${key.name}` }).click();
  expect((await downloaded).suggestedFilename()).toBe('Production_Ed25519.key');
});

test('保存错误保持输入，关联删除错误在页面显示', async ({ page }) => {
  await fixture(page);
  await page.route('**/api/keychain', (route) => route.request().method() === 'POST'
    ? route.fulfill({ status: 400, json: { error: '公钥与私钥不匹配。' } }) : route.fallback());
  await page.route(`**/api/keychain/${keyId}`, (route) => route.fulfill({ status: 409, json: { error: '此密钥仍被主机使用，请先修改关联主机。' } }));
  await page.locator('#rail-keychain').click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: `删除密钥 ${key.name}` }).click();
  await expect(page.locator('.keychain-status')).toContainText('仍被主机使用');
  await page.getByRole('button', { name: '新建密钥', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建密钥', exact: true });
  await dialog.getByLabel('名称', { exact: true }).fill('保留输入');
  await dialog.getByLabel('私钥', { exact: true }).fill('test-only-private-key');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('公钥与私钥不匹配。');
  await expect(dialog.getByLabel('名称', { exact: true })).toHaveValue('保留输入');
});

test('超大私钥文件不提交，取消后可正常生成密钥', async ({ page }) => {
  const f = await fixture(page, true);
  await page.locator('#rail-keychain').click();
  await page.getByRole('button', { name: '新建密钥', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建密钥', exact: true });
  await dialog.getByLabel('名称', { exact: true }).fill('oversized');
  await dialog.locator('[name="file"]').setInputFiles({ name: 'large-key', mimeType: 'text/plain', buffer: Buffer.alloc(65537) });
  await expect(dialog.getByRole('alert')).toContainText('64 KiB');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  expect(f.writes.filter((call) => call.path === '/api/keychain')).toHaveLength(0);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '新建密钥', exact: true }).click();
  await dialog.getByLabel('名称', { exact: true }).fill('valid');
  await dialog.getByRole('button', { name: '生成', exact: true }).click();
  await expect(dialog.locator('[name="privateKey"]')).toHaveValue(generated.privateKey);
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.keychain-row strong')).toHaveText('valid');
});

test('生成失败保留草稿，替换已有公私钥需要确认', async ({ page }) => {
  const f = await fixture(page, true);
  await page.locator('#rail-keychain').click();
  await page.getByRole('button', { name: '新建密钥', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建密钥', exact: true });
  await dialog.getByLabel('名称', { exact: true }).fill('草稿');
  await dialog.getByLabel('私钥', { exact: true }).fill('existing-private');
  await dialog.getByLabel('公钥', { exact: true }).fill('existing-public');
  page.once('dialog', (dialog) => dialog.dismiss());
  await dialog.getByRole('button', { name: '生成', exact: true }).click();
  expect(f.writes.filter((call) => call.path.endsWith('/generate'))).toHaveLength(0);
  await page.route('**/api/keychain/generate', (route) => route.fulfill({ status: 503, json: { error: '服务暂时不可用，请稍后重试。' } }));
  page.once('dialog', (dialog) => dialog.accept());
  await dialog.getByRole('button', { name: '生成', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('服务暂时不可用');
  await expect(dialog.getByLabel('私钥', { exact: true })).toHaveValue('existing-private');
  await expect(dialog.getByLabel('公钥', { exact: true })).toHaveValue('existing-public');
  await expect(dialog.getByRole('button', { name: '生成', exact: true })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
  await page.unroute('**/api/keychain/generate');
  page.once('dialog', (dialog) => dialog.accept());
  await dialog.getByRole('button', { name: '生成', exact: true }).click();
  await expect(dialog.getByLabel('私钥', { exact: true })).toHaveValue(generated.privateKey);
  await expect(dialog.getByLabel('公钥', { exact: true })).toHaveValue(generated.publicKey);
  await expect(dialog.getByLabel('名称', { exact: true })).toHaveValue('草稿');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '新建密钥', exact: true }).click();
  await expect(dialog.getByLabel('私钥', { exact: true })).toHaveValue('');
  await expect(dialog.getByLabel('公钥', { exact: true })).toHaveValue('');
});

test('生成期间禁止保存，登录失效后丢弃迟到的密钥', async ({ page }) => {
  await fixture(page, true);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/keychain/generate', async (route) => { await pending; await route.fulfill({ json: generated }); });
  await page.locator('#rail-keychain').click();
  await page.getByRole('button', { name: '新建密钥', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建密钥', exact: true });
  await dialog.getByRole('button', { name: '生成', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await page.evaluate(() => window.dispatchEvent(new Event('auth-required')));
  await expect(dialog).toBeHidden();
  release();
  await expect(page.locator('[data-generate]')).toBeEnabled();
  await expect(page.locator('.keychain-dialog [name="privateKey"]')).toHaveValue('');
  await expect(page.locator('.keychain-dialog [name="publicKey"]')).toHaveValue('');
});

test('主机编辑可从密钥链切换到上传私钥或密码', async ({ page }) => {
  const f = await fixture(page);
  await page.getByRole('button', { name: '编辑 Tokyo production' }).click();
  const dialog = page.getByRole('dialog', { name: '编辑主机', exact: true });
  await expect(dialog.locator('[name="authMethod"]')).toHaveValue('keychain');
  await expect(dialog.locator('[name="keychainId"] option')).toHaveCount(2);
  await dialog.getByRole('button', { name: '加密保存', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(f.writes.at(-1)!.body.keychainId).toBe(keyId);
  expect(f.writes.at(-1)!.body.privateKey).toBeUndefined();
  await page.getByRole('button', { name: '编辑 Tokyo production' }).click();
  await dialog.locator('[name="authMethod"]').selectOption('publickey');
  await dialog.locator('[name="privateKeyFile"]').setInputFiles({ name: 'key', mimeType: 'text/plain', buffer: Buffer.from('test-only-key') });
  await expect(dialog.locator('[name="privateKey"]')).toHaveValue('test-only-key');
  await dialog.locator('[name="authMethod"]').selectOption('password');
  await dialog.locator('[name="password"]').fill('test-only-password');
  await dialog.getByRole('button', { name: '加密保存', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(f.writes.at(-1)!.body.password).toBe('test-only-password');
  expect(f.writes.at(-1)!.body.keychainId).toBeUndefined();
});

test('快速连接只发送密钥 ID，成功后主机仍保存引用', async ({ page }, testInfo) => {
  const f = await fixture(page);
  await page.locator('#quick-connect').click();
  await page.locator('#host').fill('192.0.2.20');
  await page.getByRole('radio', { name: '密钥链', exact: true }).check();
  await page.locator('#keychain-id').selectOption(keyId);
  await page.screenshot({ path: `deliverables/keychain-connect-${testInfo.project.name}.png`, fullPage: true });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.screenshot({ path: `deliverables/keychain-connect-light-${testInfo.project.name}.png`, fullPage: true });
  await page.locator('#connect-button').click();
  await expect.poll(() => f.connections.length).toBe(1);
  expect(f.connections[0]).toMatchObject({ authMethod: 'publickey', keychainId: keyId });
  expect(f.connections[0].privateKey).toBeUndefined(); expect(f.connections[0].password).toBeUndefined();
  await expect.poll(() => f.writes.some((call) => call.path.startsWith('/api/hosts') && call.body?.keychainId === keyId)).toBe(true);
});

test('自动重连继续使用密钥引用', async ({ page }) => {
  const f = await fixture(page);
  await page.locator('.connect-host').click();
  await expect(page.locator('#connect-button')).toHaveAttribute('data-action', 'disconnect');
  await f.sockets[0].close({ code: 1011, reason: 'Test network interruption' });
  await expect.poll(() => f.connections.length).toBe(2);
  expect(f.connections[1]).toMatchObject({ authMethod: 'publickey', keychainId: keyId });
  expect(f.connections[1].privateKey).toBeUndefined(); expect(f.connections[1].password).toBeUndefined();
});

test('管理密钥后返回终端保留连接草稿且不打断活动连接', async ({ page }) => {
  const f = await fixture(page);
  await page.locator('#quick-connect').click();
  await page.locator('#host').fill('192.0.2.20');
  await page.getByRole('radio', { name: '密钥链', exact: true }).check();
  await page.locator('#keychain-id').selectOption(keyId);
  await page.locator('#manage-keychain').click();
  await expect(page.locator('.keychain-page')).toBeVisible();
  await page.getByRole('button', { name: '返回终端', exact: true }).click();
  await expect(page.locator('#host')).toHaveValue('192.0.2.20');
  await expect(page.getByRole('radio', { name: '密钥链', exact: true })).toBeChecked();
  await expect(page.locator('#keychain-id')).toHaveValue(keyId);
  await page.locator('#connect-button').click();
  await expect(page.locator('#connect-button')).toHaveAttribute('data-action', 'disconnect');
  await page.locator('#panel-toggle').click();
  await page.locator('#manage-keychain').click();
  await page.getByRole('button', { name: '返回终端', exact: true }).click();
  await expect(page.locator('#connect-button')).toHaveAttribute('data-action', 'disconnect');
  expect(f.connections).toHaveLength(1);
});

for (const view of ['terminal', 'files']) test(`已有主机在 ${view} 连接复用密钥引用`, async ({ page }) => {
  const f = await fixture(page);
  if (view === 'files') {
    await page.locator('#rail-files').click(); await page.locator('#files-host').selectOption(savedHost.id); await page.locator('#files-connect').click();
  } else await page.locator('.connect-host').click();
  await expect.poll(() => f.connections.length).toBe(1);
  expect(f.connections[0].keychainId).toBe(keyId); expect(f.connections[0].privateKey).toBeUndefined();
});

test('密钥链响应式布局与登录失效清理', async ({ page }, testInfo) => {
  await fixture(page);
  await page.locator('#rail-keychain').click();
  await expect(page.locator('.keychain-row')).toHaveCount(1);
  await expect(page.locator('#rail-keychain')).toHaveAttribute('aria-current', 'page');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const box = await page.locator('.keychain-row').boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(testInfo.project.use.viewport!.width);
  await page.screenshot({ path: `deliverables/keychain-${testInfo.project.name}.png`, fullPage: true });
  await page.getByRole('button', { name: '新建密钥', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('auth-required')));
  await expect(page.locator('.keychain-dialog')).toBeHidden();
  await expect(page.locator('.keychain-row')).toHaveCount(0);
});
