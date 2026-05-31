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

   Exposes window.p86Search = { open, close, clear }. */
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
        var name = esc(r.name || (r.type + ' ' + r.id));
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

  // ── navigation ──────────────────────────────────────────────────
  function openResult(type, id) {
    var route = routeFor(type, id);
    if (route && window.p86Router && typeof window.p86Router.navigate === 'function') {
      window.p86Router.navigate(route);
    }
    if (inputEl) inputEl.value = '';
    close();
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
    }
  }

  // ── init ────────────────────────────────────────────────────────
  function init() {
    inputEl = document.getElementById('sidebar-search-input');
    resultsEl = document.getElementById('sidebar-search-results');
    if (!inputEl || !resultsEl) return;

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
    // in app.js; we just click it when collapsed.
    var box = inputEl.closest('.sidebar-search-box');
    if (box) {
      box.addEventListener('click', function () {
        var sidebar = document.getElementById('app-sidebar');
        if (sidebar && sidebar.classList.contains('collapsed')) {
          var toggle = document.getElementById('app-sidebar-toggle');
          if (toggle) toggle.click();
          setTimeout(function () { try { inputEl.focus(); } catch (e) {} }, 60);
        }
      });
    }

    // Close when clicking outside the search widget.
    document.addEventListener('click', function (e) {
      var wrap = document.getElementById('app-sidebar-search');
      if (wrap && !wrap.contains(e.target)) close();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.p86Search = {
    open: function () { if (inputEl) inputEl.focus(); },
    close: close,
    clear: function () { if (inputEl) inputEl.value = ''; close(); }
  };
})();
