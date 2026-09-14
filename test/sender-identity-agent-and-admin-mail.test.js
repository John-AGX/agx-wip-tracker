// Sender identity on the background-task emails (ai-routes) and the admin
// email diagnostics (email-routes).
//
// WHAT IS HELD HERE
//   notifyAgentJobNeedsInput / notifyAgentJobDone
//     - branded with the JOB's org through an explicit senderOrg — the
//       organizationId they already passed is metering and never implies
//       branding on its own;
//     - replyTo:false — no human wrote them, and the answer belongs in the
//       Background Tasks panel, not in a reply to any mailbox;
//     - the per-user opt-out still means nothing is sent.
//   POST /api/email/test
//     - branded with the CALLER's org; an org-less admin gets the plain sender.
//   POST /api/email/templates/:key/test ("Send test" / "Send sample")
//     - mirrors production per event: an org-scope event is rendered WITH the
//       caller's org (so their saved override applies) and branded; a
//       system-scope event (user_invite, password_reset, org_invite) is neither
//       — production renders those with no org and sends them unbranded, so a
//       tenant override of one must not show up in its sample either.
//
// The real routers run over the pg-sqlite engine; ../server/email is mocked to
// CAPTURE the options each call site hands the transport.

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const express = require('express');
const http = require('http');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const engine = createPgSqlite(
  sqliteSchema(['organizations', 'users', 'roles', 'email_template_overrides', 'ai_messages', 'ai_sessions'], {
    pk: { organizations: 'id', users: 'id', roles: 'name' },
  }),
  { jsonColumns: ['branding', 'settings', 'notification_prefs', 'output_files'] }
);
globalThis.__P86_SENDER_AGENT_MAIL__ = [];

jest.mock('../server/email', () => ({
  sendEmail: async (opts) => {
    globalThis.__P86_SENDER_AGENT_MAIL__.push({ fn: 'sendEmail', opts });
    return { ok: true, id: 'log_1' };
  },
  sendForEvent: async () => ({ ok: true }),
  isEnabled: () => true,
  isDryRun: () => true,
  getEmailSettings: async () => ({}),
  setEmailSettings: async () => ({}),
}));
// Push is a side channel of the same notifier; it must not reach anything.
jest.mock('../server/notify-events', () => ({ sendPushForEvent: async () => ({}) }));

// The REAL db module with its pool pointed at the engine — the pattern
// test/scribe-thread-visibility.test.js uses to load ai-routes.
const db = require('../server/db');
db.pool.query = engine.pool.query;
db.pool.connect = engine.pool.connect;

const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const aiRoutes = require('../server/routes/ai-routes');
const emailRoutes = require('../server/routes/email-routes');

const mail = () => globalThis.__P86_SENDER_AGENT_MAIL__;

const ADMIN_A = { id: 10, email: 'admin@agx.test', name: 'Ada Admin', role: 'admin', organization_id: 1 };
const ORGLESS = { id: 30, email: 'x@nowhere.test', name: 'No Org', role: 'admin', organization_id: null };

let server, baseUrl;

function seed() {
  engine.db.exec(`
    DELETE FROM email_template_overrides; DELETE FROM users; DELETE FROM roles; DELETE FROM organizations;
    INSERT INTO organizations (id, name) VALUES (1, 'AG Exteriors'), (2, 'Other Roofing');
    INSERT INTO users (id, email, name, role, organization_id, active, notification_prefs) VALUES
      (10, 'admin@agx.test', 'Ada Admin', 'admin', 1, 1, '{}'),
      (11, 'pm@agx.test', 'Pat PM', 'pm', 1, 1, '{}'),
      (12, 'quiet@agx.test', 'Quiet PM', 'pm', 1, 1, '{"agent_tasks":false}'),
      (30, 'x@nowhere.test', 'No Org', 'admin', NULL, 1, '{}');
    INSERT INTO roles (name, label, capabilities) VALUES
      ('admin', 'Admin', '["USERS_MANAGE","ROLES_MANAGE"]'), ('pm', 'PM', '[]');
  `);
}

function seedOverride(orgId, key, subject) {
  engine.db.prepare(
    `INSERT INTO email_template_overrides (organization_id, event_key, subject, html_body, updated_by)
     VALUES (?, ?, ?, ?, ?)`
  ).run(orgId, key, subject, '<p>' + subject + '</p>', 10);
}

