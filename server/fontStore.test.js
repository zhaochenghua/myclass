const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createFontStore } = require('./fontStore');
const { createCoursewareStore } = require('./coursewareStore');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'myclass-font-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'fonts');
  const file = path.join(directory, 'upload');
  await fs.writeFile(file, Buffer.concat([Buffer.from('00010000', 'hex'), Buffer.alloc(20)]));
  return { directory, root, file };
}

test('font installs validate content, serialize duplicates and preserve revision across restart', async t => {
  const { root, file } = await fixture(t);
  let scans = 0;
  let caches = 0;
  const runner = async (command, args) => {
    if (command === 'fc-scan') { scans++; return '<font><family>Demo &amp; Font,示例字体</family><style>Bold</style></font>'; }
    assert.equal(command, 'fc-cache');
    assert.deepEqual(args, ['-f', root]);
    caches++;
    return '';
  };
  const store = createFontStore({ root, supported: true, runner });
  assert.equal(store.revision(), '');
  const results = await Promise.all([store.install(file, '../name.ttf'), store.install(file, 'same.otf')]);
  assert.deepEqual(results.map(result => result.duplicate), [false, true]);
  assert.equal(results[0].faces[0].family, 'Demo & Font,示例字体');
  assert.equal(scans, 2);
  assert.equal(caches, 2);
  assert.match(store.revision(), /^[a-f0-9]{12}$/);
  assert.equal((await fs.readdir(root)).length, 1);
  const restarted = createFontStore({ root, supported: true, runner });
  await restarted.initialize();
  assert.equal(restarted.revision(), store.revision());
  await assert.rejects(store.install(file, 'fake.exe'), { status: 400 });
  await fs.writeFile(file, 'not a font');
  await assert.rejects(store.install(file, 'fake.ttf'), { status: 400 });
  assert.equal(scans, 2);
});

test('damaged fonts and cache failure never publish an installed font or change revision', async t => {
  const { root, file } = await fixture(t);
  let failScan = true;
  const store = createFontStore({ root, supported: true, runner: async command => {
    if (command === 'fc-scan') {
      if (failScan) throw new Error('damaged');
      return '<font><family>Demo</family><style>Regular</style></font>';
    }
    throw new Error('cache failed');
  } });
  await assert.rejects(store.install(file, 'broken.ttf'), { status: 400 });
  assert.deepEqual(await fs.readdir(root), []);
  failScan = false;
  await assert.rejects(store.install(file, 'valid.ttf'), /cache failed/);
  assert.deepEqual(await fs.readdir(root), []);
  assert.equal(store.revision(), '');
});

test('font listing groups collection styles, identifies uploads and never exposes filesystem paths', async t => {
  const { root } = await fixture(t);
  const store = createFontStore({ root, supported: true, runner: async () =>
    `<font><file>${root}/a.ttf</file><family>Demo</family><style>Regular</style></font>` +
    `<font><file>${root}/b.ttf</file><family>Demo</family><style>Bold</style></font>` +
    '<font><file>/system/fonts/serif.ttc</file><family>Serif</family><style>Regular</style></font>' });
  const { items } = await store.list();
  assert.equal(items.length, 2);
  assert.deepEqual(items.find(item => item.source === 'uploaded').styles, ['Bold', 'Regular']);
  assert.equal(JSON.stringify(items).includes(root), false);
  const unsupported = createFontStore({ root, supported: false });
  assert.equal((await unsupported.list()).supported, false);
  await assert.rejects(unsupported.install('unused', 'demo.ttf'), { status: 503 });
});

test('uploading a font invalidates Office deduplication for later courseware uploads', async t => {
  const { directory, root, file } = await fixture(t);
  const fonts = createFontStore({ root, supported: true, runner: async command => command === 'fc-scan'
    ? '<font><family>Demo</family><style>Regular</style></font>' : '' });
  let conversions = 0;
  const store = createCoursewareStore({ root: path.join(directory, 'courseware'), prefix: '/myclass',
    officeProfile: () => `expand-animations-v2${fonts.revision() ? `-f${fonts.revision()}` : ''}`,
    convertOfficeToPdf: async (_input, _ext, output) => { conversions++; await fs.writeFile(output, '%PDF-1.4\n'); } });
  const ppt = path.join(directory, 'test.ppt');
  await fs.writeFile(ppt, 'same courseware');
  const first = await store.publish({ path: ppt }, 'test.ppt', 'alice');
  await store.publish({ path: ppt }, 'test.ppt', 'alice');
  assert.equal(conversions, 1);
  await fonts.install(file, 'font.ttf');
  const second = await store.publish({ path: ppt }, 'test.ppt', 'alice');
  assert.equal(conversions, 2);
  assert.notEqual(first.storageKey, second.storageKey);
});
