// A privilege gate must not be settable by the privilege it gates.
//
// WHAT WAS OPEN
// `roles` has no organization_id — `name` is the primary key, the table is
// global, and auth.js `_roleCache` keys on the role NAME alone. Every door in
// role-routes.js is gated on ROLES_MANAGE, which EVERY org admin holds. Both
// write doors filtered submitted capabilities against CAPABILITY_KEYS — a list
// that INCLUDES `SYSTEM_ADMIN` — and asked nothing about the caller. So a
// plain org admin, with no SYSTEM_ADMIN of their own, could
//
//     PUT  /api/roles/admin  { capabilities: [...,'SYSTEM_ADMIN'] }   -> 200
//     POST /api/roles        { capabilities: ['SYSTEM_ADMIN'] }       -> 200
//
// and hold the capability IMMEDIATELY: each handler calls refreshRoleCache()
// itself, so the grant is live before the response is written. Because the
// table is global the grant landed for every tenant's admins at once.
//
// WHY THIS ONE AND NOT ANOTHER CAPABILITY
// SYSTEM_ADMIN is the anchor of the tenant boundary this whole wave built:
// services/user-org-scope.js:90 uses it as the audited cross-tenant crossing
// arm, requireSystemAdmin and POST /api/auth/act-as key on it, and the
// narrowed org-bucket bypass defers to it. Every other door in the wave is
// correct only for as long as this capability is hard to obtain.
//
// THE PAIR
// auth-routes.js validateRoleAssignment already refused to ASSIGN a
// SYSTEM_ADMIN-carrying role to a user unless the caller held SYSTEM_ADMIN.
// The guard existed on one side and not the other, which made the two steps a
// working escalation chain: widen the ROLE (this file's hole), which makes you
// a holder, which then satisfies the assignment guard, which pins the tier
// into a users.role value that the next boot's seed cannot undo. Both routers
// are mounted below so the chain is tested as a chain.
//
// THE OTHER DIRECTION, WHICH A ONE-SIDED FIX WOULD HAVE LEFT OPEN
// A global table makes REMOVAL an attack too: a non-holder could
// `PUT /api/roles/system_admin { capabilities: [] }` and strip the platform
// owner of the capability every cross-tenant door keys on. The rule under test
// is therefore stated on the ROLE, not on the delta — a role carrying
// SYSTEM_ADMIN before OR after the write is only writable by a holder.
//
// WHAT THIS FILE DELIBERATELY ALSO PINS AS STILL-WORKING
// The fix must not cost an org admin the role administration they legitimately
// have. `admin` does not carry SYSTEM_ADMIN (db.js: "intentionally absent"),
// so editing it, editing `pm`, and creating/deleting ordinary custom roles all
// still return 200.

const express = require('express');
const http = require('http');

let queries;
let tables;

jest.mock('../server/db', () => ({
  pool: {
    query: async (sql, params) => mockRunQuery(sql, params),
    connect: async () => ({
      query: async (sql, params) => mockRunQuery(sql, params),
      release: () => {}
    })
  },
  getOrgById: async (id) => ({ id, name: 'Org ' + id })
}));

jest.mock('../server/rate-limit', () => ({
  ipLoginLimiter: (req, res, next) => next()
}));

function rowsOf(name) { return tables[name] || []; }

