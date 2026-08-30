const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');
const setupWebSocket = require('./websocket');

const SERVER_IP = process.env.SERVER_IP || '10.30.13.1';
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);
const PATH_PREFIX = normalizePrefix(process.env.PATH_PREFIX || '/myclass');
const PUBLIC_BASE_URL = removeTrailingSlash(
  process.env.PUBLIC_BASE_URL || `http://ai.nbsdszx.cn${PATH_PREFIX}`
);
const DEFAULT_APP_VERSION = process.env.APP_VERSION || '1.4.5-20260822';
const DEFAULT_WINDOWS_VERSION = process.env.WINDOWS_VERSION || '0.1.22';
const VERSIONS_PATH = path.join(__dirname, 'data', 'versions.json');
let versionsCache = { mtimeMs: -1, data: null };

// 版本号从 data/versions.json 动态读取（带 mtime 缓存），改文件即生效，无需重启
function readVersions() {
  let stat;
  try {
    stat = fs.statSync(VERSIONS_PATH);
  } catch {
    return {
      appVersion: DEFAULT_APP_VERSION,
      windowsVersion: DEFAULT_WINDOWS_VERSION
    };
  }
  if (versionsCache.data && versionsCache.mtimeMs === stat.mtimeMs) {
    return versionsCache.data;
  }
  let data = {
    appVersion: DEFAULT_APP_VERSION,
    windowsVersion: DEFAULT_WINDOWS_VERSION
  };
  try {
    const raw = JSON.parse(fs.readFileSync(VERSIONS_PATH, 'utf8'));
    if (typeof raw.appVersion === 'string' && raw.appVersion.trim()) {
      data.appVersion = raw.appVersion.trim();
    }
    if (typeof raw.windowsVersion === 'string' && raw.windowsVersion.trim()) {
      data.windowsVersion = raw.windowsVersion.trim();
    }
  } catch {}
  versionsCache = { mtimeMs: stat.mtimeMs, data };
  return data;
}

function getApkUrl() {
  const { appVersion } = readVersions();
  return `${PUBLIC_BASE_URL}/myclass.apk?v=${encodeURIComponent(appVersion)}`;
}
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS || 2 * 60 * 60 * 1000);
const ALLOWED_HOSTS = new Set(
  (process.env.ALLOWED_HOSTS || `${SERVER_IP},localhost,127.0.0.1,ai.nbsdszx.cn`)
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
);

// -- 用户系统 --
const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const secretPath = path.join(dataDir, '.auth_secret');
let AUTH_SECRET = process.env.AUTH_SECRET;
if (!AUTH_SECRET) {
  try { AUTH_SECRET = fs.readFileSync(secretPath, 'utf8').trim(); } catch {}
  if (!AUTH_SECRET) {
    AUTH_SECRET = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(secretPath, AUTH_SECRET, 'utf8');
  }
}
const INACTIVE_USER_DELETE_DAYS = Number(process.env.INACTIVE_USER_DELETE_DAYS || 60);
const usersPath = path.join(dataDir, 'users.json');

const app = express();
const server = http.createServer(app);
const webRoot = path.resolve(__dirname, '..', 'web');
const publicRoot = path.join(webRoot, 'public');
const apkPath = path.join(publicRoot, 'myclass.apk');
const windowsInstallerPath = path.join(publicRoot, 'myclass-windows.exe');
const coursewareRoot = path.join(publicRoot, 'courseware');
const coursewareIndexPath = path.join(coursewareRoot, 'index.json');
const tempRoot = path.join(__dirname, 'tmp', 'courseware');
const COURSEWARE_MAX_BYTES = Number(process.env.COURSEWARE_MAX_BYTES || 2 * 1024 * 1024 * 1024);
const COURSEWARE_REQUEST_TIMEOUT_MS = Number(
  process.env.COURSEWARE_REQUEST_TIMEOUT_MS || 30 * 60 * 1000
);
const upload = multer({
  dest: tempRoot,
  limits: {
    fileSize: COURSEWARE_MAX_BYTES
  }
});

fs.mkdirSync(coursewareRoot, { recursive: true });
fs.mkdirSync(tempRoot, { recursive: true });

