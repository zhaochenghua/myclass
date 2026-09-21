const api = window.myclass;

const elements = {
  setupCard: document.getElementById('setupCard'),
  liveCard: document.getElementById('liveCard'),
  roomCode: document.getElementById('roomCode'),
  sourceSelectButton: document.getElementById('sourceSelectButton'),
  sourceSelectLabel: document.getElementById('sourceSelectLabel'),
  sourceMenu: document.getElementById('sourceMenu'),
  localAudioOutput: document.getElementById('localAudioOutput'),
  micAmplify: document.getElementById('micAmplify'),
  cursorHighlight: document.getElementById('cursorHighlight'),
  cursorHighlightButton: document.getElementById('cursorHighlightButton'),
  startButton: document.getElementById('startButton'),
  stopButton: document.getElementById('stopButton'),
  localAudioButton: document.getElementById('localAudioButton'),
  helpButton: document.getElementById('helpButton'),
  helpDialog: document.getElementById('helpDialog'),
  closeHelpButton: document.getElementById('closeHelpButton'),
  closeHelpAction: document.getElementById('closeHelpAction'),
  settingsButton: document.getElementById('settingsButton'),
  settingsDialog: document.getElementById('settingsDialog'),
  settingsServerUrl: document.getElementById('settingsServerUrl'),
  closeSettingsButton: document.getElementById('closeSettingsButton'),
  cancelSettingsAction: document.getElementById('cancelSettingsAction'),
  saveSettingsButton: document.getElementById('saveSettingsButton'),
  sourceSwitchDialog: document.getElementById('sourceSwitchDialog'),
  switchSourceSelectButton: document.getElementById('switchSourceSelectButton'),
  switchSourceSelectLabel: document.getElementById('switchSourceSelectLabel'),
  switchSourceMenu: document.getElementById('switchSourceMenu'),
  cancelSourceSwitchButton: document.getElementById('cancelSourceSwitchButton'),
  cancelSourceSwitchAction: document.getElementById('cancelSourceSwitchAction'),
  confirmSourceSwitchButton: document.getElementById('confirmSourceSwitchButton'),
  sourceSwitchMessage: document.getElementById('sourceSwitchMessage'),
  localPreview: document.getElementById('localPreview'),
  liveCode: document.getElementById('liveCode'),
  videoStatus: document.getElementById('videoStatus'),
  audioStatus: document.getElementById('audioStatus'),
  liveBadge: document.getElementById('liveBadge'),
  statusDot: document.getElementById('statusDot'),
  statusMessage: document.getElementById('statusMessage')
};

const state = {
  serverUrl: localStorage.getItem('myclass.serverUrl') || 'http://10.30.13.1/myclass',
  roomCode: '',
  config: null,
  mediaStream: null,
  rawStream: null,
  peerConnection: null,
  pendingCandidates: [],
  joined: false,
  viewerOnline: true,
  localAudioOutput: localStorage.getItem('myclass.localAudioOutput') !== 'false',
  localAudioMuted: false,
  micAmplify: localStorage.getItem('myclass.micAmplify') === 'true',
  micStream: null,
  cursorHighlight: localStorage.getItem('myclass.cursorHighlight') !== 'false',
  captureSourceId: '',
  captureSourceType: 'screen',
  sourceMonitorTimer: null,
    followingWindowProbe: false,
  switchingSource: false,
  sourceSwitchGeneration: 0,
  stopping: false,
  // 连接自愈相关（见「连接自愈」一节）
  everConnected: false,
  recovering: false,
  recoveryAttempts: 0,
  lastRecoveryAt: 0,
  watchdogTimer: null,
  watchdogBusy: false,
  lastVideoProgress: null,
  stallSince: 0,
  healthySince: 0,
  disconnectTimer: null,
  offerTimer: null,
  offerRetries: 0,
  lastOfferAt: 0
};

elements.settingsServerUrl.value = state.serverUrl;
elements.localAudioOutput.checked = state.localAudioOutput;
elements.micAmplify.checked = state.micAmplify;
elements.cursorHighlight.checked = state.cursorHighlight;

function setStatus(message, isError = false) {
  elements.statusMessage.textContent = message;
  elements.statusMessage.classList.toggle('is-error', isError);
  elements.statusDot.classList.toggle('is-error', isError);
  if (!isError) {
    elements.statusDot.classList.remove('is-error');
  }
  if (!isError && !state.mediaStream) {
    elements.statusDot.classList.remove('is-live');
  }
}

function setLiveStatus(message) {
  elements.liveBadge.textContent = message;
  elements.videoStatus.textContent = message;
}

// 投屏时控制面板会隐藏到托盘，用托盘提示文字反映连接是否被自动恢复过。
function setTrayStatus(text) {
  try {
    api.setTrayStatus?.(text);
  } catch {
    // 托盘不可用时忽略
  }
}

function updateCursorHighlightUi() {
  elements.cursorHighlight.checked = state.cursorHighlight;
  elements.cursorHighlightButton.textContent = state.cursorHighlight ? '关闭鼠标强调' : '开启鼠标强调';
}

async function setCursorHighlight(enabled) {
  state.cursorHighlight = Boolean(enabled);
  localStorage.setItem('myclass.cursorHighlight', String(state.cursorHighlight));
  updateCursorHighlightUi();
  try {
    await api.setCursorHighlight(state.cursorHighlight);
    // 窗口模式：强调点需合成进采集帧，切换开关后重建发送流并重新协商；
    // 屏幕模式由 overlay 承担（overlay 本身在采集画面内），无需重建。
    if (state.mediaStream && state.captureSourceType === 'window') {
      await applyCompositor();
      await negotiate();
    }
  } catch (error) {
    setStatus(`鼠标强调切换失败：${error.message}`, true);
  }
}

