package cn.edu.nb3.myclass

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.RectF
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.View
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/** 图片投屏界面的操作模式：手势（缩放/拖动）或画笔（标注） */
enum class ImageCastMode { Gesture, Pen }

/**
 * 内容适配方式。
 * - Contain：整页完整显示（图片投屏用）
 * - FitWidth：宽度充满，长内容上下拖动查看（课件用，避免左右留黑边）
 */
enum class ImageFitMode { Contain, FitWidth }

/**
 * 经典图片查看控件：双指缩放、拖动平移、双击放大/还原、90° 步进旋转，
 * 并支持切换到画笔模式做标注。
 *
 * 对外只暴露归一化视口：放大倍数 userScale（1 为完整显示）加上视口中心
 * 在图片中的相对坐标 centerX / centerY（0~1）以及旋转角度，便于同步到大屏。
 * 旋转后 centerX / centerY 是**旋转后画面**中的相对坐标，大屏端按同一约定换算。
 *
 * 画笔笔迹同样使用归一化坐标（见 AnnotationStroke），基准是图片经过
 * translate → rotate → scale 之后的**轴对齐外接矩形（AABB）**，
 * 与大屏端 `coursewareImage.getBoundingClientRect()` 的口径一致，
 * 因此旋转 90/270 时两端 AABB 宽高同步互换，笔迹不会反向错位。
 */
class ZoomableImageView(context: Context) : View(context) {

    var onViewportChanged: ((scale: Float, centerX: Float, centerY: Float, rotationDegrees: Int) -> Unit)? = null

    /** 一笔开始：携带首个点，用于在大屏端建立同一条笔画 */
    var onStrokeBegin: ((strokeId: String, colorHex: String, width: Float, isEraser: Boolean, first: AnnotationPoint) -> Unit)? = null

    /** 一笔过程中的增量点（已节流），可多次回调 */
    var onStrokePoints: ((strokeId: String, points: List<AnnotationPoint>) -> Unit)? = null

    /** 一笔结束，大屏端据此落盘，之后可参与撤销 */
    var onStrokeEnd: ((strokeId: String) -> Unit)? = null

    /** 笔迹数量变化（落笔 / 撤销 / 清空），用于刷新撤销、清空按钮可用性 */
    var onAnnotationCountChanged: (() -> Unit)? = null

    /** 当前旋转角度（0 / 90 / 180 / 270），用于修正拍照方向不对的图片 */
    var rotationDegrees: Int = 0
        private set

    /**
     * 手势 / 画笔模式。画笔模式下单指绘制、双指仍然缩放与拖动，
     * 这样放大后可以直接拖到目标区域继续标注，不必来回切模式。
     */
    var mode: ImageCastMode = ImageCastMode.Gesture
        set(value) {
            if (field == value) return
            finishActiveStroke(notify = false)
            field = value
            invalidate()
        }

    /**
     * 内容适配方式。
     * 课件用 FitWidth：宽度充满屏幕，两侧不留黑边，长页上下拖动查看；
     * 图片用 Contain：整图完整显示。
     */
    var fitMode: ImageFitMode = ImageFitMode.Contain
        set(value) {
            if (field == value) return
            field = value
            measureFit()
            clampTranslation()
            markAnnotationDirty()
            notifyViewport(force = true)
            invalidate()
        }

    /** 当前画笔颜色（#RRGGBB），取自 AnnotationPalette */
    var penColorHex: String = AnnotationPalette.DEFAULT_COLOR

    /** 当前是否为板擦 */
    var penEraser: Boolean = false

    /** 已完成笔迹数量，用于撤销 / 清空按钮置灰 */
    val annotationCount: Int
        get() = strokes.size + remoteStrokes.size

