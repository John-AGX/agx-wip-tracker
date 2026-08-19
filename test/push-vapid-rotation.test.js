/* ──────────────────────────────────────────────────────────────────────────
 * ROTATING THE PLATFORM'S PUSH SIGNING KEY
 *
 * The VAPID private key was readable by any PM in any tenant through the
 * generic app_settings endpoint until 2026-08-17 (see
 * test/app-settings-key-space.test.js, which closed the read). The key itself
 * is still the one that leaked, so it has to be replaceable — and the control
 * that replaces it is destructive in a way server/push.js understates.
 *
 * WHAT THE PRODUCT COPY HAD TO GET RIGHT, and what these tests pin:
 *   · the door is SYSTEM_ADMIN, both the status read and the rotation;
 *   · a wrong confirmation leaves the stored row BYTE-IDENTICAL, because the
 *     phrase is checked before anything is read or deleted;
 *   · the rotation is recorded in admin_audit_log;
 *   · NO KEY MATERIAL reaches a response, a log line, or an error path — the
 *     endpoint that rotates a leaked key must not become the second leak;
 *   · a count that cannot be taken is reported as null, never as 0. "0 devices
 *     affected" because a COUNT threw is how a destructive button gets clicked
 *     on a false premise.
 *
 * REAL ENGINE. The load-bearing claim in the confirmation test is "the row was
 * not touched", which is a claim about what a statement did to a database. So
 * the SQL the route actually emits runs on node:sqlite via
 * test/helpers/pg-sqlite.js and the surviving bytes are compared afterwards.
 * ────────────────────────────────────────────────────────────────────────── */

process.env.JWT_SECRET = process.env.JWT_SECRET ||
  'test-secret-for-push-vapid-rotation-suite-0123456789abcdef';

const express = require('express');
const http = require('http');
const { createPgSqlite } = require('./helpers/pg-sqlite');

const SCHEMA = `
  CREATE TABLE roles (name TEXT PRIMARY KEY, capabilities TEXT);
  CREATE TABLE organizations (id INTEGER PRIMARY KEY, slug TEXT, name TEXT, archived_at TEXT);
  CREATE TABLE users (id INTEGER PRIMARY KEY, organization_id INTEGER);
  CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
  CREATE TABLE push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, endpoint TEXT UNIQUE,
    p256dh TEXT, auth TEXT, user_agent TEXT, last_used_at TEXT
  );
  CREATE TABLE admin_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    actor_user_id INTEGER, actor_email TEXT, actor_role TEXT, action TEXT,
    target_type TEXT, target_id TEXT, organization_id INTEGER, actor_org_id INTEGER,
    detail TEXT, ip TEXT
  );
`;

let engine = createPgSqlite(SCHEMA);

jest.mock('../server/db', () => ({
  pool: {
    query: async (sql, params) => require('./push-vapid-rotation.test.js.engine')().pool.query(sql, params),
    connect: async () => ({
      query: async (sql, params) => require('./push-vapid-rotation.test.js.engine')().pool.query(sql, params),
      release: () => {}
    })
  }
}));
jest.mock('./push-vapid-rotation.test.js.engine', () => () => globalThis.__P86_PUSH_ENGINE__, { virtual: true });
globalThis.__P86_PUSH_ENGINE__ = engine;

const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const { pool } = require('../server/db');
setRolePool(pool);

// The exact bytes that must never escape. Distinctive on purpose: every
// leak assertion below is a substring search for this string across the raw
// HTTP response and across everything the route wrote to the console.
const PRIVATE_KEY = 'VAPID-PRIVATE-KEY-MATERIAL-MUST-NEVER-ESCAPE-9f3a';
const PUBLIC_KEY = 'VAPID-PUBLIC-KEY-BQ7x';
const STORED_JSON = JSON.stringify({ publicKey: PUBLIC_KEY, privateKey: PRIVATE_KEY });

