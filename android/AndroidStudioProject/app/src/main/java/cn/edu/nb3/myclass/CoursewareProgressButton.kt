package cn.edu.nb3.myclass

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.util.AttributeSet
import com.google.android.material.button.MaterialButton

/** Button with a subtle playback progress strip along its lower edge. */
class CoursewareProgressButton @JvmOverloads constructor(
    context: Context, attrs: AttributeSet? = null, defStyleAttr: Int = com.google.android.material.R.attr.materialButtonOutlinedStyle
) : MaterialButton(context, attrs, defStyleAttr) {
    var playbackProgress: Int = 0
        set(value) { field = value.coerceIn(0, 100); invalidate() }
    private val progressPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xff4caf50.toInt() }
    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (playbackProgress <= 0) return
        val width = width * playbackProgress / 100f
        val barHeight = resources.displayMetrics.density * 4f
        canvas.drawRect(0f, height - barHeight, width, height.toFloat(), progressPaint)
    }
}
