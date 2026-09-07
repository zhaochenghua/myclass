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
 * 经典图片查看控件：双指缩放、拖动平移、双击放大/还原、90° 步进旋转。
 *
 * 对外只暴露归一化视口：放大倍数 userScale（1 为完整显示）加上视口中心
 * 在图片中的相对坐标 centerX / centerY（0~1）以及旋转角度，便于同步到大屏。
 * 旋转后 centerX / centerY 是**旋转后画面**中的相对坐标，大屏端按同一约定换算。
 */
class ZoomableImageView(context: Context) : View(context) {

    var onViewportChanged: ((scale: Float, centerX: Float, centerY: Float, rotationDegrees: Int) -> Unit)? = null

    /** 当前旋转角度（0 / 90 / 180 / 270），用于修正拍照方向不对的图片 */
    var rotationDegrees: Int = 0
        private set

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
        // 换图瞬间控件可能尚未完成布局，fit 为 0 会跳过上报；
        // 等一帧再补发一次，确保大屏拿到当前旋转角度（避免手机端已旋转、大屏仍是 0°）
        post {
            measureFit()
            notifyViewport(force = true)
        }
    }

    fun resetViewport() {
        userScale = 1f
        translateX = 0f
        translateY = 0f
        measureFit()
        notifyViewport(force = true)
        invalidate()
    }

    /**
     * 顺时针旋转 90°（可指定步长）。旋转后重新按旋转后的画面尺寸适应屏幕，
     * 并复位缩放/平移，保证大屏与手机端看到同一区域。
     * @return 旋转后的角度（0 / 90 / 180 / 270）
     */
    fun rotateBy(stepDegrees: Int = 90): Int {
        rotationDegrees = normalizeRotation(rotationDegrees + stepDegrees)
        userScale = 1f
        translateX = 0f
        translateY = 0f
        measureFit()
        notifyViewport(force = true)
        invalidate()
        return rotationDegrees
    }

    private fun normalizeRotation(degrees: Int): Int {
        val modulo = ((degrees % 360) + 360) % 360
        return (modulo / 90) * 90
    }

    /** 旋转 90/270 后画面的宽高互换，适应屏幕时要按互换后的尺寸计算 */
    private fun rotatedSize(image: Bitmap): Pair<Int, Int> =
        if (rotationDegrees == 90 || rotationDegrees == 270) {
            image.height to image.width
        } else {
            image.width to image.height
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
        val (imageWidth, imageHeight) = rotatedSize(image)
        fitScale = min(viewWidth / imageWidth, viewHeight / imageHeight)
        fitWidth = imageWidth * fitScale
        fitHeight = imageHeight * fitScale
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
        if (rotationDegrees != 0) {
            canvas.rotate(rotationDegrees.toFloat())
        }
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
        onViewportChanged?.invoke(userScale, centerX, centerY, rotationDegrees)
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
