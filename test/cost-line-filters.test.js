// test/cost-line-filters.test.js — one definition of "is this line job cost".
//
// The rule had four copies (js/cost-buckets.js, js/jobs.js, job-wip.js, and
// the browser's getJobWIP). The AI's per-turn job context had a FIFTH site
// that had no copy at all: it summed `amount` with no exclusions and printed
// the result to 86 as "Grand total across shown vendors", which read as job
// cost and disagreed with the WIP block in the same prompt.
//
// These pin the shared predicate AND pin that the engine still agrees with
// it, so a future edit to one cannot drift from the other.

const {
  isSubLine, isAccrualLine, classifyCostLine,
} = require('../server/services/money/cost-line-filters');
const { computeJobWIP } = require('../server/services/money/job-wip');

describe('classifyCostLine', () => {
  test('an ordinary bill is cost', () => {
    expect(classifyCostLine({ txn_type: 'Bill', account: 'Materials & Supplies - COGS', amount: 100 }))
      .toBe('cost');
  });

  test('a QB Subcontractors line is match-only', () => {
    expect(classifyCostLine({ txn_type: 'Bill', account: 'Subcontractors', amount: 100 }))
      .toBe('sub');
  });

  test('a month-end journal entry is an accrual', () => {
    expect(classifyCostLine({ txn_type: 'Journal Entry', account: 'Direct Labor', amount: 100 }))
      .toBe('accrual');
  });

  test('ORDER: a JE on a Subcontractors account classifies as accrual, not sub', () => {
    // This ordering is the rule, not an implementation detail. Most JE lines
    // carry the Subcontractors account; routing them to the sub bucket skews
    // the reconciliation against vendor bills into a false over-billing flag.
    const je = { txn_type: 'Journal Entry', account: 'Subcontractors', amount: 4574.44 };
    expect(isAccrualLine(je)).toBe(true);
    expect(isSubLine(je)).toBe(true);       // both predicates match…
    expect(classifyCostLine(je)).toBe('accrual'); // …the ordered form picks accrual
  });

  test('an explicit bucket means a human classified it — both rules stand down', () => {
    expect(classifyCostLine({ txn_type: 'Journal Entry', account: 'Subcontractors', bucket: 'labor' }))
      .toBe('cost');
    expect(classifyCostLine({ account: 'Subcontractors', bucket: 'subs' })).toBe('sub');
  });

  test('account_type is honoured when account is blank', () => {
    expect(classifyCostLine({ txn_type: 'Bill', account: '', account_type: 'Subcontract Costs' }))
      .toBe('sub');
  });

  test('camelCase txnType (the browser shape) is recognised', () => {
    expect(classifyCostLine({ txnType: 'Journal Entry', account: 'Direct Labor' })).toBe('accrual');
  });
});

describe('the WIP engine and the shared predicate agree', () => {
  const LINES = [
    { txn_type: 'Bill', account: 'Materials & Supplies - COGS', amount: 8000 },
    { txn_type: 'Bill', account: 'Subcontractors', amount: 50000 },
    { txn_type: 'Journal Entry', account: 'Direct Labor', amount: 22455.12 },
  ];

  test('computeJobWIP buckets exactly as classifyCostLine does', () => {
    const wip = computeJobWIP({ id: 'j1', contractAmount: 100000 }, {
      qbCostLines: LINES, phases: [], buildings: [], subs: [],
      changeOrders: [], invoices: [], vendorBills: [], purchaseOrders: [],
    });
    const sum = (kind) => LINES
      .filter((l) => classifyCostLine(l) === kind)
      .reduce((s, l) => s + l.amount, 0);

    expect(wip.qbActualCosts).toBeCloseTo(sum('cost'), 2);
    expect(wip.qbSubMatch).toBeCloseTo(sum('sub'), 2);
    expect(wip.qbAccrual).toBeCloseTo(sum('accrual'), 2);
  });

  test('the naive total the AI context used to print was 72,455 vs a real 8,000', () => {
    // The exact shape of the defect: a raw SUM(amount) over the same rows.
    const naive = LINES.reduce((s, l) => s + l.amount, 0);
    const real = LINES.filter((l) => classifyCostLine(l) === 'cost')
      .reduce((s, l) => s + l.amount, 0);
    expect(naive).toBeCloseTo(80455.12, 2);
    expect(real).toBe(8000);
  });
});
