'use strict';
/**
 * The Subs directory's money.
 *
 * It used to sum job_subs.contract_amt / billed_to_date. Nothing writes those
 * columns any more — po-sub-access.js inserts 0 and never updates — so on the
 * live org all 16 subs holding purchase orders read $0 contracted against
 * $1,355,804 of live POs. The figures now come from the POs themselves.
 *
 * The test that matters most is the LAST one: the directory and the job page
 * must produce the same number for the same sub. They are two implementations
 * (server SQL + rollup, browser jobSubsFromPOs), and the only thing stopping
 * them drifting is running both over one fixture and comparing.
 */

const fs = require('fs');
const path = require('path');
const { extractFunction, compile } = require('./helpers/browser-fn.js');
const {
  subCommitments, rollupBySub, poIsLive, billCounts,
} = require('../server/services/money/sub-commitments');

const SUB_A = 'sub_1727000000_aaa111';
const SUB_B = 'sub_1727000000_bbb222';

// A PO row in the shape the SERVER reads it: money lives under `data`.
const po = (over) => Object.assign({
  id: 'po1', sub_id: SUB_A, job_id: 'job1', status: 'approved',
  data: { lines: [{ qty: 1, unitCost: 10000 }] },
}, over);

describe('what a purchase order commits', () => {
  test('a live PO is the sub’s contracted amount', () => {
    const m = rollupBySub([po()], []);
    expect(m.get(SUB_A).contracted).toBe(10000);
    expect(m.get(SUB_A).po_count).toBe(1);
    expect(m.get(SUB_A).job_count).toBe(1);
  });

  test('several POs add up, and distinct jobs are counted once each', () => {
    const m = rollupBySub([
      po({ id: 'po1', job_id: 'job1' }),
      po({ id: 'po2', job_id: 'job1', data: { lines: [{ qty: 2, unitCost: 500 }] } }),
      po({ id: 'po3', job_id: 'job2', data: { lines: [{ qty: 1, unitCost: 250 }] } }),
    ], []);
    expect(m.get(SUB_A).contracted).toBe(11250);
    expect(m.get(SUB_A).po_count).toBe(3);
    expect(m.get(SUB_A).job_count).toBe(2);
  });

  test('a draft, void, cancelled, canceled or rejected PO commits nothing', () => {
    for (const status of ['draft', 'void', 'cancelled', 'canceled', 'rejected', 'DRAFT', ' Void ']) {
      expect(poIsLive(status)).toBe(false);
      expect(rollupBySub([po({ status })], []).has(SUB_A)).toBe(false);
    }
    for (const status of ['approved', 'issued', 'work_complete', 'closed']) {
      expect(poIsLive(status)).toBe(true);
    }
  });

  test('a PO with no sub belongs to no directory row', () => {
    // Still real cost on its job; it just has no subcontractor to roll up to.
    expect(rollupBySub([po({ sub_id: null })], []).size).toBe(0);
  });

  test('each sub gets only their own POs', () => {
    const m = rollupBySub([po(), po({ id: 'po2', sub_id: SUB_B, data: { lines: [{ qty: 1, unitCost: 77 }] } })], []);
    expect(m.get(SUB_A).contracted).toBe(10000);
    expect(m.get(SUB_B).contracted).toBe(77);
  });

  test('the committed total is the frozen baseline plus APPROVED addenda only', () => {
    const withAdd = po({
      data: {
        lines: [{ qty: 1, unitCost: 10000 }],
        baselineTotal: 10000,
        addendums: [
          { status: 'approved', delta: 2500 },
          { status: 'pending', delta: 9999 },   // proposed, not committed
          { status: 'approved', delta: -400 },
        ],
      },
    });
    expect(rollupBySub([withAdd], []).get(SUB_A).contracted).toBe(12100);
  });

  test('a section header row is not priced', () => {
    const p = po({ data: { lines: [
      { section: '__section_header__', qty: 99, unitCost: 99 },
      { qty: 1, unitCost: 300 },
    ] } });
    expect(rollupBySub([p], []).get(SUB_A).contracted).toBe(300);
  });
});

describe('what they have billed', () => {
  test('bills against the PO roll up to the sub', () => {
    const m = rollupBySub([po()], [
      { po_id: 'po1', amount: 2500, status: 'open' },
      { po_id: 'po1', amount: 1000, status: 'paid' },
    ]);
    expect(m.get(SUB_A).billed).toBe(3500);
  });

  test('a void bill is not billed', () => {
    expect(billCounts('void')).toBe(false);
    expect(billCounts('open')).toBe(true);
    const m = rollupBySub([po()], [
      { po_id: 'po1', amount: 2500, status: 'void' },
      { po_id: 'po1', amount: 400, status: 'open' },
    ]);
    expect(m.get(SUB_A).billed).toBe(400);
  });

  test('a bill against somebody else’s PO does not land here', () => {
    const m = rollupBySub([po()], [{ po_id: 'po_other', amount: 5000, status: 'open' }]);
    expect(m.get(SUB_A).billed).toBe(0);
  });

  test('a bill on a dead PO is dropped with the PO', () => {
    const m = rollupBySub([po({ status: 'void' })], [{ po_id: 'po1', amount: 5000, status: 'open' }]);
    expect(m.has(SUB_A)).toBe(false);
  });

  test('over-billing is reported, not clamped', () => {
    // A negative remaining is a real condition the page colours red; hiding it
    // at zero would make an over-billed PO look settled.
    const m = rollupBySub([po()], [{ po_id: 'po1', amount: 12000, status: 'open' }]);
    expect(m.get(SUB_A).contracted - m.get(SUB_A).billed).toBe(-2000);
  });
});

