const state = {
  socket: null,
  peerConnection: null,
  config: null,
  reconnectTimer: null,
  presentationMode: 'waiting',
  courseware: null,
  videoOrientation: {
    orientation: 'portrait',
    rotationDegrees: 0,
    cameraFacing: 'unknown'
  },
  framePresentation: {
    frameLocked: false,
    lockedFrameZoomRatio: 1,
    cropX: 0,
    cropY: 0,
    cropWidth: 1,
    cropHeight: 1
  },
  annotations: {
    strokes: [],
    activeStrokes: new Map(),  // key: pointerId → stroke，支持多笔同时绘制
    currentColor: '#ffd166',
    tool: 'pen'
  },
  blackboard: {
    active: false,
    pages: [{ strokes: [] }],  // 每页保存已完成笔画
    currentPage: 0,
    activeStrokes: new Map(),  // 黑板当前页活跃笔画，支持多点
    tool: 'pen',               // 'pen' | 'eraser' | 'hand'
    eraserWidth: 40,           // 板擦半径(px)
    palmDetected: false,       // 是否由手掌触发板擦
    currentColor: '#ffd166',   // 黑板专用颜色
    panX: 0, panY: 0,          // 视口在世界坐标中的偏移(px)
    scale: 1,                  // 缩放级别
    MIN_SCALE: 0.3,
    MAX_SCALE: 5.0,
    // 活动指针位置缓存（用于双指缩放检测）
    _activePointers: new Map(), // pointerId → { x: clientX, y: clientY }
    _pinch: {
      active: false,
      startDist: 0,
      startScale: 1,
      centerX: 0, centerY: 0   // 捏合中心的画布坐标(px)
    },
    // 临时平移手势状态
    _panActive: false,
    _panPointerId: null,
    _panStartX: 0, _panStartY: 0,
    _panStartPanX: 0, _panStartPanY: 0
  },
  coursewarePan: {
    active: false,
    pointerId: null,
    startX: 0,
    startY: 0,
    startOffsetX: 0,
    startOffsetY: 0,
    MIN_SCALE: 1.0,
    MAX_SCALE: 4.0,
    _activePointers: new Map(),
    _pinch: {
      active: false,
      startDist: 0,
      startScale: 1,
      centerX: 0,
      centerY: 0,
      startOffsetX: 0,
      startOffsetY: 0
    }
  },
  downloadOriginalUrl: null,
  teacherToken: null,
  directTeach: false,
  teacherCoursewareList: []
};

let pdfJsPromise = null;

const elements = {
  joinView: document.getElementById('joinView'),
  videoView: document.getElementById('videoView'),
  roomCode: document.getElementById('roomCode'),
  apkQr: document.getElementById('apkQr'),
  downloadHint: document.querySelector('.download-hint'),
  statusText: document.getElementById('statusText'),
  videoStatus: document.getElementById('videoStatus'),
  remoteVideo: document.getElementById('remoteVideo'),
  coursewareCanvas: document.getElementById('coursewareCanvas'),
  annotationCanvas: document.getElementById('annotationCanvas'),
  annotationToolbar: document.getElementById('annotationToolbar'),
  penToolButton: document.getElementById('penToolButton'),
  panToolButton: document.getElementById('panToolButton'),
  annotationColorsContainer: document.getElementById('annotationColors'),
  undoAnnotationButton: document.getElementById('undoAnnotationButton'),
  clearAnnotationButton: document.getElementById('clearAnnotationButton'),
  annotationColorButtons: Array.from(document.querySelectorAll('.annotation-color')),
  fullscreenButton: document.getElementById('fullscreenButton'),
  downloadOriginalButton: document.getElementById('downloadOriginalButton'),
  prevPageButton: document.getElementById('prevPageButton'),
  nextPageButton: document.getElementById('nextPageButton'),
  selectCoursewareButton: document.getElementById('selectCoursewareButton'),
  downloadApkButton: document.getElementById('downloadApkButton'),
  directTeachButton: document.getElementById('directTeachButton'),
  directTeachUser: document.getElementById('directTeachUser'),
  directTeachLogout: document.getElementById('directTeachLogout'),
  coursewarePicker: document.getElementById('coursewarePicker'),
  coursewareGrid: document.getElementById('coursewareGrid'),
  closePickerButton: document.getElementById('closePickerButton'),
  loginModal: document.getElementById('loginModal'),
  teacherLoginForm: document.getElementById('teacherLoginForm'),
  teacherLoginError: document.getElementById('teacherLoginError'),
  teacherUsername: document.getElementById('teacherUsername'),
  teacherPassword: document.getElementById('teacherPassword'),
  teacherLoginCancel: document.getElementById('teacherLoginCancel'),
  teacherLoginSubmit: document.getElementById('teacherLoginSubmit'),
  exitPlatformButton: document.getElementById('exitPlatformButton'),
  blackboardOverlay: document.getElementById('blackboardOverlay'),
  blackboardCanvas: document.getElementById('blackboardCanvas'),
  blackboardToggleButton: document.getElementById('blackboardToggleButton'),
  blackboardPrevPageButton: document.getElementById('blackboardPrevPageButton'),
  blackboardNextPageButton: document.getElementById('blackboardNextPageButton'),
  blackboardNewPageButton: document.getElementById('blackboardNewPageButton'),
  blackboardDelPageButton: document.getElementById('blackboardDelPageButton'),
  blackboardCloseButton: document.getElementById('blackboardCloseButton'),
  blackboardPageIndicator: document.getElementById('blackboardPageIndicator'),
  blackboardUndoButton: document.getElementById('blackboardUndoButton'),
  blackboardClearButton: document.getElementById('blackboardClearButton'),
  blackboardEraserButton: document.getElementById('blackboardEraserButton'),
  blackboardEraserCursor: document.getElementById('blackboardEraserCursor'),
  blackboardPalmIndicator: document.getElementById('blackboardPalmIndicator'),
  blackboardHandButton: document.getElementById('blackboardHandButton'),
  blackboardColorButtons: Array.from(document.querySelectorAll('#blackboardColors .annotation-color')),
  blackboardColorsContainer: document.getElementById('blackboardColors'),
};

bootstrap();

function checkBrowserCompatibility() {
  const issues = [];
  if (typeof RTCPeerConnection === 'undefined' && typeof webkitRTCPeerConnection === 'undefined') {
    issues.push('浏览器不支持WebRTC，请使用Chrome/Edge/Firefox最新版');
  }
  if (!('srcObject' in document.createElement('video'))) {
    issues.push('浏览器不支持视频流播放');
  }
  if (typeof WebSocket === 'undefined') {
    issues.push('浏览器不支持WebSocket');
  }
  return issues;
}

