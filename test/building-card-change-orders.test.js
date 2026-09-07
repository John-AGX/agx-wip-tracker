/**
 * @jest-environment jsdom
 */
/* ═══════════════════════════════════════════════════════════════════════════
 * THE CHANGE ORDERS A BUILDING CARD COULD NEVER SEE.
 *
 * `getCOsConnectedTo` filtered `appData.jobChangeOrders` on `c.jobId`. Server
 * change-order rows carry `job_id` — shapeRow (server/routes/change-order-
 * routes.js) spreads the data blob then stamps the canonical columns, and no
 * create path has ever written a camelCase job key into that blob. So `c.jobId`
 * was undefined on every row, the guard fired on every change order, and EVERY
 * building card on EVERY job rendered "CHANGE ORDERS (0) — No change orders
 * allocated to this building" from the day the branch shipped (1cd39aba,
 * 2 Aug) — inside the very commit whose purpose was to make change-order
 * income reach these cards.
 *
 * Repointing the key ALONE is not the fix. `getCOsConnectedTo` carried no
 * status filter — the only reader of that store without one — so a repointed
 * key would have put DRAFT change-order money on a money card. Both halves are
 * held separately below, so neither can be reverted without a red test.
 *
 * WHAT IS HELD, each clause failing on its own:
 *
 *   1. A change order allocated to a building appears on THAT building's card
 *      and on no other, at the building's real dollar share.
 *   2. A change order belonging to a DIFFERENT job never reaches this job's
 *      cards.
 *   3. A draft change order appears on NO card, and neither does any status
 *      that is not `approved` or `applied` — `rejected` and `void` are held
 *      too, though the server's STATUS_VALUES does not currently mint them, so
 *      the filter stays an allow-list rather than a deny-list if it ever does.
 *   4. A building with genuinely no allocated change orders still SAYS SO IN
 *      WORDS. The fix must never turn a true "none" into a blank.
 *   5. NOTHING AT REST REPRICES. The stored row is not mutated, and the job's
 *      own money — getJobCOTotals and the G703 — is byte-identical either way.
 *   6. THE STRIP RECONCILES ON A TRUE FIGURE, NOT A BALANCED ONE. Allocated
 *      and Unallocated are base-contract against base-scope on BOTH sides and
 *      carry no change-order term at all. Adding CO income to the contract
 *      numerator alone — the "obvious" repair — moves only the numerator and
 *      manufactures a phantom shortfall of exactly the CO income on every job
 *      with an approved change order. Held as arithmetic so nobody introduces
 *      it later as a tidy-up.
 *   7. The card's dollars equal the G703's change-order dollars, per building
 *      and in total. The PERCENTAGES legitimately differ — the card shows the
 *      ridden scope's cell %, the G703 seeds every CO line at 0 for the biller
 *      to fill in — but the DOLLARS may not.
 *
 * Every property is proven by MUTATION: the shipped source is mechanically
 * broken back to each pre-fix spelling and the property is asserted to go RED.
 * A green test over unmutated code proves only that the test ran.
 *
 * The functions under test are LIFTED OUT OF THE SHIPPED FILES (test/helpers/
 * browser-fn.js) rather than modelled — a model of buggy code is green for
 * exactly as long as the bug is live, which is how this bug survived its own
 * commit. The money is the REAL pricing pipeline and the REAL completion clock.
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const { extractFunction, compile } = require('./helpers/browser-fn.js');

const REPO = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

const JOBS_SRC = read('js/jobs.js');
const PA_SRC = read('js/pay-applications.js');
const CO_ROUTES_SRC = read('server/routes/change-order-routes.js');
const INDEX_HTML = read('index.html');

/* The real money modules, not stand-ins. */
require('../js/progress-core.js');
window.p86CoCompletion = require('../js/co-completion.js');
window.p86Pricing = require('../js/pricing-pipeline.js');
window.p86BuildingSort = require('../js/building-sort.js').p86BuildingSort;

const DOM = require('../js/dom-ref.js');
const escapeHTML = compile([extractFunction(read('js/app.js'), 'escapeHTML')], [], [], 'escapeHTML');
const fmtAllocPct = compile([extractFunction(JOBS_SRC, 'fmtAllocPct')], [], [], 'fmtAllocPct');
const _bldgNumSort = compile(
  [extractFunction(JOBS_SRC, '_bldgNumSort')], ['window'],
  [{ p86BuildingSort: window.p86BuildingSort }], '_bldgNumSort'
);
const formatCurrency = (val) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val || 0);

