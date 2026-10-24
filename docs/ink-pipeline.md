# 三端手写渲染管线：为什么 pen-test 好看、项目里难看

日期：2026-10-24。范围：大屏（Web）、iPad（iOS 网页版）、Android 手机 / 平板。

## 结论（根因）

`web/pen-test/` 里的两套算法（手工可变线宽、perfect-freehand）本身都没问题；项目里难看，
差别全在「喂给算法的点」和「走哪条分支」：

1. **大屏黑板根本没走 perfect-freehand。** `drawBlackboardStroke` 还在用
   `inkWidths + traceInkOutline`：忽略压力，轮廓是斜接多边形又不做抽稀，采样一密就是
   锯齿、毛刺（旧实现见提交 `8f9b336` 之前的 `web/app.js`）。
2. **无压感输入被降级。** 红外屏 / 手指 / 电容笔的压力恒为 0.5，旧代码用
   `isUnpressuredInk()` 判定后改画等宽二次曲线（`drawStableInk`）——教室里最常见的
   输入方式反而完全没有笔锋。
3. **输入没调理。** pen-test 在采集时做 1.2px 去重 + 0.3/0.7 位置平滑 + 0.55/0.45
   压力平滑；项目是 0.0005 归一化去重 + 零平滑，手抖和采样噪声全部变成轮廓顶点。
4. **速度→线宽几乎不生效。** 旧 `INK_SPEED_REF = 1.75`（图宽/秒）意味着 1600px 画布上
   要 ~2800px/s 才到顶，正常书写只让线宽变化 5%~15%；pen-test 用 1.0 px/ms，变化 3 倍。
5. **宽度口径不一致。** Android 用 `dp × density`（6dp ≈ 16px），大屏 / iPad 用
   4/6/9 CSS px；同一笔在手机上正常，投到 1920 大屏就细 3~5 倍，perfect-freehand 的
   thinning 也就看不出来了。
6. **Android 的 Kotlin 移植不完整。** 缺上游的轮廓抽稀、`lrp` 边缘插值、拐角处理与端帽；
   配合整数毫秒时间戳（重采样后 dt 会被截断成 0）还会把速度快慢判反。

## 现在的管线

`web/inkRenderer.js`（大屏 + iPad 共用）与 `InkRenderer.kt`（Android）逐行对应：

```
原始点 → 像素去重(1.2px) → 位置平滑(0.7) + 压力平滑(0.45)
      → 等距重采样(1px) → 线宽曲线(速度 + 压力 + 起收笔)
      → perfect-freehand 轮廓（大屏/iPad）或左右法线偏移轮廓（Android）
```

- **线宽曲线**：`w = size × 体宽因子 × 起收笔收尖`，`size = 线宽 × 1.25`。
  体宽因子 = 速度项（`1 - 0.3·min(speed/1.0, 1)`，0.7~1）× 压力项
  （压力曲线 0.55~1.55，权重 0.5），再限幅到 `0.78~1.18` 并做 5 点居中平滑——
  一笔之内最多差约 1.5 倍，也不会出现台阶。无压感时压力项自动退出，只用速度。
  起收笔收尖长度取 `size × 2.2`、最细到 `0.55` 倍——像圆珠笔的圆头；
  早期版本是 `3.2 / 0.18`，iPad 上两端会像毛笔一样尖。
- **为什么把粗细压平**：早期速度衰减 0.7（3.3 倍跨度）、压力权重 0.85（0.25~2.2），
  每笔都是起笔粗、行笔细，在手机上像"蝌蚪"；速度又只做单向 EMA，起笔第一段从 0
  爬升，进一步鼓出一个圆头。现在速度改成居中平滑、体宽限幅后再平滑，
  起笔直接取附近几段的平均水平，头尾只靠 `0.55` 的圆头收尖区分。
- **时间戳必须是浮点毫秒**：重采样后相邻点只差 1px，快速书写时 dt < 1ms；
  用整数毫秒或 16ms 兜底会把快写判成慢写，粗细整段反过来（Android 上表现为一串"串珠"）。
- **perfect-freehand 的压力换算**：`radius = size·((1-t)+t·p)/2`，取 `t = 0.95`，
  反解 `p = (w/size - 0.05)/0.95`，让半径正好等于我们算出的 `w/2`，同时保留上游的
  轮廓抽稀与端帽；`simulatePressure` 必须关掉，否则会按采样间距再模拟一次。
