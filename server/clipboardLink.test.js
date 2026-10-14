const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./testSupport');

test('clipboard lookup is authenticated, owner scoped, uncapped and normalizes URL spelling', async t => {
  const server = await startTestServer({ env: { COURSEWARE_LIST_LIMIT: '1' } });
  t.after(server.close);
  const url = 'https://example.com/lesson?a=1&b=2#part';
  const lookup = '/courseware/link/exists?url=' + encodeURIComponent(url);
  assert.equal((await fetch(`${server.base}/api${lookup}`)).status, 401);
  assert.deepEqual(await (await server.api(lookup)).json(), { exists: false });
  const saved = await (await server.api('/courseware/link', 'alice', 'POST', { title: '第一课', url })).json();
  await server.api('/courseware/link', 'alice', 'POST', { title: '第二课', url: 'https://example.com/other' });
  const response = await server.api(lookup);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { exists: true });
  assert.deepEqual(await (await server.api(lookup, 'bob')).json(), { exists: false });
  assert.equal((await server.api('/courseware/link/exists?url=javascript:alert(1)')).status, 400);
  const results = await Promise.all(Array.from({ length: 3 }, () => server.api('/courseware/link', 'alice', 'POST', {
    title: '不应覆盖原名称', url: 'https://EXAMPLE.com:443/lesson?a=1&b=2#part'
  }).then(r => r.json())));
  results.forEach(item => { assert.equal(item.id, saved.id); assert.equal(item.title, '第一课'); });
  const other = await (await server.api('/courseware/link', 'bob', 'POST', { title: '自己的名称', url })).json();
  assert.notEqual(other.id, saved.id);
  assert.equal((await server.api(`/courseware/${saved.id}`, 'alice', 'DELETE')).status, 200);
  assert.deepEqual(await (await server.api(lookup)).json(), { exists: false });
  assert.deepEqual(await (await server.api(lookup, 'bob')).json(), { exists: true });
});
