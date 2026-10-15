const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture() {
  const source = fs.readFileSync(`${__dirname}/main.js`, 'utf8');
  const body = source.slice(source.indexOf('async function getCaptureRegionDIP()'), source.indexOf('// Pushes the cursor point'));
  let resolve, queries = 0;
  const context = vm.createContext({
    selectedSourceType: 'window', selectedSourceId: 'window:1:0', selectedWindowRectCache: null,
    lastWindowRectQueryAt: 0, windowRectQueryInFlight: false,
    parseWindowHandle: id => Number(id.split(':')[1]),
    runWindowRectQuery: () => { queries++; return new Promise(done => { resolve = done; }); },
    screen: { screenToDipRect: (_, rect) => ({ x: rect.x + 200, y: rect.y / 2, width: rect.width / 2, height: rect.height / 2 }) }
  });
  vm.runInContext(body, context);
  return { context, open: () => context.getCaptureRegionDIP(), queries: () => queries,
    release: () => resolve({ ok: true, x: -100, y: 40, width: 800, height: 600, dpi: 192 }) };
}

test('initial cursor samples share one window query instead of spawning per tick', async () => {
  const f = fixture();
  const first = f.open();
  const pending = Array.from({ length: 120 }, () => f.open());
  assert.equal(f.queries(), 1);
  f.release();
  assert.deepEqual(JSON.parse(JSON.stringify(await first)), { x: 100, y: 20, width: 400, height: 300 });
  await Promise.all(pending);
  await f.open();
  assert.equal(f.queries(), 1);
});

test('late window geometry cannot overwrite a newly selected source', async () => {
  const f = fixture();
  const pending = f.open();
  f.context.selectedSourceId = 'window:2:0';
  f.release();
  assert.equal(await pending, null);
  assert.equal(f.context.selectedWindowRectCache, null);
});

test('screen capture uses native overlay and never queries HWND geometry', async () => {
  const f = fixture();
  f.context.selectedSourceType = 'screen';
  assert.equal(await f.open(), null);
  assert.equal(f.queries(), 0);
});
