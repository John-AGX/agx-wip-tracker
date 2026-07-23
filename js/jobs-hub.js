// Promise confirm. Native confirm() returns undefined inside an installed PWA,
// so every `if (!confirm(x)) return` guard silently did nothing there: the
// dialog never appeared and the action never ran. Uses the in-app overlay when
// present, native only as a fallback.
function p86Ask(message, opts) {
  opts = opts || {};
  if (typeof window.p86Confirm === 'function') {
    return window.p86Confirm({
      title: opts.title || 'Confirm', message: message,
      confirmLabel: opts.confirmLabel || 'Confirm', confirmText: opts.confirmLabel || 'Confirm',
      cancelLabel: 'Cancel', cancelText: 'Cancel',
      danger: opts.danger !== false, destructive: opts.danger !== false
    });
  }
  return Promise.resolve(window.confirm(message));
}
// Project 86 — Jobs Hub
// =====================
// Cross-job index pages reached from the sidebar "Jobs" dropdown:
//   Purchase Orders · Change Orders · RFIs · Submittals
// Each is an org-wide list (NOT scoped to one job) defaulting to the
// open/active items, with a job filter + status filter + search and a
// "+ New" button whose form starts with a REQUIRED job picker. Drilling
// into a row opens the parent job at the relevant subtab so the existing
// in-job editors (Change Order editor, RFI/Submittal panel) handle the
// detail — the hub is the cross-job rollup, not a second editor.
//
// Mounted as the top-level "jobshub" tab (see app.js switchTab + index.html
// #jobshub pane). switchJobsHubSubTab() mirrors switchConsoleSubTab().
(function () {
  'use strict';

  var VIEWS = ['purchase-orders', 'bills', 'change-orders', 'rfis', 'submittals'];
  var DEFAULT_VIEW = 'change-orders';
  var _view = null;

  // In-app confirm — native confirm() silently no-ops in an installed PWA,
  // so a bulk action gated on it does nothing there. Pass both p86Confirm
  // impls' option keys (app.js + dialogs.js).
  function bulkConfirm(opts) {
    opts = opts || {};
    var o = {
      title: opts.title, message: opts.message,
      confirmLabel: opts.confirmLabel, confirmText: opts.confirmLabel,
      cancelLabel: opts.cancelLabel, cancelText: opts.cancelLabel,
      danger: !!opts.danger, destructive: !!opts.danger
    };
    return (typeof window.p86Confirm === 'function')
      ? window.p86Confirm(o)
      : Promise.resolve(window.confirm(opts.message || 'Are you sure?'));
  }
  // Per-view filter state persists for the session so flipping between
  // sub-tabs keeps your filters.
  var _state = {
    'purchase-orders': { status: 'open', job: '', q: '' },
    bills:             { status: 'open', job: '', q: '' },
    'change-orders':   { status: 'open', job: '', q: '' },
    rfis:              { status: 'open', job: '', q: '' },
    submittals:        { status: 'open', job: '', q: '' }
  };

  function esc(v) {
    if (typeof window.escapeHTML === 'function') return window.escapeHTML(v == null ? '' : String(v));
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtDate(s) {
    if (!s) return '';
    var d = new Date(s);
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString();
  }
  function jobsList() {
    return (window.appData && Array.isArray(window.appData.jobs)) ? window.appData.jobs : [];
  }
  function jobLabel(j) {
    if (!j) return 'Job';
    return (j.jobNumber ? j.jobNumber + ' — ' : '') + (j.title || 'Untitled job');
  }
  function isActiveJob(j) {
    if (!j) return false;
    var s = j.status || 'active';
    return s !== 'closed' && s !== 'Archived' && s !== 'Completed';
  }
  function jobLabelFromRow(row) {
    if (row.job_number || row.job_title) {
      return (row.job_number ? row.job_number + ' — ' : '') + (row.job_title || 'Job');
    }
    var j = jobsList().find(function (x) { return String(x.id) === String(row.job_id); });
    return j ? jobLabel(j) : 'Job';
  }
  function openParentJob(jobId, subtab) {
    if (!jobId) return;
    // Use the canonical router open — it sets the URL AND runs the
    // data-aware editJob + switchJobSubTab sequence atomically. The old
    // manual switchTab('jobs') + editJob path raced: switchTab renders the
    // jobs MAIN list (and a nav-state sync re-applied "/jobs" with no
    // jobId), re-hiding the detail editJob had just opened — leaving a
    // blank job screen.
    if (window.p86Router && typeof window.p86Router.navigate === 'function') {
      window.p86Router.navigate({ top: 'jobs', jobId: jobId, jobSub: subtab || null });
      return;
    }
    // Fallback only if the router isn't present.
    try { if (typeof window.switchTab === 'function') window.switchTab('jobs'); } catch (e) {}
    if (typeof window.editJob === 'function') window.editJob(jobId);
    if (subtab && typeof window.switchJobSubTab === 'function') {
      setTimeout(function () { try { window.switchJobSubTab(subtab); } catch (e) {} }, 60);
    }
  }

  // Per-entity status state machines — MUST mirror the server's
  // ALLOWED_TRANSITIONS (server/routes/change-order-routes.js and
  // server/routes/purchase-order-routes.js). Used to filter the bulk
  // "Set status" menu to transitions the server will actually accept,
  // so bulk changes don't 409-fail on illegal jumps.
  var CO_TRANSITIONS = {
    draft: ['approved'],
    approved: ['draft', 'applied'],
    applied: []
  };
  var PO_TRANSITIONS = {
    draft: ['issued'],
    issued: ['approved', 'draft'],
    approved: ['work_complete', 'issued'],
    work_complete: ['closed', 'approved'],
    closed: []
  };
  // Mirrors server/routes/bill-routes.js ALLOWED_TRANSITIONS.
  var BILL_TRANSITIONS = {
    open: ['approved', 'void', 'paid'],
    approved: ['paid', 'open', 'void'],
    paid: ['approved', 'open'],
    void: ['open']
  };

  // ── Status badges ──────────────────────────────────────────────────
  var STATUS_COLOR = {
    draft: '#94a3b8', approved: '#34d399', applied: '#2dd4bf',
    open: '#4f8cff', answered: '#34d399', closed: '#8b90a5',
    submitted: '#4f8cff', revise_resubmit: '#fbbf24', rejected: '#f87171',
    pending: '#fbbf24', sent: '#60a5fa', received: '#34d399',
    issued: '#4f8cff', work_complete: '#2dd4bf',
    paid: '#34d399', void: '#8b90a5'
  };
  function poLineTotal(l) {
    if (!l || l.section === '__section_header__') return 0;
    return (parseFloat(l.qty) || 0) * (parseFloat(l.unitCost) || 0);
  }
  function poSum(po) { return ((po && po.lines) || []).reduce(function (s, l) { return s + poLineTotal(l); }, 0); }
  function money(n) { n = Number(n) || 0; return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function statusBadge(status) {
    var s = String(status || '').toLowerCase();
    var c = STATUS_COLOR[s] || '#8b90a5';
    var label = s.replace(/_/g, ' ').replace(/\b\w/g, function (m) { return m.toUpperCase(); });
    return '<span class="badge p86-statuschip" style="--c:' + c + ';">' + esc(label) + '</span>';
  }

  // ── Shell + sub-tab switching ──────────────────────────────────────
  function renderJobsHubInto(host) {
    if (!host) return;
    host.innerHTML =
      '<div class="jobshub">' +
        VIEWS.map(function (v) {
          return '<div class="jobshub-section" id="jobshub-' + v + '" style="display:none;"></div>';
        }).join('') +
      '</div>';
    var persisted = null;
    try { persisted = sessionStorage.getItem('p86_jobshub_tab'); } catch (e) {}
    switchJobsHubSubTab(VIEWS.indexOf(persisted) >= 0 ? persisted : DEFAULT_VIEW);
  }

  function switchJobsHubSubTab(view) {
    if (VIEWS.indexOf(view) < 0) view = DEFAULT_VIEW;
    _view = view;
    try { sessionStorage.setItem('p86_jobshub_tab', view); } catch (e) {}
    // Show the active section; HIDE + CLEAR the others. buildView uses
    // shared ids (#jh-list, #jh-status, #jh-new…) per section, so leaving a
    // previously-visited section in the DOM creates duplicate ids and the
    // active view's getElementById would resolve to the hidden sibling.
    // Clearing guarantees exactly one live set of controls.
    VIEWS.forEach(function (v) {
      var el = document.getElementById('jobshub-' + v);
      if (!el) return;
      if (v === view) { el.style.display = 'block'; }
      else { el.style.display = 'none'; el.innerHTML = ''; }
    });
    loadView(view);
    if (typeof window.markVirtualTabActive === 'function') window.markVirtualTabActive('jobshub-' + view);
  }

  function loadView(view) {
    var host = document.getElementById('jobshub-' + view);
    if (!host) return;
    if (view === 'purchase-orders') return renderPO(host);
    if (view === 'bills')           return renderBills(host);
    if (view === 'change-orders')   return renderCO(host);
    if (view === 'rfis')            return renderWorkflow(host, 'rfi', 'RFIs');
    if (view === 'submittals')      return renderWorkflow(host, 'submittal', 'Submittals');
  }

  // Lets the PO editor refresh the hub list after a status change.
  var _currentRefetch = null;
  window.p86JobsHubRefresh = function () { if (typeof _currentRefetch === 'function') _currentRefetch(); };

  // After a bill create/edit/void/delete from the Bills tab, refresh the shared
  // cost-rollup store (appData.jobVendorBills) for that job so getJobPOAccrued /
  // the jobs-list accrued tiles reflect it without a full reload (Bills S3).
  function refreshBillRollup(jobId) {
    if (jobId && typeof window.loadBillsForJob === 'function') window.loadBillsForJob(jobId);
  }

  // ── Shared list scaffold ───────────────────────────────────────────
  function jobFilterHTML(selected) {
    var jobs = jobsList().slice().sort(function (a, b) {
      return String(b.jobNumber || '').localeCompare(String(a.jobNumber || ''));
    });
    var opts = '<option value="">All jobs</option>' + jobs.map(function (j) {
      return '<option value="' + esc(j.id) + '"' + (String(j.id) === String(selected) ? ' selected' : '') + '>' + esc(jobLabel(j)) + '</option>';
    }).join('');
    return '<select id="jh-job" class="jobshub-filter" title="Filter by job">' + opts + '</select>';
  }
  function statusFilterHTML(options, selected) {
    return '<select id="jh-status" class="jobshub-filter" title="Filter by status">' +
      options.map(function (o) {
        return '<option value="' + esc(o.v) + '"' + (o.v === selected ? ' selected' : '') + '>' + esc(o.label) + '</option>';
      }).join('') + '</select>';
  }

  function buildView(host, cfg) {
    var st = _state[cfg.key];
    host.innerHTML =
      '<div class="jobshub-head">' +
        '<div class="jobshub-title">' + esc(cfg.title) + '</div>' +
        '<div class="jobshub-actions">' +
          '<input id="jh-search" class="jobshub-search" type="text" placeholder="Search…" value="' + esc(st.q) + '" autocomplete="off">' +
          jobFilterHTML(st.job) +
          statusFilterHTML(cfg.statusOptions, st.status) +
          (cfg.viewsPage ? '<button id="jh-views" class="ee-btn ghost" type="button" title="Saved views">Views ▾</button>' : '') +
          (cfg.extraActionHTML || '') +
          '<button id="jh-new" class="ee-btn primary jobshub-new" type="button">+ New</button>' +
        '</div>' +
      '</div>' +
      '<div class="jobshub-summary" id="jh-summary"></div>' +
      '<div id="jh-bulkbar" style="display:none;"></div>' +
      '<div class="jobshub-list" id="jh-list"><div class="jobshub-loading">Loading…</div></div>';

    var _rows = [];
    var _selected = new Set();   // bulk-select ids (cfg.bulk views only)

    // ── Multi-select + bulk bar (CO / PO) ─────────────────────────────
    // Checkboxes are injected AFTER the per-view tableHTML renders so the
    // per-entity table builders stay untouched. Row ids come from
    // cfg.bulk.idAttr (data-co-id / data-po-id).
    function injectCheckboxes(listEl) {
      if (!cfg.bulk) return;
      var hr = listEl.querySelector('thead tr');
      if (hr && !hr.querySelector('.jh-check-th')) {
        var th = document.createElement('th');
        th.className = 'jh-check-th';
        th.style.cssText = 'width:34px;text-align:center;';
        th.innerHTML = '<input type="checkbox" id="jh-check-all" title="Select all shown">';
        hr.insertBefore(th, hr.firstChild);
        th.querySelector('input').addEventListener('click', function (e) {
          e.stopPropagation();
          var on = e.target.checked;
          listEl.querySelectorAll('.jh-check').forEach(function (b) {
            b.checked = on;
            var id = b.getAttribute('data-id');
            if (on) _selected.add(id); else _selected.delete(id);
          });
          updateBulkBar();
        });
      }
      listEl.querySelectorAll('tbody tr').forEach(function (tr) {
        var id = tr.getAttribute(cfg.bulk.idAttr);
        if (!id || tr.querySelector('.jh-check-td')) return;
        var td = document.createElement('td');
        td.className = 'jh-check-td';
        td.style.cssText = 'width:34px;text-align:center;';
        td.innerHTML = '<input type="checkbox" class="jh-check" data-id="' + esc(id) + '"' + (_selected.has(id) ? ' checked' : '') + '>';
        td.addEventListener('click', function (e) { e.stopPropagation(); });
        td.querySelector('input').addEventListener('change', function (e) {
          if (e.target.checked) _selected.add(id); else _selected.delete(id);
          updateBulkBar(); syncCheckAll(listEl);
        });
        tr.insertBefore(td, tr.firstChild);
      });
      syncCheckAll(listEl);
    }
    function syncCheckAll(listEl) {
      var all = listEl.querySelector('#jh-check-all');
      if (!all) return;
      var boxes = listEl.querySelectorAll('.jh-check');
      var checked = 0;
      boxes.forEach(function (b) { if (b.checked) checked++; });
      all.checked = boxes.length > 0 && checked === boxes.length;
      all.indeterminate = checked > 0 && checked < boxes.length;
    }
    // After a Bills-tab bulk status/delete, refresh the shared cost-rollup
    // store (appData.jobVendorBills) for each affected job so getJobPOAccrued /
    // the jobs-list tiles reflect it — the single-bill paths do this too.
    function bulkRefreshBillStore(ids) {
      if (cfg.key !== 'bills' || typeof window.loadBillsForJob !== 'function') return;
      var jset = {};
      (ids || []).forEach(function (id) {
        var r = (_rows || []).filter(function (x) { return String(x.id) === String(id); })[0];
        if (r && r.job_id) jset[r.job_id] = true;
      });
      Object.keys(jset).forEach(function (j) { window.loadBillsForJob(j); });
    }
    function updateBulkBar() {
      var bar = host.querySelector('#jh-bulkbar');
      if (!bar || !cfg.bulk) return;
      var n = _selected.size;
      if (!window.p86BulkRibbon) return;
      if (!n) { window.p86BulkRibbon.hide(bar); return; }
      function bulkSetStatus(v) {
        var ids = Array.from(_selected);
        bulkConfirm({ title: 'Set status', message: 'Set ' + ids.length + ' item(s) to "' + v.replace(/_/g, ' ') + '"?', confirmLabel: 'Set status' }).then(function (ok) {
          if (!ok) return;
          Promise.all(ids.map(function (id) { return cfg.bulk.setStatus(id, v).then(function () { return true; }).catch(function () { return false; }); }))
            .then(function (res) {
              var okc = res.filter(Boolean).length, fail = res.length - okc;
              if (typeof window.p86Toast === 'function') window.p86Toast('Status set on ' + okc + (fail ? ', ' + fail + ' failed' : '') + '.', fail ? 'error' : 'success');
              bulkRefreshBillStore(ids);
              _selected.clear(); refetch();
            });
        });
      }
      function bulkDelete() {
        var ids = Array.from(_selected);
        bulkConfirm({ title: 'Delete items', message: 'Delete ' + ids.length + ' item(s)? This cannot be undone.', confirmLabel: 'Delete', danger: true }).then(function (ok) {
          if (!ok) return;
          Promise.all(ids.map(function (id) { return cfg.bulk.remove(id).then(function () { return true; }).catch(function () { return false; }); }))
            .then(function (res) {
              var okc = res.filter(Boolean).length, fail = res.length - okc;
              if (typeof window.p86Toast === 'function') window.p86Toast('Deleted ' + okc + (fail ? ', ' + fail + ' failed (locked or no access)' : '') + '.', fail ? 'error' : 'success');
              bulkRefreshBillStore(ids);
              _selected.clear(); refetch();
            });
        });
      }
      // Offer only the statuses legally reachable (per the server's state
      // machine) from at least one selected row's CURRENT status — the
      // union across the selection. Anything else would just 409.
      var statuses = cfg.bulk.statusOptions;
      if (cfg.bulk.transitions) {
        var legal = {};
        _selected.forEach(function (id) {
          var row = _rows.find(function (r) { return String(r.id) === String(id); });
          var curSt = row ? String(row.status || 'draft').toLowerCase() : '';
          (cfg.bulk.transitions[curSt] || []).forEach(function (s) { legal[s] = true; });
        });
        statuses = cfg.bulk.statusOptions.filter(function (s) { return legal[s]; });
      }
      var actions = [];
      if (statuses.length) {
        actions.push({ icon: 'bookmark', title: 'Set status', menu: statuses.map(function (s) { return { label: s.replace(/_/g, ' '), onClick: function () { bulkSetStatus(s); } }; }) });
      }
      actions.push({ icon: 'delete', title: 'Delete ' + n, danger: true, onClick: bulkDelete });
      window.p86BulkRibbon.render(bar, {
        count: n,
        onClear: function () {
          _selected.clear();
          host.querySelectorAll('.jh-check').forEach(function (b) { b.checked = false; });
          var all = host.querySelector('#jh-check-all');
          if (all) { all.checked = false; all.indeterminate = false; }
          updateBulkBar();
        },
        actions: actions
      });
    }

    // ── Saved views: presets of {status, job, q} per hub list ─────────
    function openViewsPopover(anchor) {
      var existing = document.getElementById('jh-views-pop');
      if (existing) { existing.remove(); return; }
      if (!(window.p86Api && window.p86Api.listViews)) return;
      window.p86Api.listViews.list(cfg.viewsPage).then(function (r) {
        var views = (r && r.views) || [];
        var pop = document.createElement('div');
        pop.id = 'jh-views-pop';
        pop.style.cssText = 'position:fixed;z-index:100000;min-width:244px;background:var(--card-bg,#161a2b);border:1px solid var(--border,#333);border-radius:8px;padding:6px;box-shadow:0 8px 24px rgba(0,0,0,.45);font-size:13px;';
        pop.innerHTML = (views.length ? views.map(function (v) {
          return '<div data-view="' + esc(v.id) + '" style="display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:6px;">' +
            '<span class="jhv-apply" style="flex:1;cursor:pointer;">' + esc(v.name) + (v.is_default ? ' <span style="color:var(--text-dim,#888);font-size:10px;">(default)</span>' : '') + '</span>' +
            '<a href="#" data-def="' + esc(v.id) + '" title="Set as default" style="text-decoration:none;">★</a>' +
            '<a href="#" data-del="' + esc(v.id) + '" title="Delete" style="text-decoration:none;color:#f87171;">✕</a>' +
          '</div>';
        }).join('') : '<div style="padding:6px 8px;color:var(--text-dim,#888);">No saved views yet.</div>') +
        '<div style="border-top:1px solid var(--border,#333);margin-top:6px;padding-top:6px;"><button type="button" class="ee-btn jhv-save" style="width:100%;">＋ Save current filters as view…</button></div>';
        document.body.appendChild(pop);
        var r2 = anchor.getBoundingClientRect();
        pop.style.top = (r2.bottom + 4) + 'px';
        pop.style.left = Math.max(8, Math.min(r2.right - 244, window.innerWidth - 252)) + 'px';
        function close() { pop.remove(); document.removeEventListener('mousedown', onOut, true); }
        function onOut(e) { if (!pop.contains(e.target) && e.target !== anchor) close(); }
        setTimeout(function () { document.addEventListener('mousedown', onOut, true); }, 0);
        pop.querySelectorAll('.jhv-apply').forEach(function (sp) {
          sp.addEventListener('click', function () {
            var v = views.find(function (x) { return x.id === sp.parentNode.getAttribute('data-view'); });
            if (!v) return;
            var f = (v.config && v.config.filters) || {};
            st.status = f.status || 'open'; st.job = f.job || ''; st.q = f.q || '';
            close();
            buildView(host, cfg);   // rebuild so the selects reflect the preset
          });
        });
        pop.querySelectorAll('[data-def]').forEach(function (a) { a.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); window.p86Api.listViews.update(a.getAttribute('data-def'), { is_default: true }).then(function () { close(); if (typeof window.p86Toast === 'function') window.p86Toast('Default view set', 'success'); }); }); });
        pop.querySelectorAll('[data-del]').forEach(function (a) { a.addEventListener('click', async function (e) { e.preventDefault(); e.stopPropagation(); if (!(await p86Ask('Delete this saved view?'))) return; window.p86Api.listViews.remove(a.getAttribute('data-del')).then(close); }); });
        pop.querySelector('.jhv-save').addEventListener('click', function () {
          var name = prompt('Name this view:'); if (name == null) return; name = String(name).trim(); if (!name) return;
          window.p86Api.listViews.create({ page: cfg.viewsPage, name: name, config: { filters: { status: st.status, job: st.job, q: st.q } }, is_default: false })
            .then(function () { close(); if (typeof window.p86Toast === 'function') window.p86Toast('View saved', 'success'); })
            .catch(function () { if (typeof window.p86Toast === 'function') window.p86Toast('Could not save view', 'error'); });
        });
      });
    }
    // All lookups are scoped to THIS section host, not document-global ids.
    // Combined with switchJobsHubSubTab clearing inactive sections, a stale
    // fetch that resolves after the user switched away finds a cleared host
    // (querySelector → null) and harmlessly no-ops instead of painting its
    // rows into whatever section is now active.
    function repaint() {
      var listEl = host.querySelector('#jh-list');
      var sumEl = host.querySelector('#jh-summary');
      if (!listEl) return;
      var q = (st.q || '').toLowerCase();
      var rows = !q ? _rows : _rows.filter(function (r) { return cfg.matches(r, q); });
      if (sumEl) sumEl.textContent = rows.length + (rows.length === 1 ? ' item' : ' items');
      if (!rows.length) {
        listEl.innerHTML = '<div class="jobshub-empty">No ' + esc(cfg.title) + ' match.</div>';
        return;
      }
      listEl.innerHTML = cfg.tableHTML(rows);
      wireRows(listEl, cfg);
      injectCheckboxes(listEl);
      updateBulkBar();
      // Draggable / resizable columns (shared enhancer) — run AFTER
      // injectCheckboxes so the leading checkbox column already sits at
      // index 0 before the enhancer measures/reorders (CO/PO use frozen:null
      // so nothing sticky overlaps that checkbox).
      if (window.p86Tables && cfg.enhanceKey) window.p86Tables.enhance(cfg.enhanceKey);
    }
    function refetch() {
      var listEl = host.querySelector('#jh-list');
      if (listEl) listEl.innerHTML = '<div class="jobshub-loading">Loading…</div>';
      cfg.fetch(st).then(function (rows) { _rows = rows || []; repaint(); })
        .catch(function (err) {
          if (listEl) listEl.innerHTML = '<div class="jobshub-error">Failed to load: ' + esc((err && err.message) || 'error') + '</div>';
        });
    }
    _currentRefetch = refetch;
    var searchEl = host.querySelector('#jh-search');
    var jobEl = host.querySelector('#jh-job');
    var statusEl = host.querySelector('#jh-status');
    var newBtn = host.querySelector('#jh-new');
    if (searchEl) searchEl.addEventListener('input', function () { st.q = searchEl.value; repaint(); });
    if (jobEl) jobEl.addEventListener('change', function () { st.job = jobEl.value; refetch(); });
    if (statusEl) statusEl.addEventListener('change', function () { st.status = statusEl.value; refetch(); });
    if (newBtn) newBtn.addEventListener('click', function () { openCreateModal(cfg.createKind, refetch); });
    var viewsBtn = host.querySelector('#jh-views');
    if (viewsBtn) viewsBtn.addEventListener('click', function () { openViewsPopover(viewsBtn); });
    if (typeof cfg.wireExtra === 'function') cfg.wireExtra(host);
    refetch();
  }

  function wireRows(listEl, cfg) {
    listEl.querySelectorAll('tbody tr').forEach(function (tr) {
      if (!tr.getAttribute('data-job-id') && !tr.getAttribute('data-po-id')) return;
      tr.addEventListener('click', function () {
        if (typeof cfg.onRow === 'function') cfg.onRow(tr);
        else openParentJob(tr.getAttribute('data-job-id'), cfg.subtab);
      });
    });
  }

  // ── Change Orders ──────────────────────────────────────────────────
  function renderCO(host) {
    buildView(host, {
      key: 'change-orders',
      enhanceKey: 'jobshubCO',
      title: 'Change Orders',
      subtab: 'job-changeorders',
      createKind: 'co',
      viewsPage: 'change_orders',
      bulk: {
        idAttr: 'data-co-id',
        statusOptions: ['draft', 'approved', 'applied'],
        transitions: CO_TRANSITIONS,
        setStatus: function (id, v) { return window.p86Api.changeOrders.setStatus(id, v); },
        remove: function (id) { return window.p86Api.changeOrders.remove(id); }
      },
      onRow: function (tr) {
        var id = tr.getAttribute('data-co-id');
        if (id && window.p86ChangeOrders && typeof window.p86ChangeOrders.open === 'function') {
          window.p86ChangeOrders.open(id);
        } else {
          openParentJob(tr.getAttribute('data-job-id'), 'job-changeorders');
        }
      },
      statusOptions: [
        { v: 'open', label: 'Open (draft + approved)' }, { v: 'all', label: 'All' },
        { v: 'draft', label: 'Draft' }, { v: 'approved', label: 'Approved' }, { v: 'applied', label: 'Applied' }
      ],
      fetch: function (st) {
        return window.p86Api.changeOrders.listAll({ status: st.status, job: st.job })
          .then(function (r) { return (r && r.change_orders) || []; });
      },
      matches: function (r, q) {
        return [r.co_number, r.title, r.job_title, r.job_number].filter(Boolean).join(' ').toLowerCase().indexOf(q) !== -1;
      },
      tableHTML: function (rows) {
        return '<div class="p86-tbl-scroll"><table class="leads-table jobshub-table"><thead><tr>' +
          '<th data-col="co">CO #</th><th data-col="job">Job</th><th data-col="title">Title</th><th data-col="status">Status</th><th data-col="updated">Updated</th>' +
          '</tr></thead><tbody>' +
          rows.map(function (r) {
            return '<tr data-job-id="' + esc(r.job_id) + '" data-co-id="' + esc(r.id) + '">' +
              '<td data-col="co"><strong>' + esc(r.co_number || '') + '</strong></td>' +
              '<td data-col="job">' + esc(jobLabelFromRow(r)) + '</td>' +
              '<td data-col="title">' + esc(r.title || '(untitled)') + '</td>' +
              '<td data-col="status">' + statusBadge(r.status) + '</td>' +
              '<td data-col="updated">' + esc(fmtDate(r.updated_at)) + '</td>' +
            '</tr>';
          }).join('') + '</tbody></table></div>';
      }
    });
  }

  // ── RFIs / Submittals (job_workflow_items) ─────────────────────────
  function renderWorkflow(host, type, title) {
    var statusOpts = (type === 'rfi')
      ? [{ v: 'open', label: 'Open' }, { v: 'all', label: 'All' }, { v: 'answered', label: 'Answered' }, { v: 'closed', label: 'Closed' }]
      : [{ v: 'open', label: 'Open' }, { v: 'all', label: 'All' }, { v: 'submitted', label: 'Submitted' }, { v: 'approved', label: 'Approved' }, { v: 'revise_resubmit', label: 'Revise & Resubmit' }, { v: 'rejected', label: 'Rejected' }, { v: 'closed', label: 'Closed' }];
    buildView(host, {
      key: (type === 'rfi') ? 'rfis' : 'submittals',
      enhanceKey: (type === 'rfi') ? 'jobshubRFI' : 'jobshubSubmittal',
      title: title,
      subtab: 'job-workflow',
      createKind: type,
      viewsPage: (type === 'rfi') ? 'rfis' : 'submittals',
      statusOptions: statusOpts,
      onRow: function (tr) {
        var jobId = tr.getAttribute('data-job-id');
        // Tell the job's workflow pane which type + item to open, so a
        // click on a submittal lands on the Submittals tab with that
        // item expanded — not the default (empty) RFI tab.
        if (window.p86JobWorkflowUI && typeof window.p86JobWorkflowUI.setFocus === 'function') {
          window.p86JobWorkflowUI.setFocus({ jobId: jobId, type: type, itemId: tr.getAttribute('data-wf-id') });
        }
        openParentJob(jobId, 'job-workflow');
      },
      fetch: function (st) {
        return window.p86Api.workflowItems.listAll({ type: type, status: st.status, job: st.job })
          .then(function (r) { return (r && r.items) || []; });
      },
      matches: function (r, q) {
        return [r.number, r.subject, r.job_title, r.job_number].filter(Boolean).join(' ').toLowerCase().indexOf(q) !== -1;
      },
      tableHTML: function (rows) {
        return '<div class="p86-tbl-scroll"><table class="leads-table jobshub-table"><thead><tr>' +
          '<th data-col="num">#</th><th data-col="job">Job</th><th data-col="subject">Subject</th><th data-col="status">Status</th><th data-col="due">Due</th><th data-col="updated">Updated</th>' +
          '</tr></thead><tbody>' +
          rows.map(function (r) {
            var overdue = r.due_date && !r.closed_at && new Date(r.due_date).getTime() < Date.now();
            return '<tr data-job-id="' + esc(r.job_id) + '" data-wf-id="' + esc(r.id) + '">' +
              '<td data-col="num"><strong>' + esc(r.number || '') + '</strong></td>' +
              '<td data-col="job">' + esc(jobLabelFromRow(r)) + '</td>' +
              '<td data-col="subject">' + esc(r.subject || '') + '</td>' +
              '<td data-col="status">' + statusBadge(r.status) + '</td>' +
              '<td data-col="due"' + (overdue ? ' style="color:#f87171;font-weight:600;"' : '') + '>' + esc(fmtDate(r.due_date)) + '</td>' +
              '<td data-col="updated">' + esc(fmtDate(r.updated_at)) + '</td>' +
            '</tr>';
          }).join('') + '</tbody></table></div>';
      }
    });
  }

  // ── Purchase Orders ────────────────────────────────────────────────
  // Rows open the dedicated PO editor (window.p86PurchaseOrders), not the
  // parent job — the PO is its own contract document.
  function renderPO(host) {
    buildView(host, {
      key: 'purchase-orders',
      enhanceKey: 'jobshubPO',
      title: 'Purchase Orders',
      createKind: 'po',
      viewsPage: 'purchase_orders',
      bulk: {
        idAttr: 'data-po-id',
        statusOptions: ['draft', 'issued', 'approved', 'work_complete', 'closed'],
        transitions: PO_TRANSITIONS,
        setStatus: function (id, v) { return window.p86Api.purchaseOrders.setStatus(id, v); },
        remove: function (id) { return window.p86Api.purchaseOrders.remove(id); }
      },
      extraActionHTML: '<button id="jh-po-template" class="ee-btn jobshub-tpl-btn" type="button" title="Edit the org-wide scope-of-work template seeded into new POs">⚙ Template</button>',
      wireExtra: function (h) { var b = h.querySelector('#jh-po-template'); if (b) b.addEventListener('click', openScopeTemplateModal); },
      onRow: function (tr) {
        var id = tr.getAttribute('data-po-id');
        if (id && window.p86PurchaseOrders && typeof window.p86PurchaseOrders.open === 'function') {
          window.p86PurchaseOrders.open(id);
        }
      },
      statusOptions: [
        { v: 'open', label: 'Open' }, { v: 'all', label: 'All' },
        { v: 'draft', label: 'Draft' }, { v: 'issued', label: 'Issued' }, { v: 'approved', label: 'Approved' },
        { v: 'work_complete', label: 'Work Complete' }, { v: 'closed', label: 'Closed' }
      ],
      fetch: function (st) {
        return window.p86Api.purchaseOrders.listAll({ status: st.status, job: st.job })
          .then(function (r) { return (r && r.purchase_orders) || []; });
      },
      matches: function (r, q) {
        return [r.po_number, r.title, r.job_title, r.job_number, r.sub_name].filter(Boolean).join(' ').toLowerCase().indexOf(q) !== -1;
      },
      tableHTML: function (rows) {
        return '<div class="p86-tbl-scroll"><table class="leads-table jobshub-table"><thead><tr>' +
          '<th data-col="po">PO #</th><th data-col="job">Job</th><th data-col="sub">Sub</th><th data-col="title">Title</th><th class="num" data-col="total">Total</th><th data-col="status">Status</th>' +
          '</tr></thead><tbody>' +
          rows.map(function (r) {
            return '<tr data-po-id="' + esc(r.id) + '">' +
              '<td data-col="po"><strong>' + esc(r.po_number || '') + '</strong></td>' +
              '<td data-col="job">' + esc(jobLabelFromRow(r)) + '</td>' +
              '<td data-col="sub">' + esc(r.sub_name || '—') + '</td>' +
              '<td data-col="title">' + esc(r.title || '(untitled)') + '</td>' +
              '<td class="num" data-col="total">' + money(poSum(r)) + '</td>' +
              '<td data-col="status">' + statusBadge(r.status) + '</td>' +
            '</tr>';
          }).join('') + '</tbody></table></div>';
      }
    });
  }

  // ── Bills (Accounts Payable) ───────────────────────────────────────
  // A Bill is a vendor's invoice recorded against a job and (usually) a
  // Purchase Order — the money AGX owes. Rows open a lightweight editor
  // (PO context + editable fields + attach the invoice PDF). Amounts here
  // are the canonical source for the PO %-billed rollup once S3 repoints
  // it — the same unified store the PO editor writes to.
  var LIEN_OPTS = [
    { v: 'none', label: 'No waiver' },
    { v: 'conditional', label: 'Conditional' },
    { v: 'unconditional', label: 'Unconditional' }
  ];
  function billVendor(r) {
    return r.sub_name || (r.data && r.data.vendor) || '';
  }
  function renderBills(host) {
    buildView(host, {
      key: 'bills',
      enhanceKey: 'jobshubBills',
      title: 'Bills',
      createKind: 'bill',
      viewsPage: 'bills',
      bulk: {
        idAttr: 'data-bill-id',
        statusOptions: ['open', 'approved', 'paid', 'void'],
        transitions: BILL_TRANSITIONS,
        setStatus: function (id, v) { return window.p86Api.bills.setStatus(id, v); },
        remove: function (id) { return window.p86Api.bills.remove(id); }
      },
      onRow: function (tr) {
        var id = tr.getAttribute('data-bill-id');
        if (id) openBillEditor(id, function () { if (typeof window.p86JobsHubRefresh === 'function') window.p86JobsHubRefresh(); });
      },
      statusOptions: [
        { v: 'open', label: 'Open (unpaid)' }, { v: 'all', label: 'All' },
        { v: 'approved', label: 'Approved — ready to pay' }, { v: 'paid', label: 'Paid' }, { v: 'void', label: 'Void' }
      ],
      fetch: function (st) {
        return window.p86Api.bills.listAll({ status: st.status, job: st.job })
          .then(function (r) { return (r && r.bills) || []; });
      },
      matches: function (r, q) {
        return [r.bill_number, r.po_number, r.job_title, r.job_number, r.sub_name].filter(Boolean).join(' ').toLowerCase().indexOf(q) !== -1;
      },
      tableHTML: function (rows) {
        return '<div class="p86-tbl-scroll"><table class="leads-table jobshub-table"><thead><tr>' +
          '<th data-col="bill">Bill #</th><th data-col="job">Job</th><th data-col="vendor">Vendor</th><th data-col="po">PO #</th><th class="num" data-col="amount">Amount</th><th data-col="status">Status</th><th data-col="due">Due</th>' +
          '</tr></thead><tbody>' +
          rows.map(function (r) {
            var overdue = r.due_date && r.status !== 'paid' && r.status !== 'void' && new Date(r.due_date).getTime() < Date.now();
            return '<tr data-job-id="' + esc(r.job_id) + '" data-bill-id="' + esc(r.id) + '">' +
              '<td data-col="bill"><strong>' + esc(r.bill_number || '—') + '</strong></td>' +
              '<td data-col="job">' + esc(jobLabelFromRow(r)) + '</td>' +
              '<td data-col="vendor">' + esc(billVendor(r) || '—') + '</td>' +
              '<td data-col="po">' + esc(r.po_number || '—') + '</td>' +
              '<td class="num" data-col="amount">' + money(r.amount) + '</td>' +
              '<td data-col="status">' + statusBadge(r.status) + '</td>' +
              '<td data-col="due"' + (overdue ? ' style="color:#f87171;font-weight:600;"' : '') + '>' + esc(fmtDate(r.due_date)) + '</td>' +
            '</tr>';
          }).join('') + '</tbody></table></div>';
      }
    });
  }

  // ── Bill editor (PO context + editable fields + attach the invoice) ─
  // Exposed as window.p86Bills.open so the PO editor + doc-import can reuse it.
  function openBillEditor(billId, onSaved) {
    var overlay = document.createElement('div');
    overlay.className = 'jobshub-modal-overlay';
    overlay.innerHTML =
      '<div class="jobshub-modal jobshub-modal-wide" role="dialog" aria-modal="true">' +
        '<div class="jobshub-modal-head"><span id="jh-bill-head">Bill</span>' +
          '<button class="jobshub-modal-x" type="button" aria-label="Close">✕</button></div>' +
        '<div class="jobshub-modal-body"><div class="jobshub-loading">Loading…</div></div>' +
        '<div class="jobshub-modal-foot" style="display:none;"></div>' +
      '</div>';
    document.body.appendChild(overlay);
    function close() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    overlay.querySelector('.jobshub-modal-x').addEventListener('click', close);
    var body = overlay.querySelector('.jobshub-modal-body');
    var foot = overlay.querySelector('.jobshub-modal-foot');
    var bill = null;
    var jobPOs = [];   // POs on this bill's job, for the link picker
    var subs = [];

    function reloadPOsAndSubs(jobId) {
      var pP = window.p86Api.purchaseOrders.listForJob(jobId).then(function (r) { jobPOs = (r && r.purchase_orders) || []; }).catch(function () { jobPOs = []; });
      var pS = (window.p86Api.subs ? window.p86Api.subs.list().then(function (r) { subs = (r && r.subs) || (Array.isArray(r) ? r : []); }).catch(function () { subs = []; }) : Promise.resolve());
      return Promise.all([pP, pS]);
    }

    function render() {
      var d = bill.data || {};
      var subName = function (id) { var s = subs.find(function (x) { return String(x.id) === String(id); }); return s ? (s.name || '') : ''; };
      var poOpts = '<option value="">— No PO (manual bill) —</option>' + jobPOs.map(function (p) {
        var vn = p.sub_name || subName(p.sub_id);
        var label = (p.po_number || 'PO') + (vn ? ' — ' + vn : '') + (p.title ? ' · ' + p.title : '');
        return '<option value="' + esc(p.id) + '" data-sub="' + esc(p.sub_id || '') + '"' + (String(p.id) === String(bill.po_id) ? ' selected' : '') + '>' + esc(label) + '</option>';
      }).join('');
      var subOpts = '<option value="">— Vendor from PO / none —</option>' + subs.map(function (s) {
        return '<option value="' + esc(s.id) + '"' + (String(s.id) === String(bill.sub_id) ? ' selected' : '') + '>' + esc(s.name || s.id) + '</option>';
      }).join('');
      var lienOpts = LIEN_OPTS.map(function (o) { return '<option value="' + o.v + '"' + ((d.lienWaiver || 'none') === o.v ? ' selected' : '') + '>' + o.label + '</option>'; }).join('');
      overlay.querySelector('#jh-bill-head').innerHTML = esc(bill.bill_number || 'Bill') + ' &nbsp; ' + statusBadge(bill.status);
      body.innerHTML =
        '<div class="jobshub-hint-note">' + esc(jobLabelFromRow(bill)) + '</div>' +
        field('Linked Purchase Order', '<select id="jh-be-po" class="jobshub-input">' + poOpts + '</select>') +
        '<div class="jobshub-field-row">' +
          field('Vendor invoice #', '<input id="jh-be-num" type="text" class="jobshub-input" value="' + esc(bill.bill_number || '') + '" placeholder="Vendor\'s invoice number">') +
          field('Amount', '<input id="jh-be-amt" type="number" step="0.01" min="0" class="jobshub-input" value="' + esc(bill.amount != null ? bill.amount : '') + '">') +
        '</div>' +
        '<div class="jobshub-field-row">' +
          field('Bill date', '<input id="jh-be-bdate" type="date" class="jobshub-input" value="' + esc((bill.bill_date || '').slice(0, 10)) + '">') +
          field('Due date', '<input id="jh-be-ddate" type="date" class="jobshub-input" value="' + esc((bill.due_date || '').slice(0, 10)) + '">') +
        '</div>' +
        '<div class="jobshub-field-row">' +
          field('Vendor', '<select id="jh-be-sub" class="jobshub-input">' + subOpts + '</select>') +
          field('Lien waiver', '<select id="jh-be-lien" class="jobshub-input">' + lienOpts + '</select>') +
        '</div>' +
        field('Description / notes', '<textarea id="jh-be-desc" class="jobshub-input" rows="2" placeholder="What this bill covers">' + esc(d.description || '') + '</textarea>') +
        '<div class="jobshub-field"><span class="jobshub-field-label">Invoice document</span><div id="jh-be-atts"><div class="jobshub-loading">Loading attachments…</div></div>' +
          '<div style="margin-top:6px;"><input id="jh-be-file" type="file" accept="application/pdf,image/*" style="font-size:12px;"><button id="jh-be-upload" class="ee-btn" type="button" style="margin-left:6px;">Attach invoice</button></div></div>';
      // Auto-fill vendor when the linked PO changes.
      var poSel = body.querySelector('#jh-be-po');
      if (poSel) poSel.addEventListener('change', function () {
        var opt = poSel.options[poSel.selectedIndex];
        var subId = opt ? opt.getAttribute('data-sub') : '';
        var subSel = body.querySelector('#jh-be-sub');
        if (subId && subSel && !subSel.value) subSel.value = subId;
      });
      loadAttachments();
      renderFoot();
    }

    function loadAttachments() {
      var wrap = body.querySelector('#jh-be-atts');
      if (!wrap) return;
      window.p86Api.attachments.list('bill', bill.id).then(function (r) {
        var atts = (r && r.attachments) || (Array.isArray(r) ? r : []);
        if (!atts.length) { wrap.innerHTML = '<div style="color:var(--text-dim,#888);font-size:12px;">No invoice attached yet.</div>'; return; }
        wrap.innerHTML = atts.map(function (a) {
          var url = a.url || ('/api/attachments/file/' + encodeURIComponent(a.id));
          return '<div style="display:flex;align-items:center;gap:8px;font-size:12px;padding:2px 0;">' +
            '<a href="' + esc(url) + '" target="_blank" rel="noopener" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(a.filename || a.original_name || 'file') + '</a>' +
            '<a href="#" data-del-att="' + esc(a.id) + '" title="Remove" style="color:#f87171;text-decoration:none;">✕</a></div>';
        }).join('');
        wrap.querySelectorAll('[data-del-att]').forEach(function (x) {
          x.addEventListener('click', function (e) {
            e.preventDefault();
            window.p86Api.attachments.remove(x.getAttribute('data-del-att')).then(loadAttachments).catch(function () {});
          });
        });
      }).catch(function () { wrap.innerHTML = '<div style="color:#f87171;font-size:12px;">Could not load attachments.</div>'; });
    }

    function renderFoot() {
      var trans = BILL_TRANSITIONS[bill.status] || [];
      var LABELS = { approved: 'Approve', paid: 'Mark paid', void: 'Void', open: 'Reopen' };
      var stBtns = trans.map(function (s) {
        return '<button class="ee-btn jh-be-status" data-status="' + s + '" type="button"' + (s === 'void' ? ' style="color:#f87171;"' : '') + '>' + (LABELS[s] || s) + '</button>';
      }).join('');
      foot.style.display = '';
      foot.innerHTML =
        '<button class="ee-btn jh-be-del" type="button" style="color:#f87171;">Delete</button>' +
        '<span style="flex:1 1 auto"></span>' + stBtns +
        '<button class="ee-btn jobshub-cancel" type="button">Close</button>' +
        '<button class="ee-btn primary jh-be-save" type="button">Save</button>';
      foot.querySelector('.jobshub-cancel').addEventListener('click', close);
      foot.querySelector('.jh-be-save').addEventListener('click', save);
      foot.querySelector('.jh-be-del').addEventListener('click', del);
      foot.querySelectorAll('.jh-be-status').forEach(function (b) {
        b.addEventListener('click', function () { setStatus(b.getAttribute('data-status')); });
      });
    }

    function collect() {
      var v = function (id) { var el = body.querySelector('#' + id); return el ? String(el.value || '').trim() : ''; };
      return {
        po_id: v('jh-be-po') || null,
        sub_id: v('jh-be-sub') || null,
        bill_number: v('jh-be-num'),
        amount: v('jh-be-amt'),
        bill_date: v('jh-be-bdate') || null,
        due_date: v('jh-be-ddate') || null,
        data: { description: v('jh-be-desc'), lienWaiver: v('jh-be-lien') || 'none' }
      };
    }
    function save() {
      var btn = foot.querySelector('.jh-be-save'); btn.disabled = true; btn.textContent = 'Saving…';
      window.p86Api.bills.update(bill.id, collect())
        .then(function (r) { bill = (r && r.bill) || bill; refreshBillRollup(bill.job_id); close(); if (typeof onSaved === 'function') onSaved(); })
        .catch(function (e) { btn.disabled = false; btn.textContent = 'Save'; alert('Could not save: ' + ((e && e.message) || 'error')); });
    }
    function setStatus(s) {
      window.p86Api.bills.setStatus(bill.id, s)
        .then(function (r) { bill = (r && r.bill) || bill; refreshBillRollup(bill.job_id); render(); if (typeof onSaved === 'function') onSaved(); })
        .catch(function (e) { alert('Could not change status: ' + ((e && e.message) || 'error')); });
    }
    function del() {
      bulkConfirm({ title: 'Delete bill', message: 'Delete this bill? This cannot be undone.', confirmLabel: 'Delete', danger: true }).then(function (ok) {
        if (!ok) return;
        var jid = bill.job_id;
        window.p86Api.bills.remove(bill.id).then(function () { refreshBillRollup(jid); close(); if (typeof onSaved === 'function') onSaved(); })
          .catch(function (e) { alert('Could not delete: ' + ((e && e.message) || 'error')); });
      });
    }

    // Wire the upload button once (delegated so it survives re-render).
    overlay.addEventListener('click', function (e) {
      if (!e.target || e.target.id !== 'jh-be-upload') return;
      var fileEl = body.querySelector('#jh-be-file');
      var file = fileEl && fileEl.files && fileEl.files[0];
      if (!file) { alert('Pick a PDF or image first.'); return; }
      e.target.disabled = true; e.target.textContent = 'Uploading…';
      window.p86Api.attachments.upload('bill', bill.id, file, { geo: false })
        .then(function () { if (fileEl) fileEl.value = ''; loadAttachments(); })
        .catch(function (err) { alert('Upload failed: ' + ((err && err.message) || 'error')); })
        .then(function () { var b = body.querySelector('#jh-be-upload'); if (b) { b.disabled = false; b.textContent = 'Attach invoice'; } });
    });

    window.p86Api.bills.get(billId).then(function (r) {
      bill = r && r.bill;
      if (!bill) { body.innerHTML = '<div class="jobshub-error">Bill not found.</div>'; return; }
      return reloadPOsAndSubs(bill.job_id).then(render);
    }).catch(function (e) {
      body.innerHTML = '<div class="jobshub-error">Could not load bill: ' + esc((e && e.message) || 'error') + '</div>';
    });
  }

  // ── Create modal (required job picker + entity fields) ─────────────
  function jobPickerOptions() {
    var jobs = jobsList().slice();
    var active = jobs.filter(isActiveJob).sort(function (a, b) { return String(b.jobNumber || '').localeCompare(String(a.jobNumber || '')); });
    var closed = jobs.filter(function (j) { return !isActiveJob(j); }).sort(function (a, b) { return String(b.jobNumber || '').localeCompare(String(a.jobNumber || '')); });
    var html = '<option value="">— Select a job (required) —</option>';
    if (active.length) {
      html += '<optgroup label="Active jobs">' + active.map(function (j) { return '<option value="' + esc(j.id) + '">' + esc(jobLabel(j)) + '</option>'; }).join('') + '</optgroup>';
    }
    if (closed.length) {
      html += '<optgroup label="Closed / archived">' + closed.map(function (j) { return '<option value="' + esc(j.id) + '">' + esc(jobLabel(j)) + '</option>'; }).join('') + '</optgroup>';
    }
    return html;
  }

  var KIND_META = {
    co:        { title: 'New Change Order',   requiredLabel: 'Title' },
    rfi:       { title: 'New RFI',            requiredLabel: 'Subject' },
    submittal: { title: 'New Submittal',      requiredLabel: 'Subject' },
    po:        { title: 'New Purchase Order', requiredLabel: 'Title' },
    bill:      { title: 'New Bill',           requiredLabel: 'Amount' }
  };

  function fieldsHTML(kind) {
    if (kind === 'po') {
      return field('Title', '<input id="jh-cr-title" type="text" class="jobshub-input" placeholder="e.g. Framing and Decking">', true) +
        field('Subcontractor (optional)', '<select id="jh-cr-sub" class="jobshub-input"><option value="">— Select sub —</option></select>') +
        '<div class="jobshub-field-row">' +
          field('Scheduled completion (optional)', '<input id="jh-cr-sched" type="date" class="jobshub-input">') +
          field('', '<label class="jobshub-inline-check"><input id="jh-cr-materials" type="checkbox"> Materials only</label>') +
        '</div>' +
        '<div class="jobshub-hint-note">The scope-of-work contract is seeded from your org template — add line items &amp; details in the editor that opens.</div>';
    }
    if (kind === 'bill') {
      return field('Purchase Order (link the bill to a PO)', '<select id="jh-cr-po" class="jobshub-input"><option value="">— Pick a job first —</option></select>') +
        '<div class="jobshub-field-row">' +
          field('Amount', '<input id="jh-cr-amount" type="number" step="0.01" min="0" class="jobshub-input" placeholder="0.00">', true) +
          field('Vendor invoice # (optional)', '<input id="jh-cr-billnum" type="text" class="jobshub-input" placeholder="Vendor\'s invoice number">') +
        '</div>' +
        field('Vendor (optional — inherited from PO)', '<select id="jh-cr-sub" class="jobshub-input"><option value="">— Select sub —</option></select>') +
        '<div class="jobshub-field-row">' +
          field('Bill date (optional)', '<input id="jh-cr-bdate" type="date" class="jobshub-input">') +
          field('Due date (optional)', '<input id="jh-cr-ddate" type="date" class="jobshub-input">') +
        '</div>' +
        field('Description (optional)', '<textarea id="jh-cr-desc" class="jobshub-input" rows="2" placeholder="What this bill covers"></textarea>') +
        '<div class="jobshub-hint-note">Attach the invoice PDF after creating — the editor opens automatically.</div>';
    }
    if (kind === 'co') {
      return field('Title', '<input id="jh-cr-title" type="text" class="jobshub-input" placeholder="e.g. Framing and Decking">', true) +
        field('Scope (optional)', '<textarea id="jh-cr-scope" class="jobshub-input" rows="3" placeholder="Short description — add line items after creating"></textarea>');
    }
    if (kind === 'rfi') {
      return field('Subject', '<input id="jh-cr-subject" type="text" class="jobshub-input" placeholder="What are you asking?">', true) +
        field('Question (optional)', '<textarea id="jh-cr-body" class="jobshub-input" rows="3"></textarea>') +
        field('Due date (optional)', '<input id="jh-cr-due" type="date" class="jobshub-input">');
    }
    // submittal
    return field('Subject', '<input id="jh-cr-subject" type="text" class="jobshub-input" placeholder="What is being submitted?">', true) +
      field('Submitted to', '<input id="jh-cr-submitted-to" type="text" class="jobshub-input" placeholder="e.g. Architect / Engineer of Record / GC">') +
      field('Notes (optional)', '<textarea id="jh-cr-body" class="jobshub-input" rows="2"></textarea>') +
      '<div class="jobshub-field-row">' +
        field('Category (optional)', '<input id="jh-cr-category" type="text" class="jobshub-input" placeholder="e.g. Mechanical">') +
        field('Spec section (optional)', '<input id="jh-cr-spec" type="text" class="jobshub-input" placeholder="e.g. 07 54 23">') +
      '</div>' +
      field('Due date (optional)', '<input id="jh-cr-due" type="date" class="jobshub-input">');
  }
  function field(label, control, required) {
    return '<label class="jobshub-field"><span class="jobshub-field-label">' + esc(label) + (required ? ' <span style="color:#f87171;">*</span>' : '') + '</span>' + control + '</label>';
  }

  function openCreateModal(kind, onSaved) {
    var meta = KIND_META[kind] || KIND_META.co;
    var jobs = jobsList();
    var overlay = document.createElement('div');
    overlay.className = 'jobshub-modal-overlay';
    overlay.innerHTML =
      '<div class="jobshub-modal" role="dialog" aria-modal="true">' +
        '<div class="jobshub-modal-head"><span>' + esc(meta.title) + '</span>' +
          '<button class="jobshub-modal-x" type="button" aria-label="Close">✕</button></div>' +
        '<div class="jobshub-modal-body">' +
          (jobs.length
            ? field('Job', '<select id="jh-cr-job" class="jobshub-input">' + jobPickerOptions() + '</select>', true) + fieldsHTML(kind)
            : '<div class="jobshub-error">No jobs loaded yet — open the Jobs list once, then try again.</div>') +
        '</div>' +
        '<div class="jobshub-modal-foot">' +
          '<button class="ee-btn jobshub-cancel" type="button">Cancel</button>' +
          (jobs.length ? '<button class="ee-btn primary jobshub-save" type="button">Create</button>' : '') +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    function close() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    overlay.querySelector('.jobshub-modal-x').addEventListener('click', close);
    overlay.querySelector('.jobshub-cancel').addEventListener('click', close);
    var saveBtn = overlay.querySelector('.jobshub-save');
    if (saveBtn) saveBtn.addEventListener('click', function () { submitCreate(kind, close, onSaved, saveBtn); });
    // PO create needs the subcontractor list — populate the picker async.
    if (kind === 'po' && window.p86Api && window.p86Api.subs) {
      window.p86Api.subs.list().then(function (r) {
        var subs = (r && r.subs) || (Array.isArray(r) ? r : []);
        var sel = overlay.querySelector('#jh-cr-sub');
        if (sel) {
          sel.innerHTML = '<option value="">— Select sub —</option>' + subs.map(function (s) {
            return '<option value="' + esc(s.id) + '">' + esc(s.name || s.id) + '</option>';
          }).join('');
        }
      }).catch(function () {});
    }
    // Bill create: populate the vendor picker, and repopulate the PO picker
    // whenever the job changes (a bill links a PO on its own job). Picking a
    // PO auto-fills the vendor from that PO.
    if (kind === 'bill' && window.p86Api) {
      if (window.p86Api.subs) {
        window.p86Api.subs.list().then(function (r) {
          var subs = (r && r.subs) || (Array.isArray(r) ? r : []);
          var sel = overlay.querySelector('#jh-cr-sub');
          if (sel) sel.innerHTML = '<option value="">— Select sub —</option>' + subs.map(function (s) {
            return '<option value="' + esc(s.id) + '">' + esc(s.name || s.id) + '</option>';
          }).join('');
        }).catch(function () {});
      }
      var jobSel = overlay.querySelector('#jh-cr-job');
      var poSel = overlay.querySelector('#jh-cr-po');
      function loadPOsForJob(jobId) {
        if (!poSel) return;
        if (!jobId) { poSel.innerHTML = '<option value="">— Pick a job first —</option>'; return; }
        poSel.innerHTML = '<option value="">Loading POs…</option>';
        window.p86Api.purchaseOrders.listForJob(jobId).then(function (r) {
          var pos = (r && r.purchase_orders) || [];
          poSel.innerHTML = '<option value="">— No PO (manual bill) —</option>' + pos.map(function (p) {
            var label = (p.po_number || 'PO') + (p.sub_name ? ' — ' + p.sub_name : '') + (p.title ? ' · ' + p.title : '');
            return '<option value="' + esc(p.id) + '" data-sub="' + esc(p.sub_id || '') + '">' + esc(label) + '</option>';
          }).join('');
        }).catch(function () { poSel.innerHTML = '<option value="">— No PO (manual bill) —</option>'; });
      }
      if (jobSel) jobSel.addEventListener('change', function () { loadPOsForJob(jobSel.value); });
      if (poSel) poSel.addEventListener('change', function () {
        var opt = poSel.options[poSel.selectedIndex];
        var subId = opt ? opt.getAttribute('data-sub') : '';
        var subSel = overlay.querySelector('#jh-cr-sub');
        if (subId && subSel && !subSel.value) subSel.value = subId;
      });
    }
    var firstInput = overlay.querySelector('#jh-cr-job');
    if (firstInput) firstInput.focus();
  }

  function val(id) { var el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; }

  function submitCreate(kind, close, onSaved, saveBtn) {
    var jobId = val('jh-cr-job');
    if (!jobId) { alert('Please pick a job first.'); return; }

    if (kind === 'bill') {
      var amt = val('jh-cr-amount');
      if (!amt || Number(amt) <= 0) { alert('Please enter the bill amount.'); return; }
      saveBtn.disabled = true; saveBtn.textContent = 'Creating…';
      var billPayload = {
        po_id: val('jh-cr-po') || null,
        sub_id: val('jh-cr-sub') || null,
        amount: amt,
        bill_number: val('jh-cr-billnum') || null,
        bill_date: val('jh-cr-bdate') || null,
        due_date: val('jh-cr-ddate') || null,
        data: { description: val('jh-cr-desc') }
      };
      window.p86Api.bills.create(jobId, billPayload)
        .then(function (res) {
          close();
          refreshBillRollup(jobId);
          if (typeof onSaved === 'function') onSaved();
          var id = res && res.bill && res.bill.id;
          if (id) openBillEditor(id, function () { if (typeof onSaved === 'function') onSaved(); });
        })
        .catch(function (err) { saveBtn.disabled = false; saveBtn.textContent = 'Create'; alert('Could not create the bill: ' + ((err && err.message) || 'error')); });
      return;
    }

    var titleKind = (kind === 'co' || kind === 'po');
    var required = titleKind ? val('jh-cr-title') : val('jh-cr-subject');
    if (!required) { alert('Please enter a ' + (titleKind ? 'title' : 'subject') + '.'); return; }
    saveBtn.disabled = true;
    saveBtn.textContent = 'Creating…';
    var done = function () { saveBtn.disabled = false; saveBtn.textContent = 'Create'; };

    if (kind === 'po') {
      var poPayload = { title: required, sub_id: val('jh-cr-sub') || null };
      var sched = val('jh-cr-sched'); if (sched) poPayload.scheduledCompletion = sched;
      var matEl = document.getElementById('jh-cr-materials'); if (matEl && matEl.checked) poPayload.materialsOnly = true;
      window.p86Api.purchaseOrders.create(jobId, poPayload)
        .then(function (res) {
          close();
          var id = res && res.purchase_order && res.purchase_order.id;
          if (id && window.p86PurchaseOrders && typeof window.p86PurchaseOrders.open === 'function') {
            window.p86PurchaseOrders.open(id);
          }
          if (typeof onSaved === 'function') onSaved();
        })
        .catch(function (err) { done(); alert('Could not create the purchase order: ' + ((err && err.message) || 'error')); });
      return;
    }

    if (kind === 'co') {
      window.p86Api.changeOrders.create(jobId, { title: required, scope: val('jh-cr-scope'), lines: [] })
        .then(function (res) {
          close();
          var id = res && res.change_order && res.change_order.id;
          // Open the parent job + the new CO so line items can be added.
          openParentJob(jobId, 'job-changeorders');
          if (id && window.p86ChangeOrders && typeof window.p86ChangeOrders.open === 'function') {
            setTimeout(function () { try { window.p86ChangeOrders.open(id); } catch (e) {} }, 120);
          }
          if (typeof onSaved === 'function') onSaved();
        })
        .catch(function (err) { done(); alert('Could not create the change order: ' + ((err && err.message) || 'error')); });
      return;
    }

    // rfi / submittal
    var payload = { type: kind, subject: required, body: val('jh-cr-body') || null };
    var due = val('jh-cr-due'); if (due) payload.due_date = due;
    if (kind === 'submittal') {
      var meta = {};
      var sto = val('jh-cr-submitted-to'); if (sto) meta.submitted_to = sto;
      var cat = val('jh-cr-category'); if (cat) meta.category = cat;
      var spec = val('jh-cr-spec'); if (spec) meta.spec_section = spec;
      if (Object.keys(meta).length) payload.metadata = meta;
    }
    window.p86Api.workflowItems.create(jobId, payload)
      .then(function () { close(); if (typeof onSaved === 'function') onSaved(); })
      .catch(function (err) { done(); alert('Could not create: ' + ((err && err.message) || 'error')); });
  }

  // ── PO scope template editor (per-org default seeded into new POs) ──
  function openScopeTemplateModal() {
    var overlay = document.createElement('div');
    overlay.className = 'jobshub-modal-overlay';
    overlay.innerHTML =
      '<div class="jobshub-modal jobshub-modal-wide" role="dialog" aria-modal="true">' +
        '<div class="jobshub-modal-head"><span>Purchase Order — Scope &amp; Terms Template</span>' +
          '<button class="jobshub-modal-x" type="button" aria-label="Close">✕</button></div>' +
        '<div class="jobshub-modal-body">' +
          '<div class="jobshub-hint-note">This text seeds the Scope of Work &amp; Terms on every NEW purchase order. Paste your exact subcontract language here. Existing POs keep their own saved copy.</div>' +
          '<textarea id="jh-tpl-text" class="jobshub-input" rows="18" style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;line-height:1.5;">Loading…</textarea>' +
          '<div class="jobshub-tpl-status" id="jh-tpl-status"></div>' +
        '</div>' +
        '<div class="jobshub-modal-foot">' +
          '<button class="ee-btn jobshub-tpl-reset" type="button">Reset to default</button>' +
          '<span style="flex:1 1 auto"></span>' +
          '<button class="ee-btn jobshub-cancel" type="button">Cancel</button>' +
          '<button class="ee-btn primary jobshub-tpl-save" type="button">Save template</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    function close() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    overlay.querySelector('.jobshub-modal-x').addEventListener('click', close);
    overlay.querySelector('.jobshub-cancel').addEventListener('click', close);
    var ta = overlay.querySelector('#jh-tpl-text');
    var statusEl = overlay.querySelector('#jh-tpl-status');
    window.p86Api.purchaseOrders.getScopeTemplate()
      .then(function (r) { ta.value = (r && r.template) || ''; statusEl.textContent = (r && r.is_default) ? 'Currently using the built-in default.' : 'Custom template in use.'; })
      .catch(function () { ta.value = ''; });
    overlay.querySelector('.jobshub-tpl-save').addEventListener('click', function () {
      var btn = this; btn.disabled = true; btn.textContent = 'Saving…';
      window.p86Api.purchaseOrders.setScopeTemplate(ta.value || '')
        .then(function () { close(); })
        .catch(function (e) { btn.disabled = false; btn.textContent = 'Save template'; alert('Could not save: ' + ((e && e.message) || 'error — admin rights required')); });
    });
    overlay.querySelector('.jobshub-tpl-reset').addEventListener('click', function () {
      if (!window.confirm('Reset to the built-in default template? Your custom text will be cleared.')) return;
      window.p86Api.purchaseOrders.setScopeTemplate('')
        .then(function () { return window.p86Api.purchaseOrders.getScopeTemplate(); })
        .then(function (r) { ta.value = (r && r.template) || ''; statusEl.textContent = 'Reset to the built-in default.'; })
        .catch(function (e) { alert('Could not reset: ' + ((e && e.message) || 'error')); });
    });
  }

  window.p86JobsHub = { renderJobsHubInto: renderJobsHubInto, switchJobsHubSubTab: switchJobsHubSubTab };
  window.switchJobsHubSubTab = switchJobsHubSubTab;
  // Bill editor exposed for reuse (PO editor "Bills" section in S3,
  // doc-import OCR-to-bill in S4). open(id, onSaved) — onSaved fires after
  // any save / status change / delete.
  window.p86Bills = { open: openBillEditor };
})();
