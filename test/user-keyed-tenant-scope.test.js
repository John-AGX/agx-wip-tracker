// The tenant boundary on a caller-supplied USER id.
//
// THE DEFECT THIS FILE EXISTS FOR
// `PUT /api/auth/users/:id` read `SELECT * FROM users WHERE id = $1` with no
// org predicate. An org-A admin could set an org-B PM's email to an address
// they control — which is account takeover, because the password reset then
// completes it — flip that PM's role to admin inside a tenant they do not
// belong to, and set active=false to lock org B's staff out. HTTP 200 for all
// three. `GET /api/auth/users` IS org-scoped, so the list never showed org B;
// users.id is SERIAL, so the by-id door never needed the list.
//
// Three more doors on the same key were open beside it, and one is sharper
// than the named finding: `PUT /users/:id/password` sets a foreign tenant's
// credential AND mails it, with no email change and no reset link required.
// The delete and the notification-prefs write are the other two. The rule is
// stated on the KEY, so all four are behind one guard.
//
// THE TWO THINGS THAT MUST SURVIVE
//   1. The org ADOPTION (57eeae5). `PUT /users/:id` is the only endpoint that
//      writes users.organization_id after insert, and it is the remediation
//      requireOrgId's 409 names. Scoping an un-stamped user out of the door
//      would close the only exit from ORG_UNRESOLVED. Asserted here, twice:
//      the adoption still fires, and it still cannot MOVE anyone.
//   2. Nobody gets locked out. A legacy install where every users row is
//      NULL-org behaves exactly as it did.
//
// THE SYSTEM ADMIN, DECIDED RATHER THAN INHERITED
// A SYSTEM_ADMIN capability holder MAY cross, and every crossing is audited.
// That is a choice, not an accident: `POST /api/auth/act-as` already lets a
// holder become any user in any tenant, so refusing here would be a fence with
// an open gate beside it. The test below pins BOTH halves — that a holder
// crosses and is recorded, and that the check is on the CAPABILITY, so a role
// merely NAMED system_admin without the cap is refused.
//
// WHY THE ROUTER IS MOUNTED FOR REAL
// "Refused before anything is written" is not observable from a source grep,
// and neither is "the guard runs before validateRoleAssignment". The real
// router runs on a real express app behind real requireAuth, over the wire,
// against a pool that records every statement.

const express = require('express');
const http = require('http');

let queries;          // every statement the routes emitted, in order
let handlers;         // sql-substring -> (sql, params) => rows

