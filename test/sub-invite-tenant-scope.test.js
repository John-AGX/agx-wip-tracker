// The tenant boundary on the sub-portal INVITE lifecycle.
//
// WHAT THIS FILE EXISTS FOR
// POST /api/subs/:subId/invite reads `SELECT ... FROM subs WHERE id = $1` with
// no org predicate and then INSERTs a sub_invites row for a CALLER-SUPPLIED
// email address. The token it mints is a magic link: /api/sub-portal/accept
// turns it into a real users row with role='sub', sets the auth cookie, and
// redirects to the portal, where the session reads every folder that sub was
// granted. The link comes back in the response body, so no email delivery is
// needed. Cross-tenant account provisioning in two HTTP calls.
//
// THE INTERACTION, FOR THE THIRD TIME.
// The accept side is not naive — it stamps the new user's organization_id from
// the sub record ("Stamp the tenant from the invite's own evidence"). Which
// means a forged invite produced a CORRECTLY STAMPED foreign-tenant login,
// indistinguishable from a real one. The stamp did not just fail to help; it
// removed the orphaned-NULL tell that would have made the forgery visible.
// Same shape as a243b76 on job_subs and 79b52ed on messages. A stamp says which
// tenant a row claims to be in. A predicate is where the server decides.
//
// AND THE WHOLE LIFECYCLE, NOT THE ONE DOOR. All three PM-side endpoints key on
// the same subId. The list hands back the email addresses of everyone another
// tenant has invited — which is also where the "opaque invite id" the revoke
// door needs comes from, so grading revoke as LOW on the strength of that
// opacity was grading a chain by its second link.

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
  }
}));

// If an invite is ever minted for a foreign sub, this is where it would show up
// even when the response body is refused — so the spy is part of the assertion.
const sentEmails = [];
jest.mock('../server/email', () => ({
  sendEmail: async (m) => { sentEmails.push(m); return { ok: true }; },
  isEnabled: () => true,
  sendForEvent: async () => ({})
}));
jest.mock('../server/storage', () => ({ storage: { put: async () => 'u', getBuffer: async () => Buffer.from(''), delete: async () => {} } }));
jest.mock('../server/services/entity-labels', () => ({ resolveEntityLabels: async () => ({}) }));

function rowsOf(n) { return tables[n] || []; }

function mockRunQuery(sql, params) {
  const text = String(sql).replace(/\s+/g, ' ').trim();
  const p = params || [];
  queries.push({ sql: text, params: p });

  if (text.includes('SELECT name, capabilities FROM roles')) return { rows: rowsOf('roles') };

  // subInOrg — the predicate under test. Answered from real rows, applying the
  // org term the service actually bound, so the test measures the predicate
  // rather than restating it.
  if (text.includes('SELECT 1 FROM subs WHERE id = $1')) {
    const hit = rowsOf('subs').find((s) => String(s.id) === String(p[0]));
    if (!hit) return { rows: [] };
    const ok = hit.organization_id == null || String(hit.organization_id) === String(p[1]);
    return { rows: ok ? [{ '?column?': 1 }] : [] };
  }
  if (text.includes('FROM subs WHERE id = $1')) {
    const hit = rowsOf('subs').find((s) => String(s.id) === String(p[0]));
    return { rows: hit ? [hit] : [] };
  }
  if (text.startsWith('INSERT INTO sub_invites')) {
    tables.sub_invites.push({ id: p[0], sub_id: p[1], email: p[2], token: p[3] });
    return { rows: [], rowCount: 1 };
  }
  if (text.includes('FROM sub_invites WHERE sub_id = $1')) {
    return { rows: rowsOf('sub_invites').filter((i) => String(i.sub_id) === String(p[0])) };
  }
  if (text.startsWith('DELETE FROM sub_invites')) {
    const before = tables.sub_invites.length;
    tables.sub_invites = tables.sub_invites.filter(
      (i) => !(String(i.id) === String(p[0]) && String(i.sub_id) === String(p[1])));
    return { rows: [], rowCount: before - tables.sub_invites.length };
  }
  return { rows: [], rowCount: 0 };
}

const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const { pool } = require('../server/db');
setRolePool(pool);

let server, baseUrl;

const ORG_A_ADMIN = { id: 10, email: 'admin-a@a.test', role: 'admin', name: 'A', organization_id: 1 };

