const api = window.myclass;

const elements = {
  setupCard: document.getElementById('setupCard'),
  liveCard: document.getElementById('liveCard'),
  serverUrl: document.getElementById('serverUrl'),
  roomCode: document.getElementById('roomCode'),
  sourceSelect: document.getElementById('sourceSelect'),
  refreshSourcesButton: document.getElementById('refreshSourcesButton'),
  localAudioOutput: document.getElementById('localAudioOutput'),
  startButton: document.getElementById('startButton'),
  stopButton: document.getElementById('stopButton'),
  audioButton: document.getElementById('audioButton'),
  localAudioButton: document.getElementById('localAudioButton'),
  showButton: document.getElementById('showButton'),
  hideButton: document.getElementById('hideButton'),
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
  audioEnabled: true,
  localAudioOutput: localStorage.getItem('myclass.localAudioOutput') !== 'false',
  localAudioMuted: false,
  captureSourceId: '',
  captureSourceType: 'screen',
  sourceMonitorTimer: null,
  stopping: false
};

elements.serverUrl.value = state.serverUrl;
elements.localAudioOutput.checked = state.localAudioOutput;

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

function setSourceOptions(sourceResult) {
  const sources = sourceResult?.sources || [];
  elements.sourceSelect.replaceChildren();
  if (sources.length === 0) {
    const option = document.createElement('option');
    option.textContent = '没有检测到显示器或应用窗口';
    option.value = '';
    elements.sourceSelect.append(option);
    return;
  }
  const groups = [
    { type: 'screen', label: '显示器' },
    { type: 'window', label: '应用窗口' }
  ];
  for (const group of groups) {
    const groupSources = sources.filter((source) => source.type === group.type);
    if (groupSources.length === 0) continue;
    const optgroup = document.createElement('optgroup');
    optgroup.label = group.label;
    for (const source of groupSources) {
      const option = document.createElement('option');
      option.value = source.id;
      option.textContent = source.type === 'screen' && source.displayId
        ? `${source.name}（显示器 ${source.displayId}）`
        : source.name;
      option.dataset.sourceType = source.type;
      optgroup.append(option);
    }
    elements.sourceSelect.append(optgroup);
  }
  const selectedId = sourceResult.selectedId || sources[0].id;
  elements.sourceSelect.value = selectedId;
  const selected = sources.find((source) => source.id === selectedId) || sources[0];
  state.captureSourceId = selected.id;
  state.captureSourceType = selected.type;
}

async function refreshSources() {
  elements.refreshSourcesButton.disabled = true;
  try {
    setSourceOptions(await api.listSources());
  } catch (error) {
    setStatus(`读取投屏来源失败：${error.message}`, true);
  } finally {
    elements.refreshSourcesButton.disabled = false;
  }
}

async function requestScreenStream() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error('当前 Electron 版本不支持屏幕采集');
  }
  // main process maps this request to the display selected in the control panel.
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      frameRate: { ideal: 30, max: 30 },
      width: { ideal: 2560, max: 3840 },
      height: { ideal: 1440, max: 2160 }
    },
    audio: true
  });
  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error('没有获取到屏幕画面');
  }
  videoTrack.contentHint = 'detail';
  videoTrack.addEventListener('ended', () => {
    if (!state.stopping) {
      stopProjection(false, state.captureSourceType === 'window'
        ? '应用窗口已关闭，投屏已停止'
        : '屏幕采集已停止');
    }
  });
  return stream;
}

function startSourceMonitor() {
  if (state.captureSourceType !== 'window' || state.sourceMonitorTimer) {
    return;
  }
  state.sourceMonitorTimer = setInterval(async () => {
    if (!state.mediaStream || state.stopping) return;
    try {
      if (!await api.sourceAvailable(state.captureSourceId)) {
        await stopProjection(false, '应用窗口已关闭，投屏已停止');
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

async function startProjection() {
  const code = elements.roomCode.value.trim();
  const serverUrl = elements.serverUrl.value.trim();
  if (!/^\d{4}$/.test(code)) {
    setStatus('请输入大屏上显示的 4 位连接码', true);
    elements.roomCode.focus();
    return;
  }
  if (!serverUrl) {
    setStatus('请输入服务器地址', true);
    elements.serverUrl.focus();
    return;
  }
  if (!elements.sourceSelect.value) {
    setStatus('没有可用的显示器或应用窗口', true);
    return;
  }

  elements.startButton.disabled = true;
  elements.startButton.textContent = '正在准备屏幕...';
  state.stopping = false;
  state.roomCode = code;
  state.serverUrl = serverUrl.replace(/\/+$/, '');
  const selectedOption = elements.sourceSelect.selectedOptions[0];
  state.captureSourceId = elements.sourceSelect.value;
  state.captureSourceType = selectedOption?.dataset.sourceType === 'window' ? 'window' : 'screen';
  state.localAudioOutput = elements.localAudioOutput.checked;
  localStorage.setItem('myclass.serverUrl', state.serverUrl);
  localStorage.setItem('myclass.localAudioOutput', String(state.localAudioOutput));
  try {
    await api.selectSource({ id: state.captureSourceId, type: state.captureSourceType });
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
    state.audioEnabled = Boolean(audioTrack);
    elements.audioButton.disabled = !audioTrack;
    elements.audioButton.textContent = audioTrack ? '关闭声音' : '没有系统声音';
    elements.audioStatus.textContent = audioTrack ? '系统声音已启用' : '未获取到系统声音';
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

async function stopProjection(disconnect = true, message = '') {
  state.stopping = true;
  stopSourceMonitor();
  if (state.peerConnection) {
    state.peerConnection.close();
    state.peerConnection = null;
  }
  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach((track) => track.stop());
    state.mediaStream = null;
  }
  elements.localPreview.srcObject = null;
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
  elements.audioButton.disabled = false;
  elements.localAudioButton.disabled = false;
  elements.localAudioButton.textContent = '关闭电脑声音';
  elements.audioStatus.textContent = '准备中';
  setStatus(message || '投屏已停止');
  state.stopping = false;
}

elements.startButton.addEventListener('click', startProjection);
elements.stopButton.addEventListener('click', () => stopProjection(true));
elements.hideButton.addEventListener('click', () => api.hideWindow());
elements.showButton.addEventListener('click', () => api.showWindow());
elements.audioButton.addEventListener('click', () => {
  const track = state.mediaStream?.getAudioTracks()[0];
  if (!track) {
    return;
  }
  track.enabled = !track.enabled;
  state.audioEnabled = track.enabled;
  elements.audioButton.textContent = track.enabled ? '关闭声音' : '开启声音';
  elements.audioStatus.textContent = track.enabled ? '系统声音已启用' : '系统声音已静音';
});
elements.localAudioOutput.addEventListener('change', async () => {
  state.localAudioOutput = elements.localAudioOutput.checked;
  localStorage.setItem('myclass.localAudioOutput', String(state.localAudioOutput));
});
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
elements.sourceSelect.addEventListener('change', async () => {
  const option = elements.sourceSelect.selectedOptions[0];
  state.captureSourceId = elements.sourceSelect.value;
  state.captureSourceType = option?.dataset.sourceType === 'window' ? 'window' : 'screen';
  await api.selectSource({ id: state.captureSourceId, type: state.captureSourceType });
});
elements.refreshSourcesButton.addEventListener('click', refreshSources);

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

refreshSources();
setStatus('请输入连接码后开始投屏');
