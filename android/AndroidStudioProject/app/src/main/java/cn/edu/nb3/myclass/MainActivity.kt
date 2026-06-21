package cn.edu.nb3.myclass

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Bundle
import android.text.TextUtils
import android.text.InputFilter
import android.text.InputType
import android.util.AttributeSet
import android.view.Gravity
import android.view.MotionEvent
import android.view.OrientationEventListener
import android.view.ScaleGestureDetector
import android.view.Surface
import android.view.View
import android.view.ViewGroup
import android.view.ViewConfiguration
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.google.android.material.button.MaterialButton
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout
import org.webrtc.SurfaceViewRenderer

class MainActivity : AppCompatActivity(), SignalingClient.Callback {
    private enum class Screen {
        Connect,
        Menu,
        Camera,
        ScreenShare
    }

    private enum class PresentationMode {
        Camera,
        ScreenShare
    }

    private var currentScreen = Screen.Connect
    private var signalingClient: SignalingClient? = null
    private var webRtcClient: CameraWebRtcClient? = null
    private var cameraRenderer: SurfaceViewRenderer? = null
    private var statusText: TextView? = null
    private var startLiveButton: MaterialButton? = null
    private var stopLiveButton: MaterialButton? = null
    private var switchCameraButton: MaterialButton? = null
    private var frameLockButton: MaterialButton? = null
    private var torchButton: MaterialButton? = null
    private var imageCastButton: MaterialButton? = null
    private var cameraControls: LinearLayout? = null
    private var cameraVersionLabel: TextView? = null
    private var orientationListener: OrientationEventListener? = null
    private var rawDeviceRotationDegrees = 0
    private var isUsingFrontCamera = false
    private var activePresentationMode = PresentationMode.Camera
    private var currentDeviceOrientation = createDeviceOrientationPayload(0)
    private var lastSentDeviceOrientation: DeviceOrientationPayload? = null
    private var activeRoomCode: String? = null
    private var roomJoined = false
    private var cameraPausedForBackground = false
    private var restartLiveOnResume = false
    private var resumeCameraAfterJoin = false
    private var resumeLiveAfterJoin = false
    private var isPickingImageForProjection = false
    private var openImagePickerAfterPermission = false

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { result ->
        if (result.values.all { it }) {
            val shouldOpenImagePicker = openImagePickerAfterPermission
            openImagePickerAfterPermission = false
            showCameraScreen(openImagePicker = shouldOpenImagePicker)
        } else {
            openImagePickerAfterPermission = false
            toast("需要摄像头权限才能直播")
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        rawDeviceRotationDegrees = displayRotationDegrees()
        currentDeviceOrientation = createDeviceOrientationPayload(rawDeviceRotationDegrees)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        onBackPressedDispatcher.addCallback(this, backCallback)
        showConnectScreen()
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        cameraRenderer?.requestLayout()
        updateCameraControlsLayout()
        syncDeviceRotationFromDisplay(force = true)
        refreshLockedFramePreviewAfterLayout()
    }

    override fun onResume() {
        super.onResume()
        if (currentScreen == Screen.Camera && cameraPausedForBackground) {
            val shouldRestartLive = restartLiveOnResume
            val roomCode = activeRoomCode
            cameraPausedForBackground = false
            restartLiveOnResume = false
            if (roomCode == null) {
                toast("请重新输入连接码")
                showConnectScreen()
                return
            }
            showCameraScreen()
            updateStatus("正在重新连接教室端...")
            connectToRoom(
                code = roomCode,
                resumeCameraAfterJoin = true,
                resumeLiveAfterJoin = shouldRestartLive
            )
        }
    }

    private val imagePickerLauncher = registerForActivityResult(
        ActivityResultContracts.GetContent()
    ) { uri: Uri? ->
        isPickingImageForProjection = false
        uri ?: return@registerForActivityResult
        showSelectedImage(uri)
    }

    private val screenCaptureLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val data = result.data
        if (result.resultCode == Activity.RESULT_OK && data != null) {
            startScreenShare(data)
        } else {
            toast("已取消屏幕共享")
        }
    }

    override fun onPause() {
        if (isPickingImageForProjection) {
            super.onPause()
            return
        }
        if (currentScreen == Screen.Camera && !isFinishing) {
            cameraPausedForBackground = true
            restartLiveOnResume = webRtcClient?.isLive() == true
            if (restartLiveOnResume) {
                signalingClient?.sendStop()
            }
            releaseCamera()
            roomJoined = false
            signalingClient?.close()
            signalingClient = null
        }
        super.onPause()
    }

