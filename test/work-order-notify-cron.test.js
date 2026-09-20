// THE WORK-ORDER NOTICE CRON — server/work-order-notify-cron.js runOnce.
//
// Driven against node:sqlite through the pg shim over the schema server/db.js
// writes, three organizations (one archived), with the database, the senders
// and the capability check injected. Stored instants are written relative to
// the engine's own clock (datetime('now', '-N minutes')), because the cron
// compares them DB-side against NOW(); calendar decisions (weekday, local hour,
// local day) take the `now` passed in.
//   A. approval retries: attempts 0 adopted only after 10 minutes and within
//      14 days; then 10 min / 60 min / 4 h; the 4th failure gives up; told,
//      archived, gave-up, in-progress and archived-org tickets are never tried;
//      a stale claim with no approval_notified event is released and retried,
//      one with the event is left alone.
//   C. crew activity: one notice for a burst, none again inside 30 minutes, the
//      next burst carries only its own events; settle 5 min / max wait 20 min;
//      finishing and flags never batch; two ticks racing send once.
//   D. digest: nothing when nothing needs attention; sections; once per local
//      day; a crew lead whose ONLY item is a WORK ORDER ASSIGNED TO THEM with
//      buildings still open gets one (1.33 — the daily task email stopped
//      carrying buildings and every other section is gated on job access,
//      which they fail; 1.35 — the key is the record's own Assigned to, and a
//      leftover assignee on a building row reaches nobody);
//      weekdays 7-12 in the person's own zone; digest off + waiting on =
//      the standalone reminder, honouring the org's N; and a digest that
//      reached NO channel falls through to that reminder in the same pass,
//      because the day is already burned and nothing retries it.
//   Isolation (the Register 3 property): no org-2 content to org-1 people, no
//      cross-org admin fallback, every statement names its org.
//   dry runs write nothing; a closing server skips the tick; a tick is never
//      started while the previous one is still running.
// Mutants: the claim's 30-minute window, the 60-minute backoff, the claim's
// org predicate, the digest fire-log check, and the tick's running guard.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');
const tz = require('../server/timezone');
const inflight = require('../server/services/inflight');

const SERVER = path.join(__dirname, '..', 'server');
const REAL = path.join(SERVER, 'work-order-notify-cron.js');
const cron = require(REAL);

const TABLES = ['organizations', 'users', 'jobs', 'leads', 'job_access', 'tasks', 'attachments', 'app_settings',
  'service_tickets', 'service_ticket_events', 'service_ticket_shares', 'service_ticket_participants',
  'service_ticket_revisions', 'service_ticket_flags'];

const ROLE_CAPS = {
  admin: ['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'LEADS_VIEW', 'LEADS_EDIT'],
  pm: ['JOBS_VIEW_ALL', 'JOBS_EDIT_OWN', 'LEADS_VIEW', 'LEADS_EDIT'],
  crew: ['JOBS_VIEW_ASSIGNED', 'JOBS_EDIT_OWN'],
};
const hasCapability = (user, cap) => String(cap || '').split(/\s+/).filter(Boolean)
  .some((k) => (ROLE_CAPS[user && user.role] || []).includes(k));

const ZONE = 'America/New_York';
const DAY = 86400000;

let eng;
const tmpDirs = [];
let logSpy;
let warnSpy;

beforeAll(() => {
  eng = createPgSqlite(sqliteSchema(TABLES), {
    jsonColumns: ['data', 'detail', 'notification_prefs', 'settings', 'tags', 'fields', 'checklist'],
  });
  // app_settings.key is the table's primary key in Postgres; the fixture has no
  // constraints, so the upsert's conflict target is given one here.
  eng.db.exec('CREATE UNIQUE INDEX fixture_app_settings_key ON app_settings (key)');
});
afterAll(() => {
  if (eng) eng.close();
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
});
beforeEach(() => {
  inflight._reset();
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  base();
});
afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
  inflight._reset();
});

