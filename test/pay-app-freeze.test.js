'use strict';

/**
 * pay-app-freeze.test.js — THE RED LINE.
 *
 * G702/G703 and pay applications are the red line on the one-clock port: a CO
 * allocation that has already been invoiced must not silently reprice. `test/`
 * had 107 files and ZERO covering pay_applications, so "nothing issued
 * restates" was an argument, not a fact. This makes it a fact.
 *
 * FOUR INDEPENDENT FREEZES, each asserted below:
 *   1. STORED    data.lines[] is the period's snapshot — no FK to any CO,
 *                phase or building.
 *   2. READ      shapeRow returns data.lines as-is; the GETs join `jobs` for
 *                labels only.
 *   3. RENDERED  every G702/G703 cell traces to computeSummary / lineG /
 *                lineRetPct, all pure over stored lines.
 *   4. BILLING % CO lines are born pctComplete 0, pullProgress skips them, and
 *                only a human typing sets one.
 *
 * AND THE ONE TIE THAT DOES EXIST: deriveSOV reads exactly ONE field off the
 * completion clock — `byBuilding[bid].share` — and divides it by the same
 * `sell` it computed itself, so the percentage cancels:
 *      pct_b = (sell × phaseRevenue(b)/scopeRev) / sell × 100
 * Move the clock from 74% to 0% or 100% and B2's scheduled value does not
 * budge. That is swept, per building, below.
 *
 * THE REAL EXPOSURE is line-ID IDENTITY on the NEXT application, not the last
 * one: `previous` carries forward by line id, and rider CO ids are
 * 'ln_co_<id>__<buildingId>' — a function of WHICH BUILDINGS APPEAR in
 * byBuilding. Three natural-looking "cleanups" would corrupt the next G703, so
 * each is pinned as forbidden:
 *   (a) filtering phaseRevenue(p) > 0 when building perB;
 *   (b) making the job-level rider branch populate byBuilding;
 *   (c) adding the fallback riderScopeMissing refuses.
 * Row POSITION is pinned too — deriveSOV pushes CO lines in
 * Object.keys(byBuilding) order, so insertion order is printed G703 row order.
 */

const path = require('path');
const fs = require('fs');
const vm = require('vm');

const pricing = require('../js/pricing-pipeline.js');
const { coCompletion } = require('../js/co-completion.js');
const bsort = require('../js/building-sort.js');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'pay-applications.js'), 'utf8');
const raw = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

// ── Run the SHIPPED source, not a copy of it ──────────────────────────────
// Brace-matched extraction of the real function bodies out of the IIFE, then
// evaluated in a sandbox. If someone rewrites deriveSOV, this test runs the
// rewrite — which is the only way a freeze proof is worth anything.
function extract(name) {
  const head = SRC.indexOf('function ' + name + '(');
  if (head < 0) throw new Error('pay-applications.js no longer defines ' + name);
  let i = SRC.indexOf('{', head), depth = 0;
  for (let j = i; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}') { depth--; if (depth === 0) return SRC.slice(head, j + 1); }
  }
  throw new Error('unbalanced braces extracting ' + name);
}

function harness(appData) {
  const win = {
    appData,
    p86BuildingSort: bsort.p86BuildingSort,
    coSellAmount(c) {
      const lines = Array.isArray(c && c.lines) ? c.lines : [];
      if (!lines.length) return 0;
      const per = pricing.computeForLines(c, lines);
      return pricing.applyFeesAndTax(pricing.resolveMarkedUp(per, c), c).total;
    },
    coCompletion(c, jobId) {
      const lines = Array.isArray(c && c.lines) ? c.lines : [];
      const per = lines.length ? pricing.computeForLines(c, lines) : null;
      const job = (appData.jobs || []).find((j) => j.id === jobId);
      return coCompletion(c, {
        sell: per ? pricing.applyFeesAndTax(pricing.resolveMarkedUp(per, c), c).total : 0,
        cost: per ? (per.subtotal || 0) : 0,
        phases: (appData.phases || []).filter((p) => p && p.jobId === jobId),
        buildings: (appData.buildings || []).filter((b) => b && b.jobId === jobId),
        storedPct: (job && job.pctComplete) || 0,
      });
    },
  };
  const ctx = vm.createContext({ window: win, appData, console });
  ctx.globalThis = ctx;
  const code = [extract('num'), extract('round2'), extract('bldgSort'),
    extract('lineRetPct'), extract('lineG'), extract('lineThisPeriod'),
    extract('computeSummary'), extract('deriveSOV')].join('\n');
  vm.runInContext(code + '\n;({deriveSOV, computeSummary, lineG, lineRetPct, lineThisPeriod});', ctx);
  return vm.runInContext('({deriveSOV, computeSummary, lineG, lineRetPct, lineThisPeriod})', ctx);
}

