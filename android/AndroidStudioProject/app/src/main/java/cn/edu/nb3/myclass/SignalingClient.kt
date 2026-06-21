package cn.edu.nb3.myclass

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

data class IceCandidatePayload(
    val sdpMid: String,
    val sdpMLineIndex: Int,
    val candidate: String
)

data class DeviceOrientationPayload(
    val orientation: String,
    val rotationDegrees: Int,
    val cameraFacing: String,
    val frameLocked: Boolean = false,
    val lockedFrameZoomRatio: Float = 1f,
    val lockedFrameCropX: Float = 0f,
    val lockedFrameCropY: Float = 0f,
    val lockedFrameCropWidth: Float = 1f,
    val lockedFrameCropHeight: Float = 1f
)

class SignalingClient(
    private val serverBaseUrl: String,
    private val roomCode: String,
    private val callback: Callback
) : WebSocketListener() {

    interface Callback {
        fun onJoinAccepted()
        fun onJoinRejected(message: String)
        fun onKicked(message: String)
        fun onServerClosed(message: String)
        fun onAnswer(sdp: String)
        fun onRemoteIceCandidate(candidate: IceCandidatePayload)
        fun onSignalError(message: String)
    }

    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    private var webSocket: WebSocket? = null
    private var closedByUser = false

    fun connect() {
        val request = Request.Builder()
            .url(toWebSocketUrl(serverBaseUrl))
            .build()
        webSocket = client.newWebSocket(request, this)
    }

    fun sendOffer(sdp: String) {
        sendJson(
            JSONObject()
                .put("type", "webrtc.offer")
                .put("sdp", sdp)
        )
    }

    fun sendIceCandidate(candidate: IceCandidatePayload) {
        sendJson(
            JSONObject()
                .put("type", "webrtc.ice-candidate")
                .put(
                    "candidate",
                    JSONObject()
                        .put("sdpMid", candidate.sdpMid)
                        .put("sdpMLineIndex", candidate.sdpMLineIndex)
                        .put("candidate", candidate.candidate)
                )
        )
    }

    fun sendStop() {
        sendJson(JSONObject().put("type", "teacher.stop"))
    }

    fun sendCoursewareOpen(url: String, title: String, page: Int = 1) {
        sendJson(
            JSONObject()
                .put("type", "courseware.open")
                .put("url", url)
                .put("title", title)
                .put("page", page)
        )
    }

    fun sendCoursewarePage(page: Int) {
        sendJson(
            JSONObject()
                .put("type", "courseware.page")
                .put("page", page)
        )
    }

    fun sendCoursewareClose() {
        sendJson(JSONObject().put("type", "courseware.close"))
    }

    fun sendOrientation(orientation: DeviceOrientationPayload) {
        sendJson(
            JSONObject()
                .put("type", "teacher.orientation")
                .put("orientation", orientation.orientation)
                .put("rotationDegrees", orientation.rotationDegrees)
                .put("cameraFacing", orientation.cameraFacing)
                .put("frameLocked", orientation.frameLocked)
                .put("lockedFrameZoomRatio", orientation.lockedFrameZoomRatio.toDouble())
                .put("lockedFrameCropX", orientation.lockedFrameCropX.toDouble())
                .put("lockedFrameCropY", orientation.lockedFrameCropY.toDouble())
                .put("lockedFrameCropWidth", orientation.lockedFrameCropWidth.toDouble())
                .put("lockedFrameCropHeight", orientation.lockedFrameCropHeight.toDouble())
        )
    }

    fun close() {
        closedByUser = true
        webSocket?.close(1000, "user closed")
        webSocket = null
        client.dispatcher.executorService.shutdown()
    }

    override fun onOpen(webSocket: WebSocket, response: Response) {
        // 手机端连接成功后立即提交 4 位连接码。
        sendJson(
            JSONObject()
                .put("type", "teacher.join")
                .put("code", roomCode)
        )
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
        val message = runCatching { JSONObject(text) }.getOrNull() ?: return
        when (message.optString("type")) {
            "join.accepted" -> callback.onJoinAccepted()
            "join.rejected" -> callback.onJoinRejected(message.optString("message", "连接码错误"))
            "teacher.kicked" -> callback.onKicked(message.optString("message", "本设备已下线"))
            "viewer.disconnected",
            "room.expired" -> callback.onServerClosed(message.optString("message", "课堂已断开"))
            "webrtc.answer" -> callback.onAnswer(message.optString("sdp"))
            "webrtc.ice-candidate" -> parseIceCandidate(message)?.let(callback::onRemoteIceCandidate)
            "error" -> callback.onSignalError(message.optString("message", "信令错误"))
        }
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
        webSocket.close(code, reason)
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        if (!closedByUser) {
            callback.onServerClosed("信令连接已断开")
        }
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        if (!closedByUser) {
            callback.onSignalError(readableNetworkError(t.message ?: "信令连接失败"))
        }
    }

    private fun sendJson(payload: JSONObject) {
        webSocket?.send(payload.toString())
    }

    private fun readableNetworkError(message: String): String {
        val lowerMessage = message.lowercase()
        return if (
            lowerMessage.contains("software caused connection abort") ||
            lowerMessage.contains("connection reset") ||
            lowerMessage.contains("broken pipe") ||
            lowerMessage.contains("timeout")
        ) {
            "网络连接中断，请确认手机和服务器网络正常"
        } else {
            message
        }
    }

    private fun parseIceCandidate(message: JSONObject): IceCandidatePayload? {
        val candidate = message.optJSONObject("candidate") ?: return null
        return IceCandidatePayload(
            sdpMid = candidate.optString("sdpMid"),
            sdpMLineIndex = candidate.optInt("sdpMLineIndex"),
            candidate = candidate.optString("candidate")
        )
    }

    private fun toWebSocketUrl(baseUrl: String): String {
        val trimmed = baseUrl.trimEnd('/')
        return when {
            trimmed.startsWith("https://") -> trimmed.replaceFirst("https://", "wss://") + "/ws"
            trimmed.startsWith("http://") -> trimmed.replaceFirst("http://", "ws://") + "/ws"
            else -> "ws://$trimmed/ws"
        }
    }
}
