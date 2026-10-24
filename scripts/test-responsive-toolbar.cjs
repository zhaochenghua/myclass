// Regression: classroom browsers whose offsetWidth follows CSS zoom must not
// make the responsive toolbar alternate between full width and scaled width.
const { chromium } = require('playwright-core');
const assert = require('node:assert/strict');
const { startTestServer } = require('../server/testSupport');

function samplePdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 400] /Resources << >> >>'
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += 'xref\n0 4\n0000000000 65535 f \n';
  pdf += offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('');
  return Buffer.from(pdf + `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

async function readToolbar(page) {
  return page.locator('#annotationToolbar').evaluate(bar => {
    const rect = bar.getBoundingClientRect();
    return {
      width: Math.round(rect.width * 100) / 100,
      height: Math.round(rect.height * 100) / 100,
      left: Math.round(rect.left * 100) / 100,
      zoom: Math.round((Number.parseFloat(bar.style.zoom) || 1) * 100000) / 100000
    };
  });
}

(async () => {
  const server = await startTestServer({ withWeb: true });
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      // Older Chromium/CEF builds (common in classroom all-in-one PCs) report
      // the zoomed box here, unlike current Chromium.
      const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
        configurable: true,
        get() {
          const width = descriptor.get.call(this);
          const toolbar = this.id === 'annotationToolbar' || this.classList?.contains('blackboard-toolbar');
          if (!toolbar) return width;
          const zoom = Number.parseFloat(this.style.zoom) || 1;
          return Math.round(width * zoom);
        }
      });
      Element.prototype.requestFullscreen = async () => {};
    });
    await page.route('**/toolbar-fit.pdf', route => route.fulfill({ contentType: 'application/pdf', body: samplePdf() }));
    await page.goto(server.base + '/');
    await page.waitForFunction(() => !!state.roomCode);
    await page.evaluate(base => openCourseware({ url: base + '/toolbar-fit.pdf', page: 1, title: 'Toolbar fit' }), server.base);
    await page.waitForFunction(() => state.courseware?.displayedPage === 1);
    await page.locator('#annotationToolbar').waitFor({ state: 'visible' });

    const samples = [];
    for (let i = 0; i < 12; i++) {
      samples.push(await readToolbar(page));
      // "本页视频" refreshes its label on a 350 ms timer; that is the churn
      // that used to retrigger the fit loop.
      await page.waitForTimeout(350);
    }
    const zooms = [...new Set(samples.map(s => s.zoom))];
    const widths = [...new Set(samples.map(s => s.width))];
    assert.ok(zooms.length <= 1, `toolbar zoom must stay put, saw ${JSON.stringify(zooms)}`);
    assert.ok(widths.length <= 1, `toolbar width must stay put, saw ${JSON.stringify(widths)}`);
    const first = samples[0];
    assert.ok(first.width <= 800 - 32 + 1, `toolbar must fit the viewport, got ${first.width}`);
    if (zooms[0] === 1) throw new Error('test viewport must require toolbar scaling');

    // Growing the viewport must release the scaling, not leave it clamped.
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.waitForFunction(() => {
      const bar = document.getElementById('annotationToolbar');
      return (Number.parseFloat(bar.style.zoom) || 1) === 1;
    });
    const wide = await readToolbar(page);
    assert.equal(wide.zoom, 1, 'toolbar returns to its natural size after the viewport grows');
    assert.ok(wide.height > first.height, 'natural toolbar is taller than the scaled one');
    assert.deepEqual(errors, [], 'no page errors');
    console.log('PASS: responsive toolbar ignores zoom-dependent offsetWidth and stays still');
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
