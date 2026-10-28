const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./testSupport');

test('homework APIs are teacher-scoped, batch-save statuses and expose statistics', async t => {
  const server = await startTestServer();
  t.after(server.close);
  const { item } = await (await server.api('/classes', 'alice', 'POST', { name: '七（1）班' })).json();
  const students = [{ number: '01', name: '张三' }, { number: '02', name: '李四' }];
  await server.api(`/classes/${item.id}`, 'alice', 'PUT', { name: item.name, students, revision: 1 });

  assert.equal((await fetch(`${server.base}/api/classes/${item.id}/homework`)).status, 401);
  assert.equal((await server.api(`/classes/${item.id}/homework`, 'bob')).status, 404);
  assert.equal((await server.api(`/classes/${item.id}/homework/stats`, 'bob')).status, 404);
  assert.equal((await server.api(`/classes/${item.id}/homework`, 'bob', 'POST', { title: '作业', date: '2026-10-28' })).status, 404);

  const created = await server.api(`/classes/${item.id}/homework`, 'alice', 'POST', { title: '第一单元练习', date: '2026-10-28' });
  assert.equal(created.status, 201);
  const homework = (await created.json()).item;
  assert.deepEqual(homework.records, {});
  assert.equal((await server.api(`/classes/${item.id}/homework`, 'alice', 'POST', { title: '第一单元练习', date: '2026-10-28' })).status, 409);

  const listResponse = await server.api(`/classes/${item.id}/homework`, 'alice');
  assert.equal(listResponse.headers.get('cache-control'), 'no-store');
  const list = await listResponse.json();
  assert.equal(list.total, 1);
  assert.deepEqual(list.items[0].counts, { excellent: 0, copy: 0, wrong: 0, missing: 0, recorded: 0, unmarked: 2, total: 2 });
  assert.equal('homework' in (await (await server.api('/classes', 'alice')).json()).items[0], false);
  assert.equal((await (await server.api('/classes', 'alice')).json()).items[0].homeworkCount, 1);

  const saved = await server.api(`/classes/${item.id}/homework/${homework.id}`, 'alice', 'PATCH', {
    records: { '01': 'excellent', '02': 'missing' }
  });
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).counts, { excellent: 1, copy: 0, wrong: 0, missing: 1, recorded: 2, unmarked: 0, total: 2 });
  assert.equal((await server.api(`/classes/${item.id}/homework/${homework.id}`, 'alice', 'PATCH', { records: { '99': 'wrong' } })).status, 400);
  assert.equal((await server.api(`/classes/${item.id}/homework/${homework.id}`, 'alice', 'PATCH', { records: { '01': 'not-a-status' } })).status, 400);

  const detail = await (await server.api(`/classes/${item.id}/homework/${homework.id}`, 'alice')).json();
  assert.deepEqual(detail.item.records, { '01': 'excellent', '02': 'missing' });

  // Clearing a status is part of the same batch endpoint.
  await server.api(`/classes/${item.id}/homework/${homework.id}`, 'alice', 'PATCH', { records: { '02': null } });
  assert.deepEqual((await (await server.api(`/classes/${item.id}/homework/${homework.id}`, 'alice')).json()).item.records, { '01': 'excellent' });

  const statsResponse = await server.api(`/classes/${item.id}/homework/stats`, 'alice');
  assert.equal(statsResponse.headers.get('cache-control'), 'no-store');
  const stats = await statsResponse.json();
  assert.deepEqual(stats.assignments.map(assignment => assignment.id), [homework.id]);
  assert.deepEqual(stats.students.map(student => student.records), [['excellent'], [null]]);
  assert.deepEqual(stats.totals, { excellent: 1, copy: 0, wrong: 0, missing: 0, recorded: 1, unmarked: 1, total: 2 });

  assert.equal((await server.api(`/classes/${item.id}/homework/${homework.id}`, 'bob', 'PATCH', { records: { '01': 'wrong' } })).status, 404);
  assert.equal((await server.api(`/classes/${item.id}/homework/${homework.id}`, 'bob', 'DELETE')).status, 404);
  assert.equal((await server.api(`/classes/${item.id}/homework/${homework.id}`, 'alice', 'DELETE')).status, 200);
  assert.equal((await (await server.api(`/classes/${item.id}/homework`, 'alice')).json()).total, 0);
  assert.equal((await (await server.api(`/classes/${item.id}/homework/${homework.id}`, 'alice')).status), 404);
});

test('homework history survives roster edits and class deletion removes it', async t => {
  const server = await startTestServer();
  t.after(server.close);
  const { item } = await (await server.api('/classes', 'alice', 'POST', { name: '一班' })).json();
  await server.api(`/classes/${item.id}`, 'alice', 'PUT', {
    name: item.name, revision: 1, students: [{ number: '01', name: '张三' }, { number: '02', name: '李四' }]
  });
  const homework = (await (await server.api(`/classes/${item.id}/homework`, 'alice', 'POST', {
    title: '期中小测', date: '2026-10-28'
  })).json()).item;
  await server.api(`/classes/${item.id}/homework/${homework.id}`, 'alice', 'PATCH', {
    records: { '01': 'excellent', '02': 'wrong' }
  });
  const edited = await (await server.api(`/classes/${item.id}`, 'alice', 'PUT', {
    name: '一班（新）', revision: 2, students: [{ number: '01', name: '张三' }]
  })).json();
  assert.equal(edited.item.homeworkCount, 1);
  const stats = await (await server.api(`/classes/${item.id}/homework/stats`, 'alice')).json();
  assert.equal(stats.students.length, 1);
  assert.deepEqual(stats.students[0].records, ['excellent']);
  assert.equal(stats.totals.total, 1);

  await server.api(`/classes/${item.id}?revision=3`, 'alice', 'DELETE');
  const list = await (await server.api('/classes', 'alice')).json();
  assert.deepEqual(list.items, []);
});
