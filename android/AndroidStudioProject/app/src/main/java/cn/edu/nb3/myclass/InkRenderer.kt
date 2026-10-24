package cn.edu.nb3.myclass

import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/**
 * 手写笔迹管线（Android 版）：与 web/inkRenderer.js 逐行对应。
 *
 * 三端（大屏 / iPad / Android）都必须用同一套「去重 → 平滑 → 线宽 → 轮廓」，
 * 否则同一份点在不同屏幕上画出来粗细不一样，老师写完投影上会"变形"。
 *
 * 关键点：
 *  - 去重按**像素**而不是归一化距离：0.0005 在 1920 宽上是 0.96px，在手机上只有 0.5px，
 *    两端采样密度不同，笔锋自然对不上；
 *  - 位置/压力做低通，抑制手抖与红外屏噪声（pen-test 页面看着顺滑主要靠这一步）；
 *  - 速度用真实时间戳 t 计算，采样密集时按间距算会永远判成"写得很慢"；
 *  - 无压感（手指 / 电容笔 / 红外屏）用速度模拟线宽，而不是退化成等宽。
 */
object InkRenderer {
    /** 相邻采样点最小像素间距 */
    const val MIN_STEP_PX = 1.2f
    private const val POSITION_ALPHA = 0.7f
    private const val PRESSURE_ALPHA = 0.45f
    /** 速度参考（px/ms） */
    private const val SPEED_REF = 1.0f
    /** 最快处衰减到 1 - SPEED_DROP 倍；0.3 让一笔之内最多差 1.4 倍，不再是"蝌蚪" */
    private const val SPEED_DROP = 0.3f
    /** 压力项权重：只做轻微修饰 */
    private const val PRESSURE_MIX = 0.5f
    /** 体宽因子的上下限（叠起收笔之前） */
    private const val BODY_MIN = 0.78f
    private const val BODY_MAX = 1.18f
    /** 起收笔收尖长度 = 线宽 × 2.2；下限 0.55，收笔像圆珠笔的圆头而不是毛笔尖 */
    private const val TAPER_RATIO = 2.2f
    private const val TAPER_MIN = 0.55f
    /** perfect-freehand 的 size 与画笔宽度的比例 */
    const val SIZE_SCALE = 1.25f
    /** 交给 PerfectFreehand 的 thinning（与压力反解配套） */
    const val THINNING = 0.95f
    /** PerfectFreehand.strokeRadius 内部把 thinning 夹到 0.05 下限 */
    private const val THINNING_FLOOR = 0.05f
    private const val MIN_WIDTH_SCALE = 0.2f
    private const val MAX_WIDTH_SCALE = 2.6f

    /** 画布像素坐标 + 压力 + 相对起笔毫秒 */
    data class Point(val x: Float, val y: Float, val p: Float, val t: Float)

    data class Prepared(
        val points: List<PerfectFreehand.Input>,
        val size: Float,
        val widths: FloatArray,
        val source: List<Point>
    )

    private fun smoothstep(value: Float): Float {
        val t = value.coerceIn(0f, 1f)
        return t * t * (3f - 2f * t)
    }

    private fun pressureCurve(pressure: Float): Float =
        0.55f + 1.0f * pressure.coerceIn(0f, 1f).pow(1.15f)

    /** 输入调理：像素去重 + 位置/压力低通（不改存档，只影响渲染） */
    fun condition(points: List<Point>): List<Point> {
        val out = ArrayList<Point>(points.size)
        for (point in points) {
            if (!point.x.isFinite() || !point.y.isFinite()) continue
            val p = if (point.p.isFinite()) point.p.coerceIn(0f, 1f) else 0.5f
            val last = out.lastOrNull()
            if (last == null) {
                out.add(Point(point.x, point.y, p, point.t))
                continue
            }
            val dx = point.x - last.x
            val dy = point.y - last.y
            if (dx * dx + dy * dy < MIN_STEP_PX * MIN_STEP_PX) continue
            out.add(
                Point(
                    last.x + dx * POSITION_ALPHA,
                    last.y + dy * POSITION_ALPHA,
                    last.p + (p - last.p) * PRESSURE_ALPHA,
                    point.t
                )
            )
        }
        return out
    }