describe('it only ever reads one tenant', () => {
  test('both queries are scoped through the job, with the org bound', async () => {
    const seen = [];
    const db = { query: async (sql, params) => { seen.push({ sql: String(sql), params }); return { rows: [] }; } };
    await subCommitments(db, 'org-7');
    expect(seen).toHaveLength(2);
    for (const q of seen) {
      expect(q.params).toEqual(['org-7']);
      expect(q.sql).toMatch(/JOIN\s+jobs\s+j\s+ON\s+j\.id\s*=/i);
      expect(q.sql).toMatch(/j\.organization_id\s*=\s*\$1/);
    }
    expect(seen.find((q) => /job_purchase_orders/.test(q.sql))).toBeTruthy();
    expect(seen.find((q) => /job_vendor_bills/.test(q.sql))).toBeTruthy();
  });

  test('rows come back folded by sub', async () => {
    const db = {
      query: async (sql) => (/job_purchase_orders/.test(sql)
        ? { rows: [po(), po({ id: 'po2', sub_id: SUB_B, data: { lines: [{ qty: 1, unitCost: 60 }] } })] }
        : { rows: [{ po_id: 'po1', amount: 1000, status: 'open' }] }),
    };
    const m = await subCommitments(db, 'org-7');
    expect(m.get(SUB_A)).toEqual({ contracted: 10000, billed: 1000, po_count: 1, job_count: 1 });
    expect(m.get(SUB_B).contracted).toBe(60);
  });
});

describe('the directory and the job page report the same money', () => {
  // THE INVARIANT. Two implementations, one fixture, same answer — because a
  // directory that disagrees with the job page is just a second number to
  // reconcile, which is the state this change exists to end.
  const JOBS_SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'jobs.js'), 'utf8');

  // Server rows carry money under `data`; the browser store holds it flattened
  // by shapeRow. Same PO, two shapes.
  const serverPOs = [
    { id: 'po1', sub_id: SUB_A, job_id: 'job1', status: 'approved',
      data: { lines: [{ qty: 2, unitCost: 1500 }], baselineTotal: 3000,
              addendums: [{ status: 'approved', delta: 500 }, { status: 'pending', delta: 900 }] } },
    { id: 'po2', sub_id: SUB_A, job_id: 'job1', status: 'work_complete',
      data: { lines: [{ qty: 1, unitCost: 250 }] } },
    { id: 'po3', sub_id: SUB_A, job_id: 'job1', status: 'draft',
      data: { lines: [{ qty: 1, unitCost: 99999 }] } },
    { id: 'po4', sub_id: null, job_id: 'job1', status: 'approved',
      data: { lines: [{ qty: 1, unitCost: 4444 }] } },
  ];
  const bills = [
    { po_id: 'po1', amount: 1200, status: 'open', job_id: 'job1' },
    { po_id: 'po1', amount: 300, status: 'void', job_id: 'job1' },
    { po_id: 'po2', amount: 100, status: 'paid', job_id: 'job1' },
  ];
  const browserPOs = serverPOs.map((p) => Object.assign(
    { id: p.id, sub_id: p.sub_id, job_id: p.job_id, status: p.status, sub_name: 'Gutters Inc' },
    p.data
  ));

  function jobPageSubs() {
    const appData = { jobPurchaseOrders: browserPOs, jobVendorBills: bills, _billsAllLoaded: true };
    const fn = compile(
      [
        extractFunction(JOBS_SRC, 'poRowTotal'),
        extractFunction(JOBS_SRC, 'poRowBilled'),
        extractFunction(JOBS_SRC, 'jobSubsFromPOs'),
      ],
      ['appData', '_JB_PO_DEAD', '_billsLoadedJobs', '_jbSubName'],
      [appData,
        { draft: 1, void: 1, cancelled: 1, canceled: 1, rejected: 1 },
        {},
        () => 'Gutters Inc'],
      'jobSubsFromPOs'
    );
    return fn('job1');
  }

  test('contracted matches, to the cent', () => {
    const page = jobPageSubs().find((x) => x.id === SUB_A);
    const dir = rollupBySub(serverPOs, bills).get(SUB_A);
    expect(dir.contracted).toBe(page.contractAmt);
    expect(dir.contracted).toBe(3500 + 250);   // baseline+approved addendum, draft excluded
  });

  test('billed matches, to the cent', () => {
    const page = jobPageSubs().find((x) => x.id === SUB_A);
    const dir = rollupBySub(serverPOs, bills).get(SUB_A);
    expect(dir.billed).toBe(page.billedToDate);
    expect(dir.billed).toBe(1300);             // void bill excluded
  });

  test('both drop the PO that has no sub', () => {
    const page = jobPageSubs();
    expect(page.find((x) => x.id === null)).toBeUndefined();
    expect(rollupBySub(serverPOs, bills).has(null)).toBe(false);
    // and neither one let its $4,444 leak into the sub that does exist
    expect(rollupBySub(serverPOs, bills).get(SUB_A).contracted).toBe(3750);
  });
});
