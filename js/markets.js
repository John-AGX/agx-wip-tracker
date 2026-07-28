/* ────────────────────────────────────────────────────────────────────────
 * markets.js — client-side markets cache (multi-market M1).
 *
 * Markets are a first-class dimension (organization -> market -> job), so
 * every picker must read the markets TABLE instead of a hardcoded list.
 * This is the shared, cache-first accessor those pickers use.
 *
 * Deliberately SYNCHRONOUS at the call site: pickers in this app are built
 * inside string-concat render functions that can't await. So we warm the
 * cache once at boot and hand back whatever we have; a cold cache still
 * returns the record's own current value so an edit can never blank a
 * field it didn't touch.
 *
 * M2 (the global market switcher) builds on this same cache.
 * ──────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  if (window.p86Markets) return;

  var _markets = [];     // [{id,name,code,timezone,color,active,...}]
  var _loaded = false;
  var _inflight = null;

  function authHeaders() {
    try {
      var t = localStorage.getItem('p86-auth-token');
      return t ? { Authorization: 'Bearer ' + t } : {};
    } catch (_) { return {}; }
  }

  // Fetch once; subsequent callers share the in-flight promise so a burst of
  // renders can't fan out into N identical requests.
  function load(force) {
    if (_loaded && !force) return Promise.resolve(_markets);
    if (_inflight) return _inflight;
    _inflight = fetch('/api/markets', { credentials: 'include', headers: authHeaders() })
      .then(function (r) { return r.ok ? r.json() : { markets: [] }; })
      .then(function (j) {
        _markets = (j && j.markets) || [];
        _loaded = true;
        _inflight = null;
        try {
          document.dispatchEvent(new CustomEvent('p86:markets-loaded', { detail: { markets: _markets } }));
        } catch (_) {}
        return _markets;
      })
      .catch(function (e) {
        console.warn('[markets] load failed:', e && e.message);
        _inflight = null;
        return _markets;
      });
    return _inflight;
  }

  function all() { return _markets.slice(); }
  function active() { return _markets.filter(function (m) { return m.active !== false; }); }

  function byId(id) {
    if (id == null) return null;
    for (var i = 0; i < _markets.length; i++) {
      if (String(_markets[i].id) === String(id)) return _markets[i];
    }
    return null;
  }
  function byName(name) {
    if (!name) return null;
    var n = String(name).trim().toLowerCase();
    for (var i = 0; i < _markets.length; i++) {
      if (String(_markets[i].name || '').trim().toLowerCase() === n) return _markets[i];
    }
    return null;
  }

  // Option list for a <select>. ALWAYS includes `current` even when it's
  // inactive or the cache is cold — a picker that silently drops the value a
  // record already holds turns an unrelated edit into data loss.
  function names(current) {
    var out = active().map(function (m) { return m.name; });
    if (current && out.indexOf(current) === -1) out.unshift(current);
    return out;
  }

  window.p86Markets = { load: load, all: all, active: active, byId: byId, byName: byName, names: names };
  // Convenience global for the string-concat pickers.
  window.p86MarketNames = names;

  // Warm the cache once auth is up. The app fires p86:auth-ready; if we
  // missed it (script order), fall back to a direct load.
  document.addEventListener('p86:auth-ready', function () { load(true); });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { load(); });
  } else {
    load();
  }
})();