async function bootstrap() {
  // 浏览器兼容性检测
  const compatIssues = checkBrowserCompatibility();
  if (compatIssues.length > 0) {
    setWaitingStatus(compatIssues.join('；'));
    elements.roomCode.textContent = '错误';
    return;
  }
  try {
    state.config = await loadConfig();
    const apkVersion = state.config?.apkVersion || 'latest';
    elements.apkQr.src = `./api/apk-qrcode.svg?v=${encodeURIComponent(apkVersion)}`;
    elements.downloadHint.textContent = `APP v${apkVersion}`;
    if (state.config?.apkUrl) {
      elements.downloadApkButton.href = '#';
      elements.downloadApkButton.style.display = '';
      elements.downloadApkButton.addEventListener('click', async (e) => {
        e.preventDefault();
        elements.downloadApkButton.textContent = '正在下载...';
        elements.downloadApkButton.style.pointerEvents = 'none';
        try {
          const response = await fetch(state.config.apkUrl);
          const total = Number(response.headers.get('content-length')) || 0;
          const reader = response.body.getReader();
          const chunks = [];
          let loaded = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            loaded += value.length;
            if (total) {
              const pct = Math.round(loaded / total * 100);
              elements.downloadApkButton.textContent = `下载中 ${pct}%`;
            }
          }
          elements.downloadApkButton.textContent = '下载完成';
          const blob = new Blob(chunks);
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'myclass.apk';
          a.click();
          URL.revokeObjectURL(url);
        } catch {
          elements.downloadApkButton.textContent = '下载失败，请重试';
          elements.downloadApkButton.style.pointerEvents = 'auto';
        }
      });
    }
    // 直接上课
    elements.directTeachButton.addEventListener('click', () => {
      elements.loginModal.hidden = false;
    });
    elements.teacherLoginCancel.addEventListener('click', () => {
      elements.loginModal.hidden = true;
    });
    elements.teacherLoginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = elements.teacherLoginSubmit;
      btn.disabled = true; btn.textContent = '登录中...';
      elements.teacherLoginError.hidden = true;
      try {
        const res = await fetch('./api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: elements.teacherUsername.value.trim(),
            password: elements.teacherPassword.value
          })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '登录失败');
        state.teacherToken = data.token;
        state.directTeach = true;
        elements.directTeachButton.hidden = true;
        elements.directTeachUser.textContent = `已登录：${data.username}`;
        elements.directTeachUser.hidden = false;
        elements.directTeachLogout.hidden = false;
        elements.loginModal.hidden = true;
        elements.teacherUsername.value = '';
        elements.teacherPassword.value = '';
        loadTeacherCourseware();
      } catch (err) {
        elements.teacherLoginError.textContent = err.message;
        elements.teacherLoginError.hidden = false;
      }
      btn.disabled = false; btn.textContent = '登录';
    });
    elements.directTeachLogout.addEventListener('click', () => {
      state.teacherToken = null;
      state.directTeach = false;
      elements.directTeachButton.hidden = false;
      elements.directTeachUser.hidden = true;
      elements.directTeachLogout.hidden = true;
      elements.coursewarePicker.hidden = true;
    });
    elements.closePickerButton.addEventListener('click', () => {
      elements.coursewarePicker.hidden = true;
    });
    elements.exitPlatformButton.addEventListener('click', () => {
      // 清理连接
      if (state.socket) { state.socket.close(); state.socket = null; }
      if (state.peerConnection) { state.peerConnection.close(); state.peerConnection = null; }
      if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
      // 退出全屏（方便触摸屏手动关闭标签页）
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
      // 尝试关闭窗口
      window.open('', '_self', '');
      window.close();
      // 兜底：覆盖全屏退出提示
      setTimeout(() => {
        document.body.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:1rem;font-size:1.2rem;color:#8892b0;font-family:sans-serif;background:#0a1628"><div>✅ 已退出上课投屏平台</div><div style="font-size:0.9rem">请手动关闭此标签页</div></div>';
      }, 300);
    });
    elements.remoteVideo.addEventListener('loadedmetadata', updateVideoPresentation);
    elements.remoteVideo.addEventListener('resize', updateVideoPresentation);
    window.addEventListener('resize', handleViewportResize);
    // 首次点击页面任意位置自动全屏（排除下载按钮、考试平台链接）
    const autoFullscreen = (e) => {
      if (e.target.closest('#downloadApkButton, #loginModal, #directTeachButton, #teacherLoginForm, #coursewarePicker, .action-btn-exam, .action-btn-exit')) return;
      document.documentElement.requestFullscreen().catch(() => {});
      document.removeEventListener('click', autoFullscreen);
    };
    document.addEventListener('click', autoFullscreen);
    elements.annotationCanvas.addEventListener('pointerdown', beginAnnotationStroke);
    elements.annotationCanvas.addEventListener('pointermove', continueAnnotationStroke);
    elements.annotationCanvas.addEventListener('pointerup', finishAnnotationStroke);
    elements.annotationCanvas.addEventListener('pointercancel', finishAnnotationStroke);
    // 黑板事件
    elements.blackboardCanvas.addEventListener('pointerdown', beginBlackboardStroke);
    elements.blackboardCanvas.addEventListener('pointermove', continueBlackboardStroke);
    elements.blackboardCanvas.addEventListener('pointerup', finishBlackboardStroke);
    elements.blackboardCanvas.addEventListener('pointercancel', finishBlackboardStroke);
    elements.blackboardToggleButton.addEventListener('click', toggleBlackboard);
    elements.blackboardCloseButton.addEventListener('click', () => toggleBlackboard(false));
    elements.blackboardPrevPageButton.addEventListener('click', () => navigateBlackboardPage(-1));
    elements.blackboardNextPageButton.addEventListener('click', () => navigateBlackboardPage(1));
    elements.blackboardNewPageButton.addEventListener('click', addBlackboardPage);
    elements.blackboardDelPageButton.addEventListener('click', deleteBlackboardPage);
    elements.blackboardUndoButton.addEventListener('click', undoBlackboardStroke);
    elements.blackboardClearButton.addEventListener('click', clearBlackboard);
    elements.blackboardEraserButton.addEventListener('click', toggleBlackboardEraser);
    elements.blackboardHandButton.addEventListener('click', toggleBlackboardHand);
    elements.blackboardColorButtons.forEach((btn) => {
      btn.addEventListener('click', () => setBlackboardColor(btn.dataset.color));
    });
    window.addEventListener('resize', resizeBlackboardCanvas);
    // 黑板板擦光标跟踪（文档级，绕过 canvas 指针捕获）
    document.addEventListener('pointermove', (event) => {
      if (!state.blackboard.active || state.blackboard.tool !== 'eraser') return;
      elements.blackboardEraserCursor.style.left = event.clientX + 'px';
      elements.blackboardEraserCursor.style.top = event.clientY + 'px';
      const size = state.blackboard.eraserWidth * 2;
      elements.blackboardEraserCursor.style.width = size + 'px';
      elements.blackboardEraserCursor.style.height = size + 'px';
    });
    if (elements.penToolButton) {
      elements.penToolButton.addEventListener('click', () => setAnnotationTool('pen'));
    }
    elements.panToolButton.addEventListener('click', () => setAnnotationTool('pan'));
    elements.undoAnnotationButton.addEventListener('click', undoAnnotationStroke);
    elements.clearAnnotationButton.addEventListener('click', clearAnnotations);
    elements.fullscreenButton.addEventListener('click', toggleFullscreen);
    elements.downloadOriginalButton.addEventListener('click', downloadOriginalFile);
    elements.prevPageButton.addEventListener('click', () => navigatePage(-1));
    elements.nextPageButton.addEventListener('click', () => navigatePage(1));
    if (elements.selectCoursewareButton) elements.selectCoursewareButton.addEventListener('click', showTeacherCoursewarePicker);
    document.addEventListener('fullscreenchange', updateFullscreenButton);
    elements.annotationColorButtons.forEach((button) => {
      button.addEventListener('click', () => setAnnotationColor(button.dataset.color));
    });
    updateAnnotationButtons();
    updateAnnotationColorButtons();
    updateAnnotationToolButtons();
    setupStudentRoller();
    connectSignaling();
  } catch (error) {
    setWaitingStatus('服务配置加载失败，请检查服务端是否启动');
  }
}

function setupStudentRoller() {
  const MAX_NO = 50;
  const DURATION = 1800;
  const btn = document.getElementById('rollStudentButton');
  const result = document.getElementById('rollStudentResult');
  let rolling = false;
  let timer = null;

  btn.addEventListener('click', () => {
    if (rolling) return;
    rolling = true;
    const startTime = Date.now();

    result.classList.remove('done');
    result.classList.add('rolling');

    const tick = () => {
      const elapsed = Date.now() - startTime;
      if (elapsed >= DURATION) {
        result.classList.remove('rolling');
        const final = Math.floor(Math.random() * MAX_NO) + 1;
        result.textContent = String(final).padStart(2, '0');
        result.classList.add('done');
        rolling = false;
        return;
      }
      const n = Math.floor(Math.random() * MAX_NO) + 1;
      result.textContent = String(n).padStart(2, '0');
      const interval = elapsed < 200 ? 50 : elapsed < 800 ? 100 : elapsed < 1400 ? 180 : 280;
      timer = setTimeout(tick, interval);
    };

    tick();
  });
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
    if (state.presentationMode === 'courseware') {
      setWaitingStatus('信令连接已断开，可继续翻页查看课件');
    } else {
      showJoinView();
      setWaitingStatus('连接已断开，正在重新连接...');
    }
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
      hideDirectTeachUI();
      setWaitingStatus('教师已连接，等待直播...');
      break;
    case 'teacher.offline':
      cleanupPeerConnection();
      showDirectTeachUI();
      if (state.presentationMode === 'courseware') {
        setWaitingStatus('教师设备已断开，可继续翻页查看课件');
      } else {
        showJoinView();
        setWaitingStatus('教师已断开，等待重新连接...');
      }
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
    case 'courseware.open':
      openCourseware(message);
      break;
    case 'courseware.navigate':
      navigateCourseware(message.delta);
      break;
    case 'courseware.page':
      showCoursewarePage(message.page);
      break;
    case 'courseware.close':
      closeCourseware('课件已结束');
      break;
    case 'courseware.original':
      handleCoursewareOriginal(message);
      break;
    case 'teacher.stop':
      cleanupPeerConnection();
      if (state.presentationMode === 'courseware') {
        closeCourseware('课件已结束');
      } else {
        closeCourseware('直播已停止，等待教师重新开始...');
      }
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
  if (!peerConnection) return;
  state.peerConnection = peerConnection;

  elements.videoStatus.textContent = '正在建立视频连接...';
  try {
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
    elements.videoStatus.textContent = '正在建立视频连接...';
  } catch (error) {
    console.error('handleOffer failed:', error);
    elements.videoStatus.textContent = '建立视频连接失败，请刷新页面重试';
    cleanupPeerConnection();
  }
}

function createPeerConnection() {
  const RTCPC = window.RTCPeerConnection || window.webkitRTCPeerConnection;
  if (!RTCPC) {
    elements.videoStatus.textContent = '浏览器不支持WebRTC，请使用Chrome或Edge最新版';
    return null;
  }

  const config = {
    iceServers: state.config?.rtc?.iceServers || []
  };

  const peerConnection = new RTCPC(config);

  // 教师端推送的媒体轨到达后，浏览器立即切换到全屏视频。
  peerConnection.addEventListener('track', (event) => {
    configureLowLatencyReceiver(event.receiver);

    // Unmute video element when audio track arrives
    if (event.track.kind === 'audio') {
      elements.remoteVideo.muted = false;
      event.track.addEventListener('unmute', () => {
        elements.remoteVideo.muted = false;
      });
    }

    // 处理 stream：某些浏览器 event.streams 可能为空
    let stream = null;
    if (event.streams && event.streams.length > 0) {
      stream = event.streams[0];
    }

    if (stream) {
      if (elements.remoteVideo.srcObject !== stream) {
        elements.remoteVideo.srcObject = stream;
      }
      showVideoView();
      updateVideoPresentation();
      elements.videoStatus.textContent = '';
      // 带用户手势恢复的自动播放
      const playPromise = elements.remoteVideo.play();
      if (playPromise) {
        playPromise.catch(() => {
          elements.videoStatus.textContent = '点击画面开始播放';
          // 全局点击恢复播放
          const resumeOnClick = () => {
            elements.remoteVideo.play().then(() => {
              elements.videoStatus.textContent = '';
            }).catch(() => {});
            document.removeEventListener('click', resumeOnClick);
          };
          document.addEventListener('click', resumeOnClick, { once: false });
        });
      }
    } else {
      console.warn('track event received but no stream available');
      elements.videoStatus.textContent = '收到视频信号但无法获取画面流，请刷新页面重试';
    }
  });

  peerConnection.addEventListener('icecandidate', (event) => {
    if (event.candidate) {
      sendMessage({
        type: 'webrtc.ice-candidate',
        candidate: event.candidate.toJSON()
      });
    }
  });

  // ICE 连接状态 — 提供诊断信息
  peerConnection.addEventListener('iceconnectionstatechange', () => {
    const iceState = peerConnection.iceConnectionState;
    if (iceState === 'checking') {
      elements.videoStatus.textContent = '正在建立视频连接...';
    } else if (iceState === 'connected' || iceState === 'completed') {
      elements.videoStatus.textContent = '';
    } else if (iceState === 'failed') {
      elements.videoStatus.textContent = '视频连接失败，请在手机上重新开启直播';
    } else if (iceState === 'disconnected') {
      elements.videoStatus.textContent = '视频连接中断，等待恢复...';
    }
  });

  // 整体连接状态
  peerConnection.addEventListener('connectionstatechange', () => {
    const status = peerConnection.connectionState;
    if (status === 'connected') {
      showVideoView();
      elements.videoStatus.textContent = '';
    } else if (status === 'failed') {
      elements.videoStatus.textContent = '视频连接失败，请在手机上重新开启直播';
    } else if (status === 'disconnected') {
      elements.videoStatus.textContent = '视频连接已断开，等待教师重新开始...';
    }
  });

  return peerConnection;
}

