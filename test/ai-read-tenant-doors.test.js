// The tenant boundary on the AGENT TOOL read surface — executed, per door.
//
// WHY A SECOND READ FILE
// test/ai-read-tenant-scope.test.js holds the five CONTEXT-BUILDER doors that
// 797a925e closed. This file holds the TOOL doors, which that commit did not
// touch and which two independent proof passes then executed cross-tenant. The
// distinction matters: a context builder runs once per turn on an entity the
// user is already looking at, while a tool runs on an id (or a bare search
// string) the MODEL supplies, so the blast radius is every row in the table.
//
// WHY A LEAK THROUGH A TOOL IS WORSE THAN A LEAK THROUGH A ROUTE
// The model does not return the row. It SUMMARISES it, in prose, into a chat
// window belonging to whoever asked. `read_past_estimate_lines` did not hand
// back JSON — it computed a median and a range across every affiliate's unit
// costs and printed "Unit-cost anchor: median $X" as though it were the
// caller's own history. `read_lead_pipeline` printed the literal words
// "Pipeline rollup (all leads)" with cross-tenant dollar totals per status.
// The leak arrives already explained.
//
// THE DOORS THIS FILE HOLDS
//   D1  read_past_estimate_lines  — line descriptions, qty, UNIT COST, MARKUP %
//   D2  read_past_estimates       — title, client, status, TOTAL PROPOSAL $, ids
//   D3  read_clients              — directory, 100/call, WITH EMAILS AND PHONES
//   D4  read_entity(client, id)   — bare WHERE id = $1, incl. agent_notes
//   D5  read_entity(lead, id)     — bare WHERE l.id = $1, incl. notes at full
//   D6  read_attachment_text      — 200,000 chars of ANY tenant's document text
//   D7  view_attachment_image     — the same key, returning the BYTES
//   D8  read_lead_pipeline        — no predicate at all, plus a $ rollup
//   D9  read_existing_clients     — execIntakeRead: TOOK NO ctx ARGUMENT
//   D10 read_existing_leads       — execIntakeRead: same
//   D11 read_photo_comments       — messages WHERE thread_key = $1, verbatim
//   D12 read_subs                 — names, phones, emails, licences, COI expiry
//   D13 read_field_tools          — execFieldToolRead: also took no ctx
//   D14 read_qb_cost_lines        } the OWNER-ORG AXIS. These three keyed on
//   D15 read_building_breakdown   } `u.organization_id` — the org of whoever
//   D16 read_job_pct_audit        } OWNS the row, not the row's own tenant.
//   D17 read_schedule_blocks      — the same axis, found by this pass's scan
//
// THE PROPERTIES, stated over a MATRIX rather than on a hand-picked case:
//   P1  For ANY caller and ANY row, a tool serves the row only when the
//       caller's org owns it or the row is legacy NULL-org.
//   P2  A tool invoked with NO org returns NOTHING rather than everything, and
//       says so VISIBLY. "Refused" and "does not exist" are different answers:
//       conflating them was the root cause of the payment-edit regression, and
//       a boundary that answers "not found" to its own tenant is a lockout
//       nobody can debug. Row-keyed doors are the deliberate exception — there
//       the refusal MUST read as absence, or the door is an existence oracle
//       over every affiliate's ids.
//   P3  CROSS-JOB HISTORY INSIDE THE ORG STILL WORKS. These tools exist so 86
//       can answer "what did we charge for gutters last year". A fix that
//       scoped them to one job, or that returned nothing, would break the
//       estimating assistant while passing every boundary assertion above.
//   P4  THE OWNER-ORG AXIS IS WRONG IN BOTH DIRECTIONS: a row owned by an
//       org-less user must not be readable platform-wide, AND a row with no
//       owner must stay readable by its own tenant.
//
// BOTH DOORS, EVERY TOOL. Each tool is exercised over real HTTP at
// POST /api/ai/exec-tool (real express, real requireAuth, real
// requireCapability, real JWT) AND through the executor with the ctx the live
// chat dispatcher builds. They are different doors and one had already been
// scoped while the other was not — the /exec-tool route's executor if-chain
// was a COPY of the streaming dispatcher's that had drifted.
//
// WHY A REAL SQL ENGINE. The property is "which rows came back", which is a
// property of the WHERE clause — the one thing a hand-written fake pool cannot
// be trusted to evaluate. The statements the handlers actually emit go to
// node:sqlite via test/helpers/pg-sqlite.js. The engine is installed on
// globalThis BEFORE the route module is required, because ai-routes
// DESTRUCTURES `pool` at module load: a per-test engine would leave the route
// reading a database these assertions never touch, which is how a previous
// pass produced a total false green.

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const express = require('express');
const http = require('http');
const { createPgSqlite } = require('./helpers/pg-sqlite');

