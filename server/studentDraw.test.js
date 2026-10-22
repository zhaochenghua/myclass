const test = require('node:test');
const assert = require('node:assert/strict');
const { candidates, createRoundDraw } = require('../web/studentRoster');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createClassStore } = require('./classStore');
const { startTestServer } = require('./testSupport');

test('each round covers the whole class once, then starts a fresh round', () => {
  for (const count of [1, 2, 50, 80, 500]) {
    const items = candidates(null, 'number', count);
    const rounds = createRoundDraw();
    for (let round = 1; round <= 3; round++) {
      const seen = new Set();
      for (let i = 0; i < count; i++) {
        const result = rounds.draw('class-a', items);
        assert.equal(result.round, round);
        assert.equal(result.remaining, count - i - 1);
        assert.ok(!seen.has(result.candidate.id));
        seen.add(result.candidate.id);
      }
      assert.equal(seen.size, count);
    }
  }
});

test('class and teacher scopes remain independent when switching back and forth', () => {
  const rounds = createRoundDraw(() => 0);
  const items = candidates(null, 'number', 3);
  for (const scope of ['alice/a', 'alice/b', 'bob/a']) {
    assert.equal(rounds.draw(scope, items).candidate.id, '1');
  }
  assert.equal(rounds.draw('alice/a', items).candidate.id, '2');
  assert.equal(rounds.draw('alice/b', items).candidate.id, '2');
});

test('names, order and display mode do not reset a round; equal names are distinct students', () => {
  const rounds = createRoundDraw(() => 0);
  const roster = { name: '一班', students: [{ number: '01', name: '王同学' }, { number: '09', name: '王同学' }] };
  assert.equal(rounds.draw('a', candidates(roster, 'name')).candidate.id, '01');
  roster.students.reverse();
  roster.students[0].name = '新姓名';
  const result = rounds.draw('a', candidates(roster, 'number'));
  assert.equal(result.candidate.id, '09');
  assert.equal(result.remaining, 0);
  assert.equal(result.round, 1);
});

test('preview never consumes a draw; new students join the round and removed students do not block it', () => {
  const rounds = createRoundDraw(() => 0);
  const items = candidates(null, 'number', 3);
  for (let i = 0; i < 100; i++) assert.equal(rounds.preview('a', items).length, 3);
  assert.equal(rounds.draw('a', items).candidate.id, '1');
  const revised = [items[0], items[2], { id: '4', text: '04', detail: '' }];
  assert.equal(rounds.draw('a', revised).candidate.id, '3');
  assert.equal(rounds.draw('a', revised).candidate.id, '4');
  for (let i = 0; i < 100; i++) rounds.preview('a', revised);
  assert.equal(rounds.draw('a', revised).round, 2);
  assert.throws(() => rounds.draw('empty', []), /没有可抽取/);
});

test('recent half-class is avoided across round boundaries, including a two-student class', () => {
  for (const count of [1, 2, 3, 50, 80, 500]) {
    const rounds = createRoundDraw(() => 0);
    const items = candidates(null, 'number', count);
    const recent = [];
    for (let i = 0; i < count * 4; i++) {
      const { candidate } = rounds.draw('a', items);
      if (count > 1) assert.ok(!recent.includes(candidate.id), `count=${count}, draw=${i}`);
      recent.push(candidate.id);
      if (recent.length > Math.floor(count / 2)) recent.shift();
    }
  }
});

