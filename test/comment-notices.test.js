/* SOMEBODY COMMENTED AND NOBODY WAS TOLD.
 *
 * Every job, lead, proposal and photo in Project 86 has had a comment thread
 * since messaging shipped, and only a DM ever produced a notice. The write
 * worked; the telling did not exist.
 *
 * WHAT THIS FILE GUARDS, in order of how much damage the mistake does:
 *
 *   1. THE AUDIENCE IS THE CONVERSATION, NOT THE RECORD. Participants (people
 *      who have posted) plus a photo's uploader. Not the job's PM, not a
 *      capability's holders, not the org. A PM running forty jobs must not
 *      receive every comment on all of them, and the rule that decides this is
 *      the same one the inbox already uses.
 *   2. NOBODY HEARS ABOUT THEIR OWN COMMENT — and under act-as that is TWO
 *      ids, because the row is attributed to the acted-as user while the
 *      request belongs to the real admin.
 *   3. NOTHING CROSSES A TENANT. A thread key is caller-supplied, so both the
 *      participant read and the recipient read carry an org term, and the
 *      mock below reads those terms OFF THE STATEMENT — hardcoding the filter
 *      here is how two mutations stayed invisible in money-notices.test.js.
 *   4. ONE PERSON, ONE COPY. The uploader is a second audience with a
 *      different footer; being in both must not mail them twice.
 *
 * The sync caution that dominates money-notices.test.js is absent here for a
 * reason this file pins: services/clickr/* never writes `messages` and the
 * string `thread_key` does not appear in it, so Buildertrend has no door into
 * a comment thread at all.
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const path = require('path');
const { liveLine, liveLines } = require('./helpers/live-line');

let tables;
let queries;

jest.mock('../server/db', () => ({
  pool: { query: async (sql, params) => mockRunQuery(sql, params) },
}));

const sentEmail = [];
const sentPush = [];
jest.mock('../server/email', () => ({
  isEnabled: () => true,
  sendEmail: async (m) => { sentEmail.push(m); return { ok: true }; },
  sendForEvent: async () => ({ skipped: true }),
}));
jest.mock('../server/push', () => ({
  sendPush: async (userId, payload) => { sentPush.push({ userId, payload }); return { sent: 1 }; },
}));

function rowsOf(n) { return tables[n] || []; }
function orgOk(row, orgId) { return row.organization_id == null || String(row.organization_id) === String(orgId); }

function mockRunQuery(sql, params) {
  const text = String(sql).replace(/\s+/g, ' ').trim();
  const p = params || [];
  queries.push({ sql: text, params: p });

  // ── who has posted in the thread ───────────────────────────────────────
  // Both terms are read off the STATEMENT: the org predicate and the LIMIT.
  // Strip either from participantIds and a test below goes red, which is the
  // only reason this mock is worth having.
  if (/^SELECT user_id, MAX\(created_at\) AS last_at FROM messages/.test(text)) {
    const scoped = /organization_id = \$2/.test(text);
    const tolerant = /organization_id IS NULL/.test(text);
    const limited = /LIMIT \$3/.test(text);
    const mine = rowsOf('messages')
      .filter((m) => m.thread_key === p[0])
      .filter((m) => !scoped || (tolerant ? orgOk(m, p[1]) : String(m.organization_id) === String(p[1])))
      .filter((m) => m.user_id != null);
    const latest = new Map();
    for (const m of mine) {
      const at = new Date(m.created_at).getTime();
      if (!latest.has(m.user_id) || at > latest.get(m.user_id)) latest.set(m.user_id, at);
    }
    const ordered = [...latest.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => ({ user_id: id }));
    return { rows: limited ? ordered.slice(0, Number(p[2])) : ordered };
  }

  // ── the photo behind an attachment: thread ─────────────────────────────
  if (/^SELECT id, filename, entity_type, entity_id, organization_id, uploaded_by FROM attachments/.test(text)) {
    const a = rowsOf('attachments').find((x) => String(x.id) === String(p[0]));
    return { rows: a ? [a] : [] };
  }
  // attachmentInOrg rung 1 — the parent entity.
  if (/^SELECT organization_id FROM jobs WHERE id = \$1/.test(text)) {
    const j = rowsOf('jobs').find((x) => String(x.id) === String(p[0]));
    return { rows: j ? [{ organization_id: j.organization_id }] : [] };
  }
  if (/^SELECT organization_id FROM users WHERE id = \$1/.test(text)) {
    const u = rowsOf('users').find((x) => Number(x.id) === Number(p[0]));
    return { rows: u ? [{ organization_id: u.organization_id }] : [] };
  }

  // ── the recipients ────────────────────────────────────────────────────
  if (/^SELECT id, name, email, role, notification_prefs FROM users WHERE id = ANY/.test(text)) {
    const want = (p[0] || []).map(Number);
    const scoped = /organization_id = \$2/.test(text);
    const activeOnly = /active = TRUE/.test(text);
    return { rows: rowsOf('users').filter((u) => want.includes(Number(u.id))
      && (!scoped || String(u.organization_id) === String(p[1]))
      && (!activeOnly || u.active !== false)) };
  }
  if (/^SELECT notification_prefs FROM users WHERE id = \$1/.test(text)) {
    const u = rowsOf('users').find((x) => Number(x.id) === Number(p[0]));
    return { rows: u ? [{ notification_prefs: u.notification_prefs || {} }] : [] };
  }
  if (/^SELECT name FROM organizations WHERE id = \$1/.test(text)) return { rows: [{ name: 'AG Exteriors' }] };

  return { rows: [], rowCount: 0 };
}

const ORG = 1;
const OTHER_ORG = 2;

function freshTables() {
  return {
    users: [
      { id: 10, name: 'Dana',  email: 'dana@agx.test',  organization_id: ORG, active: true, notification_prefs: {} },
      { id: 11, name: 'Mo',    email: 'mo@agx.test',    organization_id: ORG, active: true, notification_prefs: {} },
      { id: 12, name: 'Sam',   email: 'sam@agx.test',   organization_id: ORG, active: true, notification_prefs: {} },
      { id: 13, name: 'Reza',  email: 'reza@agx.test',  organization_id: ORG, active: true, notification_prefs: {} },
      // The job's PM, who has never posted in the thread.
      { id: 14, name: 'Pat',   email: 'pat@agx.test',   organization_id: ORG, active: true, notification_prefs: {} },
      { id: 90, name: 'Elsewhere', email: 'nope@other.test', organization_id: OTHER_ORG, active: true, notification_prefs: {} },
    ],
    jobs: [
      { id: 'j1', owner_id: 14, organization_id: ORG },
      { id: 'jOther', owner_id: 90, organization_id: OTHER_ORG },
    ],
    attachments: [
      // Mo's photo on Dana's job. Mo has NOT posted in its thread.
      { id: 'att_1', filename: 'north-elevation.jpg', entity_type: 'job', entity_id: 'j1', organization_id: ORG, uploaded_by: 11 },
      // Another tenant's photo, reachable only by guessing the id.
      { id: 'att_other', filename: 'secret.jpg', entity_type: 'job', entity_id: 'jOther', organization_id: OTHER_ORG, uploaded_by: 90 },
    ],
    messages: [
      { thread_key: 'job:j1', user_id: 12, organization_id: ORG, created_at: '2026-09-28T10:00:00Z' },
      { thread_key: 'job:j1', user_id: 13, organization_id: ORG, created_at: '2026-09-29T10:00:00Z' },
      { thread_key: 'job:j1', user_id: 10, organization_id: ORG, created_at: '2026-09-30T10:00:00Z' },
    ],
  };
}

const notices = require('../server/services/comment-notices');
const db = { query: mockRunQuery };

beforeEach(() => {
  tables = freshTables();
  queries = [];
  sentEmail.length = 0;
  sentPush.length = 0;
  notices._resetBurst();
});

const to = () => sentEmail.map((m) => m.to).sort();
const pushedTo = () => sentPush.map((x) => x.userId).sort();

function post(over) {
  return notices.notifyThreadComment(db, Object.assign({
    key: 'job:j1',
    orgId: ORG,
    actorIds: [10],
    actorName: 'Dana',
    body: 'Soffit on the north side is short two sticks.',
    label: '1042 · River Landing',
  }, over || {}));
}

/* ═══════════════════════════════════════════════════════════════════════════
 * WHO HEARS IT
 * ══════════════════════════════════════════════════════════════════════════*/