// A table-backed fake, not a script of canned answers. The property under test
// is "did the capability actually land in the cache", and that is only
// meaningful if the handler's own refreshRoleCache() re-reads rows the
// handler's own INSERT/UPDATE wrote. So `roles` is real mutable state here.
function mockRunQuery(sql, params) {
  const text = String(sql).replace(/\s+/g, ' ').trim();
  const p = params || [];
  queries.push({ sql: text, params: p });

  // The cache refresh. Reads whatever the writes below have done.
  if (text.includes('SELECT name, capabilities FROM roles')) return { rows: rowsOf('roles') };

  // Both column lists, deliberately: DELETE used to read `SELECT builtin` alone
  // and now reads capabilities too. Answering only the new shape would have
  // made the fake — not the boundary — the reason a reverted DELETE failed,
  // and inflated the red count when this fix is checked for bite.
  if (/^SELECT builtin(, capabilities)? FROM roles WHERE name = \$1/.test(text)) {
    const hit = rowsOf('roles').find((r) => r.name === p[0]);
    return { rows: hit ? [{ builtin: !!hit.builtin, capabilities: hit.capabilities }] : [] };
  }
  if (/^SELECT capabilities FROM roles WHERE name = \$1/.test(text)) {
    const hit = rowsOf('roles').find((r) => r.name === p[0]);
    return { rows: hit ? [{ capabilities: hit.capabilities }] : [] };
  }
  if (/^SELECT name, label, description, builtin, capabilities/.test(text)) {
    return { rows: rowsOf('roles') };
  }
  if (/^INSERT INTO roles/.test(text)) {
    if (rowsOf('roles').some((r) => r.name === p[0])) {
      const dup = new Error('duplicate key'); dup.code = '23505'; throw dup;
    }
    tables.roles.push({
      name: p[0], label: p[1], description: p[2], builtin: false,
      capabilities: JSON.parse(p[3])
    });
    return { rows: [], rowCount: 1 };
  }
  if (/^UPDATE roles SET/.test(text)) {
    const name = p[p.length - 1];
    const hit = rowsOf('roles').find((r) => r.name === name);
    if (!hit) return { rows: [], rowCount: 0 };
    // Apply whichever columns the route actually built into the statement, in
    // the order it built them, so the fake mirrors the real write rather than
    // restating what the test hopes it did.
    let i = 0;
    if (/label = \$/.test(text))        hit.label = p[i++];
    if (/description = \$/.test(text))  hit.description = p[i++];
    if (/capabilities = \$/.test(text)) hit.capabilities = JSON.parse(p[i++]);
    return { rows: [], rowCount: 1 };
  }
  if (/^DELETE FROM roles WHERE name = \$1/.test(text)) {
    const before = tables.roles.length;
    tables.roles = tables.roles.filter((r) => r.name !== p[0]);
    return { rows: [], rowCount: before - tables.roles.length };
  }
  if (text.includes('COUNT(*)::int AS c FROM users WHERE role = $1')) {
    return { rows: [{ c: rowsOf('users').filter((u) => u.role === p[0]).length }] };
  }
  if (/^SELECT id FROM users WHERE email = \$1/.test(text)) {
    const hit = rowsOf('users').find((u) => u.email === p[0]);
    return { rows: hit ? [{ id: hit.id }] : [] };
  }
  if (/^INSERT INTO users \(email, password_hash, name, role/.test(text)) {
    const id = 1000 + tables.users.length;
    tables.users.push({ id, email: p[0], name: p[2], role: p[3], organization_id: p[5], active: true });
    return { rows: [{ id }], rowCount: 1 };
  }
  if (/^SELECT name FROM users WHERE id = \$1/.test(text)) {
    const hit = rowsOf('users').find((u) => String(u.id) === String(p[0]));
    return { rows: hit ? [{ name: hit.name }] : [] };
  }
  if (/^SELECT \* FROM users WHERE id = \$1/.test(text)) {
    const hit = rowsOf('users').find((u) => String(u.id) === String(p[0]));
    return { rows: hit ? [hit] : [] };
  }
  if (/^SELECT organization_id FROM users WHERE id = \$1/.test(text)) {
    const hit = rowsOf('users').find((u) => String(u.id) === String(p[0]));
    return { rows: hit ? [{ organization_id: hit.organization_id }] : [] };
  }
  if (/^UPDATE users SET name = \$1, role = \$2/.test(text)) {
    const hit = rowsOf('users').find((u) => String(u.id) === String(p[6]));
    if (!hit) return { rows: [], rowCount: 0 };
    hit.role = p[1];
    return { rows: [], rowCount: 1 };
  }
  if (/^INSERT INTO admin_audit_log/.test(text)) return { rows: [], rowCount: 1 };

  return { rows: [], rowCount: 0 };
}

const { signToken, setRolePool, refreshRoleCache, hasCapability } = require('../server/auth');
const { pool } = require('../server/db');

setRolePool(pool);

let server, baseUrl;

// The org admin: capability-COMPLETE for their tenant, including ROLES_MANAGE
// and USERS_MANAGE. Nothing refused below may be explained by a missing
// capability — every refusal has to be this guard.
const ORG_A_ADMIN = { id: 10, email: 'admin-a@a.test', role: 'admin', name: 'A Admin', organization_id: 1 };
const ORG_B_ADMIN = { id: 77, email: 'admin-b@b.test', role: 'admin', name: 'B Admin', organization_id: 2 };
const PLATFORM_OWNER = { id: 1, email: 'owner@p86.test', role: 'system_admin', name: 'Owner', organization_id: 1 };

const ADMIN_CAPS = [
  'JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'JOBS_DELETE', 'JOBS_GO_LIVE', 'JOBS_REASSIGN',
  'FINANCIALS_VIEW', 'PROGRESS_UPDATE', 'ESTIMATES_VIEW', 'ESTIMATES_EDIT',
  'LEADS_VIEW', 'LEADS_EDIT', 'USERS_MANAGE', 'ROLES_MANAGE',
  'INSIGHTS_VIEW', 'ADMIN_METRICS'
];

function freshTables() {
  return {
    roles: [
      // Mirrors db.js BUILTIN_ROLES, including the omission that matters:
      // `admin` carries ROLES_MANAGE and NOT SYSTEM_ADMIN.
      { name: 'system_admin', label: 'System Admin', builtin: true,
        capabilities: ADMIN_CAPS.concat(['SYSTEM_ADMIN']) },
      { name: 'admin', label: 'Org Admin', builtin: true, capabilities: ADMIN_CAPS.slice() },
      { name: 'pm', label: 'Project Manager', builtin: true,
        capabilities: ['JOBS_VIEW_ALL', 'JOBS_EDIT_OWN', 'LEADS_VIEW', 'LEADS_EDIT'] },
      // A CUSTOM role carrying SYSTEM_ADMIN — created by a holder, for a second
      // platform operator. Not builtin, so DELETE can actually reach it.
      { name: 'platform_ops', label: 'Platform Ops', builtin: false,
        capabilities: ['USERS_MANAGE', 'SYSTEM_ADMIN'] },
      { name: 'scratch', label: 'Scratch', builtin: false, capabilities: ['LEADS_VIEW'] }
    ],
    users: [
      { id: 1, email: 'owner@p86.test', name: 'Owner', role: 'system_admin', organization_id: 1, active: true },
      { id: 10, email: 'admin-a@a.test', name: 'A Admin', role: 'admin', organization_id: 1, active: true },
      { id: 11, email: 'pm-a@a.test', name: 'A PM', role: 'pm', organization_id: 1, active: true },
      { id: 77, email: 'admin-b@b.test', name: 'B Admin', role: 'admin', organization_id: 2, active: true }
    ]
  };
}

beforeAll(async () => {
  queries = []; tables = freshTables();
  await refreshRoleCache();
  const roleRoutes = require('../server/routes/role-routes');
  const authRoutes = require('../server/routes/auth-routes');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/roles', roleRoutes);
  app.use('/api/auth', authRoutes);
  await new Promise((done) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      baseUrl = 'http://127.0.0.1:' + server.address().port;
      done();
    });
  });
});

