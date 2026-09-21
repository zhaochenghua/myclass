# PPT 出现/消失状态展开

## 选择结论与实测对比

采用 ExpandAnimations 的可见性展开逻辑，继续让 LibreOffice 解析和渲染
PPT/PPTX。它不是新的 Office 渲染器，而是普通 PDF 导出之前的补充步骤。

2026-09-21，在 Ubuntu 22.04、LibreOffice 25.8.7.3、Node 22.19.0 上，
使用隔离目录、独立 Office 配置和虚构测试账号运行对照测试：

| 同一份 10 页测试课件 | LibreOffice 直接导出 PDF | ExpandAnimations + LibreOffice |
| --- | --- | --- |
| 输出页数 | 10 | 23 |
| 出现动画首次点击前隐藏 | 否 | 是 |
| 点击后消失 | 没有对应状态 | 是 |
| 出现、消失、再次出现 | 没有对应状态 | 是 |
| 同时出现、随后出现 | 没有对应状态 | 按点击组保留最终状态 |
| 逐段文字、第一段消失而第二段保留 | 没有对应状态 | 是 |
| 图片出现/消失、整个组合对象出现 | 没有对应状态 | 是 |
| 无动画页 | 1 页 | 1 页 |

对 PPTX 和二进制 PPT 分别验证了全部 23 页文字状态；图片使用 Poppler
实际渲染进行像素对比。测试还覆盖真正的鉴权上传、PDF 下载、原文件完整性、
重复上传缓存，以及坏文件和状态数量上限。

一次同机对照，普通导出约 2.5 秒，展开导出约 3.9 秒；这只是小样例的观测值，
不是大课件性能保证。Linux 全套 37 项测试通过，浏览器中实际点击翻页也确认了
隐藏、出现、消失状态。23 页渲染图已做目视检查。

输入由可复现的 ODF 样例经 LibreOffice 导出为 PPT/PPTX，并非大量真实教师
课件的兼容性认证。PowerPoint/WPS 生成的复杂文件仍应在上线前用实际课件试用。
LibreOffice 的原生动画播放能力与其普通 PDF 导出能力不能混为一谈：前者可以
播放动画，后者在本次实测中不会自动按点击拆页。保持原来的 PDF.js 播放器，
不需要在用户浏览器中运行 Office 动画或引入完整 Office 编辑器。

## 功能边界

- 支持主动画序列中普通对象、图片、整个组合对象和段落的出现/消失。
- 这里的“出现/消失”仅指 **visibility 切换类**效果。淡入、飞入、浮入、擦除等基于
  透明度或位移的入场/退场效果不在支持范围内：它们不会被展开，而且对应对象会从
  该页的初始状态就可见（不会等到点击），等于提前显示内容。实测确认
  `unsupportedSlides` 会记录这类幻灯片，但客户端目前不展示该字段。
- 一次点击关联的“同时/随后”效果合并为一个静态结束状态，不逐帧展示移动过程。
- 保留点击前的初始状态；隐藏幻灯片不输出。自动启动动画可能形成额外初始状态。
- 不处理强调、运动路径、视频播放、点击特定形状的交互触发器、任意分支或循环。
  这些不是 PowerPoint 放映的完整替代。检测到的主序列不支持效果数量记录在
  `conversion.unsupportedSlides` 中；其属性变化不会展开。
- Android、iPhone/iPad 网页端和投屏大屏显示原始 PPT 页码及总页数。
- “下一屏/上一屏”推进或回退一个动画状态；输入页码跳到该原始页的初始状态。
- 隐藏幻灯片保留原始编号但不播放；跳转到隐藏页会明确提示，不跳到别的页。
- 内部 PDF 页码、同步消息和标注仍按状态独立保存；普通 PDF 的页码不变。
- 字体、公式、图表和排版保真度由 LibreOffice 及服务器字体决定。

## 部署

需同时更新服务端、网页（含 `web/ios/js/coursewarePages.mjs` 与 iOS 网页端）和 Android APK。
旧客户端仍可播放，但可能把动画状态数显示成页数。部署前备份整个课件目录和 `server/data`。
至少包含 `server/server.js`、`server/coursewareStore.js`、
`server/expandAnimations.js` 和完整的 `server/vendor/expand-animations/`。
保留第三方源码、LICENSE 和 README。