function configureLowLatencyReceiver(receiver) {
  if (!receiver) {
    return;
  }
  try {
    if ('playoutDelayHint' in receiver) {
      receiver.playoutDelayHint = 0;
    }
  } catch (error) {
    console.debug('low latency receiver setup skipped', error);
  }
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
  state.framePresentation = {
    frameLocked: false,
    lockedFrameZoomRatio: 1,
    cropX: 0,
    cropY: 0,
    cropWidth: 1,
    cropHeight: 1
  };
  updateVideoPresentation();
}

function openCourseware(message) {
  const url = typeof message.url === 'string' ? message.url : '';
  if (!url) {
    return;
  }

  setAnnotationTool('pen');

  // ZIP 文件：不尝试渲染，仅提供下载
  const isZip = /\.zip(\?|$)/i.test(url);
  state.courseware = {
    url,
    title: typeof message.title === 'string' ? message.title : '课件',
    page: normalizePageNumber(message.page),
    screen: normalizePageNumber(message.screen),
    screenCount: 1,
    offsetX: 0,
    offsetY: 0,
    maxOffsetX: 0,
    maxOffsetY: 0,
    scale: 1,
    pageStepY: 0,
    fitMode: 'fit-page',
    cssWidth: 1,
    cssHeight: 1,
    pageCount: isZip ? 0 : 0,
    pdfDocument: null,
    loadingTask: null,
    renderTask: null,
    renderGeneration: 0
  };
  // 从消息中读取原始文件下载地址（服务端已注入）
  // ZIP 文件：直接用 url 作为下载链接
  if (isZip) {
    state.downloadOriginalUrl = url;
  } else if (typeof message.originalUrl === 'string' && message.originalUrl) {
    state.downloadOriginalUrl = message.originalUrl;
    state.courseware.downloadOriginalUrl = message.originalUrl;
  }
  if (isZip) {
    cleanupPeerConnection();
    resetAnnotations();
    showCoursewareViewForZip(state.courseware);
  } else {
    // 先切到课件画面（隐藏 video，显示 canvas）
    showCoursewareView();
    // PDF 加载完成后再清理 WebRTC，避免加载失败时黑屏
    loadCoursewareDocument(state.courseware).finally(() => {
      cleanupPeerConnection();
      resetAnnotations();
    });
  }
}

function showCoursewareViewForZip(courseware) {
  state.presentationMode = 'courseware';
  state.downloadOriginalUrl = courseware.url;
  showDownloadButtonIfAvailable();
  elements.remoteVideo.hidden = true;
  elements.coursewareCanvas.hidden = true;
  elements.videoView.dataset.orientation = 'landscape';
  elements.videoView.dataset.lockedZoomed = 'false';
  document.body.classList.add('is-streaming');
  elements.joinView.hidden = true;
  elements.videoView.hidden = false;
  elements.panToolButton.hidden = true;
  elements.prevPageButton.hidden = true;
  elements.nextPageButton.hidden = true;
  elements.videoStatus.hidden = false;
  elements.videoStatus.textContent = `${courseware.title}（压缩包，请下载后查看）`;
  elements.annotationCanvas.hidden = true;
  elements.annotationToolbar.hidden = true;
}

function showCoursewarePage(page) {
  if (!state.courseware) {
    return;
  }
  const nextPage = normalizePageNumber(page);
  if (nextPage === state.courseware.page) {
    return;
  }
  state.courseware.page = nextPage;
  state.courseware.screen = 1;
  state.courseware.offsetY = 0;
  resetAnnotations();
  renderCoursewarePage();
}

function navigateCourseware(deltaValue) {
  const courseware = state.courseware;
  if (!courseware?.pdfDocument) {
    return;
  }

  const delta = Number(deltaValue) < 0 ? -1 : 1;
  if (courseware.screenCount > 1) {
    const nextScreen = courseware.screen + delta;
    if (nextScreen >= 1 && nextScreen <= courseware.screenCount) {
      setCoursewareScreen(nextScreen);
      return;
    }
  }

  const nextPage = courseware.page + delta;
  if (nextPage < 1 || nextPage > courseware.pageCount) {
    sendCoursewareState();
    return;
  }

  courseware.page = nextPage;
  courseware.screen = delta > 0 ? 1 : Number.MAX_SAFE_INTEGER;
  courseware.offsetY = 0;
  resetAnnotations();
  renderCoursewarePage();
}

function navigatePage(delta) {
  const courseware = state.courseware;
  if (!courseware?.pdfDocument) {
    return;
  }

  const nextPage = courseware.page + (delta < 0 ? -1 : 1);
  if (nextPage < 1 || nextPage > courseware.pageCount) {
    return;
  }

  courseware.page = nextPage;
  courseware.screen = 1;
  courseware.offsetX = 0;
  courseware.offsetY = 0;
  courseware.scale = 1;
  state.coursewarePan._activePointers.clear();
  state.coursewarePan._pinch.active = false;
  resetAnnotations();
  renderCoursewarePage();
}

function updatePageNavButtons() {
  const courseware = state.courseware;
  if (!courseware?.pdfDocument) {
    elements.prevPageButton.disabled = true;
    elements.nextPageButton.disabled = true;
    return;
  }
  elements.prevPageButton.disabled = courseware.page <= 1;
  elements.nextPageButton.disabled = courseware.page >= courseware.pageCount;
}

function hideDirectTeachUI() {
  elements.directTeachButton.hidden = true;
  if (elements.downloadApkButton) elements.downloadApkButton.style.display = 'none';
  elements.directTeachUser.hidden = true;
  elements.directTeachLogout.hidden = true;
  elements.coursewarePicker.hidden = true;
}

function showDirectTeachUI() {
  elements.directTeachButton.hidden = false;
  if (elements.downloadApkButton) elements.downloadApkButton.style.display = '';
}

function closeCourseware(statusText = '课件播放已结束，等待教师连接...') {
  // 1. 先立即切回主页（必须最先执行，确保画面立刻切换）
  try { document.body.classList.remove('is-streaming'); } catch {}
  try { elements.joinView.hidden = false; } catch {}
  try { elements.videoView.hidden = true; } catch {}
  try { elements.coursewareCanvas.hidden = true; } catch {}
  try { elements.panToolButton.hidden = true; } catch {}
  try { elements.prevPageButton.hidden = true; } catch {}
  try { elements.nextPageButton.hidden = true; } catch {}
  if (elements.selectCoursewareButton) try { elements.selectCoursewareButton.hidden = true; } catch {}
  try { elements.remoteVideo.hidden = false; } catch {}

  // 2. 重置状态
  try { state.presentationMode = 'waiting'; } catch {}
  try { state.directTeach = false; } catch {}

  // 3. 安全清理课件资源
  try { destroyCoursewareDocument(state.courseware); } catch {}
  try { state.courseware = null; } catch {}
  try { clearCoursewareCanvas(); } catch {}
  try { resetAnnotations(); } catch {}

  // 4. 清理下载相关
  try { hideDownloadButton(); } catch {}

  // 5. 更新提示
  try { setWaitingStatus(statusText); } catch {}
}

async function loadCoursewareDocument(courseware) {
  const pdfjsLib = await loadPdfJs();
  if (state.courseware !== courseware) {
    return;
  }

  elements.videoStatus.textContent = `${courseware.title} 正在加载...`;
  const loadingTask = pdfjsLib.getDocument({
    url: courseware.url,
    cMapUrl: './vendor/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: './vendor/pdfjs/standard_fonts/'
  });
  courseware.loadingTask = loadingTask;

  try {
    const pdfDocument = await loadingTask.promise;
    if (state.courseware !== courseware) {
      pdfDocument.destroy();
      return;
    }
    courseware.pdfDocument = pdfDocument;
    courseware.pageCount = pdfDocument.numPages;
    courseware.page = clamp(courseware.page, 1, pdfDocument.numPages);
    renderCoursewarePage();
  } catch (error) {
    if (state.courseware === courseware) {
      elements.videoStatus.textContent = '课件加载失败，请重新选择课件';
    }
  }
}

