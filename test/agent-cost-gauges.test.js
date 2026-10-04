// THE GAUGES 86 IS TUNED BY, EXECUTED.
//
// You cannot tune what you cannot measure, and four of the instruments were
// wrong in different directions at once:
//
//   G1  services/ai-pricing.js — "the ONE place model rates live" — had NO
//       claude-sonnet-5 row, which is the model that actually runs. Every
//       dollar figure fell through DEFAULT_MODEL_COST and priced the workload
//       at the Opus tier: 5/25 against a true 2/10. It also carried
//       claude-opus-4-5 at 15/75, the RETIRED Opus 4.1 tier.
//   G2  The 0.10 cache-read multiplier was hardcoded at the one call site,
//       which is wrong for the two models the docs call out.
//   G3  The Conversations list priced a thread from input_tokens + output
//       only. input_tokens EXCLUDES cache reads, so a thread whose real flow
//       was ~908k tokens displayed $0.026 — two orders of magnitude low.
//       sqlCostExpr, its SQL twin, had the same hole.
//   G4  usage-forensics called itself "EVERY Anthropic consumer the server
//       records" and summed a total named `everything_total_in` — from five
//       lanes, with the background lane totalled off a `LIMIT 20` DISPLAY
//       query, and ~9 model call sites excluded entirely.
//
// Every case here runs the real code. The numbers in the assertions are the
// MEASURED 30-day window from 2026-10-04 (19,066,079 cache_read + 2,038,383
// cache_creation + 958 uncached + 154,592 output on claude-sonnet-5), so the
// dollar figures are this deployment's actual bill, not a fixture's.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const http = require('http');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const PRICING = path.join(__dirname, '..', 'server', 'services', 'ai-pricing.js');

const TABLES = [
  'organizations', 'users', 'roles', 'ai_messages', 'ai_sessions',
  'agent_jobs', 'ai_subtasks', 'ai_replays', 'ai_watches', 'ai_watch_runs',
  'estimates', 'jobs',
];

const engine = createPgSqlite(
  sqliteSchema(TABLES, {
    pk: { organizations: 'id', users: 'id', roles: 'name', ai_messages: 'id', agent_jobs: 'id' },
  }),
  { jsonColumns: ['tool_uses', 'packs_loaded'] }
);

globalThis.__P86_COST_GAUGE_ENGINE__ = engine;
jest.mock('../server/db', () => ({ pool: globalThis.__P86_COST_GAUGE_ENGINE__.pool }));
jest.mock('@anthropic-ai/sdk', () => {
  function FakeAnthropic() { return { messages: {}, beta: { agents: {} } }; }
  FakeAnthropic.toFile = async () => ({});
  return Object.assign(FakeAnthropic, { toFile: FakeAnthropic.toFile, default: FakeAnthropic });
});

const pricing = require('../server/services/ai-pricing');
const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const adminAgentsRoutes = require('../server/routes/admin-agents-routes');

// ── the measured window ───────────────────────────────────────────────────
const MEASURED = {
  model: 'claude-sonnet-5',
  uncached_in: 958,
  cache_creation: 2038383,
  cache_read: 19066079,
  output: 154592,
};

let server, baseUrl;
const OWNER = { id: 11, email: 'owner@p86.test', name: 'Platform Owner', role: 'system_admin', organization_id: 1 };

function seed() {
  engine.db.exec(`
    DELETE FROM ai_messages; DELETE FROM agent_jobs; DELETE FROM ai_subtasks;
    DELETE FROM ai_replays; DELETE FROM ai_watch_runs; DELETE FROM ai_watches;
    DELETE FROM users; DELETE FROM roles; DELETE FROM organizations;

    INSERT INTO organizations (id, name, slug) VALUES (1, 'AGX', 'agx');
    INSERT INTO users (id, email, name, role, organization_id, active) VALUES
      (11, 'owner@p86.test', 'Platform Owner', 'system_admin', 1, 1);
    INSERT INTO roles (name, label, capabilities) VALUES
      ('system_admin', 'System Admin', '["ROLES_MANAGE","ADMIN_METRICS","USERS_MANAGE","SYSTEM_ADMIN"]');
  `);
}