    override fun onDestroy() {
        orientationListener?.disable()
        releaseCamera()
        signalingClient?.close()
        super.onDestroy()
    }

    private val backCallback = object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
            when (currentScreen) {
                Screen.Camera -> {
                    returnToMenuFromCamera()
                }
                Screen.ScreenShare -> {
                    stopScreenShareAndReturnMenu()
                }
                Screen.Menu -> {
                    signalingClient?.close()
                    signalingClient = null
                    activeRoomCode = null
                    roomJoined = false
                    showConnectScreen()
                }
                Screen.Connect -> {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        }
    }

    private fun showConnectScreen() {
        currentScreen = Screen.Connect
        val root = baseColumn().apply {
            setPadding(dp(28), dp(32), dp(28), dp(32))
        }

        val title = titleText(getString(R.string.platform_title), 22f)
        val inputLayout = TextInputLayout(this).apply {
            hint = "连接码"
            boxBackgroundMode = TextInputLayout.BOX_BACKGROUND_OUTLINE
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                topMargin = dp(36)
            }
        }
        val codeInput = TextInputEditText(inputLayout.context).apply {
            inputType = InputType.TYPE_CLASS_NUMBER
            filters = arrayOf(InputFilter.LengthFilter(4))
            gravity = Gravity.CENTER
            textSize = 28f
            setSingleLine(true)
        }
        inputLayout.addView(codeInput)

