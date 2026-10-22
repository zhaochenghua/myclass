package cn.edu.nb3.myclass

import android.graphics.PointF
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/**
 * 手写笔迹轮廓算法（perfect-freehand, MIT — https://github.com/steveruizok/perfect-freehand）。
 *
 * Android 端按同一套参数做了 Kotlin 移植：大屏 web/app.js 与 iPad annotation.js 直接使用
 * 官方库，这里保持 size / thinning / smoothing / streamline / taper 的含义一致，
 * 保证同一份笔迹（相同的点、时间戳 t、压力 p）在三端看起来一致。
 */
object PerfectFreehand {
    data class Input(val x: Float, val y: Float, val pressure: Float)

    private const val MIN_DISTANCE = 0.0001f

    private class StrokePoint(
        val x: Float,
        val y: Float,
        var pressure: Float,
        val vx: Float,
        val vy: Float,
        val distance: Float,
        val runningLength: Float
    )

    private fun strokeRadius(size: Float, thinning: Float, pressure: Float): Float {
        if (thinning <= 0f) return size / 2f
        val t = thinning.coerceIn(0.05f, 0.95f)
        val low = size - size * t
        return (low + (size - low) * pressure.coerceIn(0f, 1f)) / 2f
    }

    private fun smoothstep(value: Float): Float {
        val t = value.coerceIn(0f, 1f)
        return t * t * (3f - 2f * t)
    }

    /**
     * 生成一笔的轮廓多边形（x0,y0,x1,y1,...）。
     *
     * @param points 采样点（含压力 0~1）
     * @param size 基础线宽（直径）
     * @param thinning 压力对粗细的影响（0.6 ≈ 轻压 40%、满压 100%）
     * @param smoothing 边缘平滑度
     * @param streamline 中线平滑度
     * @param simulatePressure 没有真实压感时用速度模拟
     * @param taperStart / taperEnd 起收笔收尖长度（px）
     */
    fun outline(
        points: List<Input>,
        size: Float,
        thinning: Float = 0.6f,
        smoothing: Float = 0.5f,
        streamline: Float = 0.5f,
        simulatePressure: Boolean = true,
        taperStart: Float = 0f,
        taperEnd: Float = 0f
    ): FloatArray {
        if (points.isEmpty()) return FloatArray(0)
        val source = if (points.size == 1) listOf(points[0], Input(points[0].x + 1f, points[0].y, points[0].pressure)) else points

        var stream = streamline / 2f
        if (!simulatePressure) stream /= 2f

        // 1) 中线平滑（streamline）+ 累计弧长
        val stroke = ArrayList<StrokePoint>(source.size)
        stroke.add(StrokePoint(source[0].x, source[0].y, source[0].pressure, 0f, 0f, 0f, 0f))
        for (i in 1 until source.size) {
            val prev = stroke[stroke.size - 1]
            val px = prev.x + (source[i].x - prev.x) * (1f - stream)
            val py = prev.y + (source[i].y - prev.y) * (1f - stream)
            val dx = px - prev.x
            val dy = py - prev.y
            val len = hypot(dx, dy)
            if (len < MIN_DISTANCE) continue
            stroke.add(StrokePoint(px, py, source[i].pressure, dx / len, dy / len, len, prev.runningLength + len))
        }
        if (stroke.size < 2) return dot(points, size, thinning)

        val totalLength = stroke[stroke.size - 1].runningLength
        val left = ArrayList<PointF>(stroke.size)
        val right = ArrayList<PointF>(stroke.size)

        var prevPressure = stroke.take(5).fold(stroke[0].pressure) { acc, cur -> (acc + cur.pressure) / 2f }
        var radius = strokeRadius(size, thinning, stroke[stroke.size - 1].pressure)
        var prevVx = stroke[0].vx
        var prevVy = stroke[0].vy

        for (i in 1 until stroke.size - 1) {
            val point = stroke[i]
            var pressure = point.pressure
            if (thinning > 0f) {
                if (simulatePressure) {
                    val rp = min(1f, 1f - point.distance / size)
                    val sp = min(1f, point.distance / size)
                    pressure = min(1f, prevPressure + (rp - prevPressure) * (sp / 2f))
                }
                radius = strokeRadius(size, thinning, pressure)
            } else {
                radius = size / 2f
            }
            val ts = if (taperStart > 0f && point.runningLength < taperStart) smoothstep(point.runningLength / taperStart) else 1f
            val te = if (taperEnd > 0f && totalLength - point.runningLength < taperEnd) {
                smoothstep((totalLength - point.runningLength) / taperEnd)
            } else 1f
            radius *= min(ts, te)

            // 转角过锐时沿上一段法线处理，避免外侧出现缺口
            var nx = -point.vy
            var ny = point.vx
            if (i + 1 < stroke.size) {
                val next = stroke[i + 1]
                val dot = point.vx * next.vx + point.vy * next.vy
                if (dot < 0f) {
                    nx = -prevVy
                    ny = prevVx
                }
            }
            val ox = nx * radius
            val oy = ny * radius
            left.add(PointF(point.x - ox, point.y - oy))
            right.add(PointF(point.x + ox, point.y + oy))
            prevPressure = pressure
            prevVx = point.vx
            prevVy = point.vy
        }

        if (left.isEmpty()) return dot(points, size, thinning)

        // 起收笔收尖已经把两端收成接近 0，直接闭合即可
        val out = FloatArray((left.size + right.size) * 2)
        var index = 0
        for (p in left) { out[index++] = p.x; out[index++] = p.y }
        for (i in right.indices.reversed()) { out[index++] = right[i].x; out[index++] = right[i].y }
        return out
    }

    /** 极短笔画（点一下）画成圆点 */
    private fun dot(points: List<Input>, size: Float, thinning: Float): FloatArray {
        val r = max(strokeRadius(size, thinning, points[0].pressure), 0.6f)
        val segments = 16
        val out = FloatArray(segments * 2)
        for (i in 0 until segments) {
            val angle = (i.toFloat() / segments) * Math.PI.toFloat() * 2f
            out[i * 2] = points[0].x + kotlin.math.cos(angle) * r
            out[i * 2 + 1] = points[0].y + kotlin.math.sin(angle) * r
        }
        return out
    }
}
