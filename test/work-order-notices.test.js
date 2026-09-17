// ASSIGNMENT, SEND-BACK, PROBLEM AND CREW-ACTIVITY NOTICES.
//
// services/work-order-notices.js, driven against node:sqlite through the pg
// shim over the schema server/db.js writes, with the email and push senders
// injected so what was SENT is the assertion:
//   * assignment: only on a real change, never to yourself, only to someone who
//     can open the work order, email and push each honouring their own
//     preference, Reply-To the assigner's own in-org address, one timeline line;
//   * send back (crew-facing): only live respond/propose links with an address,
//     one email per address, no link, no token, no money, a count-only
//     timeline line;
//   * problem flagged: everyone on the work order incl. every link's sender,
//     admins when nobody can open it, once per flag, crew text stripped of
//     links, Reply-To the link's own address;
//   * crew activity: which events count, the work_complete drop, no fallback,
//     no timeline line;
//   * nothing throws when a sender throws or the database fails.
// Rules are then removed from a copy of the module and shown to fail.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const REAL = path.join(__dirname, '..', 'server', 'services', 'work-order-notices.js');
const N = require(REAL);

const TABLES = ['organizations', 'users', 'jobs', 'leads', 'job_access', 'tasks', 'service_tickets',
  'service_ticket_shares', 'service_ticket_participants', 'service_ticket_events', 'service_ticket_revisions'];

