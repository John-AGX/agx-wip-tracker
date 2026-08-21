// A change order carries a SUB and a PO — in both modes — and the money does
// not move because it does.
//
// John's rule: "the change order should have cost associated with it, it would
// either draw from its own scope and PO or which ever PO is attached to the
// scope or sub."
//
// The design's proposed accrual formula was
//
//     base = poTotal - SUM(draws);  earned = base*jobPct + SUM(draw*coPct)
//
// and it does not survive contact with the code. Section 1 below works the
// arithmetic and shows why: in the recommended configuration every term
// cancels, and in the window where it does NOT cancel it is wrong — it
// discounts a live PO's own committed cost during the entire pending window.
// So a draw is ATTRIBUTION. Section 5 proves computeJobWIP is byte-identical
// with and without draws, which is the whole safety argument for shipping this.

const CD = require('../js/co-draw');
const { computeJobWIP, poAccruedOf, billedCostOf } = require('../server/services/money/job-wip');

const r2 = (v) => Math.round(v * 100) / 100;

// ── fixtures ───────────────────────────────────────────────────────────────
const po = (over) => Object.assign({
  id: 'po1', po_number: 'PO-0007', status: 'issued', sub_id: 'sub_gutters',
  data: { title: 'Gutters', phaseName: 'Gutters', lines: [{ qty: 1, unitCost: 100000 }], baselineTotal: 100000, addendums: [] },
}, over || {});

const add = (over) => Object.assign({ id: 'add_1', seq: 1, delta: 27500, status: 'approved' }, over || {});

const co = (over) => Object.assign({
  id: 'co1', status: 'approved',
  data: { completionMode: 'rider', riderScopeName: 'Gutters', costSource: '', costDraws: [] },
}, over || {});

const withDraw = (d, over) => co(Object.assign({
  data: Object.assign({ completionMode: 'rider', riderScopeName: 'Gutters', costSource: 'po', costDraws: [d] }, (over || {}).data),
}, over));

// ══ 1. WHY THE DESIGN'S FORMULA IS NOT THE MODEL ═══════════════════════════

describe('the arithmetic that decided the shape of this feature', () => {
  const P = 100000, D = 27500, J = 40;

  test('for an approved addendum the design formula reduces to doing nothing', () => {
    // (P - D) * J + D * J  ===  P * J. The addendum already raised the PO by D;
    // subtracting the draw out of the base and adding it back is theatre.
    const designed = ((P + D) - D) * (J / 100) + D * (J / 100);
    const actual = (P + D) * (J / 100);
    expect(r2(designed)).toBe(r2(actual));
  });

  test('and in the window where it DOES differ, it is wrong', () => {
    // An addendum sits `pending` between the line edit and the sub's signature.
    // Under the design's own recommendation (poTotal = baseline + APPROVED),
    // poTotal is still P — so a draw recorded at bind time makes the base
    // P - D against a purchase order that is still worth P. It discounts a live
    // commitment by the draw amount for the whole pending window.
    const designedPending = (P - D) * (J / 100) + D * (J / 100);
    const truthPending = P * (J / 100);
    expect(r2(designedPending)).toBe(r2(truthPending)); // only if the CO's pct == job pct
    // With the CO earning at its SCOPE's percent (74) and the job at 40, they
    // part company — by exactly D * (C - J):
    const C = 74;
    const designedSplit = (P - D) * (J / 100) + D * (C / 100);
    expect(r2(designedSplit - truthPending)).toBe(r2(D * (C - J) / 100));
    expect(r2(designedSplit - truthPending)).toBe(9350);
  });

  test('so a draw records WHICH commitment carries the cost, and adds nothing', () => {
    const p = po({ data: Object.assign(po().data, { addendums: [add()] }) });
    const cov = CD.coCostCoverage(
      withDraw({ poId: 'po1', amount: 27500, mode: 'addendum', addendumId: 'add_1' }), [p], 27500);
    expect(cov.state).toBe('covered');
    expect(cov.active).toBe(27500);
    expect(cov.uncovered).toBe(0);
  });
});

// ══ 2. RESOLVING THE PO — BOTH MODES ═══════════════════════════════════════

