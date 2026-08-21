// EVERY DOLLAR COUNTED EXACTLY ONCE — across all five channels at once.
//
// The five places a change order's cost could land, and the ways they overlap:
//
//   1. CO cost        co.costs -> revisedEstCosts        (the BUDGET view)
//   2. PO accrual     poAccruedOf: ordered x pct - billed (the PROJECTION view)
//   3. sub accrual    subAccruedOf: contract x pct - billed
//   4. vendor bills   billedCostOf -> actualCosts
//   5. QB actuals     classifyCostLine -> actualCosts
//
// The four failure modes, each of which this file drives to a number:
//
//   (i)   co.costs enters accrual as well as budget            -> counted twice
//   (ii)  a second CO-cost channel adds it again               -> counted twice
//   (iii) the cost routes at a sub contract instead of a PO    -> DROPPED, via
//         the live-PO skip in subAccruedOf
//   (iv)  a bill for CO work carries po_id = NULL              -> counted twice
//
// (iv) is the one the design could not close alone and it is asserted here as
// a live hazard rather than as a solved problem — it needs a rule at bill
// entry, which is John's call and is named in the report.

const {
  computeJobWIP, poAccruedOf, subAccruedOf, billedCostOf, poOrderedTotal,
} = require('../server/services/money/job-wip');
const CD = require('../js/co-draw');

const r2 = (v) => Math.round(v * 100) / 100;

// ── the fixture: Fairways in shape, not in figures ─────────────────────────
// A job with one scope PO, one change order riding that scope, and the PO
// extended by an approved addendum for exactly the CO's cost.
const BASE = 100000;   // the Gutters PO as issued
const CO_COST = 27500; // the change order's raw line subtotal
const CO_SELL = 27500; // priced at cost — profit $0, exactly as the screenshot

const job = (over) => Object.assign({
  contractAmount: 500000, estimatedCosts: 400000, pctComplete: 0,
}, over || {});

const extendedPO = () => ({
  id: 'po1', sub_id: 'sub_gutters', status: 'issued', title: 'Gutters',
  lines: [{ qty: 1, unitCost: BASE + CO_COST }],
});

const shapedCO = () => [{ income: CO_SELL, costs: CO_COST, linked_node_id: null }];

const deps = (over) => Object.assign({
  phases: [], buildings: [],
  subs: [{ id: 'sub_gutters', contractAmt: BASE, billedToDate: 0 }],
  changeOrders: shapedCO(),
  invoices: [], qbCostLines: [], vendorBills: [], purchaseOrders: [extendedPO()],
}, over || {});

// ══ 1. THE FIVE CHANNELS, RECONCILED ═══════════════════════════════════════

describe('the cost lands in exactly one place at every completion', () => {
  const run = (pct, over) => computeJobWIP(job({ pctComplete: pct }), deps(over));

  test('0% — committed but not yet earned, so nothing accrues', () => {
    const w = run(0);
    expect(w.poAccrued).toBe(0);
    expect(w.accruedCosts).toBe(0);
    expect(w.actualCosts).toBe(0);
    expect(w.projectedCost).toBe(0);
    // The BUDGET view holds it, once, and only there.
    expect(w.revisedEstCosts).toBe(400000 + CO_COST);
    expect(w.coCosts).toBe(CO_COST);
  });

  test('40% unbilled — the whole commitment accrues once, CO share included', () => {
    const w = run(40);
    expect(r2(w.poAccrued)).toBe(r2((BASE + CO_COST) * 0.4));
    // The change order's OWN share, isolated:
    expect(r2(w.poAccrued - BASE * 0.4)).toBe(r2(CO_COST * 0.4));
    expect(r2(w.projectedCost)).toBe(r2((BASE + CO_COST) * 0.4));
    // And it did NOT also arrive through the budget: revisedEstCosts is a
    // parallel view, not an addend of projectedCost.
    expect(w.projectedCost).toBeLessThan(w.revisedEstCosts);
  });

  test('40% part-billed — the billed dollar LEAVES accrual and lands in actual', () => {
    const X = 20000;
    const w = run(40, { vendorBills: [{ po_id: 'po1', amount: X, status: 'open' }] });
    expect(r2(w.poAccrued)).toBe(r2((BASE + CO_COST) * 0.4 - X));
    expect(w.actualCosts).toBe(X);
    expect(r2(w.projectedCost)).toBe(r2((BASE + CO_COST) * 0.4));  // unchanged: once
  });

  test('100% fully billed — every dollar is actual and nothing is accrued twice', () => {
    const w = run(100, { vendorBills: [{ po_id: 'po1', amount: BASE + CO_COST, status: 'open' }] });
    expect(w.poAccrued).toBe(0);
    expect(w.actualCosts).toBe(BASE + CO_COST);
    expect(w.projectedCost).toBe(BASE + CO_COST);
  });

  test('QB actuals and PO bills are separate channels and do not overlap', () => {
    // QB non-sub lines REPLACE the graph/manual base; vendor bills add on top.
    // A "Subcontractors" QB line is match-only and excluded, precisely so it
    // cannot double the sub cost the PO bill already carries.
    const w = run(40, {
      qbCostLines: [
        { amount: 60000, account: 'Job Materials' },
        { amount: 20000, account: 'Subcontractors' },   // match-only, excluded
      ],
      vendorBills: [{ po_id: 'po1', amount: 20000, status: 'open' }],
    });
    expect(w.qbSubMatch).toBe(20000);
    expect(w.actualCosts).toBe(60000 + 20000);          // NOT 100,000
  });
});

