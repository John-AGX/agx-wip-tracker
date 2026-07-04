// My Day — a single time-ordered itinerary fusing the user's personal
// calendar events, their field-schedule assignments, and their tasks due
// today/overdue into one "here's your day" hub.
//
// Read-only aggregation over existing APIs (calendar / schedule / tasks);
// no new server surface. Each row deep-links back to its source (event →
// Schedule, task → task detail). Painted by renderMyDayTab() into the
// #my-day tab-content pane (wired in app.js switchTab).
//
// Scope: personal. Events + tasks are owner-scoped server-side; schedule
// entries are filtered client-side to ones whose crew includes the user.
// "Jobs near you" (geolocation) is a deliberate later slice.

(function () {
  'use strict';

  function esc(s) {
    if (typeof window.escapeHTML === 'function') return window.escapeHTML(s);
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function currentUserId() {
    var u = (window.p86Auth && window.p86Auth.getUser && window.p86Auth.getUser()) || null;
    return u ? Number(u.id) : null;
  }
  function currentUserFirstName() {
    var u = (window.p86Auth && window.p86Auth.getUser && window.p86Auth.getUser()) || null;
    var n = u && (u.name || u.email) || '';
    return String(n).trim().split(/\s+/)[0] || '';
  }

  // ── Date helpers (all local-time) ──────────────────────────────────
  function startOfToday() { var d = new Date(); d.setHours(0, 0, 0, 0); return d; }
  function endOfToday() { var d = new Date(); d.setHours(23, 59, 59, 999); return d; }
  function isoDate(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function addDays(d, n) { var x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
  function todayISO() { return isoDate(new Date()); }
  function longDate(d) {
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  }
  function timeLabel(ts) {
    var d = (ts instanceof Date) ? ts : new Date(ts);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  function dueLabel(due) {
    if (!due) return '';
    var d = (due instanceof Date) ? due : new Date(due + 'T00:00:00');
    if (isNaN(d.getTime())) return String(due).slice(0, 10);
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }
  // A bare YYYY-MM-DD from a DATE column (string or Date).
  function dateOnly(v) {
    if (!v) return '';
    if (typeof v === 'string') return v.slice(0, 10);
    if (v instanceof Date) return isoDate(v);
    return String(v).slice(0, 10);
  }

  // Best-effort job label from the cached jobs list (populated once the
  // Jobs page has loaded). Falls back to a generic label.
  function jobLabel(jobId) {
    var jobs = (window.appData && window.appData.jobs) || [];
    for (var i = 0; i < jobs.length; i++) {
      var j = jobs[i];
      if (String(j.id) === String(jobId)) {
        var d = j.data || j;
        var num = d.jobNumber ? '[' + d.jobNumber + '] ' : '';
        return num + (d.title || d.name || ('Job ' + jobId));
      }
    }
    return 'Job ' + jobId;
  }

  // ── One-time styles ────────────────────────────────────────────────
  function ensureStyles() {
    if (document.getElementById('p86-myday-styles')) return;
    var css =
      '#my-day .myday{max-width:760px;margin:0 auto;}' +
      '#my-day .myday-head{display:flex;align-items:flex-end;gap:12px;margin-bottom:4px;}' +
      '#my-day .myday-head h2{margin:0;font-size:24px;}' +
      '#my-day .myday-date{color:var(--text-dim,#9aa);font-size:14px;flex:1;}' +
      '#my-day .myday-refresh{background:transparent;border:1px solid var(--border,#2a2a3a);color:var(--text-dim,#9aa);border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer;}' +
      '#my-day .myday-summary{color:var(--text-dim,#9aa);font-size:13px;margin:8px 0 18px;}' +
      '#my-day .myday-sec{margin-bottom:22px;}' +
      '#my-day .myday-sec-h{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-dim,#8a8a9a);margin:0 0 8px 2px;}' +
      '#my-day .myday-card{display:flex;gap:12px;align-items:flex-start;padding:11px 14px;border:1px solid var(--border,#2a2a3a);border-radius:9px;background:var(--card-bg,#141419);margin-bottom:8px;cursor:pointer;transition:border-color .12s,background .12s;}' +
      '#my-day .myday-card:hover{border-color:var(--accent,#22d3ee);background:rgba(34,211,238,0.05);}' +
      '#my-day .myday-time{flex:0 0 76px;font-size:13px;font-weight:600;color:var(--text,#fff);padding-top:1px;}' +
      '#my-day .myday-time small{display:block;font-size:10px;font-weight:500;color:var(--text-dim,#8a8a9a);}' +
      '#my-day .myday-dot{flex:0 0 8px;width:8px;height:8px;border-radius:50%;margin-top:6px;}' +
      '#my-day .myday-body{flex:1;min-width:0;}' +
      '#my-day .myday-title{font-size:14px;font-weight:600;color:var(--text,#fff);}' +
      '#my-day .myday-meta{font-size:12px;color:var(--text-dim,#8a8a9a);margin-top:2px;}' +
      '#my-day .myday-chip{display:inline-block;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.4px;padding:2px 6px;border-radius:4px;margin-left:6px;vertical-align:middle;}' +
      '#my-day .myday-empty{text-align:center;color:var(--text-dim,#8a8a9a);padding:56px 20px;}' +
      '#my-day .myday-empty .big{font-size:40px;margin-bottom:10px;}' +
      '#my-day .myday-err{color:#f87171;font-size:13px;padding:14px;}';
    var st = document.createElement('style');
    st.id = 'p86-myday-styles';
    st.textContent = css;
    document.head.appendChild(st);
  }

  function renderMyDayTab() {
    var pane = document.getElementById('my-day');
    if (!pane) return;
    ensureStyles();
    var now = new Date();
    pane.innerHTML =
      '<div class="myday">' +
        '<div class="myday-head">' +
          '<h2>Good ' + partOfDay(now) + (currentUserFirstName() ? ', ' + esc(currentUserFirstName()) : '') + '</h2>' +
          '<span class="myday-date">' + esc(longDate(now)) + '</span>' +
          '<button type="button" class="myday-refresh" data-myday-refresh>&#x21bb; Refresh</button>' +
        '</div>' +
        '<div id="mydayBody"><div class="myday-summary">Loading your day&hellip;</div></div>' +
      '</div>';
    var rb = pane.querySelector('[data-myday-refresh]');
    if (rb) rb.addEventListener('click', function () { loadDay(); });
    loadDay();
  }

  function partOfDay(d) {
    var h = d.getHours();
    if (h < 12) return 'morning';
    if (h < 17) return 'afternoon';
    return 'evening';
  }

  function loadDay() {
    var body = document.getElementById('mydayBody');
    if (!body) return;
    if (!window.p86Api) { body.innerHTML = '<div class="myday-err">API unavailable.</div>'; return; }
    body.innerHTML = '<div class="myday-summary">Loading your day&hellip;</div>';

    var soT = startOfToday(), eoT = endOfToday();
    var me = currentUserId();

    var pEvents = (window.p86Api.calendar
      ? window.p86Api.calendar.list({ from: soT.toISOString(), to: eoT.toISOString() })
      : Promise.resolve({ events: [] })).catch(function () { return { events: [] }; });

    var pSchedule = (window.p86Api.schedule
      ? window.p86Api.schedule.list({ from: isoDate(addDays(soT, -60)), to: isoDate(soT) })
      : Promise.resolve({ entries: [] })).catch(function () { return { entries: [] }; });

    var pTasks = (window.p86Api.tasks
      ? window.p86Api.tasks.list({ assignee: 'me', exclude_done: 1, limit: 200 })
      : Promise.resolve({ tasks: [] })).catch(function () { return { tasks: [] }; });

    Promise.all([pEvents, pSchedule, pTasks]).then(function (res) {
      var events = (res[0] && (res[0].events || res[0])) || [];
      var sched = (res[1] && (res[1].entries || res[1].schedule || res[1])) || [];
      var tasks = (res[2] && (res[2].tasks || res[2])) || [];
      if (!Array.isArray(events)) events = [];
      if (!Array.isArray(sched)) sched = [];
      if (!Array.isArray(tasks)) tasks = [];

      var today = todayISO();

      // Events today (already range-windowed server-side), skip canceled.
      var evToday = events.filter(function (e) { return e && e.status !== 'canceled' && e.starts_at; });

      // Schedule entries whose span covers today AND the user is on crew.
      var schToday = sched.filter(function (s) {
        var crew = Array.isArray(s.crew) ? s.crew.map(Number) : [];
        if (me != null && crew.indexOf(me) === -1) return false;
        var start = dateOnly(s.startDate || s.start_date);
        if (!start) return false;
        var span = Math.max(1, Number(s.days || 1));
        var startD = new Date(start + 'T00:00:00');
        var endD = addDays(startD, span - 1);
        var t = new Date(today + 'T00:00:00');
        return startD <= t && t <= endD;
      });

      // Tasks due today or overdue (dated, not done).
      var tasksDue = tasks.filter(function (t) {
        if (!t || !t.due_date) return false;
        return dateOnly(t.due_date) <= today;
      }).sort(function (a, b) { return dateOnly(a.due_date) < dateOnly(b.due_date) ? -1 : 1; });

      renderDay(body, evToday, schToday, tasksDue);
    }).catch(function (err) {
      body.innerHTML = '<div class="myday-err">Could not load your day: ' + esc(err && err.message || '') + '</div>';
    });
  }

  function renderDay(body, events, sched, tasks) {
    var total = events.length + sched.length + tasks.length;
    if (!total) {
      body.innerHTML =
        '<div class="myday-empty">' +
          '<div class="big">&#x2600;&#xFE0F;</div>' +
          '<div style="font-size:15px;color:var(--text,#fff);margin-bottom:4px;">Nothing on the books today.</div>' +
          '<div>No events, field assignments, or tasks due. Enjoy the breathing room.</div>' +
        '</div>';
      return;
    }

    // Summary line.
    var bits = [];
    if (events.length) bits.push(events.length + ' event' + (events.length === 1 ? '' : 's'));
    if (sched.length) bits.push(sched.length + ' field assignment' + (sched.length === 1 ? '' : 's'));
    if (tasks.length) bits.push(tasks.length + ' task' + (tasks.length === 1 ? '' : 's') + ' due');
    var html = '<div class="myday-summary">' + esc(bits.join(' · ')) + '</div>';

    // Split events into timed vs all-day; timed sorted by start.
    var timed = events.filter(function (e) { return !e.all_day; })
      .sort(function (a, b) { return new Date(a.starts_at) - new Date(b.starts_at); });
    var allDay = events.filter(function (e) { return e.all_day; });

    // ── Schedule (timed events) ──
    if (timed.length) {
      html += '<div class="myday-sec"><div class="myday-sec-h">Schedule</div>';
      timed.forEach(function (e) {
        var color = e.color || '#6366f1';
        var translucent = (e.status === 'tentative');
        html += '<div class="myday-card" data-kind="event" data-id="' + esc(e.id) + '">' +
          '<div class="myday-time">' + esc(timeLabel(e.starts_at)) +
            (e.ends_at ? '<small>to ' + esc(timeLabel(e.ends_at)) + '</small>' : '') + '</div>' +
          '<span class="myday-dot" style="background:' + esc(color) + ';opacity:' + (translucent ? '0.5' : '1') + ';margin-top:4px;"></span>' +
          '<div class="myday-body">' +
            '<div class="myday-title">' + esc(e.title || '(untitled event)') +
              (translucent ? '<span class="myday-chip" style="background:rgba(148,163,184,0.2);color:#94a3b8;">tentative</span>' : '') +
              linkChip(e) + '</div>' +
            (e.location ? '<div class="myday-meta">' + (window.p86Icon ? window.p86Icon('map-pin') + ' ' : '') + esc(e.location) + '</div>' : '') +
          '</div></div>';
      });
      html += '</div>';
    }

    // ── All-day & field work ──
    if (allDay.length || sched.length) {
      html += '<div class="myday-sec"><div class="myday-sec-h">All-day &amp; field work</div>';
      allDay.forEach(function (e) {
        var color = e.color || '#6366f1';
        html += '<div class="myday-card" data-kind="event" data-id="' + esc(e.id) + '">' +
          '<span class="myday-dot" style="background:' + esc(color) + ';"></span>' +
          '<div class="myday-body"><div class="myday-title">' + esc(e.title || '(untitled event)') +
            '<span class="myday-chip" style="background:rgba(99,102,241,0.18);color:#a5b4fc;">all day</span>' +
            linkChip(e) + '</div>' +
            (e.location ? '<div class="myday-meta">' + (window.p86Icon ? window.p86Icon('map-pin') + ' ' : '') + esc(e.location) + '</div>' : '') +
          '</div></div>';
      });
      sched.forEach(function (s) {
        var statusColor = s.status === 'in-progress' ? '#22d3ee' : s.status === 'done' ? '#34d399' : '#fbbf24';
        html += '<div class="myday-card" data-kind="schedule" data-job="' + esc(s.jobId || s.job_id || '') + '">' +
          '<span class="myday-dot" style="background:' + statusColor + ';"></span>' +
          '<div class="myday-body"><div class="myday-title">' + esc(jobLabel(s.jobId || s.job_id)) +
            '<span class="myday-chip" style="background:rgba(251,191,36,0.16);color:#fbbf24;">' + esc(s.status || 'planned') + '</span></div>' +
            (s.notes ? '<div class="myday-meta">' + esc(String(s.notes).slice(0, 120)) + '</div>' : '<div class="myday-meta">Field assignment</div>') +
          '</div></div>';
      });
      html += '</div>';
    }

    // ── Tasks ──
    if (tasks.length) {
      var today = todayISO();
      html += '<div class="myday-sec"><div class="myday-sec-h">Tasks due</div>';
      tasks.forEach(function (t) {
        var overdue = dateOnly(t.due_date) < today;
        var pr = (t.priority && t.priority !== 'normal') ? t.priority : '';
        var prColor = pr === 'urgent' ? '#f87171' : pr === 'high' ? '#fbbf24' : '#94a3b8';
        html += '<div class="myday-card" data-kind="task" data-id="' + esc(t.id) + '">' +
          '<span class="myday-dot" style="background:' + (overdue ? '#f87171' : '#60a5fa') + ';"></span>' +
          '<div class="myday-body"><div class="myday-title">' + esc(t.title || '(untitled task)') +
            (pr ? '<span class="myday-chip" style="background:rgba(148,163,184,0.15);color:' + prColor + ';">' + esc(pr) + '</span>' : '') +
            (overdue ? '<span class="myday-chip" style="background:rgba(248,113,113,0.18);color:#f87171;">overdue</span>' : '') +
            linkChip(t) + '</div>' +
            '<div class="myday-meta">Due ' + esc(dueLabel(t.due_date)) + '</div>' +
          '</div></div>';
      });
      html += '</div>';
    }

    body.innerHTML = html;
    wireRows(body);
  }

  function wireRows(body) {
    body.querySelectorAll('.myday-card').forEach(function (card) {
      card.addEventListener('click', function () {
        var kind = card.getAttribute('data-kind');
        if (kind === 'task') {
          var tid = card.getAttribute('data-id');
          if (window.p86Tasks && window.p86Tasks.openDetail) window.p86Tasks.openDetail(tid);
          else if (typeof window.switchTab === 'function') window.switchTab('my-tasks');
        } else if (kind === 'event') {
          // Calendar event → jump to the Schedule surface (the event card
          // lives there). A future slice can open the read-only card inline.
          if (typeof window.switchTab === 'function') window.switchTab('schedule');
        } else if (kind === 'schedule') {
          if (typeof window.switchTab === 'function') window.switchTab('schedule');
        }
      });
    });
  }

  // A "🔗 <label>" chip shown when an event/task is linked to a record
  // (client/job/lead/project). Uses the server-resolved entity_label,
  // falling back to a capitalized type.
  function linkChip(row) {
    if (!row || !row.entity_type) return '';
    var label = row.entity_label ||
      (String(row.entity_type).charAt(0).toUpperCase() + String(row.entity_type).slice(1));
    return '<span class="myday-chip" style="background:rgba(34,211,238,0.14);color:#22d3ee;">&#128279; ' + esc(label) + '</span>';
  }

  window.p86MyDay = { render: renderMyDayTab };
  window.renderMyDayTab = renderMyDayTab;
})();