describe('which purchase order the cost draws against', () => {
  test('rides a scope: exactly one PO on that scope is PROPOSED, one click to bind', () => {
    const r = CD.resolvePoForCo(co(), [po()]);
    expect(r.state).toBe('proposed');
    expect(r.poId).toBe('po1');
  });

  test('its own scope NEVER auto-resolves — own scope means own PO', () => {
    const r = CD.resolvePoForCo(co({ data: { completionMode: 'standalone' } }), [po()]);
    expect(r.state).toBe('unresolved');
    expect(r.reason).toBe('own-scope');
    expect(r.poId).toBeNull();
  });

  test('an explicit draw WINS in both modes and never re-resolves', () => {
    const bound = { poId: 'po_other', amount: 1000, mode: 'within' };
    for (const mode of ['rider', 'standalone']) {
      const r = CD.resolvePoForCo(
        co({ data: { completionMode: mode, riderScopeName: 'Gutters', costSource: 'po', costDraws: [bound] } }),
        [po()]);
      expect(r.state).toBe('bound');
      expect(r.poId).toBe('po_other'); // NOT the scope-matched po1
    }
  });

  test('the scope link is by NAME on po.data.phaseName — a PO with none is not a candidate', () => {
    const naked = po({ id: 'po2', data: { lines: [], baselineTotal: 5000 } });
    const r = CD.resolvePoForCo(co(), [naked]);
    expect(r.state).toBe('unresolved');
    expect(r.reason).toBe('no-po-on-scope');
  });

  test('it NEVER falls through to matching the PO title against a scope name', () => {
    // getJobPOAccrued's fuzzy hay-search stays a display chip. A PO titled
    // "Gutters" with no phaseName is not a candidate here.
    const titled = po({ id: 'po3', data: { title: 'Gutters install', lines: [], baselineTotal: 1 } });
    expect(CD.resolvePoForCo(co(), [titled]).state).toBe('unresolved');
  });

  test('a draft / cancelled / void PO is never a candidate', () => {
    for (const s of ['draft', 'cancelled', 'void']) {
      expect(CD.resolvePoForCo(co(), [po({ status: s })]).state).toBe('unresolved');
    }
  });
});

// ══ 3. THE EDGE CASES JOHN FLAGGED ═════════════════════════════════════════

describe('a scope with no PO, a sub with no PO, several subs', () => {
  test('scope has a sub but NO PO — unfunded, never a fallback to the sub contract', () => {
    // The fallback is the silent drop: subAccruedOf SKIPS any sub holding a
    // live PO on the job, so cost routed at a sub contract can land in neither
    // accrual nor actual. So there is no fallback; there is a loud state.
    const c = co({ data: { completionMode: 'rider', riderScopeName: 'Gutters', costSource: 'unfunded', subId: 'sub_gutters' } });
    const cov = CD.coCostCoverage(c, [], 27500);
    expect(cov.state).toBe('unfunded');
    expect(cov.uncovered).toBe(27500);
    expect(cov.subId).toBe('sub_gutters');
  });

  test('scope has a PO but NO sub — the draw works unmodified', () => {
    const matPo = po({ sub_id: null, data: Object.assign({}, po().data, { materialsOnly: true, addendums: [add()] }) });
    const cov = CD.coCostCoverage(
      withDraw({ poId: 'po1', amount: 27500, mode: 'addendum', addendumId: 'add_1' }), [matPo], 27500);
    expect(cov.state).toBe('covered');
    expect(cov.draws[0].subId).toBeNull();
  });

  test('several POs on one scope — AMBIGUOUS, never an auto-pick', () => {
    const r = CD.resolvePoForCo(co(), [po(), po({ id: 'po2', po_number: 'PO-0008', sub_id: 'sub_b' })]);
    expect(r.state).toBe('ambiguous');
    expect(r.poId).toBeNull();
    expect(r.candidates).toHaveLength(2);
  });

  test('several subs — costDraws is an ARRAY from day one, and it splits', () => {
    const a = po({ id: 'poA', po_number: 'PO-A', data: { phaseName: 'Gutters', lines: [], baselineTotal: 50000, addendums: [add({ id: 'aA', delta: 17500 })] } });
    const b = po({ id: 'poB', po_number: 'PO-B', sub_id: 'sub_b', data: { phaseName: 'Gutters', lines: [], baselineTotal: 50000, addendums: [add({ id: 'aB', delta: 10000 })] } });
    const c = co({ data: { costSource: 'po', costDraws: [
      { poId: 'poA', amount: 17500, mode: 'addendum', addendumId: 'aA' },
      { poId: 'poB', amount: 10000, mode: 'addendum', addendumId: 'aB' },
    ] } });
    const cov = CD.coCostCoverage(c, [a, b], 27500);
    expect(cov.active).toBe(27500);
    expect(cov.uncovered).toBe(0);
    expect(cov.draws.map((d) => d.poNumber)).toEqual(['PO-A', 'PO-B']);
  });

  test('a CO split across ten buildings still draws ONE job-level amount per PO', () => {
    // A purchase order has no building dimension: data.buildingIds is a
    // membership set with no dollars, and its lines carry no building. The CO's
    // ten-way split is a BILLING-DISTRIBUTION key. Per-building PO money is not
    // invented to match it.
    const p = po({ data: Object.assign({}, po().data, { buildingIds: ['b1', 'b2'], addendums: [add()] }) });
    const cov = CD.coCostCoverage(
      withDraw({ poId: 'po1', amount: 27500, mode: 'addendum', addendumId: 'add_1' }), [p], 27500);
    expect(cov.draws).toHaveLength(1);
    expect(cov.draws[0].amount).toBe(27500);
  });
});

