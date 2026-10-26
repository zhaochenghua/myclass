const test = require('node:test');
const assert = require('node:assert/strict');
const { createFontRegeneration } = require('./fontRegeneration');
const { normalizeFontFamily } = require('./fontNames');

function setup({ families = new Set([normalizeFontFamily('Calibri')]), limit = 10, scanLimit = 10 } = {}) {
  const items = [
    { id: 'a', userId: 'alice', title: '语文', missingFonts: ['方正小标宋简体', 'Calibri'] },
    { id: 'b', userId: 'bob', title: '数学', missingFonts: ['方正小标宋简体'] },
    { id: 'c', userId: 'alice', title: '英语', missingFonts: ['Calibri'] },
    { id: 'd', userId: 'alice', title: '无缺失', missingFonts: [] }
  ];
  const calls = { scans: [], regenerated: [] };
  const coursewareStore = {
    scanMissingFonts: async scan => { calls.scans.push(scan); return { scanned: 0, pending: 0 }; },
    readIndex: async () => items,
    regenerate: async id => {
      calls.regenerated.push(id);
      const item = items.find(entry => entry.id === id);
      item.missingFonts = [];
      return { ok: true, id, title: item.title, missingFonts: [] };
    }
  };
  const fontStore = { knownFamilies: async () => families };
  const service = createFontRegeneration({ fontStore, coursewareStore, limit, scanLimit });
  return { items, calls, service, coursewareStore, fontStore };
}

test('missing-font state is scoped per teacher while pending regeneration is global', async () => {
  const { service, calls } = setup();
  const alice = await service.state({ id: 'alice', role: 'user' });
  assert.deepEqual(calls.scans, [10]);
  assert.equal(alice.missingCourseware, 1);
  assert.deepEqual(alice.missingFonts.map(font => font.family), ['方正小标宋简体']);
  assert.equal(alice.pendingRegeneration, 2);
  assert.equal(alice.scanPending, 0);

  const admin = await service.state({ id: 'root', role: 'admin' });
  assert.equal(admin.missingCourseware, 2);
  assert.deepEqual(admin.missingFonts.map(font => font.family), ['方正小标宋简体']);
  assert.equal(admin.missingFonts[0].coursewareCount, 2);
});

test('unsupported font platforms report nothing and never scan courseware', async () => {
  const { service, calls } = setup({ families: null });
  assert.deepEqual(await service.state({ id: 'alice', role: 'user' }),
    { missingFonts: [], missingCourseware: 0, pendingRegeneration: 0, scanPending: 0 });
  assert.deepEqual(await service.regenerate(), { supported: false, regenerated: [], failed: [], remaining: 0 });
  assert.deepEqual(calls.scans, []);
  assert.deepEqual(calls.regenerated, []);
});

test('unscanned legacy courseware is reported so the font page can continue scanning', async () => {
  const service = createFontRegeneration({
    limit: 5, scanLimit: 5,
    fontStore: { knownFamilies: async () => new Set() },
    coursewareStore: {
      scanMissingFonts: async () => ({ scanned: 5, pending: 7 }),
      readIndex: async () => [],
      regenerate: async () => null
    }
  });
  assert.equal((await service.state({ id: 'alice', role: 'user' })).scanPending, 7);
});

test('regeneration is capped per batch, skips previous failures unless forced and reports remaining work', async () => {
  const { service, calls, items } = setup({ limit: 1 });
  const first = await service.regenerate();
  assert.deepEqual(first.regenerated.map(item => item.id), ['a']);
  assert.equal(first.remaining, 1);
  assert.deepEqual(calls.regenerated, ['a']);

  items[2].regenerateError = '上次失败';
  const skipped = await service.regenerate();
  assert.deepEqual(skipped.regenerated, []);
  assert.equal(skipped.remaining, 1);
  assert.deepEqual(calls.regenerated, ['a']);

  const retried = await service.regenerate({ force: true });
  assert.deepEqual(retried.regenerated.map(item => item.id), ['c']);
  assert.equal(retried.remaining, 0);
});

test('concurrent regeneration requests are serialized so one document converts once', async () => {
  const items = [{ id: 'only', userId: 'alice', title: '课件', missingFonts: ['Calibri'] }];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let active = 0;
  let peak = 0;
  const service = createFontRegeneration({
    limit: 10, scanLimit: 0,
    fontStore: { knownFamilies: async () => new Set([normalizeFontFamily('Calibri')]) },
    coursewareStore: {
      scanMissingFonts: async () => ({ scanned: 0, pending: 0 }),
      readIndex: async () => items,
      regenerate: async id => {
        active++;
        peak = Math.max(peak, active);
        await gate;
        active--;
        items[0].missingFonts = [];
        return { ok: true, id, title: '课件', missingFonts: [] };
      }
    }
  });
  const first = service.regenerate();
  const second = service.regenerate();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(peak, 1);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.regenerated.length, 1);
  assert.equal(b.regenerated.length, 0);
  assert.equal(b.remaining, 0);
});