server.requestTimeout = COURSEWARE_REQUEST_TIMEOUT_MS;
server.timeout = COURSEWARE_REQUEST_TIMEOUT_MS;
server.headersTimeout = Math.min(120000, COURSEWARE_REQUEST_TIMEOUT_MS);

app.disable('x-powered-by');
app.use(express.json());

app.use((req, res, next) => {
  if (!isAllowedHost(req.headers.host)) {
    res.status(403).send('Forbidden host');
    return;
  }

  if (!isAllowedOrigin(req.headers.origin)) {
    res.status(403).send('Forbidden origin');
    return;
  }

  // 仅对允许来源返回跨域头，Android WebSocket/同源浏览器请求不依赖该头。
  if (req.headers.origin) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }

  next();
});

app.get('/', (req, res) => {
  res.redirect(`${PATH_PREFIX}/`);
});

app.get(`${PATH_PREFIX}/health`, (req, res) => {
  res.json({ ok: true, service: 'myclass', pathPrefix: PATH_PREFIX });
});

app.get(`${PATH_PREFIX}/api/config`, (req, res) => {
  const { appVersion, windowsVersion } = readVersions();
  res.json({
    title: '上课投屏平台',
    apkVersion: appVersion,
    apkUrl: getApkUrl(),
    windowsVersion,
    windowsUrl: `${PUBLIC_BASE_URL}/myclass-windows.exe?v=${encodeURIComponent(windowsVersion)}`,
    wsPath: `${PATH_PREFIX}/ws`,
    roomTtlSeconds: Math.floor(ROOM_TTL_MS / 1000),
    video: {
      width: 1920,
      height: 1440,
      fps: 24
    },
    rtc: {
      iceServers: [
        {
          // coturn 同端口同时提供 STUN，让跨网段但 NAT 支持端口映射时能 srflx 直连，减少走中继
          urls: ['stun:10.30.13.1:3478']
        },
        {
          urls: [
            'turn:10.30.13.1:3478?transport=udp',
            'turn:10.30.13.1:3478?transport=tcp'
          ],
          username: 'myclass',
          credential: 'myclass2026turn'
        }
      ]
    }
  });
});

app.get(`${PATH_PREFIX}/api/apk-qrcode.svg`, async (req, res, next) => {
  try {
    const svg = await QRCode.toString(getApkUrl(), {
      type: 'svg',
      margin: 2,
      width: 360,
      color: {
        dark: '#061014',
        light: '#f7fbff'
      }
    });
    res.type('image/svg+xml').send(svg);
  } catch (error) {
    next(error);
  }
});

// -- 认证接口 --
app.post(`${PATH_PREFIX}/api/auth/register`, async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
      res.status(400).json({ error: '用户名和密码不能为空' });
      return;
    }
    const name = username.trim();
    if (name.length < 2 || name.length > 20 || !/^[\u4e00-\u9fa5a-zA-Z0-9_]+$/.test(name)) {
      res.status(400).json({ error: '用户名仅支持中英文数字下划线，2-20位' });
      return;
    }
    if (password.length < 4 || password.length > 32) {
      res.status(400).json({ error: '密码需要4-32位' });
      return;
    }
    const users = await readUsers();
    if (users.find((u) => u.username === name)) {
      res.status(409).json({ error: '用户名已被注册' });
      return;
    }
    const now = new Date().toISOString();
    const user = {
      id: crypto.randomUUID(),
      username: name,
      passwordHash: hashPassword(password),
      token: crypto.randomBytes(32).toString('hex'),
      role: 'user',
      createdAt: now,
      lastLoginAt: now
    };
    users.push(user);
    await writeUsers(users);
    res.json({ token: user.token, username: user.username, role: user.role });
  } catch (error) {
    next(error);
  }
});

app.post(`${PATH_PREFIX}/api/auth/login`, async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      res.status(400).json({ error: '用户名和密码不能为空' });
      return;
    }
    const users = await readUsers();
    const user = users.find((u) => u.username === username.trim());
    if (!user || user.passwordHash !== hashPassword(password)) {
      res.status(401).json({ error: '用户名或密码错误' });
      return;
    }
    user.token = crypto.randomBytes(32).toString('hex');
    user.lastLoginAt = new Date().toISOString();
    await writeUsers(users);
    const role = user.role || (user.username === 'admin' ? 'admin' : 'user');
    res.json({ token: user.token, username: user.username, role });
  } catch (error) {
    next(error);
  }
});

