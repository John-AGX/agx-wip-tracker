// QUICKBOOKS PRINTS THE SAME ROW MORE THAN ONCE, AND IT USED TO VANISH.
//
// Seven separate $50.00 City of Tampa permit expenses on RV2001, every one
// dated 12/03/2025, blank Num, identical memo. They are seven real charges.
// qb_cost_lines keys a row on a hash of its CONTENT — job, vendor, date,
// type, num, account, memo, amount — so all seven produced one id, six never
// reached the table, and the import receipt filed them under "already on file
// (updated in place, not duplicated)" and painted green.
//
// On the 2026-10-01 export that was 42 rows and $4,848.01. Small as a share
// of $3.26M, but concentrated: S2229 lost 8.5% of its cost, S2032 8.2%,
// S2394 4.4%. And it was invisible — reconcile() compares the PARSED lines
// against QuickBooks' own subtotal, and the parse was never wrong; the loss
// happened after it.
//
// The fix gives the hash an occurrence index, supplied by the caller, which
// counts how many times it has already seen that exact content in this
// submission. What this file pins:
//
//   1. BACKWARD COMPATIBILITY, which is the dangerous half. Occurrence 0 must
//      hash byte-identically to the old function or every row already stored
//      is orphaned and the next import double-counts the lot.
//   2. Repeats are stored, and the money arrives whole.
//   3. Re-importing the same file still writes no duplicates — including when
//      QuickBooks emits the identical rows in a different order.
//   4. The stale-$0.00-credit cleanup still aims at the row it means to.
//
// Driven through the real router handler against the same in-memory fake pg
// client the sibling route test uses, so the real hash and the real
// ON CONFLICT branch decide every count.

const { hashLineId, staleZeroLineId } = require('../server/util/qb-line-id');

// ── Fake Postgres — a dict keyed by id, honouring ON CONFLICT ────────
function makeFakeDb(existingJobIds) {
  const jobIds = new Set(existingJobIds);
  const rows = new Map();
  const log = [];
  let staged = null;
  const view = () => (staged || rows);

  const client = {
    released: false,
    async query(sql, params) {
      const text = String(sql);
      const head = text.trim();
      log.push(head.split('\n')[0].trim());
      if (/^BEGIN/i.test(head)) { staged = new Map(rows); return { rows: [], rowCount: 0 }; }
      if (/^COMMIT/i.test(head)) {
        if (staged) { rows.clear(); for (const [k, v] of staged) rows.set(k, v); }
        staged = null; return { rows: [], rowCount: 0 };
      }
      if (/^ROLLBACK/i.test(head)) { staged = null; return { rows: [], rowCount: 0 }; }
      if (/SELECT id FROM jobs/i.test(text)) {
        const ids = (params && params[0]) || [];
        const hit = ids.filter((id) => jobIds.has(id)).map((id) => ({ id }));
        return { rows: hit, rowCount: hit.length };
      }
      if (/INSERT INTO qb_cost_lines/i.test(text)) {
        const [id, jobId, vendor, txnDate, txnType, num, account, accountType,
          klass, memo, amount] = params;
        const store = view();
        const isNew = !store.has(id);
        store.set(id, { id, job_id: jobId, vendor, txn_date: txnDate, txn_type: txnType,
          num, account, account_type: accountType, klass, memo, amount });
        return { rows: [{ inserted: isNew }], rowCount: 1 };
      }
      if (/DELETE FROM qb_cost_lines/i.test(text)) {
        const [id, jobId] = params;
        const store = view();
        const hit = store.get(id);
        if (hit && hit.job_id === jobId && Number(hit.amount) === 0) {
          store.delete(id); return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      throw new Error('fake db: unhandled SQL — ' + text.slice(0, 80));
    },
    release() { this.released = true; }
  };
  return { client, rows, log };
}

let fake;

jest.mock('../server/db', () => ({
  pool: {
    connect: async () => global.__qbFakeClient,
    query: async (sql, params) => global.__qbFakeClient.query(sql, params)
  }
}));
jest.mock('../server/auth', () => ({
  requireAuth: (req, res, next) => next(),
  requireCapability: () => (req, res, next) => next(),
  requireOrgId: (req, res, next) => { req.orgId = 7; next(); }
}));

const router = require('../server/routes/qb-cost-routes');

function importHandler() {
  const layer = router.stack.find((l) => l.route && l.route.path === '/import');
  if (!layer) throw new Error('POST /import route not found');
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}
function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.body = p; return res; };
  return res;
}
async function runImport(body) {
  const res = fakeRes();
  await importHandler()({ body, orgId: 7 }, res);
  return res;
}

