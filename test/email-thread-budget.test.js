// WHAT ONE TOOL CALL IS ALLOWED TO COST, HELD AT THE DOOR.
//
// ── THE SHAPE OF THE DEFECT ───────────────────────────────────────────────
// read_email_inbox's thread arm had three ceilings that MULTIPLIED:
//
//   messages      ORDER BY received_at DESC LIMIT 100
//   each body     .slice(0, 6000)
//   attachments   up to 8 per message, .slice(0, 4000) each
//
// 100 × 6,000 + 8 × 4,000 ≈ 632,000 chars ≈ 158,000 tokens, from one call —
// and then carried on every later turn of that conversation, because a tool
// result stays in the transcript. Each cut was silent, so the worst part was
// not the cost: a 400-message thread came back as 100 messages with a header
// that said "100 message(s)", and a model that reads that will summarise it as
// the whole conversation.
//
// ── WHY THE ASSERTIONS LOOK LIKE THIS ─────────────────────────────────────
// A budget is easy to test wrongly. "The answer is shorter" passes for an
// allocator that keeps the OLDEST messages, which bounds the cost and throws
// away the only message anybody asked about. So the tests that matter here are
// about DIRECTION and HONESTY, not length:
//
//   B1  bounded — and the fixture states the unbudgeted size itself, from its
//       own rows, rather than trusting arithmetic in a comment.
//   B2  the answer SAYS it is partial, with counts and the way to get the rest.
//   B3  the kept messages are the NEWEST. (Mutant: allocate from the start.)
//   B4  every message keeps its header line, so the shape of the conversation
//       survives the budget — who wrote when, in order.
//   B5  the reopen path actually delivers: message=N returns that message in
//       full, under the thread's own numbering.
//   B6  an out-of-range message is refused BY NUMBER, never by silently
//       falling back to the whole thread.
//   B7  the >100 ceiling is named, with the real total.
//   B8  a thread small enough to fit is untouched — this change must not take
//       anything away from what 86 reads today.
//   B9  attachment text has its own budget, and the lazy OCR ceiling is spent
//       NEWEST FIRST. (Mutant: the shipped oldest-first walk, which paid to
//       extract the 8 least relevant files on any long thread.)
//   B10 a file the OCR ceiling never opened says so, instead of reporting
//       itself as a file with no text in it.
//   B11 when the count query fails, the header says so instead of restating
//       r.rows.length as the total — the degradation is reported, not hidden.
//
// The engine is installed on globalThis BEFORE ai-routes is required, because
// that module DESTRUCTURES `pool` at load.

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');
const BUDGET = require('../server/services/read-result-budget');

const TABLES = [
  'organizations', 'roles', 'users',
  'inbound_emails', 'email_folders', 'email_labels', 'email_message_labels',
  'email_attachments',
];

const engine = createPgSqlite(sqliteSchema(TABLES), {
  jsonColumns: ['capabilities', 'notification_prefs'],
  dateColumns: ['updated_at', 'created_at', 'received_at', 'snoozed_until'],
});
globalThis.__P86_EMAIL_BUDGET_ENGINE__ = engine;
jest.mock('../server/db', () => ({ pool: globalThis.__P86_EMAIL_BUDGET_ENGINE__.pool }));

// The lazy OCR resolver, recording WHICH files it was asked to read and in
// WHAT ORDER. B9 is a claim about that order and nothing else can observe it:
// the printed answer looks the same whether the 8 files read were the newest or
// the oldest, as long as some of them had text.
globalThis.__P86_RESOLVED__ = [];
jest.mock('../server/services/email-attachment-text', () => ({
  resolveEmailAttachmentText: async (a) => {
    globalThis.__P86_RESOLVED__.push(a.id);
    return 'LAZY-' + a.id + ' ' + 'y'.repeat(300);
  },
}));

const { setRolePool, refreshRoleCache } = require('../server/auth');
const aiRoutes = require('../server/routes/ai-routes');
const { execAgentTool, execStaffTool } = aiRoutes.internals;

const ORG = 1;
const UID = 10;
const USER = { id: UID, email: 'owner@a.test', role: 'admin', name: 'Owner', organization_id: ORG };

