/* ============================================================================
 * co-completion.js — HOW A CHANGE ORDER EARNS. One implementation, both targets.
 *
 * THE DEFECT THIS ENDS
 * --------------------
 * A change order's revenue and its cost ran on different clocks, and the server
 * had no idea the rider concept existed at all:
 *
 *   browser (js/jobs.js coCompletion)  a rider CO earns at its SCOPE CELL's %
 *   server  (money/job-wip.js:190)     coEarned = unlinkedIncome × job.pctComplete/100
 *
 * On RV2008 Fairway Paint & Gutters, CO-0001 (rider on "Gutters", $27,500) reads
 * 74% / $20,302 earned on John's screen while the server booked it at the JOB's
 * stored percent. Same change order, two numbers, and 86 quoting one of them
 * into a chat window next to a ribbon showing the other.
 *
 * The precedent is server/services/money/job-wip.js: `computeJobWIP` was a
 * drifted duplicate of the browser's getJobWIP and it was DELETED, not kept in
 * sync. Same discipline here. The rider/standalone/legacy bodies no longer
 * exist in js/jobs.js — that file now holds an ~10-line wrapper that computes
 * sell/cost and filters appData. If two bodies existed, this pass failed.
 *
 * WHY sell AND cost ARE ARGUMENTS, NOT COMPUTED HERE
 * --------------------------------------------------
 * Three load-bearing reasons, not style:
 *  1. server/services/money/job-wip.js must keep passing the standing assertion
 *     that it "has never heard of the pricing model at all". A module it calls
 *     that require()s the pricing pipeline would launder that straight through.
 *  2. js/pay-applications.js deriveSOV computes `sell` itself and DIVIDES
 *     byBuilding[].share by it. If `share` came from one sell and the divisor
 *     from another, the per-building percentages stop summing to 100 and the
 *     difference silently rescales the whole G703 change-order block into the
 *     "(unallocated)" General line. One `sell` per call site, passed in, is the
 *     containment.
 *  3. The server already holds the number (change-order-totals.changeOrderMoney).
 *
 * CONTRACT
 *   coCompletion(co, ctx) -> { mode, scopeName?, sell, cost, profit,
 *                              byBuilding: { bid: {share, pct, earned} },
 *                              earned, placed, unallocated,
 *                              riderScopeMissing?, weightedPct }
 *
 *   ctx = { sell, cost, phases, buildings, storedPct }
 *     sell       Number  the caller's priced CO total (coSellAmount / .income)
 *     cost       Number  the caller's raw line subtotal, pre-markup (/ .costs)
 *     phases     Array   THIS JOB's phase rows only — the caller filters
 *     buildings  Array   THIS JOB's building rows only — the caller filters
 *     storedPct  Number  job.pctComplete, the stored scalar. REQUIRED: the
 *                        legacy branch falls back to it on a job with no scopes,
 *                        and without it every legacy CO on a scope-less job
 *                        would earn $0 — a revenue regression on BOTH sides,
 *                        hidden inside a port.
 *
 * `co` arrives in THREE shapes and all three are supported, deliberately:
 *   flat        server shapeChangeOrderRow / browser appData.jobChangeOrders
 *   nested      the CO editor's synthetic {id, lines, data:{completionMode,…}}
 *   raw row     {status, co_number, data:{…}} straight off the table
 * The top-level-first / `data`-second read below is not cruft. Do not "clean it
 * up": the editor's live preview depends on the nested form and every persisted
 * browser row is the flat form.
 *
 * ── SUBTLETIES PRESERVED VERBATIM. Each has an assertion in
 *    test/co-completion-port.test.js; the number in brackets is the test's ID. ──
 *
 * [S1]  `sell` and `cost` never see a percentage. The strip's Revenue/Cost/
 *       Profit carry no clock and do not move under this port.
 * [S2]  The rider clock is clampPct(phase.pctComplete) and NOTHING else. Units
 *       and levels do not feed it (see progress-core scopeCellPct / Saddlebrook
 *       Cluster 9). Do not "improve" it with buildingUnitPct.
 * [S3]  weightedPct = Σ(rev·pct)/Σrev over the RIDDEN SCOPE's cells only.
 * [S4]  The per-building branch WINS over job-level: when any cell of the scope
 *       carries a buildingId, a job-level cell of the same scope is silently
 *       EXCLUDED from scopeRev. A known asymmetry, preserved as-is.
 * [S5]  The job-level branch reads cells[0] ONLY. Cells 1..n are ignored,
 *       byBuilding stays {}, placed = 0, unallocated = sell. Which also means
 *       item [S12]'s "no banner" claim is about the per-building branch alone —
 *       a job-level rider DOES show unallocated = sell and bills as one
 *       General line. Both are today's behaviour.
 * [S6]  scopeRev <= 0 ⇒ even split sell/perB.length, which makes weightedPct the
 *       UNWEIGHTED MEAN of the cell percents.
 * [S7]  riderScopeMissing DOES NOT FALL BACK. A renamed or deleted scope earns
 *       $0 and says so. A fallback would restore revenue org-wide as an
 *       invisible side effect of a port, and it would reset every carried-
 *       forward G703 line to zero — a full re-bill in one draw.
 * [S8]  NO TRIM. Scope names are compared raw, so a scope stored as "Gutters "
 *       earns $0 against a CO riding "Gutters" — while js/job-audit.js R11
 *       trims both sides and calls that CO healthy. The divergence is asserted,
 *       not repaired: trimming here would RESTORE revenue on every whitespace-
 *       damaged CO, which is a money move disguised as a port.
 * [S9]  (p.phase || 'Unnamed') — an unnamed scope is matchable by a CO riding
 *       the literal string "Unnamed".
 * [S10] Standalone reads the CO's OWN pctComplete per allocation, not the
 *       scope's, and DROPS allocations pointing at buildings no longer on the
 *       job so their dollars land in `unallocated` rather than vanishing.
 * [S11] A deductive CO earns correctly NEGATIVE, but reports weightedPct 0
 *       because of the `sell > 0 ? … : 0` guard. A known display wart,
 *       preserved and asserted, not fixed here.
 * [S13] byBuilding's key set includes ZERO-REVENUE cells (share 0). The core
 *       filters nothing. deriveSOV's own `pct <= 0` skip is what keeps them off
 *       the G703 — moving that filter in here would change G703 line ids and
 *       break `previous` carry-forward on the next application.
 * [S14] The TRUTHY phaseRevenue chain is what the rider weights on, on purpose:
 *       legacy rows carry an explicit dead `asSoldRevenue: 0` with the money in
 *       asSoldPhaseBudget (Saddlebrook {0, 5000}). progress-core carries a NULL
 *       chain. Two rules, both live, neither unified — see progress-core's
 *       header for why, and what unifying would reach.
 * [S16] Legacy mode = LIVE jobPct when the job has scope rows, and the stored
 *       scalar ONLY when it has none.
 * [S22] Order cannot move a cent. This iterates the caller's array in the given
 *       order and distributes proportionally to phaseRevenue; only presentation
 *       sorts (nodegraph buildingsView) reorder anything.
 * [S23] The CO cost-attribution pair (the draw/source fields shipped alongside
 *       this work) gains NO consumer here — deliberately, so cost attribution
 *       stays provably non-accruing. A standing grep guard proves this file
 *       does not so much as name them; that guard is why they are unnamed here.
 * [S24] No amount changes. $27,500 in, $27,500 out. Only the percentage applied
 *       to it moves, and only on the server.
 * ========================================================================== */