afterAll((done) => { server.close(() => done()); });

beforeEach(async () => {
  queries = [];
  tables = freshTables();
  await refreshRoleCache();
});

async function call(method, path, user, body) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + signToken(user) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { status: res.status, body: json, text };
}

function roleWrite() {
  return queries.find((q) => /^(INSERT INTO roles|UPDATE roles SET|DELETE FROM roles)/i.test(q.sql));
}
function capsOf(name) {
  const r = tables.roles.find((x) => x.name === name);
  return r ? r.capabilities : null;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. Minting it — the reported hole, on both write doors.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('an org admin cannot MINT SYSTEM_ADMIN', () => {
  test('PUT /:name may not add it to the role the caller is already standing in', async () => {
    expect(hasCapability(ORG_A_ADMIN, 'SYSTEM_ADMIN')).toBe(false);

    const r = await call('PUT', '/api/roles/admin', ORG_A_ADMIN, {
      capabilities: ADMIN_CAPS.concat(['SYSTEM_ADMIN'])
    });

    expect(r.status).toBe(403);
    // Not merely refused — nothing was written, and the cache the very next
    // request reads is unchanged. The old handler refreshed it itself, so a
    // "403 but wrote anyway" would still have been a live escalation.
    expect(roleWrite()).toBeUndefined();
    expect(capsOf('admin')).not.toContain('SYSTEM_ADMIN');
    expect(hasCapability(ORG_A_ADMIN, 'SYSTEM_ADMIN')).toBe(false);
  });

  test('POST / may not create a fresh role carrying it', async () => {
    const r = await call('POST', '/api/roles', ORG_A_ADMIN, {
      name: 'superduper', label: 'Super Duper', capabilities: ['SYSTEM_ADMIN']
    });

    expect(r.status).toBe(403);
    expect(roleWrite()).toBeUndefined();
    expect(tables.roles.find((x) => x.name === 'superduper')).toBeUndefined();
  });

  test('smuggling it in beside legitimate caps does not get it past the filter', async () => {
    const r = await call('POST', '/api/roles', ORG_A_ADMIN, {
      name: 'sneaky', label: 'Sneaky',
      capabilities: ['LEADS_VIEW', 'SYSTEM_ADMIN', 'JOBS_VIEW_ALL']
    });
    expect(r.status).toBe(403);
    expect(tables.roles.find((x) => x.name === 'sneaky')).toBeUndefined();
  });

  test('a near-miss key is dropped by the CAPABILITY_KEYS filter and grants nothing', async () => {
    // The guard runs AFTER that filter on purpose: it inspects the array that
    // is actually about to be written, so an unrecognized spelling can neither
    // smuggle the capability nor trip a false refusal.
    const r = await call('POST', '/api/roles', ORG_A_ADMIN, {
      name: 'lookalike', label: 'Lookalike',
      capabilities: ['system_admin', 'SYSTEM_ADMIN ', 'LEADS_VIEW']
    });
    expect(r.status).toBe(200);
    expect(capsOf('lookalike')).toEqual(['LEADS_VIEW']);
    await refreshRoleCache();
    expect(hasCapability({ role: 'lookalike' }, 'SYSTEM_ADMIN')).toBe(false);
  });

  test('the other tenant cannot do it either — the table is global, so this matters', async () => {
    const r = await call('PUT', '/api/roles/pm', ORG_B_ADMIN, {
      capabilities: ['JOBS_VIEW_ALL', 'SYSTEM_ADMIN']
    });
    expect(r.status).toBe(403);
    expect(capsOf('pm')).not.toContain('SYSTEM_ADMIN');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. Removing it — the side a one-directional fix would have left open.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('an org admin cannot STRIP SYSTEM_ADMIN from the platform owner', () => {
  test('PUT /:name with an empty capability array is refused', async () => {
    const r = await call('PUT', '/api/roles/system_admin', ORG_A_ADMIN, { capabilities: [] });
    expect(r.status).toBe(403);
    expect(roleWrite()).toBeUndefined();
    expect(capsOf('system_admin')).toContain('SYSTEM_ADMIN');
    expect(hasCapability(PLATFORM_OWNER, 'SYSTEM_ADMIN')).toBe(true);
  });

  test('PUT /:name omitting capabilities entirely is refused too — the ROW is off-limits', async () => {
    // Nothing in the body mentions capabilities, so a delta-shaped guard would
    // have waved this through. Relabelling the platform-owner role is not a
    // tenant admin's business either.
    const r = await call('PUT', '/api/roles/system_admin', ORG_A_ADMIN, { label: 'Definitely Not Root' });
    expect(r.status).toBe(403);
    expect(roleWrite()).toBeUndefined();
    expect(tables.roles.find((x) => x.name === 'system_admin').label).toBe('System Admin');
  });

  test('DELETE may not remove a CUSTOM role that carries it', async () => {
    // `system_admin` is builtin so DELETE never reached it. `platform_ops` is
    // not, and nobody holds it, so both existing guards would have let it go.
    const r = await call('DELETE', '/api/roles/platform_ops', ORG_A_ADMIN);
    expect(r.status).toBe(403);
    expect(roleWrite()).toBeUndefined();
    expect(capsOf('platform_ops')).toContain('SYSTEM_ADMIN');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. A holder still can. A guard that also stops the platform owner is a bug.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a SYSTEM_ADMIN holder is unaffected', () => {
  test('can grant it on an existing role', async () => {
    const r = await call('PUT', '/api/roles/pm', PLATFORM_OWNER, {
      capabilities: ['JOBS_VIEW_ALL', 'SYSTEM_ADMIN']
    });
    expect(r.status).toBe(200);
    expect(capsOf('pm')).toContain('SYSTEM_ADMIN');
  });

  test('can create a new role carrying it', async () => {
    const r = await call('POST', '/api/roles', PLATFORM_OWNER, {
      name: 'second_operator', label: 'Second Operator', capabilities: ['SYSTEM_ADMIN']
    });
    expect(r.status).toBe(200);
    expect(capsOf('second_operator')).toEqual(['SYSTEM_ADMIN']);
  });

  test('can edit and delete a role that already carries it', async () => {
    expect((await call('PUT', '/api/roles/platform_ops', PLATFORM_OWNER, { label: 'Ops' })).status).toBe(200);
    expect((await call('DELETE', '/api/roles/platform_ops', PLATFORM_OWNER)).status).toBe(200);
    expect(tables.roles.find((x) => x.name === 'platform_ops')).toBeUndefined();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. Do not break what works. Ordinary role administration is untouched.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('ordinary role administration still works for an org admin', () => {
  test('editing the capabilities of a role that does not carry SYSTEM_ADMIN', async () => {
    const r = await call('PUT', '/api/roles/pm', ORG_A_ADMIN, {
      capabilities: ['JOBS_VIEW_ALL', 'JOBS_EDIT_OWN', 'FINANCIALS_VIEW']
    });
    expect(r.status).toBe(200);
    expect(capsOf('pm')).toContain('FINANCIALS_VIEW');
  });

  test('editing the `admin` builtin — it does not carry the cap, so it stays editable', async () => {
    const r = await call('PUT', '/api/roles/admin', ORG_A_ADMIN, {
      capabilities: ADMIN_CAPS.filter((c) => c !== 'JOBS_DELETE')
    });
    expect(r.status).toBe(200);
    expect(capsOf('admin')).not.toContain('JOBS_DELETE');
  });

  test('creating and deleting an ordinary custom role', async () => {
    expect((await call('POST', '/api/roles', ORG_A_ADMIN, {
      name: 'estimator2', label: 'Estimator II', capabilities: ['ESTIMATES_VIEW', 'ESTIMATES_EDIT']
    })).status).toBe(200);
    expect((await call('DELETE', '/api/roles/estimator2', ORG_A_ADMIN)).status).toBe(200);
  });

  test('an absent role still 404s, and a label-only edit still no-ops cleanly', async () => {
    expect((await call('PUT', '/api/roles/ghost', ORG_A_ADMIN, { label: 'x' })).status).toBe(404);
    const r = await call('PUT', '/api/roles/scratch', ORG_A_ADMIN, {});
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, unchanged: true });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 5. The pair, as a chain. Widening the role was step one of two.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('SYSTEM_ADMIN cannot be attached to a user by any route', () => {
  test('PUT /api/auth/users/:id refuses a SYSTEM_ADMIN-carrying role from a non-holder', async () => {
    const r = await call('PUT', '/api/auth/users/11', ORG_A_ADMIN, { role: 'system_admin' });
    expect(r.status).toBe(403);
    expect(tables.users.find((u) => u.id === 11).role).toBe('pm');
  });

  test('a custom role carrying it is refused the same way — the guard reads capabilities, not names', async () => {
    const r = await call('PUT', '/api/auth/users/11', ORG_A_ADMIN, { role: 'platform_ops' });
    expect(r.status).toBe(403);
    expect(tables.users.find((u) => u.id === 11).role).toBe('pm');
  });

  test('the two-step chain is dead at BOTH links', async () => {
    // Step one: widen the role the caller already holds. Refused here now.
    expect((await call('PUT', '/api/roles/admin', ORG_A_ADMIN, {
      capabilities: ADMIN_CAPS.concat(['SYSTEM_ADMIN'])
    })).status).toBe(403);
    // Step two, attempted anyway: pin the tier into a users.role value, which
    // the next boot's seed cannot undo (db.js only re-asserts capabilities on
    // the `admin` / `system_admin` ROLES, never on user assignments).
    expect((await call('PUT', '/api/auth/users/10', ORG_A_ADMIN, { role: 'system_admin' })).status).toBe(403);
    expect(tables.users.find((u) => u.id === 10).role).toBe('admin');
    expect(hasCapability(ORG_A_ADMIN, 'SYSTEM_ADMIN')).toBe(false);
  });

  test('POST /api/auth/register cannot mint one either — its role list is a whitelist', async () => {
    const r = await call('POST', '/api/auth/register', ORG_A_ADMIN, {
      email: 'new@a.test', password: 'hunter2hunter2', name: 'New', role: 'system_admin'
    });
    // The whitelist silently clamps to 'pm' rather than refusing; either way
    // the escalation does not happen. Pinned so a future "accept any role in
    // the roles table" change has to come past this test.
    expect(r.status).toBe(200);
    expect(r.body.role).toBe('pm');
  });

  test('a holder can still assign it — the platform owner must be able to appoint', async () => {
    const r = await call('PUT', '/api/auth/users/11', PLATFORM_OWNER, { role: 'system_admin' });
    expect(r.status).toBe(200);
    expect(tables.users.find((u) => u.id === 11).role).toBe('system_admin');
  });
});
