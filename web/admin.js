const API_BASE = './api';
let token = localStorage.getItem('admin_token') || '';
let currentUser = null; // { id, username, role }

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
  $('#loginPanel').hidden = false;
  $('#mainPanel').hidden = true;
  $('#adminUser').textContent = '';
}

function showMain(user) {
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
    items.push({ id: 'users', label: '用户管理' });
    items.push({ id: 'courseware', label: '课件管理' });
  } else {
    items.push({ id: 'courseware', label: '我的课件' });
  }
  items.push({ id: 'account', label: '账户设置' });

  tabs.innerHTML = items.map((t, i) =>
    `<button class="tab-btn${i === 0 ? ' is-active' : ''}" data-tab="${t.id}">${t.label}</button>`
  ).join('');

  tabs.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      tabs.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      const tab = btn.dataset.tab;
      $('#tab-users').hidden = tab !== 'users';
      $('#tab-courseware').hidden = tab !== 'courseware';
      $('#tab-account').hidden = tab !== 'account';
      if (tab === 'users') loadUsers();
      if (tab === 'courseware') loadCourseware();
      if (tab === 'account') loadProfile();
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

$('#logoutButton').addEventListener('click', () => {
  token = '';
  currentUser = null;
  localStorage.removeItem('admin_token');
  showLogin();
});

// --- 回到主页（安全退出会话并跳转） ---
$('#homeButton').addEventListener('click', () => {
  token = '';
  currentUser = null;
  localStorage.removeItem('admin_token');
  window.location.href = './index.html';
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

async function loadCourseware() {
  const isAdmin = currentUser?.role === 'admin';
  // 普通用户不传 all=true，只看自己的课件
  const url = isAdmin ? '/courseware?all=true' : '/courseware';
  // 普通用户隐藏"所有者"列和"所有人可见"选项
  $('#ownerTh').hidden = !isAdmin;
  $('#shareLabel').style.display = isAdmin ? '' : 'none';
  $('#coursewareTitle').textContent = isAdmin ? '课件列表' : '我的课件';

  try {
    const data = await apiGet(url);
    const tbody = $('#coursewareTableBody');
    if (!data.items?.length) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="${isAdmin ? 6 : 5}">暂无课件</td></tr>`;
      return;
    }
    tbody.innerHTML = data.items.map((c) => `
      <tr>
        <td>${escapeHtml(c.title)}</td>
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
    fill.style.width = '100%';
    text.textContent = '上传完成';
    toast('课件上传成功', 'success');
    setTimeout(() => { prog.hidden = true; }, 1500);
    loadCourseware();
  } catch (err) {
    text.textContent = err.message;
    toast(err.message, 'error');
    fill.style.width = '0%';
  }
}

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