async function renderCoursewarePage() {
  const courseware = state.courseware;
  if (!courseware) {
    return;
  }

  if (!courseware.pdfDocument) {
    elements.videoStatus.textContent = `${courseware.title} 正在加载...`;
    return;
  }

  courseware.page = clamp(courseware.page, 1, courseware.pageCount);
  const generation = ++courseware.renderGeneration;
  let renderTask = null;
  cancelCoursewareRender(courseware);

  try {
    const page = await courseware.pdfDocument.getPage(courseware.page);
    if (state.courseware !== courseware || generation !== courseware.renderGeneration) {
      return;
    }

    const canvas = elements.coursewareCanvas;
    const containerRect = elements.videoView.getBoundingClientRect();
    const baseViewport = page.getViewport({ scale: 1 });
    const isPortraitDocumentPage = baseViewport.height > baseViewport.width * 1.15;
    const fitScale = isPortraitDocumentPage
      ? containerRect.width / baseViewport.width
      : Math.min(
          containerRect.width / baseViewport.width,
          containerRect.height / baseViewport.height
        );
    const cssViewport = page.getViewport({ scale: fitScale });
    const outputScale = Math.min(window.devicePixelRatio || 1, 2);
    const renderViewport = page.getViewport({ scale: fitScale * outputScale });

    canvas.width = Math.max(1, Math.round(renderViewport.width));
    canvas.height = Math.max(1, Math.round(renderViewport.height));
    courseware.fitMode = isPortraitDocumentPage ? 'width-fill' : 'fit-page';
    courseware.cssWidth = Math.round(cssViewport.width);
    courseware.cssHeight = Math.round(cssViewport.height);
    courseware.maxOffsetX = Math.max(0, courseware.cssWidth - containerRect.width);
    // 至少超出10px才算需要翻屏，避免取整误差导致多出一屏
    courseware.maxOffsetY = Math.max(0, courseware.cssHeight - containerRect.height - 10);
    if (courseware.maxOffsetY < 0) courseware.maxOffsetY = 0;
    courseware.pageStepY = Math.max(1, Math.round(containerRect.height * 0.9));
    courseware.screenCount = courseware.maxOffsetY > 0
      ? Math.ceil(courseware.maxOffsetY / courseware.pageStepY) + 1
      : 1;
    courseware.screen = clamp(courseware.screen || 1, 1, courseware.screenCount);
    courseware.offsetX = clamp(courseware.offsetX || 0, 0, courseware.maxOffsetX);
    courseware.offsetY = offsetYForCoursewareScreen(courseware, courseware.screen);
    updateCoursewareCanvasPlacement();

    const context = canvas.getContext('2d', { alpha: false });
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    renderTask = page.render({
      canvasContext: context,
      viewport: renderViewport
    });
    courseware.renderTask = renderTask;
    await renderTask.promise;
    if (state.courseware === courseware && generation === courseware.renderGeneration) {
      updateCoursewareStatus();
      updatePageNavButtons();
      sendCoursewareState();
      updateVideoPresentation();
    }
  } catch (error) {
    if (error?.name !== 'RenderingCancelledException' && state.courseware === courseware) {
      elements.videoStatus.textContent = '课件页面渲染失败';
    }
  } finally {
    if (state.courseware === courseware && renderTask && courseware.renderTask === renderTask) {
      courseware.renderTask = null;
    }
  }
}

function loadPdfJs() {
  if (!pdfJsPromise) {
    pdfJsPromise = new Promise((resolve, reject) => {
      const lib = window.pdfjsLib;
      if (!lib) {
        reject(new Error('PDF组件加载失败，请使用Chrome或Edge浏览器打开此页面'));
        return;
      }
      lib.GlobalWorkerOptions.workerSrc = './vendor/pdfjs/build/pdf.worker.min.js';
      resolve(lib);
    });
  }
  return pdfJsPromise;
}

function setCoursewareScreen(screen) {
  const courseware = state.courseware;
  if (!courseware) {
    return;
  }

  courseware.screen = clamp(Math.round(screen), 1, courseware.screenCount);
  courseware.offsetX = 0;
  courseware.offsetY = offsetYForCoursewareScreen(courseware, courseware.screen);
  courseware.scale = 1;
  state.coursewarePan._activePointers.clear();
  state.coursewarePan._pinch.active = false;
  updateCoursewareCanvasPlacement();
  updateCoursewareStatus();
  sendCoursewareState();
  drawAnnotations();
}

function offsetYForCoursewareScreen(courseware, screen) {
  if (courseware.screenCount <= 1) {
    return 0;
  }
  return clamp((screen - 1) * courseware.pageStepY, 0, courseware.maxOffsetY);
}

function screenForCoursewareOffset(courseware) {
  if (courseware.screenCount <= 1 || courseware.pageStepY <= 0) {
    return 1;
  }
  return clamp(Math.round(courseware.offsetY / courseware.pageStepY) + 1, 1, courseware.screenCount);
}

function updateCoursewareCanvasPlacement() {
  const courseware = state.courseware;
  if (!courseware) {
    return;
  }

  const canvas = elements.coursewareCanvas;
  const containerRect = elements.videoView.getBoundingClientRect();
  const scale = courseware.scale || 1;
  const left = courseware.maxOffsetX > 0 || scale > 1
    ? -courseware.offsetX
    : (containerRect.width - courseware.cssWidth) / 2;
  const top = courseware.maxOffsetY > 0 || scale > 1
    ? -courseware.offsetY
    : (containerRect.height - courseware.cssHeight) / 2;
  canvas.style.width = `${courseware.cssWidth}px`;
  canvas.style.height = `${courseware.cssHeight}px`;
  canvas.style.left = `${Math.round(left)}px`;
  canvas.style.top = `${Math.round(top)}px`;
  canvas.style.transform = `scale(${scale})`;
  canvas.style.transformOrigin = '0 0';
}

function updateCoursewareStatus() {
  const courseware = state.courseware;
  if (!courseware) {
    return;
  }

  const pageText = `第 ${courseware.page} / ${courseware.pageCount} 页`;
  const screenText = courseware.screenCount > 1
    ? `，第 ${courseware.screen} / ${courseware.screenCount} 屏`
    : '';
  elements.videoStatus.textContent = `${courseware.title} ${pageText}${screenText}`;
}

function sendCoursewareState() {
  const courseware = state.courseware;
  if (!courseware) {
    return;
  }

  sendMessage({
    type: 'courseware.state',
    page: courseware.page,
    pageCount: courseware.pageCount,
    screen: courseware.screen,
    screenCount: courseware.screenCount,
    fitMode: courseware.fitMode
  });
}

function cancelCoursewareRender(courseware) {
  if (courseware?.renderTask) {
    courseware.renderTask.cancel();
    courseware.renderTask = null;
  }
}

function destroyCoursewareDocument(courseware) {
  cancelCoursewareRender(courseware);
  if (courseware?.loadingTask) {
    courseware.loadingTask.destroy();
    courseware.loadingTask = null;
  }
  if (courseware?.pdfDocument) {
    courseware.pdfDocument.destroy();
    courseware.pdfDocument = null;
  }
}

function clearCoursewareCanvas() {
  const canvas = elements.coursewareCanvas;
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);
  canvas.removeAttribute('style');
  canvas.width = 1;
  canvas.height = 1;
}

function normalizePageNumber(value) {
  const page = Number(value);
  return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
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
  state.framePresentation = {
    frameLocked: message.frameLocked === true,
    lockedFrameZoomRatio: normalizedZoomRatio(message.lockedFrameZoomRatio),
    ...normalizedLockedFrameCrop(message)
  };
  updateVideoPresentation();
}

function updateVideoPresentation() {
  elements.videoView.dataset.orientation = state.videoOrientation.orientation;
  elements.videoView.dataset.lockedZoomed =
    state.framePresentation.frameLocked && state.framePresentation.lockedFrameZoomRatio > 1.03
      ? 'true'
      : 'false';
  resizeAnnotationCanvas();
  drawAnnotations();
  updateAnnotationButtons();
}

function handleViewportResize() {
  if (state.presentationMode === 'courseware') {
    renderCoursewarePage();
    resizeAnnotationCanvas();
    drawAnnotations();
    return;
  }
  updateVideoPresentation();
}

function normalizedZoomRatio(value) {
  const ratio = Number(value);
  return Number.isFinite(ratio) && ratio > 1 ? ratio : 1;
}

function normalizedLockedFrameCrop(message) {
  const cropWidth = clamp(normalizedNumber(message.lockedFrameCropWidth, 1), 0.001, 1);
  const cropHeight = clamp(normalizedNumber(message.lockedFrameCropHeight, 1), 0.001, 1);
  const cropX = clamp(normalizedNumber(message.lockedFrameCropX, 0), 0, 1 - cropWidth);
  const cropY = clamp(normalizedNumber(message.lockedFrameCropY, 0), 0, 1 - cropHeight);
  if (cropWidth <= 0 || cropHeight <= 0) {
    return fullLockedFrameCrop();
  }
  return {
    cropX,
    cropY,
    cropWidth,
    cropHeight
  };
}

function normalizedNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function fullLockedFrameCrop() {
  return {
    cropX: 0,
    cropY: 0,
    cropWidth: 1,
    cropHeight: 1
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function resizeAnnotationCanvas() {
  const canvas = elements.annotationCanvas;
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * ratio));
  const height = Math.max(1, Math.round(rect.height * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

function beginAnnotationStroke(event) {
  // 课件模式 + 手型工具：记录指针位置供捏合检测
  if (state.presentationMode === 'courseware' && state.annotations.tool === 'pan') {
    state.coursewarePan._activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (state.coursewarePan._activePointers.size >= 2) {
      abortCoursewarePan();
      startCoursewarePinch();
      return;
    }
    if (event.isPrimary) beginCoursewarePan(event);
    return;
  }
  const point = pointerEventToSourcePoint(event);
  if (!point) {
    return;
  }
  event.preventDefault();
  elements.annotationCanvas.setPointerCapture(event.pointerId);
  state.annotations.activeStrokes.set(event.pointerId, {
    pointerId: event.pointerId,
    color: state.annotations.currentColor,
    width: 6,
    points: [point]
  });
  drawAnnotations();
}

function continueAnnotationStroke(event) {
  // 课件模式 + 手型工具：持续更新指针位置，处理捏合/平移
  if (state.presentationMode === 'courseware' && state.annotations.tool === 'pan') {
    state.coursewarePan._activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (state.coursewarePan._pinch.active) {
      continueCoursewarePinch();
      return;
    }
  }
  if (state.coursewarePan.active && state.coursewarePan.pointerId === event.pointerId) {
    // 平移中检测是否出现第二指
    if (state.coursewarePan._activePointers.size >= 2) {
      abortCoursewarePan();
      startCoursewarePinch();
      return;
    }
    continueCoursewarePan(event);
    return;
  }
  const stroke = state.annotations.activeStrokes.get(event.pointerId);
  if (!stroke) {
    return;
  }
  const point = pointerEventToSourcePoint(event);
  if (!point) {
    return;
  }
  event.preventDefault();
  const lastPoint = stroke.points.at(-1);
  if (lastPoint && Math.hypot(point.x - lastPoint.x, point.y - lastPoint.y) < 0.001) {
    return;
  }
  stroke.points.push(point);
  drawAnnotations();
}

function finishAnnotationStroke(event) {
  // 课件模式 + 手型工具：清理指针并处理捏合结束
  if (state.presentationMode === 'courseware' && state.annotations.tool === 'pan') {
    state.coursewarePan._activePointers.delete(event.pointerId);
    if (state.coursewarePan._pinch.active) {
      endCoursewarePinch();
      return;
    }
  }
  if (state.coursewarePan.active && state.coursewarePan.pointerId === event.pointerId) {
    finishCoursewarePan(event);
    return;
  }
  const stroke = state.annotations.activeStrokes.get(event.pointerId);
  if (!stroke) {
    return;
  }
  event.preventDefault();
  if (stroke.points.length > 0) {
    state.annotations.strokes.push({
      color: stroke.color,
      width: stroke.width,
      points: stroke.points
    });
  }
  state.annotations.activeStrokes.delete(event.pointerId);
  runCatching(() => elements.annotationCanvas.releasePointerCapture(event.pointerId));
  drawAnnotations();
  updateAnnotationButtons();
}

function beginCoursewarePan(event) {
  const courseware = state.courseware;
  if (!courseware) return;
  const scale = courseware.scale || 1;
  const effectiveMaxX = Math.max(0, courseware.cssWidth * scale - elements.videoView.getBoundingClientRect().width);
  const effectiveMaxY = Math.max(0, courseware.cssHeight * scale - elements.videoView.getBoundingClientRect().height);
  if (effectiveMaxX <= 0 && effectiveMaxY <= 0) return;
  event.preventDefault();
  elements.annotationCanvas.setPointerCapture(event.pointerId);
  state.coursewarePan.active = true;
  state.coursewarePan.pointerId = event.pointerId;
  state.coursewarePan.startX = event.clientX;
  state.coursewarePan.startY = event.clientY;
  state.coursewarePan.startOffsetX = courseware.offsetX;
  state.coursewarePan.startOffsetY = courseware.offsetY;
  elements.annotationCanvas.classList.add('is-panning');
}

function continueCoursewarePan(event) {
  const courseware = state.courseware;
  if (!courseware) return;
  event.preventDefault();
  const scale = courseware.scale || 1;
  const deltaX = event.clientX - state.coursewarePan.startX;
  const deltaY = event.clientY - state.coursewarePan.startY;
  const effectiveMaxX = Math.max(0, courseware.cssWidth * scale - elements.videoView.getBoundingClientRect().width);
  const effectiveMaxY = Math.max(0, courseware.cssHeight * scale - elements.videoView.getBoundingClientRect().height);
  courseware.offsetX = clamp(
    state.coursewarePan.startOffsetX - deltaX,
    0,
    effectiveMaxX
  );
  courseware.offsetY = clamp(
    state.coursewarePan.startOffsetY - deltaY,
    0,
    effectiveMaxY
  );
  courseware.screen = screenForCoursewareOffset(courseware);
  updateCoursewareCanvasPlacement();
  updateCoursewareStatus();
  drawAnnotations();
}

function finishCoursewarePan(event) {
  event.preventDefault();
  runCatching(() => elements.annotationCanvas.releasePointerCapture(event.pointerId));
  state.coursewarePan.active = false;
  state.coursewarePan.pointerId = null;
  elements.annotationCanvas.classList.remove('is-panning');
  sendCoursewareState();
}

// 取消当前课件平移（不清除指针捕捉，由后续操作接管）
function abortCoursewarePan() {
  if (!state.coursewarePan.active) return;
  state.coursewarePan.active = false;
  state.coursewarePan.pointerId = null;
  elements.annotationCanvas.classList.remove('is-panning');
}

// 启动课件双指缩放
function startCoursewarePinch() {
  const pointers = [...state.coursewarePan._activePointers.values()];
  if (pointers.length < 2) return;
  const courseware = state.courseware;
  if (!courseware) return;
  const r = elements.videoView.getBoundingClientRect();
  const dist = pointerDist(pointers[0], pointers[1]);
  const center = pinchCenter(pointers[0], pointers[1]);

  state.coursewarePan._pinch.active = true;
  state.coursewarePan._pinch.startDist = dist > 0 ? dist : 1;
  state.coursewarePan._pinch.startScale = courseware.scale || 1;
  state.coursewarePan._pinch.startOffsetX = courseware.offsetX;
  state.coursewarePan._pinch.startOffsetY = courseware.offsetY;
  state.coursewarePan._pinch.centerX = center.x - r.left;
  state.coursewarePan._pinch.centerY = center.y - r.top;
  elements.annotationCanvas.classList.add('is-pinching');
}

// 持续课件双指缩放（以捏合中心为焦点，CSS transform 坐标系）
function continueCoursewarePinch() {
  const pointers = [...state.coursewarePan._activePointers.values()];
  if (pointers.length < 2) {
    endCoursewarePinch();
    return;
  }
  const courseware = state.courseware;
  if (!courseware) return;
  const r = elements.videoView.getBoundingClientRect();
  const dist = pointerDist(pointers[0], pointers[1]);
  const center = pinchCenter(pointers[0], pointers[1]);
  if (dist < 0.5) return;

  const pinch = state.coursewarePan._pinch;
  const ratio = dist / pinch.startDist;
  const newScale = clamp(pinch.startScale * ratio, state.coursewarePan.MIN_SCALE, state.coursewarePan.MAX_SCALE);
  const oldScale = courseware.scale || 1;

  if (Math.abs(newScale - oldScale) > 0.001) {
    // CSS transform 坐标系公式：delta = (screenC + offset) * (newScale/oldScale - 1)
    const screenCx = center.x - r.left;
    const screenCy = center.y - r.top;
    const factor = newScale / oldScale - 1;
    courseware.offsetX += (screenCx + courseware.offsetX) * factor;
    courseware.offsetY += (screenCy + courseware.offsetY) * factor;
    courseware.scale = newScale;

    updateCoursewareCanvasPlacement();
    drawAnnotations();
  }
}

// 结束课件双指缩放
function endCoursewarePinch() {
  const wasActive = state.coursewarePan._pinch.active;
  state.coursewarePan._pinch.active = false;
  state.coursewarePan._pinch.startDist = 0;
  elements.annotationCanvas.classList.remove('is-pinching');
  if (!wasActive) return;

  const courseware = state.courseware;
  if (!courseware) return;

  // 缩放结束后钳位偏移到合法范围
  const scale = courseware.scale || 1;
  const containerW = elements.videoView.getBoundingClientRect().width;
  const containerH = elements.videoView.getBoundingClientRect().height;
  const effMaxX = Math.max(0, courseware.cssWidth * scale - containerW);
  const effMaxY = Math.max(0, courseware.cssHeight * scale - containerH);
  courseware.offsetX = clamp(courseware.offsetX, 0, effMaxX);
  courseware.offsetY = clamp(courseware.offsetY, 0, effMaxY);

  updateCoursewareCanvasPlacement();
  drawAnnotations();
  if (courseware.screenCount > 1) {
    courseware.screen = screenForCoursewareOffset(courseware);
    updateCoursewareStatus();
  }

  // 若仍有剩余单指，启动平移接续
  if (state.coursewarePan._activePointers.size === 1) {
    const [pointerId, pt] = [...state.coursewarePan._activePointers][0];
    elements.annotationCanvas.setPointerCapture(pointerId);
    state.coursewarePan.active = true;
    state.coursewarePan.pointerId = pointerId;
    state.coursewarePan.startX = pt.x;
    state.coursewarePan.startY = pt.y;
    state.coursewarePan.startOffsetX = courseware.offsetX;
    state.coursewarePan.startOffsetY = courseware.offsetY;
    elements.annotationCanvas.classList.add('is-panning');
  }
}

function undoAnnotationStroke() {
  state.annotations.strokes.pop();
  drawAnnotations();
  updateAnnotationButtons();
}

function clearAnnotations() {
  resetAnnotations();
}

function resetAnnotations() {
  state.annotations.strokes = [];
  state.annotations.activeStrokes.clear();
  drawAnnotations();
  updateAnnotationButtons();
}

function setAnnotationColor(color) {
  if (!color) {
    return;
  }
  state.annotations.currentColor = color;
  setAnnotationTool('pen');
  updateAnnotationColorButtons();
}

function setAnnotationTool(tool) {
  state.annotations.tool = tool === 'pan' ? 'pan' : 'pen';
  updateAnnotationToolButtons();
}

function updateAnnotationToolButtons() {
  const isPan = state.annotations.tool === 'pan';
  // 画笔按钮已整合至颜色选择交互中
  if (elements.penToolButton) elements.penToolButton.hidden = true;
  elements.panToolButton.classList.toggle('is-active', isPan);
  elements.annotationCanvas.classList.toggle('is-pan-tool', isPan);
  // 手型模式只移除调色盘选中圈，调色盘保持可见
  if (isPan) {
    elements.annotationColorButtons.forEach((btn) => btn.classList.remove('is-active'));
  } else {
    updateAnnotationColorButtons();
  }
}

function updateAnnotationButtons() {
  const hasStrokes = state.annotations.strokes.length > 0;
  elements.undoAnnotationButton.disabled = !hasStrokes;
  elements.clearAnnotationButton.disabled = !hasStrokes;
}

function updateAnnotationColorButtons() {
  elements.annotationColorButtons.forEach((button) => {
    button.classList.toggle('is-active', button.dataset.color === state.annotations.currentColor);
  });
}

function pointerEventToSourcePoint(event) {
  const videoRect = currentVideoContentRect();
  if (!videoRect || videoRect.width <= 0 || videoRect.height <= 0) {
    return null;
  }
  const videoX = (event.clientX - videoRect.left) / videoRect.width;
  const videoY = (event.clientY - videoRect.top) / videoRect.height;
  if (videoX < 0 || videoX > 1 || videoY < 0 || videoY > 1) {
    return null;
  }
  const crop = currentFrameCrop();
  return {
    x: clamp(crop.x + videoX * crop.width, 0, 1),
    y: clamp(crop.y + videoY * crop.height, 0, 1)
  };
}

function drawAnnotations() {
  resizeAnnotationCanvas();
  const canvas = elements.annotationCanvas;
  const context = canvas.getContext('2d');
  const canvasRect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, canvasRect.width, canvasRect.height);

  const videoRect = currentVideoContentRect();
  if (!videoRect) {
    return;
  }

  const crop = currentFrameCrop();
  for (const stroke of state.annotations.strokes) {
    drawAnnotationStroke(context, stroke, canvasRect, videoRect, crop);
  }
  for (const stroke of state.annotations.activeStrokes.values()) {
    drawAnnotationStroke(context, stroke, canvasRect, videoRect, crop);
  }
}

function drawAnnotationStroke(context, stroke, canvasRect, videoRect, crop) {
  context.save();
  context.strokeStyle = stroke.color;
  context.fillStyle = stroke.color;
  context.lineWidth = stroke.width;
  context.lineCap = 'round';
  context.lineJoin = 'round';

  let segmentStarted = false;
  let visiblePoints = 0;
  context.beginPath();

  for (const point of stroke.points) {
    const canvasPoint = sourcePointToCanvasPoint(point, canvasRect, videoRect, crop);
    if (!canvasPoint.visible) {
      if (segmentStarted) {
        context.stroke();
        context.beginPath();
        segmentStarted = false;
      }
      continue;
    }

    visiblePoints += 1;
    if (!segmentStarted) {
      context.moveTo(canvasPoint.x, canvasPoint.y);
      segmentStarted = true;
    } else {
      context.lineTo(canvasPoint.x, canvasPoint.y);
    }
  }

  if (segmentStarted) {
    context.stroke();
  }

  if (visiblePoints === 1) {
    const onlyPoint = stroke.points
      .map((point) => sourcePointToCanvasPoint(point, canvasRect, videoRect, crop))
      .find((point) => point.visible);
    if (onlyPoint) {
      context.beginPath();
      context.arc(onlyPoint.x, onlyPoint.y, stroke.width / 2, 0, Math.PI * 2);
      context.fill();
    }
  }

  context.restore();
}

function sourcePointToCanvasPoint(point, canvasRect, videoRect, crop) {
  const videoX = (point.x - crop.x) / crop.width;
  const videoY = (point.y - crop.y) / crop.height;
  const visible = videoX >= 0 && videoX <= 1 && videoY >= 0 && videoY <= 1;
  return {
    x: videoRect.left - canvasRect.left + videoX * videoRect.width,
    y: videoRect.top - canvasRect.top + videoY * videoRect.height,
    visible
  };
}

function currentFrameCrop() {
  return {
    x: state.framePresentation.cropX,
    y: state.framePresentation.cropY,
    width: state.framePresentation.cropWidth,
    height: state.framePresentation.cropHeight
  };
}

function currentVideoContentRect() {
  if (state.presentationMode === 'courseware') {
    return elements.coursewareCanvas.getBoundingClientRect();
  }

  const elementRect = elements.remoteVideo.getBoundingClientRect();
  const videoWidth = elements.remoteVideo.videoWidth;
  const videoHeight = elements.remoteVideo.videoHeight;
  if (!videoWidth || !videoHeight || !elementRect.width || !elementRect.height) {
    return elementRect;
  }

  const fit = getComputedStyle(elements.remoteVideo).objectFit;
  const scale = fit === 'cover'
    ? Math.max(elementRect.width / videoWidth, elementRect.height / videoHeight)
    : Math.min(elementRect.width / videoWidth, elementRect.height / videoHeight);
  const width = videoWidth * scale;
  const height = videoHeight * scale;
  return {
    left: elementRect.left + (elementRect.width - width) / 2,
    top: elementRect.top + (elementRect.height - height) / 2,
    width,
    height
  };
}

function runCatching(callback) {
  try {
    callback();
  } catch (error) {
    return undefined;
  }
  return undefined;
}

function sendMessage(payload) {
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify(payload));
  }
}

