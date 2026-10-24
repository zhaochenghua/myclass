package cn.edu.nb3.myclass.tv

import android.content.Context
import android.graphics.*
import android.view.View
import org.json.JSONObject
import kotlin.math.*

class PresentationView(context: Context) : View(context) {
    private data class InkPoint(val x: Float, val y: Float, val pressure: Float, val t: Int = 0)
    private data class Stroke(
        val id: String,
        val page: Int,
        val color: Int,
        val width: Float,
        val eraser: Boolean,
        val mode: String,
        val lineMode: Boolean,
        val points: MutableList<InkPoint>
    )

    private var bitmap: Bitmap? = null
    private val strokes = mutableListOf<Stroke>()
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    private val path = Path()
    private val inkPath = Path()
    private val clearInk = PorterDuffXfermode(PorterDuff.Mode.CLEAR)
    private val bounds = RectF()
    private var page = 1
    private var pdf = false
    private var scale = 1f
    private var centerX = .5f
    private var centerY = .5f
    private var rotation = 0f
    private var progress = false
    private var pointCount = 0
    private val density = resources.displayMetrics.density
    var screen = 1
        private set
    val screenCount: Int get() {
        val image = bitmap ?: return 1
        if (!pdf || image.height <= image.width || width == 0 || height == 0) return 1
        return 1 + ceil(max(0f, image.height * width.toFloat() / image.width - height) / (height * .9f)).toInt()
    }

    fun clear() {
        bitmap?.recycle(); bitmap = null
        strokes.clear(); pointCount = 0
        resetViewport(); invalidate()
    }

    fun show(image: Bitmap, isPdf: Boolean, number: Int) {
        val old = bitmap
        bitmap = image; pdf = isPdf; page = number
        if (old !== image) old?.recycle()
        invalidate()
    }

    fun resetViewport() {
        scale = 1f; centerX = .5f; centerY = .5f; rotation = 0f
        progress = false; screen = 1
        invalidate()
    }

    fun viewport(message: JSONObject) {
        if (message.optInt("page") > 0 && message.optInt("page") != page) return
        scale = finite(message.optDouble("scale", 1.0), 1f).coerceIn(1f, 8f)
        centerX = finite(message.optDouble("centerX", .5), .5f).coerceIn(0f, 1f)
        centerY = finite(message.optDouble("centerY", .5), .5f).coerceIn(0f, 1f)
        rotation = finite(message.optDouble("rotation"), 0f) % 360
        progress = message.optBoolean("progress")
        invalidate()
    }

    fun step(delta: Int): Boolean {
        val target = screen + delta
        if (screenCount == 1 || target !in 1..screenCount) return false
        screen = target; scale = 1f; centerX = .5f; centerY = .5f; rotation = 0f; progress = false
        invalidate(); return true
    }

    fun annotation(message: JSONObject) {
        val number = message.optInt("page", page).let { if (it == 0) page else it }
        val id = message.optString("strokeId")
        when (message.optString("action")) {
            "clear" -> { strokes.removeAll { it.page == number }; recount() }
            "undo" -> { val i = strokes.indexOfLast { it.page == number }; if (i >= 0) strokes.removeAt(i); recount() }
            "begin" -> {
                if (strokes.none { it.id == id && it.page == number }) {
                    val color = runCatching { Color.parseColor(message.optString("color", "#ff4d6d")) }.getOrDefault(Color.RED)
                    strokes.add(
                        Stroke(
                            id = id,
                            page = number,
                            color = color,
                            width = finite(message.optDouble("width", 4.0), 4f).coerceIn(1f, 80f),
                            eraser = message.optBoolean("isEraser"),
                            mode = message.optString("mode", "solid"),
                            lineMode = message.optBoolean("lineMode"),
                            points = mutableListOf()
                        )
                    )
                }
                append(id, number, message)
            }
            "points" -> append(id, number, message)
        }
        // Bound the annotation heap on low-memory television hardware.
        while (pointCount > 100000 && strokes.isNotEmpty()) { pointCount -= strokes.removeAt(0).points.size }
        invalidate()
    }

