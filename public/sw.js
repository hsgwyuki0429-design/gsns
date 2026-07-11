/* GSNS service worker: cache the app shell, pass everything dynamic through. */
var CACHE = 'gsns-v3';
var SHELL = [
  '/',
  '/styles.css',
  '/app.js',
  '/i18n.js',
  '/harness.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // API and game pages are always fresh
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/game/')) return;
  // the app shell itself is network-first so deploys reach users immediately
  // (stale-while-revalidate used to serve one-version-old HTML/JS after every
  // update, making new features look "missing"); cache is the offline fallback
  if (e.request.mode === 'navigate' || url.pathname === '/' ||
      url.pathname === '/app.js' || url.pathname === '/i18n.js' || url.pathname === '/styles.css') {
    // no-cache: revalidate with the server (skip the 1h HTTP cache); build a
    // fresh Request because init options on a navigate Request throw on older
    // Safari/Chrome
    var fresh = new Request(url.href, { cache: 'no-cache', credentials: 'same-origin' });
    e.respondWith(
      fetch(fresh).then(function (res) {
        if (res.ok) {
          var clone = res.clone();
          caches.open(CACHE).then(function (c) { c.put(e.request, clone); });
        }
        return res;
      }).catch(function () {
        // offline: cached copy, falling back to the shell for deep links (/?g=1)
        return caches.match(e.request).then(function (r) { return r || caches.match('/'); });
      })
    );
    return;
  }
  // everything else: stale-while-revalidate
  e.respondWith(
    caches.match(e.request).then(function (cached) {
      var fetched = fetch(e.request).then(function (res) {
        if (res.ok) {
          var clone = res.clone();
          caches.open(CACHE).then(function (c) { c.put(e.request, clone); });
        }
        return res;
      }).catch(function () { return cached; });
      return cached || fetched;
    })
  );
});
