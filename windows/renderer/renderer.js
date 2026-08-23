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
  peerConnection: null,
  pendingCandidates: [],
  joined: false,
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
  stopping: false
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
      // Cap at 1080p: 2K/4K laptops are downsampled (sharper text on 1080p displays),
      // saving ~75% of bandwidth and encoding load versus native 2K/4K capture.
      width: { ideal: 1920, max: 1920 },
      height: { ideal: 1080, max: 1080 }
    },
    audio: true
  });
  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error('没有获取到屏幕画面');
  }
  videoTrack.contentHint = 'detail';
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

function configureSender(sender, kind) {
  const parameters = sender.getParameters();
  parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
  const encoding = parameters.encodings[0];
  if (kind === 'video') {
    // Screen sharing needs a higher ceiling than a camera stream, especially for text.
    encoding.minBitrate = 1_500_000;
    encoding.maxBitrate = 12_000_000;
    encoding.maxFramerate = 30;
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
    const connectionState = peerConnection.connectionState;
    if (connectionState === 'connected') {
      elements.statusDot.classList.add('is-live');
      setLiveStatus('已连接');
      setStatus('已连接到教室大屏');
      setTimeout(() => api.hideWindow(), 700);
    } else if (connectionState === 'connecting') {
      setLiveStatus('连接中');
    } else if (connectionState === 'disconnected') {
      setLiveStatus('网络中断，等待恢复');
      setStatus('视频连接暂时中断，正在等待网络恢复', true);
    } else if (connectionState === 'failed') {
      setLiveStatus('连接失败');
      setStatus('视频连接失败，请重新开始投屏', true);
    }
  });
  peerConnection.addEventListener('iceconnectionstatechange', () => {
    if (peerConnection.iceConnectionState === 'failed') {
      setStatus('ICE 连接失败，请检查局域网或 TURN 服务', true);
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
  if (!state.mediaStream) {
    return;
  }
  if (state.peerConnection) {
    state.peerConnection.close();
  }
  state.pendingCandidates = [];
  state.peerConnection = createPeerConnection();
  const offer = await state.peerConnection.createOffer();
  await state.peerConnection.setLocalDescription(offer);
  api.sendSignaling({
    type: 'webrtc.offer',
    sdp: state.peerConnection.localDescription.sdp
  });
  setLiveStatus('等待大屏响应');
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
      await negotiate();
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
    state.mediaStream = await requestScreenStream();
    startSourceMonitor();
    elements.localPreview.srcObject = state.mediaStream;
    await elements.localPreview.play().catch(() => {});
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
    state.mediaStream = nextStream;
    elements.localPreview.srcObject = nextStream;
    await elements.localPreview.play().catch(() => {});
    const audioTrack = nextStream.getAudioTracks()[0];
    elements.audioStatus.textContent = audioTrack
      ? (state.micAmplify ? '系统声音 + 麦克风已启用' : '系统声音已启用')
      : '未获取到系统声音';
    startSourceMonitor();
    await negotiate();
    if (generation !== state.sourceSwitchGeneration || state.stopping) {
      return;
    }

    previousStream.getTracks().forEach((track) => track.stop());
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
    state.mediaStream = previousStream;
    elements.localPreview.srcObject = previousStream;
    await elements.localPreview.play().catch(() => {});
    state.captureSourceId = previousSource.id;
    state.captureSourceType = previousSource.type;
    await api.selectSource(previousSource).catch(() => {});
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
    state.mediaStream = nextStream;
    elements.localPreview.srcObject = nextStream;
    await elements.localPreview.play().catch(() => {});
    const audioTrack = nextStream.getAudioTracks()[0];
    elements.audioStatus.textContent = audioTrack
      ? (state.micAmplify ? '系统声音 + 麦克风已启用' : '系统声音已启用')
      : '未获取到系统声音';
    startSourceMonitor();
    await negotiate();
    if (generation !== state.sourceSwitchGeneration || state.stopping) {
      return;
    }

    previousStream.getTracks().forEach((track) => track.stop());
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
    state.mediaStream = previousStream;
    elements.localPreview.srcObject = previousStream;
    await elements.localPreview.play().catch(() => {});
    state.captureSourceId = previousSource.id;
    state.captureSourceType = previousSource.type;
    await api.selectSource(previousSource).catch(() => {});
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
  if (state.peerConnection) {
    state.peerConnection.close();
    state.peerConnection = null;
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
api.onSignalingState(({ state: signalingState }) => {
  if (signalingState === 'connecting') {
    setLiveStatus('连接中');
  } else if (signalingState === 'closed' && state.mediaStream) {
    setStatus('信令连接已断开，正在重连...', true);
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

api.getAppVersion()
  .then((version) => {
    document.title = `MyClass 投屏 v${version}`;
  })
  .catch(() => {});

refreshSources();
setStatus('请输入连接码后开始投屏');
