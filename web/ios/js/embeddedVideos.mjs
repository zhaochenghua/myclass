// A separate player never changes the PDF document, viewport or annotations.
export function createEmbeddedVideos({ container, getContext, send, remote = false }) {
  const style = document.createElement('style');
  style.textContent = `
    .embedded-launch {padding:8px 12px;border:1px solid #64748b;border-radius:8px;background:#174b47;color:white;cursor:pointer;font:inherit;white-space:nowrap}
    .embedded-overlay {position:fixed;inset:0;z-index:1200;background:#000e;display:flex;align-items:center;justify-content:center;padding:12px;box-sizing:border-box}
    .embedded-overlay[hidden],.embedded-launch[hidden] {display:none!important}
    /* 大屏投影时学生离得远，播放窗口尽量铺满：原来固定 1100px 宽，在 1920 的投影上只占一半 */
    .embedded-card {width:min(96vw,1800px);max-height:100%;overflow:auto;background:#111c26;color:white;padding:12px;border-radius:12px;box-sizing:border-box}
    .embedded-card video {display:block;position:relative;inset:auto;width:100%;height:auto;max-height:78dvh;object-fit:contain;background:black;transform:none}
    .embedded-card video[hidden] {display:none}
    .embedded-actions {display:flex;gap:10px;flex-wrap:wrap;margin-top:12px}
    .embedded-card button {padding:10px 16px;font:inherit;background:#263b4e;color:white;border:1px solid #8ba1b5;border-radius:8px;cursor:pointer}
    .embedded-card p {margin:10px 0;overflow-wrap:anywhere}
  `;
  document.head.append(style);
  const launch = document.createElement('button'); launch.className = 'embedded-launch'; launch.type = 'button'; launch.hidden = true;
  container.append(launch);
  const overlay = document.createElement('div'); overlay.className = 'embedded-overlay'; overlay.hidden = true;
  overlay.innerHTML = `<section class="embedded-card" role="dialog" aria-modal="true" aria-label="课件内嵌视频">
    <p class="embedded-title"></p><div class="embedded-choices embedded-actions"></div>
    <video playsinline controls preload="metadata" hidden></video><p class="embedded-status" role="status"></p>
    <div class="embedded-actions embedded-controls"></div>
    <div class="embedded-actions"><button type="button" class="embedded-close">返回课件</button></div></section>`;
  document.body.append(overlay);
  const video = overlay.querySelector('video'), status = overlay.querySelector('.embedded-status'), title = overlay.querySelector('.embedded-title');
  const choices = overlay.querySelector('.embedded-choices'), controls = overlay.querySelector('.embedded-controls');
  let context = null, metadata = null, generation = 0, active = null, previousFocus = null, warning = '', pending = null;
  const sameUrl = (a, b) => { try { return new URL(a, location.href).href === new URL(b, location.href).href; } catch { return false; } };
  const slide = () => metadata?.conversion?.statePages?.[(context?.page || 1) - 1] || context?.slide || context?.page || 1;
  const available = () => (metadata?.videos || []).filter(v => v.slide === slide());
  function signal(action, index = active?.index) {
    return send({ type: remote ? 'courseware.embedded-video' : 'viewer.embedded-video', action, url: context?.url, index });
  }
  function show() { if (overlay.hidden) previousFocus = document.activeElement; overlay.hidden = false; overlay.querySelector('.embedded-close').focus(); }
  function close(notify = false) {
    if (overlay.hidden && !active) return;
    if (notify && active) signal('close');
    active = null; overlay.hidden = true; video.pause(); video.removeAttribute('src'); video.load(); video.hidden = true;
    choices.replaceChildren(); controls.replaceChildren(); previousFocus?.focus(); previousFocus = null;
  }
  function button(text, fn, parent = controls) { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.onclick = fn; parent.append(b); }
  function start(item, notify = true) {
    close(false); active = item; show(); title.textContent = item.title; status.textContent = '';
    if (remote) {
      status.textContent = '正在大屏播放，可在这里控制；若大屏提示，请点击大屏播放按钮。';
      for (const [text, action] of [['播放', 'play'], ['暂停', 'pause'], ['后退 10 秒', 'back'], ['前进 10 秒', 'forward']]) button(text, () => signal(action));
      if (notify && signal('open', item.index) === false) status.textContent = '尚未连接大屏，请连接后重试。';
    } else {
      video.hidden = false; video.src = item.url;
      video.play().catch(() => { if (active) status.textContent = '请点击视频上的播放按钮开始播放。'; });
      signal('open', item.index);
    }
  }
  launch.onclick = () => {
    const list = available();
    if (!list.length) { show(); title.textContent = '内嵌视频'; status.textContent = warning || '当前页没有可播放的视频。'; return; }
    if (list.length === 1) start(list[0]);
    else { show(); title.textContent = '选择本页视频'; status.textContent = ''; choices.replaceChildren(); list.forEach(item => button(item.title, () => start(item), choices)); }
  };
  overlay.querySelector('.embedded-close').onclick = () => close(true);
  overlay.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Escape') close(true);
    if (event.key === 'Tab') {
      const nodes = [...overlay.querySelectorAll('button')], first = nodes[0], last = nodes.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  video.addEventListener('ended', () => close(true));
  video.addEventListener('error', () => { if (active) status.textContent = '视频暂时无法播放。请检查网络；若原视频为 WMV/AVI 或特殊编码，请在 PPTX 中替换为 H.264/AAC 编码的 MP4 后重新上传。'; });
  async function update() {
    const next = getContext();
    if (!next?.url || (context && (!sameUrl(next.url, context.url) || next.page !== context.page))) close(!remote);
    if (!next?.url) { context = null; metadata = null; generation++; launch.hidden = true; return; }
    const changed = !context || !sameUrl(next.url, context.url);
    context = { ...next };
    if (changed) {
      const epoch = ++generation; metadata = null; warning = ''; launch.hidden = true;
      try {
        const endpoint = new URL(next.url, location.href); endpoint.pathname += '.metadata'; endpoint.searchParams.set('embedded', '1');
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 120000);
        let response;
        try { response = await fetch(endpoint, { signal: controller.signal }); } finally { clearTimeout(timer); }
        if (!response.ok) {
          // 404 = 这个文件本来就没有内嵌视频的元数据（图片、压缩包、未登记的旧课件），
          // 属于正常情况：不提示、不显示按钮，而不是当成"加载失败"。
          if (response.status === 404) { if (epoch !== generation) return; metadata = { videos: [] }; }
          else throw new Error('metadata');
        } else {
          const data = await response.json(); if (epoch !== generation) return;
          metadata = data; warning = data.videoWarning || '';
        }
      } catch { if (epoch !== generation) return; warning = '视频信息加载失败，请重新打开课件后重试。'; }
    }
    const count = available().length;
    launch.hidden = !count && !warning;
    launch.textContent = count ? `▶ 本页视频${count > 1 ? `（${count}）` : ''}` : '视频信息';
    if (pending && metadata) { const message = pending; pending = null; receive(message); }
  }
  const timer = setInterval(() => void update(), 350); void update();
  function receive(message) {
      if (!context || !metadata) { pending = message; return; }
      if (!sameUrl(message.url, context.url)) return;
      if (message.action === 'close') { close(false); return; }
      if (message.action === 'open') {
        const item = available().find(v => v.index === message.index);
        if (item) start(item, false);
      } else if (!remote && active && (message.index == null || message.index === active.index)) {
        if (message.action === 'play') video.play().catch(() => { status.textContent = '请点击大屏视频播放按钮。'; });
        if (message.action === 'pause') video.pause();
        if (message.action === 'back') video.currentTime = Math.max(0, video.currentTime - 10);
        if (message.action === 'forward' && Number.isFinite(video.duration)) video.currentTime = Math.min(video.duration, video.currentTime + 10);
      }
    }
  return {
    receive,
    destroy() { clearInterval(timer); generation++; close(false); overlay.remove(); launch.remove(); style.remove(); }
  };
}
