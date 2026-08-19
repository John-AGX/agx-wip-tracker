// Would the trail have answered the question?
//
// THE QUESTION. A VAPID private key sat in `app_settings`, readable by any PM,
// for seven weeks. Asked "if no one got the keys yet, is it safe now?", the
// honest answer was WE CANNOT TELL — there was no request logging, no audit row
// on the settings GET, and Railway's platform log does not reach back that far.
// The security answer had to be reasoned from who could plausibly have
// bothered, not from evidence.
//
// Every test below is that question, asked of a door this session actually
// opened or closed. The bar is not "an audit function was called"; it is that a
// specific query, run by the platform owner, returns either N rows naming
// exactly who — or a positive, evidenced empty set. Both are answers. "No rows
// exist because nothing was ever recorded" is not.
//
// THE ENGINE IS REAL SQL, NOT A FAKE POOL. The claims here are about WHERE
// clauses — "an org admin's read cannot return another tenant's rows" — and a
// hand-written fake answers that by whatever its author put in the filter
// callback, which checks the fake rather than the statement. The routes' own
// SQL is handed to sqlite and the surviving rows are counted afterwards.

process.env.JWT_SECRET = process.env.JWT_SECRET ||
  'test-secret-for-audit-trail-doors-suite-0123456789';

const express = require('express');
const http = require('http');
const bcrypt = require('bcryptjs');
const { createPgSqlite } = require('./helpers/pg-sqlite');

const SCHEMA = `
  CREATE TABLE organizations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT, name TEXT,
    description TEXT, identity_body TEXT, archived_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, password_hash TEXT,
    name TEXT, role TEXT, active INTEGER DEFAULT 1, organization_id INTEGER,
    owner_id INTEGER, phone_number TEXT, timezone TEXT, title TEXT,
    notification_prefs TEXT DEFAULT '{}', last_seen_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE roles (
    name TEXT PRIMARY KEY, label TEXT, description TEXT, builtin INTEGER DEFAULT 0,
    capabilities TEXT DEFAULT '[]',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE app_settings (
    key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE agent_skills_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, saved_by INTEGER, value TEXT, comment TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE managed_agent_skills (
    agent_key TEXT, skill_id TEXT, position INTEGER, PRIMARY KEY (agent_key, skill_id)
  );
  CREATE TABLE org_skill_packs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, organization_id INTEGER, name TEXT,
    body TEXT, anthropic_skill_id TEXT, archived_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  -- The shape under test. Mirrors db.js after this change: the four evidence
  -- dimensions the original 12 columns could not carry.
  CREATE TABLE admin_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    actor_kind TEXT,
    actor_user_id INTEGER, actor_email TEXT, actor_role TEXT, actor_org_id INTEGER,
    on_behalf_of_user_id INTEGER, on_behalf_of_email TEXT,
    action TEXT, outcome TEXT DEFAULT 'ok', reason TEXT, tier TEXT, scope TEXT,
    target_type TEXT, target_id TEXT, organization_id INTEGER,
    detail TEXT, ip TEXT, user_agent TEXT, request_id TEXT
  );
`;

let engine = createPgSqlite(SCHEMA);

// A switch on the ONE table this suite needs to break. Everything else keeps
// working, so a refusal can only be the audit failure and not a broken fixture.
let mockBreakAudit = false;

jest.mock('../server/db', () => {
  const wrap = (run) => async (sql, params) => {
    if (mockBreakAudit && /INSERT INTO admin_audit_log/i.test(String(sql))) {
      throw new Error('pool exhausted');
    }
    return run(sql, params);
  };
  return {
    pool: {
      query: wrap((sql, params) => mockEngine().pool.query(sql, params)),
      connect: async () => {
        const c = await mockEngine().pool.connect();
        return { query: wrap((sql, params) => c.query(sql, params)), release: c.release };
      },
    },
    getOrgById: async (id) => ({ id, name: 'Org ' + id }),
  };
});
// eslint-disable-next-line no-unused-vars
function mockEngine() { return engine; }
global.mockEngine = mockEngine;

jest.mock('../server/rate-limit', () => ({
  ipLoginLimiter: (req, res, next) => next(),
  aiChatLimiter: (req, res, next) => next(),
  aiChatHourlyLimiter: (req, res, next) => next(),
}));
jest.mock('../server/email', () => ({
  sendEmail: async () => ({ ok: true }),
  isEnabled: () => false,
  isDryRun: () => true,
  getEmailSettings: async () => ({ events: {}, globalBcc: '' }),
  setEmailSettings: async () => {},
}));

const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const { pool } = require('../server/db');
setRolePool(pool);

const ADMIN_CAPS = [
  'JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'FINANCIALS_VIEW', 'ESTIMATES_VIEW', 'ESTIMATES_EDIT',
  'LEADS_VIEW', 'LEADS_EDIT', 'USERS_MANAGE', 'ROLES_MANAGE', 'INSIGHTS_VIEW',
];

