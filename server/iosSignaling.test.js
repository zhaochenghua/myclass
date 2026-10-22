const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function fixture() {
  const sockets = [], timers = new Map(), events = [];
  let timerId = 0;
  class WebSocket {
    static OPEN = 1; static CONNECTING = 0; static CLOSED = 3;
    constructor() { this.readyState = 0; this.sent = []; sockets.push(this); }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    close() { this.readyState = 3; this.onclose?.(); }
    open() { this.readyState = 1; this.onopen?.(); }
    receive(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
  }
  const context = vm.createContext({ WebSocket,
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id) });
  const source = fs.readFileSync(path.join(__dirname, '../web/ios/js/signaling.js'), 'utf8');
  vm.runInContext(source.replaceAll('export ', '') + '\nglobalThis.Client = SignalingClient;', context);
  const client = new context.Client({ wsUrl: 'ws://test', handlers: {
    onDisconnected: () => events.push('offline'), onViewerCoursewareViewport: m => events.push(m.type)
  } });
  client.connect(); client.join('1234', 'test-token'); sockets[0].open();
  return { client, sockets, timers, events };
}

test('foreground probe keeps a healthy socket and forwards the shared viewer range report', () => {
  const f = fixture(), socket = f.sockets[0];
  f.client.resume(); f.client.resume();
  const ping = socket.sent.at(-1);
  assert.equal(ping.type, 'client.ping');
  assert.equal(f.timers.size, 1);
  socket.receive({ type: 'server.pong', at: ping.at });
  assert.equal(f.timers.size, 0);
  socket.receive({ type: 'viewer.courseware.viewport' });
  assert.deepEqual(f.events, ['viewer.courseware.viewport']);
});

test('a half-open Safari socket is replaced and rejoins the same room', () => {
  const f = fixture();
  f.client.resume();
  [...f.timers.values()][0]();
  assert.equal(f.sockets.length, 2);
  assert.deepEqual(f.events, ['offline']);
  f.sockets[1].open();
  const join = f.sockets[1].sent[0];
  assert.equal(join.code, '1234');
  assert.equal(join.token, 'test-token');
  assert.deepEqual(join, { type: 'teacher.join', code: '1234', token: 'test-token', supportsStudentSelection: true });
});

test('leaving during a foreground probe cancels all reconnect work', () => {
  const f = fixture();
  f.client.resume(); f.client.close(); f.client.resume();
  assert.equal(f.timers.size, 0);
  assert.equal(f.sockets.length, 1);
  assert.deepEqual(f.events, []);
});

test('a delayed close from the suspended socket cannot clear its replacement', () => {
  const f = fixture(), old = f.sockets[0];
  old.readyState = 2;
  f.client.resume();
  const next = f.sockets[1];
  next.open();
  old.onclose();
  assert.equal(f.client.socket, next);
  assert.equal(f.client.isOpen(), true);
  assert.deepEqual(f.events, []);
});