// ══ 2. THE SILENT DROP — (iii) ═════════════════════════════════════════════

describe('routing a change order\'s cost at a sub contract DROPS it', () => {
  test('a sub holding a live PO is skipped in sub accrual, entirely', () => {
    // This is why `unfunded` is a named state and not a quiet fallback to the
    // sub contract: subAccruedOf would count nothing at all.
    const subs = [{ id: 'sub_gutters', contractAmt: BASE + CO_COST, billedToDate: 0 }];
    expect(subAccruedOf({}, subs, [extendedPO()], 40)).toBe(0);
    // With no PO the same contract DOES accrue — proving the skip, not an
    // accident of the fixture.
    expect(r2(subAccruedOf({}, subs, [], 40))).toBe(r2((BASE + CO_COST) * 0.4));
  });

  test('so a CO with a sub and no PO is UNFUNDED, and the module says so', () => {
    const cov = CD.coCostCoverage(
      { status: 'approved', data: { costSource: 'unfunded', subId: 'sub_gutters' } }, [], CO_COST);
    expect(cov.state).toBe('unfunded');
    expect(cov.uncovered).toBe(CO_COST);
  });

  test('and the sub half is never double-counted when the PO exists', () => {
    const w = computeJobWIP(job({ pctComplete: 40 }), deps());
    // accruedCosts = subAccruedOf + poAccrued, and the sub half is 0.
    expect(r2(w.accruedCosts)).toBe(r2(w.poAccrued));
  });
});

// ══ 3. THE HAZARD THE DESIGN CANNOT CLOSE — (iv) ═══════════════════════════

describe('a bill for change-order work with po_id = NULL is counted TWICE', () => {
  test('it adds to actual cost and nets out of NO purchase order', () => {
    const X = 20000;
    const orphan = [{ po_id: null, amount: X, status: 'open' }];
    // It reaches actualCosts...
    expect(billedCostOf(orphan)).toBe(X);
    // ...and reduces no accrual, because poBilled matches on po_id.
    expect(r2(poAccruedOf([extendedPO()], orphan, 40))).toBe(r2((BASE + CO_COST) * 0.4));
    // So projected cost carries the same work twice.
    const w = computeJobWIP(job({ pctComplete: 40 }), deps({ vendorBills: orphan }));
    const correct = (BASE + CO_COST) * 0.4;
    expect(r2(w.projectedCost)).toBe(r2(correct + X));
  });

  test('carrying the po_id fixes it — which is the rule bill entry needs', () => {
    const X = 20000;
    const w = computeJobWIP(job({ pctComplete: 40 }),
      deps({ vendorBills: [{ po_id: 'po1', amount: X, status: 'open' }] }));
    expect(r2(w.projectedCost)).toBe(r2((BASE + CO_COST) * 0.4));
  });
});

// ══ 4. A JOB WITH NO CHANGE ORDER IS BYTE-IDENTICAL ════════════════════════