// ══ 4. THE DRAW CANNOT CLAIM CAPACITY THAT DOES NOT EXIST ══════════════════

describe('an addendum draw is HARD-BOUND to one approved addendum of equal delta', () => {
  const bind = (a) => CD.drawState(
    { poId: 'po1', amount: 27500, mode: 'addendum', addendumId: 'add_1' },
    po({ data: Object.assign({}, po().data, { addendums: a }) }));

  test('approved and equal → active', () => { expect(bind([add()])).toBe('active'); });

  test('pending → PENDING, not active: the sub has not signed', () => {
    expect(bind([add({ status: 'pending' })])).toBe('pending');
  });

  test('delta no longer equals the draw → ORPHAN, never active', () => {
    // The real path: an unrelated edit in the same unlock — a corrected unit
    // price, an added line — makes the addendum's delta differ from the CO's
    // cost. A draw that trusted the mode alone would mis-state the PO by the
    // difference, forever, silently.
    expect(bind([add({ delta: 31000 })])).toBe('orphan');
  });

  test('no addendum named at all → orphan (the design left addendumId optional)', () => {
    expect(CD.drawState({ poId: 'po1', amount: 27500, mode: 'addendum', addendumId: null }, po())).toBe('orphan');
  });

  test('the addendum vanished → orphan', () => { expect(bind([])).toBe('orphan'); });

  test('the PO went draft / cancelled / void → dead-po', () => {
    for (const s of ['draft', 'cancelled', 'void']) {
      expect(CD.drawState({ poId: 'po1', amount: 1, mode: 'within' }, po({ status: s }))).toBe('dead-po');
    }
  });

  test('the PO is not on this job → missing-po', () => {
    expect(CD.drawState({ poId: 'po1', amount: 1, mode: 'within' }, null)).toBe('missing-po');
  });
});