// ── The real shape, from the real export ─────────────────────────────
const RV2001 = 'j1785987106996_rv01';
// Rows 703-708 and 726 of AG Exteriors_Project costs detail (51).xlsx.
const PERMIT = {
  vendor: 'City of Tampa',
  date: '12/03/2025',
  txnType: 'Expense',
  num: '',
  account: 'General Conditions',
  accountType: 'Cost of Goods Sold',
  klass: 'Renovation - Tampa',
  memo: 'CITY TPA PERMIT 1        TAMPA        FL',
  amount: 50
};
const copies = (n) => Array.from({ length: n }, () => Object.assign({}, PERMIT));
const submit = (lines, jobId) => ({
  reportDate: '2026-10-01',
  sourceFile: 'AG Exteriors_Project costs detail (51).xlsx',
  jobs: [{ jobId: jobId || RV2001, lines }]
});
const total = () => [...fake.rows.values()].reduce((s, r) => s + Number(r.amount || 0), 0);

beforeEach(() => {
  fake = makeFakeDb([RV2001]);
  global.__qbFakeClient = fake.client;
});

describe('the hash stays compatible with every row already stored', () => {
  // THE ONE THAT MATTERS. If this breaks, the next import does not fix
  // anything — it inserts a parallel copy of the whole table beside the
  // orphaned original and every job's cost doubles.
  test('occurrence 0 hashes exactly as the old two-argument call did', () => {
    expect(hashLineId(RV2001, PERMIT, 0)).toBe(hashLineId(RV2001, PERMIT));
    expect(hashLineId(RV2001, PERMIT, undefined)).toBe(hashLineId(RV2001, PERMIT));
    expect(hashLineId(RV2001, PERMIT, null)).toBe(hashLineId(RV2001, PERMIT));
    // Pinned as a LITERAL, computed before the occurrence index existed. A
    // refactor that changes the hashed input — reorders a part, trims a field
    // differently, switches the separator — fails here, which is the only
    // place it can be caught cheaply. Everywhere else it surfaces as a cost
    // rollup that silently doubled.
    expect(hashLineId(RV2001, PERMIT)).toBe('qbc_79c47d1ef0b81f3f');
    expect(hashLineId(RV2001, PERMIT, 1)).toBe('qbc_1728d584d6097643');
  });

  test('later occurrences are distinct from occurrence 0 and from each other', () => {
    const ids = [0, 1, 2, 3, 4, 5, 6].map((n) => hashLineId(RV2001, PERMIT, n));
    expect(new Set(ids).size).toBe(7);
  });

  test('the index is deterministic — the same call gives the same id forever', () => {
    expect(hashLineId(RV2001, PERMIT, 3)).toBe(hashLineId(RV2001, PERMIT, 3));
  });

  test('the index does not leak across jobs or across different content', () => {
    expect(hashLineId('other_job', PERMIT, 1)).not.toBe(hashLineId(RV2001, PERMIT, 1));
    expect(hashLineId(RV2001, Object.assign({}, PERMIT, { amount: 51 }), 1))
      .not.toBe(hashLineId(RV2001, PERMIT, 1));
  });

  test('the stale-credit id never carries an index', () => {
    // The phantom $0.00 row was written by the pre-fix parser, which had no
    // index, so the only stale row that can exist is the zeroth one. Asking
    // for any other would hand the DELETE an id that is not the phantom's.
    const credit = Object.assign({}, PERMIT, { amount: -50 });
    expect(staleZeroLineId(RV2001, credit))
      .toBe(hashLineId(RV2001, Object.assign({}, credit, { amount: 0 })));
  });
});

