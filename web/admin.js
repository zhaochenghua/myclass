const API_BASE = './api';
let token = localStorage.getItem('admin_token') || '';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

bootstrap();

async function bootstrap() {
  if (token) {
    const me = await apiGet('/auth/me');
    if (me.username) {
      showMain(me.username);
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

function showMain(username) {
  $('#loginPanel').hidden = true;
  $('#mainPanel').hidden = false;
  $('#adminUser').textContent = `当前用户：${username}`;
  loadUsers();
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
    showMain(data.username);
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
  localStorage.removeItem('admin_token');
  showLogin();
});

// --- 密码重置弹窗 ---
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
  } catch (err) {
    alert(err.message);
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

// --- 标签切换 ---
$$('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.tab-btn').forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    const tab = btn.dataset.tab;
    $('#tab-users').hidden = tab !== 'users';
    $('#tab-courseware').hidden = tab !== 'courseware';
    if (tab === 'users') loadUsers();
    if (tab === 'courseware') loadCourseware();
  });
});

// --- API ---
async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) { token = ''; localStorage.removeItem('admin_token'); showLogin(); throw new Error('登录已过期'); }
  return res.json();
}

async function apiDelete(path) {
  const res = await fetch(`${API_BASE}${path}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) { token = ''; localStorage.removeItem('admin_token'); showLogin(); throw new Error('登录已过期'); }
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
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || '操作失败'); }
  return res.json();
}

// --- 用户管理 ---
$('#refreshUsersButton').addEventListener('click', loadUsers);

async function loadUsers() {
  try {
    const data = await apiGet('/admin/users');
    const tbody = $('#userTableBody');
    if (!data.users?.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="4">暂无用户</td></tr>';
      return;
    }
    tbody.innerHTML = data.users.map((u) => {
      const isAdmin = u.username === 'admin';
      const deleteBtn = isAdmin ? '' : `<button class="btn-danger" data-delete-user="${u.id}">删除</button>`;
      return `
      <tr>
        <td>${escapeHtml(u.username)}${isAdmin ? ' <span class="badge">管理员</span>' : ''}</td>
        <td>${formatDate(u.createdAt)}</td>
        <td>${formatDate(u.lastLoginAt)}</td>
        <td>
          <button class="btn-secondary btn-sm" data-reset-pw="${u.id}" data-reset-name="${escapeHtml(u.username)}">重置密码</button>
          ${deleteBtn}
        </td>
      </tr>`;
    }).join('');
    tbody.querySelectorAll('.btn-danger').forEach((btn) => {
      btn.addEventListener('click', () => deleteUser(btn.dataset.deleteUser, btn));
    });
    tbody.querySelectorAll('[data-reset-pw]').forEach((btn) => {
      btn.addEventListener('click', () => openResetModal(btn.dataset.resetPw, btn.dataset.resetName));
    });
  } catch (err) {
    alert(err.message);
  }
}

async function deleteUser(userId, btn) {
  if (!confirm('确定删除该用户？')) return;
  btn.disabled = true;
  try { await apiDelete(`/admin/users/${userId}`); loadUsers(); }
  catch (err) { alert(err.message); }
  btn.disabled = false;
}

// --- 课件管理 ---
$('#refreshCoursewareButton').addEventListener('click', loadCourseware);

$('#coursewareFileInput').addEventListener('change', (e) => {
  if (e.target.files.length) uploadCourseware(e.target.files[0]);
  e.target.value = '';
});

async function loadCourseware() {
  try {
    const data = await apiGet('/courseware?all=true');
    const tbody = $('#coursewareTableBody');
    if (!data.items?.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="6">暂无课件</td></tr>';
      return;
    }
    tbody.innerHTML = data.items.map((c) => `
      <tr>
        <td>${escapeHtml(c.title)}</td>
        <td>${escapeHtml(c.fileName).substring(0, 30)}</td>
        <td><span class="tag ${c.userId === 'admin' ? 'tag-public' : 'tag-private'}">${escapeHtml(c.owner || '未知')}</span></td>
        <td>${formatBytes(c.size)}</td>
        <td>${formatDate(c.createdAt)}</td>
        <td><button class="btn-danger" data-delete-cw="${c.id}">删除</button></td>
      </tr>
    `).join('');
    tbody.querySelectorAll('.btn-danger').forEach((btn) => {
      btn.addEventListener('click', () => deleteCourseware(btn.dataset.deleteCw, btn));
    });
  } catch (err) { alert(err.message); }
}

async function deleteCourseware(id, btn) {
  if (!confirm('确定删除该课件？')) return;
  btn.disabled = true;
  try { await apiDelete(`/courseware/${id}`); loadCourseware(); }
  catch (err) { alert(err.message); }
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
    setTimeout(() => { prog.hidden = true; }, 1500);
    loadCourseware();
  } catch (err) {
    text.textContent = err.message;
    fill.style.width = '0%';
  }
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