function showJoinView() {
  hideDownloadButton();
  destroyCoursewareDocument(state.courseware);
  state.presentationMode = 'waiting';
  state.courseware = null;
  clearCoursewareCanvas();
  document.body.classList.remove('is-streaming');
  elements.joinView.hidden = false;
  elements.videoView.hidden = true;
  elements.remoteVideo.hidden = false;
  elements.coursewareCanvas.hidden = true;
  elements.panToolButton.hidden = true;
  elements.prevPageButton.hidden = true;
  elements.nextPageButton.hidden = true;
  if (elements.selectCoursewareButton) elements.selectCoursewareButton.hidden = true;
}

function showVideoView() {
  state.presentationMode = 'video';
  setAnnotationTool('pen');
  elements.coursewareCanvas.hidden = true;
  elements.remoteVideo.hidden = false;
  document.body.classList.add('is-streaming');
  elements.joinView.hidden = true;
  elements.videoView.hidden = false;
  elements.panToolButton.hidden = true;
  elements.prevPageButton.hidden = true;
  elements.nextPageButton.hidden = true;
  elements.videoStatus.hidden = false;
}

function showCoursewareView() {
  state.presentationMode = 'courseware';
  showDownloadButtonIfAvailable();
  elements.remoteVideo.hidden = true;
  elements.coursewareCanvas.hidden = false;
  elements.videoView.dataset.orientation = 'landscape';
  elements.videoView.dataset.lockedZoomed = 'false';
  document.body.classList.add('is-streaming');
  elements.joinView.hidden = true;
  elements.videoView.hidden = false;
  elements.panToolButton.hidden = false;
  elements.prevPageButton.hidden = false;
  elements.nextPageButton.hidden = false;
  if (elements.selectCoursewareButton) elements.selectCoursewareButton.hidden = !state.directTeach;
  elements.videoStatus.hidden = true;
  updatePageNavButtons();
  resizeAnnotationCanvas();
}


function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
}

function updateFullscreenButton() {
  if (elements.fullscreenButton) {
    elements.fullscreenButton.textContent = document.fullscreenElement ? '退出全屏' : '全屏';
  }
}

function handleCoursewareOriginal(message) {
  if (typeof message.originalUrl !== 'string' || !message.originalUrl) {
    return;
  }
  state.courseware = state.courseware || {};
  state.courseware.downloadOriginalUrl = message.originalUrl;
  state.downloadOriginalUrl = message.originalUrl;
  if (elements.downloadOriginalButton) {
    elements.downloadOriginalButton.hidden = false;
  }
}

function downloadOriginalFile() {
  const url = state.courseware?.downloadOriginalUrl || state.downloadOriginalUrl;
  if (!url) {
    return;
  }
  // 将相对路径转为完整 URL 并通过隐藏 a 标签触发下载
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = '';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
}

function hideDownloadButton() {
  state.downloadOriginalUrl = null;
  if (elements.downloadOriginalButton) {
    elements.downloadOriginalButton.hidden = true;
  }
}

function showDownloadButtonIfAvailable() {
  if (state.downloadOriginalUrl) {
    elements.downloadOriginalButton.hidden = false;
  }
}

function setWaitingStatus(text) {
  elements.statusText.textContent = text;
  elements.videoStatus.textContent = text;
}

// -- 直接上课模式 --
async function loadTeacherCourseware() {
  if (!state.teacherToken) return;
  try {
    const res = await fetch('./api/courseware', {
      headers: { Authorization: `Bearer ${state.teacherToken}` }
    });
    if (!res.ok) throw new Error('获取课件失败');
    const data = await res.json();
    state.teacherCoursewareList = data.items || [];
    const items = state.teacherCoursewareList;
    if (!items.length) {
      elements.coursewareGrid.innerHTML = '<p style="color:var(--muted);text-align:center">暂无课件，请通过管理后台上传</p>';
    } else {
      elements.coursewareGrid.innerHTML = items.map((c, i) => `
        <div class="courseware-item" data-index="${i}">
          <div class="courseware-item-title">${escapeHtml(c.title)}</div>
          <div class="courseware-item-meta">${c.fileName || ''} · ${formatSize(c.size)}</div>
        </div>
      `).join('');
      elements.coursewareGrid.querySelectorAll('.courseware-item').forEach((item) => {
        item.addEventListener('click', () => {
          const idx = parseInt(item.dataset.index, 10);
          const cw = state.teacherCoursewareList[idx];
          if (cw) openDirectCourseware(cw);
        });
      });
    }
    showPicker();
  } catch (err) {
    alert(err.message);
  }
}

