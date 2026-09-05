// THE ADMIN AGENT CONSOLE'S READ SURFACE, EXECUTED PER PATH AGAINST TWO ORGS.
//
// WHY THIS FILE EXISTS
// Six commits closed tenant defects on the transactional surface. The ADMIN
// CONSOLE was not in any of them, and it is the surface with the widest read
// per request: one call to /metrics returns a whole tenant's usage profile
// already summed, and one call to /managed/audit NAMES every tenant on the
// platform. Three leaks were open at 69f2cabd and every one of them was
// reachable by an ordinary org admin holding ROLES_MANAGE.
//
//   L1  GET /metrics — SIX ai_messages aggregates with no tenant predicate,
//       in a handler that had already resolved `orgId` and spent it on four
//       OTHER statements. Turn counts, distinct-conversation counts, unique
//       users, token totals, cache ratio, TOOL NAMES BY FREQUENCY, MODEL MIX —
//       and `cost_usd`, which is a dollar figure computed off those sums, so
//       the card rendered every affiliate's Anthropic bill added together and
//       labelled it as this org's.
//   L2  GET /conversations/:key — the message BODY was scoped by an earlier
//       commit; the `entity_title` beside it was read three lines later BY THE
//       ID IN THE URL with no predicate. An enumeration oracle over every
//       tenant's job and estimate NAMES, 200 per hit, no write required. Same
//       defect in batched form on the /conversations LIST, whose own tenant
//       filter was the OWNER AXIS in subquery spelling.
//   L3  GET /managed had NO WHERE CLAUSE AT ALL. GET /managed/audit named
//       organization_id FOUR TIMES — projection, LEFT JOIN ON, and twice in
//       ORDER BY — and filtered on NONE of them, which is precisely the class
//       "the query mentions organization_id, so it filters by it" describes.
//
// ── THE PROPERTY, AND WHY IT NEEDS THIS SHAPE ─────────────────────────────
// P1  VARY ONLY THE ORG. Every case runs through proveOrgOnly, which takes ONE
//     caller record and two organisation ids and derives both arms from it. A
//     test that varied the user too would prove "another user's data is not
//     yours", which nobody doubted and which is vacuous for tenancy. The
//     helper's signature makes the vacuous version unwritable.
// P2  SINGLE-TENANT PRODUCTION IS BYTE-IDENTICAL. Production has exactly one
//     organisation. Every assertion about the fix is paired with an assertion
//     that a ONE-ORG world answers exactly what 69f2cabd answered — same
//     counts, same rows, to the digit. That pairing is the deliverable: the
//     leak closes and today's numbers do not move.
// P3  REFUSED IS NOT ABSENT, AND NEVER EMPTY. /managed for an org-less
//     non-system-admin answers 403 with a sentence, not `{agents: []}`. An
//     empty list wearing a 200 reads as "you have no managed agents", which is
//     a wrong answer that looks like a right one — the silent-success class
//     behind every defect in this wave.
// P4  THE PLATFORM VIEW SURVIVES, BEHIND THE CAPABILITY THAT PROMISED IT.
//     SYSTEM_ADMIN still sees the whole registry. The seeded system_admin
//     description sells "cross-org metrics" and "Anthropic-account-wide
//     resources"; the seeded admin description says a tenant admin does NOT see
//     cross-tenant operations. The fix moves the view, it does not delete it.
// P5  THE ADMIN CAN STILL SEE THEIR OWN CONSOLE. Asserted separately and
//     first-class, because the failure mode that killed the previous attempt at
//     this was a boundary that answered "nothing" to its own tenant.
//
// ── WHY A REAL SQL ENGINE, AND WHY THE SCHEMA IS NOT TYPED HERE ───────────
// The claim is "which rows came back", which is a property of the WHERE clause
// — the one thing a hand-written fake pool cannot be trusted to evaluate. The
// statements the handlers actually emit go to node:sqlite via
// test/helpers/pg-sqlite.js, which throws loudly on anything it cannot
// translate rather than returning {rows: []}. Three of the six /metrics
// statements could NOT be executed by that shim when this file was written
// (the 3-tuple COUNT(DISTINCT …), the set-returning call in the SELECT list,
// and the FROM alias without AS); extending it was part of the work, because a
// statement that cannot be run is a statement whose predicate cannot be proved.
//
// The schema is DERIVED from server/db.js by test/helpers/db-schema.js and not
// typed out here. A hand-written fixture is a second schema, it drifts toward
// whatever the code under test happens to ask for, and it hid a live 42703 for
// four rounds.
//
// The engine is installed on globalThis BEFORE the route module is required,
// because the route DESTRUCTURES `pool` at module load: a per-test engine would
// leave the handler reading a database these assertions never touch, which
// produced a total false green earlier in this wave.

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const express = require('express');
const http = require('http');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');
const { proveOrgOnly } = require('./helpers/org-only');

const TABLES = [
  'organizations', 'users', 'roles',
  'ai_messages', 'ai_sessions',
  'agent_jobs', 'payloads', 'ai_memories', 'org_mcp_servers',
  'managed_agent_registry', 'agent_reference_links',
  'estimates', 'jobs',
];

