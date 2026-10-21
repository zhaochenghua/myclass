package cn.edu.nb3.myclass

import android.app.Activity
import android.app.Dialog
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.LruCache
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.AbsListView
import android.widget.BaseAdapter
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.MediaController
import android.widget.TextView
import android.widget.VideoView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import okhttp3.OkHttpClient
import okhttp3.Dispatcher
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Independent, continuous document reader. No classroom state or annotations are accessed. */
internal class CoursewarePreviewDialog(
    private val activity: Activity,
    client: OkHttpClient,
    private val title: String,
    private val url: String,
    private val isPdf: Boolean,
    private val isVideo: Boolean,
    private val onDismiss: () -> Unit
) {
    private val http = client.newBuilder().dispatcher(Dispatcher()).callTimeout(30, TimeUnit.SECONDS).build()
    private val worker = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var closed = false
    private var loading = false
    private var rendering = false
    private var pdf: CoursewarePdfRenderer.OpenedPdf? = null
    private var pages = emptyList<DocumentPage>()
    private val failed = mutableSetOf<Int>()
    // Visible views hold their own references. Eviction only releases unused bitmaps to GC.
    private val bitmaps = object : LruCache<Int, Bitmap>(24 * 1024 * 1024) {
        override fun sizeOf(key: Int, value: Bitmap) = value.byteCount
    }
    private val status = TextView(activity).apply {
        textSize = 12f
        gravity = Gravity.CENTER
        setTextColor(Color.rgb(100, 116, 139))
    }
    private val list = ListView(activity).apply {
        contentDescription = "课件连续预览"
        divider = android.graphics.drawable.ColorDrawable(Color.rgb(220, 224, 230))
        dividerHeight = dp(3)
        setBackgroundColor(Color.rgb(235, 238, 242))
        setPadding(0, 0, 0, 0)
        clipToPadding = false
    }
    private val adapter = object : BaseAdapter() {
        override fun getCount() = pages.size
        override fun getItem(position: Int) = pages[position]
        override fun getItemId(position: Int) = position.toLong()
        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
            val view = (convertView as? PageView) ?: PageView()
            val page = pages[position]
            view.position = position
            view.ratio = page.height.toFloat() / page.width
            view.contentDescription = "第 ${position + 1} 页"
            view.setImageBitmap(bitmaps.get(position))
            view.requestLayout()
            view.setOnClickListener {
                if (failed.remove(position)) { status.text = "正在重新加载…"; scheduleVisible() }
            }
            list.post { scheduleVisible() }
            return view
        }
    }
    private val video = if (isVideo) VideoView(activity) else null
    private lateinit var dialog: Dialog

    fun show() {
        val root = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.WHITE)
        }
        val toolbar = LinearLayout(activity).apply {
            gravity = Gravity.CENTER_VERTICAL
            addView(TextView(activity).apply {
                text = "‹"
                textSize = 32f
                gravity = Gravity.CENTER
                contentDescription = "返回课件管理"
                setTextColor(Color.rgb(30, 41, 59))
                setOnClickListener { dismiss() }
            }, LinearLayout.LayoutParams(dp(48), -1))
            addView(TextView(activity).apply {
                text = title
                textSize = 16f
                maxLines = 1
                ellipsize = android.text.TextUtils.TruncateAt.END
                setTextColor(Color.rgb(15, 23, 42))
            }, LinearLayout.LayoutParams(0, -2, 1f))
            addView(status, LinearLayout.LayoutParams(dp(82), -1))
        }
        root.addView(toolbar, LinearLayout.LayoutParams(-1, dp(48)))
        root.addView(video ?: list, LinearLayout.LayoutParams(-1, 0, 1f))
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        dialog = Dialog(activity, android.R.style.Theme_Material_Light_NoActionBar).apply {
            setContentView(root)
            setOnDismissListener {
                closed = true
                http.dispatcher.cancelAll()
                video?.stopPlayback()
                list.adapter = null
                bitmaps.evictAll()
                worker.execute { pdf?.close(); pdf = null }
                worker.shutdown()
                onDismiss()
            }
        }
        dialog.window?.let {
            WindowCompat.setDecorFitsSystemWindows(it, false)
            it.setBackgroundDrawableResource(android.R.color.white)
        }
        dialog.show()
        dialog.window?.setLayout(-1, -1)
        ViewCompat.requestApplyInsets(root)
        list.adapter = adapter
        list.setOnScrollListener(object : AbsListView.OnScrollListener {
            override fun onScrollStateChanged(view: AbsListView, scrollState: Int) = Unit
            override fun onScroll(view: AbsListView, first: Int, count: Int, total: Int) {
                if (total > 0) status.text = "${first + 1} / $total"
                scheduleVisible()
            }
        })
        if (isVideo) {
            status.text = "视频"
            video!!.setMediaController(MediaController(activity).also { it.setAnchorView(video) })
            video.setOnPreparedListener { video.start() }
            video.setOnErrorListener { _, _, _ -> status.text = "播放失败"; true }
            video.setVideoURI(Uri.parse(url))
        } else load()
    }

    fun dismiss() { if (::dialog.isInitialized) dialog.dismiss() }

    private fun load() {
        if (closed || loading) return
        loading = true
        status.text = "加载中…"
        status.setOnClickListener(null)
        worker.execute {
            val result = runCatching {
                if (isPdf) {
                    val key = MessageDigest.getInstance("SHA-256").digest(url.toByteArray())
                        .joinToString("") { "%02x".format(it) }
                    val opened = pdf ?: CoursewarePdfRenderer(activity, http).openBlocking(url, "preview-$key").also { pdf = it }
                    val indices = opened.pages?.finalStateIndices() ?: (0 until opened.pageCount).toList()
                    indices.map { index ->
                        if (closed) throw IOException("预览已关闭")
                        opened.pageSize(index).let { DocumentPage(index, it.width, it.height) }
                    } to null
                } else {
                    val file = File.createTempFile("courseware-preview-", ".image", activity.cacheDir)
                    try {
                        http.newCall(Request.Builder().url(url).build()).execute().use { response ->
                            if (!response.isSuccessful) throw IOException("HTTP ${response.code}")
                            val body = response.body ?: throw IOException("图片内容为空")
                            file.outputStream().use { output -> body.byteStream().use { it.copyTo(output) } }
                        }
                        val bitmap = ImageBitmapDecoder.decode(2048) { file.inputStream() } ?: throw IOException("无法读取图片")
                        listOf(DocumentPage(0, bitmap.width, bitmap.height)) to bitmap
                    } finally { file.delete() }
                }
            }
            main.post {
                loading = false
                if (closed) { result.getOrNull()?.second?.recycle(); return@post }
                result.onSuccess { (document, bitmap) ->
                    pages = document
                    bitmap?.let { bitmaps.put(0, it) }
                    status.text = "1 / ${pages.size}"
                    adapter.notifyDataSetChanged()
                }.onFailure {
                    status.text = "点击重试"
                    status.contentDescription = "预览失败：${it.message}，点击重试"
                    status.setOnClickListener { load() }
                }
            }
        }
    }

    /** Render one visible page at a time; a fast fling never queues the whole document. */
    private fun scheduleVisible() {
        if (closed || loading || rendering || !isPdf || list.childCount == 0) return
        val views = (0 until list.childCount).mapNotNull { list.getChildAt(it) as? PageView }
        val target = views.firstOrNull { bitmaps.get(it.position) == null && it.position !in failed } ?: return
        val position = target.position
        val page = pages[position]
        val edge = (list.width * maxOf(1f, page.height.toFloat() / page.width)).toInt().coerceIn(1024, 2048)
        rendering = true
        worker.execute {
            val result = runCatching { requireNotNull(pdf).renderPage(page.pdfIndex, edge) }
            main.post {
                rendering = false
                if (closed) { result.getOrNull()?.recycle(); return@post }
                result.onSuccess { bitmap ->
                    bitmaps.put(position, bitmap)
                    for (i in 0 until list.childCount) {
                        (list.getChildAt(i) as? PageView)?.takeIf { it.position == position }?.setImageBitmap(bitmap)
                    }
                }.onFailure {
                    failed.add(position)
                    status.text = "点击页面重试"
                }
                scheduleVisible()
            }
        }
    }

    private inner class PageView : androidx.appcompat.widget.AppCompatImageView(activity) {
        var ratio = 1f
        var position = -1
        init { scaleType = ImageView.ScaleType.FIT_XY; setBackgroundColor(Color.WHITE) }
        override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
            val width = View.MeasureSpec.getSize(widthMeasureSpec)
            setMeasuredDimension(width, (width * ratio).toInt().coerceAtLeast(1))
        }
    }

    private fun dp(value: Int) = (value * activity.resources.displayMetrics.density).toInt()
    private data class DocumentPage(val pdfIndex: Int, val width: Int, val height: Int)
}
