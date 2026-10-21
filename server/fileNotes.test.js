const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createCoursewareStore } = require('./coursewareStore');
const { normalizeAnnotation } = require('./annotationStore');
const { RoomManager } = require('./roomManager');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'myclass-notes-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const make = () => createCoursewareStore({ root, prefix: '/myclass' });
  const store = make();
  const input = path.join(root, 'input'); await fs.writeFile(input, 'test image');
  const image = await store.publish({ path: input }, 'image.png', 'alice');
  return { root, store, image, make, input };
}
const event = (action, page = 1, strokeId = 'one', extra = {}) => normalizeAnnotation({
  action, page, strokeId, points: [{ x: .2, y: .3 }], color: '#38bdf8', width: 5, ...extra
}, page);
async function stroke(store, url, page, id, extra = {}) {
  await store.fileNotes('alice', url, event('begin', page, id, extra), 'teacher');
  await store.fileNotes('alice', url, event('points', page, id, { points: [{ x: .7, y: .8 }] }), 'teacher');
  await store.fileNotes('alice', url, event('end', page, id), 'teacher');
}

test('file notes survive restart/rename, retain all pages and styles, and isolate copies/owners', async t => {
  const f = await fixture(t);
  await stroke(f.store, f.image.url, 1, 'one', { mode: 'highlighter' });
  await stroke(f.store, f.image.url, 2, 'two', { mode: 'dashed', lineMode: true });
  await stroke(f.store, f.image.url, 2, 'eraser', { isEraser: true, width: 40 });
  const before = await f.store.fileNotes('alice', f.image.url);
  assert.equal(before.strokes.length, 3);
  assert.equal(before.strokes[0].mode, 'highlighter');
  assert.equal(before.strokes[1].lineMode, true);
  assert.equal(before.strokes[2].isEraser, true);
  await f.store.rename(f.image.id, 'renamed', 'alice');
  const restarted = f.make();
  assert.deepEqual(await restarted.fileNotes('alice', f.image.url), before);
  assert.equal(await restarted.fileNotes('bob', f.image.url), null);
  const other = await restarted.publish({ path: f.input }, 'copy.png', 'bob');
  assert.deepEqual(await restarted.fileNotes('bob', other.url), { strokes: [], active: [] });
  await restarted.fileNotes('alice', f.image.url, event('clear', 1), 'teacher');
  const afterClear = await f.make().fileNotes('alice', f.image.url);
  assert.equal(afterClear.strokes.length, 2);
  assert.ok(afterClear.strokes.every(s => s.page === 2));
  await restarted.fileNotes('alice', f.image.url, event('undo', 2), 'viewer');
  assert.equal((await f.make().fileNotes('alice', f.image.url)).strokes.length, 1);
  await restarted.remove(f.image.id, 'alice');
  assert.equal(await restarted.fileNotes('alice', f.image.url, event('clear'), 'teacher'), null);
  await assert.rejects(fs.stat(path.join(f.root, '.annotations', f.image.id + '.jsonl')), { code: 'ENOENT' });
});

test('journal retains unfinished strokes and recovers only an incomplete final record', async t => {
  const f = await fixture(t);
  await f.store.fileNotes('alice', f.image.url, event('begin'), 'teacher');
  await f.store.fileNotes('alice', f.image.url, event('points'), 'teacher');
  const journal = path.join(f.root, '.annotations', f.image.id + '.jsonl');
  await fs.appendFile(journal, '{"message":');
  const restarted = f.make();
  assert.equal((await restarted.fileNotes('alice', f.image.url)).active[0].points.length, 2);
  await restarted.fileNotes('alice', f.image.url, event('end'), 'teacher');
  assert.equal((await f.make().fileNotes('alice', f.image.url)).strokes.length, 1);
  await fs.appendFile(journal, 'invalid complete record\n');
  await assert.rejects(f.make().fileNotes('alice', f.image.url), SyntaxError);
});

