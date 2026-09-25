// THE CROSS-JOB DETAILED COSTS PAGE (Jobs → Detailed Costs).
//
// Three things decide whether this page tells the truth, and all three are
// pure functions lifted out of js/jobs-hub.js and js/qb-costs-view.js and run
// here — not modelled, RUN, so a change to the real code changes this test.
//
//   costRowsFrom   one row per job, bucketed, with QuickBooks' sub figure and
//                  what P86 has billed kept APART (a sub is cost once, from
//                  its bill — counting QuickBooks too double-counts it).
//   csvFor         the export is the rows on screen, in their order.
//   bucketFor      which bucket an account name lands in.
'use strict';

const fs = require('fs');
const path = require('path');
const { extractFunction, compile } = require('./helpers/browser-fn');

const hubSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'jobs-hub.js'), 'utf8');
const qbSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'qb-costs-view.js'), 'utf8');
const bucketSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'cost-buckets.js'), 'utf8');

const bucketFor = new Function('return ' + extractFunction(bucketSrc, 'bucketFor'))();
const effectiveBucket = new Function('bucketFor', 'CODES',
  'return ' + extractFunction(bucketSrc, 'effectiveBucket'))(bucketFor, ['materials', 'labor', 'subs', 'equipment', 'gc', 'other']);
const isAccrualLine = new Function('CODES', 'return ' + extractFunction(bucketSrc, 'isAccrualLine'))(['materials', 'labor', 'subs', 'equipment', 'gc', 'other']);

// The two hub functions read window.p86CostBuckets, so hand them a real one.
const win = { p86CostBuckets: { effectiveBucket, isAccrualLine, CANON: [
  { code: 'materials', label: 'Materials & Supplies' }, { code: 'labor', label: 'Labor' },
  { code: 'subs', label: 'Subcontractors' }, { code: 'equipment', label: 'Equipment' },
  { code: 'gc', label: 'General Conditions' }, { code: 'other', label: 'Other' }] } };
const costRowsFrom = new Function('window', 'return ' + extractFunction(hubSrc, 'costRowsFrom'))(win);
const costsTotals = new Function('return ' + extractFunction(hubSrc, 'costsTotals'))();
const csvSrc = ['csvCell', 'buildingNameFor', 'csvFor'].map(function (n) { return extractFunction(qbSrc, n); });
// `appData` is a bare browser global in this file (window.appData && appData.x),
// so it is injected alongside window.
const csvFor = compile(csvSrc, ['window', 'appData'], [win, {}], 'csvFor');

const line = (o) => Object.assign({ job_id: 'j1', vendor: 'ABC', amount: 100, account: 'Materials & Supplies - COGS', txn_type: 'Bill', report_date: '2026-09-01' }, o);

describe('one row per job, bucketed', () => {
  const rows = costRowsFrom([
    line({ amount: 1000 }),
    line({ amount: 250, account: 'Direct Labor' }),
    line({ amount: 40, account: 'Travel Expenses' }),
    line({ amount: 5000, account: 'Subcontractors' }),
    line({ job_id: 'j2', amount: 300, report_date: '2026-09-15' }),
  ], [
    { job_id: 'j1', amount: 4000, status: 'received' },
    { job_id: 'j1', amount: 999, status: 'void' },
    { job_id: 'jX', amount: 50, status: 'received' },
  ]);
  const j1 = rows.find((r) => r.jobId === 'j1');

  test('the jobs that cost the most come first, whatever order the lines arrive in', () => {
    // The small job's line comes FIRST here, so insertion order alone would
    // put it on top: only sorting can produce this.
    const mixed = costRowsFrom([
      line({ job_id: 'small', amount: 5 }),
      line({ job_id: 'big', amount: 9000 }),
      line({ job_id: 'middle', amount: 500 }),
      // Sub spend counts toward WHICH job is biggest, even though it is not cost.
      line({ job_id: 'middle', amount: 4000, account: 'Subcontractors' }),
    ], []);
    expect(mixed.map((r) => r.jobId)).toEqual(['big', 'middle', 'small']);
    expect(rows.map((r) => r.jobId)).toEqual(['j1', 'j2']);
  });

  test('QuickBooks subs are kept OUT of the counted total and shown on their own', () => {
    // 1000 materials + 250 labor + 40 travel(gc) — the $5,000 sub is not cost here.
    expect(j1.total).toBe(1290);
    expect(j1.subs).toBe(5000);
    expect(j1.buckets.gc).toBe(40);
  });

  test('billed is what P86 invoiced, and a VOID bill is not money', () => {
    expect(j1.billed).toBe(4000);
  });

  test('a bill for a job with no QuickBooks cost cannot invent a row', () => {
    expect(rows.find((r) => r.jobId === 'jX')).toBeUndefined();
  });

  test('the last import date is the newest one on the job', () => {
    expect(j1.lastImport).toBe('2026-09-01');
    expect(rows.find((r) => r.jobId === 'j2').lastImport).toBe('2026-09-15');
  });

  test('a line with no job belongs to no row', () => {
    expect(costRowsFrom([line({ job_id: null })], []).length).toBe(0);
  });
});

