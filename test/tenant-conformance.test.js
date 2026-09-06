// THE TWO-ORG CONFORMANCE HARNESS — the whole published agent read surface,
// executed against a synthetic second organisation.
//
// ── WHAT THIS FILE IS FOR ─────────────────────────────────────────────────
// Six commits closed real tenant defects on this surface. An independent proof
// then added EIGHT NEW AGENT TOOLS, each with a genuine unpredicated
// cross-tenant read, ran the full suite, and got 156 suites / 4633 tests
// passing. Every guard in the repo missed all eight. The finding was therefore
// not "we missed some" but "WE CANNOT TELL WHEN WE HAVE MISSED SOME", and with
// exactly one organisation in production nothing observable ever proves us
// wrong.
//
// This file is the second organisation. It is CI-ONLY: nothing here runs in
// production, reads an env var, or adds a branch to any hot path. See
// test/tenant-noop-differential.test.js for the proof that the repairs it
// guards are inert on a single-tenant deployment.
//
// ── WHY THE POPULATION IS DERIVED AND NOT LISTED ──────────────────────────
// Five previous guards shaped their population BY HAND or BY CONTENT
// HEURISTIC — "a statement containing an authorship-scoped tenant SELECT", "a
// table named in the classification file", "a `case` label in this switch".
// Attacks A1 and A8 are attacks on exactly that shaping, not on the parsing,
// and they win every time because the author of the attack picks a shape the
// population misses.
//
// So nothing here is listed:
//
//   THE TOOL SET is the union of the eleven exported tool accessors on
//   ai-routes' `internals` with ALLOWED_AUTO_TIER_TOOLS and
//   ORGLESS_ALLOWED_TOOLS — i.e. exactly what the model is offered and what the
//   HTTP door admits. 112 names. A tool the model can call is IN that union by
//   construction; a tool not in it cannot be called. (This needed no production
//   change: the accessors were already exported, and they cover more than a
//   regex over the eleven `*_TOOLS` array literals would — `ClientDirectoryTools`
//   is reachable through `clientTools()` and appears in no `*_TOOLS` array.)
//
//   THE SCHEMA is every table server/db.js creates — all 108, derived by
//   test/helpers/db-schema.js. classify() is never asked what exists, so A1 has
//   nothing to shrink.
//
//   THE WAIVER SET IS DERIVED TOO, and this is the part that matters most. A
//   tool is waived only when `execAgentTool` ITSELF does not dispatch it — the
//   dispatcher is asked, at runtime, and its own answer decides. There is no
//   hand-maintained skip list anybody can quietly add a name to. The COUNT is
//   committed below and fails when it moves.
//
// ── THE THREE ARMS, AND WHY EACH ONE EXISTS ───────────────────────────────
// None of them reads SQL text. That is deliberate and it is what kills A2, A5,
// A6 and A7 at a stroke: a clause that does not filter does not remove rows, a
// /* */ comment does nothing at runtime, and a wrapper executes against the
// same engine. The oracle is what came back.
//
//   ARM 1 — MARK.  Every org-B string carries ZZVICTIMBRAVO. One grep over the
//                  whole flattened answer. Free, deterministic, always on.
//   ARM 2 — POISON. Every org-B number is in [900000000, 1000000000) and every
//                  org-A / un-stamped number is <= 10000. ORG B'S OWN ID IS
//                  900000002. This is what sees the two leaks a marker grep
//                  structurally cannot: A3 (`GROUP BY organization_id` puts
//                  org B's id in its own projection) and A4 (a laundered SUM()
//                  that touched one org-B row lands in the band BY
//                  CONSTRUCTION, because org A's own seed cannot reach it).
//   ARM 3 — DIFFERENTIAL. The same call, same caller, against a world where
//                  ORG B DOES NOT EXIST. Normalized answers must be identical.
//                  This catches the residue neither marker nor magnitude can
//                  see — a bare unscoped `COUNT(*)` returning 3 instead of 2.
//
// ── ARM 3 WAS MEASURED BEFORE IT WAS TRUSTED ──────────────────────────────
// A differential oracle is the only part of this design with a flake surface,
// and a flaky harness gets muted, and a muted harness protects nothing while
// wearing the costume of protection. So it was measured rather than assumed.
//
// AT DESIGN TIME: all 112 doors on empty input, 50 runs each against the same
// engine — 5,600 executions, NON-DETERMINISTIC: 0, in 1.1 seconds. That result
// is why Arm 3 compares the WHOLE normalized answer here instead of the weaker
// numeric multiset a flakier measurement would have forced.
//
// ON EVERY RUN SINCE: the same measurement is repeated with the real input
// recipes, which reach further into the handlers than an empty input does, and
// it finds exactly TWO — `create_property` and `remember`, both of which mint an
// id from Date.now() and print it. They are ledgered below with their reason,
// and that ledger fails IN BOTH DIRECTIONS: a new flaky door is red, and a
// ledgered door that turns out to be stable is red too, so an entry cannot
// outlive the reason for it. Nothing is ever silently skipped, and a door Arm 3
// cannot speak about never counts as proven by it.
//
// ── THE ANTI-LOBOTOMY ARM, WHICH IS NOT OPTIONAL ──────────────────────────
// "The app cannot see its own data" is the failure mode that killed the last
// proposal, and with one tenant there is no upside to trade against it. A
// predicate that returned NOTHING to everybody would satisfy every boundary
// assertion above. Arm 3 is what refuses it: org A's answer must be identical
// to what it is in a world with no org B at all — so it cannot have become
// empty, and it cannot have gained anything either.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const TWO = require('./helpers/two-org');
const { proveOrgOnly } = require('./helpers/org-only');

const { ORG_A, ORG_B, MARK } = TWO;

