# 大屏课件工具栏抖动修复与验证

日期：2026-10-24。范围：Web 大屏的课件标注工具栏（`.annotation-toolbar`），以及共用的大屏/iPhone 内嵌视频按钮。

## 现象

课件投屏后，底部工具栏的宽度和位置每隔几百毫秒跳一次，看起来像整条工具栏在抖动；静止不操作也会发生。

## 原因

`setupResponsiveToolbars()` 用 `bar.offsetWidth` 反推工具栏的未缩放宽度，再计算 `zoom = 可用宽度 / offsetWidth`。

- 当前 Chromium 的 `offsetWidth` 不受 CSS `zoom` 影响，所以本地和新版浏览器一直正常。
- 部分教室大屏内置浏览器（旧 Chromium / CEF）会把 `zoom` 算进 `offsetWidth`。于是第一次缩放后再次测量会得到“已缩小”的宽度，算出的 `zoom` 变大；下一次再变大，接近 1 后又突然跳回小值，形成持续的“放大—测量—再放大”循环。
- “本页视频”按钮的标签由 `embeddedVideos.mjs` 每 350 ms 轮询刷新一次；即使内容没变也会重写文本/属性，持续触发工具栏的 `MutationObserver`，把上述循环变成每 350 ms 跳一次。
- 同一段轮询和“结束投屏”按钮的 700 ms 定时器还会重复写入相同值，造成无意义的重排/重绘。

## 改动

- 工具栏改用 `getBoundingClientRect().width / 已应用的 zoom` 计算未缩放宽度，不再依赖 `offsetWidth` 的浏览器差异。
- 只有缩放比例变化不小于 0.001 时才写 `style.zoom`，重复测量不会重新排版。
- `embeddedVideos.mjs` 的轮询只在 `hidden` 或标签真正变化时写 DOM。
- `updateScreenEndButton()` 只在 `hidden` 真正变化时写属性。
- 提升大屏、iOS 页面和 Service Worker 的资源版本号，避免旧缓存继续命中旧脚本。

## 验证

| 检查 | 结果 |
| --- | --- |
| `node scripts/test-responsive-toolbar.cjs` | 通过。该测试把 `offsetWidth` 模拟成会随 `zoom` 缩放；修复前 12 次采样得到 `0.91866 → 0.93317 → 0.97338 …`，工具栏持续变宽，修复后 12 次采样只有一个宽度/缩放值，并验证窗口变宽后恢复原始尺寸。 |
| `node scripts/test-web-annotation-toolbar.cjs` | 通过。1920/1280/1024/800/640 下工具栏单行、翻页控件不位移、两个板擦菜单和实际笔宽正常。 |
| `node scripts/test-viewer-toolbar.cjs` | 通过。PDF/视频/ZIP 切换后工具栏与画笔恢复、实际落笔正常。 |
| `node scripts/test-infrared-ink.cjs` | 通过。校准合并采样、密集笔迹、擦除/撤销/清空。 |
| `cd server && node --test` | 87 通过 / 1 跳过 / 0 失败。 |
| `node scripts/test-ios-reader.cjs`、`node scripts/test-courseware-rendering.cjs` | 在 `HEAD` 的独立 worktree 中同样失败（分别为 `cwStage` 为空、渲染失败提示等待超时），与本次改动无关，未纳入本次修复范围。 |

浏览器测试使用本机 Edge 无头模式和隔离测试服务，未读取正式用户数据。

## 部署

只改 `web/**`，服务器 `git pull --ff-only` 后无需重启 Node；大屏和 iOS 页面刷新一次即可加载新版本。
