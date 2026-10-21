package cn.edu.nb3.myclass

import org.json.JSONObject

/** Wire format shared with the server journal and iOS; restoration never emits ink. */
object FileAnnotations {
    fun clearHistory(message: JSONObject): Map<Int, MutableList<List<AnnotationStroke>>> {
        val result = linkedMapOf<Int, MutableList<List<AnnotationStroke>>>()
        val cleared = message.optJSONObject("cleared") ?: return result
        for (key in cleared.keys()) {
            val page = key.toIntOrNull()?.takeIf { it > 0 } ?: continue
            val entries = cleared.optJSONArray(key) ?: continue
            result[page] = (0 until entries.length()).mapNotNull { index ->
                val strokes = entries.optJSONArray(index) ?: return@mapNotNull null
                snapshot(JSONObject().put("strokes", strokes))[page]
            }.toMutableList()
        }
        return result
    }

    fun points(json: JSONObject): List<AnnotationPoint> {
        val array = json.optJSONArray("points") ?: return emptyList()
        return (0 until array.length()).mapNotNull { index ->
            val point = array.optJSONObject(index) ?: return@mapNotNull null
            val x = point.optDouble("x"); val y = point.optDouble("y")
            if (!x.isFinite() || !y.isFinite()) null else AnnotationPoint(x.toFloat().coerceIn(0f, 1f), y.toFloat().coerceIn(0f, 1f))
        }
    }

    fun snapshot(message: JSONObject): Map<Int, List<AnnotationStroke>> {
        val pages = linkedMapOf<Int, MutableList<AnnotationStroke>>()
        for (name in listOf("strokes", "active")) {
            val array = message.optJSONArray(name) ?: continue
            for (index in 0 until array.length()) {
                val stroke = array.optJSONObject(index) ?: continue
                val points = points(stroke)
                if (points.isEmpty()) continue
                pages.getOrPut(stroke.optInt("page", 1).coerceAtLeast(1)) { mutableListOf() }.add(
                    AnnotationStroke(stroke.optString("key", stroke.optString("strokeId")),
                        stroke.optString("color", "#ff4d6d"), stroke.optDouble("width", 4.0).toFloat().coerceIn(1f, 200f),
                        stroke.optBoolean("isEraser"), points.toMutableList(),
                        stroke.optString("mode", "solid"), stroke.optBoolean("lineMode")))
            }
        }
        return pages
    }

    /** Keep updates to pages which are not currently rendered, including menu/rotation. */
    fun apply(strokes: List<AnnotationStroke>, payload: RemoteAnnotationPayload): List<AnnotationStroke> {
        val id = "v:${payload.strokeId}"
        return when (payload.action) {
            "begin" -> strokes.filterNot { it.id == id } + AnnotationStroke(id, payload.colorHex,
                payload.width, payload.isEraser, payload.points.toMutableList(), payload.mode, payload.lineMode)
            "points" -> strokes.map { stroke ->
                if (stroke.id != id) stroke else stroke.copy(points = (if (stroke.lineMode)
                    stroke.points.take(1) + payload.points.takeLast(1) else stroke.points + payload.points).toMutableList())
            }
            "undo" -> strokes.dropLast(1)
            "clear" -> emptyList()
            else -> strokes
        }
    }
}
