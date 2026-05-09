// ============================================================
// Project 86 Schedule — production-scheduling calendar (Phase 1)
//
// Outlook-style monthly grid + sidebar of in-progress jobs the
// PM drags onto days during the Friday production-scheduling
// meeting. Phase 1 = localStorage-only (`p86-schedule-entries`);
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
  // Phase 2: server is the source of truth (window.p86Api.schedule).
  // localStorage stays around as an offline cache + the seed for the
  // first paint while the network call resolves. Settings (view month
  // / weekend toggle) stay client-only since they're per-user UX state
  // not collaborative data.
  var STORAGE_KEY = 'p86-schedule-entries';
  var SETTINGS_KEY = 'p86-schedule-settings';

  function loadCachedEntries() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') || []; }
    catch (e) { return []; }
  }
  function cacheEntries(list) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); }
    catch (e) { /* defensive */ }
  }
  function loadSettings() {
    var defaults = {
      showWeekends: true,
      viewMonth: null,
      // Default status filter selects the actively-relevant set —
      // these are the jobs PMs schedule production for. The ref to
      // DEFAULT_STATUS_SET happens after that const is hoisted at
      // module scope so this is safe.
      statusFilter: {
        'New': true, 'In Progress': true, 'Backlog': true
      },
      // Default Job Type / Work Type filters: all on. PMs typically
      // narrow these manually (e.g., a renovations PM toggles off
      // Service tickets); leaving them all on means the sidebar
      // looks the same as before for users who don't touch the new
      // filter rows.
      jobTypeFilter: {
        'Service': true, 'Renovation': true, 'Work Order': true
      },
      workTypeFilter: {
        'In-house': true, 'Sub': true, 'Both': true
      },
      // Inline week-summary pin state. Pinned=false means the
      // summary tracks the current real-life week, no matter which
      // month is being viewed. Pinned=true locks it to whichever
      // week the user last selected via the calendar's left-edge
      // focus rail or the inline pin button.
      weekSummaryPinned: false
    };
    try {
      var saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      var merged = Object.assign({}, defaults, saved);
      // Ensure each filter object exists even when the legacy save
      // omitted it. Don't reset to defaults if it's there but
      // empty — empty/explicit selections must be honored (the
      // filter treats "all off" as wildcard).
      if (!merged.statusFilter || typeof merged.statusFilter !== 'object') {
        merged.statusFilter = Object.assign({}, defaults.statusFilter);
      }
      if (!merged.jobTypeFilter || typeof merged.jobTypeFilter !== 'object') {
        merged.jobTypeFilter = Object.assign({}, defaults.jobTypeFilter);
      }
      if (!merged.workTypeFilter || typeof merged.workTypeFilter !== 'object') {
        merged.workTypeFilter = Object.assign({}, defaults.workTypeFilter);
      }
      return merged;
    } catch (e) { return defaults; }
  }
  function saveSettings(s) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }
    catch (e) { /* defensive */ }
  }

  function isApiReady() {
    return !!(window.p86Api &&
              window.p86Api.schedule &&
              window.p86Api.isAuthenticated &&
              window.p86Api.isAuthenticated());
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
    return window.p86Api.schedule.list().then(function(res) {
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
      return window.p86Api.schedule.create(payload)
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
    // Week starts Sunday — Outlook / standard US calendar convention.
    // Puts Sun at the visual left edge and Sat at the right, so the
    // weekday block (Mon-Fri) is bookended by the weekends — matches
    // how PMs read a wall calendar.
    var x = new Date(d);
    var day = x.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    x.setDate(x.getDate() - day);
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
  // Sun-start order matches startOfWeek() and the new "weekends on
  // either side" layout. Index 0 = Sun, index 6 = Sat. The weekend
  // columns can collapse to half-width via CSS when showWeekends is
  // on; toggling it off makes them zero-width via the same CSS hook.
  var DOW_LABELS  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  // Weekend cols are 0.5fr (slim bookends) when shown; weekday cols
  // are 1fr each. Total 6fr units => bars use these proportions when
  // computing left%/width%.
  var COL_WEIGHTS_SHOWN  = [0.5, 1, 1, 1, 1, 1, 0.5];
  var COL_WEIGHTS_HIDDEN = [0,   1, 1, 1, 1, 1, 0  ]; // Sat/Sun collapse to 0
  function colWeights() {
    return _state.settings.showWeekends ? COL_WEIGHTS_SHOWN : COL_WEIGHTS_HIDDEN;
  }
  function colWeightSum() {
    var w = colWeights();
    return w.reduce(function(s, x) { return s + x; }, 0);
  }
  // Left% offset of a column (0-indexed) relative to the row's start.
  function colLeftPct(col) {
    var w = colWeights();
    var sum = 0;
    for (var i = 0; i < col; i++) sum += w[i];
    return (sum / colWeightSum()) * 100;
  }
  // Width% spanning [startCol .. startCol+span-1].
  function colWidthPct(startCol, span) {
    var w = colWeights();
    var sum = 0;
    for (var i = startCol; i < startCol + span; i++) sum += (w[i] || 0);
    return (sum / colWeightSum()) * 100;
  }

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
  // Three independent multi-select filter bars on the sidebar:
  //   - Status: lifecycle gate. Default = active set (the jobs a PM
  //     is actively scheduling production for).
  //   - Job Type: Service vs full Renovation vs Work Order — these
  //     run very differently and a PM scheduling renovations doesn't
  //     want service tickets in their list.
  //   - Work Type: who does the work. In-house crew vs sub vs both.
  // Default for a filter bar is "all on" (everything passes).
  // Empty selection (user toggles every pill off) surfaces every
  // job — there's no useful "match nothing" state, so we treat
  // empty as wildcard. Same convention for all three bars.
  var STATUS_FILTERS = ['New', 'In Progress', 'Backlog', 'On Hold', 'Completed', 'Archived'];
  var DEFAULT_STATUS_SET = { 'New': true, 'In Progress': true, 'Backlog': true };

  var JOB_TYPE_FILTERS = ['Service', 'Renovation', 'Work Order'];
  var DEFAULT_JOB_TYPE_SET = { 'Service': true, 'Renovation': true, 'Work Order': true };

  var WORK_TYPE_FILTERS = ['In-house', 'Sub', 'Both'];
  var DEFAULT_WORK_TYPE_SET = { 'In-house': true, 'Sub': true, 'Both': true };

  var _state = {
    cursor: null,        // first day of the month being viewed
    entries: [],
    settings: {
      showWeekends: true,
      viewMonth: null,
      // Persisted across sessions. Object keyed by string label,
      // value true/false. Missing key = false (filtered out).
      statusFilter: Object.assign({}, DEFAULT_STATUS_SET),
      jobTypeFilter: Object.assign({}, DEFAULT_JOB_TYPE_SET),
      workTypeFilter: Object.assign({}, DEFAULT_WORK_TYPE_SET)
    },
    users: [],           // hydrated from /api/auth/users
    sidebarSearch: '',
    // ISO YYYY-MM-DD for the first day (Sun) of the week the user
    // explicitly picked via the calendar's week-selector ring. null
    // = use the default reference date logic.
    focusWeekStart: null,
    // Weather forecast cache: { [jobId]: { status, days, address } }.
    // Populated by /api/weather/jobs in the background after the grid
    // paints. The grid re-renders once weather lands so chips show up
    // without a flash of empty bars on first paint.
    weather: {},
    weatherLoading: false,
    weatherFetchedAt: 0
  };

  // ── Job pool ───────────────────────────────────────────────
  // Apply the three multi-select filter bars (status / jobType /
  // workType) to the global jobs list. Empty selection on any bar
  // is treated as wildcard for that dimension so the user is never
  // stranded with no list. All comparisons are case- and whitespace-
  // tolerant since job records sometimes carry slight variations
  // ("In-House" vs "In-house", "Work order" vs "Work Order").
  function filteredJobs() {
    var jobs = (window.appData && Array.isArray(window.appData.jobs)) ? window.appData.jobs : [];
    var statusSel   = _state.settings.statusFilter   || {};
    var jobTypeSel  = _state.settings.jobTypeFilter  || {};
    var workTypeSel = _state.settings.workTypeFilter || {};
    var anyStatus   = Object.keys(statusSel).some(function(k) { return statusSel[k]; });
    var anyJobType  = Object.keys(jobTypeSel).some(function(k) { return jobTypeSel[k]; });
    var anyWorkType = Object.keys(workTypeSel).some(function(k) { return workTypeSel[k]; });
    return jobs.filter(function(j) {
      if (anyStatus) {
        var s = String(j.status || '').trim().toLowerCase();
        var match = STATUS_FILTERS.some(function(opt) { return statusSel[opt] && s === opt.toLowerCase(); });
        if (!match) return false;
      }
      if (anyJobType) {
        var t = String(j.jobType || '').trim().toLowerCase();
        var matchT = JOB_TYPE_FILTERS.some(function(opt) { return jobTypeSel[opt] && t === opt.toLowerCase(); });
        if (!matchT) return false;
      }
      if (anyWorkType) {
        var w = String(j.workType || '').trim().toLowerCase();
        var matchW = WORK_TYPE_FILTERS.some(function(opt) { return workTypeSel[opt] && w === opt.toLowerCase(); });
        if (!matchW) return false;
      }
      return true;
    });
  }

  function jobById(id) {
    var jobs = (window.appData && Array.isArray(window.appData.jobs)) ? window.appData.jobs : [];
    return jobs.find(function(j) { return j.id === id; }) || null;
  }

  // ── Weather fetch / lookup ─────────────────────────────────
  // Pulls forecasts for every job that has at least one entry on the
  // visible 6-week grid. Throttled to one fetch per 10 minutes for
  // the same job-set, so navigating between months in quick succession
  // doesn't hammer the API. The server caches NWS responses anyway,
  // but skipping the round-trip when nothing's changed is cheaper.
  var WEATHER_CLIENT_TTL_MS = 10 * 60 * 1000;
  var _weatherLastIdsKey = '';
  function refreshWeatherForVisibleJobs() {
    if (!window.p86Api || !window.p86Api.weather || !window.p86Api.isAuthenticated || !window.p86Api.isAuthenticated()) {
      return;
    }
    // Collect every jobId that has an entry in the visible 6-week
    // window. For simplicity (and because the user can scroll
    // months), we ask for all jobs that have ANY entry; the server
    // de-dupes lookups and the in-memory NWS cache makes repeated
    // lookups cheap.
    var ids = {};
    _state.entries.forEach(function(e) { if (e.jobId) ids[e.jobId] = true; });
    var idList = Object.keys(ids);
    if (!idList.length) {
      _state.weather = {};
      return;
    }
    var key = idList.slice().sort().join(',');
    var fresh = (Date.now() - _state.weatherFetchedAt) < WEATHER_CLIENT_TTL_MS;
    if (key === _weatherLastIdsKey && fresh && Object.keys(_state.weather).length) return;
    if (_state.weatherLoading) return;
    _state.weatherLoading = true;
    window.p86Api.weather.jobs(idList).then(function(res) {
      _state.weather = (res && res.weather) || {};
      _state.weatherFetchedAt = Date.now();
      _weatherLastIdsKey = key;
      _state.weatherLoading = false;
      // Repaint so chips show up.
      renderGrid();
    }).catch(function(err) {
      console.warn('[schedule] weather fetch failed:', err && err.message);
      _state.weatherLoading = false;
    });
  }

  function weatherForJobOnDate(jobId, dateIso) {
    var w = _state.weather && _state.weather[jobId];
    if (!w || w.status !== 'ok' || !Array.isArray(w.days)) return null;
    for (var i = 0; i < w.days.length; i++) {
      if (w.days[i].date === dateIso) return w.days[i];
    }
    return null;
  }

  // Glyph + label helpers for the chip / forecast tile.
  function weatherIconForRisk(risk) {
    if (risk === 'red') return '⚠️';      // ⚠️
    if (risk === 'yellow') return '☁️';   // ☁️
    return '☀️';                           // ☀️
  }

  // Build the per-row weather strip for the day sheet. Handles the
  // missing-data states explicitly so users know why a row has no
  // weather (still loading / no address on file / geocode failed
  // / NWS error) instead of just blank.
  function renderDayRowWeather(jobWx, dateISO) {
    if (!jobWx) {
      // Fetch in flight or never started.
      return '<div class="sch-day-row-wx sch-day-row-wx-pending" title="Weather still loading…">' +
        '<span class="sch-wx-icon">…</span>' +
        '<span class="sch-day-row-wx-msg">Weather loading…</span>' +
      '</div>';
    }
    if (jobWx.status === 'no_address') {
      return '<div class="sch-day-row-wx sch-day-row-wx-muted" ' +
              'title="Add a job address (or a building address) to see weather here.">' +
        '<span class="sch-wx-icon">📍</span>' +
        '<span class="sch-day-row-wx-msg">No address on this job</span>' +
      '</div>';
    }
    if (jobWx.status === 'failed') {
      return '<div class="sch-day-row-wx sch-day-row-wx-muted" ' +
              'title="Could not geocode address: ' + escapeAttr(jobWx.address || '') + '">' +
        '<span class="sch-wx-icon">📍</span>' +
        '<span class="sch-day-row-wx-msg">Address not recognized</span>' +
      '</div>';
    }
    if (jobWx.status === 'error') {
      return '<div class="sch-day-row-wx sch-day-row-wx-muted" title="Weather service unavailable.">' +
        '<span class="sch-wx-icon">⚠</span>' +
        '<span class="sch-day-row-wx-msg">Weather unavailable</span>' +
      '</div>';
    }
    if (jobWx.status !== 'ok' || !Array.isArray(jobWx.days)) return '';
    var day = null;
    for (var i = 0; i < jobWx.days.length; i++) {
      if (jobWx.days[i].date === dateISO) { day = jobWx.days[i]; break; }
    }
    if (!day) {
      // Forecast doesn't cover this date (NWS gives ~7 days; rest are
      // out of range — common when scheduling weeks ahead).
      return '<div class="sch-day-row-wx sch-day-row-wx-muted" title="Outside the 7-day NWS forecast window.">' +
        '<span class="sch-wx-icon">📅</span>' +
        '<span class="sch-day-row-wx-msg">Beyond 7-day forecast</span>' +
      '</div>';
    }
    var icon = weatherIconForRisk(day.risk);
    var temp = (day.tempHigh != null) ? day.tempHigh + '°' +
               (day.tempLow != null ? ' / ' + day.tempLow + '°' : '') : '';
    var precip = day.precipPct ? day.precipPct + '% rain' : '';
    var wind = day.windMph ? day.windMph + ' mph wind' : '';
    var bits = [day.summary, temp, precip, wind].filter(Boolean);
    return '<div class="sch-day-row-wx sch-wx-' + day.risk + '">' +
      '<span class="sch-wx-icon">' + icon + '</span>' +
      '<span class="sch-day-row-wx-msg">' + escapeHTML(bits.join(' · ')) + '</span>' +
    '</div>';
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
    if (!window.p86Api || !window.p86Api.users || !window.p86Api.isAuthenticated || !window.p86Api.isAuthenticated()) {
      _state.users = [];
      return Promise.resolve([]);
    }
    return window.p86Api.users.list().then(function(res) {
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
  // Each job's "expected revenue per scheduled day" is its remaining
  // backlog spread evenly across every day it currently sits on the
  // schedule. Example: a $100k-backlog job scheduled for 3 days this
  // week + 2 days next week = $20k/day. The week the job is viewed in
  // gets `inWeekDays × $20k`. This replaces the old
  // contractAmount / totalProductionDays math, which double-counted
  // revenue once a job was already partly billed.
  //
  // Backlog source priority:
  //   1. job.ngBacklog — pushed by the node-graph engine after compute.
  //   2. Otherwise: (contractAmount or 0) × (1 − pctComplete/100), a
  //      contract-based proxy that ignores change orders. The schedule
  //      page doesn't have easy access to CO totals, but this is a
  //      reasonable planning estimate until the engine has run.
  function jobBacklog(job) {
    if (!job) return 0;
    if (job.ngBacklog != null) return Number(job.ngBacklog) || 0;
    var contract = Number(job.contractAmount || 0);
    var pct = Number(job.pctComplete || 0);
    if (contract <= 0) return 0;
    var remainingFrac = Math.max(0, 1 - (pct / 100));
    return contract * remainingFrac;
  }

  // Sum of every scheduled day for a job across every entry in state.
  // Used as the divisor for the per-day backlog allocation. Cached per
  // weekSummary call via a closure so we don't re-scan entries for
  // every job.
  function buildScheduledDaysIndex() {
    var index = {};
    _state.entries.forEach(function(e) {
      var span = entrySpanDays(e);
      if (!span.length) return;
      index[e.jobId] = (index[e.jobId] || 0) + span.length;
    });
    return index;
  }

  function jobDailyRate(job, scheduledDaysIndex) {
    if (!job) return 0;
    var totalDays = scheduledDaysIndex[job.id] || 0;
    if (totalDays <= 0) return 0;
    var backlog = jobBacklog(job);
    if (backlog <= 0) return 0;
    return backlog / totalDays;
  }

  function weekSummaryForCursor(cursor) {
    var ws = startOfWeek(cursor);
    var we = addDays(ws, 6);
    var totalDays = 0;
    var totalRev = 0;
    var jobsTouching = {};
    var scheduledDaysIndex = buildScheduledDaysIndex();
    _state.entries.forEach(function(e) {
      var span = entrySpanDays(e);
      var inWeek = span.filter(function(k) {
        var d = parseISODate(k);
        return d && d >= ws && d <= we;
      });
      if (!inWeek.length) return;
      var job = jobById(e.jobId);
      var rate = jobDailyRate(job, scheduledDaysIndex);
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
      // Fire off the per-job weather fetch in the background. The
      // grid will repaint when it lands so chips appear. Errors are
      // logged and swallowed so a weather outage doesn't break the
      // schedule view.
      refreshWeatherForVisibleJobs();
    });
  }

  // ── Render: sidebar ────────────────────────────────────────
  function renderSidebar() {
    var el = document.getElementById('schSidebar');
    if (!el) return;
    var jobs = filteredJobs();
    var q = _state.sidebarSearch.trim().toLowerCase();
    if (q) {
      jobs = jobs.filter(function(j) {
        var hay = (jobLabel(j) + ' ' + (j.client || '') + ' ' + (j.community || '')).toLowerCase();
        return hay.indexOf(q) !== -1;
      });
    }
    // Sort by jobNumber for predictable order
    jobs.sort(function(a, b) { return (a.jobNumber || '').localeCompare(b.jobNumber || ''); });

    // ── Pill-bar render helper ────────────────────────────────
    // Generates one filter row (label + pill cluster). data-filter
    // identifies which settings key the pill toggles, and data-value
    // carries the option string. The single click handler at the
    // bottom of renderSidebar walks data attributes back to state.
    function buildFilterBar(filterKey, label, options) {
      var sel = _state.settings[filterKey] || {};
      var activeCount = options.filter(function(o) { return sel[o]; }).length;
      var pills = options.map(function(o) {
        var on = !!sel[o];
        return '<button class="sch-status-pill' + (on ? ' active' : '') +
                '" data-filter="' + escapeAttr(filterKey) +
                '" data-value="' + escapeAttr(o) + '" type="button">' +
          escapeHTML(o) +
        '</button>';
      }).join('');
      return '<div class="sch-sidebar-status-bar">' +
        '<div class="sch-sidebar-status-label">' +
          escapeHTML(label) +
          ' <span style="color:var(--text-dim,#666);font-weight:400;">(' + activeCount + ' on)</span>' +
        '</div>' +
        '<div class="sch-sidebar-status-pills">' + pills + '</div>' +
      '</div>';
    }

    var html =
      '<div class="sch-sidebar-header">' +
        '<div class="sch-sidebar-title">Jobs</div>' +
        '<div class="sch-sidebar-sub">Drag any job onto a day to schedule it.</div>' +
      '</div>' +
      '<div class="sch-sidebar-search">' +
        '<input type="text" id="schSidebarSearch" placeholder="Search jobs…" value="' + escapeAttr(_state.sidebarSearch) + '" />' +
      '</div>' +
      // Three multi-select filter bars stacked. Each toggles
      // independently and applies as an AND across dimensions
      // (job must pass all three). Empty selection on any bar is
      // treated as wildcard for that dimension.
      buildFilterBar('statusFilter',   'Status',    STATUS_FILTERS) +
      buildFilterBar('jobTypeFilter',  'Job Type',  JOB_TYPE_FILTERS) +
      buildFilterBar('workTypeFilter', 'Work Type', WORK_TYPE_FILTERS) +
      '<div class="sch-sidebar-list" id="schSidebarList">';

    if (!jobs.length) {
      html += '<div class="sch-sidebar-empty">' +
        (q ? 'No jobs match.' : 'No jobs match the selected status.') +
      '</div>';
    } else {
      jobs.forEach(function(j) {
        var color = colorForJob(j.id);
        var pct = Number(j.pctComplete || 0);
        var contract = Number(j.contractAmount || 0);
        var prodDays = Number(j.totalProductionDays || 0);
        // Slim card — single line of meta (number · title) plus a
        // bottom row for $/days/pct. Title truncates with ellipsis
        // instead of clamping to two lines, which kept cards uniform
        // height and let more fit in the visible area.
        html += '<div class="sch-job-card" draggable="true" data-job-id="' + escapeAttr(j.id) + '" style="--job-color:' + color + ';" title="' + escapeAttr(jobLabel(j)) + '">' +
          '<div class="sch-job-card-line">' +
            '<span class="sch-job-card-num">' + escapeHTML(j.jobNumber || j.id) + '</span>' +
            '<span class="sch-job-card-title">' + escapeHTML(j.title || j.name || '(untitled)') + '</span>' +
          '</div>' +
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

    // Wire pill toggles for all three filter bars. The data-filter
    // attribute identifies the settings key (statusFilter /
    // jobTypeFilter / workTypeFilter); data-value is the option to
    // flip. Persists immediately so the user's working set sticks
    // across reloads.
    el.querySelectorAll('.sch-status-pill').forEach(function(p) {
      p.addEventListener('click', function() {
        var filterKey = p.getAttribute('data-filter');
        var v = p.getAttribute('data-value');
        if (!filterKey || !v) return;
        var cur = _state.settings[filterKey] || {};
        cur[v] = !cur[v];
        _state.settings[filterKey] = cur;
        saveSettings(_state.settings);
        renderSidebar();
      });
    });

    // Wire drag events on each card.
    el.querySelectorAll('.sch-job-card').forEach(function(card) {
      card.addEventListener('dragstart', function(e) {
        card.classList.add('dragging');
        var jobId = card.getAttribute('data-job-id');
        e.dataTransfer.setData('text/x-p86-jobid', jobId);
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
    var showW = !!_state.settings.showWeekends;

    el.innerHTML =
      // Toolbar layout: nav on the left, week summary inline in the
      // middle (Expected Revenue + Jobs — the Days tile got dropped
      // because "scheduled work-days summed across jobs" wasn't a
      // useful PM metric), then the weekend toggle + Schedule entry
      // button on the right. The summary used to live in a floating,
      // draggable widget but it overlapped day cells — inline beats
      // overlay here.
      '<div class="sch-cal-toolbar">' +
        '<div class="sch-cal-nav">' +
          '<button class="sch-btn sch-btn-icon" id="schPrev" title="Previous month">&lsaquo;</button>' +
          '<div class="sch-cal-month" id="schMonth">' + MONTH_NAMES[cur.getMonth()] + ' ' + cur.getFullYear() + '</div>' +
          '<button class="sch-btn sch-btn-icon" id="schNext" title="Next month">&rsaquo;</button>' +
          '<button class="sch-btn" id="schToday" style="margin-left:6px;">Today</button>' +
        '</div>' +
        '<div class="sch-week-summary" id="schWeekSummary">' +
          // Body painted by refreshWeekSummary (kept as a single source
          // of truth so subsequent updates don't have to know the markup).
          '<div class="sch-week-summary-loading">…</div>' +
        '</div>' +
        '<div class="sch-toolbar-spacer"></div>' +
        // Weekend toggle compacted to an icon button — the bulky
        // "Show Sat/Sun columns" label was eating header space.
        // Tooltip carries the explanation.
        '<button class="sch-btn sch-btn-toggle' + (showW ? ' active' : '') + '" id="schWeekendToggle" ' +
          'title="' + (showW ? 'Hide' : 'Show') + ' weekend columns. Display only — does not change how production days are counted on entries.">' +
          (showW ? '&#x1F441; 7-day' : '&#x1F441; 5-day') +
        '</button>' +
        '<button class="sch-btn sch-btn-primary" id="schAddEntry">+ Schedule entry</button>' +
      '</div>' +
      '<div class="sch-cal-grid" id="schGrid"></div>';
    refreshWeekSummary();

    document.getElementById('schPrev').addEventListener('click', function() { stepMonth(-1); });
    document.getElementById('schNext').addEventListener('click', function() { stepMonth(1); });
    document.getElementById('schToday').addEventListener('click', function() {
      _state.cursor = startOfMonth(new Date());
      _state.settings.viewMonth = toISODate(_state.cursor);
      saveSettings(_state.settings);
      renderCalendar();
    });
    document.getElementById('schWeekendToggle').addEventListener('click', function() {
      _state.settings.showWeekends = !_state.settings.showWeekends;
      saveSettings(_state.settings);
      renderCalendar();
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
    // Toggle the no-weekends class so the CSS grid collapses the
    // Sun/Sat columns to 0fr without re-rendering header labels.
    grid.classList.toggle('sch-no-weekends', !_state.settings.showWeekends);
    var first = _state.cursor;
    var firstDow = first.getDay(); // 0=Sun … 6=Sat
    // Sun-start grid: walk back firstDow days to reach the Sunday
    // before (or equal to) the 1st of the month.
    var leadingDays = firstDow;
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
    // Mark the row as focused when its weekStart matches the user's
    // selection — drives a colored selection ring + slight tint that
    // visually anchors the toolbar week-summary numbers to the
    // calendar week they represent.
    var weekStartIso = toISODate(weekStart);
    var isFocusedWeek = (_state.focusWeekStart === weekStartIso);
    var html = '<div class="sch-cal-week-row' + (isFocusedWeek ? ' sch-week-focused' : '') +
               '" data-week-start="' + weekStartIso + '">';

    // Focus rail — slim vertical handle at the LEFT edge of the row.
    // Click pins this week as the metrics target. Visible always so
    // the user can discover it; brightens on hover and on selection.
    // Uses a button so it's keyboard-focusable.
    html += '<button type="button" class="sch-week-focus-rail" data-week-start="' + weekStartIso + '" ' +
            'title="Show week summary for ' + escapeAttr(weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })) + '+">' +
            '<span class="sch-week-focus-rail-glow"></span>' +
            '</button>';

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
      // Use variable col widths so weekend bookends (0.5fr each) are
      // sized correctly relative to weekdays (1fr each). When weekends
      // are hidden the weights collapse to 0 and bars over Sat/Sun
      // contribute nothing to width.
      var leftPct = colLeftPct(seg.startCol);
      var widthPct = colWidthPct(seg.startCol, seg.span);
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
      // Weather glyph — inline emoji shown right before the job
      // number on the bar. Sun for green, cloud for yellow, warning
      // sign for red. Tooltip carries the full forecast summary so
      // hovering reveals temp + precip without opening the day
      // sheet. Painted only on the segment's first day; multi-day
      // entries get the icon for the day each segment starts on,
      // since weather can vary across days.
      var firstDayKey = weekKeys[seg.startCol];
      var dayWx = weatherForJobOnDate(e.jobId, firstDayKey);
      var wxHtml = '';
      if (dayWx) {
        var wxTitle = (dayWx.summary || '') +
          (dayWx.tempHigh != null ? ' · ' + dayWx.tempHigh + '°' : '') +
          (dayWx.precipPct ? ' · ' + dayWx.precipPct + '% rain' : '') +
          (dayWx.windMph ? ' · ' + dayWx.windMph + ' mph wind' : '');
        wxHtml = '<span class="sch-entry-bar-wx-icon sch-wx-' + dayWx.risk + '" ' +
                 'title="' + escapeAttr(wxTitle) + '">' +
          weatherIconForRisk(dayWx.risk) +
        '</span>';
      }
      html += '<div class="sch-entry-bar' + statusCls + '" ' +
        'data-entry-id="' + escapeAttr(e.id) + '" ' +
        'style="left:' + leftPct.toFixed(4) + '%;width:calc(' + widthPct.toFixed(4) + '% - 4px);top:' + topPx + 'px;background:' + color + ';" ' +
        'title="' + escapeAttr(jobLabel(job)) + (e.notes ? ' — ' + escapeAttr(e.notes) : '') + '">' +
        wxHtml +
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
        var jobId = e.dataTransfer.getData('text/x-p86-jobid') ||
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
        if (e.target.closest('.sch-week-focus-rail')) return;
        var date = cell.getAttribute('data-date');
        // New behavior: clicking an empty day opens a "day at a
        // glance" sheet listing every entry on that date with quick
        // edit/add actions. Direct click-to-create-blank was easy
        // to trigger by accident and skipped any context — the
        // sheet gives users a moment to see what's already on the
        // day before deciding to add or edit.
        openDaySheet(date);
      });
    });
    // Week focus rails — click pins that week as the metrics target.
    // Side effect: also flip the floater into "pinned" mode so the
    // numbers actually stick. Clicking the already-focused rail
    // unpins (back to current-week tracking).
    grid.querySelectorAll('.sch-week-focus-rail').forEach(function(rail) {
      rail.addEventListener('click', function(e) {
        e.stopPropagation();
        var weekStart = rail.getAttribute('data-week-start');
        if (!weekStart) return;
        if (_state.focusWeekStart === weekStart && _state.settings.weekSummaryPinned) {
          _state.focusWeekStart = null;
          _state.settings.weekSummaryPinned = false;
        } else {
          _state.focusWeekStart = weekStart;
          _state.settings.weekSummaryPinned = true;
        }
        saveSettings(_state.settings);
        renderGrid();
        refreshWeekSummary();
      });
    });
    wireResizeHandles(grid);
  }

  // ── Day sheet — "what's happening this day?" ────────────────
  // Replaces the old click-to-create-blank-entry flow. Lists every
  // entry that touches this date (including multi-day entries that
  // started earlier or extend past) with quick links to edit each
  // and a primary action to add a fresh entry on this date.
  function openDaySheet(dateISO) {
    var prior = document.getElementById('schDaySheet');
    if (prior) prior.remove();

    var d = parseISODate(dateISO);
    if (!d) return;
    var headerLabel = d.toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    });

    var entries = entriesOnDay(d).slice();
    // Sort: earlier-starting entries first; ties broken by job number
    // so the same-day order stays stable across renders.
    entries.sort(function(a, b) {
      var ca = (a.startDate || '').localeCompare(b.startDate || '');
      if (ca !== 0) return ca;
      var ja = jobById(a.jobId);
      var jb = jobById(b.jobId);
      return ((ja && ja.jobNumber) || '').localeCompare((jb && jb.jobNumber) || '');
    });

    // Aggregate metrics for this day so the sheet header has the
    // same "at a glance" feel as the week-summary widget.
    var scheduledDaysIndex = buildScheduledDaysIndex();
    var totalRev = 0;
    var crewIds = {};
    entries.forEach(function(e) {
      var job = jobById(e.jobId);
      var rate = jobDailyRate(job, scheduledDaysIndex);
      totalRev += rate; // 1 day on this date for each entry that touches it
      (e.crew || []).forEach(function(id) { crewIds[id] = true; });
    });
    var crewCount = Object.keys(crewIds).length;

    var rowsHtml;
    if (!entries.length) {
      rowsHtml = '<div class="sch-day-sheet-empty">No production scheduled for this day yet.</div>';
    } else {
      rowsHtml = entries.map(function(e) {
        var job = jobById(e.jobId);
        var color = colorForJob(e.jobId);
        var label = jobLabel(job);
        var crewSize = (e.crew || []).length;
        var statusCls = e.status ? ' sch-day-row-status-' + e.status : '';
        // Show this day's position within the entry's span (e.g.
        // "Day 2 of 4") so PMs can see whether the crew is just
        // starting, mid-stretch, or wrapping up.
        var span = entrySpanDays(e);
        var dayIndex = span.indexOf(dateISO) + 1;
        var positionLabel = dayIndex > 0 ? 'Day ' + dayIndex + ' of ' + span.length : '';
        var notes = e.notes ? '<div class="sch-day-row-notes">' + escapeHTML(e.notes) + '</div>' : '';
        // Weather panel — full forecast detail for this job/date,
        // pulled from the same cache as the bar chips. Falls back
        // to a "no address" / "loading" hint when applicable so the
        // user understands why a row is missing weather.
        var jobWx = _state.weather && _state.weather[e.jobId];
        var wxHtml = renderDayRowWeather(jobWx, dateISO);
        return '<div class="sch-day-row' + statusCls + '" data-entry-id="' + escapeAttr(e.id) + '" ' +
                'style="--job-color:' + color + ';">' +
          '<div class="sch-day-row-color"></div>' +
          '<div class="sch-day-row-main">' +
            '<div class="sch-day-row-title">' + escapeHTML(label) + '</div>' +
            '<div class="sch-day-row-meta">' +
              (positionLabel ? '<span>' + escapeHTML(positionLabel) + '</span>' : '') +
              (crewSize ? '<span>' + crewSize + ' on crew</span>' : '<span>No crew assigned</span>') +
              (e.status ? '<span class="sch-day-row-status">' + escapeHTML(e.status) + '</span>' : '') +
            '</div>' +
            wxHtml +
            notes +
          '</div>' +
          '<div class="sch-day-row-actions">' +
            '<button type="button" class="sch-btn sch-day-edit" data-entry-id="' + escapeAttr(e.id) + '">Edit</button>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    var modal = document.createElement('div');
    modal.id = 'schDaySheet';
    modal.className = 'modal active';
    modal.innerHTML =
      '<div class="modal-content sch-day-sheet">' +
        '<div class="sch-day-sheet-header">' +
          '<div>' +
            '<div class="sch-day-sheet-eyebrow">Day at a glance</div>' +
            '<div class="sch-day-sheet-title">' + escapeHTML(headerLabel) + '</div>' +
          '</div>' +
          '<button class="sch-btn sch-day-sheet-close" id="schDaySheetClose" title="Close">&#x2715;</button>' +
        '</div>' +
        '<div class="sch-day-sheet-stats">' +
          '<div class="sch-day-stat">' +
            '<div class="sch-day-stat-label">Entries</div>' +
            '<div class="sch-day-stat-val">' + entries.length + '</div>' +
          '</div>' +
          '<div class="sch-day-stat">' +
            '<div class="sch-day-stat-label">Crew on site</div>' +
            '<div class="sch-day-stat-val">' + crewCount + '</div>' +
          '</div>' +
          '<div class="sch-day-stat">' +
            '<div class="sch-day-stat-label">Expected rev.</div>' +
            '<div class="sch-day-stat-val sch-metric-val-rev">' + fmtMoney(totalRev) + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="sch-day-sheet-rows">' + rowsHtml + '</div>' +
        '<div class="sch-day-sheet-footer">' +
          '<button class="sch-btn" id="schDaySheetCancel">Close</button>' +
          '<button class="sch-btn sch-btn-primary" id="schDaySheetAdd">+ Add entry on this day</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);

    function close() { modal.remove(); }
    modal.querySelector('#schDaySheetClose').addEventListener('click', close);
    modal.querySelector('#schDaySheetCancel').addEventListener('click', close);
    modal.addEventListener('click', function(e) { if (e.target === modal) close(); });

    modal.querySelector('#schDaySheetAdd').addEventListener('click', function() {
      close();
      openEntryEditor(null, dateISO);
    });
    modal.querySelectorAll('.sch-day-edit').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var id = btn.getAttribute('data-entry-id');
        var entry = _state.entries.find(function(x) { return x.id === id; });
        close();
        if (entry) openEntryEditor(entry, entry.startDate, entry.jobId);
      });
    });
    // Click anywhere on a row (not the Edit button) to also edit —
    // Buildertrend-style affordance, mirrors how rows behave in
    // most "list of records" surfaces in the rest of the app.
    modal.querySelectorAll('.sch-day-row').forEach(function(row) {
      row.addEventListener('click', function(e) {
        if (e.target.closest('.sch-day-edit')) return;
        var id = row.getAttribute('data-entry-id');
        var entry = _state.entries.find(function(x) { return x.id === id; });
        close();
        if (entry) openEntryEditor(entry, entry.startDate, entry.jobId);
      });
    });
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
      // Re-derive the actual Sunday of this week: take the first
      // day-cell's date, subtract its dow-offset to Sunday.
      if (dayCells.length) {
        var firstDate = parseISODate(dayCells[0].getAttribute('data-date'));
        if (firstDate) {
          var firstDow = firstDate.getDay();
          anchorDate = addDays(firstDate, -firstDow);
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
      window.p86Api.schedule.update(entry.id, payload).then(function(res) {
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
      // and ints (from p86Api.users.list), indexOf strict-equality
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
              '<label class="p86-check-row">' +
                '<input type="checkbox" id="schEditWeekends" ' + (includesWeekends ? 'checked' : '') + ' />' +
                '<span>Count weekends as production days <span class="p86-check-hint">— affects how the production-days count expands across the calendar.</span></span>' +
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
            // Notify checkbox. Default ON for new entries (the crew is
            // brand-new and should be told they're working that day).
            // Default OFF for edits (most edits are tweaks like notes
            // or status — re-emailing every existing crew member would
            // create spam). The user can override either way per save.
            // Server only emails users whose ids are NEW in the crew
            // array (PATCH compares pre/post crew), so flipping this
            // ON during a routine edit only notifies *added* members.
            '<div title="Email crew about this assignment. Default ON for new entries, OFF for edits — server only emails newly-added crew members regardless.">' +
              '<label class="p86-check-row">' +
                '<input type="checkbox" id="schEditNotify" ' + (!isEdit ? 'checked' : '') + ' />' +
                '<span>&#x1F4E7; Notify ' + (isEdit ? 'newly-added' : 'assigned') + ' crew via email <span class="p86-check-hint">— only sent to newly-added members.</span></span>' +
              '</label>' +
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
          var goDelete = (typeof window.p86Confirm === 'function')
            ? window.p86Confirm({
                title: 'Delete schedule entry',
                message: 'Delete this schedule entry? This cannot be undone.',
                confirmLabel: 'Delete',
                danger: true
              })
            : Promise.resolve(window.confirm('Delete this schedule entry?'));
          goDelete.then(function(ok) {
            if (!ok) return;
            setBusy(true);
            var p = isApiReady() && entry.id && entry.id.indexOf('sch_local_') !== 0
              ? window.p86Api.schedule.remove(entry.id)
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
              if (typeof window.p86Alert === 'function') {
                window.p86Alert({ title: 'Delete failed', message: err.message || String(err) });
              } else {
                alert('Delete failed: ' + (err.message || err));
              }
            });
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
        var notifyEl = modal.querySelector('#schEditNotify');
        var notify = !!(notifyEl && notifyEl.checked);
        var payload = {
          jobId: jobId,
          startDate: sd,
          days: d,
          crew: crew.slice(),
          notes: nt,
          status: st,
          includesWeekends: ww,
          notify: notify
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
            ? window.p86Api.schedule.update(entry.id, payload)
            : window.p86Api.schedule.create(payload);
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
              var goRefresh = (typeof window.p86Confirm === 'function')
                ? window.p86Confirm({
                    title: 'Entry changed elsewhere',
                    message: 'This entry was just updated by someone else.\n\nReload the latest version? Your unsaved changes will be lost.',
                    confirmLabel: 'Reload',
                    cancelLabel: 'Keep editing'
                  })
                : Promise.resolve(window.confirm('Reload the latest version? (Your unsaved changes will be lost.)'));
              goRefresh.then(function(ok) {
                if (!ok) return;
                fetchEntries().then(function() {
                  close();
                  renderGrid();
                  refreshWeekSummary();
                });
              });
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

  // ── Floating week-summary widget ───────────────────────────
  // Production metrics used to live inline in the calendar toolbar,
  // wedged between nav and the +Schedule button — close enough to
  // those buttons to make misclicks easy. The widget now floats
  // inside the calendar wrap so the user can drag it anywhere.
  // It also has its own pin button: pinned = stays on a chosen
  // week (driven by _state.focusWeekStart); unpinned = always
  // shows the current real-life week regardless of visible month.
  // Paints the week summary into the inline toolbar slot rendered by
  // renderCalendar (#schWeekSummary). Two visible tiles — Expected
  // Revenue + Jobs — preceded by a label and a pin button. The Days
  // tile (sum of scheduled work-days across jobs in the week) was
  // dropped because it wasn't a useful PM metric.
  //
  // Pin behavior: clicking the pin toggles _state.settings.
  // weekSummaryPinned. Pinned = stay on whatever week is selected
  // (focusWeekStart, set by clicking a week's left-edge focus rail).
  // Unpinned = always show the current real-life week regardless of
  // which month the calendar is viewing.
  function refreshWeekSummary() {
    var bar = document.getElementById('schWeekSummary');
    if (!bar) return;

    var pinned = !!_state.settings.weekSummaryPinned;
    var ref = weekSummaryReferenceDate();
    var summary = weekSummaryForCursor(ref);
    var ws = parseISODate(summary.weekStart);
    var we = parseISODate(summary.weekEnd);
    var label = (ws && we)
      ? MONTH_NAMES[ws.getMonth()].slice(0, 3) + ' ' + ws.getDate() +
        '–' + (we.getMonth() === ws.getMonth()
          ? we.getDate()
          : MONTH_NAMES[we.getMonth()].slice(0, 3) + ' ' + we.getDate())
      : 'This week';

    bar.classList.toggle('sch-week-summary-pinned', pinned);
    var pinTitle = pinned
      ? 'Pinned to ' + label + '. Click to unpin (will follow the current week).'
      : 'Pin to this week. While unpinned, the summary always shows the current real-life week.';
    var labelPrefix = pinned ? 'Pinned' : 'This week';

    bar.innerHTML =
      '<button type="button" class="sch-week-summary-pin' + (pinned ? ' active' : '') +
        '" id="schWeekSummaryPin" title="' + escapeAttr(pinTitle) + '">&#x1F4CC;</button>' +
      '<div class="sch-week-summary-label">' +
        '<span class="sch-week-summary-prefix">' + labelPrefix + '</span>' +
        '<span class="sch-week-summary-range">' + escapeHTML(label) + '</span>' +
      '</div>' +
      '<div class="sch-metric" title="Each job\'s remaining backlog (Total Income − Revenue Earned) ' +
        'split evenly across every day it sits on the schedule. A $100k-backlog job scheduled for ' +
        '5 days = $20k/day. Sums those daily values for the days inside this week.">' +
        '<div class="sch-metric-label">Expected revenue</div>' +
        '<div class="sch-metric-val sch-metric-val-rev">' + fmtMoney(summary.expectedRevenue) + '</div>' +
      '</div>' +
      '<div class="sch-metric">' +
        '<div class="sch-metric-label">Jobs</div>' +
        '<div class="sch-metric-val">' + summary.jobsCount + '</div>' +
      '</div>';

    var pinBtn = bar.querySelector('#schWeekSummaryPin');
    if (pinBtn) {
      pinBtn.addEventListener('click', function() {
        var nowPinned = !_state.settings.weekSummaryPinned;
        _state.settings.weekSummaryPinned = nowPinned;
        // Turning pin ON without a selected week → snap to the
        // current real-life week so the pin has something to lock to.
        if (nowPinned && !_state.focusWeekStart) {
          _state.focusWeekStart = toISODate(startOfWeek(new Date()));
        }
        saveSettings(_state.settings);
        renderGrid();
        refreshWeekSummary();
      });
    }
  }

  // Pick the date the week summary reports on.
  //   - Pinned mode: use the user's chosen week (focusWeekStart).
  //     Falls back to today if focus is somehow blank.
  //   - Unpinned mode: ALWAYS today's real-life week, regardless
  //     of which month is being viewed. This is what users want
  //     when scrolling through future months — the numbers stay
  //     anchored to "now" instead of jumping to the first of
  //     whatever month is on screen.
  function weekSummaryReferenceDate() {
    if (_state.settings.weekSummaryPinned && _state.focusWeekStart) {
      var picked = parseISODate(_state.focusWeekStart);
      if (picked) return picked;
    }
    return new Date();
  }

  // ── Job-detail weather widget ──────────────────────────────
  // Renders a 7-day forecast row into `mount` for a single job.
  // Used by the WIP job-overview tab so PMs can see the week
  // ahead at the job's address without bouncing to the schedule.
  // Self-contained: handles its own fetch, doesn't read or mutate
  // the schedule's _state.weather. (Schedule's cache is keyed by
  // visible-grid jobs, which may not include this one.)
  function renderJobWeatherWidget(mount, jobId, opts) {
    if (!mount || !jobId) return;
    opts = opts || {};
    var title = opts.title || 'Weather at this job';
    mount.innerHTML =
      '<div class="sch-job-wx-widget">' +
        '<div class="sch-job-wx-header">' +
          '<span class="sch-job-wx-title">' + escapeHTML(title) + '</span>' +
          '<span class="sch-job-wx-source">7-day · NWS</span>' +
        '</div>' +
        '<div class="sch-job-wx-body" id="schJobWxBody-' + escapeAttr(jobId) + '">' +
          '<div class="sch-job-wx-loading">Loading forecast…</div>' +
        '</div>' +
      '</div>';
    var body = mount.querySelector('#schJobWxBody-' + (CSS && CSS.escape ? CSS.escape(jobId) : jobId));
    if (!body) body = mount.querySelector('.sch-job-wx-body'); // fallback for ids w/ unsafe chars

    if (!window.p86Api || !window.p86Api.weather || !window.p86Api.isAuthenticated || !window.p86Api.isAuthenticated()) {
      body.innerHTML = '<div class="sch-job-wx-empty">Sign in to see weather.</div>';
      return;
    }
    window.p86Api.weather.jobs([jobId]).then(function(res) {
      var w = res && res.weather && res.weather[jobId];
      paintJobWeatherBody(body, w);
    }).catch(function(err) {
      body.innerHTML = '<div class="sch-job-wx-empty">Weather unavailable: ' +
        escapeHTML((err && err.message) || 'unknown') + '</div>';
    });
  }

  function paintJobWeatherBody(body, w) {
    if (!body) return;
    if (!w) {
      body.innerHTML = '<div class="sch-job-wx-empty">No forecast data.</div>';
      return;
    }
    if (w.status === 'no_address') {
      body.innerHTML = '<div class="sch-job-wx-empty">' +
        'Add a job address (or a building address) to see weather here.' +
      '</div>';
      return;
    }
    if (w.status === 'failed') {
      body.innerHTML = '<div class="sch-job-wx-empty">' +
        'Could not match this address: ' + escapeHTML(w.address || '') +
      '</div>';
      return;
    }
    if (w.status === 'error') {
      body.innerHTML = '<div class="sch-job-wx-empty">' +
        'Weather service unavailable.' +
      '</div>';
      return;
    }
    if (w.status !== 'ok' || !Array.isArray(w.days) || !w.days.length) {
      body.innerHTML = '<div class="sch-job-wx-empty">No forecast data.</div>';
      return;
    }
    // Day cards — rendered as a horizontal strip. Each card carries
    // a risk-colored top border so red days pop visually. Hover for
    // the full NWS summary text.
    var cards = w.days.map(function(d) {
      var iconClass = 'sch-job-wx-icon sch-wx-' + d.risk;
      var icon = weatherIconForRisk(d.risk);
      var dateLabel = (function() {
        var dd = parseISODate(d.date);
        if (!dd) return d.date;
        return DOW_LABELS[dd.getDay()] + ' ' + (dd.getMonth() + 1) + '/' + dd.getDate();
      })();
      var temp = (d.tempHigh != null) ? d.tempHigh + '°' : '—';
      var lo = (d.tempLow != null) ? d.tempLow + '°' : '';
      var precip = d.precipPct ? d.precipPct + '% rain' : '';
      var wind = d.windMph ? d.windMph + ' mph' : '';
      var meta = [precip, wind].filter(Boolean).join(' · ');
      return '<div class="sch-job-wx-card sch-wx-' + d.risk + '" title="' +
              escapeAttr((d.summary || '') +
                         (d.tempHigh != null ? ' · ' + d.tempHigh + '°' : '') +
                         (d.tempLow != null ? ' / ' + d.tempLow + '°' : '')) + '">' +
        '<div class="sch-job-wx-card-date">' + escapeHTML(dateLabel) + '</div>' +
        '<div class="' + iconClass + '">' + icon + '</div>' +
        '<div class="sch-job-wx-card-temp">' +
          '<span class="sch-job-wx-card-hi">' + escapeHTML(temp) + '</span>' +
          (lo ? ' <span class="sch-job-wx-card-lo">' + escapeHTML(lo) + '</span>' : '') +
        '</div>' +
        '<div class="sch-job-wx-card-summary">' + escapeHTML(d.summary || '') + '</div>' +
        (meta ? '<div class="sch-job-wx-card-meta">' + escapeHTML(meta) + '</div>' : '') +
      '</div>';
    }).join('');
    var addrNote = w.address
      ? '<div class="sch-job-wx-addr">📍 ' + escapeHTML(w.address) + '</div>'
      : '';
    body.innerHTML = '<div class="sch-job-wx-strip">' + cards + '</div>' + addrNote;
  }

  // ── Public API ─────────────────────────────────────────────
  window.renderSchedule = renderSchedule;
  window.scheduleAddEntry = function(jobId, dateISO) {
    openEntryEditor(null, dateISO, jobId);
  };
  // Surface the job-detail widget so wip.js (and any other module
  // that wants a per-job forecast) can drop it into a container.
  window.p86Weather = {
    renderJobWidget: renderJobWeatherWidget
  };
})();
