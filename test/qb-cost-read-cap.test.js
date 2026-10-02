// THE ORG-WIDE COST READ IS CAPPED, AND IT HAS TO SAY SO.
//
// GET /api/qb-costs with no jobId is the SOLE source of Actual Cost on the
// jobs list, the WIP and the cost buckets — js/app.js hydrates
// appData.qbCostLines from it once at boot and every figure is computed from
// that array. It carried a bare LIMIT 5000 and returned no signal, so the
// row after the five-thousandth simply did not exist as far as the app was
// concerned: every job's actual cost reads low, by an unknown amount, with
// nothing on screen to say so. AGX was at ~3,693 rows growing ~137 a week.
//
// Two things are pinned here:
//   1. The cap is raised to match the bills fetch that loads beside it.
//   2. Truncation is a FACT the server reports, not an inference the client
//      has to make from rows.length === cap — which cannot tell a full page
//      from an exact fit. The route asks for cap+1 and trims.
//
// The per-job read stays uncapped on purpose: one job cannot be big enough
// to matter, and that is the query the QB tab re-pulls to repair itself.

// jest hoists the mock factory above every declaration, so its state has to
// wear the mock- prefix to be reachable from inside it.
const mockState = { sql: null, params: null, rows: [] };

jest.mock('../server/db', () => ({
  pool: {
    connect: async () => { throw new Error('not used by the read path'); },
    query: async (sql, params) => {
      mockState.sql = String(sql);
      mockState.params = params;
      return { rows: mockState.rows, rowCount: mockState.rows.length };
    }
  }
}));
jest.mock('../server/auth', () => ({
  requireAuth: (req, res, next) => next(),
  requireCapability: () => (req, res, next) => next(),
  requireOrgId: (req, res, next) => { req.orgId = 7; next(); }
}));

const router = require('../server/routes/qb-cost-routes');
const CAP = router.QB_LINES_CAP;

function readHandler() {
  const layer = router.stack.find((l) => l.route && l.route.path === '/' && l.route.methods.get);
  if (!layer) throw new Error('GET / route not found on the router');
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}
function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.body = p; return res; };
  return res;
}
async function get(query) {
  const res = fakeRes();
  await readHandler()({ query: query || {}, user: { organization_id: 7 }, orgId: 7 }, res);
  return res;
}
const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: 'qbc_' + i, amount: 1 }));

beforeEach(() => { mockState.sql = null; mockState.params = null; mockState.rows = []; });

describe('the cap', () => {
  test('is 50,000 — the same number the bills fetch beside it uses', () => {
    // js/app.js boots both in one Promise.all; a cost cap an order of
    // magnitude below the bills cap is the kind of asymmetry nobody notices
    // until the smaller one bites.
    expect(CAP).toBe(50000);
  });

  test('the query asks for one row MORE than the cap', async () => {
    mockState.rows = rows(10);
    await get({});
    expect(mockState.params).toEqual([7, CAP + 1]);
    expect(mockState.sql).toMatch(/LIMIT \$2/);
  });
});

describe('truncation is reported, not inferred', () => {
  test('an ordinary read says truncated:false and returns everything', async () => {
    mockState.rows = rows(3693);                       // AGX, 2026-10-01
    const res = await get({});
    expect(res.body.lines).toHaveLength(3693);
    expect(res.body.truncated).toBe(false);
    expect(res.body.cap).toBe(CAP);
  });

  test('EXACTLY the cap is not truncated — the boundary a length check gets wrong', async () => {
    // This is why the route asks for cap+1. Inferring truncation from
    // `rows.length === cap` would cry wolf on a table that happens to hold
    // exactly 50,000 rows, and an app that warns when it is fine gets its
    // warning ignored when it is not.
    mockState.rows = rows(CAP);
    const res = await get({});
    expect(res.body.lines).toHaveLength(CAP);
    expect(res.body.truncated).toBe(false);
  });

  test('one row over the cap IS truncated, and the extra row is trimmed off', async () => {
    mockState.rows = rows(CAP + 1);
    const res = await get({});
    expect(res.body.truncated).toBe(true);
    expect(res.body.lines).toHaveLength(CAP);    // the probe row never ships
    expect(res.body.cap).toBe(CAP);
  });

  test('the old behaviour is gone: a capped read is no longer silent', async () => {
    mockState.rows = rows(CAP + 1);
    const res = await get({});
    // Before, this was indistinguishable from a complete read.
    expect(res.body).toHaveProperty('truncated');
    expect(res.body.truncated).not.toBe(false);
  });
});

describe('the per-job read', () => {
  test('is not capped — no LIMIT at all', async () => {
    mockState.rows = rows(5);
    await get({ jobId: 'j1' });
    expect(mockState.sql).not.toMatch(/LIMIT/i);
    expect(mockState.params).toEqual(['j1', 7]);
  });

  test('still answers the truncation question, with null for a cap it does not apply', async () => {
    // The client reads `truncated` off every response; a per-job read that
    // omitted the field would read as undefined and could be mistaken for a
    // missing answer rather than a settled one.
    mockState.rows = rows(5);
    const res = await get({ jobId: 'j1' });
    expect(res.body.truncated).toBe(false);
    expect(res.body.cap).toBe(null);
  });
});
