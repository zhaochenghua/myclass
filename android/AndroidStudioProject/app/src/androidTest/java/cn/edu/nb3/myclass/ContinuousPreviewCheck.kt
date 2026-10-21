package cn.edu.nb3.myclass

import android.app.Activity
import android.app.Instrumentation
import android.content.Context
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.ActivityInfo
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Bundle
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.Button
import android.widget.ImageView
import android.widget.ListView
import okhttp3.Request
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.File

/** Actual management entry, real server metadata/PDF, Android rendering and lifecycle checks. */
object ContinuousPreviewCheck {
    fun run(test: Instrumentation) {
        val result = Bundle()
        try {
            val base = BuildConfig.SERVER_BASE_URL
            check(base.startsWith("http://10.0.2.2:")) { "Use a disposable emulator server" }
            val context = test.targetContext
            val prefs = context.getSharedPreferences("myclass_auth", Context.MODE_PRIVATE)
            check(prefs.getString("username", null)?.endsWith("_test") != false) { "Do not replace a real account" }
            val token = CoursewareApi.client.newCall(Request.Builder().url("$base/api/auth/login")
                .post("""{"username":"alice_test","password":"test1234"}""".toRequestBody("application/json".toMediaType()))
                .build()).execute().use { check(it.isSuccessful); JSONObject(it.body!!.string()).getString("token") }
            prefs.edit().putString("token", token).putString("username", "alice_test").commit()
            val activity = test.startActivitySync(Intent(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
            fun main(block: () -> Unit) {
                var error: Throwable? = null
                test.runOnMainSync { try { block() } catch (failure: Throwable) { error = failure } }
                error?.let { throw it }
            }
            fun await(message: String, condition: () -> Boolean) {
                val end = SystemClock.uptimeMillis() + 20000
                while (SystemClock.uptimeMillis() < end) {
                    var ok = false
                    main { ok = condition() }
                    if (ok) return
                    Thread.sleep(100)
                }
                error(message)
            }
            fun field(owner: Any, name: String): Any? = owner.javaClass.getDeclaredField(name)
                .apply { isAccessible = true }.get(owner)
            fun button(prefix: String, view: View = activity.window.decorView): Button? {
                if (view is Button && view.text.toString().startsWith(prefix)) return view
                if (view is ViewGroup) for (i in 0 until view.childCount) button(prefix, view.getChildAt(i))?.let { return it }
                return null
            }
            fun preview(): Any? = field(activity, "managementPreview")
            fun reader(): ListView = field(preview()!!, "list") as ListView
            fun ready(count: Int) {
                await("Reader not fully rendered") {
                    preview() != null && reader().count == count && reader().childCount >= 1 &&
                        (0 until reader().childCount).all { (reader().getChildAt(it) as ImageView).drawable != null }
                }
            }
            fun capture(phase: String) {
                val marker = File(context.cacheDir, "continuous-$phase.continue")
                marker.delete()
                test.sendStatus(0, Bundle().apply { putString("stream", "$phase\n") })
                val end = SystemClock.uptimeMillis() + 30000
                while (!marker.exists() && SystemClock.uptimeMillis() < end) Thread.sleep(100)
                check(marker.delete()) { "Missing screenshot acknowledgement: $phase" }
            }
            main {
                (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).clearPrimaryClip()
                (field(activity, "clipboardDialog") as? androidx.appcompat.app.AlertDialog)?.dismiss()
                activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
            }
            await("User management entry missing") {
                activity.resources.configuration.orientation == android.content.res.Configuration.ORIENTATION_PORTRAIT &&
                    field(activity, "campusCheckRunning") == false &&
                    field(activity, "currentScreen").toString() == "Connect" && button("用户管理") != null
            }
            check(field(activity, "roomJoined") == false)
            await("User management entry changed during startup") { button("用户管理")?.performClick() == true }
            // Select the same menu item a user taps, through accessibility rather than fixed coordinates.
            val end = SystemClock.uptimeMillis() + 10000
            var selected = false
            while (!selected && SystemClock.uptimeMillis() < end) {
                val nodes = test.uiAutomation.rootInActiveWindow?.findAccessibilityNodeInfosByText("课件管理").orEmpty()
                selected = nodes.any { it.performAction(AccessibilityNodeInfo.ACTION_CLICK) }
                if (!selected) Thread.sleep(100)
            }
            check(selected) { "Courseware management menu missing" }
            await("Fixture missing from actual management list") { button("连续预览动画验证") != null }
            main { button("连续预览动画验证")!!.performClick() }
            ready(8)
            main {
                val list = reader()
                check(list.childCount >= 3) { "Slides do not fill the portrait viewport continuously" }
                check(list.width == activity.resources.displayMetrics.widthPixels) { "Reader retains dialog insets" }
                for (i in 0 until list.childCount) {
                    val image = list.getChildAt(i) as ImageView
                    check(image.width == list.width)
                    check(kotlin.math.abs(image.height - image.width * 9f / 16f) <= 1)
                    val bitmap = (image.drawable as android.graphics.drawable.BitmapDrawable).bitmap
                    check(Color.red(bitmap.getPixel(5, 5)) < 80) { "Intermediate animation state leaked into preview" }
                }
                val pages = field(preview()!!, "pages") as List<*>
                check(pages.map { field(it!!, "pdfIndex") } == (1..15 step 2).toList())
            }
            capture("CONTINUOUS_READY")
            main { reader().scrollListBy(reader().height * 2) }
            await("Continuous scrolling did not reach later pages") { reader().firstVisiblePosition >= 3 }
            ready(8)
            capture("SCROLLED_READY")
            main { activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE }
            await("Landscape did not resize the reader") { reader().width > reader().height }
            ready(8)
            main {
                check((0 until reader().childCount).all { reader().getChildAt(it).width == reader().width })
                (preview() as CoursewarePreviewDialog).dismiss()
            }
            await("Return to management failed") { preview() == null && button("普通PDF验证") != null }
            main { button("普通PDF验证")!!.performClick() }
            ready(3)
            main { (preview() as CoursewarePreviewDialog).dismiss() }
            // Dismiss during download/render, reopen immediately and rotate back to portrait.
            main {
                button("连续预览动画验证")!!.performClick()
                (preview() as CoursewarePreviewDialog).dismiss()
                button("连续预览动画验证")!!.performClick()
                activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
            }
            ready(8)
            main {
                val image = Bitmap.createBitmap(600, 400, Bitmap.Config.ARGB_8888)
                val zoom = ZoomableImageView(activity)
                zoom.layout(0, 0, 600, 1000)
                zoom.setImage(image)
                var taps = 0
                zoom.onPageTap = { taps++ }
                val time = SystemClock.uptimeMillis()
                for (i in 0 until 6) {
                    val down = time + i * 100
                    MotionEvent.obtain(down, down, MotionEvent.ACTION_DOWN, 450f, 500f, 0).let { zoom.onTouchEvent(it); it.recycle() }
                    MotionEvent.obtain(down, down + 20, MotionEvent.ACTION_UP, 450f, 500f, 0).let { zoom.onTouchEvent(it); it.recycle() }
                }
                check(taps == 6) { "Rapid taps lost: $taps / 6" }
                check(field(zoom, "userScale") == 1f) { "Rapid tapping changed zoom" }
                zoom.setImage(null)
                image.recycle()
            }
            check(prefs.getString("token", null) == token)
            result.putString("stream", "PASS: actual user-management entry, final states only (16 -> 8), full-width continuous pages, scrolling, rotation, ordinary PDF, close/reopen during load, six rapid taps without zoom.\n")
            test.finish(Activity.RESULT_OK, result)
        } catch (error: Throwable) {
            result.putString("stream", "FAIL: ${android.util.Log.getStackTraceString(error)}")
            test.finish(Activity.RESULT_CANCELED, result)
        }
    }
}
