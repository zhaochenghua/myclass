package cn.edu.nb3.myclass

import android.app.Activity
import android.app.Instrumentation
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Paint
import android.graphics.pdf.PdfDocument
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import java.io.ByteArrayOutputStream
import java.io.File

/**
 * Regression for two teacher-facing Android bugs:
 * - a cloud document provider (DS file) fails the first upload because it
 *   reports SIZE=0 / returns an empty stream until its cache is warm;
 * - the pen-width button is missing from tablet landscape toolbars.
 *
 * Runs without a classroom. Requires a tablet-sized landscape display; the
 * upload part uses a fake HTTP client and the test-only FakeCloudProvider.
 */
object CloudAndTabletCheck {
    fun run(test: Instrumentation, holdMs: Long = 0L) {
        val result = Bundle()
        try {
            val app = test.targetContext
            check(app.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE) {
                "Run this check with the device in landscape"
            }
            check(app.resources.configuration.smallestScreenWidthDp >= 600) {
                "Run this check on a tablet-sized display (smallestScreenWidthDp >= 600)"
            }
            uploadFromFakeCloud(test, app, knownSize = false, emptyFirst = true)
            uploadFromFakeCloud(test, app, knownSize = true, emptyFirst = true)
            uploadFromFakeCloud(test, app, knownSize = false, emptyFirst = false)
            checkTabletPenButton(test, app)
            result.putString("stream", "PASS: cloud first-read upload (unknown/known size), tablet pen width on image and PDF toolbars.\n")
            test.sendStatus(0, result)
            if (holdMs > 0) Thread.sleep(holdMs)
            test.finish(Activity.RESULT_OK, result)
        } catch (error: Throwable) {
            result.putString("stream", "FAIL: ${android.util.Log.getStackTraceString(error)}")
            test.finish(Activity.RESULT_CANCELED, result)
        }
    }

    private fun uploadFromFakeCloud(test: Instrumentation, app: Context, knownSize: Boolean, emptyFirst: Boolean) {
        val received = ByteArrayOutputStream()
        val client = CoursewareApi.client.newBuilder().addInterceptor { chain ->
            val buffer = Buffer()
            chain.request().body?.writeTo(buffer)
            val declared = chain.request().body?.contentLength() ?: -1L
            check(declared <= 0L || declared == buffer.size) {
                "Content-Length=$declared but body=${buffer.size} (known=$knownSize, emptyFirst=$emptyFirst)"
            }
            received.write(buffer.readByteArray())
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("OK")
                .body("""{"title":"云端课件","url":"/myclass/public/courseware/fake-cloud.pdf"}"""
                    .toResponseBody("application/json".toMediaType())).build()
        }.build()
        CoursewareApi.upload(app, FakeCloudProvider.uri(knownSize, emptyFirst), "云端课件.pdf",
            "alice-test-token", client) { _, _ -> }
        val body = received.toString(Charsets.ISO_8859_1.name())
        check(body.contains("FAKE-CLOUD-MARKER")) {
            "Upload body lost cloud content (known=$knownSize, emptyFirst=$emptyFirst)"
        }
        check(body.contains("name=\"file\"")) { "Multipart file part missing" }
    }

