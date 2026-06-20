package cn.edu.nb3.myclass

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Matrix
import android.graphics.Rect
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
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoFrame
import org.webrtc.VideoCapturer
import org.webrtc.VideoSink
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

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
    private var deviceRotationDegrees = 0
    private var torchEnabled = false
    private var focusRegion: MeteringRectangle? = null
    @Volatile
    private var frameLocked = false

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
            zoomRatio = 1f
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
            torchEnabled = false
            focusRegion = null
            frameLocked = false
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
        frameLocked = locked
        return true
    }

    fun isFrameLocked(): Boolean = frameLocked

    fun isTorchEnabled(): Boolean = torchEnabled

    fun isTorchSupported(): Boolean = currentCameraOrNull()?.supportsTorch == true

    fun zoomBy(scaleFactor: Float): Float {
        val camera = currentCameraOrNull() ?: return zoomRatio
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
        runOnCameraThread {
            deviceRotationDegrees = rotationDegrees
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
        if (frameLocked) {
            return
        }

        val camera = currentCameraOrNull()
        val textureBuffer = frame.buffer as? VideoFrame.TextureBuffer
        if (camera == null || textureBuffer == null) {
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
        capturerObserver?.onFrameCaptured(cameraFrame)
        cameraFrame.release()
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

    private companion object {
        private const val NATIVE_ASPECT_TOLERANCE = 0.025
    }
}