app.get(`${PATH_PREFIX}/api/auth/me`, requireAuth, async (req, res) => {
  res.json({ id: req.user.id, username: req.user.username, role: req.user.role });
});

// 修改自己的密码（需验证旧密码）
app.put(`${PATH_PREFIX}/api/auth/password`, requireAuth, async (req, res, next) => {
  try {
    const { oldPassword, newPassword } = req.body || {};
    if (!oldPassword || !newPassword) {
      res.status(400).json({ error: '请提供旧密码和新密码' });
      return;
    }
    if (newPassword.length < 4 || newPassword.length > 32) {
      res.status(400).json({ error: '新密码需4-32位' });
      return;
    }
    const users = await readUsers();
    const user = users.find((u) => u.id === req.user.id);
    if (!user) { res.status(404).json({ error: '用户不存在' }); return; }
    if (user.passwordHash !== hashPassword(oldPassword)) {
      res.status(400).json({ error: '旧密码不正确' });
      return;
    }
    user.passwordHash = hashPassword(newPassword);
    user.token = crypto.randomBytes(32).toString('hex');
    await writeUsers(users);
    res.json({ ok: true, token: user.token });
  } catch (error) { next(error); }
});

// 更新个人信息（用户名）
app.put(`${PATH_PREFIX}/api/auth/profile`, requireAuth, async (req, res, next) => {
  try {
    const { username } = req.body || {};
    if (!username || typeof username !== 'string') {
      res.status(400).json({ error: '用户名不能为空' });
      return;
    }
    const name = username.trim();
    if (name.length < 2 || name.length > 20 || !/^[\u4e00-\u9fa5a-zA-Z0-9_]+$/.test(name)) {
      res.status(400).json({ error: '用户名仅支持中英文数字下划线，2-20位' });
      return;
    }
    const users = await readUsers();
    if (users.find((u) => u.username === name && u.id !== req.user.id)) {
      res.status(409).json({ error: '用户名已被占用' });
      return;
    }
    const user = users.find((u) => u.id === req.user.id);
    if (!user) { res.status(404).json({ error: '用户不存在' }); return; }
    user.username = name;
    await writeUsers(users);
    res.json({ ok: true, username: name });
  } catch (error) { next(error); }
});

// -- 管理员接口（需管理员权限） --
app.get(`${PATH_PREFIX}/api/admin/users`, requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const users = await readUsers();
    res.json({ users: users.map((u) => ({ id: u.id, username: u.username, role: u.role || (u.username === 'admin' ? 'admin' : 'user'), createdAt: u.createdAt, lastLoginAt: u.lastLoginAt })) });
  } catch (error) { next(error); }
});