function call(method, path, user, body) {
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

let logSpy, warnSpy;
beforeAll(async () => {
  setRolePool(engine.pool);
  seed();
  await refreshRoleCache();
  const app = express();
  app.use(express.json());
  app.use('/api/email', emailRoutes);
  await new Promise((done) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => { baseUrl = 'http://127.0.0.1:' + server.address().port; done(); });
  });
});
afterAll((done) => { server.close(() => { engine.close(); done(); }); });
beforeEach(() => {
  seed();
  globalThis.__P86_SENDER_AGENT_MAIL__.length = 0;
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { logSpy.mockRestore(); warnSpy.mockRestore(); });

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. Background-task emails.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('background-task emails are branded with the job org and take no replies', () => {
  const JOB = { id: 'aj_1', user_id: 11, organization_id: 1, title: 'Draft the Bay Pointe scope' };

  test('needs-input: senderOrg is the job org, replyTo is false, metering unchanged', async () => {
    await aiRoutes.internals.notifyAgentJobNeedsInput(JOB, 'Which building first?');
    const sent = mail().filter((m) => m.fn === 'sendEmail');
    expect(sent).toHaveLength(1);
    expect(sent[0].opts.to).toBe('pm@agx.test');
    expect(sent[0].opts.tag).toBe('agent_task');
    expect(sent[0].opts.organizationId).toBe(1);
    expect(sent[0].opts.senderOrg).toEqual({ id: 1 });
    expect(sent[0].opts.replyTo).toBe(false);
  });

  test('done: same sender and the same suppression, on success and on failure', async () => {
    await aiRoutes.internals.notifyAgentJobDone(JOB, { text: 'Scope drafted.' });
    await aiRoutes.internals.notifyAgentJobDone(JOB, { error: 'tool refused' });
    const sent = mail().filter((m) => m.fn === 'sendEmail');
    expect(sent).toHaveLength(2);
    for (const s of sent) {
      expect(s.opts.senderOrg).toEqual({ id: 1 });
      expect(s.opts.replyTo).toBe(false);
      expect(s.opts.organizationId).toBe(1);
    }
  });

  test('the brand follows the JOB, not some other org', async () => {
    await aiRoutes.internals.notifyAgentJobDone(Object.assign({}, JOB, { organization_id: 2 }), { text: 'ok' });
    expect(mail()[0].opts.senderOrg).toEqual({ id: 2 });
  });

  test('the per-user opt-out still sends nothing', async () => {
    await aiRoutes.internals.notifyAgentJobNeedsInput(Object.assign({}, JOB, { user_id: 12 }), 'q');
    await aiRoutes.internals.notifyAgentJobDone(Object.assign({}, JOB, { user_id: 12 }), { text: 'ok' });
    expect(mail()).toHaveLength(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. POST /api/email/test.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('POST /api/email/test shows the sender real org mail carries', () => {
  test('an org admin: branded with their org from the token', async () => {
    const r = await call('POST', '/api/email/test', ADMIN_A, { to: 'inbox@agx.test' });
    expect(r.status).toBe(200);
    const o = mail()[0].opts;
    expect(o.tag).toBe('admin_test');
    expect(o.senderOrg).toEqual({ id: 1 });
    expect(o.replyTo).toBeUndefined();
  });

  test('the org is never taken from the body', async () => {
    await call('POST', '/api/email/test', ADMIN_A, { to: 'inbox@agx.test', organization_id: 2, senderOrg: { id: 2 } });
    expect(mail()[0].opts.senderOrg).toEqual({ id: 1 });
  });

  test('an org-less admin: the plain platform sender', async () => {
    const r = await call('POST', '/api/email/test', ORGLESS, { to: 'inbox@agx.test' });
    expect(r.status).toBe(200);
    expect(mail()[0].opts.senderOrg).toBeUndefined();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. POST /api/email/templates/:key/test.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('template Send test mirrors production per event scope', () => {
  test('org-scope event: rendered with the caller org (their override applies) and branded', async () => {
    seedOverride(1, 'job_assigned', 'AGX override subject');
    seedOverride(2, 'job_assigned', 'OTHER TENANT subject');
    const r = await call('POST', '/api/email/templates/job_assigned/test', ADMIN_A, { to: 'inbox@agx.test' });
    expect(r.status).toBe(200);
    const o = mail()[0].opts;
    expect(o.subject).toBe('[TEST] AGX override subject');
    expect(o.tag).toBe('admin_test_job_assigned');
    expect(o.senderOrg && o.senderOrg.id).toBe(1);
  });

  test('org-scope event with no override: the default, still branded', async () => {
    const r = await call('POST', '/api/email/templates/lead_status_sold/test', ADMIN_A, { to: 'inbox@agx.test', as_test: false });
    expect(r.status).toBe(200);
    const o = mail()[0].opts;
    expect(o.subject.startsWith('[TEST]')).toBe(false);
    expect(o.tag).toBe('admin_send_lead_status_sold');
    expect(o.senderOrg && o.senderOrg.id).toBe(1);
  });

  test.each(['user_invite', 'password_reset', 'org_invite'])(
    'system-scope %s: no org override in the render and no branding', async (key) => {
      seedOverride(1, key, 'TENANT OVERRIDE OF A SYSTEM TEMPLATE');
      const r = await call('POST', '/api/email/templates/' + key + '/test', ADMIN_A, { to: 'inbox@agx.test' });
      expect(r.status).toBe(200);
      const o = mail()[0].opts;
      expect(o.subject).not.toContain('TENANT OVERRIDE');
      expect(o.senderOrg).toBeUndefined();
    });

  test('an org-less admin sends an org-scope sample unbranded, with the default body', async () => {
    seedOverride(1, 'job_assigned', 'AGX override subject');
    const r = await call('POST', '/api/email/templates/job_assigned/test', ORGLESS, { to: 'inbox@agx.test' });
    expect(r.status).toBe(200);
    const o = mail()[0].opts;
    expect(o.subject).not.toContain('AGX override');
    expect(o.senderOrg).toBeUndefined();
  });
});