// ── the fixture ───────────────────────────────────────────────────────────
// Bodies carry a token at BOTH ends, so an assertion can tell "this message is
// here" from "this message is here IN FULL". A body that only ever carried a
// leading token would make a clipped message and a whole one look identical.
const tok = (p, n) => p + String(n).padStart(3, '0');
function body(p, n, size) {
  const head = tok(p, n) + '-BEGIN ';
  const tail = ' ' + tok(p, n) + '-END';
  return head + 'x'.repeat(Math.max(0, size - head.length - tail.length)) + tail;
}
// Minute-resolution timestamps, so received_at orders the thread the way the
// message numbers do and the newest message is unambiguous.
const when = (n) => {
  const h = 10 + Math.floor(n / 60);
  return '2026-09-01 ' + String(h).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0') + ':00';
};

const em = () => engine.db.prepare(
  `INSERT INTO inbound_emails
     (id, organization_id, user_id, thread_id, from_name, from_email, orig_from_email,
      subject, body_text, direction, received_at, folder_id, ai_category,
      needs_reply, triage_summary, has_attachments, is_forward_wrapper, delivered_direct)
   VALUES (?,?,?,?,?,?,?,?,?,'inbound',?,NULL,NULL,0,NULL,?,0,0)`);
const ea = () => engine.db.prepare(
  `INSERT INTO email_attachments
     (id, email_id, user_id, organization_id, filename, mime_type, size_bytes, storage_key, extracted_text)
   VALUES (?,?,?,?,?,?,?,?,?)`);

// Every thread's shape, declared once so the assertions can read the numbers
// off the fixture instead of repeating them.
const SHORT_N = 2;        // fits the budget whole — B8
const LONG_N = 40;        // 39 bodies of 6,000 + one of 9,000 — B1-B5
const LONG_BIG = 9000;    // > THREAD_BODY_MAX_PER_MESSAGE, so one body is CUT
const HUGE_N = 105;       // past the 100-row ceiling — B7
const ATT_N = 6;          // 6 files × 5,000 chars > the 16,000 text budget — B9
const LAZY_N = 12;        // 12 files, ATT_MAX is 8 — B9/B10

function seed() {
  engine.db.exec(`
    DELETE FROM email_message_labels; DELETE FROM email_labels;
    DELETE FROM email_attachments; DELETE FROM inbound_emails;
    DELETE FROM email_folders; DELETE FROM users; DELETE FROM roles;
    DELETE FROM organizations;
    INSERT INTO organizations (id, name) VALUES (1, 'Org A');
    INSERT INTO users (id, email, name, role, organization_id) VALUES
      (10, 'owner@a.test', 'Owner', 'admin', 1);
    INSERT INTO roles (name, label, capabilities) VALUES
      ('admin', 'Admin', '["ESTIMATES_VIEW","ESTIMATES_EDIT","FINANCIALS_VIEW","JOBS_VIEW","LEADS_VIEW","CLIENTS_VIEW","SUBS_VIEW","FILES_VIEW","TASKS_VIEW"]');
  `);
  const ins = em();
  const insA = ea();
  for (let n = 1; n <= SHORT_N; n++) {
    ins.run('s' + n, ORG, UID, 'th_short', 'Client', 'c@client.test', null,
      'Short thread', body('S', n, 6000), when(n), 0);
  }
  for (let n = 1; n <= LONG_N; n++) {
    ins.run('l' + n, ORG, UID, 'th_long', 'Client', 'c@client.test', null,
      'Long thread', body('L', n, n === LONG_N ? LONG_BIG : 6000), when(n), 0);
  }
  for (let n = 1; n <= HUGE_N; n++) {
    ins.run('h' + n, ORG, UID, 'th_huge', 'Client', 'c@client.test', null,
      'Huge thread', body('H', n, 120), when(n), 0);
  }
  for (let n = 1; n <= ATT_N; n++) {
    ins.run('a' + n, ORG, UID, 'th_atts', 'Client', 'c@client.test', null,
      'Attachment thread', body('A', n, 200), when(n), 1);
    // extracted_text already cached, so this thread measures the TEXT budget
    // without involving the OCR ceiling.
    insA.run('ea-a' + n, 'a' + n, UID, ORG, 'file-' + n + '.pdf', 'application/pdf', 2048,
      'k/a' + n, 'ATT-A' + n + ' ' + 'z'.repeat(5000));
  }
  for (let n = 1; n <= LAZY_N; n++) {
    ins.run('z' + n, ORG, UID, 'th_lazy', 'Client', 'c@client.test', null,
      'Lazy thread', body('Z', n, 200), when(n), 1);
    // extracted_text NULL — never attempted, so the arm will call the resolver.
    insA.run('ea-z' + n, 'z' + n, UID, ORG, 'scan-' + n + '.pdf', 'application/pdf', 4096,
      'k/z' + n, null);
  }
  setRolePool(engine.pool);
  return refreshRoleCache();
}

