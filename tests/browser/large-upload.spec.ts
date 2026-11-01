import { expect, test, type Page } from '@playwright/test';
import { connectFiles, fileFixture } from './file-fixture';

const chunkSize = 64 * 1024;

async function chooseVirtualFile(page: Page, size: number, failRead = false) {
  await page.evaluate(({ size, failRead }) => {
    // 用真实输入事件进入上传逻辑，按需生成切片，避免测试先整体分配大文件。
    const file = new File([], 'large-fixture.bin');
    Object.defineProperty(file, 'size', { value: size });
    file.slice = (start = 0, end = size) => {
      if (failRead) throw new Error('File read failed');
      if (end - start > 64 * 1024) throw new Error('Unbounded file read');
      return new Blob([new Uint8Array(end - start)]);
    };
    const input = document.querySelector<HTMLInputElement>('#file-upload-input')!;
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
  }, { size, failRead });
}

test('网页分块完成超过 64 MiB 的上传，不整体读取文件', async ({ page }) => {
  test.setTimeout(60_000);
  const fixture = await fileFixture(page, { uploadWindow: 8, discardUploadBody: true });
  await connectFiles(page);
  await expect(page.locator('#file-upload')).toBeEnabled();
  const size = 65 * 1024 * 1024 + 113;
  await chooseVirtualFile(page, size);
  await expect(page.locator('.files-list')).toContainText('large-fixture.bin', { timeout: 45_000 });
  expect(fixture.uploadStats.bytes).toBe(size);
  expect(fixture.uploadStats.maxChunk).toBe(chunkSize);
  expect(fixture.calls.filter(call => call.type === 'sftp_upload_end')).toHaveLength(1);
});

test('2 GiB 文件只预读八块，ACK 推进窗口，取消后停止读取', async ({ page }) => {
  const fixture = await fileFixture(page, { uploadWindow: 8, holdUploadAcks: true });
  await connectFiles(page);
  await expect(page.locator('#file-upload')).toBeEnabled();
  await chooseVirtualFile(page, 2 * 1024 * 1024 * 1024);
  await expect.poll(() => fixture.uploadStats.chunks).toBe(8);
  const requestId = fixture.calls.find(call => call.type === 'sftp_upload_start')!.requestId;
  expect(fixture.uploadStats.bytes).toBe(8 * chunkSize);
  fixture.sftpSockets[0].send(JSON.stringify({ type: 'sftp_upload_progress', requestId, loaded: chunkSize }));
  await expect.poll(() => fixture.uploadStats.chunks).toBe(9);
  await page.locator('#file-manager-progress-cancel').click();
  await expect(page.locator('#file-manager-progress')).toBeHidden();
  expect(fixture.uploadStats.chunks).toBe(9);
  expect(fixture.calls.some(call => call.type === 'sftp_upload_end')).toBe(false);
});

test('超过 2 GiB 在发起请求前拒绝，读取失败会取消远端上传', async ({ page }) => {
  const fixture = await fileFixture(page, { uploadWindow: 8 });
  await connectFiles(page);
  await expect(page.locator('#file-upload')).toBeEnabled();
  await chooseVirtualFile(page, 2 * 1024 * 1024 * 1024 + 1);
  await expect(page.locator('#file-manager-error')).toContainText('2 GiB');
  expect(fixture.calls.some(call => call.type === 'sftp_upload_start')).toBe(false);
  await chooseVirtualFile(page, chunkSize, true);
  await expect(page.locator('#file-manager-error')).toContainText('File read failed');
  expect(fixture.calls.some(call => call.type === 'sftp_upload_cancel')).toBe(true);
  expect(fixture.calls.some(call => call.type === 'sftp_upload_end')).toBe(false);
});

test('旧服务端保留单块背压，错误 ACK 不会被当成成功', async ({ page }) => {
  const fixture = await fileFixture(page, { holdUploadAcks: true });
  await connectFiles(page);
  await expect(page.locator('#file-upload')).toBeEnabled();
  await chooseVirtualFile(page, 10 * chunkSize);
  await expect.poll(() => fixture.uploadStats.chunks).toBe(1);
  const requestId = fixture.calls.find(call => call.type === 'sftp_upload_start')!.requestId;
  fixture.sftpSockets[0].send(JSON.stringify({ type: 'sftp_upload_progress', requestId, loaded: 1 }));
  await expect(page.locator('#file-manager-error')).toContainText('上传确认进度不匹配');
  expect(fixture.calls.some(call => call.type === 'sftp_upload_end')).toBe(false);
});
