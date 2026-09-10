// iPhone 网页版教师端主流程。
// 界面状态机与 Android MainActivity 一致：
//   auth -> connect -> menu -> (live | coursewareSource -> coursewareList -> coursewarePlay)

import {
  $,
  storage,
  toast,
  showView,
  showOverlay,
  hideOverlay,
  setOverlayText,
  setOverlayProgress,
  formatBytes,
  clamp,
  deviceAngle,
  isStandalone,
  isIos
} from './util.js';
import { SignalingClient, resolveWebSocketUrl } from './signaling.js';
import { LivePublisher } from './publisher.js';
import { MediaPipeline } from './pipeline.js';
import { CoursewareClient, coursewareFormatLabel } from './courseware.js';
import { AnnotationBoard } from './annotation.js';
import { openPdfDocument, renderPdfPage, destroyPdfDocument } from './pdfview.js';

const QUALITY_PRESETS = {
  smooth: { label: '流畅 960×720', width: 960, height: 720, fps: 24, maxBitrate: 3000000 },
  standard: { label: '标准 1280×960', width: 1280, height: 960, fps: 24, maxBitrate: 6000000 },
  hd: { label: '高清 1920×1440', width: 1920, height: 1440, fps: 24, maxBitrate: 10000000 }
};

const state = {
  config: null,
  apiBase: '',
  token: null,
  username: null,
  signaling: null,
  pipeline: null,
  publisher: null,
  coursewareClient: null,
  roomCode: null,
  joined: false,
  screen: 'Auth',
  liveMode: 'camera', // camera | image
  liveActive: false,
  quality: storage.get('quality', 'standard'),
  torchOn: false,
  courseware: null,
  // 图片视频投屏队列（与 Android 一致：上传后由大屏加载，投屏中可直接切换）
  media: { queue: [], index: -1, preloading: false, uploading: false },
  // 大屏端视频播放状态（遥控器界面用）
  video: { playing: false, position: 0, duration: 0, muted: false, volume: 100 },
  // 画笔标注：图片投屏与课件投屏各一块画板
  mediaBoard: null,
  cwBoard: null,
  // 课件标注按页缓存笔迹（与 Android coursewarePdfStrokes 一致）
  cwStrokes: { store: new Map(), page: 0 },
  cwPdf: { doc: null, url: '', pageCount: 0, rendering: false, pendingPage: 0, ignoreRemotePageUntil: 0 },
  // 课件预览视口（与安卓端 ZoomableImageView 的 userScale / translateX / translateY 同构）
  cwView: {
    scale: 1,
    translateX: 0,
    translateY: 0,
    // iPad 整页可显示时用它驱动大屏逐屏滚动（同安卓 bigScrollActive / bigProgressY）
    bigScrollActive: false,
    bigProgressY: 0,
    lastNotifyAt: 0
  },
  resumeLiveAfterJoin: false,
  pendingCoursewareClose: false,
  uploadAbort: null,
  lastHiddenAt: 0
};

// ---------------------------------------------------------------- 引导

async function bootstrap() {
  // 标注画板只依赖 DOM，最先初始化：即使后续配置/登录失败，画笔相关代码也不会拿到空画板
  setupAnnotationBoards();
  bindStaticEvents();
  renderQualityOptions();
  registerServiceWorker();

  try {
    state.config = await loadConfig();
  } catch (error) {
    toast(`无法连接服务器：${error.message}`, { warn: true, duration: 4000 });
    showView('Auth');
    return;
  }

  state.apiBase = new URL('../api', window.location.href).href.replace(/\/$/, '');
  state.coursewareClient = new CoursewareClient({ apiBase: state.apiBase, token: null });
  setupPipeline();

  const version = state.config.iosVersion || state.config.apkVersion || '';
  const versionText = version ? `v${version}` : '';
  $('authVersion').textContent = versionText;
  $('connectVersion').textContent = versionText;
  $('menuVersion').textContent = `已登录：${state.username || ''}${versionText ? ` · ${versionText}` : ''}`;
  $('connectServerHint').textContent = `服务地址：${window.location.host}${state.config.wsPath || ''}`;

  const token = storage.get('token');
  if (!token) {
    showAuth();
    return;
  }

  state.token = token;
  state.coursewareClient.setToken(token);
  // 先显示连接页避免黑屏，再后台校验 token
  showConnect();
  try {
    const me = await apiMe();
    state.username = me.username;
    storage.set('username', me.username);
    $('menuVersion').textContent = `已登录：${me.username}${versionText ? ` · ${versionText}` : ''}`;
  } catch {
    clearAuth();
    showAuth();
    toast('登录已过期，请重新登录', { warn: true });
  }
}

