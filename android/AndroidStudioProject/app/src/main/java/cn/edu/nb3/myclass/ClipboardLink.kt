package cn.edu.nb3.myclass

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/** Shared-text parsing only; reading the clipboard stays in the focused Activity. */
data class ClipboardLink(val url: String, val title: String) {
    companion object {
        fun parse(text: String): ClipboardLink? {
            val match = Regex("https?://[^\\s<>\"【】]+", RegexOption.IGNORE_CASE).find(text) ?: return null
            val raw = match.value.trimEnd('。', '，', '；', '！', '？', ',', ';', '）', '》', '」', '』')
            if (raw.length > 8192) return null
            val url = raw.toHttpUrlOrNull()?.toString() ?: return null
            val bracket = Regex("【([^】]+)】").find(text)?.groupValues?.get(1)
            val remainder = text.removeRange(match.range).trim().trim('：', ':', '-', '—', ' ', '\n', '\r')
            val title = (bracket ?: remainder.lineSequence().firstOrNull { it.isNotBlank() }.orEmpty())
                .removeSuffix("-哔哩哔哩").trim().take(50)
            return ClipboardLink(url, title)
        }
    }
}