// 自定义投屏来源下拉：点击按钮先刷新列表，再展开显示（原生 select 无法在
// 展开前拦截刷新，所以用外观一致的下拉替代，刷新按钮因此可以删除）。
function createSourcePicker({ button, label, menu, onSelect }) {
  let open = false;
  let loading = false;
  let value = '';
  let type = null;

  function close() {
    open = false;
    menu.hidden = true;
  }

  function sourceName(source) {
    return source.type === 'screen' && source.displayId
      ? `${source.name}（显示器 ${source.displayId}）`
      : source.name;
  }

  function render(sourceResult, preferredId) {
    const sources = sourceResult?.sources || [];
    menu.replaceChildren();
    value = '';
    type = null;
    if (sources.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'source-menu-item is-disabled';
      empty.textContent = '没有检测到显示器或应用窗口';
      menu.append(empty);
      label.textContent = '没有检测到显示器或应用窗口';
      return null;
    }
    const groups = [
      { type: 'screen', label: '显示器' },
      { type: 'window', label: '应用窗口' }
    ];
    for (const group of groups) {
      const groupSources = sources.filter((source) => source.type === group.type);
      if (groupSources.length === 0) continue;
      const title = document.createElement('div');
      title.className = 'source-menu-group';
      title.textContent = group.label;
      menu.append(title);
      for (const source of groupSources) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'source-menu-item';
        item.textContent = sourceName(source);
        item.dataset.sourceId = source.id;
        item.dataset.sourceType = source.type;
        item.addEventListener('click', () => {
          value = source.id;
          type = source.type;
          label.textContent = sourceName(source);
          for (const el of menu.querySelectorAll('.source-menu-item')) {
            el.classList.toggle('is-selected', el === item);
          }
          close();
          onSelect?.(source);
        });
        menu.append(item);
      }
    }
    const requestedId = preferredId || sourceResult.selectedId;
    const next = sources.find((source) => source.id === requestedId) || sources[0];
    value = next.id;
    type = next.type;
    label.textContent = sourceName(next);
    for (const el of menu.querySelectorAll('.source-menu-item')) {
      el.classList.toggle('is-selected', el.dataset.sourceId === next.id);
    }
    return next;
  }

  button.addEventListener('click', async (event) => {
    event.stopPropagation();
    if (open) {
      close();
      return;
    }
    if (loading) {
      return;
    }
    loading = true;
    const previousLabel = label.textContent;
    label.textContent = '正在刷新...';
    try {
      render(await api.listSources());
      open = true;
      menu.hidden = false;
    } catch (error) {
      label.textContent = previousLabel;
      setStatus(`读取投屏来源失败：${error.message}`, true);
    } finally {
      loading = false;
    }
  });

  document.addEventListener('click', (event) => {
    if (open && !menu.contains(event.target)) {
      close();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && open) {
      close();
    }
  });

  return {
    get value() { return value; },
    get type() { return type; },
    render,
    close,
    focus() { button.focus(); }
  };
}

const sourcePicker = createSourcePicker({
  button: elements.sourceSelectButton,
  label: elements.sourceSelectLabel,
  menu: elements.sourceMenu,
  onSelect: (source) => {
    state.captureSourceId = source.id;
    state.captureSourceType = source.type;
    api.selectSource({ id: source.id, type: source.type })
      .catch((error) => setStatus(`选择投屏来源失败：${error.message}`, true));
  }
});

const switchSourcePicker = createSourcePicker({
  button: elements.switchSourceSelectButton,
  label: elements.switchSourceSelectLabel,
  menu: elements.switchSourceMenu,
  onSelect: (source) => {
    elements.confirmSourceSwitchButton.disabled = !source.id;
    elements.sourceSwitchMessage.textContent = source.id
      ? '切换时连接码和教室连接保持不变。'
      : '没有检测到可投屏的显示器或应用窗口。';
  }
});

async function refreshSources() {
  try {
    sourcePicker.render(await api.listSources());
  } catch (error) {
    setStatus(`读取投屏来源失败：${error.message}`, true);
  }
}

async function refreshSwitchSources() {
  try {
    const selected = switchSourcePicker.render(await api.listSources(), state.captureSourceId);
    elements.confirmSourceSwitchButton.disabled = !selected;
    elements.sourceSwitchMessage.textContent = selected
      ? '切换时连接码和教室连接保持不变。'
      : '没有检测到可投屏的显示器或应用窗口。';
  } catch (error) {
    elements.confirmSourceSwitchButton.disabled = true;
    elements.sourceSwitchMessage.textContent = `读取投屏来源失败：${error.message}`;
  }
}

function closeSourceSwitcher() {
  switchSourcePicker.close();
  elements.sourceSwitchDialog.hidden = true;
}

async function openSourceSwitcher() {
  if (!state.mediaStream) {
    setStatus('当前未投屏，请在主界面选择来源后开始投屏');
    sourcePicker.focus();
    return;
  }
  sourcePicker.close();
  elements.sourceSwitchDialog.hidden = false;
  await refreshSwitchSources();
}

async function requestScreenStream() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error('当前 Electron 版本不支持屏幕采集');
  }
  // main process maps this request to the display selected in the control panel.
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      frameRate: { ideal: 30, max: 30 },
      // 采集上限抬到 2560 宽：原先把 2K/4K 笔记本压到 1080p，投到 1080p 大屏上
      // 确实更锐利，但教室里越来越多 4K 大屏会在显示端把 1080p 拉伸放大，文字立刻
      // 发虚。采集只向下缩放、不会放大，1080p 笔记本仍按原分辨率采集，高分屏保留
      // 更多细节；码率不足时由 maintain-resolution 策略降帧率保清晰度。
      // 只限制宽度、不限制高度：同时给出宽高会让 Chromium 按固定宽高比裁剪屏幕
      // （实测 3840×2160 会被裁成 2560×1600），必须让高度跟随屏幕原始比例。
      width: { ideal: 2560, max: 2560 }
    },
    audio: true
  });
  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error('没有获取到屏幕画面');
  }
  // 'text' 比 'detail' 更偏向文字可读性（编码器优先保证文字边缘清晰）。
  videoTrack.contentHint = 'text';
  const sourceType = state.captureSourceType;
  videoTrack.addEventListener('ended', () => {
    if (!state.stopping && !state.switchingSource && stream === state.mediaStream) {
      stopProjection(false, sourceType === 'window'
        ? '应用窗口已关闭，投屏已停止'
        : '屏幕采集已停止');
    }
  });
  return stream;
}

// --- 发送端鼠标强调点合成 ---
// 单应用窗口投屏时，Chromium 只采集目标窗口的内容，桌面上的 overlay 强调标记
// 属于独立窗口、不会进入采集帧，因此大屏上看不到强调点。这里把采集到的视频
// 逐帧画到 canvas，按主进程推送的光标场景（屏幕 DIP 坐标 + 采集区域）把强调点
// 合成进画面：归一化坐标 = (光标 - 区域原点) / 区域尺寸，再乘以帧分辨率
// （帧像素 / 区域 DIP 宽度 = 帧缩放系数，点的直径按该系数换算，保证大屏上大小
// 与 overlay 模式一致）。合成流替换发送给 WebRTC 的视频轨，本地预览也显示合成流。
let cursorScene = null;
let compositor = null;

