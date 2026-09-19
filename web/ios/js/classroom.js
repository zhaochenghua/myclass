import { $, toast } from './util.js?v=20260919f';

export function createClassroom(state) {
  let classes = [], selected = { classId: '', mode: 'name', count: 50, confirmed: false };
  let room = null, generation = 0, selectionRequest = null, rollRequest = null, viewerOnline = true;
  let selectionTimer, rollTimer, openGeneration = 0;
  const dialog = $('classroomDialog');
  const id = () => `phone-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const send = payload => state.joined && state.signaling?.joined && viewerOnline && state.signaling.send(payload);
  const render = () => {
    const item = classes.find(item => item.id === selected.classId);
    $('menuClassroom').textContent = item ? `班级：${item.name} · ${selected.mode === 'name' ? '抽姓名' : '抽学号'}` : '班级 / 抽取设置';
    $('classroomMode').disabled = !$('classroomClass').value;
    $('classroomCountGroup').hidden = !!$('classroomClass').value;
    $('classroomCountValue').textContent = `${$('classroomCount').value} 人`;
  };
  async function open(automatic = false) {
    if (automatic && !dialog.hidden) return;
    const token = state.token, code = state.roomCode, current = generation;
    if (!token || !state.joined) return;
    const attempt = ++openGeneration;
    if (!automatic) { dialog.hidden = false; $('classroomError').textContent = '正在加载班级…'; $('classroomApply').disabled = true; }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);
      let response;
      try { response = await fetch(`${state.apiBase}/classes`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: controller.signal }); }
      finally { clearTimeout(timeout); }
      if (!response.ok) throw new Error(response.status === 401 ? '登录已过期，请重新登录' : '班级加载失败，请重试');
      const data = await response.json();
      if (attempt !== openGeneration || current !== generation || token !== state.token || code !== state.roomCode || !state.joined) return;
      classes = data.items;
      if (automatic && (!classes.length || selected.confirmed)) { render(); return; }
      $('classroomClass').replaceChildren(new Option('不选择班级（按人数抽学号）', ''),
        ...classes.map(item => new Option(`${item.name}（${item.students.length} 人）`, item.id)));
      $('classroomClass').value = selected.classId;
      $('classroomMode').value = selected.mode;
      $('classroomCount').value = selected.count;
      $('classroomError').textContent = '';
      $('classroomApply').disabled = false;
      dialog.hidden = false;
      render();
    } catch (error) {
      if (attempt !== openGeneration || current !== generation) return;
      if (automatic) toast('班级加载失败，请点击班级设置重试', { warn: true });
      else $('classroomError').textContent = error.name === 'AbortError' ? '网络超时，请确认校园 Wi-Fi 后重试' : error.message;
    }
  }
  function apply(value = null) {
    if (selectionRequest) return;
    const next = value || { classId: $('classroomClass').value, mode: $('classroomMode').value, count: Number($('classroomCount').value) };
    const item = classes.find(item => item.id === next.classId);
    if (item && !item.students.length) { $('classroomError').textContent = '此班级没有学生，请先在管理页面录入名单'; return; }
    const requestId = id();
    if (!send({ type: 'student.selection.set', requestId, ...next })) { toast('请等待大屏连接恢复后重试', { warn: true }); return; }
    selectionRequest = requestId;
    $('classroomApply').disabled = true;
    $('classroomError').textContent = '正在同步…';
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      selectionRequest = null; $('classroomApply').disabled = false;
      $('classroomError').textContent = '大屏未确认，请刷新大屏后重试';
      toast('大屏未确认班级设置', { warn: true });
    }, 8000);
  }
  function receive(message) {
    if (!state.joined || (message.requestId && message.requestId !== selectionRequest) || (selectionRequest && !message.requestId)) return;
    const pending = !!selectionRequest;
    clearTimeout(selectionTimer); selectionRequest = null; $('classroomApply').disabled = false;
    if (message.error) { $('classroomError').textContent = message.error; toast(message.error, { warn: true }); return; }
    selected = { classId: message.classId, mode: message.mode, count: message.count, confirmed: message.confirmed };
    render();
    if (pending) { dialog.hidden = true; toast('班级与抽取设置已同步到大屏'); }
  }
  function draw() {
    if (!['Live', 'MediaCast', 'CoursewarePlay'].includes(state.screen)) return;
    if (rollRequest || selectionRequest) return toast('正在处理，请稍候');
    const requestId = id();
    if (!send({ type: 'student.roll', requestId })) return toast('请等待大屏连接恢复后重试', { warn: true });
    rollRequest = requestId;
    document.querySelectorAll('[data-student-roll]').forEach(button => { button.disabled = true; });
    rollTimer = setTimeout(() => finishRoll('大屏未返回结果，请查看大屏后再试'), 10000);
  }
  function finishRoll(message) {
    clearTimeout(rollTimer); rollRequest = null;
    document.querySelectorAll('[data-student-roll]').forEach(button => { button.disabled = false; });
    if (message) toast(message, { duration: 4000 });
  }
  function reset() {
    generation++; openGeneration++; room = null; classes = []; selectionRequest = null;
    selected = { classId: '', mode: 'name', count: 50, confirmed: false };
    clearTimeout(selectionTimer); finishRoll(); dialog.hidden = true; render();
  }
  function sync() {
    if (selected.confirmed) apply({ classId: selected.classId, mode: selected.mode, count: selected.count });
    else send({ type: 'student.selection.get', requestId: '' });
  }
  document.querySelectorAll('[data-classroom-settings]').forEach(button => button.addEventListener('click', () => open()));
  document.querySelectorAll('[data-student-roll]').forEach(button => button.addEventListener('click', draw));
  $('classroomClass').addEventListener('change', render);
  $('classroomCount').addEventListener('input', render);
  for (const [button, delta] of [['classroomMinus', -1], ['classroomPlus', 1]]) $(button).addEventListener('click', () => {
    $('classroomCount').value = Math.max(1, Math.min(80, Number($('classroomCount').value) + delta)); render();
  });
  $('classroomApply').addEventListener('click', () => apply());
  $('classroomCancel').addEventListener('click', () => { openGeneration++; dialog.hidden = true; });
  $('classroomRetry').addEventListener('click', () => open());
  return {
    reset, receive,
    joined() { if (room !== state.roomCode) { reset(); room = state.roomCode; open(true); } sync(); },
    viewer(online) { const restored = !viewerOnline && online; viewerOnline = online; if (restored && state.signaling?.joined) sync(); },
    result(message) {
      if (message.requestId !== rollRequest) return;
      if (message.status === 'started') return;
      finishRoll(message.message);
      if (message.status === 'needs-setup') open();
    }
  };
}
