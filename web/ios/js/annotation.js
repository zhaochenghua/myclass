// iPad / iPhone 端画笔标注（图片投屏 + 课件投屏共用）。
//
// 数据模型、坐标口径与同步协议全部对齐 Android 端 AnnotationStroke.kt / ZoomableImageView.kt：
//   * 坐标为 0~1 归一化值，基准是"内容显示矩形的 AABB"——图片为 <img> 经旋转/缩放/平移后的外接矩形，
//     课件为页面画布的显示矩形。大屏端用同样的口径渲染，因此两端笔迹位置一致。
//   * 一笔 = begin → points（60ms 或 12 点节流增量上报）→ end；undo / clear 按页生效。
//   * 画笔宽 4 CSS px、板擦宽 40 CSS px（与大屏端 stroke.width 同一单位）。
//   * 板擦用 destination-out，只擦笔迹不擦底图；本端笔迹画在独立画布上，天然满足。
//
// 渲染策略：已完成笔迹画在离屏 base 画布上，可见画布每帧只叠加"进行中的笔画"，
// 避免每次手指移动都全量重绘（对齐 Android 的离屏层 + 增量追加思路）。

export const ANNOTATION_COLORS = ['#ffd166', '#ff4d6d', '#38bdf8', '#22c55e', '#ffffff'];
export const DEFAULT_COLOR = '#ff4d6d';
export const PEN_WIDTH = 4;
export const ERASER_WIDTH = 40;

const SYNC_INTERVAL_MS = 60;
const MAX_PENDING_POINTS = 12;
const MIN_POINT_DISTANCE = 0.0015;
/** 起笔判定阈值（CSS px）：单指移动超过该距离才认定为绘制，避免落点被误判成笔画 */
const START_STROKE_SLOP_PX = 6;
const ERASER_COLOR = '#000000';

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function normalizeRemotePoint(raw) {
  const x = Number(raw && raw.x);
  const y = Number(raw && raw.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: clamp01(x), y: clamp01(y) };
}

export class AnnotationBoard {
  /**
   * @param {object} options
   * @param {HTMLCanvasElement} options.canvas  叠加在内容之上的标注画布
   * @param {() => HTMLElement|null} options.getSurface 返回内容元素（<img> / 页面画布），用于坐标换算
   * @param {(payload: object) => void} options.emit 上报动作，由调用方补 page 后发给大屏
   * @param {() => void} [options.onChange] 笔迹数量变化回调（刷新工具栏可用态）
   */
  constructor(options = {}) {
    this.canvas = options.canvas;
    this.getSurface = options.getSurface || (() => null);
    this.emit = options.emit || (() => {});
    this.onChange = options.onChange || (() => {});

    this.penMode = false;
    this.color = DEFAULT_COLOR;
    this.eraser = false;
    this.enabled = false;

    this.strokes = [];
    this.remoteStrokes = new Map();
    this.activeStroke = null;
    this.activePointerId = null;
    // 待定落点：按下时先只记录位置，确认为绘制（移动超过阈值）才真正起笔。
    // 这样双指缩放/平移时第二指落下可直接丢弃落点，不会留下孤立的小点。
    this.hasPendingStart = false;
    this.pendingStart = null;
    this.pendingClientX = 0;
    this.pendingClientY = 0;
    this.pendingPoints = [];
    this.lastSyncAt = 0;
    this.strokeSeq = 0;

    this.ctx = this.canvas.getContext('2d');
    this.base = document.createElement('canvas');
    this.baseCtx = this.base.getContext('2d');
    this.frame = 0;
    this.dirty = true;
    this.lastContentKey = '';

    this.#bindPointerEvents();
  }

  // ---------------------------------------------------------------- 状态

  get count() {
    return this.strokes.length + this.remoteStrokes.size + (this.activeStroke ? 1 : 0);
  }

  setEnabled(enabled) {
    this.enabled = enabled === true;
    if (!this.enabled) {
      this.penMode = false;
      this.endActiveStroke(false);
    }
  }

  setPenMode(on) {
    this.penMode = on === true;
    if (!this.penMode) this.endActiveStroke(true);
    this.invalidate();
  }

  setColor(colorHex) {
    if (!colorHex) return;
    this.color = colorHex;
    this.eraser = false;
  }

  setEraser(on) {
    this.eraser = on === true;
  }