const engine = createPgSqlite(
  sqliteSchema(TABLES, {
    pk: {
      organizations: 'id', users: 'id', roles: 'name', ai_messages: 'id',
      estimates: 'id', jobs: 'id', managed_agent_registry: 'agent_key',
      agent_reference_links: 'id',
    },
  }),
  { jsonColumns: ['tool_uses', 'packs_loaded'] }
);

globalThis.__P86_ADMIN_CONSOLE_ENGINE__ = engine;
jest.mock('../server/db', () => ({ pool: globalThis.__P86_ADMIN_CONSOLE_ENGINE__.pool }));

// Constructed at module load. Nothing here reaches the model — every assertion
// is about which rows a handler read.
jest.mock('@anthropic-ai/sdk', () => {
  function FakeAnthropic() { return { messages: {}, beta: { agents: { retrieve: async () => { throw Object.assign(new Error('no network'), { status: 404 }); } } } }; }
  FakeAnthropic.toFile = async () => ({});
  return Object.assign(FakeAnthropic, { toFile: FakeAnthropic.toFile, default: FakeAnthropic });
});

const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const adminAgentsRoutes = require('../server/routes/admin-agents-routes');

let server, baseUrl;

const ORG_A = 1;   // the caller's tenant
const ORG_B = 2;   // the victim

// Every org-B row carries this marker. Cases grep the WHOLE flattened response
// rather than a picked field, so a leak arriving somewhere this file did not
// anticipate cannot read as absent.
const MARK = 'ZZVICTIMBRAVO';

// THE CALLER. One record, used for both arms — proveOrgOnly clones it per org
// and refuses if the id ever differs between them.
const CALLER = { id: 10, email: 'a@a.a', name: 'A Admin', role: 'admin' };
// The same person again, holding SYSTEM_ADMIN. Used only for P4.
const OWNER = { id: 11, email: 'owner@p86.test', name: 'Platform Owner', role: 'system_admin' };

// ── seeding ───────────────────────────────────────────────────────────────
// Written for BOTH tenants and for a legacy NULL-org row at every table, so a
// case cannot be arranged to hit or to miss the defect by its own setup.

