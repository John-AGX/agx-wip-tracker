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

  var VIEWS = ['purchase-orders', 'change-orders', 'rfis', 'submittals'];
  var DEFAULT_VIEW = 'change-orders';
  var _view = null;
  // Per-view filter state persists for the session so flipping between
  // sub-tabs keeps your filters.
  var _state = {
    'purchase-orders': { status: 'open', job: '', q: '' },
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

  // ── Status badges ──────────────────────────────────────────────────
  var STATUS_COLOR = {
    draft: '#94a3b8', approved: '#34d399', applied: '#2dd4bf',
    open: '#4f8cff', answered: '#34d399', closed: '#8b90a5',
    submitted: '#4f8cff', revise_resubmit: '#fbbf24', rejected: '#f87171',
    pending: '#fbbf24', sent: '#60a5fa', received: '#34d399',
    issued: '#4f8cff', work_complete: '#2dd4bf'
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
    return '<span class="badge" style="background:' + c + '22;color:' + c + ';border:1px solid ' + c + '44;">' + esc(label) + '</span>';
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
    if (view === 'change-orders')   return renderCO(host);
    if (view === 'rfis')            return renderWorkflow(host, 'rfi', 'RFIs');
    if (view === 'submittals')      return renderWorkflow(host, 'submittal', 'Submittals');
  }

  // Lets the PO editor refresh the hub list after a status change.
  var _currentRefetch = null;
  window.p86JobsHubRefresh = function () { if (typeof _currentRefetch === 'function') _currentRefetch(); };

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
          (cfg.extraActionHTML || '') +
          '<button id="jh-new" class="ee-btn primary jobshub-new" type="button">+ New</button>' +
        '</div>' +
      '</div>' +
      '<div class="jobshub-summary" id="jh-summary"></div>' +
      '<div class="jobshub-list" id="jh-list"><div class="jobshub-loading">Loading…</div></div>';

    var _rows = [];
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
        listEl.innerHTML = '<div class="jobshub-empty">No ' + esc(cfg.title.toLowerCase()) + ' match.</div>';
        return;
      }
      listEl.innerHTML = cfg.tableHTML(rows);
      wireRows(listEl, cfg);
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
      title: 'Change Orders',
      subtab: 'job-changeorders',
      createKind: 'co',
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
          '<th>CO #</th><th>Job</th><th>Title</th><th>Status</th><th>Updated</th>' +
          '</tr></thead><tbody>' +
          rows.map(function (r) {
            return '<tr data-job-id="' + esc(r.job_id) + '" data-co-id="' + esc(r.id) + '">' +
              '<td><strong>' + esc(r.co_number || '') + '</strong></td>' +
              '<td>' + esc(jobLabelFromRow(r)) + '</td>' +
              '<td>' + esc(r.title || '(untitled)') + '</td>' +
              '<td>' + statusBadge(r.status) + '</td>' +
              '<td>' + esc(fmtDate(r.updated_at)) + '</td>' +
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
      title: title,
      subtab: 'job-workflow',
      createKind: type,
      statusOptions: statusOpts,
      fetch: function (st) {
        return window.p86Api.workflowItems.listAll({ type: type, status: st.status, job: st.job })
          .then(function (r) { return (r && r.items) || []; });
      },
      matches: function (r, q) {
        return [r.number, r.subject, r.job_title, r.job_number].filter(Boolean).join(' ').toLowerCase().indexOf(q) !== -1;
      },
      tableHTML: function (rows) {
        return '<div class="p86-tbl-scroll"><table class="leads-table jobshub-table"><thead><tr>' +
          '<th>#</th><th>Job</th><th>Subject</th><th>Status</th><th>Due</th><th>Updated</th>' +
          '</tr></thead><tbody>' +
          rows.map(function (r) {
            var overdue = r.due_date && !r.closed_at && new Date(r.due_date).getTime() < Date.now();
            return '<tr data-job-id="' + esc(r.job_id) + '">' +
              '<td><strong>' + esc(r.number || '') + '</strong></td>' +
              '<td>' + esc(jobLabelFromRow(r)) + '</td>' +
              '<td>' + esc(r.subject || '') + '</td>' +
              '<td>' + statusBadge(r.status) + '</td>' +
              '<td' + (overdue ? ' style="color:#f87171;font-weight:600;"' : '') + '>' + esc(fmtDate(r.due_date)) + '</td>' +
              '<td>' + esc(fmtDate(r.updated_at)) + '</td>' +
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
      title: 'Purchase Orders',
      createKind: 'po',
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
          '<th>PO #</th><th>Job</th><th>Sub</th><th>Title</th><th class="num">Total</th><th>Status</th>' +
          '</tr></thead><tbody>' +
          rows.map(function (r) {
            return '<tr data-po-id="' + esc(r.id) + '">' +
              '<td><strong>' + esc(r.po_number || '') + '</strong></td>' +
              '<td>' + esc(jobLabelFromRow(r)) + '</td>' +
              '<td>' + esc(r.sub_name || '—') + '</td>' +
              '<td>' + esc(r.title || '(untitled)') + '</td>' +
              '<td class="num">' + money(poSum(r)) + '</td>' +
              '<td>' + statusBadge(r.status) + '</td>' +
            '</tr>';
          }).join('') + '</tbody></table></div>';
      }
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
    po:        { title: 'New Purchase Order', requiredLabel: 'Title' }
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
    var firstInput = overlay.querySelector('#jh-cr-job');
    if (firstInput) firstInput.focus();
  }

  function val(id) { var el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; }

  function submitCreate(kind, close, onSaved, saveBtn) {
    var jobId = val('jh-cr-job');
    if (!jobId) { alert('Please pick a job first.'); return; }
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
})();
