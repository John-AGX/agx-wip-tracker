// Sender identity on the two customer/sales mails in lead-routes and
// estimate-routes: who the mail says it is from, where a reply goes, and who
// can be on the To line at all.
//
// WHAT IS HELD HERE
//   POST /api/estimates/:id/send (method 'email')
//     - branded with the caller's org (senderOrg), metered (organizationId);
//     - Reply-To is the estimator who sent it, read fresh and org-predicated,
//       and false when that read misses — never the platform EMAIL_REPLY_TO;
//     - the default subject names the org, not the old hard-coded 'AGX';
//     - a per-user cap of 20 an hour answers 429 BEFORE the estimate is
//       stamped sent, and print/link/outlook records are never throttled.
//   PUT /api/leads/:id -> lead_status_sold / lead_status_lost
//     - params.__orgId is the lead's org, so sendForEvent brands it (scope
//       'org') and the org's override/branding kit apply;
//     - Reply-To is the person who moved the lead (fresh, org-predicated);
//     - THE HOLE: salesperson_id is body-editable, and the salesperson JOIN had
//       no org predicate, so a lead naming another tenant's user mailed that
//       user this org's lead revenue. A foreign salesperson is now never the
//       recipient; the notice falls back to the person who made the change.
//
// Driven through the real routers, requireAuth, requireCapability and a JWT,
// over the pg-sqlite engine with tables derived from db.js. ../server/email is
// mocked to CAPTURE the options each route hands the transport; the real
// server/email-sender.js runs its real org-predicated reads against the engine.

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';
delete process.env.GEOCODING_API_KEY;

const express = require('express');
const http = require('http');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const engine = createPgSqlite(
  sqliteSchema(['organizations', 'users', 'roles', 'leads', 'clients', 'estimates'], {
    pk: { organizations: 'id', users: 'id', roles: 'name', leads: 'id', clients: 'id', estimates: 'id' },
  }),
  { jsonColumns: ['data'] }
);
globalThis.__P86_SENDER_ID_ENGINE__ = engine;
globalThis.__P86_SENDER_ID_MAIL__ = [];

jest.mock('../server/db', () => ({ pool: globalThis.__P86_SENDER_ID_ENGINE__.pool }));
jest.mock('../server/geocoder', () => ({
  geocodeAddress: async () => null,
  geocodeViaGoogle: async () => null,
  geocodeViaCensus: async () => null,
}));
jest.mock('../server/email', () => ({
  sendEmail: async (opts) => {
    globalThis.__P86_SENDER_ID_MAIL__.push({ fn: 'sendEmail', opts });
    return { ok: true, id: 'log_1' };
  },
  sendForEvent: async (eventKey, params, opts) => {
    globalThis.__P86_SENDER_ID_MAIL__.push({ fn: 'sendForEvent', eventKey, params, opts });
    return { ok: true };
  },
}));

const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const leadRoutes = require('../server/routes/lead-routes');
const estimateRoutes = require('../server/routes/estimate-routes');
const { _clearOrgNameCache } = require('../server/email-sender');

const mail = () => globalThis.__P86_SENDER_ID_MAIL__;

const PM_A = { id: 10, email: 'pm@agx.test', name: 'Pat PM', role: 'pm', organization_id: 1 };
const SALES_A = { id: 11, email: 'sales@agx.test', name: 'Sam Sales', role: 'pm', organization_id: 1 };
const USER_B = { id: 20, email: 'spy@other.test', name: 'Other Tenant', role: 'pm', organization_id: 2 };

let server, baseUrl;

function seed() {
  engine.db.exec(`
    DELETE FROM estimates; DELETE FROM leads; DELETE FROM clients; DELETE FROM users;
    DELETE FROM roles; DELETE FROM organizations;
    INSERT INTO organizations (id, name, slug) VALUES (1, 'AG Exteriors', 'agx'), (2, 'Other Roofing', 'other');
    INSERT INTO users (id, email, name, role, organization_id, active) VALUES
      (10, 'pm@agx.test', 'Pat PM', 'pm', 1, 1),
      (11, 'sales@agx.test', 'Sam Sales', 'pm', 1, 1),
      (20, 'spy@other.test', 'Other Tenant', 'pm', 2, 1);
    INSERT INTO roles (name, label, capabilities) VALUES
      ('pm', 'PM', '["LEADS_VIEW","LEADS_EDIT","ESTIMATES_VIEW","ESTIMATES_EDIT"]');
    INSERT INTO clients (id, name, company_name, organization_id) VALUES ('c1', 'Bay Pointe', 'Bay Pointe HOA', 1);
    INSERT INTO leads (id, title, status, client_id, estimated_revenue_high, notes, salesperson_id, organization_id)
    VALUES ('lead_1', 'Bay Pointe Roof Hatch', 'in_progress', 'c1', 18000, 'first visit', 11, 1);
    INSERT INTO estimates (id, owner_id, data, organization_id) VALUES ('est_1', 10, '{}', 1);
  `);
}