// ── Fairways CO-0001 ──────────────────────────────────────────────────────
const JOB = 'j1783317122508';
const LINES = Array.from({ length: 10 }, (_, i) => ({ id: 'l' + i, qty: 1, unitCost: 2750 }));
const REV = [11000, 10905, 11500, 10500, 11250, 10800, 11100, 10995, 11000, 11000];
const PCT = [100, 100, 90, 80, 75, 70, 65, 60, 50, 48];

function fixture(pcts) {
  const phases = REV.map((r, i) => ({
    id: 'p' + i, jobId: JOB, phase: 'Gutters', buildingId: 'B' + (i + 1),
    asSoldRevenue: r, asSoldPhaseBudget: r, phaseBudget: r,
    pctComplete: pcts ? pcts[i] : PCT[i],
  }));
  const buildings = REV.map((_, i) => ({ id: 'B' + (i + 1), jobId: JOB, name: 'Building ' + (i + 1) }));
  const co = {
    id: 'co1', job_id: JOB, status: 'approved', co_number: 'CO-0001', title: 'Gutters',
    lines: LINES, defaultMarkup: 0, completionMode: 'rider', riderScopeName: 'Gutters',
    buildingAllocations: [],
  };
  return { jobs: [{ id: JOB, contractAmount: 300000, pctComplete: 51 }], phases, buildings, jobChangeOrders: [co] };
}

const coLines = (sov) => sov.lines.filter((l) => l.type === 'co');

describe('the schedule of values is invariant to the completion clock', () => {
  test('CO line ids, amounts AND POSITIONS survive a 0 → 100 sweep of every cell', () => {
    const base = harness(fixture()).deriveSOV(JOB);
    const baseCo = coLines(base);
    // Ten per-building lines, one per Gutters cell…
    expect(baseCo.filter((l) => l.buildingId !== '__gen').map((l) => l.id))
      .toEqual(REV.map((_, i) => 'ln_co_co1__B' + (i + 1)));
    // …plus, on these unequal shares, a ONE-CENT General residue line. That is
    // deriveSOV absorbing the per-line 2dp rounding so the emitted lines sum
    // EXACTLY to round2(sell): 10 rounded shares come to $27,499.99. It is a
    // rounding artifact of the revenue SPLIT, not of the clock — which is why
    // it must be present or absent identically across the sweep below.
    const genBase = baseCo.filter((l) => l.buildingId === '__gen');
    expect(genBase).toHaveLength(1);
    expect(genBase[0].scheduledValue).toBe(0.01);
    expect(genBase[0].description).toMatch(/\(unallocated\)$/);
    // Σ CO lines === round2(sell) exactly — no penny created or lost on G702
    // line 2. $27,500 in, $27,500 out.
    const sum = baseCo.reduce((s, l) => s + l.scheduledValue, 0);
    expect(Math.round(sum * 100) / 100).toBe(27500);

    for (const sweep of [0, 1, 50, 99, 100]) {
      const s = harness(fixture(REV.map(() => sweep))).deriveSOV(JOB);
      const c = coLines(s);
      expect(c.map((l) => l.id)).toEqual(baseCo.map((l) => l.id));
      expect(c.map((l) => l.scheduledValue)).toEqual(baseCo.map((l) => l.scheduledValue));
      expect(c.map((l) => l.buildingId)).toEqual(baseCo.map((l) => l.buildingId));
      expect(c.map((l) => l.description)).toEqual(baseCo.map((l) => l.description));
      // Every CO line is born at 0% no matter what the scope reads.
      expect(c.every((l) => l.pctComplete === 0)).toBe(true);
      // POSITION within the whole schedule, not just within the CO block —
      // deriveSOV pushes CO lines in Object.keys(byBuilding) order, so
      // insertion order IS printed G703 row order.
      expect(s.lines.map((l) => l.id)).toEqual(base.lines.map((l) => l.id));
    }
  });

  test('the share deriveSOV divides is percentage-free by cancellation', () => {
    const phases = fixture().phases;
    const buildings = fixture().buildings;
    const scopeRev = REV.reduce((s, r) => s + r, 0);
    for (const sweep of [0, 37, 100]) {
      const r = coCompletion(
        { completionMode: 'rider', riderScopeName: 'Gutters' },
        { sell: 27500, cost: 27500, phases: phases.map((p) => Object.assign({}, p, { pctComplete: sweep })), buildings, storedPct: 51 });
      REV.forEach((rev, i) => {
        // pct_b = share/sell × 100 = phaseRevenue(b)/scopeRev × 100 — no clock.
        expect(r.byBuilding['B' + (i + 1)].share / 27500 * 100).toBeCloseTo(rev / scopeRev * 100, 9);
      });
    }
  });

  test('a rider CO on a job with NO buildings bills as one General line — unchanged', () => {
    const app = fixture();
    app.phases = [{ id: 'pj', jobId: JOB, phase: 'Gutters', asSoldRevenue: 50000, pctComplete: 40 }];
    app.buildings = [];
    const sov = harness(app).deriveSOV(JOB);
    const c = coLines(sov);
    expect(c.map((l) => l.id)).toEqual(['ln_co_co1']);
    expect(c[0].buildingId).toBe('__gen');
    expect(c[0].scheduledValue).toBe(27500);
  });
});

