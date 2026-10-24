// Run with Playwright + Edge: node scripts/test-infrared-ink.cjs
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { startTestServer } = require('../server/testSupport');

(async () => {
  const server = await startTestServer({ withWeb: true });
  const output = path.join(os.tmpdir(), 'myclass-infrared-ink-proof');
  await fs.mkdir(output, { recursive: true });
  let browser, page;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, hasTouch: true });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      Element.prototype.requestFullscreen = async () => {};
      localStorage.setItem('myclass.touchCalibration.v1', JSON.stringify({
        version: 1, width: 1280, height: 800, fullscreen: false,
        matrix: [1, 0, -24 / 1280, 0, 1, -16 / 800]
      }));
    });
    await page.goto(server.base + '/');
    await page.waitForFunction(() => !!state.roomCode);
    const image = await page.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 1280; c.height = 800;
      const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      return c.toDataURL().split(',')[1];
    });
    await page.route('**/infrared-ink.png', route => route.fulfill({ contentType: 'image/png', body: Buffer.from(image, 'base64') }));
    await page.evaluate(base => {
      window.inkSync = [];
      const send = sendViewerAnnotation;
      sendViewerAnnotation = message => { inkSync.push(structuredClone(message)); send(message); };
      openCourseware({ url: base + '/infrared-ink.png', title: 'Infrared ink test' });
    }, server.base);
    await page.waitForFunction(() => elements.coursewareImage.naturalWidth === 1280);
    // Input batch tests intentionally supply coalesced events, which CDP cannot
    // manufacture reliably. Dispatch through the real canvas event listeners.
    for (const board of [false, true]) {
      const result = await page.evaluate(async board => {
        toggleBlackboard(board);
        const canvas = board ? elements.blackboardCanvas : elements.annotationCanvas;
        const drawing = board ? state.blackboard : state.annotations;
        canvas.setPointerCapture = () => {};
        canvas.releasePointerCapture = () => {};
        const fire = (type, x, y, batch = []) => {
          const event = new PointerEvent(type, { pointerId: 41, pointerType: 'touch', isPrimary: true,
            bubbles: true, cancelable: true, clientX: x + 24, clientY: y + 16,
            button: 0, buttons: type === 'pointerup' ? 0 : 1 });
          Object.defineProperty(event, 'getCoalescedEvents', { configurable: true, value: () => batch.map(([x, y]) =>
            new PointerEvent('pointermove', { pointerId: 41, pointerType: 'touch',
              clientX: x + 24, clientY: y + 16 })) });
          canvas.dispatchEvent(event);
        };
        const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const snapshot = () => canvas.toDataURL();
        const screenPoints = stroke => stroke.points.map(point => board ? { x: point.x, y: point.y } :
          sourcePointToCanvasPoint(point, canvas.getBoundingClientRect(), currentVideoContentRect(), currentFrameCrop()));
        fire('pointerdown', 200, 300);
        fire('pointermove', 240, 320, [[210, 305], [220, 310], [230, 315]]);
        // A batch can make a loop even when its dispatched endpoint is unchanged.
        fire('pointermove', 240, 320, [[250, 330], [255, 320]]);
        fire('pointerup', 280, 330);
        await frame();
        const completed = board ? drawing.pages[0].strokes : drawing.strokes;
        const points = screenPoints(completed.at(-1));
        const syncId = inkSync.find(message => message.action === 'begin')?.strokeId;
        const syncedPoints = inkSync.filter(message => message.strokeId === syncId).flatMap(message => message.points || []);
        const completeSync = board || JSON.stringify(syncedPoints) === JSON.stringify(completed.at(-1).points);
        const committed = snapshot();
        if (board) renderBlackboard(); else drawAnnotations();
        const sameAfterRedraw = committed === snapshot();

        // Keep the start of an ongoing stroke stable as its tail grows.
        // perfect-freehand 每帧重建整条轮廓，已画部分允许极少量抗锯齿差异（<=2% 像素），
        // 但线宽 / 位置不能整体跳动——这正是红外屏最容易看出的"闪"。
        fire('pointerdown', 200, 450);
        for (let x = 210; x <= 500; x += 10) fire('pointermove', x, 450 + Math.sin(x / 45) * 12);
        await frame();
        const ratio = canvas.width / canvas.getBoundingClientRect().width;
        const prefix = () => canvas.getContext('2d').getImageData(190 * ratio, 420 * ratio, 170 * ratio, 60 * ratio).data;
        const diffRatio = (a, b) => {
          let diff = 0;
          for (let i = 0; i < a.length; i += 4) {
            if (Math.abs(a[i] - b[i]) > 8 || Math.abs(a[i + 1] - b[i + 1]) > 8 || Math.abs(a[i + 2] - b[i + 2]) > 8) diff++;
          }
          return diff / (a.length / 4);
        };
        const before = prefix();
        for (let x = 510; x <= 800; x += 10) fire('pointermove', x, 450 + Math.sin(x / 45) * 12);
        await frame();
        const prefixDiff = diffRatio(before, prefix());
        const stablePrefix = prefixDiff <= 0.02;
        const live = snapshot();
        fire('pointerup', 800, 450 + Math.sin(800 / 45) * 12);
        await frame();
        const stableCommit = live === snapshot();
        const beforeErase = snapshot();
        if (board) setBlackboardTool('eraser'); else setAnnotationTool('eraser');
        fire('pointerdown', 400, 420); fire('pointermove', 400, 480); fire('pointerup', 400, 480);
        await frame();
        const erased = snapshot() !== beforeErase;
        if (board) undoBlackboardStroke(); else undoAnnotationStroke();
        await frame();
        const undoRestored = snapshot() === beforeErase;
        if (board) clearBlackboard(); else clearAnnotations();
        await frame();
        const empty = board ? !drawing.pages[0].strokes.length : !drawing.strokes.length;
        if (board) setBlackboardTool('pen'); else setAnnotationTool('pen');
        return { points, completeSync, sameAfterRedraw, stablePrefix, prefixDiff, stableCommit, erased, undoRestored, empty };
      }, board);
      assert.equal(result.points.length, 9, JSON.stringify(result));
      const expected = [[200, 300], [210, 305], [220, 310], [230, 315], [240, 320], [250, 330], [255, 320], [240, 320], [280, 330]];
      result.points.forEach((p, i) => assert.ok(Math.abs(p.x - expected[i][0]) < 0.01 && Math.abs(p.y - expected[i][1]) < 0.01, JSON.stringify(p)));
      for (const key of ['completeSync', 'sameAfterRedraw', 'stablePrefix', 'stableCommit', 'erased', 'undoRestored', 'empty']) assert.equal(result[key], true, `${board ? 'board' : 'annotation'} ${key}: ${JSON.stringify(result)}`);
      console.log('PASS calibrated batches, endpoint, stable pixels, erase/undo/clear:', board ? 'blackboard' : 'annotation');
    }

    for (const board of [false, true]) {
      const metrics = await page.evaluate(async board => {
        toggleBlackboard(board);
        const drawing = board ? state.blackboard : state.annotations;
        const canvas = board ? elements.blackboardCanvas : elements.annotationCanvas;
        const strokes = board ? drawing.pages[0].strokes : drawing.strokes;
        const rect = canvas.getBoundingClientRect(), video = currentVideoContentRect(), crop = currentFrameCrop();
        const sourcePoint = (x, y) => board ? { x, y, p: .5 } : { ...pointerEventToSourcePoint({ clientX: x, clientY: y }, video, crop), p: .5 };
        for (let n = 0; n < 400; n++) strokes.push({ color: '#D00000', width: 4, mode: 'solid',
          points: Array.from({ length: 150 }, (_, i) => sourcePoint(80 + i * 6, 100 + n % 40 * 12 + Math.sin(i / 5) * 5)) });
        if (board) renderBlackboard(); else drawAnnotations();
        const original = board ? drawBlackboardStroke : drawAnnotationStroke;
        let historicalDraws = 0, liveDraws = 0;
        const history = new Set(strokes);
        const instrumented = (ctx, stroke, ...args) => {
          if (history.has(stroke)) historicalDraws++; else liveDraws++;
          original(ctx, stroke, ...args);
        };
        if (board) drawBlackboardStroke = instrumented; else drawAnnotationStroke = instrumented;
        const fire = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, {
          pointerId: 99, pointerType: 'mouse', isPrimary: true, bubbles: true, cancelable: true,
          clientX: x + rect.left + 24, clientY: y + rect.top + 16, button: 0, buttons: 1
        }));
        try {
          fire('pointerdown', 200, 600);
          for (let i = 1; i <= 30; i++) fire('pointermove', 200 + i * 20, 600 + Math.sin(i / 3) * 20);
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          return { historicalDraws, liveDraws, historyPoints: 60000, inputMoves: 30 };
        } finally {
          if (board) drawBlackboardStroke = original; else drawAnnotationStroke = original;
        }
      }, board);
      assert.equal(metrics.historicalDraws, 0, 'live input must not retrace completed strokes');
      assert.equal(metrics.liveDraws, 1, 'input burst should paint once per animation frame');
      await page.screenshot({ path: path.join(output, `dense-${board ? 'blackboard' : 'annotation'}.png`) });
      console.log('PASS dense page:', board ? 'blackboard' : 'annotation', metrics);
    }
    assert.deepEqual(errors, []);
    console.log('Screenshots:', output);
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    throw error;
  } finally { await browser?.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
