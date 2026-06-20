const state = {
  socket: null,
  peerConnection: null,
  config: null,
  reconnectTimer: null,
  videoOrientation: {
    orientation: 'portrait',
    rotationDegrees: 0,
    cameraFacing: 'unknown'
  }
};

const elements = {
  joinView: document.getElementById('joinView'),
  videoView: document.getElementById('videoView'),
  roomCode: document.getElementById('roomCode'),
  apkQr: document.getElementById('apkQr'),
  statusText: document.getElementById('statusText'),
  videoStatus: document.getElementById('videoStatus'),
  remoteVideo: document.getElementById('remoteVideo')
};

bootstrap();

async function bootstrap() {
  try {
    state.config = await loadConfig();
    elements.apkQr.src = './api/apk-qrcode.svg';
    elements.remoteVideo.addEventListener('loadedmetadata', updateVideoPresentation);
    elements.remoteVideo.addEventListener('resize', updateVideoPresentation);
    window.addEventListener('resize', updateVideoPresentation);
    connectSignaling();
  } catch (error) {
    setWaitingStatus('服务配置加载失败，请检查服务端是否启动');
  }
}

async function loadConfig() {
  const response = await fetch('./api/config', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`config http ${response.status}`);
  }
  return response.json();
}

function connectSignaling() {
  clearTimeout(state.reconnectTimer);
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsPath = state.config?.wsPath || '/myclass/ws';
  const socket = new WebSocket(`${protocol}//${window.location.host}${wsPath}`);
  state.socket = socket;

  socket.addEventListener('open', () => {
    sendMessage({ type: 'viewer.join' });
    setWaitingStatus('正在创建课堂...');
  });

  socket.addEventListener('message', (event) => {
    handleSignalMessage(JSON.parse(event.data));
  });

  socket.addEventListener('close', () => {
    cleanupPeerConnection();
    showJoinView();
    elements.roomCode.textContent = '----';
    setWaitingStatus('连接已断开，正在重新连接...');
    state.reconnectTimer = setTimeout(connectSignaling, 1500);
  });

  socket.addEventListener('error', () => {
    setWaitingStatus('信令连接异常，请检查网络');
  });
}

async function handleSignalMessage(message) {
  switch (message.type) {
    case 'room.created':
      elements.roomCode.textContent = message.code;
      setWaitingStatus('等待教师连接...');
      break;
    case 'teacher.online':
      setWaitingStatus('教师已连接，等待直播...');
      break;
    case 'teacher.offline':
      cleanupPeerConnection();
      showJoinView();
      setWaitingStatus('教师已断开，等待重新连接...');
      break;
    case 'webrtc.offer':
      await handleOffer(message.sdp);
      break;
    case 'webrtc.ice-candidate':
      await addRemoteCandidate(message.candidate);
      break;
    case 'teacher.orientation':
      handleTeacherOrientation(message);
      break;
    case 'teacher.stop':
      cleanupPeerConnection();
      showJoinView();
      setWaitingStatus('直播已停止，等待教师重新开始...');
      break;
    case 'room.expired':
      setWaitingStatus('连接码已过期，正在创建新课堂...');
      break;
    case 'error':
      setWaitingStatus(message.message || '服务端返回错误');
      break;
    default:
      break;
  }
}

async function handleOffer(sdp) {
  cleanupPeerConnection();
  const peerConnection = createPeerConnection();
  state.peerConnection = peerConnection;

  await peerConnection.setRemoteDescription({
    type: 'offer',
    sdp
  });
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  sendMessage({
    type: 'webrtc.answer',
    sdp: answer.sdp
  });
}

function createPeerConnection() {
  const peerConnection = new RTCPeerConnection({
    iceServers: state.config?.rtc?.iceServers || []
  });

  // 教师端推送的媒体轨到达后，浏览器立即切换到全屏视频。
  peerConnection.addEventListener('track', (event) => {
    const [stream] = event.streams;
    if (elements.remoteVideo.srcObject !== stream) {
      elements.remoteVideo.srcObject = stream;
    }
    showVideoView();
    updateVideoPresentation();
    elements.videoStatus.textContent = '';
    elements.remoteVideo.play().catch(() => {
      elements.videoStatus.textContent = '点击页面开始播放视频';
    });
  });

  peerConnection.addEventListener('icecandidate', (event) => {
    if (event.candidate) {
      sendMessage({
        type: 'webrtc.ice-candidate',
        candidate: event.candidate.toJSON()
      });
    }
  });

  peerConnection.addEventListener('connectionstatechange', () => {
    const status = peerConnection.connectionState;
    if (status === 'connected') {
      showVideoView();
      elements.videoStatus.textContent = '';
    }
    if (status === 'failed' || status === 'disconnected' || status === 'closed') {
      elements.videoStatus.textContent = '视频连接已断开，等待教师重新开始...';
    }
  });

  return peerConnection;
}

async function addRemoteCandidate(candidate) {
  if (!state.peerConnection || !candidate) {
    return;
  }
  try {
    await state.peerConnection.addIceCandidate(candidate);
  } catch (error) {
    console.warn('addIceCandidate failed', error);
  }
}

function cleanupPeerConnection() {
  if (state.peerConnection) {
    state.peerConnection.close();
    state.peerConnection = null;
  }
  elements.remoteVideo.srcObject = null;
}

function handleTeacherOrientation(message) {
  const rotationDegrees = Number(message.rotationDegrees);
  if (![0, 90, 180, 270].includes(rotationDegrees)) {
    return;
  }

  state.videoOrientation = {
    orientation:
      message.orientation === 'landscape' || rotationDegrees === 90 || rotationDegrees === 270
        ? 'landscape'
        : 'portrait',
    rotationDegrees,
    cameraFacing: ['front', 'back'].includes(message.cameraFacing)
      ? message.cameraFacing
      : 'unknown'
  };
  updateVideoPresentation();
}

function updateVideoPresentation() {
  elements.videoView.dataset.orientation = state.videoOrientation.orientation;
}

function sendMessage(payload) {
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify(payload));
  }
}

function showJoinView() {
  document.body.classList.remove('is-streaming');
  elements.joinView.hidden = false;
  elements.videoView.hidden = true;
}

function showVideoView() {
  document.body.classList.add('is-streaming');
  elements.joinView.hidden = true;
  elements.videoView.hidden = false;
}

function setWaitingStatus(text) {
  elements.statusText.textContent = text;
  elements.videoStatus.textContent = text;
}