const ctx = () => ({ userId: UID, orgId: ORG, user: USER });
const flat = (v) => (v == null ? '' : (typeof v === 'string' ? v : JSON.stringify(v)));

// Both executor doors. They are different functions with different gates in
// front of them, and a budget that only holds on one of them does not hold.
const DOORS = [
  ['execAgentTool', (input) => execAgentTool('read_email_inbox', input, ctx())],
  ['execStaffTool', (input) => execStaffTool('read_email_inbox', input, ctx())],
];
async function read(input, door) {
  const run = door || DOORS[0][1];
  let out;
  try { out = await run(input); } catch (e) { out = 'THREW: ' + (e && e.message); }
  return flat(out);
}

// What the thread would have cost with no budget — summed from the rows
// themselves, so the before-number is a measurement and not a claim.
function rawBodyChars(threadId) {
  const r = engine.db.prepare(
    'SELECT body_text FROM inbound_emails WHERE thread_id = ? ORDER BY received_at DESC LIMIT 100'
  ).all(threadId);
  return r.reduce((n, x) => n + String(x.body_text || '').length, 0);
}

beforeEach(() => { globalThis.__P86_RESOLVED__.length = 0; engine.log.length = 0; return seed(); });

describe('the fixture can actually catch this', () => {
  test('the long thread really is enormous before the budget', () => {
    // 39 × 6,000 + 9,000 = 243,000 chars of body, ~61,000 tokens of email in
    // ONE tool result under the old code, before attachments.
    expect(rawBodyChars('th_long')).toBe(243000);
    expect(rawBodyChars('th_long')).toBeGreaterThan(BUDGET.THREAD_BODY_BUDGET * 5);
  });

  test('the huge thread is past the 100-row ceiling, so the ceiling is reachable', () => {
    const n = engine.db.prepare('SELECT COUNT(*) AS n FROM inbound_emails WHERE thread_id = ?').get('th_huge').n;
    expect(n).toBe(HUGE_N);
    expect(n).toBeGreaterThan(100);
  });

  test('the attachment thread exceeds the text budget, so the text budget is reachable', () => {
    expect(ATT_N * 5000).toBeGreaterThan(BUDGET.ATTACHMENT_TEXT_BUDGET);
  });
});