jest.mock('../server/db', () => ({
  pool: {
    query: async (sql, params) => mockRunQuery(sql, params),
    connect: async () => ({
      query: async (sql, params) => mockRunQuery(sql, params),
      release: () => {}
    })
  },
  getOrgById: async () => null
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

const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const authRoutes = require('../server/routes/auth-routes');
const { userInOrg } = require('../server/services/user-org-scope');

setRolePool(require('../server/db').pool);

let server, baseUrl;

beforeAll(async () => {
  // Load the role cache once, the way index.js does at boot. hasCapability
  // reads it, and the SYSTEM_ADMIN decision below is meaningless without it.
  queries = []; handlers = {
    'SELECT name, capabilities FROM roles': () => ({ rows: [
      { name: 'admin', capabilities: ['USERS_MANAGE'] },
      { name: 'pm', capabilities: [] },
      { name: 'system_admin', capabilities: ['USERS_MANAGE', 'SYSTEM_ADMIN'] },
      // A role NAMED like the platform tier but NOT carrying the capability.
      { name: 'system_admin_lookalike', capabilities: ['USERS_MANAGE'] }
    ] })
  };
  await refreshRoleCache();

  const app = express();
  app.use(express.json({ limit: '10mb' }));
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

beforeEach(() => { queries = []; handlers = {}; });

function tokenFor(user) {
  return signToken(Object.assign(
    { id: 10, email: 'admin-a@a.test', role: 'admin', name: 'Admin A', organization_id: 1 },
    user
  ));
}

async function call(method, path, user, body) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tokenFor(user) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* non-JSON */ }
  return { status: res.status, body: json };
}

// Answer the by-id read every one of the four doors starts with.
function targetIs(row) {
  handlers['FROM users WHERE id = $1'] = (sql, params) => {
    // resolveOrgId's legacy-token fallback uses the SAME shape keyed on the
    // CALLER's id. Distinguish by the bound id so a caller lookup can never be
    // answered with the target's row (which would make the guard trivially pass).
    if (String(params[0]) === String(row.id)) return { rows: [row] };
    return { rows: [{ organization_id: null }] };
  };
}

// Any write that CHANGES the target. bumpLastSeen fires on every authed
// request and is not one — matching it would make every assertion below pass.
function userWrite() {
  return queries.find((q) =>
    /^\s*(UPDATE users SET (?!last_seen_at)|DELETE FROM users)/i.test(q.sql));
}

function auditOf(action) {
  return queries.find((q) =>
    /INSERT INTO admin_audit_log/i.test(q.sql) && (q.params || []).includes(action));
}

const ORG_A = { id: 10, email: 'admin-a@a.test', role: 'admin', organization_id: 1 };
const ORG_B_PM = { id: 77, email: 'pm@b.test', name: 'PM B', role: 'pm', active: true, organization_id: 2 };

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. The predicate itself.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the predicate', () => {
  test('same tenant reaches; a different tenant does not', () => {
    expect(userInOrg(1, 1)).toBe(true);
    expect(userInOrg(1, 2)).toBe(false);
  });

  test('an un-stamped target is reachable — that IS the adoption door', () => {
    expect(userInOrg(1, null)).toBe(true);
    expect(userInOrg(null, null)).toBe(true);   // legacy install, unchanged
  });

  test('a caller who names no tenant may not touch one that does', () => {
    expect(userInOrg(null, 2)).toBe(false);
  });

  test('the ids compare as strings, so 1 and "1" are one tenant', () => {
    expect(userInOrg('1', 1)).toBe(true);
    expect(userInOrg(1, '2')).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. All four doors refuse a foreign-tenant user id.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a foreign-tenant user is not a user you can write', () => {
  beforeEach(() => targetIs(ORG_B_PM));

  test('PUT /users/:id — the takeover triple is refused, and nothing is written', async () => {
    const r = await call('PUT', '/api/auth/users/77', ORG_A, {
      email: 'attacker@orga.example', role: 'admin', active: false
    });
    expect(r.status).toBe(404);
    expect(userWrite()).toBeUndefined();
  });

  test('PUT /users/:id/password — the credential is never set and never mailed', async () => {
    const r = await call('PUT', '/api/auth/users/77/password', ORG_A, { newPassword: 'hunter2hunter2' });
    expect(r.status).toBe(404);
    expect(userWrite()).toBeUndefined();
    expect(queries.some((q) => /password_hash/i.test(q.sql))).toBe(false);
  });

  test('DELETE /users/:id — org B keeps its user', async () => {
    const r = await call('DELETE', '/api/auth/users/77', ORG_A);
    expect(r.status).toBe(404);
    expect(userWrite()).toBeUndefined();
  });

  test('PUT /users/:id/notification-prefs — refused too', async () => {
    const r = await call('PUT', '/api/auth/users/77/notification-prefs', ORG_A, { prefs: { email: false } });
    expect(r.status).toBe(404);
    expect(userWrite()).toBeUndefined();
  });

  test('the refusal is the SAME 404 an absent user gets — users.id is SERIAL', async () => {
    // A distinguishable 403 would turn each door into a cross-tenant existence
    // oracle, which is exactly what the org-scoped GET /users prevents.
    const foreign = await call('PUT', '/api/auth/users/77', ORG_A, { name: 'x' });
    handlers['FROM users WHERE id = $1'] = () => ({ rows: [] });
    const absent = await call('PUT', '/api/auth/users/999999', ORG_A, { name: 'x' });
    expect(foreign.status).toBe(absent.status);
    expect(foreign.body).toEqual(absent.body);
  });

  test('the guard runs BEFORE the role validation, so no work precedes the refusal', async () => {
    await call('PUT', '/api/auth/users/77', ORG_A, { role: 'admin' });
    expect(queries.some((q) => /FROM roles WHERE name/i.test(q.sql))).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. The org adoption still works. This is the thing the fix must not break.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the adoption survives', () => {
  const UNSTAMPED = { id: 42, email: 'orphan@a.test', name: 'Orphan', role: 'pm', active: true, organization_id: null };

  function adoptionUpdate() {
    return queries.find((q) => /UPDATE users SET name = \$1, role = \$2/i.test(q.sql));
  }

  test('an org-less user is adopted into the calling admin org', async () => {
    targetIs(UNSTAMPED);
    const r = await call('PUT', '/api/auth/users/42', ORG_A, { name: 'Orphan' });
    expect(r.status).toBe(200);
    const u = adoptionUpdate();
    expect(u).toBeDefined();
    expect(u.sql).toMatch(/organization_id = COALESCE\(organization_id, \$8\)/);
    expect(u.params[7]).toBe(1);                       // $8 = the caller's org
    expect(auditOf('user.org_adopted')).toBeDefined();
  });

  test('the org comes from the caller, NEVER from the body', async () => {
    targetIs(UNSTAMPED);
    await call('PUT', '/api/auth/users/42', ORG_A, { name: 'Orphan', organization_id: 999 });
    expect(adoptionUpdate().params[7]).toBe(1);
    expect(adoptionUpdate().params).not.toContain(999);
  });

  test('COALESCE means it can only ever FILL a null — an edit is not a tenant move', async () => {
    targetIs(Object.assign({}, ORG_B_PM, { organization_id: 1 }));   // already in org A
    const r = await call('PUT', '/api/auth/users/77', ORG_A, { name: 'Renamed' });
    expect(r.status).toBe(200);
    expect(adoptionUpdate().params[7]).toBeNull();     // nothing to adopt
    expect(auditOf('user.org_adopted')).toBeUndefined();
  });

  test('a legacy install — caller and target both un-stamped — still saves', async () => {
    targetIs(UNSTAMPED);
    const r = await call('PUT', '/api/auth/users/42', { organization_id: null }, { name: 'Orphan' });
    expect(r.status).toBe(200);
    expect(adoptionUpdate()).toBeDefined();
  });

  test('but an org-less caller may not reach a stamped user', async () => {
    targetIs(ORG_B_PM);
    const r = await call('PUT', '/api/auth/users/77', { organization_id: null }, { name: 'x' });
    expect(r.status).toBe(404);
    expect(userWrite()).toBeUndefined();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. A same-tenant admin is untouched.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('an in-tenant edit still works on every door', () => {
  const ORG_A_PM = { id: 55, email: 'pm@a.test', name: 'PM A', role: 'pm', active: true, organization_id: 1 };
  beforeEach(() => targetIs(ORG_A_PM));

  test('update', async () => {
    const r = await call('PUT', '/api/auth/users/55', ORG_A, { name: 'PM A2' });
    expect(r.status).toBe(200);
    expect(userWrite()).toBeDefined();
  });

  test('password reset', async () => {
    const r = await call('PUT', '/api/auth/users/55/password', ORG_A, { newPassword: 'hunter2hunter2' });
    expect(r.status).toBe(200);
    expect(queries.some((q) => /password_hash/i.test(q.sql))).toBe(true);
  });

  test('delete', async () => {
    const r = await call('DELETE', '/api/auth/users/55', ORG_A);
    expect(r.status).toBe(200);
    expect(queries.some((q) => /DELETE FROM users/i.test(q.sql))).toBe(true);
  });

  test('notification prefs', async () => {
    const r = await call('PUT', '/api/auth/users/55/notification-prefs', ORG_A, { prefs: { email: true } });
    expect(r.status).toBe(200);
    expect(queries.some((q) => /notification_prefs = \$1::jsonb/i.test(q.sql))).toBe(true);
  });

  test('nothing in-tenant is logged as a crossing', async () => {
    await call('PUT', '/api/auth/users/55', ORG_A, { name: 'PM A2' });
    expect(auditOf('user.cross_tenant_write')).toBeUndefined();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 5. The system admin, both halves of the decision.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a SYSTEM_ADMIN crosses on purpose, and it is recorded', () => {
  const SYS = { id: 1, email: 'john@agx.test', role: 'system_admin', organization_id: 1 };

  test('the crossing is permitted', async () => {
    targetIs(ORG_B_PM);
    const r = await call('PUT', '/api/auth/users/77', SYS, { name: 'Fixed by support' });
    expect(r.status).toBe(200);
    expect(userWrite()).toBeDefined();
  });

  test('and audited with BOTH org ids, so it is never silent', async () => {
    targetIs(ORG_B_PM);
    await call('PUT', '/api/auth/users/77', SYS, { name: 'Fixed by support' });
    const a = auditOf('user.cross_tenant_write');
    expect(a).toBeDefined();
    const detail = JSON.parse(a.params.find((p) => typeof p === 'string' && p.includes('target_org')));
    expect(detail).toMatchObject({ door: 'user_update', actor_org: 1, target_org: 2 });
  });

  test('the check is the CAPABILITY, not the role name', async () => {
    // requireRole('admin') already admits the system_admin ROLE by NAME, so a
    // name test in the guard would be satisfied by the very gate that let the
    // caller in. Strip the capability off the role and keep the name: the same
    // token that crossed a moment ago must now be refused.
    handlers['SELECT name, capabilities FROM roles'] = () => ({ rows: [
      { name: 'admin', capabilities: ['USERS_MANAGE'] },
      { name: 'system_admin', capabilities: ['USERS_MANAGE'] }   // name kept, cap gone
    ] });
    await refreshRoleCache();
    try {
      targetIs(ORG_B_PM);
      const r = await call('PUT', '/api/auth/users/77', SYS, { name: 'x' });
      expect(r.status).toBe(404);
      expect(userWrite()).toBeUndefined();
    } finally {
      handlers['SELECT name, capabilities FROM roles'] = () => ({ rows: [
        { name: 'admin', capabilities: ['USERS_MANAGE'] },
        { name: 'pm', capabilities: [] },
        { name: 'system_admin', capabilities: ['USERS_MANAGE', 'SYSTEM_ADMIN'] }
      ] });
      await refreshRoleCache();
    }
  });

  test('crossing is not a licence to MOVE a tenant', async () => {
    targetIs(ORG_B_PM);
    await call('PUT', '/api/auth/users/77', SYS, { name: 'x', organization_id: 1 });
    const u = queries.find((q) => /UPDATE users SET name = \$1, role = \$2/i.test(q.sql));
    expect(u.params[7]).toBeNull();                    // adoption never fires
    expect(u.sql).toMatch(/COALESCE\(organization_id, \$8\)/);
  });

  test('it reaches the other three doors too', async () => {
    targetIs(ORG_B_PM);
    expect((await call('DELETE', '/api/auth/users/77', SYS)).status).toBe(200);
    expect(auditOf('user.cross_tenant_write')).toBeDefined();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 6. An unanswerable tenant is retryable, not a verdict.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a lookup failure is 503, not 403 and not a write', () => {
  test('ORG_LOOKUP_FAILED, and the target is untouched', async () => {
    // A legacy token carries no org claim, so resolveOrgId must hit the DB.
    // Registered BEFORE targetIs so the more specific key matches first.
    handlers['SELECT organization_id FROM users WHERE id = $1'] = () => {
      throw new Error('pool exhausted');
    };
    targetIs(ORG_B_PM);
    const r = await call('PUT', '/api/auth/users/77', { organization_id: null }, { name: 'x' });
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('ORG_LOOKUP_FAILED');
    expect(userWrite()).toBeUndefined();
  });
});
