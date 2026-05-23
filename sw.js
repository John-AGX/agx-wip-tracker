// Project 86 service worker — M0 (PWA foundation).
//
// Strategy:
//   • API calls (/api/*) → network-only, never cached. Auth data must
//     stay live; offline UI is opt-in per surface (M4 work).
//   • App shell (HTML/CSS/JS bundled with index.html) → stale-while-
//     revalidate. First-render is fast (cached); the network refresh
//     replaces the cache for next time. Cache bumps automatically
//     when CACHE_VERSION changes — every code release.
//   • Icons + manifest → cache-first. They're tiny and stable.
//   • Everything else → network with cache fallback.
//
// Cache lifecycle:
//   • Activate event clears any cache whose name doesn't match
//     CACHE_VERSION, so an old SW can't keep serving stale assets
//     after a deploy.
//   • clients.claim() takes control of open tabs on activation so
//     users don't have to refresh to see the new build.

const CACHE_VERSION = 'p86-shell-v2';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/images/project-86-icon.svg',
  '/images/pwa/icon-192.png',
  '/images/pwa/icon-512.png',
  '/images/pwa/apple-touch-icon.png',
];

self.addEventListener('install', function (event) {
  // Pre-cache the shell. Skip waiting so a fresh SW takes over
  // immediately instead of sitting in "installed" purgatory.
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(function (cache) { return cache.addAll(STATIC_ASSETS); })
      .then(function () { return self.skipWaiting(); })
      .catch(function (e) { console.warn('[sw] install pre-cache failed:', e); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys
          .filter(function (k) { return k !== CACHE_VERSION; })
          .map(function (k) { return caches.delete(k); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return; // never cache writes

  var url = new URL(req.url);

  // API + SSE streams + auth → always network. No interception.
  if (url.pathname.startsWith('/api/')) return;

  // Cross-origin (R2 attachments, Anthropic, etc.) → bypass.
  if (url.origin !== self.location.origin) return;

  // Static assets in the pre-cached list → cache-first.
  if (STATIC_ASSETS.indexOf(url.pathname) !== -1) {
    event.respondWith(
      caches.match(req).then(function (cached) {
        return cached || fetch(req).then(function (resp) {
          if (resp && resp.ok) {
            var clone = resp.clone();
            caches.open(CACHE_VERSION).then(function (c) { c.put(req, clone); });
          }
          return resp;
        });
      })
    );
    return;
  }

  // Everything else (JS/CSS/HTML) → stale-while-revalidate.
  event.respondWith(
    caches.open(CACHE_VERSION).then(function (cache) {
      return cache.match(req).then(function (cached) {
        var fetchPromise = fetch(req).then(function (resp) {
          if (resp && resp.ok && resp.type === 'basic') {
            cache.put(req, resp.clone());
          }
          return resp;
        }).catch(function () {
          // Network failed; serve cache if we have it, else fall through.
          return cached;
        });
        // Return cache immediately if present, refresh in background.
        return cached || fetchPromise;
      });
    })
  );
});
