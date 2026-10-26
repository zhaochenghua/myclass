const test = require('node:test');
const assert = require('node:assert/strict');
const { createFontRegeneration } = require('./fontRegeneration');
const { normalizeFontFamily } = require('./fontNames');

function setup({ families = new Set([normalizeFontFamily('Calibri')]), limit = 10, scanLimit = 10 } = {}) {
  const items = [
    { id: 'a', userId: 'alice', title: '语文', missingFonts: ['方正小标宋简体', 'Calibri'] },
    { id: 'b', userId: 'bob', title: '数学', missingFonts: ['方正小标宋简体'] },
    { id: 'c', userId: 'alice', title: '英语', missingFonts: ['Calibri'] },
    { id: 'd', userId: 'alice', title: '无缺失', missingFonts: [] },
    { id: 'e', userId: 'admin', title: '共享课件', missingFonts: ['Shared Font'] },
    { id: 'f', userId: 'root', title: '管理员课件', missingFonts: ['Calibri'] },
    { id: 'g', userId: 'legacy', title: '旧版课件', missingFonts: ['Legacy Font'] }
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

test('missing-font state and pending work are scoped per teacher; admins also see the shared bucket', async () => {
  const { service, calls } = setup();
  const alice = await service.state({ id: 'alice', role: 'user' });
  assert.deepEqual(calls.scans, [10]);
  assert.equal(alice.missingCourseware, 1);
  assert.deepEqual(alice.missingFonts.map(font => font.family), ['方正小标宋简体']);
  assert.equal(alice.pendingRegeneration, 2);
  assert.equal(alice.scanPending, 0);

  const bob = await service.state({ id: 'bob', role: 'user' });
  assert.equal(bob.missingCourseware, 1);
  assert.equal(bob.pendingRegeneration, 0, 'the installed Calibri belongs to another teacher');

  // Admin: own uploads + shared/legacy platform uploads, never Alice/Bob files.
  const admin = await service.state({ id: 'root', role: 'admin' });
  assert.equal(admin.missingCourseware, 2);
  assert.deepEqual(admin.missingFonts.map(font => font.family).sort(), ['Legacy Font', 'Shared Font'].sort());
  assert.equal(admin.pendingRegeneration, 1, 'only the admin-owned document needs regeneration');
});

test('unsupported font platforms report nothing and never scan courseware', async () => {
  const { service, calls } = setup({ families: null });
  assert.deepEqual(await service.state({ id: 'alice', role: 'user' }),
    { missingFonts: [], missingCourseware: 0, pendingRegeneration: 0, scanPending: 0 });
  assert.deepEqual(await service.regenerate({ user: { id: 'alice', role: 'user' } }),
    { supported: false, regenerated: [], failed: [], remaining: 0 });
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
  const alice = { id: 'alice', role: 'user' };
  const first = await service.regenerate({ user: alice });
  assert.deepEqual(first.regenerated.map(item => item.id), ['a']);
  assert.equal(first.remaining, 1);
  assert.deepEqual(calls.regenerated, ['a']);

  items[2].regenerateError = '上次失败';
  const skipped = await service.regenerate({ user: alice });
  assert.deepEqual(skipped.regenerated, []);
  assert.equal(skipped.remaining, 1);
  assert.deepEqual(calls.regenerated, ['a']);

  const retried = await service.regenerate({ force: true, user: alice });
  assert.deepEqual(retried.regenerated.map(item => item.id), ['c']);
  assert.equal(retried.remaining, 0);

  // Bob's own document does not need work and Alice's are never touched.
  const bob = await service.regenerate({ user: { id: 'bob', role: 'user' } });
  assert.deepEqual(bob.regenerated, []);
  assert.equal(bob.remaining, 0);
  assert.deepEqual(calls.regenerated, ['a', 'c']);
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
  const first = service.regenerate({ user: { id: 'alice', role: 'user' } });
  const second = service.regenerate({ user: { id: 'alice', role: 'user' } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(peak, 1);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.regenerated.length, 1);
  assert.equal(b.regenerated.length, 0);
  assert.equal(b.remaining, 0);
});
