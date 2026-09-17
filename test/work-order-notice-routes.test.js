// NOTIFY AGAIN — POST /api/service-tickets/:id/notify-approvers, EXECUTED.
//
// The real router (server/routes/work-order-notice-routes.js) runs its whole
// middleware chain — real requireAuth over a signed JWT, real requireOrgId, the
// real role cache loaded from a `roles` table, the real access module and the
// real approval notice — against node:sqlite through the pg shim. Only the two
// senders are replaced, so what was SENT is part of the assertion:
//   * a missing id, another org's id and a job the caller cannot edit all
//     answer the same 404; no capability is a 403 naming the capabilities;
//   * a work order that is not at Work complete is a 409 with the office's
//     wording, and nothing is sent;
//   * the messages the button shows: "Told N people.", "Already sent in the
//     last 15 minutes.", "No one else who can approve…", "The notice didn't go
//     through…";
//   * Notify again never falls back to the company admins, and never reaches
//     another org — not even later: a press with nobody else to tell leaves a
//     gave-up work order gave-up, so the notice cron does not retry it to the
//     admins.
// Then the org predicate, the write tier and the status check are removed from a
// copy of the router and the same drive is shown to go wrong.
// Finally server/index.js is read for its wiring (the mount, the cron, the
// shutdown drain) — it cannot be required: it listens and exits.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

let mockEmails = [];
let mockPushes = [];
let mockEmailOk = true;
let mockPushSent = 1;
jest.mock('../server/email', () => ({
  sendEmail: async (m) => { mockEmails.push(m); return { ok: mockEmailOk }; },
  sendForEvent: async () => ({ ok: true }),
  isEnabled: () => true,
  isDryRun: () => false,
}));
jest.mock('../server/notify-events', () => ({
  sendPushForEvent: async (userId, key, payload) => { mockPushes.push({ userId, key, payload }); return { sent: mockPushSent }; },
}));

const ROUTES_DIR = path.join(__dirname, '..', 'server', 'routes');
const REAL = path.join(ROUTES_DIR, 'work-order-notice-routes.js');
const TABLES = [
  'organizations', 'users', 'roles', 'jobs', 'job_access', 'leads', 'tasks', 'attachments',
  'service_tickets', 'service_ticket_events', 'service_ticket_shares', 'service_ticket_participants',
];

const WIDE = 10;      // JOBS_EDIT_ANY: every job's work orders
const PM = 11;        // owns j1
const CREW = 20;      // narrow tier: a VIEW grant on j1, an EDIT grant on j2
const NOBODY = 40;    // no ticket capability
const ADMIN = 12;     // company admin, on nothing
const RIVAL = 50;     // wide, in org 2

const USERS = {
  [WIDE]: { role: 'wo_wide', org: 1 },
  [PM]: { role: 'wo_crew', org: 1 },
  [ADMIN]: { role: 'admin', org: 1 },
  [CREW]: { role: 'wo_crew', org: 1 },
  [NOBODY]: { role: 'wo_none', org: 1 },
  [RIVAL]: { role: 'wo_wide', org: 2 },
};

let eng;
let auth;
let router;
const tmpDirs = [];

