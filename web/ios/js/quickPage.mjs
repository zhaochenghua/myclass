import { renderPdfPage } from './pdfview.js?v=20261012-ios3';
import { slideEntries, slidePage, slideCount } from './coursewarePages.mjs?v=20261022-reader';

export function createQuickPagePicker({ root, getCourseware, getPdf, isConnected, onSelect, onUnavailable }) {
  let closeCurrent = null;
  function open() {
    closeCurrent?.();
    const cw = getCourseware(), pdf = getPdf();
    if (!isConnected() || !cw || !pdf) { onUnavailable(); return; }
    const pages = slideEntries(cw.mapping, pdf.numPages);
    const focus = document.activeElement;
    const modal = document.createElement('div'); modal.className = 'quick-page-modal';
    const panel = document.createElement('section'); panel.className = 'quick-page-panel';
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-label', '快速翻页');
    const label = document.createElement('p'); label.className = 'quick-page-label';
    const preview = document.createElement('div'); preview.className = 'quick-page-preview';
    const slider = document.createElement('input'); slider.type = 'range'; slider.min = 0; slider.max = pages.length - 1;
    slider.step = 1; slider.value = Math.max(0, pages.findIndex(page => page.slide === slidePage(cw)));
    slider.setAttribute('aria-label', '快速翻页进度');
    const cancel = document.createElement('button'); cancel.className = 'pill quick-page-cancel'; cancel.textContent = '取消';
    panel.append(label, preview, slider, cancel); modal.append(panel); root.append(modal);
    let closed = false, rendering = false, revision = 0;
    function close() {
      if (closed) return;
      closed = true; revision++;
      modal.querySelectorAll('canvas').forEach(canvas => { canvas.width = canvas.height = 0; });
      document.removeEventListener('keydown', keydown, true);
      modal.remove(); if (focus?.isConnected) focus.focus({ preventScroll: true });
      if (closeCurrent === close) closeCurrent = null;
    }
    function keydown(event) {
      if (event.key === 'Escape') { event.stopImmediatePropagation(); event.preventDefault(); close(); }
      if (event.key === 'Tab') {
        event.preventDefault(); (document.activeElement === slider ? cancel : slider).focus();
      }
    }
    async function render() {
      if (rendering || closed) return;
      rendering = true;
      const current = revision, page = pages[Number(slider.value)];
      const canvas = document.createElement('canvas');
      try {
        await renderPdfPage(pdf, page.last, canvas, 1600);
        if (!closed && current === revision) { canvas.setAttribute('aria-label', `第 ${page.slide} 页预览`); preview.replaceChildren(canvas); }
        else canvas.width = canvas.height = 0;
      } catch { if (!closed && current === revision) preview.textContent = '预览暂不可用'; }
      finally { rendering = false; if (!closed && current !== revision) render(); }
    }
    function refresh() {
      revision++;
      const page = pages[Number(slider.value)];
      label.textContent = `第 ${page.slide} / ${slideCount(cw)} 页 · 松手投屏`;
      slider.setAttribute('aria-valuetext', `第 ${page.slide} 页`);
      preview.replaceChildren(); render();
    }
    slider.addEventListener('input', refresh);
    slider.addEventListener('change', () => {
      const page = pages[Number(slider.value)]; close();
      if (isConnected() && getCourseware() === cw && getPdf() === pdf) onSelect(page.first);
    });
    slider.addEventListener('pointercancel', close);
    cancel.onclick = close; modal.onclick = event => { if (event.target === modal) close(); };
    document.addEventListener('keydown', keydown, true); closeCurrent = close;
    slider.focus(); refresh();
  }
  return { open, close: () => closeCurrent?.() };
}