// 与 main.js 的 CURSOR_DOT_SIZE 保持一致（屏幕 DIP 像素）
const CURSOR_DOT_DIP = 14;

function drawCursorDot(ctx, cx, cy, scale) {
  // 只画中心强调点（外圈已按课堂反馈去掉）：红点 + 细白描边 + 轻微光晕。
  const radius = Math.max(3, (CURSOR_DOT_DIP / 2) * scale);
  ctx.save();
  ctx.shadowColor = 'rgba(255,59,48,.6)';
  ctx.shadowBlur = Math.max(3, 6 * scale);
  ctx.fillStyle = 'rgba(255,59,48,.95)';
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = Math.max(1, 2 * scale);
  ctx.strokeStyle = 'rgba(255,255,255,.92)';
  ctx.stroke();
  ctx.restore();
}

function createCompositor(rawStream) {
  const videoTrack = rawStream.getVideoTracks()[0];
  const video = document.createElement('video');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const handle = {
    outputTrack: null,
    rafId: 0,
    fallbackTimer: null,
    lastDrawAt: 0,
    stopped: false,
    ready: null,
    stop: null
  };
  let resolveReady = null;
  let rejectReady = null;
  handle.ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const failTimer = setTimeout(() => {
    if (!handle.outputTrack) {
      rejectReady(new Error('强调点合成初始化超时'));
    }
  }, 3000);

  function render() {
    if (handle.stopped) {
      return;
    }
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && canvas.width > 0) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      if (cursorScene && cursorScene.inside) {
        const region = cursorScene.region;
        if (region && region.width > 0 && region.height > 0) {
          const nx = (cursorScene.cursor.x - region.x) / region.width;
          const ny = (cursorScene.cursor.y - region.y) / region.height;
          if (nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1) {
            drawCursorDot(ctx, nx * canvas.width, ny * canvas.height, canvas.width / region.width);
          }
        }
      }
      handle.lastDrawAt = performance.now();
    }
  }

  function loop() {
    if (handle.stopped) {
      return;
    }
    render();
    handle.rafId = requestAnimationFrame(loop);
  }

  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([videoTrack]);
  video.addEventListener('loadedmetadata', () => {
    if (handle.stopped) {
      return;
    }
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    if (canvas.width === 0 || canvas.height === 0) {
      clearTimeout(failTimer);
      rejectReady(new Error('强调点合成：采集画面尺寸无效'));
      return;
    }
    // 画布尺寸与采集帧一致，合成不额外降采样；缩放交给高质量插值。
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const outputStream = canvas.captureStream(30);
    handle.outputTrack = outputStream.getVideoTracks()[0];
    handle.outputTrack.contentHint = 'text';
    handle.rafId = requestAnimationFrame(loop);
    // 隐藏到托盘、被其他窗口遮挡时 rAF 可能被暂停，画布一旦停止重绘，
    // captureStream 就不再产生新帧，大屏会停在最后一帧——用定时器兜底重绘。
    handle.fallbackTimer = setInterval(() => {
      if (handle.stopped) {
        return;
      }
      if (performance.now() - handle.lastDrawAt > 150) {
        render();
      }
    }, 50);
    clearTimeout(failTimer);
    resolveReady();
  });
  video.addEventListener('error', () => {
    clearTimeout(failTimer);
    rejectReady(new Error('强调点合成：采集画面播放失败'));
  });
  video.play().catch((error) => {
    clearTimeout(failTimer);
    rejectReady(error);
  });

  handle.stop = () => {
    handle.stopped = true;
    clearTimeout(failTimer);
    if (handle.rafId) {
      cancelAnimationFrame(handle.rafId);
      handle.rafId = 0;
    }
    if (handle.fallbackTimer) {
      clearInterval(handle.fallbackTimer);
      handle.fallbackTimer = null;
    }
    video.pause();
    video.srcObject = null;
    if (handle.outputTrack) {
      handle.outputTrack.stop();
      handle.outputTrack = null;
    }
  };
  return handle;
}

function stopCompositor() {
  if (compositor) {
    compositor.stop();
    compositor = null;
  }
}

// 按当前来源类型与强调开关，把 state.rawStream 包装为实际发送的 mediaStream：
// 窗口模式 + 强调开启 → canvas 合成流（圈画进画面）；其余情况直接使用原始流
// （屏幕模式由 overlay 承担，无需合成，零额外开销）。
async function applyCompositor() {
  stopCompositor();
  const raw = state.rawStream;
  if (!raw) {
    return;
  }
  let nextStream = raw;
  if (state.captureSourceType === 'window' && state.cursorHighlight && raw.getVideoTracks()[0]) {
    const handle = createCompositor(raw);
    compositor = handle;
    try {
      await handle.ready;
    } catch (error) {
      stopCompositor();
      setStatus(`开启鼠标强调合成失败：${error.message}`, true);
    }
    if (handle.outputTrack) {
      nextStream = new MediaStream([handle.outputTrack, ...raw.getAudioTracks()]);
    }
  }
  state.mediaStream = nextStream;
  elements.localPreview.srcObject = nextStream;
  await elements.localPreview.play().catch(() => {});
}

async function startMicCapture() {
  if (state.micStream) {
    return state.micStream;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('当前环境不支持麦克风采集');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });
  state.micStream = stream;
  return stream;
}

function stopMicCapture() {
  if (state.micStream) {
    state.micStream.getTracks().forEach((track) => track.stop());
    state.micStream = null;
  }
}

function startSourceMonitor() {
  if (state.captureSourceType !== 'window' || state.sourceMonitorTimer) {
    return;
  }
  state.sourceMonitorTimer = setInterval(async () => {
    if (!state.mediaStream || state.stopping || state.switchingSource) return;
    try {
      if (!await api.sourceAvailable(state.captureSourceId)) {
        await stopProjection(false, '应用窗口已关闭，投屏已停止');

      }
        if (!state.mediaStream) return;
        if (!state.followingWindowProbe) {
          state.followingWindowProbe = true;
          try {
            const follow = await api.findFollowWindow();
            if (follow?.id && follow.id !== state.captureSourceId) {
              await switchProjectionSourceTo(follow);
            }
          } finally {
            state.followingWindowProbe = false;
          }
        }
        return;
        if (!state.followingWindowProbe) {
          state.followingWindowProbe = true;
          try {
            const follow = await api.findFollowWindow();
            if (follow?.id && follow.id !== state.captureSourceId) {
              await switchProjectionSourceTo(follow);
            }
          } finally {
            state.followingWindowProbe = false;
          }
        }
    } catch {
      // The media track's ended event remains the fallback when source probing fails.
    }
  }, 2000);
}

