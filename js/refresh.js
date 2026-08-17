/* ──────────────────────────────────────────────────────────────────────────
 * js/refresh.js — window.p86Refresh(type, opts)
 *
 * THE refresh heartbeat. One place that answers: "row X of type T just
 * changed — make every surface that shows it tell the truth."
 *
 * WHY THIS EXISTS
 * P86 renders from imperative render*() functions over a global `appData`
 * that is loaded ONCE at boot. Persisting a change never refreshes anything.
 * So every mutation has to do TWO separate things:
 *   (a) patch the boot read-cache (the "store"), and
 *   (b) repaint whatever is on screen (the "surface").
 * Doing only (a) leaves a stale screen. Doing only (b) repaints from a stale
 * cache and shows the OLD number again — which reads as "it didn't save".
 * That pairing is the entire bug class, so this module makes it the SHAPE of
 * a refresh rather than a thing each of ~40 call sites has to remember.
 *
 * WHY A REGISTRY AND NOT A BROADCAST EVENT
 * Three behaviours are only correct if they are enforced in ONE place:
 *
 *   1. Coalescing is TYPE-FIRST, never per-id. The AI poller synthesises one
 *      target per changed ROW, so a 40-line estimate rewrite arrives as 40
 *      targets. Per-id dispatch would run 40 refreshes — and for job/estimate
 *      that means 40 full appData hydrates.
 *
 *   2. Never start a hydrate while one is in flight. loadData() has NO
 *      re-entrancy guard and its first act is to re-seed appData from the
 *      localStorage cache, so a second concurrent load can put STALE rows
 *      back into memory. `job` and `estimate` therefore share ONE bucket:
 *      a payload touching both can never fan out into two loads.
 *
 *   3. Never repaint a container that holds the caret. Re-rendering an open
 *      editor mid-typing destroys the row being typed into. This is why the
 *      old setTimeout() repaints were removed, and it must not come back.
 *
 * A general "something changed" event gives notification a home and gives
 * the store-patch none — which is the half that was actually missing.
 *
 * ADDING A TYPE: add an ENTRY below with `store` and `surface`. Both are
 * optional but at least one of them is the point; an entry with only a
 * surface is a bug waiting to happen unless that type genuinely has no
 * read-cache. Everything is looked up off `window` at CALL time, so this
 * file has no load-order requirements.
 * ────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var COALESCE_MS = 200;      // one window per bucket; see note 1 above
  var HYDRATE_WAIT_MS = 250;  // poll cadence while an appData load is in flight
  var HYDRATE_MAX_WAIT = 40;  // ~10s ceiling so a wedged flag can't spin forever

  function warn(what, e) { try { console.warn('[p86Refresh] ' + what + ' failed:', e); } catch (_) {} }
  function fn(path) {
    // Resolve "a.b.c" off window at call time and return it only if callable.
    var parts = String(path).split('.'), cur = window, i;
    for (i = 0; i < parts.length; i++) { if (!cur) return null; cur = cur[parts[i]]; }
    return typeof cur === 'function' ? cur : null;
  }
  function call(path, args) {
    var f = fn(path);
    if (!f) return undefined;
    try { return f.apply(null, args || []); } catch (e) { warn(path, e); }
  }

  /* ── the typing guard ──────────────────────────────────────────────────
   * True when the caret is inside `el`. A refresh must SKIP such a
   * container — repainting it drops whatever is half-typed. Callers that
   * skip should leave their "needs repaint" latch SET so the next
   * opportunity picks it up; dropping the latch trades a flicker for a
   * permanently stale screen. */
  function isTyping(el) {
    try {
      var ae = document.activeElement;
      if (!ae || !el) return false;
      var t = ae.tagName;
      if (t !== 'INPUT' && t !== 'TEXTAREA' && t !== 'SELECT' && !ae.isContentEditable) return false;
      return el === ae || (el.contains && el.contains(ae));
    } catch (e) { return false; }
  }
  function isTypingIn(sel) {
    var el = null;
    try { el = document.querySelector(sel); } catch (e) { return false; }
    return isTyping(el);
  }

  /* ── appData hydrate: serialised, never concurrent ────────────────────── */
  var _hydrateQueued = false, _hydrateTimer = null, _hydrateTicks = 0;
  function reloadAppData(force) {
    if (!fn('p86ReloadAllData')) return;
    var loading = fn('p86DataLoading');
    if (!force && loading && loading()) {
      // A hydrate is already running. Starting a second one is the documented
      // clobber path (it re-seeds from localStorage first), so we remember and
      // run after — rather than racing it or silently dropping the request.
      _hydrateQueued = true;
      if (_hydrateTimer) return;
      _hydrateTicks = 0;
      _hydrateTimer = setInterval(function () {
        var busy = fn('p86DataLoading');
        var wedged = ++_hydrateTicks >= HYDRATE_MAX_WAIT;
        if (busy && busy() && !wedged) return;
        clearInterval(_hydrateTimer); _hydrateTimer = null;
        // `wedged` is passed through as `force`. Without it, re-entering here
        // with the flag still stuck true would just queue another wait, and
        // the refresh would never run at all — a wedged flag would silently
        // disable the entire appData half rather than degrading to one
        // possibly-redundant reload.
        if (_hydrateQueued) { _hydrateQueued = false; reloadAppData(wedged); }
      }, HYDRATE_WAIT_MS);
      return;
    }
    call('p86ReloadAllData');
  }

  /* ── shared helpers ────────────────────────────────────────────────────
   * Money mirrors (jobPurchaseOrders / jobChangeOrders / jobVendorBills) are
   * per-job. Resolving which job a row belongs to, in order: what the caller
   * told us, then the mirror we already hold, then the job on screen. If all
   * three miss (a brand-new row on a job that isn't open and isn't cached)
   * the store patch is skipped and only the surface repaints — the list will
   * be right on its next natural load. Documented rather than papered over. */
  function jobIdsFor(mirror, ids, explicit) {
    var out = {};
    // `explicit` is EVERY jobId the coalesced window collected, not just the
    // last one. A bulk status change across three jobs used to arrive as three
    // p86Refresh calls that overwrote a single opts.jobId, so two of the three
    // jobs never had their store patched — while the surface repainted and
    // reported success for all three.
    (Array.isArray(explicit) ? explicit : (explicit != null ? [explicit] : []))
      .forEach(function (j) { if (j != null) out[String(j)] = true; });
    var rows = (window.appData && window.appData[mirror]) || [];
    (ids || []).forEach(function (id) {
      for (var i = 0; i < rows.length; i++) {
        if (String(rows[i].id) === String(id) && rows[i].job_id) { out[String(rows[i].job_id)] = true; return; }
      }
    });
    if (!Object.keys(out).length) {
      var cur = window.appState && window.appState.currentJobId;
      if (cur) out[String(cur)] = true;
    }
    return Object.keys(out);
  }
  // Every load*ForJob is in-flight deduped per job. A refresh fired right
  // after a write must NOT join a GET that was issued BEFORE it — that
  // returns pre-write rows and then reports success. `true` forces a fresh
  // fetch; see the `force` argument in js/jobs.js.
  function loadAll(loader, jobs) {
    var f = fn(loader);
    if (!f) return Promise.resolve();
    return Promise.all((jobs || []).map(function (j) {
      try { return Promise.resolve(f(j, true)); } catch (e) { warn(loader, e); return Promise.resolve(); }
    }));
  }
  // PO / CO / bill / invoice all move the same three surfaces: the jobs-list
  // money tiles, the cross-job hub list, and the open job's own money sections.
  // Doing all three HERE is what lets the ~10 mutation sites be a single
  // p86Refresh(...) line instead of each remembering the full set — and what
  // stops two of them accidentally both refreshing the same thing.
  //
  // NO MUTATION SITE MAY REFRESH THE HUB ITSELF. Mutation sites used to call
  // p86JobsHubRefresh() AND THEN p86Refresh(...), so one edit ran two hub
  // refetches and two repaints — the exact defect the registry was built to
  // remove, reintroduced one layer up. This is the one place that decides what
  // a money write repaints.
  //
  // js/jobs-hub.js is the single exception, and only because it OWNS the
  // function: it publishes window.p86JobsHubRefresh, and its own bill editor
  // reloads the list it just wrote to. That path does not also fire
  // p86Refresh, so a write is never refreshed from both.
  //
  // ENFORCED, NOT REMEMBERED. test/refresh-registry.test.js scans EVERY file
  // in js/ and fails on a call outside those two. The earlier version of that
  // test named two editor files by hand — and a third call site, in
  // estimate-editor.js, sat outside the list untouched for a whole release.
  // That is what "an invariant enforced by enumerating call sites will leak"
  // looks like, so the check is a scan now and must stay one.
  var REPAINT_JOB_MONEY_PATHS = [
    'renderJobsMain', 'p86JobsHubRefresh', 'p86JobDetailRefresh', 'p86RepaintJobMoneyTabs'
  ];
  var TASK_PATHS = ['p86Tasks.refresh', 'p86MyDay.render', 'renderSchedule', 'renderSummaryDashboard'];
  function repaintJobMoney(jobs) {
    call('renderJobsMain');
    call('p86JobsHubRefresh');
    var cur = window.appState && window.appState.currentJobId;
    if (!cur) return;
    if (jobs.length && jobs.indexOf(String(cur)) === -1) return;   // a different job changed
    // p86JobDetailRefresh re-renders the WHOLE job detail, which is a strict
    // superset of the money sections — so running both painted every money
    // section twice. It is latch-gated (a background write sets the latch; a
    // human edit does not) and returns true only when it actually rendered,
    // which is the signal to skip the narrow repaint.
    if (call('p86JobDetailRefresh', [String(cur)]) === true) return;
    call('p86RepaintJobMoneyTabs', [String(cur)]);
  }

  var APPDATA_ENTRY = {
    bucket: 'appdata',
    store: function () { reloadAppData(); },
    paths: ['p86ReloadAllData', 'p86DataLoading']
  };

  // Build a surface from a list of dotted paths, so the declared `paths` and
  // the code that runs CANNOT drift apart. Entries whose surface is
  // conditional declare `paths` by hand; p86Refresh.paths() exposes the list
  // and a test asserts every one of them is actually published by a module.
  // (`window.p86Reports.refresh` sat in this table for a whole release
  // pointing at a namespace that does not exist anywhere in the codebase —
  // a surface reporting that it refreshed something it never touched.)
  function callPaths(paths) {
    return function () { paths.forEach(function (p) { call(p); }); };
  }
  function surfaceEntry(paths, extra) {
    var e = extra || {};
    e.paths = paths;
    e.surface = callPaths(paths);
    return e;
  }

  /* ── the table ─────────────────────────────────────────────────────────
   * `bucket` groups types that MUST NOT run concurrently (see note 2).
   * `store` patches the read-cache and may return a promise.
   * `surface` repaints, and always runs AFTER store settles.
   * `paths` lists every dotted window path the entry can call.
   *
   * REACHABILITY IS PART OF THE CONTRACT, IN BOTH DIRECTIONS.
   *
   *   registry → door: a type only belongs here if something can actually
   *   emit it — the payload dispatcher's affected_targets vocabulary or a
   *   direct p86Refresh() call site in js/ (po, co, bill, invoice, receipt).
   *   `sub` and `project` were removed because neither door produced them; an
   *   entry nothing can reach is a claim of coverage that is never true.
   *
   *   door → registry: every entity type the SERVER dispatcher can emit must
   *   have an entry here, or be named in the test's meta-exclusion list with
   *   a reason. This half was missing, and `assembly` slipped through a sweep
   *   whose stated goal was "everywhere" — an agent could write a recipe and
   *   no surface moved. Both directions are tested against the real sources
   *   (js/ for one, server/services/payload-dispatcher.js for the other), so
   *   adding a dispatcher target with no plan for the screen fails the suite
   *   rather than shipping quiet. */
  var ENTRIES = {
    // Jobs and estimates are the appData half. p86ReloadAllData patches the
    // store AND fans out the renderers, so it is both halves at once.
    // They share the SAME entry OBJECT, not merely the same bucket name and
    // the same function: runBucket de-dupes on entry identity, so two distinct
    // entries pointing at one reload still ran it twice — which is precisely
    // the concurrent hydrate this is here to prevent.
    job:      APPDATA_ENTRY,
    estimate: APPDATA_ENTRY,

    lead:   surfaceEntry(['reloadLeadsCache']),
    client: surfaceEntry(['reloadClientsCache']),

    po: {
      paths:   ['loadPurchaseOrdersForJob'].concat(REPAINT_JOB_MONEY_PATHS),
      store:   function (ids, o) { return loadAll('loadPurchaseOrdersForJob', jobIdsFor('jobPurchaseOrders', ids, o.jobIds)); },
      surface: function (ids, o) { repaintJobMoney(jobIdsFor('jobPurchaseOrders', ids, o.jobIds)); }
    },
    co: {
      paths:   ['loadChangeOrdersForJob'].concat(REPAINT_JOB_MONEY_PATHS),
      store:   function (ids, o) { return loadAll('loadChangeOrdersForJob', jobIdsFor('jobChangeOrders', ids, o.jobIds)); },
      surface: function (ids, o) { repaintJobMoney(jobIdsFor('jobChangeOrders', ids, o.jobIds)); }
    },
    bill: {
      paths:   ['loadBillsForJob'].concat(REPAINT_JOB_MONEY_PATHS),
      store:   function (ids, o) { return loadAll('loadBillsForJob', jobIdsFor('jobVendorBills', ids, o.jobIds)); },
      surface: function (ids, o) { repaintJobMoney(jobIdsFor('jobVendorBills', ids, o.jobIds)); }
    },
    // AR invoices. p86InvoicesSyncStore is the STORE half only — it refetches
    // /invoices and patches appData.arInvoices. It used to repaint the jobs
    // list itself as well, so the surface half here painted it a second time;
    // the repaint now belongs to this table alone. Reached from the three
    // invoice mutation sites in js/invoices.js (save / status / delete).
    invoice: {
      paths:   ['p86InvoicesSyncStore'].concat(REPAINT_JOB_MONEY_PATHS),
      store:   function () { return call('p86InvoicesSyncStore'); },
      surface: function (ids, o) { repaintJobMoney(jobIdsFor('arInvoices', ids, o.jobIds)); }
    },
    // Receipts have no client store at all — mountRollup re-fetches on every
    // call. The whole gap was that nothing re-called it.
    receipt: surfaceEntry(['p86RemountReceiptRollups']),

    // Cost assemblies (recipes). The dispatcher emits assembly create / update
    // / delete targets (payload-dispatcher.js, dispatchAssembly), and this
    // entry was missing entirely — so an agent building a recipe from a
    // research packet updated no list at all.
    //
    // p86Assemblies.renderList() is BOTH halves at once, like p86ReloadAllData:
    // it re-fetches /api/assemblies into the module's `_list` and then paints.
    // Called bare it keeps whatever host prefix and view filter are currently
    // active, so the one call covers all three hosts the recipe list can
    // render into — Assembly Studio → Assemblies, Assembly Studio → Parametric,
    // and the classic Estimates → Assemblies pane — and no-ops when none of
    // them is mounted. Declared as `store` because that is what it is; adding
    // a `surface` that repainted again would be the double this table exists
    // to prevent.
    //
    // Deliberately NOT wired here, each for a reason:
    //   · the Assembly Studio cockpit (research inbox + tuning queue) already
    //     has its own visibility-gated p86:payload-applied listener in
    //     js/console.js that calls loadResearchInbox + loadAssemblyTuning.
    //     Listing them here would refresh them TWICE per applied card.
    //   · the materials drawer re-fetches /api/assemblies on open and on every
    //     keystroke, so it holds no cache that can go stale.
    //   · the sheet-editor's parametric catalog is loaded per open and sits
    //     under a canvas being drawn on — note 3 above.
    assembly: {
      paths: ['p86Assemblies.renderList'],
      store: function () { return call('p86Assemblies.renderList'); }
    },

    task:           { bucket: 'tasks', paths: TASK_PATHS, surface: refreshTaskSurfaces },
    todo:           { bucket: 'tasks', paths: TASK_PATHS, surface: refreshTaskSurfaces },
    reminder:       { bucket: 'tasks', paths: TASK_PATHS, surface: refreshTaskSurfaces },
    calendar_event: { bucket: 'tasks', paths: TASK_PATHS, surface: refreshTaskSurfaces },
    schedule:       { bucket: 'tasks', paths: TASK_PATHS, surface: refreshTaskSurfaces },

    // Reports are polymorphic: the same row shows on a project's Reports tab
    // and on a job's. p86Projects.refreshReports refetches + repaints the
    // project tab; p86JobReportsRefresh does the job tab but REFUSES while its
    // editor is open, because renderJobReports() resets the pane to list mode
    // and would eat an in-progress draft.
    report: {
      paths: ['p86Projects.refreshReports', 'p86JobReportsRefresh'],
      surface: function () {
        call('p86Projects.refreshReports');
        var cur = window.appState && window.appState.currentJobId;
        if (cur) call('p86JobReportsRefresh', [String(cur)]);
      }
    }
  };

  // Tasks, to-dos, reminders and calendar events all land on the same four
  // surfaces, so they share a bucket: ticking three punch-list items in a row
  // repaints once, not three times.
  function refreshTaskSurfaces() {
    TASK_PATHS.forEach(function (p) { call(p); });
  }

  /* ── coalescing dispatcher ─────────────────────────────────────────────── */
  var _buckets = Object.create(null);

  function bucketKey(type) {
    var e = ENTRIES[type];
    return (e && e.bucket) || type;
  }

  function runBucket(key) {
    var b = _buckets[key];
    if (!b) return Promise.resolve();
    var types = Object.keys(b.types), ids = Object.keys(b.ids);
    var opts = { jobIds: Object.keys(b.jobIds) };
    b.types = Object.create(null); b.ids = Object.create(null); b.jobIds = Object.create(null);

    // One pass per distinct entry in the bucket. Types sharing a bucket AND
    // an entry function (task/todo/reminder) collapse to a single run.
    var seen = [], chain = Promise.resolve();
    types.forEach(function (t) {
      var e = ENTRIES[t];
      if (!e) return;
      if (seen.indexOf(e) !== -1) return;
      seen.push(e);
      chain = chain.then(function () {
        var stored;
        try { stored = e.store ? e.store(ids, opts) : undefined; } catch (err) { warn(t + '.store', err); }
        return Promise.resolve(stored).catch(function (err) { warn(t + '.store', err); });
      }).then(function () {
        // Surface ALWAYS runs after store settles. Repainting first is how a
        // "fixed" refresh still shows the old number.
        try { if (e.surface) e.surface(ids, opts); } catch (err) { warn(t + '.surface', err); }
      });
    });
    return chain;
  }

  function schedule(type, opts) {
    var key = bucketKey(type);
    var b = _buckets[key] || (_buckets[key] = { types: Object.create(null), ids: Object.create(null), jobIds: Object.create(null), timer: null });
    b.types[type] = true;
    if (opts && opts.id != null) b.ids[String(opts.id)] = true;
    // A SET, not last-wins: a bulk action fires one call per job into the same
    // coalescing window, and overwriting a single jobId silently dropped every
    // job but the last from the store patch.
    if (opts && opts.jobId != null) b.jobIds[String(opts.jobId)] = true;
    if (b.timer) return;                       // already queued — this is the coalesce
    b.timer = setTimeout(function () { b.timer = null; runBucket(key); }, COALESCE_MS);
  }

  /* ── public entry ──────────────────────────────────────────────────────── */
  function p86Refresh(type, opts) {
    if (!type) return;
    type = String(type);
    if (!ENTRIES[type]) return;   // unknown type is a no-op, never a throw
    schedule(type, opts || {});
  }

  // Payloads arrive through TWO doors — the client Approve and the applied
  // poller — and both can describe the same write. Dedupe on payload id here
  // as well as in the poller: a single missing field downstream would
  // otherwise turn every client apply into a second full hydrate.
  var _seenPayloads = Object.create(null);
  p86Refresh.fromTargets = function (targets, payloadId) {
    if (payloadId != null) {
      var k = String(payloadId);
      if (_seenPayloads[k]) return false;
      _seenPayloads[k] = true;
    }
    (targets || []).forEach(function (t) {
      if (t && t.entity_type) p86Refresh(t.entity_type, { id: t.entity_id, jobId: t.job_id });
    });
    return true;
  };

  p86Refresh.isTyping = isTyping;
  p86Refresh.isTypingIn = isTypingIn;
  p86Refresh.types = function () { return Object.keys(ENTRIES); };
  // Every dotted window path an entry can call. This is the seam a test uses
  // to assert that each one is actually PUBLISHED by a module — the check that
  // was missing when `report` pointed at `window.p86Reports`, a namespace that
  // exists nowhere in the codebase.
  p86Refresh.paths = function (type) {
    if (type) return ((ENTRIES[type] && ENTRIES[type].paths) || []).slice();
    var all = {};
    Object.keys(ENTRIES).forEach(function (t) {
      (ENTRIES[t].paths || []).forEach(function (p) { all[p] = true; });
    });
    return Object.keys(all);
  };
  // Test/debug seam: run every queued bucket now instead of on its timer.
  p86Refresh.flush = function () {
    return Promise.all(Object.keys(_buckets).map(function (k) {
      var b = _buckets[k];
      if (b.timer) { clearTimeout(b.timer); b.timer = null; }
      return runBucket(k);
    }));
  };

  window.p86Refresh = p86Refresh;
})();
