// The two roles findings that close WITHOUT per-org roles.
//
// `roles` has no organization_id — `name` is the primary key, the table is
// global, and auth.js `_roleCache` keys on the role NAME alone. Making the
// table per-tenant means a schema change, a data migration, a PK change, a
// re-keyed cache and therefore every hasCapability call site (65 in server/
// key on SYSTEM_ADMIN / requireSystemAdmin / isAdminish reachable from it).
// That is its own pass and is deliberately NOT attempted.
//
// But two of the four open items were never about the table being global. They
// were about this router handing out more than the caller asked for, and both
// close here.
//
// ── 1. GET /api/roles was `requireAuth` and nothing else, unfiltered ────────
// Verified live: an org-A PM received a seeded org-B CUSTOM role by name,
// label and full capability array. A `sub` in the contractor portal got the
// same list. That is another tenant's internal org design handed to anyone
// with a login — and, for an attacker, a map of exactly which named role to
// aim an escalation at.
//
// Only two consumers exist and they want different things:
//   js/auth.js loadCapabilities()  — finds the caller's OWN role by name and
//                                    reads its capability array. One row.
//   js/admin.js Roles tab (ROLES_MANAGE) + the New/Edit User role dropdown
//                                    (USERS_MANAGE) — want the whole list.
// So administrators keep the list and everyone else gets exactly their own
// role. Nobody loses a capability they could act on, and the recon surface
// goes to zero for every non-admin session, which is nearly all of them.
//
// ── 2. The DELETE 409 body reported a CROSS-TENANT headcount ───────────────
// The refusal has to be decided on the GLOBAL count — deleting a row another
// tenant's users sit on would strip their capabilities. But the NUMBER that
// came back WAS that global count, so an org-A admin could name any role and
// read how many users exist across every tenant, repeatedly, and watch another
// org's hiring. Refuse on the global count; report only the caller's own.
//
// WHAT THIS FILE ALSO PINS AS STILL-WORKING
// The Roles UI, the user-role dropdown, and — the one that would break most
// quietly — js/auth.js's own capability load for a PM, which is what every
// capability-gated element in the app depends on.

process.env.JWT_SECRET = process.env.JWT_SECRET ||
  'test-secret-for-role-list-tenant-scope-suite-0123456789';

const express = require('express');
const http = require('http');

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

function rowsOf(name) { return tables[name] || []; }

function mockRunQuery(sql, params) {
  const text = String(sql).replace(/\s+/g, ' ').trim();
  const p = params || [];

  if (text.includes('SELECT name, capabilities FROM roles')) return { rows: rowsOf('roles') };

  // Both shapes deliberately: the narrowed read adds a WHERE the old one did
  // not have. Answering only the new shape would make the FAKE, not the
  // boundary, the reason a reverted route fails — and would inflate the red
  // count when this fix is checked for bite.
  if (/^SELECT name, label, description, builtin, capabilities, created_at, updated_at FROM roles WHERE name = \$1/.test(text)) {
    const hit = rowsOf('roles').find((r) => r.name === p[0]);
    return { rows: hit ? [hit] : [] };
  }
  if (/^SELECT name, label, description, builtin, capabilities, created_at, updated_at FROM roles/.test(text)) {
    return { rows: rowsOf('roles') };
  }
  if (/^SELECT builtin, capabilities FROM roles WHERE name = \$1/.test(text)) {
    const hit = rowsOf('roles').find((r) => r.name === p[0]);
    return { rows: hit ? [{ builtin: !!hit.builtin, capabilities: hit.capabilities }] : [] };
  }
  if (/COUNT\(\*\)::int AS c FROM users WHERE role = \$1 AND organization_id = \$2/.test(text)) {
    return { rows: [{ c: rowsOf('users').filter((u) => u.role === p[0] && String(u.organization_id) === String(p[1])).length }] };
  }
  if (/COUNT\(\*\)::int AS c FROM users WHERE role = \$1/.test(text)) {
    return { rows: [{ c: rowsOf('users').filter((u) => u.role === p[0]).length }] };
  }
  if (/^DELETE FROM roles WHERE name = \$1/.test(text)) {
    const before = tables.roles.length;
    tables.roles = tables.roles.filter((r) => r.name !== p[0]);
    return { rows: [], rowCount: before - tables.roles.length };
  }
  if (/^INSERT INTO admin_audit_log/.test(text)) return { rows: [], rowCount: 1 };
  return { rows: [], rowCount: 0 };
}

