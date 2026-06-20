package cn.edu.nb3.myclass

import android.content.Context
import android.util.Log
import org.webrtc.CandidatePairChangeEvent
import org.webrtc.DataChannel
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.IceCandidateErrorEvent
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RendererCommon
import org.webrtc.RtpParameters
import org.webrtc.RtpReceiver
import org.webrtc.RtpSender
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoSource
import org.webrtc.VideoTrack

class CameraWebRtcClient(
    context: Context,
    private val renderer: SurfaceViewRenderer,
    private val sendOffer: (String) -> Unit,
    private val sendIceCandidate: (IceCandidatePayload) -> Unit,
    private val updateStatus: (String) -> Unit,
    private val initialUseFrontCamera: Boolean = false,
    private val onCameraFacingChanged: (Boolean, String, Boolean, Boolean) -> Unit = { _, _, _, _ -> }
) {
    private val appContext = context.applicationContext
    private val eglBase = EglBase.create()
    private val factory: PeerConnectionFactory

    private var surfaceTextureHelper: SurfaceTextureHelper? = null
    private var videoCapturer: ControlledCamera2Capturer? = null
    private var videoSource: VideoSource? = null
    private var localVideoTrack: VideoTrack? = null
    private var localVideoSender: RtpSender? = null
    private var peerConnection: PeerConnection? = null
    private var useFrontCamera = initialUseFrontCamera
    private var previewStarted = false

    init {
        initializeFactoryOnce(appContext)
        val options = PeerConnectionFactory.Options().apply {
            disableNetworkMonitor = BuildConfig.WEBRTC_DISABLE_NETWORK_MONITOR
        }
        Log.i(TAG, "Creating PeerConnectionFactory, disableNetworkMonitor=${options.disableNetworkMonitor}")
        factory = PeerConnectionFactory.builder()
            .setOptions(options)
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(eglBase.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(eglBase.eglBaseContext))
            .createPeerConnectionFactory()
    }

    fun startPreview() {
        if (previewStarted) {
            return
        }

        renderer.init(eglBase.eglBaseContext, null)
        renderer.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT)
        renderer.setEnableHardwareScaler(true)

        val textureHelper = SurfaceTextureHelper.create("MyClassCameraThread", eglBase.eglBaseContext)
        val source = factory.createVideoSource(false)
        val capturer = ControlledCamera2Capturer(
            context = appContext,
            initialUseFrontCamera = useFrontCamera,
            onCameraChanged = { isFrontCamera, label, supportsTorch, torchEnabled ->
                useFrontCamera = isFrontCamera
                renderer.setMirror(isFrontCamera)
                onCameraFacingChanged(isFrontCamera, label, supportsTorch, torchEnabled)
            },
            updateStatus = updateStatus
        )
        capturer.initialize(textureHelper, appContext, source.capturerObserver)
        capturer.startCapture(BuildConfig.VIDEO_WIDTH, BuildConfig.VIDEO_HEIGHT, BuildConfig.VIDEO_FPS)

        val videoTrack = factory.createVideoTrack("myclass-video", source)
        videoTrack.setEnabled(true)
        videoTrack.addSink(renderer)

        surfaceTextureHelper = textureHelper
        videoCapturer = capturer
        videoSource = source
        localVideoTrack = videoTrack
        previewStarted = true
        updateStatus("摄像头预览已启动")
    }

    fun startLive() {
        if (!previewStarted) {
            startPreview()
        }
        if (peerConnection != null) {
            updateStatus("直播已经开始")
            return
        }

        Log.i(TAG, "startLive: creating RTCConfiguration")
        val config = PeerConnection.RTCConfiguration(emptyList())
        config.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        config.continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        config.tcpCandidatePolicy = PeerConnection.TcpCandidatePolicy.DISABLED

        Log.i(TAG, "startLive: creating PeerConnection")
        val connection = factory.createPeerConnection(config, peerObserver())
            ?: throw IllegalStateException("无法创建 WebRTC 连接")
        peerConnection = connection

        Log.i(TAG, "startLive: adding local video track")
        // Android 端只负责推送本地摄像头，浏览器端只接收。
        localVideoTrack?.let {
            connection.addTrack(it, listOf("myclass-stream"))?.also { sender ->
                localVideoSender = sender
                configureVideoSender(sender)
            }
        }
        resendLockedFrameBurst()

        val constraints = MediaConstraints().apply {
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveAudio", "false"))
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveVideo", "false"))
        }

        Log.i(TAG, "startLive: creating offer")
        connection.createOffer(object : SimpleSdpObserver() {
            override fun onCreateSuccess(description: SessionDescription) {
                connection.setLocalDescription(object : SimpleSdpObserver() {
                    override fun onSetSuccess() {
                        sendOffer(description.description)
                        updateStatus("直播信令已发送")
                    }
                }, description)
            }

            override fun onCreateFailure(error: String) {
                updateStatus("创建直播 offer 失败：$error")
            }
        }, constraints)
    }

    fun isLive(): Boolean = peerConnection != null

    fun setTorchEnabled(enabled: Boolean): Boolean =
        videoCapturer?.setTorchEnabled(enabled) == true

    fun isTorchEnabled(): Boolean =
        videoCapturer?.isTorchEnabled() == true

    fun isTorchSupported(): Boolean =
        videoCapturer?.isTorchSupported() == true

    fun setFrameLocked(locked: Boolean): Boolean {
        val applied = videoCapturer?.setFrameLocked(locked) == true
        if (applied) {
            updateStatus(if (locked) "画面已锁定" else "画面已恢复实时")
        }
        return applied
    }

    fun isFrameLocked(): Boolean =
        videoCapturer?.isFrameLocked() == true

    private fun resendLockedFrameBurst() {
        if (videoCapturer?.isFrameLocked() == true) {
            videoCapturer?.resendLockedFrameBurst()
        }
    }

    fun zoomBy(scaleFactor: Float) {
        val zoomRatio = videoCapturer?.zoomBy(scaleFactor) ?: return
        updateStatus("缩放：${"%.1f".format(zoomRatio)}x")
    }

    fun focusAt(normalizedX: Float, normalizedY: Float) {
        videoCapturer?.focusAt(normalizedX, normalizedY)
    }

    fun setDeviceRotation(rotationDegrees: Int) {
        videoCapturer?.setDeviceRotation(rotationDegrees)
    }

    fun handleAnswer(sdp: String) {
        val connection = peerConnection ?: return
        val answer = SessionDescription(SessionDescription.Type.ANSWER, sdp)
        connection.setRemoteDescription(object : SimpleSdpObserver() {
            override fun onSetSuccess() {
                updateStatus("教室端已接收视频")
                resendLockedFrameBurst()
            }

            override fun onSetFailure(error: String) {
                updateStatus("设置 answer 失败：$error")
            }
        }, answer)
    }

    fun addRemoteIceCandidate(candidate: IceCandidatePayload) {
        peerConnection?.addIceCandidate(
            IceCandidate(candidate.sdpMid, candidate.sdpMLineIndex, candidate.candidate)
        )
    }

    fun stopLive() {
        peerConnection?.close()
        peerConnection?.dispose()
        peerConnection = null
        localVideoSender = null
        updateStatus("直播已停止，摄像头预览保留")
    }

    fun switchCamera() {
        videoCapturer?.switchCamera()
    }

    fun release() {
        stopLive()
        localVideoTrack?.removeSink(renderer)
        runCatching { videoCapturer?.stopCapture() }
        videoCapturer?.dispose()
        surfaceTextureHelper?.dispose()
        localVideoTrack?.dispose()
        videoSource?.dispose()
        factory.dispose()
        eglBase.release()
        previewStarted = false
    }

    private fun configureVideoSender(sender: RtpSender) {
        val parameters = sender.parameters
        parameters.degradationPreference = RtpParameters.DegradationPreference.MAINTAIN_RESOLUTION
        parameters.encodings.forEach { encoding ->
            encoding.active = true
            encoding.minBitrateBps = VIDEO_MIN_BITRATE_BPS
            encoding.maxBitrateBps = VIDEO_MAX_BITRATE_BPS
            encoding.maxFramerate = BuildConfig.VIDEO_FPS
            encoding.scaleResolutionDownBy = 1.0
        }
        val applied = sender.setParameters(parameters)
        if (applied) {
            updateStatus("高清发送：原始比例 / 最高 12Mbps")
        } else {
            updateStatus("高清码率设置失败，继续使用默认码率")
        }
    }

    private fun peerObserver() = object : PeerConnection.Observer {
        override fun onSignalingChange(newState: PeerConnection.SignalingState) = Unit
        override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
        override fun onIceGatheringChange(newState: PeerConnection.IceGatheringState) = Unit
        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) = Unit
        override fun onAddStream(stream: MediaStream) = Unit
        override fun onRemoveStream(stream: MediaStream) = Unit
        override fun onDataChannel(dataChannel: DataChannel) = Unit
        override fun onRenegotiationNeeded() = Unit

        override fun onIceConnectionChange(newState: PeerConnection.IceConnectionState) {
            updateStatus("WebRTC 状态：${newState.name}")
        }

        override fun onIceCandidate(candidate: IceCandidate) {
            sendIceCandidate(
                IceCandidatePayload(
                    sdpMid = candidate.sdpMid,
                    sdpMLineIndex = candidate.sdpMLineIndex,
                    candidate = candidate.sdp
                )
            )
        }

        override fun onIceCandidateError(event: IceCandidateErrorEvent) {
            updateStatus("ICE candidate 收集失败：${event.errorText}")
        }

        override fun onAddTrack(receiver: RtpReceiver, mediaStreams: Array<out MediaStream>) = Unit
        override fun onRemoveTrack(receiver: RtpReceiver) = Unit
        override fun onTrack(transceiver: RtpTransceiver) = Unit
        override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
            if (newState == PeerConnection.PeerConnectionState.CONNECTED) {
                resendLockedFrameBurst()
            }
        }
        override fun onStandardizedIceConnectionChange(newState: PeerConnection.IceConnectionState) = Unit
        override fun onSelectedCandidatePairChanged(event: CandidatePairChangeEvent) = Unit
    }

    open class SimpleSdpObserver : SdpObserver {
        override fun onCreateSuccess(description: SessionDescription) = Unit
        override fun onSetSuccess() = Unit
        override fun onCreateFailure(error: String) = Unit
        override fun onSetFailure(error: String) = Unit
    }

    companion object {
        @Volatile
        private var factoryInitialized = false
        private const val TAG = "MyClassWebRtc"
        private const val VIDEO_MIN_BITRATE_BPS = 300_000
        private const val VIDEO_MAX_BITRATE_BPS = 12_000_000

        private fun initializeFactoryOnce(context: Context) {
            if (factoryInitialized) {
                return
            }
            synchronized(CameraWebRtcClient::class.java) {
                if (factoryInitialized) {
                    return
                }
                PeerConnectionFactory.initialize(
                    PeerConnectionFactory.InitializationOptions.builder(context)
                        .setEnableInternalTracer(false)
                        .createInitializationOptions()
                )
                factoryInitialized = true
            }
        }
    }
}