function stopSourceMonitor() {
  if (state.sourceMonitorTimer) {
    clearInterval(state.sourceMonitorTimer);
    state.sourceMonitorTimer = null;
  }
}

// ---------------------------------------------------------------- 连接自愈
// 课堂反馈的“大屏画面停住、但 Windows 端仍显示已连接”，实测来自四类原因：
//   1. 大屏页面刷新 / 浏览器重启 / 换网络：房间在宽限期内复用原连接码，大屏恢复了
//      WebSocket，但它的 PeerConnection 已经销毁，必须由教师端重新发 offer，
//      否则画面永远停在最后一帧（服务端只会推 viewer.online）；
//   2. Wi-Fi 漫游 / 交换机抖动：ICE 通道失效，Chromium 只会停在 disconnected，
//      不会自己恢复，必须重新协商；
//   3. 编码器或强调点合成画布卡死：连接仍是 connected，但出帧数不再增长；
//   4. 采集轨结束（显示器休眠、切换显卡输出）：本端采集已经停止。
// 统一用「出帧看门狗 + 信令事件」触发自愈：重建合成流 → 必要时重新采集 →
// 重建 PeerConnection 并重新发 offer（大屏收到 offer 会整体重建它那一侧）。
const WATCHDOG_INTERVAL_MS = 3000;
const STALL_GRACE_MS = 6000;             // 出帧停止多久判定卡死
const HEALTHY_RESET_MS = 20000;          // 正常出帧多久后重置恢复次数
const RECOVERY_MIN_INTERVAL_MS = 8000;   // 两次自愈的最小间隔
const MAX_RECOVERY_ATTEMPTS = 4;         // 连续自愈上限，超过则提示重新投屏
const DISCONNECT_RECOVERY_DELAY_MS = 4000;
const OFFER_TIMEOUT_MS = 7000;           // 发出 offer 后多久没连上就重试
const OFFER_MAX_RETRIES = 2;
const RENEGOTIATE_COALESCE_MS = 800;     // 合并同一批信令里的重复协商

function resetStallTracking() {
  state.lastVideoProgress = null;
  state.stallSince = 0;
  state.healthySince = 0;
}

function clearDisconnectTimer() {
  if (state.disconnectTimer) {
    clearTimeout(state.disconnectTimer);
    state.disconnectTimer = null;
  }
}

function clearOfferWatchdog() {
  if (state.offerTimer) {
    clearTimeout(state.offerTimer);
    state.offerTimer = null;
  }
}

function armOfferWatchdog() {
  clearOfferWatchdog();
  state.offerTimer = setTimeout(() => {
    state.offerTimer = null;
    const peerConnection = state.peerConnection;
    if (!peerConnection || state.stopping || !state.mediaStream) {
      return;
    }
    if (peerConnection.connectionState === 'connected') {
      return;
    }
    const sdp = peerConnection.localDescription?.sdp;
    if (state.offerRetries < OFFER_MAX_RETRIES && sdp) {
      // 大屏可能刚好在刷新页面，重发同一个 offer 就能恢复，不必重建连接。
      state.offerRetries += 1;
      api.sendSignaling({ type: 'webrtc.offer', sdp });
      setStatus('教室大屏暂未响应，正在重试连接...');
      armOfferWatchdog();
      return;
    }
    recoverProjection('大屏未响应');
  }, OFFER_TIMEOUT_MS);
}

function startWatchdog() {
  if (state.watchdogTimer) {
    return;
  }
  state.watchdogTimer = setInterval(runWatchdog, WATCHDOG_INTERVAL_MS);
}

function stopWatchdog() {
  if (state.watchdogTimer) {
    clearInterval(state.watchdogTimer);
    state.watchdogTimer = null;
  }
  resetStallTracking();
}

async function readOutboundVideoProgress(peerConnection) {
  let stats;
  try {
    stats = await peerConnection.getStats();
  } catch {
    return null;
  }
  let found = false;
  let frames = 0;
  let bytes = 0;
  stats.forEach((report) => {
    if (report.type === 'outbound-rtp' && report.kind === 'video' && report.isRemote !== true) {
      found = true;
      frames += report.framesEncoded ?? report.framesSent ?? 0;
      bytes += report.bytesSent || 0;
    }
  });
  return found ? { frames, bytes } : null;
}

async function runWatchdog() {
  if (state.watchdogBusy) {
    return;
  }
  state.watchdogBusy = true;
  try {
    const peerConnection = state.peerConnection;
    if (!state.mediaStream || state.stopping || state.switchingSource || !peerConnection) {
      resetStallTracking();
      return;
    }
    const progress = await readOutboundVideoProgress(peerConnection);
    if (!progress || state.peerConnection !== peerConnection) {
      return;
    }
    const now = Date.now();
    const previous = state.lastVideoProgress;
    // 刚重新协商时计数器会归零，previous 为空视为正常起点。
    const advanced = !previous
      || progress.frames > previous.frames
      || progress.bytes > previous.bytes;
    const encoding = previous && (previous.frames > 0 || previous.bytes > 0);
    state.lastVideoProgress = { frames: progress.frames, bytes: progress.bytes };

    if (advanced) {
      if (!state.healthySince) {
        state.healthySince = now;
      }
      state.stallSince = 0;
      if (now - state.healthySince >= HEALTHY_RESET_MS) {
        state.recoveryAttempts = 0;
      }
      return;
    }

    state.healthySince = 0;
    if (!encoding) {
      return;
    }
    if (!state.stallSince) {
      state.stallSince = now;
    }
    if (now - state.stallSince < STALL_GRACE_MS) {
      return;
    }
    if (!state.viewerOnline) {
      // 大屏不在线时发 offer 没有意义，等 viewer.online 再恢复。
      return;
    }
    await recoverProjection('画面停止输出');
  } finally {
    state.watchdogBusy = false;
  }
}