const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const { pool } = require('../server/db');

setRolePool(pool);

let server, baseUrl;

const ADMIN_CAPS = [
  'JOBS_VIEW_ALL', 'FINANCIALS_VIEW', 'ESTIMATES_VIEW', 'LEADS_VIEW', 'LEADS_EDIT',
  'USERS_MANAGE', 'ROLES_MANAGE', 'INSIGHTS_VIEW', 'ADMIN_METRICS'
];

const ORG_A_ADMIN = { id: 10, email: 'admin-a@a.test', role: 'admin', name: 'A Admin', organization_id: 1 };
const ORG_A_PM    = { id: 11, email: 'pm-a@a.test',    role: 'pm',    name: 'A PM',    organization_id: 1 };
const ORG_A_SUB   = { id: 12, email: 'sub-a@a.test',   role: 'sub',   name: 'A Sub',   organization_id: 1 };
const ORG_B_ADMIN = { id: 77, email: 'admin-b@b.test', role: 'admin', name: 'B Admin', organization_id: 2 };
// Holds USERS_MANAGE but NOT ROLES_MANAGE — the New/Edit User role dropdown
// runs as this shape, and a ROLES_MANAGE-only gate would have emptied it.
const ORG_A_STAFF = { id: 13, email: 'staff-a@a.test', role: 'user_manager', name: 'A Staff', organization_id: 1 };

function freshTables() {
  return {
    roles: [
      { name: 'system_admin', label: 'System Admin', builtin: true, capabilities: ADMIN_CAPS.concat(['SYSTEM_ADMIN']) },
      { name: 'admin', label: 'Org Admin', builtin: true, capabilities: ADMIN_CAPS.slice() },
      { name: 'pm', label: 'Project Manager', builtin: true, capabilities: ['JOBS_VIEW_ALL', 'LEADS_VIEW', 'LEADS_EDIT'] },
      { name: 'sub', label: 'Subcontractor', builtin: true, capabilities: [] },
      { name: 'user_manager', label: 'User Manager', builtin: false, capabilities: ['USERS_MANAGE'] },
      // Org-B's own creation. An org-A caller has no business seeing it, and
      // its capability array is the part that turns a leak into a target list.
      { name: 'org_b_field_lead', label: 'Org B Field Lead', description: 'Org B internal',
        builtin: false, capabilities: ['JOBS_VIEW_ALL', 'PROGRESS_UPDATE', 'FINANCIALS_VIEW'] },
      { name: 'scratch', label: 'Scratch', builtin: false, capabilities: [] }
    ],
    users: [
      { id: 10, role: 'admin', organization_id: 1 },
      { id: 11, role: 'pm', organization_id: 1 },
      { id: 12, role: 'sub', organization_id: 1 },
      { id: 13, role: 'user_manager', organization_id: 1 },
      { id: 77, role: 'admin', organization_id: 2 },
      // Seven org-B users on org-B's own role. The old 409 handed that 7 to
      // org-A on request.
      { id: 80, role: 'org_b_field_lead', organization_id: 2 },
      { id: 81, role: 'org_b_field_lead', organization_id: 2 },
      { id: 82, role: 'org_b_field_lead', organization_id: 2 },
      { id: 83, role: 'org_b_field_lead', organization_id: 2 },
      { id: 84, role: 'org_b_field_lead', organization_id: 2 },
      { id: 85, role: 'org_b_field_lead', organization_id: 2 },
      { id: 86, role: 'org_b_field_lead', organization_id: 2 }
    ]
  };
}

function req(method, path, user) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method,
      headers: { Authorization: 'Bearer ' + signToken(user) }
    }, (resp) => {
      let raw = '';
      resp.on('data', (c) => { raw += c; });
      resp.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (e) { /* non-JSON */ }
        resolve({ status: resp.statusCode, body: json, raw });
      });
    }).on('error', reject).end();
  });
}

beforeAll(async () => {
  tables = freshTables();
  await refreshRoleCache();
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/roles', require('../server/routes/role-routes'));
  await new Promise((done) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      baseUrl = 'http://127.0.0.1:' + server.address().port;
      done();
    });
  });
});

afterAll((done) => { server.close(() => done()); });

beforeEach(async () => { tables = freshTables(); await refreshRoleCache(); });

