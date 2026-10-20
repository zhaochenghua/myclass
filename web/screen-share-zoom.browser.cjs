const { chromium } = require('playwright');
const { startTestServer } = require('../server/testSupport');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

(async () => {
  const externalBase = process.env.SCREEN_ZOOM_BASE?.replace(/\/$/, '');
  const server = externalBase ? { base: externalBase, close: async () => {} } : await startTestServer({ withWeb: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true,
    args: externalBase ? [`--unsafely-treat-insecure-origin-as-secure=${new URL(externalBase).origin}`] : [] });
  try {
    const viewer = await browser.newPage({ viewport: { width: 1600, height: 900 }, hasTouch: true });
    const errors = [];
    viewer.on('pageerror', error => errors.push(error.message));
    await viewer.addInitScript(() => { Element.prototype.requestFullscreen = async () => {}; });
    await viewer.goto(`${server.base}/`);
    await viewer.waitForFunction(() => !!state.roomCode);
    const code = await viewer.evaluate(() => state.roomCode);
    const sender = await browser.newPage();
    await sender.goto(`${server.base}/`);
    await sender.evaluate(async ({ base, code }) => {
      const socket = new WebSocket(`${base.replace('http', 'ws')}/ws`);
      const send = message => socket.send(JSON.stringify(message));
      const pc = new RTCPeerConnection({ iceServers: [] });
      window.testSender = { socket, pc, send };
      pc.onicecandidate = event => { if (event.candidate) send({ type: 'webrtc.ice-candidate', candidate: event.candidate.toJSON() }); };
      const joined = new Promise((resolve, reject) => {
        socket.onmessage = async event => {
          const message = JSON.parse(event.data);
          if (message.type === 'join.accepted') resolve();
          if (message.type === 'join.rejected') reject(new Error(message.message));
          if (message.type === 'webrtc.answer') await pc.setRemoteDescription({ type: 'answer', sdp: message.sdp });
          if (message.type === 'webrtc.ice-candidate') await pc.addIceCandidate(message.candidate);
        };
      });
      await new Promise(resolve => { socket.onopen = resolve; });
      send({ type: 'teacher.join', code });
      await joined;
      const canvas = document.createElement('canvas');
      window.testSender.canvas = canvas;
      canvas.width = 1600; canvas.height = 900;
      const ctx = canvas.getContext('2d');
      let frame = 0;
      const draw = () => {
        ctx.fillStyle = '#126b50'; ctx.fillRect(0, 0, 1600, 900);
        ctx.fillStyle = '#f2be42'; ctx.fillRect(800, 0, 800, 450);
        ctx.fillStyle = '#c94f57'; ctx.fillRect(0, 450, 800, 450);
        ctx.fillStyle = '#ffffff'; ctx.font = '48px sans-serif';
        ctx.fillText(`Shared screen ${frame++}`, 850, 240);
      };
      draw(); window.testSender.timer = setInterval(draw, 100);
      const stream = canvas.captureStream(10);
      stream.getTracks().forEach(track => pc.addTrack(track, stream));
      // Match Android: orientation is sent before the async offer completes.
      send({ type: 'teacher.orientation', orientation: 'landscape', rotationDegrees: 90, cameraFacing: 'unknown', frameLocked: false });
      const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
      send({ type: 'webrtc.offer', sdp: offer.sdp });
    }, { base: server.base, code });
    await viewer.waitForFunction(() => elements.remoteVideo.videoWidth > 0 && state.peerConnection?.connectionState === 'connected');
    await viewer.locator('#panToolButton').waitFor({ state: 'visible' });
    assert.equal(await viewer.evaluate(() => state.framePresentation.screenSharing), true);
    await viewer.waitForTimeout(300);
    const pixels = await viewer.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 2;
      const ctx = canvas.getContext('2d'); ctx.drawImage(elements.remoteVideo, 0, 0, 2, 2);
      return [...ctx.getImageData(0, 0, 2, 2).data];
    });
    assert.notDeepEqual(pixels.slice(0, 3), pixels.slice(4, 7));
    await viewer.screenshot({ path: path.join(os.tmpdir(), 'myclass-screen-share-before.png') });
    await viewer.locator('#panToolButton').click();
    await viewer.mouse.move(1100, 280); await viewer.mouse.wheel(0, -400);
    await viewer.waitForFunction(() => state.lockedVideoPan.scale > 1.5);
    const point = await viewer.evaluate(() => pointerEventToSourcePoint({ clientX: 1100, clientY: 280 }));
    await viewer.mouse.move(1100, 280); await viewer.mouse.down();
    await viewer.mouse.move(1000, 380, { steps: 5 }); await viewer.mouse.up();
    const projected = await viewer.evaluate(point => sourcePointToCanvasPoint(point, { left: 0, top: 0 }, currentVideoContentRect(), currentFrameCrop()), point);
    assert.ok(Math.abs(projected.x - 1000) < 1 && Math.abs(projected.y - 380) < 1);
    await viewer.evaluate(() => setAnnotationTool('pen'));
    await viewer.mouse.move(700, 300); await viewer.mouse.down(); await viewer.mouse.move(900, 400, { steps: 8 }); await viewer.mouse.up();
    assert.equal(await viewer.evaluate(() => state.annotations.strokes.length), 1);
    await viewer.locator('#panToolButton').click();
    const cdp = await viewer.context().newCDPSession(viewer);
    const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y, id]) => ({ x, y, id })) });
    const beforePinch = await viewer.evaluate(() => state.lockedVideoPan.scale);
    await touch('touchStart', [[600, 450, 1], [900, 450, 2]]);
    await touch('touchMove', [[500, 450, 1], [1100, 450, 2]]);
    await touch('touchEnd', []);
    assert.ok(await viewer.evaluate(before => state.lockedVideoPan.scale > before, beforePinch));
    await viewer.screenshot({ path: path.join(os.tmpdir(), 'myclass-screen-share-zoom.png') });
    const zoom = await viewer.evaluate(() => state.lockedVideoPan.scale);
    await viewer.setViewportSize({ width: 1280, height: 800 });
    assert.equal(await viewer.evaluate(() => state.lockedVideoPan.scale), zoom);
    await viewer.mouse.dblclick(1000, 350);
    assert.equal(await viewer.evaluate(() => state.lockedVideoPan.scale), 1);
    await viewer.setViewportSize({ width: 390, height: 844 });
    await viewer.screenshot({ path: path.join(os.tmpdir(), 'myclass-screen-share-mobile.png') });
    const rect = await viewer.evaluate(() => currentVideoContentRect());
    assert.ok(rect.width <= 391 && rect.height <= 845);
    await viewer.setViewportSize({ width: 1600, height: 900 });
    await viewer.mouse.move(1000, 300); await viewer.mouse.wheel(0, -300);
    await viewer.waitForFunction(() => state.lockedVideoPan.scale > 1);
    await sender.evaluate(() => { testSender.canvas.width = 900; testSender.canvas.height = 1600; });
    await viewer.waitForFunction(() => elements.remoteVideo.videoWidth === 900 && state.lockedVideoPan.scale === 1);
    const portrait = await viewer.evaluate(() => currentVideoContentRect());
    assert.equal(portrait.height, 900);
    assert.ok(portrait.width < 1600);
    await sender.evaluate(() => testSender.send({ type: 'teacher.orientation', orientation: 'landscape', rotationDegrees: 90, cameraFacing: 'back', frameLocked: false }));
    await viewer.waitForFunction(() => !state.framePresentation.screenSharing);
    await viewer.locator('#panToolButton').waitFor({ state: 'visible' });
    assert.equal(await viewer.evaluate(() => state.lockedVideoPan.scale), 1);
    await viewer.mouse.move(1000, 300); await viewer.mouse.wheel(0, -300);
    await viewer.waitForFunction(() => state.lockedVideoPan.scale > 1);
    // Unknown/older senders have the same controls; no screen-share flag is required.
    await sender.evaluate(() => testSender.send({ type: 'teacher.orientation', orientation: 'landscape', rotationDegrees: 90 }));
    await viewer.waitForFunction(() => state.videoOrientation.cameraFacing === 'unknown');
    await viewer.mouse.dblclick(1000, 350);
    assert.equal(await viewer.evaluate(() => state.lockedVideoPan.scale), 1);
    await sender.evaluate(() => testSender.send({ type: 'teacher.stop' }));
    await viewer.waitForFunction(() => !state.framePresentation.screenSharing && !state.peerConnection);
    await sender.evaluate(() => { clearInterval(testSender.timer); testSender.pc.close(); testSender.socket.close(); });
    assert.deepEqual(errors, []);
    console.log(`PASS ${server.base}: real WebRTC, all live sources including camera and unknown senders, wheel zoom, drag, ink, touch pinch, reset, mobile fit, source transition`);
  } finally { await browser.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