function seed() {
  const caps = (list) => "'" + JSON.stringify(list) + "'";
  eng.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM roles; DELETE FROM jobs; DELETE FROM job_access;
    DELETE FROM leads; DELETE FROM tasks; DELETE FROM attachments; DELETE FROM service_tickets;
    DELETE FROM service_ticket_events; DELETE FROM service_ticket_shares; DELETE FROM service_ticket_participants;
    INSERT INTO organizations (id, name) VALUES (1, 'AGX'), (2, 'Rival Co');
    INSERT INTO roles (name, capabilities) VALUES
      ('wo_wide', ${caps(['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'LEADS_VIEW', 'LEADS_EDIT'])}),
      ('wo_crew', ${caps(['JOBS_VIEW_ASSIGNED', 'JOBS_EDIT_OWN'])}),
      ('admin',   ${caps(['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'LEADS_VIEW', 'LEADS_EDIT'])}),
      ('wo_none', ${caps(['ESTIMATES_VIEW'])});
    INSERT INTO users (id, name, email, role, organization_id, active, notification_prefs) VALUES
      (10, 'Wendy Wide',  'w@agx.test',     'wo_wide', 1, 1, '{}'),
      (11, 'Paula PM',    'pm@agx.test',    'wo_crew', 1, 1, '{}'),
      (12, 'Adam Admin',  'adam@agx.test',  'admin',   1, 1, '{}'),
      (20, 'Carl Crew',   'c@agx.test',     'wo_crew', 1, 1, '{}'),
      (40, 'Nora None',   'n@agx.test',     'wo_none', 1, 1, '{}'),
      (50, 'Rival Ray',   'r@rival.test',   'wo_wide', 2, 1, '{}'),
      (51, 'Rival Admin', 'ra@rival.test',  'admin',   2, 1, '{}');
    INSERT INTO jobs (id, owner_id, data, organization_id) VALUES
      ('j1', 11, '{"jobNumber":"M1001","title":"Latitude","contractAmount":24000}', 1),
      ('j2', 11, '{"jobNumber":"M1002","title":"Pines"}', 1),
      ('j9', 50, '{"jobNumber":"R1","title":"Rival job"}', 2);
    INSERT INTO job_access (job_id, user_id, access_level) VALUES ('j1', 20, 'view'), ('j2', 20, 'edit');
    INSERT INTO service_tickets (id, organization_id, title, job_id, lead_id, status, checklist, created_by, completed_at, archived_at) VALUES
      ('st1',  1, 'Latitude punch list', 'j1', NULL, 'work_complete', '[]', 10, datetime('now', '-3 hours'), NULL),
      ('st2',  1, 'Pines punch list',    'j2', NULL, 'work_complete', '[]', 11, datetime('now', '-3 hours'), NULL),
      ('stp',  1, 'Still going',         'j1', NULL, 'in_progress',   '[]', 10, NULL, NULL),
      ('sta',  1, 'Archived',            'j1', NULL, 'work_complete', '[]', 10, NULL, datetime('now', '-1 days')),
      ('stb',  2, 'RIVAL punch list',    'j9', NULL, 'work_complete', '[]', 50, NULL, NULL);
  `);
}

beforeAll(async () => {
  eng = createPgSqlite(sqliteSchema(TABLES), {
    jsonColumns: ['checklist', 'capabilities', 'detail', 'data', 'notification_prefs', 'tags'],
  });
  const db = require('../server/db');
  db.pool.query = eng.pool.query;
  db.pool.connect = eng.pool.connect;
  auth = require('../server/auth');
  auth.setRolePool(eng.pool);
  seed();
  await auth.refreshRoleCache();
  router = require(REAL);
});

beforeEach(() => {
  seed();
  mockEmails = [];
  mockPushes = [];
  mockEmailOk = true;
  mockPushSent = 1;
});

const flush = () => new Promise((r) => setTimeout(r, 25));

afterAll(async () => {
  await flush();
  require('../server/db').pool.query = async () => ({ rows: [], rowCount: 0 });
  if (eng) eng.close();
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
});

function fakeRes() {
  const res = { statusCode: 200, body: undefined, headersSent: false };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.body = p; res.headersSent = true; return res; };
  res.set = () => res;
  return res;
}

function tokenFor(uid) {
  const u = USERS[uid];
  return auth.signToken({ id: uid, email: uid + '@t.test', name: 'U' + uid, role: u.role, organization_id: u.org });
}

async function drive(r, method, routePath, opts) {
  const o = opts || {};
  const layer = r.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error('route not declared: ' + method + ' ' + routePath);
  const chain = layer.route.stack.map((s) => s.handle);
  const res = fakeRes();
  const req = {
    method: method.toUpperCase(),
    params: o.params || {},
    query: o.query || {},
    body: o.body || {},
    cookies: {},
    headers: o.as ? { authorization: 'Bearer ' + tokenFor(o.as) } : {},
    protocol: 'https',
    get: () => 'project86.test',
  };
  for (const h of chain) {
    let advanced = false;
    await h(req, res, (err) => { if (err) throw err; advanced = true; });
    if (!advanced) break;
  }
  return res;
}

const notifyAgain = (as, id, r) => drive(r || router, 'post', '/:id/notify-approvers', { as, params: { id }, body: { fallbackToAdmins: true, status: 'approved' } });
const row = (id) => eng.all('SELECT * FROM service_tickets WHERE id = ?', id)[0];
const eventsOf = (id) => eng.all('SELECT kind, detail, organization_id FROM service_ticket_events WHERE ticket_id = ? ORDER BY rowid', id);

function absolutizeRequires(src, fromDir) {
  return src.replace(/require\((['"])([^'"]+)\1\)/g, (_m, _q, spec) => {
    const resolved = spec.charAt(0) === '.'
      ? require.resolve(path.resolve(fromDir, spec))
      : require.resolve(spec, { paths: [fromDir] });
    return 'require(' + JSON.stringify(resolved.split(path.sep).join('/')) + ')';
  });
}

function mutant(anchor, replacement) {
  const src = fs.readFileSync(REAL, 'utf8').replace(/\r\n/g, '\n');
  if (src.split(anchor).length !== 2) throw new Error('anchor not found');
  const out = src.replace(anchor, () => replacement);
  if (out === src) throw new Error('mutation changed nothing');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p86-wonr-'));
  tmpDirs.push(dir);
  const p = path.join(dir, 'work-order-notice-routes.js');
  fs.writeFileSync(p, absolutizeRequires(out, ROUTES_DIR), 'utf8');
  return require(p);
}

describe('who may press Notify again', () => {
  test('a missing id, another org’s id and an archived work order are the same 404', async () => {
    for (const id of ['st_missing', 'stb', 'sta']) {
      const res = await notifyAgain(WIDE, id);
      expect([id, res.statusCode, res.body]).toEqual([id, 404, { error: 'Service ticket not found' }]);
    }
    const rival = await notifyAgain(RIVAL, 'st1');
    expect([rival.statusCode, rival.body]).toEqual([404, { error: 'Service ticket not found' }]);
    expect(mockEmails).toHaveLength(0);
    expect(row('stb').approval_notified_at).toBeNull();
  });

  test('the narrow tier with only a VIEW grant gets the same 404 a missing ticket gets; an EDIT grant may press it', async () => {
    const view = await notifyAgain(CREW, 'st1');
    expect([view.statusCode, view.body]).toEqual([404, { error: 'Service ticket not found' }]);
    expect(mockEmails).toHaveLength(0);
    const edit = await notifyAgain(CREW, 'st2');
    expect(edit.statusCode).toBe(200);
  });

  test('no ticket capability at all is a 403 naming what is missing', async () => {
    const res = await notifyAgain(NOBODY, 'st1');
    expect([res.statusCode, res.body]).toEqual([403, { error: 'Missing capability: JOBS_EDIT_ANY JOBS_EDIT_OWN' }]);
  });

  test('not signed in never reaches the handler', async () => {
    const res = await drive(router, 'post', '/:id/notify-approvers', { params: { id: 'st1' } });
    expect(res.statusCode).toBe(401);
    expect(mockEmails).toHaveLength(0);
  });

  test('a work order that is not waiting for approval: 409 with the office’s words, nothing sent', async () => {
    const res = await notifyAgain(WIDE, 'stp');
    expect([res.statusCode, res.body]).toEqual([409, { error: "This work order isn't waiting for approval." }]);
    expect([mockEmails.length, mockPushes.length]).toEqual([0, 0]);
  });
});

describe('what the button says', () => {
  test('sent: "Told 2 people.", with the notice on the timeline and the body ignored', async () => {
    eng.db.exec("UPDATE service_tickets SET created_by = 12 WHERE id = 'st1'");
    const res = await notifyAgain(WIDE, 'st1');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, sent: 2, recipients: 2, skipped: null, message: 'Told 2 people.' });
    expect(mockEmails.map((m) => m.to)).toEqual(['pm@agx.test', 'adam@agx.test']);
    expect(mockEmails.every((m) => m.senderOrg.id === 1 && m.organizationId === 1)).toBe(true);
    expect(JSON.stringify(mockEmails)).not.toMatch(/24000|contract/i);
    const ev = eventsOf('st1').filter((e) => e.kind === 'approval_notified');
    expect(ev.map((e) => e.detail)).toEqual([{ names: ['Paula PM', 'Adam Admin'], reason: 'notify_again' }]);
    expect(row('st1').status).toBe('work_complete');     // the body's status was not read
  });

  test('"Told 1 person."', async () => {
    const res = await notifyAgain(WIDE, 'st1');
    expect(res.body.message).toBe('Told 1 person.');
    expect(mockEmails.map((m) => m.to)).toEqual(['pm@agx.test']);
  });

  test('a second press inside 15 minutes: "Already sent in the last 15 minutes."', async () => {
    await notifyAgain(WIDE, 'st1');
    mockEmails = [];
    const res = await notifyAgain(WIDE, 'st1');
    expect(res.body).toEqual({
      ok: true, sent: 0, recipients: 1, skipped: 'already_notified', message: 'Already sent in the last 15 minutes.',
    });
    expect(mockEmails).toHaveLength(0);
  });

  test('the caller is the only approver: no admins are asked, and the button says so', async () => {
    // st2: PM 11 owns j2 and raised it; the company admin (12) and Wendy (10)
    // can approve everything but are not ON it.
    const res = await notifyAgain(PM, 'st2');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      ok: true, sent: 0, recipients: 0, skipped: 'no_recipients',
      message: 'No one else who can approve this work order has these notices turned on.',
    });
    expect([mockEmails.length, mockPushes.length]).toEqual([0, 0]);
    expect(row('st2').approval_notified_at).toBeNull();
  });

  test('the only approver presses it on a work order nobody has been told about: it stays that way, and the cron never takes it to the admins', async () => {
    // Paula moved st2 to Work complete herself; the notice gave up hours ago.
    // Every other ticket is freshly claimed, so the cron has nothing else to do.
    eng.db.exec(`
      UPDATE service_tickets SET approval_notified_at = datetime('now') WHERE id <> 'st2';
      UPDATE service_tickets SET approval_notice_attempts = 4, approval_notice_last_try_at = datetime('now', '-5 hours'),
             approval_notice_gave_up_at = datetime('now', '-5 hours') WHERE id = 'st2';
      INSERT INTO service_ticket_events (id, organization_id, ticket_id, kind, actor_kind, actor_user_id, detail, created_at)
        VALUES ('e_arr', 1, 'st2', 'status_changed', 'user', 11, '{"from":"in_progress","to":"work_complete"}', datetime('now', '-6 hours'));
    `);
    const keep = () => { const t = row('st2'); return [t.approval_notice_attempts, t.approval_notice_last_try_at, t.approval_notice_gave_up_at]; };
    const before = keep();
    const res = await notifyAgain(PM, 'st2');
    expect(res.body.skipped).toBe('no_recipients');
    expect(keep()).toEqual(before);

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      // Well past every backoff step.
      eng.db.exec("UPDATE service_tickets SET approval_notice_last_try_at = datetime('now', '-11 hours') WHERE id = 'st2'");
      const out = await require('../server/work-order-notify-cron').runOnce({ deps: { db: eng.pool } });
      expect(out.approvals).toMatchObject({ candidates: 0, retried: 0 });
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
    expect(mockEmails.map((m) => m.to)).not.toContain('adam@agx.test');
    expect([mockEmails.length, mockPushes.length]).toEqual([0, 0]);
    expect(eventsOf('st2').map((e) => e.kind)).toEqual(['status_changed']);
    expect(row('st2').approval_notice_attempts).toBe(4);
    expect(row('st2').approval_notice_gave_up_at).not.toBeNull();
  });

  test('nobody reached: "The notice didn\'t go through. It will be tried again automatically."', async () => {
    mockEmailOk = false;
    mockPushSent = 0;
    const res = await notifyAgain(WIDE, 'st1');
    expect(res.body).toEqual({
      ok: true, sent: 0, recipients: 1, skipped: 'nobody_reached',
      message: "The notice didn't go through. It will be tried again automatically.",
    });
    expect(row('st1').approval_notice_attempts).toBe(1);
    expect(row('st1').approval_notified_at).toBeNull();
  });

  test('a gave-up work order starts again from zero when pressed', async () => {
    eng.db.exec("UPDATE service_tickets SET approval_notice_attempts = 4, approval_notice_gave_up_at = datetime('now', '-1 hours') WHERE id = 'st1'");
    const res = await notifyAgain(WIDE, 'st1');
    expect(res.body.message).toBe('Told 1 person.');
    expect(row('st1').approval_notice_attempts).toBe(0);
    expect(row('st1').approval_notice_gave_up_at).toBeNull();
  });
});

describe('mutants', () => {
  test('MUTANT: drop the org predicate on the load and another org’s user notifies this org’s approvers', async () => {
    const real = await notifyAgain(RIVAL, 'st1');
    expect(real.statusCode).toBe(404);
    const mod = mutant(
      'WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL`,\n      [String(req.params.id), orgId]',
      'WHERE id = $1 AND archived_at IS NULL`,\n      [String(req.params.id)]');
    const res = await notifyAgain(RIVAL, 'st1', mod);
    expect(res.statusCode).toBe(200);
    expect(mockEmails.map((m) => m.to)).toContain('pm@agx.test');
  });

  test('MUTANT: check READ instead of WRITE and a view grant may press it', async () => {
    const mod = mutant("      mode: 'write',\n      orgId,", "      mode: 'read',\n      orgId,");
    const res = await notifyAgain(CREW, 'st1', mod);
    expect(res.statusCode).toBe(200);
  });

  test('MUTANT: drop the waiting check and an in-progress work order is answered as if it were waiting', async () => {
    const mod = mutant(
      "    if (ticket.status !== 'work_complete') return res.status(409).json({ error: NOT_WAITING });\n",
      '');
    const res = await notifyAgain(WIDE, 'stp', mod);
    expect(res.statusCode).toBe(200);
  });
});

describe('server/index.js wiring (read, not run: it listens and exits)', () => {
  const INDEX = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8').replace(/\r\n/g, '\n');

  test('the router is mounted at /api/service-tickets directly after the ticket routes', () => {
    const tickets = INDEX.indexOf("app.use('/api/service-tickets', serviceTicketRoutes);");
    const notice = INDEX.indexOf("app.use('/api/service-tickets', require('./routes/work-order-notice-routes'));");
    expect(tickets).toBeGreaterThan(0);
    expect(notice).toBeGreaterThan(tickets);
    const between = INDEX.slice(tickets, notice).split('\n').slice(1).filter((l) => !/^\s*\/\//.test(l) && l.trim());
    expect(between).toEqual([]);
  });

  test('the notice cron starts after the reminders cron, inside the database block', () => {
    const reminders = INDEX.indexOf("require('./reminders-cron').start();");
    const cron = INDEX.indexOf("require('./work-order-notify-cron').start();");
    expect(reminders).toBeGreaterThan(0);
    expect(cron).toBeGreaterThan(reminders);
    expect(INDEX.indexOf('if (process.env.DATABASE_URL) {')).toBeLessThan(cron);
  });

  test('SIGTERM and SIGINT drain the in-flight notices once, with a hard stop, and the server handle is kept', () => {
    expect(INDEX).toContain('httpServer = app.listen(PORT');
    expect(INDEX).toContain("process.once('SIGTERM'");
    expect(INDEX).toContain("process.once('SIGINT'");
    const body = INDEX.slice(INDEX.indexOf('async function shutdown(signal) {'), INDEX.indexOf("process.once('SIGTERM'"));
    const order = ['if (shuttingDown) return;', 'inflight.beginClosing();', "require('./work-order-notify-cron').stop();",
      'httpServer.close();', 'await inflight.drain(budget);', 'process.exit(0);'];
    let at = -1;
    for (const step of order) {
      const next = body.indexOf(step, at + 1);
      expect([step, next > at]).toEqual([step, true]);
      at = next;
    }
    expect(body).toContain('Number(process.env.SHUTDOWN_DRAIN_MS) || 8000');
    expect(body).toMatch(/budget \+ 2000\);\n\s*if \(hardStop\.unref\) hardStop\.unref\(\);/);
  });
});
