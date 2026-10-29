import { mediaKind } from './mediaFiles.mjs?v=20261012-ios3';
import { openPdfDocument, renderPdfPage, destroyPdfDocument } from './pdfview.js?v=20261029-pdfcompat';
import { loadPageMapping, slideEntries } from './coursewarePages.mjs?v=20261022-reader';
import { layoutRect } from './orientation.mjs?v=20261022-reader';

export function playbackProgress(item) {
  const saved = item?.playbackProgress;
  const count = Number(saved?.pageCount);
  const page = Number(saved?.page);
  if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(page) || page < 1) return null;
  const physical = Math.min(page, count);
  const mapped = item.conversion?.statePages;
  const valid = Array.isArray(mapped) && mapped.length === count && Number.isSafeInteger(item.conversion.slideCount) &&
    item.conversion.slideCount > 0 && mapped.every(p => Number.isSafeInteger(p) && p > 0 && p <= item.conversion.slideCount);
  return { physicalPage: physical, page: valid ? mapped[physical - 1] : physical,
    pageCount: valid ? item.conversion.slideCount : count, ratio: physical / count };
}

const cache = new Map();
const fileKeys = new WeakMap();
let fileSequence = 0;
function keyFor(item) {
  const file = item.preparedFile || item.file;
  if (file && !fileKeys.has(file)) fileKeys.set(file, ++fileSequence);
  return `${file ? `file:${fileKeys.get(file)}` : item.url}:page=${playbackProgress(item)?.physicalPage || 1}`;
}
function waitForMedia(media, event, signal, begin) {
  return new Promise((resolve, reject) => {
    const finish = error => {
      media.removeEventListener(event, success); media.removeEventListener('error', failed);
      signal.removeEventListener('abort', abort);
      error ? reject(error) : resolve();
    };
    const success = () => finish();
    const failed = () => finish(new Error('缩略图暂不可用'));
    const abort = () => finish(new Error('cancelled'));
    if (signal.aborted) return abort();
    media.addEventListener(event, success, { once: true });
    media.addEventListener('error', failed, { once: true });
    signal.addEventListener('abort', abort, { once: true });
    try { begin(); } catch (error) { finish(error); }
  });
}
async function thumbnail(item, signal) {
  const file = item.preparedFile || item.file;
  const kind = mediaKind(file?.name || item.url, file?.type);
  if (item.linkUrl) return null;
  const isPdf = /\.pdf(?:[?#]|$)/i.test(item.url || '');
  if (!isPdf && !['image', 'video'].includes(kind)) return null;
  const canvas = document.createElement('canvas');
  const local = file ? URL.createObjectURL(file) : null;
  const url = local || item.url;
  let media, pdf;
  const abortPdf = () => destroyPdfDocument(pdf);
  signal.addEventListener('abort', abortPdf, { once: true });
  try {
    if (isPdf) {
      pdf = await openPdfDocument(url, { signal });
      if (signal.aborted) throw new Error('cancelled');
      const mapping = await loadPageMapping(url, pdf.numPages);
      const savedPage = playbackProgress(item)?.physicalPage || 1;
      const page = slideEntries(mapping, pdf.numPages).find(page => page.last >= savedPage);
      await renderPdfPage(pdf, page?.last || 1, canvas, 240);
    } else {
      media = kind === 'image' ? new Image() : document.createElement('video');
      if (kind === 'video') {
        media.muted = true; media.playsInline = true; media.preload = 'auto';
        await waitForMedia(media, 'loadeddata', signal, () => { media.src = url; media.load(); });
        if (Number.isFinite(media.duration) && media.duration > 0.1) {
          await waitForMedia(media, 'seeked', signal, () => { media.currentTime = Math.min(0.1, media.duration / 2); });
        }
      } else await waitForMedia(media, 'load', signal, () => { media.src = url; });
      const width = media.naturalWidth || media.videoWidth;
      const height = media.naturalHeight || media.videoHeight;
      if (!width || !height) throw new Error('No image dimensions');
      const scale = Math.min(1, 180 / Math.max(width, height));
      canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(media, 0, 0, canvas.width, canvas.height);
    }
    if (signal.aborted) throw new Error('cancelled');
    return await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8));
  } finally {
    signal.removeEventListener('abort', abortPdf);
    if (pdf) await destroyPdfDocument(pdf);
    if (media) { media.pause?.(); media.removeAttribute('src'); media.load?.(); }
    if (local) URL.revokeObjectURL(local);
    canvas.width = canvas.height = 0;
  }
}

/** Observe the scroll container, not draw events; bounded work and cached small blobs. */
export class ListPreviews {
  constructor(root) {
    this.root = root; this.entries = new Map(); this.running = 0; this.closed = false;
    this.observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
      for (const entry of entries) {
        const state = this.entries.get(entry.target);
        if (state) state.visible = entry.isIntersecting;
      }
      this.pump();
    }, { root, rootMargin: '100px' }) : null;
    this.fallback = () => {
      const box = layoutRect(root);
      for (const [node, state] of this.entries) { const rect = layoutRect(node); state.visible = rect.bottom >= box.top && rect.top <= box.bottom; }
      this.pump();
    };
    if (!this.observer) root.addEventListener('scroll', this.fallback, { passive: true });
  }
  add(item, label = '文件', onPreview = null) {
    const node = document.createElement(onPreview ? 'button' : 'span'); node.className = 'file-thumbnail';
    node.textContent = label;
    if (onPreview) {
      node.type = 'button'; node.setAttribute('aria-label', `预览：${item.title || item.fileName || label}`);
      node.addEventListener('click', onPreview);
    } else node.setAttribute('aria-hidden', 'true');
    const state = { item, visible: false, done: false, controller: null, url: null };
    this.entries.set(node, state);
    this.observer?.observe(node);
    if (!this.observer) requestAnimationFrame(this.fallback);
    return node;
  }
  pump() {
    if (this.closed) return;
    for (const [node, state] of this.entries) {
      if (this.running >= 2) break;
      if (!state.visible || state.done || state.controller) continue;
      this.running++;
      state.controller = new AbortController();
      const signal = state.controller.signal;
      const timer = setTimeout(() => state.controller?.abort(), 15000);
      const key = keyFor(state.item);
      (async () => {
        try {
          const blob = cache.get(key) || await thumbnail(state.item, signal);
          if (this.closed || signal.aborted || !blob) return;
          cache.delete(key); cache.set(key, blob);
          while (cache.size > 80) cache.delete(cache.keys().next().value);
          state.url = URL.createObjectURL(blob);
          const image = new Image(); image.alt = ''; image.src = state.url;
          node.replaceChildren(image);
        } catch (error) {
          node.title = '缩略图暂不可用，仍可打开文件';
          if (!signal.aborted) console.warn('Thumbnail preview:', error.message);
        }
        finally {
          clearTimeout(timer); state.controller = null; state.done = true; this.running--;
          this.pump();
        }
      })();
    }
  }
  destroy() {
    this.closed = true; this.observer?.disconnect(); this.root.removeEventListener('scroll', this.fallback);
    for (const state of this.entries.values()) { state.controller?.abort(); if (state.url) URL.revokeObjectURL(state.url); }
    this.entries.clear();
  }
}