const ADMIN_CAPS = [
  'JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'FINANCIALS_VIEW', 'ESTIMATES_VIEW',
  'ESTIMATES_EDIT', 'LEADS_VIEW', 'LEADS_EDIT', 'USERS_MANAGE', 'ROLES_MANAGE',
  'INSIGHTS_VIEW', 'ADMIN_METRICS'
];
const ORG_ADMIN = { id: 10, email: 'admin-a@a.test', role: 'admin', name: 'A Admin', organization_id: 1 };
const PM = { id: 11, email: 'pm@a.test', role: 'pm', name: 'PM', organization_id: 1 };
const OWNER = { id: 1, email: 'owner@p86.test', role: 'system_admin', name: 'Owner', organization_id: 1 };

const ROTATE_PHRASE = 'ROTATE PUSH KEYS';

function seed(opts) {
  opts = opts || {};
  globalThis.__P86_PUSH_ENGINE__ = engine = createPgSqlite(SCHEMA);
  const db = engine.db;
  const ins = (sql, ...a) => db.prepare(sql).run(...a);

  ins('INSERT INTO roles (name, capabilities) VALUES (?, ?)',
    'system_admin', JSON.stringify(ADMIN_CAPS.concat(['SYSTEM_ADMIN'])));
  ins('INSERT INTO roles (name, capabilities) VALUES (?, ?)', 'admin', JSON.stringify(ADMIN_CAPS));
  ins('INSERT INTO roles (name, capabilities) VALUES (?, ?)', 'pm', JSON.stringify(['JOBS_VIEW_ALL']));

  ins('INSERT INTO organizations (id, slug, name) VALUES (?,?,?)', 1, 'agx', 'AGX');
  ins('INSERT INTO users (id, organization_id) VALUES (?,?)', 10, 1);
  ins('INSERT INTO users (id, organization_id) VALUES (?,?)', 11, 1);
  ins('INSERT INTO users (id, organization_id) VALUES (?,?)', 1, 1);

  if (opts.noRow !== true) {
    ins('INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?)', 'vapid_keys', STORED_JSON, 't0');
  }
  // A second row, so a DELETE that forgets its WHERE is visible as a
  // collateral loss rather than as a passing test.
  ins('INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?)',
    'agent_skills', JSON.stringify({ skills: [] }), 't0');

  // Three devices across two people.
  ins('INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?,?,?,?)', 10, 'https://fcm/a', 'p1', 'a1');
  ins('INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?,?,?,?)', 10, 'https://fcm/b', 'p2', 'a2');
  ins('INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?,?,?,?)', 11, 'https://fcm/c', 'p3', 'a3');
}

// Raw TEXT, undecoded — a byte-identity claim must not go through the JSON
// round-trip the pg shim applies to `value` columns.
function storedRaw() {
  const r = engine.db.prepare("SELECT value FROM app_settings WHERE key = 'vapid_keys'").all();
  return r.length ? r[0].value : null;
}
function settingsKeys() {
  return engine.db.prepare('SELECT key FROM app_settings ORDER BY key').all().map((r) => r.key);
}
function auditRows(action) {
  return engine.all('SELECT * FROM admin_audit_log WHERE action = ?', action);
}

let server, baseUrl;

// Everything the route prints, captured, so "no key material in a log line"
// is checked against what was actually emitted rather than assumed from a
// reading of the source.
let logged = [];
const REAL = {};
function captureConsole() {
  logged = [];
  ['log', 'warn', 'error'].forEach((m) => {
    REAL[m] = console[m];
    console[m] = function () {
      logged.push(Array.prototype.map.call(arguments, (a) => {
        try { return typeof a === 'string' ? a : JSON.stringify(a); } catch (e) { return String(a); }
      }).join(' '));
    };
  });
}
function restoreConsole() {
  ['log', 'warn', 'error'].forEach((m) => { if (REAL[m]) console[m] = REAL[m]; });
}

