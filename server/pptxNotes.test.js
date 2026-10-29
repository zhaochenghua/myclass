const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { extractPptxNotes, MAX_NOTE_CHARS } = require('./pptxNotes');
const { notesPptx, files, zip } = require('./testFixtures/pptxNotesFixture');

async function temp(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'myclass-pptx-notes-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('speaker notes follow deck order and skip slide number / footer placeholders', async t => {
  const root = await temp(t), file = path.join(root, 'lesson.pptx');
  await fs.writeFile(file, notesPptx());
  assert.deepEqual(await extractPptxNotes(file), [
    { slide: 1, text: '第一段备注\n第二段备注\n补充说明' },
    { slide: 3, text: '结尾备注' }
  ]);
});

test('a deck without notes relationships yields an empty list', async t => {
  const root = await temp(t), file = path.join(root, 'plain.pptx');
  const plain = files();
  for (const name of Object.keys(plain)) if (name.includes('notesSlide')) delete plain[name];
  for (const name of Object.keys(plain)) {
    if (!name.startsWith('ppt/slides/_rels/')) continue;
    plain[name] = plain[name].replace(/<Relationship [^>]*notesSlide[^>]*\/>/u, '');
  }
  await fs.writeFile(file, zip(plain));
  assert.deepEqual(await extractPptxNotes(file), []);
});

test('a note longer than the cap is truncated instead of rejected', async t => {
  const root = await temp(t), file = path.join(root, 'long.pptx');
  const long = files();
  long['ppt/notesSlides/notesSlide1.xml'] = long['ppt/notesSlides/notesSlide1.xml']
    .replace('第一段备注', 'x'.repeat(MAX_NOTE_CHARS + 500));
  await fs.writeFile(file, zip(long));
  const notes = await extractPptxNotes(file);
  assert.equal(notes[0].text.length, MAX_NOTE_CHARS);
});

test('doctype / entity declarations are rejected', async t => {
  const root = await temp(t), file = path.join(root, 'attack.pptx');
  const attack = files();
  attack['ppt/notesSlides/notesSlide1.xml'] =
    '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///c:/windows/win.ini">]>' +
    '<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    '<p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>&xxe;</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>';
  await fs.writeFile(file, zip(attack));
  await assert.rejects(extractPptxNotes(file), /无效的 PPTX XML/u);
});

test('a damaged package is reported to the caller', async t => {
  const root = await temp(t), file = path.join(root, 'damaged.pptx');
  await fs.writeFile(file, 'not a zip archive');
  await assert.rejects(extractPptxNotes(file));
});