function q(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') return "'" + JSON.stringify(v).replace(/'/g, "''") + "'";
  const s = String(v);
  if (/^datetime\(/.test(s)) return s;
  return "'" + s.replace(/'/g, "''") + "'";
}
function insert(table, rows) {
  const list = Array.isArray(rows) ? rows : [rows];
  list.forEach((r) => {
    const cols = Object.keys(r);
    eng.db.exec('INSERT INTO ' + table + ' (' + cols.join(', ') + ') VALUES (' + cols.map((c) => q(r[c])).join(', ') + ')');
  });
}
const ago = (n, unit) => "datetime('now', '-" + n + ' ' + (unit || 'minutes') + "')";

function ticket(o) {
  insert('service_tickets', Object.assign({
    organization_id: 1, title: 'Work order', job_id: 'j1', lead_id: null, status: 'work_complete',
    checklist: '[]', created_by: 13, assignee_user_id: null, completed_at: ago(3, 'hours'), updated_at: ago(3, 'hours'),
    approval_notified_at: null, approval_notice_attempts: 0, approval_notice_last_try_at: null,
    approval_notice_gave_up_at: null, archived_at: null, crew_activity_notified_at: null,
    crew_activity_prev_notified_at: null, due_date: null, scheduled_for: null, created_at: '2026-09-01 10:00:00',
  }, o));
}

let evSeq = 0;
function event(o) {
  evSeq++;
  insert('service_ticket_events', Object.assign({
    id: 'ev' + evSeq, organization_id: 1, ticket_id: 'c1', kind: 'share_opened', actor_kind: 'share',
    actor_user_id: null, share_id: 'sh1', actor_label: 'Marco', detail: {}, created_at: ago(10),
  }, o));
}

function base() {
  eng.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM jobs; DELETE FROM leads; DELETE FROM job_access;
    DELETE FROM tasks; DELETE FROM attachments; DELETE FROM app_settings; DELETE FROM service_tickets;
    DELETE FROM service_ticket_events; DELETE FROM service_ticket_shares; DELETE FROM service_ticket_participants;
    DELETE FROM service_ticket_revisions; DELETE FROM service_ticket_flags;
  `);
  insert('organizations', [
    { id: 1, name: 'AGX', timezone: ZONE, settings: {}, archived_at: null },
    { id: 2, name: 'Rival', timezone: ZONE, settings: {}, archived_at: null },
    { id: 3, name: 'Gone', timezone: ZONE, settings: {}, archived_at: ago(1, 'days') },
  ]);
  insert('users', [
    { id: 10, name: 'Paula PM', email: 'pm@agx.test', role: 'pm', organization_id: 1, active: 1, notification_prefs: {}, timezone: null },
    { id: 11, name: 'Carl Crew', email: 'crew@agx.test', role: 'crew', organization_id: 1, active: 1, notification_prefs: {}, timezone: null },
    { id: 13, name: 'Cora Creator', email: 'creator@agx.test', role: 'admin', organization_id: 1, active: 1, notification_prefs: {}, timezone: null },
    { id: 50, name: 'Rival Ray', email: 'ray@rival.test', role: 'admin', organization_id: 2, active: 1, notification_prefs: {}, timezone: null },
    { id: 51, name: 'Rival Rita', email: 'rita@rival.test', role: 'pm', organization_id: 2, active: 1, notification_prefs: {}, timezone: null },
    { id: 70, name: 'Gone Gary', email: 'gary@gone.test', role: 'admin', organization_id: 3, active: 1, notification_prefs: {}, timezone: null },
  ]);
  insert('jobs', [
    { id: 'j1', owner_id: 10, organization_id: 1, data: { jobNumber: 'M1001', title: 'Latitude', contractAmount: 24000 } },
    { id: 'j9', owner_id: 51, organization_id: 2, data: { jobNumber: 'R1', title: 'RIVAL JOB' } },
    { id: 'j3', owner_id: 70, organization_id: 3, data: { jobNumber: 'G1', title: 'GONE JOB' } },
  ]);
}

function senders(opts) {
  const s = { emails: [], pushes: [] };
  s.deps = {
    db: eng.pool,
    hasCapability,
    sendEmail: async (m) => { s.emails.push(m); return { ok: !(opts && opts.dead) }; },
    sendPush: async (userId, key, payload) => { s.pushes.push({ userId, key, payload }); return { sent: 0 }; },
  };
  return s;
}

const row = (id, org) => eng.all('SELECT * FROM service_tickets WHERE id = ? AND organization_id = ?', id, org || 1)[0];
const eventsOf = (id, kind) => eng.all('SELECT * FROM service_ticket_events WHERE ticket_id = ? AND kind = ? ORDER BY rowid', id, kind);
const toldTickets = () => eng.all("SELECT DISTINCT ticket_id FROM service_ticket_events WHERE kind = 'approval_notified' ORDER BY ticket_id").map((r) => r.ticket_id);

// A weekday morning in New York that is already in the past, so every stored
// instant can be written before it and still be "more than 24 hours" old to the
// engine's own clock.
function pastWeekdayMorning(weekday, hour) {
  for (let back = 2; back < 20; back++) {
    const day = tz.localDateInTz(ZONE, new Date(Date.now() - back * DAY));
    const at = tz.localWallClockToInstant(day + 'T' + String(hour).padStart(2, '0') + ':00:00', ZONE);
    if (tz.dayOfWeekInTz(ZONE, at) === weekday) return at;
  }
  throw new Error('no weekday found');
}
const sqlTime = (d) => d.toISOString().replace('T', ' ').slice(0, 19);
const localDay = (d) => tz.localDateInTz(ZONE, d);

function mutant(pairs) {
  let src = fs.readFileSync(REAL, 'utf8').replace(/\r\n/g, '\n');
  for (const [anchor, replacement] of pairs) {
    if (src.split(anchor).length !== 2) throw new Error('anchor not found');
    const next = src.replace(anchor, () => replacement);
    if (next === src) throw new Error('mutation changed nothing');
    src = next;
  }
  src = src.replace(/require\((['"])(\.{1,2}\/[^'"]+)\1\)/g,
    (_m, _q, rel) => 'require(' + JSON.stringify(require.resolve(path.resolve(SERVER, rel)).split(path.sep).join('/')) + ')');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p86-wonc-'));
  tmpDirs.push(dir);
  const p = path.join(dir, 'work-order-notify-cron.js');
  fs.writeFileSync(p, src, 'utf8');
  return require(p);
}

// ── A. approval retries ─────────────────────────────────────────────────────
describe('A. approval notice retries', () => {
  function scheduleFixture() {
    ticket({ id: 'a0_new', completed_at: ago(5), updated_at: ago(5) });
    ticket({ id: 'a0_due', completed_at: ago(15), updated_at: ago(15) });
    ticket({ id: 'a0_old', completed_at: ago(20, 'days'), updated_at: ago(20, 'days') });
    ticket({ id: 'a0_nullcount', approval_notice_attempts: null, completed_at: ago(15), updated_at: ago(15) });
    ticket({ id: 'a1_early', approval_notice_attempts: 1, approval_notice_last_try_at: ago(5) });
    ticket({ id: 'a1_due', approval_notice_attempts: 1, approval_notice_last_try_at: ago(11) });
    ticket({ id: 'a2_early', approval_notice_attempts: 2, approval_notice_last_try_at: ago(30) });
    ticket({ id: 'a2_due', approval_notice_attempts: 2, approval_notice_last_try_at: ago(61) });
    ticket({ id: 'a3_early', approval_notice_attempts: 3, approval_notice_last_try_at: ago(180) });
    ticket({ id: 'a3_due', approval_notice_attempts: 3, approval_notice_last_try_at: ago(241) });
    ticket({ id: 'told', approval_notified_at: ago(60) });
    ticket({ id: 'arch', archived_at: ago(1, 'hours'), completed_at: ago(30), updated_at: ago(30) });
    ticket({ id: 'gave', approval_notice_attempts: 4, approval_notice_last_try_at: ago(600), approval_notice_gave_up_at: ago(600) });
    ticket({ id: 'inprog', status: 'in_progress', approval_notice_attempts: 1, approval_notice_last_try_at: ago(600) });
    ticket({ id: 'gone_org', organization_id: 3, job_id: 'j3', created_by: 70, completed_at: ago(30), updated_at: ago(30) });
    ticket({ id: 'rival_due', organization_id: 2, job_id: 'j9', created_by: 51, completed_at: ago(30), updated_at: ago(30) });
  }
  const DUE = ['a0_due', 'a0_nullcount', 'a1_due', 'a2_due', 'a3_due', 'rival_due'];

  test('the schedule: 10-minute grace within 14 days, then 10 min / 1 h / 4 h; told, archived, gave-up, in-progress and archived-org tickets never', async () => {
    scheduleFixture();
    const s = senders();
    const out = await cron.runOnce({ deps: s.deps });
    expect(toldTickets()).toEqual(DUE.slice().sort());
    expect(out.approvals).toMatchObject({ candidates: 6, retried: 6, gave_up: 0 });
    // The retry is the notice itself: the job's PM and the creator, each in their own org.
    const ab = s.emails.filter((m) => /Work order/.test(m.subject));
    expect(ab.length).toBeGreaterThan(0);
    s.emails.forEach((m) => {
      const rival = /rival\.test$/.test(m.to);
      expect([m.to, m.senderOrg.id, m.organizationId]).toEqual([m.to, rival ? 2 : 1, rival ? 2 : 1]);
    });
    expect(s.emails.map((m) => m.to)).not.toContain('gary@gone.test');
    expect(row('a1_due').approval_notice_attempts).toBe(0);
    expect(eventsOf('a2_due', 'approval_notified')[0].detail).toMatchObject({ reason: 'retry', attempt: 3 });
  });

  test('a tick where every try fails counts each one; the 4th failure gives up and is not tried again', async () => {
    scheduleFixture();
    const out = await cron.runOnce({ deps: senders({ dead: true }).deps });
    expect(out.approvals).toMatchObject({ retried: 6, gave_up: 1 });
    expect(row('a3_due').approval_notice_gave_up_at).not.toBeNull();
    expect(row('a3_due').approval_notice_attempts).toBe(4);
    expect(row('a2_due').approval_notice_attempts).toBe(3);
    expect(row('a0_due').approval_notice_attempts).toBe(1);
    expect(eventsOf('a3_due', 'approval_notice_failed').map((e) => e.detail)).toEqual([{ attempts: 4, reason: 'nobody_reached' }]);
    // Nothing is due again straight away.
    const again = await cron.runOnce({ deps: senders({ dead: true }).deps });
    expect(again.approvals.candidates).toBe(0);
  });

  test('MUTANT: shorten the 1-hour backoff to 10 minutes and the third try fires early', async () => {
    scheduleFixture();
    const mod = mutant([[
      "approval_notice_attempts = 2 AND approval_notice_last_try_at < NOW() - INTERVAL '60 minutes'",
      "approval_notice_attempts = 2 AND approval_notice_last_try_at < NOW() - INTERVAL '10 minutes'",
    ]]);
    await mod.runOnce({ deps: senders().deps });
    expect(toldTickets()).toContain('a2_early');
  });

  test('a stale claim with no approval_notified event is released and retried later; one with the event is left alone', async () => {
    ticket({ id: 'stale', approval_notified_at: ago(30) });
    ticket({ id: 'sent', approval_notified_at: ago(30) });
    event({ ticket_id: 'sent', kind: 'approval_notified', actor_kind: 'system', share_id: null, actor_label: null,
      detail: { names: ['Paula PM'], reason: 'marked_complete' }, created_at: ago(29) });
    ticket({ id: 'inflight', approval_notified_at: ago(5) });
    ticket({ id: 'ancient', approval_notified_at: ago(3, 'days') });

    const out = await cron.runOnce({ deps: senders().deps });
    expect(out.approvals.released).toBe(1);
    expect(row('stale').approval_notified_at).toBeNull();
    expect(row('stale').approval_notice_attempts).toBe(1);
    expect(row('sent').approval_notified_at).not.toBeNull();
    expect(row('inflight').approval_notified_at).not.toBeNull();
    expect(row('sent').approval_notice_attempts).toBe(0);

    eng.db.exec("UPDATE service_tickets SET approval_notice_last_try_at = datetime('now', '-11 minutes') WHERE id = 'stale'");
    await cron.runOnce({ deps: senders().deps });
    expect(eventsOf('stale', 'approval_notified')).toHaveLength(1);
  });
});

// ── C. crew activity ────────────────────────────────────────────────────────
describe('C. crew activity batches', () => {
  function crewFixture() {
    ticket({ id: 'c1', status: 'in_progress', title: 'Latitude punch list', completed_at: null, created_by: 13, approval_notice_attempts: 0 });
    insert('tasks', [
      { id: 't1', organization_id: 1, title: 'Bldg 1 — Side A: rail', status: 'done', scope: 'org', service_ticket_id: 'c1' },
      { id: 't2', organization_id: 1, title: 'Bldg 2 — Side A: post', status: 'open', scope: 'org', service_ticket_id: 'c1' },
    ]);
    insert('service_ticket_shares', { id: 'sh1', organization_id: 1, ticket_id: 'c1', token_hash: 'h1', scope: 'respond',
      recipient_email: 'marco@crew.test', recipient_name: 'Marco', expires_at: '2099-01-01', created_by: 10, created_at: '2026-09-02 09:00:00' });
  }
  const crewEmails = (s) => s.emails.filter((m) => m.tag === 'ticket_crew_activity');

  test('one notice for a burst; none again inside 30 minutes; the next burst carries only its own events', async () => {
    crewFixture();
    event({ kind: 'share_opened', created_at: ago(12) });
    event({ kind: 'subtask_completed', detail: { task_id: 't1', title: 'Bldg 1 — Side A: rail' }, created_at: ago(9) });

    const first = senders();
    const out = await cron.runOnce({ deps: first.deps });
    expect(out.crew).toMatchObject({ candidates: 1, batches: 1 });
    expect(crewEmails(first).map((m) => m.to)).toEqual(['pm@agx.test', 'creator@agx.test']);
    const m = crewEmails(first)[0];
    expect(m.subject).toBe('Crew update: Latitude punch list — M1001 · Latitude');
    expect(m.text).toContain('Opened the work order for the first time');
    expect(m.text).toContain('Finished 1 building: Bldg 1 — Side A: rail');
    expect(m.replyTo).toBe('marco@crew.test');
    expect(JSON.stringify(first.emails)).not.toMatch(/24000|contract/i);
    expect(row('c1').crew_activity_notified_at).not.toBeNull();

    // Ten minutes on (everything moves back together), the crew leaves a note
    // three minutes after that notice: inside the window, so it waits.
    const travel = (minutes) => eng.db.exec(`
      UPDATE service_tickets SET crew_activity_notified_at = datetime(crew_activity_notified_at, '-${minutes} minutes') WHERE id = 'c1';
      UPDATE service_ticket_events SET created_at = datetime(created_at, '-${minutes} minutes') WHERE ticket_id = 'c1';
    `);
    travel(10);
    event({ kind: 'subtask_note', detail: { task_id: 't2', note: 'Post cracked' }, created_at: ago(7) });
    const inside = senders();
    await cron.runOnce({ deps: inside.deps });
    expect(crewEmails(inside)).toHaveLength(0);

    // 35 minutes after the first notice, another event.
    travel(25);
    event({ kind: 'photo_added', detail: { task_id: 't2', kind: 'before', attachment_id: 'a9' }, created_at: ago(6) });
    const next = senders();
    await cron.runOnce({ deps: next.deps });
    const n = crewEmails(next);
    expect(n.map((x) => x.to)).toEqual(['pm@agx.test', 'creator@agx.test']);
    // The note made inside the window was not lost, and nothing is told twice.
    expect(n[0].text).toContain('Left 1 note');
    expect(n[0].text).toContain('Added 1 photo (1 before)');
    expect(n[0].text).not.toContain('Finished');
    expect(n[0].text).not.toContain('Opened the work order');
  });

  test('settle: a crew still working (last event under 5 minutes ago) waits, unless it has been busy for 20', async () => {
    crewFixture();
    event({ kind: 'share_opened', created_at: ago(2) });
    const quiet = senders();
    expect((await cron.runOnce({ deps: quiet.deps })).crew.candidates).toBe(0);
    event({ kind: 'note_added', detail: { fields: ['guest_log'] }, created_at: ago(21) });
    const busy = senders();
    const out = await cron.runOnce({ deps: busy.deps });
    expect(out.crew.candidates).toBe(1);
    expect(crewEmails(busy)[0].text).toContain('Added a field report note');
  });

  test('finishing the work order and flagging a problem never batch; office events never count', async () => {
    crewFixture();
    event({ kind: 'status_changed', detail: { from: 'in_progress', to: 'work_complete', reason: 'marked_complete' }, created_at: ago(10) });
    event({ kind: 'flag_raised', detail: { flag_id: 'f1', category: 'safety' }, created_at: ago(10) });
    event({ kind: 'problem_flagged', detail: { flag_id: 'f1' }, created_at: ago(10) });
    event({ kind: 'note_added', actor_kind: 'user', actor_user_id: 10, share_id: null, created_at: ago(10) });
    const s = senders();
    await cron.runOnce({ deps: s.deps });
    expect(crewEmails(s)).toHaveLength(0);
  });

  test('two ticks racing each other send once (the claim)', async () => {
    crewFixture();
    event({ kind: 'share_opened', created_at: ago(12) });
    const s = senders();
    const [a, b] = await Promise.all([cron.runOnce({ deps: s.deps }), cron.runOnce({ deps: s.deps })]);
    expect(a.crew.batches + b.crew.batches).toBe(1);
    expect(crewEmails(s)).toHaveLength(2);      // PM + creator, once each
  });

  test('MUTANT: drop the 30-minute window and a second burst inside it sends again', async () => {
    crewFixture();
    const mod = mutant([
      ["(t.crew_activity_notified_at IS NULL OR t.crew_activity_notified_at < NOW() - INTERVAL '30 minutes')", '(1 = 1)'],
      ["(crew_activity_notified_at IS NULL OR crew_activity_notified_at < NOW() - INTERVAL '30 minutes')", '(1 = 1)'],
    ]);
    event({ kind: 'share_opened', created_at: ago(12) });
    await mod.runOnce({ deps: senders().deps });
    eng.db.exec("UPDATE service_tickets SET crew_activity_notified_at = datetime('now', '-10 minutes') WHERE id = 'c1'");
    event({ kind: 'subtask_note', detail: { task_id: 't2', note: 'again' }, created_at: ago(6) });
    const inside = senders();
    await mod.runOnce({ deps: inside.deps });
    expect(crewEmails(inside).length).toBeGreaterThan(0);
  });

  test('MUTANT: drop the org predicate from the claim and a same-id work order in another org is silenced', async () => {
    // Postgres ids are unique; the fixture lets two orgs share one so a claim
    // that is not pinned to its org has something to hit.
    const drive = async (mod) => {
      base();
      crewFixture();
      ticket({ id: 'c1', organization_id: 2, job_id: 'j9', status: 'in_progress', title: 'RIVAL punch list', created_by: 51, completed_at: null });
      insert('service_ticket_shares', { id: 'sh9', organization_id: 2, ticket_id: 'c1', token_hash: 'h9', scope: 'respond',
        recipient_email: 'jo@rivalcrew.test', recipient_name: 'Jo', expires_at: '2099-01-01', created_by: 51, created_at: '2026-09-02 09:00:00' });
      event({ kind: 'share_opened', created_at: ago(12) });
      event({ organization_id: 2, share_id: 'sh9', actor_label: 'Jo', kind: 'share_opened', created_at: ago(12) });
      const s = senders();
      const before = eng.log.length;
      await mod.runOnce({ deps: s.deps });
      const claims = eng.log.slice(before).filter((e) => /^UPDATE service_tickets SET crew_activity_prev_notified_at/.test(e.sql));
      return { to: crewEmails(s).map((m) => m.to).sort(), claims };
    };
    const real = await drive(cron);
    expect(real.to).toEqual(['creator@agx.test', 'pm@agx.test', 'rita@rival.test']);
    expect(real.claims.length).toBe(2);
    real.claims.forEach((c) => expect(c.sql).toContain('WHERE id = $1 AND organization_id = $2'));

    const mod = mutant([[
      'SET crew_activity_prev_notified_at = crew_activity_notified_at, crew_activity_notified_at = NOW()\n        WHERE id = $1 AND organization_id = $2',
      'SET crew_activity_prev_notified_at = crew_activity_notified_at, crew_activity_notified_at = NOW()\n        WHERE id = $1 AND $2 IS NOT NULL',
    ]]);
    const broken = await drive(mod);
    expect(broken.to).not.toContain('rita@rival.test');
  });
});

// ── D. digest / waiting reminder ────────────────────────────────────────────
describe('D. morning digest and waiting reminder', () => {
  const WED9 = () => pastWeekdayMorning(3, 9);
  function digestFixture(W, settings) {
    eng.db.exec("UPDATE organizations SET settings = '" + JSON.stringify(settings || {}) + "' WHERE id = 1");
    const back = (days) => sqlTime(new Date(W.getTime() - days * DAY + 2 * 3600000));
    ticket({ id: 'd_over5', title: 'Waiting since last week', completed_at: back(7), updated_at: back(7), approval_notified_at: back(7) });
    ticket({ id: 'd_fri3', title: 'Waiting since Friday', completed_at: back(5), updated_at: back(5), approval_notified_at: back(5) });
    // Assigned to Carl, the way the office sets it from the real dropdown.
    ticket({ id: 'd_due', title: 'Gate overdue', status: 'in_progress', completed_at: null,
      assignee_user_id: 11, due_date: localDay(new Date(W.getTime() - DAY)) });
    ticket({ id: 'd_sched', title: 'Crew today', status: 'open', completed_at: null, scheduled_for: localDay(W) });
    return back;
  }
  const digests = (s) => s.emails.filter((m) => m.tag === 'work_order_digest');
  const reminders = (s) => s.emails.filter((m) => m.tag === 'ticket_waiting');

  test('one digest per person with something to do, on a weekday morning, with the sections and no Reply-To', async () => {
    const W = WED9();
    digestFixture(W);
    // Carl holds no grant on j1, so every section that goes through
    // listVisibility skips him — and since 1.33 took buildings off the daily
    // task email, this digest is the ONLY thing that tells him about the punch
    // list he is on the hook for. Neither building carries his name: nothing
    // assigns a building, and the leftover id on the second one (Cora's, from
    // before 1.35) must reach nobody.
    insert('tasks', [
      {
        id: 'b_carl', organization_id: 1, title: 'Bldg 12', status: 'open', scope: 'org',
        service_ticket_id: 'd_due', assignee_user_id: null, archived_at: null,
        due_date: localDay(new Date(W.getTime() + DAY)),
      },
      {
        id: 'b_left', organization_id: 1, title: 'Bldg 14', status: 'open', scope: 'org',
        service_ticket_id: 'd_due', assignee_user_id: 13, archived_at: null,
        due_date: localDay(new Date(W.getTime() + 3 * DAY)),
      },
    ]);
    const s = senders();
    const out = await cron.runOnce({ now: W, deps: s.deps });
    const d = digests(s);
    // Paula runs j1; Cora raised the tickets (admin); Carl can open nothing but
    // is the ASSIGNEE of a work order whose punch list is still open.
    expect(d.map((m) => m.to).sort()).toEqual(['creator@agx.test', 'crew@agx.test', 'pm@agx.test']);
    const carl = d.find((x) => x.to === 'crew@agx.test');
    expect(carl.subject).toBe('Work orders needing you today (1)');
    expect(carl.text).toContain('Work orders assigned to you with buildings still open (1)');
    // BOTH buildings on his work order are his to answer for — the one with
    // nobody's name on it and the one still carrying Cora's.
    expect(carl.text).toContain('2 buildings still open · next due ');
    ['Ready for your approval', 'Overdue (', 'Crew scheduled soon'].forEach((head) => {
      expect([head, carl.text.includes(head)]).toEqual([head, false]);
    });
    // Crew-facing: he is told the job number and where to go, and nothing more.
    expect(carl.text).toContain('M1001 · Latitude');
    expect(carl.subject + carl.text + carl.html).not.toMatch(/[$£€]\s?\d|\b\d+\.\d{2}\b/);
    // Cora's id is on b_left, and that is not a claim on anything: the work
    // order is not hers, so the section is not in her digest at all.
    const cora = d.find((x) => x.to === 'creator@agx.test');
    expect(cora.text).not.toContain('Work orders assigned to you with buildings still open');
    expect(JSON.stringify(s.emails)).not.toMatch(/buildings? assigned|your buildings/i);
    const m = d.find((x) => x.to === 'pm@agx.test');
    expect(m.subject).toBe('[2 to approve] Work orders needing you today (4)');
    expect(m.text).toContain('Ready for your approval (2)');
    expect(m.text).toContain('Overdue (1)');
    expect(m.text).toContain('Crew scheduled soon, link not opened (1)');
    expect(m.text).toContain('over 2 business days');
    expect(m.replyTo).toBe(false);
    expect(m.senderOrg).toEqual({ id: 1, name: 'AGX' });
    expect(m.organizationId).toBe(1);
    expect(JSON.stringify(s.emails)).not.toMatch(/24000|contract/i);
    const push = s.pushes.find((p) => p.userId === 10 && p.key === 'work_order_digest');
    expect(push.payload.body).toBe('2 to approve · 1 overdue · 1 link not opened');
    expect(out.digest).toMatchObject({ digests: 3 });
    expect(out.digest.users).toBeGreaterThanOrEqual(3);
    // Delivered under the digest's own preference key, unchanged: the section
    // did not arrive with a new switch of its own.
    expect(carl.tag).toBe('work_order_digest');
    expect(s.pushes.filter((p) => p.userId === 11).map((p) => p.key)).toEqual(['work_order_digest']);
  });

  test('the section keeps the digest’s preference key: muting work_order_digest silences it, on both channels', async () => {
    const W = WED9();
    digestFixture(W);
    insert('tasks', {
      id: 'b_carl', organization_id: 1, title: 'Bldg 12', status: 'open', scope: 'org',
      service_ticket_id: 'd_due', assignee_user_id: null, archived_at: null,
      due_date: localDay(new Date(W.getTime() + DAY)),
    });
    eng.db.exec(`UPDATE users SET notification_prefs = '{"work_order_digest":false,"push":{"work_order_digest":false}}' WHERE id = 11`);
    const s = senders();
    await cron.runOnce({ now: W, deps: s.deps });
    expect(s.emails.filter((m) => m.to === 'crew@agx.test')).toHaveLength(0);
    expect(s.pushes.filter((p) => p.userId === 11)).toHaveLength(0);
    // Everyone else still receives theirs.
    expect(digests(s).map((m) => m.to).sort()).toEqual(['creator@agx.test', 'pm@agx.test']);
  });

  test('once per local day: a second tick the same morning sends nothing', async () => {
    const W = WED9();
    digestFixture(W);
    await cron.runOnce({ now: W, deps: senders().deps });
    const log = eng.all("SELECT value FROM app_settings WHERE key = 'work_order_notify_log'")[0].value;
    expect(Object.keys(log.fires)).toContain('digest|10|' + localDay(W));
    const again = senders();
    await cron.runOnce({ now: new Date(W.getTime() + 30 * 60000), deps: again.deps });
    expect(digests(again)).toHaveLength(0);
  });

  test('MUTANT: skip the fire-log check and the second tick sends a second digest', async () => {
    const W = WED9();
    digestFixture(W);
    const mod = mutant([['    if (ctx.log.fires[fireKey]) return;\n', '']]);
    await mod.runOnce({ now: W, deps: senders().deps });
    const again = senders();
    await mod.runOnce({ now: new Date(W.getTime() + 30 * 60000), deps: again.deps });
    expect(digests(again).length).toBeGreaterThan(0);
  });

  test('outside 7-12 local, on a Saturday, or before the person’s own morning: nothing', async () => {
    const W = WED9();
    digestFixture(W);
    const early = senders();
    await cron.runOnce({ now: new Date(W.getTime() - 2 * 3600000 - 60000), deps: early.deps });   // 6:59
    const noon = senders();
    await cron.runOnce({ now: new Date(W.getTime() + 3 * 3600000), deps: noon.deps });            // 12:00
    const saturday = senders();
    await cron.runOnce({ now: new Date(W.getTime() + 3 * DAY), deps: saturday.deps });
    expect([digests(early).length, digests(noon).length, digests(saturday).length]).toEqual([0, 0, 0]);
    expect(eng.all("SELECT value FROM app_settings WHERE key = 'work_order_notify_log'")).toHaveLength(0);

    // Paula in Los Angeles: 9:00 in New York is 6:00 for her.
    eng.db.exec("UPDATE users SET timezone = 'America/Los_Angeles' WHERE id = 10");
    const west = senders();
    await cron.runOnce({ now: W, deps: west.deps });
    expect(digests(west).map((m) => m.to)).toEqual(['creator@agx.test']);
  });

  test('nothing needs attention: nothing is sent, and the person is still recorded for the day', async () => {
    const W = WED9();
    const s = senders();
    const out = await cron.runOnce({ now: W, deps: s.deps });
    expect(s.emails).toHaveLength(0);
    expect(out.digest.digests).toBe(0);
    const log = eng.all("SELECT value FROM app_settings WHERE key = 'work_order_notify_log'")[0].value;
    // Everyone in both live orgs was processed; nobody in the archived one.
    expect(Object.keys(log.fires).sort()).toEqual([10, 11, 13, 50, 51].map((id) => 'digest|' + id + '|' + localDay(W)));
  });

  test('digest off, waiting reminder on: the standalone reminder, only for work orders over the org’s N business days', async () => {
    const W = WED9();
    digestFixture(W, { work_orders: { approval_reminder_business_days: 3 } });
    eng.db.exec(`UPDATE users SET notification_prefs = '{"work_order_digest":false,"push":{"work_order_digest":false}}' WHERE id = 10`);
    const s = senders();
    const out = await cron.runOnce({ now: W, deps: s.deps });
    expect(digests(s).map((m) => m.to)).toEqual(['creator@agx.test']);
    const r = reminders(s);
    expect(r.map((m) => m.to)).toEqual(['pm@agx.test']);
    // Last week's is 5 business days (> 3); Friday's is 3 (not > 3).
    expect(r[0].subject).toBe('Still waiting for approval: 1 work order');
    expect(r[0].text).toContain('Waiting since last week');
    expect(r[0].text).not.toContain('Waiting since Friday');
    expect(r[0].replyTo).toBe(false);
    expect(r[0].senderOrg).toEqual({ id: 1, name: 'AGX' });
    expect(out.digest.reminders).toBe(1);

    // With the default N (2), Friday's is over too.
    base();
    digestFixture(W, {});
    eng.db.exec(`UPDATE users SET notification_prefs = '{"work_order_digest":false,"push":{"work_order_digest":false}}' WHERE id = 10`);
    const d2 = senders();
    await cron.runOnce({ now: W, deps: d2.deps });
    expect(reminders(d2)[0].subject).toBe('Still waiting for approval: 2 work orders');

    // Both off: nothing.
    base();
    digestFixture(W, {});
    eng.db.exec(`UPDATE users SET notification_prefs = '{"work_order_digest":false,"ticket_waiting":false,"push":{"work_order_digest":false,"ticket_waiting":false}}' WHERE id = 10`);
    const off = senders();
    await cron.runOnce({ now: W, deps: off.deps });
    expect(off.emails.filter((m) => m.to === 'pm@agx.test')).toHaveLength(0);
  });

  // The digest pref defaults to ON on the push channel for everyone who never
  // touched it, so "digest on" is not evidence the digest was delivered. The
  // fire key for the day is written before the send and nothing retries it.
  function channels(opts) {
    const s = { emails: [], pushes: [] };
    s.deps = {
      db: eng.pool,
      hasCapability,
      sendEmail: async (m) => { s.emails.push(m); return { ok: !(opts && (opts.deadEmail || []).includes(m.tag)) }; },
      sendPush: async (userId, key, payload) => {
        s.pushes.push({ userId, key, payload });
        return { sent: (opts && (opts.pushKeys || []).includes(key)) ? 1 : 0 };
      },
    };
    return s;
  }

  test('digest email off and no phone subscribed: the reminder they left on is still delivered, once', async () => {
    const W = WED9();
    digestFixture(W, {});
    // Paula unchecked Email on the digest and never touched its Push box.
    eng.db.exec(`UPDATE users SET notification_prefs = '{"work_order_digest":false}' WHERE id = 10`);
    const s = channels();
    const out = await cron.runOnce({ now: W, deps: s.deps });
    expect(digests(s).map((m) => m.to)).toEqual(['creator@agx.test']);
    const r = reminders(s);
    expect(r.map((m) => m.to)).toEqual(['pm@agx.test']);
    expect(r[0].subject).toBe('Still waiting for approval: 2 work orders');
    expect(r[0].replyTo).toBe(false);
    expect(r[0].senderOrg).toEqual({ id: 1, name: 'AGX' });
    expect(out.digest.reminders).toBe(1);
    // The digest push was attempted (and reached nobody) before the fallback.
    expect(s.pushes.filter((p) => p.userId === 10).map((p) => p.key)).toEqual(['work_order_digest', 'ticket_waiting']);
  });

  test('a digest that reached the phone is not followed by a reminder as well', async () => {
    const W = WED9();
    digestFixture(W, {});
    eng.db.exec(`UPDATE users SET notification_prefs = '{"work_order_digest":false}' WHERE id = 10`);
    const s = channels({ pushKeys: ['work_order_digest'] });
    const out = await cron.runOnce({ now: W, deps: s.deps });
    expect(reminders(s)).toHaveLength(0);
    expect(s.pushes.filter((p) => p.userId === 10).map((p) => p.key)).toEqual(['work_order_digest']);
    expect(out.digest.digests).toBe(2);
    expect(out.digest.reminders).toBe(0);
  });

  test('the fallback is the reminder’s own pref and the reminder’s own rule: muted, or nothing over N, and nothing is sent', async () => {
    const W = WED9();
    digestFixture(W, {});
    // Digest email off, and the waiting reminder muted on both channels.
    eng.db.exec(`UPDATE users SET notification_prefs = '{"work_order_digest":false,"ticket_waiting":false,"push":{"ticket_waiting":false}}' WHERE id = 10`);
    const muted = channels();
    const outMuted = await cron.runOnce({ now: W, deps: muted.deps });
    expect(muted.emails.filter((m) => m.to === 'pm@agx.test')).toHaveLength(0);
    expect(outMuted.digest.reminders).toBe(0);

    // Nothing has waited over N: no reminder to fall back to.
    base();
    const W2 = WED9();
    eng.db.exec("UPDATE organizations SET settings = '{}' WHERE id = 1");
    ticket({ id: 'd_due', title: 'Gate overdue', status: 'in_progress', completed_at: null, due_date: localDay(new Date(W2.getTime() - DAY)) });
    eng.db.exec(`UPDATE users SET notification_prefs = '{"work_order_digest":false}' WHERE id = 10`);
    const none = channels();
    const outNone = await cron.runOnce({ now: W2, deps: none.deps });
    expect(none.emails.filter((m) => m.to === 'pm@agx.test')).toHaveLength(0);
    expect(outNone.digest.reminders).toBe(0);
    expect(outNone.digest.skipped).toBeGreaterThan(0);
  });

  test('MUTANT: decide the fallback on the pref instead of on what was delivered, and the reminder is never sent', async () => {
    const W = WED9();
    digestFixture(W, {});
    eng.db.exec(`UPDATE users SET notification_prefs = '{"work_order_digest":false}' WHERE id = 10`);
    const mod = mutant([[
      '    if (key === DIGEST_KEY && waitingOn && entry.overBusinessDays.length) {\n'
      + '      const fallback = text.waitingReminderMessage({ recipient: u, items: entry.overBusinessDays, overDays: overDays });\n'
      + '      const alsoReached = await inflight.track(deliver(d, u, WAITING_KEY, fallback, org, senderOrg), WAITING_KEY);\n'
      + '      if (alsoReached) { out.digest.reminders++; continue; }\n'
      + '    }\n',
      '',
    ]]);
    const s = channels();
    const out = await mod.runOnce({ now: W, deps: s.deps });
    expect(reminders(s)).toHaveLength(0);
    expect(s.emails.filter((m) => m.to === 'pm@agx.test')).toHaveLength(0);
    expect(out.digest.reminders).toBe(0);
  });
});

// ── isolation, dry, closing ─────────────────────────────────────────────────
describe('isolation between organizations', () => {
  test('no org-2 content reaches org-1 people, no org-2 admin gets org-1’s fallback, and every statement names its org', async () => {
    const W = pastWeekdayMorning(2, 10);
    const back = (days) => sqlTime(new Date(W.getTime() - days * DAY));
    // Org 1: a work order nobody on it can approve (its job has no owner and
    // its creator cannot edit) -> org 1's admin. Org 2: its own.
    insert('jobs', { id: 'j0', owner_id: null, organization_id: 1, data: { jobNumber: 'M0', title: 'Orphan job' } });
    ticket({ id: 'o1', job_id: 'j0', title: 'Orphan work order', created_by: 11, completed_at: back(6), updated_at: back(6), approval_notified_at: back(6) });
    ticket({ id: 'r1', organization_id: 2, job_id: 'j9', title: 'RIVAL WORK ORDER', created_by: 51, completed_at: back(6), updated_at: back(6), approval_notified_at: back(6) });
    ticket({ id: 'r2', organization_id: 2, job_id: 'j9', title: 'RIVAL RETRY', created_by: 51, completed_at: ago(30), updated_at: ago(30) });
    ticket({ id: 'c1', status: 'in_progress', title: 'Latitude punch list', completed_at: null });
    event({ kind: 'share_opened', share_id: null, actor_label: 'Marco', created_at: ago(12) });
    event({ ticket_id: 'r1', organization_id: 2, kind: 'share_opened', share_id: null, actor_label: 'RIVALCREW', created_at: ago(12) });

    const s = senders();
    const before = eng.log.length;
    await cron.runOnce({ now: W, deps: s.deps });
    const byOrg = { 1: /@agx\.test$/, 2: /@rival\.test$/ };
    expect(s.emails.length).toBeGreaterThan(3);
    s.emails.forEach((m) => {
      const org = byOrg[1].test(m.to) ? 1 : 2;
      expect([m.to, m.senderOrg.id, m.organizationId]).toEqual([m.to, org, org]);
      if (org === 1) expect([m.to, /RIVAL|Rita|ray@|R1 /.test(m.subject + m.text + m.html)]).toEqual([m.to, false]);
      else expect([m.to, /Latitude|Orphan|Paula|Marco|M1001/.test(m.subject + m.text + m.html)]).toEqual([m.to, false]);
    });
    const orphanDigest = s.emails.find((m) => m.tag === 'work_order_digest' && /Orphan work order/.test(m.text));
    expect(orphanDigest.to).toBe('creator@agx.test');
    expect(s.emails.filter((m) => /Orphan/.test(m.text)).map((m) => m.to)).not.toContain('ray@rival.test');

    const statements = eng.log.slice(before).filter((e) =>
      !/^SELECT id, name, timezone, settings FROM organizations WHERE archived_at IS NULL/.test(e.sql) &&
      !/^SELECT name FROM organizations WHERE id = \$1$/.test(e.sql) &&
      !/app_settings/.test(e.sql));
    expect(statements.length).toBeGreaterThan(20);
    statements.forEach((e) => {
      const named = /organization_id = \$\d/.test(e.sql) || /^INSERT INTO [a-z_]+ \([^)]*\borganization_id\b/.test(e.sql);
      expect([e.sql.slice(0, 90), named]).toEqual([e.sql.slice(0, 90), true]);
    });
  });
});

describe('dry runs and shutdown', () => {
  test('dry: counts what would happen and writes nothing — no claims, no sends, no fire log', async () => {
    const W = pastWeekdayMorning(3, 9);
    ticket({ id: 'due', completed_at: ago(30), updated_at: ago(30) });
    ticket({ id: 'stale', approval_notified_at: ago(30) });
    ticket({ id: 'c1', status: 'in_progress', completed_at: null });
    event({ kind: 'share_opened', share_id: null, created_at: ago(12) });
    ticket({ id: 'wait', completed_at: sqlTime(new Date(W.getTime() - 7 * DAY)), approval_notified_at: sqlTime(new Date(W.getTime() - 7 * DAY)) });
    const snapshot = () => JSON.stringify(eng.all('SELECT * FROM service_tickets ORDER BY id')) +
      JSON.stringify(eng.all('SELECT * FROM service_ticket_events ORDER BY id')) +
      JSON.stringify(eng.all('SELECT * FROM app_settings'));
    const was = snapshot();
    const s = senders();
    const out = await cron.runOnce({ dry: true, now: W, deps: s.deps });
    expect(out.dry).toBe(true);
    expect(out.approvals).toMatchObject({ released: 1, candidates: 1, retried: 0 });
    expect(out.crew).toMatchObject({ candidates: 1, batches: 0, sent: 0 });
    expect(out.digest.digests).toBeGreaterThan(0);
    expect([s.emails.length, s.pushes.length]).toEqual([0, 0]);
    expect(snapshot()).toBe(was);
  });

  test('a closing server skips the tick', async () => {
    ticket({ id: 'due', completed_at: ago(30), updated_at: ago(30) });
    inflight.beginClosing();
    const s = senders();
    const out = await cron.runOnce({ deps: s.deps });
    expect(out.skipped).toBe('closing');
    expect(s.emails).toHaveLength(0);
    expect(await cron.tick({ deps: s.deps })).toBeNull();
    expect(s.emails).toHaveLength(0);
    inflight._reset();
  });

  // A tick whose organization read waits on a gate the test opens, so a second
  // tick can be started while the first is still running.
  function gatedTick(mod) {
    let open;
    const gate = new Promise((r) => { open = r; });
    const reads = { orgs: 0 };
    const s = senders();
    s.deps.db = {
      query: async (sql, params) => {
        if (/^SELECT id, name, timezone, settings FROM organizations/.test(sql)) {
          reads.orgs++;
          if (reads.orgs === 1) await gate;
        }
        return eng.pool.query(sql, params);
      },
    };
    const first = mod.tick({ deps: s.deps });
    return { s, reads, first, open };
  }

  test('a tick already running is not started twice; once it has finished the next one runs', async () => {
    ticket({ id: 'due', completed_at: ago(30), updated_at: ago(30) });
    const g = gatedTick(cron);
    expect(g.reads.orgs).toBe(1);
    expect(await cron.tick({ deps: g.s.deps })).toBeNull();
    expect(g.reads.orgs).toBe(1);
    g.open();
    const out = await g.first;
    expect(out.approvals).toMatchObject({ candidates: 1, retried: 1 });
    expect(toldTickets()).toEqual(['due']);
    const next = await cron.tick({ deps: g.s.deps });
    expect(next).not.toBeNull();
    expect(g.reads.orgs).toBe(2);
  });

  test('MUTANT: drop the running guard and a second tick starts while the first is still running', async () => {
    const mod = mutant([[
      'if (inflight.isClosing() || running) return Promise.resolve(null);',
      'if (inflight.isClosing()) return Promise.resolve(null);',
    ]]);
    const g = gatedTick(mod);
    const second = await mod.tick({ deps: g.s.deps });
    expect(second).not.toBeNull();
    expect(g.reads.orgs).toBe(2);
    g.open();
    await g.first;
  });

  test('the fire log is a server-owned app_settings key: never served, never written over HTTP', () => {
    const keySpace = require('../server/services/app-settings-keys');
    expect(cron.LOG_KEY).toBe('work_order_notify_log');
    expect(keySpace.isDeclaredKey('work_order_notify_log')).toBe(true);
    expect(keySpace.classOf('work_order_notify_log')).toBe('internal');
    expect(keySpace.readCapabilityFor('work_order_notify_log')).toBeNull();
    expect(keySpace.writeCapabilityFor('work_order_notify_log')).toBeNull();
  });

  test('start arms unref’d timers once and stop clears them', () => {
    const realSetTimeout = global.setTimeout;
    const realSetInterval = global.setInterval;
    const armed = [];
    global.setTimeout = (fn, ms) => { const t = realSetTimeout(fn, ms); armed.push(['timeout', ms, t]); return t; };
    global.setInterval = (fn, ms) => { const t = realSetInterval(fn, ms); armed.push(['interval', ms, t]); return t; };
    try {
      cron.start();
      cron.start();
    } finally {
      global.setTimeout = realSetTimeout;
      global.setInterval = realSetInterval;
    }
    cron.stop();
    expect(armed.map((a) => [a[0], a[1]])).toEqual([['timeout', 75000], ['interval', 300000]]);
    armed.forEach((a) => expect(a[2].hasRef()).toBe(false));
  });
});
