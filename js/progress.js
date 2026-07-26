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

  // The job's aggregate units/levels-done %, weighted by unit count (an 8-unit
  // building counts more than a 4-unit one), or null when NO building on the job
  // tracks units/levels. This is the authoritative completion for a job-level
  // scope, which spans every building.
  function jobUnitPct(jobId) {
    var blds = jobBuildings(jobId);
    var sum = 0, n = 0;
    for (var i = 0; i < blds.length; i++) {
      var b = blds[i];
      var coll = (b.units && b.units.length) ? b.units
        : ((b.levels && b.levels.length) ? b.levels : null);
      if (!coll) continue;
      for (var j = 0; j < coll.length; j++) { sum += itemPct(coll[j]); n++; }
    }
    return n > 0 ? sum / n : null;
  }

  // THE per-cell completion %. For a per-building cell: manual entry wins, else
  // the building's units/levels, else the cell's own stored %. For a JOB-LEVEL
  // scope (no buildingId — it spans every building): the job's aggregate unit
  // progress is authoritative when the buildings track units, because a single
  // job-level % (even a manually-typed one) can't express a per-building reality
  // and goes stale the instant an unstarted building is added; only when nothing
  // tracks units does the stored/manual % stand. `buildings` optional (a lookup
  // to avoid re-scanning); falls back to appData.
  function scopeCellPct(phase, buildings) {
    if (!phase) return 0;
    if (phase.buildingId) {
      if (phase.pctCompleteManual) return clampPct(phase.pctComplete);
      var b = (buildings || (window.appData && appData.buildings) || [])
        .find(function (x) { return x && x.id === phase.buildingId; });
      var up = buildingUnitPct(b);
      if (up != null) return up;
      return clampPct(phase.pctComplete);
    }
    var ju = jobUnitPct(phase.jobId);
    if (ju != null) return ju;
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

  // Revenue-weighted % complete for a building (its scope cells). When NO scope
  // cell targets this building — scopes live only at the job level — fall back to
  // the building's own units/levels so its card reflects real field progress
  // instead of a flat 0.
  function buildingPct(buildingId, jobId) {
    var blds = jobBuildings(jobId);
    var cells = jobPhases(jobId).filter(function (p) { return p.buildingId === buildingId; });
    var rev = cells.reduce(function (s, p) { return s + phaseRevenue(p); }, 0);
    if (rev > 0) return cells.reduce(function (s, p) { return s + scopeCellPct(p, blds) * phaseRevenue(p); }, 0) / rev;
    if (cells.length) return cells.reduce(function (s, p) { return s + scopeCellPct(p, blds); }, 0) / cells.length;
    var b = blds.find(function (x) { return x && x.id === buildingId; });
    var up = buildingUnitPct(b);
    return up != null ? up : 0;
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
