package cn.edu.nb3.myclass

import android.app.Activity
import android.app.Instrumentation
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Paint
import android.graphics.pdf.PdfDocument
import android.net.Uri
import android.os.Bundle
import java.io.File
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okhttp3.MediaType.Companion.toMediaType
import java.util.concurrent.atomic.AtomicInteger

/** Uses a disposable server and the real Android PDF renderer/view. */
object PdfPreviewCheck {
    fun run(test: Instrumentation, holdMs: Long = 0L) {
        val result = Bundle()
        try {
            check(BuildConfig.SERVER_BASE_URL == "http://10.0.2.2:3107/myclass")
            val app = test.targetContext
            val prefs = app.getSharedPreferences("myclass_auth", Context.MODE_PRIVATE)
            check(prefs.getString("username", null)?.endsWith("_test") != false)
            prefs.edit().putString("token", "alice-test-token").putString("username", "alice_test").commit()
            val source = File(app.cacheDir, "preview-check.pdf")
            val pdf = PdfDocument()
            try {
                for (number in 1..2) {
                    val page = pdf.startPage(PdfDocument.PageInfo.Builder(600, 400, number).create())
                    page.canvas.drawColor(if (number == 1) Color.rgb(26, 125, 210) else Color.rgb(30, 170, 90))
                    page.canvas.drawText("PREVIEW PAGE $number", 60f, 220f, Paint().apply { color = Color.WHITE; textSize = 36f })
                    pdf.finishPage(page)
                }
                source.outputStream().use { pdf.writeTo(it) }
            } finally { pdf.close() }
            val item = CoursewareApi.upload(app, Uri.fromFile(source), "预览恢复验证.pdf", "alice-test-token")
            val url = item.getString("url")
            val key = url.substringAfterLast('/').substringBeforeLast('.')
            val cache = File(app.cacheDir, "courseware-pdf/$key.pdf")
            cache.parentFile!!.mkdirs()
            cache.writeText("interrupted or invalid cached PDF")
            val activity = test.startActivitySync(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
            fun main(block: () -> Unit) = test.runOnMainSync(block)
            fun field(name: String): Any? = MainActivity::class.java.getDeclaredField(name).apply { isAccessible = true }.get(activity)
            fun button(text: String, view: View = activity.window.decorView): Button? {
                if (view is Button && view.text.toString() == text) return view
                if (view is ViewGroup) for (i in 0 until view.childCount) button(text, view.getChildAt(i))?.let { return it }
                return null
            }
            fun await(message: String, condition: () -> Boolean) {
                val deadline = System.currentTimeMillis() + 15000
                while (System.currentTimeMillis() < deadline) {
                    var ok = false
                    main { ok = condition() }
                    if (ok) return
                    Thread.sleep(100)
                }
                error(message)
            }
            main { activity.onViewerCoursewareOpen(url, "预览恢复验证", 1, 1) }
            await("Corrupt cache hides phone preview instead of recovering") {
                val view = field("zoomableImageView") as? ZoomableImageView
                view != null && view.isShown && (field("coursewarePdfBitmaps") as Map<*, *>).containsKey(1) && field("coursewarePdfFailed") == false
            }
            main { (field("coursewarePdfPaging") as (Int) -> Unit)(1) }
            await("Page 2 not rendered") { (field("coursewarePdfBitmaps") as Map<*, *>).containsKey(2) }
            // Fail a different document once, then recover through the visible retry button.
            val attempts = AtomicInteger()
            val retryUrl = "/myclass/public/courseware/retry-${System.nanoTime()}.pdf"
            val retryClient = (field("coursewareHttpClient") as OkHttpClient).newBuilder().addInterceptor { chain ->
                if (chain.request().url.encodedPath == retryUrl) {
                    val fail = attempts.getAndIncrement() == 0
                    Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1)
                        .code(if (fail) 503 else 200).message("test")
                        .body((if (fail) byteArrayOf() else source.readBytes()).toResponseBody("application/pdf".toMediaType())).build()
                } else chain.proceed(chain.request())
            }.build()
            main {
                MainActivity::class.java.getDeclaredField("coursewareHttpClient").apply { isAccessible = true }.set(activity, retryClient)
                MainActivity::class.java.getDeclaredField("coursewarePdfRenderer").apply { isAccessible = true }.set(activity, null)
                activity.onViewerCoursewareOpen(retryUrl, "预览恢复验证", 1, 1)
            }
            await("Missing preview retry button") { field("coursewarePdfFailed") == true && button("重新加载预览")?.isShown == true }
            main { button("重新加载预览")!!.performClick() }
            await("Retry did not recover preview") { field("coursewarePdfFailed") == false && (field("coursewarePdfBitmaps") as Map<*, *>).containsKey(1) }
            check(attempts.get() == 2) { "Retry loop or missing request" }
            // A failed file must not hide the preview of a subsequent valid file.
            main { activity.onViewerCoursewareOpen("/myclass/public/courseware/missing.pdf", "缺失文件", 1, 1) }
            await("Missing file did not fail") { field("coursewarePdfFailed") == true }
            main { activity.onViewerCoursewareOpen(url, "预览恢复验证", 2, 1) }
            await("Failure leaked to next file") { field("coursewarePdfFailed") == false && (field("coursewarePdfBitmaps") as Map<*, *>).containsKey(2) }
            // Rebuild the preview while remaining on the same file (rotation/menu return path).
            main { activity.onViewerCoursewareOpen(url, "预览恢复验证", 1, 1) }
            await("Rebuilt view lost image") {
                val view = field("zoomableImageView") as? ZoomableImageView
                view != null && view.isShown && view.width > 0 && (field("coursewarePdfBitmaps") as Map<*, *>).containsKey(1)
            }
            result.putString("stream", "PASS: damaged-cache recovery, real PDF render/flip, visible retry after HTTP 503, switch from failed file, same-file view rebuild.\n")
            test.sendStatus(0, result)
            if (holdMs > 0) Thread.sleep(holdMs)
            test.finish(Activity.RESULT_OK, result)
        } catch (error: Throwable) {
            result.putString("stream", "FAIL: ${android.util.Log.getStackTraceString(error)}")
            test.finish(Activity.RESULT_CANCELED, result)
        }
    }
}
