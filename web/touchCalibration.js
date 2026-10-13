/* Local input is corrected before existing viewport/content transforms. Remote ink
   already uses content coordinates and must never pass through this module. */
(function () {
  'use strict';
  const math = TouchCalibrationMath;
  const storageKey = 'myclass.touchCalibration.v1';
  const byId = id => document.getElementById(id);
  const overlay = byId('touchCalibrationOverlay');
  const surface = byId('touchCalibrationSurface');
  const target = byId('touchCalibrationTarget');
  const message = byId('touchCalibrationMessage');
  const status = byId('touchCalibrationStatus');
  const saveButton = byId('touchCalibrationSave');
  const startButton = byId('touchCalibrationStart');
  const resetButton = byId('touchCalibrationReset');
  const canvas = byId('touchCalibrationPreview');
  let context = { token: null, classId: '', name: '' };
  let generation = 0, profile = null, revision = 0, loading = false, saving = false, loadError = false;
  let candidate = null, samples = [], phase = 'idle', capture = null, previous = null, measured = null;
  const viewport = () => ({ width: innerWidth, height: innerHeight, fullscreen: !!document.fullscreenElement });
  const matches = p => p && p.width === innerWidth && p.height === innerHeight && p.fullscreen === !!document.fullscreenElement;
  function readLocal() {
    try { const p = JSON.parse(localStorage.getItem(storageKey)); return math.validateProfile(p) ? p : null; } catch { return null; }
  }
  function renderStatus() {
    const scope = context.classId ? `班级「${context.name}」· 服务器保存` : '未选择班级 · 仅保存到此浏览器';
    const state = loadError ? '加载失败，请关闭后重新打开重试' : loading ? '正在加载' : profile ? matches(profile) ? '校准已启用' : '显示尺寸或全屏状态已改变，请恢复原显示方式或重新校准' : '尚未校准';
    status.textContent = `${scope}；${state}`;
    byId('touchCalibrationButton').title = status.textContent;
    startButton.disabled = resetButton.disabled = loading || saving;
    saveButton.disabled = loading || saving || !candidate;
  }
  function clearPreview() { canvas.width = innerWidth; canvas.height = innerHeight; previous = null; }
  function idle(text = '建议先进入全屏。请用上课时的触控笔或手指校准，完成后试写并保存。') {
    phase = 'idle'; candidate = null; capture = null; samples = [];
    target.hidden = true; saveButton.hidden = true; startButton.hidden = false;
    resetButton.hidden = false; message.textContent = text; clearPreview(); renderStatus();
  }
  async function request(snapshot, method = 'GET', body) {
    const response = await fetch(`./api/classes/${encodeURIComponent(snapshot.classId)}/touch-calibration`, {
      method, cache: 'no-store', headers: { Authorization: `Bearer ${snapshot.token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '校准数据加载失败');
    return data;
  }
  async function load() {
    const current = ++generation;
    profile = null; revision = 0; loading = !!context.classId; loadError = false; renderStatus();
    try {
      if (context.classId) {
        const data = await request({ ...context });
        if (current !== generation) return;
        profile = math.validateProfile(data.profile) ? data.profile : null; revision = data.revision;
      } else profile = readLocal();
    } catch (error) {
      if (current === generation) {
        loadError = true;
        message.textContent = `${error.message}。请关闭后重新打开重试，当前未应用班级校准。`;
        // Keep saving disabled when the current server revision is unknown.
        return;
      }
    } finally { if (current === generation) { renderStatus(); } }
    if (current === generation) { loading = false; renderStatus(); }
  }
  function setContext(next) {
    if (next.token === context.token && next.classId === context.classId) return;
    context = next; saving = false; idle('班级或教师已切换，请重新开始校准。');
    void load();
  }
  function correctedPoint(event, selected = profile) {
    if (!matches(selected)) return { x: event.clientX, y: event.clientY };
    const p = math.apply(selected.matrix, { x: event.clientX / innerWidth, y: event.clientY / innerHeight });
    return { x: p.x * innerWidth, y: p.y * innerHeight };
  }
  function eventFor(event) {
    const p = correctedPoint(event);
    // Proxy native methods back to their original Event receiver.
    return new Proxy(event, { get(object, key) {
      if (key === 'clientX') return p.x;
      if (key === 'clientY') return p.y;
      const value = Reflect.get(object, key, object);
      return typeof value === 'function' ? value.bind(object) : value;
    } });
  }
  function showTarget() {
    const p = math.targets[samples.length];
    target.style.left = `${p.x * 100}%`; target.style.top = `${p.y * 100}%`; target.hidden = false;
    target.textContent = `${samples.length + 1}`;
    message.textContent = `第 ${samples.length + 1} / 5 点：点击十字中心后抬起，请勿拖动。`;
  }
  byId('touchCalibrationButton').addEventListener('click', () => { overlay.hidden = false; idle(); void load(); });
  function close() { if (!saving) { overlay.hidden = true; idle(); } }
  byId('touchCalibrationClose').addEventListener('click', close);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  byId('touchCalibrationFullscreen').addEventListener('click', async () => {
    try { if (!document.fullscreenElement) await document.documentElement.requestFullscreen(); }
    catch { message.textContent = '无法进入全屏，可按 F11 后重新开始校准。'; }
  });
  startButton.addEventListener('click', () => {
    idle(); measured = viewport(); phase = 'sample'; startButton.hidden = resetButton.hidden = true; showTarget();
  });
  surface.addEventListener('pointerdown', event => {
    if (event.button !== 0 || capture !== null || phase === 'idle') return;
    event.preventDefault(); surface.setPointerCapture(event.pointerId); capture = event.pointerId;
    if (phase === 'sample') previous = { x: event.clientX / innerWidth, y: event.clientY / innerHeight };
    else {
      previous = correctedPoint(event, candidate);
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fbbf24'; ctx.beginPath(); ctx.arc(previous.x, previous.y, 3, 0, Math.PI * 2); ctx.fill();
    }
  });
  surface.addEventListener('pointermove', event => {
    if (capture !== event.pointerId || phase !== 'preview') return;
    event.preventDefault(); const p = correctedPoint(event, candidate), ctx = canvas.getContext('2d');
    ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(previous.x, previous.y); ctx.lineTo(p.x, p.y); ctx.stroke(); previous = p;
  });
  function finish(event) {
    if (capture !== event.pointerId) return;
    capture = null;
    if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId);
    if (phase !== 'sample' || event.type !== 'pointerup') { previous = null; return; }
    if (Math.hypot((event.clientX / innerWidth - previous.x) * innerWidth, (event.clientY / innerHeight - previous.y) * innerHeight) > 20) {
      message.textContent = '请轻点十字中心，不要拖动；当前点需要重试。'; return;
    }
    samples.push(previous); previous = null;
    if (samples.length < 5) { showTarget(); return; }
    try {
      candidate = math.fit(samples, measured); phase = 'preview'; target.hidden = true;
      startButton.hidden = saveButton.hidden = false; clearPreview(); renderStatus();
      message.textContent = '请在空白处试写，确认笔迹跟随触点后点“保存校准”；不准确可重新开始。';
    } catch (error) { idle(error.message); }
  }
  surface.addEventListener('pointerup', finish);
  surface.addEventListener('pointercancel', finish);
  surface.addEventListener('lostpointercapture', finish);
  async function persist(value) {
    const current = generation, snapshot = { ...context };
    saving = true; renderStatus(); byId('touchCalibrationClose').disabled = true;
    try {
      if (snapshot.classId) {
        const data = await request(snapshot, 'PUT', { profile: value, revision });
        if (current !== generation) return;
        revision = data.revision;
      } else if (value) localStorage.setItem(storageKey, JSON.stringify(value));
      else localStorage.removeItem(storageKey);
      if (current !== generation) return;
      profile = value; idle(value ? snapshot.classId ? '校准已保存到班级，下次选择该班级自动启用。' : '校准已保存到此浏览器。' : '已恢复默认触屏坐标。');
    } catch (error) { if (current === generation) message.textContent = `${error.message}。未保存，请重试。`; }
    finally { if (current === generation) saving = false; byId('touchCalibrationClose').disabled = false; renderStatus(); }
  }
  saveButton.addEventListener('click', () => { if (candidate && !loading && !saving) void persist(candidate); });
  resetButton.addEventListener('click', () => {
    if (!loading && !saving && confirm('清除当前班级（未选班级时为本浏览器）的校准，恢复默认坐标？')) void persist(null);
  });
  function resized() {
    if (!overlay.hidden && phase !== 'idle') idle('显示尺寸已改变，请重新开始校准。');
    renderStatus();
  }
  window.addEventListener('resize', resized); document.addEventListener('fullscreenchange', resized);
  window.TouchCalibration = { setContext, eventFor };
  profile = readLocal(); renderStatus();
})();
