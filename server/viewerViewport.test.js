const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
const start = source.indexOf('let viewerViewportTimer = null;');
const end = source.indexOf('/** 仅复位状态', start);
const code = source.slice(start, end);
function rect(left, top, width, height) { return { left, top, width, height, right: left + width, bottom: top + height }; }
test('browser reports actual page intersection for 16:9, 4:3, zoom and pan', () => {
  for (const [viewport, content, expected] of [
    [rect(10, 20, 1600, 900), rect(10, 20, 1600, 2400), [0, 0, 1, 0.375]],
    [rect(10, 20, 1200, 900), rect(10, 20, 1200, 1800), [0, 0, 1, 0.5]],
    [rect(10, 20, 1200, 900), rect(-590, -880, 2400, 3600), [0.25, 0.25, 0.75, 0.5]],
    [rect(0, 0, 1200, 900), rect(100, 100, 1000, 700), [0, 0, 1, 1]],
  ]) {
    let run; let result;
    const context = vm.createContext({ setTimeout: callback => { run = callback; return 1; },
      isCoursewarePdfVisible: () => true, clamp: (n,a,b) => Math.max(a,Math.min(b,n)),
      WebSocket: { OPEN: 1 }, state: { socket: { readyState: 1 }, teacherConnected: false, courseware: { url: '/test.pdf', page: 3 }, presentationRevision: 2 },
      elements: { videoView: { hidden: false, getBoundingClientRect: () => viewport }, coursewareCanvas: { getBoundingClientRect: () => content } },
      sendMessage: payload => { result = payload; } });
    vm.runInContext(code + '\nreportViewerCoursewareViewport(); reportViewerCoursewareViewport();', context);
    run();
    assert.deepEqual([result.left,result.top,result.right,result.bottom], expected);
    assert.equal(result.page,3);
    assert.equal(result.presentationRevision,2);
  }
});


test('viewport reporting recovers after stopped playback, disconnected socket and zero layout', () => {
  let run;
  const reports = [];
  let viewport = rect(0,0,0,0);
  const state = { teacherConnected: false, socket: { readyState: 0 },
    courseware: { url: '/book.pdf', page: 2 }, presentationRevision: 4 };
  const context = vm.createContext({ WebSocket: { OPEN: 1 }, state,
    setTimeout: callback => { run = callback; return 1; },
    isCoursewarePdfVisible: () => true, clamp: (n,a,b) => Math.max(a,Math.min(b,n)),
    elements: { videoView: { hidden: false, getBoundingClientRect: () => viewport },
      coursewareCanvas: { getBoundingClientRect: () => rect(0,0,1200,1800) } },
    sendMessage: payload => reports.push(payload) });
  vm.runInContext(code, context);
  const tick = () => { vm.runInContext('reportViewerCoursewareViewport()', context); run(); };
  tick();
  assert.equal(reports.length,0);
  state.socket.readyState = 1;
  tick();
  assert.equal(reports.length,0);
  viewport = rect(0,0,1200,900);
  tick();
  assert.equal(reports.length,1);
  assert.equal(reports[0].bottom,0.5);
  // Playback remains stopped: subsequent repair ticks must still reach the phone.
  tick();
  assert.equal(reports.length,2);
  assert.equal(reports[1].page,2);
});
