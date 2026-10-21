const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { startTestServer } = require('../server/testSupport');
function pdfFixture() {
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 400] /Resources << >> >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 400] /Resources << >> >>'];
 let data='%PDF-1.4\n', offsets=[0]; objects.forEach((s,i)=>{offsets.push(Buffer.byteLength(data));data+=`${i+1} 0 obj\n${s}\nendobj\n`});const pos=Buffer.byteLength(data); data+='xref\n0 5\n0000000000 65535 f \n'+offsets.slice(1).map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF`;return data;
}
(async () => {
  const server = await startTestServer({ withWeb: true });
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => { Element.prototype.requestFullscreen = async () => {}; });
    await page.route('**/tools-check.pdf', route => route.fulfill({ contentType: 'application/pdf', body: pdfFixture() }));
    await page.route('**/tools-check.pdf.metadata*', route => route.fulfill({ json: { videos: [{ index: 0, slide: 1, title: 'Video', url: 'test.mp4' }] } }));
    await page.goto(server.base + '/');
    await page.waitForFunction(() => !!state.roomCode);
    await page.evaluate(base => openCourseware({ url: base + '/tools-check.pdf', page: 1, title: 'Tools check' }), server.base);
    await page.waitForFunction(() => state.courseware?.displayedPage === 1);
    await page.locator('.embedded-launch').waitFor({ state: 'visible' });
    const positions = () => page.locator('#prevPageButton, #nextPageButton').evaluateAll(buttons => buttons.map(b => {
      const r = b.getBoundingClientRect(); return [r.x, r.y, r.width, r.height];
    }));
    for (const width of [1920, 1280, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => { showCoursewarePage(1); });
      await page.locator('.embedded-launch').waitFor({ state: 'visible' });
      const before = await positions();
      await page.evaluate(() => { showCoursewarePage(2); });
      await page.locator('.embedded-launch').waitFor({ state: 'hidden' });
      assert.deepEqual(await positions(), before, 'video visibility must not move navigation at ' + width);
    }
    await page.setViewportSize({ width: 1920, height: 1080 });
    for (const board of [false, true]) {
      if (board) await page.evaluate(() => toggleBlackboard(true));
      const id = board ? 'blackboardEraserButton' : 'annotationEraserButton';
      const button = page.locator('#' + id);
      for (const [label, size] of [['大', 80], ['小', 20], ['中', 40]]) {
        await button.click();
        await page.locator('#' + id + 'SizeMenu').getByRole('button', { name: label + '号板擦', exact: true }).click();
        assert.deepEqual(await page.evaluate(board => {
          const s = board ? state.blackboard : state.annotations;
          return { tool: s.tool, size: s.eraserWidth };
        }, board), { tool: 'eraser', size });
        assert.equal(await button.getAttribute('aria-expanded'), 'false');
      // The size must reach the actual stroke, not only update the selector.
      await page.mouse.move(450, 300); await page.mouse.down();
      await page.mouse.move(550, 320); await page.mouse.up();
      assert.equal(await page.evaluate(board => {
        const strokes = board ? state.blackboard.pages[state.blackboard.currentPage].strokes : strokesForCurrentPage();
        return strokes.at(-1)?.width;
      }, board), size);

      }
      await button.click();
      await page.screenshot({ path: path.join(os.tmpdir(), board ? 'myclass-board-eraser.png' : 'myclass-courseware-eraser.png') });
      await page.keyboard.press('Escape');
      assert.equal(await button.getAttribute('aria-expanded'), 'false');
    }
    assert.equal(await page.locator('.annotation-tool-icon').count(), 6);
    assert.deepEqual(errors, []);
    console.log('PASS: stable paging at three widths; both eraser menus, applied stroke widths, icons and Escape dismissal');
  } finally { await browser?.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
