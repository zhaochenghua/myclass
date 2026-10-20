package cn.edu.nb3.myclass.tv

import android.app.Activity
import android.app.AlertDialog
import android.graphics.Color
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.widget.*
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Keeps the PDF surface and its annotations intact underneath video playback. */
class TvEmbeddedVideos(
    private val activity: Activity,
    root: FrameLayout,
    http: OkHttpClient,
    private val safeUrl: (String) -> String,
    private val send: (JSONObject) -> Unit,
    private val available: (Boolean) -> Unit
) {
    private data class Clip(val index: Int, val slide: Int, val title: String, val url: String)
    private val main = Handler(Looper.getMainLooper())
    private val client = http.newBuilder().callTimeout(120, TimeUnit.SECONDS).build()
    private val overlay = FrameLayout(activity).apply { setBackgroundColor(Color.BLACK); visibility = View.GONE }
    private val video = VideoView(activity)
    private val status = TextView(activity).apply {
        setTextColor(Color.WHITE); textSize = 18f; gravity = Gravity.CENTER; maxLines = 2
    }
    private val toggle: ImageButton
    private val retry: ImageButton
    private var picker: AlertDialog? = null
    private var call: Call? = null
    private var generation = 0
    private var document = ""
    private var page = 1
    private var statePages = emptyList<Int>()
    private var clips = emptyList<Clip>()
    private var loading = false
    private var pending: Int? = null
    private var active: Clip? = null
    private var ready = false
    private var playing = true
    private var position = 0
    val isOpen: Boolean get() = active != null
    private val tick = object : Runnable {
        override fun run() {
            if (!isOpen) return
            if (ready) updateStatus()
            main.postDelayed(this, 500)
        }
    }

    init {
        overlay.addView(video, FrameLayout.LayoutParams(-1, -1, Gravity.CENTER))
        val bar = LinearLayout(activity).apply {
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), dp(6), dp(12), dp(6))
            setBackgroundColor(Color.argb(225, 30, 39, 43))
        }
        fun button(icon: Int, name: String, action: () -> Unit): ImageButton = ImageButton(activity).apply {
            setImageResource(icon); imageTintList = android.content.res.ColorStateList.valueOf(Color.WHITE)
            contentDescription = name; setBackgroundResource(android.R.drawable.list_selector_background)
            isFocusable = true
            layoutParams = LinearLayout.LayoutParams(dp(52), dp(52))
            setOnClickListener { action() }
            setOnLongClickListener { Toast.makeText(activity, name, Toast.LENGTH_SHORT).show(); true }
            if (android.os.Build.VERSION.SDK_INT >= 26) tooltipText = name
            bar.addView(this)
        }
        button(android.R.drawable.ic_menu_revert, "返回课件") { close() }
        button(android.R.drawable.ic_media_rew, "后退 10 秒") { seek(-10000) }
        toggle = button(android.R.drawable.ic_media_pause, "暂停视频") { playback(!playing) }
        button(android.R.drawable.ic_media_ff, "前进 10 秒") { seek(10000) }
        bar.addView(status, LinearLayout.LayoutParams(0, -1, 1f))
        retry = button(android.R.drawable.ic_popup_sync, "重试视频") { prepare() }
        retry.visibility = View.GONE
        overlay.addView(bar, FrameLayout.LayoutParams(-1, dp(72), Gravity.BOTTOM))
        root.addView(overlay, FrameLayout.LayoutParams(-1, -1))
        video.setOnPreparedListener {
            if (active != null) {
                ready = true
                if (position > 0) video.seekTo(position.coerceAtMost(video.duration.coerceAtLeast(0)))
                if (playing) video.start() else video.pause()
                updateStatus()
            }
        }
        video.setOnCompletionListener { close() }
        video.setOnErrorListener { _, _, _ ->
            ready = false
            status.text = "视频无法播放，请使用 H.264 / AAC MP4"
            retry.visibility = View.VISIBLE
            retry.requestFocus()
            true
        }
    }

    private fun dp(value: Int) = (activity.resources.displayMetrics.density * value).toInt()
    private fun currentClips(): List<Clip> {
        val slide = statePages.getOrNull(page - 1)?.takeIf { it > 0 } ?: page
        return clips.filter { it.slide == slide }
    }
    fun context(url: String, number: Int) {
        if (url == document && number == page) return
        close()
        picker?.dismiss(); picker = null
        page = number
        if (url == document) { available(currentClips().isNotEmpty()); return }
        call?.cancel(); call = null; generation++
        document = url; clips = emptyList(); statePages = emptyList(); loading = false
        available(false)
        if (url.isEmpty()) return
        fetch()
    }
    private fun fetch() {
        val ticket = generation
        val url = document.toHttpUrl().newBuilder().apply {
            encodedPath(document.toHttpUrl().encodedPath + ".metadata")
            setQueryParameter("embedded", "1")
        }.build()
        loading = true
        call = client.newCall(Request.Builder().url(url).build()).also { request ->
            request.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) { finish(null) }
                override fun onResponse(call: Call, response: Response) {
                    val result = runCatching { response.use {
                        if (it.isSuccessful) JSONObject(it.body?.string() ?: "{}") else null
                    } }.getOrNull()
                    finish(result)
                }
                private fun finish(result: JSONObject?) { main.post {
                    if (ticket != generation) return@post
                    loading = false; call = null
                    val states = result?.optJSONObject("conversion")?.optJSONArray("statePages")
                    statePages = if (states == null) emptyList() else (0 until states.length()).map { states.optInt(it) }
                    val videos = result?.optJSONArray("videos")
                    clips = if (videos == null) emptyList() else (0 until videos.length()).mapNotNull { i ->
                        runCatching {
                            val item = videos.getJSONObject(i)
                            val index = item.getInt("index"); val slide = item.getInt("slide")
                            require(index >= 0 && slide > 0)
                            Clip(index, slide, item.optString("title", "本页视频"), safeUrl(item.getString("url")))
                        }.getOrNull()
                    }
                    available(currentClips().isNotEmpty())
                    val requested = pending; pending = null
                    if (requested != null) {
                        if (result == null) Toast.makeText(activity, "视频列表加载失败，请重试", Toast.LENGTH_LONG).show()
                        else open(requested)
                    }
                } }
            })
        }
    }
    fun choose() {
        val items = currentClips()
        if (items.size == 1) { open(items[0].index); return }
        if (items.isEmpty()) return
        picker?.dismiss()
        picker = AlertDialog.Builder(activity).setTitle("本页视频")
            .setItems(items.map { it.title }.toTypedArray()) { _, i -> open(items[i].index) }
            .setNegativeButton("取消", null).show()
    }
    fun receive(message: JSONObject) {
        val target = runCatching { safeUrl(message.optString("url")) }.getOrNull()
        if (document.isEmpty() || target != document) return
        val index = message.optInt("index", -1)
        when (message.optString("action")) {
            "open" -> {
                if (index < 0) return
                if (loading) pending = index
                else if (clips.isEmpty()) { pending = index; fetch() }
                else open(index)
            }
            "close" -> if (index < 0 || active == null || active?.index == index) close()
            "play", "pause", "back", "forward" -> {
                if (active?.index != index) return
                when (message.optString("action")) {
                    "play" -> playback(true)
                    "pause" -> playback(false)
                    "back" -> seek(-10000)
                    "forward" -> seek(10000)
                }
            }
        }
    }
    private fun open(index: Int) {
        val clip = currentClips().find { it.index == index } ?: return
        if (active?.index == index) return
        close()
        picker?.dismiss(); picker = null
        active = clip; playing = true; position = 0
        overlay.visibility = View.VISIBLE
        prepare(); toggle.requestFocus()
        sendState("open", clip)
        main.post(tick)
    }
    private fun prepare() {
        val clip = active ?: return
        ready = false; video.stopPlayback(); retry.visibility = View.GONE
        status.text = "正在加载 ${clip.title}…"
        video.setVideoURI(Uri.parse(clip.url))
    }
    private fun playback(value: Boolean) {
        playing = value
        if (ready) { if (value) video.start() else video.pause(); updateStatus() }
    }
    private fun seek(delta: Int) {
        position = ((if (ready) video.currentPosition else position).toLong() + delta)
            .coerceIn(0L, if (ready) video.duration.coerceAtLeast(0).toLong() else Int.MAX_VALUE.toLong()).toInt()
        if (ready) video.seekTo(position)
    }
    private fun updateStatus() {
        val clip = active ?: return
        toggle.setImageResource(if (playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play)
        toggle.contentDescription = if (playing) "暂停视频" else "播放视频"
        status.text = "${clip.title}  ${if (video.isPlaying) "播放中" else "已暂停"}  ${maxOf(0, video.currentPosition) / 1000} / ${maxOf(0, video.duration) / 1000} 秒"
    }
    private fun sendState(action: String, clip: Clip) {
        send(JSONObject().put("type", "viewer.embedded-video").put("action", action).put("url", document).put("index", clip.index))
    }
    fun close() {
        pending = null
        val old = active; active = null; ready = false
        main.removeCallbacks(tick)
        video.stopPlayback(); overlay.visibility = View.GONE
        if (old != null) sendState("close", old)
    }
    fun key(event: KeyEvent): Boolean {
        if (!isOpen) return false
        if (event.keyCode == KeyEvent.KEYCODE_BACK) {
            if (event.action == KeyEvent.ACTION_UP) close()
            return true
        }
        if (event.keyCode in listOf(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_MEDIA_PLAY,
                KeyEvent.KEYCODE_MEDIA_PAUSE, KeyEvent.KEYCODE_MEDIA_REWIND, KeyEvent.KEYCODE_MEDIA_FAST_FORWARD)) {
            if (event.action == KeyEvent.ACTION_DOWN) when (event.keyCode) {
                KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> playback(!playing)
                KeyEvent.KEYCODE_MEDIA_PLAY -> playback(true)
                KeyEvent.KEYCODE_MEDIA_PAUSE -> playback(false)
                KeyEvent.KEYCODE_MEDIA_REWIND -> seek(-10000)
                KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> seek(10000)
            }
            return true
        }
        // Let the overlay buttons handle focus; prevent presentation shortcuts underneath it.
        return activity.window.superDispatchKeyEvent(event)
    }
}
