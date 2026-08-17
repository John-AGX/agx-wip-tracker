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
// primary key Postgres uses. Recognises the statements the import issues
// and mimics ON CONFLICT (id) DO UPDATE ... RETURNING (xmax = 0).
//
// It is also genuinely TRANSACTIONAL — BEGIN snapshots, COMMIT publishes,
// ROLLBACK discards. That is not decoration: the import now retries a
// chunk that deadlocks, and a retry is only safe if the failed attempt's
// writes really disappear. A fake that kept them would let a chunk which
// died halfway come back as "already on file" on the retry, quietly
// turning the double-count guard into a no-op.
//
// opts.failInsert(attempt, seqWithinAttempt) -> Error | null lets a test
// make Postgres lose a lock race at a chosen point.
function makeFakeDb(existingJobIds, opts) {
  const cfg = opts || {};
  const jobIds = new Set(existingJobIds);
  const rows = new Map();   // id -> stored row (COMMITTED state)
  const log = [];
  const insertOrder = [];   // every INSERT the fake saw, in order, per attempt

  let staged = null;        // uncommitted overlay, or null outside a txn
  let attempt = 0;          // BEGINs seen
  let seq = 0;              // statements within the current attempt

  const view = () => (staged || rows);

  const client = {
    released: false,
    releases: 0,
    async query(sql, params) {
      const text = String(sql);
      const head = text.trim();
      log.push(head.split('\n')[0].trim());

      if (/^BEGIN/i.test(head)) { staged = new Map(rows); attempt++; seq = 0; return { rows: [], rowCount: 0 }; }
      if (/^COMMIT/i.test(head)) {
        if (staged) { rows.clear(); for (const [k, v] of staged) rows.set(k, v); }
        staged = null;
        return { rows: [], rowCount: 0 };
      }
      if (/^ROLLBACK/i.test(head)) { staged = null; return { rows: [], rowCount: 0 }; }

      if (/SELECT id FROM jobs/i.test(text)) {
        const ids = (params && params[0]) || [];
        const hit = ids.filter((id) => jobIds.has(id)).map((id) => ({ id }));
        return { rows: hit, rowCount: hit.length };
      }

      if (/INSERT INTO qb_cost_lines/i.test(text)) {
        seq++;
        if (cfg.failInsert) {
          const err = cfg.failInsert(attempt, seq);
          if (err) throw err;
        }
        const [id, jobId, vendor, txnDate, txnType, num, account, accountType,
          klass, memo, amount, raw, sourceFile, reportDate] = params;
        const store = view();
        const isNew = !store.has(id);
        insertOrder.push({ id, jobId, attempt });
        store.set(id, {
          id, job_id: jobId, vendor, txn_date: txnDate, txn_type: txnType, num,
          account, account_type: accountType, klass, memo, amount,
          raw_data: raw, source_file: sourceFile, report_date: reportDate
        });
        return { rows: [{ inserted: isNew }], rowCount: 1 };
      }

      if (/DELETE FROM qb_cost_lines/i.test(text)) {
        const [id, jobId] = params;
        const store = view();
        const hit = store.get(id);
        if (hit && hit.job_id === jobId && Number(hit.amount) === 0) {
          store.delete(id);
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      throw new Error('fake db: unhandled SQL — ' + text.slice(0, 80));
    },
    release() { this.released = true; this.releases++; }
  };

  return { client, rows, log, insertOrder, attempts: () => attempt };
}

// The SQLSTATE Postgres raises when it picks a deadlock victim.
function deadlock() {
  const e = new Error('deadlock detected');
  e.code = '40P01';
  return e;
}

let fake;

// qb-cost-routes.js destructures `pool` at require time, so the mock's pool
// has to be one stable object whose connect() resolves the CURRENT fake.
// pool.query is the job-existence pre-check, which runs outside any txn.
jest.mock('../server/db', () => ({
  pool: {
    connect: async () => global.__qbFakeClient,
    query: async (sql, params) => global.__qbFakeClient.query(sql, params)
  }
}));

jest.mock('../server/auth', () => ({
  requireAuth: (req, res, next) => next(),
  requireCapability: () => (req, res, next) => next(),
  // The real one refuses, before anything is written, a write whose tenant
  // cannot be determined; that refusal has its own coverage. Here it is a
  // pass-through so these cases measure the import's OWN behaviour.
  requireOrgId: (req, res, next) => { req.orgId = 7; next(); }
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
  // req.orgId is what requireOrgId sets and what the job gate now binds.
  await importHandler()({ body, orgId: 7 }, res);
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

// ── The deadlock ─────────────────────────────────────────────────────
// Once the client started delivering correctly, the 08.13.26 import got
// as far as POSTing 1205 matched rows — and Postgres answered `40P01
// deadlock detected`. One BEGIN around 1205 sequential upserts held a
// FOR KEY SHARE lock (via the qb_cost_lines → jobs FK check) on ~25 jobs
// rows for the length of the batch, while PUT /api/jobs/bulk/save — which
// the importer's own client fires 600ms earlier — took FOR UPDATE on the
// same rows in a different order. The import lost and rolled back: 1205
// in, 0 written.
//
// The write is now ordered, chunked, and retried. These pin the three
// properties that makes safe, and the fourth that keeps it honest.
describe('POST /api/qb-costs/import — deadlock survival', () => {
  test('a chunk that deadlocks is retried and lands', async () => {
    // Lose the lock race partway through the first attempt.
    fake = makeFakeDb([CITI_LAKES], {
      failInsert: (attempt, seq) => (attempt === 1 && seq === 3 ? deadlock() : null)
    });
    global.__qbFakeClient = fake.client;

    const res = await runImport(batch(5));

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.inserted).toBe(5);
    expect(fake.rows.size).toBe(5);
    expect(res.body.failed).toBe(0);
    expect(res.body.rejected).toEqual([]);
    // Two attempts: the one that deadlocked and the one that worked.
    expect(res.body.chunks.attempts).toBe(2);
    expect(res.body.chunks.committed).toBe(1);
    expect(res.body.chunks.failed).toBe(0);
  });

  test('the rolled-back attempt is not counted — money cannot double-count on retry', async () => {
    fake = makeFakeDb([CITI_LAKES], {
      failInsert: (attempt, seq) => (attempt === 1 && seq === 3 ? deadlock() : null)
    });
    global.__qbFakeClient = fake.client;

    const res = await runImport(batch(5));

    // The first attempt really did write two rows before it died...
    expect(fake.insertOrder.filter((x) => x.attempt === 1)).toHaveLength(2);
    // ...and they were rolled back, so the retry re-INSERTs them rather
    // than finding them already present. If the failed attempt's tally
    // leaked into the receipt this would read 7 written, or 3 written +
    // 2 "already on file". Both would be lies about what is in the table.
    expect(res.body.inserted).toBe(5);
    expect(res.body.updated).toBe(0);
    expect(res.body.received).toBe(5);
    expect(fake.rows.size).toBe(5);
  });

  test('a retried credit cleanup is counted once, not once per attempt', async () => {
    const credit = line(9, { amount: -850, memo: 'Supplier refund' });
    const staleId = hashLineId(CITI_LAKES, Object.assign({}, credit, { amount: 0 }));

    fake = makeFakeDb([CITI_LAKES], {
      failInsert: (attempt, seq) => (attempt === 1 && seq === 2 ? deadlock() : null)
    });
    global.__qbFakeClient = fake.client;
    fake.rows.set(staleId, { id: staleId, job_id: CITI_LAKES, amount: 0 });

    const res = await runImport({
      reportDate: '2026-08-13',
      jobs: [{ jobId: CITI_LAKES, lines: [credit, line(1), line(2)] }]
    });

    expect(res.body.ok).toBe(true);
    expect(res.body.cleaned).toBe(1);
    expect(fake.rows.has(staleId)).toBe(false);
  });

  test('exhausted retries are reported as failed, with the row count and the reason', async () => {
    fake = makeFakeDb([CITI_LAKES], { failInsert: () => deadlock() });
    global.__qbFakeClient = fake.client;

    const res = await runImport(batch(5));

    // Still a 200 with a full receipt — the counts ARE the error report,
    // and they are far more use than the bare `HTTP 500 — deadlock
    // detected` the importer showed on 08.13.26.
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.inserted).toBe(0);
    expect(res.body.updated).toBe(0);
    expect(res.body.failed).toBe(5);
    expect(res.body.skipped).toBe(5);
    expect(fake.rows.size).toBe(0);

    expect(res.body.rejected).toHaveLength(1);
    expect(res.body.rejected[0].jobId).toBe(CITI_LAKES);
    expect(res.body.rejected[0].lines).toBe(5);
    expect(res.body.rejected[0].reason).toMatch(/rolled back/i);
    expect(res.body.rejected[0].reason).toMatch(/40P01/);
    expect(res.body.rejected[0].reason).toMatch(/NOT stored/);
    // It has to tell the user the fix, because re-importing IS the fix.
    expect(res.body.rejected[0].reason).toMatch(/re-import/i);

    // Bounded: it does not hammer a wedged database forever.
    expect(res.body.chunks.attempts).toBe(4);
    expect(res.body.chunks.failed).toBe(1);
    expect(res.body.byJob[CITI_LAKES].failed).toBe(5);

    // The receipt's own failure test is `written + already-on-file === 0`.
    // A total write failure has to trip it, or the screen goes green.
    expect(res.body.inserted + res.body.updated).toBe(0);
  });

  test('a partial write reports as partial — never as success', async () => {
    // 250 rows = two chunks. The first commits; the second never does.
    fake = makeFakeDb([CITI_LAKES], {
      failInsert: (attempt) => (attempt >= 2 ? deadlock() : null)
    });
    global.__qbFakeClient = fake.client;

    const res = await runImport(batch(250));

    expect(res.body.ok).toBe(false);
    expect(res.body.chunks.total).toBe(2);
    expect(res.body.chunks.committed).toBe(1);
    expect(res.body.chunks.failed).toBe(1);
    // 200 landed, 50 did not, and the receipt says exactly that.
    expect(res.body.inserted).toBe(200);
    expect(res.body.failed).toBe(50);
    expect(res.body.skipped).toBe(50);
    expect(fake.rows.size).toBe(200);
    expect(res.body.rejected[0].lines).toBe(50);
    // Partial success used to be indistinguishable from success. The
    // receipt renders "imported with rejections" off a non-zero skipped,
    // so this is the number that keeps the screen honest.
    expect(res.body.skipped).toBeGreaterThan(0);
  });

  test('an error that is not a lock race is surfaced, not retried', async () => {
    const fk = new Error('insert or update on table "qb_cost_lines" violates foreign key constraint');
    fk.code = '23503';
    fake = makeFakeDb([CITI_LAKES], { failInsert: () => fk });
    global.__qbFakeClient = fake.client;

    const res = await runImport(batch(4));

    expect(res.body.ok).toBe(false);
    expect(res.body.failed).toBe(4);
    // One attempt only — retrying a constraint violation just wastes time.
    expect(res.body.chunks.attempts).toBe(1);
    expect(res.body.rejected[0].reason).toMatch(/rejected this batch/i);
    expect(res.body.rejected[0].reason).toMatch(/23503/);
  });
});

describe('POST /api/qb-costs/import — deterministic lock order', () => {
  test('rows are upserted in id order', async () => {
    const res = await runImport(batch(40));
    expect(res.body.inserted).toBe(40);

    const ids = fake.insertOrder.map((x) => x.id);
    expect(ids).toHaveLength(40);
    // The id is the content hash and the primary key. Writing in sorted
    // order is what stops two concurrent writers from taking the same
    // qb_cost_lines locks in opposite orders. File order would not be
    // sorted — the hash is unrelated to the QB report's row sequence.
    expect(ids).toEqual([...ids].sort());
  });

  test('jobs are visited in id order, whatever order the client sent them', async () => {
    fake = makeFakeDb(['j_a', 'j_b', 'j_c']);
    global.__qbFakeClient = fake.client;

    // Client order is deliberately reversed: this is the QB report's own
    // ordering, which has nothing to do with how bulk/save walks jobs.
    const res = await runImport({
      reportDate: '2026-08-13',
      jobs: [
        { jobId: 'j_c', lines: [line(1), line(2)] },
        { jobId: 'j_b', lines: [line(3), line(4)] },
        { jobId: 'j_a', lines: [line(5), line(6)] }
      ]
    });

    expect(res.body.inserted).toBe(6);
    const seen = fake.insertOrder.map((x) => x.jobId);
    // job_id leads the sort key because the FK check on jobs is the lock
    // that actually collided with PUT /api/jobs/bulk/save — which now
    // walks its own batch in ascending job id too.
    expect(seen).toEqual(['j_a', 'j_a', 'j_b', 'j_b', 'j_c', 'j_c']);
  });
});

describe('POST /api/qb-costs/import — chunking', () => {
  test('a big batch commits in chunks instead of one long transaction', async () => {
    const res = await runImport(batch(450));

    expect(res.body.inserted).toBe(450);
    expect(res.body.ok).toBe(true);
    expect(res.body.chunks.total).toBe(3);
    expect(res.body.chunks.committed).toBe(3);
    // Three real transactions. The whole point: each releases its jobs
    // locks in a fraction of a second instead of holding ~25 of them for
    // the length of the file.
    expect(fake.log.filter((l) => l === 'COMMIT')).toHaveLength(3);
    expect(fake.log.filter((l) => l === 'BEGIN')).toHaveLength(3);
    // And each chunk hands its pooled connection back.
    expect(fake.client.releases).toBe(3);
  });

  test('a re-import after a partial write finishes the job without duplicating', async () => {
    // Chunk 2 dies, so 200 of 250 rows land.
    let faulty = true;
    fake = makeFakeDb([CITI_LAKES], {
      failInsert: (attempt) => (faulty && attempt >= 2 ? deadlock() : null)
    });
    global.__qbFakeClient = fake.client;

    const first = await runImport(batch(250));
    expect(first.body.ok).toBe(false);
    expect(first.body.inserted).toBe(200);
    expect(first.body.failed).toBe(50);
    expect(fake.rows.size).toBe(200);

    // The user does what the receipt tells them: import the same file
    // again. This is the property that makes chunking safe at all —
    // giving up all-or-nothing is only acceptable because a content-hash
    // primary key means a repeat import repairs rather than duplicates.
    faulty = false;
    const second = await runImport(batch(250));

    expect(second.body.ok).toBe(true);
    expect(second.body.inserted).toBe(50);   // only the rows that never landed
    expect(second.body.updated).toBe(200);   // the rest upsert in place
    expect(second.body.failed).toBe(0);
    expect(fake.rows.size).toBe(250);        // and nothing is double-counted
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