app.put(`${PATH_PREFIX}/api/admin/users/:id/password`, requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { password } = req.body || {};
    if (!password || typeof password !== 'string' || password.length < 4 || password.length > 32) {
      res.status(400).json({ error: '密码需4-32位' });
      return;
    }
    const users = await readUsers();
    const user = users.find((u) => u.id === req.params.id);
    if (!user) { res.status(404).json({ error: '用户不存在' }); return; }
    user.passwordHash = hashPassword(password);
    // 重置 token 使旧登录失效
    user.token = null;
    await writeUsers(users);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.delete(`${PATH_PREFIX}/api/admin/users/:id`, requireAuth, requireAdmin, async (req, res, next) => {
  try {
    if (req.params.id === req.user.id) {
      res.status(400).json({ error: '不能删除自己' });
      return;
    }
    const users = await readUsers();
    const index = users.findIndex((u) => u.id === req.params.id);
    if (index === -1) { res.status(404).json({ error: '用户不存在' }); return; }
    const removed = users.splice(index, 1)[0];
    await writeUsers(users);

    res.json({ ok: true });
  } catch (error) { next(error); }
});

// -- 课件接口（需认证） --
app.get(`${PATH_PREFIX}/api/courseware`, requireAuth, async (req, res, next) => {
  try {
    // 普通用户只能查看自己的+共享课件；管理员可查看全部
    const isAdmin = req.user.role === 'admin';
    const userId = (req.query.all === 'true' && isAdmin) ? null : req.user.id;
    const items = await listStoredCourseware(userId);
    if (req.query.all === 'true' && isAdmin) {
      const users = await readUsers();
      const userMap = Object.fromEntries(users.map(u => [u.id, u.username]));
      items.forEach(item => {
        item.owner = userMap[item.userId] || (item.userId === 'admin' ? '所有人' : (item.userId || '未知'));
      });
    }
    res.json({ items });
  } catch (error) {
    next(error);
  }
});

app.delete(`${PATH_PREFIX}/api/courseware/:id`, requireAuth, async (req, res, next) => {
  try {
    // 管理员可删除任意课件，普通用户只能删除自己的
    const isAdmin = req.user.role === 'admin';
    const deleted = await deleteStoredCourseware(req.params.id, isAdmin ? null : req.user.id);
    if (!deleted) {
      res.status(404).json({ error: '课件不存在或无权删除' });
      return;
    }
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// 课件重命名
app.put(`${PATH_PREFIX}/api/courseware/:id/rename`, requireAuth, express.json(), async (req, res, next) => {
  try {
    const { title } = req.body || {};
    if (!title || typeof title !== 'string' || !title.trim()) {
      res.status(400).json({ error: '标题不能为空' });
      return;
    }
    const newTitle = title.trim();
    if (newTitle.length > 100) {
      res.status(400).json({ error: '标题不能超过100个字符' });
      return;
    }
    const isAdmin = req.user.role === 'admin';
    const renamed = await renameStoredCourseware(req.params.id, newTitle, isAdmin ? null : req.user.id);
    if (!renamed) {
      res.status(404).json({ error: '课件不存在或无权重命名' });
      return;
    }
    res.json({ ok: true, title: newTitle });
  } catch (error) {
    next(error);
  }
});

app.post(`${PATH_PREFIX}/api/courseware`, requireAuth, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: '请选择课件文件' });
      return;
    }
    // share=true → 所有人可见(owner=admin)；否则仅上传者可见(owner=userId)
    const ownerId = req.body.share === 'true' ? 'admin' : req.user.id;
    const result = await publishCourseware(req.file, req.body, ownerId);
    res.json(result);
  } catch (error) {
    next(error);
  } finally {
    if (req.file?.path) {
      fs.promises.unlink(req.file.path).catch(() => {});
    }
  }
});

// 链接课件上传（不包含文件，仅标题+URL）
app.post(`${PATH_PREFIX}/api/courseware/link`, requireAuth, express.json(), async (req, res, next) => {
  try {
    const { title, url } = req.body;
    if (!title || !url) {
      res.status(400).json({ error: '请提供 title 和 url' });
      return;
    }
    // 基本 URL 校验
    let parsed;
    try { parsed = new URL(url); } catch {
      res.status(400).json({ error: '无效的 URL' });
      return;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      res.status(400).json({ error: '仅支持 http/https 链接' });
      return;
    }
    const id = crypto.randomUUID();
    const result = {
      id,
      userId: req.user.id,
      title,
      fileName: url,
      size: 0,
      linkUrl: url,
      url,
      createdAt: new Date().toISOString()
    };
    await rememberCourseware(result);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get(`${PATH_PREFIX}/myclass.apk`, (req, res) => {
  if (!fs.existsSync(apkPath)) {
    res
      .status(404)
      .type('text/plain')
      .send('myclass.apk 尚未生成，请先完成 Android 构建。');
    return;
  }
  res.download(apkPath, `myclass-${safeDownloadVersion(readVersions().appVersion)}.apk`);
});

app.get(`${PATH_PREFIX}/myclass-windows.exe`, (req, res) => {
  if (!fs.existsSync(windowsInstallerPath)) {
    res
      .status(404)
      .type('text/plain')
      .send('Windows 投屏程序尚未生成，请先完成 Windows 构建。');
    return;
  }
  res.download(windowsInstallerPath, `myclass-windows-${safeDownloadVersion(readVersions().windowsVersion)}.exe`);
});

app.use(
  `${PATH_PREFIX}/vendor/pdfjs`,
  express.static(path.join(__dirname, 'node_modules', 'pdfjs-dist'), {
    etag: true,
    maxAge: '1h',
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.mjs')) {
        res.setHeader('Content-Type', 'application/javascript');
      }
    }
  })
);

// Also serve .mjs from web root for bundled pdfjs
app.use(
  PATH_PREFIX,
  express.static(webRoot, {
    etag: true,
    maxAge: '5m',
    index: 'index.html',
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.mjs')) {
        res.setHeader('Content-Type', 'application/javascript');
      }
    }
  })
);

