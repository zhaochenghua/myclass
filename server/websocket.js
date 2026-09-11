const { WebSocketServer } = require('ws');
const {
  RoomManager,
  sendJson,
  DEFAULT_ROOM_TTL_MS,
  DEFAULT_VIEWER_GRACE_MS
} = require('./roomManager');

// 心跳：15 秒一次 ping，连续 3 次收不到 pong（约 45~60 秒）才判定连接死亡。
// 原先 30 秒一次、一次未响应即 terminate，对投屏大屏（可能息屏/被节流）过于激进，
// 一次网络抖动就会掐断大屏并导致重连后连接码变化。
const HEARTBEAT_INTERVAL_MS = 15 * 1000;
const MAX_MISSED_PONGS = 3;

function logWs(message) {
  // 用本地时间（服务器为东八区），避免排查时还要做时区换算
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  console.log(`[${stamp}] [WS] ${message}`);
}

const TEACHER_ONLY_MESSAGE_TYPES = new Set([
  'courseware.annotation',
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

// 仅允许大屏端（viewer）发送，用于把大屏本地画笔回传给教师手机端
const VIEWER_ONLY_MESSAGE_TYPES = new Set([
  'viewer.annotation',
  'viewer.courseware.open',
  'viewer.courseware.close'
]);

function setupWebSocket(server, options) {
  // HTTPS 与 HTTP 监听必须共享同一个 RoomManager，
  // 否则大屏端（http）和 iPhone 网页端（https，摄像头需要安全上下文）会进入不同的房间池。
  const roomManager =
    options.roomManager ||
    new RoomManager({
      roomTtlMs: options.roomTtlMs || DEFAULT_ROOM_TTL_MS,
      viewerGraceMs: options.viewerGraceMs || DEFAULT_VIEWER_GRACE_MS
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

  wss.on('connection', (socket, request) => {
    socket.remoteAddress = request?.socket?.remoteAddress || '?';
    socket.isAlive = true;
    socket.missedPongs = 0;
    socket.on('pong', () => {
      socket.isAlive = true;
      socket.missedPongs = 0;
    });

    socket.on('message', (rawMessage) => {
      handleMessage(socket, rawMessage, roomManager, options);
    });

    socket.on('close', (closeCode, reason) => {
      const binding = roomManager.removeSocket(socket);
      logWs(
        `close role=${binding?.role || '?'} code=${binding?.code || '-'} ` +
          `closeCode=${closeCode} reason=${reason ? reason.toString() : ''} from=${socket.remoteAddress}`
      );
    });
  });

  // 定时清理过期连接码，同时用 ping/pong 发现异常断开的客户端。
  const interval = setInterval(() => {
    roomManager.cleanupExpiredRooms();
    for (const socket of wss.clients) {
      if (socket.missedPongs >= MAX_MISSED_PONGS) {
        logWs(`heartbeat timeout, terminate from=${socket.remoteAddress}`);
        socket.terminate();
        continue;
      }
      if (!socket.isAlive) {
        socket.missedPongs += 1;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

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
      handleViewerJoin(socket, message, roomManager, options);
      break;
    case 'teacher.join':
      handleTeacherJoin(socket, message, roomManager, options);
      break;
    case 'webrtc.offer':
    case 'webrtc.answer':
    case 'webrtc.ice-candidate':
    case 'courseware.close':
    case 'courseware.annotation':
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
    case 'viewer.annotation':
      handleForward(socket, message, roomManager, options);
      break;
    default:
      sendJson(socket, {
        type: 'error',
        message: `不支持的消息类型：${message.type}`
      });
  }
}

function handleViewerJoin(socket, message, roomManager, options) {
  const existing = roomManager.getBinding(socket);
  if (existing) {
    sendJson(socket, { type: 'error', message: '教室端已加入课堂' });
    return;
  }

  // 断线重连时大屏会带上次的连接码，命中处于宽限期的房间则复用，避免教师端重连。
  const requestedCode = typeof message.roomCode === 'string' ? message.roomCode : null;
  const { room, resumed } = roomManager.createRoom(socket, requestedCode);
  logWs(
    `room.${resumed ? 'resumed' : 'created'} code=${room.code} ` +
      `requested=${requestedCode || '-'} from=${socket.remoteAddress}`
  );

  sendJson(socket, {
    type: 'room.created',
    code: room.code,
    resumed,
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
  logWs(
    `teacher.join code=${code} ok=${result.ok} reason=${result.reason || '-'} ` +
      `from=${socket.remoteAddress}`
  );
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

  // viewer.* 仅允许大屏端发送
  if (VIEWER_ONLY_MESSAGE_TYPES.has(message.type) && binding.role !== 'viewer') {
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
