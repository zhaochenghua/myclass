const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const media = import(pathToFileURL(path.join(__dirname, '../web/ios/js/mediaFiles.mjs')));
const previews = import(pathToFileURL(path.join(__dirname, '../web/ios/js/listPreviews.mjs')));

test('iOS photo classification accepts MIME, HEIC, uppercase extensions and unnamed photos', async () => {
  const { mediaKind, jpegName } = await media;
  assert.equal(mediaKind('IMG_0001.HEIC'), 'image');
  assert.equal(mediaKind('photo', 'image/jpeg'), 'image');
  assert.equal(mediaKind('', 'image/heif'), 'image');
  assert.equal(mediaKind('IMG_001.MOV'), 'video');
  assert.equal(mediaKind('/file.JPG?v=1'), 'image');
  assert.equal(mediaKind('/lesson.pdf'), 'other');
  for (const name of ['照片.HEIC', '照片.png', '照片', '照片.jpeg']) assert.equal(jpegName(name), '照片.jpg');
});

test('foreground and background share one upload and reuse the result', async () => {
  const { ensureMediaUploaded } = await media;
  let complete;
  let calls = 0;
  const client = { upload(file, progress, signal, id) {
    calls++; assert.ok(id.startsWith('ios-'));
    return new Promise(resolve => { complete = resolve; });
  } };
  const item = { kind: 'video', file: new File(['sample'], 'sample.mov'), name: 'sample' };
  const first = ensureMediaUploaded(item, client);
  const second = ensureMediaUploaded(item, client);
  assert.equal(first, second);
  assert.equal(calls, 1);
  complete({ id: 'published', url: '/myclass/public/courseware/sample.mov' });
  await Promise.all([first, second]);
  assert.equal(item.status, 'ready');
  assert.equal(item.controller, null);
  await ensureMediaUploaded(item, client);
  assert.equal(calls, 1);
});

test('failed uploads are retryable with the same idempotency key', async () => {
  const { ensureMediaUploaded } = await media;
  const ids = [];
  const client = { async upload(file, progress, signal, id) {
    ids.push(id); if (ids.length === 1) throw new Error('network unavailable');
    return { id: 'same', url: '/same.mp4' };
  } };
  const item = { kind: 'video', file: new File(['a'], 'a.mp4') };
  await assert.rejects(ensureMediaUploaded(item, client));
  assert.equal(item.status, 'failed');
  assert.equal(item.uploadTask, null);
  await ensureMediaUploaded(item, client);
  assert.equal(ids[0], ids[1]);
});

test('cancelling before image conversion prevents decoding and upload', async () => {
  const { prepareImageFile } = await media;
  const controller = new AbortController(); controller.abort();
  await assert.rejects(prepareImageFile(new File(['a'], 'a.jpg'), { signal: controller.signal }), /__ABORTED__/);
});

test('saved PDF progress uses physical preview pages and mapped slide labels', async () => {
  const { playbackProgress } = await previews;
  assert.equal(playbackProgress({}), null);
  assert.equal(playbackProgress({ playbackProgress: { page: 0, pageCount: 3 } }), null);
  assert.deepEqual(playbackProgress({ playbackProgress: { page: 2, pageCount: 4 } }), { physicalPage: 2, page: 2, pageCount: 4, ratio: 0.5 });
  assert.deepEqual(playbackProgress({ playbackProgress: { page: 20, pageCount: 4 } }), { physicalPage: 4, page: 4, pageCount: 4, ratio: 1 });
  assert.deepEqual(playbackProgress({ playbackProgress: { page: 3, pageCount: 4 }, conversion: { statePages: [1, 1, 2, 3], slideCount: 3 } }),
    { physicalPage: 3, page: 2, pageCount: 3, ratio: 0.75 });
});

test('an already-cancelled upload never sends a multipart request', async () => {
  const { CoursewareClient } = await import(pathToFileURL(path.join(__dirname, '../web/ios/js/courseware.js')));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(new CoursewareClient({ apiBase: '/api', token: 'test' }).upload(
    new File(['a'], 'a.jpg'), null, controller.signal), /__ABORTED__/);
});
