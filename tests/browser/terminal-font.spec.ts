import { test, expect, type Page } from '@playwright/test';
import { secureResponse } from '../../src/http-security';
import { connectFiles, fileFixture } from './file-fixture';

const family = 'FiraCode Nerd Font Mono';
const sample = 'W \ue0b0 \ue0a0 \uf07b \uf120 \uf306 \u{f0001}';
const output = `\x1b[2J\x1b[H${sample}\r\n\x1b[1m${sample}\x1b[0m\r\n`;

async function expectLoadedFont(page: Page): Promise<void> {
  await expect(page.locator('.xterm-rows')).toHaveCSS('font-family', /FiraCode Nerd Font Mono/);
  expect(await page.evaluate(() => Array.from(document.fonts)
    .filter((font) => font.family.includes('FiraCode Nerd Font Mono'))
    .map((font) => ({ weight: font.weight, status: font.status }))
    .sort((a, b) => a.weight.localeCompare(b.weight)))).toEqual([
    { weight: '400', status: 'loaded' },
    { weight: '700', status: 'loaded' },
  ]);
}

async function expectRenderedGlyphs(page: Page): Promise<void> {
  const rows = page.locator('.xterm-rows > div');
  await expect(rows.nth(0)).toHaveText(sample);
  await expect(rows.nth(1)).toHaveText(sample);
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('DOM.enable');
    await session.send('CSS.enable');
    const { root } = await session.send('DOM.getDocument');
    for (const row of [1, 2]) {
      const { nodeId } = await session.send('DOM.querySelector', {
        nodeId: root.nodeId,
        selector: `.xterm-rows > div:nth-child(${row})`,
      });
      const { fonts } = await session.send('CSS.getPlatformFontsForNode', { nodeId });
      // Inspect the font actually rendering every glyph, not just the CSS family or loaded face.
      expect(fonts).toEqual([expect.objectContaining({
        familyName: family,
        isCustomFont: true,
        glyphCount: Array.from(sample).length,
      })]);
      if (row === 2) expect(fonts[0].postScriptName).toMatch(/Bold/);
      else expect(fonts[0].postScriptName).not.toMatch(/Bold/);
    }
  } finally {
    await session.detach();
  }
}

test('bundled FiraCode renders regular and bold Nerd Font glyphs under the production CSP', async ({ page }, testInfo) => {
  const errors: string[] = [];
  const fontRequests: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.resourceType() === 'font') fontRequests.push(request.url());
  });
  await page.route('**/', async (route) => {
    const response = await route.fetch();
    const secured = secureResponse(new Response(null, { headers: response.headers() }));
    await route.fulfill({ response, headers: Object.fromEntries(secured.headers) });
  });
  const fixture = await fileFixture(page, { waitUntil: 'domcontentloaded' });
  // Fonts can finish while the terminal is hidden on the dashboard/files page.
  await expectLoadedFont(page);
  await connectFiles(page);
  await expect(page.locator('#files-connection-state')).toHaveText('SSH 已连接');
  await page.locator('#files-terminal').click();
  fixture.sshSockets[0].send(Buffer.from(output));
  await expectRenderedGlyphs(page);

  expect(fontRequests).toHaveLength(2);
  for (const request of fontRequests) {
    expect(new URL(request).origin).toBe(new URL(page.url()).origin);
    expect(new URL(request).pathname).toMatch(/\/fonts\/firacode-nerd-font-v3\.5\.1\/FiraCodeNerdFontMono-(Regular|Bold)\.ttf$/);
  }
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('terminal-firacode.png') });
});