describe('rendering and export are pure over STORED lines', () => {
  const stored = {
    id: 'app1', status: 'certified', retainage_pct: 10,
    lines: [
      { id: 'ln_Gutters__B1', type: 'phase', scheduledValue: 11000, pctComplete: 50, stored: 0, retainagePct: null, previous: 3000 },
      { id: 'ln_co_co1__B1', type: 'co', scheduledValue: 2749.66, pctComplete: 25, stored: 100, retainagePct: 5, previous: 200 },
    ],
  };

  test('G702 lines 1-9 do not move when every phase and CO in the fixture changes', () => {
    const before = harness(fixture()).computeSummary(stored);
    const wild = fixture(REV.map(() => 100));
    wild.phases.forEach((p) => { p.asSoldRevenue = 999999; p.phase = 'Renamed'; });
    wild.jobChangeOrders[0].riderScopeName = 'Gone';
    wild.jobChangeOrders[0].lines = [{ id: 'z', qty: 1, unitCost: 999999 }];
    const after = harness(wild).computeSummary(stored);
    expect(after).toEqual(before);
    // and the figures themselves, computed by hand off the stored lines:
    expect(before.original).toBe(11000);
    expect(before.co).toBe(2749.66);
    expect(before.contract).toBe(13749.66);
    // G = C×pct/100 + stored ⇒ 5500 + (687.42 + 100) = 6287.42
    expect(before.completedStored).toBeCloseTo(5500 + 787.42, 6);
    // retainage = 5500×10% + 787.42×5%
    expect(before.retainage).toBeCloseTo(550 + 39.371, 6);
  });

  test('a stored pay application carries NO key that could re-derive money', () => {
    for (const l of stored.lines) {
      expect(l).not.toHaveProperty('riderScopeName');
      expect(l).not.toHaveProperty('completionMode');
      expect(l).not.toHaveProperty('phaseId');
      expect(l).not.toHaveProperty('coId');
    }
  });
});

describe('the server never re-derives an application', () => {
  const ROUTES = raw('server', 'routes', 'pay-application-routes.js');

  test('shapeRow returns data.lines as-is', () => {
    expect(ROUTES).toMatch(/lines:\s*Array\.isArray\(data\.lines\) \? data\.lines : \[\]/);
    expect(ROUTES).not.toMatch(/deriveSOV|coCompletion|phaseRevenue/);
  });

  test('no pay-application query touches job_change_orders or jobs.data.phases', () => {
    expect(ROUTES).not.toMatch(/job_change_orders/);
    expect(ROUTES).not.toMatch(/data->'phases'|data->>'phases'/);
  });

  test('the invoice bridge computes only from stored line fields', () => {
    const INV = raw('server', 'routes', 'invoice-routes.js');
    expect(INV).not.toMatch(/coCompletion|deriveSOV|riderScopeName/);
  });

  test('KNOWN GAP, reported not repaired: PUT blocks only `paid` while DELETE blocks certified too', () => {
    // The UI tells the user certification locks the SOV
    // (js/pay-applications.js appEditable), but that lock is CLIENT-ONLY. This
    // port does not touch the route, and closing the hole is a change on its
    // own merits — but it is the one door through which a re-derived schedule
    // could reach a signed document, so it is pinned here rather than left to
    // be rediscovered.
    expect(ROUTES).toMatch(/status === 'paid'/);
    expect(raw('js', 'pay-applications.js')).toMatch(/status === 'certified' \|\| app\.status === 'paid'/);
  });
});

