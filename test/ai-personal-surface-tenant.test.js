// A PERSONAL SURFACE IS STILL A TENANT BOUNDARY.
//
// ── THE PREMISE THAT WAS FALSE ────────────────────────────────────────────
// Two agent tools scoped themselves by a USER ID and treated that as proof of
// tenancy. search_my_kb wrote the claim down as a comment:
//
//   "Cross-tenant access is blocked implicitly because uploads outside the
//    user's org would never have uploaded_by set to them."
//
// `users.organization_id` is MUTABLE. `PUT /api/auth/users/:id` writes it, and
// moving a person between organisations is a documented one-click admin action
// — services/user-org-scope.js calls that endpoint "the adoption door". A user
// who moves keeps `uploaded_by` / `user_id` on every row they ever authored for
// their FORMER tenant. The premise is false in exactly the case multi-tenancy
// exists for.
//
// Executed against the shipped code, an org-A caller got back two org-B
// attachments — filename, folder, parent entity id, and a snippet reading
// "subcontract price $987654 … markup 42 percent" — and the verbatim body of an
// ai_messages row stamped organization_id = 2. Narrated into an org-A chat, by
// a model, already explained.
//
// ── WHY THIS FILE IS SEPARATE FROM ai-read-tenant-doors ───────────────────
// That file holds tools keyed on an id the MODEL supplies. These two are keyed
// on the CALLER'S OWN id, which is why they were exempted from the read
// invariant rather than fixed, and why they survived three commits of
// boundary work. The defect class is different and the tests have to be too:
// here the fixture must contain a user who MOVED, or there is nothing to catch.
//
// ── THE SCHEMA IS DERIVED, NOT TYPED ──────────────────────────────────────
// Every table below is generated from server/db.js by test/helpers/db-schema.js.
// The previous fixture for this surface HAND-DECLARED `attachments.created_at`,
// a column server/db.js has never created, and that single invented line kept
// two shipped tools green while both raised 42703 in production — including the
// tenant ladder that a4d2cd85 shipped as a SECURITY FIX and which had therefore
// never run. A fixture that cannot type a column cannot invent one.
//
// ── THE PROPERTIES ───────────────────────────────────────────────────────
//   P1  A personal surface returns the caller's own rows — and it still WORKS.
//       A fix that returned nothing would pass every boundary assertion here.
//   P2  A user who has MOVED ORGS cannot reach their former org's rows, on
//       either door, through any branch.
//   P3  An org-less caller gets NOTHING rather than everything — and for a tool
//       that is not on the org-less allowlist, a VISIBLE refusal rather than an
//       empty result. "Refused" and "not there" are different answers.
//   P4  The caller's own legacy NULL-org rows stay visible to them. The
//       tolerance arm is not decoration: without it this is a lockout.
//   P5  These are PERSONAL surfaces and stay personal — the fix must not turn
//       search_my_kb into org-wide search.
//
// ── BOTH DOORS ───────────────────────────────────────────────────────────
// Every case runs over real HTTP at POST /api/ai/exec-tool (real express, real
// requireAuth, real requireCapability, real JWT) AND through execAgentTool with
// the ctx the live chat dispatcher builds. They are different doors and one has
// already been scoped while the other was not.
//
// The engine is installed on globalThis BEFORE ai-routes is required, because
// that module DESTRUCTURES `pool` at load: a per-test engine would leave the
// route reading a database these assertions never touch, which is how an
// earlier pass produced a total false green.

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const express = require('express');
const http = require('http');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema, columnsFor } = require('./helpers/db-schema');

const { proveOrgOnly } = require('./helpers/org-only');

const TABLES = [
  'organizations', 'roles', 'users', 'attachments', 'jobs', 'estimates', 'leads',
  'clients', 'subs', 'projects', 'ai_sessions', 'ai_messages', 'deal_memory',
  // The Email Dropbox. Three statements in read_email_inbox and two in
  // draft_email_reply were scoped by user_id alone; holding them needs the
  // whole filing layer, because the folder and label arms are separate
  // statements with separate predicates.
  'inbound_emails', 'email_folders', 'email_labels', 'email_message_labels',
  'email_attachments', 'email_thread_state',
];

const SCHEMA = sqliteSchema(TABLES);

const engine = createPgSqlite(SCHEMA, {
  jsonColumns: ['data', 'capabilities', 'notification_prefs', 'numbers', 'tags'],
  dateColumns: ['updated_at', 'created_at', 'uploaded_at', 'last_used_at', 'last_seen_at',
                'received_at', 'draft_updated_at'],
});
// The uniqueness draft_email_reply's ON CONFLICT arm names. db.js creates it as
// `uq_email_thread_state`; sqliteSchema renders columns only, and without the
// index the upsert silently becomes an unconditional INSERT — which would let a
// "the draft landed in the caller's own org" assertion pass on a second row
// while the first, foreign one sat there untouched.
engine.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_email_thread_state ON email_thread_state (user_id, thread_id)');
globalThis.__P86_PERSONAL_ENGINE__ = engine;

jest.mock('../server/db', () => ({ pool: globalThis.__P86_PERSONAL_ENGINE__.pool }));

// EVERYTHING THE MODEL WAS HANDED, RECORDED.
// Two of the statements fixed in this round feed a model rather than a
// response body — maybeGenerateSessionLabel asks Haiku to paraphrase the
// conversation and stores the answer, seedRecoveredSession pastes turns into a
// fresh session as trusted context. Neither leak would ever appear in an HTTP
// body, so asserting on one would be asserting on the wrong artefact. The fake
// client records its arguments instead, and the assertions read those.
globalThis.__P86_MODEL_SAW__ = [];
jest.mock('@anthropic-ai/sdk', () => {
  function FakeAnthropic() {
    return {
      messages: {
        create: async (args) => {
          globalThis.__P86_MODEL_SAW__.push(JSON.stringify(args));
          return { content: [{ type: 'text', text: '{"label":"L","summary":"S"}' }] };
        },
      },
      beta: {
        sessions: {
          events: {
            send: async (sid, body) => {
              globalThis.__P86_MODEL_SAW__.push(JSON.stringify(body));
              return {};
            },
          },
        },
      },
    };
  }
  FakeAnthropic.toFile = async () => ({});
  return Object.assign(FakeAnthropic, { toFile: FakeAnthropic.toFile, default: FakeAnthropic });
});

const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const aiRoutes = require('../server/routes/ai-routes');
const {
  execAgentTool, execStaffTool, ORGLESS_ALLOWED_TOOLS,
  maybeGenerateSessionLabel, seedRecoveredSession,
} = aiRoutes.internals;

let server, baseUrl;

const ORG_A = 1;   // where the mover is NOW
const ORG_B = 2;   // where the mover USED TO BE — the victim

// Every org-B row carries this. One grep over the flattened answer decides the
// case, so a leak arriving in a field the assertion did not anticipate cannot
// read as absent.
const MARK = 'ZZVICTIMBRAVO';

// The word every seeded row matches, so a single query term reaches all of them
// and the only thing separating the answers is the tenant predicate.
const TERM = 'gutters';

