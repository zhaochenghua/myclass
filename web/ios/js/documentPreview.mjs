import { openPdfDocument, renderPdfPage, destroyPdfDocument } from './pdfview.js?v=20261029-pdfcompat';
import { loadPageMapping, slideEntries } from './coursewarePages.mjs?v=20261022-reader';
import { layoutRect } from './orientation.mjs?v=20261022-reader';

export function createDocumentPreview(root) {
  let closeCurrent = null;
  async function open(item) {
    closeCurrent?.();
    const focus = document.activeElement;
    const modal = document.createElement('section');
    modal.className = 'document-preview';
    modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', item.title || '课件预览');
    const header = document.createElement('header');
    const back = document.createElement('button'); back.className = 'pill'; back.textContent = '返回';
    const title = document.createElement('h2'); title.textContent = item.title || item.fileName || '课件预览';
    const status = document.createElement('button'); status.className = 'preview-status'; status.textContent = '加载中...';
    status.setAttribute('aria-label', '预览状态');
    const list = document.createElement('div'); list.className = 'document-pages'; list.tabIndex = 0;
    list.setAttribute('aria-label', '课件连续预览');
    header.append(back, title, status); modal.append(header, list); root.append(modal); back.focus();
    const controller = new AbortController();
    let pdf = null, observer = null, closed = false, busy = false;
    let rows = [], cachedBytes = 0;
    const cache = new Map();
    const local = item.preparedFile || item.file;
    const url = local ? URL.createObjectURL(local) : item.url;
    function close() {
      if (closed) return;
      closed = true; controller.abort(); observer?.disconnect();
      modal.querySelector('video')?.pause();
      destroyPdfDocument(pdf);
      rows.forEach(row => { row.canvas.width = row.canvas.height = 0; });
      if (local) URL.revokeObjectURL(url);
      document.removeEventListener('keydown', keydown, true);
      modal.remove(); if (focus?.isConnected) focus.focus({ preventScroll: true });
      if (closeCurrent === close) closeCurrent = null;
    }
    function keydown(event) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); }
      if (event.key === 'Tab') {
        const buttons = [...modal.querySelectorAll('button, video, .document-pages')].filter(node => !node.disabled && node.getClientRects().length && !node.hidden);
        if (!buttons.length) return;
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener('keydown', keydown, true); back.onclick = close; closeCurrent = close;
    function evict() {
      for (const [row, bytes] of cache) {
        if (cachedBytes <= 24 * 1024 * 1024) break;
        if (row.visible) continue;
        row.canvas.width = row.canvas.height = 0;
        row.ready = false; cache.delete(row); cachedBytes -= bytes;
      }
    }
    async function pump() {
      if (busy || closed || !pdf) return;
      const row = rows.find(row => row.visible && !row.ready && !row.failed);
      if (!row) return;
      busy = true;
      try {
        await renderPdfPage(pdf, row.page.last, row.canvas, 2048);
        if (closed) { row.canvas.width = row.canvas.height = 0; return; }
        row.node.style.aspectRatio = `${row.canvas.width} / ${row.canvas.height}`;
        row.canvas.setAttribute('aria-label', `第 ${row.page.slide} 页预览`);
        row.ready = true; row.retry.hidden = true;
        const bytes = row.canvas.width * row.canvas.height * 4;
        cache.set(row, bytes); cachedBytes += bytes; evict();
      } catch {
        if (!closed) { row.failed = true; row.retry.hidden = false; }
      } finally { busy = false; if (!closed) pump(); }
    }
    function updateVisible() {
      const bounds = layoutRect(list);
      let first = null;
      rows.forEach(row => {
        const rect = layoutRect(row.node);
        row.visible = rect.bottom > bounds.top && rect.top < bounds.bottom;
        if (!first && row.visible) first = row;
      });
      if (first) status.textContent = `${rows.indexOf(first) + 1} / ${rows.length}`;
      evict(); pump();
    }
    list.addEventListener('scroll', updateVisible, { passive: true });
    async function load() {
      status.onclick = null; status.textContent = '加载中...';
      list.querySelector('video')?.pause(); list.replaceChildren();
      try {
        if (/\.pdf(?:[?#]|$)/i.test(url) || local?.type === 'application/pdf' || /\.pdf$/i.test(local?.name || '')) {
          pdf = await openPdfDocument(url, { signal: controller.signal });
          if (closed) return void destroyPdfDocument(pdf);
          const mapping = await loadPageMapping(url, pdf.numPages);
          if (closed) return;
          const first = await pdf.getPage(1);
          const size = first.getViewport({ scale: 1 }); first.cleanup();
          rows = slideEntries(mapping, pdf.numPages).map(page => {
            const node = document.createElement('div'); node.className = 'document-page';
            node.style.aspectRatio = `${size.width} / ${size.height}`; node.setAttribute('aria-label', `第 ${page.slide} 页`);
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = 0;
            const retry = document.createElement('button'); retry.textContent = '加载失败，点击重试'; retry.hidden = true;
            const row = { node, canvas, retry, page, ready: false, failed: false, visible: false };
            retry.onclick = () => { row.failed = false; retry.hidden = true; pump(); };
            node.append(canvas, retry); list.append(node); return row;
          });
          observer = new IntersectionObserver(updateVisible, { root: list });
          rows.forEach(row => observer.observe(row.node)); updateVisible();
        } else {
          const video = /\.(mp4|mov|m4v|webm)(?:[?#]|$)/i.test(url) || local?.type?.startsWith('video/');
          const media = document.createElement(video ? 'video' : 'img');
          if (video) { media.controls = true; media.playsInline = true; }
          else media.alt = item.title || '图片预览';
          media.onerror = () => { status.textContent = '点击重试'; status.onclick = load; };
          media.src = url; list.append(media); status.textContent = video ? '视频' : '1 / 1';
        }
      } catch {
        if (!closed) {
          await destroyPdfDocument(pdf); pdf = null;
          status.textContent = '点击重试'; status.onclick = load;
        }
      }
    }
    load();
  }
  return { open, close: () => closeCurrent?.() };
}
