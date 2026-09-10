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
let fallbackIndex = -1;

/** pdf.js 5.x 内部用到 Promise.withResolvers，旧版 Safari 需要兜底 */
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

export function loadPdfJs() {
  if (pdfJsPromise) return pdfJsPromise;

  pdfJsPromise = (async () => {
    ensurePromiseWithResolvers();
    try {
      const lib = await import(/* @vite-ignore */ `${PDFJS_MJS}${PDFJS_VERSION}`);
      lib.GlobalWorkerOptions.workerSrc = `${PDFJS_WORKER_MJS}${PDFJS_VERSION}`;
      return lib;
    } catch {
      // 旧版服务端只有 UMD 构建
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
    }
  })();

  return pdfJsPromise;
}

export function pdfJsUsesLegacyBuild() {
  return fallbackIndex >= 0;
}

export async function openPdfDocument(url) {
  const pdfjsLib = await loadPdfJs();
  const task = pdfjsLib.getDocument({
    url,
    cMapUrl: '../vendor/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '../vendor/pdfjs/standard_fonts/',
    disableAutoFetch: true
  });
  return task.promise;
}

/**
 * 把第 pageNumber 页（1 基）渲染到 canvas，返回页面像素尺寸。
 * maxEdge 限制渲染分辨率，避免整本大课件一次性占满内存（对齐 Android DEFAULT_MAX_EDGE=2048）。
 */
export async function renderPdfPage(document, pageNumber, canvas, maxEdge = 2048) {
  const total = document.numPages || 1;
  const target = Math.min(Math.max(1, Math.round(pageNumber) || 1), total);
  const page = await document.getPage(target);

  try {
    const base = page.getViewport({ scale: 1 });
    const longest = Math.max(base.width, base.height) || 1;
    const scale = Math.min(maxEdge / longest, 2.5);
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
    document.destroy?.();
  } catch {
    /* ignore */
  }
}
