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

/* ── THE SECOND HALF OF THE FUNCTION, WHICH THIS FILE NEVER RAN ──────────────
 * getCOsConnectedTo has two branches. The live one resolves a change order
 * through its OWN allocation; the legacy one resolves it through a node-graph
 * wire, and is entered unless `typeof NG === 'undefined'`. This harness passed
 * NG as undefined, so 823 lines of test executed the first branch only — while
 * asserting, in sections 2 and 3, the exact two properties the second branch
 * violated. Both assertions were true of half a function.
 *
 * `typeof NG === 'undefined'` is NEVER true in the running app: nodegraph/
 * engine.js declares `var NG` at top level and index.html loads it
 * unconditionally (asserted in 11a, by reading those two files). So the honest
 * default here is a real graph, and the honest default WIRING is the most
 * adversarial the surface admits: every change order in the fixture — draft,
 * rejected, void, another job's, and one allocated 100%% to Building 2 — wired
 * at the graph's own default allocPct straight at Building 1.
 *
 * A test that wants the live branch in isolation passes NO_WIRES and says why.
 * ────────────────────────────────────────────────────────────────────────── */
function makeNG(wires) {
  const nodes = BUILDINGS.map((b) => ({ id: 'n-t1-' + b.id, type: 't1', data: { id: b.id } }));
  const links = [];
  (wires || []).forEach((w, i) => {
    const nid = 'n-co-' + i;
    nodes.push({ id: nid, type: 'co', data: { id: w.co } });
    links.push({ fromNode: nid, toNode: 'n-t1-' + w.building, allocPct: w.allocPct });
  });
  return {
    nodes: () => nodes, wires: () => links,
    findNode: (id) => nodes.find((n) => n.id === id) || null,
  };
}

/* allocPct undefined on purpose: `w.allocPct != null ? w.allocPct : 100` is the
 * shipped default and 100%% of a foreign $123,456 is the loudest possible leak. */
const ALL_WIRED_TO_B1 = ALL_COS.map((c) => ({ co: c.id, building: B.one }));
const NO_WIRES = [];