test('late bold font loading redraws existing output and synchronizes the measured terminal size', async ({ page }, testInfo) => {
  let releaseBold!: () => void;
  const held = new Promise<void>((resolve) => { releaseBold = resolve; });
  await page.route('**/FiraCodeNerdFontMono-Bold.ttf', async (route) => {
    await held;
    await route.continue();
  });
  try {
    const fixture = await fileFixture(page, { waitUntil: 'domcontentloaded' });
    await expect.poll(() => page.evaluate(() => Array.from(document.fonts)
      .some((font) => font.family.includes('FiraCode Nerd Font Mono') && font.weight === '400' && font.status === 'loaded'))).toBe(true);
    await connectFiles(page);
    await expect(page.locator('#files-connection-state')).toHaveText('SSH 已连接');
    await page.locator('#files-terminal').click();
    fixture.sshSockets[0].send(Buffer.from(output));
    await expect(page.locator('.xterm-rows > div').first()).toHaveText(sample);
    await expect(page.locator('.xterm-rows')).not.toHaveCSS('font-family', /FiraCode Nerd Font Mono/);
    const resizes = () => fixture.calls.filter((call) => call.type === 'resize');
    const before = resizes().length;
    releaseBold();
    await expectLoadedFont(page);
    await expectRenderedGlyphs(page);
    await expect.poll(() => resizes().length).toBeGreaterThan(before);
    const size = resizes().at(-1)!;
    const measured = await page.locator('.xterm-rows').evaluate((element) => {
      const style = getComputedStyle(element);
      const canvas = new OffscreenCanvas(1, 1);
      const context = canvas.getContext('2d')!;
      context.font = `${style.fontSize} ${style.fontFamily}`;
      const metrics = context.measureText('W');
      const bounds = element.getBoundingClientRect();
      return {
        width: bounds.width,
        height: bounds.height,
        rows: element.childElementCount,
        cellWidth: metrics.width,
        cellHeight: Math.floor(Math.ceil((metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent) * devicePixelRatio) * 1.18) / devicePixelRatio,
      };
    });
    expect(measured.rows).toBe(size.rows);
    expect(Math.abs(measured.width / size.cols - measured.cellWidth)).toBeLessThan(1 / size.cols + 0.01);
    expect(measured.height / size.rows).toBeCloseTo(measured.cellHeight, 1);
    expect(fixture.sshSockets).toHaveLength(1);
    await page.screenshot({ path: testInfo.outputPath('terminal-after-font.png') });
  } finally {
    releaseBold();
  }
});

for (const weight of ['Regular', 'Bold']) {
  test(`a failed ${weight} font reports the problem and keeps SSH usable`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route(`**/FiraCodeNerdFontMono-${weight}.ttf`, (route) =>
      route.fulfill({ status: 404, body: 'Font not found' }));
    const fixture = await fileFixture(page);
    await expect(page.locator('#toast-region .toast.error')).toContainText('FiraCode Nerd Font 加载失败');
    await expect(page.locator('#event-log .event-line.error')).toContainText('已使用备用字体');
    await connectFiles(page);
    await expect(page.locator('#files-connection-state')).toHaveText('SSH 已连接');
    await page.locator('#files-terminal').click();
    await page.locator('#language-toggle').click();
    await expect(page.locator('#event-log .event-line.error')).toContainText('FiraCode Nerd Font could not be loaded');
    await page.locator('#language-toggle').click();
    await expect(page.locator('.xterm-rows')).not.toHaveCSS('font-family', /FiraCode Nerd Font Mono/);
    fixture.sshSockets[0].send(Buffer.from('fallback terminal ready\r\n'));
    await expect(page.locator('.xterm-rows')).toContainText('fallback terminal ready');
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('pwd');
    await expect.poll(() => fixture.calls.filter((call) => call.type === 'input').map((call) => call.data).join('')).toBe('pwd');
    expect(fixture.sshSockets).toHaveLength(1);
    expect(errors).toEqual([]);
  });
}

test('missing font-face definitions are not mistaken for successful loading', async ({ page }) => {
  await page.addInitScript(() => {
    const load = document.fonts.load.bind(document.fonts);
    document.fonts.load = (font, text) => font.includes('FiraCode Nerd Font Mono')
      ? Promise.resolve([])
      : load(font, text);
  });
  await fileFixture(page);
  await expect(page.locator('#toast-region .toast.error')).toContainText('FiraCode Nerd Font 加载失败');
  await expect(page.locator('.xterm-rows')).not.toHaveCSS('font-family', /FiraCode Nerd Font Mono/);
});
