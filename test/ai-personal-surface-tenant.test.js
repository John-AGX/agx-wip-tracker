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

const TABLES = [
  'organizations', 'roles', 'users', 'attachments', 'jobs', 'estimates', 'leads',
  'clients', 'subs', 'projects', 'ai_sessions', 'ai_messages', 'deal_memory',
];

const SCHEMA = sqliteSchema(TABLES);

const engine = createPgSqlite(SCHEMA, {
  jsonColumns: ['data', 'capabilities', 'notification_prefs', 'numbers', 'tags'],
  dateColumns: ['updated_at', 'created_at', 'uploaded_at', 'last_used_at', 'last_seen_at'],
});
globalThis.__P86_PERSONAL_ENGINE__ = engine;

jest.mock('../server/db', () => ({ pool: globalThis.__P86_PERSONAL_ENGINE__.pool }));

jest.mock('@anthropic-ai/sdk', () => {
  function FakeAnthropic() { return { messages: {}, beta: {} }; }
  FakeAnthropic.toFile = async () => ({});
  return Object.assign(FakeAnthropic, { toFile: FakeAnthropic.toFile, default: FakeAnthropic });
});

const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const aiRoutes = require('../server/routes/ai-routes');
const { execAgentTool, execStaffTool, ORGLESS_ALLOWED_TOOLS } = aiRoutes.internals;

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
    expect(engine.count('SELECT 1 FROM ai_messages WHERE user_id = 10 AND organization_id = 2')).toBe(1);
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
