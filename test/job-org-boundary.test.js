// The tenant boundary on job writes.
//
// THE DEFECT THIS FILE EXISTS FOR
// `PUT /api/jobs/bulk/save` fell through to `INSERT INTO jobs … ON CONFLICT`
// for a row the server did not have, and that INSERT never set
// organization_id. organization_id is the TENANT AND SECURITY boundary (market
// is the operating dimension and never stands in for it), and every read of
// jobs in this repo carries an `OR organization_id IS NULL` tolerance arm — so
// the un-stamped row was not hidden from everyone, it was visible to EVERY
// org, dragging its change orders, POs, bills and pay apps across the boundary
// with it.
//
// WHY THE ROUTER IS MOUNTED FOR REAL
// The properties under test are properties of the MIDDLEWARE CHAIN and of the
// exact SQL the handler emits — "refused before anything is written" is not
// observable from the handler body alone, and a source-grep cannot tell a
// stamped INSERT from one whose parameter is undefined. So the real router
// runs on a real express app behind real requireAuth/requireOrgId, over the
// wire, against a pool that records every statement.
//
// The pool is a recorder, not a database: assertions are on the statements and
// their bound parameters. Anything that needs a database to be true is called
// out as such in the report rather than faked here.

const express = require('express');
const http = require('http');

let queries;          // every statement the route emitted, in order
let handlers;         // sql-substring -> (sql, params) => rows

jest.mock('../server/db', () => ({
  pool: {
    query: async (sql, params) => mockRunQuery(sql, params),
    connect: async () => ({
      query: async (sql, params) => mockRunQuery(sql, params),
      release: () => {}
    })
  }
}));

// Markets is the OPERATING dimension. It is stubbed to a fixed answer here so
// that if the fix ever tried to derive tenancy from it, the org assertions
// below would not be able to pass by accident.
jest.mock('../server/services/markets', () => ({
  loadMarketMap: async () => ({ byName: {} }),
  resolveMarketId: () => null
}));

jest.mock('../server/email', () => ({ sendEmail: async () => ({}) }));

function mockRunQuery(sql, params) {
  const text = String(sql);
  queries.push({ sql: text, params: params || [] });
  for (const key of Object.keys(handlers)) {
    if (text.includes(key)) return handlers[key](text, params || []);
  }
  return { rows: [] };
}

const { signToken, setRolePool } = require('../server/auth');
const jobRoutes = require('../server/routes/job-routes');

// index.js does this at boot (setRolePool(pool)). It is what lets the legacy-
// token fallback read the users row; without it resolveOrgId cannot answer at
// all, which is a different outcome and has its own test below.
setRolePool(require('../server/db').pool);

let server, baseUrl;

beforeAll((done) => {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use('/api/jobs', jobRoutes);
  server = http.createServer(app);
  server.listen(0, '127.0.0.1', () => {
    baseUrl = 'http://127.0.0.1:' + server.address().port;
    done();
  });
});

afterAll((done) => { server.close(() => done()); });

beforeEach(() => {
  queries = [];
  handlers = {};
});

function tokenFor(user) {
  return signToken(Object.assign({ id: 10, email: 'a@b.c', role: 'admin', name: 'A' }, user));
}

async function call(method, path, user, body) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + tokenFor(user)
    },
    body: JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* non-JSON body */ }
  return { status: res.status, body: json };
}

// The jobs INSERT, whichever route emitted it.
function jobInsert() {
  return queries.find((q) => /INSERT INTO jobs\b/i.test(q.sql));
}

// Bind an INSERT's column list to its parameters, so a test can ask what value
// actually landed in a column rather than trusting the SQL text.
function insertedValue(q, column) {
  const cols = q.sql.match(/INSERT INTO \w+ \(([^)]+)\)/i)[1]
    .split(',').map((c) => c.trim());
  const idx = cols.indexOf(column);
  if (idx === -1) return undefined;
  // Column N binds $N for these statements (all use positional $1..$n in order).
  return q.params[idx];
}

