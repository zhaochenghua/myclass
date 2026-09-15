const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const WebSocket = require('ws');
const setupWebSocket = require('./websocket');
const { RoomManager } = require('./roomManager');

async function fixture(t) {
  const server = http.createServer();
  const manager = new RoomManager();
  const wss = setupWebSocket(server, { pathPrefix: '/myclass', roomManager: manager,
    isAllowedOrigin: () => true, isAllowedHost: () => true });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const clients = [];
  t.after(() => { clients.forEach(s => s.terminate()); wss.clients.forEach(s => s.terminate()); wss.close(); server.close(); });
  async function connect() {
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/myclass/ws`);
    clients.push(ws);
    ws.messages = [];
    ws.on('message', raw => ws.messages.push(JSON.parse(raw)));
    await once(ws, 'open');
    ws.sendJson = data => ws.send(JSON.stringify(data));
    ws.take = async type => {
      for (let i = 0; i < 200; i++) {
        const index = ws.messages.findIndex(m => m.type === type);
        if (index >= 0) return ws.messages.splice(index, 1)[0];
        await new Promise(r => setTimeout(r, 5));
      }
      throw new Error(`timeout waiting for ${type}`);
    };
    return ws;
  }
  const viewer = await connect();
  viewer.sendJson({ type: 'viewer.join', supportsRecovery: true });
  const room = await viewer.take('room.created');
  const teacher = await connect();
  teacher.sendJson({ type: 'teacher.join', code: room.code });
  await teacher.take('join.accepted');
  const send = payload => teacher.sendJson(payload);
  const barrier = async () => { send({ type: 'client.ping' }); await teacher.take('server.pong'); };
  const annotation = (action, page, id, points = []) => send({ type: 'courseware.annotation', action, page, strokeId: id, points });
  return { connect, viewer, teacher, room, manager, send, barrier, annotation };
}

test('viewer recovery restores offline page, zoom and unfinished ink; continuing the stroke does not duplicate it', async t => {
  const f = await fixture(t);
  f.send({ type: 'courseware.open', url: '/slides.pdf', page: 1 });
  await f.viewer.take('courseware.open');
  f.viewer.close();
  await f.teacher.take('viewer.reconnecting');
  f.send({ type: 'courseware.page', page: 3 });
  f.send({ type: 'courseware.image.viewport', page: 3, scale: 2, centerX: .7 });
  f.annotation('begin', 3, 'ink', [{ x: .1, y: .2 }]);
  f.annotation('points', 3, 'ink', [{ x: .3, y: .4 }]);
  await f.barrier();
  const next = await f.connect();
  next.sendJson({ type: 'viewer.join', roomCode: f.room.code, recoveryKey: f.room.recoveryKey, supportsRecovery: true });
  assert.equal((await next.take('room.created')).resumed, true);
  const snapshot = (await next.take('room.snapshot')).presentation;
  assert.equal(snapshot.open.page, 3);
  assert.equal(snapshot.viewport.scale, 2);
  assert.equal(snapshot.active[0].points.length, 2);
  f.annotation('points', 3, 'ink', [{ x: .5, y: .6 }]);
  f.annotation('end', 3, 'ink');
  await f.barrier();
  const saved = f.manager.rooms.get(f.room.code).presentation.snapshot();
  assert.equal(saved.strokes.length, 1);
  assert.equal(saved.strokes[0].points.length, 3);
  assert.equal(saved.active.length, 0);
});

test('a recovery key can replace a half-open viewer; knowing the four-digit code cannot', async t => {
  const f = await fixture(t);
  const stranger = await f.connect();
  stranger.sendJson({ type: 'viewer.join', roomCode: f.room.code, recoveryKey: 'wrong' });
  assert.notEqual((await stranger.take('room.created')).code, f.room.code);
  const next = await f.connect();
  next.sendJson({ type: 'viewer.join', roomCode: f.room.code, recoveryKey: f.room.recoveryKey, supportsRecovery: true });
  assert.equal((await next.take('room.created')).code, f.room.code);
  await next.take('room.snapshot');
  assert(f.manager.rooms.get(f.room.code).teacherSocket);
});

test('clear and undo respect explicit pages; a delayed render acknowledgement cannot roll back the page', async t => {
  const f = await fixture(t);
  f.send({ type: 'courseware.open', url: '/slides.pdf', page: 1 });
  const opened = await f.viewer.take('courseware.open');
  for (const [page, id] of [[1, 'a'], [2, 'b'], [2, 'c']]) {
    f.annotation('begin', page, id, [{ x: .1, y: .1 }]); f.annotation('end', page, id);
  }
  f.send({ type: 'courseware.page', page: 2 });
  await f.viewer.take('courseware.page');
  f.viewer.sendJson({ type: 'courseware.state', page: 1, pageCount: 10, presentationRevision: opened.presentationRevision });
  f.annotation('undo', 2);
  f.annotation('clear', 1);
  await f.barrier();
  const room = f.manager.rooms.get(f.room.code);
  assert.equal(room.presentation.page, 2);
  assert.deepEqual(room.presentation.strokes.map(s => s.strokeId), ['b']);
  f.send({ type: 'courseware.close' }); await f.barrier();
  assert.equal(room.presentation.snapshot(), null);
});

test('active classrooms do not expire at the original two-hour deadline', async t => {
  const f = await fixture(t);
  const room = f.manager.rooms.get(f.room.code);
  room.expiresAt = Date.now() - 1;
  f.manager.cleanupExpiredRooms();
  assert(f.manager.rooms.has(room.code));
  assert(room.expiresAt > Date.now());
});
