# iOS 锁屏恢复与统一视口协议

- 信令重连后保留摄像头、课件和图片投屏页面，恢复当前课件页码、缩放与滚动进度。摄像头轨道结束或被系统暂停时重新采集，保留锁定帧；预览不会自动开始投屏。
- 回到前台通过应用层 ping 检查 Safari 残留的半开 WebSocket，4 秒内未响应则重建并加入原课堂。过期连接的迟到回调不会清除新连接。
- 未连接课堂时，从课件管理返回连接页；已连接时返回功能菜单。
- 手机/平板使用现有 `courseware.image.viewport` 控制大屏，字段沿用 Android 的 `scale/centerX/centerY/rotation/page/progress`。
- 大屏 PDF 课件使用现有 `viewer.courseware.viewport` 回传 `width/height/left/top/right/bottom/url/page/presentationRevision`。iOS 与 Android 一样显示黄色可视范围框，不强制改变手机自身缩放，接收更新不回发。
- 范围框沿用 Android `MainActivity.refreshCoursewareViewportOverlay` 的阈值：本地可视宽或高比大屏多 0.08，或本地可视面积超过大屏 1.12 倍才显示。校验几何范围、URL 和页码；大屏宽高比也用于逐屏滚动计算。
- 对齐近期 Android 1.9.4（`e3a5eb1`）的 `ZoomableImageView`：整页显示时单指纵向拖动控制大屏可视范围，开始真实拖动时才采纳大屏进度，回包不覆盖正在进行的手势；剩余可滚动内容不足一屏时直接翻页。
- Android 协议参考：`android/AndroidStudioProject/app/src/main/java/cn/edu/nb3/myclass/SignalingClient.kt`、`MainActivity.kt`、`CoursewareViewportOverlay.kt`。图片和直播的大屏本地缩放保持现有逻辑，不回控手机源画面。
- 不新增消息类型、能力协商或服务端逻辑；Android 和大屏代码保持原样。本次只需发布 Web 静态资源，已更新 iOS 入口模块、样式和 Service Worker 缓存标识，无需安卓发版。

## 验证

```powershell
cd server
npm test
cd ..
node scripts/test-ios-resume-viewport.cjs
node scripts/test-handwriting-pinch.cjs
```

浏览器测试依赖 Playwright 和 Edge，使用隔离服务器、测试账号及模拟摄像头。覆盖 390×844 手机、1024×1366 平板，PDF 范围框映射、整页拖动控制大屏、不足一屏直接翻页、错误文件/页码过滤、阈值隐藏、手机控制大屏缩放、断线重连、结束摄像头轨道后的恢复、锁定帧保留和未连接时的菜单返回。截图在系统临时目录 `myclass-ios-resume-viewport-proof`。

本机浏览器模拟后台和断线，不能替代真实 iPhone/iPad Safari 或主屏幕 PWA 的系统锁屏验证。真机需确认解锁后停留在原投屏页、摄像头自动恢复、课件页码及缩放不变。

## Apple Pencil 笔锋

当前画笔采用固定线宽，尚无压感笔锋。可以增加压力、速度与起收笔渐变，并在 iOS、大屏绘制和笔记保存中保留每个点的宽度，使投屏与重开笔记后的效果一致。压感依赖笔的型号；Apple Pencil USB-C 不提供压力感应，可用书写速度模拟粗细变化。该能力不包含在本次修复中。