function freshTables() {
  return {
    roles: [{ name: 'admin', capabilities: ['JOBS_EDIT_ANY', 'JOBS_VIEW_ALL', 'USERS_MANAGE', 'ROLES_MANAGE'] }],
    subs: [
      { id: 'sub_A', name: 'Alpha Drywall', email: 'alpha@a.test', primary_contact_first: 'Al', organization_id: 1 },
      { id: 'sub_B', name: 'Beta Drywall', email: 'beta@b.test', primary_contact_first: 'Bea', organization_id: 2 },
      { id: 'sub_LEGACY', name: 'Old Co', email: 'old@x.test', primary_contact_first: null, organization_id: null }
    ],
    sub_invites: [
      { id: 'si_A', sub_id: 'sub_A', email: 'alpha@a.test', token: 'tokA' },
      { id: 'si_B', sub_id: 'sub_B', email: 'beta@b.test', token: 'tokB' }
    ]
  };
}

beforeAll(async () => {
  queries = []; tables = freshTables();
  await refreshRoleCache();
  const routes = require('../server/routes/sub-portal-routes');
  const app = express();
  app.use(express.json());
  app.use('/api', routes);
  await new Promise((done) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => { baseUrl = 'http://127.0.0.1:' + server.address().port; done(); });
  });
});

afterAll((done) => { server.close(() => done()); });
beforeEach(() => { queries = []; sentEmails.length = 0; tables = freshTables(); });

async function call(method, path, user, body) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + signToken(user) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual'
  });
  let json = null;
  const text = await res.text();
  try { json = JSON.parse(text); } catch (e) { /* redirect / html */ }
  return { status: res.status, body: json, text };
}

describe('a foreign-tenant sub is not a sub you can invite into', () => {
  test('POST /subs/:subId/invite — no token, no row, no email, no link in the body', async () => {
    const r = await call('POST', '/api/subs/sub_B/invite', ORG_A_ADMIN, { email: 'attacker@orga.example' });
    expect(r.status).toBe(404);
    // The three separate things that used to happen, each asserted on its own:
    expect(queries.some((q) => /INSERT INTO sub_invites/i.test(q.sql))).toBe(false);
    expect(tables.sub_invites.filter((i) => i.sub_id === 'sub_B').length).toBe(1);
    expect(sentEmails).toEqual([]);
    expect(r.text).not.toContain('/api/sub-portal/accept');
  });

  test('the refusal is the SAME 404 an absent sub gets — no directory oracle', async () => {
    const foreign = await call('POST', '/api/subs/sub_B/invite', ORG_A_ADMIN, { email: 'x@x.test' });
    const absent = await call('POST', '/api/subs/sub_NOPE/invite', ORG_A_ADMIN, { email: 'x@x.test' });
    expect(absent.status).toBe(foreign.status);
    expect(absent.body).toEqual(foreign.body);
  });

  test('GET /subs/:subId/invites — another tenant\'s invited email addresses stay theirs', async () => {
    const r = await call('GET', '/api/subs/sub_B/invites', ORG_A_ADMIN);
    expect(r.status).toBe(404);
    expect(r.text).not.toContain('beta@b.test');
  });

  test('DELETE /subs/:subId/invites/:inviteId — a foreign invite is not revocable', async () => {
    const r = await call('DELETE', '/api/subs/sub_B/invites/si_B', ORG_A_ADMIN);
    expect(r.status).toBe(404);
    expect(tables.sub_invites.some((i) => i.id === 'si_B')).toBe(true);
    expect(queries.some((q) => /DELETE FROM sub_invites/i.test(q.sql))).toBe(false);
  });
});

describe('the PM keeps their own invite lifecycle', () => {
  test('invite mints a token for my own sub', async () => {
    const r = await call('POST', '/api/subs/sub_A/invite', ORG_A_ADMIN, {});
    expect(r.status).toBe(200);
    expect(r.body.link).toContain('/api/sub-portal/accept?token=');
    expect(sentEmails.length).toBe(1);
    expect(sentEmails[0].to).toBe('alpha@a.test');
  });

  test('a legacy NULL-org sub is still reachable — the tolerance arm survives', async () => {
    const r = await call('POST', '/api/subs/sub_LEGACY/invite', ORG_A_ADMIN, { email: 'ok@x.test' });
    expect(r.status).toBe(200);
  });

  test('listing and revoking my own invites still works', async () => {
    const list = await call('GET', '/api/subs/sub_A/invites', ORG_A_ADMIN);
    expect(list.status).toBe(200);
    expect(list.body.invites.length).toBe(1);
    const del = await call('DELETE', '/api/subs/sub_A/invites/si_A', ORG_A_ADMIN);
    expect(del.status).toBe(200);
    expect(tables.sub_invites.some((i) => i.id === 'si_A')).toBe(false);
  });
});