function seedTwoOrgs() {
  engine.db.exec(`
    DELETE FROM ai_messages; DELETE FROM ai_sessions; DELETE FROM agent_jobs;
    DELETE FROM payloads; DELETE FROM ai_memories; DELETE FROM org_mcp_servers;
    DELETE FROM managed_agent_registry; DELETE FROM agent_reference_links;
    DELETE FROM jobs; DELETE FROM estimates; DELETE FROM users;
    DELETE FROM roles; DELETE FROM organizations;

    INSERT INTO organizations (id, name, slug) VALUES
      (1, 'Affiliate Alpha', 'alpha'),
      (2, '${MARK} Construction', 'victim');

    -- ONE caller record. Its organization_id is deliberately org A here; every
    -- case overrides it per arm through proveOrgOnly, and the handler resolves
    -- the org from the JWT claim the arm carries.
    INSERT INTO users (id, email, name, role, organization_id, active) VALUES
      (10, 'a@a.a',            'A Admin',        'admin',        1, 1),
      (11, 'owner@p86.test',   'Platform Owner', 'system_admin', 1, 1),
      (12, 'orgless@p86.test', 'Orgless Admin',  'admin',     NULL, 1);

    INSERT INTO roles (name, label, capabilities) VALUES
      ('admin', 'Org Admin', '["ROLES_MANAGE","ADMIN_METRICS","USERS_MANAGE"]'),
      ('system_admin', 'System Admin', '["ROLES_MANAGE","ADMIN_METRICS","USERS_MANAGE","SYSTEM_ADMIN"]');
  `);

  // ── ai_messages: the /metrics population ────────────────────────────────
  // DELIBERATELY ASYMMETRIC. The first version of this fixture gave the two
  // tenants the same shape, and the shared legacy row then made several of the
  // nine numbers COINCIDE across the arms — a fixture in which a half-scoped
  // statement can land on the right answer for the wrong reason. Every one of
  // the nine now differs between the arms AND differs from the platform total,
  // so each assertion has two ways to catch a regression.
  const msg = engine.db.prepare(
    `INSERT INTO ai_messages
       (id, entity_type, estimate_id, user_id, role, content, model,
        input_tokens, output_tokens, cache_creation_input_tokens,
        cache_read_input_tokens, tool_use_count, tool_uses, photos_included,
        session_id, organization_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, CURRENT_TIMESTAMP)`);

  // Token counts are at PRODUCTION SCALE (millions), not 100s. cost_usd is
  // rounded to CENTS by the handler, so a fixture priced in hundreds of tokens
  // rounds every tenant's bill to $0.00 and the two arms then agree — a
  // cost-leak assertion that can never fail. Model ids are real entries from
  // services/ai-pricing for the caller's own turns, so the dollar figure is
  // computed by the same table production uses.
  const M = 1000000;
  const turn = (id, org, user, entity, entityId, role, model, inTok, tools) =>
    msg.run(id, entity, entityId, user, role, id + ' body', model,
      inTok, inTok == null ? null : Math.round(inTok / 10), 5, 7, tools ? 1 : 0,
      tools ? JSON.stringify(tools) : null, 1, null, org);

  // ORG A — the caller's own console. Every axis is deliberately SMALLER than
  // org B's, and carries at least one value org B does not have (the
  // claude-sonnet-4-6 model, the ask86 surface, the read_job_pct_audit tool) —
  // otherwise org A's distinct sets would be a SUBSET of org B's and the
  // platform total would coincide with org B's own, leaving those three
  // assertions unable to fail.
  turn('a-u1', ORG_A, 10, 'estimate', 'e-a1', 'user',      null,                 null, null);
  turn('a-t1', ORG_A, 10, 'estimate', 'e-a1', 'assistant', 'claude-opus-4-8',    1 * M, [{ name: 'read_clients' }]);
  turn('a-t2', ORG_A, 10, 'job',      'j-a1', 'assistant', 'claude-sonnet-4-6',  2 * M, [{ name: 'escalate_to_86' }]);
  turn('a-t3', ORG_A, 10, 'job',      'j-a1', 'assistant', 'claude-opus-4-8',     null, null);      // unmetered
  turn('a-t4', ORG_A, 10, 'ask86',    'q-a1', 'assistant', 'claude-sonnet-4-6',  3 * M, [{ name: 'read_job_pct_audit' }]);

  // ORG B — the victim. Bigger on every axis, distinguishable in every string,
  // so a leak shows up both as a number that is too large AND as a name.
  turn('b-u1', ORG_B, 10, 'estimate', 'e-b1', 'user',      null,                 null, null);
  turn('b-u2', ORG_B, 10, 'job',      'j-b1', 'user',      null,                 null, null);
  turn('b-t1', ORG_B, 10, 'estimate', 'e-b1', 'assistant', MARK + '-model',      1 * M, [{ name: MARK + '_tool' }]);
  turn('b-t2', ORG_B, 10, 'job',      'j-b1', 'assistant', MARK + '-model',      2 * M, [{ name: 'escalate_to_86' }]);
  turn('b-t3', ORG_B, 10, 'job',      'j-b1', 'assistant', MARK + '-model',       null, null);      // unmetered
  turn('b-t4', ORG_B, 10, 'intake',   'i-b1', 'assistant', MARK + '-model2',     4 * M, [{ name: MARK + '_tool' }]);
  turn('b-t5', ORG_B, 10, 'job',      'j-b1', 'assistant', MARK + '-model',       null, [{ name: 'escalate_to_86' }]); // escalation AND unmetered
  turn('b-t6', ORG_B, 10, 'staff',    's-b1', 'assistant', MARK + '-model2',     5 * M, [{ name: MARK + '_tool2' }]);
  turn('b-t7', ORG_B, 10, 'estimate', 'e-b1', 'assistant', MARK + '-model',      1 * M, null);

  // ── THE ROWS THAT MAKE THE BATCHED TITLE LOOKUP REACHABLE ───────────────
  // Two ai_messages rows stamped ORG A whose entity id names an ORG B entity.
  // Not a contrivance: `ai_messages.estimate_id` is not a foreign key to
  // anything — it is whatever the chat surface stamped, including the literal
  // '__global__' sentinel — so an org-A turn naming an id the user typed, or a
  // moved user's thread, produces exactly this row.
  //
  // WITHOUT THEM THE LIST'S TITLE FIX IS UNTESTABLE, AND THE MUTATION RUN SAID
  // SO. Reverting the two batched title lookups on their own left this suite
  // fully green, because the list's row-stamp predicate had already kept every
  // foreign id out of the batch — so the title statements were never asked for
  // one. A fix nothing can distinguish from its absence is not proved by a
  // green suite; it is unmeasured. These rows put a foreign id INTO the batch
  // through a legitimately-owned row, which is the only way the title lookup is
  // the thing being tested.
  //
  // input_tokens 0 (not NULL) and no tools, so they add nothing to the token,
  // unmetered, tool or model counts and the other seven assertions keep their
  // meaning.
  turn('a-x1', ORG_A, 10, 'estimate', 'e-b1', 'assistant', 'claude-opus-4-8', 0, null);
  turn('a-x2', ORG_A, 10, 'job',      'j-b1', 'assistant', 'claude-opus-4-8', 0, null);

  // THE LEGACY ROW. Un-stamped, and it is what makes the tolerance arm a
  // decision rather than an accident: it must stay visible, because on a
  // single-tenant deployment these are the caller's OWN pre-migration turns.
  // It is admitted to BOTH arms — the residual this commit does not close, and
  // the reason `organization_id NOT NULL` is on the graduation checklist rather
  // than being quietly assumed here.
  turn('legacy-t1', null, 10, 'estimate', 'e-a1', 'assistant', 'claude-opus-4-8', M / 2, [{ name: 'read_clients' }]);

  // ── entity titles: the L2 oracle ────────────────────────────────────────
  const est = engine.db.prepare('INSERT INTO estimates (id, owner_id, organization_id, data) VALUES (?,?,?,?)');
  est.run('e-a1', 10, ORG_A, JSON.stringify({ title: 'Alpha Clubhouse Re-roof' }));
  est.run('e-b1', 10, ORG_B, JSON.stringify({ title: MARK + ' Tower Re-roof' }));
  est.run('e-legacy', null, null, JSON.stringify({ title: 'Legacy Estimate' }));

  const job = engine.db.prepare('INSERT INTO jobs (id, owner_id, organization_id, data) VALUES (?,?,?,?)');
  job.run('j-a1', 10, ORG_A, JSON.stringify({ name: 'Alpha Gutter Replacement' }));
  job.run('j-b1', 10, ORG_B, JSON.stringify({ name: MARK + ' Roof Tear-off' }));
  job.run('j-legacy', null, null, JSON.stringify({ name: 'Legacy Job' }));

  // ── the four statements that were ALREADY scoped ────────────────────────
  // Seeded so a regression that DROPS an existing predicate shows up here too.
  engine.db.prepare('INSERT INTO agent_jobs (id, organization_id, status, title, agent_key, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, created_at) VALUES (?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)')
    .run('bg-a', ORG_A, 'done', 'Alpha background job', 'job', 10, 10, 0, 0);
  engine.db.prepare('INSERT INTO agent_jobs (id, organization_id, status, title, agent_key, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, created_at) VALUES (?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)')
    .run('bg-b', ORG_B, 'done', MARK + ' background job', 'job', 10, 10, 0, 0);

  // ── managed_agent_registry: the L3 population ───────────────────────────
  const reg = engine.db.prepare(
    'INSERT INTO managed_agent_registry (agent_key, anthropic_agent_id, model, tool_count, skill_count, organization_id) VALUES (?,?,?,?,?,?)');
  reg.run('job',       'agt_alpha_job',   'claude-opus-5',  40, 3, ORG_A);
  reg.run('scribe',    'agt_' + MARK,     MARK + '-model',  10, 1, ORG_B);
  reg.run('assistant', 'agt_orphan',      'claude-haiku-5', 5,  0, null);
}

