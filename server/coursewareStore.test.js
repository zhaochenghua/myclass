const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createCoursewareStore } = require('./coursewareStore');

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'myclass-storage-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'courseware');
  const input = path.join(directory, 'upload');
  await fs.writeFile(input, 'same original bytes');
  const store = createCoursewareStore({ root, prefix: '/myclass',
    convertOfficeToPdf: async (source, ext, output) => fs.writeFile(output, 'converted PDF'), ...options });
  return { root, input, store, upload: (name, user = 'alice') => store.publish({ path: input }, name, user),
    local: item => path.join(root, path.basename(item.url)),
    bundle: item => path.join(root, '.objects', item.storageKey.slice(0, 2), item.storageKey) };
}

test('simultaneous uploads reuse Office bytes and conversion, with independent owners, names and URLs', async t => {
  let conversions = 0;
  const f = await fixture(t, { convertOfficeToPdf: async (source, ext, output) => {
    conversions++;
    await fs.writeFile(output, 'converted PDF');
  } });
  const [a, b] = await Promise.all([f.upload('语文.pptx'), f.upload('数学.pptx', 'bob')]);
  assert.equal(conversions, 1);
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.url, b.url);
  assert.equal(a.storageKey, b.storageKey);
  const [aStat, bStat] = await Promise.all([fs.stat(f.local(a)), fs.stat(f.local(b))]);
  assert.equal(aStat.ino, bStat.ino);
  assert(aStat.nlink >= 3);
  assert.deepEqual((await f.store.list('alice')).map(i => i.id), [a.id]);
  assert.deepEqual((await f.store.list('bob')).map(i => i.id), [b.id]);
  assert.equal(await f.store.rename(a.id, '新标题', 'bob'), false);
  assert.equal(await f.store.rename(a.id, '新标题', 'alice'), true);
  assert.equal((await f.store.list('bob'))[0].title, '数学');
  assert.equal(await f.store.remove(a.id, 'bob'), false);
  assert.equal(await f.store.remove(a.id, 'alice'), true);
  await assert.rejects(fs.access(f.local(a)), { code: 'ENOENT' });
  await fs.access(f.bundle(b));
  assert.equal(await fs.readFile(f.local(b), 'utf8'), 'converted PDF');
  assert.equal(await f.store.remove(b.id, 'bob'), true);
  await assert.rejects(fs.access(f.bundle(b)), { code: 'ENOENT' });
});

test('concurrent index writes retain more than 100 records and do not lose rename/delete updates', async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 120 }, (_, i) => f.store.remember({ id: `link-${i}`,
    title: `${i}`, userId: 'alice', linkUrl: 'https://example.org', url: 'https://example.org' })));
  assert.equal((await f.store.readIndex()).length, 120);
  assert.equal((await f.store.list('alice')).length, 120);
  await Promise.all([f.store.rename('link-0', 'updated', 'alice'), f.store.remove('link-1', 'alice'),
    f.store.remember({ id: 'new', title: 'new', userId: 'bob', linkUrl: 'https://example.org', url: 'https://example.org' })]);
  const index = await f.store.readIndex();
  assert.equal(index.length, 120);
  assert.equal(index.find(i => i.id === 'link-0').title, 'updated');
  assert(!index.some(i => i.id === 'link-1'));
});

test('all supported media preserve exact bytes and deletion reclaims aliases and final object', async t => {
  const f = await fixture(t);
  for (const ext of ['pdf', 'zip', 'mp4', 'mov', 'avi', 'webm', 'mkv', '3gp', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp']) {
    const item = await f.upload(`课件.${ext}`);
    assert.equal(await fs.readFile(f.local(item), 'utf8'), 'same original bytes');
    assert.equal(await f.store.remove(item.id, 'alice'), true);
    await assert.rejects(fs.access(f.local(item)), { code: 'ENOENT' });
    await assert.rejects(fs.access(f.bundle(item)), { code: 'ENOENT' });
  }
  assert.equal((await f.store.readIndex()).length, 0);
});

test('different contents with the same filename never share storage', async t => {
  const f = await fixture(t);
  const first = await f.upload('same.pdf');
  await fs.writeFile(f.input, 'changed');
  const second = await f.upload('same.pdf');
  assert.notEqual(first.storageKey, second.storageKey);
  assert.equal(await fs.readFile(f.local(first), 'utf8'), 'same original bytes');
  assert.equal(await fs.readFile(f.local(second), 'utf8'), 'changed');
});

test('conversion failure leaves no published originals, partial PDFs or staging files and queue recovers', async t => {
  const f = await fixture(t, { convertOfficeToPdf: async (source, ext, output) => {
    await fs.writeFile(output, 'incomplete');
    throw new Error('conversion failed');
  } });
  await assert.rejects(f.upload('bad.pptx'), /conversion failed/);
  assert.deepEqual(await fs.readdir(path.join(f.root, '.objects')), []);
  assert.deepEqual(await f.store.readIndex(), []);
  assert(!(await fs.readdir(f.root)).some(name => name.endsWith('.pptx') || name.endsWith('.pdf')));
  await f.upload('good.pdf');
  assert.equal((await f.store.list('alice')).length, 1);
});

test('an atomic index replacement failure keeps old records and rolls back new files', async t => {
  const f = await fixture(t);
  const first = await f.upload('good.pdf');
  const indexPath = path.join(f.root, 'index.json');
  const before = await fs.readFile(indexPath, 'utf8');
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === indexPath) throw Object.assign(new Error('disk error'), { code: 'EIO' });
    return rename(from, to);
  });
  await assert.rejects(f.upload('new.mp4'), /disk error/);
  await assert.rejects(f.store.remove(first.id, 'alice'), /disk error/);
  assert.equal(await fs.readFile(indexPath, 'utf8'), before);
  assert.equal(await fs.readFile(f.local(first), 'utf8'), 'same original bytes');
  assert(!(await fs.readdir(f.root)).some(name => name.endsWith('.mp4') || name.endsWith('.tmp')));
});

