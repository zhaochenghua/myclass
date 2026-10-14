const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { zip, fixtureFiles } = require('./testFixtures/pptxVideoFixture');
const { extractPptxVideos } = require('./pptxVideos');
const { createCoursewareStore } = require('./coursewareStore');
const { startTestServer } = require('./testSupport');
async function temp(t) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'myclass-pptx-video-')); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; }
test('PPTX video follows presentation order and deduplicates Office dual relationships', async t => {
  const root = await temp(t), input = path.join(root, 'lesson.pptx'), output = path.join(root, 'output');
  await fs.writeFile(input, zip(fixtureFiles()));
  const videos = await extractPptxVideos(input, output);
  assert.equal(videos.length, 1); assert.equal(videos[0].slide, 1);
  assert.equal(await fs.readFile(path.join(output, videos[0].file), 'utf8'), 'video bytes');
});
test('external/local-path videos are not fetched; traversal and malformed XML are rejected', async t => {
  const root = await temp(t), input = path.join(root, 'lesson.pptx');
  const files = fixtureFiles(); files['ppt/slides/_rels/slide2.xml.rels'] = '<Relationships><Relationship Id="vid" Target="https://example.com/a.mp4" TargetMode="External" Type="video"/></Relationships>';
  await fs.writeFile(input, zip(files)); assert.deepEqual(await extractPptxVideos(input, path.join(root, 'external')), []);
  files['ppt/presentation.xml'] = '<!DOCTYPE foo [<!ENTITY x "bad">]><p:presentation/>';
  await fs.writeFile(input, zip(files)); await assert.rejects(extractPptxVideos(input, path.join(root, 'bad')), /XML/);
  await fs.writeFile(input, zip({ '../escape.mp4': 'bad' })); await assert.rejects(extractPptxVideos(input, path.join(root, 'escape')));
});
test('new uploads extract videos, sharing storage but not file IDs; deletion removes final bundle', async t => {
  const root = await temp(t), input = path.join(root, 'input'); await fs.writeFile(input, zip(fixtureFiles()));
  const store = createCoursewareStore({ root, prefix: '/myclass', convertOfficeToPdf: async (input, ext, output) => fs.writeFile(output, 'PDF') });
  const a = await store.publish({ path: input }, 'lesson.pptx', 'alice');
  const b = await store.publish({ path: input }, 'copy.pptx', 'bob');
  const first = await store.embeddedVideos(a), second = await store.embeddedVideos(b);
  assert.equal(first.directory, second.directory); assert.notEqual(first.videos[0].url, second.videos[0].url);
  await store.remove(a.id, 'alice'); await fs.access(first.directory);
  await store.remove(b.id, 'bob'); await assert.rejects(fs.access(first.directory), { code: 'ENOENT' });
});
test('existing PPTX lazily extracts through metadata; video supports ranges and disappears on deletion', async t => {
  const server = await startTestServer(); t.after(server.close);
  const root = path.join(server.directory, 'courseware');
  await fs.writeFile(path.join(root, 'old.pptx'), zip(fixtureFiles()));
  await fs.writeFile(path.join(root, 'old.pdf'), 'PDF');
  await fs.writeFile(path.join(root, 'index.json'), JSON.stringify([{ id: 'old', userId: 'alice', url: '/myclass/public/courseware/old.pdf', originalUrl: '/myclass/public/courseware/old.pptx' }]));
  const meta = await (await fetch(server.base + '/public/courseware/old.pdf.metadata?embedded=1')).json();
  assert.equal(meta.videos[0].slide, 1); assert.equal(meta.videos[0].file, undefined);
  const url = new URL(meta.videos[0].url, server.base);
  const partial = await fetch(url, { headers: { Range: 'bytes=0-4' } }); assert.equal(partial.status, 206); assert.equal(await partial.text(), 'video');
  assert.equal((await fetch(server.base + '/public/courseware/old.video/999')).status, 404);
  await server.api('/courseware/old', 'alice', 'DELETE'); assert.equal((await fetch(url)).status, 404);
});
