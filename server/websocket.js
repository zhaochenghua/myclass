const { WebSocketServer } = require('ws');
const { RoomManager, sendJson, DEFAULT_ROOM_TTL_MS } = require('./roomManager');

const TEACHER_ONLY_MESSAGE_TYPES = new Set([
  'courseware.close',
  'courseware.open',
  'courseware.page',
  'webrtc.offer',
  'teacher.orientation',
  'teacher.stop'
]);

function setupWebSocket(server, options) {
  const roomManager = new RoomManager({
    roomTtlMs: options.roomTtlMs || DEFAULT_ROOM_TTL_MS
  });

  const wss = new WebSocketServer({
    server,
    path: `${options.pathPrefix}/ws`,
    verifyClient(info, done) {
      const originAllowed = options.isAllowedOrigin(info.origin);
      const hostAllowed = options.isAllowedHost(info.req.headers.host);
      done(originAllowed && hostAllowed, originAllowed && hostAllowed ? 200 : 403);
    }
  });

  wss.on('connection', (socket) => {
    socket.isAlive = true;
    socket.on('pong', () => {
      socket.isAlive = true;
    });

    socket.on('message', (rawMessage) => {
      handleMessage(socket, rawMessage, roomManager, options);
    });

    socket.on('close', () => {
      roomManager.removeSocket(socket);
    });
  });

  // 定时清理过期连接码，同时用 ping/pong 发现异常断开的客户端。
  const interval = setInterval(() => {
    roomManager.cleanupExpiredRooms();
    for (const socket of wss.clients) {
      if (!socket.isAlive) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, 30 * 1000);

  wss.on('close', () => {
    clearInterval(interval);
  });

  return wss;
}

function handleMessage(socket, rawMessage, roomManager, options) {
  const message = parseJson(rawMessage);
  if (!message || typeof message.type !== 'string') {
    sendJson(socket, { type: 'error', message: '消息格式错误' });
    return;
  }

  switch (message.type) {
    case 'viewer.join':
      handleViewerJoin(socket, roomManager, options);
      break;
    case 'teacher.join':
      handleTeacherJoin(socket, message, roomManager);
      break;
    case 'webrtc.offer':
    case 'webrtc.answer':
    case 'webrtc.ice-candidate':
    case 'courseware.close':
    case 'courseware.open':
    case 'courseware.page':
    case 'teacher.orientation':
    case 'teacher.stop':
      handleForward(socket, message, roomManager);
      break;
    default:
      sendJson(socket, {
        type: 'error',
        message: `不支持的消息类型：${message.type}`
      });
  }
}

function handleViewerJoin(socket, roomManager, options) {
  const existing = roomManager.getBinding(socket);
  if (existing) {
    sendJson(socket, { type: 'error', message: '教室端已加入课堂' });
    return;
  }

  // 连接码由服务端生成并保存在内存，避免浏览器刷新时出现碰撞。
  const room = roomManager.createRoom(socket);
  sendJson(socket, {
    type: 'room.created',
    code: room.code,
    expiresAt: room.expiresAt,
    ttlSeconds: Math.floor((room.expiresAt - Date.now()) / 1000),
    apkUrl: options.apkUrl
  });
}

function handleTeacherJoin(socket, message, roomManager) {
  const code = String(message.code || '').trim();
  if (!/^\d{4}$/.test(code)) {
    sendJson(socket, {
      type: 'join.rejected',
      message: '连接码错误'
    });
    return;
  }

  const result = roomManager.joinAsTeacher(code, socket);
  if (!result.ok) {
    sendJson(socket, {
      type: 'join.rejected',
      message: result.reason
    });
    return;
  }

  sendJson(socket, {
    type: 'join.accepted',
    code,
    message: '连接成功'
  });
}

function handleForward(socket, message, roomManager) {
  const binding = roomManager.getBinding(socket);
  if (!binding) {
    sendJson(socket, { type: 'error', message: '尚未加入课堂' });
    return;
  }

  if (TEACHER_ONLY_MESSAGE_TYPES.has(message.type) && binding.role !== 'teacher') {
    sendJson(socket, { type: 'error', message: '只有教师端可以发送该消息' });
    return;
  }

  if (message.type === 'webrtc.answer' && binding.role !== 'viewer') {
    sendJson(socket, { type: 'error', message: '只有教室端可以返回 answer' });
    return;
  }

  roomManager.forward(socket, message);
}

function parseJson(rawMessage) {
  try {
    return JSON.parse(rawMessage.toString());
  } catch (error) {
    return null;
  }
}

module.exports = setupWebSocket;
