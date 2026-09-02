# MyClass 教师投屏平台

MyClass 是一套面向局域网课堂展示的投屏系统。教师电脑打开网页端，教师手机安装 Android App、或 iPhone 直接用 Safari 打开网页版，输入网页端显示的 4 位连接码，即可把手机摄像头画面通过 WebRTC 低延迟投到教室大屏。

当前版本重点支持“手机摄像头拍摄试卷、讲义、实验器材并投到大屏讲解”的场景。iPhone 用户无需安装 App，把网页版“添加到主屏幕”即可像原生应用一样使用。

## 主要功能

- Android 手机摄像头直播到网页教师端。
- iPhone / iPad 通过浏览器网页版直播到网页教师端（无需上架 App Store）。
- 支持前置/后置摄像头切换。
- 支持 1080p 级别高清采集，尽量保持摄像头原始比例。
- 支持后置摄像头补光灯。
- 支持双指缩放、点击对焦。
- 支持锁定画面，方便针对某一帧详细讲解。
- 锁定帧支持双指放大、单指拖动画面平移，手机端和网页端同步生效。
- 横竖屏自适应：竖屏保持摄像头原始比例，横屏网页端全屏裁切显示。
- App 进入后台后恢复前台会重新连接教师端并恢复直播。
- 网络不佳时优先显示最新帧，避免积压旧帧导致页面卡死。
- 网页端支持画笔标注，可用手指、触控笔、教鞭或鼠标圈画。
- 网页端画笔支持撤销和清空。
- 标注绑定到视频内容坐标；手机端移动锁定画面时，网页端标注会跟随画面移动，避免错位。
- iPhone 网页版支持“添加到主屏幕”全屏运行、离线打开界面、课件上传与播放。

手机屏幕共享入口目前保留在 Android App 菜单中，暂未开放；iPhone 网页版不提供屏幕共享。

## 目录结构

```text
myclass/
├── server/
│   ├── server.js
│   ├── websocket.js
│   ├── roomManager.js
│   └── package.json
├── web/
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   ├── public/
│   └── ios/            # iPhone 网页版（PWA）
│       ├── index.html
│       ├── style.css
│       ├── sw.js
│       ├── manifest.webmanifest
│       └── js/
├── android/
│   └── AndroidStudioProject/
├── windows/
│   ├── main.js
│   ├── preload.js
│   └── renderer/
├── scripts/
│   ├── copy-apk.js
│   ├── generate-selfsigned-cert.sh
│   └── generate-ios-icons.py
├── .github/
│   └── workflows/
│       └── build.yml
└── README.md
```

## Windows 电脑投屏客户端

Windows 端客户端位于 `windows/`，使用 Electron 将指定显示器或单个应用窗口的画面和 Windows 系统输出声音通过现有 WebRTC 链路投到教室大屏。它复用当前连接码和 `/myclass/ws` 信令，不需要新增媒体中转服务；关闭窗口后程序继续驻留系统托盘。客户端设置中可以选择投屏时是否同时在笔记本上播放声音。

开发、打包和系统声音兼容性说明见 [`windows/README.md`](windows/README.md)。快速启动：

```powershell
cd windows
npm install
npm start
```

`web/public/myclass.apk` 是 Android 构建后的分发产物，默认不提交到 Git。Windows 安装包发布为 `web/public/myclass-windows.exe`，服务端页面会显示对应的下载链接。

## 服务端部署

默认访问地址：

```text
http://10.30.13.1/myclass/
```

安装 Node.js 20 或更高版本，然后执行：

```bash
cd server
npm install
npm start
```

默认服务监听 `0.0.0.0:3000`，页面路径是 `/myclass/`。如果服务端要直接使用 80 端口：

```bash
PORT=80 npm start
```

也可以放在 Nginx 后面反向代理到 Node 的 3000 端口，但需要同时代理 WebSocket：

