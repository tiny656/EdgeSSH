import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';

const host = (id: string, name: string, address: string) => ({
  id, name, host: address, port: 22, username: 'root', group: '测试主机',
  authMethod: 'password', initialCommand: '', termType: 'xterm-256color',
  encoding: 'utf-8', fingerprint: '', location: null, system: null,
  hasCredential: true, updatedAt: Date.now(),
});

async function fixture(page: Page) {
  const hosts = [host('alpha', 'Tokyo production', '192.0.2.10'), host('beta', 'Singapore backup', '192.0.2.20')];
  const connections: any[] = [];
  const sockets: WebSocketRoute[] = [];
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/me') {
      return route.fulfill({ json: { account: { username: 'Administrator' }, provider: 'cloudflare' } });
    }
    if (path === '/api/hosts') return route.fulfill({ json: { hosts } });
    if (path.endsWith('/credentials')) return route.fulfill({ json: { password: 'test-only-password' } });
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
      if (message.type === 'connect') {
        connections.push(message);
        ws.send(JSON.stringify({ type: 'ready' }));
      }
    });
  });
  await page.goto('/');
  await expect(page.locator('#host-list')).toContainText('Tokyo production');
  return { connections, sockets };
}

/** 连接成功后 markReady() 会折叠左侧栏，操作主机列表前需要先展开。 */
async function openPanel(page: Page): Promise<void> {
  const toggle = page.locator('#panel-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}

test('未登录的主机显示“连接”，而不是复用他人会话的“断开”', async ({ page }) => {
  const f = await fixture(page);
  const button = page.locator('#connect-button');

  await page.locator('.connect-host').first().click();
  await expect(button).toHaveAttribute('data-action', 'disconnect');
  await expect.poll(() => f.connections.length).toBe(1);
  expect(f.connections[0].host).toBe('192.0.2.10');

  // 切换左侧栏中的另一台主机：会话仍属于第一台，按钮应回到“连接”。
  await openPanel(page);
  await page.locator('[data-profile-id="beta"]').click();
  await expect(button).toHaveAttribute('data-action', 'connect');
  await expect(page.locator('#host')).toHaveValue('192.0.2.20');
  await expect.poll(() => f.connections.length).toBe(1);

  // 点击后连到新目标：单会话页面先断开旧会话，再拨号第二台主机。
  await button.click();
  await expect.poll(() => f.connections.length).toBe(2);
  expect(f.connections[1].host).toBe('192.0.2.20');
  await expect.poll(() => f.sockets.length).toBe(2);
  await expect(button).toHaveAttribute('data-action', 'disconnect');
});

test('已连接主机重新选中仍显示“断开”且不会重复拨号', async ({ page }) => {
  const f = await fixture(page);
  const button = page.locator('#connect-button');

  await page.locator('.connect-host').first().click();
  await expect(button).toHaveAttribute('data-action', 'disconnect');

  await openPanel(page);
  await page.locator('[data-profile-id="alpha"]').click();
  await expect(button).toHaveAttribute('data-action', 'disconnect');
  await button.click();
  await expect.poll(() => f.connections.length).toBe(1);
});
