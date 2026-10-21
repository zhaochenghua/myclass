// Genuine browser touch input: reject infrared false contacts and confirm pinches.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { startTestServer } = require('../server/testSupport');

function pdfFixture() {
  const content = '0.9 0.95 1 rg 0 0 600 400 re f\n';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 400] /Contents 4 0 R >>',
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
  const server = process.env.MYCLASS_TEST_BASE_URL
    ? { base: process.env.MYCLASS_TEST_BASE_URL.replace(/\/+$/, ''), close: async () => {} }
    : await startTestServer({ withWeb: true });
  const output = process.env.PINCH_TEST_OUTPUT || path.join(os.tmpdir(), 'myclass-handwriting-pinch-proof');
  await fs.mkdir(output, { recursive: true });
  let browser, page;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 }, hasTouch: true });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => { Element.prototype.requestFullscreen = async () => {}; });
    await page.route('**/pinch-check.pdf', route => route.fulfill({ contentType: 'application/pdf', body: pdfFixture() }));
    await page.route('**/pinch-check.pdf.metadata*', route => route.fulfill({ json: { conversion: null, videos: [] } }));
    await page.goto(server.base + '/');
    await page.waitForFunction(() => !!state.roomCode);
    const image = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 400;
      const c = canvas.getContext('2d'); c.fillStyle = '#f1f5f9'; c.fillRect(0, 0, 600, 400);
      c.fillStyle = '#0057b8'; c.fillRect(40, 40, 120, 120); return canvas.toDataURL();
    });
    await page.route('**/pinch-check.png', route => route.fulfill({ contentType: 'image/png', body: Buffer.from(image.split(',')[1], 'base64') }));
    await page.evaluate(() => {
      window.gestureMessages = [];
      const send = sendMessage;
      sendMessage = message => { gestureMessages.push(message); send(message); };
    });
    const cdp = await page.context().newCDPSession(page);
    const point = (id, x, y = 350) => ({ id, x, y });
    const touch = async (type, touchPoints) => {
      await cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
      // Chromium delivers multi-touch moves on its compositor frame.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    const read = blackboard => page.evaluate(board => ({
      count: board ? state.blackboard.pages[state.blackboard.currentPage].strokes.length : state.annotations.strokes.length,
      local: [...(board ? state.blackboard : state.annotations).activeStrokes.keys()].filter(id => typeof id === 'number').length,
      scale: board ? state.blackboard.scale : currentContentKind() !== 'none' ? state.imageView.scale : state.lockedVideoPan.scale,
      tool: (board ? state.blackboard : state.annotations).tool,
      pendingSync: viewerStrokeIds.size,
      gesture: handwritingTouches.has(board ? elements.blackboardCanvas : elements.annotationCanvas)
    }), blackboard);
    for (const kind of ['pdf', 'image', 'camera', 'locked-camera', 'screen', 'blackboard']) {
      const blackboard = kind === 'blackboard';
      await page.evaluate(({ kind, base }) => {
        toggleBlackboard(false); closeCourseware();
        if (kind === 'blackboard') { toggleBlackboard(true); clearBlackboard(); }
        else if (kind === 'pdf' || kind === 'image') openCourseware({ url: `${base}/pinch-check.${kind === 'pdf' ? 'pdf' : 'png'}`, page: 1, title: 'Touch gesture check' });
        else {
          showVideoView();
          handleTeacherOrientation({ orientation: 'landscape', rotationDegrees: 90, cameraFacing: kind === 'screen' ? 'unknown' : 'back', frameLocked: kind === 'locked-camera' });
        }
      }, { kind, base: server.base });
      if (kind === 'pdf') await page.waitForFunction(() => state.courseware?.displayedPage === 1 && !state.courseware.prefetching);
      if (kind === 'image') await page.waitForFunction(() => elements.coursewareImage.naturalWidth > 0);
      for (const tool of ['pen', 'eraser']) {
        await page.evaluate(({ blackboard, tool }) => {
          if (blackboard) setBlackboardTool(tool); else setAnnotationTool(tool);
          gestureMessages.length = 0;
        }, { blackboard, tool });
        for (const scenario of ['close', 'stationary', 'together', 'late', 'long-stroke', 'jitter', 'held-contact']) {
          const before = await read(blackboard);
          await touch('touchStart', [point(1, 450)]);
          await touch('touchMove', [point(1, 470, 370)]);
          if (scenario === 'late') await page.waitForTimeout(350);
          if (scenario === 'long-stroke') {
            await touch('touchMove', [point(1, 500, 400)]);
            await touch('touchMove', [point(1, 470, 370)]);
          }
          const other = scenario === 'close' ? 475 : 700;
          await touch('touchStart', [point(1, 470, 370), point(2, other, 370)]);
          assert.equal((await read(blackboard)).local, 1, `${kind}/${tool}/${scenario}: preserve ink at second contact`);
          if (scenario === 'held-contact') await page.waitForTimeout(450);
          let firstX = 400, secondX = 770;
          if (scenario === 'stationary') secondX = other;
          if (scenario === 'together') { firstX = 530; secondX = 760; }
          if (scenario === 'jitter') { firstX = 468; secondX = 702; }
          await touch('touchMove', [point(1, firstX, 370), point(2, secondX, 370)]);
          let guarded = await read(blackboard);
          assert.equal(guarded.scale, before.scale, `${kind}/${tool}/${scenario}: no false zoom`);
          assert.equal(guarded.local, 1, `${kind}/${tool}/${scenario}: keep writing`);
          assert.equal(guarded.count, before.count, 'do not split the current stroke');
          await touch('touchEnd', [point(1, firstX, 370)]);
          await touch('touchStart', [point(2, secondX, 370), point(3, 950, 370)]);
          await touch('touchMove', [point(2, secondX - 60, 370), point(3, 1010, 370)]);
          guarded = await read(blackboard);
          assert.equal(guarded.scale, before.scale, 'remaining contacts cannot become a replacement pinch');
          assert.equal(guarded.local, 0, 'remaining contacts cannot start ink');
          assert.equal(guarded.count, before.count + 1, 'only the owner saves a stroke');
          await touch('touchEnd', []);
          assert.equal((await read(blackboard)).gesture, false);
        }
        await page.evaluate(() => { gestureMessages.length = 0; });
        if (kind === 'pdf' || kind === 'image') await page.evaluate(() => handleTeacherAnnotation({
          action: 'begin', strokeId: 'remote-check', points: [{ x: 0.2, y: 0.2 }], page: 1
        }));
        const initial = await read(blackboard);
        await touch('touchStart', [point(1, 450)]);
        await touch('touchMove', [point(1, 470, 370)]);
        assert.equal((await read(blackboard)).local, 1, `${kind}/${tool}: one local stroke`);
        await touch('touchStart', [point(1, 470, 370), point(2, 700, 370)]);
        let current = await read(blackboard);
        assert.equal(current.local, 1, 'second contact alone cannot interrupt ink');
        assert.equal(current.count, initial.count);
        await touch('touchMove', [point(1, 400, 370), point(2, 770, 370)]);
        current = await read(blackboard);
        assert.equal(current.local, 0);
        assert.equal(current.count, initial.count + 1, 'finish existing ink once');
        assert.equal(current.scale, initial.scale, 'confirm pinch without a viewport jump');
        await touch('touchMove', [point(1, 760, 370), point(2, 770, 370)]);
        assert.equal((await read(blackboard)).scale, initial.scale, 'coordinate collapse cannot shrink the viewport');
        await touch('touchMove', [point(1, 400, 370), point(2, 770, 370)]);
        assert.equal((await read(blackboard)).scale, initial.scale, 'recovery from a coordinate spike cannot zoom');
        await touch('touchMove', [point(1, 340, 370), point(2, 830, 370)]);
        await touch('touchMove', [point(1, 280, 370), point(2, 890, 370)]);
        current = await read(blackboard);
        assert.ok(current.scale > initial.scale * 1.4, `${kind}/${tool}: pinch must zoom ${JSON.stringify({ initial, current })}`);
        assert.equal(current.tool, tool, 'keep selected tool');
        const enlarged = current.scale;
        await touch('touchStart', [point(1, 280, 370), point(2, 890, 370), point(3, 1000, 420)]);
        await touch('touchMove', [point(1, 280, 370), point(2, 890, 370), point(3, 1050, 460)]);
        assert.equal((await read(blackboard)).scale, enlarged, 'third finger cannot reset zoom');
        await touch('touchEnd', [point(3, 1050, 460)]);
        await touch('touchMove', [point(1, 450, 370), point(2, 720, 370)]);
        assert.ok((await read(blackboard)).scale < enlarged, 'pinch inward must shrink');
        await touch('touchEnd', [point(1, 450, 370)]);
        await touch('touchMove', [point(2, 780, 410)]);
        assert.equal((await read(blackboard)).count, initial.count + 1, 'remaining finger must not draw');
        await touch('touchEnd', []);
        current = await read(blackboard);
        assert.equal(current.local, 0); assert.equal(current.gesture, false); assert.equal(current.pendingSync, 0);
        await touch('touchStart', [point(1, 580, 400)]);
        await touch('touchMove', [point(1, 620, 440)]);
        await touch('touchEnd', []);
        assert.equal((await read(blackboard)).count, initial.count + 2, 'fresh touch resumes ink');
        if (kind === 'pdf' || kind === 'image') {
          const sync = await page.evaluate(() => gestureMessages.filter(m => m.type === 'viewer.annotation'));
          const begins = sync.filter(m => m.action === 'begin'), ends = sync.filter(m => m.action === 'end');
          assert.equal(begins.length, 2); assert.equal(ends.length, 2);
          assert.deepEqual(begins.map(m => m.strokeId), ends.map(m => m.strokeId));
          assert.equal(await page.evaluate(() => state.annotations.activeStrokes.has('teacher:remote-check')), true);
          await page.evaluate(() => handleTeacherAnnotation({ action: 'end', strokeId: 'remote-check', page: 1 }));
        }
      }
      // Cancellation must clear pinch state, then allow a fresh single stroke.
      await touch('touchStart', [point(1, 500), point(2, 700)]);
      await touch('touchMove', [point(1, 460), point(2, 740)]);
      await touch('touchCancel', []);
      assert.equal((await read(blackboard)).gesture, false);
      await page.evaluate(board => { if (board) setBlackboardTool('pen'); else setAnnotationTool('pen'); }, blackboard);
      const beforeMouse = await read(blackboard);
      await page.mouse.move(500, 450); await page.mouse.down(); await page.mouse.move(550, 470); await page.mouse.up();
      assert.equal((await read(blackboard)).count, beforeMouse.count + 1, 'mouse ink remains usable');
      await page.evaluate(board => { if (board) setBlackboardTool('hand'); else setAnnotationTool('pan'); }, blackboard);
      const beforeHand = await read(blackboard);
      await touch('touchStart', [point(1, 450), point(2, 650)]);
      await touch('touchMove', [point(1, 400), point(2, 700)]);
      await touch('touchEnd', []);
      const afterHand = await read(blackboard);
      assert.ok(afterHand.scale > beforeHand.scale, `${kind}: existing hand pinch must work`);
      assert.equal(afterHand.count, beforeHand.count);
      assert.equal(afterHand.local, 0);
      await page.evaluate(board => { if (board) setBlackboardTool('pen'); else setAnnotationTool('pen'); }, blackboard);
      await page.screenshot({ path: path.join(output, `${kind}.png`) });
      console.log(`PASS: ${kind} pen/eraser false-contact guards, confirmed pinch and hand tool`);
    }
    assert.deepEqual(errors, []);
    console.log(`PASS: actual touch on PDF/image/live/locked/screen/blackboard, false contacts, pen/eraser, confirmed zoom in/out, third finger, release/cancel, fresh ink, mouse, hand tool, remote ink and sync; screenshots: ${output}`);
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    throw error;
  } finally { await browser?.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