// A FIXED recent instant, computed once and shared by BOTH worlds. The rolling
// windows in these tools are `NOW() - INTERVAL '7 days'`, so a row has to be
// recent to be in scope at all; taking `new Date()` separately per engine would
// put a different timestamp in each world and make Arm 3 report a difference
// that is an artefact of the fixture rather than of the code.
const RECENT = new Date(Date.now() - 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');

// A poisoned money figure for org B. In the band by construction.
const P = 900007000;

function estBlob(tag, total, unitCost) {
  return JSON.stringify({
    title: tag + ' Clubhouse Re-roof', clientId: 'clients-' + tag,
    totalProposal: total, status: 'sent',
    lines: [{
      id: 'l1', description: tag + ' seamless gutters 6in', qty: 40, unit: 'lf',
      unitCost: unitCost, markup: 42, section: 'Gutters',
    }],
  });
}

function jobBlob(tag, money) {
  return JSON.stringify({
    jobNumber: 'J-' + tag, title: tag + ' Job', clientId: 'clients-' + tag,
    buildings: [{ id: 'b1', name: tag + ' Building One', pctComplete: 50 }],
    phases: [{
      id: 'p1', buildingId: 'b1', name: tag + ' Phase',
      phaseBudget: money, asSoldRevenue: money, pctComplete: 50,
    }],
  });
}

// ── THE OVERLAY ───────────────────────────────────────────────────────────
// The generic seeder in test/helpers/two-org.js already puts three rows in
// every one of the 108 tables, so no door can pass by reading an empty table.
// This overlay only makes the rows the driven doors KEY ON realistic: a jobs
// blob with buildings and phases, an attachment pointing at an estimate that
// exists, JSON where a handler calls JSON.parse.
//
// It sets VALUES ONLY. Every column named here is checked against the derived
// schema before it is written (applyOverlay in the helper), so this overlay
// cannot invent a column — which is the exact failure that let a hand-written
// `attachments.created_at` keep two shipped agent tools green while both raised
// 42703 in production.
//
// EVERY ID IS DERIVED, never typed. TWO.idFor(table, tenant) returns the id the
// generic seeder used, in the type server/db.js declares for that table's key.
// The first draft of this overlay typed them, and got two of them exactly
// backwards: `ai_sessions.id` is BIGSERIAL and `ai_messages.id` is TEXT, not the
// other way round. sqlite answered with the bare words "datatype mismatch" and
// no table name. Deriving the id makes that class of mistake unwritable, and
// makes the overlay and the generic seed incapable of disagreeing about which
// row they mean.
const ID = (t, tag) => TWO.idFor(t, tag);

const OVERLAY = {
  organizations: [
    { id: ORG_A, name: 'Affiliate Alpha', slug: 'alpha' },
    { id: ORG_B, name: MARK + ' Affiliate', slug: 'zzvictimbravo' },
  ],
  roles: [{
    name: 'admin', label: 'Admin',
    capabilities: JSON.stringify(['ESTIMATES_VIEW', 'ESTIMATES_EDIT', 'FINANCIALS_VIEW',
      'INSIGHTS_VIEW', 'JOBS_VIEW', 'LEADS_VIEW', 'CLIENTS_VIEW', 'SUBS_VIEW', 'SCHEDULE_VIEW',
      'TASKS_VIEW', 'FILES_VIEW', 'REPORTS_VIEW', 'JOBS_EDIT', 'LEADS_EDIT', 'CLIENTS_EDIT',
      'ROLES_MANAGE']),
  }],
  users: [
    { id: ID('users', 'A'), organization_id: ORG_A, email: 'a@a.a', name: 'A Admin', role: 'admin', active: 1 },
    { id: ID('users', 'B'), organization_id: ORG_B, email: MARK + '@b.b', name: MARK + ' Admin', role: 'admin', active: 1 },
    { id: ID('users', 'N'), organization_id: null, email: 'n@n.n', name: 'Orphan', role: 'admin', active: 1 },
  ],
  estimates: [
    { id: ID('estimates', 'A'), organization_id: ORG_A, owner_id: ID('users', 'A'), data: estBlob('A-0', 250, 11), is_locked: 0, updated_at: RECENT },
    { id: ID('estimates', 'B'), organization_id: ORG_B, owner_id: ID('users', 'B'), data: estBlob(MARK, P, P), is_locked: 0, updated_at: RECENT },
    { id: ID('estimates', 'N'), organization_id: null, owner_id: null, data: estBlob('N-2', 100, 9), is_locked: 0, updated_at: RECENT },
  ],
  jobs: [
    { id: ID('jobs', 'A'), organization_id: ORG_A, owner_id: ID('users', 'A'), data: jobBlob('A-0', 1000) },
    { id: ID('jobs', 'B'), organization_id: ORG_B, owner_id: ID('users', 'B'), data: jobBlob(MARK, P) },
    { id: ID('jobs', 'N'), organization_id: null, owner_id: null, data: jobBlob('N-2', 10) },
  ],
  clients: [
    { id: ID('clients', 'A'), organization_id: ORG_A, name: 'Alpha HOA', agent_notes: '[]', client_type: 'hoa', city: 'Orlando', activation_status: 'active' },
    { id: ID('clients', 'B'), organization_id: ORG_B, name: MARK + ' Property Group', agent_notes: JSON.stringify([{ body: MARK + ' confidential note' }]), client_type: 'hoa', city: 'Orlando', activation_status: 'active' },
    { id: ID('clients', 'N'), organization_id: null, name: 'Legacy Client', agent_notes: '[]', client_type: 'hoa', city: 'Orlando', activation_status: 'active' },
  ],
  attachments: [
    { id: ID('attachments', 'A'), organization_id: ORG_A, entity_type: 'estimate', entity_id: ID('estimates', 'A'), filename: 'alpha.pdf', mime_type: 'application/pdf', extracted_text: 'ALPHA scope text', uploaded_by: ID('users', 'A'), web_key: 'k/a' },
    { id: ID('attachments', 'B'), organization_id: ORG_B, entity_type: 'estimate', entity_id: ID('estimates', 'B'), filename: MARK + '.pdf', mime_type: 'application/pdf', extracted_text: MARK + ' contract text', uploaded_by: ID('users', 'B'), web_key: 'k/b' },
    { id: ID('attachments', 'N'), organization_id: null, entity_type: 'estimate', entity_id: ID('estimates', 'N'), filename: 'legacy.pdf', mime_type: 'application/pdf', extracted_text: 'LEGACY text', uploaded_by: null, web_key: 'k/n' },
  ],
  qb_cost_lines: [
    { id: ID('qb_cost_lines', 'A'), organization_id: ORG_A, job_id: ID('jobs', 'A'), amount: 150, vendor: 'Alpha Supply' },
    { id: ID('qb_cost_lines', 'B'), organization_id: ORG_B, job_id: ID('jobs', 'B'), amount: P, vendor: MARK + ' Supply' },
    { id: ID('qb_cost_lines', 'N'), organization_id: null, job_id: ID('jobs', 'N'), amount: 7, vendor: 'Legacy Supply' },
  ],
  messages: [
    { id: ID('messages', 'A'), organization_id: ORG_A, thread_key: 'attachment:' + ID('attachments', 'A'), user_id: ID('users', 'A'), body: 'alpha comment', created_at: RECENT },
    { id: ID('messages', 'B'), organization_id: ORG_B, thread_key: 'attachment:' + ID('attachments', 'B'), user_id: ID('users', 'B'), body: MARK + ' comment', created_at: RECENT },
  ],
  ai_messages: [
    { id: ID('ai_messages', 'A'), organization_id: ORG_A, entity_type: 'estimate', estimate_id: ID('estimates', 'A'), user_id: ID('users', 'A'), session_id: ID('ai_sessions', 'A'), role: 'assistant', content: 'alpha turn', model: 'claude-sonnet-5', input_tokens: 10, output_tokens: 20, tool_use_count: 1, tool_uses: '[{"name":"read_jobs"}]', created_at: RECENT },
    { id: ID('ai_messages', 'B'), organization_id: ORG_B, entity_type: 'estimate', estimate_id: ID('estimates', 'B'), user_id: ID('users', 'B'), session_id: ID('ai_sessions', 'B'), role: 'assistant', content: MARK + ' turn', model: 'claude-opus-5', input_tokens: P, output_tokens: P, tool_use_count: 1, tool_uses: '[{"name":"zzvictim_tool"}]', created_at: RECENT },
    { id: ID('ai_messages', 'N'), organization_id: null, entity_type: 'estimate', estimate_id: ID('estimates', 'N'), user_id: ID('users', 'N'), session_id: ID('ai_sessions', 'N'), role: 'assistant', content: 'legacy turn', model: 'claude-sonnet-5', input_tokens: 5, output_tokens: 6, tool_use_count: 0, tool_uses: '[]', created_at: RECENT },
    // ── THE ROW WITHOUT WHICH THE L2 DEFECT IS UNREACHABLE ────────────────
    // An ORG-A thread whose entity id NAMES AN ORG-B ESTIMATE. `ai_messages`
    // .estimate_id is not a foreign key to anything, so this shape is legal and
    // occurs in practice.
    //
    // It is here because of a specific, documented near-miss: when the L2 fix
    // was mutation-tested in `3e2c70a2`, reverting the two batched title
    // lookups killed NO test — the conversation list's own row-stamp predicate
    // already kept foreign ids out of the batch, so the title lookup was never
    // ASKED for one, and a real repair was indistinguishable from its absence.
    // Without this row the harness is green on the pre-repair code for L2, and
    // "green" would mean "not exercised".
    { id: 'am-a-points-at-b', organization_id: ORG_A, entity_type: 'estimate', estimate_id: ID('estimates', 'B'), user_id: ID('users', 'A'), session_id: ID('ai_sessions', 'A'), role: 'assistant', content: 'alpha thread about a foreign id', model: 'claude-sonnet-5', input_tokens: 3, output_tokens: 4, tool_use_count: 0, tool_uses: '[]', created_at: RECENT },
  ],
  // `ai_sessions` names its user-typed string `label`, not `title` — the first
  // draft of this overlay typed `title` and the fixture REFUSED TO LOAD. That
  // refusal is the point: an overlay that could invent a column would be a
  // second schema, and a second schema drifts toward whatever the code under
  // test happens to ask for. It is also the table with no tenant column at all
  // (see the G3 waiver in docs/TENANCY-GRADUATION.md).
  ai_sessions: [
    { id: ID('ai_sessions', 'A'), user_id: ID('users', 'A'), label: 'alpha session', summary: 'alpha summary', entity_type: 'general' },
    { id: ID('ai_sessions', 'B'), user_id: ID('users', 'B'), label: MARK + ' session', summary: MARK + ' summary', entity_type: 'general' },
  ],
};

// ── THE TWO WORLDS, AND THE SWITCHABLE POOL ───────────────────────────────
// Route and tool modules DESTRUCTURE `pool` at module load. A per-test engine
// would therefore leave the code under test reading a database these assertions
// never touch — which produced a TOTAL false green earlier in this wave. So the
// mock hands over a PROXY that forwards per call, and the active engine is
// swapped underneath it.
//
// A FRESH ENGINE PER CALL, and this is not tidiness. Several published tools
// WRITE (create_property, remember, forget), and a shared engine let their
// writes accumulate — the same call answered differently on its second run, and
// the two worlds diverged because one of them had been written to more often
// than the other. That is a fixture artefact presenting as a tenant leak, which
// is the single most expensive kind of false positive: it teaches the next
// reader that this suite cries wolf. Rebuilding costs ~12 ms and removes the
// whole class, so no tool has to be excluded from any arm and there is no
// "these ones are writes" list for anybody to quietly extend.
const freshTwo = () => TWO.buildEngine({ overlay: OVERLAY });
const freshOne = () => TWO.buildEngine({ overlay: OVERLAY, withB: false });

const TWO_ORG = freshTwo();
const ONE_ORG = freshOne();

globalThis.__P86_TC_ACTIVE__ = TWO_ORG;
globalThis.__P86_TC_POOL__ = {
  query: (...a) => globalThis.__P86_TC_ACTIVE__.pool.query(...a),
  connect: (...a) => globalThis.__P86_TC_ACTIVE__.pool.connect(...a),
};

jest.mock('../server/db', () => ({ pool: globalThis.__P86_TC_POOL__ }));

// No network from a unit test. The SDK is constructed at module load.
jest.mock('@anthropic-ai/sdk', () => {
  function FakeAnthropic() { return { messages: {}, beta: {} }; }
  FakeAnthropic.toFile = async () => ({});
  return Object.assign(FakeAnthropic, { toFile: FakeAnthropic.toFile, default: FakeAnthropic });
});

// ── WHY THE ADMIN CONSOLE ROUTER IS REQUIRED UNDER A FAKE CLOCK ───────────
// admin-agents-routes.js:4821-4822 arms a setTimeout AND a setInterval AT
// MODULE LOAD, with the handle deliberately not stored ("process exit cleans
// up"). Correct for a server, fatal for a test worker: the interval holds the
// event loop open, jest force-exits, and a force-exited worker can TRUNCATE A
// FAILURE REPORT. Faking the clock across the require and handing it straight
// back drops both timers.
jest.useFakeTimers();
const express = require('express');
const http = require('http');
const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const aiRoutes = require('../server/routes/ai-routes');
const adminAgentsRoutes = require('../server/routes/admin-agents-routes');
jest.useRealTimers();
const I = aiRoutes.internals;

// ── REGISTER 1: the published tool population, derived ────────────────────
const TOOL_ACCESSORS = [
  'estimateTools', 'jobTools', 'clientTools', 'staffTools', 'subtaskTools',
  'memoryTools', 'projectInlineTools', 'watchTools', 'payloadTools',
  'readTools', 'wave3Tools',
];

function publishedTools() {
  const origin = new Map();
  for (const g of TOOL_ACCESSORS) {
    expect(typeof I[g]).toBe('function');
    for (const t of (I[g]() || [])) {
      if (!t || !t.name) continue;
      if (!origin.has(t.name)) origin.set(t.name, []);
      origin.get(t.name).push(g);
    }
  }
  for (const n of I.ALLOWED_AUTO_TIER_TOOLS) {
    if (!origin.has(n)) origin.set(n, []);
    origin.get(n).push('ALLOWED_AUTO_TIER_TOOLS');
  }
  for (const n of I.ORGLESS_ALLOWED_TOOLS) {
    if (!origin.has(n)) origin.set(n, []);
    origin.get(n).push('ORGLESS_ALLOWED_TOOLS');
  }
  return origin;
}

const ORIGIN = publishedTools();
const ALL_TOOL_NAMES = [...ORIGIN.keys()].sort();

// Input recipes. A tool with no recipe is still DRIVEN, with `{}` — it is never
// skipped. The recipe exists so the door reaches real rows instead of stopping
// at its own argument validation, which is the difference between a case that
// proves something and a case that proves the validator works.
const RECIPES = {
  read_past_estimate_lines:  { q: 'gutters', days: 1825 },
  read_past_estimates:       { days: 1825, limit: 50 },
  read_clients:              { limit: 100 },
  read_entity:               { entity_type: 'client', id: ID('clients', 'A'), depth: 'full' },
  read_attachment_text:      { attachment_id: ID('attachments', 'A') },
  view_attachment_image:     { attachment_id: ID('attachments', 'A') },
  read_photo_comments:       { attachment_id: ID('attachments', 'A') },
  read_qb_cost_lines:        { jobId: ID('jobs', 'A') },
  read_building_breakdown:   { jobId: ID('jobs', 'A') },
  read_job_pct_audit:        { jobId: ID('jobs', 'A') },
  read_active_lines:         { estimate_id: ID('estimates', 'A') },
  read_existing_clients:     { query: 'a' },
  read_existing_leads:       { query: 'a' },
  read_conversation_detail:  { key: 'estimate|' + ID('estimates', 'A') + '|' + ID('users', 'A') },
  read_project_photos:       { project_id: ID('projects', 'A') },
  read_workspace_sheet_full: { sheet_id: ID('plans', 'A') },
  read_materials:            { q: 'a' },
  read_purchase_history:     { days: 365 },
  read_metrics:              { range: '7d' },
  read_recent_conversations: { limit: 20 },
  read_outlook_message:      { message_id: 'x' },
  search_entities:           { entity_type: 'client', q: 'a' },
  search_my_kb:              { q: 'text' },
  search_org_kb:             { q: 'text' },
  search_my_sessions:        { query: 'summary' },
  search_reference_sheet:    { q: 'a' },
  recall:                    { query: 'alpha' },
  remember:                  { topic: 'x', body: 'y' },
  forget:                    { topic: 'x' },
  find_entities_near:        { lat: 28.5, lng: -81.4, radius_miles: 50 },
  web_search:                { query: 'x' },
  draft_email_reply:         { thread_id: 'th_x', body: 'x' },
  add_photo_comment:         { attachment_id: ID('attachments', 'A'), body: 'x' },
  update_client_field:       { client_id: ID('clients', 'A'), fields: { city: 'Tampa' } },
  create_property:           { name: 'x', parent_client_id: ID('clients', 'A') },
  link_property_to_parent:   { property_client_id: ID('clients', 'A'), parent_client_id: ID('clients', 'A') },
};

// THE DISPATCHER DECIDES WHAT IS WAIVED, NOT A LIST IN THIS FILE.
// `execAgentTool` is the one door the three live entry points use. A name it
// answers "Unknown … tool:" to is not reachable through it — those are the
// approval-tier writes, routed by a different executor. They are OUT OF SCOPE
// for a READ boundary (see the ledger test below, which names what holds them)
// and they are COUNTED, so the day one becomes reachable the count moves and
// this file goes red.
const UNKNOWN_RE = /^Unknown (?:staff |approval-tier staff |intake read |memory |Wave 3 |project-inline )?tool:/;

async function callAsOrg(engine, orgId, name, input) {
  const prev = globalThis.__P86_TC_ACTIVE__;
  globalThis.__P86_TC_ACTIVE__ = engine;
  try {
    const ctx = { userId: 100, orgId, user: { id: 100, organization_id: orgId, role: 'admin', email: 'a@a.a' } };
    try { return TWO.flatten(await I.execAgentTool(name, input || {}, ctx)); }
    catch (e) { return 'THREW: ' + (e && e.message); }
  } finally { globalThis.__P86_TC_ACTIVE__ = prev; }
}

// Normalization for Arm 3. Absolute time out; nothing else. It is deliberately
// small — every rule here is a place a leak could hide, so each one has to earn
// its line.
function normalize(s) {
  return String(s)
    .replace(/\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?Z?)?/g, '<TS>')
    .replace(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b[^,\n]{0,24}/g, '<DAY>')
    .replace(/\b\d+\s*(seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s*(ago|from now)/gi, '<REL>');
}

let DISPATCHED = [];
let NOT_DISPATCHED = [];

// ONE PASS, EVERY ARM, FRESH FIXTURES. Each dispatched tool is measured once
// here and the describe blocks below assert on the recording, so a 46-tool
// matrix costs ~140 engine builds instead of one per assertion.
//   twoA / twoA2  the same call, twice, against two IDENTICAL fresh two-org
//                 worlds — the determinism probe.
//   oneA          the same call against a world where org B never existed.
const MEASURED = new Map();

beforeAll(async () => {
  for (const name of ALL_TOOL_NAMES) {
    const out = await callAsOrg(freshTwo(), ORG_A, name, RECIPES[name]);
    if (out.startsWith('THREW: ') && UNKNOWN_RE.test(out.slice(7))) { NOT_DISPATCHED.push(name); continue; }
    DISPATCHED.push(name);
    const twoA = out;
    const twoA2 = await callAsOrg(freshTwo(), ORG_A, name, RECIPES[name]);
    const oneA = await callAsOrg(freshOne(), ORG_A, name, RECIPES[name]);
    MEASURED.set(name, { twoA, twoA2, oneA });
  }
}, 120000);

// ══════════════════════════════════════════════════════════════════════════
// R1 — THE POPULATION IS CLOSED, AND ITS SHAPE IS COMMITTED
// ══════════════════════════════════════════════════════════════════════════
describe('R1 — the published tool population', () => {
  test('every published name is either DRIVEN or DERIVED-WAIVED — none is skipped', () => {
    const covered = new Set([...DISPATCHED, ...NOT_DISPATCHED]);
    const missing = ALL_TOOL_NAMES.filter((n) => !covered.has(n));
    expect(missing).toEqual([]);
    expect(covered.size).toBe(ALL_TOOL_NAMES.length);
  });

  // THE COUNTS ARE THE LEDGER. They fail when they move, which is the pattern
  // test/schema-truth.test.js already enforces and the reason that ledger has
  // not rotted. A new tool lands => this fails => somebody writes a recipe or
  // states, in this file, why it is waived.
  test('the population size is committed (112 published names)', () => {
    expect(ALL_TOOL_NAMES.length).toBe(112);
  });

  test('the DRIVEN / WAIVED split is committed (58 driven, 54 not dispatched by execAgentTool)', () => {
    expect({ driven: DISPATCHED.length, waived: NOT_DISPATCHED.length })
      .toEqual({ driven: 58, waived: 54 });
  });

  // ── THE WAIVER PROPERTY, WHICH FAILS BY NAME RATHER THAN BY ARITHMETIC ───
  // A count alone would let a read tool slip into the waived set as long as a
  // write tool left it in the same commit. So the waiver carries a PREDICATE:
  // nothing that reads may be waived. All 54 currently waived names are writes
  // routed by the approval-tier executor, plus `navigate` (client-side DOM
  // dispatch, ai-routes.js:2141) and `web_search` (an Anthropic SERVER-side tool,
  // declared as `type: 'web_search_20250305'` at :255) — neither of which has a
  // server executor at all, which is why neither can read a tenant row here.
  //
  // The write surface is held by test/agent-write-org-scope.test.js and
  // test/org-write-predicate-invariant.test.js. This file is the READ boundary,
  // end to end; extending it to writes is graduation-era work.
  const READ_SHAPED = /^(read_|search_|list_|view_|recall$|self_diagnose$)/;

  test('NO READ TOOL IS WAIVED — a read the dispatcher does not serve fails here by name', () => {
    const waivedReads = NOT_DISPATCHED.filter((n) => READ_SHAPED.test(n));
    expect(waivedReads).toEqual([]);
  });

  test('every waived name is write-shaped or executor-less, and is listed', () => {
    const EXECUTORLESS = ['navigate', 'web_search'];
    const WRITE_SHAPED = /^(propose_|set_|create_|delete_|add_|merge_|rename_|split_|change_|link_|attach_|assign_|wire_|update_|emit_|scribe_|escalate_|start_|ask_|request_)/;
    const unexplained = NOT_DISPATCHED
      .filter((n) => !WRITE_SHAPED.test(n) && EXECUTORLESS.indexOf(n) === -1);
    expect(unexplained).toEqual([]);
  });

  // A8's closure property, stated behaviourally. A name outside the published
  // union must not be reachable through the dispatcher — otherwise a tool could
  // be smuggled into the executor without ever being published, and no
  // enumeration of the published set would find it.
  test('A8 — a name outside the published union is NOT reachable through execAgentTool', async () => {
    const out = await callAsOrg(freshTwo(), ORG_A, 'zz_unpublished_smuggled_tool', {});
    expect(out.slice(7)).toMatch(UNKNOWN_RE);
  });

  // The HTTP door's own population, asserted rather than assumed. POST
  // /api/ai/exec-tool rejects by name at ai-routes.js:15199, so the set of
  // things an HTTP caller can execute is exactly ALLOWED_AUTO_TIER_TOOLS.
  test('A8 — the HTTP door admits only ALLOWED_AUTO_TIER_TOOLS, and every name on it is published', () => {
    expect(I.ALLOWED_AUTO_TIER_TOOLS.size).toBeGreaterThan(0);
    const unpublished = [...I.ALLOWED_AUTO_TIER_TOOLS].filter((n) => !ORIGIN.has(n));
    expect(unpublished).toEqual([]);
  });

  test('every ORGLESS exemption is a name that actually exists', () => {
    const ghosts = [...I.ORGLESS_ALLOWED_TOOLS].filter((n) => !ORIGIN.has(n));
    expect(ghosts).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// R2 — THE THREE ARMS, PER DOOR. Never a rate.
// ══════════════════════════════════════════════════════════════════════════
describe('R2 — every dispatched tool, against a second organisation', () => {
  test('the driven set is not empty (a harness that drives nothing proves nothing)', () => {
    expect(DISPATCHED.length).toBeGreaterThan(40);
  });

  test('ARM 1 (MARK) — no dispatched tool leaks an org-B string to an org-A caller', () => {
    const leaked = [];
    for (const name of DISPATCHED) {
      const { twoA } = MEASURED.get(name);
      if (TWO.scanAnswer(twoA).marked) leaked.push(name + ' :: ' + twoA.slice(0, 300));
    }
    expect(leaked).toEqual([]);
  });

  test('ARM 2 (POISON) — no dispatched tool leaks an org-B number to an org-A caller', () => {
    const leaked = [];
    for (const name of DISPATCHED) {
      const s = TWO.scanAnswer(MEASURED.get(name).twoA);
      if (s.poisoned.length) leaked.push(name + ' -> ' + s.poisoned.join(',') + ' :: ' + s.text.slice(0, 250));
    }
    expect(leaked).toEqual([]);
  });

  // ── THE NON-DETERMINISTIC LEDGER ────────────────────────────────────────
  // Two published tools MINT AN ID from Date.now() plus a random suffix and
  // print it. They are therefore not comparable across two runs, by
  // construction and not by accident, and Arm 3 CANNOT speak about them.
  //
  // They are not silently skipped and they do not count as proven. They are
  // named here, with the reason, and the ledger FAILS IN BOTH DIRECTIONS: a new
  // flaky door is red, and a door listed here that turns out to be stable is
  // ALSO red, so an entry cannot outlive the reason for it. Arms 1 and 2 still
  // apply to both of them and are asserted above — a minted id is fresh random
  // text and cannot carry the victim's marker or a number in the band.
  const NON_DETERMINISTIC = {
    create_property: 'mints `client_<Date.now()>_<random>` and prints it (execClientDirectoryTool).',
    remember:        'mints `mem_<base36 time>_<random>` and prints it (execMemoryTool).',
  };
  const WAIVED_ND = Object.keys(NON_DETERMINISTIC).sort();

  test('the NON-DETERMINISTIC ledger matches measurement exactly, in both directions', () => {
    const measuredFlaky = DISPATCHED.filter((name) => {
      const { twoA, twoA2 } = MEASURED.get(name);
      return normalize(twoA) !== normalize(twoA2);
    }).sort();
    expect(measuredFlaky).toEqual(WAIVED_ND);
  });

  test('every non-deterministic waiver carries a stated reason', () => {
    for (const n of WAIVED_ND) expect(String(NON_DETERMINISTIC[n]).length).toBeGreaterThan(30);
  });

  test('ARM 3 (DIFFERENTIAL) — org A\'s answer is IDENTICAL in a world with no org B', () => {
    // Simultaneously the leak proof and the ANTI-LOBOTOMY proof: an answer that
    // gained an org-B row differs, and so does an answer that became empty.
    // Both are red, so a repair that broke the product cannot pass by returning
    // nothing to everybody.
    const differing = [];
    for (const name of DISPATCHED) {
      if (WAIVED_ND.indexOf(name) !== -1) continue;   // ledgered above, with a reason
      const { twoA, oneA } = MEASURED.get(name);
      const two = normalize(twoA);
      const one = normalize(oneA);
      if (two !== one) differing.push(name + '\n   two-org: ' + two.slice(0, 260) + '\n   one-org: ' + one.slice(0, 260));
    }
    expect(differing).toEqual([]);
  });

  test('ARM 3 covers all but the two ledgered doors — the covered count is committed', () => {
    expect(DISPATCHED.length - WAIVED_ND.length).toBe(56);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// R3 — SYMMETRY. Vary ONLY the org, holding the caller record fixed.
// ══════════════════════════════════════════════════════════════════════════
describe('R3 — the same caller, two organisations', () => {
  // proveOrgOnly takes ONE caller record and TWO org ids and derives both arms
  // from it. A test written with it CANNOT vary the caller, because there is
  // only one caller in it. That is the whole reason it is a function and not a
  // convention: the old allowlist carried an entry whose stated verification
  // varied the user AND the org together, which proves "another user's data is
  // not yours" — a proposition nobody doubted, and vacuous for tenancy.
  test('a tool that serves org A serves org B its OWN rows for the same caller record', async () => {
    const caller = { id: 100, email: 'a@a.a', role: 'admin', organization_id: ORG_A };
    const { a, b } = await proveOrgOnly({
      caller, orgA: ORG_A, orgB: ORG_B,
      run: (c) => callAsOrg(TWO_ORG, c.organization_id, 'read_clients', { limit: 100 }),
    });
    // Arm A sees Alpha and never the victim.
    expect(a).toContain('Alpha HOA');
    expect(a).not.toContain(MARK);
    // Arm B sees the victim's own row — the boundary MOVED, it did not close
    // over everybody. A predicate that returned nothing to both arms would pass
    // the first assertion and break the product.
    expect(b).toContain(MARK);
    expect(b).not.toContain('Alpha HOA');
  });

  test('an ORG-LESS caller is REFUSED, visibly — not served an empty list', async () => {
    // "Refused" and "does not exist" are different answers. Conflating them is
    // the silent-success class behind every defect in this wave.
    const out = await callAsOrg(TWO_ORG, null, 'read_clients', { limit: 100 });
    expect(out).not.toContain(MARK);
    expect(out).not.toContain('Alpha HOA');
    expect(out).toMatch(/Refused|not attached to an organization/i);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// R2b — THE ADMIN CONSOLE, THROUGH THE SAME ORACLE.
// ══════════════════════════════════════════════════════════════════════════
//
// ── WHY THIS BLOCK EXISTS, AND WHAT ITS ABSENCE PROVED ───────────────────
// The first version of this file drove only agent TOOLS. Run against the real
// pre-repair code at `69f2cabd`, IT PASSED — 42 tests, all green, against a
// tree with three live cross-tenant leaks in it.
//
// That is not a small detail; it is the same failure the whole wave is about.
// The tool surface had already been repaired by `69f2cabd`; the leaks that
// remained were on the admin CONSOLE, and a harness that does not drive a
// surface cannot say anything about it. A green harness with an uncovered
// surface is exactly the "we cannot tell when we have missed some" condition,
// rebuilt one layer up.
//
// So the console routes go through the identical oracle. With this block, the
// harness IS red at `69f2cabd`, on the real defects, not on planted ones.
describe('R2b — the admin agent console, against a second organisation', () => {
  const ADMIN = { id: ID('users', 'A'), email: 'a@a.a', name: 'A Admin', role: 'admin' };

  const ROUTES = [
    ['GET /metrics',          '/api/admin/agents/metrics?range=7d'],
    ['GET /conversations',    '/api/admin/agents/conversations?limit=20'],
    ['GET /managed',          '/api/admin/agents/managed'],
    ['GET /managed/audit',    '/api/admin/agents/managed/audit'],
  ];

  let server, baseUrl;

  beforeAll((done) => {
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/admin/agents', adminAgentsRoutes);
    setRolePool(globalThis.__P86_TC_POOL__);
    refreshRoleCache().then(() => {
      server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => {
        baseUrl = 'http://127.0.0.1:' + server.address().port;
        done();
      });
    });
  });

  afterAll((done) => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(() => done());
  });

  // The caller record is FIXED; only the org it is a member of varies. See
  // test/helpers/org-only.js for why that is the only shape that proves
  // anything about tenancy.
  async function callRoute(engine, orgId, url) {
    const prev = globalThis.__P86_TC_ACTIVE__;
    globalThis.__P86_TC_ACTIVE__ = engine;
    try {
      const res = await fetch(baseUrl + url, {
        headers: {
          authorization: 'Bearer ' + signToken(Object.assign({}, ADMIN, { organization_id: orgId })),
          connection: 'close',
        },
      });
      let body = null;
      try { body = await res.json(); } catch (e) { body = null; }
      return res.status + ' ' + TWO.flatten(body);
    } finally { globalThis.__P86_TC_ACTIVE__ = prev; }
  }

  for (const [label, url] of ROUTES) {
    test(`${label} — ARM 1 (MARK): no org-B string reaches an org-A admin`, async () => {
      const out = await callRoute(freshTwo(), ORG_A, url);
      expect(TWO.scanAnswer(out).marked).toBe(false);
    });

    test(`${label} — ARM 2 (POISON): no org-B number reaches an org-A admin`, async () => {
      const out = await callRoute(freshTwo(), ORG_A, url);
      expect(TWO.scanAnswer(out).poisoned).toEqual([]);
    });

    test(`${label} — ARM 3 (DIFFERENTIAL): identical in a world with no org B`, async () => {
      const two = normalize(await callRoute(freshTwo(), ORG_A, url));
      const one = normalize(await callRoute(freshOne(), ORG_A, url));
      expect(two).toBe(one);
    });

    test(`${label} — the admin can still see their OWN console (anti-lobotomy)`, async () => {
      // The failure mode that killed the previous attempt at this work was a
      // boundary that answered "nothing" to its own tenant. A 2xx is asserted
      // separately from the boundary arms so a lockout cannot hide behind them.
      const out = await callRoute(freshTwo(), ORG_A, url);
      expect(out.slice(0, 3)).toBe('200');
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// R3b — THE MOVED USER. The case the whole wave turns on, given its own
//       fixture because it cannot be expressed in the general one.
// ══════════════════════════════════════════════════════════════════════════
//
// FALSE PREMISE #1 was "a user id is a tenant". `WHERE user_id = $1` answers
// "is this yours", not "is this your COMPANY's". Rows stamp with the author's
// org AT CREATION TIME, and `users.organization_id` is mutable — so anyone who
// ever moves between organisations carries their old rows with them.
//
// EVERY GENERAL CASE ABOVE IS BLIND TO THIS, and not by oversight: the general
// fixture gives org B its own user, so a user-axis filter refuses org B's rows
// for the right answer by the wrong reason, and the test passes while proving
// nothing. The only fixture that can express the premise is one where THE SAME
// USER ID owns a row belonging to the OTHER organisation.
//
// `ai_sessions` is where this bites, because it has NO organization_id column at
// all (19 columns, none of them a tenant) — so `search_my_sessions` cannot
// filter on the row's own tenant even in principle. services/session-search.js
// anchors it through `ai_messages` instead.
describe('R3b — a session the caller authored for their FORMER tenant', () => {
  const MOVED_SESSION = 555;

  function movedFixture(withB) {
    const overlay = JSON.parse(JSON.stringify(OVERLAY));
    // The caller's OWN session (user 100) whose messages are stamped org B.
    overlay.ai_sessions = overlay.ai_sessions.concat([{
      id: MOVED_SESSION, user_id: ID('users', 'A'), entity_type: 'general',
      label: MARK + ' former tenant thread', summary: MARK + ' former tenant summary',
    }]);
    overlay.ai_messages = overlay.ai_messages.concat([{
      id: 'am-moved', organization_id: ORG_B, entity_type: 'general', estimate_id: null,
      user_id: ID('users', 'A'), session_id: MOVED_SESSION, role: 'assistant',
      content: MARK + ' former tenant turn', model: 'claude-sonnet-5',
      input_tokens: 1, output_tokens: 1, tool_use_count: 0, tool_uses: '[]', created_at: RECENT,
    }]);
    return TWO.buildEngine({ overlay, withB });
  }

  test('search_my_sessions refuses it — the caller\'s own id is NOT proof of tenancy', async () => {
    const out = await callAsOrg(movedFixture(true), ORG_A, 'search_my_sessions', { query: 'tenant' });
    // The row is the caller's by user_id and NOT theirs by tenant. The user axis
    // alone would have served it; the parent anchor through ai_messages is what
    // refuses it.
    expect(out).not.toContain(MARK);
  });

  test('the same session IS served to the caller as a member of org B', async () => {
    // The mirror. Without this the assertion above is satisfied by a predicate
    // that serves nobody, which is a lockout rather than a boundary.
    const out = await callAsOrg(movedFixture(true), ORG_B, 'search_my_sessions', { query: 'tenant' });
    expect(out).toContain(MARK);
  });

  // ── THE DECLINED RESIDUAL, COVERED RATHER THAN CLAIMED CLOSED ───────────
  // services/session-search.js:261 ends its anchor with
  // `OR NOT EXISTS (SELECT 1 FROM ai_messages …)` — a session with NO messages
  // at all has no tenant evidence, and the file chooses to show it rather than
  // hide it. That means a MESSAGE-LESS thread's user-typed label is visible
  // whatever the caller's org.
  //
  // This is named, priced and declined IN THAT FILE. It is covered here so the
  // decision is a test rather than a paragraph: if somebody later closes it,
  // this goes red and the comment gets updated with it; if somebody widens it,
  // this goes red too. What is NOT acceptable is for it to change silently.
  test('RESIDUAL (declined, not a regression): a MESSAGE-LESS session has no tenant evidence and is shown', async () => {
    const overlay = JSON.parse(JSON.stringify(OVERLAY));
    overlay.ai_sessions = overlay.ai_sessions.concat([{
      id: 556, user_id: ID('users', 'A'), entity_type: 'general',
      label: MARK + ' orphan thread', summary: MARK + ' orphan summary',
    }]);
    const out = await callAsOrg(TWO.buildEngine({ overlay }), ORG_A, 'search_my_sessions', { query: 'orphan' });
    expect(out).toContain(MARK);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// R4 — A1, STATED AS A REPORT RATHER THAN AS A GATE
// ══════════════════════════════════════════════════════════════════════════
describe('R4 — classify() is checked, never consulted', () => {
  // THE POPULATION ABOVE DOES NOT ASK classify() ANYTHING. That is what kills
  // A1: a table cannot be dropped from a population that is already every table
  // db.js creates. This block is the REPORT — a table carrying organization_id
  // that nobody has classified is where the next hole lives, and it must be
  // visible BY NAME rather than silently absent.
  const KNOWN_UNCLASSIFIED = ['email_attachments', 'live_participants', 'live_rooms'];

  test('the set of unclassified tenant-carrying tables is committed and named', () => {
    expect(TWO.unclassifiedTenantTables().sort()).toEqual(KNOWN_UNCLASSIFIED.slice().sort());
  });

  test('the count is committed — it fails when it moves, in either direction', () => {
    expect(TWO.unclassifiedTenantTables().length).toBe(3);
  });

  test('all three are nonetheless IN the fixture, seeded, with a marked victim row', () => {
    for (const t of KNOWN_UNCLASSIFIED) {
      expect(TWO.ALL_TABLES).toContain(t);
      const rows = TWO_ORG.all('SELECT organization_id FROM ' + t);
      expect(rows.length).toBe(3);
      expect(rows.map((r) => r.organization_id).sort()).toEqual([null, ORG_A, ORG_B].sort());
    }
  });

  // 108 -> 109 on 4d8d0c8a, which added `report_shares` (the report share-link
  // portal's schema). Recorded rather than silently bumped: THIS IS THE LEDGER
  // DOING ITS JOB. A table landed from another session, this number moved, the
  // suite went red on `main`, and a human had to look at what arrived and say
  // out loud that the fixture now seeds it — three rows, org A / org B /
  // un-stamped, like every other table, with no curation step. A count that
  // never fails is a count nobody is keeping.
  test('the fixture carries every table server/db.js creates (109) — nothing curated out', () => {
    expect(TWO.ALL_TABLES.length).toBe(109);
  });
});