function req(method, urlPath, user, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const u = new URL(baseUrl + urlPath);
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: Object.assign(
        { Authorization: 'Bearer ' + signToken(user) },
        payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}
      )
    }, (resp) => {
      let raw = '';
      resp.on('data', (c) => { raw += c; });
      resp.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (e) { /* non-JSON */ }
        resolve({ status: resp.statusCode, body: json, raw });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

beforeAll(async () => {
  seed();
  await refreshRoleCache();
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/admin/push', require('../server/routes/admin-push-routes'));
  // Mounted alongside because the boundary REPORT is the other half of what
  // this wave put in front of an operator, and it is behind the same door.
  app.use('/api/admin/console', require('../server/routes/admin-console-routes'));
  await new Promise((done) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      baseUrl = 'http://127.0.0.1:' + server.address().port;
      done();
    });
  });
});

afterAll((done) => { restoreConsole(); server.close(() => done()); });

beforeEach(async () => {
  seed();
  await refreshRoleCache();
  captureConsole();
});
afterEach(() => { restoreConsole(); });

// ── the door ──────────────────────────────────────────────────────────────
describe('the door is SYSTEM_ADMIN', () => {
  test('an org admin cannot rotate, and the row survives untouched', async () => {
    const before = storedRaw();
    const r = await req('POST', '/api/admin/push/rotate-vapid', ORG_ADMIN, { confirm: ROTATE_PHRASE });
    expect(r.status).toBe(403);
    expect(storedRaw()).toBe(before);
    expect(storedRaw()).toBe(STORED_JSON);
  });

  test('a PM cannot rotate', async () => {
    const r = await req('POST', '/api/admin/push/rotate-vapid', PM, { confirm: ROTATE_PHRASE });
    expect(r.status).toBe(403);
    expect(storedRaw()).toBe(STORED_JSON);
  });

  test('an org admin cannot even read the status', async () => {
    const r = await req('GET', '/api/admin/push/vapid-status', ORG_ADMIN);
    expect(r.status).toBe(403);
  });

  test('the platform owner can read the status', async () => {
    const r = await req('GET', '/api/admin/push/vapid-status', OWNER);
    expect(r.status).toBe(200);
    expect(r.body.stored_row_present).toBe(true);
    expect(r.body.subscriptions).toBe(3);
    expect(r.body.users_affected).toBe(2);
  });
});

// ── the boundary report is behind the same door ───────────────────────────
// The report enumerates every tenant-scoped table in the platform, the id of
// every un-stamped row, and exactly which arms are load-bearing. That is a map
// of the boundary's weak points, and it is cross-tenant by construction — so
// it belongs to the platform owner, same as the rotation.
describe('the tenant-boundary report is SYSTEM_ADMIN-only', () => {
  test('an org admin cannot read the report', async () => {
    const r = await req('GET', '/api/admin/console/org-boundary', ORG_ADMIN);
    expect(r.status).toBe(403);
  });

  test('a PM cannot read the report', async () => {
    const r = await req('GET', '/api/admin/console/org-boundary', PM);
    expect(r.status).toBe(403);
  });

  test('an org admin cannot run the backfill, dry or otherwise', async () => {
    const dry = await req('POST', '/api/admin/console/org-boundary/backfill', ORG_ADMIN, { dry_run: true });
    expect(dry.status).toBe(403);
    const wet = await req('POST', '/api/admin/console/org-boundary/backfill', ORG_ADMIN, { dry_run: false });
    expect(wet.status).toBe(403);
  });
});

