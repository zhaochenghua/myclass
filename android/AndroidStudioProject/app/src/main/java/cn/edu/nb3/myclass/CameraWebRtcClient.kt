package cn.edu.nb3.myclass

import android.content.Context
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.Camera2Enumerator
import org.webrtc.CameraVideoCapturer
import org.webrtc.CandidatePairChangeEvent
import org.webrtc.DataChannel
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoCapturer
import org.webrtc.VideoSource
import org.webrtc.VideoTrack

class CameraWebRtcClient(
    context: Context,
    private val renderer: SurfaceViewRenderer,
    private val sendOffer: (String) -> Unit,
    private val sendIceCandidate: (IceCandidatePayload) -> Unit,
    private val updateStatus: (String) -> Unit
) {
    private val appContext = context.applicationContext
    private val eglBase = EglBase.create()
    private val factory: PeerConnectionFactory

    private var surfaceTextureHelper: SurfaceTextureHelper? = null
    private var videoCapturer: CameraVideoCapturer? = null
    private var videoSource: VideoSource? = null
    private var audioSource: AudioSource? = null
    private var localVideoTrack: VideoTrack? = null
    private var localAudioTrack: AudioTrack? = null
    private var peerConnection: PeerConnection? = null
    private var useFrontCamera = false
    private var previewStarted = false

    init {
        initializeFactoryOnce(appContext)
        val encoderFactory = DefaultVideoEncoderFactory(
            eglBase.eglBaseContext,
            true,
            true
        )
        val decoderFactory = DefaultVideoDecoderFactory(eglBase.eglBaseContext)
        factory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(encoderFactory)
            .setVideoDecoderFactory(decoderFactory)
            .createPeerConnectionFactory()
    }

    fun startPreview() {
        if (previewStarted) {
            return
        }

        renderer.init(eglBase.eglBaseContext, null)
        renderer.setEnableHardwareScaler(true)

        val capturer = createCameraCapturer()
            ?: throw IllegalStateException("未找到可用摄像头")

        val textureHelper = SurfaceTextureHelper.create("MyClassCameraThread", eglBase.eglBaseContext)
        val source = factory.createVideoSource(false)
        capturer.initialize(textureHelper, appContext, source.capturerObserver)
        capturer.startCapture(BuildConfig.VIDEO_WIDTH, BuildConfig.VIDEO_HEIGHT, BuildConfig.VIDEO_FPS)

        val videoTrack = factory.createVideoTrack("myclass-video", source)
        videoTrack.setEnabled(true)
        videoTrack.addSink(renderer)

        val audio = factory.createAudioSource(MediaConstraints())
        val audioTrack = factory.createAudioTrack("myclass-audio", audio)
        // 当前阶段音频只预留链路，默认静音，后续需要时直接打开即可。
        audioTrack.setEnabled(false)

        surfaceTextureHelper = textureHelper
        videoCapturer = capturer
        videoSource = source
        audioSource = audio
        localVideoTrack = videoTrack
        localAudioTrack = audioTrack
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

        val config = PeerConnection.RTCConfiguration(emptyList())
        config.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        config.continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY

        val connection = factory.createPeerConnection(config, peerObserver())
            ?: throw IllegalStateException("无法创建 WebRTC 连接")
        peerConnection = connection

        // Android 端只负责推送本地摄像头，浏览器端只接收。
        localVideoTrack?.let { connection.addTrack(it, listOf("myclass-stream")) }
        localAudioTrack?.let { connection.addTrack(it, listOf("myclass-stream")) }

        val constraints = MediaConstraints().apply {
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveAudio", "false"))
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveVideo", "false"))
        }

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

    fun handleAnswer(sdp: String) {
        val connection = peerConnection ?: return
        val answer = SessionDescription(SessionDescription.Type.ANSWER, sdp)
        connection.setRemoteDescription(object : SimpleSdpObserver() {
            override fun onSetSuccess() {
                updateStatus("教室端已接收视频")
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
        updateStatus("直播已停止，摄像头预览保留")
    }

    fun switchCamera() {
        val capturer = videoCapturer ?: return
        capturer.switchCamera(object : CameraVideoCapturer.CameraSwitchHandler {
            override fun onCameraSwitchDone(isFrontCamera: Boolean) {
                useFrontCamera = isFrontCamera
                renderer.setMirror(isFrontCamera)
                updateStatus(if (isFrontCamera) "已切换到前置摄像头" else "已切换到后置摄像头")
            }

            override fun onCameraSwitchError(errorDescription: String) {
                updateStatus("切换摄像头失败：$errorDescription")
            }
        })
    }

    fun release() {
        stopLive()
        localVideoTrack?.removeSink(renderer)
        runCatching { videoCapturer?.stopCapture() }
        videoCapturer?.dispose()
        surfaceTextureHelper?.dispose()
        localVideoTrack?.dispose()
        localAudioTrack?.dispose()
        videoSource?.dispose()
        audioSource?.dispose()
        factory.dispose()
        eglBase.release()
        previewStarted = false
    }

    private fun createCameraCapturer(): CameraVideoCapturer? {
        val enumerator = Camera2Enumerator(appContext)
        val names = enumerator.deviceNames
        val preferred = names.firstOrNull {
            if (useFrontCamera) enumerator.isFrontFacing(it) else enumerator.isBackFacing(it)
        }
        val fallback = names.firstOrNull()
        val selected = preferred ?: fallback ?: return null
        return enumerator.createCapturer(selected, null) as? CameraVideoCapturer
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

        override fun onAddTrack(receiver: RtpReceiver, mediaStreams: Array<out MediaStream>) = Unit
        override fun onTrack(transceiver: RtpTransceiver) = Unit
        override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) = Unit
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
