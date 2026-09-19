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
