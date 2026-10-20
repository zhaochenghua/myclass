const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startTestServer } = require('./testSupport');

function get(base, path, host) {
  return new Promise((resolve, reject) => {
    http.get(`${base}${path}`, { headers: { Host: host } }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({
        status: response.statusCode,
        body: body.startsWith('{') ? JSON.parse(body) : null
      }));
    }).on('error', reject);
  });
}

test('internal viewer receives campus download links and QR codes', async t => {
  const server = await startTestServer({ env: {
    SERVER_IP: '10.30.13.1', ALLOWED_HOSTS: '127.0.0.1,localhost,10.30.13.1,sz.imst.xyz'
  } });
  t.after(server.close);
  const config = await get(server.base, '/api/config', '10.30.13.1');
  assert.equal(config.status, 200);
  assert.equal(config.body.showDownloadLinks, true);
  assert.match(config.body.apkUrl, /^http:\/\/10\.30\.13\.1\//);
  assert.equal((await get(server.base, '/api/apk-qrcode.svg', '10.30.13.1')).status, 200);
  assert.equal((await get(server.base, '/api/ios-qrcode.svg', '10.30.13.1')).status, 200);
});

test('public viewer receives no campus download links or QR codes', async t => {
  const server = await startTestServer({ env: {
    SERVER_IP: '10.30.13.1', ALLOWED_HOSTS: '127.0.0.1,localhost,10.30.13.1,sz.imst.xyz'
  } });
  t.after(server.close);
  const config = await get(server.base, '/api/config', 'sz.imst.xyz');
  assert.equal(config.status, 200);
  assert.equal(config.body.showDownloadLinks, false);
  assert.equal(config.body.apkUrl, null);
  assert.equal(config.body.windowsUrl, null);
  assert.equal(config.body.iosUrl, null);
  assert.equal((await get(server.base, '/api/apk-qrcode.svg', 'sz.imst.xyz')).status, 404);
  assert.equal((await get(server.base, '/api/ios-qrcode.svg', 'sz.imst.xyz')).status, 404);
});
