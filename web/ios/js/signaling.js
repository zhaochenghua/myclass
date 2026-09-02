// WebSocket 信令：协议与 Android 端 SignalingClient.kt 完全一致。
//
// 手机端 -> 服务端：teacher.join / webrtc.offer / webrtc.ice-candidate /
//                   teacher.orientation / teacher.stop /
//                   courseware.open / courseware.navigate / courseware.page / courseware.close
// 服务端 -> 手机端：join.accepted / join.rejected / teacher.kicked /
//                   viewer.disconnected / room.expired / webrtc.answer /
//                   webrtc.ice-candidate / courseware.state /
//                   viewer.courseware.open / viewer.courseware.close / error

const RECONNECT_DELAY_MS = 1500;

export class SignalingClient {
  constructor(options = {}) {
    this.wsUrl = options.wsUrl;
    this.handlers = options.handlers || {};
    this.socket = null;
    this.closedByUser = false;
    this.reconnectTimer = null;
    this.joinPayload = null; // { code, token } —— 重连后自动重新加入
    this.joined = false;
  }

  connect() {
    this.closedByUser = false;
    this.#open();
  }

  close() {
    this.closedByUser = true;
    this.joined = false;
    clearTimeout(this.reconnectTimer);
    if (this.socket) {
      this.socket.onopen = null;
      this.socket.onmessage = null;
      this.socket.onclose = null;
      this.socket.onerror = null;
      try {
        this.socket.close(1000, 'user closed');
      } catch {
        /* ignore */
      }
      this.socket = null;
    }
  }

  /** 加入课堂（教师端）。断线重连后会用相同的参数自动重新加入。 */
  join(code, token) {
    this.joinPayload = { code, token: token || null };
    if (this.isOpen()) {
      this.#sendJoin();
    } else if (!this.socket || this.socket.readyState === WebSocket.CLOSED) {
      this.#open();
    }
  }

  isOpen() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  send(payload) {
    if (!this.isOpen()) return false;
    try {
      this.socket.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  // ---- 业务消息 ----
  sendOffer(sdp) {
    return this.send({ type: 'webrtc.offer', sdp });
  }

  sendIceCandidate(candidate) {
    return this.send({ type: 'webrtc.ice-candidate', candidate });
  }

  sendStop() {
    return this.send({ type: 'teacher.stop' });
  }

  sendOrientation(payload) {
    return this.send({ type: 'teacher.orientation', ...payload });
  }

  sendCoursewareOpen({ url, title, page = 1, screen = 1, linkUrl = null }) {
    const message = { type: 'courseware.open', url, title, page, screen };
    if (linkUrl) message.linkUrl = linkUrl;
    return this.send(message);
  }

  sendCoursewareNavigate(delta) {
    return this.send({ type: 'courseware.navigate', delta: delta < 0 ? -1 : 1 });
  }

  sendCoursewarePage(page) {
    return this.send({ type: 'courseware.page', page });
  }

  sendCoursewareClose() {
    return this.send({ type: 'courseware.close' });
  }

  // ---- 内部实现 ----
  #open() {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const socket = new WebSocket(this.wsUrl);
    this.socket = socket;

    socket.onopen = () => {
      this.handlers.onOpen?.();
      if (this.joinPayload) {
        this.#sendJoin();
      }
    };

    socket.onmessage = (event) => {
      let message = null;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!message || typeof message.type !== 'string') return;

      switch (message.type) {
        case 'join.accepted':
          this.joined = true;
          this.handlers.onJoinAccepted?.(message);
          break;
        case 'join.rejected':
          this.joined = false;
          this.joinPayload = null;
          this.handlers.onJoinRejected?.(message.message || '连接码错误');
          break;
        case 'teacher.kicked':
          this.joined = false;
          this.joinPayload = null;
          this.handlers.onKicked?.(message.message || '本设备已下线');
          break;
        case 'viewer.disconnected':
        case 'room.expired':
          this.joined = false;
          this.joinPayload = null;
          this.handlers.onServerClosed?.(message.message || '课堂已断开');
          break;
        case 'webrtc.answer':
          this.handlers.onAnswer?.(message.sdp);
          break;
        case 'webrtc.ice-candidate':
          this.handlers.onRemoteIceCandidate?.(message.candidate);
          break;
        case 'courseware.state':
          this.handlers.onCoursewareState?.(message);
          break;
        case 'viewer.courseware.open':
          this.handlers.onViewerCoursewareOpen?.(message);
          break;
        case 'viewer.courseware.close':
          this.handlers.onViewerCoursewareClose?.(message);
          break;
        case 'error':
          this.handlers.onSignalError?.(message.message || '信令错误');
          break;
        default:
          break;
      }
    };

    socket.onerror = () => {
      this.handlers.onSignalError?.('信令连接异常');
    };

    socket.onclose = () => {
      this.joined = false;
      this.socket = null;
      if (this.closedByUser) return;
      this.handlers.onDisconnected?.();
      if (this.joinPayload) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => this.#open(), RECONNECT_DELAY_MS);
      }
    };
  }

  #sendJoin() {
    if (!this.joinPayload) return;
    const payload = { type: 'teacher.join', code: this.joinPayload.code };
    if (this.joinPayload.token) payload.token = this.joinPayload.token;
    this.send(payload);
  }
}

/** 根据当前页面地址推导 WebSocket 地址 */
export function resolveWebSocketUrl(wsPath) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const path = wsPath && wsPath.startsWith('/') ? wsPath : '/myclass/ws';
  return `${protocol}//${window.location.host}${path}`;
}
