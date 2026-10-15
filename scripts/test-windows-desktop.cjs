// Windows/Electron integration: real OS cursor input, gInk and WebRTC capture.
const { _electron, chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { startTestServer } = require('../server/testSupport');

(async () => {
  const root = path.resolve(__dirname, '..');
  const output = path.join(os.tmpdir(), 'myclass-windows-desktop-proof');
  await fs.mkdir(output, { recursive: true });
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'myclass-windows-user-'));
  const probe = path.join(output, 'DesktopProbe.exe');
  execFileSync(path.join(process.env.WINDIR, 'Microsoft.NET/Framework/v4.0.30319/csc.exe'),
    ['/nologo', '/platform:x86', '/r:System.Web.Extensions.dll', `/out:${probe}`, path.join(root, 'windows/scripts/DesktopProbe.cs')], { windowsHide: true });
  const input = (...args) => execFileSync(probe, args.map(String), { windowsHide: true, encoding: 'utf8' }).trim();
  const server = await startTestServer({ withWeb: true });
  let desktop, browser, viewer;
  try {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const packaged = process.env.MYCLASS_TEST_EXE;
    desktop = await _electron.launch({ executablePath: packaged || path.join(root, 'windows/node_modules/electron/dist/electron.exe'),
      args: [...(packaged ? [] : [path.join(root, 'windows')]), `--user-data-dir=${userData}`], env });
    const panel = await desktop.firstWindow();
    const errors = [];
    panel.on('pageerror', error => errors.push(error.message));
    await panel.waitForFunction(() => typeof state !== 'undefined' && sourcePicker.value);
    await panel.evaluate(base => { state.serverUrl = base; localStorage.setItem('myclass.serverUrl', base); }, server.base);
    if (process.argv.includes('--smoke')) {
      await panel.screenshot({ path: path.join(output, '00-windows-panel.png') });
      // Exercise the actual media compositor without depending on an RDP display.
      const compositorCheck = await panel.evaluate(async () => {
        const source = document.createElement('canvas'); source.width = 640; source.height = 480;
        const sourceContext = source.getContext('2d');
        sourceContext.fillStyle = 'white'; sourceContext.fillRect(0, 0, 640, 480);
        const raw = source.captureStream(30);
        const repaint = setInterval(() => sourceContext.fillRect(0, 0, 640, 480), 33);
        const handle = createCompositor(raw);
        let video;
        try {
          await handle.ready;
          video = document.createElement('video'); video.muted = true;
          video.srcObject = new MediaStream([handle.outputTrack]); await video.play();
          const sample = document.createElement('canvas'); sample.width = 640; sample.height = 480;
          const ctx = sample.getContext('2d');
          const wait = () => new Promise(resolve => setTimeout(resolve, 120));
          const redAt = (x, y) => {
            ctx.drawImage(video, 0, 0); const p = ctx.getImageData(x, y, 1, 1).data;
            return p[0] > 180 && p[1] < 190 && p[2] < 190;
          };
          cursorScene = { inside: true, cursor: { x: 100, y: 100 }, region: { x: 0, y: 0, width: 640, height: 480 }, receivedAt: performance.now() };
          handle.render(); await wait();
          const first = redAt(112, 100);
          cursorScene = { ...cursorScene, cursor: { x: 200, y: 200 }, receivedAt: performance.now() };
          handle.render(); await wait();
          const second = redAt(212, 200), clearedOld = !redAt(112, 100);
          cursorScene = { inside: false }; handle.render(); await wait();
          const clearedExit = !redAt(212, 200);
          return { first, second, clearedOld, clearedExit, frames: video.getVideoPlaybackQuality().totalVideoFrames };
        } finally {
          clearInterval(repaint); handle.stop(); raw.getTracks().forEach(t => t.stop());
          if (video) { video.pause(); video.srcObject = null; } cursorScene = null;
        }
      });
      assert.deepEqual(compositorCheck, { first: true, second: true, clearedOld: true, clearedExit: true, frames: compositorCheck.frames });
      assert.ok(compositorCheck.frames > 3);
      console.log('Actual canvas media compositor:', compositorCheck);
      await panel.evaluate(() => api.setCursorHighlight(true));
      await panel.evaluate(() => api.setCursorHighlight(false));
      await panel.locator('#setupInkButton').click();
      await panel.waitForFunction(() => state.inkActive);
      await panel.evaluate(() => api.toggleInkPointer());
      await panel.evaluate(() => api.setScreenInk(false));
      await panel.waitForFunction(() => !state.inkActive);
      await panel.evaluate(() => api.setScreenInk(true));
      await panel.waitForFunction(() => state.inkActive);
      await panel.evaluate(() => stopProjection(false));
      await panel.waitForFunction(() => !state.inkActive);
      assert.deepEqual(errors, []);
      console.log('PASS: real media compositor/halo/cleanup, Electron button/IPC, native halo lifecycle, gInk start/pointer/stop/restart, stop-projection cleanup (no desktop input/capture claims)');
      return;
    }
    // Neutral content keeps the captured screen free of unrelated desktop content.
    await desktop.evaluate(async ({ BrowserWindow, screen }) => {
      const bounds = screen.getPrimaryDisplay().bounds;
      global.testLesson = new BrowserWindow({ ...bounds, frame: false, backgroundColor: '#fff', show: true });
      await global.testLesson.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<title>MyClass desktop test lesson</title><body style="margin:0;padding:90px;background:#fff;color:#182033;font:40px sans-serif"><h1>MyClass 标注验证</h1><p>画笔 · 橡皮 · 撤销 · 鼠标操作</p></body>'));
    });
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    viewer = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await viewer.goto(server.base + '/');
    await viewer.waitForFunction(() => !!state.roomCode);
    const code = await viewer.evaluate(() => state.roomCode);
    assert.ok(await panel.evaluate(async () => (await api.listSources()).sources.some(s => s.type === 'screen')),
      'No display capture source. Connect and unlock this Windows desktop before running the full test.');
    await panel.evaluate(async code => {
      elements.roomCode.value = code;
      const sources = await api.listSources();
      sourcePicker.render(sources, sources.sources.find(source => source.type === 'screen').id);
      await startProjection();
    }, code);
    await viewer.waitForFunction(() => elements.remoteVideo.videoWidth > 0 && !elements.remoteVideo.paused, { timeout: 20000 });
    const latency = JSON.parse(input('measure'));
    // An active RDP client can echo older cursor positions over injected input.
    // Check both the normal response and eventual alignment under that jitter;
    // these geometry measurements do not measure display presentation latency.
    assert.ok(latency.p50Ms < 20 && latency.p95Ms < 150, JSON.stringify(latency));
    console.log('Native cursor geometry latency:', latency);
    await viewer.screenshot({ path: path.join(output, '01-native-cursor.png') });
    // Refusing the whole-screen switch must leave the current window share intact.
    const lessonSource = await panel.evaluate(async () => (await api.listSources()).sources.find(s => s.name === 'MyClass desktop test lesson'));
    assert.ok(lessonSource);
    await panel.evaluate(source => switchProjectionSourceTo(source), lessonSource);
    panel.once('dialog', dialog => dialog.dismiss());
    await panel.evaluate(() => startScreenInk());
    assert.equal(await panel.evaluate(() => state.captureSourceType), 'window');
    assert.equal(await panel.evaluate(() => state.inkActive), false);
    panel.once('dialog', dialog => dialog.accept());
    await panel.evaluate(() => startScreenInk());
    await panel.waitForFunction(() => state.inkActive && state.captureSourceType === 'screen');
    assert.equal(await panel.evaluate(() => state.roomCode), code);
    await panel.evaluate(() => api.setScreenInk(false));
    await panel.waitForFunction(() => !state.inkActive);
    // Start through the actual global shortcut, then draw through Win32 mouse input.
    input('shortcut');
    await panel.waitForFunction(() => state.inkActive);
    const physicalSize = await desktop.evaluate(({ screen }) => {
      const d = screen.getPrimaryDisplay();
      return { width: d.size.width * d.scaleFactor, height: d.size.height * d.scaleFactor };
    });
    const strokePixels = () => viewer.evaluate(size => {
      const v = elements.remoteVideo, c = document.createElement('canvas');
      c.width = v.videoWidth; c.height = v.videoHeight;
      const ctx = c.getContext('2d'); ctx.drawImage(v, 0, 0);
      // Only the drawn line's physical-screen region; exclude cursor and toolbar.
      const sx = c.width / size.width, sy = c.height / size.height;
      const pixels = ctx.getImageData(Math.floor(390 * sx), Math.floor(350 * sy), Math.ceil(320 * sx), Math.ceil(80 * sy)).data;
      let red = 0; for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 160 && pixels[i] > pixels[i + 1] * 1.6 && pixels[i] > pixels[i + 2] * 1.4) red++;
      return red;
    }, physicalSize);
    const waitStroke = async predicate => {
      let count;
      for (let i = 0; i < 40; i++) { count = await strokePixels(); if (predicate(count)) return count; await viewer.waitForTimeout(100); }
      assert.fail(`Expected stroke state was not received over WebRTC: ${count}`);
    };
    input('move', 900, 600); await viewer.waitForTimeout(400);
    const baseline = await strokePixels();
    console.log('Stroke baseline:', baseline, 'physical display:', physicalSize);
    input('draw', 400, 360); input('move', 900, 600);
    await waitStroke(count => count > baseline + 100);
    await viewer.screenshot({ path: path.join(output, '02-gink-stroke.png') });
    input('ctrl', 90); await waitStroke(count => count < baseline + 30); // Undo.
    input('ctrl', 89); await waitStroke(count => count > baseline + 100); // Redo.
    input('key', 69); input('draw', 400, 360); input('move', 900, 600); // Erase.
    await waitStroke(count => count < baseline + 30);
    await viewer.screenshot({ path: path.join(output, '03-gink-erased.png') });
    input('key', 27);
    await panel.waitForFunction(() => !state.inkActive);
    await panel.evaluate(() => stopProjection(true));
    assert.deepEqual(errors, []);
    console.log(`PASS: desktop capture, native cursor, global shortcut, gInk draw/undo/redo/erase in WebRTC, Esc exit and stop; evidence: ${output}`);
  } catch (error) {
    if (viewer) await viewer.screenshot({ path: path.join(output, 'failure.png') });
    throw error;
  } finally {
    await desktop?.evaluate(({ app }) => app.quit()).catch(() => {});
    await desktop?.close().catch(() => {});
    await browser?.close();
    await server.close();
    // Preserve isolated user data for diagnosis if Windows still holds its lock.
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