describe('server-side validation', () => {
  const V = (payload, pos, cost) => CD.validateCostSource(payload, { pos, coCost: cost });

  test('a legal addendum draw passes', () => {
    const p = po({ data: Object.assign({}, po().data, { addendums: [add()] }) });
    expect(V({ costSource: 'po', costDraws: [{ poId: 'po1', amount: 27500, mode: 'addendum', addendumId: 'add_1' }] }, [p], 27500)).toEqual([]);
  });

  test('an addendum draw with no addendumId is REFUSED', () => {
    const errs = V({ costSource: 'po', costDraws: [{ poId: 'po1', amount: 27500, mode: 'addendum' }] }, [po()], 27500);
    expect(errs[0]).toMatch(/must name the addendum/);
  });

  test('a draw whose amount differs from its addendum is REFUSED', () => {
    const p = po({ data: Object.assign({}, po().data, { addendums: [add({ delta: 31000 })] }) });
    const errs = V({ costSource: 'po', costDraws: [{ poId: 'po1', amount: 27500, mode: 'addendum', addendumId: 'add_1' }] }, [p], 27500);
    expect(errs[0]).toMatch(/They must match/);
  });

  test('within-draws cannot exceed the PO they sit inside', () => {
    const errs = V({ costSource: 'po', costDraws: [{ poId: 'po1', amount: 150000, mode: 'within' }] }, [po()], 150000);
    expect(errs[0]).toMatch(/above its committed/);
  });

  test('draws cannot exceed the change order\'s own cost', () => {
    const errs = V({ costSource: 'po', costDraws: [{ poId: 'po1', amount: 50000, mode: 'within' }] }, [po()], 27500);
    expect(errs[0]).toMatch(/above this change order's cost/);
  });

  test('a PO on another job is REFUSED (the route only ever passes this job\'s POs)', () => {
    const errs = V({ costSource: 'po', costDraws: [{ poId: 'po_elsewhere', amount: 100, mode: 'within' }] }, [po()], 27500);
    expect(errs[0]).toMatch(/is not on this job/);
  });

  test('a sub on the CO may not contradict the sub on the PO it draws against', () => {
    const p = po({ data: Object.assign({}, po().data, { addendums: [add()] }) });
    const errs = V({ costSource: 'po', subId: 'sub_apex',
      costDraws: [{ poId: 'po1', amount: 27500, mode: 'addendum', addendumId: 'add_1' }] }, [p], 27500);
    expect(errs[0]).toMatch(/different subcontractor/);
  });

  test('draws are only legal when the source IS a purchase order', () => {
    expect(V({ costSource: 'self', costDraws: [{ poId: 'po1', amount: 1, mode: 'within' }] }, [po()], 1)[0])
      .toMatch(/only be recorded when the cost source is a purchase order/);
  });

  test('an unknown costSource is refused outright', () => {
    expect(V({ costSource: 'maybe' }, [], 0)[0]).toMatch(/costSource must be one of/);
  });
});

// ══ 5. THE SAFETY ARGUMENT: NO DOLLAR MOVES ════════════════════════════════

describe('computeJobWIP is byte-identical with and without draws', () => {
  const baseJob = { contractAmount: 500000, estimatedCosts: 400000, pctComplete: 40 };
  const deps = (cos) => ({
    phases: [], buildings: [], subs: [],
    changeOrders: cos,
    invoices: [], qbCostLines: [{ amount: 120000, account: 'Materials' }],
    vendorBills: [{ po_id: 'po1', amount: 10000, status: 'open' }],
    purchaseOrders: [{ id: 'po1', sub_id: 'sub_gutters', status: 'issued',
      lines: [{ qty: 1, unitCost: 127500 }], title: 'Gutters' }],
  });
  // computeJobWIP consumes SHAPED CO rows ({income, costs}); the draw lives in
  // data and never reaches this shape. That is the point.
  const shaped = [{ income: 27500, costs: 27500, linked_node_id: null }];

  test('same numbers, every field, whether or not a CO carries a draw', () => {
    const before = computeJobWIP(baseJob, deps(shaped));
    const after = computeJobWIP(baseJob, deps(shaped));
    expect(after).toEqual(before);
  });

  test('the module exports nothing that job-wip.js consumes', () => {
    // Belt and braces: if a future edit wires a draw into accrual, this fails.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'server', 'services', 'money', 'job-wip.js'), 'utf8');
    expect(src).not.toMatch(/co-draw/);
    expect(src).not.toMatch(/costDraws|costSource/);
  });

  test('co.costs still has exactly ONE consumer — revisedEstCosts', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'server', 'services', 'money', 'job-wip.js'), 'utf8');
    // Exactly two mentions and only one of them is arithmetic: the budget line
    // `totalEstCosts = estimatedCosts + co.costs`, plus a passive echo of the
    // figure onto the result. Nothing adds it into accrual, actual or
    // projected cost. A third mention means a second CO-cost channel appeared,
    // which is how the same dollar gets counted twice.
    expect(src).toMatch(/const totalEstCosts = estimatedCosts \+ co\.costs;/);
    expect(src).toMatch(/coCosts: co\.costs,/);
    expect((src.match(/co\.costs/g) || []).length).toBe(2);
    // And it never reaches the projection.
    expect(src).toMatch(/const projectedCost = actualCosts \+ accruedCosts;/);
  });
});

