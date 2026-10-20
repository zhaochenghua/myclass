const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const QRCode = require('qrcode');
const { startTestServer } = require('./testSupport');

function get(base, path, host, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(`${base}${path}`, { headers: { ...headers, Host: host } }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        text: body,
        body: body.startsWith('{') ? JSON.parse(body) : null
      }));
    }).on('error', reject);
  });
}

for (const host of ['10.30.13.1', 'sz.imst.xyz', 'sz.imst.xyz:443']) {
  test(`${host} receives matching download links and QR codes`, async t => {
    const server = await startTestServer({ env: {
      SERVER_IP: '10.30.13.1', PUBLIC_BASE_URL: 'http://10.30.13.1/myclass',
      IOS_BASE_URL: 'https://10.30.13.1/myclass',
      ALLOWED_HOSTS: '127.0.0.1,localhost,10.30.13.1,sz.imst.xyz'
    } });
    t.after(server.close);
    const headers = { 'X-Forwarded-Host': 'attacker.invalid', 'X-Forwarded-Proto': 'http' };
    const config = await get(server.base, '/api/config', host, headers);
    const internal = host === '10.30.13.1';
    const base = internal ? 'http://10.30.13.1/myclass' : 'https://sz.imst.xyz/myclass';
    const iosBase = internal ? 'https://10.30.13.1/myclass' : base;
    assert.equal(config.status, 200);
    assert.equal(config.headers['cache-control'], 'no-store');
    assert.equal(config.body.showDownloadLinks, true);
    assert.equal(config.body.iosRequiresCertificate, internal);
    assert.equal(config.body.apkUrl, `${base}/myclass.apk?v=${encodeURIComponent(config.body.apkVersion)}`);
    assert.equal(config.body.windowsUrl, `${base}/myclass-windows.exe?v=${encodeURIComponent(config.body.windowsVersion)}`);
    assert.equal(config.body.iosUrl, `${iosBase}/ios/?v=${encodeURIComponent(config.body.iosVersion)}`);
    for (const [endpoint, url] of [['apk', config.body.apkUrl], ['ios', config.body.iosUrl]]) {
      const qr = await get(server.base, `/api/${endpoint}-qrcode.svg`, host, headers);
      assert.equal(qr.status, 200);
      assert.equal(qr.headers['cache-control'], 'no-store');
      assert.equal(qr.text, await QRCode.toString(url, {
        type: 'svg', margin: 2, width: 360, color: { dark: '#061014', light: '#f7fbff' }
      }));
    }
  });
}
