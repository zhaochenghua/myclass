// Browser integration test. Requires Playwright and Chrome/Edge (or BROWSER_PATH).
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { startTestServer } = require('../server/testSupport');

(async () => {
  const server = await startTestServer({ withWeb: true });
  let browser, page;
  const output = process.env.CALIBRATION_TEST_OUTPUT || path.join(require('node:os').tmpdir(), 'myclass-calibration-proof');
  await fs.mkdir(output, { recursive: true });
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : { channel: 'msedge' }) });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 }, hasTouch: true });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${server.base}/`);
    await page.waitForFunction(() => document.getElementById('roomCode').textContent.match(/^\d{4}$/));
    await page.getByRole('button', { name: '触屏校准', exact: true }).click();
    const calibrate = async () => {
      await page.locator('#touchCalibrationStart').click();
      for (let i = 0; i < 5; i++) {
        const target = await page.locator('#touchCalibrationTarget').boundingBox();
        // Synthetic hardware error: reports 24px right and 16px down.
        await page.mouse.click(target.x + target.width / 2 + 24, target.y + target.height / 2 + 16);
      }
      await page.locator('#touchCalibrationSave').waitFor({ state: 'visible' });
    };
    await calibrate();
    await page.mouse.move(450, 430); await page.mouse.down(); await page.mouse.move(750, 580, { steps: 20 }); await page.mouse.up();
    await page.screenshot({ path: path.join(output, '01-preview.png') });
    await page.locator('#touchCalibrationSave').click();
    await page.waitForFunction(() => document.getElementById('touchCalibrationMessage').textContent.includes('已保存到此浏览器'));
    assert.ok(await page.evaluate(() => localStorage.getItem('myclass.touchCalibration.v1')));
    await page.reload();
    await page.waitForFunction(() => typeof TouchCalibration !== 'undefined');
    // Reopening calibration also dismisses first-click fullscreen, so this
    // non-fullscreen profile remains valid during the following toolbar tests.
    await page.getByRole('button', { name: '触屏校准', exact: true }).click();
    await page.locator('#touchCalibrationClose').click();
    let p = await page.evaluate(() => { const e = TouchCalibration.eventFor(new PointerEvent('pointermove', { clientX: 500, clientY: 400 })); return [e.clientX, e.clientY]; });
    assert.ok(Math.abs(p[0] - 476) < 1 && Math.abs(p[1] - 384) < 1);
    assert.deepEqual(await page.evaluate(() => [state.annotations.currentColor, state.blackboard.currentColor]), ['#D00000', '#D00000']);
    const toolbarClick = async (selector, touch = false) => {
      const button = page.locator(selector);
      const rect = await button.boundingBox();
      assert.ok(rect, selector);
      const raw = { x: rect.x + rect.width - 4 + 24, y: rect.y + rect.height / 2 + 16 };
      assert.equal(await button.evaluate((el, raw) => el.contains(document.elementFromPoint(raw.x, raw.y)), raw), false,
        selector + ': test must miss the uncalibrated button');
      if (touch) await page.touchscreen.tap(raw.x, raw.y);
      else await page.mouse.click(raw.x, raw.y);
    };
    const checkToolbar = async (prefix, touch) => {
      const blackboard = prefix === 'blackboard';
      const tools = () => page.evaluate(blackboard => {
        const s = blackboard ? state.blackboard : state.annotations;
        return { tool: s.tool, color: s.currentColor, mode: s.mode,
          strokes: blackboard ? s.pages[s.currentPage].strokes.length : s.strokes.length };
      }, blackboard);
      const before = (await tools()).strokes;
      await toolbarClick(`#${prefix}EraserButton`, touch);
      assert.equal((await tools()).tool, 'eraser');
      await toolbarClick(`#${prefix}Colors [data-color="#0057B8"]`, touch);
      assert.equal((await tools()).color, '#0057B8');
      assert.equal((await tools()).tool, 'pen');
      await toolbarClick(`#${prefix}ModeMenu [data-mode="dashed"]`, touch);
      assert.equal((await tools()).mode, 'dashed');
      await toolbarClick(`#${prefix}MoreColorsButton`, touch);
      await toolbarClick(`#${prefix}MoreColorsButton`, touch);
      await toolbarClick(`#${prefix}MoreColorsMenu [data-color="#7B2CBF"]`, touch);
      assert.equal((await tools()).color, '#7B2CBF');
      await toolbarClick(`#${prefix}ModeMenu [data-mode="solid"]`, touch);
      assert.equal((await tools()).mode, 'solid');
      assert.equal((await tools()).strokes, before, 'toolbar taps must not leave ink');
      // Keyboard activation must retain its native target regardless of pointer calibration.
      await page.locator(`#${prefix}EraserButton`).press('Enter');
      assert.equal((await tools()).tool, 'eraser');
      await toolbarClick(`#${prefix}Colors [data-color="#D00000"]`, touch);
      assert.equal((await tools()).color, '#D00000');
      await toolbarClick(`#${prefix}ModeMenu [data-mode="solid"]`, touch);
    };
    // Actual blackboard listeners receive corrected points, including native pointer capture.
    await page.evaluate(() => toggleBlackboard(true));
    await page.mouse.move(500, 400); await page.mouse.down(); await page.mouse.move(600, 450); await page.mouse.up();
    const ink = await page.evaluate(() => state.blackboard.pages[0].strokes[0].points[0]);
    assert.ok(Math.abs(ink.x - 476) < 1 && Math.abs(ink.y - 384) < 1, JSON.stringify(ink));
    assert.equal(await page.evaluate(() => state.blackboard.pages[0].strokes[0].color), '#D00000');
    await checkToolbar('blackboard', false);
    await checkToolbar('blackboard', true);
    // A physical stroke above the toolbar may be reported inside it. Route it
    // back to the canvas without applying calibration twice.
    const edge = await page.locator('.blackboard-toolbar').boundingBox();
    const edgeStart = { x: edge.x + edge.width / 2, y: edge.y - 8 };
    const strokesBefore = await page.evaluate(() => state.blackboard.pages[0].strokes.length);
    await page.mouse.move(edgeStart.x + 24, edgeStart.y + 16); await page.mouse.down();
    await page.mouse.move(edgeStart.x + 64, edgeStart.y - 24); await page.mouse.up();
    const edgeInk = await page.evaluate(i => state.blackboard.pages[0].strokes[i]?.points[0], strokesBefore);
    assert.ok(edgeInk && Math.abs(edgeInk.x - edgeStart.x) < 1 && Math.abs(edgeInk.y - edgeStart.y) < 1, JSON.stringify(edgeInk));
    await page.screenshot({ path: path.join(output, '02-blackboard.png') });
    await page.evaluate(() => toggleBlackboard(false));
    await page.evaluate(() => showVideoView());
    // The raw hit lands on disabled Undo: activation must still reach Line.
    const line = await page.locator('#annotationLineToggle').boundingBox();
    const disabledHit = await page.evaluate(r => document.elementFromPoint(r.x + r.width - 4 + 24, r.y + r.height / 2 + 16)?.closest('button')?.disabled, line);
    assert.equal(disabledHit, true);
    await toolbarClick('#annotationLineToggle', true);
    assert.equal(await page.evaluate(() => state.annotations.lineMode), true);
    await toolbarClick('#annotationLineToggle', true);
    assert.equal(await page.evaluate(() => state.annotations.lineMode), false);
    await checkToolbar('annotation', false);
    await checkToolbar('annotation', true);
    assert.equal(await page.evaluate(() => state.annotations.strokes.length), 0);
    assert.equal(await page.locator('#undoAnnotationButton').isDisabled(), true);
    await toolbarClick('#undoAnnotationButton', true);
    assert.equal(await page.evaluate(() => state.annotations.strokes.length), 0);
    const eraser = await page.locator('#annotationEraserButton').boundingBox();
    const blue = await page.locator('#annotationColors [data-color="#0057B8"]').boundingBox();
    await page.mouse.move(eraser.x + eraser.width / 2 + 24, eraser.y + eraser.height / 2 + 16);
    await page.mouse.down();
    await page.mouse.move(blue.x + blue.width / 2 + 24, blue.y + blue.height / 2 + 16);
    await page.mouse.up();
    assert.equal(await page.evaluate(() => state.annotations.currentColor), '#D00000', 'drag across buttons must not activate either');
    await page.mouse.move(500, 400); await page.mouse.down();
    await page.mouse.move(eraser.x + eraser.width / 2 + 24, eraser.y + eraser.height / 2 + 16); await page.mouse.up();
    assert.equal(await page.evaluate(() => state.annotations.tool), 'pen', 'ink ending over toolbar must not activate eraser');
    await page.screenshot({ path: path.join(output, '02-annotation-toolbar.png') });
    await page.evaluate(() => showJoinView());
    const a = (await (await server.api('/classes', 'alice', 'POST', { name: '校准测试一班' })).json()).item;
    const b = (await (await server.api('/classes', 'alice', 'POST', { name: '校准测试二班' })).json()).item;
    // Exercise the same selection path as direct login / phone connection.
    await page.evaluate(async id => {
      await studentRoller.setTeacher('alice-test-token', false);
      await studentRoller.receiveSelection({ type: 'student.selection.set', classId: id, mode: 'name', count: 50 });
    }, a.id);
    await page.getByRole('button', { name: '触屏校准', exact: true }).click();
    await page.waitForFunction(() => !document.getElementById('touchCalibrationStart').disabled);
    await calibrate();
    await page.locator('#touchCalibrationSave').click();
    await page.waitForFunction(() => document.getElementById('touchCalibrationMessage').textContent.includes('已保存到班级'));
    assert.ok((await (await server.api(`/classes/${a.id}/touch-calibration`)).json()).profile);
    await page.screenshot({ path: path.join(output, '03-class-saved.png') });
    await page.locator('#touchCalibrationClose').click();
    const select = async id => {
      await page.evaluate(async classId => studentRoller.receiveSelection({ type: 'student.selection.set', classId, mode: 'name', count: 50 }), id);
      await page.waitForFunction(() => !document.getElementById('touchCalibrationStart').disabled);
    };
    await select(b.id);
    p = await page.evaluate(() => { const e = TouchCalibration.eventFor(new PointerEvent('pointermove', { clientX: 500, clientY: 400 })); return [e.clientX, e.clientY]; });
    assert.deepEqual(p, [500, 400]);
    await select(a.id);
    p = await page.evaluate(() => { const e = TouchCalibration.eventFor(new PointerEvent('pointermove', { clientX: 500, clientY: 400 })); return [e.clientX, e.clientY]; });
    assert.ok(Math.abs(p[0] - 476) < 1);
    // Send genuine touch input to the annotation canvas; source coordinates
    // must be corrected once before the existing content transform.
    await page.evaluate(() => { showVideoView(); state.annotations.strokes = []; });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 500, y: 400 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 600, y: 450 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const projected = await page.evaluate(() => {
      const stroke = state.annotations.strokes[0];
      return sourcePointToCanvasPoint(stroke.points[0], { left: 0, top: 0 }, currentVideoContentRect(), currentFrameCrop());
    });
    assert.ok(Math.abs(projected.x - 476) < 1 && Math.abs(projected.y - 384) < 1, JSON.stringify(projected));
    await page.screenshot({ path: path.join(output, '04-touch-annotation.png') });
    await page.evaluate(() => showJoinView());
    // A fresh browser with no local storage loads the server calibration.
    const other = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await other.goto(`${server.base}/`);
    await other.waitForFunction(() => studentRoller !== null);
    await other.evaluate(async id => {
      await studentRoller.setTeacher('alice-test-token', false);
      await studentRoller.receiveSelection({ type: 'student.selection.set', classId: id, mode: 'name', count: 50 });
    }, a.id);
    const saved = (await (await server.api(`/classes/${a.id}/touch-calibration`)).json()).profile;
    if (saved.fullscreen) {
      await other.getByRole('button', { name: '触屏校准', exact: true }).click();
      await other.locator('#touchCalibrationFullscreen').click();
    }
    await other.waitForFunction(() => document.getElementById('touchCalibrationStatus').textContent.includes('校准已启用'));
    await other.setViewportSize({ width: 1024, height: 768 });
    p = await other.evaluate(() => { const e = TouchCalibration.eventFor(new PointerEvent('pointermove', { clientX: 500, clientY: 400 })); return [e.clientX, e.clientY]; });
    assert.deepEqual(p, [500, 400]);
    // A delayed class response must never restore the previous class profile.
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route(`**/api/classes/${b.id}/touch-calibration`, async route => { await gate; await route.continue(); });
    await page.evaluate(async id => studentRoller.receiveSelection({ type: 'student.selection.set', classId: id, mode: 'name', count: 50 }), b.id);
    await select(a.id); release();
    await page.unrouteAll({ behavior: 'wait' });
    assert.ok((await page.locator('#touchCalibrationStatus').textContent()).includes('校准测试一班'));
    // Failed loading blocks writes rather than using a revision or calibration from another class.
    await page.route(`**/api/classes/${b.id}/touch-calibration`, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '测试服务不可达' }) }));
    await page.evaluate(async id => studentRoller.receiveSelection({ type: 'student.selection.set', classId: id, mode: 'name', count: 50 }), b.id);
    await page.waitForFunction(() => document.getElementById('touchCalibrationStatus').textContent.includes('加载失败'));
    assert.equal(await page.locator('#touchCalibrationStart').isDisabled(), true);
    await page.unrouteAll(); await select(a.id);
    await page.getByRole('button', { name: '触屏校准', exact: true }).click();
    await page.waitForFunction(() => !document.getElementById('touchCalibrationReset').disabled);
    page.once('dialog', d => d.accept()); await page.locator('#touchCalibrationReset').click();
    await page.waitForFunction(() => document.getElementById('touchCalibrationMessage').textContent.includes('已恢复默认'));
    assert.equal((await (await server.api(`/classes/${a.id}/touch-calibration`)).json()).profile, null);
    assert.deepEqual(errors, []);
    console.log(`PASS: red defaults, calibrated mouse/touch toolbar and menus, keyboard, disabled button, canvas edge, local reload, real ink, class save/switch, fresh browser load, viewport guard, reset; screenshots: ${output}`);
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    throw error;
  } finally { await browser?.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
