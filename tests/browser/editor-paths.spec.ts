import { test, expect, type Page } from '@playwright/test';
import { connectFiles, fileFixture } from './file-fixture';

const STORAGE_PREFIX = 'edgessh.file-path.v1:';

function storageKey(hostId: string): string {
  return `${STORAGE_PREFIX}${hostId}`;
}

async function readRecord(page: Page, hostId: string): Promise<Record<string, unknown> | null> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as Record<string, unknown> : null;
  }, storageKey(hostId));
}

test('按主机记住目录：重连回到上次目录，其他主机互不影响', async ({ page }) => {
  await fileFixture(page);
  await connectFiles(page, 'alpha');
  await expect(page.locator('#files-connection-state')).toHaveText('SSH 已连接');
  await expect(page.locator('#file-manager-path')).toHaveValue('/root');

  await page.locator('.files-list [role="treeitem"]').filter({ hasText: 'backups' }).dblclick();
  await expect(page.locator('#file-manager-path')).toHaveValue('/root/backups');
  expect(await readRecord(page, 'alpha')).toMatchObject({ directory: '/root/backups' });

  // 断开后重连同一主机：自动回到上次目录。
  await page.locator('#files-connect').click();
  await expect(page.locator('#files-connection-state')).toHaveText('未连接');
  await page.locator('#files-connect').click();
  await expect(page.locator('#file-manager-path')).toHaveValue('/root/backups');

  // 另一台主机没有记录：回到服务端默认目录，不会串用 alpha 的路径。
  await page.locator('#files-connect').click();
  await expect(page.locator('#files-connection-state')).toHaveText('未连接');
  await page.locator('#files-host').selectOption('beta');
  await page.locator('#files-connect').click();
  await expect(page.locator('#files-connection-state')).toHaveText('SSH 已连接');
  await expect(page.locator('#file-manager-path')).toHaveValue('/root');
  expect(await readRecord(page, 'beta')).toMatchObject({ directory: '/root' });

  // 再回到 alpha：仍是 alpha 自己的目录。
  await page.locator('#files-connect').click();
  await expect(page.locator('#files-connection-state')).toHaveText('未连接');
  await page.locator('#files-host').selectOption('alpha');
  await page.locator('#files-connect').click();
  await expect(page.locator('#file-manager-path')).toHaveValue('/root/backups');
});

test('上次目录已失效：回落 / 并提示一句', async ({ page }) => {
  await fileFixture(page);
  await page.evaluate(([key]) => {
    localStorage.setItem(key, JSON.stringify({ directory: '/forbidden', file: null, updatedAt: Date.now() }));
  }, [storageKey('alpha')]);

  await connectFiles(page, 'alpha');
  await expect(page.locator('#file-manager-path')).toHaveValue('/');
  await expect(page.locator('#file-manager-status')).toContainText('上次访问的目录已不可用');
  await expect(page.locator('.files-list')).toContainText('root');
  expect(await readRecord(page, 'alpha')).toMatchObject({ directory: '/' });
});

test('打开编辑器只记录目录，存储里没有文件路径和凭据', async ({ page }) => {
  await fileFixture(page);
  await connectFiles(page, 'alpha');
  await page.locator('.files-list').getByRole('treeitem', { name: 'README.md', exact: true }).dblclick();
  await expect(page.locator('.file-editor')).toBeVisible();

  const record = await readRecord(page, 'alpha');
  expect(record).toMatchObject({ directory: '/root' });
  expect(record).not.toHaveProperty('file');
  const raw = await page.evaluate((key) => localStorage.getItem(key), storageKey('alpha'));
  expect(raw).not.toBeNull();
  expect(raw).not.toContain('password');
  expect(Object.keys(JSON.parse(raw!)).sort()).toEqual(['directory', 'updatedAt']);
});
