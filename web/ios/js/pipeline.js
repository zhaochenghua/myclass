// 媒体管道：摄像头/图片 -> canvas -> captureStream -> WebRTC。
//
// 之所以统一走 canvas：iOS Safari 既不提供摄像头变焦（zoom 约束），也不提供补光灯，
// 更没有 Camera2 那种"锁定帧"能力。把画面先绘制到 canvas 再做裁剪/旋转，
// 就能在不依赖任何原生能力的前提下实现与 Android 端一致的效果：
//   - 双指缩放（数字变焦）
//   - 锁定画面（冻结当前帧）+ 锁定帧上继续缩放、单指拖动平移
//   - 图片投屏（把静态图片作为一帧持续推送）
//   - 横竖屏自适应

import { clamp } from './util.js';

export const MAX_ZOOM = 8;
const MIN_ZOOM = 1;

export class MediaPipeline {
  constructor(options = {}) {
    this.canvas = options.canvas;
    this.video = options.video;
    this.image = options.image;
    this.ctx = this.canvas.getContext('2d', { alpha: false });

    this.onTrackChange = options.onTrackChange || (() => {});
    this.onPresentationChange = options.onPresentationChange || (() => {});
    this.onError = options.onError || (() => {});

    this.sourceKind = 'none'; // none | camera | image
    this.facing = 'back';
    this.targetLongEdge = 1280;
    this.fps = 24;

    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.locked = false;
    // 画面方向：默认 0（直接跟随 video 正立画面，竖→横自动切换），
    // 仅在 iOS 个别机型画面角度不对时用"旋转"按钮手动叠加 90°
    this.manualRotation = 0;

    this.stream = null;
    this.track = null;
    this.cameraStream = null;
    this.imageUrl = null;

    this._rafId = null;
    this._keepAliveTimer = null;
    this._manualStreamMode = false;
    this._dirty = true;
  }

  // ---------------- 生命周期 ----------------

