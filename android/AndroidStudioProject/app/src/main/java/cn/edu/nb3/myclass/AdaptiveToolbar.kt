package cn.edu.nb3.myclass

import android.content.Context
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import com.google.android.material.button.MaterialButton
import kotlin.math.ceil
import kotlin.math.max

/** Reflows whole controls, including invisible video slots, without clipping labels. */
class AdaptiveToolbar(context: Context, source: LinearLayout) : LinearLayout(context) {
    private val controls = (0 until source.childCount).map { source.getChildAt(it) }
    private fun dp(value: Int) = (value * resources.displayMetrics.density + .5f).toInt()
    private val widths = controls.map { view ->
        val text = view as? TextView
        val label = when {
            view is EditText -> "页码"
            text != null -> text.text.toString()
            else -> ""
        }
        val paint = android.graphics.Paint(text?.paint).apply {
            textSize = 14 * resources.displayMetrics.scaledDensity
        }
        val icon = (view as? MaterialButton)?.let { if (it.icon != null) dp(24) else 0 } ?: 0
        max(dp(if (view is EditText) 64 else 76), ceil(paint.measureText(label)).toInt() + icon +
            max(dp(24), view.paddingLeft + view.paddingRight))
    }
    private var arrangedWidth = -1

    init {
        orientation = VERTICAL
        layoutParams = LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        setPadding(dp(8), dp(2), dp(8), dp(2))
        source.removeAllViews()
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val available = (View.MeasureSpec.getSize(widthMeasureSpec) - paddingLeft - paddingRight).coerceAtLeast(1)
        if (available != arrangedWidth) {
            arrangedWidth = available
            controls.forEach { (it.parent as? ViewGroup)?.removeView(it) }
            removeAllViews()
            var row: LinearLayout? = null
            var used = 0
            controls.forEachIndexed { index, view ->
                val needed = widths[index].coerceAtMost(available)
                if (row == null || used + dp(4) + needed > available) {
                    row = LinearLayout(context).apply { orientation = HORIZONTAL }
                    addView(row, LayoutParams(LayoutParams.MATCH_PARENT, dp(48)))
                    used = 0
                }
                val gap = if (used == 0) 0 else dp(4)
                row!!.addView(view, LayoutParams(needed, dp(44), needed.toFloat()).apply { marginStart = gap })
                used += gap + needed
            }
        }
        super.onMeasure(widthMeasureSpec, heightMeasureSpec)
    }
}