test('number-only progress survives reopening without preview writes', () => {
  const saved = new Map();
  const storage = {
    load: scope => JSON.parse(saved.get(scope) || 'null'),
    save: (scope, state) => saved.set(scope, JSON.stringify(state))
  };
  const items = candidates(null, 'number', 5);
  const seen = new Set();
  for (let lesson = 0; lesson < 5; lesson++) {
    const rounds = createRoundDraw(() => 0, storage);
    const before = saved.get('alice/numbers');
    for (let i = 0; i < 10; i++) rounds.preview('alice/numbers', items);
    assert.equal(saved.get('alice/numbers'), before);
    const result = rounds.draw('alice/numbers', items);
    assert.equal(result.round, 1);
    assert.ok(!seen.has(result.candidate.id));
    seen.add(result.candidate.id);
  }
  assert.equal(createRoundDraw(() => 0, storage).draw('alice/numbers', items).round, 2);
  assert.equal(createRoundDraw(() => 0, storage).draw('bob/numbers', items).round, 1);
});

test('class draw progress survives store restart and roster edits without changing roster revision', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'myclass-draw-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'classes.json');
  let store = createClassStore(filename);
  const item = await store.create('alice', { name: '一班' });
  const students = ['01', '03', '09', '12'].map(number => ({ number, name: '同名学生' }));
  await store.update('alice', item.id, { name: item.name, students, revision: 1 });
  const first = await store.draw('alice', item.id, 'name');
  store = createClassStore(filename);
  const seen = new Set([first.candidate.id]);
  for (let i = 0; i < 3; i++) {
    const result = await store.draw('alice', item.id, 'number');
    assert.equal(result.round, 1);
    assert.ok(!seen.has(result.candidate.id));
    seen.add(result.candidate.id);
  }
  assert.equal((await store.get('alice', item.id)).revision, 2);
  const next = await store.draw('alice', item.id, 'name');
  assert.equal(next.round, 2);
  const revised = [students.find(s => s.number === next.candidate.id), { number: '20', name: '新学生' }];
  await store.update('alice', item.id, { name: '改名', students: revised, revision: 2 });
  store = createClassStore(filename);
  const added = await store.draw('alice', item.id, 'number');
  assert.equal(added.candidate.id, '20');
  assert.equal(added.round, 2);
  assert.equal(added.remaining, 0);
  await store.remove('alice', item.id, 3);
  assert.deepEqual(await store.list('alice'), []);
});

test('draw API authenticates and serializes concurrent screens using the latest roster', async t => {
  const server = await startTestServer(); t.after(server.close);
  const item = (await (await server.api('/classes', 'alice', 'POST', { name: '一班' })).json()).item;
  const route = `/classes/${item.id}`;
  const draw = `${route}/draw`;
  assert.equal((await fetch(`${server.base}/api${draw}`, { method: 'POST' })).status, 401);
  assert.equal((await server.api(draw, 'bob', 'POST', { mode: 'name' })).status, 404);
  assert.equal((await server.api(draw, 'alice', 'POST', { mode: 'name' })).status, 400);
  assert.equal((await server.api(draw, 'alice', 'POST', { mode: 'invalid' })).status, 400);
  const students = Array.from({ length: 8 }, (_, i) => ({ number: `0${i}`, name: `学生${i}` }));
  await server.api(route, 'alice', 'PUT', { name: '一班', students, revision: 1 });
  const outcomes = await Promise.all(students.map(async () => {
    const response = await server.api(draw, 'alice', 'POST', { mode: 'number' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return response.json();
  }));
  assert.equal(new Set(outcomes.map(o => o.candidate.id)).size, 8);
  assert.ok(outcomes.every(o => o.round === 1));
  assert.deepEqual(outcomes.map(o => o.remaining).sort(), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal((await (await server.api(draw, 'alice', 'POST', { mode: 'name' })).json()).round, 2);
  const other = (await (await server.api('/classes', 'alice', 'POST', { name: '二班' })).json()).item;
  await server.api(`/classes/${other.id}`, 'alice', 'PUT', { name: '二班', students, revision: 1 });
  assert.equal((await (await server.api(`/classes/${other.id}/draw`, 'alice', 'POST', { mode: 'name' })).json()).round, 1);
  await server.api(`${route}?revision=2`, 'alice', 'DELETE');
  assert.equal((await server.api(draw, 'alice', 'POST', { mode: 'name' })).status, 404);
});
