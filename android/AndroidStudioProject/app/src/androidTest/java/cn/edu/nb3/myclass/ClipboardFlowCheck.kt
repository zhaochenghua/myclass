package cn.edu.nb3.myclass

import android.app.Activity
import android.app.Instrumentation
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.widget.EditText
import androidx.appcompat.app.AlertDialog
import okhttp3.Request
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/** Exercises real Activity focus, clipboard access, naming UI and durable uploads. */
object ClipboardFlowCheck {
    fun run(test: Instrumentation) {
        val result = Bundle()
        try {
            check(BuildConfig.SERVER_BASE_URL == "http://10.0.2.2:3107/myclass")
            val app = test.targetContext
            // Read-only verification may safely retry an expired keep-alive socket.
            val lookupClient = CoursewareApi.client.newBuilder().retryOnConnectionFailure(true).build()
            val prefs = app.getSharedPreferences("myclass_auth", Context.MODE_PRIVATE)
            check(prefs.getString("username", null)?.endsWith("_test") != false)
            val token = CoursewareApi.client.newCall(Request.Builder().url("${BuildConfig.SERVER_BASE_URL}/api/auth/login")
                .post("""{"username":"alice_test","password":"test1234"}""".toRequestBody("application/json".toMediaTypeOrNull())).build())
                .execute().use { check(it.isSuccessful); JSONObject(it.body!!.string()).getString("token") }
            prefs.edit().putString("token", token).putString("username", "alice_test").commit()
            val activity = test.startActivitySync(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
            fun await(message: String, condition: () -> Boolean) {
                val end = System.currentTimeMillis() + 15000
                while (System.currentTimeMillis() < end) { if (condition()) return; Thread.sleep(100) }
                error(message)
            }
            fun main(block: () -> Unit) = test.runOnMainSync(block)
            fun dialog(): AlertDialog? {
                var value: AlertDialog? = null
                main { value = MainActivity::class.java.getDeclaredField("clipboardDialog").apply { isAccessible = true }.get(activity) as? AlertDialog }
                return value
            }
            fun textInput(d: AlertDialog): EditText {
                fun find(view: android.view.View): EditText? {
                    if (view is EditText) return view
                    if (view is android.view.ViewGroup) for (i in 0 until view.childCount) find(view.getChildAt(i))?.let { return it }
                    return null
                }
                return find(d.window!!.decorView) ?: error("Missing name input")
            }
            fun resumeClipboard(text: String) {
                await("Activity not focused") { activity.hasWindowFocus() }
                main {
                    (activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("分享链接", text))
                    app.startActivity(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                }
                Thread.sleep(400)
                main { app.startActivity(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)) }
            }
            await("Login did not reach connection screen") {
                var ready = false
                main { ready = MainActivity::class.java.getDeclaredField("currentScreen").apply { isAccessible = true }.get(activity).toString() == "Connect" }
                ready && activity.hasWindowFocus()
            }
            check(ClipboardLink.parse("【测试课程-哔哩哔哩】 https://b23.tv/abc")?.title == "测试课程")
            check(ClipboardLink.parse("课程名称\nhttps://example.com/a")?.title == "课程名称")
            check(ClipboardLink.parse("https://example.com/a")?.title == "")
            check(ClipboardLink.parse("普通文字") == null)
            check(ClipboardLink.parse("https://") == null)
            check(ClipboardLink.parse("【" + "长".repeat(80) + "】 https://example.com")?.title?.length == 50)
            val suffix = System.currentTimeMillis()
            val url = "https://example.com/clipboard-$suffix"
            resumeClipboard("【启动导入课程-哔哩哔哩】 $url")
            await("Startup clipboard prompt missing") { dialog()?.isShowing == true }
            val prompt = dialog()!!
            main {
                check(textInput(prompt).text.toString() == "启动导入课程")
                check(MainActivity::class.java.getDeclaredField("roomJoined").apply { isAccessible = true }.getBoolean(activity).not())
                textInput(prompt).setText("")
                prompt.getButton(AlertDialog.BUTTON_POSITIVE).performClick()
                check(prompt.isShowing && textInput(prompt).error != null)
                textInput(prompt).setText("我的链接课程")
                prompt.getButton(AlertDialog.BUTTON_POSITIVE).performClick()
            }
            await("Link not uploaded without classroom") {
                runCatching { CoursewareApi.linkExists(url, token, lookupClient) }.getOrDefault(false)
            }
            val items = lookupClient.newCall(Request.Builder().url("${BuildConfig.SERVER_BASE_URL}/api/courseware")
                .header("Authorization", "Bearer $token").build()).execute().use { JSONObject(it.body!!.string()).getJSONArray("items") }
            check((0 until items.length()).any { items.getJSONObject(it).optString("linkUrl") == url && items.getJSONObject(it).optString("title") == "我的链接课程" })
            resumeClipboard("再次复制 $url")
            Thread.sleep(1500); check(dialog() == null) { "Saved link prompted again" }
            resumeClipboard("取消课程 https://example.com/cancel-$suffix")
            await("Cancel prompt missing") { dialog()?.isShowing == true }
            val cancelled = dialog()!!
            main { cancelled.getButton(AlertDialog.BUTTON_NEGATIVE).performClick() }
            await("Cancel did not dismiss") { dialog() == null && activity.hasWindowFocus() }
            main { activity.onWindowFocusChanged(true) }
            Thread.sleep(700); check(dialog() == null) { "Cancelled clipboard repeated" }
            check(!CoursewareApi.linkExists("https://example.com/cancel-$suffix", token, lookupClient))
            resumeClipboard("普通文本，没有链接")
            Thread.sleep(500); check(dialog() == null)
            // Leave a real unsaved, named prompt for ui.ps1 and screenshot evidence.
            resumeClipboard("【课前备课示例-哔哩哔哩】 https://example.com/preview-$suffix")
            await("Final preview missing") { dialog()?.isShowing == true }
            result.putString("stream", "PASS: foreground clipboard before classroom; title parsing; empty-name validation; named durable upload; saved-link suppression; cancellation; ordinary text ignored.\n")
            test.finish(Activity.RESULT_OK, result)
        } catch (error: Throwable) {
            result.putString("stream", "FAIL: ${android.util.Log.getStackTraceString(error)}")
            test.finish(Activity.RESULT_CANCELED, result)
        }
    }
}
