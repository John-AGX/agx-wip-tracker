/**
 * @jest-environment jsdom
 */
/* ──────────────────────────────────────────────────────────────────────────
 * CENTS IN THE CONTRACT ALLOCATION.
 *
 * John: "i need to be able to add cents to the contract allocation table, not
 * rounding". Two things were rounding, and only one of them was the obvious
 * one.
 *
 *   1. The inputs were <input type="number" step="100">. A browser treats any
 *      value that is not a multiple of the step as INVALID: the spinner jumps
 *      $100 at a time and on mobile the entry is silently refused. That is the
 *      symptom John reported.
 *
 *   2. Behind it, recomputePhasePctAllocation split a % -mode scope with a
 *      WHOLE-DOLLAR largest-remainder — Math.floor(exact) per cell, integer
 *      remainders handed out one dollar at a time. So even with the attribute
 *      fixed, a $10,000.50 scope total came back as $10,001 of cells: the
 *      cents were not merely dropped, fifty of them were INVENTED, and the row
 *      total input said one number while the footer summed to another.
 *
 * Once cents are enterable the columns still have to tie, and the ways they
 * can stop tying are all in this file:
 *
 *   - the split has to be exact to the cent, not to the dollar;
 *   - the footers have to sum the SAME revenue chain the cells render from
 *     (they did not — see "the live footer and the painted footer");
 *   - a % split that genuinely under-allocates has to SAY SO rather than let
 *     the row total and the column totals disagree in silence;
 *   - and no dollar may reach a record carrying binary residue, because three
 *     separate comparisons in this path (`money === 0` in
 *     pruneEmptyUnassignedPhases, `phaseDollar(r) > 0` in phasePctShares and
 *     in allocCoveredSet) change their answer on 5.55e-17.
 *
 * Everything below runs the REAL functions, lifted out of js/jobs.js with
 * test/helpers/browser-fn.js. js/jobs.js is a bare IIFE with no export seam,
 * and the alternative — a model of the arithmetic — is green for exactly as
 * long as the bug is live. Anything that changes inside these functions
 * changes what these tests run.
 * ────────────────────────────────────────────────────────────────────────── */
'use strict';

const fs = require('fs');
const path = require('path');
const { extractFunction, compile } = require('./helpers/browser-fn.js');

const JOBS_SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'jobs.js'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');

/* _bldgNumSort delegates to window.p86BuildingSort — the one comparator the
 * whole app shares. It has a real CommonJS export, so use it rather than a
 * stand-in: column ORDER decides which cell the odd cent lands in. */
window.p86BuildingSort = require('../js/building-sort.js').p86BuildingSort;

/* formatCurrency is a `const` arrow in js/app.js, so extractFunction can't see
 * it. Lift its text the same way and for the same reason: a hand-written copy
 * is a model, and a model cannot fail when the real one starts rounding the
 * display of a sum instead of summing rounded values. */
