const API_BASE = './api';
let token = localStorage.getItem('admin_token') || '';
let currentUser = null; // { id, username, role }
let teachingClasses = [];
let editingClass = null;
let rosterDirty = false;
let classBusy = false;
let usageData = null;
let usageRequest = 0;
let fontItems = [];
let fontPage = 0;
let fontBusy = false;
let fontRequest = 0;
let fontSupported = false;
let fontMissing = [];
let fontMissingCourseware = 0;
let fontRegeneratePending = 0;
let fontRegenerating = false;
let fontScanPending = 0;
let fontScanTimer = null;
let fontScanRounds = 0;
let fontScanLastPending = -1;
let drawLogRequest = 0;

const HOMEWORK_STATUS_TONES = [
  { id: 'green', label: '绿色' },
  { id: 'orange', label: '橙色' },
  { id: 'yellow', label: '黄色' },
  { id: 'red', label: '红色' },
  { id: 'blue', label: '蓝色' },
  { id: 'purple', label: '紫色' },
  { id: 'gray', label: '灰色' }
];
const HOMEWORK_STATUS_LIMIT = 8;
const HOMEWORK_FLUSH_DELAY = 200;
let homeworkStatuses = [];
let homeworkStatusSettingsOpen = false;
let homeworkStatusBusy = false;
let homeworkStatusListRequest = 0;
let homeworkAssignments = [];
let homeworkCurrent = null;
let homeworkStatsData = null;
let homeworkListRequest = 0;
let homeworkDetailRequest = 0;
let homeworkStatsRequest = 0;
let homeworkPending = new Map();
let homeworkFlushTimer = null;
let homeworkFlushPromise = null;
let homeworkStatsOpen = false;
let homeworkCreating = false;
let homeworkSaveToken = 0;
let classSelectionToken = 0;

const COURSEWARE_DEFAULT_WIDTHS = { title: 230, fileName: 180, owner: 100, size: 90, createdAt: 160, actions: 180 };
const COURSEWARE_MIN_WIDTH = 64;
const COURSEWARE_WIDTHS_KEY = 'myclass.admin.courseware.widths.v1';
const COURSEWARE_SORT_KEY = 'myclass.admin.courseware.sort.v1';
let coursewareItems = [];
let coursewareSort = readCoursewareSort();
let coursewareWidths = readCoursewareWidths();
let coursewareResize = null;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

bootstrap();

async function bootstrap() {
  if (token) {
    const me = await apiGet('/auth/me');
    if (me.username) {
      currentUser = me;
      showMain(me);
      return;
    }
    token = '';
    localStorage.removeItem('admin_token');
  }
  showLogin();
}

function showLogin() {
  fontRequest++;
  fontItems = [];
  fontSupported = false;
  fontMissing = [];
  fontMissingCourseware = 0;
  fontRegeneratePending = 0;
  fontRegenerating = false;
  fontScanPending = 0;
  clearTimeout(fontScanTimer);
  fontScanTimer = null;
  fontScanRounds = 0;
  fontScanLastPending = -1;
  $('#fontTableBody').replaceChildren();
  $('#fontUploadResults').replaceChildren();
  $('#fontStatus').textContent = '';
  $('#fontMissingPanel').hidden = true;
  $('#fontMissingList').replaceChildren();
  $('#fontRegenerateStatus').textContent = '';
  $('#fontScanStatus').textContent = '';
  usageRequest++;
  usageData = null;
  $('#usageTableBody').replaceChildren();
  $('#usageSummary').replaceChildren();
  $('#usageTrend').replaceChildren();
  $('#onlineTeachersBody').replaceChildren();
  $('#onlineTeachersStatus').textContent = '';
  resetClassEditor();
  $('#loginPanel').hidden = false;
  $('#mainPanel').hidden = true;
  $('#adminUser').textContent = '';
}

function showMain(user) {
  resetClassEditor();
  currentUser = user;
  $('#loginPanel').hidden = true;
  $('#mainPanel').hidden = false;
  const roleLabel = user.role === 'admin' ? '管理员' : '普通用户';
  $('#adminUser').textContent = `当前用户：${user.username}（${roleLabel}）`;
  renderTabs(user.role);
  // 默认激活第一个标签
  const firstTab = $('#adminTabs .tab-btn');
  if (firstTab) firstTab.click();
}

// --- 根据角色动态渲染标签 ---
function renderTabs(role) {
  const tabs = $('#adminTabs');
  const items = [];
  if (role === 'admin') {
    items.push({ id: 'usage', label: '使用统计' });
    items.push({ id: 'users', label: '用户管理' });
    items.push({ id: 'courseware', label: '课件管理' });
  } else {
    items.push({ id: 'courseware', label: '我的课件' });
  }
  items.push({ id: 'classes', label: '任教班级' });
  items.push({ id: 'fonts', label: '字体管理' });
  items.push({ id: 'account', label: '账户设置' });

  tabs.innerHTML = items.map((t, i) =>
    `<button class="tab-btn${i === 0 ? ' is-active' : ''}" data-tab="${t.id}">${t.label}</button>`
  ).join('');

  tabs.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (classBusy || (rosterDirty && !confirm('名单尚未保存，确定离开并放弃修改吗？'))) return;
      rosterDirty = false;
      tabs.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      const tab = btn.dataset.tab;
      $('#tab-users').hidden = tab !== 'users';
      $('#tab-usage').hidden = tab !== 'usage';
      $('#tab-courseware').hidden = tab !== 'courseware';
      $('#tab-account').hidden = tab !== 'account';
      $('#tab-classes').hidden = tab !== 'classes';
      $('#tab-fonts').hidden = tab !== 'fonts';
      if (tab === 'users') loadUsers();
      if (tab === 'usage') loadUsage();
      if (tab === 'courseware') loadCourseware();
      if (tab === 'account') loadProfile();
      if (tab === 'classes') loadTeachingClasses();
      if (tab === 'fonts') loadFonts();
    });
  });
}

// --- 登录 ---
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  btn.textContent = '登录中...';
  $('#loginError').hidden = true;
  try {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: $('#loginUsername').value.trim(),
        password: $('#loginPassword').value
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '登录失败');
    token = data.token;
    localStorage.setItem('admin_token', token);
    const me = await apiGet('/auth/me');
    showMain(me);
    toast('登录成功', 'success');
    $('#loginUsername').value = '';
    $('#loginPassword').value = '';
  } catch (err) {
    $('#loginError').textContent = err.message;
    $('#loginError').hidden = false;
  }
  btn.disabled = false;
  btn.textContent = '登录';
});

$('#logoutButton').addEventListener('click', async () => {
  if (homeworkPending.size) await flushAllHomework();
  token = '';
  currentUser = null;
  localStorage.removeItem('admin_token');
  showLogin();
});

// --- 回到主页（安全退出会话并跳转） ---
$('#homeButton').addEventListener('click', async () => {
  if (homeworkPending.size) await flushAllHomework();
  token = '';
  currentUser = null;
  localStorage.removeItem('admin_token');
  // 从 iPhone 网页版进入后台时，回到 iOS 端（iOS 的登录态仍在 myclass.ios.token）
  const fromIos = new URLSearchParams(window.location.search).get('from') === 'ios';
  window.location.href = fromIos ? './ios/' : './index.html';
});

// --- 登录/注册面板切换 ---
$('#toRegisterLink').addEventListener('click', (e) => {
  e.preventDefault();
  $('#loginPanel').hidden = true;
  $('#registerPanel').hidden = false;
  $('#registerError').hidden = true;
});

$('#toLoginLink').addEventListener('click', (e) => {
  e.preventDefault();
  $('#registerPanel').hidden = true;
  $('#loginPanel').hidden = false;
  $('#loginError').hidden = true;
});