describe('seven identical permit charges are seven rows', () => {
  test('all seven are stored, and the money arrives whole', () => {
    return runImport(submit(copies(7))).then((res) => {
      expect(res.statusCode).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.inserted).toBe(7);
      expect(res.body.updated).toBe(0);
      expect(fake.rows.size).toBe(7);
      expect(total()).toBe(350);        // not 50
    });
  });

  test('the receipt COUNTS the repeats rather than calling them "already on file"', async () => {
    const res = await runImport(submit(copies(7)));
    // Six of the seven are repeats of the first.
    expect(res.body.repeats).toBe(6);
  });

  test('a file with no repeats reports none', async () => {
    const res = await runImport(submit([
      Object.assign({}, PERMIT, { amount: 50 }),
      Object.assign({}, PERMIT, { amount: 60 }),
      Object.assign({}, PERMIT, { num: 'INV 1' })
    ]));
    expect(res.body.repeats).toBe(0);
    expect(res.body.inserted).toBe(3);
  });

  test('BEFORE THE FIX this collapsed to one row — the control', () => {
    // Hashing without an index is what the old code did. Proves the fixture
    // really does collide, so the test above is measuring the fix and not a
    // set of rows that were always distinct.
    const ids = copies(7).map((l) => hashLineId(RV2001, l));
    expect(new Set(ids).size).toBe(1);
  });
});

describe('re-importing the same report still writes nothing new', () => {
  test('a second submit updates all seven in place', async () => {
    await runImport(submit(copies(7)));
    const second = await runImport(submit(copies(7)));
    expect(second.body.inserted).toBe(0);
    expect(second.body.updated).toBe(7);
    expect(fake.rows.size).toBe(7);
    expect(total()).toBe(350);
  });

  test('…and it holds when QuickBooks emits the identical rows in another order', async () => {
    // The colliding rows are identical in every hashed field, so WHICH copy
    // gets index 0 cannot matter: any permutation yields the same set of ids.
    // That is what makes the index safe without a stable row number.
    await runImport(submit(copies(7)));
    const ids = new Set(fake.rows.keys());
    const mixed = copies(7).reverse();
    const second = await runImport(submit(mixed));
    expect(second.body.inserted).toBe(0);
    expect(new Set(fake.rows.keys())).toEqual(ids);
  });

  test('a week later, with one MORE copy, only the new one is written', async () => {
    await runImport(submit(copies(7)));
    const next = await runImport(submit(copies(8)));
    expect(next.body.inserted).toBe(1);
    expect(next.body.updated).toBe(7);
    expect(fake.rows.size).toBe(8);
    expect(total()).toBe(400);
  });
});

describe('repeats do not disturb anything else the import does', () => {
  test('a repeated CREDIT still retires only its own phantom $0.00 twin', async () => {
    const credit = Object.assign({}, PERMIT, { amount: -50 });
    // Seed the table with the phantom the pre-fix parser would have left.
    fake.rows.set(staleZeroLineId(RV2001, credit), {
      id: staleZeroLineId(RV2001, credit), job_id: RV2001, amount: 0
    });
    const res = await runImport(submit([credit, Object.assign({}, credit)]));
    expect(res.body.inserted).toBe(2);
    expect(res.body.cleaned).toBe(1);               // exactly one phantom retired
    expect(fake.rows.has(staleZeroLineId(RV2001, credit))).toBe(false);
    expect(total()).toBe(-100);
  });

  test('repeats across two different jobs are counted per job, not pooled', async () => {
    const OTHER = 'j1785987106996_s229';
    fake = makeFakeDb([RV2001, OTHER]);
    global.__qbFakeClient = fake.client;
    const res = await runImport({
      reportDate: '2026-10-01',
      sourceFile: 'x.xlsx',
      jobs: [
        { jobId: RV2001, lines: copies(3) },
        { jobId: OTHER, lines: copies(2) }
      ]
    });
    expect(res.body.inserted).toBe(5);
    expect(fake.rows.size).toBe(5);
    expect(res.body.byJob[RV2001]).toMatchObject({ inserted: 3 });
    expect(res.body.byJob[OTHER]).toMatchObject({ inserted: 2 });
  });
});