const ROLE_CAPS = {
  admin: ['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'LEADS_VIEW', 'LEADS_EDIT'],
  pm: ['JOBS_VIEW_ALL', 'JOBS_EDIT_OWN', 'LEADS_VIEW', 'LEADS_EDIT'],
  crew: ['JOBS_VIEW_ASSIGNED', 'JOBS_EDIT_OWN'],
};
const hasCapability = (user, cap) => String(cap || '').split(/\s+/).filter(Boolean)
  .some((k) => (ROLE_CAPS[user && user.role] || []).includes(k));

const MONEY = /24000|24,000|contract|\$|price|cost/i;

let eng;
const tmpDirs = [];
let warn;

beforeAll(() => {
  eng = createPgSqlite(sqliteSchema(TABLES), { jsonColumns: ['data', 'notification_prefs', 'fields'] });
});
afterAll(() => {
  if (eng) eng.close();
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
});

function seed() {
  eng.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM jobs; DELETE FROM leads; DELETE FROM job_access;
    DELETE FROM tasks; DELETE FROM service_tickets; DELETE FROM service_ticket_shares;
    DELETE FROM service_ticket_participants; DELETE FROM service_ticket_events; DELETE FROM service_ticket_revisions;
    INSERT INTO organizations (id, name) VALUES (1, 'AGX'), (2, 'Rival');
    INSERT INTO users (id, name, email, role, organization_id, active, notification_prefs) VALUES
      (10, 'Paula PM',       'pm@agx.test',      'pm',    1, 1, '{}'),
      (11, 'Ana Assignee',   'ana@agx.test',     'crew',  1, 1, '{}'),
      (13, 'Cora Creator',   'creator@agx.test', 'admin', 1, 1, '{}'),
      (14, 'Sam Sender',     'sender@agx.test',  'admin', 1, 1, '{}'),
      (15, 'Ivan Inactive',  'gone@agx.test',    'crew',  1, 0, '{}'),
      (17, 'Olive Outsider', 'olive@agx.test',   'crew',  1, 1, '{}'),
      (18, 'Mia Muted',      'muted@agx.test',   'crew',  1, 1, '{"ticket_assignment":false,"push":{"ticket_assignment":false}}'),
      (19, 'Eve EmailOff',   'eve@agx.test',     'crew',  1, 1, '{"ticket_assignment":false,"ticket_problem":false}'),
      (20, 'Pat PushOff',    'pat@agx.test',     'crew',  1, 1, '{"push":{"ticket_assignment":false}}'),
      (30, 'Adam Admin',     'adam@agx.test',    'admin', 1, 1, '{}'),
      (50, 'Rival Ray',      'ray@rival.test',   'admin', 2, 1, '{}');
    INSERT INTO job_access (job_id, user_id, access_level) VALUES
      ('j1', 11, 'edit'), ('j1', 18, 'edit'), ('j1', 19, 'edit'), ('j1', 20, 'edit');
    INSERT INTO jobs (id, owner_id, lead_id, organization_id, data) VALUES
      ('j1', 10, NULL, 1, '{"jobNumber":"M1001","title":"BH Management Latitude","street_address":"828 Orienta Ave","city":"Altamonte Springs","state":"FL","zip":"32701","contractAmount":24000}'),
      ('j2', NULL, NULL, 1, '{"jobNumber":"M1002","title":"Nobody runs this","contractAmount":24000}');
    INSERT INTO service_tickets (id, organization_id, title, job_id, lead_id, status, priority, scheduled_for, created_by, assignee_user_id, scope_approved, internal_notes) VALUES
      ('st1', 1, 'Latitude 28 punch list', 'j1', NULL, 'in_progress',   'high',   '2026-09-18', 13, NULL, 'Approved at $24,000', 'secret office note'),
      ('stw', 1, 'Done and waiting',       'j1', NULL, 'work_complete', 'normal', NULL,         13, NULL, NULL, NULL),
      ('st2', 1, 'Nobody can open it',     'j2', NULL, 'open',          'normal', NULL,         17, NULL, NULL, NULL);
    INSERT INTO tasks (id, organization_id, title, status, scope, service_ticket_id, entity_type, entity_id) VALUES
      ('t782', 1, 'Bldg 782 — Side A: railing', 'done', 'org', 'st1', 'job', 'j1'),
      ('t784', 1, 'Bldg 784 — Side A: post',    'open', 'org', 'st1', 'job', 'j1'),
      ('tpriv', 1, 'private to-do',             'open', 'personal', 'st1', 'job', 'j1');
    INSERT INTO service_ticket_shares (id, organization_id, ticket_id, token_hash, scope, recipient_email, recipient_name, expires_at, revoked_at, created_by, created_at) VALUES
      ('sh_resp',    1, 'st1', 'hash_resp',    'respond', 'marco@crew.test',    'Marco',   '2099-01-01', NULL,         14, '2026-09-02 09:00:00'),
      ('sh_jose',    1, 'st1', 'hash_jose',    'respond', 'jose@crew.test',     'Jose',    '2099-01-01', NULL,         14, '2026-09-02 09:30:00'),
      ('sh_prop',    1, 'st1', 'hash_prop',    'propose', ' MARCO@crew.test ',  'Marco R', '2099-01-01', NULL,         14, '2026-09-02 10:00:00'),
      ('sh_view',    1, 'st1', 'hash_view',    'view',    'viewer@crew.test',   'Vic',     '2099-01-01', NULL,         14, '2026-09-02 10:10:00'),
      ('sh_revoked', 1, 'st1', 'hash_revoked', 'respond', 'revoked@crew.test',  'Rev',     '2099-01-01', '2026-09-03', 14, '2026-09-02 10:20:00'),
      ('sh_expired', 1, 'st1', 'hash_expired', 'respond', 'old@crew.test',      'Old',     '2000-01-01', NULL,         14, '2026-09-02 10:30:00'),
      ('sh_noemail', 1, 'st1', 'hash_noemail', 'respond', NULL,                 'None',    '2099-01-01', NULL,         14, '2026-09-02 10:40:00'),
      ('sh_blank',   1, 'st1', 'hash_blank',   'respond', '',                   'Blank',   '2099-01-01', NULL,         14, '2026-09-02 10:50:00'),
      ('sh_rival',   2, 'st1', 'hash_rival',   'respond', 'spy@rival.test',     'Spy',     '2099-01-01', NULL,         50, '2026-09-02 11:00:00');
    INSERT INTO service_ticket_revisions (id, organization_id, ticket_id, status, fields, created_at) VALUES
      ('rv1', 1, 'st1', 'pending',  '{}', '2026-09-02 09:00:00'),
      ('rv2', 1, 'st1', 'accepted', '{}', '2026-09-02 09:00:00'),
      ('rv_rival', 2, 'st1', 'pending', '{}', '2026-09-02 09:00:00');
  `);
}

beforeEach(() => {
  seed();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { warn.mockRestore(); });

// Never the new wave-1 bookkeeping columns: a notice is handed the row it needs.
const ticket = (id) => eng.all(
  'SELECT id, organization_id, title, job_id, lead_id, status, priority, scheduled_for, due_date, created_by, assignee_user_id, street_address, city, state, zip, access_notes FROM service_tickets WHERE id = ?', id)[0];
const eventsOf = (id) => eng.all('SELECT kind, actor_kind, actor_user_id, share_id, detail FROM service_ticket_events WHERE ticket_id = ? ORDER BY rowid', id);

function senders(opts) {
  const o = opts || {};
  const s = { emails: [], pushes: [] };
  s.deps = {
    sendEmail: async (m) => {
      s.emails.push(m);
      if (o.emailThrows) throw new Error('smtp down');
      if (o.failTo && o.failTo.includes(m.to)) return { ok: false };
      return { ok: true };
    },
    sendPush: async (userId, key, payload, prefs) => {
      s.pushes.push({ userId, key, payload, prefs });
      if (o.pushThrows) throw new Error('push down');
      return { sent: o.noPush ? 0 : 1 };
    },
    hasCapability,
  };
  if (o.disabled) s.deps.isEnabled = () => false;
  return s;
}

function mutant(anchor, replacement) {
  const src = fs.readFileSync(REAL, 'utf8').replace(/\r\n/g, '\n');
  if (src.split(anchor).length !== 2) throw new Error('anchor not found');
  let out = src.replace(anchor, () => replacement);
  if (out === src) throw new Error('mutation changed nothing');
  const dir = path.dirname(REAL);
  out = out.replace(/require\((['"])(\.{1,2}\/[^'"]+)\1\)/g,
    (_m, _q, rel) => 'require(' + JSON.stringify(path.resolve(dir, rel).split(path.sep).join('/')) + ')');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p86-won-'));
  tmpDirs.push(tmp);
  const p = path.join(tmp, 'work-order-notices.js');
  fs.writeFileSync(p, out, 'utf8');
  return require(p);
}

const PAULA = { kind: 'user', userId: 10, label: 'Paula PM' };
const LINK = 'https://project86.net/jobs/j1/job-service-tickets?ticket=st1';

describe('assignment', () => {
  test('the new assignee hears by email and push, from the assigner, with a timeline line', async () => {
    const s = senders();
    const r = await N.notifyAssigned(eng.pool, { ticket: ticket('st1'), assigneeUserId: 11, previousAssigneeUserId: null, actor: PAULA }, s.deps);
    expect(r).toEqual({ sent: 1 });
    expect(s.emails).toHaveLength(1);
    const m = s.emails[0];
    expect(m.to).toBe('ana@agx.test');
    expect(m.subject).toBe('Assigned to you: Latitude 28 punch list — M1001 · BH Management Latitude');
    expect(m.text).toContain('Paula PM assigned you "Latitude 28 punch list".');
    expect(m.text).toContain('Punch list: 1 of 2 buildings done');
    expect(m.text).toContain('Priority: High');
    expect(m.text).toContain('Open work order: ' + LINK);
    expect(m.tag).toBe('ticket_assignment');
    expect(m.organizationId).toBe(1);
    expect(m.senderOrg).toEqual({ id: 1, name: 'AGX' });
    expect(m.replyTo).toBe('pm@agx.test');
    expect(m.subject + m.text + m.html).not.toMatch(MONEY);
    expect(m.text + m.html).not.toContain('secret office note');
    expect(s.pushes).toEqual([{
      userId: 11, key: 'ticket_assignment', prefs: {},
      payload: { title: '📋 Assigned to you', body: 'M1001 · BH Management Latitude — Latitude 28 punch list: assigned by Paula PM.', url: LINK, tag: 'ticket_assignment:st1' },
    }]);
    const ev = eventsOf('st1');
    expect(ev).toEqual([{ kind: 'assignee_notified', actor_kind: 'system', actor_user_id: null, share_id: null, detail: { names: ['Ana Assignee'] } }]);
  });

  test.each([
    ['unchanged', { assigneeUserId: 11, previousAssigneeUserId: '11' }, 'unchanged'],
    ['assigning yourself', { assigneeUserId: 10, previousAssigneeUserId: null }, 'self'],
    ['no assignee', { assigneeUserId: null }, 'no_user'],
    ['a bad id', { assigneeUserId: 'abc' }, 'no_user'],
    ['an inactive user', { assigneeUserId: 15 }, 'no_user'],
    ['another org’s user', { assigneeUserId: 50 }, 'no_user'],
    ['someone who cannot open the job', { assigneeUserId: 17 }, 'no_access'],
    ['someone who muted both channels', { assigneeUserId: 18 }, 'muted'],
  ])('%s: nothing sent', async (_label, extra, skipped) => {
    const s = senders();
    const r = await N.notifyAssigned(eng.pool, Object.assign({ ticket: ticket('st1'), actor: PAULA }, extra), s.deps);
    expect(r).toEqual({ sent: 0, skipped });
    expect([s.emails.length, s.pushes.length]).toEqual([0, 0]);
    expect(eventsOf('st1')).toHaveLength(0);
  });

  test('email and push each honour their own preference', async () => {
    const emailOff = senders();
    await N.notifyAssigned(eng.pool, { ticket: ticket('st1'), assigneeUserId: 19, actor: PAULA }, emailOff.deps);
    expect(emailOff.emails).toHaveLength(0);
    expect(emailOff.pushes.map((p) => p.userId)).toEqual([19]);

    const pushOff = senders();
    await N.notifyAssigned(eng.pool, { ticket: ticket('st1'), assigneeUserId: 20, actor: PAULA }, pushOff.deps);
    expect(pushOff.emails.map((m) => m.to)).toEqual(['pat@agx.test']);
    expect(pushOff.pushes).toHaveLength(0);
  });

  test('86 assigning (no label): the assigner is named from their own row; act-as from another org puts no Reply-To', async () => {
    const s = senders();
    await N.notifyAssigned(eng.pool, { ticket: ticket('st1'), assigneeUserId: 11, actor: { kind: 'user', userId: 14, label: null } }, s.deps);
    expect(s.emails[0].text).toContain('Sam Sender assigned you');
    expect(s.emails[0].replyTo).toBe('sender@agx.test');

    const foreign = senders();
    await N.notifyAssigned(eng.pool, { ticket: ticket('st1'), assigneeUserId: 11, actor: { kind: 'user', userId: 50, label: null } }, foreign.deps);
    expect(foreign.emails[0].replyTo).toBe(false);
    expect(foreign.emails[0].text).toContain('A teammate assigned you');
    expect(JSON.stringify(foreign.emails)).not.toContain('rival');
  });

  test('nobody reached: no timeline line', async () => {
    const s = senders({ failTo: ['ana@agx.test'], noPush: true });
    const r = await N.notifyAssigned(eng.pool, { ticket: ticket('st1'), assigneeUserId: 11, actor: PAULA }, s.deps);
    expect(r).toEqual({ sent: 0 });
    expect(eventsOf('st1')).toHaveLength(0);
  });

  test('never throws: a throwing sender still pushes; a failing database answers error', async () => {
    const s = senders({ emailThrows: true });
    expect(await N.notifyAssigned(eng.pool, { ticket: ticket('st1'), assigneeUserId: 11, actor: PAULA }, s.deps)).toEqual({ sent: 1 });
    const dead = { query: async () => { throw new Error('db down'); } };
    expect(await N.notifyAssigned(dead, { ticket: ticket('st1'), assigneeUserId: 11, actor: PAULA }, senders().deps))
      .toEqual({ sent: 0, skipped: 'error' });
    expect(await N.notifyAssigned(eng.pool, null, senders().deps)).toEqual({ sent: 0, skipped: 'error' });
  });

  test('MUTANT: skip the access check and someone who cannot open the job is emailed about it', async () => {
    const mod = mutant(
      "    if (!(await memo.check(db, u, ticket, 'read', orgId))) return { sent: 0, skipped: 'no_access' };\n", '');
    const s = senders();
    await mod.notifyAssigned(eng.pool, { ticket: ticket('st1'), assigneeUserId: 17, actor: PAULA }, s.deps);
    expect(s.emails.map((m) => m.to)).toContain('olive@agx.test');
  });

  test('MUTANT: ignore the email preference and a muted inbox is written to', async () => {
    const mod = mutant("  return !!(u && u.email) && prefsOf(u)[key] !== false;", '  return !!(u && u.email);');
    const s = senders();
    await mod.notifyAssigned(eng.pool, { ticket: ticket('st1'), assigneeUserId: 19, actor: PAULA }, s.deps);
    expect(s.emails.map((m) => m.to)).toContain('eve@agx.test');
  });

  test('MUTANT: forget the previous assignee and a save that did not change it notifies again', async () => {
    const mod = mutant("    if (assignee === positiveInt(o.previousAssigneeUserId)) return { sent: 0, skipped: 'unchanged' };\n", '');
    const s = senders();
    await mod.notifyAssigned(eng.pool, { ticket: ticket('st1'), assigneeUserId: 11, previousAssigneeUserId: 11, actor: PAULA }, s.deps);
    expect(s.emails).toHaveLength(1);
  });
});

describe('send back (crew-facing)', () => {
  const SEND_BACK = {
    note: 'Railing at the stairs is loose.',
    buildings: [{ task_id: 't782', title: 'Bldg 782 — Side A: railing', note: 'Retighten the posts', reopened: true }],
  };

  test('recipients: live respond/propose links with an address, newest first, one per address', async () => {
    expect(await N.sendBackRecipients(eng.pool, ticket('st1'))).toEqual([
      { share_id: 'sh_prop', email: 'MARCO@crew.test', name: 'Marco R' },
      { share_id: 'sh_jose', email: 'jose@crew.test', name: 'Jose' },
    ]);
  });

  test('at most ten addresses', async () => {
    for (let i = 0; i < 12; i++) {
      eng.db.exec(`INSERT INTO service_ticket_shares (id, organization_id, ticket_id, token_hash, scope, recipient_email, expires_at, created_by, created_at)
        VALUES ('shx${i}', 1, 'st1', 'hx${i}', 'respond', 'crew${i}@crew.test', '2099-01-01', 14, '2026-09-04 09:${String(i).padStart(2, '0')}:00')`);
    }
    const list = await N.sendBackRecipients(eng.pool, ticket('st1'));
    expect(list).toHaveLength(10);
    expect(list[0].email).toBe('crew11@crew.test');
  });

  test('one email per address with the reason and buildings, no link, no token, no money; a count-only timeline line', async () => {
    const s = senders();
    const r = await N.notifySentBack(eng.pool, { ticket: ticket('st1'), actor: PAULA, sendBack: SEND_BACK }, s.deps);
    expect(r).toEqual({ sent: 2, failed: 0 });
    expect(s.emails.map((m) => m.to)).toEqual(['MARCO@crew.test', 'jose@crew.test']);
    expect(s.pushes).toHaveLength(0);
    for (const m of s.emails) {
      expect(m.subject).toBe('Sent back for more work: Latitude 28 punch list — BH Management Latitude');
      expect(m.text).toContain('AGX sent this work order back for more work: "Latitude 28 punch list".');
      expect(m.text).toContain('What needs fixing:\nRailing at the stairs is loose.');
      expect(m.text).toContain('Buildings to redo:\n- Bldg 782 — Retighten the posts');
      expect(m.text).toContain('Address: 828 Orienta Ave, Altamonte Springs, FL, 32701');
      expect(m.tag).toBe('service_ticket_sent_back');
      expect(m.organizationId).toBe(1);
      expect(m.senderOrg).toEqual({ id: 1, name: 'AGX' });
      expect(m.replyTo).toBe('pm@agx.test');
      const all = m.subject + m.text + m.html;
      expect(all).not.toMatch(/\/st\/|hash_|token|job-service-tickets/);
      expect(all).not.toMatch(/24000|24,000|contract|\$/i);
      expect(all).not.toContain('secret office note');
    }
    expect(s.emails[0].text).toContain('Hi Marco R,');
    const ev = eventsOf('st1');
    expect(ev).toEqual([{ kind: 'crew_emailed', actor_kind: 'system', actor_user_id: null, share_id: null, detail: { about: 'send_back', sent: 2, failed: 0 } }]);
    expect(JSON.stringify(ev)).not.toContain('@');
  });

  test('a failed or throwing send counts as failed; email switched off counts every address as failed', async () => {
    const one = senders({ failTo: ['jose@crew.test'] });
    expect(await N.notifySentBack(eng.pool, { ticket: ticket('st1'), actor: PAULA, sendBack: SEND_BACK }, one.deps)).toEqual({ sent: 1, failed: 1 });

    const thrown = senders({ emailThrows: true });
    expect(await N.notifySentBack(eng.pool, { ticket: ticket('st1'), actor: PAULA, sendBack: SEND_BACK }, thrown.deps)).toEqual({ sent: 0, failed: 2 });

    const off = senders({ disabled: true });
    expect(await N.notifySentBack(eng.pool, { ticket: ticket('st1'), actor: PAULA, sendBack: SEND_BACK }, off.deps)).toEqual({ sent: 0, failed: 2 });
    expect(off.emails).toHaveLength(0);
    expect(eventsOf('st1').map((e) => e.detail)).toEqual([
      { about: 'send_back', sent: 1, failed: 1 },
      { about: 'send_back', sent: 0, failed: 2 },
      { about: 'send_back', sent: 0, failed: 2 },
    ]);
  });

  test('no reason, or no link with an address: nothing sent and no timeline line', async () => {
    const s = senders();
    expect(await N.notifySentBack(eng.pool, { ticket: ticket('st1'), actor: PAULA, sendBack: { note: '   ' } }, s.deps))
      .toEqual({ sent: 0, failed: 0, skipped: 'no_reason' });
    expect(await N.notifySentBack(eng.pool, { ticket: ticket('st2'), actor: PAULA, sendBack: SEND_BACK }, s.deps))
      .toEqual({ sent: 0, failed: 0, skipped: 'no_link_email' });
    expect(s.emails).toHaveLength(0);
    expect(eventsOf('st1').concat(eventsOf('st2'))).toHaveLength(0);
  });

  test('recipients the caller already read are used as given (deduped)', async () => {
    const s = senders();
    const r = await N.notifySentBack(eng.pool, {
      ticket: ticket('st1'), actor: PAULA, sendBack: SEND_BACK,
      recipients: [{ share_id: 'a', email: 'x@crew.test', name: 'X' }, { share_id: 'b', email: 'X@crew.test', name: 'Y' }],
    }, s.deps);
    expect(r).toEqual({ sent: 1, failed: 0 });
    expect(s.emails.map((m) => m.to)).toEqual(['x@crew.test']);
  });

  test('never throws', async () => {
    const dead = { query: async () => { throw new Error('db down'); } };
    expect(await N.notifySentBack(dead, { ticket: ticket('st1'), actor: PAULA, sendBack: SEND_BACK }, senders().deps))
      .toEqual({ sent: 0, failed: 0, skipped: 'no_link_email' });
    expect(await N.notifySentBack(eng.pool, undefined, senders().deps)).toEqual({ sent: 0, failed: 0, skipped: 'error' });
    expect(await N.sendBackRecipients(dead, ticket('st1'))).toEqual([]);
  });

  test('MUTANT: drop the scope filter and a view-only link is emailed to redo work', async () => {
    const mod = mutant("\n          AND scope IN ('respond','propose')", '\n         ');
    const s = senders();
    await mod.notifySentBack(eng.pool, { ticket: ticket('st1'), actor: PAULA, sendBack: SEND_BACK }, s.deps);
    expect(s.emails.map((m) => m.to)).toContain('viewer@crew.test');
  });

  test('MUTANT: drop the org predicate on the links and another tenant’s address is emailed', async () => {
    const mod = mutant(
      'WHERE ticket_id = $1 AND organization_id = $2 AND revoked_at IS NULL',
      'WHERE ticket_id = $1 AND (organization_id = $2 OR 1 = 1) AND revoked_at IS NULL');
    const s = senders();
    await mod.notifySentBack(eng.pool, { ticket: ticket('st1'), actor: PAULA, sendBack: SEND_BACK }, s.deps);
    expect(s.emails.map((m) => m.to)).toContain('spy@rival.test');
  });
});

describe('problem flagged', () => {
  const SHARE = { id: 'sh_resp', created_by: 14, recipient_name: 'Marco' };
  const FLAG = {
    id: 'stflag1', category: 'extra_damage', task_id: 't784', photo_count: 2,
    note: 'Rot https://evil.co www.x.com me@evil.test p86-review.com Bldg.784 Note: bad',
  };

  test('everyone on the work order who can open it hears, once, with links taken out of the crew’s note', async () => {
    const s = senders();
    const r = await N.notifyProblemFlagged(eng.pool, { ticket: ticket('st1'), share: SHARE, flag: FLAG }, s.deps);
    expect(r).toEqual({ sent: 3, recipients: 3 });
    expect(s.emails.map((m) => m.to)).toEqual(['pm@agx.test', 'creator@agx.test', 'sender@agx.test']);
    const m = s.emails[0];
    expect(m.subject).toBe('Problem flagged: Extra damage — Latitude 28 punch list — M1001 · BH Management Latitude');
    expect(m.text).toContain('Marco (via the crew link) flagged a problem on "Latitude 28 punch list" at Bldg 784 — Side A: post.');
    expect(m.text).toContain('\nNote: Rot [link removed] Bldg.784 Note: bad\n');
    expect(m.text).toContain('\nPhotos: 2\n');
    expect(m.tag).toBe('ticket_problem');
    expect(m.replyTo).toBe('marco@crew.test');
    expect(m.senderOrg).toEqual({ id: 1, name: 'AGX' });
    const all = JSON.stringify(s.emails) + JSON.stringify(s.pushes);
    expect(all).not.toMatch(/evil|p86-review|24000|contract/);
    expect(s.pushes[0].payload.title).toBe('⚠️ Problem flagged: Extra damage');
    expect(s.pushes[0].payload.tag).toBe('ticket_problem:stflag1');
    expect(s.pushes[0].payload.body).not.toMatch(/[\r\n]/);
    expect(eventsOf('st1')).toEqual([{
      kind: 'flag_notified', actor_kind: 'system', actor_user_id: null, share_id: null,
      detail: { names: ['Paula PM', 'Cora Creator', 'Sam Sender'], flag_id: 'stflag1' },
    }]);

    const again = senders();
    expect(await N.notifyProblemFlagged(eng.pool, { ticket: ticket('st1'), share: SHARE, flag: FLAG }, again.deps))
      .toEqual({ sent: 0, skipped: 'already_notified' });
    expect([again.emails.length, again.pushes.length]).toEqual([0, 0]);
    // A different flag on the same ticket is its own notice.
    const other = senders();
    expect((await N.notifyProblemFlagged(eng.pool, { ticket: ticket('st1'), share: SHARE, flag: Object.assign({}, FLAG, { id: 'stflag2' }) }, other.deps)).sent).toBe(3);
  });

  test('every link’s sender is on the list, not only this link’s', async () => {
    eng.db.exec("UPDATE service_ticket_shares SET created_by = 11 WHERE id = 'sh_jose'");
    const s = senders();
    await N.notifyProblemFlagged(eng.pool, { ticket: ticket('st1'), share: SHARE, flag: FLAG }, s.deps);
    expect(s.emails.map((m) => m.to)).toEqual(['pm@agx.test', 'creator@agx.test', 'sender@agx.test', 'ana@agx.test']);
  });

  test('nobody on it can open it: the org’s admins hear, with their own footer, and never another org’s', async () => {
    const s = senders();
    const r = await N.notifyProblemFlagged(eng.pool, { ticket: ticket('st2'), share: {}, flag: { id: 'f2', category: 'safety', note: 'Wasp nest' } }, s.deps);
    expect(r.sent).toBe(3);
    expect(s.emails.map((m) => m.to)).toEqual(['creator@agx.test', 'sender@agx.test', 'adam@agx.test']);
    expect(s.emails[0].text).toContain("because you're an admin and nobody on this work order can open it.");
    expect(s.emails[0].replyTo).toBe(false);
    expect(JSON.stringify(s.emails)).not.toContain('rival');
  });

  test('a share id from another org gives no Reply-To; an email-muted person still gets the push', async () => {
    eng.db.exec("UPDATE service_tickets SET created_by = 19 WHERE id = 'st1'");
    const s = senders();
    await N.notifyProblemFlagged(eng.pool, { ticket: ticket('st1'), share: { id: 'sh_rival', created_by: 50 }, flag: FLAG }, s.deps);
    expect(s.emails.map((m) => m.to)).toEqual(['pm@agx.test', 'sender@agx.test']);
    expect(s.emails.every((m) => m.replyTo === false)).toBe(true);
    expect(s.pushes.map((p) => p.userId)).toEqual([10, 19, 14]);
  });

  test('never throws', async () => {
    const thrown = senders({ emailThrows: true, pushThrows: true });
    expect(await N.notifyProblemFlagged(eng.pool, { ticket: ticket('st1'), share: SHARE, flag: FLAG }, thrown.deps))
      .toEqual({ sent: 0, recipients: 3 });
    const dead = { query: async () => { throw new Error('db down'); } };
    expect(await N.notifyProblemFlagged(dead, { ticket: ticket('st1'), share: SHARE, flag: FLAG }, senders().deps))
      .toEqual({ sent: 0, skipped: 'error' });
  });

  test('MUTANT: drop the once-per-flag guard and a retried flag emails everyone twice', async () => {
    const mod = mutant("    if (already.rows.length) return { sent: 0, skipped: 'already_notified' };\n", '');
    await mod.notifyProblemFlagged(eng.pool, { ticket: ticket('st1'), share: SHARE, flag: FLAG }, senders().deps);
    const again = senders();
    await mod.notifyProblemFlagged(eng.pool, { ticket: ticket('st1'), share: SHARE, flag: FLAG }, again.deps);
    expect(again.emails).toHaveLength(3);
  });

  test('MUTANT: only this link’s sender counts and the person who sent the other link never hears', async () => {
    eng.db.exec("UPDATE service_ticket_shares SET created_by = 11 WHERE id = 'sh_jose'");
    const mod = mutant("mode: 'read', allSenders: true, sharedBy: share.created_by,", "mode: 'read', sharedBy: share.created_by,");
    const s = senders();
    await mod.notifyProblemFlagged(eng.pool, { ticket: ticket('st1'), share: SHARE, flag: FLAG }, s.deps);
    expect(s.emails.map((m) => m.to)).not.toContain('ana@agx.test');
  });
});

describe('crew activity batch', () => {
  const ev = (kind, detail, extra) => Object.assign(
    { kind, actor_kind: 'share', share_id: 'sh_resp', actor_label: 'Marco', detail: JSON.stringify(detail || {}) }, extra || {});

  test('which events count', () => {
    const kept = N.crewBatchEvents([
      ev('share_opened', {}),
      ev('status_changed', { to: 'in_progress' }),
      ev('status_changed', { to: 'work_complete' }),
      ev('note_added', { fields: ['note'] }, { actor_kind: 'user' }),
      ev('problem_flagged', {}),
      ev('flag_raised', {}),
      ev('photo_added', { flag_id: 'f1', kind: 'flag' }),
      ev('photo_added', { task_id: 't782', kind: 'completion' }),
      ev('subtask_completed', { task_id: 't782' }),
    ], 'in_progress').map((e) => e.kind + ':' + JSON.parse(e.detail).to);
    expect(kept).toEqual(['share_opened:undefined', 'status_changed:in_progress', 'photo_added:undefined', 'subtask_completed:undefined']);
  });

  test('once the work order is at Work complete, finished buildings and completion photos are left to the approval notice', () => {
    const kept = N.crewBatchEvents([
      ev('subtask_completed', { task_id: 't782' }),
      ev('photo_added', { task_id: 't782', kind: 'completion' }),
      ev('photo_added', { task_id: 't782', kind: 'before' }),
      ev('photo_added', { mime: 'image/jpeg' }),
      ev('subtask_note', { task_id: 't782', note: 'x' }),
    ], 'work_complete').map((e) => e.kind + ':' + (JSON.parse(e.detail).kind || ''));
    expect(kept).toEqual(['photo_added:before', 'photo_added:', 'subtask_note:']);
  });

  test('a crew undo of Mark work complete is kept, and dropped once the work order is at Work complete again', () => {
    const batch = [
      ev('status_changed', { from: 'work_complete', to: 'in_progress', reason: 'crew_undid_finish' }),
      ev('status_changed', { from: 'scheduled', to: 'in_progress' }),
    ];
    expect(N.crewBatchEvents(batch, 'in_progress').map((e) => JSON.parse(e.detail).from)).toEqual(['work_complete', 'scheduled']);
    expect(N.crewBatchEvents(batch, 'work_complete').map((e) => JSON.parse(e.detail).from)).toEqual(['scheduled']);
  });

  test('MUTANT: keep an undone-and-refinished trip back to In progress and the office reads "Took back" on a finished work order', () => {
    const mod = mutant("    if (nowComplete && e.kind === 'status_changed' && d.from === 'work_complete') return false;\n", '');
    const kept = mod.crewBatchEvents([ev('status_changed', { from: 'work_complete', to: 'in_progress', reason: 'crew_undid_finish' })], 'work_complete');
    expect(kept).toHaveLength(1);
  });

  test('one message to the people on the work order, worded from the batch', async () => {
    const s = senders();
    const r = await N.sendCrewActivityBatch(eng.pool, {
      ticket: ticket('st1'),
      events: [
        ev('share_opened', {}),
        ev('subtask_completed', { task_id: 't782', title: 'Bldg 782 — Side A: railing' }),
        ev('subtask_note', { task_id: 't784', note: 'Post cracked, see www.evil.test' }),
        ev('revision_proposed', {}),
      ],
    }, s.deps);
    expect(r.lines).toEqual([
      'Opened the work order for the first time',
      'Finished 1 building: Bldg 782 — Side A: railing',
      'Left 1 note',
      'Suggested 1 change — 1 waiting for you',
    ]);
    expect(r.sent).toBe(3);
    expect(s.emails.map((m) => m.to)).toEqual(['pm@agx.test', 'creator@agx.test', 'sender@agx.test']);
    const m = s.emails[0];
    expect(m.subject).toBe('Crew update: Latitude 28 punch list — M1001 · BH Management Latitude');
    expect(m.text).toContain('  “Post cracked, see [link removed]” — Bldg 784 — Side A: post');
    expect(m.tag).toBe('ticket_crew_activity');
    expect(m.replyTo).toBe('marco@crew.test');
    expect(s.pushes[0].payload.tag).toBe('ticket_crew_activity:st1');
    expect(JSON.stringify(s.emails)).not.toMatch(/evil|24000|contract/);
    // The batch summarises the timeline; it adds nothing to it.
    expect(eventsOf('st1')).toHaveLength(0);
  });

  test('two links in one batch: no Reply-To; the ticket at Work complete drops finished buildings', async () => {
    const s = senders();
    const r = await N.sendCrewActivityBatch(eng.pool, {
      ticket: Object.assign(ticket('st1'), { status: 'work_complete' }),
      events: [
        ev('subtask_completed', { task_id: 't782', title: 'Bldg 782 — Side A: railing' }),
        ev('photo_added', { task_id: 't782', kind: 'completion' }),
        ev('photo_added', { task_id: 't782', kind: 'before' }),
        ev('note_added', { fields: ['note'] }, { share_id: 'sh_jose', actor_label: 'Jose' }),
      ],
    }, s.deps);
    expect(r.lines).toEqual(['Added 1 photo (1 before)', 'Added a field report note']);
    expect(s.emails[0].text).toContain('Marco and Jose (via crew links) on "Latitude 28 punch list":');
    expect(s.emails.every((m) => m.replyTo === false)).toBe(true);
  });

  test('nothing left to say sends nothing; nobody on it gets no admin fallback', async () => {
    const s = senders();
    expect(await N.sendCrewActivityBatch(eng.pool, {
      ticket: ticket('st1'), events: [ev('status_changed', { to: 'work_complete' }), ev('photo_added', { flag_id: 'f', kind: 'flag' })],
    }, s.deps)).toEqual({ sent: 0, lines: [] });
    const nobody = await N.sendCrewActivityBatch(eng.pool, {
      ticket: ticket('st2'), events: [ev('share_opened', {}, { share_id: null })],
    }, s.deps);
    expect(nobody).toEqual({ sent: 0, lines: ['Opened the work order for the first time'] });
    expect([s.emails.length, s.pushes.length]).toEqual([0, 0]);
  });

  test('never throws', async () => {
    const dead = { query: async () => { throw new Error('db down'); } };
    expect(await N.sendCrewActivityBatch(dead, { ticket: ticket('st1'), events: [ev('subtask_note', { task_id: 't782', note: 'x' })] }, senders().deps))
      .toEqual({ sent: 0, lines: [] });
    const thrown = senders({ emailThrows: true, pushThrows: true });
    expect(await N.sendCrewActivityBatch(eng.pool, { ticket: ticket('st1'), events: [ev('share_opened', {})] }, thrown.deps))
      .toEqual({ sent: 0, lines: ['Opened the work order for the first time'] });
  });

  test('MUTANT: forget the Work complete drop and the batch repeats what the approval notice said', () => {
    const mod = mutant("    if (nowComplete && e.kind === 'subtask_completed') return false;\n", '');
    const kept = mod.crewBatchEvents([ev('subtask_completed', { task_id: 't782' })], 'work_complete');
    expect(kept).toHaveLength(1);
  });

  test('MUTANT: drop the org predicate on the suggestion count and another tenant’s row is "waiting for you"', async () => {
    const mod = mutant("WHERE ticket_id = $1 AND organization_id = $2 AND status = 'pending'", "WHERE ticket_id = $1 AND (organization_id = $2 OR 1 = 1) AND status = 'pending'");
    const r = await mod.sendCrewActivityBatch(eng.pool, { ticket: ticket('st1'), events: [ev('revision_proposed', {})] }, senders().deps);
    expect(r.lines).toEqual(['Suggested 1 change — 2 waiting for you']);
  });

  test('MUTANT: count the office’s own events and the office is told what it did', () => {
    const mod = mutant("    if (!e || e.actor_kind !== 'share' || CREW_BATCH_KINDS.indexOf(e.kind) < 0) return false;",
      '    if (!e || CREW_BATCH_KINDS.indexOf(e.kind) < 0) return false;');
    const kept = mod.crewBatchEvents([ev('note_added', { fields: ['note'] }, { actor_kind: 'user' })], 'in_progress');
    expect(kept).toHaveLength(1);
  });
});
