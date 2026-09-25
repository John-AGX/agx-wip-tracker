'use strict';
/**
 * The PO/sub double-count.
 *
 * accruedCosts = subAccruedOf(...) + poAccruedOf(...). A sub that holds a live
 * PO must be skipped by the first term, because the second already carries its
 * commitment. The skip is the ONLY thing standing between those two terms and
 * counting the same dollars twice.
 *
 * It did not work. `subs` is the jobs.data blob array, and js/jobs.js saveSub()
 * writes those rows as `{ id: 's' + Date.now(), name, contractAmt, ... }` — an
 * id local to that array, with no directory-sub field on the row at all.
 * `po.sub_id` is a `subs` TABLE id (`sub_<ts>_<rand>`). The guard compared the
 * two, so it could never fire.
 *
 * The old test passed anyway because its fixture gave the blob sub the
 * DIRECTORY id as its `id` — a shape no browser has ever written. These tests
 * use the real shape, so the guard has to earn its keep.
 */

const {
  computeJobWIP, subAccruedOf, poAccruedOf, subKey,
} = require('../server/services/money/job-wip');

const r2 = (n) => Math.round(n * 100) / 100;

// A blob sub exactly as js/jobs.js saveSub() writes it: local id, no sub_id.
const blobSub = (over) => Object.assign({
  id: 's1727451900123',
  jobId: 'job1',
  name: 'Gutters Inc',
  trade: 'Gutters',
  contractAmt: 50000,
  billedToDate: 0,
}, over);

// A PO row as loadWipInputs now yields it: directory sub id + the joined name.
const po = (over) => Object.assign({
  id: 'po1',
  sub_id: 'sub_1727000000_ab12cd',
  sub_name: 'Gutters Inc',
  status: 'issued',
  lines: [{ qty: 1, unitCost: 50000 }],
}, over);

describe('a sub that holds a live PO is not accrued twice', () => {
  test('the blob shape the browser actually writes is matched, by name', () => {
    // THE REGRESSION. Before the fix this returned 20000 (50000 x 40%) on top
    // of an identical PO accrual — the job's accrued cost, projected cost and
    // displayed profit were all wrong by the sub's whole earned contract.
    expect(subAccruedOf({}, [blobSub()], [po()], 40)).toBe(0);
  });

  test('and with no PO the same contract DOES accrue — the skip, not a dead function', () => {
    expect(r2(subAccruedOf({}, [blobSub()], [], 40))).toBe(r2(50000 * 0.4));
  });

  test('a DIFFERENT sub still accrues — the match is not "skip everything"', () => {
    const other = blobSub({ id: 's1727451900999', name: 'Roofing Co', contractAmt: 10000 });
    expect(r2(subAccruedOf({}, [blobSub(), other], [po()], 40))).toBe(r2(10000 * 0.4));
  });

  test('a draft or cancelled PO commits nothing, so its sub keeps accruing', () => {
    for (const status of ['draft', 'cancelled', 'void']) {
      expect(r2(subAccruedOf({}, [blobSub()], [po({ status })], 40)))
        .toBe(r2(50000 * 0.4));
    }
  });

  test('a table-shaped caller, whose sub.id IS the directory id, still matches', () => {
    const tableSub = { id: 'sub_1727000000_ab12cd', name: null, contractAmt: 50000, billedToDate: 0 };
    expect(subAccruedOf({}, [tableSub], [po({ sub_name: null })], 40)).toBe(0);
  });

  test('an explicit link field is honoured if a row ever carries one', () => {
    const linked = blobSub({ name: 'renamed since', subId: 'sub_1727000000_ab12cd' });
    expect(subAccruedOf({}, [linked], [po({ sub_name: null })], 40)).toBe(0);
  });

  test('a PO with no sub at all (materials-only) skips nobody', () => {
    expect(r2(subAccruedOf({}, [blobSub()], [po({ sub_id: null, sub_name: null })], 40)))
      .toBe(r2(50000 * 0.4));
  });
});

