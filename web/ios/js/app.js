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
  deviceAngle,
  isStandalone,
  isIos
} from './util.js';
import { SignalingClient, resolveWebSocketUrl } from './signaling.js';
import { LivePublisher } from './publisher.js';
import { MediaPipeline } from './pipeline.js';
import { CoursewareClient, coursewareFormatLabel } from './courseware.js';

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
  resumeLiveAfterJoin: false,
  pendingCoursewareClose: false,
  uploadAbort: null,
  lastHiddenAt: 0
};

// ---------------------------------------------------------------- 引导

async function bootstrap() {
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
      onViewerCoursewareOpen: handleViewerCoursewareOpen,
      onViewerCoursewareClose: handleViewerCoursewareClose,
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
  toast(state.courseware.linkUrl ? '链接课件已推送到大屏' : '课件已打开');
}

function updateCoursewareStatus() {
  const cw = state.courseware;
  if (!cw) return;
  $('cwPlayTitle').textContent = cw.title;
  const screenText = cw.screenCount > 1 ? `，第 ${cw.screen} / ${cw.screenCount} 屏` : '';
  $('cwPlayStatus').textContent = `第 ${cw.page} / ${cw.pageCount} 页${screenText}`;
  $('cwPageInput').placeholder = `1-${cw.pageCount}`;
}

function handleCoursewareState(message) {
  if (!state.courseware) return;
  state.courseware.page = Math.max(1, Number(message.page) || 1);
  state.courseware.pageCount = Math.max(1, Number(message.pageCount) || 1);
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
}

function handleViewerCoursewareClose() {
  if (state.screen !== 'CoursewarePlay') return;
  // 不回发关闭信号，避免与大屏端形成循环
  state.courseware = null;
  showMenu();
}

function navigateCourseware(delta) {
  if (!state.joined || !state.courseware) return;
  state.signaling?.sendCoursewareNavigate(delta);
}

function gotoCoursewarePage() {
  const raw = $('cwPageInput').value.trim();
  const page = Number(raw);
  if (!Number.isFinite(page) || page < 1) {
    toast('请输入有效页码', { warn: true });
    return;
  }
  if (!state.joined || !state.courseware) return;
  state.signaling?.sendCoursewarePage(Math.floor(page));
  $('cwPageInput').value = '';
}

function stopCoursewareSignals() {
  const stopSent = state.signaling?.sendStop() === true;
  const closeSent = state.signaling?.sendCoursewareClose() === true;
  return stopSent || closeSent;
}

function stopCourseware({ silent = false } = {}) {
  if (!state.courseware) return;
  state.courseware = null;
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
  $('menuImage').addEventListener('click', () => openImagePicker());
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

  $('cwServerButton').addEventListener('click', () => loadServerCourseware());
  $('cwUploadButton').addEventListener('click', () => pickCoursewareFile());
  $('cwSourceBack').addEventListener('click', () => showMenu());
  $('cwFileInput').addEventListener('change', (event) => uploadCourseware(event.target.files?.[0]));

  $('cwListBack').addEventListener('click', () => showMenu());
  $('cwListRefresh').addEventListener('click', () => loadServerCourseware());
  $('cwListUpload').addEventListener('click', () => pickCoursewareFile());
  $('cwListFileInput').addEventListener('change', (event) => uploadCourseware(event.target.files?.[0]));

  bindPageLongPress('cwPrevPage', -1);
  bindPageLongPress('cwNextPage', 1);
  $('cwGotoPage').addEventListener('click', () => gotoCoursewarePage());
  $('cwCloseButton').addEventListener('click', () => stopCourseware());

  bindLiveGestures();

  window.addEventListener('orientationchange', () => {
    setTimeout(() => handleOrientationChange(), 300);
  });
  window.addEventListener('resize', () => {
    sendOrientationNow();
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
