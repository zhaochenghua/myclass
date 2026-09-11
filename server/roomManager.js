const crypto = require('crypto');

const SOCKET_OPEN = 1;
const DEFAULT_ROOM_TTL_MS = 2 * 60 * 60 * 1000;
// 教室端（大屏）断开后房间的保留宽限期。
// 这段时间内大屏重连（携带原连接码）会复用同一个房间和连接码，教师端无感知，
// 从而避免网络抖动 / 页面刷新导致大屏连接码变化、教师反复重连。
const DEFAULT_VIEWER_GRACE_MS = 5 * 60 * 1000;

function isOpen(socket) {
  return socket && socket.readyState === SOCKET_OPEN;
}

function sendJson(socket, payload) {
  if (!isOpen(socket)) {
    return false;
  }
  socket.send(JSON.stringify(payload));
  return true;
}

class RoomManager {
  constructor(options = {}) {
    this.roomTtlMs = options.roomTtlMs || DEFAULT_ROOM_TTL_MS;
    this.viewerGraceMs = options.viewerGraceMs || DEFAULT_VIEWER_GRACE_MS;
    this.rooms = new Map();
    this.socketIndex = new Map();
  }

  /**
   * 教室端加入课堂。requestedCode 为断线重连时带回的原连接码，
   * 命中处于宽限期的房间则复用原码（返回 resumed=true），否则新建房间。
   */
  createRoom(viewerSocket, requestedCode = null) {
    const resumed = this.#resumeRoom(viewerSocket, requestedCode);
    if (resumed) {
      return resumed;
    }

    const now = Date.now();
    const code = this.#createUniqueCode();
    const room = {
      code,
      viewerSocket,
      teacherSocket: null,
      createdAt: now,
      expiresAt: now + this.roomTtlMs,
      disconnectedAt: null,
      graceTimer: null
    };

    this.rooms.set(code, room);
    this.socketIndex.set(viewerSocket, { code, role: 'viewer' });

    return { room, resumed: false };
  }

  #resumeRoom(viewerSocket, requestedCode) {
    if (!requestedCode) {
      return null;
    }

    const code = String(requestedCode).trim();
    if (!/^\d{4}$/.test(code)) {
      return null;
    }

    const room = this.rooms.get(code);
    // 仅接管“大屏已断开且处于宽限期”的房间，防止在线的大屏被他人抢占。
    if (!room || room.viewerSocket || !room.disconnectedAt || this.#isExpired(room)) {
      return null;
    }

    clearTimeout(room.graceTimer);
    room.graceTimer = null;
    room.disconnectedAt = null;
    room.viewerSocket = viewerSocket;
    room.expiresAt = Date.now() + this.roomTtlMs;
    this.socketIndex.set(viewerSocket, { code, role: 'viewer' });

    if (isOpen(room.teacherSocket)) {
      sendJson(room.teacherSocket, {
        type: 'viewer.online',
        message: '教室端已恢复连接'
      });
    }

    return { room, resumed: true };
  }

  joinAsTeacher(code, teacherSocket, teacherInfo = null) {
    const room = this.rooms.get(code);
    if (!room || this.#isExpired(room)) {
      if (room) {
        this.#closeRoom(room, 'room.expired', '连接码已过期');
      }
      return { ok: false, reason: '连接码错误' };
    }

    // 当前版本一个课堂只允许一个教师设备，新设备会替换旧设备。
    if (isOpen(room.teacherSocket) && room.teacherSocket !== teacherSocket) {
      sendJson(room.teacherSocket, {
        type: 'teacher.kicked',
        message: '已有新设备连接，本设备已下线'
      });
      room.teacherSocket.close(4002, 'teacher replaced');
      this.socketIndex.delete(room.teacherSocket);
    }

    room.teacherSocket = teacherSocket;
    this.socketIndex.set(teacherSocket, { code, role: 'teacher' });

    // 通知大屏端教师上线，携带用户信息用于同步登录
    const onlineMsg = { type: 'teacher.online' };
    if (teacherInfo) {
      onlineMsg.username = teacherInfo.username;
      onlineMsg.token = teacherInfo.token;
    }
    sendJson(room.viewerSocket, onlineMsg);

    return { ok: true, room };
  }

  forward(senderSocket, payload) {
    const binding = this.socketIndex.get(senderSocket);
    if (!binding) {
      return false;
    }

    const room = this.rooms.get(binding.code);
    if (!room) {
      return false;
    }

    const target =
      binding.role === 'teacher' ? room.viewerSocket : room.teacherSocket;
    return sendJson(target, payload);
  }

  getBinding(socket) {
    return this.socketIndex.get(socket) || null;
  }

  removeSocket(socket) {
    const binding = this.socketIndex.get(socket);
    if (!binding) {
      return null;
    }

    const room = this.rooms.get(binding.code);
    this.socketIndex.delete(socket);

    if (!room) {
      return binding;
    }

    if (binding.role === 'viewer') {
      // 房间可能已被重连的新连接接管，此时不能再销毁房间。
      if (room.viewerSocket !== socket) {
        return binding;
      }

      // 教室端断开后先保留房间一个宽限期（教师端保持在线），
      // 大屏在此期间重连即复用原连接码；超过宽限期才真正销毁课堂。
      room.viewerSocket = null;
      room.disconnectedAt = Date.now();
      sendJson(room.teacherSocket, {
        type: 'viewer.reconnecting',
        message: '教室端已断开，正在等待自动恢复'
      });

      clearTimeout(room.graceTimer);
      room.graceTimer = setTimeout(() => {
        this.#closeRoom(room, 'viewer.disconnected', '教室端已断开，请重新输入连接码');
      }, this.viewerGraceMs);
      if (typeof room.graceTimer.unref === 'function') {
        room.graceTimer.unref();
      }
      return binding;
    }

    if (binding.role === 'teacher' && room.teacherSocket === socket) {
      room.teacherSocket = null;
      sendJson(room.viewerSocket, {
        type: 'teacher.offline',
        message: '教师设备已断开'
      });
    }

    return binding;
  }

  cleanupExpiredRooms() {
    const now = Date.now();
    for (const room of this.rooms.values()) {
      if (room.expiresAt <= now) {
        this.#closeRoom(room, 'room.expired', '连接码已过期');
      }
    }
  }

  #closeRoom(room, type, message) {
    clearTimeout(room.graceTimer);
    room.graceTimer = null;

    sendJson(room.viewerSocket, { type, message });
    sendJson(room.teacherSocket, { type, message });

    if (isOpen(room.viewerSocket)) {
      room.viewerSocket.close(4004, 'room expired');
    }
    if (isOpen(room.teacherSocket)) {
      room.teacherSocket.close(4004, 'room expired');
    }

    this.socketIndex.delete(room.viewerSocket);
    this.socketIndex.delete(room.teacherSocket);
    this.rooms.delete(room.code);
  }

  #isExpired(room) {
    return room.expiresAt <= Date.now();
  }

  #createUniqueCode() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const code = String(crypto.randomInt(1000, 10000));
      if (!this.rooms.has(code)) {
        return code;
      }
    }
    throw new Error('无法生成唯一连接码，请稍后重试');
  }
}

module.exports = {
  RoomManager,
  sendJson,
  isOpen,
  DEFAULT_ROOM_TTL_MS,
  DEFAULT_VIEWER_GRACE_MS
};