describe('the three forbidden cleanups stay forbidden', () => {
  const CORE = raw('js', 'co-completion.js');

  test('(a) perB is NOT filtered on phaseRevenue > 0 — a $0 building keeps its line id', () => {
    const app = fixture();
    app.phases[4].asSoldRevenue = 0; app.phases[4].asSoldPhaseBudget = 0; app.phases[4].phaseBudget = 0;
    const r = coCompletion(app.jobChangeOrders[0], {
      sell: 27500, cost: 27500, phases: app.phases, buildings: app.buildings, storedPct: 51 });
    expect(Object.keys(r.byBuilding)).toHaveLength(10);
    expect(r.byBuilding.B5.share).toBe(0);
    expect(CORE).not.toMatch(/filter\([^)]*phaseRevenueTruthy\([^)]*\)\s*>\s*0/);
  });

  test('(b) the job-level rider branch returns byBuilding {} — it does not populate', () => {
    const r = coCompletion({ completionMode: 'rider', riderScopeName: 'Gutters' }, {
      sell: 27500, cost: 27500,
      phases: [{ jobId: JOB, phase: 'Gutters', asSoldRevenue: 50000, pctComplete: 40 }],
      buildings: [{ id: 'B1', jobId: JOB }], storedPct: 51 });
    expect(r.byBuilding).toEqual({});
    expect(r.unallocated).toBe(27500);
  });

  test('(c) riderScopeMissing has NO fallback — $0 stays $0 and stays loud', () => {
    const r = coCompletion({ completionMode: 'rider', riderScopeName: 'Gutters' }, {
      sell: 27500, cost: 27500,
      phases: [{ jobId: JOB, phase: 'Guttering', buildingId: 'B1', asSoldRevenue: 50000, pctComplete: 100 }],
      buildings: [{ id: 'B1', jobId: JOB }], storedPct: 100 });
    expect(r.riderScopeMissing).toBe(true);
    expect(r.earned).toBe(0);
    expect(Object.keys(r.byBuilding)).toHaveLength(0);
    // No branch anywhere re-reads storedPct once the scope is missing.
    const rider = CORE.slice(CORE.indexOf("if (mode === 'rider')"), CORE.indexOf("if (mode === 'standalone')"));
    expect(rider).not.toMatch(/storedPct/);
  });
});

describe('the building sort and every money distribution are untouched', () => {
  test('p86SortBuildings still returns a COPY — it cannot reorder a distribution', () => {
    const src = [{ id: 'b', name: 'B 2' }, { id: 'a', name: 'B 1' }];
    const out = bsort.p86SortBuildings(src);
    expect(out).not.toBe(src);
    expect(src.map((b) => b.id)).toEqual(['b', 'a']);
    expect(out.map((b) => b.id)).toEqual(['a', 'b']);
  });

  test('the largest-remainder walk is standalone-only — a rider never enters it', () => {
    const UI = raw('nodegraph', 'ui.js');
    const save = UI.indexOf("if(coMode!=='rider')");
    expect(save).toBeGreaterThan(-1);
    // The walk lives INSIDE that guard: largest-remainder over pct×100 (basis
    // points), so its unit is 0.01 percentage points = sell/10,000 = $2.75 per
    // building on Fairways' $27,500. Not a penny — and CO-0001's
    // `buildingAllocations: []` is the proof a rider never enters it at all.
    const guarded = UI.slice(save, save + 900);
    expect(guarded).toMatch(/Math\.floor\(v\s*\*\s*100\)/);
    expect(guarded).toMatch(/floors\[order\[k\]\.i\]\s*\+=\s*1/);
    expect(27500 * 0.01 / 100).toBe(2.75);
  });

  test('the completion core never sorts, and the money split follows the caller\'s order', () => {
    expect(raw('js', 'co-completion.js')).not.toMatch(/\.sort\(/);
    expect(raw('js', 'progress-core.js')).not.toMatch(/\.sort\(/);
  });
});