// 重新协商：大屏收到新 offer 会整体重建它那一侧的连接，是恢复画面最可靠的手段。
async function requestRenegotiation() {
  if (!state.mediaStream || state.stopping) {
    return;
  }
  if (Date.now() - state.lastOfferAt < RENEGOTIATE_COALESCE_MS) {
    // join.accepted 与 viewer.online 常常同一批到达，只保留一次协商。
    return;
  }
  await negotiate();
}

async function recoverProjection(reason) {
  if (!state.mediaStream || state.stopping || state.switchingSource || state.recovering) {
    return;
  }
  if (!state.viewerOnline) {
    return;
  }
  const now = Date.now();
  if (now - state.lastRecoveryAt < RECOVERY_MIN_INTERVAL_MS) {
    return;
  }
  if (state.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
    setLiveStatus('需要重新投屏');
    setStatus('画面多次自动恢复失败，请点击“停止投屏”后重新开始', true);
    setTrayStatus('MyClass 投屏 - 画面中断，需要重新开始投屏');
    return;
  }

  state.recovering = true;
  state.lastRecoveryAt = now;
  state.recoveryAttempts += 1;
  const attempt = state.recoveryAttempts;
  setLiveStatus('正在自动恢复');
  setStatus(`检测到画面中断（${reason}），正在自动恢复（第 ${attempt} 次）...`);
  setTrayStatus(`MyClass 投屏 - 正在自动恢复画面（第 ${attempt} 次）`);
  try {
    const rawTrack = state.rawStream?.getVideoTracks()[0];
    if (!rawTrack || rawTrack.readyState !== 'live') {
      // 采集轨已结束（显示器休眠、切换显卡输出、窗口被销毁），重新采集。
      const previousRaw = state.rawStream;
      const nextRaw = await requestScreenStream();
      state.rawStream = nextRaw;
      previousRaw?.getTracks().forEach((track) => track.stop());
    }
    // 强调点合成画布可能已经停止重绘，直接重建最稳妥。
    await applyCompositor();
    await negotiate();
  } catch (error) {
    setStatus(`自动恢复失败：${error.message}`, true);
  } finally {
    state.recovering = false;
    resetStallTracking();
  }
}

function scheduleDisconnectRecovery(peerConnection) {
  if (state.disconnectTimer) {
    return;
  }
  state.disconnectTimer = setTimeout(() => {
    state.disconnectTimer = null;
    if (state.peerConnection !== peerConnection || state.stopping || !state.mediaStream) {
      return;
    }
    if (peerConnection.connectionState === 'connected') {
      return;
    }
    recoverProjection('连接中断');
  }, DISCONNECT_RECOVERY_DELAY_MS);
}

function configureSender(sender, kind) {
  const parameters = sender.getParameters();
  parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
  const encoding = parameters.encodings[0];
  if (kind === 'video') {
    // 教室是局域网，放开到 16 Mbps：屏幕文字是高细节内容，码率越高越清晰，
    // 弱网时 GCC 会自己降回可用带宽，不会因此拥塞。
    encoding.minBitrate = 1_000_000;
    encoding.maxBitrate = 16_000_000;
    encoding.maxFramerate = 30;
    // 禁止浏览器按带宽偷偷降低分辨率（文字会直接变糊），宁可掉帧保住清晰度。
    encoding.scaleResolutionDownBy = 1;
    parameters.degradationPreference = 'maintain-resolution';
  } else if (kind === 'audio') {
    encoding.maxBitrate = 128_000;
  }
  sender.setParameters(parameters).catch(() => {});
}

function createPeerConnection() {
  const iceServers = state.config?.config?.rtc?.iceServers || [];
  const peerConnection = new RTCPeerConnection({ iceServers });
  peerConnection.addEventListener('icecandidate', (event) => {
    if (event.candidate) {
      api.sendSignaling({
        type: 'webrtc.ice-candidate',
        candidate: event.candidate.toJSON()
      });
    }
  });
  peerConnection.addEventListener('connectionstatechange', () => {
    if (state.peerConnection !== peerConnection) {
      return;
    }
    const connectionState = peerConnection.connectionState;
    if (connectionState === 'connected') {
      clearOfferWatchdog();
      clearDisconnectTimer();
      state.offerRetries = 0;
      elements.statusDot.classList.add('is-live');
      setLiveStatus('已连接');
      setStatus('已连接到教室大屏');
      setTrayStatus('MyClass 投屏 - 正在投屏');
      if (!state.everConnected) {
        // 只在首次连上时自动隐藏面板；自动恢复后隐藏会打断正在查看状态的老师。
        state.everConnected = true;
        setTimeout(() => api.hideWindow(), 700);
      }
    } else if (connectionState === 'connecting') {
      setLiveStatus('连接中');
    } else if (connectionState === 'disconnected') {
      setLiveStatus('网络中断，等待恢复');
      setStatus('视频连接暂时中断，正在等待网络恢复', true);
      // Chromium 不会自己从 disconnected 恢复，稍等无果就重新协商。
      scheduleDisconnectRecovery(peerConnection);
    } else if (connectionState === 'failed') {
      setLiveStatus('连接失败');
      setStatus('视频连接异常，正在自动恢复...', true);
      recoverProjection('连接失败');
    }
  });
  peerConnection.addEventListener('iceconnectionstatechange', () => {
    if (state.peerConnection !== peerConnection) {
      return;
    }
    if (peerConnection.iceConnectionState === 'failed') {
      setStatus('ICE 连接失败，正在自动恢复...', true);
      recoverProjection('ICE 连接失败');
    }
  });

  for (const track of state.mediaStream.getTracks()) {
    const sender = peerConnection.addTrack(track, state.mediaStream);
    configureSender(sender, track.kind);
  }
  // 扩音：把麦克风音频作为第二条音频轨一起发送到大屏。
  if (state.micAmplify && state.micStream) {
    const micTrack = state.micStream.getAudioTracks()[0];
    if (micTrack) {
      const sender = peerConnection.addTrack(micTrack, state.micStream);
      configureSender(sender, 'audio');
    }
  }
  return peerConnection;
}

async function negotiate() {
  if (!state.mediaStream || state.stopping) {
    return;
  }
  clearOfferWatchdog();
  clearDisconnectTimer();
  state.offerRetries = 0;
  // 新连接从 0 开始出帧，旧的出帧计数必须清掉，否则看门狗会误判卡死。
  resetStallTracking();
  if (state.peerConnection) {
    state.peerConnection.close();
  }
  state.pendingCandidates = [];
  const peerConnection = createPeerConnection();
  state.peerConnection = peerConnection;
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  if (state.peerConnection !== peerConnection || state.stopping) {
    return;
  }
  state.lastOfferAt = Date.now();
  api.sendSignaling({
    type: 'webrtc.offer',
    sdp: peerConnection.localDescription.sdp
  });
  setLiveStatus('等待大屏响应');
  armOfferWatchdog();
}

