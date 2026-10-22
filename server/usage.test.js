const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { once } = require('node:events');
const WebSocket = require('ws');
const { createUsageStore, chinaDay, dateRange } = require('./usageStore');
const { RoomManager } = require('./roomManager');
const { startTestServer } = require('./testSupport');

test('usage survives concurrent writes/restarts, deduplicates uploads and uses China midnight', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'myclass-usage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let now = Date.parse('2026-10-11T15:59:59Z');
  const store = createUsageStore(root, { now: () => now });
  const alice = { id: 'alice', username: 'Alice', token: 'MUST_NOT_BE_STORED' };
  await Promise.all(Array.from({ length: 40 }, () => store.record(alice, 'connections')));
  await Promise.all(Array.from({ length: 5 }, () => store.record(alice, 'uploads', { bytes: 100, uniqueId: 'same-file' })));
  now += 2000;
  await store.record(alice, 'presentations');
  await store.record(null, 'connections');
  const restarted = createUsageStore(root, { now: () => now });
  const result = await restarted.report({ from: '2026-10-11', to: '2026-10-12', users: [
    { ...alice, username: 'Renamed' }, { id: 'bob', username: 'Bob', role: 'user' }
  ] });
  assert.equal(result.totals.connections, 41);
  assert.equal(result.totals.uploads, 1);
  assert.equal(result.totals.uploadBytes, 100);
  assert.equal(result.totals.activeUsers, 1);
  assert.equal(result.users.find(row => row.id === 'alice').activeDays, 2);
  assert.equal(result.users.find(row => row.id === 'alice').username, 'Renamed');
  assert.equal(result.users.find(row => row.id === 'bob').activeDays, 0);
  assert.equal(result.daily[0].presentations, 0);
  assert.equal(result.daily[1].presentations, 1);
  assert.equal(result.startedAt, '2026-10-11T15:59:59.000Z');
  assert.equal(JSON.stringify(result).includes('MUST_NOT_BE_STORED'), false);
  assert.equal((await fs.readFile(path.join(root, '2026-10-11.json'), 'utf8')).includes('MUST_NOT_BE_STORED'), false);
  const day = await restarted.report({ from: '2026-10-12', to: '2026-10-12' });
  assert.equal(day.totals.connections, 1);
  assert.equal(day.users.find(row => row.id === 'alice').role, 'deleted');
});

test('usage rejects invalid ranges and never silently replaces corrupt totals', async t => {
  const now = Date.parse('2026-10-12T10:00:00Z');
  for (const [from, to] of [['../bad', '2026-10-12'], ['2026-02-30', '2026-10-12'],
    ['2026-10-12', '2026-10-11'], ['2026-10-11', '2026-10-13'], ['2024-01-01', '2026-10-12']]) {
    assert.throws(() => dateRange(from, to, now), { status: 400 });
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'myclass-usage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createUsageStore(root, { now: () => now });
  await fs.writeFile(path.join(root, '2026-10-12.json'), 'BROKEN');
  await assert.rejects(store.record({ id: 'alice' }, 'logins'));
  assert.equal(await fs.readFile(path.join(root, '2026-10-12.json'), 'utf8'), 'BROKEN');
});

test('classroom metrics count forwarded actions only and never break legacy signaling', () => {
  const events = [];
  const manager = new RoomManager({ recordUsage: (...args) => events.push(args) });
  const socket = () => ({ readyState: 1, send() {}, close() {} });
  const viewer = socket();
  const teacher = socket();
  const { room } = manager.createRoom(viewer);
  assert.equal(manager.joinAsTeacher('0000', teacher).ok, false);
  assert.equal(events.length, 0);
  manager.joinAsTeacher(room.code, teacher, { id: 'alice', username: 'Alice' });
  manager.forward(teacher, { type: 'courseware.open', url: '/photo.jpg' });
  manager.forward(teacher, { type: 'courseware.page', page: 2 });
  manager.forward(teacher, { type: 'courseware.annotation', action: 'clear' });
  manager.forward(teacher, { type: 'webrtc.offer', sdp: 'test' });
  manager.forward(viewer, { type: 'student.roll.result', status: 'busy', requestId: 'a' });
  manager.forward(viewer, { type: 'student.roll.result', status: 'done', requestId: 'a' });
  viewer.readyState = 3;
  assert.equal(manager.forward(teacher, { type: 'courseware.open', url: '/offline.pdf' }), false);
  assert.deepEqual(events.map(event => event[1]), ['connections', 'presentations', 'realtime', 'rolls']);
  assert.ok(events.every(event => event[0].id === 'alice'));
  manager.recordUsage = () => { throw new Error('disk unavailable'); };
  viewer.readyState = 1;
  assert.equal(manager.forward(teacher, { type: 'courseware.open', url: '/still-works.pdf' }), true);
});

test('statistics API is admin-only and counts successful logins/uploads without counting report reads', async t => {
  const server = await startTestServer();
  t.after(server.close);
  assert.equal((await fetch(`${server.base}/api/admin/usage`)).status, 401);
  assert.equal((await server.api('/admin/usage')).status, 403);
  const file = path.join(server.directory, 'server', 'data', 'users.json');
  const users = JSON.parse(await fs.readFile(file, 'utf8'));
  users.push({ id: 'admin-test', username: 'admin_test', role: 'admin', token: 'admin-test-token', lastLoginAt: new Date().toISOString() });
  await fs.writeFile(file, JSON.stringify(users));
  const login = password => fetch(`${server.base}/api/auth/login`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'alice_test', password }) });
  assert.equal((await login('incorrect')).status, 401);
  assert.equal((await login('test1234')).status, 200);
  assert.equal((await server.api('/courseware/link', 'alice', 'POST', { title: 'example', url: 'https://example.com' })).status, 200);
  const report = await server.api('/admin/usage', 'admin');
  assert.equal(report.status, 200);
  assert.equal(report.headers.get('cache-control'), 'no-store');
  const data = await report.json();
  assert.equal(data.totals.logins, 1);
  assert.equal(data.totals.uploads, 1);
  assert.equal(data.totals.activeUsers, 1);
  assert.equal(data.users.find(user => user.id === 'bob').activeDays, 0);
  assert.equal(data.users.some(user => user.token || user.passwordHash), false);
  assert.equal(data.to, chinaDay(Date.now()));
  assert.deepEqual(data.online, { classrooms: 0, teacherDevices: 0, users: 0, teachers: [] });
  assert.equal((await (await server.api('/admin/usage', 'admin')).json()).totals.logins, 1);
  assert.equal((await server.api('/admin/usage?from=bad&to=2026-10-12', 'admin')).status, 400);
});

