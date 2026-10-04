/* THE COST INBOX HAD NO FLOOR.
 *
 * Every door in routes/receipt-routes.js carried requireAuth and nothing else,
 * and requireAuth admits EVERY authenticated caller — including the builtin
 * `sub` role, an EXTERNAL subcontractor whose whole capability set is
 * SUB_PORTAL_VIEW and SUB_PORTAL_UPLOAD. A sub-portal session could read the
 * organisation's Cost Inbox — vendor names and dollar totals — and capture
 * into it.
 *
 * The agent surface met this first and fixed its own doors, recording the REST
 * twins as open ("John's call"). He made it on 2026-10-04.
 *
 * WHAT THIS FILE GUARDS:
 *
 *   1. THE OUTSIDER IS REFUSED. A sub-portal session gets nothing, on every
 *      door — reads and writes.
 *   2. EVERY INSIDER STILL PASSES. This is a floor, not a policy. Each builtin
 *      internal role is driven against a read, from the SEEDED capability lists
 *      rather than a list retyped here, so tightening the floor later cannot
 *      quietly lock one of them out.
 *   3. THE TWO SURFACES SHARE ONE LIST. 86 dispatches through the agent map and
 *      the app through these routes; a caller refused one way must not be
 *      admitted the other.
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');

let tables;

jest.mock('../server/db', () => ({
  pool: { query: async (sql, params) => mockRunQuery(sql, params) },
}));
jest.mock('../server/email', () => ({ sendEmail: async () => ({ ok: true }), isEnabled: () => false }));
jest.mock('../server/push', () => ({ sendPush: async () => ({ sent: 0 }) }));

function rowsOf(n) { return tables[n] || []; }

function mockRunQuery(sql) {
  const text = String(sql).replace(/\s+/g, ' ').trim();
  if (/FROM roles/.test(text)) return { rows: rowsOf('roles') };
  return { rows: [], rowCount: 0 };
}

// The seeded roles, read OUT of db.js rather than retyped — so if a role's
// capabilities change, this suite follows rather than asserting a stale copy.
const DB = fs.readFileSync(path.join(__dirname, '..', 'server', 'db.js'), 'utf8');

function seededCaps(roleName) {
  const i = DB.indexOf("name: '" + roleName + "',");
  expect(i).toBeGreaterThan(-1);
  const seg = DB.slice(i, i + 1200);
  const m = seg.match(/capabilities:\s*\[([\s\S]*?)\]/);
  expect(m).toBeTruthy();
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
}

const INTERNAL_ROLES = ['system_admin', 'admin', 'corporate', 'pm', 'field_crew'];
const ALL_ROLES = INTERNAL_ROLES.concat(['sub']);

function freshTables() {
  return { roles: ALL_ROLES.map((n) => ({ name: n, capabilities: seededCaps(n) })) };
}

const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const { pool } = require('../server/db');
const { INTERNAL_VIEW_FLOOR, INTERNAL_FLOOR_CAPS } = require('../server/services/internal-floor');

let server;
let base;

const USER = (role) => ({
  id: role === 'sub' ? 50 : 10, email: role + '@agx.test', role: role,
  name: role, organization_id: 1, sub_id: role === 'sub' ? 'sub_1' : null,
});

beforeAll(async () => {
  tables = freshTables();
  setRolePool(pool);
  await refreshRoleCache();
  const app = express();
  app.use(express.json());
  app.use('/api/receipts', require('../server/routes/receipt-routes'));
  await new Promise((done) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => { base = 'http://127.0.0.1:' + server.address().port; done(); });
  });
});

afterAll((done) => { if (server) server.close(() => done()); else done(); });
beforeEach(async () => { tables = freshTables(); await refreshRoleCache(); });

async function call(method, p, role, body) {
  const res = await fetch(base + p, {
    method: method,
    headers: Object.assign(
      { 'content-type': 'application/json' },
      role ? { authorization: 'Bearer ' + signToken(USER(role)) } : {}
    ),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.status;
}

// Every door that had no gate before this change.
const READS = [
  ['GET', '/api/receipts/'],
  ['GET', '/api/receipts/rollup'],
  ['GET', '/api/receipts/categories'],
  ['GET', '/api/receipts/ocr/stats'],
  ['GET', '/api/receipts/r_1'],
];
const WRITES = [
  ['POST', '/api/receipts/', { amount: 10 }],
  ['PATCH', '/api/receipts/r_1', { amount: 10 }],
  ['DELETE', '/api/receipts/r_1', undefined],
  ['POST', '/api/receipts/ocr', { image: 'x' }],
];

/* ═══════════════════════════════════════════════════════════════════════════
 * THE OUTSIDER
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a subcontractor cannot reach the Cost Inbox', () => {
  test('not one read', async () => {
    for (const [m, p] of READS) {
      expect([m + ' ' + p, await call(m, p, 'sub')]).toEqual([m + ' ' + p, 403]);
    }
  });

  test('and not one write', async () => {
    for (const [m, p, b] of WRITES) {
      expect([m + ' ' + p, await call(m, p, 'sub', b)]).toEqual([m + ' ' + p, 403]);
    }
  });

  test('the sub role holds none of the floor’s capabilities — which is WHY', () => {
    const caps = seededCaps('sub');
    for (const c of INTERNAL_VIEW_FLOOR) {
      expect([c, caps.includes(c)]).toEqual([c, false]);
    }
    // and it is an external role by construction
    expect(caps.every((c) => c.startsWith('SUB_PORTAL_'))).toBe(true);
  });

  test('a signed-out caller still gets 401, not 403 — the floor is not the lock', async () => {
    expect(await call('GET', '/api/receipts/', null)).toBe(401);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * EVERY INSIDER STILL PASSES — IT IS A FLOOR, NOT A POLICY
 * ══════════════════════════════════════════════════════════════════════════*/
