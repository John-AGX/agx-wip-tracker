// ============================================================
// Project 86 — Job sidebar: Service Tickets tab
// ------------------------------------------------------------
// A service ticket is the WORK ORDER tier above tasks: dispatchable work with
// an owner, an address, a proposed scope and a lifecycle, raised on a job or a
// lead. This file is the PM's manager for the ones on a job — list, create,
// open, edit, move through the lattice, archive.
//
// The renderer is looked up as window[fn](jobId) by all three job sub-tab
// dispatch maps: TAB_RENDERERS + activateTabFromOutside
// (js/workspace-layout.js) and _LATE_JOB_SUBTAB_RENDERERS (js/app.js). The
// pane is a static <div class="sub-tab-content-job"> in index.html;
// populateRightPanels() relocates it and the router shows/hides it.
//
// Loaded AFTER api.js and jobs.js so p86Api and appData are available.
//
// NOT here yet, by slice: child tasks (S2), sharing (S4), guest responses (S5),
// revisions (S6), the "Draft with 86" button (S7). The server answers those
// keys as empty arrays already, so this file is written against the final
// shape rather than a temporary one.
// ============================================================
(function () {
  'use strict';

  // One open ticket at a time, keyed by job. Module-level so a repaint that
  // arrives while a ticket is expanded can restore it.
  var _state = { jobId: null, filter: 'all', openId: null, tickets: [], busy: false };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function escAttr(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  }

  function api() {
    return (window.p86Api && window.p86Api.serviceTickets) || null;
  }

  // Editable unless the job carries an explicit _canEdit:false gate — mirrors
  // js/job-media.js. Fail OPEN (the server still enforces write capability);
  // this only tames the client affordances.
  function canEditJob(jobId) {
    try {
      var jobs = (window.appData && window.appData.jobs) || [];
      var job = jobs.find(function (j) { return j && j.id === jobId; });
      if (job && job._canEdit === false) return false;
    } catch (e) { /* fail open */ }
    return true;
  }

  var STATUSES = ['draft', 'open', 'scheduled', 'in_progress', 'work_complete', 'approved', 'closed', 'cancelled'];
  var STATUS_LABEL = {
    draft: 'Draft', open: 'Open', scheduled: 'Scheduled', in_progress: 'In progress',
    work_complete: 'Work complete', approved: 'Approved', closed: 'Closed', cancelled: 'Cancelled'
  };
  // The filter pills. 'active' is the useful default view for a PM — everything
  // that still needs someone to do something.
  var FILTERS = [
    { id: 'all', label: 'All' },
    { id: 'active', label: 'Active' },
    { id: 'draft', label: 'Draft' },
    { id: 'scheduled', label: 'Scheduled' },
    { id: 'in_progress', label: 'In progress' },
    { id: 'work_complete', label: 'Awaiting approval' },
    { id: 'closed', label: 'Closed' }
  ];
  var PRIORITY_LABEL = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };

  function matchesFilter(t) {
    var f = _state.filter;
    if (f === 'all') return true;
    if (f === 'active') return ['open', 'scheduled', 'in_progress', 'work_complete'].indexOf(t.status) >= 0;
    if (f === 'closed') return t.status === 'closed' || t.status === 'cancelled';
    return t.status === f;
  }

  function fmtDate(v) {
    if (!v) return '';
    var d = new Date(v);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function pane() { return document.getElementById('job-service-tickets'); }

  function toast(msg, kind) {
    if (window.p86Toast) { try { window.p86Toast(msg, kind); return; } catch (e) { /* fall through */ } }
    if (kind === 'error') console.error('[service-tickets] ' + msg);
  }

  // ── Paint ────────────────────────────────────────────────────────────
  function paint() {
    var host = pane();
    if (!host) return;
    var canEdit = canEditJob(_state.jobId);
    var shown = _state.tickets.filter(matchesFilter);

    var pills = FILTERS.map(function (f) {
      var n = _state.tickets.filter(function (t) {
        var save = _state.filter; _state.filter = f.id;
        var m = matchesFilter(t); _state.filter = save; return m;
      }).length;
      return '<button class="p86-st-pill' + (_state.filter === f.id ? ' active' : '') +
        '" data-filter="' + escAttr(f.id) + '">' + esc(f.label) +
        (n ? ' <span class="p86-st-pill-n">' + n + '</span>' : '') + '</button>';
    }).join('');

    host.innerHTML =
      '<div class="p86-st-wrap">' +
        '<div class="p86-st-bar">' +
          '<div class="p86-st-pills">' + pills + '</div>' +
          (canEdit ? '<button class="ee-btn primary p86-st-new">+ New ticket</button>' : '') +
        '</div>' +
        (shown.length
          ? '<div class="p86-st-list">' + shown.map(rowHTML).join('') + '</div>'
          : '<div class="p86-st-empty">' +
              (_state.tickets.length
                ? 'No tickets match this filter.'
                : 'No service tickets on this job yet.' +
                  (canEdit ? ' Raise one when a warranty call, punch return or extra comes in.' : '')) +
            '</div>') +
      '</div>';

    wire(host);
    if (_state.openId) {
      var openRow = host.querySelector('[data-ticket="' + escAttr(_state.openId) + '"]');
      if (openRow) expand(openRow, _state.openId);
    }
  }

  function rowHTML(t) {
    var total = Number(t.task_total || 0);
    var done = Number(t.task_done || 0);
    return '<div class="p86-st-row" data-ticket="' + escAttr(t.id) + '">' +
      '<div class="p86-st-row-head">' +
        '<span class="p86-st-prio prio-' + esc(t.priority || 'normal') + '" ' +
          'title="' + escAttr(PRIORITY_LABEL[t.priority] || 'Normal') + ' priority"></span>' +
        (t.ticket_number ? '<span class="p86-st-num">' + esc(t.ticket_number) + '</span>' : '') +
        '<span class="p86-st-title">' + esc(t.title || 'Untitled ticket') + '</span>' +
        '<span class="p86-st-status st-' + esc(t.status) + '">' + esc(STATUS_LABEL[t.status] || t.status) + '</span>' +
        (total ? '<span class="p86-st-tasks">' + done + '/' + total + '</span>' : '') +
        (t.scheduled_for ? '<span class="p86-st-when">' + esc(fmtDate(t.scheduled_for)) + '</span>' : '') +
      '</div>' +
      '<div class="p86-st-detail" hidden></div>' +
    '</div>';
  }

  function wire(host) {
    host.querySelectorAll('.p86-st-pill').forEach(function (b) {
      b.addEventListener('click', function () {
        _state.filter = b.getAttribute('data-filter');
        paint();
      });
    });
    var nb = host.querySelector('.p86-st-new');
    if (nb) nb.addEventListener('click', openCreate);

    host.querySelectorAll('.p86-st-row-head').forEach(function (h) {
      h.addEventListener('click', function () {
        var row = h.closest('.p86-st-row');
        var id = row && row.getAttribute('data-ticket');
        if (!id) return;
        if (_state.openId === id) { collapse(row); _state.openId = null; return; }
        // Only one expanded at a time — a work order is read one at a time.
        host.querySelectorAll('.p86-st-row').forEach(collapse);
        _state.openId = id;
        expand(row, id);
      });
    });
  }

  function collapse(row) {
    row.classList.remove('is-open');
    var d = row.querySelector('.p86-st-detail');
    if (d) { d.hidden = true; d.innerHTML = ''; }
  }

  // ── Expanded detail ──────────────────────────────────────────────────
  function expand(row, id) {
    row.classList.add('is-open');
    var d = row.querySelector('.p86-st-detail');
    if (!d) return;
    d.hidden = false;
    d.innerHTML = '<div class="p86-st-loading">Loading…</div>';
    if (!api()) { d.innerHTML = '<div class="p86-st-loading">Service tickets are unavailable.</div>'; return; }

    api().get(id).then(function (r) {
      // The user may have collapsed or switched rows while this was in flight.
      if (_state.openId !== id) return;
      paintDetail(d, r);
    }).catch(function (e) {
      if (_state.openId !== id) return;
      d.innerHTML = '<div class="p86-st-loading" style="color:#f87171;">' +
        esc(e && e.message ? e.message : 'Failed to load') + '</div>';
    });
  }

  function paintDetail(d, r) {
    var t = r.ticket || {};
    var canEdit = canEditJob(_state.jobId) && t.status !== 'closed' && t.status !== 'cancelled';
    var events = r.events || [];

    // The stepper shows position on the lattice at a glance. cancelled is not
    // a step on the line — it is a branch off it — so it renders as a note
    // rather than a position.
    var LINE = ['draft', 'open', 'scheduled', 'in_progress', 'work_complete', 'approved', 'closed'];
    var at = LINE.indexOf(t.status);
    var stepper = t.status === 'cancelled'
      ? '<div class="p86-st-cancelled">This ticket was cancelled.</div>'
      : '<div class="p86-st-stepper">' + LINE.map(function (s, i) {
          return '<span class="p86-st-step' + (i <= at ? ' done' : '') + (i === at ? ' at' : '') + '">' +
            esc(STATUS_LABEL[s]) + '</span>';
        }).join('') + '</div>';

    d.innerHTML =
      stepper +
      '<div class="p86-st-detail-grid">' +
        '<div class="p86-st-detail-main">' +
          '<label class="p86-st-lbl">Proposed scope</label>' +
          (canEdit
            ? '<textarea class="p86-st-scope" rows="5" placeholder="What needs doing, and where.">' +
                esc(t.scope_proposed || '') + '</textarea>'
            : '<div class="p86-st-ro">' + (t.scope_proposed ? esc(t.scope_proposed) : '<em>No scope written.</em>') + '</div>') +
          (t.scope_approved
            ? '<label class="p86-st-lbl">Approved scope</label><div class="p86-st-ro">' + esc(t.scope_approved) + '</div>'
            : '') +
          (t.guest_log
            ? '<label class="p86-st-lbl">Field log</label><div class="p86-st-ro p86-st-guestlog">' + esc(t.guest_log) + '</div>'
            : '') +
        '</div>' +
        '<div class="p86-st-detail-side">' +
          metaRow('Status', statusControl(t, canEdit)) +
          metaRow('Priority', canEdit
            ? select('p86-st-prio-sel', ['low', 'normal', 'high', 'urgent'], t.priority || 'normal', PRIORITY_LABEL)
            : esc(PRIORITY_LABEL[t.priority] || 'Normal')) +
          metaRow('Scheduled', canEdit
            ? '<input type="date" class="p86-st-sched" value="' + escAttr((t.scheduled_for || '').slice(0, 10)) + '" />'
            : esc(fmtDate(t.scheduled_for) || '—')) +
          metaRow('Due', canEdit
            ? '<input type="date" class="p86-st-due" value="' + escAttr((t.due_date || '').slice(0, 10)) + '" />'
            : esc(fmtDate(t.due_date) || '—')) +
          metaRow('Site contact', canEdit
            ? '<input type="text" class="p86-st-contact" value="' + escAttr(t.site_contact_name || '') + '" placeholder="Name" />'
            : esc(t.site_contact_name || '—')) +
          (t.street_address ? metaRow('Address', esc([t.street_address, t.city, t.state].filter(Boolean).join(', '))) : '') +
        '</div>' +
      '</div>' +
      (canEdit ? '<div class="p86-st-actions">' +
        '<button class="ee-btn primary p86-st-save">Save</button>' +
        '<button class="ee-btn secondary p86-st-archive">Archive</button>' +
      '</div>' : '') +
      (events.length ? '<div class="p86-st-timeline">' +
        '<label class="p86-st-lbl">Progress</label>' +
        events.map(eventHTML).join('') +
      '</div>' : '');

    wireDetail(d, t);
  }

  function metaRow(label, html) {
    return '<div class="p86-st-meta"><span class="p86-st-meta-k">' + esc(label) + '</span>' +
      '<span class="p86-st-meta-v">' + html + '</span></div>';
  }

  function select(cls, opts, cur, labels) {
    return '<select class="' + cls + '">' + opts.map(function (o) {
      return '<option value="' + escAttr(o) + '"' + (o === cur ? ' selected' : '') + '>' +
        esc((labels && labels[o]) || o) + '</option>';
    }).join('') + '</select>';
  }

  // Only transitions the server will actually accept are offered. The lattice
  // lives in server/services/service-tickets.js; this mirrors the office arm
  // of it so the UI does not present a move that comes back 403.
  var USER_NEXT = {
    draft: ['open', 'cancelled'],
    open: ['draft', 'scheduled', 'in_progress', 'cancelled'],
    scheduled: ['open', 'in_progress', 'cancelled'],
    in_progress: ['scheduled', 'work_complete', 'cancelled'],
    work_complete: ['in_progress', 'approved', 'cancelled'],
    approved: ['work_complete', 'closed', 'cancelled'],
    closed: ['open'],
    cancelled: ['open']
  };

  function statusControl(t, canEdit) {
    if (!canEdit) return '<span class="p86-st-status st-' + esc(t.status) + '">' + esc(STATUS_LABEL[t.status]) + '</span>';
    var next = USER_NEXT[t.status] || [];
    return '<span class="p86-st-status st-' + esc(t.status) + '">' + esc(STATUS_LABEL[t.status]) + '</span>' +
      (next.length
        ? ' ' + select('p86-st-move', [''].concat(next), '',
            Object.assign({ '': 'Move to…' }, STATUS_LABEL))
        : '');
  }

  function eventHTML(e) {
    var who = e.actor_kind === 'share'
      ? (e.actor_label ? esc(e.actor_label) + ' · via shared link' : 'via shared link')
      : (e.actor_kind === 'agent' ? '86' : 'Office');
    var what = e.kind === 'status_changed' && e.detail
      ? 'moved it to ' + esc(STATUS_LABEL[e.detail.to] || e.detail.to)
      : e.kind === 'field_changed' && e.detail && e.detail.fields
        ? 'edited ' + esc((e.detail.fields || []).join(', '))
        : esc(String(e.kind || '').replace(/_/g, ' '));
    return '<div class="p86-st-event' + (e.actor_kind === 'share' ? ' is-guest' : '') + '">' +
      '<span class="p86-st-event-who">' + who + '</span> ' +
      '<span class="p86-st-event-what">' + what + '</span> ' +
      '<span class="p86-st-event-when">' + esc(fmtDate(e.created_at)) + '</span>' +
    '</div>';
  }

  function wireDetail(d, t) {
    var mv = d.querySelector('.p86-st-move');
    if (mv) mv.addEventListener('change', function () {
      var to = mv.value;
      if (!to) return;
      mv.disabled = true;
      api().setStatus(t.id, to).then(function () {
        return reload();
      }).catch(function (e) {
        mv.disabled = false;
        mv.value = '';
        toast(e && e.message ? e.message : 'Could not change the status', 'error');
      });
    });

    var save = d.querySelector('.p86-st-save');
    if (save) save.addEventListener('click', function () {
      if (_state.busy) return;
      _state.busy = true;
      save.disabled = true;
      var payload = {};
      var sc = d.querySelector('.p86-st-scope');
      if (sc) payload.scope_proposed = sc.value;
      var pr = d.querySelector('.p86-st-prio-sel');
      if (pr) payload.priority = pr.value;
      var sd = d.querySelector('.p86-st-sched');
      if (sd) payload.scheduled_for = sd.value || null;
      var du = d.querySelector('.p86-st-due');
      if (du) payload.due_date = du.value || null;
      var ct = d.querySelector('.p86-st-contact');
      if (ct) payload.site_contact_name = ct.value;
      api().update(t.id, payload).then(function () {
        toast('Ticket saved');
        return reload();
      }).catch(function (e) {
        toast(e && e.message ? e.message : 'Could not save', 'error');
      }).then(function () {
        _state.busy = false;
        if (save) save.disabled = false;
      });
    });

    var arch = d.querySelector('.p86-st-archive');
    if (arch) arch.addEventListener('click', function () {
      // p86Confirm, never native confirm() — it no-ops inside the installed PWA.
      var ask = window.p86Confirm
        ? window.p86Confirm({
            title: 'Archive this ticket?',
            message: 'It leaves the list. Tasks under it are kept — archiving a work order must not delete field work.',
            confirmText: 'Archive', danger: true
          })
        : Promise.resolve(true);
      Promise.resolve(ask).then(function (yes) {
        if (!yes) return;
        return api().archive(t.id).then(function () {
          _state.openId = null;
          toast('Ticket archived');
          return reload();
        });
      }).catch(function (e) {
        toast(e && e.message ? e.message : 'Could not archive', 'error');
      });
    });
  }

  // ── Create ───────────────────────────────────────────────────────────
  function openCreate() {
    var prior = document.getElementById('p86StCreate');
    if (prior) prior.remove();
    var wrap = document.createElement('div');
    wrap.id = 'p86StCreate';
    wrap.className = 'p86-st-modal-back';
    wrap.innerHTML =
      '<div class="p86-st-modal">' +
        '<div class="p86-st-modal-head">New service ticket</div>' +
        '<label class="p86-st-lbl">Title</label>' +
        '<input type="text" id="p86StTitle" placeholder="e.g. Warranty call — gate will not latch" />' +
        '<label class="p86-st-lbl">Proposed scope</label>' +
        '<textarea id="p86StScope" rows="4" placeholder="What needs doing, and where."></textarea>' +
        '<div class="p86-st-modal-row">' +
          '<div><label class="p86-st-lbl">Priority</label>' +
            select('p86-st-modal-prio', ['low', 'normal', 'high', 'urgent'], 'normal', PRIORITY_LABEL) + '</div>' +
          '<div><label class="p86-st-lbl">Scheduled</label>' +
            '<input type="date" id="p86StSched" /></div>' +
        '</div>' +
        '<div class="p86-st-modal-actions">' +
          '<button class="ee-btn secondary" id="p86StCancel">Cancel</button>' +
          '<button class="ee-btn primary" id="p86StCreateGo">Create</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(wrap);
    var titleEl = wrap.querySelector('#p86StTitle');
    if (titleEl) titleEl.focus();

    function close() { wrap.remove(); }
    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
    wrap.querySelector('#p86StCancel').addEventListener('click', close);
    wrap.querySelector('#p86StCreateGo').addEventListener('click', function () {
      var title = (titleEl && titleEl.value || '').trim();
      if (!title) { if (titleEl) titleEl.focus(); return; }
      var go = wrap.querySelector('#p86StCreateGo');
      go.disabled = true;
      api().create({
        job_id: _state.jobId,
        title: title,
        scope_proposed: (wrap.querySelector('#p86StScope') || {}).value || '',
        priority: (wrap.querySelector('.p86-st-modal-prio') || {}).value || 'normal',
        scheduled_for: (wrap.querySelector('#p86StSched') || {}).value || null
      }).then(function (r) {
        close();
        _state.openId = r && r.ticket && r.ticket.id;
        toast('Ticket created');
        return reload();
      }).catch(function (e) {
        go.disabled = false;
        toast(e && e.message ? e.message : 'Could not create the ticket', 'error');
      });
    });
  }

  // ── Load ─────────────────────────────────────────────────────────────
  function reload() {
    if (!api() || !_state.jobId) return Promise.resolve();
    return api().list({ job_id: _state.jobId }).then(function (r) {
      _state.tickets = (r && r.tickets) || [];
      paint();
    }).catch(function (e) {
      var host = pane();
      if (host) {
        host.innerHTML = '<div class="p86-st-empty" style="color:#f87171;">' +
          esc(e && e.message ? e.message : 'Failed to load service tickets') + '</div>';
      }
    });
  }

  // THE RENDERER. Called as window.renderJobServiceTickets(jobId) — one
  // argument — by all three dispatch maps.
  function renderJobServiceTickets(jobId) {
    var host = pane();
    if (!host) return;
    if (!jobId) { host.innerHTML = ''; return; }
    if (!api()) {
      host.innerHTML = '<div class="p86-st-empty">Service tickets couldn\'t load — try refreshing the page.</div>';
      return;
    }
    // A different job means a different list; keep the expanded ticket only
    // while we are on the job it belongs to.
    if (_state.jobId !== jobId) { _state.jobId = jobId; _state.openId = null; _state.tickets = []; }
    host.innerHTML = '<div class="p86-st-empty">Loading service tickets…</div>';
    reload();
  }

  window.renderJobServiceTickets = renderJobServiceTickets;

  // Refresh seam. Deliberately REFUSES to repaint while a ticket is expanded
  // and being edited — a work order must not be repainted out from under the
  // caret. Same rule the reports tab follows.
  window.p86ServiceTickets = {
    refresh: function () {
      if (_state.busy) return;
      if (document.querySelector('#job-service-tickets .p86-st-row.is-open textarea:focus, ' +
                                 '#job-service-tickets .p86-st-row.is-open input:focus')) return;
      reload();
    }
  };
})();
