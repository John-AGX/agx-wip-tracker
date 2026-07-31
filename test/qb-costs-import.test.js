// test/qb-costs-import.test.js — money math for the QuickBooks
// "Project costs detail" importer. This posts straight into job actual
// costs, so a parsing slip shows up as fake margin.
//
// Two things are pinned here:
//   1. Subtotal / grand-total rows never become cost lines. They repeat
//      money the detail rows already carry, so counting one double-books
//      an entire project.
//   2. Credits keep their sign. QB formats negatives in accounting
//      parentheses — "(1,234.56)" — and we read the sheet with SheetJS
//      `raw:false`, so the parser receives that literal text. parseFloat
//      returns NaN for it, and the old NaN→0 fallback silently zeroed
//      every credit: the 07.30.26 export came in at $2,900,434.29 against
//      a true $2,351,823.05, over by the $548,611.24 of credits it ate.

const { toNumber, isTotalRow, parseAoa } = require('../js/job-costs-import');

// Column layout of the real export (header on row 5):
// A=<group/total>, B=Project, C=Vendor, D=Transaction type, E=Date,
// F=Num, G=Distribution account, H=Distribution account type, I=Class,
// J=Memo/Description, K=Amount
const HEADER = ['', 'Project', 'Vendor', 'Transaction type', 'Date', 'Num',
  'Distribution account', 'Distribution account type', 'Class',
  'Memo/Description', 'Amount'];

const PREAMBLE = [
  ['AG Exteriors'],
  ['Project costs detail'],
  ['October, 2025-July, 2026'],
  [],
  HEADER,
];

const JOB = 'S2240 Citi Lakes Garage Repair G48';

function detail(vendor, amount) {
  return ['', JOB, vendor, 'Check', '05/14/2026', '1206', 'Subcontractors',
    'Cost of Goods Sold', 'Service & Repair - Orlando', 'Invoice #1044', amount];
}
function groupHeader() { return [JOB, '', '', '', '', '', '', '', '', '', '']; }
function totalRow(amount) {
  return ['Total for ' + JOB, '', '', '', '', '', '', '', '', '', amount];
}

describe('toNumber', () => {
  test('parses plain and currency-formatted positives', () => {
    expect(toNumber(304.95)).toBe(304.95);
    expect(toNumber('304.95')).toBe(304.95);
    expect(toNumber('$1,234.56')).toBe(1234.56);
    expect(toNumber(' 1,234.56 ')).toBe(1234.56);
  });

  test('parses leading-minus negatives', () => {
    expect(toNumber(-850)).toBe(-850);
    expect(toNumber('-1,234.56')).toBe(-1234.56);
    expect(toNumber('-$1,234.56')).toBe(-1234.56);
  });

  // The actual bug: QB's "#,##0.00 ;[Red](#,##0.00)" format.
  test('reads accounting parentheses as NEGATIVE, not zero', () => {
    expect(toNumber('(1,234.56)')).toBe(-1234.56);
    expect(toNumber('(1234.56)')).toBe(-1234.56);
    expect(toNumber('$(1,234.56)')).toBe(-1234.56);
    expect(toNumber('(850.00)')).toBe(-850);
  });

  test('handles trailing-minus and unicode-minus variants', () => {
    expect(toNumber('1234.56-')).toBe(-1234.56);
    expect(toNumber('−1,234.56')).toBe(-1234.56);
  });

  test('non-numeric and empty input is 0', () => {
    expect(toNumber('')).toBe(0);
    expect(toNumber(null)).toBe(0);
    expect(toNumber(undefined)).toBe(0);
    expect(toNumber('n/a')).toBe(0);
    expect(toNumber('()')).toBe(0);
  });
});

describe('isTotalRow', () => {
  test('flags subtotal and grand-total rows', () => {
    expect(isTotalRow('Total for ' + JOB)).toBe(true);
    expect(isTotalRow('total for whatever')).toBe(true);
    expect(isTotalRow('TOTAL FOR X')).toBe(true);
    expect(isTotalRow('Total')).toBe(true);
    expect(isTotalRow('total')).toBe(true);
  });

  test('does not flag real project headers', () => {
    expect(isTotalRow(JOB)).toBe(false);
    expect(isTotalRow('S2157 Hammock II Stairway')).toBe(false);
    // A project that merely starts with the word is still a project.
    expect(isTotalRow('Totally Awesome Condos Phase 2')).toBe(false);
  });
});