// 25 background jobs, descending cost. The TOTAL must cover all 25; the
// display list is capped at 20, and summing that list is the defect.
const JOB_COUNT = 25;
function seedAgentJobs() {
  const ins = engine.db.prepare(
    `INSERT INTO agent_jobs (id, title, agent_key, status, user_id, organization_id,
                             input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?, CURRENT_TIMESTAMP)`);
  let expected = 0;
  for (let i = 0; i < JOB_COUNT; i++) {
    // Descending so the 5 cheapest are exactly the ones a LIMIT 20 drops.
    const cacheRead = (JOB_COUNT - i) * 1000;
    ins.run('aj_' + i, 'job ' + i, 'job', 'done', 11, 1, 10, 20, 100, cacheRead);
    expected += 10 + 100 + cacheRead;
  }
  return expected;
}

function seedChatTurns() {
  const ins = engine.db.prepare(
    `INSERT INTO ai_messages
       (id, entity_type, estimate_id, user_id, role, content, model,
        input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
        turn_input_tokens, turn_output_tokens, turn_cache_creation_tokens, turn_cache_read_tokens,
        model_requests, tool_calls_executed, organization_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, CURRENT_TIMESTAMP)`);
  // One turn carrying the whole measured window, recorded on BOTH bases: the
  // per-request columns hold the last request, the turn_* columns the turn.
  ins.run('t_new', 'job', 'j1', 11, 'assistant', 'answer', MEASURED.model,
    2, 500, 0, 70000,
    MEASURED.uncached_in, MEASURED.output, MEASURED.cache_creation, MEASURED.cache_read,
    3, 7, 1);
  // And one pre-migration turn: turn_* absent, not zero.
  ins.run('t_old', 'job', 'j1', 11, 'assistant', 'older', MEASURED.model,
    5, 50, 1000, 2000,
    null, null, null, null,
    null, null, 1);
}

