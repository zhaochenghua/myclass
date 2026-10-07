const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');
const { startTestServer } = require('./testSupport');

function request(base, host, origin) {
  return new Promise((resolve, reject) => {
    http.get(`${base}/api/config`, { headers: { Host: host, ...(origin ? { Origin: origin } : {}) } }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
}

function connect(base, host, origin) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http:', 'ws:')}/ws`, {
      headers: { Host: host }, origin, handshakeTimeout: 3000
    });
    ws.once('open', () => { ws.close(); resolve(101); });
    ws.once('unexpected-response', (_, res) => { res.resume(); ws.terminate(); resolve(res.statusCode); });
    ws.on('error', reject);
  });
}

test('public domain permits HTTP and WebSocket while unknown hosts and origins stay blocked', async t => {
  const server = await startTestServer({ env: { ALLOWED_HOSTS: '' } });
  t.after(server.close);
  for (const probe of [request, connect]) {
    const success = probe === request ? 200 : 101;
    assert.equal(await probe(server.base, 'sz.imst.xyz', 'https://sz.imst.xyz'), success);
    assert.equal(await probe(server.base, 'sz.imst.xyz:443', 'https://sz.imst.xyz'), success);
    assert.equal(await probe(server.base, '10.30.13.1'), success);
    assert.equal(await probe(server.base, 'untrusted.example', 'https://sz.imst.xyz'), 403);
    assert.equal(await probe(server.base, 'sz.imst.xyz', 'https://untrusted.example'), 403);
  }
});

test('explicit host configuration still overrides the defaults', async t => {
  const server = await startTestServer();
  t.after(server.close);
  assert.equal(await request(server.base, 'sz.imst.xyz', 'https://sz.imst.xyz'), 403);
  assert.equal(await request(server.base, 'localhost', 'http://localhost'), 200);
});