describe.each(DOORS)('read_email_inbox thread arm — %s', (label, door) => {
  test('B1 the answer is bounded to a fraction of the thread', async () => {
    const out = await read({ thread_id: 'th_long' }, door);
    expect(out).not.toMatch(/THREW/);
    // The bodies alone were 243,000 chars. The whole answer — headers,
    // wrappers, notices and all — now comes in under a quarter of that.
    expect(out.length).toBeLessThan(rawBodyChars('th_long') / 4);
    expect(out.length).toBeLessThan(80000);
  });

  test('B2 it says it is not all of it, with the counts and the way back', async () => {
    const out = await read({ thread_id: 'th_long' }, door);
    expect(out).toContain('THIS IS NOT ALL OF IT');
    expect(out).toContain('243,000 chars available');
    expect(out).toContain('48,000 kept');
    expect(out).toContain('1 message body cut short');
    expect(out).toContain('32 message bodies left out entirely');
    expect(out).toContain('OLDEST');
    expect(out).toContain('Do not describe this as the complete conversation');
    // The reopen instruction names this thread and the parameter by name.
    expect(out).toContain('thread_id="th_long"');
    expect(out).toContain('message=N');
  });

  test('B3 the messages it kept are the NEWEST', async () => {
    // MUTANT: allocating from the start of the list instead of the end. The
    // answer is just as short, just as loud, and about the wrong eight
    // messages. 48,000 chars buys the 9,000-char newest (cut to 6,000) plus
    // seven whole ones, so 33-40 survive and 1-32 do not.
    const out = await read({ thread_id: 'th_long' }, door);
    expect(out).toContain('L040-BEGIN');
    expect(out).toContain('L039-BEGIN');
    expect(out).toContain('L033-BEGIN');
    expect(out).not.toContain('L032-BEGIN');
    expect(out).not.toContain('L001-BEGIN');
    // The newest body is over the per-message cap, so it is CUT, not whole —
    // and that is visible rather than inferred.
    expect(out).not.toContain('L040-END');
    expect(out).toContain('cut short: 6,000 of 9,000 chars');
    expect(out).toContain('message=40 reads it in full');
    // A body that fits is printed whole.
    expect(out).toContain('L039-END');
  });

  test('B4 every message keeps its header, so the shape of the thread survives', async () => {
    const out = await read({ thread_id: 'th_long' }, door);
    const headers = (out.match(/── Message \d+ ·/g) || []).length;
    expect(headers).toBe(LONG_N);
    // And an omitted body is marked as absent where its text would be, rather
    // than leaving a header with nothing under it.
    expect(out).toContain('body left out to stay in budget');
    expect(out).toContain('6,000 chars not shown');
  });

  test('B5 message=N returns that message in full, under the THREAD numbering', async () => {
    const out = await read({ thread_id: 'th_long', message: 40 }, door);
    expect(out).toContain('Showing MESSAGE 40 only');
    // The reopen path delivers what the notice promised: the body the thread
    // view had to cut is here whole.
    expect(out).toContain('L040-BEGIN');
    expect(out).toContain('L040-END');
    expect(out).not.toContain('THIS IS NOT ALL OF IT');
    // MUTANT: renumbering the single message to 1. "Message 3" has to mean the
    // same thing in both answers or the reopen path points at the wrong row.
    expect(out).toContain('── Message 40 ·');
    expect(out).not.toContain('── Message 1 ·');
    expect(out).not.toContain('L039-BEGIN');
  });

  test('B5 a message from the middle comes back whole too', async () => {
    const out = await read({ thread_id: 'th_long', message: 3 }, door);
    expect(out).toContain('── Message 3 ·');
    expect(out).toContain('L003-BEGIN');
    expect(out).toContain('L003-END');
    expect(out).not.toContain('L004-BEGIN');
    expect(out).toContain('the other 39 message(s) of this thread are not in this answer'.replace('the other', 'The other'));
  });

  test('B6 an out-of-range message is refused by number, not answered with the thread', async () => {
    // MUTANT: `if (oneMessage)` with a silent fallback. A model that asked for
    // message 99 and got all 40 back learns nothing about what it just paid
    // for, and the refusal it needed to read never happened.
    const out = await read({ thread_id: 'th_long', message: 99 }, door);
    expect(out).toContain('numbered 1-40');
    expect(out).toContain('There is no message 99');
    expect(out).not.toContain('L040-BEGIN');
    expect(out.length).toBeLessThan(400);
  });

  test('B6 zero and non-numbers are refused the same way', async () => {
    for (const m of [0, -4, 'abc', {}]) {
      const out = await read({ thread_id: 'th_long', message: m }, door);
      expect(out).toMatch(/There is no message/);
      expect(out).not.toContain('L040-BEGIN');
    }
  });

  test('B7 the 100-row ceiling is named, with the real total', async () => {
    // MUTANT: the shipped header, which printed r.rows.length as the count. A
    // 105-message thread read as "100 message(s)" is not a truncated answer,
    // it is a wrong one.
    const out = await read({ thread_id: 'th_huge' }, door);
    expect(out).toContain('100 message(s) in this answer');
    expect(out).toContain('the thread has 105');
    expect(out).toContain('NEWEST 100');
    expect(out).toContain('do not describe this as the whole conversation');
    // The five oldest are genuinely gone, which is what the header now admits.
    expect(out).not.toContain('H001-BEGIN');
    expect(out).not.toContain('H005-BEGIN');
    expect(out).toContain('H006-BEGIN');
    expect(out).toContain('H105-BEGIN');
  });

  test('B8 a thread that fits is untouched — nothing was taken away', async () => {
    const out = await read({ thread_id: 'th_short' }, door);
    expect(out).toContain('2 message(s) in this answer');
    expect(out).not.toContain('THIS IS NOT ALL OF IT');
    expect(out).not.toContain('cut short');
    expect(out).not.toContain('left out to stay in budget');
    // Both bodies, whole, both ends present.
    expect(out).toContain('S001-BEGIN');
    expect(out).toContain('S001-END');
    expect(out).toContain('S002-BEGIN');
    expect(out).toContain('S002-END');
    expect(out).not.toContain('the thread has');
  });

  test('B9 attachment text has its own budget, spent newest-first', async () => {
    const out = await read({ thread_id: 'th_atts' }, door);
    // 6 files × 5,000 chars of cached text = 30,000, against a 16,000 budget
    // with 4,000 per file: the four newest are served, the two oldest are not.
    expect(out).toContain('ATT-A6');
    expect(out).toContain('ATT-A5');
    expect(out).toContain('ATT-A4');
    expect(out).toContain('ATT-A3');
    expect(out).not.toContain('ATT-A2');
    expect(out).not.toContain('ATT-A1');
    expect(out).toContain('text held back to stay in budget');
    expect(out).toContain('attachment text left out to stay in budget');
    expect(out).toContain('4,000 of 5,0');   // each served file was cut to 4,000
    // The bodies are tiny here, so the ONLY notice is the attachment one —
    // proof the two budgets are separate and a big PDF cannot evict bodies.
    expect(out).toContain('set of attachments');
    expect(out).not.toContain('message bodies left out entirely');
  });

  test('B9 the lazy OCR ceiling is spent on the NEWEST files', async () => {
    // MUTANT: the shipped oldest-first walk. On any long thread it paid to
    // OCR the 8 least relevant files and reported the newest — this morning's
    // invoice — as having no readable text.
    await read({ thread_id: 'th_lazy' }, door);
    const got = globalThis.__P86_RESOLVED__;
    expect(got.length).toBe(8);
    expect(got).toEqual(['ea-z12', 'ea-z11', 'ea-z10', 'ea-z9', 'ea-z8', 'ea-z7', 'ea-z6', 'ea-z5']);
    expect(got).not.toContain('ea-z1');
  });

  test('B10 a file the ceiling never opened says so, and is not called empty', async () => {
    const out = await read({ thread_id: 'th_lazy' }, door);
    expect(out).toContain('LAZY-ea-z12');
    expect(out).toContain('NOT READ: the 8-file extraction limit');
    expect(out).toContain('do NOT report it as empty');
    // The four it could not reach name the message that would extract them.
    expect(out).toContain('message=1) to extract it');
    // "no readable text extracted" is now reserved for a file that WAS read
    // and had nothing — and no file in this fixture is that.
    expect(out).not.toContain('no readable text extracted');
  });
});

