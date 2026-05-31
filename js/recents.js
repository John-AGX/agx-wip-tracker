/* ── Recents (sidebar) ─────────────────────────────────────────────
   Client-side, localStorage-backed list of recently opened jobs,
   estimates, leads and clients. There is no server-side "recents"
   concept — this lives entirely in the browser so it costs nothing
   and works per-device.

   How it captures opens: it wraps the four canonical entity-open
   functions (editJob / editEstimate / openEditLeadModal /
   openEditClientModal) the same way js/router.js does. When one runs,
   we record {type, id} and resolve a display name. Names for jobs and
   estimates come from window.appData; lead/client names are only known
   once their detail view renders, so we read the title element and
   retry briefly while it loads.

   Clicking a recent reopens the entity via window.p86Router.navigate()
   — the canonical route shapes the router already understands.

   Exposes window.p86Recents = { push, render, clear }. */
(function () {
  'use strict';

  var STORAGE_KEY = 'p86_recents_v1';
  var CAP = 8;

  // type → sidebar icon name (agx-icons.js) and fallback-label noun.
  var ICONS = { jobs: 'wip', estimates: 'estimates', leads: 'leads', clients: 'clients' };
  var NOUNS = { jobs: 'Job', estimates: 'Estimate', leads: 'Lead', clients: 'Client' };

  // ── storage ──────────────────────────────────────────────────────
  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function save(list) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, CAP)));
    } catch (e) {
      /* quota / disabled storage — recents are best-effort */
    }
  }

  // Move (or insert) {type,id} to the front, most-recent-first, dedup
  // by type+id. A truthy `name` updates the stored label; a null name
  // never clobbers a previously-resolved one.
  function upsert(type, id, name) {
    var list = load();
    var key = type + '|' + String(id);
    var idx = -1;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && (list[i].type + '|' + String(list[i].id)) === key) { idx = i; break; }
    }
    var entry;
    if (idx >= 0) {
      entry = list.splice(idx, 1)[0];
      if (name) entry.name = name;
    } else {
      entry = { type: type, id: id, name: name || null };
    }
    entry.ts = Date.now();
    list.unshift(entry);
    save(list);
  }

  // ── name resolution (hybrid: caches first, then detail-view title) ─
  function txt(el) { return el && el.textContent ? el.textContent.trim() : ''; }

  function resolveName(type, id) {
    var sid = String(id);
    try {
      if (type === 'jobs') {
        var jobs = (window.appData && window.appData.jobs) || [];
        for (var i = 0; i < jobs.length; i++) {
          if (String(jobs[i].id) === sid) {
            var j = jobs[i];
            return j.jobNumber ? (j.jobNumber + ' — ' + (j.title || '')) : (j.title || '');
          }
        }
        var jt = txt(document.getElementById('job-detail-title'));
        if (jt) return jt;
      } else if (type === 'estimates') {
        var ests = (window.appData && window.appData.estimates) || [];
        for (var k = 0; k < ests.length; k++) {
          if (String(ests[k].id) === sid) return ests[k].title || '';
        }
        var et = txt(document.getElementById('ee-title'));
        if (et) return et;
      } else if (type === 'leads') {
        var lt = txt(document.getElementById('leadEditor_title'));
        if (lt) { lt = lt.replace(/^Edit Lead:\s*/i, '').trim(); if (lt) return lt; }
      } else if (type === 'clients') {
        var ct = txt(document.getElementById('clientEditor_title'));
        if (ct) { ct = ct.replace(/^Edit Client:\s*/i, '').trim(); if (ct) return ct; }
      }
    } catch (e) { /* defensive */ }
    return '';
  }

  // Record an open. Pushes immediately with whatever name we can get,
  // then polls briefly to fill in an async-loaded name (lead/client
  // detail titles, or jobs/estimates opened before appData lands).
  function track(type, id) {
    if (id == null || id === '') return;
    var name = resolveName(type, id);
    upsert(type, id, name);
    render();
    if (!name) {
      var tries = 0;
      var iv = setInterval(function () {
        tries++;
        var n = resolveName(type, id);
        if (n) { upsert(type, id, n); render(); clearInterval(iv); }
        else if (tries >= 14) clearInterval(iv); // ~2.1s
      }, 150);
    }
  }

  // ── render ───────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function render() {
    var section = document.getElementById('app-sidebar-recents');
    var listEl = document.getElementById('sidebar-recents-list');
    if (!section || !listEl) return;
    var list = load();
    if (!list.length) {
      section.setAttribute('hidden', '');
      listEl.innerHTML = '';
      return;
    }
    section.removeAttribute('hidden');
    listEl.innerHTML = list.map(function (r) {
      var icon = ICONS[r.type] || 'estimates';
      var label = r.name || (NOUNS[r.type] || 'Item') + ' ' + r.id;
      var safe = esc(label);
      return '<button class="sidebar-recent-item" type="button" ' +
        'data-type="' + esc(r.type) + '" data-id="' + esc(r.id) + '" ' +
        'data-p86-icon="' + icon + '" title="' + safe + '">' +
        '<span class="sidebar-recent-label">' + safe + '</span></button>';
    }).join('');
    if (typeof window.p86IconDecorate === 'function') {
      try { window.p86IconDecorate(listEl); } catch (e) { /* icons also auto-hydrate via observer */ }
    }
  }

  function clear() {
    save([]);
    render();
  }

  // ── navigation ───────────────────────────────────────────────────
  function routeFor(type, id) {
    if (type === 'jobs') return { top: 'jobs', jobId: id };
    if (type === 'estimates') return { top: 'estimates', estId: id };
    if (type === 'leads') return { top: 'estimates', estSub: 'leads', leadId: id };
    if (type === 'clients') return { top: 'estimates', estSub: 'clients', clientId: id };
    return null;
  }

  function openRecent(type, domId) {
    // Recover the original-typed id (number vs string) from storage so
    // the open functions' strict id comparisons still match.
    var list = load();
    var realId = domId;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].type === type && String(list[i].id) === String(domId)) {
        realId = list[i].id; break;
      }
    }
    var route = routeFor(type, realId);
    if (route && window.p86Router && typeof window.p86Router.navigate === 'function') {
      window.p86Router.navigate(route);
    }
  }

  // ── wire the entity-open functions (mirrors router.js wrapNav) ─────
  function wrapOpen(name, type) {
    var fn = window[name];
    if (typeof fn !== 'function') return false;
    if (fn.__p86RecentsWrapped) return true;
    var wrapped = function () {
      var r = fn.apply(this, arguments);
      try { track(type, arguments[0]); } catch (e) { /* never break the open */ }
      return r;
    };
    wrapped.__p86RecentsWrapped = true;
    wrapped.__p86RecentsOrig = fn;
    window[name] = wrapped;
    return true;
  }

  function wireAll() {
    var targets = [
      ['editJob', 'jobs'],
      ['editEstimate', 'estimates'],
      ['openEditLeadModal', 'leads'],
      ['openEditClientModal', 'clients']
    ];
    var pending = targets.slice();
    function attempt() {
      pending = pending.filter(function (t) { return !wrapOpen(t[0], t[1]); });
      return pending.length === 0;
    }
    if (attempt()) return;
    // Some open functions load after this script — retry briefly.
    var tries = 0;
    var iv = setInterval(function () {
      if (attempt() || ++tries > 40) clearInterval(iv); // ~8s
    }, 200);
  }

  // ── init ─────────────────────────────────────────────────────────
  function init() {
    var listEl = document.getElementById('sidebar-recents-list');
    if (listEl) {
      listEl.addEventListener('click', function (e) {
        var btn = e.target.closest('.sidebar-recent-item');
        if (!btn) return;
        e.preventDefault();
        openRecent(btn.getAttribute('data-type'), btn.getAttribute('data-id'));
      });
    }
    var clearBtn = document.getElementById('sidebar-recents-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        clear();
      });
    }
    render();
    wireAll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.p86Recents = {
    push: track,
    render: render,
    clear: clear
  };
})();
