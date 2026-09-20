const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function pipelineFixture(manualFrames = true) {
  const intervals = new Map(), frames = new Map(), rates = [];
  let serial = 0;
  const document = { createElement: () => makeCanvas() };
  function makeCanvas() {
    const canvas = { width: 0, height: 0, pixel: null, ownerDocument: document };
    const ctx = { save() {}, restore() {}, setTransform() {}, fillRect() {}, scale() {}, translate() {}, rotate() {},
      drawImage(source) { canvas.pixel = source.pixel; canvas.drawSource = source; } };
    canvas.getContext = () => ctx;
    canvas.captureStream = fps => {
      rates.push(fps);
      const track = { stopped: false, stop() { this.stopped = true; } };
      if (manualFrames) track.requestFrame = () => {};
      return { getVideoTracks: () => [track] };
    };
    return canvas;
  }
  const video = { videoWidth: 640, videoHeight: 480, readyState: 4, pixel: 'red',
    play: async () => {}, setAttribute() {} };
  const context = vm.createContext({ clamp, navigator: { mediaDevices: {
    getUserMedia: async () => ({getTracks: () => [{stop() {}}]}) } },
    requestAnimationFrame: fn => { frames.set(++serial, fn); return serial; },
    cancelAnimationFrame: id => frames.delete(id),
    setInterval: fn => { intervals.set(++serial, fn); return serial; }, clearInterval: id => intervals.delete(id),
    setTimeout, clearTimeout });
  const source = fs.readFileSync(`${__dirname}/ios/js/pipeline.js`, 'utf8')
    .replace(/import \{ clamp \} from '[^']+';/, '').replace(/export /g, '');
  vm.runInContext(`${source}\nglobalThis.Pipeline = MediaPipeline;`, context);
  const canvas = makeCanvas();
  const pipeline = new context.Pipeline({ canvas, video, image: {removeAttribute() {}} });
  return { pipeline, canvas, video, rates, intervals, tick() {
    const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn());
  }, keepAlive() { [...intervals.values()].forEach(fn => fn()); } };
}

test('camera lock stores original pixels across keep-alive, zoom, pan and rotation; unlock resumes live', async () => {
  const f = pipelineFixture();
  await f.pipeline.openCamera(); f.tick();
  f.pipeline.zoomBy(2);
  assert.equal(f.pipeline.setLocked(true), true);
  const frozen = f.pipeline.frozenFrame;
  assert.equal(frozen.width, 640);
  f.video.pixel = 'blue';
  for (let i = 0; i < 10; i++) f.keepAlive();
  assert.equal(f.canvas.pixel, 'red');
  f.pipeline.zoomBy(1.5); f.pipeline.panBy(.1, .2); f.pipeline.rotateOnce(); f.tick();
  assert.equal(f.canvas.drawSource, frozen);
  assert.equal(f.canvas.pixel, 'red');
  assert.equal(f.pipeline.zoom, 3);
  assert.notEqual(f.pipeline.panX, 0);
  f.pipeline.setLocked(false); f.tick();
  assert.equal(f.canvas.pixel, 'blue');
  assert.equal(f.pipeline.frozenFrame, null);
  f.pipeline.setLocked(true); f.video.pixel = 'green'; f.keepAlive();
  assert.equal(f.canvas.pixel, 'blue');
  f.pipeline.stop();
  assert.equal(f.intervals.size, 0);
  assert.equal(f.pipeline.locked, false);
  assert.equal(f.pipeline.frozenFrame, null);
});

test('orientation and background camera recovery preserve frozen pixels and original dimensions', async () => {
  const f = pipelineFixture(); await f.pipeline.openCamera(); f.tick();
  f.pipeline.setLocked(true); f.pipeline.zoomBy(2);
  f.video.videoWidth = 480; f.video.videoHeight = 640; f.video.pixel = 'new portrait frame';
  await f.pipeline.reopenCamera(); f.tick(); f.keepAlive();
  assert.equal(f.pipeline.locked, true);
  assert.equal(f.pipeline.zoom, 2);
  assert.equal(f.canvas.pixel, 'red');
  assert.ok(f.canvas.width > f.canvas.height);
  await f.pipeline.switchCamera(); f.tick();
  assert.equal(f.pipeline.locked, false);
  assert.equal(f.canvas.pixel, 'new portrait frame');
  f.pipeline.stop();
});

test('Safari without requestFrame uses a timed stream; unavailable camera does not enter lock mode', async () => {
  const f = pipelineFixture(false); await f.pipeline.openCamera();
  f.video.readyState = 1;
  assert.throws(() => f.pipeline.setLocked(true), /尚未就绪/);
  assert.equal(f.pipeline.locked, false);
  f.video.readyState = 4; f.pipeline.setLocked(true);
  assert.deepEqual(f.rates.slice(-2), [0, 24]);
  f.video.pixel = 'blue'; f.keepAlive();
  assert.equal(f.canvas.pixel, 'red');
  f.pipeline.stop();
});

function gestureFixture(rotation) {
  const handlers = {}, sent = [];
  const box = { width: 400, height: 300 };
  const img = { hidden: false, offsetWidth: 400, offsetHeight: 225, naturalWidth: 1600, naturalHeight: 900, style: {} };
  const stage = { getBoundingClientRect: () => box, addEventListener: (type, fn) => { handlers[type] = fn; } };
  const item = { kind: 'image', rotation, scale: 4, panX: 0, panY: 0 };
  const nodes = { mediaPreview: img, mediaPreviewBox: stage, mediaStatus: {} };
  const state = { media: {queue: [item], index: 0}, signaling: {sendCoursewareImageViewport: msg => sent.push(msg)} };
  const context = vm.createContext({state, clamp, $: id => nodes[id], MAX_MEDIA_ZOOM: 8, MIN_MEDIA_ZOOM: 1});
  vm.runInContext(fs.readFileSync(`${__dirname}/ios/js/mediaGeometry.js`, 'utf8').replace('export ', ''), context);
  const source = fs.readFileSync(`${__dirname}/ios/js/app.js`, 'utf8');
  for (const name of ['sendMediaViewport', 'zoomByMedia', 'panByMedia', 'clampMediaPan', 'currentMediaGeometry',
    'applyMediaPreviewRotation', 'updateMediaZoomStatus', 'bindMediaGestures']) {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf('\nfunction ', start + 1);
    vm.runInContext(source.slice(start, end), context);
  }
  context.bindMediaGestures();
  return {handlers, img, item, sent};
}

test('single and two-finger drags follow screen axes and distance at all four image rotations', () => {
  for (const rotation of [0, 90, 180, 270]) for (const fingers of [1, 2]) {
    const f = gestureFixture(rotation);
    const touches = (dx, dy) => Array.from({length: fingers}, (_, i) => ({clientX: 100 + i * 100 + dx, clientY: 100 + dy}));
    f.handlers.touchstart({touches: touches(0, 0)});
    f.handlers.touchmove({touches: touches(30, -20), preventDefault() {}});
    const match = f.img.style.transform.match(/^translate\(([-.\d]+)px, ([-.\d]+)px\)/);
    assert.ok(match, f.img.style.transform);
    assert.ok(Math.abs(Number(match[1]) - 30) < 1e-6);
    assert.ok(Math.abs(Number(match[2]) + 20) < 1e-6);
    assert.equal(f.sent.at(-1).rotation, rotation);
    assert.ok(f.sent.at(-1).centerX < .5);
    assert.ok(f.sent.at(-1).centerY > .5);
  }
});
