const state = {
  socket: null,
  peerConnection: null,
  config: null,
  reconnectTimer: null,
  teacherConnected: false,
  roomCode: null,

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
    currentColor: '#ff4d6d',
    tool: 'pen'
  },
  blackboard: {
    active: false,
    pages: [{ strokes: [] }],  // 每页保存已完成笔画
    currentPage: 0,
    activeStrokes: new Map(),  // 黑板当前页活跃笔画，支持多点
    tool: 'pen',               // 'pen' | 'eraser' | 'hand' | 'select'
    eraserWidth: 40,           // 板擦半径(px)
    currentColor: '#ff4d6d',   // 黑板专用颜色（默认红色）
    // 圈选系统
    selection: {
      lassoPoints: [],          // 正在绘制的套索多边形点
      drawing: false,           // 是否正在绘制套索
      confirmedIndices: [],     // 已确认选中的笔画索引（按 page.strokes 顺序）
      bbox: null,               // 选中笔画的包围盒 { minX, minY, maxX, maxY }
      dragging: false,          // 是否正在拖拽移动选中笔画
      dragStartWX: 0, dragStartWY: 0, // 拖拽起始世界坐标
      dragSnapshot: null,       // 拖拽前的笔画深拷贝（用于实时渲染）
    },
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
  syncedFromTeacher: false,
  directTeach: false,
  coursewareFromViewer: false,
  teacherCoursewareList: [],
  videoPlayer: {
    active: false,
    idleTimer: null,
    scrubbing: false
  }
};

let pdfJsPromise = null;

const elements = {
  joinView: document.getElementById('joinView'),
  videoView: document.getElementById('videoView'),
  roomCode: document.getElementById('roomCode'),
  clockTime: document.getElementById('clockTime'),
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
  coursewareDropdown: document.getElementById('coursewareDropdown'),
  coursewareMenuButton: document.getElementById('coursewareMenuButton'),
  coursewareDropdownMenu: document.getElementById('coursewareDropdownMenu'),
  downloadOriginalMenuItem: document.getElementById('downloadOriginalMenuItem'),
  switchCoursewareMenuItem: document.getElementById('switchCoursewareMenuItem'),
  prevPageButton: document.getElementById('prevPageButton'),
  nextPageButton: document.getElementById('nextPageButton'),
  selectCoursewareButton: document.getElementById('selectCoursewareButton'),
  downloadApkButton: document.getElementById('downloadApkButton'),
  downloadWindowsButton: document.getElementById('downloadWindowsButton'),
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
  homeFullscreenButton: document.getElementById('fullscreenButton'),
  quickBlackboardButton: document.getElementById('quickBlackboardButton'),
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
  blackboardHandButton: document.getElementById('blackboardHandButton'),
  blackboardSelectButton: document.getElementById('blackboardSelectButton'),
  blackboardDeleteSelButton: document.getElementById('blackboardDeleteSelButton'),
  blackboardColorButtons: Array.from(document.querySelectorAll('#blackboardColors .annotation-color')),
  blackboardColorsContainer: document.getElementById('blackboardColors'),
  // 视频播放器
  videoPlayerOverlay: document.getElementById('videoPlayerOverlay'),
  coursewareVideo: document.getElementById('coursewareVideo'),
  videoControls: document.getElementById('videoControls'),
  videoPlayPause: document.getElementById('videoPlayPause'),
  videoProgressContainer: document.getElementById('videoProgressContainer'),
  videoProgressTrack: document.getElementById('videoProgressTrack'),
  videoProgressFill: document.getElementById('videoProgressFill'),
  videoProgressThumb: document.getElementById('videoProgressThumb'),
  videoTime: document.getElementById('videoTime'),
  videoMuteBtn: document.getElementById('videoMuteBtn'),
  videoVolumeSlider: document.getElementById('videoVolumeSlider'),
  videoFullscreenBtn: document.getElementById('videoFullscreenBtn'),
  videoCloseBtn: document.getElementById('videoCloseBtn'),
  // 课件连接码角标
  coursewareConnIndicator: document.getElementById('coursewareConnIndicator'),
  coursewareConnCode: document.getElementById('coursewareConnCode'),
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
    if (state.config?.windowsUrl && elements.downloadWindowsButton) {
      elements.downloadWindowsButton.href = state.config.windowsUrl;
      elements.downloadWindowsButton.download = '';
      elements.downloadWindowsButton.hidden = false;
      elements.downloadWindowsButton.textContent = `下载 Windows 投屏程序 v${state.config.windowsVersion || ''}`.trim();
    }
    // 直接上课
    elements.directTeachButton.addEventListener('click', () => {
      if (state.teacherToken) {
        showTeacherCoursewarePicker();
      } else {
        elements.loginModal.hidden = false;
      }
    });
    // 主页快捷黑板
    elements.quickBlackboardButton.addEventListener('click', () => {
      toggleBlackboard(true);
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
        state.syncedFromTeacher = false;
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
      state.syncedFromTeacher = false;
      state.directTeach = false;
      elements.directTeachButton.hidden = false;
      elements.directTeachUser.hidden = true;
      elements.directTeachLogout.hidden = true;
      elements.coursewarePicker.hidden = true;
    });
    elements.closePickerButton.addEventListener('click', () => {
      elements.coursewarePicker.hidden = true;
    });
    elements.homeFullscreenButton.addEventListener('click', () => {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
        elements.homeFullscreenButton.textContent = '全屏';
      } else {
        document.documentElement.requestFullscreen().catch(() => {});
        elements.homeFullscreenButton.textContent = '退出全屏';
      }
    });
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && elements.homeFullscreenButton) {
        elements.homeFullscreenButton.textContent = '全屏';
      }
    });
    elements.remoteVideo.addEventListener('loadedmetadata', updateVideoPresentation);
    elements.remoteVideo.addEventListener('resize', updateVideoPresentation);
    window.addEventListener('resize', handleViewportResize);
    // 首次点击页面任意位置自动全屏（排除下载按钮、考试平台链接）
    const autoFullscreen = (e) => {
      if (e.target.closest('#downloadApkButton, #loginModal, #directTeachButton, #teacherLoginForm, #coursewarePicker, #coursewareDropdownMenu, .action-btn-exam, .action-btn-exit')) return;
      document.documentElement.requestFullscreen().catch(() => {});
      document.removeEventListener('click', autoFullscreen);
    };
    document.addEventListener('click', autoFullscreen);
    // 用户首次交互后取消静音（绕过浏览器自动播放策略，独立于全屏逻辑）
    const unmuteOnFirstInteraction = () => {
      if (!elements.remoteVideo.muted) return;
      elements.remoteVideo.muted = false;
      elements.remoteVideo.play().catch(() => {});
    };
    document.addEventListener('click', unmuteOnFirstInteraction, { once: true });
    document.addEventListener('touchstart', unmuteOnFirstInteraction, { once: true });
    document.addEventListener('keydown', unmuteOnFirstInteraction, { once: true });
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
    elements.blackboardSelectButton.addEventListener('click', toggleBlackboardSelect);
    elements.blackboardDeleteSelButton.addEventListener('click', deleteBlackboardSelection);
    elements.blackboardColorButtons.forEach((btn) => {
      btn.addEventListener('click', () => setBlackboardColor(btn.dataset.color));
    });
    window.addEventListener('resize', resizeBlackboardCanvas);
    // 黑板板擦光标跟踪（文档级，绕过 canvas 指针捕获）
    document.addEventListener('pointermove', (event) => {
      if (!state.blackboard.active || state.blackboard.tool !== 'eraser') return;
      elements.blackboardEraserCursor.style.left = event.clientX + 'px';
      elements.blackboardEraserCursor.style.top = event.clientY + 'px';
      const size = state.blackboard.eraserWidth;
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
    // 课件下拉菜单
    elements.coursewareMenuButton.addEventListener('click', (e) => {
      e.stopPropagation();
      elements.coursewareDropdownMenu.classList.toggle('is-open');
    });
    elements.downloadOriginalMenuItem.addEventListener('click', (e) => {
      e.stopPropagation();
      elements.coursewareDropdownMenu.classList.remove('is-open');
      downloadOriginalFile();
    });
    elements.switchCoursewareMenuItem.addEventListener('click', (e) => {
      e.stopPropagation();
      elements.coursewareDropdownMenu.classList.remove('is-open');
      showTeacherCoursewarePicker();
    });
    // 点击其他区域关闭下拉菜单
    document.addEventListener('click', () => {
      elements.coursewareDropdownMenu.classList.remove('is-open');
    });
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
    startClock();
    connectSignaling();
  } catch (error) {
    setWaitingStatus('服务配置加载失败，请检查服务端是否启动');
  }
}

