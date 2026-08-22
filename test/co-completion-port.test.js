'use strict';

/**
 * co-completion-port.test.js — DIFFERENTIAL proof that js/co-completion.js is
 * the SAME function that lived inside js/jobs.js, and that the server now runs
 * it instead of `unlinkedIncome × job.pctComplete / 100`.
 *
 * THE ORACLE IS INLINE, ON PURPOSE.
 * ---------------------------------
 * `preportCoCompletion` + `preportProgress` below are the pre-port bodies,
 * copied verbatim from js/jobs.js and js/progress.js as they stood at c47b113,
 * driven by a hand-built `appData`. They are the thing the port replaced. Every
 * grid case runs BOTH and compares. If someone "improves" the ported module,
 * this file is where the improvement shows up as a difference from the code
 * John's screen has been running.
 *
 * Two numbers in here are the live ground truth from John's own tab —
 * RV2008 Fairway Paint & Gutters, CO-0001, rider on "Gutters": the strip reads
 * `% Complete 74%` and `Earned $20,302` against `Revenue $27,500`.
 */

const path = require('path');
const fs = require('fs');

const pricing = require('../js/pricing-pipeline.js');
const core = require('../js/progress-core.js');
const { coCompletion, phaseRevenueTruthy } = require('../js/co-completion.js');
const jobWip = require('../server/services/money/job-wip.js');
const jobMoney = require('../server/services/money/change-order-totals.js');

const raw = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

// ═══════════════════════════════════════════════════════════════════════════
// THE ORACLE — js/progress.js + js/jobs.js coCompletion, pre-port, verbatim.
// ═══════════════════════════════════════════════════════════════════════════

function preportProgress(appData) {
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function clampPct(v) { var n = num(v); return n < 0 ? 0 : (n > 100 ? 100 : n); }
  function phaseRevenue(p) {
    return num(p && (p.asSoldRevenue != null ? p.asSoldRevenue
      : (p.asSoldPhaseBudget != null ? p.asSoldPhaseBudget : p.phaseBudget)));
  }
  function scopeCellPct(phase) { if (!phase) return 0; return clampPct(phase.pctComplete); }
  function jobPhases(jobId) { return (appData.phases || []).filter(function (p) { return p && p.jobId === jobId; }); }
  function jobEarnedRevenue(jobId) {
    return jobPhases(jobId).reduce(function (s, p) { return s + phaseRevenue(p) * scopeCellPct(p) / 100; }, 0);
  }
  function jobPct(jobId) {
    var cells = jobPhases(jobId);
    var rev = cells.reduce(function (s, p) { return s + phaseRevenue(p); }, 0);
    if (rev <= 0) return 0;
    var earned = cells.reduce(function (s, p) { return s + phaseRevenue(p) * scopeCellPct(p); }, 0);
    return earned / rev;
  }
  return { scopeCellPct, jobEarnedRevenue, jobPct, phaseRevenue };
}

// js/jobs.js coSellAmount + phaseRevenue (TRUTHY chain) + coCompletion, verbatim.
function preportCoCompletion(co, jobId, appData) {
  const P = preportProgress(appData);
  function coSellAmount(c) {
    const lines = Array.isArray(c && c.lines) ? c.lines : [];
    if (!lines.length) return 0;
    const per = pricing.computeForLines(c, lines);
    const markedUp = pricing.resolveMarkedUp(per, c);
    return pricing.applyFeesAndTax(markedUp, c).total;
  }
  function phaseRevenue(p) {
    if (!p) return 0;
    return p.asSoldRevenue || p.asSoldPhaseBudget || p.phaseBudget || 0;
  }
  function clampPct(v) { v = Number(v) || 0; return v < 0 ? 0 : (v > 100 ? 100 : v); }
  var sell = coSellAmount(co);
  var lines = Array.isArray(co && co.lines) ? co.lines : [];
  var cost = lines.length ? ((pricing.computeForLines(co, lines) || {}).subtotal || 0) : 0;
  var mode = (co && (co.completionMode || (co.data && co.data.completionMode))) || '';
  var byB = {}, earned = 0, placed = 0;

  if (mode === 'rider') {
    var scopeName = (co && (co.riderScopeName || (co.data && co.data.riderScopeName))) || '';
    var cells = (appData.phases || []).filter(function (p) { return p.jobId === jobId && (p.phase || 'Unnamed') === scopeName; });
    var perB = cells.filter(function (p) { return p.buildingId; });
    if (perB.length) {
      var scopeRev = perB.reduce(function (s, p) { return s + phaseRevenue(p); }, 0);
      perB.forEach(function (p) {
        var cpct = P.scopeCellPct(p);
        var share = scopeRev > 0 ? sell * (phaseRevenue(p) / scopeRev) : (sell / perB.length);
        var e = share * cpct / 100;
        byB[p.buildingId] = { share: share, pct: cpct, earned: e };
        earned += e; placed += share;
      });
    } else if (cells.length) {
      var cpct0 = P.scopeCellPct(cells[0]);
      earned = sell * cpct0 / 100;
    }
    return { mode: 'rider', scopeName: scopeName, sell: sell, cost: cost, profit: sell - cost,
      byBuilding: byB, earned: earned, placed: placed, unallocated: sell - placed,
      riderScopeMissing: !cells.length,
      weightedPct: sell > 0 ? earned / sell * 100 : 0 };
  }

  if (mode === 'standalone') {
    var allocs = Array.isArray(co && co.buildingAllocations) ? co.buildingAllocations
      : ((co && co.data && Array.isArray(co.data.buildingAllocations)) ? co.data.buildingAllocations : []);
    var live = {}; (appData.buildings || []).forEach(function (b) { if (b && b.jobId === jobId) live[b.id] = 1; });
    allocs.forEach(function (a) {
      if (!a || !a.buildingId || !live[a.buildingId]) return;
      var share = sell * clampPct(a.pct) / 100;
      var cpct = clampPct(a.pctComplete);
      var e = share * cpct / 100;
      byB[a.buildingId] = { share: share, pct: cpct, earned: e };
      earned += e; placed += share;
    });
    return { mode: 'standalone', sell: sell, cost: cost, profit: sell - cost,
      byBuilding: byB, earned: earned, placed: placed, unallocated: sell - placed,
      weightedPct: sell > 0 ? earned / sell * 100 : 0 };
  }

  var _hasScopes = (appData.phases || []).some(function (p) { return p.jobId === jobId; });
  var _job = (appData.jobs || []).find(function (j) { return j.id === jobId; });
  var jp = _hasScopes ? P.jobPct(jobId) : ((_job && _job.pctComplete) || 0);
  return { mode: 'legacy', sell: sell, cost: cost, profit: sell - cost,
    byBuilding: {}, earned: sell * jp / 100, placed: 0, unallocated: sell, weightedPct: jp };
}

