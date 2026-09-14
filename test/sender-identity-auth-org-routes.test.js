// Sender identity on the platform's own mail: the credential emails in
// auth-routes and the org invitation in admin-organizations-routes — plus the
// save-time rule that keeps an organization's name usable as a sender name.
//
// THE DECISIONS HELD HERE
//   New-user invite (POST /api/auth/register) and admin password reset
//   (PUT /api/auth/users/:id/password) both carry a plaintext password. They
//   stay on the PLAIN platform sender — no senderOrg, ever — because credential
//   mail needs one stable sender people learn to trust, and a tenant-chosen
//   display name on it is the classic phishing shape.
//     Reply-To is the admin who did it, read FRESH and predicated on the org
//     being mailed. Where that is not a same-org admin — a SYSTEM_ADMIN
//     resetting another tenant's user, an un-stamped target, a deactivated
//     admin — it is replyTo:false, so platform staff never appear on a tenant's
//     mail and the platform EMAIL_REPLY_TO does not stand in either.
//   org_invite (POST /api/admin/organizations/invites) is the platform
//   onboarding a prospect. No __orgId, no senderOrg, no reply-to override:
//   sendForEvent keeps scope-'system' mail on the platform sender.
//   Organization names (create, rename, and an invitation's org_name, which
//   becomes the name at accept) refuse control characters, invisible format
//   characters and the platform's own name, with a 400 — existing trim and the
//   200-character cap unchanged.
//
// Driven through the real routers and real auth over the pg-sqlite engine.
// ../server/email is mocked to CAPTURE what each route asks the transport for;
// server/email-sender.js runs for real against the engine.

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const express = require('express');
const http = require('http');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const engine = createPgSqlite(
  sqliteSchema(['organizations', 'users', 'roles', 'org_invitations', 'admin_audit_log'], {
    pk: { organizations: 'id', users: 'id', roles: 'name', org_invitations: 'id', admin_audit_log: 'id' },
  }),
  { jsonColumns: ['settings', 'branding', 'billing'] }
);
globalThis.__P86_SENDER_AUTH_ENGINE__ = engine;
globalThis.__P86_SENDER_AUTH_MAIL__ = [];

jest.mock('../server/db', () => ({
  pool: globalThis.__P86_SENDER_AUTH_ENGINE__.pool,
  getOrgById: async (id) => globalThis.__P86_SENDER_AUTH_ENGINE__.all('SELECT * FROM organizations WHERE id = ?', id)[0] || null,
  listOrganizations: async () => globalThis.__P86_SENDER_AUTH_ENGINE__.all('SELECT * FROM organizations'),
}));
jest.mock('../server/email', () => ({
  sendEmail: async (opts) => {
    globalThis.__P86_SENDER_AUTH_MAIL__.push({ fn: 'sendEmail', opts });
    return { ok: true };
  },
  sendForEvent: async (eventKey, params, opts) => {
    globalThis.__P86_SENDER_AUTH_MAIL__.push({ fn: 'sendForEvent', eventKey, params, opts });
    return { ok: true };
  },
  isEnabled: () => false,
}));

const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const authRoutes = require('../server/routes/auth-routes');
const orgRoutes = require('../server/routes/admin-organizations-routes');

const mail = () => globalThis.__P86_SENDER_AUTH_MAIL__;

const ADMIN_A = { id: 10, email: 'admin@agx.test', name: 'Ada Admin', role: 'admin', organization_id: 1 };
const ADMIN_B = { id: 20, email: 'admin@other.test', name: 'Bo Admin', role: 'admin', organization_id: 2 };
const SYS = { id: 1, email: 'john@platform.test', name: 'John Sys', role: 'system_admin', organization_id: 1 };

let server, baseUrl;

function seed() {
  engine.db.exec(`
    DELETE FROM admin_audit_log; DELETE FROM org_invitations; DELETE FROM users;
    DELETE FROM roles; DELETE FROM organizations;
    INSERT INTO organizations (id, slug, name) VALUES (1, 'agx', 'AG Exteriors'), (2, 'other', 'Other Roofing');
    INSERT INTO users (id, email, password_hash, name, role, organization_id, active) VALUES
      (1,  'john@platform.test', 'x', 'John Sys', 'system_admin', 1, 1),
      (10, 'admin@agx.test',     'x', 'Ada Admin', 'admin', 1, 1),
      (11, 'pm@agx.test',        'x', 'Pat PM',   'pm',    1, 1),
      (20, 'admin@other.test',   'x', 'Bo Admin', 'admin', 2, 1),
      (21, 'pm@other.test',      'x', 'Pip PM',   'pm',    2, 1),
      (30, 'orphan@legacy.test', 'x', 'Orphan',   'pm',    NULL, 1);
    INSERT INTO roles (name, label, capabilities) VALUES
      ('admin', 'Admin', '["USERS_MANAGE","ROLES_MANAGE"]'),
      ('pm', 'PM', '[]'),
      ('system_admin', 'System Admin', '["USERS_MANAGE","ROLES_MANAGE","SYSTEM_ADMIN"]');
  `);
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

// The credential mails are fire-and-forget after an awaited lookup; the send
// itself is synchronous with the response in practice, but wait rather than race.
async function waitForMail(pred, ms) {
  const until = Date.now() + (ms || 2000);
  while (Date.now() < until) {
    const hit = mail().find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 10));
  }
  return undefined;
}

