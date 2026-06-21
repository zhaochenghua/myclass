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
  process.env.PUBLIC_BASE_URL || `http://${SERVER_IP}${PATH_PREFIX}`
);
const APP_VERSION = process.env.APP_VERSION || '1.1.26-20260622';
const APK_URL = `${PUBLIC_BASE_URL}/myclass.apk?v=${encodeURIComponent(APP_VERSION)}`;
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS || 2 * 60 * 60 * 1000);
const ALLOWED_HOSTS = new Set(
  (process.env.ALLOWED_HOSTS || `${SERVER_IP},localhost,127.0.0.1`)
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
);

const app = express();
const server = http.createServer(app);
const webRoot = path.resolve(__dirname, '..', 'web');
const publicRoot = path.join(webRoot, 'public');
const apkPath = path.join(publicRoot, 'myclass.apk');
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
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
  res.json({
    title: '上课投屏平台',
    apkVersion: APP_VERSION,
    apkUrl: APK_URL,
    wsPath: `${PATH_PREFIX}/ws`,
    roomTtlSeconds: Math.floor(ROOM_TTL_MS / 1000),
    video: {
      width: 1920,
      height: 1440,
      fps: 24
    },
    rtc: {
      iceServers: []
    }
  });
});

app.get(`${PATH_PREFIX}/api/apk-qrcode.svg`, async (req, res, next) => {
  try {
    const svg = await QRCode.toString(APK_URL, {
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

app.get(`${PATH_PREFIX}/api/courseware`, async (req, res, next) => {
  try {
    res.json({ items: await listStoredCourseware() });
  } catch (error) {
    next(error);
  }
});

app.post(`${PATH_PREFIX}/api/courseware`, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: '请选择课件文件' });
      return;
    }

    const result = await publishCourseware(req.file, req.body);
    res.json(result);
  } catch (error) {
    next(error);
  } finally {
    if (req.file?.path) {
      fs.promises.unlink(req.file.path).catch(() => {});
    }
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
  res.download(apkPath, `myclass-${safeDownloadVersion(APP_VERSION)}.apk`);
});

app.use(
  `${PATH_PREFIX}/vendor/pdfjs`,
  express.static(path.join(__dirname, 'node_modules', 'pdfjs-dist'), {
    etag: true,
    maxAge: '1h'
  })
);

app.use(
  PATH_PREFIX,
  express.static(webRoot, {
    etag: true,
    maxAge: '5m',
    index: 'index.html'
  })
);

setupWebSocket(server, {
  pathPrefix: PATH_PREFIX,
  roomTtlMs: ROOM_TTL_MS,
  apkUrl: APK_URL,
  isAllowedHost,
  isAllowedOrigin
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
  console.log(`APK QR points to ${APK_URL}`);
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

async function publishCourseware(file, fields = {}) {
  const originalName = preferredCoursewareName(file, fields);
  const ext = path.extname(originalName).toLowerCase();
  const id = crypto.randomUUID();
  const pdfName = `${id}.pdf`;
  const pdfPath = path.join(coursewareRoot, pdfName);

  if (ext === '.pdf') {
    await fs.promises.copyFile(file.path, pdfPath);
  } else if (ext === '.ppt' || ext === '.pptx') {
    await convertPresentationToPdf(file.path, ext, pdfPath, id);
  } else {
    throw publicError(400, '仅支持 PDF、PPT、PPTX 课件');
  }

  const stat = await fs.promises.stat(pdfPath);
  const result = {
    id,
    title: path.basename(originalName, ext),
    fileName: originalName,
    size: stat.size,
    createdAt: new Date().toISOString(),
    url: `${PATH_PREFIX}/public/courseware/${pdfName}`
  };
  await rememberCourseware(result);
  return result;
}

async function convertPresentationToPdf(inputPath, ext, outputPdfPath, id) {
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

async function listStoredCourseware() {
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
      title: id,
      fileName: file.name,
      size: stat.size,
      createdAt: stat.birthtime.toISOString(),
      url: `${PATH_PREFIX}/public/courseware/${file.name}`
    });
  }

  const items = [...indexedItems, ...discoveredItems]
    .filter((item) => item && item.id && item.url)
    .filter((item) => fs.existsSync(path.join(coursewareRoot, `${item.id}.pdf`)))
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

async function readCoursewareIndex() {
  try {
    const text = await fs.promises.readFile(coursewareIndexPath, 'utf8');
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
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
