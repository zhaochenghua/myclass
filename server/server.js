const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const QRCode = require('qrcode');
const setupWebSocket = require('./websocket');

const SERVER_IP = process.env.SERVER_IP || '10.30.13.1';
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);
const PATH_PREFIX = normalizePrefix(process.env.PATH_PREFIX || '/myclass');
const PUBLIC_BASE_URL = removeTrailingSlash(
  process.env.PUBLIC_BASE_URL || `http://${SERVER_IP}${PATH_PREFIX}`
);
const APP_VERSION = process.env.APP_VERSION || '1.1.9-20260620';
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
    title: '宁波三中人工智能实验室上课投屏平台',
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
