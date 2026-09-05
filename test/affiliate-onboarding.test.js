// THERE HAS NEVER BEEN A SECOND ORGANIZATION, AND THIS IS WHY.
//
// ── WHAT WAS BROKEN ───────────────────────────────────────────────────────
// POST /api/admin/organizations/invites/:token/accept is the ONLY door in this
// codebase that creates a tenant together with somebody who can log into it.
// (POST /api/admin/organizations creates an organizations row and no user — an
// org nobody can sign in to.) Inside its transaction it ran:
//
//     INSERT INTO users (email, password_hash, name, role, organization_id, owner_id)
//     UPDATE users SET owner_id = $1 WHERE id = $1
//
// `users` has no owner_id column. server/db.js:66 declares the table and ten
// ALTERs extend it; none of them is this one, and no migration anywhere adds
// it. Postgres therefore raised 42703 (undefined_column) on the INSERT, the
// handler's catch rolled the transaction back, and the caller got a 500. The
// organization, the owner user, the accepted-invitation stamp and the audit row
// all disappeared together — correctly, atomically, and every single time.
//
// So the multi-tenant story had a gate on it that had never once opened. Every
// argument about tenant isolation in this repo is an argument about a second
// tenant that could not be created.
//
// ── WHERE owner_id CAME FROM ──────────────────────────────────────────────
// It arrived with the flow itself (18d6e724, "Wave 2 — org invitation flow"),
// carrying this comment:
//
//     // Set owner_id = user.id so the user is the org's owner record
//     // (the bootstrap pattern other org-scoped queries assume).
//
// The pattern it names is real and is a DIFFERENT COLUMN. server/org-access.js
// scopes a job or an estimate by `jobs.owner_id -> users.organization_id`: an
// AUTHORSHIP pointer, from a content row to the user who wrote it. There is no
// self-pointer on `users`, nothing in server/, js/ or test/ reads one, and no
// query would be satisfied by one existing. The comment is the whole defect —
// a reassuring sentence that made a guaranteed-failing statement look load
// bearing, which is exactly the class this session keeps finding.
//
// The repair is to delete both references. NO MIGRATION IS NEEDED, and that is
// the argued conclusion rather than the convenient one: "who founded this org"
// is already recorded twice in columns that exist — org_invitations
// .accepted_user_id / .accepted_org_id, and the org.invite_accept audit row's
// detail.owner_user_id — so adding a column to a live pilot's users table would
// buy a third copy of a fact nothing asks for.
//
// ── WHY THIS FILE USES A REAL SQL ENGINE ──────────────────────────────────
// The property under test is THE ABSENCE OF A COLUMN. A hand-written mock pool
// answers "did the org get created" out of whatever its author wrote in the
// INSERT branch, and an author writing that branch types the columns the
// statement mentions — including owner_id. The fixture would have absorbed the
// defect and reported success, which is precisely how test/ai-read-tenant-doors
// .test.js's invented `attachments.created_at` hid two broken agent tools for
// four rounds.
//
// So the schema here is DERIVED from server/db.js by test/helpers/db-schema.js
// and handed to node:sqlite. Nothing in this file types a column name into a
// CREATE TABLE. A statement naming a column db.js does not create fails here
// the same way it fails in Postgres, and O0 below proves that the harness can
// still see the original defect rather than passing by finding nothing.
//
// ── THE TWO-ORG FIXTURE IS THE POINT ──────────────────────────────────────
// The database starts with the incumbent tenant in it (org 1, AGX, with its
// system admin). A pass means TWO organizations exist afterwards, the founder
// is in the new one and not the old one, and no row the flow wrote landed on
// the incumbent. That last part is not decoration: the scaffold this session is
// building depends on a synthetic second org whose rows are correctly stamped,
// and a second org created with rows carrying org 1 would poison it.

process.env.JWT_SECRET = process.env.JWT_SECRET ||
  'affiliate-onboarding-suite-secret-0123456789abcdef';

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const schema = require('./helpers/db-schema');
const { createPgSqlite } = require('./helpers/pg-sqlite');

// The engine is swapped PER TEST, and the mock forwards to whatever it is at
// call time rather than capturing it. server/routes/admin-organizations-routes
// .js destructures `pool` at module load, so a factory that returned a pool
// object bound to the engine that existed when the module was first required
// would leave the route writing to a database these assertions never read —
// the exact false green this wave produced once already.
let mockEngine = null;