Linux 运行依赖：

```bash
sudo apt-get install libreoffice-impress fonts-noto-cjk
```

默认 `PPT_ANIMATION_MODE=expand`，新上传 PPT/PPTX 展开后输出 PDF；
PDF、Word、图片和视频仍走原有路径。无需安装全局 OXT 扩展，也无需降低 Office
宏安全设置。每次转换在独立临时目录生成应用宏和 LibreOffice 用户配置，
先初始化配置，再运行宏；读取上传文档时禁止执行其宏和更新外部链接。

```text
PPT_ANIMATION_MODE=expand
PPT_ANIMATION_TIMEOUT_MS=180000
PPT_ANIMATION_MAX_STATES=500
LIBREOFFICE_PATH=/usr/bin/libreoffice
```

转换串行执行，避免同时占用大量内存。超时终止本任务的 Office 进程组并清理
临时目录；不终止其他 Office 会话。展开失败会明确报错，不悄悄退回缺失步骤的
静态 PDF。反向代理上传超时也必须覆盖转换耗时，否则课件会被代理判为超时（504），
而服务端仍在转换并最终入库。nginx 需显式配置，默认 `proxy_read_timeout` 只有 60s：

```nginx
proxy_read_timeout 300s;
proxy_send_timeout 300s;
```

内容池使用 `expand-animations-v2` 转换版本隔离旧缓存。同一版本的重复上传
复用结果；旧课件及 URL 不被修改。要让旧 PPT 使用新功能，重新上传即可。
不同转换版本目前独立保存原文件，可能额外占用空间。最后一个同版本引用删除
后才清理该版本的内容池。

## 回滚

最快方式：设置 `PPT_ANIMATION_MODE=static` 并重启 Node，后续上传恢复原有
LibreOffice 直接转 PDF。已经展开的课件仍可正常播放，原始 PPT 保持可下载。

代码回滚使用对应 Git 提交的 `git revert <提交号>`，避免覆盖其他改动。
不要用旧版 `coursewareStore.js` 直接管理新的带版本内容池：它不认识新存储键。
建议优先用环境变量回退，保留新版存储模块。

## 验证命令

```bash
cd server
npm test
# 在已装 LibreOffice 和 Poppler 的 Linux 上执行真实转换及 HTTP 测试：
RUN_LIBREOFFICE_TESTS=1 npm test
```

常规测试不依赖 Office，会显式跳过真实转换测试；Linux CI 会安装依赖并强制运行。
测试的服务端和课件数据均在临时目录，绝不读写线上账号或课件。

上游：[ExpandAnimations](https://github.com/monperrus/ExpandAnimations)，
固定到 `77fb4c592676ef6435a05ddeef726bb5abf4ee47`，LGPL-3.0-or-later。
本地修正了上游隐藏一个段落时误清空后续段落的问题；完整改动记录见 vendor README。

## 原始页码协议

转换元数据包含 `slideCount`（含隐藏页的原始总页数）、`stateCount` 和
`statePages`（每个 PDF 状态对应的原始页码）。例如 `[1,2,2,3,3]` 表示第二页
和第三页各有两个状态。映射随上传/列表返回，也可通过 PDF 地址追加 `.metadata`
读取；该公开接口只返回当前文件的转换元数据，不返回教师信息或课件列表。
客户端校验映射长度与 PDF 页数一致，保持信令 `page/pageCount` 为物理状态编号，
显示和用户跳转才转换为原始页码；断线重连重新加载同一份映射。
旧版静态或 v1 展开的已上传文件不会自动改写，需重新上传原 PPT 获取映射。

2026-09-21 页码集成验收：Linux 37 项测试全部通过。Android 16 模拟器增量构建、
安装并连接隔离大屏，验证了第 2 页出现前后仍为 2/10、跳到第 5 页初始状态、
音量键推进出现/消失时仍为 5/10、返回菜单续播及普通 PDF；应用无崩溃或 ANR。
iPhone/iPad 网页控制端在桌面浏览器中验证了预览、原始第 5 页跳转与下一屏保持
5/10（未替代真机 Safari 测试）。同时修正了该端 PDF 模块相对路径解析错误。
