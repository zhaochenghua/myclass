const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { startTestServer } = require('./testSupport');
const { createClassStore } = require('./classStore');
const { targets, fit, apply, validateProfile } = require('../web/touchCalibrationMath');
const viewport = { width: 1920, height: 1080, fullscreen: true };
const profile = { version: 1, ...viewport, matrix: [1, 0, -.025, 0, 1, .02] };

test('five point calibration corrects translation, scale and skew across the whole screen', () => {
  const raw = p => ({ x: p.x * .93 + p.y * .035 + .03, y: p.y * 1.05 - p.x * .025 - .01 });
  const fitted = fit(targets.map(raw), viewport);
  assert.ok(validateProfile(fitted));
  for (const p of [...targets, { x: .27, y: .67 }, { x: 0, y: 1 }]) {
    const q = apply(fitted.matrix, raw(p));
    assert.ok(Math.hypot(q.x - p.x, q.y - p.y) < 1e-9);
  }
});
test('bad taps, degenerate geometry and invalid server payloads are rejected', () => {
  assert.throws(() => fit(targets.map(() => ({ x: .5, y: .5 })), viewport));
  assert.throws(() => fit(targets.map((p, i) => i === 4 ? { x: .6, y: .7 } : p), viewport));
  assert.throws(() => fit(targets.slice(1), viewport));
  for (const p of [null, {}, { ...profile, matrix: [0, 0, 0, 0, 0, 0] },
    { ...profile, matrix: [1, 0, Infinity, 0, 1, 0] }, { ...profile, width: -1 }]) assert.equal(validateProfile(p), false);
});
test('class calibration persists, isolates teachers/classes, prevents stale writes and survives roster edits', async t => {
  const server = await startTestServer(); t.after(server.close);
  const a = (await (await server.api('/classes', 'alice', 'POST', { name: '一班' })).json()).item;
  const b = (await (await server.api('/classes', 'alice', 'POST', { name: '二班' })).json()).item;
  const route = `/classes/${a.id}/touch-calibration`;
  assert.equal((await fetch(`${server.base}/api${route}`)).status, 401);
  assert.equal((await fetch(`${server.base}/api${route}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile, revision: 0 }) })).status, 401);
  assert.equal((await server.api(route, 'bob')).status, 404);
  assert.equal((await server.api(route, 'bob', 'PUT', { profile, revision: 0 })).status, 404);
  assert.equal((await server.api(route, 'alice', 'PUT', { profile: {}, revision: 0 })).status, 400);
  assert.equal((await server.api(route, 'alice', 'PUT', { profile, revision: 0 })).status, 200);
  assert.equal((await server.api(route, 'alice', 'PUT', { profile: null, revision: 0 })).status, 409);
  assert.equal((await (await server.api(`/classes/${b.id}/touch-calibration`)).json()).profile, null);
  assert.equal((await server.api(`/classes/${a.id}`, 'alice', 'PUT', { name: '改名', students: [], revision: 1 })).status, 200);
  const loaded = await server.api(route);
  assert.equal(loaded.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await loaded.json(), { profile, revision: 1 });
  const reopened = createClassStore(path.join(server.directory, 'server/data/classes.json'));
  assert.deepEqual((await reopened.get('alice', a.id)).touchCalibration, profile);
  assert.equal((await server.api(route, 'alice', 'PUT', { profile: null, revision: 1 })).status, 200);
  assert.equal((await (await server.api(route)).json()).profile, null);
  assert.equal((await server.api(`/classes/${a.id}?revision=2`, 'alice', 'DELETE')).status, 200);
  assert.equal((await server.api(route)).status, 404);
  assert.equal((JSON.parse(await fs.readFile(path.join(server.directory, 'server/data/classes.json')))).length, 1);
});
