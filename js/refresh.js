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
    if (explicit) out[String(explicit)] = true;
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
  function repaintJobMoney(jobs) {
    call('renderJobsMain');
    call('p86JobsHubRefresh');
    var cur = window.appState && window.appState.currentJobId;
    if (!cur) return;
    if (jobs.length && jobs.indexOf(String(cur)) === -1) return;   // a different job changed
    call('p86RepaintJobMoneyTabs', [String(cur)]);
    call('p86JobDetailRefresh', [String(cur)]);   // latch-gated; no-ops for human edits
  }

  var APPDATA_ENTRY = { bucket: 'appdata', store: function () { reloadAppData(); } };

  /* ── the table ─────────────────────────────────────────────────────────
   * `bucket` groups types that MUST NOT run concurrently (see note 2).
   * `store` patches the read-cache and may return a promise.
   * `surface` repaints, and always runs AFTER store settles. */
  var ENTRIES = {
    // Jobs and estimates are the appData half. p86ReloadAllData patches the
    // store AND fans out the renderers, so it is both halves at once.
    // They share the SAME entry OBJECT, not merely the same bucket name and
    // the same function: runBucket de-dupes on entry identity, so two distinct
    // entries pointing at one reload still ran it twice — which is precisely
    // the concurrent hydrate this is here to prevent.
    job:      APPDATA_ENTRY,
    estimate: APPDATA_ENTRY,

    lead:   { surface: function () { call('reloadLeadsCache'); } },
    client: { surface: function () { call('reloadClientsCache'); } },
    sub:    { surface: function () { call('p86Subs.refresh'); } },

    po: {
      store:   function (ids, o) { return loadAll('loadPurchaseOrdersForJob', jobIdsFor('jobPurchaseOrders', ids, o.jobId)); },
      surface: function (ids, o) { repaintJobMoney(jobIdsFor('jobPurchaseOrders', ids, o.jobId)); }
    },
    co: {
      store:   function (ids, o) { return loadAll('loadChangeOrdersForJob', jobIdsFor('jobChangeOrders', ids, o.jobId)); },
      surface: function (ids, o) { repaintJobMoney(jobIdsFor('jobChangeOrders', ids, o.jobId)); }
    },
    bill: {
      store:   function (ids, o) { return loadAll('loadBillsForJob', jobIdsFor('jobVendorBills', ids, o.jobId)); },
      surface: function (ids, o) { repaintJobMoney(jobIdsFor('jobVendorBills', ids, o.jobId)); }
    },
    invoice: {
      store:   function () { return call('p86InvoicesSyncStore'); },
      surface: function (ids, o) { repaintJobMoney(jobIdsFor('arInvoices', ids, o.jobId)); }
    },
    // Receipts have no client store at all — mountRollup re-fetches on every
    // call. The whole gap was that nothing re-called it.
    receipt: { surface: function () { call('p86RemountReceiptRollups'); } },

    task:           { bucket: 'tasks', surface: refreshTaskSurfaces },
    todo:           { bucket: 'tasks', surface: refreshTaskSurfaces },
    reminder:       { bucket: 'tasks', surface: refreshTaskSurfaces },
    calendar_event: { bucket: 'tasks', surface: refreshTaskSurfaces },
    schedule:       { bucket: 'tasks', surface: refreshTaskSurfaces },

    project: { surface: function () { call('p86Projects.refresh'); } },
    report:  { surface: function () { call('p86Reports.refresh'); } }
  };

  // Tasks, to-dos, reminders and calendar events all land on the same four
  // surfaces, so they share a bucket: ticking three punch-list items in a row
  // repaints once, not three times.
  function refreshTaskSurfaces() {
    call('p86Tasks.refresh');
    call('p86MyDay.render');
    call('renderSchedule');
    call('renderSummaryDashboard');
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
    var types = Object.keys(b.types), ids = Object.keys(b.ids), opts = b.opts;
    b.types = Object.create(null); b.ids = Object.create(null); b.opts = {};

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
    var b = _buckets[key] || (_buckets[key] = { types: Object.create(null), ids: Object.create(null), opts: {}, timer: null });
    b.types[type] = true;
    if (opts && opts.id != null) b.ids[String(opts.id)] = true;
    if (opts && opts.jobId != null) b.opts.jobId = opts.jobId;
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