```nginx
location /myclass/ {
    proxy_pass http://127.0.0.1:3000/myclass/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

常用环境变量：

```text
SERVER_IP=10.30.13.1
HOST=0.0.0.0
PORT=3000
PATH_PREFIX=/myclass
PUBLIC_BASE_URL=http://10.30.13.1/myclass
ALLOWED_HOSTS=10.30.13.1,localhost,127.0.0.1
ROOM_TTL_MS=7200000
APP_VERSION=1.1.28-20260622
HTTPS_PORT=443
TLS_KEY=server/data/tls/server.key
TLS_CERT=server/data/tls/server.crt
IOS_BASE_URL=https://10.30.13.1/myclass
IOS_VERSION=1.0.0
LIBREOFFICE_PATH=C:\Program Files\LibreOffice\program\soffice.exe
COURSEWARE_MAX_BYTES=2147483648
COURSEWARE_REQUEST_TIMEOUT_MS=1800000
COURSEWARE_CONVERT_TIMEOUT_MS=120000
```

“播放课件”功能由手机 App 选择本机 PDF/PPT/PPTX 并上传到服务端。PDF 会直接发布，PPT/PPTX 会通过 LibreOffice headless 转换为 PDF 后在网页端自动打开，并写入服务器暂存课件列表；App 后续可直接选择或删除服务器课件，避免大课件重复上传。网页端使用本地 PDF.js 单页渲染课件；横向幻灯片整页显示，竖向 A4 文档按屏幕宽度铺满并支持上一屏/下一屏、长按快速定位页码与手型拖拽。画笔标注绑定在课件页坐标上，会跟随拖动画面移动。服务器需要安装 LibreOffice；如果不在默认路径，请设置 `LIBREOFFICE_PATH` 或 `SOFFICE_PATH`。

HTTP 和 WebSocket 会检查 `Host` 与 `Origin`，默认只允许 `10.30.13.1`、`localhost`、`127.0.0.1`。请不要把该服务直接暴露到公网。

HTTPS 与 HTTP 由同一个 `RoomManager` 管理，因此大屏端走 http、iPhone 走 https 时连接码依然匹配，两种协议可以混用。

## iPhone 网页版（iOS）

iOS 浏览器无法实现屏幕共享，且上架 App Store 成本较高，所以 iPhone / iPad 直接提供网页版：
用 Safari 打开 `https://10.30.13.1/myclass/ios/`，点底部分享按钮 → “添加到主屏幕”，
桌面会生成图标，之后点开即全屏运行，没有地址栏，体验与原生 App 一致。

### 为什么必须用 https

iOS Safari 只在**安全上下文**中开放摄像头，在 `http://10.30.13.1/...` 下调用 `getUserMedia` 会直接失败。
因此服务端需要额外监听一个 HTTPS 端口；教室大屏仍可继续使用原来的 http 地址，两者共用同一套连接码。

### 部署步骤

**方式一（推荐，已有 Nginx/OpenResty 反代）：** 本项目部署在 1Panel OpenResty 后，
`proxy/myclass.conf` 已把 `/myclass/` 反代到 Node 的 3000 端口（含 WebSocket 头），
443 上已有 TLS。此时 **Node 不需要监听 HTTPS**，直接用现成入口：

1. 确认 `server/data/versions.json` 里有 `iosVersion` 字段（没有则补上）。
2. 用新版代码重启 Node 服务（改代码后需重启）：

```bash
cd server
# 停掉旧进程后：
nohup node server.js > /home/zch/myclass-server.log 2>&1 &
```

   服务端 `IOS_BASE_URL` 默认回退为 `https://<SERVER_IP>/myclass`，反代可达，无需额外配置。
   若想用已有 https 域名，可设 `IOS_BASE_URL=https://ai.nbsdszx.cn/myclass`。

3. 教室大屏页面点“iPhone 网页版”按钮，会弹出二维码和使用说明。
4. iPhone 扫码后用 Safari 打开 `https://10.30.13.1/myclass/ios/`，
   出现“此网站的安全证书无效”时点“显示详细信息” → “访问此网站”。
   首次开启摄像头时同样允许一次即可。

**方式二（无反代环境）：** 让 Node 自己监听 HTTPS。

1. 生成自签证书（证书必须带 IP SAN，否则 iOS 校验不通过）：

```bash
SERVER_IP=10.30.13.1 bash scripts/generate-selfsigned-cert.sh
```

   需要域名也能访问时追加 `EXTRA_DNS=ai.nbsdszx.cn`。证书生成在 `server/data/tls/`，已被 `.gitignore` 忽略。

2. 带 HTTPS 端口启动（443 需要 root 权限，普通用户可改用 8443 并设置 `IOS_BASE_URL` 带端口）：

```bash
cd server
HTTPS_PORT=443 PORT=3000 npm start
```

> 如果服务器已有正式证书（例如通过域名 https 访问），直接把 `IOS_BASE_URL` 指向该域名即可，
> 不需要自签证书，也不用设 `HTTPS_PORT`。

### 功能对照

