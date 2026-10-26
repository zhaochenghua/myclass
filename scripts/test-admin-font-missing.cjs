// Admin font-missing prompt and classroom draw history against an isolated
// server. Font endpoints are mocked (the isolated server runs on a platform
// without fontconfig); class and draw-log endpoints are real.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { startTestServer } = require('../server/testSupport');

(async () => {
  const server = await startTestServer({ withWeb: true });
  const output = path.join(os.tmpdir(), 'myclass-admin-font-missing-proof');
  await fs.mkdir(output, { recursive: true });
  let browser;
  try {
    const item = (await (await server.api('/classes', 'alice', 'POST', { name: '七年级（1）班' })).json()).item;
    const students = [{ number: '01', name: '张三' }, { number: '02', name: '李四' }, { number: '03', name: '王五' }];
    await server.api(`/classes/${item.id}`, 'alice', 'PUT', { name: item.name, students, revision: 1 });
    const first = await (await server.api(`/classes/${item.id}/draw`, 'alice', 'POST', { mode: 'name' })).json();
    const second = await (await server.api(`/classes/${item.id}/draw`, 'alice', 'POST', { mode: 'number' })).json();
    assert.notEqual(first.candidate.id, second.candidate.id);

    browser = await chromium.launch({ headless: true,
      ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : { channel: 'msedge' }) });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('admin_token', 'alice-test-token'));

    const fontItems = [{ family: 'Source Han Sans CN,思源黑体 CN', styles: ['Regular'], source: 'system' }];
    let missing = [
      { family: '方正小标宋简体', coursewareCount: 2, titles: ['语文课件', '数学课件'] },
      { family: 'Ink Free', coursewareCount: 1, titles: ['语文课件'] }
    ];
    let pendingRegeneration = 2;
    let scanPending = 3;
    let regenerateCalls = 0;
    await page.route('**/api/fonts**', async route => {
      const request = route.request();
      if (request.method() === 'POST' && request.url().includes('/regenerate')) {
        regenerateCalls++;
        const titles = missing.length ? ['语文课件', '数学课件'] : [];
        missing = [];
        pendingRegeneration = 0;
        return route.fulfill({ json: { supported: true,
          regenerated: titles.map((title, index) => ({ id: `cw-${index}`, title })), failed: [], remaining: 0 } });
      }
      if (request.method() === 'POST') {
        return route.fulfill({ status: 201, json: { duplicate: false, faces: [{ family: '方正小标宋简体', style: 'Regular' }] } });
      }
      return route.fulfill({ json: { supported: true, maxBytes: 64 * 1024 * 1024, items: fontItems,
        missingFonts: missing, missingCourseware: missing.length ? 2 : 0, pendingRegeneration, scanPending } });
    });

    await page.goto(`${server.base}/admin.html`);
    const fontTab = page.locator('#adminTabs .tab-btn[data-tab="fonts"]');
    await fontTab.click();
    await page.waitForFunction(() => document.getElementById('fontFileInput').disabled === false);
    await page.waitForFunction(() => !document.getElementById('fontMissingPanel').hidden);

    assert.match(await fontTab.innerText(), /字体管理（缺 2 种）/, 'the tab must advertise the missing fonts');
    assert.match(await page.locator('#fontMissingCount').innerText(), /2 种，影响 2 个课件/);
    const missingText = await page.locator('#fontMissingList').innerText();
    assert.match(missingText, /方正小标宋简体/);
    assert.match(missingText, /Ink Free/);
    assert.match(missingText, /涉及：语文课件、数学课件/);
    assert.equal(await page.locator('#regenerateFontsButton').isVisible(), true);
    assert.match(await page.locator('#regenerateFontsButton').innerText(), /重新生成待更新课件（2）/);
    assert.match(await page.locator('#fontScanStatus').innerText(), /还有 3 个旧课件待检查字体/);
    await page.screenshot({ path: path.join(output, 'fonts-missing.png'), fullPage: true });

    scanPending = 0;
    await page.locator('#fontFileInput').setInputFiles({ name: '方正小标宋简体.ttf', mimeType: 'font/ttf', buffer: Buffer.from('fixture') });
    await page.locator('#uploadFontsButton').click();
    await page.waitForFunction(() => document.getElementById('fontRegenerateStatus').textContent.includes('已重新生成 2 个课件'));
    assert.equal(regenerateCalls, 1, 'a successful upload must trigger one regeneration pass');
    assert.equal(await page.locator('#fontMissingPanel').isVisible(), false, 'the prompt disappears once nothing is missing');
    assert.equal(await page.locator('#fontUploadResults .font-result-success').count(), 1);
    assert.equal(await page.locator('#tab-fonts img').count(), 0);

    // Missing font names and courseware titles are escaped as text.
    missing = [{ family: '<img src=x onerror=alert(1)>', coursewareCount: 1, titles: ['<b>课件</b>'] }];
    pendingRegeneration = 1;
    await page.locator('#refreshFontsButton').click();
    await page.waitForFunction(() => !document.getElementById('fontMissingPanel').hidden);
    assert.equal(await page.locator('#fontMissingList img').count(), 0);
    assert.equal(await page.locator('#fontMissingList b').count(), 0);
    assert.match(await page.locator('#fontMissingList').innerText(), /<img src=x onerror=alert\(1\)>/);

    await page.locator('#adminTabs .tab-btn[data-tab="classes"]').click();
    await page.waitForFunction(() => !document.getElementById('classDrawLog').hidden);
    await page.waitForFunction(() => document.querySelectorAll('#classDrawLogList li').length === 2);
    const logText = await page.locator('#classDrawLogList').innerText();
    for (const student of [students.find(s => s.number === first.candidate.id), students.find(s => s.number === second.candidate.id)]) {
      assert.ok(logText.includes(`${student.number} ${student.name}`), `draw history must show ${student.name}`);
    }
    assert.match(logText, /第 1 轮 · 抽姓名/);
    assert.match(logText, /第 1 轮 · 抽学号/);
    assert.match(await page.locator('#classDrawLogCount').innerText(), /共 2 条/);
    await page.screenshot({ path: path.join(output, 'class-draw-log.png'), fullPage: true });

    // Refresh keeps the history; clearing removes it without resetting rounds.
    await page.locator('#refreshDrawLogButton').click();
    await page.waitForFunction(() => document.querySelectorAll('#classDrawLogList li').length === 2);
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#clearDrawLogButton').click();
    await page.waitForFunction(() => document.querySelectorAll('#classDrawLogList li').length === 0);
    assert.equal(await page.locator('#classDrawLogEmpty').isVisible(), true);
    const cleared = await (await server.api(`/classes/${item.id}/draw-log`, 'alice')).json();
    assert.equal(cleared.total, 0);
    const next = await (await server.api(`/classes/${item.id}/draw`, 'alice', 'POST', { mode: 'name' })).json();
    assert.equal(next.round, 1, 'clearing history must not reset the draw round');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#classDrawLog').scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
      'draw history must fit the mobile page');
    await page.screenshot({ path: path.join(output, 'class-draw-log-mobile.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    console.log(`PASS: missing-font prompt, automatic regeneration, safe text, draw history and clearing. Screenshots: ${output}`);
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