async function handleRemoteCandidate(candidate) {
  if (!candidate) {
    return;
  }
  if (!state.peerConnection || !state.peerConnection.remoteDescription) {
    state.pendingCandidates.push(candidate);
    return;
  }
  try {
    await state.peerConnection.addIceCandidate(candidate);
  } catch {
    // A late candidate can legitimately arrive after the peer has been replaced.
  }
}

async function handleAnswer(sdp) {
  if (!state.peerConnection || !sdp) {
    return;
  }
  try {
    await state.peerConnection.setRemoteDescription({ type: 'answer', sdp });
    // 大屏已响应，后续由连接状态和出帧看门狗接管，不必再重发 offer。
    clearOfferWatchdog();
    state.offerRetries = 0;
    const pending = state.pendingCandidates.splice(0);
    for (const candidate of pending) {
      await handleRemoteCandidate(candidate);
    }
  } catch (error) {
    setStatus(`设置大屏响应失败：${error.message}`, true);
  }
}

async function handleSignal(message) {
  switch (message.type) {
    case 'join.accepted':
      state.joined = true;
      setStatus('连接码验证成功，正在建立投屏连接...');
      if (state.viewerOnline === false) {
        // 大屏此刻不在线，等它重新连接后由 viewer.online 触发协商。
        setLiveStatus('等待大屏连接');
      } else {
        await requestRenegotiation();
      }
      break;
    case 'join.rejected':
      setStatus(message.message || '连接码错误', true);
      await stopProjection(false);
      break;
    case 'webrtc.answer':
      await handleAnswer(message.sdp);
      break;
    case 'webrtc.ice-candidate':
      await handleRemoteCandidate(message.candidate);
      break;
    case 'viewer.online':
      // 大屏刷新页面或网络恢复后重新连上同一个房间：它那一侧的 PeerConnection
      // 已经销毁，只有教师端重新发 offer 才能让画面恢复，否则大屏一直停在最后一帧。
      state.viewerOnline = true;
      setTrayStatus('MyClass 投屏 - 正在投屏');
      if (state.joined && state.mediaStream) {
        setStatus('教室大屏已重新连接，正在恢复画面...');
        await requestRenegotiation();
      }
      break;
    case 'viewer.reconnecting':
      state.viewerOnline = false;
      resetStallTracking();
      clearOfferWatchdog();
      clearDisconnectTimer();
      setLiveStatus('大屏断开，等待恢复');
      setStatus('教室大屏已断开，正在等待自动恢复...');
      setTrayStatus('MyClass 投屏 - 大屏断开，等待自动恢复');
      break;
    case 'viewer.disconnected':
    case 'room.expired':
      await stopProjection(false, message.message || '教室端已断开');
      break;
    case 'teacher.kicked':
      await stopProjection(false, message.message || '本设备已下线');
      break;
    case 'error':
      setStatus(message.message || '信令错误', true);
      break;
    default:
      break;
  }
}

function closeHelpDialog() {
  elements.helpDialog.hidden = true;
}

function openHelpDialog() {
  elements.helpDialog.hidden = false;
}

function closeSettingsDialog() {
  elements.settingsDialog.hidden = true;
}

function openSettingsDialog() {
  elements.settingsServerUrl.value = state.serverUrl;
  elements.settingsDialog.hidden = false;
  elements.settingsServerUrl.focus();
}

function saveSettings() {
  const serverUrl = elements.settingsServerUrl.value.trim().replace(/\/+$/, '');
  if (!serverUrl) {
    setStatus('服务器地址不能为空', true);
    elements.settingsServerUrl.focus();
    return;
  }
  state.serverUrl = serverUrl;
  localStorage.setItem('myclass.serverUrl', state.serverUrl);
  closeSettingsDialog();
  setStatus('服务器地址已保存');
}

async function startProjection() {
  const code = elements.roomCode.value.trim();
  if (!/^\d{4}$/.test(code)) {
    setStatus('请输入大屏上显示的 4 位连接码', true);
    elements.roomCode.focus();
    return;
  }
  if (!state.serverUrl) {
    setStatus('请先在设置中配置服务器地址', true);
    openSettingsDialog();
    return;
  }
  if (!sourcePicker.value) {
    setStatus('没有可用的显示器或应用窗口', true);
    return;
  }

  elements.startButton.disabled = true;
  elements.startButton.textContent = '正在准备屏幕...';
  state.stopping = false;
  state.everConnected = false;
  state.recovering = false;
  state.recoveryAttempts = 0;
  state.lastRecoveryAt = 0;
  state.lastOfferAt = 0;
  state.viewerOnline = true;
  clearOfferWatchdog();
  clearDisconnectTimer();
  resetStallTracking();
  state.roomCode = code;
  state.captureSourceId = sourcePicker.value;
  state.captureSourceType = sourcePicker.type;
  state.localAudioOutput = elements.localAudioOutput.checked;
  state.micAmplify = elements.micAmplify.checked;
  state.cursorHighlight = elements.cursorHighlight.checked;
  localStorage.setItem('myclass.serverUrl', state.serverUrl);
  localStorage.setItem('myclass.localAudioOutput', String(state.localAudioOutput));
  localStorage.setItem('myclass.micAmplify', String(state.micAmplify));
  localStorage.setItem('myclass.cursorHighlight', String(state.cursorHighlight));
  updateCursorHighlightUi();
  try {
    await api.selectSource({ id: state.captureSourceId, type: state.captureSourceType });
    if (state.micAmplify) {
      await startMicCapture();
    } else {
      stopMicCapture();
    }
    if (state.cursorHighlight) {
      await api.setCursorHighlight(true);
    }
    if (!state.localAudioOutput) {
      await api.setLocalAudioOutput(false);
      state.localAudioMuted = true;
    }
    elements.localAudioButton.textContent = state.localAudioOutput ? '关闭电脑声音' : '开启电脑声音';
    state.rawStream = await requestScreenStream();
    state.mediaStream = state.rawStream;
    startSourceMonitor();
    await applyCompositor();
    startWatchdog();
    const audioTrack = state.mediaStream.getAudioTracks()[0];
    elements.audioStatus.textContent = audioTrack
      ? (state.micAmplify ? '系统声音 + 麦克风已启用' : '系统声音已启用')
      : '未获取到系统声音';
    state.config = await api.connectSignaling({ baseUrl: state.serverUrl, code });
    elements.setupCard.hidden = true;
    elements.liveCard.hidden = false;
    elements.liveCode.textContent = code;
    setLiveStatus('等待连接码确认');
    setStatus('正在连接教室信令服务...');
  } catch (error) {
    await stopProjection(false);
    setStatus(error.message || '启动投屏失败', true);
  } finally {
    elements.startButton.disabled = false;
    elements.startButton.textContent = '开始投屏';
  }
}

