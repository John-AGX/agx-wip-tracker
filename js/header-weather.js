// Header weather chip — small "current location" forecast tile that
// lives in the top-right cluster next to the bell + folder buttons.
//
// Lifecycle:
//   1. After the user authenticates, ask the browser for geolocation.
//      Permission prompt is one-shot and the answer persists at the
//      browser level; we don't pester users who have denied.
//   2. Cache the resolved coords in localStorage so subsequent reloads
//      don't re-call getCurrentPosition unless the cache has expired
//      (12 hours). Re-prompting on every reload would be obnoxious.
//   3. Fetch the daily forecast for those coords via the existing
//      /api/weather/coords endpoint (NWS + in-memory cache server-side).
//   4. Paint the chip: glyph + temp. Tooltip carries the summary text
//      (Mostly Sunny · 78°/65° · 4% rain · 13 mph wind). Click reloads
//      the forecast (cheap, just hits the 1hr server cache).
//
// Failure modes (handled silently — chip just stays hidden):
//   - User denies geolocation
//   - User outside US (NWS won't have coverage)
//   - Browser doesn't have a geolocation API (very old browsers)
//   - Server / NWS unreachable

(function () {
  'use strict';

  var COORDS_KEY = 'p86-user-coords';
  var COORDS_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

  var _state = {
    started: false,
    lastFetchAt: 0,
    coords: null,
    risk: null,
    summary: null,
    tempHigh: null,
    tempLow: null,
    precipPct: null,
    windMph: null
  };

  function loadCachedCoords() {
    try {
      var raw = localStorage.getItem(COORDS_KEY);
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (!obj || typeof obj.lat !== 'number' || typeof obj.lng !== 'number') return null;
      if (!obj.fetchedAt || (Date.now() - obj.fetchedAt) > COORDS_TTL_MS) return null;
      return obj;
    } catch (e) { return null; }
  }
  function saveCachedCoords(lat, lng) {
    try {
      localStorage.setItem(COORDS_KEY, JSON.stringify({
        lat: lat, lng: lng, fetchedAt: Date.now()
      }));
    } catch (e) { /* defensive */ }
  }

  // Wraps the callback-style getCurrentPosition in a Promise. Times
  // out at 12s — geolocation can hang forever on some platforms when
  // location services are disabled at the OS level.
  function getBrowserCoords() {
    if (!navigator || !navigator.geolocation) {
      return Promise.reject(new Error('no_geolocation_api'));
    }
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error('geolocation_timeout'));
      }, 12000);
      navigator.geolocation.getCurrentPosition(
        function (pos) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        },
        function (err) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          // err.code: 1=PERMISSION_DENIED, 2=POSITION_UNAVAILABLE, 3=TIMEOUT
          var tag = err.code === 1 ? 'permission_denied'
                  : err.code === 2 ? 'position_unavailable'
                  : err.code === 3 ? 'geolocation_timeout'
                  : 'geolocation_error';
          var e = new Error(tag);
          e.code = err.code;
          reject(e);
        },
        { enableHighAccuracy: false, timeout: 10000, maximumAge: 60 * 60 * 1000 }
      );
    });
  }

  function weatherIconForRisk(risk) {
    if (risk === 'red') return '⚠️';
    if (risk === 'yellow') return '☁️';
    return '☀️';
  }

  function paintChip() {
    var el = document.getElementById('header-weather');
    if (!el) return;
    if (!_state.summary) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    var risk = _state.risk || 'green';
    var icon = weatherIconForRisk(risk);
    var temp = _state.tempHigh != null
      ? _state.tempHigh + '°'
      : (_state.tempLow != null ? _state.tempLow + '°' : '');
    var titleBits = [_state.summary];
    if (_state.tempHigh != null) {
      titleBits.push(_state.tempHigh + '°' + (_state.tempLow != null ? ' / ' + _state.tempLow + '°' : ''));
    }
    if (_state.precipPct) titleBits.push(_state.precipPct + '% rain');
    if (_state.windMph) titleBits.push(_state.windMph + ' mph wind');
    el.title = titleBits.join(' · ') + ' (your location)';
    el.className = 'header-weather header-weather-' + risk;
    el.hidden = false;
    el.innerHTML =
      '<span class="header-weather-icon">' + icon + '</span>' +
      '<span class="header-weather-temp">' + escapeHTML(temp) + '</span>';
  }

  function escapeHTML(s) {
    if (typeof window.escapeHTML === 'function') return window.escapeHTML(s);
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function fetchAndPaint(lat, lng) {
    if (!window.p86Api || !window.p86Api.weather || !window.p86Api.weather.coords) {
      return;
    }
    return window.p86Api.weather.coords(lat, lng).then(function (res) {
      if (!res || res.status !== 'ok' || !Array.isArray(res.days) || !res.days.length) {
        // out_of_range / error / etc. — chip stays hidden silently.
        return;
      }
      // Pull today's day. Forecast may start with tomorrow's day if
      // it's already past sunset; in that case use the first available.
      var todayIso = new Date().toISOString().slice(0, 10);
      var today = res.days.find(function (d) { return d.date === todayIso; }) || res.days[0];
      _state.risk = today.risk || 'green';
      _state.summary = today.summary || '';
      _state.tempHigh = today.tempHigh;
      _state.tempLow = today.tempLow;
      _state.precipPct = today.precipPct || 0;
      _state.windMph = today.windMph || 0;
      _state.lastFetchAt = Date.now();
      paintChip();
    }).catch(function (err) {
      console.warn('[header-weather] forecast fetch failed:', err && err.message);
    });
  }

  function start() {
    if (_state.started) return;
    if (!window.p86Api || !window.p86Api.isAuthenticated || !window.p86Api.isAuthenticated()) {
      return; // wait for auth — caller will retry on auth-ready signal
    }
    _state.started = true;
    var cached = loadCachedCoords();
    if (cached) {
      _state.coords = cached;
      fetchAndPaint(cached.lat, cached.lng);
      return;
    }
    getBrowserCoords().then(function (c) {
      _state.coords = c;
      saveCachedCoords(c.lat, c.lng);
      fetchAndPaint(c.lat, c.lng);
    }).catch(function (err) {
      // Permission denied / unavailable / timeout — leave the chip
      // hidden. Don't surface a notification or pester the user.
      console.info('[header-weather] geolocation skipped:', err && err.message);
    });
  }

  // Click handler: refetch on demand. Useful when the cached forecast
  // is stale (e.g., user has been on the page for hours) — server-side
  // cache makes this nearly free anyway.
  function wireClick() {
    var el = document.getElementById('header-weather');
    if (!el) return;
    el.addEventListener('click', function () {
      if (!_state.coords) return;
      fetchAndPaint(_state.coords.lat, _state.coords.lng);
    });
  }

  function boot() {
    wireClick();
    // First attempt — if not authenticated yet, this no-ops and the
    // retry below handles it once auth resolves.
    start();
    // Re-attempt every couple seconds for the first ~20s after load,
    // since auth can resolve asynchronously after the bundle parses.
    var attempts = 0;
    var iv = setInterval(function () {
      if (_state.started || ++attempts > 10) { clearInterval(iv); return; }
      start();
    }, 2000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Public surface — exposed so other modules can force a refresh
  // (e.g., after a long sleep or visibility-change wakeup).
  window.p86HeaderWeather = {
    refresh: function () {
      if (_state.coords) fetchAndPaint(_state.coords.lat, _state.coords.lng);
      else start();
    }
  };
})();
