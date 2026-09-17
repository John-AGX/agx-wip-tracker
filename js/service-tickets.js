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
//
// 1.29 (Work Orders) keeps the PM's typing: an open ticket updates in place
// (sections and building cards are swapped only when they change), Save sends
// only the fields that changed with what they were when loaded, and anything
// that would redraw the fields asks "Save your changes first?" first. Other
// office modules add to this screen through window.p86StExt
// (js/service-ticket-ext.js) instead of being called from here.
// ============================================================
(function () {
  'use strict';

  // Windows has no camera behind a file input: capture="environment" is
  // ignored there. A 2-in-1 folded into a tablet reports a finger as its
  // pointer, which would show Take photo buttons that only open the file
  // dialog, so the page is marked and styles.css hides them. Only a
  // tablet-sized screen counts: a phone browser asked for the desktop site
  // can send a Windows user agent, and a phone must keep its camera.
  try {
    if (/Windows NT/.test(navigator.userAgent) && Math.min(screen.width || 0, screen.height || 0) >= 600) document.documentElement.classList.add('p86-no-capture');
  } catch (e) { /* no navigator: nothing to mark */ }

  // One open ticket at a time, keyed by job. Module-level so a repaint that
  // arrives while a ticket is expanded can restore it.
  // `stale` is the deferred-refresh latch; see refresh() at the bottom.
  // `listedJob` is the job whose list `tickets` holds (null while one loads).
  var _state = { jobId: null, filter: 'all', openId: null, tickets: [], listedJob: null, busy: false, stale: false, openSubs: {}, taskTitles: {}, drafts: {}, scrollToOpen: false };
  // A ticket to open once its job's list loads: { jobId, ticketId }. The one
  // read from the URL at load (before the router rewrites it without its
  // query) names no job and goes to the first list loaded; one from
  // openTicket() is for its own job only.
  var _deepTicket = (function () {
    try {
      var id = new URLSearchParams(location.search).get('ticket');
      return id ? { jobId: null, ticketId: id } : null;
    } catch (_) { return null; }
  })();

  function deepFor(jobId) {
    return !!_deepTicket && (_deepTicket.jobId == null || String(_deepTicket.jobId) === String(jobId));
  }

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

  // ── 1.29 host seams ──────────────────────────────────────────────────
  // The field editor kit (js/service-ticket-editor.js) and the extension
  // registry (js/service-ticket-ext.js) are looked up at call time, like the
  // AI panel. With no editor kit the ticket FIELDS render read-only (building
  // cards, photos and materials still work); with no registry there are
  // simply no extensions.
  function editor() {
    var e = window.p86StEditor;
    return (e && typeof e.dirtyKeys === 'function' && typeof e.swapSection === 'function') ? e : null;
  }

  function ext() {
    var x = window.p86StExt;
    return (x && typeof x.collect === 'function') ? x : null;
  }

  function extCollect() {
    var x = ext();
    if (!x) return [];
    try { return x.collect.apply(x, arguments) || []; } catch (e) { return []; }
  }

  function extFirst() {
    var x = ext();
    if (!x || typeof x.first !== 'function') return undefined;
    try { return x.first.apply(x, arguments); } catch (e) { return undefined; }
  }

  function extHtml() {
    var x = ext();
    if (!x || typeof x.html !== 'function') return '';
    try {
      var s = x.html.apply(x, arguments);
      return typeof s === 'string' ? s : '';
    } catch (e) { return ''; }
  }

  function currentUserId() {
    try {
      var a = window.p86Auth;
      var u = a && typeof a.getUser === 'function' ? a.getUser() : null;
      return u && u.id != null ? u.id : null;
    } catch (e) { return null; }
  }

  function noop() {}

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
  // that still needs someone to do something. 'mine' is what is assigned to
  // the person looking, still open.
  var FILTERS = [
    { id: 'all', label: 'All' },
    { id: 'active', label: 'Active' },
    { id: 'mine', label: 'Mine' },
    { id: 'draft', label: 'Draft' },
    { id: 'scheduled', label: 'Scheduled' },
    { id: 'in_progress', label: 'In progress' },
    { id: 'work_complete', label: 'Awaiting approval' },
    { id: 'closed', label: 'Closed' }
  ];
  var PRIORITY_LABEL = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };
  var STALE = 'This work order just changed. Reload to see the latest.';

  function matchesFilter(t) {
    var f = _state.filter;
    if (f === 'all') return true;
    if (f === 'active') return ['open', 'scheduled', 'in_progress', 'work_complete'].indexOf(t.status) >= 0;
    if (f === 'mine') {
      var me = currentUserId();
      return me != null && t.assignee_user_id != null && String(t.assignee_user_id) === String(me) &&
        t.status !== 'closed' && t.status !== 'cancelled';
    }
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

  // An INSTANT for reading: 'Sep 14, 3:05 PM', with the year only when it is
  // not this one. A building note carries a timestamp, never a calendar day,
  // so it is shown in the reader's own zone with its time.
  function fmtWhen(v) {
    if (!v) return '';
    var d = new Date(v);
    if (isNaN(d.getTime())) return '';
    var o = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
    if (d.getFullYear() !== new Date().getFullYear()) o.year = 'numeric';
    return d.toLocaleString(undefined, o);
  }

  function pane() { return document.getElementById('job-service-tickets'); }

  function toast(msg, kind) {
    if (window.p86Toast) { try { window.p86Toast(msg, kind); return; } catch (e) { /* fall through */ } }
    if (kind === 'error') console.error('[service-tickets] ' + msg);
  }

  // ── Paint ────────────────────────────────────────────────────────────
  function listCtx() {
    return { jobId: _state.jobId, leadId: null, tickets: _state.tickets, filter: _state.filter };
  }

  function pillCount(id) {
    var save = _state.filter;
    _state.filter = id;
    try {
      return _state.tickets.filter(matchesFilter).length;
    } finally {
      _state.filter = save;
    }
  }

  function pillInnerHTML(f) {
    var n = pillCount(f.id);
    return esc(f.label) + (n ? ' <span class="p86-st-pill-n">' + n + '</span>' : '');
  }

  // The open work order, carried across a list rebuild: the node itself, with
  // its listeners and whatever is typed in it, instead of a fresh "Loading…"
  // and a rebuild from the server row.
  function keptDetail(host) {
    if (!_state.openId) return null;
    var row = host.querySelector('.p86-st-row.is-open');
    if (!row || row.getAttribute('data-ticket') !== String(_state.openId)) return null;
    var d = row.querySelector('.p86-st-detail');
    return (d && d._st && d._st.painted) ? d : null;
  }

  function paint() {
    var host = pane();
    if (!host) return;
    var canEdit = canEditJob(_state.jobId);
    var shown = _state.tickets.filter(matchesFilter);

    var pills = FILTERS.map(function (f) {
      return '<button class="p86-st-pill' + (_state.filter === f.id ? ' active' : '') +
        '" data-filter="' + escAttr(f.id) + '">' + pillInnerHTML(f) + '</button>';
    }).join('');

    var kept = keptDetail(host);

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
      if (openRow) {
        var fresh = openRow.querySelector('.p86-st-detail');
        if (kept && fresh) {
          openRow.replaceChild(kept, fresh);
          openRow.classList.add('is-open');
          kept.hidden = false;
          updateDetail(kept, _state.openId).catch(function (e) {
            try { console.warn('[service-tickets] ticket refresh failed:', e); } catch (_) {}
          });
        } else {
          expand(openRow, _state.openId);
        }
        if (_state.scrollToOpen) {
          _state.scrollToOpen = false;
          if (typeof openRow.scrollIntoView === 'function') {
            try { openRow.scrollIntoView({ block: 'start' }); } catch (e) { /* old engine */ }
          }
        }
      }
    }
    fillWhoChips(host);
    extCollect('onListPainted', host, listCtx());
  }

  function rowHTML(t) {
    return '<div class="p86-st-row" data-ticket="' + escAttr(t.id) + '">' +
      '<div class="p86-st-row-head">' + rowHeadInnerHTML(t) + '</div>' +
      '<div class="p86-st-detail" hidden></div>' +
    '</div>';
  }

  function rowHeadInnerHTML(t) {
    var total = Number(t.task_total || 0);
    var done = Number(t.task_done || 0);
    return '<span class="p86-st-prio prio-' + esc(t.priority || 'normal') + '" ' +
        'title="' + escAttr(PRIORITY_LABEL[t.priority] || 'Normal') + ' priority"></span>' +
      (t.ticket_number ? '<span class="p86-st-num">' + esc(t.ticket_number) + '</span>' : '') +
      '<span class="p86-st-title">' + esc(t.title || 'Untitled ticket') + '</span>' +
      '<span class="p86-st-status st-' + esc(t.status) + '">' + esc(STATUS_LABEL[t.status] || t.status) + '</span>' +
      extHtml('rowBadges', t, listCtx()) +
      whoChipHTML(t) +
      (total ? '<span class="p86-st-tasks">' + done + '/' + total + '</span>' : '') +
      (t.scheduled_for ? '<span class="p86-st-when">' + esc(fmtDate(t.scheduled_for)) + '</span>' : '');
  }

  // Who it is assigned to, as initials. The name comes from the list row when
  // the server sends one, otherwise from the staff directory, filled in when
  // that answers.
  function whoChipHTML(t) {
    var ed = editor();
    if (!ed || t.assignee_user_id == null || t.assignee_user_id === '') return '';
    var name = String(t.assignee_name || '').trim() || ed.nameOf(t.assignee_user_id);
    return '<span class="p86-st-who" data-user="' + escAttr(t.assignee_user_id) + '"' +
      (name ? ' title="' + escAttr('Assigned to ' + name) + '"' : ' data-st-pending="1"') + '>' +
      esc(name ? ed.initials(name) : '') + '</span>';
  }

  function fillWhoChips(root) {
    var ed = editor();
    if (!ed || !root || !root.querySelector('.p86-st-who[data-st-pending]')) return;
    Promise.resolve(ed.directory()).then(function () {
      Array.prototype.forEach.call(root.querySelectorAll('.p86-st-who[data-st-pending]'), function (chip) {
        var name = ed.nameOf(chip.getAttribute('data-user'));
        chip.removeAttribute('data-st-pending');
        chip.textContent = name ? ed.initials(name) : '?';
        chip.setAttribute('title', name ? 'Assigned to ' + name : 'Assigned');
      });
    }).catch(noop);
  }

  function ticketRow(id) {
    for (var i = 0; i < _state.tickets.length; i++) {
      if (String(_state.tickets[i].id) === String(id)) return _state.tickets[i];
    }
    return null;
  }

  // Rows of a detail sub-read that are in one state. Not an array (a sub-read
  // that failed, or a caller that sent none) counts as none.
  function countInState(rows, status) {
    if (!Array.isArray(rows)) return 0;
    return rows.filter(function (x) { return x && x.status === status; }).length;
  }

  // The job's Service Tickets chip counts the rows this screen holds, so it
  // follows them whenever they are corrected in place.
  function fillJobChipFromRows() {
    if (_state.jobId == null || _state.jobId === '') return;
    var flags = window.p86TicketFlags;
    if (!flags || typeof flags.fillJobChip !== 'function') return;
    try { flags.fillJobChip(_state.jobId, _state.tickets); } catch (e) { /* the chip is a nicety */ }
  }

  // After an in-place update: the row head and the pill counts follow the
  // ticket, without rebuilding the list (and the open ticket under it). `r` is
  // the detail read the update was made from.
  //
  // The attention counters (open_flags, pending_suggestions, co_draft_count)
  // are added by the LIST route only — the detail read's ticket carries none of
  // them — so merging it would leave the badge above the panel saying a
  // suggestion is still waiting after it was accepted, or a problem still open
  // after it was resolved. They are recomputed here from the read's own rows.
  // What that costs: the detail's revisions come back LIMIT 50 and its flags
  // are capped at the office list limit (open ones sort first, so the open
  // count is exact below the cap), and flags and change orders are best-effort
  // sub-reads that arrive as [] when they fail — so a failed sub-read zeroes
  // the badge, which is exactly what the empty panel drawn beside it says.
  // new_from_crew is left to markSeen.
  function patchRowHead(d, t, r) {
    var read = (r && typeof r === 'object') ? r : {};
    var progress = read.progress;
    var row = d.closest('.p86-st-row');
    var entry = ticketRow(t.id);
    if (entry) {
      Object.assign(entry, t);
      if (progress && typeof progress === 'object') {
        if (progress.tasksTotal != null) entry.task_total = progress.tasksTotal;
        if (progress.tasksDone != null) entry.task_done = progress.tasksDone;
      }
      entry.pending_suggestions = countInState(read.revisions, 'pending');
      entry.open_flags = countInState(read.flags, 'open');
      entry.co_draft_count = countInState(read.change_orders, 'draft');
    }
    var head = row && row.querySelector('.p86-st-row-head');
    if (head) {
      var html = rowHeadInnerHTML(entry || t);
      if (head._stHtml !== html) { head.innerHTML = html; head._stHtml = html; }
      fillWhoChips(head);
    }
    if (entry) fillJobChipFromRows();
    var host = pane();
    if (!host) return;
    Array.prototype.forEach.call(host.querySelectorAll('.p86-st-pill'), function (b) {
      var id = b.getAttribute('data-filter');
      var f = FILTERS.filter(function (x) { return x.id === id; })[0];
      if (!f) return;
      var inner = pillInnerHTML(f);
      if (b._stHtml !== inner) { b.innerHTML = inner; b._stHtml = inner; }
    });
  }

  function wire(host) {
    host.querySelectorAll('.p86-st-pill').forEach(function (b) {
      b.addEventListener('click', function () {
        var want = b.getAttribute('data-filter');
        leaveOpenTicket().then(function (go) {
          if (!go) return;
          _state.filter = want;
          paint();
        });
      });
    });
    var nb = host.querySelector('.p86-st-new');
    if (nb) nb.addEventListener('click', function () {
      leaveOpenTicket().then(function (go) { if (go) openCreate(); });
    });
    var d86 = host.querySelector('.p86-st-draft86');
    if (d86) d86.addEventListener('click', function () { draftForJob(_state.jobId); });

    host.querySelectorAll('.p86-st-row-head').forEach(function (h) {
      h.addEventListener('click', function () {
        var row = h.closest('.p86-st-row');
        var id = row && row.getAttribute('data-ticket');
        if (!id) return;
        // Collapsing or opening another ticket redraws the fields, so typed
        // changes are asked about first.
        leaveOpenTicket().then(function (go) {
          if (!go) return;
          if (_state.openId === id) { collapse(row); _state.openId = null; flushStale(); return; }
          // Only one expanded at a time — a work order is read one at a time.
          host.querySelectorAll('.p86-st-row').forEach(collapse);
          _state.openId = id;
          expand(row, id);
        });
      });
    });
  }

  function collapse(row) {
    row.classList.remove('is-open');
    var d = row.querySelector('.p86-st-detail');
    if (d) {
      d.hidden = true;
      d.innerHTML = '';
      if (d._st) d._st.painted = false;
    }
  }

  // ── Expanded detail ──────────────────────────────────────────────────
  function expand(row, id) {
    row.classList.add('is-open');
    var d = row.querySelector('.p86-st-detail');
    if (!d) return;
    d.hidden = false;
    if (d._st) d._st.painted = false;
    d.innerHTML = '<div class="p86-st-loading">Loading…</div>';
    if (!api()) { d.innerHTML = '<div class="p86-st-loading">Service tickets are unavailable.</div>'; return; }

    api().get(id).then(function (r) {
      // The user may have collapsed or switched rows while this was in flight.
      if (_state.openId !== id || !d.isConnected) return;
      paintDetail(d, r);
      extCollect('onRowExpanded', row, ticketRow(id) || (r && r.ticket) || null, r, listCtx());
    }).catch(function (e) {
      if (_state.openId !== id) return;
      d.innerHTML = '<div class="p86-st-loading" style="color:#f87171;">' +
        esc(e && e.message ? e.message : 'Failed to load') + '</div>';
    });
  }

  // ── The detail context (d._st) ───────────────────────────────────────
  // One object per detail element for its whole life, so a closure or an
  // extension holding it always reads the live ticket (ctx.t is updated in
  // place) and the last read (ctx.r). The shape other modules may use is the
  // Work Orders 1.29 contract (shared contracts 5.2); base, html, extHtml,
  // cardHtml, tasksById, fieldsEdit and painted are the host's own.
  function makeCtx(d) {
    var ctx = {
      ticketId: null, t: null, r: null, canEdit: false, jobId: null, leadId: null,
      toast: toast,
      refresh: function (opts) {
        return updateDetail(d, ctx.ticketId, opts).catch(function (e) {
          try { console.warn('[service-tickets] ticket refresh failed:', e); } catch (_) {}
        });
      },
      reload: function () {
        if (ctx.ticketId != null) _state.openId = String(ctx.ticketId);
        return reload();
      },
      leave: function () { return leaveOpenTicket(); },
      taskTitle: function (id) { return _state.taskTitles[String(id)] || ''; },
      parseSubtaskTitle: parseSubtaskTitle,
      api: api
    };
    d._st = ctx;
    return ctx;
  }

  function indexTasks(ctx, r) {
    _state.taskTitles = {};
    ctx.tasksById = {};
    ((r && r.tasks) || []).forEach(function (k) {
      _state.taskTitles[String(k.id)] = k.title || '';
      ctx.tasksById[String(k.id)] = k;
    });
  }

  // Tags a section's root with data-st-sec (the same rule as the editor kit's
  // sec(), kept here so sections still carry their keys without the kit). An
  // empty section is an empty <template>: no box, no gap, still swappable.
  function sec(key, html) {
    var k = esc(key);
    var s = html == null ? '' : String(html);
    if (!/\S/.test(s)) return '<template data-st-sec="' + k + '"></template>';
    var tagged = false;
    var out = s.replace(/^(\s*<[A-Za-z][A-Za-z0-9-]*)/, function (m) {
      tagged = true;
      return m + ' data-st-sec="' + k + '"';
    });
    return tagged ? out : '<div data-st-sec="' + k + '">' + s + '</div>';
  }

  function findSec(root, key) {
    if (!root || !root.querySelector) return null;
    return root.querySelector('[data-st-sec="' + String(key).replace(/["\\]/g, '\\$&') + '"]');
  }

  // Extension sections, by slot, in registry order. A key is taken once.
  var SLOTS = ['banner', 'afterSite', 'scopeCard', 'afterRevisions', 'statusMeta', 'actions'];

  function extSections(ctx) {
    var out = {};
    SLOTS.forEach(function (s) { out[s] = []; });
    var seen = {};
    extCollect('detailSections', ctx).forEach(function (list) {
      (Array.isArray(list) ? list : [list]).forEach(function (s) {
        if (!s || typeof s.key !== 'string' || !s.key || !out[s.slot] || seen[s.key]) return;
        seen[s.key] = true;
        out[s.slot].push({
          key: s.key, slot: s.slot,
          html: typeof s.html === 'string' ? s.html : '',
          wire: typeof s.wire === 'function' ? s.wire : null
        });
      });
    });
    return out;
  }

  function slotHTML(list, ctx) {
    return list.map(function (s) {
      ctx.extHtml[s.key] = s.html;
      return sec(s.key, s.html);
    }).join('');
  }

  function wireSec(node, s, ctx) {
    if (!node || !s.html || !s.wire) return;
    try { s.wire(node, ctx); } catch (e) {
      try { console.warn('[p86StExt] section ' + s.key, e); } catch (_) {}
    }
  }

  // The stepper shows position on the lattice at a glance. cancelled is not
  // a step on the line — it is a branch off it — so it renders as a note
  // rather than a position.
  var LINE = ['draft', 'open', 'scheduled', 'in_progress', 'work_complete', 'approved', 'closed'];

  function stepperHTML(t) {
    var at = LINE.indexOf(t.status);
    return t.status === 'cancelled'
      ? '<div class="p86-st-cancelled">This ticket was cancelled.</div>'
      : '<div class="p86-st-stepper">' + LINE.map(function (s, i) {
          return '<span class="p86-st-step' + (i <= at ? ' done' : '') + (i === at ? ' at' : '') + '">' +
            esc(STATUS_LABEL[s]) + '</span>';
        }).join('') + '</div>';
  }

  // On a touch phone the stepper is one row that scrolls sideways
  // (styles.css, the 760px pointer: coarse block), so "Approved" or
  // "Closed" can start off screen. Centre the current step by moving the
  // ROW's scrollLeft only — scrollIntoView would also scroll the page. A
  // desktop stepper, and a narrow mouse window's, wraps and never overflows,
  // so there this does nothing.
  function centreStep(d) {
    var stepRow = d.querySelector('.p86-st-stepper');
    var atStep = stepRow && stepRow.querySelector('.p86-st-step.at');
    if (atStep && stepRow.scrollWidth > stepRow.clientWidth) {
      var sr = stepRow.getBoundingClientRect();
      var ar = atStep.getBoundingClientRect();
      stepRow.scrollLeft += (ar.left + ar.width / 2) - (sr.left + sr.width / 2);
    }
  }

  function parentWordOf(t) { return (t && t.lead_id && !t.job_id) ? 'lead' : 'job'; }

  function scopeExtraHTML(t) {
    var html =
      (t.scope_approved
        ? '<label class="p86-st-lbl">Approved scope</label><div class="p86-st-ro">' + esc(t.scope_approved) + '</div>'
        : '') +
      (t.guest_log
        ? '<label class="p86-st-lbl">Field log</label><div class="p86-st-ro p86-st-guestlog">' + esc(t.guest_log) + '</div>'
        : '');
    return html ? '<div class="p86-st-scope-extra">' + html + '</div>' : '';
  }

  // The status control and whatever extensions put beside it. The wrapper
  // has no box of its own, so the phone's status row lays out as before.
  function statusWrapHTML(t, canEdit) {
    return '<span class="p86-st-statusctl" style="display:contents">' + statusControl(t, canEdit) + '</span>';
  }

  function timelineHTML(events, ctx) {
    return events.length ? '<div class="p86-st-timeline">' +
      '<label class="p86-st-lbl">Progress</label>' +
      events.map(function (e) { return eventHTML(e, ctx); }).join('') +
    '</div>' : '';
  }

  function paintDetail(d, r) {
    var t = r.ticket || {};
    var ed = editor();
    var canEdit = canEditJob(_state.jobId) && t.status !== 'closed' && t.status !== 'cancelled';
    var ctx = (d._st && String(d._st.ticketId) === String(t.id)) ? d._st : makeCtx(d);
    ctx.t = ctx.t ? Object.assign(ctx.t, t) : t;
    ctx.ticketId = t.id;
    ctx.r = r;
    ctx.canEdit = canEdit;
    ctx.fieldsEdit = canEdit && !!ed;
    ctx.jobId = _state.jobId;
    ctx.leadId = t.lead_id || null;
    ctx.base = ed ? ed.baseOf(ctx.t) : {};
    ctx.html = {};
    ctx.extHtml = {};
    ctx.cardHtml = {};
    ctx.painted = false;
    indexTasks(ctx, r);
    t = ctx.t;
    var tasks = r.tasks || [];
    var secs = extSections(ctx);
    var H = ctx.html;
    function put(key, html) {
      H[key] = html == null ? '' : String(html);
      return sec(key, H[key]);
    }
    H.addreff = ed ? ed.addressLineHTML(t, r.site, parentWordOf(t)) : '';

    var side;
    var statusHTML = put('status', statusWrapHTML(t, canEdit)) + slotHTML(secs.statusMeta, ctx);
    if (ed) {
      side = ed.sideFieldsHTML(t, ctx.fieldsEdit, r.site, parentWordOf(t), { statusHTML: statusHTML });
    } else {
      side = metaRow('status', 'Status', statusHTML) +
        metaRow('priority', 'Priority', esc(PRIORITY_LABEL[t.priority] || 'Normal')) +
        metaRow('scheduled_for', 'Scheduled', esc(fmtDate(t.scheduled_for) || '—')) +
        metaRow('due_date', 'Due', esc(fmtDate(t.due_date) || '—')) +
        metaRow('site_contact_name', 'Site contact', esc(t.site_contact_name || '—')) +
        (canEdit ? '<div class="p86-st-help p86-st-noeditor" role="note">Editing is unavailable — refresh the page.</div>' : '');
    }

    d.innerHTML =
      put('stepper', stepperHTML(t)) +
      slotHTML(secs.banner, ctx) +
      put('site', siteHTML(r.site)) +
      slotHTML(secs.afterSite, ctx) +
      put('revs', revisionsHTML(r.revisions || [], canEdit, ctx)) +
      slotHTML(secs.afterRevisions, ctx) +
      '<div class="p86-st-detail-grid">' +
        '<div class="p86-st-detail-main">' +
          // A plain block on a desktop (no rule of its own there); on a phone
          // it is the Scope card — the one wrapper the card layout needs,
          // since label and box are otherwise loose siblings.
          '<div class="p86-st-scopecard">' +
          (ed ? ed.titleFieldHTML(t, ctx.fieldsEdit) : '') +
          '<label class="p86-st-lbl">Proposed scope</label>' +
          (ctx.fieldsEdit
            ? '<textarea class="p86-st-scope" data-st-field="scope_proposed" rows="5" placeholder="What needs doing, and where.">' +
                esc(t.scope_proposed || '') + '</textarea>'
            : '<div class="p86-st-ro">' + (t.scope_proposed ? esc(t.scope_proposed) : '<em>No scope written.</em>') + '</div>') +
          put('scopeextra', scopeExtraHTML(t)) +
          slotHTML(secs.scopeCard, ctx) +
          '</div>' +
          (ed ? put('internal', ed.internalNotesHTML(t, ctx.fieldsEdit)) : '') +
          put('mats', materialsHTML(t, canEdit)) +
          put('punchhead', punchHeadHTML(tasks)) +
          subsSectionHTML(tasks, canEdit, ctx) +
          taskAddHTML(canEdit) +
        '</div>' +
        '<div class="p86-st-detail-side">' + side + '</div>' +
      '</div>' +
      actionsHTML(ctx, secs) +
      '<div class="p86-st-sharewrap" hidden></div>' +
      put('parts', participantsHTML(r.participants || [], canEdit)) +
      put('timeline', timelineHTML(r.events || [], ctx));

    if (ctx.fieldsEdit) restoreDraft(d, ctx);
    centreStep(d);
    // The phone scope box grows with its text through CSS field-sizing. A
    // browser without it (older iOS Safari) gets the same from its height.
    var scopeBox = d.querySelector('textarea.p86-st-scope');
    if (scopeBox && !(window.CSS && CSS.supports && CSS.supports('field-sizing', 'content')) &&
        window.matchMedia && window.matchMedia('(max-width: 760px)').matches) {
      var fitScope = function () { scopeBox.style.height = 'auto'; scopeBox.style.height = scopeBox.scrollHeight + 2 + 'px'; };
      scopeBox.addEventListener('input', fitScope);
      fitScope();
    }

    wireActions(d);
    wireMove(findSec(d, 'status'), d);
    wireRevisions(findSec(d, 'revs'), d);
    wireParticipants(findSec(d, 'parts'), d);
    wireMaterials(findSec(d, 'mats'), d);
    Array.prototype.forEach.call(d.querySelectorAll('.p86-wo-sub'), function (card) { wireCard(d, card); });
    if (!d._stDirtyWired) {
      d._stDirtyWired = true;
      d.addEventListener('input', onDirtyInput);
      d.addEventListener('change', onDirtyInput);
    }
    if (ed && ctx.fieldsEdit) {
      var who = d.querySelector('select[data-st-field="assignee_user_id"]');
      if (who) {
        ed.fillAssignees(who, { kind: parentWordOf(t), id: parentWordOf(t) === 'lead' ? t.lead_id : (t.job_id || _state.jobId) },
          t.assignee_user_id).catch(noop);
      }
    }
    if (ed && typeof ed.fillNames === 'function') Promise.resolve(ed.fillNames(d)).catch(noop);
    ctx.painted = true;

    SLOTS.forEach(function (slot) {
      secs[slot].forEach(function (s) { wireSec(findSec(d, s.key), s, ctx); });
    });
    if (!d._stExtWired) {
      d._stExtWired = true;
      extCollect('wireDetail', d, ctx);
    }
    if (ed && ctx.fieldsEdit) ed.showDirty(d, ed.dirtyKeys(d, ctx.base));
    extCollect('afterPaint', d, ctx);
  }

  function actionsHTML(ctx, secs) {
    var canEdit = ctx.canEdit;
    var extra = slotHTML(secs.actions, ctx);
    var anyExtra = secs.actions.some(function (s) { return !!s.html; });
    return (
      // Ask 86 is a READ, so it is not behind canEdit: a closed or cancelled
      // ticket is exactly the one somebody asks "what happened here" about.
      ((canEdit || aiAsk()) ? '<div class="p86-st-actions">' +
        (canEdit
          ? (ctx.fieldsEdit ? '<button class="ee-btn primary p86-st-save">Save</button>' : '') +
            '<button class="ee-btn secondary p86-st-share">&#x1F517; Share</button>' +
            '<button class="ee-btn secondary p86-st-archive">Archive</button>'
          : '') +
        (aiAsk()
          ? '<button class="ee-btn secondary p86-st-ask86" title="Ask 86 about this work order">Ask 86</button>'
          : '') +
        extra +
      '</div>' : (anyExtra ? '<div class="p86-st-actions">' + extra + '</div>' : ''))
    );
  }

  function onDirtyInput(e) {
    var d = e.currentTarget;
    var ctx = d && d._st;
    var ed = editor();
    if (!ctx || !ed || !ctx.fieldsEdit || !ctx.painted) return;
    ed.showDirty(d, ed.dirtyKeys(d, ctx.base));
    syncDraftNote(d);
  }

  // The "your changes are back" note stays only while one of the boxes it
  // names still holds an unsaved change: once they are saved, discarded,
  // replaced by their version or typed back, it goes.
  function syncDraftNote(d) {
    var note = d && d.querySelector && d.querySelector('.p86-st-draftnote');
    if (!note) return;
    var ed = editor();
    var ctx = d._st;
    var dirty = (ed && ctx && ctx.fieldsEdit) ? ed.dirtyKeys(d, ctx.base) : [];
    var keys = note._stKeys || [];
    if (!keys.some(function (k) { return dirty.indexOf(k) !== -1; })) note.remove();
  }

  // ── Unsaved work that outlives a job switch ──────────────────────────
  function stashDraft(d, keys) {
    var ed = editor();
    var ctx = d && d._st;
    if (!ed || !ctx || !ctx.fieldsEdit) return [];
    var list = keys || ed.dirtyKeys(d, ctx.base);
    if (!list.length) return list;
    var values = {};
    var base = {};
    list.forEach(function (k) {
      var c = ed.controlOf(d, k);
      if (!c) return;
      values[k] = c.value;
      base[k] = ctx.base[k];
    });
    _state.drafts[String(ctx.ticketId)] = { values: values, base: base, jobId: ctx.jobId != null ? ctx.jobId : _state.jobId };
    return list;
  }

  // A kept draft counts as unsaved work only while it can still come back: a
  // ticket on a job whose list is not loaded (nothing known about it), or one
  // on the loaded list that is still open for editing. One closed, cancelled
  // or archived since cannot be put back in any box, so it must not make the
  // browser ask before every page leave. It is kept all the same, and returns
  // if the ticket is reopened.
  function draftCanReturn(id) {
    var dr = _state.drafts[id];
    if (!dr) return false;
    if (dr.jobId == null || _state.listedJob == null || String(dr.jobId) !== String(_state.listedJob)) return true;
    var row = ticketRow(id);
    return !!row && row.status !== 'closed' && row.status !== 'cancelled';
  }

  // Typed values go back into the boxes; each box's default stays the server
  // value, so it reads as unsaved, and its base is what the PM started from,
  // so a Save still catches someone else's change in between.
  function restoreDraft(d, ctx) {
    var ed = editor();
    var id = String(ctx.ticketId);
    var dr = _state.drafts[id];
    if (!ed || !dr) return;
    delete _state.drafts[id];
    var restored = [];
    Object.keys(dr.values || {}).forEach(function (k) {
      var c = ed.controlOf(d, k);
      if (!c) return;
      c.value = dr.values[k];
      ctx.base[k] = dr.base[k];
      restored.push(k);
    });
    if (!restored.length) return;
    var grid = d.querySelector('.p86-st-detail-grid');
    if (!grid) return;
    grid.insertAdjacentHTML('beforebegin', ed.draftNoteHTML(restored));
    var note = grid.previousElementSibling;
    if (note) note._stKeys = restored;
    var btn = note && note.querySelector('.p86-st-draftnote-discard');
    if (btn) btn.addEventListener('click', function () {
      resetFields(d, d._st, restored);
      note.remove();
    });
  }

  // Put the server's value back in each box and make it the base again.
  function resetFields(d, ctx, keys) {
    var ed = editor();
    if (!ed || !ctx) return;
    (keys || []).forEach(function (k) {
      var v = ctx.t && ctx.t[k] !== undefined ? ctx.t[k] : null;
      ed.setControl(d, k, v);
      ctx.base[k] = v;
    });
    ed.clearInvalid(d);
    var box = d.querySelector('.p86-st-conflict');
    if (box) { box.hidden = true; box.innerHTML = ''; }
    ed.showDirty(d, ctx.fieldsEdit ? ed.dirtyKeys(d, ctx.base) : []);
    syncDraftNote(d);
  }

  function discardExtras(d) {
    Array.prototype.forEach.call(d.querySelectorAll('.p86-wo-note-in, .p86-st-task-new'), function (i) { i.value = ''; });
    Array.prototype.forEach.call(d.querySelectorAll('.p86-wo-mats-form'), function (f) {
      if (f.hasAttribute('data-filling')) return;
      f.hidden = true;
      f.innerHTML = '';
    });
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

  function revisionHTML(rev, canEdit, ctx) {
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
      extHtml('revisionActions', rev, ctx) +
    '</div>';
  }

  function revisionsHTML(revisions, canEdit, ctx) {
    var rows = revisions.filter(function (r) { return r && r.fields; });
    if (!rows.length) return '';
    var pending = rows.filter(function (r) { return r.status === 'pending'; });
    var done = rows.filter(function (r) { return r.status !== 'pending'; });
    var body = pending.concat(done).map(function (r) { return revisionHTML(r, canEdit, ctx); }).join('');
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
  //
  // Three pieces, so an update can redraw the header and each card on its own
  // and leave the Add box (and what is typed in it) where it is.
  function liveTasks(tasks) {
    return (tasks || []).filter(function (t) { return !t.archived_at; });
  }

  function punchHeadHTML(tasks) {
    var live = liveTasks(tasks);
    var done = live.filter(function (t) { return t.status === 'done'; }).length;
    var pct = live.length ? Math.round((done / live.length) * 100) : 0;
    // .p86-wo-punch-head groups the label and the progress bar: nothing on a
    // desktop, the Punch list header card on a phone, with the building cards
    // straight under it at full width (the crew link does the same).
    return '<div class="p86-wo-punch-head">' +
      '<label class="p86-st-lbl">Punch list' +
        (live.length ? ' <span class="p86-st-taskcount">' + done + ' of ' + live.length + ' done</span>' : '') +
      '</label>' +
      (live.length
        ? '<div class="p86-st-bar-track"><div class="p86-st-bar-fill" style="width:' + pct + '%"></div></div>'
        : '<div class="p86-st-ro"><em>No subtasks under this work order yet.</em></div>') +
      '</div>';
  }

  function subsSectionHTML(tasks, canEdit, ctx) {
    var live = liveTasks(tasks);
    if (!live.length) return sec('subs', '');
    return '<div class="p86-wo-subs" data-st-sec="subs">' + live.map(function (t) {
      var html = subtaskHTML(t, canEdit, ctx);
      if (ctx) ctx.cardHtml[String(t.id)] = html;
      return html;
    }).join('') + '</div>';
  }

  function taskAddHTML(canEdit) {
    return canEdit
      ? '<div class="p86-st-task-add">' +
          '<input type="text" class="p86-st-task-new" placeholder="Add a subtask — e.g. Bldg 790 — Side A: …" />' +
          '<button class="ee-btn secondary p86-st-task-go">Add</button>' +
        '</div>' +
        '<div class="p86-st-task-note">Subtasks stay on the job\'s Tasks list and in My Tasks — ' +
          'the work order groups them, it does not hide them.</div>'
      : '';
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

  // The camera outline on Take photo controls, drawn in currentColor.
  var CAM_ICON_PATH =
    '<path d="M4 8.5h3.2l1.6-2.5h6.4l1.6 2.5H20V19H4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>' +
    '<circle cx="12" cy="13.2" r="3.3" fill="none" stroke="currentColor" stroke-width="1.8"/>';
  var CAM_ICON_TILE = '<svg class="p86-wo-camico" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">' + CAM_ICON_PATH + '</svg>';
  var CAM_ICON_BTN = '<svg class="p86-wo-camico" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">' + CAM_ICON_PATH + '</svg>';

  function subtaskHTML(t, canEdit, ctx) {
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
          extHtml('cardMeta', t, ctx) +
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
          // The dashed tiles at the end of the row, as on the crew link:
          // Take photo and Upload photo. display:none on a desktop; on a
          // phone each opens the matching completion-photo input below (wired
          // in wireCard), so an upload from a tile or a button goes down
          // one path. On a phone the tiles ARE the completion buttons: the
          // two completion labels below are hidden there (styles.css).
          (canEdit
            ? '<button type="button" class="p86-wo-addtile p86-wo-camtile" title="Take a completion photo with the camera">' + CAM_ICON_TILE + 'Take photo</button>' +
              '<button type="button" class="p86-wo-addtile" title="Upload completion photos from the photo library">Upload photo</button>'
            : '') +
        '</div>' +
        // Each kind of photo has two inputs. The camera one carries
        // capture="environment", so a phone opens the back camera straight
        // away (one photo a tap; capture ignores multiple). The upload one has
        // no capture, so it opens the photo library and takes many at once —
        // on Android that picker offers no camera, which is why both exist.
        // The camera controls are hidden where the pointer is not a finger,
        // and on Windows (styles.css): there capture is ignored and "Take
        // photo" would only open the file dialog.
        (canEdit
          ? '<div class="p86-wo-sub-actions">' +
              '<label class="ee-btn primary p86-wo-up p86-wo-cam is-completion">' + CAM_ICON_BTN + 'Take completion photo<input type="file" accept="image/*" capture="environment" hidden data-kind="completion" /></label>' +
              '<label class="ee-btn primary p86-wo-up is-completion">Upload completion photo<input type="file" accept="image/*" multiple hidden data-kind="completion" /></label>' +
              '<label class="ee-btn secondary p86-wo-up p86-wo-cam">' + CAM_ICON_BTN + 'Take before photo<input type="file" accept="image/*" capture="environment" hidden data-kind="before" /></label>' +
              '<label class="ee-btn secondary p86-wo-up">Upload before photo<input type="file" accept="image/*" multiple hidden data-kind="before" /></label>' +
            '</div>'
          : '') +
        (notes.length
          ? '<div class="p86-wo-notes">' + notes.map(function (n) {
              return '<div class="p86-wo-note"><span class="p86-wo-note-by">' + esc(n.by || '') +
                (n.at ? ' · ' + esc(fmtWhen(n.at)) : '') + '</span>' + esc(n.note) +
                extHtml('noteActions', n, t, ctx) + '</div>';
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
    // Navigate: the SAME maps URL the address link above is built from
    // (coords first, then the address). display:none on a desktop, where
    // the address link is the way in; a full-width button on a phone.
    var navHref = (addr && window.p86MapLink && window.p86MapLink.url)
      ? window.p86MapLink.url({ lat: lat, lng: lng, address: addr })
      : '';
    return '<div class="p86-wo-site">' +
      (name ? '<div class="p86-wo-site-name">' + esc(name) + '</div>' : '') +
      // The phone card sets the number in monospace on its own line over the
      // name. Separate nodes, display:none on a desktop, so the desktop line
      // above stays one run of text (splitting it into spans re-kerned it).
      (site.job_number ? '<div class="p86-wo-site-num">' + esc(site.job_number) + '</div>' : '') +
      (site.name ? '<div class="p86-wo-site-title">' + esc(site.name) + '</div>' : '') +
      '<div class="p86-wo-site-row">' +
        (addrHTML ? '<span class="p86-wo-site-addr">' + addrHTML + '</span>' : '') +
        (site.gate_code ? '<span class="p86-wo-gate">Gate <b>' + esc(site.gate_code) + '</b></span>' : '') +
      '</div>' +
      (navHref
        ? '<a class="p86-wo-nav" href="' + escAttr(navHref) + '" target="_blank" rel="noopener noreferrer">' +
            '<span class="p86-wo-nav-pin" aria-hidden="true"></span>Navigate</a>'
        : '') +
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
  // kind, and for a spreadsheet the price-free copy the server made from it —
  // never a URL: the crew opens it through the share token, and the server
  // re-proves the file belongs to the ticket's parents every time.
  //
  // Where it shows (John's rule: no money on a work order). A spreadsheet is
  // NEVER sent as the original file on a link that hides financials (the
  // default). The server reads it with the same extractor that fills the
  // materials list and keeps only material, quantity and unit (copy.lines);
  // those links get a generated .xlsx of just that. Links sent with financial
  // details get the original. When no copy could be made (copy null, with
  // copy_problem saying why — an old .xls, a sheet the reader cannot follow)
  // the file shows only on links sent with financial details. Nothing here
  // tries to spot price columns any more; the copy is built from what the
  // reader keeps, so there is no guess to get wrong.
  //
  // A PDF or photo cannot be turned into a copy, so it shows as it is on
  // every link, after the office is warned.
  function crewTakeoffOf(t) {
    var ct = t && t.crew_takeoff;
    // JSONB arrives parsed from pg, but a text column in a test harness (or a
    // cached row) can hand back the string. Anything unreadable is "nothing
    // shown", which is also what the server does with it.
    if (typeof ct === 'string') { try { ct = JSON.parse(ct); } catch (_) { ct = null; } }
    return ct && typeof ct === 'object' && ct.attachment_id != null ? ct : null;
  }

  // The only kinds the server sends as the whole file on EVERY link
  // (ORIGINAL_ON_EVERY_LINK in service-ticket-share-routes.js). Every other
  // record — a spreadsheet, a kind the reader could not name ('unknown'), a
  // hand-written row — is kept off links that hide financials unless it has a
  // copy, so it never reads as "shows the whole file" here.
  var CREW_WHOLE_FILE_KINDS = { pdf: 1, image: 1 };

  // The lines of a stored copy, or null when there is no usable one. The
  // server serves the copy only when copy.lines is a non-empty list, so an
  // empty or malformed copy reads exactly like no copy.
  function crewCopyLines(ct) {
    var copy = ct && ct.copy;
    return copy && typeof copy === 'object' && Array.isArray(copy.lines) && copy.lines.length
      ? copy.lines : null;
  }

  // Which status a stored record reads as:
  //   copy      — a spreadsheet with a price-free copy: default links get the
  //               copy, links with financial details get the original.
  //   original  — a spreadsheet no copy could be made from: only links sent
  //               with financial details show it.
  //   repick    — a spreadsheet stored before copies existed (no copy key at
  //               all; those rows carried the old has_prices verdict). The
  //               server treats it as "no copy", and picking it again makes one.
  //   unchecked — a PDF or photo: every link shows the whole file.
  // A row stored before copies whose old byte check found prices
  // (has_prices true) is not a PDF or photo whatever kind it names — that check
  // read the bytes — and the server drops its kind, so it reads as a spreadsheet.
  function crewTone(ct) {
    if (CREW_WHOLE_FILE_KINDS[ct.kind] && ct.has_prices !== true) return 'unchecked';
    if (crewCopyLines(ct)) return 'copy';
    if (!Object.prototype.hasOwnProperty.call(ct, 'copy')) return 'repick';
    return 'original';
  }

  // The status line under the file: the PM's only statement of WHICH links
  // show it and in what form. copy_problem is the server's own plain sentence;
  // it sits in brackets mid-sentence, so its closing full stop is dropped.
  function crewStatusText(ct, canEdit) {
    var tone = crewTone(ct);
    if (tone === 'copy') {
      return 'Links that hide financials (the default) get a price-free copy — material, quantity and unit only (' +
        plural(crewCopyLines(ct).length, 'line') + '). Links sent with financial details get the original file.';
    }
    if (tone === 'original') {
      var why = typeof ct.copy_problem === 'string' ? ct.copy_problem.trim().replace(/\.+$/, '') : '';
      return 'No price-free copy could be made' + (why ? ' (' + why + ')' : '') +
        ', so this file only shows on links sent with financial details.';
    }
    if (tone === 'repick') {
      // Only someone who can edit the ticket can pick it again; everyone else
      // is told what the link does with it meanwhile.
      return canEdit
        ? 'Pick this file again to make a price-free copy for the crew link.'
        : 'This file only shows on links sent with financial details until the office picks it again.';
    }
    return 'The crew link shows this whole file. PDFs and photos can\'t be checked for prices — make sure it has none.';
  }

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
    var tone = crewTone(ct);
    var status = crewStatusText(ct, canEdit);
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
      '<div class="p86-wo-crew-status" role="note">' + esc(status) + '</div>' +
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

  // Only used when the editor kit is missing; the kit draws the Details panel
  // otherwise. data-for places the row in the phone grid.
  function metaRow(key, label, html) {
    return '<div class="p86-st-meta" data-for="' + escAttr(key) + '"><span class="p86-st-meta-k">' + esc(label) + '</span>' +
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

  // A column name reads as jargon on the timeline, so every field the office
  // can change has a plain name. The server logs names only, never values, so
  // "what it was changed to" is on the ticket, not here.
  var FIELD_LABEL = {
    title: 'the title', scope_proposed: 'the scope', scope_approved: 'the approved scope',
    priority: 'the priority', scheduled_for: 'the scheduled date', due_date: 'the due date',
    assignee_user_id: 'the assignee', site_contact_name: 'the site contact',
    site_contact_phone: 'the site phone', access_notes: 'the gate code / access notes',
    street_address: 'the address', city: 'the address', state: 'the address', zip: 'the address',
    internal_notes: 'the internal notes', materials: 'the materials', crew_takeoff: 'the crew link takeoff'
  };

  var STATUS_REASON = {
    all_subtasks_done: ' — every subtask done',
    marked_complete: ' — the crew finished the whole work order',
    crew_undid_finish: ' — the crew took back Finish whole work order',
    subtask_added: ' — a subtask was added',
    subtask_removed: ' — its last subtask was removed'
  };

  function photoKindWord(k) {
    return k === 'before' ? 'before' : (k === 'site' ? 'site' : 'completion');
  }

  function statusSuffix(detail) {
    var s = STATUS_REASON[detail.reason] || '';
    if (detail.override === 'buildings_open' && detail.open != null && detail.total != null &&
        isFinite(Number(detail.open)) && isFinite(Number(detail.total))) {
      s += ' with ' + Number(detail.open) + ' of ' + Number(detail.total) + ' subtasks still open';
    }
    if (typeof detail.note === 'string' && detail.note.trim()) {
      s += ' — “' + esc(detail.note.trim()) + '”';
    }
    return s;
  }

  function eventHTML(e, ctx) {
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
      photo_removed: 'removed a photo',
      photo_retagged: 'changed a photo',
      shared: 'sent a link',
      share_revoked: 'turned a link off',
      share_opened: 'opened the link',
      revision_proposed: 'proposed a revision',
      revision_accepted: 'accepted a revision',
      revision_rejected: 'rejected a revision',
      agent_drafted: 'drafted this with 86',
      subtask_completed: 'finished a subtask',
      subtask_reopened: 'reopened a subtask',
      subtask_note: 'added a subtask note',
      task_added: 'added a subtask',
      task_removed: 'removed a subtask'
    };
    var detail = e.detail;
    if (typeof detail === 'string') { try { detail = JSON.parse(detail); } catch (_) { detail = null; } }
    e = Object.assign({}, e, { detail: detail });
    // The building's name as it is now, or — for a building since removed or
    // moved — the title the event recorded.
    var task = detail && detail.task_id != null ? _state.taskTitles[String(detail.task_id)] : '';
    var titled = task || (detail && typeof detail.title === 'string' && detail.title.trim() ? detail.title : '');
    var head = titled ? esc(parseSubtaskTitle(titled).head) : '';
    var ON_TASK = {
      subtask_completed: 'finished ' + head,
      subtask_reopened: 'reopened ' + head,
      subtask_note: 'added a note on ' + head,
      task_added: 'added ' + head,
      task_removed: (detail && detail.reason === 'archived') ? 'removed ' + head : 'took ' + head + ' off this work order'
    };

    // An extension that owns this kind words it first.
    var own = extCollect('eventWhat', e, {
      esc: esc,
      head: function (id) {
        var tt = _state.taskTitles[String(id)];
        return tt ? parseSubtaskTitle(tt).head : '';
      },
      statusLabel: function (s) { return STATUS_LABEL[s] || String(s == null ? '' : s); },
      detail: detail
    });

    var what;
    if (own.length) {
      what = String(own[0]);
    } else if (e.kind === 'status_changed' && detail) {
      what = 'moved it to ' + esc(STATUS_LABEL[detail.to] || detail.to) + statusSuffix(detail);
    } else if (e.kind === 'approval_notified' && detail && Array.isArray(detail.names) && detail.names.length) {
      what = 'told ' + esc(detail.names.join(', ')) + ' it is ready for approval';
    } else if (e.kind === 'photo_added' && detail && detail.task_id != null) {
      what = 'added a ' + (detail.kind === 'before' ? 'before' : 'completion') + ' photo' + (head ? ' on ' + head : '');
    } else if (e.kind === 'photo_added' && detail && detail.flag_id == null) {
      what = 'added a site photo';
    } else if (e.kind === 'photo_removed' && detail) {
      what = 'removed a ' + photoKindWord(detail.kind) + ' photo' + (head ? ' from ' + head : '');
    } else if (e.kind === 'photo_retagged' && detail) {
      what = 'changed a ' + photoKindWord(detail.from) + ' photo to a ' + photoKindWord(detail.to) + ' photo' +
        (head ? ' on ' + head : '');
    } else if (e.kind === 'note_added' && detail && Number(detail.photo_count) > 0) {
      var n = Math.floor(Number(detail.photo_count));
      what = 'added a field note with ' + n + (n === 1 ? ' photo' : ' photos');
    } else if (head && ON_TASK[e.kind]) {
      what = ON_TASK[e.kind];
    } else if (e.kind === 'field_changed' && detail && detail.fields) {
      var names = [];
      (Array.isArray(detail.fields) ? detail.fields : []).forEach(function (k) {
        var nm = FIELD_LABEL[k] || String(k);
        if (names.indexOf(nm) === -1) names.push(nm);
      });
      what = 'edited ' + esc(names.join(', '));
    } else {
      what = esc(VERB[e.kind] || String(e.kind || '').replace(/_/g, ' '));
    }
    return '<div class="p86-st-event' + (e.actor_kind === 'share' ? ' is-guest' : '') + '">' +
      '<span class="p86-st-event-who">' + who + '</span> ' +
      '<span class="p86-st-event-what">' + what + '</span> ' +
      '<span class="p86-st-event-when">' + esc(fmtDate(e.created_at)) + '</span>' +
    '</div>';
  }

  // ── In-place updates ─────────────────────────────────────────────────
  // Re-read this ticket and change only what changed: each section is
  // swapped when its markup differs, each building card likewise, and a field
  // the PM has changed and not saved is left exactly as it is. The page keeps
  // its scroll position around opts.anchor.
  function updateDetail(d, id, opts) {
    var o = opts || {};
    if (!d || !api()) return Promise.resolve();
    return api().get(id).then(function (r) {
      if (String(_state.openId) !== String(id) || !d.isConnected) return;
      var ctx = d._st;
      var ed = editor();
      var t = (r && r.ticket) || {};
      if (!ed || !ctx || !ctx.painted || String(ctx.ticketId) !== String(t.id)) {
        paintDetail(d, r);
        return;
      }
      var canEdit = canEditJob(_state.jobId) && t.status !== 'closed' && t.status !== 'cancelled';
      if (canEdit !== ctx.canEdit) {
        // Closed, cancelled or reopened elsewhere: the controls change, so the
        // detail is rebuilt. Typed changes are kept as a draft, not saved.
        var keys = ctx.fieldsEdit ? ed.dirtyKeys(d, ctx.base) : [];
        if (keys.length) {
          stashDraft(d, keys);
          toast('This work order was ' + (STATUS_LABEL[t.status] || t.status) +
            ' while you were editing — your changes to ' + ed.labelList(keys) + ' were not saved.', 'error');
        }
        paintDetail(d, r);
        // The list row follows, so a draft kept for a ticket that can no
        // longer be edited stops counting as unsaved work.
        patchRowHead(d, t, r);
        return;
      }
      return ed.keepScroll(anchorNow(d, o.anchor), function () { patchDetail(d, r); }, d);
    });
  }

  // The scroll anchor, looked up when the update lands rather than when it
  // was asked for: a card or section redrawn by another update in between is
  // detached, measures at the top of nothing, and would scroll the wrong box.
  // The element itself while it is on the page, else the card or section now
  // drawn in its place, else none (the kit keeps the first thing on screen).
  function anchorNow(d, el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.isConnected) return el;
    var keyed = el.closest ? el.closest('[data-task],[data-st-sec]') : null;
    if (!keyed || !d || !d.querySelector) return null;
    var attr = keyed.hasAttribute('data-task') ? 'data-task' : 'data-st-sec';
    var val = String(keyed.getAttribute(attr)).replace(/["\\]/g, '\\$&');
    var now = d.querySelector('[' + attr + '="' + val + '"]');
    return (now && now.isConnected) ? now : null;
  }

  // The old name, for callers that still use it.
  function refreshDetail(d, id) {
    return updateDetail(d, id);
  }

  function patchDetail(d, r) {
    var ed = editor();
    var ctx = d._st;
    var dirty = ctx.fieldsEdit ? ed.dirtyKeys(d, ctx.base) : [];
    Object.assign(ctx.t, r.ticket || {});
    ctx.r = r;
    indexTasks(ctx, r);
    var t = ctx.t;
    var canEdit = ctx.canEdit;
    var H = ctx.html;
    function swap(key, html, wireFn) {
      return ed.swapSection(d, key, html == null ? '' : String(html), H, wireFn);
    }

    if (swap('stepper', stepperHTML(t))) centreStep(d);
    swap('site', siteHTML(r.site));
    swap('revs', revisionsHTML(r.revisions || [], canEdit, ctx), function (n) { wireRevisions(n, d); });
    swap('scopeextra', scopeExtraHTML(t));
    var internal = findSec(d, 'internal');
    if (internal && dirty.indexOf('internal_notes') === -1 && !holdsCaret(internal)) {
      swap('internal', ed.internalNotesHTML(t, ctx.fieldsEdit));
    }
    swap('addreff', ed.addressLineHTML(t, r.site, parentWordOf(t)));
    // Not while someone is choosing a move, or one is on its way.
    var mv = d.querySelector('.p86-st-move');
    if (!(mv && (mv.disabled || document.activeElement === mv))) {
      swap('status', statusWrapHTML(t, canEdit), function (n) { wireMove(n, d); });
    }
    var pick = d.querySelector('.p86-st-part-user');
    if (!(pick && pick.value)) {
      swap('parts', participantsHTML(r.participants || [], canEdit), function (n) { wireParticipants(n, d); });
    }
    swap('timeline', timelineHTML(r.events || [], ctx));
    swap('punchhead', punchHeadHTML(r.tasks || []));

    // An open materials editor (or a file being read into it) is left alone;
    // only the crew link row under it follows the ticket.
    var form = d.querySelector('.p86-wo-mats-form');
    if (!form || (form.hidden && !form.hasAttribute('data-filling'))) {
      swap('mats', materialsHTML(t, canEdit), function (n) { wireMaterials(n, d); });
    } else {
      var crew = d.querySelector('.p86-wo-crew');
      var crewHtml = crewTakeoffHTML(t, canEdit);
      if (crew && crewHtml) {
        crew.outerHTML = crewHtml;
        delete H.mats;
      }
    }

    syncCards(d, ctx, r.tasks || []);
    syncFields(d, ctx, dirty);
    patchExtSections(d, ctx);
    patchRowHead(d, t, r);
    if (ctx.fieldsEdit) ed.showDirty(d, ed.dirtyKeys(d, ctx.base));
    syncDraftNote(d);
    extCollect('afterPaint', d, ctx);
  }

  // Building cards, one at a time: a changed card is redrawn carrying the note
  // typed in it (and the caret), a new one is put in its place, a removed one
  // goes.
  function syncCards(d, ctx, tasks) {
    var holder = findSec(d, 'subs');
    if (!holder || !holder.parentNode) return;
    var doc = d.ownerDocument;
    var live = liveTasks(tasks);
    if (!live.length) {
      if (holder.tagName !== 'TEMPLATE') {
        var empty = doc.createElement('template');
        empty.setAttribute('data-st-sec', 'subs');
        holder.parentNode.replaceChild(empty, holder);
      }
      ctx.cardHtml = {};
      return;
    }
    if (holder.tagName === 'TEMPLATE') {
      var box = doc.createElement('div');
      box.className = 'p86-wo-subs';
      box.setAttribute('data-st-sec', 'subs');
      holder.parentNode.replaceChild(box, holder);
      holder = box;
    }
    var byId = {};
    Array.prototype.forEach.call(holder.children, function (c) {
      var k = c.getAttribute('data-task');
      if (k != null) byId[k] = c;
    });
    var keep = {};
    var prev = null;
    live.forEach(function (task) {
      var id = String(task.id);
      var html = subtaskHTML(task, ctx.canEdit, ctx);
      var card = byId[id];
      if (!card || ctx.cardHtml[id] !== html) {
        var tpl = doc.createElement('template');
        tpl.innerHTML = html;
        var fresh = tpl.content.firstElementChild;
        if (!fresh) return;
        var oldIn = card && card.querySelector('.p86-wo-note-in');
        var focused = !!(oldIn && doc.activeElement === oldIn);
        var selStart = focused ? oldIn.selectionStart : null;
        var selEnd = focused ? oldIn.selectionEnd : null;
        if (card) holder.replaceChild(fresh, card);
        else holder.insertBefore(fresh, prev ? prev.nextSibling : holder.firstChild);
        var newIn = fresh.querySelector('.p86-wo-note-in');
        if (oldIn && newIn && oldIn.value) newIn.value = oldIn.value;
        if (focused && newIn) {
          try { newIn.focus(); newIn.setSelectionRange(selStart, selEnd); } catch (e) { /* not focusable */ }
        }
        ctx.cardHtml[id] = html;
        wireCard(d, fresh);
        card = fresh;
      } else if (card.previousElementSibling !== prev) {
        holder.insertBefore(card, prev ? prev.nextSibling : holder.firstChild);
      }
      keep[id] = true;
      prev = card;
    });
    Object.keys(byId).forEach(function (id) {
      if (keep[id]) return;
      if (byId[id].parentNode) byId[id].parentNode.removeChild(byId[id]);
      delete ctx.cardHtml[id];
    });
  }

  // Every field NOT changed by the PM takes the server's value (and that value
  // becomes its default and its base). A changed field keeps the typing and
  // the base it started from, so Save can still see a conflict.
  function syncFields(d, ctx, dirty) {
    var ed = editor();
    if (!ed || !ctx.fieldsEdit) return;
    ed.FIELDS.forEach(function (f) {
      if (dirty.indexOf(f.key) !== -1) return;
      var c = ed.controlOf(d, f.key);
      if (!c) return;
      var v = ctx.t[f.key] === undefined ? null : ctx.t[f.key];
      ctx.base[f.key] = v;
      if (ed.norm(f.key, c.value) !== ed.norm(f.key, v)) ed.setControl(d, f.key, v);
    });
  }

  function patchExtSections(d, ctx) {
    var ed = editor();
    var secs = extSections(ctx);
    var now = {};
    SLOTS.forEach(function (slot) {
      var list = secs[slot];
      list.forEach(function (s, i) {
        now[s.key] = true;
        if (!findSec(d, s.key)) {
          var added = insertSec(d, slot, list, i, s);
          if (added) {
            ctx.extHtml[s.key] = s.html;
            wireSec(added, s, ctx);
          }
          return;
        }
        ed.swapSection(d, s.key, s.html, ctx.extHtml, function (n) { wireSec(n, s, ctx); });
      });
    });
    // A section its module no longer returns is emptied, not left stale.
    Object.keys(ctx.extHtml).forEach(function (key) {
      if (!now[key]) ed.swapSection(d, key, '', ctx.extHtml);
    });
  }

  var SLOT_AFTER = { banner: 'stepper', afterSite: 'site', afterRevisions: 'revs', statusMeta: 'status' };

  // A section that was not there at the last paint goes after the nearest
  // earlier section of its slot, or at the slot's own place.
  function insertSec(d, slot, list, i, s) {
    var tpl = d.ownerDocument.createElement('template');
    tpl.innerHTML = sec(s.key, s.html);
    var fresh = tpl.content.firstElementChild;
    if (!fresh) return null;
    for (var j = i - 1; j >= 0; j--) {
      var before = findSec(d, list[j].key);
      if (before && before.parentNode) {
        before.parentNode.insertBefore(fresh, before.nextSibling);
        return fresh;
      }
    }
    if (SLOT_AFTER[slot]) {
      var a = findSec(d, SLOT_AFTER[slot]);
      if (!a || !a.parentNode) return null;
      a.parentNode.insertBefore(fresh, a.nextSibling);
      return fresh;
    }
    var holder = d.querySelector(slot === 'scopeCard' ? '.p86-st-scopecard' : '.p86-st-actions');
    if (!holder) return null;
    holder.appendChild(fresh);
    return fresh;
  }

  // One building card. Everything it does reads the task from ctx.tasksById
  // at click time, so a card that outlives an update acts on the task as it
  // is now, not as it was when the card was drawn.
  function wireCard(d, card) {
    var taskId = card.getAttribute('data-task');
    function ctxNow() { return d._st || {}; }
    function task() { return (ctxNow().tasksById || {})[taskId] || {}; }
    function photos() { return task().photos || []; }
    var body = card.querySelector('.p86-wo-sub-body');
    var toggle = card.querySelector('.p86-wo-sub-toggle');

    function setOpen(open) {
      if (!body) return;
      body.hidden = !open;
      card.classList.toggle('is-open', open);
      if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) _state.openSubs[taskId] = true; else delete _state.openSubs[taskId];
      // The card on screen is now the open (or closed) one, so an update that
      // draws it the same way leaves it alone.
      var ctx = ctxNow();
      if (ctx.cardHtml && ctx.cardHtml[taskId] != null && ctx.tasksById && ctx.tasksById[taskId]) {
        ctx.cardHtml[taskId] = subtaskHTML(ctx.tasksById[taskId], ctx.canEdit, ctx);
      }
    }
    if (toggle) toggle.addEventListener('click', function () { setOpen(body.hidden); });

    card.querySelectorAll('.p86-wo-thumb').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!window.p86Attachments || !window.p86Attachments.openLightbox) return;
        window.p86Attachments.openLightbox(photos(), Number(b.getAttribute('data-idx')) || 0, {
          parentLabel: parseSubtaskTitle(task().title).head,
          parentSubtitle: (ctxNow().t && ctxNow().t.title) || ''
        });
      });
    });

    if (!ctxNow().canEdit) return;

    // Which control started a photo pick — a tile or a button — so the upload
    // module can mark that one busy. The click the tile or label passes on to
    // its hidden input is not a tap of its own.
    card.addEventListener('click', function (e) {
      var el = e.target;
      if (!el || !el.closest || el.tagName === 'INPUT') return;
      var tap = el.closest('.p86-wo-addtile, .p86-wo-up');
      if (tap && card.contains(tap)) card._p86LastTap = tap;
    }, true);

    var check = card.querySelector('.p86-wo-check');
    if (check) check.addEventListener('click', function () {
      var ctx = ctxNow();
      var done = task().status !== 'done';
      var hasCompletion = photos().some(function (p) { return p.kind !== 'before'; });
      if (done && !hasCompletion) {
        setOpen(true);
        toast('Add a completion photo before marking this complete.', 'error');
        return;
      }
      check.disabled = true;
      var wasStatus = ctx.t && ctx.t.status;
      api().setSubtaskDone(ctx.ticketId, taskId, done).then(function (res) {
        if (res && res.ticket_status === 'work_complete' && wasStatus !== 'work_complete') {
          toast('Every subtask is done — the work order is awaiting approval.');
        }
        return updateDetail(d, ctx.ticketId, { anchor: card }).catch(noop);
      }, function (e) {
        check.disabled = false;
        var code = e && e.data && e.data.code;
        if (code === 'completion_photo_required') setOpen(true);
        toast(e && e.message ? e.message : 'Could not update the subtask', 'error');
        // A locked work order has changed under the screen: show it as it is.
        if (code === 'work_order_locked') return updateDetail(d, ctx.ticketId, { anchor: card }).catch(noop);
      }).then(function () {
        if (check.isConnected) check.disabled = false;
      });
    });

    // Each tile opens its own completion input: Take photo the camera one,
    // Upload photo the library one.
    var camTile = card.querySelector('.p86-wo-camtile');
    var addTile = card.querySelector('.p86-wo-addtile:not(.p86-wo-camtile)');
    var completionCam = card.querySelector('.p86-wo-up.p86-wo-cam input[data-kind="completion"]');
    var completionIn = card.querySelector('.p86-wo-up:not(.p86-wo-cam) input[data-kind="completion"]');
    if (camTile && completionCam) camTile.addEventListener('click', function () { completionCam.click(); });
    if (addTile && completionIn) addTile.addEventListener('click', function () { completionIn.click(); });

    card.querySelectorAll('.p86-wo-up input[type=file]').forEach(function (inp) {
      inp.addEventListener('change', function () {
        var files = Array.prototype.slice.call(inp.files || []);
        inp.value = '';
        var ctx = ctxNow();
        var kind = inp.getAttribute('data-kind') === 'before' ? 'before' : 'completion';
        // The office upload queue (js/work-order-uploads.js) when it is on the
        // page: retries, a busy tile and thumbnails as each photo lands.
        var uploads = window.p86WorkOrderUploads;
        if (files.length && uploads && typeof uploads.addPhotos === 'function') {
          uploads.addPhotos(card, inp, files, {
            ticketId: ctx.ticketId,
            taskId: taskId,
            kind: kind,
            onSettled: function () {
              _state.openSubs[taskId] = true;
              return updateDetail(d, ctx.ticketId, { anchor: card }).catch(noop);
            }
          });
          return;
        }
        if (!files.length || !window.p86Api || !window.p86Api.attachments) return;
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
          if (label) label.classList.remove('is-busy');
          return updateDetail(d, ctx.ticketId, { anchor: card });
        }).catch(function (e) {
          if (label) label.classList.remove('is-busy');
          toast(e && e.message ? e.message : 'Could not upload the photo', 'error');
          return updateDetail(d, ctx.ticketId, { anchor: card }).catch(noop);
        });
      });
    });

    var noteIn = card.querySelector('.p86-wo-note-in');
    var noteGo = card.querySelector('.p86-wo-note-go');
    function addNote() {
      var ctx = ctxNow();
      var note = (noteIn && noteIn.value || '').trim();
      if (!note) return;
      noteGo.disabled = true;
      api().addSubtaskNote(ctx.ticketId, taskId, note).then(function () {
        _state.openSubs[taskId] = true;
        // Cleared before the update, which would otherwise carry the note just
        // sent into the redrawn card.
        if (noteIn) noteIn.value = '';
        noteGo.disabled = false;
        return updateDetail(d, ctx.ticketId, { anchor: card }).catch(noop);
      }, function (e) {
        noteGo.disabled = false;
        toast(e && e.message ? e.message : 'Could not add the note', 'error');
      });
    }
    if (noteGo) noteGo.addEventListener('click', addNote);
    if (noteIn) noteIn.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); addNote(); }
    });
  }

  // The Materials section, wired each time it is drawn (a section swap draws
  // it again). Listeners hang off the section's own nodes.
  function wireMaterials(node, d) {
    if (!node || !node.querySelector || !d._st) return;
    function ctxNow() { return d._st || {}; }
    // Materials editor: rows of qty / unit / material. No price column —
    // the server drops any key that is not one of those three anyway.
    var matsEdit = node.querySelector('.p86-wo-mats-edit');
    var matsForm = node.querySelector('.p86-wo-mats-form');
    if (matsEdit && matsForm) matsEdit.addEventListener('click', function () {
      if (!matsForm.hidden) { matsForm.hidden = true; matsForm.innerHTML = ''; return; }
      var t = ctxNow().t || {};
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
    // Wired ONCE per draw, not inside the Edit handler above. It used to be
    // added on every open, so an editor closed and reopened answered each click
    // twice — two saves racing, one of them from the detached rows of the first
    // open, and two pickers and two metered reads of the same file. The rows
    // container is looked up per click because each open rebuilds it.
    if (matsForm) matsForm.addEventListener('click', function (e) {
      var rows = matsForm.querySelector('.p86-wo-mat-rows');
      if (!rows) return;
      var t = ctxNow().t || {};
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
          // Closed first, so the update below draws the saved list.
          matsForm.hidden = true;
          matsForm.innerHTML = '';
          return updateDetail(d, t.id, { anchor: node }).catch(noop);
        }, function (err) {
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
    if (ctxNow().canEdit) node.addEventListener('click', function (e) {
      var t = ctxNow().t || {};
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

  // An old .xls cannot be read — the reader takes .xlsx only — so it is not
  // pickable for filling the editor, and its row says to save it as .xlsx.
  // On the crew link it IS pickable: nothing is read to put it there, and
  // the server simply makes no price-free copy from it, so it shows only on
  // links sent with financial details. The row says that before the pick.
  function pickable(f, crew) {
    return !!f && (crew === true || f.kind !== 'xls');
  }

  // crewId: in crew mode, the attachment already on the crew link, so its row
  // says so.
  function pickRowHTML(f, idx, crew, crewId) {
    var legacy = !pickable(f, crew);
    // Crew mode only: a spreadsheet no price-free copy can come from.
    var narrow = crew && f.kind === 'xls';
    var current = crew && crewId != null && String(crewId) === String(f.id);
    var meta = [f.folder, fmtBytes(f.size_bytes), fmtDate(f.uploaded_at)].filter(Boolean).join(' · ');
    return '<button type="button" class="p86-wo-pick-row' + (legacy ? ' is-legacy' : '') +
        (narrow ? ' is-narrow' : '') + (current ? ' is-current' : '') + '" data-idx="' + idx + '"' +
        (legacy ? ' disabled' : '') + '>' +
      '<span class="p86-wo-pick-kind k-' + esc(f.kind) + '">' + esc(PICK_KIND[f.kind] || f.kind) + '</span>' +
      '<span class="p86-wo-pick-main">' +
        '<span class="p86-wo-pick-name">' + esc(f.filename || 'Untitled file') + '</span>' +
        '<span class="p86-wo-pick-meta">' +
          (legacy ? 'Save as .xlsx to read it'
            : narrow ? 'Only on links sent with financial details (no price-free copy from .xls)'
            : esc(meta)) +
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
          ? '<div class="p86-wo-pick-note">Links that hide financials (the default) get a price-free copy of a ' +
              'spreadsheet — material, quantity and unit only. Links sent with financial details get the original. ' +
              'PDFs and photos show as they are.</div>'
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
      if (!pickable(f, crew)) return;
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
          b.disabled = !pickable(ff, crew);
        });
        btn.classList.remove('is-reading');
        btn.removeAttribute('aria-busy');
        if (state) state.textContent = stateWas;
      }

      if (crew) {
        // A PDF or photo is asked about BEFORE anything is saved: no
        // price-free copy can be made from one, so it goes out as it is on
        // every link. A spreadsheet needs no question — links that hide
        // financials only ever get its copy, or nothing. The row reads
        // "Saving…" only once the PM has said yes.
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
        note.innerHTML = takeoffNoteHTML(res, filename, lines.length, put.length, lines.length - put.length);
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
  //
  // READ and ADDED are two numbers and the note says both when they differ.
  // It used to print the added count as "N lines read", so "Add to it" on a
  // nearly full list said "5 lines read … so 25 read lines did not fit" right
  // after the Replace / Add question had said 30 were read.
  function takeoffNoteHTML(res, filename, read, added, didNotFit) {
    var c = (res && res.counts) || {};
    var sk = c.skipped || {};
    var sheet = res.source && res.source.sheet;
    var skipped = [];
    if (Number(sk.labor) > 0) skipped.push(plural(Number(sk.labor), 'labor line'));
    if (Number(sk.totals) > 0) skipped.push(plural(Number(sk.totals), 'subtotal row'));
    if (Number(sk.zero_qty) > 0) skipped.push(plural(Number(sk.zero_qty), 'removed line') + ' (qty 0)');

    var head = plural(read, 'line') + ' read from ' + filename + (sheet ? ' (' + sheet + ')' : '') +
      (skipped.length ? '; skipped ' + skipped.join(', ') : '') + '.' +
      (added !== read ? ' ' + plural(added, 'line') + ' added.' : '');

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

  // The one question before a whole file goes to the crew. A spreadsheet or
  // CSV (an old .xls included) never needs it: links that hide financials get
  // only the server's price-free copy of it, or nothing when none could be
  // made. A PDF or a photo has no copy, so it would show as it is on every
  // link, including the ones that hide financials. Resolves true to go ahead.
  // Never rejects.
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

  // Says in what form, and on which links, the saved file shows. A plain
  // "shown" is only ever a PDF or photo, which really does show as it is.
  function crewSavedMessage(ct) {
    var tone = ct ? crewTone(ct) : null;
    if (tone === 'copy') return 'Takeoff shown on the crew link — default links get a price-free copy';
    if (tone === 'original' || tone === 'repick') {
      return 'Takeoff shown on the crew link — only on links sent with financial details';
    }
    return 'Takeoff shown on the crew link';
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

  // Show the new crew-link file. The "Also show" button sits right under lines
  // just read into the editor and not yet saved; an in-place update leaves an
  // open editor alone and redraws only the crew row, so those lines stay.
  // Without the editor kit (no in-place update) the old rule holds: when the
  // open ticket holds edits, only the crew row is redrawn.
  function afterCrewTakeoff(d, t, res) {
    t.crew_takeoff = crewFromResponse(res);
    if (!d) return Promise.resolve();
    var ct = t.crew_takeoff;
    Array.prototype.forEach.call(d.querySelectorAll('.p86-wo-mat-crew'), function (b) {
      if (ct && String(b.getAttribute('data-att')) === String(ct.attachment_id)) b.remove();
    });
    if (!(editor() && d._st && d._st.painted)) {
      var row = d.closest('.p86-st-row');
      if (row && row.parentNode && detailHoldsEdits(row.parentNode)) {
        var old = d.querySelector('.p86-wo-crew');
        // Only an editor reaches this, so the row is drawn with its controls.
        if (old) old.outerHTML = crewTakeoffHTML(t, true);
        return Promise.resolve();
      }
    }
    return updateDetail(d, t.id).catch(function () {
      toast('Saved, but the ticket could not be reloaded — collapse and reopen it to see the change.', 'error');
    });
  }

  // The static controls of a detail: Save, Share, Archive, Ask 86 and the
  // Add subtask box. None of them is swapped by an update, so they are wired
  // once per full paint.
  function wireActions(d) {
    var save = d.querySelector('.p86-st-save');
    if (save) save.addEventListener('click', function () { saveTicket(d); });

    // Add a task under this ticket. entity_type/entity_id are stamped from the
    // ticket's own parent so the task lands on the JOB as well — sending only
    // service_ticket_id would create a task that belongs to a work order and
    // to no job, which is exactly the disappearance this design avoids.
    var addGo = d.querySelector('.p86-st-task-go');
    var addIn = d.querySelector('.p86-st-task-new');
    function addTask() {
      var t = d._st.t;
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
        // In place: whatever else is typed on the ticket stays in its box.
        return updateDetail(d, t.id, { anchor: d.querySelector('.p86-st-task-add') }).catch(noop);
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
      paintSharePanel(wrap, d._st.t);
    });

    var arch = d.querySelector('.p86-st-archive');
    if (arch) arch.addEventListener('click', function () {
      var t = d._st.t;
      leaveOpenTicket().then(function (go) {
        if (!go) return;
        // p86Confirm, never native confirm() — it no-ops inside the installed PWA.
        var ask = window.p86Confirm
          ? window.p86Confirm({
              title: 'Archive this ticket?',
              message: 'It leaves the list. Tasks under it are kept — archiving a work order must not delete field work.',
              confirmText: 'Archive', danger: true
            })
          : Promise.resolve(true);
        return Promise.resolve(ask).then(function (yes) {
          if (!yes) return;
          return api().archive(t.id).then(function () {
            _state.openId = null;
            toast('Ticket archived');
            return reload();
          });
        });
      }).catch(function (e) {
        toast(e && e.message ? e.message : 'Could not archive', 'error');
      });
    });

    var ask86 = d.querySelector('.p86-st-ask86');
    if (ask86) ask86.addEventListener('click', function () { askAboutTicket(d._st.t); });
  }

  // Move to… A move redraws the status and can reopen buildings, so unsaved
  // changes are asked about first. A module that needs a reason for the move
  // (js/work-order-review.js) answers confirmMove with the extra body, or null
  // to cancel. The move is sent with the status on screen, so a work order
  // moved by someone else in the meantime is refused, not overwritten.
  function wireMove(node, d) {
    var mv = node && node.querySelector ? node.querySelector('.p86-st-move') : null;
    if (!mv) return;
    mv.addEventListener('change', function () {
      var ctx = d._st;
      var to = mv.value;
      if (!to || !ctx) return;
      var t = ctx.t;
      var from = t.status;
      mv.disabled = true;
      function reset() {
        mv.disabled = false;
        mv.value = '';
      }
      function settle() {
        reset();
        try { mv.blur(); } catch (e) { /* detached */ }
        return updateDetail(d, ctx.ticketId, { anchor: d.querySelector('.p86-st-meta[data-for="status"]') });
      }
      leaveOpenTicket().then(function (go) {
        if (!go) { reset(); return; }
        var asked = extFirst('confirmMove', ctx, to);
        return Promise.resolve(asked === undefined ? {} : asked).then(function (extra) {
          if (extra === null) { reset(); return; }
          var body = (extra && typeof extra === 'object') ? extra : {};
          var move = typeof window.p86MoveTicketStatus === 'function'
            ? window.p86MoveTicketStatus(t, to, body)
            : api().setStatus(t.id, to, Object.assign({ expected_status: t.status }, body)).then(function (res) {
                return { outcome: 'moved', response: res, ticket: (res && res.ticket) || null };
              });
          return Promise.resolve(move).then(function (out) {
            if (!out || out.outcome === 'cancelled') { reset(); return; }
            if (out.outcome === 'stale') {
              toast(out.message || STALE, 'error');
              return settle();
            }
            extCollect('afterStatus', ctx, out.response, from, to);
            return settle();
          });
        });
      }).catch(function (e) {
        toast(e && e.message ? e.message : 'Could not change the status', 'error');
        return settle().catch(noop);
      });
    });
  }

  // ── Save, and the unsaved-changes question ───────────────────────────
  function openDetail() {
    var host = pane();
    var d = host && host.querySelector('.p86-st-row.is-open .p86-st-detail');
    return (d && d._st && d._st.painted) ? d : null;
  }

  // Saves only the fields that changed, with what they were when loaded.
  // Resolves true when there is nothing left unsaved, false otherwise.
  function saveTicket(d) {
    var ed = editor();
    var ctx = d && d._st;
    if (!ed || !ctx || !ctx.fieldsEdit || !api()) return Promise.resolve(false);
    var keys = ed.dirtyKeys(d, ctx.base);
    if (!keys.length) {
      toast('No changes to save.');
      return Promise.resolve(true);
    }
    if (_state.busy) return Promise.resolve(false);
    _state.busy = true;
    var save = d.querySelector('.p86-st-save');
    if (save) save.disabled = true;
    ed.clearInvalid(d);
    var patch = ed.buildPatch(d, ctx.base, keys);
    function done() {
      _state.busy = false;
      if (save) save.disabled = false;
    }
    return api().update(ctx.ticketId, patch).then(function (res) {
      done();
      var row = (res && res.ticket) || {};
      keys.forEach(function (k) {
        var v = Object.prototype.hasOwnProperty.call(row, k) ? row[k] : patch[k];
        ed.setControl(d, k, v);
        ctx.base[k] = v;
        ctx.t[k] = v;
      });
      var box = d.querySelector('.p86-st-conflict');
      if (box) { box.hidden = true; box.innerHTML = ''; }
      ed.showDirty(d, ed.dirtyKeys(d, ctx.base));
      syncDraftNote(d);
      toast('Ticket saved');
      return updateDetail(d, ctx.ticketId, { anchor: save }).catch(noop).then(function () { return true; });
    }, function (err) {
      done();
      var data = (err && err.data) || {};
      if (err && err.status === 400 && data.field) {
        ed.markInvalid(d, data.field, data.error || err.message);
        return false;
      }
      if (err && err.status === 409 && data.code === 'edit_conflict') {
        var theirs = (data.ticket && typeof data.ticket === 'object') ? data.ticket : {};
        var fields = Array.isArray(data.fields) ? data.fields : [];
        // Their value is now the starting point for those fields, so the next
        // Save replaces it knowingly. Fields this PM did not touch take theirs.
        fields.forEach(function (k) {
          if (Object.prototype.hasOwnProperty.call(theirs, k)) ctx.base[k] = theirs[k];
        });
        ed.FIELDS.forEach(function (f) {
          if (keys.indexOf(f.key) !== -1 || !Object.prototype.hasOwnProperty.call(theirs, f.key)) return;
          ctx.t[f.key] = theirs[f.key];
          ctx.base[f.key] = theirs[f.key];
          if (ed.controlOf(d, f.key) && ed.norm(f.key, ed.controlOf(d, f.key).value) !== ed.norm(f.key, theirs[f.key])) {
            ed.setControl(d, f.key, theirs[f.key]);
          }
        });
        ed.showConflict(d, fields, theirs, function (used, src) {
          (used || []).forEach(function (k) {
            if (!Object.prototype.hasOwnProperty.call(src, k)) return;
            ctx.base[k] = src[k];
            ctx.t[k] = src[k];
          });
          ed.showDirty(d, ed.dirtyKeys(d, ctx.base));
        });
        ed.showDirty(d, ed.dirtyKeys(d, ctx.base));
        return false;
      }
      toast(err && err.message ? err.message : 'Could not save', 'error');
      updateDetail(d, ctx.ticketId).catch(noop);
      return false;
    });
  }

  // Before anything that redraws or drops the open ticket's fields. Resolves
  // true to go on (nothing unsaved, saved, or discarded), false to stay.
  function leaveOpenTicket() {
    var d = openDetail();
    var ed = editor();
    if (!d || !ed) return Promise.resolve(true);
    var ctx = d._st;
    var keys = ctx.fieldsEdit ? ed.dirtyKeys(d, ctx.base) : [];
    var extras = ed.unsavedExtras(d);
    if (!keys.length && !extras.length) return Promise.resolve(true);
    return Promise.resolve(ed.confirmUnsaved({
      keys: keys,
      extras: extras,
      save: function () { return saveTicket(d); }
    })).then(function (answer) {
      if (answer === 'discard') {
        resetFields(d, ctx, keys);
        discardExtras(d);
        delete _state.drafts[String(ctx.ticketId)];
      }
      return answer === 'saved' || answer === 'discard';
    }, function () { return false; });
  }

  // Unsaved changes anywhere on this surface: the open ticket, a draft kept
  // from another job, or a New ticket box with something in it.
  function hasUnsavedWork() {
    if (Object.keys(_state.drafts).some(draftCanReturn)) return true;
    if (typeof _createTyped === 'function' && _createTyped()) return true;
    var ed = editor();
    var d = openDetail();
    if (!ed || !d) return false;
    var ctx = d._st;
    return (ctx.fieldsEdit && ed.dirtyKeys(d, ctx.base).length > 0) || ed.unsavedExtras(d).length > 0;
  }

  // Accept takes the CHECKED fields only, so "take the new scope, ignore the
  // date they suggested" is one click. Sending nothing checked is refused here
  // rather than making the round trip to be told 400.
  function wireRevisions(node, d) {
    if (!node || !node.querySelectorAll) return;
    Array.prototype.forEach.call(node.querySelectorAll('.p86-st-rev'), function (row) {
      var id = row.getAttribute('data-rev');
      var acc = row.querySelector('.p86-st-rev-accept');
      var rej = row.querySelector('.p86-st-rev-reject');

      if (acc) acc.addEventListener('click', function () {
        var t = d._st.t;
        var picked = Array.prototype.map.call(
          row.querySelectorAll('.p86-st-rev-pick:checked'), function (c) { return c.value; });
        if (!picked.length) { toast('Tick at least one field to accept.', 'error'); return; }
        acc.disabled = true;
        if (rej) rej.disabled = true;
        function release() {
          acc.disabled = false;
          if (rej) rej.disabled = false;
        }
        // Accepting writes the ticket's fields, so typed changes are settled
        // first.
        leaveOpenTicket().then(function (go) {
          if (!go) { release(); return; }
          return api().acceptRevision(t.id, id, picked).then(function () {
            toast('Applied ' + picked.length + (picked.length === 1 ? ' field' : ' fields'));
            return updateDetail(d, t.id, { anchor: row }).catch(noop);
          }, function (e) {
            release();
            // A second accept is a 404 by predicate — say what that means rather
            // than showing "not found" for a row still on screen.
            toast(e && /not found/i.test(e.message || '')
              ? 'That suggestion was already handled — reload to see where it went.'
              : (e && e.message) || 'Could not apply the suggestion', 'error');
          });
        });
      });

      if (rej) rej.addEventListener('click', function () {
        var t = d._st.t;
        rej.disabled = true;
        if (acc) acc.disabled = true;
        api().rejectRevision(t.id, id).then(function () {
          toast('Suggestion declined');
          return updateDetail(d, t.id, { anchor: row }).catch(noop);
        }, function (e) {
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
  function wireParticipants(node, d) {
    if (!node || !node.querySelector) return;
    var sel = node.querySelector('.p86-st-part-user');
    var lvl = node.querySelector('.p86-st-part-lvl-sel');
    var go = node.querySelector('.p86-st-part-go');
    var already = {};
    Array.prototype.forEach.call(node.querySelectorAll('.p86-st-part'), function (p) {
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
      var t = d._st.t;
      if (!sel || !sel.value) return;
      go.disabled = true;
      api().addParticipant(t.id, sel.value, lvl ? lvl.value : 'view').then(function () {
        toast('Added to the ticket');
        // The picker is emptied first: while it holds a choice the update
        // leaves the section alone.
        sel.value = '';
        return updateDetail(d, t.id, { anchor: node }).catch(noop);
      }, function (e) {
        go.disabled = false;
        toast(e && e.message ? e.message : 'Could not add them', 'error');
      });
    });

    Array.prototype.forEach.call(node.querySelectorAll('.p86-st-part-rm'), function (btn) {
      btn.addEventListener('click', function () {
        var t = d._st.t;
        var uid = btn.parentNode && btn.parentNode.getAttribute('data-user');
        if (!uid) return;
        btn.disabled = true;
        api().removeParticipant(t.id, uid).then(function () {
          return updateDetail(d, t.id, { anchor: node }).catch(noop);
        }, function (e) {
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
  // While the New ticket box is up: does it hold anything typed or chosen.
  var _createTyped = null;

  function openCreate(opts) {
    var o = (opts && typeof opts === 'object' && !opts.target) ? opts : {};
    var leadId = o.leadId;
    var ed = editor();
    var prior = document.getElementById('p86StCreate');
    if (prior) prior.remove();
    var wrap = document.createElement('div');
    wrap.id = 'p86StCreate';
    wrap.className = 'p86-st-modal-back';
    wrap.innerHTML =
      '<div class="p86-st-modal" role="dialog" aria-modal="true" aria-labelledby="p86StCreateHead">' +
        '<div class="p86-st-modal-head" id="p86StCreateHead">New service ticket</div>' +
        '<label class="p86-st-lbl" for="p86StTitle">Title</label>' +
        '<input type="text" id="p86StTitle" data-st-field="title" maxlength="300" placeholder="e.g. Warranty call — gate will not latch" />' +
        '<label class="p86-st-lbl" for="p86StScope">Proposed scope</label>' +
        '<textarea id="p86StScope" data-st-field="scope_proposed" rows="4" placeholder="What needs doing, and where."></textarea>' +
        '<div class="p86-st-modal-row">' +
          '<div><label class="p86-st-lbl">Priority</label>' +
            select('p86-st-modal-prio', ['low', 'normal', 'high', 'urgent'], 'normal', PRIORITY_LABEL) + '</div>' +
          '<div><label class="p86-st-lbl" for="p86StSched">Scheduled</label>' +
            '<input type="date" id="p86StSched" data-st-field="scheduled_for" /></div>' +
        '</div>' +
        '<div class="p86-st-modal-row">' +
          '<div><label class="p86-st-lbl" for="p86StDue">Due</label>' +
            '<input type="date" id="p86StDue" data-st-field="due_date" /></div>' +
          '<div><label class="p86-st-lbl" for="p86StAssignee">Assigned to</label>' +
            '<select id="p86StAssignee" data-st-field="assignee_user_id">' +
              '<option value="" selected>Unassigned</option>' +
              '<option value="" disabled>Loading people…</option>' +
            '</select></div>' +
        '</div>' +
        '<div class="p86-st-save-err" role="alert" hidden></div>' +
        '<div class="p86-st-modal-actions">' +
          '<button class="ee-btn secondary" id="p86StCancel">Cancel</button>' +
          '<button class="ee-btn primary" id="p86StCreateGo">Create</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(wrap);
    var titleEl = wrap.querySelector('#p86StTitle');
    var prioEl = wrap.querySelector('.p86-st-modal-prio');
    if (prioEl) prioEl.setAttribute('data-st-field', 'priority');
    var whoEl = wrap.querySelector('#p86StAssignee');
    var errEl = wrap.querySelector('.p86-st-save-err');
    if (titleEl) titleEl.focus();

    // Only people who can open the job (or lead) are offered.
    var parent = leadId ? { kind: 'lead', id: leadId } : { kind: 'job', id: _state.jobId };
    function dropLoading() {
      Array.prototype.slice.call(whoEl.options).forEach(function (op) { if (op.disabled) op.remove(); });
    }
    if (whoEl) {
      if (ed && parent.id) Promise.resolve(ed.fillAssignees(whoEl, parent, null)).then(dropLoading, dropLoading);
      else dropLoading();
    }

    function val(sel) {
      var el = wrap.querySelector(sel);
      return el ? String(el.value || '') : '';
    }
    function typed() {
      return !!(val('#p86StTitle').trim() || val('#p86StScope').trim() || val('#p86StSched') ||
        val('#p86StDue') || val('#p86StAssignee') || (val('.p86-st-modal-prio') || 'normal') !== 'normal');
    }

    var closed = false;
    var asking = false;
    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey);
      if (_createTyped === typed) _createTyped = null;
      wrap.remove();
    }
    // Nothing typed: it just closes. Something typed: ask first.
    function askClose() {
      if (closed || asking) return;
      if (!typed()) { close(); return; }
      if (typeof window.p86Confirm !== 'function') {
        // Never native confirm(), which no-ops inside the installed PWA.
        toast('Clear what you typed, or create the ticket.', 'error');
        return;
      }
      asking = true;
      Promise.resolve(window.p86Confirm({
        title: 'Discard this new ticket?',
        message: 'What you typed will be lost.',
        confirmText: 'Discard',
        confirmLabel: 'Discard',
        cancelText: 'Keep editing',
        cancelLabel: 'Keep editing',
        destructive: true,
        danger: true
      })).then(function (yes) {
        asking = false;
        if (yes === true) close();
      }, function () { asking = false; });
    }
    function onKey(e) {
      if (e.key !== 'Escape' || asking || closed) return;
      e.preventDefault();
      askClose();
    }
    _createTyped = typed;
    document.addEventListener('keydown', onKey);
    wrap.addEventListener('click', function (e) { if (e.target === wrap) askClose(); });
    wrap.querySelector('#p86StCancel').addEventListener('click', askClose);

    function showErr(field, message) {
      if (ed) { ed.markInvalid(wrap, field, message); return; }
      errEl.textContent = message;
      errEl.hidden = false;
      var c = wrap.querySelector('[data-st-field="' + field + '"]');
      if (c) c.focus();
    }

    wrap.querySelector('#p86StCreateGo').addEventListener('click', function () {
      if (ed) ed.clearInvalid(wrap);
      else { errEl.textContent = ''; errEl.hidden = true; }
      var title = val('#p86StTitle').trim();
      if (!title) { showErr('title', 'Give the ticket a title.'); return; }
      var go = wrap.querySelector('#p86StCreateGo');
      go.disabled = true;
      var payload = {
        // Exactly one parent is set here. The other is filled in later by the
        // convert carry-forward, never by the client.
        job_id: leadId ? undefined : _state.jobId,
        lead_id: leadId || undefined,
        title: title,
        scope_proposed: val('#p86StScope'),
        priority: val('.p86-st-modal-prio') || 'normal',
        scheduled_for: val('#p86StSched') || null,
        due_date: val('#p86StDue') || null
      };
      var who = val('#p86StAssignee');
      if (/^\d+$/.test(who)) payload.assignee_user_id = Number(who);
      api().create(payload).then(function (r) {
        close();
        toast('Ticket created');
        // A ticket raised from a lead repaints the LEAD panel; the job
        // manager may not even be mounted.
        if (leadId) return mountLeadPanel(_leadPanel.host, leadId);
        _state.openId = r && r.ticket && r.ticket.id;
        return reload();
      }).catch(function (e) {
        go.disabled = false;
        var data = e && e.data;
        var field = data && typeof data.field === 'string' && /^[a-z_]+$/.test(data.field) ? data.field : '';
        if (e && e.status === 400 && field && wrap.querySelector('[data-st-field="' + field + '"]')) {
          showErr(field, data.error || e.message);
          return;
        }
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
    var jobId = _state.jobId;
    return api().list({ job_id: jobId }).then(function (r) {
      // A list for a job no longer on screen is not painted over the new one.
      if (String(_state.jobId) !== String(jobId)) return;
      _state.tickets = (r && r.tickets) || [];
      _state.listedJob = jobId;
      // The approval email and push link here as ?ticket=<id>, and the Service
      // Tickets page opens a ticket the same way (openTicket): open that ticket
      // once — and only if it IS one of this job's tickets, so a value from the
      // URL never reaches a selector. Consumed either way. One openTicket()
      // left for another job waits for that job.
      if (deepFor(jobId)) {
        var want = _deepTicket.ticketId;
        _deepTicket = null;
        var hit = ticketRow(want);
        if (hit) {
          _state.openId = String(hit.id);
          // A filter that hides it would open a ticket nobody can see.
          if (!matchesFilter(hit)) _state.filter = 'all';
          _state.scrollToOpen = true;
        } else {
          toast("That work order isn't in this job's list. It may have been archived.", 'error');
        }
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
    // A ticket waiting to open on some other job is not opened later, out of
    // the blue, when that job comes round again.
    if (_deepTicket && _deepTicket.jobId != null && !deepFor(jobId)) _deepTicket = null;
    // Back on the job already on screen (a tab switch): the list is refreshed
    // quietly, and a ticket holding edits is not touched at all — the refresh
    // waits for it, as a background refresh does.
    if (_state.jobId === jobId && host.querySelector('.p86-st-wrap')) {
      // Sent here to open one of its tickets (openTicket): asked about like a
      // click on another row.
      if (deepFor(jobId) && openDeepHere(host)) return;
      if (detailHoldsEdits(host)) {
        _state.stale = true;
        wireLatch(host);
        return;
      }
      reload();
      return;
    }
    // A different job means a different list; keep the expanded ticket only
    // while we are on the job it belongs to. Its unsaved changes are kept as a
    // draft for when it is opened again.
    if (_state.jobId !== jobId) {
      var open = openDetail();
      if (open) stashDraft(open);
      _state.jobId = jobId; _state.openId = null; _state.tickets = []; _state.listedJob = null;
    }
    host.innerHTML = '<div class="p86-st-empty">Loading service tickets…</div>';
    reload();
  }

  // openTicket() for the job already painted in the pane. Consumed now, so
  // nothing is left waiting to open on a later, unrelated reload.
  //   - The ticket is already the open one: it is scrolled into view and the
  //     caller goes on as on any return to the tab (returns false).
  //   - Another ticket: the open one's typed changes are asked about first,
  //     as a click on another row does. Go, and the list is read again with
  //     that ticket to open (a filter hiding it reset, a missing one told);
  //     Keep editing, and the open ticket stays as it is (returns true).
  function openDeepHere(host) {
    var want = String(_deepTicket.ticketId);
    var jobId = _state.jobId;
    _deepTicket = null;
    var kept = keptDetail(host);
    if (kept && String(_state.openId) === want) {
      var row = kept.closest('.p86-st-row');
      if (row && typeof row.scrollIntoView === 'function') {
        try { row.scrollIntoView({ block: 'start' }); } catch (e) { /* old engine */ }
      }
      return false;
    }
    leaveOpenTicket().then(function (go) {
      if (!go || String(_state.jobId) !== String(jobId)) return;
      _deepTicket = { jobId: String(jobId), ticketId: want };
      return reload();
    });
    return true;
  }

  // Leaving the page with unsaved changes asks first (the browser's own
  // question; its wording cannot be set).
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('beforeunload', function (e) {
      if (!hasUnsavedWork()) return;
      e.preventDefault();
      e.returnValue = '';
    });
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
    // The company-wide Service Tickets page is NOT refreshed from here: js/refresh.js
    // calls its own refresh (p86WorkOrdersBoard.refresh) beside this one, and a
    // second call from here would fetch that list twice for every write.
    return Promise.all(work);
  }

  // Open one work order on its job's Service Tickets tab (the Service Tickets
  // page calls this). The ticket is expanded once the job's list loads; a
  // filter hiding it is reset to All, and a ticket no longer on the list says so.
  //
  // openTicket(ticketId), with ONE argument, is the 1.29 form: it only marks
  // that ticket to open on the next job list loaded, whichever job that is, and
  // the caller navigates to the job itself. It returns true once marked.
  function openTicket(jobId, ticketId) {
    if (arguments.length < 2) {
      var only = jobId;
      if (only == null || only === '') return false;
      _deepTicket = { jobId: null, ticketId: String(only) };
      return true;
    }
    if (!jobId || ticketId == null || ticketId === '') return false;
    _deepTicket = { jobId: String(jobId), ticketId: String(ticketId) };
    var router = window.p86Router;
    if (router && typeof router.navigate === 'function') {
      router.navigate({ top: 'jobs', jobId: jobId, jobSub: 'job-service-tickets' });
      // A router that does not draw the tab again (already on that route)
      // leaves the link waiting: open it on the pane that is there.
      var host = pane();
      if (deepFor(jobId) && _deepTicket.jobId != null && String(_state.jobId) === String(jobId) &&
          host && host.querySelector('.p86-st-wrap')) {
        if (!openDeepHere(host)) {
          if (detailHoldsEdits(host)) { _state.stale = true; wireLatch(host); } else reload();
        }
      }
      return true;
    }
    try { if (typeof window.switchTab === 'function') window.switchTab('jobs'); } catch (e) { /* no tabs */ }
    if (typeof window.editJob === 'function') window.editJob(jobId);
    setTimeout(function () {
      try { if (typeof window.switchJobSubTab === 'function') window.switchJobSubTab('job-service-tickets'); } catch (e) { /* no tab */ }
    }, 60);
    return true;
  }

  window.p86ServiceTickets = {
    // The lead surfaces (js/leads.js calls both).
    mountLeadPanel: mountLeadPanel,
    createForLead: createForLead,
    refresh: refresh,
    openTicket: openTicket
  };
})();
