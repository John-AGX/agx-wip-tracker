// ============================================================
// Project 86 — Service Tickets page (sidebar → Operations → Service Tickets)
// ------------------------------------------------------------
// The org-wide list of work orders: every service ticket the caller may see,
// across all jobs and leads, newest first. The job's Service Tickets tab
// (js/service-tickets.js) is still where a ticket is opened, edited and moved
// along its status line; this page finds it and takes you there.
//
// switchTab('service-tickets') (js/app.js) calls
// window.p86ServiceTicketsPage.render(host) into #serviceTicketsHost on every
// visit. js/service-tickets.js refresh() calls refresh() after an agent write,
// which refetches only while this page is the one on screen.
//
// WHAT THE SERVER DECIDES AND WHAT THIS PAGE DECIDES
// GET /api/service-tickets already answers only the tickets this caller may
// see (listVisibility in server/services/service-ticket-access.js) and names
// each ticket's job, lead and assignee (job_number, job_title, lead_title,
// assignee_name) from rows in the ticket's own organization. Every filter here
// is CLIENT-SIDE over that one fetch: the server's `status` parameter takes one
// real status and turns anything else into 'draft', so a status GROUP such as
// Active must never be sent to it.
//
// Loaded AFTER api.js and job-label.js; js/service-tickets.js and js/router.js
// are looked up at click time, so load order between them does not matter.
// ============================================================
(function () {
  'use strict';

  var LIMIT = 200;
  var LS_KEY = 'p86_stp_filters';

  // Copied from js/service-tickets.js so the two lists name a status the same
  // way and a pill means the same thing on both.
  var STATUS_LABEL = {
    draft: 'Draft', open: 'Open', scheduled: 'Scheduled', in_progress: 'In progress',
    work_complete: 'Work complete', approved: 'Approved', closed: 'Closed', cancelled: 'Cancelled'
  };
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
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function statusMatches(t, f) {
    if (f === 'all') return true;
    if (f === 'active') return ['open', 'scheduled', 'in_progress', 'work_complete'].indexOf(t.status) >= 0;
    if (f === 'closed') return t.status === 'closed' || t.status === 'cancelled';
    return t.status === f;
  }

  function ids(list) { return list.map(function (o) { return o.id; }); }

  // ── state ───────────────────────────────────────────────────────────
  // tickets === null means "never loaded": only then does the page say
  // Loading…. Every later visit refetches with the last list still showing.
  var _state = { host: null, root: null, tickets: null, error: null, seq: 0, filters: readFilters() };

  function defaultFilters() { return { status: 'all', priority: 'all', parent: 'all', q: '' }; }

  function readFilters() {
    var f = defaultFilters();
    try {
      var raw = window.localStorage && window.localStorage.getItem(LS_KEY);
      var saved = raw ? JSON.parse(raw) : null;
      if (saved && typeof saved === 'object') {
        if (ids(FILTERS).indexOf(saved.status) >= 0) f.status = saved.status;
        if (ids(PRIORITY_OPTIONS).indexOf(saved.priority) >= 0) f.priority = saved.priority;
        if (ids(PARENT_OPTIONS).indexOf(saved.parent) >= 0) f.parent = saved.parent;
        if (typeof saved.q === 'string') f.q = saved.q.slice(0, 200);
      }
    } catch (e) { /* no storage: defaults */ }
    return f;
  }

  function saveFilters() {
    try {
      if (window.localStorage) window.localStorage.setItem(LS_KEY, JSON.stringify(_state.filters));
    } catch (e) { /* storage full or blocked: the filters still apply this visit */ }
  }

  // ── text ────────────────────────────────────────────────────────────
  function localEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // The shared escaper when there is one, and quotes escaped either way: every
  // value below also lands inside an attribute.
  function esc(s) {
    var str = String(s == null ? '' : s);
    if (typeof window.escapeHTML === 'function') {
      try {
        var out = window.escapeHTML(str);
        if (typeof out === 'string') return out.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      } catch (e) { /* fall through */ }
    }
    return localEsc(str);
  }

  function clean(v) {
    if (v == null) return '';
    return String(v).trim();
  }

  // due_date and scheduled_for are CALENDAR days (DATE columns). new Date on
  // 'YYYY-MM-DD' parses UTC midnight and shows the day before anywhere west of
  // Greenwich, so the day is built from its own parts. A DATE serialized by pg
  // arrives as ...T00:00:00.000Z and names the same day.
  function calendarDayText(v) {
    if (!v) return '';
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00(?:\.000)?Z)?$/.exec(String(v));
    if (!m) return '';
    var y = Number(m[1]);
    var mo = Number(m[2]);
    var d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return '';
    return dayText(y, mo - 1, d);
  }

  // updated_at is an INSTANT (TIMESTAMPTZ): shown as the viewer's local day.
  function instantDayText(v) {
    if (!v) return '';
    var dt = new Date(v);
    if (isNaN(dt.getTime())) return '';
    return dayText(dt.getFullYear(), dt.getMonth(), dt.getDate());
  }

  function dayText(y, monthIndex, d) {
    var s = MONTHS[monthIndex] + ' ' + d;
    return y === new Date().getFullYear() ? s : s + ', ' + y;
  }

  function parentKind(t) {
    if (t.job_id != null && t.job_id !== '') return 'job';
    if (t.lead_id != null && t.lead_id !== '') return 'lead';
    return null;
  }

  // Forward-facing names only: a job is its number and title, a lead its
  // title. A label the server could not find (null) says so; a raw id is never
  // shown in its place.
  function parentText(t) {
    var kind = parentKind(t);
    if (kind === 'job') {
      var n = clean(t.job_number);
      var ti = clean(t.job_title);
      if (!n && !ti) return 'Job not found';
      return typeof window.p86JobLabel === 'function'
        ? window.p86JobLabel(n, ti)
        : [n, ti].filter(Boolean).join(' ');
    }
    if (kind === 'lead') {
      var lt = clean(t.lead_title);
      return lt ? 'Lead · ' + lt : 'Lead not found';
    }
    return '—';
  }

  function searchMatches(t, q) {
    if (!q) return true;
    var hay = [t.title, t.job_number, t.job_title, t.lead_title, t.assignee_name]
      .map(function (v) { return clean(v).toLowerCase(); }).join('\n');
    return hay.indexOf(q) >= 0;
  }

  // Everything except status, so a pill's count is how many the pill would
  // show under the priority, parent and search already chosen.
  function otherFiltersMatch(t) {
    var f = _state.filters;
    if (f.priority !== 'all' && (t.priority || 'normal') !== f.priority) return false;
    if (f.parent !== 'all' && parentKind(t) !== f.parent) return false;
    return searchMatches(t, clean(f.q).toLowerCase());
  }

  // ── styles ──────────────────────────────────────────────────────────
  function ensureStyles() {
    if (document.getElementById('p86stp-styles')) return;
    var st = document.createElement('style');
    st.id = 'p86stp-styles';
    st.textContent =
      '.stp-page{max-width:1280px;margin:0 auto;padding:8px 4px 40px;color:var(--text);}' +
      '.stp-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px;}' +
      '.stp-title{font-size:17px;font-weight:700;margin:0;color:var(--text);}' +
      '.stp-summary{font-size:12.5px;color:var(--text-dim);}' +
      '.stp-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:12px;}' +
      '.stp-controls{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}' +
      '.stp-select,.stp-search{width:auto;background:var(--input-bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px;padding:6px 9px;font-family:inherit;}' +
      '.stp-search{min-width:200px;}' +
      '.stp-select:focus,.stp-search:focus{outline:none;border-color:var(--accent);}' +
      '.stp-note{font-size:12px;color:var(--text-dim);margin:0 0 8px;}' +
      '.stp-error{font-size:13px;color:var(--red);margin:0 0 8px;}' +
      '.stp-empty{border:1px dashed var(--border);border-radius:10px;padding:34px;text-align:center;color:var(--text-dim);font-size:13px;}' +
      '.stp-table-wrap{overflow-x:auto;border:1px solid var(--border);border-radius:10px;background:var(--card-bg);}' +
      '.stp-table{width:100%;border-collapse:collapse;font-size:12.5px;}' +
      '.stp-table th{text-align:left;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--text-dim);padding:9px 10px;border-bottom:1px solid var(--border);white-space:nowrap;}' +
      '.stp-table td{padding:9px 10px;border-bottom:1px solid var(--border);vertical-align:middle;color:var(--text);}' +
      '.stp-table tbody tr:last-child td{border-bottom:0;}' +
      '.stp-row{cursor:pointer;}' +
      '.stp-row:hover{background:var(--row-hover);}' +
      '.stp-row:focus{outline:none;}' +
      '.stp-row:focus-visible{outline:2px solid var(--accent);outline-offset:-2px;}' +
      '.stp-c-prio{width:18px;}' +
      '.stp-table .p86-st-prio{display:inline-block;vertical-align:middle;}' +
      '.stp-c-title{font-weight:600;min-width:180px;}' +
      '.stp-c-parent{min-width:160px;}' +
      '.stp-c-dim{color:var(--text-dim);white-space:nowrap;}' +
      '.stp-c-num{font-variant-numeric:tabular-nums;white-space:nowrap;}' +
      '.stp-missing{color:var(--text-dim);font-style:italic;}' +
      '.stp-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;}' +
      '@media (max-width:760px){' +
        '.stp-search{min-width:0;flex:1 1 100%;}' +
        '.stp-select{flex:1 1 auto;}' +
        '.stp-controls{width:100%;}' +
        '.stp-table-wrap{border:0;background:transparent;overflow:visible;}' +
        '.stp-table thead{display:none;}' +
        '.stp-table,.stp-table tbody,.stp-table tr,.stp-table td{display:block;width:100%;box-sizing:border-box;}' +
        '.stp-row{border:1px solid var(--border);border-radius:10px;background:var(--card-bg);margin-bottom:10px;padding:8px 12px;position:relative;}' +
        '.stp-table td{border:0;padding:3px 0;display:flex;gap:10px;align-items:baseline;}' +
        '.stp-table td[data-label]::before{content:attr(data-label);flex:0 0 84px;font-size:10.5px;text-transform:uppercase;letter-spacing:.3px;color:var(--text-dim);}' +
        '.stp-table td.stp-c-prio{position:absolute;top:14px;right:12px;width:auto;padding:0;}' +
        '.stp-table td.stp-c-prio::before{display:none;}' +
        '.stp-table td.stp-c-title{font-size:14px;padding:2px 24px 6px 0;min-width:0;}' +
        '.stp-table td.stp-c-title::before{display:none;}' +
      '}';
    document.head.appendChild(st);
  }

  // ── paint ───────────────────────────────────────────────────────────
  function optionsHTML(list, selected) {
    return list.map(function (o) {
      return '<option value="' + esc(o.id) + '"' + (o.id === selected ? ' selected' : '') + '>' + esc(o.label) + '</option>';
    }).join('');
  }

  // The shell is built once per host. Filters and the list repaint inside it,
  // so the search box keeps its caret while the list under it changes.
  function buildShell(host) {
    var f = _state.filters;
    host.innerHTML =
      '<div class="stp-page">' +
        '<div class="stp-head">' +
          '<h2 class="stp-title">Service Tickets</h2>' +
          '<div class="stp-summary" aria-live="polite"></div>' +
        '</div>' +
        '<div class="stp-bar">' +
          '<div class="stp-pills p86-st-pills" role="group" aria-label="Filter by status"></div>' +
          '<div class="stp-controls">' +
            '<select class="stp-select stp-prio" aria-label="Priority">' + optionsHTML(PRIORITY_OPTIONS, f.priority) + '</select>' +
            '<select class="stp-select stp-parent" aria-label="Jobs or leads">' + optionsHTML(PARENT_OPTIONS, f.parent) + '</select>' +
            '<input type="search" class="stp-search" placeholder="Search title, job, lead or assignee" aria-label="Search tickets" value="' + esc(f.q) + '">' +
          '</div>' +
        '</div>' +
        '<div class="stp-body"></div>' +
      '</div>';
    var root = host.querySelector('.stp-page');
    _state.host = host;
    _state.root = root;
    wire(root);
  }

  // A repaint replaces the pills and the rows. The one that had keyboard focus
  // (the pill just pressed, a row a refetch redrew) is found again by its data
  // attribute and focused, so focus never drops to <body>.
  function paint() {
    var keep = focusedKey();
    paintNow();
    if (keep) refocus(keep);
  }

  function focusedKey() {
    var root = _state.root;
    var a = document.activeElement;
    if (!root || !a || !a.classList || !root.contains(a)) return null;
    if (a.classList.contains('stp-pill')) return { cls: 'stp-pill', attr: 'data-filter', val: a.getAttribute('data-filter') };
    if (a.classList.contains('stp-row')) return { cls: 'stp-row', attr: 'data-ticket', val: a.getAttribute('data-ticket') };
    return null;
  }

  function refocus(k) {
    var root = _state.root;
    if (!root || !root.isConnected) return;
    var list = root.querySelectorAll('.' + k.cls);
    for (var i = 0; i < list.length; i++) {
      if (list[i].getAttribute(k.attr) === k.val) {
        try { list[i].focus({ preventScroll: true }); } catch (e) { /* defensive */ }
        return;
      }
    }
  }

  function paintNow() {
    var root = _state.root;
    if (!root || !root.isConnected) return;
    var body = root.querySelector('.stp-body');
    var pillsEl = root.querySelector('.stp-pills');
    var summary = root.querySelector('.stp-summary');
    var tickets = _state.tickets;
    var f = _state.filters;

    if (tickets == null) {
      pillsEl.innerHTML = '';
      summary.textContent = '';
      body.innerHTML = _state.error
        ? '<div class="stp-error">Could not load service tickets: ' + esc(_state.error) + '</div>'
        : '<div class="stp-empty">Loading…</div>';
      return;
    }

    var pool = tickets.filter(otherFiltersMatch);
    var shown = pool.filter(function (t) { return statusMatches(t, f.status); });

    pillsEl.innerHTML = FILTERS.map(function (p) {
      var n = pool.filter(function (t) { return statusMatches(t, p.id); }).length;
      var on = f.status === p.id;
      return '<button type="button" class="stp-pill p86-st-pill' + (on ? ' active' : '') + '" data-filter="' + esc(p.id) + '"' +
        ' aria-pressed="' + (on ? 'true' : 'false') + '">' + esc(p.label) +
        ' <span class="stp-pill-n p86-st-pill-n">' + n + '</span></button>';
    }).join('');

    summary.textContent = tickets.length === 0
      ? ''
      : (shown.length === tickets.length
        ? tickets.length + (tickets.length === 1 ? ' ticket' : ' tickets')
        : 'Showing ' + shown.length + ' of ' + tickets.length + ' tickets');

    var notes =
      (_state.error ? '<div class="stp-error">Could not load service tickets: ' + esc(_state.error) + '</div>' : '') +
      (tickets.length >= LIMIT ? '<div class="stp-note">Showing the newest ' + LIMIT + ' tickets.</div>' : '');

    if (!tickets.length) {
      body.innerHTML = notes + '<div class="stp-empty">No service tickets yet. Raise one from a job\'s Service Tickets tab or from a lead.</div>';
      return;
    }
    if (!shown.length) {
      body.innerHTML = notes + '<div class="stp-empty">No tickets match these filters.</div>';
      return;
    }
    body.innerHTML = notes +
      '<div class="stp-table-wrap"><table class="stp-table">' +
        '<thead><tr>' +
          '<th class="stp-c-prio"><span class="stp-sr">Priority</span></th>' +
          '<th>Ticket</th><th>Job / Lead</th><th>Status</th><th>Tasks</th>' +
          '<th>Scheduled</th><th>Due</th><th>Assignee</th><th>Updated</th>' +
        '</tr></thead>' +
        '<tbody>' + shown.map(rowHTML).join('') + '</tbody>' +
      '</table></div>';
  }

  function rowHTML(t) {
    var prio = PRIORITY_LABEL[t.priority] ? t.priority : 'normal';
    var total = Number(t.task_total || 0);
    var done = Number(t.task_done || 0);
    var parent = parentText(t);
    var missing = parent === 'Job not found' || parent === 'Lead not found';
    var sched = calendarDayText(t.scheduled_for);
    var due = calendarDayText(t.due_date);
    var who = clean(t.assignee_name);
    var updated = instantDayText(t.updated_at);
    return '<tr class="stp-row" tabindex="0" role="link" data-ticket="' + esc(t.id) + '">' +
      '<td class="stp-c-prio" data-label="Priority"><span class="p86-st-prio prio-' + esc(prio) + '" title="' + esc(PRIORITY_LABEL[prio]) + ' priority"></span>' +
        '<span class="stp-sr">' + esc(PRIORITY_LABEL[prio]) + ' priority</span></td>' +
      '<td class="stp-c-title">' + esc(clean(t.title) || 'Untitled ticket') + '</td>' +
      '<td class="stp-c-parent" data-label="Job / Lead">' + (missing ? '<span class="stp-missing">' + esc(parent) + '</span>' : esc(parent)) + '</td>' +
      '<td data-label="Status"><span class="p86-st-status st-' + esc(t.status) + '">' + esc(STATUS_LABEL[t.status] || t.status) + '</span></td>' +
      '<td class="stp-c-num" data-label="Tasks">' + (total ? done + '/' + total : '—') + '</td>' +
      '<td class="stp-c-dim" data-label="Scheduled">' + (sched ? esc(sched) : '—') + '</td>' +
      '<td class="stp-c-dim" data-label="Due">' + (due ? esc(due) : '—') + '</td>' +
      '<td data-label="Assignee">' + (who ? esc(who) : '—') + '</td>' +
      '<td class="stp-c-dim" data-label="Updated">' + (updated ? esc(updated) : '—') + '</td>' +
    '</tr>';
  }

  // ── events ──────────────────────────────────────────────────────────
  function wire(root) {
    root.addEventListener('click', function (ev) {
      var pill = ev.target.closest && ev.target.closest('.stp-pill');
      if (pill && root.contains(pill)) {
        var id = pill.getAttribute('data-filter');
        if (ids(FILTERS).indexOf(id) >= 0) {
          _state.filters.status = id;
          saveFilters();
          paint();
        }
        return;
      }
      var row = ev.target.closest && ev.target.closest('.stp-row');
      if (row && root.contains(row)) activateRow(row);
    });
    root.addEventListener('keydown', function (ev) {
      var row = ev.target && ev.target.classList && ev.target.classList.contains('stp-row') ? ev.target : null;
      if (!row) return;
      if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
        ev.preventDefault();
        activateRow(row);
      }
    });
    root.addEventListener('change', function (ev) {
      var el = ev.target;
      if (!el || !el.classList) return;
      if (el.classList.contains('stp-prio') && ids(PRIORITY_OPTIONS).indexOf(el.value) >= 0) {
        _state.filters.priority = el.value;
      } else if (el.classList.contains('stp-parent') && ids(PARENT_OPTIONS).indexOf(el.value) >= 0) {
        _state.filters.parent = el.value;
      } else {
        return;
      }
      saveFilters();
      paint();
    });
    root.addEventListener('input', function (ev) {
      var el = ev.target;
      if (!el || !el.classList || !el.classList.contains('stp-search')) return;
      _state.filters.q = String(el.value || '').slice(0, 200);
      saveFilters();
      paint();
    });
  }

  // The row's id is looked up in the loaded list, never put into a selector or
  // a route unchecked.
  function activateRow(row) {
    var id = row.getAttribute('data-ticket');
    var t = (_state.tickets || []).filter(function (x) { return String(x.id) === id; })[0];
    if (t) openTicket(t);
  }

  function openTicket(t) {
    var kind = parentKind(t);
    var router = window.p86Router && typeof window.p86Router.navigate === 'function' ? window.p86Router : null;
    if (kind === 'job') {
      var jobId = String(t.job_id);
      // Tell the job tab which ticket to expand BEFORE it loads its list.
      if (window.p86ServiceTickets && typeof window.p86ServiceTickets.openTicket === 'function') {
        window.p86ServiceTickets.openTicket(t.id);
      }
      // The router open sets the URL and runs editJob + switchJobSubTab as one
      // sequence (js/jobs-hub.js openParentJob gives the reasons).
      if (router) {
        router.navigate({ top: 'jobs', jobId: jobId, jobSub: 'job-service-tickets' });
        return;
      }
      try { if (typeof window.switchTab === 'function') window.switchTab('jobs'); } catch (e) { /* defensive */ }
      if (typeof window.editJob === 'function') window.editJob(jobId);
      if (typeof window.switchJobSubTab === 'function') {
        setTimeout(function () { try { window.switchJobSubTab('job-service-tickets'); } catch (e) { /* defensive */ } }, 60);
      }
      return;
    }
    if (kind === 'lead') {
      var leadId = String(t.lead_id);
      if (router) {
        router.navigate({ top: 'estimates', estSub: 'leads', leadId: leadId });
        return;
      }
      try { if (typeof window.switchTab === 'function') window.switchTab('estimates'); } catch (e) { /* defensive */ }
      try { if (typeof window.switchEstimatesSubTab === 'function') window.switchEstimatesSubTab('leads'); } catch (e) { /* defensive */ }
      if (typeof window.openEditLeadModal === 'function') window.openEditLeadModal(leadId);
    }
  }

  // ── load ────────────────────────────────────────────────────────────
  function api() {
    return (window.p86Api && window.p86Api.serviceTickets) || null;
  }

  // Every fetch takes a sequence number, and only the newest one may paint: a
  // slow first response must never land on top of a later, fresher one.
  function load() {
    var seq = ++_state.seq;
    // Never loaded and the last try failed: this try says Loading… again
    // instead of leaving the old error up while it runs.
    if (_state.tickets == null && _state.error) {
      _state.error = null;
      paint();
    }
    var a = api();
    if (!a || typeof a.list !== 'function') {
      _state.error = 'the service tickets service is not available';
      paint();
      return Promise.resolve();
    }
    return Promise.resolve()
      .then(function () { return a.list({ limit: LIMIT }); })
      .then(function (r) {
        if (seq !== _state.seq) return;
        _state.tickets = (r && Array.isArray(r.tickets)) ? r.tickets : [];
        _state.error = null;
        paint();
      }, function (e) {
        if (seq !== _state.seq) return;
        _state.error = (e && e.message) ? String(e.message) : 'unknown error';
        paint();
      });
  }

  function render(host) {
    host = host || document.getElementById('serviceTicketsHost');
    if (!host) return Promise.resolve();
    ensureStyles();
    if (_state.host !== host || !_state.root || !host.contains(_state.root)) buildShell(host);
    paint();
    return load();
  }

  function refresh() {
    var pane = document.getElementById('service-tickets');
    var host = _state.host;
    if (!pane || !pane.classList.contains('active') || !host || !host.isConnected || !_state.root) {
      return Promise.resolve();
    }
    return load();
  }

  window.p86ServiceTicketsPage = { render: render, refresh: refresh };
})();
