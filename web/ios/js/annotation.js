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

import { layoutPoint, layoutRect } from './orientation.mjs?v=20261022-reader';
import getStroke from './perfect-freehand.mjs';

export const ANNOTATION_COLORS = ['#E87500', '#D00000', '#0057B8', '#00843D', '#FFFFFF'];
export const DEFAULT_COLOR = '#D00000';
export const PEN_WIDTH = 4;
export const ERASER_WIDTH = 40;
// 笔画粗细三档（CSS px）：细 / 中 / 粗
export const PEN_WIDTH_LEVELS = [4, 6, 9];

const SYNC_INTERVAL_MS = 60;
const MAX_PENDING_POINTS = 12;
// 0.0015 在 1600px 宽的内容上约 2.4px，会把合并事件里的点大量丢掉；收紧到 0.0005 让笔迹连续
const MIN_POINT_DISTANCE = 0.0005;
// 传输降采样：本地按全部采样点渲染，发给大屏时每 0.0012（1920 宽约 2.3px）一个点。
// 大屏用同一套 InkRenderer 重采样回 1px 再平滑，形状与粗细不变，报文约为 1/4。
const SYNC_MIN_DISTANCE = 0.0012;
/** 起笔判定阈值（CSS px）：单指移动超过该距离才认定为绘制，避免落点被误判成笔画 */
const START_STROKE_SLOP_PX = 6;
const ERASER_COLOR = '#000000';

// ---- 手写笔防误触 ----
// Apple Pencil 报 pointerType === 'pen'，手指 / 掌托报 'touch'。
// 笔在写的时候手指落屏一律忽略；抬笔后再屏蔽一段时间，避免掌托边缘刚抬笔就画出杂笔或触发缩放。
const STYLUS_GUARD_MS = 500;
let stylusActiveUntil = 0;

/** 笔是否正在书写（含抬笔后的短暂屏蔽期），供手势层判断要不要让开 */
export function stylusBusy() {
  return performance.now() < stylusActiveUntil;
}

function noteStylus(event) {
  if (event && event.pointerType === 'pen') stylusActiveUntil = performance.now() + STYLUS_GUARD_MS;
}

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
  const point = { x: clamp01(x), y: clamp01(y) };
  // t 是相对笔画起点的毫秒数，只用于速度笔锋；旧端不带时保持缺省
  const t = Number(raw && raw.t);
  if (Number.isFinite(t) && t >= 0) point.t = t;
  const p = Number(raw && raw.p);
  if (Number.isFinite(p) && p >= 0) point.p = clamp01(p);
  return point;
}

/** 指针压力（0~1）：手写笔给真实压力，手指 / 鼠标记 0.5，渲染时按整笔跨度决定是否用速度模拟 */
function eventPressure(event) {
  if (!event || event.pointerType !== 'pen') return 0.5;
  const value = Number(event.pressure);
  if (!Number.isFinite(value) || value <= 0) return 0.5;
  return clamp01(value);
}

// ---- 手写笔迹轮廓（perfect-freehand, MIT）----
// 参数与大屏 web/app.js、Android 端保持一致，保证同一笔迹三端一样。
const FREEHAND_THINNING = 0.6;
const FREEHAND_SMOOTHING = 0.5;
const FREEHAND_STREAMLINE = 0.5;