    /** 每点目标线宽（px） */
    fun widths(points: List<Point>, width: Float): FloatArray {
        val n = points.size
        val out = FloatArray(n)
        if (n == 0) return out
        val base = max(0.5f, width)
        val size = base * SIZE_SCALE
        if (n == 1) {
            out[0] = size
            return out
        }

        // 1) 每段速度（px/ms）
        val segments = FloatArray(n)
        for (i in 1 until n) {
            val dx = points[i].x - points[i - 1].x
            val dy = points[i].y - points[i - 1].y
            val rawDt = points[i].t - points[i - 1].t
            // 重采样后相邻点只差 1px，快速书写时 dt 会小于 1ms，不能再用整数毫秒或 16ms 兜底
            val dt = if (rawDt.isFinite() && rawDt > 0f) rawDt.coerceIn(0.2f, 120f) else 16f
            segments[i] = hypot(dx, dy) / dt
        }
        segments[0] = if (n > 1) segments[1] else 0f
        // 居中平滑：起笔时速度从 0 爬升，单向 EMA 会先给出一个"大圆头"（蝌蚪）
        val speeds = smoothArray(segments, 2)

        val dist = FloatArray(n)
        for (i in 1 until n) {
            dist[i] = dist[i - 1] + hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
        }
        val total = dist[n - 1]
        val taper = min(size * TAPER_RATIO, total * 0.45f)
        val tapered = total > taper * 2.2f

        var minPressure = 1f
        var maxPressure = 0f
        for (point in points) {
            if (point.p < minPressure) minPressure = point.p
            if (point.p > maxPressure) maxPressure = point.p
        }
        val usePressure = maxPressure - minPressure >= 0.04f

        // 2) 体宽因子 = 速度项 × 压力项，限幅后再平滑，避免一笔之内一头粗一头细
        val body = FloatArray(n)
        for (i in 0 until n) {
            var factor = 1f - SPEED_DROP * min(speeds[i] / SPEED_REF, 1f)
            if (usePressure) factor *= 1f + (pressureCurve(points[i].p) - 1f) * PRESSURE_MIX
            body[i] = factor.coerceIn(BODY_MIN, BODY_MAX)
        }
        val smoothed = smoothArray(body, 2)

        // 3) 起收笔收尖（圆头），叠在平滑后的体宽上
        for (i in 0 until n) {
            var factor = smoothed[i]
            if (tapered) {
                val head = smoothstep(dist[i] / taper)
                val tail = smoothstep((total - dist[i]) / taper)
                factor *= TAPER_MIN + (1f - TAPER_MIN) * min(head, tail)
            }
            out[i] = (size * factor).coerceIn(max(0.6f, size * MIN_WIDTH_SCALE), size * MAX_WIDTH_SCALE)
        }
        return out
    }

    /** 居中滑动平均（半径 radius，边界截断），抹平速度/宽度的突变 */
    private fun smoothArray(values: FloatArray, radius: Int): FloatArray {
        val n = values.size
        val out = FloatArray(n)
        for (i in 0 until n) {
            var sum = 0f
            var count = 0
            for (k in -radius..radius) {
                val j = i + k
                if (j < 0 || j >= n) continue
                sum += values[j]
                count++
            }
            out[i] = if (count > 0) sum / count else values[i]
        }
        return out
    }

    /** 等距重采样：把传输降采样后的稀疏点补回约 1px 一个（本地点本来就密，近似无操作） */
    fun resample(points: List<Point>, step: Float = 1f): List<Point> {
        if (points.size < 2) return points
        val spacing = max(0.2f, step)
        val out = ArrayList<Point>(points.size * 2)
        out.add(points[0])
        var from = points[0]
        var remaining = spacing
        for (i in 1 until points.size) {
            val to = points[i]
            var dx = to.x - from.x
            var dy = to.y - from.y
            var len = hypot(dx, dy)
            while (len >= remaining && len > 0f) {
                val u = remaining / len
                val next = Point(
                    from.x + dx * u,
                    from.y + dy * u,
                    from.p + (to.p - from.p) * u,
                    from.t + (to.t - from.t) * u
                )
                out.add(next)
                from = next
                dx = to.x - from.x
                dy = to.y - from.y
                len = hypot(dx, dy)
                remaining = spacing
            }
            remaining -= len
            from = to
        }
        val last = points.last()
        val tail = out.last()
        if (hypot(last.x - tail.x, last.y - tail.y) > spacing * 0.3f) out.add(last)
        return out
    }

    /** 一次算完：点调理 → 等距重采样 → 线宽 → PerfectFreehand 输入 */
    fun prepare(points: List<Point>, width: Float): Prepared? {
        val conditioned = resample(condition(points), 1f)
        if (conditioned.isEmpty()) return null
        val strokeWidths = widths(conditioned, width)
        var maxWidth = 0f
        for (value in strokeWidths) if (value > maxWidth) maxWidth = value
        if (maxWidth <= 0f) maxWidth = max(0.5f, width)
        val span = THINNING - THINNING_FLOOR
        val inputs = conditioned.mapIndexed { index, point ->
            PerfectFreehand.Input(
                point.x,
                point.y,
                ((strokeWidths[index] / maxWidth - THINNING_FLOOR) / span).coerceIn(0f, 1f)
            )
        }
        return Prepared(inputs, maxWidth, strokeWidths, conditioned)
    }
}