let logSpy, warnSpy, errSpy;
beforeAll(async () => {
  setRolePool(engine.pool);
  seed();
  await refreshRoleCache();
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  app.use('/api/admin/organizations', orgRoutes);
  await new Promise((done) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => { baseUrl = 'http://127.0.0.1:' + server.address().port; done(); });
  });
});
afterAll((done) => { server.close(() => { engine.close(); done(); }); });
beforeEach(() => {
  seed();
  globalThis.__P86_SENDER_AUTH_MAIL__.length = 0;
  try { require('../server/audit')._resetCoalescer(); } catch (_) { /* optional */ }
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { logSpy.mockRestore(); warnSpy.mockRestore(); errSpy.mockRestore(); });

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. New-user invite.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('POST /api/auth/register — the invite stays on the platform sender', () => {
  const NEW_USER = { email: 'New.Hire@AGX.test', password: 'starting-pass-1', name: 'New Hire', role: 'pm' };

  test('no senderOrg; Reply-To is the inviting admin, fresh and in-org', async () => {
    const r = await call('POST', '/api/auth/register', ADMIN_A, NEW_USER);
    expect(r.status).toBe(200);
    const m = await waitForMail((x) => x.opts && x.opts.tag === 'new_user_invite');
    expect(m).toBeDefined();
    expect(m.fn).toBe('sendEmail');
    expect(m.opts.to).toBe('new.hire@agx.test');
    expect(m.opts.senderOrg).toBeUndefined();
    expect(m.opts.replyTo).toBe('admin@agx.test');
  });

  test('Reply-To follows the admin row, not the JWT email claim', async () => {
    engine.db.exec("UPDATE users SET email = 'ada.new@agx.test' WHERE id = 10");
    await call('POST', '/api/auth/register', ADMIN_A, NEW_USER);    // token still says admin@agx.test
    const m = await waitForMail((x) => x.opts && x.opts.tag === 'new_user_invite');
    expect(m.opts.replyTo).toBe('ada.new@agx.test');
  });

  test('an inviter whose own row is not in the org gets replyTo:false, not a fallback', async () => {
    // A token claiming org 2 for a user whose row lives in org 1 — the shape an
    // act-as / platform session has. Their address must not go out on org 2 mail.
    const r = await call('POST', '/api/auth/register', Object.assign({}, SYS, { organization_id: 2 }), NEW_USER);
    expect(r.status).toBe(200);
    const m = await waitForMail((x) => x.opts && x.opts.tag === 'new_user_invite');
    expect(m.opts.replyTo).toBe(false);
    expect(m.opts.senderOrg).toBeUndefined();
    expect(JSON.stringify(m.opts)).not.toContain('john@platform.test');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. Admin password reset.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('PUT /api/auth/users/:id/password — platform sender, reply-to only in-org', () => {
  test('same-org reset: no senderOrg, Reply-To the resetting admin', async () => {
    const r = await call('PUT', '/api/auth/users/11/password', ADMIN_A, { newPassword: 'hunter2hunter2' });
    expect(r.status).toBe(200);
    const m = await waitForMail((x) => x.opts && x.opts.tag === 'password_reset');
    expect(m.opts.to).toBe('pm@agx.test');
    expect(m.opts.senderOrg).toBeUndefined();
    expect(m.opts.replyTo).toBe('admin@agx.test');
  });

  test('a SYSTEM_ADMIN cross-tenant reset never puts platform staff on the tenant\'s mail', async () => {
    const r = await call('PUT', '/api/auth/users/21/password', SYS, { newPassword: 'hunter2hunter2' });
    expect(r.status).toBe(200);
    const m = await waitForMail((x) => x.opts && x.opts.tag === 'password_reset');
    expect(m.opts.to).toBe('pm@other.test');
    expect(m.opts.replyTo).toBe(false);
    expect(m.opts.senderOrg).toBeUndefined();
    expect(JSON.stringify(m.opts)).not.toContain('john@platform.test');
  });

  test('the crossTenant gate holds on its own, even where the org predicate alone would not', async () => {
    // The platform admin's ROW now says org 2 while the token still says org 1
    // (a stale claim), so guardUserTarget calls the reset cross-tenant yet a
    // bare replyToForUser(john, org 2) WOULD match. Only the crossTenant arm
    // keeps the address off the mail.
    engine.db.exec('UPDATE users SET organization_id = 2 WHERE id = 1');
    const r = await call('PUT', '/api/auth/users/21/password', SYS, { newPassword: 'hunter2hunter2' });
    expect(r.status).toBe(200);
    const m = await waitForMail((x) => x.opts && x.opts.tag === 'password_reset');
    expect(m.opts.replyTo).toBe(false);
  });

  test('an un-stamped (legacy) target names no org to predicate on: replyTo:false', async () => {
    const r = await call('PUT', '/api/auth/users/30/password', ADMIN_A, { newPassword: 'hunter2hunter2' });
    expect(r.status).toBe(200);
    const m = await waitForMail((x) => x.opts && x.opts.tag === 'password_reset');
    expect(m.opts.replyTo).toBe(false);
  });

  test('a foreign org admin is still refused before anything is mailed', async () => {
    const r = await call('PUT', '/api/auth/users/11/password', ADMIN_B, { newPassword: 'hunter2hunter2' });
    expect(r.status).toBe(404);
    await new Promise((res) => setTimeout(res, 30));
    expect(mail()).toHaveLength(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. The org invitation.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('POST /api/admin/organizations/invites — platform onboarding', () => {
  test('org_invite carries no senderOrg, no reply-to override and no tenant id', async () => {
    const r = await call('POST', '/api/admin/organizations/invites', SYS,
      { email: 'founder@newco.test', org_name: 'NewCo Painting' });
    expect(r.status).toBe(200);
    const m = mail().find((x) => x.fn === 'sendForEvent');
    expect(m).toBeDefined();
    expect(m.eventKey).toBe('org_invite');
    expect(m.opts).toEqual({ to: 'founder@newco.test' });
    expect(m.params.__orgId).toBeUndefined();
    expect(m.params.org_name).toBe('NewCo Painting');
  });

  test.each([
    ['the platform name', 'Project 86 Security'],
    ['the platform name, respelled', 'PROJECT-86 billing'],
    ['a bidi override', 'AG Ext\u202Eeriors'],
  ])('org_name with %s is refused with a 400 and nothing is written or sent', async (_label, orgName) => {
    const r = await call('POST', '/api/admin/organizations/invites', SYS,
      { email: 'founder@newco.test', org_name: orgName });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/^org_name /);
    expect(engine.all('SELECT * FROM org_invitations')).toHaveLength(0);
    expect(mail()).toHaveLength(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. Organization names on create and rename.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('an organization name must be usable as a sender name', () => {
  const BAD = [
    ['a line break (header injection)', 'AG Exteriors\r\nBcc: victim@example.com'],
    ['a tab', 'AG\tExteriors'],
    ['a C1 control', 'AG Exteriors\u0085'],
    ['a right-to-left override', 'AG Exteriors \u202Egnp.exe'],
    ['a zero-width space', 'AG\u200BExteriors'],
    ['the platform name', 'Project 86 Security'],
    ['the platform name without the space', 'project86 support'],
    ['the platform name in fullwidth forms', '\uFF30roject 86'],
  ];

  test.each(BAD)('rename refuses %s with a 400 and leaves the name alone', async (_label, name) => {
    const r = await call('PUT', '/api/admin/organizations/1', ADMIN_A, { name });
    expect(r.status).toBe(400);
    expect(typeof r.body.error).toBe('string');
    expect(engine.all('SELECT name FROM organizations WHERE id = 1')[0].name).toBe('AG Exteriors');
  });

  test.each(BAD)('create refuses %s with a 400 and creates nothing', async (_label, name) => {
    const r = await call('POST', '/api/admin/organizations', SYS, { slug: 'newco', name });
    expect(r.status).toBe(400);
    expect(engine.all("SELECT * FROM organizations WHERE slug = 'newco'")).toHaveLength(0);
  });

  test.each([
    'AG Exteriors, LLC',
    "O'Brien & Sons, Inc.",
    'Caf\u00E9 \u00D1and\u00FA Construcci\u00F3n',
    '86 Roofing Co',          // a number is not the platform name
  ])('an ordinary name saves: %s', async (name) => {
    const r = await call('PUT', '/api/admin/organizations/1', ADMIN_A, { name: '  ' + name + '  ' });
    expect(r.status).toBe(200);
    expect(engine.all('SELECT name FROM organizations WHERE id = 1')[0].name).toBe(name);   // trimmed
  });

  test('the existing checks are unchanged: empty and over 200 characters', async () => {
    expect((await call('PUT', '/api/admin/organizations/1', ADMIN_A, { name: '   ' })).status).toBe(400);
    const long = await call('PUT', '/api/admin/organizations/1', ADMIN_A, { name: 'A'.repeat(201) });
    expect(long.status).toBe(400);
    expect(long.body.error).toBe('name max 200 chars');
    expect((await call('PUT', '/api/admin/organizations/1', ADMIN_A, { name: 'A'.repeat(200) })).status).toBe(200);
  });

  test('create still works for an ordinary name', async () => {
    const r = await call('POST', '/api/admin/organizations', SYS, { slug: 'newco', name: 'NewCo Painting' });
    expect(r.status).toBe(200);
    expect(r.body.organization.name).toBe('NewCo Painting');
  });
});
