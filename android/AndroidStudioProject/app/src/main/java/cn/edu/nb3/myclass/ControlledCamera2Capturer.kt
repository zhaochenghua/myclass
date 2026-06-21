package cn.edu.nb3.myclass

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.SurfaceTexture
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.params.MeteringRectangle
import android.os.Handler
import android.util.Size
import android.view.Surface
import org.webrtc.CapturerObserver
import org.webrtc.JavaI420Buffer
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoFrame
import org.webrtc.VideoCapturer
import org.webrtc.VideoSink
import java.nio.ByteBuffer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

data class LockedFramePresentation(
    val zoomRatio: Float,
    val cropX: Float,
    val cropY: Float,
    val cropWidth: Float,
    val cropHeight: Float
)

class ControlledCamera2Capturer(
    context: Context,
    initialUseFrontCamera: Boolean,
    private val onCameraChanged: (Boolean, String, Boolean, Boolean) -> Unit,
    private val updateStatus: (String) -> Unit
) : VideoCapturer {
    private val appContext = context.applicationContext
    private val cameraManager = appContext.getSystemService(Context.CAMERA_SERVICE) as CameraManager
    private val cameras = loadCameras()

    private var surfaceTextureHelper: SurfaceTextureHelper? = null
    private var capturerObserver: CapturerObserver? = null
    private var cameraDevice: CameraDevice? = null
    private var captureSession: CameraCaptureSession? = null
    private var captureRequestBuilder: CaptureRequest.Builder? = null
    private var previewSurface: Surface? = null

    private var currentCameraIndex = preferredCameraIndex(initialUseFrontCamera)
    private var captureWidth = 1920
    private var captureHeight = 1080
    private var activeCaptureWidth = 1920
    private var activeCaptureHeight = 1080
    private var captureFps = 24
    private var isCapturing = false
    private var isListening = false
    private var zoomRatio = 1f
    private var lockedFrameZoomRatio = 1f
    private var lockedFramePanX = 0f
    private var lockedFramePanY = 0f
    private var imageBitmap: Bitmap? = null
    private var imageFrameWidth = 1920
    private var imageFrameHeight = 1440
    private var imageZoomRatio = 1f
    private var imagePanX = 0f
    private var imagePanY = 0f
    private var imageFrameGeneration = 0
    private var deviceRotationDegrees = 0
    private var torchEnabled = false
    private var focusRegion: MeteringRectangle? = null
    @Volatile
    private var frameLocked = false
    @Volatile
    private var frameLockRequested = false
    @Volatile
    private var lockedFrame: VideoFrame? = null

    override fun initialize(
        surfaceTextureHelper: SurfaceTextureHelper,
        context: Context,
        capturerObserver: CapturerObserver
    ) {
        this.surfaceTextureHelper = surfaceTextureHelper
        this.capturerObserver = capturerObserver
    }

    override fun startCapture(width: Int, height: Int, framerate: Int) {
        captureWidth = width
        captureHeight = height
        captureFps = framerate
        runOnCameraThread {
            if (isCapturing) {
                return@runOnCameraThread
            }
            isCapturing = true
            frameLocked = false
            frameLockRequested = false
            clearLockedFrame()
            zoomRatio = 1f
            lockedFrameZoomRatio = 1f
            resetLockedFramePan()
            clearImageProjectionInternal()
            torchEnabled = false
            focusRegion = null
            startSurfaceTexture()
            openCurrentCamera()
        }
    }

    override fun stopCapture() {
        if (!isCapturing && !isListening) {
            return
        }
        val helper = surfaceTextureHelper
        val handler = helper?.handler
        if (handler == null) {
            val shouldNotifyStopped = isCapturing
            isCapturing = false
            frameLocked = false
            frameLockRequested = false
            clearLockedFrame()
            clearImageProjectionInternal()
            closeCamera()
            if (shouldNotifyStopped) {
                capturerObserver?.onCapturerStopped()
            }
            return
        }

        if (handler.looper.thread == Thread.currentThread()) {
            val shouldNotifyStopped = isCapturing
            isCapturing = false
            frameLocked = false
            frameLockRequested = false
            clearLockedFrame()
            clearImageProjectionInternal()
            closeCamera()
            stopSurfaceTexture()
            if (shouldNotifyStopped) {
                capturerObserver?.onCapturerStopped()
            }
            return
        }

        val latch = CountDownLatch(1)
        handler.post {
            val shouldNotifyStopped = isCapturing
            isCapturing = false
            frameLocked = false
            frameLockRequested = false
            clearLockedFrame()
            clearImageProjectionInternal()
            closeCamera()
            stopSurfaceTexture()
            if (shouldNotifyStopped) {
                capturerObserver?.onCapturerStopped()
            }
            latch.countDown()
        }
        latch.await(2, TimeUnit.SECONDS)
    }

    override fun changeCaptureFormat(width: Int, height: Int, framerate: Int) {
        captureWidth = width
        captureHeight = height
        captureFps = framerate
        runOnCameraThread {
            if (!isCapturing) {
                return@runOnCameraThread
            }
            closeCamera()
            startSurfaceTexture()
            openCurrentCamera()
        }
    }

    override fun dispose() {
        stopCapture()
        surfaceTextureHelper = null
        capturerObserver = null
    }

    override fun isScreencast(): Boolean = false

    fun switchCamera() {
        runOnCameraThread {
            if (cameras.size <= 1) {
                updateStatus("当前设备只开放了一个可用镜头")
                return@runOnCameraThread
            }
            currentCameraIndex = (currentCameraIndex + 1) % cameras.size
            zoomRatio = 1f
            lockedFrameZoomRatio = 1f
            resetLockedFramePan()
            clearImageProjectionInternal()
            torchEnabled = false
            focusRegion = null
            frameLocked = false
            frameLockRequested = false
            clearLockedFrame()
            notifyCameraChanged()
            if (isCapturing) {
                closeCamera()
                startSurfaceTexture()
                openCurrentCamera()
            }
        }
    }

    fun setTorchEnabled(enabled: Boolean): Boolean {
        val camera = currentCameraOrNull() ?: return false
        if (enabled && !camera.supportsTorch) {
            torchEnabled = false
            updateStatus("当前镜头不支持补光灯")
            return false
        }

        torchEnabled = enabled && camera.supportsTorch
        runOnCameraThread {
            applyRepeatingRequest()
        }
        updateStatus(if (torchEnabled) "补光灯已打开" else "补光灯已关闭")
        return torchEnabled
    }

    fun setFrameLocked(locked: Boolean): Boolean {
        if (locked) {
            lockedFrameZoomRatio = 1f
            resetLockedFramePan()
            frameLockRequested = true
        } else {
            frameLockRequested = false
            frameLocked = false
            lockedFrameZoomRatio = 1f
            resetLockedFramePan()
            clearLockedFrame()
        }
        return true
    }

    fun isFrameLocked(): Boolean = frameLocked || frameLockRequested

    fun isImageProjectionActive(): Boolean = imageBitmap != null

    fun isStaticPresentationActive(): Boolean = imageBitmap != null || isFrameLocked()

    fun setImageProjection(bitmap: Bitmap): Boolean {
        runOnCameraThreadBlocking {
            clearImageProjectionInternal()
            frameLocked = false
            frameLockRequested = false
            clearLockedFrame()
            zoomRatio = 1f
            focusRegion = null
            imageBitmap = bitmap
            val size = imageOutputFrameSize()
            imageFrameWidth = size.width
            imageFrameHeight = size.height
            imageZoomRatio = 1f
            resetImagePan()
            resendImageFrameBurst()
        }
        return true
    }

    fun clearImageProjection() {
        runOnCameraThreadBlocking(atFront = true) {
            clearImageProjectionInternal()
        }
    }

    fun lockedFrameZoomRatio(): Float =
        when {
            imageBitmap != null -> imageZoomRatio
            frameLocked || frameLockRequested -> lockedFrameZoomRatio
            else -> 1f
        }

    fun lockedFramePresentation(): LockedFramePresentation {
        imageBitmap?.let {
            val crop = imageCrop()
            return LockedFramePresentation(
                zoomRatio = imageZoomRatio,
                cropX = crop.x,
                cropY = crop.y,
                cropWidth = crop.width,
                cropHeight = crop.height
            )
        }
        if (!frameLocked && !frameLockRequested) {
            return FULL_FRAME_PRESENTATION
        }
        val rotation = currentCameraOrNull()?.let { frameOrientation(it) } ?: lockedFrame?.rotation ?: 0
        val crop = rotateCropForDisplay(lockedFrameCropInBuffer(), rotation)
        return LockedFramePresentation(
            zoomRatio = lockedFrameZoomRatio,
            cropX = crop.x,
            cropY = crop.y,
            cropWidth = crop.width,
            cropHeight = crop.height
        )
    }

    fun resendLockedFrameBurst(repeatCount: Int = 12, intervalMs: Long = 250L) {
        if (imageBitmap != null) {
            resendImageFrameBurst(repeatCount, intervalMs)
            return
        }
        val handler = surfaceTextureHelper?.handler
        if (handler == null) {
            repeatLockedFrameIfNeeded()
            return
        }
        repeat(repeatCount) { index ->
            handler.postDelayed(
                { repeatLockedFrameIfNeeded() },
                index * intervalMs
            )
        }
    }

    fun isTorchEnabled(): Boolean = torchEnabled

    fun isTorchSupported(): Boolean = currentCameraOrNull()?.supportsTorch == true

    fun zoomBy(scaleFactor: Float): Float {
        imageBitmap?.let {
            val maxZoom = maxImageZoom()
            val nextImageZoom = (imageZoomRatio * scaleFactor).coerceIn(1f, maxZoom)
            if (nextImageZoom == imageZoomRatio) {
                return imageZoomRatio
            }
            imageZoomRatio = nextImageZoom
            coerceImagePan()
            runOnCameraThread {
                resendImageFrameBurst(repeatCount = 4, intervalMs = 80L)
            }
            return imageZoomRatio
        }

        val camera = currentCameraOrNull() ?: return zoomRatio
        if (frameLocked || frameLockRequested) {
            val nextLockedZoom = (lockedFrameZoomRatio * scaleFactor).coerceIn(1f, camera.maxZoom)
            if (nextLockedZoom == lockedFrameZoomRatio) {
                return lockedFrameZoomRatio
            }
            lockedFrameZoomRatio = nextLockedZoom
            if (lockedFrameZoomRatio <= 1.01f) {
                resetLockedFramePan()
            } else {
                coerceLockedFramePan()
            }
            runOnCameraThread {
                if (frameLocked) {
                    resendLockedFrameBurst(repeatCount = 4, intervalMs = 80L)
                }
            }
            return lockedFrameZoomRatio
        }

        val nextZoom = (zoomRatio * scaleFactor).coerceIn(1f, camera.maxZoom)
        if (nextZoom == zoomRatio) {
            return zoomRatio
        }
        zoomRatio = nextZoom
        focusRegion = null
        runOnCameraThread {
            applyRepeatingRequest()
        }
        return zoomRatio
    }

    fun panLockedFrameBy(deltaXNormalized: Float, deltaYNormalized: Float): Boolean {
        if (imageBitmap != null) {
            return panImageBy(deltaXNormalized, deltaYNormalized)
        }
        if (!frameLocked || lockedFrameZoomRatio <= 1.01f || lockedFrame == null) {
            return false
        }

        val rotation = currentCameraOrNull()?.let { frameOrientation(it) } ?: lockedFrame?.rotation ?: 0
        val (sourceDx, sourceDy) = displayDeltaToBufferDelta(
            deltaXNormalized,
            deltaYNormalized,
            rotation
        )
        val previousPanX = lockedFramePanX
        val previousPanY = lockedFramePanY
        lockedFramePanX -= sourceDx / lockedFrameZoomRatio
        lockedFramePanY -= sourceDy / lockedFrameZoomRatio
        coerceLockedFramePan()

        if (abs(previousPanX - lockedFramePanX) < PAN_EPSILON &&
            abs(previousPanY - lockedFramePanY) < PAN_EPSILON
        ) {
            return false
        }

        runOnCameraThread {
            repeatLockedFrameIfNeeded()
        }
        return true
    }

    fun focusAt(normalizedX: Float, normalizedY: Float) {
        val camera = currentCameraOrNull() ?: return
        if (!camera.supportsFocus) {
            updateStatus("当前镜头不支持手动对焦")
            return
        }

        val region = createMeteringRegion(
            normalizedX.coerceIn(0f, 1f),
            normalizedY.coerceIn(0f, 1f),
            camera
        ) ?: return
        focusRegion = region
        runOnCameraThread {
            triggerFocus(region)
        }
        updateStatus("已对焦")
    }

    fun setDeviceRotation(rotationDegrees: Int) {
        var repeatLockedFrame = false
        var repeatImageFrame = false
        runOnCameraThreadBlocking {
            val changed = deviceRotationDegrees != rotationDegrees
            deviceRotationDegrees = rotationDegrees
            if (changed && frameLocked) {
                repeatLockedFrame = true
            }
            if (changed && imageBitmap != null) {
                updateImageFrameSizeForRotation()
                repeatImageFrame = true
            }
        }
        if (repeatLockedFrame) {
            runOnCameraThread {
                repeatLockedFrameIfNeeded()
            }
        }
        if (repeatImageFrame) {
            runOnCameraThread {
                repeatImageFrameIfNeeded()
            }
        }
    }

    fun isFrontCamera(): Boolean = currentCameraOrNull()?.isFrontCamera == true

    private fun startSurfaceTexture() {
        val helper = surfaceTextureHelper ?: return
        val size = chooseOutputSize(currentCameraOrNull())
        activeCaptureWidth = size.width
        activeCaptureHeight = size.height
        helper.setTextureSize(activeCaptureWidth, activeCaptureHeight)
        helper.surfaceTexture.setDefaultBufferSize(activeCaptureWidth, activeCaptureHeight)
        if (!isListening) {
            helper.startListening(VideoSink { frame ->
                deliverCameraFrame(frame)
            })
            isListening = true
        }
    }

    private fun stopSurfaceTexture() {
        val helper = surfaceTextureHelper ?: return
        if (isListening) {
            helper.stopListening()
            isListening = false
        }
    }

    @SuppressLint("MissingPermission")
    private fun openCurrentCamera() {
        val camera = currentCameraOrNull()
        val helper = surfaceTextureHelper
        val handler = helper?.handler
        if (camera == null || helper == null || handler == null) {
            capturerObserver?.onCapturerStarted(false)
            updateStatus("未找到可用摄像头")
            return
        }

        notifyCameraChanged()
        cameraManager.openCamera(
            camera.id,
            object : CameraDevice.StateCallback() {
                override fun onOpened(device: CameraDevice) {
                    cameraDevice = device
                    createCameraSession(device, helper, handler, camera)
                }

                override fun onDisconnected(device: CameraDevice) {
                    device.close()
                    if (cameraDevice == device) {
                        cameraDevice = null
                    }
                    capturerObserver?.onCapturerStarted(false)
                }

                override fun onError(device: CameraDevice, error: Int) {
                    device.close()
                    if (cameraDevice == device) {
                        cameraDevice = null
                    }
                    capturerObserver?.onCapturerStarted(false)
                    updateStatus("摄像头打开失败：$error")
                }
            },
            handler
        )
    }

    @Suppress("DEPRECATION")
    private fun createCameraSession(
        device: CameraDevice,
        helper: SurfaceTextureHelper,
        handler: Handler,
        camera: CameraInfo
    ) {
        val surface = Surface(helper.surfaceTexture)
        previewSurface = surface
        device.createCaptureSession(
            listOf(surface),
            object : CameraCaptureSession.StateCallback() {
                override fun onConfigured(session: CameraCaptureSession) {
                    captureSession = session
                    captureRequestBuilder = device.createCaptureRequest(CameraDevice.TEMPLATE_RECORD)
                        .apply {
                            addTarget(surface)
                        }
                    applyRepeatingRequest()
                    capturerObserver?.onCapturerStarted(true)
                    updateStatus("${camera.label} 已启动：${activeCaptureWidth}x${activeCaptureHeight}@${captureFps}fps")
                }

                override fun onConfigureFailed(session: CameraCaptureSession) {
                    capturerObserver?.onCapturerStarted(false)
                    updateStatus("摄像头会话配置失败")
                }
            },
            handler
        )
    }

    private fun closeCamera() {
        runCatching { captureSession?.stopRepeating() }
        captureSession?.close()
        captureSession = null
        captureRequestBuilder = null

        cameraDevice?.close()
        cameraDevice = null

        previewSurface?.release()
        previewSurface = null
    }

    private fun applyRepeatingRequest() {
        val session = captureSession ?: return
        val builder = captureRequestBuilder ?: return
        applyCommonControls(builder)
        runCatching {
            session.setRepeatingRequest(builder.build(), null, surfaceTextureHelper?.handler)
        }
    }

    private fun triggerFocus(region: MeteringRectangle) {
        val session = captureSession ?: return
        val builder = captureRequestBuilder ?: return
        val handler = surfaceTextureHelper?.handler

        applyCommonControls(builder)
        builder.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_AUTO)
        val camera = currentCameraOrNull()
        if ((camera?.maxAfRegions ?: 0) > 0) {
            builder.set(CaptureRequest.CONTROL_AF_REGIONS, arrayOf(region))
        }
        if ((camera?.maxAeRegions ?: 0) > 0) {
            builder.set(CaptureRequest.CONTROL_AE_REGIONS, arrayOf(region))
        }
        builder.set(CaptureRequest.CONTROL_AF_TRIGGER, CaptureRequest.CONTROL_AF_TRIGGER_START)
        runCatching {
            session.capture(builder.build(), null, handler)
            builder.set(CaptureRequest.CONTROL_AF_TRIGGER, CaptureRequest.CONTROL_AF_TRIGGER_IDLE)
            builder.set(CaptureRequest.CONTROL_AF_MODE, supportedContinuousAfMode())
            session.setRepeatingRequest(builder.build(), null, handler)
        }
    }

    private fun applyCommonControls(builder: CaptureRequest.Builder) {
        builder.set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO)
        builder.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON)
        builder.set(CaptureRequest.CONTROL_AF_MODE, supportedContinuousAfMode())
        currentCropRegion()?.let {
            builder.set(CaptureRequest.SCALER_CROP_REGION, it)
        }
        val camera = currentCameraOrNull()
        if (camera?.supportsTorch == true) {
            builder.set(
                CaptureRequest.FLASH_MODE,
                if (torchEnabled) CaptureRequest.FLASH_MODE_TORCH else CaptureRequest.FLASH_MODE_OFF
            )
        }
        focusRegion?.let {
            if ((camera?.maxAfRegions ?: 0) > 0) {
                builder.set(CaptureRequest.CONTROL_AF_REGIONS, arrayOf(it))
            }
            if ((camera?.maxAeRegions ?: 0) > 0) {
                builder.set(CaptureRequest.CONTROL_AE_REGIONS, arrayOf(it))
            }
        }
    }

    private fun supportedContinuousAfMode(): Int {
        val camera = currentCameraOrNull() ?: return CaptureRequest.CONTROL_AF_MODE_OFF
        return when {
            camera.afModes.contains(CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO) ->
                CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO
            camera.afModes.contains(CaptureRequest.CONTROL_AF_MODE_AUTO) ->
                CaptureRequest.CONTROL_AF_MODE_AUTO
            else -> CaptureRequest.CONTROL_AF_MODE_OFF
        }
    }

    private fun currentCropRegion(): Rect? {
        val camera = currentCameraOrNull() ?: return null
        val activeArray = camera.activeArray ?: return null
        if (zoomRatio <= 1f) {
            return activeArray
        }

        val cropWidth = (activeArray.width() / zoomRatio).toInt().coerceAtLeast(1)
        val cropHeight = (activeArray.height() / zoomRatio).toInt().coerceAtLeast(1)
        val left = activeArray.left + (activeArray.width() - cropWidth) / 2
        val top = activeArray.top + (activeArray.height() - cropHeight) / 2
        return Rect(left, top, left + cropWidth, top + cropHeight)
    }

    private fun createMeteringRegion(
        normalizedX: Float,
        normalizedY: Float,
        camera: CameraInfo
    ): MeteringRectangle? {
        val crop = currentCropRegion() ?: camera.activeArray ?: return null
        val focusX = if (camera.isFrontCamera) 1f - normalizedX else normalizedX
        val sensorX = crop.left + (crop.width() * focusX).toInt()
        val sensorY = crop.top + (crop.height() * normalizedY).toInt()
        val boxSize = max(120, min(crop.width(), crop.height()) / 7)
        val left = (sensorX - boxSize / 2).coerceIn(crop.left, crop.right - 1)
        val top = (sensorY - boxSize / 2).coerceIn(crop.top, crop.bottom - 1)
        val right = (left + boxSize).coerceAtMost(crop.right)
        val bottom = (top + boxSize).coerceAtMost(crop.bottom)
        return MeteringRectangle(
            Rect(left, top, right, bottom),
            MeteringRectangle.METERING_WEIGHT_MAX - 1
        )
    }

    private fun deliverCameraFrame(frame: VideoFrame) {
        if (imageBitmap != null) {
            return
        }
        if (frameLocked) {
            return
        }

        val camera = currentCameraOrNull()
        val textureBuffer = frame.buffer as? VideoFrame.TextureBuffer
        if (camera == null || textureBuffer == null) {
            lockFrameIfRequested(frame)
            capturerObserver?.onFrameCaptured(frame)
            return
        }

        val transform = Matrix().apply {
            preTranslate(0.5f, 0.5f)
            if (camera.isFrontCamera) {
                preScale(-1f, 1f)
            }
            preRotate(-camera.sensorOrientation.toFloat())
            preTranslate(-0.5f, -0.5f)
        }
        val transformedBuffer = textureBuffer.applyTransformMatrix(
            transform,
            textureBuffer.width,
            textureBuffer.height
        )
        val cameraFrame = VideoFrame(
            transformedBuffer,
            frameOrientation(camera),
            frame.timestampNs
        )
        lockFrameIfRequested(cameraFrame)
        capturerObserver?.onFrameCaptured(cameraFrame)
        cameraFrame.release()
    }

    private fun lockFrameIfRequested(frame: VideoFrame) {
        if (!frameLockRequested) {
            return
        }
        val copiedBuffer = frame.buffer.toI420()
        val copiedFrame = VideoFrame(copiedBuffer, frame.rotation, frame.timestampNs)
        val previousFrame = lockedFrame
        lockedFrame = copiedFrame
        previousFrame?.release()
        frameLocked = true
        frameLockRequested = false
    }

    private fun repeatLockedFrameIfNeeded() {
        if (!frameLocked) {
            return
        }
        val frame = lockedFrame ?: return
        val rotation = currentCameraOrNull()?.let { frameOrientation(it) } ?: frame.rotation
        val buffer = lockedFrameBuffer(frame)
        val repeatedFrame = VideoFrame(
            buffer,
            rotation,
            System.nanoTime()
        )
        capturerObserver?.onFrameCaptured(repeatedFrame)
        repeatedFrame.release()
    }

    private fun lockedFrameBuffer(frame: VideoFrame): VideoFrame.Buffer {
        val buffer = frame.buffer
        if (lockedFrameZoomRatio <= 1.01f) {
            buffer.retain()
            return buffer
        }

        val width = buffer.width
        val height = buffer.height
        val crop = lockedFrameCropInBuffer()
        val cropWidth = (width * crop.width).roundToInt().coerceIn(1, width)
        val cropHeight = (height * crop.height).roundToInt().coerceIn(1, height)
        val cropX = (width * crop.x)
            .roundToInt()
            .coerceIn(0, width - cropWidth)
        val cropY = (height * crop.y)
            .roundToInt()
            .coerceIn(0, height - cropHeight)
        return buffer.cropAndScale(cropX, cropY, cropWidth, cropHeight, width, height)
    }

    private fun lockedFrameCropInBuffer(): NormalizedCrop {
        val zoom = lockedFrameZoomRatio.coerceAtLeast(1f)
        val cropWidth = (1f / zoom).coerceIn(0f, 1f)
        val cropHeight = (1f / zoom).coerceIn(0f, 1f)
        val maxCropX = 1f - cropWidth
        val maxCropY = 1f - cropHeight
        return NormalizedCrop(
            x = (maxCropX / 2f + lockedFramePanX).coerceIn(0f, maxCropX),
            y = (maxCropY / 2f + lockedFramePanY).coerceIn(0f, maxCropY),
            width = cropWidth,
            height = cropHeight
        )
    }

    private fun rotateCropForDisplay(crop: NormalizedCrop, rotation: Int): NormalizedCrop =
        when (((rotation % 360) + 360) % 360) {
            90 -> NormalizedCrop(
                x = 1f - crop.y - crop.height,
                y = crop.x,
                width = crop.height,
                height = crop.width
            )
            180 -> NormalizedCrop(
                x = 1f - crop.x - crop.width,
                y = 1f - crop.y - crop.height,
                width = crop.width,
                height = crop.height
            )
            270 -> NormalizedCrop(
                x = crop.y,
                y = 1f - crop.x - crop.width,
                width = crop.height,
                height = crop.width
            )
            else -> crop
        }

    private fun displayDeltaToBufferDelta(
        deltaXNormalized: Float,
        deltaYNormalized: Float,
        rotation: Int
    ): Pair<Float, Float> =
        when (((rotation % 360) + 360) % 360) {
            90 -> Pair(deltaYNormalized, -deltaXNormalized)
            180 -> Pair(-deltaXNormalized, -deltaYNormalized)
            270 -> Pair(-deltaYNormalized, deltaXNormalized)
            else -> Pair(deltaXNormalized, deltaYNormalized)
        }

    private fun coerceLockedFramePan() {
        val limit = ((lockedFrameZoomRatio - 1f) / (2f * lockedFrameZoomRatio))
            .coerceAtLeast(0f)
        lockedFramePanX = lockedFramePanX.coerceIn(-limit, limit)
        lockedFramePanY = lockedFramePanY.coerceIn(-limit, limit)
    }

    private fun resetLockedFramePan() {
        lockedFramePanX = 0f
        lockedFramePanY = 0f
    }

    private fun resendImageFrameBurst(repeatCount: Int = 12, intervalMs: Long = 250L) {
        val handler = surfaceTextureHelper?.handler
        imageFrameGeneration += 1
        val generation = imageFrameGeneration
        if (handler == null) {
            repeatImageFrameIfNeeded(generation)
            return
        }
        repeat(repeatCount) { index ->
            handler.postDelayed(
                { repeatImageFrameIfNeeded(generation) },
                index * intervalMs
            )
        }
    }

    private fun repeatImageFrameIfNeeded(expectedGeneration: Int? = null) {
        if (expectedGeneration != null && expectedGeneration != imageFrameGeneration) {
            return
        }
        val bitmap = imageBitmap ?: return
        val buffer = renderImageToI420(bitmap)
        val frame = VideoFrame(buffer, 0, System.nanoTime())
        capturerObserver?.onFrameCaptured(frame)
        frame.release()
    }

    private fun renderImageToI420(bitmap: Bitmap): VideoFrame.Buffer {
        val output = Bitmap.createBitmap(imageFrameWidth, imageFrameHeight, Bitmap.Config.ARGB_8888)
        val crop = imageCrop()
        val sourceWidth = (bitmap.width * crop.width).roundToInt().coerceIn(1, bitmap.width)
        val sourceHeight = (bitmap.height * crop.height).roundToInt().coerceIn(1, bitmap.height)
        val sourceX = (bitmap.width * crop.x).roundToInt().coerceIn(0, bitmap.width - sourceWidth)
        val sourceY = (bitmap.height * crop.y).roundToInt().coerceIn(0, bitmap.height - sourceHeight)
        val source = Rect(
            sourceX,
            sourceY,
            sourceX + sourceWidth,
            sourceY + sourceHeight
        )
        Canvas(output).drawBitmap(
            bitmap,
            source,
            RectF(0f, 0f, imageFrameWidth.toFloat(), imageFrameHeight.toFloat()),
            IMAGE_PAINT
        )
        val buffer = bitmapToI420(output)
        output.recycle()
        return buffer
    }

    private fun bitmapToI420(bitmap: Bitmap): JavaI420Buffer {
        val width = bitmap.width
        val height = bitmap.height
        val pixels = IntArray(width * height)
        bitmap.getPixels(pixels, 0, width, 0, 0, width, height)
        val buffer = JavaI420Buffer.allocate(width, height)
        val dataY = buffer.dataY
        val dataU = buffer.dataU
        val dataV = buffer.dataV
        val strideY = buffer.strideY
        val strideU = buffer.strideU
        val strideV = buffer.strideV

        for (y in 0 until height) {
            for (x in 0 until width) {
                val pixel = pixels[y * width + x]
                val r = (pixel shr 16) and 0xff
                val g = (pixel shr 8) and 0xff
                val b = pixel and 0xff
                val yValue = ((66 * r + 129 * g + 25 * b + 128) shr 8) + 16
                putByte(dataY, y * strideY + x, yValue)
            }
        }

        for (y in 0 until height step 2) {
            for (x in 0 until width step 2) {
                var rSum = 0
                var gSum = 0
                var bSum = 0
                var count = 0
                for (dy in 0..1) {
                    for (dx in 0..1) {
                        val sampleX = x + dx
                        val sampleY = y + dy
                        if (sampleX >= width || sampleY >= height) {
                            continue
                        }
                        val pixel = pixels[sampleY * width + sampleX]
                        rSum += (pixel shr 16) and 0xff
                        gSum += (pixel shr 8) and 0xff
                        bSum += pixel and 0xff
                        count += 1
                    }
                }
                val r = rSum / count
                val g = gSum / count
                val b = bSum / count
                val uValue = ((-38 * r - 74 * g + 112 * b + 128) shr 8) + 128
                val vValue = ((112 * r - 94 * g - 18 * b + 128) shr 8) + 128
                val chromaIndex = (y / 2) * strideU + (x / 2)
                putByte(dataU, chromaIndex, uValue)
                putByte(dataV, (y / 2) * strideV + (x / 2), vValue)
            }
        }
        return buffer
    }

    private fun putByte(buffer: ByteBuffer, index: Int, value: Int) {
        buffer.put(index, value.coerceIn(0, 255).toByte())
    }

    private fun imageCrop(): NormalizedCrop {
        val cropSize = imageCropSize()
        val cropWidth = cropSize.width
        val cropHeight = cropSize.height
        val maxCropX = 1f - cropWidth
        val maxCropY = 1f - cropHeight
        return NormalizedCrop(
            x = (maxCropX / 2f + imagePanX).coerceIn(0f, maxCropX),
            y = (maxCropY / 2f + imagePanY).coerceIn(0f, maxCropY),
            width = cropWidth,
            height = cropHeight
        )
    }

    private fun panImageBy(deltaXNormalized: Float, deltaYNormalized: Float): Boolean {
        if (imageBitmap == null) {
            return false
        }
        val cropSize = imageCropSize()
        if (cropSize.width >= 0.999f && cropSize.height >= 0.999f) {
            return false
        }
        val previousPanX = imagePanX
        val previousPanY = imagePanY
        imagePanX -= deltaXNormalized * cropSize.width
        imagePanY -= deltaYNormalized * cropSize.height
        coerceImagePan()
        if (abs(previousPanX - imagePanX) < PAN_EPSILON &&
            abs(previousPanY - imagePanY) < PAN_EPSILON
        ) {
            return false
        }
        runOnCameraThread {
            repeatImageFrameIfNeeded()
        }
        return true
    }

    private fun maxImageZoom(): Float =
        MAX_IMAGE_ZOOM

    private fun coerceImagePan() {
        val cropSize = imageCropSize()
        val maxPanX = ((1f - cropSize.width) / 2f).coerceAtLeast(0f)
        val maxPanY = ((1f - cropSize.height) / 2f).coerceAtLeast(0f)
        imagePanX = imagePanX.coerceIn(-maxPanX, maxPanX)
        imagePanY = imagePanY.coerceIn(-maxPanY, maxPanY)
    }

    private fun resetImagePan() {
        imagePanX = 0f
        imagePanY = 0f
    }

    private fun clearImageProjectionInternal() {
        imageFrameGeneration += 1
        imageBitmap?.recycle()
        imageBitmap = null
        imageZoomRatio = 1f
        resetImagePan()
    }

    private fun updateImageFrameSizeForRotation(): Boolean {
        val bitmap = imageBitmap ?: return false
        val size = imageOutputFrameSize()
        val changed = imageFrameWidth != size.width || imageFrameHeight != size.height
        imageFrameWidth = size.width
        imageFrameHeight = size.height
        imageZoomRatio = imageZoomRatio.coerceIn(1f, maxImageZoom())
        coerceImagePan()
        return changed
    }

    private fun imageOutputFrameSize(): Size =
        if (deviceRotationDegrees.isLandscapeRotation()) {
            Size(MAX_IMAGE_FRAME_EDGE, IMAGE_FRAME_SHORT_EDGE)
        } else {
            Size(IMAGE_FRAME_SHORT_EDGE, MAX_IMAGE_FRAME_EDGE)
        }

    private fun imageCropSize(
        bitmap: Bitmap? = imageBitmap,
        zoomRatio: Float = imageZoomRatio
    ): NormalizedCrop {
        val sourceBitmap = bitmap ?: return NormalizedCrop(0f, 0f, 1f, 1f)
        val outputAspect = imageFrameWidth.toFloat() / imageFrameHeight.toFloat()
        val sourceAspect = sourceBitmap.width.toFloat() / sourceBitmap.height.toFloat()
        var cropWidth = 1f
        var cropHeight = 1f
        if (sourceAspect > outputAspect) {
            cropWidth = (outputAspect / sourceAspect).coerceIn(0.001f, 1f)
        } else if (sourceAspect < outputAspect) {
            cropHeight = (sourceAspect / outputAspect).coerceIn(0.001f, 1f)
        }
        val zoom = zoomRatio.coerceAtLeast(1f)
        return NormalizedCrop(
            x = 0f,
            y = 0f,
            width = (cropWidth / zoom).coerceIn(0.001f, 1f),
            height = (cropHeight / zoom).coerceIn(0.001f, 1f)
        )
    }

    private fun Int.isLandscapeRotation(): Boolean =
        this == 90 || this == 270

    private fun clearLockedFrame() {
        lockedFrame?.release()
        lockedFrame = null
    }

    private fun frameOrientation(camera: CameraInfo): Int {
        val deviceOrientation = if (camera.isFrontCamera) {
            deviceRotationDegrees
        } else {
            (360 - deviceRotationDegrees) % 360
        }
        return (camera.sensorOrientation + deviceOrientation) % 360
    }

    private fun runOnCameraThread(block: () -> Unit) {
        val handler = surfaceTextureHelper?.handler
        if (handler == null) {
            block()
        } else {
            handler.post(block)
        }
    }

    private fun runOnCameraThreadBlocking(atFront: Boolean = false, block: () -> Unit) {
        val handler = surfaceTextureHelper?.handler
        if (handler == null || handler.looper.thread == Thread.currentThread()) {
            block()
            return
        }

        val latch = CountDownLatch(1)
        val runnable = Runnable {
            block()
            latch.countDown()
        }
        if (atFront) {
            handler.postAtFrontOfQueue(runnable)
        } else {
            handler.post(runnable)
        }
        latch.await(2, TimeUnit.SECONDS)
    }

    private fun notifyCameraChanged() {
        val camera = currentCameraOrNull() ?: return
        onCameraChanged(camera.isFrontCamera, camera.label, camera.supportsTorch, torchEnabled)
    }

    private fun currentCameraOrNull(): CameraInfo? = cameras.getOrNull(currentCameraIndex)

    private fun preferredCameraIndex(useFrontCamera: Boolean): Int {
        val preferred = cameras.indexOfFirst { it.isFrontCamera == useFrontCamera }
        if (preferred >= 0) {
            return preferred
        }
        return 0
    }

    private fun loadCameras(): List<CameraInfo> {
        return cameraManager.cameraIdList.mapNotNull { id ->
            val characteristics = cameraManager.getCameraCharacteristics(id)
            val facing = characteristics.get(CameraCharacteristics.LENS_FACING) ?: return@mapNotNull null
            val isFrontCamera = facing == CameraCharacteristics.LENS_FACING_FRONT
            val isBackCamera = facing == CameraCharacteristics.LENS_FACING_BACK
            if (!isFrontCamera && !isBackCamera) {
                return@mapNotNull null
            }

            val maxZoom = characteristics
                .get(CameraCharacteristics.SCALER_AVAILABLE_MAX_DIGITAL_ZOOM)
                ?.coerceAtLeast(1f) ?: 1f
            val activeArray = characteristics.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE)
            val afModes = characteristics.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES)
                ?: intArrayOf()
            val maxAfRegions = characteristics.get(CameraCharacteristics.CONTROL_MAX_REGIONS_AF) ?: 0
            val maxAeRegions = characteristics.get(CameraCharacteristics.CONTROL_MAX_REGIONS_AE) ?: 0
            val sensorOrientation = characteristics.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 0
            val supportsTorch = characteristics.get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
            val focalLengths = characteristics.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)
                ?: floatArrayOf()
            val outputSizes = characteristics
                .get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
                ?.getOutputSizes(SurfaceTexture::class.java)
                ?.toList()
                .orEmpty()

            CameraInfo(
                id = id,
                isFrontCamera = isFrontCamera,
                label = cameraLabel(isFrontCamera, id, focalLengths),
                maxZoom = maxZoom,
                activeArray = activeArray,
                afModes = afModes,
                maxAfRegions = maxAfRegions,
                maxAeRegions = maxAeRegions,
                outputSizes = outputSizes,
                sensorOrientation = sensorOrientation,
                supportsTorch = supportsTorch
            )
        }.ifEmpty {
            emptyList()
        }
    }

    private fun cameraLabel(isFrontCamera: Boolean, id: String, focalLengths: FloatArray): String {
        val facing = if (isFrontCamera) "前置镜头" else "后置镜头"
        val focal = focalLengths.minOrNull()
        val lensHint = when {
            isFrontCamera -> ""
            focal == null -> ""
            focal <= 2.2f -> " · 广角"
            focal >= 6.0f -> " · 长焦/微距"
            else -> ""
        }
        return "$facing $id$lensHint"
    }

    private fun chooseOutputSize(camera: CameraInfo?): Size {
        val sizes = camera?.outputSizes.orEmpty()
        if (sizes.isEmpty()) {
            return Size(captureWidth, captureHeight)
        }

        val targetAspect = camera?.nativeAspectSize ?: Size(captureWidth, captureHeight)
        val maxPixels = captureWidth.toLong() * captureHeight.toLong()
        val aspectMatched = sizes.filter {
            aspectError(it, targetAspect) <= NATIVE_ASPECT_TOLERANCE
        }
        val candidates = aspectMatched.ifEmpty { sizes }
        val withinBudget = candidates.filter { it.pixelCount() <= maxPixels }

        return withinBudget
            .minWithOrNull(compareByDescending<Size> { it.pixelCount() }.thenBy { aspectError(it, targetAspect) })
            ?: candidates.minWithOrNull(
                compareBy<Size> { it.pixelCount() }
                    .thenBy { aspectError(it, targetAspect) }
            )
            ?: Size(captureWidth, captureHeight)
    }

    private fun aspectError(size: Size, target: Size): Double {
        val sizeRatio = size.width.toDouble() / size.height.toDouble()
        val targetRatio = target.width.toDouble() / target.height.toDouble()
        return abs(sizeRatio - targetRatio) / targetRatio
    }

    private fun Size.pixelCount(): Long =
        width.toLong() * height.toLong()

    private data class CameraInfo(
        val id: String,
        val isFrontCamera: Boolean,
        val label: String,
        val maxZoom: Float,
        val activeArray: Rect?,
        val afModes: IntArray,
        val maxAfRegions: Int,
        val maxAeRegions: Int,
        val outputSizes: List<Size>,
        val sensorOrientation: Int,
        val supportsTorch: Boolean,
        val nativeAspectSize: Size? = activeArray?.let { Size(it.width(), it.height()) },
        val supportsFocus: Boolean =
            maxAfRegions > 0 &&
                afModes.any {
                    it == CaptureRequest.CONTROL_AF_MODE_AUTO ||
                        it == CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO
                }
    )

    private data class NormalizedCrop(
        val x: Float,
        val y: Float,
        val width: Float,
        val height: Float
    )

    private companion object {
        private const val NATIVE_ASPECT_TOLERANCE = 0.025
        private const val PAN_EPSILON = 0.0005f
        private const val MAX_IMAGE_FRAME_EDGE = 1920
        private const val IMAGE_FRAME_SHORT_EDGE = 1080
        private const val MAX_IMAGE_ZOOM = 8f
        private val IMAGE_PAINT = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
        private val FULL_FRAME_PRESENTATION = LockedFramePresentation(
            zoomRatio = 1f,
            cropX = 0f,
            cropY = 0f,
            cropWidth = 1f,
            cropHeight = 1f
        )
    }
}
