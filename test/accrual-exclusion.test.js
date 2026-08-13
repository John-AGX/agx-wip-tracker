// test/accrual-exclusion.test.js — QB month-end accrual journal entries must
// not count as job cost.
//
// Measured on the live pilot 2026-08-12: 87 of 697 QB cost lines are Journal
// Entries, and every one is an accrual pair — memos "To record month-end WIP
// adjustment" / "To accrue payroll as of 06.30.26", numbered 251 / 251R,
// dated month-end and the 1st of the next month. $310,269.88 accrued against
// $310,269.88 reversed, netting to $0.00 on every job and every account.
//
// The pairs cancel inside a full export window, which is exactly why this
// never showed up. It bites when the window CUTS BETWEEN the two halves —
// pull the report through a month end and you capture accruals with no
// reversals. A 6/30 cutoff would have stranded $22,455.12 in actual cost.
//
// The first test is the one that made this safe to ship: against balanced
// data, excluding accruals changes the cost total by exactly $0.00.

const { computeJobWIP } = require('../server/services/money/job-wip');

const JOB = { id: 'j1', contractAmount: 100000, jobNumber: '25-001' };

// computeJobWIP(job, deps) — job is the jobs.data blob, deps carries the tables.
function wip(qbCostLines) {
  return computeJobWIP(JOB, {
    qbCostLines,
    phases: [],
    buildings: [],
    subs: [],
    changeOrders: [],
    invoices: [],
    vendorBills: [],
    purchaseOrders: []
  });
}

// A real pair, transcribed from the live rows.
const ACCRUAL = {
  txn_type: 'Journal Entry', num: '251', txn_date: '2026-06-30',
  account: 'Subcontractors', amount: 4574.44,
  memo: 'To record month-end WIP adjustment'
};
const REVERSAL = {
  txn_type: 'Journal Entry', num: '251R', txn_date: '2026-07-01',
  account: 'Subcontractors', amount: -4574.44,
  memo: 'To record month-end WIP adjustment'
};
const LABOR_ACCRUAL = {
  txn_type: 'Journal Entry', num: '300', txn_date: '2026-06-30',
  account: 'Direct Labor', amount: 22455.12,
  memo: 'To accrue payroll as of 06.30.26'
};
const LABOR_REVERSAL = {
  txn_type: 'Journal Entry', num: '300R', txn_date: '2026-07-01',
  account: 'Direct Labor', amount: -22455.12,
  memo: 'To accrue payroll as of 06.30.26'
};
const REAL_COST = {
  txn_type: 'Bill', txn_date: '2026-06-15',
  account: 'Materials & Supplies - COGS', amount: 8000
};

describe('the change is a no-op on balanced data', () => {
  test('a full window containing both halves reports the same cost either way', () => {
    const withPairs = wip([REAL_COST, LABOR_ACCRUAL, LABOR_REVERSAL]);
    const without = wip([REAL_COST]);
    expect(withPairs.qbActualCosts).toBe(without.qbActualCosts);
    expect(withPairs.qbActualCosts).toBe(8000);
  });

  test('sub-account accrual pairs do not disturb the bills reconciliation', () => {
    // Ordering matters: the accrual test runs BEFORE the sub test, so these
    // never reach qbSubMatch. If they did, a stranded half would read as
    // "invoiced beyond QB" and raise a false over-billing flag.
    const r = wip([ACCRUAL, REVERSAL]);
    expect(r.qbSubMatch).toBe(0);
    expect(r.qbAccrual).toBeCloseTo(0, 2);
  });
});

describe('the month-boundary case this prevents', () => {
  test('an accrual with no reversal stays out of actual cost', () => {
    const cutAtMonthEnd = wip([REAL_COST, LABOR_ACCRUAL]); // 7/1 reversal not imported
    expect(cutAtMonthEnd.qbActualCosts).toBe(8000);
    expect(cutAtMonthEnd.qbAccrual).toBeCloseTo(22455.12, 2);
  });

  test('without the fix that same import would have inflated cost', () => {
    // Documents the defect: the old behaviour summed every non-sub line.
    const naive = [REAL_COST, LABOR_ACCRUAL]
      .filter((l) => !/\bsub|subcontract/i.test(l.account))
      .reduce((s, l) => s + l.amount, 0);
    expect(naive).toBeCloseTo(30455.12, 2);
    expect(wip([REAL_COST, LABOR_ACCRUAL]).qbActualCosts).toBe(8000);
  });
});

describe('guard rails', () => {
  test('ordinary transaction types still count as cost', () => {
    for (const t of ['Bill', 'Expense', 'Check', 'Credit Card Credit', 'Vendor Credit']) {
      const r = wip([{ txn_type: t, account: 'Direct Labor', amount: 500 }]);
      expect(r.qbActualCosts).toBe(500);
    }
  });

  test('a manual bucket override wins — a classified JE counts as cost', () => {
    const r = wip([{ txn_type: 'Journal Entry', account: 'Direct Labor',
                     amount: 1200, bucket: 'labor' }]);
    expect(r.qbActualCosts).toBe(1200);
    expect(r.qbAccrual).toBe(0);
  });

  test('a JE still counts toward the line count — nothing is hidden', () => {
    const r = wip([REAL_COST, ACCRUAL, REVERSAL]);
    expect(r.qbCostLineCount).toBe(3);
  });
});
