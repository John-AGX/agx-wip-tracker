// test/co-rest-line-identity.test.js — the two REST doors that actually
// STORE a change order's lines, driven for real.
//
// A source assertion that `stampCoLineIds` appears in the handler proves the
// call is written, not that the row that lands in Postgres carries ids. These
// two handlers are the ones John's live CO-0001 came through — the bulk PDF
// importer POSTs here, the editor's autosave PUTs here — and a line stored
// without an id is silently uneditable in the CO editor (see
// co-line-identity.test.js for that mechanism). So the property is asserted
// against the JSON handed to the INSERT / UPDATE.
//
// The handlers hold their own inlined copy of the data cleaner rather than
// calling jobFin.cleanCoData — drift this repo already carries — which is
// exactly why each door is driven separately instead of one being taken as
// evidence for the other.

let db;

jest.mock('../server/db', () => ({
  pool: {
    connect: async () => ({ query: async (s, p) => global.__coDb.query(s, p), release() {} }),
    query: async (s, p) => global.__coDb.query(s, p),
  },
}));

jest.mock('../server/auth', () => ({
  requireAuth: (req, res, next) => next(),
  requireOrg: (req, res, next) => next(),
  requireOrgId: (req, res, next) => { req.orgId = 1; next(); },
  requireRole: () => (req, res, next) => next(),
  requireCapability: () => (req, res, next) => next(),
  resolveOrgId: (req, res, next) => next(),
  hasCapability: () => true,
  isAdminish: () => true,
}));

const coRouter = require('../server/routes/change-order-routes');

function handlerFor(router, method, routePath) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(method.toUpperCase() + ' ' + routePath + ' not found');
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function makeDb(existing) {
  const state = { written: null, calls: [] };
  state.query = async (sql, params) => {
    const s = String(sql);
    state.calls.push(s.replace(/\s+/g, ' ').trim());
    if (/INSERT INTO job_change_orders/.test(s)) {
      state.written = JSON.parse(params[4]);
      return { rowCount: 1, rows: [{ id: 'co_1', job_id: 'job1', status: 'draft',
        co_number: 'CO-0001', data: state.written }] };
    }
    if (/UPDATE job_change_orders/.test(s)) {
      state.written = JSON.parse(params[0]);
      return { rowCount: 1, rows: [{ id: 'co_1', job_id: 'job1', status: 'draft',
        co_number: 'CO-0001', data: state.written }] };
    }
    if (/SELECT co\.status/.test(s)) {
      return { rowCount: 1, rows: [existing || { status: 'draft', is_locked: false }] };
    }
    if (/FROM jobs WHERE id/.test(s)) return { rowCount: 1, rows: [{ id: 'job1' }] };
    if (/co_number/.test(s)) return { rowCount: 0, rows: [] };
    return { rowCount: 0, rows: [] };
  };
  return state;
}

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.body = p; return res; };
  res.end = () => res;
  return res;
}

const user = { id: 'u1', role: 'admin', organization_id: 1 };

async function post(body) {
  db = makeDb(); global.__coDb = db;
  const res = fakeRes();
  await handlerFor(coRouter, 'post', '/jobs/:jobId/change-orders')(
    { params: { jobId: 'job1' }, body, user, orgId: 1 }, res);
  return { res, stored: db.written };
}

async function put(body, existing) {
  db = makeDb(existing); global.__coDb = db;
  const res = fakeRes();
  await handlerFor(coRouter, 'put', '/change-orders/:id')(
    { params: { id: 'co_1' }, body, user, orgId: 1 }, res);
  return { res, stored: db.written };
}

// The line shapes the two machine producers emit, verbatim.
const IMPORTER_LINES = [
  { description: 'Gutters — Buildertrend Flat Rate', qty: 1, unitCost: 2750, unitSell: 2750, costPending: true },
  { description: 'Soffit — Buildertrend Flat Rate', qty: 1, unitCost: 1800, unitSell: 1800, costPending: true },
  { description: 'Fascia — Buildertrend Flat Rate', qty: 1, unitCost: 3200, unitSell: 3200, costPending: true },
];

function addressable(lines) {
  return lines.every((l) => l.id != null && String(l.id) !== '')
    && new Set(lines.map((l) => String(l.id))).size === lines.length;
}

describe('POST /api/jobs/:jobId/change-orders — the bulk PDF importer door', () => {
  test('the stored lines are addressable', async () => {
    const { res, stored } = await post({ title: 'CO', lines: IMPORTER_LINES });
    expect(res.statusCode).toBe(200);
    expect(stored.lines).toHaveLength(3);
    expect(addressable(stored.lines)).toBe(true);
  });

  test('stamping moved no money — the numbers are byte-identical', async () => {
    const { stored } = await post({ title: 'CO', lines: IMPORTER_LINES });
    expect(stored.lines.map((l) => [l.qty, l.unitCost, l.unitSell, l.costPending]))
      .toEqual(IMPORTER_LINES.map((l) => [l.qty, l.unitCost, l.unitSell, l.costPending]));
  });

  test('a line that already has an id keeps it', async () => {
    const { stored } = await post({ lines: [{ id: 'keep', qty: 1, unitCost: 5 }] });
    expect(stored.lines[0].id).toBe('keep');
  });

  test('an empty change order still stores lines: []', async () => {
    const { stored } = await post({ title: 'CO' });
    expect(stored.lines).toEqual([]);
  });
});

describe('PUT /api/change-orders/:id — the editor autosave door', () => {
  test('the stored lines are addressable', async () => {
    const { res, stored } = await put({ title: 'CO', lines: IMPORTER_LINES });
    expect(res.statusCode).toBe(200);
    expect(addressable(stored.lines)).toBe(true);
  });

  test('a duplicate id is re-minted rather than stored twice', async () => {
    const { stored } = await put({ lines: [
      { id: 'x', qty: 1, unitCost: 900 },
      { id: 'x', qty: 1, unitCost: 2750 },
    ] });
    expect(addressable(stored.lines)).toBe(true);
    expect(stored.lines.map((l) => l.unitCost)).toEqual([900, 2750]);
  });

  test('the applied / locked refusals still hold — identity is not a bypass', async () => {
    const applied = await put({ lines: IMPORTER_LINES }, { status: 'applied', is_locked: false });
    expect(applied.res.statusCode).toBe(409);
    expect(applied.stored).toBeNull();
    const locked = await put({ lines: IMPORTER_LINES }, { status: 'approved', is_locked: true });
    expect(locked.res.statusCode).toBe(409);
    expect(locked.stored).toBeNull();
  });
});
