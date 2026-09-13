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
// Written against the final response shape (tasks, shares, guest responses,
// revisions, participants), so a key the server answers as an empty array
// renders as "none yet" rather than needing a temporary branch.
//
// S7 adds the agent seams: "Draft with 86" on the job manager and the lead
// panel, "Ask 86" on an open ticket, and a refresh() that repaints whichever
// surface is mounted when an agent write lands (js/refresh.js calls it).
// ============================================================
(function () {
  'use strict';

  // One open ticket at a time, keyed by job. Module-level so a repaint that
  // arrives while a ticket is expanded can restore it.
  // `stale` is the deferred-refresh latch; see refresh() at the bottom.
  var _state = { jobId: null, filter: 'all', openId: null, tickets: [], busy: false, stale: false, openSubs: {}, taskTitles: {} };
  // Read at load, before the router rewrites the URL without its query.
  var _deepTicket = (function () {
    try { return new URLSearchParams(location.search).get('ticket') || null; } catch (_) { return null; }
  })();

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

  // The lead side mirrors the lead header's own Service Ticket button
  // (refreshLeadDetailHeader in js/leads.js): LEADS_EDIT, and hidden when the
  // auth module is not there to ask. Two affordances on one screen that
  // disagreed about who may raise a ticket would each be half a lie.
  function canEditLead() {
    try {
      return !!(window.p86Auth && window.p86Auth.hasCapability('LEADS_EDIT'));
    } catch (e) { return false; }
  }

  // ── 86 hand-off ──────────────────────────────────────────────────────
  // Everything goes through the AI panel's PUBLIC seam, window.p86AI.ask
  // (js/ai-panel.js), looked up at click time because that file loads after
  // this one. The prompt is seeded and left UNSENT (autoSend:false): a draft
  // is only as good as what the PM adds about the call that came in, and a
  // prompt that fired on click would spend a turn asking for exactly that.
  //
  // Names are forward-facing. The model and the PM both read this text, so a
  // job is its number and title and a lead is its title, never a raw id. The
  // job's id still reaches 86: the panel opened against a job sends it in
  // current_context. The one id written into a prompt is the ticket's own, on
  // "Ask 86", because a ticket has no page context of its own and reading it
  // back by id is the only way 86 can find that exact work order.
  function aiAsk() {
    var ai = window.p86AI;
    return (ai && typeof ai.ask === 'function') ? ai : null;
  }

  function jobName(jobId) {
    try {
      var jobs = (window.appData && window.appData.jobs) || [];
      var job = jobs.find(function (j) { return j && String(j.id) === String(jobId); });
      var L = window.p86JobLabel;
      if (!job || !L || typeof L.fromJob !== 'function') return '';
      var label = L.fromJob(job);
      // The formatter's fallback is a placeholder, not a name. "Draft a ticket
      // on job Untitled job" reads as a real job called that.
      return label === L.DEFAULT_FALLBACK ? '' : label;
    } catch (e) { return ''; }
  }

  function leadRecord(leadId, lead) {
    try {
      var leads = (window.appData && window.appData.leads) || [];
      var row = leads.find(function (l) { return l && String(l.id) === String(leadId); });
      return row || lead || null;
    } catch (e) { return lead || null; }
  }

  function leadName(leadId, lead) {
    var r = leadRecord(leadId, lead);
    return (r && String(r.title || r.property_name || '').trim()) || '';
  }

  var DRAFT_ASK =
    'Propose a title, the scope of work, a priority, when it should be scheduled and when it is due, ' +
    'and the child tasks the crew will need. Ask me for anything you are missing before it is written, ' +
    'then have it drafted for my approval. What came in: ';

  function draftPromptForJob(jobId) {
    var name = jobName(jobId);
    return 'Draft a service ticket on ' + (name ? 'job ' + name : 'this job') + '. ' + DRAFT_ASK;
  }

  function draftPromptForLead(leadId, lead) {
    var name = leadName(leadId, lead);
    var r = leadRecord(leadId, lead);
    // The address disambiguates two leads with the same title ("Roof leak")
    // without handing the model an id to repeat back to the PM.
    var where = r ? [r.street_address, r.city].filter(function (s) { return s && String(s).trim(); }).join(', ') : '';
    return 'Draft a service ticket on ' + (name ? 'the lead "' + name + '"' : 'this lead') +
      (where ? ' at ' + where : '') + '. ' + DRAFT_ASK;
  }

  function askPromptForTicket(t) {
    var label = [t.ticket_number, '"' + (t.title || 'Untitled ticket') + '"'].filter(Boolean).join(' ');
    var parent = t.job_id
      ? (jobName(t.job_id) ? 'job ' + jobName(t.job_id) : '')
      : (leadName(t.lead_id) ? 'the lead "' + leadName(t.lead_id) + '"' : '');
    return 'Read service ticket ' + label + ' (ticket id ' + t.id + ')' +
      (parent ? ' on ' + parent : '') +
      ' and tell me where it stands: the scope, the schedule, its status, and which of its tasks are still open.';
  }

  function noAi() {
    toast('86 is not available on this page right now.', 'error');
  }

  // On a job: open the panel against THAT job, so current_context carries the
  // job id and 86 does not have to guess the parent from a name.
  function draftForJob(jobId) {
    var ai = aiAsk();
    if (!ai) { noAi(); return; }
    ai.ask(draftPromptForJob(jobId), { entityType: 'job', entityId: jobId, autoSend: false });
  }

  // On a lead: open the entity-free Ask 86 surface, NOT the panel's lead mode.
  // ai-panel.js packs current_context only for job / estimate / intake / ask86,
  // so lead mode would carry LESS than Ask 86 does — Ask 86 at least sends the
  // page context, the /leads/:id route among it. The prompt names the lead
  // either way, and the Scribe's draft still goes through the approval card.
  function draftForLead(leadId, lead) {
    var ai = aiAsk();
    if (!ai) { noAi(); return; }
    ai.ask(draftPromptForLead(leadId, lead), { autoSend: false });
  }

  function askAboutTicket(t) {
    var ai = aiAsk();
    if (!ai) { noAi(); return; }
    if (t.job_id && _state.jobId && String(t.job_id) === String(_state.jobId)) {
      ai.ask(askPromptForTicket(t), { entityType: 'job', entityId: _state.jobId, autoSend: false });
    } else {
      ai.ask(askPromptForTicket(t), { autoSend: false });
    }
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
          // Same gate as + New ticket: a draft ends in a create, so a user who
          // cannot raise a ticket by hand is not offered one by proxy.
          (canEdit && aiAsk()
            ? '<button class="ee-btn secondary p86-st-draft86" title="86 drafts the ticket, scope and tasks for your approval">Draft with 86</button>'
            : '') +
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
    var d86 = host.querySelector('.p86-st-draft86');
    if (d86) d86.addEventListener('click', function () { draftForJob(_state.jobId); });

    host.querySelectorAll('.p86-st-row-head').forEach(function (h) {
      h.addEventListener('click', function () {
        var row = h.closest('.p86-st-row');
        var id = row && row.getAttribute('data-ticket');
        if (!id) return;
        if (_state.openId === id) { collapse(row); _state.openId = null; flushStale(); return; }
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
    // Timeline rows name the building a photo or note landed on.
    _state.taskTitles = {};
    (r.tasks || []).forEach(function (k) { _state.taskTitles[String(k.id)] = k.title || ''; });

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
      siteHTML(r.site) +
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
          materialsHTML(t, canEdit) +
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
          (t.street_address && !(r.site && r.site.address)
            ? metaRow('Address', esc([t.street_address, t.city, t.state].filter(Boolean).join(', ')))
            : '') +
        '</div>' +
      '</div>' +
      // Ask 86 is a READ, so it is not behind canEdit: a closed or cancelled
      // ticket is exactly the one somebody asks "what happened here" about.
      ((canEdit || aiAsk()) ? '<div class="p86-st-actions">' +
        (canEdit
          ? '<button class="ee-btn primary p86-st-save">Save</button>' +
            '<button class="ee-btn secondary p86-st-share">&#x1F517; Share</button>' +
            '<button class="ee-btn secondary p86-st-archive">Archive</button>'
          : '') +
        (aiAsk()
          ? '<button class="ee-btn secondary p86-st-ask86" title="Ask 86 about this work order">Ask 86</button>'
          : '') +
      '</div>' : '') +
      '<div class="p86-st-sharewrap" hidden></div>' +
      participantsHTML(r.participants || [], canEdit) +
      (events.length ? '<div class="p86-st-timeline">' +
        '<label class="p86-st-lbl">Progress</label>' +
        events.map(eventHTML).join('') +
      '</div>' : '');

    wireDetail(d, t);
    wireWorkOrder(d, t, r.tasks || [], canEdit);
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
  //
  // Each task is a work-order SUBTASK: one per building, with its own before
  // and completion photos, crew notes, and a complete box. Completing needs at
  // least one completion photo — the server enforces it (409), the card only
  // says so up front so nobody finds out by clicking.
  function tasksHTML(tasks, canEdit) {
    var live = tasks.filter(function (t) { return !t.archived_at; });
    var done = live.filter(function (t) { return t.status === 'done'; }).length;
    var pct = live.length ? Math.round((done / live.length) * 100) : 0;
    return '<label class="p86-st-lbl">Punch list' +
        (live.length ? ' <span class="p86-st-taskcount">' + done + ' of ' + live.length + ' done</span>' : '') +
      '</label>' +
      (live.length
        ? '<div class="p86-st-bar-track"><div class="p86-st-bar-fill" style="width:' + pct + '%"></div></div>' +
          '<div class="p86-wo-subs">' + live.map(function (t) { return subtaskHTML(t, canEdit); }).join('') + '</div>'
        : '<div class="p86-st-ro"><em>No subtasks under this work order yet.</em></div>') +
      (canEdit
        ? '<div class="p86-st-task-add">' +
            '<input type="text" class="p86-st-task-new" placeholder="Add a subtask — e.g. Bldg 790 — Side A: …" />' +
            '<button class="ee-btn secondary p86-st-task-go">Add</button>' +
          '</div>' +
          '<div class="p86-st-task-note">Subtasks stay on the job\'s Tasks list and in My Tasks — ' +
            'the work order groups them, it does not hide them.</div>'
        : '');
  }

  // "Bldg 784 — Side A: rail post; tread 3 · Side D: stringer" → a heading and
  // per-side lists. A title that does not follow the shape renders whole.
  function parseSubtaskTitle(title) {
    var s = String(title || '').trim();
    var m = s.match(/^(.+?)\s+[—–-]\s+(.+)$/);
    if (!m) return { head: s || 'Untitled', sides: [] };
    var sides = m[2].split(/\s+·\s+/).map(function (part) {
      var sm = part.match(/^([^:]{1,40}):\s*(.+)$/);
      if (!sm) return { label: '', items: [part.trim()] };
      return {
        label: sm[1].trim(),
        items: sm[2].split(/;\s*/).map(function (x) { return x.trim(); }).filter(Boolean)
      };
    });
    return { head: m[1].trim(), sides: sides };
  }

  function subtaskHTML(t, canEdit) {
    var parsed = parseSubtaskTitle(t.title);
    var photos = t.photos || [];
    var completion = photos.filter(function (p) { return p.kind !== 'before'; }).length;
    var before = photos.length - completion;
    var isDone = t.status === 'done';
    var open = !!_state.openSubs[t.id];
    var sideSummary = parsed.sides.map(function (sd) {
      return sd.label ? sd.label + ' (' + sd.items.length + ')' : sd.items.length + ' item' + (sd.items.length === 1 ? '' : 's');
    }).join(' · ');
    var notes = t.notes || [];

    return '<div class="p86-wo-sub' + (isDone ? ' is-done' : '') + (open ? ' is-open' : '') + '" data-task="' + escAttr(t.id) + '">' +
      '<div class="p86-wo-sub-head">' +
        '<button type="button" class="p86-wo-check" aria-pressed="' + (isDone ? 'true' : 'false') + '"' +
          (canEdit ? '' : ' disabled') +
          ' title="' + (isDone ? 'Reopen this subtask' : (completion ? 'Mark complete' : 'Add a completion photo to mark this complete')) + '">' +
          (isDone ? '&#x2713;' : '') +
        '</button>' +
        '<button type="button" class="p86-wo-sub-toggle" aria-expanded="' + (open ? 'true' : 'false') + '">' +
          '<span class="p86-wo-sub-name">' + esc(parsed.head) + '</span>' +
          (sideSummary ? '<span class="p86-wo-sub-sum">' + esc(sideSummary) + '</span>' : '') +
        '</button>' +
        '<span class="p86-wo-sub-meta">' +
          (photos.length
            ? '<span class="p86-wo-chip" title="' + completion + ' completion, ' + before + ' before">' + photos.length + ' photo' + (photos.length === 1 ? '' : 's') + '</span>'
            : '') +
          (notes.length ? '<span class="p86-wo-chip">' + notes.length + ' note' + (notes.length === 1 ? '' : 's') + '</span>' : '') +
          (isDone
            ? '<span class="p86-wo-doneby">Done' + (t.completed_by ? ' · ' + esc(t.completed_by) : '') + '</span>'
            : (completion ? '' : '<span class="p86-wo-needs">Needs photo</span>')) +
        '</span>' +
      '</div>' +
      '<div class="p86-wo-sub-body"' + (open ? '' : ' hidden') + '>' +
        (parsed.sides.length
          ? '<div class="p86-wo-sides">' + parsed.sides.map(function (sd) {
              return '<div class="p86-wo-side">' +
                (sd.label ? '<div class="p86-wo-side-lbl">' + esc(sd.label) + '</div>' : '') +
                '<ul>' + sd.items.map(function (it) { return '<li>' + esc(it) + '</li>'; }).join('') + '</ul>' +
              '</div>';
            }).join('') + '</div>'
          : '') +
        '<div class="p86-wo-photos">' +
          (photos.length
            ? photos.map(function (p, i) {
                return '<button type="button" class="p86-wo-thumb" data-idx="' + i + '" title="' + (p.kind === 'before' ? 'Before' : 'Completion') + ' photo">' +
                  '<img src="' + escAttr(p.thumb_url || p.web_url || '') + '" alt="" loading="lazy" />' +
                  '<span class="p86-wo-kind k-' + (p.kind === 'before' ? 'before' : 'after') + '">' + (p.kind === 'before' ? 'Before' : 'Done') + '</span>' +
                '</button>';
              }).join('')
            : '<div class="p86-wo-nophotos">No photos yet.</div>') +
        '</div>' +
        (canEdit
          ? '<div class="p86-wo-sub-actions">' +
              '<label class="ee-btn primary p86-wo-up">+ Completion photo<input type="file" accept="image/*" multiple hidden data-kind="completion" /></label>' +
              '<label class="ee-btn secondary p86-wo-up">+ Before photo<input type="file" accept="image/*" multiple hidden data-kind="before" /></label>' +
            '</div>'
          : '') +
        (notes.length
          ? '<div class="p86-wo-notes">' + notes.map(function (n) {
              return '<div class="p86-wo-note"><span class="p86-wo-note-by">' + esc(n.by || '') +
                (n.at ? ' · ' + esc(fmtDate(n.at)) : '') + '</span>' + esc(n.note) + '</div>';
            }).join('') + '</div>'
          : '') +
        (canEdit
          ? '<div class="p86-wo-note-add">' +
              '<input type="text" class="p86-wo-note-in" placeholder="Add a note for this building…" maxlength="2000" />' +
              '<button type="button" class="ee-btn secondary p86-wo-note-go">Add note</button>' +
            '</div>'
          : '') +
      '</div>' +
    '</div>';
  }

  // Where the work is: job number and name, tap-to-navigate address, gate code.
  function siteHTML(site) {
    if (!site) return '';
    var addr = site.address || '';
    var lat = site.lat != null ? Number(site.lat) : NaN;
    var lng = site.lng != null ? Number(site.lng) : NaN;
    var addrHTML = addr
      ? ((window.p86MapLink && window.p86MapLink.linkHTML)
          ? window.p86MapLink.linkHTML(addr, addr, { lat: lat, lng: lng })
          : esc(addr))
      : '';
    var name = [site.job_number, site.name].filter(Boolean).join(' · ');
    if (!name && !addr && !site.gate_code) return '';
    return '<div class="p86-wo-site">' +
      (name ? '<div class="p86-wo-site-name">' + esc(name) + '</div>' : '') +
      '<div class="p86-wo-site-row">' +
        (addrHTML ? '<span class="p86-wo-site-addr">' + addrHTML + '</span>' : '') +
        (site.gate_code ? '<span class="p86-wo-gate">Gate <b>' + esc(site.gate_code) + '</b></span>' : '') +
      '</div>' +
    '</div>';
  }

  // Materials / takeoff — optional, and never priced. Quantities and units
  // only; a work order goes to the crew, so money has no place on it.
  function materialsHTML(t, canEdit) {
    var list = Array.isArray(t.materials) ? t.materials : [];
    // A file already on the crew link is shown to everyone who can see the
    // ticket, so a read-only viewer learns what the crew is looking at even
    // when the ticket carries no typed list.
    if (!list.length && !canEdit && !crewTakeoffOf(t)) return '';
    return '<div class="p86-wo-mats">' +
      '<label class="p86-st-lbl">Materials' +
        (canEdit ? ' <button type="button" class="p86-wo-mats-edit">' + (list.length ? 'Edit' : '+ Add list') + '</button>' : '') +
      '</label>' +
      (list.length
        ? '<table class="p86-wo-mats-tbl"><tbody>' + list.map(function (m) {
            return '<tr><td class="q">' + esc(m.qty || '') + '</td><td class="u">' + esc(m.unit || '') + '</td>' +
              '<td>' + esc(m.description || '') + '</td></tr>';
          }).join('') + '</tbody></table>'
        : (canEdit ? '<div class="p86-wo-nophotos">No material list. Add one if the takeoff should travel with the crew.</div>' : '')) +
      '<div class="p86-wo-mats-form" hidden></div>' +
      // Outside the editor form on purpose: choosing the crew-link file is its
      // own save, not part of Save materials, and it must not vanish when the
      // editor is cancelled.
      crewTakeoffHTML(t, canEdit) +
    '</div>';
  }

  // ── Takeoff on the crew link ─────────────────────────────────────────
  // The PM picks ONE file already on the job / lead / estimate for the crew
  // link to show. What is stored is a small record — attachment id, name,
  // kind and whether the file has price columns — never a URL: the crew opens
  // it through the share token, and the server re-proves the file belongs to
  // the ticket's parents every time. has_prices decides where it shows: a
  // spreadsheet with price columns only on links sent with financial details
  // (John's rule: no money on a work order), a clean one everywhere, and a PDF
  // or photo — which cannot be checked — everywhere, after the office is
  // warned.
  function crewTakeoffOf(t) {
    var ct = t && t.crew_takeoff;
    // JSONB arrives parsed from pg, but a text column in a test harness (or a
    // cached row) can hand back the string. Anything unreadable is "nothing
    // shown", which is also what the server does with it.
    if (typeof ct === 'string') { try { ct = JSON.parse(ct); } catch (_) { ct = null; } }
    return ct && typeof ct === 'object' && ct.attachment_id != null ? ct : null;
  }

  var CREW_STATUS = {
    priced: 'This file has price columns, so it only shows on crew links sent with financial details. ' +
      'Links that hide financials (the default) don\'t show it.',
    clean: 'The crew link shows this file.',
    unchecked: 'The crew link shows this whole file. PDFs and photos can\'t be checked for prices — make sure it has none.'
  };

  function crewTakeoffHTML(t, canEdit) {
    var ct = crewTakeoffOf(t);
    // Only a ticket with a parent has files to choose from — the same gate as
    // Fill from a job file. The server re-proves every parent regardless.
    if (!ct) {
      return (canEdit && (t.job_id || t.lead_id))
        ? '<div class="p86-wo-crew is-empty">' +
            '<button type="button" class="p86-wo-crew-pick">Show a takeoff file on the crew link</button>' +
          '</div>'
        : '';
    }
    var tone = ct.has_prices === true ? 'priced' : (ct.has_prices === false ? 'clean' : 'unchecked');
    return '<div class="p86-wo-crew is-' + tone + '">' +
      '<div class="p86-wo-crew-lbl">Takeoff on the crew link</div>' +
      '<div class="p86-wo-crew-file">' +
        '<span class="p86-wo-pick-kind k-' + esc(ct.kind || 'file') + '">' + esc(PICK_KIND[ct.kind] || 'File') + '</span>' +
        '<span class="p86-wo-crew-name">' + esc(ct.filename || 'Untitled file') + '</span>' +
        (canEdit
          ? '<span class="p86-wo-crew-acts">' +
              '<button type="button" class="p86-wo-crew-change">Change</button>' +
              '<button type="button" class="p86-wo-crew-remove">Remove</button>' +
            '</span>'
          : '') +
      '</div>' +
      '<div class="p86-wo-crew-status" role="note">' + esc(CREW_STATUS[tone]) + '</div>' +
    '</div>';
  }

  function materialRowHTML(m) {
    m = m || {};
    return '<div class="p86-wo-mat-row">' +
      '<input type="text" class="p86-wo-mat-q" placeholder="Qty" maxlength="24" value="' + escAttr(m.qty || '') + '" />' +
      '<input type="text" class="p86-wo-mat-u" placeholder="Unit" maxlength="24" value="' + escAttr(m.unit || '') + '" />' +
      '<input type="text" class="p86-wo-mat-d" placeholder="Material" maxlength="200" value="' + escAttr(m.description || '') + '" />' +
      '<button type="button" class="p86-st-part-rm p86-wo-mat-rm" title="Remove">&times;</button>' +
    '</div>';
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
      : (e.actor_kind === 'agent' ? '86' : (e.actor_kind === 'system' ? 'Project 86' : 'Office'));
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
      agent_drafted: 'drafted this with 86',
      subtask_completed: 'finished a subtask',
      subtask_reopened: 'reopened a subtask',
      subtask_note: 'added a subtask note'
    };
    // A column name reads as jargon on the timeline; the few that do not say
    // what they are get a plain name. The server logs names only, never the
    // file itself, so "which file" is in the Materials section, not here.
    var FIELD_LABEL = { crew_takeoff: 'the crew link takeoff' };
    var detail = e.detail;
    if (typeof detail === 'string') { try { detail = JSON.parse(detail); } catch (_) { detail = null; } }
    e = Object.assign({}, e, { detail: detail });
    var task = detail && detail.task_id != null ? _state.taskTitles[String(detail.task_id)] : '';
    var head = task ? esc(parseSubtaskTitle(task).head) : '';
    var ON_TASK = {
      subtask_completed: 'finished ' + head,
      subtask_reopened: 'reopened ' + head,
      subtask_note: 'added a note on ' + head
    };
    var what = e.kind === 'status_changed' && e.detail
      ? 'moved it to ' + esc(STATUS_LABEL[e.detail.to] || e.detail.to) +
        (e.detail.reason === 'all_subtasks_done' ? ' — every subtask done' : '')
      : e.kind === 'approval_notified' && e.detail && Array.isArray(e.detail.names) && e.detail.names.length
        ? 'told ' + esc(e.detail.names.join(', ')) + ' it is ready for approval'
      : e.kind === 'photo_added' && e.detail && e.detail.task_id != null
        ? 'added a ' + (e.detail.kind === 'before' ? 'before' : 'completion') + ' photo' + (head ? ' on ' + head : '')
      : (head && ON_TASK[e.kind])
        ? ON_TASK[e.kind]
      : e.kind === 'field_changed' && e.detail && e.detail.fields
        ? 'edited ' + esc((e.detail.fields || []).map(function (k) { return FIELD_LABEL[k] || k; }).join(', '))
        : esc(VERB[e.kind] || String(e.kind || '').replace(/_/g, ' '));
    return '<div class="p86-st-event' + (e.actor_kind === 'share' ? ' is-guest' : '') + '">' +
      '<span class="p86-st-event-who">' + who + '</span> ' +
      '<span class="p86-st-event-what">' + what + '</span> ' +
      '<span class="p86-st-event-when">' + esc(fmtDate(e.created_at)) + '</span>' +
    '</div>';
  }

  // Re-read just this ticket (photos and notes do not change the list row).
  function refreshDetail(d, id) {
    return api().get(id).then(function (r) {
      if (_state.openId !== id) return;
      paintDetail(d, r);
    });
  }

  function wireWorkOrder(d, t, tasks, canEdit) {
    var byId = {};
    tasks.forEach(function (k) { byId[String(k.id)] = k; });

    d.querySelectorAll('.p86-wo-sub').forEach(function (card) {
      var taskId = card.getAttribute('data-task');
      var task = byId[taskId] || {};
      var photos = task.photos || [];
      var body = card.querySelector('.p86-wo-sub-body');
      var toggle = card.querySelector('.p86-wo-sub-toggle');

      function setOpen(open) {
        if (!body) return;
        body.hidden = !open;
        card.classList.toggle('is-open', open);
        if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) _state.openSubs[taskId] = true; else delete _state.openSubs[taskId];
      }
      if (toggle) toggle.addEventListener('click', function () { setOpen(body.hidden); });

      card.querySelectorAll('.p86-wo-thumb').forEach(function (b) {
        b.addEventListener('click', function () {
          if (!window.p86Attachments || !window.p86Attachments.openLightbox) return;
          window.p86Attachments.openLightbox(photos, Number(b.getAttribute('data-idx')) || 0, {
            parentLabel: parseSubtaskTitle(task.title).head,
            parentSubtitle: t.title || ''
          });
        });
      });

      if (!canEdit) return;

      var check = card.querySelector('.p86-wo-check');
      if (check) check.addEventListener('click', function () {
        var done = task.status !== 'done';
        var hasCompletion = photos.some(function (p) { return p.kind !== 'before'; });
        if (done && !hasCompletion) {
          setOpen(true);
          toast('Add a completion photo before marking this complete.', 'error');
          return;
        }
        check.disabled = true;
        api().setSubtaskDone(t.id, taskId, done).then(function (res) {
          if (res && res.ticketStatus === 'work_complete' && t.status !== 'work_complete') {
            toast('Every subtask is done — the work order is awaiting approval.');
          }
          _state.openId = t.id;
          return reload();
        }).catch(function (e) {
          check.disabled = false;
          toast(e && e.message ? e.message : 'Could not update the subtask', 'error');
        });
      });

      card.querySelectorAll('.p86-wo-up input[type=file]').forEach(function (inp) {
        inp.addEventListener('change', function () {
          var files = Array.prototype.slice.call(inp.files || []);
          inp.value = '';
          if (!files.length || !window.p86Api || !window.p86Api.attachments) return;
          var kind = inp.getAttribute('data-kind') === 'before' ? 'before' : 'completion';
          var label = inp.parentNode;
          if (label) label.classList.add('is-busy');
          toast('Uploading ' + files.length + ' photo' + (files.length === 1 ? '' : 's') + '…');
          // One at a time: a crew phone on one bar of LTE should not open
          // six parallel uploads and lose all of them.
          files.reduce(function (p, f) {
            return p.then(function () {
              return window.p86Api.attachments.upload('task', taskId, f, { tags: kind });
            });
          }, Promise.resolve()).then(function () {
            _state.openSubs[taskId] = true;
            return refreshDetail(d, t.id);
          }).catch(function (e) {
            if (label) label.classList.remove('is-busy');
            toast(e && e.message ? e.message : 'Could not upload the photo', 'error');
            return refreshDetail(d, t.id);
          });
        });
      });

      var noteIn = card.querySelector('.p86-wo-note-in');
      var noteGo = card.querySelector('.p86-wo-note-go');
      function addNote() {
        var note = (noteIn && noteIn.value || '').trim();
        if (!note) return;
        noteGo.disabled = true;
        api().addSubtaskNote(t.id, taskId, note).then(function () {
          _state.openSubs[taskId] = true;
          return refreshDetail(d, t.id);
        }).catch(function (e) {
          noteGo.disabled = false;
          toast(e && e.message ? e.message : 'Could not add the note', 'error');
        });
      }
      if (noteGo) noteGo.addEventListener('click', addNote);
      if (noteIn) noteIn.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); addNote(); }
      });
    });

    // Materials editor: rows of qty / unit / material. No price column —
    // the server drops any key that is not one of those three anyway.
    var matsEdit = d.querySelector('.p86-wo-mats-edit');
    var matsForm = d.querySelector('.p86-wo-mats-form');
    if (matsEdit && matsForm) matsEdit.addEventListener('click', function () {
      if (!matsForm.hidden) { matsForm.hidden = true; matsForm.innerHTML = ''; return; }
      var list = Array.isArray(t.materials) && t.materials.length ? t.materials : [{}];
      matsForm.hidden = false;
      matsForm.innerHTML =
        '<div class="p86-wo-mat-rows">' + list.map(materialRowHTML).join('') + '</div>' +
        '<div class="p86-wo-mat-note" role="status" hidden></div>' +
        '<div class="p86-wo-mat-actions">' +
          '<button type="button" class="ee-btn secondary p86-wo-mat-add">+ Row</button>' +
          // Only a ticket with a parent has files to read. The server re-proves
          // every parent and every file; this only hides a button with nothing
          // behind it.
          ((t.job_id || t.lead_id)
            ? '<button type="button" class="ee-btn secondary p86-wo-mat-fill" ' +
                'title="Read the lines from a takeoff already in the job\'s files">Fill from a job file</button>'
            : '') +
          '<span style="flex:1"></span>' +
          '<button type="button" class="ee-btn secondary p86-wo-mat-cancel">Cancel</button>' +
          '<button type="button" class="ee-btn primary p86-wo-mat-save">Save materials</button>' +
        '</div>';
    });
    // Wired ONCE per paint, not inside the Edit handler above. It used to be
    // added on every open, so an editor closed and reopened answered each click
    // twice — two saves racing, one of them from the detached rows of the first
    // open, and (now) two pickers and two metered reads of the same file. The
    // rows container is looked up per click because each open rebuilds it.
    if (matsForm) matsForm.addEventListener('click', function (e) {
      var rows = matsForm.querySelector('.p86-wo-mat-rows');
      if (!rows) return;
      if (e.target.closest('.p86-wo-mat-fill')) { openTakeoffPicker(matsForm, t); return; }
      var rm = e.target.closest('.p86-wo-mat-rm');
      if (rm) { var row = rm.closest('.p86-wo-mat-row'); if (row) row.remove(); return; }
      if (e.target.closest('.p86-wo-mat-add')) {
        rows.insertAdjacentHTML('beforeend', materialRowHTML({}));
        var last = rows.lastElementChild;
        if (last) { var q = last.querySelector('.p86-wo-mat-d'); if (q) q.focus(); }
        return;
      }
      if (e.target.closest('.p86-wo-mat-cancel')) { matsForm.hidden = true; matsForm.innerHTML = ''; return; }
      var sv = e.target.closest('.p86-wo-mat-save');
      if (sv) {
        var next = [];
        rows.querySelectorAll('.p86-wo-mat-row').forEach(function (row) {
          var desc = row.querySelector('.p86-wo-mat-d').value.trim();
          if (!desc) return;
          next.push({
            description: desc,
            qty: row.querySelector('.p86-wo-mat-q').value.trim(),
            unit: row.querySelector('.p86-wo-mat-u').value.trim()
          });
        });
        sv.disabled = true;
        api().update(t.id, { materials: next.length ? next : null }).then(function () {
          toast('Materials saved');
          return refreshDetail(d, t.id);
        }).catch(function (err) {
          sv.disabled = false;
          toast(err && err.message ? err.message : 'Could not save the materials', 'error');
        });
      }
    });

    // Takeoff on the crew link. Delegated from the whole Materials section,
    // which outlives an in-place redraw of the crew row, and it catches the
    // "Also show this file on the crew link" button inside the editor's read
    // summary too — so the editor's own listener above stays exactly as it is
    // (a click on that button matches none of its branches and falls through).
    var mats = d.querySelector('.p86-wo-mats');
    if (mats && canEdit) mats.addEventListener('click', function (e) {
      if (e.target.closest('.p86-wo-crew-pick, .p86-wo-crew-change')) {
        if (matsForm) openTakeoffPicker(matsForm, t, { purpose: 'crew' });
        return;
      }
      var also = e.target.closest('.p86-wo-mat-crew');
      if (also) {
        if (also.disabled) return;
        also.disabled = true;
        chooseCrewTakeoff(d, t, {
          id: also.getAttribute('data-att'),
          kind: also.getAttribute('data-kind'),
          filename: also.getAttribute('data-name')
        }).then(function (saved) { if (!saved) also.disabled = false; });
        return;
      }
      var rm = e.target.closest('.p86-wo-crew-remove');
      if (rm) {
        if (rm.disabled) return;
        rm.disabled = true;
        // No confirm: removing only takes the file off the crew link, the file
        // itself stays in the job's Files, and Change puts it back in two taps.
        api().setCrewTakeoff(t.id, null).then(function (res) {
          toast('Takeoff removed from the crew link');
          return afterCrewTakeoff(d, t, res);
        }).catch(function (err) {
          rm.disabled = false;
          toast(err && err.message ? err.message : 'Could not remove the takeoff from the crew link', 'error');
        });
      }
    });
  }

  // ── Fill the materials editor from a job file ────────────────────────
  // The PM picks a takeoff already attached to the ticket's job, lead or
  // estimate; the server reads it and hands back { description, qty, unit }
  // lines. They land in the open editor UNSAVED — the PM reviews them and
  // presses Save materials, which is still the only write. Nothing here saves,
  // and nothing here ever holds a file URL: the list carries names and sizes.
  var PICK_WHERE = [
    { where: 'job', label: 'Job files' },
    { where: 'lead', label: 'Lead files' },
    { where: 'estimate', label: 'Estimate files' }
  ];
  var PICK_KIND = { xlsx: 'XLSX', xls: 'XLS', csv: 'CSV', pdf: 'PDF', image: 'Photo' };
  // The server's own caps (normalizeMaterials in server/services/
  // service-tickets.js). Mirrored so a filled editor never holds more than a
  // save would keep — the server would drop the excess without a word.
  var MAT_MAX_LINES = 100;
  var MAT_MAX = { description: 200, qty: 24, unit: 24 };

  // The close function of the picker on screen, if any. One at a time: a
  // second open replaces the first rather than stacking two backdrops.
  var _takeoffPick = null;

  function fmtBytes(n) {
    n = Number(n);
    if (!isFinite(n) || n < 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : (many || one + 's'));
  }

  // crewId: in crew mode, the attachment already on the crew link, so its row
  // says so. An .xls cannot be READ here (the parser takes .xlsx only), but the
  // crew can open one in whatever they have, so crew mode offers it.
  function pickRowHTML(f, idx, crew, crewId) {
    var legacy = f.kind === 'xls' && !crew;
    var current = crew && crewId != null && String(crewId) === String(f.id);
    var meta = [f.folder, fmtBytes(f.size_bytes), fmtDate(f.uploaded_at)].filter(Boolean).join(' · ');
    return '<button type="button" class="p86-wo-pick-row' + (legacy ? ' is-legacy' : '') +
        (current ? ' is-current' : '') + '" data-idx="' + idx + '"' +
        (legacy ? ' disabled' : '') + '>' +
      '<span class="p86-wo-pick-kind k-' + esc(f.kind) + '">' + esc(PICK_KIND[f.kind] || f.kind) + '</span>' +
      '<span class="p86-wo-pick-main">' +
        '<span class="p86-wo-pick-name">' + esc(f.filename || 'Untitled file') + '</span>' +
        '<span class="p86-wo-pick-meta">' +
          (legacy ? 'Save as .xlsx to read it' : esc(meta)) +
        '</span>' +
      '</span>' +
      '<span class="p86-wo-pick-state" aria-hidden="true">' + (current ? 'On the link' : '') + '</span>' +
    '</button>';
  }

  // opts.purpose === 'crew': the same list of files, but picking one puts it
  // on the crew link (PUT crew-takeoff) instead of reading its lines. Nothing
  // lands in the editor in that mode; the editor's repaint hold is still taken
  // while the picker is up so a background refresh cannot detach the ticket
  // the pick is about to save onto.
  function openTakeoffPicker(matsForm, t, opts) {
    var crew = !!(opts && opts.purpose === 'crew');
    if (!api() || typeof api().materialSources !== 'function' ||
        (crew && typeof api().setCrewTakeoff !== 'function')) {
      toast((crew ? 'Choosing a crew link file' : 'Reading a job file') +
        ' is not available on this page — refresh and try again.', 'error');
      return;
    }
    if (_takeoffPick) _takeoffPick();
    var crewNow = crew ? crewTakeoffOf(t) : null;
    var detail = matsForm.closest('.p86-st-detail');

    var wrap = document.createElement('div');
    wrap.id = 'p86StTakeoffPick';
    wrap.className = 'p86-st-modal-back';
    wrap.innerHTML =
      '<div class="p86-st-modal p86-wo-pick' + (crew ? ' is-crew' : '') + '" role="dialog" aria-modal="true" aria-labelledby="p86StTakeoffPickHead">' +
        '<div class="p86-st-modal-head" id="p86StTakeoffPickHead">' +
          (crew ? 'Show a takeoff on the crew link' : 'Pick a takeoff') + '</div>' +
        (crew
          ? '<div class="p86-wo-pick-note">The crew opens the file itself. Spreadsheets with price columns ' +
              'only show on links sent with financial details.</div>'
          : '<div class="p86-wo-pick-note">Spreadsheets are read directly. PDFs and photos are read by AI, ' +
              'so check every line. Prices are never copied.</div>') +
        '<div class="p86-wo-pick-err" role="alert" hidden></div>' +
        '<div class="p86-wo-pick-body"><div class="p86-st-loading">Looking for files…</div></div>' +
        '<div class="p86-st-modal-actions">' +
          '<button type="button" class="ee-btn secondary p86-wo-pick-cancel">Cancel</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(wrap);

    var closed = false;
    var busy = false;
    // True while the "Show the whole file?" question is up over the picker.
    // Escape belongs to that dialog then — it answers No, and must not also
    // close the list the PM is still choosing from.
    var asking = false;
    var files = [];
    var body = wrap.querySelector('.p86-wo-pick-body');
    var errEl = wrap.querySelector('.p86-wo-pick-err');

    // While the picker is up — and until the lines it read are in the editor —
    // the editor is held against a background repaint (see detailHoldsEdits).
    // The picker and the Replace / Add question both live outside the pane, so
    // neither holds the caret, and an AI read can run for most of a minute.
    matsForm.setAttribute('data-filling', '1');
    function release() {
      matsForm.removeAttribute('data-filling');
      // A refresh refused while the hold was on is retried now. If lines just
      // landed, the editor's unsaved values keep holding it.
      setTimeout(flushStale, 0);
    }

    function onKey(e) {
      if (e.key !== 'Escape' || asking) return;
      e.preventDefault();
      close();
    }
    // keepHold: the success path closes the picker but still has lines to put
    // in the editor, so it releases the hold itself once they are in.
    function close(keepHold) {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey);
      wrap.remove();
      if (_takeoffPick === close) _takeoffPick = null;
      if (keepHold !== true) release();
    }
    _takeoffPick = close;
    document.addEventListener('keydown', onKey);
    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
    wrap.querySelector('.p86-wo-pick-cancel').addEventListener('click', function () { close(); });

    function showErr(msg) {
      errEl.textContent = msg;
      errEl.hidden = !msg;
    }

    api().materialSources(t.id).then(function (r) {
      if (closed) return;
      files = (r && Array.isArray(r.files) ? r.files : []).filter(function (f) {
        return f && f.id != null && PICK_KIND[f.kind];
      });
      var html = '';
      PICK_WHERE.forEach(function (g) {
        var inGroup = [];
        files.forEach(function (f, i) {
          if (f.where === g.where) inGroup.push(pickRowHTML(f, i, crew, crewNow && crewNow.attachment_id));
        });
        if (!inGroup.length) return;
        html += '<div class="p86-wo-pick-group">' +
          '<div class="p86-st-lbl">' + esc(g.label) + '</div>' +
          inGroup.join('') +
        '</div>';
      });
      // A file with a `where` this list does not know is not shown rather than
      // guessed into a group, so an empty grouping is the empty state too.
      body.innerHTML = html || '<div class="p86-wo-pick-empty">No spreadsheets, PDFs or photos on this job yet. ' +
        'Add the takeoff to the job\'s Files, then come back.</div>';
      var first = body.querySelector('.p86-wo-pick-row:not([disabled])');
      if (first) first.focus();
    }).catch(function (e) {
      if (closed) return;
      body.innerHTML = '';
      showErr(e && e.message ? e.message : 'Could not list the files on this job.');
    });

    // One listener on the body, which outlives every repaint of the list.
    body.addEventListener('click', function (e) {
      var btn = e.target.closest('.p86-wo-pick-row');
      if (!btn || btn.disabled || busy) return;
      var f = files[Number(btn.getAttribute('data-idx'))];
      if (!f || (f.kind === 'xls' && !crew)) return;
      busy = true;
      showErr('');
      var allRows = body.querySelectorAll('.p86-wo-pick-row');
      Array.prototype.forEach.call(allRows, function (b) { b.disabled = true; });
      btn.classList.add('is-reading');
      btn.setAttribute('aria-busy', 'true');
      var state = btn.querySelector('.p86-wo-pick-state');
      var stateWas = state ? state.textContent : '';
      if (state && !crew) state.textContent = 'Reading…';

      function unlock() {
        busy = false;
        Array.prototype.forEach.call(allRows, function (b) {
          var ff = files[Number(b.getAttribute('data-idx'))];
          b.disabled = !ff || (ff.kind === 'xls' && !crew);
        });
        btn.classList.remove('is-reading');
        btn.removeAttribute('aria-busy');
        if (state) state.textContent = stateWas;
      }

      if (crew) {
        // A PDF or photo is asked about BEFORE anything is saved: the server
        // cannot look inside it for prices, so it would go out on every link.
        // The row reads "Saving…" only once the PM has said yes.
        asking = f.kind === 'pdf' || f.kind === 'image';
        confirmWholeFile(f).then(function (yes) {
          asking = false;
          if (closed) return;
          if (!yes) { unlock(); return; }
          if (state) state.textContent = 'Saving…';
          return api().setCrewTakeoff(t.id, f.id).then(function (res) {
            // Saved even if the picker was dismissed while the request ran —
            // the write happened, so the panel must show it either way.
            close();
            toast(crewSavedMessage(crewFromResponse(res)));
            return afterCrewTakeoff(detail, t, res);
          }, function (err) {
            if (closed) {
              toast(err && err.message ? err.message : 'Could not show that file on the crew link', 'error');
              return;
            }
            unlock();
            showErr((err && err.message) || 'Could not show that file on the crew link');
          });
        });
        return;
      }

      api().extractMaterials(t.id, f.id).then(function (res) {
        // Cancelled while it read: the PM said no, so nothing lands.
        if (closed) return;
        if (!res || res.ok === false || !usableLines(res).length) {
          unlock();
          showErr((res && res.error) || ('No material lines were found in ' + (f.filename || 'that file') + '.'));
          return;
        }
        close(true);
        return Promise.resolve().then(function () {
          return applyTakeoff(matsForm, t, f, res);
        }).catch(function (err) {
          try { console.error('[service-tickets] could not fill the materials editor:', err); } catch (_) {}
          toast('The lines were read but could not be put in the list — try again.', 'error');
        }).then(release);
      }).catch(function (err) {
        if (closed) return;
        unlock();
        showErr(err && err.status === 429
          ? '86 is busy — try again in a minute.'
          : (err && err.message) || 'Could not read materials from that file');
      });
    });
  }

  // The lines a save would keep: an object with a description. Anything else
  // would be dropped by normalizeMaterials, so it is not counted as read.
  function usableLines(res) {
    var list = res && Array.isArray(res.materials) ? res.materials : [];
    return list.filter(function (m) {
      return m && typeof m === 'object' && String(m.description == null ? '' : m.description).trim();
    });
  }

  // Put the read lines into the editor. Resolves once they are in (or the PM
  // backed out), so the caller can release the repaint hold after.
  function applyTakeoff(matsForm, t, f, res) {
    var filename = (res.source && res.source.filename) || f.filename || 'the file';
    // The ticket this editor belongs to must still be the one open, and the
    // editor must still be on the page — the PM can collapse the row or leave
    // the job while a file is being read.
    function stillHere() {
      return String(_state.openId) === String(t.id) && matsForm.isConnected && !matsForm.hidden &&
        !!matsForm.querySelector('.p86-wo-mat-rows');
    }
    if (!stillHere()) {
      toast('The ticket was closed before ' + filename + ' was read — nothing was added.');
      return Promise.resolve();
    }

    var lines = usableLines(res);
    var rows = matsForm.querySelector('.p86-wo-mat-rows');
    var described = Array.prototype.filter.call(rows.querySelectorAll('.p86-wo-mat-row'), function (row) {
      var dIn = row.querySelector('.p86-wo-mat-d');
      return dIn && dIn.value.trim();
    }).length;

    var ask = !described
      ? Promise.resolve('primary')
      : (typeof window.p86ConfirmTernary === 'function'
          ? window.p86ConfirmTernary({
              title: 'Add to the list or replace it?',
              message: 'The list already has ' + plural(described, 'line') + '. ' +
                plural(lines.length, 'line') + (lines.length === 1 ? ' was' : ' were') + ' read from ' + filename + '.',
              primaryLabel: 'Replace',
              secondaryLabel: 'Add to it',
              cancelLabel: 'Cancel'
            })
          // No dialog helper loaded: add, never replace. Appending cannot
          // lose a line the PM typed; replacing without asking could.
          : Promise.resolve('secondary'));

    return Promise.resolve(ask).then(function (choice) {
      if (choice !== 'primary' && choice !== 'secondary') return;
      if (!stillHere()) {
        toast('The ticket was closed before the lines were added — nothing was added.');
        return;
      }
      rows = matsForm.querySelector('.p86-wo-mat-rows');
      Array.prototype.forEach.call(rows.querySelectorAll('.p86-wo-mat-row'), function (row) {
        if (choice === 'primary') { row.remove(); return; }
        // Adding: a row with nothing in it is the editor's blank starter row,
        // not a line — the read lines follow the real ones, not a gap.
        var empty = Array.prototype.every.call(row.querySelectorAll('input'), function (i) { return !i.value.trim(); });
        if (empty) row.remove();
      });

      var room = Math.max(0, MAT_MAX_LINES - rows.querySelectorAll('.p86-wo-mat-row').length);
      var put = lines.slice(0, room);
      put.forEach(function (m) {
        // Built empty, then filled through .value, so every field differs from
        // its markup default — the background-refresh guard reads that as
        // unsaved and leaves the editor alone until the PM saves or cancels.
        rows.insertAdjacentHTML('beforeend', materialRowHTML({}));
        var row = rows.lastElementChild;
        row.querySelector('.p86-wo-mat-q').value = String(m.qty == null ? '' : m.qty).trim().slice(0, MAT_MAX.qty);
        row.querySelector('.p86-wo-mat-u').value = String(m.unit == null ? '' : m.unit).trim().slice(0, MAT_MAX.unit);
        row.querySelector('.p86-wo-mat-d').value = String(m.description).trim().slice(0, MAT_MAX.description);
      });
      if (!rows.querySelector('.p86-wo-mat-row')) rows.insertAdjacentHTML('beforeend', materialRowHTML({}));

      var note = matsForm.querySelector('.p86-wo-mat-note');
      if (note) {
        note.innerHTML = takeoffNoteHTML(res, filename, put.length, lines.length - put.length);
        // The file just read is usually the one the crew should see too, so
        // offer it here rather than send the PM back through the picker. The
        // editor only exists for someone who can edit this ticket (canEdit),
        // and the button is left off when that file is already on the link.
        var onLink = crewTakeoffOf(t);
        if (f && f.id != null && PICK_KIND[f.kind] && api() && typeof api().setCrewTakeoff === 'function' &&
            !(onLink && String(onLink.attachment_id) === String(f.id))) {
          note.insertAdjacentHTML('beforeend',
            ' <button type="button" class="p86-wo-mat-crew" data-att="' + escAttr(f.id) + '" data-kind="' +
              escAttr(f.kind) + '" data-name="' + escAttr(filename) + '">Also show this file on the crew link</button>');
        }
        note.classList.toggle('is-ai', /^ai-/.test(String(res.method || '')));
        note.hidden = false;
      }
    });
  }

  // "12 lines read from Lead Report.xlsx (Lead Report); skipped 6 labor lines…"
  // in plain words, then every warning, then what to do next. Server text is
  // escaped like any other — a file name is whatever the uploader typed.
  function takeoffNoteHTML(res, filename, added, didNotFit) {
    var c = (res && res.counts) || {};
    var sk = c.skipped || {};
    var sheet = res.source && res.source.sheet;
    var skipped = [];
    if (Number(sk.labor) > 0) skipped.push(plural(Number(sk.labor), 'labor line'));
    if (Number(sk.totals) > 0) skipped.push(plural(Number(sk.totals), 'subtotal row'));
    if (Number(sk.zero_qty) > 0) skipped.push(plural(Number(sk.zero_qty), 'removed line') + ' (qty 0)');

    var head = plural(added, 'line') + ' read from ' + filename + (sheet ? ' (' + sheet + ')' : '') +
      (skipped.length ? '; skipped ' + skipped.join(', ') : '') + '.';

    var warnings = [];
    function warn(s) { if (s && warnings.indexOf(s) === -1) warnings.push(String(s)); }
    if (/^ai-/.test(String(res.method || ''))) warn('Read by AI — check every quantity before saving.');
    (Array.isArray(res.warnings) ? res.warnings : []).forEach(warn);
    if (Number(c.over_cap) > 0) warn('Only the first 100 lines fit — the rest were left out.');
    if (didNotFit > 0) {
      warn('The list holds ' + MAT_MAX_LINES + ' lines, so ' + plural(didNotFit, 'read line') + ' did not fit.');
    }

    return '<span class="p86-wo-mat-note-head">' + esc(head) + '</span>' +
      warnings.map(function (w) { return ' <span class="p86-wo-mat-note-warn">' + esc(w) + '</span>'; }).join('') +
      ' <span class="p86-wo-mat-note-next">Review, then Save materials.</span>';
  }

  // The one question before a file nobody can check goes to the crew. A
  // spreadsheet or CSV is checked by the server for price columns; a PDF or a
  // photo cannot be, so it would show on every link, including the ones that
  // hide financials. Resolves true to go ahead. Never rejects.
  function confirmWholeFile(f) {
    if (!f || (f.kind !== 'pdf' && f.kind !== 'image')) return Promise.resolve(true);
    if (typeof window.p86Confirm !== 'function') {
      // No dialog helper loaded: refuse rather than send an unchecked file
      // without the warning — the warning is the whole point of this step.
      // Never native confirm(), which no-ops inside the installed PWA.
      toast('Could not ask before showing that file — refresh and try again.', 'error');
      return Promise.resolve(false);
    }
    return Promise.resolve(window.p86Confirm({
      title: 'Show the whole file to the crew?',
      message: 'PDFs and photos can\'t be checked for prices. The crew will see everything in this file.',
      confirmText: 'Show it'
    })).then(function (yes) { return yes === true; }, function () { return false; });
  }

  // PUT crew-takeoff answers { ok, ticket, crew_takeoff }. crew_takeoff is the
  // stored record (null when cleared); the ticket row carries the same value.
  function crewFromResponse(res) {
    if (res && Object.prototype.hasOwnProperty.call(res, 'crew_takeoff')) return crewTakeoffOf({ crew_takeoff: res.crew_takeoff });
    return crewTakeoffOf(res && res.ticket);
  }

  function crewSavedMessage(ct) {
    return ct && ct.has_prices === true
      ? 'Saved — it shows only on links sent with financial details'
      : 'Takeoff shown on the crew link';
  }

  // The "Also show this file on the crew link" path, outside the picker.
  // Resolves true once the file is on the link; failures are toasted.
  function chooseCrewTakeoff(d, t, f) {
    return confirmWholeFile(f).then(function (yes) {
      if (!yes) return false;
      return api().setCrewTakeoff(t.id, f.id).then(function (res) {
        toast(crewSavedMessage(crewFromResponse(res)));
        return Promise.resolve(afterCrewTakeoff(d, t, res)).then(function () { return true; });
      }, function (err) {
        toast(err && err.message ? err.message : 'Could not show that file on the crew link', 'error');
        return false;
      });
    });
  }

  // Show the new crew-link file. Normally a plain re-read of the ticket. But
  // the "Also show" button sits right under lines just read into the editor
  // and not yet saved, and a repaint rebuilds the editor from the server row —
  // those lines would be gone. So when the open ticket holds edits (the same
  // rule the background refresh obeys), only the crew row is redrawn in place.
  function afterCrewTakeoff(d, t, res) {
    t.crew_takeoff = crewFromResponse(res);
    if (!d) return Promise.resolve();
    var row = d.closest('.p86-st-row');
    if (row && row.parentNode && detailHoldsEdits(row.parentNode)) {
      var old = d.querySelector('.p86-wo-crew');
      // Only an editor reaches this, so the row is drawn with its controls.
      if (old) old.outerHTML = crewTakeoffHTML(t, true);
      var ct = t.crew_takeoff;
      Array.prototype.forEach.call(d.querySelectorAll('.p86-wo-mat-crew'), function (b) {
        if (ct && String(b.getAttribute('data-att')) === String(ct.attachment_id)) b.remove();
      });
      return Promise.resolve();
    }
    return refreshDetail(d, t.id).catch(function () {
      toast('Saved, but the ticket could not be reloaded — collapse and reopen it to see the change.', 'error');
    });
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

    var ask86 = d.querySelector('.p86-st-ask86');
    if (ask86) ask86.addEventListener('click', function () { askAboutTicket(t); });

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
            '<strong>Can suggest changes</strong> adds a form to rewrite the scope, but what ' +
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
  var _leadPanel = { host: null, leadId: null, lead: null };

  function mountLeadPanel(host, leadId, lead) {
    if (!host || !leadId) return;
    // createForLead remounts with no lead object; keep the one we were given
    // for the same lead rather than forgetting its name.
    if (lead) _leadPanel.lead = lead;
    else if (String(_leadPanel.leadId) !== String(leadId)) _leadPanel.lead = null;
    _leadPanel.host = host;
    _leadPanel.leadId = leadId;
    if (!api()) {
      host.innerHTML = '<div class="p86-st-lead-empty">Service tickets module unavailable.</div>';
      return;
    }
    host.innerHTML = '<div class="p86-st-lead-empty">Loading…</div>';
    return loadLeadPanel(host, leadId, false);
  }

  // `quiet` is the refresh path. A data-changed repaint must not blank a list
  // the PM is already reading to "Loading…", and a failed background refetch
  // must not replace that list with an error they did not ask for — the rows
  // on screen stay, and the next mount or refresh tries again.
  function loadLeadPanel(host, leadId, quiet) {
    return api().list({ lead_id: leadId }).then(function (r) {
      // The panel may have been remounted onto a different lead while this
      // was in flight.
      if (_leadPanel.leadId !== leadId || _leadPanel.host !== host) return;
      var list = (r && r.tickets) || [];
      host.innerHTML = leadBarHTML() + (list.length
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
        : '<div class="p86-st-lead-empty">No service tickets on this lead.</div>');
      wireLeadPanel(host, leadId);
    }).catch(function (e) {
      if (_leadPanel.leadId !== leadId) return;
      if (quiet) {
        try { console.warn('[service-tickets] lead panel refresh failed:', e); } catch (_) {}
        return;
      }
      host.innerHTML = '<div class="p86-st-lead-empty" style="color:#f87171;">' +
        esc(e && e.message ? e.message : 'Failed to load') + '</div>';
    });
  }

  function leadBarHTML() {
    if (!canEditLead() || !aiAsk()) return '';
    return '<div class="p86-st-lead-bar" style="display:flex;justify-content:flex-end;margin-bottom:6px;">' +
      '<button class="ee-btn secondary p86-st-draft86" title="86 drafts the ticket, scope and tasks for your approval">Draft with 86</button>' +
    '</div>';
  }

  function wireLeadPanel(host, leadId) {
    var b = host.querySelector('.p86-st-draft86');
    if (b) b.addEventListener('click', function () { draftForLead(leadId, _leadPanel.lead); });
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
    // Any refetch issued now is newer than the write a deferred refresh was
    // waiting to show, so it satisfies that refresh too.
    _state.stale = false;
    return api().list({ job_id: _state.jobId }).then(function (r) {
      _state.tickets = (r && r.tickets) || [];
      // The approval email and push link here as ?ticket=<id>: open that ticket
      // once — and only if it IS one of this job's tickets, so a value from the
      // URL never reaches a selector. Consumed either way.
      if (_deepTicket) {
        var want = _deepTicket;
        _deepTicket = null;
        if (_state.tickets.some(function (t) { return String(t.id) === want; })) _state.openId = want;
      }
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

  // ── Refresh seam ─────────────────────────────────────────────────────
  // Called by js/refresh.js (the `service_ticket` entry) after an agent write
  // lands, with no arguments: it does not know which job or lead the ticket
  // hangs off, and does not need to. It repaints whichever surface is MOUNTED.
  //
  // It used to be job-only — reload() returns early without a job in view — so
  // a ticket 86 drafted on a LEAD landed in Postgres while the lead panel kept
  // saying "No service tickets on this lead." Both surfaces are checked
  // independently; a lead that has converted shows the same ticket on both,
  // and both repaint.
  function jobPaneInView() {
    if (!_state.jobId || !pane()) return false;
    // _state.jobId outlives the job page: leaving a job does not clear it, so
    // on its own it would refetch a job nobody is looking at. The job on screen
    // is the one appState names.
    var cur = window.appState && window.appState.currentJobId;
    return cur != null && String(cur) === String(_state.jobId);
  }

  function leadPanelMounted() {
    var h = _leadPanel.host;
    return !!(h && _leadPanel.leadId && h.isConnected);
  }

  function holdsCaret(el) {
    try {
      var ae = document.activeElement;
      if (!ae || !el || !el.contains(ae)) return false;
      var tag = ae.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!ae.isContentEditable;
    } catch (e) { return false; }
  }

  // An open work order holds edits in two ways, and either one must stop a
  // repaint: the caret is in it, OR a field was changed and the PM moved on to
  // another field without pressing Save. The second is the one a focus check
  // misses — paintDetail rebuilds every field from the server row, so a scope
  // typed, blurred and not yet saved would silently revert under a background
  // refresh. The markup's own defaults ARE the server row, so "differs from its
  // default" is exactly "unsaved".
  function detailHoldsEdits(host) {
    var open = host && host.querySelector('.p86-st-row.is-open');
    if (!open) return false;
    if (holdsCaret(open)) return true;
    // A share link minted in this row is held too, though it is no edit: it is
    // shown once and the server keeps only its hash. Its input is readonly, so
    // the value scan below skips it, and the Copy button takes no caret — the
    // focusout from that very click would flush the latch, paint() would
    // rebuild the row, and the link the note says "cannot be shown again" would
    // be gone before it was pasted anywhere. Collapsing the row (or closing the
    // share panel) clears it and releases the refresh.
    var minted = open.querySelector('.p86-st-share-out input');
    if (minted && minted.value) return true;
    // A job file being read into the materials editor holds it as well. The
    // picker and the Replace / Add question sit outside the pane and take no
    // caret here, the editor is not dirty until the lines land, and an AI read
    // can take most of a minute — a repaint inside that window would rebuild
    // the editor and the lines would arrive with nowhere to go. The picker
    // clears the mark when it is done and retries the latch.
    if (open.querySelector('.p86-wo-mats-form[data-filling]')) return true;
    var fields = open.querySelectorAll('input, textarea, select');
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (f.readOnly || f.disabled) continue;
      if (f.type === 'checkbox' || f.type === 'radio') {
        if (f.checked !== f.defaultChecked) return true;
      } else if (f.tagName === 'SELECT') {
        // A select with no `selected` attribute defaults to its FIRST option;
        // comparing per-option defaultSelected would call every such select
        // (Move to…, the participant picker) dirty from the moment it renders.
        var def = 0;
        for (var j = 0; j < f.options.length; j++) { if (f.options[j].defaultSelected) { def = j; break; } }
        if (f.selectedIndex !== def) return true;
      } else if (f.value !== f.defaultValue) {
        return true;
      }
    }
    return false;
  }

  // The "needs repaint" latch. A refresh refused because of the rule above is
  // remembered, not dropped — dropping it trades one repaint for a permanently
  // stale list (the rule js/refresh.js states for every guarded surface). It is
  // retried when focus leaves the pane or the ticket is collapsed, and any
  // reload() satisfies it.
  function flushStale() {
    if (!_state.stale || _state.busy || !jobPaneInView()) return;
    if (detailHoldsEdits(pane())) return;
    reload();
  }

  var _latchHost = null;
  function wireLatch(host) {
    if (!host || _latchHost === host) return;
    _latchHost = host;
    host.addEventListener('focusout', function () { setTimeout(flushStale, 0); });
  }

  function refresh() {
    var work = [];
    if (jobPaneInView()) {
      var host = pane();
      wireLatch(host);
      if (_state.busy || detailHoldsEdits(host)) _state.stale = true;
      else work.push(reload());
    }
    if (leadPanelMounted() && api()) {
      work.push(loadLeadPanel(_leadPanel.host, _leadPanel.leadId, true));
    }
    return Promise.all(work);
  }

  window.p86ServiceTickets = {
    // The lead surfaces (js/leads.js calls both).
    mountLeadPanel: mountLeadPanel,
    createForLead: createForLead,
    refresh: refresh
  };
})();
