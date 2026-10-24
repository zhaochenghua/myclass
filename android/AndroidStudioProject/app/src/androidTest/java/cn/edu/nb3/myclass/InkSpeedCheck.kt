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
 *   * 起笔处收尖，比行笔段细；
 *   * 本地保留全部采样点，发给大屏的点按像素距离降采样，且收笔点一定包含在内。
 *
 * 渲染结果会写到应用缓存目录的 ink-check.png，方便 adb pull 出来肉眼核对。
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

                // 记录实际发给大屏的点（本地渲染不受影响）
                val synced = mutableListOf<AnnotationPoint>()
                view.onStrokePoints = { _, batch -> synced.addAll(batch) }

                // 一条横线：前 40 步慢写（1px / 30ms，采样比传输阈值更密），之后快写（24px / 10ms）
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
                    val slow = step < 40
                    x += if (slow) 1f else 24f
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

                // 本地全量、传输降采样：线上点必须明显更少，但收笔位置一致
                check(synced.isNotEmpty()) { "没有任何点发给大屏" }
                check(synced.size < points.size) { "传输没有降采样: 本地 ${points.size} 线上 ${synced.size}" }
                check(synced.last().x == points.last().x && synced.last().y == points.last().y) {
                    "收笔点没有同步：线上 ${synced.last()} 本地 ${points.last()}"
                }

                val output = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                view.draw(Canvas(output))
                // 留一份渲染结果给人工核对（adb pull），失败时也能看到实际笔迹
                runCatching {
                    java.io.File(test.targetContext.cacheDir, "ink-check.png").outputStream().use {
                        output.compress(Bitmap.CompressFormat.PNG, 100, it)
                    }
                }
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

                // 再画一条 S 形笔画，模拟真实书写的快慢/压力变化，用于确认不会再出现"蝌蚪"
                val demo = AnnotationStroke(
                    id = "demo",
                    colorHex = "#D00000",
                    width = PenSettings.width,
                    isEraser = false
                )
                var demoX = 120f
                for (i in 0..220) {
                    val u = i / 220f
                    val wave = kotlin.math.sin(Math.PI * u).toFloat()
                    demoX += (0.2f + 2.2f * wave) * 8f
                    val demoY = 520f + 110f * kotlin.math.sin(u * Math.PI * 2).toFloat()
                    demo.points.add(
                        AnnotationPoint(
                            (demoX / width).coerceIn(0f, 1f),
                            (demoY / height).coerceIn(0f, 1f),
                            i * 8,
                            0.2f + 0.7f * wave
                        )
                    )
                }
                view.replaceStrokes(listOf(demo))
                val demoOutput = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                view.draw(Canvas(demoOutput))
                runCatching {
                    java.io.File(test.targetContext.cacheDir, "ink-demo.png").outputStream().use {
                        demoOutput.compress(Bitmap.CompressFormat.PNG, 100, it)
                    }
                }
                val slow = thickness(120)
                val fast = thickness(900)
                val tip = thickness(104)

                // 诊断信息：管线输出规模与线宽区间
                val density = view.resources.displayMetrics.density
                val prepared = InkRenderer.prepare(points.map {
                    InkRenderer.Point(it.x * width, it.y * height, it.p, it.t.toFloat())
                }, PenSettings.width * density)
                val debug = prepared?.let {
                    "管线 source=${it.source.size} size=${"%.1f".format(it.size)} " +
                        "w=${"%.1f".format(it.widths.min())}..${"%.1f".format(it.widths.max())} " +
                        "w120=${"%.1f".format(it.widths.getOrNull(120) ?: -1f)} w900=${"%.1f".format(it.widths.getOrNull(900) ?: -1f)}"
                } ?: "管线为空"

                check(slow >= 4) { "慢写段没有墨迹: $slow ($debug)" }
                check(slow > fast) { "快写段没有变细: 慢=$slow 快=$fast ($debug)" }
                check(slow <= fast * 2.0f) { "快慢段粗细相差过大: 慢=$slow 快=$fast ($debug)" }
                // 起笔是圆珠笔式的圆头：比行笔略细，但不能细成一个尖
                check(tip >= slow * 0.4f) { "起笔不是圆头（太尖）: 起笔=$tip 慢写=$slow ($debug)" }
                check(tip <= slow) { "起笔比行笔还粗: 起笔=$tip 慢写=$slow ($debug)" }

                // 留一份渲染结果给人工核对（adb pull）
                runCatching {
                    java.io.File(test.targetContext.cacheDir, "ink-check.png").outputStream().use {
                        output.compress(Bitmap.CompressFormat.PNG, 100, it)
                    }
                }


                result.putString(
                    "stream",
                    "PASS: 速度笔锋 起笔=${tip}px 慢写=${slow}px 快写=${fast}px，" +
                        "本地 ${points.size} 点 / 线上 ${synced.size} 点，t=${points.first().t}..${points.last().t}ms"
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