// A SINGLE-TENANT WORLD. The same fixture with org B and everything stamped to
// it removed — which is what production is. Used to prove the fix moves no
// number that a one-org deployment can see.
function seedSingleTenant() {
  seedTwoOrgs();
  engine.db.exec(`
    -- The two cross-pointing org-A rows go too. They exist only to put a
    -- FOREIGN id into the batched title lookup, and in a world with one
    -- organisation there is no foreign entity for them to name.
    DELETE FROM ai_messages           WHERE id IN ('a-x1', 'a-x2');
    DELETE FROM ai_messages           WHERE organization_id = ${ORG_B};
    DELETE FROM estimates             WHERE organization_id = ${ORG_B};
    DELETE FROM jobs                  WHERE organization_id = ${ORG_B};
    DELETE FROM agent_jobs            WHERE organization_id = ${ORG_B};
    DELETE FROM managed_agent_registry WHERE organization_id = ${ORG_B};
    DELETE FROM organizations         WHERE id = ${ORG_B};
  `);
}

// ── the door ──────────────────────────────────────────────────────────────
// Real express, real router, real requireAuth, real requireCapability, real
// JWT. The caller record decides the org, and nothing else does.
async function get(caller, path) {
  const res = await fetch(baseUrl + path, {
    headers: { authorization: 'Bearer ' + signToken(caller) },
  });
  let body = null;
  try { body = await res.json(); } catch (e) { /* non-JSON */ }
  return { status: res.status, body, text: JSON.stringify(body) };
}

beforeAll(async () => {
  setRolePool(engine.pool);
  seedTwoOrgs();
  await refreshRoleCache();
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/admin/agents', adminAgentsRoutes);
  await new Promise((done) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => { baseUrl = 'http://127.0.0.1:' + server.address().port; done(); });
  });
});
afterAll((done) => { server.close(() => done()); });
beforeEach(() => seedTwoOrgs());

// ══════════════════════════════════════════════════════════════════════════
// L1 — GET /metrics. Six statements, asserted individually, never as a rate.
// ══════════════════════════════════════════════════════════════════════════