    private fun append(id: String, number: Int, message: JSONObject) {
        val stroke = strokes.lastOrNull { it.id == id && it.page == number } ?: return
        val points = message.optJSONArray("points") ?: return
        for (i in 0 until min(points.length(), 10000)) {
            val point = points.optJSONObject(i) ?: continue
            val x = point.optDouble("x", Double.NaN); val y = point.optDouble("y", Double.NaN)
            if (!x.isFinite() || !y.isFinite()) continue
            // 旧版手机不发送压力，缺省 0.5 -> 按等宽手写曲线绘制，与大屏一致。
            val pressure = point.optDouble("p", 0.5).takeIf { it.isFinite() }?.toFloat() ?: 0.5f
            stroke.points.add(
                InkPoint(
                    x.toFloat().coerceIn(-8f, 8f),
                    y.toFloat().coerceIn(-8f, 8f),
                    pressure.coerceIn(0f, 1f),
                    point.optInt("t", 0)
                )
            )
            pointCount++
        }
    }

    private fun recount() { pointCount = strokes.sumOf { it.points.size } }
    private fun finite(value: Double, fallback: Float) = if (value.isFinite()) value.toFloat() else fallback

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val image = bitmap ?: return
        val radians = Math.toRadians(rotation.toDouble())
        val rotatedW = abs(image.width * cos(radians)) + abs(image.height * sin(radians))
        val rotatedH = abs(image.width * sin(radians)) + abs(image.height * cos(radians))
        val fit = if (pdf && image.height > image.width && rotation == 0f) width / rotatedW
            else min(width / rotatedW, height / rotatedH)
        val w = (rotatedW * fit * scale).toFloat()
        val h = (rotatedH * fit * scale).toFloat()
        val limitX = max(0f, (1 - width / w) / 2)
        val limitY = max(0f, (1 - height / h) / 2)
        val cx = if (progress) .5f + (centerX - .5f) * 2 * limitX else centerX.coerceIn(.5f - limitX, .5f + limitX)
        val cy = if (progress) .5f + (centerY - .5f) * 2 * limitY else centerY.coerceIn(.5f - limitY, .5f + limitY)
        val top = if (pdf && image.height > image.width && rotation == 0f && scale == 1f && centerY == .5f && !progress)
            -min((screen - 1) * height * .9f, max(0f, h - height)) else height / 2f - cy * h
        bounds.set(width / 2f - cx * w, top, width / 2f - cx * w + w, top + h)
        canvas.save()
        canvas.translate(bounds.centerX(), bounds.centerY())
        canvas.rotate(rotation)
        canvas.scale((fit * scale).toFloat(), (fit * scale).toFloat())
        paint.reset(); paint.isFilterBitmap = true
        canvas.drawBitmap(image, -image.width / 2f, -image.height / 2f, paint)
        canvas.restore()
        if (strokes.none { it.page == page && it.points.isNotEmpty() }) return
        val layer = canvas.saveLayer(0f, 0f, width.toFloat(), height.toFloat(), null)
        for (stroke in strokes) {
            if (stroke.page != page || stroke.points.isEmpty()) continue
            drawStroke(canvas, stroke)
        }
        canvas.restoreToCount(layer)
    }

    /**
     * 笔迹绘制与 Android 手机 / iPad 的 perfect-freehand 参数保持一致：
     * - 有真实压力时按压力生成轮廓，线宽随压力变化、起收笔收尖；
     * - 手指 / 普通电容笔整笔压力恒定时按归一化书写速度算线宽（InkSpeed），
     *   与电视分辨率无关，不会因为电视更宽就把整笔算成最细的一条线；
     * - 板擦、荧光笔、虚线、直线工具保持等宽，不做手写收尖。
     * 线宽按屏幕密度换算（1080p 电视 density=1，与大屏 CSS 像素 1:1），
     * 不随内容缩放变化——放大课件时笔迹保持固定粗细。
     */
    private fun drawStroke(canvas: Canvas, stroke: Stroke) {
        val points = stroke.points
        val widthPx = max(stroke.width * density, 0.5f)
        paint.reset(); paint.isAntiAlias = true
        paint.color = stroke.color
        paint.strokeCap = Paint.Cap.ROUND
        paint.strokeJoin = Paint.Join.ROUND
        when {
            stroke.eraser -> {
                paint.style = Paint.Style.STROKE
                paint.strokeWidth = widthPx
                paint.xfermode = clearInk
            }
            stroke.mode == "highlighter" -> {
                paint.style = Paint.Style.STROKE
                paint.strokeWidth = widthPx * 5f
                paint.alpha = 115
            }
            stroke.mode == "dashed" -> {
                paint.style = Paint.Style.STROKE
                paint.strokeWidth = widthPx
                paint.pathEffect = DashPathEffect(floatArrayOf(widthPx * 2.2f, widthPx * 1.6f), 0f)
            }
            stroke.mode == "dashdot" -> {
                paint.style = Paint.Style.STROKE
                paint.strokeWidth = widthPx
                paint.pathEffect = DashPathEffect(
                    floatArrayOf(widthPx * 2.2f, widthPx * 1.2f, 0.1f, widthPx * 1.2f), 0f
                )
            }
            else -> paint.style = Paint.Style.STROKE
        }

        val solidInk = !stroke.eraser && (stroke.mode == "solid" || stroke.mode.isEmpty()) && !stroke.lineMode
        if (solidInk && points.size >= 3) {
            // 压力跨度 >= 0.04 才认为设备提供真实压感；手指 / 普通电容笔整笔恒定，
            // 按归一化书写速度计算线宽（InkSpeed）。电视只显示手机发来的笔迹，
            // 不需要大屏红外框那套“等宽稳定曲线”。
            var minPressure = 1f
            var maxPressure = 0f
            for (point in points) {
                if (point.pressure < minPressure) minPressure = point.pressure
                if (point.pressure > maxPressure) maxPressure = point.pressure
            }
            if (maxPressure - minPressure >= 0.04f) {
                drawFreehandOutline(canvas, points, widthPx)
            } else {
                // 手机/平板的手指与普通电容笔整笔都是恒定压力。perfect-freehand 的
                // simulatePressure 把点距当速度，点在 2560 宽电视上比在手机上稀疏得多，
                // 会被算成整笔最细；这里改用按“归一化速度”计算的线宽（InkSpeed），
                // 与屏幕尺寸无关，手机写完投到电视上仍保留快慢造成的粗细变化。
                drawSpeedInk(canvas, points, widthPx)
            }
            return
        }

        if (points.size == 1) {
            val dotWidth = when {
                stroke.eraser -> widthPx
                stroke.mode == "highlighter" -> widthPx * 5f
                else -> widthPx
            }
            drawDot(canvas, points[0], dotWidth)
            return
        }
        path.rewind()
        points.forEachIndexed { index, point ->
            val x = bounds.left + point.x * bounds.width()
            val y = bounds.top + point.y * bounds.height()
            if (index == 0) path.moveTo(x, y) else path.lineTo(x, y)
        }
        canvas.drawPath(path, paint)
        path.rewind()
    }

    /**
     * 无压感笔迹：按归一化速度计算每个点的线宽，再生成左右两条边构成的闭合轮廓。
     * 速度以“内容宽度/秒”为单位，和电视分辨率无关，因此手机、平板上看到的粗细变化
     * 在电视上也能保留；起收笔同样收尖。算法与 Android 旧版 InkSpeed 一致。
     */
    private fun drawSpeedInk(canvas: Canvas, points: List<InkPoint>, widthPx: Float) {
        val widths = speedWidths(points, widthPx, bounds.width(), bounds.height())
        val n = points.size
        if (n == 1) { drawDot(canvas, points[0], widths[0]); return }
        // 逐段画圆头线段：每段用两端宽度的平均值。相比自己拼左右边多边形，
        // 不会在转折/稀疏采样处自交出一个鼓包，粗细过渡也足够平滑。
        paint.style = Paint.Style.STROKE
        paint.strokeCap = Paint.Cap.ROUND
        for (i in 1 until n) {
            val previous = points[i - 1]
            val point = points[i]
            paint.strokeWidth = max((widths[i - 1] + widths[i]) / 2f, 0.6f)
            canvas.drawLine(
                bounds.left + previous.x * bounds.width(),
                bounds.top + previous.y * bounds.height(),
                bounds.left + point.x * bounds.width(),
                bounds.top + point.y * bounds.height(),
                paint
            )
        }
    }

    private fun speedWidths(points: List<InkPoint>, width: Float, unitX: Float, unitY: Float): FloatArray {
        val n = points.size
        val out = FloatArray(n)
        if (n == 0) return out
        if (n == 1) { out[0] = width; return out }
        val reference = if (unitX > 0f) unitX else 1f
        val speeds = FloatArray(n)
        var speed = 0f
        for (i in 1 until n) {
            val dx = (points[i].x - points[i - 1].x) * unitX
            val dy = (points[i].y - points[i - 1].y) * unitY
            val rawDt = points[i].t - points[i - 1].t
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
        val taper = minOf(width * 3.2f, total * 0.45f)
        val tapered = total > taper * 2.2f
        fun smoothstep(value: Float): Float {
            val t = value.coerceIn(0f, 1f)
            return t * t * (3f - 2f * t)
        }
        for (i in 0 until n) {
            var factor = 1f - 0.56f * minOf(speeds[i] / 1.75f, 1f)
            if (tapered) {
                val head = smoothstep(minOf(dist[i] / taper, 1f))
                val tail = smoothstep(minOf((total - dist[i]) / taper, 1f))
                factor *= (0.2f + 0.8f * head) * (0.2f + 0.8f * tail)
            }
            out[i] = minOf(width * 2.6f, maxOf(0.6f, width * factor))
        }
        return out
    }

    /** 手写笔迹：perfect-freehand 生成闭合轮廓，参数与 Android 手机 / iPad 一致。 */
    private fun drawFreehandOutline(canvas: Canvas, points: List<InkPoint>, widthPx: Float) {
        val input = points.map { point ->
            PerfectFreehand.Input(
                bounds.left + point.x * bounds.width(),
                bounds.top + point.y * bounds.height(),
                point.pressure
            )
        }
        val size = widthPx * 1.25f
        val outline = PerfectFreehand.outline(
            input,
            size,
            thinning = 0.6f,
            smoothing = 0.5f,
            streamline = 0.5f,
            simulatePressure = false,
            taperStart = size * 0.55f,
            taperEnd = size * 0.55f
        )
        if (outline.size < 4) return
        inkPath.rewind()
        inkPath.moveTo(outline[0], outline[1])
        var i = 2
        while (i + 1 < outline.size) {
            inkPath.lineTo(outline[i], outline[i + 1])
            i += 2
        }
        inkPath.close()
        paint.style = Paint.Style.FILL
        canvas.drawPath(inkPath, paint)
        paint.style = Paint.Style.STROKE
        inkPath.rewind()
    }

    private fun drawDot(canvas: Canvas, point: InkPoint, widthPx: Float) {
        val radius = max(widthPx / 2f, 0.5f)
        val fill = Paint(paint).apply { style = Paint.Style.FILL }
        canvas.drawCircle(
            bounds.left + point.x * bounds.width(),
            bounds.top + point.y * bounds.height(),
            radius,
            fill
        )
    }
}
