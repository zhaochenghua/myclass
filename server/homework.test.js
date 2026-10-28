const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createClassStore } = require('./classStore');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'myclass-homework-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'classes.json');
  return { store: createClassStore(filename), filename };
}

async function classWithRoster(store) {
  const item = await store.create('alice', { name: '七（1）班' });
  await store.update('alice', item.id, {
    name: item.name, revision: 1,
    students: [{ number: '01', name: '张三' }, { number: '02', name: '李四' }, { number: '03', name: '王五' }]
  });
  return item;
}

test('homework sessions can be created, registered, listed and deleted per teacher', async t => {
  const { store } = await fixture(t);
  await assert.rejects(store.createHomework('alice', 'missing', { title: '作业', date: '2026-10-28' }), { status: 404 });
  const item = await classWithRoster(store);
  await assert.rejects(store.createHomework('alice', item.id, { title: '', date: '2026-10-28' }), { status: 400 });
  await assert.rejects(store.createHomework('alice', item.id, { title: '作业', date: '2026-02-30' }), { status: 400 });
  assert.equal((await store.homeworkList('alice', item.id)).total, 0);

  const first = await store.createHomework('alice', item.id, { title: '第一单元练习', date: '2026-10-27' });
  const second = await store.createHomework('alice', item.id, { title: '第二单元练习', date: '2026-10-28' });
  await assert.rejects(store.createHomework('alice', item.id, { title: '第一单元练习', date: '2026-10-27' }), { status: 409 });
  assert.equal((await store.homeworkList('alice', item.id)).items[0].id, second.id, 'newest assignment must come first');
  assert.equal('homework' in await store.get('alice', item.id), false);
  assert.equal((await store.get('alice', item.id)).homeworkCount, 2);

  const updated = await store.setHomeworkRecords('alice', item.id, first.id, {
    records: { '01': 'excellent', '02': 'copy', '03': null }
  });
  assert.deepEqual(updated.counts, { excellent: 1, copy: 1, wrong: 0, missing: 0, recorded: 2, unmarked: 1, total: 3 });
  assert.deepEqual((await store.homeworkGet('alice', item.id, first.id)).records, { '01': 'excellent', '02': 'copy' });
  // A later click clears an existing status.
  await store.setHomeworkRecords('alice', item.id, first.id, { records: { '01': null, '03': 'missing' } });
  assert.deepEqual((await store.homeworkGet('alice', item.id, first.id)).records, { '02': 'copy', '03': 'missing' });

  await assert.rejects(store.setHomeworkRecords('alice', item.id, first.id, { records: { '99': 'wrong' } }), { status: 400 });
  await assert.rejects(store.setHomeworkRecords('alice', item.id, first.id, { records: { '01': 'unknown' } }), { status: 400 });
  // The rejected batch must not partially apply.
  assert.deepEqual((await store.homeworkGet('alice', item.id, first.id)).records, { '02': 'copy', '03': 'missing' });

  await assert.rejects(store.homeworkList('bob', item.id), { status: 404 });
  await assert.rejects(store.homeworkGet('bob', item.id, first.id), { status: 404 });
  await assert.rejects(store.setHomeworkRecords('bob', item.id, first.id, { records: { '01': 'excellent' } }), { status: 404 });
  await assert.rejects(store.removeHomework('bob', item.id, first.id), { status: 404 });

  assert.deepEqual(await store.removeHomework('alice', item.id, first.id), { ok: true, id: first.id });
  await assert.rejects(store.homeworkGet('alice', item.id, first.id), { status: 404 });
  assert.equal((await store.homeworkList('alice', item.id)).total, 1);
});

test('homework statistics show every assignment in date order and ignore removed students', async t => {
  const { store } = await fixture(t);
  const item = await classWithRoster(store);
  const later = await store.createHomework('alice', item.id, { title: '第二次', date: '2026-10-29' });
  const earlier = await store.createHomework('alice', item.id, { title: '第一次', date: '2026-10-28' });
  await store.setHomeworkRecords('alice', item.id, earlier.id, { records: { '01': 'excellent', '02': 'wrong', '03': 'missing' } });
  await store.setHomeworkRecords('alice', item.id, later.id, { records: { '01': 'copy', '02': 'wrong' } });

  const stats = await store.homeworkStats('alice', item.id);
  assert.deepEqual(stats.assignments.map(assignment => assignment.title), ['第一次', '第二次']);
  assert.deepEqual(stats.students.map(student => student.name), ['张三', '李四', '王五']);
  assert.deepEqual(stats.students[0].records, ['excellent', 'copy']);
  assert.deepEqual(stats.students[1].records, ['wrong', 'wrong']);
  assert.deepEqual(stats.students[2].records, ['missing', null]);
  assert.deepEqual(stats.students[0].totals, { excellent: 1, copy: 1, wrong: 0, missing: 0, recorded: 2, unmarked: 0, total: 2 });
  assert.deepEqual(stats.students[2].totals, { excellent: 0, copy: 0, wrong: 0, missing: 1, recorded: 1, unmarked: 1, total: 2 });
  assert.deepEqual(stats.totals, { excellent: 1, copy: 1, wrong: 2, missing: 1, recorded: 5, unmarked: 1, total: 6 });

  // Removing a student hides their old records from the statistics, but the
  // data stays in classes.json so re-adding the same number restores it.
  await store.update('alice', item.id, {
    name: item.name, revision: 2,
    students: [{ number: '01', name: '张三' }, { number: '02', name: '李四' }]
  });
  const afterRemoval = await store.homeworkStats('alice', item.id);
  assert.deepEqual(afterRemoval.students.map(student => student.number), ['01', '02']);
  assert.deepEqual(afterRemoval.totals, { excellent: 1, copy: 1, wrong: 2, missing: 0, recorded: 4, unmarked: 0, total: 4 });
  await store.update('alice', item.id, {
    name: item.name, revision: 3,
    students: [{ number: '01', name: '张三' }, { number: '02', name: '李四' }, { number: '03', name: '王五' }]
  });
  assert.deepEqual((await store.homeworkStats('alice', item.id)).students[2].records, ['missing', null]);
});

test('homework keeps the newest 200 sessions and rejects invalid student-number keys safely', async t => {
  const { store, filename } = await fixture(t);
  const item = await classWithRoster(store);
  await store.update('alice', item.id, {
    name: item.name, revision: 2,
    students: [{ number: '__proto__', name: '特殊学号' }, { number: '01', name: '张三' }]
  });
  const created = await store.createHomework('alice', item.id, { title: '测试', date: '2026-10-28' });
  await store.setHomeworkRecords('alice', item.id, created.id, { records: { ['__proto__']: 'excellent' } });
  assert.deepEqual((await store.homeworkGet('alice', item.id, created.id)).records, { ['__proto__']: 'excellent' });
  assert.equal((await store.homeworkStats('alice', item.id)).students[0].records[0], 'excellent');

  const data = JSON.parse(await fs.readFile(filename, 'utf8'));
  data[0].homework = Array.from({ length: 200 }, (_, index) => ({
    id: `hw-${index}`, title: `作业 ${index}`, date: '2026-10-01',
    records: {}, createdAt: new Date(index).toISOString(), updatedAt: new Date(index).toISOString()
  }));
  await fs.writeFile(filename, JSON.stringify(data));
  await assert.rejects(store.createHomework('alice', item.id, { title: '超限', date: '2026-10-28' }), /最多保留 200/);
});