const SCHEMA = `
  CREATE TABLE organizations (id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE roles (name TEXT PRIMARY KEY, label TEXT, capabilities TEXT);
  CREATE TABLE users (
    id INTEGER PRIMARY KEY, email TEXT, name TEXT, role TEXT,
    organization_id INTEGER, active INTEGER DEFAULT 1,
    ai_host_agent_key TEXT, notification_prefs TEXT, last_seen_at TEXT
  );
  CREATE TABLE clients (
    id TEXT PRIMARY KEY, organization_id INTEGER, name TEXT, parent_client_id TEXT,
    client_type TEXT, activation_status TEXT, first_name TEXT, last_name TEXT,
    email TEXT, phone TEXT, company_name TEXT, community_name TEXT,
    property_address TEXT, city TEXT, state TEXT, market TEXT,
    community_manager TEXT, cm_email TEXT, agent_notes TEXT
  );
  CREATE TABLE leads (
    id TEXT PRIMARY KEY, organization_id INTEGER, client_id TEXT, job_id TEXT,
    title TEXT, status TEXT, salesperson_id INTEGER, property_name TEXT,
    street_address TEXT, city TEXT, state TEXT, zip TEXT, notes TEXT,
    source TEXT, confidence REAL, market TEXT,
    projected_sale_date TEXT, estimated_revenue_low REAL, estimated_revenue_high REAL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE estimates (
    id TEXT PRIMARY KEY, owner_id INTEGER, organization_id INTEGER,
    data TEXT NOT NULL, is_locked INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  -- jobs has NO job_number column. The number lives in the data blob as
  -- 'jobNumber' and every route reads it as data->>'jobNumber'. Declaring it
  -- here made read_change_orders' \`j.job_number\` — a 42703 in production —
  -- look like a working statement. See test/schema-truth.test.js.
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY, owner_id INTEGER, organization_id INTEGER, data TEXT
  );
  -- node_graphs is keyed on job_id; it has no id of its own.
  CREATE TABLE node_graphs (
    organization_id INTEGER, job_id TEXT, data TEXT
  );
  -- qb_cost_lines has source_file, not source.
  CREATE TABLE qb_cost_lines (
    id TEXT PRIMARY KEY, organization_id INTEGER, job_id TEXT, amount REAL DEFAULT 0,
    linked_node_id TEXT, report_date TEXT, txn_date TEXT, num TEXT,
    account TEXT, account_type TEXT,
    txn_type TEXT, klass TEXT, bucket TEXT, vendor TEXT, memo TEXT, source_file TEXT
  );
  CREATE TABLE schedule_entries (
    id TEXT PRIMARY KEY, organization_id INTEGER, job_id TEXT, start_date TEXT,
    days INTEGER DEFAULT 1, crew TEXT, includes_weekends INTEGER DEFAULT 0,
    status TEXT, notes TEXT
  );
  CREATE TABLE attachments (
    id TEXT PRIMARY KEY, organization_id INTEGER,
    entity_type TEXT, entity_id TEXT, filename TEXT, mime_type TEXT,
    size_bytes INTEGER, extracted_text TEXT, web_key TEXT, anthropic_file_id TEXT,
    uploaded_by INTEGER, folder TEXT, caption TEXT, tags TEXT,
    lat REAL, lng REAL, taken_at TEXT,
    position INTEGER DEFAULT 0, uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP
    -- NO created_at. server/db.js:1239 declares uploaded_at and nothing adds
    -- the other name. This line used to be here, and while it was, both
    -- search_my_kb and search_org_kb passed here and raised 42703 in
    -- production. The fixture was the second schema, and it was the one the
    -- suite believed.
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY, organization_id INTEGER, thread_key TEXT,
    user_id INTEGER, body TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE message_reads (
    thread_key TEXT, user_id INTEGER, last_read_at TEXT,
    PRIMARY KEY (thread_key, user_id)
  );
  CREATE TABLE subs (
    id TEXT PRIMARY KEY, organization_id INTEGER, name TEXT, trade TEXT, status TEXT,
    contact_name TEXT, primary_contact_first TEXT, primary_contact_last TEXT,
    business_phone TEXT, cell_phone TEXT, email TEXT, license_no TEXT
  );
  CREATE TABLE sub_certificates (
    id TEXT PRIMARY KEY, organization_id INTEGER, sub_id TEXT,
    cert_type TEXT, expiration_date TEXT
  );
  CREATE TABLE field_tools (
    id TEXT PRIMARY KEY, organization_id INTEGER, name TEXT, description TEXT,
    category TEXT, html_body TEXT, is_system INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE ai_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, organization_id INTEGER,
    entity_type TEXT, estimate_id TEXT, user_id INTEGER, session_id TEXT,
    role TEXT, content TEXT, model TEXT, output_files TEXT,
    input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
    tool_use_count INTEGER DEFAULT 0, tool_uses TEXT, photos_included INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`;

const engine = createPgSqlite(SCHEMA, {
  // `certs` is the json_agg the subs read builds in-statement, and the handler
  // calls .map on it; `updated_at`/`created_at` are Dates in pg and the
  // handlers call .toISOString() on them with no guard. Both are decoded to
  // match the pg driver so a handler cannot throw on a line unrelated to the
  // property under test and take the tenant assertion down with it.
  jsonColumns: ['data', 'tool_uses', 'agent_notes', 'crew', 'tags', 'capabilities', 'notification_prefs', 'output_files', 'certs'],
  dateColumns: ['updated_at', 'created_at', 'uploaded_at', 'last_seen_at']
});
globalThis.__P86_AIDOORS_ENGINE__ = engine;

jest.mock('../server/db', () => ({ pool: globalThis.__P86_AIDOORS_ENGINE__.pool }));

// The Anthropic SDK is constructed at module load. No network from a unit test,
// and nothing in this file reaches the model — every assertion is on which rows
// a handler read.
jest.mock('@anthropic-ai/sdk', () => {
  function FakeAnthropic() { return { messages: {}, beta: {} }; }
  FakeAnthropic.toFile = async () => ({});
  return Object.assign(FakeAnthropic, { toFile: FakeAnthropic.toFile, default: FakeAnthropic });
});

const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const aiRoutes = require('../server/routes/ai-routes');
const {
  execStaffTool, execAgentTool, execIntakeRead, execFieldToolRead, execProjectInlineTool,
  ORGLESS_ALLOWED_TOOLS, ALLOWED_AUTO_TIER_TOOLS,
} = aiRoutes.internals;

let server, baseUrl;

const ORG_A = 1;   // the caller
const ORG_B = 2;   // the victim

// Every org-B row carries this marker. One grep over the whole answer decides
// the case: flattened, not field-picked, so a leak arriving in a field this
// helper did not anticipate cannot read as absent.
const MARK = 'ZZVICTIMBRAVO';

// ── seeding ───────────────────────────────────────────────────────────────
// Every fixture is written for BOTH tenants and for a legacy NULL-org row, so
// the matrix below can ask the same question of all three without a per-case
// setup that could be chosen to hit or to miss the defect.