test('concurrent classrooms retain both strokes and storage errors do not acknowledge success', async t => {
  const f = await fixture(t);
  await Promise.all([stroke(f.store, f.image.url, 1, 'class-a'), stroke(f.store, f.image.url, 1, 'class-b')]);
  assert.equal((await f.make().fileNotes('alice', f.image.url)).strokes.length, 2);
  const manager = new RoomManager({ fileNotes: async () => { throw new Error('disk unavailable'); } });
  const viewer = socket(), teacher = socket();
  const { room } = manager.createRoom(viewer);
  manager.joinAsTeacher(room.code, teacher, { id: 'alice', username: 'alice' });
  assert.equal(await manager.forward(teacher, { type: 'courseware.open', url: f.image.url }), false);
  assert.match(teacher.messages.at(-1).message, /笔记保存或恢复失败/);
  assert.equal(viewer.messages.some(m => m.type === 'courseware.open' || m.type === 'annotations.snapshot'), false);
});

function socket() { return { readyState: 1, messages: [], send(raw) { this.messages.push(JSON.parse(raw)); }, close() {} }; }
test('room lifecycle restores file notes, protects against stale files, and supports direct teaching', async t => {
  const f = await fixture(t);
  const manager = new RoomManager({ fileNotes: (...args) => f.store.fileNotes(...args) });
  const viewer = socket(), teacher = socket(); viewer.supportsRecovery = true;
  const { room } = manager.createRoom(viewer);
  manager.joinAsTeacher(room.code, teacher, { id: 'alice', username: 'alice' });
  const open = { type: 'courseware.open', url: f.image.url, page: 1 };
  await manager.forward(teacher, open);
  for (const action of ['begin', 'points', 'end']) await manager.forward(teacher, event(action));
  await manager.forward(teacher, { type: 'teacher.stop' });
  await manager.forward(teacher, open);
  assert.equal(viewer.messages.filter(m => m.type === 'annotations.snapshot').at(-1).strokes.length, 1);
  await manager.forward(viewer, { ...event('clear'), type: 'viewer.annotation', url: '/wrong.png' });
  assert.equal((await f.store.fileNotes('alice', f.image.url)).strokes.length, 1);
  const direct = socket(), directRoom = manager.createRoom(direct).room;
  await manager.forward(direct, { ...open, type: 'viewer.courseware.open' }, { id: 'alice' });
  assert.equal(direct.messages.at(-1).strokes.length, 1);
  await manager.forward(direct, { ...event('clear'), type: 'viewer.annotation' });
  assert.equal((await f.make().fileNotes('alice', f.image.url)).strokes.length, 0);
  await manager.forward(teacher, open);
  assert.equal(teacher.messages.filter(m => m.type === 'annotations.snapshot').at(-1).cleared[1][0].length, 1);
  await manager.forward(teacher, event('undo'));
  assert.equal(room.presentation.strokes.length, 1);
  assert.equal((await f.make().fileNotes('alice', f.image.url)).strokes.length, 1);
  assert.equal(viewer.messages.at(-1).action, 'undo');
  assert.ok(directRoom.notesUserId);
});


test('clear undo restores all styles after restart, new strokes undo first and pages remain isolated', async t => {
  const f = await fixture(t);
  await stroke(f.store, f.image.url, 1, 'pen', { mode: 'highlighter' });
  await stroke(f.store, f.image.url, 1, 'erase', { isEraser: true, width: 80 });
  await stroke(f.store, f.image.url, 2, 'other');
  const before = await f.store.fileNotes('alice', f.image.url);
  await f.store.fileNotes('alice', f.image.url, event('clear', 1), 'teacher');
  const restarted = f.make();
  assert.equal((await restarted.fileNotes('alice', f.image.url)).cleared[1][0].length, 2);
  await stroke(restarted, f.image.url, 1, 'new');
  await restarted.fileNotes('alice', f.image.url, event('undo', 1), 'viewer');
  assert.equal((await restarted.fileNotes('alice', f.image.url)).strokes.length, 1);
  await restarted.fileNotes('alice', f.image.url, event('undo', 1), 'viewer');
  const after = await f.make().fileNotes('alice', f.image.url);
  assert.deepEqual(after.strokes.filter(s => s.page === 1), before.strokes.filter(s => s.page === 1));
  assert.deepEqual(after.strokes.filter(s => s.page === 2), before.strokes.filter(s => s.page === 2));
  await restarted.fileNotes('alice', f.image.url, event('clear', 1), 'viewer');
  await restarted.fileNotes('alice', f.image.url, event('clear', 1), 'viewer');
  await restarted.fileNotes('alice', f.image.url, event('undo', 1), 'teacher');
  assert.equal((await restarted.fileNotes('alice', f.image.url)).strokes.length, 3);
});
