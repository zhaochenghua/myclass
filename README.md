# MyClass 教师投屏平台

MyClass 是一套面向局域网课堂展示的投屏系统。教师电脑打开网页端，教师手机安装 Android App 后输入网页端显示的 4 位连接码，即可把手机摄像头画面通过 WebRTC 低延迟投到教室大屏。

当前版本重点支持“手机摄像头拍摄试卷、讲义、实验器材并投到大屏讲解”的场景。

## 主要功能

- Android 手机摄像头直播到网页教师端。
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

手机屏幕共享入口目前保留在 App 菜单中，暂未开放。

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
│   └── public/
├── android/
│   └── AndroidStudioProject/
├── scripts/
│   └── copy-apk.js
├── .github/
│   └── workflows/
│       └── build.yml
└── README.md
```

`web/public/myclass.apk` 是 Android 构建后的分发产物，默认不提交到 Git。GitHub Actions 和本地复制脚本会生成这个文件。

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
APP_VERSION=1.1.14-20260620
```

HTTP 和 WebSocket 会检查 `Host` 与 `Origin`，默认只允许 `10.30.13.1`、`localhost`、`127.0.0.1`。请不要把该服务直接暴露到公网。

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
3. 教师手机扫码安装 App。
4. 打开 App，输入大屏上的 4 位连接码。
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

当前版本暂未开放。Android App 中已经保留入口，后续可基于 Android MediaProjection 增加屏幕采集，并复用现有 WebRTC 信令链路。
