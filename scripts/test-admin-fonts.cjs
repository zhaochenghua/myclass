const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { startTestServer } = require('../server/testSupport');

(async () => {
  const server = await startTestServer({ withWeb: true });
  const output = path.join(os.tmpdir(), 'myclass-admin-fonts-proof');
  await fs.mkdir(output, { recursive: true });
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('admin_token', 'alice-test-token'));
    let unsupported = false;
    let uploads = 0;
    const items = Array.from({ length: 103 }, (_, index) => ({ family: `Font ${index}`, styles: ['Regular', 'Bold'], source: 'system' }));
    items.unshift({ family: 'Source Han Sans CN,思源黑体 CN', styles: ['Regular', 'Bold'], source: 'system' });
    await page.route('**/api/fonts', async route => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { supported: !unsupported, maxBytes: 64 * 1024 * 1024,
        message: unsupported ? '当前服务器暂不支持字体安装' : '', items: unsupported ? [] : items } });
      const body = route.request().postDataBuffer().toString();
      if (body.includes('bad.otf')) return route.fulfill({ status: 400, json: { error: '字体损坏或格式不受支持' } });
      uploads++;
      if (uploads === 1) items.unshift({ family: 'Uploaded <img src=x onerror=alert(1)>', styles: ['Bold'], source: 'uploaded' });
      return route.fulfill({ status: uploads === 1 ? 201 : 200, json: { duplicate: uploads > 1, faces: [{ family: 'Uploaded <img src=x onerror=alert(1)>', style: 'Bold' }] } });
    });
    await page.goto(`${server.base}/admin.html`);
    await page.getByRole('button', { name: '字体管理', exact: true }).click();
    await page.waitForFunction(() => !document.getElementById('fontFileInput').disabled);
    assert.equal(await page.locator('#fontTableBody tr').count(), 100);
    await page.locator('#fontNextButton').click();
    assert.equal(await page.locator('#fontTableBody tr').count(), 4);
    await page.locator('#fontSearch').fill('思源');
    assert.equal(await page.locator('#fontTableBody tr').count(), 1);
    assert.match(await page.locator('#fontTableBody').innerText(), /Bold/);
    await page.locator('#fontSearch').fill('missing-font');
    assert.match(await page.locator('#fontTableBody').innerText(), /没有匹配/);
    await page.locator('#fontSearch').fill('');
    await page.locator('#fontFileInput').setInputFiles(['good.ttf', 'duplicate.ttf', 'bad.otf'].map(name => ({ name, mimeType: 'font/ttf', buffer: Buffer.from('fixture') })));
    await page.locator('#uploadFontsButton').click();
    await page.waitForFunction(() => document.getElementById('fontStatus').textContent.includes('成功 2 个，失败 1 个'));
    assert.equal(await page.locator('.font-result-success').count(), 2);
    assert.equal(await page.locator('.font-result-error').count(), 1);
    assert.match(await page.locator('#fontUploadResults').innerText(), /无需重复上传/);
    assert.equal(await page.locator('#tab-fonts img').count(), 0);
    await page.locator('#fontSearch').fill('Uploaded');
    await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#fontCount').scrollIntoViewIfNeeded();
    assert.ok((await page.locator('.admin-header h1').boundingBox()).height < 40);
    assert.ok(await page.evaluate(() => scrollY > 0), 'mobile font results must remain scrollable');
    assert.ok(await page.locator('.font-table th:last-child').evaluate(element => element.getBoundingClientRect().right <= innerWidth), 'font source must fit on mobile');
    await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    unsupported = true;
    await page.locator('#refreshFontsButton').click();
    await page.waitForFunction(() => document.getElementById('fontFileInput').disabled);
    assert.match(await page.locator('#fontStatus').innerText(), /暂不支持/);
    assert.deepEqual(errors, []);
    console.log(`PASS: teacher access, search, pagination, batch upload, duplicates, errors, safe text, unsupported platform, desktop/mobile. Screenshots: ${output}`);
  } finally { await browser?.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
