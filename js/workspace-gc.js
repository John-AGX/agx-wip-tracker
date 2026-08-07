// Workspace cache garbage collector — window.p86WorkspaceGC.
//
// WHY THIS EXISTS
//
// `p86-workspaces` is the localStorage cache of per-entity workbooks. It is a
// CACHE: every workbook is also persisted server-side in jobs.data->'workbook'
// / estimates.data->'workbook' (see PUT /api/jobs/:id/workbook). Nothing here
// is the only copy of anything.
//
// It grew to ~9.9MB against a ~5MB browser quota, and a full store does not
// fail quietly — it throws QuotaExceededError out of whatever happened to be
// writing. That took down two unrelated features in one day: job pages stopped
// opening (saveData threw mid-render) and the QuickBooks import silently
// stopped persisting costs (the bare setItem above the server POST threw, so
// the POST never ran).
//
// Measured composition of the 9.87MB at the time this was written:
//   6.2MB  legacy DUPLICATE keys  — 63%, and the entire problem
//   2.3MB  orphaned entities      — workbooks for jobs/estimates long deleted
//   7.1MB  "QB Costs <date>" sheets across 137 sheets (overlaps the above)
//
// THE DUPLICATES ARE THE DISEASE. The key format migrated from a bare entity
// id ("j123") to a composite ("job:j123"). _wsLegacyLookup keeps the bare slot
// as a "cold backup" and nothing ever expires it, so every migrated workbook
// is stored twice — forever. The loader always prefers the composite, so the
// legacy copy is unreachable by design: pure dead weight.
//
// SAFETY MODEL
//
// Sweeps are ordered by how much they need to know:
//   dedupeLegacy()  needs NOTHING but the cache itself. The composite key is
//                   what the loader reads; the bare twin is already ignored.
//                   Safe to run any time, including before the server load.
//   capQbSheets()   needs nothing either. QB cost NUMBERS live in the
//                   qb_cost_lines table; these sheets are a rendered view that
//                   the importer can regenerate. Keeps the newest few.
//   dropOrphans()   needs a COMPLETE entity list to decide "this job is gone".
//                   Boot seeds appData from cache before the server responds,
//                   so running this early would delete live workbooks based on
//                   a half-loaded list. It is therefore MANUAL ONLY and refuses
//                   to run unless told the entity lists are authoritative.
//
// The automatic boot sweep runs only the two that cannot be wrong.

