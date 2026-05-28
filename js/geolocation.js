// Geolocation helper — one-call-per-session permission request +
// position cache. Used by attachment uploads to tag each photo with
// where the user was standing.
//
// Public surface:
//   window.p86Geo.get(maxAgeMs)
//     Resolves to { lat, lng, accuracy } or null if the user denied
//     permission or the platform doesn't support geolocation.
//     maxAgeMs (default 60_000) lets a fresh upload reuse a recent fix
//     instead of triggering a new HTTP-or-GPS hit.
//
//   window.p86Geo.status()
//     Returns the cached state: 'unknown' | 'granted' | 'denied' |
//     'unsupported'. Lets the UI render a small "📍 location on" chip
//     without having to await a position.
//
//   window.p86Geo.invalidate()
//     Clears the cache so the NEXT get() call re-requests the device
//     position. Used by edit-pin flows.
//
// Notes:
//   - On iOS Safari (PWA + browser), the permission prompt is per-
//     session — once granted, subsequent get() calls don't re-prompt
//     until the page is reloaded. We cache the position for `maxAgeMs`
//     to avoid hitting the GPS hardware on every photo in a burst.
//   - Failures are non-fatal — get() resolves to null so the upload
//     still proceeds without geo. The server-side EXIF extractor
//     covers most cases where the device geolocation fails.
//   - We never throw. The UI never has to wrap get() in try/catch.

(function() {
  'use strict';

  if (window.p86Geo) return;  // idempotent

  var _cache = null;          // { lat, lng, accuracy, capturedAt }
  var _status = 'unknown';    // 'unknown' | 'granted' | 'denied' | 'unsupported'
  var _inflight = null;       // promise we share across concurrent get() calls

  function supported() {
    return !!(navigator && navigator.geolocation && typeof navigator.geolocation.getCurrentPosition === 'function');
  }

  function rawGet(timeoutMs) {
    return new Promise(function(resolve) {
      navigator.geolocation.getCurrentPosition(
        function(pos) {
          _status = 'granted';
          _cache = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            capturedAt: Date.now()
          };
          resolve(_cache);
        },
        function(err) {
          // err.code: 1=PERMISSION_DENIED, 2=POSITION_UNAVAILABLE, 3=TIMEOUT
          if (err && err.code === 1) _status = 'denied';
          else _status = 'unknown';   // timeout/unavailable might recover later
          resolve(null);
        },
        {
          enableHighAccuracy: true,   // worth the battery hit for field work
          timeout: timeoutMs || 8000,
          maximumAge: 0                // we manage staleness above
        }
      );
    });
  }

  function get(maxAgeMs) {
    if (!supported()) {
      _status = 'unsupported';
      return Promise.resolve(null);
    }
    if (_status === 'denied') return Promise.resolve(null);

    var maxAge = (typeof maxAgeMs === 'number') ? maxAgeMs : 60000;

    // Cache hit — reuse the recent fix.
    if (_cache && (Date.now() - _cache.capturedAt) <= maxAge) {
      return Promise.resolve(_cache);
    }

    // De-dupe concurrent callers (e.g., a 5-photo burst upload).
    if (_inflight) return _inflight;

    _inflight = rawGet().then(function(res) {
      _inflight = null;
      return res;
    });
    return _inflight;
  }

  function status() { return _status; }
  function invalidate() { _cache = null; }

  // Try a silent permission probe at module load so the status chip
  // can render without forcing a prompt. We use the Permissions API
  // when available (everywhere except Safari) — it tells us granted/
  // denied/prompt WITHOUT showing the prompt.
  try {
    if (navigator.permissions && typeof navigator.permissions.query === 'function') {
      navigator.permissions.query({ name: 'geolocation' }).then(function(p) {
        if (p.state === 'granted') _status = 'granted';
        else if (p.state === 'denied') _status = 'denied';
        // 'prompt' leaves _status as 'unknown'
        if (p.addEventListener) {
          p.addEventListener('change', function() {
            if (p.state === 'denied') { _status = 'denied'; _cache = null; }
            else if (p.state === 'granted') _status = 'granted';
          });
        }
      }).catch(function() { /* permissions probe failed — ignore */ });
    } else if (!supported()) {
      _status = 'unsupported';
    }
  } catch (e) { /* defensive */ }

  window.p86Geo = {
    get: get,
    status: status,
    invalidate: invalidate
  };
})();