jest.mock('../server/db', () => ({
  pool: {
    query: (sql, params) => mockEngine.pool.query(sql, params),
    connect: async () => (await mockEngine.pool.connect()),
  },
  listOrganizations: async () => mockEngine.all('SELECT * FROM organizations'),
  getOrgById: async (id) => mockEngine.all('SELECT * FROM organizations WHERE id = ?', id)[0] || null,
}));
jest.mock('../server/email', () => ({
  sendEmail: async () => ({ ok: true }),
  isEnabled: () => false,
  sendForEvent: async () => ({}),
}));

const TABLES = ['organizations', 'users', 'org_invitations', 'admin_audit_log'];
const PK = { organizations: 'id', users: 'id', org_invitations: 'id', admin_audit_log: 'id' };

function derivedSchema(tables) {
  return schema.sqliteSchema(tables || TABLES, { pk: PK });
}

const HOUR = 3600 * 1000;
const future = () => new Date(Date.now() + 72 * HOUR).toISOString();
const past = () => new Date(Date.now() - 72 * HOUR).toISOString();

// The incumbent tenant, exactly as production has it: one organization, one
// system admin who issues invitations.
function seedIncumbent(engine) {
  engine.db.exec(
    "INSERT INTO organizations (id, slug, name) VALUES (1, 'agx-central-florida', 'AGX Central Florida');" +
    "INSERT INTO users (id, email, password_hash, name, role, organization_id, active) " +
    "  VALUES (10, 'john@agxco.com', 'x', 'John', 'system_admin', 1, 1);"
  );
}

function seedInvite(engine, row) {
  const r = Object.assign({
    id: 1, email: 'owner@affiliate.test', org_name: 'Affiliate Roofing',
    token: 'a'.repeat(64), invited_by_user_id: 10, expires_at: future(),
    accepted_at: null, accepted_org_id: null, accepted_user_id: null,
  }, row || {});
  engine.db.prepare(
    'INSERT INTO org_invitations (id, email, org_name, token, invited_by_user_id, expires_at,' +
    ' accepted_at, accepted_org_id, accepted_user_id) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(r.id, r.email, r.org_name, r.token, r.invited_by_user_id, r.expires_at,
    r.accepted_at, r.accepted_org_id, r.accepted_user_id);
  return r;
}

function newEngine(opts) {
  const tables = (opts && opts.tables) || TABLES;
  const e = createPgSqlite(derivedSchema(tables), { jsonColumns: ['settings', 'branding', 'billing'] });
  return e;
}

let server, baseUrl, logSpy, errSpy;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/organizations', require('../server/routes/admin-organizations-routes'));
  await new Promise((done) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      baseUrl = 'http://127.0.0.1:' + server.address().port;
      done();
    });
  });
});
afterAll((done) => { server.close(() => done()); });

beforeEach(() => {
  mockEngine = newEngine();
  seedIncumbent(mockEngine);
  require('../server/audit')._resetCoalescer();
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { logSpy.mockRestore(); errSpy.mockRestore(); });

async function accept(token, body) {
  const res = await fetch(baseUrl + '/api/admin/organizations/invites/' + token + '/accept', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(Object.assign({ password: 'correct horse battery', name: 'Dana Owner' }, body || {})),
  });
  return { status: res.status, body: await res.json() };
}

const orgs = () => mockEngine.all('SELECT * FROM organizations ORDER BY id');
const users = () => mockEngine.all('SELECT * FROM users ORDER BY id');
const invites = () => mockEngine.all('SELECT * FROM org_invitations ORDER BY id');
const audit = () => mockEngine.all('SELECT * FROM admin_audit_log ORDER BY id');

