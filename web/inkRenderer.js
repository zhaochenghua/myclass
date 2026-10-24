/**
 * 三端统一的手写笔迹管线（大屏 / iPad / Android 共用同一套参数与顺序）。
 *
 * 为什么需要这一步：pen-test 页面里同一套算法看起来顺滑，接到项目里却发毛、发细、
 * 没有笔锋，差别不在轮廓算法，而在"喂给轮廓算法的点"和"线宽曲线"：
 *   1. 采集点直接进渲染器（0.0005 归一化去重、零平滑）——手抖与采样噪声全部变成轮廓顶点；
 *   2. 无压感设备（红外屏 / 手指 / 电容笔）被降级成等宽线段，完全没有笔锋；
 *   3. 速度笔锋用"图宽/秒"作参考，正常书写速度根本触发不了；
 *   4. 端与端的基础线宽口径不同（dp×density vs CSS px）。
 *
 * 本模块把前两步固定下来，并把"速度 / 压力 / 起收笔"折算成每个点的目标线宽，
 * 再交给 perfect-freehand（或退化轮廓）绘制。所有端只传同一份点，看到的粗细就一致。
 *
 * 坐标必须是**最终画布像素**（调用方先做好归一化 → 像素的映射），时间 t 为相对起笔毫秒。
 */