// ── the typed confirmation ────────────────────────────────────────────────
describe('the typed confirmation is checked BEFORE the destructive step', () => {
  const WRONG = [
    ['an empty body', undefined],
    ['no confirm field', {}],
    ['the wrong phrase', { confirm: 'rotate the keys' }],
    ['the right phrase in the wrong case', { confirm: 'rotate push keys' }],
    ['the phrase with trailing whitespace', { confirm: ROTATE_PHRASE + ' ' }],
    ['a non-string', { confirm: 42 }],
    ['a boolean true, the classic truthy bypass', { confirm: true }]
  ];

  WRONG.forEach(([label, body]) => {
    test('refuses ' + label + ' and leaves the row byte-identical', async () => {
      const before = storedRaw();
      expect(before).toBe(STORED_JSON);
      const r = await req('POST', '/api/admin/push/rotate-vapid', OWNER, body);
      expect(r.status).toBe(400);
      expect(r.body.rotated).toBe(false);
      // Byte-identical, not merely "still present".
      expect(storedRaw()).toBe(before);
      expect(settingsKeys()).toEqual(['agent_skills', 'vapid_keys']);
      // A refusal must not have written an audit row either — nothing happened.
      expect(auditRows('push.vapid_rotate')).toHaveLength(0);
    });
  });

  test('a refusal names the exact phrase required', async () => {
    const r = await req('POST', '/api/admin/push/rotate-vapid', OWNER, { confirm: 'nope' });
    expect(r.body.error).toContain(ROTATE_PHRASE);
  });

  test('the exact phrase deletes the stored row and nothing else', async () => {
    const r = await req('POST', '/api/admin/push/rotate-vapid', OWNER, { confirm: ROTATE_PHRASE });
    expect(r.status).toBe(200);
    expect(r.body.rotated).toBe(true);
    expect(r.body.rows_removed).toBe(1);
    expect(storedRaw()).toBeNull();
    // The neighbouring global row is untouched — the DELETE was keyed.
    expect(settingsKeys()).toEqual(['agent_skills']);
  });

  test('subscriptions are NOT deleted — the rows outlive the key, which is the point', async () => {
    await req('POST', '/api/admin/push/rotate-vapid', OWNER, { confirm: ROTATE_PHRASE });
    expect(engine.all('SELECT id FROM push_subscriptions')).toHaveLength(3);
  });
});

// ── the audit row ─────────────────────────────────────────────────────────
describe('the rotation is recorded', () => {
  test('writes one admin_audit_log row naming the actor and the blast radius', async () => {
    await req('POST', '/api/admin/push/rotate-vapid', OWNER, { confirm: ROTATE_PHRASE });
    const rows = auditRows('push.vapid_rotate');
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_user_id).toBe(OWNER.id);
    expect(rows[0].actor_email).toBe(OWNER.email);
    expect(rows[0].target_type).toBe('app_settings');
    expect(rows[0].target_id).toBe('vapid_keys');
    const detail = typeof rows[0].detail === 'string' ? JSON.parse(rows[0].detail) : rows[0].detail;
    expect(detail.rows_removed).toBe(1);
    expect(detail.subscriptions_invalidated).toBe(3);
    expect(detail.restart_required).toBe(true);
  });

  test('the audit detail carries no key material', async () => {
    await req('POST', '/api/admin/push/rotate-vapid', OWNER, { confirm: ROTATE_PHRASE });
    const rows = auditRows('push.vapid_rotate');
    expect(JSON.stringify(rows)).not.toContain(PRIVATE_KEY);
    expect(JSON.stringify(rows)).not.toContain(PUBLIC_KEY);
  });
});