function extractConstArrow(src, name) {
  const start = src.indexOf('const ' + name + ' = ');
  if (start === -1) throw new Error('extractConstArrow: no const ' + name);
  let depth = 0, opened = false;
  for (let j = start; j < src.length; j++) {
    if (src[j] === '{') { depth++; opened = true; }
    else if (src[j] === '}') { depth--; if (opened && depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error('extractConstArrow: unbalanced braces in ' + name);
}

/* The allocation cluster, in dependency order. Every name here is a real
 * function declaration in js/jobs.js. */
const CLUSTER = [
  'money2',
  'phaseRevenue',
  'phaseDollar',
  '_bldgNumSort',
  'dedupePhaseRecords',
  'phaseAllocInfo',
  'pruneEmptyUnassignedPhases',
  'phaseRecFor',
  'setPhaseDollar',
  'phasePctShares',
  'recomputePhasePctAllocation',
  'phaseAllocResidual',
  'phaseAllocResidualChip',
  'allocCoveredSet',
  'spreadPhaseCore',
  'renderPhaseMatrixInto',
  'renderPhaseAllocEditorInto',
  'recomputePhaseMatrixTotals',
  'onPhaseMatrixCell',
  'onPhaseMatrixTotal',
  'setScopeTotal',
  'getJobContractTotal',
  'getPhasesWiredToBuilding',
  'buildingEffectiveBudget',
  'getJobBudgetRecon',
];

/* Build a fresh sandbox over the given appData. Returns every lifted function
 * plus the live appData/appState so a test can assert on the store. */
function sandbox(appData, jobId) {
  const appState = { currentJobId: jobId };
  const saveData = jest.fn();
  const escapeHTML = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const sources = CLUSTER.map((n) => extractFunction(JOBS_SRC, n));
  sources.unshift(extractConstArrow(APP_SRC, 'formatCurrency'));
  /* Module-scope mutable state the render functions close over. Injected as
   * params so each test gets a clean selection; the functions reassign them,
   * which sloppy-mode new Function bodies permit. */
  const params = ['appData', 'appState', 'saveData', 'escapeHTML', '_mxSel', '_mxPhaseSel', '_mxSelJob', '_allocView'];
  const values = [appData, appState, saveData, escapeHTML, {}, {}, null, {}];

  const api = {};
  CLUSTER.concat(['formatCurrency']).forEach((name) => {
    api[name] = compile(sources, params, values, name);
  });
  api.appData = appData;
  api.appState = appState;
  api.saveData = saveData;
  return api;
}

/* ── Fixtures ──────────────────────────────────────────────────────────── */

const P = (over) => Object.assign({
  id: 'p?', jobId: 'j1', buildingId: null, phase: 'Roofing',
  workScope: 'in-house', locked: false, pctComplete: 0,
  materials: 0, labor: 0, sub: 0, equipment: 0,
  asSoldRevenue: 0, asSoldPhaseBudget: 0, coPhaseBudget: 0, phaseBudget: 0,
  hoursWeek: 0, hoursTotal: 0, rate: 40, notes: '',
}, over);

/* A job in $ mode: two buildings, one scope, whole dollars — the shape that
 * exists on disk today. */
function dollarModeJob(contract) {
  return {
    jobs: [{ id: 'j1', contractAmount: contract == null ? 20000 : contract }],
    buildings: [
      { id: 'b1', jobId: 'j1', name: 'Building 1', units: [], levels: [] },
      { id: 'b2', jobId: 'j1', name: 'Building 2', units: [], levels: [] },
    ],
    phases: [
      P({ id: 'p1', buildingId: 'b1', allocMode: 'dollar', asSoldRevenue: 12000, asSoldPhaseBudget: 12000, phaseBudget: 12000 }),
      P({ id: 'p2', buildingId: 'b2', allocMode: 'dollar', asSoldRevenue: 8000, asSoldPhaseBudget: 8000, phaseBudget: 8000 }),
    ],
  };
}

/* A job in % mode: three equal buildings, one scope, an auto split. */
function pctModeJob(total) {
  return {
    jobs: [{ id: 'j1', contractAmount: total }],
    buildings: [
      { id: 'b1', jobId: 'j1', name: 'Building 1', units: [], levels: [] },
      { id: 'b2', jobId: 'j1', name: 'Building 2', units: [], levels: [] },
      { id: 'b3', jobId: 'j1', name: 'Building 3', units: [], levels: [] },
    ],
    phases: ['b1', 'b2', 'b3'].map((b, i) => P({
      id: 'p' + (i + 1), buildingId: b, allocMode: 'pct',
      phaseAllocTotal: total, allocAuto: true, allocPct: null,
    })),
  };
}

function mount() {
  const host = document.createElement('div');
  host.className = 'phase-matrix-host';
  document.body.appendChild(host);
  return host;
}

/* Parse a rendered currency string back to a number: "$3,333.34" → 3333.34. */
const unmoney = (s) => Number(String(s).replace(/[^0-9.\-]/g, ''));

afterEach(() => { document.body.innerHTML = ''; });

/* ──────────────────────────────────────────────────────────────────────────
 * PATH 1 — the money inputs admit a cent at all.
 * ────────────────────────────────────────────────────────────────────────── */
describe('path: the allocation inputs admit a cent', () => {
  test('no money input on either allocation surface carries a $100 step', () => {
    const api = sandbox(dollarModeJob(), 'j1');
    const grid = mount();
    api.renderPhaseMatrixInto(grid, 'j1');
    const cards = mount();
    api.renderPhaseAllocEditorInto(cards, 'j1');

    [grid, cards].forEach((hostEl) => {
      const money = [...hostEl.querySelectorAll('input[type=number]')]
        .filter((i) => i.getAttribute('data-mx-bldg') !== null || i.getAttribute('placeholder') === 'total $')
        /* the % and %-Done cells are not money and keep their own step */
        .filter((i) => i.getAttribute('max') !== '100');
      expect(money.length).toBeGreaterThan(0);
      money.forEach((i) => {
        const step = i.getAttribute('step');
        expect(step).not.toBe('100');
        /* a cent must be a legal value: step divides 0.01 */
        expect(step === 'any' || Math.abs(0.01 / Number(step) - Math.round(0.01 / Number(step))) < 1e-9).toBe(true);
      });
    });
  });

  test('the source carries no step="100" on any dollar field', () => {
    /* The Add-job-level-scope modal's Budget/Revenue inputs are money too and
     * have no render seam to drive; held on the source. */
    expect(JOBS_SRC).not.toMatch(/step="100"/);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * PATH 2 — entry → store → read back → display, to the cent.
 * ────────────────────────────────────────────────────────────────────────── */
describe('path: a cent entered in a $ -mode cell survives storage and repaint', () => {
  test('typing 1234.56 stores 1234.56 on all three revenue fields', () => {
    const api = sandbox(dollarModeJob(), 'j1');
    const host = mount();
    api.renderPhaseMatrixInto(host, 'j1');

    const cell = host.querySelector('input[data-mx-bldg="b1"]');
    cell.value = '1234.56';
    api.onPhaseMatrixCell(cell);

    const rec = api.appData.phases.find((p) => p.id === 'p1');
    expect(rec.asSoldRevenue).toBe(1234.56);
    expect(rec.asSoldPhaseBudget).toBe(1234.56);
    expect(rec.phaseBudget).toBe(1234.56);
    expect(api.phaseDollar(rec)).toBe(1234.56);
  });

  test('the repaint reads it back to the cent, not to the dollar', () => {
    const api = sandbox(dollarModeJob(), 'j1');
    const host = mount();
    api.renderPhaseMatrixInto(host, 'j1');
    const cell = host.querySelector('input[data-mx-bldg="b1"]');
    cell.value = '1234.56';
    api.onPhaseMatrixCell(cell);

    const again = mount();
    api.renderPhaseMatrixInto(again, 'j1');
    expect(again.querySelector('input[data-mx-bldg="b1"]').getAttribute('value')).toBe('1234.56');
  });

  test('a CO-carrying record keeps as-sold and total apart, both to the cent', () => {
    const data = dollarModeJob();
    data.phases[0].coPhaseBudget = 250.25;
    const api = sandbox(data, 'j1');
    const host = mount();
    api.renderPhaseMatrixInto(host, 'j1');
    const cell = host.querySelector('input[data-mx-bldg="b1"]');
    cell.value = '1000.10';
    api.onPhaseMatrixCell(cell);

    const rec = api.appData.phases.find((p) => p.id === 'p1');
    expect(rec.asSoldRevenue).toBe(1000.10);
    expect(rec.phaseBudget).toBe(1250.35); // NOT 1250.3500000000001
  });

  test('as-sold + change-order income is added in cents, not in binary', () => {
    /* phaseBudget = cell + coPhaseBudget. Adding two exact cent amounts is
     * still not exact in binary: 0.1 + 0.2 is 0.30000000000000004, and that
     * residue is what pruneEmptyUnassignedPhases' `money === 0` and
     * phasePctShares' `phaseDollar(r) > 0` then trip over. */
    const data = dollarModeJob();
    data.phases[0].coPhaseBudget = 0.2;
    const api = sandbox(data, 'j1');
    const host = mount();
    api.renderPhaseMatrixInto(host, 'j1');
    const cell = host.querySelector('input[data-mx-bldg="b1"]');
    cell.value = '0.1';
    api.onPhaseMatrixCell(cell);

    const rec = api.appData.phases.find((p) => p.id === 'p1');
    expect(rec.phaseBudget).toBe(0.3);
    expect(rec.phaseBudget).not.toBe(0.30000000000000004);
  });

  test('a sub-cent entry is quantised to the cent — never stored as a third of one', () => {
    /* A dollar field cannot hold a third of a cent, and the input's own
     * step="0.01" already marks such a value invalid in the browser. What must
     * never happen is that it is STORED: a phase record holding 1234.567 puts
     * a sub-cent residue into every downstream sum and comparison. It is
     * quantised at the single write point instead. */
    const api = sandbox(dollarModeJob(), 'j1');
    const host = mount();
    api.renderPhaseMatrixInto(host, 'j1');
    const cell = host.querySelector('input[data-mx-bldg="b1"]');
    cell.value = '1234.567';
    api.onPhaseMatrixCell(cell);

    const rec = api.appData.phases.find((p) => p.id === 'p1');
    expect(rec.asSoldRevenue).toBe(1234.57);
    const cents = rec.asSoldRevenue * 100;
    expect(Math.abs(cents - Math.round(cents))).toBeLessThan(1e-9);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * PATH 3 — the footers tie to the cent, and tie to the CELLS.
 * ────────────────────────────────────────────────────────────────────────── */
describe('path: row, column and grand totals equal the sum of their cells', () => {
  function threeCentJob() {
    const d = dollarModeJob();
    d.phases = [
      P({ id: 'p1', buildingId: 'b1', allocMode: 'dollar', asSoldRevenue: 1000.01, asSoldPhaseBudget: 1000.01, phaseBudget: 1000.01 }),
      P({ id: 'p2', buildingId: 'b2', allocMode: 'dollar', asSoldRevenue: 2000.02, asSoldPhaseBudget: 2000.02, phaseBudget: 2000.02 }),
      P({ id: 'p3', buildingId: null, allocMode: 'dollar', asSoldRevenue: 3000.03, asSoldPhaseBudget: 3000.03, phaseBudget: 3000.03 }),
    ];
    return d;
  }

  test('the painted grand total is the sum of the painted cells, to the cent', () => {
    const api = sandbox(threeCentJob(), 'j1');
    const host = mount();
    api.renderPhaseMatrixInto(host, 'j1');

    const cells = [...host.querySelectorAll('input[data-mx-bldg]')]
      .map((i) => Number(i.getAttribute('value') || 0));
    const sumOfCells = Math.round(cells.reduce((a, b) => a + b, 0) * 100) / 100;
    expect(sumOfCells).toBe(6000.06);

    const grand = unmoney(host.querySelector('[data-mx-grand]').textContent);
    expect(grand).toBe(sumOfCells);
  });

  test('each column footer is the sum of that column\'s cells', () => {
    const api = sandbox(threeCentJob(), 'j1');
    const host = mount();
    api.renderPhaseMatrixInto(host, 'j1');

    ['b1', 'b2', '__un__'].forEach((key) => {
      const sel = key === '__un__' ? 'input[data-mx-bldg=""]' : 'input[data-mx-bldg="' + key + '"]';
      const colCells = [...host.querySelectorAll(sel)].map((i) => Number(i.getAttribute('value') || 0));
      const expected = Math.round(colCells.reduce((a, b) => a + b, 0) * 100) / 100;
      const painted = unmoney(host.querySelector('[data-mx-coltot="' + key + '"]').textContent);
      expect(painted).toBe(expected);
    });
  });

  test('the LIVE footer update agrees with the painted footer — same revenue chain', () => {
    /* recomputePhaseMatrixTotals runs on every keystroke and used to sum
     * (asSoldPhaseBudget || phaseBudget), while the paint sums phaseRevenue
     * (asSoldRevenue || asSoldPhaseBudget || phaseBudget). A legacy row that
     * carries ONLY asSoldRevenue therefore counted in the paint and vanished
     * from the live update: typing in any cell silently rewrote the footer to
     * a different number than a repaint would show. */
    const d = dollarModeJob();
    d.phases = [
      P({ id: 'p1', buildingId: 'b1', allocMode: 'dollar', asSoldRevenue: 500.50, asSoldPhaseBudget: 0, phaseBudget: 0 }),
      P({ id: 'p2', buildingId: 'b2', allocMode: 'dollar', asSoldRevenue: 100.25, asSoldPhaseBudget: 100.25, phaseBudget: 100.25 }),
    ];
    const api = sandbox(d, 'j1');
    const host = mount();
    api.renderPhaseMatrixInto(host, 'j1');

    const paintedGrand = unmoney(host.querySelector('[data-mx-grand]').textContent);
    expect(paintedGrand).toBe(600.75);

    /* touch b2 with the value it already has → the live path repaints footers */
    const cell = host.querySelector('input[data-mx-bldg="b2"]');
    cell.value = '100.25';
    api.onPhaseMatrixCell(cell);

    const liveGrand = unmoney(host.querySelector('[data-mx-grand]').textContent);
    expect(liveGrand).toBe(paintedGrand);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * PATH 4 — the % split that cannot divide evenly.
 * ────────────────────────────────────────────────────────────────────────── */
describe('path: a percent split resolves to the cent, and the odd cent is visible in the cells', () => {
  test('$10,000.00 three ways sums to exactly $10,000.00', () => {
    const api = sandbox(pctModeJob(10000), 'j1');
    api.recomputePhasePctAllocation('j1', 'Roofing');

    const cells = api.appData.phases.map((p) => api.phaseDollar(p));
    const sum = cells.reduce((a, b) => a + b, 0);
    expect(Math.round(sum * 100) / 100).toBe(10000);
    /* the odd cent lands in ONE cell, and it is one cent — not one dollar */
    expect(cells.slice().sort((a, b) => b - a)).toEqual([3333.34, 3333.33, 3333.33]);
  });

  test('a total that itself carries cents is not rounded away or invented', () => {
    /* the whole-dollar split turned $10,000.50 into $10,001 of cells */
    const api = sandbox(pctModeJob(10000.50), 'j1');
    api.recomputePhasePctAllocation('j1', 'Roofing');

    const sum = api.appData.phases.reduce((s, p) => s + api.phaseDollar(p), 0);
    expect(Math.round(sum * 100) / 100).toBe(10000.50);
    api.appData.phases.forEach((p) => {
      expect(api.phaseDollar(p)).toBe(Math.round(api.phaseDollar(p) * 100) / 100);
    });
  });

  test('every cell is a whole number of cents — nothing sub-cent is ever stored', () => {
    const api = sandbox(pctModeJob(7777.77), 'j1');
    api.recomputePhasePctAllocation('j1', 'Roofing');
    api.appData.phases.forEach((p) => {
      const cents = api.phaseDollar(p) * 100;
      expect(Math.abs(cents - Math.round(cents))).toBeLessThan(1e-9);
    });
  });

  test('setScopeTotal — the programmatic seam — lands on the same cents', () => {
    const api = sandbox(pctModeJob(10000), 'j1');
    api.setScopeTotal('j1', 'Roofing', 10000.99);
    const sum = api.appData.phases.reduce((s, p) => s + api.phaseDollar(p), 0);
    expect(Math.round(sum * 100) / 100).toBe(10000.99);
  });

  test('the SCOPE TOTAL itself is stored in cents, so the field never shows a third of one', () => {
    /* The cells are quantised as they are written, so a sub-cent total still
     * produces exact cells and hides the problem. What it does NOT hide is the
     * total input, which renders phaseAllocTotal verbatim: an unquantised
     * total paints "10000.567" into a dollar field. */
    const api = sandbox(pctModeJob(10000), 'j1');
    api.setScopeTotal('j1', 'Roofing', 10000.567);
    expect(api.appData.phases[0].phaseAllocTotal).toBe(10000.57);

    const host = mount();
    api.renderPhaseMatrixInto(host, 'j1');
    expect(host.querySelector('input[placeholder="total $"]').getAttribute('value')).toBe('10000.57');
  });

  test('and the same when it is TYPED, not set programmatically', () => {
    const api = sandbox(pctModeJob(10000), 'j1');
    const host = mount();
    api.renderPhaseMatrixInto(host, 'j1');
    const totalInput = host.querySelector('input[placeholder="total $"]');
    totalInput.value = '10000.567';
    api.onPhaseMatrixTotal(totalInput);
    expect(api.appData.phases[0].phaseAllocTotal).toBe(10000.57);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * PATH 5 — a split that genuinely under-allocates says so.
 * ────────────────────────────────────────────────────────────────────────── */
describe('path: an under-allocated percent scope resolves visibly, not silently', () => {
  function manualPct(total, pcts) {
    const d = pctModeJob(total);
    d.phases.forEach((p, i) => { p.allocAuto = false; p.allocPct = pcts[i]; });
    return d;
  }

  test('three manual 33.33% shares of $10,000 leave $1.00 the user did not place', () => {
    const api = sandbox(manualPct(10000, [33.33, 33.33, 33.33]), 'j1');
    api.recomputePhasePctAllocation('j1', 'Roofing');

    const r = api.phaseAllocResidual('j1', 'Roofing');
    expect(r).not.toBeNull();
    expect(r.residual).toBe(1);
    expect(r.allocated).toBe(9999);
    expect(r.total).toBe(10000);
  });

  test('and the grid NAMES that dollar on the row', () => {
    const api = sandbox(manualPct(10000, [33.33, 33.33, 33.33]), 'j1');
    api.recomputePhasePctAllocation('j1', 'Roofing');
    const host = mount();
    api.renderPhaseMatrixInto(host, 'j1');

    const chip = host.querySelector('[data-mx-residual="Roofing"]');
    expect(chip).not.toBeNull();
    expect(unmoney(chip.textContent)).toBe(1);
  });

  test('the card editor names it on its allocation meter', () => {
    /* The card has its own status device, so it names the money there rather
     * than carrying a second chip. What it must never do is what it did: the
     * meter reads Math.round(bldgPctSum), so three 33.33% shares summed to
     * 99.99, rounded to 100, and painted a GREEN "Allocated 100% ✓" over a
     * whole dollar sitting on no building. */
    const api = sandbox(manualPct(10000, [33.33, 33.33, 33.33]), 'j1');
    api.recomputePhasePctAllocation('j1', 'Roofing');
    const host = mount();
    api.renderPhaseAllocEditorInto(host, 'j1');
    const meter = host.querySelector('[data-mx-residual="Roofing"]');
    expect(meter).not.toBeNull();
    expect(unmoney(meter.textContent)).toBe(1);
    expect(host.textContent).not.toContain('Allocated 100% ✓');
  });

  test('and the meter still gives a green tick when the scope really does tie', () => {
    const api = sandbox(pctModeJob(10000), 'j1');
    api.recomputePhasePctAllocation('j1', 'Roofing');
    const host = mount();
    api.renderPhaseAllocEditorInto(host, 'j1');
    expect(host.querySelector('[data-mx-residual="Roofing"]')).toBeNull();
    expect(host.textContent).toContain('Allocated 100% ✓');
  });

  test('an over-allocated scope is named as over, not as a negative gap', () => {
    const api = sandbox(manualPct(10000, [40, 40, 40]), 'j1');
    api.recomputePhasePctAllocation('j1', 'Roofing');
    const r = api.phaseAllocResidual('j1', 'Roofing');
    expect(r.residual).toBe(-2000);
    const host = mount();
    api.renderPhaseMatrixInto(host, 'j1');
    expect(host.querySelector('[data-mx-residual="Roofing"]').textContent.toLowerCase()).toContain('over');
  });

  test('a split that DOES tie shows no chip — the chip means something', () => {
    const api = sandbox(pctModeJob(10000), 'j1');
    api.recomputePhasePctAllocation('j1', 'Roofing');
    expect(api.phaseAllocResidual('j1', 'Roofing')).toBeNull();
    const host = mount();
    api.renderPhaseMatrixInto(host, 'j1');
    expect(host.querySelector('[data-mx-residual="Roofing"]')).toBeNull();
  });

  test('the SUB-CENT rounding residue is absorbed, and is never reported as a gap', () => {
    /* $10,000 over 3 is $3,333.333… — a third of a cent cannot be paid to
     * anyone, so largest-remainder absorbs it. That is not an unallocated
     * balance and must not raise the chip. */
    const api = sandbox(pctModeJob(10000), 'j1');
    api.recomputePhasePctAllocation('j1', 'Roofing');
    const info = api.phaseAllocInfo('j1', 'Roofing');
    expect(info.sumDollars).toBe(info.total);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * PATH 6 — floating-point residue is never a balance.
 * ────────────────────────────────────────────────────────────────────────── */
describe('path: no comparison treats binary residue as real money', () => {
  test('setPhaseDollar quantises — 0.1 + 0.2 lands as 0.3', () => {
    const api = sandbox(dollarModeJob(), 'j1');
    const rec = api.appData.phases[0];
    api.setPhaseDollar(rec, 0.1 + 0.2);
    expect(rec.asSoldRevenue).toBe(0.3);
    expect(rec.asSoldRevenue).not.toBe(0.30000000000000004);
  });

  test('a zero reached by subtraction is EXACTLY zero, so the empty bucket prunes', () => {
    /* pruneEmptyUnassignedPhases tests `money === 0`. 0.1 + 0.2 - 0.3 is
     * 5.55e-17, which is not 0, so the emptied job-level bucket would linger
     * for ever as a "$0.00 Job-level (unassigned)" row. */
    const d = dollarModeJob();
    d.phases.push(P({ id: 'p3', buildingId: null, allocMode: 'dollar' }));
    const api = sandbox(d, 'j1');
    const urec = api.appData.phases.find((p) => p.id === 'p3');
    api.setPhaseDollar(urec, 0.1 + 0.2 - 0.3);

    api.pruneEmptyUnassignedPhases('j1');
    expect(api.appData.phases.find((p) => p.id === 'p3')).toBeUndefined();
  });

  test('a residue does not freeze an auto share into a manual one', () => {
    /* phasePctShares classifies `phaseDollar(rec) > 0` as a legacy manual
     * share. A cell holding 5.55e-17 would pin itself at ~0% and drop out of
     * the rebalance, quietly starving it. */
    const d = pctModeJob(9000);
    const api = sandbox(d, 'j1');
    api.setPhaseDollar(api.appData.phases[0], 0.1 + 0.2 - 0.3);
    api.appData.phases[0].allocAuto = undefined;
    api.appData.phases[0].allocPct = null;

    const shares = api.phasePctShares('j1', 'Roofing').shares;
    expect(shares.b1.auto).toBe(true);
  });

  test('a covered building is not conjured out of a residue', () => {
    const d = dollarModeJob();
    const api = sandbox(d, 'j1');
    api.setPhaseDollar(api.appData.phases[0], 0.1 + 0.2 - 0.3);
    expect(api.allocCoveredSet('j1', 'Roofing').b1).toBeUndefined();
  });

  test('the section strip sees a cent-exact tie, not a residual balance', () => {
    /* getJobBudgetRecon carries a ±$1-per-building tolerance that would mask
     * drift. Assert the STRONG property — the gap is zero to the cent — so the
     * tie does not depend on the tolerance to look clean. */
    const api = sandbox(pctModeJob(10000.50), 'j1');
    api.recomputePhasePctAllocation('j1', 'Roofing');
    const recon = api.getJobBudgetRecon('j1');
    expect(Math.abs(recon.gap)).toBeLessThan(0.005);
    expect(recon.full).toBe(true);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * PATH 7 — nothing at rest reprices.
 * ────────────────────────────────────────────────────────────────────────── */
describe('path: reading an existing whole-dollar job changes nothing', () => {
  /* A corpus of the shapes that are actually on disk, including the three
   * generations of revenue field named in phaseRevenue's comment. */
  const CORPUS = [
    ['$ mode, two buildings', dollarModeJob()],
    ['% mode, even three-way', pctModeJob(9000)],
    ['% mode, uneven three-way', (() => {
      const d = pctModeJob(10000);
      d.phases[0].asSoldRevenue = 3334; d.phases[0].asSoldPhaseBudget = 3334; d.phases[0].phaseBudget = 3334;
      d.phases[1].asSoldRevenue = 3333; d.phases[1].asSoldPhaseBudget = 3333; d.phases[1].phaseBudget = 3333;
      d.phases[2].asSoldRevenue = 3333; d.phases[2].asSoldPhaseBudget = 3333; d.phases[2].phaseBudget = 3333;
      return d;
    })()],
    ['legacy: phaseBudget only', (() => {
      const d = dollarModeJob();
      d.phases.forEach((p) => { p.asSoldRevenue = 0; p.asSoldPhaseBudget = 0; p.phaseBudget = 5000; });
      return d;
    })()],
    ['legacy: dead asSoldRevenue 0 with money on asSoldPhaseBudget', (() => {
      const d = dollarModeJob();
      d.phases.forEach((p) => { p.asSoldRevenue = 0; p.asSoldPhaseBudget = 5000; p.phaseBudget = 5000; });
      return d;
    })()],
    ['job-level scope, no buildings assigned', (() => {
      const d = dollarModeJob();
      d.phases = [P({ id: 'p1', buildingId: null, allocMode: 'dollar', asSoldRevenue: 20000, asSoldPhaseBudget: 20000, phaseBudget: 20000 })];
      return d;
    })()],
  ];

  test.each(CORPUS)('%s — painting both surfaces mutates no stored value', (_label, data) => {
    const api = sandbox(data, 'j1');
    const before = JSON.stringify(api.appData);

    api.renderPhaseMatrixInto(mount(), 'j1');
    api.renderPhaseAllocEditorInto(mount(), 'j1');
    api.phaseAllocInfo('j1', 'Roofing');
    api.phasePctShares('j1', 'Roofing');
    api.getJobBudgetRecon('j1');
    api.phaseAllocResidual('j1', 'Roofing');

    expect(JSON.stringify(api.appData)).toBe(before);
  });

  test.each(CORPUS)('%s — every stored amount still reads back to the same number', (_label, data) => {
    const api = sandbox(data, 'j1');
    const before = api.appData.phases.map((p) => api.phaseDollar(p));
    api.renderPhaseMatrixInto(mount(), 'j1');
    const after = api.appData.phases.map((p) => api.phaseDollar(p));
    expect(after).toEqual(before);
  });

  test('a whole-dollar split that already divides exactly re-commits unchanged', () => {
    const api = sandbox(pctModeJob(9000), 'j1');
    api.recomputePhasePctAllocation('j1', 'Roofing');
    const first = api.appData.phases.map((p) => api.phaseDollar(p));
    expect(first).toEqual([3000, 3000, 3000]);
    api.recomputePhasePctAllocation('j1', 'Roofing');
    expect(api.appData.phases.map((p) => api.phaseDollar(p))).toEqual(first);
  });

  test('re-committing is idempotent — a second pass never moves another cent', () => {
    const api = sandbox(pctModeJob(10000.50), 'j1');
    api.recomputePhasePctAllocation('j1', 'Roofing');
    const first = api.appData.phases.map((p) => api.phaseDollar(p));
    api.recomputePhasePctAllocation('j1', 'Roofing');
    api.recomputePhasePctAllocation('j1', 'Roofing');
    expect(api.appData.phases.map((p) => api.phaseDollar(p))).toEqual(first);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * PATH 8 — the cent survives downstream.
 * ────────────────────────────────────────────────────────────────────────── */
describe('path: a cent entered here reaches the surfaces that read it', () => {
  test('buildingEffectiveBudget — what the buildings table and the strip sum', () => {
    const d = dollarModeJob();
    d.phases[0].asSoldRevenue = 1000.01; d.phases[0].asSoldPhaseBudget = 1000.01; d.phases[0].phaseBudget = 1000.01;
    const api = sandbox(d, 'j1');
    const eff = api.buildingEffectiveBudget(api.appData.buildings[0], 'j1');
    expect(eff.amount).toBe(1000.01);
  });

  test('phaseDollar — what the node-graph t2 revenue sync writes to n.revenue', () => {
    const api = sandbox(dollarModeJob(), 'j1');
    const host = mount();
    api.renderPhaseMatrixInto(host, 'j1');
    const cell = host.querySelector('input[data-mx-bldg="b1"]');
    cell.value = '4321.09';
    api.onPhaseMatrixCell(cell);
    /* commitMatrixChange/onPhaseMatrixCommit both do n.revenue = phaseDollar(r) */
    expect(api.phaseDollar(api.appData.phases.find((p) => p.id === 'p1'))).toBe(4321.09);
  });

  test('a cent on the scope total reaches the contract reconciliation', () => {
    const d = pctModeJob(10000);
    d.jobs[0].contractAmount = 10000.75;
    const api = sandbox(d, 'j1');
    api.setScopeTotal('j1', 'Roofing', 10000.75);
    const recon = api.getJobBudgetRecon('j1');
    expect(Math.round(recon.onBuildings * 100) / 100).toBe(10000.75);
    expect(Math.abs(recon.gap)).toBeLessThan(0.005);
  });
});
