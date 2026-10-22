package cn.edu.nb3.myclass

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.view.View

/**
 * 笔画粗细按钮：三条不同粗细的横线，当前档位实心、其余淡化。
 * 用图标而不是文字，避免把手机底部的画笔工具栏挤换行。
 */
class PenWidthButton(context: Context) : View(context) {
    var level: Int = PenSettings.index
        set(value) {
            field = value.coerceIn(0, PenSettings.WIDTHS.lastIndex)
            invalidate()
        }

    var onCycle: (() -> Unit)? = null

    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        color = Color.WHITE
    }

    init {
        isClickable = true
        isFocusable = true
        contentDescription = "笔画粗细"
        setOnClickListener { onCycle?.invoke() }
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0f || h <= 0f) return
        val startX = w * 0.3f
        val endX = w * 0.7f
        val ys = floatArrayOf(h * 0.3f, h * 0.5f, h * 0.7f)
        val strokes = floatArrayOf(1.5f, 3.2f, 5.5f)
        for (i in 0..2) {
            paint.alpha = if (i == level) 255 else 70
            paint.strokeWidth = strokes[i] * resources.displayMetrics.density
            canvas.drawLine(startX, ys[i], endX, ys[i], paint)
        }
    }
}
