'use strict';
/**
 * The browser half of the PO/sub double-count.
 *
 * The server figure is what 86, the company rollup and the Live Rooms chip
 * read; THIS is the one on the job page John looks at. They are separate
 * implementations of the same rule, so the fix has to be proved on both —
 * the whole reason the server port carries "Mirrors js/jobs.js" comments.
 *
 * The function's real TEXT is lifted out and run, so if the guard in
 * js/jobs.js changes, what these tests execute changes with it.
 */

const fs = require('fs');
const path = require('path');
const { extractFunction, compile } = require('./helpers/browser-fn.js');

const JOBS_SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'jobs.js'), 'utf8');

const r2 = (n) => Math.round(n * 100) / 100;

// Built exactly as js/jobs.js saveSub() writes it: a local 's'+Date.now() id,
// and no directory-sub field anywhere on the row.
const blobSub = (over) => Object.assign({
  id: 's1727451900123',
  jobId: 'job1',
  name: 'Gutters Inc',
  contractAmt: 50000,
  billedToDate: 0,
}, over);

const po = (over) => Object.assign({
  id: 'po1',
  job_id: 'job1',
  sub_id: 'sub_1727000000_ab12cd',
  sub_name: 'Gutters Inc',
  status: 'issued',
}, over);

function accrual({ subs, pos, pct = 40 }) {
  const appData = {
    jobs: [{ id: 'job1', pctComplete: pct }],
    subs,
    jobPurchaseOrders: pos,
  };
  return compile(
    [
      extractFunction(JOBS_SRC, '_subMatchKey'),
      extractFunction(JOBS_SRC, 'getJobAccruedCosts'),
    ],
    ['appData', 'window', '_jbSubName'],
    [appData, { }, () => null],
    'getJobAccruedCosts'
  )('job1');
}

describe('the job page does not accrue a PO-backed sub twice', () => {
  test('the real blob shape is matched by name, so nothing doubles', () => {
    // Before the fix: 20000, on top of an identical PO accrual. The job page's
    // accrued cost, projected cost and displayed profit were each wrong by it.
    expect(accrual({ subs: [blobSub()], pos: [po()] })).toBe(0);
  });

  test('with no PO the same contract accrues — proving the skip, not a dead branch', () => {
    expect(r2(accrual({ subs: [blobSub()], pos: [] }))).toBe(r2(50000 * 0.4));
  });

  test('an unrelated sub keeps its accrual', () => {
    const other = blobSub({ id: 's999', name: 'Roofing Co', contractAmt: 10000 });
    expect(r2(accrual({ subs: [blobSub(), other], pos: [po()] }))).toBe(r2(10000 * 0.4));
  });

  test('a draft PO commits nothing, so its sub still accrues', () => {
    expect(r2(accrual({ subs: [blobSub()], pos: [po({ status: 'draft' })] })))
      .toBe(r2(50000 * 0.4));
  });

  test('a PO on ANOTHER job never suppresses this job’s accrual', () => {
    expect(r2(accrual({ subs: [blobSub()], pos: [po({ job_id: 'job2' })] })))
      .toBe(r2(50000 * 0.4));
  });

  test('billed-to-date still nets out of an unmatched sub', () => {
    const partly = blobSub({ name: 'Nobody Else', billedToDate: 5000 });
    expect(r2(accrual({ subs: [partly], pos: [po()] }))).toBe(r2(50000 * 0.4 - 5000));
  });

  test('LLC and Inc stay separate here too', () => {
    const smithInc = blobSub({ name: 'Smith Roofing Inc', contractAmt: 8000 });
    expect(r2(accrual({ subs: [smithInc], pos: [po({ sub_name: 'Smith Roofing LLC' })], pct: 50 })))
      .toBe(r2(8000 * 0.5));
  });
});

describe('the two implementations state the same rule', () => {
  test('browser and server normalize a sub name identically', () => {
    const browserKey = compile([extractFunction(JOBS_SRC, '_subMatchKey')], [], [], '_subMatchKey');
    const { subKey } = require('../server/services/money/job-wip');
    for (const n of ['Gutters Inc', 'gutters,  inc.', 'Smith Roofing LLC', '', null, 'A&B  Co']) {
      expect(browserKey(n)).toBe(subKey(n));
    }
  });
});
