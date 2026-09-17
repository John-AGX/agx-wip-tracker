// ONE RECIPIENT LIST FOR EVERY WORK-ORDER NOTICE.
//
// services/work-order-recipients.js decides who is "on" a work order. Driven
// here against node:sqlite through the pg shim, over the schema server/db.js
// writes, with the capability check injected per role:
//   * order: PM, creator, link sender(s), assignee, salesperson (lead-only
//     tickets), participants — each once, never the actor;
//   * never an inactive user, never another org's user or share or participant;
//   * read and write tiers through services/service-ticket-access.js;
//   * the admin fallback only when nobody on the ticket passes the access rule
//     (never because of mutes), never the actor, never another org's admin;
//   * myTicketRelationSql executes and stays inside the ticket's org.
// The tenancy, fallback, salesperson and mode rules are then removed from a
// copy of the module and shown to fail.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const REAL = path.join(__dirname, '..', 'server', 'services', 'work-order-recipients.js');
const R = require(REAL);

const TABLES = ['organizations', 'users', 'jobs', 'leads', 'job_access', 'service_tickets',
  'service_ticket_shares', 'service_ticket_participants'];

// The access rule's own capability check, stubbed per role. pm sees every job
// and edits only its own (or a granted one); crew sees and edits only what it
// owns or is granted; admin edits everything.
const ROLE_CAPS = {
  admin: ['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'LEADS_VIEW', 'LEADS_EDIT'],
  pm: ['JOBS_VIEW_ALL', 'JOBS_EDIT_OWN', 'LEADS_VIEW', 'LEADS_EDIT'],
  crew: ['JOBS_VIEW_ASSIGNED', 'JOBS_EDIT_OWN'],
  estimator: ['LEADS_VIEW'],
};
const hasCapability = (user, cap) => String(cap || '').split(/\s+/).filter(Boolean)
  .some((k) => (ROLE_CAPS[user && user.role] || []).includes(k));

let eng;
const tmpDirs = [];

beforeAll(() => {
  eng = createPgSqlite(sqliteSchema(TABLES), { jsonColumns: ['data', 'notification_prefs'] });
});
afterAll(() => {
  if (eng) eng.close();
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
});

function seed() {
  eng.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM jobs; DELETE FROM leads; DELETE FROM job_access;
    DELETE FROM service_tickets; DELETE FROM service_ticket_shares; DELETE FROM service_ticket_participants;
    INSERT INTO organizations (id, name) VALUES (1, 'AGX'), (2, 'Rival');
    INSERT INTO users (id, name, email, role, organization_id, active, notification_prefs) VALUES
      (10, 'Paula PM',       'pm@agx.test',       'pm',    1, 1, '{}'),
      (11, 'Ana Assignee',   'ana@agx.test',      'crew',  1, 1, '{}'),
      (12, 'Cora Creator',   'creator@agx.test',  'pm',    1, 1, '{}'),
      (13, 'Sam Sender',     'sender@agx.test',   'crew',  1, 1, '{}'),
      (14, 'Wes Watcher',    'wes@agx.test',      'crew',  1, 1, '{}'),
      (15, 'Ivan Inactive',  'gone@agx.test',     'admin', 1, 0, '{}'),
      (16, 'Sally Sales',    'sales@agx.test',    'pm',    1, 1, '{}'),
      (17, 'Olive Outsider', 'olive@agx.test',    'crew',  1, 1, '{}'),
      (20, 'Adam Admin',     'adam@agx.test',     'admin', 1, 1, '{}'),
      (21, 'Abby Admin',     'abby@agx.test',     'admin', 1, 1, '{}'),
      (50, 'Rival Ray',      'ray@rival.test',    'admin', 2, 1, '{}'),
      (51, 'Rival Rita',     'rita@rival.test',   'admin', 2, 1, '{}');
    INSERT INTO job_access (job_id, user_id, access_level) VALUES
      ('j1', 11, 'edit'), ('j1', 13, 'view'), ('j1', 14, 'edit');
    INSERT INTO leads (id, title, organization_id, salesperson_id) VALUES
      ('l1', 'Latitude lead', 1, 16), ('l2', 'Pines lead', 1, 16), ('l9', 'Rival lead', 2, 51);
    INSERT INTO jobs (id, owner_id, lead_id, organization_id, data) VALUES
      ('j1', 10, 'l1', 1, '{"jobNumber":"M1001","title":"Latitude","contractAmount":24000}'),
      ('j2', NULL, NULL, 1, '{"jobNumber":"M1002","title":"Nobody runs this"}'),
      ('j9', 50, NULL, 2, '{"jobNumber":"R1","title":"Rival job"}');
    INSERT INTO service_tickets (id, organization_id, title, job_id, lead_id, status, created_by, assignee_user_id, created_at) VALUES
      ('st1', 1, 'Latitude punch list', 'j1', NULL, 'work_complete', 12, 11,   '2026-09-01 10:00:00'),
      ('stc', 1, 'Converted lead ticket', 'j1', 'l1', 'open',       12, NULL, '2026-09-01 10:01:00'),
      ('stl', 1, 'Lead-only ticket',    NULL, 'l2', 'open',         12, NULL, '2026-09-01 10:02:00'),
      ('st2', 1, 'Nobody can open it',  'j2', NULL, 'work_complete', 17, NULL, '2026-09-01 10:03:00'),
      ('stb', 2, 'Rival ticket',        'j9', NULL, 'work_complete', 10, 10,   '2026-09-01 10:04:00');
    INSERT INTO service_ticket_shares (id, organization_id, ticket_id, token_hash, scope, expires_at, created_by, created_at) VALUES
      ('sh1', 1, 'st1', 'h1', 'respond', '2099-01-01', 13, '2026-09-02 09:00:00'),
      ('sh2', 1, 'st1', 'h2', 'respond', '2099-01-01', 14, '2026-09-02 09:05:00'),
      ('sh_rival', 2, 'st1', 'h3', 'respond', '2099-01-01', 50, '2026-09-02 08:00:00'),
      ('sh_plant', 2, 'st2', 'h4', 'respond', '2099-01-01', 10, '2026-09-02 08:00:00');
    INSERT INTO service_ticket_participants (id, organization_id, ticket_id, user_id, access_level, created_at) VALUES
      ('p1', 1, 'st1', 14, 'view', '2026-09-03 09:00:00'),
      ('p2', 1, 'st1', 11, 'view', '2026-09-03 09:01:00'),
      ('p_rival', 2, 'st1', 51, 'view', '2026-09-03 08:00:00'),
      ('p_plant', 2, 'st2', 10, 'view', '2026-09-03 08:00:00');
  `);
}
beforeEach(seed);

const ticket = (id) => eng.all('SELECT id, organization_id, title, job_id, lead_id, status, created_by, assignee_user_id FROM service_tickets WHERE id = ?', id)[0];
const ids = (out) => out.users.map((u) => Number(u.id));

function mutant(anchor, replacement) {
  const src = fs.readFileSync(REAL, 'utf8').replace(/\r\n/g, '\n');
  if (src.split(anchor).length !== 2) throw new Error('anchor not found');
  let out = src.replace(anchor, () => replacement);
  if (out === src) throw new Error('mutation changed nothing');
  const dir = path.dirname(REAL);
  out = out.replace(/require\((['"])(\.{1,2}\/[^'"]+)\1\)/g,
    (_m, _q, rel) => 'require(' + JSON.stringify(path.resolve(dir, rel).split(path.sep).join('/')) + ')');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p86-wor-'));
  tmpDirs.push(tmp);
  const p = path.join(tmp, 'work-order-recipients.js');
  fs.writeFileSync(p, out, 'utf8');
  return require(p);
}

describe('relationIds (pure)', () => {
  const facts = {
    jobOwnerId: 10, createdBy: 12, senderIds: [13, '14', 13], assigneeId: 11,
    salespersonId: 16, participantIds: [14, 11, 22], leadOnly: false,
  };

  test('order PM, creator, senders, assignee, participants; each once', () => {
    expect(R.relationIds(facts, {})).toEqual([10, 12, 13, 14, 11, 22]);
  });

  test('the salesperson only on a lead-only ticket, after the assignee', () => {
    expect(R.relationIds(Object.assign({}, facts, { leadOnly: true }), {})).toEqual([10, 12, 13, 14, 11, 16, 22]);
  });

  test('never the actor; only positive integers', () => {
    expect(R.relationIds(facts, { actorUserId: '10' })).toEqual([12, 13, 14, 11, 22]);
    expect(R.relationIds({ jobOwnerId: 'abc', createdBy: -1, senderIds: [0, 1.5, null], assigneeId: 7 }, {})).toEqual([7]);
  });

  test('a subset of relations', () => {
    expect(R.relationIds(facts, { relations: ['assignee', 'participant'] })).toEqual([11, 14, 22]);
    expect(R.relationEntries(facts, {}).find((e) => e.id === 14).relations).toEqual(['sender', 'participant']);
  });
});

describe('ticketRecipients', () => {
  test('read: PM, creator, every link sender, assignee, participants — in that order, once each', async () => {
    const out = await R.ticketRecipients(eng.pool, ticket('st1'), { mode: 'read', allSenders: true, hasCapability });
    expect(ids(out)).toEqual([10, 12, 13, 14, 11]);
    expect(out.fallback).toBeNull();
    expect(out.users.find((u) => u.id === 14).relations).toEqual(['sender', 'participant']);
    expect(Object.keys(out.users[0]).sort()).toEqual(['email', 'id', 'name', 'notification_prefs', 'relations', 'role', 'timezone']);
  });

  test('without allSenders only the named sender counts', async () => {
    const out = await R.ticketRecipients(eng.pool, ticket('st1'), { mode: 'read', sharedBy: 13, hasCapability });
    expect(ids(out)).toEqual([10, 12, 13, 11, 14]);
  });

  test('write: only people who can edit the job — the view grant and the non-owner PM drop out', async () => {
    const out = await R.ticketRecipients(eng.pool, ticket('st1'), { mode: 'write', allSenders: true, hasCapability });
    expect(ids(out)).toEqual([10, 14, 11]);
  });

  test('never the actor, never an inactive user, never another org’s user, share or participant', async () => {
    const noActor = await R.ticketRecipients(eng.pool, ticket('st1'), { mode: 'read', actorUserId: 10, hasCapability });
    expect(ids(noActor)).not.toContain(10);
    const inactive = await R.ticketRecipients(eng.pool, ticket('st1'), { mode: 'read', sharedBy: [15], hasCapability });
    expect(ids(inactive)).not.toContain(15);
    // 50 sent an org-2 "share" on this ticket and 51 is an org-2 participant
    // row on it; both are admins elsewhere, whom the access rule would pass.
    const all = await R.ticketRecipients(eng.pool, ticket('st1'), { mode: 'write', allSenders: true, hasCapability });
    expect(ids(all)).not.toContain(50);
    expect(ids(all)).not.toContain(51);
    const named = await R.ticketRecipients(eng.pool, ticket('st1'), { mode: 'write', sharedBy: 50, hasCapability });
    expect(ids(named)).not.toContain(50);
  });

  test('the salesperson on a lead-only ticket; not on a converted lead’s job ticket', async () => {
    const lead = await R.ticketRecipients(eng.pool, ticket('stl'), { mode: 'write', hasCapability });
    expect(ids(lead)).toEqual([12, 16]);
    expect(lead.users[1].relations).toEqual(['salesperson']);
    const converted = await R.ticketRecipients(eng.pool, ticket('stc'), { mode: 'read', hasCapability });
    expect(ids(converted)).toEqual([10, 12]);
  });

  test('admin fallback only when nobody on the ticket can open it: never the actor, never another org’s admin', async () => {
    const off = await R.ticketRecipients(eng.pool, ticket('st2'), { mode: 'write', hasCapability });
    expect(off).toEqual({ users: [], fallback: null });
    const on = await R.ticketRecipients(eng.pool, ticket('st2'), { mode: 'write', fallbackToAdmins: true, hasCapability });
    expect(ids(on)).toEqual([20, 21]);
    expect(on.fallback).toBe('admins');
    expect(on.users[0].relations).toEqual(['admin']);
    const withActor = await R.ticketRecipients(eng.pool, ticket('st2'), { mode: 'write', fallbackToAdmins: true, actorUserId: 20, hasCapability });
    expect(ids(withActor)).toEqual([21]);
  });

  test('muting is not "nobody": a ticket whose people all muted everything gets no admins', async () => {
    eng.db.exec(`UPDATE users SET notification_prefs = '{"ticket_approval":false,"push":{"ticket_approval":false}}'`);
    const out = await R.ticketRecipients(eng.pool, ticket('st1'), { mode: 'write', fallbackToAdmins: true, hasCapability });
    expect(ids(out)).toEqual([10, 11, 14]);
    expect(out.fallback).toBeNull();
  });

  test('no admins to fall back to answers fallback null', async () => {
    eng.db.exec("UPDATE users SET role = 'pm' WHERE id IN (20, 21)");
    const out = await R.ticketRecipients(eng.pool, ticket('st2'), { mode: 'write', fallbackToAdmins: true, hasCapability });
    expect(out).toEqual({ users: [], fallback: null });
  });

  test('every statement it ran carries the organization predicate', async () => {
    const before = eng.log.length;
    await R.ticketRecipients(eng.pool, ticket('stc'), { mode: 'write', allSenders: true, fallbackToAdmins: true, hasCapability });
    await R.ticketRecipients(eng.pool, ticket('st2'), { mode: 'write', allSenders: true, fallbackToAdmins: true, hasCapability });
    const mine = eng.log.slice(before).filter((e) => !/FROM jobs j\s+LEFT JOIN job_access/.test(e.sql));
    expect(mine.length).toBeGreaterThan(6);
    for (const e of mine) {
      expect(e.ok).toBe(true);
      expect(e.sql).toMatch(/organization_id = \$\d/);
    }
  });

  test('the access check is memoised per person and parent', async () => {
    const memo = R.accessMemo(hasCapability);
    const before = eng.log.length;
    const u = { id: 13, role: 'crew' };
    expect(await memo.check(eng.pool, u, ticket('st1'), 'read', 1)).toBe(true);
    expect(await memo.check(eng.pool, u, ticket('stc'), 'read', 1)).toBe(true);   // same job parent
    expect(await memo.check(eng.pool, u, ticket('st1'), 'write', 1)).toBe(false);
    expect(eng.log.slice(before).filter((e) => /job_access/.test(e.sql))).toHaveLength(2);
    expect(memo.size()).toBe(2);
  });

  test('orgAdmins lists only this org’s active admins', async () => {
    expect((await R.orgAdmins(eng.pool, 1)).map((u) => u.id)).toEqual([20, 21]);
    expect((await R.orgAdmins(eng.pool, 2)).map((u) => u.id)).toEqual([50, 51]);
  });
});

describe('NOTICE_TICKET_COLS', () => {
  test('names the columns a notice reads, and no money, scope or office-only text', () => {
    const cols = R.NOTICE_TICKET_COLS.split(', ');
    expect(cols).toEqual([
      'id', 'organization_id', 'title', 'job_id', 'lead_id', 'status', 'priority',
      'created_by', 'assignee_user_id', 'completed_at', 'updated_at', 'scheduled_for',
      'due_date', 'street_address', 'city', 'state', 'zip', 'lat', 'lng', 'access_notes',
      'approval_notified_at', 'approval_notice_attempts', 'approval_notice_last_try_at',
      'approval_notice_gave_up_at', 'crew_activity_notified_at',
    ]);
    for (const banned of ['scope_proposed', 'scope_approved', 'internal_notes', 'guest_log', 'crew_takeoff', 'materials', 'checklist']) {
      expect(cols).not.toContain(banned);
    }
  });
});

describe('myTicketRelationSql', () => {
  async function mine(uid) {
    const sql = 'SELECT t.id FROM service_tickets t WHERE t.organization_id = $1 AND ' +
      R.myTicketRelationSql('t', '$2') + ' ORDER BY t.id';
    return (await eng.pool.query(sql, [1, uid])).rows.map((r) => r.id);
  }

  test('each relation finds the ticket, and only in this org', async () => {
    expect(await mine(10)).toEqual(['st1', 'stc']);         // PM of j1; the org-2 share and participant rows on st2 do not count
    expect(await mine(11)).toEqual(['st1']);                // assignee (and participant)
    expect(await mine(12)).toEqual(['st1', 'stc', 'stl']);  // creator
    expect(await mine(13)).toEqual(['st1']);                // link sender
    expect(await mine(14)).toEqual(['st1']);                // participant and sender
    expect(await mine(16)).toEqual(['stl']);                // salesperson, lead-only ticket only
    expect(await mine(50)).toEqual([]);                     // another org's user
  });

  test('every subquery is pinned to the ticket’s organization', () => {
    const sql = R.myTicketRelationSql('tk', '$3');
    const subqueries = sql.match(/EXISTS \(SELECT 1 FROM [a-z_]+ [a-z_]+ WHERE [^)]*\)/g);
    expect(subqueries).toHaveLength(4);
    for (const s of subqueries) expect(s).toMatch(/rel_[jslp]\.organization_id = tk\.organization_id/);
  });

  test('refuses an alias or a user reference that is not a plain name and a $n parameter', () => {
    expect(() => R.myTicketRelationSql('t; DROP TABLE users', '$1')).toThrow();
    expect(() => R.myTicketRelationSql('t', '10')).toThrow();
    expect(() => R.myTicketRelationSql('t', '$1 OR 1=1')).toThrow();
  });
});

describe('mutants', () => {
  test('MUTANT: drop the org predicate on users and another tenant’s admin is on this work order', async () => {
    const mod = mutant(
      "WHERE id = ANY($1::int[]) AND organization_id = $2 AND active = TRUE',",
      "WHERE id = ANY($1::int[]) AND (organization_id = $2 OR 1 = 1) AND active = TRUE',");
    const out = await mod.ticketRecipients(eng.pool, ticket('st1'), { mode: 'write', sharedBy: 50, hasCapability });
    expect(ids(out)).toContain(50);
  });

  test('MUTANT: drop the org predicate on the admin read and another tenant’s admins get the fallback', async () => {
    const mod = mutant(
      'WHERE organization_id = $1 AND active = TRUE AND role IN',
      'WHERE (organization_id = $1 OR 1 = 1) AND active = TRUE AND role IN');
    const out = await mod.ticketRecipients(eng.pool, ticket('st2'), { mode: 'write', fallbackToAdmins: true, hasCapability });
    expect(ids(out)).toEqual(expect.arrayContaining([50, 51]));
  });

  test('MUTANT: fall back whenever asked and the admins replace the PM who can approve it', async () => {
    const mod = mutant(
      '  if (users.length || !o.fallbackToAdmins) return { users: users, fallback: null };',
      '  if (!o.fallbackToAdmins) return { users: users, fallback: null };');
    const out = await mod.ticketRecipients(eng.pool, ticket('st1'), { mode: 'write', fallbackToAdmins: true, hasCapability });
    expect(out.fallback).toBe('admins');
    expect(ids(out)).toContain(20);
  });

  test('MUTANT: drop the lead-only guard and a job ticket emails the lead’s salesperson', async () => {
    const mod = mutant(
      "  if (f.leadOnly) add('salesperson', f.salespersonId);",
      "  add('salesperson', f.salespersonId);");
    const out = await mod.ticketRecipients(eng.pool, ticket('stc'), { mode: 'read', hasCapability });
    expect(ids(out)).toContain(16);
  });

  test('MUTANT: check READ whatever was asked and a view-only grant is asked to approve', async () => {
    const mod = mutant("  const mode = o.mode || 'read';", "  const mode = 'read';");
    const out = await mod.ticketRecipients(eng.pool, ticket('st1'), { mode: 'write', allSenders: true, hasCapability });
    expect(ids(out)).toContain(13);
  });

  test('MUTANT: drop the actor exclusion and the PM is told about their own move', async () => {
    const mod = mutant('      if (id === actor) return;\n', '');
    const out = await mod.ticketRecipients(eng.pool, ticket('st1'), { mode: 'read', actorUserId: 10, hasCapability });
    expect(ids(out)).toContain(10);
  });

  test('MUTANT: drop the share org pin in myTicketRelationSql and an org-2 share row makes st2 "mine"', async () => {
    const mod = mutant(
      "rel_s.ticket_id = ' + t + '.id AND rel_s.organization_id = ' + t + '.organization_id AND ",
      "rel_s.ticket_id = ' + t + '.id AND ");
    const sql = 'SELECT t.id FROM service_tickets t WHERE t.organization_id = $1 AND ' + mod.myTicketRelationSql('t', '$2') + ' ORDER BY t.id';
    const rows = (await eng.pool.query(sql, [1, 10])).rows.map((r) => r.id);
    expect(rows).toContain('st2');
  });
});