// The ported module, reached exactly as js/jobs.js's wrapper reaches it.
function portedFromAppData(co, jobId, appData) {
  const lines = Array.isArray(co && co.lines) ? co.lines : [];
  const per = lines.length ? pricing.computeForLines(co, lines) : null;
  const sell = per ? pricing.applyFeesAndTax(pricing.resolveMarkedUp(per, co), co).total : 0;
  const job = (appData.jobs || []).find((j) => j.id === jobId);
  return coCompletion(co, {
    sell,
    cost: per ? (per.subtotal || 0) : 0,
    phases: (appData.phases || []).filter((p) => p && p.jobId === jobId),
    buildings: (appData.buildings || []).filter((b) => b && b.jobId === jobId),
    storedPct: (job && job.pctComplete) || 0,
  });
}

/** Run BOTH and assert they agree, then hand back the ported result. */
function differential(co, jobId, appData) {
  const before = preportCoCompletion(co, jobId, appData);
  const after = portedFromAppData(co, jobId, appData);
  // round2 rather than bit-equality: the two walk the same array in the same
  // order today, but the server's array is job.data.phases while the browser's
  // is a filtered appData.phases, and floating-point addition is not
  // associative — reversing ten terms moves `earned` by ~4e-12. Pinning bits
  // would be pinning array order, which §"order cannot move a cent" says is
  // exactly what must NOT be load-bearing.
  const r2 = (n) => Math.round(n * 100) / 100;
  expect(after.mode).toBe(before.mode);
  expect(r2(after.sell)).toBe(r2(before.sell));
  expect(r2(after.cost)).toBe(r2(before.cost));
  expect(r2(after.profit)).toBe(r2(before.profit));
  expect(after.earned).toBeCloseTo(before.earned, 6);
  expect(after.weightedPct).toBeCloseTo(before.weightedPct, 9);
  expect(r2(after.placed)).toBe(r2(before.placed));
  expect(r2(after.unallocated)).toBe(r2(before.unallocated));
  expect(after.riderScopeMissing).toBe(before.riderScopeMissing);
  // Key SET and key ORDER both — deriveSOV pushes G703 lines in
  // Object.keys(byBuilding) order, so insertion order is printed row order.
  expect(Object.keys(after.byBuilding)).toEqual(Object.keys(before.byBuilding));
  for (const k of Object.keys(before.byBuilding)) {
    expect(r2(after.byBuilding[k].share)).toBe(r2(before.byBuilding[k].share));
    expect(after.byBuilding[k].pct).toBe(before.byBuilding[k].pct);
    expect(after.byBuilding[k].earned).toBeCloseTo(before.byBuilding[k].earned, 6);
  }
  return after;
}

// ═══════════════════════════════════════════════════════════════════════════
// FIXTURES
// ═══════════════════════════════════════════════════════════════════════════

const JOB = 'j1783317122508';

/** Ten $2,750 lines, defaultMarkup 0 ⇒ sell = cost = $27,500, profit $0. */
const FAIRWAYS_LINES = Array.from({ length: 10 }, (_, i) => ({
  id: 'l' + i, description: 'Gutter run ' + i, qty: 1, unitCost: 2750,
}));

// Ten Gutters cells, one per building. B2 carries the live row John showed:
// pctComplete 100, revenue 10905. Σrev = 110,050 and the revenue-weighted
// percent lands on the screenshot: 74% / $20,302 against $27,500.
const FAIRWAYS_CELLS = [
  { id: 'p1', jobId: JOB, phase: 'Gutters', buildingId: 'B1', workScope: 'sub', asSoldRevenue: 11000, asSoldPhaseBudget: 11000, phaseBudget: 11000, pctComplete: 100, sub: 0, coPhaseBudget: 0 },
  { id: 'p2', jobId: JOB, phase: 'Gutters', buildingId: 'B2', workScope: 'sub', asSoldRevenue: 10905, asSoldPhaseBudget: 10905, phaseBudget: 10905, pctComplete: 100, sub: 0, coPhaseBudget: 0 },
  { id: 'p3', jobId: JOB, phase: 'Gutters', buildingId: 'B3', workScope: 'sub', asSoldRevenue: 11500, asSoldPhaseBudget: 11500, phaseBudget: 11500, pctComplete: 90, sub: 0, coPhaseBudget: 0 },
  { id: 'p4', jobId: JOB, phase: 'Gutters', buildingId: 'B4', workScope: 'sub', asSoldRevenue: 10500, asSoldPhaseBudget: 10500, phaseBudget: 10500, pctComplete: 80, sub: 0, coPhaseBudget: 0 },
  { id: 'p5', jobId: JOB, phase: 'Gutters', buildingId: 'B5', workScope: 'sub', asSoldRevenue: 11250, asSoldPhaseBudget: 11250, phaseBudget: 11250, pctComplete: 75, sub: 0, coPhaseBudget: 0 },
  { id: 'p6', jobId: JOB, phase: 'Gutters', buildingId: 'B6', workScope: 'sub', asSoldRevenue: 10800, asSoldPhaseBudget: 10800, phaseBudget: 10800, pctComplete: 70, sub: 0, coPhaseBudget: 0 },
  { id: 'p7', jobId: JOB, phase: 'Gutters', buildingId: 'B7', workScope: 'sub', asSoldRevenue: 11100, asSoldPhaseBudget: 11100, phaseBudget: 11100, pctComplete: 65, sub: 0, coPhaseBudget: 0 },
  { id: 'p8', jobId: JOB, phase: 'Gutters', buildingId: 'B8', workScope: 'sub', asSoldRevenue: 10995, asSoldPhaseBudget: 10995, phaseBudget: 10995, pctComplete: 60, sub: 0, coPhaseBudget: 0 },
  { id: 'p9', jobId: JOB, phase: 'Gutters', buildingId: 'B9', workScope: 'sub', asSoldRevenue: 11000, asSoldPhaseBudget: 11000, phaseBudget: 11000, pctComplete: 50, sub: 0, coPhaseBudget: 0 },
  { id: 'p10', jobId: JOB, phase: 'Gutters', buildingId: 'B10', workScope: 'sub', asSoldRevenue: 11000, asSoldPhaseBudget: 11000, phaseBudget: 11000, pctComplete: 48, sub: 0, coPhaseBudget: 0 },
];