(function () {
  'use strict';

  var STORE_KEY = 'p86-workspaces';
  var QB_SHEET_RE = /^QB Costs\s+(\d{4}-\d{2}-\d{2})/i;
  var KEEP_QB_SHEETS = 4;   // ~a month of weekly imports

  function readStore() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      return (o && typeof o === 'object') ? o : null;
    } catch (e) { return null; }
  }

  function writeStore(obj) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(obj));
      return true;
    } catch (e) {
      console.warn('[workspace-gc] could not write pruned store:', (e && e.name) || e);
      return false;
    }
  }

  function bytesOf(v) {
    try { return JSON.stringify(v).length * 2; } catch (e) { return 0; }
  }

  function storeBytes(obj) {
    return bytesOf(obj) + STORE_KEY.length * 2;
  }

  // ── Sweep 1: legacy duplicate keys ────────────────────────────────
  // A bare "j123" whose composite twin "job:j123" (or "estimate:j123")
  // also exists. The composite wins in _wsLegacyLookup, so the bare slot
  // is already dead to the app.
  function dedupeLegacy(store) {
    var keys = Object.keys(store);
    var composite = {};
    keys.forEach(function (k) {
      var i = k.indexOf(':');
      if (i > 0) composite[k.slice(i + 1)] = true;
    });
    var freed = 0, removed = [];
    keys.forEach(function (k) {
      if (k.indexOf(':') > 0) return;        // already composite
      if (!composite[k]) return;             // no twin — this IS the live copy, keep
      freed += bytesOf(store[k]);
      removed.push(k);
      delete store[k];
    });
    return { removed: removed, freedBytes: freed };
  }

  // ── Sweep 2: cap the QB Costs sheet history ───────────────────────
  // The importer adds one "QB Costs <date>" sheet per job per import and
  // never prunes. The dollars live in qb_cost_lines server-side; these are
  // a rendered convenience. Keep the newest KEEP_QB_SHEETS by the date in
  // the name (falling back to array order when the name has no date).
  function capQbSheets(store, keep) {
    keep = keep || KEEP_QB_SHEETS;
    var freed = 0, trimmed = [];
    Object.keys(store).forEach(function (k) {
      var ws = store[k];
      if (!ws || !Array.isArray(ws.sheets)) return;
      var qb = [];
      ws.sheets.forEach(function (s, idx) {
        var m = s && QB_SHEET_RE.exec(s.name || '');
        if (m) qb.push({ idx: idx, date: m[1], id: s.id });
      });
      if (qb.length <= keep) return;
      qb.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
      var doomed = {};
      qb.slice(keep).forEach(function (x) { doomed[x.idx] = true; freed += bytesOf(ws.sheets[x.idx]); });
      var survivors = ws.sheets.filter(function (_, i) { return !doomed[i]; });
      // Never orphan the active sheet pointer.
      if (ws.activeSheetId && !survivors.some(function (s) { return s.id === ws.activeSheetId; })) {
        ws.activeSheetId = survivors.length ? survivors[0].id : null;
      }
      trimmed.push(k + ' (-' + (qb.length - keep) + ')');
      ws.sheets = survivors;
    });
    return { trimmed: trimmed, freedBytes: freed };
  }

  // ── Sweep 3: orphaned entities (MANUAL) ───────────────────────────
  // Refuses to guess. Caller must pass the authoritative id sets AND assert
  // they came from the server, because boot seeds appData from this very
  // cache — deciding "gone" from a half-loaded list would delete live work.
  function dropOrphans(store, opts) {
    opts = opts || {};
    if (!opts.entityListsAreAuthoritative) {
      return { skipped: 'refused — entity lists not asserted authoritative', removed: [], freedBytes: 0 };
    }
    var live = {};
    (opts.jobIds || []).forEach(function (id) { live['job:' + id] = true; live[id] = true; });
    (opts.estimateIds || []).forEach(function (id) { live['estimate:' + id] = true; live[id] = true; });
    var freed = 0, removed = [];
    Object.keys(store).forEach(function (k) {
      if (live[k]) return;
      var bare = k.indexOf(':') > 0 ? k.slice(k.indexOf(':') + 1) : k;
      if (live[bare] || live['job:' + bare] || live['estimate:' + bare]) return;
      freed += bytesOf(store[k]);
      removed.push(k);
      delete store[k];
    });
    return { removed: removed, freedBytes: freed };
  }

  function fmtMB(b) { return (b / 1048576).toFixed(2) + 'MB'; }

  // Run the safe sweeps. dryRun reports without writing.
  function sweep(opts) {
    opts = opts || {};
    var store = readStore();
    if (!store) return { ok: false, reason: 'no workspace cache' };
    var before = storeBytes(store);

    var dedupe = dedupeLegacy(store);
    var capped = capQbSheets(store, opts.keepQbSheets);
    var orphans = opts.dropOrphans
      ? dropOrphans(store, opts)
      : { removed: [], freedBytes: 0, skipped: 'not requested' };

    var after = storeBytes(store);
    var report = {
      ok: true,
      beforeMB: +(before / 1048576).toFixed(2),
      afterMB: +(after / 1048576).toFixed(2),
      freedMB: +((before - after) / 1048576).toFixed(2),
      legacyDuplicatesRemoved: dedupe.removed.length,
      qbSheetHistoriesTrimmed: capped.trimmed.length,
      orphansRemoved: orphans.removed.length,
      orphanNote: orphans.skipped || null,
      dryRun: !!opts.dryRun
    };
    if (!opts.dryRun && (before - after) > 0) {
      report.written = writeStore(store);
    }
    return report;
  }

  // Boot sweep — only the two sweeps that cannot be wrong, and only when
  // the cache is actually under pressure. Silent unless it did something.
  var PRESSURE_BYTES = 3 * 1024 * 1024;
  function autoSweep() {
    try {
      var store = readStore();
      if (!store) return;
      if (storeBytes(store) < PRESSURE_BYTES) return;   // plenty of headroom
      var r = sweep({});
      if (r.ok && r.freedMB > 0) {
        console.log('[workspace-gc] reclaimed ' + r.freedMB + 'MB ' +
          '(' + r.legacyDuplicatesRemoved + ' legacy duplicate key(s), ' +
          r.qbSheetHistoriesTrimmed + ' QB sheet histor(ies) trimmed) — ' +
          r.beforeMB + 'MB → ' + r.afterMB + 'MB');
      }
    } catch (e) {
      console.warn('[workspace-gc] auto sweep failed:', e && e.message);
    }
  }

  window.p86WorkspaceGC = {
    sweep: sweep,
    autoSweep: autoSweep,
    // exposed for an operator / console run
    dropOrphansNow: function (jobIds, estimateIds) {
      return sweep({ dropOrphans: true, entityListsAreAuthoritative: true,
                     jobIds: jobIds || [], estimateIds: estimateIds || [] });
    },
    report: function () { return sweep({ dryRun: true }); },
    _fmtMB: fmtMB
  };

  // Sweep once the app has settled. Deliberately NOT gated on the server
  // load: neither automatic sweep consults the entity lists, so there is
  // nothing to race.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(autoSweep, 1500); });
  } else {
    setTimeout(autoSweep, 1500);
  }
})();
