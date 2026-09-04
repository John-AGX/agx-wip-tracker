// DELETE /api/email/templates/:key — the org-less arm that cleared everybody.
//
// THE DEFECT
// The handler branched on the caller's organization. With one, it deleted
// `WHERE event_key = $1 AND organization_id = $2`. WITHOUT one, it fell to
// `DELETE FROM email_template_overrides WHERE event_key = $1` — no tenant
// predicate at all. One admin with no organization clicking "revert to
// default" on one template wiped that template's override for EVERY tenant on
// the platform, reverting their branded email to the baked-in copy, and
// answered 200 with nothing to indicate more than one row had moved.
//
// It was also unreachable-by-construction, which is why it was never going to
// surface as a bug report: PUT /templates/:key refuses an org-less admin with
// 400 before it writes, so such an admin has no override of their own to
// delete. Every row that DELETE could reach belonged to somebody else.
//
// The GET has the same shape and is held here too: its org-less arm took
// "the most recently updated override for this key, from anyone", so an
// org-less admin opening the editor was shown another tenant's subject line
// and HTML body — and could then save it as their own.
//
// THE PROPERTIES
//   E1  An admin's delete removes THEIR override and nothing else. Asserted by
//       counting the other tenants' rows, not by reading the response.
//   E2  An org-less admin is refused, and every row survives.
//   E3  An org-less admin reading a template is shown no override rather than
//       somebody else's.
//   E4  The org-scoped read and write still work — the door still opens.

'use strict';

const express = require('express');
const http = require('http');

const { createPgSqlite } = require('./helpers/pg-sqlite');

const SCHEMA = `
  CREATE TABLE organizations (id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, role TEXT, organization_id INTEGER);
  CREATE TABLE roles (name TEXT PRIMARY KEY, label TEXT, capabilities TEXT);
  CREATE TABLE email_template_overrides (
    organization_id INTEGER,
    event_key TEXT,
    subject TEXT,
    html_body TEXT,
    updated_by INTEGER,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (organization_id, event_key)
  );
`;

const engine = createPgSqlite(SCHEMA, {});
globalThis.__P86_EMAIL_ENGINE__ = engine;

jest.mock('../server/db', () => ({ pool: globalThis.__P86_EMAIL_ENGINE__.pool }));

const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const emailRoutes = require('../server/routes/email-routes');

let server, baseUrl, EVENT_KEY;

const ORG_A = 1;
const ORG_B = 2;

function seed() {
  engine.db.exec(`
    DELETE FROM email_template_overrides; DELETE FROM users;
    DELETE FROM roles; DELETE FROM organizations;
    INSERT INTO organizations (id, name) VALUES (1, 'Org A'), (2, 'Org B');
    INSERT INTO users (id, email, role, organization_id) VALUES
      (10, 'a@a.a', 'admin', 1), (20, 'b@b.b', 'admin', 2), (30, 'x@x.x', 'admin', NULL);
    INSERT INTO roles (name, label, capabilities) VALUES
      ('admin', 'Admin', '["USERS_MANAGE","ROLES_MANAGE","INSIGHTS_VIEW"]');
  `);
  setRolePool(engine.pool);
  return refreshRoleCache();
}

function seedOverride(orgId, key, subject) {
  engine.db.prepare(
    `INSERT INTO email_template_overrides (organization_id, event_key, subject, html_body, updated_by)
     VALUES (?, ?, ?, ?, ?)`
  ).run(orgId, key, subject, '<p>' + subject + '</p>', 10);
}

function overrideCount(orgId, key) {
  return engine.count(
    "SELECT organization_id FROM email_template_overrides WHERE organization_id = " +
    orgId + " AND event_key = '" + key + "'");
}

const A_ADMIN = { id: 10, email: 'a@a.a', role: 'admin', name: 'A', organization_id: ORG_A };
const ORGLESS = { id: 30, email: 'x@x.x', role: 'admin', name: 'X', organization_id: null };

async function call(method, path, user, body) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + signToken(user) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* non-JSON */ }
  return { status: res.status, body: json };
}

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/email', emailRoutes);
  server = http.createServer(app);
  server.listen(0, '127.0.0.1', () => {
    baseUrl = 'http://127.0.0.1:' + server.address().port;
    // The route 404s an unknown event key before it reaches any SQL, so the
    // key under test is taken from the live catalog rather than invented —
    // an invented key would make every assertion below pass for the wrong
    // reason (nothing deleted because nothing was attempted).
    const { EVENTS } = require('../server/email-events');
    EVENT_KEY = (EVENTS && EVENTS.length) ? EVENTS[0].key : null;
    done();
  });
});
afterAll((done) => { server.close(() => done()); });
beforeEach(() => seed());

describe('PATH E — email template overrides are per tenant', () => {
  test('the catalog exposes a real event key to test against', () => {
    // Guards the whole file: without this, a renamed catalog turns every
    // assertion below into a 404 that quietly proves nothing.
    expect(typeof EVENT_KEY).toBe('string');
    expect(EVENT_KEY.length).toBeGreaterThan(0);
  });

  test('E1 — an admin deleting their override leaves the other tenant\'s alone', async () => {
    seedOverride(ORG_A, EVENT_KEY, 'ORG A SUBJECT');
    seedOverride(ORG_B, EVENT_KEY, 'ORG B SUBJECT');
    const res = await call('DELETE', '/api/email/templates/' + EVENT_KEY, A_ADMIN);
    expect(res.status).toBe(200);
    // Read the DATABASE.
    expect(overrideCount(ORG_A, EVENT_KEY)).toBe(0);
    expect(overrideCount(ORG_B, EVENT_KEY)).toBe(1);
  });

  test('E2 — an ORG-LESS admin is refused, and every tenant\'s override survives', async () => {
    seedOverride(ORG_A, EVENT_KEY, 'ORG A SUBJECT');
    seedOverride(ORG_B, EVENT_KEY, 'ORG B SUBJECT');
    const before = engine.count('SELECT event_key FROM email_template_overrides');
    const res = await call('DELETE', '/api/email/templates/' + EVENT_KEY, ORGLESS);
    // Visibly refused — and it mirrors what PUT already answers, so the two
    // halves of the editor agree about who may act.
    expect(res.status).toBe(400);
    expect(engine.count('SELECT event_key FROM email_template_overrides')).toBe(before);
    expect(overrideCount(ORG_A, EVENT_KEY)).toBe(1);
    expect(overrideCount(ORG_B, EVENT_KEY)).toBe(1);
  });

  test('E3 — an ORG-LESS admin reading a template is shown no override, not somebody else\'s', async () => {
    seedOverride(ORG_B, EVENT_KEY, 'ORG-B-PRIVATE-SUBJECT');
    const res = await call('GET', '/api/email/templates/' + EVENT_KEY, ORGLESS);
    expect(res.status).toBe(200);
    expect(res.body.override).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('ORG-B-PRIVATE-SUBJECT');
  });

  test('E4 — the caller\'s own override still reads back (the control)', async () => {
    seedOverride(ORG_A, EVENT_KEY, 'OUR OWN SUBJECT');
    const res = await call('GET', '/api/email/templates/' + EVENT_KEY, A_ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.override).not.toBeNull();
    expect(res.body.override.subject).toBe('OUR OWN SUBJECT');
  });

  test('E5 — an admin cannot see another tenant\'s override through their own read either', async () => {
    seedOverride(ORG_B, EVENT_KEY, 'ORG-B-PRIVATE-SUBJECT');
    const res = await call('GET', '/api/email/templates/' + EVENT_KEY, A_ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.override).toBeNull();
  });
});
