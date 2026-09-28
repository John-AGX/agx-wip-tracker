/* ── Global search (sidebar) ───────────────────────────────────────
   Debounced, server-backed search across jobs / estimates / leads /
   clients. Unlike the Recents list (which only knows what's been
   opened on this device), this hits GET /api/search and so finds any
   entity in the org regardless of what appData has loaded.

   Flow: type ≥2 chars → debounce ~200ms → fetch → render a grouped
   dropdown → click (or Enter on the highlighted row) reopens the
   entity via window.p86Router.navigate(), reusing the same canonical
   route shapes the router and Recents use.

   Keyboard: ArrowDown/ArrowUp move the active row, Enter opens it,
   Escape clears + closes.

   Phone widths: the header has no room for the box, so CSS hides it and
   #header-search-btn (the magnifying glass) drops it open as a full-width
   panel under the sticky header — setMobileOpen() below. Desktop never
   sets the panel class, so nothing here changes the desktop box.

   Exposes window.p86Search = { open, close, clear, toggleMobile }. */
(function () {
  'use strict';

  var DEBOUNCE_MS = 200;
  var MIN_CHARS = 2;
  var PER_TYPE = 6;

  // type → sidebar icon name (agx-icons.js) and group heading.
  var ICONS = { jobs: 'wip', estimates: 'estimates', leads: 'leads', clients: 'clients' };
  var GROUP_LABELS = { jobs: 'Jobs', estimates: 'Estimates', leads: 'Leads', clients: 'Clients' };
  var GROUP_ORDER = ['jobs', 'estimates', 'leads', 'clients'];

  var inputEl = null;
  var resultsEl = null;
  var debounceTimer = null;
  var reqSeq = 0;            // guards against out-of-order responses
  var current = [];          // flat list of currently-rendered results
  var activeIdx = -1;        // keyboard-highlighted row index
  var wrapEl = null;         // #app-sidebar-search
  var mobileBtn = null;      // #header-search-btn (phone widths only)

  // ── helpers ────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function routeFor(type, id) {
    if (type === 'jobs') return { top: 'jobs', jobId: id };
    if (type === 'estimates') return { top: 'estimates', estId: id };
    if (type === 'leads') return { top: 'estimates', estSub: 'leads', leadId: id };
    if (type === 'clients') return { top: 'estimates', estSub: 'clients', clientId: id };
    return null;
  }

  // ── render ──────────────────────────────────────────────────────
  function showEmpty(msg) {
    current = [];
    activeIdx = -1;
    resultsEl.innerHTML = '<div class="sidebar-search-empty">' + esc(msg) + '</div>';
    resultsEl.removeAttribute('hidden');
  }

  function close() {
    if (resultsEl) {
      resultsEl.setAttribute('hidden', '');
      resultsEl.innerHTML = '';
    }
    current = [];
    activeIdx = -1;
  }

  function render(results) {
    current = results;
    activeIdx = -1;
    if (!results.length) {
      showEmpty('No matches');
      return;
    }
    // Group by type, preserving GROUP_ORDER, so the flat `current`
    // index lines up with the rendered button order.
    var byType = {};
    results.forEach(function (r) {
      (byType[r.type] = byType[r.type] || []).push(r);
    });

    var html = '';
    var flatIdx = 0;
    GROUP_ORDER.forEach(function (type) {
      var rows = byType[type];
      if (!rows || !rows.length) return;
      html += '<div class="sidebar-search-group-label">' + esc(GROUP_LABELS[type] || type) + '</div>';
      rows.forEach(function (r) {
        var icon = ICONS[r.type] || 'estimates';
        var name = esc(r.name || (window.entityDisplayName && window.entityDisplayName(r.type, r.id)) || r.type);
        var sub = r.sub ? '<span class="sidebar-search-item-sub">' + esc(r.sub) + '</span>' : '';
        html += '<button class="sidebar-search-item" type="button" role="option" ' +
          'data-idx="' + flatIdx + '" data-type="' + esc(r.type) + '" data-id="' + esc(r.id) + '" ' +
          'data-p86-icon="' + icon + '" title="' + name + '">' +
          '<span class="sidebar-search-item-text">' +
          '<span class="sidebar-search-item-name">' + name + '</span>' + sub +
          '</span></button>';
        flatIdx++;
      });
    });
    resultsEl.innerHTML = html;
    resultsEl.removeAttribute('hidden');
    if (typeof window.p86IconDecorate === 'function') {
      try { window.p86IconDecorate(resultsEl); } catch (e) { /* observer also hydrates */ }
    }
  }

  function setActive(idx) {
    var items = resultsEl.querySelectorAll('.sidebar-search-item');
    if (!items.length) return;
    if (idx < 0) idx = items.length - 1;
    if (idx >= items.length) idx = 0;
    activeIdx = idx;
    for (var i = 0; i < items.length; i++) {
      if (i === idx) {
        items[i].classList.add('active');
        items[i].scrollIntoView({ block: 'nearest' });
      } else {
        items[i].classList.remove('active');
      }
    }
  }

  // ── phone drop-down panel ───────────────────────────────────────
  function isMobileOpen() { return !!(wrapEl && wrapEl.classList.contains('is-mopen')); }
  function setMobileOpen(open) {
    if (!wrapEl || !mobileBtn) return;
    if (open === isMobileOpen()) return;
    if (open) {
      // Pin the panel to the header's real bottom edge — the phone header's
      // height moves with its padding tiers (640 / 480px), so no constant.
      var header = wrapEl.closest('header');
      var top = header ? Math.round(header.getBoundingClientRect().bottom) : 0;
      wrapEl.style.setProperty('--p86-msearch-top', Math.max(0, top) + 'px');
      wrapEl.classList.add('is-mopen');
      mobileBtn.setAttribute('aria-expanded', 'true');
      // Synchronous, inside the tap handler — iOS only raises the keyboard
      // for a focus() made during the user gesture.
      try { inputEl.focus(); } catch (e) {}
    } else {
      wrapEl.classList.remove('is-mopen');
      mobileBtn.setAttribute('aria-expanded', 'false');
      close();
      try { inputEl.blur(); } catch (e) {}
    }
  }

  // ── navigation ──────────────────────────────────────────────────
  function openResult(type, id) {
    var route = routeFor(type, id);
    if (route && window.p86Router && typeof window.p86Router.navigate === 'function') {
      window.p86Router.navigate(route);
    }
    if (inputEl) inputEl.value = '';
    close();
    setMobileOpen(false);
  }

  function openActive() {
    if (activeIdx < 0 || activeIdx >= current.length) {
      // Default to the first result if none highlighted.
      if (current.length) { openResult(current[0].type, current[0].id); }
      return;
    }
    var r = current[activeIdx];
    openResult(r.type, r.id);
  }

  // ── fetch ───────────────────────────────────────────────────────
  function runSearch(q) {
    var seq = ++reqSeq;
    if (!window.p86Api || typeof window.p86Api.get !== 'function') return;
    window.p86Api.get('/api/search?q=' + encodeURIComponent(q) + '&limit=' + PER_TYPE)
      .then(function (data) {
        if (seq !== reqSeq) return;                 // stale response
        render((data && data.results) || []);
      })
      .catch(function () {
        if (seq !== reqSeq) return;
        showEmpty('Search unavailable');
      });
  }

  function onInput() {
    var q = (inputEl.value || '').trim();
    if (debounceTimer) clearTimeout(debounceTimer);
    if (q.length < MIN_CHARS) {
      close();
      return;
    }
    debounceTimer = setTimeout(function () { runSearch(q); }, DEBOUNCE_MS);
  }

  function onKeydown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(activeIdx + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(activeIdx - 1);
    } else if (e.key === 'Enter') {
      if (!resultsEl.hasAttribute('hidden') && current.length) {
        e.preventDefault();
        openActive();
      }
    } else if (e.key === 'Escape') {
      inputEl.value = '';
      close();
      inputEl.blur();
      setMobileOpen(false);
    }
  }

  // ── init ────────────────────────────────────────────────────────
  function init() {
    inputEl = document.getElementById('sidebar-search-input');
    resultsEl = document.getElementById('sidebar-search-results');
    if (!inputEl || !resultsEl) return;
    wrapEl = document.getElementById('app-sidebar-search');
    mobileBtn = document.getElementById('header-search-btn');
    if (mobileBtn) {
      mobileBtn.addEventListener('click', function (e) {
        e.preventDefault();
        setMobileOpen(!isMobileOpen());
      });
    }

    inputEl.addEventListener('input', onInput);
    inputEl.addEventListener('keydown', onKeydown);
    inputEl.addEventListener('focus', function () {
      // Re-show results if there's still a query and rows.
      if (current.length && (inputEl.value || '').trim().length >= MIN_CHARS) {
        resultsEl.removeAttribute('hidden');
      }
    });

    // Clicking a result row opens it (delegation).
    resultsEl.addEventListener('mousedown', function (e) {
      // mousedown (not click) so it fires before the input blur closes us.
      var btn = e.target.closest('.sidebar-search-item');
      if (!btn) return;
      e.preventDefault();
      openResult(btn.getAttribute('data-type'), btn.getAttribute('data-id'));
    });

    // On the collapsed rail the input is hidden — clicking the box
    // should expand the sidebar so the user can type. The toggle lives
    // in app.js; we just click it when collapsed. Only applies when the
    // box is actually INSIDE the sidebar — the search now lives in the
    // sticky header, where a click must never toggle the sidebar.
    var box = inputEl.closest('.sidebar-search-box');
    if (box && box.closest('#app-sidebar')) {
      box.addEventListener('click', function () {
        var sidebar = document.getElementById('app-sidebar');
        if (sidebar && sidebar.classList.contains('collapsed')) {
          var toggle = document.getElementById('app-sidebar-toggle');
          if (toggle) toggle.click();
          setTimeout(function () { try { inputEl.focus(); } catch (e) {} }, 60);
        }
      });
    }

    // Close when clicking outside the search widget. The glass is outside
    // the widget too, but it runs its own toggle first — closing here would
    // shut the panel in the same tap that opened it.
    document.addEventListener('click', function (e) {
      var wrap = document.getElementById('app-sidebar-search');
      if (!wrap || wrap.contains(e.target)) return;
      if (mobileBtn && mobileBtn.contains(e.target)) return;
      close();
      setMobileOpen(false);
    });
    // Back/forward navigates without a tap outside; a panel left open over
    // the new page reads as stuck.
    window.addEventListener('popstate', function () { setMobileOpen(false); });
    // Widening past phone width hides the glass; drop the panel state with it
    // so aria-expanded never claims an open panel nobody can see.
    if (window.matchMedia) {
      var mq = window.matchMedia('(max-width: 768px)');
      var onMq = function () { if (!mq.matches) setMobileOpen(false); };
      if (mq.addEventListener) mq.addEventListener('change', onMq);
      else if (mq.addListener) mq.addListener(onMq);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.p86Search = {
    open: function () { if (inputEl) inputEl.focus(); },
    close: close,
    clear: function () { if (inputEl) inputEl.value = ''; close(); },
    toggleMobile: function (open) { setMobileOpen(open == null ? !isMobileOpen() : !!open); }
  };
})();