describe('no internal role is locked out', () => {
  test('each builtin internal role holds at least one floor capability', () => {
    for (const role of INTERNAL_ROLES) {
      const caps = seededCaps(role);
      const hit = INTERNAL_VIEW_FLOOR.filter((c) => caps.includes(c));
      expect([role, hit.length > 0]).toEqual([role, true]);
    }
  });

  test('field_crew passes — its role description is literally "Estimates and Cost Inbox only"', async () => {
    const i = DB.indexOf("name: 'field_crew',");
    expect(DB.slice(i, i + 400)).toContain('Cost Inbox');
    expect(await call('GET', '/api/receipts/', 'field_crew')).not.toBe(403);
  });

  test('corporate, which is read-only, still reads', async () => {
    expect(await call('GET', '/api/receipts/', 'corporate')).not.toBe(403);
  });

  test('and so do admin and pm', async () => {
    for (const role of ['admin', 'pm', 'system_admin']) {
      expect([role, await call('GET', '/api/receipts/', role)]).not.toEqual([role, 403]);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * ONE LIST, TWO SURFACES
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the agent gate and the REST gate cannot drift', () => {
  const AI = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'ai-routes.js'), 'utf8');
  const RX = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'receipt-routes.js'), 'utf8');

  test('both ask the shared module; neither keeps its own copy', () => {
    expect(AI).toContain("require('../services/internal-floor')");
    expect(RX).toContain("require('../services/internal-floor')");
    // the literal list appears in exactly one place in server/
    const lit = "'ESTIMATES_VIEW', 'JOBS_VIEW_ALL', 'JOBS_VIEW_ASSIGNED', 'FINANCIALS_VIEW', 'LEADS_VIEW'";
    expect(AI.includes(lit)).toBe(false);
    expect(RX.includes(lit)).toBe(false);
  });

  test('every previously-ungated receipt door carries the floor', () => {
    // requireAuth ALONE is the bug this file is named for. No door in the file
    // may carry it without a capability beside it.
    const bare = RX.split('\n').filter((l) => /^router\.(get|post|patch|delete)\(/.test(l)
      && /requireAuth/.test(l) && !/requireCapability/.test(l));
    expect(bare).toEqual([]);
  });

  test('the floor is ANY-of, so one capability is enough', () => {
    // requireCapability reads a space-separated list as ANY-of — never AND —
    // which is what lets corporate (FINANCIALS_VIEW, no ESTIMATES_EDIT) and
    // field_crew (ESTIMATES_VIEW, no FINANCIALS_VIEW) both pass the same gate.
    expect(INTERNAL_FLOOR_CAPS.split(' ')).toEqual(INTERNAL_VIEW_FLOOR);
    expect(INTERNAL_FLOOR_CAPS).not.toContain(',');
  });

  test('the doors that were already stricter were NOT loosened', () => {
    // /merchants had FINANCIALS_VIEW and the category writers had ROLES_MANAGE.
    // A floor must never become a ceiling.
    expect(RX).toContain("router.get('/merchants', requireAuth, requireCapability('FINANCIALS_VIEW')");
    expect(RX).toContain("router.post('/categories', requireAuth, requireCapability('ROLES_MANAGE')");
    expect(RX).toContain("router.delete('/ocr/feedback/reset', requireAuth, requireCapability('ROLES_MANAGE')");
  });
});