        val connectButton = primaryButton("连接").apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(56)
            ).apply {
                topMargin = dp(20)
            }
            setOnClickListener {
                val code = codeInput.text?.toString()?.trim().orEmpty()
                if (!Regex("^\\d{4}$").matches(code)) {
                    inputLayout.error = "请输入 4 位数字连接码"
                    return@setOnClickListener
                }
                inputLayout.error = null
                isEnabled = false
                text = "连接中..."
                connectToRoom(code)
            }
        }

        statusText = bodyText("请输入教室大屏上的 4 位连接码").apply {
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                topMargin = dp(18)
            }
        }

        root.addView(title)
        root.addView(inputLayout)
        root.addView(connectButton)
        root.addView(statusText)
        root.addView(versionLabel())
        setContentView(root)
    }

    private fun showMenuScreen() {
        currentScreen = Screen.Menu
        val root = baseColumn().apply {
            setPadding(dp(28), dp(32), dp(28), dp(32))
        }

        root.addView(titleText("功能菜单", 28f))
        root.addView(primaryButton("摄像头直播").apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(58)
            ).apply {
                topMargin = dp(34)
            }
            setOnClickListener {
                ensureCameraPermissions()
            }
        })
        root.addView(secondaryButton("图片投屏").apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(58)
            ).apply {
                topMargin = dp(16)
            }
            setOnClickListener {
                ensureCameraPermissions(openImagePicker = true)
            }
        })
        root.addView(secondaryButton("共享屏幕").apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(58)
            ).apply {
                topMargin = dp(16)
            }
            setOnClickListener {
                requestScreenSharePermission()
            }
        })
        statusText = bodyText("已连接课堂").apply {
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                topMargin = dp(24)
            }
        }
        root.addView(statusText)
        root.addView(versionLabel())
        setContentView(root)
    }

    private fun requestScreenSharePermission() {
        val manager = getSystemService(MediaProjectionManager::class.java)
        screenCaptureLauncher.launch(manager.createScreenCaptureIntent())
    }

    private fun startScreenShare(permissionData: Intent) {
        updateStatus("正在启动屏幕共享服务...")
        ScreenProjectionService.start(this) {
            runOnUiThread {
                if (currentScreen == Screen.Menu && !isFinishing) {
                    showScreenShareScreen(permissionData)
                } else {
                    ScreenProjectionService.stop(this)
                }
            }
        }
    }

    private fun showScreenShareScreen(permissionData: Intent) {
        currentScreen = Screen.ScreenShare
        activePresentationMode = PresentationMode.ScreenShare
        val root = baseColumn().apply {
            setPadding(dp(28), dp(32), dp(28), dp(32))
        }

        root.addView(titleText("共享屏幕", 28f))
        statusText = bodyText("正在准备屏幕共享...").apply {
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                topMargin = dp(24)
            }
        }
        root.addView(statusText)
        root.addView(primaryButton("停止共享并返回菜单").apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(58)
            ).apply {
                topMargin = dp(32)
            }
            setOnClickListener {
                stopScreenShareAndReturnMenu()
            }
        })
        root.addView(versionLabel())
        setContentView(root)
        startOrientationTracking()

        runCatching {
            webRtcClient = CameraWebRtcClient(
                context = this,
                renderer = null,
                sendOffer = { signalingClient?.sendOffer(it) },
                sendIceCandidate = { signalingClient?.sendIceCandidate(it) },
                updateStatus = { updateStatus(it) },
                captureMode = WebRtcCaptureMode.Screen,
                screenCaptureData = permissionData
            )
            webRtcClient?.startPreview()
            sendCurrentDeviceOrientation(force = true)
            startScreenShareLive()
        }.onFailure {
            ScreenProjectionService.stop(this)
            activePresentationMode = PresentationMode.Camera
            updateStatus(it.message ?: "屏幕共享启动失败")
            toast(it.message ?: "屏幕共享启动失败")
            showMenuScreen()
        }
    }

    private fun startScreenShareLive() {
        if (!roomJoined) {
            updateStatus("正在重新连接教室端...")
            toast("正在重新连接教室端")
            return
        }

        runCatching {
            sendCurrentDeviceOrientation(force = true)
            webRtcClient?.startLive()
            sendCurrentDeviceOrientation(force = true)
            updateStatus("屏幕共享中")
        }.onFailure {
            updateStatus(it.message ?: "屏幕共享启动失败")
            toast(it.message ?: "屏幕共享启动失败")
        }
    }

    private fun stopScreenShareAndReturnMenu() {
        if (webRtcClient?.isLive() == true) {
            signalingClient?.sendStop()
        }
        releaseCamera()
        showMenuScreen()
    }

    private fun showCameraScreen(
        autoStartLive: Boolean = false,
        openImagePicker: Boolean = false
    ) {
        currentScreen = Screen.Camera
        activePresentationMode = PresentationMode.Camera
        val root = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
        }

        val renderer = SurfaceViewRenderer(this)
        attachCameraGestures(renderer)
        cameraRenderer = renderer
        root.addView(
            renderer,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        )

        statusText = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 15f
            text = "正在启动摄像头预览..."
            setShadowLayer(8f, 0f, 2f, Color.BLACK)
            gravity = Gravity.CENTER
        }
        root.addView(
            statusText,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.TOP
            ).apply {
                setMargins(dp(16), dp(24), dp(16), 0)
            }
        )

        val controls = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(18))
            setBackgroundColor(Color.argb(140, 0, 0, 0))
        }
        cameraControls = controls

        startLiveButton = cameraPrimaryButton("开始直播").apply {
            isEnabled = roomJoined
            setOnClickListener {
                startLiveFromUi()
            }
        }
        stopLiveButton = cameraSecondaryButton("返回菜单").apply {
            setOnClickListener {
                if (webRtcClient?.isLive() == true) {
                    webRtcClient?.stopLive()
                    signalingClient?.sendStop()
                    updateLiveControlButtons(isLive = false)
                } else {
                    returnToMenuFromCamera()
                }
            }
        }
        switchCameraButton = cameraSecondaryButton("切换镜头").apply {
            setOnClickListener {
                webRtcClient?.setFrameLocked(false)
                updateFrameLockButton(isLocked = false, isEnabled = true)
                webRtcClient?.switchCamera()
                updateImageCastButton(isProjecting = false)
            }
        }
        frameLockButton = cameraSecondaryButton("锁定画面").apply {
            isEnabled = false
            setOnClickListener {
                val nextLocked = webRtcClient?.isFrameLocked() != true
                val applied = webRtcClient?.setFrameLocked(nextLocked) == true
                if (applied) {
                    updateFrameLockButton(isLocked = nextLocked, isEnabled = true)
                    sendCurrentDeviceOrientation(force = true)
                    toast(if (nextLocked) "画面已锁定" else "画面已恢复实时")
                }
            }
        }
        torchButton = cameraSecondaryButton("补光灯").apply {
            isEnabled = false
            setOnClickListener {
                val nextEnabled = webRtcClient?.isTorchEnabled() != true
                val enabled = webRtcClient?.setTorchEnabled(nextEnabled) == true
                updateTorchButton(
                    supportsTorch = webRtcClient?.isTorchSupported() == true,
                    torchEnabled = enabled
                )
            }
        }
        imageCastButton = cameraSecondaryButton("图片投屏").apply {
            isEnabled = true
            setOnClickListener {
                if (webRtcClient?.isImageProjectionActive() == true) {
                    updateImageCastButton(isProjecting = false)
                    webRtcClient?.clearImageProjection()
                    sendCurrentDeviceOrientation(force = true)
                    return@setOnClickListener
                }
                launchImagePickerForProjection()
            }
        }
        cameraVersionLabel = versionLabel(onDark = true)
        updateCameraControlsLayout()
        root.addView(
            controls,
            controls.layoutParams ?: cameraControlsLayoutParams(isLandscape = false)
        )

        setContentView(root)
        startOrientationTracking()

        runCatching {
            webRtcClient = CameraWebRtcClient(
                context = this,
                renderer = renderer,
                sendOffer = { signalingClient?.sendOffer(it) },
                sendIceCandidate = { signalingClient?.sendIceCandidate(it) },
                updateStatus = { updateStatus(it) },
                initialUseFrontCamera = isUsingFrontCamera,
                onCameraFacingChanged = { isFrontCamera, label, supportsTorch, torchEnabled ->
                    isUsingFrontCamera = isFrontCamera
                    currentDeviceOrientation = createDeviceOrientationPayload(rawDeviceRotationDegrees)
                    sendCurrentDeviceOrientation(force = true)
                    updateTorchButton(supportsTorch, torchEnabled)
                    updateStatus("已切换到$label")
                }
            )
            webRtcClient?.startPreview()
            webRtcClient?.setDeviceRotation(rawDeviceRotationDegrees)
            updateFrameLockButton(isLocked = false, isEnabled = true)
            updateImageCastButton(isProjecting = false)
            updateLiveControlButtons(isLive = false)
            if (autoStartLive) {
                startLiveFromUi()
            }
            if (openImagePicker) {
                renderer.post {
                    launchImagePickerForProjection()
                }
            }
        }.onFailure {
            updateStatus(it.message ?: "摄像头启动失败")
            toast("摄像头启动失败")
        }
    }

    private fun connectToRoom(
        code: String,
        resumeCameraAfterJoin: Boolean = false,
        resumeLiveAfterJoin: Boolean = false
    ) {
        activeRoomCode = code
        roomJoined = false
        this.resumeCameraAfterJoin = resumeCameraAfterJoin
        this.resumeLiveAfterJoin = resumeLiveAfterJoin
        startLiveButton?.isEnabled = false
        signalingClient?.close()
        signalingClient = SignalingClient(
            serverBaseUrl = BuildConfig.SERVER_BASE_URL,
            roomCode = code,
            callback = this
        ).also { it.connect() }
    }

    private fun ensureCameraPermissions(openImagePicker: Boolean = false) {
        openImagePickerAfterPermission = openImagePicker
        val permissions = arrayOf(
            Manifest.permission.CAMERA
        )
        val allGranted = permissions.all {
            ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
        }
        if (allGranted) {
            val shouldOpenImagePicker = openImagePickerAfterPermission
            openImagePickerAfterPermission = false
            showCameraScreen(openImagePicker = shouldOpenImagePicker)
        } else {
            permissionLauncher.launch(permissions)
        }
    }

    override fun onJoinAccepted() {
        runOnUiThread {
            roomJoined = true
            val shouldResumeCamera = resumeCameraAfterJoin
            val shouldResumeLive = resumeLiveAfterJoin
            resumeCameraAfterJoin = false
            resumeLiveAfterJoin = false
            toast("连接成功")

            if (shouldResumeCamera || currentScreen == Screen.Camera) {
                if (currentScreen != Screen.Camera || webRtcClient == null) {
                    showCameraScreen(autoStartLive = shouldResumeLive)
                } else {
                    updateStatus("教室端已重新连接")
                    updateLiveControlButtons(isLive = webRtcClient?.isLive() == true)
                    sendCurrentDeviceOrientation(force = true)
                    if (shouldResumeLive) {
                        startLiveFromUi()
                    }
                }
            } else {
                showMenuScreen()
            }
        }
    }

    override fun onJoinRejected(message: String) {
        runOnUiThread {
            activeRoomCode = null
            roomJoined = false
            resumeCameraAfterJoin = false
            resumeLiveAfterJoin = false
            toast(message)
            signalingClient?.close()
            signalingClient = null
            showConnectScreen()
        }
    }

    override fun onKicked(message: String) {
        runOnUiThread {
            releaseCamera()
            signalingClient?.close()
            signalingClient = null
            activeRoomCode = null
            roomJoined = false
            toast(message)
            showConnectScreen()
        }
    }

    override fun onServerClosed(message: String) {
        runOnUiThread {
            releaseCamera()
            signalingClient?.close()
            signalingClient = null
            activeRoomCode = null
            roomJoined = false
            toast(message)
            showConnectScreen()
        }
    }

    override fun onAnswer(sdp: String) {
        webRtcClient?.handleAnswer(sdp)
    }

    override fun onRemoteIceCandidate(candidate: IceCandidatePayload) {
        webRtcClient?.addRemoteIceCandidate(candidate)
    }

    override fun onSignalError(message: String) {
        runOnUiThread {
            roomJoined = false
            updateLiveControlButtons(isLive = webRtcClient?.isLive() == true)
            updateStatus(message)
            toast(message)
            if (currentScreen == Screen.Connect) {
                signalingClient?.close()
                signalingClient = null
                showConnectScreen()
            }
        }
    }

    private fun releaseCamera() {
        stopOrientationTracking()
        ScreenProjectionService.stop(this)
        webRtcClient?.release()
        webRtcClient = null
        cameraRenderer?.release()
        cameraRenderer = null
        startLiveButton = null
        stopLiveButton = null
        switchCameraButton = null
        frameLockButton = null
        torchButton = null
        imageCastButton = null
        cameraControls = null
        cameraVersionLabel = null
        activePresentationMode = PresentationMode.Camera
    }

    private fun returnToMenuFromCamera() {
        releaseCamera()
        showMenuScreen()
    }

    private fun updateStatus(message: String) {
        runOnUiThread {
            statusText?.text = message
        }
    }

    private fun startLiveFromUi() {
        if (!roomJoined) {
            updateStatus("正在重新连接教室端...")
            toast("正在重新连接教室端")
            updateLiveControlButtons(isLive = false)
            return
        }

        updateLiveControlButtons(isLive = true)
        runCatching {
            sendCurrentDeviceOrientation(force = true)
            webRtcClient?.startLive()
            sendCurrentDeviceOrientation(force = true)
        }.onFailure {
            updateLiveControlButtons(isLive = false)
            val message = it.message ?: "直播启动失败"
            updateStatus(message)
            toast(message)
        }
    }

    private fun updateLiveControlButtons(isLive: Boolean) {
        startLiveButton?.isEnabled = roomJoined && !isLive
        stopLiveButton?.isEnabled = true
        setCameraButtonText(stopLiveButton, if (isLive) "停止直播" else "返回菜单")
    }

    private fun updateTorchButton(supportsTorch: Boolean, torchEnabled: Boolean) {
        runOnUiThread {
            torchButton?.isEnabled = supportsTorch
            setCameraButtonText(torchButton, when {
                !supportsTorch -> "无补光灯"
                torchEnabled -> "关闭补光灯"
                else -> "开补光灯"
            })
        }
    }

    private fun updateFrameLockButton(
        isLocked: Boolean,
        isEnabled: Boolean = frameLockButton?.isEnabled == true
    ) {
        frameLockButton?.isEnabled = isEnabled
        setCameraButtonText(frameLockButton, if (isLocked) "解除锁定" else "锁定画面")
    }

    private fun launchImagePickerForProjection() {
        isPickingImageForProjection = true
        runCatching {
            imagePickerLauncher.launch("image/*")
        }.onFailure {
            isPickingImageForProjection = false
            toast("无法打开相册")
        }
    }

    private fun updateImageCastButton(isProjecting: Boolean) {
        setCameraButtonText(imageCastButton, if (isProjecting) "恢复摄像头" else "图片投屏")
    }

    private fun showSelectedImage(uri: Uri) {
        runCatching {
            webRtcClient?.setFrameLocked(false)
            updateFrameLockButton(isLocked = false, isEnabled = true)
            webRtcClient?.showImage(uri)
        }.onSuccess {
            updateImageCastButton(isProjecting = true)
            sendCurrentDeviceOrientation(force = true)
        }.onFailure {
            updateStatus(it.message ?: "图片投屏失败")
            toast(it.message ?: "图片投屏失败")
        }
    }

    private fun updateCameraControlsLayout() {
        val controls = cameraControls ?: return
        val startButton = startLiveButton ?: return
        val stopButton = stopLiveButton ?: return
        val switchButton = switchCameraButton ?: return
        val lockButton = frameLockButton ?: return
        val lightButton = torchButton ?: return
        val imageButton = imageCastButton ?: return
        val version = cameraVersionLabel ?: return
        val isLandscape = resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE

        listOf(startButton, stopButton, switchButton, lockButton, lightButton, imageButton, version).forEach { view ->
            (view.parent as? ViewGroup)?.removeView(view)
        }
        controls.removeAllViews()
        controls.layoutParams = cameraControlsLayoutParams(isLandscape)
        controls.orientation = LinearLayout.VERTICAL
        controls.gravity = Gravity.CENTER
        controls.setPadding(
            if (isLandscape) dp(8) else dp(16),
            if (isLandscape) dp(8) else dp(16),
            if (isLandscape) dp(8) else dp(16),
            if (isLandscape) dp(8) else dp(18)
        )

        if (isLandscape) {
            listOf(startButton, stopButton, switchButton, lockButton, lightButton, imageButton).forEach { button ->
                setCameraButtonTextRotation(button, 0f)
                button.ellipsize = TextUtils.TruncateAt.END
                button.maxLines = 2
                button.layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    0,
                    1f
                ).apply {
                    topMargin = dp(4)
                    bottomMargin = dp(4)
                }
                controls.addView(button)
            }
            version.visibility = View.GONE
            return
        }

        listOf(startButton, stopButton, switchButton, lockButton, lightButton, imageButton).forEach { button ->
            setCameraButtonTextRotation(button, 0f)
            button.ellipsize = TextUtils.TruncateAt.END
            button.maxLines = 1
        }

        val liveRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
        }
        startButton.layoutParams = LinearLayout.LayoutParams(0, dp(52), 1f).apply {
            marginEnd = dp(8)
        }
        stopButton.layoutParams = LinearLayout.LayoutParams(0, dp(52), 1f).apply {
            marginStart = dp(8)
        }
        liveRow.addView(startButton)
        liveRow.addView(stopButton)

        val toolsRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                topMargin = dp(12)
            }
        }
        switchButton.layoutParams = LinearLayout.LayoutParams(0, dp(52), 1f).apply {
            marginEnd = dp(6)
        }
        lockButton.layoutParams = LinearLayout.LayoutParams(0, dp(52), 1f).apply {
            marginStart = dp(6)
            marginEnd = dp(6)
        }
        lightButton.layoutParams = LinearLayout.LayoutParams(0, dp(52), 1f).apply {
            marginStart = dp(6)
            marginEnd = dp(6)
        }
        imageButton.layoutParams = LinearLayout.LayoutParams(0, dp(52), 1f).apply {
            marginStart = dp(6)
        }
        toolsRow.addView(switchButton)
        toolsRow.addView(lockButton)
        toolsRow.addView(lightButton)
        toolsRow.addView(imageButton)

        version.visibility = View.VISIBLE
        controls.addView(liveRow)
        controls.addView(toolsRow)
        controls.addView(version)
    }

    private fun cameraControlsLayoutParams(isLandscape: Boolean): FrameLayout.LayoutParams =
        if (isLandscape) {
            FrameLayout.LayoutParams(dp(86), ViewGroup.LayoutParams.MATCH_PARENT, Gravity.END)
        } else {
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM
            )
        }

    private fun startOrientationTracking() {
        if (orientationListener == null) {
            orientationListener = object : OrientationEventListener(this@MainActivity) {
                override fun onOrientationChanged(orientation: Int) {
                    if (orientation != OrientationEventListener.ORIENTATION_UNKNOWN) {
                        syncDeviceRotationFromDisplay()
                    }
                }
            }
        }

        lastSentDeviceOrientation = null
        orientationListener?.let {
            if (it.canDetectOrientation()) {
                it.enable()
            }
        }
        syncDeviceRotationFromDisplay(force = true)
    }

    private fun stopOrientationTracking() {
        orientationListener?.disable()
        lastSentDeviceOrientation = null
    }

    private fun sendCurrentDeviceOrientation(force: Boolean = false) {
        currentDeviceOrientation = createDeviceOrientationPayload(rawDeviceRotationDegrees)
        if (!force && currentDeviceOrientation == lastSentDeviceOrientation) {
            return
        }
        signalingClient?.sendOrientation(currentDeviceOrientation)
        lastSentDeviceOrientation = currentDeviceOrientation
    }

    private fun syncDeviceRotationFromDisplay(force: Boolean = false) {
        val nextRotationDegrees = displayRotationDegrees()
        if (!force && nextRotationDegrees == rawDeviceRotationDegrees) {
            return
        }
        rawDeviceRotationDegrees = nextRotationDegrees
        webRtcClient?.setDeviceRotation(nextRotationDegrees)
        currentDeviceOrientation = createDeviceOrientationPayload(nextRotationDegrees)
        sendCurrentDeviceOrientation(force = force)
    }

    private fun refreshLockedFramePreviewAfterLayout() {
        val renderer = cameraRenderer ?: return
        renderer.post {
            webRtcClient?.refreshLockedFramePreview()
            renderer.postDelayed(
                { webRtcClient?.refreshLockedFramePreview() },
                120L
            )
        }
    }

    @Suppress("DEPRECATION")
    private fun displayRotationDegrees(): Int {
        return when (windowManager.defaultDisplay.rotation) {
            Surface.ROTATION_90 -> 90
            Surface.ROTATION_180 -> 180
            Surface.ROTATION_270 -> 270
            else -> 0
        }
    }

    private fun createDeviceOrientationPayload(rawRotationDegrees: Int): DeviceOrientationPayload {
        val isScreenShare = activePresentationMode == PresentationMode.ScreenShare
        val rotationDegrees = when {
            isScreenShare && rawRotationDegrees.isLandscapeRotation() -> rawRotationDegrees
            isScreenShare -> 90
            !isUsingFrontCamera && rawRotationDegrees.isLandscapeRotation() -> (rawRotationDegrees + 180) % 360
            else -> rawRotationDegrees
        }
        val orientation = if (isScreenShare || rawRotationDegrees.isLandscapeRotation()) {
            "landscape"
        } else {
            "portrait"
        }
        val cameraFacing = when {
            isScreenShare -> "unknown"
            isUsingFrontCamera -> "front"
            else -> "back"
        }
        val frameLocked = !isScreenShare && webRtcClient?.isStaticPresentationActive() == true
        val lockedFramePresentation = if (frameLocked) {
            webRtcClient?.lockedFramePresentation()
        } else {
            null
        } ?: LockedFramePresentation(
            zoomRatio = 1f,
            cropX = 0f,
            cropY = 0f,
            cropWidth = 1f,
            cropHeight = 1f
        )

        return DeviceOrientationPayload(
            orientation = orientation,
            rotationDegrees = rotationDegrees,
            cameraFacing = cameraFacing,
            frameLocked = frameLocked,
            lockedFrameZoomRatio = lockedFramePresentation.zoomRatio,
            lockedFrameCropX = lockedFramePresentation.cropX,
            lockedFrameCropY = lockedFramePresentation.cropY,
            lockedFrameCropWidth = lockedFramePresentation.cropWidth,
            lockedFrameCropHeight = lockedFramePresentation.cropHeight
        )
    }

    private fun Int.isLandscapeRotation(): Boolean = this == 90 || this == 270

    private fun attachCameraGestures(renderer: SurfaceViewRenderer) {
        var touchWasScaling = false
        var touchWasDragging = false
        var lastTouchX = 0f
        var lastTouchY = 0f
        val touchSlop = ViewConfiguration.get(this).scaledTouchSlop.toFloat()
        val touchSlopSquared = touchSlop * touchSlop
        val scaleDetector = ScaleGestureDetector(
            this,
            object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
                override fun onScale(detector: ScaleGestureDetector): Boolean {
                    touchWasScaling = true
                    webRtcClient?.zoomBy(detector.scaleFactor)
                    if (webRtcClient?.isStaticPresentationActive() == true) {
                        sendCurrentDeviceOrientation(force = true)
                    }
                    return true
                }
            }
        )

        renderer.setOnTouchListener { view, event ->
            scaleDetector.onTouchEvent(event)
            if (event.pointerCount > 1) {
                touchWasScaling = true
            }
            if (event.actionMasked == MotionEvent.ACTION_DOWN) {
                touchWasScaling = false
                touchWasDragging = false
                lastTouchX = event.x
                lastTouchY = event.y
            }
            if (event.actionMasked == MotionEvent.ACTION_MOVE &&
                event.pointerCount == 1 &&
                !touchWasScaling &&
                webRtcClient?.isStaticPresentationActive() == true
            ) {
                val dx = event.x - lastTouchX
                val dy = event.y - lastTouchY
                if (touchWasDragging || dx * dx + dy * dy >= touchSlopSquared) {
                    val width = view.width.coerceAtLeast(1)
                    val height = view.height.coerceAtLeast(1)
                    if (webRtcClient?.panLockedFrameBy(dx / width, dy / height) == true) {
                        touchWasDragging = true
                        sendCurrentDeviceOrientation(force = true)
                    }
                    lastTouchX = event.x
                    lastTouchY = event.y
                }
            }
            if (event.actionMasked == MotionEvent.ACTION_UP &&
                !touchWasScaling &&
                !touchWasDragging &&
                webRtcClient?.isStaticPresentationActive() != true
            ) {
                val width = view.width
                val height = view.height
                if (width > 0 && height > 0) {
                    webRtcClient?.focusAt(event.x / width, event.y / height)
                }
                view.performClick()
            }
            true
        }
    }

    private fun versionLabel(onDark: Boolean = false): TextView =
        TextView(this).apply {
            text = "v${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})"
            textSize = 12f
            gravity = Gravity.CENTER
            setTextColor(
                if (onDark) {
                    Color.argb(210, 255, 255, 255)
                } else {
                    ContextCompat.getColor(this@MainActivity, R.color.myclass_on_surface)
                }
            )
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                topMargin = dp(12)
            }
        }

    private fun baseColumn(): LinearLayout =
        LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(ContextCompat.getColor(this@MainActivity, R.color.myclass_background))
        }

    private fun titleText(textValue: String, size: Float): TextView =
        TextView(this).apply {
            text = textValue
            textSize = size
            setTextColor(ContextCompat.getColor(this@MainActivity, R.color.myclass_on_surface))
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }

    private fun bodyText(textValue: String): TextView =
        TextView(this).apply {
            text = textValue
            textSize = 15f
            setTextColor(ContextCompat.getColor(this@MainActivity, R.color.myclass_on_surface))
        }

    private fun primaryButton(textValue: String): MaterialButton =
        MaterialButton(this).apply {
            text = textValue
            textSize = 16f
            cornerRadius = dp(8)
        }

    private fun secondaryButton(textValue: String): MaterialButton =
        MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
            text = textValue
            textSize = 16f
            cornerRadius = dp(8)
            setTextColor(ContextCompat.getColor(this@MainActivity, R.color.myclass_on_surface))
        }

    private fun cameraPrimaryButton(textValue: String): MaterialButton =
        RotatedTextMaterialButton(this).apply {
            setCameraButtonText(this, textValue)
            textSize = 16f
            cornerRadius = dp(8)
        }

    private fun cameraSecondaryButton(textValue: String): MaterialButton =
        RotatedTextMaterialButton(
            this,
            null,
            com.google.android.material.R.attr.materialButtonOutlinedStyle
        ).apply {
            setCameraButtonText(this, textValue)
            textSize = 16f
            cornerRadius = dp(8)
            setTextColor(ContextCompat.getColor(this@MainActivity, R.color.myclass_on_surface))
        }

    private fun setCameraButtonText(button: MaterialButton?, textValue: String) {
        if (button is RotatedTextMaterialButton) {
            button.displayText = textValue
        } else {
            button?.text = textValue
        }
    }

    private fun setCameraButtonTextRotation(button: MaterialButton, degrees: Float) {
        if (button is RotatedTextMaterialButton) {
            button.textRotationDegrees = degrees
        }
    }

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    }

    private fun dp(value: Int): Int =
        (value * resources.displayMetrics.density).toInt()

    private class RotatedTextMaterialButton @JvmOverloads constructor(
        context: android.content.Context,
        attrs: AttributeSet? = null,
        defStyleAttr: Int = com.google.android.material.R.attr.materialButtonStyle
    ) : MaterialButton(context, attrs, defStyleAttr) {
        var displayText: String = ""
            set(value) {
                field = value
                contentDescription = value
                super.setText("", TextView.BufferType.NORMAL)
                invalidate()
            }

        var textRotationDegrees: Float = 0f
            set(value) {
                field = value
                invalidate()
            }

        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            if (displayText.isBlank()) {
                return
            }

            val oldColor = paint.color
            val oldAlign = paint.textAlign
            paint.color = currentTextColor
            paint.textAlign = Paint.Align.CENTER
            val lines = displayLines()
            val fontMetrics = paint.fontMetrics
            val lineHeight = fontMetrics.descent - fontMetrics.ascent
            val firstBaseline = height / 2f -
                (lineHeight * lines.size) / 2f -
                fontMetrics.ascent

            canvas.save()
            canvas.rotate(textRotationDegrees, width / 2f, height / 2f)
            lines.forEachIndexed { index, line ->
                canvas.drawText(line, width / 2f, firstBaseline + index * lineHeight, paint)
            }
            canvas.restore()

            paint.color = oldColor
            paint.textAlign = oldAlign
        }

        private fun displayLines(): List<String> {
            if (maxLines <= 1 || displayText.length <= 2) {
                return listOf(displayText)
            }
            if (displayText.endsWith("补光灯")) {
                val prefix = displayText.removeSuffix("补光灯")
                return if (prefix.isBlank()) {
                    listOf(displayText)
                } else {
                    listOf(prefix, "补光灯")
                }
            }
            val splitIndex = displayText.length / 2
            return listOf(
                displayText.substring(0, splitIndex),
                displayText.substring(splitIndex)
            )
        }
    }
}
