package cn.edu.nb3.myclass

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import kotlin.math.max
import kotlin.math.min

/**
 * 经典图片查看控件：双指缩放、拖动平移、双击放大/还原。
 *
 * 对外只暴露归一化视口：放大倍数 userScale（1 为完整显示）加上视口中心
 * 在图片中的相对坐标 centerX / centerY（0~1），便于同步到大屏。
 */
class ZoomableImageView(context: Context) : View(context) {

    var onViewportChanged: ((scale: Float, centerX: Float, centerY: Float) -> Unit)? = null

    private val paint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG)
    private var bitmap: Bitmap? = null
    private var fitScale = 1f
    private var fitWidth = 0f
    private var fitHeight = 0f
    private var userScale = 1f
    private var translateX = 0f
    private var translateY = 0f
    private var lastNotifyAt = 0L

    private val scaleDetector = ScaleGestureDetector(context, ScaleListener())
    private val gestureDetector = GestureDetector(context, GestureListener())

    fun setImage(next: Bitmap?) {
        bitmap = next
        resetViewport()
    }

    fun resetViewport() {
        userScale = 1f
        translateX = 0f
        translateY = 0f
        measureFit()
        notifyViewport(force = true)
        invalidate()
    }

    private fun measureFit() {
        val image = bitmap
        val viewWidth = width.toFloat()
        val viewHeight = height.toFloat()
        if (image == null || viewWidth <= 0f || viewHeight <= 0f) {
            fitScale = 1f
            fitWidth = 0f
            fitHeight = 0f
            return
        }
        fitScale = min(viewWidth / image.width, viewHeight / image.height)
        fitWidth = image.width * fitScale
        fitHeight = image.height * fitScale
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        measureFit()
        clampTranslation()
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val image = bitmap ?: return
        canvas.save()
        canvas.translate(width / 2f + translateX, height / 2f + translateY)
        val scale = fitScale * userScale
        canvas.scale(scale, scale)
        canvas.drawBitmap(image, -image.width / 2f, -image.height / 2f, paint)
        canvas.restore()
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        scaleDetector.onTouchEvent(event)
        gestureDetector.onTouchEvent(event)
        val action = event.actionMasked
        if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
            notifyViewport(force = true)
            performClick()
        }
        return true
    }

    override fun performClick(): Boolean {
        super.performClick()
        return true
    }

    private fun clampTranslation() {
        val maxX = max(0f, (fitWidth * userScale - width) / 2f)
        val maxY = max(0f, (fitHeight * userScale - height) / 2f)
        translateX = translateX.coerceIn(-maxX, maxX)
        translateY = translateY.coerceIn(-maxY, maxY)
    }

    private fun notifyViewport(force: Boolean = false) {
        if (fitWidth <= 0f || fitHeight <= 0f) return
        val now = System.currentTimeMillis()
        if (!force && now - lastNotifyAt < NOTIFY_INTERVAL_MS) return
        lastNotifyAt = now
        val centerX = 0.5f - translateX / (fitWidth * userScale)
        val centerY = 0.5f - translateY / (fitHeight * userScale)
        onViewportChanged?.invoke(userScale, centerX, centerY)
    }

    private inner class ScaleListener : ScaleGestureDetector.SimpleOnScaleGestureListener() {
        override fun onScale(detector: ScaleGestureDetector): Boolean {
            val previous = userScale
            val next = (previous * detector.scaleFactor).coerceIn(1f, MAX_SCALE)
            if (next == previous) return true
            val ratio = next / previous
            val focusX = detector.focusX - width / 2f
            val focusY = detector.focusY - height / 2f
            translateX = (translateX - focusX) * ratio + focusX
            translateY = (translateY - focusY) * ratio + focusY
            userScale = next
            clampTranslation()
            notifyViewport()
            invalidate()
            return true
        }
    }

    private inner class GestureListener : GestureDetector.SimpleOnGestureListener() {
        override fun onDown(e: MotionEvent): Boolean = true

        override fun onScroll(
            e1: MotionEvent?,
            e2: MotionEvent,
            distanceX: Float,
            distanceY: Float
        ): Boolean {
            if (e2.pointerCount > 1) return false
            translateX -= distanceX
            translateY -= distanceY
            clampTranslation()
            notifyViewport()
            invalidate()
            return true
        }

        override fun onDoubleTap(e: MotionEvent): Boolean {
            if (userScale > 1.01f) {
                userScale = 1f
                translateX = 0f
                translateY = 0f
            } else {
                userScale = DOUBLE_TAP_SCALE
                clampTranslation()
            }
            notifyViewport(force = true)
            invalidate()
            return true
        }
    }

    companion object {
        private const val MAX_SCALE = 8f
        private const val DOUBLE_TAP_SCALE = 2.5f
        private const val NOTIFY_INTERVAL_MS = 80L
    }
}
