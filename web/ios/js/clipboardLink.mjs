export function parseClipboardLink(text) {
  const source = String(text || '');
  const match = /https?:\/\/[^\s<>"【】]+/i.exec(source);
  if (!match) return null;
  const raw = match[0].replace(/[。，；！？,;）》」』]+$/u, '');
  if (raw.length > 8192) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  const remainder = (source.slice(0, match.index) + source.slice(match.index + match[0].length)).trim().replace(/^[：:\-—\s]+|[：:\-—\s]+$/gu, '');
  const title = (/【([^】]+)】/u.exec(source)?.[1] || remainder.split(/\r?\n/).find(line => line.trim()) || '')
    .replace(/-哔哩哔哩$/u, '').trim().slice(0, 50);
  return { url: url.href, title };
}

export function setupClipboardLink({ getSession, onSaved }) {
  const $ = id => document.getElementById(id);
  const modal = $('clipboardDialog'), source = $('clipboardText'), title = $('clipboardName');
  const status = $('clipboardStatus'), save = $('clipboardSave'), check = $('clipboardCheck');
  let session = null, generation = 0, candidate = null, busy = false, uploadId = null, previousFocus = null;
  const current = () => session && getSession().token === session.token && getSession().apiBase === session.apiBase;
  function controls() {
    source.disabled = busy; title.disabled = busy; check.disabled = busy;
    save.disabled = busy || !candidate;
    $('clipboardRead').disabled = busy;
    $('clipboardClose').disabled = busy;
  }
  function close() {
    if (busy) return;
    generation++; modal.hidden = true; candidate = null; session = null;
    previousFocus?.focus();
  }
  async function request(path, options = {}) {
    if (!current()) throw new Error('登录状态已变化，请关闭后重新打开');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(session.apiBase + path, { ...options, cache: 'no-store', signal: controller.signal,
        headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json', ...options.headers } });
      const data = await response.json().catch(() => ({}));
      if (!current()) throw new Error('登录状态已变化，请关闭后重新打开');
      if (!response.ok) throw new Error(response.status === 401 ? '登录已过期，请重新登录' : data.error || `请求失败：HTTP ${response.status}`);
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('网络请求超时，请重试');
      throw error;
    } finally { clearTimeout(timeout); }
  }
  async function inspect() {
    if (busy || modal.hidden) return;
    candidate = null; uploadId = null; title.value = '';
    const parsed = parseClipboardLink(source.value);
    if (!parsed) { status.textContent = '没有找到有效的 HTTP/HTTPS 链接，请粘贴链接或分享文案。'; controls(); return; }
    const epoch = ++generation;
    busy = true; controls(); status.textContent = '正在检查服务器是否已保存…';
    try {
      const data = await request('/courseware/link/exists?url=' + encodeURIComponent(parsed.url));
      if (epoch !== generation) return;
      if (data.exists) status.textContent = '该链接已在当前账号的服务器列表中，无需重复上传。';
      else {
        candidate = parsed;
        title.value = parsed.title;
        uploadId = globalThis.crypto?.randomUUID?.() || `ios-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        status.textContent = '该链接尚未保存。请确认显示名称，再上传到服务器列表。';
      }
    } catch (error) { if (epoch === generation) status.textContent = error.message; }
    finally { if (epoch === generation) { busy = false; controls(); } }
  }
  async function readClipboard() {
    // Keep readText() in the click call stack: Safari requires user activation.
    const epoch = generation;
    candidate = null; uploadId = null; title.value = ''; controls();
    let timer;
    busy = true; controls(); status.textContent = '请允许读取剪贴板；也可关闭提示后手动粘贴。';
    try {
      if (!navigator.clipboard?.readText) throw new Error('unavailable');
      const text = await Promise.race([navigator.clipboard.readText(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 12000); })]);
      if (epoch !== generation) return;
      source.value = text; busy = false;
      await inspect();
    } catch {
      if (epoch === generation) status.textContent = '无法直接读取。请在上方输入框长按“粘贴”，然后点击“检查链接”。';
    } finally { clearTimeout(timer); if (epoch === generation) { busy = false; controls(); } }
  }
  function open() {
    session = { ...getSession() };
    if (!session.token) return;
    generation++; previousFocus = document.activeElement;
    source.value = ''; title.value = ''; candidate = null; uploadId = null; busy = false;
    modal.hidden = false; controls(); $('clipboardClose').focus();
    void readClipboard();
  }
  document.querySelectorAll('[data-clipboard-link]').forEach(button => button.addEventListener('click', open));
  $('clipboardRead').addEventListener('click', readClipboard);
  check.addEventListener('click', inspect);
  source.addEventListener('input', () => { candidate = null; title.value = ''; uploadId = null; status.textContent = '粘贴后点击“检查链接”。'; controls(); });
  source.addEventListener('paste', () => setTimeout(inspect, 0));
  save.addEventListener('click', async () => {
    if (busy || !candidate) return;
    const name = title.value.trim();
    if (!name) { status.textContent = '请填写链接显示名称。'; title.focus(); return; }
    busy = true; controls(); status.textContent = '正在保存…';
    try {
      await request('/courseware/link', { method: 'POST', headers: { 'X-Upload-Id': uploadId }, body: JSON.stringify({ title: name, url: candidate.url }) });
      candidate = null;
      status.textContent = '已保存到服务器列表，可在“课件管理”中查看。';
      Promise.resolve().then(() => onSaved?.()).catch(console.error);
    } catch (error) { status.textContent = `${error.message}。可重试，重复提交不会新增相同链接。`; }
    finally { busy = false; controls(); }
  });
  $('clipboardClose').addEventListener('click', close);
  modal.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key === 'Tab') {
      const nodes = [...modal.querySelectorAll('button, input, textarea')].filter(node => !node.disabled);
      const first = nodes[0], last = nodes.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
}
