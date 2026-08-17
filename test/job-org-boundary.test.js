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

// The bulk save's locked read. Matched on FOR UPDATE rather than on the
// projection, so adding a column to it does not silently unhook every handler
// in this file (which is what the projection-shaped key used to do).
const LOCKED_READ = 'FOR UPDATE';

// The jobs INSERT, whichever route emitted it.
function jobInsert() {
  return queries.find((q) => /INSERT INTO jobs\b/i.test(q.sql));
}

// Any write landing on a JOB-KEYED table. The N4 property is not "the response
// said no" — it is "no write was reached". Asserting only on jobInsert() proves
// nothing about node_graphs or job_access, which is exactly how the site plan
// and the share list stayed open.
function jobKeyedWrite() {
  return queries.find((q) =>
    /\b(INSERT INTO|UPDATE|DELETE FROM)\s+(jobs|node_graphs|job_access)\b/i.test(q.sql));
}

// The source text of one top-level function, from its `async function NAME(`
// through its closing brace at column 0. CRLF-tolerant on purpose: this repo's
// server files are CRLF, and a '\n}\n' probe silently matches nothing there and
// hands back the rest of the FILE, which makes any `not.toMatch` assertion pass
// or fail on unrelated code.
function fnBody(src, name) {
  const start = src.indexOf('async function ' + name + '(');
  if (start === -1) throw new Error('no such function: ' + name);
  const rest = src.slice(start);
  const end = rest.search(/\r?\n\}\r?\n/);
  if (end === -1) throw new Error('unterminated function: ' + name);
  return rest.slice(0, end);
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
    handlers[LOCKED_READ] =() => ({ rows: [] });
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
    handlers[LOCKED_READ] =() => ({ rows: [] });
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
    handlers[LOCKED_READ] =() => ({ rows: [] });
    handlers['ON CONFLICT (id) DO UPDATE'] = () => ({ rows: [{ updated_at: new Date() }] });

    await call('PUT', '/api/jobs/bulk/save',
      { id: 10, role: 'admin', organization_id: 7 }, ONE_JOB);

    const q = jobInsert();
    // markets is stubbed to resolve nothing, yet the org still landed.
    expect(insertedValue(q, 'organization_id')).toBe(7);
    expect(insertedValue(q, 'market_id')).toBeNull();
  });

  test('ON CONFLICT never rewrites an existing row org — a save is not a tenant move', async () => {
    handlers[LOCKED_READ] =() => ({ rows: [] });
    handlers['ON CONFLICT (id) DO UPDATE'] = () => ({ rows: [{ updated_at: new Date() }] });

    await call('PUT', '/api/jobs/bulk/save',
      { id: 10, role: 'admin', organization_id: 7 }, ONE_JOB);

    // The SET list, up to the guard's own WHERE. organization_id must not be
    // assignable here — no EXCLUDED, no COALESCE, nothing — because a save that
    // could rewrite an org would make every bulk save a potential tenant move.
    // (It DOES appear in the arm's WHERE, as the second layer under the JS
    // tenant branch; that is a filter, not an assignment.)
    const doUpdate = jobInsert().sql.split(/DO UPDATE/i)[1];
    const setList = doUpdate.split(/\bWHERE\b/i)[0];
    expect(setList).not.toMatch(/organization_id/);
    expect(doUpdate).toMatch(/WHERE jobs\.organization_id = \$4 OR jobs\.organization_id IS NULL/);
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
    handlers[LOCKED_READ] =() => ({ rows: [] });
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
    handlers[LOCKED_READ] =() => ({ rows: [] });
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
    handlers[LOCKED_READ] =() => ({ rows: [] });
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
    handlers[LOCKED_READ] =() => ({
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
    handlers[LOCKED_READ] =() => ({ rows: [] });
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

/* ═══════════════════════════════════════════════════════════════════════════
 * 7. N4 — a job that belongs to ANOTHER TENANT cannot be overwritten.
 *
 *    The bulk save's locked read carried no org predicate at all, so an org-A
 *    admin reached the `DO UPDATE` arm on an org-B row and replaced its `data`
 *    blob wholesale, money included. DO UPDATE correctly leaves
 *    organization_id alone, so the row stayed org B's CARRYING ORG A's
 *    CONTENTS — and stamping the INSERT (46b63e9) removed the orphaned-NULL
 *    tell that was previously the only evidence it had happened.
 *
 *    The property asserted is not "the response said no". It is that NO WRITE
 *    WAS REACHED on any job-keyed table.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a foreign-tenant job cannot be overwritten', () => {
  const withBase = () => {
    const b = JSON.parse(JSON.stringify(ONE_JOB));
    b.baseVersions = { job_new_1: new Date('2026-01-01T00:00:00.000Z').toISOString() };
    return b;
  };

  test('the locked read reports the tenant instead of filtering on it', () => {
    // Filtering the WHERE can only say "no rows", and "no rows" already means
    // 'deleted' here (client -> unrecoverable-data-loss modal) or, with no base,
    // falls through to INSERT ... ON CONFLICT, which matches by PRIMARY KEY and
    // overwrites the foreign row anyway. The predicate has to be data the
    // branch decides on, under the same lock.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'server', 'routes', 'job-routes.js'), 'utf8');
    expect(src).toMatch(
      /SELECT owner_id, updated_at, organization_id FROM jobs WHERE id = \$1 FOR UPDATE/);
    expect(src).not.toMatch(/updated_at FROM jobs WHERE id = \$1 AND \(organization_id/);
  });

  test('org A saving an org B row: not_in_org, and the upsert is never reached', async () => {
    handlers[LOCKED_READ] = () => ({
      rows: [{ owner_id: 10, updated_at: null, organization_id: 9 }]   // org B
    });
    handlers['ON CONFLICT (id) DO UPDATE'] = () => ({ rows: [{ updated_at: new Date() }] });

    const r = await call('PUT', '/api/jobs/bulk/save',
      { id: 10, role: 'admin', organization_id: 7 }, ONE_JOB);

    expect(r.status).toBe(200);
    expect(r.body.conflicts.map((c) => c.reason)).toEqual(['not_in_org']);
    expect(r.body.count).toBe(0);
    expect(jobInsert()).toBeUndefined();
    expect(jobKeyedWrite()).toBeUndefined();
  });

  test('not_in_org is NOT deleted — the reason string is the only discriminator', async () => {
    // Both carry serverUpdatedAt: null. 'deleted' routes the client to the
    // unrecoverable-data-loss dialog; this row is alive and untouched in
    // another tenant and nothing of the caller's was lost.
    handlers[LOCKED_READ] = () => ({
      rows: [{ owner_id: 10, updated_at: null, organization_id: 9 }]
    });

    const r = await call('PUT', '/api/jobs/bulk/save',
      { id: 10, role: 'admin', organization_id: 7 }, withBase());

    expect(r.body.conflicts[0].reason).toBe('not_in_org');
    expect(r.body.conflicts[0].reason).not.toBe('deleted');
    expect(jobKeyedWrite()).toBeUndefined();
  });

  test('the client tells the two apart, and calls neither "changed by someone else"', () => {
    const app = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'js', 'app.js'), 'utf8');
    // not_in_org and invalid_owner both used to fall into isStale, which says
    // "changed by someone else — your edit was NOT saved". False about both.
    expect(app).toMatch(/c\.reason === 'not_in_org'/);
    expect(app).toMatch(/c\.reason === 'invalid_owner'/);
    expect(app).toMatch(/!isLocked\(c\) && !isUnver\(c\) && !isNotInOrg\(c\) && !isBadOwner\(c\)/);
    expect(app).toMatch(/is not in your organization/);
  });

  test('the tolerance arm is intact: a NULL-org row still saves', async () => {
    handlers[LOCKED_READ] = () => ({
      rows: [{ owner_id: 10, updated_at: null, organization_id: null }]
    });
    handlers['ON CONFLICT (id) DO UPDATE'] = () => ({ rows: [{ updated_at: new Date() }] });

    const r = await call('PUT', '/api/jobs/bulk/save',
      { id: 10, role: 'admin', organization_id: 7 }, ONE_JOB);

    expect(r.body.count).toBe(1);
    expect(r.body.conflicts).toHaveLength(0);
  });

  test('a row in the caller own org still saves', async () => {
    handlers[LOCKED_READ] = () => ({
      rows: [{ owner_id: 10, updated_at: null, organization_id: 7 }]
    });
    handlers['ON CONFLICT (id) DO UPDATE'] = () => ({ rows: [{ updated_at: new Date() }] });

    const r = await call('PUT', '/api/jobs/bulk/save',
      { id: 10, role: 'admin', organization_id: 7 }, ONE_JOB);

    expect(r.body.count).toBe(1);
    expect(r.body.conflicts).toHaveLength(0);
  });

  test('the DO UPDATE carries the guard too, and a refusal is a 500 not a silent save', async () => {
    handlers[LOCKED_READ] = () => ({ rows: [] });
    // The SQL layer refuses what the JS branch let through — they disagree.
    handlers['ON CONFLICT (id) DO UPDATE'] = () => ({ rows: [] });

    const r = await call('PUT', '/api/jobs/bulk/save',
      { id: 10, role: 'admin', organization_id: 7 }, ONE_JOB);

    // `saved++` runs unconditionally, so a filtered DO UPDATE used to be
    // counted as saved. It must not be reported as a save.
    expect(r.status).toBe(500);
    const q = jobInsert();
    expect(q.sql).toMatch(/WHERE jobs\.organization_id = \$4 OR jobs\.organization_id IS NULL/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 8. The job-keyed doors — same defect, tables the `jobs` survey never named.
 *
 *    canAccess / canEdit / canManageAccess answered `true` for any adminish
 *    caller BEFORE touching the database. So an org predicate on their `jobs`
 *    statement would have fixed nothing: for the callers that matter the
 *    statement never ran. The gates are now ORG FIRST, THEN ROLE.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('job-keyed child tables are behind the same boundary', () => {
  const FOREIGN = () => ({ rows: [{ owner_id: 10, organization_id: 9 }] });

  test('PUT /:id/graph cannot overwrite another tenant site plan', async () => {
    handlers['SELECT owner_id, organization_id FROM jobs'] = FOREIGN;
    handlers['SELECT data FROM node_graphs'] = () => ({ rows: [] });
    handlers['INSERT INTO node_graphs'] = () => ({ rowCount: 1 });

    const r = await call('PUT', '/api/jobs/jobB/graph',
      { id: 10, role: 'admin', organization_id: 7 },
      { nodes: [{ id: 'n1', polygon: [[0, 0]] }] });

    expect(r.status).toBe(403);
    expect(jobKeyedWrite()).toBeUndefined();
  });

  test('...and its DO UPDATE arm carries the guard as the second layer', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'server', 'routes', 'job-routes.js'), 'utf8');
    // lastIndexOf: /convert carries the lead's survey graph forward with the
    // same INSERT, and that one is a create with no conflict arm to guard.
    const upsert = src.slice(src.lastIndexOf('INSERT INTO node_graphs (job_id, data, organization_id)'));
    expect(upsert.slice(0, 400)).toMatch(
      /ON CONFLICT \(job_id\) DO UPDATE[\s\S]*WHERE node_graphs\.organization_id IS NULL OR node_graphs\.organization_id = \$3/);
  });

  test('GET /:id/access does not hand another tenant its staff directory', async () => {
    // The share list carries user_id, name, EMAIL and role — a cross-tenant
    // staff directory read keyed on a guessable job id.
    handlers['SELECT owner_id, organization_id FROM jobs'] = FOREIGN;
    handlers['FROM job_access ja'] = () => ({ rows: [{ user_id: 1, email: 'b@orgb.test' }] });

    const r = await call('GET', '/api/jobs/jobB/access',
      { id: 10, role: 'admin', organization_id: 7 });

    expect(r.status).toBe(403);
    expect(queries.some((q) => /FROM job_access ja/i.test(q.sql))).toBe(false);
  });

  test('POST /:id/access cannot plant a durable cross-tenant grant', async () => {
    handlers['SELECT owner_id, organization_id FROM jobs'] = FOREIGN;
    handlers['INSERT INTO job_access'] = () => ({ rows: [] });

    const r = await call('POST', '/api/jobs/jobB/access',
      { id: 10, role: 'admin', organization_id: 7 }, { userId: 55, accessLevel: 'edit' });

    expect(r.status).toBe(404);      // another tenant's job reads as absent
    expect(jobKeyedWrite()).toBeUndefined();
  });

  test('...and the GRANTEE must be in the caller org too (it was unvalidated)', async () => {
    handlers['SELECT owner_id, organization_id FROM jobs'] =
      () => ({ rows: [{ owner_id: 10, organization_id: 7 }] });   // our own job
    handlers['SELECT id FROM users WHERE id = $1 AND organization_id'] = () => ({ rows: [] });
    handlers['INSERT INTO job_access'] = () => ({ rows: [] });

    const r = await call('POST', '/api/jobs/jobA/access',
      { id: 10, role: 'admin', organization_id: 7 }, { userId: 55, accessLevel: 'edit' });

    expect(r.status).toBe(400);
    expect(jobKeyedWrite()).toBeUndefined();
  });

  test('DELETE /:id/access/:userId cannot revoke another tenant share', async () => {
    handlers['SELECT owner_id, organization_id FROM jobs'] = FOREIGN;
    handlers['DELETE FROM job_access'] = () => ({ rows: [] });

    const r = await call('DELETE', '/api/jobs/jobB/access/55',
      { id: 10, role: 'admin', organization_id: 7 }, {});

    expect(r.status).toBe(404);
    expect(jobKeyedWrite()).toBeUndefined();
  });

  test('the gates read the tenant BEFORE the role short-circuit', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'server', 'routes', 'job-routes.js'), 'utf8');
    for (const fn of ['canAccess', 'canEdit', 'canManageAccess']) {
      const head = fnBody(src, fn);
      expect(head.indexOf('orgAllows')).toBeGreaterThan(-1);
      expect(head.indexOf('isAdminish')).toBeGreaterThan(-1);
      expect(head.indexOf('orgAllows')).toBeLessThan(head.indexOf('isAdminish'));
    }
  });

  test('the caller org is never read from the body', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'server', 'routes', 'job-routes.js'), 'utf8');
    expect(fnBody(src, 'callerOrgId')).not.toMatch(/req\.body/);
  });

  test('an in-org job still reaches its own site plan', async () => {
    handlers['SELECT owner_id, organization_id FROM jobs'] =
      () => ({ rows: [{ owner_id: 10, organization_id: 7 }] });
    handlers['INSERT INTO node_graphs'] = () => ({ rowCount: 1 });

    const r = await call('PUT', '/api/jobs/jobA/graph',
      { id: 10, role: 'admin', organization_id: 7 },
      { nodes: [{ id: 'n1', polygon: [[0, 0]] }] });

    expect(r.status).toBe(200);
    expect(queries.some((q) => /INSERT INTO node_graphs/i.test(q.sql))).toBe(true);
  });

  test('a legacy NULL-org job is still reachable by everyone, as before', async () => {
    handlers['SELECT owner_id, organization_id FROM jobs'] =
      () => ({ rows: [{ owner_id: 10, organization_id: null }] });
    handlers['INSERT INTO node_graphs'] = () => ({ rowCount: 1 });

    const r = await call('PUT', '/api/jobs/jobLegacy/graph',
      { id: 10, role: 'admin', organization_id: 7 },
      { nodes: [{ id: 'n1', polygon: [[0, 0]] }] });

    expect(r.status).toBe(200);
  });
});