describe('the name key is forgiving about formatting, strict about identity', () => {
  test('case and punctuation do not defeat the match', () => {
    const sub = blobSub({ name: 'gutters,  inc.' });
    expect(subKey(sub.name)).toBe(subKey('Gutters Inc'));
    expect(subAccruedOf({}, [sub], [po()], 40)).toBe(0);
  });

  test('LLC and Inc are NOT merged — two companies, two accruals', () => {
    // A false match would silently erase a real sub's cost. A miss only leaves
    // the over-count, so this errs toward the miss on purpose.
    expect(subKey('Smith Roofing LLC')).not.toBe(subKey('Smith Roofing Inc'));
    const smithInc = blobSub({ name: 'Smith Roofing Inc', contractAmt: 8000 });
    const poLlc = po({ sub_name: 'Smith Roofing LLC' });
    expect(r2(subAccruedOf({}, [smithInc], [poLlc], 50))).toBe(r2(8000 * 0.5));
  });

  test('a blank or missing name never matches a blank one', () => {
    expect(subKey(null)).toBe('');
    const nameless = blobSub({ name: '' });
    expect(r2(subAccruedOf({}, [nameless], [po({ sub_id: null, sub_name: '' })], 40)))
      .toBe(r2(50000 * 0.4));
  });
});

describe('end to end: the two accrual terms stop overlapping', () => {
  const job = { pctComplete: 40, contractAmount: 200000, estimatedCosts: 150000 };
  const deps = () => ({
    phases: [], buildings: [], changeOrders: [], invoices: [],
    qbCostLines: [], vendorBills: [],
    subs: [blobSub()],
    purchaseOrders: [po()],
  });

  test('accruedCosts is the PO accrual alone, not PO + the same sub again', () => {
    const w = computeJobWIP(job, deps());
    expect(r2(w.accruedCosts)).toBe(r2(w.poAccrued));
    expect(r2(w.poAccrued)).toBe(r2(50000 * 0.4));
  });

  test('so projected cost does not carry the sub twice', () => {
    const w = computeJobWIP(job, deps());
    // actual 0 + accrued 20000. Double-counted it read 40000, and projected
    // profit was understated by the same 20000.
    expect(r2(w.projectedCost)).toBe(20000);
    expect(r2(w.projectedProfit)).toBe(r2(200000 - 20000));
  });

  test('a sub WITHOUT a PO still lands in accrued — nothing was traded away', () => {
    const d = deps();
    d.subs = [blobSub(), blobSub({ id: 's2', name: 'Painting LLC', contractAmt: 10000 })];
    const w = computeJobWIP(job, d);
    expect(r2(w.accruedCosts)).toBe(r2(w.poAccrued + 10000 * 0.4));
  });
});

describe('the PO rows reaching the accrual carry the name it matches on', () => {
  test('loadWipInputs joins subs and passes sub_name through', async () => {
    const jobWip = require('../server/services/money/job-wip');
    const seen = [];
    const db = {
      query: async (sql, params) => {
        seen.push(String(sql));
        if (/job_purchase_orders/.test(sql)) {
          return { rows: [{
            id: 'po1', job_id: 'job1', sub_id: 'sub_x', status: 'issued',
            data: { lines: [{ qty: 1, unitCost: 100 }] }, sub_name: 'Gutters Inc',
          }] };
        }
        return { rows: [] };
      },
    };
    const out = await jobWip.loadWipInputs(db, ['job1']);
    const poSql = seen.find((q) => /job_purchase_orders/.test(q));
    // The join is what makes the name available at all.
    expect(poSql).toMatch(/LEFT JOIN\s+subs\s+s\s+ON\s+s\.id\s*=\s*po\.sub_id/i);
    expect(out.get('job1').purchaseOrders[0].sub_name).toBe('Gutters Inc');
  });
});