function estimateBlob(tag, total) {
  return {
    title: tag + ' Clubhouse Re-roof',
    clientId: 'c-' + tag,
    totalProposal: total,
    status: 'sent',
    lines: [
      { id: 'l1', description: tag + ' seamless gutters 6in', qty: 400, unit: 'lf', unitCost: 11.25, markup: 42, section: 'Gutters' }
    ]
  };
}

function seed() {
  engine.db.exec(`
    DELETE FROM ai_messages; DELETE FROM field_tools; DELETE FROM sub_certificates;
    DELETE FROM subs; DELETE FROM message_reads; DELETE FROM messages;
    DELETE FROM attachments; DELETE FROM schedule_entries; DELETE FROM qb_cost_lines;
    DELETE FROM node_graphs; DELETE FROM jobs; DELETE FROM estimates; DELETE FROM leads;
    DELETE FROM clients; DELETE FROM users; DELETE FROM roles; DELETE FROM organizations;
    INSERT INTO organizations (id, name) VALUES (1, 'Affiliate A'), (2, 'Affiliate B');
    INSERT INTO users (id, email, name, role, organization_id) VALUES
      (10, 'a@a.a', 'A Admin',  'admin', 1),
      (20, 'b@b.b', 'B Admin',  'admin', 2),
      (30, 'orphan@x.x', 'Orphan Owner', 'admin', NULL);
    INSERT INTO roles (name, label, capabilities) VALUES
      ('admin', 'Admin', '["ESTIMATES_VIEW","ESTIMATES_EDIT","FINANCIALS_VIEW","INSIGHTS_VIEW","JOBS_VIEW","LEADS_VIEW","CLIENTS_VIEW","SUBS_VIEW","SCHEDULE_VIEW","TASKS_VIEW","FILES_VIEW","REPORTS_VIEW","JOBS_EDIT","LEADS_EDIT","CLIENTS_EDIT"]');
  `);

  const est = engine.db.prepare(
    'INSERT INTO estimates (id, owner_id, organization_id, data, updated_at) VALUES (?,?,?,?,?)');
  // TWO org-A estimates on purpose — P3 (cross-JOB history inside the org)
  // needs more than one row to be a real claim.
  est.run('e-a1', 10, ORG_A, JSON.stringify(estimateBlob('ALPHA', 250000)), '2026-08-01 00:00:00');
  est.run('e-a2', 10, ORG_A, JSON.stringify(estimateBlob('ALPHA2', 310000)), '2026-08-02 00:00:00');
  est.run('e-b1', 20, ORG_B, JSON.stringify(estimateBlob(MARK, 987654)), '2026-08-03 00:00:00');
  est.run('e-null', null, null, JSON.stringify(estimateBlob('LEGACY', 100)), '2026-08-04 00:00:00');
  // The owner-axis cell: an org-B row whose OWNER has no organization.
  est.run('e-b-orphanowner', 30, ORG_B, JSON.stringify(estimateBlob(MARK + 'OWNER', 555)), '2026-08-05 00:00:00');

  const cli = engine.db.prepare(
    `INSERT INTO clients (id, organization_id, name, parent_client_id, client_type,
                          first_name, last_name, email, phone, community_name, city, state,
                          community_manager, cm_email, property_address, agent_notes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  cli.run('c-ALPHA', ORG_A, 'Alpha HOA', null, 'hoa', 'Ann', 'Alpha', 'ann@alpha.test', '407-555-0001', 'Alpha Community', 'Orlando', 'FL', 'Ann CAM', 'cam@alpha.test', '1 Alpha Way', '[]');
  cli.run('c-ALPHA2', ORG_A, 'Alpha Two HOA', null, 'hoa', 'Amy', 'Alpha', 'amy@alpha.test', '407-555-0002', 'Alpha Two', 'Orlando', 'FL', null, null, '2 Alpha Way', '[]');
  cli.run('c-victim', ORG_B, MARK + ' Property Group', null, 'hoa', 'Bob', MARK, MARK + '@victim.test', '813-555-' + '9999', MARK + ' Community', 'Tampa', 'FL', MARK + ' CAM', MARK + 'cam@victim.test', MARK + ' Blvd', JSON.stringify([{ body: MARK + ' confidential note' }]));
  cli.run('c-child-B', ORG_B, MARK + ' Child Property', 'c-victim', 'property', null, null, null, null, null, 'Tampa', 'FL', null, null, MARK + ' Child Addr', '[]');
  cli.run('c-LEGACY', null, 'Legacy Client', null, 'hoa', null, null, 'legacy@x.test', null, null, 'Orlando', 'FL', null, null, null, '[]');

  const lead = engine.db.prepare(
    `INSERT INTO leads (id, organization_id, client_id, title, status, salesperson_id,
                        property_name, street_address, city, state, zip, notes, source,
                        confidence, market, estimated_revenue_low, estimated_revenue_high,
                        created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  lead.run('l-a1', ORG_A, 'c-ALPHA', 'Alpha gutters', 'new', 10, 'Alpha Prop', '1 Alpha Way', 'Orlando', 'FL', '32801', 'alpha notes', 'web', 0.5, 'Orlando', 100000, 200000, '2026-08-01', '2026-08-01');
  lead.run('l-b1', ORG_B, 'c-victim', MARK + ' roof replacement', 'new', 20, MARK + ' Prop', MARK + ' Blvd', 'Tampa', 'FL', '33601', MARK + ' private lead notes', 'referral', 0.9, 'Tampa', 900000, 1100000, '2026-08-02', '2026-08-02');
  lead.run('l-null', null, null, 'Legacy lead', 'new', null, null, null, 'Orlando', 'FL', null, null, null, 0.1, null, 10, 20, '2026-08-03', '2026-08-03');

  const job = engine.db.prepare('INSERT INTO jobs (id, owner_id, organization_id, data) VALUES (?,?,?,?)');
  const jobBlob = (tag) => JSON.stringify({
    jobNumber: 'J-' + tag, title: tag + ' Job',
    buildings: [{ id: 'b1', name: tag + ' Building One', pctComplete: 50 }],
    phases: [{ id: 'p1', buildingId: 'b1', name: tag + ' Phase', phaseBudget: 1000, pctComplete: 50 }]
  });
  job.run('j-a1', 10, ORG_A, jobBlob('ALPHA'));
  job.run('j-b1', 20, ORG_B, jobBlob(MARK));
  // THE OWNER-AXIS CELL: org B owns the row, but its owner has no org, so the
  // old `u.organization_id IS NULL` arm matched for EVERY caller.
  job.run('j-b-orphanowner', 30, ORG_B, jobBlob(MARK + 'OWNER'));
  // The other direction: an org-A row with NO owner at all. The old INNER JOIN
  // on users dropped it from its own tenant's results.
  job.run('j-a-noowner', null, ORG_A, jobBlob('ALPHANOOWNER'));

  engine.db.prepare('INSERT INTO node_graphs (organization_id, job_id, data) VALUES (?,?,?)')
    .run(ORG_B, 'j-b1', JSON.stringify({ nodes: [] }));

  const qb = engine.db.prepare(
    `INSERT INTO qb_cost_lines (id, organization_id, job_id, amount, account, account_type, vendor, memo)
     VALUES (?,?,?,?,?,?,?,?)`);
  qb.run('q-a1', ORG_A, 'j-a1', 1500, 'Materials', 'Expense', 'Alpha Supply', 'alpha memo');
  qb.run('q-b1', ORG_B, 'j-b1', 88888, 'Materials', 'Expense', MARK + ' Supply', MARK + ' memo');
  qb.run('q-b-orphan', ORG_B, 'j-b-orphanowner', 77777, 'Materials', 'Expense', MARK + ' OwnerSupply', MARK + ' owner memo');
  qb.run('q-a-noowner', ORG_A, 'j-a-noowner', 4242, 'Materials', 'Expense', 'Alpha NoOwner Supply', 'noowner memo');

  const sch = engine.db.prepare(
    `INSERT INTO schedule_entries (id, organization_id, job_id, start_date, days, crew, status, notes)
     VALUES (?,?,?,?,?,?,?,?)`);
  const soon = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  sch.run('s-a1', ORG_A, 'j-a1', soon, 3, '[]', 'scheduled', 'alpha crew note');
  sch.run('s-b1', ORG_B, 'j-b1', soon, 3, '[]', 'scheduled', MARK + ' crew note');
  sch.run('s-a-noowner', ORG_A, 'j-a-noowner', soon, 1, '[]', 'scheduled', 'noowner crew note');

  const att = engine.db.prepare(
    `INSERT INTO attachments (id, organization_id, entity_type, entity_id, filename,
                              mime_type, size_bytes, extracted_text, uploaded_by, web_key)
     VALUES (?,?,?,?,?,?,?,?,?,?)`);
  att.run('att-a1', ORG_A, 'estimate', 'e-a1', 'alpha-scope.pdf', 'application/pdf', 2048, 'ALPHA extracted scope text', 10, 'k/a1');
  att.run('att-b1', ORG_B, 'estimate', 'e-b1', MARK + '-contract.pdf', 'application/pdf', 4096, MARK + ' extracted contract text', 20, 'k/b1');
  att.run('att-b-img', ORG_B, 'job', 'j-b1', MARK + '-site.jpg', 'image/jpeg', 9000, null, 20, 'k/bimg');
  att.run('att-a-img', ORG_A, 'job', 'j-a1', 'alpha-site.jpg', 'image/jpeg', 9000, null, 10, 'k/aimg');

  const msg = engine.db.prepare(
    'INSERT INTO messages (id, organization_id, thread_key, user_id, body, created_at) VALUES (?,?,?,?,?,?)');
  msg.run('m-a1', ORG_A, 'attachment:att-a1', 10, 'alpha comment on the scope', '2026-08-01 10:00:00');
  msg.run('m-b1', ORG_B, 'attachment:att-b1', 20, MARK + ' comment: our margin here is 38%', '2026-08-02 10:00:00');
  msg.run('m-b-img', ORG_B, 'attachment:att-b-img', 20, MARK + ' photo comment', '2026-08-02 11:00:00');
  // An UN-STAMPED comment on an org-B photo. Found by mutation: with only the
  // messages-table predicate, removing the attachment guard left this file
  // green, because every seeded comment carried a stamp and the tolerance arm
  // (`OR m.organization_id IS NULL`) never fired. It fires here, and the ONLY
  // thing that refuses this row to org A is the attachment guard — which is
  // what makes that guard load-bearing rather than decorative. The row is
  // realistic: db.js's backfill for `messages` stamps off the author's users
  // row, so anything written before that backfill (or by a path that skipped
  // it) is exactly this shape.
  msg.run('m-b-unstamped', null, 'attachment:att-b1', 20, MARK + ' unstamped comment', '2026-08-02 12:00:00');

  const sub = engine.db.prepare(
    `INSERT INTO subs (id, organization_id, name, trade, status, contact_name,
                       business_phone, email, license_no)
     VALUES (?,?,?,?,?,?,?,?,?)`);
  sub.run('sub-a1', ORG_A, 'Alpha Roofing', 'roofing', 'active', 'Al', '407-555-1000', 'al@alpha.test', 'CCC111');
  sub.run('sub-b1', ORG_B, MARK + ' Roofing', 'roofing', 'active', MARK + ' Contact', '813-555-2000', MARK + '@sub.test', 'CCC' + '999');

  const ft = engine.db.prepare(
    'INSERT INTO field_tools (id, organization_id, name, description, category, html_body) VALUES (?,?,?,?,?,?)');
  ft.run('ft-a1', ORG_A, 'Alpha Punch Sheet', 'alpha desc', 'punch', '<div>a</div>');
  ft.run('ft-b1', ORG_B, MARK + ' Bid Sheet', MARK + ' desc', 'bid', '<div>b</div>');

  setRolePool(engine.pool);
  return refreshRoleCache();
}

// ── the two doors ─────────────────────────────────────────────────────────

const USERS = {
  A:    { id: 10, email: 'a@a.a', role: 'admin', name: 'A Admin', organization_id: ORG_A },
  B:    { id: 20, email: 'b@b.b', role: 'admin', name: 'B Admin', organization_id: ORG_B },
  NONE: { id: 30, email: 'orphan@x.x', role: 'admin', name: 'Orphan', organization_id: null },
};

function ctxFor(u) {
  // EXACTLY the shape the live chat dispatcher builds (ai-routes.js, the
  // `const ctx = { userId, orgId: turnOrg.orgId, user: capUser }` block) and
  // the shape POST /api/ai/exec-tool builds. Built here rather than imported so
  // a change to either one shows up as a failure rather than as agreement.
  return { userId: u.id, orgId: u.organization_id, user: u };
}

// DOOR 1 — over real HTTP, through real middleware, with a real JWT.
async function viaHttp(user, name, input) {
  const res = await fetch(baseUrl + '/api/ai/exec-tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + signToken(user) },
    body: JSON.stringify({ name, input: input || {} })
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* non-JSON */ }
  return { status: res.status, body: json, text: flatten(json && json.summary) };
}

// DOOR 2 — the executor, with the ctx the live dispatcher builds. Routed
// through execAgentTool, which is what all three live entry points now use.
async function viaExec(user, name, input) {
  let out;
  try { out = await execAgentTool(name, input || {}, ctxFor(user)); }
  catch (e) { out = 'THREW: ' + (e && e.message); }
  return { text: flatten(out), raw: out };
}

// Flatten the WHOLE value, never a picked field: view_attachment_image returns
// {blocks:[…]} and a leak inside a block must not read as absent.
function flatten(v) {
  if (v == null) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

const DOORS = [
  { path: 'DOOR viaHttp  (POST /api/ai/exec-tool)', call: viaHttp },
  { path: 'DOOR viaExec  (execAgentTool + live ctx)', call: viaExec },
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
beforeEach(() => seed());

// ══════════════════════════════════════════════════════════════════════════
// P1 — the search / list doors. Org A asks with no filter (or a filter that
// matches BOTH tenants' rows) and must see only its own.
// ══════════════════════════════════════════════════════════════════════════

const LIST_DOORS = [
  { id: 'D1',  tool: 'read_past_estimate_lines', input: { q: 'gutters', days: 1825 },
    ownMust: 'ALPHA' },
  { id: 'D2',  tool: 'read_past_estimates',      input: { days: 1825, limit: 50 },
    ownMust: 'ALPHA' },
  { id: 'D3',  tool: 'read_clients',             input: { limit: 100 },
    ownMust: 'Alpha HOA' },
  { id: 'D3b', tool: 'read_clients',             input: { q: 'o', limit: 100 },
    ownMust: 'Alpha HOA' },
  { id: 'D8',  tool: 'read_lead_pipeline',       input: { limit: 200 },
    ownMust: 'Alpha gutters' },
  { id: 'D9',  tool: 'read_existing_clients',    input: { query: 'o' },
    ownMust: 'Alpha HOA' },
  { id: 'D10', tool: 'read_existing_leads',      input: { query: 'o' },
    ownMust: 'Alpha' },
  { id: 'D12', tool: 'read_subs',                input: { status: 'all', limit: 200 },
    ownMust: 'Alpha Roofing' },
  { id: 'D13', tool: 'read_field_tools',         input: {},
    ownMust: 'Alpha Punch Sheet' },
  { id: 'D17', tool: 'read_schedule_blocks',     input: {},
    ownMust: 'ALPHA' },
];

DOORS.forEach((door) => {
  describe(`${door.path} — P1: a list door serves only the caller's tenant`, () => {
    LIST_DOORS.forEach((d) => {
      test(`${d.id} ${d.tool} — org-A caller never sees org-B rows`, async () => {
        const r = await door.call(USERS.A, d.tool, d.input);
        expect(r.text).not.toContain(MARK);
      });

      test(`${d.id} ${d.tool} — org-A caller STILL sees its own rows (the feature survives)`, async () => {
        const r = await door.call(USERS.A, d.tool, d.input);
        expect(r.text).toContain(d.ownMust);
      });

      test(`${d.id} ${d.tool} — the SAME call from org B sees org B, and not org A`, async () => {
        // The mirror case. A predicate that returned nothing to everyone would
        // satisfy the assertion above and break the product; this is what says
        // the door still works, from the other side.
        const r = await door.call(USERS.B, d.tool, d.input);
        expect(r.text).toContain(MARK);
        expect(r.text).not.toContain('Alpha');
      });

      test(`${d.id} ${d.tool} — an ORG-LESS caller gets NOTHING, and is told so`, async () => {
        const r = await door.call(USERS.NONE, d.tool, d.input);
        expect(r.text).not.toContain(MARK);
        expect(r.text).not.toContain('Alpha');
        // P2: visibly refused. Not an empty list, not "no rows found" — those
        // read as "there is no such data", which is a different claim.
        expect(r.text).toMatch(/Refused|not attached to an organization/i);
      });
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// P1 + P2 — the ROW-KEYED doors. Here the refusal must be INDISTINGUISHABLE
// from absence, or the door is an existence oracle over every affiliate's ids.
// ══════════════════════════════════════════════════════════════════════════

const ROW_DOORS = [
  { id: 'D4',  tool: 'read_entity',          own: { entity_type: 'client', id: 'c-ALPHA', depth: 'full' },
    foreign: { entity_type: 'client', id: 'c-victim', depth: 'full' },
    absent:  { entity_type: 'client', id: 'c-does-not-exist', depth: 'full' },
    ownMust: 'Alpha HOA' },
  { id: 'D5',  tool: 'read_entity',          own: { entity_type: 'lead', id: 'l-a1', depth: 'full' },
    foreign: { entity_type: 'lead', id: 'l-b1', depth: 'full' },
    absent:  { entity_type: 'lead', id: 'l-nope', depth: 'full' },
    ownMust: 'Alpha gutters' },
  { id: 'D6',  tool: 'read_attachment_text', own: { attachment_id: 'att-a1' },
    foreign: { attachment_id: 'att-b1' },
    absent:  { attachment_id: 'att-nope' },
    ownMust: 'ALPHA extracted scope text' },
  { id: 'D7',  tool: 'view_attachment_image', own: { attachment_id: 'att-a-img' },
    foreign: { attachment_id: 'att-b-img' },
    absent:  { attachment_id: 'att-nope' },
    ownMust: null },   // the own case needs real bytes; asserted separately below
  { id: 'D11', tool: 'read_photo_comments',  own: { attachment_id: 'att-a1' },
    foreign: { attachment_id: 'att-b1' },
    absent:  { attachment_id: 'att-nope' },
    ownMust: 'alpha comment on the scope' },
  { id: 'D14', tool: 'read_qb_cost_lines',   own: { jobId: 'j-a1' },
    foreign: { jobId: 'j-b1' },
    absent:  { jobId: 'j-nope' },
    ownMust: 'Alpha Supply' },
  { id: 'D15', tool: 'read_building_breakdown', own: { jobId: 'j-a1' },
    foreign: { jobId: 'j-b1' },
    absent:  { jobId: 'j-nope' },
    ownMust: 'ALPHA Building One' },
  { id: 'D16', tool: 'read_job_pct_audit',   own: { jobId: 'j-a1' },
    foreign: { jobId: 'j-b1' },
    absent:  { jobId: 'j-nope' },
    ownMust: null },   // the audit prints findings, not the job title
];

DOORS.forEach((door) => {
  describe(`${door.path} — P1/P2: a row-keyed door refuses foreign ids as absent`, () => {
    ROW_DOORS.forEach((d) => {
      test(`${d.id} ${d.tool} — a FOREIGN id yields none of the foreign row`, async () => {
        const r = await door.call(USERS.A, d.tool, d.foreign);
        expect(r.text).not.toContain(MARK);
      });

      test(`${d.id} ${d.tool} — a foreign id and an ABSENT id answer identically`, async () => {
        // The existence-oracle property. Before this, a caller could walk
        // another tenant's id space and learn which ids were real.
        const foreignR = await door.call(USERS.A, d.tool, d.foreign);
        const absentR  = await door.call(USERS.A, d.tool, d.absent);
        const norm = (s) => s.replace(/att-b1|att-b-img|c-victim|l-b1|j-b1|att-nope|c-does-not-exist|l-nope|j-nope/g, '<ID>');
        expect(norm(foreignR.text)).toBe(norm(absentR.text));
      });

      if (d.ownMust) {
        test(`${d.id} ${d.tool} — the caller's OWN row still reads`, async () => {
          const r = await door.call(USERS.A, d.tool, d.own);
          expect(r.text).toContain(d.ownMust);
        });
      }

      test(`${d.id} ${d.tool} — an ORG-LESS caller reads nothing`, async () => {
        const r = await door.call(USERS.NONE, d.tool, d.foreign);
        expect(r.text).not.toContain(MARK);
      });
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// P3 — the legitimate feature. Scoped to the TENANT, not to the entity.
// ══════════════════════════════════════════════════════════════════════════

describe('P3 — cross-JOB history inside the org still works', () => {
  test('read_past_estimate_lines still spans EVERY estimate in the org, not one', async () => {
    // Two org-A estimates, one org-B. The answer must carry both org-A lines
    // — a fix that scoped this to a single estimate would break the whole
    // point of the tool ("what did we charge for gutters last year").
    const r = await viaExec(USERS.A, 'read_past_estimate_lines', { q: 'gutters', days: 1825, limit: 100 });
    expect(r.text).toContain('ALPHA seamless gutters');
    expect(r.text).toContain('ALPHA2 seamless gutters');
    expect(r.text).not.toContain(MARK);
  });

  test('the unit-cost ANCHOR is computed from the org\'s own history', async () => {
    // The anchor is the number the model quotes as a price. It has to be built
    // from rows the caller owns; org B's 987654-dollar estimate must not move
    // it. Both org-A lines cost 11.25, so the whole range collapses onto it.
    const r = await viaExec(USERS.A, 'read_past_estimate_lines', { q: 'gutters', days: 1825, limit: 100 });
    expect(r.text).toContain('Unit-cost anchor');
    expect(r.text).toContain('$11.25');
    // THREE: the two org-A estimates plus the legacy NULL-org one, which the
    // tolerance arm deliberately still serves. Org B's row is not in it — if
    // it were, the range would not have collapsed onto a single value.
    expect(r.text).toMatch(/3 priced lines/);
    expect(r.text).toContain('range $11.25-$11.25');
  });

  test('read_past_estimates still spans every estimate in the org', async () => {
    const r = await viaExec(USERS.A, 'read_past_estimates', { days: 1825, limit: 50 });
    expect(r.text).toContain('ALPHA Clubhouse');
    expect(r.text).toContain('ALPHA2 Clubhouse');
  });

  test('the legacy NULL-org row is still served (the tolerance arm is policy)', async () => {
    // Tightening to `= $n` would silently orphan every un-stamped row. The
    // `OR organization_id IS NULL` arm is deliberate and is load-bearing until
    // the un-stamped count reaches zero.
    const r = await viaExec(USERS.A, 'read_past_estimates', { days: 1825, limit: 50 });
    expect(r.text).toContain('LEGACY Clubhouse');
  });

  test('the pipeline rollup counts only the caller\'s tenant, and says so', async () => {
    const r = await viaExec(USERS.A, 'read_lead_pipeline', { limit: 200 });
    expect(r.text).toContain('Pipeline rollup');
    expect(r.text).not.toContain(MARK);
    // The sentence the model reads must not claim more than it counted.
    expect(r.text).not.toMatch(/rollup \(all leads\):/);
  });

  test('…and the rollup DOLLARS are the caller\'s, not the platform\'s', async () => {
    // Found by mutation. The assertions above are all on TEXT, and the rollup
    // prints no names — only a status, a count and a dollar figure. So dropping
    // the rollup's own predicate left every one of them green while the number
    // the model quotes silently became the whole platform's pipeline. That is
    // the worst shape a leak can take here: no foreign string appears anywhere,
    // and the answer is simply wrong in the caller's favour-looking direction.
    //
    // Org A: one lead, midpoint (100000+200000)/2 = 150000 -> "$150K".
    // Legacy NULL-org: midpoint 15 -> rounds to "$0K", and is included on
    // purpose (the tolerance arm is policy).
    // Org B: midpoint (900000+1100000)/2 = 1000000. If it were counted the
    // figure would be $1150K.
    const r = await viaExec(USERS.A, 'read_lead_pipeline', { limit: 200 });
    expect(r.text).toMatch(/new=2 \(\$150K\)/);
    expect(r.text).not.toMatch(/\$1150K/);
  });

  test('the rollup from org B is org B\'s, so the predicate is not "return nothing"', async () => {
    const r = await viaExec(USERS.B, 'read_lead_pipeline', { limit: 200 });
    expect(r.text).toMatch(/new=2 \(\$1000K\)/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// P4 — THE OWNER-ORG AXIS. Wrong in both directions.
// ══════════════════════════════════════════════════════════════════════════

describe('P4 — the owner-org axis: the ROW\'s tenant is the answer, not its owner\'s', () => {
  const AXIS_TOOLS = [
    { tool: 'read_qb_cost_lines',      input: (j) => ({ jobId: j }) },
    { tool: 'read_building_breakdown', input: (j) => ({ jobId: j }) },
    { tool: 'read_job_pct_audit',      input: (j) => ({ jobId: j }) },
  ];

  AXIS_TOOLS.forEach((t) => {
    test(`${t.tool} — a job owned by an ORG-LESS user is NOT readable platform-wide`, async () => {
      // The precise cell `JOIN users u … (u.organization_id = $2 OR
      // u.organization_id IS NULL)` got wrong. User 30 has no organization, so
      // the tolerance arm matched for EVERY caller and the org-B row was
      // readable by org A. The row's own organization_id says org B.
      const r = await viaExec(USERS.A, t.tool, t.input('j-b-orphanowner'));
      expect(r.text).not.toContain(MARK);
      expect(r.text).toMatch(/not found|No .*cost lines|no lines/i);
    });

    test(`${t.tool} — …and its real tenant still reads it`, async () => {
      const r = await viaExec(USERS.B, t.tool, t.input('j-b-orphanowner'));
      expect(r.text).not.toMatch(/Job not found/i);
    });

    test(`${t.tool} — a job with NO owner is still readable by its OWN tenant`, async () => {
      // The other direction of the same fault: the INNER JOIN on users dropped
      // an owner-less row entirely, so a tenant could not see its own job.
      const r = await viaExec(USERS.A, t.tool, t.input('j-a-noowner'));
      expect(r.text).not.toMatch(/Job not found/i);
    });
  });

  test('read_schedule_blocks — same axis: owner-less job is not platform-wide…', async () => {
    const r = await viaExec(USERS.A, 'read_schedule_blocks', {});
    expect(r.text).not.toContain(MARK);
  });

  test('read_schedule_blocks — …and an owner-LESS job still shows on its own tenant\'s schedule', async () => {
    const r = await viaExec(USERS.A, 'read_schedule_blocks', {});
    expect(r.text).toContain('ALPHANOOWNER');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// THE STATE-LEVEL BINDING. The properties above are per-door; this one is the
// reason a NEW door does not have to be remembered.
// ══════════════════════════════════════════════════════════════════════════

describe('the tenant gate binds at the dispatcher, not at the call site', () => {
  const TENANT_TOOLS = [
    'read_clients', 'read_past_estimates', 'read_past_estimate_lines',
    'read_lead_pipeline', 'read_subs', 'read_field_tools',
    'read_existing_clients', 'read_existing_leads', 'read_entity',
  ];

  TENANT_TOOLS.forEach((name) => {
    test(`execAgentTool refuses "${name}" outright when ctx carries no org`, async () => {
      const out = flatten(await execAgentTool(name, { limit: 100, q: 'o', query: 'o', entity_type: 'client', id: 'c-victim' }, { userId: 30, orgId: null, user: USERS.NONE }));
      expect(out).not.toContain(MARK);
      expect(out).toMatch(/Refused|not found/i);
    });

    test(`…and refuses "${name}" for a ctx that is entirely absent`, async () => {
      const out = flatten(await execAgentTool(name, { limit: 100, q: 'o', query: 'o', entity_type: 'client', id: 'c-victim' }, undefined));
      expect(out).not.toContain(MARK);
    });
  });

  test('the gate\'s exception list is short, real, and reads no tenant row', () => {
    // An exemption nobody can enumerate is an exemption nobody can review, so
    // the list is asserted rather than trusted. Three properties:
    //   1. it is SMALL — the gate is the boundary, not the list;
    //   2. every name answers to something — a name in a gate is a claim that
    //      a tool exists behind it, and the first draft of this set carried
    //      three (`web_fetch`, `navigate_to`, `open_entity`) that did not;
    //   3. each one is either not tenant data or is keyed on the caller's own
    //      user id, and the reason is written down beside it in the source.
    const names = [...ORGLESS_ALLOWED_TOOLS];
    expect(names.length).toBeLessThanOrEqual(6);
    expect(names.sort()).toEqual(['navigate', 'search_my_kb', 'self_diagnose', 'web_search']);
    // Every EXEMPT name that is reachable through /exec-tool must be a name
    // that endpoint actually allows; the rest are chat-only tools.
    const bogus = names.filter((n) => !ALLOWED_AUTO_TIER_TOOLS.has(n) &&
      !['web_search', 'navigate', 'self_diagnose'].includes(n));
    expect(bogus).toEqual([]);
  });

  test('search_my_kb — the exemption is real: an org-less caller sees ONLY their own uploads', async () => {
    // The exemption's justification, executed. User 30 uploaded nothing, so an
    // org-less caller reaching the one tool the gate lets through still reads
    // no other tenant's file.
    const out = flatten(await execAgentTool('search_my_kb', { query: 'contract' }, { userId: 30, orgId: null, user: USERS.NONE }));
    expect(out).not.toContain(MARK);
    expect(out).not.toContain('alpha');
  });

  test('execIntakeRead now TAKES a ctx — the signature was the finding', () => {
    // It took (name, input). Three call sites, none of which could scope it
    // even if they wanted to. Asserted on the signature because that is the
    // shape of the defect: a boundary that cannot be expressed cannot be held.
    expect(execIntakeRead.length).toBeGreaterThanOrEqual(3);
    expect(execFieldToolRead.length).toBeGreaterThanOrEqual(3);
  });

  test('an org-less caller reaching execIntakeRead DIRECTLY is still refused', async () => {
    // Defence in depth: the gate is at the dispatcher AND the predicate is on
    // the statement, so bypassing one does not reach the rows.
    const out = flatten(await execIntakeRead('read_existing_clients', { query: 'o' }, { userId: 30, orgId: null }));
    expect(out).not.toContain(MARK);
    expect(out).not.toContain('Alpha HOA');
  });

  test('an org-less caller reaching execFieldToolRead DIRECTLY is still refused', async () => {
    const out = flatten(await execFieldToolRead('read_field_tools', {}, { userId: 30, orgId: null }));
    expect(out).not.toContain(MARK);
    expect(out).not.toContain('Alpha Punch Sheet');
  });

  test('an org-less caller reaching execStaffTool DIRECTLY is still refused', async () => {
    const out = flatten(await execStaffTool('read_clients', { limit: 100 }, { userId: 30, orgId: null }));
    expect(out).not.toContain(MARK);
    expect(out).not.toContain('Alpha HOA');
  });

  test('an org-less caller reaching execProjectInlineTool DIRECTLY is still refused', async () => {
    let out;
    try { out = await execProjectInlineTool('read_photo_comments', { attachment_id: 'att-b1' }, { userId: 30, orgId: null }); }
    catch (e) { out = 'THREW: ' + e.message; }
    expect(flatten(out)).not.toContain(MARK);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// The WRITE twin found while scoping its read. add_photo_comment confirmed the
// attachment existed with a bare `WHERE id = $1`, so an org-A caller could
// post a comment onto an org-B photo's thread.
// ══════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════
// D7 was source-confirmed but not executed by the pass that reported it, with
// a note to verify it. Verified here: view_attachment_image is a BYTES door,
// not a metadata door, and the refusal has to stop BEFORE the byte loader.
// ══════════════════════════════════════════════════════════════════════════

describe('view_attachment_image really is a bytes door, and a foreign id never reaches it', () => {
  test('the caller\'s OWN image gets as far as the byte loader', async () => {
    // No object storage under a unit test, so the loader cannot produce
    // pixels — but WHICH failure comes back is the evidence. "Could not load
    // image bytes" / "Failed to load image" means the handler passed the row
    // to loadPhotoAsBlock, i.e. it was on its way to returning the image.
    const r = await viaExec(USERS.A, 'view_attachment_image', { attachment_id: 'att-a-img' });
    expect(r.text).toMatch(/Could not load image bytes|Failed to load image|"type":"image"/);
    expect(r.text).not.toMatch(/No attachment with id/);
  });

  test('a FOREIGN image stops at the boundary and never reaches the byte loader', async () => {
    const r = await viaExec(USERS.A, 'view_attachment_image', { attachment_id: 'att-b-img' });
    expect(r.text).toBe('No attachment with id att-b-img.');
    expect(r.text).not.toMatch(/Could not load image bytes|Failed to load image|"type":"image"/);
  });

  test('…and its own tenant still reaches the loader for it', async () => {
    const r = await viaExec(USERS.B, 'view_attachment_image', { attachment_id: 'att-b-img' });
    expect(r.text).toMatch(/Could not load image bytes|Failed to load image|"type":"image"/);
  });

  test('read_attachment_text: the same split, on the TEXT the door returns', async () => {
    // The own case returns the extracted text itself, so this one is exact.
    const own = await viaExec(USERS.A, 'read_attachment_text', { attachment_id: 'att-a1' });
    expect(own.text).toContain('ALPHA extracted scope text');
    const foreign = await viaExec(USERS.A, 'read_attachment_text', { attachment_id: 'att-b1' });
    expect(foreign.text).toBe('No attachment with id att-b1.');
    // The victim's own tenant is unaffected — this is a boundary, not a lock.
    const theirs = await viaExec(USERS.B, 'read_attachment_text', { attachment_id: 'att-b1' });
    expect(theirs.text).toContain(MARK + ' extracted contract text');
  });
});

describe('add_photo_comment — the write twin of read_photo_comments', () => {
  test('org A cannot post onto an org-B photo\'s thread', async () => {
    const before = engine.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_key = 'attachment:att-b1'").all()[0].n;
    let err = null;
    try { await execProjectInlineTool('add_photo_comment', { attachment_id: 'att-b1', body: 'injected' }, ctxFor(USERS.A)); }
    catch (e) { err = e.message; }
    const after = engine.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_key = 'attachment:att-b1'").all()[0].n;
    expect(after).toBe(before);
    expect(err).toMatch(/not found/i);
  });

  test('…and can still post onto its own', async () => {
    const before = engine.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_key = 'attachment:att-a1'").all()[0].n;
    await execProjectInlineTool('add_photo_comment', { attachment_id: 'att-a1', body: 'legit' }, ctxFor(USERS.A));
    const after = engine.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_key = 'attachment:att-a1'").all()[0].n;
    expect(after).toBe(before + 1);
  });
});