describe('B11 when the count fails, the header says so', () => {
  test('the failure is printed, not degraded into a smaller total', async () => {
    // MUTANT: `catch { threadTotal = r.rows.length }` — the shape I have
    // shipped before and been caught by. It restates exactly the lie the loud
    // header exists to stop, and no assertion on a happy path can see it.
    const real = engine.pool.query.bind(engine.pool);
    engine.pool.query = async (sql, params) => {
      if (/COUNT\(\*\)::int AS n\s+FROM inbound_emails/i.test(String(sql))) {
        throw new Error('relation "inbound_emails" is unavailable');
      }
      return real(sql, params);
    };
    try {
      const out = await read({ thread_id: 'th_huge' });
      expect(out).toContain('could not count the full thread');
      expect(out).toContain('is unavailable');
      expect(out).toContain('may hold more than these');
      // And it does NOT assert a total it does not have.
      expect(out).not.toContain('the thread has 105');
      expect(out).not.toContain('the thread has 100');
    } finally {
      engine.pool.query = real;
    }
  });
});

describe('the list arm is untouched by any of this', () => {
  test('it still lists threads, with no budget notice', async () => {
    const out = await read({});
    expect(out).not.toMatch(/THREW/);
    expect(out).toContain('th_long');
    expect(out).not.toContain('THIS IS NOT ALL OF IT');
  });
});