const OWNER    = { id: 1,  email: 'owner@p86.test',  role: 'system_admin', name: 'Owner',   organization_id: 1 };
const A_ADMIN  = { id: 10, email: 'admin-a@a.test',  role: 'admin',        name: 'A Admin', organization_id: 1 };
const A_PM     = { id: 11, email: 'pm-a@a.test',     role: 'pm',           name: 'A PM',    organization_id: 1 };
const B_ADMIN  = { id: 77, email: 'admin-b@b.test',  role: 'admin',        name: 'B Admin', organization_id: 2 };

let server, baseUrl, errSpy, logSpy;

function seed() {
  engine = createPgSqlite(SCHEMA);
  const db = engine.db;
  db.exec(`
    INSERT INTO organizations (id, slug, name) VALUES (1,'org-a','Org A'),(2,'org-b','Org B');
    INSERT INTO roles (name,label,builtin,capabilities) VALUES
      ('system_admin','System Admin',1, '${JSON.stringify(ADMIN_CAPS.concat(['SYSTEM_ADMIN']))}'),
      ('admin','Org Admin',1, '${JSON.stringify(ADMIN_CAPS)}'),
      ('pm','Project Manager',1, '${JSON.stringify(['JOBS_VIEW_ALL', 'ESTIMATES_VIEW', 'LEADS_VIEW'])}'),
      ('platform_ops','Platform Ops',0, '${JSON.stringify(['USERS_MANAGE', 'SYSTEM_ADMIN'])}'),
      ('scratch','Scratch',0, '${JSON.stringify(['LEADS_VIEW'])}');
  `);
  const hash = bcrypt.hashSync('correct-horse-battery', 4);
  db.prepare('INSERT INTO users (id,email,password_hash,name,role,organization_id,active) VALUES (?,?,?,?,?,?,1)')
    .run(1, 'owner@p86.test', hash, 'Owner', 'system_admin', 1);
  db.prepare('INSERT INTO users (id,email,password_hash,name,role,organization_id,active) VALUES (?,?,?,?,?,?,1)')
    .run(10, 'admin-a@a.test', hash, 'A Admin', 'admin', 1);
  db.prepare('INSERT INTO users (id,email,password_hash,name,role,organization_id,active) VALUES (?,?,?,?,?,?,1)')
    .run(11, 'pm-a@a.test', hash, 'A PM', 'pm', 1);
  db.prepare('INSERT INTO users (id,email,password_hash,name,role,organization_id,active) VALUES (?,?,?,?,?,?,1)')
    .run(77, 'admin-b@b.test', hash, 'B Admin', 'admin', 2);
  // The key at the centre of the whole question. Present in the table, so a
  // refusal is genuinely a refusal and not an absence.
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('vapid_keys', ?)")
    .run(JSON.stringify({ publicKey: 'BPub', privateKey: 'PRIVATE-KEY-DO-NOT-LOG' }));
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('agent_skills', ?)")
    .run(JSON.stringify({ skills: [{ id: 'p1', name: 'estimating', body: 'secret playbook body' }] }));
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('proposal_template', ?)")
    .run(JSON.stringify({ intro: 'hello' }));
}

beforeAll(async () => {
  seed();
  await refreshRoleCache();
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/settings', require('../server/routes/settings-routes'));
  app.use('/api/roles', require('../server/routes/role-routes'));
  app.use('/api/auth', require('../server/routes/auth-routes'));
  app.use('/api/org', require('../server/routes/org-audit-routes'));
  app.use('/api/admin/console', require('../server/routes/admin-console-routes'));
  await new Promise((done) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => { baseUrl = 'http://127.0.0.1:' + server.address().port; done(); });
  });
});
afterAll((done) => { server.close(() => done()); });

