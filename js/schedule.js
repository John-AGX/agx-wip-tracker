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
  //
  // Cache merge rule: any entry whose id starts with "sch_local_"
  // never made it to the server (offline create). We keep those in
  // the in-memory list so the user sees them; they're promoted to
  // real server rows the next time the user edits + saves them.
  //
  // Migration rule: any cached entry whose id is NOT in the server's
  // response AND doesn't have the sch_local_ prefix is treated as an
  // orphaned Phase-1-style entry (created before server persistence
  // shipped). We POST them up so they're not silently dropped — see
  // migrateOrphanedCacheEntries().
  function fetchEntries() {
    if (!isApiReady()) {
      _state.entries = loadCachedEntries();
      return Promise.resolve(_state.entries);
    }
    return window.agxApi.schedule.list().then(function(res) {
      var serverList = (res && res.entries) || [];
      var cached = loadCachedEntries();
      var serverIds = {};
      serverList.forEach(function(e) { if (e.id) serverIds[e.id] = true; });
      var localOnly = cached.filter(function(e) {
        return typeof e.id === 'string' && e.id.indexOf('sch_local_') === 0;
      });
      // Phase-1 orphans — cached, not on the server, not local-only.
      var orphans = cached.filter(function(e) {
        if (!e || !e.id) return false;
        if (serverIds[e.id]) return false;
        if (typeof e.id === 'string' && e.id.indexOf('sch_local_') === 0) return false;
        return true;
      });
      var merged = serverList.concat(localOnly);
      _state.entries = merged;
      cacheEntries(merged);
      // Kick off the migration in the background and re-render once
      // it completes. This is best-effort — failures get logged but
      // don't block the render.
      if (orphans.length) {
        migrateOrphanedCacheEntries(orphans).then(function(migrated) {
          if (!migrated.length) return;
          // Append the new server rows and drop the orphan id
          // versions from the cache.
          _state.entries = _state.entries.concat(migrated);
          cacheEntries(_state.entries);
          renderGrid();
          refreshWeekSummary();
          // One-shot toast so the user knows what happened.
          try { console.info('[schedule] migrated ' + migrated.length + ' Phase-1 entries to server'); } catch (e) {}
        });
      }
      return merged;
    }).catch(function(err) {
      console.warn('[schedule] fetch failed, using cache:', err && err.message);
      _state.entries = loadCachedEntries();
      return _state.entries;
    });
  }

  // POST each orphaned cache entry to the server. Resolves with the
  // list of successfully-migrated server rows.
  function migrateOrphanedCacheEntries(orphans) {
    if (!orphans || !orphans.length) return Promise.resolve([]);
    var jobs = (window.appData && Array.isArray(window.appData.jobs)) ? window.appData.jobs : [];
    var validJobIds = {};
    jobs.forEach(function(j) { validJobIds[j.id] = true; });
    var promises = orphans.map(function(e) {
      // Drop entries that reference a job that no longer exists —
      // POST would 404 otherwise and the server would reject. Better
      // to skip them quietly than break the whole migration.
      if (!validJobIds[e.jobId]) return Promise.resolve(null);
      var payload = {
        jobId: e.jobId,
        startDate: e.startDate,
        days: parseInt(e.days, 10) || 1,
        crew: Array.isArray(e.crew) ? e.crew : [],
        includesWeekends: !!e.includesWeekends,
        status: e.status || 'planned',
        notes: e.notes || ''
      };
      return window.agxApi.schedule.create(payload)
        .then(function(res) { return res && res.entry ? res.entry : null; })
        .catch(function(err) {
          console.warn('[schedule] migrate orphan failed (' + e.id + '):', err && err.message);
          return null;
        });
    });
    return Promise.all(promises).then(function(results) {
      return results.filter(function(r) { return !!r; });
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

    el.innerHTML =
      '<div class="sch-cal-toolbar">' +
        '<div class="sch-cal-nav">' +
          '<button class="sch-btn sch-btn-icon" id="schPrev" title="Previous month">&lsaquo;</button>' +
          '<div class="sch-cal-month" id="schMonth">' + MONTH_NAMES[cur.getMonth()] + ' ' + cur.getFullYear() + '</div>' +
          '<button class="sch-btn sch-btn-icon" id="schNext" title="Next month">&rsaquo;</button>' +
          '<button class="sch-btn" id="schToday" style="margin-left:6px;">Today</button>' +
        '</div>' +
        '<label class="sch-toolbar-toggle" title="Calendar display only — does not change how production days are counted on entries.">' +
          '<input type="checkbox" id="schWeekendToggle" ' + (_state.settings.showWeekends ? 'checked' : '') + ' /> ' +
          'Show Sat/Sun columns' +
        '</label>' +
        '<div class="sch-toolbar-spacer"></div>' +
        '<button class="sch-btn sch-btn-primary" id="schAddEntry">+ Schedule entry</button>' +
      '</div>' +
      '<div class="sch-cal-grid" id="schGrid"></div>' +
      '<div class="sch-week-summary" id="schWeekSummary"></div>';
    // refreshWeekSummary populates the bar — single source of truth so
    // the label / numbers can't drift between initial render and
    // post-edit refreshes.
    refreshWeekSummary();

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

    // Always render 6 weeks (42 cells) so the grid has a stable shape
    // — Outlook does the same. Trailing/leading days from sibling
    // months get dimmed.
    var html = '';

    // Day-of-week header row.
    DOW_LABELS.forEach(function(d) {
      html += '<div class="sch-cal-dow">' + d + '</div>';
    });

    var today = new Date();

    // Per-week rendering — a week is its own positioned container so
    // entry bars can span multiple day columns continuously.
    for (var w = 0; w < 6; w++) {
      var weekStart = addDays(gridStart, w * 7);
      html += renderWeekRow(weekStart, first, today);
    }

    grid.innerHTML = html;
    wireGridDrop(grid);
    wireGridClicks(grid);
  }

  // Render a single week row. Day cells form a 7-column sub-grid;
  // entry bars layer on top using grid-column spans so a multi-day
  // entry paints as one continuous bar instead of breaking on every
  // cell boundary. Entries that cross the week boundary get clipped
  // to the visible week and re-emerge in the next week's bar layer.
  function renderWeekRow(weekStart, monthCursor, today) {
    // Collect day metadata for this week.
    var days = [];
    for (var i = 0; i < 7; i++) {
      var d = addDays(weekStart, i);
      days.push({
        date: d,
        iso: toISODate(d),
        dow: d.getDay(),
        inMonth: d.getMonth() === monthCursor.getMonth(),
        isWeekend: (d.getDay() === 0 || d.getDay() === 6),
        isToday: isSameDay(d, today)
      });
    }
    var weekKeys = days.map(function(x) { return x.iso; });

    // Find entries that touch this week. Compute their per-week
    // segment (start col, span) so each entry renders as one bar
    // segment per week it spans.
    var hideWeekend = !_state.settings.showWeekends;
    var segments = [];
    _state.entries.forEach(function(e) {
      var span = entrySpanDays(e);
      // Filter the entry's days to the ones inside this week.
      var here = span.filter(function(k) { return weekKeys.indexOf(k) !== -1; });
      if (!here.length) return;
      // Convert dates to column indices (0..6). When weekends are
      // hidden the user-visible columns shift, but since we keep the
      // 7-col grid and just hide Sat/Sun cells, indices stay aligned.
      var cols = here.map(function(k) { return weekKeys.indexOf(k); });
      cols.sort(function(a, b) { return a - b; });
      // An entry's days may not be contiguous (e.g. weekends skipped).
      // Group consecutive runs into separate segments so each renders
      // as its own bar.
      var entrySegStart = segments.length;
      var run = [cols[0]];
      for (var i = 1; i < cols.length; i++) {
        if (cols[i] === cols[i - 1] + 1) {
          run.push(cols[i]);
        } else {
          segments.push({ entry: e, startCol: run[0], span: run.length });
          run = [cols[i]];
        }
      }
      segments.push({ entry: e, startCol: run[0], span: run.length });
      // Mark the last day of this entry overall so we know which
      // segment gets the resize handle. The handle only renders on
      // segments that contain the entry's final calendar day.
      var lastDayKey = span[span.length - 1];
      for (var j = entrySegStart; j < segments.length; j++) {
        var seg = segments[j];
        var segDates = [];
        for (var k = 0; k < seg.span; k++) segDates.push(weekKeys[seg.startCol + k]);
        if (segDates.indexOf(lastDayKey) !== -1) {
          seg.isLastSegment = true;
        }
      }
    });

    // Stack segments — each gets a row index based on the lowest
    // available row that doesn't conflict with an earlier-placed
    // segment in its column range. Greedy left-to-right packing.
    segments.sort(function(a, b) {
      if (a.startCol !== b.startCol) return a.startCol - b.startCol;
      return b.span - a.span;
    });
    var rowOccupancy = []; // rowOccupancy[r] = array of {start, end}
    segments.forEach(function(seg) {
      var placed = false;
      for (var r = 0; r < 12 && !placed; r++) {
        rowOccupancy[r] = rowOccupancy[r] || [];
        var clash = rowOccupancy[r].some(function(slot) {
          return !(seg.startCol + seg.span <= slot.start || seg.startCol >= slot.end);
        });
        if (!clash) {
          rowOccupancy[r].push({ start: seg.startCol, end: seg.startCol + seg.span });
          seg.row = r;
          placed = true;
        }
      }
      if (!placed) seg.row = 11; // last-resort overflow row
    });

    // ── DOM
    var html = '<div class="sch-cal-week-row">';

    // Day-cell base layer (one cell per column).
    days.forEach(function(d) {
      if (d.isWeekend && hideWeekend) {
        html += '<div class="sch-cal-day sch-weekend sch-cal-day-hidden"></div>';
        return;
      }
      var cls = 'sch-cal-day';
      if (!d.inMonth) cls += ' sch-other-month';
      if (d.isWeekend) cls += ' sch-weekend';
      if (d.isToday) cls += ' sch-today';
      html += '<div class="' + cls + '" data-date="' + d.iso + '">' +
        '<span class="sch-cal-day-num">' + d.date.getDate() + '</span>' +
      '</div>';
    });

    // Overlay layer — absolute container positioned over the week
    // row. Bars use percent-based left/width so they snap to the
    // 7-col layout and stay aligned when the row resizes.
    html += '<div class="sch-cal-bars">';
    var maxRow = 0;
    segments.forEach(function(seg) {
      // Note: when "Show Sat/Sun" is off but an entry's includesWeekends
      // is true, the bar still renders over the (visibility:hidden)
      // weekend cells. Underlying cells take grid space, so the
      // percentage math stays correct — bar just paints over blank
      // visual area. That's the right call: respect what the entry
      // actually represents instead of dropping data.
      var leftPct = (seg.startCol / 7) * 100;
      var widthPct = (seg.span / 7) * 100;
      var topPx = 22 + seg.row * 18; // 22px reserved for the day-num
      if (seg.row > maxRow) maxRow = seg.row;
      var e = seg.entry;
      var job = jobById(e.jobId);
      var color = colorForJob(e.jobId);
      var statusCls = '';
      if (e.status === 'done') statusCls = ' sch-entry-bar-done';
      else if (e.status === 'rolled-over') statusCls = ' sch-entry-bar-rolled';
      var meta = e.crew && e.crew.length ? ' · ' + e.crew.length + '👷' : '';
      var label = job ? (job.jobNumber || job.title || 'Job') : 'Job';
      // Days-remaining hint shown after the label for spans ≥ 2 cols.
      var hint = seg.span >= 2 ? ' (' + seg.span + 'd)' : '';
      // Only the segment containing the entry's last day gets the
      // resize handle — dragging that handle adjusts entry.days.
      // Handles on every segment would let the user shrink the
      // middle of a multi-week entry, which doesn't have a sensible
      // mapping to days/startDate.
      var handleHtml = seg.isLastSegment
        ? '<span class="sch-entry-bar-handle" data-entry-id="' + escapeAttr(e.id) + '" title="Drag to extend / shrink production days"></span>'
        : '';
      html += '<div class="sch-entry-bar' + statusCls + '" ' +
        'data-entry-id="' + escapeAttr(e.id) + '" ' +
        'style="left:' + leftPct.toFixed(4) + '%;width:calc(' + widthPct.toFixed(4) + '% - 4px);top:' + topPx + 'px;background:' + color + ';" ' +
        'title="' + escapeAttr(jobLabel(job)) + (e.notes ? ' — ' + escapeAttr(e.notes) : '') + '">' +
        '<span class="sch-entry-bar-label">' + escapeHTML(label) + hint + '</span>' +
        (meta ? '<span class="sch-entry-bar-meta">' + meta + '</span>' : '') +
        handleHtml +
      '</div>';
    });
    html += '</div></div>'; // close .sch-cal-bars + .sch-cal-week-row
    return html;
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
    grid.querySelectorAll('.sch-entry-bar[data-entry-id]').forEach(function(el) {
      el.addEventListener('click', function(e) {
        // The resize handle handles its own mousedown/up — clicks
        // shouldn't open the editor. The handle's mousedown calls
        // stopPropagation, so click also won't fire on it normally,
        // but defense-in-depth here keeps it tight.
        if (e.target.closest('.sch-entry-bar-handle')) return;
        // If we just finished a resize-drag, suppress the click that
        // browsers fire as the mouseup release. _resizeJustEnded is
        // set true for one tick by the resize-drag handler.
        if (_resizeJustEnded) {
          _resizeJustEnded = false;
          return;
        }
        e.stopPropagation();
        var id = el.getAttribute('data-entry-id');
        var entry = _state.entries.find(function(x) { return x.id === id; });
        if (entry) openEntryEditor(entry, entry.startDate, entry.jobId);
      });
    });
    grid.querySelectorAll('.sch-cal-day[data-date]').forEach(function(cell) {
      cell.addEventListener('click', function(e) {
        if (e.target.closest('.sch-entry-bar')) return;
        var date = cell.getAttribute('data-date');
        openEntryEditor(null, date);
      });
    });
    wireResizeHandles(grid);
  }

  // ── Drag-resize: extend / shrink an entry by its right edge ─
  // Phase 3. Handles only appear on the SEGMENT containing the
  // entry's final day (isLastSegment in renderWeekRow). Drag math
  // walks forward from the entry's startDate, counting calendar
  // days that pass under the cursor and respecting the entry's
  // includesWeekends flag — same rule entrySpanDays uses to expand
  // the entry forward, so what the user drags is what they save.
  var _resizeJustEnded = false;
  function wireResizeHandles(grid) {
    grid.querySelectorAll('.sch-entry-bar-handle').forEach(function(handle) {
      handle.addEventListener('mousedown', function(e) {
        e.preventDefault();
        e.stopPropagation();
        var entryId = handle.getAttribute('data-entry-id');
        var entry = _state.entries.find(function(x) { return x.id === entryId; });
        if (!entry) return;
        startResizeDrag(entry, e);
      });
    });
  }

  function startResizeDrag(entry, downEv) {
    var bar = downEv.target.closest('.sch-entry-bar');
    if (!bar) return;
    var weekRow = bar.closest('.sch-cal-week-row');
    if (!weekRow) return;

    // Live preview state — we update entry.days locally during the
    // drag and re-render the grid so the bar grows/shrinks in real
    // time. The PATCH only fires on mouseup if the value changed.
    var originalDays = parseInt(entry.days, 10) || 1;
    var startDate = parseISODate(entry.startDate);
    if (!startDate) return;

    // Build a forward-walk function: given a target column index in
    // the visible-week-row coords, count how many days from the
    // entry's startDate to that column. Used to compute the new
    // production-day count as the cursor moves.
    function daysAtCursor(clientX, hostRow) {
      var rect = hostRow.getBoundingClientRect();
      var colWidth = rect.width / 7;
      // Clamp to 0..6 (or 7 to allow snapping just past the right edge).
      var rawCol = (clientX - rect.left) / colWidth;
      var col = Math.max(0, Math.min(6, Math.floor(rawCol)));
      // Compute target date = first day of that hostRow + col.
      var hostDow = hostRow.querySelector('.sch-cal-day[data-date]');
      // First *visible* day cell in the row. If weekends hidden the
      // first cell may be Mon — use it as the row's anchor and add
      // its index back.
      var anchorDate = null, anchorCol = 0;
      var dayCells = hostRow.querySelectorAll('.sch-cal-day[data-date]');
      // Re-derive the actual Monday of this week: take the first
      // day-cell's date, subtract its dow-offset to Monday.
      if (dayCells.length) {
        var firstDate = parseISODate(dayCells[0].getAttribute('data-date'));
        if (firstDate) {
          var firstDow = firstDate.getDay();
          var deltaToMon = firstDow === 0 ? -6 : (1 - firstDow);
          anchorDate = addDays(firstDate, deltaToMon);
        }
      }
      if (!anchorDate) return originalDays;
      var targetDate = addDays(anchorDate, col);
      // Days from entry startDate to targetDate, respecting the
      // entry's weekend rule. We re-use entrySpanDays' math by
      // building a temp entry with a generous days count, then
      // searching for the targetDate.
      var probe = { startDate: entry.startDate, days: 365, includesWeekends: !!entry.includesWeekends };
      var span = entrySpanDays(probe);
      var targetIso = toISODate(targetDate);
      var idx = span.indexOf(targetIso);
      if (idx >= 0) return idx + 1;
      // Cursor is past the entry's last calendar day — entry must
      // grow to reach. Estimate by counting calendar days, then
      // scaling for the weekend skip when needed. Floor to 1.
      var msPerDay = 86400000;
      var calDays = Math.round((targetDate.getTime() - startDate.getTime()) / msPerDay) + 1;
      if (calDays < 1) calDays = 1;
      if (entry.includesWeekends) return calDays;
      // Skipping weekends: walk forward from startDate, count workdays
      // up to and including targetDate.
      var workDays = 0;
      var cursor = new Date(startDate);
      while (cursor <= targetDate) {
        var dow = cursor.getDay();
        if (dow !== 0 && dow !== 6) workDays++;
        cursor.setDate(cursor.getDate() + 1);
      }
      return Math.max(1, workDays);
    }

    function onMove(ev) {
      // Always resolve the host row from the cursor's CURRENT position
      // — when the user drags into a different week row, switch.
      var below = document.elementFromPoint(ev.clientX, ev.clientY);
      var hostRow = below ? below.closest('.sch-cal-week-row') : null;
      if (!hostRow) hostRow = weekRow;
      var newDays = daysAtCursor(ev.clientX, hostRow);
      newDays = Math.max(1, Math.min(365, newDays));
      if (newDays !== (entry.days | 0)) {
        entry.days = newDays;
        renderGrid();
        refreshWeekSummary();
      }
    }

    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('sch-resizing');
      _resizeJustEnded = true;
      setTimeout(function() { _resizeJustEnded = false; }, 0);
      var newDays = parseInt(entry.days, 10) || 1;
      if (newDays === originalDays) return;
      // Persist. PATCH carries the optimistic-locking token. On
      // failure we revert the local change.
      if (!isApiReady() || (typeof entry.id === 'string' && entry.id.indexOf('sch_local_') === 0)) {
        // Local-only entry — just update the cache; no PATCH route.
        cacheEntries(_state.entries);
        return;
      }
      var payload = { days: newDays };
      if (entry.updatedAt) payload.expectedUpdatedAt = entry.updatedAt;
      window.agxApi.schedule.update(entry.id, payload).then(function(res) {
        var saved = res && res.entry;
        if (!saved) return;
        var idx = _state.entries.findIndex(function(x) { return x.id === entry.id; });
        if (idx >= 0) _state.entries[idx] = saved;
        cacheEntries(_state.entries);
        renderGrid();
        refreshWeekSummary();
      }).catch(function(err) {
        var msg = (err && err.message) || String(err);
        alert('Could not save resize: ' + msg);
        // Revert local change so the UI matches truth.
        entry.days = originalDays;
        renderGrid();
        refreshWeekSummary();
      });
    }

    document.body.classList.add('sch-resizing');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
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
      // Coerce every crew id to integer up-front. users.id is SERIAL
      // server-side; if we mix strings (from getAttribute on click)
      // and ints (from agxApi.users.list), indexOf strict-equality
      // checks fail and the picker can't tell what's already selected
      // when re-opening an entry. One canonical type fixes both ends.
      var crew = (entry && Array.isArray(entry.crew))
        ? entry.crew.map(function(x) { var n = parseInt(x, 10); return Number.isFinite(n) ? n : null; })
                    .filter(function(n) { return n !== null; })
        : [];
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

      var users = _state.users || [];
      var userIdSet = {};
      users.forEach(function(u) {
        var n = parseInt(u.id, 10);
        if (Number.isFinite(n)) userIdSet[n] = true;
      });
      var crewPills = users.map(function(u) {
        var uid = parseInt(u.id, 10);
        var on = crew.indexOf(uid) !== -1;
        return '<span class="sch-crew-pill' + (on ? ' selected' : '') + '" data-user-id="' + uid + '">' +
          escapeHTML(u.name || u.email || '(unnamed)') +
        '</span>';
      }).join('');
      // Ghost pills for crew ids that no longer match an active user
      // (deleted / deactivated). Marked so the data is visible in the
      // UI — clicking removes them from the entry's crew list.
      var missingCrewPills = crew.filter(function(id) { return !userIdSet[id]; }).map(function(id) {
        return '<span class="sch-crew-pill selected sch-crew-pill-missing" ' +
               'data-user-id="' + id + '" title="User no longer active. Click to remove.">' +
          'Unknown user #' + id +
        '</span>';
      }).join('');
      crewPills = crewPills + missingCrewPills;

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
            '<div title="When ON: Sat/Sun count toward the entry\'s span (e.g. 5 days starting Friday → ends Tuesday). When OFF: weekends are skipped (5 days starting Friday → ends Thursday).">' +
              '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;text-transform:none;letter-spacing:normal;font-weight:500;color:var(--text,#e4e6f0);">' +
                '<input type="checkbox" id="schEditWeekends" ' + (includesWeekends ? 'checked' : '') + ' />' +
                '<span>Count weekends as production days</span>' +
              '</label>' +
              '<div style="font-size:10px;color:var(--text-dim,#888);margin-top:4px;line-height:1.3;">Affects how the production-days count expands across the calendar.</div>' +
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

      // Crew pill toggle — store ints to match the integer ids
      // delivered by /api/auth/users (and expected by /api/schedule).
      // Ghost pills (missing users) just remove themselves on click;
      // toggling them off would leave a striped-but-unselected pill
      // which reads as broken.
      modal.querySelectorAll('.sch-crew-pill').forEach(function(p) {
        p.addEventListener('click', function() {
          var id = parseInt(p.getAttribute('data-user-id'), 10);
          if (!Number.isFinite(id)) return;
          var isMissing = p.classList.contains('sch-crew-pill-missing');
          var idx = crew.indexOf(id);
          if (isMissing) {
            if (idx >= 0) crew.splice(idx, 1);
            p.remove();
            return;
          }
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
          // Offline-created entries (id prefixed sch_local_) never
          // existed on the server, so a PATCH would 404. Promote them
          // to a POST instead — the server assigns a real id and we
          // drop the placeholder from the cache below.
          var isLocalOnly = isEdit && entry && typeof entry.id === 'string' && entry.id.indexOf('sch_local_') === 0;
          // Pass the entry's last-seen updatedAt as the optimistic-
          // locking token. If someone else saved this entry in the
          // meantime the server returns 409 and we surface a refresh
          // prompt instead of silently overwriting their change.
          if (isEdit && !isLocalOnly && entry && entry.updatedAt) {
            payload.expectedUpdatedAt = entry.updatedAt;
          }
          var req = (isEdit && !isLocalOnly)
            ? window.agxApi.schedule.update(entry.id, payload)
            : window.agxApi.schedule.create(payload);
          req.then(function(res) {
            var saved = res && res.entry;
            if (isLocalOnly) {
              // Replace the local placeholder with the server row.
              _state.entries = _state.entries.filter(function(x) { return x.id !== entry.id; });
            }
            done(saved);
          }).catch(function(err) {
            var msg = (err && err.message) || String(err);
            // 409 conflict — let the user know and offer to refresh
            // with the server's current copy. The error text from
            // the api layer carries the route's "Entry changed
            // elsewhere — refresh and try again." message.
            if (/changed elsewhere|409/i.test(msg)) {
              setBusy(false);
              var goRefresh = confirm(
                'This entry was just updated by someone else.\n\n' +
                'Reload the latest version? (Your unsaved changes will be lost.)'
              );
              if (goRefresh) {
                fetchEntries().then(function() {
                  close();
                  renderGrid();
                  refreshWeekSummary();
                });
              }
              return;
            }
            fail(err);
          });
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
    // Week summary follows the visible month: shows the current week
    // when viewing the current month, otherwise the first full week
    // of the visible month so PMs planning ahead see relevant numbers.
    var ref = weekSummaryReferenceDate();
    var summary = weekSummaryForCursor(ref);
    var ws = parseISODate(summary.weekStart);
    var we = parseISODate(summary.weekEnd);
    var label = (ws && we)
      ? 'Week of ' + MONTH_NAMES[ws.getMonth()].slice(0, 3) + ' ' + ws.getDate() +
        '–' + (we.getMonth() === ws.getMonth()
          ? we.getDate()
          : MONTH_NAMES[we.getMonth()].slice(0, 3) + ' ' + we.getDate())
      : 'This week';
    bar.innerHTML =
      '<span class="sch-week-summary-label">' + escapeHTML(label) + '</span>' +
      '<span><span class="sch-week-summary-label">Days</span> <span class="sch-week-summary-val">' + summary.scheduledDays + '</span></span>' +
      '<span><span class="sch-week-summary-label">Expected revenue</span> <span class="sch-week-summary-val sch-rev">' + fmtMoney(summary.expectedRevenue) + '</span></span>' +
      '<span><span class="sch-week-summary-label">Jobs</span> <span class="sch-week-summary-val">' + summary.jobsCount + '</span></span>';
  }

  // Pick the date the bottom-bar week summary reports on:
  //   viewing current month → today (this week)
  //   viewing other month   → first day of that month (planning ahead)
  function weekSummaryReferenceDate() {
    var today = new Date();
    var cur = _state.cursor || startOfMonth(today);
    if (cur.getFullYear() === today.getFullYear() && cur.getMonth() === today.getMonth()) {
      return today;
    }
    return new Date(cur);
  }

  // ── Public API ─────────────────────────────────────────────
  window.renderSchedule = renderSchedule;
  window.scheduleAddEntry = function(jobId, dateISO) {
    openEntryEditor(null, dateISO, jobId);
  };
})();