// --- 用户注册 ---
$('#registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('#registerUsername').value.trim();
  const password = $('#registerPassword').value;
  const confirmPassword = $('#registerConfirmPassword').value;
  const errEl = $('#registerError');
  errEl.hidden = true;

  // 前端输入校验
  if (!username || !password || !confirmPassword) {
    errEl.textContent = '所有字段均为必填项';
    errEl.hidden = false;
    return;
  }
  if (username.length < 2 || username.length > 20 || !/^[\u4e00-\u9fa5a-zA-Z0-9_]+$/.test(username)) {
    errEl.textContent = '用户名仅支持中英文数字下划线，2-20位';
    errEl.hidden = false;
    return;
  }
  if (password.length < 4 || password.length > 32) {
    errEl.textContent = '密码长度需为4-32位';
    errEl.hidden = false;
    return;
  }
  if (password !== confirmPassword) {
    errEl.textContent = '两次输入的密码不一致';
    errEl.hidden = false;
    return;
  }

  const btn = e.target.querySelector('button');
  btn.disabled = true;
  btn.textContent = '注册中...';
  try {
    const res = await fetch(`${API_BASE}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '注册失败');
    // 注册成功，自动登录
    token = data.token;
    localStorage.setItem('admin_token', token);
    const me = await apiGet('/auth/me');
    showMain(me);
    toast('注册成功，已自动登录', 'success');
    $('#registerUsername').value = '';
    $('#registerPassword').value = '';
    $('#registerConfirmPassword').value = '';
    $('#registerPanel').hidden = true;
    $('#loginPanel').hidden = true;
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
  btn.disabled = false;
  btn.textContent = '注册';
});

// --- 密码重置弹窗（管理员重置他人密码） ---
$('#resetPasswordCancel').addEventListener('click', closeResetModal);
$('#resetPasswordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#resetUserId').value;
  const pw = $('#resetPasswordInput').value;
  const btn = $('#resetPasswordSubmit');
  btn.disabled = true;
  btn.textContent = '重置中...';
  try {
    await apiPut(`/admin/users/${id}/password`, { password: pw });
    closeResetModal();
    toast('密码重置成功', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
  btn.disabled = false;
  btn.textContent = '确定重置';
});

function openResetModal(userId, username) {
  $('#resetUserId').value = userId;
  $('#resetUsername').textContent = username;
  $('#resetPasswordInput').value = '';
  $('#resetModal').hidden = false;
}

function closeResetModal() {
  $('#resetModal').hidden = true;
}

// --- 课件重命名弹窗 ---
$('#renameCancel').addEventListener('click', closeRenameModal);
$('#renameForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#renameCoursewareId').value;
  const title = $('#renameCoursewareTitle').value.trim();
  const errEl = $('#renameError');
  errEl.hidden = true;

  if (!title) {
    errEl.textContent = '标题不能为空';
    errEl.hidden = false;
    return;
  }

  const btn = $('#renameSubmit');
  btn.disabled = true;
  btn.textContent = '保存中...';
  try {
    await apiPut(`/courseware/${id}/rename`, { title });
    closeRenameModal();
    toast('课件重命名成功', 'success');
    loadCourseware();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
  btn.disabled = false;
  btn.textContent = '确定';
});

function openRenameModal(id, title) {
  $('#renameCoursewareId').value = id;
  $('#renameCoursewareTitle').value = title;
  $('#renameError').hidden = true;
  $('#renameModal').hidden = false;
}

function closeRenameModal() {
  $('#renameModal').hidden = true;
}

// --- 账户设置：修改密码 ---
$('#changePasswordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const oldPw = $('#oldPassword').value;
  const newPw = $('#newPassword').value;
  const confirmPw = $('#confirmPassword').value;
  const errEl = $('#changePwError');
  errEl.hidden = true;

  if (newPw !== confirmPw) {
    errEl.textContent = '两次输入的新密码不一致';
    errEl.hidden = false;
    return;
  }
  if (newPw === oldPw) {
    errEl.textContent = '新密码不能与旧密码相同';
    errEl.hidden = false;
    return;
  }

  const btn = e.target.querySelector('button');
  btn.disabled = true;
  btn.textContent = '修改中...';
  try {
    const data = await apiPut('/auth/password', { oldPassword: oldPw, newPassword: newPw });
    if (data.token) {
      token = data.token;
      localStorage.setItem('admin_token', token);
    }
    toast('密码修改成功', 'success');
    $('#oldPassword').value = '';
    $('#newPassword').value = '';
    $('#confirmPassword').value = '';
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
  btn.disabled = false;
  btn.textContent = '确认修改';
});

// --- 账户设置：更新个人信息 ---
$('#updateProfileForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('#profileUsername').value.trim();
  const errEl = $('#profileError');
  errEl.hidden = true;

  if (username === currentUser.username) {
    errEl.textContent = '用户名未更改';
    errEl.hidden = false;
    return;
  }

  const btn = e.target.querySelector('button');
  btn.disabled = true;
  btn.textContent = '保存中...';
  try {
    const data = await apiPut('/auth/profile', { username });
    currentUser.username = data.username;
    const roleLabel = currentUser.role === 'admin' ? '管理员' : '普通用户';
    $('#adminUser').textContent = `当前用户：${data.username}（${roleLabel}）`;
    toast('个人信息更新成功', 'success');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
  btn.disabled = false;
  btn.textContent = '保存修改';
});

function loadProfile() {
  if (currentUser) {
    $('#profileUsername').value = currentUser.username;
  }
}

// --- Usage statistics (administrator only) ---
function usageDate(time) { return new Date(time + 8 * 3600000).toISOString().slice(0, 10); }
function setUsageRange(days) {
  $('#usageFrom').value = usageDate(Date.now() - (days - 1) * 86400000);
  $('#usageTo').value = usageDate(Date.now());
}
function usageTime(iso) {
  return iso ? new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—';
}
const usageRoles = { admin: '管理员', user: '教师', deleted: '已删除账号', anonymous: '未登录设备' };

async function loadUsage() {
  if (currentUser?.role !== 'admin') return;
  if (!$('#usageFrom').value) setUsageRange(30);
  const from = $('#usageFrom').value;
  const to = $('#usageTo').value;
  const request = ++usageRequest;
  usageData = null;
  $('#exportUsageButton').disabled = true;
  $('#usageSummary').replaceChildren();
  $('#usageTrend').replaceChildren();
  $('#usageTableBody').replaceChildren();
  $('#usageStatus').classList.remove('usage-error');
  $('#usageStatus').textContent = '正在加载使用统计…';
  $('#onlineTeachersBody').replaceChildren();
  $('#onlineTeachersStatus').textContent = '正在查询在线教师...';
  try {
    const data = await apiGet(`/admin/usage?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    if (request !== usageRequest || currentUser?.role !== 'admin') return;
    if (data.error || !data.totals) throw new Error(data.error || '统计数据加载失败');
    usageData = data;
    renderOnlineTeachers(data);
    const t = data.totals;
    const cards = [
      ['活跃账号 / 注册账号', `${t.activeUsers} / ${t.registeredUsers}`],
      ['课堂连接次数', t.connections], ['投屏打开次数', t.presentations], ['实时投屏协商次数', t.realtime],
      ['上传次数', t.uploads], ['抽选完成次数', t.rolls],
      ['当前在线教师账号', data.online.users], ['当前在线大屏', data.online.classrooms]
    ];
    for (const [label, value] of cards) {
      const card = document.createElement('div'); card.className = 'usage-card';
      const title = document.createElement('span'); title.textContent = label;
      const number = document.createElement('strong'); number.textContent = String(value);
      card.append(title, number); $('#usageSummary').append(card);
    }
    const max = Math.max(1, ...data.daily.map(day => day.presentations));
    const fragment = document.createDocumentFragment();
    for (const day of [...data.daily].reverse()) {
      const row = document.createElement('div'); row.className = 'usage-day';
      const date = document.createElement('span'); date.textContent = day.date;
      const track = document.createElement('div'); track.className = 'usage-bar'; track.setAttribute('aria-hidden', 'true');
      const bar = document.createElement('i'); bar.style.width = `${day.presentations / max * 100}%`; track.append(bar);
      const count = document.createElement('small'); count.textContent = `${day.activeUsers} 活跃 · ${day.presentations} 次投屏`;
      row.append(date, track, count); fragment.append(row);
    }
    $('#usageTrend').append(fragment);
    $('#usageStatus').textContent = `${data.from} 至 ${data.to}（北京时间） · 统计始于 ${usageTime(data.startedAt)} · 刷新于 ${usageTime(data.generatedAt)}${t.activeUsers || t.connections || t.uploads ? '' : ' · 所选期间暂无使用记录'}`;
    $('#exportUsageButton').disabled = false;
    renderUsageUsers();
  } catch (error) {
    if (request !== usageRequest) return;
    $('#usageStatus').textContent = `加载失败：${error.message}`;
    $('#usageStatus').classList.add('usage-error');
    $('#onlineTeachersStatus').textContent = '在线状态查询失败';
  }
}
function renderOnlineTeachers(data) {
  const body = $('#onlineTeachersBody');
  body.replaceChildren();
  const teachers = data.online?.teachers;
  if (!Array.isArray(teachers)) {
    $('#onlineTeachersStatus').textContent = '服务器尚未提供在线教师名单';
    return;
  }
  $('#onlineTeachersStatus').textContent = `${data.online.users} 个账号 · ${data.online.teacherDevices} 台教师设备 · 刷新于 ${usageTime(data.generatedAt)}`;
  if (!teachers.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 4;
    cell.textContent = '当前无教师设备在线';
    row.append(cell); body.append(row);
    return;
  }
  for (const teacher of teachers) {
    const row = document.createElement('tr');
    for (const value of [teacher.username, usageRoles[teacher.role] || teacher.role, teacher.roomCode,
      teacher.viewerOnline ? '已连接' : '断线重连中']) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    body.append(row);
  }
}
function filteredUsageUsers() {
  const query = $('#usageSearch').value.trim().toLocaleLowerCase();
  return (usageData?.users || []).filter(user => user.username.toLocaleLowerCase().includes(query));
}
function usageCells(user) {
  return [user.username, usageRoles[user.role] || user.role, user.activeDays, user.logins, user.connections,
    user.presentations, user.realtime, user.uploads, formatBytes(user.uploadBytes), user.rolls, usageTime(user.lastAt)];
}
function renderUsageUsers() {
  const body = $('#usageTableBody'); body.replaceChildren();
  const users = filteredUsageUsers();
  if (!users.length) {
    const row = document.createElement('tr'); const cell = document.createElement('td');
    cell.colSpan = 11; cell.textContent = '暂无匹配账号'; row.append(cell); body.append(row); return;
  }
  for (const user of users) {
    const row = document.createElement('tr');
    for (const value of usageCells(user)) { const cell = document.createElement('td'); cell.textContent = String(value); row.append(cell); }
    body.append(row);
  }
}
$('#usageFilters').addEventListener('submit', event => { event.preventDefault(); loadUsage(); });
$$('[data-usage-days]').forEach(button => button.addEventListener('click', () => { setUsageRange(Number(button.dataset.usageDays)); loadUsage(); }));
$('#usageSearch').addEventListener('input', renderUsageUsers);
$('#exportUsageButton').addEventListener('click', () => {
  if (!usageData || currentUser?.role !== 'admin') return;
  const headers = ['账号', '角色', '活跃天数', '登录', '课堂连接', '投屏打开', '实时投屏协商', '上传', '上传大小', '抽选完成', '期间最后使用'];
  const quote = value => `"${String(value).replace(/^[=+@\-\t\r]/, match => `'${match}`).replaceAll('"', '""')}"`;
  const csv = '\uFEFF' + [headers, ...filteredUsageUsers().map(usageCells)].map(row => row.map(quote).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url;
  link.download = `使用统计_${usageData.from}_${usageData.to}.csv`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// --- API ---
async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) { token = ''; localStorage.removeItem('admin_token'); showLogin(); throw new Error('登录已过期'); }
  if (res.status === 403) { const d = await res.json().catch(() => ({})); throw new Error(d.error || '权限不足'); }
  return res.json();
}

async function apiDelete(path) {
  const res = await fetch(`${API_BASE}${path}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) { token = ''; localStorage.removeItem('admin_token'); showLogin(); throw new Error('登录已过期'); }
  if (res.status === 403) { const d = await res.json().catch(() => ({})); throw new Error(d.error || '权限不足'); }
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || '操作失败'); }
  return res.json();
}

async function apiPut(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  });
  if (res.status === 401) { token = ''; localStorage.removeItem('admin_token'); showLogin(); throw new Error('登录已过期'); }
  if (res.status === 403) { const d = await res.json().catch(() => ({})); throw new Error(d.error || '权限不足'); }
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || '操作失败'); }
  return res.json();
}

// --- 用户管理（仅管理员） ---
$('#refreshUsersButton').addEventListener('click', loadUsers);

