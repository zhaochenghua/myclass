package cn.edu.nb3.myclass

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.database.Cursor
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.content.res.ColorStateList
import android.graphics.Typeface
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.text.TextUtils
import android.text.InputFilter
import android.text.InputType
import android.util.AttributeSet
import android.util.Base64
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
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.google.android.material.button.MaterialButton
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okio.BufferedSink
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.SurfaceViewRenderer
import java.io.IOException
import java.util.concurrent.TimeUnit

class MainActivity : AppCompatActivity(), SignalingClient.Callback {
    private enum class Screen {
        Auth,
        Connect,
        Menu,
        Camera,
        ScreenShare,
        Courseware
    }

    private enum class CoursewareSubScreen {
        None,
        Source,
        ListLoading,
        ServerList,
        Playback
    }

    private enum class PresentationMode {
        Camera,
        ScreenShare
    }

    private data class CoursewareUploadResult(
        val title: String,
        val url: String
    )

    private data class CoursewareState(
        val title: String,
        val url: String,
        val page: Int,
        val pageCount: Int,
        val screen: Int,
        val screenCount: Int
    )

    private data class StoredCoursewareItem(
        val id: String,
        val title: String,
        val url: String,
        val size: Long,
        val originalUrl: String = ""
    )

    private var currentScreen = Screen.Connect
    private var authToken: String? = null
    private var authUsername: String? = null
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
    private var audioToggleButton: MaterialButton? = null
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
    private var pendingCoursewareCloseAfterJoin = false
    private var isPickingImageForProjection = false
    private var openImagePickerAfterPermission = false
    private var coursewarePage = 1
    private var coursewarePageCount = 1
    private var coursewareScreen = 1
    private var coursewareScreenCount = 1
    private var coursewareTitle = ""
    private var coursewareUrl = ""
    private var coursewareUploadInProgress = false
    private var coursewareFastSeekDirection = 0
    private var coursewareFastSeekTargetPage = 1
    private var coursewareFastSeekConsumedClick = false
    private var coursewareFastSeekTicks = 0
    private var coursewareFastSeekRunnable: Runnable? = null
    private var signalReconnectInProgress = false
    private var savedCoursewareState: CoursewareState? = null
    private var coursewareSubScreen: CoursewareSubScreen = CoursewareSubScreen.None
    private var initialIntentProcessed = false
    private val coursewareHttpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.MINUTES)
        .readTimeout(30, TimeUnit.MINUTES)
        .callTimeout(35, TimeUnit.MINUTES)
        .retryOnConnectionFailure(true)
        .build()

    private val authHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .build()

    private val prefs: SharedPreferences
        get() = getSharedPreferences("myclass_auth", Context.MODE_PRIVATE)

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { result ->
        if (result.values.all { it }) {
            val shouldOpenImagePicker = openImagePickerAfterPermission
            openImagePickerAfterPermission = false
            showCameraScreen(openImagePicker = shouldOpenImagePicker)
        } else {
            openImagePickerAfterPermission = false
            toast("需要摄像头和麦克风权限才能直播")
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        rawDeviceRotationDegrees = displayRotationDegrees()
        currentDeviceOrientation = createDeviceOrientationPayload(rawDeviceRotationDegrees)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        onBackPressedDispatcher.addCallback(this, backCallback)
        loadAuth()
        ExternalFileReceiver.restoreQueue(this)
        if (authToken != null) {
            showAuthScreen() // show immediately to avoid black screen
            verifyTokenThenProceed()
        } else {
            showAuthScreen()
        }
        if (!initialIntentProcessed) {
            initialIntentProcessed = true
            val capturedIntent = intent
            if (capturedIntent?.action in listOf(Intent.ACTION_SEND, Intent.ACTION_VIEW)) {
                Thread {
                    val handled = ExternalFileReceiver.handleIncomingIntent(this, capturedIntent)
                    runOnUiThread {
                        when {
                            ExternalFileReceiver.wasLastReceiveDuplicate() -> toast("该文件已在待上传列表中")
                            handled && ExternalFileReceiver.isLatestPendingVideo() -> {
                                showVideoNameDialog()
                            }
                            handled -> {
                                toast("课件已加入上传队列（${ExternalFileReceiver.pendingCount()} 个待上传）")
                                triggerPendingUploadIfReady()
                            }
                        }
                    }
                }.start()
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (intent.action in listOf(Intent.ACTION_SEND, Intent.ACTION_VIEW)) {
            Thread {
                val handled = ExternalFileReceiver.handleIncomingIntent(this, intent)
                runOnUiThread {
                    when {
                        ExternalFileReceiver.wasLastReceiveDuplicate() -> toast("该文件已在待上传列表中")
                        handled && ExternalFileReceiver.isLatestPendingVideo() -> {
                            showVideoNameDialog()
                        }
                        handled -> {
                            toast("课件已加入上传队列（${ExternalFileReceiver.pendingCount()} 个待上传）")
                            triggerPendingUploadIfReady()
                        }
                    }
                }
            }.start()
        }
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        // 横竖屏切换时重建当前页面布局
        when (currentScreen) {
            Screen.Auth -> showAuthScreen()
            Screen.Connect -> showConnectScreen()
            Screen.Menu -> showMenuScreen()
            Screen.Camera -> {
                // 不重建整个相机页面（会中断预览），仅更新按钮布局和悬浮按钮位置
                updateCameraControlsLayout()
                updateAudioButtonPosition()
                cameraRenderer?.requestLayout()
                refreshLockedFramePreviewAfterLayout()
            }
            Screen.ScreenShare -> {
                // 共享屏幕页面布局简单，无需重建
            }
            Screen.Courseware -> {
                // 根据子页面类型重建课件界面
                when (coursewareSubScreen) {
                    CoursewareSubScreen.Source -> showCoursewareSourceScreen()
                    CoursewareSubScreen.ListLoading -> showCoursewareListLoadingScreen()
                    CoursewareSubScreen.ServerList -> {
                        // 服务器列表由异步数据填充，此处重建为加载中状态
                        showCoursewareListLoadingScreen()
                        loadServerCoursewareList()
                    }
                    CoursewareSubScreen.Playback -> showCoursewareScreen(
                        title = coursewareTitle,
                        isUploading = coursewareUploadInProgress
                    )
                    CoursewareSubScreen.None -> {}
                }
            }
        }
        syncDeviceRotationFromDisplay(force = true)
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

    private val coursewarePickerLauncher = registerForActivityResult(
        ActivityResultContracts.GetContent()
    ) { uri: Uri? ->
        uri ?: return@registerForActivityResult
        uploadCourseware(uri)
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
                Screen.Auth -> {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
                Screen.Camera -> {
                    returnToMenuFromCamera()
                }
                Screen.ScreenShare -> {
                    stopScreenShareAndReturnMenu()
                }
                Screen.Courseware -> {
                    closeCoursewareAndReturnMenu()
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

    // -- 认证相关 --
    private fun loadAuth() {
        val p = prefs
        authToken = p.getString("token", null)
        authUsername = p.getString("username", null)
    }

    private fun saveAuth(token: String, username: String) {
        authToken = token
        authUsername = username
        prefs.edit()
            .putString("token", token)
            .putString("username", username)
            .apply()
    }

    private fun clearAuth() {
        authToken = null
        authUsername = null
        prefs.edit().remove("token").remove("username").apply()
    }

    private fun triggerPendingUploadIfReady() {
        if (authToken == null) return
        val count = ExternalFileReceiver.pendingCount()
        if (count > 0) {
            toast("正在上传 ${count} 个待上传课件...")
        }
        Thread {
            ExternalFileReceiver.processPendingQueue(this)
        }.start()
    }

    private fun addAuthHeader(builder: Request.Builder) {
        authToken?.let { builder.header("Authorization", "Bearer $it") }
    }

    private fun verifyTokenThenProceed() {
        Thread {
            runCatching {
                val request = Request.Builder()
                    .url("${BuildConfig.SERVER_BASE_URL.trimEnd('/')}/api/auth/me")
                    .get().also { addAuthHeader(it) }
                    .build()
                authHttpClient.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) throw IOException("token invalid")
                }
            }.onSuccess {
                runOnUiThread { showConnectScreen() }
            }.onFailure {
                runOnUiThread {
                    clearAuth()
                    // Already on auth screen, just update status
                    updateStatus("无法连接服务器，请确认已连接教室网络")
                }
            }
        }.start()
    }

    private fun showAuthScreen() {
        currentScreen = Screen.Auth
        val isLandscape = resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE

        // 创建输入控件
        val usernameLayout = TextInputLayout(this).apply {
            hint = "用户名（2-20位）"
            boxBackgroundMode = TextInputLayout.BOX_BACKGROUND_OUTLINE
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(if (isLandscape) 0 else 28) }
        }
        val usernameInput = TextInputEditText(usernameLayout.context).apply {
            inputType = InputType.TYPE_CLASS_TEXT
            textSize = 17f
            setSingleLine(true)
        }
        usernameLayout.addView(usernameInput)

        val passwordLayout = TextInputLayout(this).apply {
            hint = "密码（4-32位）"
            boxBackgroundMode = TextInputLayout.BOX_BACKGROUND_OUTLINE
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(16) }
        }
        val passwordInput = TextInputEditText(passwordLayout.context).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            textSize = 17f
            setSingleLine(true)
        }
        passwordLayout.addView(passwordInput)

        val loginButton = primaryButton("登录").apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(52)
            ).apply { topMargin = dp(24) }
            setOnClickListener {
                val name = usernameInput.text?.toString()?.trim().orEmpty()
                val pass = passwordInput.text?.toString().orEmpty()
                if (name.length < 2) { usernameLayout.error = "用户名至少2位"; return@setOnClickListener }
                if (pass.length < 4) { passwordLayout.error = "密码至少4位"; return@setOnClickListener }
                usernameLayout.error = null
                passwordLayout.error = null
                isEnabled = false
                text = "登录中..."
                performAuth(false, name, pass)
            }
        }
        val registerButton = secondaryButton("注册新账号").apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(52)
            ).apply { topMargin = dp(12) }
            setOnClickListener {
                val name = usernameInput.text?.toString()?.trim().orEmpty()
                val pass = passwordInput.text?.toString().orEmpty()
                if (name.length < 2) { usernameLayout.error = "用户名至少2位"; return@setOnClickListener }
                if (!Regex("^[\\u4e00-\\u9fa5a-zA-Z0-9_]+$").matches(name)) {
                    usernameLayout.error = "仅支持中英文数字下划线"; return@setOnClickListener
                }
                if (name.length > 20) { usernameLayout.error = "用户名最多20位"; return@setOnClickListener }
                if (pass.length < 4) { passwordLayout.error = "密码至少4位"; return@setOnClickListener }
                if (pass.length > 32) { passwordLayout.error = "密码最多32位"; return@setOnClickListener }
                usernameLayout.error = null
                passwordLayout.error = null
                isEnabled = false
                text = "注册中..."
                performAuth(true, name, pass)
            }
        }
        val statusView = bodyText("").apply {
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(18) }
        }

        if (isLandscape) {
            // 横屏：左右结构
            val root = landscapeRoot().apply {
                setPadding(dp(24), dp(16), dp(24), dp(16))
                gravity = Gravity.CENTER
            }
            val leftPanel = baseColumn().apply {
                gravity = Gravity.CENTER
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                    marginEnd = dp(24)
                }
            }
            leftPanel.addView(titleText("上课投屏平台", 22f))
            leftPanel.addView(bodyText("首次使用请注册账号").apply {
                gravity = Gravity.CENTER
                setTextColor(Color.argb(180, 96, 96, 96))
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { topMargin = dp(8) }
            })
            leftPanel.addView(statusView)
            leftPanel.addView(footerLabel().apply {
                (layoutParams as LinearLayout.LayoutParams).topMargin = dp(16)
            })
            leftPanel.addView(versionLabel())

            val rightPanel = baseColumn().apply {
                gravity = Gravity.CENTER
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            rightPanel.addView(usernameLayout)
            rightPanel.addView(passwordLayout)
            rightPanel.addView(loginButton)
            rightPanel.addView(registerButton)

            root.addView(leftPanel)
            root.addView(rightPanel)
            setContentView(root)
        } else {
            // 竖屏：垂直结构
            val root = baseColumn().apply {
                setPadding(dp(28), dp(36), dp(28), dp(32))
            }
            root.addView(titleText("上课投屏平台", 24f))
            root.addView(bodyText("首次使用请注册账号").apply {
                gravity = Gravity.CENTER
                setTextColor(Color.argb(180, 96, 96, 96))
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { topMargin = dp(8) }
            })
            root.addView(usernameLayout)
            root.addView(passwordLayout)
            root.addView(loginButton)
            root.addView(registerButton)
            root.addView(statusView)
            root.addView(footerLabel())
            root.addView(versionLabel())
            setContentView(root)
        }
    }

    private fun performAuth(isRegister: Boolean, username: String, password: String) {
        Thread {
            runCatching {
                val json = JSONObject().apply {
                    put("username", username)
                    put("password", password)
                }
                val body = RequestBody.create(
                    "application/json; charset=utf-8".toMediaTypeOrNull(),
                    json.toString()
                )
                val url = "${BuildConfig.SERVER_BASE_URL.trimEnd('/')}/api/auth/${if (isRegister) "register" else "login"}"
                val request = Request.Builder().url(url).post(body).build()
                authHttpClient.newCall(request).execute().use { response ->
                    val respBody = response.body?.string().orEmpty()
                    if (!response.isSuccessful) {
                        val error = runCatching {
                            JSONObject(respBody).optString("error")
                        }.getOrNull().orEmpty()
                        throw IOException(error.ifBlank { "HTTP ${response.code}" })
                    }
                    val resp = JSONObject(respBody)
                    val token = resp.getString("token")
                    val name = resp.getString("username")
                    runOnUiThread {
                        saveAuth(token, name)
                        triggerPendingUploadIfReady()
                        showConnectScreen()
                        toast("${if (isRegister) "注册" else "登录"}成功，欢迎 $name")
                    }
                }
            }.onFailure { error ->
                runOnUiThread {
                    toast(error.message ?: "认证失败")
                    showAuthScreen()
                }
            }
        }.start()
    }

    private fun showConnectScreen() {
        currentScreen = Screen.Connect
        val isLandscape = resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE

        val inputLayout = TextInputLayout(this).apply {
            hint = "连接码"
            boxBackgroundMode = TextInputLayout.BOX_BACKGROUND_OUTLINE
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                topMargin = dp(if (isLandscape) 0 else 28)
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
                topMargin = dp(18)
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
                topMargin = dp(20)
            }
        }

        val hintText = TextView(this).apply {
            text = "浏览器进入 10.30.13.1/myclass 查看连接码"
            textSize = 13f
            gravity = Gravity.CENTER
            alpha = 0.6f
            setTextColor(ContextCompat.getColor(this@MainActivity, R.color.myclass_on_surface))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                topMargin = dp(6)
            }
        }

        val userButton = secondaryButton("用户管理：${authUsername ?: ""}").apply {
            textSize = 14f
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                dp(40)
            ).apply {
                topMargin = dp(32)
            }
            setOnClickListener {
                showUserManagementDialog()
            }
        }

        if (ExternalFileReceiver.pendingCount() > 0) {
            updateStatus("${ExternalFileReceiver.pendingCount()} 个课件等待上传，连接教室后自动上传")
        }

        if (isLandscape) {
            // 横屏：左右结构
            val root = landscapeRoot().apply {
                setPadding(dp(24), dp(16), dp(24), dp(16))
                gravity = Gravity.CENTER
            }
            val leftPanel = baseColumn().apply {
                gravity = Gravity.CENTER
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                    marginEnd = dp(24)
                }
            }
            leftPanel.addView(titleText(getString(R.string.platform_title), 22f))
            leftPanel.addView(statusText)
            leftPanel.addView(hintText)
            leftPanel.addView(userButton.apply {
                (layoutParams as LinearLayout.LayoutParams).topMargin = dp(16)
            })

            val rightPanel = baseColumn().apply {
                gravity = Gravity.CENTER
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            rightPanel.addView(inputLayout)
            rightPanel.addView(connectButton)
            rightPanel.addView(versionLabel().apply {
                (layoutParams as LinearLayout.LayoutParams).topMargin = dp(12)
            })
            rightPanel.addView(footerLabel().apply {
                (layoutParams as LinearLayout.LayoutParams).topMargin = dp(2)
            })

            root.addView(leftPanel)
            root.addView(rightPanel)
            setContentView(root)
        } else {
            // 竖屏：垂直结构
            val root = baseColumn().apply {
                setPadding(dp(28), dp(36), dp(28), dp(20))
            }
            root.addView(titleText(getString(R.string.platform_title), 22f))
            root.addView(inputLayout)
            root.addView(connectButton)
            root.addView(statusText)
            root.addView(hintText)
            root.addView(userButton)
            root.addView(versionLabel().apply {
                (layoutParams as LinearLayout.LayoutParams).topMargin = dp(6)
            })
            root.addView(footerLabel().apply {
                (layoutParams as LinearLayout.LayoutParams).topMargin = dp(2)
            })
            setContentView(root)
        }
    }

    private fun showUserManagementDialog() {
        AlertDialog.Builder(this)
            .setTitle("用户管理")
            .setItems(arrayOf("课件管理", "切换用户")) { _, which ->
                when (which) {
                    0 -> showCoursewareManagement()
                    1 -> confirmSwitchUser()
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun confirmSwitchUser() {
        AlertDialog.Builder(this)
            .setTitle("切换用户")
            .setMessage("确定要退出当前账号（${authUsername}）吗？")
            .setNegativeButton("取消", null)
            .setPositiveButton("确定") { _, _ ->
                signalingClient?.close()
                signalingClient = null
                activeRoomCode = null
                roomJoined = false
                ExternalFileReceiver.clearQueue(this@MainActivity)
                clearAuth()
                showAuthScreen()
            }
            .show()
    }

    private fun showCoursewareManagementUploading(fileName: String) {
        currentScreen = Screen.Connect
        val root = baseColumn().apply {
            setPadding(dp(28), dp(32), dp(28), dp(32))
        }
        root.addView(titleText("上传课件", 22f))
        val progressView = bodyText("正在上传：$fileName").apply {
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(20) }
        }
        root.addView(progressView)
        setContentView(root)
        statusText = progressView
    }

    private fun showCoursewareManagement() {
        currentScreen = Screen.Connect  // 停留在 Connect 状态，避免 back 混乱
        val root = baseColumn().apply {
            setPadding(dp(28), dp(32), dp(28), dp(32))
        }
        root.addView(titleText("课件管理", 22f))
        val statusView = bodyText("正在加载...").apply {
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(20) }
        }
        root.addView(statusView)
        root.addView(secondaryButton("返回").apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(50)
            ).apply { topMargin = dp(20) }
            setOnClickListener { showConnectScreen() }
        })
        setContentView(root)

        Thread {
            runCatching {
                fetchServerCoursewareListBlocking()
            }.onSuccess { items ->
                runOnUiThread { showCoursewareManagementList(items) }
            }.onFailure { error ->
                runOnUiThread {
                    statusView.text = "加载失败：${error.message}"
                }
            }
        }.start()
    }

    private fun showCoursewareManagementList(items: List<StoredCoursewareItem>) {
        val root = baseColumn().apply {
            setPadding(dp(28), dp(32), dp(28), dp(32))
        }
        root.addView(titleText("课件管理", 22f))

        if (items.isEmpty()) {
            root.addView(bodyText("暂无课件").apply {
                gravity = Gravity.CENTER
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { topMargin = dp(24) }
            })
        } else {
            val listColumn = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    0,
                    1f
                )
            }
            items.forEachIndexed { index, item ->
                val row = LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    ).apply {
                        if (index > 0) topMargin = dp(4)
                    }
                }
                row.addView(secondaryButton("${item.title} ${coursewareFormatLabel(item)}  ${formatCoursewareSize(item.size)}").apply {
                    maxLines = 2
                    setSingleLine(false)
                    ellipsize = TextUtils.TruncateAt.END
                    textSize = 14f
                    isEnabled = false
                    layoutParams = LinearLayout.LayoutParams(
                        0,
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                        1f
                    ).apply { marginEnd = dp(4) }
                })
                row.addView(deleteButton("删除").apply {
                    setOnClickListener {
                        confirmDeleteManagementCourseware(item)
                    }
                })
                listColumn.addView(row)
            }
            val listScroll = ScrollView(this).apply {
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    0,
                    1f
                ).apply { topMargin = dp(12) }
                addView(listColumn)
            }
            root.addView(listScroll)
        }

        root.addView(primaryButton("上传课件").apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(50)
            ).apply { topMargin = dp(16) }
            setOnClickListener {
                uploadFromManagement()
            }
        })
        root.addView(secondaryButton("返回").apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(50)
            ).apply { topMargin = dp(8) }
            setOnClickListener { showConnectScreen() }
        })
        setContentView(root)
    }

    private val managementPickerLauncher = registerForActivityResult(
        ActivityResultContracts.GetContent()
    ) { uri: Uri? ->
        if (uri == null) return@registerForActivityResult
        managementUploadProgress(uri)
    }

    private fun uploadFromManagement() {
        managementPickerLauncher.launch("*/*")
    }

    private fun managementUploadProgress(uri: Uri) {
        val fileName = displayNameForUri(uri)
        showCoursewareManagementUploading(fileName)
        Thread {
            runCatching {
                val totalBytes = contentLengthForUri(uri)
                val requestBody = object : RequestBody() {
                    override fun contentType() =
                        (contentResolver.getType(uri) ?: "application/octet-stream").toMediaTypeOrNull()
                    override fun contentLength(): Long = totalBytes
                    override fun writeTo(sink: BufferedSink) {
                        val input = contentResolver.openInputStream(uri)
                            ?: throw IOException("无法读取文件")
                        input.use {
                            val buffer = ByteArray(8 * 1024)
                            var uploadedBytes = 0L
                            var lastProgressAt = 0L
                            while (true) {
                                val read = it.read(buffer)
                                if (read == -1) break
                                sink.write(buffer, 0, read)
                                uploadedBytes += read
                                val now = System.currentTimeMillis()
                                if (now - lastProgressAt > 300L || uploadedBytes == totalBytes) {
                                    lastProgressAt = now
                                    runOnUiThread {
                                        updateCoursewareUploadProgress(fileName, uploadedBytes, totalBytes)
                                    }
                                }
                            }
                        }
                    }
                }
                val multipartBody = MultipartBody.Builder()
                    .setType(MultipartBody.FORM)
                    .addFormDataPart(
                        "displayNameBase64",
                        Base64.encodeToString(fileName.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
                    )
                    .addFormDataPart("file", fileName, requestBody)
                    .build()
                val request = Request.Builder()
                    .url("${BuildConfig.SERVER_BASE_URL.trimEnd('/')}/api/courseware")
                    .post(multipartBody)
                    .also { addAuthHeader(it) }
                    .build()
                coursewareHttpClient.newCall(request).execute().use { response ->
                    val body = response.body?.string().orEmpty()
                    if (!response.isSuccessful) {
                        val error = runCatching {
                            JSONObject(body).optString("error")
                        }.getOrNull().orEmpty()
                        throw IOException(error.ifBlank { "上传失败：HTTP ${response.code}" })
                    }
                }
            }.onSuccess {
                runOnUiThread {
                    toast("课件上传成功")
                    showCoursewareManagement()
                }
            }.onFailure { error ->
                runOnUiThread {
                    toast(error.message ?: "课件上传失败")
                    showCoursewareManagement()
                }
            }
        }.start()
    }

    private fun confirmDeleteManagementCourseware(item: StoredCoursewareItem) {
        AlertDialog.Builder(this)
            .setTitle("删除课件")
            .setMessage("确定删除「${item.title}」吗？")
            .setNegativeButton("取消", null)
            .setPositiveButton("删除") { _, _ ->
                deleteManagementCourseware(item)
            }
            .show()
    }

    private fun showVideoNameDialog() {
        val input = android.widget.EditText(this).apply {
            hint = "请输入视频名称"
            inputType = InputType.TYPE_CLASS_TEXT
            setSingleLine(true)
            filters = arrayOf(InputFilter.LengthFilter(50))
            setPadding(dp(16), dp(12), dp(16), dp(12))
        }
        AlertDialog.Builder(this)
            .setTitle("导入视频")
            .setMessage("请输入该视频的名称")
            .setView(input)
            .setNegativeButton("取消") { _, _ ->
                ExternalFileReceiver.clearQueue(this)
                toast("已取消视频导入")
            }
            .setPositiveButton("确定") { _, _ ->
                val name = input.text.toString().trim()
                if (name.isEmpty()) {
                    toast("名称不能为空")
                    showVideoNameDialog()
                } else {
                    ExternalFileReceiver.setLatestPendingName(name, this)
                    toast("视频已加入上传队列")
                    triggerPendingUploadIfReady()
                }
            }
            .setOnCancelListener {
                ExternalFileReceiver.clearQueue(this)
                toast("已取消视频导入")
            }
            .show()
    }

    private fun deleteManagementCourseware(item: StoredCoursewareItem) {
        Thread {
            runCatching {
                deleteServerCoursewareBlocking(item)
            }.onSuccess {
                runOnUiThread {
                    toast("课件已删除")
                    showCoursewareManagement()
                }
            }.onFailure { error ->
                runOnUiThread {
                    toast(error.message ?: "删除失败")
                    showCoursewareManagement()
                }
            }
        }.start()
    }

    private fun showMenuScreen() {
        currentScreen = Screen.Menu
        val isLandscape = resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE

        val cameraBtn = primaryButton("摄像头直播").apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(58)
            ).apply {
                topMargin = dp(if (isLandscape) 0 else 34)
            }
            setOnClickListener {
                ensureCameraPermissions()
            }
        }
        val imageBtn = primaryButton("图片投屏").apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(58)
            ).apply {
                topMargin = dp(16)
            }
            setOnClickListener {
                ensureCameraPermissions(openImagePicker = true)
            }
        }
        val screenBtn = primaryButton("共享屏幕").apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(58)
            ).apply {
                topMargin = dp(16)
            }
            setOnClickListener {
                requestScreenSharePermission()
            }
        }
        val coursewareBtn = primaryButton(if (savedCoursewareState != null) "继续播放课件" else "播放课件").apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(58)
            ).apply {
                topMargin = dp(16)
            }
            setOnClickListener {
                resumeOrShowCoursewareSource()
            }
        }
        statusText = bodyText("已连接课堂").apply {
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                topMargin = dp(if (isLandscape) 12 else 24)
            }
        }

        if (isLandscape) {
            // 横屏：左右结构
            val root = landscapeRoot().apply {
                setPadding(dp(24), dp(16), dp(24), dp(16))
                gravity = Gravity.CENTER
            }
            val leftPanel = baseColumn().apply {
                gravity = Gravity.CENTER
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                    marginEnd = dp(24)
                }
            }
            leftPanel.addView(titleText("功能菜单", 22f))
            leftPanel.addView(statusText)
            leftPanel.addView(versionLabel())

            val rightPanel = baseColumn().apply {
                gravity = Gravity.CENTER
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            rightPanel.addView(cameraBtn)
            rightPanel.addView(imageBtn)
            rightPanel.addView(screenBtn)
            rightPanel.addView(coursewareBtn)

            root.addView(leftPanel)
            root.addView(rightPanel)
            setContentView(root)
        } else {
            // 竖屏：垂直结构
            val root = baseColumn().apply {
                setPadding(dp(28), dp(32), dp(28), dp(32))
            }
            root.addView(titleText("功能菜单", 28f))
            root.addView(cameraBtn)
            root.addView(imageBtn)
            root.addView(screenBtn)
            root.addView(coursewareBtn)
            root.addView(statusText)
            root.addView(versionLabel())
            setContentView(root)
        }
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

    private fun resumeOrShowCoursewareSource() {
        val saved = savedCoursewareState
        if (saved != null) {
            savedCoursewareState = null
            coursewareUploadInProgress = false
            coursewarePage = saved.page
            coursewarePageCount = saved.pageCount
            coursewareScreen = saved.screen
            coursewareScreenCount = saved.screenCount
            coursewareTitle = saved.title
            coursewareUrl = saved.url
            if (roomJoined) {
                signalingClient?.sendStop()
                signalingClient?.sendCoursewareOpen(
                    saved.url,
                    saved.title,
                    saved.page,
                    saved.screen
                )
                showCoursewareScreen(title = saved.title, isUploading = false)
                toast("已恢复课件：${saved.title}")
            } else {
                reconnectSignalingForCurrentRoom()
                showCoursewareScreen(title = saved.title, isUploading = false)
                toast("正在重新连接教室端…")
            }
            return
        }
        showCoursewareSourceScreen()
    }

    private fun showCoursewareSourceScreen() {
        currentScreen = Screen.Courseware
        coursewareSubScreen = CoursewareSubScreen.Source
        val isLandscape = resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE

        val serverBtn = primaryButton("服务器课件").apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(58)
            ).apply {
                topMargin = dp(if (isLandscape) 0 else 34)
            }
            setOnClickListener {
                loadServerCoursewareList()
            }
        }
        val uploadBtn = primaryButton("本地上传").apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(58)
            ).apply {
                topMargin = dp(16)
            }
            setOnClickListener {
                launchCoursewarePicker()
            }
        }
        val backBtn = secondaryButton("返回菜单").apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(58)
            ).apply {
                topMargin = dp(16)
            }
            setOnClickListener {
                showMenuScreen()
            }
        }
        statusText = bodyText("可直接打开服务器暂存课件，或从手机重新上传").apply {
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                topMargin = dp(if (isLandscape) 12 else 24)
            }
        }

        if (isLandscape) {
            // 横屏：左右结构
            val root = landscapeRoot().apply {
                setPadding(dp(24), dp(16), dp(24), dp(16))
                gravity = Gravity.CENTER
            }
            val leftPanel = baseColumn().apply {
                gravity = Gravity.CENTER
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                    marginEnd = dp(24)
                }
            }
            leftPanel.addView(titleText("播放课件", 22f))
            leftPanel.addView(statusText)
            leftPanel.addView(versionLabel())

            val rightPanel = baseColumn().apply {
                gravity = Gravity.CENTER
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            rightPanel.addView(serverBtn)
            rightPanel.addView(uploadBtn)
            rightPanel.addView(backBtn)

            root.addView(leftPanel)
            root.addView(rightPanel)
            setContentView(root)
        } else {
            // 竖屏：垂直结构
            val root = baseColumn().apply {
                setPadding(dp(28), dp(32), dp(28), dp(32))
            }
            root.addView(titleText("播放课件", 28f))
            root.addView(serverBtn)
            root.addView(uploadBtn)
            root.addView(backBtn)
            root.addView(statusText)
            root.addView(versionLabel())
            setContentView(root)
        }
    }

    private fun loadServerCoursewareList() {
        if (!roomJoined || activeRoomCode == null) {
            toast("请先连接教室端")
            return
        }
        showCoursewareListLoadingScreen()
        Thread {
            runCatching {
                fetchServerCoursewareListBlocking()
            }.onSuccess { items ->
                runOnUiThread {
                    showServerCoursewareList(items)
                }
            }.onFailure { error ->
                runOnUiThread {
                    toast(error.message ?: "服务器课件列表加载失败")
                    showCoursewareSourceScreen()
                }
            }
        }.start()
    }

    private fun showCoursewareListLoadingScreen() {
        currentScreen = Screen.Courseware
        coursewareSubScreen = CoursewareSubScreen.ListLoading
        val isLandscape = resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE

        statusText = bodyText("正在加载服务器暂存课件...").apply {
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                topMargin = dp(if (isLandscape) 12 else 24)
            }
        }

        if (isLandscape) {
            val root = landscapeRoot().apply {
                setPadding(dp(24), dp(16), dp(24), dp(16))
                gravity = Gravity.CENTER
            }
            val leftPanel = baseColumn().apply {
                gravity = Gravity.CENTER
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                    marginEnd = dp(24)
                }
            }
            leftPanel.addView(titleText("服务器课件", 22f))
            leftPanel.addView(versionLabel())

            val rightPanel = baseColumn().apply {
                gravity = Gravity.CENTER
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            rightPanel.addView(statusText)

            root.addView(leftPanel)
            root.addView(rightPanel)
            setContentView(root)
        } else {
            val root = baseColumn().apply {
                setPadding(dp(28), dp(32), dp(28), dp(32))
            }
            root.addView(titleText("服务器课件", 28f))
            root.addView(statusText)
            root.addView(versionLabel())
            setContentView(root)
        }
    }

    private fun showServerCoursewareList(items: List<StoredCoursewareItem>) {
        currentScreen = Screen.Courseware
        coursewareSubScreen = CoursewareSubScreen.ServerList
        val isLandscape = resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE

        val uploadBtn = primaryButton("本地上传").apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(58)
            ).apply {
                topMargin = dp(16)
            }
            setOnClickListener {
                launchCoursewarePicker()
            }
        }
        val backBtn = secondaryButton("返回").apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(58)
            ).apply {
                topMargin = dp(12)
            }
            setOnClickListener {
                showCoursewareSourceScreen()
            }
        }

        if (isLandscape) {
            // 横屏：左侧列表，右侧按钮
            val root = landscapeRoot().apply {
                setPadding(dp(24), dp(16), dp(24), dp(16))
            }
            val leftPanel = baseColumn().apply {
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f).apply {
                    marginEnd = dp(20)
                }
            }
            leftPanel.addView(titleText("服务器课件", 22f))

            if (items.isEmpty()) {
                leftPanel.addView(bodyText("服务器还没有暂存课件").apply {
                    gravity = Gravity.CENTER
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    ).apply { topMargin = dp(24) }
                })
            } else {
                val listColumn = LinearLayout(this).apply {
                    orientation = LinearLayout.VERTICAL
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    )
                }
                items.forEachIndexed { index, item ->
                    val row = LinearLayout(this).apply {
                        orientation = LinearLayout.HORIZONTAL
                        gravity = Gravity.CENTER_VERTICAL
                        layoutParams = LinearLayout.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.WRAP_CONTENT
                        ).apply {
                            if (index > 0) topMargin = dp(4)
                        }
                    }
                    row.addView(secondaryButton("${item.title} ${coursewareFormatLabel(item)}  ${formatCoursewareSize(item.size)}").apply {
                        maxLines = 2
                        setSingleLine(false)
                        ellipsize = TextUtils.TruncateAt.END
                        layoutParams = LinearLayout.LayoutParams(
                            0,
                            ViewGroup.LayoutParams.WRAP_CONTENT,
                            1f
                        ).apply { marginEnd = dp(4) }
                        setOnClickListener { openStoredCourseware(item) }
                    })
                    row.addView(deleteButton("删除").apply {
                        setOnClickListener { confirmDeleteServerCourseware(item) }
                    })
                    listColumn.addView(row)
                }
                leftPanel.addView(ScrollView(this).apply {
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        0,
                        1f
                    ).apply { topMargin = dp(16) }
                    addView(listColumn)
                })
            }

            val rightPanel = baseColumn().apply {
                gravity = Gravity.CENTER
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                    marginStart = dp(20)
                }
            }
            rightPanel.addView(uploadBtn)
            rightPanel.addView(backBtn)
            rightPanel.addView(versionLabel())

            root.addView(leftPanel)
            root.addView(rightPanel)
            setContentView(root)
        } else {
            // 竖屏
            val root = baseColumn().apply {
                setPadding(dp(28), dp(32), dp(28), dp(32))
            }
            root.addView(titleText("服务器课件", 28f))

            if (items.isEmpty()) {
                root.addView(bodyText("服务器还没有暂存课件").apply {
                    gravity = Gravity.CENTER
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    ).apply { topMargin = dp(24) }
                })
            } else {
                val listColumn = LinearLayout(this).apply {
                    orientation = LinearLayout.VERTICAL
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    )
                }
                items.forEachIndexed { index, item ->
                    val row = LinearLayout(this).apply {
                        orientation = LinearLayout.HORIZONTAL
                        gravity = Gravity.CENTER_VERTICAL
                        layoutParams = LinearLayout.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.WRAP_CONTENT
                        ).apply {
                            if (index > 0) topMargin = dp(4)
                        }
                    }
                    row.addView(secondaryButton("${item.title} ${coursewareFormatLabel(item)}  ${formatCoursewareSize(item.size)}").apply {
                        maxLines = 2
                        setSingleLine(false)
                        ellipsize = TextUtils.TruncateAt.END
                        layoutParams = LinearLayout.LayoutParams(
                            0,
                            ViewGroup.LayoutParams.WRAP_CONTENT,
                            1f
                        ).apply { marginEnd = dp(4) }
                        setOnClickListener { openStoredCourseware(item) }
                    })
                    row.addView(deleteButton("删除").apply {
                        setOnClickListener { confirmDeleteServerCourseware(item) }
                    })
                    listColumn.addView(row)
                }
                root.addView(ScrollView(this).apply {
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        0,
                        1f
                    ).apply { topMargin = dp(16) }
                    addView(listColumn)
                })
            }

            root.addView(uploadBtn)
            root.addView(backBtn)
            root.addView(versionLabel())
            setContentView(root)
        }
    }

    private fun fetchServerCoursewareListBlocking(): List<StoredCoursewareItem> {
        val request = Request.Builder()
            .url("${BuildConfig.SERVER_BASE_URL.trimEnd('/')}/api/courseware")
            .get()
            .also { addAuthHeader(it) }
            .build()
        coursewareHttpClient.newCall(request).execute().use { response ->
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                throw IOException("服务器课件列表加载失败：HTTP ${response.code}")
            }
            val items = JSONObject(body).optJSONArray("items") ?: JSONArray()
            return (0 until items.length()).mapNotNull { index ->
                val item = items.optJSONObject(index) ?: return@mapNotNull null
                val id = item.optString("id")
                val url = item.optString("url")
                if (id.isBlank() || url.isBlank()) {
                    return@mapNotNull null
                }
                val originalUrl = item.optString("originalUrl", "")
                StoredCoursewareItem(
                    id = id,
                    title = item.optString("title", "课件"),
                    url = url,
                    size = item.optLong("size", 0L),
                    originalUrl = originalUrl
                )
            }
        }
    }

    private fun confirmDeleteServerCourseware(item: StoredCoursewareItem) {
        AlertDialog.Builder(this)
            .setTitle("删除服务器课件")
            .setMessage("确定删除“${item.title}”吗？")
            .setNegativeButton("取消", null)
            .setPositiveButton("删除") { _, _ ->
                deleteServerCourseware(item)
            }
            .show()
    }

    private fun deleteServerCourseware(item: StoredCoursewareItem) {
        Thread {
            runCatching {
                deleteServerCoursewareBlocking(item)
            }.onSuccess {
                runOnUiThread {
                    toast("服务器课件已删除")
                    loadServerCoursewareList()
                }
            }.onFailure { error ->
                runOnUiThread {
                    toast(error.message ?: "服务器课件删除失败")
                }
            }
        }.start()
    }

    private fun deleteServerCoursewareBlocking(item: StoredCoursewareItem) {
        val request = Request.Builder()
            .url("${BuildConfig.SERVER_BASE_URL.trimEnd('/')}/api/courseware/${item.id}")
            .delete()
            .also { addAuthHeader(it) }
            .build()
        coursewareHttpClient.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                throw IOException("服务器课件删除失败：HTTP ${response.code}")
            }
        }
    }

    private fun openStoredCourseware(item: StoredCoursewareItem) {
        cancelCoursewareFastSeek()
        coursewareUploadInProgress = false
        coursewarePage = 1
        coursewarePageCount = 1
        coursewareScreen = 1
        coursewareScreenCount = 1
        coursewareTitle = item.title
        coursewareUrl = item.url
        signalingClient?.sendStop()
        signalingClient?.sendCoursewareOpen(item.url, item.title, coursewarePage, coursewareScreen)
        showCoursewareScreen(title = item.title, isUploading = false)
        toast("服务器课件已打开")
    }

    private fun formatCoursewareSize(size: Long): String =
        when {
            size <= 0L -> "大小未知"
            size >= 1024L * 1024L -> "${size / 1024L / 1024L} MB"
            else -> "${(size / 1024L).coerceAtLeast(1L)} KB"
        }

    private fun coursewareFormatLabel(item: StoredCoursewareItem): String {
        // 优先用原始文件扩展名（PPT/DOC 转 PDF 后仍显示原格式）
        val source = if (item.originalUrl.isNotBlank()) item.originalUrl else item.url
        val ext = source.substringAfterLast('.', "").uppercase()
        return if (ext.isNotEmpty()) "[$ext]" else ""
    }

    private fun launchCoursewarePicker() {
        coursewarePickerLauncher.launch("*/*")
    }

    private fun uploadCourseware(uri: Uri) {
        if (!roomJoined || activeRoomCode == null) {
            toast("请先连接教室端")
            return
        }
        cancelCoursewareFastSeek()
        val fileName = displayNameForUri(uri)
        coursewareTitle = fileName
        coursewareUrl = ""
        coursewarePage = 1
        coursewarePageCount = 1
        coursewareScreen = 1
        coursewareScreenCount = 1
        showCoursewareScreen(title = fileName, isUploading = true)

        Thread {
            runCatching {
                uploadCoursewareBlocking(uri, fileName)
            }.onSuccess { result ->
                runOnUiThread {
                    if (currentScreen != Screen.Courseware) {
                        return@runOnUiThread
                    }
                    coursewareUploadInProgress = false
                    coursewarePage = 1
                    coursewarePageCount = 1
                    coursewareScreen = 1
                    coursewareScreenCount = 1
                    coursewareTitle = result.title
                    coursewareUrl = result.url
                    if (roomJoined) {
                        signalingClient?.sendStop()
                        signalingClient?.sendCoursewareOpen(
                            result.url,
                            result.title,
                            coursewarePage,
                            coursewareScreen
                        )
                        toast("课件已打开")
                    } else {
                        reconnectSignalingForCurrentRoom()
                        toast("课件已上传，正在重新连接教室端")
                    }
                    showCoursewareScreen(title = result.title, isUploading = false)
                }
            }.onFailure { error ->
                runOnUiThread {
                    coursewareUploadInProgress = false
                    toast(coursewareUploadErrorMessage(error))
                    showMenuScreen()
                }
            }
        }.start()
    }

    private fun uploadCoursewareBlocking(uri: Uri, fileName: String): CoursewareUploadResult {
        val totalBytes = contentLengthForUri(uri)
        val requestBody = object : RequestBody() {
            override fun contentType() =
                (contentResolver.getType(uri) ?: "application/octet-stream").toMediaTypeOrNull()

            override fun contentLength(): Long = totalBytes

            override fun writeTo(sink: BufferedSink) {
                val input = contentResolver.openInputStream(uri)
                    ?: throw IOException("无法读取所选课件")
                input.use {
                    val buffer = ByteArray(8 * 1024)
                    var uploadedBytes = 0L
                    var lastProgressAt = 0L
                    while (true) {
                        val read = it.read(buffer)
                        if (read == -1) {
                            break
                        }
                        sink.write(buffer, 0, read)
                        uploadedBytes += read
                        val now = System.currentTimeMillis()
                        if (now - lastProgressAt > 300L || uploadedBytes == totalBytes) {
                            lastProgressAt = now
                            updateCoursewareUploadProgress(fileName, uploadedBytes, totalBytes)
                        }
                    }
                }
                updateStatus("$fileName\n上传完成，服务器正在转换/处理...")
            }
        }
        val multipartBody = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart(
                "displayNameBase64",
                Base64.encodeToString(fileName.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
            )
            .addFormDataPart("file", fileName, requestBody)
            .build()
        val request = Request.Builder()
            .url("${BuildConfig.SERVER_BASE_URL.trimEnd('/')}/api/courseware")
            .post(multipartBody)
            .also { addAuthHeader(it) }
            .build()

        coursewareHttpClient.newCall(request).execute().use { response ->
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                val message = runCatching {
                    JSONObject(body).optString("error")
                }.getOrNull().orEmpty()
                throw IOException(message.ifBlank { "课件上传失败：HTTP ${response.code}" })
            }
            val json = JSONObject(body)
            return CoursewareUploadResult(
                title = json.optString("title", fileName),
                url = json.getString("url")
            )
        }
    }

    private fun contentLengthForUri(uri: Uri): Long =
        contentResolver.query(uri, null, null, null, null)?.use { cursor ->
            val index = cursor.getColumnIndex(OpenableColumns.SIZE)
            if (index >= 0 && cursor.moveToFirst()) cursor.getLong(index) else -1L
        } ?: -1L

    private fun updateCoursewareUploadProgress(fileName: String, uploadedBytes: Long, totalBytes: Long) {
        if (totalBytes <= 0L) {
            updateStatus("$fileName\n正在上传：${formatCoursewareSize(uploadedBytes)}")
            return
        }
        val percent = ((uploadedBytes * 100L) / totalBytes).coerceIn(0L, 100L)
        updateStatus(
            "$fileName\n正在上传：$percent% " +
                "(${formatCoursewareSize(uploadedBytes)} / ${formatCoursewareSize(totalBytes)})"
        )
    }

    private fun displayNameForUri(uri: Uri): String {
        contentResolver.query(uri, null, null, null, null)?.use { cursor: Cursor ->
            val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (index >= 0 && cursor.moveToFirst()) {
                return cursor.getString(index) ?: "courseware"
            }
        }
        return uri.lastPathSegment?.substringAfterLast('/') ?: "courseware"
    }

    private fun coursewareUploadErrorMessage(error: Throwable): String {
        val message = error.message.orEmpty()
        val lowerMessage = message.lowercase()
        return when {
            lowerMessage.contains("software caused connection abort") ||
                lowerMessage.contains("connection reset") ||
                lowerMessage.contains("broken pipe") ||
                lowerMessage.contains("timeout") ||
                lowerMessage.contains("failed to connect") ->
                "课件上传连接中断，请确认手机和服务器网络正常后重试"
            message.isNotBlank() -> message
            else -> "课件上传失败"
        }
    }

    private fun showCoursewareScreen(title: String, isUploading: Boolean) {
        currentScreen = Screen.Courseware
        coursewareSubScreen = CoursewareSubScreen.Playback
        coursewareUploadInProgress = isUploading
        val isLandscape = resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE

        statusText = bodyText(
            if (isUploading) {
                "正在上传并转换：$title"
            } else if (!roomJoined) {
                "$title\n正在重新连接教室端..."
            } else {
                coursewareStatusText(title)
            }
        ).apply {
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                topMargin = dp(if (isLandscape) 12 else 24)
            }
        }

        val pageRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(58)
            ).apply {
                topMargin = dp(if (isLandscape) 16 else 32)
            }
        }
        pageRow.addView(secondaryButton("上一屏").apply {
            isEnabled = !isUploading && roomJoined
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f).apply {
                marginEnd = dp(8)
            }
            configureCoursewareNavigationButton(this, -1)
        })
        pageRow.addView(primaryButton("下一屏").apply {
            isEnabled = !isUploading && roomJoined
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f).apply {
                marginStart = dp(8)
            }
            configureCoursewareNavigationButton(this, 1)
        })

        if (isLandscape) {
            // 横屏：左侧标题+状态+版本，右侧翻页按钮+操作按钮
            val root = landscapeRoot().apply {
                setPadding(dp(24), dp(16), dp(24), dp(16))
                gravity = Gravity.CENTER
            }
            val leftPanel = baseColumn().apply {
                gravity = Gravity.CENTER
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                    marginEnd = dp(24)
                }
            }
            leftPanel.addView(titleText("播放课件", 22f))
            leftPanel.addView(statusText)
            leftPanel.addView(versionLabel())

            val rightPanel = baseColumn().apply {
                gravity = Gravity.CENTER
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            rightPanel.addView(pageRow)
            if (isUploading) {
                rightPanel.addView(secondaryButton("返回菜单").apply {
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        dp(58)
                    ).apply { topMargin = dp(16) }
                    setOnClickListener { closeCoursewareAndReturnMenu() }
                })
            } else {
                rightPanel.addView(primaryButton("返回主菜单").apply {
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        dp(58)
                    ).apply { topMargin = dp(16) }
                    setOnClickListener { pauseCoursewareAndReturnMenu() }
                })
                rightPanel.addView(secondaryButton("结束播放").apply {
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        dp(58)
                    ).apply { topMargin = dp(12) }
                    setOnClickListener { closeCoursewareAndReturnMenu() }
                })
            }

            root.addView(leftPanel)
            root.addView(rightPanel)
            setContentView(root)
        } else {
            // 竖屏
            val root = baseColumn().apply {
                setPadding(dp(28), dp(32), dp(28), dp(32))
            }
            root.addView(titleText("播放课件", 28f))
            root.addView(statusText)
            root.addView(pageRow)

            if (isUploading) {
                root.addView(secondaryButton("返回菜单").apply {
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        dp(58)
                    ).apply { topMargin = dp(16) }
                    setOnClickListener { closeCoursewareAndReturnMenu() }
                })
            } else {
                root.addView(primaryButton("返回主菜单").apply {
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        dp(58)
                    ).apply { topMargin = dp(16) }
                    setOnClickListener { pauseCoursewareAndReturnMenu() }
                })
                root.addView(secondaryButton("结束播放").apply {
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        dp(58)
                    ).apply { topMargin = dp(12) }
                    setOnClickListener { closeCoursewareAndReturnMenu() }
                })
            }
            root.addView(versionLabel())
            setContentView(root)
        }
    }

    private fun coursewareStatusText(title: String): String {
        val pageText = "第 $coursewarePage / $coursewarePageCount 页"
        val screenText = if (coursewareScreenCount > 1) {
            "，第 $coursewareScreen / $coursewareScreenCount 屏"
        } else {
            ""
        }
        return "$title\n$pageText$screenText"
    }

    private fun changeCoursewarePage(delta: Int) {
        if (coursewareUploadInProgress) {
            return
        }
        if (!roomJoined) {
            reconnectSignalingForCurrentRoom()
            updateStatus("$coursewareTitle\n正在重新连接教室端...")
            return
        }
        signalingClient?.sendCoursewareNavigate(delta)
        updateStatus("$coursewareTitle\n正在切换...")
    }

    private fun configureCoursewareNavigationButton(button: MaterialButton, delta: Int) {
        button.setOnClickListener {
            if (coursewareFastSeekConsumedClick) {
                coursewareFastSeekConsumedClick = false
                return@setOnClickListener
            }
            changeCoursewarePage(delta)
        }
        button.setOnLongClickListener {
            startCoursewareFastSeek(delta)
            true
        }
        button.setOnTouchListener { _, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_UP,
                MotionEvent.ACTION_CANCEL -> {
                    if (coursewareFastSeekDirection != 0) {
                        finishCoursewareFastSeek()
                        coursewareFastSeekConsumedClick = true
                        true
                    } else {
                        false
                    }
                }
                else -> false
            }
        }
    }

    private fun startCoursewareFastSeek(delta: Int) {
        if (coursewareUploadInProgress) {
            return
        }
        if (!roomJoined) {
            reconnectSignalingForCurrentRoom()
            updateStatus("$coursewareTitle\n正在重新连接教室端...")
            return
        }
        cancelCoursewareFastSeek()
        coursewareFastSeekDirection = if (delta < 0) -1 else 1
        coursewareFastSeekTargetPage = coursewarePage.coerceIn(1, coursewarePageCount.coerceAtLeast(1))
        coursewareFastSeekConsumedClick = false
        stepCoursewareFastSeek()
    }

    private fun stepCoursewareFastSeek() {
        if (coursewareFastSeekDirection == 0) {
            return
        }
        val pageCount = coursewarePageCount.coerceAtLeast(1)
        val step = when {
            coursewareFastSeekTicks >= 45 -> 10
            coursewareFastSeekTicks >= 25 -> 5
            coursewareFastSeekTicks >= 10 -> 2
            else -> 1
        }
        coursewareFastSeekTargetPage = (
            coursewareFastSeekTargetPage + coursewareFastSeekDirection * step
        ).coerceIn(1, pageCount)
        coursewareFastSeekTicks += 1
        updateStatus(
            "$coursewareTitle\n定位到第 $coursewareFastSeekTargetPage / $pageCount 页，松手跳转"
        )

        val runnable = Runnable {
            stepCoursewareFastSeek()
        }
        coursewareFastSeekRunnable = runnable
        statusText?.postDelayed(runnable, 120L)
    }

    private fun finishCoursewareFastSeek() {
        if (coursewareFastSeekDirection == 0) {
            return
        }
        val targetPage = coursewareFastSeekTargetPage
        cancelCoursewareFastSeek()
        if (!roomJoined) {
            reconnectSignalingForCurrentRoom()
            updateStatus("$coursewareTitle\n正在重新连接教室端...")
            return
        }
        if (targetPage == coursewarePage) {
            updateStatus(coursewareStatusText(coursewareTitle))
            return
        }
        signalingClient?.sendCoursewarePage(targetPage)
        updateStatus("$coursewareTitle\n正在跳转到第 $targetPage 页...")
    }

    private fun cancelCoursewareFastSeek() {
        coursewareFastSeekRunnable?.let { runnable ->
            statusText?.removeCallbacks(runnable)
        }
        coursewareFastSeekRunnable = null
        coursewareFastSeekDirection = 0
        coursewareFastSeekTicks = 0
    }

    private fun closeCoursewareAndReturnMenu() {
        cancelCoursewareFastSeek()
        if (!sendCoursewareCloseSignal() && activeRoomCode != null) {
            pendingCoursewareCloseAfterJoin = true
            reconnectSignalingForCurrentRoom()
        }
        coursewareUploadInProgress = false
        coursewarePage = 1
        coursewarePageCount = 1
        coursewareScreen = 1
        coursewareScreenCount = 1
        coursewareTitle = ""
        coursewareUrl = ""
        savedCoursewareState = null
        coursewareSubScreen = CoursewareSubScreen.None
        showMenuScreen()
    }

    private fun pauseCoursewareAndReturnMenu() {
        cancelCoursewareFastSeek()
        coursewareSubScreen = CoursewareSubScreen.None
        savedCoursewareState = CoursewareState(
            title = coursewareTitle,
            url = coursewareUrl,
            page = coursewarePage,
            pageCount = coursewarePageCount,
            screen = coursewareScreen,
            screenCount = coursewareScreenCount
        )
        showMenuScreen()
    }

    private fun sendCoursewareCloseSignal(): Boolean {
        val stopSent = signalingClient?.sendStop() == true
        val closeSent = signalingClient?.sendCoursewareClose() == true
        return closeSent || stopSent
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
                    audioToggleButton?.visibility = View.VISIBLE
                    webRtcClient?.clearImageProjection()
                    sendCurrentDeviceOrientation(force = true)
                    return@setOnClickListener
                }
                launchImagePickerForProjection()
            }
        }
        audioToggleButton = MaterialButton(this).apply {
            text = "🔇"
            textSize = 20f
            contentDescription = "开启麦克风"
            insetTop = 0
            insetBottom = 0
            setBackgroundColor(Color.argb(180, 40, 40, 40))
            strokeColor = ColorStateList.valueOf(Color.argb(120, 255, 255, 255))
            strokeWidth = dp(2)
            cornerRadius = dp(26)
            setPadding(0, 0, 0, 0)
            isEnabled = true
            setOnClickListener {
                val nextEnabled = webRtcClient?.toggleAudio() == true
                updateAudioButton(isEnabled = nextEnabled)
                toast(if (nextEnabled) "麦克风已开启" else "麦克风已静音")
            }
        }
        cameraVersionLabel = versionLabel(onDark = true)
        updateCameraControlsLayout()
        val isLandscape = resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
        root.addView(
            controls,
            controls.layoutParams ?: cameraControlsLayoutParams(isLandscape)
        )
        // 悬浮麦克风图标，根据横竖屏调整位置
        val audioBtn = audioToggleButton!!
        root.addView(
            audioBtn,
            audioButtonLayoutParams(isLandscape)
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

    private fun reconnectSignalingForCurrentRoom(): Boolean {
        val roomCode = activeRoomCode ?: return false
        if (signalReconnectInProgress) {
            return true
        }
        signalReconnectInProgress = true
        roomJoined = false
        signalingClient?.close()
        signalingClient = null
        connectToRoom(roomCode)
        return true
    }

    private fun ensureCameraPermissions(openImagePicker: Boolean = false) {
        openImagePickerAfterPermission = openImagePicker
        val permissions = arrayOf(
            Manifest.permission.CAMERA,
            Manifest.permission.RECORD_AUDIO
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
            signalReconnectInProgress = false
            val shouldResumeCamera = resumeCameraAfterJoin
            val shouldResumeLive = resumeLiveAfterJoin
            resumeCameraAfterJoin = false
            resumeLiveAfterJoin = false
            if (pendingCoursewareCloseAfterJoin) {
                pendingCoursewareCloseAfterJoin = false
                sendCoursewareCloseSignal()
                toast("课件播放已结束")
                showMenuScreen()
                return@runOnUiThread
            }
            if (currentScreen == Screen.Courseware) {
                if (!coursewareUploadInProgress && coursewareUrl.isNotBlank()) {
                    signalingClient?.sendCoursewareOpen(
                        coursewareUrl,
                        coursewareTitle,
                        coursewarePage,
                        coursewareScreen
                    )
                    showCoursewareScreen(title = coursewareTitle, isUploading = false)
                    toast("课件控制已重新连接")
                }
                return@runOnUiThread
            }

            toast("连接成功")

            triggerPendingUploadIfReady()

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
            signalReconnectInProgress = false
            resumeCameraAfterJoin = false
            resumeLiveAfterJoin = false
            pendingCoursewareCloseAfterJoin = false
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
            signalReconnectInProgress = false
            savedCoursewareState = null
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
            signalReconnectInProgress = false
            savedCoursewareState = null
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

    override fun onCoursewareState(state: CoursewareStatePayload) {
        runOnUiThread {
            if (currentScreen != Screen.Courseware) {
                return@runOnUiThread
            }
            coursewarePage = state.page
            coursewarePageCount = state.pageCount
            coursewareScreen = state.screen
            coursewareScreenCount = state.screenCount
            if (coursewareFastSeekDirection == 0) {
                updateStatus(coursewareStatusText(coursewareTitle))
            }
        }
    }

    override fun onSignalError(message: String) {
        runOnUiThread {
            roomJoined = false
            if (
                (currentScreen == Screen.Courseware || currentScreen == Screen.Menu) &&
                activeRoomCode != null &&
                !signalReconnectInProgress
            ) {
                if (coursewareUploadInProgress) {
                    reconnectSignalingForCurrentRoom()
                    return@runOnUiThread
                }
                updateStatus("网络连接中断，正在重新连接教室端...")
                toast("网络连接中断，正在重新连接教室端")
                reconnectSignalingForCurrentRoom()
                return@runOnUiThread
            }
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
        audioToggleButton = null
        cameraControls = null
        cameraVersionLabel = null
        activePresentationMode = PresentationMode.Camera
    }

    private fun returnToMenuFromCamera() {
        releaseCamera()
        showMenuScreen()
    }

    fun updateStatus(message: String) {
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

    private fun updateAudioButton(isEnabled: Boolean) {
        audioToggleButton?.apply {
            text = if (isEnabled) "🎤" else "🔇"
            contentDescription = if (isEnabled) "关闭麦克风" else "开启麦克风"
        }
    }

    private fun audioButtonLayoutParams(isLandscape: Boolean): FrameLayout.LayoutParams =
        FrameLayout.LayoutParams(dp(52), dp(52)).apply {
            if (isLandscape) {
                // 横屏：右侧偏左，避免挡住右侧控制栏
                gravity = Gravity.BOTTOM or Gravity.END
                setMargins(0, 0, dp(100), dp(24))
            } else {
                // 竖屏：右下角调高，避免挡住底部控制按钮
                gravity = Gravity.BOTTOM or Gravity.END
                setMargins(0, 0, dp(20), dp(150))
            }
        }

    private fun updateAudioButtonPosition() {
        val btn = audioToggleButton ?: return
        val isLandscape = resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
        btn.layoutParams = audioButtonLayoutParams(isLandscape)
        btn.requestLayout()
    }

    private fun showSelectedImage(uri: Uri) {
        runCatching {
            webRtcClient?.setFrameLocked(false)
            updateFrameLockButton(isLocked = false, isEnabled = true)
            webRtcClient?.showImage(uri)
        }.onSuccess {
            updateImageCastButton(isProjecting = true)
            audioToggleButton?.visibility = View.GONE
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
            marginEnd = dp(6)
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

    private fun footerLabel(): TextView =
        TextView(this).apply {
            text = "本应用由宁波三中人工智能实验室开发维护"
            textSize = 11f
            gravity = Gravity.CENTER
            setTextColor(
                ContextCompat.getColor(this@MainActivity, R.color.myclass_on_surface)
            )
            alpha = 0.55f
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                topMargin = dp(24)
            }
        }

    private fun baseColumn(): LinearLayout =
        LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(ContextCompat.getColor(this@MainActivity, R.color.myclass_background))
        }

    private fun landscapeRoot(): LinearLayout =
        LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setBackgroundColor(ContextCompat.getColor(this@MainActivity, R.color.myclass_background))
        }

    private fun titleText(textValue: String, size: Float): TextView =
        TextView(this).apply {
            text = textValue
            textSize = size
            typeface = Typeface.DEFAULT_BOLD
            letterSpacing = 0.02f
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
            setTextColor(ContextCompat.getColor(this@MainActivity, R.color.myclass_muted))
        }

    private fun primaryButton(textValue: String): MaterialButton =
        MaterialButton(this).apply {
            text = textValue
            textSize = 15f
            cornerRadius = dp(12)
            elevation = dp(4).toFloat()
        }

    private fun secondaryButton(textValue: String): MaterialButton =
        MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
            text = textValue
            textSize = 15f
            cornerRadius = dp(12)
            strokeWidth = dp(1)
            setStrokeColor(ColorStateList.valueOf(Color.argb(0.3f, 1f, 1f, 1f)))
            setTextColor(ContextCompat.getColor(this@MainActivity, R.color.myclass_on_surface))
        }

    private fun deleteButton(textValue: String): MaterialButton =
        MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
            text = textValue
            textSize = 13f
            setSingleLine(true)
            cornerRadius = dp(8)
            strokeWidth = dp(1)
            setStrokeColor(ColorStateList.valueOf(ContextCompat.getColor(this@MainActivity, R.color.myclass_alert)))
            setTextColor(ContextCompat.getColor(this@MainActivity, R.color.myclass_alert))
            insetTop = 0
            insetBottom = 0
            minHeight = dp(36)
            minimumWidth = dp(56)
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
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