// ── O0 — THE HARNESS CAN SEE THE DEFECT IT WAS WRITTEN FOR ────────────────
describe('O0 — the fixture is the real schema, and it still refuses the original statement', () => {
  test('server/db.js does not create users.owner_id', () => {
    expect(schema.columnsFor('users').has('owner_id')).toBe(false);
    // and the derived DDL never types it, because nothing here types columns
    expect(derivedSchema(['users'])).not.toMatch(/owner_id/);
    // the column the flow actually needs IS there
    expect(schema.columnsFor('users').has('organization_id')).toBe(true);
  });

  test('the exact statement that shipped fails against the derived schema', async () => {
    // Re-introduce the defect verbatim. If this passes, every assertion below
    // is worthless, because the harness would accept the broken code too.
    const c = await mockEngine.pool.connect();
    await expect(c.query(
      `INSERT INTO users (email, password_hash, name, role, organization_id, owner_id)
       VALUES ($1, $2, $3, 'admin', $4, NULL) RETURNING id`,
      ['x@y.z', 'h', 'N', 1]
    )).rejects.toThrow(/owner_id/);
    // …and the same statement without it is accepted, so the refusal above is
    // about the column and not about the shim disliking the statement shape.
    const ok = await c.query(
      `INSERT INTO users (email, password_hash, name, role, organization_id)
       VALUES ($1, $2, $3, 'admin', $4) RETURNING id`,
      ['x@y.z', 'h', 'N', 1]
    );
    expect(ok.rows[0].id).toBeGreaterThan(0);
  });
});

// ── O1 — A SECOND ORGANIZATION IS CREATED, AND IT PERSISTS ────────────────
describe('O1 — accepting an invitation creates a tenant that survives the commit', () => {
  test('one org before, two orgs after, and the new one is committed', async () => {
    const inv = seedInvite(mockEngine);
    expect(orgs()).toHaveLength(1);

    const r = await accept(inv.token);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    // Read the table again AFTER the handler returned. A row visible only
    // inside the transaction is the failure this whole file is about.
    const after = orgs();
    expect(after).toHaveLength(2);
    const fresh = after.find((o) => o.id !== 1);
    expect(fresh.name).toBe('Affiliate Roofing');
    expect(fresh.slug).toBe('affiliate-roofing');
    expect(r.body.organization.id).toBe(fresh.id);
    // the incumbent is untouched
    expect(after.find((o) => o.id === 1).name).toBe('AGX Central Florida');
  });

  test('the founder exists, is an admin, and is IN THE NEW ORG', async () => {
    const inv = seedInvite(mockEngine);
    const r = await accept(inv.token);
    const newOrgId = r.body.organization.id;

    const founder = users().find((u) => u.email === inv.email);
    expect(founder).toBeTruthy();
    expect(founder.role).toBe('admin');
    expect(founder.name).toBe('Dana Owner');
    expect(founder.organization_id).toBe(newOrgId);
    expect(founder.organization_id).not.toBe(1);
    // the password is hashed, not stored
    expect(founder.password_hash).not.toBe('correct horse battery');
    expect(founder.password_hash.startsWith('$2')).toBe(true);
    // the incumbent org gained nobody
    expect(users().filter((u) => u.organization_id === 1)).toHaveLength(1);
  });

  test('the minted auth token lands the founder in their own tenant', async () => {
    const inv = seedInvite(mockEngine);
    const r = await accept(inv.token);
    const claims = jwt.verify(r.body.token, process.env.JWT_SECRET);
    expect(claims.organization_id).toBe(r.body.organization.id);
    expect(claims.organization_id).not.toBe(1);
    expect(claims.email).toBe(inv.email);
    expect(claims.role).toBe('admin');
  });

  test('the invitation is spent and points at what it created', async () => {
    const inv = seedInvite(mockEngine);
    const r = await accept(inv.token);
    const row = invites()[0];
    expect(row.accepted_at).toBeTruthy();
    expect(row.accepted_org_id).toBe(r.body.organization.id);
    expect(row.accepted_user_id).toBe(r.body.user.id);
  });

  test('a colliding org name still gets its own slug', async () => {
    // The incumbent is already 'agx-central-florida'. An affiliate that takes
    // the same trading name must not fail the unique index.
    const inv = seedInvite(mockEngine, { org_name: 'AGX Central Florida' });
    const r = await accept(inv.token);
    expect(r.status).toBe(200);
    expect(r.body.organization.slug).toBe('agx-central-florida-2');
    expect(orgs()).toHaveLength(2);
  });
});

