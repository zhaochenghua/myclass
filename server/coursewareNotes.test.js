const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createCoursewareStore } = require('./coursewareStore');
const { notesPptx } = require('./testFixtures/pptxNotesFixture');

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'myclass-notes-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'courseware');
  const input = path.join(directory, 'lesson.pptx');
  await fs.writeFile(input, notesPptx());
  const store = createCoursewareStore({ root, prefix: '/myclass',
    convertOfficeToPdf: async (source, ext, output) => fs.writeFile(output, 'converted PDF'), ...options });
  return {
    root, input, store,
    upload: (user = 'alice', name = 'lesson.pptx') => store.publish({ path: input }, name, user)
  };
}

test('uploaded PPTX notes are available without opening the file again', async t => {
  const f = await fixture(t);
  const item = await f.upload();
  assert.equal(await f.store.notesSupported(item), true);
  assert.deepEqual(await f.store.notes(item, 'alice'), [
    { slide: 1, text: '第一段备注\n第二段备注\n补充说明' },
    { slide: 3, text: '结尾备注' }
  ]);
  // Cached next to the object bundle, so a restart does not re-read the PPTX.
  const cached = path.join(f.root, '.objects', item.storageKey.slice(0, 2), item.storageKey, 'notes.json');
  assert.equal(JSON.parse(await fs.readFile(cached, 'utf8')).length, 2);
});

test('edits are per teacher and can add, change and clear a slide', async t => {
  const f = await fixture(t);
  const item = await f.upload();
  assert.deepEqual(await f.store.saveNote(item, 'alice', 2, '第 2 页新增备注\r\n第二行  '), { slide: 2, text: '第 2 页新增备注\n第二行' });
  assert.deepEqual((await f.store.notes(item, 'alice')).map(note => note.slide), [1, 2, 3]);
  // Bob sees only the PPTX's own notes, not Alice's script.
  assert.deepEqual((await f.store.notes(item, 'bob')).map(note => note.slide), [1, 3]);
  // Clearing masks the original note instead of restoring it.
  await f.store.saveNote(item, 'alice', 1, '   ');
  assert.deepEqual((await f.store.notes(item, 'alice')).map(note => note.slide), [2, 3]);
  assert.deepEqual((await f.store.notes(item, 'bob')).map(note => note.slide), [1, 3]);
  assert.equal((await f.store.notes(item, 'alice'))[0].text, '第 2 页新增备注\n第二行');
});

test('invalid slide numbers and oversized notes are rejected', async t => {
  const f = await fixture(t);
  const item = await f.upload();
  await assert.rejects(f.store.saveNote(item, 'alice', 0, 'x'), { status: 400 });
  await assert.rejects(f.store.saveNote(item, 'alice', 1.5, 'x'), { status: 400 });
  await assert.rejects(f.store.saveNote(item, 'alice', 1, 'x'.repeat(20001)), { status: 400 });
  await assert.rejects(f.store.saveNote(item, 'alice', 1, 42), { status: 400 });
  await assert.rejects(f.store.saveNote(item, '../escape', 1, 'x'), { status: 400 });
});

test('legacy courseware without a bundle extracts notes on first request', async t => {
  const f = await fixture(t);
  // Simulate a record published before notes and object bundles existed.
  const id = 'legacy-lesson';
  await fs.writeFile(path.join(f.root, `${id}.pptx`), notesPptx());
  await fs.writeFile(path.join(f.root, `${id}.pdf`), 'PDF');
  const item = { id, userId: 'alice', title: '旧课件', fileName: 'lesson.pptx',
    url: `/myclass/public/courseware/${id}.pdf`, originalUrl: `/myclass/public/courseware/${id}.pptx` };
  assert.deepEqual((await f.store.notes(item, 'alice')).map(note => note.slide), [1, 3]);
  assert.equal((await fs.readFile(path.join(f.root, '.notes', `${id}.base.json`), 'utf8')).length > 0, true);
  await f.store.saveNote(item, 'alice', 1, '旧课件改过');
  assert.equal((await f.store.notes(item, 'alice'))[0].text, '旧课件改过');
});

test('PDF courseware has no notes and deletion removes stored edits', async t => {
  const f = await fixture(t);
  const pdfInput = path.join(path.dirname(f.input), 'plain.pdf');
  await fs.writeFile(pdfInput, '%PDF-1.4');
  const pdf = await f.store.publish({ path: pdfInput }, 'plain.pdf', 'alice');
  assert.equal(await f.store.notesSupported(pdf), false);
  assert.deepEqual(await f.store.notes(pdf, 'alice'), []);

  const item = await f.upload();
  await f.store.saveNote(item, 'alice', 2, '备注');
  const directory = path.join(f.root, '.notes', item.id);
  assert.equal((await fs.readdir(directory)).length, 1);
  assert.equal(await f.store.remove(item.id, 'alice'), true);
  await assert.rejects(fs.access(directory), { code: 'ENOENT' });
});
