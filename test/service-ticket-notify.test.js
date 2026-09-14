// "FLAG IT FOR THE OFFICE TO KNOW THAT THE JOB IS COMPLETE" (John, 2026-09-13).
//
// services/service-ticket-notify.js tells the approvers when a ticket reaches
// work_complete. Driven here against node:sqlite through the pg shim, over the
// real schema, with the email and push senders injected so what was SENT is the
// assertion:
//   * who hears: the job's PM, the ticket's creator and the crew link's sender —
//     active, in this org, each once, never the person who made the move;
//   * what they hear: the job, the ticket, who finished it, the punch-list tally
//     and a link that opens the ticket — and no money;
//   * once per arrival: a second call inside 15 minutes sends nothing, and a
//     ticket no longer awaiting approval is never announced;
//   * the email opt-out holds, and a failing sender never throws;
//   * only people who can still open the ticket are told, a crew-typed name
//     cannot forge a line or a link, and a claim that reached nobody is given back.
// The tenancy, actor and dedupe rules are then removed from a copy of the
// module and shown to fail.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const SERVICES = path.join(__dirname, '..', 'server', 'services');
const REAL = path.join(SERVICES, 'service-ticket-notify.js');
const TABLES = ['organizations', 'users', 'jobs', 'leads', 'tasks', 'attachments', 'job_access',
  'service_tickets', 'service_ticket_events', 'service_ticket_shares'];

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
const mutantPaths = [];

beforeAll(() => {
  eng = createPgSqlite(sqliteSchema(TABLES), {
    jsonColumns: ['data', 'tags', 'detail', 'checklist', 'materials', 'notification_prefs'],
  });
});
afterAll(() => {
  if (eng) eng.close();
  for (const p of mutantPaths) { try { fs.unlinkSync(p); } catch (_) {} }
});

