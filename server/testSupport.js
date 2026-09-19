// Isolated server for HTTP tests and browser/emulator validation. No real user
// data or release packages are read or written. Run directly for a local demo.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHmac } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

async function startTestServer({ port = 0, withWeb = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'myclass-classroom-test-'));
  const serverRoot = path.join(directory, 'server');
  await fs.mkdir(path.join(serverRoot, 'data'), { recursive: true });
  for (const name of ['server.js', 'classStore.js', 'coursewareStore.js', 'userStore.js', 'websocket.js', 'roomManager.js', 'presentationState.js']) {
    await fs.copyFile(path.join(__dirname, name), path.join(serverRoot, name));
  }
  if (withWeb) {
    await fs.mkdir(path.join(directory, 'web'), { recursive: true });
    for (const name of ['index.html', 'app.js', 'style.css', 'studentRoster.js', 'admin.html', 'admin.js', 'admin.css']) {
      await fs.copyFile(path.join(__dirname, '..', 'web', name), path.join(directory, 'web', name));
    }
  }
  const secret = 'isolated-roster-validation-secret';
  await fs.writeFile(path.join(serverRoot, 'data', 'users.json'), JSON.stringify(['alice', 'bob'].map(id => ({
    id, username: `${id}_test`, role: 'user', token: `${id}-test-token`,
    passwordHash: createHmac('sha256', secret).update('test1234').digest('hex'),
    createdAt: new Date().toISOString(), lastLoginAt: new Date().toISOString()
  }))));
  const child = spawn(process.execPath, [path.join(serverRoot, 'server.js')], {
    cwd: directory, windowsHide: true,
    env: { ...process.env, NODE_PATH: path.join(__dirname, 'node_modules'), HOST: '0.0.0.0', PORT: String(port),
      HTTPS_PORT: '0', PATH_PREFIX: '/myclass', ALLOWED_HOSTS: '127.0.0.1,localhost,10.0.2.2',
      AUTH_SECRET: secret, COURSEWARE_ROOT: path.join(directory, 'courseware') }
  });
  let output = '';
  child.stderr.on('data', data => { output += data; });
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill();
      await closed;
    }
    await fs.rm(directory, { recursive: true, force: true });
  };
  let base;
  try {
    base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server timeout: ${output}`)), 10000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`Server exited: ${output}`)); });
      child.stdout.on('data', data => {
        output += data;
        const match = output.match(/server listening on http:\/\/0\.0\.0\.0:(\d+)\/myclass\//);
        if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}/myclass`); }
      });
    });
  } catch (error) { await close(); throw error; }
  const api = async (route, user = 'alice', method = 'GET', body) => fetch(`${base}/api${route}`, {
    method, headers: { Authorization: `Bearer ${user}-test-token`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { base, directory, api, close };
}
module.exports = { startTestServer };
if (require.main === module) {
  startTestServer({ port: 3107, withWeb: true }).then(server => {
    console.log(JSON.stringify({ base: server.base, directory: server.directory, username: 'alice_test', password: 'test1234' }));
    process.once('SIGINT', async () => { await server.close(); process.exit(0); });
    process.once('SIGTERM', async () => { await server.close(); process.exit(0); });
  }).catch(error => { console.error(error); process.exit(1); });
}
