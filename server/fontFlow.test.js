const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createCoursewareStore } = require('./coursewareStore');
const { extractDocumentFonts } = require('./documentFonts');
const { createFontRegeneration } = require('./fontRegeneration');
const { normalizeFontFamily } = require('./fontNames');
const { zip } = require('./testFixtures/pptxVideoFixture');

function pptx(fonts) {
  return zip({
    'ppt/theme/theme1.xml': '<a:theme xmlns:a="x"><a:fontScheme><a:minorFont>' +
      fonts.map(font => `<a:latin typeface="${font}"/>`).join('') +
      '</a:minorFont></a:fontScheme></a:theme>',
    'ppt/slides/slide1.xml': '<p:sld xmlns:a="x"/>'
  });
}

test('upload, missing-font prompt and automatic regeneration work together', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'myclass-font-flow-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'courseware');
  const input = path.join(directory, 'lesson.pptx');
  await fs.writeFile(input, pptx(['Installed Sans', 'Missing Display']));
  const known = new Set([normalizeFontFamily('Installed Sans')]);
  let profile = '';
  let conversions = 0;
  const store = createCoursewareStore({
    root, prefix: '/myclass',
    officeProfile: () => profile,
    convertOfficeToPdf: async (source, ext, output) => {
      conversions++;
      await fs.writeFile(output, `pdf:${profile || 'base'}`);
    },
    detectMissingFonts: async (file, ext) => {
      const { fonts } = await extractDocumentFonts(file, ext);
      return fonts.filter(name => !known.has(normalizeFontFamily(name)));
    }
  });
  const service = createFontRegeneration({
    fontStore: { knownFamilies: async () => known }, coursewareStore: store, limit: 10, scanLimit: 10
  });

  const published = await store.publish({ path: input }, 'lesson.pptx', 'alice');
  assert.deepEqual(published.missingFonts, ['Missing Display']);
  const prompt = await service.state({ id: 'alice', role: 'user' });
  assert.equal(prompt.pendingRegeneration, 0, 'nothing can be regenerated before the font is installed');
  assert.deepEqual(prompt.missingFonts.map(font => font.family), ['Missing Display']);
  assert.equal(prompt.missingFonts[0].coursewareCount, 1);
  assert.deepEqual(prompt.missingFonts[0].titles, ['lesson']);

  // Installing the font bumps the conversion profile, exactly like server.js.
  known.add(normalizeFontFamily('Missing Display'));
  profile = 'office-fabc123';
  const regenerated = await service.regenerate();
  assert.equal(regenerated.supported, true);
  assert.deepEqual(regenerated.regenerated.map(item => item.id), [published.id]);
  assert.equal(regenerated.remaining, 0);
  assert.equal(conversions, 2);

  const after = await service.state({ id: 'alice', role: 'user' });
  assert.deepEqual(after.missingFonts, []);
  assert.equal(after.missingCourseware, 0);
  assert.equal(after.pendingRegeneration, 0);
  const [stored] = await store.list('alice');
  assert.equal(stored.url, published.url);
  assert.equal(stored.id, published.id);
  assert.deepEqual(stored.missingFonts, []);
  assert.equal(await fs.readFile(path.join(root, `${published.id}.pdf`), 'utf8'), 'pdf:office-fabc123');
});