test('online teacher names are admin-only live connections, deduplicated by account and contain no credentials', async t => {
  const server = await startTestServer();
  const sockets = [];
  t.after(async () => { sockets.forEach(socket => socket.terminate()); await server.close(); });
  const file = path.join(server.directory, 'server/data/users.json');
  const users = JSON.parse(await fs.readFile(file, 'utf8'));
  users.push({ id: 'admin-test', username: 'admin_test', role: 'admin', token: 'admin-test-token' });
  await fs.writeFile(file, JSON.stringify(users));
  async function connect() {
    const socket = new WebSocket(server.base.replace('http:', 'ws:') + '/ws');
    sockets.push(socket);
    await once(socket, 'open');
    return socket;
  }
  function message(socket, type) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.off('message', receive); reject(Error('Waiting for ' + type)); }, 3000);
      function receive(raw) {
        const value = JSON.parse(raw);
        if (value.type !== type) return;
        clearTimeout(timer); socket.off('message', receive); resolve(value);
      }
      socket.on('message', receive);
    });
  }
  async function classroom(token) {
    const viewer = await connect();
    const created = message(viewer, 'room.created');
    viewer.send(JSON.stringify({ type: 'viewer.join' }));
    const room = await created;
    const teacher = await connect();
    const accepted = message(teacher, 'join.accepted');
    teacher.send(JSON.stringify({ type: 'teacher.join', code: room.code, ...(token ? { token } : {}) }));
    await accepted;
    return { viewer, teacher, code: room.code, recoveryKey: room.recoveryKey };
  }
  const first = await classroom('alice-test-token');
  const second = await classroom('alice-test-token');
  const anonymous = await classroom();
  assert.equal((await server.api('/admin/usage')).status, 403);
  const report = async () => (await (await server.api('/admin/usage?from=2026-01-01&to=2026-01-01', 'admin')).json()).online;
  let online = await report();
  assert.equal(online.users, 1);
  assert.equal(online.teacherDevices, 3);
  assert.equal(online.classrooms, 3);
  assert.equal(online.teachers.filter(row => row.username === 'alice_test').length, 2);
  assert.deepEqual(online.teachers.find(row => row.roomCode === anonymous.code), {
    id: null, username: '未登录设备', role: 'anonymous', roomCode: anonymous.code, viewerOnline: true
  });
  const serialized = JSON.stringify(online);
  assert.equal(serialized.includes('alice-test-token'), false);
  assert.equal(serialized.includes(first.recoveryKey), false);
  const offline = message(first.teacher, 'viewer.reconnecting');
  first.viewer.close();
  await offline;
  online = await report();
  assert.equal(online.teachers.find(row => row.roomCode === first.code).viewerOnline, false);
  assert.equal(online.teacherDevices, 3);
  const disconnected = message(second.viewer, 'teacher.offline');
  second.teacher.close();
  await disconnected;
  online = await report();
  assert.equal(online.teacherDevices, 2);
  assert.equal(online.users, 1);
  assert.equal(online.teachers.some(row => row.roomCode === second.code), false);
  const renamed = JSON.parse(await fs.readFile(file, 'utf8'));
  renamed.find(user => user.id === 'alice').username = 'AliceRenamed';
  await fs.writeFile(file, JSON.stringify(renamed));
  assert.equal((await report()).teachers.find(row => row.roomCode === first.code).username, 'AliceRenamed');
});
