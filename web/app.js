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
    activeStroke: null,
    currentColor: '#ffd166',
    tool: 'pen'
  },
  coursewarePan: {
    active: false,
    pointerId: null,
    startX: 0,
    startY: 0,
    startOffsetX: 0,
    startOffsetY: 0
  }
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
  penToolButton: document.getElementById('penToolButton'),
  panToolButton: document.getElementById('panToolButton'),
  undoAnnotationButton: document.getElementById('undoAnnotationButton'),
  clearAnnotationButton: document.getElementById('clearAnnotationButton'),
  annotationColorButtons: Array.from(document.querySelectorAll('.annotation-color')),
  fullscreenButton: document.getElementById('fullscreenButton'),
  downloadOriginalButton: document.getElementById('downloadOriginalButton'),
  prevPageButton: document.getElementById('prevPageButton'),
  nextPageButton: document.getElementById('nextPageButton'),
  offlineCode: document.getElementById('offlineCode'),
  offlineCodeValue: document.getElementById('offlineCodeValue'),
  downloadApkButton: document.getElementById('downloadApkButton'),
};

bootstrap();

async function bootstrap() {
  try {
    state.config = await loadConfig();
    const apkVersion = state.config?.apkVersion || 'latest';
    elements.apkQr.src = `./api/apk-qrcode.svg?v=${encodeURIComponent(apkVersion)}`;
    elements.downloadHint.textContent = `APP v${apkVersion}`;
    if (state.config?.apkUrl) {
      elements.downloadApkButton.href = '#';
      elements.downloadApkButton.hidden = false;
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
    elements.remoteVideo.addEventListener('loadedmetadata', updateVideoPresentation);
    elements.remoteVideo.addEventListener('resize', updateVideoPresentation);
    window.addEventListener('resize', handleViewportResize);
    // 首次点击页面任意位置自动全屏（排除下载按钮）
    const autoFullscreen = (e) => {
      if (e.target.closest('#downloadApkButton')) return;
      document.documentElement.requestFullscreen().catch(() => {});
      document.removeEventListener('click', autoFullscreen);
    };
    document.addEventListener('click', autoFullscreen);
    elements.annotationCanvas.addEventListener('pointerdown', beginAnnotationStroke);
    elements.annotationCanvas.addEventListener('pointermove', continueAnnotationStroke);
    elements.annotationCanvas.addEventListener('pointerup', finishAnnotationStroke);
    elements.annotationCanvas.addEventListener('pointercancel', finishAnnotationStroke);
    elements.penToolButton.addEventListener('click', () => setAnnotationTool('pen'));
    elements.panToolButton.addEventListener('click', () => setAnnotationTool('pan'));
    elements.undoAnnotationButton.addEventListener('click', undoAnnotationStroke);
    elements.clearAnnotationButton.addEventListener('click', clearAnnotations);
    elements.fullscreenButton.addEventListener('click', toggleFullscreen);
    elements.downloadOriginalButton.addEventListener('click', downloadOriginalFile);
    elements.prevPageButton.addEventListener('click', () => navigatePage(-1));
    elements.nextPageButton.addEventListener('click', () => navigatePage(1));
    document.addEventListener('fullscreenchange', updateFullscreenButton);
    elements.annotationColorButtons.forEach((button) => {
      button.addEventListener('click', () => setAnnotationColor(button.dataset.color));
    });
    updateAnnotationButtons();
    updateAnnotationColorButtons();
    updateAnnotationToolButtons();
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
    if (state.presentationMode === 'courseware') {
      showOfflineCode();
      setWaitingStatus('信令连接已断开，可继续翻页查看课件');
    } else {
      showJoinView();
      elements.roomCode.textContent = '----';
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
      hideOfflineCode();
      setWaitingStatus('教师已连接，等待直播...');
      break;
    case 'teacher.offline':
      cleanupPeerConnection();
      if (state.presentationMode === 'courseware') {
        showOfflineCode();
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
      closeCourseware();
      break;
    case 'courseware.original':
      handleCoursewareOriginal(message);
      break;
    case 'teacher.stop':
      cleanupPeerConnection();
      closeCourseware(
        state.presentationMode === 'courseware'
          ? '课件播放已结束，等待教师连接...'
          : '直播已停止，等待教师重新开始...'
      );
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
    configureLowLatencyReceiver(event.receiver);
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

  cleanupPeerConnection();
  resetAnnotations();
  setAnnotationTool('pen');
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
    pageStepY: 0,
    fitMode: 'fit-page',
    cssWidth: 1,
    cssHeight: 1,
    pageCount: 0,
    pdfDocument: null,
    loadingTask: null,
    renderTask: null,
    renderGeneration: 0
  };
  // 从消息中读取原始文件下载地址（服务端已注入）
  if (typeof message.originalUrl === 'string' && message.originalUrl) {
    state.downloadOriginalUrl = message.originalUrl;
    state.courseware.downloadOriginalUrl = message.originalUrl;
  }
  showCoursewareView();
  loadCoursewareDocument(state.courseware);
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
  courseware.offsetY = 0;
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

function showOfflineCode() {
  elements.offlineCodeValue.textContent = elements.roomCode.textContent;
  elements.offlineCode.hidden = false;
}

function hideOfflineCode() {
  elements.offlineCode.hidden = true;
}

function closeCourseware(statusText = '课件播放已结束，等待教师连接...') {
  hideDownloadButton();
  elements.prevPageButton.hidden = true;
  elements.nextPageButton.hidden = true;
  destroyCoursewareDocument(state.courseware);
  state.courseware = null;
  clearCoursewareCanvas();
  resetAnnotations();
  showJoinView();
  setWaitingStatus(statusText);
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
    courseware.maxOffsetY = Math.max(0, courseware.cssHeight - containerRect.height);
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
    pdfJsPromise = import('./vendor/pdfjs/build/pdf.min.mjs').then((pdfjsLib) => {
      pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdfjs/build/pdf.worker.min.mjs';
      return pdfjsLib;
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
  courseware.offsetY = offsetYForCoursewareScreen(courseware, courseware.screen);
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
  const left = courseware.maxOffsetX > 0
    ? -courseware.offsetX
    : (containerRect.width - courseware.cssWidth) / 2;
  const top = courseware.maxOffsetY > 0
    ? -courseware.offsetY
    : (containerRect.height - courseware.cssHeight) / 2;
  canvas.style.width = `${courseware.cssWidth}px`;
  canvas.style.height = `${courseware.cssHeight}px`;
  canvas.style.left = `${Math.round(left)}px`;
  canvas.style.top = `${Math.round(top)}px`;
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
  if (!event.isPrimary) {
    return;
  }
  if (state.presentationMode === 'courseware' && state.annotations.tool === 'pan') {
    beginCoursewarePan(event);
    return;
  }
  const point = pointerEventToSourcePoint(event);
  if (!point) {
    return;
  }
  event.preventDefault();
  elements.annotationCanvas.setPointerCapture(event.pointerId);
  state.annotations.activeStroke = {
    pointerId: event.pointerId,
    color: state.annotations.currentColor,
    width: 6,
    points: [point]
  };
  drawAnnotations();
}

function continueAnnotationStroke(event) {
  if (state.coursewarePan.active && state.coursewarePan.pointerId === event.pointerId) {
    continueCoursewarePan(event);
    return;
  }
  const stroke = state.annotations.activeStroke;
  if (!stroke || stroke.pointerId !== event.pointerId) {
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
  if (state.coursewarePan.active && state.coursewarePan.pointerId === event.pointerId) {
    finishCoursewarePan(event);
    return;
  }
  const stroke = state.annotations.activeStroke;
  if (!stroke || stroke.pointerId !== event.pointerId) {
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
  state.annotations.activeStroke = null;
  runCatching(() => elements.annotationCanvas.releasePointerCapture(event.pointerId));
  drawAnnotations();
  updateAnnotationButtons();
}

function beginCoursewarePan(event) {
  const courseware = state.courseware;
  if (!courseware || (courseware.maxOffsetX <= 0 && courseware.maxOffsetY <= 0)) {
    return;
  }
  event.preventDefault();
  elements.annotationCanvas.setPointerCapture(event.pointerId);
  state.coursewarePan = {
    active: true,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    startOffsetX: courseware.offsetX,
    startOffsetY: courseware.offsetY
  };
  elements.annotationCanvas.classList.add('is-panning');
}

function continueCoursewarePan(event) {
  const courseware = state.courseware;
  if (!courseware) {
    return;
  }
  event.preventDefault();
  const deltaX = event.clientX - state.coursewarePan.startX;
  const deltaY = event.clientY - state.coursewarePan.startY;
  courseware.offsetX = clamp(
    state.coursewarePan.startOffsetX - deltaX,
    0,
    courseware.maxOffsetX
  );
  courseware.offsetY = clamp(
    state.coursewarePan.startOffsetY - deltaY,
    0,
    courseware.maxOffsetY
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
  state.annotations.activeStroke = null;
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
  elements.penToolButton.classList.toggle('is-active', !isPan);
  elements.panToolButton.classList.toggle('is-active', isPan);
  elements.annotationCanvas.classList.toggle('is-pan-tool', isPan);
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
  if (state.annotations.activeStroke) {
    drawAnnotationStroke(context, state.annotations.activeStroke, canvasRect, videoRect, crop);
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
  elements.offlineCode.hidden = true;
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
