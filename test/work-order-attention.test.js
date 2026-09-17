// WHAT NEEDS ATTENTION, PER PERSON — services/work-order-attention.js.
//
// One assembly feeds the morning digest and the Work Orders page's "Needs
// attention" count. Driven against node:sqlite through the pg shim over the
// schema server/db.js writes, with the capability check injected per role:
//   * section membership follows who is ON the work order (PM, creator, link
//     senders, assignee, lead-only salesperson, watchers) and the access tier:
//     a crew lead with a VIEW grant sees overdue and flags but is not asked to
//     approve or to review suggestions;
//   * a work order nobody on it can approve goes to the company admins;
//   * waiting more than 24 hours, the org's N business days, overdue by the
//     org's calendar day, scheduled today/tomorrow with no link vs an unopened
//     link, links expiring within 3 days (not 4, not revoked), suggestions
//     older than a day, flags still open;
//   * attentionForUser counts work orders once across sections;
//   * nothing from another organization reaches either org's people.
// The participants org predicate is then removed from a copy and shown to leak.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');
const tz = require('../server/timezone');
const text = require('../server/services/work-order-notify-text');

const REAL = path.join(__dirname, '..', 'server', 'services', 'work-order-attention.js');
const A = require(REAL);

const TABLES = ['organizations', 'users', 'jobs', 'leads', 'job_access', 'tasks', 'service_tickets',
  'service_ticket_shares', 'service_ticket_participants', 'service_ticket_revisions', 'service_ticket_flags'];

const ROLE_CAPS = {
  admin: ['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'LEADS_VIEW', 'LEADS_EDIT'],
  pm: ['JOBS_VIEW_ALL', 'JOBS_EDIT_OWN', 'LEADS_VIEW', 'LEADS_EDIT'],
  crew: ['JOBS_VIEW_ASSIGNED', 'JOBS_EDIT_OWN'],
};
const hasCapability = (user, cap) => String(cap || '').split(/\s+/).filter(Boolean)
  .some((k) => (ROLE_CAPS[user && user.role] || []).includes(k));
const DEPS = { hasCapability };

const ZONE = 'America/New_York';
const DAY = 86400000;
function ymd(offsetDays) {
  const today = tz.localDateInTz(ZONE, new Date());
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]) + offsetDays * DAY).toISOString().slice(0, 10);
}

let eng;
const tmpDirs = [];

beforeAll(() => {
  eng = createPgSqlite(sqliteSchema(TABLES), { jsonColumns: ['data', 'notification_prefs', 'settings', 'fields'] });
});
afterAll(() => {
  if (eng) eng.close();
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
});

