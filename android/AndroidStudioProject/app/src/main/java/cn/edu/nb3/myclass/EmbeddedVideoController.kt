package cn.edu.nb3.myclass

import android.app.Activity
import android.net.Uri
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit

internal fun coursewareFilePath(url: String): String = Uri.parse(url).path.orEmpty()

/** Remote controls only: the big screen plays the video without replacing the PDF. */
class EmbeddedVideoController(
    private val activity: Activity,
    private val client: OkHttpClient,
    private val getContext: () -> Context?,
    private val absoluteUrl: (String) -> String?,
    private val send: (String, String, Int?) -> Boolean,
    private val onPages: (String, CoursewarePages) -> Unit
) {
    data class Context(val url: String, val page: Int, val slide: Int)
    private data class Video(val index: Int, val slide: Int, val title: String)
    private var button: Button? = null
    private var context: Context? = null
    private var generation = 0
    private var metadata: JSONObject? = null
    private var warning = ""
    private var loading = false
    private var dialog: AlertDialog? = null
    private var active: Video? = null
    private var activeUrl = ""
    private var pending: JSONObject? = null

    fun attach(view: Button) {
        button = view
        view.visibility = View.GONE
        view.setOnClickListener { launch() }
        refresh()
    }

    private fun videos(): List<Video> {
        val array = metadata?.optJSONArray("videos") ?: return emptyList()
        val current = context ?: return emptyList()
        val conversion = metadata?.optJSONObject("conversion")?.optJSONArray("statePages")
        val slide = conversion?.optInt(current.page - 1, current.slide) ?: current.slide
        return (0 until array.length()).mapNotNull {
            val item = array.optJSONObject(it) ?: return@mapNotNull null
            val index = item.optInt("index", -1)
            if (index !in 0..199 || item.optInt("slide") != slide) null
            else Video(index, slide, item.optString("title", "第 $slide 页视频 ${it + 1}"))
        }
    }

    fun refresh(retry: Boolean = false) {
        val next = getContext()
        val changed = coursewareFilePath(next?.url.orEmpty()) != coursewareFilePath(context?.url.orEmpty())
        if (changed || next?.page != context?.page) close(true)
        context = next
        if (next == null) {
            generation++; metadata = null; warning = ""; loading = false; pending = null
            renderButton(); return
        }
        if (changed || retry) {
            val epoch = ++generation
            metadata = null; warning = ""; loading = true; pending = null
            Thread {
                val result = runCatching {
                    val url = requireNotNull(absoluteUrl(next.url)).toHttpUrl()
                    val endpoint = url.newBuilder().encodedPath(url.encodedPath + ".metadata").setQueryParameter("embedded", "1").build()
                    client.newBuilder().callTimeout(120, TimeUnit.SECONDS).build()
                        .newCall(Request.Builder().url(endpoint).build()).execute().use { response ->
                            check(response.isSuccessful) { "HTTP ${response.code}" }
                            JSONObject(response.body?.string().orEmpty())
                        }
                }
                activity.runOnUiThread {
                    if (epoch != generation || activity.isDestroyed) return@runOnUiThread
                    loading = false
                    metadata = result.getOrNull()
                    warning = metadata?.optString("videoWarning").orEmpty()
                    if (result.isFailure) warning = "视频信息加载失败，请检查网络后重试。课件仍可正常翻页。"
                    val conversion = metadata?.optJSONObject("conversion")
                    CoursewarePages.parse(conversion, conversion?.optJSONArray("statePages")?.length() ?: 0)?.let { onPages(next.url, it) }
                    renderButton()
                    pending?.let { message -> pending = null; receive(message) }
                }
            }.start()
        }
        renderButton()
    }

    private fun renderButton() {
        val count = videos().size
        button?.visibility = if (context != null && (count > 0 || warning.isNotBlank() || loading)) View.VISIBLE else View.GONE
        button?.isEnabled = !loading
        button?.text = when { loading -> "视频加载中"; count > 0 -> "本页视频（$count）"; else -> "视频信息" }
    }

    private fun launch() {
        val items = videos()
        if (items.isEmpty()) {
            dialog = AlertDialog.Builder(activity).setTitle("内嵌视频").setMessage(warning.ifBlank { "当前页没有可播放的视频。" })
                .setPositiveButton("重试") { _, _ -> refresh(true) }.setNegativeButton("关闭", null).show()
        } else if (items.size == 1) start(items.first(), true)
        else dialog = AlertDialog.Builder(activity).setTitle("选择本页视频")
            .setItems(items.map { it.title }.toTypedArray()) { _, which -> start(items[which], true) }
            .setNegativeButton("取消", null).show()
    }

    private fun start(video: Video, notify: Boolean) {
        close(false)
        active = video; activeUrl = context?.url ?: return
        val density = activity.resources.displayMetrics.density
        val controls = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            val padding = (20 * density).toInt(); setPadding(padding, padding, padding, 0)
        }
        val status = TextView(activity).apply {
            text = "正在大屏播放；如大屏提示，请点击大屏视频上的播放按钮。"
        }
        controls.addView(status)
        for ((text, action) in listOf("播放" to "play", "暂停" to "pause", "后退 10 秒" to "back", "前进 10 秒" to "forward")) {
            controls.addView(Button(activity).apply {
                this.text = text
                setOnClickListener { if (!send(action, activeUrl, video.index)) status.text = "尚未连接大屏，请连接后重试。" }
            })
        }
        val scroller = ScrollView(activity).apply { addView(controls) }
        dialog = AlertDialog.Builder(activity).setTitle(video.title).setView(scroller)
            .setPositiveButton("返回课件") { _, _ -> close(true) }
            .setOnCancelListener { close(true) }.show()
        if (notify && !send("open", activeUrl, video.index)) status.text = "尚未连接大屏，请连接后重试。"
    }

    fun receive(message: JSONObject) {
        if (coursewareFilePath(message.optString("url")) != coursewareFilePath(context?.url.orEmpty())) return
        if (message.optString("action") == "close") { pending = null; close(false); return }
        if (message.optString("action") != "open") return
        if (metadata == null) { pending = message; return }
        videos().find { it.index == message.optInt("index", -1) }?.let { start(it, false) }
    }

    private fun close(notify: Boolean) {
        if (notify && active != null) send("close", activeUrl, active?.index)
        active = null; dialog?.dismiss(); dialog = null
    }

    fun detach() { button = null; close(true) }
    fun destroy() { generation++; button = null; close(false) }
}
