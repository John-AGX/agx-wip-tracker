/* ============================================================================
 * Progress + earned revenue — the graph-free source of truth for "how far
 * along" a job is, and therefore how much revenue is earned.
 *
 * John's model: completion lives at the SCOPE level (each scope × building cell
 * has its own %), and a cell's % has two equivalent entry points that drive the
 * same number:
 *   1. Type it directly — "Gutters 60%" (phase.pctComplete, flagged manual).
 *   2. Check off units/levels on the building — the % fills to units-done.
 * A manually-typed % WINS; otherwise the building's units/levels drive it; with
 * neither, the cell's own stored % stands (0 until set). A job with no units
 * still has a source of truth: the scope % itself.
 *
 * Earned revenue = Σ over (scope, building) cells of (cell revenue × cell %).
 * This replaces the node graph's getOutput(wip,2) — no wires, no divergence.
 * ========================================================================== */
(function () {
  'use strict';

  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function clampPct(v) { var n = num(v); return n < 0 ? 0 : (n > 100 ? 100 : n); }

  function phaseRevenue(p) {
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
  function scopeCellPct(phase, buildings) {
    if (!phase) return 0;
    return clampPct(phase.pctComplete);
  }

  function jobPhases(jobId) {
    return ((window.appData && appData.phases) || []).filter(function (p) { return p && p.jobId === jobId; });
  }
  function jobBuildings(jobId) {
    return ((window.appData && appData.buildings) || []).filter(function (b) { return b && b.jobId === jobId; });
  }

  // Earned revenue = Σ cell revenue × cell %. The node-graph-free replacement
  // for job.ngRevenueEarned.
  function jobEarnedRevenue(jobId) {
    var blds = jobBuildings(jobId);
    return jobPhases(jobId).reduce(function (s, p) {
      return s + phaseRevenue(p) * scopeCellPct(p, blds) / 100;
    }, 0);
  }

  // Revenue-weighted % complete for a building = the roll-up of its scope cells'
  // own %s (the source of truth). A building with no scope cell has no scope-driven
  // completion basis → 0; give it scope cells to drive it (per Saddlebrook Cluster 9).
  function buildingPct(buildingId, jobId) {
    var blds = jobBuildings(jobId);
    var cells = jobPhases(jobId).filter(function (p) { return p.buildingId === buildingId; });
    var rev = cells.reduce(function (s, p) { return s + phaseRevenue(p); }, 0);
    if (rev > 0) return cells.reduce(function (s, p) { return s + scopeCellPct(p, blds) * phaseRevenue(p); }, 0) / rev;
    return cells.length ? cells.reduce(function (s, p) { return s + scopeCellPct(p, blds); }, 0) / cells.length : 0;
  }

  // Revenue-weighted job % = earned ÷ total scope revenue.
  function jobPct(jobId) {
    var blds = jobBuildings(jobId);
    var cells = jobPhases(jobId);
    var rev = cells.reduce(function (s, p) { return s + phaseRevenue(p); }, 0);
    if (rev <= 0) return 0;
    var earned = cells.reduce(function (s, p) { return s + phaseRevenue(p) * scopeCellPct(p, blds); }, 0);
    return earned / rev;
  }

  window.p86Progress = {
    scopeCellPct: scopeCellPct,
    buildingUnitPct: buildingUnitPct,
    jobEarnedRevenue: jobEarnedRevenue,
    buildingPct: buildingPct,
    jobPct: jobPct
  };
})();
