// THE CREW LINK EMAIL — who it is from, and who a reply reaches.
//
// POST /api/service-tickets/:id/share can email the link to the crew. John
// asked for the company name on outgoing mail and a Reply-To that reaches a
// person, so this door now sends:
//   * senderOrg = the ticket's org (sendEmail renders "AG Exteriors via
//     Project 86"), and organizationId for metering;
//   * replyTo  = the office user who minted the link — their FRESH users row in
//     this org (never the JWT email, never anything typed on the form), or
//     false when there is none;
//   * a plain-text part and a tag;
// and it reports email_sent from sendEmail's answer, because sendEmail resolves
// a refused send as { ok: false } rather than throwing.
//
// The real handlers run — real requireAuth over a signed JWT, the real role
// cache, the real access rule — against node:sqlite through the pg shim; only
// the email transport is replaced, so what the route ASKED it to send is the
// assertion.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const mockSent = [];
let mockResult = { ok: true };
jest.mock('../server/email', () => ({
  sendEmail: async (opts) => { mockSent.push(opts); return mockResult; },
  isEnabled: () => true,
}));

const TABLES = [
  'organizations', 'users', 'roles', 'jobs', 'job_access', 'leads', 'tasks',
  'service_tickets', 'service_ticket_events', 'service_ticket_shares', 'attachments',
];

const WIDE = 10;
const STALE = 11;   // a JWT whose user row has since been deactivated
const USERS = { [WIDE]: { role: 'st_wide', org: 1 }, [STALE]: { role: 'st_wide', org: 1 } };

let eng;
let auth;
let shareRouter;

function seed() {
  eng.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM roles; DELETE FROM jobs;
    DELETE FROM service_tickets; DELETE FROM service_ticket_events; DELETE FROM service_ticket_shares;
    INSERT INTO organizations (id, name) VALUES (1, 'AG Exteriors'), (2, 'Rival Co');
    INSERT INTO roles (name, capabilities) VALUES
      ('st_wide', '["JOBS_VIEW_ALL","JOBS_EDIT_ANY","LEADS_VIEW","LEADS_EDIT"]');
    INSERT INTO users (id, name, email, role, organization_id, active) VALUES
      (10, 'Paula PM', 'paula@agx.test', 'st_wide', 1, 1),
      (11, 'Gone Gary', 'gary@agx.test', 'st_wide', 1, 0);
    INSERT INTO jobs (id, owner_id, data, organization_id) VALUES ('j1', 10, '{"jobNumber":"M1001","title":"Latitude"}', 1);
    INSERT INTO service_tickets (id, organization_id, title, job_id, status, checklist) VALUES
      ('st_j1', 1, 'Latitude 28 punch list', 'j1', 'open', '[]');
  `);
}

beforeAll(async () => {
  eng = createPgSqlite(sqliteSchema(TABLES), { jsonColumns: ['checklist', 'capabilities', 'detail', 'data'] });
  const db = require('../server/db');
  db.pool.query = eng.pool.query;
  db.pool.connect = eng.pool.connect;
  auth = require('../server/auth');
  auth.setRolePool(eng.pool);
  seed();
  await auth.refreshRoleCache();
  shareRouter = require('../server/routes/service-ticket-share-routes');
});

const flush = () => new Promise((r) => setTimeout(r, 25));
beforeEach(() => { seed(); mockSent.length = 0; mockResult = { ok: true }; });
afterAll(async () => {
  await flush();
  require('../server/db').pool.query = async () => ({ rows: [], rowCount: 0 });
  if (eng) eng.close();
});

function tokenFor(uid) {
  const u = USERS[uid];
  return auth.signToken({ id: uid, email: 'jwt-claim-' + uid + '@stale.test', name: 'U' + uid, role: u.role, organization_id: u.org });
}

async function mint(as, body) {
  const layer = shareRouter.stack.find((l) => l.route && l.route.path === '/service-tickets/:id/share' && l.route.methods.post);
  const res = { statusCode: 200, body: undefined, headersSent: false };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.body = p; res.headersSent = true; return res; };
  res.set = () => res;
  const req = {
    method: 'POST', params: { id: 'st_j1' }, query: {}, body: body, cookies: {},
    headers: { authorization: 'Bearer ' + tokenFor(as) }, protocol: 'https', get: () => 'project86.test',
  };
  for (const h of layer.route.stack.map((s) => s.handle)) {
    let advanced = false;
    await h(req, res, (err) => { if (err) throw err; advanced = true; });
    if (!advanced) break;
  }
  await flush();
  return res;
}

test('the link email is sent as the company, with a text part, and a reply reaches the PM who sent it', async () => {
  const res = await mint(WIDE, { scope: 'respond', email: 'crew@sub.test', name: 'Marco' });
  expect(res.statusCode).toBe(200);
  expect(res.body.email_sent).toBe(true);
  expect(mockSent).toHaveLength(1);
  const m = mockSent[0];
  expect(m.to).toBe('crew@sub.test');
  expect(m.senderOrg).toEqual({ id: 1 });
  expect(m.organizationId).toBe(1);
  // The FRESH users row, not the JWT's claimed email.
  expect(m.replyTo).toBe('paula@agx.test');
  expect(m.tag).toBe('service_ticket_share');
  expect(m.text).toContain(res.body.link);
  expect(m.text).toContain('Marco,');
});

test('a deactivated sender gives no Reply-To at all — never the address the token still claims', async () => {
  const res = await mint(STALE, { scope: 'view', email: 'crew@sub.test' });
  expect(res.statusCode).toBe(200);
  expect(mockSent).toHaveLength(1);
  expect(mockSent[0].replyTo).toBe(false);
  expect(JSON.stringify(mockSent[0])).not.toContain('@stale.test');
});

test('a refused send is reported as not sent, with the reason — the link is still returned', async () => {
  mockResult = { ok: false, error: 'domain not verified' };
  const res = await mint(WIDE, { scope: 'view', email: 'crew@sub.test' });
  expect(res.statusCode).toBe(200);
  expect(res.body.link).toMatch(/\/st\/[a-f0-9]{64}$/);
  expect([res.body.email_sent, res.body.email_error]).toEqual([false, 'domain not verified']);
});

test('no email address on the form sends nothing', async () => {
  const res = await mint(WIDE, { scope: 'view' });
  expect(res.statusCode).toBe(200);
  expect(mockSent).toHaveLength(0);
  expect(res.body.email_sent).toBe(false);
});
