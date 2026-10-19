// Browser regression: mode transitions must restore both tools and usable ink.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { startTestServer } = require('../server/testSupport');

function samplePdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 400] /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\nendstream'
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += 'xref\n0 5\n0000000000 65535 f \n';
  pdf += offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('');
  return Buffer.from(pdf + `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

(async () => {
  const server = await startTestServer({ withWeb: true });
  const output = process.env.TOOLBAR_TEST_OUTPUT || path.join(require('node:os').tmpdir(), 'myclass-toolbar-proof');
  await fs.mkdir(output, { recursive: true });
  let browser, page;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : { channel: 'msedge' }) });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { Element.prototype.requestFullscreen = async () => {}; });
    await page.route('**/toolbar-check.pdf', route => route.fulfill({ contentType: 'application/pdf', body: samplePdf() }));
    await page.route('**/toolbar-check.mp4', route => route.fulfill({ contentType: 'video/mp4', body: '' }));
    await page.goto(server.base + '/');
    await page.waitForFunction(() => !!state.roomCode);
    const failures = [];
    const open = async kind => {
      await page.evaluate(({ kind, base }) => {
        if (kind === 'camera') showVideoView();
        else openCourseware({ url: base + '/toolbar-check.' + kind, title: '工具栏切换测试', page: 1 });
      }, { kind, base: server.base });
      if (kind === 'pdf') await page.waitForFunction(() => state.courseware?.pdfDocument && !state.courseware.renderTask);
    };
    const check = async label => {
      const visible = await page.locator('#annotationToolbar').isVisible();
      const ink = await page.locator('#annotationCanvas').isVisible();
      if (!visible || !ink) {
        failures.push(`${label}: toolbar=${visible}, ink=${ink}`);
        await page.screenshot({ path: path.join(output, label + '-failed.png') });
        return;
      }
      // Wait for the actual placement observer rather than assigning DOM state in the test.
      await page.waitForFunction(() => document.getElementById('studentRollControls').parentElement.id === 'studentRollToolbarSlot');
      assert.equal(await page.locator('#studentRollControls').evaluate(el => el.parentElement.id), 'studentRollToolbarSlot');
      await page.locator('#annotationEraserButton').click();
      assert.equal(await page.evaluate(() => state.annotations.tool), 'eraser');
      await page.locator('#annotationColors [data-color="#D00000"]').click();
      const before = await page.evaluate(() => state.annotations.strokes.length);
      await page.mouse.move(400, 320); await page.mouse.down();
      await page.mouse.move(600, 420, { steps: 10 }); await page.mouse.up();
      assert.equal(await page.evaluate(() => state.annotations.strokes.length), before + 1, label + ': cannot draw');
      await page.screenshot({ path: path.join(output, label + '.png') });
    };
    await open('pdf'); await check('initial-pdf');
    for (const source of ['mp4', 'zip']) {
      for (const target of ['pdf', 'camera']) {
        await open(source);
        assert.equal(await page.locator('#annotationToolbar').isVisible(), false);
        if (source === 'mp4') await page.evaluate(() => closeVideoPlayer());
        await open(target); await check(`${source}-to-${target}`);
        await open(source);
        await page.evaluate(() => { closeCourseware(); showJoinView(); });
        await open(target); await check(`${source}-waiting-to-${target}`);
      }
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(failures, [], 'mode transitions must restore annotation UI');
    console.log(`PASS: initial PDF plus video/ZIP → PDF/camera, with/without waiting; tool clicks and real drawing; evidence: ${output}`);
  } finally { await browser?.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