function startClock() {
  const pad = (n) => String(n).padStart(2, '0');
  const update = () => {
    const now = new Date();
    elements.clockTime.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  };
  update();
  // 计算到下一分钟的毫秒数，对齐整分钟更新
  const now = new Date();
  const msToNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
  setTimeout(() => {
    update();
    setInterval(update, 60000);
  }, msToNextMinute);
}

function setupStudentRoller() {
  const DURATION = 1800;
  const MIN_NO = 1;
  const MAX_NO = 80;
  const btn = document.getElementById('rollStudentButton');
  const result = document.getElementById('rollStudentResult');
  const big = document.getElementById('rollStudentBig');
  let rolling = false;
  let timer = null;
  // 班级人数，首次使用抽学号时设置，默认 50
  let studentCount = 50;
  let countConfigured = false;

  // ---- 设置人数模态框 ----
  const modal = document.getElementById('studentCountModal');
  const slider = document.getElementById('studentCountSlider');
  const thumb = document.getElementById('studentCountThumb');
  const fill = document.getElementById('studentCountFill');
  const display = document.getElementById('studentCountDisplay');
  const confirmBtn = document.getElementById('studentCountConfirm');
  const cancelBtn = document.getElementById('studentCountCancel');
  const minus1 = document.getElementById('studentCountMinus1');
  const minus10 = document.getElementById('studentCountMinus10');
  const plus1 = document.getElementById('studentCountPlus1');
  const plus10 = document.getElementById('studentCountPlus10');
  // 待执行的抽学号回调（确定后触发）；为 null 时仅修改人数
  let pendingRoll = null;
  // 打开模态框时的人数快照，用于取消时还原
  let openedCount = studentCount;

  function renderCount(value) {
    value = Math.max(MIN_NO, Math.min(MAX_NO, value));
    const ratio = (value - MIN_NO) / (MAX_NO - MIN_NO);
    // 横向滑块：左为最小，右为最大
    thumb.style.left = (ratio * 100) + '%';
    fill.style.width = (ratio * 100) + '%';
    display.textContent = String(value);
    return value;
  }

  function pointToValue(clientX) {
    const rect = slider.getBoundingClientRect();
    let ratio = (clientX - rect.left) / rect.width;
    ratio = Math.max(0, Math.min(1, ratio));
    return Math.round(MIN_NO + ratio * (MAX_NO - MIN_NO));
  }

  // onConfirm: 传入函数则在确定后执行（如首次抽号）；传 null 则仅保存人数
  function openCountModal(onConfirm) {
    pendingRoll = onConfirm;
    openedCount = studentCount;
    renderCount(studentCount);
    modal.hidden = false;
  }

  function closeCountModal() {
    modal.hidden = true;
    pendingRoll = null;
  }

  // 拖动交互（指针事件，支持触摸/鼠标）
  let dragging = false;
  const startDrag = (e) => {
    dragging = true;
    slider.setPointerCapture?.(e.pointerId);
    studentCount = renderCount(pointToValue(e.clientX));
    e.preventDefault();
  };
  const moveDrag = (e) => {
    if (!dragging) return;
    studentCount = renderCount(pointToValue(e.clientX));
  };
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    slider.releasePointerCapture?.(e.pointerId);
  };
  slider.addEventListener('pointerdown', startDrag);
  slider.addEventListener('pointermove', moveDrag);
  slider.addEventListener('pointerup', endDrag);
  slider.addEventListener('pointercancel', endDrag);

  // 大号 ± 按钮（支持长按连按，触屏友好）
  function bindStepper(el, delta) {
    let holdTimer = null;
    let repeatTimer = null;
    const activate = () => {
      studentCount = renderCount(studentCount + delta);
    };
    const startHold = (e) => {
      e.preventDefault();
      // 捕获指针，确保 pointerup 一定回到本按钮，避免移出后计时器泄漏
      el.setPointerCapture?.(e.pointerId);
      activate();
      holdTimer = setTimeout(() => {
        repeatTimer = setInterval(activate, 120);
      }, 400);
    };
    const stopHold = () => {
      clearTimeout(holdTimer);
      clearInterval(repeatTimer);
      holdTimer = repeatTimer = null;
    };
    el.addEventListener('pointerdown', startHold);
    el.addEventListener('pointerup', stopHold);
    el.addEventListener('pointercancel', stopHold);
  }
  bindStepper(minus1, -1);
  bindStepper(minus10, -10);
  bindStepper(plus1, 1);
  bindStepper(plus10, 10);

  confirmBtn.addEventListener('click', () => {
    const cb = pendingRoll;
    // 确定即采纳当前 studentCount（已通过滑块/按钮实时更新）
    closeCountModal();
    countConfigured = true;
    if (cb) cb();
  });
  cancelBtn.addEventListener('click', () => {
    // 取消：还原为打开前的人数
    studentCount = openedCount;
    closeCountModal();
  });

  function startRoll() {
    if (rolling) return;
    rolling = true;
    const startTime = Date.now();

    result.classList.remove('done');
    result.classList.add('rolling');
    // 居中超大显示开始滚动
    big.textContent = '??';
    big.classList.remove('done');
    big.classList.add('rolling', 'show');

    const tick = () => {
      const elapsed = Date.now() - startTime;
      if (elapsed >= DURATION) {
        result.classList.remove('rolling');
        big.classList.remove('rolling');
        const final = Math.floor(Math.random() * studentCount) + 1;
        const text = String(final).padStart(2, '0');
        result.textContent = text;
        big.textContent = text;
        result.classList.add('done');
        big.classList.add('done');
        // 抽完后缩回右下角（保留短暂展示再隐藏）
        setTimeout(() => {
          big.classList.remove('show');
        }, 1400);
        rolling = false;
        return;
      }
      const n = Math.floor(Math.random() * studentCount) + 1;
      const text = String(n).padStart(2, '0');
      result.textContent = text;
      big.textContent = text;
      const interval = elapsed < 200 ? 50 : elapsed < 800 ? 100 : elapsed < 1400 ? 180 : 280;
      timer = setTimeout(tick, interval);
    };

    tick();
  }

  btn.addEventListener('click', () => {
    if (rolling) return;
    if (!countConfigured) {
      // 首次使用：弹出设置人数模态框，确定后仅保存人数（不自动抽号）
      openCountModal(null);
    } else {
      startRoll();
    }
  });

  // 圆圈始终可点击修改人数（?? 状态与已设置状态均可）
  result.classList.add('configured');
  result.title = '点击设置/修改班级人数';

  // 点击抽学号右侧圆圈：仅设置/修改班级人数，确定后不自动抽号
  result.addEventListener('click', () => {
    if (rolling) return;
    openCountModal(null);
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
    state.teacherConnected = false;
    if (state.presentationMode === 'courseware') {
      updateCoursewareConnectionIndicator();
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
      state.roomCode = message.code;
      elements.roomCode.textContent = message.code;
      elements.coursewareConnCode.textContent = message.code;
      setWaitingStatus('等待教师连接...');
      break;
    case 'teacher.online':
      state.teacherConnected = true;
      if (message.username && message.token) {
        // 教师手机端已登录，大屏同步登录态（使用真实 token）
        // 不自动弹出课件列表，保留"打开课件"按钮供教师主动操作
        state.teacherToken = message.token;
        state.syncedFromTeacher = true;
        state.directTeach = true;
        elements.directTeachUser.textContent = `已登录：${message.username}`;
        elements.directTeachUser.hidden = false;
        elements.directTeachLogout.hidden = false;
      } else {
        hideDirectTeachUI();
      }
      updateCoursewareConnectionIndicator();
      setWaitingStatus('教师已连接，等待直播...');
      break;
    case 'teacher.offline':
      state.teacherConnected = false;
      // 清除手机同步登录状态
      if (state.syncedFromTeacher) {
        state.teacherToken = null;
        state.syncedFromTeacher = false;
        state.directTeach = false;
        elements.directTeachUser.hidden = true;
        elements.directTeachLogout.hidden = true;
      }
      cleanupPeerConnection();
      showDirectTeachUI();
      if (state.presentationMode === 'courseware') {
        updateCoursewareConnectionIndicator();
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
      if (state.blackboard.active) toggleBlackboard(false);
      openCourseware(message);
      break;
    case 'courseware.navigate':
      if (state.blackboard.active) toggleBlackboard(false);
      navigateCourseware(message.delta);
      break;
    case 'courseware.page':
      if (state.blackboard.active) toggleBlackboard(false);
      showCoursewarePage(message.page);
      break;
    case 'courseware.close':
      closeCourseware('课件已结束');
      break;
    case 'courseware.original':
      handleCoursewareOriginal(message);
      break;
    case 'teacher.stop':
      // teacher.stop 仅表示停止推流/课件播放，手机端仍在线，不清除登录态
      state.teacherConnected = false;
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
      // 视频元素初始为 muted，muted autoplay 不受浏览器策略限制，可直接播放
      const playPromise = elements.remoteVideo.play();
      if (playPromise) {
        playPromise.catch(() => {
          // 极少数情况 muted autoplay 也被阻止，等待用户点击恢复
          elements.videoStatus.textContent = '点击画面开始播放';
          const resumeOnClick = () => {
            elements.remoteVideo.muted = false;
            elements.remoteVideo.play().then(() => {
              elements.videoStatus.textContent = '';
            }).catch(() => {});
            document.removeEventListener('click', resumeOnClick);
          };
          document.addEventListener('click', resumeOnClick);
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
      state.teacherConnected = true;
      updateCoursewareConnectionIndicator();
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

  // 链接类型课件：弹窗提示用户在大屏端打开
  const linkUrl = typeof message.linkUrl === 'string' ? message.linkUrl : '';
  if (linkUrl) {
    showLinkPrompt(message.title || '课件', linkUrl);
    return;
  }

  setAnnotationTool('pen');

  // 视频文件：直接播放
  const isVideo = /\.(mp4|mov|avi|webm|mkv|3gp)(\?|$)/i.test(url);
  // ZIP 文件：不尝试渲染，仅提供下载
  const isZip = /\.zip(\?|$)/i.test(url);

  if (isVideo) {
    cleanupPeerConnection();
    resetAnnotations();
    showCoursewareViewForVideo({
      url,
      title: typeof message.title === 'string' ? message.title : '视频'
    });
    return;
  }

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
  updateCoursewareConnectionIndicator();
}

// ---- 视频课件播放器 ----

function showCoursewareViewForVideo(info) {
  state.presentationMode = 'courseware';
  state.videoPlayer.active = true;
  document.body.classList.add('is-streaming');
  elements.joinView.hidden = true;
  elements.videoView.hidden = true;
  elements.remoteVideo.hidden = true;
  elements.coursewareCanvas.hidden = true;
  elements.annotationCanvas.hidden = true;
  elements.annotationToolbar.hidden = true;
  elements.panToolButton.hidden = true;
  elements.prevPageButton.hidden = true;
  elements.nextPageButton.hidden = true;
  if (elements.selectCoursewareButton) elements.selectCoursewareButton.hidden = true;
  if (state.teacherToken && elements.coursewareDropdown) elements.coursewareDropdown.hidden = false;

  // 先绑定事件（内部会 cloneNode 替换元素），再设置 src 避免被 cloneNode(false) 丢弃
  bindVideoEvents();

  const video = elements.coursewareVideo;
  video.src = info.url;
  video.volume = elements.videoVolumeSlider.value / 100;
  video.currentTime = 0;

  elements.videoPlayerOverlay.hidden = false;
  elements.videoPlayPause.textContent = '⏸';
  elements.videoTime.textContent = '0:00 / 0:00';
  elements.videoProgressFill.style.width = '0%';
  elements.videoProgressThumb.style.left = '0%';

  video.play().catch(() => {});
  updateCoursewareConnectionIndicator();
}

function bindVideoEvents() {
  const video = elements.coursewareVideo;

  // 移除旧事件（避免重复绑定）
  const newVideo = video.cloneNode(false);
  video.parentNode.replaceChild(newVideo, video);
  elements.coursewareVideo = newVideo;

  const v = elements.coursewareVideo;

  v.addEventListener('timeupdate', () => {
    if (!state.videoPlayer.scrubbing && v.duration) {
      const pct = (v.currentTime / v.duration) * 100;
      elements.videoProgressFill.style.width = pct + '%';
      elements.videoProgressThumb.style.left = pct + '%';
      elements.videoTime.textContent = formatTime(v.currentTime) + ' / ' + formatTime(v.duration);
    }
  });

  v.addEventListener('loadedmetadata', () => {
    elements.videoTime.textContent = '0:00 / ' + formatTime(v.duration);
  });

  v.addEventListener('play', () => {
    elements.videoPlayPause.textContent = '⏸';
  });

  v.addEventListener('pause', () => {
    elements.videoPlayPause.textContent = '▶';
  });

  v.addEventListener('ended', () => {
    elements.videoPlayPause.textContent = '↺';
  });

  v.addEventListener('click', () => {
    if (v.paused) {
      if (v.ended) { v.currentTime = 0; }
      v.play().catch(() => {});
    } else {
      v.pause();
    }
  });

  // 控制栏自动隐藏
  v.addEventListener('mousemove', resetVideoIdleTimer);
  v.addEventListener('touchstart', resetVideoIdleTimer);
  elements.videoControls.addEventListener('mousemove', (e) => { e.stopPropagation(); resetVideoIdleTimer(); });
  elements.videoControls.addEventListener('touchstart', (e) => { e.stopPropagation(); resetVideoIdleTimer(); });
  resetVideoIdleTimer();
}

function resetVideoIdleTimer() {
  elements.videoPlayerOverlay.classList.remove('idle');
  if (state.videoPlayer.idleTimer) clearTimeout(state.videoPlayer.idleTimer);
  state.videoPlayer.idleTimer = setTimeout(() => {
    if (!elements.coursewareVideo.paused) {
      elements.videoPlayerOverlay.classList.add('idle');
    }
  }, 3000);
}

function formatTime(seconds) {
  if (isNaN(seconds) || !isFinite(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m + ':' + (s < 10 ? '0' : '') + s;
}

function closeVideoPlayer() {
  const v = elements.coursewareVideo;
  v.pause();
  v.src = '';
  v.removeAttribute('src');
  state.videoPlayer.active = false;
  if (state.videoPlayer.idleTimer) clearTimeout(state.videoPlayer.idleTimer);
  elements.videoPlayerOverlay.hidden = true;
  elements.videoPlayerOverlay.classList.remove('idle');
  closeCourseware('视频播放已结束');
}

// 进度条拖拽
elements.videoProgressContainer.addEventListener('mousedown', (e) => {
  state.videoPlayer.scrubbing = true;
  elements.videoProgressContainer.classList.add('scrubbing');
  scrubVideo(e);
});
elements.videoProgressContainer.addEventListener('touchstart', (e) => {
  state.videoPlayer.scrubbing = true;
  elements.videoProgressContainer.classList.add('scrubbing');
  scrubVideo(e.touches[0]);
});

document.addEventListener('mousemove', (e) => {
  if (state.videoPlayer.scrubbing) scrubVideo(e);
});
document.addEventListener('touchmove', (e) => {
  if (state.videoPlayer.scrubbing) scrubVideo(e.touches[0]);
}, { passive: false });
document.addEventListener('mouseup', () => {
  if (state.videoPlayer.scrubbing) {
    state.videoPlayer.scrubbing = false;
    elements.videoProgressContainer.classList.remove('scrubbing');
  }
});
document.addEventListener('touchend', () => {
  if (state.videoPlayer.scrubbing) {
    state.videoPlayer.scrubbing = false;
    elements.videoProgressContainer.classList.remove('scrubbing');
  }
});

function scrubVideo(e) {
  const rect = elements.videoProgressTrack.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const v = elements.coursewareVideo;
  if (v.duration) {
    v.currentTime = pct * v.duration;
    elements.videoProgressFill.style.width = (pct * 100) + '%';
    elements.videoProgressThumb.style.left = (pct * 100) + '%';
    elements.videoTime.textContent = formatTime(v.currentTime) + ' / ' + formatTime(v.duration);
  }
}

// 播放/暂停
elements.videoPlayPause.addEventListener('click', () => {
  const v = elements.coursewareVideo;
  if (v.paused) {
    if (v.ended) { v.currentTime = 0; }
    v.play().catch(() => {});
  } else {
    v.pause();
  }
});

// 静音
elements.videoMuteBtn.addEventListener('click', () => {
  const v = elements.coursewareVideo;
  v.muted = !v.muted;
  elements.videoMuteBtn.textContent = v.muted ? '🔇' : '🔊';
  if (!v.muted) elements.videoVolumeSlider.value = Math.round(v.volume * 100);
});

// 音量
elements.videoVolumeSlider.addEventListener('input', () => {
  const v = elements.coursewareVideo;
  v.volume = elements.videoVolumeSlider.value / 100;
  v.muted = v.volume === 0;
  elements.videoMuteBtn.textContent = v.muted || v.volume === 0 ? '🔇' : '🔊';
});

// 全屏
elements.videoFullscreenBtn.addEventListener('click', () => {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    elements.videoPlayerOverlay.requestFullscreen().catch(() => {});
  }
});

// 关闭
elements.videoCloseBtn.addEventListener('click', () => {
  closeVideoPlayer();
});

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
  try { elements.videoPlayerOverlay.hidden = true; } catch {}
  if (state.videoPlayer.idleTimer) { clearTimeout(state.videoPlayer.idleTimer); state.videoPlayer.idleTimer = null; }
  try { elements.coursewareVideo.pause(); elements.coursewareVideo.src = ''; elements.coursewareVideo.removeAttribute('src'); } catch {}
  try { state.videoPlayer.active = false; } catch {}
  try { elements.panToolButton.hidden = true; } catch {}
  try { elements.prevPageButton.hidden = true; } catch {}
  try { elements.nextPageButton.hidden = true; } catch {}
  if (elements.selectCoursewareButton) try { elements.selectCoursewareButton.hidden = true; } catch {}
  try { elements.remoteVideo.hidden = false; } catch {}

  // 2. 重置状态
  const willNotifyViewerClose = state.coursewareFromViewer;
  try { state.presentationMode = 'waiting'; } catch {}
  try { state.directTeach = false; } catch {}
  try { state.coursewareFromViewer = false; } catch {}

  // 通知手机端关闭课件翻页页面（仅大屏直接打开的课件才需要通知）
  if (willNotifyViewerClose) {
    sendMessage({ type: 'viewer.courseware.close' });
  }

  // 3. 安全清理课件资源
  try { destroyCoursewareDocument(state.courseware); } catch {}
  try { state.courseware = null; } catch {}
  try { clearCoursewareCanvas(); } catch {}
  try { resetAnnotations(); } catch {}

  // 4. 清理下载相关
  try { hideDownloadButton(); } catch {}

  // 5. 更新提示
  try { setWaitingStatus(statusText); } catch {}

  // 6. 恢复连接码显示（directTeach 模式下可能被覆盖为 ----）
  if (state.roomCode) {
    try { elements.roomCode.textContent = state.roomCode; } catch {}
  }
}

function updateCoursewareConnectionIndicator() {
  // 连接码始终保持可见，仅更新显示内容
  elements.coursewareConnCode.textContent = state.roomCode || '----';
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
      lib.GlobalWorkerOptions.workerSrc = './vendor/pdfjs/build/pdf.worker.min.mjs?v=5.4.530';
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
  if (state.teacherToken && elements.coursewareDropdown) elements.coursewareDropdown.hidden = false;
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
  updateCoursewareConnectionIndicator();
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
  if (elements.coursewareDropdown) {
    elements.coursewareDropdown.hidden = false;
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
  if (elements.coursewareDropdown) {
    elements.coursewareDropdown.hidden = true;
    elements.coursewareDropdownMenu.classList.remove('is-open');
  }
}

function showDownloadButtonIfAvailable() {
  if (state.downloadOriginalUrl) {
    elements.coursewareDropdown.hidden = false;
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
      elements.coursewareGrid.innerHTML = items.map((c, i) => {
        const fileName = c.fileName || c.url || '';
        const isVideo = /\.(mp4|mov|avi|webm|mkv|3gp)(\?|$)/i.test(fileName);
        const isLink = !!c.linkUrl;
        const isCourseware = /\.(ppt|pptx)(\?|$)/i.test(fileName);
        const isDocument = /\.(pdf|doc|docx|xls|xlsx)(\?|$)/i.test(fileName);
        let badge = '';
        if (isLink) badge = '<span class="courseware-link-badge">链接</span>';
        else if (isVideo) badge = '<span class="courseware-video-badge">视频</span>';
        else if (isCourseware) badge = '<span class="courseware-doc-badge">课件</span>';
        else if (isDocument) badge = '<span class="courseware-doc-badge">文档</span>';
        return `
        <div class="courseware-item" data-index="${i}">
          <div class="courseware-item-title">${badge}<span class="courseware-item-title-text">${escapeHtml(c.title)}</span></div>
          <div class="courseware-item-meta"><span class="courseware-item-meta-text">${escapeHtml(fileName)} · ${isLink ? '外部链接' : formatSize(c.size)}</span></div>
        </div>
        `;
      }).join('');
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
  state.coursewareFromViewer = true;

  // 链接类型课件：弹窗提示用户在大屏端打开
  if (cw.linkUrl) {
    showLinkPrompt(cw.title, cw.linkUrl);
    return;
  }

  // 如果有原文件下载地址，直接设置
  if (cw.originalUrl && cw.originalUrl !== cw.url) {
    state.downloadOriginalUrl = cw.originalUrl;
  } else {
    state.downloadOriginalUrl = null;
  }
  openCourseware({ url: cw.url, title: cw.title, page: 1, screen: 1 });

  // 通知手机端同步打开课件翻页页面
  sendMessage({
    type: 'viewer.courseware.open',
    url: cw.url,
    title: cw.title,
    page: 1,
    screen: 1
  });
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

// ---- 链接课件提示弹窗 ----
function showLinkPrompt(title, linkUrl) {
  // 移除已有弹窗
  const existing = document.querySelector('.link-prompt-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay link-prompt-overlay';
  overlay.innerHTML = `
    <div class="modal-card" style="width:420px;text-align:center">
      <h3>🔗 ${escapeHtml(title)}</h3>
      <p style="color:var(--muted);margin:0.5rem 0 1.2rem;word-break:break-all;font-size:0.85rem">${escapeHtml(linkUrl)}</p>
      <p style="margin:0 0 1.2rem">教师已推送链接课件，是否在新窗口打开？</p>
      <div class="modal-actions" style="justify-content:center">
        <button class="btn-secondary" id="link-prompt-cancel">取消</button>
        <button class="btn-primary" id="link-prompt-open" style="margin-left:0.75rem">打开链接</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector('#link-prompt-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#link-prompt-open').addEventListener('click', () => {
    window.open(linkUrl, '_blank', 'noopener,noreferrer');
    overlay.remove();
  });
  // 点击遮罩关闭
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
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
    state.blackboard.panX = 0;
    state.blackboard.panY = 0;
    state.blackboard.scale = 1;
    state.blackboard._panActive = false;
    state.blackboard._pinch.active = false;
    state.blackboard._activePointers.clear();
    clearBlackboardSelection();
    setBlackboardTool('pen');
    updateBlackboardColorButtons();
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

  // 圈选工具：启动套索绘制或拖拽
  if (state.blackboard.tool === 'select') {
    beginBlackboardSelect(event);
    return;
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
    isEraser: isEraser,
    points: [point]
  });
  renderBlackboard();
}

function continueBlackboardStroke(event) {
  if (!state.blackboard.active) return;

  // 始终更新指针位置缓存
  state.blackboard._activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

  // 圈选工具：套索绘制 或 拖拽移动
  if (state.blackboard.tool === 'select') {
    continueBlackboardSelect(event);
    return;
  }

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

  // 圈选工具：套索完成 或 拖拽结束
  if (state.blackboard.tool === 'select') {
    finishBlackboardSelect(event);
    return;
  }

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
      isEraser: !!stroke.isEraser,
      points: stroke.points
    });
  }
  state.blackboard.activeStrokes.delete(event.pointerId);
  runCatching(() => elements.blackboardCanvas.releasePointerCapture(event.pointerId));

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

  // 渲染圈选
  renderBlackboardSelection(ctx);
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
      page.strokes.push({ color: stroke.color, width: stroke.width, isEraser: !!stroke.isEraser, points: stroke.points });
    }
  }
  state.blackboard.activeStrokes.clear();
}

function navigateBlackboardPage(delta) {
  flushBlackboardActiveStrokes();
  clearBlackboardSelection();
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
  clearBlackboardSelection();
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
  clearBlackboardSelection();
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
  // 切换工具时清除旧圈选状态
  if (tool !== 'select') clearBlackboardSelection();

  if (tool === 'eraser') {
    state.blackboard.tool = 'eraser';
  } else if (tool === 'hand') {
    state.blackboard.tool = 'hand';
  } else if (tool === 'select') {
    state.blackboard.tool = 'select';
  } else {
    state.blackboard.tool = 'pen';
  }

  const isEraser = state.blackboard.tool === 'eraser';
  const isHand = state.blackboard.tool === 'hand';
  const isPen = state.blackboard.tool === 'pen';
  const isSelect = state.blackboard.tool === 'select';

  elements.blackboardCanvas.classList.toggle('is-eraser', isEraser);
  elements.blackboardCanvas.classList.toggle('is-hand-tool', isHand);
  elements.blackboardCanvas.classList.toggle('is-select-tool', isSelect);
  elements.blackboardEraserButton.classList.toggle('is-active', isEraser);
  elements.blackboardHandButton.classList.toggle('is-active', isHand);
  elements.blackboardSelectButton.classList.toggle('is-active', isSelect);

  // 删除按钮仅在圈选工具有选中内容时显示
  elements.blackboardDeleteSelButton.style.display = (isSelect && state.blackboard.selection.confirmedIndices.length > 0) ? '' : 'none';

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
  const newTool = state.blackboard.tool === 'hand' ? 'pen' : 'hand';
  setBlackboardTool(newTool);
}

function undoBlackboardStroke() {
  flushBlackboardActiveStrokes();
  clearBlackboardSelection();
  const page = state.blackboard.pages[state.blackboard.currentPage];
  if (page && page.strokes.length > 0) {
    page.strokes.pop();
  }
  renderBlackboard();
  updateBlackboardPageIndicator();
}

function clearBlackboard() {
  flushBlackboardActiveStrokes();
  clearBlackboardSelection();
  const page = state.blackboard.pages[state.blackboard.currentPage];
  if (page) {
    page.strokes = [];
  }
  state.blackboard.activeStrokes.clear();
  renderBlackboard();
  updateBlackboardPageIndicator();
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
  const newTool = state.blackboard.tool === 'eraser' ? 'pen' : 'eraser';
  setBlackboardTool(newTool);
}

// ========== 圈选系统 ==========

function clearBlackboardSelection() {
  const sel = state.blackboard.selection;
  sel.lassoPoints = [];
  sel.drawing = false;
  sel.confirmedIndices = [];
  sel.bbox = null;
  sel.dragging = false;
  sel.dragStartWX = 0;
  sel.dragStartWY = 0;
  sel.dragSnapshot = null;
  elements.blackboardDeleteSelButton.style.display = 'none';
}

function toggleBlackboardSelect() {
  flushBlackboardActiveStrokes();
  if (state.blackboard.tool === 'select') {
    setBlackboardTool('pen');
  } else {
    setBlackboardTool('select');
  }
}

function beginBlackboardSelect(event) {
  const sel = state.blackboard.selection;

  // 如果已有确认的选中内容，尝试拖拽
  if (sel.confirmedIndices.length > 0) {
    const point = blackboardPointerToPoint(event);
    if (!point) return;
    // 判断点击是否落在已选区域的包围盒内
    if (sel.bbox && point.x >= sel.bbox.minX - 20 && point.x <= sel.bbox.maxX + 20
        && point.y >= sel.bbox.minY - 20 && point.y <= sel.bbox.maxY + 20) {
      // 启动拖拽
      event.preventDefault();
      elements.blackboardCanvas.setPointerCapture(event.pointerId);
      sel.dragging = true;
      sel.dragStartWX = point.x;
      sel.dragStartWY = point.y;
      sel.dragSnapshot = deepCopyStrokesForSelection();
      return;
    }
    // 点击在选区外 → 取消选中
    if (sel.confirmedIndices.length > 0) {
      clearBlackboardSelection();
      renderBlackboard();
      return;
    }
  }

  // 否则开始绘制套索
  const point = blackboardPointerToPoint(event);
  if (!point) return;

  // 清空旧结果
  sel.confirmedIndices = [];
  sel.bbox = null;
  sel.dragSnapshot = null;
  elements.blackboardDeleteSelButton.style.display = 'none';

  event.preventDefault();
  elements.blackboardCanvas.setPointerCapture(event.pointerId);
  sel.drawing = true;
  sel.lassoPoints = [point];
  renderBlackboard();
}

function continueBlackboardSelect(event) {
  const sel = state.blackboard.selection;

  // 拖拽移动中
  if (sel.dragging && sel.dragSnapshot) {
    event.preventDefault();
    const point = blackboardPointerToPoint(event);
    if (!point) return;
    const dx = point.x - sel.dragStartWX;
    const dy = point.y - sel.dragStartWY;
    applyDragOffsetToSnapshot(sel.dragSnapshot, dx, dy);
    sel.dragStartWX = point.x;
    sel.dragStartWY = point.y;
    renderBlackboard();
    return;
  }

  // 套索绘制中
  if (!sel.drawing) return;
  event.preventDefault();
  const point = blackboardPointerToPoint(event);
  if (!point) return;

  // 距离阈值，避免点过密
  const last = sel.lassoPoints[sel.lassoPoints.length - 1];
  if (last && Math.hypot(point.x - last.x, point.y - last.y) < 5) return;

  sel.lassoPoints.push(point);
  renderBlackboard();
}

function finishBlackboardSelect(event) {
  const sel = state.blackboard.selection;

  // 拖拽结束：提交
  if (sel.dragging) {
    sel.dragging = false;
    runCatching(() => elements.blackboardCanvas.releasePointerCapture(event.pointerId));
    commitDragSelection(sel.dragSnapshot);
    sel.dragSnapshot = null;
    renderBlackboard();
    return;
  }

  // 套索完成
  if (!sel.drawing) return;
  sel.drawing = false;
  runCatching(() => elements.blackboardCanvas.releasePointerCapture(event.pointerId));

  // 需要至少3个点才能形成闭合区域
  if (sel.lassoPoints.length < 3) {
    sel.lassoPoints = [];
    clearBlackboardSelection();
    renderBlackboard();
    return;
  }

  // 闭合套索（首尾相连）
  const poly = [...sel.lassoPoints];
  if (poly.length > 2) {
    poly.push({ x: poly[0].x, y: poly[0].y });
  }

  // 检测哪些笔画在套索内
  flushBlackboardActiveStrokes();
  const page = state.blackboard.pages[state.blackboard.currentPage];
  if (!page) {
    sel.lassoPoints = [];
    renderBlackboard();
    return;
  }

  const indices = [];
  for (let i = 0; i < page.strokes.length; i++) {
    // 跳过板擦笔迹本身
    if (page.strokes[i].isEraser) continue;
    // 跳过已被后续板擦笔迹完全覆盖的笔迹
    if (isStrokeFullyErased(i, page)) continue;
    if (isStrokeInPolygon(page.strokes[i], poly)) {
      indices.push(i);
    }
  }

  if (indices.length > 0) {
    sel.confirmedIndices = indices;
    sel.bbox = computeBBox(indices.map(i => page.strokes[i]));
    elements.blackboardDeleteSelButton.style.display = '';
  } else {
    clearBlackboardSelection();
  }

  sel.lassoPoints = [];
  renderBlackboard();
}

// 判断笔迹是否被后续的板擦笔迹完全覆盖（视觉上已被擦除）
function isStrokeFullyErased(strokeIndex, page) {
  const stroke = page.strokes[strokeIndex];
  if (!stroke || !stroke.points || stroke.points.length === 0) return true;

  // 遍历当前笔迹之后的所有板擦笔迹
  for (let j = strokeIndex + 1; j < page.strokes.length; j++) {
    const eraser = page.strokes[j];
    if (!eraser.isEraser) continue;
    if (!eraser.points || eraser.points.length < 2) continue;

    const eraserRadius = (eraser.width || 40) / 2;

    // 检查当前笔迹的所有点是否都在板擦覆盖范围内
    let allCovered = true;
    for (const pt of stroke.points) {
      if (!isPointWithinEraserPath(pt, eraser.points, eraserRadius)) {
        allCovered = false;
        break;
      }
    }
    if (allCovered) return true;
  }
  return false;
}

// 判断一个点是否在板擦路径覆盖范围内（点到任意线段的距离 <= 板擦半径）
function isPointWithinEraserPath(pt, eraserPoints, radius) {
  for (let k = 0; k < eraserPoints.length - 1; k++) {
    const seg = { x1: eraserPoints[k].x, y1: eraserPoints[k].y, x2: eraserPoints[k + 1].x, y2: eraserPoints[k + 1].y };
    if (pointToSegmentDistSq(pt.x, pt.y, seg.x1, seg.y1, seg.x2, seg.y2) <= radius * radius) {
      return true;
    }
  }
  // 单独检查最后一个孤立点（如果板擦只有一个点）
  if (eraserPoints.length === 1) {
    const dx = pt.x - eraserPoints[0].x;
    const dy = pt.y - eraserPoints[0].y;
    return dx * dx + dy * dy <= radius * radius;
  }
  return false;
}

// 点 (px,py) 到线段 (x1,y1)-(x2,y2) 的平方距离
function pointToSegmentDistSq(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ex = px - x1;
    const ey = py - y1;
    return ex * ex + ey * ey;
  }
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  const ex = px - projX;
  const ey = py - projY;
  return ex * ex + ey * ey;
}

// 射线法判断点是否在多边形内
function isPointInPolygon(px, py, polygon) {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// 判断笔画是否与套索有交集（至少一个点落在多边形内）
function isStrokeInPolygon(stroke, polygon) {
  if (!stroke.points || stroke.points.length === 0) return false;
  for (const p of stroke.points) {
    if (isPointInPolygon(p.x, p.y, polygon)) return true;
  }
  return false;
}

// 计算笔画集合的包围盒
function computeBBox(strokes) {
  if (!strokes || strokes.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of strokes) {
    if (!s.points) continue;
    for (const p of s.points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return { minX, minY, maxX, maxY };
}

// 深拷贝选中的笔画（用于拖拽预览）
function deepCopyStrokesForSelection() {
  const page = state.blackboard.pages[state.blackboard.currentPage];
  if (!page) return [];
  return state.blackboard.selection.confirmedIndices.map(i => ({
    color: page.strokes[i].color,
    width: page.strokes[i].width,
    isEraser: !!page.strokes[i].isEraser,
    points: page.strokes[i].points.map(p => ({ x: p.x, y: p.y })),
  }));
}

// 对拖拽快照中的所有笔画点位施加偏移
function applyDragOffsetToSnapshot(snapshot, dx, dy) {
  for (const s of snapshot) {
    for (const p of s.points) {
      p.x += dx;
      p.y += dy;
    }
  }
}

// 提交拖拽：从原始page中删除旧笔画，插入偏移后的新笔画
function commitDragSelection(snapshot) {
  if (!snapshot || snapshot.length === 0) return;
  const page = state.blackboard.pages[state.blackboard.currentPage];
  if (!page) return;
  const indices = [...state.blackboard.selection.confirmedIndices].sort((a, b) => b - a);
  for (const i of indices) {
    page.strokes.splice(i, 1);
  }
  // 追加新笔画
  for (const s of snapshot) {
    page.strokes.push({
      color: s.color,
      width: s.width,
      isEraser: !!s.isEraser,
      points: s.points.map(p => ({ x: p.x, y: p.y })),
    });
  }
  // 新确认的索引是刚追加的这些
  state.blackboard.selection.confirmedIndices = [];
  for (let i = page.strokes.length - snapshot.length; i < page.strokes.length; i++) {
    state.blackboard.selection.confirmedIndices.push(i);
  }
  state.blackboard.selection.bbox = computeBBox(snapshot);
  if (state.blackboard.selection.confirmedIndices.length > 0) {
    elements.blackboardDeleteSelButton.style.display = '';
  }
}

// 删除圈选的笔画
function deleteBlackboardSelection() {
  flushBlackboardActiveStrokes();
  const page = state.blackboard.pages[state.blackboard.currentPage];
  if (!page) return;
  const indices = [...state.blackboard.selection.confirmedIndices].sort((a, b) => b - a);
  for (const i of indices) {
    page.strokes.splice(i, 1);
  }
  clearBlackboardSelection();
  renderBlackboard();
  updateBlackboardPageIndicator();
}

// 渲染圈选视觉
function renderBlackboardSelection(ctx) {
  const sel = state.blackboard.selection;
  const page = state.blackboard.pages[state.blackboard.currentPage];

  // 1. 渲染正在绘制的套索
  if (sel.drawing && sel.lassoPoints.length >= 2) {
    ctx.save();
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.9)';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash([8, 4]);
    ctx.beginPath();
    ctx.moveTo(sel.lassoPoints[0].x, sel.lassoPoints[0].y);
    for (let i = 1; i < sel.lassoPoints.length; i++) {
      ctx.lineTo(sel.lassoPoints[i].x, sel.lassoPoints[i].y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  // 2. 拖拽预览：绘制偏移中的笔画
  if (sel.dragging && sel.dragSnapshot) {
    for (const s of sel.dragSnapshot) {
      drawBlackboardStroke(ctx, s);
    }
    // 绘制拖拽中的包围盒
    const bb = computeBBox(sel.dragSnapshot);
    if (bb) drawSelectionBBox(ctx, bb);
    return;
  }

  // 3. 已确认的选中笔画高亮
  if (sel.confirmedIndices.length > 0 && page) {
    // 对被选中的笔画绘制光晕
    for (const i of sel.confirmedIndices) {
      const s = page.strokes[i];
      if (!s || s.points.length === 0) continue;
      ctx.save();
      // 外层光晕
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.25)';
      ctx.lineWidth = s.width + 8;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(s.points[0].x, s.points[0].y);
      for (let j = 1; j < s.points.length; j++) {
        ctx.lineTo(s.points[j].x, s.points[j].y);
      }
      ctx.stroke();
      ctx.restore();
    }
    // 绘制包围盒
    if (sel.bbox) drawSelectionBBox(ctx, sel.bbox);
  }
}

// 绘制选中包围盒
function drawSelectionBBox(ctx, bbox) {
  const pad = 8;
  const w = bbox.maxX - bbox.minX + pad * 2;
  const h = bbox.maxY - bbox.minY + pad * 2;
  ctx.save();
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.8)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 3]);
  ctx.strokeRect(bbox.minX - pad, bbox.minY - pad, w, h);

  // 四个角拖拽手柄
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(56, 189, 248, 0.9)';
  const handleSize = 6;
  const corners = [
    { x: bbox.minX - pad, y: bbox.minY - pad },
    { x: bbox.maxX + pad, y: bbox.minY - pad },
    { x: bbox.minX - pad, y: bbox.maxY + pad },
    { x: bbox.maxX + pad, y: bbox.maxY + pad },
  ];
  for (const c of corners) {
    ctx.fillRect(c.x - handleSize / 2, c.y - handleSize / 2, handleSize, handleSize);
  }
  ctx.restore();
}