    private fun checkTabletPenButton(test: Instrumentation, app: Context) {
        val prefs = app.getSharedPreferences("myclass_auth", Context.MODE_PRIVATE)
        prefs.edit().putString("token", "alice-test-token").putString("username", "alice_test").commit()
        val intent = Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val activity = test.startActivitySync(intent) as MainActivity
        test.waitForIdleSync()

        fun button(text: String): Button? = findButton(activity.window.decorView, text)
        fun penWidth(): PenWidthButton? = findPenWidth(activity.window.decorView)
        fun state(): String = "screen=${field(activity, "currentScreen")} " +
            "sub=${field(activity, "coursewareSubScreen")} pdfFailed=${field(activity, "coursewarePdfFailed")} " +
            "buttons=${visibleButtons(activity.window.decorView)}"
        fun await(message: String, condition: () -> Boolean) {
            val deadline = System.currentTimeMillis() + 8000
            while (System.currentTimeMillis() < deadline) {
                var ok = false
                test.runOnMainSync { ok = condition() }
                if (ok) return
                Thread.sleep(100)
            }
            error("$message; ${state()}")
        }

        // Image cast: tablet landscape uses a dedicated bottom pen row.
        test.runOnMainSync {
            activity.onViewerCoursewareOpen("/myclass/public/courseware/tablet-pen.jpg", "平板画笔检查", 1, 1)
        }
        await("Image toolbar missing pen mode button") { button("画笔") != null }
        test.runOnMainSync { button("画笔")!!.performClick() }
        await("Image tablet toolbar missing pen width button") {
            penWidth()?.let { it.isShown && it.width > 0 && it.height > 0 } == true
        }
        val before = PenSettings.index
        test.runOnMainSync { requireNotNull(penWidth()).performClick() }
        test.runOnMainSync { check(PenSettings.index != before) { "Pen width button did not cycle" } }

        // PDF courseware: the separate playback toolbar has its own pen row.
        val source = File(app.cacheDir, "tablet-pen-check.pdf")
        val pdf = PdfDocument()
        try {
            val page = pdf.startPage(PdfDocument.PageInfo.Builder(600, 400, 1).create())
            page.canvas.drawColor(Color.WHITE)
            page.canvas.drawText("TABLET PEN", 60f, 200f, Paint().apply { color = Color.BLACK; textSize = 36f })
            pdf.finishPage(page)
            source.outputStream().use { pdf.writeTo(it) }
        } finally {
            pdf.close()
        }
        val bytes = source.readBytes()
        val pdfClient = (field(activity, "coursewareHttpClient") as OkHttpClient).newBuilder()
            .addInterceptor { chain ->
                Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("OK")
                    .body(bytes.toResponseBody("application/pdf".toMediaType())).build()
            }.build()
        test.runOnMainSync {
            setField(activity, "coursewareHttpClient", pdfClient)
            setField(activity, "coursewarePdfRenderer", null)
            // Enter the PDF page in gesture mode, as a fresh courseware open would.
            setField(activity, "imageCastPenMode", false)
            activity.onViewerCoursewareOpen("/myclass/public/courseware/tablet-pen-check.pdf", "平板画笔检查", 1, 1)
        }
        await("PDF toolbar missing pen mode button") { button("画笔") != null }
        test.runOnMainSync { button("画笔")!!.performClick() }
        await("PDF tablet toolbar missing pen width button") {
            penWidth()?.let { it.isShown && it.width > 0 && it.height > 0 } == true
        }
    }

    private fun findButton(view: View, text: String): Button? {
        if (view is Button && view.isShown && view.text?.toString() == text) return view
        if (view is ViewGroup) for (index in 0 until view.childCount) {
            findButton(view.getChildAt(index), text)?.let { return it }
        }
        return null
    }

    private fun findPenWidth(view: View): PenWidthButton? {
        if (view is PenWidthButton) return view
        if (view is ViewGroup) for (index in 0 until view.childCount) {
            findPenWidth(view.getChildAt(index))?.let { return it }
        }
        return null
    }

    private fun visibleButtons(view: View, out: MutableList<String> = mutableListOf()): List<String> {
        if (view.isShown) {
            if (view is PenWidthButton) out.add("笔画粗细")
            if (view is Button) out.add(view.text?.toString().orEmpty())
        }
        if (view is ViewGroup) for (index in 0 until view.childCount) visibleButtons(view.getChildAt(index), out)
        return out
    }

    private fun field(activity: MainActivity, name: String): Any? =
        MainActivity::class.java.getDeclaredField(name).apply { isAccessible = true }.get(activity)

    private fun setField(activity: MainActivity, name: String, value: Any?) {
        MainActivity::class.java.getDeclaredField(name).apply { isAccessible = true }.set(activity, value)
    }
}
