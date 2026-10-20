// Exercise the actual PDF renderer with APIs missing from older classroom browsers.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { startTestServer } = require('../server/testSupport');

function samplePdf() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>'];
  ['1 0 0', '0 1 0'].forEach((colour, i) => {
    const content = `${colour} rg 0 0 600 400 re f\n`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 400] /Contents ${4 + 2 * i} 0 R >>`,
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`);
  });
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('');
  return Buffer.from(pdf + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

(async () => {
  const server = process.env.MYCLASS_TEST_BASE_URL
    ? { base: process.env.MYCLASS_TEST_BASE_URL.replace(/\/+$/, ''), close: async () => {} }
    : await startTestServer({ withWeb: true });
  const output = process.env.PDF_COMPAT_TEST_OUTPUT || path.join(os.tmpdir(), 'myclass-pdf-compatibility-proof');
  await fs.mkdir(output, { recursive: true });
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    for (const mode of ['missing-api', 'unsupported-module', 'retry']) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      const errors = [], requests = [];
      let legacyLoads = 0;
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => requests.push(request.url()));
      await page.addInitScript(missing => {
        Element.prototype.requestFullscreen = async () => {};
        if (missing) delete Promise.withResolvers;
      }, mode !== 'unsupported-module');
      await page.route('**/vendor/pdfjs/build/pdf.min.mjs?*', route => route.fulfill({
        contentType: 'application/javascript', body: 'throw new SyntaxError("Unsupported PDF module");'
      }));
      await page.route('**/vendor/pdfjs/build/pdf.min.js?*', route => {
        legacyLoads += 1;
        return mode === 'retry' && legacyLoads === 1
          ? route.fulfill({ status: 503, body: 'Temporary failure' }) : route.continue();
      });
      await page.route('**/compatibility.pdf', route => route.fulfill({ contentType: 'application/pdf', body: samplePdf() }));
      await page.route('**/compatibility.pdf.metadata*', route => route.fulfill({ json: { conversion: null, videos: [] } }));
      await page.goto(server.base + '/');
      await page.waitForFunction(() => !!state.roomCode);
      const open = () => page.evaluate(url => openCourseware({ url, title: 'PDF compatibility', page: 1 }), `${server.base}/compatibility.pdf`);
      await open();
      if (mode === 'retry') {
        await page.waitForFunction(() => !elements.videoStatus.hidden && elements.videoStatus.textContent.includes('加载失败'));
        assert.equal(await page.evaluate(() => pdfJsPromise), null);
        const errorBox = await page.locator('#videoStatus').boundingBox();
        const toolbarBox = await page.locator('#annotationToolbar').boundingBox();
        assert.ok(errorBox.y + errorBox.height < toolbarBox.y);
        await page.screenshot({ path: path.join(output, 'visible-error.png') });
        await open();
      }
      await page.waitForFunction(() => state.courseware?.displayedPage === 1 && !state.courseware.prefetching);
      const pixel = () => page.evaluate(() => Array.from(elements.coursewareCanvas.getContext('2d').getImageData(20, 20, 1, 1).data));
      assert.deepEqual(await pixel(), [255, 0, 0, 255]);
      assert.equal(await page.evaluate(() => window.pdfjsLib.version), '3.11.174');
      assert.equal(await page.evaluate(() => window.pdfjsLib.GlobalWorkerOptions.workerSrc), './vendor/pdfjs/build/pdf.worker.min.js?v=3.11.174');
      await page.evaluate(() => showCoursewarePage(2));
      await page.waitForFunction(() => state.courseware?.displayedPage === 2);
      assert.deepEqual(await pixel(), [0, 255, 0, 255]);
      assert.equal(requests.some(url => url.includes('pdf.min.mjs')), mode === 'unsupported-module');
      assert.deepEqual(errors, []);
      await page.screenshot({ path: path.join(output, `${mode}.png`) });
      await page.close();
    }
    console.log(`PASS: missing API, unsupported module, matching worker, rendered pixels, navigation, visible error and retry; screenshots: ${output}`);
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
