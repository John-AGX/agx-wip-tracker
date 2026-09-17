// "FLAG IT FOR THE OFFICE TO KNOW THAT THE JOB IS COMPLETE" (John, 2026-09-13).
//
// services/service-ticket-notify.js tells the approvers when a ticket reaches
// work_complete. Driven here against node:sqlite through the pg shim, over the
// real schema, with the email and push senders injected so what was SENT is the
// assertion:
//   * who hears: the job's PM, the ticket's creator, the crew link's sender, the
//     assignee, the salesperson on a lead-only ticket and the watchers — active,
//     in this org, each once, never the person who made the move — and the
//     company admins when nobody on it can approve it;
//   * what they hear: the job, the ticket, who finished it, the punch-list tally
//     and a link that opens the ticket — and no money;
//   * once per arrival: a second call inside 15 minutes sends nothing, and a
//     ticket no longer awaiting approval is never announced;
//   * a notice that does not go through is counted (approval_notice_attempts),
//     the 4th failure gives up once, everyone muted gives up at once, a success
//     resets the count, and a cron retry reads exactly like the original notice;
//   * Notify again changes no bookkeeping unless it claims a send (a gave-up
//     ticket stays gave-up, a retrying one keeps its count), and once it claims,
//     a failure starts the schedule from its first step, and it is WORDED after
//     the arrival it re-sends (the crew, or the office mover) while still being
//     ADDRESSED from the clicker's own call;
//   * the email opt-out holds, and a failing sender never throws;
//   * a crew-typed name cannot forge a line or a link, and a claim that reached
//     nobody is given back.
// The dedupe, claim release, status, give-up and Notify-again bookkeeping rules
// are then removed from a copy of the module and shown to fail. The recipient-list mutants (write mode,
// the access rule, the users org predicate, the actor exclusion) moved with the
// code to test/work-order-recipients.test.js.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const SERVICES = path.join(__dirname, '..', 'server', 'services');
const REAL = path.join(SERVICES, 'service-ticket-notify.js');
const TABLES = ['organizations', 'users', 'jobs', 'leads', 'tasks', 'attachments', 'job_access',
  'service_tickets', 'service_ticket_events', 'service_ticket_shares', 'service_ticket_participants'];

// The access rule's own role check, stubbed to a fixed role → capability map so
// the suite does not need auth's role cache. 'crew' sees only jobs it owns or
// holds a grant on; 'estimator' can view leads but not edit them.
// These mirror the roles server/db.js seeds: admin edits every job; pm sees
// every job but edits only its own (or a granted one).
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
  eng = createPgSqlite(sqliteSchema(TABLES), {
    jsonColumns: ['data', 'tags', 'detail', 'checklist', 'materials', 'notification_prefs'],
  });
});
afterAll(() => {
  if (eng) eng.close();
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
});

