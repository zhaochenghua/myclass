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
    panToolButton: {},
    annotationCanvas: { classList: { add() {}, remove() {} },
      setPointerCapture: id => captured.add(id), releasePointerCapture: id => captured.delete(id) }
  };
  elements.videoView.dataset = {};
  const context = vm.createContext({ state, elements, getComputedStyle: () => ({ objectFit: 'cover' }),
    drawAnnotations() {}, resizeAnnotationCanvas() {}, updateAnnotationButtons() {},
    setAnnotationTool(tool) { state.annotations.tool = tool; } });
  for (const name of ['clamp', 'runCatching', 'currentVideoContentRect', 'currentFrameCrop',
    'pointerEventToSourcePoint', 'sourcePointToCanvasPoint', 'beginLockedVideoPan',
    'continueLockedVideoPan', 'finishLockedVideoPan', 'resetLockedVideoPan', 'lockedVideoContentRect',
    'applyLockedVideoView', 'zoomLockedVideo', 'canControlLockedVideo', 'zoomLockedVideoWheel', 'resetLockedVideoOnDoubleClick',
    'isLocalVideoViewEnabled', 'handleTeacherOrientation', 'updateVideoPresentation',
    'normalizedZoomRatio', 'normalizedLockedFrameCrop', 'normalizedNumber', 'fullLockedFrameCrop']) {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf('\nfunction ', start + 1);
    vm.runInContext(source.slice(start, end < 0 ? undefined : end), context);
  }
  return { context, state, elements, captured };
}
const pointer = (x, y, id = 1) => ({ clientX: x, clientY: y, pointerId: id, preventDefault() {} });
const screenShare = { orientation: 'landscape', rotationDegrees: 90, cameraFacing: 'unknown', frameLocked: false };

test('existing Android screen-share signals enable local zoom without locking the stream', () => {
  const { context: c, state, elements } = fixture(1920, 1080);
  c.handleTeacherOrientation(screenShare);
  assert.equal(state.framePresentation.screenSharing, true);
  assert.equal(state.framePresentation.frameLocked, false);
  assert.equal(elements.panToolButton.hidden, false);
  c.zoomLockedVideoWheel({ ...pointer(1000, 600), deltaY: -200, deltaMode: 0 });
  const scale = state.lockedVideoPan.scale;
  assert.ok(scale > 1);
  c.handleTeacherOrientation(screenShare);
  c.updateVideoPresentation();
  assert.equal(state.lockedVideoPan.scale, scale);
  c.beginLockedVideoPan(pointer(800, 450));
  c.continueLockedVideoPan(pointer(900, 500));
  assert.equal(state.lockedVideoPan.pointers.size, 1);
  c.handleTeacherOrientation({ ...screenShare, cameraFacing: 'back' });
  assert.equal(state.lockedVideoPan.scale, 1);
  assert.equal(state.lockedVideoPan.pointers.size, 0);
  assert.equal(elements.panToolButton.hidden, false);
  assert.equal(state.annotations.tool, 'pan');
});

test('screen sharing fits the full frame and keeps ink aligned through pinch, drag and reset', () => {
  const { context: c, state } = fixture();
  c.handleTeacherOrientation(screenShare);
  const rect = c.currentVideoContentRect();
  assert.equal(rect.height, 900);
  assert.ok(rect.width < 1600);
  const point = c.pointerEventToSourcePoint(pointer(800, 450));
  c.beginLockedVideoPan(pointer(700, 450));
  c.beginLockedVideoPan(pointer(900, 450, 2));
  c.continueLockedVideoPan(pointer(1100, 450, 2));
  assert.equal(state.lockedVideoPan.scale, 2);
  c.finishLockedVideoPan(pointer(1100, 450, 2));
  c.continueLockedVideoPan(pointer(800, 500));
  const projected = c.sourcePointToCanvasPoint(point, { left: 0, top: 0 }, c.currentVideoContentRect(), c.currentFrameCrop());
  assert.equal(projected.x, 1000);
  assert.equal(projected.y, 500);
  c.finishLockedVideoPan(pointer(800, 500));
  c.resetLockedVideoOnDoubleClick(pointer(800, 500));
  assert.equal(state.lockedVideoPan.scale, 1);
  state.annotations.tool = 'pen';
  assert.equal(c.beginLockedVideoPan(pointer(800, 450)), false);
  state.annotations.tool = 'pan';
  state.presentationMode = 'courseware';
  assert.equal(c.canControlLockedVideo(), false);
});

test('missing or image-source orientation signals do not disable local zoom', () => {
  const { context: c, state } = fixture();
  c.handleTeacherOrientation({ orientation: 'landscape', rotationDegrees: 90 });
  assert.equal(state.framePresentation.screenSharing, false);
  assert.equal(c.canControlLockedVideo(), true);
  c.handleTeacherOrientation({ ...screenShare, frameLocked: true });
  assert.equal(state.framePresentation.screenSharing, false);
  assert.equal(c.canControlLockedVideo(), true);
});

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

test('all live video sources can start a local gesture, while pen and courseware do not', () => {
  const { context: c, state } = fixture();
  state.framePresentation.frameLocked = false;
  state.framePresentation.lockedFrameZoomRatio = 1;
  assert.equal(c.isLocalVideoViewEnabled(), true);
  c.beginLockedVideoPan(pointer(800, 450));
  assert.equal(state.lockedVideoPan.pointers.size, 1);
  c.finishLockedVideoPan(pointer(800, 450));
  state.annotations.tool = 'pen';
  assert.equal(c.beginLockedVideoPan(pointer(800, 450)), false);
  state.annotations.tool = 'pan';
  state.presentationMode = 'courseware';
  assert.equal(c.beginLockedVideoPan(pointer(800, 450)), false);
  assert.equal(c.canControlLockedVideo(), false);
});

test('unlocked portrait camera uses contain fit and remains zoomable', () => {
  const { context: c, state, elements } = fixture(900, 1600);
  state.framePresentation.frameLocked = false;
  state.framePresentation.lockedFrameZoomRatio = 1;
  state.framePresentation.screenSharing = false;
  state.videoOrientation.orientation = 'portrait';
  c.updateVideoPresentation();
  assert.equal(elements.panToolButton.hidden, false);
  const before = c.currentVideoContentRect();
  assert.equal(before.width, 506.25);
  c.zoomLockedVideo(2, { x: 800, y: 450 });
  assert.equal(state.lockedVideoPan.scale, 2);
  assert.equal(c.currentVideoContentRect().width, 1012.5);
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
