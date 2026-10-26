const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { extractDocumentFonts } = require('./documentFonts');
const { zip } = require('./testFixtures/pptxVideoFixture');

async function writeFixture(t, name, files) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'myclass-doc-fonts-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, name);
  await fs.writeFile(filename, Buffer.isBuffer(files) ? files : zip(files));
  return filename;
}

test('PPTX theme and run fonts are extracted while theme references are ignored', async t => {
  const file = await writeFixture(t, 'lesson.pptx', {
    'ppt/theme/theme1.xml': '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:fontScheme><a:majorFont>' +
      '<a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:font script="Hans" typeface="等线"/>' +
      '</a:majorFont><a:minorFont><a:latin typeface="Calibri"/></a:minorFont></a:fontScheme></a:theme>',
    'ppt/slides/slide1.xml': '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:rPr lang="zh-CN">' +
      '<a:latin typeface="微软雅黑"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:rPr></p:sld>',
    'ppt/media/image1.png': Buffer.from([0x89, 0x50, 0x4e, 0x47])
  });
  const result = await extractDocumentFonts(file, '.pptx');
  assert.equal(result.supported, true);
  assert.deepEqual([...result.fonts].sort(), ['Calibri', 'Calibri Light', '微软雅黑', '等线'].sort());
  assert.deepEqual(await extractDocumentFonts(path.join(path.dirname(file), 'missing.pdf'), '.pdf'), { supported: false, fonts: [] });
});

test('DOCX run fonts, embedded font table and theme fonts are extracted once', async t => {
  const file = await writeFixture(t, 'lesson.docx', {
    'word/fontTable.xml': '<w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:font w:name="Times New Roman"/><w:font w:name="A&amp;B 字体"/></w:fonts>',
    'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:r><w:rPr>' +
      '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="宋体" w:cs="Arial"/></w:rPr></w:r></w:document>',
    'word/theme/theme1.xml': '<a:latin xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" typeface="Cambria"/>',
    'word/styles.xml': '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>'
  });
  const result = await extractDocumentFonts(file, '.docx');
  assert.equal(result.supported, true);
  assert.deepEqual([...result.fonts].sort(), ['A&B 字体', 'Arial', 'Cambria', 'Times New Roman', '宋体'].sort());
});

test('legacy Office binaries are reported as unsupported and damaged packages reject', async t => {
  assert.deepEqual(await extractDocumentFonts('unused.ppt', '.ppt'), { supported: false, fonts: [] });
  assert.deepEqual(await extractDocumentFonts('unused.doc', '.doc'), { supported: false, fonts: [] });
  const damaged = await writeFixture(t, 'damaged.pptx', Buffer.from('not a zip archive'));
  await assert.rejects(extractDocumentFonts(damaged, '.pptx'));
});