describe('who hears a comment', () => {
  test('the people in the conversation — and not the job’s PM, who never posted', async () => {
    const r = await post();
    // Sam and Reza have posted. Dana wrote this one. Pat runs the job and has
    // said nothing in the thread, so Pat is not in the conversation.
    expect(to()).toEqual(['reza@agx.test', 'sam@agx.test']);
    expect(r.sent).toBe(2);
  });

  test('nobody hears about their own comment', async () => {
    await post({ actorIds: [12], actorName: 'Sam' });
    // Dana and Reza both posted and both hear it; Sam wrote this one.
    expect(to()).toEqual(['dana@agx.test', 'reza@agx.test']);
    expect(to()).not.toContain('sam@agx.test');
  });

  test('under act-as BOTH ids are dropped: the admin and the person they are acting as', async () => {
    // The row is attributed to Sam (12); the request is admin Dana's (10).
    // Either id surviving would mail somebody about a comment they just made.
    await post({ actorIds: [10, 12], actorName: 'Sam' });
    expect(to()).toEqual(['reza@agx.test']);
  });

  test('a participant whose message row belongs to another tenant is not told', async () => {
    // A forged or legacy row sitting under this thread key. The org term on
    // the participant read is what keeps its author out of the audience.
    tables.messages.push({ thread_key: 'job:j1', user_id: 90, organization_id: OTHER_ORG, created_at: '2026-09-30T11:00:00Z' });
    await post();
    expect(to()).toEqual(['reza@agx.test', 'sam@agx.test']);
  });

  /* THE TWO LAYERS, EACH TESTED WHERE THE OTHER CANNOT SAVE IT.
   *
   * The participant read and the recipient read both carry an org term, and
   * mutation showed that either one alone keeps every obvious case green: strip
   * the term from one and the other still filtered the same person out. That is
   * good defence and a bad test, so these two name the exact row shape that
   * only one layer can catch. Found by mutating services/comment-notices.js,
   * not by reading it. */
  test('a foreign user reached through an UNSTAMPED row is stopped by the recipient read', async () => {
    // organization_id IS NULL is tolerated by the participant read on purpose
    // (pre-backfill rows), so this id gets all the way to the users lookup.
    // The org term THERE is the only thing between it and another tenant's
    // mailbox.
    tables.messages.push({ thread_key: 'job:j1', user_id: 90, organization_id: null, created_at: '2026-09-30T11:00:00Z' });
    await post();
    expect(to()).toEqual(['reza@agx.test', 'sam@agx.test']);
    expect(to()).not.toContain('nope@other.test');
  });

  test('a row stamped to another tenant does not make its author a participant HERE', async () => {
    // Mo is in this organisation, so the recipient read would happily mail
    // them — the row is what is foreign, not the person. Only the org term on
    // the participant read can tell.
    tables.messages.push({ thread_key: 'job:j1', user_id: 11, organization_id: OTHER_ORG, created_at: '2026-09-30T11:00:00Z' });
    await post();
    expect(to()).toEqual(['reza@agx.test', 'sam@agx.test']);
    expect(to()).not.toContain('mo@agx.test');
  });

  test('an unstamped message row still counts — rows written before the backfill', async () => {
    tables.messages.push({ thread_key: 'job:j1', user_id: 11, organization_id: null, created_at: '2026-09-27T10:00:00Z' });
    await post();
    expect(to()).toEqual(['mo@agx.test', 'reza@agx.test', 'sam@agx.test']);
  });

  test('a deactivated teammate is skipped', async () => {
    tables.users.find((u) => u.id === 13).active = false;
    await post();
    expect(to()).toEqual(['sam@agx.test']);
  });

  test('nobody left to tell is not an error', async () => {
    tables.messages = [{ thread_key: 'job:j1', user_id: 10, organization_id: ORG, created_at: '2026-09-30T10:00:00Z' }];
    const r = await post();
    expect([r.sent, r.skipped]).toEqual([0, 'nobody']);
    expect(sentEmail.length).toBe(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE PHOTO'S UPLOADER — the whole reason photo comments work
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a comment on a photo', () => {
  test('reaches the uploader, who has never posted in the thread', async () => {
    // att_1 has NO messages at all: this is the first comment on the photo,
    // which is the only comment that matters. A participants-only rule would
    // have told nobody.
    const r = await notices.notifyThreadComment(db, {
      key: 'attachment:att_1', orgId: ORG, actorIds: [10], actorName: 'Dana',
      body: 'This is the corner I meant.',
    });
    expect(to()).toEqual(['mo@agx.test']);
    expect(r.sent).toBe(1);
  });

  test('the uploader is told WHY, and it is a true statement about them', async () => {
    await notices.notifyThreadComment(db, {
      key: 'attachment:att_1', orgId: ORG, actorIds: [10], actorName: 'Dana',
      body: 'This is the corner I meant.',
    });
    expect(sentEmail[0].text).toContain('because you uploaded this photo');
    expect(sentEmail[0].text).not.toContain('because you have posted');
  });

  test('an uploader who has also posted gets ONE copy, not two', async () => {
    tables.messages.push({ thread_key: 'attachment:att_1', user_id: 11, organization_id: ORG, created_at: '2026-09-29T09:00:00Z' });
    await notices.notifyThreadComment(db, {
      key: 'attachment:att_1', orgId: ORG, actorIds: [10], actorName: 'Dana', body: 'Agreed.',
    });
    expect(to()).toEqual(['mo@agx.test']);
    expect(sentEmail.length).toBe(1);
    // and the footer is the participant one, because that is how they joined
    expect(sentEmail[0].text).toContain('because you have posted in this conversation');
  });

  test('the uploader of ANOTHER tenant’s photo is never told, however the id was guessed', async () => {
    const r = await notices.notifyThreadComment(db, {
      key: 'attachment:att_other', orgId: ORG, actorIds: [10], actorName: 'Dana', body: 'hello',
    });
    expect(sentEmail.length).toBe(0);
    expect(r.sent).toBe(0);
  });

  test('a forged thread on a foreign photo leaks neither its name nor its job', async () => {
    // threadInOrg's last rung admits a thread that has its own messages, so a
    // comment posted under a GUESSED attachment id reaches this notice with
    // real in-org participants behind it. The ladder is then the only thing
    // standing between another tenant's file name — a name somebody typed —
    // and a subject line, and between their job id and a link.
    tables.messages.push({ thread_key: 'attachment:att_other', user_id: 12, organization_id: ORG, created_at: '2026-09-29T10:00:00Z' });
    await notices.notifyThreadComment(db, {
      key: 'attachment:att_other', orgId: ORG, actorIds: [10], actorName: 'Dana', body: 'what is this?',
    });
    expect(to()).toEqual(['sam@agx.test']);          // the in-org poster, who is real
    expect(sentEmail[0].subject).toBe('New comment on Photo att_other');
    expect(sentEmail[0].text).not.toContain('secret.jpg');
    expect(sentEmail[0].text).not.toContain('jOther');
    expect(to()).not.toContain('nope@other.test'); // and never the foreign uploader
  });

  test('the subject names the FILE, read here rather than trusted from the caller', async () => {
    // 86's tool (add_photo_comment) passes no label at all; the file name has
    // to come off the row, behind the same org ladder.
    await notices.notifyThreadComment(db, {
      key: 'attachment:att_1', orgId: ORG, actorIds: [10], actorName: 'Dana',
      body: 'x', label: 'a label the caller made up',
    });
    expect(sentEmail[0].subject).toBe('New comment on north-elevation.jpg');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * WHAT THE MESSAGE SAYS AND WHERE IT GOES
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the message', () => {
  test('carries the comment itself, the record, and the person who wrote it', async () => {
    await post();
    const m = sentEmail[0];
    expect(m.subject).toBe('New comment on 1042 · River Landing');
    expect(m.text).toContain('Dana left a comment on this job.');
    expect(m.text).toContain('Soffit on the north side is short two sticks.');
    expect(m.html).toContain('Dana commented on this job');
  });

  test('a job comment links to the Comments tab this slice built', async () => {
    await post();
    expect(sentEmail[0].text).toContain('/jobs/j1/job-comments');
  });

  test('a photo comment links to the Photos tab of the job the photo hangs on', async () => {
    await notices.notifyThreadComment(db, {
      key: 'attachment:att_1', orgId: ORG, actorIds: [10], actorName: 'Dana', body: 'x',
    });
    expect(sentEmail[0].text).toContain('/jobs/j1/job-photos');
  });

  test('a lead or proposal thread, which has no per-record URL, goes to Messages', async () => {
    tables.messages.push({ thread_key: 'lead:L9', user_id: 12, organization_id: ORG, created_at: '2026-09-29T10:00:00Z' });
    await post({ key: 'lead:L9', label: 'Citi Lakes rewrap' });
    expect(sentEmail[0].text).toContain('/messages');
    expect(sentEmail[0].text).toContain('this lead');
  });

  test('an unknown name does not become the word "undefined"', async () => {
    await post({ actorName: null });
    expect(sentEmail[0].text).toContain('A teammate left a comment');
    expect(sentEmail[0].text).not.toMatch(/undefined|null/);
  });

  test('one notification per thread on the phone — a second comment replaces the first', async () => {
    await post();
    expect(sentPush.length).toBe(2);
    expect(sentPush.every((x) => x.payload.tag === 'comment_posted:job:j1')).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE SWITCHES IN MY ACCOUNT
 * ══════════════════════════════════════════════════════════════════════════*/
describe('preferences', () => {
  test('email off, push on — the push still goes', async () => {
    tables.users.find((u) => u.id === 12).notification_prefs = { comment_posted: false };
    await post();
    expect(to()).toEqual(['reza@agx.test']);
    expect(pushedTo()).toEqual([12, 13]);
  });

  test('both off — that person is not even composed for', async () => {
    tables.users.find((u) => u.id === 12).notification_prefs = { comment_posted: false, push: { comment_posted: false } };
    await post();
    expect(to()).toEqual(['reza@agx.test']);
    expect(pushedTo()).toEqual([13]);
  });

  test('the catalog carries the switch, or there is nothing to turn off', () => {
    const { NOTIFY_EVENTS } = require('../server/notify-events');
    const row = NOTIFY_EVENTS.find((e) => e.key === notices.KEY);
    expect(row).toBeTruthy();
    expect(row.channels).toEqual({ email: true, push: true });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * LIMITS
 * ══════════════════════════════════════════════════════════════════════════*/
describe('limits', () => {
  test('an old thread with a crowd tells at most PARTICIPANT_CAP people, newest talkers first', async () => {
    tables.users = [{ id: 10, name: 'Dana', email: 'dana@agx.test', organization_id: ORG, active: true, notification_prefs: {} }];
    tables.messages = [];
    // 14 posters, oldest first. The cap is applied in SQL, so the ten most
    // recent are the ones that come back.
    for (let i = 1; i <= 14; i++) {
      tables.users.push({ id: 100 + i, name: 'U' + i, email: 'u' + i + '@agx.test', organization_id: ORG, active: true, notification_prefs: {} });
      tables.messages.push({ thread_key: 'job:j1', user_id: 100 + i, organization_id: ORG, created_at: '2026-09-' + String(i).padStart(2, '0') + 'T10:00:00Z' });
    }
    const r = await post();
    expect(r.sent).toBe(notices.PARTICIPANT_CAP);
    expect(to()).toContain('u14@agx.test');   // posted yesterday
    expect(to()).not.toContain('u1@agx.test'); // posted a fortnight ago
  });

  test('a paste storm in one thread stops at BURST_CAP within the minute', async () => {
    const now = Date.parse('2026-09-30T12:00:00Z');
    let allowed = 0;
    for (let i = 0; i < notices.BURST_CAP + 3; i++) {
      const r = await post({ now: now + i * 10 });
      if (!r.skipped) allowed++;
    }
    expect(allowed).toBe(notices.BURST_CAP);
  });

  test('the cap is per thread, so two conversations never starve each other', async () => {
    const now = Date.parse('2026-09-30T12:00:00Z');
    tables.messages.push({ thread_key: 'job:j2', user_id: 12, organization_id: ORG, created_at: '2026-09-29T10:00:00Z' });
    for (let i = 0; i < notices.BURST_CAP; i++) await post({ now: now + i });
    const other = await post({ key: 'job:j2', now: now + 99 });
    expect(other.skipped).toBeUndefined();
  });

  test('an empty comment notifies nobody', async () => {
    const r = await post({ body: '   ' });
    expect([r.sent, r.skipped]).toEqual([0, 'empty']);
  });

  test('a dm: key is refused here — notifyMessageDM owns those, and one comment is one notice', async () => {
    const r = await notices.notifyThreadComment(db, {
      key: 'dm:10:12', orgId: ORG, actorIds: [10], actorName: 'Dana', body: 'hi',
    });
    expect([r.sent, r.skipped]).toEqual([0, 'dm']);
    expect(sentEmail.length).toBe(0);
  });

  test('a caller with no organisation sends nothing', async () => {
    const r = await post({ orgId: null });
    expect([r.sent, r.skipped]).toEqual([0, 'no_org']);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE TWO DOORS, AND THE ONE THAT DOES NOT EXIST
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the doors that post a comment', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

  test('the human door notifies, and does it for entity threads only', () => {
    const src = read('server/routes/message-routes.js');
    expect(liveLines(src, 'notifyThreadComment(pool, {').length).toBe(1);
    // The DM path must not reach it: notifyMessageDM already mailed that
    // person, and the guard is what keeps one comment from being two notices.
    expect(liveLine(src, 'if (!isDm) {')).toBe(true);
    // Both ids, not one. The act-as case is the whole reason this is a list.
    expect(liveLines(src, 'actorIds: [req.user.id, authorId]').length).toBe(1);
  });

  test('86’s own add_photo_comment notifies too — it wrote and told nobody', () => {
    const src = read('server/routes/ai-routes.js');
    expect(liveLines(src, "require('../services/comment-notices')").length).toBe(1);
    expect(liveLines(src, 'actorIds: [userId]').length).toBe(1);
  });

  test('both notices are handed to inflight, so a deploy does not drop them', () => {
    expect(liveLines(read('server/routes/message-routes.js'), 'inflight.track(').length).toBeGreaterThan(0);
    expect(liveLines(read('server/routes/ai-routes.js'), "require('../services/inflight').track(").length).toBe(1);
  });

  test('the Buildertrend sync has no door into a comment thread at all', () => {
    const dir = path.join(__dirname, '..', 'server', 'services', 'clickr');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
    expect(files.length).toBeGreaterThan(3);
    const offenders = [];
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      // Not "it must not call the notifier" but the stronger claim the module
      // header makes: the sync does not touch this table, so there is nothing
      // to key a notice off. If that ever changes, the notice needs the same
      // route-boundary discipline the money notices have.
      if (/thread_key|comment-notices/.test(src)) offenders.push('server/services/clickr/' + f);
    }
    expect(offenders).toEqual([]);
  });
});