const ONE_JOB = {
  appData: {
    jobs: [{ id: 'job_new_1', name: 'New job', contractAmount: 250000 }],
    buildings: [], phases: [], changeOrders: [], subs: [],
    purchaseOrders: [], invoices: []
  },
  baseVersions: {}   // no base => this is a CREATE, the path that inserts
};

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. A new job carries the caller's org.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a new job carries the caller org', () => {
  test('bulk save stamps organization_id from the token, not from the body', async () => {
    handlers['SELECT owner_id, updated_at FROM jobs'] = () => ({ rows: [] });
    handlers['ON CONFLICT (id) DO UPDATE'] = () => ({ rows: [{ updated_at: new Date() }] });

    const r = await call('PUT', '/api/jobs/bulk/save',
      { id: 10, role: 'admin', organization_id: 7 }, ONE_JOB);

    expect(r.status).toBe(200);
    const q = jobInsert();
    expect(q).toBeDefined();
    expect(q.sql).toMatch(/INSERT INTO jobs \([^)]*\borganization_id\b/i);
    expect(insertedValue(q, 'organization_id')).toBe(7);
  });

  test('an organization_id in the request body cannot become the row org', async () => {
    handlers['SELECT owner_id, updated_at FROM jobs'] = () => ({ rows: [] });
    handlers['ON CONFLICT (id) DO UPDATE'] = () => ({ rows: [{ updated_at: new Date() }] });

    const body = JSON.parse(JSON.stringify(ONE_JOB));
    body.appData.jobs[0].organization_id = 999;   // a forged boundary
    body.organization_id = 999;

    await call('PUT', '/api/jobs/bulk/save',
      { id: 10, role: 'admin', organization_id: 7 }, body);

    const q = jobInsert();
    expect(insertedValue(q, 'organization_id')).toBe(7);
    // …and it must not survive inside the JSONB either, where it would shadow
    // the column for anything reading the blob.
    const blob = JSON.parse(insertedValue(q, 'data'));
    expect(blob.organization_id).toBeUndefined();
  });

  test('the org is NOT derived from market — market is the operating dimension', async () => {
    handlers['SELECT owner_id, updated_at FROM jobs'] = () => ({ rows: [] });
    handlers['ON CONFLICT (id) DO UPDATE'] = () => ({ rows: [{ updated_at: new Date() }] });

    await call('PUT', '/api/jobs/bulk/save',
      { id: 10, role: 'admin', organization_id: 7 }, ONE_JOB);

    const q = jobInsert();
    // markets is stubbed to resolve nothing, yet the org still landed.
    expect(insertedValue(q, 'organization_id')).toBe(7);
    expect(insertedValue(q, 'market_id')).toBeNull();
  });

  test('ON CONFLICT never rewrites an existing row org — a save is not a tenant move', async () => {
    handlers['SELECT owner_id, updated_at FROM jobs'] = () => ({ rows: [] });
    handlers['ON CONFLICT (id) DO UPDATE'] = () => ({ rows: [{ updated_at: new Date() }] });

    await call('PUT', '/api/jobs/bulk/save',
      { id: 10, role: 'admin', organization_id: 7 }, ONE_JOB);

    const doUpdate = jobInsert().sql.split(/DO UPDATE/i)[1];
    expect(doUpdate).not.toMatch(/organization_id/);
    // market_id, by contrast, SHOULD be updatable — a market can change.
    expect(doUpdate).toMatch(/market_id = COALESCE/i);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. A write that cannot determine an org is REFUSED, with a named error.
 *    Not inserted NULL, and not "carried on quietly".
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a write with no determinable org is refused', () => {
  test('bulk save: named ORG_UNRESOLVED, and nothing is written', async () => {
    handlers['SELECT organization_id FROM users'] = () => ({ rows: [{ organization_id: null }] });

    const r = await call('PUT', '/api/jobs/bulk/save',
      { id: 10, role: 'admin', organization_id: null }, ONE_JOB);

    expect(r.body.code).toBe('ORG_UNRESOLVED');
    expect(r.status).toBe(409);
    expect(jobInsert()).toBeUndefined();
    // Refused BEFORE the transaction — no row was ever locked.
    expect(queries.some((q) => /FOR UPDATE/i.test(q.sql))).toBe(false);
    expect(queries.some((q) => /^BEGIN$/i.test(q.sql.trim()))).toBe(false);
  });

  test('POST /api/jobs and /convert refuse the same way', async () => {
    handlers['SELECT organization_id FROM users'] = () => ({ rows: [{ organization_id: null }] });

    const post = await call('POST', '/api/jobs',
      { id: 10, role: 'admin', organization_id: null }, { name: 'x' });
    expect(post.status).toBe(409);
    expect(post.body.code).toBe('ORG_UNRESOLVED');

    queries = [];
    const conv = await call('POST', '/api/jobs/convert',
      { id: 10, role: 'admin', organization_id: null },
      { lead_id: 'lead_1', job: { jobNumber: 'S1234' } });
    expect(conv.status).toBe(409);
    expect(conv.body.code).toBe('ORG_UNRESOLVED');
    expect(jobInsert()).toBeUndefined();
  });

  test('a legacy token with no org claim resolves from the users row and proceeds', async () => {
    // The fallback exists so tokens minted before the column did still work.
    // It reads the VERIFIED user id — never anything from the request.
    handlers['SELECT organization_id FROM users'] = (sql, params) => {
      expect(params[0]).toBe(10);           // the token subject, not a body field
      return { rows: [{ organization_id: 42 }] };
    };
    handlers['SELECT owner_id, updated_at FROM jobs'] = () => ({ rows: [] });
    handlers['ON CONFLICT (id) DO UPDATE'] = () => ({ rows: [{ updated_at: new Date() }] });

    const r = await call('PUT', '/api/jobs/bulk/save',
      { id: 10, role: 'admin', organization_id: null }, ONE_JOB);

    expect(r.status).toBe(200);
    expect(insertedValue(jobInsert(), 'organization_id')).toBe(42);
  });

  test('a DB failure during org resolution is retryable, NOT a permission verdict', async () => {
    // "I cannot tell whether this user has an org" is not "this user has no
    // org", and only one of those is the caller's fault. A bare 403 here would
    // train the client to give up on a pool blip — on the app's hottest write,
    // which holds FOR UPDATE on ~25 rows and has a deadlock history.
    handlers['SELECT organization_id FROM users'] = () => { throw new Error('pool exhausted'); };

    const r = await call('PUT', '/api/jobs/bulk/save',
      { id: 10, role: 'admin', organization_id: null }, ONE_JOB);

    expect(r.status).toBe(503);
    expect(r.body.code).toBe('ORG_LOOKUP_FAILED');
    expect(r.body.code).not.toBe('ORG_UNRESOLVED');
    expect(jobInsert()).toBeUndefined();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. owner_id is a SECOND tenancy pointer, and it comes from the body.
 *    org-access.js scopes a job by owner_id -> users.organization_id, so
 *    stamping only the column would leave the other source caller-chosen —
 *    and a column/owner disagreement is invisible to a NULL check, to a future
 *    NOT NULL, and to dropping the IS-NULL tolerance.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('owner_id cannot point a new job at another tenant', () => {
  test('an owner outside the caller org is refused, not written', async () => {
    handlers['SELECT id FROM users WHERE id = ANY'] = () => ({ rows: [] });  // not in org
    handlers['SELECT owner_id, updated_at FROM jobs'] = () => ({ rows: [] });
    handlers['ON CONFLICT (id) DO UPDATE'] = () => ({ rows: [{ updated_at: new Date() }] });

    const body = JSON.parse(JSON.stringify(ONE_JOB));
    body.appData.jobs[0].owner_id = 999;    // a user in some other org

    const r = await call('PUT', '/api/jobs/bulk/save',
      { id: 10, role: 'admin', organization_id: 7 }, body);

    expect(r.status).toBe(200);
    expect(r.body.conflicts.map((c) => c.reason)).toContain('invalid_owner');
    expect(r.body.count).toBe(0);
    expect(jobInsert()).toBeUndefined();
  });

  test('the org membership lookup binds the CALLER org', async () => {
    let seen = null;
    handlers['SELECT id FROM users WHERE id = ANY'] = (sql, params) => {
      seen = { sql, params };
      return { rows: [{ id: 999 }] };
    };
    handlers['SELECT owner_id, updated_at FROM jobs'] = () => ({ rows: [] });
    handlers['ON CONFLICT (id) DO UPDATE'] = () => ({ rows: [{ updated_at: new Date() }] });

    const body = JSON.parse(JSON.stringify(ONE_JOB));
    body.appData.jobs[0].owner_id = 999;

    await call('PUT', '/api/jobs/bulk/save',
      { id: 10, role: 'admin', organization_id: 7 }, body);

    expect(seen.sql).toMatch(/organization_id = \$2/);
    expect(seen.params[1]).toBe(7);
    // In-org owner => the write proceeds, stamped with the caller's org.
    expect(insertedValue(jobInsert(), 'owner_id')).toBe(999);
    expect(insertedValue(jobInsert(), 'organization_id')).toBe(7);
  });

  test('a routine save that merely echoes the row current owner is not an assignment', async () => {
    // Enforcing on every save would break admins editing jobs whose owner was
    // since deactivated or predates org stamping. Only creates and actual
    // owner CHANGES are validated.
    handlers['SELECT owner_id, updated_at FROM jobs'] = () => ({
      rows: [{ owner_id: 999, updated_at: null }]
    });
    handlers['SELECT id FROM users WHERE id = ANY'] = () => ({ rows: [] });  // 999 not in org
    handlers['ON CONFLICT (id) DO UPDATE'] = () => ({ rows: [{ updated_at: new Date() }] });

    const body = JSON.parse(JSON.stringify(ONE_JOB));
    body.appData.jobs[0].owner_id = 999;

    const r = await call('PUT', '/api/jobs/bulk/save',
      { id: 10, role: 'admin', organization_id: 7 }, body);

    expect(r.body.count).toBe(1);
    expect(r.body.conflicts).toHaveLength(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. The consequence: a stamped row is no longer returned to another org.
 *
 *    The `OR organization_id IS NULL` tolerance is deliberately still in place
 *    (dropping it is ~295 sites and its own reviewed change). That tolerance is
 *    exactly why an un-stamped row leaked. So the read test is run against the
 *    REAL predicate from the route, over both rows: the one this bug used to
 *    produce, and the one the fix produces.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a stamped row is scoped; an un-stamped row is the leak', () => {
  // The literal WHERE clause the jobs list uses, as a predicate.
  const listPredicate = (rowOrg, readerOrg) => rowOrg === readerOrg || rowOrg === null;

  test('the predicate is the one the route actually runs', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'server', 'routes', 'job-routes.js'), 'utf8');
    expect(src).toMatch(/WHERE j\.organization_id = \$2 OR j\.organization_id IS NULL/);
  });

  test('a NULL-org row is returned to EVERY org — the defect, stated as a test', () => {
    expect(listPredicate(null, 7)).toBe(true);
    expect(listPredicate(null, 9)).toBe(true);   // a different tenant. this is the bug.
  });

  test('a row stamped with the creator org is NOT returned to a different org', async () => {
    handlers['SELECT owner_id, updated_at FROM jobs'] = () => ({ rows: [] });
    handlers['ON CONFLICT (id) DO UPDATE'] = () => ({ rows: [{ updated_at: new Date() }] });

    await call('PUT', '/api/jobs/bulk/save',
      { id: 10, role: 'admin', organization_id: 7 }, ONE_JOB);

    const rowOrg = insertedValue(jobInsert(), 'organization_id');
    expect(rowOrg).toBe(7);
    expect(listPredicate(rowOrg, 7)).toBe(true);    // its own org still sees it
    expect(listPredicate(rowOrg, 9)).toBe(false);   // another org no longer does
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 5. The convert path still works — and its site plan is stamped too.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('convert still works', () => {
  function convertHandlers() {
    handlers['SELECT job_id, market_id FROM leads'] = () => ({
      rows: [{ job_id: null, market_id: null }]
    });
    handlers['SELECT id FROM users WHERE id = $1 AND active'] = () => ({ rows: [{ id: 10 }] });
    handlers['INSERT INTO jobs'] = () => ({ rows: [] });
    handlers['UPDATE leads'] = () => ({ rows: [] });
    handlers['UPDATE receipts'] = () => ({ rows: [] });
    handlers['INSERT INTO node_graphs'] = () => ({ rows: [] });
  }

  test('a lead converts, and the job carries the caller org', async () => {
    convertHandlers();
    const r = await call('POST', '/api/jobs/convert',
      { id: 10, role: 'admin', organization_id: 7 },
      { lead_id: 'lead_1', job: { jobNumber: 'S1234', name: 'Converted' } });

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const q = jobInsert();
    expect(insertedValue(q, 'organization_id')).toBe(7);
    expect(insertedValue(q, 'lead_id')).toBe('lead_1');
  });

  test('the job number guard and the double-convert guard still fire', async () => {
    convertHandlers();
    const bad = await call('POST', '/api/jobs/convert',
      { id: 10, role: 'admin', organization_id: 7 },
      { lead_id: 'lead_1', job: { name: 'no number' } });
    expect(bad.status).toBe(400);

    handlers['SELECT job_id, market_id FROM leads'] = () => ({
      rows: [{ job_id: 'job_existing', market_id: null }]
    });
    const dup = await call('POST', '/api/jobs/convert',
      { id: 10, role: 'admin', organization_id: 7 },
      { lead_id: 'lead_1', job: { jobNumber: 'S1234' } });
    expect(dup.status).toBe(409);
  });

  test('the site plan carried over from the lead is stamped too', async () => {
    convertHandlers();
    await call('POST', '/api/jobs/convert',
      { id: 10, role: 'admin', organization_id: 7 },
      { lead_id: 'lead_1', job: { jobNumber: 'S1234' } });

    const g = queries.find((q) => /INSERT INTO node_graphs/i.test(q.sql));
    expect(g.sql).toMatch(/organization_id/);
    expect(g.params).toContain(7);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 6. The prerequisite: user creation must not mint org-less users.
 *    The gate above is only honest if users are born with an org — otherwise
 *    "fail closed" is a support ticket rather than a fix.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('user creation stamps an org', () => {
  const read = (p) => require('fs').readFileSync(
    require('path').join(__dirname, '..', 'server', p), 'utf8');

  test('admin user-create inserts organization_id, gated on the creator having one', () => {
    const src = read('routes/auth-routes.js');
    const stmt = src.slice(src.indexOf('INSERT INTO users'));
    expect(stmt.slice(0, 200)).toMatch(/organization_id/);
    expect(src).toMatch(/router\.post\('\/register',\s*requireAuth,\s*requireOrgId/);
    // from the creating admin's resolved org, never from the request body
    expect(stmt.slice(0, 400)).toMatch(/req\.orgId/);
    expect(stmt.slice(0, 400)).not.toMatch(/req\.body\.organization_id/);
  });

  test('the boot admin seeds stamp an org, and only when there is exactly one', () => {
    const src = read('db.js');
    const seed = src.slice(src.indexOf("VALUES ($1, $2, 'Admin', 'admin'"));
    expect(seed.slice(0, 500)).toMatch(/organization_id/);
    // never a guess: one live org, or nothing
    expect(seed.slice(0, 500))
      .toMatch(/SELECT COUNT\(\*\) FROM organizations WHERE archived_at IS NULL\) = 1/);
    // and an existing admin keeps whatever org it already has
    expect(seed.slice(0, 700)).toMatch(/COALESCE\(users\.organization_id/);
  });

  test('the sub-portal claim derives its org from evidence, never a fallback pick', () => {
    const src = read('routes/sub-portal-routes.js');
    expect(src).toMatch(/s\.organization_id AS sub_org_id/);
    expect(src).toMatch(/cu\.organization_id AS inviter_org_id/);
    const stmt = src.slice(src.indexOf("INSERT INTO users (email, password_hash, name, role, sub_id"));
    expect(stmt.slice(0, 300)).toMatch(/organization_id/);
    // no ORDER BY id LIMIT 1 style "pick the first org" anywhere in this path
    expect(src).not.toMatch(/ORDER BY u\.id ASC\s+LIMIT 1/);
  });
});
