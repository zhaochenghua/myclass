package cn.edu.nb3.myclass

import android.app.Activity
import android.app.Instrumentation
import android.os.Bundle

object ClearUndoCheck {
    fun run(test: Instrumentation) {
        val result = Bundle()
        var failure: Throwable? = null
        test.runOnMainSync {
            try {
                val themed = android.view.ContextThemeWrapper(test.targetContext, cn.edu.nb3.myclass.R.style.Theme_MyClass)
                val source = android.widget.LinearLayout(themed)
                val labels = listOf("画笔", "抽学生", "清空", "▶视频", "上一屏", "1 / 999", "下一屏", "页码", "跳转", "返回主菜单", "结束投屏")
                val buttons = labels.map { label ->
                    com.google.android.material.button.MaterialButton(themed).apply {
                        text = label
                        setSingleLine(true)
                        textSize = 14f
                        source.addView(this)
                    }
                }
                val toolbar = AdaptiveToolbar(themed, source)
                val density = test.targetContext.resources.displayMetrics.density
                for (width in listOf(600, 800, 960, 1280)) {
                    val px = (width * density).toInt()
                    toolbar.measure(android.view.View.MeasureSpec.makeMeasureSpec(px, android.view.View.MeasureSpec.EXACTLY),
                        android.view.View.MeasureSpec.makeMeasureSpec(0, android.view.View.MeasureSpec.UNSPECIFIED))
                    toolbar.layout(0, 0, px, toolbar.measuredHeight)
                    buttons.forEach { button ->
                        check(button.width >= button.paint.measureText(button.text.toString()) + button.paddingLeft + button.paddingRight)
                        check(button.layout.lineCount == 1)
                    }
                    val positions = buttons.map { it.left to it.top }
                    buttons[3].visibility = android.view.View.INVISIBLE
                    toolbar.measure(android.view.View.MeasureSpec.makeMeasureSpec(px, android.view.View.MeasureSpec.EXACTLY),
                        android.view.View.MeasureSpec.makeMeasureSpec(0, android.view.View.MeasureSpec.UNSPECIFIED))
                    toolbar.layout(0, 0, px, toolbar.measuredHeight)
                    check(positions == buttons.map { it.left to it.top })
                    buttons[3].visibility = android.view.View.VISIBLE
                }
                val view = ZoomableImageView(test.targetContext)
                val before = listOf(
                    AnnotationStroke("pen", "#ff0000", 4f, false, mutableListOf(AnnotationPoint(.1f, .2f)), "highlighter"),
                    AnnotationStroke("eraser", "#000000", 80f, true, mutableListOf(AnnotationPoint(.3f, .4f)))
                )
                view.replaceStrokes(before)
                check(view.clearAnnotations())
                check(view.annotationCount == 0 && view.canUndoAnnotation)
                check(!view.clearAnnotations())
                check(view.undoAnnotation())
                check(view.currentStrokes() == before)
                view.applyRemoteAnnotation(RemoteAnnotationPayload("clear"))
                check(view.canUndoAnnotation)
                view.applyRemoteAnnotation(RemoteAnnotationPayload("begin", "new", "#ff0000", points = listOf(AnnotationPoint(.5f, .6f))))
                view.applyRemoteAnnotation(RemoteAnnotationPayload("end", "new"))
                check(view.undoAnnotation() && view.annotationCount == 0)
                view.applyRemoteAnnotation(RemoteAnnotationPayload("undo"))
                check(view.currentStrokes() == before)
                // Rebuilding the view keeps the page's shared undo history.
                view.clearAnnotations()
                val rebuilt = ZoomableImageView(test.targetContext)
                rebuilt.clearedHistory = view.clearedHistory
                rebuilt.replaceStrokes(emptyList())
                check(rebuilt.undoAnnotation())
                check(rebuilt.currentStrokes() == before)
            } catch (error: Throwable) { failure = error }
        }
        result.putString("stream", failure?.stackTraceToString() ?: "PASS: local/remote clear undo, new strokes, styles and view rebuild")
        test.finish(if (failure == null) Activity.RESULT_OK else Activity.RESULT_CANCELED, result)
    }
}