function seed(settings) {
  const s = JSON.stringify(settings || { work_orders: { approval_reminder_business_days: 2 } });
  eng.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM jobs; DELETE FROM leads; DELETE FROM job_access;
    DELETE FROM tasks; DELETE FROM service_tickets; DELETE FROM service_ticket_shares;
    DELETE FROM service_ticket_participants; DELETE FROM service_ticket_revisions; DELETE FROM service_ticket_flags;
    INSERT INTO organizations (id, name, timezone, settings) VALUES
      (1, 'AGX', '${ZONE}', '${s}'), (2, 'Rival', 'America/Los_Angeles', '{}');
    INSERT INTO users (id, name, email, role, organization_id, active, notification_prefs) VALUES
      (10, 'Paula PM',       'pm@agx.test',     'pm',    1, 1, '{}'),
      (11, 'Carl Crew',      'crew@agx.test',   'crew',  1, 1, '{}'),
      (12, 'Adam Admin',     'adam@agx.test',   'admin', 1, 1, '{}'),
      (13, 'Sally Sales',    'sales@agx.test',  'pm',    1, 1, '{}'),
      (14, 'Olive Outsider', 'olive@agx.test',  'crew',  1, 1, '{}'),
      (15, 'Ivan Inactive',  'gone@agx.test',   'admin', 1, 0, '{}'),
      (50, 'Rival Ray',      'ray@rival.test',  'admin', 2, 1, '{}'),
      (51, 'Rival Rita',     'rita@rival.test', 'pm',    2, 1, '{}');
    INSERT INTO jobs (id, owner_id, lead_id, organization_id, data) VALUES
      ('j1', 10, NULL, 1, '{"jobNumber":"M1001","title":"Latitude","contractAmount":24000}'),
      ('j2', NULL, NULL, 1, '{"jobNumber":"M1002","title":"Nobody runs this"}'),
      ('j9', 51, NULL, 2, '{"jobNumber":"R1","title":"RIVAL JOB"}');
    INSERT INTO job_access (job_id, user_id, access_level) VALUES ('j1', 11, 'view');
    INSERT INTO leads (id, title, organization_id, salesperson_id) VALUES
      ('l1', 'Maple lead', 1, 13), ('l9', 'RIVAL LEAD', 2, 51);
    INSERT INTO service_tickets (id, organization_id, title, job_id, lead_id, status, created_by, assignee_user_id,
                                 completed_at, updated_at, due_date, scheduled_for, archived_at, created_at) VALUES
      ('st_wait',   1, 'Waiting a day',       'j1', NULL, 'work_complete', 10, 11,   datetime('now', '-30 hours'), datetime('now', '-30 hours'), NULL, NULL, NULL, '2026-09-01 10:00:01'),
      ('st_old',    1, 'Waiting ten days',    'j1', NULL, 'work_complete', 10, NULL, datetime('now', '-10 days'),  datetime('now', '-10 days'),  NULL, NULL, NULL, '2026-09-01 10:00:02'),
      ('st_fresh',  1, 'Just finished',       'j1', NULL, 'work_complete', 10, NULL, datetime('now', '-2 hours'),  datetime('now', '-2 hours'),  NULL, NULL, NULL, '2026-09-01 10:00:03'),
      ('st_orphan', 1, 'Nobody can approve',  'j2', NULL, 'work_complete', 14, NULL, datetime('now', '-30 hours'), datetime('now', '-30 hours'), NULL, NULL, NULL, '2026-09-01 10:00:04'),
      ('st_over',   1, 'Overdue gate',        'j1', NULL, 'in_progress',   10, 11,   NULL, NULL, '${ymd(-1)}', NULL, NULL, '2026-09-01 10:00:05'),
      ('st_today',  1, 'Due today',           'j1', NULL, 'in_progress',   10, NULL, NULL, NULL, '${ymd(0)}',  NULL, NULL, '2026-09-01 10:00:06'),
      ('st_sched0', 1, 'Crew today',          'j1', NULL, 'open',          10, NULL, NULL, NULL, NULL, '${ymd(0)}', NULL, '2026-09-01 10:00:07'),
      ('st_sched1', 1, 'Crew tomorrow',       'j1', NULL, 'scheduled',     10, NULL, NULL, NULL, NULL, '${ymd(1)}', NULL, '2026-09-01 10:00:08'),
      ('st_seen',   1, 'Crew opened it',      'j1', NULL, 'open',          10, NULL, NULL, NULL, NULL, '${ymd(0)}', NULL, '2026-09-01 10:00:09'),
      ('st_later',  1, 'Crew in three days',  'j1', NULL, 'open',          10, NULL, NULL, NULL, NULL, '${ymd(3)}', NULL, '2026-09-01 10:00:10'),
      ('st_exp',    1, 'Link expiring',       'j1', NULL, 'open',          10, NULL, NULL, NULL, NULL, NULL, NULL, '2026-09-01 10:00:11'),
      ('st_exp4',   1, 'Link fine for now',   'j1', NULL, 'open',          10, NULL, NULL, NULL, NULL, NULL, NULL, '2026-09-01 10:00:12'),
      ('st_sugg',   1, 'Suggestions waiting', 'j1', NULL, 'open',          10, 11,   NULL, NULL, NULL, NULL, NULL, '2026-09-01 10:00:13'),
      ('st_flag',   1, 'Flagged gate',        'j1', NULL, 'open',          10, 11,   NULL, NULL, '${ymd(-2)}', NULL, NULL, '2026-09-01 10:00:14'),
      ('st_lead',   1, 'Lead-only',           NULL, 'l1', 'work_complete', 14, NULL, datetime('now', '-30 hours'), datetime('now', '-30 hours'), NULL, NULL, NULL, '2026-09-01 10:00:15'),
      ('st_conv',   1, 'Converted lead',      'j1', 'l1', 'work_complete', 14, NULL, datetime('now', '-30 hours'), datetime('now', '-30 hours'), NULL, NULL, NULL, '2026-09-01 10:00:16'),
      ('st_arch',   1, 'Archived',            'j1', NULL, 'work_complete', 10, NULL, datetime('now', '-3 days'),   NULL, '${ymd(-5)}', NULL, datetime('now', '-1 days'), '2026-09-01 10:00:17'),
      ('st_done',   1, 'Approved already',    'j1', NULL, 'approved',      10, NULL, datetime('now', '-3 days'),   NULL, '${ymd(-5)}', NULL, NULL, '2026-09-01 10:00:18'),
      ('stb',       2, 'RIVAL TICKET',        'j9', NULL, 'work_complete', 51, NULL, datetime('now', '-3 days'),   NULL, '${ymd(-5)}', NULL, NULL, '2026-09-01 10:00:19');
    INSERT INTO tasks (id, organization_id, title, status, scope, service_ticket_id, archived_at) VALUES
      ('t1', 1, 'Bldg 1', 'done', 'org', 'st_over', NULL),
      ('t2', 1, 'Bldg 2', 'open', 'org', 'st_over', NULL),
      ('t3', 1, 'private', 'done', 'personal', 'st_over', NULL),
      ('t4', 1, 'gone', 'done', 'org', 'st_over', datetime('now', '-1 days')),
      ('t9', 2, 'RIVAL', 'done', 'org', 'st_over', NULL);
    INSERT INTO service_ticket_shares (id, organization_id, ticket_id, token_hash, scope, recipient_name, created_by, expires_at, opened_at, revoked_at, created_at) VALUES
      ('sh_s1',   1, 'st_sched1', 'h1', 'respond', 'Jose',  10, '2099-01-01', NULL, NULL, '2026-09-02 09:00:00'),
      ('sh_seen', 1, 'st_seen',   'h2', 'respond', 'Jose',  10, '2099-01-01', datetime('now', '-1 hours'), NULL, '2026-09-02 09:00:01'),
      ('sh_e2',   1, 'st_exp',    'h3', 'respond', 'Marco', 10, datetime('now', '+2 days'), NULL, NULL, '2026-09-02 09:00:02'),
      ('sh_e4',   1, 'st_exp4',   'h4', 'respond', 'Marco', 10, datetime('now', '+4 days'), NULL, NULL, '2026-09-02 09:00:03'),
      ('sh_rev',  1, 'st_exp4',   'h5', 'respond', 'Marco', 10, datetime('now', '+1 days'), NULL, datetime('now', '-1 hours'), '2026-09-02 09:00:04'),
      ('sh_plant', 2, 'st_sched0', 'h6', 'respond', 'Spy', 50, '2099-01-01', datetime('now', '-1 hours'), NULL, '2026-09-02 09:00:05');
    INSERT INTO service_ticket_participants (id, organization_id, ticket_id, user_id, access_level, created_at) VALUES
      ('p_plant', 2, 'st_over', 12, 'view', '2026-09-03 08:00:00');
    INSERT INTO service_ticket_revisions (id, organization_id, ticket_id, status, fields, created_at) VALUES
      ('rv1', 1, 'st_sugg', 'pending',  '{}', datetime('now', '-2 days')),
      ('rv2', 1, 'st_sugg', 'pending',  '{}', datetime('now', '-2 hours')),
      ('rv3', 1, 'st_sugg', 'accepted', '{}', datetime('now', '-3 days')),
      ('rv9', 2, 'st_sugg', 'pending',  '{}', datetime('now', '-3 days'));
    INSERT INTO service_ticket_flags (id, organization_id, ticket_id, category, note, status, attachment_ids, created_at) VALUES
      ('f1', 1, 'st_flag', 'no_access',    'Gate locked', 'open',     '[]', '2026-09-14 13:00:00'),
      ('f2', 1, 'st_flag', 'extra_damage', 'More rot',    'resolved', '[]', '2026-09-14 13:05:00'),
      ('f9', 2, 'st_flag', 'safety',       'RIVAL',       'open',     '[]', '2026-09-14 13:10:00');
  `);
}
beforeEach(() => seed());

const ORG1 = () => eng.all('SELECT id, name, timezone, settings FROM organizations WHERE id = 1')[0];
const ORG2 = () => eng.all('SELECT id, name, timezone, settings FROM organizations WHERE id = 2')[0];
const ticketsIn = (entry, key) => (entry ? entry.sections[key].map((it) => it.ticket.id) : []);

describe('sections per person', () => {
  test('the PM who runs the job: every section, in the right shape', async () => {
    const map = await A.attentionForOrg(eng.pool, { org: ORG1(), deps: DEPS });
    const paula = map.get(10);
    // Longest wait first.
    expect(ticketsIn(paula, 'approvals')[0]).toBe('st_old');
    expect(ticketsIn(paula, 'approvals').sort()).toEqual(['st_conv', 'st_old', 'st_wait']);
    expect(ticketsIn(paula, 'flags')).toEqual(['st_flag']);
    expect(ticketsIn(paula, 'overdue').sort()).toEqual(['st_flag', 'st_over']);
    expect(ticketsIn(paula, 'unopened').sort()).toEqual(['st_sched0', 'st_sched1']);
    expect(ticketsIn(paula, 'expiring')).toEqual(['st_exp']);
    expect(ticketsIn(paula, 'suggestions')).toEqual(['st_sugg']);

    const old = paula.sections.approvals[0];
    expect(old.jobLine).toBe('M1001 · Latitude');
    expect(old.daysWaiting).toBeGreaterThanOrEqual(9);
    expect(old.over).toBe(true);
    const wait = paula.sections.approvals.find((it) => it.ticket.id === 'st_wait');
    expect([wait.daysWaiting, wait.over]).toEqual([1, false]);
    expect(paula.overBusinessDays.map((it) => it.ticket.id)).toEqual(['st_old']);

    expect(paula.sections.flags[0]).toMatchObject({ flagId: 'f1', category: 'no_access', jobLine: 'M1001 · Latitude' });
    expect(paula.sections.overdue.find((it) => it.ticket.id === 'st_over')).toMatchObject({ dueDate: ymd(-1), done: 1, total: 2 });
    const byTicket = Object.fromEntries(paula.sections.unopened.map((it) => [it.ticket.id, [it.when, it.linkSent]]));
    expect(byTicket).toEqual({ st_sched0: ['today', false], st_sched1: ['tomorrow', true] });
    expect(paula.sections.expiring[0]).toMatchObject({ crewName: 'Marco' });
    expect(paula.sections.suggestions[0]).toMatchObject({ count: 1 });
    // No money, ever: the job is read for its number and title only.
    expect(JSON.stringify(Array.from(map.values()))).not.toMatch(/24000|contractAmount/);
  });

  test('a crew lead with a VIEW grant: overdue and flags, but no approvals and no suggestions', async () => {
    const map = await A.attentionForOrg(eng.pool, { org: ORG1(), deps: DEPS });
    const carl = map.get(11);
    expect(ticketsIn(carl, 'overdue').sort()).toEqual(['st_flag', 'st_over']);
    expect(ticketsIn(carl, 'flags')).toEqual(['st_flag']);
    expect(ticketsIn(carl, 'approvals')).toEqual([]);
    expect(ticketsIn(carl, 'suggestions')).toEqual([]);
    // With an EDIT grant the same person is asked to approve.
    eng.db.exec("UPDATE job_access SET access_level = 'edit' WHERE user_id = 11");
    const again = await A.attentionForOrg(eng.pool, { org: ORG1(), deps: DEPS });
    expect(ticketsIn(again.get(11), 'approvals')).toEqual(['st_wait']);
    expect(ticketsIn(again.get(11), 'suggestions')).toEqual(['st_sugg']);
  });

  test('nobody on it can approve it: the company admins who can are asked; nobody else', async () => {
    const map = await A.attentionForOrg(eng.pool, { org: ORG1(), deps: DEPS });
    expect(ticketsIn(map.get(12), 'approvals')).toEqual(['st_orphan']);
    expect(ticketsIn(map.get(12), 'overdue')).toEqual([]);          // the org-2 participant row is not a relation
    expect(map.has(14)).toBe(false);                                  // on it, but can approve nothing
    expect(map.has(15)).toBe(false);                                  // inactive
  });

  test('a lead-only work order asks the salesperson; a converted lead’s work order asks the PM instead', async () => {
    const map = await A.attentionForOrg(eng.pool, { org: ORG1(), deps: DEPS });
    expect(ticketsIn(map.get(13), 'approvals')).toEqual(['st_lead']);
    expect(map.get(13).sections.approvals[0].jobLine).toBe('Maple lead');
    expect(ticketsIn(map.get(10), 'approvals')).toContain('st_conv');
  });

  test('the boundaries: 24 hours, 3 days not 4, revoked links, day-old suggestions, open flags only, archived and approved never', async () => {
    const map = await A.attentionForOrg(eng.pool, { org: ORG1(), deps: DEPS });
    const all = JSON.stringify(Array.from(map.values()).map((e) => e.sections));
    ['st_fresh', 'st_today', 'st_seen', 'st_later', 'st_exp4', 'st_arch', 'st_done'].forEach((id) => {
      expect([id, all.includes('"' + id + '"')]).toEqual([id, false]);
    });
    expect(all).not.toContain('extra_damage');
  });

  test('the org’s N business days decides "over"; businessDaysSince counts weekdays after the finish', async () => {
    seed({ work_orders: { approval_reminder_business_days: 10 } });
    const map = await A.attentionForOrg(eng.pool, { org: ORG1(), deps: DEPS });
    expect(map.get(10).sections.approvals.every((it) => it.over === false)).toBe(true);
    expect(map.get(10).overBusinessDays).toEqual([]);

    const friday = new Date('2026-09-11T20:55:00Z');     // Fri 4:55 pm in New York
    expect(text.businessDaysSince(friday, new Date('2026-09-14T15:00:00Z'), ZONE)).toBe(1);
    expect(text.businessDaysSince(friday, new Date('2026-09-15T15:00:00Z'), ZONE)).toBe(2);
    expect(text.businessDaysSince(friday, new Date('2026-09-16T15:00:00Z'), ZONE)).toBe(3);
    expect(text.businessDaysSince(new Date('2026-09-12T15:00:00Z'), new Date('2026-09-14T15:00:00Z'), ZONE)).toBe(1);
  });

  test('overdue and "today" follow the org’s calendar day, not the server’s', async () => {
    // 03:30 UTC is still the previous evening in New York.
    const now = new Date('2026-09-16T03:30:00Z');
    eng.db.exec("UPDATE service_tickets SET due_date = '2026-09-15' WHERE id = 'st_over'; UPDATE service_tickets SET scheduled_for = '2026-09-15' WHERE id = 'st_sched0'");
    const map = await A.attentionForOrg(eng.pool, { org: ORG1(), now, deps: DEPS });
    expect(ticketsIn(map.get(10), 'overdue')).not.toContain('st_over');
    expect(map.get(10).sections.unopened.find((it) => it.ticket.id === 'st_sched0')).toMatchObject({ when: 'today' });
  });

  test('open flags can come from an injected reader', async () => {
    const openFlags = async (db, orgId, ids) => {
      expect(orgId).toBe(1);
      return new Map([['st_exp4', [{ flag_id: 'fx', category: 'safety', created_at: '2026-09-14 12:00:00' }]]]);
    };
    const map = await A.attentionForOrg(eng.pool, { org: ORG1(), deps: { hasCapability, openFlags } });
    expect(ticketsIn(map.get(10), 'flags')).toEqual(['st_exp4']);
  });
});

describe('isolation', () => {
  test('each org’s assembly reads only its own rows, and every statement names the org', async () => {
    const before = eng.log.length;
    const one = await A.attentionForOrg(eng.pool, { org: ORG1(), deps: DEPS });
    const mine = eng.log.slice(before);
    expect(mine.length).toBeGreaterThan(5);
    mine.forEach((e) => expect([e.sql.slice(0, 60), /organization_id = \$1/.test(e.sql)]).toEqual([e.sql.slice(0, 60), true]));
    expect(Array.from(one.keys()).some((id) => id >= 50)).toBe(false);
    expect(JSON.stringify(Array.from(one.values()))).not.toMatch(/RIVAL|Spy|ray@rival|rita@rival/);

    const two = await A.attentionForOrg(eng.pool, { org: ORG2(), deps: DEPS });
    expect(Array.from(two.keys()).sort()).toEqual([51]);
    expect(ticketsIn(two.get(51), 'approvals')).toEqual(['stb']);
    expect(JSON.stringify(Array.from(two.values()))).not.toMatch(/Latitude|Paula|Maple|Marco/);
  });

  test('MUTANT: drop the org predicate on participants and another org’s row makes the admin "on" an overdue work order', async () => {
    const src = fs.readFileSync(REAL, 'utf8').replace(/\r\n/g, '\n');
    const anchor = 'FROM service_ticket_participants\n        WHERE organization_id = $1 AND ticket_id = ANY($2::text[])';
    if (src.split(anchor).length !== 2) throw new Error('anchor not found');
    const out = src.replace(anchor, 'FROM service_ticket_participants\n        WHERE $1 IS NOT NULL AND ticket_id = ANY($2::text[])')
      .replace(/require\((['"])(\.{1,2}\/[^'"]+)\1\)/g,
        (_m, _q, rel) => 'require(' + JSON.stringify(path.resolve(path.dirname(REAL), rel).split(path.sep).join('/')) + ')');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p86-woa-'));
    tmpDirs.push(dir);
    const p = path.join(dir, 'work-order-attention.js');
    fs.writeFileSync(p, out, 'utf8');
    const mod = require(p);
    const map = await mod.attentionForOrg(eng.pool, { org: ORG1(), deps: DEPS });
    expect(ticketsIn(map.get(12), 'overdue')).toContain('st_over');
  });
});

describe('attentionForUser (the Work Orders page count)', () => {
  test('counts per section and work orders once in total', async () => {
    const c = await A.attentionForUser(eng.pool, { orgId: 1, userId: 10, deps: DEPS });
    expect(c).toEqual({ approvals: 3, flags: 1, overdue: 2, unopened: 2, expiring: 1, suggestions: 1, total: 9 });
  });

  test('nothing to do, another org, or a user from another org: zeros', async () => {
    const zero = { approvals: 0, flags: 0, overdue: 0, unopened: 0, expiring: 0, suggestions: 0, total: 0 };
    expect(await A.attentionForUser(eng.pool, { orgId: 1, userId: 14, deps: DEPS })).toEqual(zero);
    expect(await A.attentionForUser(eng.pool, { orgId: 1, userId: 51, deps: DEPS })).toEqual(zero);
    expect(await A.attentionForUser(eng.pool, { orgId: 99, userId: 10, deps: DEPS })).toEqual(zero);
    expect(await A.attentionForUser(eng.pool, { orgId: 1, userId: 'x', deps: DEPS })).toEqual(zero);
  });

  test('the admin fallback shows on the admin’s own count', async () => {
    const c = await A.attentionForUser(eng.pool, { orgId: 1, userId: 12, deps: DEPS });
    expect(c).toMatchObject({ approvals: 1, total: 1 });
  });
});