setupWebSocket(server, {
  pathPrefix: PATH_PREFIX,
  roomTtlMs: ROOM_TTL_MS,
  apkUrl: getApkUrl(),
  isAllowedHost,
  isAllowedOrigin,
  readCoursewareIndex,
  verifyTeacherToken: async (token) => {
    if (!token) return null;
    const users = await readUsers();
    const user = users.find((u) => u.token === token);
    if (!user) return null;
    user.lastLoginAt = new Date().toISOString();
    await writeUsers(users);
    return { id: user.id, username: user.username, token: user.token };
  }
});

app.use((error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  const isMulterSizeError = error.code === 'LIMIT_FILE_SIZE';
  const status = isMulterSizeError ? 413 : error.statusCode || error.status || 500;
  res.status(status).json({
    error: isMulterSizeError
      ? `课件文件过大，请控制在 ${formatBytes(COURSEWARE_MAX_BYTES)} 以内`
      : error.publicMessage || error.message || '服务器处理失败'
  });
});

server.listen(PORT, HOST, () => {
  console.log(`MyClass server listening on http://${HOST}:${PORT}${PATH_PREFIX}/`);
  console.log(`APK QR points to ${getApkUrl()}`);
});

function normalizePrefix(prefix) {
  const withSlash = prefix.startsWith('/') ? prefix : `/${prefix}`;
  return removeTrailingSlash(withSlash);
}