| 功能 | Android App | iPhone 网页版 |
| --- | --- | --- |
| 输入连接码连接 | 支持 | 支持 |
| 摄像头直播 | 支持 | 支持 |
| 前后镜头切换 | 支持 | 支持 |
| 双指缩放 | 光学 + 数字变焦 | 数字变焦 1-8x |
| 点击对焦 | 支持 | 部分机型（不支持时仅显示对焦提示框） |
| 补光灯 | 支持 | 不支持（iOS Safari 未开放） |
| 锁定画面 + 放大平移 | 支持 | 支持 |
| 图片投屏 | 支持 | 支持 |
| 课件上传 / 服务器课件 / 翻页 | 支持 | 支持 |
| 手机屏幕共享 | 保留入口，未开放 | 不支持 |

### 实现要点

- 画面统一先绘制到 canvas，再用 `canvas.captureStream()` 推给 WebRTC。
  这样在不依赖任何原生能力的前提下也能实现数字变焦、锁定帧和静态图片推流。
- 锁定画面时停止重绘 canvas，并定时调用 `track.requestFrame()`，保证大屏端画面不中断。
- `teacher.orientation` 上报的裁剪区域采用“已旋转后的显示画面坐标”，
  因此大屏端画笔标注同样会跟随手机端的缩放和平移。
- 信令消息、课件接口、连接码规则与 Android 端完全一致，同一个连接码既能连 Android 手机，也能连 iPhone。
- 画质可在功能菜单中切换（流畅 960×720 / 标准 1280×960 / 高清 1920×1440），下次开始直播时生效。

### 图标更新

图标由脚本生成（需要 Python + Pillow）：

```bash
python3 scripts/generate-ios-icons.py
```

## Android 构建

使用 Android Studio 打开：

```text
android/AndroidStudioProject
```

要求：

- Android Studio 当前稳定版
- JDK 17
- compileSdk 35
- minSdk 26
- targetSdk 35

默认 App 连接地址写入为：

```text
http://10.30.13.1/myclass
```

如需本地调试其他地址，可以在 Gradle 命令中覆盖：

```bash
cd android/AndroidStudioProject
gradle assembleRelease -PMYCLASS_SERVER_URL=http://10.30.13.1/myclass
```

本仓库当前本地构建环境可使用：

```powershell
$env:JAVA_HOME='C:\Program Files\Android\Android Studio\jbr'
& 'C:\Users\zch\Documents\code\myclass\.local\gradle-8.9\bin\gradle.bat' assembleRelease
```

构建后复制 APK 到网页下载目录：

```powershell
Copy-Item -LiteralPath 'android\AndroidStudioProject\app\build\outputs\apk\release\app-release.apk' -Destination 'web\public\myclass.apk' -Force
```

最终下载地址：

```text
http://10.30.13.1/myclass/myclass.apk
```

网页二维码指向该 APK 地址，并通过版本号参数避免安装包缓存混淆。

Windows 安装包下载地址：

```text
http://10.30.13.1/myclass/myclass-windows.exe
```

更新 Windows 客户端时，将新的安装包复制为 `web/public/myclass-windows.exe`，并修改 `server/data/versions.json` 中的 `windowsVersion` 字段更新页面显示的版本号（改完即生效，无需重启服务）。Android 版本号同理，修改 `appVersion` 字段即可；iPhone 网页版修改 `iosVersion` 字段（该值会作为二维码和页面缓存的刷新参数）。

## GitHub Actions

代码 push 到 `main` 分支时，`.github/workflows/build.yml` 会自动执行：

1. 安装 JDK 17。
2. 安装 Android SDK 35。
3. 执行 Gradle 构建。
4. 生成 `app-release.apk`。
5. 复制到 `web/public/myclass.apk`。
6. 上传 GitHub Actions Artifact。

生成的 APK 使用 debug 签名配置生成 release 包，适合局域网内部分发安装。如需正式签名，请在 `android/AndroidStudioProject/app/build.gradle.kts` 中替换 release signingConfig。

## WebRTC 与信令

视频数据路径：

```text
Android App 摄像头 -> WebRTC PeerConnection -> 浏览器 video
```

WebSocket 只做信令和状态同步，不传输视频流。主要流程：

1. 教师网页连接 `/myclass/ws`，服务端生成 4 位连接码并保存到内存。
2. Android 输入连接码后发送 `teacher.join`。
3. 服务端验证连接码，成功后通知浏览器 `teacher.online`。
4. Android 点击开始直播，创建 WebRTC offer，经 WebSocket 发给浏览器。
5. 浏览器创建 answer，经 WebSocket 返回 Android。
6. 双方交换 ICE candidate 后，媒体流直接通过 WebRTC 传输。
7. Android 会通过 `teacher.orientation` 同步横竖屏、摄像头朝向、锁定帧缩放和平移裁剪区域。

