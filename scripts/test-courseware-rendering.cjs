// Real PDF.js rendering, with controlled stalls to expose intermediate frames.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { startTestServer } = require('../server/testSupport');

function samplePdf() {
  const colours = ['0.75 0.15 0.1', '0.1 0.25 0.8', '0.1 0.6 0.2', '0.55 0.15 0.7', '0.9 0.45 0.1', '0.1 0.65 0.65'];
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R 9 0 R 11 0 R 13 0 R] /Count 6 >>'];
  colours.forEach((colour, i) => {
    const height = i === 3 ? 600 : 400;
    const content = `${colour} rg 0 0 600 ${height} re f\n1 1 1 rg 30 30 ${40 * (i + 1)} 18 re f\n`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 ${height}] /Contents ${4 + 2 * i} 0 R >>`,
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`);
  });
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('');
  return Buffer.from(pdf + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

(async () => {
  const server = await startTestServer({ withWeb: true });
  const output = process.env.RENDER_TEST_OUTPUT || path.join(require('node:os').tmpdir(), 'myclass-render-proof');
  await fs.mkdir(output, { recursive: true });
  let browser, page;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : { channel: 'msedge' }) });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { Element.prototype.requestFullscreen = async () => {}; });
    const pdf = samplePdf();
    await page.route('**/render-check*.pdf', route => route.fulfill({ contentType: 'application/pdf', body: pdf }));
    await page.route('**/render-check*.pdf.metadata', route => route.fulfill({ json: { conversion: { slideCount: 3, statePages: [1, 1, 1, 2, 2, 3] } } }));
    await page.goto(server.base + '/');
    await page.waitForFunction(() => !!state.roomCode);
    const settled = async number => page.waitForFunction(n => state.courseware?.displayedPage === n && !state.courseware.renderTask && !state.courseware.prefetching, number);
    const open = async name => {
      await page.evaluate(url => openCourseware({ url, page: 1, title: 'Buffered page test' }), `${server.base}/${name}.pdf`);
      await settled(1);
    };
    const snapshot = () => page.evaluate(() => ({
      pixels: elements.coursewareCanvas.toDataURL(), ink: elements.annotationCanvas.toDataURL(),
      width: elements.coursewareCanvas.width, height: elements.coursewareCanvas.height,
      style: elements.coursewareCanvas.style.cssText
    }));
    const cacheBound = async () => {
      const cache = await page.evaluate(() => ({
        pages: [...state.courseware.renderCache.keys()], bytes: state.courseware.renderCacheBytes,
        actual: [...state.courseware.renderCache.values()].reduce((n, b) => n + b.canvas.width * b.canvas.height * 4, 0)
      }));
      assert.ok(cache.pages.length <= 3 && cache.bytes <= 64 * 1024 * 1024, JSON.stringify(cache));
      assert.equal(cache.bytes, cache.actual);
    };
    await open('render-check');
    assert.deepEqual(await page.evaluate(() => [...state.courseware.renderCache.keys()]), [1, 2]);
    // Count actual PDF.js render calls and gate selected tasks before they draw.
    await page.evaluate(() => {
      window.renderProbe = { calls: {}, holds: new Set(), failures: new Set(), gates: new Map(), messages: [], cancellations: 0 };
      const send = sendMessage;
      sendMessage = message => { renderProbe.messages.push(message); send(message); };
      const doc = state.courseware.pdfDocument;
      const getPage = doc.getPage.bind(doc);
      const wrapped = new WeakSet();
      doc.getPage = async number => {
        const pdfPage = await getPage(number);
        if (wrapped.has(pdfPage)) return pdfPage;
        wrapped.add(pdfPage);
        const render = pdfPage.render.bind(pdfPage);
        pdfPage.render = options => {
          renderProbe.calls[number] = (renderProbe.calls[number] || 0) + 1;
          if (renderProbe.failures.delete(number)) return { promise: Promise.reject(new Error('test prefetch failure')), cancel() {} };
          if (!renderProbe.holds.has(number)) return render(options);
          let task, cancelled = false, rejectTask;
          const promise = new Promise((resolve, reject) => {
            rejectTask = reject;
            renderProbe.gates.set(number, () => {
              renderProbe.holds.delete(number);
              renderProbe.gates.delete(number);
              if (cancelled) return;
              task = render(options);
              task.promise.then(resolve, reject);
            });
          });
          return { promise, cancel() {
            cancelled = true; renderProbe.cancellations++;
            task?.cancel();
            rejectTask(Object.assign(new Error('test cancellation'), { name: 'RenderingCancelledException' }));
          } };
        };
        return pdfPage;
      };
    });
    // A ready neighbour is displayed synchronously and never sent through PDF.js again.
    assert.equal(await page.evaluate(() => { navigatePage(1); return state.courseware.displayedPage; }), 2);
    await settled(2);
    assert.equal(await page.evaluate(() => renderProbe.calls[2] || 0), 0);
    assert.equal(await page.evaluate(() => { navigatePage(-1); return state.courseware.displayedPage; }), 1);
    await settled(1);
    // An optional prefetch error must not fail the displayed page or poison navigation.
    const callsBeforeFailure = await page.evaluate(() => renderProbe.calls[3] || 0);
    await page.evaluate(() => { renderProbe.failures.add(3); showCoursewarePage(2); });
    await settled(2);
    assert.equal(await page.evaluate(() => state.courseware.renderCache.has(3)), false);
    assert.equal(await page.locator('#videoStatus').textContent().then(text => text.includes('失败')), false);
    await page.evaluate(() => showCoursewarePage(3));
    await settled(3);
    assert.equal(await page.evaluate(() => renderProbe.calls[3]), callsBeforeFailure + 2);
    await page.evaluate(() => showCoursewarePage(1));
    await settled(1);
    await page.mouse.move(450, 300); await page.mouse.down(); await page.mouse.move(650, 380); await page.mouse.up();
    const before = await snapshot();
    await page.screenshot({ path: path.join(output, '01-before.png') });
    await page.evaluate(() => { renderProbe.holds.add(4); showCoursewarePage(4); });
    await page.waitForFunction(() => renderProbe.gates.has(4));
    // A teacher viewport for the incoming page must wait along with its pixels.
    await page.evaluate(() => {
      handleCoursewareImageViewport({ page: 4, scale: 1.5, centerX: .5, centerY: .5 });
      state.annotations.strokes.push({ points: [{ x: .2, y: .3 }, { x: .4, y: .3 }], color: '#0057B8', width: 4, page: 4 });
      drawAnnotations();
      reportViewerCoursewareViewport();
    });
    await page.evaluate(async () => { for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame); });
    assert.deepEqual(await snapshot(), before, 'old pixels, placement and ink stay intact while rendering');
    await page.mouse.move(480, 420); await page.mouse.down(); await page.mouse.move(600, 440); await page.mouse.up();
    assert.equal(await page.evaluate(() => state.annotations.strokes.length), 2, 'pending page cannot accept ink against old pixels');
    assert.equal(await page.evaluate(() => renderProbe.messages.some(m => m.type === 'viewer.courseware.viewport' && m.page === 4)), false);
    await page.screenshot({ path: path.join(output, '02-render-pending.png') });
    await page.evaluate(() => renderProbe.gates.get(4)());
    await settled(4);
    const after = await snapshot();
    assert.notEqual(after.pixels, before.pixels);
    assert.notEqual(after.ink, before.ink);
    assert.equal(await page.evaluate(() => state.imageView.scale), 1.5);
    assert.ok(await page.evaluate(() => renderProbe.messages.some(m => m.type === 'courseware.state' && m.page === 4)));
    await page.screenshot({ path: path.join(output, '03-render-committed.png') });
    await cacheBound();

    // Cancelling an in-progress neighbour must not keep it alive after navigation.
    await page.evaluate(() => {
      removeCoursewareCachedPage(state.courseware, 5);
      renderProbe.holds.add(5);
      void renderCoursewarePage();
    });
    await page.waitForFunction(() => renderProbe.gates.has(5));
    await page.evaluate(() => showCoursewarePage(2));
    await settled(2);
    await page.evaluate(() => renderProbe.gates.get(5)());
    assert.equal(await page.evaluate(() => state.courseware.displayedPage), 2);
    await page.evaluate(() => showCoursewarePage(4));
    await settled(4);

    // Rapid navigation cancels a cold render; releasing it later cannot roll back the screen.
    await page.evaluate(() => { renderProbe.holds.add(1); showCoursewarePage(1); });
    await page.waitForFunction(() => renderProbe.gates.has(1));
    await page.evaluate(() => showCoursewarePage(5));
    await settled(5);
    const latest = await snapshot();
    await page.evaluate(() => renderProbe.gates.get(1)());
    await page.evaluate(async () => { for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame); });
    assert.deepEqual(await snapshot(), latest);
    assert.ok(await page.evaluate(() => renderProbe.cancellations > 0));
    await cacheBound();
    await page.evaluate(() => { renderProbe.failures.add(1); showCoursewarePage(1); });
    await page.waitForFunction(() => elements.videoStatus.textContent.includes('页面渲染失败'));
    assert.deepEqual(await snapshot(), latest, 'a failed foreground render keeps the previous page');
    await page.evaluate(() => showCoursewarePage(5));
    await settled(5);

    // Resize invalidates cached pixel dimensions and releases their backing stores.
    await page.evaluate(() => { window.oldBuffers = [...state.courseware.renderCache.values()]; });
    await page.setViewportSize({ width: 960, height: 640 });
    await page.waitForFunction(() => state.courseware.cssWidth === 960);
    await settled(5);
    assert.equal(await page.evaluate(() => state.courseware.cssWidth), 960);
    assert.ok(await page.evaluate(() => oldBuffers.every(b => b.canvas.width === 1 && b.canvas.height === 1)));
    await cacheBound();

    // Closing a document during rendering cancels both work and retained canvases.
    await page.evaluate(() => { renderProbe.holds.add(2); showCoursewarePage(2); });
    await page.waitForFunction(() => renderProbe.gates.has(2));
    await page.evaluate(() => {
      window.closedDocument = state.courseware;
      window.closedBuffers = [...state.courseware.renderCache.values()];
      closeCourseware();
      renderProbe.gates.get(2)();
    });
    await page.evaluate(async () => { for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame); });
    assert.ok(await page.evaluate(() => !state.courseware && closedDocument.renderCache.size === 0 && closedDocument.renderCacheBytes === 0 && closedBuffers.every(b => b.canvas.width === 1)));
    await open('render-check-other');
    assert.equal(await page.evaluate(() => state.courseware.displayedPage), 1);

    // A narrow viewport and high-DPI desktop use the same bounded render path.
    for (const viewport of [{ width: 390, height: 844 }, { width: 1920, height: 1080 }]) {
      await page.setViewportSize(viewport);
      await page.waitForFunction(width => state.courseware.cssWidth === width, viewport.width);
      await settled(1);
      if (viewport.width === 1920) {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 2, mobile: false });
        await page.evaluate(() => renderCoursewarePage());
      }
      await settled(1);
      await page.evaluate(() => showCoursewarePage(4));
      await settled(4);
      await cacheBound();
      if (viewport.width === 1920) {
        assert.equal(await page.evaluate(() => devicePixelRatio), 2);
        assert.equal(await page.evaluate(() => elements.coursewareCanvas.width), 4096);
      }
      const colour = await page.evaluate(() => [...elements.coursewareCanvas.getContext('2d').getImageData(10, 10, 1, 1).data]);
      assert.ok(colour[0] > 100 && colour[2] > 100 && colour[1] < 80, JSON.stringify(colour));
      await page.screenshot({ path: path.join(output, `04-${viewport.width}.png`) });
      await page.evaluate(() => showCoursewarePage(1));
      await settled(1);
    }
    assert.deepEqual(errors, []);
    console.log(`PASS: atomic pixels/ink/viewport, prefetched forward/back, cancellation, resize, close/switch, cache bounds, desktop/mobile; screenshots: ${output}`);
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    throw error;
  } finally { await browser?.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
