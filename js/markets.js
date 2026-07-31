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

  /* ── M2: the global market selection ──────────────────────────────────
   * ONE selection drives every list / map / KPI. null = "All markets"
   * (the exec roll-up). Persisted per user in localStorage so a reload
   * lands you back in the market you were working.
   *
   * Surfaces DON'T poll this — they listen for p86:market-changed and
   * re-render. Anything that filters must treat a NULL market_id row as
   * "unassigned": it shows under All markets, and under no specific one.
   * ─────────────────────────────────────────────────────────────────── */
  var LS_KEY = 'p86_active_market';
  var _sel = null;
  try { _sel = localStorage.getItem(LS_KEY) || null; } catch (_) {}

  function selectedId() { return _sel; }
  function selected() { return _sel ? byId(_sel) : null; }

  function select(id) {
    var next = (id === '' || id === undefined) ? null : (id === null ? null : String(id));
    if (String(_sel) === String(next)) return;
    _sel = next;
    try { next ? localStorage.setItem(LS_KEY, next) : localStorage.removeItem(LS_KEY); } catch (_) {}
    renderSwitcher();
    try {
      document.dispatchEvent(new CustomEvent('p86:market-changed', {
        detail: { market_id: _sel, market: selected() }
      }));
    } catch (_) {}
  }

  // Which market does this record belong to? Returns the market RECORD
  // (or null when unassigned / not yet cached). The market_id FK wins;
  // the legacy `market` TEXT name is the fallback so a row that hasn't
  // been backfilled still resolves. Every surface that needs to SHOW a
  // market — the list chips, the P&L rollup — goes through here, so
  // there's exactly one answer to "what market is this?".
  function resolve(rec) {
    if (!rec) return null;
    if (rec.market_id != null && rec.market_id !== '') {
      var m = byId(rec.market_id);
      if (m) return m;
    }
    return rec.market ? byName(rec.market) : null;
  }

  // Does a record belong in the current view? The ONE predicate every
  // surface should use, so "unassigned" is handled identically everywhere.
  function matches(rec) {
    if (!_sel) return true;                       // All markets
    if (!rec) return false;
    // Goes through resolve() — the ONE answer to "what market is this?" —
    // rather than re-deriving market_id-then-name here. Two copies of that
    // rule WOULD drift: the chip could say Tampa while the filter disagreed.
    var m = resolve(rec);
    return !!m && String(m.id) === String(_sel);
  }
  function filter(list) {
    if (!_sel || !Array.isArray(list)) return list || [];
    return list.filter(matches);
  }

  // Is this org actually multi-market? Same >=2 test the switcher uses,
  // so the Market column and the P&L comparison appear and disappear
  // together with it — a single-market org gets no dead chrome anywhere.
  function hasMulti() { return active().length >= 2; }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Market color chip for a list cell. Falls back to the record's raw
  // legacy market TEXT when the markets cache can't resolve it (cold
  // cache / deactivated market), so a cell never goes blank on data that
  // visibly has a market — it just renders without a color.
  function chipHTML(rec) {
    var m = resolve(rec);
    var label = m ? m.name : (rec && rec.market) || '';
    if (!label) return '<span class="p86-mkt-chip p86-mkt-chip--none">&mdash;</span>';
    var color = (m && m.color) || '#8b90a5';
    return '<span class="p86-mkt-chip" title="' + esc(label) + (m && m.code ? ' (' + esc(m.code) + ')' : '') + '">' +
             '<span class="p86-mkt-dot" style="background:' + esc(color) + ';"></span>' +
             esc(label) +
           '</span>';
  }

  // The market NAME for sorting / export — plain text, same resolution.
  function nameFor(rec) {
    var m = resolve(rec);
    return m ? m.name : ((rec && rec.market) || '');
  }

  // ── switcher UI ──
  function renderSwitcher() {
    var host = document.getElementById('app-sidebar-market');
    if (!host) return;
    var list = active();
    // A single-market org gets no chrome — the switcher would be a no-op.
    if (list.length < 2) { host.hidden = true; host.innerHTML = ''; return; }
    host.hidden = false;
    var cur = selected();
    var opts = ['<option value="">All markets</option>'].concat(list.map(function (m) {
      var s = String(m.id) === String(_sel) ? ' selected' : '';
      return '<option value="' + m.id + '"' + s + '>' + (m.name || '') + '</option>';
    })).join('');
    host.innerHTML =
      '<label class="sidebar-market-label" for="p86-market-select">Market</label>' +
      '<div class="sidebar-market-row">' +
        '<span class="sidebar-market-dot" style="background:' + ((cur && cur.color) || '#8b90a5') + '"></span>' +
        '<select id="p86-market-select" class="sidebar-market-select" ' +
                'aria-label="Active market — scopes every list and dashboard">' + opts + '</select>' +
      '</div>';
    var sel = host.querySelector('#p86-market-select');
    if (sel) sel.addEventListener('change', function () { select(sel.value || null); });
  }

  window.p86Markets = {
    load: load, all: all, active: active, byId: byId, byName: byName, names: names,
    selectedId: selectedId, selected: selected, select: select,
    matches: matches, filter: filter, renderSwitcher: renderSwitcher,
    resolve: resolve, chipHTML: chipHTML, nameFor: nameFor, hasMulti: hasMulti
  };
  // Convenience globals for the string-concat pickers + list filters.
  window.p86MarketNames = names;
  window.p86MarketFilter = filter;

  // Re-render whatever surface is open. Each entry is best-effort and
  // independently guarded: a page that isn't mounted (or a renderer that
  // throws) must never stop the others from updating — a half-switched UI
  // showing two markets at once is worse than a stale one.
  //
  // Verified-global renderers ONLY. Guessed names silently never fire —
  // the switcher would filter the data and leave the DOM stale, which
  // reads as "the switcher is broken". `renderSummary` / `renderDashboard`
  // were exactly that: neither has ever existed (the real one is
  // renderSummaryDashboard), so nothing on Summary ever re-rendered.
  // p86MarketPnlRender is the targeted repaint for the Summary P&L block —
  // preferred over renderSummaryDashboard, which would re-fire every
  // agenda/inbox/manifest fetch on the page just to update one table.
  var RERENDER = ['renderJobsMain', 'renderLeadsList', 'renderEstimatesList',
                  'p86MarketPnlRender'];
  function rerenderSurfaces() {
    RERENDER.forEach(function (fn) {
      try { if (typeof window[fn] === 'function') window[fn](); } catch (e) {
        console.warn('[markets] re-render failed for ' + fn + ':', e && e.message);
      }
    });
  }

  // The cache is warmed asynchronously, so a list that painted first has
  // blank Market chips (nothing to resolve against yet). Repaint once the
  // markets land — otherwise the column looks broken until you navigate.
  document.addEventListener('p86:markets-loaded', function () {
    renderSwitcher();
    rerenderSurfaces();
  });
  document.addEventListener('p86:market-changed', rerenderSurfaces);

  // Warm the cache once auth is up. The app fires p86:auth-ready; if we
  // missed it (script order), fall back to a direct load.
  document.addEventListener('p86:auth-ready', function () { load(true); });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { load(); });
  } else {
    load();
  }
})();