async function loadConfig() {
  const response = await fetch('../api/config', { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function apiMe() {
  const response = await fetch(`${state.apiBase}/auth/me`, {
    headers: { Authorization: `Bearer ${state.token}` },
    cache: 'no-store'
  });
  if (!response.ok) throw new Error('未登录');
  return response.json();
}

function clearAuth() {
  state.token = null;
  state.username = null;
  storage.remove('token');
  storage.remove('username');
  state.coursewareClient?.setToken(null);
}

// ---------------------------------------------------------------- 认证

async function performAuth(isRegister) {
  const username = $('authUsername').value.trim();
  const password = $('authPassword').value;

  if (username.length < 2) return toast('用户名至少2位', { warn: true });
  if (password.length < 4) return toast('密码至少4位', { warn: true });
  if (isRegister) {
    if (username.length > 20) return toast('用户名最多20位', { warn: true });
    if (!/^[一-龥a-zA-Z0-9_]+$/.test(username)) return toast('仅支持中英文数字下划线', { warn: true });
    if (password.length > 32) return toast('密码最多32位', { warn: true });
  }

  const button = isRegister ? $('authRegister') : $('authLogin');
  const original = button.textContent;
  button.disabled = true;
  button.textContent = isRegister ? '注册中...' : '登录中...';

  try {
    const response = await fetch(`${state.apiBase}/auth/${isRegister ? 'register' : 'login'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);

    state.token = payload.token;
    state.username = payload.username;
    storage.set('token', payload.token);
    storage.set('username', payload.username);
    state.coursewareClient?.setToken(payload.token);
    $('authPassword').value = '';
    showConnect();
    toast(isRegister ? '注册成功' : '登录成功');
  } catch (error) {
    toast(error.message || '操作失败', { warn: true });
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function showAuth() {
  state.screen = 'Auth';
  showView('Auth');
}

function showConnect() {
  state.screen = 'Connect';
  showView('Connect');
  $('connectHint').textContent = '请输入教室大屏上的 4 位连接码';
  setTimeout(() => $('roomCodeInput')?.focus(), 120);
}

function showMenu() {
  state.screen = 'Menu';
  showView('Menu');
  $('menuStatus').textContent = `已连接课堂 ${state.roomCode || ''}`;
  // 离开投屏/课件页时收起画笔，避免回到菜单后工具栏残留
  setMediaPenMode(false);
  setCoursewarePenMode(false);
}

// ---------------------------------------------------------------- 信令

function ensureSignaling() {
  if (state.signaling) return state.signaling;

  const signaling = new SignalingClient({
    wsUrl: resolveWebSocketUrl(state.config?.wsPath),
    handlers: {
      onJoinAccepted: handleJoinAccepted,
      onJoinRejected: (message) => {
        toast(message, { warn: true });
        state.roomCode = null;
        showConnect();
      },
      onKicked: (message) => {
        toast(message, { warn: true });
        leaveRoom();
        showConnect();
      },
      onServerClosed: (message) => {
        toast(message, { warn: true });
        leaveRoom();
        showConnect();
      },
      onAnswer: async (sdp) => {
        try {
          await state.publisher?.acceptAnswer(sdp);
        } catch (error) {
          toast('建立视频连接失败', { warn: true });
        }
      },
      onRemoteIceCandidate: async (candidate) => {
        await state.publisher?.addIceCandidate(candidate).catch(() => {});
      },
      onCoursewareState: handleCoursewareState,
      onCoursewareVideoState: handleCoursewareVideoState,
      onViewerCoursewareOpen: handleViewerCoursewareOpen,
      onViewerCoursewareClose: handleViewerCoursewareClose,
      onViewerAnnotation: handleViewerAnnotation,
      onSignalError: (message) => toast(message, { warn: true }),
      onDisconnected: () => {
        if (state.joined) $('connectHint').textContent = '连接已断开，正在重新连接...';
      }
    }
  });

  state.signaling = signaling;
  signaling.connect();
  return signaling;
}

function handleJoinAccepted() {
  state.joined = true;
  $('connectHint').textContent = '连接成功';
  toast('连接成功');

  if (state.pendingCoursewareClose) {
    state.pendingCoursewareClose = false;
    stopCoursewareSignals();
    toast('课件播放已结束');
    showMenu();
    return;
  }

  if (state.resumeLiveAfterJoin) {
    state.resumeLiveAfterJoin = false;
    if (state.screen === 'Live' || state.liveMode === 'image') {
      restartLive();
      return;
    }
  }

  // 图片视频投屏中断线重连：重新把当前文件推给大屏（视频不重发 open，避免从头播放）
  if (resumeMediaCast()) return;

  // iOS 选图后若发生页面重载，已选图片（压缩后）已存入 sessionStorage，
  // 加入房间后自动恢复图片直播，避免“退回菜单、无任何提示”。
  if (restorePendingImage()) return;

  showMenu();
}

// iOS 选图后若发生页面重载，已选图片（压缩后）已存入 sessionStorage，
// 加入房间后自动恢复图片直播，避免“退回菜单、无任何提示”。
function restorePendingImage() {
  const dataUrl = sessionStorage.getItem(PENDING_IMAGE_KEY);
  if (!dataUrl) return false;
  sessionStorage.removeItem(PENDING_IMAGE_KEY);
  (async () => {
    try {
      const blob = await (await fetch(dataUrl)).blob();
      await showImageLive(new File([blob], 'image.jpg', { type: 'image/jpeg' }));
    } catch {
      toast('恢复图片失败，请重新选择图片', { warn: true });
    }
  })();
  return true;
}

function connectToRoom(code) {
  if (!/^\d{4}$/.test(code)) {
    toast('请输入 4 位数字连接码', { warn: true });
    return;
  }
  state.roomCode = code;
  $('connectHint').textContent = '正在连接...';
  ensureSignaling().join(code, state.token);
}

function leaveRoom() {
  state.joined = false;
  state.roomCode = null;
  state.resumeLiveAfterJoin = false;
  state.signaling?.close();
  state.signaling = null;
  stopLive({ notify: false });
}

function disconnectAndBack() {
  stopLive({ notify: true });
  stopCourseware({ silent: true });
  resetMediaCastState();
  leaveRoom();
  showConnect();
}

// ---------------------------------------------------------------- 推流

function setupPipeline() {
  const pipeline = new MediaPipeline({
    canvas: $('previewCanvas'),
    video: $('sourceVideo'),
    image: $('sourceImage'),
    onTrackChange: (track) => {
      if (state.publisher?.active) {
        state.publisher.replaceTrack(track);
      }
      updateLiveUI();
    },
    onPresentationChange: () => sendOrientationNow()
  });
  state.pipeline = pipeline;
}

function createPublisher() {
  const preset = QUALITY_PRESETS[state.quality] || QUALITY_PRESETS.standard;
  return new LivePublisher({
    iceServers: state.config?.rtc?.iceServers || [],
    maxBitrate: preset.maxBitrate,
    onIceCandidate: (candidate) => state.signaling?.sendIceCandidate(candidate),
    onStateChange: () => updateLiveStatus(),
    onError: (message) => toast(message, { warn: true })
  });
}

async function startLive() {
  if (!state.joined) {
    toast('请先连接教室端', { warn: true });
    return;
  }
  if (!state.pipeline?.track) {
    toast('画面尚未就绪，请稍候', { warn: true });
    return;
  }
  if (state.publisher?.active) return;

  state.publisher = createPublisher();
  try {
    const sdp = await state.publisher.publish(state.pipeline.track);
    if (!state.signaling?.sendOffer(sdp)) {
      throw new Error('信令未连接');
    }
    state.liveActive = true;
    updateLiveUI();
    sendOrientationNow();
  } catch (error) {
    state.publisher?.stop();
    state.publisher = null;
    state.liveActive = false;
    updateLiveUI();
    toast(error.message || '开始直播失败', { warn: true });
  }
}

async function restartLive() {
  stopLive({ notify: false });
  await new Promise((resolve) => setTimeout(resolve, 400));
  if (state.screen === 'Live') await startLive();
}

function stopLive({ notify = true } = {}) {
  state.publisher?.stop();
  state.publisher = null;
  if (state.liveActive) {
    state.liveActive = false;
  }
  if (notify && state.joined) {
    state.signaling?.sendStop();
  }
  updateLiveUI();
}

function sendOrientationNow() {
  if (!state.joined || !state.pipeline) return;
  state.signaling?.sendOrientation(state.pipeline.presentation());
  updateZoomBadge();
}

// ---------------------------------------------------------------- 直播页

async function openCameraLive() {
  // 正在投屏图片/视频时改开摄像头：先结束投屏，避免大屏停留在旧内容
  if (state.media.index >= 0) stopMediaCast();
  const preset = QUALITY_PRESETS[state.quality] || QUALITY_PRESETS.standard;
  state.liveMode = 'camera';
  state.screen = 'Live';
  showView('Live');
  setLiveMessage('正在打开摄像头...');
  updateLiveUI();

  try {
    await state.pipeline.openCamera({
      facing: state.pipeline.facing || 'back',
      width: preset.width,
      height: preset.height,
      fps: preset.fps
    });
    delete $('liveStatus').dataset.userMessage;
    updateTorchButton();
    updateLiveUI();
    updateLiveStatus();
    sendOrientationNow();
  } catch (error) {
    toast(error.message || '无法打开摄像头', { warn: true, duration: 4000 });
    setLiveMessage(error.message || '无法打开摄像头');
  }
}

// iOS（尤其“添加到主屏”的 PWA 模式）对临时创建、未挂载到 DOM 的 <input type=file>
// 行为异常：选择图片后既不触发 change，又可能重载页面（选图结果丢失、退回菜单且无提示）。
// 这里把 input 持久挂到 DOM，并选图后立即压缩存入 sessionStorage 以便重载后自动恢复。
const PENDING_IMAGE_KEY = 'myclass.pendingImage';
let persistentImageInput = null;

async function openImagePicker() {
  if (!persistentImageInput) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    // 真实存在于 DOM（但不能 display:none，否则 iOS 不触发选择）
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    input.style.top = '0';
    input.style.opacity = '0';
    input.style.width = '1px';
    input.style.height = '1px';
    input.addEventListener('change', handleImagePicked);
    document.body.appendChild(input);
    persistentImageInput = input;
  }
  persistentImageInput.value = ''; // 允许重复选择同一张
  persistentImageInput.click();
}

async function handleImagePicked(event) {
  const input = event.currentTarget;
  const file = input.files?.[0];
  if (!file) {
    toast('未选择到图片，请重试', { warn: true });
    return;
  }
  try {
    // 压缩到长边 1920 的 JPEG，既减小推流体积，也便于断点恢复
    const dataUrl = await fileToResizedDataUrl(file, 1920);
    sessionStorage.setItem(PENDING_IMAGE_KEY, dataUrl);
    const blob = await (await fetch(dataUrl)).blob();
    await showImageLive(new File([blob], file.name || 'image.jpg', { type: 'image/jpeg' }));
  } catch (error) {
    toast(error.message || '无法读取所选图片', { warn: true });
  }
}

function fileToResizedDataUrl(file, maxEdge) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight || 1));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      try {
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      } catch (e) {
        reject(e instanceof Error ? e : new Error('图片处理失败'));
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片解码失败（iOS 可能不支持该图片格式）'));
    };
    img.src = url;
  });
}

async function showImageLive(file) {
  state.liveMode = 'image';
  state.screen = 'Live';
  showView('Live');
  setLiveMessage('正在载入图片...');
  updateLiveUI();

  try {
    await state.pipeline.showImage(file);
    delete $('liveStatus').dataset.userMessage;
    updateTorchButton();
    updateLiveUI();
    sendOrientationNow();
    // 图片是静态画面，直接开始推流，避免大屏停在上一帧
    await startLive();
    // 进入直播成功，清除待恢复标记（避免重载恢复时重复）
    sessionStorage.removeItem(PENDING_IMAGE_KEY);
  } catch (error) {
    toast(error.message || '无法读取所选图片', { warn: true });
    setLiveMessage(error.message || '读取图片失败');
  }
}

function exitLive() {
  stopLive({ notify: true });
  state.pipeline?.stop();
  state.torchOn = false;
  showMenu();
}

function updateLiveUI() {
  const toggle = $('liveToggle');
  const isImage = state.liveMode === 'image';
  toggle.textContent = state.liveActive ? '停止直播' : '开始直播';
  toggle.classList.toggle('is-live', state.liveActive);
  // 画面轨道就绪后才允许推流，避免摄像头还在打开时点了没反应
  toggle.disabled = !state.joined || !state.pipeline?.track;

  const cameraMode = !isImage;
  $('switchCameraButton').hidden = !cameraMode;
  $('torchButton').hidden = !cameraMode;
  $('rotateButton').hidden = isImage;
  $('lockFrameButton').hidden = isImage;
  $('lockFrameButton').textContent = state.pipeline?.locked ? '解除锁定' : '锁定画面';
  $('lockFrameButton').classList.toggle('is-active', state.pipeline?.locked === true);
  updateZoomBadge();
  updateLiveStatus();
}

function updateZoomBadge() {
  const badge = $('liveZoom');
  const zoom = state.pipeline?.zoom || 1;
  badge.hidden = zoom <= 1.02;
  badge.textContent = `${zoom.toFixed(1)}x`;
}

function updateTorchButton() {
  const button = $('torchButton');
  const supported = state.pipeline?.torchSupported() === true;
  button.disabled = !supported;
  button.textContent = supported ? (state.torchOn ? '关闭补光' : '补光灯') : '补光灯(不支持)';
  button.classList.toggle('is-active', supported && state.torchOn);
}

function updateLiveStatus() {
  const node = $('liveStatus');
  if (!node) return;
  if (!state.liveActive) {
    if (node.dataset.userMessage) return;
    if (!state.joined) {
      node.textContent = '未连接教室端';
      return;
    }
    node.textContent = '未开始直播';
    return;
  }
  delete node.dataset.userMessage;
  const ice = state.publisher?.iceConnectionState || '';
  if (ice === 'connected' || ice === 'completed') {
    const canvas = $('previewCanvas');
    node.textContent = `直播中 · ${canvas.width}×${canvas.height}`;
  } else if (ice === 'failed') {
    node.textContent = '视频连接失败，请重新开启直播';
  } else if (ice === 'disconnected') {
    node.textContent = '视频连接中断，等待恢复...';
  } else {
    node.textContent = '正在建立视频连接...';
  }
}

function setLiveMessage(message) {
  const node = $('liveStatus');
  node.dataset.userMessage = '1';
  node.textContent = message;
}

// ---- 手势：双指缩放 / 单指拖动 / 点击对焦 ----

function bindLiveGestures() {
  const stage = $('liveStage');
  let pinchActive = false;
  let lastPinchDistance = 0;
  let lastSingle = null;
  let moved = false;
  let pinched = false; // 本轮手势中是否发生过双指捏合（用于抑制松手后的误判点击）

  // 直接取 event.touches 快照，避免自己维护指针表时 identifier 不同步
  const pointsOf = (event) =>
    Array.from(event.touches || []).map((touch) => ({
      id: touch.identifier,
      x: touch.clientX,
      y: touch.clientY
    }));

  const distanceOf = (points) => {
    if (points.length < 2) return 0;
    return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
  };

  stage.addEventListener('touchstart', (event) => {
    const points = pointsOf(event);
    if (points.length >= 2) {
      // 双指捏合：以最近一次有效间距为基准做连续缩放，
      // 不依赖跨事件的起始状态，兼容浏览器把多点 touchstart 拆成多个单点事件的情况
      pinchActive = true;
      pinched = true;
      lastPinchDistance = distanceOf(points);
      lastSingle = null;
      moved = false;
      return;
    }
    if (points.length === 1 && !pinchActive) {
      lastSingle = { x: points[0].x, y: points[0].y };
      moved = false;
    }
  }, { passive: true });

  stage.addEventListener('touchmove', (event) => {
    const points = pointsOf(event);

    if (points.length >= 2) {
      pinchActive = true;
      const current = distanceOf(points);
      if (current > 0 && lastPinchDistance > 0) {
        const factor = current / lastPinchDistance;
        if (Math.abs(factor - 1) > 0.001) state.pipeline?.zoomBy(factor);
      }
      lastPinchDistance = current;
      updateZoomBadge();
      return;
    }

    if (points.length !== 1 || !lastSingle) return;
    const dx = points[0].x - lastSingle.x;
    const dy = points[0].y - lastSingle.y;
    if (!moved && Math.hypot(dx, dy) < 6) return;
    moved = true;

    const rect = stage.getBoundingClientRect();
    state.pipeline?.panBy(dx / rect.width, dy / rect.height);
    // 始终跟随手指，避免到达边界后位移量累积
    lastSingle = { x: points[0].x, y: points[0].y };
  }, { passive: true });

  stage.addEventListener('touchend', (event) => {
    const remaining = pointsOf(event);
    // 捏合/拖动过的松手不视为点击，避免缩放后复位视图或误触对焦
    const isTap = !pinched && !moved && event.changedTouches.length > 0;
    if (remaining.length < 2) {
      pinchActive = false;
      lastPinchDistance = 0;
      lastSingle = remaining.length === 1 ? { x: remaining[0].x, y: remaining[0].y } : null;
    }
    if (remaining.length === 0) {
      // 整轮手势结束，下次手势重新开始记录
      pinched = false;
      moved = false;
    }
    if (isTap) {
      handleTap(event.changedTouches[0]);
    }
  }, { passive: true });

  stage.addEventListener('touchcancel', () => {
    pinchActive = false;
    lastPinchDistance = 0;
    lastSingle = null;
    moved = false;
    pinched = false;
  }, { passive: true });

  // 桌面/触控板调试用：滚轮缩放
  stage.addEventListener('wheel', (event) => {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.08 : 1 / 1.08;
    state.pipeline?.zoomBy(factor);
    updateZoomBadge();
  }, { passive: false });
}

function handleTap(touch) {
  if (state.pipeline?.sourceKind !== 'camera') return;
  const stage = $('liveStage');
  const rect = stage.getBoundingClientRect();
  const x = (touch.clientX - rect.left) / rect.width;
  const y = (touch.clientY - rect.top) / rect.height;

  if (state.pipeline.locked || state.pipeline.zoom > 1.02) {
    // 放大状态下单击用于复位视图，避免误触发对焦
    state.pipeline.resetView();
    updateZoomBadge();
    return;
  }

  showFocusRing(touch.clientX - rect.left, touch.clientY - rect.top);
  state.pipeline.focusAt(x, y).then((ok) => {
    if (ok) setLiveMessage('已对焦');
    setTimeout(() => {
      delete $('liveStatus').dataset.userMessage;
      updateLiveStatus();
    }, 1200);
  });
}

function showFocusRing(x, y) {
  const ring = $('focusRing');
  ring.style.left = `${x}px`;
  ring.style.top = `${y}px`;
  ring.hidden = false;
  ring.classList.add('is-visible');
  setTimeout(() => {
    ring.classList.remove('is-visible');
    setTimeout(() => {
      ring.hidden = true;
    }, 200);
  }, 700);
}

// ---------------------------------------------------------------- 图片视频投屏
// 与 Android 端一致：本机文件先上传到服务器，再由大屏端直接加载播放（不经 WebRTC 编码），
// 一次可多选，投屏过程中用“上一个/下一个/列表”切换，无需重新选择文件。

const VIDEO_PATTERN = /\.(mp4|mov|avi|webm|mkv|3gp)(\?|$)/i;
const IMAGE_PATTERN = /\.(jpe?g|png|gif|webp|bmp)(\?|$)/i;

function mediaKindOf(nameOrUrl) {
  const value = String(nameOrUrl || '');
  if (VIDEO_PATTERN.test(value)) return 'video';
  if (IMAGE_PATTERN.test(value)) return 'image';
  return 'other';
}

// iOS（尤其主屏 PWA）对临时创建、未挂载到 DOM 的 <input type=file> 行为异常，
// 因此与单图投屏一样把 input 持久挂到 DOM。
let mediaFileInput = null;
let mediaPreviewUrl = null;

function showMediaSource() {
  state.screen = 'MediaSource';
  showView('MediaSource');
}

function openMediaPicker() {
  if (!mediaFileInput) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*,video/*';
    input.multiple = true;
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    input.style.top = '0';
    input.style.opacity = '0';
    input.style.width = '1px';
    input.style.height = '1px';
    input.addEventListener('change', handleMediaPicked);
    document.body.appendChild(input);
    mediaFileInput = input;
  }
  mediaFileInput.value = '';
  mediaFileInput.click();
}

async function handleMediaPicked(event) {
  const files = Array.from(event.currentTarget.files || []);
  if (files.length === 0) {
    toast('未选择到文件，请重试', { warn: true });
    return;
  }
  if (!state.joined) {
    toast('请先连接教室端', { warn: true });
    return;
  }

  // 连续多次选择时追加到已有队列后面，已投屏的内容不受影响
  const startIndex = state.media.queue.length;
  for (const file of files) {
    state.media.queue.push({
      file,
      name: file.name || 'media',
      kind: mediaKindOf(file.name),
      status: 'pending',
      url: '',
      title: '',
      id: null,
      rotation: 0,
      scale: 1,
      panX: 0,
      panY: 0
    });
  }
  await castMediaItem(startIndex);
}

/** 当前文件的旋转角度（0 / 90 / 180 / 270），修正拍照方向不对的图片 */
function currentMediaRotation() {
  return state.media.queue[state.media.index]?.rotation || 0;
}

/** 旋转当前图片 90°：本地预览与大屏同步旋转 */
function rotateCurrentMedia() {
  const item = state.media.queue[state.media.index];
  if (!item || item.kind === 'video') return;
  item.rotation = ((item.rotation || 0) + 90) % 360;
  applyMediaPreviewRotation();
  sendMediaViewport();
  toast(`已旋转 ${item.rotation}°，大屏同步`);
}

/** 把当前图片的视口（缩放/平移/旋转）同步给大屏，与大屏端约定一致：
 *  scale 为相对适应屏幕的放大倍数，centerX/centerY 为视口中心归一化坐标 */
function sendMediaViewport() {
  const item = state.media.queue[state.media.index];
  if (!item || item.kind === 'video') return;
  state.signaling?.sendCoursewareImageViewport({
    scale: item.scale || 1,
    centerX: 0.5 + (item.panX || 0),
    centerY: 0.5 + (item.panY || 0),
    rotation: item.rotation || 0
  });
}

const MAX_MEDIA_ZOOM = 8;
const MIN_MEDIA_ZOOM = 1;

/** 双指捏合缩放当前图片（factor 为相对上一间距的倍数） */
function zoomByMedia(factor) {
  const item = state.media.queue[state.media.index];
  if (!item || item.kind !== 'image') return;
  const next = clamp((item.scale || 1) * factor, MIN_MEDIA_ZOOM, MAX_MEDIA_ZOOM);
  if (Math.abs(next - (item.scale || 1)) < 0.0005) return;
  item.scale = next;
  clampMediaPan(item);
  applyMediaPreviewRotation();
  updateMediaZoomStatus();
  sendMediaViewport();
}

/** 单指拖动平移当前图片（dx/dy 为相对预览框的归一化位移，手指右移为正） */
function panByMedia(dx, dy) {
  const item = state.media.queue[state.media.index];
  if (!item || item.kind !== 'image' || (item.scale || 1) <= 1.02) return;
  item.panX = (item.panX || 0) - dx;
  item.panY = (item.panY || 0) - dy;
  clampMediaPan(item);
  applyMediaPreviewRotation();
  updateMediaZoomStatus();
  sendMediaViewport();
}

/** 复位图片缩放与平移（放大倍数回到 1、中心回到正中） */
function resetMediaView() {
  const item = state.media.queue[state.media.index];
  if (!item || item.kind !== 'image') return;
  item.scale = 1;
  item.panX = 0;
  item.panY = 0;
  applyMediaPreviewRotation();
  updateMediaZoomStatus();
  sendMediaViewport();
}

/** 平移范围随放大倍数收紧，避免露出图片外的黑边 */
function clampMediaPan(item) {
  const limit = Math.max(0, (1 - 1 / (item.scale || 1)) / 2);
  item.panX = clamp(item.panX || 0, -limit, limit);
  item.panY = clamp(item.panY || 0, -limit, limit);
}

/** 缩放时在状态栏临时显示倍数，复位后恢复默认提示 */
function updateMediaZoomStatus() {
  const item = state.media.queue[state.media.index];
  if (!item || item.kind !== 'image') return;
  const s = item.scale || 1;
  $('mediaStatus').textContent =
    s > 1.02 ? `缩放 ${s.toFixed(2)}x（双指/滚轮缩放，拖动平移）` : '大屏正在显示该图片';
}

/**
 * 预览图变换：旋转 + 缩放 + 平移（与大屏端 refit 思路一致）。
 * 90/270 时画面宽高互换，需要按容器重新适应，否则旋转后会超出预览区域。
 */
function applyMediaPreviewRotation() {
  const img = $('mediaPreview');
  const item = state.media.queue[state.media.index];
  if (!img || img.hidden || !item) return;
  const rotation = item.rotation || 0;
  const scale = item.scale || 1;
  const panX = item.panX || 0;
  const panY = item.panY || 0;
  const swapped = rotation === 90 || rotation === 270;
  let adapt = 1;
  const box = $('mediaPreviewBox')?.getBoundingClientRect();
  if (swapped && img.naturalWidth && img.naturalHeight && box?.width && box?.height) {
    const fitNormal = Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight);
    const fitRotated = Math.min(box.width / img.naturalHeight, box.height / img.naturalWidth);
    if (fitNormal > 0) adapt = fitRotated / fitNormal;
  }
  img.style.transformOrigin = 'center center';
  // 视口中心由 (0.5,0.5) 移到 (0.5+panX, 0.5+panY)，与大屏端 translate(-panX) 方向一致：
  // 先缩放（含旋转后的适应修正），再按归一化中心反向平移，使视口对准图片对应区域
  img.style.transform =
    `rotate(${rotation}deg) scale(${scale * adapt}) translate(${-panX * 100}%, ${-panY * 100}%)`;
  // 图片显示矩形变化后，标注画布要跟着重绘（笔迹坐标以图片显示矩形为基准）
  state.mediaBoard?.invalidate();
}

/** 图片投屏页手势：双指捏合缩放 + 双指拖动平移 + 单指平移 + 滚轮（桌面调试），仅对图片生效 */
function bindMediaGestures() {
  const stage = $('mediaPreviewBox');
  if (!stage) return;
  let pinchActive = false;
  let lastDist = 0;
  let lastSingle = null;
  let lastCenter = null; // 双指中点，用于双指平移（画笔模式下单指被绘制占用，只能靠双指平移）

  const pointsOf = (event) => {
    const list = event.touches ? Array.from(event.touches) : [];
    return list.map((p) => ({ x: p.clientX, y: p.clientY }));
  };
  const distOf = (pts) => Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  const centerOf = (pts) => ({
    x: (pts[0].x + pts[1].x) / 2,
    y: (pts[0].y + pts[1].y) / 2
  });
  const currentItem = () => state.media.queue[state.media.index];
  const imageShown = () => {
    const it = currentItem();
    return !!it && it.kind === 'image' && !$('mediaPreview').hidden;
  };

  stage.addEventListener('touchstart', (event) => {
    if (!imageShown()) return;
    const pts = pointsOf(event);
    if (pts.length >= 2) {
      // 第二根手指落下：先结束当前笔画，再进入双指缩放/平移（与 Android 一致）
      state.mediaBoard?.endActiveStroke(true);
      pinchActive = true;
      lastDist = distOf(pts);
      lastCenter = centerOf(pts);
      lastSingle = null;
    } else if (pts.length === 1) {
      lastSingle = { x: pts[0].x, y: pts[0].y };
      lastCenter = null;
    }
  }, { passive: true });

  stage.addEventListener('touchmove', (event) => {
    if (!imageShown()) return;
    const pts = pointsOf(event);
    if (pts.length >= 2) {
      pinchActive = true;
      const box = stage.getBoundingClientRect();
      const current = distOf(pts);
      if (current > 0 && lastDist > 0) zoomByMedia(current / lastDist);
      lastDist = current;
      // 双指平移：按中点位移拖动画面（缩放状态下画笔模式也能用）
      const center = centerOf(pts);
      if (lastCenter && box.width && box.height) {
        panByMedia((center.x - lastCenter.x) / box.width, (center.y - lastCenter.y) / box.height);
      }
      lastCenter = center;
      lastSingle = null;
      event.preventDefault();
      return;
    }
    // 画笔模式下单指用于绘制，不再平移画面
    if (state.mediaBoard?.penMode) return;
    if (pts.length === 1 && lastSingle) {
      const dx = pts[0].x - lastSingle.x;
      const dy = pts[0].y - lastSingle.y;
      const box = stage.getBoundingClientRect();
      if (box.width && box.height) panByMedia(dx / box.width, dy / box.height);
      lastSingle = { x: pts[0].x, y: pts[0].y };
      event.preventDefault();
    }
  }, { passive: false });

  stage.addEventListener('touchend', (event) => {
    const remaining = pointsOf(event);
    if (remaining.length < 2) {
      pinchActive = false;
      lastDist = 0;
      lastCenter = null;
      lastSingle = remaining.length === 1 ? { x: remaining[0].x, y: remaining[0].y } : null;
    } else {
      // 还剩两根及以上手指：以最新两点重设基准，避免抬起一指后画面跳一下
      lastDist = distOf(remaining);
      lastCenter = centerOf(remaining);
    }
    if (remaining.length === 0) lastSingle = null;
  }, { passive: true });

  stage.addEventListener('touchcancel', () => {
    pinchActive = false;
    lastDist = 0;
    lastSingle = null;
    lastCenter = null;
  }, { passive: true });

  // 桌面/触控板调试用：滚轮缩放
  stage.addEventListener('wheel', (event) => {
    if (!imageShown()) return;
    event.preventDefault();
    zoomByMedia(event.deltaY < 0 ? 1.08 : 1 / 1.08);
  }, { passive: false });
}

/** 投屏队列中的第 index 个文件：已上传的直接切换，未上传的先上传 */
async function castMediaItem(index) {
  const item = state.media.queue[index];
  if (!item) return;
  if (!state.joined) {
    toast('请先连接教室端', { warn: true });
    return;
  }
  if (item.status === 'uploading') {
    toast('该文件正在上传，请稍候');
    return;
  }
  if (item.url) {
    switchToReadyMediaItem(index);
    return;
  }
  await uploadAndCastMediaItem(index);
}

function switchMediaBy(delta) {
  const total = state.media.queue.length;
  if (total < 2) return;
  const current = state.media.index >= 0 && state.media.index < total ? state.media.index : 0;
  castMediaItem((current + delta + total) % total);
}

/** 已上传过的文件：直接通知大屏切换，本地同步显示预览或视频遥控器 */
function switchToReadyMediaItem(index) {
  const item = state.media.queue[index];
  if (!item) return;
  state.media.index = index;
  state.courseware = null;
  // 换一张图就是换一份标注：收起画笔并清空本地笔迹
  setMediaPenMode(false);
  state.mediaBoard?.reset();

  stopLive({ notify: false });
  state.signaling?.sendStop();
  state.signaling?.sendCoursewareOpen({
    url: item.url,
    title: item.title || item.name,
    page: 1,
    screen: 1
  });
  // 大屏打开新图时会复位变换，这里把当前角度补发一次，避免手机端已旋转而大屏回到 0°
  sendMediaViewport();
  resetVideoState();

  state.screen = 'MediaCast';
  showView('MediaCast');
  updateMediaCastUI();
  // 探活：让大屏回传一次当前播放状态
  if (item.kind === 'video') state.signaling?.sendCoursewareVideoControl('query');
  preloadRestOfMediaQueue();
}

async function uploadAndCastMediaItem(index) {
  const item = state.media.queue[index];
  if (!item) return;
  state.media.index = index;
  item.status = 'uploading';
  state.media.uploading = true;
  state.courseware = null;
  stopLive({ notify: false });

  state.screen = 'MediaCast';
  showView('MediaCast');
  updateMediaCastUI(`正在上传：${item.name}`);

  const controller = new AbortController();
  state.uploadAbort = controller;
  showOverlay(`正在上传：${item.name}`, {
    progress: true,
    onCancel: () => controller.abort()
  });

  try {
    const file = item.kind === 'image' ? await compressImageFile(item.file) : item.file;
    const result = await state.coursewareClient.upload(
      file,
      (ratio) => {
        setOverlayProgress(ratio);
        setOverlayText(`正在上传：${item.name}\n${Math.round(ratio * 100)}%`);
      },
      controller.signal
    );
    hideOverlay();
    item.status = 'ready';
    item.url = result.url;
    item.title = result.title || item.name;
    item.id = result.id || null;
    state.media.uploading = false;
    if (state.media.index !== index) {
      // 期间用户已切到别的文件：结果只入队，不覆盖当前界面
      preloadRestOfMediaQueue();
      return;
    }
    switchToReadyMediaItem(index);
  } catch (error) {
    hideOverlay();
    state.media.uploading = false;
    item.status = 'failed';
    if (error.message !== '__ABORTED__') {
      toast(error.message || '文件上传失败', { warn: true, duration: 3500 });
    }
    updateMediaCastUI(`上传失败：${item.name}`);
    preloadRestOfMediaQueue();
  } finally {
    state.uploadAbort = null;
  }
}

/** 后台依次上传队列中尚未上传的文件，切换时即可秒开（不弹遮罩、不打断当前投屏） */
async function preloadRestOfMediaQueue() {
  if (state.media.preloading) return;
  state.media.preloading = true;
  try {
    for (let index = 0; index < state.media.queue.length; index += 1) {
      const item = state.media.queue[index];
      if (!item || item.url || item.status === 'failed') continue;
      if (!state.joined) break;
      item.status = 'uploading';
      try {
        const file = item.kind === 'image' ? await compressImageFile(item.file) : item.file;
        const result = await state.coursewareClient.upload(file, null, null);
        item.status = 'ready';
        item.url = result.url;
        item.title = result.title || item.name;
        item.id = result.id || null;
      } catch {
        item.status = 'failed';
      }
      if (state.screen === 'MediaQueue') renderMediaQueue();
    }
  } finally {
    state.media.preloading = false;
  }
}

async function compressImageFile(file) {
  const dataUrl = await fileToResizedDataUrl(file, 1920);
  const blob = await (await fetch(dataUrl)).blob();
  return new File([blob], file.name || 'image.jpg', { type: 'image/jpeg' });
}

function showMediaQueue() {
  state.screen = 'MediaQueue';
  showView('MediaQueue');
  renderMediaQueue();
}

function renderMediaQueue() {
  const body = $('mediaQueueBody');
  body.innerHTML = '';
  if (state.media.queue.length === 0) {
    body.innerHTML = '<p class="list-empty">还没有选择图片或视频</p>';
    return;
  }

  state.media.queue.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = 'cw-item';

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'cw-item-main';
    if (index === state.media.index) main.classList.add('is-current');

    const title = document.createElement('span');
    title.className = 'cw-item-title';
    title.textContent = `${index + 1}. ${item.title || item.name}`;

    const meta = document.createElement('span');
    meta.className = 'cw-item-meta';
    meta.textContent = mediaStatusText(item, index);

    main.append(title, meta);
    main.addEventListener('click', () => castMediaItem(index));
    row.appendChild(main);
    body.appendChild(row);
  });
}

function mediaStatusText(item, index) {
  if (index === state.media.index) return '● 正在投屏';
  switch (item.status) {
    case 'ready':
      return '已就绪';
    case 'uploading':
      return '上传中...';
    case 'failed':
      return '上传失败，点按重试';
    default:
      return '待上传';
  }
}

function backFromMediaQueue() {
  if (state.media.index >= 0 && state.media.queue[state.media.index]) {
    state.screen = 'MediaCast';
    showView('MediaCast');
    updateMediaCastUI();
    return;
  }
  showMediaSource();
}

/** 服务器已暂存的图片/视频：直接作为可切换队列展示，点按即投 */
async function loadServerMedia() {
  state.screen = 'MediaQueue';
  showView('MediaQueue');
  $('mediaQueueBody').innerHTML = '<p class="list-empty">正在加载服务器图片视频...</p>';

  try {
    const items = await state.coursewareClient.list();
    const media = items.filter((item) => mediaKindOf(item.url || item.originalUrl) !== 'other');
    state.media.queue = media.map((item) => ({
      file: null,
      name: item.title || 'media',
      kind: mediaKindOf(item.url || item.originalUrl),
      status: 'ready',
      url: item.url,
      title: item.title || item.fileName || 'media',
      id: item.id || null,
      rotation: 0,
      scale: 1,
      panX: 0,
      panY: 0
    }));
    state.media.index = -1;
    renderMediaQueue();
  } catch (error) {
    $('mediaQueueBody').innerHTML = `<p class="list-empty">${error.message || '加载失败'}</p>`;
  }
}

function updateMediaCastUI(statusOverride) {
  const item = state.media.queue[state.media.index];
  const total = state.media.queue.length;
  $('mediaTitle').textContent = item ? (item.title || item.name) : '图片视频投屏';

  const count = $('mediaCount');
  count.hidden = total < 2;
  if (total >= 2) count.textContent = `${state.media.index + 1}/${total}`;

  const isVideo = item?.kind === 'video';
  $('mediaVideoPanel').hidden = !isVideo;
  // 旋转只对图片有意义（视频自带方向信息）
  $('mediaImageActions').hidden = isVideo || !item;
  // 旋转按钮保持固定文案"旋转 90°"，当前角度由 rotateCurrentMedia 的提示条反馈
  updateMediaPreview(item, isVideo);

  const switchRow = $('mediaSwitchRow');
  switchRow.hidden = total < 2;
  if (total >= 2) $('mediaListButton').textContent = `列表 ${state.media.index + 1}/${total}`;

  if (statusOverride) {
    $('mediaStatus').textContent = statusOverride;
  } else if (!item) {
    $('mediaStatus').textContent = '尚未选择文件';
  } else if (isVideo) {
    updateVideoPanelUI();
  } else {
    $('mediaStatus').textContent = state.joined ? '大屏正在显示该图片' : '正在重新连接教室端...';
  }
}

function updateMediaPreview(item, isVideo) {
  const img = $('mediaPreview');
  if (mediaPreviewUrl) {
    URL.revokeObjectURL(mediaPreviewUrl);
    mediaPreviewUrl = null;
  }
  if (!item || isVideo) {
    img.hidden = true;
    img.removeAttribute('src');
    img.style.transform = '';
    // 视频没有可标注的内容，顺带收起画笔
    state.mediaBoard?.setEnabled(false);
    return;
  }
  // 图片尺寸要等加载完才知道，旋转后的自适应缩放必须在 onload 里再算一次
  img.onload = () => applyMediaPreviewRotation();
  // 本机文件用本地 blob 预览（省流量），服务器文件用远程地址
  if (item.file) {
    mediaPreviewUrl = URL.createObjectURL(item.file);
    img.src = mediaPreviewUrl;
  } else {
    img.src = item.url;
  }
  img.hidden = false;
  state.mediaBoard?.setEnabled(true);
  applyMediaPreviewRotation();
}

function updateVideoPanelUI() {
  const video = state.video;
  $('mediaPlayToggle').textContent = video.playing ? '暂停' : '播放';
  const total = video.duration > 0 ? formatMediaTime(video.duration) : '--:--';
  $('mediaTime').textContent = `${formatMediaTime(video.position)} / ${total}`;
  $('mediaSeek').value = String(
    video.duration > 0 ? Math.round((video.position / video.duration) * 1000) : 0
  );
  $('mediaMute').textContent = video.muted ? '🔇' : '🔊';
  $('mediaVolume').value = String(video.volume);

  if (!state.joined) {
    $('mediaStatus').textContent = '正在重新连接教室端...';
  } else if (video.duration <= 0) {
    $('mediaStatus').textContent = '大屏正在加载视频...';
  } else if (video.playing) {
    $('mediaStatus').textContent = video.muted ? '大屏正在播放（已静音）' : '大屏正在播放';
  } else {
    $('mediaStatus').textContent = '大屏已暂停';
  }
}

function handleCoursewareVideoState(message) {
  state.video.playing = message?.playing === true;
  state.video.position = Math.max(0, Number(message?.position) || 0);
  const duration = Number(message?.duration) || 0;
  if (duration > 0) state.video.duration = duration;
  state.video.muted = message?.muted === true;
  const volume = Number(message?.volume);
  if (Number.isFinite(volume)) state.video.volume = clamp(Math.round(volume), 0, 100);
  if (state.screen === 'MediaCast') updateMediaCastUI();
}

function sendVideoControl(action, options = {}) {
  if (!state.joined) {
    toast('请先连接教室端', { warn: true });
    return;
  }
  state.signaling?.sendCoursewareVideoControl(action, options);
}

function seekVideoBy(deltaSeconds) {
  const video = state.video;
  if (video.duration <= 0) {
    toast('暂未获取到视频时长');
    return;
  }
  const target = clamp(video.position + deltaSeconds, 0, video.duration);
  video.position = target;
  sendVideoControl('seek', { position: target });
  updateMediaCastUI();
}

function seekVideoToRatio(ratio) {
  const video = state.video;
  if (video.duration <= 0) return;
  const target = clamp(ratio * video.duration, 0, video.duration);
  video.position = target;
  sendVideoControl('seek', { position: target });
  updateMediaCastUI();
}

function formatMediaTime(seconds) {
  const total = Math.max(0, Math.round(seconds || 0));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  if (minutes >= 60) {
    return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function resetVideoState() {
  state.video.playing = false;
  state.video.position = 0;
  state.video.duration = 0;
}

function stopMediaCast() {
  const stopSent = state.signaling?.sendStop() === true;
  const closeSent = state.signaling?.sendCoursewareClose() === true;
  if (!stopSent && !closeSent && state.roomCode) {
    state.pendingCoursewareClose = true;
    ensureSignaling().join(state.roomCode, state.token);
  }
  resetMediaCastState();
  showMenu();
}

function resetMediaCastState() {
  if (mediaPreviewUrl) {
    URL.revokeObjectURL(mediaPreviewUrl);
    mediaPreviewUrl = null;
  }
  setMediaPenMode(false);
  state.mediaBoard?.setEnabled(false);
  state.mediaBoard?.reset();
  state.media.queue = [];
  state.media.index = -1;
  resetVideoState();
}

/** 断线重连成功后：把当前文件重新推给大屏（视频不重发 open，避免从头播放） */
function resumeMediaCast() {
  const item = state.media.queue[state.media.index];
  if (!item?.url) return false;
  if (item.kind === 'video' && state.video.duration > 0) {
    state.signaling?.sendCoursewareVideoControl('query');
  } else {
    state.signaling?.sendCoursewareOpen({
      url: item.url,
      title: item.title || item.name,
      page: 1,
      screen: 1
    });
  }
  if (state.screen === 'MediaCast' || state.screen === 'MediaQueue') {
    state.screen = 'MediaCast';
    showView('MediaCast');
    updateMediaCastUI();
  }
  return true;
}

// ---------------------------------------------------------------- 画笔标注
// 与 Android 端一致：iPad 上直接标注 → 通过 courseware.annotation 增量同步到大屏；
// 大屏端的标注动作（viewer.annotation）也会回传并在本地回放，两端笔迹栈保持一致。
// 图片投屏 page = 0（由大屏按当前页处理），课件投屏传当前页码。

const MEDIA_BAR = {
  colors: 'mediaAnnotationColors',
  eraser: 'mediaEraserButton',
  undo: 'mediaUndoButton',
  clear: 'mediaClearButton'
};
const CW_BAR = {
  colors: 'cwAnnotationColors',
  eraser: 'cwEraserButton',
  undo: 'cwUndoButton',
  clear: 'cwClearButton'
};

function setupAnnotationBoards() {
  if (state.mediaBoard && state.cwBoard) return; // 已初始化
  try {
    createAnnotationBoards();
  } catch (error) {
    // 画板初始化失败不应影响直播等主流程，这里给出可见提示便于排查
    console.error('[MyClass] 标注画板初始化失败', error);
    toast('标注功能初始化失败，请刷新页面重试', { warn: true, duration: 4000 });
  }
}

function createAnnotationBoards() {
  state.mediaBoard = new AnnotationBoard({
    canvas: $('mediaAnnotationCanvas'),
    getSurface: () => ($('mediaPreview').hidden ? null : $('mediaPreview')),
    emit: (payload) => sendAnnotation(payload, 0),
    onChange: () => {
      refreshAnnotationBar(MEDIA_BAR);
      syncAnnotationCanvas(MEDIA_BAR);
    }
  });

  state.cwBoard = new AnnotationBoard({
    canvas: $('cwAnnotationCanvas'),
    getSurface: coursewareSurface,
    emit: (payload) => sendAnnotation(payload, state.courseware?.page || 1),
    onChange: () => {
      refreshAnnotationBar(CW_BAR);
      syncAnnotationCanvas(CW_BAR);
    }
  });

  bindAnnotationBar(MEDIA_BAR, state.mediaBoard);
  bindAnnotationBar(CW_BAR, state.cwBoard);
}

function boardOfBar(bar) {
  return bar === MEDIA_BAR ? state.mediaBoard : state.cwBoard;
}

function bindAnnotationBar(bar, board) {
  $(bar.colors)
    .querySelectorAll('.annotation-color')
    .forEach((dot) => {
      dot.addEventListener('click', () => {
        board.setColor(dot.dataset.color); // 选颜色自动退出板擦
        refreshAnnotationBar(bar);
      });
    });
  $(bar.eraser).addEventListener('click', () => {
    board.setEraser(!board.eraser);
    refreshAnnotationBar(bar);
  });
  $(bar.undo).addEventListener('click', () => {
    if (!board.undo()) toast('没有可撤销的笔迹');
  });
  $(bar.clear).addEventListener('click', () => {
    if (!board.clear()) toast('没有可清空的笔迹');
  });
}

/** 有笔迹或处于画笔模式时显示标注画布；非画笔模式下画布不接收触摸，手势照常生效 */
function syncAnnotationCanvas(bar) {
  const board = boardOfBar(bar);
  const canvas = $(bar === MEDIA_BAR ? 'mediaAnnotationCanvas' : 'cwAnnotationCanvas');
  if (!board || !canvas) return;
  canvas.hidden = !(board.penMode || board.count > 0);
  canvas.classList.toggle('is-pen', board.penMode);
}

function refreshAnnotationBar(bar) {
  const board = boardOfBar(bar);
  if (!board) return;
  $(bar.colors)
    .querySelectorAll('.annotation-color')
    .forEach((dot) => {
      dot.classList.toggle('is-active', !board.eraser && dot.dataset.color === board.color);
    });
  $(bar.eraser).classList.toggle('is-active', board.eraser);
  const hasStrokes = board.count > 0;
  $(bar.undo).disabled = !hasStrokes;
  $(bar.clear).disabled = !hasStrokes;
}

/** 把画板产生的动作翻译成信令消息（page 由调用场景决定） */
function sendAnnotation(payload, page) {
  const signaling = state.signaling;
  if (!signaling?.isOpen()) return;
  switch (payload.action) {
    case 'begin':
      signaling.sendAnnotationBegin(
        payload.strokeId,
        payload.colorHex,
        payload.width,
        payload.isEraser,
        payload.points[0],
        page
      );
      break;
    case 'points':
      signaling.sendAnnotationPoints(payload.strokeId, payload.points, page);
      break;
    case 'end':
      signaling.sendAnnotationEnd(payload.strokeId, page);
      break;
    case 'undo':
      signaling.sendAnnotationUndo(page);
      break;
    case 'clear':
      signaling.sendAnnotationClear(page);
      break;
    default:
      break;
  }
}

/** 大屏端画笔回传：直接回放动作，保持两端笔迹一致 */
function handleViewerAnnotation(payload) {
  if (!payload || typeof payload.action !== 'string') return;
  if (state.screen === 'MediaCast') {
    state.mediaBoard?.applyRemote(payload);
    return;
  }
  if (state.screen === 'CoursewarePlay') {
    const page = Number(payload.page) || 0;
    // page = 0 表示旧版大屏或未分页场景，按当前页处理
    if (page > 0 && page !== (state.courseware?.page || 1)) return;
    state.cwBoard?.applyRemote(payload);
  }
}

// ---- 图片投屏标注 ----

function setMediaPenMode(on) {
  const board = state.mediaBoard;
  if (!board) return;
  board.setPenMode(on);
  syncAnnotationCanvas(MEDIA_BAR);
  $('mediaAnnotationBar').hidden = !on;
  const button = $('mediaPenButton');
  button.textContent = on ? '退出画笔' : '画笔';
  button.classList.toggle('is-active', on);
  if (on) board.render();
  refreshAnnotationBar(MEDIA_BAR);
}

function toggleMediaPen() {
  const board = state.mediaBoard;
  if (!board) return;
  const item = state.media.queue[state.media.index];
  if (!item || item.kind !== 'image') {
    toast('只有图片可以标注', { warn: true });
    return;
  }
  const next = !board.penMode;
  setMediaPenMode(next);
  if (next) toast('画笔模式：单指绘制，双指缩放拖动');
}

// ---- 课件投屏标注 ----

function coursewareSurface() {
  const canvas = $('cwPageCanvas');
  if (!canvas.hidden) return canvas;
  const image = $('cwPageImage');
  if (!image.hidden) return image;
  return null;
}

function coursewarePreviewKind(cw) {
  if (!cw?.url) return 'none';
  if (cw.linkUrl) return 'link';
  if (/\.pdf(\?|$)/i.test(cw.url)) return 'pdf';
  if (IMAGE_PATTERN.test(cw.url)) return 'image';
  return 'other';
}

function setCoursewarePenMode(on) {
  const board = state.cwBoard;
  if (!board) {
    setupAnnotationBoards();
    return;
  }
  if (on && !board.enabled) {
    toast('当前课件不支持在 iPad 上标注', { warn: true });
    return;
  }
  board.setPenMode(on);
  syncAnnotationCanvas(CW_BAR);
  $('cwAnnotationBar').hidden = !on;
  const button = $('cwPenButton');
  button.textContent = on ? '退出画笔' : '画笔';
  button.classList.toggle('is-active', on);
  if (on) board.render();
  refreshAnnotationBar(CW_BAR);
}

/** 打开课件后准备本地预览（PDF 渲染成位图，从而复用与图片一致的标注能力） */
async function prepareCoursewarePreview() {
  const cw = state.courseware;
  if (!cw) return;

  state.cwStrokes.store.clear();
  state.cwStrokes.page = cw.page || 1;
  state.cwBoard?.reset();
  setCoursewarePenMode(false);

  const kind = coursewarePreviewKind(cw);
  if (kind === 'pdf') {
    await loadCoursewarePdf(cw);
    return;
  }
  if (kind === 'image') {
    $('cwPageCanvas').hidden = true;
    const image = $('cwPageImage');
    // 图片类课件与 PDF 页一样走 FitWidth：宽度充满舞台，长图可拖动查看
    image.onload = () => {
      applyCoursewareSurfaceRatio(image, image.naturalWidth, image.naturalHeight);
      state.cwBoard?.invalidate();
      resetCoursewareViewport({ atBottom: false });
    };
    image.src = cw.url;
    image.hidden = false;
    $('cwStageHint').hidden = true;
    state.cwBoard?.setEnabled(true);
    state.cwBoard?.invalidate();
    resetCoursewareViewport({ atBottom: false });
    return;
  }

  $('cwPageCanvas').hidden = true;
  $('cwPageImage').hidden = true;
  $('cwStageHint').hidden = false;
  $('cwStageHint').textContent =
    kind === 'link' ? '链接课件由大屏直接打开，不支持在 iPad 上标注' : '该课件暂不支持在 iPad 上预览标注';
  state.cwBoard?.setEnabled(false);
}

async function loadCoursewarePdf(cw) {
  const hint = $('cwStageHint');
  $('cwPageCanvas').hidden = true;
  $('cwPageImage').hidden = true;

  if (state.cwPdf.doc && state.cwPdf.url === cw.url) {
    hint.hidden = true;
    await renderCoursewarePage(state.courseware?.page || 1);
    return;
  }

  hint.hidden = false;
  hint.textContent = '正在加载课件预览...';
  try {
    const doc = await openPdfDocument(cw.url);
    if (state.courseware !== cw) {
      destroyPdfDocument(doc);
      return;
    }
    destroyPdfDocument(state.cwPdf.doc);
    state.cwPdf.doc = doc;
    state.cwPdf.url = cw.url;
    state.cwPdf.pageCount = doc.numPages || 0;
    if (state.courseware && doc.numPages > 0 && state.courseware.pageCount !== doc.numPages) {
      state.courseware.pageCount = doc.numPages;
    }
    hint.hidden = true;
    await renderCoursewarePage(state.courseware?.page || 1);
    updateCoursewareStatus();
  } catch (error) {
    hint.hidden = false;
    hint.textContent = `课件预览加载失败：${error.message || '未知错误'}`;
    state.cwBoard?.setEnabled(false);
  }
}

/** 渲染第 page 页；atBottom = true 时落在页面底部（向前翻页，便于向上逐屏回顾） */
async function renderCoursewarePage(page, { atBottom = false } = {}) {
  const doc = state.cwPdf.doc;
  if (!doc) return;
  const total = state.cwPdf.pageCount || doc.numPages || 1;
  const target = clamp(Math.round(page) || 1, 1, total);

  if (state.cwPdf.rendering) {
    state.cwPdf.pendingPage = target;
    return;
  }
  state.cwPdf.rendering = true;
  try {
    const canvas = $('cwPageCanvas');
    await renderPdfPage(doc, target, canvas);
    if (!state.courseware) return;
    canvas.hidden = false;
    $('cwStageHint').hidden = true;
    // 显式锁定显示比例：canvas 按页面比例铺满舞台宽度（FitWidth）
    applyCoursewareSurfaceRatio(canvas, canvas.width, canvas.height);
    applyCoursewarePageAnnotations(target);
    state.cwBoard?.setEnabled(true);
    // 换页后复位视口并同步大屏（同安卓 showPage → setImage → resetViewport）
    resetCoursewareViewport({ atBottom });
    state.cwBoard?.invalidate();
  } catch {
    $('cwStageHint').hidden = false;
    $('cwStageHint').textContent = `第 ${target} 页渲染失败`;
  } finally {
    state.cwPdf.rendering = false;
    const pending = state.cwPdf.pendingPage;
    state.cwPdf.pendingPage = 0;
    if (pending && pending !== target) await renderCoursewarePage(pending, { atBottom });
  }
}

/** 翻页时按页存取笔迹（与 Android MainActivity 中 coursewarePdfStrokes 一致） */
function applyCoursewarePageAnnotations(page) {
  const board = state.cwBoard;
  if (!board) return;
  const store = state.cwStrokes.store;
  const previous = state.cwStrokes.page;
  if (previous && previous !== page) {
    const saved = board.currentStrokes();
    if (saved.length > 0) store.set(previous, saved);
    else store.delete(previous);
  }
  state.cwStrokes.page = page;
  board.replaceStrokes(store.get(page) || []);
}

function releaseCoursewarePreview() {
  destroyPdfDocument(state.cwPdf.doc);
  state.cwPdf.doc = null;
  state.cwPdf.url = '';
  state.cwPdf.pageCount = 0;
  state.cwPdf.pendingPage = 0;
  state.cwStrokes.store.clear();
  state.cwStrokes.page = 0;
  setCoursewarePenMode(false);
  state.cwBoard?.setEnabled(false);
  state.cwBoard?.reset();
  resetCwViewState();
  $('cwPageCanvas').hidden = true;
  $('cwPageImage').hidden = true;
  $('cwAnnotationCanvas').hidden = true;
  $('cwAnnotationBar').hidden = true;
  $('cwStageHint').hidden = false;
  $('cwStageHint').textContent = '正在打开课件...';
}

function clearCourseware() {
  state.courseware = null;
  releaseCoursewarePreview();
}

// ------------------------------------------------- 课件预览视口（缩放 / 平移 / 逐屏）
// 与安卓端 ZoomableImageView（FitWidth + userScale / translateX / translateY）完全同构：
//  - 内容按宽度充满舞台显示（FitWidth），长页可上下拖动查看；
//  - 缩放 / 平移实时同步大屏（progress 协议 + page），两端屏幕比例不同也能保持一致；
//  - 「上一页 / 下一页」先逐屏滚动，滚到页面边界才真正翻页。
// 坐标口径：translate 为"内容中心相对舞台中心"的像素位移，
// 变换链与 ZoomableImageView.onDraw 的 translate → scale 完全一致。

const CW_MAX_SCALE = 8; // 同 ZoomableImageView.MAX_SCALE
const CW_NOTIFY_INTERVAL_MS = 80; // 同 ZoomableImageView.NOTIFY_INTERVAL_MS
const CW_DOUBLE_TAP_SCALE = 2.5; // 同 ZoomableImageView.DOUBLE_TAP_SCALE
const CW_SCREEN_STEP_RATIO = 0.92; // 逐屏滚动留 8% 重叠，避免相邻屏内容割裂
const BIG_SCREEN_H_OVER_W = 9 / 16; // 大屏按 16:9 横屏估算（同安卓 stepBigScreen）

function coursewareStage() {
  return $('cwStage');
}

function coursewareStageSize() {
  const stage = coursewareStage();
  if (!stage) return { width: 0, height: 0 };
  const rect = stage.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}

/** 内容的布局尺寸（不含 transform），对应安卓端的 fitWidth / fitHeight */
function coursewareBaseSize() {
  const surface = coursewareSurface();
  if (!surface || surface.hidden) return { width: 0, height: 0 };
  return { width: surface.offsetWidth || 0, height: surface.offsetHeight || 0 };
}

/** 内容原始像素尺寸（位图 / 图片），用于估算大屏是否为长页 */
function coursewareNaturalSize() {
  const canvas = $('cwPageCanvas');
  if (!canvas.hidden && canvas.width && canvas.height) {
    return { width: canvas.width, height: canvas.height };
  }
  const image = $('cwPageImage');
  if (!image.hidden && image.naturalWidth && image.naturalHeight) {
    return { width: image.naturalWidth, height: image.naturalHeight };
  }
  return { width: 0, height: 0 };
}

/** 本地预览已就绪：后续翻页由 iPad 主导（同安卓 coursewarePdfPaging != null） */
function coursewarePreviewReady() {
  if (!state.courseware || state.cwBoard?.enabled !== true) return false;
  const base = coursewareBaseSize();
  return base.width > 0 && base.height > 0;
}

/** 显式锁定显示比例，保证 canvas / img 都按页面比例铺满舞台宽度 */
function applyCoursewareSurfaceRatio(surface, width, height) {
  if (!surface || !width || !height) return;
  surface.style.aspectRatio = `${width} / ${height}`;
}

function coursewareMaxTranslation() {
  const view = state.cwView;
  const base = coursewareBaseSize();
  const stage = coursewareStageSize();
  if (!base.width || !base.height || !stage.width || !stage.height) return { x: 0, y: 0 };
  return {
    x: Math.max(0, (base.width * view.scale - stage.width) / 2),
    y: Math.max(0, (base.height * view.scale - stage.height) / 2)
  };
}

function clampCoursewareTranslation() {
  const view = state.cwView;
  const max = coursewareMaxTranslation();
  view.translateX = clamp(view.translateX, -max.x, max.x);
  view.translateY = clamp(view.translateY, -max.y, max.y);
}

function applyCoursewareView({ notify = true, force = false } = {}) {
  const surface = coursewareSurface();
  if (!surface) return;
  clampCoursewareTranslation();
  const view = state.cwView;
  surface.style.transformOrigin = 'center center';
  surface.style.transform =
    `translate(${view.translateX}px, ${view.translateY}px) scale(${view.scale})`;
  // 显示矩形变化后按新矩形重画笔迹（笔迹坐标以内容显示矩形为基准）
  state.cwBoard?.invalidate();
  updateCoursewareStatus();
  if (notify) notifyCoursewareViewport(force);
}

function notifyCoursewareViewport(force = false) {
  const view = state.cwView;
  const base = coursewareBaseSize();
  const stage = coursewareStageSize();
  if (!base.width || !base.height || !stage.width || !stage.height) return;
  const signaling = state.signaling;
  if (!signaling?.isOpen()) return;
  const now = Date.now();
  if (!force && now - view.lastNotifyAt < CW_NOTIFY_INTERVAL_MS) return;
  view.lastNotifyAt = now;
  const max = coursewareMaxTranslation();
  // 滚动进度：0 = 顶部/左侧对齐，1 = 底部/右侧对齐；整页可显示时为 0（顶部对齐）。
  // 用进度而非"视口中心位置"归一化，可消除两端屏幕比例不同造成的错位。
  const progressX = max.x > 0.5 ? (max.x - view.translateX) / (2 * max.x) : 0;
  const progressY =
    max.y > 0.5
      ? (max.y - view.translateY) / (2 * max.y)
      : view.bigScrollActive
        ? view.bigProgressY
        : 0;
  signaling.sendCoursewareImageViewport({
    scale: view.scale,
    centerX: Math.round(progressX * 10000) / 10000,
    centerY: Math.round(progressY * 10000) / 10000,
    rotation: 0, // 课件页方向固定，同安卓硬编码 0
    page: Number(state.courseware?.page) || 0,
    progress: true
  });
}

/** 一次手势内同时完成"围绕焦点缩放"与"平移"，只重绘一次（同安卓 handleTwoFingerGesture） */
function applyCoursewareGesture({ factor = 1, focusX = 0, focusY = 0, dx = 0, dy = 0 }) {
  const view = state.cwView;
  const previous = view.scale;
  const next = clamp(previous * factor, 1, CW_MAX_SCALE);
  if (next !== previous) {
    const ratio = next / previous;
    view.translateX = (view.translateX - focusX) * ratio + focusX;
    view.translateY = (view.translateY - focusY) * ratio + focusY;
    view.scale = next;
  }
  view.translateX += dx;
  view.translateY += dy;
  applyCoursewareView();
}

function toggleCoursewareZoom(point) {
  const view = state.cwView;
  if (view.scale > 1.01) {
    view.scale = 1;
    applyCoursewareView({ force: true });
    return;
  }
  const rect = coursewareStage().getBoundingClientRect();
  applyCoursewareGesture({
    factor: CW_DOUBLE_TAP_SCALE,
    focusX: point.x - (rect.left + rect.width / 2),
    focusY: point.y - (rect.top + rect.height / 2)
  });
  notifyCoursewareViewport(true);
}

/** 清空视口状态与残留 transform / 比例（关闭课件、释放本地预览时用） */
function resetCwViewState() {
  const view = state.cwView;
  view.scale = 1;
  view.translateX = 0;
  view.translateY = 0;
  view.bigScrollActive = false;
  view.bigProgressY = 0;
  view.lastNotifyAt = 0;
  for (const element of [$('cwPageCanvas'), $('cwPageImage')]) {
    if (!element) continue;
    element.style.removeProperty('transform');
    element.style.removeProperty('aspect-ratio');
  }
}

/** 换页 / 打开课件后复位视口（安卓 ZoomableImageView.resetViewport） */
function resetCoursewareViewport({ atBottom = false, notify = true } = {}) {
  const view = state.cwView;
  view.scale = 1;
  view.translateX = 0;
  view.translateY = 0;
  view.bigScrollActive = false;
  view.bigProgressY = 0;
  const base = coursewareBaseSize();
  const stage = coursewareStageSize();
  if (base.height && stage.height) {
    // 宽度充满后页面可能高于舞台：默认从顶部开始显示；
    // 向前翻页（atBottom）时落在上一页底部，继续按"上一页"可向上逐屏回顾。
    const maxY = Math.max(0, (base.height - stage.height) / 2);
    view.translateY = atBottom ? -maxY : maxY;
    if (atBottom && maxY <= 0.5) {
      // iPad 整页可显示：交给"大屏滚动模式"把大屏对齐到上一页底部
      view.bigScrollActive = true;
      view.bigProgressY = 1;
    }
  }
  applyCoursewareView({ notify, force: true });
}

/** 舞台尺寸变化后重新适配（安卓 ZoomableImageView.onSizeChanged） */
function refitCoursewareViewport() {
  const view = state.cwView;
  if (view.scale <= 1.01) {
    const base = coursewareBaseSize();
    const stage = coursewareStageSize();
    if (base.height && stage.height) {
      view.translateX = 0;
      view.translateY = (base.height - stage.height) / 2; // 未放大时回到顶部对齐
    }
  }
  applyCoursewareView({ force: true });
}

/**
 * 「下一屏 / 上一屏」滚动（同安卓 ZoomableImageView.requestScreenStep）
 * @returns true 表示应当真正翻页（已滚到边界、整页一屏能显示完、或处于放大状态）
 */
function requestCoursewareScreenStep(direction) {
  const view = state.cwView;
  const base = coursewareBaseSize();
  const stage = coursewareStageSize();
  if (!base.width || !base.height || !stage.height) return true;

  // 放大状态：直接翻页，缩放由渲染新页时的 resetCoursewareViewport 复位
  if (view.scale > 1.01) return true;

  const displayHeight = base.height * view.scale;
  const viewHeight = stage.height;
  if (displayHeight <= viewHeight) {
    // iPad 整页可显示：大屏（横屏）往往是长页，改用大屏滚动进度驱动大屏逐屏下滚，
    // 滚到底再翻页，避免 iPad 整页直接翻页导致大屏不滚动。
    return stepCoursewareBigScreen(direction);
  }

  view.bigScrollActive = false;
  const maxY = (displayHeight - viewHeight) / 2;
  const atBottom = view.translateY <= -maxY + 0.5;
  const atTop = view.translateY >= maxY - 0.5;
  if (direction > 0 && atBottom) return true;
  if (direction < 0 && atTop) return true;

  view.translateY = clamp(
    view.translateY - direction * viewHeight * CW_SCREEN_STEP_RATIO,
    -maxY,
    maxY
  );
  applyCoursewareView({ force: true });
  return false;
}

/**
 * 大屏滚动模式：iPad 整页可显示、但按 16:9 估算大屏是长页时，
 * 用 bigProgressY 驱动大屏逐屏滚动，滚到底/顶才返回 true 让 iPad 翻页。
 * 同安卓 ZoomableImageView.stepBigScreen。
 */
function stepCoursewareBigScreen(direction) {
  const view = state.cwView;
  const natural = coursewareNaturalSize();
  if (!natural.width || !natural.height) return true;

  const pageAspectHOverW = natural.height / natural.width;
  const bigMaxYRatio = (pageAspectHOverW - BIG_SCREEN_H_OVER_W) / 2;
  if (bigMaxYRatio <= 0) {
    // 大屏也是整页
    view.bigScrollActive = false;
    view.bigProgressY = 0;
    return true;
  }
  if (!view.bigScrollActive) {
    view.bigScrollActive = true;
    view.bigProgressY = 0;
  }
  if (
    (direction > 0 && view.bigProgressY >= 1 - 1e-4) ||
    (direction < 0 && view.bigProgressY <= 1e-4)
  ) {
    // 已到边界：本次才翻页。
    // 此处不能上报视口：当前页尚未换掉，上报会把大屏拉回"本页顶部"，
    // 造成翻页前闪一下本页顶部的画面（安卓在此处同样刻意不上报）。
    view.bigScrollActive = false;
    view.bigProgressY = 0;
    return true;
  }
  const stepRatio = (BIG_SCREEN_H_OVER_W * CW_SCREEN_STEP_RATIO) / (2 * bigMaxYRatio);
  view.bigProgressY = clamp(view.bigProgressY + direction * stepRatio, 0, 1);
  notifyCoursewareViewport(true);
  updateCoursewareStatus();
  return false;
}

/** 估算当前页的屏数，用于「第 x / y 屏」提示（仅显示用，不参与定位） */
function coursewareScreenInfo() {
  const view = state.cwView;
  const base = coursewareBaseSize();
  const stage = coursewareStageSize();
  if (!base.height || !stage.height) return null;

  if (view.bigScrollActive) {
    const natural = coursewareNaturalSize();
    if (!natural.width || !natural.height) return null;
    const bigMaxYRatio = (natural.height / natural.width - BIG_SCREEN_H_OVER_W) / 2;
    if (bigMaxYRatio <= 0) return null;
    const stepRatio = (BIG_SCREEN_H_OVER_W * CW_SCREEN_STEP_RATIO) / (2 * bigMaxYRatio);
    const total = Math.max(2, Math.ceil(1 / stepRatio) + 1);
    return {
      screen: clamp(Math.round(view.bigProgressY * (total - 1)) + 1, 1, total),
      count: total
    };
  }

  const displayHeight = base.height * view.scale;
  if (displayHeight <= stage.height + 1) return null;
  const range = displayHeight - stage.height;
  const maxY = range / 2;
  const steps = Math.max(1, Math.ceil(range / (stage.height * CW_SCREEN_STEP_RATIO)));
  const count = steps + 1;
  const progress = maxY > 0.5 ? (maxY - view.translateY) / (2 * maxY) : 0;
  return { screen: clamp(Math.round(progress * steps) + 1, 1, count), count };
}

/** 课件舞台手势：双指缩放 + 双指平移 + 单指平移 + 双击缩放（同安卓 ZoomableImageView） */
function bindCoursewareGestures() {
  const stage = coursewareStage();
  if (!stage) return;
  let twoFingerActive = false;
  let lastCenter = null;
  let lastSpan = 0;
  let lastSingle = null;
  let lastTapAt = 0;
  let lastTapPoint = null;

  const pointsOf = (event) => Array.from(event.touches || []).map((p) => ({ x: p.clientX, y: p.clientY }));
  const distOf = (pts) => Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  const centerOf = (pts) => ({ x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 });
  const focusOf = (point) => {
    const rect = stage.getBoundingClientRect();
    return {
      x: point.x - (rect.left + rect.width / 2),
      y: point.y - (rect.top + rect.height / 2)
    };
  };

  stage.addEventListener('touchstart', (event) => {
    if (!coursewarePreviewReady()) return;
    const pts = pointsOf(event);
    if (pts.length >= 2) {
      // 第二根手指落下：先结束当前笔画，再进入双指缩放 / 平移（与安卓一致）
      state.cwBoard?.endActiveStroke(true);
      twoFingerActive = true;
      lastSpan = distOf(pts);
      lastCenter = centerOf(pts);
      lastSingle = null;
      lastTapAt = 0;
      lastTapPoint = null;
    } else if (pts.length === 1) {
      lastSingle = { x: pts[0].x, y: pts[0].y };
      lastCenter = null;
      lastSpan = 0;
      // 双击缩放（画笔模式下禁用，避免绘制过程中的误触）
      if (state.cwBoard?.penMode) return;
      const now = Date.now();
      const near =
        lastTapPoint && Math.hypot(pts[0].x - lastTapPoint.x, pts[0].y - lastTapPoint.y) < 36;
      if (near && now - lastTapAt < 320) {
        toggleCoursewareZoom(pts[0]);
        lastTapAt = 0;
        lastTapPoint = null;
      } else {
        lastTapAt = now;
        lastTapPoint = { x: pts[0].x, y: pts[0].y };
      }
    }
  }, { passive: true });

  stage.addEventListener('touchmove', (event) => {
    if (!coursewarePreviewReady()) return;
    const pts = pointsOf(event);
    if (pts.length >= 2 && twoFingerActive) {
      const center = centerOf(pts);
      const span = distOf(pts);
      const focus = focusOf(center);
      applyCoursewareGesture({
        factor: lastSpan > 0 && span > 0 ? span / lastSpan : 1,
        focusX: focus.x,
        focusY: focus.y,
        dx: lastCenter ? center.x - lastCenter.x : 0,
        dy: lastCenter ? center.y - lastCenter.y : 0
      });
      lastCenter = center;
      lastSpan = span;
      lastSingle = null;
      lastTapAt = 0;
      lastTapPoint = null;
      event.preventDefault();
      return;
    }
    // 画笔模式：单指留给绘制，缩放 / 平移靠双指（不必来回切模式）
    if (state.cwBoard?.penMode) return;
    if (pts.length === 1 && lastSingle) {
      applyCoursewareGesture({ dx: pts[0].x - lastSingle.x, dy: pts[0].y - lastSingle.y });
      lastSingle = { x: pts[0].x, y: pts[0].y };
      lastTapAt = 0;
      lastTapPoint = null;
      event.preventDefault();
    }
  }, { passive: false });

  const release = (event) => {
    const remaining = pointsOf(event);
    twoFingerActive = false;
    lastSpan = 0;
    lastCenter = null;
    lastSingle = remaining.length === 1 ? { x: remaining[0].x, y: remaining[0].y } : null;
    if (remaining.length === 0) notifyCoursewareViewport(true);
  };
  stage.addEventListener('touchend', release, { passive: true });
  stage.addEventListener('touchcancel', release, { passive: true });

  // 桌面 / 触控板调试用：滚轮缩放
  stage.addEventListener('wheel', (event) => {
    if (!coursewarePreviewReady()) return;
    const rect = stage.getBoundingClientRect();
    applyCoursewareGesture({
      factor: event.deltaY < 0 ? 1.08 : 1 / 1.08,
      focusX: event.clientX - (rect.left + rect.width / 2),
      focusY: event.clientY - (rect.top + rect.height / 2)
    });
    notifyCoursewareViewport(true);
    event.preventDefault();
  }, { passive: false });
}

// ---------------------------------------------------------------- 课件

function showCoursewareSource() {
  state.screen = 'CoursewareSource';
  showView('CoursewareSource');
}

async function loadServerCourseware({ forManage = false } = {}) {
  if (!state.coursewareClient) return;
  state.screen = 'CoursewareList';
  showView('CoursewareList');
  $('cwListBody').innerHTML = '<p class="list-empty">正在加载服务器暂存课件...</p>';

  try {
    const items = await state.coursewareClient.list();
    renderCoursewareList(items, forManage);
  } catch (error) {
    $('cwListBody').innerHTML = `<p class="list-empty">${error.message || '加载失败'}</p>`;
  }
}

function renderCoursewareList(items, forManage) {
  const body = $('cwListBody');
  body.innerHTML = '';
  if (items.length === 0) {
    body.innerHTML = '<p class="list-empty">暂无课件</p>';
    return;
  }

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'cw-item';

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'cw-item-main';
    main.innerHTML = `
      <span class="cw-item-title"></span>
      <span class="cw-item-meta"></span>
    `;
    main.querySelector('.cw-item-title').textContent = item.title || item.fileName || '未命名课件';
    main.querySelector('.cw-item-meta').textContent =
      `${coursewareFormatLabel(item)} · ${formatBytes(item.size)} · ${formatDate(item.createdAt)}`;

    main.addEventListener('click', () => {
      if (forManage) {
        toast('连接教室后可在功能菜单中打开课件');
        return;
      }
      openCourseware(item);
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'cw-item-del';
    del.textContent = '删除';
    del.addEventListener('click', () => confirmDeleteCourseware(item));

    row.appendChild(main);
    row.appendChild(del);
    body.appendChild(row);
  }
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function confirmDeleteCourseware(item) {
  if (!window.confirm(`确定删除《${item.title || item.fileName}》？`)) return;
  try {
    await state.coursewareClient.remove(item.id);
    toast('课件已删除');
    await loadServerCourseware();
  } catch (error) {
    toast(error.message || '删除失败', { warn: true });
  }
}

function pickCoursewareFile() {
  const input = $('viewCoursewareSource').hidden ? $('cwListFileInput') : $('cwFileInput');
  input.value = '';
  input.click();
}

async function uploadCourseware(file) {
  if (!file) return;
  const controller = new AbortController();
  state.uploadAbort = controller;
  showOverlay(`正在上传：${file.name}`, {
    progress: true,
    onCancel: () => controller.abort()
  });

  try {
    const result = await state.coursewareClient.upload(
      file,
      (ratio) => {
        setOverlayProgress(ratio);
        setOverlayText(
          `正在上传：${file.name}\n${Math.round(ratio * 100)}%（${formatBytes(file.size)}）`
        );
      },
      controller.signal
    );
    setOverlayText('上传完成，服务器正在处理...');
    setOverlayProgress(1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    hideOverlay();
    toast('课件已上传');

    if (state.joined) {
      openCourseware({ id: result.id, url: result.url, title: result.title || file.name });
    } else {
      toast('请先连接教室端再打开课件', { warn: true });
      showCoursewareSource();
    }
  } catch (error) {
    hideOverlay();
    if (error.message !== '__ABORTED__') {
      toast(error.message || '课件上传失败', { warn: true, duration: 3500 });
    }
  } finally {
    state.uploadAbort = null;
  }
}

function openCourseware(item) {
  if (!state.joined) {
    toast('请先连接教室端', { warn: true });
    return;
  }

  // 改播课件时清掉图片视频队列，避免投屏界面残留切换按钮
  resetMediaCastState();
  stopLive({ notify: false });
  state.signaling?.sendStop();

  state.courseware = {
    id: item.id || null,
    url: item.url,
    title: item.title || item.fileName || '课件',
    page: 1,
    pageCount: 1,
    screen: 1,
    screenCount: 1,
    fitMode: 'fit-page',
    linkUrl: item.linkUrl || null
  };

  state.signaling?.sendCoursewareOpen({
    url: state.courseware.url,
    title: state.courseware.title,
    page: 1,
    screen: 1,
    linkUrl: state.courseware.linkUrl
  });

  state.screen = 'CoursewarePlay';
  showView('CoursewarePlay');
  updateCoursewareStatus();
  // 本地渲染课件页面，供 iPad 上直接标注（失败不影响大屏播放）
  prepareCoursewarePreview().catch(() => {});
  toast(state.courseware.linkUrl ? '链接课件已推送到大屏' : '课件已打开');
}

function updateCoursewareStatus() {
  const cw = state.courseware;
  if (!cw) return;
  $('cwPlayTitle').textContent = cw.title;
  // 本地预览可用时以本机滚动状态为准（大屏端现在按滚动进度联动，不再上报屏数）
  const local = coursewareScreenInfo();
  const localText = local && local.count > 1 ? `，第 ${local.screen} / ${local.count} 屏` : '';
  const remoteText = cw.screenCount > 1 ? `，第 ${cw.screen} / ${cw.screenCount} 屏` : '';
  const zoomText = state.cwView.scale > 1.02 ? `，${state.cwView.scale.toFixed(1)}x` : '';
  $('cwPlayStatus').textContent = `第 ${cw.page} / ${cw.pageCount} 页${localText || remoteText}${zoomText}`;
  $('cwPageInput').placeholder = `1-${cw.pageCount}`;
}

function handleCoursewareState(message) {
  if (!state.courseware) return;
  const remotePage = Math.max(1, Number(message.page) || 1);
  // 本地刚发起翻页时，大屏可能还没渲染完就回传了旧页码，
  // 直接采信会把 iPad 的页码改回去造成来回跳页（同安卓对 courseware.state 的处理）。
  const pagingLocally = Date.now() < (state.cwPdf.ignoreRemotePageUntil || 0);
  if (remotePage !== state.courseware.page && !pagingLocally) {
    state.courseware.page = remotePage;
    renderCoursewarePage(remotePage);
  }
  // 本地 PDF 已加载时页数以本地为准（最准确）
  state.courseware.pageCount = Math.max(
    Number(state.cwPdf.pageCount) || 0,
    Math.max(1, Number(message.pageCount) || 1)
  );
  state.courseware.screen = Math.max(1, Number(message.screen) || 1);
  state.courseware.screenCount = Math.max(1, Number(message.screenCount) || 1);
  if (message.fitMode) state.courseware.fitMode = message.fitMode;
  if (state.screen === 'CoursewarePlay') updateCoursewareStatus();
}

function handleViewerCoursewareOpen(message) {
  if (!message?.url) return;
  // 大屏端直接打开的课件：同步显示翻页界面，不回发 open 避免循环
  state.courseware = {
    id: null,
    url: message.url,
    title: message.title || '课件',
    page: Math.max(1, Number(message.page) || 1),
    pageCount: 1,
    screen: Math.max(1, Number(message.screen) || 1),
    screenCount: 1,
    fitMode: 'fit-page',
    linkUrl: null
  };
  state.screen = 'CoursewarePlay';
  showView('CoursewarePlay');
  updateCoursewareStatus();
  // 大屏端直接打开的课件也要在本地渲染，才能用 iPad 标注
  prepareCoursewarePreview().catch(() => {});
}

function handleViewerCoursewareClose() {
  if (state.screen === 'MediaCast' || state.screen === 'MediaQueue') {
    // 大屏端关闭了正在投屏的图片/视频：不回发关闭信号，避免循环
    resetMediaCastState();
    showMenu();
    return;
  }
  if (state.screen !== 'CoursewarePlay') return;
  // 不回发关闭信号，避免与大屏端形成循环
  clearCourseware();
  showMenu();
}

/**
 * 上一页 / 下一页的统一入口（同安卓 MainActivity.pagingOrStep）：
 * 本地预览可用时由 iPad 主导——先在页面内逐屏滚动，滚到边界才真正翻页；
 * 没有本地预览（链接课件、预览加载失败等）才退化成 courseware.navigate 由大屏处理。
 */
function navigateCourseware(delta) {
  if (!state.joined || !state.courseware) return;
  if (coursewarePreviewReady()) {
    if (requestCoursewareScreenStep(delta)) flipCoursewarePage(delta);
    else updateCoursewareStatus();
    return;
  }
  state.signaling?.sendCoursewareNavigate(delta);
}

/** 真正翻页：本地换页并同步大屏（同安卓 showPage） */
function flipCoursewarePage(delta) {
  const cw = state.courseware;
  const total = Math.max(1, Number(state.cwPdf.pageCount) || Number(cw.pageCount) || 1);
  const current = Number(cw.page) || 1;
  const target = clamp(current + delta, 1, total);
  if (target === current) {
    // 已经在首页 / 末页：只刷新提示，不再重复发信令
    updateCoursewareStatus();
    toast(delta > 0 ? '已经是最后一页' : '已经是第一页');
    return;
  }
  jumpToCoursewarePage(target, { atBottom: delta < 0 });
}

/** 切换到指定页：本地立刻换页 + 同步大屏（翻页与跳页共用，避免两端页码不一致） */
function jumpToCoursewarePage(target, { atBottom = false } = {}) {
  const cw = state.courseware;
  if (!cw) return;
  // 这段时间忽略大屏回传的旧页码，避免刚跳过去又被拉回来
  state.cwPdf.ignoreRemotePageUntil = Date.now() + 1500;
  cw.page = target;
  cw.screen = 1;
  // 课件一律走 courseware.page：大屏会优先把 courseware.navigate 解释成"翻屏"而不是"翻页"
  state.signaling?.sendCoursewarePage(target);
  if (coursewarePreviewKind(cw) === 'pdf') {
    renderCoursewarePage(target, { atBottom });
  } else {
    resetCoursewareViewport({ atBottom });
  }
  updateCoursewareStatus();
}

function gotoCoursewarePage() {
  const raw = $('cwPageInput').value.trim();
  const page = Number(raw);
  if (!Number.isFinite(page) || page < 1) {
    toast('请输入有效页码', { warn: true });
    return;
  }
  if (!state.joined || !state.courseware) return;
  // 只有本地 PDF 已加载（知道真实页数）时才做范围收敛，否则照原样跳转
  const knownTotal = Number(state.cwPdf.pageCount) || 0;
  const target = knownTotal > 0 ? clamp(Math.floor(page), 1, knownTotal) : Math.floor(page);
  jumpToCoursewarePage(target);
  $('cwPageInput').value = '';
}

function stopCoursewareSignals() {
  const stopSent = state.signaling?.sendStop() === true;
  const closeSent = state.signaling?.sendCoursewareClose() === true;
  return stopSent || closeSent;
}

function stopCourseware({ silent = false } = {}) {
  if (!state.courseware) return;
  clearCourseware();
  if (silent) return;
  if (!stopCoursewareSignals() && state.roomCode) {
    state.pendingCoursewareClose = true;
    ensureSignaling().join(state.roomCode, state.token);
  }
  showMenu();
}

// 长按连续翻页
function bindPageLongPress(buttonId, delta) {
  const button = $(buttonId);
  let holdTimer = null;
  let repeatTimer = null;
  let longPressed = false;

  const stop = () => {
    clearTimeout(holdTimer);
    clearInterval(repeatTimer);
    holdTimer = null;
    repeatTimer = null;
  };

  button.addEventListener('touchstart', () => {
    longPressed = false;
    holdTimer = setTimeout(() => {
      longPressed = true;
      repeatTimer = setInterval(() => navigateCourseware(delta), 260);
    }, 420);
  }, { passive: true });

  button.addEventListener('touchend', () => {
    stop();
    // 长按刚结束时浏览器还会补发一次 click，用标志位避免多翻一页
    setTimeout(() => {
      longPressed = false;
    }, 350);
  });
  button.addEventListener('touchcancel', () => {
    stop();
    longPressed = false;
  });
  button.addEventListener('click', () => {
    if (longPressed) return;
    navigateCourseware(delta);
  });
}

// ---------------------------------------------------------------- 其他交互

function renderQualityOptions() {
  const select = $('qualitySelect');
  select.innerHTML = '';
  for (const [key, preset] of Object.entries(QUALITY_PRESETS)) {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = preset.label;
    select.appendChild(option);
  }
  select.value = QUALITY_PRESETS[state.quality] ? state.quality : 'standard';
}

function bindStaticEvents() {
  $('authLogin').addEventListener('click', () => performAuth(false));
  $('authRegister').addEventListener('click', () => performAuth(true));
  $('authPassword').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') performAuth(false);
  });

  $('connectButton').addEventListener('click', () => connectToRoom($('roomCodeInput').value.trim()));
  $('roomCodeInput').addEventListener('input', (event) => {
    event.target.value = event.target.value.replace(/\D/g, '').slice(0, 4);
  });
  $('roomCodeInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') connectToRoom($('roomCodeInput').value.trim());
  });
  $('switchUserButton').addEventListener('click', () => {
    disconnectAndBack();
    clearAuth();
    showAuth();
  });
  $('manageCoursewareButton').addEventListener('click', () => loadServerCourseware({ forManage: true }));

  $('menuCamera').addEventListener('click', () => openCameraLive());
  $('menuMedia').addEventListener('click', () => showMediaSource());
  $('menuCourseware').addEventListener('click', () => showCoursewareSource());
  $('menuDisconnect').addEventListener('click', () => disconnectAndBack());
  $('qualitySelect').addEventListener('change', (event) => {
    state.quality = event.target.value;
    storage.set('quality', state.quality);
    toast('下次开始直播时生效');
  });

  $('liveBack').addEventListener('click', () => exitLive());
  $('liveToggle').addEventListener('click', () => {
    if (state.liveActive) stopLive({ notify: true });
    else startLive();
  });
  $('switchCameraButton').addEventListener('click', async () => {
    setLiveMessage('正在切换镜头...');
    try {
      await state.pipeline.switchCamera();
      updateTorchButton();
      updateLiveUI();
      sendOrientationNow();
      delete $('liveStatus').dataset.userMessage;
      updateLiveStatus();
    } catch (error) {
      toast(error.message || '切换镜头失败', { warn: true });
    }
  });
  $('lockFrameButton').addEventListener('click', () => {
    const locked = state.pipeline.toggleLock();
    setLiveMessage(locked ? '画面已锁定' : '画面已恢复实时');
    updateLiveUI();
    if (!locked) {
      setTimeout(() => {
        delete $('liveStatus').dataset.userMessage;
        updateLiveStatus();
      }, 1200);
    }
  });
  $('torchButton').addEventListener('click', async () => {
    const next = !state.torchOn;
    const ok = await state.pipeline.setTorch(next);
    if (!ok) {
      toast('iPhone 网页版暂不支持补光灯，请使用环境光或开启闪光灯手电', { warn: true, duration: 3500 });
      return;
    }
    state.torchOn = next;
    updateTorchButton();
  });
  $('rotateButton').addEventListener('click', () => {
    const rotation = state.pipeline.rotateOnce();
    setLiveMessage(`画面旋转 ${rotation}°`);
    setTimeout(() => {
      delete $('liveStatus').dataset.userMessage;
      updateLiveStatus();
    }, 1000);
  });
  $('resetZoomButton').addEventListener('click', () => {
    state.pipeline.resetView();
    updateZoomBadge();
  });

  $('mediaLocalButton').addEventListener('click', () => openMediaPicker());
  $('mediaServerButton').addEventListener('click', () => loadServerMedia());
  $('mediaSourceBack').addEventListener('click', () => showMenu());

  $('mediaBack').addEventListener('click', () => showMenu());
  $('mediaRotate').addEventListener('click', () => rotateCurrentMedia());
  $('mediaPrev').addEventListener('click', () => switchMediaBy(-1));
  $('mediaNext').addEventListener('click', () => switchMediaBy(1));
  $('mediaListButton').addEventListener('click', () => showMediaQueue());
  $('mediaEndButton').addEventListener('click', () => stopMediaCast());

  $('mediaPlayToggle').addEventListener('click', () => sendVideoControl('toggle'));
  $('mediaSeekBack').addEventListener('click', () => seekVideoBy(-10));
  $('mediaSeekForward').addEventListener('click', () => seekVideoBy(10));
  $('mediaSeek').addEventListener('input', (event) => {
    const ratio = Number(event.target.value) / 1000;
    if (state.video.duration > 0) {
      $('mediaTime').textContent =
        `${formatMediaTime(ratio * state.video.duration)} / ${formatMediaTime(state.video.duration)}`;
    }
  });
  $('mediaSeek').addEventListener('change', (event) => seekVideoToRatio(Number(event.target.value) / 1000));
  $('mediaMute').addEventListener('click', () => {
    const next = !state.video.muted;
    state.video.muted = next;
    sendVideoControl('mute', { muted: next });
    updateMediaCastUI();
  });
  $('mediaVolume').addEventListener('change', (event) => {
    const volume = clamp(Number(event.target.value), 0, 100);
    state.video.volume = volume;
    if (volume <= 0) state.video.muted = true;
    sendVideoControl('volume', { volume });
    updateMediaCastUI();
  });

  $('mediaPenButton').addEventListener('click', () => toggleMediaPen());

  $('mediaQueueBack').addEventListener('click', () => backFromMediaQueue());
  $('mediaQueueAdd').addEventListener('click', () => openMediaPicker());

  $('cwServerButton').addEventListener('click', () => loadServerCourseware());
  $('cwUploadButton').addEventListener('click', () => pickCoursewareFile());
  $('cwSourceBack').addEventListener('click', () => showMenu());
  $('cwFileInput').addEventListener('change', (event) => uploadCourseware(event.target.files?.[0]));

  $('cwListBack').addEventListener('click', () => showMenu());
  $('cwListRefresh').addEventListener('click', () => loadServerCourseware());
  $('cwListUpload').addEventListener('click', () => pickCoursewareFile());
  $('cwListFileInput').addEventListener('change', (event) => uploadCourseware(event.target.files?.[0]));

  $('cwBackButton').addEventListener('click', () => showMenu());
  $('cwPenButton').addEventListener('click', () => setCoursewarePenMode(!state.cwBoard?.penMode));
  // 缩放 / 平移后一键回到「顶部对齐 + 1 倍」的默认视图
  $('cwResetView').addEventListener('click', () => {
    if (!coursewarePreviewReady()) {
      toast('当前课件不支持在 iPad 上预览', { warn: true });
      return;
    }
    resetCoursewareViewport({ atBottom: false });
    toast('已复位视图');
  });

  bindPageLongPress('cwPrevPage', -1);
  bindPageLongPress('cwNextPage', 1);
  $('cwGotoPage').addEventListener('click', () => gotoCoursewarePage());
  $('cwCloseButton').addEventListener('click', () => stopCourseware());

  bindLiveGestures();
  bindMediaGestures();
  // 课件预览的双指缩放 / 平移 / 双击放大（缺了这一步 iPad 上只能看不能操作画面）
  bindCoursewareGestures();
  $('mediaResetView').addEventListener('click', resetMediaView);

  window.addEventListener('orientationchange', () => {
    setTimeout(() => handleOrientationChange(), 300);
  });
  window.addEventListener('resize', () => {
    sendOrientationNow();
    // 容器尺寸变化后标注画布要重新按新尺寸绘制
    state.mediaBoard?.render();
    state.cwBoard?.render();
    // 课件预览要按新舞台尺寸重新适配并回到顶部对齐（同安卓 onSizeChanged）
    if (state.screen === 'CoursewarePlay') refitCoursewareViewport();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      state.lastHiddenAt = Date.now();
      return;
    }
    handleResume();
  });

  document.addEventListener('gesturestart', (event) => event.preventDefault());
}

let lastOrientationCategory = null;

function orientationCategory() {
  const angle = deviceAngle();
  return angle === 90 || angle === 270 ? 'landscape' : 'portrait';
}

/**
 * 屏幕在竖屏/横屏之间切换时，iOS 摄像头流的内容方向不会自动跟随
 * （Android 靠 WebRTC CVO 动态旋转，网页版 canvas 没有该机制）。
 * 因此重新采集一次，让 iOS 按当前方向初始化流，保证画面正立。
 */
async function handleOrientationChange() {
  sendOrientationNow();
  updateLiveStatus();

  const category = orientationCategory();
  if (category === lastOrientationCategory) return;
  lastOrientationCategory = category;

  // 仅在摄像头直播页（含预览与正在直播）时重建；图片投屏不需要
  if (state.screen !== 'Live' || state.liveMode !== 'camera') return;
  if (state.pipeline?.sourceKind !== 'camera') return;

  setLiveMessage('正在调整画面方向...');
  try {
    await state.pipeline.reopenCamera();
    sendOrientationNow();
    delete $('liveStatus').dataset.userMessage;
    updateLiveUI();
    updateLiveStatus();
  } catch (error) {
    setLiveMessage('方向调整失败，可点“旋转”修正');
  }
}

/** 从后台回到前台：恢复摄像头与推流（iOS 切后台会释放摄像头） */
async function handleResume() {
  if (state.screen !== 'Live' || state.liveMode !== 'camera') return;
  if (Date.now() - state.lastHiddenAt < 800) return;

  // 后台期间方向可能已变化，先同步（类别变化时内部会重建流并上报）
  if (orientationCategory() !== lastOrientationCategory) {
    await handleOrientationChange();
  }

  const track = state.pipeline?.cameraStream?.getVideoTracks?.()[0];
  if (!track || track.readyState === 'ended') {
    setLiveMessage('正在恢复摄像头...');
    try {
      const preset = QUALITY_PRESETS[state.quality] || QUALITY_PRESETS.standard;
      await state.pipeline.openCamera({
        facing: state.pipeline.facing || 'back',
        width: preset.width,
        height: preset.height,
        fps: preset.fps
      });
      if (state.liveActive) await restartLive();
      updateLiveStatus();
    } catch {
      setLiveMessage('摄像头恢复失败，请返回重试');
    }
    return;
  }

  if (state.liveActive) {
    const iceState = state.publisher?.iceConnectionState || '';
    if (iceState === 'failed' || iceState === 'disconnected' || iceState === 'closed') {
      await restartLive();
    }
  }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (!window.isSecureContext) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      /* 注册失败不影响使用 */
    });
  });
}

// ---------------------------------------------------------------- 启动

bootstrap();
// 记录初始方向类别，供旋转时判断是否需要重建摄像头流
lastOrientationCategory = orientationCategory();

if (!isIos()) {
  // 不是 iOS 也允许使用（便于桌面调试），但提示一次
  console.info('[MyClass] 当前不是 iOS 设备，页面以兼容模式运行');
}
if (isStandalone()) {
  console.info('[MyClass] 以全屏 App 模式运行');
}

// 轻量只读钩子：供自动化测试 / 网页内调试使用，不暴露任何凭据
window.__myclassApp = {
  get screen() {
    return state.screen;
  },
  get pipeline() {
    return state.pipeline;
  },
  get joined() {
    return state.joined;
  },
  openCamera: () => openCameraLive(),
  showImage: (file) => showImageLive(file)
};