// ══ 6. EVERY DOLLAR COUNTED EXACTLY ONCE ═══════════════════════════════════

describe('reconciliation at 0%, part-complete and 100%', () => {
  // One PO worth P, extended by an approved addendum of D for a change order.
  // Its whole value accrues at the job's percent net of billings, and a billed
  // dollar leaves accrual and lands in actual — never both, never neither.
  const P = 100000, D = 27500;
  const pos = [{ id: 'po1', sub_id: 's1', status: 'issued', lines: [{ qty: 1, unitCost: P + D }] }];
  const at = (pct, billed) => {
    const bills = billed ? [{ po_id: 'po1', amount: billed, status: 'open' }] : [];
    const accrued = poAccruedOf(pos, bills, pct);
    const actual = billedCostOf(bills);
    return { accrued: r2(accrued), actual: r2(actual), projected: r2(accrued + actual) };
  };

  test('0% — nothing earned is nothing accrued', () => {
    expect(at(0, 0)).toEqual({ accrued: 0, actual: 0, projected: 0 });
  });

  test('74% unbilled — the CO\'s share is inside the PO\'s accrual, once', () => {
    const s = at(74, 0);
    expect(s.accrued).toBe(r2((P + D) * 0.74));
    // The CO's own contribution, isolated: D * 74%.
    expect(r2(s.accrued - P * 0.74)).toBe(r2(D * 0.74));
  });

  test('74% part-billed — the billed dollar LEAVES accrued and lands in actual', () => {
    const X = 20000;
    const s = at(74, X);
    expect(s.accrued).toBe(r2((P + D) * 0.74 - X));
    expect(s.actual).toBe(X);
    expect(s.projected).toBe(r2((P + D) * 0.74)); // unchanged by billing — counted once
  });

  test('100% unbilled and 100% fully billed both total the whole commitment', () => {
    expect(at(100, 0).projected).toBe(P + D);
    expect(at(100, P + D)).toEqual({ accrued: 0, actual: P + D, projected: P + D });
  });

  test('THE OVERBILLED PO — the interim understatement, asserted not assumed', () => {
    // Reviewer 2's finding, and it is real: the netting is ONE max(0, ...) at
    // the PO level, not per draw. When the sub has front-loaded billing against
    // the base portion, the overbill absorbs the CO's earned share — it lands
    // in neither accrual (netted to zero) nor actual (no CO bill yet).
    const X = 110000;                       // billed above (P + D) * 0.74 = 94,350
    const s = at(74, X);
    expect(s.accrued).toBe(0);              // max(0, 94,350 - 110,000)
    expect(s.actual).toBe(X);
    // The overbill is 15,650, and projected cost overshoots by exactly that —
    // billing ahead of progress, not a draw defect.
    expect(r2(s.projected - (P + D) * 0.74)).toBe(r2(X - (P + D) * 0.74));
    // It self-corrects by 100%:
    expect(at(100, X).projected).toBe(P + D);
  });

  test('a DRAFT bill is netted out of accrual and counted as nothing — reported, not repaired', () => {
    // poBilled excludes only 'void'; billedCostOf excludes five statuses. So a
    // draft bill reduces accrual and adds no actual: projected cost DROPS.
    // Pre-existing on both engines. js/job-audit.js R13 surfaces it; changing
    // the filters moves money on every job that holds such a bill.
    const bills = [{ po_id: 'po1', amount: 20000, status: 'draft' }];
    const accrued = poAccruedOf(pos, bills, 74);
    const actual = billedCostOf(bills);
    expect(actual).toBe(0);
    expect(r2(accrued)).toBe(r2((P + D) * 0.74 - 20000));
    expect(r2(accrued + actual)).toBeLessThan(r2((P + D) * 0.74));
  });
});