/** 一笔里的压力跨度：>= 0.04 才认为设备给了真实压感，否则交给速度模拟 */
function strokePressureRange(points) {
  let min = 1;
  let max = 0;
  for (const point of points) {
    const value = Number(point.p);
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return points.length ? max - min : 0;
}

/** 用 perfect-freehand 生成一笔的轮廓并填充（输入先过统一的 InkRenderer 管线） */
function drawFreehandStroke(ctx, stroke, rect, width = stroke.width) {
  const points = stroke.points;
  if (points.length < 2) return;
  const hasPressure = strokePressureRange(points) >= 0.04;
  const renderer = globalThis.InkRenderer;
  const px = points.map((point) => ({
    x: rect.left + point.x * rect.width,
    y: rect.top + point.y * rect.height,
    p: hasPressure ? clamp01(Number(point.p) || 0.5) : 0.5,
    t: Number(point.t) || 0
  }));
  // 没有加载到 inkRenderer.js（旧缓存页面）时退回原来的直接调用，至少不会整笔消失
  const prepared = renderer
    ? renderer.prepare(px, width)
    : { points: px, size: width * 1.25 };
  if (!prepared || prepared.points.length < 2) return;
  const outline = getStroke(prepared.points, {
    size: prepared.size,
    thinning: renderer ? renderer.constants.THINNING : FREEHAND_THINNING,
    smoothing: FREEHAND_SMOOTHING,
    streamline: FREEHAND_STREAMLINE,
    simulatePressure: renderer ? false : !hasPressure,
    start: { taper: 0, cap: true },
    end: { taper: 0, cap: true },
    last: true
  });
  if (outline.length < 2) return;
  ctx.beginPath();
  outline.forEach(([x, y], index) => (index === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
  ctx.fill();
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
    this.getZoom = options.getZoom || (() => 1);
    this.emit = options.emit || (() => {});
    this.onChange = options.onChange || (() => {});

    this.penMode = false;
    this.color = DEFAULT_COLOR;
    this.eraser = false;
    this.enabled = false;
    // 笔画粗细（三档）与最近一次指针压力：压力为 0.5 表示手指/电容笔
    this.penWidth = PEN_WIDTH;
    this.lastPressure = 0.5;

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
    this.lastSyncedPoint = null;
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

  /** 笔画粗细（CSS px）：细 / 中 / 粗三档由调用方决定 */
  setPenWidth(width) {
    const value = Number(width);
    if (Number.isFinite(value) && value > 0) this.penWidth = value;
  }

  /** 换图 / 翻页 / 换课件：丢弃笔迹且不产生同步副作用 */
  reset() {
    this.endActiveStroke(false);
    this.strokes = [];
    this.remoteStrokes.clear();
    this.pendingPoints = [];
    this.lastSyncedPoint = null;
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
    // 无论是否真正起笔，都必须释放指针占用并丢弃待定落点：
    // 只丢弃落点而不清 activePointerId，会让 pointerdown 里的
    // "if (this.activePointerId !== null) return" 一直命中，画笔从此再也起不了笔
    // （课件模式下双指缩放/平移后画笔失效就是这么来的）。
    this.activePointerId = null;
    this.hasPendingStart = false;
    this.pendingStart = null;
    if (!stroke) {
      // 尚未真正起笔（只是落点）：丢弃落点，不产生孤立小点。
      // 双指缩放/平移时第二指落下走的就是这条路径。
      return;
    }
    // 收笔位置一定要发给大屏：最后一个移动点可能因为降采样阈值没进队列
    const lastPoint = stroke.points[stroke.points.length - 1];
    if (lastPoint && (!this.lastSyncedPoint ||
        lastPoint.x !== this.lastSyncedPoint.x || lastPoint.y !== this.lastSyncedPoint.y)) {
      this.pendingPoints.push(lastPoint);
    }
    this.#flushPendingPoints();
    this.lastSyncedPoint = null;
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
      mode: payload.mode || 'solid',
      lineMode: payload.lineMode === true,
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
      if (point) {
        if (stroke.lineMode) stroke.points = [stroke.points[0], point];
        else stroke.points.push(point);
      }
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
    const rect = layoutRect(this.canvas);
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
    const content = layoutRect(surface);
    if (content.width <= 0 || content.height <= 0) return null;
    const canvas = layoutRect(this.canvas);
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
    // 线宽 = 内容宽度的千分比：4/6/9 → 0.27%/0.4%/0.6%，板擦 2%（比上一版整体细 1/3）。
    // 与大屏 / Android 同一口径，内容矩形已含缩放，放大时线自动变粗。
    const ratio = stroke.isEraser ? 0.02 : (Number(stroke.width) || PEN_WIDTH) / 1500;
    const width = Math.max(0.8, ratio * Math.max(1, rect.width));

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
    ctx.lineWidth = width;
    if (!stroke.isEraser) {
      if (stroke.mode === 'dashed') ctx.setLineDash([width * 2.2, width * 1.6]);
      else if (stroke.mode === 'dashdot') ctx.setLineDash([width * 2.2, width * 1.2, 0.1, width * 1.2]);
      else if (stroke.mode === 'highlighter') { ctx.lineWidth = width * 5; ctx.globalAlpha = 0.45; }
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // 实线画笔走手写轮廓（perfect-freehand，与大屏 / Android 同一套参数）；板擦、荧光笔、虚线保持等宽
    const solidInk = !stroke.isEraser && (stroke.mode === 'solid' || !stroke.mode) && !stroke.lineMode;
    if (solidInk && stroke.points.length >= 3) {
      drawFreehandStroke(ctx, stroke, rect, width);
      ctx.restore();
      return;
    }

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
      noteStylus(event);
      // 笔正在写：手指 / 掌托落屏直接忽略，不参与绘制也不参与手势
      if (event.pointerType !== 'pen' && stylusBusy()) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      // 多指时交给手势处理；仅当同一指针确实还在进行中才忽略，
      // 避免异常丢失 pointerup 时残留的 id 把画笔永久锁死。
      if (this.activePointerId !== null && (this.activeStroke || this.hasPendingStart)) return;
      this.activePointerId = null;
      const point = this.#toNormalized(event.clientX, event.clientY);
      if (!point) return;
      event.preventDefault();
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        /* 某些浏览器不支持捕获，忽略 */
      }
      this.activePointerId = event.pointerId;
      this.lastPressure = eventPressure(event);
      // 先只记录落点，等确认是单指绘制（移动超过阈值）才真正起笔，
      // 避免双指缩放 / 平移时把落点提交成"只有一个点的笔画"而留下小点。
      this.pendingStartTime = event.timeStamp;
      this.pendingClientX = event.clientX;
      this.pendingClientY = event.clientY;
      this.pendingStart = point;
      this.hasPendingStart = true;
    });

    canvas.addEventListener('pointermove', (event) => {
      noteStylus(event);
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
        this.lastPressure = eventPressure(sample);
        this.#extendStroke(sample.clientX, sample.clientY, sample.timeStamp);
      }
    });

    const finish = (event) => {
      noteStylus(event);
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
    const rect = layoutRect(surface);
    if (rect.width <= 0 || rect.height <= 0) return null;
    const point = layoutPoint({ x: clientX, y: clientY });
    const x = (point.x - rect.left) / rect.width;
    const y = (point.y - rect.top) / rect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  }

  /**
   * 本页笔迹的"锚定缩放"：以本页第一笔落下时的图像缩放为准。
   * 每笔宽度 = 画笔档位 / 锚定缩放，保证：
   *  - 单题图与整张试卷第一笔的屏幕线宽相同；
   *  - 想更细就把图放大再落第一笔；
   *  - 高分辨率整张试卷放大后，笔迹不会跟着变得很粗。
   */
  #inkAnchor() {
    const first = this.strokes.find((stroke) => !stroke.isEraser);
    if (first) {
      const stored = Number(first.inkZoom);
      if (Number.isFinite(stored) && stored > 0) return stored;
      if (Number(first.width) > 0) return Math.min(8, Math.max(1, this.penWidth / first.width));
      return 1;
    }
    const zoom = Number(this.getZoom?.());
    return Number.isFinite(zoom) && zoom > 0 ? Math.min(8, zoom) : 1;
  }

  #beginStroke(point) {
    const id = `i${(this.strokeSeq += 1)}`;
    // 时间基准用"落指那一刻"，不是真正起笔的这一帧：
    // 起笔要等移动超过 6px 才发生，若以此刻为基准，第二个点的 dt≈0，
    // 速度被算成无穷大、线宽瞬间压到最细，看起来就是起笔处跳变。
    this.strokeStartedAt = Number.isFinite(this.pendingStartTime) ? this.pendingStartTime : performance.now();
    point.t = 0;
    point.p = this.lastPressure;
    const anchor = this.#inkAnchor();
    const stroke = {
      id,
      colorHex: this.eraser ? ERASER_COLOR : this.color,
      width: this.eraser ? ERASER_WIDTH : Math.max(1, Math.min(200, this.penWidth / anchor)),
      inkZoom: anchor,
      isEraser: this.eraser,
      points: [point]
    };
    this.activeStroke = stroke;
    // begin 已携带起点，无需再放入待发队列，避免首帧把起点重复发给大屏
    this.pendingPoints = [];
    this.lastSyncedPoint = point;
    this.lastSyncAt = performance.now();
    this.emit({
      action: 'begin',
      strokeId: id,
      colorHex: stroke.colorHex,
      width: stroke.width,
      isEraser: stroke.isEraser,
      mode: 'solid',
      points: [{ x: round4(point.x), y: round4(point.y), t: 0, p: round4(point.p) }]
    });
    this.invalidate();
    this.onChange();
  }

  #extendStroke(clientX, clientY, timeStamp) {
    const stroke = this.activeStroke;
    if (!stroke) return;
    const point = this.#toNormalized(clientX, clientY);
    if (!point) return;
    const last = stroke.points[stroke.points.length - 1];
    const dx = point.x - last.x;
    const dy = point.y - last.y;
    if (dx * dx + dy * dy < MIN_POINT_DISTANCE * MIN_POINT_DISTANCE) return;

    point.t = Math.max(0, Math.round((Number.isFinite(timeStamp) ? timeStamp : performance.now()) - (this.strokeStartedAt || performance.now())));
    point.p = this.lastPressure;
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
    // 本地按全部采样点渲染，发给大屏时按像素距离抽稀（1920 宽约 2.3px 一个点）。
    // 大屏用同一套 InkRenderer 重采样回 1px 再平滑，形状与粗细不变，报文约为 1/4。
    const batch = [];
    let last = this.lastSyncedPoint;
    for (let index = 0; index < this.pendingPoints.length; index += 1) {
      const point = this.pendingPoints[index];
      const isLast = index === this.pendingPoints.length - 1;
      if (!isLast && last) {
        const dx = point.x - last.x;
        const dy = point.y - last.y;
        if (dx * dx + dy * dy < SYNC_MIN_DISTANCE * SYNC_MIN_DISTANCE) continue;
      }
      batch.push(point);
      last = point;
    }
    this.pendingPoints = [];
    if (batch.length === 0) return;
    this.lastSyncedPoint = last;
    this.emit({
      action: 'points',
      strokeId: stroke.id,
      points: batch.map((point) => ({ x: round4(point.x), y: round4(point.y), t: point.t || 0, p: round4(point.p ?? 0.5) }))
    });
  }
}

