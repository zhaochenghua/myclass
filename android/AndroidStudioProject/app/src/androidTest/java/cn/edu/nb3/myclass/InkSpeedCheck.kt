package cn.edu.nb3.myclass

import android.app.Activity
import android.app.Instrumentation
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.os.Bundle
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View

/**
 * 速度笔锋的机上校验（不需要服务器）：
 *   * 每个采样点都带单调递增的相对时间戳 t；
 *   * 慢写段明显比快写段粗；
 *   * 起笔处收尖，比行笔段细。
 */
object InkSpeedCheck {
    fun run(test: Instrumentation) {
        val result = Bundle()
        var failure: Throwable? = null
        test.runOnMainSync {
            try {
                val themed = android.view.ContextThemeWrapper(test.targetContext, R.style.Theme_MyClass)
                val width = 1200
                val height = 800
                val view = ZoomableImageView(themed)
                view.measure(
                    View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY)
                )
                view.layout(0, 0, width, height)
                val image = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                image.eraseColor(Color.WHITE)
                view.setImage(image)
                view.mode = ImageCastMode.Pen

                // 一条横线：前 30 步慢写（4px / 30ms），之后快写（24px / 10ms）
                val downTime = SystemClock.uptimeMillis()
                var time = downTime
                var x = 100f
                val y = height / 2f
                fun send(action: Int, at: Long, px: Float) {
                    val event = MotionEvent.obtain(downTime, at, action, px, y, 0)
                    view.dispatchTouchEvent(event)
                    event.recycle()
                }
                send(MotionEvent.ACTION_DOWN, time, x)
                var step = 0
                while (x < width - 150f) {
                    val slow = step < 30
                    x += if (slow) 4f else 24f
                    time += if (slow) 30L else 10L
                    send(MotionEvent.ACTION_MOVE, time, x)
                    step++
                }
                send(MotionEvent.ACTION_UP, time + 16L, x)

                val strokes = view.currentStrokes()
                check(strokes.size == 1) { "笔画数量异常: ${strokes.size}" }
                val points = strokes[0].points
                check(points.size > 40) { "采样点太少: ${points.size}" }
                check(points.first().t == 0) { "首点时间戳应为 0，实际 ${points.first().t}" }
                check(points.last().t >= 300) { "时间戳没有累积: ${points.last().t}" }
                for (i in 1 until points.size) {
                    check(points[i].t >= points[i - 1].t) { "时间戳非单调 @$i" }
                }

                val output = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                view.draw(Canvas(output))
                fun thickness(px: Int): Int {
                    var best = 0
                    var run = 0
                    for (py in (y.toInt() - 80)..(y.toInt() + 80)) {
                        val color = output.getPixel(px, py)
                        val ink = Color.red(color) > 150 && Color.green(color) < 120
                        run = if (ink) run + 1 else 0
                        if (run > best) best = run
                    }
                    return best
                }

                val slow = thickness(200)
                val fast = thickness(900)
                val tip = thickness(104)
                check(slow >= 4) { "慢写段没有墨迹: $slow" }
                check(slow > fast * 1.3) { "快写段没有变细: 慢=$slow 快=$fast" }
                check(tip < slow) { "起笔没有收尖: 起笔=$tip 慢写=$slow" }

                result.putString(
                    "stream",
                    "PASS: 速度笔锋 起笔=${tip}px 慢写=${slow}px 快写=${fast}px，共 ${points.size} 点，t=${points.first().t}..${points.last().t}ms"
                )
            } catch (error: Throwable) {
                failure = error
            }
        }
        if (failure != null) {
            result.putString("stream", "FAIL: ${android.util.Log.getStackTraceString(failure)}")
        }
        test.finish(if (failure == null) Activity.RESULT_OK else Activity.RESULT_CANCELED, result)
    }
}
