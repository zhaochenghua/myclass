package cn.edu.nb3.myclass

import kotlin.math.hypot

/**
 * 手机端画笔标注的数据模型。
 *
 * 坐标口径必须与大屏端（web/app.js 的 pointerEventToSourcePoint）完全一致：
 * x / y 为 0~1 归一化值，基准是**图片在控件中经过缩放/平移/旋转之后的轴对齐外接矩形（AABB）**，
 * 而不是图片的原始像素坐标。这样旋转 90/270 时两端 AABB 宽高同步互换，笔迹不会反向错位。
 *
 * [t] 是相对笔画起点的毫秒数，[p] 是指针压力（0~1，手指/电容笔固定 0.5）。
 * 两者只用于手写笔迹的线宽曲线；旧数据缺省时退化成等宽或用速度模拟。
 */
data class AnnotationPoint(val x: Float, val y: Float, val t: Int = 0, val p: Float = 0.5f)

/**
 * 速度笔锋：线宽随书写速度变化，并在起笔 / 收笔处收尖。
 *
 * 参数必须与 web/app.js、web/ios/js/annotation.js 保持一致——
 * 同一份笔迹在手机、平板、投影上算出的粗细要完全一样，否则老师写完投影上会"变形"。
 */
object InkSpeed {
    /** 归一化速度（内容宽度/秒）达到该值后不再继续变细 */
    const val SPEED_REF = 1.75f
    /** 最快处衰减到 1 - SPEED_DROP = 0.44 倍 */
    const val SPEED_DROP = 0.56f
    /** 起收笔收尖长度 = 线宽 × 3.2 */
    const val TAPER_RATIO = 3.2f
    /** 笔尖最细到 0.2 倍 */
    const val TAPER_MIN = 0.2f
    const val MIN_WIDTH = 0.6f
    const val MAX_WIDTH_SCALE = 2.6f

    private fun smoothstep(value: Float): Float = value * value * (3f - 2f * value)

    /** 按书写速度给每个点算线宽（px）；unitX / unitY 是归一化坐标到像素的换算比例 */
    fun widths(points: List<AnnotationPoint>, width: Float, unitX: Float, unitY: Float): FloatArray {
        val n = points.size
        val out = FloatArray(n)
        if (n == 0) return out
        if (n == 1) {
            out[0] = width
            return out
        }
        val reference = if (unitX > 0f) unitX else 1f

        // 速度做 EMA 平滑，避免采样抖动让线条一节粗一节细
        val speeds = FloatArray(n)
        var speed = 0f
        for (i in 1 until n) {
            val dx = (points[i].x - points[i - 1].x) * unitX
            val dy = (points[i].y - points[i - 1].y) * unitY
            val rawDt = points[i].t.toLong() - points[i - 1].t.toLong()
            val dt = if (rawDt in 1..120) rawDt.toFloat() else 16f
            speed = speed * 0.5f + (hypot(dx, dy) / reference / dt * 1000f) * 0.5f
            speeds[i] = speed
        }
        speeds[0] = speeds[1]

        val dist = FloatArray(n)
        for (i in 1 until n) {
            val dx = (points[i].x - points[i - 1].x) * unitX
            val dy = (points[i].y - points[i - 1].y) * unitY
            dist[i] = dist[i - 1] + hypot(dx, dy)
        }
        val total = dist[n - 1]
        val taper = minOf(width * TAPER_RATIO, total * 0.45f)
        val tapered = total > taper * 2.2f

        for (i in 0 until n) {
            var factor = 1f - SPEED_DROP * minOf(speeds[i] / SPEED_REF, 1f)
            if (tapered) {
                val head = smoothstep(minOf(dist[i] / taper, 1f))
                val tail = smoothstep(minOf((total - dist[i]) / taper, 1f))
                factor *= (TAPER_MIN + (1f - TAPER_MIN) * head) * (TAPER_MIN + (1f - TAPER_MIN) * tail)
            }
            out[i] = minOf(width * MAX_WIDTH_SCALE, maxOf(MIN_WIDTH, width * factor))
        }
        return out
    }
}

data class AnnotationStroke(
    val id: String,
    /** #RRGGBB，与大屏端调色板同一套取值 */
    val colorHex: String,
    /** 画笔 4f / 板擦 40f，与大屏端 stroke.width 同单位 */
    val width: Float,
    val isEraser: Boolean,
    val points: MutableList<AnnotationPoint> = mutableListOf(),
    val mode: String = "solid",
    val lineMode: Boolean = false
)

object AnnotationPalette {
    /** 必须与 web/index.html 中 .annotation-color 的 data-color 完全一致 */
    val COLORS = listOf("#ffd166", "#ff4d6d", "#38bdf8", "#22c55e", "#ffffff")

    const val DEFAULT_COLOR = "#ff4d6d"
    const val PEN_WIDTH = 4f
    const val ERASER_WIDTH = 40f

    /** 绘制过程中增量上报轨迹点的节流间隔 */
    const val SYNC_INTERVAL_MS = 60L

    /**
     * 相邻采样点的最小归一化距离。原来是 0.0015（在 1920 宽的投影上约 2.9px），
     * 会把 MotionEvent 合并批里的历史点大量丢掉，笔迹变成稀疏折线、笔锋不连续。
     */
    const val MIN_POINT_DISTANCE = 0.0005f

    /**
     * 传输降采样：本地按全部采样点渲染，发给大屏时只保留每 0.0012 归一化距离
     * （1920 宽约 2.3px）一个点。接收端用同一套 InkRenderer 重采样回 1px 再平滑，
     * 形状与粗细不变，报文体积约为原来的 1/4。
     */
    const val SYNC_MIN_DISTANCE = 0.0012f

    /** 归一化坐标保留 4 位小数，避免浮点长尾把报文撑大 */
    fun round(value: Float): Double = Math.round(value.toDouble() * 10000.0) / 10000.0
}

/**
 * 笔画粗细：细 / 中 / 粗三档（dp），与大屏、iPad 的 4 / 6 / 9 对应。
 * 放在单例里，图片投屏和课件播放两套画笔工具栏共用同一份设置。
 */
object PenSettings {
    val WIDTHS = floatArrayOf(4f, 6f, 9f)
    var index: Int = 1
        set(value) { field = value.coerceIn(0, WIDTHS.lastIndex) }

    val width: Float get() = WIDTHS[index]

    fun cycle(): Int {
        index = (index + 1) % WIDTHS.size
        return index
    }
}

/** 大屏端画笔回传的标注动作（begin / points / end / undo / clear） */
data class RemoteAnnotationPayload(
    val action: String,
    val strokeId: String = "",
    val colorHex: String = "",
    val width: Float = AnnotationPalette.PEN_WIDTH,
    val isEraser: Boolean = false,
    val mode: String = "solid",
    val points: List<AnnotationPoint> = emptyList(),
    /** 所属页码（1 基）；0 表示不区分页（图片投屏等单页场景） */
    val page: Int = 0,
    val lineMode: Boolean = false,
    val url: String = ""
)
