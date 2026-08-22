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
 *
 * THIS FILE IS NOW AN ADAPTER, AND THAT IS THE POINT.
 * ---------------------------------------------------
 * The arithmetic moved to js/progress-core.js, appData-free, so the SERVER can
 * require the same lines the browser runs. It was welded to appData here, which
 * is precisely why server/services/money/job-wip.js grew a second, smaller idea
 * of "how far along" (`job.pctComplete`, a stored 0.1-precision scalar written
 * as a side effect of a browser render). One clock, one implementation.
 *
 * Everything below is jobId → filter appData → delegate. No math lives here.
 * Every existing call site keeps its jobId signature and its exact value.
 * ========================================================================== */
(function () {
  'use strict';

  // Loud, not lenient. If progress-core.js has not loaded, a silent degrade
  // here would leave coCompletion earning from an absent core and would let a
  // rider change order bill as one General G703 line instead of ten
  // per-building lines — the exact corruption the port exists to prevent.
  var CORE = (typeof window !== 'undefined') ? window.p86ProgressCore : null;
  if (!CORE) throw new Error('js/progress.js requires js/progress-core.js to load first');

  function jobPhases(jobId) {
    return ((window.appData && appData.phases) || []).filter(function (p) { return p && p.jobId === jobId; });
  }
  function jobBuildings(jobId) {
    return ((window.appData && appData.buildings) || []).filter(function (b) { return b && b.jobId === jobId; });
  }

  window.p86Progress = {
    scopeCellPct: CORE.scopeCellPct,
    buildingUnitPct: CORE.buildingUnitPct,
    jobEarnedRevenue: function (jobId) { return CORE.jobEarnedRevenue(jobPhases(jobId), jobBuildings(jobId)); },
    buildingPct: function (buildingId, jobId) { return CORE.buildingPct(buildingId, jobPhases(jobId), jobBuildings(jobId)); },
    jobPct: function (jobId) { return CORE.jobPct(jobPhases(jobId), jobBuildings(jobId)); }
  };
})();
