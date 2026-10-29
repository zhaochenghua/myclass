package cn.edu.nb3.myclass

import android.os.SystemClock
import java.util.Locale

/**
 * 演讲者视图的讲话计时。
 *
 * 计时跨“关闭再打开演讲者视图”累计（老师中途回课件页再回来，不应清零），
 * 只在本课件结束时重置；暂停按老师手动操作保留。
 */
class PresentationTimer {
    private var accumulatedMs = 0L
    private var startedAtMs = 0L
    private var running = false

    val isRunning: Boolean get() = running

    fun elapsedMs(): Long = accumulatedMs + if (running) SystemClock.elapsedRealtime() - startedAtMs else 0L

    /** 第一次打开演讲者视图时自动开始；已暂停/已有时长则保持不变。 */
    fun startIfNeeded() {
        if (running || accumulatedMs > 0L) return
        startedAtMs = SystemClock.elapsedRealtime()
        running = true
    }

    fun pause() {
        if (!running) return
        accumulatedMs = elapsedMs()
        running = false
    }

    fun resume() {
        if (running) return
        startedAtMs = SystemClock.elapsedRealtime()
        running = true
    }

    fun reset() {
        accumulatedMs = 0L
        startedAtMs = SystemClock.elapsedRealtime()
        running = false
    }

    fun format(): String {
        val total = (elapsedMs() / 1000L).coerceAtLeast(0L)
        val hours = total / 3600
        val minutes = (total % 3600) / 60
        val seconds = total % 60
        return if (hours > 0) String.format(Locale.US, "%d:%02d:%02d", hours, minutes, seconds)
        else String.format(Locale.US, "%02d:%02d", minutes, seconds)
    }
}
