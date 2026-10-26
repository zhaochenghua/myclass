const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createClassStore, validateStudents } = require('./classStore');
const { parse, candidates } = require('../web/studentRoster');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'myclass-roster-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return createClassStore(path.join(directory, 'classes.json'));
}

test('class CRUD is teacher scoped; student numbers retain leading zeros and real gaps', async t => {
  const store = await fixture(t);
  const item = await store.create('alice', { name: '七（1）班' });
  await store.create('bob', { name: '七（1）班' });
  assert.equal((await store.list('alice')).length, 1);
  await assert.rejects(store.get('bob', item.id), { status: 404 });
  const saved = await store.update('alice', item.id, { name: '七（2）班', revision: 1,
    students: [{ number: '01', name: '王同学' }, { number: '09', name: '王同学' }] });
  assert.deepEqual(candidates(saved, 'number').map(item => item.text), ['01', '09']);
  assert.deepEqual(candidates(saved, 'name').map(item => item.text), ['王同学', '王同学']);
  await assert.rejects(store.update('bob', item.id, { ...saved, students: [] }), { status: 404 });
  await assert.rejects(store.remove('bob', item.id, 2), { status: 404 });
  await assert.rejects(store.remove('alice', item.id, 1), { status: 409 });
  await store.remove('alice', item.id, 2);
  assert.deepEqual(await store.list('alice'), []);
  assert.equal((await store.list('bob')).length, 1);
});

test('concurrent class writes keep all classes and reject stale roster edits', async t => {
  const store = await fixture(t);
  const items = await Promise.all(Array.from({ length: 12 }, (_, i) => store.create('alice', { name: `班级${i}` })));
  assert.equal((await store.list('alice')).length, 12);
  const result = await Promise.allSettled(['张三', '李四'].map(name => store.update('alice', items[0].id, {
    name: items[0].name, revision: 1, students: [{ number: '001', name }]
  })));
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(result.find(r => r.status === 'rejected').reason.status, 409);
  const sameName = await Promise.allSettled([store.create('alice', { name: '新班' }), store.create('alice', { name: '新班' })]);
  assert.equal(sameName.filter(r => r.status === 'fulfilled').length, 1);
});

test('Excel paste supports headers and whitespace, rejects duplicate or malformed numbers', () => {
  const students = parse('学号\t姓名\r\n01\t张三\r\n07 李 四\n\n09，王五');
  assert.deepEqual(validateStudents(students), [
    { number: '01', name: '张三' }, { number: '07', name: '李 四' }, { number: '09', name: '王五' }
  ]);
  assert.throws(() => parse('01 张三\n01 李四'), /重复/);
  assert.throws(() => validateStudents([{ number: '01', name: '张三' }, { number: '01', name: '李四' }]), /重复/);
  assert.throws(() => parse('只有姓名'), /第 1 行/);
  assert.throws(() => validateStudents([{ number: '', name: '张三' }]), { status: 400 });
  assert.throws(() => validateStudents(Array(501).fill({ number: '1', name: '张三' })), /500/);
  assert.throws(() => candidates({ students: [] }, 'name'), /没有学生/);
  assert.deepEqual(candidates(null, 'name', 3).map(item => item.text), ['01', '02', '03']);
});

test('draw history is recorded per class, hidden from list responses and clearable without resetting progress', async t => {
  const store = await fixture(t);
  const item = await store.create('alice', { name: '一班' });
  const students = [{ number: '01', name: '张三' }, { number: '02', name: '李四' }];
  await store.update('alice', item.id, { name: item.name, students, revision: 1 });
  const first = await store.draw('alice', item.id, 'name');
  const second = await store.draw('alice', item.id, 'number');
  const log = await store.drawLog('alice', item.id);
  assert.equal(log.total, 2);
  assert.deepEqual(log.items.map(entry => entry.number), [second.candidate.id, first.candidate.id]);
  assert.equal(log.items[0].mode, 'number');
  assert.equal(log.items[0].name, students.find(student => student.number === log.items[0].number).name);
  assert.ok(log.items.every(entry => Date.parse(entry.at) > 0));
  assert.equal('drawLog' in (await store.list('alice'))[0], false);
  assert.equal('drawLog' in await store.get('alice', item.id), false);
  await assert.rejects(store.drawLog('bob', item.id), { status: 404 });
  await assert.rejects(store.clearDrawLog('bob', item.id), { status: 404 });
  const third = await store.draw('alice', item.id, 'name');
  assert.equal(third.round, 2);
  assert.deepEqual((await store.drawLog('alice', item.id)).items.map(entry => entry.number),
    [third.candidate.id, second.candidate.id, first.candidate.id]);
  assert.deepEqual(await store.clearDrawLog('alice', item.id), { cleared: 3 });
  assert.deepEqual(await store.drawLog('alice', item.id), { items: [], total: 0 });
});

test('draw history keeps only the newest 500 entries and clamps the requested page size', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'myclass-draw-log-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'classes.json');
  const store = createClassStore(filename);
  const item = await store.create('alice', { name: '一班' });
  await store.update('alice', item.id, { name: '一班', students: [{ number: '01', name: '张三' }], revision: 1 });
  const data = JSON.parse(await fs.readFile(filename, 'utf8'));
  data[0].drawLog = Array.from({ length: 600 }, (_, index) => ({
    number: '01', name: '张三', mode: 'name', round: 1, remaining: 0, total: 1,
    at: new Date(index).toISOString()
  }));
  await fs.writeFile(filename, JSON.stringify(data));
  await store.draw('alice', item.id, 'name');
  const saved = JSON.parse(await fs.readFile(filename, 'utf8'))[0].drawLog;
  assert.equal(saved.length, 500);
  assert.ok(Date.parse(saved[saved.length - 1].at) > Date.parse(saved[saved.length - 2].at),
    'the new draw must be the newest entry');
  const page = await store.drawLog('alice', item.id, { limit: 999 });
  assert.equal(page.items.length, 500);
  assert.equal(page.total, 500);
});

test('removing a teacher removes only that teacher’s rosters', async t => {
  const store = await fixture(t);
  await store.create('alice', { name: '一班' });
  await store.create('bob', { name: '一班' });
  await store.removeOwner('alice');
  assert.deepEqual(await store.list('alice'), []);
  assert.equal((await store.list('bob')).length, 1);
});
