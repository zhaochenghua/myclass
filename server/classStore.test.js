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

test('removing a teacher removes only that teacher’s rosters', async t => {
  const store = await fixture(t);
  await store.create('alice', { name: '一班' });
  await store.create('bob', { name: '一班' });
  await store.removeOwner('alice');
  assert.deepEqual(await store.list('alice'), []);
  assert.equal((await store.list('bob')).length, 1);
});
