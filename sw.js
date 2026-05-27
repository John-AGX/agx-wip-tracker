// Project 86 service worker — M0 (PWA foundation).
//
// Strategy:
//   • API calls (/api/*) → network-only, never cached. Auth data must
//     stay live; offline UI is opt-in per surface (M4 work).
//   • Navigation requests (HTML, i.e. index.html and /) → NETWORK-FIRST
//     with a short timeout, cache fallback. This is the fix for the
//     "old Ask 86 button on mobile until refresh" bug — previous
//     behavior pre-cached /index.html cache-first, so subsequent
//     deploys never reached the user until they hit refresh AND the
//     SW happened to update the cache via a background fetch. The
//     stale HTML carried stale `?v=N` script tags, locking the whole
//     page to the previous build. Network-first guarantees online
//     users always see fresh HTML on every page load.
//   • Versioned static assets (CSS/JS with ?v=N) → stale-while-
//     revalidate. The ?v= cache buster already changes per release,
//     so the cache entry IS the version; new ?v= means cache miss
//     means fresh network fetch.
//   • Icons + manifest → cache-first. They're tiny and stable.
//   • Everything else → network with cache fallback.
//
// Cache lifecycle:
//   • Activate event clears any cache whose name doesn't match
//     CACHE_VERSION, so an old SW can't keep serving stale assets
//     after a deploy.
//   • clients.claim() takes control of open tabs on activation so
//     users don't have to refresh to see the new build.
//
// BUMP CACHE_VERSION whenever this SW's behavior changes so existing
// users pick up the new strategy on their next visit.

const CACHE_VERSION = 'p86-shell-v11';

// NOTE: /index.html and / are deliberately NOT in this list. HTML
// goes through the network-first handler below; pre-caching it with
// cache-first was the root cause of the stale-button bug.
const STATIC_ASSETS = [
  '/manifest.json',
  '/images/project-86-icon.svg',
  '/images/pwa/icon-192.png',
  '/images/pwa/icon-512.png',
  '/images/pwa/apple-touch-icon.png',
];

// How long to wait for the network on a navigation request before
// falling back to the cached HTML. 3s is enough to feel snappy on a
// good connection but short enough that a flaky cellular network
// still gets users a page instead of a spinner.
const NAV_NETWORK_TIMEOUT_MS = 3000;

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

  // ── Navigation requests (HTML) — network-first with cache fallback.
  // A "navigation request" is the top-level GET that loads the
  // document. We detect it via req.mode === 'navigate' (the modern
  // way) plus a fallback for non-conforming engines via the Accept
  // header. Race the network against a short timeout; if the
  // network wins and is OK, update the cache + return. If the
  // network is slow or fails, return whatever's cached.
  //
  // This is the fix for the stale-button bug — previously this same
  // request fell through to stale-while-revalidate below, which
  // returned the cached HTML first and only updated the cache for
  // next time, locking the user to the previously-cached build for
  // one full visit cycle.
  var isNavigation = req.mode === 'navigate'
    || (req.headers.get('accept') || '').indexOf('text/html') !== -1;
  if (isNavigation) {
    event.respondWith(
      new Promise(function (resolve) {
        var settled = false;
        var timeoutId = setTimeout(function () {
          if (settled) return;
          // Network took too long — serve cached HTML if we have any.
          // The network fetch keeps running in the background and
          // updates the cache when it lands, so the NEXT visit gets
          // the fresh version regardless.
          caches.open(CACHE_VERSION).then(function (cache) {
            cache.match(req).then(function (cached) {
              if (cached && !settled) { settled = true; resolve(cached); }
            });
          });
        }, NAV_NETWORK_TIMEOUT_MS);

        fetch(req).then(function (resp) {
          clearTimeout(timeoutId);
          if (resp && resp.ok && resp.type === 'basic') {
            // Update the cached fallback for offline use next time.
            var clone = resp.clone();
            caches.open(CACHE_VERSION).then(function (c) { c.put(req, clone); });
          }
          if (!settled) { settled = true; resolve(resp); }
        }).catch(function () {
          clearTimeout(timeoutId);
          if (settled) return;
          caches.open(CACHE_VERSION).then(function (cache) {
            cache.match(req).then(function (cached) {
              settled = true;
              // If neither network nor cache works, return a minimal
              // offline notice so the browser doesn't show its own
              // error chrome.
              resolve(cached || new Response('Offline', { status: 503, statusText: 'Offline' }));
            });
          });
        });
      })
    );
    return;
  }

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

  // Everything else (JS/CSS/images) → stale-while-revalidate.
  // Versioned assets (?v=N) get a fresh fetch every release because
  // the URL itself changes; the previous version's cache entry
  // becomes orphan and is cleared on the next CACHE_VERSION bump.
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