(function () {
  'use strict';

  var CORE = (typeof module !== 'undefined' && module.exports)
    ? require('./progress-core.js')
    : ((typeof window !== 'undefined') ? window.p86ProgressCore : null);
  // Loud, never lenient — see js/progress.js for what a silent degrade costs.
  if (!CORE) throw new Error('js/co-completion.js requires js/progress-core.js to load first');

  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function clampPct(v) { var n = Number(v) || 0; return n < 0 ? 0 : (n > 100 ? 100 : n); }

  // [S14] THE TRUTHY CHAIN, lifted verbatim from js/jobs.js phaseRevenue.
  // Truthy on purpose: legacy rows carry an explicit asSoldRevenue: 0 written by
  // old save paths while the real number sits in asSoldPhaseBudget/phaseBudget
  // (verified on Saddlebrook: {asSoldRevenue:0, asSoldPhaseBudget:5000}). A
  // null-check chain would stop at that dead 0. Deliberately un-coerced, exactly
  // as the browser has always read it, so the two targets cannot diverge on a
  // string-valued row.
  function phaseRevenueTruthy(p) {
    if (!p) return 0;
    return p.asSoldRevenue || p.asSoldPhaseBudget || p.phaseBudget || 0;
  }

  // Top-level first, `data` second — the three input shapes. See header.
  function readField(co, key) {
    return (co && (co[key] || (co.data && co.data[key]))) || '';
  }

  function coCompletion(co, ctx) {
    var c = ctx || {};
    var sell = num(c.sell);
    var cost = num(c.cost);
    var phases = Array.isArray(c.phases) ? c.phases : [];
    var buildings = Array.isArray(c.buildings) ? c.buildings : [];
    var storedPct = num(c.storedPct);
    var mode = readField(co, 'completionMode');
    var byB = {}, earned = 0, placed = 0;

    if (mode === 'rider') {
      var scopeName = readField(co, 'riderScopeName');
      // [S8] Raw comparison, no trim. [S9] an unnamed scope reads as 'Unnamed'.
      var cells = phases.filter(function (p) { return (p.phase || 'Unnamed') === scopeName; });
      var perB = cells.filter(function (p) { return p.buildingId; });
      if (perB.length) {
        // [S4] Per-building scope: inherit its revenue split + %s EXACTLY.
        // A job-level cell of this same scope is excluded from scopeRev.
        var scopeRev = perB.reduce(function (s, p) { return s + phaseRevenueTruthy(p); }, 0);
        perB.forEach(function (p) {
          var cpct = CORE.scopeCellPct(p, buildings);
          // [S6] scopeRev <= 0 ⇒ even split.
          var share = scopeRev > 0 ? sell * (phaseRevenueTruthy(p) / scopeRev) : (sell / perB.length);
          var e = share * cpct / 100;
          // [S13] a zero-revenue cell still gets a key, with share 0.
          byB[p.buildingId] = { share: share, pct: cpct, earned: e };
          earned += e; placed += share;
        });
      } else if (cells.length) {
        // [S5] Job-level scope (no per-building split to inherit yet) — earn at
        // its overall %; no per-building breakdown until it's split. cells[0]
        // ONLY: cells 1..n are ignored, and unallocated comes back as `sell`.
        var cpct0 = CORE.scopeCellPct(cells[0], buildings);
        earned = sell * cpct0 / 100;
      }
      // [S7] THE SILENT DROP, NAMED. If the ridden scope has been renamed
      // or deleted, `cells` is empty: earned falls to $0 and stays there,
      // with nothing on screen to say why. That is revenue vanishing, not
      // revenue not yet earned.
      //
      // This flag REPORTS it; it deliberately does NOT fall back to the
      // job's percent. A fallback would restore the revenue — moving
      // displayProfit and displayMargin on every job whose rider scope was
      // ever renamed — as an invisible side effect of a commit. Worse, on a
      // job that has already billed, byBuilding would repopulate and reset
      // every carried-forward G703 line's `previous` to 0: a full re-bill in
      // a single draw. So the drop stays visible (the CO editor and
      // js/job-audit.js R11 both shout), John sees the number, and
      // re-pointing the CO at a real scope is the fix.
      return {
        mode: 'rider', scopeName: scopeName, sell: sell, cost: cost, profit: sell - cost,
        byBuilding: byB, earned: earned, placed: placed, unallocated: sell - placed,
        riderScopeMissing: !cells.length,
        weightedPct: sell > 0 ? earned / sell * 100 : 0
      };
    }

    if (mode === 'standalone') {
      var allocs = Array.isArray(co && co.buildingAllocations) ? co.buildingAllocations
        : ((co && co.data && Array.isArray(co.data.buildingAllocations)) ? co.data.buildingAllocations : []);
      // [S10] Only buildings still on the job; a share aimed at a deleted
      // building falls into `unallocated`, it never silently disappears.
      var live = {};
      buildings.forEach(function (b) { if (b && b.id) live[b.id] = 1; });
      allocs.forEach(function (a) {
        if (!a || !a.buildingId || !live[a.buildingId]) return;
        var share = sell * clampPct(a.pct) / 100;
        var cpct = clampPct(a.pctComplete);
        var e = share * cpct / 100;
        byB[a.buildingId] = { share: share, pct: cpct, earned: e };
        earned += e; placed += share;
      });
      return {
        mode: 'standalone', sell: sell, cost: cost, profit: sell - cost,
        byBuilding: byB, earned: earned, placed: placed, unallocated: sell - placed,
        // [S11] a deductive CO earns negative but reports 0% — a display wart,
        // preserved rather than fixed inside a port.
        weightedPct: sell > 0 ? earned / sell * 100 : 0
      };
    }

    // [S16] Legacy: earn at the job's overall %. LIVE jobPct when the job has
    // scope rows, the stored scalar only when it has none. This is what the
    // browser has always done; the server used the stored scalar in both cases,
    // which is one of the two clocks this port collapses.
    var jp = phases.length ? CORE.jobPct(phases, buildings) : storedPct;
    return {
      mode: 'legacy', sell: sell, cost: cost, profit: sell - cost,
      byBuilding: {}, earned: sell * jp / 100, placed: 0, unallocated: sell, weightedPct: jp
    };
  }

  var api = { coCompletion: coCompletion, phaseRevenueTruthy: phaseRevenueTruthy };

  if (typeof window !== 'undefined') window.p86CoCompletion = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
