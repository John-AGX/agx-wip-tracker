/* ============================================================================
 * progress-core.js — the PURE core of progress + earned revenue.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * js/progress.js held both the arithmetic and the appData lookups, so the only
 * way to reach the arithmetic was to be a browser with a populated appData.
 * The server therefore could not run it, and server/services/money/job-wip.js
 * grew its OWN idea of how far along a job is (`job.pctComplete`, a stored
 * scalar). Two clocks. That is the defect this file exists to end: the math
 * lives here, appData-free, and BOTH targets require it.
 *
 * This is a lift, not a redesign. Every function below is byte-for-byte the
 * body that was in js/progress.js, with the implicit `appData.phases.filter(
 * p => p.jobId === jobId)` replaced by an explicit `phases` argument. The
 * caller does the filtering; the core never hears of a jobId. That is what
 * makes it testable with hand-built arrays — and what stopped it being a
 * second opinion.
 *
 * js/progress.js is now a ~30-line adapter over this file and keeps every
 * existing jobId-shaped call site working at its exact current value.
 *
 * THE TWO phaseRevenue CHAINS — DELIBERATE, DO NOT UNIFY
 * -----------------------------------------------------
 * `phaseRevenueNull` below is a NULL-check chain:
 *     asSoldRevenue != null ? asSoldRevenue : (asSoldPhaseBudget != null ? … )
 * js/co-completion.js carries a TRUTHY chain (`a || b || c || 0`), lifted from
 * js/jobs.js. They disagree on exactly one shape — the legacy row
 * {asSoldRevenue: 0, asSoldPhaseBudget: 5000} verified on Saddlebrook — where
 * the null chain reads $0 and the truthy chain reads $5,000.
 *
 * Both are preserved AS THEY ARE. Unifying them would move browser money on
 * every legacy row, and it would move `byBuilding[].share`, which is the ONE
 * value a pay application reads out of the completion model (js/pay-applications.js
 * deriveSOV) — so a "cleanup" here reaches a printed G703. The divergence is
 * asserted in test/co-completion-port.test.js rather than repaired. Unify it
 * later, deliberately, with a census of affected rows in hand.
 * ========================================================================== */
(function () {
  'use strict';

  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function clampPct(v) { var n = num(v); return n < 0 ? 0 : (n > 100 ? 100 : n); }

  // The NULL-check chain. See the header: this is one of two rules, on purpose.
  function phaseRevenueNull(p) {
    return num(p && (p.asSoldRevenue != null ? p.asSoldRevenue
      : (p.asSoldPhaseBudget != null ? p.asSoldPhaseBudget : p.phaseBudget)));
  }

  // A unit/level's own % — an explicit `pct` (0-100) wins, else a bare
  // `done:true` reads as 100. Matches the engine's _uPct.
  function itemPct(u) {
    if (!u) return 0;
    if (u.pct != null) return clampPct(u.pct);
    return u.done ? 100 : 0;
  }
  // Average % across a units/levels collection, or null when there is none.
  function collectionPct(coll) {
    if (!coll || !coll.length) return null;
    var s = 0; for (var i = 0; i < coll.length; i++) s += itemPct(coll[i]);
    return s / coll.length;
  }
  // A building's units/levels-driven %, or null when it has neither.
  function buildingUnitPct(b) {
    if (!b) return null;
    var u = collectionPct(b.units);
    if (u != null) return u;
    return collectionPct(b.levels);
  }

  // THE per-cell completion %. The scope's OWN % — a manually-typed value or the
  // stored value — is the SOURCE OF TRUTH: an existing scope drives its building's
  // completion, it is NOT overridden by the building's units. (John / Saddlebrook
  // Cluster 9: 12 per-building scope cells roll straight up to B1 92 / B2 8 / B3 8
  // / B4 75, job 46, with no units in play — and across the live data no building
  // ever has both a scope cell and units, so the scope % always stands.) `buildings`
  // kept for call-site compatibility.
  //
  // ALWAYS CLAMPED. A stored `pctComplete: 150` contributes 100, never 150. The
  // old p86Progress-absent fallbacks in js/jobs.js coCompletion read a bare
  // `p.pctComplete || 0` with NO clamp, so a damaged row could earn 150% of a
  // change order. Those fallbacks are deleted; this is the only reader.
  function scopeCellPct(phase, buildings) {
    if (!phase) return 0;
    return clampPct(phase.pctComplete);
  }

  // Earned revenue = Σ cell revenue × cell %. The node-graph-free replacement
  // for job.ngRevenueEarned. `phases` is THIS JOB's rows; the caller filters.
  function jobEarnedRevenue(phases, buildings) {
    var blds = Array.isArray(buildings) ? buildings : [];
    return (Array.isArray(phases) ? phases : []).reduce(function (s, p) {
      return s + phaseRevenueNull(p) * scopeCellPct(p, blds) / 100;
    }, 0);
  }

  // Revenue-weighted % complete for a building = the roll-up of its scope cells'
  // own %s (the source of truth). A building with no scope cell has no scope-driven
  // completion basis → 0; give it scope cells to drive it (per Saddlebrook Cluster 9).
  function buildingPct(buildingId, phases, buildings) {
    var blds = Array.isArray(buildings) ? buildings : [];
    var cells = (Array.isArray(phases) ? phases : []).filter(function (p) { return p && p.buildingId === buildingId; });
    var rev = cells.reduce(function (s, p) { return s + phaseRevenueNull(p); }, 0);
    if (rev > 0) return cells.reduce(function (s, p) { return s + scopeCellPct(p, blds) * phaseRevenueNull(p); }, 0) / rev;
    return cells.length ? cells.reduce(function (s, p) { return s + scopeCellPct(p, blds); }, 0) / cells.length : 0;
  }

  // Revenue-weighted job % = earned ÷ total scope revenue.
  function jobPct(phases, buildings) {
    var blds = Array.isArray(buildings) ? buildings : [];
    var cells = Array.isArray(phases) ? phases : [];
    var rev = cells.reduce(function (s, p) { return s + phaseRevenueNull(p); }, 0);
    if (rev <= 0) return 0;
    var earned = cells.reduce(function (s, p) { return s + phaseRevenueNull(p) * scopeCellPct(p, blds); }, 0);
    return earned / rev;
  }

  var api = {
    num: num,
    clampPct: clampPct,
    phaseRevenueNull: phaseRevenueNull,
    itemPct: itemPct,
    collectionPct: collectionPct,
    buildingUnitPct: buildingUnitPct,
    scopeCellPct: scopeCellPct,
    jobEarnedRevenue: jobEarnedRevenue,
    buildingPct: buildingPct,
    jobPct: jobPct
  };

  // Dual-target, same reason js/pricing-pipeline.js is: the number on screen
  // and the number the server hands 86 must be produced by the same lines.
  if (typeof window !== 'undefined') window.p86ProgressCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
