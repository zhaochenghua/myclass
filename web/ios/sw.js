// Service Worker：为 iPhone 网页版提供离线兜底。
//
// 策略：网络优先（stale-while-network 风格），
//  - 在线时始终使用服务器最新代码，并把响应写入缓存；
//  - 离线（或服务器不可达）时回退到最近一次缓存的界面。
// 这样代码更新即时生效，同时断网/弱网也能打开界面。
// API、WebSocket、课件文件不在本页面路径下，不会被缓存。

const CACHE_NAME = 'myclass-ios-v2';
const SHELL_FILES = [
  './',
  './index.html',
  './style.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/util.js',
  './js/signaling.js',
  './js/publisher.js',
  './js/pipeline.js',
  './js/courseware.js',
  './icons/icon.svg',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png'
];

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
  // 只处理本页面（/myclass/ios/）下的资源，API / WebSocket / 课件文件不缓存
  if (!/\/ios(\/|$)/.test(url.pathname)) return;

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
          // 连缓存都没有（例如首次安装失败），退回 index.html 兜底
          if (request.mode === 'navigate') {
            return caches.match('./index.html');
          }
          return new Response('', { status: 404, statusText: 'Not Found' });
        })
      )
  );
});