function build(appData, src, wires) {
  const appState = { currentJobId: JOB };
  const coSellAmount = compile([extractFunction(JOBS_SRC, 'coSellAmount')], ['window'], [window], 'coSellAmount');
  window.coSellAmount = coSellAmount;
  const coCompletion = compile([extractFunction(JOBS_SRC, 'coCompletion')],
    ['appData', 'coSellAmount', 'window'], [appData, coSellAmount, window], 'coCompletion');
  window.coCompletion = coCompletion;
  const getCOsConnectedTo = compile([src || GETCOS_SRC],
    ['appData', 'appState', 'coCompletion', 'ensureNGLoaded', 'NG', 'window'],
    [appData, appState, coCompletion, () => {},
     makeNG(wires === undefined ? ALL_WIRED_TO_B1 : wires), window], 'getCOsConnectedTo');
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
    //
    // NO_WIRES on purpose, and the reason is worth stating: this clause is a
    // claim about the LIVE branch's two guards, and with the legacy branch now
    // correct a wire would legitimately re-supply CO-0001 and CO-0002 from the
    // graph and hide the very regression this mutation exists to show. 11g
    // holds that combined behaviour separately rather than blurring it in here.
    const src = MUT_OLD_KEY();
    expect(src).toContain("c.status !== 'approved'");
    expect(build(makeAppData(), src, NO_WIRES).getCOsConnectedTo('t1', B.one)).toEqual([]);
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

  /* A REAL graph over the Fairways buildings, not `NG: undefined`. This
   * section is the per-building RECONCILIATION — the one place that proves the
   * card's dollars are the pay application's dollars — and it was proving it
   * about the live branch only. The legacy branch paints the SAME card from the
   * SAME store, so a wire that re-supplies a change order the allocation
   * already placed would break exactly this reconciliation and this section
   * would never have seen it. The wiring is the most adversarial the surface
   * admits: the one $27,500 rider wired at the graph's default allocPct (100)
   * at EVERY ONE of the ten buildings, i.e. $275,000 of card money against
   * $27,500 of G703 if the wire is allowed to speak over the allocation. */
  function fairwaysNG(wires) {
    const nodes = F_BUILDINGS.map((b) => ({ id: 'n-t1-' + b.id, type: 't1', data: { id: b.id } }));
    const links = [];
    (wires || []).forEach((w, i) => {
      const nid = 'n-co-' + i;
      nodes.push({ id: nid, type: 'co', data: { id: w.co } });
      links.push({ fromNode: nid, toNode: 'n-t1-' + w.building, allocPct: w.allocPct });
    });
    return {
      nodes: () => nodes, wires: () => links,
      findNode: (id) => nodes.find((n) => n.id === id) || null,
    };
  }
  const F_WIRED_EVERYWHERE = F_BUILDINGS.map((b) => ({ co: F_CO.id, building: b.id }));

  function fairwaysCards(src, wires) {
    const app = fairways();
    const coSellAmount = compile([extractFunction(JOBS_SRC, 'coSellAmount')], ['window'], [window], 'coSellAmount');
    window.coSellAmount = coSellAmount;
    const coCompletion = compile([extractFunction(JOBS_SRC, 'coCompletion')],
      ['appData', 'coSellAmount', 'window'], [app, coSellAmount, window], 'coCompletion');
    window.coCompletion = coCompletion;
    const getCOs = compile([src || GETCOS_SRC],
      ['appData', 'appState', 'coCompletion', 'ensureNGLoaded', 'NG', 'window'],
      [app, { currentJobId: F_JOB }, coCompletion, () => {},
       fairwaysNG(wires === undefined ? F_WIRED_EVERYWHERE : wires), window], 'getCOsConnectedTo');
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

  /* 7e — THE RECONCILIATION ACROSS BOTH BRANCHES.
   *
   * 7a-7d wire the rider at every building, which reaches the legacy branch on
   * NO card: the live branch accepts that rider everywhere and stamps seenCo,
   * so the wire is unreachable and those clauses remain, honestly, a statement
   * about the live branch alone. Stated rather than implied, because a wired
   * fixture that never reaches the wire proves nothing about it.
   *
   * This clause reaches it. A SECOND change order, $40,000, allocated 100%% to
   * B2 and wired at B1 — the live branch rejects it on B1 (B1 holds no share),
   * so the wire is the only thing that can speak there. deriveSOV bills it as
   * one $40,000 line against B2 and nothing against B1, so if the wire is
   * allowed to answer, B1's card carries $40,000 the pay application puts on
   * B2 and this reconciliation breaks by exactly that much. Mutation-proven:
   * disarming the allocation clause turns this red at B1 (+40000) and nowhere
   * else. */
  const F_CO_ELSEWHERE = shapeRow({
    id: 'fco2', job_id: F_JOB, owner_id: 'u1', status: 'approved', co_number: 'CO-0002',
    data: {
      title: 'Sitework', defaultMarkup: 0, completionMode: 'standalone',
      buildingAllocations: [{ buildingId: 'B2', pct: 100 }],
      lines: [{ id: 'fx1', description: 'Sitework', qty: 1, unitCost: 40000 }],
    },
    approved_at: null, approved_by: null, linked_node_id: null, is_locked: false,
    created_at: null, updated_at: null,
  });

  test('7e · a change order wired to a building it is NOT allocated to keeps the reconciliation', () => {
    const app = fairways();
    app.jobChangeOrders = [F_CO, F_CO_ELSEWHERE];
    const coSellAmount = compile([extractFunction(JOBS_SRC, 'coSellAmount')], ['window'], [window], 'coSellAmount');
    window.coSellAmount = coSellAmount;
    const coCompletion = compile([extractFunction(JOBS_SRC, 'coCompletion')],
      ['appData', 'coSellAmount', 'window'], [app, coSellAmount, window], 'coCompletion');
    window.coCompletion = coCompletion;
    const getCOs = compile([GETCOS_SRC],
      ['appData', 'appState', 'coCompletion', 'ensureNGLoaded', 'NG', 'window'],
      [app, { currentJobId: F_JOB }, coCompletion, () => {},
       fairwaysNG([{ co: 'fco2', building: 'B1' }]), window], 'getCOsConnectedTo');

    const { byB } = fairwaysG703(app);
    F_BUILDINGS.forEach((b) => {
      expect([b.id, round2(dollars(getCOs('t1', b.id)))]).toEqual([b.id, round2(byB[b.id])]);
    });
    // and the $40,000 is on B2, where the G703 bills it — not deleted. Measured
    // as the DIFFERENCE from the same job without this change order, so the
    // rider's own weighted B2 share never has to be restated here.
    const base = fairwaysCards(null, []).out;
    expect(round2(dollars(getCOs('t1', 'B2')) - base.B2)).toBe(40000);
    expect(round2(dollars(getCOs('t1', 'B1')) - base.B1)).toBe(0);
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
  test('8a · index.html requests js/jobs.js at v245 or later', () => {
    // The whole token, not a numeric PREFIX of it. `?v=(\d+)` reads "4" out
    // of "4h" and compares 4 >= 4 quite happily, which is how a reviewer on
    // this file once certified a bump that had not happened. Capture to the
    // quote, prove it is digits, and only then compare.
    const m = INDEX_HTML.match(/js\/jobs\.js\?v=([^"\s>]*)/);
    expect(m).not.toBeNull();
    expect(m[1]).toMatch(/^\d+$/);
    expect(Number(m[1])).toBeGreaterThanOrEqual(245);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 9 · THE ROW SAYS WHAT THE CHANGE ORDER IS
 *
 * The row printed `c.description`. A server change-order row has no such
 * field: every create path writes `title`, and shapeRow stamps nothing called
 * description (description belongs to a change order's LINES, not to the
 * change order). While the key bug hid this list entirely the defect was
 * unobservable. The moment the list paints, every row ships as a change-order
 * number followed by nothing — so this is repaired in the same wave that made
 * the list reachable, rather than shipped as a fresh visible defect.
 *
 * `description` is still read FIRST, so any pre-server row that genuinely
 * carries one renders exactly as it did.
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('9 · a change-order row is named, not left blank', () => {
  test('9a · the rows this store holds carry title and no description at all', () => {
    expect(CO_APPROVED_B1.title).toBe('Add lanai');
    expect('description' in CO_APPROVED_B1).toBe(false);
  });

  test('9b · the painted row shows the change order title beside its number', () => {
    const app = makeAppData();
    const html = paintCards(app, build(app).getCOsConnectedTo);
    expect(html).toContain('CO-0001');
    expect(html).toContain('Add lanai');
    expect(html).toContain('Regrade');
  });

  test('9c · MUTATION — reading description alone leaves every row nameless', () => {
    const app = makeAppData();
    const html = paintCards(app, build(app).getCOsConnectedTo,
      (src) => src.replace("(c.description || c.title || '')", "(c.description || '')"));
    expect(html).toContain('CO-0001');          // the number still paints
    expect(html).not.toContain('Add lanai');    // and nothing else does
    expect(html).not.toContain('Regrade');
  });

  test('9d · a legacy row that really carries a description still wins', () => {
    const app = makeAppData();
    app.jobChangeOrders = [Object.assign({}, CO_APPROVED_B1,
      { description: 'Legacy words', title: 'Not this one' })];
    const html = paintCards(app, build(app).getCOsConnectedTo);
    expect(html).toContain('Legacy words');
    expect(html).not.toContain('Not this one');
  });

  test('9e · a row with neither still renders — no crash, no "undefined"', () => {
    const app = makeAppData();
    const bare = Object.assign({}, CO_APPROVED_B1);
    delete bare.title;
    app.jobChangeOrders = [bare];
    const html = paintCards(app, build(app).getCOsConnectedTo);
    expect(html).toContain('CO-0001');
    expect(html).not.toContain('undefined');
  });

  test('9f · the title is escaped, not injected', () => {
    const app = makeAppData();
    app.jobChangeOrders = [serverCO({
      id: 'co-x', status: 'approved', co_number: 'CO-0010',
      data: { title: '<img src=x onerror=alert(1)>', lines: line(1000),
              buildingAllocations: [{ buildingId: B.one, pct: 100 }] },
    })];
    const html = paintCards(app, build(app).getCOsConnectedTo);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 10 · A CREDIT CHANGE ORDER IS STILL A CHANGE ORDER
 *
 * The card admitted a building's share only when `b.share > 0`, and divided by
 * `comp.sell` only when `comp.sell > 0`. A DEDUCTIVE change order — one that
 * takes work out of the contract — has a negative sell and a negative share, so
 * it failed both, and the card said "No change orders allocated to this
 * building" about a building the G703 was billing minus five thousand dollars
 * against. A true "some" reported as "none", on a money surface, disagreeing
 * with the pay application.
 *
 * While the key bug hid every change order this was unreachable. Repointing the
 * key makes it reachable, so it is repaired in the same wave rather than shipped
 * as a new disagreement between two money screens.
 *
 * Both edits are STRICTLY ADDITIVE and 10f holds it byte-for-byte: for every
 * share and every sell that is not negative, the old and new predicates accept
 * exactly the same rows and compute exactly the same percentage. Nothing that
 * shows today can stop showing.
 *
 * The dollar THRESHOLDS still differ across the three per-building readers —
 * this card admits any non-zero share, deriveSOV gates on pct, and the Site
 * Plan's buildingRevSources uses fifty cents. Harmonising them would move money
 * on three surfaces at once, so they are deliberately left alone and named here
 * instead of quietly aligned inside this commit.
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('10 · a deductive change order reaches the card it is allocated to', () => {
  const CREDIT = serverCO({
    id: 'co-neg', status: 'approved', co_number: 'CO-0007',
    data: { title: 'Deleted the lanai', lines: line(-5000),
            buildingAllocations: [{ buildingId: B.one, pct: 100 }] },
  });

  function creditApp() {
    const app = makeAppData();
    app.jobChangeOrders = [Object.assign({}, CREDIT)];
    return app;
  }

  test('10a · it appears on its building, at its real negative dollars', () => {
    const rows = build(creditApp()).getCOsConnectedTo('t1', B.one);
    expect(coNumbers(rows)).toEqual(['CO-0007']);
    expect(rows[0].allocPct).toBe(100);
    expect(round2(dollars(rows))).toBe(-5000);
  });

  test('10b · and it agrees with what the G703 bills for that same building', () => {
    const app = creditApp();
    window.appData = app;
    const deriveSOV = compile([
      extractFunction(PA_SRC, 'num'), extractFunction(PA_SRC, 'round2'),
      extractFunction(PA_SRC, 'bldgSort'), extractFunction(PA_SRC, 'deriveSOV'),
    ], ['window'], [window], 'deriveSOV');
    const sov = deriveSOV(JOB);
    const onB1 = (Array.isArray(sov) ? sov : (sov.lines || []))
      .filter((l) => l.type === 'co' && l.buildingId === B.one)
      .reduce((s, l) => s + l.scheduledValue, 0);
    expect(round2(onB1)).toBe(-5000);
    expect(round2(dollars(build(creditApp()).getCOsConnectedTo('t1', B.one)))).toBe(round2(onB1));
  });

  test('10c · the other buildings still say the words — three honest "none"s', () => {
    const app = creditApp();
    const html = paintCards(app, build(app).getCOsConnectedTo);
    expect(html.split(EMPTY_WORDS).length - 1).toBe(3);   // B2, B3, B4
    expect(html).toContain('CHANGE ORDERS (1)');           // B1
  });

  test('10d · MUTATION — the old sign gate hides it while the G703 bills it', () => {
    const H = build(creditApp(),
      mutate('if (!b || !(Math.abs(b.share) > 0)) return;', 'if (!b || !(b.share > 0)) return;'));
    expect(H.getCOsConnectedTo('t1', B.one)).toEqual([]);
  });

  test('10e · MUTATION — the old divisor renders a $5,000 credit as $0', () => {
    const H = build(creditApp(), mutate('comp.sell !== 0 ?', 'comp.sell > 0 ?'));
    const rows = H.getCOsConnectedTo('t1', B.one);
    expect(rows.length).toBe(1);
    expect(round2(dollars(rows))).toBe(0);
  });

  test('10f · STRICTLY ADDITIVE — nothing that shows today stops showing', () => {
    // The whole safety argument for this commit, held byte-for-byte over the
    // main fixture: every positive change order, both predicates, identical.
    const oldGate = mutate('comp.sell !== 0 ?', 'comp.sell > 0 ?',
      mutate('if (!b || !(Math.abs(b.share) > 0)) return;', 'if (!b || !(b.share > 0)) return;'));
    const now = build(makeAppData());
    const before = build(makeAppData(), oldGate);
    BUILDINGS.forEach((b) => {
      expect(JSON.stringify(now.getCOsConnectedTo('t1', b.id)))
        .toBe(JSON.stringify(before.getCOsConnectedTo('t1', b.id)));
    });
  });

  test('10g · a genuinely $0 change order is still excluded from the card', () => {
    const app = makeAppData();
    app.jobChangeOrders = [serverCO({
      id: 'co-zero', status: 'approved', co_number: 'CO-0000',
      data: { lines: line(0), buildingAllocations: [{ buildingId: B.one, pct: 100 }] },
    })];
    expect(build(app).getCOsConnectedTo('t1', B.one)).toEqual([]);
  });

  test('10h · a draft credit is still excluded — the status filter still rules', () => {
    const app = makeAppData();
    app.jobChangeOrders = [Object.assign({}, CREDIT, { status: 'draft' })];
    expect(build(app).getCOsConnectedTo('t1', B.one)).toEqual([]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 11 · THE OTHER HALF OF THE FUNCTION — a graph wire is not an allocation
 *
 * Everything above this line ran the LIVE branch. This section runs the LEGACY
 * one, which the harness used to switch off by injecting NG as undefined, and
 * which resolved a change order on `c.id === src.data.id` and nothing else —
 * no job guard, no status filter, and at the WIRE's allocPct rather than the
 * change order's own per-building share. Because seenCo was stamped only for
 * change orders the live branch ACCEPTED, everything the live branch rejected
 * was exactly what this branch was free to pick back up.
 *
 * Three leaks, all onto a money card, each reproduced below (11c, 11e, 11j)
 * against the shipped legacy branch before it is closed:
 *   • a DRAFT change order at its full $50,000;
 *   • another JOB's approved change order at $123,456;
 *   • one $50,000 change order allocated 100% to Building 2 rendering IN FULL
 *     on Building 1 as well — the same fifty thousand dollars on two cards,
 *     and $100,000 of card against $50,000 of G703.
 *
 * THE FIX IS NOT "TURN THE BRANCH OFF". That was the tempting one and it is
 * wrong, because coCompletion returns byBuilding {} for FOUR live shapes — a
 * change order with no completionMode at all (mode 'legacy', whose return
 * literal is `byBuilding: {}`), a rider on a job-level scope, a rider whose
 * scope has been renamed out from under it, and a standalone whose allocations
 * all point at deleted buildings. For every one of those the wire is the ONLY
 * thing that has ever put that money on a card. Switching the branch off
 * silently zeroes all four. 11n proves it byte-for-byte with the money on
 * screen, which is why it is not what shipped here.
 *
 * So the branch keeps its job, under the live branch's own two guards, plus one
 * rule: WHEN THE CHANGE ORDER HAS ITS OWN ALLOCATION, THE ALLOCATION WINS. If
 * coCompletion resolves any per-building split at all, the live branch above
 * has already ruled on this exact building — accepting it (and stamping seenCo,
 * so the wire is never consulted) or rejecting it because the building holds no
 * share of it. A wire may not overrule that. Where there is no split to
 * overrule, the wire still renders exactly what it renders today.
 *
 * The two halves of that are BOTH load-bearing and neither subsumes the other:
 * the allocation rule closes an allocated draft (11d) but is blind to a
 * change order that carries no allocation, and the guards close a statusless,
 * modeless one (11g, 11i) that the allocation rule waves straight through.
 * ═══════════════════════════════════════════════════════════════════════════ */

/* Each mutator rewinds ONE clause of the legacy branch to its shipped-broken
 * spelling; mutate() throws if a rename ever makes one of them a no-op.
 * \r?\n throughout — this repo is core.autocrlf=true and the source these are
 * applied to came off disk with CRLF, which is how a regex written against \n
 * alone silently matches nothing. */
const MUT_LEG_NO_JOB = (src) => mutate(
  /\r?\n +if \(jobId && srv\.job_id !== jobId\) return;/, '', src);
const MUT_LEG_NO_STATUS = (src) => mutate(
  /\r?\n +if \(srv\.status !== 'approved' && srv\.status !== 'applied'\) return;/, '', src);
/* `var lcomp = null;` on the very next line is load-bearing in this anchor:
 * the CONDITION alone appears twice in the function — the live branch opens
 * with the identical `targetType === 't1' && typeof coCompletion` — and a
 * regex without it matched from there and deleted three quarters of the
 * function, producing a mutant that failed to PARSE rather than one that
 * demonstrated anything. A mutation that dies of a SyntaxError proves the same
 * amount as a mutation that does not apply: nothing. */
const MUT_LEG_NO_ALLOC = (src) => mutate(
  /\r?\n +if \(targetType === 't1' && typeof coCompletion === 'function'\) \{\r?\n +var lcomp = null;[\s\S]*?\r?\n +\}(\r?\n +var lines =)/,
  '$1', src);
const MUT_LEG_NO_RELIC_JOB = (src) => mutate(
  /\r?\n +if \(coEntry && jobId && coEntry\.jobId !== jobId\) return;/, '', src);

/* All four at once = origin/main's legacy branch, which is what the three
 * leaks are reproduced against and what "nothing moved" is measured against. */
const MUT_LEGACY_AS_SHIPPED = () =>
  MUT_LEG_NO_RELIC_JOB(MUT_LEG_NO_ALLOC(MUT_LEG_NO_STATUS(MUT_LEG_NO_JOB(GETCOS_SRC))));

describe('11 · the node-wire branch obeys the same two guards, and the allocation', () => {
  test('11a · the branch under test ACTUALLY EXECUTES — proven by the graph being read', () => {
    // Not a source assertion. The injected NG counts its own calls, so this
    // goes red the day someone reintroduces `NG: undefined` and quietly
    // switches the other 47 tests in this file back off.
    let reads = 0;
    const base = makeNG(ALL_WIRED_TO_B1);
    const spy = { nodes: () => { reads++; return base.nodes(); },
                  wires: () => { reads++; return base.wires(); },
                  findNode: base.findNode };
    const app = makeAppData();
    const coSellAmount = compile([extractFunction(JOBS_SRC, 'coSellAmount')], ['window'], [window], 'coSellAmount');
    window.coSellAmount = coSellAmount;
    const coCompletion = compile([extractFunction(JOBS_SRC, 'coCompletion')],
      ['appData', 'coSellAmount', 'window'], [app, coSellAmount, window], 'coCompletion');
    const g = compile([GETCOS_SRC],
      ['appData', 'appState', 'coCompletion', 'ensureNGLoaded', 'NG', 'window'],
      [app, { currentJobId: JOB }, coCompletion, () => {}, spy, window], 'getCOsConnectedTo');
    g('t1', B.one);
    expect(reads).toBeGreaterThan(0);
  });

  test('11b · and it is reachable in the shipped app — NG is a top-level var, loaded unconditionally', () => {
    expect(read('nodegraph/engine.js')).toMatch(/^\s*var NG\s*=/m);
    expect(INDEX_HTML).toMatch(/<script src="nodegraph\/engine\.js/);
  });

  /* ── LEAK 1 · a draft ───────────────────────────────────────────────────── */

  test('11c · REPRODUCTION — the shipped legacy branch puts $50,000 of DRAFT money on a card', () => {
    // CO-0003 is a $50,000 draft allocated to B2. Wire it at B1 and the branch
    // as shipped renders it there in full, in words, on a money card.
    const app = makeAppData();
    const H = build(app, MUT_LEGACY_AS_SHIPPED());
    const rows = H.getCOsConnectedTo('t1', B.one);
    expect(coNumbers(rows)).toContain('CO-0003');
    const draft = rows.find((r) => r.co.co_number === 'CO-0003');
    expect(round2((draft.co.income || 0) * draft.allocPct / 100)).toBe(50000);
    expect(paintCards(makeAppData(), build(makeAppData(), MUT_LEGACY_AS_SHIPPED()).getCOsConnectedTo))
      .toContain('Inc: <b>$50,000.00</b> (100%)');
  });

  test('11d · and it no longer does — on any card, under either guard', () => {
    const H = build(makeAppData());
    BUILDINGS.forEach((b) => expect(coNumbers(H.getCOsConnectedTo('t1', b.id))).not.toContain('CO-0003'));
    expect(round2(dollars(H.getCOsConnectedTo('t1', B.one)))).toBe(10000);
    // Defence in depth, and both halves are proven live rather than assumed:
    // the allocation rule alone closes it (status filter removed), and the
    // status filter alone closes it (allocation rule removed).
    expect(coNumbers(build(makeAppData(), MUT_LEG_NO_STATUS()).getCOsConnectedTo('t1', B.one)))
      .not.toContain('CO-0003');
    expect(coNumbers(build(makeAppData(), MUT_LEG_NO_ALLOC()).getCOsConnectedTo('t1', B.one)))
      .not.toContain('CO-0003');
  });

  /* ── LEAK 2 · another job's money ───────────────────────────────────────── */

  test("11e · REPRODUCTION — the shipped legacy branch puts another JOB's $123,456 on this job's card", () => {
    const H = build(makeAppData(), MUT_LEGACY_AS_SHIPPED());
    const rows = H.getCOsConnectedTo('t1', B.one);
    expect(coNumbers(rows)).toContain('CO-9001');
    const foreign = rows.find((r) => r.co.co_number === 'CO-9001');
    expect(round2((foreign.co.income || 0) * foreign.allocPct / 100)).toBe(123456);
    expect(paintCards(makeAppData(), build(makeAppData(), MUT_LEGACY_AS_SHIPPED()).getCOsConnectedTo))
      .toContain('Inc: <b>$123,456.00</b> (100%)');
  });

  test('11f · and it no longer does — on any card, under either guard', () => {
    const H = build(makeAppData());
    BUILDINGS.forEach((b) => expect(coNumbers(H.getCOsConnectedTo('t1', b.id))).not.toContain('CO-9001'));
    expect(coNumbers(build(makeAppData(), MUT_LEG_NO_JOB()).getCOsConnectedTo('t1', B.one)))
      .not.toContain('CO-9001');
    expect(coNumbers(build(makeAppData(), MUT_LEG_NO_ALLOC()).getCOsConnectedTo('t1', B.one)))
      .not.toContain('CO-9001');
  });

  /* ── the guards are not dead code behind the allocation rule ────────────── */

  /* A change order with NO completionMode resolves to mode 'legacy', whose
   * byBuilding is {} unconditionally — so the allocation rule cannot see it and
   * the two guards are the only thing standing between it and the card. This
   * is not a contrived shape: nodegraph/engine.js mints exactly it, and every
   * change order predating the completion-mode work carries it. */
  const modeless = (over) => {
    const c = serverCO(over);
    delete c.completionMode; delete c.buildingAllocations;
    return c;
  };
  const CO_DRAFT_NOMODE = modeless({ id: 'co-dn', status: 'draft', co_number: 'CO-0080',
    data: { title: 'Draft, no mode', lines: line(50000) } });
  const CO_FOREIGN_NOMODE = modeless({ id: 'co-fn', job_id: OTHER_JOB, status: 'approved',
    co_number: 'CO-0081', data: { title: 'Another job, no mode', lines: line(123456) } });

  const oneCO = (co) => {
    const app = makeAppData();
    app.jobChangeOrders = [co];
    return app;
  };
  const wireTo = (co, b) => [{ co: co.id, building: b || B.one }];

  test('11g · a DRAFT with no completion mode — invisible to the allocation rule — is still excluded', () => {
    expect(build(oneCO(CO_DRAFT_NOMODE), null, wireTo(CO_DRAFT_NOMODE)).getCOsConnectedTo('t1', B.one))
      .toEqual([]);
  });

  test('11h · MUTATION — remove the legacy status filter and $50,000 of draft lands', () => {
    const rows = build(oneCO(CO_DRAFT_NOMODE), MUT_LEG_NO_STATUS(), wireTo(CO_DRAFT_NOMODE))
      .getCOsConnectedTo('t1', B.one);
    expect(coNumbers(rows)).toEqual(['CO-0080']);
    expect(round2(dollars(rows))).toBe(50000);
  });

  test("11i · another job's approved change order with no completion mode is still excluded", () => {
    expect(build(oneCO(CO_FOREIGN_NOMODE), null, wireTo(CO_FOREIGN_NOMODE)).getCOsConnectedTo('t1', B.one))
      .toEqual([]);
    // MUTATION — remove the legacy job guard and $123,456 of another job lands.
    const rows = build(oneCO(CO_FOREIGN_NOMODE), MUT_LEG_NO_JOB(), wireTo(CO_FOREIGN_NOMODE))
      .getCOsConnectedTo('t1', B.one);
    expect(coNumbers(rows)).toEqual(['CO-0081']);
    expect(round2(dollars(rows))).toBe(123456);
  });

  /* ── LEAK 3 · the wire overruling the allocation ────────────────────────── */

  const WRONG_B = serverCO({
    id: 'co-wrong', status: 'approved', co_number: 'CO-0050',
    data: { title: 'All of it on B2', lines: line(50000),
            buildingAllocations: [{ buildingId: B.two, pct: 100 }] },
  });
  const WIRE_WRONG_TO_B1 = [{ co: 'co-wrong', building: B.one }];

  function g703COTotal(app) {
    window.appData = app;
    const deriveSOV = compile([
      extractFunction(PA_SRC, 'num'), extractFunction(PA_SRC, 'round2'),
      extractFunction(PA_SRC, 'bldgSort'), extractFunction(PA_SRC, 'deriveSOV'),
    ], ['window'], [window], 'deriveSOV');
    const sov = deriveSOV(JOB);
    return round2((Array.isArray(sov) ? sov : (sov.lines || []))
      .filter((l) => l.type === 'co').reduce((s, l) => s + l.scheduledValue, 0));
  }

  test('11j · REPRODUCTION — $50,000 allocated 100% to Building 2 renders IN FULL on Building 1 too', () => {
    const H = build(oneCO(WRONG_B), MUT_LEGACY_AS_SHIPPED(), WIRE_WRONG_TO_B1);
    expect(coNumbers(H.getCOsConnectedTo('t1', B.one))).toEqual(['CO-0050']);
    expect(coNumbers(H.getCOsConnectedTo('t1', B.two))).toEqual(['CO-0050']);
    const total = BUILDINGS.reduce((s, b) => s + dollars(H.getCOsConnectedTo('t1', b.id)), 0);
    expect(round2(total)).toBe(100000);                       // twice the change order
    expect(g703COTotal(oneCO(WRONG_B))).toBe(50000);          // against half of that on the G703
  });

  test('11k · and now it appears ONCE, on the building it is actually allocated to', () => {
    const H = build(oneCO(WRONG_B), null, WIRE_WRONG_TO_B1);
    expect(coNumbers(H.getCOsConnectedTo('t1', B.one))).toEqual([]);
    expect(coNumbers(H.getCOsConnectedTo('t1', B.two))).toEqual(['CO-0050']);
    const cards = BUILDINGS.reduce((s, b) => s + dollars(H.getCOsConnectedTo('t1', b.id)), 0);
    expect(round2(cards)).toBe(50000);
    expect(round2(cards)).toBe(g703COTotal(oneCO(WRONG_B)));   // card = pay application
  });

  test('11l · a zero-share cell is an allocation too — share 0 on B1 does not re-open the wire', () => {
    // co-completion [S13] keys ZERO-revenue cells with share 0, and the live
    // branch rejects them (Math.abs(share) > 0). If "has an allocation" were
    // spelled "has a share on THIS building", a wire would refill exactly the
    // rows the live branch just turned down.
    const zero = serverCO({
      id: 'co-zshare', status: 'approved', co_number: 'CO-0060',
      data: { title: 'Nothing on B1', lines: line(50000),
              buildingAllocations: [{ buildingId: B.one, pct: 0 }, { buildingId: B.two, pct: 100 }] },
    });
    const H = build(oneCO(zero), null, wireTo(zero));
    expect(H.getCOsConnectedTo('t1', B.one)).toEqual([]);
    expect(round2(dollars(H.getCOsConnectedTo('t1', B.two)))).toBe(50000);
  });

  /* ── THE CONSTRAINT THAT OUTRANKS EVERYTHING ───────────────────────────────
   * No money that renders correctly today may stop rendering. Each shape below
   * is one for which coCompletion returns byBuilding {} — so the live branch
   * cannot see it at all and the WIRE is the only thing putting it on a card —
   * and each is held byte-identical against origin/main's legacy branch.
   * ────────────────────────────────────────────────────────────────────────── */

  const CO_NO_MODE = modeless({ id: 'co-nomode', status: 'approved', co_number: 'CO-0070',
    data: { title: 'Never chose a mode', lines: line(30000) } });
  /* A rider on a JOB-LEVEL scope — cells exist, none carries a buildingId. */
  const CO_RIDER_JOBLEVEL = serverCO({
    id: 'co-rjl', status: 'approved', co_number: 'CO-0071',
    data: { title: 'Rides a job-level scope', lines: line(21000),
            completionMode: 'rider', riderScopeName: 'JobLevel', buildingAllocations: [] },
  });
  /* A rider whose scope was renamed away — co-completion [S7]: it earns $0 and
   * says so, but SELL is what a card renders and the wire still shows it. */
  const CO_RIDER_MISSING = serverCO({
    id: 'co-rmiss', status: 'approved', co_number: 'CO-0072',
    data: { title: 'Scope renamed out from under it', lines: line(17000),
            completionMode: 'rider', riderScopeName: 'Gutters (old name)', buildingAllocations: [] },
  });
  /* Standalone, allocations pointing only at buildings no longer on the job —
   * co-completion [S10] drops them, so byBuilding comes back {}. */
  const CO_DEAD_ALLOCS = serverCO({
    id: 'co-dead', status: 'approved', co_number: 'CO-0073',
    data: { title: 'Aimed at a deleted building', lines: line(9000),
            buildingAllocations: [{ buildingId: 'b-deleted', pct: 100 }] },
  });

  const MONEY_THAT_MUST_NOT_MOVE = [
    [CO_NO_MODE, 'legacy', 30000],
    [CO_RIDER_JOBLEVEL, 'rider', 21000],
    [CO_RIDER_MISSING, 'rider', 17000],
    [CO_DEAD_ALLOCS, 'standalone', 9000],
  ];

  /* 'JobLevel' has to exist as a scope with no buildingId, or the job-level
   * rider would be exercising the missing-scope path instead. */
  const withJobLevelScope = (app) => {
    app.phases.push({ id: 'p-jl', jobId: JOB, phase: 'JobLevel', asSoldRevenue: 4000, pctComplete: 25 });
    return app;
  };

  test('11m · the premise, executed — all four really do resolve to byBuilding {}', () => {
    MONEY_THAT_MUST_NOT_MOVE.forEach(([co, mode]) => {
      const H = build(withJobLevelScope(makeAppData()), null, NO_WIRES);
      const comp = H.coCompletion(co, JOB);
      expect([co.co_number, comp.mode]).toEqual([co.co_number, mode]);
      expect([co.co_number, Object.keys(comp.byBuilding)]).toEqual([co.co_number, []]);
    });
  });

  test('11n · BYTE-FOR-BYTE against the shipped legacy branch — not one of them moved', () => {
    // The whole safety argument for this commit, and the reason the branch was
    // not simply switched off: same fixtures, same wires, origin/main's legacy
    // branch on one side and this one on the other, every building compared.
    const shipped = MUT_LEGACY_AS_SHIPPED();
    MONEY_THAT_MUST_NOT_MOVE.forEach(([co, , amount]) => {
      const wires = wireTo(co);
      const now = build(withJobLevelScope(oneCO(Object.assign({}, co))), null, wires);
      const before = build(withJobLevelScope(oneCO(Object.assign({}, co))), shipped, wires);
      BUILDINGS.forEach((b) => {
        expect([co.co_number, b.id, JSON.stringify(now.getCOsConnectedTo('t1', b.id))])
          .toEqual([co.co_number, b.id, JSON.stringify(before.getCOsConnectedTo('t1', b.id))]);
      });
      // And the money is really there — a pair of empty arrays would also be
      // byte-identical, which is precisely how a vacuous assertion passes.
      expect([co.co_number, round2(dollars(now.getCOsConnectedTo('t1', B.one)))])
        .toEqual([co.co_number, amount]);
    });
  });

  test('11o · a change order the clock THROWS on keeps the money the wire shows it', () => {
    // The live branch catches and moves on; so does this one, deliberately, so
    // a shape coCompletion cannot read is not also a shape that loses its money.
    const app = oneCO(Object.assign({}, CO_NO_MODE));
    const coSellAmount = compile([extractFunction(JOBS_SRC, 'coSellAmount')], ['window'], [window], 'coSellAmount');
    window.coSellAmount = coSellAmount;
    const throwing = () => { throw new Error('clock unavailable'); };
    const g = compile([GETCOS_SRC],
      ['appData', 'appState', 'coCompletion', 'ensureNGLoaded', 'NG', 'window'],
      [app, { currentJobId: JOB }, throwing, () => {},
       makeNG(wireTo(CO_NO_MODE)), window], 'getCOsConnectedTo');
    expect(round2(dollars(g('t1', B.one)))).toBe(30000);
  });

  /* ── the pre-server relic store ─────────────────────────────────────────── */

  const relic = (over) => Object.assign(
    { id: 'relic1', jobId: JOB, coNumber: 'CO-R1', income: 12000, estimatedCosts: 7000 }, over);
  const relicApp = (rows) => {
    const app = makeAppData();
    app.jobChangeOrders = [];
    app.changeOrders = rows;
    return app;
  };

  test('11p · a pre-server relic change order still renders, and carries no status to gate on', () => {
    // appData.changeOrders rows are minted by nodegraph/engine.js and the
    // legacy saveCO. Neither shape has a `status` key — asserted on the row,
    // not grepped — so a status filter here would not gate a draft, it would
    // zero every relic change order on every card.
    const r = relic();
    expect('status' in r).toBe(false);
    const rows = build(relicApp([r]), null, [{ co: 'relic1', building: B.one }]).getCOsConnectedTo('t1', B.one);
    expect(rows.length).toBe(1);
    expect(round2(dollars(rows))).toBe(12000);
  });

  test("11q · but a relic belonging to another job does NOT reach this job's card", () => {
    const r = relic({ id: 'relic2', jobId: OTHER_JOB, coNumber: 'CO-R2', income: 99000 });
    expect(build(relicApp([r]), null, [{ co: 'relic2', building: B.one }]).getCOsConnectedTo('t1', B.one))
      .toEqual([]);
  });

  test('11r · MUTATION — without the relic job guard, that $99,000 lands on the card', () => {
    const r = relic({ id: 'relic2', jobId: OTHER_JOB, coNumber: 'CO-R2', income: 99000 });
    const rows = build(relicApp([r]), MUT_LEG_NO_RELIC_JOB(), [{ co: 'relic2', building: B.one }])
      .getCOsConnectedTo('t1', B.one);
    expect(round2(dollars(rows))).toBe(99000);
  });

  test('11s · statusless-but-counted is how the relic store is read EVERYWHERE else', () => {
    // getJobCOTotals' legacy fallback gates relic rows on jobId and nothing
    // else. Executed over the shipped function, not asserted about its text.
    const app = relicApp([relic(), relic({ id: 'r2', jobId: OTHER_JOB, coNumber: 'CO-R2', income: 99000 })]);
    const coSellAmount = compile([extractFunction(JOBS_SRC, 'coSellAmount')], ['window'], [window], 'coSellAmount');
    const totals = compile([extractFunction(JOBS_SRC, 'getJobCOTotals')],
      ['appData', 'coSellAmount', 'window'], [app, coSellAmount, window], 'getJobCOTotals')(JOB);
    expect(totals.income).toBe(12000);   // statusless, and counted
    expect(totals.count).toBe(1);        // the other job's is not
  });

  /* ── nothing above this section moved ───────────────────────────────────── */

  test('11t · the LIVE branch is untouched — with no wires at all, section 1 still holds', () => {
    const H = build(makeAppData(), null, NO_WIRES);
    expect(coNumbers(H.getCOsConnectedTo('t1', B.one))).toEqual(['CO-0001', 'CO-0002']);
    expect(round2(dollars(H.getCOsConnectedTo('t1', B.one)))).toBe(10000);
    expect(round2(dollars(H.getCOsConnectedTo('t1', B.two)))).toBe(4000);
  });

  test('11u · and adding the wires changes not one figure on the main fixture', () => {
    const wired = build(makeAppData());
    const bare = build(makeAppData(), null, NO_WIRES);
    BUILDINGS.forEach((b) => {
      expect(JSON.stringify(wired.getCOsConnectedTo('t1', b.id)))
        .toBe(JSON.stringify(bare.getCOsConnectedTo('t1', b.id)));
    });
  });
});
