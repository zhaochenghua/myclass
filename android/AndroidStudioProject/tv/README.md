# MyClass 大屏端

独立的原生 Android 电视接收端，包名 `cn.edu.nb3.myclass.tv`，默认连接
`https://sz.imst.xyz/myclass/`，与手机发送端可同时安装。最低 Android 5.0（API 21），
APK 包含 `armeabi-v7a`、`arm64-v8a`、`x86`、`x86_64`，兼容常见 32 位老电视和电视盒子。
Android 4.4 及更早版本不支持。本应用不依赖电视的浏览器或系统 WebView。

## 使用

安装 `tv/build/outputs/apk/release/tv-release.apk`，从电视桌面打开“MyClass 大屏”。
手机或 Windows 发送端输入电视显示的四位连接码。

首页同时提供两种控制入口二维码：Windows 扫描后下载 `myclass-windows.exe`，手机/平板扫描后打开 iOS 控制页。
二维码使用稳定地址，不绑定当前版本号；服务端更新客户端后无需重新打包电视端。
教师手机断联时，电视右上角会保留当前连接码，方便教师直接重新连接；恢复连接后自动隐藏。

- 摄像头、电脑屏幕：原生 WebRTC 接收，保持画面比例，接收发送端声音。
- PDF 和服务端转换后的 PPT/PPTX/Word：逐页渲染；纵向文档逐屏阅读，支持手机端翻页、缩放、旋转和标注。
- 图片：原生显示，接受手机端视口与笔迹同步。GIF 显示静态首帧。
- 视频：系统播放器，有声自动播放，接受手机端播放、暂停、跳转、音量和静音控制。
- 教师登录后可直接选择服务器课件；手机教师登录态也会同步至电视。
- 班级和抽学生设置沿用现有 API，支持手机端确认设置、姓名/学号抽取，同一轮不重复。
- 网络中断自动重连，服务端宽限期内恢复原连接码、课件页码、视口与笔迹。
  恢复直播需要发送端响应 `viewer.online` 重新协商。关闭进程或创建新课堂会重新生成连接码。

遥控器方向键移动焦点，确定键执行；展示时上/下/确定键显示工具栏，返回键切换工具栏。
工具栏隐藏时左/右逐屏阅读或翻页，Page Up/Down 翻页，播放/暂停键控制视频，菜单键打开设置。
首页返回键会确认退出。设置中可更换地址、选择班级、设置人数、打开 Wi-Fi 设置、创建新课堂或退出教师账号。
教师凭据只存在内存，不写入本地存储。

电视端不提供手机摄像头采集、文件上传、电子黑板编辑或电视端画笔工具；笔迹来自手机。
ZIP 不在电视解压显示。视频格式取决于设备解码器，老电视优先使用 H.264/AAC MP4、720p。
静态课件下载限制 128 MB，图片最多约 400 万解码像素，PDF 单页最多 1920 × 2560 像素，
最多保留 10 万个笔迹点，避免低内存电视一次载入整个文档。

## 外网直播条件

HTTPS 页面与课件下载走指定外网地址，媒体直播仍通过现有 STUN/TURN。
当前线上 `/api/config` 返回的是 `10.30.13.1:3478`，这是校园内网地址。
跨不同公网网络、对称 NAT 或禁用 UDP 的网络，需要服务器向发送端和接收端返回可公网访问的 TURN，
并正确开放其监听端口与中继端口。仅有 HTTPS 反向代理不能代替 WebRTC 媒体中继。
电视端读取 `/api/config` 的 ICE 配置，不会忽略 HTTPS 证书错误。
Android 5/6 的系统证书与设备解码器差异，仍需在目标实机上验收；过期系统根证书可导致 HTTPS 连接失败。

## 构建与验证

在 `android/AndroidStudioProject` 中执行增量构建，禁止 `clean`：

```powershell
gradle :tv:assembleRelease :tv:lintDebug
& "C:\Users\zch\.local\android-dev\dev.ps1" -Module tv
& "C:\Users\zch\.local\android-dev\ui.ps1"
& "C:\Users\zch\.local\android-dev\shot.ps1"
```

签名复用项目现有 keystore。发布时将电视 APK 单独命名为 `myclass-tv.apk`，不要替换手机的 `myclass.apk`。
构建时也可指定 `-PMYCLASS_TV_SERVER_URL=https://your-host/myclass/`，不影响手机模块默认地址。

自动收发测试位于 `scripts/test-tv-emulator.cjs`，需 Node 20+、服务端依赖、Playwright Chromium、
`pdf-lib`、`sharp`、ffmpeg、PowerShell 7 和在线的 `emulator-5554`；额外 Node 包可通过 `NODE_PATH` 提供。
测试使用临时隔离服务和虚构教师账号，生成 PDF/图片/视频，在模拟器上设置临时服务地址，
验证认证、课件翻页、笔迹恢复、班级抽取、视频远程控制、WebRTC 解码和遥控器焦点。
每个坐标操作先运行 `ui.ps1` 并从 UI XML 获取控件位置；截图始终通过 `shot.ps1`。
测试结束恢复线上服务地址，证据保存在 `tv/build/evidence/`。

```powershell
node scripts/test-tv-emulator.cjs
```

本机仅安装 Android 16 模拟器；Lint 检查 API 21 兼容性，但不等同于 Android 5.0 实机验证。

## 当前验收状态（2026-10-08）

已通过增量构建、签名打包和 `lintDebug`（0 errors）。Android 16 模拟器已安装并启动，
线上 HTTPS 服务生成四位连接码正常；隔离环境教师认证、两页 PDF 下载与第一页像素检查通过，
这些操作没有发现 FATAL EXCEPTION 或应用 ANR。

完整端到端脚本尚未通过：连续三轮停在遥控器翻页回报等待。方向键与 Page Down 注入后，
调试日志均未出现相应 `dispatchKeyEvent` 记录，第一页仍保持显示。
已尝试隐藏工具栏、直接翻页命令、按键与渲染日志诊断，并按项目三轮上限停止模拟器修复。
后续图片视口/笔迹恢复、视频控制、WebRTC 直播、抽学生和遥控器焦点断言尚未执行完成，
不能视为验收通过；APK 应作为待验收测试版使用。

失败证据：`build/evidence/failure.png`、`failure-logcat.txt`；PDF 第一页：`pdf-page-1.png`；
线上服务最终画面：`external-final.png`。脚本结束已恢复线上地址并关闭隔离服务。