function removeTrailingSlash(value) {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function safeDownloadVersion(value) {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function publishCourseware(file, fields = {}, userId) {
  const originalName = preferredCoursewareName(file, fields);
  const ext = path.extname(originalName).toLowerCase();
  const id = crypto.randomUUID();
  const pdfName = `${id}.pdf`;
  const pdfPath = path.join(coursewareRoot, pdfName);

  let originalPath = null;
  let originalUrl = null;
  let originalSize = 0;
  let downloadOnly = false;

  if (ext === '.pdf') {
    await fs.promises.copyFile(file.path, pdfPath);
    originalPath = pdfPath;
    originalUrl = `${PATH_PREFIX}/public/courseware/${pdfName}`;
  } else if (ext === '.ppt' || ext === '.pptx' || ext === '.doc' || ext === '.docx') {
    const originalSavePath = path.join(coursewareRoot, `${id}${ext}`);
    await fs.promises.copyFile(file.path, originalSavePath);
    originalPath = originalSavePath;
    originalUrl = `${PATH_PREFIX}/public/courseware/${id}${ext}`;

    const originalStat = await fs.promises.stat(originalPath);
    originalSize = originalStat.size;

    await convertOfficeToPdf(file.path, ext, pdfPath, id);
  } else if (ext === '.zip') {
    const zipPath = path.join(coursewareRoot, `${id}.zip`);
    await fs.promises.copyFile(file.path, zipPath);
    const stat = await fs.promises.stat(zipPath);
    downloadOnly = true;
    const result = {
      id,
      userId: userId || 'legacy',
      title: path.basename(originalName, ext),
      fileName: originalName,
      size: stat.size,
      downloadOnly: true,
      url: `${PATH_PREFIX}/public/courseware/${id}.zip`,
      createdAt: new Date().toISOString()
    };
    await rememberCourseware(result);
    return result;
  } else if (ext === '.mp4' || ext === '.mov' || ext === '.avi' || ext === '.webm' || ext === '.mkv' || ext === '.3gp') {
    const videoPath = path.join(coursewareRoot, `${id}${ext}`);
    await fs.promises.copyFile(file.path, videoPath);
    const stat = await fs.promises.stat(videoPath);
    downloadOnly = true;
    const result = {
      id,
      userId: userId || 'legacy',
      title: path.basename(originalName, ext),
      fileName: originalName,
      size: stat.size,
      downloadOnly: false,
      videoUrl: `${PATH_PREFIX}/public/courseware/${id}${ext}`,
      url: `${PATH_PREFIX}/public/courseware/${id}${ext}`,
      createdAt: new Date().toISOString()
    };
    await rememberCourseware(result);
    return result;
  } else {
    throw publicError(400, '仅支持 PDF、PPT、PPTX、DOC、DOCX、ZIP、视频文件');
  }

  const stat = await fs.promises.stat(pdfPath);
  const result = {
    id,
    userId: userId || 'legacy',
    title: path.basename(originalName, ext),
    fileName: originalName,
    size: stat.size,
    originalUrl: originalUrl || `${PATH_PREFIX}/public/courseware/${pdfName}`,
    originalSize: originalSize,
    createdAt: new Date().toISOString(),
    url: `${PATH_PREFIX}/public/courseware/${pdfName}`
  };
  await rememberCourseware(result);
  return result;
}

async function convertOfficeToPdf(inputPath, ext, outputPdfPath, id) {
  const sourcePath = path.join(tempRoot, `${id}${ext}`);
  const outputDir = path.join(tempRoot, id);
  await fs.promises.mkdir(outputDir, { recursive: true });
  await fs.promises.copyFile(inputPath, sourcePath);

  try {
    await runLibreOffice([
      '--headless',
      '--nologo',
      '--nofirststartwizard',
      '--convert-to',
      'pdf',
      '--outdir',
      outputDir,
      sourcePath
    ]);

    const convertedPath = path.join(outputDir, `${id}.pdf`);
    if (!fs.existsSync(convertedPath)) {
      throw publicError(500, 'LibreOffice 未生成 PDF，请检查课件格式');
    }
    await fs.promises.rename(convertedPath, outputPdfPath);
  } finally {
    fs.promises.rm(outputDir, { recursive: true, force: true }).catch(() => {});
    fs.promises.unlink(sourcePath).catch(() => {});
  }
}

function runLibreOffice(args) {
  const executable = libreOfficeExecutable();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true
    });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(publicError(504, 'LibreOffice 转换超时'));
    }, Number(process.env.COURSEWARE_CONVERT_TIMEOUT_MS || 120000));

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      if (error.code === 'ENOENT') {
        reject(publicError(500, '服务器未找到 LibreOffice，请安装或配置 LIBREOFFICE_PATH'));
      } else {
        reject(error);
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(publicError(500, `LibreOffice 转换失败：${stderr.trim() || code}`));
      }
    });
  });
}

function libreOfficeExecutable() {
  const configured = process.env.LIBREOFFICE_PATH || process.env.SOFFICE_PATH;
  if (configured) {
    return configured;
  }

  const candidates = os.platform() === 'win32'
    ? [
        'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
        'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe'
      ]
    : [
        '/usr/bin/libreoffice',
        '/usr/local/bin/libreoffice',
        '/usr/bin/soffice',
        '/usr/local/bin/soffice'
      ];

  return candidates.find((candidate) => fs.existsSync(candidate)) || 'soffice';
}

function publicError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.publicMessage = message;
  return error;
}

function preferredCoursewareName(file, fields) {
  const fromApp = decodeBase64Utf8(fields?.displayNameBase64);
  const fromMultipart = decodeMultipartFileName(file.originalname);
  return sanitizeCoursewareName(fromApp || fromMultipart || 'courseware');
}

function decodeBase64Utf8(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return '';
  }

  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8').trim();
    return decoded.includes('\uFFFD') ? '' : decoded;
  } catch (error) {
    return '';
  }
}

function decodeMultipartFileName(value) {
  const original = String(value || '').trim();
  if (!original) {
    return '';
  }

  const decodedAsUtf8 = Buffer.from(original, 'latin1').toString('utf8');
  if (
    decodedAsUtf8 &&
    decodedAsUtf8 !== original &&
    !decodedAsUtf8.includes('\uFFFD') &&
    /[\u4e00-\u9fff]/.test(decodedAsUtf8)
  ) {
    return decodedAsUtf8;
  }

  return original;
}

