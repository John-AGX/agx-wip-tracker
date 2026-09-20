// ============================================================
// Project 86 — the Service Tickets page (sidebar → Operations → Service Tickets)
// ============================================================
// Every service ticket (work order) the signed-in person can see, across every
// job and lead, in one list. switchTab('service-tickets') (js/app.js) calls
// window.p86WorkOrdersBoard.render into #serviceTicketsHost on every visit.
// /work-orders, the name this list had while it was built, redirects here
// (js/router.js).
//
// It reads GET /api/service-tickets?board=1 — the SAME door the job's Service
// Tickets tab reads, so it lists exactly what the job tab would list for this
// person (server/services/service-ticket-board.js). Every filter is answered
// by the server, so the page pages through every ticket instead of filtering
// the newest few hundred in the browser. The rows are slim: no scope, no
// notes, no prices.
//
//   * Status pills — the job tab's own (All, Active, Draft, Scheduled, In
//     progress, Awaiting approval, Closed), matching what they match there —
//     and saved views (My approvals, Overdue, Due this week, Assigned to me,
//     Unassigned, No link sent, Flagged, Suggestions). Each shows its count
//     under the other filters, and the server counts them. A view is pressed
//     again to clear it.
//   * Priority, jobs or leads, search (debounced: title, job, lead, assignee,
//     WO # or address) and sort; Show more for the next 50. Every filter is
//     remembered in this browser, under the key the 1.29 page used.
//   * Quiet refresh on tab re-entry, when the window comes back after a minute,
//     and on a service_ticket write (js/refresh.js). A failed quiet refresh
//     keeps what is on screen.
//   * Rows are real links (/jobs/<job>/job-service-tickets?ticket=<id>), so a
//     middle-click or new tab works. A plain click opens the job's Service
//     Tickets tab with the ticket expanded (p86ServiceTickets.openTicket), and
//     a ticket on a lead opens the lead.
//   * Late responses are dropped by a sequence number, and keyboard focus
//     stays on the pill or row it was on when the list repaints.
//   * "Today" comes from the server in the user's zone, never this browser's
//     clock, so days late cannot be off by one at night.
//
// ── "My work" (1.33, re-keyed in 1.35) — the view that is NOT this door ───
// 1.33 took buildings off every task list: a building on a work order is not a
// to-do. 1.35 settled who is responsible for one, and the answer is that NO
// ONE is, personally. A building is never assigned to anybody. Responsibility
// sits on the RECORD — the work order's own Assigned to, which the office
// sets from a real dropdown — and everyone on that record is equally
// responsible for every building on its punch list.
//
// So this view is "the work orders assigned to ME that still have a building
// open". It is the FIRST view pill, and it reads a different endpoint:
// GET /api/service-tickets/my-buildings.
//
// It has to. Everything above is gated by access.listVisibility — the job
// access rule — and the person a work order is assigned to is deliberately
// allowed to finish a building on a job they cannot otherwise open. A view
// built on ?board=1 would show that person nothing, which is the exact
// failure this release exists to avoid. So My work is a CLIENT-ONLY view with
// no counterpart in server/services/service-ticket-board.js VIEWS, its own
// narrow record-keyed door, and its own row whitelist (MY_WORK_ROW_KEYS).
//
// The door's my_buildings_open / my_buildings_total / my_next_due KEPT THEIR
// NAMES in 1.35 and changed their meaning: they describe the WORK ORDER's own
// punch list, not one person's share of it — there is no such share. Nothing
// on this page may say "your buildings", and nothing here renders a
// per-building owner, picker, label or filter.
//
// Because that door is not gated on job access, a row here can name a job the
// caller cannot open. Its title is therefore plain text unless this browser
// has actually loaded the job, and the affordance is the buildings under the
// row: each one opens window.p86Tasks.openDetail(id), which is how anyone the
// work order is assigned to ticks it off (GET/PATCH /api/tasks/:id stay open
// to them).
(function () {
  'use strict';

  var PAGE = 50;
  var QUIET_AFTER_MS = 60 * 1000;
  // The 1.29 Service Tickets page kept { status, priority, parent, q } here, so
  // the filters people already chose carry over. view and sort ride along.
  var LS_KEY = 'p86_stp_filters';

  // The job tab's pills (FILTERS in js/service-tickets.js, less Mine, which is
  // the Assigned to me view here), each with the server's status group that
  // matches what the pill matches on the job tab.
  var STATUS_PILLS = [
    { id: 'all', label: 'All', group: 'all' },
    { id: 'active', label: 'Active', group: 'active' },
    { id: 'draft', label: 'Draft', group: 'draft' },
    { id: 'scheduled', label: 'Scheduled', group: 'scheduled' },
    { id: 'in_progress', label: 'In progress', group: 'in_progress' },
    { id: 'work_complete', label: 'Awaiting approval', group: 'awaiting_approval' },
    { id: 'closed', label: 'Closed', group: 'closed' }
  ];
  // attention: a count above zero is marked, so what needs someone stands out.
  // my_work is FIRST and is the client-only view described at the top of this
  // file: it reads my-buildings, not ?board=1, and has no entry in the
  // server's board VIEWS on purpose.
  var VIEWS = [
    { id: 'my_work', label: 'My work', attention: true, tip: 'Work orders assigned to you that still have a building open — including jobs you cannot otherwise open. Everyone assigned to a work order is responsible for every building on it.', empty: 'No work order assigned to you has a building open right now.' },
    { id: 'my_approvals', label: 'My approvals', attention: true, tip: 'Work complete and waiting for you: jobs you run, or tickets you raised, are assigned or sent the crew link for', empty: 'Nothing is waiting for your approval.' },
    { id: 'overdue', label: 'Overdue', attention: true, tip: "Past the due date and the crew isn't finished", empty: 'Nothing is overdue.' },
    { id: 'due_week', label: 'Due this week', tip: 'Due today or in the next 6 days, crew not finished', empty: 'Nothing is due in the next 7 days.' },
    { id: 'mine', label: 'Assigned to me', tip: 'Assigned to you and not closed or cancelled — every one, not only the ones with a building still open', empty: 'No open tickets are assigned to you.' },
    { id: 'unassigned', label: 'Unassigned', tip: 'Not finished and nobody is assigned', empty: 'Every unfinished ticket has an assignee.' },
    { id: 'no_link', label: 'No link sent', tip: 'Open, scheduled or in progress with no working crew link', empty: 'Every ticket in the field has a working crew link.' },
    { id: 'flagged', label: 'Flagged', attention: true, tip: "A crew reported a problem the office hasn't resolved", empty: 'No open problems reported by crews.' },
    { id: 'suggestions', label: 'Suggestions', tip: 'Crew suggestions waiting for the office', empty: 'No crew suggestions are waiting.' }
  ];
  var PRIORITY_OPTIONS = [
    { id: 'all', label: 'All priorities' },
    { id: 'urgent', label: 'Urgent' },
    { id: 'high', label: 'High' },
    { id: 'normal', label: 'Normal' },
    { id: 'low', label: 'Low' }
  ];
  var PARENT_OPTIONS = [
    { id: 'all', label: 'Jobs and leads' },
    { id: 'job', label: 'Jobs' },
    { id: 'lead', label: 'Leads' }
  ];
  // Newest first by default: the order the 1.29 page listed them in.
  var SORTS = [
    { id: 'created', label: 'Newest' },
    { id: 'due', label: 'Due date' },
    { id: 'priority', label: 'Priority' },
    { id: 'scheduled', label: 'Scheduled date' },
    { id: 'updated', label: 'Recently updated' }
  ];
  var STATUS_LABEL = {
    draft: 'Draft', open: 'Open', scheduled: 'Scheduled', in_progress: 'In progress',
    work_complete: 'Work complete', approved: 'Approved', closed: 'Closed', cancelled: 'Cancelled'
  };
  var PRIORITY_LABEL = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };
  var CREW_STATUSES = ['open', 'scheduled', 'in_progress'];
  var CHIP_STATUSES = ['open', 'scheduled', 'in_progress', 'work_complete'];
  // What a row may carry into this page. Anything else the server ever sends
  // is dropped here too.
  var ROW_KEYS = [
    'id', 'ticket_number', 'title', 'job_id', 'lead_id', 'status', 'priority',
    'scheduled_for', 'due_date', 'assignee_user_id', 'assignee_name',
    'completed_at', 'closed_at', 'created_at', 'updated_at', 'street_address', 'city',
    'job_number', 'job_title', 'lead_title', 'task_total', 'task_done',
    'pending_suggestions', 'links_total', 'links_live', 'links_opened',
    'last_crew_at', 'open_flags', 'office_seen_at', 'new_from_crew', 'is_overdue'
  ];
  // What a My work row may carry: the exact projection
  // GET /api/service-tickets/my-buildings answers with, and nothing else.
  // Anything the server ever adds to that body is dropped here too, which is
  // what keeps a price off this page even if one ever reaches the wire.
  // my_buildings_open / my_buildings_total / my_next_due are the WORK ORDER's
  // own open count, live count and next due date — 1.35 kept the names and
  // changed the meaning. They are never "mine": a building has no owner.
  var MY_WORK_ROW_KEYS = [
    'id', 'ticket_number', 'title', 'status', 'priority', 'scheduled_for', 'due_date',
    'street_address', 'city', 'job_id', 'lead_id', 'job_number', 'job_title', 'lead_title',
    'my_buildings_open', 'my_buildings_total', 'my_next_due', 'is_overdue', 'buildings'
  ];
  // And inside `buildings`, the work order's whole punch list: oldest first,
  // max 25. There is no assignee on a building row and never will be.
  var BUILDING_KEYS = ['id', 'title', 'status', 'due_date', 'completed_at'];
  // The column header, and the one My work uses instead. My work has no crew
  // badges (the door does not send them) and no ticket assignee column — every
  // row on it is already assigned to the caller.
  var COLS = ['', 'Ticket', 'Status', 'Scheduled', 'Due', 'Assignee', 'Buildings', 'Crew'];
  var MY_WORK_COLS = ['', 'Ticket', 'Status', 'Scheduled', 'Due', 'Where', 'Buildings open', ''];
  // What the view is, and then what it does not do. The first sentence is the
  // rule on screen: the work order is yours, its buildings belong to everyone
  // on it.
  var MY_WORK_NOTE = "Work orders assigned to you with a building still open. " +
    "Everyone assigned to a work order is equally responsible for every building on it. " +
    "Ordered by due date. Filters and search don't apply to My work.";

  function byId(list, id) {
    if (typeof id !== 'string') return null;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function lsGet(key) {
    try { return window.localStorage ? window.localStorage.getItem(key) : null; } catch (e) { return null; }
  }
  function lsSet(key, value) {
    try { if (window.localStorage) window.localStorage.setItem(key, value); } catch (e) { /* private window */ }
  }

  function defaults() {
    return { status: 'all', view: null, priority: 'all', parent: 'all', q: '', sort: 'created' };
  }

  // Each saved field is taken only if it is still a real choice; anything else
  // (junk, a retired id, not JSON) is the default.
  function readSaved() {
    var f = defaults();
    try {
      var raw = lsGet(LS_KEY);
      var saved = raw ? JSON.parse(raw) : null;
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        if (byId(STATUS_PILLS, saved.status)) f.status = saved.status;
        if (byId(VIEWS, saved.view)) f.view = saved.view;
        if (byId(PRIORITY_OPTIONS, saved.priority)) f.priority = saved.priority;
        if (byId(PARENT_OPTIONS, saved.parent)) f.parent = saved.parent;
        if (typeof saved.q === 'string') f.q = saved.q.trim().slice(0, 200);
        if (byId(SORTS, saved.sort)) f.sort = saved.sort;
      }
    } catch (e) { /* not JSON: defaults */ }
    return f;
  }

  // ?view=<id> on a full page load of this page (or of /work-orders, which
  // redirects here) opens that view with the other filters cleared, so the
  // link shows what it promised. Read once, then taken out of the address so a
  // reload does not clear the filters again.
  function takeDeepView() {
    try {
      if (!/^\/(?:service-tickets|work-orders)\/?$/.test(location.pathname)) return null;
      var sp = new URLSearchParams(location.search);
      if (!sp.has('view')) return null;
      var v = sp.get('view');
      sp.delete('view');
      var rest = sp.toString();
      try { history.replaceState(history.state, '', location.pathname + (rest ? '?' + rest : '') + location.hash); } catch (e) { /* no history */ }
      return byId(VIEWS, v) ? v : null;
    } catch (e) { return null; }
  }

  var _initial = readSaved();
  var _deepView = takeDeepView();
  if (_deepView) {
    var _sort = _initial.sort;
    _initial = defaults();
    _initial.sort = _sort;
    _initial.view = _deepView;
  }

  var _state = {
    status: _initial.status,
    view: _initial.view,
    priority: _initial.priority,
    parent: _initial.parent,
    q: _initial.q,
    sort: _initial.sort,
    rows: [],
    today: null,
    counts: null,
    statusCounts: null,
    total: null,
    hasMore: false,
    nextOffset: null,
    // The My work pill's number. The board's `counts` will never carry it —
    // my_work is not a server view — so it comes from its own count call and
    // stays null when that call fails (the pill then shows no number).
    myWorkCount: null,
    seq: 0,
    loadedAt: 0,
    stale: false,
    host: null,
    loading: false,
    error: false,
    searchTimer: null
  };

  function save() {
    lsSet(LS_KEY, JSON.stringify({
      status: _state.status, view: _state.view, priority: _state.priority,
      parent: _state.parent, q: _state.q, sort: _state.sort
    }));
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function clean(v) {
    return v == null ? '' : String(v).trim();
  }

  function api() {
    return (window.p86Api && window.p86Api.serviceTickets) || null;
  }

  function toast(msg, kind) {
    if (typeof window.p86Toast === 'function') { try { window.p86Toast(msg, kind); return; } catch (e) { /* fall through */ } }
    if (kind === 'error') console.error('[service-tickets-page] ' + msg);
  }

  // Copied from js/service-tickets.js (the reference): a DATE column is a
  // calendar day and is never shifted into a timezone; an instant is.
  function fmtDate(v) {
    if (!v) return '';
    var cal = /^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00(?:\.000)?Z)?$/.exec(String(v));
    var d = cal
      ? new Date(Number(cal[1]), Number(cal[2]) - 1, Number(cal[3]))
      : new Date(v);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // The calendar day a DATE value names, as 'YYYY-MM-DD', or ''.
  function calDayOf(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:$|T00:00:00(?:\.000)?Z$)/.exec(String(v == null ? '' : v));
    return m ? m[1] + '-' + m[2] + '-' + m[3] : '';
  }

  // Whole days from calendar day a to calendar day b, from the parts alone.
  function daysBetween(a, b) {
    var x = /^(\d{4})-(\d{2})-(\d{2})$/.exec(calDayOf(a));
    var y = /^(\d{4})-(\d{2})-(\d{2})$/.exec(calDayOf(b));
    if (!x || !y) return null;
    var ax = Date.UTC(Number(x[1]), Number(x[2]) - 1, Number(x[3]));
    var by = Date.UTC(Number(y[1]), Number(y[2]) - 1, Number(y[3]));
    return Math.round((by - ax) / 86400000);
  }

  // An instant, relative to now.
  function fmtAgo(v) {
    if (!v) return '';
    var s = String(v);
    var t = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) ? Date.parse(s.replace(' ', 'T') + 'Z') : Date.parse(s);
    if (isNaN(t)) return '';
    var mins = Math.floor((Date.now() - t) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours + ' h ago';
    var days = Math.floor(hours / 24);
    if (days < 2) return 'yesterday';
    if (days < 7) return days + ' days ago';
    return fmtDate(new Date(t).toISOString());
  }

  function plural(n, one, many) { return n === 1 ? one : many; }

  function pick(row) {
    var out = {};
    ROW_KEYS.forEach(function (k) { out[k] = row && row[k] !== undefined ? row[k] : null; });
    return out;
  }

  // The same whitelist, for the My work door — including inside `buildings`,
  // so an extra column on a building row cannot ride onto a crew screen
  // either.
  function pickMyWork(row) {
    var out = {};
    MY_WORK_ROW_KEYS.forEach(function (k) { out[k] = row && row[k] !== undefined ? row[k] : null; });
    out.buildings = Array.isArray(row && row.buildings)
      ? row.buildings.map(function (b) {
          var o = {};
          BUILDING_KEYS.forEach(function (k) { o[k] = b && b[k] !== undefined ? b[k] : null; });
          return o;
        })
      : [];
    return out;
  }

  // Is the My work view the one on screen?
  function myWork() { return _state.view === 'my_work'; }

  function hrefFor(r) {
    if (r.job_id) return '/jobs/' + encodeURIComponent(r.job_id) + '/job-service-tickets?ticket=' + encodeURIComponent(r.id);
    if (r.lead_id) return '/leads/' + encodeURIComponent(r.lead_id);
    return '#';
  }

  function loadedJob(jobId) {
    try {
      var jobs = (window.appData && window.appData.jobs) || [];
      for (var i = 0; i < jobs.length; i++) if (jobs[i] && String(jobs[i].id) === String(jobId)) return jobs[i];
    } catch (e) { /* no store */ }
    return null;
  }

  // Forward-facing names only: a job is its number and title, a lead its
  // title. A label the server could not name (a record not in this company)
  // says so; a raw id is never shown in its place.
  function parentLabel(r) {
    var L = window.p86JobLabel;
    if (r.job_id) {
      var n = clean(r.job_number);
      var t = clean(r.job_title);
      if (n || t) return { text: typeof L === 'function' ? L(n, t) : [n, t].filter(Boolean).join(' '), missing: false };
      var job = loadedJob(r.job_id);
      if (job && L && typeof L.fromJob === 'function') return { text: L.fromJob(job), missing: false };
      return { text: 'Job not found', missing: true };
    }
    if (r.lead_id) {
      var lt = clean(r.lead_title);
      return lt ? { text: 'Lead · ' + lt, missing: false } : { text: 'Lead not found', missing: true };
    }
    return { text: '—', missing: false };
  }

  function countOf(map, key) {
    if (!map || typeof map !== 'object' || map[key] == null) return null;
    var n = Number(map[key]);
    return isFinite(n) ? n : null;
  }

  function optionsHTML(list, selected) {
    return list.map(function (o) {
      return '<option value="' + esc(o.id) + '"' + (o.id === selected ? ' selected' : '') + '>' + esc(o.label) + '</option>';
    }).join('');
  }

  // ── markup ───────────────────────────────────────────────────────────
  // The shell is built once per host. The pills, the rows and the footer
  // repaint inside it, so the search box keeps its caret while the list
  // under it changes.
  function shellHTML() {
    return '<div class="p86-wob">' +
      '<div class="p86-wob-head">' +
        '<div class="p86-wob-titles">' +
          '<h2 class="p86-wob-h">Service Tickets</h2>' +
          '<div class="p86-wob-sub">Every service ticket across your jobs and leads</div>' +
          '<div class="p86-wob-total" aria-live="polite"></div>' +
        '</div>' +
        '<button type="button" class="ee-btn secondary p86-wob-refresh">Refresh</button>' +
      '</div>' +
      '<div class="p86-st-pills p86-wob-pills p86-wob-status" role="group" aria-label="Filter by status"></div>' +
      '<div class="p86-wob-viewsrow">' +
        '<span class="p86-wob-views-label" aria-hidden="true">Views</span>' +
        '<div class="p86-st-pills p86-wob-pills p86-wob-views" role="group" aria-label="Saved views"></div>' +
      '</div>' +
      // Only My work fills this: the door takes no filters, so the page says
      // so instead of leaving the dimmed controls unexplained.
      '<div class="p86-wob-note p86-wob-sub"></div>' +
      '<div class="p86-wob-controls">' +
        '<input type="search" class="p86-wob-search" placeholder="Search title, job, lead, assignee, WO # or address" aria-label="Search service tickets" value="' + esc(_state.q) + '">' +
        '<select class="p86-wob-select p86-wob-prio" aria-label="Priority">' + optionsHTML(PRIORITY_OPTIONS, _state.priority) + '</select>' +
        '<select class="p86-wob-select p86-wob-parent" aria-label="Jobs or leads">' + optionsHTML(PARENT_OPTIONS, _state.parent) + '</select>' +
        '<select class="p86-wob-select p86-wob-sort" aria-label="Sort service tickets">' + optionsHTML(SORTS, _state.sort) + '</select>' +
      '</div>' +
      '<div class="p86-wob-scroll">' +
        '<div class="p86-wob-colhead" aria-hidden="true">' + colheadHTML() + '</div>' +
        '<div class="p86-wob-list"></div>' +
      '</div>' +
      '<div class="p86-wob-foot"></div>' +
    '</div>';
  }

  function colheadHTML() {
    return (myWork() ? MY_WORK_COLS : COLS).map(function (h) {
      return '<span>' + esc(h) + '</span>';
    }).join('');
  }

  function statusPillsHTML() {
    // While My work is on the status does not narrow anything — but a status
    // pill is also the way back out of it (pressing one leaves My work), so
    // the pills stay pressable and are dimmed rather than disabled.
    var off = myWork();
    return STATUS_PILLS.map(function (p) {
      var on = !off && p.id === _state.status;
      var n = off ? null : countOf(_state.statusCounts, p.group);
      return '<button type="button" class="p86-st-pill' + (on ? ' active' : '') + (off ? ' p86-wob-dim' : '') +
        '" data-status="' + esc(p.id) + '"' +
        ' aria-pressed="' + (on ? 'true' : 'false') + '"' +
        (off ? ' title="' + esc('Leaves My work and lists ' + p.label.toLowerCase() + ' tickets') + '"' : '') + '>' +
        esc(p.label) + (n != null ? ' <span class="p86-st-pill-n">' + esc(n) + '</span>' : '') +
        '</button>';
    }).join('');
  }

  function viewPillsHTML() {
    return VIEWS.map(function (v) {
      var on = v.id === _state.view;
      // My work is not a server view, so its number comes from its own count
      // call; a failed count leaves the pill with no number at all.
      var n = v.id === 'my_work'
        ? (typeof _state.myWorkCount === 'number' && isFinite(_state.myWorkCount) ? _state.myWorkCount : null)
        : countOf(_state.counts, v.id);
      var hot = !!v.attention && n != null && n > 0;
      return '<button type="button" class="p86-st-pill' + (on ? ' active' : '') + (hot ? ' is-attention' : '') + '" data-view="' + esc(v.id) + '"' +
        ' aria-pressed="' + (on ? 'true' : 'false') + '"' + (v.tip ? ' title="' + esc(v.tip) + '"' : '') + '>' +
        esc(v.label) + (n != null ? ' <span class="p86-st-pill-n">' + esc(n) + '</span>' : '') +
        '</button>';
    }).join('');
  }

  function dueCell(r) {
    var date = fmtDate(r.due_date);
    if (r.is_overdue && date) {
      var late = daysBetween(r.due_date, _state.today);
      var text = date + (late != null && late > 0 ? ' · ' + late + ' ' + plural(late, 'day', 'days') + ' late' : '');
      return { cls: ' is-late', html: esc(text) };
    }
    if (date && _state.today && calDayOf(r.due_date) === _state.today && CREW_STATUSES.indexOf(r.status) >= 0) {
      return { cls: ' is-today', html: 'Due today' };
    }
    return { cls: '', html: date ? esc(date) : '—' };
  }

  // The attention badges on a row: the crew link, suggestions and problems
  // waiting, New from crew, and when the crew last did something.
  function chipsHTML(r) {
    if (CHIP_STATUSES.indexOf(r.status) < 0) return '';
    var chips = [];
    var total = Number(r.links_total) || 0;
    var live = Number(r.links_live) || 0;
    var opened = Number(r.links_opened) || 0;
    if (total === 0) chips.push('<span class="p86-wob-chip is-warn">No crew link</span>');
    else if (live === 0) chips.push('<span class="p86-wob-chip" title="Every link on this work order was turned off or has expired">Link off</span>');
    else if (opened > 0) chips.push('<span class="p86-wob-chip is-info">Link opened</span>');
    else chips.push('<span class="p86-wob-chip">Link sent</span>');
    var sugg = Number(r.pending_suggestions) || 0;
    if (sugg > 0) chips.push('<span class="p86-wob-chip is-info">' + esc(sugg === 1 ? '1 suggestion' : sugg + ' suggestions') + '</span>');
    var fl = Number(r.open_flags) || 0;
    if (fl > 0) chips.push('<span class="p86-wob-chip is-alert">' + esc(fl === 1 ? '1 problem flagged' : fl + ' problems flagged') + '</span>');
    if (r.new_from_crew === true) chips.push('<span class="p86-wob-chip is-info">New from crew</span>');
    var ago = fmtAgo(r.last_crew_at);
    if (ago) chips.push('<span class="p86-wob-chip is-quiet">' + esc('Crew ' + ago) + '</span>');
    return chips.join('');
  }

  // The five cells both row shapes draw the same way, in one copy: the
  // priority dot, the ticket, its status, its scheduled day and its due day.
  // Both callers pass the values they already computed, so nothing is
  // formatted twice.
  function leadCellsHTML(r, title, parent, status, due) {
    var prio = PRIORITY_LABEL[r.priority] ? r.priority : 'normal';
    return '<span class="p86-wob-cell p86-wob-c-prio"><span class="p86-wob-k">Priority</span><span class="p86-st-prio prio-' + esc(prio) + '" title="' + esc(PRIORITY_LABEL[prio] + ' priority') + '"></span></span>' +
      '<span class="p86-wob-cell p86-wob-c-main"><span class="p86-wob-k">Ticket</span>' +
        '<span class="p86-wob-titleline">' +
          (r.ticket_number ? '<span class="p86-st-num">' + esc(r.ticket_number) + '</span> ' : '') +
          '<span class="p86-wob-title">' + esc(title) + '</span>' +
        '</span>' +
        '<span class="p86-wob-job' + (parent.missing ? ' p86-wob-missing' : '') + '">' + esc(parent.text) + '</span>' +
      '</span>' +
      '<span class="p86-wob-cell p86-wob-c-status"><span class="p86-wob-k">Status</span><span class="p86-st-status st-' + esc(r.status) + '">' + esc(status) + '</span></span>' +
      '<span class="p86-wob-cell p86-wob-c-sched"><span class="p86-wob-k">Scheduled</span>' + (fmtDate(r.scheduled_for) ? esc(fmtDate(r.scheduled_for)) : '—') + '</span>' +
      '<span class="p86-wob-cell p86-wob-c-due' + due.cls + '"><span class="p86-wob-k">Due</span>' + due.html + '</span>';
  }

  function rowHTML(r) {
    var status = STATUS_LABEL[r.status] || String(r.status || '');
    var parent = parentLabel(r);
    var due = dueCell(r);
    var dueWords = fmtDate(r.due_date);
    var title = clean(r.title) || 'Untitled ticket';
    var label = title + ', ' + parent.text + ', ' + status + ', ' + (dueWords ? 'due ' + dueWords : 'no due date');
    var total = Number(r.task_total) || 0;
    var done = Number(r.task_done) || 0;
    return '<a class="p86-wob-row" href="' + esc(hrefFor(r)) + '" data-id="' + esc(r.id) + '" aria-label="' + esc(label) + '">' +
      leadCellsHTML(r, title, parent, status, due) +
      '<span class="p86-wob-cell p86-wob-c-assignee"><span class="p86-wob-k">Assignee</span>' +
        (r.assignee_name ? esc(r.assignee_name) : '<span class="p86-wob-dim">Unassigned</span>') + '</span>' +
      '<span class="p86-wob-cell p86-wob-c-bldg"><span class="p86-wob-k">Buildings</span>' +
        (total > 0
          ? '<span class="p86-wob-bldg-d">' + esc(done + '/' + total) + '</span><span class="p86-wob-bldg-m">' + esc(done + ' of ' + total + ' ' + plural(total, 'building', 'buildings')) + '</span>'
          : '—') +
      '</span>' +
      '<span class="p86-wob-cell p86-wob-c-crew"><span class="p86-wob-k">Crew</span>' + chipsHTML(r) + '</span>' +
    '</a>';
  }

  // ── My work rows ─────────────────────────────────────────────────────
  // The my-buildings door is not gated on job access, so the row may name a
  // job this browser cannot open. The link is kept ONLY when the job is
  // already loaded here (the same test openRow makes before handing the row
  // to the job's tab); otherwise the title is plain text and the buildings
  // under it are the affordance.
  //
  // A row is a WORK ORDER assigned to the caller. The buildings under it are
  // the work order's whole punch list — shared, unowned, and shown to every
  // person the record is assigned to in exactly the same words.
  function myWorkHref(r) {
    return r.job_id && loadedJob(r.job_id) ? hrefFor(r) : '';
  }

  // Where the work is, for someone who may not be able to open the job.
  function whereText(r) {
    var street = clean(r.street_address);
    var city = clean(r.city);
    if (street && city) return street + ', ' + city;
    return street || city || '—';
  }

  // The work order's punch list, one button per building. Clicking one opens
  // the task editor on it — the only route left to a building for someone who
  // cannot open its job, and the reason the removal did not strand anybody.
  // Every person the work order is assigned to sees the same list: no owner,
  // no "yours", no picker.
  function buildingsHTML(r) {
    var list = Array.isArray(r.buildings) ? r.buildings : [];
    if (!list.length) return '';
    var next = fmtDate(r.my_next_due);
    var lead = 'Punch list' + (next ? ' · next due ' + next : '');
    // p86-wob-c-crew is borrowed for its layout only (wrap, 4px gap) — this
    // strip sits OUTSIDE the row, and the page adds no stylesheet of its own.
    return '<div class="p86-wob-mw-bldgs p86-wob-c-crew"' +
      ' title="' + esc("Everyone this work order is assigned to is responsible for every building on it.") + '">' +
      '<span class="p86-wob-dim">' + esc(lead) + '</span>' +
      list.map(function (b) {
        var done = b.status === 'done';
        var name = clean(b.title) || 'Untitled building';
        var when = fmtDate(b.due_date);
        return '<button type="button" class="p86-wob-chip p86-wob-mw-bldg' + (done ? ' is-quiet' : '') + '"' +
          ' data-bldg="' + esc(b.id) + '"' +
          ' title="' + esc('Open ' + name) + '">' +
          esc(name + (done ? ' · done' : when ? ' · ' + when : '')) +
          '</button>';
      }).join('') +
    '</div>';
  }

  function myWorkRowHTML(r) {
    var status = STATUS_LABEL[r.status] || String(r.status || '');
    var parent = parentLabel(r);
    var due = dueCell(r);
    var dueWords = fmtDate(r.due_date);
    var title = clean(r.title) || 'Untitled ticket';
    var open = Number(r.my_buildings_open) || 0;
    var tot = Number(r.my_buildings_total) || 0;
    var href = myWorkHref(r);
    var label = title + ', ' + parent.text + ', ' + status + ', ' +
      open + ' of ' + tot + ' ' + plural(tot, 'building', 'buildings') + ' open, ' +
      (dueWords ? 'due ' + dueWords : 'no due date');
    var head = href
      ? '<a class="p86-wob-row" href="' + esc(href) + '" data-id="' + esc(r.id) + '" aria-label="' + esc(label) + '">'
      : '<div class="p86-wob-row" data-id="' + esc(r.id) + '" role="group" aria-label="' + esc(label) + '">';
    return '<div class="p86-wob-mw">' +
      head +
      leadCellsHTML(r, title, parent, status, due) +
      '<span class="p86-wob-cell p86-wob-c-assignee"><span class="p86-wob-k">Where</span>' + esc(whereText(r)) + '</span>' +
      '<span class="p86-wob-cell p86-wob-c-bldg"><span class="p86-wob-k">Buildings open</span>' +
        '<span class="p86-wob-bldg-d">' + esc(open + '/' + tot) + '</span>' +
        '<span class="p86-wob-bldg-m">' + esc(open + ' of ' + tot + ' ' + plural(tot, 'building', 'buildings') + ' open') + '</span>' +
      '</span>' +
      '<span class="p86-wob-cell p86-wob-c-crew"><span class="p86-wob-k">Crew</span></span>' +
      (href ? '</a>' : '</div>') +
      buildingsHTML(r) +
    '</div>';
  }

  // Anything narrowing the list besides a saved view.
  function filtered() {
    return _state.status !== 'all' || _state.priority !== 'all' || _state.parent !== 'all' || !!_state.q;
  }

  function emptyText() {
    var v = byId(VIEWS, _state.view);
    // Nothing narrows My work, so a remembered status or search never gets to
    // claim it did.
    if (myWork()) return v.empty;
    if (_state.q) return 'No tickets match “' + _state.q + '”' + (v ? ' in ' + v.label : '') + '.';
    if (v && !filtered()) return v.empty;
    if (v || filtered()) return 'No tickets match these filters.';
    return "No service tickets yet. Raise one from a job's Service Tickets tab or from a lead.";
  }

  function listHTML() {
    if (_state.error && !_state.rows.length) {
      return '<div class="p86-wob-state p86-wob-error">Couldn\'t load service tickets. ' +
        '<button type="button" class="ee-btn secondary p86-wob-retry">Try again</button></div>';
    }
    if (_state.loading && !_state.rows.length) return '<div class="p86-wob-state p86-st-loading">Loading service tickets…</div>';
    if (!_state.rows.length) return '<div class="p86-wob-state p86-st-empty">' + esc(emptyText()) + '</div>';
    var one = myWork() ? myWorkRowHTML : rowHTML;
    return _state.rows.map(function (r) { return one(r); }).join('');
  }

  function totalText() {
    var n = _state.total != null ? _state.total : _state.rows.length;
    if (_state.loading && !_state.rows.length) return '';
    return n + ' ' + plural(n, 'ticket', 'tickets');
  }

  function footHTML() {
    if (!_state.rows.length) return '';
    var shown = 'Showing ' + _state.rows.length + (_state.total != null ? ' of ' + _state.total : '');
    return '<span class="p86-wob-showing">' + esc(shown) + '</span>' +
      (_state.hasMore ? '<button type="button" class="ee-btn secondary p86-wob-more">Show more</button>' : '');
  }

  // Which repainted control holds keyboard focus, by what it is rather than
  // the element (the element is about to be replaced).
  function focusKey() {
    var host = _state.host;
    var a = document.activeElement;
    if (!host || !a || a === document.body || typeof a.getAttribute !== 'function' || !host.contains(a)) return null;
    var attrs = ['data-status', 'data-view', 'data-id', 'data-bldg'];
    for (var i = 0; i < attrs.length; i++) {
      if (a.hasAttribute(attrs[i])) return { attr: attrs[i], val: a.getAttribute(attrs[i]) };
    }
    if (a.classList && a.classList.contains('p86-wob-more')) return { more: true };
    return null;
  }

  function focusEl(el) {
    if (!el) return;
    try { el.focus({ preventScroll: true }); } catch (e) { /* defensive */ }
  }

  function refocus(k, firstNewId) {
    var host = _state.host;
    if (!k || !host || !host.isConnected) return;
    if (k.more) {
      // Show more is gone once the last page is in: the first row it added
      // takes the focus, so the keyboard carries on down the list.
      var btn = host.querySelector('.p86-wob-more');
      if (btn) { focusEl(btn); return; }
      if (firstNewId == null) return;
      k = { attr: 'data-id', val: String(firstNewId) };
    }
    var list = host.querySelectorAll('[' + k.attr + ']');
    for (var i = 0; i < list.length; i++) {
      if (list[i].getAttribute(k.attr) === k.val) { focusEl(list[i]); return; }
    }
  }

  function paint(firstNewId) {
    var host = _state.host;
    if (!host) return;
    var keep = focusKey();
    var q = function (sel) { return host.querySelector(sel); };
    var status = q('.p86-wob-status');
    if (status) status.innerHTML = statusPillsHTML();
    var views = q('.p86-wob-views');
    if (views) views.innerHTML = viewPillsHTML();
    var head = q('.p86-wob-colhead');
    if (head) head.innerHTML = colheadHTML();
    // My work takes no filters, no search and one order. The controls are
    // really disabled (not just dimmed) so nothing can be typed into a box
    // whose value would not be sent, and the note says why.
    var off = myWork();
    var note = q('.p86-wob-note');
    if (note) note.textContent = off ? MY_WORK_NOTE : '';
    ['.p86-wob-search', '.p86-wob-prio', '.p86-wob-parent', '.p86-wob-sort'].forEach(function (sel) {
      var el = q(sel);
      if (el) el.disabled = off;
    });
    var list = q('.p86-wob-list');
    if (list) list.innerHTML = listHTML();
    var foot = q('.p86-wob-foot');
    if (foot) foot.innerHTML = footHTML();
    var total = q('.p86-wob-total');
    if (total) total.textContent = totalText();
    var wrap = q('.p86-wob');
    if (wrap) wrap.classList.toggle('is-empty', !_state.rows.length);
    if (keep) refocus(keep, firstNewId);
  }

  // ── data ─────────────────────────────────────────────────────────────
  // The request for what is chosen. A status of All and a filter left on its
  // default are not sent at all.
  function paramsFor(limit, offset) {
    var params = { board: 1, view: _state.view || 'all', sort: _state.sort, limit: limit, offset: offset };
    var pill = byId(STATUS_PILLS, _state.status);
    if (pill && pill.id !== 'all') params.status_group = pill.group;
    if (_state.priority !== 'all') params.priority = _state.priority;
    if (_state.parent !== 'all') params.parent = _state.parent;
    if (_state.q) params.q = _state.q;
    if (offset === 0) params.include_counts = 1;
    return params;
  }

  // The My work pill's number. The board's `counts` cannot carry it, so it is
  // its own tiny call, fired beside every reset load and never blocking it. A
  // failure leaves the pill with no number rather than a wrong one.
  function loadMyWorkCount(my) {
    var a = api();
    if (!a || typeof a.myBuildings !== 'function') { _state.myWorkCount = null; return; }
    var p;
    try { p = Promise.resolve(a.myBuildings({ count_only: 1 })); } catch (e) { p = Promise.reject(e); }
    p.then(function (res) {
      if (my !== _state.seq) return;
      var n = res && res.total != null ? Number(res.total) : NaN;
      _state.myWorkCount = isFinite(n) ? n : null;
      paint();
    }, function () {
      if (my !== _state.seq) return;
      _state.myWorkCount = null;
      paint();
    });
  }

  // mode: 'reset' (a filter, view, sort or search changed; first load), 'more'
  // (next page, appended), 'quiet' (refetch what is on screen, keep it on
  // failure).
  function load(mode) {
    var a = api();
    var mine = myWork();
    // My work reads its own door; an older cached api.js without it degrades
    // to the error state instead of throwing.
    if (!a || typeof a.list !== 'function' || (mine && typeof a.myBuildings !== 'function')) {
      _state.error = true;
      paint();
      return Promise.resolve();
    }
    var my = ++_state.seq;
    var more = mode === 'more';
    var offset = more ? (_state.nextOffset || 0) : 0;
    var limit = mode === 'quiet' ? Math.min(100, Math.max(PAGE, _state.rows.length)) : PAGE;
    if (mode === 'reset') {
      _state.loading = true;
      _state.error = false;
      _state.rows = [];
      _state.hasMore = false;
      paint();
      loadMyWorkCount(my);
    }
    var p;
    try {
      // Status, priority, parent, search and sort are not sent on My work —
      // the door takes none of them.
      p = Promise.resolve(mine
        ? a.myBuildings({ limit: limit, offset: offset })
        : a.list(paramsFor(limit, offset)));
    } catch (e) { p = Promise.reject(e); }
    return p.then(function (res) {
      if (my !== _state.seq) return;
      var body = res || {};
      var rows = Array.isArray(body.tickets) ? body.tickets.map(mine ? pickMyWork : pick) : [];
      _state.rows = more ? _state.rows.concat(rows) : rows;
      if (body.today) _state.today = String(body.today);
      if (!more) {
        _state.counts = body.counts && typeof body.counts === 'object' ? body.counts : null;
        _state.statusCounts = body.status_counts && typeof body.status_counts === 'object' ? body.status_counts : null;
        _state.total = body.total != null && isFinite(Number(body.total)) ? Number(body.total) : null;
        // On My work the list body already carries the pill's number, so the
        // pill agrees with the rows under it even before the count answers.
        if (mine && _state.total != null) _state.myWorkCount = _state.total;
      }
      _state.hasMore = body.has_more === true;
      _state.nextOffset = body.next_offset != null ? Number(body.next_offset) : null;
      _state.loading = false;
      _state.error = false;
      _state.stale = false;
      _state.loadedAt = Date.now();
      paint(more && rows.length ? rows[0].id : null);
    }, function (err) {
      if (my !== _state.seq) return;
      _state.loading = false;
      if (mode === 'quiet' && _state.rows.length) {
        toast("Couldn't refresh service tickets — showing what was loaded before.", 'error');
      } else if (more) {
        toast("Couldn't load more service tickets. Try again.", 'error');
      } else {
        _state.rows = [];
        _state.error = true;
        if (err && console && console.warn) console.warn('[service-tickets-page] load failed', err && err.message);
      }
      paint();
    });
  }

  function paneActive() {
    var pane = document.getElementById('service-tickets');
    return !!(pane && pane.classList.contains('active'));
  }

  // ── row open ─────────────────────────────────────────────────────────
  // The navigation seam: a full page load to the link. Kept on the export so a
  // test can observe it (jsdom cannot navigate).
  function assign(href) {
    var self = window.p86WorkOrdersBoard;
    if (self && typeof self._assign === 'function') { self._assign(href); return; }
    window.location.assign(href);
  }

  // A job this browser has loaded opens in the app: openTicket(jobId, ticketId)
  // goes to the job's Service Tickets tab and expands the ticket once its list
  // loads. Any other job is a full load of the row's link, which does the same
  // from the ?ticket= in the address.
  function openRow(r, href) {
    if (r.job_id) {
      var st = window.p86ServiceTickets;
      if (loadedJob(r.job_id) && st && typeof st.openTicket === 'function') {
        try {
          if (st.openTicket(r.job_id, r.id) !== false) return;
        } catch (e) { /* fall back to the link */ }
      }
      assign(href);
      return;
    }
    if (r.lead_id) {
      var router = window.p86Router;
      if (router && typeof router.go === 'function' && router.go('/leads/' + r.lead_id)) return;
      if (typeof window.openEditLeadModal === 'function') { window.openEditLeadModal(r.lead_id); return; }
      assign(href);
    }
  }

  function rowById(id) {
    for (var i = 0; i < _state.rows.length; i++) if (String(_state.rows[i].id) === String(id)) return _state.rows[i];
    return null;
  }

  // THE WAY IN, and the reason 1.33's removal stranded nobody. Buildings are
  // off every task list now, so this button is the route to one on a work
  // order assigned to the caller — on a job they may not be able to open at
  // all. js/tasks.js openDetail reads GET /api/tasks/:id and saves through
  // PATCH /api/tasks/:id, both of which stay open to the person the WORK
  // ORDER is assigned to (1.35: the building itself is assigned to nobody).
  // The guard is load-bearing: js/tasks.js is not on every screen this page
  // can be reached from, and a missing editor must be a sentence, not a throw.
  function openBuilding(id) {
    if (id == null || id === '') return;
    var t = window.p86Tasks;
    if (t && typeof t.openDetail === 'function') {
      try { t.openDetail(id); return; } catch (e) { /* fall through to the toast */ }
    }
    toast("Couldn't open that building. Reload the page and try again.", 'error');
  }

  function wire(host) {
    host.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || typeof t.closest !== 'function') return;
      var bldg = t.closest('.p86-wob-mw-bldg');
      if (bldg) {
        e.preventDefault();
        openBuilding(bldg.getAttribute('data-bldg'));
        return;
      }
      var pill = t.closest('.p86-wob-status [data-status]');
      if (pill) {
        var s = pill.getAttribute('data-status');
        if (!byId(STATUS_PILLS, s)) return;
        // A status pill is the way back out of My work: pressing one leaves
        // the view and lists that status through the board door again.
        if (myWork()) _state.view = null;
        _state.status = s;
        save();
        load('reset');
        return;
      }
      var viewPill = t.closest('.p86-wob-views [data-view]');
      if (viewPill) {
        var v = viewPill.getAttribute('data-view');
        if (!byId(VIEWS, v)) return;
        // Pressing the view that is on turns it off.
        _state.view = _state.view === v ? null : v;
        save();
        load('reset');
        return;
      }
      if (t.closest('.p86-wob-more')) { load('more'); return; }
      if (t.closest('.p86-wob-retry')) { load('reset'); return; }
      if (t.closest('.p86-wob-refresh')) { load(_state.rows.length ? 'quiet' : 'reset'); return; }
      var a = t.closest('a.p86-wob-row');
      if (a) {
        // A modified click is the browser's: new tab, new window, download.
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        var r = rowById(a.getAttribute('data-id'));
        if (!r) return;
        e.preventDefault();
        openRow(r, a.getAttribute('href'));
      }
    });
    var search = host.querySelector('.p86-wob-search');
    if (search) {
      search.addEventListener('input', function () {
        if (_state.searchTimer) clearTimeout(_state.searchTimer);
        _state.searchTimer = setTimeout(function () {
          _state.searchTimer = null;
          var next = String(search.value || '').trim().slice(0, 200);
          if (next === _state.q) return;
          _state.q = next;
          save();
          load('reset');
        }, 300);
      });
    }
    host.addEventListener('change', function (e) {
      var el = e.target;
      if (!el || !el.classList) return;
      if (el.classList.contains('p86-wob-prio')) {
        if (!byId(PRIORITY_OPTIONS, el.value)) return;
        _state.priority = el.value;
      } else if (el.classList.contains('p86-wob-parent')) {
        if (!byId(PARENT_OPTIONS, el.value)) return;
        _state.parent = el.value;
      } else if (el.classList.contains('p86-wob-sort')) {
        if (!byId(SORTS, el.value)) return;
        _state.sort = el.value;
      } else {
        return;
      }
      save();
      load('reset');
    });
  }

  // ── public ───────────────────────────────────────────────────────────
  function render(host) {
    host = host || document.getElementById('serviceTicketsHost');
    if (!host) return Promise.resolve();
    var fresh = _state.host !== host || !host.querySelector('.p86-wob');
    _state.host = host;
    if (fresh) {
      host.innerHTML = shellHTML();
      wire(host);
      return load('reset');
    }
    // Tab re-entry: what was loaded, at once, then a quiet refetch.
    paint();
    return load(_state.rows.length ? 'quiet' : 'reset');
  }

  // js/refresh.js calls this after a service_ticket write. Off screen it only
  // remembers; the next visit refetches.
  function refresh() {
    if (!_state.host || !_state.host.isConnected || !paneActive()) {
      _state.stale = true;
      return Promise.resolve();
    }
    paint();
    return load(_state.rows.length ? 'quiet' : 'reset');
  }

  try {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible' || !_state.host || !paneActive()) return;
      if (Date.now() - _state.loadedAt > QUIET_AFTER_MS) load(_state.rows.length ? 'quiet' : 'reset');
    });
  } catch (e) { /* no document events */ }

  window.p86WorkOrdersBoard = {
    render: render,
    refresh: refresh,
    _assign: null,
    // For tests: copies of the rows this page holds, after the whitelist.
    _rows: function () { return _state.rows.map(function (r) { return Object.assign({}, r); }); }
  };
})();