const USERS = {
  // THE WHOLE POINT: user 10 is in org A today and authored rows in org B.
  MOVER:   { id: 10, email: 'mover@a.test', role: 'admin', name: 'Moved Admin', organization_id: ORG_A },
  B_LOCAL: { id: 20, email: 'b@b.test',     role: 'admin', name: 'B Admin',     organization_id: ORG_B },
  ORGLESS: { id: 30, email: 'none@x.test',  role: 'admin', name: 'No Org',      organization_id: null },
};

function seed() {
  engine.db.exec(`
    DELETE FROM ai_messages; DELETE FROM ai_sessions; DELETE FROM deal_memory;
    DELETE FROM attachments; DELETE FROM jobs; DELETE FROM estimates;
    DELETE FROM leads; DELETE FROM clients; DELETE FROM subs; DELETE FROM projects;
    DELETE FROM email_message_labels; DELETE FROM email_labels;
    DELETE FROM email_attachments; DELETE FROM email_thread_state;
    DELETE FROM inbound_emails; DELETE FROM email_folders;
    DELETE FROM users; DELETE FROM roles; DELETE FROM organizations;
    INSERT INTO organizations (id, name) VALUES (1, 'Affiliate A'), (2, 'Affiliate B');
    INSERT INTO users (id, email, name, role, organization_id) VALUES
      (10, 'mover@a.test', 'Moved Admin', 'admin', 1),
      (20, 'b@b.test',     'B Admin',     'admin', 2),
      (30, 'none@x.test',  'No Org',      'admin', NULL);
    INSERT INTO roles (name, label, capabilities) VALUES
      ('admin', 'Admin', '["ESTIMATES_VIEW","ESTIMATES_EDIT","FINANCIALS_VIEW","INSIGHTS_VIEW","JOBS_VIEW","LEADS_VIEW","CLIENTS_VIEW","SUBS_VIEW","FILES_VIEW","TASKS_VIEW"]');
    INSERT INTO jobs (id, owner_id, organization_id, data) VALUES
      ('j-a1',   10, 1,    '{"title":"Alpha Job"}'),
      ('j-b1',   20, 2,    '{"title":"Bravo Job"}'),
      ('j-null', 10, NULL, '{"title":"Legacy Job"}');
    INSERT INTO estimates (id, owner_id, organization_id, data) VALUES
      ('e-b1', 20, 2, '{"title":"Bravo Estimate"}');
    -- An entity whose NAME contains the search term, so session-search's
    -- entity branch (branch C) has candidates and actually EMITS its
    -- statement. Without it that branch short-circuits on an empty candidate
    -- set and the SQL assertion below would pass by finding nothing.
    INSERT INTO leads (id, organization_id, title, status) VALUES
      ('lead-a1', 1, 'Gutters Alpha Community', 'new');
  `);

  // ── attachments ─────────────────────────────────────────────────────────
  // EVERY row is uploaded_by = 10, the mover. That is the fixture's whole
  // claim: `uploaded_by` cannot separate these, so only the tenant predicate
  // can. The parent entity, the row's own stamp and the org bucket are each
  // represented so all three arms of the ladder are exercised.
  const att = engine.db.prepare(
    `INSERT INTO attachments
       (id, entity_type, entity_id, filename, mime_type, size_bytes, folder,
        uploaded_by, uploaded_at, organization_id, extracted_text)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const A = (id, type, eid, name, org, text, at) =>
    att.run(id, type, eid, name, 'application/pdf', 2048, 'Docs', 10, at, org, text);

  A('att-a-job',  'job',      'j-a1',  'alpha-gutters.pdf',  ORG_A, TERM + ' alpha scope', '2026-08-05 00:00:00');
  A('att-legacy', 'job',      'j-null', 'legacy-gutters.pdf', null,  TERM + ' legacy scope', '2026-08-04 00:00:00');
  A('att-a-org',  'org',      '1',     'alpha-company.pdf',  ORG_A, TERM + ' company handbook', '2026-08-03 00:00:00');
  // The four org-B rows the mover authored before the move.
  A('att-b-job',  'job',      'j-b1',  MARK + '-job.pdf',    ORG_B, TERM + ' ' + MARK + ' subcontract price $987654 markup 42 percent', '2026-08-09 00:00:00');
  A('att-b-est',  'estimate', 'e-b1',  MARK + '-est.pdf',    ORG_B, TERM + ' ' + MARK + ' estimate body', '2026-08-08 00:00:00');
  A('att-b-user', 'user',     '20',    MARK + '-mine.pdf',   ORG_B, TERM + ' ' + MARK + ' personal bucket', '2026-08-07 00:00:00');
  A('att-b-org',  'org',      '2',     MARK + '-co.pdf',     ORG_B, TERM + ' ' + MARK + ' company handbook', '2026-08-06 00:00:00');
  // A row belonging to somebody ELSE, in the caller's own org. P5: fixing the
  // tenant boundary must not turn this personal surface into org-wide search.
  // It is also the row search_org_kb SHOULD return, which is how P5 stays a
  // claim about the boundary rather than about the row simply being absent.
  att.run('att-a-other', 'job', 'j-a1', 'someone-else-gutters.pdf', 'application/pdf',
    2048, 'Docs', 20, '2026-08-05 00:00:00', ORG_A, TERM + ' NOTMINE alpha');
  // THE LADDER'S OWN CASE, and it has never once executed in production.
  // An org-A job's file, uploaded by an org-B user, with NO stamp of its own.
  // Anchored on the uploader it is org B's — invisible to the tenant that owns
  // the job, visible to one that does not. Anchored on the PARENT, which is
  // what services/attachment-org-scope.js says and what search_org_kb's ladder
  // now expresses, it is org A's.
  att.run('att-a-parent', 'job', 'j-a1', 'parent-anchored-gutters.pdf', 'application/pdf',
    2048, 'Docs', 20, '2026-08-05 00:00:00', null, TERM + ' parent anchored alpha');
  // An org-A user's personal bucket, so the 'user' arm of the ladder is
  // exercised on the side that should be VISIBLE as well as the side that
  // should not.
  att.run('att-a-userbucket', 'user', '10', 'alpha-personal.pdf', 'application/pdf',
    2048, 'My Files', 10, '2026-08-05 00:00:00', ORG_A, TERM + ' alpha personal');
  // The org-less caller's own rows: one legacy, one from org B.
  att.run('att-none-legacy', 'job', 'j-null', 'orgless-gutters.pdf', 'application/pdf',
    2048, 'Docs', 30, '2026-08-02 00:00:00', null, TERM + ' orgless legacy');
  att.run('att-none-b', 'job', 'j-b1', MARK + '-orgless.pdf', 'application/pdf',
    2048, 'Docs', 30, '2026-08-01 00:00:00', ORG_B, TERM + ' ' + MARK + ' orgless bravo');

  // ── sessions + messages ─────────────────────────────────────────────────
  // All four threads belong to user 10. Only their MESSAGES name a tenant,
  // because ai_sessions has no organization_id column.
  const ses = engine.db.prepare(
    `INSERT INTO ai_sessions
       (id, agent_key, entity_type, entity_id, user_id, anthropic_session_id,
        anthropic_agent_id, created_at, last_used_at, archived_at, label, summary,
        pinned, turn_count, session_kind)
     VALUES (?,?,?,?,?,?,?,?,?,NULL,?,?,0,1,'user_thread')`);
  const S = (id, label, summary, at) =>
    ses.run(id, '86', 'general', null, 10, 'as-' + id, 'aa-' + id, at, at, label, summary);

  S(101, TERM + ' bravo thread', MARK + ' bravo summary', '2026-08-09 00:00:00');
  S(102, TERM + ' alpha thread', 'alpha summary',         '2026-08-08 00:00:00');
  S(103, TERM + ' legacy thread', 'legacy summary',       '2026-08-07 00:00:00');
  S(104, TERM + ' fresh thread', 'fresh summary',         '2026-08-06 00:00:00');   // no messages

  const msg = engine.db.prepare(
    `INSERT INTO ai_messages
       (id, entity_type, estimate_id, user_id, session_id, role, content,
        organization_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`);
  // Note entity_type 'general' and estimate_id NULL on EVERY row and EVERY
  // session. That is not incidental: branch B joins on
  // (user_id, entity_type, COALESCE(estimate_id,'')), not on session_id, so
  // this org-B message fans out onto all four of the mover's sessions. Without
  // the message-level predicate its body is the snippet printed beside an
  // org-A thread — which is exactly the row the executed proof recovered.
  msg.run('m-b1', 'general', null, 10, 101, 'assistant',
    MARK + ' unit cost 987.65 markup 42', ORG_B, '2026-08-09 01:00:00');
  msg.run('m-a1', 'general', null, 10, 102, 'assistant',
    'alpha body ' + TERM, ORG_A, '2026-08-08 01:00:00');
  msg.run('m-l1', 'general', null, 10, 103, 'assistant',
    'legacy body ' + TERM, null, '2026-08-07 01:00:00');

  // ── THE BACK CATALOGUE — sessions whose messages predate session_id ──────
  // `ai_messages.session_id` is a late ALTER and server/db.js says in its own
  // comment that the backfill is a LATER slice. There is no backfill, so every
  // pre-cutover message carries session_id NULL and its session joined to
  // nothing — which put the entire back catalogue into arm 2's "no messages,
  // so no tenant to check" tolerance, for every caller on the platform. These
  // two threads are that shape, identical in every respect except THE ORG OF
  // THEIR MESSAGES, which is the only thing a tenant predicate can act on.
  //
  // Each thread's window is disjoint from the other's and from 101–104's, so a
  // message is inside exactly one session's lifespan and the assertion below
  // is about the predicate rather than about an accident of overlap.
  const ses2 = engine.db.prepare(
    `INSERT INTO ai_sessions
       (id, agent_key, entity_type, entity_id, user_id, anthropic_session_id,
        anthropic_agent_id, created_at, last_used_at, archived_at, label, summary,
        pinned, turn_count, session_kind)
     VALUES (?,?,?,?,?,?,?,?,?,NULL,?,?,0,1,'user_thread')`);
  ses2.run(105, '86', 'general', null, 10, 'as-105', 'aa-105',
    '2026-09-01 00:00:00', '2026-09-01 23:00:00',
    TERM + ' legacy-link bravo thread', MARK + ' bravo paraphrase');
  ses2.run(106, '86', 'general', null, 10, 'as-106', 'aa-106',
    '2026-09-02 00:00:00', '2026-09-02 23:00:00',
    TERM + ' legacy-link alpha thread', 'alpha paraphrase');
  msg.run('m-legacy-b', 'general', null, 10, null, 'assistant',
    MARK + ' legacy-link bravo body ' + TERM, ORG_B, '2026-09-01 10:00:00');
  msg.run('m-legacy-a', 'general', null, 10, null, 'assistant',
    'legacy-link alpha body ' + TERM, ORG_A, '2026-09-02 10:00:00');

  // ── self_diagnose — the caller's own 86 turns, inside its rolling window ──
  // NOW()-relative, so the timestamps are computed rather than written down;
  // a fixed date would fall out of the window the moment the clock moved.
  const nowIso = (offsetMin) => new Date(Date.now() - offsetMin * 60000)
    .toISOString().replace('T', ' ').slice(0, 19);
  msg.run('m-diag-a', '86', null, 10, null, 'user',
    'alpha diagnostics ' + TERM, ORG_A, nowIso(9));
  msg.run('m-diag-b', '86', null, 10, null, 'user',
    MARK + ' bravo diagnostics unit cost 987.65', ORG_B, nowIso(8));
  msg.run('m-diag-null', '86', null, 10, null, 'user',
    'legacy diagnostics ' + TERM, null, nowIso(7));
  // The org-less caller's own 86 turns: one un-stamped, one from org B.
  msg.run('m-diag-none', '86', null, 30, null, 'user',
    'orgless diagnostics ' + TERM, null, nowIso(6));
  msg.run('m-diag-none-b', '86', null, 30, null, 'user',
    MARK + ' orgless bravo diagnostics', ORG_B, nowIso(5));

  // ── the Email Dropbox ───────────────────────────────────────────────────
  // EVERY inbound_emails row belongs to user 10, the mover. `user_id` cannot
  // separate them; only `organization_id` can. inbound_emails.organization_id
  // is INTEGER NOT NULL in server/db.js, so there is deliberately no
  // un-stamped row here — a legacy tolerance arm on this table would be dead
  // SQL, and the fixture says so by having nothing for it to match.
  engine.db.exec(`
    INSERT INTO email_folders (id, organization_id, user_id, name, slug, kind, path, sort, system)
      VALUES ('fld-a', 1, 10, 'Invoices & Bills', 'invoices', 'user', '/invoices', 0, 0),
             ('fld-b', 2, 10, '${MARK}-FOLDER',   'bravo',    'user', '/bravo',    0, 0);
    INSERT INTO email_labels (id, organization_id, name, color, sort, use_count, archived_at)
      VALUES (1, 1, 'Alpha-Label', '#fff', 0, 0, NULL),
             (2, 2, '${MARK}-LABEL', '#000', 0, 0, NULL);
  `);
  const em = engine.db.prepare(
    `INSERT INTO inbound_emails
       (id, organization_id, user_id, thread_id, from_name, from_email, orig_from_email,
        subject, body_text, direction, received_at, folder_id, ai_category,
        needs_reply, triage_summary, has_attachments, is_forward_wrapper, delivered_direct)
     VALUES (?,?,?,?,?,?,?,?,?,'inbound',?,?,?,0,?,?,0,0)`);
  em.run('em-a1', ORG_A, 10, 'th_alpha', 'Alpha Sender', 'alpha@client.test', null,
    'Alpha ' + TERM + ' scope question', 'Alpha body about ' + TERM + ' on the north elevation.',
    '2026-08-20 09:00:00', 'fld-a', 'invoices_bills', 'alpha triage', 1);
  em.run('em-b1', ORG_B, 10, 'th_bravo', MARK + ' Sender', 'bravo@' + MARK + '.test', null,
    MARK + ' ' + TERM + ' subcontract', MARK + ' body: subcontract price $987654 markup 42 percent, ' + TERM + '.',
    '2026-08-21 09:00:00', 'fld-b', 'invoices_bills', MARK + ' triage summary', 1);
  // A COLLIDING THREAD ID, on purpose. thread_id is derived from the mail
  // headers, so the same conversation forwarded to the dropbox before and
  // after a move lands under one id in two tenants. Without this row the
  // LABELS statement is unreachable behaviourally — the message statement
  // refuses first and there is nothing to attach a label to — so its predicate
  // would be held only by the static invariant. With it, an unscoped labels
  // read prints org B's label on org A's thread and the assertion can see it.
  em.run('em-b2', ORG_B, 10, 'th_alpha', MARK + ' Sender', 'bravo@' + MARK + '.test', null,
    MARK + ' same-thread reply', MARK + ' colliding-thread body.',
    '2026-08-22 09:00:00', 'fld-b', null, null, 0);
  engine.db.exec(`
    INSERT INTO email_message_labels (message_id, label_id)
      VALUES ('em-a1', 1), ('em-b1', 2), ('em-b2', 2);
    INSERT INTO email_attachments
      (id, email_id, user_id, organization_id, filename, mime_type, size_bytes, storage_key, extracted_text)
      VALUES ('ea-a1', 'em-a1', 10, 1, 'alpha-quote.pdf', 'application/pdf', 2048, 'k/a', 'alpha attachment text'),
             ('ea-b1', 'em-b1', 10, 2, '${MARK}-quote.pdf', 'application/pdf', 2048, 'k/b', '${MARK} OCR: unit price 987654');
  `);

  setRolePool(engine.pool);
  return refreshRoleCache();
}

// ── the two doors ─────────────────────────────────────────────────────────

function ctxFor(u) {
  // EXACTLY the shape POST /api/ai/exec-tool builds and the shape the live
  // streaming dispatcher builds. Written out here rather than imported so a
  // change to either one shows up as a failure instead of as agreement.
  return { userId: u.id, orgId: u.organization_id, user: u };
}

function flatten(v) {
  if (v == null) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

async function viaHttp(user, name, input) {
  const res = await fetch(baseUrl + '/api/ai/exec-tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + signToken(user) },
    body: JSON.stringify({ name, input: input || {} }),
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* non-JSON */ }
  return { status: res.status, text: flatten(json && (json.summary != null ? json.summary : json)) };
}

async function viaExec(user, name, input) {
  let out;
  try { out = await execAgentTool(name, input || {}, ctxFor(user)); }
  catch (e) { out = 'THREW: ' + (e && e.message); }
  return { status: 200, text: flatten(out) };
}

// The third door named in the brief: the narrow executor itself, reached
// without execAgentTool's org gate in front of it.
async function viaStaff(user, name, input) {
  let out;
  try { out = await execStaffTool(name, input || {}, ctxFor(user)); }
  catch (e) { out = 'THREW: ' + (e && e.message); }
  return { status: 200, text: flatten(out) };
}

const DOORS = [
  ['DOOR http   POST /api/ai/exec-tool', viaHttp],
  ['DOOR exec   execAgentTool + live ctx', viaExec],
  ['DOOR staff  execStaffTool + live ctx', viaStaff],
];

beforeAll((done) => {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/ai', aiRoutes);
  server = http.createServer(app);
  server.listen(0, '127.0.0.1', () => {
    baseUrl = 'http://127.0.0.1:' + server.address().port;
    done();
  });
});
afterAll((done) => { server.close(() => done()); });
beforeEach(() => { engine.log.length = 0; return seed(); });

// ══════════════════════════════════════════════════════════════════════════
// The fixture's own honesty, first. Every assertion below is worth exactly as
// much as these.
// ══════════════════════════════════════════════════════════════════════════
describe('the fixture is derived, and it can catch the defect that hid', () => {
  test('the schema comes from server/db.js — attachments has uploaded_at, not created_at', () => {
    expect(SCHEMA).toMatch(/\buploaded_at\b/);
    expect(columnsFor('attachments').has('created_at')).toBe(false);
    // And the engine agrees: the column genuinely is not there, so the
    // pre-fix statement could not have prepared against this fixture.
    expect(() => engine.db.prepare('SELECT created_at FROM attachments').all())
      .toThrow(/no such column/i);
  });

  test('ai_sessions genuinely has no organization_id — which is why the guard goes through messages', () => {
    expect(columnsFor('ai_sessions').has('organization_id')).toBe(false);
    expect(columnsFor('ai_messages').has('organization_id')).toBe(true);
  });

  test('the mover really is in org A and really does own org-B rows', () => {
    expect(engine.all('SELECT organization_id AS o FROM users WHERE id = 10')[0].o).toBe(ORG_A);
    expect(engine.count('SELECT 1 FROM attachments WHERE uploaded_by = 10 AND organization_id = 2')).toBe(4);
    // Named rather than counted, so adding a row to the fixture cannot quietly
    // satisfy this and so a failure says WHICH arm lost its victim row: the
    // session-linked message, the pre-cutover legacy-key one, and the 86 turn
    // self_diagnose prints verbatim.
    expect(engine.all(
      'SELECT id FROM ai_messages WHERE user_id = 10 AND organization_id = 2 ORDER BY id'
    ).map((r) => r.id)).toEqual(['m-b1', 'm-diag-b', 'm-legacy-b']);
    // And the dropbox: every inbound_emails row is the mover's, so user_id
    // cannot separate them and only organization_id can.
    expect(engine.all(
      'SELECT id, organization_id AS o FROM inbound_emails ORDER BY id'
    )).toEqual([{ id: 'em-a1', o: ORG_A }, { id: 'em-b1', o: ORG_B }, { id: 'em-b2', o: ORG_B }]);
    expect(engine.count('SELECT 1 FROM inbound_emails WHERE user_id = 10')).toBe(3);
    // The colliding thread id: th_alpha exists in BOTH tenants, which is what
    // makes the labels statement independently reachable.
    expect(engine.all(
      "SELECT organization_id AS o FROM inbound_emails WHERE thread_id = 'th_alpha' ORDER BY o"
    ).map((r) => r.o)).toEqual([ORG_A, ORG_B]);
    // inbound_emails.organization_id is INTEGER NOT NULL in server/db.js —
    // there is no legacy un-stamped row for a tolerance arm to keep visible,
    // which is why the predicate on that table is strict.
    expect(columnsFor('inbound_emails').has('organization_id')).toBe(true);
    expect(engine.count('SELECT 1 FROM inbound_emails WHERE organization_id IS NULL')).toBe(0);
  });

  test('the back-catalogue threads really do have NULL session_id, which is the whole defect', () => {
    // If these ever carried a session_id the arm-2 assertions below would pass
    // through arm 1 and prove nothing about the tolerance.
    expect(engine.all(
      "SELECT id FROM ai_messages WHERE session_id IS NULL AND entity_type = 'general' ORDER BY id"
    ).map((r) => r.id)).toEqual(['m-legacy-a', 'm-legacy-b']);
    // …and that server/db.js still has no backfill for the column, which is
    // the reason the back catalogue is in this state at all. If a migration
    // lands, this fails and the tolerance can be revisited on purpose.
    const dbjs = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'server', 'db.js'), 'utf8');
    expect(/UPDATE\s+ai_messages[\s\S]{0,200}SET\s+session_id/i.test(dbjs)).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// search_my_kb
// ══════════════════════════════════════════════════════════════════════════
describe.each(DOORS)('search_my_kb — %s', (_label, call) => {
  test('P1 the caller\'s own in-tenant uploads still come back', async () => {
    const r = await call(USERS.MOVER, 'search_my_kb', { query: TERM });
    expect(r.status).toBe(200);
    expect(r.text).toContain('alpha-gutters.pdf');
    expect(r.text).toContain('alpha-company.pdf');
  });

  test('P2 a user who moved orgs cannot reach their former org\'s files', async () => {
    const r = await call(USERS.MOVER, 'search_my_kb', { query: TERM });
    expect(r.text).not.toContain(MARK);
    // named individually so a failure says WHICH arm of the ladder gave way
    expect(r.text).not.toContain('att-b-job');    // parent entity = org-B job
    expect(r.text).not.toContain('att-b-est');    // parent entity = org-B estimate
    expect(r.text).not.toContain('att-b-user');   // org-B user's personal bucket
    expect(r.text).not.toContain('att-b-org');    // org-B company bucket
    expect(r.text).not.toContain('987654');
  });

  test('P4 the caller\'s own legacy NULL-org rows stay visible', async () => {
    const r = await call(USERS.MOVER, 'search_my_kb', { query: TERM });
    expect(r.text).toContain('legacy-gutters.pdf');
  });

  test('P5 it is still PERSONAL — another user\'s file in the same org is not returned', async () => {
    const r = await call(USERS.MOVER, 'search_my_kb', { query: TERM });
    expect(r.text).not.toContain('someone-else-gutters.pdf');
    expect(r.text).not.toContain('NOTMINE');
  });

  test('P3 an org-less caller gets their own un-stamped rows and nothing that names a tenant', async () => {
    const r = await call(USERS.ORGLESS, 'search_my_kb', { query: TERM });
    expect(r.status).toBe(200);
    expect(r.text).toContain('orgless-gutters.pdf');   // their own legacy row
    expect(r.text).not.toContain(MARK);                // and nothing of org B's
  });
});

// ══════════════════════════════════════════════════════════════════════════
// search_org_kb — CODE THAT HAS NEVER RUN.
//
// This tool ordered by `attachments.created_at`, a column server/db.js has
// never created, so it raised 42703 on every call since it was written. The
// parent-anchor ladder inside it shipped in a4d2cd85 as the fix for a
// cross-tenant read and has therefore never executed either. Correcting the
// column TURNS IT ON. Switching on code that has never run, on a live pilot,
// without holding it is how the next incident starts, so it is held here — and
// the ladder's own case (a file whose uploader and whose parent are in
// different tenants) is the first thing asserted, because that is the property
// a4d2cd85 claimed and could not have been getting.
// ══════════════════════════════════════════════════════════════════════════
describe.each(DOORS)('search_org_kb — %s', (_label, call) => {
  test('it executes at all, and returns the caller\'s org across buckets', async () => {
    const r = await call(USERS.MOVER, 'search_org_kb', { query: TERM });
    expect(r.status).toBe(200);
    expect(r.text).not.toMatch(/THREW|error/i);
    expect(r.text).toContain('alpha-gutters.pdf');       // entity bucket
    expect(r.text).toContain('alpha-company.pdf');       // org bucket
    expect(r.text).toContain('alpha-personal.pdf');      // an org-A user bucket
    expect(r.text).toContain('someone-else-gutters.pdf');// org-WIDE: not just mine
  });

  test('the parent is the anchor — an org-A job\'s file uploaded by an org-B user is org A\'s', async () => {
    const a = await call(USERS.MOVER, 'search_org_kb', { query: TERM });
    expect(a.text).toContain('parent-anchored-gutters.pdf');
    const b = await call(USERS.B_LOCAL, 'search_org_kb', { query: TERM });
    expect(b.text).not.toContain('parent-anchored-gutters.pdf');
  });

  test('and it is still a boundary — org B\'s files are not in org A\'s answer', async () => {
    const r = await call(USERS.MOVER, 'search_org_kb', { query: TERM });
    expect(r.text).not.toContain(MARK);
    expect(r.text).not.toContain('987654');
  });

  test('org B sees its own and not org A\'s', async () => {
    const r = await call(USERS.B_LOCAL, 'search_org_kb', { query: TERM });
    expect(r.text).toContain(MARK);
    expect(r.text).not.toContain('alpha-gutters.pdf');
    expect(r.text).not.toContain('alpha-company.pdf');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// search_my_sessions
// ══════════════════════════════════════════════════════════════════════════
describe.each(DOORS)('search_my_sessions — %s', (_label, call) => {
  test('P1 the caller\'s own in-tenant threads still come back', async () => {
    const r = await call(USERS.MOVER, 'search_my_sessions', { query: TERM });
    expect(r.status).toBe(200);
    expect(r.text).toContain('alpha thread');
  });

  test('P2 a thread whose messages belong to the former org is gone — label, summary and body', async () => {
    const r = await call(USERS.MOVER, 'search_my_sessions', { query: TERM });
    expect(r.text).not.toContain('bravo thread');       // branch A: the label
    expect(r.text).not.toContain('bravo summary');      // branch A: the summary
    expect(r.text).not.toContain(MARK);
    expect(r.text).not.toContain('987.65');             // branch B: the message body
  });

  test('P2 the fan-out snippet is scoped too — an org-B message cannot decorate an org-A thread', async () => {
    // Searching a phrase that appears ONLY in the org-B message body. Under the
    // old join this matched through (user_id, entity_type, estimate_id) and
    // printed that body beside every one of the mover's general threads.
    const r = await call(USERS.MOVER, 'search_my_sessions', { query: 'unit cost' });
    expect(r.text).not.toContain(MARK);
    expect(r.text).not.toContain('987.65');
  });

  test('P4 a legacy thread whose messages name no tenant stays visible', async () => {
    const r = await call(USERS.MOVER, 'search_my_sessions', { query: TERM });
    expect(r.text).toContain('legacy thread');
  });

  test('P4 a brand-new thread with no messages yet stays visible to its owner', async () => {
    const r = await call(USERS.MOVER, 'search_my_sessions', { query: TERM });
    expect(r.text).toContain('fresh thread');
  });
});

describe('search_my_sessions — the org-less caller', () => {
  test('P3 REFUSED VISIBLY, not answered empty', async () => {
    // search_my_sessions is NOT on ORGLESS_ALLOWED_TOOLS, so the gate answers
    // before the query runs. "Refused" and "nothing found" must not read the
    // same: conflating them is how a boundary becomes a lockout nobody can
    // debug.
    expect(ORGLESS_ALLOWED_TOOLS.has('search_my_sessions')).toBe(false);
    const r = await viaExec(USERS.ORGLESS, 'search_my_sessions', { query: TERM });
    expect(r.text).toMatch(/Refused/i);
    expect(r.text).not.toContain(MARK);
  });

  test('search_my_kb IS on that list, and is safe there because of the predicate', () => {
    expect(ORGLESS_ALLOWED_TOOLS.has('search_my_kb')).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// The statement, not just the answer. Branch C of session-search uses
// `unnest($2::text[], $3::text[])`, which test/helpers/pg-sqlite.js cannot
// translate — the branch fails soft and returns [] here, so no ROW assertion
// can hold it. It is not left unheld: the SQL the engine was actually handed is
// asserted to carry the guard, and test/ai-read-predicate-invariant.test.js
// fails if the token is removed from the statement. Named, with the reason,
// rather than quietly uncovered.
// ══════════════════════════════════════════════════════════════════════════
describe('the SQL that was actually run', () => {
  test('every session-search statement carries a tenant predicate', async () => {
    await viaExec(USERS.MOVER, 'search_my_sessions', { query: TERM });
    const stmts = engine.log
      .map((e) => e.sql)
      .filter((s) => /FROM ai_sessions s/i.test(s));
    // meta, message and entity branches
    expect(stmts.length).toBeGreaterThanOrEqual(3);
    const missing = stmts.filter((s) => !/organization_id/i.test(s));
    expect(missing).toEqual([]);
  });

  test('the entity branch — the one no row assertion can reach here — is among them', async () => {
    await viaExec(USERS.MOVER, 'search_my_sessions', { query: TERM });
    const entityBranch = engine.log.map((e) => e.sql).filter((s) => /unnest\(/i.test(s));
    expect(entityBranch.length).toBe(1);
    expect(entityBranch[0]).toMatch(/organization_id/);
  });

  test('search_my_kb reads uploaded_at, and never created_at', async () => {
    await viaExec(USERS.MOVER, 'search_my_kb', { query: TERM });
    const stmts = engine.log.map((e) => e.sql).filter((s) => /FROM attachments/i.test(s));
    expect(stmts.length).toBe(1);
    expect(stmts[0]).toMatch(/ORDER BY a\.uploaded_at DESC/);
    expect(stmts[0]).not.toMatch(/created_at/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// VARY ONLY THE ORG.
//
// Everything below runs through test/helpers/org-only.js's `proveOrgOnly`,
// which takes ONE caller record and two organisation ids and derives both arms
// from it. That is not ceremony. The allowlist entry that kept
// read_email_inbox open for three commits cited a cross-tenant check that had
// varied the user AND the org — two different people asked for each other's
// mail — which can only ever prove "another user's mail is not yours". The
// proposition at issue is "a row I authored for my FORMER tenant is not mine
// now", and no test that moves the caller can express it.
//
// So the caller cannot move here. There is one of him.
// ══════════════════════════════════════════════════════════════════════════

// ── read_email_inbox ─────────────────────────────────────────────────────
describe.each(DOORS)('read_email_inbox — %s', (label, call) => {
  const bothOrgs = (name, input) => proveOrgOnly({
    caller: USERS.MOVER, orgA: ORG_A, orgB: ORG_B,
    run: (caller) => call(caller, name, input),
  });

  test('P1 the LIST arm still works, and shows the caller their own in-tenant threads', async () => {
    const { a } = await bothOrgs('read_email_inbox', {});
    expect(a.status).toBe(200);
    expect(a.text).not.toMatch(/THREW/);
    expect(a.text).toContain('Alpha ' + TERM + ' scope question');
  });

  test('P2 the LIST arm: same caller, org changed — the foreign thread is gone', async () => {
    const { a, b } = await bothOrgs('read_email_inbox', {});
    expect(a.text).not.toContain(MARK);           // as a member of org A
    expect(b.text).toContain(MARK);               // as a member of org B — the ONLY change
    expect(b.text).not.toContain('Alpha ' + TERM + ' scope question');
  });

  test('P2 the q arm is DISCOVERY, and it is scoped too', async () => {
    // The distinction the last commit drew — re-entry (you already hold the
    // id) versus discovery (the tool finds rows for you) — puts this arm on
    // the discovery side: it ILIKEs subject, from_email, orig_from_email AND
    // body_text across the whole mailbox. Its allowlist reason called the
    // whole tool "re-entry", which was true of one arm out of three.
    const { a, b } = await proveOrgOnly({
      caller: USERS.MOVER, orgA: ORG_A, orgB: ORG_B,
      run: (caller) => call(caller, 'read_email_inbox', { q: 'subcontract' }),
    });
    expect(a.text).not.toContain(MARK);
    expect(a.text).not.toContain('987654');
    expect(b.text).toContain(MARK);               // the row exists; only the org moved
  });

  test('P2 the THREAD arm: body, triage, folder, labels and attachment OCR all stop', async () => {
    const { a, b } = await bothOrgs('read_email_inbox', { thread_id: 'th_bravo' });
    // Named individually so a failure says WHICH of the three statements gave
    // way — the message read, the label read, or the attachment read that
    // hangs off it.
    expect(a.text).not.toContain(MARK);                       // subject / sender / body
    expect(a.text).not.toContain('987654');                   // the money in the body
    expect(a.text).not.toContain(MARK + '-FOLDER');           // the folder join
    expect(a.text).not.toContain(MARK + '-LABEL');            // the labels statement
    expect(a.text).not.toContain(MARK + '-quote.pdf');        // the attachment metadata
    expect(a.text).not.toContain('OCR: unit price 987654');   // the attachment's TEXT
    expect(a.text).toMatch(/No conversation with that thread id/);
    // And it is a real thread, not an absent one: the same id as a member of
    // org B returns all six.
    expect(b.text).toContain(MARK);
    expect(b.text).toContain('987654');
    expect(b.text).toContain(MARK + '-FOLDER');
    expect(b.text).toContain(MARK + '-LABEL');
    expect(b.text).toContain('OCR: unit price 987654');
  });

  test('P2 the LABELS arm is its own statement, and it is scoped on its own', async () => {
    // th_alpha exists in BOTH tenants (the same conversation forwarded to the
    // dropbox before and after a move). The message arm returns only org A's
    // copy; an unscoped labels read would still print org B's label beside it,
    // because it is a separate statement over the same thread_id.
    const { a, b } = await bothOrgs('read_email_inbox', { thread_id: 'th_alpha' });
    expect(a.text).toContain('Alpha ' + TERM + ' scope question');   // the thread resolves
    expect(a.text).toContain('Alpha-Label');                         // its own label prints
    expect(a.text).not.toContain(MARK + '-LABEL');                   // and only its own
    expect(a.text).not.toContain('colliding-thread body');           // nor org B's message
    expect(b.text).toContain(MARK + '-LABEL');                       // the row is really there
  });

  test('P5 it is still the caller\'s OWN mailbox, not the org\'s', async () => {
    // B_LOCAL is a different user in org B. Fixing the tenant boundary must
    // not turn a personal dropbox into a shared one.
    const r = await call(USERS.B_LOCAL, 'read_email_inbox', {});
    expect(r.text).not.toContain(MARK);
  });
});

describe('read_email_inbox — the org-less caller', () => {
  test('P3 REFUSED VISIBLY at the gate, and empty at the executor behind it', async () => {
    expect(ORGLESS_ALLOWED_TOOLS.has('read_email_inbox')).toBe(false);
    const gated = await viaExec(USERS.ORGLESS, 'read_email_inbox', {});
    expect(gated.text).toMatch(/Refused/i);
    // The executor door has no gate in front of it. `organization_id = NULL`
    // is NULL, so it fails closed on its own rather than relying on the gate —
    // which matters because execStaffTool is reachable directly.
    const raw = await viaStaff(USERS.ORGLESS, 'read_email_inbox', {});
    expect(raw.text).not.toContain(MARK);
  });
});

// ── draft_email_reply — a read hole that ended in a WRITE ─────────────────
describe('draft_email_reply', () => {
  const draftsFor = (org) => engine.all(
    'SELECT id, organization_id, thread_id, draft_text FROM email_thread_state WHERE organization_id = ' + org);

  test('the ownership probe is org-scoped: a foreign thread is not draftable', async () => {
    const { a, b } = await proveOrgOnly({
      caller: USERS.MOVER, orgA: ORG_A, orgB: ORG_B,
      run: (caller) => viaExec(caller, 'draft_email_reply',
        { thread_id: 'th_bravo', body: 'Thanks, we will price it this week.' }),
    });
    expect(a.text).toMatch(/could not find thread/i);
    expect(b.text).toMatch(/Draft saved/i);
  });

  test('AND NO ROW LANDS IN THE OTHER TENANT — the finding, executed', async () => {
    // The INSERT stamped `own.rows[0].organization_id`, i.e. the org of
    // whatever inbound_emails row the unpredicated probe found. An org-A
    // caller therefore WROTE A ROW INTO ORG B. This is the assertion that
    // could not be made before: the shim now carries the unique index the
    // ON CONFLICT arm names, so the upsert is a real upsert.
    await viaExec({ id: 10, email: 'mover@a.test', role: 'admin', organization_id: ORG_A },
      'draft_email_reply', { thread_id: 'th_bravo', body: 'nothing should be written' });
    expect(draftsFor(ORG_B)).toEqual([]);
    expect(draftsFor(ORG_A)).toEqual([]);
  });

  test('the caller\'s own thread still drafts, and the row is stamped with THEIR org', async () => {
    const r = await viaExec(USERS.MOVER, 'draft_email_reply',
      { thread_id: 'th_alpha', body: 'On it — pricing Friday.' });
    expect(r.text).toMatch(/Draft saved/i);
    const rows = draftsFor(ORG_A);
    expect(rows.length).toBe(1);
    expect(rows[0].thread_id).toBe('th_alpha');
    expect(draftsFor(ORG_B)).toEqual([]);
  });
});

// ── self_diagnose ────────────────────────────────────────────────────────
describe.each(DOORS)('self_diagnose — %s', (_label, call) => {
  test('P1 the caller\'s own in-tenant 86 turns still come back', async () => {
    const { a } = await proveOrgOnly({
      caller: USERS.MOVER, orgA: ORG_A, orgB: ORG_B,
      run: (caller) => call(caller, 'self_diagnose', { window_minutes: 60 }),
    });
    expect(a.status).toBe(200);
    expect(a.text).toContain('alpha diagnostics');
  });

  test('P2 same caller, org changed — the former tenant\'s turns are gone', async () => {
    const { a, b } = await proveOrgOnly({
      caller: USERS.MOVER, orgA: ORG_A, orgB: ORG_B,
      run: (caller) => call(caller, 'self_diagnose', { window_minutes: 60 }),
    });
    // self_diagnose prints m.content VERBATIM — this is not a summary of a
    // foreign row, it is the row.
    expect(a.text).not.toContain(MARK);
    expect(a.text).not.toContain('987.65');
    expect(b.text).toContain(MARK);
  });

  test('P4 the caller\'s own un-stamped legacy turns stay visible', async () => {
    const { a } = await proveOrgOnly({
      caller: USERS.MOVER, orgA: ORG_A, orgB: ORG_B,
      run: (caller) => call(caller, 'self_diagnose', { window_minutes: 60 }),
    });
    expect(a.text).toContain('legacy diagnostics');
  });
});

describe('self_diagnose — the org-less caller', () => {
  test('P3 on the ORGLESS allowlist, and safe there: own un-stamped rows, nothing that names a tenant', async () => {
    expect(ORGLESS_ALLOWED_TOOLS.has('self_diagnose')).toBe(true);
    const r = await viaExec(USERS.ORGLESS, 'self_diagnose', { window_minutes: 60 });
    expect(r.text).toContain('orgless diagnostics');   // their own legacy turns
    expect(r.text).not.toContain(MARK);                // and nothing of org B's
  });
});

// ── search_my_sessions — the pre-cutover back catalogue ──────────────────
describe.each(DOORS)('search_my_sessions, arm 2 — %s', (_label, call) => {
  const bothOrgs = () => proveOrgOnly({
    caller: USERS.MOVER, orgA: ORG_A, orgB: ORG_B,
    run: (caller) => call(caller, 'search_my_sessions', { query: TERM }),
  });

  test('a thread whose messages predate session_id is scoped by the LEGACY key', async () => {
    // The tolerance arm was not "a few fresh threads": with no backfill
    // anywhere in server/db.js, EVERY pre-cutover session took it. What it
    // served is `summary`, which maybeGenerateSessionLabel writes out of the
    // conversation — a model-written paraphrase of another tenant's chat.
    const { a, b } = await bothOrgs();
    expect(a.text).not.toContain('legacy-link bravo thread');
    expect(a.text).not.toContain('bravo paraphrase');
    expect(a.text).not.toContain(MARK);
    expect(b.text).toContain('legacy-link bravo thread');
  });

  test('and the caller\'s OWN pre-cutover threads stay visible — this is not a lockout', async () => {
    const { a } = await bothOrgs();
    expect(a.text).toContain('legacy-link alpha thread');
  });

  test('a genuinely message-less thread is still visible to its owner', async () => {
    // Arm 2 survives for the case it was written for. Widening the "any
    // messages" probe without keeping this would hide a brand-new chat from
    // the person who just opened it.
    const { a } = await bothOrgs();
    expect(a.text).toContain('fresh thread');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// WHAT THE MODEL WAS HANDED.
//
// These two leaks never reach an HTTP body, so no response assertion can hold
// them. maybeGenerateSessionLabel reads the caller's turns on the LEGACY key
// and asks a model to paraphrase them, then stores that paraphrase on
// ai_sessions.summary — which is the exact string search_my_sessions serves
// and which the arm-2 finding is about. seedRecoveredSession reads six turns
// and pastes them, verbatim, into a fresh session as trusted context. The
// assertion is on the ARGUMENTS the fake client received.
// ══════════════════════════════════════════════════════════════════════════
describe('the model is not handed the other tenant\'s conversation', () => {
  const withKey = async (fn) => {
    const had = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key-for-the-fake-client';
    try { return await fn(); } finally {
      if (had === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = had;
    }
  };
  beforeEach(() => { globalThis.__P86_MODEL_SAW__.length = 0; });

  test('maybeGenerateSessionLabel summarises only the caller\'s in-tenant turns', async () => {
    // Session 106 is the mover's pre-cutover ALPHA thread. Its label read is on
    // (user_id, 'general', NULL), which matches every general turn this user
    // ever took — including m-b1 and m-legacy-b, both org B's. `summary` is
    // NULLed so the early return does not skip the read.
    await withKey(() => maybeGenerateSessionLabel({
      id: 106, user_id: 10, entity_type: 'general', entity_id: null, summary: null,
    }));
    const sawAll = globalThis.__P86_MODEL_SAW__.join('\n');
    expect(sawAll.length).toBeGreaterThan(0);       // the model really was called
    expect(sawAll).not.toContain(MARK);
    expect(sawAll).not.toContain('987.65');
    expect(sawAll).toContain('alpha body');         // and it still has something to title
  });

  test('seedRecoveredSession recaps only the caller\'s in-tenant turns', async () => {
    const fake = {
      beta: { sessions: { events: { send: async (sid, body) => {
        globalThis.__P86_MODEL_SAW__.push(JSON.stringify(body)); return {};
      } } } },
    };
    await seedRecoveredSession(fake, { anthropic_session_id: 'as-fresh' },
      { user_id: 10, entity_type: 'general', entity_id: null });
    const sawAll = globalThis.__P86_MODEL_SAW__.join('\n');
    expect(sawAll).toContain('conversation_recap');   // it really did seed
    expect(sawAll).not.toContain(MARK);
    expect(sawAll).not.toContain('987.65');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// REACHABILITY, STATED HONESTLY AND THEN PINNED.
//
// Every predicate in this file defends against a caller who holds rows in two
// organisations. NOTHING IN THE APPLICATION CREATES SUCH A CALLER TODAY:
//
//   • `PUT /api/auth/users/:id` — the only endpoint that writes
//     users.organization_id after insert — writes
//     `organization_id = COALESCE(organization_id, $8)`, a bare column meaning
//     the OLD value, so it can only ever fill a NULL. It is the adoption door,
//     not a move door, and a SYSTEM_ADMIN cannot widen it: `adoptOrgId` is only
//     non-null when the target's org is already NULL.
//   • `POST /api/auth/act-as` refuses a target outside the caller's own org
//     (403), so impersonation cannot author rows in a second tenant either.
//   • Every other `INSERT INTO users` — /register, the org-creation seed admin,
//     the affiliate invitation accept, the sub-portal claim — creates a NEW
//     row with a NEW serial id. A second row is a second user, not one user in
//     two tenants.
//   • Rows are stamped from their author's CURRENT org at insert
//     (inbound_emails from `user.organization_id`, ai_messages likewise) and
//     db.js's backfills stamp from the owner, so no row diverges on its own.
//
// So these doors were UNGUARDED AND ONE FEATURE AWAY, not clickable. The one
// divergence that does exist today is the legacy NULL-org row — an org-less
// user's work, later adopted — which is why every predicate here carries the
// `OR organization_id IS NULL` tolerance and why that is not a hole.
//
// That is a claim about the whole of server/, so it is checked mechanically
// rather than written down. THE DAY SOMEBODY SHIPS A MOVE, THIS FAILS — and
// the failure is the notice that every predicate in this file just went from
// prophylactic to load-bearing.
// ══════════════════════════════════════════════════════════════════════════
describe('nothing in the application moves a user between two organisations', () => {
  const fsx = require('fs');
  const pathx = require('path');
  const SERVER = pathx.join(__dirname, '..', 'server');

  function serverFiles() {
    const out = [];
    (function walk(dir) {
      for (const f of fsx.readdirSync(dir)) {
        const p = pathx.join(dir, f);
        if (fsx.statSync(p).isDirectory()) { if (f !== 'node_modules') walk(p); continue; }
        if (f.endsWith('.js')) out.push(p);
      }
    })(SERVER);
    return out;
  }

  test('every write to users.organization_id after insert is a NULL-FILL', () => {
    // Every `UPDATE users …` in server/ that assigns organization_id. There are
    // exactly two ways such a statement can be a fill rather than a MOVE, and
    // both are in the repo today:
    //   • `SET organization_id = COALESCE(organization_id, $n)` — the bare
    //     column is the OLD value, so a set row keeps what it had. This is
    //     PUT /api/auth/users/:id, the adoption door.
    //   • `SET organization_id = … WHERE organization_id IS NULL` — the boot
    //     backfill in server/db.js, additionally gated on the database never
    //     having held more than one organisation.
    // Anything else moves a user, and makes "one user, rows in two tenants"
    // representable for the first time.
    const offenders = [];
    let seenCoalesce = 0, seenNullWhere = 0;
    for (const p of serverFiles()) {
      const src = fsx.readFileSync(p, 'utf8');
      const re = /UPDATE\s+users\b/gi;
      let m;
      while ((m = re.exec(src))) {
        const stmt = src.slice(m.index, m.index + 600);
        // Cut at the end of the statement so a later, unrelated one cannot
        // lend this one its NULL guard.
        const cut = stmt.search(/;|`|\r?\n\s*\r?\n/);
        const s = cut === -1 ? stmt : stmt.slice(0, cut);
        if (!/organization_id\s*=/i.test(s)) continue;
        if (/organization_id\s*=\s*COALESCE\(\s*organization_id\s*,/i.test(s)) { seenCoalesce++; continue; }
        if (/WHERE[\s\S]*organization_id\s+IS\s+NULL/i.test(s)) { seenNullWhere++; continue; }
        offenders.push(pathx.relative(pathx.join(__dirname, '..'), p).replace(/\\/g, '/') +
          '  ' + s.replace(/\s+/g, ' ').trim().slice(0, 140));
      }
    }
    expect(offenders).toEqual([]);
    // …and both shapes really were found, so this cannot pass by matching no
    // UPDATE at all — the way every scan in this suite has failed at least once.
    expect({ coalesce: seenCoalesce > 0, nullOnlyWhere: seenNullWhere > 0 })
      .toEqual({ coalesce: true, nullOnlyWhere: true });
  });

  test('act-as cannot span tenants', () => {
    const auth = fsx.readFileSync(pathx.join(SERVER, 'routes', 'auth-routes.js'), 'utf8');
    const seg = auth.slice(auth.indexOf("router.post('/act-as'"));
    const body = seg.slice(0, seg.indexOf("router.post('/act-as/exit'"));
    expect(body).toMatch(/target\.organization_id !== req\.user\.organization_id/);
    expect(body).toMatch(/Can only act as a user in your own organization/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// THE HELPER'S OWN HONESTY. proveOrgOnly is now load-bearing — R4's exemption
// validator will only admit an entry whose proof runs through it — so the two
// things it claims are asserted rather than assumed.
// ══════════════════════════════════════════════════════════════════════════
describe('proveOrgOnly cannot vary the caller', () => {
  test('both arms are the same user id, whatever the caller passes', async () => {
    const seen = [];
    await proveOrgOnly({
      caller: USERS.MOVER, orgA: ORG_A, orgB: ORG_B,
      run: (caller) => { seen.push({ id: caller.id, org: caller.organization_id }); return null; },
    });
    expect(seen.map((s) => s.id)).toEqual([USERS.MOVER.id, USERS.MOVER.id]);
    expect(seen.map((s) => s.org)).toEqual([ORG_A, ORG_B]);
  });

  test('it refuses a "proof" that does not vary the org at all', async () => {
    await expect(proveOrgOnly({
      caller: USERS.MOVER, orgA: ORG_A, orgB: ORG_A, run: () => null,
    })).rejects.toThrow(/must differ/);
  });

  test('a callee that mutates its caller record cannot leak org A into arm B', async () => {
    // resolveOrgId repairs req.user.organization_id IN PLACE. A helper that
    // handed the same object to both arms would silently turn arm B into
    // arm A, and the proof would pass by agreeing with itself.
    const orgs = [];
    await proveOrgOnly({
      caller: USERS.MOVER, orgA: ORG_A, orgB: ORG_B,
      run: (caller) => { orgs.push(caller.organization_id); caller.organization_id = 999; return null; },
    });
    expect(orgs).toEqual([ORG_A, ORG_B]);
    expect(USERS.MOVER.organization_id).toBe(ORG_A);
  });
});
