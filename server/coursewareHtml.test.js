const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./testSupport');

function fileForm(contents, name, type) {
  const form = new FormData();
  form.append('file', new Blob([contents], { type }), name);
  return form;
}

test('HTML courseware uploads, lists as html and is served inside a CSP sandbox', { timeout: 20000 }, async t => {
  const server = await startTestServer();
  t.after(() => server.close());
  const auth = { Authorization: 'Bearer alice-test-token' };

  const upload = await fetch(`${server.base}/api/courseware`, {
    method: 'POST',
    headers: auth,
    body: fileForm('<!doctype html><html><head><title>互动课件</title></head><body><h1 id="ok">HTML 课件</h1><script>document.title = "ran";</script></body></html>', 'interactive.html', 'text/html')
  });
  assert.equal(upload.status, 200);
  const item = await upload.json();
  assert.equal(item.kind, 'html');
  assert.match(item.url, /^\/myclass\/public\/courseware\/[a-f0-9-]+\.html$/);
  assert.equal(item.htmlUrl, item.url);
  assert.equal(item.fileName, 'interactive.html');

  const listed = await (await fetch(`${server.base}/api/courseware`, { headers: auth })).json();
  assert.equal(listed.items.find(entry => entry.id === item.id)?.kind, 'html');

  // 公开地址无需登录，响应带沙箱 CSP（即使直接打开也拿不到同源存储）
  const page = await fetch(new URL(item.url, server.base));
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') || '', /^text\/html/);
  const csp = page.headers.get('content-security-policy') || '';
  assert.match(csp, /^sandbox /);
  assert.match(csp, /allow-scripts/);
  assert.doesNotMatch(csp, /allow-same-origin/);
  // 只要有一个非法标记（例如 allow-fullscreen），浏览器会整条忽略 sandbox 指令，
  // 相当于网页完全没被沙箱限制。这里逐个校验标记，防止再次写错。
  const SANDBOX_FLAGS = new Set([
    'allow-downloads', 'allow-forms', 'allow-modals', 'allow-orientation-lock',
    'allow-pointer-lock', 'allow-popups', 'allow-popups-to-escape-sandbox',
    'allow-presentation', 'allow-same-origin', 'allow-scripts',
    'allow-storage-access-by-user-activation', 'allow-top-navigation',
    'allow-top-navigation-by-user-activation'
  ]);
  const flags = csp.replace(/^sandbox\s*/, '').trim().split(/\s+/).filter(Boolean);
  assert(flags.length > 0);
  for (const flag of flags) {
    assert(SANDBOX_FLAGS.has(flag), `非法沙箱标记：${flag}`);
  }
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await page.text(), /HTML 课件/);

  // .htm 同样支持
  const short = await fetch(`${server.base}/api/courseware`, {
    method: 'POST',
    headers: auth,
    body: fileForm('<html><body>短后缀</body></html>', 'short.htm', 'text/html')
  });
  assert.equal(short.status, 200);
  assert.equal((await short.json()).kind, 'html');
});
