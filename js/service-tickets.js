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
    // A due date is a CALENDAR date, not an instant. `new Date('2026-09-20')`
    // parses it as UTC midnight, and every timezone west of Greenwich then
    // renders it as the 19th — a work order showing a deadline one day early.
    // A Postgres DATE column arrives as ...T00:00:00.000Z and means the same
    // thing, so both spellings are read as the day they name.
    var cal = /^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00(?:\.000)?Z)?$/.exec(String(v));
    var d = cal
      ? new Date(Number(cal[1]), Number(cal[2]) - 1, Number(cal[3]))
      : new Date(v);
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
      revisionsHTML(r.revisions || [], canEdit) +
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
          tasksHTML(r.tasks || [], canEdit) +
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
        '<button class="ee-btn secondary p86-st-share">&#x1F517; Share</button>' +
        '<button class="ee-btn secondary p86-st-archive">Archive</button>' +
      '</div>' : '') +
      '<div class="p86-st-sharewrap" hidden></div>' +
      participantsHTML(r.participants || [], canEdit) +
      (events.length ? '<div class="p86-st-timeline">' +
        '<label class="p86-st-lbl">Progress</label>' +
        events.map(eventHTML).join('') +
      '</div>' : '');

    wireDetail(d, t);
  }

  // ── Suggestions from a `propose` link ────────────────────────────────────
  //
  // A guest on a propose link never edits this ticket. What they typed landed
  // in a quarantine table and shows up here, per field, until somebody accepts
  // it. That is the whole design: the widest scope a token can hold still
  // cannot change the work order.
  var PROPOSED_LABEL = {
    scope_proposed: 'Scope', title: 'Title', priority: 'Priority',
    scheduled_for: 'Scheduled', due_date: 'Due', site_contact_name: 'Site contact',
    site_contact_phone: 'Site phone', access_notes: 'Access notes',
  };

  function proposedValue(k, v) {
    if (v === null || v === undefined || v === '') return '<em>cleared</em>';
    if (k === 'scheduled_for' || k === 'due_date') return esc(fmtDate(v) || String(v));
    if (k === 'priority') return esc(PRIORITY_LABEL[v] || v);
    return esc(String(v));
  }

  function revisionHTML(rev, canEdit) {
    var fields = (rev.fields && typeof rev.fields === 'object') ? rev.fields : {};
    var keys = Object.keys(fields).filter(function (k) { return PROPOSED_LABEL[k]; });
    if (!keys.length) return '';
    var pending = rev.status === 'pending';

    return '<div class="p86-st-rev' + (pending ? ' pending' : '') + '" data-rev="' + escAttr(rev.id) + '">' +
      '<div class="p86-st-rev-head">' +
        // author_label is a CLAIM, never identity — nobody authenticated to
        // type it. The UI says so rather than presenting it as a byline.
        '<span class="p86-st-rev-who">' +
          (rev.author_label ? esc(rev.author_label) : 'Someone on the link') +
          '<span class="p86-st-rev-claim" title="Typed by the guest. Nobody signed in to prove it.">unverified</span>' +
        '</span>' +
        '<span class="p86-st-rev-when">' + esc(fmtDate(rev.created_at) || '') + '</span>' +
        (rev.via_revoked_link
          ? '<span class="p86-st-rev-revoked" title="The link this came through has since been turned off. The suggestion is kept.">link revoked</span>'
          : '') +
        (pending ? '' : '<span class="p86-st-rev-state">' + esc(rev.status) + '</span>') +
      '</div>' +
      (rev.note ? '<div class="p86-st-rev-note">' + esc(rev.note) + '</div>' : '') +
      '<div class="p86-st-rev-fields">' + keys.map(function (k) {
        return '<label class="p86-st-rev-field">' +
          (pending && canEdit
            ? '<input type="checkbox" class="p86-st-rev-pick" value="' + escAttr(k) + '" checked />'
            : '') +
          '<span class="p86-st-rev-fname">' + esc(PROPOSED_LABEL[k]) + '</span>' +
          '<span class="p86-st-rev-fval">' + proposedValue(k, fields[k]) + '</span>' +
        '</label>';
      }).join('') + '</div>' +
      (pending && canEdit
        ? '<div class="p86-st-rev-actions">' +
            '<button class="ee-btn primary p86-st-rev-accept">Accept selected</button>' +
            '<button class="ee-btn secondary p86-st-rev-reject">Reject</button>' +
          '</div>'
        : '') +
    '</div>';
  }

  function revisionsHTML(revisions, canEdit) {
    var rows = revisions.filter(function (r) { return r && r.fields; });
    if (!rows.length) return '';
    var pending = rows.filter(function (r) { return r.status === 'pending'; });
    var done = rows.filter(function (r) { return r.status !== 'pending'; });
    var body = pending.concat(done).map(function (r) { return revisionHTML(r, canEdit); }).join('');
    if (!body) return '';
    return '<div class="p86-st-revs' + (pending.length ? ' has-pending' : '') + '">' +
      '<label class="p86-st-lbl">Suggestions' +
        (pending.length ? ' <span class="p86-st-revs-badge">' + pending.length + ' waiting</span>' : '') +
      '</label>' +
      body +
    '</div>';
  }

  // ── Internal participants ────────────────────────────────────────────────
  //
  // NOT a share, and the panel says so. Nobody here gets a token: a token for
  // an employee would bypass their own role, survive their deactivation, and
  // be forwardable outside the company. They sign in like they always do.
  function participantsHTML(participants, canEdit) {
    var rows = participants || [];
    if (!rows.length && !canEdit) return '';
    return '<div class="p86-st-parts">' +
      '<label class="p86-st-lbl">On this ticket</label>' +
      (rows.length
        ? rows.map(function (p) {
            return '<div class="p86-st-part" data-user="' + escAttr(p.user_id) + '">' +
              '<span class="p86-st-part-name">' + esc(p.user_name || ('User ' + p.user_id)) + '</span>' +
              '<span class="p86-st-part-lvl">' + (p.access_level === 'edit' ? 'can edit' : 'can view') + '</span>' +
              (canEdit ? '<button class="p86-st-part-rm" title="Remove">&times;</button>' : '') +
            '</div>';
          }).join('')
        : '<div class="p86-st-empty">Nobody added yet.</div>') +
      (canEdit
        ? '<div class="p86-st-part-add">' +
            '<select class="p86-st-part-user"><option value="">Add someone…</option></select>' +
            '<select class="p86-st-part-lvl-sel"><option value="view">Can view</option><option value="edit">Can edit</option></select>' +
            '<button class="ee-btn secondary p86-st-part-go">Add</button>' +
          '</div>' +
          '<div class="p86-st-part-note">They sign in as themselves — no link is created.</div>'
        : '') +
    '</div>';
  }

  // The ticket's child tasks — what makes this the tier ABOVE tasks.
  //
  // These are real org tasks, not a private sub-list: each one keeps its
  // entity_type='job' / entity_id, so it ALSO appears on the job's Tasks panel
  // and in the My Tasks "Job" column. That is the entire reason the ticket got
  // its own column on tasks rather than claiming the polymorphic slot, and the
  // note below says so on screen because it is otherwise invisible and someone
  // will eventually "tidy it up".
  function tasksHTML(tasks, canEdit) {
    var live = tasks.filter(function (t) { return !t.archived_at; });
    var done = live.filter(function (t) { return t.status === 'done'; }).length;
    var pct = live.length ? Math.round((done / live.length) * 100) : 0;
    return '<label class="p86-st-lbl">Tasks' +
        (live.length ? ' <span class="p86-st-taskcount">' + done + ' of ' + live.length + ' done</span>' : '') +
      '</label>' +
      (live.length
        ? '<div class="p86-st-bar-track"><div class="p86-st-bar-fill" style="width:' + pct + '%"></div></div>' +
          '<div class="p86-st-tasklist">' + live.map(function (t) {
            return '<div class="p86-st-task' + (t.status === 'done' ? ' is-done' : '') + '">' +
              '<span class="p86-st-task-dot"></span>' +
              '<span class="p86-st-task-title">' + esc(t.title || 'Untitled') + '</span>' +
              (t.due_date ? '<span class="p86-st-task-due">' + esc(fmtDate(t.due_date)) + '</span>' : '') +
            '</div>';
          }).join('') + '</div>'
        : '<div class="p86-st-ro"><em>No tasks under this ticket yet.</em></div>') +
      (canEdit
        ? '<div class="p86-st-task-add">' +
            '<input type="text" class="p86-st-task-new" placeholder="Add a task to this work order…" />' +
            '<button class="ee-btn secondary p86-st-task-go">Add</button>' +
          '</div>' +
          '<div class="p86-st-task-note">Tasks added here stay on the job\'s Tasks list and in My Tasks — ' +
            'the ticket groups them, it does not hide them.</div>'
        : '');
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
    // A name on a guest row is a CLAIM, not identity — a bearer token cannot
    // prove who is holding it — so the row says how it arrived rather than
    // presenting the name the way an authenticated actor's is presented.
    var who = e.actor_kind === 'share'
      ? (e.actor_label ? esc(e.actor_label) + ' · via shared link' : 'via shared link')
      : (e.actor_kind === 'agent' ? '86' : 'Office');
    var VERB = {
      created: 'raised the ticket',
      note_added: 'added a field note',
      photo_added: 'added a photo',
      shared: 'sent a link',
      share_revoked: 'turned a link off',
      share_opened: 'opened the link',
      revision_proposed: 'proposed a revision',
      revision_accepted: 'accepted a revision',
      revision_rejected: 'rejected a revision',
      agent_drafted: 'drafted this with 86'
    };
    var what = e.kind === 'status_changed' && e.detail
      ? 'moved it to ' + esc(STATUS_LABEL[e.detail.to] || e.detail.to)
      : e.kind === 'field_changed' && e.detail && e.detail.fields
        ? 'edited ' + esc((e.detail.fields || []).join(', '))
        : esc(VERB[e.kind] || String(e.kind || '').replace(/_/g, ' '));
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

    // Add a task under this ticket. entity_type/entity_id are stamped from the
    // ticket's own parent so the task lands on the JOB as well — sending only
    // service_ticket_id would create a task that belongs to a work order and
    // to no job, which is exactly the disappearance this design avoids.
    var addGo = d.querySelector('.p86-st-task-go');
    var addIn = d.querySelector('.p86-st-task-new');
    function addTask() {
      var title = (addIn && addIn.value || '').trim();
      if (!title || !window.p86Api || !window.p86Api.tasks) return;
      addGo.disabled = true;
      window.p86Api.tasks.create({
        title: title,
        service_ticket_id: t.id,
        entity_type: t.job_id ? 'job' : 'lead',
        entity_id: t.job_id || t.lead_id
      }).then(function () {
        if (addIn) addIn.value = '';
        _state.openId = t.id;
        return reload();
      }).catch(function (e) {
        toast(e && e.message ? e.message : 'Could not add the task', 'error');
      }).then(function () { if (addGo) addGo.disabled = false; });
    }
    if (addGo) addGo.addEventListener('click', addTask);
    if (addIn) addIn.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); addTask(); }
    });

    var shareBtn = d.querySelector('.p86-st-share');
    if (shareBtn) shareBtn.addEventListener('click', function () {
      var wrap = d.querySelector('.p86-st-sharewrap');
      if (!wrap) return;
      if (!wrap.hidden) { wrap.hidden = true; wrap.innerHTML = ''; return; }
      wrap.hidden = false;
      paintSharePanel(wrap, t);
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

    wireRevisions(d, t);
    wireParticipants(d, t);
  }

  // Accept takes the CHECKED fields only, so "take the new scope, ignore the
  // date they suggested" is one click. Sending nothing checked is refused here
  // rather than making the round trip to be told 400.
  function wireRevisions(d, t) {
    Array.prototype.forEach.call(d.querySelectorAll('.p86-st-rev'), function (row) {
      var id = row.getAttribute('data-rev');
      var acc = row.querySelector('.p86-st-rev-accept');
      var rej = row.querySelector('.p86-st-rev-reject');

      if (acc) acc.addEventListener('click', function () {
        var picked = Array.prototype.map.call(
          row.querySelectorAll('.p86-st-rev-pick:checked'), function (c) { return c.value; });
        if (!picked.length) { toast('Tick at least one field to accept.', 'error'); return; }
        acc.disabled = true;
        if (rej) rej.disabled = true;
        api().acceptRevision(t.id, id, picked).then(function () {
          toast('Applied ' + picked.length + (picked.length === 1 ? ' field' : ' fields'));
          _state.openId = t.id;
          return reload();
        }).catch(function (e) {
          acc.disabled = false;
          if (rej) rej.disabled = false;
          // A second accept is a 404 by predicate — say what that means rather
          // than showing "not found" for a row still on screen.
          toast(e && /not found/i.test(e.message || '')
            ? 'That suggestion was already handled — reload to see where it went.'
            : (e && e.message) || 'Could not apply the suggestion', 'error');
        });
      });

      if (rej) rej.addEventListener('click', function () {
        rej.disabled = true;
        if (acc) acc.disabled = true;
        api().rejectRevision(t.id, id).then(function () {
          toast('Suggestion declined');
          _state.openId = t.id;
          return reload();
        }).catch(function (e) {
          rej.disabled = false;
          if (acc) acc.disabled = false;
          toast(e && e.message ? e.message : 'Could not decline', 'error');
        });
      });
    });
  }

  // The picker is filled from the org's own users. A body-supplied id only
  // proves a user exists, never whose they are — the server re-proves the org
  // regardless of what this list contains.
  function wireParticipants(d, t) {
    var sel = d.querySelector('.p86-st-part-user');
    var lvl = d.querySelector('.p86-st-part-lvl-sel');
    var go = d.querySelector('.p86-st-part-go');
    var already = {};
    Array.prototype.forEach.call(d.querySelectorAll('.p86-st-part'), function (p) {
      already[String(p.getAttribute('data-user'))] = true;
    });

    if (sel && window.p86Api && window.p86Api.users && window.p86Api.users.list) {
      Promise.resolve(window.p86Api.users.list()).then(function (r) {
        var users = (r && (r.users || r)) || [];
        if (!Array.isArray(users)) return;
        users.forEach(function (u) {
          if (!u || !u.id || already[String(u.id)]) return;
          var o = document.createElement('option');
          o.value = u.id;
          o.textContent = u.name || u.email || ('User ' + u.id);
          sel.appendChild(o);
        });
      }).catch(function () { /* the picker degrades to empty; nothing breaks */ });
    }

    if (go) go.addEventListener('click', function () {
      if (!sel || !sel.value) return;
      go.disabled = true;
      api().addParticipant(t.id, sel.value, lvl ? lvl.value : 'view').then(function () {
        toast('Added to the ticket');
        _state.openId = t.id;
        return reload();
      }).catch(function (e) {
        go.disabled = false;
        toast(e && e.message ? e.message : 'Could not add them', 'error');
      });
    });

    Array.prototype.forEach.call(d.querySelectorAll('.p86-st-part-rm'), function (btn) {
      btn.addEventListener('click', function () {
        var uid = btn.parentNode && btn.parentNode.getAttribute('data-user');
        if (!uid) return;
        btn.disabled = true;
        api().removeParticipant(t.id, uid).then(function () {
          _state.openId = t.id;
          return reload();
        }).catch(function (e) {
          btn.disabled = false;
          toast(e && e.message ? e.message : 'Could not remove them', 'error');
        });
      });
    });
  }

  // ── Share panel ──────────────────────────────────────────────────────
  // Send a work order to someone with no account. The panel ALWAYS shows the
  // link, even when the email is off or the send fails, because the link IS
  // the deliverable: the server keeps only its hash, so a link not copied
  // here cannot be recovered later, only replaced.
  //
  // The selector offers exactly the three scopes the server will honour. It
  // never offered one the server would silently narrow — that would be a lie
  // told by a dropdown — so it grew as the doors landed: view only in S4,
  // respond in S5, propose in S6. There is no 'edit': the DB CHECK refuses it.
  function paintSharePanel(wrap, t) {
    wrap.innerHTML = '<div class="p86-st-loading">Loading links…</div>';
    api().shares(t.id).then(function (r) {
      var list = (r && r.shares) || [];
      wrap.innerHTML =
        '<div class="p86-st-share-panel">' +
          '<div class="p86-st-lbl-row"><span class="p86-st-lbl">Share this work order</span></div>' +
          '<div class="p86-st-share-form">' +
            '<input type="email" class="p86-st-share-email" placeholder="Email (optional)" />' +
            '<input type="text" class="p86-st-share-name" placeholder="Their name (optional)" />' +
            select('p86-st-share-scope', ['view', 'respond', 'propose'], 'respond',
              { view: 'View only', respond: 'Can file a report', propose: 'Can also suggest changes' }) +
            '<button class="ee-btn primary p86-st-share-go">Create link</button>' +
          '</div>' +
          '<div class="p86-st-task-note">Anyone with the link can OPEN this work order. ' +
            '<strong>Can file a report</strong> also lets them add notes and photos and mark the ' +
            'work complete — things that are theirs to report. ' +
            '<strong>Can suggest changes</strong> adds a form for the scope and the dates, but what ' +
            'they send is a SUGGESTION: it waits here for you to accept it, field by field, and ' +
            'changes nothing until you do. Neither one can change who it is assigned to or its ' +
            'status. The link expires in 30 days and you can turn it off at any time.</div>' +
          '<div class="p86-st-share-out"></div>' +
          (list.length
            ? '<div class="p86-st-share-list">' + list.map(shareRowHTML).join('') + '</div>'
            : '<div class="p86-st-lead-empty">No links yet.</div>') +
        '</div>';
      wireSharePanel(wrap, t);
    }).catch(function (e) {
      wrap.innerHTML = '<div class="p86-st-loading" style="color:#f87171;">' +
        esc(e && e.message ? e.message : 'Could not load links') + '</div>';
    });
  }

  function shareRowHTML(s) {
    var state = s.state || 'sent';
    return '<div class="p86-st-share-row" data-share="' + escAttr(s.id) + '">' +
      '<span class="p86-st-share-who">' +
        esc(s.recipient_name || s.recipient_email || 'Anyone with the link') + '</span>' +
      '<span class="p86-st-share-state st-' + esc(state) + '">' + esc(state) + '</span>' +
      (s.view_count ? '<span class="p86-st-share-views">' + esc(String(s.view_count)) + ' view' +
        (Number(s.view_count) === 1 ? '' : 's') + '</span>' : '') +
      '<span class="p86-st-share-exp">' + esc(fmtDate(s.expires_at)) + '</span>' +
      (state === 'revoked' || state === 'expired'
        ? ''
        : '<button class="p86-st-share-revoke" title="Turn this link off">Turn off</button>') +
    '</div>';
  }

  function wireSharePanel(wrap, t) {
    var go = wrap.querySelector('.p86-st-share-go');
    if (go) go.addEventListener('click', function () {
      go.disabled = true;
      api().share(t.id, {
        email: (wrap.querySelector('.p86-st-share-email') || {}).value || '',
        name: (wrap.querySelector('.p86-st-share-name') || {}).value || '',
        // The server normalizes this and narrows anything it does not
        // recognise to 'view' — the dropdown is a convenience, not the gate.
        scope: (wrap.querySelector('.p86-st-share-scope') || {}).value || 'view'
      }).then(function (r) {
        var out = wrap.querySelector('.p86-st-share-out');
        // Shown whether or not the email sent — this is the only time the raw
        // token exists.
        if (out) {
          out.innerHTML =
            '<div class="p86-st-share-link">' +
              '<input type="text" readonly value="' + escAttr(r.link || '') + '" />' +
              '<button class="ee-btn secondary p86-st-share-copy">Copy</button>' +
            '</div>' +
            '<div class="p86-st-task-note">' +
              (r.email_sent ? 'Emailed. ' : (r.email_error ? 'The email did not send — copy the link instead. ' : '')) +
              'Copy this now: it is stored only as a hash, so it cannot be shown again.' +
            '</div>';
          var copy = out.querySelector('.p86-st-share-copy');
          if (copy) copy.addEventListener('click', function () {
            var inp = out.querySelector('input');
            if (!inp) return;
            inp.select();
            try { navigator.clipboard.writeText(inp.value); toast('Link copied'); }
            catch (e) { try { document.execCommand('copy'); toast('Link copied'); } catch (_) {} }
          });
        }
        return paintSharePanelKeepingOutput(wrap, t, out && out.innerHTML);
      }).catch(function (e) {
        toast(e && e.message ? e.message : 'Could not create the link', 'error');
      }).then(function () { if (go) go.disabled = false; });
    });

    wrap.querySelectorAll('.p86-st-share-revoke').forEach(function (b) {
      b.addEventListener('click', function () {
        var row = b.closest('.p86-st-share-row');
        var sid = row && row.getAttribute('data-share');
        if (!sid) return;
        b.disabled = true;
        api().revokeShare(t.id, sid).then(function () {
          toast('Link turned off');
          return paintSharePanel(wrap, t);
        }).catch(function (e) {
          b.disabled = false;
          toast(e && e.message ? e.message : 'Could not turn the link off', 'error');
        });
      });
    });
  }

  // Repaint the list without losing the just-minted link, which cannot be
  // recovered if it scrolls away.
  function paintSharePanelKeepingOutput(wrap, t, outHTML) {
    return api().shares(t.id).then(function (r) {
      var list = (r && r.shares) || [];
      var listEl = wrap.querySelector('.p86-st-share-list');
      var html = list.length
        ? list.map(shareRowHTML).join('')
        : '';
      if (listEl) listEl.innerHTML = html;
      else {
        var panel = wrap.querySelector('.p86-st-share-panel');
        if (panel) panel.insertAdjacentHTML('beforeend', '<div class="p86-st-share-list">' + html + '</div>');
      }
      wireSharePanel(wrap, t);
      var out = wrap.querySelector('.p86-st-share-out');
      if (out && outHTML) out.innerHTML = outHTML;
      // Re-wire the copy button — the innerHTML restore above dropped its
      // listener.
      var copy = out && out.querySelector('.p86-st-share-copy');
      if (copy) copy.addEventListener('click', function () {
        var inp = out.querySelector('input');
        if (!inp) return;
        inp.select();
        try { navigator.clipboard.writeText(inp.value); toast('Link copied'); } catch (e) {}
      });
    });
  }

  // ── Lead surface ─────────────────────────────────────────────────────
  // A ticket raised during the pursuit. It keeps lead_id FOREVER and GAINS
  // job_id when the lead converts (see the carry-forward in
  // server/routes/job-routes.js), so it stays listed here AND appears in the
  // job's manager from that moment — which is why service_tickets has two
  // nullable parent columns instead of the polymorphic pair every other child
  // of a lead uses. Those children get re-pointed or stranded on conversion;
  // this one does not.
  var _leadPanel = { host: null, leadId: null };

  function mountLeadPanel(host, leadId, lead) {
    if (!host || !leadId) return;
    _leadPanel.host = host;
    _leadPanel.leadId = leadId;
    if (!api()) {
      host.innerHTML = '<div class="p86-st-lead-empty">Service tickets module unavailable.</div>';
      return;
    }
    host.innerHTML = '<div class="p86-st-lead-empty">Loading…</div>';
    api().list({ lead_id: leadId }).then(function (r) {
      // The panel may have been remounted onto a different lead while this
      // was in flight.
      if (_leadPanel.leadId !== leadId || _leadPanel.host !== host) return;
      var list = (r && r.tickets) || [];
      host.innerHTML = list.length
        ? '<div class="p86-st-lead-list">' + list.map(function (t) {
            return '<div class="p86-st-lead-row">' +
              '<span class="p86-st-prio prio-' + esc(t.priority || 'normal') + '"></span>' +
              '<span class="p86-st-lead-title">' + esc(t.title || 'Untitled') + '</span>' +
              '<span class="p86-st-status st-' + esc(t.status) + '">' +
                esc(STATUS_LABEL[t.status] || t.status) + '</span>' +
              // Once converted, say so here — otherwise the lead panel looks
              // like the ticket never went anywhere.
              (t.job_id ? '<span class="p86-st-lead-onjob" title="This ticket is on the job too">on job</span>' : '') +
            '</div>';
          }).join('') + '</div>'
        : '<div class="p86-st-lead-empty">No service tickets on this lead.</div>';
    }).catch(function (e) {
      if (_leadPanel.leadId !== leadId) return;
      host.innerHTML = '<div class="p86-st-lead-empty" style="color:#f87171;">' +
        esc(e && e.message ? e.message : 'Failed to load') + '</div>';
    });
  }

  // The lead header button. Reuses the same create modal the job manager uses,
  // pointed at a lead instead of a job.
  function createForLead() {
    var leadId = _leadPanel.leadId ||
      (window.p86Leads && window.p86Leads.currentId && window.p86Leads.currentId());
    if (!leadId) {
      toast('Save the lead before raising a ticket', 'error');
      return;
    }
    openCreate({ leadId: leadId });
  }

  // ── Create ───────────────────────────────────────────────────────────
  function openCreate(opts) {
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
      var leadId = opts && opts.leadId;
      api().create({
        // Exactly one parent is set here. The other is filled in later by the
        // convert carry-forward, never by the client.
        job_id: leadId ? undefined : _state.jobId,
        lead_id: leadId || undefined,
        title: title,
        scope_proposed: (wrap.querySelector('#p86StScope') || {}).value || '',
        priority: (wrap.querySelector('.p86-st-modal-prio') || {}).value || 'normal',
        scheduled_for: (wrap.querySelector('#p86StSched') || {}).value || null
      }).then(function (r) {
        close();
        toast('Ticket created');
        // A ticket raised from a lead repaints the LEAD panel; the job
        // manager may not even be mounted.
        if (leadId) return mountLeadPanel(_leadPanel.host, leadId);
        _state.openId = r && r.ticket && r.ticket.id;
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
    // The lead surfaces (js/leads.js calls both).
    mountLeadPanel: mountLeadPanel,
    createForLead: createForLead,
    refresh: function () {
      if (_state.busy) return;
      if (document.querySelector('#job-service-tickets .p86-st-row.is-open textarea:focus, ' +
                                 '#job-service-tickets .p86-st-row.is-open input:focus')) return;
      reload();
    }
  };
})();
