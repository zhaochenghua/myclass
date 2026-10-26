const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./testSupport');

test('class APIs require authentication, isolate teachers and validate edits/deletion', async t => {
  const server = await startTestServer();
  t.after(server.close);
  assert.equal((await fetch(`${server.base}/api/classes`)).status, 401);
  const created = await server.api('/classes', 'alice', 'POST', { name: '七（1）班' });
  assert.equal(created.status, 201);
  const { item } = await created.json();
  const route = `/classes/${item.id}`;
  assert.equal((await server.api('/classes', 'alice', 'POST', { name: item.name })).status, 409);
  assert.equal((await server.api(route, 'bob')).status, 404);
  const edit = { name: '七（2）班', students: [{ number: '01', name: '张三' }, { number: '03', name: '李四' }], revision: 1 };
  assert.equal((await server.api(route, 'bob', 'PUT', edit)).status, 404);
  assert.equal((await server.api(route, 'alice', 'PUT', { ...edit, students: [edit.students[0], edit.students[0]] })).status, 400);
  assert.equal((await server.api(route, 'alice', 'PUT', edit)).status, 200);
  assert.equal((await server.api(route, 'alice', 'PUT', edit)).status, 409);
  const list = await server.api('/classes');
  assert.equal(list.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await list.json()).items[0].students, edit.students);
  assert.deepEqual((await (await server.api('/classes', 'bob')).json()).items, []);
  assert.equal((await server.api(`${route}?revision=2`, 'bob', 'DELETE')).status, 404);
  assert.equal((await server.api(`${route}?revision=1`, 'alice', 'DELETE')).status, 409);
  assert.equal((await server.api(`${route}?revision=2`, 'alice', 'DELETE')).status, 200);
  assert.equal((await server.api(route)).status, 404);
});

test('draw log API is teacher-scoped, keeps the round after clearing and stays out of class lists', async t => {
  const server = await startTestServer();
  t.after(server.close);
  const { item } = await (await server.api('/classes', 'alice', 'POST', { name: '一班' })).json();
  const students = [{ number: '01', name: '张三' }, { number: '02', name: '李四' }];
  await server.api(`/classes/${item.id}`, 'alice', 'PUT', { name: item.name, students, revision: 1 });
  const outcome = await (await server.api(`/classes/${item.id}/draw`, 'alice', 'POST', { mode: 'name' })).json();
  const secondOutcome = await (await server.api(`/classes/${item.id}/draw`, 'alice', 'POST', { mode: 'number' })).json();
  assert.equal(secondOutcome.round, 1);
  assert.equal((await fetch(`${server.base}/api/classes/${item.id}/draw-log`)).status, 401);
  assert.equal((await server.api(`/classes/${item.id}/draw-log`, 'bob')).status, 404);
  assert.equal((await server.api(`/classes/${item.id}/draw-log`, 'bob', 'DELETE')).status, 404);
  const response = await server.api(`/classes/${item.id}/draw-log`, 'alice');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const log = await response.json();
  assert.equal(log.total, 2);
  assert.deepEqual(log.items.map(entry => entry.number), [secondOutcome.candidate.id, outcome.candidate.id]);
  assert.equal(log.items[1].name, students.find(student => student.number === outcome.candidate.id).name);
  assert.deepEqual((await (await server.api(`/classes/${item.id}/draw-log?limit=1`, 'alice')).json()).items.map(entry => entry.number),
    [secondOutcome.candidate.id]);
  assert.equal('drawLog' in (await (await server.api('/classes', 'alice')).json()).items[0], false);
  assert.equal((await server.api(`/classes/${item.id}/draw-log`, 'alice', 'DELETE')).status, 200);
  assert.equal((await (await server.api(`/classes/${item.id}/draw-log`, 'alice')).json()).total, 0);
  // Clearing history must not let the next draw repeat the same round.
  const next = await (await server.api(`/classes/${item.id}/draw`, 'alice', 'POST', { mode: 'number' })).json();
  assert.equal(next.round, 2);
});