function seed() {
  eng.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM jobs; DELETE FROM leads; DELETE FROM tasks;
    DELETE FROM attachments; DELETE FROM service_tickets; DELETE FROM service_ticket_events; DELETE FROM job_access;
    DELETE FROM service_ticket_shares; DELETE FROM service_ticket_participants;
    INSERT INTO organizations (id, name) VALUES (1, 'AGX'), (2, 'Rival');
    INSERT INTO users (id, name, email, role, organization_id, active, notification_prefs) VALUES
      (10, 'Paula PM',      'pm@agx.test',      'pm', 1, 1, '{}'),
      (13, 'Cora Creator',  'creator@agx.test', 'admin', 1, 1, '{}'),
      (14, 'Sam Sender',    'sender@agx.test',  'admin', 1, 1, '{}'),
      (15, 'Ivan Inactive', 'gone@agx.test',    'admin', 1, 0, '{}'),
      (16, 'Olga Optout',   'optout@agx.test',  'admin', 1, 1, '{"ticket_approval":false}'),
      (50, 'Rival Ray',     'ray@rival.test',   'admin', 2, 1, '{}'),
      (17, 'Carl Crew',     'crew@agx.test',    'crew', 1, 1, '{}'),
      (18, 'Mia Muted',     'muted@agx.test',   'admin', 1, 1, '{"ticket_approval":false,"push":{"ticket_approval":false}}'),
      (19, 'Pete OtherPM',  'otherpm@agx.test', 'pm', 1, 1, '{}'),
      (20, 'Ella Estimator','est@agx.test',     'estimator', 1, 1, '{}'),
      (21, 'Wes Watcher',   'wes@agx.test',     'crew', 1, 1, '{}'),
      (22, 'Sally Sales',   'sales@agx.test',   'pm', 1, 1, '{}');
    INSERT INTO job_access (job_id, user_id, access_level) VALUES ('j1', 17, 'edit'), ('j1', 21, 'edit');
    INSERT INTO leads (id, title, organization_id) VALUES ('l1', 'Latitude lead', 1);
    INSERT INTO jobs (id, owner_id, lead_id, organization_id, data) VALUES
      ('j1', 10, 'l1', 1, '{"jobNumber":"M1001","title":"BH Management Latitude","street_address":"828 Orienta Ave","city":"Altamonte Springs","state":"FL","zip":"32701","contractAmount":24000}');
    INSERT INTO service_tickets (id, organization_id, title, job_id, lead_id, status, checklist, created_by, completed_at) VALUES
      ('st1', 1, 'Latitude 28 punch list', 'j1', NULL, 'work_complete', '[]', 13, datetime('now', '-1 minutes')),
      ('stl', 1, 'Lead ticket',           NULL, 'l1', 'work_complete', '[]', 13, datetime('now', '-1 minutes')),
      ('stp', 1, 'Still in progress',     'j1', NULL, 'in_progress',   '[]', 13, NULL);
    INSERT INTO tasks (id, organization_id, title, status, scope, service_ticket_id, entity_type, entity_id) VALUES
      ('t782', 1, 'Bldg 782 — Side A: railing', 'done', 'org', 'st1', 'job', 'j1'),
      ('t784', 1, 'Bldg 784 — Side A: post',    'done', 'org', 'st1', 'job', 'j1'),
      ('tpriv', 1, 'private to-do',             'open', 'personal', 'st1', 'job', 'j1');
    INSERT INTO attachments (id, entity_type, entity_id, filename, mime_type, thumb_url, web_url, tags, organization_id, position) VALUES
      ('a1', 'task', 't782', 'b.jpg', 'image/jpeg', 'https://cdn/t', 'https://cdn/w', '["before"]', 1, 0),
      ('a2', 'task', 't782', 'c.jpg', 'image/jpeg', 'https://cdn/t', 'https://cdn/w', '["completion"]', 1, 1),
      ('a3', 'task', 't784', 'c.jpg', 'image/jpeg', 'https://cdn/t', 'https://cdn/w', '["completion"]', 1, 0);
    INSERT INTO service_ticket_shares (id, organization_id, ticket_id, token_hash, recipient_email, recipient_name, expires_at, created_by) VALUES
      ('sh1',     1, 'st1', 'h1', 'marco@crew.test', NULL, '2099-01-01', 14),
      ('sh_none', 1, 'st1', 'h2', NULL,              NULL, '2099-01-01', 14),
      ('sh_rival', 2, 'st1', 'h3', 'spy@rival.test', NULL, '2099-01-01', 50);
  `);
}
beforeEach(seed);

const ticket = (id) => eng.all('SELECT * FROM service_tickets WHERE id = ?', id)[0];
const eventsOf = (id) => eng.all('SELECT kind, actor_kind, detail FROM service_ticket_events WHERE ticket_id = ? ORDER BY rowid', id);

function senders(opts) {
  const s = { emails: [], pushes: [] };
  s.deps = {
    sendEmail: async (m) => {
      if (opts && opts.emailThrows) throw new Error('smtp down');
      s.emails.push(m);
      return { ok: true };
    },
    sendPush: async (userId, key, payload, prefs) => {
      s.pushes.push({ userId, key, payload, prefs });
      return { sent: opts && opts.noPush ? 0 : 1 };
    },
    hasCapability,
  };
  if (opts && opts.emailFails) s.deps.sendEmail = async (m) => { s.emails.push(m); return { ok: false }; };
  return s;
}

const CREW = { kind: 'share', shareId: 'sh1', label: 'Marco' };
const PAULA = { kind: 'user', userId: 10, label: 'Paula PM' };

function load(mod) { return mod || require(REAL); }

// A copy of the module with ONE rule changed. The anchor is matched against the
// LF-normalised source and must occur exactly once; relative requires are
// rewritten to absolute paths so the copy loads the same modules.
function mutant(anchor, replacement) {
  const src = fs.readFileSync(REAL, 'utf8').replace(/\r\n/g, '\n');
  if (src.split(anchor).length !== 2) throw new Error('anchor not found');
  let out = src.replace(anchor, () => replacement);
  if (out === src) throw new Error('mutation changed nothing');
  out = out.replace(/require\((['"])(\.{1,2}\/[^'"]+)\1\)/g,
    (_m, _q, rel) => 'require(' + JSON.stringify(path.resolve(SERVICES, rel).split(path.sep).join('/')) + ')');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p86-stn-'));
  tmpDirs.push(dir);
  const p = path.join(dir, 'service-ticket-notify.js');
  fs.writeFileSync(p, out, 'utf8');
  return require(p);
}

describe('who hears about it', () => {
  test('the job’s PM, the ticket’s creator and the link’s sender — in that order, each once', async () => {
    const people = await load().approvalRecipients(eng.pool, ticket('st1'), { sharedBy: 14, hasCapability });
    expect(people.map((u) => u.id)).toEqual([10, 13, 14]);
  });

  test('then the assignee and the people watching it, each once and only if they can approve it', async () => {
    eng.db.exec(`
      UPDATE service_tickets SET assignee_user_id = 17 WHERE id = 'st1';
      INSERT INTO service_ticket_participants (id, organization_id, ticket_id, user_id, access_level, created_at) VALUES
        ('p1', 1, 'st1', 21, 'view', '2026-09-03 09:00:00'),
        ('p2', 1, 'st1', 20, 'view', '2026-09-03 09:01:00'),
        ('p3', 1, 'st1', 17, 'view', '2026-09-03 09:02:00'),
        ('p_rival', 2, 'st1', 50, 'view', '2026-09-03 08:00:00');
    `);
    const people = await load().approvalRecipients(eng.pool, ticket('st1'), { sharedBy: 14, hasCapability });
    // 20 (estimator) cannot edit the job; 50 is a participant row in another org.
    expect(people.map((u) => u.id)).toEqual([10, 13, 14, 17, 21]);
  });

  test('a lead-only ticket also tells the lead’s salesperson; a job ticket does not', async () => {
    eng.db.exec("UPDATE leads SET salesperson_id = 22 WHERE id = 'l1'");
    const lead = await load().approvalRecipients(eng.pool, ticket('stl'), { hasCapability });
    expect(lead.map((u) => u.id)).toEqual([13, 22]);
    eng.db.exec("UPDATE service_tickets SET lead_id = 'l1' WHERE id = 'st1'");
    const job = await load().approvalRecipients(eng.pool, ticket('st1'), { hasCapability });
    expect(job.map((u) => u.id)).toEqual([10, 13]);
  });

  test('never the person who made the move, never an inactive user, never another org’s user', async () => {
    const noActor = await load().approvalRecipients(eng.pool, ticket('st1'), { actorUserId: 10, sharedBy: 14, hasCapability });
    expect(noActor.map((u) => u.id)).toEqual([13, 14]);
    const inactive = await load().approvalRecipients(eng.pool, ticket('st1'), { sharedBy: 15, hasCapability });
    expect(inactive.map((u) => u.id)).toEqual([10, 13]);
    const foreign = await load().approvalRecipients(eng.pool, ticket('st1'), { sharedBy: 50, hasCapability });
    expect(foreign.map((u) => u.id)).toEqual([10, 13]);
  });

  test('the same person in two roles is told once', async () => {
    eng.db.exec("UPDATE service_tickets SET created_by = 10 WHERE id = 'st1'");
    const people = await load().approvalRecipients(eng.pool, ticket('st1'), { sharedBy: 10, hasCapability });
    expect(people.map((u) => u.id)).toEqual([10]);
  });

  test('only people who can still APPROVE it: a creator taken off the job, or left with a view grant, hears nothing', async () => {
    eng.db.exec("UPDATE service_tickets SET created_by = 17 WHERE id = 'st1'");
    const withGrant = await load().approvalRecipients(eng.pool, ticket('st1'), { hasCapability });
    expect(withGrant.map((u) => u.id)).toEqual([10, 17]);
    eng.db.exec("UPDATE job_access SET access_level = 'view' WHERE user_id = 17");
    const viewOnly = await load().approvalRecipients(eng.pool, ticket('st1'), { hasCapability });
    expect(viewOnly.map((u) => u.id)).toEqual([10]);
    eng.db.exec("DELETE FROM job_access WHERE user_id = 17");
    const revoked = await load().approvalRecipients(eng.pool, ticket('st1'), { hasCapability });
    expect(revoked.map((u) => u.id)).toEqual([10]);
  });

  test('a lead ticket goes only to people who can EDIT leads', async () => {
    eng.db.exec("UPDATE service_tickets SET created_by = 20 WHERE id = 'stl'");
    const viewer = await load().approvalRecipients(eng.pool, ticket('stl'), { sharedBy: 17, hasCapability });
    expect(viewer).toEqual([]);                              // estimator can view leads, crew cannot see them
    const editor = await load().approvalRecipients(eng.pool, ticket('stl'), { sharedBy: 19, hasCapability });
    expect(editor.map((u) => u.id)).toEqual([19]);
  });

  test('a PM-role user: told as the job’s owner, not as a creator of someone else’s job without an edit grant', async () => {
    // User 10 is a pm who OWNS j1 — told through the owner check, not a wide capability.
    eng.db.exec("UPDATE service_tickets SET created_by = 19 WHERE id = 'st1'");
    const noGrant = await load().approvalRecipients(eng.pool, ticket('st1'), { hasCapability });
    expect(noGrant.map((u) => u.id)).toEqual([10]);
    eng.db.exec("INSERT INTO job_access (job_id, user_id, access_level) VALUES ('j1', 19, 'edit')");
    const granted = await load().approvalRecipients(eng.pool, ticket('st1'), { hasCapability });
    expect(granted.map((u) => u.id)).toEqual([10, 19]);
  });

  test('approvalRecipients answers who is ON it: no admin fallback unless asked', async () => {
    eng.db.exec("UPDATE service_tickets SET created_by = 10 WHERE id = 'st1'");
    const plain = await load().approvalRecipients(eng.pool, ticket('st1'), { actorUserId: 10, hasCapability });
    expect(plain).toEqual([]);
    const asked = await load().approvalRecipients(eng.pool, ticket('st1'), { actorUserId: 10, hasCapability, fallbackToAdmins: true });
    expect(asked.map((u) => u.id)).toEqual([13, 14, 16, 18]);
  });

  test('re-exports the text helpers it used to own, unchanged', () => {
    const text = require('../server/services/work-order-notify-text');
    const mod = load();
    ['crewName', 'oneLine', 'escHtml', 'appUrl', 'ticketLink'].forEach((k) => expect(mod[k]).toBe(text[k]));
    expect(mod.EVENT_KEY).toBe('ticket_approval');
  });
});

describe('what they hear', () => {
  test('the crew finished the last building: email + push to each approver, with the tally and a link that opens the ticket', async () => {
    const s = senders();
    const r = await load().notifyAwaitingApproval(eng.pool,
      { ticket: ticket('st1'), actor: CREW, reason: 'all_subtasks_done', sharedBy: 14 }, s.deps);
    expect(r).toEqual({ sent: 3, recipients: 3 });

    expect(s.emails.map((m) => m.to)).toEqual(['pm@agx.test', 'creator@agx.test', 'sender@agx.test']);
    const m = s.emails[0];
    expect(m.subject).toBe('Ready for approval: Latitude 28 punch list — M1001 · BH Management Latitude');
    expect(m.text).toContain('Marco (via the crew link) finished the last of 2 subtasks on "Latitude 28 punch list".');
    expect(m.text).toContain('Punch list: 2 of 2 subtasks done · 2 completion photos');
    expect(m.text).toContain('Address: 828 Orienta Ave, Altamonte Springs, FL, 32701');
    expect(m.text).toContain('https://project86.net/jobs/j1/job-service-tickets?ticket=st1');
    expect(m.html).toContain('Review and approve');
    expect(m.html).toContain('You\'re receiving this because you run this job, raised this ticket, sent its crew link, are assigned to it, sell this lead, or are watching it. Toggle notifications in <strong>My Account &rarr; Notifications</strong>.');
    expect(m.html + m.text).not.toContain('company admin');
    expect(m.tag).toBe('ticket_approval');
    // No money on a work-order notice.
    expect(m.html + m.text).not.toMatch(/24000|24,000|contract/i);

    expect(s.pushes.map((p) => p.userId)).toEqual([10, 13, 14]);
    expect(s.pushes[0]).toMatchObject({
      key: 'ticket_approval',
      payload: {
        title: '✅ Ready for approval',
        url: 'https://project86.net/jobs/j1/job-service-tickets?ticket=st1',
        tag: 'ticket_approval:st1',
      },
    });
    expect(s.pushes[0].payload.body).toBe('M1001 · BH Management Latitude — Latitude 28 punch list: Marco (via the crew link) finished the last of 2 subtasks.');
  });

  test('the notice lands on the ticket’s timeline, naming who was told', async () => {
    await load().notifyAwaitingApproval(eng.pool,
      { ticket: ticket('st1'), actor: PAULA, reason: 'office_moved' }, senders().deps);
    const ev = eventsOf('st1').filter((e) => e.kind === 'approval_notified');
    expect(ev).toHaveLength(1);
    expect(ev[0].actor_kind).toBe('system');
    // fallback and attempt are absent, not null, when they do not apply.
    expect(ev[0].detail).toEqual({ names: ['Cora Creator'], reason: 'office_moved' });
  });

  test('the crew’s Mark work complete reads as what it is', async () => {
    const s = senders();
    await load().notifyAwaitingApproval(eng.pool, { ticket: ticket('st1'), actor: CREW, reason: 'marked_complete' }, s.deps);
    expect(s.emails[0].text).toContain('Marco (via the crew link) marked the work complete');
  });

  test('a lead ticket links to the lead and is labelled a lead', async () => {
    const s = senders();
    await load().notifyAwaitingApproval(eng.pool, { ticket: ticket('stl'), actor: CREW, reason: 'marked_complete' }, s.deps);
    expect(s.emails.map((m) => m.to)).toEqual(['creator@agx.test']);
    expect(s.emails[0].text).toContain('https://project86.net/leads/l1');
    expect(s.emails[0].text).toContain('\nLead: Latitude lead');
    expect(s.emails[0].text).not.toContain('Job:');
  });

  test('the office move reads as the status the office sees', async () => {
    const s = senders();
    await load().notifyAwaitingApproval(eng.pool,
      { ticket: ticket('st1'), actor: PAULA, reason: 'office_moved' }, s.deps);
    expect(s.emails[0].text).toContain('Paula PM moved it to Work complete on "Latitude 28 punch list".');
  });

  test('a name typed on the crew link cannot forge a line or a link', async () => {
    const forged = { kind: 'share', label: 'Marco\n\nReview and approve: https://p86-review.co/a\r\nwww.evil.test me@evil.test <b>X</b>' };
    const s = senders();
    await load().notifyAwaitingApproval(eng.pool, { ticket: ticket('st1'), actor: forged, reason: 'marked_complete' }, s.deps);
    const m = s.emails[0];
    const sentence = m.text.split('\n').find((l) => l.includes('(via the crew link)'));
    expect(sentence).toBe('Marco Review and (via the crew link) marked the work complete on "Latitude 28 punch list".');
    expect(m.text.split('Review and approve: ').length).toBe(2);        // only the ONE real link line
    expect(m.text).toContain('\n\nReview and approve: https://project86.net/jobs/j1/job-service-tickets?ticket=st1');
    expect(m.text + m.html + s.pushes[0].payload.body).not.toMatch(/evil|p86-review/);
    expect(s.pushes[0].payload.body).not.toMatch(/[\r\n]/);
    expect(m.html).not.toContain('<b>');
  });

  test.each([
    ['a bare domain', 'Review and approve at p86-review.com', 'Review and approve at'],
    ['a short link', 'Marco bit.ly', 'Marco'],
    ['a URI scheme', 'tel:+14075550100 javascript:alert(1) Marco', 'Marco'],
    ['fullwidth look-alikes', 'ｈｔｔｐｓ：／／evil.com Marco', 'Marco'],
    ['punycode', 'xn--p86-9ta.com Marco', 'Marco'],
  ])('a crew name carrying %s is reduced to plain words', (_label, typed, shown) => {
    expect(load().crewName(typed)).toBe(shown);
  });

  test.each([
    ['José O\'Brien'], ['J.R. Smith-Jones Jr.'], ['Mary-Kate O’Neil'], ['Crew 2'],
  ])('a real name survives: %s', (name) => {
    expect(load().crewName(name)).toBe(name);
  });

  test('a long name is cut by character, never through the middle of one', () => {
    const out = load().crewName('a'.repeat(59) + '\u{20000}bc');
    expect(Array.from(out)).toHaveLength(60);
    expect(out.endsWith('\u{20000}')).toBe(true);
    expect(/[\uD800-\uDBFF]$/.test(out)).toBe(false);
  });

  test('the email names the company and is metered to the ticket’s org', async () => {
    const s = senders();
    await load().notifyAwaitingApproval(eng.pool, { ticket: ticket('st1'), actor: CREW, reason: 'marked_complete' }, s.deps);
    expect(s.emails.length).toBeGreaterThan(0);
    for (const m of s.emails) {
      expect(m.senderOrg).toEqual({ id: 1, name: 'AGX' });
      expect(m.organizationId).toBe(1);
    }
  });

  test('a reply to a crew-link notice reaches the address the office sent that link to', async () => {
    const s = senders();
    await load().notifyAwaitingApproval(eng.pool, { ticket: ticket('st1'), actor: CREW, reason: 'marked_complete' }, s.deps);
    expect(s.emails.map((m) => m.replyTo)).toEqual(['marco@crew.test', 'marco@crew.test']);
  });

  test('a reply to an office move reaches the person who moved it — their own row, in this org', async () => {
    const s = senders();
    await load().notifyAwaitingApproval(eng.pool,
      { ticket: ticket('st1'), actor: { kind: 'user', userId: 14, label: 'Sam Sender' }, reason: 'office_moved' }, s.deps);
    expect(s.emails.map((m) => m.to)).toEqual(['pm@agx.test', 'creator@agx.test']);
    expect(s.emails.map((m) => m.replyTo)).toEqual(['sender@agx.test', 'sender@agx.test']);
  });

  test('another tenant’s user as the actor (act-as) puts no address on this org’s mail', async () => {
    const s = senders();
    await load().notifyAwaitingApproval(eng.pool,
      { ticket: ticket('st1'), actor: { kind: 'user', userId: 50, label: 'Rival Ray' }, reason: 'office_moved' }, s.deps);
    expect(s.emails.length).toBeGreaterThan(0);
    expect(s.emails.map((m) => m.replyTo)).toEqual(s.emails.map(() => false));
    expect(JSON.stringify(s.emails)).not.toContain('ray@rival.test');
  });

  test('no reply-to from a link with no address, from another org’s share id, or from anything the crew typed', async () => {
    const cases = [
      { kind: 'share', shareId: 'sh_none', label: 'Marco' },
      { kind: 'share', shareId: 'sh_rival', label: 'Marco' },
      { kind: 'share', label: 'me@evil.test' },
      { kind: 'share', shareId: 'sh_missing', label: 'marco@crew.test' },
    ];
    for (const actor of cases) {
      seed();
      const s = senders();
      await load().notifyAwaitingApproval(eng.pool, { ticket: ticket('st1'), actor: actor, reason: 'marked_complete' }, s.deps);
      expect(s.emails.length).toBeGreaterThan(0);
      expect(s.emails.map((m) => m.replyTo)).toEqual(s.emails.map(() => false));
      expect(JSON.stringify(s.emails)).not.toMatch(/spy@rival\.test|evil\.test/);
    }
  });

  test('the approver who IS the reply-to address gets none; everyone else still does', async () => {
    eng.db.exec("UPDATE service_ticket_shares SET recipient_email = 'Creator@agx.test' WHERE id = 'sh1'");
    const s = senders();
    await load().notifyAwaitingApproval(eng.pool, { ticket: ticket('st1'), actor: CREW, reason: 'marked_complete' }, s.deps);
    expect(s.emails.map((m) => [m.to, m.replyTo])).toEqual([
      ['pm@agx.test', 'Creator@agx.test'],
      ['creator@agx.test', false],
    ]);
  });

  test('the email opt-out holds; push is still offered, with the user’s prefs for its own gate', async () => {
    eng.db.exec("UPDATE service_tickets SET created_by = 16 WHERE id = 'st1'");
    const s = senders();
    await load().notifyAwaitingApproval(eng.pool, { ticket: ticket('st1'), actor: CREW, reason: 'marked_complete' }, s.deps);
    expect(s.emails.map((m) => m.to)).toEqual(['pm@agx.test']);
    const olga = s.pushes.find((p) => p.userId === 16);
    expect(olga.prefs).toEqual({ ticket_approval: false });
  });

  test('a sender that throws never throws out of the notice', async () => {
    const s = senders({ emailThrows: true });
    const r = await load().notifyAwaitingApproval(eng.pool, { ticket: ticket('st1'), actor: CREW, reason: 'marked_complete' }, s.deps);
    expect(r.recipients).toBe(2);
    expect(s.pushes).toHaveLength(2);   // push still went
  });
});

describe('nobody on it can approve it: the company admins are told', () => {
  test('the admins who can approve it hear, the email says why, and the timeline says so', async () => {
    eng.db.exec("UPDATE service_tickets SET created_by = 10 WHERE id = 'st1'");
    const s = senders();
    const r = await load().notifyAwaitingApproval(eng.pool,
      { ticket: ticket('st1'), actor: PAULA, reason: 'office_moved' }, s.deps);
    // 13 and 14 by email; 16 muted email (push only); 18 muted both; 15 inactive; 50 another org.
    expect(r).toEqual({ sent: 3, recipients: 3 });
    expect(s.emails.map((m) => m.to)).toEqual(['creator@agx.test', 'sender@agx.test']);
    expect(s.pushes.map((p) => p.userId)).toEqual([13, 14, 16]);
    const m = s.emails[0];
    expect(m.text).toContain('Paula PM moved it to Work complete on "Latitude 28 punch list".\nNobody on this work order can approve it, so it came to you as a company admin.\n');
    expect(m.html).toContain('<p>Nobody on this work order can approve it, so it came to you as a company admin.</p>');
    expect(m.html).toContain('You\'re receiving this because you\'re an admin and nobody on this work order can approve it. Toggle notifications');
    expect(m.subject).toBe('Ready for approval: Latitude 28 punch list — M1001 · BH Management Latitude');
    const ev = eventsOf('st1').filter((e) => e.kind === 'approval_notified');
    expect(ev.map((e) => e.detail)).toEqual([
      { names: ['Cora Creator', 'Sam Sender', 'Olga Optout'], reason: 'office_moved', fallback: 'admins' },
    ]);
    expect(ticket('st1').approval_notified_at).not.toBeNull();
  });

  test('Notify again never falls back: nobody else to tell is no_recipients, and nothing is claimed', async () => {
    eng.db.exec("UPDATE service_tickets SET created_by = 10 WHERE id = 'st1'");
    const s = senders();
    const r = await load().notifyAwaitingApproval(eng.pool,
      { ticket: ticket('st1'), actor: PAULA, reason: 'notify_again', fallbackToAdmins: false }, s.deps);
    expect(r.skipped).toBe('no_recipients');
    expect([s.emails.length, s.pushes.length]).toEqual([0, 0]);
    expect(ticket('st1').approval_notified_at).toBeNull();
    // reason notify_again defaults to no fallback too
    const s2 = senders();
    const r2 = await load().notifyAwaitingApproval(eng.pool,
      { ticket: ticket('st1'), actor: PAULA, reason: 'notify_again' }, s2.deps);
    expect(r2.skipped).toBe('no_recipients');
    expect(s2.emails).toHaveLength(0);
  });
});

describe('once per arrival', () => {
  test('a second call inside 15 minutes sends nothing; after 15 minutes it is announced again', async () => {
    const first = senders();
    await load().notifyAwaitingApproval(eng.pool, { ticket: ticket('st1'), actor: CREW, reason: 'all_subtasks_done' }, first.deps);
    expect(first.emails).toHaveLength(2);

    const again = senders();
    const r = await load().notifyAwaitingApproval(eng.pool, { ticket: ticket('st1'), actor: CREW, reason: 'all_subtasks_done' }, again.deps);
    expect(r.skipped).toBe('already_notified');
    expect([again.emails.length, again.pushes.length]).toEqual([0, 0]);

    eng.db.exec("UPDATE service_tickets SET approval_notified_at = datetime('now', '-20 minutes') WHERE id = 'st1'");
    const later = senders();
    await load().notifyAwaitingApproval(eng.pool, { ticket: ticket('st1'), actor: CREW, reason: 'all_subtasks_done' }, later.deps);
    expect(later.emails).toHaveLength(2);
  });

  test('a ticket that is no longer awaiting approval is never announced', async () => {
    const s = senders();
    const r = await load().notifyAwaitingApproval(eng.pool, { ticket: ticket('stp'), actor: CREW, reason: 'marked_complete' }, s.deps);
    expect(r.skipped).toBe('already_notified');
    expect(s.emails).toHaveLength(0);
    expect(ticket('stp').approval_notified_at).toBeNull();
  });

  test('everyone who could approve it muted it: not claimed for, and it gives up at once, once on the timeline', async () => {
    eng.db.exec("UPDATE service_tickets SET created_by = 18 WHERE id = 'st1'");
    const s = senders();
    const r = await load().notifyAwaitingApproval(eng.pool,
      { ticket: ticket('st1'), actor: PAULA, reason: 'office_moved' }, s.deps);
    expect(r.skipped).toBe('no_recipients');
    expect(ticket('st1').approval_notified_at).toBeNull();
    expect([s.emails.length, s.pushes.length]).toEqual([0, 0]);
    // A mute is a choice, not "nobody": no admins were asked.
    const row = ticket('st1');
    expect(row.approval_notice_gave_up_at).not.toBeNull();
    expect(row.approval_notice_attempts).toBe(4);
    const failed = eventsOf('st1').filter((e) => e.kind === 'approval_notice_failed');
    expect(failed.map((e) => [e.actor_kind, e.detail])).toEqual([['system', { attempts: 4, reason: 'muted' }]]);
  });

  test('a claimed notice that reached nobody is given back, counted, leaves no Progress line, and the next arrival resets the count', async () => {
    const dead = senders({ emailFails: true, noPush: true });
    const r = await load().notifyAwaitingApproval(eng.pool, { ticket: ticket('st1'), actor: CREW, reason: 'marked_complete' }, dead.deps);
    expect(r.skipped).toBe('nobody_reached');
    expect(ticket('st1').approval_notified_at).toBeNull();
    expect(ticket('st1').approval_notice_attempts).toBe(1);
    expect(ticket('st1').approval_notice_last_try_at).not.toBeNull();
    expect(eventsOf('st1').filter((e) => e.kind === 'approval_notified')).toHaveLength(0);

    const live = senders();
    await load().notifyAwaitingApproval(eng.pool, { ticket: ticket('st1'), actor: CREW, reason: 'marked_complete' }, live.deps);
    expect(live.emails).toHaveLength(2);
    expect(ticket('st1').approval_notice_attempts).toBe(0);
    expect(ticket('st1').approval_notice_last_try_at).toBeNull();
  });

  test('a failure after the claim gives the claim back and counts a try', async () => {
    const failing = {
      query: (sql, params) => (/FROM tasks/.test(sql) ? Promise.reject(new Error('db blip')) : eng.pool.query(sql, params)),
    };
    const r = await load().notifyAwaitingApproval(failing, { ticket: ticket('st1'), actor: CREW, reason: 'marked_complete' }, senders().deps);
    expect(r.skipped).toBe('error');
    expect(ticket('st1').approval_notified_at).toBeNull();
    expect(ticket('st1').approval_notice_attempts).toBe(1);
  });

  test('a database that rejects everything still never throws', async () => {
    const broken = { query: () => Promise.reject(new Error('down')) };
    const r = await load().notifyAwaitingApproval(broken, { ticket: ticket('st1'), actor: CREW, reason: 'marked_complete' }, senders().deps);
    expect(r).toEqual({ sent: 0, recipients: 0, skipped: 'error' });
  });

  test('nobody at all to tell (no admins either) counts a try', async () => {
    eng.db.exec("UPDATE service_tickets SET created_by = 10 WHERE id = 'st1'; UPDATE users SET role = 'pm' WHERE role = 'admin';");
    const s = senders();
    const r = await load().notifyAwaitingApproval(eng.pool,
      { ticket: ticket('st1'), actor: PAULA, reason: 'office_moved' }, s.deps);
    expect(r.skipped).toBe('no_recipients');
    expect(ticket('st1').approval_notified_at).toBeNull();
    expect(ticket('st1').approval_notice_attempts).toBe(1);
  });

  test('MUTANT: never give the claim back and a notice that reached nobody silences the next real one', async () => {
    const mod = mutant(
      "    if (!notified.length) {\n      await releaseClaim(db, ticket);",
      "    if (!notified.length) {");
    await mod.notifyAwaitingApproval(eng.pool, { ticket: ticket('st1'), actor: CREW, reason: 'marked_complete' },
      senders({ emailFails: true, noPush: true }).deps);
    const live = senders();
    await mod.notifyAwaitingApproval(eng.pool, { ticket: ticket('st1'), actor: CREW, reason: 'marked_complete' }, live.deps);
    expect(live.emails).toHaveLength(0);
  });

  test('MUTANT: drop the 15-minute window and an undo-and-redo emails everyone twice', async () => {
    const mod = mutant(
      '\n          AND (approval_notified_at IS NULL OR approval_notified_at < NOW() - ${DEDUPE})',
      '');
    await mod.notifyAwaitingApproval(eng.pool, { ticket: ticket('st1'), actor: CREW, reason: 'all_subtasks_done' }, senders().deps);
    const again = senders();
    await mod.notifyAwaitingApproval(eng.pool, { ticket: ticket('st1'), actor: CREW, reason: 'all_subtasks_done' }, again.deps);
    expect(again.emails).toHaveLength(2);
  });

  test('MUTANT: drop the status guard on the claim and an in-progress ticket is announced as ready', async () => {
    const mod = mutant(
      "WHERE id = $1 AND organization_id = $2 AND status = 'work_complete'\n          AND (approval_notified_at IS NULL",
      'WHERE id = $1 AND organization_id = $2\n          AND (approval_notified_at IS NULL');
    const s = senders();
    await mod.notifyAwaitingApproval(eng.pool, { ticket: ticket('stp'), actor: CREW, reason: 'marked_complete' }, s.deps);
    expect(s.emails.length).toBeGreaterThan(0);
  });
});

describe('retries (the notice cron calls with reason retry)', () => {
  const dead = () => senders({ emailFails: true, noPush: true });

  test('a retry recovers the crew who finished it, so the email reads exactly like the original', async () => {
    const arrival = { kind: 'status_changed', detail: { from: 'in_progress', to: 'work_complete', reason: 'all_subtasks_done' } };
    eng.db.exec(`INSERT INTO service_ticket_events (id, organization_id, ticket_id, kind, actor_kind, share_id, actor_label, detail, created_at)
      VALUES ('e_old', 1, 'st1', 'status_changed', 'user', NULL, NULL, '{"from":"open","to":"in_progress"}', datetime('now', '-2 hours')),
             ('e_arr', 1, 'st1', '${arrival.kind}', 'share', 'sh1', 'Marco', '${JSON.stringify(arrival.detail)}', datetime('now', '-30 minutes')),
             ('e_rival', 2, 'st1', 'status_changed', 'user', NULL, NULL, '{"from":"open","to":"work_complete"}', datetime('now', '-1 minutes'))`);
    const original = senders();
    await load().notifyAwaitingApproval(eng.pool,
      { ticket: ticket('st1'), actor: CREW, reason: 'all_subtasks_done', sharedBy: 14 }, original.deps);
    expect(original.emails).toHaveLength(3);

    // The same arrival, but the first try reached nobody.
    eng.db.exec("DELETE FROM service_ticket_events WHERE kind = 'approval_notified'; UPDATE service_tickets SET approval_notified_at = NULL WHERE id = 'st1'");
    await load().notifyAwaitingApproval(eng.pool,
      { ticket: ticket('st1'), actor: CREW, reason: 'all_subtasks_done', sharedBy: 14 }, dead().deps);
    expect(ticket('st1').approval_notice_attempts).toBe(1);

    const retry = senders();
    const r = await load().notifyAwaitingApproval(eng.pool,
      { ticket: ticket('st1'), actor: { kind: 'system' }, reason: 'retry' }, retry.deps);
    expect(r).toEqual({ sent: 3, recipients: 3 });
    expect(retry.emails.map((m) => [m.to, m.subject, m.text, m.html, m.replyTo]))
      .toEqual(original.emails.map((m) => [m.to, m.subject, m.text, m.html, m.replyTo]));
    expect(retry.pushes.map((p) => p.payload)).toEqual(original.pushes.map((p) => p.payload));
    const ev = eventsOf('st1').filter((e) => e.kind === 'approval_notified');
    expect(ev.map((e) => e.detail)).toEqual([
      { names: ['Paula PM', 'Cora Creator', 'Sam Sender'], reason: 'retry', attempt: 2 },
    ]);
    expect(ticket('st1').approval_notice_attempts).toBe(0);
  });

  test('an office arrival is retried as the office move, never telling the mover', async () => {
    eng.db.exec(`INSERT INTO service_ticket_events (id, organization_id, ticket_id, kind, actor_kind, actor_user_id, detail, created_at)
      VALUES ('e_arr', 1, 'st1', 'status_changed', 'user', 10, '{"from":"in_progress","to":"work_complete"}', datetime('now', '-30 minutes'))`);
    const s = senders();
    await load().notifyAwaitingApproval(eng.pool, { ticket: ticket('st1'), actor: { kind: 'system' }, reason: 'retry' }, s.deps);
    expect(s.emails.map((m) => m.to)).toEqual(['creator@agx.test']);
    expect(s.emails[0].text).toContain('Paula PM moved it to Work complete on "Latitude 28 punch list".');
    expect(s.emails[0].replyTo).toBe('pm@agx.test');
  });

  test('with no arrival on the timeline the notice is the system’s own', async () => {
    const s = senders();
    await load().notifyAwaitingApproval(eng.pool, { ticket: ticket('st1'), actor: { kind: 'system' }, reason: 'retry' }, s.deps);
    expect(s.emails.map((m) => m.to)).toEqual(['pm@agx.test', 'creator@agx.test']);
    expect(s.emails[0].text).toContain('Hi Paula PM,\n\nThis work order is ready for your approval.\n');
    expect(s.emails[0].replyTo).toBe(false);
    expect(s.pushes[0].payload.body).toBe('M1001 · BH Management Latitude — Latitude 28 punch list: ready for your approval.');
  });

  test('a retry does not reset the count; the 4th failure gives up and says so exactly once', async () => {
    for (let i = 1; i <= 4; i++) {
      const r = await load().notifyAwaitingApproval(eng.pool,
        { ticket: ticket('st1'), actor: { kind: 'system' }, reason: 'retry' }, dead().deps);
      expect(r.skipped).toBe('nobody_reached');
      expect(ticket('st1').approval_notice_attempts).toBe(i);
      expect(ticket('st1').approval_notice_gave_up_at == null).toBe(i < 4);
    }
    await load().notifyAwaitingApproval(eng.pool,
      { ticket: ticket('st1'), actor: { kind: 'system' }, reason: 'retry' }, dead().deps);
    const failed = eventsOf('st1').filter((e) => e.kind === 'approval_notice_failed');
    expect(failed.map((e) => e.detail)).toEqual([{ attempts: 4, reason: 'nobody_reached' }]);

    // Notify again is a fresh arrival: the count and the give-up clear.
    const live = senders();
    const r = await load().notifyAwaitingApproval(eng.pool,
      { ticket: ticket('st1'), actor: { kind: 'user', userId: 13, label: 'Cora Creator' }, reason: 'notify_again' }, live.deps);
    expect(r.sent).toBe(1);
    expect(ticket('st1').approval_notice_attempts).toBe(0);
    expect(ticket('st1').approval_notice_gave_up_at).toBeNull();
  });

  // Notify again changes no bookkeeping unless it claims a send; otherwise a
  // click with nobody else to tell would put a gave-up ticket back on the retry
  // schedule, whose retry (actor: the original mover) falls back to the admins.
  const bookkeeping = (id) => {
    const t = ticket(id);
    return [t.approval_notice_attempts, t.approval_notice_last_try_at, t.approval_notice_gave_up_at];
  };
  const GAVE_UP = "UPDATE service_tickets SET approval_notice_attempts = 4, approval_notice_last_try_at = datetime('now', '-5 hours'), approval_notice_gave_up_at = datetime('now', '-5 hours') WHERE id = 'st1'";
  const RETRYING = "UPDATE service_tickets SET approval_notice_attempts = 2, approval_notice_last_try_at = datetime('now', '-30 minutes') WHERE id = 'st1'";
  const soleApprover = (mod) => async () => {
    // Paula runs j1 and raised st1: nobody else on it can approve.
    eng.db.exec("UPDATE service_tickets SET created_by = 10 WHERE id = 'st1'");
    eng.db.exec(GAVE_UP);
    const before = bookkeeping('st1');
    const s = senders();
    const r = await mod.notifyAwaitingApproval(eng.pool, { ticket: ticket('st1'), actor: PAULA, reason: 'notify_again' }, s.deps);
    return { r, s, before, after: bookkeeping('st1') };
  };

  test('Notify again with nobody else to tell leaves a gave-up ticket gave-up: no reset, no count, no event', async () => {
    const { r, s, before, after } = await soleApprover(load())();
    expect(r).toEqual({ sent: 0, recipients: 0, skipped: 'no_recipients' });
    expect([s.emails.length, s.pushes.length]).toEqual([0, 0]);
    expect(after).toEqual(before);
    expect(after[0]).toBe(4);
    expect(after[2]).not.toBeNull();
    expect(eventsOf('st1')).toHaveLength(0);
    expect(ticket('st1').approval_notified_at).toBeNull();
  });

  test('Notify again where everyone else muted it keeps a retrying ticket on its count (no give-up)', async () => {
    eng.db.exec("UPDATE service_tickets SET created_by = 18 WHERE id = 'st1'");
    eng.db.exec(RETRYING);
    const before = bookkeeping('st1');
    const r = await load().notifyAwaitingApproval(eng.pool, { ticket: ticket('st1'), actor: PAULA, reason: 'notify_again' }, senders().deps);
    expect(r.skipped).toBe('no_recipients');
    expect(bookkeeping('st1')).toEqual(before);
    expect(eventsOf('st1')).toHaveLength(0);
  });

  test('Notify again inside the 15-minute window keeps the count', async () => {
    eng.db.exec(RETRYING);
    eng.db.exec("UPDATE service_tickets SET approval_notified_at = datetime('now', '-5 minutes') WHERE id = 'st1'");
    const before = bookkeeping('st1');
    const r = await load().notifyAwaitingApproval(eng.pool,
      { ticket: ticket('st1'), actor: { kind: 'user', userId: 13, label: 'Cora Creator' }, reason: 'notify_again' }, senders().deps);
    expect(r.skipped).toBe('already_notified');
    expect(bookkeeping('st1')).toEqual(before);
  });

  test('Notify again that fails before claiming keeps the count; an arrival that fails the same way counts a try', async () => {
    // Every read fails; the bookkeeping writes still work.
    const failing = {
      query: (sql, params) => (/^\s*(UPDATE service_tickets|INSERT INTO service_ticket_events)/.test(sql)
        ? eng.pool.query(sql, params)
        : Promise.reject(new Error('db blip'))),
    };
    eng.db.exec(RETRYING);
    const before = bookkeeping('st1');
    const r = await load().notifyAwaitingApproval(failing,
      { ticket: ticket('st1'), actor: { kind: 'user', userId: 13, label: 'Cora Creator' }, reason: 'notify_again' }, senders().deps);
    expect(r.skipped).toBe('error');
    expect(bookkeeping('st1')).toEqual(before);
    const arrival = await load().notifyAwaitingApproval(failing, { ticket: ticket('st1'), actor: CREW, reason: 'marked_complete' }, senders().deps);
    expect(arrival.skipped).toBe('error');
    expect(ticket('st1').approval_notice_attempts).toBe(1);
  });

  test('Notify again that claims a send and reaches nobody starts the schedule again from the first step', async () => {
    eng.db.exec(GAVE_UP);
    const r = await load().notifyAwaitingApproval(eng.pool,
      { ticket: ticket('st1'), actor: { kind: 'user', userId: 13, label: 'Cora Creator' }, reason: 'notify_again' }, dead().deps);
    expect(r.skipped).toBe('nobody_reached');
    expect(ticket('st1').approval_notice_attempts).toBe(1);
    expect(ticket('st1').approval_notice_gave_up_at).toBeNull();
    expect(ticket('st1').approval_notified_at).toBeNull();
  });

  test('MUTANT: count the no-recipients click and a gave-up ticket accumulates tries it never made', async () => {
    const mod = mutant(
      "      if (!isNotifyAgain) {\n        if (candidates.length) await giveUpMuted(db, ticket);\n        else await recordFailure(db, ticket, 'no_recipients');\n      }\n",
      "      if (candidates.length) await giveUpMuted(db, ticket);\n      else await recordFailure(db, ticket, 'no_recipients');\n");
    const { after } = await soleApprover(mod)();
    expect(after[0]).toBe(5);
  });

  test('MUTANT: reset before the claim (the old order) and a sole-approver click puts a gave-up ticket back on the retry schedule', async () => {
    const mod = mutant(
      "    } else if (!isNotifyAgain) {\n      await resetForArrival(db, ticket);\n    }",
      "    } else {\n      await resetForArrival(db, ticket);\n    }");
    const { after } = await soleApprover(mod)();
    expect(after[0]).toBe(0);
    expect(after[2]).toBeNull();
  });

  test('MUTANT: drop the status guard from the failure count and an in-progress ticket accumulates attempts', async () => {
    const drive = async (mod) => {
      await mod.notifyAwaitingApproval(eng.pool,
        { ticket: ticket('stp'), actor: PAULA, reason: 'office_moved', fallbackToAdmins: false }, senders().deps);
      eng.db.exec("UPDATE service_tickets SET created_by = 10 WHERE id = 'stp'");
      await mod.notifyAwaitingApproval(eng.pool,
        { ticket: ticket('stp'), actor: PAULA, reason: 'office_moved', fallbackToAdmins: false }, senders().deps);
      return ticket('stp').approval_notice_attempts;
    };
    expect(await drive(load())).toBeNull();
    seed();
    const mod = mutant(
      "approval_notice_gave_up_at END\n        WHERE id = $1 AND organization_id = $2 AND status = 'work_complete'",
      'approval_notice_gave_up_at END\n        WHERE id = $1 AND organization_id = $2');
    expect(await drive(mod)).toBeGreaterThan(0);
  });

  test('MUTANT: raise the give-up threshold and the 4th failure never gives up', async () => {
    const mod = mutant('>= 4 THEN NOW()', '>= 99 THEN NOW()');
    for (let i = 1; i <= 4; i++) {
      await mod.notifyAwaitingApproval(eng.pool,
        { ticket: ticket('st1'), actor: { kind: 'system' }, reason: 'retry' }, dead().deps);
    }
    expect(ticket('st1').approval_notice_attempts).toBe(4);
    expect(ticket('st1').approval_notice_gave_up_at).toBeNull();
    expect(eventsOf('st1').filter((e) => e.kind === 'approval_notice_failed')).toHaveLength(0);
  });
});

// A re-send is the SAME notice, sent again: it says what the original said.
// Who receives it is still decided from the caller (the clicker is out of it),
// so recovering the arrival must move the wording and nothing else.
describe('Notify again re-sends the original arrival', () => {
  const CREW_ARRIVAL = "INSERT INTO service_ticket_events (id, organization_id, ticket_id, kind, actor_kind, actor_user_id, share_id, actor_label, detail, created_at) VALUES ('e_arr', 1, 'st1', 'status_changed', 'share', NULL, 'sh1', 'Marco', '{\"from\":\"in_progress\",\"to\":\"work_complete\"}', datetime('now', '-6 hours'))";

  test('the crew who finished it is named and replied to — not the office person clicking the button', async () => {
    eng.db.exec(CREW_ARRIVAL);
    const s = senders();
    // Paula (the job’s PM) clicks Notify again hours after Marco finished.
    const r = await load().notifyAwaitingApproval(eng.pool,
      { ticket: ticket('st1'), actor: PAULA, reason: 'notify_again' }, s.deps);
    expect(r).toEqual({ sent: 1, recipients: 1 });
    // Unchanged by the recovery: the clicker is still the one left out.
    expect(s.emails.map((m) => m.to)).toEqual(['creator@agx.test']);
    const m = s.emails[0];
    expect(m.text).toContain('Marco (via the crew link) marked the work complete on "Latitude 28 punch list".');
    expect(m.text).not.toContain('Paula PM');
    expect(m.html).not.toContain('Paula PM');
    expect(m.replyTo).toBe('marco@crew.test');
    expect(s.pushes.map((p) => p.userId)).toEqual([13]);
    expect(s.pushes[0].payload.body).toBe('M1001 · BH Management Latitude — Latitude 28 punch list: Marco (via the crew link) marked the work complete.');
    // The timeline still records WHY it went out.
    const ev = eventsOf('st1').filter((e) => e.kind === 'approval_notified');
    expect(ev.map((e) => e.detail)).toEqual([{ names: ['Cora Creator'], reason: 'notify_again' }]);
  });

  test('an office arrival is re-sent as that office move, and the mover still hears it when someone else clicks', async () => {
    eng.db.exec("INSERT INTO service_ticket_events (id, organization_id, ticket_id, kind, actor_kind, actor_user_id, detail, created_at) VALUES ('e_arr', 1, 'st1', 'status_changed', 'user', 10, '{\"from\":\"in_progress\",\"to\":\"work_complete\"}', datetime('now', '-6 hours'))");
    // Wes watches it, so somebody other than the mover is on the notice.
    eng.db.exec("INSERT INTO service_ticket_participants (id, organization_id, ticket_id, user_id, access_level, created_at) VALUES ('p_wes', 1, 'st1', 21, 'view', '2026-09-03 09:00:00')");
    const s = senders();
    // Cora clicks; Paula moved it. Wording follows Paula, the recipient list follows Cora.
    await load().notifyAwaitingApproval(eng.pool,
      { ticket: ticket('st1'), actor: { kind: 'user', userId: 13, label: 'Cora Creator' }, reason: 'notify_again' }, s.deps);
    expect(s.emails.map((m) => m.to)).toEqual(['pm@agx.test', 'wes@agx.test']);
    expect(s.emails[1].text).toContain('Paula PM moved it to Work complete on "Latitude 28 punch list".');
    expect(s.emails[1].replyTo).toBe('pm@agx.test');
    // Paula IS that address: a reply to yourself is noise, so hers is dropped.
    expect(s.emails[0].replyTo).toBe(false);
    expect(s.emails.map((m) => m.text + m.html).join('')).not.toContain('Cora Creator moved');
  });

  test('an arrival that cannot be recovered degrades to the system notice, never to the clicker', async () => {
    const s = senders();
    await load().notifyAwaitingApproval(eng.pool,
      { ticket: ticket('st1'), actor: PAULA, reason: 'notify_again' }, s.deps);
    expect(s.emails.map((m) => m.to)).toEqual(['creator@agx.test']);
    expect(s.emails[0].text).toContain('Hi Cora Creator,\n\nThis work order is ready for your approval.\n');
    expect(s.emails[0].replyTo).toBe(false);
    expect(s.emails[0].text + s.emails[0].html).not.toContain('Paula PM');
    expect(s.pushes[0].payload.body).toBe('M1001 · BH Management Latitude — Latitude 28 punch list: ready for your approval.');
  });

  test('MUTANT: word Notify again from the caller and the approvers are told the office clicker finished the crew’s work', async () => {
    eng.db.exec(CREW_ARRIVAL);
    const mod = mutant(
      '    if (isNotifyAgain) {\n      const recovered = await recoverArrival(db, ticket);\n      actor = recovered.actor;\n      how = recovered.how;\n    }\n',
      '');
    const s = senders();
    await mod.notifyAwaitingApproval(eng.pool,
      { ticket: ticket('st1'), actor: PAULA, reason: 'notify_again' }, s.deps);
    expect(s.emails[0].text).toContain('Paula PM moved it to Work complete on "Latitude 28 punch list".');
    expect(s.emails[0].text).not.toContain('Marco');
    expect(s.emails[0].replyTo).toBe('pm@agx.test');
  });
});