package cn.edu.nb3.myclass

import android.app.Activity
import android.app.Dialog
import android.content.Context
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import android.util.TypedValue
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.google.android.material.button.MaterialButton

/**
 * 演讲者视图（全屏）：当前页 / 下一页预览、演讲备注（可就地修改）、当前页视频、计时器、页码进度。
 *
 * 界面按横竖屏自适应：
 * - 横屏：左侧当前页，右侧上下分成下一页与备注；
 * - 竖屏：当前页 / 下一页 / 备注纵向排布。
 * 编辑备注时临时收起预览，把整块空间让给输入框（键盘弹起后仍然够用）。
 *
 * 预览优先复用课件主界面已经渲染好的位图（按比例缩成预览图），没有时才自己渲染，
 * 并缓存最近几页：来回翻页不需要重新渲染。自己渲染/生成的位图由本类回收，
 * 主界面的位图只读取、不回收。
 */
class CoursewarePresenter(
    private val activity: Activity,
    private val notes: CoursewareNotes,
    private val timer: PresentationTimer,
    private val totalPages: () -> Int,
    private val currentPage: () -> Int,
    private val slideNumber: () -> Int,
    private val slideTotal: () -> Int,
    private val step: (Int) -> Unit,
    private val renderPage: (page: Int, maxEdge: Int, onDone: (Bitmap?) -> Unit) -> Unit,
    /** 主界面已渲染的页位图（只读，不回收）；没有则返回 null。 */
    private val sharedBitmap: (Int) -> Bitmap? = { null },
    /** 当前幻灯片是否有内嵌视频。 */
    private val hasVideo: () -> Boolean = { false },
    /** 打开本页视频的选择 / 遥控面板。 */
    private val openVideo: () -> Unit = {}
) {
    private class PagePane(val view: LinearLayout, val image: ImageView, val hint: TextView)

    private companion object {
        const val PREVIEW_MAIN_EDGE = 1200
        const val PREVIEW_NEXT_EDGE = 800
        const val PREVIEW_CACHE_LIMIT = 3
    }

    private var dialog: Dialog? = null
    private var currentPane: PagePane? = null
    private var nextPane: PagePane? = null
    private var notesPane: LinearLayout? = null
    private var progressLabel: TextView? = null
    private var progressBar: ProgressBar? = null
    private var timerLabel: TextView? = null
    private var pauseButton: MaterialButton? = null
    private var notesBody: TextView? = null
    private var notesScroll: ScrollView? = null
    private var notesEditor: EditText? = null
    private var notesAction: MaterialButton? = null
    private var notesCancel: MaterialButton? = null
    private var notesStatus: TextView? = null
    private var videoButton: MaterialButton? = null
    private var fontDownButton: MaterialButton? = null
    private var fontUpButton: MaterialButton? = null
    /** 备注字号四档（sp），默认 16；选择记在本机，换课件/重启后保持 */
    private val noteSizesSp = floatArrayOf(14f, 16f, 18f, 20f)
    private var noteSizeIndex = activity.getSharedPreferences("myclass_ui", Context.MODE_PRIVATE)
        .getInt("presenterNoteSize", 1).coerceIn(0, noteSizesSp.lastIndex)
    /** 预览缓存：页码 → 自己生成/缩放的位图（最近几页，来回翻页不重复渲染） */
    private val previewCache = LinkedHashMap<Int, Bitmap>()

    private var editing = false
    private var saving = false
    private var previewGeneration = 0
    private var renderedPage = -1
    private var renderedTotal = -1
    private var previewFailed = false
    private var retryCount = 0

    private val handler = Handler(Looper.getMainLooper())
    private val ticker = object : Runnable {
        override fun run() {
            updateTimerUi()
            if (dialog != null) handler.postDelayed(this, 500L)
        }
    }

    fun isShowing(): Boolean = dialog?.isShowing == true

    fun show() {
        if (isShowing()) return
        timer.startIfNeeded()
        renderedPage = -1
        renderedTotal = -1
        val next = Dialog(activity)
        next.requestWindowFeature(android.view.Window.FEATURE_NO_TITLE)
        next.setContentView(buildRoot())
        next.setOnDismissListener { cleanup() }
        next.setCanceledOnTouchOutside(false)
        next.show()
        next.window?.apply {
            setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            setBackgroundDrawable(ColorDrawable(Color.BLACK))
            @Suppress("DEPRECATION")
            setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        }
        next.window?.let { window ->
            WindowCompat.setDecorFitsSystemWindows(window, false)
            WindowInsetsControllerCompat(window, window.decorView).apply {
                hide(WindowInsetsCompat.Type.systemBars())
                systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        }
        dialog = next
        refresh(force = true)
        updateTimerUi()
        handler.removeCallbacks(ticker)
        handler.post(ticker)
    }

    fun dismiss() {
        dialog?.dismiss()
        dialog = null
    }

    /** 页面、备注、课件状态变化时由主界面调用。 */
    fun refresh(force: Boolean = false) {
        if (dialog == null) return
        updateHeader()
        if (!editing) renderNotesBody()
        updateVideoButton()
        val page = currentPage()
        val total = totalPages()
        if (force || page != renderedPage || total != renderedTotal || previewFailed) {
            renderPreviews()
        }
    }

    /** 横竖屏切换：保留编辑中的草稿，按新方向重建布局。 */
    fun onConfigurationChanged() {
        val active = dialog ?: return
        val wasEditing = editing
        val draft = notesEditor?.text?.toString().orEmpty()
        if (saving) return
        editing = false
        releaseBitmaps()
        active.setContentView(buildRoot())
        active.window?.apply {
            setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            WindowCompat.setDecorFitsSystemWindows(this, false)
            WindowInsetsControllerCompat(this, decorView).apply {
                hide(WindowInsetsCompat.Type.systemBars())
                systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        }
        renderedPage = -1
        renderedTotal = -1
        if (wasEditing) enterEdit(draft) else refresh(force = true)
    }

    // ---------------------------------------------------------------- 布局

    private fun buildRoot(): LinearLayout {
        val root = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.BLACK)
        }
        val landscape = activity.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
        val padding = dp(10)
        root.addView(buildHeader(), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(44)))
        root.addView(
            buildBody(landscape).apply { setPadding(padding, 0, padding, 0) },
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
        )
        root.addView(buildFooter(), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52)))
        root.addView(buildProgressBar(), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(3)))
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            // 对话框窗口是 edge-to-edge 的：系统栏隐藏后仍要避开刘海，编辑备注时
            // 还要让键盘真正把内容顶上去（否则页脚和“保存”会被键盘盖住）。
            val cutout = insets.getInsets(WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            view.setPadding(cutout.left, cutout.top, cutout.right, maxOf(cutout.bottom, ime.bottom))
            insets
        }
        ViewCompat.requestApplyInsets(root)
        return root
    }

    private fun buildHeader(): LinearLayout {
        val row = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), 0, dp(8), 0)
        }
        row.addView(label("演讲者视图", 16f, R.color.myclass_on_surface).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        })
        progressLabel = label("", 14f, R.color.myclass_muted).apply {
            gravity = Gravity.END
            setSingleLine(true)
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                marginStart = dp(10)
                marginEnd = dp(10)
            }
        }
        row.addView(progressLabel)
        // 备注字号：A− / A+ 四档，设置保存在本机（不同老师/设备互不影响）
        fontDownButton = actionButton("A−", filled = false, textSize = 12f).apply {
            layoutParams = LinearLayout.LayoutParams(dp(40), dp(34)).apply { marginEnd = dp(4) }
            setOnClickListener { changeNoteSize(-1) }
        }
        row.addView(fontDownButton)
        fontUpButton = actionButton("A+", filled = false, textSize = 12f).apply {
            layoutParams = LinearLayout.LayoutParams(dp(40), dp(34)).apply { marginEnd = dp(8) }
            setOnClickListener { changeNoteSize(1) }
        }
        row.addView(fontUpButton)
        row.addView(actionButton("关闭", filled = false, textSize = 13f).apply {
            layoutParams = LinearLayout.LayoutParams(dp(64), dp(34))
            setOnClickListener { dismiss() }
        })
        return row
    }

    private fun buildBody(landscape: Boolean): LinearLayout {
        val body = LinearLayout(activity).apply {
            orientation = if (landscape) LinearLayout.HORIZONTAL else LinearLayout.VERTICAL
        }
        currentPane = buildPagePane("当前页")
        nextPane = buildPagePane("下一页")
        notesPane = buildNotesPane()
        val current = requireNotNull(currentPane)
        val next = requireNotNull(nextPane)
        val notesView = requireNotNull(notesPane)
        if (landscape) {
            body.addView(current.view, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 3f).apply {
                marginEnd = dp(8)
            })
            val side = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
            side.addView(next.view, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 0.55f))
            side.addView(notesView, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1.45f).apply {
                topMargin = dp(8)
            })
            body.addView(side, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 2f))
        } else {
            body.addView(current.view, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1.35f))
            body.addView(next.view, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 0.55f).apply {
                topMargin = dp(8)
            })
            body.addView(notesView, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1.15f).apply {
                topMargin = dp(8)
            })
        }
        return body
    }

    private fun buildPagePane(title: String): PagePane {
        val pane = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#0B1620"))
            setPadding(dp(8), dp(5), dp(8), dp(6))
        }
        val header = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        header.addView(label(title, 12f, R.color.myclass_muted))
        val hint = label("", 11f, R.color.myclass_muted).apply {
            gravity = Gravity.END
            setSingleLine(true)
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        header.addView(hint)
        pane.addView(header, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(20)))
        val host = FrameLayout(activity)
        val image = ImageView(activity).apply {
            layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            scaleType = ImageView.ScaleType.FIT_CENTER
        }
        host.addView(image)
        pane.addView(host, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        return PagePane(pane, image, hint)
    }

    private fun buildNotesPane(): LinearLayout {
        val pane = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#0B1620"))
            setPadding(dp(8), dp(4), dp(8), dp(6))
        }
        val header = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        header.addView(label("演讲备注", 12f, R.color.myclass_muted))
        notesStatus = label("", 12f, R.color.myclass_muted).apply {
            gravity = Gravity.END
            setSingleLine(true)
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                marginStart = dp(8)
                marginEnd = dp(8)
            }
        }
        header.addView(notesStatus)
        // 当前幻灯片有内嵌视频时才有入口；视频仍在大屏播放，这里负责选片与遥控。
        videoButton = actionButton("本页视频", filled = false, textSize = 12f).apply {
            layoutParams = LinearLayout.LayoutParams(dp(72), dp(30)).apply { marginEnd = dp(6) }
            visibility = View.GONE
            setOnClickListener { if (!editing && !saving) openVideo() }
        }
        header.addView(videoButton)
        notesAction = actionButton("编辑", filled = false, textSize = 12f).apply {
            layoutParams = LinearLayout.LayoutParams(dp(60), dp(30))
            setOnClickListener { if (editing) saveNote() else enterEdit() }
        }
        header.addView(notesAction)
        notesCancel = actionButton("取消", filled = false, textSize = 12f).apply {
            layoutParams = LinearLayout.LayoutParams(dp(56), dp(30)).apply { marginStart = dp(6) }
            visibility = View.GONE
            setOnClickListener { exitEdit() }
        }
        header.addView(notesCancel)
        pane.addView(header, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(32)))

        val host = FrameLayout(activity)
        notesScroll = ScrollView(activity).apply {
            isFillViewport = true
            layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        }
        notesBody = TextView(activity).apply {
            textSize = 16f
            setTextColor(ContextCompat.getColor(activity, R.color.myclass_on_surface))
            setTextIsSelectable(true)
            setLineSpacing(dp(3).toFloat(), 1f)
            setPadding(dp(2), dp(6), dp(2), dp(6))
        }
        notesScroll?.addView(notesBody)
        host.addView(notesScroll)
        notesEditor = EditText(activity).apply {
            textSize = 16f
            setTextColor(ContextCompat.getColor(activity, R.color.myclass_on_surface))
            setHintTextColor(ContextCompat.getColor(activity, R.color.myclass_muted))
            setHint("输入本页备注；只给老师看，不会投到大屏")
            gravity = Gravity.TOP or Gravity.START
            isVerticalScrollBarEnabled = true
            setPadding(dp(8), dp(6), dp(8), dp(6))
            visibility = View.GONE
            layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        }
        host.addView(notesEditor)
        pane.addView(host, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        applyNoteFont()
        return pane
    }

    private fun buildFooter(): LinearLayout {
        val row = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(10), dp(6), dp(10), dp(6))
        }
        row.addView(actionButton("上一页", filled = false, textSize = 14f).apply {
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f)
            setOnClickListener { go(-1) }
        })
        timerLabel = label("00:00", 17f, R.color.myclass_on_surface).apply {
            gravity = Gravity.CENTER
            isSingleLine = true
            layoutParams = LinearLayout.LayoutParams(dp(76), ViewGroup.LayoutParams.MATCH_PARENT)
        }
        row.addView(timerLabel)
        pauseButton = actionButton("暂停", filled = false, textSize = 12f).apply {
            layoutParams = LinearLayout.LayoutParams(dp(50), dp(36)).apply { marginEnd = dp(6) }
            setOnClickListener {
                if (timer.isRunning) timer.pause() else timer.resume()
                updateTimerUi()
            }
        }
        row.addView(pauseButton)
        row.addView(actionButton("重置", filled = false, textSize = 12f).apply {
            layoutParams = LinearLayout.LayoutParams(dp(50), dp(36))
            setOnClickListener {
                timer.reset()
                timer.startIfNeeded()
                updateTimerUi()
            }
        })
        row.addView(actionButton("下一页", filled = true, textSize = 14f).apply {
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f).apply {
                marginStart = dp(6)
            }
            setOnClickListener { go(1) }
        })
        return row
    }

    private fun buildProgressBar(): ProgressBar {
        val bar = ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 1000
            progress = 0
            progressTintList = ColorStateList.valueOf(ContextCompat.getColor(activity, R.color.myclass_primary))
            progressBackgroundTintList = ColorStateList.valueOf(Color.parseColor("#1A2230"))
            minimumHeight = dp(3)
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(3))
        }
        progressBar = bar
        return bar
    }

    private fun label(text: String, size: Float, colorRes: Int): TextView = TextView(activity).apply {
        this.text = text
        textSize = size
        setTextColor(ContextCompat.getColor(activity, colorRes))
    }

    private fun actionButton(text: String, filled: Boolean, textSize: Float): MaterialButton = MaterialButton(activity).apply {
        this.text = text
        this.textSize = textSize
        isAllCaps = false
        minWidth = 0
        minimumWidth = 0
        minHeight = 0
        minimumHeight = 0
        insetTop = 0
        insetBottom = 0
        setPadding(0, 0, 0, 0)
        cornerRadius = dp(8)
        if (filled) {
            backgroundTintList = ColorStateList.valueOf(ContextCompat.getColor(activity, R.color.myclass_primary))
            setTextColor(Color.WHITE)
        } else {
            backgroundTintList = ColorStateList.valueOf(Color.TRANSPARENT)
            strokeWidth = dp(1)
            strokeColor = ColorStateList.valueOf(ContextCompat.getColor(activity, R.color.myclass_outline))
            setTextColor(ContextCompat.getColor(activity, R.color.myclass_on_surface))
        }
    }

    // ---------------------------------------------------------------- 状态刷新

    private fun updateHeader() {
        val totalSlides = slideTotal().coerceAtLeast(1)
        progressLabel?.text = "第 ${slideNumber().coerceIn(1, totalSlides)} / $totalSlides 页"
        val total = totalPages()
        val page = currentPage()
        progressBar?.progress = when {
            total <= 1 -> 0
            else -> ((page - 1) * 1000 / (total - 1)).coerceIn(0, 1000)
        }
    }

    private fun updateTimerUi() {
        timerLabel?.text = timer.format()
        pauseButton?.text = if (timer.isRunning) "暂停" else "继续"
    }

    private fun renderNotesBody() {
        val text = notes.noteText(slideNumber())
        notesBody?.text = text.ifBlank { "本页没有备注。点“编辑”可以添加，磨课时随时修改。" }
        notesBody?.setTextColor(ContextCompat.getColor(activity,
            if (text.isBlank()) R.color.myclass_muted else R.color.myclass_on_surface))
    }

    private fun renderPreviews() {
        val page = currentPage()
        val total = totalPages()
        renderedPage = page
        renderedTotal = total
        previewFailed = false
        retryCount = 0
        val generation = ++previewGeneration
        if (total <= 0) {
            currentPane?.hint?.text = "正在加载课件…"
            nextPane?.hint?.text = ""
            currentPane?.image?.setImageDrawable(null)
            nextPane?.image?.setImageDrawable(null)
            previewFailed = true
            scheduleRetry(generation)
            return
        }
        drawPreview(currentPane, page, PREVIEW_MAIN_EDGE, generation)
        if (page < total) {
            drawPreview(nextPane, page + 1, PREVIEW_NEXT_EDGE, generation)
        } else {
            nextPane?.image?.setImageDrawable(null)
            nextPane?.hint?.text = "已是最后一页"
        }
    }

    private fun previewFor(page: Int): Bitmap? = previewCache[page]?.takeIf { !it.isRecycled }

    private fun putPreview(page: Int, bitmap: Bitmap) {
        // 只做缓存替换，不立即 recycle：旧位图可能还挂在某个 ImageView 上，
        // 立刻回收会让画面显示一张已回收的位图。真正回收放在 releaseBitmaps()。
        previewCache[page] = bitmap
        while (previewCache.size > PREVIEW_CACHE_LIMIT) {
            previewCache.remove(previewCache.keys.first())
        }
    }

    /** 主界面已渲染好的页位图按比例缩成预览图；尺寸相同也必须复制，不能回收主界面的位图 */
    private fun scaledCopy(source: Bitmap, maxEdge: Int): Bitmap? {
        val longest = maxOf(source.width, source.height).coerceAtLeast(1)
        val scale = (maxEdge.toFloat() / longest).coerceAtMost(1f)
        val width = maxOf(1, (source.width * scale).toInt())
        val height = maxOf(1, (source.height * scale).toInt())
        if (width == source.width && height == source.height) return source.copy(Bitmap.Config.ARGB_8888, false)
        return Bitmap.createScaledBitmap(source, width, height, true)
    }

    private fun drawPreview(pane: PagePane?, page: Int, maxEdge: Int, generation: Int) {
        pane ?: return
        // 1) 预览缓存命中：来回翻页瞬间显示
        val cached = previewFor(page)
        if (cached != null) {
            pane.image.setImageBitmap(cached)
            pane.hint.text = ""
            return
        }
        // 2) 主界面已经渲染过这一页：缩放复制，省掉一次完整渲染
        val shared = sharedBitmap(page)?.takeIf { !it.isRecycled }
        if (shared != null) {
            val copy = runCatching { scaledCopy(shared, maxEdge) }.getOrNull()
            if (copy != null) {
                putPreview(page, copy)
                pane.image.setImageBitmap(copy)
                pane.hint.text = ""
                return
            }
        }
        // 3) 兜底：自己渲染（分辨率比主界面低，速度更快）
        pane.hint.text = "正在渲染…"
        renderPage(page, maxEdge) { bitmap ->
            if (dialog == null || generation != previewGeneration) return@renderPage
            if (bitmap == null) {
                pane.hint.text = "预览加载中…"
                previewFailed = true
                scheduleRetry(generation)
                return@renderPage
            }
            putPreview(page, bitmap)
            pane.image.setImageBitmap(bitmap)
            pane.hint.text = ""
        }
    }

    private fun scheduleRetry(generation: Int) {
        if (retryCount >= 8) return
        retryCount++
        handler.postDelayed({
            if (dialog != null && !editing && generation == previewGeneration) renderPreviews()
        }, 900L)
    }

    // ---------------------------------------------------------------- 备注编辑

    private fun enterEdit(draft: String? = null) {
        if (editing || saving) return
        val text = draft ?: notes.noteText(slideNumber())
        editing = true
        currentPane?.view?.visibility = View.GONE
        nextPane?.view?.visibility = View.GONE
        notesScroll?.visibility = View.GONE
        notesEditor?.apply {
            setText(text)
            setSelection(text.length)
            visibility = View.VISIBLE
            requestFocus()
        }
        notesAction?.text = "保存"
        notesCancel?.visibility = View.VISIBLE
        notesStatus?.setTextColor(ContextCompat.getColor(activity, R.color.myclass_muted))
        notesStatus?.text = ""
        updateVideoButton()
        notesEditor?.post {
            activity.getSystemService(InputMethodManager::class.java)
                ?.showSoftInput(notesEditor, InputMethodManager.SHOW_IMPLICIT)
        }
    }

    private fun exitEdit() {
        editing = false
        currentPane?.view?.visibility = View.VISIBLE
        nextPane?.view?.visibility = View.VISIBLE
        notesScroll?.visibility = View.VISIBLE
        notesEditor?.visibility = View.GONE
        notesAction?.text = "编辑"
        notesCancel?.visibility = View.GONE
        hideKeyboard()
        renderNotesBody()
        updateVideoButton()
    }

    private fun saveNote() {
        if (saving) return
        val slide = slideNumber()
        val text = notesEditor?.text?.toString().orEmpty()
        saving = true
        notesAction?.isEnabled = false
        notesCancel?.isEnabled = false
        notesStatus?.setTextColor(ContextCompat.getColor(activity, R.color.myclass_muted))
        notesStatus?.text = "正在保存…"
        notes.saveNote(slide, text) { result ->
            saving = false
            notesAction?.isEnabled = true
            notesCancel?.isEnabled = true
            result.onSuccess {
                exitEdit()
                notesStatus?.setTextColor(ContextCompat.getColor(activity, R.color.myclass_primary))
                notesStatus?.text = "已保存"
            }.onFailure { error ->
                notesStatus?.setTextColor(ContextCompat.getColor(activity, R.color.myclass_alert))
                notesStatus?.text = error.message ?: "保存失败，请检查网络后重试"
            }
        }
    }

    private fun hideKeyboard() {
        val editor = notesEditor ?: return
        activity.getSystemService(InputMethodManager::class.java)
            ?.hideSoftInputFromWindow(editor.windowToken, 0)
    }

    // ---------------------------------------------------------------- 翻页与生命周期

    private fun go(delta: Int) {
        if (editing || saving) return
        val before = currentPage()
        step(delta)
        if (currentPage() == before) return
        notesStatus?.text = ""
        refresh(force = true)
    }

    private fun releaseBitmaps() {
        // 先摘掉 ImageView 上的引用，再回收缓存位图，避免绘制已回收位图。
        listOf(currentPane, nextPane).forEach { it?.image?.setImageDrawable(null) }
        previewCache.values.forEach { runCatching { it.recycle() } }
        previewCache.clear()
    }

    private fun updateVideoButton() {
        val button = videoButton ?: return
        button.visibility = if (!editing && hasVideo()) View.VISIBLE else View.GONE
    }

    /** 备注字号（阅读与编辑同步），并维护 A−/A+ 在两端时的置灰状态 */
    private fun applyNoteFont() {
        val size = noteSizesSp[noteSizeIndex]
        notesBody?.setTextSize(TypedValue.COMPLEX_UNIT_SP, size)
        notesEditor?.setTextSize(TypedValue.COMPLEX_UNIT_SP, size)
        val canDown = noteSizeIndex > 0
        val canUp = noteSizeIndex < noteSizesSp.lastIndex
        fontDownButton?.apply {
            isEnabled = canDown
            alpha = if (canDown) 1f else 0.4f
        }
        fontUpButton?.apply {
            isEnabled = canUp
            alpha = if (canUp) 1f else 0.4f
        }
    }

    private fun changeNoteSize(delta: Int) {
        val next = (noteSizeIndex + delta).coerceIn(0, noteSizesSp.lastIndex)
        if (next == noteSizeIndex) return
        noteSizeIndex = next
        activity.getSharedPreferences("myclass_ui", Context.MODE_PRIVATE).edit()
            .putInt("presenterNoteSize", noteSizeIndex).apply()
        applyNoteFont()
    }

    private fun cleanup() {
        handler.removeCallbacksAndMessages(null)
        previewGeneration++
        editing = false
        saving = false
        releaseBitmaps()
        currentPane = null
        nextPane = null
        notesPane = null
        progressLabel = null
        progressBar = null
        timerLabel = null
        pauseButton = null
        notesBody = null
        notesScroll = null
        notesEditor = null
        notesAction = null
        notesCancel = null
        notesStatus = null
        videoButton = null
        fontDownButton = null
        fontUpButton = null
        dialog = null
    }

    private fun dp(value: Int): Int =
        (value * activity.resources.displayMetrics.density).toInt()
}
