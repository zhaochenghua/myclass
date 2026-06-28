package cn.edu.nb3.myclass

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.media.projection.MediaProjection
import android.net.Uri
import android.util.Log
import android.util.Size
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
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
import org.webrtc.ScreenCapturerAndroid
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoCapturer
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

enum class WebRtcCaptureMode {
    Camera,
    Screen
}

class CameraWebRtcClient(
    context: Context,
    private val renderer: SurfaceViewRenderer? = null,
    private val sendOffer: (String) -> Unit,
    private val sendIceCandidate: (IceCandidatePayload) -> Unit,
    private val updateStatus: (String) -> Unit,
    private val initialUseFrontCamera: Boolean = false,
    private val captureMode: WebRtcCaptureMode = WebRtcCaptureMode.Camera,
    private val screenCaptureData: Intent? = null,
    private val onCameraFacingChanged: (Boolean, String, Boolean, Boolean) -> Unit = { _, _, _, _ -> }
) {
    private val appContext = context.applicationContext
    private val eglBase = EglBase.create()
    private val factory: PeerConnectionFactory

    private var surfaceTextureHelper: SurfaceTextureHelper? = null
    private var videoCapturer: VideoCapturer? = null
    private var cameraCapturer: ControlledCamera2Capturer? = null
    private var videoSource: VideoSource? = null
    private var localVideoTrack: VideoTrack? = null
    private var localAudioTrack: AudioTrack? = null
    private var localVideoSender: RtpSender? = null
    private var localAudioSender: RtpSender? = null
    private var peerConnection: PeerConnection? = null
    private var useFrontCamera = initialUseFrontCamera
    private var previewStarted = false
    private var audioEnabled = false

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

        if (captureMode == WebRtcCaptureMode.Camera) {
            val previewRenderer = renderer
                ?: throw IllegalStateException("摄像头模式需要本地预览")
            previewRenderer.init(eglBase.eglBaseContext, null)
            previewRenderer.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT)
            previewRenderer.setEnableHardwareScaler(true)
        }

        val textureHelper = SurfaceTextureHelper.create(
            if (captureMode == WebRtcCaptureMode.Screen) {
                "MyClassScreenThread"
            } else {
                "MyClassCameraThread"
            },
            eglBase.eglBaseContext
        )
        val capturer = createVideoCapturer()
        val source = factory.createVideoSource(capturer.isScreencast)
        capturer.initialize(textureHelper, appContext, source.capturerObserver)
        val captureSize = captureStartSize()
        capturer.startCapture(captureSize.width, captureSize.height, captureFps())

        val videoTrack = factory.createVideoTrack("myclass-video", source)
        videoTrack.setEnabled(true)
        renderer?.let { videoTrack.addSink(it) }

        surfaceTextureHelper = textureHelper
        videoCapturer = capturer
        cameraCapturer = capturer as? ControlledCamera2Capturer
        videoSource = source
        localVideoTrack = videoTrack

        // Create audio track (disabled by default)
        val audioConstraints = MediaConstraints()
        val audioSource = factory.createAudioSource(audioConstraints)
        val audioTrack = factory.createAudioTrack("myclass-audio", audioSource)
        audioTrack.setEnabled(false)
        localAudioTrack = audioTrack

        previewStarted = true
        if (captureMode == WebRtcCaptureMode.Screen) {
            updateStatus("屏幕共享已准备")
        }
        updateStatus("摄像头预览已启动")
    }

    private fun createVideoCapturer(): VideoCapturer =
        when (captureMode) {
            WebRtcCaptureMode.Camera -> ControlledCamera2Capturer(
                context = appContext,
                initialUseFrontCamera = useFrontCamera,
                onCameraChanged = { isFrontCamera, label, supportsTorch, torchEnabled ->
                    useFrontCamera = isFrontCamera
                    renderer?.setMirror(isFrontCamera)
                    onCameraFacingChanged(isFrontCamera, label, supportsTorch, torchEnabled)
                },
                updateStatus = updateStatus
            )
            WebRtcCaptureMode.Screen -> ScreenCapturerAndroid(
                screenCaptureData ?: throw IllegalStateException("缺少屏幕共享授权"),
                object : MediaProjection.Callback() {
                    override fun onStop() {
                        updateStatus("屏幕共享已停止")
                    }
                }
            )
        }

    private fun captureStartSize(): Size =
        if (captureMode == WebRtcCaptureMode.Screen) {
            screenShareCaptureSize()
        } else {
            Size(BuildConfig.VIDEO_WIDTH, BuildConfig.VIDEO_HEIGHT)
        }

    private fun captureFps(): Int =
        if (captureMode == WebRtcCaptureMode.Screen) {
            SCREEN_SHARE_FPS
        } else {
            BuildConfig.VIDEO_FPS
        }

    private fun screenShareCaptureSize(): Size {
        val metrics = appContext.resources.displayMetrics
        val sourceWidth = metrics.widthPixels
        val sourceHeight = metrics.heightPixels
        if (sourceWidth <= 0 || sourceHeight <= 0) {
            return Size(SCREEN_SHARE_FALLBACK_WIDTH, SCREEN_SHARE_FALLBACK_HEIGHT)
        }

        val sourceLongEdge = max(sourceWidth, sourceHeight)
        val sourceShortEdge = min(sourceWidth, sourceHeight)
        val targetLongEdge = min(sourceLongEdge, SCREEN_SHARE_MAX_LONG_EDGE)
        val targetShortEdge = (sourceShortEdge * targetLongEdge.toFloat() / sourceLongEdge)
            .roundToInt()
        return Size(
            targetLongEdge.toEvenAtLeast(2),
            targetShortEdge.toEvenAtLeast(2)
        )
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
        // Add audio track (disabled by default)
        localAudioTrack?.let {
            connection.addTrack(it, listOf("myclass-stream"))?.also { sender ->
                localAudioSender = sender
            }
        }
        resendStaticPresentationBurst()

        val constraints = MediaConstraints().apply {
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveAudio", "true"))
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

    fun isAudioEnabled(): Boolean = audioEnabled

    fun setAudioEnabled(enabled: Boolean): Boolean {
        audioEnabled = enabled
        localAudioTrack?.setEnabled(enabled)
        return true
    }

    fun toggleAudio(): Boolean {
        audioEnabled = !audioEnabled
        localAudioTrack?.setEnabled(audioEnabled)
        return audioEnabled
    }

    fun setTorchEnabled(enabled: Boolean): Boolean =
        cameraCapturer?.setTorchEnabled(enabled) == true

    fun isTorchEnabled(): Boolean =
        cameraCapturer?.isTorchEnabled() == true

    fun isTorchSupported(): Boolean =
        cameraCapturer?.isTorchSupported() == true

    fun setFrameLocked(locked: Boolean): Boolean {
        val applied = cameraCapturer?.setFrameLocked(locked) == true
        if (applied) {
            updateStatus(if (locked) "画面已锁定" else "画面已恢复实时")
        }
        return applied
    }

    fun isFrameLocked(): Boolean =
        cameraCapturer?.isFrameLocked() == true

    fun lockedFrameZoomRatio(): Float =
        cameraCapturer?.lockedFrameZoomRatio() ?: 1f

    fun lockedFramePresentation(): LockedFramePresentation =
        cameraCapturer?.lockedFramePresentation()
            ?: LockedFramePresentation(
                zoomRatio = 1f,
                cropX = 0f,
                cropY = 0f,
                cropWidth = 1f,
                cropHeight = 1f
            )

    fun isImageProjectionActive(): Boolean =
        cameraCapturer?.isImageProjectionActive() == true

    fun isStaticPresentationActive(): Boolean =
        cameraCapturer?.isStaticPresentationActive() == true

    fun showImage(uri: Uri) {
        val bitmap = decodeGalleryBitmap(uri)
            ?: throw IllegalArgumentException("无法读取所选图片")
        val applied = cameraCapturer?.setImageProjection(bitmap) == true
        if (!applied) {
            bitmap.recycle()
            throw IllegalStateException("图片投屏启动失败")
        }
        updateStatus("图片投屏：${bitmap.width}x${bitmap.height}")
    }

    fun clearImageProjection() {
        cameraCapturer?.clearImageProjection()
        updateStatus("已恢复摄像头画面")
    }

    fun refreshLockedFramePreview() {
        if (cameraCapturer?.isStaticPresentationActive() == true) {
            renderer?.requestLayout()
            cameraCapturer?.resendLockedFrameBurst(repeatCount = 4, intervalMs = 80L)
        }
    }

    private fun resendStaticPresentationBurst() {
        if (cameraCapturer?.isStaticPresentationActive() == true) {
            cameraCapturer?.resendLockedFrameBurst()
        }
    }

    fun zoomBy(scaleFactor: Float) {
        val zoomRatio = cameraCapturer?.zoomBy(scaleFactor) ?: return
        updateStatus("缩放：${"%.1f".format(zoomRatio)}x")
    }

    fun panLockedFrameBy(deltaXNormalized: Float, deltaYNormalized: Float): Boolean =
        cameraCapturer?.panLockedFrameBy(deltaXNormalized, deltaYNormalized) == true

    fun focusAt(normalizedX: Float, normalizedY: Float) {
        cameraCapturer?.focusAt(normalizedX, normalizedY)
    }

    private fun decodeGalleryBitmap(uri: Uri): Bitmap? {
        val bounds = BitmapFactory.Options().apply {
            inJustDecodeBounds = true
        }
        appContext.contentResolver.openInputStream(uri)?.use {
            BitmapFactory.decodeStream(it, null, bounds)
        }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
            return null
        }

        val sampleSize = calculateSampleSize(bounds.outWidth, bounds.outHeight, MAX_IMAGE_SOURCE_EDGE)
        val decodeOptions = BitmapFactory.Options().apply {
            inSampleSize = sampleSize
            inPreferredConfig = Bitmap.Config.ARGB_8888
        }
        val decoded = appContext.contentResolver.openInputStream(uri)?.use {
            BitmapFactory.decodeStream(it, null, decodeOptions)
        } ?: return null

        val orientation = appContext.contentResolver.openInputStream(uri)?.use {
            ExifInterface(it).getAttributeInt(
                ExifInterface.TAG_ORIENTATION,
                ExifInterface.ORIENTATION_NORMAL
            )
        } ?: ExifInterface.ORIENTATION_NORMAL
        return applyExifOrientation(decoded, orientation)
    }

    private fun calculateSampleSize(width: Int, height: Int, maxEdge: Int): Int {
        var sampleSize = 1
        var sampledWidth = width
        var sampledHeight = height
        while (sampledWidth / 2 >= maxEdge || sampledHeight / 2 >= maxEdge) {
            sampleSize *= 2
            sampledWidth /= 2
            sampledHeight /= 2
        }
        return sampleSize
    }

    private fun applyExifOrientation(bitmap: Bitmap, orientation: Int): Bitmap {
        val matrix = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_ROTATE_90 -> matrix.postRotate(90f)
            ExifInterface.ORIENTATION_ROTATE_180 -> matrix.postRotate(180f)
            ExifInterface.ORIENTATION_ROTATE_270 -> matrix.postRotate(270f)
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.postScale(-1f, 1f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.postScale(1f, -1f)
            else -> return bitmap
        }
        val rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
        if (rotated != bitmap) {
            bitmap.recycle()
        }
        return rotated
    }

    fun setDeviceRotation(rotationDegrees: Int) {
        cameraCapturer?.setDeviceRotation(rotationDegrees)
    }

    fun handleAnswer(sdp: String) {
        val connection = peerConnection ?: return
        val answer = SessionDescription(SessionDescription.Type.ANSWER, sdp)
        connection.setRemoteDescription(object : SimpleSdpObserver() {
            override fun onSetSuccess() {
                updateStatus("教室端已接收视频")
                resendStaticPresentationBurst()
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
        localAudioSender = null
        updateStatus("直播已停止，摄像头预览保留")
    }

    fun switchCamera() {
        cameraCapturer?.switchCamera()
    }

    fun release() {
        stopLive()
        renderer?.let { localVideoTrack?.removeSink(it) }
        runCatching { videoCapturer?.stopCapture() }
        videoCapturer?.dispose()
        cameraCapturer = null
        surfaceTextureHelper?.dispose()
        localVideoTrack?.dispose()
        localAudioTrack?.dispose()
        videoSource?.dispose()
        factory.dispose()
        eglBase.release()
        previewStarted = false
        audioEnabled = false
    }

    private fun configureVideoSender(sender: RtpSender) {
        val parameters = sender.parameters
        parameters.degradationPreference = RtpParameters.DegradationPreference.MAINTAIN_RESOLUTION
        parameters.encodings.forEach { encoding ->
            encoding.active = true
            encoding.minBitrateBps = minVideoBitrateBps()
            encoding.maxBitrateBps = maxVideoBitrateBps()
            encoding.maxFramerate = captureFps()
            encoding.scaleResolutionDownBy = 1.0
        }
        val applied = sender.setParameters(parameters)
        if (applied) {
            updateStatus("高清发送：原始比例 / 最高 12Mbps")
        } else {
            updateStatus("高清码率设置失败，继续使用默认码率")
        }
    }

    private fun minVideoBitrateBps(): Int =
        if (captureMode == WebRtcCaptureMode.Screen) {
            SCREEN_SHARE_MIN_BITRATE_BPS
        } else {
            VIDEO_MIN_BITRATE_BPS
        }

    private fun maxVideoBitrateBps(): Int =
        if (captureMode == WebRtcCaptureMode.Screen) {
            SCREEN_SHARE_MAX_BITRATE_BPS
        } else {
            VIDEO_MAX_BITRATE_BPS
        }

    private fun Int.toEvenAtLeast(minimum: Int): Int {
        val value = coerceAtLeast(minimum)
        return if (value % 2 == 0) value else value - 1
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
                resendStaticPresentationBurst()
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
        private const val MAX_IMAGE_SOURCE_EDGE = 4096
        private const val SCREEN_SHARE_FALLBACK_WIDTH = 1920
        private const val SCREEN_SHARE_FALLBACK_HEIGHT = 1080
        private const val SCREEN_SHARE_MAX_LONG_EDGE = 2560
        private const val SCREEN_SHARE_FPS = 12
        private const val SCREEN_SHARE_MIN_BITRATE_BPS = 1_500_000
        private const val SCREEN_SHARE_MAX_BITRATE_BPS = 25_000_000

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