局域网内通常不需要 STUN/TURN，配置中 `iceServers` 为空。后续跨网段或复杂网络环境可以在服务端配置接口中增加 ICE 服务器。

## 课堂使用说明

1. 教师电脑打开 `http://10.30.13.1/myclass/`。
2. 大屏显示 4 位连接码和 App 下载二维码。
3. 安卓手机扫码安装 App；iPhone 点大屏上的“iPhone 网页版”按钮扫码，
   用 Safari 打开后“添加到主屏幕”，以后直接点桌面图标进入。
4. 打开 App（或 iPhone 网页版），输入大屏上的 4 位连接码。
5. 进入功能菜单，点击“摄像头直播”。
6. 授权摄像头权限。
7. 在直播界面点击“开始直播”。
8. 大屏自动切换到手机摄像头画面。
9. 可按需切换镜头、打开补光灯、双指缩放、点击对焦。
10. 点击“锁定画面”后，可双指放大锁定帧，并用单指拖动画面查看细节。
11. 在网页端可直接用手指、教鞭或鼠标圈画标注，并使用撤销/清空按钮管理标注。
12. 点击“停止直播”后，大屏恢复等待状态。

连接码有效期默认为 2 小时。当前版本一个连接码只允许一个教师设备；新设备连接后，旧设备会自动下线。

## 常见问题

### 页面打不开

确认 Node 服务已启动，并检查服务器防火墙是否允许访问对应端口。默认开发端口是 `3000`；生产环境如果要使用 `http://10.30.13.1/myclass/`，需要监听 80 端口或配置 Nginx 反向代理。

### 手机提示连接码错误

连接码只保存在服务端内存中，网页刷新会生成新连接码。请以大屏当前显示的 4 位数字为准。

### APK 二维码可以扫，但下载 404

说明 `web/public/myclass.apk` 尚未生成。先完成 Android release 构建，然后复制 APK 到 `web/public/myclass.apk`。

### 页面一直等待教师连接

确认手机和教师电脑在同一局域网或同一 OpenVPN 内网环境，并且 App 的 `SERVER_BASE_URL` 指向 `http://10.30.13.1/myclass`。

### 连接成功但没有画面

检查 Android 摄像头权限是否授权；确认浏览器支持 WebRTC；确认网络没有隔离同一局域网设备之间的 UDP 连接。

### 锁定帧放大后变模糊

锁定帧放大基于当前摄像头采集输出帧，不是基于 WebRTC 压缩后的画面，但也不是传感器完整拍照分辨率。放大倍率过高时会出现数字放大带来的模糊。若未来需要更高清的锁定放大，可增加“锁定时拍摄高分辨率静态图”的方案。

### 网页端标注为什么能跟随手机端平移

网页端笔迹保存为视频内容的归一化坐标。手机端锁定帧缩放或平移时，会把当前可见裁剪区域同步给网页端，网页端按最新裁剪区域重绘标注，因此标注会跟随画面移动。

### 是否支持手机屏幕共享

当前版本暂未开放。Android App 中已经保留入口，后续可基于 Android MediaProjection 增加屏幕采集，并复用现有 WebRTC 信令链路。iPhone 网页版受 iOS 限制无法提供屏幕共享。

### iPhone 提示“无法访问摄像头”

iOS Safari 只在 https 下开放摄像头。请确认：

1. 访问地址以 `https://` 开头，而不是 `http://`；
2. 服务端已用 `HTTPS_PORT` 启动，或 `IOS_BASE_URL` 指向了已有的 https 域名；
3. 首次访问时在证书警告页选择了“访问此网站”；
4. Safari 的相机权限设为“允许”（设置 → Safari 浏览器 → 相机）。

### iPhone 提示证书无效

自签证书属于正常现象，点“显示详细信息” → “访问此网站”即可。
如果希望长期免提示，可在“设置 → 通用 → VPN 与设备管理”中安装并信任该描述文件，
或在“设置 → 通用 → 关于本机 → 证书信任设置”中打开对该证书的完全信任。

### iPhone 网页版没有补光灯

iOS Safari 没有开放摄像头补光灯接口，按钮会显示为“补光灯(不支持)”。
拍摄试卷时建议借助教室灯光，或用另一台手机的手电筒补光。

### 添加到主屏幕后界面打不开

主屏幕图标依赖 Service Worker 缓存，而 Service Worker 同样只在 https 下注册。
请确认是通过 https 打开的页面；之后重新添加一次即可。