async function switchProjectionSource() {
  const nextSourceId = switchSourcePicker.value;
  const nextSourceType = switchSourcePicker.type;
  if (!nextSourceId || !state.mediaStream || state.switchingSource) {
    return;
  }
  if (nextSourceId === state.captureSourceId) {
    closeSourceSwitcher();
    return;
  }

  const previousStream = state.mediaStream;
  const previousRawStream = state.rawStream;
  const previousSource = {
    id: state.captureSourceId,
    type: state.captureSourceType
  };
  const generation = ++state.sourceSwitchGeneration;
  let nextStream = null;
  state.switchingSource = true;
  switchSourcePicker.close();
  elements.confirmSourceSwitchButton.disabled = true;
  elements.sourceSwitchMessage.textContent = '正在切换投屏窗口，请稍候...';
  setLiveStatus('正在切换窗口');

  try {
    await api.selectSource({ id: nextSourceId, type: nextSourceType });
    state.captureSourceId = nextSourceId;
    state.captureSourceType = nextSourceType;
    nextStream = await requestScreenStream();
    if (generation !== state.sourceSwitchGeneration || state.stopping) {
      nextStream.getTracks().forEach((track) => track.stop());
      return;
    }

    stopSourceMonitor();
    stopCompositor();
    state.rawStream = nextStream;
    await applyCompositor();
    const audioTrack = state.mediaStream.getAudioTracks()[0];
    elements.audioStatus.textContent = audioTrack
      ? (state.micAmplify ? '系统声音 + 麦克风已启用' : '系统声音已启用')
      : '未获取到系统声音';
    startSourceMonitor();
    await negotiate();
    if (generation !== state.sourceSwitchGeneration || state.stopping) {
      return;
    }

    previousStream.getTracks().forEach((track) => track.stop());
    if (previousRawStream && previousRawStream !== previousStream) {
      previousRawStream.getTracks().forEach((track) => track.stop());
    }
    closeSourceSwitcher();
    setStatus(nextSourceType === 'window' ? '已切换到应用窗口' : '已切换到显示器');
  } catch (error) {
    if (nextStream) {
      nextStream.getTracks().forEach((track) => track.stop());
    }
    if (generation !== state.sourceSwitchGeneration || state.stopping) {
      return;
    }
    stopSourceMonitor();
    state.captureSourceId = previousSource.id;
    state.captureSourceType = previousSource.type;
    await api.selectSource(previousSource).catch(() => {});
    state.rawStream = previousRawStream;
    await applyCompositor();
    startSourceMonitor();
    elements.sourceSwitchMessage.textContent = error.message || '切换投屏窗口失败';
    setStatus(error.message || '切换投屏窗口失败', true);
    setLiveStatus('已连接');
  } finally {
    state.switchingSource = false;
    elements.confirmSourceSwitchButton.disabled = false;
  }
}

async function switchProjectionSourceTo(nextSource) {
  const nextSourceId = String(nextSource?.id || '');
  const nextSourceType = nextSource?.type === 'window' ? 'window' : 'screen';
  if (!nextSourceId || !state.mediaStream || state.switchingSource) {
    return;
  }
  if (nextSourceId === state.captureSourceId) {
    closeSourceSwitcher();
    return;
  }

  const previousStream = state.mediaStream;
  const previousRawStream = state.rawStream;
  const previousSource = {
    id: state.captureSourceId,
    type: state.captureSourceType
  };
  const generation = ++state.sourceSwitchGeneration;
  let nextStream = null;
  state.switchingSource = true;
  switchSourcePicker.close();
  closeSourceSwitcher();
  elements.confirmSourceSwitchButton.disabled = true;
  setLiveStatus('正在切换窗口');
  setStatus('检测到演示文稿放映窗口，正在自动切换...');

  try {
    await api.selectSource({ id: nextSourceId, type: nextSourceType });
    state.captureSourceId = nextSourceId;
    state.captureSourceType = nextSourceType;
    nextStream = await requestScreenStream();
    if (generation !== state.sourceSwitchGeneration || state.stopping) {
      nextStream.getTracks().forEach((track) => track.stop());
      return;
    }

    stopSourceMonitor();
    stopCompositor();
    state.rawStream = nextStream;
    await applyCompositor();
    const audioTrack = state.mediaStream.getAudioTracks()[0];
    elements.audioStatus.textContent = audioTrack
      ? (state.micAmplify ? '系统声音 + 麦克风已启用' : '系统声音已启用')
      : '未获取到系统声音';
    startSourceMonitor();
    await negotiate();
    if (generation !== state.sourceSwitchGeneration || state.stopping) {
      return;
    }

    previousStream.getTracks().forEach((track) => track.stop());
    if (previousRawStream && previousRawStream !== previousStream) {
      previousRawStream.getTracks().forEach((track) => track.stop());
    }
    setStatus(nextSourceType === 'window' ? '已自动切换到演示文稿放映窗口' : '已切换到显示器');
      refreshSources().catch(() => {});
  } catch (error) {
    if (nextStream) {
      nextStream.getTracks().forEach((track) => track.stop());
    }
    if (generation !== state.sourceSwitchGeneration || state.stopping) {
      return;
    }
    stopSourceMonitor();
    state.captureSourceId = previousSource.id;
    state.captureSourceType = previousSource.type;
    await api.selectSource(previousSource).catch(() => {});
    state.rawStream = previousRawStream;
    await applyCompositor();
    startSourceMonitor();
    setStatus(`自动切换演示文稿放映窗口失败：${error.message || '未知错误'}`, true);
    setLiveStatus('已连接');
  } finally {
    state.switchingSource = false;
    elements.confirmSourceSwitchButton.disabled = false;
  }
}


