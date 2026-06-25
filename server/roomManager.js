const crypto = require('crypto');

const SOCKET_OPEN = 1;
const DEFAULT_ROOM_TTL_MS = 2 * 60 * 60 * 1000;

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
    this.rooms = new Map();
    this.socketIndex = new Map();
  }

  createRoom(viewerSocket) {
    const now = Date.now();
    const code = this.#createUniqueCode();
    const room = {
      code,
      viewerSocket,
      teacherSocket: null,
      createdAt: now,
      expiresAt: now + this.roomTtlMs
    };

    this.rooms.set(code, room);
    this.socketIndex.set(viewerSocket, { code, role: 'viewer' });

    return room;
  }

  joinAsTeacher(code, teacherSocket) {
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
    sendJson(room.viewerSocket, { type: 'teacher.online' });

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
      return;
    }

    const room = this.rooms.get(binding.code);
    this.socketIndex.delete(socket);

    if (!room) {
      return;
    }

    if (binding.role === 'viewer') {
      // 教室端关闭后课堂连接码立即失效，手机端需要重新输入新连接码。
      sendJson(room.teacherSocket, {
        type: 'viewer.disconnected',
        message: '教室端已断开，请重新输入连接码'
      });
      if (isOpen(room.teacherSocket)) {
        room.teacherSocket.close(4003, 'viewer disconnected');
      }
      this.socketIndex.delete(room.teacherSocket);
      this.rooms.delete(room.code);
      return;
    }

    if (binding.role === 'teacher' && room.teacherSocket === socket) {
      room.teacherSocket = null;
      sendJson(room.viewerSocket, {
        type: 'teacher.offline',
        message: '教师设备已断开'
      });
    }
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
  DEFAULT_ROOM_TTL_MS
};