function sanitizeCoursewareName(value) {
  const name = String(value || '')
    .replace(/\0/g, '')
    .replace(/\\/g, '/')
    .trim();
  return path.basename(name) || 'courseware';
}

function formatBytes(bytes) {
  const mb = bytes / 1024 / 1024;
  return `${Math.round(mb)}MB`;
}

async function listStoredCourseware(userId) {
  const indexedItems = await readCoursewareIndex();
  const knownIds = new Set(indexedItems.map((item) => item.id));
  const discoveredItems = [];
  const files = await fs.promises.readdir(coursewareRoot, { withFileTypes: true });

  for (const file of files) {
    if (!file.isFile() || path.extname(file.name).toLowerCase() !== '.pdf') {
      continue;
    }
    const id = path.basename(file.name, '.pdf');
    if (knownIds.has(id)) {
      continue;
    }
    const stat = await fs.promises.stat(path.join(coursewareRoot, file.name));
    discoveredItems.push({
      id,
      userId: 'legacy',
      title: id,
      fileName: file.name,
      size: stat.size,
      createdAt: stat.birthtime.toISOString(),
      url: `${PATH_PREFIX}/public/courseware/${file.name}`
    });
  }

  const items = [...indexedItems, ...discoveredItems]
    .filter((item) => item && item.id && item.url)
    .filter((item) => !userId || !item.userId || item.userId === 'admin' || item.userId === userId || item.userId === 'legacy')
    .filter((item) => {
      // 链接类型课件不需要检查磁盘文件
      if (item.linkUrl) return true;
      const fileExt = path.extname(new URL(item.url, 'http://localhost').pathname);
      return fs.existsSync(path.join(coursewareRoot, `${item.id}${fileExt}`));
    })
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, Number(process.env.COURSEWARE_LIST_LIMIT || 60));

  return items;
}

async function rememberCourseware(item) {
  const currentItems = await readCoursewareIndex();
  const nextItems = [
    item,
    ...currentItems.filter((existing) => existing.id !== item.id)
  ].slice(0, Number(process.env.COURSEWARE_INDEX_LIMIT || 100));
  await fs.promises.writeFile(
    coursewareIndexPath,
    JSON.stringify(nextItems, null, 2),
    'utf8'
  );
}

async function deleteStoredCourseware(id, userId) {
  if (!isSafeCoursewareId(id)) {
    const error = new Error('无效课件编号');
    error.status = 400;
    throw error;
  }

  const currentItems = await readCoursewareIndex();
  const targetItem = currentItems.find((item) => item.id === id);
  // userId 为 null 时表示管理员，可删除任意课件
  if (targetItem && targetItem.userId && userId !== null && userId && targetItem.userId !== userId) {
    return false; // 不属于当前用户
  }
  const wasIndexed = currentItems.some((item) => item.id === id);
  let fileDeleted = false;

  // 删除所有可能的关联文件（PDF、原始 Office 文件、ZIP）
  for (const ext of ['.pdf', '.zip', '.pptx', '.ppt', '.docx', '.doc']) {
    const filePath = path.join(coursewareRoot, `${id}${ext}`);
    const resolvedFilePath = path.resolve(filePath);
    if (!resolvedFilePath.startsWith(`${path.resolve(coursewareRoot)}${path.sep}`)) {
      const error = new Error('无效课件路径');
      error.status = 400;
      throw error;
    }
    try {
      await fs.promises.unlink(resolvedFilePath);
      fileDeleted = true;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  if (wasIndexed) {
    await fs.promises.writeFile(
      coursewareIndexPath,
      JSON.stringify(currentItems.filter((item) => item.id !== id), null, 2),
      'utf8'
    );
  }

  return wasIndexed || fileDeleted;
}

async function renameStoredCourseware(id, newTitle, userId) {
  if (!isSafeCoursewareId(id)) {
    const error = new Error('无效课件编号');
    error.status = 400;
    throw error;
  }

  const currentItems = await readCoursewareIndex();
  const targetItem = currentItems.find((item) => item.id === id);

  // 权限检查：userId 为 null 表示管理员
  if (targetItem && targetItem.userId && userId !== null && userId && targetItem.userId !== userId) {
    return false;
  }

  if (targetItem) {
    targetItem.title = newTitle;
  } else {
    // 课件不在索引中（legacy 课件），添加到索引
    // 先确认磁盘上存在对应文件
    const possibleExts = ['.pdf', '.zip', '.pptx', '.ppt', '.docx', '.doc'];
    let found = false;
    let fileName = '';
    let size = 0;
    for (const ext of possibleExts) {
      const filePath = path.join(coursewareRoot, `${id}${ext}`);
      try {
        const stat = await fs.promises.stat(filePath);
        found = true;
        fileName = `${id}${ext}`;
        size = stat.size;
        break;
      } catch {}
    }
    if (!found) return false;
    currentItems.push({
      id,
      userId: userId || 'legacy',
      title: newTitle,
      fileName,
      size,
      createdAt: new Date().toISOString(),
      url: `${PATH_PREFIX}/public/courseware/${fileName}`
    });
  }

  await fs.promises.writeFile(
    coursewareIndexPath,
    JSON.stringify(currentItems, null, 2),
    'utf8'
  );
  return true;
}

async function readCoursewareIndex() {
  try {
    const text = await fs.promises.readFile(coursewareIndexPath, 'utf8');
    if (!text.trim()) return [];
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    // 空文件或 JSON 解析失败时返回空数组，避免阻断上传
    if (error instanceof SyntaxError) {
      console.warn('课件索引文件格式异常，已重置为空数组:', error.message);
      return [];
    }
    throw error;
  }
}

function isSafeCoursewareId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id);
}