- **Android 直接按左右法线偏移生成轮廓**（不用 `PerfectFreehand.kt` 的移植版）：1px
  重采样后偏移边缘天然连续，两端补圆点做端帽。移植版缺抽稀，密集采样会自交成串珠。

## 线宽跟随课件缩放

笔迹要"钉"在课件上：课件放大，线同比变粗；缩小，线同比变细，始终保持与页面的相对比例。
以前线宽是固定的屏幕像素，内容被 transform 放大后线不变，看起来反而越放越细。

| 端 | 缩放来源 | 落点 |
| --- | --- | --- |
| 大屏 | `state.imageView.scale`（PDF / 图片课件的 transform） | `annotationInkScale()` → `width = stroke.width × scale` |
| iPad | `state.cwView.scale`（课件）、`media.queue[i].scale`（图片投屏），由 `getInkScale` 注入 | `AnnotationBoard#inkScale()` |
| Android | `userScale`（`imageDisplayRect()` 已含该倍率） | `drawStroke()` 里 `width = stroke.width × density × userScale` |

板擦、荧光笔、虚线、点划线的 `lineWidth` / `dash` 一起缩放。电子黑板是世界坐标 + 画布
变换，笔迹本来就随缩放变化，不需要额外处理。
回归检查在 `scripts/test-ink-speed.cjs`（放大 2 倍后线宽 ≥1.7 倍）和 Android
`InkSpeedCheck`（1x→2x 实测 12px→24px）。

## 本地渲染与传输分离

本地始终用全部采样点渲染；发给大屏时按像素距离降采样：

| 端 | 本地 | 传输 |
| --- | --- | --- |
| Android | 0.0005 归一化去重后的全部点 | 每 0.0012（1920 宽约 2.3px）一个点，`AnnotationPalette.SYNC_MIN_DISTANCE` |
| iPad | 0.0005 归一化去重后的全部点 | 每 0.0012 一个点，`SYNC_MIN_DISTANCE` |

每批最后一个点一定发送（`finishActiveStroke` / `endActiveStroke` 会补一次收笔点），
接收端用同一套 `InkRenderer` 重采样回 1px 再平滑，所以形状与粗细不因降采样变化，
报文约为原来的 1/4。仪器测试实测：本地 68 点 / 线上 54 点，收笔点一致。

## 兼容旧数据

- 旧笔迹没有 `p`：按 0.5 处理，走速度笔锋。
- 旧笔迹没有 `t`：`widths()` 里 `dt <= 0` 时按 16ms 退化，不会把整笔算成最快或最慢。
- 已有存档不需要迁移：调理与线宽都在渲染时计算，同一份点在任何端都得到同样的结果。

## 验证

| 检查 | 结果 |
| --- | --- |
| `node scripts/test-ink-speed.cjs` | 通过。慢写 4.5px / 快写 4.0px / 起笔 3.5px（1600 宽画布，alpha 覆盖率计） |
| `node scripts/test-infrared-ink.cjs` | 通过。校准合并采样、端点、擦除/撤销/清空；已画前缀在延长笔画时差异 ≤ 2% 像素；密集页面 60000 点仅 1 次活动笔画重绘 |
| `node scripts/test-handwriting-pinch.cjs` | 通过。PDF/图片/直播/锁帧/投屏/黑板，误触、缩放、板擦、远端笔迹与同步 |
| Android `InkSpeedCheck`（模拟器 Pixel_7_API36） | 通过。起笔 8px / 慢写 12px / 快写 10px（一笔内 ≤1.3 倍）；本地 68 点 / 线上 54 点；`ink-check.png` / `ink-demo.png` 可 `adb pull` 复核 |
| `cd server && node --test` | 87 通过 / 1 跳过（`fontStore` 一条用例与本次无关，重跑通过） |

浏览器验证使用本机 Edge + 隔离测试服务，未读取正式用户数据。

## 已知限制

- 大屏 / iPad 与 Android 的轮廓生成器不同（perfect-freehand vs 法线偏移），同一笔的
  边缘有亚像素差异；线宽曲线已经统一，视觉粗细一致。
- 电视原生端（`android/AndroidStudioProject/tv`）仍用自己的 `speedWidths + PerfectFreehand`
  渲染。传输降采样后 1080p 电视上点距约 1.3px，暂时够用；4K 电视若出现折线，可按
  同一套 `InkRenderer` 逻辑再补一次重采样。
- 实体红外框的采样噪声、投影仪刷新与端到端延迟无法用浏览器测试覆盖，仍需现场试写。
- `web/pen-test/` 是本地对比页（已加入 `.gitignore`），不随服务器发布。