  /** 换图 / 翻页 / 换课件：丢弃笔迹且不产生同步副作用 */
  reset() {
    this.endActiveStroke(false);
    this.strokes = [];
    this.remoteStrokes.clear();
    this.pendingPoints = [];
    this.dirty = true;
    this.invalidate();
    this.onChange();
  }

  replaceStrokes(list) {
    this.endActiveStroke(false);
    this.strokes = Array.isArray(list) ? list.map((stroke) => ({ ...stroke, points: stroke.points.slice() })) : [];
    this.remoteStrokes.clear();
    this.dirty = true;
    this.invalidate();
    this.onChange();
  }

  /** 取出当前页笔迹用于缓存（大屏尚未结束的笔画先落盘，保证翻页后不丢） */
  currentStrokes() {
    this.endActiveStroke(false);
    this.#flushRemoteStrokes();
    return this.strokes.map((stroke) => ({ ...stroke, points: stroke.points.slice() }));
  }

  // ---------------------------------------------------------------- 编辑

  undo() {
    this.endActiveStroke(false);
    this.#flushRemoteStrokes();
    if (this.strokes.length === 0) return false;
    this.strokes.pop();
    this.dirty = true;
    this.invalidate();
    this.onChange();
    this.emit({ action: 'undo' });
    return true;
  }

  clear() {
    this.endActiveStroke(false);
    this.#flushRemoteStrokes();
    if (this.strokes.length === 0) return false;
    this.strokes = [];
    this.dirty = true;
    this.invalidate();
    this.onChange();
    this.emit({ action: 'clear' });
    return true;
  }

  /** 第二根手指落下 / 退出画笔时结束当前笔画 */
  endActiveStroke(notify = true) {
    const stroke = this.activeStroke;
    if (!stroke) {
      // 尚未真正起笔（只是落点）：直接丢弃落点，不产生孤立小点。
      // 双指缩放/平移时第二指落下走的就是这条路径。
      this.hasPendingStart = false;
      this.pendingStart = null;
      return;
    }
    this.#flushPendingPoints();
    this.activeStroke = null;
    this.activePointerId = null;
    if (stroke.points.length > 0) {
      this.strokes.push(stroke);
      this.dirty = true;
    }
    if (notify) this.emit({ action: 'end', strokeId: stroke.id });
    this.invalidate();
    this.onChange();
  }

  // ---------------------------------------------------------------- 大屏回传

  applyRemote(payload) {
    if (!payload || typeof payload.action !== 'string') return;
    switch (payload.action) {
      case 'begin':
        this.#remoteBegin(payload);
        break;
      case 'points':
        this.#remotePoints(payload);
        break;
      case 'end':
        this.#remoteEnd(payload);
        break;
      case 'undo':
        this.#flushRemoteStrokes();
        if (this.strokes.length === 0) return;
        this.strokes.pop();
        this.dirty = true;
        this.invalidate();
        this.onChange();
        break;
      case 'clear':
        this.#flushRemoteStrokes();
        if (this.strokes.length === 0) return;
        this.strokes = [];
        this.dirty = true;
        this.invalidate();
        this.onChange();
        break;
      default:
        break;
    }
  }

