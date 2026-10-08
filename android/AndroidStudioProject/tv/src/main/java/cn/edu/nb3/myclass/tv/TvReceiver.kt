package cn.edu.nb3.myclass.tv

import android.content.Context
import android.os.Handler
import android.os.Looper
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.json.JSONObject
import org.webrtc.*
import java.util.concurrent.TimeUnit

/** All state transitions and SDK callbacks are serialized on the UI thread. */
class TvReceiver(
    private val context: Context,
    private val renderer: SurfaceViewRenderer,
    private val onMessage: (JSONObject) -> Unit,
    private val onStatus: (String) -> Unit,
    private val onVideo: () -> Unit
) {
    val http = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS).pingInterval(15, TimeUnit.SECONDS).build()
    private val main = Handler(Looper.getMainLooper())
    private var socket: WebSocket? = null
    private var generation = 0
    private var stopped = true
    private var attempts = 0
    private var roomCode = ""
    private var recoveryKey = ""
    private var joined = false
    private var base = ""
    private var iceServers = emptyList<PeerConnection.IceServer>()
    private var factory: PeerConnectionFactory? = null
    private var egl: EglBase? = null
    private var peer: PeerConnection? = null
    private var remoteReady = false
    private var track: VideoTrack? = null
    private var mediaGeneration = 0
    private val pendingIce = mutableListOf<IceCandidate>()

    fun start(endpoint: String, fresh: Boolean = false) {
        stop()
        if (fresh || base != endpoint) { roomCode = ""; recoveryKey = ""; joined = false }
        base = endpoint
        stopped = false
        attempts = 0
        connect()
    }

    private fun connect() {
        if (stopped) return
        val ticket = ++generation
        onStatus(if (attempts == 0) "正在连接服务器…" else "网络中断，正在重连…")
        http.newCall(Request.Builder().url("${base}api/config").build()).enqueue(object : Callback {
            override fun onFailure(call: Call, e: java.io.IOException) = main.post { retry(ticket) }.let { Unit }
            override fun onResponse(call: Call, response: Response) {
                val config = response.use {
                    if (it.isSuccessful) runCatching { JSONObject(it.body!!.string()) }.getOrNull() else null
                }
                main.post {
                    if (ticket != generation || stopped) return@post
                    if (config == null) { retry(ticket); return@post }
                    iceServers = parseIce(config)
                    val endpoint = base.toHttpUrl()
                    val wsPath = config.optString("wsPath", "${endpoint.encodedPath.trimEnd('/')}/ws")
                    val url = endpoint.newBuilder().encodedPath(wsPath).build().toString()
                    socket = http.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
                        override fun onOpen(webSocket: WebSocket, response: Response) {
                            main.post {
                                if (ticket != generation || stopped) { webSocket.close(1000, "stopped"); return@post }
                                attempts = 0
                                send(JSONObject().put("type", "viewer.join").put("roomCode", roomCode)
                                    .put("recoveryKey", recoveryKey).put("supportsRecovery", true).put("freshPage", !joined))
                            }
                        }
                        override fun onMessage(webSocket: WebSocket, text: String) {
                            main.post {
                                if (ticket != generation || stopped) return@post
                                val message = runCatching { JSONObject(text) }.getOrNull() ?: return@post
                                if (message.optString("type") == "room.created") {
                                    roomCode = message.optString("code")
                                    recoveryKey = message.optString("recoveryKey")
                                    joined = true
                                }
                                onMessage(message)
                            }
                        }
                        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                            main.post { retry(ticket) }
                        }
                        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                            main.post { retry(ticket) }
                        }
                    })
                }
            }
        })
    }

    private fun parseIce(config: JSONObject): List<PeerConnection.IceServer> {
        val array = config.optJSONObject("rtc")?.optJSONArray("iceServers") ?: return emptyList()
        return (0 until array.length()).mapNotNull { index ->
            val item = array.optJSONObject(index) ?: return@mapNotNull null
            val urls = item.optJSONArray("urls")?.let { a -> (0 until a.length()).map { a.getString(it) } }
                ?: listOf(item.optString("urls")).filter { it.isNotBlank() }
            if (urls.isEmpty()) null else PeerConnection.IceServer.builder(urls)
                .setUsername(item.optString("username")).setPassword(item.optString("credential")).createIceServer()
        }
    }

    private fun retry(ticket: Int) {
        if (ticket != generation || stopped) return
        ++generation
        socket?.cancel(); socket = null
        closeVideo()
        onStatus("服务器暂不可达，正在重连…")
        val delay = minOf(10000L, 1000L shl minOf(attempts++, 3))
        main.postDelayed({ connect() }, delay)
    }

    fun send(message: JSONObject) { socket?.send(message.toString()) }

    fun offer(sdp: String) {
        closeVideo()
        val mediaTicket = mediaGeneration
        try {
            if (factory == null) {
                PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(context).createInitializationOptions())
                egl = EglBase.create()
                renderer.init(egl!!.eglBaseContext, null)
                renderer.setEnableHardwareScaler(true)
                renderer.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT)
                factory = PeerConnectionFactory.builder()
                    .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl!!.eglBaseContext))
                    .createPeerConnectionFactory()
            }
            val configuration = PeerConnection.RTCConfiguration(iceServers).apply {
                sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            }
            val created = factory!!.createPeerConnection(configuration, object : PeerConnection.Observer {
                override fun onIceCandidate(candidate: IceCandidate) {
                    main.post {
                        send(JSONObject().put("type", "webrtc.ice-candidate").put("candidate", JSONObject()
                            .put("candidate", candidate.sdp).put("sdpMid", candidate.sdpMid)
                            .put("sdpMLineIndex", candidate.sdpMLineIndex)))
                    }
                }
                override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) {
                    val incoming = receiver.track()
                    main.post {
                        if (peer == null || mediaTicket != mediaGeneration) return@post
                        if (incoming is VideoTrack) {
                            track?.removeSink(renderer); track = incoming
                            incoming.addSink(renderer); onVideo()
                        }
                        if (incoming is AudioTrack) incoming.setEnabled(true)
                    }
                }
                override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
                    main.post {
                        if (state == PeerConnection.IceConnectionState.FAILED) onStatus("视频连接失败，请在发送端重新开始投屏")
                    }
                }
                override fun onSignalingChange(state: PeerConnection.SignalingState) {}
                override fun onIceConnectionReceivingChange(receiving: Boolean) {}
                override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {}
                override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}
                override fun onAddStream(stream: MediaStream) {}
                override fun onRemoveStream(stream: MediaStream) {}
                override fun onDataChannel(channel: DataChannel) {}
                override fun onRenegotiationNeeded() {}
            }) ?: error("无法创建视频连接")
            peer = created
            created.setRemoteDescription(observer(created) {
                remoteReady = true
                pendingIce.forEach { created.addIceCandidate(it) }; pendingIce.clear()
                created.createAnswer(object : SdpObserver {
                    override fun onCreateSuccess(description: SessionDescription) {
                        main.post {
                            if (peer !== created) return@post
                            created.setLocalDescription(observer(created) {
                                send(JSONObject().put("type", "webrtc.answer").put("sdp", description.description))
                            }, description)
                        }
                    }
                    override fun onCreateFailure(error: String) { main.post { onStatus("视频协商失败") } }
                    override fun onSetSuccess() {}
                    override fun onSetFailure(error: String) {}
                }, MediaConstraints())
            }, SessionDescription(SessionDescription.Type.OFFER, sdp))
        } catch (e: Exception) { onStatus("设备无法初始化视频解码：${e.message}") }
    }

    private fun observer(expected: PeerConnection, success: () -> Unit) = object : SdpObserver {
        override fun onSetSuccess() { main.post { if (peer === expected) success() } }
        override fun onSetFailure(error: String) { main.post { if (peer === expected) onStatus("视频协商失败") } }
        override fun onCreateSuccess(description: SessionDescription) {}
        override fun onCreateFailure(error: String) {}
    }

    fun candidate(json: JSONObject) {
        val candidate = IceCandidate(json.optString("sdpMid"), json.optInt("sdpMLineIndex"), json.optString("candidate"))
        if (remoteReady) peer?.addIceCandidate(candidate) else if (pendingIce.size < 256) pendingIce.add(candidate)
    }

    fun closeVideo() {
        ++mediaGeneration
        track?.removeSink(renderer); track = null
        peer?.close(); peer?.dispose(); peer = null
        remoteReady = false; pendingIce.clear()
        renderer.clearImage()
    }

    fun stop() {
        stopped = true; ++generation
        main.removeCallbacksAndMessages(null)
        socket?.cancel(); socket = null
        closeVideo()
    }

    fun release() {
        stop()
        if (factory != null) renderer.release()
        factory?.dispose(); factory = null
        egl?.release(); egl = null
        http.dispatcher.cancelAll()
        http.connectionPool.evictAll()
    }
}