beforeAll(async () => {
  setRolePool(engine.pool);
  seed();
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
beforeEach(() => seed());

let mutantPaths = [];
afterEach(() => {
  for (const p of mutantPaths) {
    try { delete require.cache[require.resolve(p)]; } catch (e) { /* never loaded */ }
    try { fs.unlinkSync(p); } catch (e) { /* already gone */ }
  }
  mutantPaths = [];
});

function mutantCopy(file, pairs) {
  let out = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const src = out;
  for (const [find, replace] of pairs) {
    if (out.split(find).length - 1 !== 1) throw new Error('anchor not found: ' + String(find).slice(0, 60));
    out = out.split(find).join(replace);
  }
  if (out === src) throw new Error('MUTATION CHANGED NO BYTES');
  const dir = path.dirname(file);
  out = out.replace(/require\((['"])([^'"]+)\1\)/g, (m, _q, spec) => {
    try {
      const resolved = spec.charAt(0) === '.'
        ? require.resolve(path.resolve(dir, spec))
        : require.resolve(spec, { paths: [dir] });
      return 'require(' + JSON.stringify(resolved.split(path.sep).join('/')) + ')';
    } catch (e) { return m; }
  });
  const p = path.join(os.tmpdir(), '_p86_costgauge_' + process.pid + '_' + Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, out, 'utf8');
  mutantPaths.push(p);
  return p;
}

async function get(url, user) {
  const token = signToken(user || OWNER);
  const res = await fetch(baseUrl + url, { headers: { authorization: 'Bearer ' + token, connection: 'close' } });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, body };
}


// ══════════════════════════════════════════════════════════════════════════
// G1 + G2 — the rate table
// ══════════════════════════════════════════════════════════════════════════
describe('G1/G2 the rate table prices the model that actually runs', () => {
  test('claude-sonnet-5 is in the table at 2/10 — the live model is no longer a fallback', () => {
    expect(pricing.MODEL_COSTS['claude-sonnet-5']).toEqual({ in: 2, out: 10 });
    expect(pricing.rateFor('claude-sonnet-5')).toEqual({ in: 2, out: 10 });
    expect(pricing.rateFor('claude-sonnet-5').estimated).toBeUndefined();
  });

  test('claude-opus-4-5 is 5/25, not the retired 4.1 tier it used to carry', () => {
    expect(pricing.MODEL_COSTS['claude-opus-4-5']).toEqual({ in: 5, out: 25 });
  });

  test('an unknown model still gets a number, and the number SAYS it is a guess', () => {
    const r = pricing.rateFor('claude-whatever-9');
    expect(r).toEqual({ in: 5, out: 25, estimated: true, model: 'claude-whatever-9' });
  });

  test('the cache-read multiplier is per model, not a hardcoded 0.10', () => {
    expect(pricing.cacheReadMultiplierFor('claude-sonnet-5')).toBe(0.10);
    expect(pricing.cacheReadMultiplierFor('claude-opus-5-5')).toBe(0.05);
    expect(pricing.cacheReadMultiplierFor('claude-fable-5-1')).toBe(0.025);
    expect(pricing.cacheReadMultiplierFor('something-new')).toBe(pricing.DEFAULT_CACHE_READ_MULTIPLIER);
  });

  test('the measured 30-day window costs $10.46 — and priced at the old fallback it read $26.14', () => {
    const real = pricing.cacheCostRaw(MEASURED.model, MEASURED.uncached_in, MEASURED.output, MEASURED.cache_creation, MEASURED.cache_read);
    expect(real).toBeCloseTo(10.46, 2);
    const asFallback = pricing.cacheCostRaw('claude-opus-4-8', MEASURED.uncached_in, MEASURED.output, MEASURED.cache_creation, MEASURED.cache_read);
    expect(asFallback).toBeCloseTo(26.14, 2);
    // The gauge was reading 2.5x the real bill.
    expect(asFallback / real).toBeGreaterThan(2.4);
  });

  test('cache WRITES are the biggest line on this workload — which is what makes cold starts the thing to chase', () => {
    const rate = pricing.rateFor(MEASURED.model);
    const reads = MEASURED.cache_read * rate.in * pricing.cacheReadMultiplierFor(MEASURED.model) / 1e6;
    const writes = MEASURED.cache_creation * rate.in * pricing.CACHE_WRITE_MULTIPLIER_5M / 1e6;
    const out = MEASURED.output * rate.out / 1e6;
    expect(writes).toBeGreaterThan(reads);
    expect(writes).toBeGreaterThan(out);
    expect([+reads.toFixed(2), +writes.toFixed(2), +out.toFixed(2)]).toEqual([3.81, 5.10, 1.55]);
  });

  test('the module states the dimension it CANNOT price: managed-agent session runtime', () => {
    expect(pricing.MANAGED_SESSION_RUNTIME_USD_PER_HOUR).toBe(0.08);
    // A token cost is therefore a subtotal. One hour of session runtime is
    // more than this deployment's entire 30-day output bill at 7.5 hours.
    expect(pricing.MANAGED_SESSION_RUNTIME_USD_PER_HOUR * 20)
      .toBeGreaterThan(MEASURED.output * pricing.rateFor(MEASURED.model).out / 1e6);
  });

  test('MUTANT: take the sonnet-5 row back out and the live workload re-prices at the Opus tier', () => {
    const mut = mutantCopy(PRICING, [[
      "  'claude-sonnet-5':   { in: 2,    out: 10  },   // live default on Railway",
      '',
    ]]);
    const broken = require(mut);
    expect(broken.MODEL_COSTS['claude-sonnet-5']).toBeUndefined();
    expect(broken.rateFor('claude-sonnet-5').estimated).toBe(true);
    const cost = broken.cacheCostRaw(MEASURED.model, MEASURED.uncached_in, MEASURED.output, MEASURED.cache_creation, MEASURED.cache_read);
    expect(cost).toBeCloseTo(26.14, 2);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// G3 — a conversation's cost includes the cached mass
// ══════════════════════════════════════════════════════════════════════════
describe('G3 the Conversations list prices the cache', () => {
  test('a thread whose input is almost entirely cache reads is priced in dollars, not in rounding error', async () => {
    seedChatTurns();
    const r = await get('/api/admin/agents/conversations?range=7 days');
    expect(r.status).toBe(200);
    const conv = (r.body.conversations || [])[0];
    expect(conv).toBeTruthy();
    // The cached mass is reported, not silently dropped.
    expect(conv.cache_read).toBe(MEASURED.cache_read + 2000);
    expect(conv.cache_creation).toBe(MEASURED.cache_creation + 1000);
    // And priced: >$10, where input+output alone would have been under 2 cents.
    const inputOnly = pricing.cacheCostRaw(MEASURED.model, 7, MEASURED.output + 50, 0, 0);
    expect(inputOnly).toBeLessThan(2);
    expect(conv.cost_usd).toBeGreaterThan(10);
    expect(conv.cost_estimated).toBe(false);
  });

  test('EXECUTED tool calls are reported beside PROPOSED ones — the two are different questions', async () => {
    seedChatTurns();
    const r = await get('/api/admin/agents/conversations?range=7 days');
    const conv = (r.body.conversations || [])[0];
    expect(conv.tool_calls_executed).toBe(7);   // what ran
    expect(conv.tool_uses).toBe(0);             // what was parked for approval
  });

  test('MUTANT: price it from input+output only (the shipped bug) and the same thread reads as free', async () => {
    seedChatTurns();
    const before = await get('/api/admin/agents/conversations?range=7 days');
    const real = (before.body.conversations || [])[0].cost_usd;
    // The arithmetic the route used to do, on the same row.
    const asShipped = pricing.cacheCostRaw(MEASURED.model, MEASURED.uncached_in + 5, MEASURED.output + 50, 0, 0);
    expect(real / asShipped).toBeGreaterThan(5);
    expect(asShipped).toBeLessThan(2);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// G4 — the ledger says what it covers.
//
// Assembled by services/usage-ledger.js as a pure function, so the honesty
// contract is held here directly rather than through a route whose other
// queries this harness cannot speak. The LIMIT-20 defect is held by running
// the TWO REAL QUERIES against 25 seeded jobs: the display list and the
// aggregate that replaced it.
// ══════════════════════════════════════════════════════════════════════════
const { buildGrandLedger, UNMEASURED_LANES } = require('../server/services/usage-ledger');

// The two shapes, copied from routes/admin-console-routes.js.
const JOBS_DISPLAY_LIST = `
  SELECT id, title, (input_tokens + cache_creation_tokens + cache_read_tokens) AS total_in
    FROM agent_jobs
   ORDER BY total_in DESC
   LIMIT 20`;
const JOBS_AGGREGATE = `
  SELECT COUNT(*) AS n,
         COALESCE(SUM(COALESCE(input_tokens,0) + COALESCE(cache_creation_tokens,0)
                      + COALESCE(cache_read_tokens,0)), 0) AS total_in,
         COALESCE(SUM(output_tokens), 0) AS output_tokens
    FROM agent_jobs`;

describe('G4 the background lane is totalled over every job, not over the display list', () => {
  test('25 jobs: the list shows 20, the aggregate counts 25, and the gap is the 5 cheapest', () => {
    const expected = seedAgentJobs();
    const list = engine.all(JOBS_DISPLAY_LIST);
    const agg = engine.all(JOBS_AGGREGATE)[0];
    expect(list).toHaveLength(20);
    expect(Number(agg.n)).toBe(JOB_COUNT);
    expect(Number(agg.total_in)).toBe(expected);
    const listOnly = list.reduce((a, j) => a + Number(j.total_in), 0);
    // Summing the display list — the shipped defect — loses exactly the five
    // cheapest jobs.
    expect(expected - listOnly).toBe((1 + 2 + 3 + 4 + 5) * 1000 + 5 * 110);
  });

  test('the ledger takes the aggregate, and a caller who passes the display list is visibly wrong', () => {
    const expected = seedAgentJobs();
    const agg = engine.all(JOBS_AGGREGATE)[0];
    const honest = buildGrandLedger({ agentJobsTotal: agg });
    expect(honest.agent_jobs_total_in).toBe(expected);
    expect(honest.agent_jobs_n).toBe(JOB_COUNT);
    // The shape the route used to pass: a row list, which has no total_in of
    // its own, so the lane silently reads zero rather than reading low.
    const wrong = buildGrandLedger({ agentJobsTotal: {} });
    expect(wrong.agent_jobs_total_in).toBe(0);
  });
});

describe('G4 the ledger is a named subtotal with named holes', () => {
  const LEDGER_INPUT = {
    chatBySurface: [
      { entity_type: 'lead', input_tokens: 250, cache_creation: 1498042, cache_read: 15329806, output_tokens: 85460 },
      { entity_type: 'job', input_tokens: 62, cache_creation: 269913, cache_read: 1588645, output_tokens: 40913 },
    ],
    agentJobsTotal: { n: 1, total_in: 237043, output_tokens: 22124 },
    subtasks: [{ input_tokens: 0, cache_creation: 0, cache_read: 0 }],
    replays: [{ input_tokens: 0 }],
    watchRuns: [],
    turnBasis: {
      rows_turn_basis: 1, rows_request_basis_only: 177,
      turn_input_tokens: 958, turn_cache_creation: 2038383, turn_cache_read: 19066079,
      turn_output_tokens: 154592, model_requests: 3, tool_calls_executed: 7,
    },
  };

  test('there is no field called everything_total_in, and the subtotal is the sum of exactly the recorded lanes', () => {
    const g = buildGrandLedger(LEDGER_INPUT);
    expect(g.everything_total_in).toBeUndefined();
    expect(g.recorded_total_in).toBe(
      g.chat_total_in + g.agent_jobs_total_in + g.subtasks_total_in + g.replays_in);
    expect(g.chat_total_in).toBe(250 + 1498042 + 15329806 + 62 + 269913 + 1588645);
  });

  test('ledger_complete is false while anything is unmeasured — and it is derived from the list, not asserted beside it', () => {
    const g = buildGrandLedger(LEDGER_INPUT);
    expect(g.ledger_complete).toBe(false);
    expect(g.unmeasured_lanes.length).toBe(UNMEASURED_LANES.length);
    expect(g.unmeasured_lanes.length).toBeGreaterThanOrEqual(8);
  });

  test('every unmeasured lane names itself, its location and WHY — the prefix-ledger contract', () => {
    for (const l of UNMEASURED_LANES) {
      expect(typeof l.lane).toBe('string');
      expect(l.lane.length).toBeGreaterThan(0);
      expect(typeof l.where).toBe('string');
      expect(l.where.length).toBeGreaterThan(0);
      expect(typeof l.trigger).toBe('string');
      expect(l.trigger.length).toBeGreaterThan(0);
      expect(typeof l.why_not_measured).toBe('string');
      expect(l.why_not_measured.length).toBeGreaterThan(0);
    }
    // The two that matter most: a per-email lane that scales with the
    // business rather than with how much John chats, and a charge that is
    // not tokens at all.
    expect(UNMEASURED_LANES.some((l) => /email triage/i.test(l.lane))).toBe(true);
    const runtime = UNMEASURED_LANES.find((l) => /runtime/i.test(l.lane));
    expect(runtime).toBeTruthy();
    expect(runtime.trigger).toMatch(/0\.08/);
  });

  test('the retired watch lane is proven zero beside the subtotal, never inside it', () => {
    const g = buildGrandLedger(LEDGER_INPUT);
    expect(g.watches_total_in).toBeUndefined();
    expect(g.retired_lanes_confirmed_zero.watches_total_in).toBe(0);
    // And if the scheduler ever came back, the number moves without being
    // added to the subtotal.
    const withWatches = buildGrandLedger(Object.assign({}, LEDGER_INPUT, {
      watchRuns: [{ input_tokens: 10, cache_creation: 20, cache_read: 30 }],
    }));
    expect(withWatches.retired_lanes_confirmed_zero.watches_total_in).toBe(60);
    expect(withWatches.recorded_total_in).toBe(buildGrandLedger(LEDGER_INPUT).recorded_total_in);
  });

  test('the chat lane is reported on both bases, and model_requests exceeding the turn count is the proof the old columns were a floor', () => {
    const g = buildGrandLedger(LEDGER_INPUT);
    const tb = g.chat_turn_basis;
    expect(tb.total_in).toBe(958 + 2038383 + 19066079);
    expect(tb.rows_turn_basis).toBe(1);
    expect(tb.rows_request_basis_only).toBe(177);
    expect(tb.model_requests).toBe(3);
    expect(tb.tool_calls_executed).toBe(7);
    expect(tb.model_requests).toBeGreaterThan(tb.rows_turn_basis);
    expect(tb.note).toMatch(/per-REQUEST/);
  });

  test('an empty ledger is all zeros and still declares itself incomplete — absent is not complete', () => {
    const g = buildGrandLedger({});
    expect(g.recorded_total_in).toBe(0);
    expect(g.ledger_complete).toBe(false);
    expect(g.chat_turn_basis.model_requests).toBe(0);
  });

  test('MUTANT: empty the unmeasured list and the ledger declares itself complete while nine lanes still go uncounted', () => {
    const mut = mutantCopy(path.join(__dirname, '..', 'server', 'services', 'usage-ledger.js'), [[
      '  grand.ledger_complete = UNMEASURED_LANES.length === 0;',
      '  grand.ledger_complete = true;',
    ]]);
    const broken = require(mut);
    const g = broken.buildGrandLedger(LEDGER_INPUT);
    expect(g.ledger_complete).toBe(true);
    // …which is the defect: it says complete while still listing the holes.
    expect(g.unmeasured_lanes.length).toBeGreaterThan(0);
  });
});