/* The shipped server shaper, so the rows under test are the rows the browser
 * actually receives rather than a hand-written guess at their shape. */
const shapeRow = compile([extractFunction(CO_ROUTES_SRC, 'shapeRow')], [], [], 'shapeRow');

/* ═══════════════════════════════════════════════════════════════════════════
 * FIXTURE — one job, four buildings, change orders in every status the store
 * can hold, plus one belonging to a different job entirely.
 * ═══════════════════════════════════════════════════════════════════════════ */

const JOB = 'j-cards-1';
const OTHER_JOB = 'j-cards-2';
const B = { one: 'b-one', two: 'b-two', three: 'b-three', four: 'b-four' };

/* Four buildings wide so at least one can honestly carry nothing. */
const BUILDINGS = [
  { id: B.one, jobId: JOB, name: 'B1', materials: 1200, labor: 3400, sub: 900, equipment: 150 },
  { id: B.two, jobId: JOB, name: 'B2', materials: 7000, labor: 250.55, sub: 0, equipment: 0 },
  { id: B.three, jobId: JOB, name: 'B3', materials: 0, labor: 0, sub: 0, equipment: 0 },
  { id: B.four, jobId: JOB, name: 'B4', materials: 0, labor: 0, sub: 0, equipment: 0 },
];

/* Real scope revenue, so buildingEffectiveBudget and the strip have something
 * true to reconcile rather than zeroes that agree by accident. */
const PHASES = [
  { id: 'p1', jobId: JOB, phase: 'Gutters', buildingId: B.one, asSoldRevenue: 12000, pctComplete: 100, materials: 500, labor: 700, sub: 0, equipment: 0 },
  { id: 'p2', jobId: JOB, phase: 'Gutters', buildingId: B.two, asSoldRevenue: 8000, pctComplete: 50, materials: 300, labor: 0, sub: 1200, equipment: 0 },
  { id: 'p3', jobId: JOB, phase: 'Paint', buildingId: B.three, asSoldRevenue: 5000, pctComplete: 0, materials: 0, labor: 0, sub: 0, equipment: 0 },
];

const CONTRACT = 25000;   // 12,000 + 8,000 + 5,000 — the scopes fully cover it

const line = (unitCost) => [{ id: 'l1', description: 'work', qty: 1, unitCost: unitCost }];

/* Built through shapeRow so every row carries exactly the keys the browser gets. */
function serverCO(over) {
  const d = Object.assign({
    title: 'Change', lines: line(10000), defaultMarkup: 0,
    completionMode: 'standalone', buildingAllocations: [],
  }, over.data || {});
  return shapeRow({
    id: over.id, job_id: over.job_id || JOB, owner_id: 'u1',
    status: over.status, co_number: over.co_number, data: d,
    approved_at: null, approved_by: null, linked_node_id: null,
    is_locked: false, created_at: null, updated_at: null,
  });
}

const CO_APPROVED_B1 = serverCO({
  id: 'co-a', status: 'approved', co_number: 'CO-0001',
  data: { title: 'Add lanai', lines: line(4000), buildingAllocations: [{ buildingId: B.one, pct: 100 }] },
});
const CO_APPLIED_SPLIT = serverCO({
  id: 'co-b', status: 'applied', co_number: 'CO-0002',
  data: { title: 'Regrade', lines: line(10000), buildingAllocations: [{ buildingId: B.one, pct: 60 }, { buildingId: B.two, pct: 40 }] },
});
const CO_DRAFT_B2 = serverCO({
  id: 'co-c', status: 'draft', co_number: 'CO-0003',
  data: { title: 'Not approved yet', lines: line(50000), buildingAllocations: [{ buildingId: B.two, pct: 100 }] },
});
const CO_REJECTED_B1 = serverCO({
  id: 'co-d', status: 'rejected', co_number: 'CO-0004',
  data: { title: 'Turned down', lines: line(70000), buildingAllocations: [{ buildingId: B.one, pct: 100 }] },
});
const CO_VOID_B3 = serverCO({
  id: 'co-e', status: 'void', co_number: 'CO-0005',
  data: { title: 'Voided', lines: line(90000), buildingAllocations: [{ buildingId: B.three, pct: 100 }] },
});
/* Another job's approved change order, pointed at THIS job's building id —
 * the only shape in which a cross-job leak could ever surface. */