    private val paint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG)
    private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val eraserPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
        // 笔迹画在独立离屏层上，板擦用 CLEAR 只擦笔迹，不会擦掉底下的图片
        xfermode = PorterDuffXfermode(PorterDuff.Mode.CLEAR)
    }
    private val strokePath = Path()

    /** 大屏端笔宽是 CSS 像素，手机端按 dp 呈现，避免高分屏上线条过细 */
    private val density = context.resources.displayMetrics.density

    private var bitmap: Bitmap? = null
    private var fitScale = 1f
    private var fitWidth = 0f
    private var fitHeight = 0f
    private var userScale = 1f
    private var translateX = 0f
    private var translateY = 0f
    private var lastNotifyAt = 0L
    /** 双指手势状态：中心坐标与两指间距，用于同时处理缩放与平移 */
    private var twoFingerCenterX = 0f
    private var twoFingerCenterY = 0f
    private var twoFingerSpan = 0f
    private var twoFingerActive = false

    private val strokes = mutableListOf<AnnotationStroke>()
    private val remoteStrokes = LinkedHashMap<String, AnnotationStroke>()
    private var activeStroke: AnnotationStroke? = null
    private var activeDrawnIndex = 0
    // 待定落点：单指按下时先只记录位置，确认为绘制（移动超过阈值）才真正起笔。
    // 这样双指缩放/平移时第二指落下可直接丢弃落点，不会留下孤立的小点。
    private var pendingStartX = 0f
    private var pendingStartY = 0f
    private var hasPendingStart = false
    private val pendingPoints = mutableListOf<AnnotationPoint>()
    private var strokeSeq = 0
    private var lastSyncAt = 0L

    private var annotationBitmap: Bitmap? = null
    private val annotationCanvas = Canvas()
    private var annotationDirty = true

    private val transformMatrix = Matrix()
    private val displayRect = RectF()

    private val gestureDetector = GestureDetector(context, GestureListener())

    fun setImage(next: Bitmap?, atBottom: Boolean = false) {
        bitmap = next
        // 换图后旧笔迹失去意义（大屏端打开新图片时也会清空标注），仅本地清理
        resetAnnotations()
        resetViewport(atBottom)
        // 换图瞬间控件可能尚未完成布局，fit 为 0 会跳过上报；
        // 等一帧再补发一次，确保大屏拿到当前旋转角度（避免手机端已旋转、大屏仍是 0°）
        post {
            measureFit()
            notifyViewport(force = true)
        }
    }

    /**
     * 复位缩放 / 平移。
     * atBottom = true 表示落到页面底部（用于向前翻页时落在上一页底部，方便继续向上回顾）；
     * 默认落在页面顶部（符合向后翻页的阅读顺序）。
     */
    fun resetViewport(atBottom: Boolean = false) {
        userScale = 1f
        translateX = 0f
        translateY = 0f
        bigScrollActive = false
        bigProgressY = 0f
        measureFit()
        if (fitMode == ImageFitMode.FitWidth) {
            // 宽度充满后页面可能高于屏幕：默认从顶部开始显示；
            // 向前翻页（atBottom）时落在上一页底部，继续按"上一页"可向上逐屏回顾。
            val maxY = max(0f, (fitHeight - height) / 2f)
            translateY = if (atBottom) -maxY else maxY
            if (atBottom && maxY <= 0.5f) {
                // 手机端整页可显示：交给"大屏滚动模式"把大屏对齐到上一页底部
                bigScrollActive = true
                bigProgressY = 1f
            }
        }
        clampTranslation()
        markAnnotationDirty()
        notifyViewport(force = true)
        invalidate()
    }

    /**
     * 顺时针旋转 90°（可指定步长）。旋转后重新按旋转后的画面尺寸适应屏幕，
     * 并复位缩放/平移，保证大屏与手机端看到同一区域。
     * @return 旋转后的角度（0 / 90 / 180 / 270）
     */
    fun rotateBy(stepDegrees: Int = 90): Int {
        rotationDegrees = normalizeRotation(rotationDegrees + stepDegrees)
        userScale = 1f
        translateX = 0f
        translateY = 0f
        measureFit()
        markAnnotationDirty()
        notifyViewport(force = true)
        invalidate()
        return rotationDegrees
    }

    /** 撤销最后一笔，返回是否真的撤销了（供调用方决定是否同步大屏） */
    fun undoAnnotation(): Boolean {
        finishActiveStroke(notify = false)
        flushRemoteStrokes()
        if (strokes.isEmpty()) return false
        strokes.removeAt(strokes.size - 1)
        annotationDirty = true
        invalidate()
        onAnnotationCountChanged?.invoke()
        return true
    }

    /** 清空全部笔迹，返回是否真的清空了 */
    fun clearAnnotations(): Boolean {
        finishActiveStroke(notify = false)
        flushRemoteStrokes()
        if (strokes.isEmpty()) return false
        strokes.clear()
        annotationDirty = true
        invalidate()
        onAnnotationCountChanged?.invoke()
        return true
    }

    /** 仅本地清空笔迹（换图、释放资源等场景），不产生任何同步副作用 */
    fun resetAnnotations() {
        activeStroke = null
        activeDrawnIndex = 0
        hasPendingStart = false
        pendingPoints.clear()
        strokes.clear()
        remoteStrokes.clear()
        annotationDirty = true
        invalidate()
        onAnnotationCountChanged?.invoke()
    }

    /** 释放离屏笔迹层，避免 Activity 重建时堆积 Bitmap */
    fun releaseAnnotationLayer() {
        activeStroke = null
        activeDrawnIndex = 0
        hasPendingStart = false
        pendingPoints.clear()
        strokes.clear()
        remoteStrokes.clear()
        annotationCanvas.setBitmap(null)
        annotationBitmap?.recycle()
        annotationBitmap = null
    }

    // ---- 按页笔迹：课件翻页时保存 / 恢复 ----

    /**
     * 取出当前页笔迹（翻页前调用）。大屏端尚未结束的回传笔画会先落盘，
     * 保证保存下来的是完整的一笔。返回副本，避免外部改动影响内部状态。
     */
    fun currentStrokes(): List<AnnotationStroke> {
        flushRemoteStrokes()
        return strokes.map { it.copy(points = it.points.toMutableList()) }
    }

    /**
     * 载入指定页的笔迹（翻页后调用）。仅本地恢复，不产生任何同步副作用，
     * 也不改动视口——视口由 setImage 负责复位。
     */
    fun replaceStrokes(next: List<AnnotationStroke>) {
        activeStroke = null
        activeDrawnIndex = 0
        hasPendingStart = false
        pendingPoints.clear()
        strokes.clear()
        strokes.addAll(next.map { it.copy(points = it.points.toMutableList()) })
        remoteStrokes.clear()
        annotationDirty = true
        invalidate()
        onAnnotationCountChanged?.invoke()
    }

    // ---- 画笔：大屏端画笔回传（保证两端笔迹栈完全一致）----

    /**
     * 应用大屏端回传的标注动作（大屏本地笔画、板擦、撤销、清空）。
     * 这样大屏擦掉的线手机上也会消失，撤销不会撤错笔画。
     */
    fun applyRemoteAnnotation(payload: RemoteAnnotationPayload) {
        when (payload.action) {
            "begin" -> remoteBegin(payload)
            "points" -> remotePoints(payload)
            "end" -> remoteEnd(payload)
            "undo" -> remoteUndo()
            "clear" -> remoteClear()
        }
    }

    private fun remoteBegin(payload: RemoteAnnotationPayload) {
        val first = payload.points.firstOrNull() ?: return
        remoteStrokes[payload.strokeId] = AnnotationStroke(
            id = "v:${payload.strokeId}",
            colorHex = if (payload.isEraser) ERASER_COLOR else payload.colorHex,
            width = if (payload.width > 0f) payload.width else AnnotationPalette.PEN_WIDTH,
            isEraser = payload.isEraser
        ).also { it.points.add(first) }
        annotationDirty = true
        invalidate()
    }

    private fun remotePoints(payload: RemoteAnnotationPayload) {
        val stroke = remoteStrokes[payload.strokeId] ?: return
        if (stroke.points.isEmpty()) return
        var last = stroke.points.last()
        val threshold = AnnotationPalette.MIN_POINT_DISTANCE
        for (point in payload.points) {
            val dx = point.x - last.x
            val dy = point.y - last.y
            if (dx * dx + dy * dy < threshold * threshold) continue
            stroke.points.add(point)
            last = point
        }
        annotationDirty = true
        invalidate()
    }

    private fun remoteEnd(payload: RemoteAnnotationPayload) {
        val stroke = remoteStrokes.remove(payload.strokeId) ?: return
        if (stroke.points.isNotEmpty()) {
            strokes.add(stroke)
        }
        annotationDirty = true
        invalidate()
        onAnnotationCountChanged?.invoke()
    }

    private fun remoteUndo() {
        // 撤销前把大屏尚未结束的笔画落盘，保证撤销的是完整的一笔
        flushRemoteStrokes()
        if (strokes.isEmpty()) return
        strokes.removeAt(strokes.size - 1)
        annotationDirty = true
        invalidate()
        onAnnotationCountChanged?.invoke()
    }

    private fun remoteClear() {
        remoteStrokes.clear()
        strokes.clear()
        annotationDirty = true
        invalidate()
        onAnnotationCountChanged?.invoke()
    }

    private fun flushRemoteStrokes() {
        if (remoteStrokes.isEmpty()) return
        for (stroke in remoteStrokes.values) {
            if (stroke.points.isNotEmpty()) strokes.add(stroke)
        }
        remoteStrokes.clear()
    }

    private fun normalizeRotation(degrees: Int): Int {
        val modulo = ((degrees % 360) + 360) % 360
        return (modulo / 90) * 90
    }

    /** 旋转 90/270 后画面的宽高互换，适应屏幕时要按互换后的尺寸计算 */
    private fun rotatedSize(image: Bitmap): Pair<Int, Int> =
        if (rotationDegrees == 90 || rotationDegrees == 270) {
            image.height to image.width
        } else {
            image.width to image.height
        }

    private fun measureFit() {
        val image = bitmap
        val viewWidth = width.toFloat()
        val viewHeight = height.toFloat()
        if (image == null || viewWidth <= 0f || viewHeight <= 0f) {
            fitScale = 1f
            fitWidth = 0f
            fitHeight = 0f
            return
        }
        val (imageWidth, imageHeight) = rotatedSize(image)
        fitScale = if (fitMode == ImageFitMode.FitWidth) {
            viewWidth / imageWidth
        } else {
            min(viewWidth / imageWidth, viewHeight / imageHeight)
        }
        fitWidth = imageWidth * fitScale
        fitHeight = imageHeight * fitScale
    }

    /**
     * 图片在控件坐标系中的显示矩形（AABB），使用与 onDraw 完全相同的
     * translate → rotate → scale 变换链，保证落笔与显示不会错位。
     * 返回值是复用的 RectF，调用方需立即使用。
     */
    private fun imageDisplayRect(): RectF? {
        val image = bitmap ?: return null
        if (fitScale <= 0f) return null
        val scale = fitScale * userScale
        transformMatrix.reset()
        transformMatrix.postScale(scale, scale)
        if (rotationDegrees != 0) {
            transformMatrix.postRotate(rotationDegrees.toFloat())
        }
        transformMatrix.postTranslate(width / 2f + translateX, height / 2f + translateY)
        displayRect.set(
            -image.width / 2f,
            -image.height / 2f,
            image.width / 2f,
            image.height / 2f
        )
        transformMatrix.mapRect(displayRect)
        return displayRect
    }

    /** 屏幕坐标 → 归一化图片坐标；落在图片外时返回 null（与大屏端一样忽略） */
    private fun toNormalized(viewX: Float, viewY: Float): AnnotationPoint? {
        val rect = imageDisplayRect() ?: return null
        if (rect.width() <= 0f || rect.height() <= 0f) return null
        val x = (viewX - rect.left) / rect.width()
        val y = (viewY - rect.top) / rect.height()
        if (x < 0f || x > 1f || y < 0f || y > 1f) return null
        return AnnotationPoint(x, y)
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        measureFit()
        if (fitMode == ImageFitMode.FitWidth && userScale <= 1.01f) {
            // 未放大时，尺寸变化（含横竖屏旋转）后重新从顶部对齐，
            // 避免出现竖屏时画面停在页面中间的情况
            translateY = (fitHeight - height) / 2f
            translateX = 0f
        }
        clampTranslation()
        markAnnotationDirty()
        invalidate()
    }

    /**
     * 课件"下一屏 / 上一屏"翻动（FitWidth 长页专用）：
     * direction +1 = 向下看一屏，-1 = 向上看一屏。
     * 返回 true 表示应当真正翻页（已滚到边界、整页一屏能显示完、或处于放大状态），
     * 返回 false 表示本次只是滚动了一屏、尚未越界，调用方不应翻页。
     *
     * - 放大状态（userScale>1）：交给调用方翻页，缩放由换图时的 resetViewport 复位为默认大小；
     * - 页面一屏即可完整显示：直接翻页；
     * - 否则按方向滚动约一屏高度（留 8% 重叠），滚到边界后下一次再按才翻页。
     */
    fun requestScreenStep(direction: Int): Boolean {
        if (bitmap == null || fitScale <= 0f) return true
        if (userScale > 1.01f) {
            // 放大状态：直接翻页并复位缩放
            return true
        }
        val displayHeight = fitHeight * userScale
        val viewHeight = height.toFloat()
        if (displayHeight <= viewHeight) {
            // 手机端整页可显示：大屏（横屏）往往是长页。改用大屏滚动进度驱动大屏逐屏下滚，
            // 滚到底再翻页，避免手机整页直接翻页导致大屏不滚动。
            return stepBigScreen(direction)
        }
        bigScrollActive = false
        val maxY = (displayHeight - viewHeight) / 2f
        val atBottom = translateY <= -maxY + 0.5f
        val atTop = translateY >= maxY - 0.5f
        if (direction > 0 && atBottom) return true
        if (direction < 0 && atTop) return true
        // 滚动一屏（留 8% 重叠，避免相邻屏内容割裂）
        val step = viewHeight * 0.92f
        // 可滚动范围不足一屏（页面只比屏幕高一点点，如横版 PPT）：一屏就能滚完剩余内容，
        // 直接翻页即可，避免"先滚到底、再按一次才翻页"导致要按两下。
        if (2f * maxY <= step) {
            return true
        }
        translateY = (translateY - direction * step).coerceIn(-maxY, maxY)
        clampTranslation()
        markAnnotationDirty()
        notifyViewport(force = true)
        invalidate()
        return false
    }

    // 大屏滚动模式：手机端整页但大屏（横屏）长页时，用大屏滚动进度驱动大屏逐屏滚动
    private var bigScrollActive = false
    private var bigProgressY = 0f

    /**
     * 手机端整页可显示但大屏（横屏）通常是长页时，用"大屏滚动进度"驱动大屏逐屏滚动。
     * 假设投屏大屏为横屏（宽>高），按图片原始宽高比估算大屏是否为长页：
     * - 大屏也是整页：直接翻页；
     * - 大屏长页：累计 bigProgressY，每次推进约一屏，滚到底/顶才返回 true 让调用方翻页。
     * 大屏端收到 progress 后按自身比例换算为本地的逐屏滚动，从而手机整页时大屏仍能逐屏下滚。
     */
    private fun stepBigScreen(direction: Int): Boolean {
        val bmp = bitmap ?: return true
        val imageAspect = bmp.width.toFloat() / bmp.height.toFloat()
        val bigAspectHOverW = 9f / 16f // 大屏高/宽（按 16:9 横屏估算）
        val pageAspectHOverW = 1f / imageAspect // 页面高/宽
        val bigMaxYRatio = (pageAspectHOverW - bigAspectHOverW) / 2f // <=0 表示大屏整页
        if (bigMaxYRatio <= 0f) {
            bigScrollActive = false
            bigProgressY = 0f
            return true
        }
        if (!bigScrollActive) {
            bigScrollActive = true
            bigProgressY = 0f
        }
        // 已经滚到底（向下）/ 顶（向上）：本次才翻页
        if ((direction > 0 && bigProgressY >= 1f - 1e-4f) ||
            (direction < 0 && bigProgressY <= 1e-4f)
        ) {
            // 已到边界：本次翻页。
            // 注意此处不能上报视口：此时当前页尚未换掉，上报 progress=0 会把大屏拉回
            // "本页顶部"，造成翻页前闪一下本页顶部的画面。新页视口由 showPage 换图时
            // 的 resetViewport 统一上报。
            bigScrollActive = false
            bigProgressY = 0f
            return true
        }
        // 大屏一屏（占屏高 92%）对应的进度增量
        val stepRatio = (bigAspectHOverW * 0.92f) / (2f * bigMaxYRatio)
        // 大屏可滚动范围不足一屏（页面只比大屏高一点点，如横版 PPT）：一屏就能滚完，
        // 直接翻页，避免需要按两下才翻页。
        if (stepRatio >= 1f) {
            bigScrollActive = false
            bigProgressY = 0f
            return true
        }
        // 滚动一屏；剩余不足一屏时滚到底/顶，把剩余内容补成一屏显示出来，下次再按才翻页
        bigProgressY = (bigProgressY + direction * stepRatio).coerceIn(0f, 1f)
        notifyViewport(force = true)
        return false
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val image = bitmap ?: return
        canvas.save()
        canvas.translate(width / 2f + translateX, height / 2f + translateY)
        if (rotationDegrees != 0) {
            canvas.rotate(rotationDegrees.toFloat())
        }
        val scale = fitScale * userScale
        canvas.scale(scale, scale)
        canvas.drawBitmap(image, -image.width / 2f, -image.height / 2f, paint)
        canvas.restore()

        if (strokes.isEmpty() && activeStroke == null && remoteStrokes.isEmpty()) return
        ensureAnnotationLayer()
        val layer = annotationBitmap ?: return
        if (annotationDirty) {
            redrawAnnotationLayer()
            annotationDirty = false
        }
        canvas.drawBitmap(layer, 0f, 0f, null)
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                twoFingerActive = false
                if (mode == ImageCastMode.Pen && event.pointerCount == 1) {
                    // 先只记录落点，等确认是单指绘制（移动超过阈值）才真正起笔，
                    // 避免双指缩放 / 平移时把落点提交成"只有一个点的笔画"而留下小点。
                    pendingStartX = event.x
                    pendingStartY = event.y
                    hasPendingStart = true
                }
            }
            MotionEvent.ACTION_POINTER_DOWN -> {
                // 第二指落下：若尚未真正起笔（只是落点），直接丢弃落点，不产生孤立小点；
                // 已经起笔则正常结束当前笔画，进入双指缩放 / 平移。
                if (hasPendingStart) {
                    hasPendingStart = false
                } else {
                    finishActiveStroke(notify = true)
                }
                twoFingerActive = true
                updateTwoFingerState(event)
            }
            MotionEvent.ACTION_MOVE -> {
                when {
                    mode == ImageCastMode.Pen && event.pointerCount == 1 -> {
                        if (hasPendingStart) {
                            val dx = event.x - pendingStartX
                            val dy = event.y - pendingStartY
                            val slop = START_STROKE_SLOP_DP * resources.displayMetrics.density
                            if (dx * dx + dy * dy >= slop * slop) {
                                // 确认为绘制：以最初落点起笔，再补上当前这个移动点
                                hasPendingStart = false
                                startStroke(pendingStartX, pendingStartY)
                                extendStroke(event.x, event.y)
                            }
                        } else {
                            extendStroke(event.x, event.y)
                        }
                    }
                    event.pointerCount >= 2 -> {
                        // 双指手势期间丢弃待定落点，避免抬指后被当成单击画点
                        hasPendingStart = false
                        handleTwoFingerGesture(event)
                    }
                    // 手势模式下单指平移由 GestureListener.onScroll 负责
                }
            }
            MotionEvent.ACTION_POINTER_UP -> {
                // 抬起一指后若只剩单指，重置双指基准，避免下一帧位置跳变
                if (event.pointerCount - 1 <= 1) {
                    twoFingerActive = false
                } else {
                    updateTwoFingerState(event)
                }
            }
            MotionEvent.ACTION_UP -> {
                if (hasPendingStart) {
                    // 单指点击且未移动：补画一个点，保留"单击画点"的能力
                    hasPendingStart = false
                    startStroke(pendingStartX, pendingStartY)
                }
                finishActiveStroke(notify = true)
                notifyViewport(force = true)
                performClick()
            }
            MotionEvent.ACTION_CANCEL -> {
                // 手势被取消：丢弃待定落点，不补画点
                hasPendingStart = false
                finishActiveStroke(notify = true)
                notifyViewport(force = true)
            }
        }
        gestureDetector.onTouchEvent(event)
        return true
    }

    override fun performClick(): Boolean {
        super.performClick()
        return true
    }

    private fun clampTranslation() {
        val maxX = max(0f, (fitWidth * userScale - width) / 2f)
        val maxY = max(0f, (fitHeight * userScale - height) / 2f)
        translateX = translateX.coerceIn(-maxX, maxX)
        translateY = translateY.coerceIn(-maxY, maxY)
    }

    private fun notifyViewport(force: Boolean = false) {
        if (fitWidth <= 0f || fitHeight <= 0f) return
        val now = System.currentTimeMillis()
        if (!force && now - lastNotifyAt < NOTIFY_INTERVAL_MS) return
        lastNotifyAt = now
        val maxX = max(0f, (fitWidth * userScale - width) / 2f)
        val maxY = max(0f, (fitHeight * userScale - height) / 2f)
        // 滚动进度：0 = 顶部/左侧对齐，1 = 底部/右侧对齐；整页可显示时为 0（顶部对齐）。
        // 用进度而非"视口中心位置"做归一化，可消除两端屏幕比例不同造成的错位，
        // 保证手机竖屏与横屏大屏都从页面顶部开始、并逐屏同步滚动。
        // 手机端整页可显示（maxY<=0）且处于"大屏滚动模式"时，上报大屏滚动进度，
        // 让大屏（横屏长页）逐屏下滚，而不是随手机整页一起直接翻页。
        val progressX = if (maxX > 0.5f) (maxX - translateX) / (2f * maxX) else 0f
        val progressY = if (maxY > 0.5f) {
            (maxY - translateY) / (2f * maxY)
        } else if (bigScrollActive) {
            bigProgressY
        } else {
            0f
        }
        onViewportChanged?.invoke(userScale, progressX, progressY, rotationDegrees)
    }

    // ---- 画笔：笔迹生命周期 ----

    private fun startStroke(viewX: Float, viewY: Float) {
        val point = toNormalized(viewX, viewY) ?: return
        val stroke = AnnotationStroke(
            id = "a${++strokeSeq}",
            colorHex = if (penEraser) ERASER_COLOR else penColorHex,
            width = if (penEraser) AnnotationPalette.ERASER_WIDTH else AnnotationPalette.PEN_WIDTH,
            isEraser = penEraser
        )
        stroke.points.add(point)
        activeStroke = stroke
        activeDrawnIndex = 0
        pendingPoints.clear()
        lastSyncAt = System.currentTimeMillis()
        ensureAnnotationLayer()
        if (annotationDirty) {
            redrawAnnotationLayer()
            annotationDirty = false
        }
        appendActiveSegment()
        invalidate()
        onStrokeBegin?.invoke(stroke.id, stroke.colorHex, stroke.width, stroke.isEraser, point)
    }

    private fun extendStroke(viewX: Float, viewY: Float) {
        val stroke = activeStroke ?: return
        val point = toNormalized(viewX, viewY) ?: return
        val last = stroke.points.last()
        val dx = point.x - last.x
        val dy = point.y - last.y
        val threshold = AnnotationPalette.MIN_POINT_DISTANCE
        if (dx * dx + dy * dy < threshold * threshold) return
        stroke.points.add(point)
        pendingPoints.add(point)
        appendActiveSegment()
        invalidate()
        val now = System.currentTimeMillis()
        if (now - lastSyncAt >= AnnotationPalette.SYNC_INTERVAL_MS || pendingPoints.size >= MAX_PENDING_POINTS) {
            flushPendingPoints(stroke)
            lastSyncAt = now
        }
    }

    private fun finishActiveStroke(notify: Boolean) {
        val stroke = activeStroke ?: return
        // 先把尚未发送的点补发出去，再结束笔画。
        // 顺序很关键：若先置空 activeStroke，flush 时取到 null 会直接 return，
        // 最后一段点就丢了，大屏上的笔画会短一截（例如画圆不闭合）。
        flushPendingPoints(stroke)
        activeStroke = null
        strokes.add(stroke)
        annotationDirty = true
        invalidate()
        if (notify) {
            onStrokeEnd?.invoke(stroke.id)
        }
        onAnnotationCountChanged?.invoke()
    }

    private fun flushPendingPoints(stroke: AnnotationStroke?) {
        if (stroke == null || pendingPoints.isEmpty()) return
        val batch = pendingPoints.toList()
        pendingPoints.clear()
        onStrokePoints?.invoke(stroke.id, batch)
    }

    // ---- 画笔：离屏图层渲染 ----

    private fun ensureAnnotationLayer() {
        val w = width
        val h = height
        if (w <= 0 || h <= 0) return
        val current = annotationBitmap
        if (current != null && current.width == w && current.height == h) return
        annotationCanvas.setBitmap(null)
        current?.recycle()
        annotationBitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888).also {
            annotationCanvas.setBitmap(it)
        }
        annotationDirty = true
    }

    private fun redrawAnnotationLayer() {
        val layer = annotationBitmap ?: return
        annotationCanvas.setBitmap(layer)
        layer.eraseColor(Color.TRANSPARENT)
        for (stroke in strokes) {
            drawStroke(annotationCanvas, stroke, 0)
        }
        for (stroke in remoteStrokes.values) {
            drawStroke(annotationCanvas, stroke, 0)
        }
        activeStroke?.let {
            drawStroke(annotationCanvas, it, 0)
            activeDrawnIndex = (it.points.size - 1).coerceAtLeast(0)
        }
    }

    /** 把当前笔画新增的那一段增量画到离屏层，避免每次移动都全量重绘 */
    private fun appendActiveSegment() {
        val stroke = activeStroke ?: return
        val layer = annotationBitmap ?: return
        annotationCanvas.setBitmap(layer)
        drawStroke(annotationCanvas, stroke, activeDrawnIndex)
        activeDrawnIndex = (stroke.points.size - 1).coerceAtLeast(0)
    }

    private fun drawStroke(target: Canvas, stroke: AnnotationStroke, fromIndex: Int) {
        val rect = imageDisplayRect() ?: return
        val points = stroke.points
        if (points.isEmpty()) return
        val targetPaint = if (stroke.isEraser) eraserPaint else strokePaint
        if (!stroke.isEraser) {
            targetPaint.color = runCatching { Color.parseColor(stroke.colorHex) }.getOrDefault(Color.RED)
        }
        targetPaint.strokeWidth = stroke.width * density

        val lastIndex = points.size - 1
        if (lastIndex == 0) {
            // 单点：补画一个圆点，与大屏端 drawAnnotationStroke 的行为一致
            val only = points[0]
            targetPaint.style = Paint.Style.FILL
            target.drawCircle(
                rect.left + only.x * rect.width(),
                rect.top + only.y * rect.height(),
                targetPaint.strokeWidth / 2f,
                targetPaint
            )
            targetPaint.style = Paint.Style.STROKE
            return
        }

        // 增量绘制时从上一已绘制点开始，保证线段连续
        val startIndex = if (fromIndex <= 0) 0 else fromIndex - 1
        strokePath.rewind()
        for (index in startIndex..lastIndex) {
            val point = points[index]
            val px = rect.left + point.x * rect.width()
            val py = rect.top + point.y * rect.height()
            if (index == startIndex) strokePath.moveTo(px, py) else strokePath.lineTo(px, py)
        }
        target.drawPath(strokePath, targetPaint)
        strokePath.rewind()
    }

    private fun markAnnotationDirty() {
        if (strokes.isNotEmpty() || activeStroke != null) {
            annotationDirty = true
        }
    }

    // ---- 双指手势：缩放 + 平移同时处理 ----
    // ScaleGestureDetector 只在两指间距变化超阈值时才回调 onScale，纯双指拖动
    // 不会触发，导致放大后拖不动。因此改为自己计算：两指中心位移 = 平移，
    // 两指间距比值 = 缩放，一步到位，无论是否捏合都能平移。
    private fun twoFingerDistance(event: MotionEvent): Float {
        val dx = event.getX(1) - event.getX(0)
        val dy = event.getY(1) - event.getY(0)
        return hypot(dx, dy)
    }

    private fun updateTwoFingerState(event: MotionEvent) {
        if (event.pointerCount < 2) return
        twoFingerCenterX = (event.getX(0) + event.getX(1)) / 2f
        twoFingerCenterY = (event.getY(0) + event.getY(1)) / 2f
        twoFingerSpan = twoFingerDistance(event)
    }

    private fun handleTwoFingerGesture(event: MotionEvent) {
        if (event.pointerCount < 2 || !twoFingerActive) return
        val cx = (event.getX(0) + event.getX(1)) / 2f
        val cy = (event.getY(0) + event.getY(1)) / 2f
        val span = twoFingerDistance(event)

        // 平移：双指中心相对上一帧的位移
        val dx = cx - twoFingerCenterX
        val dy = cy - twoFingerCenterY

        // 缩放：间距变化，围绕双指中心进行（焦点在屏幕上的位置保持不变）
        val previous = userScale
        val scaleFactor = if (twoFingerSpan > 0f) span / twoFingerSpan else 1f
        val next = (previous * scaleFactor).coerceIn(1f, MAX_SCALE)
        val ratio = next / previous
        val focusX = cx - width / 2f
        val focusY = cy - height / 2f
        translateX = (translateX - focusX) * ratio + focusX
        translateY = (translateY - focusY) * ratio + focusY

        // 叠加双指平移量
        translateX += dx
        translateY += dy

        twoFingerCenterX = cx
        twoFingerCenterY = cy
        twoFingerSpan = span
        userScale = next
        clampTranslation()
        markAnnotationDirty()
        notifyViewport()
        invalidate()
    }

    private inner class GestureListener : GestureDetector.SimpleOnGestureListener() {
        override fun onDown(e: MotionEvent): Boolean = true

        override fun onScroll(
            e1: MotionEvent?,
            e2: MotionEvent,
            distanceX: Float,
            distanceY: Float
        ): Boolean {
            // 画笔模式：单指留给绘制；双指缩放 / 平移由 onTouchEvent 自管，避免重复平移
            if (mode == ImageCastMode.Pen) return false
            if (e2.pointerCount > 1) return false
            translateX -= distanceX
            translateY -= distanceY
            clampTranslation()
            markAnnotationDirty()
            notifyViewport()
            invalidate()
            return true
        }

        override fun onDoubleTap(e: MotionEvent): Boolean {
            // 画笔模式下禁用双击缩放，避免绘制过程中的误触
            if (mode == ImageCastMode.Pen) return true
            if (userScale > 1.01f) {
                userScale = 1f
                translateX = 0f
                translateY = 0f
            } else {
                userScale = DOUBLE_TAP_SCALE
                clampTranslation()
            }
            markAnnotationDirty()
            notifyViewport(force = true)
            invalidate()
            return true
        }
    }

    companion object {
        private const val MAX_SCALE = 8f
        private const val DOUBLE_TAP_SCALE = 2.5f
        private const val NOTIFY_INTERVAL_MS = 80L
        /** 单次批量上报的最大点数，防止弱网下积压过多 */
        private const val MAX_PENDING_POINTS = 12
        /** 起笔判定阈值（dp）：单指移动超过该距离才认定为绘制，避免落点被误判成笔画 */
        private const val START_STROKE_SLOP_DP = 6f
        /** 板擦不依赖颜色（大屏端固定 #000），这里给一个占位色 */
        private const val ERASER_COLOR = "#000000"
    }
}
