// 课件 PDF 页面渲染：让 iPad 端能像 Android 端 CoursewarePdfRenderer 那样，
// 把"课件的一页"渲染成一张位图，从而复用与图片投屏完全相同的标注能力。
//
// 复用大屏端已经在用的 pdf.js（/myclass/vendor/pdfjs）；
// 服务端若只提供了旧版 UMD 构建，则自动回退。

const PDFJS_VERSION = '?v=5.4.530';
const PDFJS_MJS = '../vendor/pdfjs/build/pdf.min.mjs';
const PDFJS_WORKER_MJS = '../vendor/pdfjs/build/pdf.worker.min.mjs';
const PDFJS_UMD_CANDIDATES = [
  '../vendor/pdfjs/build/pdf.min.js',
  '../vendor/vendor-backup/pdfjs/legacy/build/pdf.min.js'
];
const PDFJS_UMD_WORKER = [
  '../vendor/pdfjs/build/pdf.worker.min.js',
  '../vendor/vendor-backup/pdfjs/legacy/build/pdf.worker.min.js'
];

let pdfJsPromise = null;
let legacyPromise = null;
let fallbackIndex = -1;
let legacyRetryUsed = false;
const documentTasks = new WeakMap();

// pdf.js 4.x/5.x 的 worker 在独立线程里运行，页面里的 Promise.withResolvers
// 兜底补丁传不进 worker。浏览器原生没有它（Chrome < 119、Safari < 17.4）时
// worker 会直接起不来：worker 反复重试、PDF 一次都不会被请求，界面只剩
// “课件预览加载失败”。这种环境必须直接用旧版 UMD 构建（大屏端也是这么判断的）。
// 注意：必须在下面任何兜底补丁执行之前取这个值。
const nativeWorkerSupport = typeof Promise.withResolvers === 'function';

/** pdf.js 5.x 内部用到 Promise.withResolvers，旧版 Safari 的主线程需要兜底 */
function ensurePromiseWithResolvers() {
  if (typeof Promise.withResolvers === 'function') return;
  Promise.withResolvers = function withResolvers() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`无法加载 ${src}`));
    document.head.appendChild(script);
  });
}

function loadLegacyPdfJs() {
  if (legacyPromise) return legacyPromise;
  legacyPromise = (async () => {
    for (let index = 0; index < PDFJS_UMD_CANDIDATES.length; index += 1) {
      try {
        await loadScript(`${PDFJS_UMD_CANDIDATES[index]}${PDFJS_VERSION}`);
        const lib = window.pdfjsLib;
        if (!lib) continue;
        fallbackIndex = index;
        lib.GlobalWorkerOptions.workerSrc = `${PDFJS_UMD_WORKER[index]}${PDFJS_VERSION}`;
        return lib;
      } catch {
        /* 尝试下一个候选 */
      }
    }
    throw new Error('PDF 组件加载失败，请检查服务器 vendor 资源');
  })();
  // 失败后允许下一次重新尝试，不把失败结果永久缓存。
  legacyPromise.catch(() => { legacyPromise = null; });
  return legacyPromise;
}

export function loadPdfJs() {
  ensurePromiseWithResolvers();
  if (!nativeWorkerSupport) return loadLegacyPdfJs();
  if (pdfJsPromise) return pdfJsPromise;

  pdfJsPromise = (async () => {
    try {
      // import() resolves relative to this module (ios/js/), whereas the other
      // resource URLs resolve relative to the document (ios/).
      const lib = await import(/* @vite-ignore */ new URL(`${PDFJS_MJS}${PDFJS_VERSION}`, document.baseURI).href);
      lib.GlobalWorkerOptions.workerSrc = `${PDFJS_WORKER_MJS}${PDFJS_VERSION}`;
      return lib;
    } catch {
      // 旧版服务端只有 UMD 构建
      return loadLegacyPdfJs();
    }
  })();

  return pdfJsPromise;
}

export function pdfJsUsesLegacyBuild() {
  return fallbackIndex >= 0 || !nativeWorkerSupport;
}

export async function openPdfDocument(url, { signal } = {}) {
  try {
    return await openWith(await loadPdfJs(), url, signal);
  } catch (error) {
    // 现代构建在个别浏览器上仍可能起不来（worker 初始化失败等）。
    // 整个会话退回旧版 UMD 构建再试一次，避免整块课件都打不开。
    if (signal?.aborted || legacyRetryUsed || !nativeWorkerSupport) throw error;
    legacyRetryUsed = true;
    return openWith(await loadLegacyPdfJs(), url, signal);
  }
}

async function openWith(pdfjsLib, url, signal) {
  if (signal?.aborted) throw new Error('cancelled');
  const task = pdfjsLib.getDocument({
    url,
    cMapUrl: '../vendor/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '../vendor/pdfjs/standard_fonts/',
    disableAutoFetch: true
  });
  const abort = () => { Promise.resolve(task.destroy()).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    let document;
    try {
      document = await task.promise;
    } catch (error) {
      // 失败的任务要显式销毁，避免换旧版构建重试时留下半个 worker。
      Promise.resolve(task.destroy()).catch(() => {});
      throw error;
    }
    documentTasks.set(document, task);
    return document;
  }
  finally { signal?.removeEventListener('abort', abort); }
}

/**
 * 把第 pageNumber 页（1 基）渲染到 canvas，返回页面像素尺寸。
 * maxEdge 限制渲染分辨率，避免整本大课件一次性占满内存。
 * 数值比 Android 的 DEFAULT_MAX_EDGE=2048 大一档：iPad 横屏已改为整屏显示课件
 * （宽约 1117 CSS px，2x 屏即 ~2234 物理像素），2048 的长边会被拉伸发虚。
 * 缩放上限 4 与 Android CoursewarePdfRenderer 的 coerceIn(0.25f, 4f) 保持一致。
 */
export async function renderPdfPage(document, pageNumber, canvas, maxEdge = 2560) {
  const total = document.numPages || 1;
  const target = Math.min(Math.max(1, Math.round(pageNumber) || 1), total);
  const page = await document.getPage(target);

  try {
    const base = page.getViewport({ scale: 1 });
    const longest = Math.max(base.width, base.height) || 1;
    const scale = Math.min(maxEdge / longest, 4);
    const viewport = page.getViewport({ scale });

    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));

    const context = canvas.getContext('2d');
    // PDF 背景透明，补白底（与 Android CoursewarePdfRenderer 一致）
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: context, viewport }).promise;
    return { width: canvas.width, height: canvas.height, page: target };
  } finally {
    page.cleanup?.();
  }
}

export function destroyPdfDocument(document) {
  if (!document) return;
  try {
    const task = documentTasks.get(document);
    documentTasks.delete(document);
    return Promise.resolve(task ? task.destroy() : document.destroy?.()).catch(() => {});
  } catch {
    /* ignore */
  }
}