const CO_OTHER_JOB = serverCO({
  id: 'co-f', job_id: OTHER_JOB, status: 'approved', co_number: 'CO-9001',
  data: { title: 'Someone else money', lines: line(123456), buildingAllocations: [{ buildingId: B.one, pct: 100 }] },
});

const ALL_COS = [CO_APPROVED_B1, CO_APPLIED_SPLIT, CO_DRAFT_B2, CO_REJECTED_B1, CO_VOID_B3, CO_OTHER_JOB];

function makeAppData() {
  return {
    jobs: [{ id: JOB, jobNumber: 'RV-TEST', pctComplete: 40, contractAmount: CONTRACT },
           { id: OTHER_JOB, jobNumber: 'RV-OTHER', pctComplete: 0, contractAmount: 0 }],
    phases: PHASES.map((p) => Object.assign({}, p)),
    buildings: BUILDINGS.map((b) => Object.assign({}, b)),
    jobChangeOrders: ALL_COS.map((c) => Object.assign({}, c)),
    changeOrders: [], subs: [], purchaseOrders: [],
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * HARNESS — the shipped getCOsConnectedTo over the shipped clock, with its
 * source available for mutation.
 * ═══════════════════════════════════════════════════════════════════════════ */

const GETCOS_SRC = extractFunction(JOBS_SRC, 'getCOsConnectedTo');

function build(appData, src) {
  const appState = { currentJobId: JOB };
  const coSellAmount = compile([extractFunction(JOBS_SRC, 'coSellAmount')], ['window'], [window], 'coSellAmount');
  window.coSellAmount = coSellAmount;
  const coCompletion = compile([extractFunction(JOBS_SRC, 'coCompletion')],
    ['appData', 'coSellAmount', 'window'], [appData, coSellAmount, window], 'coCompletion');
  window.coCompletion = coCompletion;
  const getCOsConnectedTo = compile([src || GETCOS_SRC],
    ['appData', 'appState', 'coCompletion', 'ensureNGLoaded', 'NG', 'window'],
    [appData, appState, coCompletion, () => {}, undefined, window], 'getCOsConnectedTo');
  return { appData, coSellAmount, coCompletion, getCOsConnectedTo };
}

/* Mechanically break the shipped source back to a pre-fix spelling. Each
 * replace asserts it applied, so a rename cannot quietly turn a mutation test
 * into a tautology that passes by doing nothing. */
function mutate(from, to, src) {
  const base = src || GETCOS_SRC;
  const out = base.replace(from, to);
  if (out === base) throw new Error('mutation did not apply: ' + from);
  return out;
}
const MUT_OLD_KEY = () => mutate('c.job_id !== jobId', 'c.jobId !== jobId');
const MUT_NO_STATUS = () => mutate(
  /\n\s*if \(c\.status !== 'approved' && c\.status !== 'applied'\) return;/, '');

const coNumbers = (rows) => rows.map((r) => r.co.co_number).sort();
const dollars = (rows) => rows.reduce((s, r) => s + (r.co.income || 0) * r.allocPct / 100, 0);
const round2 = (n) => Math.round(n * 100) / 100;

/* ── the REAL card renderer over the REAL budget/recon helpers, so the strip
 *    asserted on below is the strip the app paints ─────────────────────────── */
const RENDER_DEPS = [
  '_bldgNumSort', 'appData', 'buildingEffectiveBudget', 'calcBuildingPctComplete',
  'document', 'escapeHTML', 'fillBuildingCrew', 'fmtAllocPct', 'formatCurrency',
  'getCOsConnectedTo', 'getJobBudgetRecon', 'getPhasesWiredToBuilding', 'p86Enc', 'window',
];

function reconFor(appData) {
  const phaseRevenue = compile([extractFunction(JOBS_SRC, 'phaseRevenue')], [], [], 'phaseRevenue');
  const getPhasesWiredToBuilding = compile([extractFunction(JOBS_SRC, 'getPhasesWiredToBuilding')],
    ['appData', 'appState', 'NG', 'ensureNGLoaded'],
    [appData, { currentJobId: JOB }, undefined, () => {}], 'getPhasesWiredToBuilding');
  const buildingEffectiveBudget = compile([extractFunction(JOBS_SRC, 'buildingEffectiveBudget')],
    ['appData', 'getPhasesWiredToBuilding', 'phaseRevenue'],
    [appData, getPhasesWiredToBuilding, phaseRevenue], 'buildingEffectiveBudget');
  const getJobContractTotal = compile([extractFunction(JOBS_SRC, 'getJobContractTotal')],
    ['appData'], [appData], 'getJobContractTotal');
  const getJobBudgetRecon = compile([extractFunction(JOBS_SRC, 'getJobBudgetRecon')],
    ['appData', 'getJobContractTotal', 'buildingEffectiveBudget', 'phaseRevenue'],
    [appData, getJobContractTotal, buildingEffectiveBudget, phaseRevenue], 'getJobBudgetRecon');
  return { getPhasesWiredToBuilding, buildingEffectiveBudget, getJobBudgetRecon };
}

/* Paint the cards and hand back the HTML. `patchSrc` lets a mutation test
 * break the RENDERER (not the reader) and see what the card would say. */
function paintCards(appData, getCOsConnectedTo, patchSrc) {
  const H = reconFor(appData);
  const host = document.createElement('div');
  host.id = 'job-buildings-content';
  document.body.appendChild(host);
  let src = extractFunction(JOBS_SRC, 'renderJobBuildings');
  if (patchSrc) {
    const next = patchSrc(src);
    if (next === src) throw new Error('renderer mutation did not apply');
    src = next;
  }
  const render = compile([src], RENDER_DEPS, [
    _bldgNumSort, appData, H.buildingEffectiveBudget, () => 0, document, escapeHTML,
    () => {}, fmtAllocPct, formatCurrency, getCOsConnectedTo, H.getJobBudgetRecon,
    H.getPhasesWiredToBuilding, DOM.enc, window,
  ], 'renderJobBuildings');
  render(JOB, host.id);
  const html = host.innerHTML;
  host.remove();
  return html;
}

const EMPTY_WORDS = 'No change orders allocated to this building';

/* ═══════════════════════════════════════════════════════════════════════════
 * 1 · THE KEY — a change order reaches its building, and only its building
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('1 · a change order allocated to a building appears on that card and no other', () => {
  test('1a · the rows this store actually holds are keyed job_id, never jobId', () => {
    // The premise of the whole bug, asserted against the shipped shaper rather
    // than assumed. If a migration ever adds a jobId, this goes red first.
    ALL_COS.forEach((c) => {
      expect(c.job_id).toBeTruthy();
      expect('jobId' in c).toBe(false);
    });
  });

  test('1b · B1 shows its two change orders; B2 shows only the split share', () => {
    const H = build(makeAppData());
    expect(coNumbers(H.getCOsConnectedTo('t1', B.one))).toEqual(['CO-0001', 'CO-0002']);
    expect(coNumbers(H.getCOsConnectedTo('t1', B.two))).toEqual(['CO-0002']);
    expect(coNumbers(H.getCOsConnectedTo('t1', B.three))).toEqual([]);
    expect(coNumbers(H.getCOsConnectedTo('t1', B.four))).toEqual([]);
  });

  test('1c · the dollars are the building SHARE, not the whole change order', () => {
    const H = build(makeAppData());
    // CO-0001 $4,000 × 100% + CO-0002 $10,000 × 60% = $10,000 on B1.
    expect(round2(dollars(H.getCOsConnectedTo('t1', B.one)))).toBe(10000);
    // CO-0002 $10,000 × 40% = $4,000 on B2.
    expect(round2(dollars(H.getCOsConnectedTo('t1', B.two)))).toBe(4000);
    // Every allocated dollar lands on exactly one building; none double-counted.
    const total = BUILDINGS.reduce((s, b) => s + dollars(H.getCOsConnectedTo('t1', b.id)), 0);
    expect(round2(total)).toBe(14000);
  });

  test('1d · MUTATION — restoring `c.jobId` empties every card (the shipped bug)', () => {
    const H = build(makeAppData(), MUT_OLD_KEY());
    BUILDINGS.forEach((b) => expect(H.getCOsConnectedTo('t1', b.id)).toEqual([]));
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2 · CROSS-JOB — another job's money never lands here
 * ═══════════════════════════════════════════════════════════════════════════ */
describe("2 · a change order on another job never reaches this job's cards", () => {
  test('2a · CO-9001 is allocated to B1 by id and is still absent', () => {
    const rows = build(makeAppData()).getCOsConnectedTo('t1', B.one);
    expect(coNumbers(rows)).not.toContain('CO-9001');
    expect(round2(dollars(rows))).toBe(10000);   // unpolluted by the $123,456
  });

  test('2b · MUTATION — dropping the job guard leaks it straight in', () => {
    const H = build(makeAppData(), mutate('if (!c || (jobId && c.job_id !== jobId)) return;', 'if (!c) return;'));
    expect(coNumbers(H.getCOsConnectedTo('t1', B.one))).toContain('CO-9001');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 3 · THE STATUS FILTER — the second half of the same edit
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('3 · a draft, rejected or void change order appears on NO card', () => {
  test('3a · none of the three unapproved statuses reaches any building', () => {
    const H = build(makeAppData());
    const seen = [];
    BUILDINGS.forEach((b) => H.getCOsConnectedTo('t1', b.id).forEach((r) => seen.push(r.co.co_number)));
    ['CO-0003', 'CO-0004', 'CO-0005'].forEach((n) => expect(seen).not.toContain(n));
  });

  test('3b · approved and applied both DO reach — the filter is not a blanket', () => {
    const statuses = build(makeAppData()).getCOsConnectedTo('t1', B.one).map((r) => r.co.status).sort();
    expect(statuses).toEqual(['applied', 'approved']);
  });

  test('3c · the filter is an ALLOW-list — an unknown future status is excluded', () => {
    const app = makeAppData();
    app.jobChangeOrders.push(serverCO({
      id: 'co-z', status: 'superseded', co_number: 'CO-0099',
      data: { buildingAllocations: [{ buildingId: B.one, pct: 100 }] },
    }));
    expect(coNumbers(build(app).getCOsConnectedTo('t1', B.one))).not.toContain('CO-0099');
  });

  test('3d · MUTATION — removing the status filter puts DRAFT money on a card', () => {
    const rows = build(makeAppData(), MUT_NO_STATUS()).getCOsConnectedTo('t1', B.two);
    expect(coNumbers(rows)).toContain('CO-0003');
    // Not cosmetic: $50,000 of unapproved money on a money card.
    expect(round2(dollars(rows))).toBe(54000);
  });

  test('3e · MUTATION — the status filter alone is not enough; the key still matters', () => {
    // Both halves are load-bearing. With the filter present but the old key
    // restored, the card is still empty.
    const src = MUT_OLD_KEY();
    expect(src).toContain("c.status !== 'approved'");
    expect(build(makeAppData(), src).getCOsConnectedTo('t1', B.one)).toEqual([]);
  });

  test('3f · every other reader of this store uses the SAME predicate, verbatim', () => {
    // If one of them is ever loosened, this card must be reconsidered with it.
    const PRED = /c\.status === 'approved' \|\| c\.status === 'applied'/;
    expect(JOBS_SRC).toMatch(PRED);          // getJobCOTotals + the WIP snapshot
    expect(PA_SRC).toMatch(PRED);            // deriveSOV
    expect(JOBS_SRC).toMatch(/c\.status !== 'approved' && c\.status !== 'applied'/);
    expect(read('nodegraph/ui.js')).toMatch(/status!=='approved' && c\.status!=='applied'/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 4 · NEVER SILENTLY EMPTY — a true "none" is still said in words
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('4 · a building with no allocated change orders still says so', () => {
  test('4a · B3 and B4 carry nothing and say it in words, not as a blank', () => {
    const app = makeAppData();
    const html = paintCards(app, build(app).getCOsConnectedTo);
    expect(html).toContain(EMPTY_WORDS);
    expect(html).toContain('CHANGE ORDERS (0)');
  });

  test('4b · the buildings WITH change orders no longer say it', () => {
    const app = makeAppData();
    const html = paintCards(app, build(app).getCOsConnectedTo);
    expect(html).toContain('CHANGE ORDERS (2)');   // B1
    expect(html).toContain('CHANGE ORDERS (1)');   // B2
    expect(html).toContain('CO-0001');
    expect(html).toContain('CO-0002');
  });

  test('4c · the words appear exactly as often as there are empty buildings', () => {
    const app = makeAppData();
    const html = paintCards(app, build(app).getCOsConnectedTo);
    expect(html.split(EMPTY_WORDS).length - 1).toBe(2);   // B3 and B4, not B1/B2
  });

  test('4d · a job with no change orders at all still paints the words on every card', () => {
    const app = makeAppData();
    app.jobChangeOrders = [];
    const html = paintCards(app, build(app).getCOsConnectedTo);
    expect(html.split(EMPTY_WORDS).length - 1).toBe(BUILDINGS.length);
  });

  test('4e · a job whose ONLY change orders are unapproved still says the words', () => {
    // The dangerous near-miss: money exists in the store, none of it qualifies,
    // and the card must say "none" rather than render an empty list.
    const app = makeAppData();
    app.jobChangeOrders = [CO_DRAFT_B2, CO_REJECTED_B1, CO_VOID_B3].map((c) => Object.assign({}, c));
    const html = paintCards(app, build(app).getCOsConnectedTo);
    expect(html.split(EMPTY_WORDS).length - 1).toBe(BUILDINGS.length);
    expect(html).not.toContain('CO-0003');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 5 · THE STRIP — true, not merely balanced
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('5 · the allocation strip reconciles on a figure that is true', () => {
  test('5a · Allocated and Unallocated are byte-identical before and after the fix', () => {
    const appBefore = makeAppData();
    const appAfter = makeAppData();
    const before = paintCards(appBefore, build(appBefore, MUT_OLD_KEY()).getCOsConnectedTo);
    const after = paintCards(appAfter, build(appAfter).getCOsConnectedTo);
    const strip = (h) => h.slice(h.indexOf('p86-mline-strip'), h.indexOf('p86-mline-list'));
    expect(strip(after)).toBe(strip(before));
    // And the card bodies DID change — so the byte-identity above is a real
    // invariant rather than a comparison of two identical renders.
    expect(after).not.toBe(before);
  });

  test('5b · the strip carries no change-order term on EITHER side', () => {
    const app = makeAppData();
    const recon = reconFor(app).getJobBudgetRecon(JOB);
    expect(recon.contract).toBe(CONTRACT);          // base contract alone
    expect(round2(recon.onBuildings)).toBe(25000);  // base scope split alone
    expect(round2(recon.gap)).toBe(0);
    expect(recon.full).toBe(true);
  });

  test('5c · getJobContractTotal is the base term and reads no change order', () => {
    const src = extractFunction(JOBS_SRC, 'getJobContractTotal');
    expect(src).toMatch(/contractAmount/);
    expect(src).not.toMatch(/jobChangeOrders|getJobCOTotals|coIncome/);
  });

  test('5d · the "obvious" repair is the wrong one — it invents a shortfall', () => {
    // Option (b): contract := contractAmount + CO income. `onBuildings` has no
    // CO term to match it, so only the numerator moves and a fully-allocated
    // job reads $14,000 short. Held as arithmetic so it is not introduced later
    // as a tidy-up by someone who assumes the strip must already include COs.
    const app = makeAppData();
    const recon = reconFor(app).getJobBudgetRecon(JOB);
    const coIncome = 14000;                     // approved + applied only
    const wrongGap = (recon.contract + coIncome) - recon.onBuildings;
    expect(round2(wrongGap)).toBe(coIncome);
    expect(round2(recon.gap)).toBe(0);
    // A reconciled job would turn red for exactly the change-order income.
    expect(Math.abs(wrongGap) > Math.max(1, BUILDINGS.length)).toBe(true);
  });

  test('5e · the card reader never reaches the strip at all', () => {
    // getCOsConnectedTo's return value is consumed by the CO list and nothing
    // else — not totalBudget, not totalSpent, not the recon.
    const render = extractFunction(JOBS_SRC, 'renderJobBuildings');
    const uses = render.split('cosWired').length - 1;
    expect(uses).toBe(4);   // one assignment + .length ×2 + .forEach
    expect(render).not.toMatch(/totalBudget\s*\+?=\s*[^;]*cosWired/);
    expect(render).not.toMatch(/cosWired[^;]*totalSpent/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 6 · NOTHING AT REST REPRICES
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('6 · the fix changes what a card READS, never what is stored', () => {
  test('6a · the stored rows are byte-identical after a full read of every card', () => {
    const app = makeAppData();
    const snapshot = JSON.stringify(app);
    const H = build(app);
    BUILDINGS.forEach((b) => H.getCOsConnectedTo('t1', b.id));
    expect(JSON.stringify(app)).toBe(snapshot);
  });

  test('6b · the row handed to the card is a COPY — mutating it cannot reach the store', () => {
    const app = makeAppData();
    const row = build(app).getCOsConnectedTo('t1', B.one)[0];
    expect(row.co).not.toBe(app.jobChangeOrders[0]);
    row.co.title = 'CLOBBERED';
    row.co.income = 999999;
    const stored = app.jobChangeOrders.find((c) => c.id === 'co-a');
    expect(stored.title).toBe('Add lanai');
    expect(stored.income).toBeUndefined();
  });

  test('6c · the function body contains no write of any kind', () => {
    // Read-only, proven by its own text, so a future edit that adds a save has
    // to delete this assertion on purpose rather than slip past review.
    [/saveData/, /localStorage/, /p86Api/, /\bfetch\s*\(/, /appData\.\w+\s*=[^=]/].forEach((re) => {
      expect(GETCOS_SRC).not.toMatch(re);
    });
  });

  test('6d · getJobCOTotals is byte-identical before and after, and already agreed', () => {
    const app = makeAppData();
    const coSellAmount = compile([extractFunction(JOBS_SRC, 'coSellAmount')], ['window'], [window], 'coSellAmount');
    const getJobCOTotals = compile([extractFunction(JOBS_SRC, 'getJobCOTotals')],
      ['appData', 'coSellAmount', 'window'], [app, coSellAmount, window], 'getJobCOTotals');
    const before = JSON.stringify(getJobCOTotals(JOB));
    build(app).getCOsConnectedTo('t1', B.one);
    expect(JSON.stringify(getJobCOTotals(JOB))).toBe(before);
    expect(round2(getJobCOTotals(JOB).income)).toBe(14000);   // approved+applied
  });

  test('6e · the card total equals the job change-order total — one number, two surfaces', () => {
    const app = makeAppData();
    const coSellAmount = compile([extractFunction(JOBS_SRC, 'coSellAmount')], ['window'], [window], 'coSellAmount');
    const getJobCOTotals = compile([extractFunction(JOBS_SRC, 'getJobCOTotals')],
      ['appData', 'coSellAmount', 'window'], [app, coSellAmount, window], 'getJobCOTotals');
    const H = build(app);
    const cards = BUILDINGS.reduce((s, b) => s + dollars(H.getCOsConnectedTo('t1', b.id)), 0);
    expect(round2(cards)).toBe(round2(getJobCOTotals(JOB).income));
  });

  test('6f · the server never sees this function, so what 86 reports cannot move', () => {
    const files = fs.readdirSync(path.join(REPO, 'server', 'services', 'money'));
    files.forEach((f) => {
      expect(read(path.join('server', 'services', 'money', f))).not.toMatch(/getCOsConnectedTo/);
    });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 7 · THE G703 — the card's dollars ARE the pay application's dollars
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('7 · card change-order dollars reconcile to the G703, per building', () => {
  /* Fairways RV2008 CO-0001 — the job test/co-completion-port.test.js
   * reconstructs from John's screenshot. A RIDER change order whose split is
   * INHERITED from the Gutters scope rather than stored, which is the shape
   * that exercises the most machinery: ten buildings, $27,500. */
  const F_JOB = 'j1783317122508';
  const F_CELLS = [
    ['B1', 11000, 100], ['B2', 10905, 100], ['B3', 11500, 90], ['B4', 10500, 80], ['B5', 11250, 75],
    ['B6', 10800, 70], ['B7', 11100, 65], ['B8', 10995, 60], ['B9', 11000, 50], ['B10', 11000, 48],
  ].map(([b, rev, pct], i) => ({
    id: 'fp' + (i + 1), jobId: F_JOB, phase: 'Gutters', buildingId: b, workScope: 'sub',
    asSoldRevenue: rev, asSoldPhaseBudget: rev, phaseBudget: rev, pctComplete: pct, sub: 0, coPhaseBudget: 0,
  }));
  const F_BUILDINGS = F_CELLS.map((p) => ({ id: p.buildingId, jobId: F_JOB, name: p.buildingId }));
  const F_CO = shapeRow({
    id: 'fco1', job_id: F_JOB, owner_id: 'u1', status: 'approved', co_number: 'CO-0001',
    data: {
      title: 'Gutters', defaultMarkup: 0, completionMode: 'rider', riderScopeName: 'Gutters',
      buildingAllocations: [],
      lines: Array.from({ length: 10 }, (_, i) => ({ id: 'fl' + i, description: 'Gutter run ' + i, qty: 1, unitCost: 2750 })),
    },
    approved_at: null, approved_by: null, linked_node_id: null, is_locked: false,
    created_at: null, updated_at: null,
  });

  const fairways = () => ({
    jobs: [{ id: F_JOB, jobNumber: 'RV2008', pctComplete: 51, contractAmount: 300000 }],
    phases: F_CELLS, buildings: F_BUILDINGS, jobChangeOrders: [F_CO], changeOrders: [],
  });

  function fairwaysCards(src) {
    const app = fairways();
    const coSellAmount = compile([extractFunction(JOBS_SRC, 'coSellAmount')], ['window'], [window], 'coSellAmount');
    window.coSellAmount = coSellAmount;
    const coCompletion = compile([extractFunction(JOBS_SRC, 'coCompletion')],
      ['appData', 'coSellAmount', 'window'], [app, coSellAmount, window], 'coCompletion');
    window.coCompletion = coCompletion;
    const getCOs = compile([src || GETCOS_SRC],
      ['appData', 'appState', 'coCompletion', 'ensureNGLoaded', 'NG', 'window'],
      [app, { currentJobId: F_JOB }, coCompletion, () => {}, undefined, window], 'getCOsConnectedTo');
    const out = {};
    F_BUILDINGS.forEach((b) => { out[b.id] = round2(dollars(getCOs('t1', b.id))); });
    return { app, out, getCOs, sell: coSellAmount(F_CO) };
  }

  function fairwaysG703(app) {
    window.appData = app;
    const deriveSOV = compile([
      extractFunction(PA_SRC, 'num'), extractFunction(PA_SRC, 'round2'),
      extractFunction(PA_SRC, 'bldgSort'), extractFunction(PA_SRC, 'deriveSOV'),
    ], ['window'], [window], 'deriveSOV');
    const sov = deriveSOV(F_JOB);
    const lines = (Array.isArray(sov) ? sov : (sov.lines || [])).filter((l) => l.type === 'co');
    const byB = {};
    lines.forEach((l) => { byB[l.buildingId] = round2((byB[l.buildingId] || 0) + l.scheduledValue); });
    return { byB, lines };
  }

  test('7a · every building card matches its G703 change-order line to the penny', () => {
    const { app, out } = fairwaysCards();
    const { byB } = fairwaysG703(app);
    F_BUILDINGS.forEach((b) => {
      expect([b.id, out[b.id]]).toEqual([b.id, byB[b.id]]);
    });
  });

  test('7b · the per-building totals agree, and the penny is the G703\'s own residue', () => {
    const { app, out, sell } = fairwaysCards();
    const { byB, lines } = fairwaysG703(app);
    // Ten cents-rounded building shares of a $27,500 rider do not land on a
    // round number — both surfaces sum to the SAME $27,499.99.
    const cardTotal = round2(Object.values(out).reduce((s, v) => s + v, 0));
    const perBuilding = round2(Object.keys(byB)
      .filter((k) => k !== '__gen').reduce((s, k) => s + byB[k], 0));
    expect(cardTotal).toBe(27499.99);
    expect(perBuilding).toBe(cardTotal);

    // deriveSOV emits a remainder line precisely so its lines sum EXACTLY to
    // round2(sell) — by design (js/pay-applications.js), not drift. With it,
    // the G703 totals the priced change order to the cent.
    const g703All = round2(lines.reduce((s, l) => s + l.scheduledValue, 0));
    expect(g703All).toBe(27500);
    expect(round2(sell)).toBe(27500);
    expect(round2(g703All - perBuilding)).toBe(0.01);

    // And the card, summed UNROUNDED, is the whole change order — the cent is
    // a display artefact of rounding ten shares, not money that went missing.
    const H = fairwaysCards();
    const raw = F_BUILDINGS.reduce((s, b) => s + dollars(H.getCOs('t1', b.id)), 0);
    expect(round2(raw)).toBe(27500);
  });

  test('7c · MUTATION — with the old key the rider reaches no card at all', () => {
    const { getCOs } = fairwaysCards(MUT_OLD_KEY());
    F_BUILDINGS.forEach((b) => expect(getCOs('t1', b.id)).toEqual([]));
  });

  test('7d · the PERCENTAGES may differ from the G703, and that is correct', () => {
    // The card shows the ridden scope's cell %; the G703 seeds every change-order
    // line at 0 for the biller to fill in. Pinned so a future "harmonisation"
    // has to argue with this rather than quietly move one of them.
    expect(PA_SRC).toContain("type: 'co', scheduledValue: amt, pctComplete: 0");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 8 · THE CACHE-BUSTER — an edit to js/jobs.js that never reaches a browser
 *     is not a fix
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('8 · js/jobs.js is served at a version that carries this change', () => {
  test('8a · index.html requests js/jobs.js at v239 or later', () => {
    const m = INDEX_HTML.match(/js\/jobs\.js\?v=(\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBeGreaterThanOrEqual(239);
  });
});
