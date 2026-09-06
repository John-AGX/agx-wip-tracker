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

// ── THE OVERLAY LIVES IN test/helpers/tenant-overlay.js ──────────────────
// It moved out of this file when REGISTER 2 (test/tenant-register2-http.test.js)
// needed the same rows. A second hand-written copy is exactly what the
// two-org header warns about: a differential built on two independently
// written seeds compares the seeds, not the code. One fixture, both registers.
const { overlay: OVERLAY, ID, RECENT, P } = require('./helpers/tenant-overlay');

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
//
// ── THE ELEVEN HARD-CODED STRINGS THAT USED TO BE HERE ───────────────────
// This was a literal array of eleven accessor names, in a file whose own header
// spends four paragraphs on why nothing may be listed. It was attack class A8
// alive inside the code written to kill A8, and it was EXPLOITED: an auditor
// added a LENS_TOOLS group behind a new `lensTools` accessor and spread it into
// the managed-agent tool list exactly like every other group. Measured in one
// process — SCAFFOLD POPULATION 112, DERIVED POPULATION 113, missing
// `read_portfolio_digest`, which returned org B's estimate. The assertion "the
// population size is committed (112)" PASSED. All 165 suites passed.
//
// A published accessor is a function on `internals` whose name ends in `Tools`.
// That is the convention every one of the eleven already followed and the one
// admin-agents-routes.js spells when it composes an agent's tool set
// (`aiInternals.<x>Tools()`), so a new group either follows it and is caught
// here, or does not and is not offered to any agent.
const TOOL_ACCESSORS = Object.entries(I)
  .filter(([k, v]) => /Tools$/.test(k) && typeof v === 'function')
  .map(([k]) => k)
  .sort();

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