test('corrupt or empty indexes are never silently discarded during upload', async t => {
  const f = await fixture(t);
  for (const invalid of ['', '{broken', '{}', '[null]']) {
    await fs.writeFile(path.join(f.root, 'index.json'), invalid);
    await assert.rejects(f.upload('new.pdf'));
    assert.equal(await fs.readFile(path.join(f.root, 'index.json'), 'utf8'), invalid);
    assert.deepEqual(await fs.readdir(path.join(f.root, '.objects')), []);
  }
});

test('old indexed files keep their URLs, permissions and complete removal without storage keys', async t => {
  const f = await fixture(t);
  for (const ext of ['pdf', 'pptx', 'mp4', 'png']) await fs.writeFile(path.join(f.root, `old.${ext}`), 'old');
  await fs.writeFile(path.join(f.root, 'index.json'), JSON.stringify([{ id: 'old', userId: 'alice',
    title: 'old course', url: '/myclass/public/courseware/old.pdf', originalUrl: '/myclass/public/courseware/old.pptx' }]));
  assert.equal((await f.store.list('alice'))[0].url, '/myclass/public/courseware/old.pdf');
  assert.equal((await f.store.list('bob')).length, 0);
  await f.store.remove('old', null);
  assert.deepEqual(await fs.readdir(f.root), ['.objects', 'index.json']);
});

test('unindexed PDFs are not silently exposed to everyone when an index exists', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'orphan.pdf'), 'private');
  await fs.writeFile(path.join(f.root, 'index.json'), '[]');
  assert.deepEqual(await f.store.list('bob'), []);
  assert.equal(await f.store.remove('orphan', 'bob'), false);
  assert.equal(await fs.readFile(path.join(f.root, 'orphan.pdf'), 'utf8'), 'private');
});

test('legacy installations without an index retain their original PDFs on first upload', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'legacy.pdf'), 'old');
  await f.upload('new.pdf');
  assert.equal((await f.store.readIndex()).length, 2);
  assert.equal((await f.store.list('bob'))[0].id, 'legacy');
});

test('unsupported formats and path traversal cannot create or delete files', async t => {
  const f = await fixture(t);
  await assert.rejects(f.upload('bad.exe'), { status: 400 });
  assert.throws(() => f.store.remove('../upload', null), { status: 400 });
  assert.equal(await fs.readFile(f.input, 'utf8'), 'same original bytes');
});

test('animation profiles do not reuse static previews; cached metadata and reference deletion stay independent', async t => {
  let profile = '';
  let conversions = 0;
  const f = await fixture(t, { officeProfile: () => profile,
    convertOfficeToPdf: async (source, ext, output) => {
      conversions++;
      await fs.writeFile(output, profile || 'static');
      return profile ? { mode: 'animation-states', stateCount: 3, slideCount: 1, profile } : undefined;
    } });
  const old = await f.upload('same.pptx');
  profile = 'expand-animations-v1';
  const expanded = await f.upload('same.pptx');
  const duplicate = await f.upload('same.pptx', 'bob');
  assert.equal(conversions, 2);
  assert.notEqual(old.storageKey, expanded.storageKey);
  assert.equal(duplicate.storageKey, expanded.storageKey);
  assert.deepEqual(duplicate.conversion, expanded.conversion);
  assert.equal(duplicate.conversion.stateCount, 3);
  assert.equal(await fs.readFile(f.local(old), 'utf8'), 'static');
  await f.store.remove(expanded.id, 'alice');
  await fs.access(f.bundle(duplicate));
  await f.store.remove(duplicate.id, 'bob');
  await assert.rejects(fs.access(f.bundle(duplicate)), { code: 'ENOENT' });
  assert.equal(await fs.readFile(f.local(old), 'utf8'), 'static');
  profile = '';
  assert.equal((await f.upload('same.pptx')).storageKey, old.storageKey);
  assert.equal(conversions, 2);
});
