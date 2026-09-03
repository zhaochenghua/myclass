const { WebSocketServer } = require('ws');
const { RoomManager, sendJson, DEFAULT_ROOM_TTL_MS } = require('./roomManager');

const TEACHER_ONLY_MESSAGE_TYPES = new Set([
  'courseware.close',
  'courseware.image.viewport',
  'courseware.navigate',
  'courseware.open',
  'courseware.page',
  'courseware.video.control',
  'webrtc.offer',
  'teacher.orientation',
  'teacher.stop'
]);

function setupWebSocket(server, options) {
  // HTTPS 与 HTTP 监听必须共享同一个 RoomManager，
  // 否则大屏端（http）和 iPhone 网页端（https，摄像头需要安全上下文）会进入不同的房间池。
  const roomManager =
    options.roomManager ||
    new RoomManager({
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

  const binding = roomManager.getBinding(socket);
  if (message.type === 'courseware.close' || message.type === 'teacher.stop') {
    console.log(`[WS] ${binding?.role || '?'} → ${message.type}`);
  }

  switch (message.type) {
    case 'viewer.join':
      handleViewerJoin(socket, roomManager, options);
      break;
    case 'teacher.join':
      handleTeacherJoin(socket, message, roomManager, options);
      break;
    case 'webrtc.offer':
    case 'webrtc.answer':
    case 'webrtc.ice-candidate':
    case 'courseware.close':
    case 'courseware.image.viewport':
    case 'courseware.navigate':
    case 'courseware.open':
    case 'courseware.page':
    case 'courseware.state':
    case 'courseware.video.control':
    case 'courseware.video.state':
    case 'teacher.orientation':
    case 'teacher.stop':
    case 'viewer.courseware.open':
    case 'viewer.courseware.close':
      handleForward(socket, message, roomManager, options);
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

async function handleTeacherJoin(socket, message, roomManager, options) {
  const code = String(message.code || '').trim();
  if (!/^\d{4}$/.test(code)) {
    sendJson(socket, {
      type: 'join.rejected',
      message: '连接码错误'
    });
    return;
  }

  // 如果教师手机端已登录，验证 token 并获取用户信息用于大屏同步登录
  let teacherInfo = null;
  if (typeof message.token === 'string' && message.token && typeof options.verifyTeacherToken === 'function') {
    teacherInfo = await options.verifyTeacherToken(message.token);
  }

  const result = roomManager.joinAsTeacher(code, socket, teacherInfo);
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

function handleForward(socket, message, roomManager, options) {
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

  // viewer.courseware.* 仅允许大屏端发送
  if (message.type.startsWith('viewer.courseware.') && binding.role !== 'viewer') {
    sendJson(socket, { type: 'error', message: '只有教室端可以发送该消息' });
    return;
  }

  // 先同步转发消息，确保课件立即打开
  roomManager.forward(socket, message);

  // 异步查找原始文件下载地址，通过 courseware.original 消息发送
  if (message.type === 'courseware.open' && typeof message.url === 'string') {
    sendOriginalUrl(socket, message, roomManager, options);
  }
}

async function sendOriginalUrl(socket, message, roomManager, options) {
  if (typeof options.readCoursewareIndex !== 'function') {
    return;
  }
  try {
    const items = await options.readCoursewareIndex();
    const connUrl = message.url;

    // 匹配 PDF / ZIP 文件
    const pdfMatch = connUrl.match(/\/([a-f0-9-]+)\.pdf$/i);
    const zipMatch = connUrl.match(/\/([a-f0-9-]+)\.zip$/i);
    const match = pdfMatch || zipMatch;
    if (!match) {
      return;
    }
    const id = match[1];
    const item = items.find((c) => c.id === id);

    // ZIP 文件：直接用 url 作为下载链接
    if (zipMatch) {
      roomManager.forward(socket, {
        type: 'courseware.original',
        id,
        originalUrl: item?.url || connUrl
      });
      return;
    }

    // PDF 课件：发送原始文件链接
    if (item?.originalUrl && item.originalUrl !== item.url) {
      roomManager.forward(socket, {
        type: 'courseware.original',
        id,
        originalUrl: item.originalUrl
      });
    }
  } catch (error) {
    // 静默失败，不影响主流程
  }
}

function parseJson(rawMessage) {
  try {
    return JSON.parse(rawMessage.toString());
  } catch (error) {
    return null;
  }
}

module.exports = setupWebSocket;