async function loadUsers() {
  try {
    const data = await apiGet('/admin/users');
    const tbody = $('#userTableBody');
    if (!data.users?.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="5">暂无用户</td></tr>';
      return;
    }
    tbody.innerHTML = data.users.map((u) => {
      const isAdmin = u.role === 'admin';
      const deleteBtn = isAdmin ? '' : `<button class="btn-danger" data-delete-user="${u.id}">删除</button>`;
      const resetBtn = isAdmin ? '' : `<button class="btn-secondary btn-sm" data-reset-pw="${u.id}" data-reset-name="${escapeHtml(u.username)}">重置密码</button>`;
      return `
      <tr>
        <td>${escapeHtml(u.username)}</td>
        <td>${isAdmin ? '<span class="badge">管理员</span>' : '<span class="badge badge-user">普通用户</span>'}</td>
        <td>${formatDate(u.createdAt)}</td>
        <td>${formatDate(u.lastLoginAt)}</td>
        <td>${resetBtn} ${deleteBtn}</td>
      </tr>`;
    }).join('');
    tbody.querySelectorAll('.btn-danger').forEach((btn) => {
      btn.addEventListener('click', () => deleteUser(btn.dataset.deleteUser, btn));
    });
    tbody.querySelectorAll('[data-reset-pw]').forEach((btn) => {
      btn.addEventListener('click', () => openResetModal(btn.dataset.resetPw, btn.dataset.resetName));
    });
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function deleteUser(userId, btn) {
  if (!confirm('确定删除该用户？相关课件也会被清除。')) return;
  btn.disabled = true;
  try { await apiDelete(`/admin/users/${userId}`); loadUsers(); toast('用户已删除', 'success'); }
  catch (err) { toast(err.message, 'error'); }
  btn.disabled = false;
}

// --- 课件管理 ---
$('#refreshCoursewareButton').addEventListener('click', loadCourseware);

$('#coursewareFileInput').addEventListener('change', (e) => {
  if (e.target.files.length) uploadCourseware(e.target.files[0]);
  e.target.value = '';
});

function readCoursewareWidths() {
  try {
    const values = JSON.parse(localStorage.getItem(COURSEWARE_WIDTHS_KEY) || '{}');
    const result = {};
    for (const [key, width] of Object.entries(values || {})) {
      if (Object.hasOwn(COURSEWARE_DEFAULT_WIDTHS, key) && Number.isFinite(width) && width >= COURSEWARE_MIN_WIDTH && width <= 2000) {
        result[key] = Math.round(width);
      }
    }
    return result;
  } catch { return {}; }
}

function saveCoursewareWidths() {
  try { localStorage.setItem(COURSEWARE_WIDTHS_KEY, JSON.stringify(coursewareWidths)); } catch { /* 隐私模式下忽略存储失败 */ }
}

function readCoursewareSort() {
  try {
    const value = JSON.parse(localStorage.getItem(COURSEWARE_SORT_KEY) || 'null');
    if (value && Object.hasOwn(COURSEWARE_DEFAULT_WIDTHS, value.key) && value.key !== 'actions'
      && (value.direction === 'asc' || value.direction === 'desc')) return value;
  } catch { /* 忽略损坏的本地设置 */ }
  return null;
}

function saveCoursewareSort() {
  try {
    if (coursewareSort) localStorage.setItem(COURSEWARE_SORT_KEY, JSON.stringify(coursewareSort));
    else localStorage.removeItem(COURSEWARE_SORT_KEY);
  } catch { /* 隐私模式下忽略存储失败 */ }
}

function updateCoursewareSortHeaders() {
  $$('#coursewareTable thead th').forEach((th) => {
    if (!th.dataset.sortKey) return;
    const active = coursewareSort?.key === th.dataset.sortKey;
    th.setAttribute('aria-sort', active ? (coursewareSort.direction === 'asc' ? 'ascending' : 'descending') : 'none');
  });
}

function coursewareSortValue(item, key) {
  if (key === 'size') return Number(item.size) || 0;
  if (key === 'createdAt') {
    const time = Date.parse(item.createdAt);
    return Number.isNaN(time) ? 0 : time;
  }
  if (key === 'owner') return item.owner || '';
  return item[key] || '';
}

function sortedCoursewareItems() {
  if (!coursewareSort) return coursewareItems;
  const direction = coursewareSort.direction === 'asc' ? 1 : -1;
  return [...coursewareItems].sort((a, b) => {
    const left = coursewareSortValue(a, coursewareSort.key);
    const right = coursewareSortValue(b, coursewareSort.key);
    let result = typeof left === 'number' && typeof right === 'number'
      ? left - right
      : String(left).localeCompare(String(right), 'zh-CN', { numeric: true, sensitivity: 'base' });
    if (!result) result = a._order - b._order;
    return result * direction;
  });
}

function toggleCoursewareSort(key) {
  if (!key) return;
  if (coursewareSort?.key === key) {
    coursewareSort.direction = coursewareSort.direction === 'asc' ? 'desc' : 'asc';
  } else {
    // 大小和上传时间先看最新的/最大的，文字列先按升序，符合常见直觉
    coursewareSort = { key, direction: key === 'size' || key === 'createdAt' ? 'desc' : 'asc' };
  }
  saveCoursewareSort();
  updateCoursewareSortHeaders();
  renderCoursewareRows();
}

function visibleCoursewareColumns() {
  const table = $('#coursewareTable');
  const visible = new Map();
  if (!table) return visible;
  [...table.tHead.rows[0].cells].forEach((th) => visible.set(th.dataset.col, !th.hidden));
  return visible;
}

function applyCoursewareWidths() {
  const table = $('#coursewareTable');
  if (!table) return;
  const visible = visibleCoursewareColumns();
  let total = 0;
  [...table.querySelectorAll('colgroup col')].forEach((col) => {
    const key = col.dataset.col;
    if (!visible.get(key)) {
      col.style.display = 'none';
      col.style.width = '';
      return;
    }
    col.style.display = '';
    const width = coursewareWidths[key] || COURSEWARE_DEFAULT_WIDTHS[key];
    col.style.width = `${width}px`;
    total += width;
  });
  const available = table.parentElement ? table.parentElement.clientWidth : 0;
  table.style.width = total ? `${Math.max(total, available - 2)}px` : '';
  $$('#coursewareTable thead th').forEach((th) => {
    const handle = th.querySelector('.column-resizer');
    if (!handle || th.hidden) return;
    const width = th.getBoundingClientRect().width || coursewareWidths[th.dataset.col] || COURSEWARE_DEFAULT_WIDTHS[th.dataset.col];
    handle.setAttribute('aria-valuenow', String(Math.round(width)));
    handle.setAttribute('aria-valuemin', String(COURSEWARE_MIN_WIDTH));
  });
}

function startColumnResize(event, th) {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  event.preventDefault();
  const table = th.closest('table');
  const key = th.dataset.col;
  const col = table?.querySelector(`colgroup col[data-col="${key}"]`);
  if (!col) return;
  coursewareResize = {
    table, th, col, key, handle: event.currentTarget, pointerId: event.pointerId,
    startX: event.clientX, startWidth: th.getBoundingClientRect().width
  };
  table.classList.add('is-resizing');
  document.body.classList.add('is-col-resizing');
  window.addEventListener('pointermove', onColumnResizeMove);
  window.addEventListener('pointerup', stopColumnResize);
  window.addEventListener('pointercancel', stopColumnResize);
}

function onColumnResizeMove(event) {
  const state = coursewareResize;
  if (!state || event.pointerId !== state.pointerId) return;
  const width = Math.max(COURSEWARE_MIN_WIDTH, Math.round(state.startWidth + event.clientX - state.startX));
  coursewareWidths[state.key] = width;
  applyCoursewareWidths();
}

function stopColumnResize(event) {
  const state = coursewareResize;
  if (!state || (event && event.pointerId !== undefined && event.pointerId !== state.pointerId)) return;
  coursewareResize = null;
  state.table.classList.remove('is-resizing');
  document.body.classList.remove('is-col-resizing');
  window.removeEventListener('pointermove', onColumnResizeMove);
  window.removeEventListener('pointerup', stopColumnResize);
  window.removeEventListener('pointercancel', stopColumnResize);
  saveCoursewareWidths();
  applyCoursewareWidths();
}

function handleColumnResizeKey(event, th) {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  const key = th.dataset.col;
  const current = coursewareWidths[key] || Math.round(th.getBoundingClientRect().width) || COURSEWARE_DEFAULT_WIDTHS[key];
  coursewareWidths[key] = Math.max(COURSEWARE_MIN_WIDTH, current + (event.key === 'ArrowRight' ? 16 : -16));
  saveCoursewareWidths();
  applyCoursewareWidths();
}

function resetCoursewareColumnWidth(th) {
  delete coursewareWidths[th.dataset.col];
  saveCoursewareWidths();
  applyCoursewareWidths();
}

function setupCoursewareTable() {
  const table = $('#coursewareTable');
  if (!table) return;
  [...table.tHead.rows[0].cells].forEach((th) => {
    th.querySelector('.sort-button')?.addEventListener('click', () => toggleCoursewareSort(th.dataset.sortKey));
    const handle = th.querySelector('.column-resizer');
    if (!handle) return;
    handle.addEventListener('pointerdown', (event) => startColumnResize(event, th));
    handle.addEventListener('keydown', (event) => handleColumnResizeKey(event, th));
    handle.addEventListener('dblclick', () => resetCoursewareColumnWidth(th));
  });
  updateCoursewareSortHeaders();
  applyCoursewareWidths();
  window.addEventListener('resize', applyCoursewareWidths);
}

function renderCoursewareRows() {
  const isAdmin = currentUser?.role === 'admin';
  const tbody = $('#coursewareTableBody');
  if (!coursewareItems.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="${isAdmin ? 6 : 5}">暂无课件</td></tr>`;
    return;
  }
  tbody.innerHTML = sortedCoursewareItems().map((c) => `
    <tr>
      <td>${escapeHtml(c.title)}${c.playbackProgress ? `<div class="muted">上次播放（未选班级）：第 ${Number(c.playbackProgress.page)} / ${Number(c.playbackProgress.pageCount)} 页</div><progress max="${Number(c.playbackProgress.pageCount)}" value="${Number(c.playbackProgress.page)}"></progress>` : ''}</td>
      <td>${escapeHtml(c.fileName).substring(0, 30)}</td>
      ${isAdmin ? `<td><span class="tag ${c.userId === 'admin' ? 'tag-public' : 'tag-private'}">${escapeHtml(c.owner || '未知')}</span></td>` : ''}
      <td>${formatBytes(c.size)}</td>
      <td>${formatDate(c.createdAt)}</td>
      <td>
        <button class="btn-secondary btn-sm" data-rename-cw="${c.id}" data-rename-title="${escapeHtml(c.title)}">重命名</button>
        <button class="btn-danger" data-delete-cw="${c.id}">删除</button>
      </td>
    </tr>
  `).join('');
  tbody.querySelectorAll('.btn-danger').forEach((btn) => {
    btn.addEventListener('click', () => deleteCourseware(btn.dataset.deleteCw, btn));
  });
  tbody.querySelectorAll('[data-rename-cw]').forEach((btn) => {
    btn.addEventListener('click', () => openRenameModal(btn.dataset.renameCw, btn.dataset.renameTitle));
  });
}

async function loadCourseware() {
  const isAdmin = currentUser?.role === 'admin';
  // 普通用户不传 all=true，只看自己的课件
  const url = isAdmin ? '/courseware?all=true' : '/courseware';
  // 普通用户隐藏"所有者"列和"所有人可见"选项
  $('#ownerTh').hidden = !isAdmin;
  $('#shareLabel').style.display = isAdmin ? '' : 'none';
  $('#coursewareTitle').textContent = isAdmin ? '课件列表' : '我的课件';
  if (!isAdmin && coursewareSort?.key === 'owner') {
    coursewareSort = null;
    saveCoursewareSort();
  }
  updateCoursewareSortHeaders();

  try {
    const data = await apiGet(url);
    coursewareItems = (data.items || []).map((item, index) => ({ ...item, _order: index }));
    renderCoursewareRows();
    applyCoursewareWidths();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function deleteCourseware(id, btn) {
  if (!confirm('确定删除该课件？')) return;
  btn.disabled = true;
  try { await apiDelete(`/courseware/${id}`); loadCourseware(); toast('课件已删除', 'success'); }
  catch (err) { toast(err.message, 'error'); }
  btn.disabled = false;
}

async function uploadCourseware(file) {
  const prog = $('#uploadProgress');
  const fill = $('#progressFill');
  const text = $('#progressText');
  const share = $('#uploadShareCheckbox').checked;
  prog.hidden = false;
  fill.style.width = '0%';
  text.textContent = '上传中...';

  try {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('share', share ? 'true' : 'false');
    const res = await fetch(`${API_BASE}/courseware`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || '上传失败');
    }
    const data = await res.json().catch(() => ({}));
    fill.style.width = '100%';
    text.textContent = '上传完成';
    toast('课件上传成功', 'success');
    if (Array.isArray(data.missingFonts) && data.missingFonts.length) {
      toast(`课件缺少字体：${data.missingFonts.join('、')}。请在“字体管理”上传，系统会自动重新生成课件。`, 'info');
    }
    setTimeout(() => { prog.hidden = true; }, 1500);
    loadCourseware();
  } catch (err) {
    text.textContent = err.message;
    toast(err.message, 'error');
    fill.style.width = '0%';
  }
}

// --- 服务器字体 ---
function renderFonts() {
  const query = $('#fontSearch').value.trim().toLocaleLowerCase();
  const matches = fontItems.filter(item => `${item.family} ${item.styles.join(' ')}`.toLocaleLowerCase().includes(query));
  const pageSize = 100;
  fontPage = Math.max(0, Math.min(fontPage, Math.ceil(matches.length / pageSize) - 1));
  const rows = matches.slice(fontPage * pageSize, (fontPage + 1) * pageSize);
  const body = $('#fontTableBody');
  body.replaceChildren();
  for (const item of rows) {
    const row = document.createElement('tr');
    for (const value of [item.family, item.styles.join(' / '), item.source === 'uploaded' ? '教师上传' : '系统字体']) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.appendChild(cell);
    }
    body.appendChild(row);
  }
  if (!rows.length) {
    const row = body.insertRow();
    const cell = row.insertCell();
    cell.colSpan = 3;
    cell.textContent = query ? '没有匹配的字体' : '暂无字体';
  }
  $('#fontCount').textContent = matches.length ? `${fontPage * pageSize + 1} - ${Math.min((fontPage + 1) * pageSize, matches.length)} / ${matches.length} 个字体系列` : '0 个字体系列';
  $('#fontPreviousButton').disabled = fontPage === 0;
  $('#fontNextButton').disabled = (fontPage + 1) * pageSize >= matches.length;
  renderFontMissing();
}

function renderFontMissing() {
  const list = $('#fontMissingList');
  list.replaceChildren();
  for (const item of fontMissing) {
    const row = document.createElement('li');
    const name = document.createElement('strong');
    name.textContent = item.family;
    const count = document.createElement('span');
    count.className = 'font-missing-count';
    count.textContent = ` ${item.coursewareCount} 个课件`;
    row.append(name, count);
    if (item.titles?.length) {
      const titles = document.createElement('div');
      titles.className = 'font-missing-titles';
      titles.textContent = `涉及：${item.titles.join('、')}${item.coursewareCount > item.titles.length ? ' 等' : ''}`;
      row.appendChild(titles);
    }
    list.appendChild(row);
  }
  const pending = fontRegeneratePending > 0;
  $('#fontMissingPanel').hidden = !fontMissing.length && !pending && !fontScanPending;
  $('#fontMissingHelp').textContent = fontMissing.length
    ? '上传下列字体后，系统会自动重新生成当前账号使用这些字体的课件，无需重新上传课件。'
    : '字体已安装，但当前账号的相关课件还没有重新生成，可点击右侧按钮更新。';
  $('#fontMissingHelp').hidden = !fontMissing.length && !pending;
  const scan = $('#fontScanStatus');
  scan.hidden = !fontScanPending;
  scan.textContent = fontScanPending ? `还有 ${fontScanPending} 个旧课件待检查字体，页面会自动分批检查。` : '';
  $('#fontMissingCount').textContent = fontMissing.length ? `（${fontMissing.length} 种，影响 ${fontMissingCourseware} 个课件）` : '';
  $('#regenerateFontsButton').hidden = !pending;
  $('#regenerateFontsButton').textContent = pending ? `重新生成待更新课件（${fontRegeneratePending}）` : '重新生成待更新课件';
  updateFontTabBadge();
}

// Show the outstanding count on the tab itself, so the prompt is visible
// without opening the font page.
function updateFontTabBadge() {
  const tab = document.querySelector('#adminTabs .tab-btn[data-tab="fonts"]');
  if (!tab) return;
  const count = fontMissing.length;
  tab.textContent = count ? `字体管理（缺 ${count} 种）` : '字体管理';
  tab.classList.toggle('has-font-missing', count > 0);
  tab.title = count ? `${count} 种课件字体尚未安装，点击查看并上传` : '';
}

function setFontControls() {
  const locked = fontBusy || fontRegenerating;
  $('#fontFileInput').disabled = locked || !fontSupported;
  $('#uploadFontsButton').disabled = locked || !fontSupported;
  $('#refreshFontsButton').disabled = locked;
  $('#regenerateFontsButton').disabled = locked;
}

async function fontApi(route = '', options = {}) {
  const requestToken = token;
  const response = await fetch(`${API_BASE}/fonts${route}`, { ...options, cache: 'no-store', headers: { Authorization: `Bearer ${requestToken}` } });
  if (requestToken !== token) throw new Error('登录用户已改变，请重试');
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) { token = ''; localStorage.removeItem('admin_token'); showLogin(); }
  if (!response.ok) throw new Error(data.error || '字体操作失败');
  return data;
}

async function loadFonts({ preserveStatus = false, autoScan = false } = {}) {
  if (fontBusy && !preserveStatus) return;
  if (!autoScan) {
    clearTimeout(fontScanTimer);
    fontScanTimer = null;
    fontScanRounds = 0;
    fontScanLastPending = -1;
  }
  const request = ++fontRequest;
  if (!preserveStatus) { $('#fontStatus').textContent = '正在读取字体...'; $('#fontStatus').classList.remove('is-error'); }
  try {
    const data = await fontApi();
    if (request !== fontRequest) return;
    fontItems = data.items;
    fontSupported = data.supported;
    fontMissing = Array.isArray(data.missingFonts) ? data.missingFonts : [];
    fontMissingCourseware = Number(data.missingCourseware) || 0;
    fontRegeneratePending = Number(data.pendingRegeneration) || 0;
    fontScanPending = Number(data.scanPending) || 0;
    if (!preserveStatus || !data.supported) $('#fontStatus').textContent = data.message || '';
    renderFonts();
    scheduleFontScan(autoScan);
  } catch (error) {
    if (request !== fontRequest) return;
    fontSupported = false;
    fontMissing = [];
    fontMissingCourseware = 0;
    fontRegeneratePending = 0;
    fontScanPending = 0;
    $('#fontStatus').textContent = error.message;
    $('#fontStatus').classList.add('is-error');
    renderFontMissing();
  } finally { if (request === fontRequest) setFontControls(); }
}

// Old courseware is inspected in small batches so the fonts request stays
// fast. Keep asking while the batch makes progress; stop when the count no
// longer drops (unreadable originals) or when the user leaves the tab.
function scheduleFontScan(autoScan) {
  clearTimeout(fontScanTimer);
  fontScanTimer = null;
  if (!fontScanPending || fontScanRounds >= 30) return;
  if (autoScan && fontScanPending >= fontScanLastPending) return;
  fontScanLastPending = fontScanPending;
  fontScanRounds++;
  fontScanTimer = setTimeout(() => {
    fontScanTimer = null;
    const tab = $('#tab-fonts');
    if (!token || fontBusy || fontRegenerating || (tab && tab.hidden)) return;
    loadFonts({ preserveStatus: true, autoScan: true });
  }, 250);
}

$('#fontSearch').addEventListener('input', () => { fontPage = 0; renderFonts(); });
$('#fontPreviousButton').addEventListener('click', () => { fontPage--; renderFonts(); });
$('#fontNextButton').addEventListener('click', () => { fontPage++; renderFonts(); });
$('#refreshFontsButton').addEventListener('click', () => loadFonts());
$('#regenerateFontsButton').addEventListener('click', () => regenerateFonts({ force: true }));

// Installing a font does not change an already published PDF. Ask the server
// to re-convert the affected courseware once per upload batch; the server caps
// each call, so keep asking while work remains.
async function regenerateFonts({ force = false } = {}) {
  if (fontRegenerating || fontBusy) return;
  const requestToken = token;
  const status = $('#fontRegenerateStatus');
  fontRegenerating = true;
  setFontControls();
  status.classList.remove('is-error');
  let total = 0;
  let failedItems = [];
  let remaining = 0;
  try {
    for (let round = 0; round < 40; round++) {
      if (token !== requestToken) return;
      status.textContent = total ? `已重新生成 ${total} 个课件，继续处理…` : '正在重新生成课件…';
      const data = await fontApi(`/regenerate${force && round === 0 ? '?force=1' : ''}`, { method: 'POST' });
      if (token !== requestToken) return;
      const regenerated = Array.isArray(data.regenerated) ? data.regenerated : [];
      failedItems = Array.isArray(data.failed) ? data.failed : [];
      total += regenerated.length;
      remaining = Number(data.remaining) || 0;
      if (!data.supported) { status.textContent = '当前服务器暂不支持字体安装，未重新生成课件'; break; }
      if (!remaining || failedItems.length || !regenerated.length) break;
    }
    if (failedItems.length) {
      status.textContent = `已重新生成 ${total} 个课件，${failedItems.length} 个失败：` +
        `${failedItems.map(item => item.title).join('、')}。可点击“重新生成待更新课件”重试。`;
      status.classList.add('is-error');
    } else if (remaining) {
      status.textContent = `已重新生成 ${total} 个课件，还有 ${remaining} 个待处理，请稍后重试。`;
    } else {
      status.textContent = total ? `已重新生成 ${total} 个课件。` : '没有需要重新生成的课件。';
    }
    await loadFonts({ preserveStatus: true });
  } catch (error) {
    status.textContent = error.message;
    status.classList.add('is-error');
  } finally {
    fontRegenerating = false;
    setFontControls();
  }
}

$('#fontUploadForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (fontBusy || fontRegenerating || !fontSupported) return;
  const files = [...$('#fontFileInput').files];
  if (!files.length) return;
  const requestToken = token;
  fontBusy = true;
  setFontControls();
  $('#fontUploadResults').replaceChildren();
  $('#fontStatus').classList.remove('is-error');
  $('#fontRegenerateStatus').textContent = '';
  let succeeded = 0;
  let failed = 0;
  try {
    for (let index = 0; index < files.length; index++) {
      if (token !== requestToken) break;
      const file = files[index];
      $('#fontStatus').textContent = `正在上传并安装 ${index + 1} / ${files.length}：${file.name}`;
      const result = document.createElement('li');
      try {
        if (!/\.(ttf|otf|ttc)$/i.test(file.name)) throw new Error('仅支持 TTF、OTF、TTC');
        if (file.size > 64 * 1024 * 1024) throw new Error('单个字体不能超过 64MB');
        const body = new FormData();
        body.append('file', file);
        const data = await fontApi('', { method: 'POST', body });
        result.textContent = `${file.name}：${data.duplicate ? '已安装，无需重复上传' : '安装成功'}（${data.faces.map(face => `${face.family} ${face.style}`).join(' / ')}）`;
        result.className = 'font-result-success';
        succeeded++;
      } catch (error) {
        result.textContent = `${file.name}：${error.message}`;
        result.className = 'font-result-error';
        failed++;
      }
      if (token === requestToken) $('#fontUploadResults').appendChild(result);
    }
    if (token === requestToken) {
      $('#fontFileInput').value = '';
      $('#fontStatus').textContent = `已处理：成功 ${succeeded} 个，失败 ${failed} 个。`;
      $('#fontStatus').classList.toggle('is-error', failed > 0);
      await loadFonts({ preserveStatus: true });
    }
  } finally { fontBusy = false; setFontControls(); }
  if (token === requestToken && succeeded > 0) await regenerateFonts();
});

// --- 任教班级 / 学生名单 ---
function resetClassEditor() {
  teachingClasses = [];
  editingClass = null;
  rosterDirty = false;
  classSelectionToken++;
  drawLogRequest++;
  resetHomeworkPanel();
  $('#teachingClassList').replaceChildren();
  $('#classEditor').hidden = true;
  $('#classEditorEmpty').hidden = false;
  $('#classRoster').value = '';
  $('#editClassName').value = '';
  $('#classEditorDetails').open = false;
  $('#classRosterSummary').textContent = '';
  $('#classStudentCount').textContent = '';
  $('#classDrawLog').hidden = true;
  $('#classDrawLogList').replaceChildren();
  $('#classDrawLogCount').textContent = '';
  $('#classDrawLogEmpty').hidden = false;
  $('#classDrawLogEmpty').textContent = '暂无抽取记录。';
}

async function classApi(route, method = 'GET', body) {
  const requestToken = token;
  const response = await fetch(`${API_BASE}/classes${route}`, {
    method, cache: 'no-store', headers: { Authorization: `Bearer ${requestToken}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  if (requestToken !== token) throw new Error('登录用户已改变，请重试');
  const data = await response.json();
  if (response.status === 401) { token = ''; localStorage.removeItem('admin_token'); showLogin(); }
  if (!response.ok) throw new Error(data.error || '班级操作失败');
  return data;
}

async function selectTeachingClass(item) {
  const selection = ++classSelectionToken;
  if (homeworkPending.size || homeworkFlushPromise) await flushAllHomework();
  if (selection !== classSelectionToken) return;
  const sameClass = Boolean(item && editingClass?.id === item.id);
  const rosterWasOpen = $('#classEditorDetails').open;
  editingClass = item;
  rosterDirty = false;
  $('#classEditor').hidden = !item;
  $('#classEditorEmpty').hidden = !!item;
  $('#classEditorError').hidden = true;
  $('#editClassName').value = item?.name || '';
  $('#classRoster').value = (item?.students || []).map(student => `${student.number}\t${student.name}`).join('\n');
  $('#classEditorDetails').open = Boolean(item) && (sameClass ? rosterWasOpen : !(item.students || []).length);
  updateRosterCount();
  resetHomeworkPanel();
  if (item) {
    $('#classHomework').hidden = false;
    prepareHomeworkPanel();
  }
  $('#classDrawLog').hidden = !item;
  drawLogRequest++;
  $('#classDrawLogList').replaceChildren();
  $('#classDrawLogCount').textContent = '';
  $('#classDrawLogEmpty').hidden = false;
  $('#classDrawLogEmpty').textContent = item ? '正在读取抽取记录…' : '暂无抽取记录。';
  if (item) {
    loadDrawLog(item.id);
    loadHomework(item.id);
  }
  renderTeachingClasses();
}

// Draw history is fetched separately from the roster: it is larger and only
// changes when the classroom draws, so it must not slow down class switching.
async function loadDrawLog(classId) {
  const request = ++drawLogRequest;
  const empty = $('#classDrawLogEmpty');
  try {
    const data = await classApi(`/${encodeURIComponent(classId)}/draw-log?limit=100`);
    if (request !== drawLogRequest) return;
    renderDrawLog(data);
  } catch (error) {
    if (request !== drawLogRequest) return;
    $('#classDrawLogList').replaceChildren();
    $('#classDrawLogCount').textContent = '';
    empty.hidden = false;
    empty.textContent = error.message;
  }
}

function renderDrawLog(data) {
  const list = $('#classDrawLogList');
  list.replaceChildren();
  const items = Array.isArray(data.items) ? data.items : [];
  for (const entry of items) {
    const row = document.createElement('li');
    const time = document.createElement('time');
    time.dateTime = entry.at || '';
    time.textContent = formatDate(entry.at);
    const student = document.createElement('strong');
    student.textContent = `${entry.number} ${entry.name}`;
    const meta = document.createElement('span');
    meta.className = 'class-draw-log-meta';
    const parts = [`第 ${entry.round} 轮`, entry.mode === 'number' ? '抽学号' : '抽姓名'];
    if (entry.remaining === 0) parts.push('本轮抽完');
    meta.textContent = parts.join(' · ');
    row.append(time, student, meta);
    list.appendChild(row);
  }
  $('#classDrawLogCount').textContent = data.total ? `共 ${data.total} 条，显示最近 ${items.length} 条` : '';
  const empty = $('#classDrawLogEmpty');
  empty.hidden = items.length > 0;
  empty.textContent = '暂无抽取记录。';
}

// --- 任教班级：作业登记与统计 ---
function localDateInput(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function homeworkDefaultTitle(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
  return match ? `${Number(match[2])}月${Number(match[3])}日作业` : `${date || ''} 作业`;
}

function updateHomeworkTitlePlaceholder() {
  const date = $('#newHomeworkDate').value || localDateInput();
  $('#newHomeworkTitle').placeholder = `留空自动命名，如 ${homeworkDefaultTitle(date)}`;
}

function updateHomeworkCreateState() {
  const button = $('#createHomeworkButton');
  button.disabled = homeworkCreating || !(editingClass?.students || []).length;
  button.textContent = homeworkCreating ? '正在创建…' : '新建并开始登记';
}

function prepareHomeworkPanel() {
  $('#newHomeworkDate').value = localDateInput();
  $('#newHomeworkTitle').value = '';
  updateHomeworkTitlePlaceholder();
  updateHomeworkCreateState();
  $('#homeworkSaveState').textContent = '';
  $('#homeworkSaveState').classList.remove('is-error');
}

function resetHomeworkPanel() {
  homeworkListRequest++;
  homeworkDetailRequest++;
  homeworkStatsRequest++;
  clearTimeout(homeworkFlushTimer);
  homeworkFlushTimer = null;
  homeworkPending.clear();
  homeworkAssignments = [];
  homeworkCurrent = null;
  homeworkStatuses = [];
  homeworkStatusSettingsOpen = false;
  homeworkStatusBusy = false;
  homeworkStatusListRequest++;
  homeworkStatsData = null;
  homeworkStatsOpen = false;
  homeworkSaveToken++;
  $('#classHomework').hidden = true;
  $('#classHomeworkTitle').textContent = '';
  $('#homeworkEmpty').hidden = true;
  $('#homeworkEmpty').textContent = '';
  $('#homeworkRegister').hidden = true;
  $('#homeworkDateWarning').hidden = true;
  $('#homeworkDateWarning').textContent = '';
  $('#homeworkRosterEmpty').hidden = true;
  $('#homeworkStatusSettings').hidden = true;
  $('#homeworkStatusList').replaceChildren();
  $('#newHomeworkStatusLabel').value = '';
  $('#newHomeworkStatusTone').value = 'blue';
  $('#createHomeworkStatusButton').disabled = false;
  $('#homeworkStudents').replaceChildren();
  $('#homeworkStudents').hidden = false;
  $('#homeworkSelect').replaceChildren();
  $('#homeworkSelect').disabled = true;
  $('#homeworkCounts').textContent = '';
  $('#homeworkSaveState').textContent = '';
  $('#homeworkSaveState').classList.remove('is-error');
  $('#homeworkProgressFill').style.width = '0%';
  $('#homeworkProgress').setAttribute('aria-valuenow', '0');
  $('#toggleHomeworkStatusSettingsButton').textContent = '状态设置';
  $('#toggleHomeworkStatusSettingsButton').setAttribute('aria-expanded', 'false');
  $('#toggleHomeworkStatusSettingsButton').disabled = true;
  $('#toggleHomeworkStatsButton').textContent = '历次作业统计';
  $('#toggleHomeworkStatsButton').setAttribute('aria-expanded', 'false');
  $('#toggleHomeworkStatsButton').disabled = true;
  $('#deleteHomeworkButton').disabled = true;
  $('#homeworkStats').hidden = true;
  $('#homeworkStatsStatus').textContent = '';
  $('#homeworkStatsStatus').classList.remove('is-error');
  $('#homeworkStatsSummary').replaceChildren();
  $('#homeworkStatsTables').replaceChildren();
  $('#exportHomeworkStatsButton').disabled = true;
}

function activeHomeworkStatuses() {
  return homeworkStatuses.filter(status => !status.archived);
}

function findHomeworkStatus(statusId) {
  return homeworkStatuses.find(status => status.id === statusId) || null;
}

function homeworkRecord(records, number) {
  if (!records || !Object.prototype.hasOwnProperty.call(records, number)) return null;
  const status = records[number];
  return homeworkStatuses.some(entry => entry.id === status) ? status : null;
}

function setHomeworkRecord(records, number, status) {
  if (status === null) { delete records[number]; return; }
  Object.defineProperty(records, number, { value: status, enumerable: true, configurable: true, writable: true });
}

function countHomework(students, records) {
  const counts = { recorded: 0, unmarked: 0, total: students.length };
  for (const status of homeworkStatuses) counts[status.id] = 0;
  for (const student of students) {
    const status = homeworkRecord(records, student.number);
    if (!status) continue;
    counts[status] = (counts[status] || 0) + 1;
    counts.recorded++;
  }
  counts.unmarked = counts.total - counts.recorded;
  return counts;
}

async function loadHomework(classId, preferredId) {
  const request = ++homeworkListRequest;
  closeHomeworkStats(true);
  closeHomeworkStatusSettings();
  homeworkAssignments = [];
  homeworkCurrent = null;
  homeworkStatuses = [];
  homeworkStatsData = null;
  $('#classHomeworkTitle').textContent = '';
  $('#homeworkRegister').hidden = true;
  $('#homeworkSelect').replaceChildren();
  $('#homeworkSelect').disabled = true;
  $('#toggleHomeworkStatusSettingsButton').disabled = true;
  $('#toggleHomeworkStatsButton').disabled = true;
  $('#deleteHomeworkButton').disabled = true;
  $('#homeworkEmpty').hidden = false;
  $('#homeworkEmpty').textContent = '正在读取作业登记…';
  try {
    const data = await classApi(`/${encodeURIComponent(classId)}/homework`);
    if (request !== homeworkListRequest || editingClass?.id !== classId) return;
    homeworkAssignments = Array.isArray(data.items) ? data.items : [];
    homeworkStatuses = Array.isArray(data.statuses) ? data.statuses : [];
    homeworkStatusListRequest++;
    if (editingClass) editingClass.homeworkCount = homeworkAssignments.length;
    const classEntry = teachingClasses.find(entry => entry.id === classId);
    if (classEntry) classEntry.homeworkCount = homeworkAssignments.length;
    renderTeachingClasses();
    renderHomeworkSelect();
    renderHomeworkStatusSettings();
    $('#toggleHomeworkStatusSettingsButton').disabled = false;
    if (!homeworkAssignments.length) {
      $('#homeworkEmpty').hidden = false;
      $('#homeworkEmpty').textContent = (editingClass?.students || []).length
        ? '还没有作业登记。填好日期和名称后，点“新建并开始登记”。'
        : '这个班级还没有学生，请先在上方录入并保存名单，再登记作业。';
      return;
    }
    $('#homeworkEmpty').hidden = true;
    const chosen = homeworkAssignments.find(entry => entry.id === preferredId) || homeworkAssignments[0];
    await openHomework(chosen.id, request);
  } catch (error) {
    if (request !== homeworkListRequest || editingClass?.id !== classId) return;
    $('#homeworkEmpty').hidden = false;
    $('#homeworkEmpty').textContent = error.message;
  }
}

async function openHomework(homeworkId, listRequest = homeworkListRequest) {
  const classId = editingClass?.id;
  if (!classId) return;
  const request = ++homeworkDetailRequest;
  closeHomeworkStats(true);
  try {
    const data = await classApi(`/${encodeURIComponent(classId)}/homework/${encodeURIComponent(homeworkId)}`);
    if (request !== homeworkDetailRequest || listRequest !== homeworkListRequest || editingClass?.id !== classId) return;
    homeworkCurrent = data.item;
    renderHomeworkRegister();
  } catch (error) {
    if (request !== homeworkDetailRequest || listRequest !== homeworkListRequest || editingClass?.id !== classId) return;
    homeworkCurrent = null;
    $('#homeworkRegister').hidden = true;
    $('#homeworkEmpty').hidden = false;
    $('#homeworkEmpty').textContent = error.message;
  }
}

function renderHomeworkSelect() {
  const select = $('#homeworkSelect');
  select.replaceChildren();
  for (const entry of homeworkAssignments) {
    const option = document.createElement('option');
    option.value = entry.id;
    option.textContent = `${entry.date} ${entry.title}`;
    select.appendChild(option);
  }
  select.disabled = !homeworkAssignments.length;
  $('#toggleHomeworkStatsButton').disabled = !homeworkAssignments.length;
  updateHomeworkCreateState();
}

function renderHomeworkRegister() {
  const item = homeworkCurrent;
  if (!item) return;
  if (!item.records || typeof item.records !== 'object' || Array.isArray(item.records)) item.records = {};
  closeHomeworkStats(true);
  $('#homeworkEmpty').hidden = true;
  $('#homeworkRegister').hidden = false;
  $('#classHomeworkTitle').textContent = `${item.date} ${item.title}`;
  $('#homeworkSelect').value = item.id;
  $('#deleteHomeworkButton').disabled = false;
  $('#toggleHomeworkStatusSettingsButton').disabled = false;
  $('#toggleHomeworkStatsButton').disabled = false;
  const today = localDateInput();
  const warning = $('#homeworkDateWarning');
  warning.hidden = item.date === today;
  warning.textContent = item.date === today
    ? ''
    : `当前选中的是 ${item.date} 的作业；如果这是今天刚改完的新作业，请先在上方“新建并开始登记”。`;
  const students = editingClass?.students || [];
  $('#homeworkRosterEmpty').hidden = students.length > 0;
  $('#homeworkStudents').hidden = students.length === 0;
  renderHomeworkStudents();
  updateHomeworkCounts();
  updateHomeworkCreateState();
}

function renderHomeworkStudents() {
  const container = $('#homeworkStudents');
  container.replaceChildren();
  const students = editingClass?.students || [];
  const records = homeworkCurrent?.records || {};
  for (const student of students) {
    const row = document.createElement('div');
    row.className = 'homework-student';
    row.dataset.number = student.number;
    const status = homeworkRecord(records, student.number);
    row.classList.toggle('has-record', Boolean(status));

    const name = document.createElement('span');
    name.className = 'homework-student-name';
    const number = document.createElement('span');
    number.className = 'homework-student-number';
    number.textContent = student.number;
    const label = document.createElement('span');
    label.textContent = student.name;
    name.append(number, label);

    const group = document.createElement('span');
    group.className = 'homework-statuses';
    const activeStatuses = activeHomeworkStatuses();
    for (const option of activeStatuses) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `homework-status tone-${option.tone}`;
      button.dataset.status = option.id;
      button.textContent = option.label;
      button.title = `${option.label}（再次点击取消登记）`;
      button.setAttribute('aria-label', `${student.number} ${student.name} ${option.label}`);
      button.setAttribute('aria-pressed', String(status === option.id));
      button.addEventListener('click', () => chooseHomeworkStatus(student.number, option.id));
      group.appendChild(button);
    }
    if (status && !activeStatuses.some(option => option.id === status)) {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'homework-status homework-status-clear';
      clear.textContent = '清除';
      clear.title = '该状态已停用，点击清除这条历史登记';
      clear.setAttribute('aria-label', `${student.number} ${student.name} 清除已停用状态`);
      clear.addEventListener('click', () => chooseHomeworkStatus(student.number, status));
      group.appendChild(clear);
    }
    row.append(name, group);
    container.appendChild(row);
  }
}

function updateHomeworkStudentRow(number) {
  const row = Array.from($('#homeworkStudents').children).find(element => element.dataset.number === number);
  if (!row) return;
  const status = homeworkRecord(homeworkCurrent?.records, number);
  row.querySelectorAll('.homework-status').forEach(button => {
    if (button.dataset.status) button.setAttribute('aria-pressed', String(button.dataset.status === status));
  });
  const clear = row.querySelector('.homework-status-clear');
  if (clear) {
    const active = status && activeHomeworkStatuses().some(option => option.id === status);
    clear.hidden = !status || Boolean(active);
  }
  row.classList.toggle('has-record', Boolean(status));
}

function updateHomeworkCounts() {
  const counts = countHomework(editingClass?.students || [], homeworkCurrent?.records || {});
  const parts = [`已登记 ${counts.recorded} / ${counts.total}`];
  for (const status of homeworkStatuses) {
    if (status.archived && !(counts[status.id] > 0)) continue;
    parts.push(`${status.label} ${counts[status.id] || 0}${status.archived ? '（停用）' : ''}`);
  }
  $('#homeworkCounts').textContent = parts.join(' · ');
  const percent = counts.total ? Math.round(counts.recorded / counts.total * 100) : 0;
  $('#homeworkProgressFill').style.width = `${percent}%`;
  $('#homeworkProgress').setAttribute('aria-valuenow', String(percent));
}

function closeHomeworkStatusSettings() {
  homeworkStatusSettingsOpen = false;
  $('#homeworkStatusSettings').hidden = true;
  $('#toggleHomeworkStatusSettingsButton').textContent = '状态设置';
  $('#toggleHomeworkStatusSettingsButton').setAttribute('aria-expanded', 'false');
}

function toggleHomeworkStatusSettings() {
  if (!editingClass) return;
  if (homeworkStatusSettingsOpen) {
    closeHomeworkStatusSettings();
    return;
  }
  homeworkStatusSettingsOpen = true;
  $('#homeworkStatusSettings').hidden = false;
  $('#toggleHomeworkStatusSettingsButton').textContent = '收起状态设置';
  $('#toggleHomeworkStatusSettingsButton').setAttribute('aria-expanded', 'true');
  renderHomeworkStatusSettings();
  refreshHomeworkStatusList();
}

async function refreshHomeworkStatusList() {
  const classId = editingClass?.id;
  if (!classId) return;
  const request = ++homeworkStatusListRequest;
  try {
    const data = await classApi(`/${encodeURIComponent(classId)}/homework-statuses`);
    if (request !== homeworkStatusListRequest || editingClass?.id !== classId) return;
    homeworkStatuses = Array.isArray(data.items) ? data.items : [];
    renderHomeworkStatusSettings();
    if (homeworkCurrent) {
      renderHomeworkStudents();
      updateHomeworkCounts();
    }
  } catch (error) {
    if (request !== homeworkStatusListRequest) return;
    toast(error.message, 'error');
  }
}

function homeworkToneSelect(selected) {
  const select = document.createElement('select');
  select.className = 'homework-status-tone';
  select.setAttribute('aria-label', '状态颜色');
  for (const option of HOMEWORK_STATUS_TONES) {
    const item = document.createElement('option');
    item.value = option.id;
    item.textContent = option.label;
    item.selected = option.id === selected;
    select.appendChild(item);
  }
  return select;
}

function renderHomeworkStatusSettings() {
  const list = $('#homeworkStatusList');
  if (!list) return;
  list.replaceChildren();
  const activeCount = activeHomeworkStatuses().length;
  for (const status of homeworkStatuses) {
    const row = document.createElement('li');
    row.className = `homework-status-row${status.archived ? ' is-archived' : ''}`;
    row.dataset.statusId = status.id;

    const preview = document.createElement('span');
    preview.className = `homework-status-preview tone-${status.tone}`;
    preview.textContent = status.label;

    const label = document.createElement('input');
    label.className = 'homework-status-label';
    label.value = status.label;
    label.maxLength = 12;
    label.autocomplete = 'off';
    label.disabled = homeworkStatusBusy;
    label.setAttribute('aria-label', `状态名称：${status.label}`);

    const tone = homeworkToneSelect(status.tone);
    tone.disabled = homeworkStatusBusy;
    tone.setAttribute('aria-label', `状态颜色：${status.label}`);

    const usage = document.createElement('span');
    usage.className = 'homework-status-usage';
    usage.textContent = status.archived
      ? `已停用 · 历史 ${status.usage || 0} 条`
      : `已用于 ${status.usage || 0} 条记录`;

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn-secondary homework-status-row-action';
    save.textContent = '保存';
    save.disabled = homeworkStatusBusy;
    save.addEventListener('click', () => saveHomeworkStatus(status.id, label.value, tone.value));

    const action = document.createElement('button');
    action.type = 'button';
    action.className = `btn-secondary homework-status-row-action${status.archived ? '' : ' is-danger'}`;
    action.textContent = status.archived ? '恢复' : '停用';
    action.disabled = homeworkStatusBusy;
    if (!status.archived && activeCount <= 1) {
      action.disabled = true;
      action.title = '至少保留一个可用的作业状态';
    } else if (status.archived && activeCount >= HOMEWORK_STATUS_LIMIT) {
      action.disabled = true;
      action.title = `最多同时启用 ${HOMEWORK_STATUS_LIMIT} 个作业状态`;
    }
    action.addEventListener('click', () => (status.archived
      ? restoreHomeworkStatus(status)
      : removeHomeworkStatus(status)));

    label.addEventListener('input', () => { preview.textContent = label.value || '未命名'; });
    label.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      saveHomeworkStatus(status.id, label.value, tone.value);
    });
    tone.addEventListener('change', () => {
      preview.className = `homework-status-preview tone-${tone.value}`;
    });

    row.append(preview, label, tone, usage, save, action);
    list.appendChild(row);
  }
  $('#newHomeworkStatusLabel').disabled = homeworkStatusBusy;
  $('#newHomeworkStatusTone').disabled = homeworkStatusBusy;
  $('#createHomeworkStatusButton').disabled = homeworkStatusBusy || activeCount >= HOMEWORK_STATUS_LIMIT;
}

function applyHomeworkStatuses(items) {
  homeworkStatuses = Array.isArray(items) ? items : [];
  renderHomeworkStatusSettings();
  if (homeworkCurrent) {
    renderHomeworkStudents();
    updateHomeworkCounts();
  }
  if (homeworkStatsOpen) loadHomeworkStats({ silent: true });
}

async function saveHomeworkStatus(statusId, label, tone) {
  if (homeworkStatusBusy || !editingClass) return;
  const classId = editingClass.id;
  homeworkStatusListRequest++;
  const name = label.trim();
  if (!name) { toast('状态名称不能为空', 'error'); return; }
  homeworkStatusBusy = true;
  renderHomeworkStatusSettings();
  try {
    await flushAllHomework();
    const data = await classApi(`/${encodeURIComponent(classId)}/homework-statuses/${encodeURIComponent(statusId)}`, 'PUT', {
      label: name, tone
    });
    if (editingClass?.id !== classId) return;
    applyHomeworkStatuses(data.items);
    toast('作业状态已更新', 'success');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    if (editingClass?.id === classId) {
      homeworkStatusBusy = false;
      renderHomeworkStatusSettings();
    }
  }
}

async function removeHomeworkStatus(status) {
  if (homeworkStatusBusy || !editingClass) return;
  const classId = editingClass.id;
  homeworkStatusListRequest++;
  const message = status.usage > 0
    ? `“${status.label}”已用于 ${status.usage} 条历史记录。停用后不再显示登记按钮，但历史统计仍会保留。确定停用吗？`
    : `确定删除“${status.label}”这个作业状态按钮吗？`;
  if (!confirm(message)) return;
  homeworkStatusBusy = true;
  renderHomeworkStatusSettings();
  try {
    await flushAllHomework();
    const data = await classApi(`/${encodeURIComponent(classId)}/homework-statuses/${encodeURIComponent(status.id)}`, 'DELETE');
    if (editingClass?.id !== classId) return;
    applyHomeworkStatuses(data.items);
    toast(data.archived ? '状态已停用，历史记录保留' : '状态已删除', 'success');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    if (editingClass?.id === classId) {
      homeworkStatusBusy = false;
      renderHomeworkStatusSettings();
    }
  }
}

async function restoreHomeworkStatus(status) {
  if (homeworkStatusBusy || !editingClass) return;
  const classId = editingClass.id;
  homeworkStatusListRequest++;
  homeworkStatusBusy = true;
  renderHomeworkStatusSettings();
  try {
    await flushAllHomework();
    const data = await classApi(`/${encodeURIComponent(classId)}/homework-statuses/${encodeURIComponent(status.id)}`, 'PUT', {
      archived: false
    });
    if (editingClass?.id !== classId) return;
    applyHomeworkStatuses(data.items);
    toast('状态已恢复', 'success');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    if (editingClass?.id === classId) {
      homeworkStatusBusy = false;
      renderHomeworkStatusSettings();
    }
  }
}

async function createHomeworkStatus(event) {
  event.preventDefault();
  if (homeworkStatusBusy || !editingClass) return;
  if (activeHomeworkStatuses().length >= HOMEWORK_STATUS_LIMIT) {
    toast(`最多同时启用 ${HOMEWORK_STATUS_LIMIT} 个作业状态`, 'error');
    return;
  }
  const classId = editingClass.id;
  homeworkStatusListRequest++;
  const input = $('#newHomeworkStatusLabel');
  const label = input.value.trim();
  if (!label) { toast('请输入状态名称', 'error'); return; }
  homeworkStatusBusy = true;
  renderHomeworkStatusSettings();
  try {
    await flushAllHomework();
    const data = await classApi(`/${encodeURIComponent(classId)}/homework-statuses`, 'POST', {
      label, tone: $('#newHomeworkStatusTone').value
    });
    if (editingClass?.id !== classId) return;
    input.value = '';
    applyHomeworkStatuses(data.items);
    toast('作业状态已新增', 'success');
    input.focus();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    if (editingClass?.id === classId) {
      homeworkStatusBusy = false;
      renderHomeworkStatusSettings();
    }
  }
}

function applyHomeworkRecord(number, status) {
  if (!homeworkCurrent) return;
  if (!homeworkCurrent.records || typeof homeworkCurrent.records !== 'object' || Array.isArray(homeworkCurrent.records)) {
    homeworkCurrent.records = {};
  }
  setHomeworkRecord(homeworkCurrent.records, number, status);
  updateHomeworkStudentRow(number);
  updateHomeworkCounts();
}

function chooseHomeworkStatus(number, status) {
  if (!homeworkCurrent) return;
  const previous = homeworkRecord(homeworkCurrent.records, number);
  const next = previous === status ? null : status;
  if (next === previous) return;
  applyHomeworkRecord(number, next);
  const queued = homeworkPending.get(number);
  homeworkPending.set(number, { status: next, previous: queued ? queued.previous : previous });
  setHomeworkSaveState('保存中…');
  scheduleHomeworkFlush();
}

function setHomeworkSaveState(text, isError = false) {
  const element = $('#homeworkSaveState');
  const token = ++homeworkSaveToken;
  element.textContent = text;
  element.classList.toggle('is-error', isError);
  if (!isError && text === '已保存') {
    setTimeout(() => {
      if (token === homeworkSaveToken) element.textContent = '';
    }, 2000);
  }
}

function scheduleHomeworkFlush() {
  clearTimeout(homeworkFlushTimer);
  homeworkFlushTimer = setTimeout(() => {
    homeworkFlushTimer = null;
    flushHomework();
  }, HOMEWORK_FLUSH_DELAY);
}

function flushHomework() {
  if (homeworkFlushPromise) return homeworkFlushPromise;
  if (!homeworkPending.size || !homeworkCurrent || !editingClass) return Promise.resolve();
  clearTimeout(homeworkFlushTimer);
  homeworkFlushTimer = null;
  const classId = editingClass.id;
  const homeworkId = homeworkCurrent.id;
  const changes = new Map(homeworkPending);
  homeworkPending.clear();
  const records = {};
  for (const [number, change] of changes) {
    Object.defineProperty(records, number, { value: change.status, enumerable: true, configurable: true, writable: true });
  }
  setHomeworkSaveState('保存中…');
  homeworkFlushPromise = (async () => {
    try {
      const data = await classApi(`/${encodeURIComponent(classId)}/homework/${encodeURIComponent(homeworkId)}`, 'PATCH', { records });
      if (editingClass?.id === classId && homeworkCurrent?.id === homeworkId) {
        const summary = homeworkAssignments.find(entry => entry.id === homeworkId);
        if (summary) summary.counts = data.counts;
        setHomeworkSaveState('已保存');
        if (homeworkStatsOpen) loadHomeworkStats({ silent: true });
      }
    } catch (error) {
      if (editingClass?.id === classId && homeworkCurrent?.id === homeworkId) {
        for (const [number, change] of changes) {
          if (homeworkPending.has(number)) continue;
          if (homeworkRecord(homeworkCurrent.records, number) !== change.status) continue;
          applyHomeworkRecord(number, change.previous);
        }
        setHomeworkSaveState('保存失败，请重试', true);
      }
      toast(error.message, 'error');
    } finally {
      homeworkFlushPromise = null;
      if (homeworkPending.size) scheduleHomeworkFlush();
    }
  })();
  return homeworkFlushPromise;
}

async function flushAllHomework() {
  for (let attempt = 0; attempt < 10; attempt++) {
    if (homeworkFlushPromise) { await homeworkFlushPromise; continue; }
    if (!homeworkPending.size) return;
    if (!homeworkCurrent || !editingClass) return;
    await flushHomework();
  }
}

function closeHomeworkStats(clear) {
  homeworkStatsOpen = false;
  homeworkStatsRequest++;
  $('#homeworkStats').hidden = true;
  $('#toggleHomeworkStatsButton').textContent = '历次作业统计';
  $('#toggleHomeworkStatsButton').setAttribute('aria-expanded', 'false');
  if (clear) {
    homeworkStatsData = null;
    $('#homeworkStatsSummary').replaceChildren();
    $('#homeworkStatsTables').replaceChildren();
    $('#homeworkStatsStatus').textContent = '';
    $('#homeworkStatsStatus').classList.remove('is-error');
    $('#exportHomeworkStatsButton').disabled = true;
  }
}

async function loadHomeworkStats({ silent = false } = {}) {
  const classId = editingClass?.id;
  if (!classId) return;
  const request = ++homeworkStatsRequest;
  const status = $('#homeworkStatsStatus');
  if (!silent) {
    status.textContent = '正在统计…';
    status.classList.remove('is-error');
  }
  $('#refreshHomeworkStatsButton').disabled = true;
  try {
    const data = await classApi(`/${encodeURIComponent(classId)}/homework/stats`);
    if (request !== homeworkStatsRequest || editingClass?.id !== classId) return;
    if (Array.isArray(data.statuses)) homeworkStatuses = data.statuses;
    homeworkStatsData = data;
    renderHomeworkStats(data);
    status.textContent = silent ? '' : '统计已更新。';
    status.classList.remove('is-error');
  } catch (error) {
    if (request !== homeworkStatsRequest || editingClass?.id !== classId) return;
    status.textContent = error.message;
    status.classList.add('is-error');
  } finally {
    if (request === homeworkStatsRequest) $('#refreshHomeworkStatsButton').disabled = false;
  }
}

function statsTableRow(cellTag, values) {
  const row = document.createElement('tr');
  for (const value of values) {
    const cell = document.createElement(cellTag);
    if (value instanceof Node) cell.appendChild(value);
    else cell.textContent = String(value);
    row.appendChild(cell);
  }
  return row;
}

function statsTableScroll(table) {
  const wrapper = document.createElement('div');
  wrapper.className = 'table-scroll';
  wrapper.appendChild(table);
  return wrapper;
}

function homeworkBadge(statusId) {
  const status = findHomeworkStatus(statusId);
  const badge = document.createElement('span');
  if (!status) {
    badge.className = 'homework-badge';
    badge.textContent = '已删除';
    return badge;
  }
  badge.className = `homework-badge tone-${status.tone}${status.archived ? ' is-archived' : ''}`;
  badge.textContent = status.label;
  if (status.archived) badge.title = '该状态已停用，历史记录保留';
  return badge;
}

function homeworkStatusHeading(status) {
  return status.archived ? `${status.label}（停用）` : status.label;
}

function renderHomeworkStats(data) {
  const assignments = Array.isArray(data.assignments) ? data.assignments : [];
  const students = Array.isArray(data.students) ? data.students : [];
  const statuses = Array.isArray(data.statuses) ? data.statuses : [];
  const totals = data.totals || {};
  const summary = $('#homeworkStatsSummary');
  summary.replaceChildren();
  const cards = [
    ['作业次数', assignments.length],
    ['已登记', `${totals.recorded || 0} / ${totals.total || 0}`],
    ...statuses.map(status => [homeworkStatusHeading(status), totals[status.id] || 0]),
    ['未登记', totals.unmarked || 0]
  ];
  for (const [label, value] of cards) {
    const card = document.createElement('div');
    card.className = 'homework-stat-card';
    const title = document.createElement('span');
    title.textContent = label;
    const number = document.createElement('strong');
    number.textContent = String(value);
    card.append(title, number);
    summary.appendChild(card);
  }

  const container = $('#homeworkStatsTables');
  container.replaceChildren();

  const assignmentHeading = document.createElement('h4');
  assignmentHeading.textContent = '各次作业汇总';
  const assignmentTable = document.createElement('table');
  assignmentTable.className = 'data-table homework-assignment-table';
  const assignmentHead = document.createElement('thead');
  assignmentHead.appendChild(statsTableRow('th', [
    '日期', '作业名称', ...statuses.map(homeworkStatusHeading), '未登记', '已登记'
  ]));
  assignmentTable.appendChild(assignmentHead);
  const assignmentBody = document.createElement('tbody');
  for (const assignment of assignments) {
    const counts = assignment.counts || {};
    assignmentBody.appendChild(statsTableRow('td', [
      assignment.date, assignment.title,
      ...statuses.map(status => counts[status.id] || 0),
      counts.unmarked || 0, `${counts.recorded || 0} / ${counts.total || 0}`
    ]));
  }
  assignmentTable.appendChild(assignmentBody);
  const assignmentFoot = document.createElement('tfoot');
  assignmentFoot.appendChild(statsTableRow('td', [
    '合计', '',
    ...statuses.map(status => totals[status.id] || 0),
    totals.unmarked || 0, `${totals.recorded || 0} / ${totals.total || 0}`
  ]));
  assignmentTable.appendChild(assignmentFoot);
  container.append(assignmentHeading, statsTableScroll(assignmentTable));

  const studentHeading = document.createElement('h4');
  studentHeading.textContent = '学生历次作业明细';
  const matrix = document.createElement('table');
  matrix.className = 'data-table homework-matrix';
  const matrixHead = document.createElement('thead');
  const matrixHeadRow = document.createElement('tr');
  const studentTh = document.createElement('th');
  studentTh.scope = 'col';
  studentTh.textContent = '学生';
  matrixHeadRow.appendChild(studentTh);
  for (const assignment of assignments) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.title = `${assignment.date} ${assignment.title}`;
    const date = document.createElement('span');
    date.className = 'homework-matrix-date';
    date.textContent = assignment.date.slice(5);
    const title = document.createElement('span');
    title.className = 'homework-matrix-title';
    title.textContent = assignment.title;
    th.append(date, title);
    matrixHeadRow.appendChild(th);
  }
  for (const status of statuses) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = homeworkStatusHeading(status);
    matrixHeadRow.appendChild(th);
  }
  const unmarkedTh = document.createElement('th');
  unmarkedTh.scope = 'col';
  unmarkedTh.textContent = '未登记';
  matrixHeadRow.appendChild(unmarkedTh);
  matrixHead.appendChild(matrixHeadRow);
  matrix.appendChild(matrixHead);

  const matrixBody = document.createElement('tbody');
  for (const student of students) {
    const row = document.createElement('tr');
    const studentCell = document.createElement('td');
    const number = document.createElement('span');
    number.className = 'homework-student-number';
    number.textContent = student.number;
    const name = document.createElement('span');
    name.textContent = student.name;
    studentCell.append(number, name);
    row.appendChild(studentCell);
    for (const status of student.records || []) {
      const cell = document.createElement('td');
      if (status && findHomeworkStatus(status)) cell.appendChild(homeworkBadge(status));
      else {
        const empty = document.createElement('span');
        empty.className = 'homework-unmarked';
        empty.textContent = '—';
        cell.appendChild(empty);
      }
      row.appendChild(cell);
    }
    for (const status of statuses) {
      const cell = document.createElement('td');
      cell.textContent = String(student.totals?.[status.id] || 0);
      row.appendChild(cell);
    }
    const unmarkedCell = document.createElement('td');
    unmarkedCell.textContent = String(student.totals?.unmarked || 0);
    row.appendChild(unmarkedCell);
    matrixBody.appendChild(row);
  }
  matrix.appendChild(matrixBody);
  if (assignments.length && students.length) {
    const matrixFoot = document.createElement('tfoot');
    const footRow = document.createElement('tr');
    const label = document.createElement('td');
    label.textContent = '合计';
    footRow.appendChild(label);
    for (const assignment of assignments) {
      const counts = assignment.counts || {};
      const cell = document.createElement('td');
      cell.textContent = `${counts.recorded || 0}/${counts.total || 0}`;
      footRow.appendChild(cell);
    }
    for (const status of statuses) {
      const cell = document.createElement('td');
      cell.textContent = String(totals[status.id] || 0);
      footRow.appendChild(cell);
    }
    const unmarkedCell = document.createElement('td');
    unmarkedCell.textContent = String(totals.unmarked || 0);
    footRow.appendChild(unmarkedCell);
    matrixFoot.appendChild(footRow);
    matrix.appendChild(matrixFoot);
  }
  container.append(studentHeading, statsTableScroll(matrix));
  const note = document.createElement('p');
  note.className = 'class-help homework-stats-note';
  note.textContent = '“未登记”表示该次作业没有点选任何状态；已停用的状态不再显示登记按钮，但历史统计仍保留。名单中已删除的学生不计入统计，重新加入同一学号后会恢复显示历史记录。表格较宽时可左右滑动查看。';
  container.appendChild(note);
  $('#exportHomeworkStatsButton').disabled = false;
}

