// test/convert-estimate-resell-guard.test.js
//
// THE INVARIANT: an estimate can be sold ONCE.
//
// POST /api/jobs/convert has always guarded the LEAD ("Lead already linked to a
// job", 409) and never the ESTIMATE. Its UPDATE stamps data.job_id
// unconditionally, so converting a second time repoints a sold estimate at the
// new job — while the ORIGINAL job's estimate_id column still names that same
// row. The first job is left sourcing its costs from an estimate that no longer
// claims it: the documented "no estimate — costs not flowing" state, except the
// chip keys on the job's own blob and so never fires. Silent.
//
// It was unreachable through the UI only because nothing could attach an
// estimate to a lead. That is no longer true — the estimate editor is gaining a
// Lead control — and the path is one click wide once it is:
//
//   _estimatesForLead (js/leads.js) filters on lead_id ALONE, with no job_id or
//   is_locked exclusion, and the convert flow AUTO-SELECTS when a lead has
//   exactly one estimate — no picker, no confirmation.
//
// So the refusal lives on the server. A client-side block is the client-only
// guard this codebase keeps re-learning; the estimate lock is likewise not a
// defence, because an admin can clear it and the convert UPDATE never reads it.
'use strict';

// The estimates row the guard reads. `soldTo` is what data->>'job_id' returns.
function makeDb({ leadJobId = null, estimateExists = true, soldTo = null }) {
  const state = { statements: [], stamped: null, released: false };

  const query = async (text, params) => {
    state.statements.push(text.replace(/\s+/g, ' ').trim().slice(0, 90));

    if (/^BEGIN|^COMMIT|^ROLLBACK/i.test(text)) return { rows: [], rowCount: 0 };
    if (/SELECT job_id, market_id FROM leads/i.test(text)) {
      return { rows: [{ job_id: leadJobId, market_id: null }], rowCount: 1 };
    }
    // The guard under test.
    if (/FROM estimates WHERE id = \$1/i.test(text) && /job_id/i.test(text)) {
      return estimateExists ? { rows: [{ job_id: soldTo }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (/SELECT .* FROM job_types|FROM org_job_types/i.test(text)) return { rows: [], rowCount: 0 };
    if (/INSERT INTO jobs/i.test(text)) return { rows: [], rowCount: 1 };
    if (/UPDATE leads SET job_id/i.test(text)) return { rows: [], rowCount: 1 };
    if (/UPDATE receipts SET/i.test(text)) return { rows: [], rowCount: 1 };
    if (/UPDATE service_tickets SET job_id/i.test(text)) return { rows: [], rowCount: 0 };
    if (/INSERT INTO node_graphs/i.test(text)) return { rows: [], rowCount: 1 };
    if (/UPDATE estimates SET data/i.test(text)) {
      state.stamped = params;               // the write the guard must prevent
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT 1 FROM jobs/i.test(text)) return { rows: [{}], rowCount: 1 };
    if (/SELECT/i.test(text)) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  };

  state.client = { query, release() { state.released = true; } };
  state.query = query;
  return state;
}

jest.mock('../server/db', () => ({
  pool: {
    connect: async () => global.__rsDb.client,
    query: async (sql, params) => global.__rsDb.query(sql, params),
  },
}));

jest.mock('../server/auth', () => ({
  requireAuth: (req, res, next) => next(),
  requireOrg: (req, res, next) => next(),
  requireOrgId: (req, res, next) => { req.orgId = 1; next(); },
  requireRole: () => (req, res, next) => next(),
  requireCapability: () => (req, res, next) => next(),
  resolveOrgId: (req, res, next) => next(),
  isAdminish: () => true,
}));

const jobRouter = require('../server/routes/job-routes');

function handlerFor(router, method, routePath) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === routePath && l.route.methods[method]
  );
  if (!layer) throw new Error(method.toUpperCase() + ' ' + routePath + ' not found');
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.body = p; return res; };
  res.end = () => res;
  return res;
}

async function convert(dbOpts, body) {
  const db = makeDb(dbOpts);
  global.__rsDb = db;
  const res = fakeRes();
  await handlerFor(jobRouter, 'post', '/convert')(
    {
      body: Object.assign(
        { job: { title: 'New job', jobNumber: 'S1001', jobType: 'Service' }, lead_id: 'lead-2' },
        body || {}
      ),
      user: { id: 'u1', role: 'admin', organization_id: 1 },
      orgId: 1,
    },
    res
  );
  return { res, db };
}

describe('POST /api/jobs/convert refuses to re-sell an estimate', () => {
  test('409 when the estimate is already sold to a DIFFERENT job', async () => {
    const { res, db } = await convert(
      { soldTo: 'job_ORIGINAL' },
      { estimate_id: 'est_sold' }
    );
    expect(res.statusCode).toBe(409);
    expect(String(res.body.error)).toMatch(/already been sold/i);
    // …and it names the job that owns it, so the UI can say where it went.
    expect(res.body.job_id).toBe('job_ORIGINAL');
  });

  test('the refusal happens BEFORE the estimate is re-stamped', async () => {
    // The whole point. A 409 that still wrote data.job_id would be worse than
    // no guard, because the caller would believe nothing happened.
    const { db } = await convert({ soldTo: 'job_ORIGINAL' }, { estimate_id: 'est_sold' });
    expect(db.stamped).toBeNull();
    expect(db.statements.some((s) => /INSERT INTO jobs/i.test(s))).toBe(false);
  });

  test('an unsold estimate converts normally', async () => {
    const { res, db } = await convert({ soldTo: null }, { estimate_id: 'est_fresh' });
    expect(res.statusCode).not.toBe(409);
    expect(db.stamped).not.toBeNull();
  });

  test('an estimate with no id at all is unaffected (the pre-existing path)', async () => {
    const { res } = await convert({ soldTo: null }, {});
    expect(res.statusCode).not.toBe(409);
  });

  test('404 when the estimate does not exist in this org', async () => {
    // Same shape as the lead guard directly above it. A cross-org or deleted id
    // must not fall through to a conversion that silently stamps nothing.
    const { res } = await convert({ estimateExists: false }, { estimate_id: 'est_gone' });
    expect(res.statusCode).toBe(404);
    expect(String(res.body.error)).toMatch(/not found/i);
  });

  test('an idempotent retry of the SAME job is not refused', async () => {
    // The client may re-post a convert it already completed. Refusing that would
    // turn a harmless retry into a dead end.
    const { res } = await convert(
      { soldTo: 'job_SAME' },
      { estimate_id: 'est_sold', job: { id: 'job_SAME', title: 'J', jobNumber: 'S1002', jobType: 'Service' } }
    );
    expect(res.statusCode).not.toBe(409);
  });

  test('the lead guard still fires first and independently', async () => {
    const { res } = await convert(
      { leadJobId: 'job_LEAD_ALREADY' },
      { estimate_id: 'est_fresh' }
    );
    expect(res.statusCode).toBe(409);
    expect(String(res.body.error)).toMatch(/lead already linked/i);
  });
});