function seed() {
  eng.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM jobs; DELETE FROM leads; DELETE FROM tasks;
    DELETE FROM attachments; DELETE FROM service_tickets; DELETE FROM service_ticket_events; DELETE FROM job_access;
    DELETE FROM service_ticket_shares;
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
      (20, 'Ella Estimator','est@agx.test',     'estimator', 1, 1, '{}');
    INSERT INTO job_access (job_id, user_id, access_level) VALUES ('j1', 17, 'edit');
    INSERT INTO leads (id, title, organization_id) VALUES ('l1', 'Latitude lead', 1);
    INSERT INTO jobs (id, owner_id, lead_id, organization_id, data) VALUES
      ('j1', 10, 'l1', 1, '{"jobNumber":"M1001","title":"BH Management Latitude","street_address":"828 Orienta Ave","city":"Altamonte Springs","state":"FL","zip":"32701","contractAmount":24000}');
    INSERT INTO service_tickets (id, organization_id, title, job_id, lead_id, status, checklist, created_by) VALUES
      ('st1', 1, 'Latitude 28 punch list', 'j1', NULL, 'work_complete', '[]', 13),
      ('stl', 1, 'Lead ticket',           NULL, 'l1', 'work_complete', '[]', 13),
      ('stp', 1, 'Still in progress',     'j1', NULL, 'in_progress',   '[]', 13);
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

function load(mod) { return mod || require(REAL); }

function mutant(find, replace) {
  const src = fs.readFileSync(REAL, 'utf8');
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const f = find.split('\n').join(eol);
  if (src.split(f).length !== 2) throw new Error('MUTATION ANCHOR not found exactly once: ' + find.slice(0, 80));
  const abs = (name) => JSON.stringify(path.join(SERVICES, name).split(path.sep).join('/'));
  const out = src.replace(f, replace.split('\n').join(eol))
    .replace("require('./service-tickets')", 'require(' + abs('service-tickets.js') + ')')
    .replace("require('./service-ticket-workorder')", 'require(' + abs('service-ticket-workorder.js') + ')')
    .replace("require('./service-ticket-access')", 'require(' + abs('service-ticket-access.js') + ')')
    // The sender identity helpers sit one directory up; required lazily, but on
    // every notice, so a mutant copy must resolve them too.
    .replace("require('../email-sender')",
      'require(' + JSON.stringify(path.join(SERVICES, '..', 'email-sender.js').split(path.sep).join('/')) + ')');
  if (out === src) throw new Error('MUTATION CHANGED NO BYTES');
  const p = path.join(os.tmpdir(), '_p86_stn_' + process.pid + '_' + Math.random().toString(36).slice(2, 9) + '.js');
  fs.writeFileSync(p, out, 'utf8');
  mutantPaths.push(p);
  return require(p);
}

describe('who hears about it', () => {
  test('the job’s PM, the ticket’s creator and the link’s sender — in that order, each once', async () => {
    const people = await load().approvalRecipients(eng.pool, ticket('st1'), { sharedBy: 14, hasCapability });
    expect(people.map((u) => u.id)).toEqual([10, 13, 14]);
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

  test('MUTANT: check READ instead of WRITE and a view-only grant is asked to approve', async () => {
    eng.db.exec("UPDATE service_tickets SET created_by = 17 WHERE id = 'st1'; UPDATE job_access SET access_level = 'view' WHERE user_id = 17;");
    const mod = mutant("      mode: 'write',", "      mode: 'read',");
    const people = await mod.approvalRecipients(eng.pool, ticket('st1'), { hasCapability });
    expect(people.map((u) => u.id)).toContain(17);
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

  test('MUTANT: skip the access rule and the creator taken off the job is still emailed', async () => {
    eng.db.exec("UPDATE service_tickets SET created_by = 17 WHERE id = 'st1'; DELETE FROM job_access WHERE user_id = 17;");
    const mod = mutant('    if (verdict && verdict.ok) out.push(u);', '    out.push(u);');
    const people = await mod.approvalRecipients(eng.pool, ticket('st1'), { hasCapability });
    expect(people.map((u) => u.id)).toContain(17);
  });

  test('MUTANT: drop the org predicate on users and another tenant’s user is told about this job', async () => {
    // Ray is an ADMIN in his own org: a wide capability the access rule does not
    // tie to an org, so the users predicate is the only thing keeping him out.
    const mod = mutant(
      "WHERE id = ANY($1::int[]) AND organization_id = $2 AND active = TRUE',\n    [wanted, orgId]",
      "WHERE id = ANY($1::int[]) AND active = TRUE',\n    [wanted]");
    const people = await mod.approvalRecipients(eng.pool, ticket('st1'), { sharedBy: 50, hasCapability });
    expect(people.map((u) => u.id)).toContain(50);
  });

  test('MUTANT: drop the actor exclusion and the PM is emailed about their own click', async () => {
    const mod = mutant('id && id !== actor && ids.indexOf(id) === i', 'id && ids.indexOf(id) === i');
    const people = await mod.approvalRecipients(eng.pool, ticket('st1'), { actorUserId: 10, hasCapability });
    expect(people.map((u) => u.id)).toContain(10);
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
      { ticket: ticket('st1'), actor: { kind: 'user', userId: 10, label: 'Paula PM' }, reason: 'office_moved' }, senders().deps);
    const ev = eventsOf('st1').filter((e) => e.kind === 'approval_notified');
    expect(ev).toHaveLength(1);
    expect(ev[0].actor_kind).toBe('system');
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
      { ticket: ticket('st1'), actor: { kind: 'user', userId: 10, label: 'Paula PM' }, reason: 'office_moved' }, s.deps);
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

  test('someone who muted it on both channels is not claimed for', async () => {
    eng.db.exec("UPDATE service_tickets SET created_by = 18 WHERE id = 'st1'");
    const s = senders();
    const r = await load().notifyAwaitingApproval(eng.pool,
      { ticket: ticket('st1'), actor: { kind: 'user', userId: 10, label: 'Paula PM' }, reason: 'office_moved' }, s.deps);
    expect(r.skipped).toBe('no_recipients');
    expect(ticket('st1').approval_notified_at).toBeNull();
    expect([s.emails.length, s.pushes.length]).toEqual([0, 0]);
  });

  test('a claimed notice that reached nobody is given back, leaves no Progress line, and the next arrival is announced', async () => {
    const dead = senders({ emailFails: true, noPush: true });
    const r = await load().notifyAwaitingApproval(eng.pool, { ticket: ticket('st1'), actor: CREW, reason: 'marked_complete' }, dead.deps);
    expect(r.skipped).toBe('nobody_reached');
    expect(ticket('st1').approval_notified_at).toBeNull();
    expect(eventsOf('st1').filter((e) => e.kind === 'approval_notified')).toHaveLength(0);

    const live = senders();
    await load().notifyAwaitingApproval(eng.pool, { ticket: ticket('st1'), actor: CREW, reason: 'marked_complete' }, live.deps);
    expect(live.emails).toHaveLength(2);
  });

  test('a failure after the claim gives the claim back', async () => {
    const failing = {
      query: (sql, params) => (/FROM tasks/.test(sql) ? Promise.reject(new Error('db blip')) : eng.pool.query(sql, params)),
    };
    const r = await load().notifyAwaitingApproval(failing, { ticket: ticket('st1'), actor: CREW, reason: 'marked_complete' }, senders().deps);
    expect(r.skipped).toBe('error');
    expect(ticket('st1').approval_notified_at).toBeNull();
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

  test('with nobody to tell, nothing is claimed — the next real arrival is still announced', async () => {
    eng.db.exec("UPDATE service_tickets SET created_by = 10 WHERE id = 'st1'");
    const s = senders();
    const r = await load().notifyAwaitingApproval(eng.pool,
      { ticket: ticket('st1'), actor: { kind: 'user', userId: 10, label: 'Paula PM' }, reason: 'office_moved' }, s.deps);
    expect(r.skipped).toBe('no_recipients');
    expect(ticket('st1').approval_notified_at).toBeNull();
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

  test('MUTANT: drop the status guard and an in-progress ticket is announced as ready', async () => {
    const mod = mutant(" AND status = 'work_complete'", '');
    const s = senders();
    await mod.notifyAwaitingApproval(eng.pool, { ticket: ticket('stp'), actor: CREW, reason: 'marked_complete' }, s.deps);
    expect(s.emails.length).toBeGreaterThan(0);
  });
});
