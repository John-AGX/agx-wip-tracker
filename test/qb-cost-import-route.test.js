// test/qb-cost-import-route.test.js — the QB cost import WRITE.
//
// The 08.13.26 "Project costs detail" export was imported twice and wrote
// zero rows. Nothing upstream was broken: the file parsed, the sheet was
// picked correctly, RV2004's 222 lines reconciled to QuickBooks' own
// printed subtotal to the penny, and the job matched by jobNumber. The
// rows died at the write — a fire-and-forget fetch() whose every failure
// path was a console.warn, under a success alert() computed from
// client-side spreadsheet math. An import that stored nothing was
// pixel-identical to one that worked.
//
// The client fix is "report the SERVER'S numbers"; that is only worth
// anything if the server's numbers are right. So this pins the two facts
// the receipt reports:
//
//   1. Genuinely-new rows for a job with no existing lines get WRITTEN.
//      (Citi Lakes had never been imported — its 222 rows could not
//      legitimately dedupe away, and a dedupe that drops a whole batch is
//      exactly the failure that was suspected.)
//   2. Re-submitting rows already stored writes NO duplicates. The QB
//      report is cumulative — every weekly export re-sends months of rows
//      — so the dedupe has to hold on the same file twice. This writes
//      live financial data; a dedupe defect in the other direction
//      double-counts cost.
//
// Driven through the real router handler against an in-memory fake pg
// client, so the real hashLineId and the real ON CONFLICT branch decide
// the counts. `../db` and `../auth` are mocked: requiring auth.js
// hard-fails without a JWT_SECRET (A1), and this must not depend on the
// environment having one.

const { hashLineId } = require('../server/util/qb-line-id');