  #remoteBegin(payload) {
    const first = normalizeRemotePoint(payload.points?.[0]);
    if (!first) return;
    const isEraser = payload.isEraser === true;
    const width = Number(payload.width);
    this.remoteStrokes.set(String(payload.strokeId || ''), {
      id: `v:${payload.strokeId}`,
      colorHex: isEraser ? ERASER_COLOR : String(payload.colorHex || payload.color || DEFAULT_COLOR),
      width: Number.isFinite(width) && width > 0 ? width : PEN_WIDTH,
      isEraser,
      points: [first]
    });
    this.invalidate();
    // 通知外部：可能有笔迹了，需要把标注画布显示出来
    this.onChange();
  }

  #remotePoints(payload) {
    const stroke = this.remoteStrokes.get(String(payload.strokeId || ''));
    if (!stroke) return;
    const raw = Array.isArray(payload.points) ? payload.points : [];
    for (const item of raw) {
      const point = normalizeRemotePoint(item);
      if (point) stroke.points.push(point);
    }
    this.invalidate();
  }

  #remoteEnd(payload) {
    const key = String(payload.strokeId || '');
    const stroke = this.remoteStrokes.get(key);
    if (!stroke) return;
    this.remoteStrokes.delete(key);
    if (stroke.points.length > 0) {
      this.strokes.push(stroke);
      this.dirty = true;
    }
    this.invalidate();
    this.onChange();
  }

  /** 撤销/清空前把大屏尚未结束的笔画落盘，保证两端笔迹栈一致、不会撤错笔画 */
  #flushRemoteStrokes() {
    if (this.remoteStrokes.size === 0) return;
    for (const stroke of this.remoteStrokes.values()) {
      if (stroke.points.length > 0) this.strokes.push(stroke);
    }
    this.remoteStrokes.clear();
    this.dirty = true;
  }

  // ---------------------------------------------------------------- 渲染

  /** 请求重绘（内容变换、窗口尺寸变化后调用） */
  invalidate() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  render() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (rect.width <= 0 || rect.height <= 0) return;

    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.base.width = width;
      this.base.height = height;
      this.dirty = true;
    }

    // 内容显示矩形变了（图片缩放/平移/旋转、课件翻页、容器尺寸变化）必须重建离屏层：
    // base 里存的是"按当时的显示矩形"投影出来的像素，不重建就会出现图片动了而笔迹不动的错位。
    const content = this.#contentRect();
    const key = content
      ? `${content.left.toFixed(2)}|${content.top.toFixed(2)}|${content.width.toFixed(2)}|${content.height.toFixed(2)}`
      : '';
    if (key !== this.lastContentKey) {
      this.lastContentKey = key;
      this.dirty = true;
    }

    if (this.dirty) {
      this.#renderBase(dpr, content);
      this.dirty = false;
    }

    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.drawImage(this.base, 0, 0, rect.width, rect.height);
    for (const stroke of this.remoteStrokes.values()) this.#drawStroke(ctx, stroke, content);
    if (this.activeStroke) this.#drawStroke(ctx, this.activeStroke, content);
  }

  #renderBase(dpr, content) {
    const ctx = this.baseCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.base.width, this.base.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const stroke of this.strokes) this.#drawStroke(ctx, stroke, content);
  }

  /** 内容元素相对标注画布的显示矩形（含旋转/缩放后的 AABB） */
  #contentRect() {
    const surface = this.getSurface();
    if (!surface) return null;
    const content = surface.getBoundingClientRect();
    if (content.width <= 0 || content.height <= 0) return null;
    const canvas = this.canvas.getBoundingClientRect();
    return {
      left: content.left - canvas.left,
      top: content.top - canvas.top,
      width: content.width,
      height: content.height
    };
  }

  #drawStroke(ctx, stroke, content) {
    const rect = content || this.#contentRect();
    if (!rect || stroke.points.length === 0) return;

    ctx.save();
    if (stroke.isEraser) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = '#000';
      ctx.fillStyle = '#000';
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = stroke.colorHex;
      ctx.fillStyle = stroke.colorHex;
    }
    ctx.lineWidth = stroke.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (stroke.points.length === 1) {
      // 单点：补画圆点，与大屏端 drawAnnotationStroke 行为一致
      const only = stroke.points[0];
      ctx.beginPath();
      ctx.arc(
        rect.left + only.x * rect.width,
        rect.top + only.y * rect.height,
        Math.max(ctx.lineWidth / 2, 1),
        0,
        Math.PI * 2
      );
      ctx.fill();
      ctx.restore();
      return;
    }

    ctx.beginPath();
    stroke.points.forEach((point, index) => {
      const x = rect.left + point.x * rect.width;
      const y = rect.top + point.y * rect.height;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.restore();
  }

  // ---------------------------------------------------------------- 输入

  #bindPointerEvents() {
    const canvas = this.canvas;

    canvas.addEventListener('pointerdown', (event) => {
      if (!this.penMode || !this.enabled) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      if (this.activePointerId !== null) return; // 多指时交给手势处理
      const point = this.#toNormalized(event.clientX, event.clientY);
      if (!point) return;
      event.preventDefault();
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        /* 某些浏览器不支持捕获，忽略 */
      }
      this.activePointerId = event.pointerId;
      // 先只记录落点，等确认是单指绘制（移动超过阈值）才真正起笔，
      // 避免双指缩放 / 平移时把落点提交成"只有一个点的笔画"而留下小点。
      this.pendingClientX = event.clientX;
      this.pendingClientY = event.clientY;
      this.pendingStart = point;
      this.hasPendingStart = true;
    });

    canvas.addEventListener('pointermove', (event) => {
      if (!this.activeStroke && !this.hasPendingStart) return;
      if (event.pointerId !== this.activePointerId) return;
      event.preventDefault();
      // 尽量取回合并事件，快速划动时笔迹更平滑（不支持时退回单事件）
      let samples = [];
      try {
        if (typeof event.getCoalescedEvents === 'function') samples = event.getCoalescedEvents() || [];
      } catch {
        samples = [];
      }
      const list = samples.length > 0 ? samples : [event];
      for (const sample of list) {
        if (this.hasPendingStart) {
          const dx = sample.clientX - this.pendingClientX;
          const dy = sample.clientY - this.pendingClientY;
          if (dx * dx + dy * dy < START_STROKE_SLOP_PX * START_STROKE_SLOP_PX) continue;
          // 确认为绘制：以最初落点起笔，再补上当前这个点
          this.hasPendingStart = false;
          this.#beginStroke(this.pendingStart);
          this.pendingStart = null;
        }
        this.#extendStroke(sample.clientX, sample.clientY);
      }
    });

    const finish = (event) => {
      if (this.activePointerId === null || event.pointerId !== this.activePointerId) return;
      event.preventDefault();
      if (this.hasPendingStart) {
        // 单指点击且未移动：补画一个点，保留"单击画点"的能力
        this.hasPendingStart = false;
        this.#beginStroke(this.pendingStart);
        this.pendingStart = null;
      }
      this.endActiveStroke(true);
      // 释放捕获放在最后：releasePointerCapture 可能同步触发 lostpointercapture，
      // 若此时落点还没消费完，会被误判成"未起笔"而丢弃，导致单击画不出点。
      try {
        canvas.releasePointerCapture(event.pointerId);
      } catch {
        /* ignore */
      }
    };
    canvas.addEventListener('pointerup', finish);
    canvas.addEventListener('pointercancel', (event) => {
      // 手势被取消：丢弃待定落点，不补画点
      if (this.activePointerId === null || event.pointerId !== this.activePointerId) return;
      this.hasPendingStart = false;
      this.pendingStart = null;
      this.endActiveStroke(true);
    });
    canvas.addEventListener('lostpointercapture', () => {
      // 仅在真正起笔后结束；未起笔时保留待定落点，交给 pointerup 补画点
      if (this.activeStroke) this.endActiveStroke(true);
    });
  }

  #toNormalized(clientX, clientY) {
    const surface = this.getSurface();
    if (!surface) return null;
    const rect = surface.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  }

  #beginStroke(point) {
    const id = `i${(this.strokeSeq += 1)}`;
    const stroke = {
      id,
      colorHex: this.eraser ? ERASER_COLOR : this.color,
      width: this.eraser ? ERASER_WIDTH : PEN_WIDTH,
      isEraser: this.eraser,
      points: [point]
    };
    this.activeStroke = stroke;
    // begin 已携带起点，无需再放入待发队列，避免首帧把起点重复发给大屏
    this.pendingPoints = [];
    this.lastSyncAt = performance.now();
    this.emit({
      action: 'begin',
      strokeId: id,
      colorHex: stroke.colorHex,
      width: stroke.width,
      isEraser: stroke.isEraser,
      mode: 'solid',
      points: [{ x: round4(point.x), y: round4(point.y) }]
    });
    this.invalidate();
    this.onChange();
  }

  #extendStroke(clientX, clientY) {
    const stroke = this.activeStroke;
    if (!stroke) return;
    const point = this.#toNormalized(clientX, clientY);
    if (!point) return;
    const last = stroke.points[stroke.points.length - 1];
    const dx = point.x - last.x;
    const dy = point.y - last.y;
    if (dx * dx + dy * dy < MIN_POINT_DISTANCE * MIN_POINT_DISTANCE) return;

    stroke.points.push(point);
    this.pendingPoints.push(point);

    const now = performance.now();
    if (now - this.lastSyncAt >= SYNC_INTERVAL_MS || this.pendingPoints.length >= MAX_PENDING_POINTS) {
      this.#flushPendingPoints();
      this.lastSyncAt = now;
    }
    this.invalidate();
  }

  #flushPendingPoints() {
    const stroke = this.activeStroke;
    if (!stroke || this.pendingPoints.length === 0) return;
    const points = this.pendingPoints.map((point) => ({ x: round4(point.x), y: round4(point.y) }));
    this.pendingPoints = [];
    this.emit({ action: 'points', strokeId: stroke.id, points });
  }
}