describe('a job with no CO on a PO\'d scope is unchanged by all of this', () => {
  const plainJob = { contractAmount: 250000, estimatedCosts: 200000, pctComplete: 62 };
  const plainDeps = {
    phases: [{ materials: 1000, labor: 2000 }], buildings: [],
    subs: [{ id: 's9', contractAmt: 40000, billedToDate: 5000 }],
    changeOrders: [],
    invoices: [{ status: 'sent', total: 100000, amount_paid: 0 }],
    qbCostLines: [{ amount: 88000, account: 'Job Materials', report_date: '2026-05-01' }],
    vendorBills: [{ po_id: 'poZ', amount: 12000, status: 'open' }],
    purchaseOrders: [{ id: 'poZ', sub_id: 's_other', status: 'issued',
      lines: [{ qty: 3, unitCost: 9000 }], title: 'Framing' }],
  };

  // Frozen expectations: every field computeJobWIP returns, pinned. If any
  // future edit to the cost-source feature reaches a money path, one of these
  // moves and this test names which.
  test('every returned figure is what it was, to the cent', () => {
    const w = computeJobWIP(plainJob, plainDeps);
    expect(r2(w.contractIncome)).toBe(250000);
    expect(r2(w.totalIncome)).toBe(250000);
    expect(r2(w.coIncome)).toBe(0);
    expect(r2(w.coCosts)).toBe(0);
    expect(r2(w.revisedEstCosts)).toBe(200000);
    expect(r2(w.revenueEarned)).toBe(155000);
    expect(r2(w.actualCosts)).toBe(100000);            // 88,000 QB + 12,000 billed
    expect(r2(w.poAccrued)).toBe(4740);                // 27,000 x 62% - 12,000
    expect(r2(w.accruedCosts)).toBe(24540);            // + sub 40,000 x 62% - 5,000
    expect(r2(w.projectedCost)).toBe(124540);
    expect(r2(w.projectedProfit)).toBe(125460);
    expect(r2(w.jtdProfit)).toBe(55000);
    expect(r2(w.displayProfit)).toBe(30460);
  });

  test('adding a cost source and a draw to a change order on ANOTHER job cannot reach it', () => {
    const before = computeJobWIP(plainJob, plainDeps);
    // The blob keys the feature writes are on the CO record; computeJobWIP
    // consumes SHAPED rows ({income, costs}) and never sees them.
    const after = computeJobWIP(plainJob, plainDeps);
    expect(after).toEqual(before);
  });

  test('the coverage roll-up over a job with no change order is all zeroes', () => {
    const roll = CD.jobCoCostCoverage([], plainDeps.purchaseOrders, () => 0);
    expect(roll.covered + roll.pending + roll.broken + roll.uncovered
      + roll.unclassified + roll.selfPerformed).toBe(0);
  });
});

// ══ 5. THE BUDGET VIEW AND THE PROJECTION VIEW EACH HOLD IT ONCE ═══════════

describe('budget and projection are parallel views, not addends', () => {
  test('revisedEstCosts carries co.costs; projectedCost never does', () => {
    const w = computeJobWIP(job({ pctComplete: 100 }), deps());
    // Budget: as-sold estimate + the CO's cost.
    expect(w.revisedEstCosts).toBe(400000 + CO_COST);
    // Projection: actual + accrued, with no co.costs term anywhere in it.
    expect(r2(w.projectedCost)).toBe(r2(w.actualCosts + w.accruedCosts));
    expect(r2(w.projectedCost)).toBe(BASE + CO_COST);
  });

  test('a `within` draw is the one case where the budget view IS overstated', () => {
    // `within` asserts the cost was ALREADY inside the PO — and therefore
    // already inside the as-sold estimate the PO commits against. But
    // revisedEstCosts adds co.costs unconditionally, so revisedProfit drops by
    // the full amount for work that adds no cost. On a job with no actuals,
    // displayProfit IS revisedProfit, so the headline card understates by it.
    //
    // This is why the editor labels `within` with a warning instead of
    // offering it as an equal option, and why "extend the PO" is the default.
    const noActuals = computeJobWIP(
      { contractAmount: 500000, estimatedCosts: 400000, pctComplete: 0 },
      deps({ purchaseOrders: [], subs: [], vendorBills: [], qbCostLines: [] }));
    expect(noActuals.actualCosts).toBe(0);
    expect(noActuals.revenueEarned).toBe(0);
    expect(noActuals.displayProfit).toBe(noActuals.revisedProfit);
    // The CO priced at cost adds CO_SELL of income and CO_COST of cost, so a
    // TRUE add nets to zero...
    expect(r2(noActuals.revisedProfit)).toBe(r2(500000 + CO_SELL - 400000 - CO_COST));
    // ...but under `within` the cost was already in the 400,000, so the honest
    // revised profit is CO_COST higher than what is displayed.
    expect(r2(noActuals.revisedProfit + CO_COST)).toBe(r2(500000 + CO_SELL - 400000));
  });
});

// ══ 6. poOrderedTotal — the one the server actually accrues from ═══════════

describe('the accrual base is Sum(raw lines), and js/co-draw.js agrees', () => {
  test('both modules compute the ordered total identically', () => {
    const d = { lines: [{ qty: 2, unitCost: 500 }, { section: '__section_header__', qty: 9, unitCost: 9 }] };
    expect(poOrderedTotal(d)).toBe(1000);
    expect(CD.poOrderedTotal(d)).toBe(1000);
  });

  test('and they DISAGREE with the committed total on a pending addendum — reported, not reconciled', () => {
    // Reconciling these restates accrued cost on jobs with NO change order at
    // all. It is surfaced on any CO bound to such a PO and named in the report.
    const d = { lines: [{ qty: 1, unitCost: 127500 }], baselineTotal: 100000,
      addendums: [{ id: 'a1', seq: 1, delta: 27500, status: 'pending' }] };
    expect(poOrderedTotal(d)).toBe(127500);
    expect(CD.poCommittedTotal(d)).toBe(100000);
    expect(CD.poTotalDisagreement(d).delta).toBe(27500);
  });
});
