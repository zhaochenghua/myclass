const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { mountFontRoutes } = require('./fontHttp');
const { startTestServer } = require('./testSupport');

test('production font routes require login and are available to ordinary teachers', async t => {
  const server = await startTestServer();
  t.after(server.close);
  assert.equal((await fetch(`${server.base}/api/fonts`)).status, 401);
  assert.equal((await fetch(`${server.base}/api/fonts`, { method: 'POST' })).status, 401);
  const response = await server.api('/fonts');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(Array.isArray((await response.json()).items), true);
});

test('multipart font upload reports installs/duplicates/errors and always removes temporary files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'myclass-font-http-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let count = 0;
  const app = express();
  mountFontRoutes(app, { prefix: '/myclass', tempRoot: root, requireAuth: (_req, _res, next) => next(), store: {
    install: async (file, name) => {
      assert.equal(await fs.readFile(file, 'utf8'), 'test font');
      if (name.endsWith('.exe')) throw Object.assign(new Error('invalid font'), { status: 400 });
      return { duplicate: count++ > 0, faces: [{ family: 'Demo', style: 'Bold' }] };
    }
  } });
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/myclass/api/fonts`;
  const upload = async (name, field = 'file') => {
    const body = new FormData();
    body.append(field, new Blob(['test font']), name);
    return fetch(url, { method: 'POST', body });
  };
  const first = await upload('demo.ttf');
  assert.equal(first.status, 201);
  assert.equal((await first.json()).duplicate, false);
  assert.equal((await upload('demo.ttf')).status, 200);
  assert.equal((await upload('bad.exe')).status, 400);
  assert.equal((await upload('demo.ttf', 'unexpected')).status, 400);
  assert.equal((await fetch(url, { method: 'POST' })).status, 400);
  // The response may arrive just before the handler's finally finishes.
  for (let retry = 0; retry < 20 && (await fs.readdir(root)).length; retry++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(await fs.readdir(root), []);
});
