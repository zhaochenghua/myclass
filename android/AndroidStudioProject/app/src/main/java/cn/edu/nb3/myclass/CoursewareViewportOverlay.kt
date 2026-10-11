package cn.edu.nb3.myclass

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.view.View

/** 在手机课件预览上标出估算的大屏当前可视区域。 */
class CoursewareViewportOverlay(context: Context) : View(context) {
    private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(42, 255, 193, 7)
        style = Paint.Style.FILL
    }
    private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.rgb(255, 193, 7)
        style = Paint.Style.STROKE
        strokeWidth = resources.displayMetrics.density * 2f
    }
    private var viewport: RectF? = null

    init {
        isClickable = false
        isFocusable = false
    }

    fun setViewport(rect: RectF?) {
        viewport = rect?.let { RectF(it) }
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val rect = viewport ?: return
        canvas.save()
        canvas.clipRect(0f, 0f, width.toFloat(), height.toFloat())
        canvas.drawRect(rect, fillPaint)
        canvas.drawRect(rect, strokePaint)
        canvas.restore()
    }
}
