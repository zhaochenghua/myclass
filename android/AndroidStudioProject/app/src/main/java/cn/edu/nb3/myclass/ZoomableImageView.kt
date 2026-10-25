package cn.edu.nb3.myclass

import android.content.Context
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
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
 * 经典图片查看控件：双指缩放、拖动平移、90° 步进旋转，
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

    /**
     * 点动翻页：点击屏幕左半边向前翻（上一页）、右半边向后翻（下一页）。
     * direction 为 -1 / +1，与「上一屏 / 下一屏」按钮同一条路径。
     *
     * 手势模式下单指点击即可；画笔模式下单指留给绘制，改为**双指点击**触发，
     * 与 iOS 端的"点动翻页（非画笔单指、画笔双指）"一致。
     * 单指抬起立即翻页，避免快速连续点击被双击手势拦截。
     */
    var onPageTap: ((direction: Int) -> Unit)? = null

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

    /**
     * 横向课件（宽高比 ≥ 1.2，即 4:3 / 16:9 这类 PPT 页）在横屏舞台上按宽度铺满时，
     * 只要舞台比课件更扁就会被裁掉底部一点点，"下一屏"会据此判定"一屏放不下"，
     * 先做本地逐屏滚动，于是一张课件要按两次才翻得过去（与 iOS 端同款问题）。
     *
     * 开启本开关后，这类课件会收窄到"整页刚好放得下"（两侧各留一点黑边），一次翻页；
     * 竖向长课件（A4 等）仍按宽度铺满 + 逐屏滚动，否则收窄后小得没法看。
     *
     * 与 iOS 端 `web/ios/js/app.js` 的 `applyCoursewareFit` 策略一致。
     */
    var fitPageForWidePages: Boolean = false
        set(value) {
            if (field == value) return
            field = value
            measureFit()
            clampTranslation()
            markAnnotationDirty()
            notifyViewport(force = true)
            invalidate()
        }

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
    /** 速度笔锋的轮廓路径（可复用，避免每帧新建对象） */
    private val inkPath = Path()
    /** 当前笔画起笔时刻（uptimeMillis），用于给每个点算相对时间戳 */
    private var strokeStartedAtMs = 0L

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
    // 画笔模式的"双指点击翻页"：两指同时落下、几乎不移动、快速抬起才算点击，
    // 一旦有缩放/拖动就取消，避免翻页与手势互相干扰。
    private var twoFingerTapCandidate = false
    private var twoFingerTapDownTime = 0L
    private var twoFingerTapX = 0f
    private var twoFingerTapP0X = 0f
    private var twoFingerTapP0Y = 0f
    private var twoFingerTapP1X = 0f
    private var twoFingerTapP1Y = 0f
    private val pendingPoints = mutableListOf<AnnotationPoint>()
    /** 最后一个已经发给大屏的点：本地全量渲染，传输按像素距离降采样 */
    private var lastSyncedPoint: AnnotationPoint? = null
    private var strokeSeq = 0
    private var lastSyncAt = 0L

    // ---- 手写笔防误触 ----
    /** 当前这一笔是手写笔（含笔尾橡皮）画的：掌托 / 手指的额外触点一律不参与绘制与缩放 */
    private var stylusInk = false
    /** 手写笔抬笔后的屏蔽窗口：掌托边缘刚离开又落下时不会画出杂笔或触发翻页 */
    private var stylusGuardUntil = 0L
    /** 本次手势判定为掌托误触，整个手势直接丢弃 */
    private var palmIgnored = false

    private var annotationBitmap: Bitmap? = null
    private val annotationCanvas = Canvas()
    private var annotationDirty = true

    private val transformMatrix = Matrix()
    private val displayRect = RectF()

    private val gestureDetector = GestureDetector(context, GestureListener()).apply { setOnDoubleTapListener(null) }

    fun setImage(next: Bitmap?, atBottom: Boolean = false) {
        reportedViewerRect = null
        bitmap = next
        // The owner restores the new file/page's saved notes immediately afterward.
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
    var clearedHistory: MutableList<List<AnnotationStroke>> = mutableListOf()
    val canUndoAnnotation: Boolean get() = annotationCount > 0 || clearedHistory.isNotEmpty()

    fun undoAnnotation(): Boolean {
        finishActiveStroke(notify = false)
        flushRemoteStrokes()
        if (strokes.isNotEmpty()) strokes.removeAt(strokes.size - 1)
        else if (clearedHistory.isNotEmpty()) strokes.addAll(clearedHistory.removeAt(clearedHistory.lastIndex))
        else return false
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
        clearedHistory.add(currentStrokes())
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
        lastSyncedPoint = null
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
        lastSyncedPoint = null
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
        lastSyncedPoint = null
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
            isEraser = payload.isEraser,
            mode = payload.mode,
            lineMode = payload.lineMode
        ).also { it.points.add(first) }
        annotationDirty = true
        invalidate()
    }

    private fun remotePoints(payload: RemoteAnnotationPayload) {
        val stroke = remoteStrokes[payload.strokeId] ?: return
        if (stroke.points.isEmpty()) return
        if (stroke.lineMode && payload.points.isNotEmpty()) {
            val first = stroke.points.first()
            stroke.points.clear(); stroke.points.add(first); stroke.points.add(payload.points.last())
            annotationDirty = true; invalidate(); return
        }
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
        if (strokes.isNotEmpty()) strokes.removeAt(strokes.size - 1)
        else if (clearedHistory.isNotEmpty()) strokes.addAll(clearedHistory.removeAt(clearedHistory.lastIndex))
        else return
        annotationDirty = true
        invalidate()
        onAnnotationCountChanged?.invoke()
    }

    private fun remoteClear() {
        flushRemoteStrokes()
        if (strokes.isNotEmpty()) clearedHistory.add(currentStrokes())
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
        val fillWidthScale = viewWidth / imageWidth
        val contain = fitMode != ImageFitMode.FitWidth ||
            shouldFitWholePage(imageWidth.toFloat(), imageHeight.toFloat(), viewWidth, viewHeight, fillWidthScale)
        fitScale = if (contain) {
            min(viewWidth / imageWidth, viewHeight / imageHeight)
        } else {
            fillWidthScale
        }
        fitWidth = imageWidth * fitScale
        fitHeight = imageHeight * fitScale
    }

    /**
     * 是否需要"整页刚好放下"（与 iOS `applyCoursewareFit` 判定一致）：
     * 1. 只在 FitWidth 模式、且开启了 [fitPageForWidePages] 时才可能收窄；
     * 2. 宽高比 < 1.2 的竖向长课件不收窄（保持铺满 + 逐屏滚动）；
     * 3. 按宽度铺开本来就放得下的不收窄（没有收益，不必留黑边）；
     * 4. 收窄带来的宽度损失超过阈值时也不收窄——宁可裁切（仍可逐屏滚动），
     *    手机横屏舞台比课件扁得多，宁可多让一点宽度也要整页完整、一次翻页。
     */
    private fun shouldFitWholePage(
        imageWidth: Float,
        imageHeight: Float,
        viewWidth: Float,
        viewHeight: Float,
        fillWidthScale: Float
    ): Boolean {
        if (!fitPageForWidePages) return false
        val aspect = imageWidth / imageHeight
        if (aspect < FIT_PAGE_MIN_ASPECT) return false
        if (imageHeight * fillWidthScale <= viewHeight + 1f) return false
        val widthLoss = 1f - (viewHeight * aspect) / viewWidth
        val maxLoss = if (shortLandscape()) 1f else FIT_TABLET_MAX_WIDTH_LOSS
        return widthLoss <= maxLoss
    }

    /** 手机横屏（高度紧张）判定，与 iOS 的 (orientation: landscape) and (max-height: 30rem) 对齐 */
    private fun shortLandscape(): Boolean {
        val config = context.resources.configuration
        return config.orientation == Configuration.ORIENTATION_LANDSCAPE && config.screenHeightDp <= 480
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

    /**
     * 返回按 16:9 横屏大屏估算的可视区域，并转换到本控件坐标。
     * 课件在手机上可能整页可见，但大屏会裁掉上下部分；这个矩形用于在手机
     * 页面上标出大屏当前正在显示的区域。返回值为独立副本，调用方可长期保存。
     */
    fun bigScreenViewportRectInView(bigScreenAspect: Float = 9f / 16f): RectF? {
        val image = bitmap ?: return null
        val imageRect = imageDisplayRect()?.let { RectF(it) } ?: return null
        val (imageWidth, imageHeight) = rotatedSize(image)
        if (imageWidth <= 0 || imageHeight <= 0) return null
        val scale = userScale.coerceAtLeast(0.01f)
        val imageAspect = imageWidth.toFloat() / imageHeight.toFloat()
        val visibleWidth = (1f / scale).coerceIn(0f, 1f)
        val visibleHeight = (bigScreenAspect * imageAspect / scale).coerceIn(0f, 1f)
        val maxX = (1f - visibleWidth).coerceAtLeast(0f)
        val maxY = (1f - visibleHeight).coerceAtLeast(0f)
        val maxTranslateX = max(0f, (fitWidth * userScale - width) / 2f)
        val maxTranslateY = max(0f, (fitHeight * userScale - height) / 2f)
        val progressX = if (maxTranslateX > 0.5f) {
            ((maxTranslateX - translateX) / (2f * maxTranslateX)).coerceIn(0f, 1f)
        } else 0f
        val progressY = if (maxTranslateY > 0.5f) {
            ((maxTranslateY - translateY) / (2f * maxTranslateY)).coerceIn(0f, 1f)
        } else if (bigScrollActive) {
            bigProgressY.coerceIn(0f, 1f)
        } else 0f
        val centerX = 0.5f + (progressX - 0.5f) * maxX
        val centerY = 0.5f + (progressY - 0.5f) * maxY
        val normalized = RectF(
            centerX - visibleWidth / 2f,
            centerY - visibleHeight / 2f,
            centerX + visibleWidth / 2f,
            centerY + visibleHeight / 2f
        )
        return RectF(
            imageRect.left + normalized.left * imageRect.width(),
            imageRect.top + normalized.top * imageRect.height(),
            imageRect.left + normalized.right * imageRect.width(),
            imageRect.top + normalized.bottom * imageRect.height()
        )
    }

    /** 屏幕坐标 → 归一化图片坐标；落在图片外时返回 null（与大屏端一样忽略） */
    fun mapPageRectToView(rect: RectF): RectF? {
        val image = imageDisplayRect() ?: return null
        return RectF(image.left + rect.left * image.width(), image.top + rect.top * image.height(),
            image.left + rect.right * image.width(), image.top + rect.bottom * image.height())
    }

    /** 当前手持设备实际能看到的课件范围，使用课件归一化坐标。 */
    fun visiblePageRect(): RectF? {
        val image = imageDisplayRect() ?: return null
        if (image.width() <= 0f || image.height() <= 0f || width <= 0 || height <= 0) return null
        return RectF(
            ((0f - image.left) / image.width()).coerceIn(0f, 1f),
            ((0f - image.top) / image.height()).coerceIn(0f, 1f),
            ((width - image.left) / image.width()).coerceIn(0f, 1f),
            ((height - image.top) / image.height()).coerceIn(0f, 1f)
        ).takeIf { it.width() > 0f && it.height() > 0f }
    }

    /** 大屏高宽比也用于手机整页显示时的逐屏翻动。 */
    var bigScreenHeightOverWidth = 9f / 16f

    /** 大屏确认的页面可见范围；不直接覆盖正在进行的手势进度，避免网络回包导致跳动。 */
    var reportedViewerRect: RectF? = null
    private var viewerDragStarted = false

    private fun canDragViewerViewport(): Boolean =
        fitMode == ImageFitMode.FitWidth && fitHeight > 0f &&
            fitHeight * userScale <= height + 1f &&
            (reportedViewerRect?.height() ?: 1f) < 0.999f

    private fun dragViewerViewport(distanceY: Float): Boolean {
        if (!canDragViewerViewport()) return false
        val visibleFraction = reportedViewerRect?.height() ?: return false
        val travel = fitHeight * userScale * (1f - visibleFraction)
        if (travel <= 1f) return false
        if (!viewerDragStarted) {
            val rect = reportedViewerRect ?: return false
            // Only a real drag adopts the reported position. A tap must preserve
            // the exact progress reached by the preceding screen step.
            bigProgressY = when {
                rect.bottom >= 0.999f -> 1f
                rect.top <= 0.001f -> 0f
                else -> (rect.top / (1f - rect.height())).coerceIn(0f, 1f)
            }
            viewerDragStarted = true
        }
        bigScrollActive = true
        bigProgressY = (bigProgressY + distanceY / travel).coerceIn(0f, 1f)
        notifyViewport()
        return true
    }

    private fun toNormalized(viewX: Float, viewY: Float, timeMs: Int = 0, pressure: Float = 0.5f): AnnotationPoint? {
        val rect = imageDisplayRect() ?: return null
        if (rect.width() <= 0f || rect.height() <= 0f) return null
        val x = (viewX - rect.left) / rect.width()
        val y = (viewY - rect.top) / rect.height()
        if (x < 0f || x > 1f || y < 0f || y > 1f) return null
        return AnnotationPoint(x, y, timeMs, pressure.coerceIn(0f, 1f))
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        // 切换画笔模式时，平板横屏底部工具栏会增减一行，导致预览区域高度变化。
        // 保留尺寸变化前的滚动位置，否则长页停在底部时会被强制跳回顶部，
        // 而大屏仍停在底部，造成手机与大屏显示区域不一致。
        val oldMaxY = max(0f, (fitHeight - oldh) / 2f)
        val oldProgressY = if (oldMaxY > 0.5f) {
            ((oldMaxY - translateY) / (2f * oldMaxY)).coerceIn(0f, 1f)
        } else {
            0f
        }
        measureFit()
        if (fitMode == ImageFitMode.FitWidth && userScale <= 1.01f) {
            val newMaxY = max(0f, (fitHeight - height) / 2f)
            translateY = if (oldMaxY > 0.5f) {
                // 0 是顶部，1 是底部；按比例映射到新的可滚动范围。
                newMaxY - oldProgressY * 2f * newMaxY
            } else {
                // 首次布局或整页可见时仍从顶部开始。
                newMaxY
            }
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
        // 1px 容差：整页放下的课件高度可能与舞台差不到 1px（亚像素舍入），
        // 这种情况必须当成"整页可显示"，否则一张课件要按两次才翻得过去（与 iOS 端一致）。
        if (displayHeight <= viewHeight + 1f) {
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
        val bigAspectHOverW = bigScreenHeightOverWidth
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
        // 进行中的画笔笔画实时绘制在离屏层之上：起收笔收尖要跟随笔画总长度变化，
        // 一旦画进离屏层就擦不掉了。板擦例外，它必须写进离屏层才能只擦笔迹。
        activeStroke?.takeIf { !it.isEraser }?.let { drawStroke(canvas, it, 0) }
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        val action = event.actionMasked
        if (action == MotionEvent.ACTION_DOWN) {
            val tool = event.getToolType(0)
            stylusInk = tool == MotionEvent.TOOL_TYPE_STYLUS || tool == MotionEvent.TOOL_TYPE_ERASER
            // 掌托在 Android 上不区分工具类型（系统报成 FINGER），靠"笔在写 / 刚抬笔"来判定：
            // 笔正在写时多出来的触点一律不参与绘制与缩放；刚抬笔的屏蔽窗口内的触控整段丢弃。
            palmIgnored = !stylusInk && event.eventTime < stylusGuardUntil
        }
        if (palmIgnored) {
            if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) palmIgnored = false
            return true
        }
        // 手写笔书写期间，多出来的触点（掌托 / 手指）不参与双指缩放和翻页
        if (stylusInk && action == MotionEvent.ACTION_POINTER_DOWN) return true
        if (stylusInk && action == MotionEvent.ACTION_POINTER_UP) return true
        when (action) {
            MotionEvent.ACTION_DOWN -> {
                twoFingerActive = false
                twoFingerTapCandidate = false
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
                // 画笔模式：单指留给绘制，翻页改用双指点击，这里先登记候选
                twoFingerTapCandidate = mode == ImageCastMode.Pen && onPageTap != null
                if (twoFingerTapCandidate) {
                    twoFingerTapDownTime = event.eventTime
                    twoFingerTapP0X = event.getX(0)
                    twoFingerTapP0Y = event.getY(0)
                    twoFingerTapP1X = event.getX(1)
                    twoFingerTapP1Y = event.getY(1)
                    twoFingerTapX = (twoFingerTapP0X + twoFingerTapP1X) / 2f
                }
            }
            MotionEvent.ACTION_MOVE -> {
                when {
                    // 手写笔书写时即使掌托多按了一指，也只认笔尖（pointer 0）的轨迹
                    mode == ImageCastMode.Pen && (event.pointerCount == 1 || stylusInk) -> {
                        if (hasPendingStart) {
                            val dx = event.x - pendingStartX
                            val dy = event.y - pendingStartY
                            val slop = START_STROKE_SLOP_DP * resources.displayMetrics.density
                            if (dx * dx + dy * dy >= slop * slop) {
                                // 确认为绘制：以最初落点起笔，再补上当前这个移动点
                                hasPendingStart = false
                                startStroke(pendingStartX, pendingStartY, event.eventTime, event.pressure)
                                extendStroke(event)
                            }
                        } else {
                            extendStroke(event)
                        }
                    }
                    event.pointerCount >= 2 && !stylusInk -> {
                        // 双指手势期间丢弃待定落点，避免抬指后被当成单击画点
                        hasPendingStart = false
                        if (twoFingerTapCandidate) {
                            // 任一指移动超过阈值即视为缩放 / 拖动，不再算"双指点击翻页"
                            val slop = TAP_PAGE_SLOP_DP * resources.displayMetrics.density
                            val moved = maxOf(
                                hypot(event.getX(0) - twoFingerTapP0X, event.getY(0) - twoFingerTapP0Y),
                                hypot(event.getX(1) - twoFingerTapP1X, event.getY(1) - twoFingerTapP1Y)
                            )
                            if (moved > slop) twoFingerTapCandidate = false
                        }
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
                    startStroke(pendingStartX, pendingStartY, event.eventTime, event.pressure)
                }
                if (twoFingerTapCandidate) {
                    twoFingerTapCandidate = false
                    if (event.eventTime - twoFingerTapDownTime <= TWO_FINGER_TAP_TIMEOUT_MS) {
                        onPageTap?.invoke(if (twoFingerTapX < width / 2f) -1 else 1)
                    }
                }
                finishActiveStroke(notify = true)
                // 抬笔后屏蔽一小段时间，防止掌托边缘紧接着落下被当成新的手指操作
                if (stylusInk) stylusGuardUntil = event.eventTime + STYLUS_GUARD_MS
                notifyViewport(force = true)
                performClick()
            }
            MotionEvent.ACTION_CANCEL -> {
                // 手势被取消：丢弃待定落点，不补画点
                hasPendingStart = false
                twoFingerTapCandidate = false
                finishActiveStroke(notify = true)
                if (stylusInk) stylusGuardUntil = event.eventTime + STYLUS_GUARD_MS
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

    fun resendViewport() = notifyViewport(force = true)

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

    private fun startStroke(viewX: Float, viewY: Float, eventTime: Long, pressure: Float) {
        val point = toNormalized(viewX, viewY, 0, pressure) ?: return
        strokeStartedAtMs = eventTime
        val stroke = AnnotationStroke(
            id = "a${++strokeSeq}",
            colorHex = if (penEraser) ERASER_COLOR else penColorHex,
            width = if (penEraser) AnnotationPalette.ERASER_WIDTH else PenSettings.width,
            isEraser = penEraser
        )
        stroke.points.add(point)
        activeStroke = stroke
        activeDrawnIndex = 0
        pendingPoints.clear()
        lastSyncedPoint = point
        lastSyncAt = System.currentTimeMillis()
        ensureAnnotationLayer()
        if (annotationDirty) {
            redrawAnnotationLayer()
            annotationDirty = false
        }
        // 板擦必须画进离屏层（CLEAR 只能作用于笔迹层，画到视图层会把底图擦掉）；
        // 画笔改为每帧实时绘制，因为起收笔收尖要跟着笔画总长度变化，画进离屏层就改不回来了。
        if (stroke.isEraser) appendActiveSegment()
        invalidate()
        onStrokeBegin?.invoke(stroke.id, stroke.colorHex, stroke.width, stroke.isEraser, point)
    }

    /**
     * 处理一次 MOVE：MotionEvent 一批里通常合并了 3~10 个采样点（getHistorical*），
     * 只取 event.x / event.y 会把笔迹拉成稀疏折线、笔锋看不出粗细渐变。
     */
    private fun extendStroke(event: MotionEvent) {
        for (h in 0 until event.historySize) {
            extendStroke(
                event.getHistoricalX(0, h),
                event.getHistoricalY(0, h),
                event.getHistoricalEventTime(h),
                event.getHistoricalPressure(0, h)
            )
        }
        extendStroke(event.x, event.y, event.eventTime, event.pressure)
    }

    private fun extendStroke(viewX: Float, viewY: Float, eventTime: Long, pressure: Float) {
        val stroke = activeStroke ?: return
        val elapsed = (eventTime - strokeStartedAtMs).coerceIn(0L, 600000L).toInt()
        val point = toNormalized(viewX, viewY, elapsed, pressure) ?: return
        val last = stroke.points.last()
        val dx = point.x - last.x
        val dy = point.y - last.y
        val threshold = AnnotationPalette.MIN_POINT_DISTANCE
        if (dx * dx + dy * dy < threshold * threshold) return
        stroke.points.add(point)
        pendingPoints.add(point)
        if (stroke.isEraser) appendActiveSegment()
        invalidate()
        val now = System.currentTimeMillis()
        if (now - lastSyncAt >= AnnotationPalette.SYNC_INTERVAL_MS || pendingPoints.size >= MAX_PENDING_POINTS) {
            flushPendingPoints(stroke)
            lastSyncAt = now
        }
    }

    private fun finishActiveStroke(notify: Boolean) {
        val stroke = activeStroke ?: return
        // 收笔位置一定要发给大屏：最后一个移动点可能因为降采样阈值没进队列
        val lastPoint = stroke.points.lastOrNull()
        val synced = lastSyncedPoint
        if (lastPoint != null && (synced == null || lastPoint.x != synced.x || lastPoint.y != synced.y)) {
            pendingPoints.add(lastPoint)
        }
        // 先把尚未发送的点补发出去，再结束笔画。
        // 顺序很关键：若先置空 activeStroke，flush 时取到 null 会直接 return，
        // 最后一段点就丢了，大屏上的笔画会短一截（例如画圆不闭合）。
        flushPendingPoints(stroke)
        activeStroke = null
        lastSyncedPoint = null
        strokes.add(stroke)
        annotationDirty = true
        invalidate()
        if (notify) {
            onStrokeEnd?.invoke(stroke.id)
        }
        onAnnotationCountChanged?.invoke()
    }

    /**
     * 把积攒的点发给大屏。
     *
     * 本地渲染用全部采样点（画质最好），传输只发"够描述形状"的点：默认每 0.0012
     * 归一化距离（1920 宽上约 2.3px）一个，接收端用同一套 InkRenderer 重采样回 1px
     * 再平滑，所以形状和粗细不会因为降采样而变化，报文却能小 3~4 倍。
     * 每批的最后一个点一定发送，保证收笔位置不被抹掉。
     */
    private fun flushPendingPoints(stroke: AnnotationStroke?) {
        if (stroke == null || pendingPoints.isEmpty()) return
        val threshold = AnnotationPalette.SYNC_MIN_DISTANCE
        val batch = ArrayList<AnnotationPoint>(pendingPoints.size)
        var last = lastSyncedPoint
        for (index in pendingPoints.indices) {
            val point = pendingPoints[index]
            val isLast = index == pendingPoints.lastIndex
            if (!isLast && last != null) {
                val dx = point.x - last.x
                val dy = point.y - last.y
                if (dx * dx + dy * dy < threshold * threshold) continue
            }
            batch.add(point)
            last = point
        }
        pendingPoints.clear()
        if (batch.isEmpty()) return
        lastSyncedPoint = last
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
        activeStroke?.takeIf { it.isEraser }?.let {
            // 只把进行中的板擦落进离屏层；画笔笔画是每帧在视图层实时画的，不能烙进层里
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
        // 线宽 = 内容宽度的千分比：4/6/9 → 0.27%/0.4%/0.6%，板擦 2%（比上一版整体细 1/3）。
        // 手机、iPad、大屏因此与页面保持同样的粗细比例；rect 已含缩放，放大时线自然变粗。
        // 以前用 dp×density，手机相对页面比大屏粗 3~5 倍。
        val inkRatio = if (stroke.isEraser) 0.02f else stroke.width / 1500f
        val baseWidth = (inkRatio * rect.width()).coerceAtLeast(0.8f)
        val targetPaint = if (stroke.isEraser) eraserPaint else strokePaint
        if (!stroke.isEraser) {
            targetPaint.color = runCatching { Color.parseColor(stroke.colorHex) }.getOrDefault(Color.RED)
            targetPaint.alpha = if (stroke.mode == "highlighter") 115 else 255
            val unit = baseWidth
            targetPaint.pathEffect = when (stroke.mode) {
                "dashed" -> DashPathEffect(floatArrayOf(unit * 2.2f, unit * 1.6f), 0f)
                "dashdot" -> DashPathEffect(floatArrayOf(unit * 2.2f, unit * 1.2f, 0.1f, unit * 1.2f), 0f)
                else -> null
            }
        }
        targetPaint.strokeWidth = baseWidth * if (!stroke.isEraser && stroke.mode == "highlighter") 5f else 1f

        // 实线画笔走手写轮廓（InkRenderer + perfect-freehand）；板擦、荧光笔、虚线、直线工具保持等宽
        if (!stroke.isEraser && stroke.mode == "solid" && !stroke.lineMode && points.size >= 2) {
            drawFreehandStroke(target, points, targetPaint.strokeWidth, rect, targetPaint)
            return
        }

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

    /**
     * 手写轮廓：InkRenderer 负责「像素去重 → 位置平滑 → 速度/压力线宽 → 等距重采样」，
     * 这里按每个点的线宽生成左右两条边，一次 drawPath 填充。
     *
     * 不用 Kotlin 版 perfect-freehand 的移植轮廓：它缺上游的轮廓抽稀与端帽，密集采样时
     * 多边形会自交成一串"串珠"；而按 1px 重采样后的点直接做法线偏移，边缘是连续的，
     * 与网页端 traceInkOutline 的兜底轮廓同源。
     */
    private fun drawFreehandStroke(
        target: Canvas,
        points: List<AnnotationPoint>,
        widthPx: Float,
        rect: RectF,
        paint: Paint
    ) {
        val prepared = InkRenderer.prepare(points.map { point ->
            InkRenderer.Point(
                rect.left + point.x * rect.width(),
                rect.top + point.y * rect.height(),
                point.p,
                point.t.toFloat()
            )
        }, widthPx) ?: return
        val source = prepared.source
        val widths = prepared.widths
        paint.style = Paint.Style.FILL

        if (source.size >= 2) {
            val n = source.size
            inkPath.rewind()
            // 左边：沿前进方向左法线偏移半个线宽
            for (i in 0 until n) {
                val prev = source[if (i == 0) 0 else i - 1]
                val next = source[if (i == n - 1) n - 1 else i + 1]
                val half = widths[i] / 2f
                var nx = -(next.y - prev.y)
                var ny = next.x - prev.x
                val len = hypot(nx, ny).coerceAtLeast(0.0001f)
                nx /= len
                ny /= len
                val x = source[i].x + nx * half
                val y = source[i].y + ny * half
                if (i == 0) inkPath.moveTo(x, y) else inkPath.lineTo(x, y)
            }
            // 右边：反向回到起点
            for (i in n - 1 downTo 0) {
                val prev = source[if (i == 0) 0 else i - 1]
                val next = source[if (i == n - 1) n - 1 else i + 1]
                val half = widths[i] / 2f
                var nx = -(next.y - prev.y)
                var ny = next.x - prev.x
                val len = hypot(nx, ny).coerceAtLeast(0.0001f)
                nx /= len
                ny /= len
                inkPath.lineTo(source[i].x - nx * half, source[i].y - ny * half)
            }
            inkPath.close()
            target.drawPath(inkPath, paint)
        }

        // 端帽：起收笔各补一个圆，保证收笔不是平头
        val first = source.first()
        val last = source.last()
        target.drawCircle(first.x, first.y, (widths.first() / 2f).coerceAtLeast(0.5f), paint)
        target.drawCircle(last.x, last.y, (widths.last() / 2f).coerceAtLeast(0.5f), paint)
        paint.style = Paint.Style.STROKE
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
        override fun onDown(e: MotionEvent): Boolean {
            viewerDragStarted = false
            return true
        }

        override fun onScroll(
            e1: MotionEvent?,
            e2: MotionEvent,
            distanceX: Float,
            distanceY: Float
        ): Boolean {
            // 画笔模式：单指留给绘制；双指缩放 / 平移由 onTouchEvent 自管，避免重复平移
            if (mode == ImageCastMode.Pen) return false
            if (e2.pointerCount > 1) return false
            if (dragViewerViewport(distanceY)) return true
            translateX -= distanceX
            translateY -= distanceY
            clampTranslation()
            markAnnotationDirty()
            notifyViewport()
            invalidate()
            return true
        }

        override fun onSingleTapUp(e: MotionEvent): Boolean {
            // 点动翻页：点击左半边向前翻、右半边向后翻。
            // 单指抬起立即处理，快速连续点击也能逐次翻页。画笔模式单指用于绘制，
            // 翻页走双指点击（见 onTouchEvent）。
            if (mode == ImageCastMode.Pen) return false
            val handler = onPageTap ?: return false
            handler(if (e.x < width / 2f) -1 else 1)
            return true
        }

    }

    companion object {
        private const val MAX_SCALE = 8f
        /** 宽高比 ≥ 1.2 视为横向课件（4:3 = 1.33，16:9 = 1.78），见 [fitPageForWidePages] */
        private const val FIT_PAGE_MIN_ASPECT = 1.2f

        /** 平板舞台与课件比例接近，只在几乎不损失宽度时才收窄（对齐 iOS CW_FIT_TABLET_MAX_WIDTH_LOSS） */
        private const val FIT_TABLET_MAX_WIDTH_LOSS = 0.03f

        /** 画笔模式双指点击翻页的最长按住时间（对齐 iOS 的 ≤500ms） */
        private const val TWO_FINGER_TAP_TIMEOUT_MS = 500L

        /** 判定"点击"的最大位移（dp），超过即视为缩放 / 拖动，不再翻页 */
        private const val TAP_PAGE_SLOP_DP = 12f
        private const val NOTIFY_INTERVAL_MS = 80L
        /** 单次批量上报的最大点数，防止弱网下积压过多 */
        private const val MAX_PENDING_POINTS = 12
        /** 起笔判定阈值（dp）：单指移动超过该距离才认定为绘制，避免落点被误判成笔画 */
        private const val START_STROKE_SLOP_DP = 6f
        /** 板擦不依赖颜色（大屏端固定 #000），这里给一个占位色 */
        private const val ERASER_COLOR = "#000000"
        /** 手写笔抬笔后屏蔽触控的时间，防止掌托边缘立刻落下被当成新的手指操作 */
        private const val STYLUS_GUARD_MS = 500L
    }
}


