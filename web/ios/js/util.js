// 通用工具：DOM 引用、提示条、遮罩、本地存储。

export const $ = (id) => document.getElementById(id);

const STORAGE_PREFIX = 'myclass.ios.';

export const storage = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
    } catch {
      /* 隐私模式下忽略 */
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(STORAGE_PREFIX + key);
    } catch {
      /* ignore */
    }
  }
};

let toastTimer = null;
export function toast(message, options = {}) {
  const node = $('toast');
  if (!node) return;
  node.textContent = message;
  node.classList.toggle('is-warn', options.warn === true);
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, options.duration || 2200);
}

export function showOverlay(text, options = {}) {
  $('overlayText').textContent = text;
  $('overlay').hidden = false;
  const progress = $('overlayProgress');
  progress.hidden = options.progress !== true;
  if (options.progress === true) {
    setOverlayProgress(0);
  }
  const cancel = $('overlayCancel');
  cancel.hidden = typeof options.onCancel !== 'function';
  cancel.onclick = () => {
    hideOverlay();
    options.onCancel?.();
  };
}

export function setOverlayProgress(ratio) {
  const fill = $('overlayProgressFill');
  if (fill) {
    fill.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
  }
}

export function setOverlayText(text) {
  $('overlayText').textContent = text;
}

export function hideOverlay() {
  const overlay = $('overlay');
  if (overlay) overlay.hidden = true;
}

export function showView(name) {
  const views = ['Auth', 'Connect', 'Menu', 'Live', 'CoursewareSource', 'CoursewareList', 'CoursewarePlay'];
  for (const viewName of views) {
    const node = $(`view${viewName}`);
    if (node) node.hidden = viewName !== name;
  }
}

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function formatBytes(size) {
  const bytes = Number(size);
  if (!Number.isFinite(bytes) || bytes <= 0) return '大小未知';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** iOS 设备方向角：0 / 90 / 180 / 270 */
export function deviceAngle() {
  const angle = window.screen?.orientation?.angle;
  if (typeof angle === 'number') {
    const normalized = ((angle % 360) + 360) % 360;
    if ([0, 90, 180, 270].includes(normalized)) return normalized;
  }
  if (typeof window.orientation === 'number') {
    const normalized = ((window.orientation % 360) + 360) % 360;
    if ([0, 90, 180, 270].includes(normalized)) return normalized;
  }
  return window.innerWidth > window.innerHeight ? 90 : 0;
}

export function isLandscape() {
  const angle = deviceAngle();
  return angle === 90 || angle === 270;
}

/** 是否处于"添加到主屏幕"后的独立窗口 */
export function isStandalone() {
  return window.navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches === true;
}

export function isIos() {
  const ua = window.navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
