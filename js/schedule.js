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
      // Default Job Type filter: all on. PMs typically narrow this
      // manually (e.g., a renovations PM toggles off Service tickets).
      jobTypeFilter: {
        'Service': true, 'Renovation': true, 'Work Order': true
      },
      // Inline week-summary pin state. Pinned=false means the
      // summary tracks the current real-life week, no matter which
      // month is being viewed. Pinned=true locks it to whichever
      // week the user last selected via the calendar's left-edge
      // focus rail or the inline pin button. focusWeekStart is the
      // Sunday-ISO of the locked week — kept in settings (not
      // _state) so saveSettings persists it; otherwise reload
      // would show "Pinned" in the toolbar but with no week-row
      // glow because the focus key was lost.
      weekSummaryPinned: false,
      focusWeekStart: null,
      // Slice C — overlay layer visibility. Both on by default; the
      // toolbar pills flip these. Merge-healed below so a legacy save
      // (no layers key) picks up the defaults without clobbering an
      // explicit user choice.
      layers: { jobs: true, events: true },
      // Exclusive view switch (replaces the additive layer pills):
      //   'production' — job bars on the grid + the draggable jobs list.
      //   'calendar'   — events + tasks + to-dos + reminders on the grid
      //                  + a day-summary sidebar for the selected day.
      // Legacy saves (no key) default to production. Healed below.
      view: 'production'
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
      // Slice C — heal the layers object. A legacy save predates it
      // entirely (object missing → seed both-on); a partial save may
      // carry only one key → backfill the other with its default so
      // an undefined never reads as "off". Explicit false is honored.
      if (!merged.layers || typeof merged.layers !== 'object') {
        merged.layers = Object.assign({}, defaults.layers);
      } else {
        if (typeof merged.layers.jobs !== 'boolean') merged.layers.jobs = defaults.layers.jobs;
        if (typeof merged.layers.events !== 'boolean') merged.layers.events = defaults.layers.events;
      }
      // Heal the exclusive view — anything not a known mode → default.
      if (merged.view !== 'production' && merged.view !== 'calendar') {
        merged.view = defaults.view;
      }
      // Heal the legacy state where weekSummaryPinned was persisted
      // but focusWeekStart was a top-level _state key that never
      // round-tripped. Without this, reload shows "Pinned" in the
      // toolbar but no green glow on the calendar week. Snap to
      // the current real-life week so the affordances line up.
      // toISODate + startOfWeek are function declarations later in
      // this file; JS hoisting makes them safe to call here.
      // Persist the heal too (write back to localStorage) so
      // subsequent loads don't keep snapping the focus to wherever
      // today falls — once healed, the value sticks across reloads
      // until the user explicitly picks a different week or unpins.
      if (merged.weekSummaryPinned && !merged.focusWeekStart) {
        merged.focusWeekStart = toISODate(startOfWeek(new Date()));
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged)); }
        catch (e) { /* defensive — quota/private mode etc. */ }
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
  // SERVER IS THE SOURCE OF TRUTH for everything else. A cached entry
  // with a server-style id that is NOT in the server's response means
  // it was DELETED on the server — we drop it from the cache; we do
  // NOT re-create it. (Previously a one-time "Phase-1 migration"
  // re-POSTed such entries, which could not distinguish "never synced"
  // from "deleted" — so a delete on one device was silently undone by
  // any other device/tab that still held the entry in its localStorage
  // cache. That cross-device resurrection bug is the reason this was
  // removed; Phase-1 migration is long complete.)
  function fetchEntries() {
    if (!isApiReady()) {
      _state.entries = loadCachedEntries();
      return Promise.resolve(_state.entries);
    }
    return window.p86Api.schedule.list().then(function(res) {
      var serverList = (res && res.entries) || [];
      var cached = loadCachedEntries();
      // Keep only genuine offline-created entries from the cache; the
      // server list is authoritative for everything else, so anything
      // cached-but-missing-from-server (i.e. deleted) is pruned by the
      // cacheEntries(merged) rewrite below — never re-uploaded.
      var localOnly = cached.filter(function(e) {
        return e && typeof e.id === 'string' && e.id.indexOf('sch_local_') === 0;
      });
      var merged = serverList.concat(localOnly);
      _state.entries = merged;
      cacheEntries(merged);
      return merged;
    }).catch(function(err) {
      console.warn('[schedule] fetch failed, using cache:', err && err.message);
      _state.entries = loadCachedEntries();
      return _state.entries;
    });
  }

  // ── Slice C: personal calendar events ──────────────────────
  // Pulls the user's personal calendar events (window.p86Api.calendar)
  // so they can be overlaid as a second layer on the production grid.
  // No range filter — we window client-side per week-row, same as job
  // entries. Degrades silently to [] when the api is unavailable or
  // the user isn't authenticated, so a logged-out / offline view just
  // shows no event layer instead of erroring. Returns a Promise so the
  // caller can chain a render.
  function isCalendarApiReady() {
    return !!(window.p86Api &&
              window.p86Api.calendar &&
              window.p86Api.isAuthenticated &&
              window.p86Api.isAuthenticated());
  }
  function fetchEvents() {
    if (!isCalendarApiReady()) {
      _state.events = [];
      return Promise.resolve(_state.events);
    }
    return window.p86Api.calendar.list().then(function(res) {
      _state.events = (res && res.events) || [];
      return _state.events;
    }).catch(function(err) {
      console.warn('[schedule] event fetch failed:', err && err.message);
      _state.events = [];
      return _state.events;
    });
  }

  // ── Calendar-view data: tasks / to-dos + reminders ─────────
  // Both are owner+org scoped server-side. Fetched alongside events so
  // the calendar view + day-summary sidebar have everything. Degrade
  // silently to [] when the api is missing or the user is logged out.
  function fetchTasks() {
    if (!isCalendarApiReady() || !window.p86Api.tasks) {
      _state.tasks = [];
      return Promise.resolve(_state.tasks);
    }
    // exclude_done — keep the calendar to the live, actionable set.
    return window.p86Api.tasks.list({ exclude_done: 1 }).then(function(res) {
      _state.tasks = (res && (res.tasks || res.items)) || [];
      return _state.tasks;
    }).catch(function(err) {
      console.warn('[schedule] task fetch failed:', err && err.message);
      _state.tasks = [];
      return _state.tasks;
    });
  }
  function fetchReminders() {
    if (!isCalendarApiReady() || !window.p86Api.reminders) {
      _state.reminders = [];
      return Promise.resolve(_state.reminders);
    }
    // Default list = pending only (done/dismissed drop off the grid).
    return window.p86Api.reminders.list().then(function(res) {
      _state.reminders = (res && (res.reminders || res.items)) || [];
      return _state.reminders;
    }).catch(function(err) {
      console.warn('[schedule] reminder fetch failed:', err && err.message);
      _state.reminders = [];
      return _state.reminders;
    });
  }

  // ── View + calendar-item helpers ───────────────────────────
  // The Schedule has two exclusive views. 'production' paints job bars
  // and shows the draggable jobs list in the sidebar; 'calendar' paints
  // the user's events/tasks/reminders and shows a day-summary sidebar.
  function currentView() {
    return (_state.settings && _state.settings.view === 'calendar') ? 'calendar' : 'production';
  }
  // Tasks carry a date-only due_date; reminders a full remind_at instant.
  // Both normalize to a local YYYY-MM-DD so they clip onto day columns
  // the same way job entries + events do.
  function taskDueISO(t) {
    if (!t || !t.due_date) return null;
    var d = parseISODate(t.due_date);
    return d ? toISODate(d) : null;
  }
  function reminderISO(r) {
    if (!r || !r.remind_at) return null;
    var d = new Date(r.remind_at);
    return isNaN(d.getTime()) ? null : toISODate(d);
  }
  function reminderTimeLabel(r) {
    return (r && r.remind_at) ? fmtEventTime(r.remind_at) : '';
  }
  function isTaskDone(t) { return !!t && t.status === 'done'; }
  // Calendar-item palette. Tasks (assignable) amber, personal to-dos
  // teal, reminders violet — distinct from job/event colors.
  var TASK_COLOR = '#f59e0b';
  var TODO_COLOR = '#14b8a6';
  var REMINDER_COLOR = '#a78bfa';
  function taskColor(t) {
    if (isTaskDone(t)) return '#64748b';
    return (t && t.scope === 'personal') ? TODO_COLOR : TASK_COLOR;
  }
  // Normalized calendar items (events + tasks/to-dos + reminders) on a
  // given local ISO day. Used for the per-day cards/dots on the grid AND
  // the day-summary sidebar so everything stays consistent.
  function dayCalItems(iso) {
    var out = [];
    (_state.events || []).forEach(function(ev) {
      if (!ev || !ev.starts_at) return;
      var sd = parseISODate(ev.starts_at); if (!sd) return;
      var ed = parseISODate(ev.ends_at) || sd; if (ed < sd) ed = sd;
      if (iso >= toISODate(sd) && iso <= toISODate(ed)) {
        var tp = (!ev.all_day && fmtEventTime(ev.starts_at)) ? fmtEventTime(ev.starts_at) + ' ' : '';
        out.push({ kind: 'event', id: ev.id, color: (ev.color || EVENT_DEFAULT_COLOR), label: tp + (ev.title || '(event)') });
      }
    });
    (_state.tasks || []).forEach(function(t) {
      if (taskDueISO(t) !== iso) return;
      out.push({ kind: 'task', id: t.id, color: taskColor(t), done: isTaskDone(t), label: (isTaskDone(t) ? '✓ ' : '') + (t.title || 'Task') });
    });
    (_state.reminders || []).forEach(function(r) {
      if (reminderISO(r) !== iso) return;
      var tl = reminderTimeLabel(r);
      out.push({ kind: 'reminder', id: r.id, color: REMINDER_COLOR, label: '⏰ ' + (tl ? tl + ' ' : '') + (r.title || 'Reminder') });
    });
    return out;
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

  // ── Mobile detection + breakpoint-flip re-render ───────────
  // The calendar swaps to a fixed Outlook-style month grid (plain
  // 7-equal-col day cells with compact chips) at phone widths. The
  // desktop spanning-bar / fisheye path is untouched above the
  // breakpoint. 640px matches the existing @media (max-width:640px)
  // CSS section so the JS branch and the CSS section flip together.
  function isMobileCal() { return (window.innerWidth || 0) <= 640; }
  // Track the mode used at the last render so the resize handler only
  // re-renders when the breakpoint actually flips (not on every tick).
  var _lastCalMobileMode = null;
  // Guard so the resize listener is only attached once per page life.
  var _resizeListenerAttached = false;
  function attachCalResizeListener() {
    if (_resizeListenerAttached) return;
    _resizeListenerAttached = true;
    var t = 0;
    window.addEventListener('resize', function() {
      if (t) clearTimeout(t);
      t = setTimeout(function() {
        t = 0;
        // Only act when the schedule page is mounted.
        if (!document.getElementById('schStack')) return;
        var now = isMobileCal();
        if (now === _lastCalMobileMode) return; // breakpoint didn't flip
        renderGrid();
      }, 200);
    });
  }

  // ── Slice C: event time formatting ─────────────────────────
  // Compact local 12-hour clock for an ISO datetime — no leading zero
  // on the hour, lowercased am/pm, e.g. "9:30 am". Used to prefix
  // timed event labels on the grid. Returns '' for an unparseable
  // input so the label just falls back to the bare title.
  function fmtEventTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var h = d.getHours();
    var m = d.getMinutes();
    var ampm = h < 12 ? 'am' : 'pm';
    var h12 = h % 12;
    if (h12 === 0) h12 = 12;
    return h12 + ':' + (m < 10 ? '0' + m : m) + ' ' + ampm;
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
  // Two independent multi-select filter bars on the sidebar:
  //   - Status: lifecycle gate. Default = active set (the jobs a PM
  //     is actively scheduling production for).
  //   - Job Type: Service vs full Renovation vs Work Order — these
  //     run very differently and a PM scheduling renovations doesn't
  //     want service tickets in their list.
  // Default for each bar is "all on" (everything passes).
  // Empty selection (user toggles every pill off) surfaces every
  // job — there's no useful "match nothing" state, so we treat
  // empty as wildcard. Same convention for both bars.
  var STATUS_FILTERS = ['New', 'In Progress', 'Backlog', 'On Hold', 'Completed', 'Archived'];
  var DEFAULT_STATUS_SET = { 'New': true, 'In Progress': true, 'Backlog': true };

  var JOB_TYPE_FILTERS = ['Service', 'Renovation', 'Work Order'];
  var DEFAULT_JOB_TYPE_SET = { 'Service': true, 'Renovation': true, 'Work Order': true };

  var _state = {
    cursor: null,        // first day of the month being viewed
    entries: [],
    // Slice C — personal calendar events overlaid as a second layer
    // on the production grid. Hydrated by fetchEvents() from
    // window.p86Api.calendar; stays [] when the api is unavailable.
    events: [],
    // Calendar-view layers: the user's tasks + to-dos (window.p86Api.tasks)
    // and personal reminders (window.p86Api.reminders), hydrated alongside
    // events. Stay [] in production view / when the api is unavailable.
    tasks: [],
    reminders: [],
    // Selected day for the calendar-view day-summary sidebar (ISO date).
    // Defaults to today on first calendar render.
    selectedDay: null,
    settings: {
      showWeekends: true,
      viewMonth: null,
      // Persisted across sessions. Object keyed by string label,
      // value true/false. Missing key = false (filtered out).
      statusFilter: Object.assign({}, DEFAULT_STATUS_SET),
      jobTypeFilter: Object.assign({}, DEFAULT_JOB_TYPE_SET),
      // Slice C — which overlay layers paint on the grid. Both on
      // by default. Toggled via the toolbar pills.
      layers: { jobs: true, events: true },
      // Exclusive view: 'production' or 'calendar'. See currentView().
      view: 'production'
    },
    users: [],           // hydrated from /api/auth/users
    sidebarSearch: '',
    // (focusWeekStart now lives in _state.settings so saveSettings
    // persists it across reloads — see the loadSettings defaults.)
    // Weather forecast cache: { [jobId]: { status, days, address } }.
    // Populated by /api/weather/jobs in the background after the grid
    // paints. The grid re-renders once weather lands so chips show up
    // without a flash of empty bars on first paint.
    weather: {},
    weatherLoading: false,
    weatherFetchedAt: 0,
    // User-location forecast for the day-cell chips. Pulls coords
    // from the same localStorage cache the header weather chip uses
    // ('p86-user-coords') and asks /api/weather/coords for a 7-day
    // forecast. Keyed by YYYY-MM-DD via userWeatherByDate so
    // renderWeekRow can do a constant-time lookup per cell.
    userWeather: null,
    userWeatherByDate: null,
    userWeatherLoading: false,
    userWeatherFetchedAt: 0
  };

  // ── Job pool ───────────────────────────────────────────────
  // Apply the two multi-select filter bars (status / jobType) to
  // the global jobs list. Empty selection on either bar is treated
  // as wildcard for that dimension so the user is never stranded
  // with no list. All comparisons are case- and whitespace-tolerant
  // since job records sometimes carry slight variations ("Work
  // order" vs "Work Order", trailing whitespace, etc.).
  function filteredJobs() {
    var jobs = (window.appData && Array.isArray(window.appData.jobs)) ? window.appData.jobs : [];
    var statusSel  = _state.settings.statusFilter  || {};
    var jobTypeSel = _state.settings.jobTypeFilter || {};
    var anyStatus  = Object.keys(statusSel).some(function(k) { return statusSel[k]; });
    var anyJobType = Object.keys(jobTypeSel).some(function(k) { return jobTypeSel[k]; });
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

  // ── User-location daily forecast (calendar day-cell chips) ─
  // Reads cached coords from localStorage (planted by the header
  // weather chip's geolocation flow) and pulls a 7-day forecast
  // for them. Indexed by YYYY-MM-DD so renderWeekRow can paint
  // each visible day cell with a tiny weather chip in constant
  // time. Skipped silently when no coords are cached — the user
  // either denied geolocation or hasn't granted yet.
  function refreshUserWeatherForecast() {
    if (!window.p86Api || !window.p86Api.weather || !window.p86Api.isAuthenticated || !window.p86Api.isAuthenticated()) {
      return;
    }
    var raw;
    try { raw = JSON.parse(localStorage.getItem('p86-user-coords') || 'null'); }
    catch (e) { raw = null; }
    if (!raw || typeof raw.lat !== 'number' || typeof raw.lng !== 'number') return;
    if (_state.userWeatherLoading) return;
    var fresh = (Date.now() - _state.userWeatherFetchedAt) < WEATHER_CLIENT_TTL_MS;
    if (fresh && _state.userWeatherByDate) return;
    _state.userWeatherLoading = true;
    window.p86Api.weather.coords(raw.lat, raw.lng).then(function(res) {
      _state.userWeatherLoading = false;
      if (!res || res.status !== 'ok' || !Array.isArray(res.days)) return;
      _state.userWeather = res.days;
      _state.userWeatherFetchedAt = Date.now();
      var idx = {};
      res.days.forEach(function(d) { if (d.date) idx[d.date] = d; });
      _state.userWeatherByDate = idx;
      renderGrid();
    }).catch(function(err) {
      _state.userWeatherLoading = false;
      console.warn('[schedule] user-location weather fetch failed:', err && err.message);
    });
  }

  function userWeatherOnDate(dateIso) {
    var idx = _state.userWeatherByDate;
    return (idx && idx[dateIso]) || null;
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
  // Picks an AGX phosphor icon (wx-* registry name) based on the
  // forecast period's actual condition text — sunny gets a sun,
  // thunderstorms get the lightning bolt, fog gets fog, etc. Falls
  // back to a risk-driven default when the summary text doesn't
  // match a known condition. Risk-tinted background on the chip
  // (CSS) still carries the green/yellow/red signal alongside.
  function weatherIconNameFor(day) {
    if (!day) return 'wx-sun';
    var text = String(day.summary || '').toLowerCase();
    if (/thunder|lightning|t-?storm/.test(text)) return 'wx-cloud-lightning';
    if (/snow|sleet|flurr|wintry/.test(text)) return 'wx-cloud-snow';
    if (/fog|mist|haze/.test(text)) return 'wx-cloud-fog';
    if (/rain|shower|drizzle|storm/.test(text)) return 'wx-cloud-rain';
    if (/partly|mostly|few clouds|broken/.test(text)) return 'wx-cloud-sun';
    if (/cloud|overcast/.test(text)) return 'wx-cloud';
    if (/sunny|clear|fair/.test(text)) return 'wx-sun';
    // Fallback by risk level when the summary doesn't match.
    if (day.risk === 'red') return 'wx-cloud-warning';
    if (day.risk === 'yellow') return 'wx-cloud';
    return 'wx-sun';
  }
  // Renders the Phosphor SVG inline. Used by chip slots that don't
  // get the data-p86-icon auto-decorator (because the chip element
  // itself is the icon container — no separate child).
  function weatherIconSVG(day) {
    var name = weatherIconNameFor(day);
    if (typeof window.p86Icon === 'function') {
      return window.p86Icon(name);
    }
    return '';
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
    var iconSVG = weatherIconSVG(day);
    var temp = (day.tempHigh != null) ? day.tempHigh + '°' +
               (day.tempLow != null ? ' / ' + day.tempLow + '°' : '') : '';
    var precip = day.precipPct ? day.precipPct + '% rain' : '';
    var wind = day.windMph ? day.windMph + ' mph wind' : '';
    var bits = [day.summary, temp, precip, wind].filter(Boolean);
    return '<div class="sch-day-row-wx sch-wx-' + day.risk + '">' +
      '<span class="sch-wx-icon">' + iconSVG + '</span>' +
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
      '<div class="sch-page" id="schPage">' +
        '<aside class="sch-sidebar" id="schSidebar"></aside>' +
        // Mobile backdrop — only visible when .sch-sidebar-open is
        // on the page wrapper (CSS handles the show/hide). Click to
        // close the drawer.
        '<div class="sch-sidebar-backdrop" id="schSidebarBackdrop"></div>' +
        '<section class="sch-cal-wrap" id="schCalWrap"></section>' +
      '</div>';

    // Wire the mobile backdrop close. The sidebar-toggle button is
    // added in renderCalendar() as part of the toolbar; both
    // toggles flip the same .sch-sidebar-open class on #schPage.
    var backdrop = document.getElementById('schSidebarBackdrop');
    if (backdrop) backdrop.addEventListener('click', closeMobileSidebar);

    // Open centered on today — clear the preserved scroll anchor so
    // re-opening the Schedule always lands on today's week (not the
    // oldest rendered week, and not wherever the user last scrolled).
    _focusedWeekStart = null;
    renderSidebar();
    renderCalendar();

    // Kick off user load in the background so the editor modal can
    // populate the crew picker as soon as the user clicks a day.
    loadUsers();

    // And the server fetch — repaint the grid + summary when it lands.
    fetchEntries().then(function() {
      renderGrid();
      refreshWeekSummary();
      // Fire off two weather fetches in the background:
      //   1. Per-job forecasts → drives the entry-bar weather glyphs.
      //   2. User-location forecast → drives the day-cell chips that
      //      let the PM see "is Tuesday going to rain at my location"
      //      regardless of which jobs are scheduled. Pulls coords
      //      from the same localStorage cache the header chip uses.
      // Both repaint the grid when they land. Errors are logged
      // and swallowed so a weather outage doesn't break the view.
      refreshWeatherForVisibleJobs();
      refreshUserWeatherForecast();
    });

    // Calendar-view data — events + tasks/to-dos + reminders, fetched in
    // parallel on their own chain so they don't gate the job-entry fetch.
    // Repaint the grid + sidebar when they land so the calendar layer and
    // the day-summary sidebar fill in.
    Promise.all([fetchEvents(), fetchTasks(), fetchReminders()]).then(function() {
      renderGrid();
      renderSidebar();
    });
  }

  // Flip the exclusive view. Persists + repaints toolbar, grid, sidebar.
  function setScheduleView(v) {
    if (v !== 'production' && v !== 'calendar') return;
    _state.settings.view = v;
    if (v === 'calendar' && !_state.selectedDay) {
      _state.selectedDay = toISODate(new Date());
    }
    saveSettings(_state.settings);
    renderSidebar();
    renderCalendar(); // rebuilds toolbar (active seg) + repaints grid
  }
  // Select a day from a grid click / chip tap. Calendar view fills the
  // day-summary sidebar (and opens the mobile drawer); production view
  // keeps the existing day-at-a-glance modal.
  function selectDay(iso) {
    _state.selectedDay = iso;
    if (currentView() === 'calendar') {
      renderSidebar();
      var p = document.getElementById('schPage');
      if (p && typeof isMobileCal === 'function' && isMobileCal()) p.classList.add('sch-sidebar-open');
    } else {
      openDaySheet(iso);
    }
  }

  // ── Render: sidebar ────────────────────────────────────────
  function renderSidebar() {
    var el = document.getElementById('schSidebar');
    if (!el) return;
    // Calendar view → day-summary sidebar; production → the jobs list.
    if (currentView() === 'calendar') { renderDaySummarySidebar(el); return; }
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
      // Two multi-select filter bars stacked. Each toggles
      // independently and applies as an AND across dimensions
      // (job must pass both). Empty selection on either bar is
      // treated as wildcard for that dimension.
      buildFilterBar('statusFilter',  'Status',   STATUS_FILTERS) +
      buildFilterBar('jobTypeFilter', 'Job Type', JOB_TYPE_FILTERS) +
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

    // Wire pill toggles for both filter bars. The data-filter
    // attribute identifies the settings key (statusFilter /
    // jobTypeFilter); data-value is the option to flip. Persists
    // immediately so the user's working set sticks across reloads.
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

  // ── Day-summary sidebar (calendar view) ────────────────────
  // Occupies the same sidebar slot as the production jobs list, but
  // shows the selected day's personal items — appointments, tasks,
  // to-dos, reminders — with a day stepper. Tapping any grid day (or a
  // task/reminder chip) changes the selection via selectDay().
  function renderDaySummarySidebar(el) {
    var iso = _state.selectedDay || toISODate(new Date());
    _state.selectedDay = iso;
    var d = parseISODate(iso) || new Date();
    var todayIso = toISODate(new Date());
    var dateLabel = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    var isToday = (iso === todayIso);

    var events = (_state.events || []).filter(function(ev) {
      if (!ev || !ev.starts_at) return false;
      var sd = parseISODate(ev.starts_at); if (!sd) return false;
      var ed = parseISODate(ev.ends_at) || sd; if (ed < sd) ed = sd;
      return iso >= toISODate(sd) && iso <= toISODate(ed);
    }).sort(function(a, b) { return String(a.starts_at).localeCompare(String(b.starts_at)); });

    var dayTasks = (_state.tasks || []).filter(function(t) { return taskDueISO(t) === iso; });
    var orgTasks = dayTasks.filter(function(t) { return t.scope !== 'personal'; });
    var todos = dayTasks.filter(function(t) { return t.scope === 'personal'; });
    var reminders = (_state.reminders || []).filter(function(r) { return reminderISO(r) === iso; })
      .sort(function(a, b) { return String(a.remind_at).localeCompare(String(b.remind_at)); });
    var jobEntries = (_state.entries || []).filter(function(e) { return entrySpanDays(e).indexOf(iso) !== -1; });

    function eventRow(ev) {
      var tl = ev.all_day ? 'All day'
        : (fmtEventTime(ev.starts_at) + (ev.ends_at ? '–' + fmtEventTime(ev.ends_at) : ''));
      var st = (ev.status && ev.status !== 'confirmed') ? ev.status : '';
      return '<div class="sch-dsr sch-dsr-event" data-event-id="' + escapeAttr(ev.id) + '" style="--row-color:' + escapeAttr(ev.color || EVENT_DEFAULT_COLOR) + ';">' +
        '<span class="sch-dsr-dot"></span>' +
        '<div class="sch-dsr-main">' +
          '<div class="sch-dsr-title">' + escapeHTML(ev.title || '(untitled event)') + '</div>' +
          '<div class="sch-dsr-meta">' + escapeHTML(tl) + (ev.location ? ' · ' + escapeHTML(ev.location) : '') + (st ? ' · ' + escapeHTML(st) : '') + '</div>' +
        '</div>' +
      '</div>';
    }
    function taskRow(t) {
      return '<label class="sch-dsr sch-dsr-task" style="--row-color:' + escapeAttr(taskColor(t)) + ';">' +
        '<input type="checkbox" class="sch-dsr-check" data-task-id="' + escapeAttr(t.id) + '"' + (isTaskDone(t) ? ' checked' : '') + ' />' +
        '<div class="sch-dsr-main">' +
          '<div class="sch-dsr-title' + (isTaskDone(t) ? ' sch-dsr-done' : '') + '">' + escapeHTML(t.title || '(task)') + '</div>' +
        '</div>' +
      '</label>';
    }
    function reminderRow(r) {
      var tl = reminderTimeLabel(r);
      return '<label class="sch-dsr sch-dsr-rem" style="--row-color:' + REMINDER_COLOR + ';">' +
        '<input type="checkbox" class="sch-dsr-check" data-reminder-id="' + escapeAttr(r.id) + '" />' +
        '<div class="sch-dsr-main">' +
          '<div class="sch-dsr-title">' + escapeHTML(r.title || '(reminder)') + '</div>' +
          (tl ? '<div class="sch-dsr-meta">' + escapeHTML(tl) + '</div>' : '') +
        '</div>' +
      '</label>';
    }
    function section(title, count, rowsHtml) {
      if (!count) return '';
      return '<div class="sch-dsum-sect">' +
        '<div class="sch-dsum-sect-title">' + escapeHTML(title) + ' <span>' + count + '</span></div>' +
        rowsHtml +
      '</div>';
    }

    // Tasks/to-dos with no due date have no day to live on — surface them
    // in a day-independent bucket so they're still visible + actionable.
    var undatedTodos = (_state.tasks || []).filter(function(t) { return !taskDueISO(t); });
    var dayHasItems = events.length || dayTasks.length || reminders.length;

    var body = '';
    body += section('Appointments', events.length, events.map(eventRow).join(''));
    body += section('Tasks', orgTasks.length, orgTasks.map(taskRow).join(''));
    body += section('To-dos', todos.length, todos.map(taskRow).join(''));
    body += section('Reminders', reminders.length, reminders.map(reminderRow).join(''));
    if (!dayHasItems) body += '<div class="sch-dsum-none">Nothing on this day.</div>';
    if (jobEntries.length) {
      body += '<div class="sch-dsum-prod">' + jobEntries.length + ' job' + (jobEntries.length > 1 ? 's' : '') +
        ' on the production schedule this day. <button type="button" class="sch-dsum-link" id="schDsumToProd">View &rsaquo;</button></div>';
    }
    if (undatedTodos.length) {
      body += '<div class="sch-dsum-unsched">' +
        section('Unscheduled — no due date', undatedTodos.length, undatedTodos.map(taskRow).join('')) +
      '</div>';
    }
    if (!dayHasItems && !jobEntries.length && !undatedTodos.length) {
      body = '<div class="sch-dsum-empty">Nothing on this day.<br/>Tap <strong>+ Event</strong> to add one, or pick another day.</div>';
    }

    el.innerHTML =
      '<div class="sch-dsum-header">' +
        '<div class="sch-dsum-eyebrow">My calendar</div>' +
        '<div class="sch-dsum-date">' + escapeHTML(dateLabel) + (isToday ? ' <span class="sch-dsum-today-tag">Today</span>' : '') + '</div>' +
        '<div class="sch-dsum-nav">' +
          '<button type="button" class="sch-btn sch-btn-icon" id="schDsumPrev" title="Previous day">&lsaquo;</button>' +
          '<button type="button" class="sch-btn" id="schDsumToday">Today</button>' +
          '<button type="button" class="sch-btn sch-btn-icon" id="schDsumNext" title="Next day">&rsaquo;</button>' +
        '</div>' +
      '</div>' +
      '<div class="sch-dsum-body" id="schDsumBody">' + body + '</div>' +
      '<div class="sch-dsum-footer">' +
        '<button type="button" class="sch-btn sch-btn-primary" id="schDsumAddEvent">+ Event</button>' +
      '</div>';

    function shiftDay(n) {
      var nd = parseISODate(iso) || new Date();
      nd.setDate(nd.getDate() + n);
      _state.selectedDay = toISODate(nd);
      renderDaySummarySidebar(el);
      scrollToDate(_state.selectedDay);
    }
    var prevBtn = document.getElementById('schDsumPrev');
    if (prevBtn) prevBtn.addEventListener('click', function() { shiftDay(-1); });
    var nextBtn = document.getElementById('schDsumNext');
    if (nextBtn) nextBtn.addEventListener('click', function() { shiftDay(1); });
    var todayBtn = document.getElementById('schDsumToday');
    if (todayBtn) todayBtn.addEventListener('click', function() { _state.selectedDay = toISODate(new Date()); renderDaySummarySidebar(el); scrollToDate(_state.selectedDay); });
    var addEvBtn = document.getElementById('schDsumAddEvent');
    if (addEvBtn) addEvBtn.addEventListener('click', function() { openEventEditor(null, _state.selectedDay); });
    var toProdBtn = document.getElementById('schDsumToProd');
    if (toProdBtn) toProdBtn.addEventListener('click', function() { setScheduleView('production'); });

    // Event rows open the read-only card.
    el.querySelectorAll('.sch-dsr-event[data-event-id]').forEach(function(row) {
      row.addEventListener('click', function() {
        var ev = (_state.events || []).find(function(x) { return String(x.id) === String(row.getAttribute('data-event-id')); });
        if (ev) openEventCard(ev);
      });
    });
    // Task / to-do checkboxes → mark done (or reopen).
    el.querySelectorAll('.sch-dsr-check[data-task-id]').forEach(function(cb) {
      cb.addEventListener('change', function(e) {
        e.stopPropagation();
        var id = cb.getAttribute('data-task-id');
        if (!window.p86Api || !window.p86Api.tasks) return;
        window.p86Api.tasks.update(id, { status: cb.checked ? 'done' : 'open' })
          .then(function() { return fetchTasks(); })
          .then(function() { renderDaySummarySidebar(el); renderGrid(); })
          .catch(function(err) { console.warn('[schedule] task update failed:', err && err.message); });
      });
    });
    // Reminder checkboxes → mark done.
    el.querySelectorAll('.sch-dsr-check[data-reminder-id]').forEach(function(cb) {
      cb.addEventListener('change', function(e) {
        e.stopPropagation();
        var id = cb.getAttribute('data-reminder-id');
        if (!window.p86Api || !window.p86Api.reminders) return;
        window.p86Api.reminders.update(id, { status: 'done' })
          .then(function() { return fetchReminders(); })
          .then(function() { renderDaySummarySidebar(el); renderGrid(); })
          .catch(function(err) { console.warn('[schedule] reminder update failed:', err && err.message); });
      });
    });
  }

  // ── Render: calendar grid ──────────────────────────────────
  function renderCalendar() {
    var el = document.getElementById('schCalWrap');
    if (!el) return;
    var showW = !!_state.settings.showWeekends;
    // Exclusive view switch (production ↔ calendar) drives both the grid
    // layers and the sidebar content. See currentView() / loadSettings.
    var view = currentView();

    el.innerHTML =
      '<div class="sch-cal-toolbar">' +
        '<div class="sch-cal-nav">' +
          '<button class="sch-btn sch-btn-icon sch-mobile-only" id="schSidebarToggle" title="Filters / jobs" aria-label="Toggle filters">&#9776;</button>' +
          '<button class="sch-btn sch-btn-icon" id="schPrev" title="Previous month">&lsaquo;</button>' +
          '<div class="sch-cal-month" id="schMonth">…</div>' +
          '<button class="sch-btn sch-btn-icon" id="schNext" title="Next month">&rsaquo;</button>' +
          '<button class="sch-btn" id="schToday" style="margin-left:6px;">Today</button>' +
        '</div>' +
        '<div class="sch-week-summary" id="schWeekSummary">' +
          '<div class="sch-week-summary-loading">…</div>' +
        '</div>' +
        '<div class="sch-toolbar-spacer"></div>' +
        '<span class="p86-ask86-mount"></span>' +
        // Exclusive view switch — Production (job bars + draggable jobs
        // list) vs Calendar (events/tasks/to-dos/reminders + day summary).
        '<div class="sch-view-switch" role="group" aria-label="Calendar view">' +
          '<button class="sch-view-seg' + (view === 'production' ? ' active' : '') + '" id="schViewProduction" type="button" ' +
            'title="Production calendar — job bars on the grid + the jobs list to drag-schedule.">Production</button>' +
          '<button class="sch-view-seg' + (view === 'calendar' ? ' active' : '') + '" id="schViewCalendar" type="button" ' +
            'title="My calendar — events, tasks, to-dos &amp; reminders + a day summary.">Calendar</button>' +
        '</div>' +
        '<button class="sch-btn sch-btn-toggle' + (showW ? ' active' : '') + '" id="schWeekendToggle" ' +
          'title="' + (showW ? 'Hide' : 'Show') + ' weekend columns. Display only — does not change how production days are counted on entries.">' +
          (showW ? '&#x1F441; 7-day' : '&#x1F441; 5-day') +
        '</button>' +
        // Context the primary action to the active view.
        (view === 'calendar'
          ? '<button class="sch-btn sch-btn-primary" id="schAddEvent">+ Event</button>'
          : '<button class="sch-btn sch-btn-primary" id="schAddEntry">+ Schedule entry</button>') +
      '</div>' +
      // Fisheye scroll container. Sticky day-of-week header rides
      // at the top; the week stack below scrolls continuously.
      '<div class="sch-cal-scroll" id="schCalScroll">' +
        '<div class="sch-cal-dow-row" id="schDowRow"></div>' +
        '<div class="sch-cal-stack" id="schStack"></div>' +
      '</div>';
    refreshWeekSummary();

    document.getElementById('schPrev').addEventListener('click', function() { scrollToMonth(-1); });
    document.getElementById('schNext').addEventListener('click', function() { scrollToMonth(1); });
    document.getElementById('schToday').addEventListener('click', function() { scrollToToday(); });
    document.getElementById('schWeekendToggle').addEventListener('click', function() {
      _state.settings.showWeekends = !_state.settings.showWeekends;
      saveSettings(_state.settings);
      renderCalendar();
    });
    var addEntryBtn = document.getElementById('schAddEntry');
    if (addEntryBtn) addEntryBtn.addEventListener('click', function() {
      openEntryEditor(null, toISODate(new Date()));
    });
    // Exclusive view switch — flip the whole view (grid layers + sidebar).
    var viewProdBtn = document.getElementById('schViewProduction');
    if (viewProdBtn) viewProdBtn.addEventListener('click', function() { setScheduleView('production'); });
    var viewCalBtn = document.getElementById('schViewCalendar');
    if (viewCalBtn) viewCalBtn.addEventListener('click', function() { setScheduleView('calendar'); });
    var addEventBtn = document.getElementById('schAddEvent');
    if (addEventBtn) addEventBtn.addEventListener('click', function() {
      openEventEditor(null, toISODate(new Date()));
    });
    var toggleBtn = document.getElementById('schSidebarToggle');
    if (toggleBtn) toggleBtn.addEventListener('click', toggleMobileSidebar);

    renderGrid();
  }

  // ── Mobile sidebar drawer helpers ─────────────────────────
  function toggleMobileSidebar() {
    var page = document.getElementById('schPage');
    if (page) page.classList.toggle('sch-sidebar-open');
  }
  function closeMobileSidebar() {
    var page = document.getElementById('schPage');
    if (page) page.classList.remove('sch-sidebar-open');
  }

  // ── Fisheye lens scroll model ─────────────────────────────
  // The calendar is now a continuous vertical scroll through ~6
  // months stacked under each other. The week nearest the scroll
  // container's vertical center auto-promotes to data-lens="focused"
  // (tall row with per-day job cards); neighbors are "near" (regular
  // height with bar overlay); mid weeks shrink; far weeks compress
  // to a density strip. _state.cursor is no longer a discrete
  // "viewed month" — instead it's the date whose week is currently
  // most centered. The Today button and Prev/Next buttons smooth-
  // scroll to the right week.

  // Range we initially render around today. Lazy-extend kicks in if
  // the user scrolls within 2 weeks of either edge.
  // Range of months prepended/appended to today's date when building
  // the continuous-scroll stack. 6/6 (one year) covers normal usage
  // — scheduling 6 months out is the realistic upper bound — so the
  // boundary is never reached in practice. True dynamic lazy extension
  // (prepend/append a month when the user scrolls within 2 weeks of
  // the edge) is deferred until someone actually hits the boundary;
  // the static-wider approach trades ~700 KB of DOM for zero
  // implementation complexity + smooth scrolling across the whole
  // window without re-render hiccups.
  var MONTHS_BEHIND = 6;
  var MONTHS_AHEAD = 6;
  var _io = null;            // IntersectionObserver instance
  var _focusedWeekStart = null; // ISO date of the currently-focused week
  // Flow mode: every week row is content-driven (height grows with the
  // number of items scheduled) and shows its full day cards, instead of the
  // scroll-position fisheye that enlarged only the centered week. The
  // continuous month scroll + month label are kept. Set false to restore
  // the legacy fisheye lens.
  var FLOW_MODE = true;

  function renderGrid() {
    try { renderGridInner(); }
    catch (e) {
      console.error('[schedule] renderGrid failed:', e);
      // Visible failure note inside the scroll container so the user
      // doesn't just see a blank panel. Lets us tell at a glance
      // whether the calendar is empty because of no data or because
      // the code blew up.
      var stack = document.getElementById('schStack');
      if (stack) {
        stack.innerHTML = '<div style="padding:24px;color:#f87171;font-size:13px;">' +
          'Schedule render error: ' + (e && e.message ? e.message : String(e)) +
          ' &mdash; check the browser console for details.' +
        '</div>';
      }
    }
  }
  function renderGridInner() {
    var stack = document.getElementById('schStack');
    var dowRow = document.getElementById('schDowRow');
    var scrollEl = document.getElementById('schCalScroll');
    if (!stack || !dowRow || !scrollEl) return;
    var showW = !!_state.settings.showWeekends;
    var mobile = isMobileCal();
    // Remember the mode this render painted so the resize handler can
    // detect a breakpoint flip without re-rendering on every tick.
    _lastCalMobileMode = mobile;
    attachCalResizeListener();

    // Day-of-week header. On mobile we collapse to single letters
    // (S M T W T F S) laid out as 7 equal columns to match the
    // mobile week rows; desktop keeps the 3-letter labels and the
    // weekend-bookend column treatment.
    var MDOW_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    var dowLabels = mobile ? MDOW_LABELS : DOW_LABELS;
    var dowHtml = '';
    dowLabels.forEach(function(d) {
      dowHtml += '<div class="sch-cal-dow">' + d + '</div>';
    });
    dowRow.innerHTML = dowHtml;
    // On mobile, hide the no-weekends collapse (all 7 cols equal) and
    // tag the row so CSS lays it out as a 7-equal-col grid.
    dowRow.classList.toggle('sch-no-weekends', !mobile && !showW);
    dowRow.classList.toggle('sch-mdow', mobile);

    // Build the stack: walk from (today - MONTHS_BEHIND months, snapped
    // to its containing Sunday) to (today + MONTHS_AHEAD months, snapped
    // to the end of its last week). Emit a month-header divider whenever
    // the week crosses into a new month.
    var today = new Date();
    var firstDate = new Date(today.getFullYear(), today.getMonth() - MONTHS_BEHIND, 1);
    var lastDate  = new Date(today.getFullYear(), today.getMonth() + MONTHS_AHEAD + 1, 0);
    var rangeStart = startOfWeek(firstDate);
    var rangeEnd = addDays(lastDate, 6 - lastDate.getDay()); // pad to Saturday

    var html = '';
    var lastMonth = -1, lastYear = -1;
    for (var d = new Date(rangeStart); d <= rangeEnd; d = addDays(d, 7)) {
      var weekStart = new Date(d);
      // Month-header divider whenever the FIRST in-month day of this
      // week is a new month. We test the THURSDAY (midpoint) which
      // gives the month label that "owns" this week — the same
      // convention ISO weeks use.
      var midWeek = addDays(weekStart, 3);
      if (midWeek.getMonth() !== lastMonth || midWeek.getFullYear() !== lastYear) {
        html += '<div class="sch-month-header" data-month="' +
                midWeek.getFullYear() + '-' + (midWeek.getMonth() + 1) + '">' +
                MONTH_NAMES[midWeek.getMonth()] + ' ' + midWeek.getFullYear() + '</div>';
        lastMonth = midWeek.getMonth();
        lastYear = midWeek.getFullYear();
      }
      html += renderWeekRow(weekStart, midWeek, today);
    }
    stack.innerHTML = html;
    stack.classList.toggle('sch-no-weekends', !showW);

    wireGridDrop(stack);
    wireGridClicks(stack);

    // Pick the week to center on. Preserve the previously-focused
    // week across re-renders (entry save/delete, filter changes,
    // weekend toggle) so the user isn't snapped back to today every
    // time data updates. _focusedWeekStart is null only on the very
    // first render or after a full re-mount.
    var todayWeekIso = toISODate(startOfWeek(today));
    var centerIso = _focusedWeekStart || todayWeekIso;
    var centerRow = stack.querySelector('[data-week-start="' + centerIso + '"]');
    // Fallback if the preserved week scrolled out of the rendered
    // range (e.g. the user was viewing 5 months out and the new
    // render window doesn't include it). Just snap to today.
    if (!centerRow) {
      centerRow = stack.querySelector('[data-week-start="' + todayWeekIso + '"]');
      centerIso = todayWeekIso;
    }
    // Flow mode: tag the stack so CSS makes every row content-driven
    // (height grows with its items) instead of the scroll-position fisheye.
    stack.classList.toggle('sch-flow', FLOW_MODE);
    if (centerRow) {
      if (!FLOW_MODE) centerRow.setAttribute('data-lens', 'focused');
      _focusedWeekStart = centerIso;
    }
    // Set decay lens states on rows above/below so the initial paint
    // already shows the fisheye shape (legacy fisheye only).
    if (!FLOW_MODE) setLensAround(stack, centerRow);

    // Position scroll so the center row lands centered in the viewport.
    // requestAnimationFrame so we measure AFTER the new layout has
    // committed, not against the previous one. 'auto' (not 'smooth')
    // for re-renders so the user doesn't see an animation every time
    // they edit an entry.
    function centerNow() {
      if (centerRow && centerRow.scrollIntoView) {
        centerRow.scrollIntoView({ block: 'center', behavior: 'auto' });
      }
    }
    requestAnimationFrame(function() {
      centerNow();
      attachFocusObserver(scrollEl, stack);
      updateMonthLabel();
      // Flow-mode rows are content-driven and the stack can mount while
      // its tab is briefly hidden — both make the first scrollIntoView
      // land at the top (the oldest week). Re-center after layout settles
      // so opening the calendar reliably lands on the centered week.
      requestAnimationFrame(centerNow);
      setTimeout(centerNow, 180);
    });
  }

  // Assign data-lens to every row in the stack based on its
  // distance from `centerRow`. Used for the initial paint AND when
  // the IntersectionObserver decides the focused row changed.
  // This avoids the IO having to fire 30 ticks just to set the
  // starting state.
  function setLensAround(stack, centerRow) {
    // Mobile rows are content-sized fixed cells, not lens-driven bar
    // rows — no fisheye decoration applies. No-op so a stray call
    // can't tag mobile rows with data-lens height tiers.
    if (isMobileCal()) return;
    if (!centerRow) return;
    var rows = stack.querySelectorAll('.sch-cal-week-row');
    var centerIdx = -1;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i] === centerRow) { centerIdx = i; break; }
    }
    if (centerIdx < 0) return;
    for (var j = 0; j < rows.length; j++) {
      var dist = Math.abs(j - centerIdx);
      var lens = 'far';
      if (dist === 0) lens = 'focused';
      else if (dist === 1) lens = 'near';
      else if (dist === 2) lens = 'mid';
      rows[j].setAttribute('data-lens', lens);
    }
  }

  // IntersectionObserver-driven focus engine. Watches each
  // .sch-cal-week-row. On scroll we find the row whose center is
  // nearest the scroll container's vertical center and promote it
  // to data-lens="focused"; neighbors get "near" / "mid" / "far"
  // based on row-count distance.
  function attachFocusObserver(scrollEl, stack) {
    if (_io) { _io.disconnect(); _io = null; }
    var raf = 0;
    var pending = false;
    function tick() {
      pending = false;
      raf = 0;
      var containerRect = scrollEl.getBoundingClientRect();
      var containerCenter = containerRect.top + containerRect.height / 2;
      var rows = stack.querySelectorAll('.sch-cal-week-row');
      if (!rows.length) return;
      // Find the row whose vertical center is closest to the
      // container's center. O(n) per scroll tick — fine for ~30 rows.
      var bestIdx = 0, bestDist = Infinity;
      var rowRects = [];
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i].getBoundingClientRect();
        rowRects.push(r);
        var rowCenter = r.top + r.height / 2;
        var dist = Math.abs(rowCenter - containerCenter);
        if (dist < bestDist) { bestDist = dist; bestIdx = i; }
      }
      var focusedIso = rows[bestIdx].getAttribute('data-week-start');
      if (focusedIso === _focusedWeekStart) return; // no change
      _focusedWeekStart = focusedIso;
      // Apply new lens states based on row-count distance (legacy fisheye).
      // Skipped in flow mode, where rows are sized by their own content.
      if (!FLOW_MODE) {
        for (var k = 0; k < rows.length; k++) {
          var distRows = Math.abs(k - bestIdx);
          var lens = 'far';
          if (distRows === 0) lens = 'focused';
          else if (distRows === 1) lens = 'near';
          else if (distRows === 2) lens = 'mid';
          if (rows[k].getAttribute('data-lens') !== lens) {
            rows[k].setAttribute('data-lens', lens);
          }
        }
      }
      updateMonthLabel();
    }
    function schedule() {
      if (pending) return;
      pending = true;
      raf = requestAnimationFrame(tick);
    }
    scrollEl.addEventListener('scroll', schedule, { passive: true });
    // First tick so we get accurate lens states even if the user
    // doesn't scroll right away (the initial center-scroll might
    // move us off the row we set as focused above).
    schedule();
  }

  // Sync the month label in the toolbar with whichever week is
  // currently focused — gives the user a stable orientation as
  // they scroll between months.
  function updateMonthLabel() {
    var label = document.getElementById('schMonth');
    if (!label || !_focusedWeekStart) return;
    var midWeek = addDays(parseISODate(_focusedWeekStart), 3);
    label.textContent = MONTH_NAMES[midWeek.getMonth()] + ' ' + midWeek.getFullYear();
  }

  // Smooth-scroll the calendar so today's week lands centered.
  function scrollToToday() {
    var stack = document.getElementById('schStack');
    if (!stack) return;
    var iso = toISODate(startOfWeek(new Date()));
    var row = stack.querySelector('[data-week-start="' + iso + '"]');
    if (row && row.scrollIntoView) {
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
  // Smooth-scroll the grid so a given day's week is centered. Used when
  // the day-summary sidebar's stepper moves the selected day off-screen.
  function scrollToDate(iso) {
    var stack = document.getElementById('schStack');
    if (!stack || !iso) return;
    var wkIso = toISODate(startOfWeek(parseISODate(iso) || new Date()));
    var row = stack.querySelector('[data-week-start="' + wkIso + '"]');
    if (row && row.scrollIntoView) {
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
  // Smooth-scroll to the first week of (focused month + delta).
  function scrollToMonth(delta) {
    var stack = document.getElementById('schStack');
    if (!stack) return;
    var base = _focusedWeekStart ? parseISODate(_focusedWeekStart) : new Date();
    var target = new Date(base.getFullYear(), base.getMonth() + delta, 1);
    var iso = toISODate(startOfWeek(target));
    var row = stack.querySelector('[data-week-start="' + iso + '"]');
    // If we scrolled off the rendered range, snap to the closest
    // edge week. Lazy-extend will be added later; for now we just
    // make sure the button does *something* visible.
    if (!row) {
      var rows = stack.querySelectorAll('.sch-cal-week-row');
      row = delta < 0 ? rows[0] : rows[rows.length - 1];
    }
    if (row && row.scrollIntoView) {
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
  // Legacy entry point kept so callers (e.g. callbacks that used to
  // hop months) still work. Maps to scrollToMonth.
  function stepMonth(delta) { scrollToMonth(delta); }

  // ── Mobile week row (Outlook-style month grid) ─────────────
  // Builds one week as a 7-equal-col grid of day cells. Each cell:
  //   - day number at top (filled accent circle for today)
  //   - up to 3 compact rounded chips (title only, one line, ellipsis)
  //   - a "+N more" button when the day has > 3 items
  // The per-day item list is the union of job entries that span the
  // day (when the Jobs layer is on) and personal events whose
  // [starts_at .. ends_at||starts_at] range covers the day (when the
  // My Events layer is on). All-day / job items sort first; timed
  // events follow by start time. Reuses entrySpanDays, colorForJob,
  // jobById, EVENT_DEFAULT_COLOR, escapeHTML/escapeAttr — no new
  // scheduling logic. `days` and `weekKeys` come from renderWeekRow.
  function renderMobileWeekRow(days, weekKeys) {
    var layers = _state.settings.layers || {};
    var view = currentView();
    var jobsOn = (view === 'production');
    var eventsOn = (view === 'calendar');

    var weekStartIso = weekKeys[0];
    var html = '<div class="sch-cal-week-row sch-mweek" data-week-start="' +
               escapeAttr(weekStartIso) + '">';

    days.forEach(function(day) {
      // Collect this day's items. Match the desktop date-clipping
      // logic: jobs via entrySpanDays membership, events via an
      // inclusive [start..end] ISO-date range that falls back to the
      // start date when ends_at is missing.
      var items = [];
      if (jobsOn) {
        _state.entries.forEach(function(e) {
          var span = entrySpanDays(e);
          if (span.indexOf(day.iso) === -1) return;
          items.push({
            kind: 'job',
            entry: e,
            color: colorForJob(e.jobId),
            label: (function() {
              var job = jobById(e.jobId);
              return job ? (job.jobNumber || job.title || 'Job') : 'Job';
            })(),
            muted: (e.status === 'done' || e.status === 'rolled-over'),
            canceled: false,
            sortKey: 0 // jobs (all-day-ish) sort before timed events
          });
        });
      }
      if (eventsOn && _state.events && _state.events.length) {
        _state.events.forEach(function(ev) {
          if (!ev || !ev.starts_at) return;
          var sd = parseISODate(ev.starts_at);
          if (!sd) return;
          var ed = parseISODate(ev.ends_at) || sd;
          if (ed < sd) ed = sd;
          if (day.iso < toISODate(sd) || day.iso > toISODate(ed)) return;
          // Timed events sort after all-day ones, ordered by start
          // time. All-day events keep the same all-day rank as jobs.
          var sortKey = 0;
          if (!ev.all_day) {
            var t = new Date(ev.starts_at);
            sortKey = isNaN(t.getTime()) ? 1 : (1 + t.getHours() / 24 + t.getMinutes() / 1440);
          }
          items.push({
            kind: 'event',
            event: ev,
            color: ev.color || EVENT_DEFAULT_COLOR,
            label: ev.title || '(untitled event)',
            muted: (ev.status === 'tentative' || ev.status === 'canceled'),
            canceled: (ev.status === 'canceled'),
            sortKey: sortKey
          });
        });
      }
      // Tasks / to-dos + reminders share the calendar layer with events.
      if (eventsOn) {
        (_state.tasks || []).forEach(function(t) {
          if (taskDueISO(t) !== day.iso) return;
          items.push({
            kind: 'task', task: t, color: taskColor(t),
            label: (isTaskDone(t) ? '✓ ' : '') + (t.title || 'Task'),
            muted: isTaskDone(t), canceled: false, sortKey: 0.5
          });
        });
        (_state.reminders || []).forEach(function(r) {
          if (reminderISO(r) !== day.iso) return;
          var tl = reminderTimeLabel(r);
          items.push({
            kind: 'reminder', reminder: r, color: REMINDER_COLOR,
            label: '⏰ ' + (tl ? tl + ' ' : '') + (r.title || 'Reminder'),
            muted: false, canceled: false, sortKey: 0.6
          });
        });
      }
      // Stable sort: all-day/job first, then timed events by start.
      items.sort(function(a, b) { return a.sortKey - b.sortKey; });

      var cls = 'sch-mcell';
      if (!day.inMonth) cls += ' sch-mcell-oom';
      if (day.isToday) cls += ' sch-mcell-today';
      if (day.isWeekend) cls += ' sch-mcell-weekend';

      var cellHtml = '<div class="' + cls + '" data-date="' + escapeAttr(day.iso) + '">' +
        '<div class="sch-mdaynum">' + day.date.getDate() + '</div>';

      var shown = items.slice(0, 3);
      shown.forEach(function(it) {
        var chipCls = 'sch-mchip';
        if (it.muted) chipCls += ' sch-mchip-muted';
        if (it.canceled) chipCls += ' sch-mchip-canceled';
        var idAttr = it.kind === 'job'
          ? 'data-entry-id="' + escapeAttr(it.entry.id) + '"'
          : it.kind === 'task'
          ? 'data-task-id="' + escapeAttr(it.task.id) + '"'
          : it.kind === 'reminder'
          ? 'data-reminder-id="' + escapeAttr(it.reminder.id) + '"'
          : 'data-event-id="' + escapeAttr(it.event.id) + '"';
        cellHtml += '<div class="' + chipCls + '" ' + idAttr +
          ' style="--chip-color:' + escapeAttr(it.color) + ';"' +
          ' title="' + escapeAttr(it.label) + '">' +
          escapeHTML(it.label) +
        '</div>';
      });

      if (items.length > 3) {
        var more = items.length - 3;
        cellHtml += '<button type="button" class="sch-mmore" data-date="' +
          escapeAttr(day.iso) + '">+' + more + ' more</button>';
      }

      cellHtml += '</div>';
      html += cellHtml;
    });

    html += '</div>';
    return html;
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
    // View drives both the grid layers and which per-day content renders.
    var view = currentView();
    var calOn = (view === 'calendar');
    var jobsLayerOn = (view === 'production');

    // ── MOBILE month-grid branch ───────────────────────────────
    // Outlook-mobile-style fixed grid: a 7-equal-col row of day cells,
    // each with the day number on top + up to 3 compact event chips +
    // a "+N more" affordance. No spanning bars, no fisheye, no weekend
    // bookends — all 7 columns are equal width. Keeps the
    // data-week-start attribute so scroll-to-week still works. Desktop
    // (the code below) is left byte-for-byte unchanged.
    if (isMobileCal()) {
      return renderMobileWeekRow(days, weekKeys);
    }

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
    var isFocusedWeek = (_state.settings.focusWeekStart === weekStartIso);
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

    // Day-cell base layer (one cell per column). Each cell may
    // carry a per-day weather chip in the top-right corner when
    // the user-location forecast is loaded and covers that date.
    // The chip uses small inline styling + a risk class so red
    // days catch the eye without crowding the day number.
    days.forEach(function(d) {
      if (d.isWeekend && hideWeekend) {
        html += '<div class="sch-cal-day sch-weekend sch-cal-day-hidden"></div>';
        return;
      }
      var cls = 'sch-cal-day';
      if (!d.inMonth) cls += ' sch-other-month';
      if (d.isWeekend) cls += ' sch-weekend';
      if (d.isToday) cls += ' sch-today';
      var dayWx = userWeatherOnDate(d.iso);
      var wxHtml = '';
      if (dayWx) {
        var wxBits = [dayWx.summary || ''];
        if (dayWx.tempHigh != null) {
          wxBits.push(dayWx.tempHigh + '°' + (dayWx.tempLow != null ? ' / ' + dayWx.tempLow + '°' : ''));
        }
        if (dayWx.precipPct) wxBits.push(dayWx.precipPct + '% rain');
        if (dayWx.windMph) wxBits.push(dayWx.windMph + ' mph wind');
        var wxIconSVG = weatherIconSVG(dayWx);
        var wxTemp = (dayWx.tempHigh != null) ? (dayWx.tempHigh + '°') : '';
        wxHtml = '<span class="sch-cal-day-wx sch-wx-' + dayWx.risk +
                 '" title="' + escapeAttr(wxBits.filter(Boolean).join(' · ')) + ' (your location)">' +
          '<span class="sch-cal-day-wx-icon">' + wxIconSVG + '</span>' +
          (wxTemp ? '<span class="sch-cal-day-wx-temp">' + escapeHTML(wxTemp) + '</span>' : '') +
        '</span>';
      }
      // Per-day job-card list, shown only when the parent week is
      // focused. We always emit the list so toggling lens states
      // doesn't require re-rendering — CSS just shows/hides via
      // display rules on .sch-cal-week-row[data-lens="focused"].
      // entriesOnDay() expects a Date, NOT an ISO string — passing
      // d.iso was the bug behind "[schedule] renderGrid failed:
      // TypeError: d.getFullYear is not a function".
      var dayEntries = calOn ? [] : entriesOnDay(d.date);
      var dayCardsHtml = '';
      if (dayEntries.length) {
        dayCardsHtml = '<div class="sch-cal-day-jobs">';
        dayEntries.forEach(function(e) {
          var job = jobById(e.jobId);
          var color = colorForJob(e.jobId);
          var label = job ? (job.jobNumber || job.title || 'Job') : 'Job';
          var span = entrySpanDays(e);
          // Continuation arrows: ← if this isn't the entry's first day;
          // → if it isn't its last. Helps the user see at a glance
          // that the entry spans more than the cell they're looking at.
          var continueLeft = span.length > 1 && span.indexOf(d.iso) > 0 ? '<span class="sch-day-job-cont">←</span> ' : '';
          var continueRight = span.length > 1 && span.indexOf(d.iso) < span.length - 1 ? ' <span class="sch-day-job-cont">→</span>' : '';
          var statusCls = '';
          if (e.status === 'done') statusCls = ' sch-day-job-done';
          else if (e.status === 'rolled-over') statusCls = ' sch-day-job-rolled';
          var crew = (e.crew && e.crew.length) ? '<span class="sch-day-job-crew">' + e.crew.length + '👷</span>' : '';
          dayCardsHtml += '<button type="button" class="sch-day-job-card' + statusCls + '" ' +
            'data-entry-id="' + escapeAttr(e.id) + '" ' +
            'style="--job-color:' + color + ';" ' +
            'title="' + escapeAttr(jobLabel(job)) + (e.notes ? ' — ' + escapeAttr(e.notes) : '') + '">' +
            continueLeft +
            '<span class="sch-day-job-label">' + escapeHTML(label) + '</span>' +
            continueRight +
            crew +
          '</button>';
        });
        dayCardsHtml += '</div>';
      }
      // Mid-state dot strip — one colored dot per entry on this day.
      // CSS shows this only when the parent week is data-lens="mid".
      var dotsHtml = '';
      if (dayEntries.length) {
        dotsHtml = '<div class="sch-cal-day-dots">';
        dayEntries.forEach(function(e) {
          dotsHtml += '<span class="sch-cal-day-dot" style="background:' + colorForJob(e.jobId) + ';"></span>';
        });
        dotsHtml += '</div>';
      }
      // Calendar view paints the user's events / tasks / reminders as the
      // per-day cards (focused + flow lens) AND dots (mid lens) — the only
      // layers visible in FLOW_MODE. Jobs are hidden here (dayEntries=[]).
      if (calOn) {
        var _ci = dayCalItems(d.iso);
        if (_ci.length) {
          dayCardsHtml = '<div class="sch-cal-day-jobs">';
          _ci.forEach(function(it) {
            var da = it.kind === 'event' ? 'data-event-id="' + escapeAttr(it.id) + '"'
                   : it.kind === 'task' ? 'data-task-id="' + escapeAttr(it.id) + '"'
                   : 'data-reminder-id="' + escapeAttr(it.id) + '"';
            dayCardsHtml += '<button type="button" class="sch-day-job-card sch-cal-daycard' + (it.done ? ' sch-day-job-done' : '') + '" ' +
              da + ' style="--job-color:' + escapeAttr(it.color) + ';" title="' + escapeAttr(it.label) + '">' +
              '<span class="sch-day-job-label">' + escapeHTML(it.label) + '</span>' +
            '</button>';
          });
          dayCardsHtml += '</div>';
          dotsHtml = '<div class="sch-cal-day-dots">';
          _ci.forEach(function(it) { dotsHtml += '<span class="sch-cal-day-dot" style="background:' + escapeAttr(it.color) + ';"></span>'; });
          dotsHtml += '</div>';
        }
      }
      html += '<div class="' + cls + '" data-date="' + d.iso + '">' +
        '<span class="sch-cal-day-num">' + d.date.getDate() + '</span>' +
        wxHtml +
        dotsHtml +
        dayCardsHtml +
      '</div>';
    });

    // Overlay layer — absolute container positioned over the week
    // row. Bars use percent-based left/width so they snap to the
    // 7-col layout and stay aligned when the row resizes.
    html += '<div class="sch-cal-bars">';
    // Slice C — layer visibility. Job bars only emit when the Jobs
    // layer is on; events only when the My Events layer is on. maxRow
    // tracks the highest job-bar row actually rendered so the event
    // layer can stack below without overlapping. When jobs are hidden
    // maxRow stays -1 so events start at the base row.
    var layers = _state.settings.layers || {};
    var view = currentView();
    var jobsLayerOn = (view === 'production');
    var calOn = (view === 'calendar');
    var maxRow = -1;
    if (jobsLayerOn) segments.forEach(function(seg) {
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
          weatherIconSVG(dayWx) +
        '</span>';
      }
      html += '<div class="sch-entry-bar' + statusCls + '" ' +
        'data-entry-id="' + escapeAttr(e.id) + '" ' +
        'style="left:' + leftPct.toFixed(4) + '%;width:calc(' + widthPct.toFixed(4) + '% - 4px);top:' + topPx + 'px;--entry-color:' + color + ';" ' +
        'title="' + escapeAttr(jobLabel(job)) + (e.notes ? ' — ' + escapeAttr(e.notes) : '') + '">' +
        wxHtml +
        '<span class="sch-entry-bar-label">' + escapeHTML(label) + hint + '</span>' +
        (meta ? '<span class="sch-entry-bar-meta">' + meta + '</span>' : '') +
        handleHtml +
      '</div>';
    });

    // ── Slice C: personal calendar events layer ────────────────
    // A SECOND layer painted alongside (below) the job bars. Each
    // event is clipped to this week's 7 day-columns; multi-day events
    // span columns, single-day events occupy one. Events stack into
    // their own rows starting just below the lowest job-bar row used
    // this week (eventBaseRow), so the two layers never overlap.
    if (calOn) {
      var eventSegs = [];
      // Personal calendar events (multi-day aware), clipped to this week.
      (_state.events || []).forEach(function(ev) {
        if (!ev || !ev.starts_at) return;
        var sd = parseISODate(ev.starts_at);
        if (!sd) return;
        // End date inclusive; fall back to the start date when ends_at
        // is missing. Clip the [start..end] day range to this week.
        var ed = parseISODate(ev.ends_at) || sd;
        if (ed < sd) ed = sd;
        var cols = [];
        for (var ci = 0; ci < 7; ci++) {
          var dayIso = weekKeys[ci];
          if (dayIso >= toISODate(sd) && dayIso <= toISODate(ed)) cols.push(ci);
        }
        if (!cols.length) return;
        // Group consecutive columns into runs so an event that wraps
        // a week boundary (or the layout) renders as one bar per run.
        var run = [cols[0]];
        for (var k = 1; k < cols.length; k++) {
          if (cols[k] === cols[k - 1] + 1) { run.push(cols[k]); }
          else { eventSegs.push({ kind: 'event', event: ev, startCol: run[0], span: run.length }); run = [cols[k]]; }
        }
        eventSegs.push({ kind: 'event', event: ev, startCol: run[0], span: run.length });
      });
      // Tasks + to-dos — single-day, on their due_date.
      (_state.tasks || []).forEach(function(t) {
        var iso = taskDueISO(t); if (!iso) return;
        var ci = weekKeys.indexOf(iso); if (ci === -1) return;
        eventSegs.push({ kind: 'task', task: t, startCol: ci, span: 1 });
      });
      // Reminders — single-day, on the remind_at date.
      (_state.reminders || []).forEach(function(r) {
        var iso = reminderISO(r); if (!iso) return;
        var ci = weekKeys.indexOf(iso); if (ci === -1) return;
        eventSegs.push({ kind: 'reminder', reminder: r, startCol: ci, span: 1 });
      });

      if (eventSegs.length) {
        // Greedy left-to-right row packing within the calendar layer,
        // identical to the job-bar packer. Row 0 here is the first
        // calendar row; it's offset below the job rows when positioned.
        eventSegs.sort(function(a, b) {
          if (a.startCol !== b.startCol) return a.startCol - b.startCol;
          return b.span - a.span;
        });
        var evOccupancy = [];
        eventSegs.forEach(function(seg) {
          var placed = false;
          for (var r = 0; r < 12 && !placed; r++) {
            evOccupancy[r] = evOccupancy[r] || [];
            var clash = evOccupancy[r].some(function(slot) {
              return !(seg.startCol + seg.span <= slot.start || seg.startCol >= slot.end);
            });
            if (!clash) {
              evOccupancy[r].push({ start: seg.startCol, end: seg.startCol + seg.span });
              seg.row = r;
              placed = true;
            }
          }
          if (!placed) seg.row = 11;
        });

        // Calendar items start one row below the lowest job-bar row used
        // this week. When jobs are hidden (maxRow === -1) they start at
        // the base row, same vertical rhythm (22 + row*18).
        var eventBaseRow = maxRow + 1;
        eventSegs.forEach(function(seg) {
          var leftPct = colLeftPct(seg.startCol);
          var widthPct = colWidthPct(seg.startCol, seg.span);
          var rowIdx = eventBaseRow + seg.row;
          var topPx = 22 + rowIdx * 18;
          var cls = 'sch-cal-event';
          var color, title, dataAttr, statusCls = '', timePrefix = '';
          if (seg.kind === 'task') {
            var t = seg.task;
            color = taskColor(t);
            title = (isTaskDone(t) ? '✓ ' : '') + (t.title || '(task)');
            dataAttr = 'data-task-id="' + escapeAttr(t.id) + '"';
            cls += ' sch-cal-task';
            if (isTaskDone(t)) statusCls = ' sch-cal-event-canceled';
          } else if (seg.kind === 'reminder') {
            var r2 = seg.reminder;
            color = REMINDER_COLOR;
            var rt = reminderTimeLabel(r2);
            timePrefix = (rt ? rt + ' ' : '') + '⏰ ';
            title = r2.title || '(reminder)';
            dataAttr = 'data-reminder-id="' + escapeAttr(r2.id) + '"';
            cls += ' sch-cal-reminder';
          } else {
            var ev = seg.event;
            color = ev.color || EVENT_DEFAULT_COLOR;
            if (ev.status === 'tentative') statusCls = ' sch-cal-event-tentative';
            else if (ev.status === 'canceled') statusCls = ' sch-cal-event-canceled';
            title = ev.title || '(untitled event)';
            // Timed events get a compact local-time prefix; all-day
            // events just show the title.
            if (!ev.all_day) { var et = fmtEventTime(ev.starts_at); if (et) timePrefix = et + ' '; }
            dataAttr = 'data-event-id="' + escapeAttr(ev.id) + '"';
          }
          html += '<div class="' + cls + statusCls + '" ' + dataAttr + ' ' +
            'style="left:' + leftPct.toFixed(4) + '%;width:calc(' + widthPct.toFixed(4) + '% - 4px);top:' + topPx + 'px;--event-color:' + escapeAttr(color) + ';" ' +
            'title="' + escapeAttr(timePrefix + title) + '">' +
            escapeHTML(timePrefix + title) +
          '</div>';
        });
      }
    }

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
        if (entry) openEntryCard(entry);
      });
    });
    // Slice C — personal calendar events. Tap → read-only event card.
    // Wired alongside the job-bar handler so both overlay layers are
    // independently clickable.
    grid.querySelectorAll('.sch-cal-event[data-event-id], .sch-day-job-card[data-event-id]').forEach(function(el) {
      el.addEventListener('click', function(e) {
        e.stopPropagation();
        var id = el.getAttribute('data-event-id');
        var event = (_state.events || []).find(function(x) { return String(x.id) === String(id); });
        if (event) openEventCard(event);
      });
    });
    // Calendar tasks / reminders (desktop bars + mobile chips both carry
    // these attrs) — tap selects that day so its summary fills the
    // sidebar, where the item can be checked off.
    grid.querySelectorAll('[data-task-id]').forEach(function(el) {
      el.addEventListener('click', function(e) {
        e.stopPropagation();
        var t = (_state.tasks || []).find(function(x) { return String(x.id) === String(el.getAttribute('data-task-id')); });
        if (t && taskDueISO(t)) selectDay(taskDueISO(t));
      });
    });
    grid.querySelectorAll('[data-reminder-id]').forEach(function(el) {
      el.addEventListener('click', function(e) {
        e.stopPropagation();
        var r = (_state.reminders || []).find(function(x) { return String(x.id) === String(el.getAttribute('data-reminder-id')); });
        if (r && reminderISO(r)) selectDay(reminderISO(r));
      });
    });
    // Per-day job cards inside focused weeks. Tap → open the read-only card.
    // Wired BEFORE the day-cell catch-all so the card click doesn't
    // bubble up and re-open the day sheet on top of the editor.
    grid.querySelectorAll('.sch-day-job-card[data-entry-id]').forEach(function(card) {
      card.addEventListener('click', function(e) {
        e.stopPropagation();
        var id = card.getAttribute('data-entry-id');
        var entry = _state.entries.find(function(x) { return x.id === id; });
        if (entry) openEntryCard(entry);
      });
    });
    grid.querySelectorAll('.sch-cal-day[data-date]').forEach(function(cell) {
      cell.addEventListener('click', function(e) {
        if (e.target.closest('.sch-entry-bar')) return;
        if (e.target.closest('.sch-day-job-card')) return;
        if (e.target.closest('.sch-week-focus-rail')) return;
        var date = cell.getAttribute('data-date');
        // Calendar view: select the day so the sidebar shows its summary.
        // Production view: open the day-at-a-glance sheet (job focus) —
        // direct click-to-create-blank was easy to trigger by accident.
        selectDay(date);
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
        if (_state.settings.focusWeekStart === weekStart && _state.settings.weekSummaryPinned) {
          _state.settings.focusWeekStart = null;
          _state.settings.weekSummaryPinned = false;
        } else {
          _state.settings.focusWeekStart = weekStart;
          _state.settings.weekSummaryPinned = true;
        }
        saveSettings(_state.settings);
        renderGrid();
        refreshWeekSummary();
      });
    });

    // ── Mobile month-grid wiring ───────────────────────────────
    // Chips open their read-only card; "+N more" and a bare cell tap
    // open the day-at-a-glance sheet. These selectors only exist on
    // mobile rows (renderMobileWeekRow), so on desktop the loops are
    // no-ops.
    grid.querySelectorAll('.sch-mchip[data-entry-id]').forEach(function(el) {
      el.addEventListener('click', function(e) {
        e.stopPropagation();
        var id = el.getAttribute('data-entry-id');
        var entry = _state.entries.find(function(x) { return x.id === id; });
        if (entry) openEntryCard(entry);
      });
    });
    grid.querySelectorAll('.sch-mchip[data-event-id]').forEach(function(el) {
      el.addEventListener('click', function(e) {
        e.stopPropagation();
        var id = el.getAttribute('data-event-id');
        var event = (_state.events || []).find(function(x) { return String(x.id) === String(id); });
        if (event) openEventCard(event);
      });
    });
    grid.querySelectorAll('.sch-mmore[data-date]').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var date = btn.getAttribute('data-date');
        if (date) openDaySheet(date);
      });
    });
    grid.querySelectorAll('.sch-mcell[data-date]').forEach(function(cell) {
      cell.addEventListener('click', function(e) {
        // Only the bare cell tap acts — chip / more taps handle
        // themselves and stopPropagation above.
        if (e.target.closest('.sch-mchip')) return;
        if (e.target.closest('.sch-mmore')) return;
        var date = cell.getAttribute('data-date');
        if (date) selectDay(date);
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

    // Personal calendar events on this day — unified into the day sheet
    // alongside job entries so "day at a glance" shows EVERYTHING. Same
    // date-clip as the grid; sorted by start time.
    var dayEvents = (_state.events || []).filter(function(ev) {
      if (!ev || !ev.starts_at) return false;
      var sd = parseISODate(ev.starts_at); if (!sd) return false;
      var ed = parseISODate(ev.ends_at) || sd; if (ed < sd) ed = sd;
      return dateISO >= toISODate(sd) && dateISO <= toISODate(ed);
    }).sort(function(a, b) { return String(a.starts_at).localeCompare(String(b.starts_at)); });

    // Tasks / to-dos + reminders due on this day — surfaced in the sheet
    // so "day at a glance" really shows everything (not just jobs/events).
    var dayTasks = (_state.tasks || []).filter(function(t) { return taskDueISO(t) === dateISO; });
    var dayReminders = (_state.reminders || []).filter(function(r) { return reminderISO(r) === dateISO; })
      .sort(function(a, b) { return String(a.remind_at).localeCompare(String(b.remind_at)); });

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

    var entryRowsHtml = entries.map(function(e) {
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

    var eventRowsHtml = dayEvents.map(function(ev) {
      var color = ev.color || EVENT_DEFAULT_COLOR;
      var timeLabel = ev.all_day ? 'All day'
        : (fmtEventTime(ev.starts_at) + (ev.ends_at ? '–' + fmtEventTime(ev.ends_at) : ''));
      var st = (ev.status && ev.status !== 'confirmed') ? ev.status : '';
      return '<div class="sch-day-row" data-event-id="' + escapeAttr(ev.id) + '" ' +
              'style="--job-color:' + escapeAttr(color) + ';">' +
        '<div class="sch-day-row-color"></div>' +
        '<div class="sch-day-row-main">' +
          '<div class="sch-day-row-title">' + escapeHTML(ev.title || '(untitled event)') + '</div>' +
          '<div class="sch-day-row-meta">' +
            '<span>' + escapeHTML(timeLabel) + '</span>' +
            (ev.location ? '<span>' + escapeHTML(ev.location) + '</span>' : '') +
            (st ? '<span class="sch-day-row-status">' + escapeHTML(st) + '</span>' : '') +
          '</div>' +
          (ev.notes ? '<div class="sch-day-row-notes">' + escapeHTML(ev.notes) + '</div>' : '') +
        '</div>' +
        '<div class="sch-day-row-actions">' +
          '<button type="button" class="sch-btn sch-day-edit-event" data-event-id="' + escapeAttr(ev.id) + '">Edit</button>' +
        '</div>' +
      '</div>';
    }).join('');

    var taskRowsHtml = dayTasks.map(function(t) {
      return '<div class="sch-day-row" data-task-id="' + escapeAttr(t.id) + '" ' +
              'style="--job-color:' + escapeAttr(taskColor(t)) + ';">' +
        '<div class="sch-day-row-color"></div>' +
        '<div class="sch-day-row-main">' +
          '<div class="sch-day-row-title">' + (isTaskDone(t) ? '✓ ' : '') + escapeHTML(t.title || '(task)') + '</div>' +
          '<div class="sch-day-row-meta"><span>' + (t.scope === 'personal' ? 'To-do' : 'Task') + '</span></div>' +
        '</div>' +
      '</div>';
    }).join('');
    var reminderRowsHtml = dayReminders.map(function(r) {
      var tl = reminderTimeLabel(r);
      return '<div class="sch-day-row" data-reminder-id="' + escapeAttr(r.id) + '" ' +
              'style="--job-color:' + REMINDER_COLOR + ';">' +
        '<div class="sch-day-row-color"></div>' +
        '<div class="sch-day-row-main">' +
          '<div class="sch-day-row-title">⏰ ' + escapeHTML(r.title || '(reminder)') + '</div>' +
          '<div class="sch-day-row-meta"><span>' + escapeHTML(tl || 'Reminder') + '</span></div>' +
        '</div>' +
      '</div>';
    }).join('');

    var rowsHtml = (entryRowsHtml + eventRowsHtml + taskRowsHtml + reminderRowsHtml) ||
      '<div class="sch-day-sheet-empty">Nothing scheduled for this day yet.</div>';

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
            '<div class="sch-day-stat-label">Items</div>' +
            '<div class="sch-day-stat-val">' + (entries.length + dayEvents.length + dayTasks.length + dayReminders.length) + '</div>' +
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
          '<button class="sch-btn" id="schDaySheetAddEvent">+ Event</button>' +
          '<button class="sch-btn sch-btn-primary" id="schDaySheetAdd">+ Job entry</button>' +
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
    var addEvtBtn = modal.querySelector('#schDaySheetAddEvent');
    if (addEvtBtn) addEvtBtn.addEventListener('click', function() {
      close();
      openEventEditor(null, dateISO);
    });
    // Edit buttons jump straight to the editor (job entries / events).
    modal.querySelectorAll('.sch-day-edit').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var id = btn.getAttribute('data-entry-id');
        var entry = _state.entries.find(function(x) { return x.id === id; });
        close();
        if (entry) openEntryEditor(entry, entry.startDate, entry.jobId);
      });
    });
    modal.querySelectorAll('.sch-day-edit-event').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var id = btn.getAttribute('data-event-id');
        var ev = (_state.events || []).find(function(x) { return String(x.id) === String(id); });
        close();
        if (ev) openEventEditor(ev);
      });
    });
    // Click anywhere on a row (not an Edit button) → open its READ-ONLY
    // card; the card's Edit button is the path into the editor. Branches
    // job rows (data-entry-id) vs event rows (data-event-id).
    modal.querySelectorAll('.sch-day-row').forEach(function(row) {
      row.addEventListener('click', function(e) {
        if (e.target.closest('.sch-day-edit') || e.target.closest('.sch-day-edit-event')) return;
        var eid = row.getAttribute('data-event-id');
        if (eid) {
          var ev = (_state.events || []).find(function(x) { return String(x.id) === String(eid); });
          close();
          if (ev) openEventCard(ev);
          return;
        }
        var id = row.getAttribute('data-entry-id');
        var entry = _state.entries.find(function(x) { return x.id === id; });
        close();
        if (entry) openEntryCard(entry);
      });
    });
  }

  // ── Read-only "live card" for a schedule entry ─────────────
  // Clicking an entry on the calendar opens this clean, refined view —
  // NOT the editor. An Edit button flips into the full editor only when
  // the user actually wants to change something (the Outlook "open the
  // item, then choose to edit" flow).
  function fmtCardDate(d) {
    if (!d) return '';
    var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return DOW[d.getDay()] + ', ' + MON[d.getMonth()] + ' ' + d.getDate();
  }
  function openEntryCard(entry) {
    if (!entry) return;
    var job = jobById(entry.jobId);
    var color = colorForJob(entry.jobId);
    var span = entrySpanDays(entry);
    var startD = parseISODate(entry.startDate);
    var endIso = span.length ? span[span.length - 1] : entry.startDate;
    var endD = parseISODate(endIso);
    var when = fmtCardDate(startD) + (endD && endIso !== entry.startDate ? '  →  ' + fmtCardDate(endD) : '');
    var dayCount = span.length || (parseInt(entry.days, 10) || 1);
    var statusLabel = (entry.status || 'planned').replace(/-/g, ' ');
    var crew = (entry.crew || []).map(function (id) {
      var u = (_state.users || []).find(function (x) { return String(x.id) === String(id); });
      return u ? (u.name || u.email || ('User ' + id)) : ('User ' + id);
    });

    function row(label, val) {
      if (!val) return '';
      return '<div style="display:flex;gap:12px;padding:9px 0;border-top:1px solid var(--border,#262626);">' +
        '<div style="width:92px;flex-shrink:0;font-size:11px;text-transform:uppercase;letter-spacing:0.4px;color:var(--text-dim,#888);padding-top:1px;">' + escapeHTML(label) + '</div>' +
        '<div style="flex:1;font-size:13px;color:var(--text,#e6e6e6);line-height:1.5;">' + val + '</div>' +
      '</div>';
    }

    var modal = document.createElement('div');
    modal.id = 'schEntryCard';
    modal.className = 'modal active';
    modal.innerHTML =
      '<div class="modal-content" style="max-width:440px;border-left:4px solid ' + color + ';">' +
        '<div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:8px;">' +
          '<div style="flex:1;min-width:0;">' +
            '<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:' + color + ';font-weight:700;margin-bottom:3px;">Schedule entry</div>' +
            '<div style="font-size:17px;font-weight:700;color:var(--text,#fff);line-height:1.25;">' + escapeHTML(jobLabel(job)) + '</div>' +
            '<div style="margin-top:6px;"><span style="font-size:11px;font-weight:600;text-transform:capitalize;color:' + color + ';background:rgba(255,255,255,0.06);border:1px solid ' + color + ';border-radius:10px;padding:2px 10px;">' + escapeHTML(statusLabel) + '</span></div>' +
          '</div>' +
          '<button type="button" class="sch-btn sch-btn-primary" id="schCardEdit">Edit</button>' +
          '<button type="button" class="sch-btn sch-btn-icon" id="schCardClose" title="Close">✕</button>' +
        '</div>' +
        row('When', escapeHTML(when)) +
        row('Production', dayCount + ' day' + (dayCount === 1 ? '' : 's')) +
        row('Crew', crew.length ? crew.map(escapeHTML).join(', ') : '<span style="color:var(--text-dim,#888);">No crew assigned</span>') +
        row('Notes', entry.notes ? escapeHTML(entry.notes) : '') +
      '</div>';
    document.body.appendChild(modal);
    function close() { modal.remove(); }
    modal.querySelector('#schCardClose').addEventListener('click', close);
    modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
    modal.querySelector('#schCardEdit').addEventListener('click', function () {
      close();
      openEntryEditor(entry, entry.startDate, entry.jobId);
    });
  }

  // ── Slice C: read-only "live card" for a personal event ─────
  // Mirrors openEntryCard's structure/scaffolding — left accent border
  // in the event color, an "Event" eyebrow, the title, a status chip,
  // and rows for When / Location / Notes. Top-right Edit + close.
  var EVENT_DEFAULT_COLOR = '#6366f1';
  function openEventCard(event) {
    if (!event) return;
    var color = event.color || EVENT_DEFAULT_COLOR;
    var sd = parseISODate(event.starts_at);
    var ed = parseISODate(event.ends_at);
    // Compose the When line. All-day → "All day"; timed → a local
    // time range. Multi-day events show the end date too.
    var whenVal = '';
    if (sd) {
      var startDateLabel = fmtCardDate(sd);
      if (event.all_day) {
        whenVal = startDateLabel + (ed && toISODate(ed) !== toISODate(sd) ? '  →  ' + fmtCardDate(ed) : '') + ' · All day';
      } else {
        var startTime = fmtEventTime(event.starts_at);
        var endTime = event.ends_at ? fmtEventTime(event.ends_at) : '';
        var sameDay = !ed || toISODate(ed) === toISODate(sd);
        if (sameDay) {
          whenVal = startDateLabel + ' · ' + startTime + (endTime ? '–' + endTime : '');
        } else {
          whenVal = startDateLabel + ' ' + startTime + '  →  ' + fmtCardDate(ed) + (endTime ? ' ' + endTime : '');
        }
      }
    }
    var statusLabel = (event.status || 'confirmed');

    function row(label, val) {
      if (!val) return '';
      return '<div style="display:flex;gap:12px;padding:9px 0;border-top:1px solid var(--border,#262626);">' +
        '<div style="width:92px;flex-shrink:0;font-size:11px;text-transform:uppercase;letter-spacing:0.4px;color:var(--text-dim,#888);padding-top:1px;">' + escapeHTML(label) + '</div>' +
        '<div style="flex:1;font-size:13px;color:var(--text,#e6e6e6);line-height:1.5;">' + val + '</div>' +
      '</div>';
    }

    var modal = document.createElement('div');
    modal.id = 'schEventCard';
    modal.className = 'modal active';
    modal.innerHTML =
      '<div class="modal-content" style="max-width:440px;border-left:4px solid ' + escapeAttr(color) + ';">' +
        '<div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:8px;">' +
          '<div style="flex:1;min-width:0;">' +
            '<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:' + escapeAttr(color) + ';font-weight:700;margin-bottom:3px;">Event</div>' +
            '<div style="font-size:17px;font-weight:700;color:var(--text,#fff);line-height:1.25;">' + escapeHTML(event.title || '(untitled event)') + '</div>' +
            '<div style="margin-top:6px;"><span style="font-size:11px;font-weight:600;text-transform:capitalize;color:' + escapeAttr(color) + ';background:rgba(255,255,255,0.06);border:1px solid ' + escapeAttr(color) + ';border-radius:10px;padding:2px 10px;">' + escapeHTML(statusLabel) + '</span></div>' +
          '</div>' +
          '<button type="button" class="sch-btn sch-btn-primary" id="schEventCardEdit">Edit</button>' +
          '<button type="button" class="sch-btn sch-btn-icon" id="schEventCardClose" title="Close">✕</button>' +
        '</div>' +
        row('When', escapeHTML(whenVal)) +
        row('Location', event.location ? escapeHTML(event.location) : '') +
        row('Notes', event.notes ? escapeHTML(event.notes) : '') +
      '</div>';
    document.body.appendChild(modal);
    function close() { modal.remove(); }
    modal.querySelector('#schEventCardClose').addEventListener('click', close);
    modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
    modal.querySelector('#schEventCardEdit').addEventListener('click', function () {
      close();
      openEventEditor(event);
    });
  }

  // ── Slice C: event editor (create / edit) ───────────────────
  // A self-contained modal mirroring openEntryEditor's flow. Fields:
  // Title, All-day, Date, Start/End time (hidden when all-day),
  // Location, Notes, Status. Save composes starts_at/ends_at as ISO
  // and calls create or update; Delete removes; both refetch + repaint.
  // Linked-record picker data source — the calendar's LINK_TYPES
  // (client/job/lead/project, matching server calendar-routes.js). Cached
  // per type for the life of the page so toggling the type select is
  // instant after the first load.
  var _linkOptCache = {};
  function loadEntList(type) {
    if (_linkOptCache[type]) return Promise.resolve(_linkOptCache[type]);
    var api = window.p86Api;
    if (!api) return Promise.resolve([]);
    var p;
    if (type === 'client')      p = api.clients.list().then(function(r) { return (r && r.clients) || []; });
    else if (type === 'job')    p = api.jobs.list().then(function(r) { return (r && r.jobs) || []; });
    else if (type === 'lead')   p = api.leads.list().then(function(r) { return (r && r.leads) || []; });
    else if (type === 'project') p = api.projects.list().then(function(r) { return (r && r.projects) || []; });
    else return Promise.resolve([]);
    return p.then(function(list) { _linkOptCache[type] = list; return list; })
            .catch(function() { return []; });
  }
  // Mirror server entity-labels.js: jobs prefix [jobNumber], leads use
  // title, clients/projects use name.
  function entOptionLabel(type, it) {
    if (type === 'job') { var n = it.jobNumber ? '[' + it.jobNumber + '] ' : ''; return n + (it.title || it.name || 'Job'); }
    if (type === 'lead') return it.title || '(untitled lead)';
    return it.name || it.title || '(unnamed)';
  }

  // opts (optional):
  //   prefillEntity: { type, id, label } — on CREATE, preselect this
  //     record (client|job|lead|project) in the link picker. The user can
  //     still change or clear it.
  //   onSaved / onDeleted: callbacks fired after a successful mutation so
  //     a caller outside the schedule page (e.g. an entity panel) can
  //     refresh its own list. When absent we fall back to refreshing the
  //     schedule grid, guarded so it no-ops when the grid isn't mounted.
  function openEventEditor(eventOrNull, prefillDateISO, opts) {
    opts = opts || {};
    var event = eventOrNull || null;
    var isEdit = !!event;
    // Prefer the prefill link on create; on edit, reflect the event's link.
    var linkEntity = isEdit
      ? (event.entity_type && event.entity_id
          ? { type: event.entity_type, id: event.entity_id, label: event.entity_label || '' }
          : null)
      : (opts.prefillEntity && opts.prefillEntity.type && opts.prefillEntity.id ? opts.prefillEntity : null);
    var prior = document.getElementById('schEventEditorModal');
    if (prior) prior.remove();

    var sd = event && event.starts_at ? new Date(event.starts_at) : null;
    var ed = event && event.ends_at ? new Date(event.ends_at) : null;
    var allDay = !!(event && event.all_day);
    var dateVal = (sd && !isNaN(sd.getTime())) ? toISODate(sd) : (prefillDateISO || toISODate(new Date()));
    // Time inputs want HH:MM (24h). Derive from the event's local time.
    function toTimeInput(d) {
      if (!d || isNaN(d.getTime())) return '';
      var h = d.getHours(), m = d.getMinutes();
      return (h < 10 ? '0' + h : h) + ':' + (m < 10 ? '0' + m : m);
    }
    var startTimeVal = (!allDay && sd) ? toTimeInput(sd) : '09:00';
    var endTimeVal = (!allDay && ed) ? toTimeInput(ed) : '10:00';
    var title = (event && event.title) || '';
    var location = (event && event.location) || '';
    var notes = (event && event.notes) || '';
    var status = (event && event.status) || 'confirmed';

    var modal = document.createElement('div');
    modal.id = 'schEventEditorModal';
    modal.className = 'modal active';
    modal.innerHTML =
      '<div class="modal-content" style="max-width:560px;">' +
        '<div class="modal-header">' + (isEdit ? 'Edit event' : 'New event') + '</div>' +
        '<div class="sch-modal-form">' +
          '<div>' +
            '<label>Title</label>' +
            '<input type="text" id="schEventTitle" value="' + escapeAttr(title) + '" placeholder="Event title" />' +
          '</div>' +
          '<div title="All-day events span whole days and ignore start / end times.">' +
            '<label class="p86-check-row">' +
              '<input type="checkbox" id="schEventAllDay" ' + (allDay ? 'checked' : '') + ' />' +
              '<span>All-day event</span>' +
            '</label>' +
          '</div>' +
          '<div class="sch-modal-row">' +
            '<div>' +
              '<label>Date</label>' +
              '<input type="date" id="schEventDate" value="' + escapeAttr(dateVal) + '" />' +
            '</div>' +
            '<div id="schEventTimeWrap" class="sch-modal-row" style="gap:8px;' + (allDay ? 'display:none;' : '') + '">' +
              '<div>' +
                '<label>Start</label>' +
                '<input type="time" id="schEventStart" value="' + escapeAttr(startTimeVal) + '" ' + (allDay ? 'disabled' : '') + ' />' +
              '</div>' +
              '<div>' +
                '<label>End</label>' +
                '<input type="time" id="schEventEnd" value="' + escapeAttr(endTimeVal) + '" ' + (allDay ? 'disabled' : '') + ' />' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div>' +
            '<label>Location</label>' +
            '<input type="text" id="schEventLocation" value="' + escapeAttr(location) + '" placeholder="Optional" />' +
          '</div>' +
          '<div>' +
            '<label>Notes</label>' +
            '<textarea id="schEventNotes" rows="2">' + escapeHTML(notes) + '</textarea>' +
          '</div>' +
          '<div>' +
            '<label>Status</label>' +
            '<select id="schEventStatus">' +
              ['confirmed','tentative','canceled'].map(function(s) {
                return '<option value="' + s + '"' + (s === status ? ' selected' : '') + '>' + s + '</option>';
              }).join('') +
            '</select>' +
          '</div>' +
          '<div>' +
            '<label>Linked to <span style="font-weight:400;color:var(--text-dim,#888);">(optional — client, job, lead, or project)</span></label>' +
            '<div class="sch-link-picker">' +
              '<select id="schEventLinkType">' +
                '<option value="">— None —</option>' +
                '<option value="client">Client</option>' +
                '<option value="job">Job</option>' +
                '<option value="lead">Lead</option>' +
                '<option value="project">Project</option>' +
              '</select>' +
              '<select id="schEventLinkId" style="display:none;"></select>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="modal-footer" style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">' +
          (isEdit ? '<button class="sch-btn" id="schEventDelete" style="margin-right:auto;color:#f87171;border-color:rgba(248,113,113,0.4);">Delete</button>' : '') +
          '<button class="sch-btn" id="schEventCancel">Cancel</button>' +
          '<button class="sch-btn sch-btn-primary" id="schEventSave">' + (isEdit ? 'Save' : 'Create') + '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);

    function close() { modal.remove(); }
    modal.querySelector('#schEventCancel').addEventListener('click', close);
    modal.addEventListener('click', function(e) { if (e.target === modal) close(); });

    // Toggle the time inputs in/out as all-day flips.
    var allDayEl = modal.querySelector('#schEventAllDay');
    var timeWrap = modal.querySelector('#schEventTimeWrap');
    var startEl = modal.querySelector('#schEventStart');
    var endEl = modal.querySelector('#schEventEnd');
    allDayEl.addEventListener('change', function() {
      var on = allDayEl.checked;
      if (timeWrap) timeWrap.style.display = on ? 'none' : '';
      if (startEl) startEl.disabled = on;
      if (endEl) endEl.disabled = on;
    });

    // ── Linked-record picker ───────────────────────────────────
    // Type select drives a lazily-loaded record select. Preselected to
    // the event's existing link (edit) or the prefill entity (create from
    // a client/job page). Empty type → no link (cleared on save).
    var linkTypeEl = modal.querySelector('#schEventLinkType');
    var linkIdEl = modal.querySelector('#schEventLinkId');
    function fillLinkOptions(type, selectedId) {
      if (!linkIdEl) return;
      if (!type) { linkIdEl.style.display = 'none'; linkIdEl.innerHTML = ''; return; }
      linkIdEl.style.display = '';
      linkIdEl.innerHTML = '<option value="">Loading…</option>';
      loadEntList(type).then(function(items) {
        var opts = ['<option value="">— Select a ' + type + ' —</option>'];
        items.forEach(function(it) {
          var sel = (selectedId != null && String(it.id) === String(selectedId)) ? ' selected' : '';
          opts.push('<option value="' + escapeAttr(String(it.id)) + '"' + sel + '>' + escapeHTML(entOptionLabel(type, it)) + '</option>');
        });
        linkIdEl.innerHTML = opts.join('');
      }).catch(function() {
        linkIdEl.innerHTML = '<option value="">(could not load ' + escapeHTML(type) + 's)</option>';
      });
    }
    if (linkTypeEl) {
      if (linkEntity && linkEntity.type) {
        linkTypeEl.value = linkEntity.type;
        fillLinkOptions(linkEntity.type, linkEntity.id);
      }
      linkTypeEl.addEventListener('change', function() { fillLinkOptions(linkTypeEl.value, null); });
    }

    function setBusy(busy) {
      modal.querySelectorAll('button').forEach(function(b) { b.disabled = !!busy; });
      var saveBtn = modal.querySelector('#schEventSave');
      if (saveBtn) saveBtn.textContent = busy ? '…' : (isEdit ? 'Save' : 'Create');
    }

    // Compose a local Date from a YYYY-MM-DD date string + HH:MM time
    // string. Returns a Date in local time (so .toISOString() carries
    // the correct UTC offset for the user's timezone).
    function composeLocal(dateStr, timeStr) {
      var dm = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (!dm) return null;
      var hh = 0, mm = 0;
      var tm = String(timeStr || '').match(/^(\d{1,2}):(\d{2})/);
      if (tm) { hh = +tm[1]; mm = +tm[2]; }
      return new Date(+dm[1], +dm[2] - 1, +dm[3], hh, mm, 0, 0);
    }

    var del = modal.querySelector('#schEventDelete');
    if (del) {
      del.addEventListener('click', function() {
        if (!event) return;
        var goDelete = (typeof window.p86Confirm === 'function')
          ? window.p86Confirm({
              title: 'Delete event',
              message: 'Delete this event? This cannot be undone.',
              confirmLabel: 'Delete',
              danger: true
            })
          : Promise.resolve(window.confirm('Delete this event?'));
        goDelete.then(function(ok) {
          if (!ok) return;
          setBusy(true);
          var p = (isCalendarApiReady() && event.id)
            ? window.p86Api.calendar.remove(event.id)
            : Promise.resolve();
          p.then(function() {
            close();
            if (opts.onSaved) { try { opts.onSaved(); } catch (e) {} }
            fetchEvents().then(renderGrid);
          }).catch(function(err) {
            setBusy(false);
            if (typeof window.p86Alert === 'function') {
              window.p86Alert({ title: 'Delete failed', message: (err && err.message) || String(err) });
            } else {
              alert('Delete failed: ' + ((err && err.message) || err));
            }
          });
        });
      });
    }

    modal.querySelector('#schEventSave').addEventListener('click', function() {
      var t = (modal.querySelector('#schEventTitle').value || '').trim();
      var dateStr = modal.querySelector('#schEventDate').value;
      var isAllDay = modal.querySelector('#schEventAllDay').checked;
      // Require a title OR a date; alert when a date is missing (the
      // grid needs at least a date to place the event).
      if (!t && !dateStr) { alert('Add a title or a date.'); return; }
      if (!dateStr) { alert('Pick a date.'); return; }
      var startsAt, endsAt;
      if (isAllDay) {
        // All-day → local midnight on the date. ends_at left null
        // (single-day all-day event).
        var startD = composeLocal(dateStr, '00:00');
        startsAt = startD ? startD.toISOString() : null;
        endsAt = null;
      } else {
        var st = modal.querySelector('#schEventStart').value || '00:00';
        var et = modal.querySelector('#schEventEnd').value || '';
        var sD = composeLocal(dateStr, st);
        startsAt = sD ? sD.toISOString() : null;
        if (et) {
          var eD = composeLocal(dateStr, et);
          endsAt = eD ? eD.toISOString() : null;
        } else {
          endsAt = null;
        }
      }
      var payload = {
        title: t || '(untitled event)',
        starts_at: startsAt,
        ends_at: endsAt,
        all_day: isAllDay,
        location: (modal.querySelector('#schEventLocation').value || '').trim(),
        notes: modal.querySelector('#schEventNotes').value || '',
        status: modal.querySelector('#schEventStatus').value || 'confirmed'
      };
      // Linked record from the picker — always sent so an edit can set,
      // change, or clear the link. Empty type clears it; the server stores
      // both columns or neither.
      var lpType = (modal.querySelector('#schEventLinkType') || {}).value || '';
      var lpId = (modal.querySelector('#schEventLinkId') || {}).value || '';
      if (lpType && lpId) { payload.entity_type = lpType; payload.entity_id = lpId; }
      else { payload.entity_type = null; payload.entity_id = null; }

      if (!isCalendarApiReady()) {
        // No api → can't persist. Surface a soft notice and bail
        // rather than silently dropping the user's input.
        if (typeof window.p86Alert === 'function') {
          window.p86Alert({ title: 'Offline', message: 'Calendar is unavailable right now — event not saved.' });
        } else {
          alert('Calendar is unavailable right now — event not saved.');
        }
        return;
      }
      setBusy(true);
      var req = (isEdit && event && event.id)
        ? window.p86Api.calendar.update(event.id, payload)
        : window.p86Api.calendar.create(payload);
      req.then(function() {
        close();
        if (opts.onSaved) { try { opts.onSaved(); } catch (e) {} }
        fetchEvents().then(renderGrid);
      }).catch(function(err) {
        setBusy(false);
        alert('Save failed: ' + ((err && err.message) || err));
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
  // week (driven by _state.settings.focusWeekStart); unpinned = always
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
        if (nowPinned && !_state.settings.focusWeekStart) {
          _state.settings.focusWeekStart = toISODate(startOfWeek(new Date()));
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
    if (_state.settings.weekSummaryPinned && _state.settings.focusWeekStart) {
      var picked = parseISODate(_state.settings.focusWeekStart);
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
      var iconSVG = weatherIconSVG(d);
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
        '<div class="' + iconClass + '">' + iconSVG + '</div>' +
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
  // Personal calendar event editor — reusable from entity pages (the
  // Appointments subsection's "+ Add" and row-click both call this).
  // openEventEditor(eventOrNull, prefillDateISO, { prefillEntity, onSaved }).
  window.p86Schedule = window.p86Schedule || {};
  window.p86Schedule.openEventEditor = openEventEditor;
  // Surface the job-detail widget so wip.js (and any other module
  // that wants a per-job forecast) can drop it into a container.
  window.p86Weather = {
    renderJobWidget: renderJobWeatherWidget
  };
})();