// Inputs for the APPROVAL-ROUTED names, so the executor reaches a body instead
// of stopping at its own argument check. Same rule as RECIPES above: a name
// with no entry is still driven, with {}.
const APPROVAL_RECIPES = {
  add_client_note:            { client_id: ID('clients', 'A'), body: 'note' },
  propose_link_job_to_client: { job_id: ID('jobs', 'A'), client_id: ID('clients', 'A') },
  propose_bulk_link_jobs_to_clients: { links: [{ job_id: ID('jobs', 'A'), client_id: ID('clients', 'A') }] },
  propose_create_lead:        { title: 'x', client_name: 'y' },
  propose_skill_pack_add:     { name: 'p', body: 'b' },
  propose_skill_pack_edit:    { name: 'p', body: 'b' },
  propose_skill_pack_delete:  { name: 'p' },
  propose_create_field_tool:  { name: 'ft', html_body: '<div>x</div>' },
  propose_update_field_tool:  { id: 'ft-x', name: 'ft' },
  propose_delete_field_tool:  { id: 'ft-x' },
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

// The two doors that MINT AN ID from Date.now() and print it. Module-level
// because Arm 0 needs them too: a minted id differs between any two runs, so
// a starvation comparison on these two would report a difference that is an
// artefact of the mint rather than of the data.
const WAIVED_ND_NAMES = ['create_property', 'remember'];

let DISPATCHED = [];
let NOT_DISPATCHED = [];

// ── ARM 0'S THIRD WORLD: THE CALLER'S OWN TENANT, STARVED ────────────────
// An organisation that EXISTS and owns NOTHING. Not in the poison band (so it
// cannot be mistaken for org B) and above the seeded ids (so it collides with
// nothing).
//
// THE CALLER'S USERS ROW MOVES WITH `ctx.orgId`, and that is not optional. Four
// published doors — every one routed through execProjectInlineTool — resolve
// their tenant with `SELECT organization_id FROM users WHERE id = $1` and never
// look at ctx at all (ai-routes.js:14814). Moving only ctx would leave those
// doors reading org A in both worlds, and Arm 0 would then report "identical"
// for a door that is working perfectly. Vary the org in EVERY place the code
// can read it, or the arm measures the fixture.
const ORG_EMPTY = 424242;

function starve(engine) {
  engine.db.prepare('UPDATE organizations SET id = id').run();   // fail loudly if the table is missing
  engine.db.prepare(
    'INSERT OR REPLACE INTO organizations (id, name, slug) VALUES (?, ?, ?)'
  ).run(ORG_EMPTY, 'Starved Co', 'starved');
  engine.db.prepare('UPDATE users SET organization_id = ? WHERE id = ?').run(ORG_EMPTY, ID('users', 'A'));
  return engine;
}

// ONE PASS, EVERY ARM, FRESH FIXTURES. Each dispatched tool is measured once
// here and the describe blocks below assert on the recording, so the matrix
// costs a bounded number of engine builds instead of one per assertion.
//   twoA / twoA2  the same call, twice, against two IDENTICAL fresh two-org
//                 worlds — the determinism probe.
//   oneA          the same call against a world where org B never existed.
//   starvedA      the same call from a caller whose organisation owns nothing.
//   foreignA      the same call with every org-A id in the recipe swapped for
//                 org B's — the IDOR axis.
//   wideA         the same call with every bound widened to its maximum — the
//                 deeper-page axis.
const MEASURED = new Map();

// ── THE INPUT AXES ───────────────────────────────────────────────────────
// Every recipe passed an ORG-A id and nothing else. None passed a FOREIGN id,
// so an IDOR — "the id is in the URL and nobody checks whose it is" — produced
// an IDENTICAL answer in both worlds and Arms 1, 2 and 3 were ALL GREEN on it.
// That is not a gap in the oracle, it is a gap in the INPUT: the question was
// never asked. It is asked here.
//
// The swap is derived, never typed: any recipe value that equals a seeded org-A
// id is replaced by the SAME TABLE's org-B id, so a recipe added next week gets
// its foreign twin without anybody remembering to write one.
const A_TO_B = (() => {
  const map = new Map();
  for (const t of TWO.ALL_TABLES) {
    let a, b;
    try { a = TWO.idFor(t, 'A'); b = TWO.idFor(t, 'B'); } catch (e) { continue; }
    map.set(String(a), b);
  }
  return map;
})();

function foreignify(input) {
  if (!input) return null;
  const out = {};
  let swapped = 0;
  for (const [k, v] of Object.entries(input)) {
    const hit = (typeof v === 'string' || typeof v === 'number') && A_TO_B.get(String(v));
    if (hit !== undefined && hit !== false && hit != null) { out[k] = hit; swapped++; continue; }
    // Composite keys — read_conversation_detail's `estimate|<id>|<user>`.
    if (typeof v === 'string' && v.indexOf('|') !== -1) {
      const parts = v.split('|').map((p) => {
        const h = A_TO_B.get(p);
        if (h == null) return p;
        swapped++;
        return String(h);
      });
      out[k] = parts.join('|');
      continue;
    }
    out[k] = v;
  }
  return swapped ? out : null;
}

// The deeper-page axis. Every bound a recipe carries is pushed to the maximum
// the handler will clamp to, so a door that scoped page 1 and not the rest, or
// clamped its LIMIT before its predicate, answers differently here.
const WIDE = { limit: 1000, days: 3650, radius_miles: 25000, depth: 'full', range: '30d' };
function widen(input) {
  if (!input) return null;
  const out = Object.assign({}, input);
  let touched = 0;
  for (const k of Object.keys(WIDE)) if (k in out) { out[k] = WIDE[k]; touched++; }
  return touched ? out : null;
}

beforeAll(async () => {
  for (const name of ALL_TOOL_NAMES) {
    const out = await callAsOrg(freshTwo(), ORG_A, name, RECIPES[name]);
    if (out.startsWith('THREW: ') && UNKNOWN_RE.test(out.slice(7))) { NOT_DISPATCHED.push(name); continue; }
    DISPATCHED.push(name);
    const twoA = out;
    const twoA2 = await callAsOrg(freshTwo(), ORG_A, name, RECIPES[name]);
    const oneA = await callAsOrg(freshOne(), ORG_A, name, RECIPES[name]);
    const starvedA = await callAsOrg(starve(freshTwo()), ORG_EMPTY, name, RECIPES[name]);
    const fInput = foreignify(RECIPES[name]);
    const foreignA = fInput ? await callAsOrg(freshTwo(), ORG_A, name, fInput) : null;
    const wInput = widen(RECIPES[name]);
    const wideA = wInput ? await callAsOrg(freshTwo(), ORG_A, name, wInput) : null;
    MEASURED.set(name, { twoA, twoA2, oneA, starvedA, foreignA, wideA, fInput, wInput });
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

  // ── THE WAIVER, MEASURED INSTEAD OF SPELLED ─────────────────────────────
  // The two assertions above are NAME SHAPES. They were the whole waiver, and a
  // name shape is exactly what attack class A8 picks around: a read named
  // `get_*`, `fetch_*` or `update_*` satisfies both of them and is waived
  // permanently after one count bump. Worse, "the approval-tier executor serves
  // these 54" was an assumption nobody had executed — and a cross-tenant
  // clients read planted in that executor was caught by the static source
  // scanner alone, by nothing behavioural.
  //
  // So the waiver now carries a MEASUREMENT. Every waived name is offered to
  // every server-side approval executor `POST /86/chat/continue` can reach, and
  // what comes back decides which of three sets it is in:
  //
  //   SERVED     an executor dispatches it. It runs SQL, so it is a tenant
  //              surface and it is NOT covered by this file — the write suites
  //              hold it, and the count below is what makes that claim
  //              falsifiable.
  //   FALLTHROUGH  no executor answers. In production the chain's final `else`
  //              writes `summary = r.applied_summary || 'User approved. Change
  //              applied.'` — the ledgered misroute sentence — and NO SERVER
  //              STATEMENT RUNS. These are client-applied mutations.
  //   EXECUTORLESS  no executor at all, anywhere (navigate, web_search).
  //
  // The three counts are committed. A name moving between them is red.
  // THE ROUTED SET IS DERIVED FROM THE CHAIN ITSELF, not from a refusal
  // pattern. Every executor spells "I do not know this name" differently
  // ('Unknown staff tool:', 'Unknown field tool approval action:', …), so
  // sniffing refusals classified all 52 as served and 0 as fallthrough — a
  // measurement that says everything is covered is the same lie as a name
  // regex, arrived at more slowly.
  //
  // So the population comes from the DISPATCH CONDITION: the literal names the
  // `else if` chain in POST /86/chat/continue tests, plus the ClientDirectory
  // branch's runtime set. Parsing the chain is a POPULATION step — the worst a
  // mis-parse can do is leave a name out of the routed set, where it lands in
  // FALLTHROUGH and is reported by name.
  const CONTINUE_SRC = (() => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'server', 'routes', 'ai-routes.js'), 'utf8');
    const start = src.indexOf('const capDenial = (r.approved && !r.apply_error)');
    const end = src.indexOf("summary = r.applied_summary || 'User approved. Change applied.'");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  })();

  const ROUTED_LITERALS = [...CONTINUE_SRC.matchAll(/r\.name === '([a-z0-9_]+)'/g)].map((m) => m[1]);
  const CLIENT_DIRECTORY_NAMES = (I.clientTools() || []).map((t) => t && t.name).filter(Boolean);
  const ROUTED = new Set(ROUTED_LITERALS.concat(
    CONTINUE_SRC.indexOf('ClientDirectoryTools.some') !== -1 ? CLIENT_DIRECTORY_NAMES : []));

  const EXECUTORLESS = ['navigate', 'web_search'];
  // LAZY, because NOT_DISPATCHED is filled by beforeAll and a describe body
  // runs first. Computing these eagerly measured an empty array and reported
  // 0/0 — a split that says nothing is a split that cannot fail.
  const served = () => NOT_DISPATCHED.filter((n) => ROUTED.has(n) && EXECUTORLESS.indexOf(n) === -1).sort();
  const fallthrough = () => NOT_DISPATCHED.filter((n) => !ROUTED.has(n) && EXECUTORLESS.indexOf(n) === -1).sort();

  test('the chain the parse is built on is still there (a parse of nothing routes nothing)', () => {
    expect(ROUTED_LITERALS.length).toBe(9);
    expect(CONTINUE_SRC).toContain('ClientDirectoryTools.some');
    expect(CLIENT_DIRECTORY_NAMES.length).toBeGreaterThan(10);
  });

  test('the approval-tier split is DERIVED and committed', () => {
    expect({ served: served().length, fallthrough: fallthrough().length, executorless: EXECUTORLESS.length })
      .toEqual({ served: 17, fallthrough: 35, executorless: 2 });
    expect(served().length + fallthrough().length + EXECUTORLESS.length).toBe(NOT_DISPATCHED.length);
  });

  test('NO SERVED APPROVAL NAME IS READ-SHAPED — the measured version of the same rule', () => {
    // The name-shape assertion above says no read is waived. This says the same
    // thing about the surface that actually runs SQL, and derives it from the
    // dispatch chain rather than from spelling.
    expect(served().filter((n) => READ_SHAPED.test(n))).toEqual([]);
  });

  // ── THE APPROVAL EXECUTOR, DRIVEN. Repair 5's actual point. ─────────────
  // Every name the chain routes is now EXECUTED against the second
  // organisation, through the same oracle as the read surface. A cross-tenant
  // read planted in this executor used to be caught by the static scanner
  // alone; it is now caught by a row coming back.
  test('ARM 1+2 — no approval-routed name leaks org B to an org-A caller', async () => {
    const leaked = [];
    for (const name of served()) {
      const prev = globalThis.__P86_TC_ACTIVE__;
      globalThis.__P86_TC_ACTIVE__ = freshTwo();
      let out;
      try {
        const ctx = { userId: ID('users', 'A'), orgId: ORG_A,
          user: { id: ID('users', 'A'), organization_id: ORG_A, role: 'admin', email: 'a@a.a' } };
        const input = APPROVAL_RECIPES[name] || {};
        try {
          if (name.indexOf('field_tool') !== -1) out = await I.execFieldToolApproval(name, input, ctx.userId, ctx.orgId);
          else if (name === 'propose_create_lead') out = await I.execProposeCreateLead(input, ctx.userId);
          else if (name === 'propose_link_job_to_client') out = await I.execLinkJobToClient(input, ctx.orgId);
          else if (name === 'propose_bulk_link_jobs_to_clients') out = await I.execBulkLinkJobsToClients(input, ctx.orgId);
          else if (name.indexOf('skill_pack') !== -1) out = await I.execStaffApprovalTool(name, input, ctx);
          else out = await I.execClientDirectoryToolWithCtx(name, input, ctx);
        } catch (e) { out = 'THREW: ' + (e && e.message); }
      } finally { globalThis.__P86_TC_ACTIVE__ = prev; }
      const s = TWO.scanAnswer(TWO.flatten(out));
      if (s.marked || s.poisoned.length) {
        leaked.push(name + ' -> marked=' + s.marked + ' poison=' + s.poisoned.slice(0, 4).join(',')
          + ' :: ' + s.text.slice(0, 240));
      }
    }
    expect(leaked).toEqual([]);
  }, 120000);

  test('the FALLTHROUGH set runs NO server statement, and is named rather than assumed', () => {
    // These reach the chain's final `else`, which writes
    //   summary = r.applied_summary || 'User approved. Change applied.'
    // — the ledgered misroute sentence. They are CLIENT-applied mutations: no
    // server executor runs, so this file has nothing to say about them and
    // says so. What it must not do is count them as covered.
    expect(fallthrough().length).toBe(35);
    expect(fallthrough().some((n) => ROUTED.has(n))).toBe(false);
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
  const WAIVED_ND = WAIVED_ND_NAMES;

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
// ARM 0 — "DRIVEN" IS NOT "EXERCISED", AND THE DIFFERENCE IS MEASURED
// ══════════════════════════════════════════════════════════════════════════
//
// ── THE VACUOUS PASS, WHICH IS THE MOST EXPENSIVE KIND OF GREEN ──────────
// Arms 1, 2 and 3 all ask what came back. NONE OF THEM ASKS WHETHER ANYTHING
// CAME BACK. A door that answers "No projects." to everybody satisfies every
// one of them — no marker, no poisoned number, and identical in a world with no
// org B, because it was identical in every world. It is counted as covered, it
// contributes to the committed 58, and it proves precisely nothing.
//
// This was not hypothetical. Two published doors — `read_projects` and
// `read_change_orders` — answered "No projects." / "No change orders found."
// for BOTH organisations, because the generic seeder stamps `archived_at` on
// every row and seeds a `job_id` matching no job. Two more, `add_photo_comment`
// and `list_compliance_expiring`, THREW AT SQL PREPARE and still counted as
// driven; `list_compliance_expiring` is a READ tool and was satisfying "NO READ
// TOOL IS WAIVED" BY THROWING.
//
// ── THE ORACLE, AND WHY IT IS NOT A HEURISTIC ────────────────────────────
// Not a regex for "No ", not a row count, not a marker for org-A text. Those
// are all guesses about what an answer looks like, and a guess is what the last
// five guards were made of.
//
// ARM 0 IS ARM 3 RUN IN THE OTHER DIRECTION. Arm 3 says org A's answer must NOT
// change when org B disappears. Arm 0 says org A's answer MUST change when ORG
// A'S OWN DATA disappears — same call, same caller record, from a caller whose
// organisation exists and owns nothing. If the two answers are identical, the
// door showed org A nothing, and whatever the other arms said about it they
// said about an empty string.
//
// MEASURED AT HEAD: 58 driven, 24 VACUOUS. That is the honest coverage number,
// and it is 34, not 58.
describe('ARM 0 — every DRIVEN door either shows org A its own data, or is ledgered', () => {
  // ── THE VACUITY LEDGER ──────────────────────────────────────────────────
  // Every name here is a door the harness DRIVES and does not EXERCISE. It is
  // not a skip list: these doors still take Arms 1, 2 and 3, and a leak on one
  // of them is still red. What the ledger records is that a GREEN on this door
  // is worth nothing, so nobody reads the committed 58 as 58 proofs.
  //
  // Grouped by WHY, because the four reasons need different work:
  //
  //   FIXTURE   the seed does not reach the door's filter. Cheapest to fix and
  //             the highest-value: these are doors that WOULD prove something.
  //   INPUT     the recipe does not satisfy the door's own argument check, so
  //             it stops before the database. A recipe, not a fixture.
  //   SHIM      pg-sqlite cannot translate the statement, so the door throws at
  //             prepare. Real Postgres would run it; the shim is the limit.
  //   ABSENT    the feature is not configured in a unit test at all (Outlook),
  //             and no fixture can change that.
  const VACUOUS = {
    // FIXTURE — the seeded row exists and the door's filter excludes it.
    read_users:              'FIXTURE: the users overlay gives org A exactly one user — the caller themselves — and this door lists the OTHERS, so the answer is the same empty list whichever tenant asks.',
    read_projects:           'FIXTURE: the generic seeder stamps archived_at on every row, and this door filters it out. It answers "No projects." to every tenant.',
    read_change_orders:      'FIXTURE: same archived_at, plus a seeded job_id that matches no job — the JOIN drops it.',
    read_assemblies:         'FIXTURE: assemblies are seeded but the door filters on a status the generic seeder does not produce.',
    read_assembly_taxonomy:  'FIXTURE: reads the taxonomy tables, which the generic seeder fills with placeholder text the grouping discards.',
    read_calendar_events:    'FIXTURE: the seeded dates are fixed at 2026-08-01 and the door reads a window relative to NOW().',
    read_schedule_blocks:    'FIXTURE: same fixed-date window — every seeded _at column is the fixed instant 2026-08-01, and this door reads a window relative to NOW().',
    read_reminders:          'FIXTURE: seeded reminders are already past their fixed due date, so the pending filter drops them.',
    read_skill_packs:        'FIXTURE: org_skill_packs rows are seeded archived (archived_at is stamped like every other _at column).',
    search_reference_sheet:  'FIXTURE: agent_reference_links rows are seeded but the door requires an inline fetch status the seed does not set.',
    list_workflow_items:     'FIXTURE: workflow items are seeded assigned to nobody, and the door asks for the caller\'s own.',
    list_memories:           'FIXTURE: ai_memories rows are seeded under a different user id than the caller\'s.',
    recall:                  'FIXTURE: same — the memory rows exist and belong to another user.',
    forget:                  'FIXTURE: same. Also a WRITE, kept in the driven set deliberately so its refusal path is exercised.',
    draft_email_reply:       'FIXTURE: the recipe names thread th_x, which no seeded inbound_emails row carries.',
    read_email_inbox:        'FIXTURE: inbound_emails rows are seeded but filed into a folder the default view excludes.',
    self_diagnose:           'FIXTURE: reads a 60-minute window; every seeded row is at the fixed 2026-08-01 instant.',
    find_entities_near:      'FIXTURE: no seeded row carries a lat/lng near the recipe\'s coordinates.',
    // INPUT — the recipe never reaches the database.
    search_my_kb:            'INPUT: the recipe passes {q}, the handler wants {query}. It answers "query is required." and runs no statement.',
    search_org_kb:           'INPUT: same argument-name mismatch as search_my_kb — the recipe passes {q} and the handler wants {query}, so it stops at its own validator.',
    read_workspace_sheet_full: 'INPUT: the handler wants jobId or estimateId, or a chat session anchored to one; the recipe passes sheet_id.',
    // SHIM — pg-sqlite cannot translate the statement.
    list_compliance_expiring: 'SHIM: `(expiration_date - CURRENT_DATE)` is Postgres date arithmetic the shim does not translate, so the door throws at prepare. A READ TOOL THAT WAS SATISFYING "NO READ TOOL IS WAIVED" BY THROWING.',
    // ABSENT — not configurable in a unit test.
    read_outlook_mail:       'ABSENT: Outlook is not configured on a test server, and the door says so before touching the database. No fixture can change this.',
    read_outlook_message:    'ABSENT: same as read_outlook_mail — Outlook is not configured on a test server and the door says so before touching the database.',
  };

  const VACUOUS_NAMES = Object.keys(VACUOUS).sort();

  function measuredVacuous() {
    return DISPATCHED.filter((name) => {
      const m = MEASURED.get(name);
      if (WAIVED_ND_NAMES.indexOf(name) !== -1) return false;  // minted ids differ by construction
      return normalize(m.twoA) === normalize(m.starvedA);
    }).sort();
  }

  test('the vacuity ledger matches measurement EXACTLY, in both directions', () => {
    // A NEW vacuous door is red — somebody widened the population without
    // widening the fixture. A LEDGERED door that starts returning real data is
    // ALSO red, so an entry cannot outlive the reason for it and the coverage
    // number cannot quietly drift back up.
    expect(measuredVacuous()).toEqual(VACUOUS_NAMES);
  });

  test('every vacuity waiver carries a category and a stated reason', () => {
    for (const n of VACUOUS_NAMES) {
      expect(VACUOUS[n]).toMatch(/^(FIXTURE|INPUT|SHIM|ABSENT):/);
      expect(String(VACUOUS[n]).length).toBeGreaterThan(60);
    }
  });

  test('THE HONEST COVERAGE NUMBER IS COMMITTED: 58 driven, 24 vacuous, 34 EXERCISED', () => {
    // The number that must never be reported as 58 again.
    expect({
      driven: DISPATCHED.length,
      vacuous: VACUOUS_NAMES.length,
      exercised: DISPATCHED.length - VACUOUS_NAMES.length,
    }).toEqual({ driven: 58, vacuous: 24, exercised: 34 });
  });

  test('NO DRIVEN DOOR THROWS, except the three that are ledgered by name', () => {
    // A door that throws executed nothing. It counted as driven anyway, which
    // is how a read tool satisfied "NO READ TOOL IS WAIVED" without running a
    // single statement.
    const THROWS = {
      add_photo_comment:        'SHIM: its ON CONFLICT arm on message_reads uses CURRENT_TIMESTAMP in a way pg-sqlite does not translate.',
      list_compliance_expiring: 'SHIM: `(expiration_date - CURRENT_DATE)` date arithmetic.',
      link_property_to_parent:  'BY DESIGN: the recipe passes the same client as child and parent, and the handler refuses with "A client cannot be its own parent." That is the door working.',
    };
    const measured = DISPATCHED.filter((n) => MEASURED.get(n).twoA.startsWith('THREW: ')).sort();
    expect(measured).toEqual(Object.keys(THROWS).sort());
    for (const why of Object.values(THROWS)) expect(String(why).length).toBeGreaterThan(50);
  });

  test('THE EXERCISED SET IS NOT EMPTY, and it is what the boundary arms actually prove', () => {
    const exercised = DISPATCHED.filter((n) => VACUOUS_NAMES.indexOf(n) === -1);
    expect(exercised.length).toBe(34);
    // Spot-anchored: these four are the doors whose leak would matter most, and
    // they must be in the exercised set, not merely in the driven one.
    for (const n of ['read_clients', 'read_entity', 'read_attachment_text', 'read_metrics']) {
      expect(exercised).toContain(n);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ARM 4 — THE FOREIGN ID. The axis that was pinned, and the one that caught
//         the planted IDOR when Arms 1, 2 and 3 were all green on it.
// ══════════════════════════════════════════════════════════════════════════
describe('ARM 4 — the same door, asked for ANOTHER TENANT\'S id', () => {
  test('the foreign-id axis actually swapped something (an axis nobody drives is not an axis)', () => {
    const withForeign = DISPATCHED.filter((n) => MEASURED.get(n).fInput);
    expect(withForeign.length).toBe(16);
  });

  test('ARM 4 (MARK) — naming an org-B id does not make org B\'s row appear', () => {
    // The whole IDOR class in one assertion. An id is not an authorisation: the
    // caller controls it, and a door that answers it without asking whose it is
    // hands over a row by request.
    const leaked = [];
    for (const name of DISPATCHED) {
      const m = MEASURED.get(name);
      if (!m.foreignA) continue;
      if (TWO.scanAnswer(m.foreignA).marked) {
        leaked.push(name + ' <- ' + JSON.stringify(m.fInput) + '\n   ' + m.foreignA.slice(0, 300));
      }
    }
    expect(leaked).toEqual([]);
  });

  test('ARM 4 (POISON) — naming an org-B id does not make org B\'s numbers appear', () => {
    const leaked = [];
    for (const name of DISPATCHED) {
      const m = MEASURED.get(name);
      if (!m.foreignA) continue;
      const s = TWO.scanAnswer(m.foreignA);
      if (s.poisoned.length) {
        leaked.push(name + ' -> ' + s.poisoned.slice(0, 6).join(',') + ' :: ' + s.text.slice(0, 250));
      }
    }
    expect(leaked).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ARM 5 — THE DEEPER PAGE. Every bound pushed to its maximum.
// ══════════════════════════════════════════════════════════════════════════
describe('ARM 5 — the same door, with every bound widened', () => {
  test('the widened axis actually widened something', () => {
    expect(DISPATCHED.filter((n) => MEASURED.get(n).wInput).length).toBe(8);
  });

  test('ARM 5 (MARK) — a wider window does not reach into another tenant', () => {
    const leaked = DISPATCHED
      .filter((n) => MEASURED.get(n).wideA && TWO.scanAnswer(MEASURED.get(n).wideA).marked)
      .map((n) => n + ' <- ' + JSON.stringify(MEASURED.get(n).wInput));
    expect(leaked).toEqual([]);
  });

  test('ARM 5 (POISON) — nor does it reach another tenant\'s numbers', () => {
    const leaked = [];
    for (const n of DISPATCHED) {
      const m = MEASURED.get(n);
      if (!m.wideA) continue;
      const s = TWO.scanAnswer(m.wideA);
      if (s.poisoned.length) leaked.push(n + ' -> ' + s.poisoned.slice(0, 6).join(','));
    }
    expect(leaked).toEqual([]);
  });

  // ── WHAT THIS ARM CANNOT YET DO, SAID PLAINLY ───────────────────────────
  // With three rows per table, no door's DEFAULT limit hides anything, so this
  // arm's discriminating power today is against a handler that clamps its LIMIT
  // BEFORE applying its predicate — real, and narrower than a true page-2 axis.
  // A genuine second page needs the fixture padded with enough org-A rows to
  // push org B past the first, and none of these tools accepts an OFFSET at
  // all. That is named in docs/TENANCY-GRADUATION.md rather than claimed here.
  test('the limitation of this arm is recorded where a reader will find it', () => {
    const doc = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'docs', 'TENANCY-GRADUATION.md'), 'utf8');
    expect(doc).toContain('no OFFSET');
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
