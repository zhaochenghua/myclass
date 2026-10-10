// Service Worker：为 iPhone 网页版（<前缀>/ios/）提供离线兜底。
//
// 为什么放在 web 根（<前缀>/sw.js）而不是 ios/ 目录下：
// 作用域默认是脚本所在目录，放在根上则整个 <前缀>/ 归它管，其中就包括“不带结尾斜杠”的
// 老入口 <前缀>/ios —— 它只是 <前缀>/ios/ 的前缀，落在 ios/ 作用域之外，主屏幕图标
// 按这个地址启动时拿不到任何离线兜底（服务器不可达就直接白屏，而不是我们自己的界面）。
// 除 <前缀>/ios* 以外的请求（大屏页、API、课件、安装包等）一律直接放行，不受影响。
//
// 策略：网络优先（stale-while-network 风格），
//  - 在线时始终使用服务器最新代码，并把响应写入缓存；
//  - 离线（或服务器不可达）时回退到最近一次缓存的界面。
// 这样代码更新即时生效，同时断网/弱网也能打开界面。
// API、WebSocket、课件文件不在本页面路径下，不会被缓存。

// 每次发版请同时提升 CACHE_NAME 与下方资源上的 ?v= 版本号（与 ios/index.html 保持一致），
// 否则旧设备会继续命中旧缓存；页面内的"清除缓存并更新"是用户的兜底手段。
const CACHE_NAME = 'myclass-ios-v17-update-nag-and-clean-url';
// 注意：带 ?v= 的条目必须与源码里的引用完全一致（ios/index.html 的 link/script、
// ios/js/*.js 里的 import）。漏一个带版本号的模块，设备首次离线打开时该 import 会失败，
// 整个应用起不来、页面只剩初始的“连接投屏服务”屏（且不会有任何网络请求）。
// 路径相对本脚本（<前缀>/sw.js），所以 iOS 网页版一律带 ios/ 前缀。
const SHELL_FILES = [
  './ios/',
  './ios/index.html',
  './ios/style.css',
  './ios/style.css?v=20261010a',
  './ios/manifest.webmanifest',
  './ios/js/app.js',
  './ios/js/app.js?v=20261010c',
  './ios/js/pipeline.js?v=20260920a',
  './ios/js/mediaGeometry.js?v=20260920a',
  './ios/js/classroom.js?v=20260919f',
  './ios/js/signaling.js?v=20260919f',
  './ios/js/util.js?v=20260919f',
  './ios/js/util.js',
  './ios/js/signaling.js',
  './ios/js/publisher.js',
  './ios/js/pipeline.js',
  './ios/js/courseware.js',
  './ios/js/annotation.js',
  './ios/js/pdfview.js',
  './ios/js/pdfview.js?v=20260921',
  './ios/js/coursewarePages.mjs',
  './ios/icons/icon.svg',
  './ios/icons/icon-180.png',
  './ios/icons/icon-192.png',
  './ios/icons/icon-512.png',
  './ios/icons/icon-512-maskable.png'
];

// 由本脚本的位置推出前缀，避免把 /myclass 写死（服务端 PATH_PREFIX 可配置）
const BASE_DIR = new URL('./', self.location.href).pathname; // 例如 /myclass/
const APP_PATH = `${BASE_DIR}ios`; // 例如 /myclass/ios（老图标存的就是它）
const APP_DIR = `${APP_PATH}/`; // 例如 /myclass/ios/

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // 只接管 iOS 网页版（含不带结尾斜杠的入口）；其余请求交回网络
  if (url.pathname !== APP_PATH && !url.pathname.startsWith(APP_DIR)) return;

  // 不带结尾斜杠的入口（老主屏幕图标存的就是 <前缀>/ios）：文档相对路径会解析到上一级目录
  // （./js/app.js → <前缀>/js/app.js）从而全部 404，所以先归一化到 <前缀>/ios/。
  // 在线时服务器本来就会给这个 301，离线时给不了——这里自己补上，两种情况下行为一致。
  if (request.mode === 'navigate' && url.pathname === APP_PATH) {
    event.respondWith(Response.redirect(new URL(APP_DIR, self.location.origin).href, 302));
    return;
  }

  event.respondWith(
    // no-store 绕过 HTTP 强缓存，保证页面更新即时生效（局域网内成本可忽略）
    fetch(request, { cache: 'no-store' })
      .then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then((cached) => {
          if (cached) return cached;
          // 连缓存都没有（例如首次安装失败），退回 iOS 网页版入口兜底
          if (request.mode === 'navigate') {
            return caches.match('./ios/index.html');
          }
          return new Response('', { status: 404, statusText: 'Not Found' });
        })
      )
  );
});