describe('month-end accruals', () => {
  // An accrual and its reversal cancel; neither is cost.
  const rows = costRowsFrom([
    line({ amount: 500 }),
    line({ amount: 2000, txn_type: 'Journal Entry', account: 'Subcontractors' }),
    line({ amount: -2000, txn_type: 'Journal Entry', account: 'Subcontractors' }),
  ], []);

  test('they are counted apart and never land in a bucket', () => {
    expect(rows[0].total).toBe(500);
    expect(rows[0].subs).toBe(0);
    expect(rows[0].accrual).toBe(0);
    expect(rows[0].lines).toBe(3);
  });

  test('a HALF pair is what the page has to report — it means an import was cut', () => {
    const cut = costRowsFrom([line({ amount: 2000, txn_type: 'Journal Entry' })], []);
    expect(cut[0].accrual).toBe(2000);
    expect(cut[0].total).toBe(0);
    expect(costsTotals(cut).accrual).toBe(2000);
  });
});

describe('the org rollup adds up', () => {
  const rows = costRowsFrom([
    line({ amount: 1000 }), line({ job_id: 'j2', amount: 500, account: 'Direct Labor' }),
    line({ job_id: 'j2', amount: 700, account: 'Subcontractors' }),
  ], [{ job_id: 'j2', amount: 600, status: 'received' }]);
  const t = costsTotals(rows);

  test('every figure is the sum of the rows it is made of', () => {
    expect([t.jobs, t.lines, t.total, t.subs, t.billed]).toEqual([2, 3, 1500, 700, 600]);
    expect(t.buckets.materials).toBe(1000);
    expect(t.buckets.labor).toBe(500);
  });
});

describe('the CSV is what is on screen', () => {
  const lines = [
    { date: '2026-09-02', vendor: 'Home Depot', account: 'Materials & Supplies - COGS', klass: 'Renovation - Tampa', memo: 'paint, 5 gal', amount: 123.456, buildingId: 'b1' },
    { date: '2026-09-03', vendor: 'A "Big" Sub, LLC', account: 'Subcontractors', klass: '', memo: 'line\nbreak', amount: -50 },
  ];
  const win2 = Object.assign({}, win, { appData: { buildings: [{ id: 'b1', name: 'Building 3' }] } });
  const csv = compile(csvSrc, ['window', 'appData'], [win2, win2.appData], 'csvFor')('j1', lines);
  const rows = csv.split('\r\n');

  test('it carries the columns the table shows, including Class', () => {
    expect(rows[0]).toBe('Date,Vendor,Account,Class,Memo,Amount,Bucket,Building');
  });

  test('a bucket is named the way the screen names it, and a building by its name', () => {
    expect(rows[1]).toContain('Materials & Supplies');
    expect(rows[1]).toContain('Building 3');
  });

  test('money is exact to the cent, negatives kept', () => {
    expect(rows[1]).toContain('123.46');
    expect(rows[2]).toContain('-50.00');
  });

  test('a quote, a comma and a line break inside a value cannot break the file', () => {
    expect(rows[2]).toContain('"A ""Big"" Sub, LLC"');
    expect(csv).toContain('"line\nbreak"');
    // Two data rows and a header, no matter what the memos contain.
    expect(csv.split('\r\n').filter((r) => /^\d{4}-/.test(r)).length).toBe(2);
  });
});

describe('accounts land in the right bucket', () => {
  test.each([
    ['Materials & Supplies - COGS', 'materials'],
    ['Direct Labor', 'labor'],
    ['Direct Burden (deleted)', 'labor'],
    ['Subcontractors', 'subs'],
    ['General Conditions', 'gc'],
    ['Permit & Engineering Fees', 'gc'],
    // Was falling to Other, which is for cost nobody has classified.
    ['Travel Expenses', 'gc'],
    ['Equipment Rental', 'equipment'],
    ['Something nobody mapped', 'other'],
  ])('%s → %s', (account, bucket) => {
    expect(bucketFor(account)).toBe(bucket);
  });

  test('a hand-set bucket beats the account name', () => {
    expect(effectiveBucket({ account: 'Subcontractors', bucket: 'materials' })).toBe('materials');
  });
});
