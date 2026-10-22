// PDF.js link annotations for converted PPTX/PDF pages.
// LibreOffice keeps PPTX hyperlinks as PDF annotations, so the rendered page
// can expose the original clickable regions without parsing PPTX coordinates.

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function pageTarget(annotation) {
  if (!annotation || annotation.subtype !== 'Link') return null;
  const url = typeof annotation.url === 'string' ? annotation.url.trim() : '';
  if (/^https?:\/\//i.test(url)) return { kind: 'external', url };
  if (annotation.dest != null) return { kind: 'internal', dest: annotation.dest };
  return null;
}

/**
 * Creates a link overlay for one rendered PDF page.
 * The overlay follows the rendered surface's bounding rectangle, including
 * the zoom/pan transform used by both the large-screen and iOS viewers.
 */
export function createCoursewareLinks({ container, getSurface, getDocument, onExternal, onInternal,
  getRect = element => element.getBoundingClientRect() }) {
  let entries = [];
  let generation = 0;
  let interactive = true;

  function clear() {
    generation += 1;
    entries = [];
    container.replaceChildren();
    container.hidden = true;
  }

  function update() {
    const surface = getSurface?.();
    if (!surface || surface.hidden || entries.length === 0) {
      container.hidden = true;
      return;
    }
    const host = container.parentElement;
    const surfaceRect = getRect(surface);
    const hostRect = host && getRect(host);
    if (!hostRect || surfaceRect.width <= 0 || surfaceRect.height <= 0) {
      container.hidden = true;
      return;
    }
    container.hidden = false;
    container.style.left = `${surfaceRect.left - hostRect.left}px`;
    container.style.top = `${surfaceRect.top - hostRect.top}px`;
    container.style.width = `${surfaceRect.width}px`;
    container.style.height = `${surfaceRect.height}px`;
    container.style.pointerEvents = interactive ? 'none' : 'none';
    for (const entry of entries) {
      entry.element.style.left = `${entry.left * 100}%`;
      entry.element.style.top = `${entry.top * 100}%`;
      entry.element.style.width = `${entry.width * 100}%`;
      entry.element.style.height = `${entry.height * 100}%`;
      entry.element.style.pointerEvents = interactive ? 'auto' : 'none';
    }
  }

  async function render(pageNumber) {
    clear();
    const pdfDocument = getDocument?.();
    const surface = getSurface?.();
    if (!pdfDocument || !surface) return;
    const current = generation;
    try {
      const page = await pdfDocument.getPage(Math.max(1, Math.round(Number(pageNumber) || 1)));
      const annotations = await page.getAnnotations({ intent: 'display' });
      if (current !== generation || getDocument?.() !== pdfDocument || !getSurface?.()) return;
      const base = page.getViewport({ scale: 1 });
      if (!base.width || !base.height) return;
      const targets = [];
      for (const annotation of annotations || []) {
        const target = pageTarget(annotation);
        if (!target || !Array.isArray(annotation.rect) || annotation.rect.length < 4) continue;
        const rect = page.getViewport({ scale: 1 }).convertToViewportRectangle(annotation.rect);
        const left = clamp(Math.min(rect[0], rect[2]) / base.width, 0, 1);
        const top = clamp(Math.min(rect[1], rect[3]) / base.height, 0, 1);
        const right = clamp(Math.max(rect[0], rect[2]) / base.width, 0, 1);
        const bottom = clamp(Math.max(rect[1], rect[3]) / base.height, 0, 1);
        if (right - left < 0.002 || bottom - top < 0.002) continue;
        const link = globalThis.document.createElement('a');
        link.className = 'courseware-link-hit';
        link.href = target.kind === 'external' ? target.url : '#';
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.setAttribute('aria-label', target.kind === 'external' ? `打开链接 ${target.url}` : '跳转到课件页面');
        link.title = target.kind === 'external' ? '打开链接' : '跳转到课件页面';
        link.addEventListener('click', async event => {
          event.preventDefault();
          if (!interactive) return;
          if (target.kind === 'external') {
            onExternal?.(target.url);
            return;
          }
          let destination = target.dest;
          try {
            if (typeof destination === 'string') destination = await pdfDocument.getDestination(destination);
            const ref = Array.isArray(destination) ? destination[0] : null;
            const index = ref && typeof ref === 'object' ? await pdfDocument.getPageIndex(ref) : Number(ref);
            if (Number.isFinite(index) && index >= 0) onInternal?.(index + 1);
          } catch {
            /* An invalid internal destination should not break page playback. */
          }
        });
        container.appendChild(link);
        targets.push({ element: link, left, top, width: right - left, height: bottom - top });
      }
      if (current !== generation) return;
      entries = targets;
      update();
    } catch {
      if (current === generation) clear();
    }
  }

  function setInteractive(value) {
    interactive = value !== false;
    update();
  }

  return { clear, render, update, setInteractive };
}
