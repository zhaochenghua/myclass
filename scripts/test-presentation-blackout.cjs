const { chromium } = require('playwright');
const { startTestServer } = require('../server/testSupport');
const assert = require('node:assert/strict');

function portraitPdf() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>'];
  for (const [i, color] of ['0.1 0.5 0.7', '0.2 0.7 0.3'].entries()) {
    const stream = `${color} rg 0 0 595 1684 re f\n`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 1684] /Contents ${4 + i * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
  }
  let pdf = '%PDF-1.4\n'; const offsets = [];
  objects.forEach((o, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  return Buffer.from(pdf + `xref\n0 7\n0000000000 65535 f \n` + offsets.map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

(async () => {
  const server = await startTestServer({ withWeb: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => { Element.prototype.requestFullscreen = async () => {}; });
    await page.route('**/portrait.pdf', r => r.fulfill({ contentType: 'application/pdf', body: portraitPdf() }));
    await page.route('**/portrait.pdf.metadata*', r => r.fulfill({ json: { conversion: null, videos: [] } }));
    await page.goto(server.base + '/');
    await page.waitForFunction(() => !!state.roomCode);
    // Keep the actual old connection so we can deliver delayed browser events after PDF opens.
    await page.evaluate(() => { window.oldConnection = state.peerConnection = createPeerConnection(); });
    await page.evaluate(url => openCourseware({ url, title: 'Portrait PDF', page: 1 }), server.base + '/portrait.pdf');
    await page.waitForFunction(() => state.courseware?.displayedPage === 1 && !state.courseware.prefetching);
    const checkVisible = () => page.evaluate(() => {
      const c = elements.coursewareCanvas, rect = c.getBoundingClientRect();
      const pixel = [...c.getContext('2d').getImageData(10, 10, 1, 1).data];
      return { mode: state.presentationMode, visible: !c.hidden, area: c.width * c.height,
        intersects: rect.left < innerWidth && rect.right > 0 && rect.top < innerHeight && rect.bottom > 0,
        pixel };
    });
    let visible = await checkVisible();
    assert.equal(visible.mode, 'courseware'); assert.ok(visible.visible && visible.intersects);
    assert.ok(visible.area <= 4 * 1024 * 1024); assert.ok(visible.pixel[2] > 100);
    await page.evaluate(() => {
      Object.defineProperty(oldConnection, 'connectionState', { value: 'connected' });
      oldConnection.dispatchEvent(new Event('connectionstatechange'));
      oldConnection.dispatchEvent(new Event('iceconnectionstatechange'));
      const canvas = document.createElement('canvas'); canvas.width = 90; canvas.height = 160;
      const stream = canvas.captureStream(1);
      const event = new Event('track'); Object.assign(event, { streams: [stream], track: stream.getVideoTracks()[0] });
      oldConnection.dispatchEvent(event);
      stream.getTracks().forEach(t => t.stop());
    });
    assert.deepEqual(await checkVisible(), visible, 'Late video callback hid the PDF');
    // Force a real render failure, then verify the lower-resolution retry paints page 2.
    await page.evaluate(() => {
      cancelCoursewarePrefetch(state.courseware); clearCoursewareRenderCache(state.courseware);
      const document = state.courseware.pdfDocument, getPage = document.getPage.bind(document);
      window.injectedFailures = 0;
      document.getPage = async number => {
        const page = await getPage(number);
        if (number === 2 && !page.testWrapped) {
          page.testWrapped = true; const render = page.render.bind(page);
          page.render = args => {
            if (!window.injectedFailures++) return { promise: Promise.reject(new Error('Injected allocation failure')), cancel() {} };
            return render(args);
          };
        }
        return page;
      };
      showCoursewarePage(2);
    });
    await page.waitForFunction(() => state.courseware?.displayedPage === 2);
    visible = await checkVisible();
    assert.ok(visible.visible && visible.pixel[1] > 100);
    assert.ok(visible.area <= 1024 * 1024);
    // Repeated portrait paging and viewport changes must keep visible pixels.
    for (const [width, height] of [[1280, 720], [800, 1280], [1920, 1080]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => showCoursewarePage(1));
      await page.waitForFunction(() => state.courseware?.displayedPage === 1 && !state.courseware.renderTask);
      const view = await checkVisible(); assert.ok(view.visible && view.intersects && view.pixel[2] > 100);
    }
    assert.deepEqual(errors, []);
    console.log('PASS: portrait PDF pixels at high DPI, bounded canvas memory, stale video events ignored, lower-resolution render retry, resize and navigation.');
  } finally { await browser.close(); await server.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