// ── O2 — EVERYTHING THE FLOW WRITES CARRIES THE NEW ORG ───────────────────
// The scaffold this session is building runs against a synthetic second org.
// A second org whose founding rows are stamped with the INCUMBENT's id would
// make that fixture agree with a leak.
describe('O2 — every row the flow creates is stamped with the new tenant', () => {
  test('no row the flow wrote landed on the incumbent org', async () => {
    const inv = seedInvite(mockEngine);
    const r = await accept(inv.token);
    const newOrgId = r.body.organization.id;
    expect(newOrgId).not.toBe(1);

    const founder = users().find((u) => u.email === inv.email);
    const a = audit().filter((x) => x.action === 'org.invite_accept');
    expect(a).toHaveLength(1);

    const stamped = [
      ['users.organization_id', founder.organization_id],
      ['org_invitations.accepted_org_id', invites()[0].accepted_org_id],
      ['admin_audit_log.organization_id', a[0].organization_id],
      ['admin_audit_log.actor_org_id', a[0].actor_org_id],
    ];
    expect(stamped.filter(([, v]) => v !== newOrgId)).toEqual([]);
  });

  test('the founding is audited, org-scoped, and names who let them in', async () => {
    const inv = seedInvite(mockEngine);
    const r = await accept(inv.token);
    const row = audit().find((x) => x.action === 'org.invite_accept');
    expect(row.tier).toBe('A');
    expect(row.scope).toBe('org');
    expect(row.actor_kind).toBe('invite');
    expect(row.actor_email).toBe(inv.email);
    expect(row.actor_user_id).toBe(r.body.user.id);
    expect(row.target_type).toBe('organization');
    expect(String(row.target_id)).toBe(String(r.body.organization.id));
    expect(row.detail.invited_by).toBe(10);
    expect(row.detail.owner_user_id).toBe(r.body.user.id);
  });
});

// ── O3 — THE TRANSACTION IS STILL ALL-OR-NOTHING ──────────────────────────
// The atomicity is what made the owner_id defect total rather than partial, and
// it is worth keeping for exactly that reason: a half-created tenant is worse
// than none. Each refusal below must leave the database with one organization.
describe('O3 — a refused or failed accept leaves no half-built tenant', () => {
  test.each([
    ['a malformed token', () => 'not-a-hex-token', {}, 400],
    ['a token nobody issued', () => 'b'.repeat(64), {}, 404],
    ['too short a password', null, { password: 'short' }, 400],
    ['no name', null, { name: '   ' }, 400],
  ])('%s is refused and creates nothing', async (_label, tokenFn, body, status) => {
    const inv = seedInvite(mockEngine);
    const token = tokenFn ? tokenFn() : inv.token;
    const r = await accept(token, body);
    expect(r.status).toBe(status);
    expect(orgs()).toHaveLength(1);
    expect(users()).toHaveLength(1);
  });

  test('an expired invitation is 410 and creates nothing', async () => {
    const inv = seedInvite(mockEngine, { expires_at: past() });
    const r = await accept(inv.token);
    expect(r.status).toBe(410);
    expect(orgs()).toHaveLength(1);
  });

  test('a replayed invitation is 409 and does not create a second tenant', async () => {
    const inv = seedInvite(mockEngine);
    expect((await accept(inv.token)).status).toBe(200);
    expect(orgs()).toHaveLength(2);
    const again = await accept(inv.token);
    expect(again.status).toBe(409);
    expect(orgs()).toHaveLength(2);          // still two, not three
    expect(users().filter((u) => u.email === inv.email)).toHaveLength(1);
  });

  test('an audit write that cannot land takes the whole tenant with it', async () => {
    // The org.invite_accept row is written on the SAME client inside the SAME
    // transaction, deliberately, so that a tenant cannot exist with no record
    // of its birth. Prove it by taking the audit table away: the org must not
    // survive. This is also the mechanism that made owner_id fatal — any throw
    // inside the transaction unwinds the entire founding.
    mockEngine = newEngine({ tables: ['organizations', 'users', 'org_invitations'] });
    seedIncumbent(mockEngine);
    const inv = seedInvite(mockEngine);
    const r = await accept(inv.token);
    expect(r.status).toBe(500);
    expect(orgs()).toHaveLength(1);
    expect(users()).toHaveLength(1);
    expect(invites()[0].accepted_at).toBeNull();
  });
});
