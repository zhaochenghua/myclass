package cn.edu.nb3.myclass

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Bundle
import android.text.InputFilter
import android.text.InputType
import android.view.Gravity
import android.view.ViewGroup
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
        Camera
    }

    private var currentScreen = Screen.Connect
    private var signalingClient: SignalingClient? = null
    private var webRtcClient: CameraWebRtcClient? = null
    private var cameraRenderer: SurfaceViewRenderer? = null
    private var statusText: TextView? = null
    private var startLiveButton: MaterialButton? = null
    private var stopLiveButton: MaterialButton? = null

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { result ->
        if (result.values.all { it }) {
            showCameraScreen()
        } else {
            toast("需要摄像头权限才能直播")
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        onBackPressedDispatcher.addCallback(this, backCallback)
        showConnectScreen()
    }

    override fun onDestroy() {
        releaseCamera()
        signalingClient?.close()
        super.onDestroy()
    }

    private val backCallback = object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
            when (currentScreen) {
                Screen.Camera -> {
                    releaseCamera()
                    showMenuScreen()
                }
                Screen.Menu -> {
                    signalingClient?.close()
                    signalingClient = null
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
        root.addView(secondaryButton("共享手机屏幕（暂未开放）").apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(58)
            ).apply {
                topMargin = dp(16)
            }
            setOnClickListener {
                toast("该功能开发中")
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
        setContentView(root)
    }

    private fun showCameraScreen() {
        currentScreen = Screen.Camera
        val root = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
        }

        val renderer = SurfaceViewRenderer(this)
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
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
        }

        startLiveButton = primaryButton("开始直播").apply {
            layoutParams = LinearLayout.LayoutParams(0, dp(52), 1f).apply {
                marginEnd = dp(8)
            }
            setOnClickListener {
                startLiveButton?.isEnabled = false
                stopLiveButton?.isEnabled = true
                runCatching {
                    webRtcClient?.startLive()
                }.onFailure {
                    stopLiveButton?.isEnabled = false
                    startLiveButton?.isEnabled = true
                    val message = it.message ?: "直播启动失败"
                    updateStatus(message)
                    toast(message)
                }
            }
        }
        stopLiveButton = secondaryButton("停止直播").apply {
            isEnabled = false
            layoutParams = LinearLayout.LayoutParams(0, dp(52), 1f).apply {
                marginStart = dp(8)
            }
            setOnClickListener {
                stopLiveButton?.isEnabled = false
                startLiveButton?.isEnabled = true
                webRtcClient?.stopLive()
                signalingClient?.sendStop()
            }
        }
        val switchButton = secondaryButton("切换前后摄").apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(52)
            ).apply {
                topMargin = dp(12)
            }
            setOnClickListener {
                webRtcClient?.switchCamera()
            }
        }

        row.addView(startLiveButton)
        row.addView(stopLiveButton)
        controls.addView(row)
        controls.addView(switchButton)
        root.addView(
            controls,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM
            )
        )

        setContentView(root)

        runCatching {
            webRtcClient = CameraWebRtcClient(
                context = this,
                renderer = renderer,
                sendOffer = { signalingClient?.sendOffer(it) },
                sendIceCandidate = { signalingClient?.sendIceCandidate(it) },
                updateStatus = { updateStatus(it) }
            )
            webRtcClient?.startPreview()
        }.onFailure {
            updateStatus(it.message ?: "摄像头启动失败")
            toast("摄像头启动失败")
        }
    }

    private fun connectToRoom(code: String) {
        signalingClient?.close()
        signalingClient = SignalingClient(
            serverBaseUrl = BuildConfig.SERVER_BASE_URL,
            roomCode = code,
            callback = this
        ).also { it.connect() }
    }

    private fun ensureCameraPermissions() {
        val permissions = arrayOf(
            Manifest.permission.CAMERA
        )
        val allGranted = permissions.all {
            ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
        }
        if (allGranted) {
            showCameraScreen()
        } else {
            permissionLauncher.launch(permissions)
        }
    }

    override fun onJoinAccepted() {
        runOnUiThread {
            toast("连接成功")
            showMenuScreen()
        }
    }

    override fun onJoinRejected(message: String) {
        runOnUiThread {
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
            toast(message)
            showConnectScreen()
        }
    }

    override fun onServerClosed(message: String) {
        runOnUiThread {
            releaseCamera()
            signalingClient?.close()
            signalingClient = null
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
        webRtcClient?.release()
        webRtcClient = null
        cameraRenderer?.release()
        cameraRenderer = null
        startLiveButton = null
        stopLiveButton = null
    }

    private fun updateStatus(message: String) {
        runOnUiThread {
            statusText?.text = message
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

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    }

    private fun dp(value: Int): Int =
        (value * resources.displayMetrics.density).toInt()
}
