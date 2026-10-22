const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { startTestServer } = require('../server/testSupport');

function pdfFixture(height = 900) {
  const content = `0.9 0.95 1 rg 0 0 600 ${height} re f\n0.8 0.1 0.2 rg 30 ${height - 180} 300 100 re f\n`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 ${height}] /Contents 4 0 R >>`,
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, i) => {
    const offset = Buffer.byteLength(pdf); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; return offset;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += 'xref\n0 5\n0000000000 65535 f \n';
  pdf += offsets.map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('');
  return Buffer.from(pdf + `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

(async () => {
  const server = await startTestServer({ withWeb: true });
  const output = path.join(os.tmpdir(), 'myclass-ios-resume-viewport-proof');
  await fs.mkdir(output, { recursive: true });
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true,
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
    for (const viewport of [{ width: 390, height: 844 }, { width: 1024, height: 1366 }]) {
      const context = await browser.newContext({ viewport, permissions: ['camera'], serviceWorkers: 'block' });
      const errors = [];
      context.on('page', p => p.on('pageerror', e => errors.push(e.message)));
      await context.addInitScript(() => {
        try { localStorage.setItem('myclass.ios.token', JSON.stringify('alice-test-token')); } catch { /* opaque media frame */ }
        Element.prototype.requestFullscreen = async () => {};
      });
      await context.route('**/resume-check.pdf', r => r.fulfill({ contentType: 'application/pdf', body: pdfFixture() }));
      await context.route('**/resume-check.pdf.metadata*', r => r.fulfill({ json: { conversion: null, videos: [] } }));
      await context.route('**/resume-square.pdf', r => r.fulfill({ contentType: 'application/pdf', body: pdfFixture(600) }));
      await context.route('**/resume-square.pdf.metadata*', r => r.fulfill({ json: { conversion: null, videos: [] } }));
      const source = await fs.readFile(path.join(__dirname, '../web/ios/js/app.js'), 'utf8');
      await context.route('**/ios/js/app.js?*', r => r.fulfill({ contentType: 'application/javascript', body: source + `
        window.probe = { state, openCourseware, connectToRoom, openCameraLive, startLive,
          switchToReadyMediaItem, zoomByMedia, applyCoursewareGesture, jumpToCoursewarePage,
          handleViewerCoursewareViewport, requestCoursewareScreenStep };
      ` }));
      const viewer = await context.newPage();
      await viewer.setViewportSize({ width: 1280, height: 800 });
      await viewer.goto(server.base + '/');
      await viewer.waitForFunction(() => !!state.roomCode);
      const code = await viewer.evaluate(() => state.roomCode);
      const phone = await context.newPage();
      await phone.goto(server.base + '/ios/');
      await phone.waitForFunction(() => window.probe?.state.screen === 'Connect');
      for (let attempt = 0; attempt < 2; attempt++) {
        await phone.locator('#manageCoursewareButton').click();
        await phone.waitForFunction(() => probe.state.screen === 'CoursewareList');
        await phone.locator('#cwListRefresh').click();
        await phone.locator('#cwListBack').click();
        await phone.screenshot({ path: path.join(output, `management-back-${viewport.width}.png`) });
        assert.equal(await phone.evaluate(() => probe.state.screen), 'Connect');
        assert.equal(await phone.locator('#viewMenu').isVisible(), false);
        assert.equal(await phone.evaluate(() => probe.state.joined), false);
      }
      await phone.evaluate(code => probe.connectToRoom(code), code);
      await phone.waitForFunction(() => probe.state.joined);
      await phone.locator('#menuCourseware').click();
      await phone.locator('#cwServerButton').click();
      await phone.locator('#cwListBack').click();
      assert.equal(await phone.evaluate(() => probe.state.screen), 'Menu');
      await phone.evaluate(() => {
        window.sent = [];
        const send = probe.state.signaling.send.bind(probe.state.signaling);
        probe.state.signaling.send = m => { sent.push(m); return send(m); };
        window.hiddenForTest = false;
        Object.defineProperty(document, 'visibilityState', { get: () => hiddenForTest ? 'hidden' : 'visible' });
      });
      const reconnect = async () => {
        await phone.evaluate(() => {
          hiddenForTest = true;
          document.dispatchEvent(new Event('visibilitychange'));
          probe.state.signaling.socket.close();
        });
        await viewer.waitForFunction(() => !state.teacherConnected);
        await phone.waitForFunction(() => !probe.state.joined);
        await phone.waitForFunction(() => probe.state.joined);
        await phone.evaluate(() => { hiddenForTest = false; document.dispatchEvent(new Event('visibilitychange')); });
      };

      await phone.evaluate(url => probe.openCourseware({ url, title: 'Resume check' }), server.base + '/resume-check.pdf');
      await phone.waitForFunction(() => probe.state.cwPdf.doc && !probe.state.cwPdf.rendering && probe.state.cwBoard.enabled);
      await viewer.waitForFunction(() => state.courseware?.displayedPage === 1);
      await viewer.evaluate(() => zoomImageViewAt(2.5));
      await phone.waitForFunction(() => !document.getElementById('cwViewerViewport').hidden);
      assert.equal(await phone.evaluate(() => probe.state.cwView.scale), 1);
      await viewer.evaluate(() => panImageViewTo(0.5, 0.5, -100, -200));
      await phone.waitForTimeout(200);
      const remote = await viewer.evaluate(() => {
        const viewport = elements.videoView.getBoundingClientRect();
        const content = elements.coursewareCanvas.getBoundingClientRect();
        return { left: clamp((viewport.left - content.left) / content.width, 0, 1),
          top: clamp((viewport.top - content.top) / content.height, 0, 1),
          right: clamp((viewport.right - content.left) / content.width, 0, 1),
          bottom: clamp((viewport.bottom - content.top) / content.height, 0, 1) };
      });
      const mapped = await phone.evaluate(() => {
        const content = document.getElementById('cwPageCanvas').getBoundingClientRect();
        const rect = document.getElementById('cwViewerViewport').getBoundingClientRect();
        return { left: (rect.left - content.left) / content.width,
          top: (rect.top - content.top) / content.height,
          right: (rect.right - content.left) / content.width,
          bottom: (rect.bottom - content.top) / content.height };
      });
      for (const edge of ['left', 'top', 'right', 'bottom']) assert.ok(Math.abs(mapped[edge] - remote[edge]) < 0.002, edge);
      const count = await phone.evaluate(() => sent.filter(m => m.type === 'courseware.image.viewport').length);
      await phone.waitForTimeout(200);
      assert.equal(await phone.evaluate(() => sent.filter(m => m.type === 'courseware.image.viewport').length), count);
      await phone.screenshot({ path: path.join(output, `pdf-range-${viewport.width}.png`) });
      await phone.evaluate(() => {
        const before = document.getElementById('cwViewerViewport').style.cssText;
        const cw = probe.state.courseware;
        const report = { width: 1600, height: 900, left: 0, top: 0, right: 1, bottom: 1, url: cw.url, page: cw.page };
        for (const invalid of [{ url: '/old.pdf' }, { page: cw.page + 1 }, { width: 0 }, { left: -1 }, { bottom: NaN }]) {
          probe.handleViewerCoursewareViewport({ ...report, ...invalid });
          if (document.getElementById('cwViewerViewport').style.cssText !== before) throw Error('stale or invalid report changed overlay');
        }
        probe.handleViewerCoursewareViewport(report);
      });
      assert.equal(await phone.locator('#cwViewerViewport').isVisible(), false);
      await phone.evaluate(() => probe.applyCoursewareGesture({ factor: 3 }));
      await viewer.waitForFunction(() => Math.abs(state.imageView.scale - 3) < 0.01);
      await reconnect();
      assert.equal(await phone.evaluate(() => probe.state.screen), 'CoursewarePlay');
      await viewer.waitForFunction(() => Math.abs(state.imageView.scale - 3) < 0.01);
      await phone.screenshot({ path: path.join(output, `pdf-${viewport.width}.png`) });

      await phone.evaluate(url => probe.openCourseware({ url, title: 'Range drag check' }), server.base + '/resume-square.pdf');
      await phone.waitForFunction(() => probe.state.cwPdf.url.endsWith('resume-square.pdf') && !probe.state.cwPdf.rendering && probe.state.cwBoard.enabled);
      await viewer.waitForFunction(() => state.courseware?.url.endsWith('resume-square.pdf') && state.courseware.displayedPage === 1);
      await phone.waitForTimeout(200);
      assert.equal(await phone.evaluate(() => probe.requestCoursewareScreenStep(1)), true,
        'Android advances the page when the remaining screen content fits in one step');
      await viewer.evaluate(() => zoomImageViewAt(2.5));
      await phone.waitForFunction(() => !document.getElementById('cwViewerViewport').hidden);
      await phone.evaluate(() => {
        const stage = document.getElementById('cwStage');
        const rect = stage.getBoundingClientRect();
        const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
        const touch = atY => new Touch({ identifier: 1, target: stage, clientX: x, clientY: atY });
        stage.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch(y)] }));
        for (let offset = 15; offset <= 60; offset += 15) {
          stage.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, cancelable: true, touches: [touch(y - offset)] }));
        }
        stage.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [], changedTouches: [touch(y - 60)] }));
      });
      await viewer.waitForFunction(() => state.pendingTeacherViewport?.progress === true && state.pendingTeacherViewport.centerY > 0);
      assert.equal(await phone.evaluate(() => probe.state.cwView.scale), 1);
      await phone.screenshot({ path: path.join(output, `pdf-range-drag-${viewport.width}.png`) });

      const image = await phone.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 400;
        const c = canvas.getContext('2d'); c.fillStyle = '#d9f1ec'; c.fillRect(0, 0, 600, 400);
        c.fillStyle = '#c22'; c.fillRect(60, 40, 180, 160); return canvas.toDataURL();
      });
      await context.route('**/resume-check.png', r => r.fulfill({ contentType: 'image/png', body: Buffer.from(image.split(',')[1], 'base64') }));
      await phone.evaluate(url => {
        probe.state.media.queue = [{ kind: 'image', url, title: 'Zoom check', status: 'ready', scale: 1 }];
        probe.switchToReadyMediaItem(0);
      }, server.base + '/resume-check.png');
      await viewer.waitForFunction(() => isImageViewVisible() && elements.coursewareImage.complete);
      await viewer.evaluate(() => zoomImageViewAt(2));
      await phone.waitForTimeout(200);
      assert.equal(await phone.evaluate(() => probe.state.media.queue[0].scale), 1);
      await phone.evaluate(() => probe.zoomByMedia(3));
      await viewer.waitForFunction(() => state.imageView.scale === 3);
      await reconnect();
      assert.equal(await phone.evaluate(() => probe.state.screen), 'MediaCast');
      await viewer.waitForFunction(() => state.imageView.scale === 3);
      await phone.screenshot({ path: path.join(output, `image-${viewport.width}.png`) });

      await phone.evaluate(() => probe.openCameraLive());
      await phone.waitForFunction(() => probe.state.pipeline.track?.readyState === 'live');
      await reconnect();
      assert.equal(await phone.evaluate(() => probe.state.screen), 'Live');
      assert.equal(await phone.evaluate(() => probe.state.liveActive), false);
      await phone.evaluate(() => probe.startLive());
      await viewer.waitForFunction(() => elements.remoteVideo.videoWidth > 0 && state.presentationMode === 'video');
      await viewer.evaluate(() => zoomLockedVideo(2, { x: 640, y: 400 }));
      await phone.waitForTimeout(200);
      assert.equal(await phone.evaluate(() => probe.state.pipeline.zoom), 1);
      await phone.evaluate(() => probe.state.pipeline.zoomBy(2));
      await viewer.waitForFunction(() => Math.abs(state.framePresentation.lockedFrameZoomRatio - 2) < 0.01);
      await phone.evaluate(() => {
        probe.state.pipeline.setLocked(true);
        probe.state.pipeline.cameraStream.getVideoTracks()[0].stop();
      });
      await reconnect();
      await phone.waitForFunction(() => probe.state.screen === 'Live' && probe.state.liveActive && probe.state.pipeline.cameraStream.getVideoTracks()[0].readyState === 'live');
      assert.equal(await phone.evaluate(() => probe.state.pipeline.locked), true);
      assert.equal(await phone.evaluate(() => probe.state.pipeline.zoom), 2);
      await phone.waitForFunction(() => !document.getElementById('liveStatus').dataset.userMessage);
      await phone.screenshot({ path: path.join(output, `camera-${viewport.width}.png`) });
      assert.deepEqual(errors, []);
      console.log(`PASS ${viewport.width}x${viewport.height}: shared PDF range overlay/drag, Android screen-step behavior, phone zoom, reconnect, locked-frame recovery`);
      await context.close();
    }
    console.log(`Screenshots: ${output}`);
  } finally { await browser?.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