// ── Fake Postgres ────────────────────────────────────────────────────
// A dict keyed by qb_cost_lines.id, which is the whole point: the id is a
// content hash, so "already stored" and "new" are decided by the same
// primary key Postgres uses. Recognises the three statements the import
// issues and mimics ON CONFLICT (id) DO UPDATE ... RETURNING (xmax = 0).
function makeFakeDb(existingJobIds) {
  const jobIds = new Set(existingJobIds);
  const rows = new Map(); // id -> stored row
  const log = [];

  const client = {
    released: false,
    async query(sql, params) {
      const text = String(sql);
      log.push(text.trim().split('\n')[0].trim());

      if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(text.trim())) return { rows: [], rowCount: 0 };

      if (/SELECT 1 FROM jobs/i.test(text)) {
        return jobIds.has(params[0]) ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }

      if (/INSERT INTO qb_cost_lines/i.test(text)) {
        const [id, jobId, vendor, txnDate, txnType, num, account, accountType,
          klass, memo, amount, raw, sourceFile, reportDate] = params;
        const isNew = !rows.has(id);
        rows.set(id, {
          id, job_id: jobId, vendor, txn_date: txnDate, txn_type: txnType, num,
          account, account_type: accountType, klass, memo, amount,
          raw_data: raw, source_file: sourceFile, report_date: reportDate
        });
        return { rows: [{ inserted: isNew }], rowCount: 1 };
      }

      if (/DELETE FROM qb_cost_lines/i.test(text)) {
        const [id, jobId] = params;
        const hit = rows.get(id);
        if (hit && hit.job_id === jobId && Number(hit.amount) === 0) {
          rows.delete(id);
          return { rows: [], rowCount: 1 };
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

// qb-cost-routes.js destructures `pool` at require time, so the mock's pool
// has to be one stable object whose connect() resolves the CURRENT fake.
jest.mock('../server/db', () => ({
  pool: { connect: async () => global.__qbFakeClient }
}));

jest.mock('../server/auth', () => ({
  requireAuth: (req, res, next) => next(),
  requireCapability: () => (req, res, next) => next()
}));

const router = require('../server/routes/qb-cost-routes');

// Pull the POST /import handler out of the express router. The auth
// middleware is mocked to a pass-through, so the last handler in the
// route's stack is the one under test.
function importHandler() {
  const layer = router.stack.find(l => l.route && l.route.path === '/import');
  if (!layer) throw new Error('POST /import route not found on the router');
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = code => { res.statusCode = code; return res; };
  res.json = payload => { res.body = payload; return res; };
  return res;
}

async function runImport(body) {
  const res = fakeRes();
  await importHandler()({ body }, res);
  return res;
}

// ── Fixture: the shape that actually failed ──────────────────────────
// RV2004 Citi Lakes Repaint and Repairs — a job with zero stored lines.
const CITI_LAKES = 'j1785987106996_n9rp';

function line(i, overrides) {
  return Object.assign({
    vendor: 'Black Horse Construction Service of FL Inc',
    date: '07/15/2026',
    txnType: 'Bill',
    num: 'INV ' + (7152026 + i),
    account: 'Subcontractors',
    accountType: '',
    klass: 'Renovation - Orlando',
    memo: 'Paint Bldgs 1, 2 & 3 — draw ' + i,
    amount: 1000 + i
  }, overrides || {});
}

function batch(n, jobId) {
  return {
    reportDate: '2026-08-13',
    sourceFile: '08.13.26 - Project Costs.xlsx',
    jobs: [{ jobId: jobId || CITI_LAKES, lines: Array.from({ length: n }, (_, i) => line(i)) }]
  };
}

beforeEach(() => {
  fake = makeFakeDb([CITI_LAKES]);
  global.__qbFakeClient = fake.client;
});

describe('POST /api/qb-costs/import — genuinely-new rows must be written', () => {
  test('a job with no existing lines gets every row stored', async () => {
    const res = await runImport(batch(222));

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    // The failure this closes: 222 in, 0 out, and the UI says "imported".
    expect(res.body.inserted).toBe(222);
    expect(res.body.updated).toBe(0);
    expect(res.body.skipped).toBe(0);
    expect(res.body.rejected).toEqual([]);
    expect(fake.rows.size).toBe(222);
    // The receipt's headline number is the server's, so it has to be real.
    expect(res.body.received).toBe(222);
    expect(res.body.byJob[CITI_LAKES]).toMatchObject({ inserted: 222, updated: 0 });
  });

  test('the batch is committed, not rolled back', async () => {
    await runImport(batch(3));
    expect(fake.log).toContain('COMMIT');
    expect(fake.log).not.toContain('ROLLBACK');
    expect(fake.client.released).toBe(true);
  });
});

describe('POST /api/qb-costs/import — a re-submit must not duplicate', () => {
  test('re-sending stored rows updates in place and writes no new rows', async () => {
    const first = await runImport(batch(222));
    expect(first.body.inserted).toBe(222);
    expect(fake.rows.size).toBe(222);

    // The QB report is cumulative: next week's export re-sends all of this.
    const second = await runImport(batch(222));

    expect(second.body.inserted).toBe(0);
    expect(second.body.updated).toBe(222);
    expect(second.body.skipped).toBe(0);
    // The one that matters — money cannot double-count.
    expect(fake.rows.size).toBe(222);
  });

  test('a cumulative export writes only the rows that are new', async () => {
    await runImport(batch(200));
    expect(fake.rows.size).toBe(200);

    // Same 200 rows plus 22 fresh ones, the real weekly shape.
    const next = await runImport(batch(222));

    expect(next.body.updated).toBe(200);
    expect(next.body.inserted).toBe(22);
    expect(fake.rows.size).toBe(222);
  });

  test('the id is the content hash, so an edited row replaces nothing', async () => {
    // Editing a memo in QuickBooks changes the hash — the row lands as a
    // new line rather than updating the old one. Pinned so the "already on
    // file" number on the receipt is understood, not mistaken for a bug.
    const a = hashLineId(CITI_LAKES, line(0));
    const b = hashLineId(CITI_LAKES, line(0, { memo: 'Paint Bldgs 1 & 2 only' }));
    expect(a).not.toBe(b);

    await runImport(batch(1));
    expect(fake.rows.size).toBe(1);
    expect(fake.rows.has(a)).toBe(true);
  });

  test('the same QB row on two different jobs stays two rows', async () => {
    fake = makeFakeDb([CITI_LAKES, 'j_other']);
    global.__qbFakeClient = fake.client;

    await runImport({
      reportDate: '2026-08-13',
      jobs: [
        { jobId: CITI_LAKES, lines: [line(0)] },
        { jobId: 'j_other', lines: [line(0)] }
      ]
    });

    expect(fake.rows.size).toBe(2);
  });
});

describe('POST /api/qb-costs/import — rejections carry a reason', () => {
  test('a job the server does not have is reported, not swallowed', async () => {
    const res = await runImport({
      reportDate: '2026-08-13',
      jobs: [
        { jobId: CITI_LAKES, lines: [line(0), line(1)] },
        { jobId: 'j_deleted_last_week', lines: [line(2), line(3), line(4)] }
      ]
    });

    expect(res.body.inserted).toBe(2);
    expect(res.body.skipped).toBe(3);
    expect(res.body.received).toBe(5);
    expect(res.body.rejected).toHaveLength(1);
    expect(res.body.rejected[0].jobId).toBe('j_deleted_last_week');
    expect(res.body.rejected[0].lines).toBe(3);
    expect(res.body.rejected[0].reason).toMatch(/no job with this id exists/i);
    // The good job still wrote — a bad entry does not take the batch down.
    expect(fake.rows.size).toBe(2);
  });

  test('an unparseable amount is named instead of stored as NaN', async () => {
    const res = await runImport({
      reportDate: '2026-08-13',
      jobs: [{ jobId: CITI_LAKES, lines: [line(0), line(1, { amount: 'twelve thousand' })] }]
    });

    expect(res.body.inserted).toBe(1);
    expect(res.body.skipped).toBe(1);
    expect(res.body.rejected[0].reason).toMatch(/amount is not a number/i);
    expect(res.body.rejected[0].reason).toContain('twelve thousand');
    expect(fake.rows.size).toBe(1);
    // Nothing NaN reached the table.
    for (const row of fake.rows.values()) expect(Number.isFinite(Number(row.amount))).toBe(true);
  });

  test('an empty or missing amount still stores as 0.00, as it always did', async () => {
    const res = await runImport({
      reportDate: '2026-08-13',
      jobs: [{ jobId: CITI_LAKES, lines: [line(0, { amount: '' }), line(1, { amount: null })] }]
    });

    expect(res.body.inserted).toBe(2);
    expect(res.body.skipped).toBe(0);
    for (const row of fake.rows.values()) expect(row.amount).toBe(0);
  });

  test('a malformed batch entry is reported by reason', async () => {
    const res = await runImport({
      reportDate: '2026-08-13',
      jobs: [{ jobId: null, lines: [line(0)] }]
    });

    expect(res.body.inserted).toBe(0);
    expect(res.body.skipped).toBe(1);
    expect(res.body.rejected[0].reason).toMatch(/malformed batch entry/i);
  });

  test('received counts what arrived, so a truncated body is detectable', async () => {
    const res = await runImport(batch(17));
    expect(res.body.received).toBe(17);
  });
});

describe('POST /api/qb-costs/import — credits', () => {
  test('a credit keeps its sign and retires the pre-fix $0.00 twin', async () => {
    // The old parser read "(850.00)" as 0 and stored the line under the
    // hash of amount 0. The corrected line hashes differently, so the
    // upsert cannot reach the stale row — the import deletes it by name.
    const credit = line(9, { amount: -850, memo: 'Supplier refund' });
    const staleId = hashLineId(CITI_LAKES, Object.assign({}, credit, { amount: 0 }));

    // Seed the phantom row the way the pre-fix import left it.
    fake.rows.set(staleId, { id: staleId, job_id: CITI_LAKES, amount: 0 });

    const res = await runImport({
      reportDate: '2026-08-13',
      jobs: [{ jobId: CITI_LAKES, lines: [credit] }]
    });

    expect(res.body.inserted).toBe(1);
    expect(res.body.cleaned).toBe(1);
    expect(fake.rows.has(staleId)).toBe(false);
    expect(fake.rows.size).toBe(1);
    expect([...fake.rows.values()][0].amount).toBe(-850);
  });
});
