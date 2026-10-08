package cn.edu.nb3.myclass.tv

import android.content.Context
import android.graphics.*
import android.view.View
import org.json.JSONObject
import kotlin.math.*

class PresentationView(context: Context) : View(context) {
    private data class Stroke(val id: String, val page: Int, val color: Int, val width: Float,
        val eraser: Boolean, val mode: String, val points: MutableList<PointF>)
    private var bitmap: Bitmap? = null
    private val strokes = mutableListOf<Stroke>()
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    private val path = Path()
    private val clearInk = PorterDuffXfermode(PorterDuff.Mode.CLEAR)
    private val dashed = DashPathEffect(floatArrayOf(12f, 8f), 0f)
    private val bounds = RectF()
    private var page = 1
    private var pdf = false
    private var scale = 1f
    private var centerX = .5f
    private var centerY = .5f
    private var rotation = 0f
    private var progress = false
    private var pointCount = 0
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
                    strokes.add(Stroke(id, number, color, finite(message.optDouble("width", 4.0), 4f).coerceIn(1f, 80f),
                        message.optBoolean("isEraser"), message.optString("mode", "solid"), mutableListOf()))
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
            if (x.isFinite() && y.isFinite()) { stroke.points.add(PointF(x.toFloat().coerceIn(-8f, 8f), y.toFloat().coerceIn(-8f, 8f))); pointCount++ }
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
            paint.reset(); paint.isAntiAlias = true
            paint.color = stroke.color; paint.style = Paint.Style.STROKE
            paint.strokeCap = Paint.Cap.ROUND; paint.strokeJoin = Paint.Join.ROUND
            paint.strokeWidth = max(1f, stroke.width * bounds.width() / 1000f)
            if (stroke.eraser) paint.xfermode = clearInk
            if (stroke.mode == "dashed") paint.pathEffect = dashed
            if (stroke.mode == "highlighter") paint.alpha = 90
            path.reset()
            stroke.points.forEachIndexed { index, point ->
                val x = bounds.left + point.x * bounds.width(); val y = bounds.top + point.y * bounds.height()
                if (index == 0) path.moveTo(x, y) else path.lineTo(x, y)
            }
            if (stroke.points.size == 1) {
                val p = stroke.points[0]; canvas.drawPoint(bounds.left + p.x * bounds.width(), bounds.top + p.y * bounds.height(), paint)
            } else canvas.drawPath(path, paint)
        }
        canvas.restoreToCount(layer)
    }
}
