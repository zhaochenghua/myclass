// WebSocket 信令：协议与 Android 端 SignalingClient.kt 完全一致。
//
// 手机端 -> 服务端：teacher.join / webrtc.offer / webrtc.ice-candidate /
//                   teacher.orientation / teacher.stop /
//                   courseware.open / courseware.navigate / courseware.page / courseware.close /
//                   courseware.annotation（begin / points / end / undo / clear）
// 服务端 -> 手机端：join.accepted / join.rejected / teacher.kicked /
//                   viewer.disconnected / room.expired / webrtc.answer /
//                   webrtc.ice-candidate / courseware.state /
//                   viewer.courseware.open / viewer.courseware.close /
//                   viewer.annotation（大屏画笔回传）/ error

const RECONNECT_DELAY_MS = 1500;

/** 与大屏端、Android 端一致：归一化坐标保留 4 位小数 */
function annotationPoint(point) {
  return {
    x: Math.round(Number(point?.x || 0) * 10000) / 10000,
    y: Math.round(Number(point?.y || 0) * 10000) / 10000
  };
}

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

  /**
   * 同步图片 / 课件视口到大屏（与 Android SignalingClient 完全一致）：
   * scale 为相对"适应屏幕"的放大倍数，rotation 为旋转角度（0 / 90 / 180 / 270）。
   *
   * 两种归端口径（大屏端按 progress 字段分支处理）：
   * - progress = false（图片投屏，兼容旧端）：centerX / centerY 直接是视口中心归一化坐标；
   * - progress = true（课件投屏，与安卓最新版一致）：centerX / centerY 是"滚动进度"
   *   （0 = 左/顶对齐，1 = 右/底对齐），并附带 page 让大屏按页记忆视口。
   *   用进度而非"视口中心位置"，可消除 iPad 与横屏大屏画面比例不同造成的错位，
   *   保证两端都从页面顶部开始、并逐屏同步滚动。
   */
  sendCoursewareImageViewport({
    scale = 1,
    centerX = 0.5,
    centerY = 0.5,
    rotation = 0,
    page = 0,
    progress = false
  }) {
    const message = { type: 'courseware.image.viewport', scale, centerX, centerY, rotation };
    if (progress) {
      message.progress = true;
      if (page) message.page = page;
    }
    return this.send(message);
  }

  /**
   * 遥控大屏端的视频播放（与 Android SignalingClient 完全一致）：
   * action 为 play / pause / toggle / seek / volume / mute / query；
   * seek 附带 position（秒），volume 附带 volume（0~100），mute 附带 muted。
   */
  sendCoursewareVideoControl(action, { position = null, volume = null, muted = null } = {}) {
    const message = { type: 'courseware.video.control', action };
    if (position !== null) message.position = position;
    if (volume !== null) message.volume = volume;
    if (muted !== null) message.muted = muted;
    return this.send(message);
  }

  // ---- 画笔标注 ----
  // 与 Android SignalingClient 完全一致：同一笔画用 strokeId 串联 begin → points（节流增量）→ end，
  // 坐标口径与大屏端画笔一致（0~1 归一化，基准为内容变换后的 AABB）。
  // undo / clear 只作用于 page 指定的那一页；page = 0 时由大屏端按当前页处理。

  sendAnnotationBegin(strokeId, colorHex, width, isEraser, firstPoint, page = 0) {
    return this.send({
      type: 'courseware.annotation',
      action: 'begin',
      strokeId,
      color: colorHex,
      width,
      isEraser: isEraser === true,
      mode: 'solid',
      lineMode: false,
      page,
      points: [annotationPoint(firstPoint)]
    });
  }

  sendAnnotationPoints(strokeId, points, page = 0) {
    const list = Array.isArray(points) ? points : [];
    if (list.length === 0) return false;
    return this.send({
      type: 'courseware.annotation',
      action: 'points',
      strokeId,
      page,
      points: list.map(annotationPoint)
    });
  }

  sendAnnotationEnd(strokeId, page = 0) {
    return this.send({ type: 'courseware.annotation', action: 'end', strokeId, page });
  }

  sendAnnotationUndo(page = 0) {
    return this.send({ type: 'courseware.annotation', action: 'undo', page });
  }

  sendAnnotationClear(page = 0) {
    return this.send({ type: 'courseware.annotation', action: 'clear', page });
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
        case 'courseware.video.state':
          this.handlers.onCoursewareVideoState?.(message);
          break;
        case 'viewer.courseware.open':
          this.handlers.onViewerCoursewareOpen?.(message);
          break;
        case 'viewer.courseware.close':
          this.handlers.onViewerCoursewareClose?.(message);
          break;
        case 'viewer.annotation':
          this.handlers.onViewerAnnotation?.(message);
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