function isAllowedHost(hostHeader) {
  if (!hostHeader) {
    return true;
  }
  const host = hostHeader.split(':')[0].toLowerCase();
  return ALLOWED_HOSTS.has(host);
}

function isAllowedOrigin(origin) {
  if (!origin) {
    return true;
  }

  try {
    const url = new URL(origin);
    return ALLOWED_HOSTS.has(url.hostname.toLowerCase());
  } catch (error) {
    return false;
  }
}

// -- 用户数据读写 --
async function readUsers() {
  try {
    const text = await fs.promises.readFile(usersPath, 'utf8');
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function writeUsers(users) {
  await fs.promises.writeFile(usersPath, JSON.stringify(users, null, 2), 'utf8');
}

function hashPassword(password) {
  return crypto.createHmac('sha256', AUTH_SECRET).update(password).digest('hex');
}

// -- 认证中间件 --
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) {
    res.status(401).json({ error: '请先登录' });
    return;
  }
  const users = await readUsers();
  const user = users.find((u) => u.token === token);
  if (!user) {
    res.status(401).json({ error: '登录已过期，请重新登录' });
    return;
  }
  user.lastLoginAt = new Date().toISOString();
  await writeUsers(users);
  // 兼容旧数据：无 role 字段时按用户名判断
  const role = user.role || (user.username === 'admin' ? 'admin' : 'user');
  req.user = { id: user.id, username: user.username, role };
  next();
}

// -- 管理员权限中间件 --
async function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    res.status(403).json({ error: '权限不足，仅管理员可操作' });
    return;
  }
  next();
}

// -- 自动清理不活跃用户 --
async function cleanupInactiveUsers() {
  try {
    const users = await readUsers();
    const cutoff = Date.now() - INACTIVE_USER_DELETE_DAYS * 24 * 60 * 60 * 1000;
    const inactive = users.filter((u) => new Date(u.lastLoginAt).getTime() < cutoff);
    if (inactive.length === 0) return;
    const index = await readCoursewareIndex();
    const inactiveIds = new Set(inactive.map((u) => u.id));
    for (const item of index) {
      if (inactiveIds.has(item.userId)) {
        await deleteStoredCourseware(item.id, item.userId).catch(() => {});
      }
    }
    const remaining = users.filter((u) => !inactiveIds.has(u.id));
    await writeUsers(remaining);
    console.log(`清理了 ${inactive.length} 个不活跃用户及课件`);
  } catch (error) {
    console.error('清理不活跃用户失败:', error.message);
  }
}

// 启动时清理
cleanupInactiveUsers();