(function (global) {
  'use strict';

  /** 相邻采样点的最小像素间距：小于它直接丢弃，避免稀疏折线（也是 pen-test 的取值） */
  const MIN_STEP_PX = 1.2;
  /** 位置平滑：新点只取 70%，抑制手抖与红外屏噪声 */
  const POSITION_ALPHA = 0.7;
  /** 压力平滑：新压力取 45% */
  const PRESSURE_ALPHA = 0.45;
  /** 速度参考（px/ms）：达到它后不再变细；人手书写约 0.3~1.2 px/ms */
  const SPEED_REF = 1.0;
  /** 最快处衰减到 1 - SPEED_DROP 倍 */
  const SPEED_DROP = 0.7;
  /**
   * 起收笔收尖长度 = 线宽 × 2.2。原来 3.2 配 0.18 的收尖像毛笔，iPad 上两端太尖；
   * 收短并抬高下限后，起收笔是圆珠笔那种圆头。
   */
  const TAPER_RATIO = 2.2;
  /** 笔尖最细到 0.55 倍（原来 0.18） */
  const TAPER_MIN = 0.55;
  /** perfect-freehand 的 size 与画笔宽度的比例（保持原有视觉重量） */
  const SIZE_SCALE = 1.25;
  /** 交给 perfect-freehand 的 thinning：配合下面的压力换算，radius 正好等于 w/2 */
  const THINNING = 0.95;
  /** perfect-freehand 内部会把 thinning 夹到 0.95，压力换算必须用同一个下限 */
  const THINNING_FLOOR = 0.05;
  /** 线宽上下限（相对基础线宽） */
  const MIN_WIDTH_SCALE = 0.2;
  const MAX_WIDTH_SCALE = 2.6;

  function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
  }

  function smoothstep(value) {
    const t = clamp(value, 0, 1);
    return t * t * (3 - 2 * t);
  }

  /** 压力曲线：轻压 ≈ 0.25 倍、满压 ≈ 2.2 倍，接近毛笔的粗细跨度 */
  function pressureCurve(pressure) {
    return 0.25 + 1.95 * Math.pow(clamp(pressure, 0, 1), 1.25);
  }

  /** 一笔里的压力跨度：>= 0.04 才认为设备真的给了压感 */
  function pressureRange(points) {
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

  /**
   * 输入调理：像素去重 + 位置/压力低通。
   * 只在渲染前做，不改存档里的点，所有端用同一份原始点算出同样的结果。
   * @param {Array<{x:number,y:number,p?:number,t?:number}>} points 画布像素坐标
   * @returns {Array<{x:number,y:number,p:number,t:number}>}
   */
  function condition(points) {
    const out = [];
    for (const point of points) {
      const x = Number(point.x);
      const y = Number(point.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const p = Number.isFinite(Number(point.p)) ? clamp(Number(point.p), 0, 1) : 0.5;
      const t = Number.isFinite(Number(point.t)) ? Number(point.t) : 0;
      const last = out[out.length - 1];
      if (!last) {
        out.push({ x, y, p, t });
        continue;
      }
      const dx = x - last.x;
      const dy = y - last.y;
      if (dx * dx + dy * dy < MIN_STEP_PX * MIN_STEP_PX) continue;
      out.push({
        x: last.x + dx * POSITION_ALPHA,
        y: last.y + dy * POSITION_ALPHA,
        p: last.p + (p - last.p) * PRESSURE_ALPHA,
        t
      });
    }
    return out;
  }

  /**
   * 计算每个点的目标线宽（像素）。
   * 速度项用真实时间戳，而不是采样间距——采样密集时按间距算会永远判成"写得慢/写得快"。
   * @param {Array<{x:number,y:number,p:number,t:number}>} points 已调理的点
   * @param {number} width 基础线宽（像素，与 points 同一坐标系）
   * @returns {Float32Array}
   */
  function widths(points, width) {
    const n = points.length;
    const base = Math.max(0.5, Number(width) || 0);
    const size = base * SIZE_SCALE;
    const out = new Float32Array(n);
    if (n === 0) return out;
    if (n === 1) { out[0] = size; return out; }

    // 1) 速度（px/ms），EMA 平滑，避免抖动让线条一节粗一节细
    const speeds = new Float32Array(n);
    let speed = 0;
    for (let i = 1; i < n; i += 1) {
      const dx = points[i].x - points[i - 1].x;
      const dy = points[i].y - points[i - 1].y;
      const rawDt = points[i].t - points[i - 1].t;
      // 重采样后相邻点只差 1px，快速书写时 dt 可能小于 1ms，不能按 16ms 兜底，
      // 否则速度会被判成"很慢"，粗细曲线整段反过来。
      const dt = Number.isFinite(rawDt) && rawDt > 0 ? clamp(rawDt, 0.2, 120) : 16;
      speed = speed * 0.5 + (Math.hypot(dx, dy) / dt) * 0.5;
      speeds[i] = speed;
    }
    speeds[0] = speeds[1] || 0;

    // 2) 累计弧长，用于起笔 / 收笔收尖
    const dist = new Float32Array(n);
    for (let i = 1; i < n; i += 1) {
      dist[i] = dist[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    }
    const total = dist[n - 1] || 0;
    const taper = Math.min(size * TAPER_RATIO, total * 0.45);
    const tapered = total > taper * 2.2;

    const usePressure = pressureRange(points) >= 0.04;
    for (let i = 0; i < n; i += 1) {
      let factor = 1;

      // 写得快 → 线变细；慢下来 → 线变粗
      const s = Math.min(speeds[i] / SPEED_REF, 1);
      factor *= 1 - SPEED_DROP * s;

      // 有真实压感才叠压力项，否则电容笔会得到一根"两端收尖"的假笔锋
      if (usePressure) factor *= 1 + (pressureCurve(points[i].p) - 1) * 0.85;

      if (tapered) {
        const head = smoothstep(dist[i] / taper);
        const tail = smoothstep((total - dist[i]) / taper);
        factor *= (TAPER_MIN + (1 - TAPER_MIN) * head) * (TAPER_MIN + (1 - TAPER_MIN) * tail);
      }

      out[i] = clamp(size * factor, Math.max(0.6, size * MIN_WIDTH_SCALE), size * MAX_WIDTH_SCALE);
    }
    return out;
  }

  /**
   * 把线宽换算成 perfect-freehand 的每点压力：
   * radius = size * ((1 - thinning) + thinning * p) / 2，令 radius = w / 2 解出 p。
   * @param {Float32Array} widths 每点线宽（像素）
   * @returns {{ points: Array<{x:number,y:number,p:number}>, size: number }}
   */
  function toFreehand(points, widths, size) {
    const span = THINNING - THINNING_FLOOR;
    return points.map((point, index) => ({
      x: point.x,
      y: point.y,
      // perfect-freehand 只认 `pressure` 字段；反解后正好落在 [THINNING_FLOOR, 1]
      pressure: clamp((widths[index] / size - THINNING_FLOOR) / span, 0, 1)
    }));
  }

  /**
   * 等距重采样：把稀疏的传输点补成约 step 像素一个，接收端才能画出平滑曲线。
   * 本地点本来就密，这一步近似无操作；大屏 / 其他端收到降采样后的点时靠它还原曲率。
   * @param {Array<{x:number,y:number,p:number,t:number}>} points
   * @param {number} [step] 目标间距（像素），默认 1px
   */
  function resample(points, step = 1) {
    if (points.length < 2) return points.map(point => ({ ...point }));
    const spacing = Math.max(0.2, Number(step) || 1);
    const out = [{ ...points[0] }];
    let from = { ...points[0] };
    let remaining = spacing;
    for (let i = 1; i < points.length; i += 1) {
      const to = points[i];
      let dx = to.x - from.x;
      let dy = to.y - from.y;
      let len = Math.hypot(dx, dy);
      while (len >= remaining && len > 0) {
        const u = remaining / len;
        const next = {
          x: from.x + dx * u,
          y: from.y + dy * u,
          p: from.p + (to.p - from.p) * u,
          t: from.t + (to.t - from.t) * u
        };
        out.push(next);
        from = next;
        dx = to.x - from.x;
        dy = to.y - from.y;
        len = Math.hypot(dx, dy);
        remaining = spacing;
      }
      remaining -= len;
      from = { ...to };
    }
    const last = points[points.length - 1];
    const tail = out[out.length - 1];
    if (Math.hypot(last.x - tail.x, last.y - tail.y) > spacing * 0.3) out.push({ ...last });
    return out;
  }

  /**
   * 一次算完：点调理 → 等距重采样 → 线宽 → perfect-freehand 输入。
   * @param {Array<{x:number,y:number,p?:number,t?:number}>} points 画布像素坐标
   * @param {number} width 基础线宽（像素）
   * @returns {{ points: Array<{x:number,y:number,pressure:number}>, size: number,
   *             widths: Float32Array, source: Array } | null}
   */
  function prepare(points, width) {
    const conditioned = resample(condition(points), 1);
    if (conditioned.length === 0) return null;
    const strokeWidths = widths(conditioned, width);
    let maxWidth = 0;
    for (const value of strokeWidths) if (value > maxWidth) maxWidth = value;
    if (!(maxWidth > 0)) maxWidth = Math.max(0.5, Number(width) || 0);
    return {
      points: toFreehand(conditioned, strokeWidths, maxWidth),
      size: maxWidth,
      widths: strokeWidths,
      source: conditioned
    };
  }

  const api = {
    condition,
    resample,
    widths,
    prepare,
    pressureCurve,
    constants: {
      MIN_STEP_PX, POSITION_ALPHA, PRESSURE_ALPHA, SPEED_REF, SPEED_DROP,
      TAPER_RATIO, TAPER_MIN, SIZE_SCALE, THINNING
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.InkRenderer = api;
})(typeof window !== 'undefined' ? window : globalThis);


