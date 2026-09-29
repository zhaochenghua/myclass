const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { startTestServer } = require('./testSupport');

test('animation states keep original page labels and jump to the first state; hidden slides never alias another slide', async () => {
  const { pageMapping, slidePage, slideCount, firstState } = await import('../web/ios/js/coursewarePages.mjs');
  const conversion = { slideCount: 4, statePages: [1, 2, 2, 2, 4, 4] };
  const cw = { page: 2, pageCount: 6, mapping: pageMapping(conversion, 6) };
  for (const physical of [2, 3, 4]) { cw.page = physical; assert.equal(slidePage(cw), 2); }
  assert.equal(slideCount(cw), 4);
  assert.equal(firstState(cw, 2), 2);
  assert.equal(firstState(cw, 4), 5);
  assert.equal(firstState(cw, 3), 0);
  assert.equal(pageMapping(conversion, 5), null);
  assert.equal(pageMapping({ slideCount: 2, statePages: [2, 1] }, 2), null);
  assert.equal(pageMapping({ slideCount: 2, statePages: [1, 3] }, 2), null);
  const pdf = { page: 3, pageCount: 8 };
  assert.equal(slidePage(pdf), 3);
  assert.equal(slideCount(pdf), 8);
  assert.equal(firstState(pdf, 6), 6);
});

test('public PDF metadata exposes only conversion, not owners or other courseware', async t => {
  const server = await startTestServer();
  t.after(server.close);
  const conversion = { slideCount: 2, statePages: [1, 2, 2] };
  await fs.writeFile(path.join(server.directory, 'courseware', 'index.json'), JSON.stringify([
    { id: 'mapped', url: '/myclass/public/courseware/mapped.pdf', userId: 'secret-owner', conversion },
    { id: 'plain', url: '/myclass/public/courseware/plain.pdf', userId: 'another-owner' }
  ]));
  const get = name => fetch(`${server.base}/public/courseware/${name}.metadata`);
  assert.deepEqual(await (await get('mapped.pdf')).json(), { conversion });
  assert.deepEqual(await (await get('plain.pdf')).json(), { conversion: null });
  assert.equal((await get('missing.pdf')).status, 404);
  assert.equal((await get('index.json')).status, 404);
});