function csvCell(value) {
  const text = String(value ?? '');
  // Keep student numbers such as "01" as text when Excel opens the CSV.
  if (/^0\d+$/.test(text)) return `"=""${text}"""`;
  const guarded = text.replace(/^[=+@\-\t\r]/, match => `'${match}`);
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

function sanitizeFilename(value) {
  return String(value || '').replace(/[\\/:*?"<>|]/g, '_').trim() || '班级';
}

function exportHomeworkStatsCsv() {
  const data = homeworkStatsData;
  if (!data || !editingClass) return;
  const statuses = Array.isArray(data.statuses) ? data.statuses : [];
  const statusLabels = new Map(statuses.map(status => [status.id, status.label]));
  const statusHeadings = statuses.map(homeworkStatusHeading);
  const lines = [
    [`${editingClass.name} 作业统计`, `导出时间 ${new Date().toLocaleString('zh-CN')}`],
    [],
    ['日期', '作业名称', ...statusHeadings, '未登记', '已登记']
  ];
  for (const assignment of data.assignments || []) {
    const counts = assignment.counts || {};
    lines.push([assignment.date, assignment.title,
      ...statuses.map(status => counts[status.id] || 0),
      counts.unmarked || 0, `${counts.recorded || 0}/${counts.total || 0}`]);
  }
  const totals = data.totals || {};
  lines.push(['合计', '',
    ...statuses.map(status => totals[status.id] || 0),
    totals.unmarked || 0, `${totals.recorded || 0}/${totals.total || 0}`]);
  lines.push([]);
  lines.push(['学号', '姓名', ...(data.assignments || []).map(assignment => `${assignment.date} ${assignment.title}`),
    ...statusHeadings, '未登记']);
  for (const student of data.students || []) {
    const studentTotals = student.totals || {};
    lines.push([student.number, student.name,
      ...(student.records || []).map(status => statusLabels.get(status) || '未登记'),
      ...statuses.map(status => studentTotals[status.id] || 0),
      studentTotals.unmarked || 0]);
  }
  const csv = `\ufeff${lines.map(row => row.map(csvCell).join(',')).join('\r\n')}`;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${sanitizeFilename(editingClass.name)}-作业统计-${localDateInput()}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function createHomework(event) {
  event.preventDefault();
  if (!editingClass || homeworkCreating) return;
  const date = $('#newHomeworkDate').value;
  if (!date) { toast('请选择作业日期', 'error'); return; }
  const titleInput = $('#newHomeworkTitle');
  const title = titleInput.value.trim() || homeworkDefaultTitle(date);
  const classId = editingClass.id;
  homeworkCreating = true;
  updateHomeworkCreateState();
  try {
    await flushAllHomework();
    const data = await classApi(`/${encodeURIComponent(classId)}/homework`, 'POST', { title, date });
    titleInput.value = '';
    if (editingClass?.id !== classId) return;
    await loadHomework(classId, data.item.id);
    toast('已新建作业，可以开始登记了', 'success');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    homeworkCreating = false;
    updateHomeworkCreateState();
  }
}

async function deleteCurrentHomework() {
  if (!editingClass || !homeworkCurrent) return;
  const classId = editingClass.id;
  const homework = homeworkCurrent;
  if (!confirm(`确定删除“${homework.date} ${homework.title}”的作业登记？该次记录将无法恢复。`)) return;
  clearTimeout(homeworkFlushTimer);
  homeworkFlushTimer = null;
  homeworkPending.clear();
  if (homeworkFlushPromise) await homeworkFlushPromise;
  try {
    await classApi(`/${encodeURIComponent(classId)}/homework/${encodeURIComponent(homework.id)}`, 'DELETE');
    if (editingClass?.id !== classId) return;
    const next = homeworkAssignments.find(entry => entry.id !== homework.id);
    await loadHomework(classId, next?.id);
    toast('本次作业记录已删除', 'success');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function toggleHomeworkStats() {
  if (!editingClass || !homeworkAssignments.length) return;
  if (homeworkStatsOpen) {
    closeHomeworkStats(true);
    return;
  }
  homeworkStatsOpen = true;
  $('#homeworkStats').hidden = false;
  $('#toggleHomeworkStatsButton').textContent = '收起统计';
  $('#toggleHomeworkStatsButton').setAttribute('aria-expanded', 'true');
  await flushAllHomework();
  await loadHomeworkStats();
  $('#homeworkStats').scrollIntoView({ block: 'nearest' });
}

function renderTeachingClasses() {
  const list = $('#teachingClassList');
  list.replaceChildren();
  teachingClasses.forEach(item => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `teaching-class-button${editingClass?.id === item.id ? ' is-active' : ''}`;
    const homeworkCount = Number(item.homeworkCount) || 0;
    button.textContent = `${item.name} · ${item.students.length} 人${homeworkCount ? ` · ${homeworkCount} 次作业` : ''}`;
    button.setAttribute('aria-pressed', String(editingClass?.id === item.id));
    button.addEventListener('click', () => {
      if (classBusy || (rosterDirty && !confirm('名单尚未保存，确定切换并放弃修改吗？'))) return;
      selectTeachingClass(item);
    });
    list.appendChild(button);
  });
}

async function loadTeachingClasses(selectedId = editingClass?.id) {
  try {
    const data = await classApi('');
    teachingClasses = data.items;
    await selectTeachingClass(teachingClasses.find(item => item.id === selectedId) || teachingClasses[0] || null);
  } catch (error) { toast(error.message, 'error'); }
}

function updateRosterCount() {
  let summary;
  try {
    const count = StudentRoster.parse($('#classRoster').value).length;
    const suffix = `人${rosterDirty ? ' · 未保存' : ''}`;
    $('#classStudentCount').textContent = `（${count} ${suffix}）`;
    summary = `${count} ${suffix}`;
  } catch {
    $('#classStudentCount').textContent = '（名单有待检查，保存时会提示）';
    summary = '名单有待检查';
  }
  $('#classRosterSummary').textContent = summary ? `· ${summary}` : '';
}
$('#classEditor').addEventListener('input', () => { rosterDirty = true; updateRosterCount(); });
$('#refreshClassesButton').addEventListener('click', () => {
  if (classBusy || (rosterDirty && !confirm('刷新将放弃未保存的名单修改，是否继续？'))) return;
  loadTeachingClasses();
});
$('#createClassForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (classBusy || (rosterDirty && !confirm('名单尚未保存，确定添加班级并放弃修改吗？'))) return;
  classBusy = true;
  try {
    const { item } = await classApi('', 'POST', { name: $('#newClassName').value.trim() });
    $('#newClassName').value = '';
    await loadTeachingClasses(item.id);
    toast('班级已添加，请录入学生名单', 'success');
  } catch (error) { toast(error.message, 'error'); }
  finally { classBusy = false; }
});
$('#classEditor').addEventListener('submit', async event => {
  event.preventDefault();
  if (classBusy || !editingClass) return;
  $('#classEditorError').hidden = true;
  classBusy = true;
  $('#saveClassButton').disabled = true;
  try {
    const students = StudentRoster.parse($('#classRoster').value);
    if (!students.length && editingClass.students.length && !confirm('保存后将清空这个班级的学生名单，确定继续吗？')) return;
    await flushAllHomework();
    const { item } = await classApi(`/${editingClass.id}`, 'PUT', {
      name: $('#editClassName').value.trim(), students, revision: editingClass.revision
    });
    teachingClasses = teachingClasses.map(existing => existing.id === item.id ? item : existing);
    await selectTeachingClass(item);
    toast('班级与名单已保存', 'success');
  } catch (error) {
    $('#classEditorError').textContent = error.message;
    $('#classEditorError').hidden = false;
    $('#classEditorDetails').open = true;
  } finally { classBusy = false; $('#saveClassButton').disabled = false; }
});
$('#deleteClassButton').addEventListener('click', async () => {
  if (classBusy || !editingClass || !confirm(`确定删除“${editingClass.name}”及其全部学生名单？`)) return;
  classBusy = true;
  try {
    await flushAllHomework();
    await classApi(`/${editingClass.id}?revision=${editingClass.revision}`, 'DELETE');
    rosterDirty = false;
    await loadTeachingClasses(null);
    toast('班级已删除', 'success');
  } catch (error) { toast(error.message, 'error'); }
  finally { classBusy = false; }
});
$('#refreshDrawLogButton').addEventListener('click', () => {
  if (classBusy || !editingClass) return;
  loadDrawLog(editingClass.id);
});
$('#clearDrawLogButton').addEventListener('click', async () => {
  if (classBusy || !editingClass) return;
  if (!confirm(`确定清空“${editingClass.name}”的已抽学生记录？抽取进度不会重置。`)) return;
  classBusy = true;
  try {
    await classApi(`/${editingClass.id}/draw-log`, 'DELETE');
    await loadDrawLog(editingClass.id);
    toast('抽取记录已清空', 'success');
  } catch (error) { toast(error.message, 'error'); }
  finally { classBusy = false; }
});
$('#newHomeworkDate').addEventListener('change', updateHomeworkTitlePlaceholder);
$('#createHomeworkForm').addEventListener('submit', createHomework);
$('#homeworkSelect').addEventListener('change', () => {
  const homeworkId = $('#homeworkSelect').value;
  if (!homeworkId || homeworkId === homeworkCurrent?.id) return;
  if (homeworkPending.size) flushHomework();
  closeHomeworkStats(true);
  openHomework(homeworkId);
});
$('#deleteHomeworkButton').addEventListener('click', deleteCurrentHomework);
$('#toggleHomeworkStatusSettingsButton').addEventListener('click', toggleHomeworkStatusSettings);
$('#closeHomeworkStatusSettingsButton').addEventListener('click', closeHomeworkStatusSettings);
$('#createHomeworkStatusForm').addEventListener('submit', createHomeworkStatus);
$('#toggleHomeworkStatsButton').addEventListener('click', toggleHomeworkStats);
$('#refreshHomeworkStatsButton').addEventListener('click', async () => {
  if (!homeworkStatsOpen) return;
  await flushAllHomework();
  await loadHomeworkStats();
});
$('#exportHomeworkStatsButton').addEventListener('click', exportHomeworkStatsCsv);
window.addEventListener('beforeunload', event => {
  if (rosterDirty || homeworkPending.size) { event.preventDefault(); event.returnValue = ''; }
});

// --- Toast 提示 ---
function toast(message, type = 'info') {
  const container = $('#toastContainer');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  container.appendChild(el);
  // 触发动画
  requestAnimationFrame(() => el.classList.add('toast-show'));
  setTimeout(() => {
    el.classList.remove('toast-show');
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

// --- 工具函数 ---
function formatDate(iso) {
  if (!iso) return '-';
  try { return new Date(iso).toLocaleString('zh-CN'); } catch { return iso; }
}

function formatBytes(b) {
  if (!b) return '0B';
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)}KB`;
  return `${(b / 1024 / 1024).toFixed(1)}MB`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

setupCoursewareTable();
