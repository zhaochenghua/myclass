package cn.edu.nb3.myclass

import android.app.Activity
import android.app.Instrumentation
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.graphics.Color
import android.graphics.Paint
import android.graphics.pdf.PdfDocument
import android.os.Bundle
import android.os.SystemClock
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.ImageView
import android.widget.PopupWindow
import android.widget.SeekBar
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import okhttp3.Request
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.File

/** Exercises the real PDF playback UI, popup touch dispatch and immersive window. */
object QuickPagingCheck {
    fun run(test: Instrumentation) {
        val result = Bundle()
        try {
            val context = test.targetContext
            val base = BuildConfig.SERVER_BASE_URL
            check(base.startsWith("http://10.0.2.2:")) { "Use disposable server" }
            val prefs = context.getSharedPreferences("myclass_auth", Context.MODE_PRIVATE)
            check(prefs.getString("username", null)?.endsWith("_test") != false)
            val token = CoursewareApi.client.newCall(Request.Builder().url("$base/api/auth/login")
                .post("""{"username":"alice_test","password":"test1234"}""".toRequestBody("application/json".toMediaType()))
                .build()).execute().use { check(it.isSuccessful); JSONObject(it.body!!.string()).getString("token") }
            prefs.edit().putString("token", token).putString("username", "alice_test").commit()
            val activity = test.startActivitySync(Intent(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
            fun main(block: () -> Unit) {
                var failure: Throwable? = null
                test.runOnMainSync { try { block() } catch (error: Throwable) { failure = error } }
                failure?.let { throw it }
            }
            fun field(name: String) = MainActivity::class.java.getDeclaredField(name).apply { isAccessible = true }
            fun get(name: String) = field(name).get(activity)
            fun set(name: String, value: Any?) = field(name).set(activity, value)
            fun await(message: String, condition: () -> Boolean) {
                val end = SystemClock.uptimeMillis() + 15000
                while (SystemClock.uptimeMillis() < end) {
                    var ready = false
                    main { ready = condition() }
                    if (ready) return
                    Thread.sleep(80)
                }
                error(message)
            }
            fun descendants(view: View): List<View> = listOf(view) +
                if (view is ViewGroup) (0 until view.childCount).flatMap { descendants(view.getChildAt(it)) } else emptyList()
            fun button(text: String) = descendants(activity.window.decorView).filterIsInstance<Button>()
                .firstOrNull { it.text.toString() == text }
            fun popup() = get("quickPagePopup") as? PopupWindow
            fun barsHidden() = ViewCompat.getRootWindowInsets(activity.window.decorView)?.let {
                !it.isVisible(WindowInsetsCompat.Type.statusBars()) && !it.isVisible(WindowInsetsCompat.Type.navigationBars())
            } == true
            fun capture(phase: String) {
                val marker = File(context.cacheDir, "quick-$phase.continue").apply { delete() }
                test.sendStatus(0, Bundle().apply { putString("stream", "$phase\n") })
                val end = SystemClock.uptimeMillis() + 30000
                while (!marker.exists() && SystemClock.uptimeMillis() < end) Thread.sleep(100)
                check(marker.delete()) { "Screenshot acknowledgement missing" }
            }
            main { activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT }
            await("Startup not ready") { get("campusCheckRunning") == false && get("currentScreen").toString() == "Connect" }
            val file = File(context.cacheDir, "quick-portrait-test.pdf")
            val document = PdfDocument()
            try {
                for (i in 1..9) {
                    val page = document.startPage(PdfDocument.PageInfo.Builder(595, 1684, i).create())
                    page.canvas.drawColor(Color.rgb(25, 110 + i * 10, 180))
                    page.canvas.drawText("PORTRAIT PDF $i", 20f, 140f, Paint().apply { color = Color.WHITE; textSize = 35f })
                    document.finishPage(page)
                }
                file.outputStream().use { document.writeTo(it) }
            } finally { document.close() }
            val pdf = CoursewarePdfRenderer.OpenedPdf(file)
            main {
                set("roomJoined", true)
                set("coursewareUrl", "$base/public/courseware/quick-test.pdf")
                set("coursewareTitle", "竖向PDF快速翻页验证")
                set("coursewarePageCount", 9)
                set("coursewarePage", 1)
                set("coursewarePdf", pdf)
                MainActivity::class.java.getDeclaredMethod("showPdfCastScreen", String::class.java)
                    .apply { isAccessible = true }.invoke(activity, "竖向PDF快速翻页验证")
            }
            await("PDF playback not immersive") { barsHidden() && button("快速翻页") != null }
            for ((orientation, phase) in listOf(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT to "QUICK_PORTRAIT",
                ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE to "QUICK_LANDSCAPE")) {
                main { activity.requestedOrientation = orientation }
                await("Orientation not applied") {
                    (activity.resources.displayMetrics.widthPixels > activity.resources.displayMetrics.heightPixels) ==
                        (orientation == ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE) && button("快速翻页") != null &&
                        activity.hasWindowFocus() && barsHidden()
                }
                main { button("快速翻页")!!.performClick() }
                await("Preview image not rendered") {
                    popup()?.isShowing == true && activity.hasWindowFocus() &&
                        descendants(popup()!!.contentView).filterIsInstance<ImageView>().any { it.drawable != null }
                }
                main {
                    val window = popup()!!
                    val image = descendants(window.contentView).filterIsInstance<ImageView>().single()
                    check(!window.isFocusable && activity.hasWindowFocus()) { "Popup stole immersive window focus" }
                    check(image.height > activity.resources.displayMetrics.heightPixels * .25f) { "Preview too short: ${image.height}" }
                    check(barsHidden()) { "System bars appeared over popup" }
                }
                capture(phase)
                val before = get("coursewarePage")
                main {
                    val slider = descendants(popup()!!.contentView).filterIsInstance<SeekBar>().single()
                    val time = SystemClock.uptimeMillis()
                    val targetX = slider.width * if ((before as Int) > 4) .2f else .8f
                    for ((action, x) in listOf(MotionEvent.ACTION_DOWN to slider.width * .4f, MotionEvent.ACTION_MOVE to targetX)) {
                        MotionEvent.obtain(time, SystemClock.uptimeMillis(), action, x, slider.height / 2f, 0)
                            .let { slider.dispatchTouchEvent(it); it.recycle() }
                    }
                    check(get("coursewarePage") == before) { "Drag changed the cast before release" }
                    MotionEvent.obtain(time, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, targetX, slider.height / 2f, 0)
                        .let { slider.dispatchTouchEvent(it); it.recycle() }
                    check(popup() == null) { "Release did not dismiss preview" }
                    check(get("coursewarePage") != before) { "Release did not select target page" }
                }
                await("System bars appeared after selection") { barsHidden() }
                main { button("快速翻页")!!.performClick(); activity.onBackPressedDispatcher.onBackPressed() }
                check(popup() == null) { "Back did not cancel quick paging" }
                for (i in 0..7) {
                    main {
                        activity.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, if (i % 2 == 0) KeyEvent.KEYCODE_VOLUME_UP else KeyEvent.KEYCODE_VOLUME_DOWN))
                        activity.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, if (i % 2 == 0) KeyEvent.KEYCODE_VOLUME_UP else KeyEvent.KEYCODE_VOLUME_DOWN))
                    }
                    await("System bars appeared while paging") { barsHidden() }
                }
            }
            capture("QUICK_FINISHED")
            result.putString("stream", "PASS: actual portrait PDF playback, adaptive quick preview in both orientations, retained immersive focus, drag defers cast, release selects/dismisses, back cancels, repeated volume paging keeps system bars hidden.\n")
            test.finish(Activity.RESULT_OK, result)
        } catch (error: Throwable) {
            result.putString("stream", "FAIL: ${android.util.Log.getStackTraceString(error)}")
            test.finish(Activity.RESULT_CANCELED, result)
        }
    }
}
