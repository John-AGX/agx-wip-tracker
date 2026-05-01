// ============================================================
// AGX Schedule — production-scheduling calendar (Phase 1)
//
// Outlook-style monthly grid + sidebar of in-progress jobs the
// PM drags onto days during the Friday production-scheduling
// meeting. Phase 1 = localStorage-only (`agx-schedule-entries`);
// Phase 2 will swap in /api/schedule and the schedule_entries
// table without touching this module's public shape.
//
// Public surface (called from app.js switchTab):
//   window.renderSchedule()          — paint the page
//   window.scheduleAddEntry(jobId,d) — programmatic entry add
//
// Entry shape:
//   {
//     id, jobId, startDate (YYYY-MM-DD), days,
//     crew: [userId, ...],     // assigned system users
//     notes,
//     status: 'planned'|'in-progress'|'done'|'rolled-over',
//     includesWeekends: bool,
//     createdAt, updatedAt
//   }
// ============================================================

(function() {
  'use strict';

  // ── Storage ────────────────────────────────────────────────
  // Phase 2: server is the source of truth (window.agxApi.schedule).
  // localStorage stays around as an offline cache + the seed for the
  // first paint while the network call resolves. Settings (view month
  // / weekend toggle) stay client-only since they're per-user UX state
  // not collaborative data.
  var STORAGE_KEY = 'agx-schedule-entries';
  var SETTINGS_KEY = 'agx-schedule-settings';

  function loadCachedEntries() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') || []; }
    catch (e) { return []; }
  }
  function cacheEntries(list) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); }
    catch (e) { /* defensive */ }
  }
  function loadSettings() {
    try {
      return Object.assign(
        { showWeekends: true, viewMonth: null },
        JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')
      );
    } catch (e) { return { showWeekends: true, viewMonth: null }; }
  }
  function saveSettings(s) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }
    catch (e) { /* defensive */ }
  }

  function isApiReady() {
    return !!(window.agxApi &&
              window.agxApi.schedule &&
              window.agxApi.isAuthenticated &&
              window.agxApi.isAuthenticated());
  }

  // Pull entries from the server and refresh the cache. Returns a
  // Promise so callers can chain a render. Falls back to the cached
  // copy when offline / unauthenticated so the page still works.
  function fetchEntries() {
    if (!isApiReady()) {
      _state.entries = loadCachedEntries();
      return Promise.resolve(_state.entries);
    }
    return window.agxApi.schedule.list().then(function(res) {
      var list = (res && res.entries) || [];
      _state.entries = list;
      cacheEntries(list);
      return list;
    }).catch(function(err) {
      console.warn('[schedule] fetch failed, using cache:', err && err.message);
      _state.entries = loadCachedEntries();
      return _state.entries;
    });
  }

  // ── Date helpers ───────────────────────────────────────────
  // All keys & wire format are YYYY-MM-DD strings — easy to compare,
  // easy to persist, and they round-trip without timezone drift.
  function toISODate(d) {
    var y = d.getFullYear(), m = d.getMonth() + 1, dd = d.getDate();
    return y + '-' + (m < 10 ? '0' + m : m) + '-' + (dd < 10 ? '0' + dd : dd);
  }
  function parseISODate(s) {
    if (!s) return null;
    var m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3]);
  }
  function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  function endOfMonth(d)   { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }
  function addDays(d, n)   { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function startOfWeek(d) {
    // Week starts Monday — matches the production-week mental model
    // ("schedule for the week of Mon Oct 5"). Sunday becomes the
    // 7th day of the prior week.
    var x = new Date(d);
    var day = x.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    var diff = (day === 0 ? -6 : 1 - day);
    x.setDate(x.getDate() + diff);
    x.setHours(0, 0, 0, 0);
    return x;
  }
  function isSameDay(a, b) {
    return a && b &&
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate();
  }
  var MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var DOW_LABELS  = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

  // ── Color palette for jobs ─────────────────────────────────
  // Stable hash-mod-palette so the same job always gets the same color
  // across the sidebar, calendar, and modal.
  var JOB_COLORS = [
    '#4f8cff', '#34d399', '#fbbf24', '#a78bfa', '#ec4899',
    '#22d3ee', '#fb923c', '#f87171', '#84cc16', '#60a5fa',
    '#facc15', '#c084fc', '#14b8a6'
  ];
  function colorForJob(jobId) {
    var s = String(jobId || '');
    var h = 0;
    for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0; }
    return JOB_COLORS[h % JOB_COLORS.length];
  }

  // ── State ──────────────────────────────────────────────────
  var _state = {
    cursor: null,        // first day of the month being viewed
    entries: [],
    settings: { showWeekends: true, viewMonth: null },
    users: [],           // hydrated from /api/auth/users
    sidebarSearch: ''
  };

  // ── Job pool ───────────────────────────────────────────────
  // The sidebar lists in-progress jobs. We pull from window.appData.jobs
  // (already hydrated on login) and filter to status=In Progress.
  function inProgressJobs() {
    var jobs = (window.appData && Array.isArray(window.appData.jobs)) ? window.appData.jobs : [];
    return jobs.filter(function(j) {
      var s = String(j.status || '').toLowerCase();
      // "In Progress" is the canonical status; fall back to any non-
      // closed/cancelled/archived bucket so jobs created with slightly
      // different casing still show up.
      if (s.indexOf('closed') !== -1) return false;
      if (s.indexOf('cancel') !== -1) return false;
      if (s.indexOf('archive') !== -1) return false;
      if (s.indexOf('complete') !== -1 && s.indexOf('progress') === -1) return false;
      return true;
    });
  }

  function jobById(id) {
    var jobs = (window.appData && Array.isArray(window.appData.jobs)) ? window.appData.jobs : [];
    return jobs.find(function(j) { return j.id === id; }) || null;
  }

  function jobLabel(j) {
    if (!j) return '(unknown job)';
    return (j.jobNumber || '') + (j.jobNumber && j.title ? ' — ' : '') + (j.title || j.name || '');
  }

  // ── Crew (system users) ────────────────────────────────────
  // We list every active user; field-crew filtering happens once that
  // role exists. Loaded once per page render and cached for the
  // entry-editor modal's crew picker.
  function loadUsers() {
    if (!window.agxApi || !window.agxApi.users || !window.agxApi.isAuthenticated || !window.agxApi.isAuthenticated()) {
      _state.users = [];
      return Promise.resolve([]);
    }
    return window.agxApi.users.list().then(function(res) {
      var list = (res && res.users) || [];
      _state.users = list.filter(function(u) { return u && (u.active === undefined || u.active); });
      return _state.users;
    }).catch(function() {
      _state.users = [];
      return [];
    });
  }

  // ── Money / format helpers ─────────────────────────────────
  function fmtMoney(n) {
    var v = Number(n || 0);
    var sign = v < 0 ? '-' : '';
    return sign + '$' + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
  }
  function escapeHTML(s) {
    if (typeof window.escapeHTML === 'function') return window.escapeHTML(s);
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escapeAttr(s) { return escapeHTML(s).replace(/"/g, '&quot;'); }

  // ── Day → entries lookup ───────────────────────────────────
  // For each day in the visible month, collect entries that touch it
  // (startDate ≤ day ≤ startDate + days-1, optionally skipping
  // weekends if the entry's includesWeekends flag is false).
  function entriesOnDay(day) {
    var key = toISODate(day);
    return _state.entries.filter(function(e) {
      var s = parseISODate(e.startDate);
      if (!s) return false;
      // Build the inclusive set of dates this entry covers, expanding
      // by `days` business or calendar days depending on the flag.
      var spanned = entrySpanDays(e);
      for (var i = 0; i < spanned.length; i++) {
        if (spanned[i] === key) return true;
      }
      return false;
    });
  }
  // Expand an entry into its set of YYYY-MM-DD strings.
  function entrySpanDays(e) {
    var out = [];
    var s = parseISODate(e.startDate);
    if (!s) return out;
    var days = Math.max(1, parseInt(e.days, 10) || 1);
    var includeWeekends = !!e.includesWeekends;
    var cursor = new Date(s);
    var added = 0;
    var safety = 0;
    while (added < days && safety < 365) {
      safety++;
      var dow = cursor.getDay();
      var isWeekend = (dow === 0 || dow === 6);
      if (includeWeekends || !isWeekend) {
        out.push(toISODate(cursor));
        added++;
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    return out;
  }

  // ── Week summary math ──────────────────────────────────────
  // Walk the visible month's weeks, sum scheduled days × estimated
  // daily revenue per job. Daily revenue is contractAmount /
  // job.totalProductionDays — we add that field to the WIP page; until
  // the user fills it in we fall back to (contractAmount / 5) just so
  // the summary shows something instead of $0.
  function jobDailyRate(job) {
    if (!job) return 0;
    var contract = Number(job.contractAmount || 0);
    var days = Number(job.totalProductionDays || 0);
    if (contract <= 0) return 0;
    if (days > 0) return contract / days;
    return contract / 5; // placeholder — see comment above
  }

  function weekSummaryForCursor(cursor) {
    var ws = startOfWeek(cursor);
    var we = addDays(ws, 6);
    var totalDays = 0;
    var totalRev = 0;
    var jobsTouching = {};
    _state.entries.forEach(function(e) {
      var span = entrySpanDays(e);
      var inWeek = span.filter(function(k) {
        var d = parseISODate(k);
        return d && d >= ws && d <= we;
      });
      if (!inWeek.length) return;
      var job = jobById(e.jobId);
      var rate = jobDailyRate(job);
      totalDays += inWeek.length;
      totalRev += rate * inWeek.length;
      jobsTouching[e.jobId] = true;
    });
    return {
      weekStart: toISODate(ws),
      weekEnd: toISODate(we),
      scheduledDays: totalDays,
      expectedRevenue: totalRev,
      jobsCount: Object.keys(jobsTouching).length
    };
  }

  // ── Render: page shell ─────────────────────────────────────
  function renderSchedule() {
    var root = document.getElementById('schedule-root');
    if (!root) return;
    _state.settings = loadSettings();
    if (typeof _state.settings.showWeekends !== 'boolean') _state.settings.showWeekends = true;
    if (!_state.cursor) {
      var saved = parseISODate(_state.settings.viewMonth);
      _state.cursor = saved ? startOfMonth(saved) : startOfMonth(new Date());
    }
    // Seed with cached entries so the first paint isn't blank, then
    // refresh from the server in the background.
    _state.entries = loadCachedEntries();

    root.innerHTML =
      '<div class="sch-page">' +
        '<aside class="sch-sidebar" id="schSidebar"></aside>' +
        '<section class="sch-cal-wrap" id="schCalWrap"></section>' +
      '</div>';

    renderSidebar();
    renderCalendar();

    // Kick off user load in the background so the editor modal can
    // populate the crew picker as soon as the user clicks a day.
    loadUsers();

    // And the server fetch — repaint the grid + summary when it lands.
    fetchEntries().then(function() {
      renderGrid();
      refreshWeekSummary();
    });
  }

  // ── Render: sidebar ────────────────────────────────────────
  function renderSidebar() {
    var el = document.getElementById('schSidebar');
    if (!el) return;
    var jobs = inProgressJobs();
    var q = _state.sidebarSearch.trim().toLowerCase();
    if (q) {
      jobs = jobs.filter(function(j) {
        var hay = (jobLabel(j) + ' ' + (j.client || '') + ' ' + (j.community || '')).toLowerCase();
        return hay.indexOf(q) !== -1;
      });
    }
    // Sort by jobNumber for predictable order
    jobs.sort(function(a, b) { return (a.jobNumber || '').localeCompare(b.jobNumber || ''); });

    var html =
      '<div class="sch-sidebar-header">' +
        '<div class="sch-sidebar-title">In-Progress Jobs</div>' +
        '<div class="sch-sidebar-sub">Drag any job onto a day to schedule it.</div>' +
      '</div>' +
      '<div class="sch-sidebar-search">' +
        '<input type="text" id="schSidebarSearch" placeholder="Search jobs…" value="' + escapeAttr(_state.sidebarSearch) + '" />' +
      '</div>' +
      '<div class="sch-sidebar-list" id="schSidebarList">';

    if (!jobs.length) {
      html += '<div class="sch-sidebar-empty">' +
        (q ? 'No jobs match.' : 'No in-progress jobs.') +
      '</div>';
    } else {
      jobs.forEach(function(j) {
        var color = colorForJob(j.id);
        var pct = Number(j.pctComplete || 0);
        var contract = Number(j.contractAmount || 0);
        var prodDays = Number(j.totalProductionDays || 0);
        html += '<div class="sch-job-card" draggable="true" data-job-id="' + escapeAttr(j.id) + '" style="--job-color:' + color + ';">' +
          '<div class="sch-job-card-num">' + escapeHTML(j.jobNumber || j.id) + '</div>' +
          '<div class="sch-job-card-title">' + escapeHTML(j.title || j.name || '(untitled)') + '</div>' +
          '<div class="sch-job-card-meta">' +
            '<span>' + fmtMoney(contract) + (prodDays ? ' · ' + prodDays + 'd' : '') + '</span>' +
            '<span class="sch-job-card-pct">' + pct.toFixed(0) + '%</span>' +
          '</div>' +
        '</div>';
      });
    }

    html += '</div>';
    el.innerHTML = html;

    var searchEl = document.getElementById('schSidebarSearch');
    if (searchEl) {
      searchEl.addEventListener('input', function(e) {
        _state.sidebarSearch = e.target.value || '';
        renderSidebar();
      });
    }

    // Wire drag events on each card.
    el.querySelectorAll('.sch-job-card').forEach(function(card) {
      card.addEventListener('dragstart', function(e) {
        card.classList.add('dragging');
        var jobId = card.getAttribute('data-job-id');
        e.dataTransfer.setData('text/x-agx-jobid', jobId);
        e.dataTransfer.setData('text/plain', jobId);
        e.dataTransfer.effectAllowed = 'copy';
      });
      card.addEventListener('dragend', function() {
        card.classList.remove('dragging');
      });
    });
  }

  // ── Render: calendar grid ──────────────────────────────────
  function renderCalendar() {
    var el = document.getElementById('schCalWrap');
    if (!el) return;
    var cur = _state.cursor;
    var summary = weekSummaryForCursor(new Date());

    el.innerHTML =
      '<div class="sch-cal-toolbar">' +
        '<div class="sch-cal-nav">' +
          '<button class="sch-btn sch-btn-icon" id="schPrev" title="Previous month">&lsaquo;</button>' +
          '<div class="sch-cal-month" id="schMonth">' + MONTH_NAMES[cur.getMonth()] + ' ' + cur.getFullYear() + '</div>' +
          '<button class="sch-btn sch-btn-icon" id="schNext" title="Next month">&rsaquo;</button>' +
          '<button class="sch-btn" id="schToday" style="margin-left:6px;">Today</button>' +
        '</div>' +
        '<label class="sch-toolbar-toggle">' +
          '<input type="checkbox" id="schWeekendToggle" ' + (_state.settings.showWeekends ? 'checked' : '') + ' /> ' +
          'Show weekends' +
        '</label>' +
        '<div class="sch-toolbar-spacer"></div>' +
        '<button class="sch-btn sch-btn-primary" id="schAddEntry">+ Schedule entry</button>' +
      '</div>' +
      '<div class="sch-cal-grid" id="schGrid"></div>' +
      '<div class="sch-week-summary" id="schWeekSummary">' +
        '<span class="sch-week-summary-label">This week</span>' +
        '<span><span class="sch-week-summary-label">Days</span> <span class="sch-week-summary-val">' + summary.scheduledDays + '</span></span>' +
        '<span><span class="sch-week-summary-label">Expected revenue</span> <span class="sch-week-summary-val sch-rev">' + fmtMoney(summary.expectedRevenue) + '</span></span>' +
        '<span><span class="sch-week-summary-label">Jobs</span> <span class="sch-week-summary-val">' + summary.jobsCount + '</span></span>' +
      '</div>';

    document.getElementById('schPrev').addEventListener('click', function() { stepMonth(-1); });
    document.getElementById('schNext').addEventListener('click', function() { stepMonth(1); });
    document.getElementById('schToday').addEventListener('click', function() {
      _state.cursor = startOfMonth(new Date());
      _state.settings.viewMonth = toISODate(_state.cursor);
      saveSettings(_state.settings);
      renderCalendar();
    });
    document.getElementById('schWeekendToggle').addEventListener('change', function(e) {
      _state.settings.showWeekends = !!e.target.checked;
      saveSettings(_state.settings);
      renderGrid();
    });
    document.getElementById('schAddEntry').addEventListener('click', function() {
      openEntryEditor(null, toISODate(new Date()));
    });

    renderGrid();
  }

  function stepMonth(delta) {
    _state.cursor = new Date(_state.cursor.getFullYear(), _state.cursor.getMonth() + delta, 1);
    _state.settings.viewMonth = toISODate(_state.cursor);
    saveSettings(_state.settings);
    renderCalendar();
  }

  function renderGrid() {
    var grid = document.getElementById('schGrid');
    if (!grid) return;
    var first = _state.cursor;
    var firstDow = first.getDay(); // 0=Sun … 6=Sat
    // Convert to Monday-start: how many days back to get to Monday?
    var leadingDays = firstDow === 0 ? 6 : (firstDow - 1);
    var gridStart = addDays(first, -leadingDays);
    var lastOfMonth = endOfMonth(first);
    // Always render 6 weeks (42 cells) so the grid has a stable shape
    // — Outlook does the same. Trailing/leading days from sibling
    // months get dimmed.
    var cells = [];
    for (var i = 0; i < 42; i++) {
      cells.push(addDays(gridStart, i));
    }

    var html = '';
    DOW_LABELS.forEach(function(d) {
      html += '<div class="sch-cal-dow">' + d + '</div>';
    });

    var today = new Date();
    cells.forEach(function(d) {
      var inMonth = (d.getMonth() === first.getMonth());
      var dow = d.getDay();
      var isWeekend = (dow === 0 || dow === 6);
      // Hide weekend cells when the toggle is off — replace them
      // with an empty placeholder so the grid keeps its 7-col shape.
      if (isWeekend && !_state.settings.showWeekends) {
        html += '<div class="sch-cal-day sch-weekend" style="visibility:hidden;"></div>';
        return;
      }
      var cls = 'sch-cal-day';
      if (!inMonth) cls += ' sch-other-month';
      if (isWeekend) cls += ' sch-weekend';
      if (isSameDay(d, today)) cls += ' sch-today';
      html += '<div class="' + cls + '" data-date="' + toISODate(d) + '">' +
        '<span class="sch-cal-day-num">' + d.getDate() + '</span>';
      var ents = entriesOnDay(d);
      ents.slice(0, 4).forEach(function(e) {
        var job = jobById(e.jobId);
        var color = colorForJob(e.jobId);
        var statusCls = '';
        if (e.status === 'done') statusCls = ' sch-entry-done';
        else if (e.status === 'rolled-over') statusCls = ' sch-entry-rolled';
        var meta = e.crew && e.crew.length ? ' · ' + e.crew.length + '👷' : '';
        html += '<div class="sch-entry' + statusCls + '" data-entry-id="' + escapeAttr(e.id) + '" style="--entry-color:' + color + ';background:' + color + ';" title="' + escapeAttr(jobLabel(job)) + (e.notes ? ' — ' + escapeAttr(e.notes) : '') + '">' +
          escapeHTML(job ? (job.jobNumber || job.title || 'Job') : 'Job') +
          '<span class="sch-entry-meta">' + meta + '</span>' +
        '</div>';
      });
      if (ents.length > 4) {
        html += '<div style="font-size:9px;color:var(--text-dim,#888);padding:0 2px;">+ ' + (ents.length - 4) + ' more</div>';
      }
      html += '</div>';
    });

    grid.innerHTML = html;
    wireGridDrop(grid);
    wireGridClicks(grid);
  }

  // Drag-drop: drop a sidebar job-card onto a day cell to create
  // an entry. The drop opens the editor pre-populated with the job
  // and date so the user can set days / crew / notes before saving.
  function wireGridDrop(grid) {
    grid.querySelectorAll('.sch-cal-day[data-date]').forEach(function(cell) {
      cell.addEventListener('dragover', function(e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        cell.classList.add('sch-drop-target');
      });
      cell.addEventListener('dragleave', function() {
        cell.classList.remove('sch-drop-target');
      });
      cell.addEventListener('drop', function(e) {
        e.preventDefault();
        cell.classList.remove('sch-drop-target');
        var jobId = e.dataTransfer.getData('text/x-agx-jobid') ||
                    e.dataTransfer.getData('text/plain');
        if (!jobId) return;
        var date = cell.getAttribute('data-date');
        openEntryEditor(null, date, jobId);
      });
    });
  }

  function wireGridClicks(grid) {
    grid.querySelectorAll('.sch-entry[data-entry-id]').forEach(function(el) {
      el.addEventListener('click', function(e) {
        e.stopPropagation();
        var id = el.getAttribute('data-entry-id');
        var entry = _state.entries.find(function(x) { return x.id === id; });
        if (entry) openEntryEditor(entry, entry.startDate, entry.jobId);
      });
    });
    grid.querySelectorAll('.sch-cal-day[data-date]').forEach(function(cell) {
      cell.addEventListener('click', function(e) {
        if (e.target.closest('.sch-entry')) return;
        var date = cell.getAttribute('data-date');
        openEntryEditor(null, date);
      });
    });
  }

  // ── Entry editor modal ─────────────────────────────────────
  function openEntryEditor(entry, defaultDate, defaultJobId) {
    var isEdit = !!entry;
    var prior = document.getElementById('schEditorModal');
    if (prior) prior.remove();

    // Make sure users are loaded before painting; if the request is
    // still in-flight we render with whatever we have and let the
    // .then() repaint when it resolves.
    var paint = function() {
      var modal = document.createElement('div');
      modal.id = 'schEditorModal';
      modal.className = 'modal active';
      var entryJobId = (entry && entry.jobId) || defaultJobId || '';
      var startDate = (entry && entry.startDate) || defaultDate || toISODate(new Date());
      var days = (entry && entry.days) || 1;
      var crew = (entry && Array.isArray(entry.crew)) ? entry.crew.slice() : [];
      var notes = (entry && entry.notes) || '';
      var status = (entry && entry.status) || 'planned';
      var includesWeekends = !!(entry && entry.includesWeekends);

      // Sidebar pulls only in-progress jobs, but the editor allows
      // any job in appData.jobs so an entry can survive a job moving
      // to "On Hold" or "Pending" without the user losing the schedule.
      var jobs = (window.appData && Array.isArray(window.appData.jobs)) ? window.appData.jobs : [];
      var jobOptions = jobs.slice().sort(function(a, b) {
        return (a.jobNumber || '').localeCompare(b.jobNumber || '');
      }).map(function(j) {
        var sel = (j.id === entryJobId) ? ' selected' : '';
        return '<option value="' + escapeAttr(j.id) + '"' + sel + '>' +
          escapeHTML((j.jobNumber || '') + ' — ' + (j.title || j.name || '(untitled)')) +
        '</option>';
      }).join('');

      var crewPills = (_state.users || []).map(function(u) {
        var on = crew.indexOf(u.id) !== -1;
        return '<span class="sch-crew-pill' + (on ? ' selected' : '') + '" data-user-id="' + escapeAttr(u.id) + '">' +
          escapeHTML(u.name || u.email || '(unnamed)') +
        '</span>';
      }).join('');

      modal.innerHTML =
        '<div class="modal-content" style="max-width:560px;">' +
          '<div class="modal-header">' + (isEdit ? 'Edit schedule entry' : 'New schedule entry') + '</div>' +
          '<div class="sch-modal-form">' +
            '<div>' +
              '<label>Job</label>' +
              '<select id="schEditJob">' +
                '<option value="">— select a job —</option>' +
                jobOptions +
              '</select>' +
            '</div>' +
            '<div class="sch-modal-row">' +
              '<div>' +
                '<label>Start date</label>' +
                '<input type="date" id="schEditStart" value="' + escapeAttr(startDate) + '" />' +
              '</div>' +
              '<div>' +
                '<label>Production days</label>' +
                '<input type="number" id="schEditDays" min="1" max="60" value="' + days + '" />' +
              '</div>' +
            '</div>' +
            '<div>' +
              '<label>' +
                '<input type="checkbox" id="schEditWeekends" ' + (includesWeekends ? 'checked' : '') + ' style="margin-right:4px;" />' +
                'Include weekends in production days' +
              '</label>' +
            '</div>' +
            '<div>' +
              '<label>Crew (click to assign)</label>' +
              '<div class="sch-crew-picker" id="schEditCrew">' +
                (crewPills || '<span style="font-size:11px;color:var(--text-dim,#888);">No active users found.</span>') +
              '</div>' +
            '</div>' +
            '<div>' +
              '<label>Status</label>' +
              '<select id="schEditStatus">' +
                ['planned','in-progress','done','rolled-over'].map(function(s) {
                  return '<option value="' + s + '"' + (s === status ? ' selected' : '') + '>' + s + '</option>';
                }).join('') +
              '</select>' +
            '</div>' +
            '<div>' +
              '<label>Notes</label>' +
              '<textarea id="schEditNotes" rows="2">' + escapeHTML(notes) + '</textarea>' +
            '</div>' +
          '</div>' +
          '<div class="modal-footer" style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">' +
            (isEdit ? '<button class="sch-btn" id="schEditDelete" style="margin-right:auto;color:#f87171;border-color:rgba(248,113,113,0.4);">Delete</button>' : '') +
            '<button class="sch-btn" id="schEditCancel">Cancel</button>' +
            '<button class="sch-btn sch-btn-primary" id="schEditSave">' + (isEdit ? 'Save' : 'Create') + '</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(modal);

      // Crew pill toggle
      modal.querySelectorAll('.sch-crew-pill').forEach(function(p) {
        p.addEventListener('click', function() {
          var id = p.getAttribute('data-user-id');
          var idx = crew.indexOf(id);
          if (idx >= 0) crew.splice(idx, 1); else crew.push(id);
          p.classList.toggle('selected');
        });
      });

      function close() { modal.remove(); }
      modal.querySelector('#schEditCancel').addEventListener('click', close);
      modal.addEventListener('click', function(e) { if (e.target === modal) close(); });

      // Disable buttons + show a tiny spinner so a slow network doesn't
      // produce double-clicks or the appearance of a frozen modal.
      function setBusy(busy) {
        modal.querySelectorAll('button').forEach(function(b) { b.disabled = !!busy; });
        var saveBtn = modal.querySelector('#schEditSave');
        if (saveBtn) saveBtn.textContent = busy ? '…' : (isEdit ? 'Save' : 'Create');
      }

      var del = modal.querySelector('#schEditDelete');
      if (del) {
        del.addEventListener('click', function() {
          if (!entry) return;
          if (!confirm('Delete this schedule entry?')) return;
          setBusy(true);
          var p = isApiReady() && entry.id && entry.id.indexOf('sch_local_') !== 0
            ? window.agxApi.schedule.remove(entry.id)
            : Promise.resolve();
          p.then(function() {
            _state.entries = _state.entries.filter(function(x) { return x.id !== entry.id; });
            cacheEntries(_state.entries);
            close();
            renderGrid();
            renderSidebar();
            refreshWeekSummary();
          }).catch(function(err) {
            setBusy(false);
            alert('Delete failed: ' + (err.message || err));
          });
        });
      }
      modal.querySelector('#schEditSave').addEventListener('click', function() {
        var jobId = modal.querySelector('#schEditJob').value;
        if (!jobId) { alert('Pick a job.'); return; }
        var sd = modal.querySelector('#schEditStart').value;
        if (!sd) { alert('Pick a start date.'); return; }
        var d = Math.max(1, parseInt(modal.querySelector('#schEditDays').value, 10) || 1);
        var ww = modal.querySelector('#schEditWeekends').checked;
        var st = modal.querySelector('#schEditStatus').value || 'planned';
        var nt = modal.querySelector('#schEditNotes').value || '';
        var payload = {
          jobId: jobId,
          startDate: sd,
          days: d,
          crew: crew.slice(),
          notes: nt,
          status: st,
          includesWeekends: ww
        };
        setBusy(true);
        var done = function(saved) {
          if (isEdit) {
            // Replace the entry in-place — cleaner than splice since
            // the server response carries the canonical row including
            // updated_at and any server-side defaults.
            var idx = _state.entries.findIndex(function(x) { return x.id === entry.id; });
            if (idx >= 0) _state.entries[idx] = saved;
            else _state.entries.push(saved);
          } else {
            _state.entries.push(saved);
          }
          cacheEntries(_state.entries);
          close();
          renderGrid();
          refreshWeekSummary();
        };
        var fail = function(err) {
          setBusy(false);
          alert('Save failed: ' + (err.message || err));
        };

        if (isApiReady()) {
          var req = isEdit
            ? window.agxApi.schedule.update(entry.id, payload)
            : window.agxApi.schedule.create(payload);
          req.then(function(res) {
            done(res && res.entry);
          }).catch(fail);
        } else {
          // Offline / unauthenticated fallback: write to cache only,
          // tag the id so we don't try to PATCH it later. These entries
          // become first-class once the user is back online by being
          // re-created via /api/schedule on the next save action — for
          // now, they're effectively local-only.
          var now = new Date().toISOString();
          var saved = isEdit
            ? Object.assign({}, entry, payload, { updatedAt: now })
            : Object.assign({
                id: 'sch_local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
                createdAt: now,
                updatedAt: now
              }, payload);
          done(saved);
        }
      });
    };

    paint();
    if (!_state.users.length) {
      loadUsers().then(function() {
        // Repaint so the crew picker fills in once the list arrives.
        var still = document.getElementById('schEditorModal');
        if (still) {
          still.remove();
          paint();
        }
      });
    }
  }

  function refreshWeekSummary() {
    var bar = document.getElementById('schWeekSummary');
    if (!bar) return;
    var summary = weekSummaryForCursor(new Date());
    bar.innerHTML =
      '<span class="sch-week-summary-label">This week</span>' +
      '<span><span class="sch-week-summary-label">Days</span> <span class="sch-week-summary-val">' + summary.scheduledDays + '</span></span>' +
      '<span><span class="sch-week-summary-label">Expected revenue</span> <span class="sch-week-summary-val sch-rev">' + fmtMoney(summary.expectedRevenue) + '</span></span>' +
      '<span><span class="sch-week-summary-label">Jobs</span> <span class="sch-week-summary-val">' + summary.jobsCount + '</span></span>';
  }

  // ── Public API ─────────────────────────────────────────────
  window.renderSchedule = renderSchedule;
  window.scheduleAddEntry = function(jobId, dateISO) {
    openEntryEditor(null, dateISO, jobId);
  };
})();
