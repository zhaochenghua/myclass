package cn.edu.nb3.myclass

/**
 * 手机端画笔标注的数据模型。
 *
 * 坐标口径必须与大屏端（web/app.js 的 pointerEventToSourcePoint）完全一致：
 * x / y 为 0~1 归一化值，基准是**图片在控件中经过缩放/平移/旋转之后的轴对齐外接矩形（AABB）**，
 * 而不是图片的原始像素坐标。这样旋转 90/270 时两端 AABB 宽高同步互换，笔迹不会反向错位。
 */
data class AnnotationPoint(val x: Float, val y: Float)

data class AnnotationStroke(
    val id: String,
    /** #RRGGBB，与大屏端调色板同一套取值 */
    val colorHex: String,
    /** 画笔 4f / 板擦 40f，与大屏端 stroke.width 同单位 */
    val width: Float,
    val isEraser: Boolean,
    val points: MutableList<AnnotationPoint> = mutableListOf()
)

object AnnotationPalette {
    /** 必须与 web/index.html 中 .annotation-color 的 data-color 完全一致 */
    val COLORS = listOf("#ffd166", "#ff4d6d", "#38bdf8", "#22c55e", "#ffffff")

    const val DEFAULT_COLOR = "#ff4d6d"
    const val PEN_WIDTH = 4f
    const val ERASER_WIDTH = 40f

    /** 绘制过程中增量上报轨迹点的节流间隔 */
    const val SYNC_INTERVAL_MS = 60L

    /** 相邻采样点的最小归一化距离，小于该值直接丢弃，避免点数膨胀 */
    const val MIN_POINT_DISTANCE = 0.0015f

    /** 归一化坐标保留 4 位小数，避免浮点长尾把报文撑大 */
    fun round(value: Float): Double = Math.round(value.toDouble() * 10000.0) / 10000.0
}

/** 大屏端画笔回传的标注动作（begin / points / end / undo / clear） */
data class RemoteAnnotationPayload(
    val action: String,
    val strokeId: String = "",
    val colorHex: String = "",
    val width: Float = AnnotationPalette.PEN_WIDTH,
    val isEraser: Boolean = false,
    val mode: String = "solid",
    val points: List<AnnotationPoint> = emptyList(),
    /** 所属页码（1 基）；0 表示不区分页（图片投屏等单页场景） */
    val page: Int = 0
)