async function stopProjection(disconnect = true, message = '') {
  state.stopping = true;
  state.sourceSwitchGeneration += 1;
  state.switchingSource = false;
    state.followingWindowProbe = false;
  closeSourceSwitcher();
  stopSourceMonitor();
  stopWatchdog();
  clearOfferWatchdog();
  clearDisconnectTimer();
  state.recovering = false;
  state.recoveryAttempts = 0;
  state.lastRecoveryAt = 0;
  state.everConnected = false;
  state.viewerOnline = true;
  setTrayStatus('MyClass 投屏');
  if (state.peerConnection) {
    state.peerConnection.close();
    state.peerConnection = null;
  }
  stopCompositor();
  if (state.rawStream) {
    state.rawStream.getTracks().forEach((track) => track.stop());
    state.rawStream = null;
  }
  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach((track) => track.stop());
    state.mediaStream = null;
  }
  stopMicCapture();
  elements.localPreview.srcObject = null;
  if (state.cursorHighlight) {
    await api.setCursorHighlight(false).catch(() => {});
  }
  if (state.localAudioMuted) {
    try {
      await api.setLocalAudioOutput(true);
    } catch (error) {
      setStatus(`恢复笔记本声音失败：${error.message}`, true);
    }
    state.localAudioMuted = false;
  }
  if (disconnect) {
    api.sendSignaling({ type: 'teacher.stop' });
  }
  api.disconnectSignaling();
  state.joined = false;
  state.pendingCandidates = [];
  elements.liveCard.hidden = true;
  elements.setupCard.hidden = false;
  elements.statusDot.classList.remove('is-live');
  elements.localAudioButton.disabled = false;
  elements.localAudioButton.textContent = '关闭电脑声音';
  elements.audioStatus.textContent = '准备中';
  setStatus(message || '投屏已停止');
  state.stopping = false;
}

elements.startButton.addEventListener('click', startProjection);
elements.stopButton.addEventListener('click', () => stopProjection(true));
elements.helpButton.addEventListener('click', openHelpDialog);
elements.closeHelpButton.addEventListener('click', closeHelpDialog);
elements.closeHelpAction.addEventListener('click', closeHelpDialog);
elements.settingsButton.addEventListener('click', openSettingsDialog);
elements.closeSettingsButton.addEventListener('click', closeSettingsDialog);
elements.cancelSettingsAction.addEventListener('click', closeSettingsDialog);
elements.saveSettingsButton.addEventListener('click', saveSettings);
elements.localAudioOutput.addEventListener('change', async () => {
  state.localAudioOutput = elements.localAudioOutput.checked;
  localStorage.setItem('myclass.localAudioOutput', String(state.localAudioOutput));
});
elements.micAmplify.addEventListener('change', () => {
  state.micAmplify = elements.micAmplify.checked;
  localStorage.setItem('myclass.micAmplify', String(state.micAmplify));
  if (!state.mediaStream) {
    return;
  }
  if (state.micAmplify) {
    startMicCapture()
      .then(() => negotiate())
      .catch((error) => {
        state.micAmplify = false;
        elements.micAmplify.checked = false;
        localStorage.setItem('myclass.micAmplify', 'false');
        stopMicCapture();
        setStatus(`启用扩音失败：${error.message}`, true);
      });
  } else {
    stopMicCapture();
    negotiate().catch((error) => setStatus(`重新建立连接失败：${error.message}`, true));
  }
});
elements.cursorHighlight.addEventListener('change', () => {
  if (state.mediaStream) {
    setCursorHighlight(elements.cursorHighlight.checked);
  } else {
    state.cursorHighlight = elements.cursorHighlight.checked;
    localStorage.setItem('myclass.cursorHighlight', String(state.cursorHighlight));
    updateCursorHighlightUi();
  }
});
elements.cursorHighlightButton.addEventListener('click', () => setCursorHighlight(!state.cursorHighlight));
elements.localAudioButton.addEventListener('click', async () => {
  const enabled = !state.localAudioMuted;
  try {
    await api.setLocalAudioOutput(enabled);
    state.localAudioMuted = !enabled;
    elements.localAudioOutput.checked = enabled;
    state.localAudioOutput = enabled;
    elements.localAudioButton.textContent = enabled ? '关闭电脑声音' : '开启电脑声音';
    localStorage.setItem('myclass.localAudioOutput', String(enabled));
    setStatus(enabled ? '已恢复笔记本声音' : '笔记本声音已关闭，大屏声音继续发送');
  } catch (error) {
    setStatus(`切换笔记本声音失败：${error.message}`, true);
  }
});
elements.roomCode.addEventListener('input', () => {
  elements.roomCode.value = elements.roomCode.value.replace(/\D/g, '').slice(0, 4);
});

elements.cancelSourceSwitchButton.addEventListener('click', closeSourceSwitcher);
elements.cancelSourceSwitchAction.addEventListener('click', closeSourceSwitcher);
elements.confirmSourceSwitchButton.addEventListener('click', switchProjectionSource);

api.onSignalingMessage((message) => handleSignal(message).catch((error) => setStatus(error.message, true)));
api.onSignalingState(({ state: signalingState, reconnected }) => {
  if (signalingState === 'connecting') {
    setLiveStatus('连接中');
  } else if (signalingState === 'connected' && reconnected && state.mediaStream) {
    // 信令重连后服务端会重发 join.accepted / viewer.online，由那里触发重新协商。
    setStatus('信令已重新连接，正在恢复投屏...');
  } else if (signalingState === 'closed' && state.mediaStream) {
    setStatus('信令连接已断开，正在重连...', true);
    setTrayStatus('MyClass 投屏 - 信令断开，正在重连');
  }
});
api.onSignalingError(({ message }) => setStatus(message, true));
api.onTrayStop(() => stopProjection(true));
api.onTraySwitchSource(() => openSourceSwitcher().catch((error) => setStatus(error.message, true)));
api.onToggleCursorHighlight(() => {
  if (state.mediaStream) {
    setCursorHighlight(!state.cursorHighlight);
  } else {
    state.cursorHighlight = !state.cursorHighlight;
    localStorage.setItem('myclass.cursorHighlight', String(state.cursorHighlight));
    updateCursorHighlightUi();
  }
});
api.onCursorScene((scene) => {
  cursorScene = scene;
});

api.getAppVersion()
  .then((version) => {
    document.title = `MyClass 投屏 v${version}`;
  })
  .catch(() => {});

refreshSources();
setStatus('请输入连接码后开始投屏');
