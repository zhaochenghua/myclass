package cn.edu.nb3.myclass

import android.app.Activity
import android.app.Instrumentation
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import androidx.appcompat.app.AlertDialog
import org.json.JSONObject
import java.io.File

/** Real Android views + WebSocket + persisted server journal, using disposable fixtures only. */
object NotesVideosCheck {
    fun run(test: Instrumentation, room: String) {
        val result = Bundle()
        try {
            check(BuildConfig.SERVER_BASE_URL == "http://10.0.2.2:3107/myclass")
            val app = test.targetContext
            val prefs = app.getSharedPreferences("myclass_auth", Context.MODE_PRIVATE)
            check(prefs.getString("username", null)?.endsWith("_test") != false)
            prefs.edit().putString("token", "alice-test-token").putString("username", "alice_test").commit()
            val activity = test.startActivitySync(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
            fun main(block: () -> Unit) = test.runOnMainSync(block)
            fun field(name: String): Any? = MainActivity::class.java.getDeclaredField(name).apply { isAccessible = true }.get(activity)
            fun set(name: String, value: Any?) = MainActivity::class.java.getDeclaredField(name).apply { isAccessible = true }.set(activity, value)
            fun call(name: String) = MainActivity::class.java.getDeclaredMethod(name).apply { isAccessible = true }.invoke(activity)
            fun button(text: String, view: View = activity.window.decorView): Button? {
                if (view is Button && view.text.toString() == text && view.isShown) return view
                if (view is ViewGroup) for (i in 0 until view.childCount) button(text, view.getChildAt(i))?.let { return it }
                return null
            }
            fun await(message: String, condition: () -> Boolean) {
                val deadline = System.currentTimeMillis() + 20000
                while (System.currentTimeMillis() < deadline) {
                    var ok = false; main { ok = condition() }; if (ok) return
                    Thread.sleep(100)
                }
                error(message)
            }
            fun evidence(phase: String) {
                val gate = File(app.cacheDir, "parity-$phase.continue")
                gate.delete()
                test.sendStatus(0, Bundle().apply { putString("stream", "$phase\n") })
                val deadline = System.currentTimeMillis() + 30000
                while (!gate.exists() && System.currentTimeMillis() < deadline) Thread.sleep(100)
                check(gate.exists()) { "UI evidence was not captured: $phase" }
                gate.delete()
            }
            fun view() = field("zoomableImageView") as? ZoomableImageView
            fun notes(page: Int) = (field("coursewarePdfStrokes") as Map<*, *>)[page] as? List<*>
            fun signal() = field("signalingClient") as SignalingClient
            val pdf = "/myclass/public/courseware/android-features.pdf"
            val image = "/myclass/public/courseware/android-image.png"
            fun open(url: String, page: Int = 1) {
                main { activity.onViewerCoursewareOpen(url, "安卓适配验证", page, 1); signal().sendCoursewareOpen(url, "安卓适配验证", page) }
            }
            main {
                set("classPickerRoom", room); set("studentSelectionConfirmed", true)
                MainActivity::class.java.getDeclaredMethod("connectToRoom", String::class.java, Boolean::class.javaPrimitiveType, Boolean::class.javaPrimitiveType)
                    .apply { isAccessible = true }.invoke(activity, room, false, false)
            }
            await("Android did not join real classroom WebSocket") { field("roomJoined") == true }
            open(pdf)
            await("Saved page 1 ink not restored after PDF download") { view()?.annotationCount == 1 && notes(3)?.size == 1 && (field("coursewarePdfBitmaps") as Map<*, *>).containsKey(1) }
            main {
                val stroke = view()!!.currentStrokes().single()
                check(stroke.mode == "highlighter" && stroke.lineMode && stroke.points.size == 2)
                activity.onAnnotationsSnapshot(JSONObject("""{"url":"/myclass/public/courseware/wrong.pdf","strokes":[]}"""))
                check(view()!!.annotationCount == 1) { "Stale file snapshot cleared the current file" }
            }
            await("Missing embedded video entry") { button("本页视频（2）") != null }
            evidence("NOTES_READY")
            main { activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE }
            await("Landscape rebuild lost notes/video controls") { activity.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE && view()?.annotationCount == 1 && button("本页视频（2）") != null }
            evidence("LANDSCAPE_READY")
            main { activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT }
            await("Portrait rebuild lost notes") { activity.resources.configuration.orientation == Configuration.ORIENTATION_PORTRAIT && view()?.annotationCount == 1 }
            main { (field("coursewarePdfPaging") as (Int) -> Unit)(1) }
            await("Expanded slide state lost video mapping") { field("coursewarePage") == 2 && button("本页视频（2）") != null && (field("coursewarePdfBitmaps") as Map<*, *>).containsKey(2) }
            main { (field("coursewarePdfPaging") as (Int) -> Unit)(1) }
            await("Page 3 saved notes missing") { field("coursewarePage") == 3 && view()?.annotationCount == 1 && button("本页视频（2）") == null }
            main { activity.onViewerCoursewareOpen(pdf, "安卓适配验证", 3, 1) }
            await("Same-file UI rebuild lost saved notes") { view()?.annotationCount == 1 && (field("coursewarePdfBitmaps") as Map<*, *>).containsKey(3) }
            open(image)
            await("Image saved notes missing") { view()?.annotationCount == 1 && field("castImageBitmap") != null }
            main { activity.onViewerCoursewareOpen(image, "安卓适配验证", 1, 1) }
            await("Reopening image erased saved notes") { view()?.annotationCount == 1 }
            main {
                button("画笔")!!.performClick()
                button("清空")!!.performClick()
            }
            await("Explicit clear did not change local notes") { view()?.annotationCount == 0 }
            open(image)
            await("Cleared image ink returned from server") { view()?.annotationCount == 0 && notes(1).orEmpty().isEmpty() }
            open(pdf)
            await("Returning to PDF lost saved notes") { view()?.annotationCount == 1 && button("本页视频（2）") != null }
            val controller = call("getEmbeddedVideos") as EmbeddedVideoController
            fun dialog(): AlertDialog? = EmbeddedVideoController::class.java.getDeclaredField("dialog").apply { isAccessible = true }.get(controller) as? AlertDialog
            main { button("本页视频（2）")!!.performClick() }
            await("Missing multiple-video chooser") { dialog()?.listView?.count == 2 }
            main { dialog()!!.listView.performItemClick(null, 0, 0) }
            await("Missing embedded video playback controls") { dialog()?.window?.decorView?.let { button("暂停", it) } != null }
            evidence("VIDEO_READY")
            main {
                val root = dialog()!!.window!!.decorView
                button("暂停", root)!!.performClick(); button("播放", root)!!.performClick()
                button("前进 10 秒", root)!!.performClick(); button("后退 10 秒", root)!!.performClick()
                button("返回课件", root)!!.performClick()
                check(field("coursewarePage") == 1 && view()!!.annotationCount == 1)
            }
            // Reopen through the real server after ending the presentation.
            main { signal().sendCoursewareClose(); call("pauseCoursewareAndReturnMenu") }
            open(pdf, 3)
            await("Closing and reopening did not restore server notes") { field("coursewarePage") == 3 && view()?.annotationCount == 1 }
            result.putString("stream", "PASS: server note snapshots before render, image/PDF reopen, page isolation, style, explicit clear persistence, stale-file protection, expanded-slide videos, chooser and remote playback controls.\n")
            test.finish(Activity.RESULT_OK, result)
        } catch (error: Throwable) {
            result.putString("stream", "FAIL: ${android.util.Log.getStackTraceString(error)}")
            test.finish(Activity.RESULT_CANCELED, result)
        }
    }
}