// ── the thing this endpoint exists to protect ─────────────────────────────
describe('no key material escapes, by any path', () => {
  test('the rotation response body contains neither half of the pair', async () => {
    const r = await req('POST', '/api/admin/push/rotate-vapid', OWNER, { confirm: ROTATE_PHRASE });
    expect(r.raw).not.toContain(PRIVATE_KEY);
    expect(r.raw).not.toContain(PUBLIC_KEY);
  });

  test('the REFUSAL response body contains neither half either', async () => {
    const r = await req('POST', '/api/admin/push/rotate-vapid', OWNER, { confirm: 'wrong' });
    expect(r.raw).not.toContain(PRIVATE_KEY);
    expect(r.raw).not.toContain(PUBLIC_KEY);
  });

  test('the status response contains neither half', async () => {
    const r = await req('GET', '/api/admin/push/vapid-status', OWNER);
    expect(r.raw).not.toContain(PRIVATE_KEY);
    expect(r.raw).not.toContain(PUBLIC_KEY);
  });

  test('nothing the route logged contains key material', async () => {
    await req('GET', '/api/admin/push/vapid-status', OWNER);
    await req('POST', '/api/admin/push/rotate-vapid', OWNER, { confirm: 'wrong' });
    await req('POST', '/api/admin/push/rotate-vapid', OWNER, { confirm: ROTATE_PHRASE });
    const all = logged.join('\n');
    expect(all).not.toContain(PRIVATE_KEY);
    expect(all).not.toContain(PUBLIC_KEY);
    // And it did log SOMETHING about the rotation, so the absence above is
    // not just an absence of logging.
    expect(all).toContain('VAPID row deleted');
  });

  test('no statement the route ran ever selected the value column of the key row', async () => {
    await req('GET', '/api/admin/push/vapid-status', OWNER);
    await req('POST', '/api/admin/push/rotate-vapid', OWNER, { confirm: ROTATE_PHRASE });
    const touching = engine.log.filter((s) => /vapid_keys/.test(s.sql));
    expect(touching.length).toBeGreaterThan(0);
    touching.forEach((s) => {
      // COUNT and DELETE only. A SELECT of `value`, or any RETURNING, would
      // pull the private key into the process for no reason.
      expect(s.sql).not.toMatch(/SELECT\s+value/i);
      expect(s.sql).not.toMatch(/RETURNING/i);
      expect(s.sql).toMatch(/^(SELECT COUNT|DELETE)/i);
    });
  });
});

// ── unknown is not zero ───────────────────────────────────────────────────
describe('a count that cannot be taken is reported as unknown, never as zero', () => {
  test('status reports null subscriptions when the table cannot be read', async () => {
    engine.db.exec('DROP TABLE push_subscriptions');
    const r = await req('GET', '/api/admin/push/vapid-status', OWNER);
    expect(r.status).toBe(200);
    expect(r.body.subscriptions).toBeNull();
    expect(r.body.users_affected).toBeNull();
    // The distinction that matters: not 0.
    expect(r.body.subscriptions).not.toBe(0);
  });

  test('rotation still proceeds but reports the blast radius as unknown', async () => {
    engine.db.exec('DROP TABLE push_subscriptions');
    const r = await req('POST', '/api/admin/push/rotate-vapid', OWNER, { confirm: ROTATE_PHRASE });
    expect(r.status).toBe(200);
    expect(r.body.subscriptions_invalidated).toBeNull();
    const d = auditRows('push.vapid_rotate')[0].detail;
    const detail = typeof d === 'string' ? JSON.parse(d) : d;
    expect(detail.subscriptions_invalidated).toBeNull();
  });
});

// ── the consequence the UI has to state ───────────────────────────────────
describe('the endpoint states the real consequence, so the UI cannot undersell it', () => {
  test('status declares that a restart is required and nothing re-subscribes', async () => {
    const r = await req('GET', '/api/admin/push/vapid-status', OWNER);
    expect(r.body.restart_required).toBe(true);
    expect(r.body.auto_resubscribe).toBe(false);
    expect(Array.isArray(r.body.recovery)).toBe(true);
    expect(r.body.recovery.length).toBeGreaterThan(0);
    expect(r.body.confirm_phrase).toBe(ROTATE_PHRASE);
  });

  test('the rotation response repeats it, so a client that only reads the POST still learns it', async () => {
    const r = await req('POST', '/api/admin/push/rotate-vapid', OWNER, { confirm: ROTATE_PHRASE });
    expect(r.body.restart_required).toBe(true);
    expect(r.body.auto_resubscribe).toBe(false);
    expect(r.body.stale_rows_note).toMatch(/404\/410/);
  });

  test('deleting a row that is not there says so rather than claiming a rotation', async () => {
    seed({ noRow: true });
    await refreshRoleCache();
    const r = await req('POST', '/api/admin/push/rotate-vapid', OWNER, { confirm: ROTATE_PHRASE });
    expect(r.status).toBe(200);
    expect(r.body.rows_removed).toBe(0);
    expect(r.body.note).toMatch(/No stored row existed/i);
  });
});