describe('parseAoa — row filtering', () => {
  test('counts only the detail rows, never the "Total for" row', () => {
    const aoa = [
      ...PREAMBLE,
      groupHeader(),
      detail('1st Choice Garage Doors', '304.95'),
      detail('Rizpa Shop Solutions', '315.62'),
      totalRow('620.57'),
    ];

    const jobs = parseAoa(aoa, 'Sheet1');

    expect(jobs).toHaveLength(1);
    expect(jobs[0].code).toBe('S2240');
    expect(jobs[0].name).toBe('Citi Lakes Garage Repair G48');
    // The whole point: 2 detail rows in, 2 lines out — the subtotal is
    // not a third line.
    expect(jobs[0].lines).toHaveLength(2);
    expect(jobs[0].lines.map(l => l.vendor))
      .toEqual(['1st Choice Garage Doors', 'Rizpa Shop Solutions']);
    expect(jobs[0].computedTotal).toBeCloseTo(620.57, 2);
    // The subtotal is retained for reconciliation, not as a cost line.
    expect(jobs[0].reportedTotal).toBeCloseTo(620.57, 2);
  });

  test('computed total reconciles with the subtotal QB printed', () => {
    const aoa = [
      ...PREAMBLE,
      groupHeader(),
      detail('A', '304.95'),
      detail('B', '315.62'),
      totalRow('620.57'),
    ];
    const [job] = parseAoa(aoa, 'Sheet1');
    expect(job.computedTotal).toBeCloseTo(job.reportedTotal, 2);
  });

  test('a trailing bare "Total" grand-total row is not a cost line', () => {
    const aoa = [
      ...PREAMBLE,
      groupHeader(),
      detail('A', '100.00'),
      detail('B', '50.00'),
      totalRow('150.00'),
      ['Total', '', '', '', '', '', '', '', '', '', '150.00'],
    ];
    const jobs = parseAoa(aoa, 'Sheet1');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].lines).toHaveLength(2);
    expect(jobs[0].computedTotal).toBeCloseTo(150, 2);
  });

  test('multiple projects each keep their own lines', () => {
    const other = 'S2157 Hammock II Stairway';
    const aoa = [
      ...PREAMBLE,
      groupHeader(),
      detail('A', '304.95'),
      totalRow('304.95'),
      [other, '', '', '', '', '', '', '', '', '', ''],
      ['', other, 'C', 'Expense', '05/26/2026', '', 'Subcontractors',
        'Cost of Goods Sold', 'Service & Repair - Tampa', '', '618.00'],
      ['Total for ' + other, '', '', '', '', '', '', '', '', '', '618.00'],
    ];
    const jobs = parseAoa(aoa, 'Sheet1');
    expect(jobs.map(j => j.code)).toEqual(['S2240', 'S2157']);
    expect(jobs.map(j => j.lines.length)).toEqual([1, 1]);
  });
});

describe('parseAoa — credits', () => {
  test('a parenthesized credit SUBTRACTS from the job total', () => {
    const aoa = [
      ...PREAMBLE,
      groupHeader(),
      detail('Supplier invoice', '1,000.00'),
      detail('Supplier refund', '(850.00)'),
      totalRow('150.00'),
    ];

    const [job] = parseAoa(aoa, 'Sheet1');

    expect(job.lines).toHaveLength(2);
    expect(job.lines[1].amount).toBe(-850);
    // Before the fix this was 1000 — the credit was read as 0.
    expect(job.computedTotal).toBeCloseTo(150, 2);
    expect(job.computedTotal).toBeCloseTo(job.reportedTotal, 2);
  });

  test('a job that is net negative stays negative', () => {
    const aoa = [
      ...PREAMBLE,
      groupHeader(),
      detail('Original bill', '500.00'),
      detail('Full reversal', '(1,200.00)'),
      totalRow('(700.00)'),
    ];
    const [job] = parseAoa(aoa, 'Sheet1');
    expect(job.computedTotal).toBeCloseTo(-700, 2);
    expect(job.reportedTotal).toBeCloseTo(-700, 2);
  });
});