const FAIRWAYS_BUILDINGS = FAIRWAYS_CELLS.map((p) => ({ id: p.buildingId, jobId: JOB, name: p.buildingId }));

const CO_0001 = {
  id: 'co1', job_id: JOB, status: 'approved', co_number: 'CO-0001',
  title: 'Gutters', lines: FAIRWAYS_LINES, defaultMarkup: 0,
  completionMode: 'rider', riderScopeName: 'Gutters', buildingAllocations: [],
};

function fairwaysAppData(jobPctStored) {
  return {
    jobs: [{ id: JOB, jobNumber: 'RV2008', pctComplete: jobPctStored }],
    phases: FAIRWAYS_CELLS,
    buildings: FAIRWAYS_BUILDINGS,
    jobChangeOrders: [CO_0001],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
describe('A · Fairways CO-0001 — the screenshot, reconstructed', () => {
  const app = fairwaysAppData(51);

  test('A1 · the ported clock reproduces 74% / $20,302 on $27,500', () => {
    const r = differential(CO_0001, JOB, app);
    expect(r.mode).toBe('rider');
    expect(r.scopeName).toBe('Gutters');
    expect(r.sell).toBe(27500);
    expect(r.cost).toBe(27500);
    expect(r.profit).toBe(0);
    // The two figures off John's tab.
    expect(Math.round(r.weightedPct)).toBe(74);
    expect(Math.round(r.earned)).toBe(20302);
    // weightedPct IS Σ(rev·pct)/Σrev over the ridden scope's cells — nothing else.
    const scopeRev = FAIRWAYS_CELLS.reduce((s, p) => s + p.asSoldRevenue, 0);
    expect(scopeRev).toBe(110050);
    const hand = FAIRWAYS_CELLS.reduce((s, p) => s + p.asSoldRevenue * p.pctComplete, 0) / scopeRev;
    expect(r.weightedPct).toBeCloseTo(hand, 9);
  });

  test('A2 · computeJobWIP\'s coEarned equals the browser wrapper\'s earned', () => {
    const browser = preportCoCompletion(CO_0001, JOB, app);
    const shaped = jobMoney.shapeChangeOrderRow({
      id: 'co1', status: 'approved', co_number: 'CO-0001', linked_node_id: null,
      data: { lines: FAIRWAYS_LINES, defaultMarkup: 0, completionMode: 'rider', riderScopeName: 'Gutters', buildingAllocations: [] },
    });
    const wip = jobWip.computeJobWIP(
      { contractAmount: 300000, estimatedCosts: 200000, pctComplete: 51, ngRevenueEarned: 100000 },
      { phases: FAIRWAYS_CELLS, buildings: FAIRWAYS_BUILDINGS, changeOrders: [shaped] });
    // revenueEarned = ngRevenueEarned + coEarned, so coEarned is recoverable.
    expect(wip.revenueEarned - 100000).toBeCloseTo(browser.earned, 6);
    expect(Math.round(wip.revenueEarned - 100000)).toBe(20302);
  });

  test('A3 · the delta against the deleted formula, at a stored 51%', () => {
    const shaped = jobMoney.shapeChangeOrderRow({
      id: 'co1', status: 'approved', co_number: 'CO-0001', linked_node_id: null,
      data: { lines: FAIRWAYS_LINES, defaultMarkup: 0, completionMode: 'rider', riderScopeName: 'Gutters', buildingAllocations: [] },
    });
    const job = { contractAmount: 300000, estimatedCosts: 200000, pctComplete: 51, ngRevenueEarned: 100000 };
    const wip = jobWip.computeJobWIP(job, { phases: FAIRWAYS_CELLS, buildings: FAIRWAYS_BUILDINGS, changeOrders: [shaped] });
    const preport = 27500 * (51 / 100); // the DELETED `unlinkedIncome × pctComplete/100`
    expect(preport).toBe(14025);
    const after = wip.revenueEarned - 100000;
    expect(Math.round(after - preport)).toBe(6277); // +$6,277, direction pinned
    // …and it flows where the design says it flows.
    expect(wip.jtdProfit).toBeCloseTo(wip.revenueEarned - wip.actualCosts, 6);
    expect(wip.backlog).toBeCloseTo(wip.totalIncome - wip.revenueEarned, 6);
    expect(wip.unbilled).toBeCloseTo(wip.revenueEarned - wip.invoiced, 6);
  });

  test('A4 · $27,500 stays $27,500 — only the percentage moved', () => {
    const shaped = jobMoney.shapeChangeOrderRow({
      id: 'co1', status: 'approved', co_number: 'CO-0001', linked_node_id: null,
      data: { lines: FAIRWAYS_LINES, defaultMarkup: 0, completionMode: 'rider', riderScopeName: 'Gutters', buildingAllocations: [] },
    });
    expect(shaped.income).toBe(27500);
    expect(shaped.costs).toBe(27500);
    const wip = jobWip.computeJobWIP(
      { contractAmount: 300000, estimatedCosts: 200000, pctComplete: 51 },
      { phases: FAIRWAYS_CELLS, buildings: FAIRWAYS_BUILDINGS, changeOrders: [shaped] });
    expect(wip.coIncome).toBe(27500);
    expect(wip.coCosts).toBe(27500);
    expect(wip.totalIncome).toBe(327500);
  });

  test('A5 · the per-cell decomposition sums to the whole, B2 included', () => {
    const r = portedFromAppData(CO_0001, JOB, fairwaysAppData(51));
    const scopeRev = 110050;
    let sum = 0;
    for (const p of FAIRWAYS_CELLS) {
      const b = r.byBuilding[p.buildingId];
      expect(b.share).toBeCloseTo(27500 * (p.asSoldRevenue / scopeRev), 9);
      expect(b.pct).toBe(p.pctComplete);
      sum += b.earned;
    }
    expect(sum).toBeCloseTo(r.earned, 9);
    // B2: pctComplete 100, revenue 10905 — the row John named.
    expect(r.byBuilding.B2.pct).toBe(100);
    expect(r.byBuilding.B2.earned).toBeCloseTo(27500 * (10905 / scopeRev), 9);
    // placed === sell; unallocated is float dust, under every banner gate
    // (0.5 in nodegraph/ui.js, 0.005 in deriveSOV).
    expect(r.placed).toBeCloseTo(27500, 6);
    expect(Math.abs(r.unallocated)).toBeLessThan(0.005);
  });

  test('A6 · the mini-P&L strip is internally consistent and clock-free', () => {
    const r = portedFromAppData(CO_0001, JOB, fairwaysAppData(51));
    expect(r.profit).toBe(r.sell - r.cost);
    // Revenue/Cost/Profit do not move when the clock does.
    for (const pct of [0, 25, 74, 100]) {
      const swept = FAIRWAYS_CELLS.map((p) => Object.assign({}, p, { pctComplete: pct }));
      const s = coCompletion(CO_0001, { sell: 27500, cost: 27500, phases: swept, buildings: FAIRWAYS_BUILDINGS, storedPct: 51 });
      expect(s.sell).toBe(27500);
      expect(s.cost).toBe(27500);
      expect(s.profit).toBe(0);
      expect(s.earned).toBeCloseTo(27500 * pct / 100, 6);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('B · the grid — 0 / part / 100 × rider / own-scope / unallocated', () => {
  const L = [{ id: 'x', qty: 1, unitCost: 10000 }];
  const mkApp = (phases, buildings, storedPct) => ({
    jobs: [{ id: JOB, pctComplete: storedPct }], phases, buildings, jobChangeOrders: [],
  });

  test.each([0, 37.5, 100])('B1 · rider, per-building, every cell at %s%%', (pct) => {
    const phases = ['B1', 'B2', 'B3'].map((b, i) => ({
      jobId: JOB, phase: 'Roof', buildingId: b, asSoldRevenue: 1000 * (i + 1), pctComplete: pct,
    }));
    const blds = ['B1', 'B2', 'B3'].map((id) => ({ id, jobId: JOB }));
    const co = { id: 'c', job_id: JOB, lines: L, defaultMarkup: 0, completionMode: 'rider', riderScopeName: 'Roof' };
    const r = differential(co, JOB, mkApp(phases, blds, 51));
    expect(r.weightedPct).toBeCloseTo(pct, 9);
    expect(r.earned).toBeCloseTo(10000 * pct / 100, 6);
  });

  test('B2 · rider, per-building, VARYING cells — Σ(rev·pct)/Σrev by hand', () => {
    const phases = [
      { jobId: JOB, phase: 'Roof', buildingId: 'B1', asSoldRevenue: 1000, pctComplete: 100 },
      { jobId: JOB, phase: 'Roof', buildingId: 'B2', asSoldRevenue: 3000, pctComplete: 50 },
      { jobId: JOB, phase: 'Roof', buildingId: 'B3', asSoldRevenue: 6000, pctComplete: 0 },
    ];
    const blds = ['B1', 'B2', 'B3'].map((id) => ({ id, jobId: JOB }));
    const co = { id: 'c', job_id: JOB, lines: L, defaultMarkup: 0, completionMode: 'rider', riderScopeName: 'Roof' };
    const r = differential(co, JOB, mkApp(phases, blds, 51));
    // (1000×100 + 3000×50 + 6000×0) / 10000 = 25
    expect(r.weightedPct).toBeCloseTo(25, 9);
    expect(r.earned).toBeCloseTo(2500, 9);
    expect(r.byBuilding.B1.share).toBeCloseTo(1000, 9);
    expect(r.byBuilding.B3.share).toBeCloseTo(6000, 9);
  });

  test('B3 · scopeRev === 0 ⇒ even split, and weightedPct is the UNWEIGHTED mean', () => {
    const phases = [
      { jobId: JOB, phase: 'Roof', buildingId: 'B1', asSoldRevenue: 0, pctComplete: 90 },
      { jobId: JOB, phase: 'Roof', buildingId: 'B2', asSoldRevenue: 0, pctComplete: 30 },
    ];
    const blds = ['B1', 'B2'].map((id) => ({ id, jobId: JOB }));
    const co = { id: 'c', job_id: JOB, lines: L, defaultMarkup: 0, completionMode: 'rider', riderScopeName: 'Roof' };
    const r = differential(co, JOB, mkApp(phases, blds, 51));
    expect(r.byBuilding.B1.share).toBe(5000);
    expect(r.byBuilding.B2.share).toBe(5000);
    expect(r.weightedPct).toBeCloseTo(60, 9); // (90+30)/2, NOT revenue-weighted
  });

  test('B4 · job-level rider reads cells[0] ONLY; byBuilding {}, unallocated = sell', () => {
    const phases = [
      { jobId: JOB, phase: 'Roof', asSoldRevenue: 5000, pctComplete: 40 },
      { jobId: JOB, phase: 'Roof', asSoldRevenue: 5000, pctComplete: 100 },
    ];
    const co = { id: 'c', job_id: JOB, lines: L, defaultMarkup: 0, completionMode: 'rider', riderScopeName: 'Roof' };
    const r = differential(co, JOB, mkApp(phases, [], 51));
    expect(r.earned).toBeCloseTo(4000, 9); // cells[0] at 40%, cells[1] ignored
    expect(r.byBuilding).toEqual({});
    expect(r.placed).toBe(0);
    expect(r.unallocated).toBe(10000);
  });

  test('B5 · per-building branch WINS and EXCLUDES a job-level cell from scopeRev', () => {
    const withJobLevel = [
      { jobId: JOB, phase: 'Roof', asSoldRevenue: 500000, pctComplete: 0 },
      { jobId: JOB, phase: 'Roof', buildingId: 'B1', asSoldRevenue: 1000, pctComplete: 100 },
    ];
    const blds = [{ id: 'B1', jobId: JOB }];
    const co = { id: 'c', job_id: JOB, lines: L, defaultMarkup: 0, completionMode: 'rider', riderScopeName: 'Roof' };
    const r = differential(co, JOB, mkApp(withJobLevel, blds, 51));
    expect(r.earned).toBe(10000);        // the $500k job-level cell did not dilute it
    expect(Object.keys(r.byBuilding)).toEqual(['B1']);
  });

  test('B6 · a RENAMED scope earns $0 and says so — no fallback, even at 100%', () => {
    const phases = [{ jobId: JOB, phase: 'Roofing', buildingId: 'B1', asSoldRevenue: 1000, pctComplete: 100 }];
    const blds = [{ id: 'B1', jobId: JOB }];
    const co = { id: 'c', job_id: JOB, lines: L, defaultMarkup: 0, completionMode: 'rider', riderScopeName: 'Roof' };
    const r = differential(co, JOB, mkApp(phases, blds, 100));
    expect(r.riderScopeMissing).toBe(true);
    expect(r.earned).toBe(0);
    expect(r.weightedPct).toBe(0);
    expect(r.byBuilding).toEqual({});
    // And through the server: a stored 100% does not resurrect it.
    const shaped = jobMoney.shapeChangeOrderRow({
      id: 'c', status: 'approved', co_number: 'CO-9', linked_node_id: null,
      data: { lines: L, defaultMarkup: 0, completionMode: 'rider', riderScopeName: 'Roof' },
    });
    const wip = jobWip.computeJobWIP({ contractAmount: 0, pctComplete: 100, ngRevenueEarned: 0 },
      { phases, buildings: blds, changeOrders: [shaped] });
    expect(wip.revenueEarned).toBe(0);
  });

  test('B7 · NO TRIM — "Gutters " earns $0 while job-audit R11 calls it healthy', () => {
    const phases = [{ jobId: JOB, phase: 'Gutters ', buildingId: 'B1', asSoldRevenue: 1000, pctComplete: 100 }];
    const blds = [{ id: 'B1', jobId: JOB }];
    const co = { id: 'c', job_id: JOB, lines: L, defaultMarkup: 0, completionMode: 'rider', riderScopeName: 'Gutters' };
    const r = differential(co, JOB, mkApp(phases, blds, 51));
    expect(r.riderScopeMissing).toBe(true);
    expect(r.earned).toBe(0);
    // R11's predicate trims BOTH sides, so it sees a match and reports nothing.
    // The divergence is asserted, not repaired: trimming inside the clock would
    // RESTORE revenue on every whitespace-damaged CO, org-wide, inside a port.
    const AUDIT = raw('js', 'job-audit.js');
    expect(AUDIT).toMatch(/trim\(\)/);
    const r11Trimmed = phases.some((p) => String(p.phase || 'Unnamed').trim() === 'Gutters'.trim());
    expect(r11Trimmed).toBe(true);
    // The clock does not trim.
    expect(raw('js', 'co-completion.js')).not.toMatch(/scopeName\s*\.trim|\.trim\(\)\s*===/);
  });

  test('B8 · a cell stored at 150% contributes 100, and the module has no unclamped read', () => {
    const phases = [{ jobId: JOB, phase: 'Roof', buildingId: 'B1', asSoldRevenue: 1000, pctComplete: 150 }];
    const blds = [{ id: 'B1', jobId: JOB }];
    const co = { id: 'c', job_id: JOB, lines: L, defaultMarkup: 0, completionMode: 'rider', riderScopeName: 'Roof' };
    const r = differential(co, JOB, mkApp(phases, blds, 51));
    expect(r.earned).toBe(10000);
    expect(r.byBuilding.B1.pct).toBe(100);
    // The old p86Progress-absent fallbacks (`p.pctComplete || 0`, unclamped —
    // a stored 150 earned 150%) are deleted, not relocated. Scoped to the
    // wrapper body: js/jobs.js carries the same shape elsewhere, in the scope
    // matrix renderer, which is not this pass's lane.
    expect(raw('js', 'co-completion.js')).not.toMatch(/p\.pctComplete\s*\|\|\s*0/);
    const JOBS = raw('js', 'jobs.js');
    const wrapper = JOBS.slice(JOBS.indexOf('function coCompletion('), JOBS.indexOf('window.coCompletion = coCompletion;'));
    expect(wrapper).not.toMatch(/p86Progress/);
  });

  test('B9 · a CO riding the literal "Unnamed" matches an unnamed scope row', () => {
    const phases = [{ jobId: JOB, buildingId: 'B1', asSoldRevenue: 1000, pctComplete: 60 }];
    const blds = [{ id: 'B1', jobId: JOB }];
    const co = { id: 'c', job_id: JOB, lines: L, defaultMarkup: 0, completionMode: 'rider', riderScopeName: 'Unnamed' };
    const r = differential(co, JOB, mkApp(phases, blds, 51));
    expect(r.riderScopeMissing).toBe(false);
    expect(r.earned).toBeCloseTo(6000, 9);
  });

  test('B10 · a ZERO-REVENUE cell still gets a byBuilding key, with share 0', () => {
    const phases = [
      { jobId: JOB, phase: 'Roof', buildingId: 'B1', asSoldRevenue: 1000, pctComplete: 100 },
      { jobId: JOB, phase: 'Roof', buildingId: 'B2', asSoldRevenue: 0, pctComplete: 100 },
    ];
    const blds = ['B1', 'B2'].map((id) => ({ id, jobId: JOB }));
    const co = { id: 'c', job_id: JOB, lines: L, defaultMarkup: 0, completionMode: 'rider', riderScopeName: 'Roof' };
    const r = differential(co, JOB, mkApp(phases, blds, 51));
    expect(Object.keys(r.byBuilding)).toEqual(['B1', 'B2']);
    expect(r.byBuilding.B2.share).toBe(0);
    // The core filters NOTHING. deriveSOV's own `pct <= 0` skip is what keeps
    // it off the G703; moving that filter in here would change line ids.
    expect(raw('js', 'pay-applications.js')).toMatch(/if \(pct <= 0\) return;/);
  });

  test('B11 · the TRUTHY chain weights the rider; the NULL chain does not — both live', () => {
    // Saddlebrook shape: a dead explicit asSoldRevenue: 0 with the money below.
    const p = { jobId: JOB, phase: 'Roof', buildingId: 'B1', asSoldRevenue: 0, asSoldPhaseBudget: 5000, pctComplete: 50 };
    expect(phaseRevenueTruthy(p)).toBe(5000);
    expect(core.phaseRevenueNull(p)).toBe(0);
    // Deliberate, and asserted rather than unified: unifying moves browser money
    // AND moves byBuilding[].share, which is the one value a pay app reads.
    expect(core.jobPct([p], [])).toBe(0);
    const co = { id: 'c', job_id: JOB, lines: L, defaultMarkup: 0, completionMode: 'rider', riderScopeName: 'Roof' };
    const r = differential(co, JOB, mkApp([p], [{ id: 'B1', jobId: JOB }], 51));
    expect(r.earned).toBeCloseTo(5000, 9);
  });

  test('B12 · standalone — own %s, and a dead building\'s dollars land in unallocated', () => {
    const blds = [{ id: 'B1', jobId: JOB }];
    const co = {
      id: 'c', job_id: JOB, lines: L, defaultMarkup: 0, completionMode: 'standalone',
      buildingAllocations: [
        { buildingId: 'B1', pct: 60, pctComplete: 50 },
        { buildingId: 'GONE', pct: 40, pctComplete: 100 },
      ],
    };
    const r = differential(co, JOB, mkApp([], blds, 51));
    expect(r.byBuilding.B1.share).toBe(6000);
    expect(r.byBuilding.GONE).toBeUndefined();
    expect(r.earned).toBe(3000);
    expect(r.placed).toBe(6000);
    expect(r.unallocated).toBe(4000); // the deleted building's dollars, not vanished
  });

  test('B13 · a DEDUCTIVE CO earns negative and reports weightedPct 0 (a preserved wart)', () => {
    const negLines = [{ id: 'x', qty: 1, unitCost: -5000 }];
    const phases = [{ jobId: JOB, phase: 'Roof', buildingId: 'B1', asSoldRevenue: 1000, pctComplete: 60 }];
    const blds = [{ id: 'B1', jobId: JOB }];
    const co = { id: 'c', job_id: JOB, lines: negLines, defaultMarkup: 0, completionMode: 'rider', riderScopeName: 'Roof' };
    const r = differential(co, JOB, mkApp(phases, blds, 51));
    expect(r.sell).toBe(-5000);
    expect(r.earned).toBeCloseTo(-3000, 9);
    expect(r.weightedPct).toBe(0); // sell > 0 ? … : 0
  });

  test('B14 · legacy + scopes = LIVE jobPct, not the stored scalar', () => {
    const phases = [{ jobId: JOB, phase: 'Roof', buildingId: 'B1', asSoldRevenue: 1000, pctComplete: 62 }];
    const blds = [{ id: 'B1', jobId: JOB }];
    const co = { id: 'c', job_id: JOB, lines: L, defaultMarkup: 0 }; // no completionMode
    const r = differential(co, JOB, mkApp(phases, blds, 51));
    expect(r.mode).toBe('legacy');
    expect(r.earned).toBeCloseTo(6200, 9);   // live 62%
    expect(r.earned).not.toBeCloseTo(5100, 6); // NOT the stored 51%
  });

  test('B15 · legacy + NO scopes = the stored scalar, byte-identical to the deleted formula', () => {
    const co = { id: 'c', job_id: JOB, lines: L, defaultMarkup: 0 };
    const r = differential(co, JOB, mkApp([], [], 51));
    expect(r.mode).toBe('legacy');
    expect(r.earned).toBe(10000 * 51 / 100);
    expect(r.earned).toBe(5100);
    // THE NO-REGRESSION ANCHOR: the ctx MUST carry storedPct. Without it this
    // is $0 — a straight revenue regression on both sides, hidden in a port.
    const noStored = coCompletion(co, { sell: 10000, cost: 10000, phases: [], buildings: [] });
    expect(noStored.earned).toBe(0);
    expect(raw('js', 'jobs.js')).toMatch(/storedPct:/);
    expect(raw('server', 'services', 'money', 'job-wip.js')).toMatch(/storedPct,/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('C · shapes and plumbing', () => {
  const L = [{ id: 'x', qty: 1, unitCost: 10000 }];
  const phases = [{ jobId: JOB, phase: 'Roof', buildingId: 'B1', asSoldRevenue: 1000, pctComplete: 60 }];
  const blds = [{ id: 'B1', jobId: JOB }];
  const ctx = { sell: 10000, cost: 10000, phases, buildings: blds, storedPct: 51 };

  test('C1 · flat, nested and raw-row shapes produce identical output', () => {
    const flat = { id: 'c', completionMode: 'rider', riderScopeName: 'Roof' };
    const nested = { id: 'c', lines: L, data: { completionMode: 'rider', riderScopeName: 'Roof' } };
    const rawRow = { status: 'approved', co_number: 'CO-1', data: { completionMode: 'rider', riderScopeName: 'Roof' } };
    const a = coCompletion(flat, ctx), b = coCompletion(nested, ctx), c = coCompletion(rawRow, ctx);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(a.earned).toBeCloseTo(6000, 9);
  });

  test('C2 · shapeChangeOrderRow carries the three completion fields', () => {
    const s = jobMoney.shapeChangeOrderRow({
      id: 'x', status: 'approved', co_number: 'CO-1', linked_node_id: null,
      data: { lines: L, completionMode: 'rider', riderScopeName: 'Gutters', buildingAllocations: [{ buildingId: 'B1', pct: 100 }] },
    });
    expect(s.completionMode).toBe('rider');
    expect(s.riderScopeName).toBe('Gutters');
    expect(s.buildingAllocations).toEqual([{ buildingId: 'B1', pct: 100 }]);
  });

  test('C3 · shapeLegacyChangeOrder carries them EMPTY ⇒ legacy branch ⇒ same money', () => {
    const s = jobMoney.shapeLegacyChangeOrder({ id: 'old', income: 10000, costs: 4000, status: 'approved' });
    expect(s.completionMode).toBe('');
    expect(s.riderScopeName).toBe('');
    expect(s.buildingAllocations).toEqual([]);
    // On a job with NO phases this is byte-identical to the deleted formula.
    const wip = jobWip.computeJobWIP({ contractAmount: 0, pctComplete: 51, ngRevenueEarned: 0 },
      { phases: [], buildings: [], changeOrders: [s] });
    expect(wip.revenueEarned).toBe(10000 * 0.51);
  });

  test('C4 · old-shaped rows (fields absent) take the legacy branch — no crash, no silent 0', () => {
    const legacyRow = { id: 'old', income: 10000, costs: 0 }; // no completionMode key at all
    const wip = jobWip.computeJobWIP({ contractAmount: 0, pctComplete: 51, ngRevenueEarned: 0 },
      { phases: [], buildings: [], changeOrders: [legacyRow] });
    expect(wip.revenueEarned).toBe(5100);
  });

  test('C5 · a graph-LINKED CO is excluded, exactly as unlinkedIncome excluded it', () => {
    const linked = { id: 'c', income: 10000, costs: 0, linked_node_id: 'n1', completionMode: '' };
    const wip = jobWip.computeJobWIP({ contractAmount: 0, pctComplete: 51, ngRevenueEarned: 7000 },
      { phases: [], buildings: [], changeOrders: [linked] });
    expect(wip.revenueEarned).toBe(7000); // its earned lives in ngRevenueEarned
    expect(wip.coIncome).toBe(10000);     // but its money still joins the contract
  });

  test('C6 · a draft CO earns nothing — income 0 from the shaper is the whole gate', () => {
    const s = jobMoney.shapeChangeOrderRow({
      id: 'x', status: 'draft', co_number: 'CO-2', linked_node_id: null,
      data: { lines: L, completionMode: 'rider', riderScopeName: 'Roof' },
    });
    expect(s.income).toBe(0);
    const wip = jobWip.computeJobWIP({ contractAmount: 0, pctComplete: 51, ngRevenueEarned: 0 },
      { phases, buildings: blds, changeOrders: [s] });
    expect(wip.revenueEarned).toBe(0);
  });

  test('C7 · the ngRevenueEarned == null branch still DISCARDS coEarned', () => {
    const s = jobMoney.shapeChangeOrderRow({
      id: 'x', status: 'approved', co_number: 'CO-3', linked_node_id: null,
      data: { lines: L, defaultMarkup: 0, completionMode: 'rider', riderScopeName: 'Roof' },
    });
    const wip = jobWip.computeJobWIP({ contractAmount: 90000, estimatedCosts: 0, pctComplete: 51 },
      { phases, buildings: blds, changeOrders: [s] });
    // totalIncome × storedPct — the CO's 60% scope clock is computed and dropped,
    // true on BOTH sides today and preserved here.
    expect(wip.revenueEarned).toBeCloseTo(100000 * 0.51, 6);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('D · the blast radius — what this port may NOT touch', () => {
  test('D1 · the COST clock did not move: storedPct and only storedPct accrues', () => {
    // A job whose scope clock (74%) and stored scalar (51%) disagree.
    const po = { id: 'po1', sub_id: 's1', status: 'issued', lines: [{ qty: 1, unitCost: 104967 }] };
    const wip = jobWip.computeJobWIP(
      { contractAmount: 300000, estimatedCosts: 0, pctComplete: 51 },
      { phases: FAIRWAYS_CELLS, buildings: FAIRWAYS_BUILDINGS, changeOrders: [],
        purchaseOrders: [po], vendorBills: [], subs: [] });
    expect(wip.poAccrued).toBeCloseTo(104967 * 0.51, 6);
    expect(wip.poAccrued).not.toBeCloseTo(104967 * 0.74, 2);
    // Static: the live scope clock must never appear in the accrual arguments.
    const WIP = raw('server', 'services', 'money', 'job-wip.js');
    expect(WIP).toMatch(/poAccruedOf\(purchaseOrders, vendorBills, storedPct\)/);
    expect(WIP).toMatch(/subAccruedOf\(job, subs, purchaseOrders, storedPct\)/);
    // Exactly ONE call site each, so the positive matches above are exhaustive.
    expect((WIP.match(/^\s*const poAccrued = poAccruedOf\(/gm) || [])).toHaveLength(1);
    expect((WIP.match(/^\s*const accruedCosts = subAccruedOf\(/gm) || [])).toHaveLength(1);
    // And the LIVE scope clock never enters this file at all — it stays inside
    // js/co-completion.js, reached only through the per-CO earned loop. One
    // variable feeding both revenue and cost is how the defect happened once.
    expect(WIP).not.toMatch(/progress-core|p86ProgressCore|livePct/);
  });

  test('D2 · billed dollars leave accrued and land in actual — untouched', () => {
    const po = { id: 'po1', sub_id: 's1', status: 'issued', lines: [{ qty: 1, unitCost: 100000 }] };
    const bills = [{ po_id: 'po1', amount: 30000, status: 'open' }];
    const wip = jobWip.computeJobWIP({ contractAmount: 0, pctComplete: 50 },
      { phases: [], buildings: [], changeOrders: [], purchaseOrders: [po], vendorBills: bills, subs: [] });
    expect(wip.poAccrued).toBe(20000);   // 50,000 earned − 30,000 billed
    expect(wip.billedCost).toBe(30000);
    expect(wip.actualCosts).toBe(30000);
  });

  test('D3 · `unlinkedIncome` is GONE — not deprecated, not kept as a fallback', () => {
    const t = jobWip.coTotals([{ income: 100, costs: 10, linked_node_id: null }]);
    expect(t.unlinkedIncome).toBeUndefined();
    expect(t.income).toBe(100);
    expect(t.costs).toBe(10);
    expect(t.count).toBe(1);
    const WIP = raw('server', 'services', 'money', 'job-wip.js');
    // The deleted formula, in any spelling.
    expect(WIP).not.toMatch(/unlinkedIncome\s*\*/);
    expect(WIP).not.toMatch(/let income = 0, costs = 0, unlinkedIncome/);
  });

  test('D4 · exactly ONE body — js/jobs.js keeps a wrapper, not a copy', () => {
    const JOBS = raw('js', 'jobs.js');
    const i = JOBS.indexOf('function coCompletion(');
    expect(i).toBeGreaterThan(-1);
    const body = JOBS.slice(i, JOBS.indexOf('window.coCompletion = coCompletion;'));
    expect(body).toMatch(/window\.p86CoCompletion\.coCompletion\(co, \{/);
    // None of the three branch bodies survive here.
    expect(body).not.toMatch(/riderScopeMissing/);
    expect(body).not.toMatch(/mode === 'standalone'/);
    expect(body).not.toMatch(/scopeRev/);
    expect(body).not.toMatch(/byBuilding:/);
    // …and js/progress.js keeps no arithmetic either.
    const PROG = raw('js', 'progress.js');
    expect(PROG).toMatch(/window\.p86ProgressCore/);
    expect(PROG).not.toMatch(/asSoldPhaseBudget/);
    expect(PROG).not.toMatch(/earned \/ rev/);
  });

  test('D5 · costDraws / costSource still have ZERO money-path consumers', () => {
    for (const rel of [['server', 'services', 'money', 'job-wip.js'],
      ['server', 'services', 'money', 'change-order-totals.js'],
      ['server', 'services', 'money', 'job-cost-buckets.js'],
      ['server', 'services', 'money', 'cost-line-filters.js'],
      ['js', 'co-completion.js'],
      ['js', 'progress-core.js']]) {
      expect(raw(...rel)).not.toMatch(/costDraws|costSource/);
    }
  });

  test('D6 · the money layer still has never heard of the pricing model', () => {
    for (const rel of [['server', 'services', 'money', 'job-wip.js'],
      ['js', 'co-completion.js'], ['js', 'progress-core.js']]) {
      expect(raw(...rel)).not.toMatch(/unitSell|lockedSell|lockedSubtotal|resolveMarkedUp|applyTargetMargin|computeForLines/);
      expect(raw(...rel)).not.toMatch(/require\(.*pricing-pipeline/);
    }
  });

  test('D7 · ORDER cannot move a cent — reverse the phases array, same money', () => {
    const co = CO_0001;
    const fwd = coCompletion(co, { sell: 27500, cost: 27500, phases: FAIRWAYS_CELLS, buildings: FAIRWAYS_BUILDINGS, storedPct: 51 });
    const rev = coCompletion(co, { sell: 27500, cost: 27500, phases: FAIRWAYS_CELLS.slice().reverse(), buildings: FAIRWAYS_BUILDINGS.slice().reverse(), storedPct: 51 });
    const r2 = (n) => Math.round(n * 100) / 100;
    expect(r2(rev.earned)).toBe(r2(fwd.earned));
    expect(rev.weightedPct).toBeCloseTo(fwd.weightedPct, 9);
    for (const k of Object.keys(fwd.byBuilding)) {
      expect(r2(rev.byBuilding[k].share)).toBe(r2(fwd.byBuilding[k].share));
      expect(rev.byBuilding[k].pct).toBe(fwd.byBuilding[k].pct);
    }
    // Order DOES decide printed G703 row order, and that is the caller's array —
    // which is why nothing in here sorts.
    expect(Object.keys(rev.byBuilding)).toEqual(Object.keys(fwd.byBuilding).reverse());
    expect(raw('js', 'co-completion.js')).not.toMatch(/\.sort\(/);
    expect(raw('js', 'progress-core.js')).not.toMatch(/\.sort\(/);
  });

  test('D8 · a job with NO change order at all is byte-identical to pre-port', () => {
    const job = { contractAmount: 500000, estimatedCosts: 400000, pctComplete: 42, ngRevenueEarned: 210000 };
    const deps = { phases: FAIRWAYS_CELLS, buildings: FAIRWAYS_BUILDINGS, changeOrders: [] };
    const wip = jobWip.computeJobWIP(job, deps);
    expect(wip.revenueEarned).toBe(210000);          // ng + 0
    expect(wip.coIncome).toBe(0);
    expect(wip.pctComplete).toBe(42);                 // still the stored scalar
    const noGraph = jobWip.computeJobWIP({ contractAmount: 500000, estimatedCosts: 0, pctComplete: 42 }, deps);
    expect(noGraph.revenueEarned).toBe(500000 * 0.42);
  });

  test('D9 · the reported pctComplete is STILL the stored scalar (guest-visible; not in this pass)', () => {
    const wip = jobWip.computeJobWIP({ contractAmount: 100, pctComplete: 51 },
      { phases: FAIRWAYS_CELLS, buildings: FAIRWAYS_BUILDINGS, changeOrders: [] });
    expect(wip.pctComplete).toBe(51);   // NOT the live 73.8% the browser reports
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('E · load order and cache-busting — the containment', () => {
  const HTML = raw('index.html');
  const at = (f) => HTML.indexOf('src="' + f);

  test('E1 · both new files are in index.html, cache-busted', () => {
    expect(HTML).toMatch(/src="js\/progress-core\.js\?v=\d/);
    expect(HTML).toMatch(/src="js\/co-completion\.js\?v=\d/);
  });

  test('E2 · progress-core loads before progress.js, co-completion, and jobs.js', () => {
    const coreAt = at('js/progress-core.js');
    expect(coreAt).toBeGreaterThan(-1);
    for (const dep of ['js/co-completion.js', 'js/progress.js', 'js/jobs.js']) {
      expect(at(dep)).toBeGreaterThan(coreAt);
    }
    expect(at('js/jobs.js')).toBeGreaterThan(at('js/co-completion.js'));
  });

  test('E3 · both edited files got a ?v bump in the same commit', () => {
    expect(HTML).toMatch(/src="js\/progress\.js\?v=4"/);
    expect(HTML).toMatch(/src="js\/jobs\.js\?v=230"/);
  });

  test('E4 · a missing core THROWS — it does not degrade', () => {
    // A silent degrade would leave deriveSOV's `typeof window.coCompletion ===
    // "function"` guard passing, then fall to allocs = c.buildingAllocations
    // ([] for a rider), collapsing ten G703 lines into one General line under a
    // new id and re-billing the whole CO in a single draw.
    expect(raw('js', 'co-completion.js')).toMatch(/throw new Error\('js\/co-completion\.js requires/);
    expect(raw('js', 'progress.js')).toMatch(/throw new Error\('js\/progress\.js requires/);
  });
});