describe('L1 GET /metrics — the six unpredicated ai_messages aggregates', () => {
  // Each entry names ONE of the six statements, the field it lands in, each
  // tenant's OWN answer, and `all` — what the statement returned at 69f2cabd,
  // i.e. over the whole table. Reported per statement: a route that fixed five
  // of six must fail five times over, not score 83%.
  //
  // `all` is stated per row rather than derived as `a + b`, because it is not
  // a sum for four of the nine: `conversations`, `surfaces`, `tools_top` and
  // `models` are DISTINCT counts and the shared legacy row belongs to both
  // arms' groups. A test that assumed additivity would have asserted a number
  // the unscoped route never produced, and passed while proving nothing.
  const STATEMENTS = [
    { id: 'aggSql:turns',         pick: (r) => r.agent86.turns,            a: 7,       b: 8,        all: 14 },
    { id: 'aggSql:user_msgs',     pick: (r) => r.agent86.user_msgs,        a: 1,       b: 2,        all: 3 },
    { id: 'aggSql:conversations', pick: (r) => r.agent86.conversations,    a: 5,       b: 5,        all: 7 },
    { id: 'aggSql:input_tokens',  pick: (r) => r.agent86.tokens.input,     a: 6500000, b: 13500000, all: 19500000 },
    { id: 'surfaceSql',           pick: (r) => r.agent86.surfaces.length,  a: 3,       b: 4,        all: 5 },
    { id: 'toolSql',              pick: (r) => r.agent86.tools_top.length, a: 3,       b: 4,        all: 5 },
    { id: 'modelSql',             pick: (r) => r.agent86.models.length,    a: 2,       b: 3,        all: 4 },
    { id: 'escalations',          pick: (r) => r.agent86.escalations,      a: 1,       b: 2,        all: 3 },
    { id: 'unmetered',            pick: (r) => r.agent86.unmetered_turns,  a: 1,       b: 2,        all: 3 },
  ];

  test.each(STATEMENTS)('$id answers each tenant its OWN total, never the platform total', async ({ pick, a, b, all }) => {
    const { a: resA, b: resB } = await proveOrgOnly({
      caller: CALLER, orgA: ORG_A, orgB: ORG_B,
      run: (caller) => get(caller, '/api/admin/agents/metrics?range=7d'),
    });
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    // P5 FIRST — the admin still sees their own console. Named first because a
    // boundary that answers nothing to its own tenant is the failure that
    // killed the previous attempt at this.
    expect(pick(resA.body)).toBe(a);
    expect(pick(resB.body)).toBe(b);
    // …and the leak, stated as the literal the unscoped statement returned.
    expect(pick(resA.body)).not.toBe(all);
    expect(pick(resB.body)).not.toBe(all);
  });

  test('the victim tenant NEVER appears by name — model mix and tool names', async () => {
    const { a } = await proveOrgOnly({
      caller: CALLER, orgA: ORG_A, orgB: ORG_B,
      run: (caller) => get(caller, '/api/admin/agents/metrics?range=7d'),
    });
    // Flattened, not field-picked: modelSql and toolSql both project a raw
    // string straight out of the other tenant's rows.
    expect(a.text).not.toContain(MARK);
    expect(a.body.agent86.models.map((m) => m.model).sort())
      .toEqual(['claude-opus-4-8', 'claude-sonnet-4-6']);
    expect(a.body.agent86.tools_top.map((t) => t.name).sort())
      .toEqual(['escalate_to_86', 'read_clients', 'read_job_pct_audit']);
  });

  test('cost_usd is the caller\'s own bill, not the platform\'s', async () => {
    const { a, b } = await proveOrgOnly({
      caller: CALLER, orgA: ORG_A, orgB: ORG_B,
      run: (caller) => get(caller, '/api/admin/agents/metrics?range=7d'),
    });
    // Both are positive — the number still works — and they differ, which an
    // unscoped aggregate could not produce: it returned one platform total to
    // both arms.
    expect(a.body.agent86.cost_usd).toBeGreaterThan(0);
    expect(b.body.agent86.cost_usd).toBeGreaterThan(0);
    expect(a.body.agent86.cost_usd).not.toBe(b.body.agent86.cost_usd);
  });

  test('the four statements that were ALREADY scoped stay scoped', async () => {
    const { a } = await proveOrgOnly({
      caller: CALLER, orgA: ORG_A, orgB: ORG_B,
      run: (caller) => get(caller, '/api/admin/agents/metrics?range=7d'),
    });
    expect(a.body.agent86.background.jobs).toBe(1);
    expect(a.text).not.toContain(MARK + ' background job');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// P2 — SINGLE-TENANT PRODUCTION IS UNCHANGED. The deliverable, not a footnote.
// ══════════════════════════════════════════════════════════════════════════

describe('with ONE organization — production — every number is what it always was', () => {
  beforeEach(() => seedSingleTenant());

  test('/metrics returns the same totals a wholly unscoped aggregate would', async () => {
    const res = await get(Object.assign({}, CALLER, { organization_id: ORG_A }),
      '/api/admin/agents/metrics?range=7d');
    expect(res.status).toBe(200);
    // These are the counts computed over the WHOLE ai_messages table — the
    // stamped rows plus the legacy un-stamped one — because with one
    // organisation there is nothing else in it. Byte-identical to 69f2cabd,
    // asserted as literals rather than as "unchanged".
    expect(res.body.agent86.turns).toBe(5);
    expect(res.body.agent86.user_msgs).toBe(1);
    expect(res.body.agent86.conversations).toBe(3);
    expect(res.body.agent86.tokens.input).toBe(6500000);
    expect(res.body.agent86.escalations).toBe(1);
    expect(res.body.agent86.unmetered_turns).toBe(1);
    expect(res.body.agent86.models.length).toBe(2);
    expect(res.body.agent86.tools_top.length).toBe(3);
    expect(res.body.agent86.surfaces.length).toBe(3);
  });

  test('the legacy UN-STAMPED turn is still counted — the tolerance arm is not decorative', async () => {
    engine.db.exec("DELETE FROM ai_messages WHERE id <> 'legacy-t1';");
    const res = await get(Object.assign({}, CALLER, { organization_id: ORG_A }),
      '/api/admin/agents/metrics?range=7d');
    // A strict `organization_id = $n` would answer 0 here, and 0 renders as a
    // dead console rather than as an error — the single-tenant lockout this
    // whole approach is built to avoid.
    expect(res.body.agent86.turns).toBe(1);
    expect(res.body.agent86.tokens.input).toBe(500000);
  });

  test('/managed lists every registry row, including the un-stamped one', async () => {
    const res = await get(Object.assign({}, CALLER, { organization_id: ORG_A }), '/api/admin/agents/managed');
    expect(res.status).toBe(200);
    expect(res.body.agents.map((r) => r.agent_key).sort()).toEqual(['assistant', 'job']);
  });

  test('/conversations still lists the tenant\'s own threads', async () => {
    const res = await get(Object.assign({}, CALLER, { organization_id: ORG_A }),
      '/api/admin/agents/conversations?range=7d&limit=500');
    expect(res.status).toBe(200);
    expect(res.body.conversations.map((t) => t.entity_type + '|' + t.entity_id).sort())
      .toEqual(['ask86|q-a1', 'estimate|e-a1', 'job|j-a1']);
  });

  test('/conversations/:key still resolves its own entity title', async () => {
    const res = await get(Object.assign({}, CALLER, { organization_id: ORG_A }),
      '/api/admin/agents/conversations/' + encodeURIComponent('estimate|e-a1|10'));
    expect(res.status).toBe(200);
    expect(res.body.entity_title).toBe('Alpha Clubhouse Re-roof');
    expect(res.body.messages.length).toBeGreaterThan(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// L2 — the entity-title oracle, on BOTH /conversations doors.
// ══════════════════════════════════════════════════════════════════════════

// ── THE SCENARIO THESE TWO DOORS ACTUALLY MODEL ──────────────────────────
// User 10's row in the `users` TABLE says organization_id = 1. That is the
// ground truth the C1 owner guard and the list's owner subquery both read, and
// it is deliberately NOT varied: this is one person who MOVED, who is in org A
// today and who wrote ai_messages rows stamped org B for their former tenant.
// The premise under both doors was that "the target user is in my org" settles
// which rows are mine to read. It does not, and this is the fixture that says
// so with a single caller record.
//
// A consequence worth stating rather than discovering: the org-B ARM of
// proveOrgOnly is refused by the owner guard (404 / empty), because user 10 is
// not currently an org-2 member. That is the guard working, and it is asserted
// as such. The org-B tenant's own visibility — the no-lockout half — is proved
// separately with a caller who genuinely belongs to org B, because proving THAT
// requires varying the caller and so is a different proposition from tenancy.
const B_NATIVE = { id: 20, email: 'b@b.b', name: 'B Admin', role: 'admin', organization_id: ORG_B };

describe('L2 GET /conversations/:key — entity_title read by the id in the URL', () => {
  test('a FOREIGN estimate id yields the id back, never the other tenant\'s name', async () => {
    const { a, b } = await proveOrgOnly({
      caller: CALLER, orgA: ORG_A, orgB: ORG_B,
      // The KEY is fixed — same entity, same user — so the only thing that
      // moves between the arms is the caller's tenant.
      run: (caller) => get(caller, '/api/admin/agents/conversations/' + encodeURIComponent('estimate|e-b1|10')),
    });
    expect(a.status).toBe(200);
    // REFUSED IS NOT ABSENT, and here it is neither: `entity_title` was
    // initialised to the entity id, so an unresolvable title renders the ID THE
    // CALLER TYPED. They learn nothing they did not already supply, and no 404
    // is invented for a conversation the owner guard already admitted.
    expect(a.body.entity_title).toBe('e-b1');
    expect(a.text).not.toContain(MARK);
    // The org-B arm: the C1 owner guard refuses, because user 10 is not an
    // org-2 member. 404 rather than 403 so the answer does not confirm that
    // the conversation exists.
    expect(b.status).toBe(404);
  });

  test('a FOREIGN job id yields the id back', async () => {
    const { a } = await proveOrgOnly({
      caller: CALLER, orgA: ORG_A, orgB: ORG_B,
      run: (caller) => get(caller, '/api/admin/agents/conversations/' + encodeURIComponent('job|j-b1|10')),
    });
    expect(a.body.entity_title).toBe('j-b1');
    expect(a.text).not.toContain(MARK);
  });

  test('the message BODY predicate that an earlier commit added still holds', async () => {
    const { a } = await proveOrgOnly({
      caller: CALLER, orgA: ORG_A, orgB: ORG_B,
      run: (caller) => get(caller, '/api/admin/agents/conversations/' + encodeURIComponent('estimate|e-b1|10')),
    });
    // The key names an org-B ESTIMATE, and four ai_messages rows carry that
    // entity id: three stamped org B, one (a-x1) stamped org A. The caller gets
    // exactly their own, and none of the other tenant's bodies — which is the
    // sharper form of the original `toEqual([])`, because an empty array could
    // also have been produced by a predicate that excluded everything.
    expect(a.body.messages.map((m) => m.id)).toEqual(['a-x1']);
    expect(a.text).not.toContain('b-t1 body');
    expect(a.text).not.toContain('b-t7 body');
  });

  test('P5 — the row\'s OWN tenant still reads its own title and its own messages', async () => {
    engine.db.exec("INSERT INTO users (id, email, name, role, organization_id, active) VALUES (20, 'b@b.b', 'B Admin', 'admin', 2, 1);");
    const res = await get(B_NATIVE, '/api/admin/agents/conversations/' + encodeURIComponent('estimate|e-b1|20'));
    expect(res.status).toBe(200);
    expect(res.body.entity_title).toBe(MARK + ' Tower Re-roof');
  });
});

describe('L2b GET /conversations — the LIST: batched titles and the owner axis', () => {
  test('the OWNER-AXIS subquery is not the only predicate — the row\'s own stamp counts', async () => {
    // THE CASE THE OWNER AXIS CANNOT DECIDE. User 10 is a member of org A, so
    // `user_id IN (SELECT id FROM users WHERE organization_id = 1)` admits
    // EVERY row they ever wrote — including the six they wrote for org B.
    // Nothing here is exotic: it is one person who moved organisations, which
    // is a documented one-click admin action.
    const { a, b } = await proveOrgOnly({
      caller: CALLER, orgA: ORG_A, orgB: ORG_B,
      run: (caller) => get(caller, '/api/admin/agents/conversations?range=7d&limit=500'),
    });
    expect(a.status).toBe(200);
    const keys = a.body.conversations.map((t) => t.entity_type + '|' + t.entity_id).sort();
    // The two cross-pointing rows ARE the caller's, so their keys belong here.
    expect(keys).toEqual(['ask86|q-a1', 'estimate|e-a1', 'estimate|e-b1', 'job|j-a1', 'job|j-b1']);
    // The org-B-STAMPED threads are the ones that must not be here. Named
    // individually as well as covered by the equality above, because 'intake'
    // and 'staff' exist ONLY on org B's side — their absence is the part of
    // this that the owner axis alone could never have produced.
    expect(keys).not.toContain('intake|i-b1');
    expect(keys).not.toContain('staff|s-b1');
    // And the row counts prove it is the caller's OWN rows on the shared keys,
    // not org B's: 'estimate|e-b1' is one turn (a-x1), never the four that id
    // actually has in the table.
    const shared = a.body.conversations.find((t) => t.entity_id === 'e-b1');
    expect(shared.turns).toBe(1);
    // The org-B arm is emptied by the owner subquery alone — user 10 is not an
    // org-2 member. Asserted so a later edit that drops the owner axis in
    // favour of the row stamp shows up here rather than passing silently.
    expect(b.body.conversations).toEqual([]);
  });

  test('the batched title map never carries a foreign name', async () => {
    const { a } = await proveOrgOnly({
      caller: CALLER, orgA: ORG_A, orgB: ORG_B,
      run: (caller) => get(caller, '/api/admin/agents/conversations?range=7d&limit=500'),
    });
    expect(a.text).not.toContain(MARK);
    // P5 — the caller's own threads are still there, with their names.
    expect(a.text).toContain('Alpha Clubhouse Re-roof');
    expect(a.text).toContain('Alpha Gutter Replacement');
  });

  // ── THE TWO BATCHED LOOKUPS, REACHED THROUGH A ROW THE CALLER OWNS ──────
  // The thread itself is org A's — the row-stamp predicate admits it, and
  // should — but its entity id names an org-B estimate/job. The list therefore
  // hands a FOREIGN id to the batched title statement, which is the only
  // situation in which that statement's predicate is the thing under test.
  // A refused title is not a 404 and not an error: the id falls through as the
  // display value, which is the id the caller's own row already carried.
  test('an OWNED thread pointing at a FOREIGN estimate renders the id, not the name', async () => {
    const { a } = await proveOrgOnly({
      caller: CALLER, orgA: ORG_A, orgB: ORG_B,
      run: (caller) => get(caller, '/api/admin/agents/conversations?range=7d&limit=500'),
    });
    const row = a.body.conversations.find((t) => t.entity_type === 'estimate' && t.entity_id === 'e-b1');
    expect(row).toBeDefined();          // the thread IS the caller's — it must be listed
    expect(row.entity_title).toBe('e-b1');
    expect(row.entity_title).not.toBe(MARK + ' Tower Re-roof');
  });

  test('an OWNED thread pointing at a FOREIGN job renders the id, not the name', async () => {
    const { a } = await proveOrgOnly({
      caller: CALLER, orgA: ORG_A, orgB: ORG_B,
      run: (caller) => get(caller, '/api/admin/agents/conversations?range=7d&limit=500'),
    });
    const row = a.body.conversations.find((t) => t.entity_type === 'job' && t.entity_id === 'j-b1');
    expect(row).toBeDefined();
    expect(row.entity_title).toBe('j-b1');
    expect(row.entity_title).not.toBe(MARK + ' Roof Tear-off');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// L3 — the managed-agent registry.
// ══════════════════════════════════════════════════════════════════════════

describe('L3 GET /managed — the statement with no WHERE clause at all', () => {
  test('an org admin sees their own agents and the un-stamped one, never the other tenant\'s', async () => {
    const { a, b } = await proveOrgOnly({
      caller: CALLER, orgA: ORG_A, orgB: ORG_B,
      run: (caller) => get(caller, '/api/admin/agents/managed'),
    });
    expect(a.status).toBe(200);
    // 'assistant' is the organization_id IS NULL row — the `no_org` case. It
    // stays visible on purpose: a row belonging to nobody must not become
    // invisible to everybody, and this panel is where it gets cleaned up.
    expect(a.body.agents.map((r) => r.agent_key).sort()).toEqual(['assistant', 'job']);
    expect(a.text).not.toContain(MARK);
    // The anthropic_agent_id is the handle the sibling DELETE acts on. It is
    // the field that made this more than a metadata leak.
    expect(a.text).not.toContain('agt_' + MARK);
    // Varying ONLY the org flips which tenant's agent is served.
    expect(b.body.agents.map((r) => r.agent_key).sort()).toEqual(['assistant', 'scribe']);
  });

  test('P4 — SYSTEM_ADMIN still sees the whole platform', async () => {
    const res = await get(Object.assign({}, OWNER, { organization_id: ORG_A }), '/api/admin/agents/managed');
    expect(res.status).toBe(200);
    expect(res.body.agents.map((r) => r.agent_key).sort()).toEqual(['assistant', 'job', 'scribe']);
  });

  test('P3 — an org-less org admin is REFUSED, loudly, and not handed an empty list', async () => {
    const res = await get({ id: 12, email: 'orgless@p86.test', name: 'Orgless Admin', role: 'admin' },
      '/api/admin/agents/managed');
    expect(res.status).toBe(403);
    expect(String(res.body.error)).toMatch(/not associated with an organization/i);
    // The distinction that matters: NOT a 200 carrying nothing. An empty list
    // reads as "you have no managed agents" and is a wrong answer wearing a
    // success code.
    expect(res.body.agents).toBeUndefined();
  });

  test('P4b — an org-less SYSTEM_ADMIN is NOT locked out', async () => {
    // The reason registryScope resolves the org only on the branch that needs
    // it, rather than bolting requireOrg on as middleware: that would have
    // 403'd a platform owner with no organisation out of the two endpoints
    // written for them.
    const res = await get({ id: 13, email: 'owner2@p86.test', name: 'Orgless Owner', role: 'system_admin' },
      '/api/admin/agents/managed');
    expect(res.status).toBe(200);
    expect(res.body.agents.length).toBe(3);
  });
});

describe('L3b GET /managed/audit — organization_id named four times, filtered on none', () => {
  test('an org admin is not handed the roster of every tenant', async () => {
    const { a, b } = await proveOrgOnly({
      caller: CALLER, orgA: ORG_A, orgB: ORG_B,
      run: (caller) => get(caller, '/api/admin/agents/managed/audit'),
    });
    expect(a.status).toBe(200);
    // The LEFT JOIN to organizations is what made this worse than /managed: it
    // did not leak ids, it NAMED every affiliate. org_name and org_slug both.
    expect(a.text).not.toContain(MARK);
    expect(a.body.rows.map((r) => r.agent_key).sort()).toEqual(['assistant', 'job']);
    expect(b.body.rows.map((r) => r.agent_key).sort()).toEqual(['assistant', 'scribe']);
  });

  test('the no_org flag — the audit\'s whole purpose — still fires', async () => {
    const { a } = await proveOrgOnly({
      caller: CALLER, orgA: ORG_A, orgB: ORG_B,
      run: (caller) => get(caller, '/api/admin/agents/managed/audit'),
    });
    const orphan = a.body.rows.find((r) => r.agent_key === 'assistant');
    expect(orphan).toBeDefined();
    expect(orphan.flags).toContain('no_org');
  });

  test('P4 — SYSTEM_ADMIN keeps the cross-tenant audit the endpoint was written for', async () => {
    const res = await get(Object.assign({}, OWNER, { organization_id: ORG_A }), '/api/admin/agents/managed/audit');
    expect(res.status).toBe(200);
    expect(res.body.rows.map((r) => r.agent_key).sort()).toEqual(['assistant', 'job', 'scribe']);
    // It NAMES the other tenant — deliberately. That is the platform-owner
    // view, and moving it behind SYSTEM_ADMIN was the fix, not deleting it.
    expect(JSON.stringify(res.body)).toContain(MARK);
  });
});