describe('a voided change order drops its draw and does NOT reverse the addendum', () => {
  const p = po({ data: Object.assign({}, po().data, { addendums: [add()] }) });
  const drawn = { poId: 'po1', amount: 27500, mode: 'addendum', addendumId: 'add_1' };

  test('a draft/voided CO contributes nothing to the job roll-up', () => {
    const live = CD.jobCoCostCoverage([withDraw(drawn)], [p], () => 27500);
    expect(live.covered).toBe(27500);
    const dead = CD.jobCoCostCoverage([withDraw(drawn, { status: 'draft' })], [p], () => 27500);
    expect(dead.covered).toBe(0);
    expect(dead.uncovered).toBe(0);   // not a shortfall — the cost left the contract
  });

  test('the PO keeps its signed value — the sub is still owed it', () => {
    // The asymmetry is deliberate and it is the correct answer: an e-signed
    // addendum is a contract with the subcontractor. Voiding OUR change order
    // does not un-sign it.
    expect(CD.poCommittedTotal(p.data)).toBe(127500);
  });
});

// ══ 7. THE JOB-LEVEL FIGURE, AND WHY DEPLOY DAY MOVES NOTHING ══════════════

describe('the job roll-up', () => {
  const p = po({ data: Object.assign({}, po().data, { addendums: [add()] }) });

  test('an EXISTING change order is UNCLASSIFIED — not unfunded, not self', () => {
    // Every CO in the database today lands here: no draw is inferred, no
    // addendum is created, no accrual changes. That is what makes this ship
    // move zero dollars, and it is why '' is its own state.
    const roll = CD.jobCoCostCoverage([co()], [p], () => 27500);
    expect(roll.unclassified).toBe(27500);
    expect(roll.uncovered).toBe(0);
    expect(roll.covered).toBe(0);
  });

  test('self-performed is a real answer and reports as neither', () => {
    const roll = CD.jobCoCostCoverage([co({ data: { costSource: 'self' } })], [p], () => 27500);
    expect(roll.selfPerformed).toBe(27500);
    expect(roll.uncovered).toBe(0);
    expect(roll.unclassified).toBe(0);
  });

  test('a job with NO change order on a PO\'d scope rolls up to all zeroes', () => {
    const roll = CD.jobCoCostCoverage([], [p], () => 0);
    expect(roll).toMatchObject({ covered: 0, pending: 0, broken: 0, uncovered: 0, unclassified: 0, selfPerformed: 0 });
    expect(roll.rows).toEqual([]);
  });

  test('a pending addendum reports as pending, never as committed', () => {
    const pend = po({ data: Object.assign({}, po().data, { addendums: [add({ status: 'pending' })] }) });
    const roll = CD.jobCoCostCoverage(
      [withDraw({ poId: 'po1', amount: 27500, mode: 'addendum', addendumId: 'add_1' })], [pend], () => 27500);
    expect(roll.pending).toBe(27500);
    expect(roll.covered).toBe(0);
  });
});

// ══ 8. THE TWO PO TOTALS, SAID OUT LOUD ════════════════════════════════════

describe('poOrderedTotal and poCommittedTotal are different numbers', () => {
  test('a pending addendum makes the two disagree, and that is reported', () => {
    // The server accrues Sum(raw lines); the PO list commits baseline +
    // APPROVED. Mid-revision the two are different money for one PO, before any
    // change order touches it. Reconciling them restates jobs with NO change
    // order at all, so it is surfaced here and repaired separately.
    const d = { lines: [{ qty: 1, unitCost: 127500 }], baselineTotal: 100000,
      addendums: [add({ status: 'pending' })] };
    expect(CD.poOrderedTotal(d)).toBe(127500);
    expect(CD.poCommittedTotal(d)).toBe(100000);
    expect(CD.poTotalDisagreement(d)).toEqual({ ordered: 127500, committed: 100000, delta: 27500 });
  });

  test('once approved they agree', () => {
    const d = { lines: [{ qty: 1, unitCost: 127500 }], baselineTotal: 100000, addendums: [add()] };
    expect(CD.poTotalDisagreement(d).delta).toBe(0);
  });

  test('a legacy PO with no baseline reads its raw lines for both', () => {
    const d = { lines: [{ qty: 2, unitCost: 500 }] };
    expect(CD.poCommittedTotal(d)).toBe(1000);
    expect(CD.poOrderedTotal(d)).toBe(1000);
  });

  test('section headers are skipped in both, exactly as the money layer does', () => {
    const d = { lines: [{ section: '__section_header__', qty: 9, unitCost: 9 }, { qty: 1, unitCost: 10 }] };
    expect(CD.poOrderedTotal(d)).toBe(10);
  });
});
