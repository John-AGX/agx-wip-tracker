// Google Maps JS API loader — fetches the key from the server then
// dynamically injects the Maps script tag, returning a promise that
// resolves to the `google.maps` namespace once the SDK is ready.
//
// Public surface:
//   window.p86Maps.ready()
//     Returns a promise resolving to `google.maps`. Idempotent — first
//     call kicks off the fetch+inject, subsequent calls share the
//     cached promise so 5 widgets on one page don't trigger 5 loads.
//   window.p86Maps.isAvailable()
//     Synchronous best-effort check: returns true once google.maps is
//     loaded. UI can use this to render a "Map unavailable" empty
//     state for users on a key-less deployment without awaiting.
//
// The script tag uses the recommended async loader pattern: maps JS
// boots, then calls our `__p86MapsReady` global. We resolve the
// promise from there.
//
// Failure modes — promise REJECTS with a meaningful Error when:
//   - The /api/config/maps-key request fails (not authed / 500)
//   - The server returned { key: null } (env var not set)
//   - Google's script tag errors out (network, CSP, etc.)
// UI consumers should catch and fall back to a static view.

(function() {
  'use strict';

  if (window.p86Maps) return;  // idempotent

  var _loadPromise = null;
  // Cached API key once fetched. Stays in memory for the lifetime of
  // the tab so getKey() can return synchronously after the first
  // ready() call. Used by Static Maps URLs in print-mode <img> tags
  // where we can't await a promise.
  var _cachedKey = null;

  function isAvailable() {
    return !!(window.google && window.google.maps);
  }

  // Synchronous accessor — returns the cached key, or null if ready()
  // hasn't completed at least once. Print-path callers should await
  // ready() first to guarantee the key is loaded.
  function getKey() { return _cachedKey; }

  function fetchKey() {
    return window.p86Api.get('/api/config/maps-key').then(function(r) {
      var k = r && r.key;
      if (!k) throw new Error('Google Maps API key not configured on the server.');
      _cachedKey = k;
      return k;
    });
  }

  function injectScript(key) {
    return new Promise(function(resolve, reject) {
      // Reuse a script already in the DOM (e.g. from a prior nav).
      if (document.querySelector('script[data-p86-maps]')) {
        if (isAvailable()) return resolve(window.google.maps);
        // Tag exists but not ready yet — listen for the ready event.
        window.addEventListener('p86:maps-ready', function once() {
          window.removeEventListener('p86:maps-ready', once);
          resolve(window.google.maps);
        });
        return;
      }
      // Define the global callback Google calls when the SDK finishes
      // booting. The `loading=async` recommended pattern wants a
      // callback URL param.
      window.__p86MapsReady = function() {
        window.dispatchEvent(new Event('p86:maps-ready'));
        resolve(window.google.maps);
      };
      var s = document.createElement('script');
      s.async = true;
      s.defer = true;
      s.setAttribute('data-p86-maps', '1');
      // Libraries: marker (for AdvancedMarkerElement), geometry (for
      // bbox math we'll want when fitting bounds around photo pins).
      s.src = 'https://maps.googleapis.com/maps/api/js' +
        '?key=' + encodeURIComponent(key) +
        '&v=weekly' +
        '&libraries=marker,geometry' +
        '&loading=async' +
        '&callback=__p86MapsReady';
      s.onerror = function() {
        reject(new Error('Google Maps script failed to load. Check the API key referrer restrictions for ' + location.origin + '.'));
      };
      document.head.appendChild(s);
    });
  }

  function ready() {
    if (isAvailable()) return Promise.resolve(window.google.maps);
    if (_loadPromise) return _loadPromise;
    _loadPromise = fetchKey().then(injectScript).catch(function(err) {
      // Reset on failure so a later retry attempt can re-try.
      _loadPromise = null;
      throw err;
    });
    return _loadPromise;
  }

  window.p86Maps = {
    ready: ready,
    isAvailable: isAvailable,
    getKey: getKey
  };
})();
