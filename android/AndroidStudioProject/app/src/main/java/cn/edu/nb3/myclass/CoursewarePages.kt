package cn.edu.nb3.myclass

import org.json.JSONObject

/** Render and signaling indices stay physical; page labels and jumps use PPT slide numbers. */
data class CoursewarePages(val slideCount: Int, val statePages: List<Int>) {
    fun slide(page: Int): Int = statePages.getOrNull(page - 1) ?: page
    fun firstState(slide: Int): Int = statePages.indexOf(slide) + 1

    companion object {
        fun parse(json: JSONObject?, pageCount: Int): CoursewarePages? {
            val array = json?.optJSONArray("statePages") ?: return null
            val total = json.optInt("slideCount", 0)
            if (total < 1 || array.length() != pageCount || pageCount !in 1..10000) return null
            val pages = (0 until array.length()).map { array.optInt(it, 0) }
            if (pages.any { it !in 1..total } || pages.zipWithNext().any { it.first > it.second }) return null
            return CoursewarePages(total, pages)
        }
    }
}
