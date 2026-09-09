const state = {
  socket: null,
  peerConnection: null,
  config: null,
  reconnectTimer: null,
  relayCheckTimer: null,
  lastRelayMode: null,
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
    tool: 'pen',
    mode: 'solid',  // solid | dashed | dashdot | highlighter
    lineMode: false,  // true=直线 false=曲线（与线型正交）
    eraserWidth: 40  // 板擦直径(px)
  },
  blackboard: {
    active: false,
    pages: [{ strokes: [] }],  // 每页保存已完成笔画
    currentPage: 0,
    activeStrokes: new Map(),  // 黑板当前页活跃笔画，支持多点
    tool: 'pen',               // 'pen' | 'eraser' | 'hand' | 'select'
    eraserWidth: 40,           // 板擦半径(px)
    currentColor: '#ff4d6d',   // 黑板专用颜色（默认红色）
    mode: 'solid',             // solid | dashed | dashdot | highlighter
    lineMode: false,           // true=直线 false=曲线（与线型正交）
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
  // 投屏图片在大屏端的本地视口，与手机端同一套归一化语义：
  // scale = 相对“适应屏幕”的放大倍数，centerX/centerY = 视口中心在图片中的相对位置。
  // 手机端上报与大屏端本地手势共用这一份状态，保证两端换算口径一致。
  imageView: {
    scale: 1,
    centerX: 0.5,
    centerY: 0.5,
    rotation: 0,
    MIN_SCALE: 1,
    MAX_SCALE: 8,
    // 单指/鼠标拖动平移
    active: false,
    pointerId: null,
    startX: 0,
    startY: 0,
    startCenterX: 0.5,
    startCenterY: 0.5,
    _activePointers: new Map(),
    _pinch: {
      active: false,
      startDist: 0,
      startScale: 1
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
    scrubbing: false,
    lastReportAt: 0,
    // 因浏览器自动播放策略被迫静音启动，需等用户手势后才能恢复声音
    autoplayMuted: false,
    // 用户主动静音（点过静音按钮或把音量拉到 0）
    userMuted: false,
    // 静音前的音量（0~100），取消静音时恢复用
    lastVolumePct: 100,
    // 页面已拿到用户手势（点击/按键）
    userActivated: false,
    gestureBound: false
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
  relayBadge: document.getElementById('relayBadge'),
  remoteVideo: document.getElementById('remoteVideo'),
  coursewareCanvas: document.getElementById('coursewareCanvas'),
  annotationCanvas: document.getElementById('annotationCanvas'),
  annotationToolbar: document.getElementById('annotationToolbar'),
  penToolButton: document.getElementById('penToolButton'),
  panToolButton: document.getElementById('panToolButton'),
  annotationEraserButton: document.getElementById('annotationEraserButton'),
  annotationEraserCursor: document.getElementById('annotationEraserCursor'),
  angleIndicator: document.getElementById('angleIndicator'),
  angleValue: document.getElementById('angleValue'),
  lengthValue: document.getElementById('lengthValue'),
  annotationColorsContainer: document.getElementById('annotationColors'),
  undoAnnotationButton: document.getElementById('undoAnnotationButton'),
  clearAnnotationButton: document.getElementById('clearAnnotationButton'),
  annotationColorButtons: Array.from(document.querySelectorAll('.annotation-color')),
  annotationColorsDropdown: document.getElementById('annotationColorsDropdown'),
  annotationModeMenu: document.getElementById('annotationModeMenu'),
  annotationLineToggle: document.getElementById('annotationLineToggle'),
  fullscreenButton: document.getElementById('annotationFullscreenButton'),
  coursewareDropdown: document.getElementById('coursewareDropdown'),
  coursewareMenuButton: document.getElementById('coursewareMenuButton'),
  coursewareDropdownMenu: document.getElementById('coursewareDropdownMenu'),
  downloadOriginalMenuItem: document.getElementById('downloadOriginalMenuItem'),
  switchCoursewareMenuItem: document.getElementById('switchCoursewareMenuItem'),
  prevPageButton: document.getElementById('prevPageButton'),
  nextPageButton: document.getElementById('nextPageButton'),
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
  homeFullscreenButton: document.getElementById('homeFullscreenButton'),
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
  blackboardColorsDropdown: document.getElementById('blackboardColorsDropdown'),
  blackboardModeMenu: document.getElementById('blackboardModeMenu'),
  blackboardLineToggle: document.getElementById('blackboardLineToggle'),
  // 图片投屏
  imagePlayerOverlay: document.getElementById('imagePlayerOverlay'),
  coursewareImage: document.getElementById('coursewareImage'),
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
  videoPlayerError: document.getElementById('videoPlayerError'),
  videoHint: document.getElementById('videoHint'),
  // 课件连接码角标
  coursewareConnIndicator: document.getElementById('coursewareConnIndicator'),
  coursewareConnCode: document.getElementById('coursewareConnCode'),
  // iPhone 网页版入口
  iosWebAppButton: document.getElementById('iosWebAppButton'),
  iosModal: document.getElementById('iosModal'),
  iosQr: document.getElementById('iosQr'),
  iosUrlText: document.getElementById('iosUrlText'),
  iosCaQr: document.getElementById('iosCaQr'),
  iosModalClose: document.getElementById('iosModalClose'),
};

bootstrap();

/** iPhone 网页版入口：二维码 + 使用说明（iOS 摄像头需要 https 才能授权） */
function setupIosWebAppEntry() {
  const iosVersion = state.config?.iosVersion || 'latest';
  const iosUrl = state.config?.iosUrl || '';
  if (!iosUrl) {
    if (elements.iosWebAppButton) elements.iosWebAppButton.hidden = true;
    return;
  }
  elements.iosQr.src = `./api/ios-qrcode.svg?v=${encodeURIComponent(iosVersion)}`;
  elements.iosUrlText.textContent = iosUrl.replace(/\?v=.*$/, '');
  // 第 1 步：证书安装引导二维码（指向服务器 http://<host>/ca/，扫码即开无需手输）
  elements.iosCaQr.src = './ios-ca-qr.svg';
  elements.iosWebAppButton.addEventListener('click', () => {
    elements.iosModal.hidden = false;
  });
  elements.iosModalClose.addEventListener('click', () => {
    elements.iosModal.hidden = true;
  });
  elements.iosModal.addEventListener('click', (event) => {
    if (event.target === elements.iosModal) elements.iosModal.hidden = true;
  });
}

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
  // 屏蔽右键菜单，避免上课时误触弹出浏览器菜单
  document.addEventListener('contextmenu', (e) => e.preventDefault());
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
    if (state.config?.apkUrl && elements.downloadApkButton) {
      elements.downloadApkButton.href = state.config.apkUrl;
      elements.downloadApkButton.style.display = '';
    }
    if (state.config?.windowsUrl && elements.downloadWindowsButton) {
      elements.downloadWindowsButton.href = state.config.windowsUrl;
      elements.downloadWindowsButton.download = '';
      elements.downloadWindowsButton.hidden = false;
      elements.downloadWindowsButton.textContent = `下载 Windows 投屏程序 v${state.config.windowsVersion || ''}`.trim();
    }
    setupIosWebAppEntry();
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
    // 投屏图片的滚轮缩放与双击复位
    elements.annotationCanvas.addEventListener('wheel', handleImageWheel, { passive: false });
    elements.annotationCanvas.addEventListener('dblclick', handleImageDoubleClick);
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
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const menu = elements.blackboardModeMenu;
        if (btn.dataset.color === state.blackboard.currentColor && menu.classList.contains('is-open')) {
          menu.classList.remove('is-open');
          return;
        }
        setBlackboardColor(btn.dataset.color);
        menu.classList.add('is-open');
      });
    });
    elements.blackboardModeMenu.querySelectorAll('.toolbar-dropdown-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        setBlackboardMode(item.dataset.mode);
        elements.blackboardModeMenu.classList.remove('is-open');
      });
    });
    document.addEventListener('click', (e) => {
      const dropdown = elements.blackboardColorsDropdown;
      if (dropdown && !dropdown.contains(e.target)) {
        elements.blackboardModeMenu.classList.remove('is-open');
      }
    });
    // 直线/曲线切换按钮
    elements.annotationLineToggle.addEventListener('click', () => {
      state.annotations.lineMode = !state.annotations.lineMode;
      updateLineToggleButtons();
    });
    elements.blackboardLineToggle.addEventListener('click', () => {
      state.blackboard.lineMode = !state.blackboard.lineMode;
      updateLineToggleButtons();
    });
    updateLineToggleButtons();
    // 初始化模式菜单图标颜色为当前选中颜色
    updateModeMenuIconColor(elements.annotationModeMenu, state.annotations.currentColor);
    updateModeMenuIconColor(elements.blackboardModeMenu, state.blackboard.currentColor);
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
    elements.annotationEraserButton.addEventListener('click', () => {
      setAnnotationTool(state.annotations.tool === 'eraser' ? 'pen' : 'eraser');
    });
    // 普通标注板擦光标跟踪（文档级，绕过 canvas 指针捕获）
    document.addEventListener('pointermove', (event) => {
      if (state.annotations.tool !== 'eraser') return;
      elements.annotationEraserCursor.style.left = event.clientX + 'px';
      elements.annotationEraserCursor.style.top = event.clientY + 'px';
      const size = state.annotations.eraserWidth;
      elements.annotationEraserCursor.style.width = size + 'px';
      elements.annotationEraserCursor.style.height = size + 'px';
    });
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
    document.addEventListener('fullscreenchange', updateFullscreenButton);
    elements.annotationColorButtons.forEach((button) => {
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        const menu = elements.annotationModeMenu;
        if (button.dataset.color === state.annotations.currentColor && menu.classList.contains('is-open')) {
          menu.classList.remove('is-open');
          return;
        }
        setAnnotationColor(button.dataset.color);
        menu.classList.add('is-open');
      });
    });
    elements.annotationModeMenu.querySelectorAll('.toolbar-dropdown-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        setAnnotationMode(item.dataset.mode);
        elements.annotationModeMenu.classList.remove('is-open');
      });
    });
    document.addEventListener('click', (e) => {
      const dropdown = elements.annotationColorsDropdown;
      if (dropdown && !dropdown.contains(e.target)) {
        elements.annotationModeMenu.classList.remove('is-open');
      }
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
  const bigNum = big.querySelector('.roll-student-big-num');
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
    btn.disabled = true;
    const startTime = Date.now();

    result.classList.remove('done');
    result.classList.add('rolling');
    // 居中超大显示开始滚动
    bigNum.textContent = '??';
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
        bigNum.textContent = text;
        result.classList.add('done');
        big.classList.add('done');
        // 抽完后缩回右下角（保留短暂展示再隐藏）
        setTimeout(() => {
          big.classList.remove('show');
        }, 1400);
        rolling = false;
        btn.disabled = false;
        return;
      }
      const n = Math.floor(Math.random() * studentCount) + 1;
      const text = String(n).padStart(2, '0');
      result.textContent = text;
      bigNum.textContent = text;
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
    case 'courseware.video.control':
      handleCoursewareVideoControl(message);
      break;
    case 'courseware.image.viewport':
      handleCoursewareImageViewport(message);
      break;
    case 'courseware.annotation':
      handleTeacherAnnotation(message);
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
      console.log('[WebRTC] 连接已建立，正在检测直连/中继模式...');
      startRelayBadgeCheck();
    } else if (status === 'failed') {
      stopRelayBadgeCheck();
      elements.videoStatus.textContent = '视频连接失败，请在手机上重新开启直播';
    } else if (status === 'disconnected') {
      stopRelayBadgeCheck();
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

// ---- 中继模式提示 ----
// 通过 getStats 检测当前选中的 ICE 候选对是否经过 TURN 中继（relay）
async function updateRelayBadge() {
  const pc = state.peerConnection;
  if (!pc) {
    return;
  }
  if (pc.connectionState !== 'connected') {
    if (elements.relayBadge) {
      elements.relayBadge.hidden = true;
    }
    return;
  }
  try {
    const stats = await pc.getStats();
    let relay = false;
    stats.forEach((report) => {
      if (report.type !== 'candidate-pair') {
        return;
      }
      // 只统计已成功的候选对（部分实现可能没有 state 字段，兜底处理）
      if (report.state && report.state !== 'succeeded') {
        return;
      }
      const local = report.localCandidateId ? stats.get(report.localCandidateId) : null;
      const remote = report.remoteCandidateId ? stats.get(report.remoteCandidateId) : null;
      if (
        (local && local.candidateType === 'relay') ||
        (remote && remote.candidateType === 'relay')
      ) {
        relay = true;
      }
    });
    if (elements.relayBadge) {
      elements.relayBadge.hidden = !relay;
    }

    // 控制台输出：直连 / 中继，仅在模式变化时打印一次，避免刷屏
    const mode = relay ? '中继模式' : '直连模式';
    if (state.lastRelayMode !== mode) {
      state.lastRelayMode = mode;
      console.log(`[WebRTC] 连接模式：${mode}`);
    }
  } catch (error) {
    // 连接关闭瞬间 getStats 可能抛错，忽略即可
  }
}

function startRelayBadgeCheck() {
  stopRelayBadgeCheck();
  updateRelayBadge();
  state.relayCheckTimer = setInterval(updateRelayBadge, 3000);
}

function stopRelayBadgeCheck() {
  if (state.relayCheckTimer) {
    clearInterval(state.relayCheckTimer);
    state.relayCheckTimer = null;
  }
  if (elements.relayBadge) {
    elements.relayBadge.hidden = true;
  }
}

function cleanupPeerConnection() {
  stopRelayBadgeCheck();
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
  // 图片文件：原图渲染
  const isImage = /\.(jpe?g|png|gif|webp|bmp)(\?|$)/i.test(url);
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

  // 图片文件：直接渲染原图（不走 PDF 转换），保证清晰度
  if (isImage) {
    cleanupPeerConnection();
    resetAnnotations();
    showCoursewareViewForImage({
      url,
      title: typeof message.title === 'string' ? message.title : '图片'
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
    // 渲染完成后才有真实尺寸；在此之前 pdf 不参与视口变换，避免用占位尺寸算错变换
    cssWidth: 0,
    cssHeight: 0,
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
  elements.imagePlayerOverlay.hidden = true;
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

// ---- 图片投屏 ----

function showCoursewareViewForImage(info) {
  state.presentationMode = 'courseware';
  document.body.classList.add('is-streaming');
  elements.joinView.hidden = true;
  // 图片课件与 PDF 课件共用 videoView 展示框架：图片作为内容层显示，
  // 保留标注画布与底部画笔工具栏，便于教师在图片上圈画讲解。
  elements.videoView.hidden = false;
  elements.videoView.dataset.orientation = 'landscape';
  elements.videoView.dataset.lockedZoomed = 'false';
  elements.remoteVideo.hidden = true;
  elements.coursewareCanvas.hidden = true;
  elements.annotationCanvas.hidden = false;
  elements.annotationToolbar.hidden = false;
  elements.videoStatus.hidden = true;
  elements.videoPlayerOverlay.hidden = true;
  // 图片缩放/平移：手机端可控制，大屏端切到手型工具也能拖动（滚轮缩放、双击复位）
  elements.panToolButton.hidden = false;
  elements.prevPageButton.hidden = true;
  elements.nextPageButton.hidden = true;
  if (state.teacherToken && elements.coursewareDropdown) elements.coursewareDropdown.hidden = false;

  // 打开新图片时复位缩放/平移，并裁剪溢出部分（避免沿用上一张的视口）
  elements.imagePlayerOverlay.style.overflow = 'hidden';
  resetImageViewState();
  elements.coursewareImage.style.transform = '';
  elements.coursewareImage.style.transformOrigin = '';
  elements.coursewareImage.src = info.url;
  elements.coursewareImage.alt = info.title || '图片';
  elements.imagePlayerOverlay.hidden = false;
  resizeAnnotationCanvas();
  updateCoursewareConnectionIndicator();
}

// ---- 视频课件播放器 ----

// 浏览器对“无用户手势的有声自动播放”有拦截策略（带 room 参数自动进入的大屏页面
// 常常没有任何点击），直接 play() 会被拒绝。此时先以静音启动拿到播放许可；
// 但取消静音必须等真实用户手势，否则浏览器会撤销播放许可、把视频直接暂停
// （表现为：大屏刚播起来就停，手机端显示“大屏已暂停”）。
function showVideoPlayerError(detail) {
  console.error('[Video] ' + detail);
  const el = elements.videoPlayerError;
  if (el) {
    el.textContent = detail;
    el.hidden = false;
  }
}

function hideVideoPlayerError() {
  if (elements.videoPlayerError) elements.videoPlayerError.hidden = true;
}

function syncVideoMuteButton() {
  elements.videoMuteBtn.textContent = elements.coursewareVideo.muted ? '🔇' : '🔊';
}

function showVideoHint(text) {
  const el = elements.videoHint;
  if (!el) return;
  el.textContent = text;
  el.hidden = !text;
}

function hasPageUserActivation() {
  return !!(navigator.userActivation && navigator.userActivation.hasBeenActive);
}

function restoreAutoplayAudio() {
  const v = elements.coursewareVideo;
  if (!state.videoPlayer.autoplayMuted) return;
  if (state.videoPlayer.userMuted) return;
  if (!state.videoPlayer.userActivated && !hasPageUserActivation()) return;
  v.muted = false;
  state.videoPlayer.autoplayMuted = false;
  showVideoHint('');
  syncVideoMuteButton();
}

// 等老师在大屏上点一次（点画面/按键/拖音量都算手势），再恢复声音
function bindGestureForAudio() {
  if (state.videoPlayer.gestureBound) return;
  state.videoPlayer.gestureBound = true;
  const onGesture = () => {
    state.videoPlayer.userActivated = true;
    restoreAutoplayAudio();
    document.removeEventListener('pointerdown', onGesture, true);
    document.removeEventListener('keydown', onGesture, true);
    document.removeEventListener('touchstart', onGesture, true);
  };
  document.addEventListener('pointerdown', onGesture, true);
  document.addEventListener('keydown', onGesture, true);
  document.addEventListener('touchstart', onGesture, true);
}

function startCoursewareVideo() {
  const v = elements.coursewareVideo;
  if (!v.paused && !v.ended) return;
  const p = v.play();
  if (!p) return;
  p.then(() => {
    // 有声播放成功：若之前因策略静音过且现在已有手势，则恢复声音
    restoreAutoplayAudio();
  }).catch(() => {
    // 无用户手势被拒绝：先静音拿到播放许可，声音留到手势之后再恢复
    v.muted = true;
    state.videoPlayer.autoplayMuted = true;
    syncVideoMuteButton();
    const retry = v.play();
    if (retry) {
      retry.then(() => {
        showVideoHint('已静音播放，点击画面即可开启声音');
        bindGestureForAudio();
        restoreAutoplayAudio();
      }).catch(() => {
        // 静音后仍无法播放：多半不是自动播放策略，而是视频格式/编码不被支持
        // 或视频源无法访问（404/服务器未就绪），直接在屏幕上提示原因
        showVideoPlayerError('无法开始播放：视频格式不被浏览器支持，或视频文件无法访问。\n建议将手机拍摄的视频转成 H.264 MP4（1080P/720P）后重新上传。');
      });
    }
  });
}

function showCoursewareViewForVideo(info) {
  state.presentationMode = 'courseware';
  state.videoPlayer.active = true;
  document.body.classList.add('is-streaming');
  elements.joinView.hidden = true;
  elements.videoView.hidden = true;
  elements.imagePlayerOverlay.hidden = true;
  elements.remoteVideo.hidden = true;
  elements.coursewareCanvas.hidden = true;
  elements.annotationCanvas.hidden = true;
  elements.annotationToolbar.hidden = true;
  elements.panToolButton.hidden = true;
  elements.prevPageButton.hidden = true;
  elements.nextPageButton.hidden = true;
  if (state.teacherToken && elements.coursewareDropdown) elements.coursewareDropdown.hidden = false;

  // 先绑定事件（内部会 cloneNode 替换元素），再设置 src 避免被 cloneNode(false) 丢弃
  hideVideoPlayerError();
  bindVideoEvents();

  const video = elements.coursewareVideo;
  video.src = info.url;
  video.volume = elements.videoVolumeSlider.value / 100;
  video.currentTime = 0;
  // 沿用老师上次的静音选择；是否因策略静音需要重新判定
  video.muted = state.videoPlayer.userMuted;
  state.videoPlayer.autoplayMuted = false;
  showVideoHint('');
  syncVideoMuteButton();

  elements.videoPlayerOverlay.hidden = false;
  elements.videoPlayPause.textContent = '⏸';
  elements.videoTime.textContent = '0:00 / 0:00';
  elements.videoProgressFill.style.width = '0%';
  elements.videoProgressThumb.style.left = '0%';

  startCoursewareVideo();
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
    reportVideoState();
  });

  v.addEventListener('loadedmetadata', () => {
    elements.videoTime.textContent = '0:00 / ' + formatTime(v.duration);
    reportVideoState(true);
  });

  v.addEventListener('play', () => {
    elements.videoPlayPause.textContent = '⏸';
    reportVideoState(true);
  });

  v.addEventListener('pause', () => {
    elements.videoPlayPause.textContent = '▶';
    reportVideoState(true);
  });

  v.addEventListener('ended', () => {
    elements.videoPlayPause.textContent = '↺';
    reportVideoState(true);
  });

  v.addEventListener('seeked', () => {
    reportVideoState(true);
  });

  // 加载/解码错误必须上屏提示，避免“点了播放没反应”却找不到原因
  v.addEventListener('error', () => {
    const err = v.error;
    let detail;
    if (!err) {
      detail = '视频加载失败。';
    } else if (err.code === MediaError.MEDIA_ERR_DECODE) {
      detail = '视频解码失败：浏览器不支持该视频的编码格式（手机拍摄的 HEVC/H.265 常见）。\n请转成 H.264 MP4 后重新上传。';
    } else if (err.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
      detail = '视频格式或编码不被浏览器支持。\n请转成 H.264 MP4 后重新上传。';
    } else if (err.code === MediaError.MEDIA_ERR_NETWORK) {
      detail = '网络错误：视频加载中断，请确认视频文件仍可访问。';
    } else {
      detail = '视频加载失败（错误码 ' + err.code + '）。';
    }
    showVideoPlayerError(detail);
    reportVideoState(true);
  });
  v.addEventListener('canplay', hideVideoPlayerError);
  v.addEventListener('playing', hideVideoPlayerError);

  // 音量/静音变化（本地滑块、静音按钮或手机遥控）统一节流上报给手机端
  v.addEventListener('volumechange', () => reportVideoState());

  v.addEventListener('click', () => {
    if (v.paused) {
      if (v.ended) { v.currentTime = 0; }
      startCoursewareVideo();
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
  hideVideoPlayerError();
  showVideoHint('');
  state.videoPlayer.autoplayMuted = false;
  closeCourseware('视频播放已结束');
}

// ---- 手机端远程控制（视频播放 / 图片视口） ----

function reportVideoState(force = false) {
  if (!state.videoPlayer.active) return;
  const v = elements.coursewareVideo;
  const now = Date.now();
  if (!force && now - (state.videoPlayer.lastReportAt || 0) < 500) return;
  state.videoPlayer.lastReportAt = now;
  sendMessage({
    type: 'courseware.video.state',
    playing: !v.paused && !v.ended,
    position: Number.isFinite(v.currentTime) ? v.currentTime : 0,
    duration: Number.isFinite(v.duration) ? v.duration : 0,
    muted: v.muted,
    volume: Number.isFinite(v.volume) ? Math.round(v.volume * 100) : 100
  });
}

function handleCoursewareVideoControl(message) {
  if (!state.videoPlayer.active) return;
  const v = elements.coursewareVideo;
  const action = typeof message.action === 'string' ? message.action : '';
  if (action === 'play' || action === 'toggle') {
    if (v.paused) {
      if (v.ended) v.currentTime = 0;
      startCoursewareVideo();
    } else if (action === 'toggle') {
      v.pause();
    }
  } else if (action === 'pause') {
    v.pause();
  } else if (action === 'seek') {
    const position = Number(message.position);
    if (!Number.isFinite(position) || !Number.isFinite(v.duration) || v.duration <= 0) return;
    v.currentTime = Math.max(0, Math.min(v.duration, position));
  } else if (action === 'volume') {
    const volume = Number(message.volume);
    if (!Number.isFinite(volume)) return;
    setVideoVolume(Math.max(0, Math.min(100, volume)));
  } else if (action === 'mute') {
    setVideoMuted(!!message.muted);
  }
  reportVideoState(true);
}

/**
 * 从手机端设置大屏音量（0~100）。
 * 调到 0 表示静音；调到 >0 表示“要声音”，即使曾被浏览器自动播放策略强制静音，
 * 也会尽力恢复出声；若浏览器仍拒绝（无用户手势），会自动回落到静音继续播放，不中断画面。
 */
function setVideoVolume(pct) {
  const v = elements.coursewareVideo;
  state.videoPlayer.userActivated = true;
  if (pct > 0) state.videoPlayer.lastVolumePct = pct;
  if (pct <= 0) {
    // 音量归零视为用户主动静音
    v.muted = true;
    state.videoPlayer.userMuted = true;
    state.videoPlayer.autoplayMuted = false;
    showVideoHint('');
  } else {
    v.volume = pct / 100;
    state.videoPlayer.userMuted = false;
    if (elements.videoVolumeSlider && Math.abs(Number(elements.videoVolumeSlider.value) - pct) > 1) {
      elements.videoVolumeSlider.value = String(pct);
    }
    requestSound();
  }
  syncVideoMuteButton();
}

/** 从手机端切换静音。muted=true 静音；false 表示要声音（尽力恢复，见 requestSound）。 */
function setVideoMuted(muted) {
  const v = elements.coursewareVideo;
  state.videoPlayer.userActivated = true;
  if (muted) {
    // 记住当前音量，之后“取消静音”能恢复
    if (v.volume > 0) state.videoPlayer.lastVolumePct = Math.round(v.volume * 100);
    v.muted = true;
    state.videoPlayer.userMuted = true;
    state.videoPlayer.autoplayMuted = false;
    showVideoHint('');
  } else {
    state.videoPlayer.userMuted = false;
    if (v.volume <= 0) {
      const restorePct = state.videoPlayer.lastVolumePct > 0 ? state.videoPlayer.lastVolumePct : 100;
      v.volume = restorePct / 100;
      if (elements.videoVolumeSlider) elements.videoVolumeSlider.value = String(restorePct);
    }
    requestSound();
  }
  syncVideoMuteButton();
}

/**
 * 尽力开启声音：先解除静音，若视频因此被暂停（浏览器无用户手势时常见），
 * 立即重新走 startCoursewareVideo —— 它有声失败会自动回落到静音续播，保证不黑屏。
 */
function requestSound() {
  const v = elements.coursewareVideo;
  v.muted = false;
  state.videoPlayer.autoplayMuted = false;
  showVideoHint('');
  if (v.paused && !v.ended) {
    startCoursewareVideo();
  } else if (v.ended) {
    v.currentTime = 0;
    startCoursewareVideo();
  }
  // 个别浏览器在解除静音后一小段时间才把无手势的有声播放暂停，这里复查一次并救回
  setTimeout(() => {
    if (!v.muted && v.paused && !v.ended && state.videoPlayer.active) {
      startCoursewareVideo();
    }
  }, 300);
}

// 手机端上报的是归一化视口（缩放倍数 + 视口中心在图片中的相对位置 + 旋转角度），
// 大屏端按自身显示尺寸换算成本地像素变换，保证两端看到的区域一致。
function handleCoursewareImageViewport(message) {
  // 图片与 PDF 课件都接受手机端视口：统一写入 state.imageView 后按内容层渲染
  if (currentContentKind() === 'none') return;
  const view = state.imageView;
  const rawScale = Number(message.scale);
  const rawCenterX = Number(message.centerX);
  const rawCenterY = Number(message.centerY);
  view.scale = Number.isFinite(rawScale) ? clamp(rawScale, view.MIN_SCALE, view.MAX_SCALE) : 1;
  view.centerX = Number.isFinite(rawCenterX) ? clamp(rawCenterX, 0, 1) : 0.5;
  view.centerY = Number.isFinite(rawCenterY) ? clamp(rawCenterY, 0, 1) : 0.5;
  view.rotation = normalizeImageRotation(message.rotation);
  clampImageViewCenter();
  applyCoursewareImageViewTransform();
}

// ---- 手机端画笔同步 ----
// 手机端与大屏端画笔共用同一份笔迹（strokes / activeStrokes）与同一套坐标口径
// （0~1 归一化，基准为图片显示矩形），因此这里只需回放动作，渲染完全复用标注层。

/** 一帧内合并多次重绘，避免高频 points 消息把主线程打满 */
let teacherAnnotationFrame = 0;
function scheduleAnnotationRedraw() {
  if (teacherAnnotationFrame) return;
  teacherAnnotationFrame = requestAnimationFrame(() => {
    teacherAnnotationFrame = 0;
    drawAnnotations();
  });
}

function normalizeAnnotationPoints(rawPoints) {
  if (!Array.isArray(rawPoints)) return [];
  const points = [];
  for (const raw of rawPoints) {
    const x = Number(raw && raw.x);
    const y = Number(raw && raw.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    points.push({ x: clamp(x, 0, 1), y: clamp(y, 0, 1) });
  }
  return points;
}

function teacherStrokeKey(strokeId) {
  return `teacher:${strokeId}`;
}

/** 撤销 / 清空前把手机端尚未结束的笔画落盘，保证撤销的是完整的一笔 */
function flushTeacherActiveStrokes() {
  for (const [key, stroke] of Array.from(state.annotations.activeStrokes.entries())) {
    if (!String(key).startsWith('teacher:') || !stroke) continue;
    if (stroke.points.length > 0) {
      state.annotations.strokes.push({
        color: stroke.color,
        width: stroke.width,
        isEraser: !!stroke.isEraser,
        mode: stroke.mode,
        lineMode: !!stroke.lineMode,
        points: stroke.points,
        page: stroke.page || currentCoursewarePage()
      });
    }
    state.annotations.activeStrokes.delete(key);
  }
}

// ---- 笔迹按页：课件每一页的标注独立保存 ----
// 课件翻页时笔迹不再清空，翻回来还在；撤销与清空只作用于当前页。

/** 当前课件页码；非课件场景返回 0，表示不区分页 */
function currentCoursewarePage() {
  return state.courseware ? state.courseware.page : 0;
}

/** 当前页的笔迹（page 为 0 的旧笔迹按当前页处理，兼容旧端） */
function strokesForCurrentPage() {
  const page = currentCoursewarePage();
  return state.annotations.strokes.filter((stroke) => !stroke.page || stroke.page === page);
}

/**
 * 移除当前页的笔迹。
 * @param {boolean} all true 清空当前页全部，false 只撤销最后一笔
 * @returns 是否真的移除了内容
 */
function removeStrokesForCurrentPage(all) {
  const page = currentCoursewarePage();
  const strokes = state.annotations.strokes;
  if (all) {
    const kept = strokes.filter((stroke) => stroke.page && stroke.page !== page);
    if (kept.length === strokes.length) return false;
    state.annotations.strokes = kept;
    return true;
  }
  for (let index = strokes.length - 1; index >= 0; index -= 1) {
    const stroke = strokes[index];
    if (!stroke.page || stroke.page === page) {
      strokes.splice(index, 1);
      return true;
    }
  }
  return false;
}

function handleTeacherAnnotation(message) {
  // 图片投屏与 PDF 课件都接受手机端笔迹；直播 / 黑板场景忽略，避免误画
  if (currentContentKind() === 'none') return;
  const action = message && message.action;
  const key = teacherStrokeKey(typeof message.strokeId === 'string' ? message.strokeId : '');

  if (action === 'begin') {
    const points = normalizeAnnotationPoints(message.points);
    if (points.length === 0) return;
    const isEraser = !!message.isEraser;
    state.annotations.activeStrokes.set(key, {
      pointerId: key,
      color: isEraser ? '#000' : (typeof message.color === 'string' ? message.color : state.annotations.currentColor),
      width: Number.isFinite(Number(message.width)) ? Number(message.width) : 4,
      isEraser,
      mode: isEraser ? null : (typeof message.mode === 'string' ? message.mode : 'solid'),
      lineMode: false,
      points,
      startScreen: null,
      page: Number(message.page) || currentCoursewarePage()
    });
    scheduleAnnotationRedraw();
    return;
  }

  if (action === 'points') {
    const stroke = state.annotations.activeStrokes.get(key);
    if (!stroke) return;
    const points = normalizeAnnotationPoints(message.points);
    if (points.length === 0) return;
    stroke.points.push(...points);
    scheduleAnnotationRedraw();
    return;
  }

  if (action === 'end') {
    const stroke = state.annotations.activeStrokes.get(key);
    state.annotations.activeStrokes.delete(key);
    if (stroke && stroke.points.length > 0) {
      state.annotations.strokes.push({
        color: stroke.color,
        width: stroke.width,
        isEraser: !!stroke.isEraser,
        mode: stroke.mode,
        lineMode: !!stroke.lineMode,
        points: stroke.points,
        page: stroke.page || currentCoursewarePage()
      });
    }
    drawAnnotations();
    updateAnnotationButtons();
    return;
  }

  if (action === 'undo') {
    withSuppressedViewerSync(() => {
      flushTeacherActiveStrokes();
      undoAnnotationStroke();
    });
    return;
  }

  if (action === 'clear') {
    // 按页清空：只清当前页，其它页的标注保留
    withSuppressedViewerSync(() => clearAnnotations());
  }
}

// ---- 大屏端画笔回传手机 ----
// 手机端画笔是单向同步过来的，大屏本地画的笔画同样需要回传，
// 否则两端笔迹栈会发散：大屏擦掉的线手机上还在，撤销也会撤错笔画。

let suppressViewerAnnotationSync = false;
let viewerStrokeSeq = 0;
const viewerStrokeIds = new Map();
const viewerPendingPoints = new Map();
let viewerLastSyncAt = 0;
const VIEWER_ANNOTATION_SYNC_INTERVAL_MS = 60;
const VIEWER_ANNOTATION_MAX_PENDING = 12;

/** 只有图片投屏与 PDF 课件场景手机端才有画板，直播 / 黑板场景回传没有意义 */
function viewerAnnotationEnabled() {
  return !suppressViewerAnnotationSync && currentContentKind() !== 'none';
}

function sendViewerAnnotation(payload) {
  sendMessage(Object.assign({ type: 'viewer.annotation' }, payload));
}

function syncViewerAnnotationBegin(pointerId) {
  if (!viewerAnnotationEnabled()) return;
  const stroke = state.annotations.activeStrokes.get(pointerId);
  if (!stroke || stroke.points.length === 0) return;
  const strokeId = `v${++viewerStrokeSeq}`;
  viewerStrokeIds.set(pointerId, strokeId);
  viewerPendingPoints.set(strokeId, []);
  viewerLastSyncAt = Date.now();
  sendViewerAnnotation({
    action: 'begin',
    strokeId,
    color: stroke.color,
    width: stroke.width,
    isEraser: !!stroke.isEraser,
    mode: stroke.mode || 'solid',
    page: currentCoursewarePage(),
    points: [stroke.points[0]]
  });
}

function syncViewerAnnotationPoints(pointerId, point) {
  const strokeId = viewerStrokeIds.get(pointerId);
  if (!strokeId || !point || !viewerAnnotationEnabled()) return;
  const buffer = viewerPendingPoints.get(strokeId) || [];
  buffer.push(point);
  viewerPendingPoints.set(strokeId, buffer);
  const now = Date.now();
  if (now - viewerLastSyncAt >= VIEWER_ANNOTATION_SYNC_INTERVAL_MS || buffer.length >= VIEWER_ANNOTATION_MAX_PENDING) {
    sendViewerAnnotation({ action: 'points', strokeId, points: buffer });
    viewerPendingPoints.set(strokeId, []);
    viewerLastSyncAt = now;
  }
}

function syncViewerAnnotationEnd(pointerId) {
  const strokeId = viewerStrokeIds.get(pointerId);
  if (!strokeId) return;
  viewerStrokeIds.delete(pointerId);
  const buffer = viewerPendingPoints.get(strokeId) || [];
  viewerPendingPoints.delete(strokeId);
  // 已经发过 begin 就必须补发 end，否则手机端会残留一条未结束的笔画
  if (suppressViewerAnnotationSync) return;
  if (buffer.length > 0) {
    sendViewerAnnotation({ action: 'points', strokeId, points: buffer });
  }
  sendViewerAnnotation({ action: 'end', strokeId, page: currentCoursewarePage() });
}

function syncViewerAnnotationUndo() {
  if (!viewerAnnotationEnabled()) return;
  sendViewerAnnotation({ action: 'undo', page: currentCoursewarePage() });
}

function syncViewerAnnotationClear() {
  if (!viewerAnnotationEnabled()) return;
  sendViewerAnnotation({ action: 'clear', page: currentCoursewarePage() });
}

/** 处理来自手机端的 undo / clear 时抑制回传，避免两端互相撤销形成回环 */
function withSuppressedViewerSync(fn) {
  suppressViewerAnnotationSync = true;
  try {
    fn();
  } finally {
    suppressViewerAnnotationSync = false;
  }
}

/** 旋转角度归一到 0 / 90 / 180 / 270（旧版手机端不下发该字段时为 0） */
function normalizeImageRotation(value) {
  const raw = Math.round(Number(value) || 0);
  const modulo = ((raw % 360) + 360) % 360;
  return Math.round(modulo / 90) * 90 % 360;
}

/**
 * 旋转后需要重新适应屏幕：未旋转时 CSS 已按 min(容器宽/图宽, 容器高/图高) 缩放，
 * 旋转后的适应比例不同，两者相除得到补偿系数，再乘到大屏的 scale 上。
 * 图片尚未加载（取不到原始尺寸）时按 1 处理，退化为原来的行为。
 */
function imageRotationRefitFactor(img, rotation) {
  if (rotation === 0) return 1;
  const intrinsicWidth = img.naturalWidth;
  const intrinsicHeight = img.naturalHeight;
  const overlay = elements.imagePlayerOverlay;
  const containerWidth = overlay?.clientWidth || 0;
  const containerHeight = overlay?.clientHeight || 0;
  if (!intrinsicWidth || !intrinsicHeight || !containerWidth || !containerHeight) return 1;
  const swapped = rotation === 90 || rotation === 270;
  const rotatedWidth = swapped ? intrinsicHeight : intrinsicWidth;
  const rotatedHeight = swapped ? intrinsicWidth : intrinsicHeight;
  const fitBefore = Math.min(containerWidth / intrinsicWidth, containerHeight / intrinsicHeight);
  const fitAfter = Math.min(containerWidth / rotatedWidth, containerHeight / rotatedHeight);
  if (!fitBefore) return 1;
  return fitAfter / fitBefore;
}

// ---- 投屏图片：大屏端本地缩放/平移 ----
// 手机端上报的视口与大屏端本地手势都写入 state.imageView，
// 再由 applyCoursewareImageViewTransform 统一渲染，保证两端换算口径一致。

/** 图片当前是否处于投屏显示状态 */
function isImageViewVisible() {
  return !elements.imagePlayerOverlay.hidden;
}

/** PDF 课件画布当前是否处于显示状态 */
function isCoursewarePdfVisible() {
  return !elements.coursewareCanvas.hidden && !!state.courseware && state.courseware.cssWidth > 0;
}

/**
 * 当前参与视口变换的内容层：图片投屏 / PDF 课件 / 无。
 * 两者共用 state.imageView 与同一套归一化换算（缩放倍数 + 视口中心 0~1），
 * 因此手机端上报的视口与大屏本地手势口径完全一致。
 */
function currentContentKind() {
  if (isImageViewVisible()) return 'image';
  if (isCoursewarePdfVisible()) return 'pdf';
  return 'none';
}

/** 手型工具 + 内容层（图片或 PDF）：此时指针事件用于平移/捏合，而不是画笔 */
function isImageViewPanMode() {
  return currentContentKind() !== 'none' && state.annotations.tool === 'pan';
}

/**
 * 图片在本端的显示基准尺寸（未放大、已按旋转换算到屏幕方向）。
 * baseWidth/baseHeight 与 centerX/centerY 同为屏幕方向的量，
 * 因此平移换算不需要再按旋转角度分支。
 */
function imageViewBaseSize() {
  // PDF 课件：基准尺寸即整页适应后的 CSS 尺寸，页面方向固定不参与旋转换算
  if (currentContentKind() === 'pdf') {
    const courseware = state.courseware;
    return { baseWidth: courseware.cssWidth, baseHeight: courseware.cssHeight, refit: 1 };
  }
  const img = elements.coursewareImage;
  const width = img.offsetWidth;
  const height = img.offsetHeight;
  if (!width || !height) return { baseWidth: 0, baseHeight: 0, refit: 1 };
  const rotation = state.imageView.rotation;
  const refit = imageRotationRefitFactor(img, rotation);
  const swapped = rotation === 90 || rotation === 270;
  return {
    baseWidth: (swapped ? height : width) * refit,
    baseHeight: (swapped ? width : height) * refit,
    refit
  };
}

/**
 * 限制视口中心，保证内容不会被拖出黑边：
 * 内容比视口小（或刚好铺满）的方向不允许平移，只有内容超出视口的方向才留出可平移范围。
 * 图片与 PDF 通用——课件宽度充满时横向可平移范围自然为 0，两侧不会露黑边。
 */
function clampImageViewCenter() {
  const view = state.imageView;
  const { baseWidth, baseHeight } = imageViewBaseSize();
  if (!baseWidth || !baseHeight) return;
  const rect = elements.videoView.getBoundingClientRect();
  const scale = view.scale || 1;
  const limitX = Math.max(0, (1 - rect.width / (baseWidth * scale)) / 2);
  const limitY = Math.max(0, (1 - rect.height / (baseHeight * scale)) / 2);
  view.centerX = clamp(view.centerX, 0.5 - limitX, 0.5 + limitX);
  view.centerY = clamp(view.centerY, 0.5 - limitY, 0.5 + limitY);
}

/** 把 state.imageView 渲染成实际 transform（图片与 PDF 课件共用同一套换算） */
function applyCoursewareImageViewTransform() {
  const kind = currentContentKind();
  if (kind === 'none') return;
  const { baseWidth, baseHeight, refit } = imageViewBaseSize();
  if (!baseWidth || !baseHeight) return;
  const view = state.imageView;
  const offsetX = -view.scale * (view.centerX - 0.5) * baseWidth;
  const offsetY = -view.scale * (view.centerY - 0.5) * baseHeight;
  if (kind === 'pdf') {
    // PDF 页：画布已居中，只需表达缩放与平移（课件页方向固定，不参与旋转）
    const canvas = elements.coursewareCanvas;
    canvas.style.transformOrigin = 'center center';
    canvas.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${view.scale})`;
    drawAnnotations();
    return;
  }
  const img = elements.coursewareImage;
  img.style.transformOrigin = 'center center';
  img.style.transform =
    `translate(${offsetX}px, ${offsetY}px) rotate(${view.rotation}deg) scale(${view.scale * refit})`;
  // 显示区域（含缩放/平移/旋转）已经变化，需要按新区域重绘笔迹，
  // 否则已画的标注会停留在变换前的位置，不随内容移动。
  drawAnnotations();
}

/** 仅复位状态（不渲染），用于打开新图片、关闭课件等场景 */
function resetImageViewState() {
  const view = state.imageView;
  view.scale = 1;
  view.centerX = 0.5;
  view.centerY = 0.5;
  view.rotation = 0;
  view.active = false;
  view.pointerId = null;
  view._activePointers.clear();
  view._pinch.active = false;
  view._pinch.startDist = 0;
  elements.annotationCanvas.classList.remove('is-panning', 'is-pinching');
}

/** 复位视图并立即生效（图片与 PDF 课件通用） */
function resetImageView() {
  if (currentContentKind() === 'none') return;
  resetImageViewState();
  applyCoursewareImageViewTransform();
}

/**
 * 缩放到指定倍数。传入 focusX/focusY（屏幕坐标）时保持该点下的图片内容不动，
 * 不传则以图片中心为焦点。
 */
function zoomImageViewAt(nextScale, focusX, focusY) {
  const view = state.imageView;
  const { baseWidth, baseHeight } = imageViewBaseSize();
  if (!baseWidth || !baseHeight) return;
  const next = clamp(Number(nextScale) || 1, view.MIN_SCALE, view.MAX_SCALE);
  const prev = view.scale || 1;
  if (Math.abs(next - prev) < 0.0005) return;
  const ratio = next / prev;
  const offsetX0 = -prev * (view.centerX - 0.5) * baseWidth;
  const offsetY0 = -prev * (view.centerY - 0.5) * baseHeight;
  let offsetX1 = ratio * offsetX0;
  let offsetY1 = ratio * offsetY0;
  if (Number.isFinite(focusX) && Number.isFinite(focusY)) {
    const rect = elements.imagePlayerOverlay.getBoundingClientRect();
    // 图片居中于 overlay，overlay 中心即图片布局中心
    const ex = focusX - (rect.left + rect.width / 2);
    const ey = focusY - (rect.top + rect.height / 2);
    offsetX1 = ex * (1 - ratio) + ratio * offsetX0;
    offsetY1 = ey * (1 - ratio) + ratio * offsetY0;
  }
  view.scale = next;
  view.centerX = 0.5 - offsetX1 / (next * baseWidth);
  view.centerY = 0.5 - offsetY1 / (next * baseHeight);
  clampImageViewCenter();
  applyCoursewareImageViewTransform();
}

/** 按屏幕位移平移视口（dx/dy 为屏幕像素，右/下为正） */
function panImageViewTo(startCenterX, startCenterY, dx, dy) {
  const view = state.imageView;
  const { baseWidth, baseHeight } = imageViewBaseSize();
  if (!baseWidth || !baseHeight) return;
  const scale = Math.max(view.scale || 1, view.MIN_SCALE);
  view.centerX = startCenterX - dx / (scale * baseWidth);
  view.centerY = startCenterY - dy / (scale * baseHeight);
  clampImageViewCenter();
  applyCoursewareImageViewTransform();
}

// ---- 投屏图片：指针手势（拖动平移 / 双指捏合）----

function beginImagePan(event) {
  const view = state.imageView;
  // 未放大时没有可平移的范围，留给双指缩放等手势处理
  if ((view.scale || 1) <= 1.0001) return;
  event.preventDefault();
  runCatching(() => elements.annotationCanvas.setPointerCapture(event.pointerId));
  view.active = true;
  view.pointerId = event.pointerId;
  view.startX = event.clientX;
  view.startY = event.clientY;
  view.startCenterX = view.centerX;
  view.startCenterY = view.centerY;
  elements.annotationCanvas.classList.add('is-panning');
}

function continueImagePan(event) {
  const view = state.imageView;
  event.preventDefault();
  panImageViewTo(
    view.startCenterX,
    view.startCenterY,
    event.clientX - view.startX,
    event.clientY - view.startY
  );
}

function finishImagePan(event) {
  const view = state.imageView;
  view.active = false;
  view.pointerId = null;
  elements.annotationCanvas.classList.remove('is-panning');
  runCatching(() => elements.annotationCanvas.releasePointerCapture(event.pointerId));
}

function abortImagePan() {
  const view = state.imageView;
  if (!view.active) return;
  view.active = false;
  view.pointerId = null;
  elements.annotationCanvas.classList.remove('is-panning');
}

function startImagePinch() {
  const view = state.imageView;
  const pointers = [...view._activePointers.values()];
  if (pointers.length < 2) return;
  const dist = pointerDist(pointers[0], pointers[1]);
  view._pinch.active = true;
  view._pinch.startDist = dist > 0 ? dist : 1;
  view._pinch.startScale = view.scale || 1;
  elements.annotationCanvas.classList.add('is-pinching');
}

function continueImagePinch() {
  const view = state.imageView;
  const pointers = [...view._activePointers.values()];
  if (pointers.length < 2 || !view._pinch.startDist) {
    endImagePinch();
    return;
  }
  const dist = pointerDist(pointers[0], pointers[1]);
  if (dist < 0.5) return;
  const center = pinchCenter(pointers[0], pointers[1]);
  zoomImageViewAt(view._pinch.startScale * (dist / view._pinch.startDist), center.x, center.y);
}

function endImagePinch() {
  const view = state.imageView;
  const wasActive = view._pinch.active;
  view._pinch.active = false;
  view._pinch.startDist = 0;
  elements.annotationCanvas.classList.remove('is-pinching');
  if (!wasActive) return;
  clampImageViewCenter();
  applyCoursewareImageViewTransform();
  // 松开一指后仍有手指时接续为平移
  if (view._activePointers.size === 1) {
    const [pointerId, point] = [...view._activePointers][0];
    runCatching(() => elements.annotationCanvas.setPointerCapture(pointerId));
    view.active = true;
    view.pointerId = pointerId;
    view.startX = point.x;
    view.startY = point.y;
    view.startCenterX = view.centerX;
    view.startCenterY = view.centerY;
    if ((view.scale || 1) > 1.0001) elements.annotationCanvas.classList.add('is-panning');
  }
}

/**
 * 三个入口统一判断是否由图片手势消费事件，
 * 返回 true 表示不应再走画笔或 PDF 课件平移逻辑。
 */
function beginImageGesture(event) {
  if (!isImageViewPanMode()) return false;
  const view = state.imageView;
  view._activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (view._activePointers.size >= 2) {
    abortImagePan();
    startImagePinch();
    return true;
  }
  if (event.isPrimary) beginImagePan(event);
  return true;
}

function continueImageGesture(event) {
  const view = state.imageView;
  const handling = view.active || view._pinch.active || view._activePointers.size > 0;
  if (!handling) return false;
  view._activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (view._pinch.active) {
    continueImagePinch();
    return true;
  }
  if (view.active && view.pointerId === event.pointerId) {
    if (view._activePointers.size >= 2) {
      abortImagePan();
      startImagePinch();
      return true;
    }
    continueImagePan(event);
    return true;
  }
  // 其余指针（例如尚未触发捏合的第二指）不参与画笔绘制
  return true;
}

function finishImageGesture(event) {
  const view = state.imageView;
  if (!view.active && !view._pinch.active && !view._activePointers.has(event.pointerId)) {
    return false;
  }
  view._activePointers.delete(event.pointerId);
  if (view._pinch.active) {
    endImagePinch();
    return true;
  }
  if (view.active && view.pointerId === event.pointerId) {
    finishImagePan(event);
    return true;
  }
  return true;
}

/** 图片投屏时滚轮缩放（不受工具限制，方便讲解时快速放大局部） */
function handleImageWheel(event) {
  if (!isImageViewVisible()) return;
  event.preventDefault();
  const view = state.imageView;
  zoomImageViewAt(view.scale * Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY);
}

/** 手型工具下双击复位视图 */
function handleImageDoubleClick(event) {
  if (!isImageViewPanMode()) return;
  event.preventDefault();
  resetImageView();
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
    startCoursewareVideo();
  } else {
    v.pause();
  }
});

// 静音：点击=取反；开声交给 setVideoMuted（大屏本地点击是真实用户手势，浏览器放行）
elements.videoMuteBtn.addEventListener('click', () => {
  setVideoMuted(!elements.coursewareVideo.muted);
});

// 音量：大屏本地调节与手机遥控走同一入口，保证两端状态一致并节流上报
elements.videoVolumeSlider.addEventListener('input', () => {
  setVideoVolume(Number(elements.videoVolumeSlider.value));
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
  // 笔迹按页保留：翻页只丢弃未结束的笔画，翻回来时本页标注还在
  state.annotations.activeStrokes.clear();
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
  // 笔迹按页保留：翻页只丢弃未结束的笔画，翻回来时本页标注还在
  state.annotations.activeStrokes.clear();
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
  // 笔迹按页保留：翻页只丢弃未结束的笔画，翻回来时本页标注还在
  state.annotations.activeStrokes.clear();
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
  try { elements.imagePlayerOverlay.hidden = true; } catch {}
  try { elements.coursewareImage.src = ''; elements.coursewareImage.removeAttribute('src'); } catch {}
  resetImageViewState();
  if (state.videoPlayer.idleTimer) { clearTimeout(state.videoPlayer.idleTimer); state.videoPlayer.idleTimer = null; }
  try { elements.coursewareVideo.pause(); elements.coursewareVideo.src = ''; elements.coursewareVideo.removeAttribute('src'); } catch {}
  try { state.videoPlayer.active = false; } catch {}
  try { elements.panToolButton.hidden = true; } catch {}
  try { elements.prevPageButton.hidden = true; } catch {}
  try { elements.nextPageButton.hidden = true; } catch {}
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

/** 课件页渲染的超采样倍率：整页适应后显示尺寸偏小，多渲染一些像素保证放大后依然清晰 */
const COURSEWARE_RENDER_OVERSAMPLE = 1.5;
/** 课件页渲染的最长边上限，避免超大页面占用过多显存 */
const COURSEWARE_MAX_RENDER_EDGE = 4096;

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
    // 宽度充满：课件默认铺满容器宽度，两侧不留黑边；
    // 页面高于屏幕时上下拖动查看（与手机端 FitWidth 的口径一致）。
    const fitScale = containerRect.width / baseViewport.width;
    const cssViewport = page.getViewport({ scale: fitScale });
    const outputScale = Math.min(window.devicePixelRatio || 1, 2);
    let renderScale = fitScale * outputScale * COURSEWARE_RENDER_OVERSAMPLE;
    const longestEdge = Math.max(baseViewport.width, baseViewport.height) * renderScale;
    if (longestEdge > COURSEWARE_MAX_RENDER_EDGE) {
      renderScale *= COURSEWARE_MAX_RENDER_EDGE / longestEdge;
    }
    const renderViewport = page.getViewport({ scale: renderScale });

    canvas.width = Math.max(1, Math.round(renderViewport.width));
    canvas.height = Math.max(1, Math.round(renderViewport.height));
    courseware.fitMode = 'width-fill';
    courseware.cssWidth = Math.round(cssViewport.width);
    courseware.cssHeight = Math.round(cssViewport.height);
    // 分屏字段保留（状态上报与旧端兼容），但不再参与定位：
    // 整页适应后页面不会超出容器，需要看细节时缩放平移即可。
    courseware.maxOffsetX = 0;
    courseware.maxOffsetY = 0;
    courseware.pageStepY = Math.max(1, Math.round(containerRect.height * 0.9));
    courseware.screenCount = 1;
    courseware.screen = 1;
    courseware.offsetX = 0;
    courseware.offsetY = 0;
    courseware.scale = 1;
    updateCoursewareCanvasPlacement();
    resetCoursewareViewport();

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
  canvas.style.width = `${courseware.cssWidth}px`;
  canvas.style.height = `${courseware.cssHeight}px`;
  // 统一视口模型：画布先居中，缩放与平移统一由 transform 表达，
  // 换算方式与图片投屏完全一致，保证手机端与大屏看到同一区域。
  canvas.style.left = `${Math.round((containerRect.width - courseware.cssWidth) / 2)}px`;
  canvas.style.top = `${Math.round((containerRect.height - courseware.cssHeight) / 2)}px`;
}

/** 课件换页 / 尺寸变化后复位视口：缩放回到 1 倍，宽度充满后从页面顶部开始显示 */
function resetCoursewareViewport() {
  resetImageViewState();
  const courseware = state.courseware;
  if (courseware && courseware.cssHeight > 0) {
    const rect = elements.videoView.getBoundingClientRect();
    const limitY = Math.max(0, (1 - rect.height / courseware.cssHeight) / 2);
    // 页面高于屏幕时从顶部开始，符合阅读顺序（与手机端 FitWidth 的复位行为一致）
    state.imageView.centerY = 0.5 - limitY;
  }
  applyCoursewareImageViewTransform();
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
    // 图片尺寸随窗口变化，需按新尺寸重算缩放/平移（内部会重绘笔迹）
    if (isImageViewVisible()) {
      applyCoursewareImageViewTransform();
      return;
    }
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
  // 投屏图片 + 手型工具：走图片自身的平移/捏合，与 PDF 课件的 coursewarePan 分开
  if (beginImageGesture(event)) return;
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
  // 开始画图的瞬间立即收起线型选择下拉，避免遮挡投屏画面
  elements.annotationModeMenu.classList.remove('is-open');
  elements.annotationCanvas.setPointerCapture(event.pointerId);
  const isEraser = state.annotations.tool === 'eraser';
  const isLine = !isEraser && state.annotations.lineMode;
  state.annotations.activeStrokes.set(event.pointerId, {
    pointerId: event.pointerId,
    color: isEraser ? '#000' : state.annotations.currentColor,
    width: isEraser ? state.annotations.eraserWidth : 4,
    isEraser: isEraser,
    mode: isEraser ? null : state.annotations.mode,
    lineMode: isLine,
    points: [point],
    startScreen: isLine ? { x: event.clientX, y: event.clientY } : null,
    page: currentCoursewarePage()
  });
  syncViewerAnnotationBegin(event.pointerId);
  drawAnnotations();
}

function continueAnnotationStroke(event) {
  // 投屏图片：正在平移/捏合时优先处理，避免中途切工具导致手势错乱
  if (continueImageGesture(event)) return;
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
  if (stroke.lineMode) {
    // 直线模式：只保留起点与当前点，水平/竖直自动吸附，实时显示长度与夹角
    const { storagePoint, screenPoint } = computeLineSnap(stroke.points[0], point, stroke.startScreen, event);
    stroke.points = [stroke.points[0], storagePoint];
    updateAngleIndicator(stroke.startScreen, screenPoint);
  } else {
    stroke.points.push(point);
  }
  syncViewerAnnotationPoints(event.pointerId, stroke.points.at(-1));
  drawAnnotations();
}

function finishAnnotationStroke(event) {
  // 投屏图片：清理本次手势的指针缓存，结束平移或捏合
  if (finishImageGesture(event)) return;
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
      isEraser: !!stroke.isEraser,
      mode: stroke.mode,
      lineMode: !!stroke.lineMode,
      points: stroke.points,
      page: stroke.page || currentCoursewarePage()
    });
  }
  state.annotations.activeStrokes.delete(event.pointerId);
  syncViewerAnnotationEnd(event.pointerId);
  runCatching(() => elements.annotationCanvas.releasePointerCapture(event.pointerId));
  if (stroke.lineMode) hideAngleIndicator();
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
  // 只撤销当前页的最后一笔，其它页的标注不受影响
  if (!removeStrokesForCurrentPage(false)) return;
  drawAnnotations();
  updateAnnotationButtons();
  syncViewerAnnotationUndo();
}

function clearAnnotations() {
  // 只清空当前页，其它页的标注保留（关闭课件时用 resetAnnotations 全清）
  if (!removeStrokesForCurrentPage(true)) return;
  state.annotations.activeStrokes.clear();
  drawAnnotations();
  updateAnnotationButtons();
  syncViewerAnnotationClear();
}

function resetAnnotations() {
  state.annotations.strokes = [];
  state.annotations.activeStrokes.clear();
  drawAnnotations();
  updateAnnotationButtons();
}

function updateModeMenuIconColor(menu, color) {
  if (!menu) return;
  menu.querySelectorAll('svg line').forEach((line) => {
    line.setAttribute('stroke', color);
  });
}

function setAnnotationColor(color) {
  if (!color) {
    return;
  }
  state.annotations.currentColor = color;
  setAnnotationTool('pen');
  updateAnnotationColorButtons();
  updateModeMenuIconColor(elements.annotationModeMenu, color);
}

function setAnnotationMode(mode) {
  state.annotations.mode = mode;
}

function updateLineToggleButtons() {
  if (elements.annotationLineToggle) {
    elements.annotationLineToggle.textContent = state.annotations.lineMode ? '曲线' : '直线';
    elements.annotationLineToggle.classList.toggle('is-active', state.annotations.lineMode);
  }
  if (elements.blackboardLineToggle) {
    elements.blackboardLineToggle.textContent = state.blackboard.lineMode ? '曲线' : '直线';
    elements.blackboardLineToggle.classList.toggle('is-active', state.blackboard.lineMode);
  }
}

function setAnnotationTool(tool) {
  state.annotations.tool = (tool === 'pan' || tool === 'eraser') ? tool : 'pen';
  // 离开手型工具时清理可能残留的图片平移/捏合，避免指针缓存影响后续画笔
  if (state.annotations.tool !== 'pan') {
    abortImagePan();
    state.imageView._activePointers.clear();
    state.imageView._pinch.active = false;
    state.imageView._pinch.startDist = 0;
    elements.annotationCanvas.classList.remove('is-panning', 'is-pinching');
  }
  updateAnnotationToolButtons();
}

function updateAnnotationToolButtons() {
  const isPan = state.annotations.tool === 'pan';
  const isEraser = state.annotations.tool === 'eraser';
  // 画笔按钮已整合至颜色选择交互中
  if (elements.penToolButton) elements.penToolButton.hidden = true;
  elements.panToolButton.classList.toggle('is-active', isPan);
  elements.annotationEraserButton.classList.toggle('is-active', isEraser);
  elements.annotationCanvas.classList.toggle('is-pan-tool', isPan);
  elements.annotationCanvas.classList.toggle('is-eraser', isEraser);
  // 非画笔模式只移除调色盘选中圈，调色盘保持可见
  if (isPan || isEraser) {
    elements.annotationColorButtons.forEach((btn) => btn.classList.remove('is-active'));
  } else {
    updateAnnotationColorButtons();
  }
  if (!isEraser) {
    elements.annotationEraserCursor.style.display = 'none';
  } else {
    elements.annotationEraserCursor.style.display = 'block';
  }
}

function updateAnnotationButtons() {
  const hasStrokes = strokesForCurrentPage().length > 0;
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
  // 课件按页保存笔迹：只绘制属于当前页的标注，翻页后自动切换
  const page = currentCoursewarePage();
  for (const stroke of state.annotations.strokes) {
    if (stroke.page && stroke.page !== page) continue;
    drawAnnotationStroke(context, stroke, canvasRect, videoRect, crop);
  }
  for (const stroke of state.annotations.activeStrokes.values()) {
    drawAnnotationStroke(context, stroke, canvasRect, videoRect, crop);
  }
}

function drawAnnotationStroke(context, stroke, canvasRect, videoRect, crop) {
  context.save();
  if (stroke.isEraser) {
    // 标注画布透明（叠在视频上），板擦用 destination-out 真正擦除下层笔画
    context.globalCompositeOperation = 'destination-out';
    context.strokeStyle = '#000';
    context.fillStyle = '#000';
    context.lineWidth = stroke.width;
    context.lineCap = 'round';
    context.lineJoin = 'round';
  } else {
    context.strokeStyle = stroke.color;
    context.fillStyle = stroke.color;
    context.lineWidth = stroke.width;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    if (stroke.mode === 'dashed') {
      context.setLineDash([stroke.width * 2.2, stroke.width * 1.6]);
    } else if (stroke.mode === 'dashdot') {
      context.setLineDash([stroke.width * 2.2, stroke.width * 1.2, 0.1, stroke.width * 1.2]);
    } else if (stroke.mode === 'highlighter') {
      context.lineWidth = stroke.width * 5;
      context.globalAlpha = 0.45;
    }
  }

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
      context.arc(onlyPoint.x, onlyPoint.y, (stroke.mode === 'highlighter' ? stroke.width * 5 : stroke.width) / 2, 0, Math.PI * 2);
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
    // 图片课件：标注绑定到图片内容区域（其 transform 已随手机端视口放大/平移，
    // getBoundingClientRect 会返回变换后的实际区域，笔迹自动跟随图片移动）
    if (!elements.imagePlayerOverlay.hidden) {
      const imageRect = elements.coursewareImage.getBoundingClientRect();
      if (imageRect.width > 0 && imageRect.height > 0) {
        return imageRect;
      }
    }
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
  elements.imagePlayerOverlay.hidden = true;
  elements.joinView.hidden = false;
  elements.videoView.hidden = true;
  elements.remoteVideo.hidden = false;
  elements.coursewareCanvas.hidden = true;
  elements.panToolButton.hidden = true;
  elements.prevPageButton.hidden = true;
  elements.nextPageButton.hidden = true;
}

function showVideoView() {
  state.presentationMode = 'video';
  setAnnotationTool('pen');
  elements.coursewareCanvas.hidden = true;
  elements.imagePlayerOverlay.hidden = true;
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
  elements.imagePlayerOverlay.hidden = true;
  elements.coursewareCanvas.hidden = false;
  elements.videoView.dataset.orientation = 'landscape';
  elements.videoView.dataset.lockedZoomed = 'false';
  document.body.classList.add('is-streaming');
  elements.joinView.hidden = true;
  elements.videoView.hidden = false;
  elements.panToolButton.hidden = false;
  elements.prevPageButton.hidden = false;
  elements.nextPageButton.hidden = false;
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
  const isLine = !isEraser && state.blackboard.lineMode;
  state.blackboard.activeStrokes.set(event.pointerId, {
    pointerId: event.pointerId,
    color: isEraser ? '#2c2f36' : state.blackboard.currentColor,
    width: isEraser ? state.blackboard.eraserWidth : 6,
    isEraser: isEraser,
    mode: isEraser ? null : state.blackboard.mode,
    lineMode: isLine,
    points: [point],
    startScreen: isLine ? { x: event.clientX, y: event.clientY } : null
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
  if (stroke.lineMode) {
    // 直线模式：只保留起点与当前点，水平/竖直自动吸附，实时显示长度与夹角
    const { storagePoint, screenPoint } = computeLineSnap(stroke.points[0], point, stroke.startScreen, event);
    stroke.points = [stroke.points[0], storagePoint];
    updateAngleIndicator(stroke.startScreen, screenPoint);
  } else {
    stroke.points.push(point);
  }
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
      mode: stroke.mode,
      lineMode: !!stroke.lineMode,
      points: stroke.points
    });
  }
  state.blackboard.activeStrokes.delete(event.pointerId);
  runCatching(() => elements.blackboardCanvas.releasePointerCapture(event.pointerId));
  if (stroke.lineMode) hideAngleIndicator();

  renderBlackboard();
  updateBlackboardPageIndicator();
}

const LINE_SNAP_THRESHOLD = 5; // 水平/竖直吸附阈值（度）

// 直线吸附：根据屏幕角度判断是否吸附到水平/竖直，返回存储坐标点和屏幕坐标点
function computeLineSnap(startPoint, point, startScreen, event) {
  const dx = event.clientX - startScreen.x;
  const dy = event.clientY - startScreen.y;
  const angle = Math.atan2(-dy, dx) * 180 / Math.PI;
  let storagePoint = point;
  let screenPoint = { x: event.clientX, y: event.clientY };
  // 水平吸附：角度接近 0° 或 ±180°
  if (Math.abs(angle) < LINE_SNAP_THRESHOLD || Math.abs(angle) > 180 - LINE_SNAP_THRESHOLD) {
    storagePoint = { x: point.x, y: startPoint.y };
    screenPoint = { x: event.clientX, y: startScreen.y };
  } else if (Math.abs(Math.abs(angle) - 90) < LINE_SNAP_THRESHOLD) {
    // 竖直吸附：角度接近 ±90°
    storagePoint = { x: startPoint.x, y: point.y };
    screenPoint = { x: startScreen.x, y: event.clientY };
  }
  return { storagePoint, screenPoint };
}

function updateAngleIndicator(startScreen, screenPoint) {
  if (!startScreen || !elements.angleIndicator) return;
  const dx = screenPoint.x - startScreen.x;
  const dy = screenPoint.y - startScreen.y;
  const length = Math.hypot(dx, dy);
  if (length < 2) return;
  // 与水平方向的夹角（屏幕 y 轴向下，取负使向上为正），范围 -180°~180°
  const angle = Math.atan2(-dy, dx) * 180 / Math.PI;
  elements.angleValue.textContent = `${angle.toFixed(1)}°`;
  elements.lengthValue.textContent = `${Math.round(length)}px`;
  elements.angleIndicator.style.left = `${screenPoint.x}px`;
  elements.angleIndicator.style.top = `${screenPoint.y}px`;
  elements.angleIndicator.classList.add('is-visible');
}

function hideAngleIndicator() {
  if (elements.angleIndicator) {
    elements.angleIndicator.classList.remove('is-visible');
  }
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
  if (!stroke.isEraser) {
    if (stroke.mode === 'dashed') {
      ctx.setLineDash([stroke.width * 2.2, stroke.width * 1.6]);
    } else if (stroke.mode === 'dashdot') {
      ctx.setLineDash([stroke.width * 2.2, stroke.width * 1.2, 0.1, stroke.width * 1.2]);
    } else if (stroke.mode === 'highlighter') {
      ctx.lineWidth = stroke.width * 5;
      ctx.globalAlpha = 0.45;
    }
  }

  ctx.beginPath();
  ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
  for (let i = 1; i < stroke.points.length; i++) {
    ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
  }
  ctx.stroke();

  if (stroke.points.length === 1) {
    ctx.beginPath();
    const r = (!stroke.isEraser && stroke.mode === 'highlighter') ? stroke.width * 5 : stroke.width;
    ctx.arc(stroke.points[0].x, stroke.points[0].y, r / 2, 0, Math.PI * 2);
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
      page.strokes.push({ color: stroke.color, width: stroke.width, isEraser: !!stroke.isEraser, mode: stroke.mode, points: stroke.points });
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

function setBlackboardMode(mode) {
  state.blackboard.mode = mode;
}

function setBlackboardColor(color) {
  if (!color) return;
  state.blackboard.currentColor = color;
  // 选颜色自动切回画笔
  setBlackboardTool('pen');
  updateBlackboardColorButtons();
  updateModeMenuIconColor(elements.blackboardModeMenu, color);
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
    mode: page.strokes[i].mode,
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
      mode: s.mode,
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
