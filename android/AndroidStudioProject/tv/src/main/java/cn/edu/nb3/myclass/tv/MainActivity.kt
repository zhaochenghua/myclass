package cn.edu.nb3.myclass.tv

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.media.AudioManager
import android.media.MediaPlayer
import android.net.Uri
import android.os.*
import android.provider.Settings
import android.text.InputType
import android.util.Log
import android.view.*
import android.widget.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.SurfaceViewRenderer
import java.util.concurrent.Executors
import kotlin.random.Random

class MainActivity : Activity() {
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private val prefs by lazy { getSharedPreferences("tv", MODE_PRIVATE) }
    private lateinit var receiver: TvReceiver
    private lateinit var loader: ContentLoader
    private lateinit var root: FrameLayout
    private lateinit var stage: FrameLayout
    private lateinit var waiting: LinearLayout
    private lateinit var toolbar: LinearLayout
    private lateinit var code: TextView
    private lateinit var status: TextView
    private lateinit var header: TextView
    private lateinit var serverLabel: TextView
    private lateinit var cornerCode: TextView
    private lateinit var notice: TextView
    private lateinit var pageLabel: TextView
    private lateinit var surface: SurfaceViewRenderer
    private lateinit var picture: PresentationView
    private lateinit var video: VideoView
    private lateinit var previous: ImageButton
    private lateinit var next: ImageButton
    private lateinit var play: ImageButton
    private lateinit var retryButton: ImageButton
    private var endpoint = ""
    private var roomCode = ""
    private var token = ""
    private var username = ""
    private var connected = false
    private var presentationUrl = ""
    private var presentationTitle = ""
    private var kind = ""
    private var page = 1
    private var pageCount = 0
    private var revision = 0L
    private var loadId = 0
    private var renderId = 0
    private var pendingViewport: JSONObject? = null
    private var player: MediaPlayer? = null
    private var videoReady = false
    private var desiredPlay = true
    private var desiredSeek = 0
    private var volume = 100
    private var muted = false
    private var classId = ""
    private var drawMode = "number"
    private var drawCount = 50
    private var drawing = false
    private val drawn = mutableMapOf<String, MutableSet<String>>()
    private var dialog: AlertDialog? = null
    private var stopped = false
    private val teal = Color.rgb(13, 116, 106)
    private val ink = Color.rgb(30, 39, 43)
    private val videoTick = object : Runnable {
        override fun run() {
            if (!stopped && kind == "video" && videoReady) reportVideo()
            if (!stopped) main.postDelayed(this, 1000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        immersive()
        volumeControlStream = AudioManager.STREAM_MUSIC
        endpoint = prefs.getString("endpoint", BuildConfig.SERVER_BASE_URL)!!.trimEnd('/') + "/"
        buildUi()
        receiver = TvReceiver(applicationContext, surface, ::signal, ::connectionStatus) {
            if (kind == "live") {
                surface.visibility = View.VISIBLE; waiting.visibility = View.GONE
                notice.visibility = View.GONE
                setToolbar(false)
            }
        }
        loader = ContentLoader(this, receiver.http)
        receiver.start(endpoint)
    }

    private fun dp(value: Int) = (resources.displayMetrics.density * value).toInt()
    private fun label(text: String, size: Float, color: Int = ink) = TextView(this).apply {
        this.text = text; textSize = size; setTextColor(color); gravity = Gravity.CENTER_VERTICAL
        letterSpacing = 0f
    }
    private fun buildUi() {
        root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        stage = FrameLayout(this)
        root.addView(stage, FrameLayout.LayoutParams(-1, -1))
        surface = SurfaceViewRenderer(this).apply { visibility = View.GONE }
        stage.addView(surface, FrameLayout.LayoutParams(-1, -1))
        video = VideoView(this).apply { visibility = View.GONE }
        stage.addView(video, FrameLayout.LayoutParams(-1, -1, Gravity.CENTER))
        picture = PresentationView(this).apply { visibility = View.GONE; contentDescription = "课件画面" }
        stage.addView(picture, FrameLayout.LayoutParams(-1, -1))
        waiting = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setBackgroundColor(Color.rgb(244, 247, 248))
            setPadding(dp(44), dp(26), dp(44), dp(82))
        }
        stage.addView(waiting, FrameLayout.LayoutParams(-1, -1))
        val brand = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        brand.addView(ImageView(this).apply { setImageResource(cn.edu.nb3.myclass.tv.R.drawable.tv_icon) }, LinearLayout.LayoutParams(dp(48), dp(48)))
        brand.addView(label("MyClass 大屏", 28f).apply { typeface = Typeface.DEFAULT_BOLD; setPadding(dp(16), 0, 0, 0) })
        header = label("", 17f, teal).apply { gravity = Gravity.END or Gravity.CENTER_VERTICAL }
        brand.addView(header, LinearLayout.LayoutParams(0, -1, 1f))
        waiting.addView(brand, LinearLayout.LayoutParams(-1, dp(58)))
        val center = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            isBaselineAligned = false
        }
        val connectionPanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(0, 0, dp(18), 0)
        }
        connectionPanel.addView(label("课堂连接码", 22f).apply { gravity = Gravity.CENTER })
        code = label("----", 96f, teal).apply {
            gravity = Gravity.CENTER
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        }
        connectionPanel.addView(code, LinearLayout.LayoutParams(-1, dp(122)))
        status = label("正在连接服务器…", 19f).apply { gravity = Gravity.CENTER }
        connectionPanel.addView(status, LinearLayout.LayoutParams(-1, dp(38)))
        serverLabel = label(Uri.parse(endpoint).host ?: "sz.imst.xyz", 15f, Color.DKGRAY).apply { gravity = Gravity.CENTER }
        connectionPanel.addView(serverLabel, LinearLayout.LayoutParams(-1, dp(28)))
        center.addView(connectionPanel, LinearLayout.LayoutParams(0, dp(220), 1f))
        val qrRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
        }
        qrRow.addView(qrOption(cn.edu.nb3.myclass.tv.R.drawable.qr_windows, "Windows 客户端", "扫码下载安装"),
            LinearLayout.LayoutParams(dp(142), dp(154)))
        qrRow.addView(qrOption(cn.edu.nb3.myclass.tv.R.drawable.qr_ios, "手机 / 平板", "扫码打开控制页"),
            LinearLayout.LayoutParams(dp(142), dp(154)).apply { marginStart = dp(12) })
        center.addView(qrRow, LinearLayout.LayoutParams(dp(300), dp(154)))
        waiting.addView(center, LinearLayout.LayoutParams(-1, 0, 1f))
        notice = label("", 18f, Color.WHITE).apply {
            gravity = Gravity.CENTER; setBackgroundColor(Color.rgb(148, 40, 40))
            setPadding(dp(18), dp(10), dp(18), dp(10)); visibility = View.GONE
            isFocusable = false
        }
        root.addView(notice, FrameLayout.LayoutParams(-2, -2, Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply { topMargin = dp(20) })
        cornerCode = label("", 17f, Color.WHITE).apply {
            gravity = Gravity.CENTER
            setPadding(dp(16), dp(8), dp(16), dp(8))
            setBackgroundColor(Color.argb(210, 30, 39, 43))
            visibility = View.GONE
            isFocusable = false
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
        }
        root.addView(cornerCode, FrameLayout.LayoutParams(-2, -2, Gravity.TOP or Gravity.END).apply {
            topMargin = dp(18)
            rightMargin = dp(28)
        })
        toolbar = LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL; setPadding(dp(22), dp(8), dp(22), dp(8))
            setBackgroundColor(Color.rgb(237, 242, 243))
        }
        root.addView(toolbar, FrameLayout.LayoutParams(-1, dp(72), Gravity.BOTTOM).apply {
            leftMargin = dp(24); rightMargin = dp(24); bottomMargin = dp(20)
        })
        previous = icon(android.R.drawable.ic_media_previous, "上一屏 / 上一页") { navigate(-1) }
        next = icon(android.R.drawable.ic_media_next, "下一屏 / 下一页") { navigate(1) }
        play = icon(android.R.drawable.ic_media_pause, "播放 / 暂停") { controlVideo(JSONObject().put("action", "toggle")) }
        toolbar.addView(previous); toolbar.addView(next); toolbar.addView(play)
        pageLabel = label("", 15f).apply { gravity = Gravity.CENTER; maxLines = 2 }
        toolbar.addView(pageLabel, LinearLayout.LayoutParams(0, -1, 1f))
        toolbar.addView(command("打开课件") { library() })
        toolbar.addView(command("抽学生") { roll("") })
        toolbar.addView(command("结束展示") { endPresentation(true) })
        retryButton = icon(android.R.drawable.ic_popup_sync, "重新连接") { receiver.start(endpoint) }
        toolbar.addView(retryButton)
        toolbar.addView(icon(android.R.drawable.ic_menu_preferences, "设置") { settings() })
        setContentView(root)
        picture.setOnClickListener { setToolbar(toolbar.visibility != View.VISIBLE); next.requestFocus() }
        surface.setOnClickListener { setToolbar(toolbar.visibility != View.VISIBLE); retryButton.requestFocus() }
        retryButton.requestFocus()
        updateControls()
        video.setOnPreparedListener {
            player = it; videoReady = true
            if (desiredSeek > 0) video.seekTo(desiredSeek)
            applyVolume()
            if (desiredPlay) video.start() else video.pause()
            notice.visibility = View.GONE
            setToolbar(false)
            reportVideo()
        }
        video.setOnCompletionListener { desiredPlay = false; reportVideo() }
        video.setOnErrorListener { _, _, _ ->
            videoReady = false; showError("视频无法播放，请使用电视支持的 H.264 MP4 视频")
            true
        }
    }

    private fun buttonBackground(): StateListDrawable {
        fun shape(color: Int, stroke: Int) = GradientDrawable().apply {
            setColor(color); cornerRadius = dp(4).toFloat(); setStroke(dp(2), stroke)
        }
        return StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_focused), shape(teal, Color.rgb(255, 209, 102)))
            addState(intArrayOf(android.R.attr.state_pressed), shape(teal, teal))
            addState(intArrayOf(), shape(Color.TRANSPARENT, Color.TRANSPARENT))
        }
    }
    private fun qrOption(resource: Int, title: String, subtitle: String): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER
        setPadding(dp(5), dp(4), dp(5), 0)
        addView(ImageView(this@MainActivity).apply {
            setImageResource(resource)
            scaleType = ImageView.ScaleType.CENTER_INSIDE
            contentDescription = title
            setBackgroundColor(Color.WHITE)
        }, LinearLayout.LayoutParams(dp(102), dp(102)))
        addView(label(title, 14f).apply {
            gravity = Gravity.CENTER
            typeface = Typeface.DEFAULT_BOLD
        }, LinearLayout.LayoutParams(-1, dp(23)))
        addView(label(subtitle, 11f, Color.DKGRAY).apply {
            gravity = Gravity.CENTER
        }, LinearLayout.LayoutParams(-1, dp(19)))
    }
    private fun showCornerCode(show: Boolean) {
        if (!::cornerCode.isInitialized) return
        cornerCode.text = if (show && roomCode.isNotEmpty()) "重连码  $roomCode" else ""
        cornerCode.visibility = if (show && roomCode.isNotEmpty()) View.VISIBLE else View.GONE
    }
    private fun command(name: String, action: () -> Unit) = Button(this).apply {
        text = name; textSize = 16f; isAllCaps = false; minWidth = 0; minimumWidth = 0
        setPadding(dp(14), 0, dp(14), 0); background = buttonBackground()
        setTextColor(ColorStateList(arrayOf(intArrayOf(android.R.attr.state_focused), intArrayOf()), intArrayOf(Color.WHITE, ink)))
        layoutParams = LinearLayout.LayoutParams(-2, dp(52)).apply { marginStart = dp(4) }
        setOnClickListener { action() }
    }
    private fun icon(resource: Int, name: String, action: () -> Unit) = ImageButton(this).apply {
        setImageResource(resource); contentDescription = name; background = buttonBackground()
        imageTintList = ColorStateList(arrayOf(intArrayOf(android.R.attr.state_focused), intArrayOf()), intArrayOf(Color.WHITE, ink))
        layoutParams = LinearLayout.LayoutParams(dp(52), dp(52)).apply { marginStart = dp(4) }
        isFocusable = true; setOnClickListener { action() }
        setOnLongClickListener { Toast.makeText(this@MainActivity, name, Toast.LENGTH_SHORT).show(); true }
        if (Build.VERSION.SDK_INT >= 26) tooltipText = name
    }

    private fun updateControls() {
        previous.visibility = if (kind == "pdf") View.VISIBLE else View.GONE
        next.visibility = previous.visibility
        play.visibility = if (kind == "video") View.VISIBLE else View.GONE
        pageLabel.text = when (kind) {
            "pdf" -> "$presentationTitle\n第 $page / ${if (pageCount == 0) "…" else pageCount} 页"
            "" -> roomCode.takeIf { it.isNotEmpty() }?.let { "连接码 $it" } ?: "离线"
            else -> roomCode.takeIf { it.isNotEmpty() }?.let { "连接码 $it" } ?: ""
        }
    }
    private fun connectionStatus(message: String) {
        status.text = message
        if (kind.isNotEmpty()) { notice.text = message; notice.visibility = View.VISIBLE }
    }
    private fun showError(message: String) {
        notice.text = message; notice.visibility = View.VISIBLE
        status.text = message; setToolbar(true)
    }
    private fun setToolbar(visible: Boolean) { toolbar.visibility = if (visible) View.VISIBLE else View.GONE }
    private fun immersive() {
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
    }

    private fun signal(message: JSONObject) {
        if (message.has("presentationRevision")) revision = message.optLong("presentationRevision")
        when (message.optString("type")) {
            "room.created" -> {
                if (roomCode.isNotEmpty() && roomCode != message.optString("code")) {
                    endPresentation(false); clearTeacher()
                }
                roomCode = message.optString("code"); code.text = roomCode
                showCornerCode(false)
                notice.visibility = View.GONE; status.text = "等待教师连接"
                updateControls()
            }
            "teacher.online" -> {
                val incoming = message.optString("token")
                if (token != incoming) {
                    if (token.isNotEmpty()) endPresentation(false)
                    clearTeacher()
                }
                token = incoming; username = message.optString("username")
                connected = true; header.text = if (username.isEmpty()) "教师已连接" else username
                showCornerCode(false)
                status.text = "教师已连接"; notice.visibility = View.GONE
            }
            "teacher.offline" -> {
                connected = false; header.text = ""; receiver.closeVideo()
                if (kind == "live") endPresentation(false)
                showCornerCode(true)
                connectionStatus("教师已断开，等待重新连接")
            }
            "webrtc.offer" -> {
                endPresentation(false); kind = "live"; status.text = "正在建立视频连接…"
                updateControls(); receiver.offer(message.optString("sdp"))
            }
            "webrtc.ice-candidate" -> message.optJSONObject("candidate")?.let { receiver.candidate(it) }
            "courseware.open" -> openPresentation(message)
            "courseware.page" -> changePage(message.optInt("page", 1))
            "courseware.navigate" -> navigate(if (message.optInt("delta") < 0) -1 else 1)
            "courseware.close", "teacher.stop" -> endPresentation(false)
            "courseware.annotation" -> picture.annotation(message)
            "courseware.image.viewport" -> { pendingViewport = message; picture.viewport(message) }
            "courseware.video.control" -> controlVideo(message)
            "room.snapshot" -> snapshot(message.optJSONObject("presentation"))
            "student.selection.set", "student.selection.get" -> receiveSelection(message)
            "student.roll" -> roll(message.optString("requestId"))
            "room.expired" -> { showCornerCode(false); clearTeacher(); endPresentation(false); receiver.start(endpoint, true) }
            "error" -> showError(message.optString("message", "连接异常"))
        }
    }

    private fun safeContentUrl(value: String): String {
        val base = endpoint.toHttpUrl()
        val url = base.resolve(value) ?: error("文件地址无效")
        require(url.host == base.host && url.port == base.port && url.scheme == base.scheme &&
            url.encodedPath.startsWith(base.encodedPath) && url.username.isEmpty() && url.password.isEmpty()) { "课件地址不属于当前服务器" }
        return url.toString()
    }

    private fun openPresentation(message: JSONObject) {
        val url = try { safeContentUrl(message.optString("url")) } catch (e: Exception) { showError(e.message!!); return }
        if (presentationUrl == url && kind == "pdf") { changePage(message.optInt("page", page)); return }
        endPresentation(false)
        presentationUrl = url; presentationTitle = message.optString("title", "课件").take(80)
        page = maxOf(1, message.optInt("page", 1)); pendingViewport = null
        val path = url.toHttpUrl().encodedPath.lowercase()
        kind = when {
            Regex("\\.(mp4|mov|avi|webm|mkv|3gp)$").containsMatchIn(path) -> "video"
            Regex("\\.(jpg|jpeg|png|gif|webp|bmp)$").containsMatchIn(path) -> "image"
            path.endsWith(".pdf") -> "pdf"
            else -> "unsupported"
        }
        waiting.visibility = View.GONE
        notice.text = "正在加载 $presentationTitle…"; notice.visibility = View.VISIBLE
        updateControls()
        if (kind == "video") {
            videoReady = false; desiredPlay = true; desiredSeek = 0
            video.visibility = View.VISIBLE; video.setVideoURI(Uri.parse(url))
            return
        }
        if (kind == "unsupported") { showError("此文件不能在电视端打开，请从手机发送 PDF、图片或视频"); return }
        picture.visibility = View.VISIBLE
        val ticket = ++loadId
        val initialPage = page
        loader.open(url, kind == "pdf", page, { bitmap, count ->
            if (ticket != loadId || stopped) { bitmap.recycle(); return@open }
            pageCount = count; page = page.coerceIn(1, count)
            if (kind == "pdf" && page != initialPage.coerceIn(1, count)) {
                bitmap.recycle(); changePage(page); return@open
            }
            picture.show(bitmap, kind == "pdf", page)
            pendingViewport?.let { picture.viewport(it) }
            notice.visibility = View.GONE; setToolbar(false); updateControls(); reportPage()
        }, { if (ticket == loadId) showError("加载失败：$it") })
    }

    private fun changePage(number: Int) {
        if (kind != "pdf") return
        page = number.coerceIn(1, maxOf(1, pageCount.takeIf { it > 0 } ?: number))
        val ticket = ++renderId
        picture.resetViewport(); pendingViewport = null
        val targetPage = page
        loader.page(presentationUrl, page, { bitmap, count ->
            if (ticket != renderId || kind != "pdf" || stopped) { bitmap.recycle(); return@page }
            pageCount = count; page = targetPage.coerceIn(1, count)
            picture.show(bitmap, true, page); notice.visibility = View.GONE
            pendingViewport?.let { picture.viewport(it) }
            updateControls(); reportPage()
        }, { showError("翻页失败：$it") })
    }
    private fun navigate(delta: Int) {
        if (BuildConfig.DEBUG) Log.d("MyClassTV", "navigate delta=$delta kind=$kind page=$page count=$pageCount")
        if (kind != "pdf") return
        if (picture.step(delta)) reportPage() else if (pageCount > 0) changePage((page + delta).coerceIn(1, pageCount))
    }
    private fun reportPage() {
        if (kind != "pdf") return
        val state = JSONObject().put("type", "courseware.state").put("url", presentationUrl)
            .put("page", page).put("pageCount", pageCount)
            .put("screen", picture.screen).put("screenCount", picture.screenCount).put("fitMode", "fit-page")
        if (revision >= 0) state.put("presentationRevision", revision)
        receiver.send(state)
    }
    private fun snapshot(snapshot: JSONObject?) {
        val open = snapshot?.optJSONObject("open")
        if (open == null) { if (kind != "live") endPresentation(false); return }
        // Replacing the view also replaces its strokes; replay never appends duplicate ink.
        endPresentation(false); openPresentation(open)
        for (key in listOf("strokes", "active")) {
            val strokes = snapshot.optJSONArray(key) ?: continue
            for (i in 0 until strokes.length()) {
                val stroke = strokes.getJSONObject(i)
                picture.annotation(JSONObject(stroke.toString()).put("action", "begin"))
            }
        }
        pendingViewport = snapshot.optJSONObject("viewport")
        pendingViewport?.let { picture.viewport(it) }
    }

    private fun endPresentation(notify: Boolean) {
        ++loadId; ++renderId
        if (::loader.isInitialized) loader.cancel()
        if (::receiver.isInitialized) {
            receiver.closeVideo()
            if (notify) receiver.send(JSONObject().put("type", "viewer.courseware.close"))
        }
        player = null; videoReady = false; video.stopPlayback(); video.visibility = View.GONE
        surface.visibility = View.GONE; picture.clear(); picture.visibility = View.GONE
        presentationUrl = ""; kind = ""; page = 1; pageCount = 0; pendingViewport = null
        waiting.visibility = View.VISIBLE; notice.visibility = View.GONE
        status.text = if (connected) "教师已连接" else "等待教师连接"
        setToolbar(true); updateControls()
    }

    private fun controlVideo(message: JSONObject) {
        if (kind != "video") return
        when (message.optString("action")) {
            "play" -> desiredPlay = true
            "pause" -> desiredPlay = false
            "toggle" -> desiredPlay = !desiredPlay
            "seek" -> {
                val seconds = message.optDouble("position", 0.0)
                if (seconds.isFinite()) desiredSeek = (seconds.coerceIn(0.0, if (videoReady) video.duration / 1000.0 else 86400.0) * 1000).toInt()
                if (videoReady) video.seekTo(desiredSeek)
            }
            "volume" -> { volume = message.optInt("volume", 100).coerceIn(0, 100); muted = volume == 0; applyVolume() }
            "mute" -> { muted = message.optBoolean("muted"); applyVolume() }
        }
        if (videoReady) { if (desiredPlay) video.start() else video.pause(); reportVideo() }
    }
    private fun applyVolume() { val level = if (muted) 0f else volume / 100f; player?.setVolume(level, level) }
    private fun reportVideo() {
        receiver.send(JSONObject().put("type", "courseware.video.state").put("playing", video.isPlaying)
            .put("position", maxOf(0, video.currentPosition) / 1000.0).put("duration", maxOf(0, video.duration) / 1000.0)
            .put("muted", muted).put("volume", volume))
    }

    private fun api(route: String, method: String = "GET", body: JSONObject? = null, success: (JSONObject) -> Unit, failure: (String) -> Unit) {
        val savedToken = token; val savedEndpoint = endpoint
        worker.execute {
            try {
                val builder = Request.Builder().url("${savedEndpoint}api/$route")
                if (savedToken.isNotEmpty()) builder.header("Authorization", "Bearer $savedToken")
                if (method != "GET") builder.method(method, (body ?: JSONObject()).toString().toRequestBody("application/json".toMediaType()))
                val result = receiver.http.newCall(builder.build()).execute().use {
                    val json = JSONObject(it.body?.string() ?: "{}")
                    check(it.isSuccessful) { json.optString("message", json.optString("error", "请求失败 ${it.code}")) }
                    json
                }
                main.post { if (!stopped && token == savedToken && endpoint == savedEndpoint) success(result) }
            } catch (e: Exception) {
                main.post { if (!stopped && token == savedToken && endpoint == savedEndpoint) failure(e.message ?: "网络请求失败") }
            }
        }
    }
    private fun showDialog(value: AlertDialog) { dialog?.dismiss(); dialog = value; value.show() }
    private fun library() {
        if (token.isEmpty()) { login(); return }
        api("courseware", success = { result ->
            val items = result.optJSONArray("items") ?: JSONArray()
            if (items.length() == 0) { showError("暂无服务器课件"); return@api }
            val names = (0 until items.length()).map { items.getJSONObject(it).optString("title", "课件") }.toTypedArray()
            showDialog(AlertDialog.Builder(this).setTitle("服务器课件").setItems(names) { _, index ->
                val item = items.getJSONObject(index)
                // A locally opened file has no server-acknowledged revision yet.
                revision = -1
                openPresentation(item)
                receiver.send(JSONObject().put("type", "viewer.courseware.open").put("url", item.optString("url"))
                    .put("title", item.optString("title")).put("page", 1))
            }.setNegativeButton("取消", null).create())
        }, failure = ::showError)
    }
    private fun login() {
        val form = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(24), dp(12), dp(24), 0) }
        val account = EditText(this).apply { hint = "账号"; inputType = InputType.TYPE_CLASS_TEXT; isSingleLine = true }
        val password = EditText(this).apply { hint = "密码"; inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD; isSingleLine = true }
        form.addView(account); form.addView(password)
        val value = AlertDialog.Builder(this).setTitle("教师登录").setView(form).setNegativeButton("取消", null).setPositiveButton("登录", null).create()
        showDialog(value)
        value.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            api("auth/login", "POST", JSONObject().put("username", account.text.toString().trim()).put("password", password.text.toString()), {
                clearTeacher(); token = it.optString("token"); username = it.optString("username"); header.text = username
                value.dismiss(); library()
            }, { password.error = it })
        }
    }

    private fun selectionState(requestId: String, confirmed: Boolean, error: String = "") {
        receiver.send(JSONObject().put("type", "student.selection.state").put("requestId", requestId)
            .put("classId", classId).put("mode", drawMode).put("count", drawCount).put("confirmed", confirmed).put("error", error))
    }
    private fun receiveSelection(message: JSONObject) {
        val requestId = message.optString("requestId")
        if (message.optString("type") == "student.selection.get") { selectionState(requestId, true); return }
        val requested = message.optString("classId")
        val mode = message.optString("mode"); val count = message.optInt("count")
        if (mode !in listOf("name", "number") || count !in 1..80) { selectionState(requestId, false, "设置无效"); return }
        fun apply() { classId = requested; drawMode = mode; drawCount = count; selectionState(requestId, true) }
        if (requested.isEmpty()) apply() else {
            if (token.isEmpty()) { selectionState(requestId, false, "请先登录教师账号"); return }
            api("classes/$requested", success = { apply() }, failure = { selectionState(requestId, false, it) })
        }
    }
    private fun drawSettings() {
        fun modes() {
            showDialog(AlertDialog.Builder(this).setTitle("抽取方式").setSingleChoiceItems(arrayOf("姓名", "学号"), if (drawMode == "name") 0 else 1) { value, which ->
                drawMode = if (which == 0) "name" else "number"; value.dismiss(); selectionState("", true)
            }.setNegativeButton("取消", null).create())
        }
        fun count() {
            val input = EditText(this).apply { inputType = InputType.TYPE_CLASS_NUMBER; setText(drawCount.toString()); selectAll() }
            val value = AlertDialog.Builder(this).setTitle("抽取人数（1–80）").setView(input).setPositiveButton("确定", null).setNegativeButton("取消", null).create()
            showDialog(value)
            value.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val number = input.text.toString().toIntOrNull()
                if (number == null || number !in 1..80) input.error = "请输入 1–80" else {
                    classId = ""; drawCount = number; drawMode = "number"; selectionState("", true); value.dismiss()
                }
            }
        }
        if (token.isEmpty()) { count(); return }
        api("classes", success = { result ->
            val items = result.optJSONArray("items") ?: JSONArray()
            val names = arrayOf("不选择班级") + (0 until items.length()).map { items.getJSONObject(it).optString("name") }
            showDialog(AlertDialog.Builder(this).setTitle("上课班级").setItems(names) { _, index ->
                if (index == 0) count() else { classId = items.getJSONObject(index - 1).getString("id"); modes() }
            }.setNegativeButton("取消", null).create())
        }, failure = ::showError)
    }
    private fun roll(requestId: String) {
        fun reply(state: String, text: String) {
            if (requestId.isNotEmpty()) receiver.send(JSONObject().put("type", "student.roll.result").put("requestId", requestId).put("status", state).put("message", text))
        }
        if (drawing) { reply("busy", "请等待本次抽取结束"); return }
        drawing = true
        fun show(items: List<Pair<String, String>>, scope: String) {
            if (items.isEmpty()) { drawing = false; reply("needs-setup", "这个班级还没有学生"); showError("这个班级还没有学生"); return }
            val used = drawn.getOrPut(scope) { mutableSetOf() }
            used.retainAll(items.map { it.first }.toSet())
            var pool = items.filter { it.first !in used }
            if (pool.isEmpty()) { used.clear(); pool = items }
            val selected = pool[Random.nextInt(pool.size)]; used.add(selected.first)
            reply("started", "正在抽取")
            val result = label(selected.second, 44f, teal).apply { gravity = Gravity.CENTER; setPadding(dp(24), dp(24), dp(24), dp(24)) }
            val value = AlertDialog.Builder(this).setTitle("抽取结果").setView(result).setPositiveButton("确定", null).create()
            value.setOnDismissListener { drawing = false }
            showDialog(value); reply("done", selected.second)
            main.postDelayed({ if (dialog === value) value.dismiss() }, 5000)
        }
        if (classId.isEmpty()) show((1..drawCount).map { it.toString() to it.toString().padStart(2, '0') }, "$username:count:$drawCount") else {
            val requested = classId; val mode = drawMode
            api("classes/$requested", success = { result ->
                val item = result.getJSONObject("item"); val students = item.optJSONArray("students") ?: JSONArray()
                show((0 until students.length()).map { index ->
                    val s = students.getJSONObject(index); val number = s.getString("number"); val name = s.getString("name")
                    number to if (mode == "name") "$name\n学号 $number" else "$number\n$name"
                }, "$username:$requested")
            }, failure = { drawing = false; reply("error", it); showError(it) })
        }
    }

    private fun settings() {
        showDialog(AlertDialog.Builder(this).setTitle("大屏设置").setItems(arrayOf("服务器地址", "班级 / 抽取设置", "网络设置", "新课堂", "退出教师账号")) { _, index ->
            when (index) {
                0 -> serverSettings()
                1 -> drawSettings()
                2 -> startActivity(Intent(Settings.ACTION_WIFI_SETTINGS))
                3 -> { endPresentation(false); clearTeacher(); roomCode = ""; code.text = "----"; receiver.start(endpoint, true) }
                4 -> { clearTeacher(); endPresentation(false); receiver.start(endpoint, true) }
            }
        }.setNegativeButton("关闭", null).create())
    }
    private fun serverSettings() {
        val input = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            setText(endpoint); isSingleLine = true; setSelectAllOnFocus(true)
        }
        val value = AlertDialog.Builder(this).setTitle("服务器地址").setView(input).setPositiveButton("保存", null).setNegativeButton("取消", null).create()
        showDialog(value)
        value.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            val parsed = runCatching { input.text.toString().trim().toHttpUrl() }.getOrNull()
            if (parsed == null || parsed.username.isNotEmpty() || parsed.password.isNotEmpty() || parsed.query != null || parsed.fragment != null) {
                input.error = "请输入完整的 HTTP 或 HTTPS 服务地址"; return@setOnClickListener
            }
            endpoint = parsed.toString().trimEnd('/') + "/"
            serverLabel.text = parsed.host
            prefs.edit().putString("endpoint", endpoint).apply()
            endPresentation(false); clearTeacher(); roomCode = ""; code.text = "----"
            receiver.start(endpoint, true); value.dismiss()
        }
    }
    private fun clearTeacher() {
        token = ""; username = ""; connected = false; classId = ""; drawMode = "number"; drawCount = 50
        drawing = false; drawn.clear(); header.text = ""; showCornerCode(false)
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (BuildConfig.DEBUG && event.action == KeyEvent.ACTION_DOWN) Log.d("MyClassTV", "key=${event.keyCode} dialog=${dialog?.isShowing} toolbar=${toolbar.visibility} kind=$kind")
        if (dialog?.isShowing == true) return super.dispatchKeyEvent(event)
        if (event.action == KeyEvent.ACTION_DOWN) {
            when (event.keyCode) {
                KeyEvent.KEYCODE_MENU -> { settings(); return true }
                KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> { controlVideo(JSONObject().put("action", "toggle")); return true }
                KeyEvent.KEYCODE_PAGE_UP -> { navigate(-1); return true }
                KeyEvent.KEYCODE_PAGE_DOWN -> { navigate(1); return true }
            }
            if (toolbar.visibility != View.VISIBLE) {
                when (event.keyCode) {
                    KeyEvent.KEYCODE_DPAD_LEFT -> { navigate(-1); return true }
                    KeyEvent.KEYCODE_DPAD_RIGHT -> { navigate(1); return true }
                    KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> {
                        setToolbar(true); (if (kind == "pdf") next else retryButton).requestFocus(); return true
                    }
                }
            }
        }
        return super.dispatchKeyEvent(event)
    }
    @Deprecated("Legacy TV remote back support")
    override fun onBackPressed() {
        if (kind.isNotEmpty()) {
            if (toolbar.visibility == View.VISIBLE) setToolbar(false) else { setToolbar(true); retryButton.requestFocus() }
        } else showDialog(AlertDialog.Builder(this).setTitle("退出 MyClass 大屏？").setPositiveButton("退出") { _, _ -> finish() }.setNegativeButton("取消", null).create())
    }
    override fun onResume() {
        super.onResume(); immersive()
        if (stopped) { stopped = false; receiver.start(endpoint) }
        main.removeCallbacks(videoTick); main.post(videoTick)
    }
    override fun onStop() {
        stopped = true; main.removeCallbacksAndMessages(null); dialog?.dismiss()
        if (::receiver.isInitialized) receiver.stop()
        if (::loader.isInitialized) endPresentation(false)
        super.onStop()
    }
    override fun onDestroy() {
        if (::receiver.isInitialized) receiver.release()
        if (::loader.isInitialized) loader.release()
        worker.shutdownNow(); super.onDestroy()
    }
}
