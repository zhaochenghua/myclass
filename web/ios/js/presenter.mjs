// 演讲者视图（iPhone / iPad 网页版）：
// 当前页 / 下一页预览、演讲备注（可就地修改）、计时器、页码进度。
//
// 备注来自 PPTX 的 notesSlide，服务器按“原幻灯片编号”返回；动画展开后同一张
// 幻灯片的多页共用一段备注。修改按“课件 ID + 教师账号”保存：同一账号在 Android
// 与 iPad 上看到同一份备注，共享课件不会把一位老师的讲稿串给另一位老师。
// 备注与预览只在手持设备显示，不投到大屏。
//
// 只有当前课件确实带有备注时才显示“演讲”按钮；普通 PDF、链接课件、提取失败的
// 文件不会多出一个空入口。

import { renderPdfPage } from './pdfview.js?v=20261029-pdfcompat';

export function createPresenter({ container, getContext, getSession, getDocument, slideFor, navigate,
  hasVideo, openVideo, getMainPreview }) {
  const style = document.createElement('style');
  style.textContent = `
    .presenter-launch {padding:8px 12px;border:1px solid #64748b;border-radius:8px;background:#1f3a5f;color:white;cursor:pointer;font:inherit;white-space:nowrap}
    .presenter-launch[hidden] {display:none!important}
    .presenter-overlay {position:fixed;left:0;right:0;top:0;height:100%;z-index:1300;background:#060b10;color:#e8edf3;
      display:flex;flex-direction:column;box-sizing:border-box;
      padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}
    .presenter-overlay[hidden] {display:none!important}
    .presenter-head {display:flex;align-items:center;gap:.6rem;padding:.45rem .8rem;flex:0 0 auto}
    .presenter-head h2 {margin:0;font-size:1rem;font-weight:600;white-space:nowrap}
    .presenter-progress {margin:0;color:#94a3b8;font-size:.85rem;flex:1;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .presenter-head button,.presenter-foot button {padding:.45rem .7rem;font:inherit;background:#263b4e;color:#fff;border:1px solid #8ba1b5;border-radius:.5rem;cursor:pointer}
    .presenter-head button:disabled,.presenter-foot button:disabled {opacity:.5;cursor:default}
    .presenter-head .presenter-font-down,.presenter-head .presenter-font-up {padding:.35rem .45rem;font-size:.8rem;line-height:1}
    .presenter-body {flex:1;min-height:0;display:flex;flex-direction:column;gap:.5rem;padding:0 .7rem .2rem}
    .presenter-pane {display:flex;flex-direction:column;min-height:0;background:#0b1620;border-radius:.6rem;padding:.3rem .5rem .5rem;box-sizing:border-box}
    .presenter-caption {margin:0;display:flex;justify-content:space-between;gap:.5rem;color:#94a3b8;font-size:.75rem;flex:0 0 auto}
    .presenter-canvas {flex:1;min-height:0;display:flex;align-items:center;justify-content:center;position:relative;padding-top:.2rem}
    .presenter-canvas canvas {max-width:100%;max-height:100%;width:auto;height:auto;display:block}
    .presenter-hint {margin:0;position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#94a3b8;font-size:.85rem;text-align:center}
    .presenter-hint:empty {display:none!important}
    .presenter-main {flex:1.35}
    .presenter-side {flex:1.7;display:flex;flex-direction:column;gap:.5rem;min-height:0}
    .presenter-next {flex:.42}
    .presenter-notes {flex:1}
    .presenter-notes-head {display:flex;align-items:center;gap:.5rem;flex:0 0 auto}
    .presenter-notes-title {color:#94a3b8;font-size:.75rem;white-space:nowrap}
    .presenter-status {flex:1;text-align:right;font-size:.78rem;color:#94a3b8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .presenter-status.is-error {color:#f87171}
    .presenter-status.is-ok {color:#7dd3fc}
    .presenter-notes-head button {padding:.3rem .6rem;font:inherit;background:#263b4e;color:#fff;border:1px solid #8ba1b5;border-radius:.4rem;cursor:pointer}
    .presenter-notes-head button[hidden] {display:none!important}
    .presenter-notes-head .presenter-video {background:#174b47;border-color:#2f7a73;white-space:nowrap}
    .presenter-note-scroll {flex:1;min-height:0;overflow:auto;margin-top:.3rem;-webkit-overflow-scrolling:touch}
    .presenter-note-scroll[hidden] {display:none!important}
    .presenter-note-text {margin:0;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.5;font-size:1rem}
    .presenter-note-text.is-empty {color:#94a3b8}
    .presenter-note-editor {flex:1;min-height:0;width:100%;box-sizing:border-box;margin-top:.3rem;resize:none;
      background:#0b141c;color:#e8edf3;border:1px solid #3c4a5c;border-radius:.4rem;padding:.5rem;font:inherit;line-height:1.5}
    .presenter-note-editor[hidden] {display:none!important}
    .presenter-foot {flex:0 0 auto;display:flex;align-items:center;gap:.4rem;padding:.35rem .7rem}
    .presenter-foot .presenter-prev,.presenter-foot .presenter-next-page {flex:1;min-width:0}
    .presenter-foot .presenter-next-page {background:#1d4ed8;border-color:#1d4ed8}
    .presenter-timer {min-width:4.2rem;text-align:center;font-variant-numeric:tabular-nums;font-size:1rem;white-space:nowrap}
    .presenter-progressbar {flex:0 0 auto;height:3px;background:#1a2230}
    .presenter-progressbar i {display:block;height:100%;width:0;background:#4da6ff;transition:width .2s}
    .presenter-overlay.is-editing .presenter-main,
    .presenter-overlay.is-editing .presenter-next {display:none}
    .presenter-overlay.is-editing .presenter-notes {flex:1}
    @media (orientation: landscape) {
      .presenter-body {flex-direction:row}
      .presenter-main {flex:3}
      .presenter-side {flex:2}
      .presenter-next {flex:0 0 34%}
    }
  `;
  document.head.append(style);

  const launch = document.createElement('button');
  launch.type = 'button';
  launch.className = 'presenter-launch';
  launch.textContent = '演讲';
  launch.hidden = true;
  container.append(launch);

  const overlay = document.createElement('div');
  overlay.className = 'presenter-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `<header class="presenter-head">
      <h2>演讲者视图</h2>
      <p class="presenter-progress"></p>
      <button type="button" class="presenter-font-down" aria-label="减小备注字号">A−</button>
      <button type="button" class="presenter-font-up" aria-label="增大备注字号">A+</button>
      <button type="button" class="presenter-close">关闭</button>
    </header>
    <div class="presenter-body">
      <section class="presenter-pane presenter-main">
        <p class="presenter-caption"><span>当前页</span><span class="presenter-main-page"></span></p>
        <div class="presenter-canvas"><canvas class="presenter-current"></canvas><p class="presenter-hint presenter-current-hint">正在加载预览…</p></div>
      </section>
      <div class="presenter-side">
        <section class="presenter-pane presenter-next">
          <p class="presenter-caption"><span>下一页</span><span class="presenter-next-caption"></span></p>
          <div class="presenter-canvas"><canvas class="presenter-next-canvas"></canvas><p class="presenter-hint presenter-next-hint"></p></div>
        </section>
        <section class="presenter-pane presenter-notes">
          <div class="presenter-notes-head">
            <span class="presenter-notes-title">演讲备注</span>
            <span class="presenter-status" role="status"></span>
            <button type="button" class="presenter-video" hidden>本页视频</button>
            <button type="button" class="presenter-edit">编辑</button>
            <button type="button" class="presenter-cancel" hidden>取消</button>
          </div>
          <div class="presenter-note-scroll"><p class="presenter-note-text"></p></div>
          <textarea class="presenter-note-editor" hidden aria-label="本页备注" placeholder="输入本页备注；只给老师看，不会投到大屏"></textarea>
        </section>
      </div>
    </div>
    <footer class="presenter-foot">
      <button type="button" class="presenter-prev">上一页</button>
      <span class="presenter-timer">00:00</span>
      <button type="button" class="presenter-pause">暂停</button>
      <button type="button" class="presenter-reset">重置</button>
      <button type="button" class="presenter-next-page">下一页</button>
    </footer>
    <div class="presenter-progressbar"><i></i></div>`;
  document.body.append(overlay);

  const nodes = {
    progress: overlay.querySelector('.presenter-progress'),
    fontDown: overlay.querySelector('.presenter-font-down'),
    fontUp: overlay.querySelector('.presenter-font-up'),
    close: overlay.querySelector('.presenter-close'),
    mainCaption: overlay.querySelector('.presenter-main-page'),
    nextCaption: overlay.querySelector('.presenter-next-caption'),
    currentCanvas: overlay.querySelector('.presenter-current'),
    nextCanvas: overlay.querySelector('.presenter-next-canvas'),
    currentHint: overlay.querySelector('.presenter-current-hint'),
    nextHint: overlay.querySelector('.presenter-next-hint'),
    status: overlay.querySelector('.presenter-status'),
    video: overlay.querySelector('.presenter-video'),
    edit: overlay.querySelector('.presenter-edit'),
    cancel: overlay.querySelector('.presenter-cancel'),
    noteScroll: overlay.querySelector('.presenter-note-scroll'),
    noteText: overlay.querySelector('.presenter-note-text'),
    editor: overlay.querySelector('.presenter-note-editor'),
    timer: overlay.querySelector('.presenter-timer'),
    pause: overlay.querySelector('.presenter-pause'),
    reset: overlay.querySelector('.presenter-reset'),
    prev: overlay.querySelector('.presenter-prev'),
    next: overlay.querySelector('.presenter-next-page'),
    bar: overlay.querySelector('.presenter-progressbar i')
  };

  const EMPTY_HINT = '本页没有备注。点“编辑”可以添加，磨课时随时修改。';

  // 备注字号四档，选择保存在本机（换课件/重新打开演讲者视图后保持）
  const NOTE_FONT_KEY = 'myclass.ios.presenterNoteSize';
  const NOTE_FONT_SIZES = ['0.875rem', '1rem', '1.125rem', '1.25rem'];
  let noteFontIndex = (() => {
    try {
      const raw = localStorage.getItem(NOTE_FONT_KEY);
      // Number(null) 是 0，必须先排除没存过的情况，否则默认字号会变成最小档
      const parsed = raw === null ? Number.NaN : Number(raw);
      return Number.isInteger(parsed) && parsed >= 0 && parsed < NOTE_FONT_SIZES.length ? parsed : 1;
    } catch { return 1; }
  })();

  function applyNoteFont() {
    const size = NOTE_FONT_SIZES[noteFontIndex];
    nodes.noteText.style.fontSize = size;
    nodes.editor.style.fontSize = size;
    nodes.fontDown.disabled = noteFontIndex <= 0;
    nodes.fontUp.disabled = noteFontIndex >= NOTE_FONT_SIZES.length - 1;
  }

  function changeNoteFont(delta) {
    const next = Math.min(Math.max(0, noteFontIndex + delta), NOTE_FONT_SIZES.length - 1);
    if (next === noteFontIndex) return;
    noteFontIndex = next;
    try { localStorage.setItem(NOTE_FONT_KEY, String(noteFontIndex)); } catch { /* 隐私模式忽略 */ }
    applyNoteFont();
  }

  let context = null;
  let deck = '';
  let queriedId = '';
  let notes = new Map();
  let open = false;
  let editing = false;
  let saving = false;
  let previousFocus = null;
  let drawBusy = false;
  let drawPending = false;
  let drawToken = 0;
  let drawnPage = 0;
  let drawnDoc = null;
  const timer = { url: '', accumulated: 0, startedAt: 0, running: false };

  const coursewareId = url => {
    try {
      const path = new URL(url, location.href).pathname;
      if (!/\.pdf$/i.test(path)) return '';
      const id = path.slice(path.lastIndexOf('/') + 1).replace(/\.pdf$/i, '');
      return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id) ? id : '';
    } catch { return ''; }
  };
  const pageOf = () => Math.max(1, Number(context?.page) || 1);
  const totalOf = () => Math.max(1, Number(context?.pageCount) || 1);
  const slideOf = () => (Number(context?.slide) >= 1 ? Number(context.slide) : pageOf());
  const endpoint = id => `${String(getSession?.()?.apiBase || '').replace(/\/+$/, '')}/courseware/${encodeURIComponent(id)}/notes`;
  const authHeaders = () => {
    const token = getSession?.()?.token;
    return token ? { Authorization: `Bearer ${token}` } : null;
  };

  // ---------------------------------------------------------------- 备注数据

  async function loadNotes(id) {
    const headers = authHeaders();
    if (!headers) { queriedId = ''; return; }
    try {
      const response = await fetch(endpoint(id), { headers, cache: 'no-store' });
      if (queriedId !== id) return;
      if (!response.ok) { deck = ''; notes = new Map(); return; }
      const data = await response.json();
      if (queriedId !== id) return;
      if (data?.supported && Array.isArray(data.slides)) {
        deck = id;
        notes = new Map(data.slides
          .filter(note => Number.isInteger(note?.slide) && note.slide >= 1 && typeof note?.text === 'string' && note.text.trim())
          .map(note => [note.slide, note.text.trim()]));
      } else {
        deck = '';
        notes = new Map();
      }
    } catch {
      if (queriedId !== id) return;
      deck = '';
      notes = new Map();
    }
  }

  function renderNoteText() {
    if (!nodes.noteText) return;
    const text = notes.get(slideOf()) || '';
    const value = text || EMPTY_HINT;
    if (nodes.noteText.textContent !== value) nodes.noteText.textContent = value;
    nodes.noteText.classList.toggle('is-empty', !text);
  }

  function setStatus(text, tone = '') {
    nodes.status.textContent = text;
    nodes.status.classList.toggle('is-error', tone === 'error');
    nodes.status.classList.toggle('is-ok', tone === 'ok');
  }

  // 主循环每 350ms 跑一次：内容没变就不要重写 DOM，避免无谓的重排。
  function setText(node, value) {
    if (node && node.textContent !== value) node.textContent = value;
  }

  // ---------------------------------------------------------------- 计时器

  function elapsedMs() {
    return timer.accumulated + (timer.running ? performance.now() - timer.startedAt : 0);
  }
  function formatTimer() {
    const total = Math.max(0, Math.floor(elapsedMs() / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const pad = value => String(value).padStart(2, '0');
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
  }
  function timerStartIfNeeded(url) {
    if (timer.url !== url) {
      timer.url = url;
      timer.accumulated = 0;
      timer.startedAt = 0;
      timer.running = false;
    }
    if (!timer.running && timer.accumulated === 0) {
      timer.startedAt = performance.now();
      timer.running = true;
    }
  }

  // ---------------------------------------------------------------- 预览渲染

  // 预览缓存：page -> { doc, canvas }。老师来回翻页时不用重新渲染；
  // 当前页若主界面已经渲染好，直接按比例复制那张 canvas，省掉一次完整渲染。
  const PREVIEW_CACHE_LIMIT = 4;
  const previewCache = new Map();
  let previewUrl = '';
  let drawBlockedUntil = 0;

  function cachePreview(page, doc, canvas) {
    previewCache.set(page, { doc, canvas });
    while (previewCache.size > PREVIEW_CACHE_LIMIT) {
      previewCache.delete(previewCache.keys().next().value);
    }
  }

  function cachedPreview(page, doc) {
    const hit = previewCache.get(page);
    return hit && hit.doc === doc ? hit.canvas : null;
  }

  function clearCanvas(canvas) {
    if (!canvas.width || !canvas.height) return;
    canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
  }

  /** 把源画布按 maxEdge 等比缩放画到目标画布（白底，与主界面一致） */
  function paint(target, source, maxEdge) {
    const longest = Math.max(source.width, source.height) || 1;
    const scale = Math.min(1, maxEdge / longest);
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));
    if (target.width !== width) target.width = width;
    if (target.height !== height) target.height = height;
    const context = target.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(source, 0, 0, width, height);
  }

  async function ensurePreview(page, doc, maxEdge) {
    const cached = cachedPreview(page, doc);
    if (cached) return cached;
    const main = getMainPreview?.();
    if (main && main.page === page && !main.rendering && main.canvas?.width && !main.canvas.hidden) {
      const copy = document.createElement('canvas');
      paint(copy, main.canvas, maxEdge);
      cachePreview(page, doc, copy);
      return copy;
    }
    const canvas = document.createElement('canvas');
    await renderPdfPage(doc, page, canvas, maxEdge);
    cachePreview(page, doc, canvas);
    return canvas;
  }

  function retryDrawLater() {
    drawBlockedUntil = Date.now() + 1200;
    setTimeout(() => { if (open) requestDraw(); }, 1200);
  }

  async function drawPreviews() {
    if (!open) return;
    if (drawBusy) { drawPending = true; return; }
    const token = ++drawToken;
    const page = pageOf();
    const total = totalOf();
    const doc = getDocument?.();
    if (!doc) {
      nodes.currentHint.textContent = '正在加载预览…';
      nodes.nextHint.textContent = '';
      retryDrawLater();
      return;
    }
    drawBusy = true;
    try {
      nodes.currentHint.textContent = '正在渲染…';
      nodes.nextHint.textContent = '';
      const current = await ensurePreview(page, doc, 1200);
      if (token !== drawToken || !open) return;
      paint(nodes.currentCanvas, current, 1200);
      nodes.currentHint.textContent = '';
      if (page < total) {
        const next = await ensurePreview(page + 1, doc, 800);
        if (token !== drawToken || !open) return;
        paint(nodes.nextCanvas, next, 800);
        nodes.nextHint.textContent = '';
      } else {
        clearCanvas(nodes.nextCanvas);
        nodes.nextHint.textContent = '已是最后一页';
      }
      drawnPage = page;
      drawnDoc = doc;
      drawBlockedUntil = 0;
    } catch {
      if (token !== drawToken || !open) return;
      nodes.currentHint.textContent = '预览加载中…';
      retryDrawLater();
    } finally {
      drawBusy = false;
      if (drawPending && open) {
        drawPending = false;
        void drawPreviews();
      }
    }
  }

  function requestDraw() {
    if (!open) return;
    if (Date.now() < drawBlockedUntil) return;
    if (drawBusy) { drawPending = true; return; }
    void drawPreviews();
  }

  // ---------------------------------------------------------------- 打开/关闭

  function syncViewport() {
    if (!open) { overlay.style.height = ''; overlay.style.top = ''; return; }
    const vv = window.visualViewport;
    if (!vv) return;
    overlay.style.height = `${vv.height}px`;
    overlay.style.top = `${vv.offsetTop}px`;
  }

  function refreshOpen() {
    if (!open || !context) return;
    const page = pageOf();
    const total = totalOf();
    const totalSlides = Math.max(1, Number(context.slideTotal) || slideOf());
    setText(nodes.progress, `第 ${Math.min(slideOf(), totalSlides)} / ${totalSlides} 页`);
    const width = `${total > 1 ? ((page - 1) / (total - 1)) * 100 : 0}%`;
    if (nodes.bar.style.width !== width) nodes.bar.style.width = width;
    const currentSlide = Number(slideFor?.(page)) || slideOf();
    setText(nodes.mainCaption, `第 ${currentSlide} 页`);
    setText(nodes.nextCaption, page < total ? `第 ${Number(slideFor?.(page + 1)) || page + 1} 页` : '');
    if (!editing) renderNoteText();
    setText(nodes.timer, formatTimer());
    setText(nodes.pause, timer.running ? '暂停' : '继续');
    // 当前幻灯片有内嵌视频时才出现“本页视频”；编辑备注时收起，给输入框让位。
    const canVideo = !editing && Boolean(hasVideo?.(slideOf()));
    if (nodes.video.hidden === canVideo) nodes.video.hidden = !canVideo;
    const nextDoc = getDocument?.();
    if (page !== drawnPage || nextDoc !== drawnDoc) requestDraw();
  }

  function show() {
    if (open) return;
    const ctx = getContext();
    if (!ctx) return;
    context = ctx;
    timerStartIfNeeded(ctx.url);
    open = true;
    editing = false;
    previousFocus = document.activeElement;
    overlay.hidden = false;
    overlay.classList.remove('is-editing');
    nodes.editor.hidden = true;
    nodes.noteScroll.hidden = false;
    nodes.edit.textContent = '编辑';
    nodes.cancel.hidden = true;
    nodes.edit.disabled = false;
    nodes.cancel.disabled = false;
    setStatus('');
    drawnPage = 0;
    drawnDoc = null;
    drawBlockedUntil = 0;
    syncViewport();
    refreshOpen();
    nodes.close.focus();
  }

  function close() {
    if (!open) return;
    open = false;
    editing = false;
    drawToken++;
    overlay.hidden = true;
    overlay.classList.remove('is-editing');
    overlay.style.height = '';
    overlay.style.top = '';
    previousFocus?.focus?.();
    previousFocus = null;
    updateButton();
  }

  function go(delta) {
    if (editing || saving || !open) return;
    const page = pageOf();
    const target = Math.min(Math.max(1, page + delta), totalOf());
    if (target === page) return;
    navigate?.(target);
    // 主流程会同步更新 state.courseware.page，紧接着重画即可
    context = getContext() || context;
    setStatus('');
    drawnPage = 0;
    refreshOpen();
  }

  // ---------------------------------------------------------------- 备注编辑

  function enterEdit() {
    if (editing || saving) return;
    editing = true;
    overlay.classList.add('is-editing');
    nodes.editor.value = notes.get(slideOf()) || '';
    nodes.editor.hidden = false;
    nodes.noteScroll.hidden = true;
    nodes.edit.textContent = '保存';
    nodes.cancel.hidden = false;
    setStatus('');
    nodes.editor.focus();
    nodes.editor.setSelectionRange(nodes.editor.value.length, nodes.editor.value.length);
  }

  function exitEdit() {
    editing = false;
    overlay.classList.remove('is-editing');
    nodes.editor.hidden = true;
    nodes.noteScroll.hidden = false;
    nodes.edit.textContent = '编辑';
    nodes.cancel.hidden = true;
    renderNoteText();
    nodes.editor.blur();
  }

  async function saveNote() {
    if (saving || !deck) return;
    const headers = authHeaders();
    if (!headers) { setStatus('登录已过期，请重新登录后再修改备注', 'error'); return; }
    const slide = slideOf();
    saving = true;
    nodes.edit.disabled = true;
    nodes.cancel.disabled = true;
    setStatus('正在保存…');
    try {
      const response = await fetch(endpoint(deck), {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ slide, text: nodes.editor.value })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || `保存失败：HTTP ${response.status}`);
      const text = (typeof data?.text === 'string' ? data.text : nodes.editor.value).trim();
      if (text) notes.set(slide, text); else notes.delete(slide);
      exitEdit();
      setStatus('已保存', 'ok');
      updateButton();
    } catch (error) {
      setStatus(error?.message || '备注保存失败，请检查网络后重试', 'error');
    } finally {
      saving = false;
      nodes.edit.disabled = false;
      nodes.cancel.disabled = false;
    }
  }

  // ---------------------------------------------------------------- 事件

  launch.addEventListener('click', show);
  nodes.close.addEventListener('click', close);
  nodes.prev.addEventListener('click', () => go(-1));
  nodes.next.addEventListener('click', () => go(1));
  nodes.pause.addEventListener('click', () => {
    if (timer.running) {
      timer.accumulated = elapsedMs();
      timer.running = false;
    } else {
      timer.startedAt = performance.now();
      timer.running = true;
    }
    refreshOpen();
  });
  nodes.reset.addEventListener('click', () => {
    timer.accumulated = 0;
    timer.startedAt = performance.now();
    timer.running = true;
    refreshOpen();
  });
  nodes.edit.addEventListener('click', () => { if (editing) void saveNote(); else enterEdit(); });
  nodes.cancel.addEventListener('click', () => { if (!saving) exitEdit(); });
  nodes.video.addEventListener('click', () => { if (!editing && !saving) openVideo?.(); });
  nodes.fontDown.addEventListener('click', () => changeNoteFont(-1));
  nodes.fontUp.addEventListener('click', () => changeNoteFont(1));
  overlay.addEventListener('keydown', event => {
    // 翻页快捷键挂在 document 上，弹窗内按键不能顺带翻页。
    event.stopPropagation();
    if (event.key === 'Escape' && !saving) {
      if (editing) exitEdit(); else close();
    }
    if (event.key === 'Tab' && !editing) {
      const focusable = [nodes.close, nodes.prev, nodes.pause, nodes.reset, nodes.next, nodes.edit, nodes.cancel]
        .filter(node => !node.hidden && !node.disabled);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  window.visualViewport?.addEventListener('resize', syncViewport);
  window.visualViewport?.addEventListener('scroll', syncViewport);

  // ---------------------------------------------------------------- 主循环

  function updateButton() {
    const visible = notes.size > 0;
    if (launch.hidden === visible) launch.hidden = !visible;
  }

  function update() {
    const next = getContext();
    const id = next?.url ? coursewareId(next.url) : '';
    const url = next?.url || '';
    context = next;
    // 换课件时丢弃上一份课件的预览缓存（同一个课件关掉再开仍复用）。
    if (url !== previewUrl) {
      previewUrl = url;
      previewCache.clear();
    }
    if (!id) {
      queriedId = '';
      if (deck || notes.size) { deck = ''; notes = new Map(); }
      if (open) close();
      updateButton();
      return;
    }
    if (id !== queriedId) {
      queriedId = id;
      void loadNotes(id);
    }
    updateButton();
    if (open) refreshOpen();
  }

  const ticker = setInterval(update, 350);
  applyNoteFont();
  update();

  return {
    destroy() {
      clearInterval(ticker);
      drawToken++;
      close();
      overlay.remove();
      launch.remove();
      style.remove();
      window.visualViewport?.removeEventListener('resize', syncViewport);
      window.visualViewport?.removeEventListener('scroll', syncViewport);
    }
  };
}