function showPicker() {
  elements.coursewarePicker.hidden = false;
  if (elements.selectCoursewareButton) elements.selectCoursewareButton.hidden = false;
}

function showTeacherCoursewarePicker() {
  loadTeacherCourseware();
}

function openDirectCourseware(cw) {
  elements.coursewarePicker.hidden = true;
  elements.roomCode.textContent = '----';
  setWaitingStatus('');
  state.directTeach = true;
  // 如果有原文件下载地址，直接设置
  if (cw.originalUrl && cw.originalUrl !== cw.url) {
    state.downloadOriginalUrl = cw.originalUrl;
  } else {
    state.downloadOriginalUrl = null;
  }
  openCourseware({ url: cw.url, title: cw.title, page: 1, screen: 1 });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatSize(b) {
  if (!b) return '0B';
  if (b < 1024 * 1024) return Math.round(b / 1024) + 'KB';
  return (b / 1024 / 1024).toFixed(1) + 'MB';
}

// ---- 黑板系统 ----
function toggleBlackboard(forceState) {
  const open = typeof forceState === 'boolean' ? forceState : !state.blackboard.active;
  if (open === state.blackboard.active) return;

  state.blackboard.active = open;
  elements.blackboardOverlay.hidden = !open;
  elements.blackboardToggleButton.classList.toggle('is-active', open);

  if (open) {
    flushBlackboardActiveStrokes();
    state.blackboard.activeStrokes.clear();
    state.blackboard.palmDetected = false;
    state.blackboard.panX = 0;
    state.blackboard.panY = 0;
    state.blackboard.scale = 1;
    state.blackboard._panActive = false;
    state.blackboard._pinch.active = false;
    state.blackboard._activePointers.clear();
    setBlackboardTool('pen');
    updateBlackboardColorButtons();
    hidePalmIndicator();
    resizeBlackboardCanvas();
    renderBlackboard();
    updateBlackboardPageIndicator();
  }
}

function beginBlackboardStroke(event) {
  if (!state.blackboard.active) return;

  // 始终记录指针位置（用于双指缩放检测）
  state.blackboard._activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

  // 手型工具：启动平移或双指缩放
  if (state.blackboard.tool === 'hand') {
    if (state.blackboard._activePointers.size >= 2) {
      abortBlackboardPan();
      startBlackboardPinch();
      return;
    }
    if (event.isPrimary) beginBlackboardPan(event);
    return;
  }

  // 手掌检测：触屏设备上接触面积 > 22px 判定为手掌 → 自动切板擦
  // 阈值 50px：大屏上单指触摸不会超过此值，但手掌会
  const PALM_THRESHOLD = 50;
  const isPalmTouch = event.pointerType === 'touch'
    && event.width > PALM_THRESHOLD
    && event.height > PALM_THRESHOLD;

  if (isPalmTouch && state.blackboard.tool !== 'eraser') {
    state.blackboard.palmDetected = true;
    setBlackboardTool('eraser');
    showPalmIndicator();
  }

  const point = blackboardPointerToPoint(event);
  if (!point) return;

  event.preventDefault();
  elements.blackboardCanvas.setPointerCapture(event.pointerId);

  const isEraser = state.blackboard.tool === 'eraser';
  state.blackboard.activeStrokes.set(event.pointerId, {
    pointerId: event.pointerId,
    color: isEraser ? '#2c2f36' : state.blackboard.currentColor,
    width: isEraser ? state.blackboard.eraserWidth : 6,
    points: [point]
  });
  renderBlackboard();
}

function continueBlackboardStroke(event) {
  if (!state.blackboard.active) return;

  // 始终更新指针位置缓存
  state.blackboard._activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

  // 手型捏合缩放中
  if (state.blackboard._pinch.active) {
    continueBlackboardPinch();
    return;
  }

  // 手型平移中 → 检测是否出现第二指触发缩放
  if (state.blackboard._panActive && state.blackboard._panPointerId === event.pointerId) {
    if (state.blackboard._activePointers.size >= 2) {
      abortBlackboardPan();
      startBlackboardPinch();
      return;
    }
    continueBlackboardPan(event);
    return;
  }
  const stroke = state.blackboard.activeStrokes.get(event.pointerId);
  if (!stroke) return;
  event.preventDefault();
  const point = blackboardPointerToPoint(event);
  if (!point) return;
  const lastPoint = stroke.points.at(-1);
  if (lastPoint && Math.hypot(point.x - lastPoint.x, point.y - lastPoint.y) < 0.001) return;
  stroke.points.push(point);
  renderBlackboard();
}

function finishBlackboardStroke(event) {
  if (!state.blackboard.active) return;

  // 清理指针缓存
  state.blackboard._activePointers.delete(event.pointerId);

  // 捏合缩放结束
  if (state.blackboard._pinch.active) {
    endBlackboardPinch();
    return;
  }

  // 手型平移结束
  if (state.blackboard._panActive && state.blackboard._panPointerId === event.pointerId) {
    finishBlackboardPan(event);
    return;
  }
  const stroke = state.blackboard.activeStrokes.get(event.pointerId);
  if (!stroke) return;
  event.preventDefault();
  if (stroke.points.length > 0) {
    const pages = state.blackboard.pages;
    pages[state.blackboard.currentPage].strokes.push({
      color: stroke.color,
      width: stroke.width,
      points: stroke.points
    });
  }
  state.blackboard.activeStrokes.delete(event.pointerId);
  runCatching(() => elements.blackboardCanvas.releasePointerCapture(event.pointerId));

  // 手掌板擦自动恢复：所有手指离开后回到画笔模式
  if (state.blackboard.palmDetected && state.blackboard.activeStrokes.size === 0) {
    state.blackboard.palmDetected = false;
    setBlackboardTool('pen');
    hidePalmIndicator();
  }

  renderBlackboard();
  updateBlackboardPageIndicator();
}

function blackboardPointerToPoint(event) {
  const rect = elements.blackboardCanvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const scale = state.blackboard.scale;
  // 屏幕坐标 → 世界坐标（除以缩放 + 视口偏移）
  const x = (event.clientX - rect.left) / scale + state.blackboard.panX;
  const y = (event.clientY - rect.top) / scale + state.blackboard.panY;
  return { x, y };
}

function resizeBlackboardCanvas() {
  const canvas = elements.blackboardCanvas;
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rect.width * ratio));
  const height = Math.max(1, Math.round(rect.height * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

function renderBlackboard() {
  resizeBlackboardCanvas();
  const canvas = elements.blackboardCanvas;
  const ctx = canvas.getContext('2d');
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const panX = state.blackboard.panX;
  const panY = state.blackboard.panY;
  const scale = state.blackboard.scale;
  const s = scale * ratio;

  // 视口变换：缩放 + 平移
  ctx.setTransform(s, 0, 0, s, -panX * s, -panY * s);

  // 填充黑板底色并绘制网格（世界坐标范围需覆盖视口）
  const worldW = rect.width / scale;
  const worldH = rect.height / scale;
  ctx.fillStyle = '#2c2f36';
  ctx.fillRect(panX, panY, worldW, worldH);
  drawBlackboardGrid(ctx, rect);

  const page = state.blackboard.pages[state.blackboard.currentPage];
  if (page) {
    for (const stroke of page.strokes) {
      drawBlackboardStroke(ctx, stroke);
    }
  }
  for (const stroke of state.blackboard.activeStrokes.values()) {
    drawBlackboardStroke(ctx, stroke);
  }
}

function drawBlackboardStroke(ctx, stroke) {
  if (stroke.points.length === 0) return;
  ctx.save();
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.lineWidth = stroke.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  ctx.beginPath();
  ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
  for (let i = 1; i < stroke.points.length; i++) {
    ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
  }
  ctx.stroke();

  if (stroke.points.length === 1) {
    ctx.beginPath();
    ctx.arc(stroke.points[0].x, stroke.points[0].y, stroke.width / 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawBlackboardGrid(ctx, rect) {
  const panX = state.blackboard.panX;
  const panY = state.blackboard.panY;
  const scale = state.blackboard.scale;
  const gridSize = 48;
  const dotRadius = 1.2;
  const startX = Math.floor(panX / gridSize) * gridSize;
  const startY = Math.floor(panY / gridSize) * gridSize;
  const endX = panX + rect.width / scale;
  const endY = panY + rect.height / scale;

  ctx.fillStyle = 'rgba(255,255,255,0.055)';
  for (let x = startX; x <= endX; x += gridSize) {
    for (let y = startY; y <= endY; y += gridSize) {
      ctx.beginPath();
      ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function flushBlackboardActiveStrokes() {
  const pages = state.blackboard.pages;
  const page = pages[state.blackboard.currentPage];
  if (!page) return;
  for (const stroke of state.blackboard.activeStrokes.values()) {
    if (stroke.points.length > 0) {
      page.strokes.push({ color: stroke.color, width: stroke.width, points: stroke.points });
    }
  }
  state.blackboard.activeStrokes.clear();
}

function navigateBlackboardPage(delta) {
  flushBlackboardActiveStrokes();
  const pages = state.blackboard.pages;
  const newPage = state.blackboard.currentPage + (delta < 0 ? -1 : 1);
  if (newPage < 0 || newPage >= pages.length) return;
  state.blackboard.currentPage = newPage;
  state.blackboard.activeStrokes.clear();
  state.blackboard.panX = 0;
  state.blackboard.panY = 0;
  renderBlackboard();
  updateBlackboardPageIndicator();
}

function addBlackboardPage() {
  flushBlackboardActiveStrokes();
  const pages = state.blackboard.pages;
  // 在当前页之后插入新页
  const insertAt = state.blackboard.currentPage + 1;
  pages.splice(insertAt, 0, { strokes: [] });
  state.blackboard.currentPage = insertAt;
  state.blackboard.activeStrokes.clear();
  state.blackboard.panX = 0;
  state.blackboard.panY = 0;
  renderBlackboard();
  updateBlackboardPageIndicator();
}

function deleteBlackboardPage() {
  const pages = state.blackboard.pages;
  if (pages.length <= 1) return; // 至少保留一页
  flushBlackboardActiveStrokes();
  const idx = state.blackboard.currentPage;
  pages.splice(idx, 1);
  if (state.blackboard.currentPage >= pages.length) {
    state.blackboard.currentPage = pages.length - 1;
  }
  state.blackboard.activeStrokes.clear();
  state.blackboard.panX = 0;
  state.blackboard.panY = 0;
  renderBlackboard();
  updateBlackboardPageIndicator();
}

function updateBlackboardPageIndicator() {
  const pages = state.blackboard.pages;
  const cur = state.blackboard.currentPage + 1;
  const page = pages[state.blackboard.currentPage];
  const hasStrokes = page && page.strokes.length > 0;
  elements.blackboardPageIndicator.textContent = `第 ${cur} / ${pages.length} 页`;
  elements.blackboardPrevPageButton.disabled = state.blackboard.currentPage <= 0;
  elements.blackboardNextPageButton.disabled = state.blackboard.currentPage >= pages.length - 1;
  elements.blackboardDelPageButton.disabled = pages.length <= 1;
  elements.blackboardUndoButton.disabled = !hasStrokes;
  elements.blackboardClearButton.disabled = !hasStrokes;
}

function setBlackboardTool(tool) {
  if (tool === 'eraser') {
    state.blackboard.tool = 'eraser';
  } else if (tool === 'hand') {
    state.blackboard.tool = 'hand';
  } else {
    state.blackboard.tool = 'pen';
  }

  const isEraser = state.blackboard.tool === 'eraser';
  const isHand = state.blackboard.tool === 'hand';
  const isPen = state.blackboard.tool === 'pen';

  elements.blackboardCanvas.classList.toggle('is-eraser', isEraser);
  elements.blackboardCanvas.classList.toggle('is-hand-tool', isHand);
  elements.blackboardEraserButton.classList.toggle('is-active', isEraser);
  elements.blackboardHandButton.classList.toggle('is-active', isHand);

  // 非画笔模式只移除调色盘选中圈，调色盘保持可见
  if (isPen) {
    updateBlackboardColorButtons();
  } else {
    elements.blackboardColorButtons.forEach((btn) => btn.classList.remove('is-active'));
  }

  if (!isEraser) {
    elements.blackboardEraserCursor.style.display = 'none';
  } else {
    elements.blackboardEraserCursor.style.display = '';
  }
}

function toggleBlackboardHand() {
  state.blackboard.palmDetected = false;
  hidePalmIndicator();
  const newTool = state.blackboard.tool === 'hand' ? 'pen' : 'hand';
  setBlackboardTool(newTool);
}

function undoBlackboardStroke() {
  flushBlackboardActiveStrokes();
  const page = state.blackboard.pages[state.blackboard.currentPage];
  if (page && page.strokes.length > 0) {
    page.strokes.pop();
  }
  renderBlackboard();
  updateBlackboardPageIndicator();
}

function clearBlackboard() {
  flushBlackboardActiveStrokes();
  const page = state.blackboard.pages[state.blackboard.currentPage];
  if (page) {
    page.strokes = [];
  }
  state.blackboard.activeStrokes.clear();
  renderBlackboard();
  updateBlackboardPageIndicator();
}

function showPalmIndicator() {
  elements.blackboardPalmIndicator.style.display = '';
  clearTimeout(elements.blackboardPalmIndicator._hideTimer);
  elements.blackboardPalmIndicator._hideTimer = setTimeout(() => {
    hidePalmIndicator();
  }, 3000);
}

function hidePalmIndicator() {
  elements.blackboardPalmIndicator.style.display = 'none';
  clearTimeout(elements.blackboardPalmIndicator._hideTimer);
}

function beginBlackboardPan(event) {
  if (!state.blackboard.active) return;
  event.preventDefault();
  elements.blackboardCanvas.setPointerCapture(event.pointerId);
  state.blackboard._panActive = true;
  state.blackboard._panPointerId = event.pointerId;
  state.blackboard._panStartX = event.clientX;
  state.blackboard._panStartY = event.clientY;
  state.blackboard._panStartPanX = state.blackboard.panX;
  state.blackboard._panStartPanY = state.blackboard.panY;
  elements.blackboardCanvas.classList.add('is-panning');
}

function continueBlackboardPan(event) {
  if (!state.blackboard._panActive) return;
  event.preventDefault();
  const scale = state.blackboard.scale;
  const dx = (event.clientX - state.blackboard._panStartX) / scale;
  const dy = (event.clientY - state.blackboard._panStartY) / scale;
  state.blackboard.panX = state.blackboard._panStartPanX - dx;
  state.blackboard.panY = state.blackboard._panStartPanY - dy;
  renderBlackboard();
}

function finishBlackboardPan(event) {
  if (!state.blackboard._panActive) return;
  event.preventDefault();
  state.blackboard._panActive = false;
  state.blackboard._panPointerId = null;
  runCatching(() => elements.blackboardCanvas.releasePointerCapture(event.pointerId));
  elements.blackboardCanvas.classList.remove('is-panning');
}

// 取消当前平移（不清除指针捕捉，由后续操作接管）
function abortBlackboardPan() {
  if (!state.blackboard._panActive) return;
  state.blackboard._panActive = false;
  state.blackboard._panPointerId = null;
  elements.blackboardCanvas.classList.remove('is-panning');
}

function pointerDist(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function pinchCenter(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

// 启动双指缩放
function startBlackboardPinch() {
  const pointers = [...state.blackboard._activePointers.values()];
  if (pointers.length < 2) return;
  const r = elements.blackboardCanvas.getBoundingClientRect();
  const dist = pointerDist(pointers[0], pointers[1]);
  const center = pinchCenter(pointers[0], pointers[1]);

  state.blackboard._pinch.active = true;
  state.blackboard._pinch.startDist = dist > 0 ? dist : 1;
  state.blackboard._pinch.startScale = state.blackboard.scale;
  state.blackboard._pinch.centerX = center.x - r.left;
  state.blackboard._pinch.centerY = center.y - r.top;
}

// 持续双指缩放（以捏合中心为焦点）
function continueBlackboardPinch() {
  const pointers = [...state.blackboard._activePointers.values()];
  if (pointers.length < 2) {
    endBlackboardPinch();
    return;
  }
  const r = elements.blackboardCanvas.getBoundingClientRect();
  const dist = pointerDist(pointers[0], pointers[1]);
  const center = pinchCenter(pointers[0], pointers[1]);
  if (dist < 0.5) return;

  const pinch = state.blackboard._pinch;
  const ratio = dist / pinch.startDist;
  const newScale = clamp(pinch.startScale * ratio, state.blackboard.MIN_SCALE, state.blackboard.MAX_SCALE);

  // 以捏合中心为焦点缩放：世界坐标中心点保持不变
  const screenCx = center.x - r.left;
  const screenCy = center.y - r.top;
  const oldScale = state.blackboard.scale;
  if (Math.abs(newScale - oldScale) > 0.001) {
    state.blackboard.panX += screenCx / oldScale - screenCx / newScale;
    state.blackboard.panY += screenCy / oldScale - screenCy / newScale;
    state.blackboard.scale = newScale;
    renderBlackboard();
  }
}

// 结束双指缩放
function endBlackboardPinch() {
  const wasActive = state.blackboard._pinch.active;
  state.blackboard._pinch.active = false;
  state.blackboard._pinch.startDist = 0;
  if (!wasActive) return;
  // 若仍有剩余单指，启动平移接续
  if (state.blackboard._activePointers.size === 1 && state.blackboard.tool === 'hand') {
    const [pointerId, pt] = [...state.blackboard._activePointers][0];
    elements.blackboardCanvas.setPointerCapture(pointerId);
    state.blackboard._panActive = true;
    state.blackboard._panPointerId = pointerId;
    state.blackboard._panStartX = pt.x;
    state.blackboard._panStartY = pt.y;
    state.blackboard._panStartPanX = state.blackboard.panX;
    state.blackboard._panStartPanY = state.blackboard.panY;
    elements.blackboardCanvas.classList.add('is-panning');
  }
}

function setBlackboardColor(color) {
  if (!color) return;
  state.blackboard.currentColor = color;
  // 选颜色自动切回画笔
  setBlackboardTool('pen');
  updateBlackboardColorButtons();
}

function updateBlackboardColorButtons() {
  elements.blackboardColorButtons.forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.color === state.blackboard.currentColor);
  });
}

function toggleBlackboardEraser() {
  // 手动切换板擦 → 清除手掌标记
  state.blackboard.palmDetected = false;
  hidePalmIndicator();
  const newTool = state.blackboard.tool === 'eraser' ? 'pen' : 'eraser';
  setBlackboardTool(newTool);
}
