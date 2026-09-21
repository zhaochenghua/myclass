const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

// Run the actual server with an isolated code/data tree, never local users or
// classroom files. NODE_PATH reuses installed dependencies without reinstalling.
test('HTTP upload/list/download/range/delete work on a separate storage root', { timeout: 20000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'myclass-http-storage-test-'));
  const serverRoot = path.join(directory, 'server');
  const storageRoot = path.join(directory, 'separate-storage');
  await fs.mkdir(path.join(serverRoot, 'data'), { recursive: true });
  for (const name of ['server.js', 'coursewareStore.js', 'expandAnimations.js', 'classStore.js', 'userStore.js', 'websocket.js', 'roomManager.js', 'presentationState.js']) {
    await fs.copyFile(path.join(__dirname, name), path.join(serverRoot, name));
  }
  await fs.writeFile(path.join(serverRoot, 'data', 'users.json'), JSON.stringify([
    { id: 'alice', username: 'alice', token: 'alice-test-token', role: 'user', lastLoginAt: new Date().toISOString() },
    { id: 'bob', username: 'bob', token: 'bob-test-token', role: 'user', lastLoginAt: new Date().toISOString() }
  ]));
  // A stale public index must remain inaccessible even with an external root.
  const oldPublic = path.join(directory, 'web', 'public', 'courseware');
  await fs.mkdir(oldPublic, { recursive: true });
  await fs.writeFile(path.join(oldPublic, 'index.json'), 'private metadata');
  const child = spawn(process.execPath, [path.join(serverRoot, 'server.js')], {
    cwd: directory, windowsHide: true,
    env: { ...process.env, NODE_PATH: path.join(__dirname, 'node_modules'),
      HOST: '127.0.0.1', PORT: '0', HTTPS_PORT: '0', PATH_PREFIX: '/myclass',
      ALLOWED_HOSTS: '127.0.0.1,localhost', AUTH_SECRET: 'isolated-test-secret',
      COURSEWARE_ROOT: storageRoot, COURSEWARE_MAX_BYTES: '1024', COURSEWARE_LIST_LIMIT: '0' }
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill();
      await closed;
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  let output = '';
  child.stderr.on('data', data => { output += data; });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Server exited: ${output}`)); });
    child.stdout.on('data', data => {
      output += data;
      const match = output.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)\/myclass\//);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  const api = (route, user = 'alice', options = {}) => fetch(`${base}/myclass/api/courseware${route}`, {
    ...options, headers: { Authorization: `Bearer ${user}-test-token`, ...options.headers }
  });
  const upload = async (user, filename, data) => {
    const body = new FormData();
    body.set('file', new Blob([data]), filename);
    body.set('displayNameBase64', Buffer.from(filename).toString('base64'));
    return api('', user, { method: 'POST', body });
  };
  assert.equal((await fetch(`${base}/myclass/api/courseware`)).status, 401);
  const firstResponse = await upload('alice', '视频.mp4', '0123456789');
  assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json();
  const secondResponse = await upload('bob', '副本.mp4', '0123456789');
  assert.equal(secondResponse.status, 200);
  const second = await secondResponse.json();
  assert.equal(first.fileName, '视频.mp4');
  assert.equal(first.videoUrl, first.url);
  assert.equal(first.storageKey, second.storageKey);
  assert.notEqual(first.url, second.url);
  const listing = await (await api('')).json();
  assert.deepEqual(listing.items.map(item => item.id), [first.id]);
  const download = await fetch(`${base}${first.url}`);
  assert.equal(download.status, 200);
  assert.equal(await download.text(), '0123456789');
  const range = await fetch(`${base}${first.url}`, { headers: { Range: 'bytes=2-5' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await range.text(), '2345');
  const rename = await api(`/${first.id}/rename`, 'alice', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '新名称' })
  });
  assert.equal(rename.status, 200);
  assert.equal((await api(`/${first.id}`, 'bob', { method: 'DELETE' })).status, 404);
  for (const relative of ['public/courseware/index.json', 'public/%63ourseware/index.json',
    'public//courseware/index.json', 'public/courseware/.objects/a',
    `public/courseware/.objects/${first.storageKey.slice(0, 2)}/${first.storageKey}/original.mp4`]) {
    const response = await fetch(`${base}/myclass/${relative}`);
    assert.equal(response.status, 404, relative);
  }
  assert.equal((await upload('alice', 'large.pdf', 'a'.repeat(2048))).status, 413);
  assert.equal((await upload('alice', 'bad.exe', 'invalid')).status, 400);
  assert.equal((await api(`/${first.id}`, 'alice', { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(`${base}${first.url}`)).status, 404);
  assert.equal(await (await fetch(`${base}${second.url}`)).text(), '0123456789');
  assert.equal((await api(`/${second.id}`, 'bob', { method: 'DELETE' })).status, 200);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(storageRoot, 'index.json'), 'utf8')), []);
});