  async openCamera({ facing = 'back', width = 1280, height = 960, fps = 24 } = {}) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        '当前环境无法访问摄像头。iOS 要求通过 https 打开本页面，请在 Safari 中访问 https 地址后重试。'
      );
    }

    this.facing = facing;
    this.targetLongEdge = Math.max(width, height);
    this.fps = fps;

    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: facing === 'front' ? 'user' : 'environment' },
        width: { ideal: this.targetLongEdge },
        height: { ideal: Math.min(width, height) },
        frameRate: { ideal: fps, max: 30 }
      }
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.#stopCameraStream();

    this.cameraStream = stream;
    this.video.srcObject = stream;
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;

    try {
      await this.video.play();
    } catch {
      /* iOS 上 muted+playsinline 通常可直接播放，失败也不影响采集 */
    }

    await this.#waitForVideoSize();

    this.sourceKind = 'camera';
    // 新采集的流已按当前屏幕方向正立，清除旧的手动旋转补偿
    this.manualRotation = 0;
    this.resetView({ silent: true });
    this.#start();
    // 方向/尺寸已变化，主动上报一次（切换镜头、旋转重建时大屏端立即同步）
    this.#emitPresentation();
    return this.videoSize();
  }

  async switchCamera() {
    if (this.sourceKind !== 'camera') return;
    await this.openCamera({
      facing: this.facing === 'back' ? 'front' : 'back',
      width: this.targetLongEdge,
      height: Math.round((this.targetLongEdge * 3) / 4),
      fps: this.fps
    });
  }

  /**
   * iOS Safari 摄像头流的方向在 getUserMedia 那一刻就固定了，之后旋转手机画面不会跟随。
   * 屏幕在竖屏/横屏之间切换时调用本方法重新采集一次，
   * 让 iOS 按当前屏幕方向初始化流（Android 端靠 WebRTC CVO 动态旋转，网页版没有这个机制）。
   * 若正在直播，onTrackChange 会用 replaceTrack 无缝切换，无需断开。
   */
  async reopenCamera() {
    if (this.sourceKind !== 'camera') return false;
    const width = this.targetLongEdge;
    const height = Math.round((this.targetLongEdge * 3) / 4);
    await this.openCamera({ facing: this.facing, width, height, fps: this.fps });
    return true;
  }

  async showImage(file) {
    const url = URL.createObjectURL(file);
    try {
      await new Promise((resolve, reject) => {
        this.image.onload = resolve;
        this.image.onerror = () => reject(new Error('无法读取所选图片'));
        this.image.src = url;
      });
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }

    if (this.imageUrl) URL.revokeObjectURL(this.imageUrl);
    this.imageUrl = url;

    this.#stopCameraStream();
    this.sourceKind = 'image';
    this.resetView({ silent: true });
    this.#start();
    return { width: this.image.naturalWidth, height: this.image.naturalHeight };
  }

  clearImage() {
    if (this.imageUrl) {
      URL.revokeObjectURL(this.imageUrl);
      this.imageUrl = null;
    }
    this.image.removeAttribute('src');
    if (this.sourceKind === 'image') {
      this.sourceKind = 'none';
    }
  }

  stop() {
    this.#stopLoop();
    this.#stopKeepAlive();
    this.#stopCameraStream();
    this.clearImage();
    this.sourceKind = 'none';
    if (this.track) {
      try {
        this.track.stop();
      } catch {
        /* ignore */
      }
    }
    this.stream = null;
    this.track = null;
    this._manualStreamMode = false;
  }

  // ---------------- 视图控制 ----------------

  get rotation() {
    return (((this.manualRotation % 360) + 360) % 360);
  }

  rotateOnce() {
    this.manualRotation = (this.manualRotation + 90) % 360;
    this.#resizeCanvas();
    this._dirty = true;
    this.#emitPresentation();
    return this.rotation;
  }

  setLocked(locked) {
    const next = locked === true;
    if (this.locked === next) return this.locked;
    this.locked = next;
    // 出帧模式（自动/手动）切换：静态画面需要手动 requestFrame 驱动
    if (this.track && this.#isStaticContent() !== this._manualStreamMode) {
      this.#rebuildStream();
    }
    this.#updateKeepAlive();
    this.#emitPresentation();
    return this.locked;
  }

  toggleLock() {
    return this.setLocked(!this.locked);
  }

  zoomBy(factor) {
    const next = clamp(this.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    if (Math.abs(next - this.zoom) < 0.0005) return this.zoom;
    this.zoom = next;
    this.#clampPan();
    this._dirty = true;
    this.#emitPresentation();
    return this.zoom;
  }

  /** dx / dy：相对于预览区域宽高的归一化拖动量（手指右移为正） */
  panBy(dx, dy) {
    if (this.zoom <= 1.01) return false;
    const cropWidth = 1 / this.zoom;
    const cropHeight = 1 / this.zoom;
    const prevX = this.panX;
    const prevY = this.panY;
    this.panX -= dx * cropWidth;
    this.panY -= dy * cropHeight;
    this.#clampPan();
    if (Math.abs(this.panX - prevX) < 1e-5 && Math.abs(this.panY - prevY) < 1e-5) {
      return false;
    }
    this._dirty = true;
    this.#emitPresentation();
    return true;
  }

  resetView({ silent = false } = {}) {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this._dirty = true;
    if (!silent) this.#emitPresentation();
  }

  crop() {
    const width = 1 / this.zoom;
    const height = 1 / this.zoom;
    return {
      x: (1 - width) / 2 + this.panX,
      y: (1 - height) / 2 + this.panY,
      width,
      height
    };
  }

  videoSize() {
    return { width: this.video.videoWidth || 0, height: this.video.videoHeight || 0 };
  }

  /** 与 Android DeviceOrientationPayload 字段一致的 orientation 上报。
   *  以"实际输出的画布方向"为准（画布直绘 video 的正立画面，竖→横自动跟随），
   *  而不是设备的物理角度 —— 否则画面与上报方向不一致时大屏端会裁切错误。 */
  presentation() {
    const outputLandscape = (this.canvas.width || 0) >= (this.canvas.height || 1);
    const crop = this.crop();
    return {
      orientation: outputLandscape ? 'landscape' : 'portrait',
      // 画布帧已正立，大屏端只需区分横竖：90=横 0=竖
      rotationDegrees: outputLandscape ? 90 : 0,
      cameraFacing: this.sourceKind === 'camera' ? this.facing : 'unknown',
      frameLocked: this.locked || this.sourceKind === 'image',
      lockedFrameZoomRatio: Number(this.zoom.toFixed(4)),
      lockedFrameCropX: Number(crop.x.toFixed(5)),
      lockedFrameCropY: Number(crop.y.toFixed(5)),
      lockedFrameCropWidth: Number(crop.width.toFixed(5)),
      lockedFrameCropHeight: Number(crop.height.toFixed(5))
    };
  }

  /** iOS Safari 不支持 torch 约束，这里仅探测能力供 UI 提示 */
  torchSupported() {
    const track = this.cameraStream?.getVideoTracks?.()[0];
    if (!track || typeof track.getCapabilities !== 'function') return false;
    try {
      const capabilities = track.getCapabilities();
      return Object.prototype.hasOwnProperty.call(capabilities, 'torch');
    } catch {
      return false;
    }
  }

  async setTorch(enabled) {
    const track = this.cameraStream?.getVideoTracks?.()[0];
    if (!track) return false;
    try {
      await track.applyConstraints({ advanced: [{ torch: enabled }] });
      return true;
    } catch {
      return false;
    }
  }

  /** 点击对焦：iOS 不保证支持，失败时仅保留视觉反馈 */
  async focusAt(normalizedX, normalizedY) {
    const track = this.cameraStream?.getVideoTracks?.()[0];
    if (!track) return false;
    try {
      await track.applyConstraints({
        advanced: [{ focusMode: 'single-shot' }]
      });
      return true;
    } catch {
      return false;
    }
  }

  // ---------------- 内部实现 ----------------

  #start() {
    this.#resizeCanvas();
    // 出帧模式（自动/手动）切换了但 canvas 尺寸没变（resizeCanvas 未重建轨道）时强制重建
    if (this.track && this.#isStaticContent() !== this._manualStreamMode) {
      this.#rebuildStream();
    }
    this.#startLoop();
    this.#updateKeepAlive();
    this._dirty = true;
  }

  #waitForVideoSize() {
    if (this.video.videoWidth > 0 && this.video.videoHeight > 0) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('摄像头画面超时未就绪，请重试'));
      }, 8000);
      const onReady = () => {
        if (this.video.videoWidth > 0 && this.video.videoHeight > 0) {
          cleanup();
          resolve();
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.video.removeEventListener('loadedmetadata', onReady);
        this.video.removeEventListener('resize', onReady);
      };
      this.video.addEventListener('loadedmetadata', onReady);
      this.video.addEventListener('resize', onReady);
    });
  }

  #sourceElement() {
    if (this.sourceKind === 'camera') return this.video;
    if (this.sourceKind === 'image') return this.image;
    return null;
  }

  #sourceSize() {
    if (this.sourceKind === 'camera') {
      return { width: this.video.videoWidth, height: this.video.videoHeight };
    }
    if (this.sourceKind === 'image') {
      return { width: this.image.naturalWidth, height: this.image.naturalHeight };
    }
    return null;
  }

  #resizeCanvas() {
    const size = this.#sourceSize();
    if (!size || !size.width || !size.height) return;

    const quarter = this.rotation;
    const swapped = quarter === 90 || quarter === 270;
    const srcW = swapped ? size.height : size.width;
    const srcH = swapped ? size.width : size.height;

    const longEdge = Math.max(2, this.targetLongEdge);
    const scale = longEdge / Math.max(srcW, srcH);
    let width = Math.round(srcW * scale);
    let height = Math.round(srcH * scale);
    // H.264 编码要求偶数分辨率
    width -= width % 2;
    height -= height % 2;
    width = Math.max(2, width);
    height = Math.max(2, height);

    if (this.canvas.width === width && this.canvas.height === height) {
      // 尺寸没变但轨道已被 stop() 清空（如退出直播后又重新投屏/切到图片），需要重建轨道
      if (!this.track) {
        this.#rebuildStream();
      }
      this._dirty = true;
      return;
    }

    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.#rebuildStream();
    this._dirty = true;
  }

  /** 静态内容（图片 / 锁定帧）需要手动模式出帧；实时摄像头用自动模式 */
  #isStaticContent() {
    return this.sourceKind === 'image' || (this.sourceKind === 'camera' && this.locked);
  }

  #rebuildStream() {
    // 静态画面用 captureStream(0) + 手动 requestFrame（标准做法，Safari 可靠）；
    // 实时摄像头用 captureStream(fps)，由绘制操作自动出帧。
    const manual = this.#isStaticContent();
    this._manualStreamMode = manual;
    let stream;
    try {
      stream = this.canvas.captureStream(manual ? 0 : this.fps);
    } catch {
      stream = this.canvas.captureStream();
    }
    const track = stream.getVideoTracks()[0];
    if (!track) return;

    const previous = this.track;
    this.stream = stream;
    this.track = track;
    this.onTrackChange(track);
    if (previous && previous !== track) {
      try {
        previous.stop();
      } catch {
        /* ignore */
      }
    }
  }

  #startLoop() {
    if (this._rafId !== null) return;
    const tick = () => {
      this._rafId = requestAnimationFrame(tick);
      if (this.sourceKind === 'none') return;
      if (this.sourceKind === 'camera') {
        const size = this.videoSize();
        if (!size.width || !size.height) return;
        if (this.canvas.width === 0 || this.canvas.height === 0) {
          this.#resizeCanvas();
        } else {
          // 旋转或分辨率变化会改变 canvas 需要的尺寸
          this.#resizeCanvas();
        }
        if (this.locked) return;
        this.#draw();
        this._dirty = false;
        return;
      }
      if (this._dirty) {
        this.#draw();
        this._dirty = false;
      }
    };
    this._rafId = requestAnimationFrame(tick);
  }

  #stopLoop() {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  /**
   * 静态画面（图片 / 锁定帧）：canvas 内容不变化，自动模式的 captureStream 不会出帧。
   * 此时轨道用 captureStream(0) 手动模式，必须定时 requestFrame() 才会输出一帧。
   * 这里每 200ms 请求一帧（约 5fps，Android 静态图推送同为低频），大屏端能持续显示。
   */
  #updateKeepAlive() {
    const needed = this.#isStaticContent();
    if (needed && this._keepAliveTimer === null) {
      this._keepAliveTimer = setInterval(() => {
        // 手动模式下每次 requestFrame 前确保画布是最新内容
        if (this.locked || this.sourceKind === 'image') {
          this.#draw();
          this._dirty = false;
        }
        try {
          this.track?.requestFrame?.();
        } catch {
          /* ignore */
        }
      }, 200);
    } else if (!needed && this._keepAliveTimer !== null) {
      this.#stopKeepAlive();
    }
  }

  #stopKeepAlive() {
    if (this._keepAliveTimer !== null) {
      clearInterval(this._keepAliveTimer);
      this._keepAliveTimer = null;
    }
  }

  #draw() {
    const element = this.#sourceElement();
    const size = this.#sourceSize();
    if (!element || !size || !size.width || !size.height) return;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    if (!cw || !ch) return;

    const quarter = this.rotation;
    const swapped = quarter === 90 || quarter === 270;
    // 旋转后、未经裁剪的"虚拟画布"尺寸
    const srcW = swapped ? size.height : size.width;
    const srcH = swapped ? size.width : size.height;
    const crop = this.crop();
    const ctx = this.ctx;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, ch);

    // 把裁剪区域（相对虚拟画布的归一化矩形）放大到整块 canvas
    ctx.scale(cw / (crop.width * srcW), ch / (crop.height * srcH));
    ctx.translate(-crop.x * srcW, -crop.y * srcH);
    ctx.translate(srcW / 2, srcH / 2);
    ctx.rotate((quarter * Math.PI) / 180);
    ctx.drawImage(element, -size.width / 2, -size.height / 2, size.width, size.height);
    ctx.restore();
  }

  #clampPan() {
    const limit = Math.max(0, (1 - 1 / this.zoom) / 2);
    this.panX = clamp(this.panX, -limit, limit);
    this.panY = clamp(this.panY, -limit, limit);
  }

  #emitPresentation() {
    this.onPresentationChange(this.presentation());
  }

  #stopCameraStream() {
    if (this.cameraStream) {
      for (const track of this.cameraStream.getTracks()) {
        try {
          track.stop();
        } catch {
          /* ignore */
        }
      }
      this.cameraStream = null;
    }
    this.video.srcObject = null;
  }
}