function req(method, path, user, body) {
  return fetch(baseUrl + path, {
    method,
    headers: { authorization: 'Bearer ' + signToken(user), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => {
    let json = null;
    try { json = await res.json(); } catch (e) { /* non-JSON */ }
    return { status: res.status, body: json };
  });
}

// The lead notice fires AFTER res.json, so wait for it rather than racing it.
async function waitForMail(pred, ms) {
  const until = Date.now() + (ms || 2000);
  while (Date.now() < until) {
    const hit = mail().find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 10));
  }
  return undefined;
}

beforeAll(async () => {
  setRolePool(engine.pool);
  seed();
  await refreshRoleCache();
  const app = express();
  app.use(express.json());
  app.use('/api/leads', leadRoutes);
  app.use('/api/estimates', estimateRoutes);
  await new Promise((done) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => { baseUrl = 'http://127.0.0.1:' + server.address().port; done(); });
  });
});
// The engine is left open: lead-routes and estimate-routes schedule a boot
// geocode backfill on a timer, and closing the database under it only turns
// that into a log line after the run (lead-partial-save-keeps-revenue does
// the same).
afterAll((done) => { server.close(() => done()); });
let warnSpy;
beforeEach(() => {
  seed();
  globalThis.__P86_SENDER_ID_MAIL__.length = 0;
  _clearOrgNameCache();
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { warnSpy.mockRestore(); });

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. The proposal email.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('POST /api/estimates/:id/send — the company sends its own proposal', () => {
  test('branded with the caller org, metered, Reply-To the estimator', async () => {
    const r = await req('POST', '/api/estimates/est_1/send', PM_A,
      { to: 'owner@baypointe.test', method: 'email', html: '<p>Proposal</p>', subject: 'Roof hatch proposal' });
    expect(r.status).toBe(200);
    expect(r.body.emailed).toBe(true);
    const sent = mail().filter((m) => m.fn === 'sendEmail');
    expect(sent).toHaveLength(1);
    const o = sent[0].opts;
    expect(o.to).toBe('owner@baypointe.test');
    expect(o.subject).toBe('Roof hatch proposal');
    expect(o.tag).toBe('proposal_sent');
    expect(o.organizationId).toBe(1);
    expect(o.senderOrg).toEqual({ id: 1 });
    expect(o.replyTo).toBe('pm@agx.test');
  });

  test('the default subject names the org — never the old hard-coded AGX', async () => {
    await req('POST', '/api/estimates/est_1/send', PM_A,
      { to: 'owner@baypointe.test', method: 'email', html: '<p>Proposal</p>' });
    const o = mail().find((m) => m.fn === 'sendEmail').opts;
    expect(o.subject).toBe('Your proposal from AG Exteriors');
  });

  test('an org name that cannot be shown is left out of the subject rather than used raw', async () => {
    engine.db.exec("UPDATE organizations SET name = 'Project 86 Support' WHERE id = 1");
    await req('POST', '/api/estimates/est_1/send', PM_A,
      { to: 'owner@baypointe.test', method: 'email', html: '<p>Proposal</p>' });
    expect(mail().find((m) => m.fn === 'sendEmail').opts.subject).toBe('Your proposal');
  });

  test('Reply-To is the FRESH row, not the JWT email claim', async () => {
    engine.db.exec("UPDATE users SET email = 'pat.new@agx.test' WHERE id = 10");
    await req('POST', '/api/estimates/est_1/send', PM_A,   // token still says pm@agx.test
      { to: 'owner@baypointe.test', method: 'email', html: '<p>Proposal</p>' });
    expect(mail().find((m) => m.fn === 'sendEmail').opts.replyTo).toBe('pat.new@agx.test');
  });

  test('a caller whose row is not in the org (deactivated, moved) gets replyTo:false, not a fallback', async () => {
    engine.db.exec('UPDATE users SET active = 0 WHERE id = 10');
    await req('POST', '/api/estimates/est_1/send', PM_A,
      { to: 'owner@baypointe.test', method: 'email', html: '<p>Proposal</p>' });
    expect(mail().find((m) => m.fn === 'sendEmail').opts.replyTo).toBe(false);
  });

  test('a foreign-tenant estimate is refused and nothing is mailed', async () => {
    const r = await req('POST', '/api/estimates/est_1/send', USER_B,
      { to: 'owner@baypointe.test', method: 'email', html: '<p>Proposal</p>' });
    expect(r.status).toBe(404);
    expect(mail()).toHaveLength(0);
  });

  test('print / link / outlook record only, and send nothing', async () => {
    for (const method of ['print', 'link', 'outlook']) {
      const r = await req('POST', '/api/estimates/est_1/send', PM_A,
        { to: 'owner@baypointe.test', method, html: '<p>Proposal</p>' });
      expect(r.status).toBe(200);
    }
    expect(mail()).toHaveLength(0);
  });

  test('the per-user cap: the 21st email in an hour is a 429 and the estimate is not stamped', async () => {
    // A user id no other test in this file sends as, so the in-process window
    // starts empty regardless of test order.
    engine.db.exec("INSERT INTO users (id, email, name, role, organization_id, active) VALUES (12, 'busy@agx.test', 'Busy', 'pm', 1, 1)");
    const BUSY = { id: 12, email: 'busy@agx.test', name: 'Busy', role: 'pm', organization_id: 1 };
    for (let i = 0; i < 20; i++) {
      const ok = await req('POST', '/api/estimates/est_1/send', BUSY,
        { to: 'owner@baypointe.test', method: 'email', html: '<p>Proposal</p>' });
      expect(ok.status).toBe(200);
    }
    const before = engine.db.prepare('SELECT sent_count FROM estimates WHERE id = ?').get('est_1').sent_count;
    const r = await req('POST', '/api/estimates/est_1/send', BUSY,
      { to: 'owner@baypointe.test', method: 'email', html: '<p>Proposal</p>' });
    expect(r.status).toBe(429);
    expect(r.body.retryAfter).toBeGreaterThan(0);
    expect(mail().filter((m) => m.fn === 'sendEmail')).toHaveLength(20);
    expect(engine.db.prepare('SELECT sent_count FROM estimates WHERE id = ?').get('est_1').sent_count).toBe(before);
    // A record that sends no mail is not throttled by it.
    const printed = await req('POST', '/api/estimates/est_1/send', BUSY,
      { to: 'owner@baypointe.test', method: 'print' });
    expect(printed.status).toBe(200);
    // And the cap is per user: someone else in the org still sends.
    const other = await req('POST', '/api/estimates/est_1/send', SALES_A,
      { to: 'owner@baypointe.test', method: 'email', html: '<p>Proposal</p>' });
    expect(other.status).toBe(200);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. The lead status notice.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('PUT /api/leads/:id -> lead_status_* — branded, replied to the changer', () => {
  test('sold: __orgId is the lead org, the salesperson is mailed, Reply-To is the changer', async () => {
    const r = await req('PUT', '/api/leads/lead_1', PM_A, { status: 'sold' });
    expect(r.status).toBe(200);
    const m = await waitForMail((x) => x.fn === 'sendForEvent');
    expect(m).toBeDefined();
    expect(m.eventKey).toBe('lead_status_sold');
    expect(m.params.__orgId).toBe(1);
    expect(m.opts.to).toBe('sales@agx.test');
    expect(m.opts.replyTo).toBe('pm@agx.test');
    expect(m.params.changedBy.name).toBe('Pat PM');
  });

  test('lost: same shape, and the reason travels', async () => {
    await req('PUT', '/api/leads/lead_1', PM_A, { status: 'lost', notes: 'went with a competitor' });
    const m = await waitForMail((x) => x.fn === 'sendForEvent');
    expect(m.eventKey).toBe('lead_status_lost');
    expect(m.params.__orgId).toBe(1);
    expect(m.params.reason).toBe('went with a competitor');
    expect(m.opts.replyTo).toBe('pm@agx.test');
  });

  test('a deactivated changer gives replyTo:false, never a platform fallback', async () => {
    engine.db.exec('UPDATE users SET active = 0 WHERE id = 10');
    await req('PUT', '/api/leads/lead_1', PM_A, { status: 'sold' });
    const m = await waitForMail((x) => x.fn === 'sendForEvent');
    expect(m.opts.replyTo).toBe(false);
  });

  test('REGRESSION — a salesperson_id naming another tenant\'s user never receives the notice', async () => {
    // The body-editable pointer, set to org B's user in the same save as the
    // status change — the exact shape the unpredicated JOIN mailed.
    const r = await req('PUT', '/api/leads/lead_1', PM_A, { status: 'sold', salesperson_id: 20 });
    expect(r.status).toBe(200);
    const m = await waitForMail((x) => x.fn === 'sendForEvent');
    expect(m).toBeDefined();
    expect(m.opts.to).not.toBe('spy@other.test');
    // The fallback that always existed for "no salesperson": the changer.
    expect(m.opts.to).toBe('pm@agx.test');
    expect(m.params.salesperson.name).toBe('');
    expect(JSON.stringify(mail())).not.toContain('spy@other.test');
  });

  test('the same foreign pointer set earlier (already on the row) is refused too', async () => {
    engine.db.exec("UPDATE leads SET salesperson_id = 20 WHERE id = 'lead_1'");
    await req('PUT', '/api/leads/lead_1', SALES_A, { status: 'lost' });
    const m = await waitForMail((x) => x.fn === 'sendForEvent');
    expect(m.opts.to).toBe('sales@agx.test');
    expect(JSON.stringify(mail())).not.toContain('spy@other.test');
  });

  test('a legacy un-stamped lead is held to the changer\'s org and still brands with it', async () => {
    engine.db.exec("UPDATE leads SET organization_id = NULL WHERE id = 'lead_1'");
    await req('PUT', '/api/leads/lead_1', PM_A, { status: 'sold' });
    const m = await waitForMail((x) => x.fn === 'sendForEvent');
    expect(m.params.__orgId).toBe(1);
    expect(m.opts.to).toBe('sales@agx.test');       // an org-1 salesperson still matches
  });

  test('a status that does not move sends nothing', async () => {
    await req('PUT', '/api/leads/lead_1', PM_A, { status: 'in_progress' });
    await new Promise((r) => setTimeout(r, 50));
    expect(mail()).toHaveLength(0);
  });
});
