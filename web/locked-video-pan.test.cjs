const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Run the actual page gesture and coordinate functions with a simulated video viewport.
const source = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
function fixture(width = 900, height = 1600) {
  const state = {
    presentationMode: 'video', annotations: { tool: 'pan' },
    videoOrientation: { orientation: 'portrait' },
    framePresentation: { frameLocked: true, lockedFrameZoomRatio: 2, cropX: 0.25, cropY: 0.25, cropWidth: 0.5, cropHeight: 0.5 },
    lockedVideoPan: { x: 0, y: 0, scale: 1, pointers: new Map() }
  };
  const captured = new Set();
  const elements = {
    videoView: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1600, height: 900 }) },
    remoteVideo: { videoWidth: width, videoHeight: height, style: {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1600, height: 900 }) },
    annotationCanvas: { classList: { add() {}, remove() {} },
      setPointerCapture: id => captured.add(id), releasePointerCapture: id => captured.delete(id) }
  };
  const context = vm.createContext({ state, elements, getComputedStyle: () => ({ objectFit: 'cover' }), drawAnnotations() {} });
  for (const name of ['clamp', 'runCatching', 'currentVideoContentRect', 'currentFrameCrop',
    'pointerEventToSourcePoint', 'sourcePointToCanvasPoint', 'beginLockedVideoPan',
    'continueLockedVideoPan', 'finishLockedVideoPan', 'resetLockedVideoPan', 'lockedVideoContentRect',
    'applyLockedVideoView', 'zoomLockedVideo', 'canControlLockedVideo', 'zoomLockedVideoWheel', 'resetLockedVideoOnDoubleClick']) {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf('\nfunction ', start + 1);
    vm.runInContext(source.slice(start, end < 0 ? undefined : end), context);
  }
  return { context, state, elements, captured };
}
const pointer = (x, y, id = 1) => ({ clientX: x, clientY: y, pointerId: id, preventDefault() {} });

test('locked portrait video moves in both axes and remains recoverable at drag limits', () => {
  const { context: c, elements, captured } = fixture();
  const before = c.currentVideoContentRect();
  assert.equal(c.beginLockedVideoPan(pointer(800, 450)), true);
  c.continueLockedVideoPan(pointer(1000, 650));
  assert.ok(Math.abs(c.currentVideoContentRect().top - before.top - 200) < 1e-6);
  assert.equal(c.currentVideoContentRect().left, 200);
  c.continueLockedVideoPan(pointer(800, 10000));
  assert.ok(c.currentVideoContentRect().top <= 836);
  c.continueLockedVideoPan(pointer(800, -10000));
  assert.ok(c.currentVideoContentRect().top + c.currentVideoContentRect().height >= 64);
  c.finishLockedVideoPan(pointer(800, 450));
  assert.equal(captured.size, 0);
  assert.equal(elements.remoteVideo.style.objectFit, 'contain');
});

test('annotations retain their source coordinates after dragging', () => {
  const { context: c } = fixture();
  const point = c.pointerEventToSourcePoint(pointer(800, 450));
  c.beginLockedVideoPan(pointer(800, 450));
  c.continueLockedVideoPan(pointer(800, 650));
  const projected = c.sourcePointToCanvasPoint(point, { left: 0, top: 0 }, c.currentVideoContentRect(), c.currentFrameCrop());
  assert.ok(Math.abs(projected.y - 650) < 1e-6);
  assert.equal(projected.x, 800);
});

test('wide video pans horizontally; another pointer cannot interrupt the drag', () => {
  const { context: c, state } = fixture(3200, 900);
  c.beginLockedVideoPan(pointer(800, 450));
  assert.equal(c.continueLockedVideoPan(pointer(1000, 450, 2)), false);
  c.continueLockedVideoPan(pointer(1000, 450));
  assert.equal(c.currentVideoContentRect().left, -600);
  c.resetLockedVideoPan();
  assert.equal(state.lockedVideoPan.pointers.size, 0);
  assert.equal(c.currentVideoContentRect().left, -800);
});

test('unlocked video, pen, and courseware never start a locked-video gesture', () => {
  const { context: c, state } = fixture();
  state.framePresentation.frameLocked = false;
  c.beginLockedVideoPan(pointer(800, 450));
  assert.equal(state.lockedVideoPan.pointers.size, 0);
  state.annotations.tool = 'pen';
  assert.equal(c.beginLockedVideoPan(pointer(800, 450)), false);
  state.annotations.tool = 'pan';
  state.presentationMode = 'courseware';
  assert.equal(c.beginLockedVideoPan(pointer(800, 450)), false);
});

test('wheel zoom stays anchored at the cursor and supports zooming out', () => {
  const { context: c, state } = fixture();
  const point = c.pointerEventToSourcePoint(pointer(1000, 600));
  c.zoomLockedVideoWheel({ ...pointer(1000, 600), deltaY: -200, deltaMode: 0 });
  assert.ok(state.lockedVideoPan.scale > 1);
  const projected = c.sourcePointToCanvasPoint(point, { left: 0, top: 0 }, c.currentVideoContentRect(), c.currentFrameCrop());
  assert.ok(Math.abs(projected.x - 1000) < 1e-6);
  assert.ok(Math.abs(projected.y - 600) < 1e-6);
  c.zoomLockedVideoWheel({ ...pointer(1000, 600), deltaY: 400, deltaMode: 0 });
  assert.ok(state.lockedVideoPan.scale < 1);
});

test('two-finger pinch transitions to single-finger drag without jumping', () => {
  const { context: c, state, captured } = fixture();
  c.beginLockedVideoPan(pointer(700, 450));
  c.beginLockedVideoPan(pointer(900, 450, 2));
  c.continueLockedVideoPan(pointer(1100, 450, 2));
  assert.equal(state.lockedVideoPan.scale, 2);
  c.finishLockedVideoPan(pointer(1100, 450, 2));
  const before = c.currentVideoContentRect();
  c.continueLockedVideoPan(pointer(800, 500));
  assert.equal(c.currentVideoContentRect().left, before.left + 100);
  assert.equal(c.currentVideoContentRect().top, before.top + 50);
  c.resetLockedVideoOnDoubleClick(pointer(800, 500));
  assert.equal(captured.size, 0);
  assert.equal(state.lockedVideoPan.scale, 1);
  assert.equal(state.lockedVideoPan.x, 0);
});

test('zoom limits and cleanup restore normal video layout', () => {
  const { context: c, state, elements } = fixture();
  c.zoomLockedVideo(100, { x: 800, y: 450 });
  assert.equal(state.lockedVideoPan.scale, 5);
  c.zoomLockedVideo(0.001, { x: 800, y: 450 });
  assert.equal(state.lockedVideoPan.scale, 0.25);
  c.resetLockedVideoPan();
  assert.equal(elements.remoteVideo.style.width, '');
  assert.equal(elements.remoteVideo.style.objectFit, '');
});