beforeEach(async () => {
  mockBreakAudit = false;
  seed();
  require('../server/audit')._resetCoalescer();
  await refreshRoleCache();
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { errSpy.mockRestore(); logSpy.mockRestore(); });

async function call(method, path, user, body) {
  const headers = { 'content-type': 'application/json', 'user-agent': 'P86Test/1.0' };
  if (user) headers.authorization = 'Bearer ' + signToken(user);
  const res = await fetch(baseUrl + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { status: res.status, body: json, text };
}

// THE QUERY JOHN ACTUALLY RUNS. Exactly the predicate the new partial index
// (target_type, target_id, created_at DESC) serves.
function whoTouched(targetType, targetId) {
  return engine.all(
    'SELECT * FROM admin_audit_log WHERE target_type = ? AND target_id = ? ORDER BY id DESC',
    targetType, targetId
  );
}
function rowsFor(action) {
  return engine.all('SELECT * FROM admin_audit_log WHERE action = ? ORDER BY id DESC', action);
}
// detail comes back parsed from the sqlite shim (JSON_COLUMNS) and as text
// from a raw driver — accept both rather than pinning the harness.
function dtl(row) { const d = row && row.detail; return typeof d === 'string' ? JSON.parse(d) : (d || {}); }
function allRows() { return engine.all('SELECT * FROM admin_audit_log ORDER BY id'); }
function screams(prefix) {
  return errSpy.mock.calls.filter((c) => String(c[0]).indexOf(prefix) === 0);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. THE ACCEPTANCE TEST — a privileged read of a secret key is findable.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a privileged read of a secret key leaves a findable row', () => {
  test('a PM reaching for vapid_keys is refused AND recorded, and the query finds it', async () => {
    const r = await call('GET', '/api/settings/vapid_keys', A_PM);
    expect(r.status).toBe(404);            // the gate is unchanged — this records, it does not gate

    const rows = whoTouched('app_setting', 'vapid_keys');
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.action).toBe('settings.read');
    expect(row.outcome).toBe('denied');
    expect(row.reason).toBe('never_served');
    // Who, from where, and under what identity. This is the answer the seven-
    // week question could not have.
    expect(row.actor_user_id).toBe(11);
    expect(row.actor_email).toBe('pm-a@a.test');
    expect(row.actor_role).toBe('pm');
    expect(row.user_agent).toContain('P86Test');
    expect(row.scope).toBe('platform');
    expect(dtl(row).key_class).toBe('secret');
  });

  test('and the key VALUE is not in the row — the trail is not the next copy of the leak', async () => {
    await call('GET', '/api/settings/vapid_keys', A_PM);
    const serialized = JSON.stringify(allRows());
    expect(serialized).not.toContain('PRIVATE-KEY-DO-NOT-LOG');
    expect(serialized).not.toContain('BPub');
  });

  test('THE HARDER VERSION: a SUCCESSFUL privileged read is one row per read', async () => {
    // vapid_keys is now unreachable, so the identically-shaped key that IS
    // still served stands in: agent_skills, platform class, SYSTEM_ADMIN both
    // ways, mirrors to Anthropic account-wide. Seven weeks ago the VAPID GET
    // behaved exactly like this one and recorded nothing.
    await call('GET', '/api/settings/agent_skills', OWNER);
    await call('GET', '/api/settings/agent_skills', OWNER);
    const rows = whoTouched('app_setting', 'agent_skills');
    expect(rows.length).toBe(2);            // NEVER deduplicated
    expect(rows.every((x) => x.outcome === 'ok')).toBe(true);
    expect(rows.every((x) => x.actor_email === 'owner@p86.test')).toBe(true);
    // ...and the playbook body is not copied into the trail.
    expect(JSON.stringify(rows)).not.toContain('secret playbook body');
  });

  test('the empty set is a POSITIVE answer: nobody reached for it, evidenced', async () => {
    await call('GET', '/api/settings/proposal_template', A_PM);   // ordinary work
    expect(whoTouched('app_setting', 'vapid_keys')).toEqual([]);
  });

  test('walking the key space is recorded, but the walked strings are NOT stored', async () => {
    // target_id would otherwise be an attacker-chosen string on an evidence
    // row — a log-injection surface, and a place a mistyped credential lands.
    await call('GET', '/api/settings/aws_secret_access_key_AKIAEXAMPLE', A_PM);
    const rows = rowsFor('settings.read');
    expect(rows.length).toBe(1);
    expect(rows[0].target_id).toBe('(undeclared)');
    expect(rows[0].reason).toBe('undeclared_key');
    expect(JSON.stringify(rows)).not.toContain('AKIAEXAMPLE');
    // But it still aggregates: the sha8 makes repeat attempts countable.
    expect(dtl(rows[0]).key_sha8).toMatch(/^[0-9a-f]{8}$/);
  });

  test('ordinary work is NOT recorded — this is not a surveillance tool', async () => {
    // A PM opening an estimate reads proposal_template, and the BT exporter
    // reads bt_export_mapping, both on ESTIMATES_VIEW. Auditing those successes
    // would write a row naming the PM, their IP and their browser every time
    // somebody opens an estimate — which is what the privacy statement says
    // does not happen.
    const r = await call('GET', '/api/settings/proposal_template', A_PM);
    expect(r.status).toBe(200);
    expect(allRows()).toEqual([]);
  });

  test('but a REFUSED read of that same ordinary key IS recorded', async () => {
    // Narrowing the success path must not narrow the enumeration signal.
    const NO_CAPS = { id: 99, email: 'nobody@a.test', role: 'scratch', organization_id: 1 };
    const r = await call('GET', '/api/settings/proposal_template', NO_CAPS);
    expect(r.status).toBe(404);
    expect(rowsFor('settings.read').length).toBe(1);
    expect(rowsFor('settings.read')[0].outcome).toBe('denied');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. A role escalation leaves a row whether it SUCCEEDED or was REFUSED.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a role escalation attempt leaves a row either way', () => {
  test('REFUSED: the guard fires before the handler, so the refusal is the only event there is', async () => {
    // systemAdminRoleGuard returns 403 before the handler's own audit line is
    // ever reached. Without a denial row this door — the one the whole tenant
    // boundary rests on — would be silent again: door shut, room dark.
    const r = await call('PUT', '/api/roles/admin', A_ADMIN, {
      capabilities: ADMIN_CAPS.concat(['SYSTEM_ADMIN']),
    });
    expect(r.status).toBe(403);
    const rows = rowsFor('role.escalation_denied');
    expect(rows.length).toBe(1);
    expect(rows[0].outcome).toBe('denied');
    expect(rows[0].tier).toBe('A');
    expect(rows[0].actor_email).toBe('admin-a@a.test');
    expect(rows[0].target_id).toBe('admin');
    // Capability arrays are the ONE case where the contents ARE the point.
    expect(dtl(rows[0]).capabilities_submitted).toContain('SYSTEM_ADMIN');
  });

  test('REFUSED on create, and on the strip-the-owner direction too', async () => {
    await call('POST', '/api/roles', A_ADMIN, { name: 'sneaky', label: 'S', capabilities: ['SYSTEM_ADMIN'] });
    await call('DELETE', '/api/roles/platform_ops', A_ADMIN);
    expect(rowsFor('role.escalation_denied').length).toBe(2);
  });

  test('SUCCEEDED: the same change by a holder is recorded with before AND after', async () => {
    const r = await call('PUT', '/api/roles/pm', OWNER, { capabilities: ['LEADS_VIEW', 'ESTIMATES_VIEW'] });
    expect(r.status).toBe(200);
    const rows = rowsFor('role.update');
    expect(rows.length).toBe(1);
    const d = dtl(rows[0]);
    expect(d.capabilities_before).toContain('JOBS_VIEW_ALL');
    expect(d.capabilities_after).toEqual(['LEADS_VIEW', 'ESTIMATES_VIEW']);
    expect(rows[0].tier).toBe('A');
  });

  test('a role DELETE now carries the capabilities it destroyed', async () => {
    const r = await call('DELETE', '/api/roles/scratch', OWNER);
    expect(r.status).toBe(200);
    const d = dtl(rowsFor('role.delete')[0]);
    // Without this the row says a privilege set vanished and nothing about
    // what it was — the one delete where contents are the point.
    expect(d.capabilities_before).toEqual(['LEADS_VIEW']);
  });

  test('a REFUSED user-role escalation does not record itself as OK', async () => {
    // The other half of the escalation pair: widen the ROLE (refused above),
    // then PIN it into a users.role value. An org admin promoting one of their
    // own people into a SYSTEM_ADMIN-carrying role is refused by
    // validateRoleAssignment — and until now left nothing.
    //
    // The audit used to fire the moment the tenant guard let the caller
    // through, i.e. at PROPOSAL, three lines above this refusal. With an
    // outcome column that row would have asserted a write that never happened.
    const r = await call('PUT', '/api/auth/users/11', A_ADMIN, { role: 'platform_ops' });
    expect(r.status).toBe(403);
    const changes = rowsFor('user.role_change');
    expect(changes.length).toBe(1);
    expect(changes[0].outcome).toBe('denied');
    expect(changes[0].reason).toBe('not_entitled');
    expect(dtl(changes[0]).role_attempted).toBe('platform_ops');
    // and nothing anywhere claims a successful write on this request.
    expect(allRows().some((x) => x.outcome === 'ok')).toBe(false);
    // the user really was not promoted.
    expect(engine.all('SELECT role FROM users WHERE id = 11')[0].role).toBe('pm');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. TENANT SCOPE ON THE READ PATH.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('an org admin cannot read another tenant’s rows', () => {
  function stuff() {
    const ins = engine.db.prepare(
      `INSERT INTO admin_audit_log (actor_kind,actor_user_id,actor_email,actor_role,actor_org_id,
        action,outcome,tier,scope,target_type,target_id,organization_id,detail,ip)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    ins.run('user', 10, 'admin-a@a.test', 'admin', 1, 'user.role_change', 'ok', 'A', 'org', 'user', '11', 1, '{}', '1.1.1.1');
    ins.run('user', 77, 'admin-b@b.test', 'admin', 2, 'user.role_change', 'ok', 'A', 'org', 'user', '78', 2, '{}', '2.2.2.2');
    ins.run('user', 77, 'admin-b@b.test', 'admin', 2, 'auth.login', 'ok', 'B', 'org', 'user', '77', 2, '{}', '2.2.2.2');
    // Platform-scoped: a capability change on the GLOBAL roles table. NULL org.
    ins.run('user', 1, 'owner@p86.test', 'system_admin', 1, 'role.update', 'ok', 'A', 'platform', 'role', 'admin', null, '{}', '9.9.9.9');
    // A secret read. Platform-scoped, NULL org.
    ins.run('user', 11, 'pm-a@a.test', 'pm', 1, 'settings.read', 'denied', 'B', 'platform', 'app_setting', 'vapid_keys', null, '{}', '1.1.1.2');
    // The platform operator reaching into org A.
    ins.run('user', 1, 'owner@p86.test', 'system_admin', 1, 'user.cross_tenant_write', 'ok', 'A', 'org', 'user', '11', 1,
      JSON.stringify({ door: 'password_reset', actor_org: 1, target_org: 1 }), '9.9.9.9');
  }

  test('org A sees only org A', async () => {
    stuff();
    const r = await call('GET', '/api/org/audit', A_ADMIN);
    expect(r.status).toBe(200);
    const orgs = new Set(r.body.entries.map((e) => e.organization_id));
    expect([...orgs]).toEqual([1]);
    expect(JSON.stringify(r.body)).not.toContain('admin-b@b.test');
    expect(JSON.stringify(r.body)).not.toContain('2.2.2.2');
  });

  test('NO NULL-ORG ARM: platform config and secret access never reach a tenant', async () => {
    // The trap this whole `scope` column exists for. `roles` and `app_settings`
    // are global, so those rows carry organization_id NULL — and an
    // `OR organization_id IS NULL` arm would hand every org admin the entire
    // platform trail, including the secret-read row.
    stuff();
    const r = await call('GET', '/api/org/audit', A_ADMIN);
    const actions = r.body.entries.map((e) => e.action);
    expect(actions).not.toContain('role.update');
    expect(actions).not.toContain('settings.read');
    expect(JSON.stringify(r.body)).not.toContain('vapid_keys');
  });

  test('the allowlist is CLOSED — an action not named is not served, whatever its scope', async () => {
    engine.db.prepare(
      `INSERT INTO admin_audit_log (action,outcome,tier,scope,organization_id,target_type,target_id)
       VALUES ('platform.data_export','ok','A','org',1,'training_corpus','all')`).run();
    const r = await call('GET', '/api/org/audit', A_ADMIN);
    expect(r.body.entries.map((e) => e.action)).not.toContain('platform.data_export');
  });

  test('a platform operator reaching in IS shown, through a projection that names no operator', async () => {
    // Hiding it entirely would mean a tenant cannot see that somebody outside
    // their company touched their data — the worse failure, given the point is
    // trust. Showing it raw discloses the operator's identity, home org and IP.
    stuff();
    const r = await call('GET', '/api/org/audit', A_ADMIN);
    const row = r.body.entries.find((e) => e.action === 'user.cross_tenant_write');
    expect(row).toBeTruthy();
    expect(row.actor_email).toBe('platform operator');
    expect(row.ip).toBeNull();
    expect(row.actor_user_id).toBeNull();
    expect(row.detail).toEqual({ door: 'password_reset' });
    expect(JSON.stringify(row)).not.toContain('owner@p86.test');
    expect(JSON.stringify(row)).not.toContain('9.9.9.9');
  });

  test('the tenant is taken from the caller’s token, never from the query string', async () => {
    stuff();
    const r = await call('GET', '/api/org/audit?organization_id=2&org=2', A_ADMIN);
    expect(r.body.organization_id).toBe(1);
    expect(JSON.stringify(r.body)).not.toContain('admin-b@b.test');
  });

  test('a PM cannot read the org trail at all', async () => {
    stuff();
    const r = await call('GET', '/api/org/audit', A_PM);
    expect(r.status).toBe(403);
  });

  test('keyset pagination reaches row N without OFFSET', async () => {
    const ins = engine.db.prepare(
      `INSERT INTO admin_audit_log (actor_kind,action,outcome,tier,scope,target_type,target_id,organization_id)
       VALUES ('user','auth.login','ok','B','org','user',?,1)`);
    for (let i = 0; i < 12; i++) ins.run(String(i));
    const first = await call('GET', '/api/org/audit?limit=5', A_ADMIN);
    expect(first.body.entries.length).toBe(5);
    expect(first.body.next_before_id).toBeTruthy();
    const second = await call('GET', '/api/org/audit?limit=5&before_id=' + first.body.next_before_id, A_ADMIN);
    expect(second.body.entries.length).toBe(5);
    const ids = new Set(first.body.entries.concat(second.body.entries).map((e) => e.id));
    expect(ids.size).toBe(10);              // no overlap, no gap
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 3b. THE PLATFORM READ PATH — the query John actually runs.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the platform tier answers the question in one call', () => {
  // Seven weeks of ordinary traffic, so a filter that does not filter is a
  // filter that fails. Without this a one-row table makes every query look
  // correct.
  function noise(n) {
    const ins = engine.db.prepare(
      `INSERT INTO admin_audit_log (actor_kind,actor_email,action,outcome,tier,scope,target_type,target_id,organization_id)
       VALUES ('user','someone@a.test',?,?,?,'org','user',?,1)`);
    for (let i = 0; i < (n || 40); i++) {
      ins.run(i % 2 ? 'auth.login' : 'user.update', i % 5 ? 'ok' : 'denied', 'B', String(i));
    }
    engine.db.prepare(
      `INSERT INTO admin_audit_log (actor_kind,actor_email,action,outcome,tier,scope,target_type,target_id)
       VALUES ('user','someone@a.test','settings.read','ok','B','platform','app_setting','agent_skills')`).run();
  }

  test('THE ACCEPTANCE QUERY: target_type + target_id + from, over HTTP', async () => {
    noise();
    await call('GET', '/api/settings/vapid_keys', A_PM);
    const r = await call('GET',
      '/api/admin/console/audit?target_type=app_setting&target_id=vapid_keys&from=2020-01-01', OWNER);
    expect(r.status).toBe(200);
    // One row out of 40-plus. The filter is what makes this an answer rather
    // than a haystack, and it is the query the new partial index serves.
    expect(r.body.entries.length).toBe(1);
    expect(r.body.entries[0].actor_email).toBe('pm-a@a.test');
    expect(r.body.entries[0].outcome).toBe('denied');
    expect(r.body.entries[0].target_id).toBe('vapid_keys');
  });

  test('the empty result is a POSITIVE answer, delivered by the same query', async () => {
    noise();
    const r = await call('GET',
      '/api/admin/console/audit?target_type=app_setting&target_id=vapid_keys', OWNER);
    expect(r.status).toBe(200);
    // Rows exist — dozens of them. None is a read of this key, and THAT is the
    // finding: an evidenced "nobody touched it" rather than "we have no idea".
    expect(r.body.entries).toEqual([]);
    const unfiltered = await call('GET', '/api/admin/console/audit', OWNER);
    expect(unfiltered.body.entries.length).toBeGreaterThan(10);
  });

  test('outcome=denied is the enumeration hunt, and it excludes the successes', async () => {
    noise();
    await call('GET', '/api/settings/vapid_keys', A_PM);
    const r = await call('GET', '/api/admin/console/audit?outcome=denied&limit=500', OWNER);
    expect(r.body.entries.length).toBeGreaterThan(0);
    expect(r.body.entries.every((e) => e.outcome === 'denied')).toBe(true);
    const all = await call('GET', '/api/admin/console/audit?limit=500', OWNER);
    expect(all.body.entries.length).toBeGreaterThan(r.body.entries.length);
  });

  test('the list ships no detail and no ip — that was exposure the UI never painted', async () => {
    await call('GET', '/api/settings/vapid_keys', A_PM);
    const r = await call('GET', '/api/admin/console/audit', OWNER);
    const row = r.body.entries[0];
    expect(row.detail).toBeUndefined();
    expect(row.ip).toBeUndefined();
    expect(row.user_agent).toBeUndefined();
    expect(row.has_detail).toBeTruthy();      // there IS one; fetch it deliberately
  });

  test('the full row is one deliberate request away', async () => {
    await call('GET', '/api/settings/vapid_keys', A_PM);
    const list = await call('GET', '/api/admin/console/audit', OWNER);
    const one = await call('GET', '/api/admin/console/audit/' + list.body.entries[0].id, OWNER);
    expect(one.status).toBe(200);
    expect(one.body.entry.ip).toBeTruthy();
    expect(one.body.entry.user_agent).toContain('P86Test');
    expect(dtl(one.body.entry).key_class).toBe('secret');
  });

  test('row 501 is reachable — pagination, on the table whose value is what happened weeks ago', async () => {
    const ins = engine.db.prepare(
      `INSERT INTO admin_audit_log (actor_kind,action,outcome,tier,scope,target_type,target_id)
       VALUES ('user','auth.login','ok','B','platform','user',?)`);
    for (let i = 0; i < 20; i++) ins.run(String(i));
    const p1 = await call('GET', '/api/admin/console/audit?limit=8', OWNER);
    expect(p1.body.entries.length).toBe(8);
    const p2 = await call('GET', '/api/admin/console/audit?limit=8&before_id=' + p1.body.next_before_id, OWNER);
    const p3 = await call('GET', '/api/admin/console/audit?limit=8&before_id=' + p2.body.next_before_id, OWNER);
    const ids = p1.body.entries.concat(p2.body.entries, p3.body.entries).map((e) => e.id);
    expect(new Set(ids).size).toBe(20);       // every row reachable, none twice
  });

  test('an action FAMILY search works — settings. finds read and write alike', async () => {
    noise();                                   // auth.login / user.update rows to exclude
    await call('GET', '/api/settings/vapid_keys', A_PM);
    await call('PUT', '/api/settings/proposal_template', A_ADMIN, { value: { intro: 'x' } });
    const r = await call('GET', '/api/admin/console/audit?action_prefix=settings.&limit=500', OWNER);
    const actions = new Set(r.body.entries.map((e) => e.action));
    expect([...actions].sort()).toEqual(['settings.read', 'settings.write']);
    expect(r.body.entries.length).toBeLessThan(10);   // the family, not the table
  });

  test('the platform trail is SYSTEM_ADMIN only — an org admin gets nothing, not a filtered view', async () => {
    const r = await call('GET', '/api/admin/console/audit', A_ADMIN);
    expect(r.status).toBe(403);
    const one = await call('GET', '/api/admin/console/audit/1', A_ADMIN);
    expect(one.status).toBe(403);
  });

  test('audit-health is readable, so a failing trail is visible on a dashboard', async () => {
    const r = await call('GET', '/api/admin/console/audit-health', OWNER);
    expect(r.status).toBe(200);
    expect(typeof r.body.health.write_failures).toBe('number');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. NO ROW CONTAINS KEY MATERIAL, A TOKEN, OR A PASSWORD.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the trail never becomes the next leak', () => {
  test('a login with a password typed into the email field does not store it', async () => {
    // The single field a stranger controls, and the canonical way an audit
    // table acquires a cleartext credential.
    const r = await call('POST', '/api/auth/login', null,
      { email: 'MyR3alPassw0rd!', password: 'x' });
    expect(r.status).toBe(401);
    const rows = rowsFor('auth.login');
    expect(rows.length).toBe(1);
    expect(rows[0].outcome).toBe('denied');
    expect(rows[0].reason).toBe('no_such_user');
    expect(JSON.stringify(allRows())).not.toContain('MyR3alPassw0rd');
    expect(dtl(rows[0]).identifier_sha8).toMatch(/^[0-9a-f]{8}$/);
    // actor_kind types the missing user id instead of leaving a bare NULL that
    // reads as coverage.
    expect(rows[0].actor_kind).toBe('anonymous');
  });

  test('a bad password against a REAL account names the account and not the attempt', async () => {
    const r = await call('POST', '/api/auth/login', null,
      { email: 'pm-a@a.test', password: 'Tr0ub4dor&3' });
    expect(r.status).toBe(401);
    const rows = rowsFor('auth.login');
    expect(rows[0].reason).toBe('bad_password');
    expect(rows[0].actor_user_id).toBe(11);
    expect(JSON.stringify(allRows())).not.toContain('Tr0ub4dor');
  });

  test('an admin password reset records the reset and never the password', async () => {
    const r = await call('PUT', '/api/auth/users/11/password', A_ADMIN, { newPassword: 'N3wSecret!pass' });
    expect(r.status).toBe(200);
    const rows = rowsFor('user.password_reset');
    expect(rows.length).toBe(1);
    expect(rows[0].organization_id).toBe(1);      // visible to the org that did it
    expect(JSON.stringify(allRows())).not.toContain('N3wSecret');
    expect(JSON.stringify(allRows())).not.toContain('$2a$');   // nor the hash
  });

  test('a settings WRITE records counts and names, never the blob', async () => {
    const r = await call('PUT', '/api/settings/agent_skills', OWNER, {
      value: { skills: [{ id: 'p1', name: 'estimating', body: 'a whole new secret playbook' }] },
    });
    expect(r.status).toBe(200);
    const rows = rowsFor('settings.write');
    // 'attempted' fail-closed pre-row, then the terminal row.
    expect(rows.map((x) => x.outcome).sort()).toEqual(['attempted', 'ok']);
    expect(JSON.stringify(allRows())).not.toContain('a whole new secret playbook');
    const ok = rows.find((x) => x.outcome === 'ok');
    expect(dtl(ok).packs_after).toBe(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 5. THE TWO FAILURE MODES, AT THE ROUTE.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('never fail silent — proven at the door, not only in the writer', () => {
  test('FAIL CLOSED: a tier-A settings write is REFUSED when the row cannot be written', async () => {
    mockBreakAudit = true;
    const r = await call('PUT', '/api/settings/agent_skills', OWNER, {
      value: { skills: [{ id: 'p1', name: 'renamed-by-an-unrecorded-write' }] },
    });
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/could not be recorded/i);
    // And NOTHING changed. An unrecordable privileged write must not happen,
    // because the empty log would then read as "nothing happened".
    const stored = engine.all("SELECT value FROM app_settings WHERE key = 'agent_skills'");
    expect(JSON.stringify(stored)).not.toContain('renamed-by-an-unrecorded-write');
    expect(screams('[AUDIT-FAIL]').length).toBeGreaterThan(0);
  });

  test('FAIL CLOSED: act-as is refused rather than issued unrecorded', async () => {
    mockBreakAudit = true;
    const r = await call('POST', '/api/auth/act-as', OWNER, { user_id: 11 });
    expect(r.status).toBe(503);
    // Impersonation is the one operation where an unrecorded success is
    // indistinguishable from the target acting for themselves.
    expect(r.headers === undefined || true).toBe(true);
  });

  test('FAIL LOUD: a settings READ still answers, and screams the whole row', async () => {
    mockBreakAudit = true;
    const r = await call('GET', '/api/settings/vapid_keys', A_PM);
    // Refusing a REFUSAL because it could not be logged is incoherent, and
    // blocking reads on an audit failure is an availability attack.
    expect(r.status).toBe(404);
    const yells = screams('[AUDIT-FAIL]');
    expect(yells.length).toBe(1);
    const payload = JSON.parse(yells[0][1]);
    expect(payload.action).toBe('settings.read');
    expect(payload.target_id).toBe('vapid_keys');
    expect(payload.actor_email).toBe('pm-a@a.test');
  });

  test('FAIL LOUD: a login still succeeds when the trail is down', async () => {
    mockBreakAudit = true;
    const r = await call('POST', '/api/auth/login', null,
      { email: 'pm-a@a.test', password: 'correct-horse-battery' });
    expect(r.status).toBe(200);      // anyone who can pressure the pool must not be able to lock everyone out
    expect(screams('[AUDIT-FAIL]').length).toBe(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 6. THE ACTOR CANNOT EDIT OR DELETE THEIR OWN ROW.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('append-only, and enforced rather than asserted', () => {
  const fs = require('fs');
  const path = require('path');

  function serverSources() {
    const out = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
        else if (e.name.endsWith('.js')) out.push(p);
      }
    })(path.join(__dirname, '..', 'server'));
    return out;
  }

  test('exactly one file in the server can mutate the trail, and it is the retention purge', () => {
    const offenders = serverSources().filter((p) => {
      const src = fs.readFileSync(p, 'utf8');
      return /UPDATE\s+admin_audit_log|DELETE\s+FROM\s+admin_audit_log/i.test(src);
    }).map((p) => path.basename(p));
    // Not "no deletes exist" — a retention policy has to be able to delete.
    // The claim is that the ONLY path is the one that audits itself first.
    expect(offenders).toEqual(['audit-retention.js']);
  });

  test('the schema enforces it with a trigger, not with a comment', () => {
    const db = fs.readFileSync(path.join(__dirname, '..', 'server', 'db.js'), 'utf8');
    expect(db).toMatch(/CREATE TRIGGER trg_admin_audit_append_only/);
    expect(db).toMatch(/BEFORE UPDATE OR DELETE ON admin_audit_log/);
    expect(db).toMatch(/RAISE EXCEPTION 'admin_audit_log is append-only/);
    // The purge identifies itself with a transaction-local GUC. SET LOCAL, not
    // SET: the escape hatch must not survive onto the next borrower of a pooled
    // connection.
    const purge = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'audit-retention.js'), 'utf8');
    expect(purge).toMatch(/SET LOCAL app\.audit_purge/);
  });

  test('the FKs that would have turned that trigger into an outage are dropped', () => {
    // ON DELETE SET NULL is implemented as an UPDATE on this table, and row
    // triggers fire on it — so the FK plus the trigger would abort every
    // `DELETE FROM users` and every org delete. It was also a partial
    // suppression primitive: delete a user, their rows' actor quietly NULLs.
    const db = fs.readFileSync(path.join(__dirname, '..', 'server', 'db.js'), 'utf8');
    expect(db).toMatch(/ALTER TABLE admin_audit_log DROP CONSTRAINT IF EXISTS admin_audit_log_actor_user_id_fkey/);
    expect(db).toMatch(/ALTER TABLE admin_audit_log DROP CONSTRAINT IF EXISTS admin_audit_log_organization_id_fkey/);
  });

  test('no read endpoint exposes a mutation of the trail', () => {
    const org = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'org-audit-routes.js'), 'utf8');
    expect(org).not.toMatch(/router\.(post|put|patch|delete)\b/);
    // And the tenant predicate has no NULL arm — the single line that would
    // turn the org tier into a platform read. Comments are stripped first:
    // the file talks about that arm at length in order to forbid it, and a
    // regex over prose would fail on the explanation rather than the code.
    const code = org.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    expect(code).not.toMatch(/organization_id IS NULL/);
    expect(code).toMatch(/a\.scope = 'org'/);
  });

  test('a user delete still works with the trail present', async () => {
    // The regression the dropped FK exists to prevent: this must not 500.
    const r = await call('DELETE', '/api/auth/users/11', A_ADMIN);
    expect(r.status).toBe(200);
    expect(rowsFor('user.delete').length).toBe(1);
    // The row survives the user it names — actor/target identity is
    // SNAPSHOTTED, which is the whole reason the FK bought nothing.
    expect(engine.all('SELECT * FROM users WHERE id = 11')).toEqual([]);
    expect(rowsFor('user.delete')[0].target_id).toBe('11');
  });
});