describe("GET /api/roles no longer hands out another tenant's org design", () => {
  test("a PM does not receive org-B's custom role", async () => {
    const r = await req('GET', '/api/roles', ORG_A_PM);
    expect(r.status).toBe(200);
    const names = r.body.roles.map((x) => x.name);
    expect(names).not.toContain('org_b_field_lead');
    // Not just the name — the capability array was the useful half.
    expect(r.raw).not.toContain('PROGRESS_UPDATE');
  });

  test('a sub in the contractor portal gets the same treatment', async () => {
    const r = await req('GET', '/api/roles', ORG_A_SUB);
    expect(r.body.roles.map((x) => x.name)).toEqual(['sub']);
  });

  test('a PM still gets its OWN role, with capabilities — js/auth.js depends on it', async () => {
    // loadCapabilities() finds the caller's role by name and reads the array.
    // If this regressed, every capability-gated element in the app silently
    // disappears and nothing throws.
    const r = await req('GET', '/api/roles', ORG_A_PM);
    const own = r.body.roles.find((x) => x.name === 'pm');
    expect(own).toBeTruthy();
    expect(own.capabilities).toEqual(expect.arrayContaining(['LEADS_EDIT', 'JOBS_VIEW_ALL']));
  });

  test('a PM cannot see the system_admin role or its capability list', async () => {
    // The escalation target list. Naming the role that carries SYSTEM_ADMIN,
    // and what it holds, is exactly the reconnaissance step.
    const r = await req('GET', '/api/roles', ORG_A_PM);
    expect(r.raw).not.toContain('SYSTEM_ADMIN');
    expect(r.body.roles.map((x) => x.name)).not.toContain('system_admin');
  });

  test('the admin Roles UI still gets the whole list', async () => {
    const r = await req('GET', '/api/roles', ORG_A_ADMIN);
    expect(r.body.roles).toHaveLength(7);
  });

  test('the New/Edit User role dropdown still gets it on USERS_MANAGE alone', async () => {
    // Gating on ROLES_MANAGE only would have left this caller with one option
    // in a dropdown whose whole job is choosing among many.
    const r = await req('GET', '/api/roles', ORG_A_STAFF);
    expect(r.body.roles).toHaveLength(7);
  });

  test('GET /api/roles/capabilities is untouched — the Roles UI renders from it', async () => {
    const r = await req('GET', '/api/roles/capabilities', ORG_A_PM);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.capabilities)).toBe(true);
  });
});

describe('the DELETE 409 is no longer a cross-tenant headcount oracle', () => {
  test("org-A cannot read org-B's headcount off a refusal", async () => {
    const r = await req('DELETE', '/api/roles/org_b_field_lead', ORG_A_ADMIN);
    expect(r.status).toBe(409);
    // Seven org-B users sit on that role. The number must not cross.
    expect(r.body.error).not.toMatch(/\d/);
    expect(r.body.error).not.toContain('7');
  });

  test('the role is still protected — refusing is not softened, only the body', async () => {
    await req('DELETE', '/api/roles/org_b_field_lead', ORG_A_ADMIN);
    expect(tables.roles.map((x) => x.name)).toContain('org_b_field_lead');
  });

  test("an admin still gets a real, actionable count for their OWN org", async () => {
    tables.users.push({ id: 90, role: 'scratch', organization_id: 1 });
    tables.users.push({ id: 91, role: 'scratch', organization_id: 1 });
    // Plus one in the other tenant, which must not be added to the number.
    tables.users.push({ id: 92, role: 'scratch', organization_id: 2 });
    const r = await req('DELETE', '/api/roles/scratch', ORG_A_ADMIN);
    expect(r.status).toBe(409);
    expect(r.body.error).toContain('2 user(s) in your organization');
    expect(r.body.error).not.toContain('3 user');
  });

  test('an unused custom role still deletes — the refusal path did not widen', async () => {
    const r = await req('DELETE', '/api/roles/scratch', ORG_A_ADMIN);
    expect(r.status).toBe(200);
    expect(tables.roles.map((x) => x.name)).not.toContain('scratch');
  });

  test('org-B sees its own count for its own role', async () => {
    const r = await req('DELETE', '/api/roles/org_b_field_lead', ORG_B_ADMIN);
    expect(r.status).toBe(409);
    expect(r.body.error).toContain('7 user(s) in your organization');
  });
});
