// MEASURING THE PART OF THE PREFIX NO LEDGER CAN SEE — the probe, executed.
//
// services/agent-prefix-ledger.js names a gap it cannot close: on 86, 67,100
// tokens observed on a real first turn against 15,640 modelled, leaving
// ~51,460 in the expanded builtin toolset, the Skills descriptors and
// Anthropic's harness preamble. That gap is 77% of a prefix paid on the first
// turn of every session. The only lever Managed Agents offers for any of it
// is the partial toolset — which builtinToolsetFor ALREADY applies to the
// `assistant` agent on the strength of an unmeasured "~30k of dead weight"
// comment. This probe exists so the same decision for 86 is made on a
// measurement.
//
// What has to hold, and is held here by running it:
//
//   P1  Each component is a DIFFERENCE between two sets that differ only by
//       that component, derived from the named pair. Taking the Skills
//       descriptors from skills − floor instead of skills − toolset_read
//       would silently add a read tool's schema to the Skills figure.
//   P2  A partial run publishes NO component total. Half a bisection is not
//       a measurement, and `complete` says so.
//   P3  The floor is labelled for what it is — harness preamble PLUS the
//       probe's own message — because a floor that claimed to be the preamble
//       alone would be the same over-claiming defect in a new place.
//   P4  A set the API REFUSES is a result, not a crash. Skills with no read
//       tool is a documented 400 and recording it proves the constraint.
//   P5  CLEANUP IS REPORTED. The SDK has no beta.agents.delete, so a failed
//       raw delete must come back with the agent id and a note, never be
//       swallowed into a success.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';
// getAnthropic() gates on the key before it constructs a client, and the
// client it would construct is the mock below. A fake value is enough to get
// past the gate; no request leaves the process.
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-ant-probe-test-key';

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const http = require('http');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const PROBE_SVC = path.join(__dirname, '..', 'server', 'services', 'prefix-probe.js');

const TABLES = [
  'organizations', 'users', 'roles', 'ai_messages', 'ai_sessions',
  'managed_agent_registry', 'managed_environment_registry', 'agent_reference_links',
  'org_memory', 'app_settings', 'org_skill_packs', 'managed_agent_skills', 'org_mcp_servers',
  'estimates', 'jobs',
];

const engine = createPgSqlite(
  sqliteSchema(TABLES, {
    pk: {
      organizations: 'id', users: 'id', roles: 'name',
      managed_agent_registry: 'agent_key', managed_environment_registry: 'env_key',
    },
  }),
  { jsonColumns: ['capabilities', 'tool_uses', 'packs_loaded'] }
);

// ── a programmable fake of the managed-agents surface ────────────────────
const sdk = {
  agents: [],          // every create/update payload, in order
  sessions: [],        // every session create
  sent: [],            // every events.send
  deletedSessions: [],
  archived: [],
  version: 0,
  // scripted per-set usage, keyed by the session title's set label
  usageByLabel: {},
  failUpdateFor: null,     // a set label whose agent update should 400
  failAgentArchive: false,
  failAgentList: false,
  existingAgents: [],
  emitNoUsageFor: null,    // a set label whose turn emits no usage event
};
globalThis.__P86_PROBE_SDK__ = sdk;
globalThis.__P86_PROBE_ENGINE__ = engine;

jest.mock('../server/db', () => ({ pool: globalThis.__P86_PROBE_ENGINE__.pool }));
// The route lazy-requires ai-routes-internals purely for composedAgentSystem,
// and that pulls in the whole 18k-line ai-routes (whose module load leaves
// timers behind, so the suite would never exit on its own). The probe only
// needs the composed system TEXT, so the seam is stubbed: what is under test
// here is the bisection, not how the system prompt is assembled.
jest.mock('../server/routes/ai-routes-internals', () => {
  // customToolsFor() spreads several tool lists; two stand in for the real 33.
  const tool = (name) => ({ name, description: 'stub', input_schema: { type: 'object', properties: {} } });
  const none = () => [];
  return {
    composedAgentSystem: async () => 'THE COMPOSED SYSTEM PROMPT, STUBBED',
    estimateTools: () => [tool('propose_update_line_item')],
    jobTools: () => [tool('read_jobs')],
    clientTools: none, staffTools: none, memoryTools: none, watchTools: none,
    payloadTools: none, readTools: none, wave3Tools: none, projectInlineTools: none,
  };
});
jest.mock('@anthropic-ai/sdk', () => {
  const s = globalThis.__P86_PROBE_SDK__;
  const labelOf = (title) => String(title || '').split('· ')[1] || '';
  function FakeAnthropic() {
    return {
      messages: {},
      delete: async (urlPath) => {
        s.rawDeletes.push(urlPath);
        if (s.failAgentDelete) throw new Error('404 Not Found: agents cannot be deleted');
        return {};
      },
      beta: {
        agents: {
          create: async (payload) => {
            if (s.failUpdateFor === 'CREATE') throw new Error('400 invalid_request_error: create refused');
            s.version = 1;
            s.agents.push({ op: 'create', payload, version: s.version });
            return { id: 'agent_probe_01', version: s.version };
          },
          // The disposal the API actually offers: archive. There is no
          // DELETE /v1/agents/{id} — a live run proved it with a 404.
          archive: async (id) => {
            s.archived.push(id);
            if (s.failAgentArchive) throw new Error('500 could not archive');
            return { id, archived: true };
          },
          list: async () => {
            if (s.failAgentList) throw new Error("500 could not list agents");
            return { data: s.existingAgents };
          },
          update: async (id, payload) => {
            const label = payload && payload.skills && payload.skills.length && !(payload.tools || []).length
              ? 'SKILLS_NO_READ' : null;
            if (s.failUpdateFor && (s.failUpdateFor === label || s.failUpdateFor === 'ANY')) {
              throw new Error('400 invalid_request_error: skills require the read tool');
            }
            s.version += 1;
            s.agents.push({ op: 'update', id, payload, version: s.version });
            return { id, version: s.version };
          },
        },
        environments: { create: async () => ({ id: 'env_fake' }) },
        sessions: {
          create: async (payload) => {
            const id = 'ses_' + (s.sessions.length + 1);
            s.sessions.push({ id, payload, label: labelOf(payload.title) });
            return { id };
          },
          delete: async (id) => { s.deletedSessions.push(id); return {}; },
          events: {
            // THE REAL API'S SHAPE CHECK, reproduced. The first version of
            // this fake accepted anything, so a probe that sent
            // `content: 'a string'` passed every test here and then failed on
            // all eight sets live with 400 "Failed to parse request body:
            // unexpected token …". A fake more permissive than the thing it
            // stands in for is a fake that certifies broken code.
            send: async (id, body) => {
              for (const ev of (body && body.events) || []) {
                if (ev.type !== 'user.message') continue;
                if (!Array.isArray(ev.content)) {
                  throw new Error('400 invalid_request_error: Failed to parse request body: unexpected token '
                    + JSON.stringify(ev.content));
                }
                for (const b of ev.content) {
                  if (!b || b.type !== 'text' || typeof b.text !== 'string') {
                    throw new Error('400 invalid_request_error: content blocks must be {type:"text", text}');
                  }
                }
              }
              s.sent.push({ id, body });
              return {};
            },
            stream: async (id) => {
              const sess = s.sessions.find((x) => x.id === id);
              const label = sess ? sess.label : '';
              const u = s.usageByLabel[label];
              const events = [];
              if (u && s.emitNoUsageFor !== label) {
                events.push({ type: 'span.model_request_end', model_usage: u });
              }
              events.push({ type: 'session.status_idle', stop_reason: { type: 'end_turn' } });
              return {
                controller: { abort: () => {} },
                [Symbol.asyncIterator]: async function* () { for (const e of events) yield e; },
              };
            },
          },
        },
      },
    };
  }
  FakeAnthropic.toFile = async () => ({});
  return Object.assign(FakeAnthropic, { toFile: FakeAnthropic.toFile, default: FakeAnthropic, Anthropic: FakeAnthropic });
});

const probe = require('../server/services/prefix-probe');
const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const adminAgentsRoutes = require('../server/routes/admin-agents-routes');

let server, baseUrl;
const OWNER = { id: 11, email: 'owner@p86.test', name: 'Owner', role: 'system_admin', organization_id: 1 };
const ADMIN = { id: 12, email: 'admin@p86.test', name: 'Org Admin', role: 'admin', organization_id: 1 };

function seed() {
  engine.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM roles;
    DELETE FROM managed_agent_registry; DELETE FROM managed_environment_registry;
    INSERT INTO organizations (id, name, slug) VALUES (1, 'AGX', 'agx');
    INSERT INTO users (id, email, name, role, organization_id, active) VALUES
      (11, 'owner@p86.test', 'Owner', 'system_admin', 1, 1),
      (12, 'admin@p86.test', 'Org Admin', 'admin', 1, 1);
    INSERT INTO roles (name, label, capabilities) VALUES
      ('system_admin', 'System Admin', '["ROLES_MANAGE","SYSTEM_ADMIN"]'),
      ('admin', 'Org Admin', '["ROLES_MANAGE"]');
    INSERT INTO managed_environment_registry (env_key, anthropic_environment_id, networking, updated_at)
      VALUES ('default', 'env_seeded', 'unrestricted', CURRENT_TIMESTAMP);
  `);
}

// Scripted prefixes per set. Chosen so every delta is a distinct round
// number and a mis-paired subtraction cannot coincidentally come out right.
const FLOOR = 4000;
const SYSTEM_TOK = 6700;
const CUSTOM_TOK = 8900;
const TOOLSET_FULL_TOK = 30000;
const TOOLSET_READ_TOK = 3000;
const TOOLSET_READ_WEB_TOK = 9000;
const SKILLS_TOK = 500;
const usage = (prefix) => ({ input_tokens: 12, output_tokens: 3, cache_creation_input_tokens: prefix, cache_read_input_tokens: 0 });

function scriptAllSets() {
  sdk.usageByLabel = {
    floor: usage(FLOOR),
    system: usage(FLOOR + SYSTEM_TOK),
    custom_tools: usage(FLOOR + CUSTOM_TOK),
    toolset_full: usage(FLOOR + TOOLSET_FULL_TOK),
    toolset_read: usage(FLOOR + TOOLSET_READ_TOK),
    toolset_read_web: usage(FLOOR + TOOLSET_READ_WEB_TOK),
    skills: usage(FLOOR + TOOLSET_READ_TOK + SKILLS_TOK),
    replica: usage(FLOOR + SYSTEM_TOK + CUSTOM_TOK + TOOLSET_FULL_TOK + SKILLS_TOK),
  };
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
beforeEach(() => {
  seed();
  sdk.agents = []; sdk.sessions = []; sdk.sent = []; sdk.deletedSessions = [];
  sdk.archived = []; sdk.version = 0; sdk.failUpdateFor = null;
  sdk.failAgentArchive = false; sdk.emitNoUsageFor = null;
  sdk.failAgentList = false; sdk.existingAgents = [];
  scriptAllSets();
});

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
    if (out.split(find).length - 1 !== 1) throw new Error('anchor not found: ' + String(find).slice(0, 50));
    out = out.split(find).join(replace);
  }
  if (out === src) throw new Error('MUTATION CHANGED NO BYTES');
  const p = path.join(os.tmpdir(), '_p86_probe_' + process.pid + '_' + Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, out, 'utf8');
  mutantPaths.push(p);
  return p;
}

async function post(body, user) {
  const token = signToken(user || OWNER);
  const res = await fetch(baseUrl + '/api/admin/agents/managed/prefix-probe', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', connection: 'close' },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, body: parsed, raw: text };
}

// ══════════════════════════════════════════════════════════════════════════
// The payload each set registers
// ══════════════════════════════════════════════════════════════════════════
describe('buildProbePayload — each set differs from the floor by exactly one thing', () => {
  const PARTS = {
    model: 'claude-sonnet-5', name: 'probe',
    system: 'THE COMPOSED SYSTEM',
    customTools: [{ name: 'read_jobs' }, { name: 'search_entities' }],
    skills: [{ type: 'custom', skill_id: 'skill_1' }],
  };
  const setOf = (k) => probe.PROBE_SETS.find((s) => s.key === k);

  test('the floor carries no tools, no skills, and no system content', () => {
    const p = probe.buildProbePayload(setOf('floor'), PARTS);
    expect(p.tools).toEqual([]);
    expect(p.skills).toEqual([]);
    expect(p.system).toBe(' ');     // present but empty — never an absent field
    expect(p.model).toBe('claude-sonnet-5');
  });

  test('each component set adds only its own component', () => {
    expect(probe.buildProbePayload(setOf('system'), PARTS).system).toBe('THE COMPOSED SYSTEM');
    expect(probe.buildProbePayload(setOf('system'), PARTS).tools).toEqual([]);
    const ct = probe.buildProbePayload(setOf('custom_tools'), PARTS);
    expect(ct.tools).toEqual(PARTS.customTools);
    expect(ct.system).toBe(' ');
    expect(ct.skills).toEqual([]);
  });

  test('the toolset sets register the real entry shapes — full, and partial with per-tool configs', () => {
    expect(probe.buildProbePayload(setOf('toolset_full'), PARTS).tools)
      .toEqual([{ type: 'agent_toolset_20260401', default_config: { enabled: true } }]);
    expect(probe.buildProbePayload(setOf('toolset_read'), PARTS).tools)
      .toEqual([{ type: 'agent_toolset_20260401', default_config: { enabled: false }, configs: [{ name: 'read', enabled: true }] }]);
    const lean = probe.buildProbePayload(setOf('toolset_read_web'), PARTS).tools[0];
    expect(lean.configs.map((c) => c.name)).toEqual(['read', 'glob', 'grep', 'web_search', 'web_fetch']);
    expect(lean.configs.every((c) => c.enabled)).toBe(true);
  });

  test('the skills set carries read as well — a skill with no read tool is a 400, so measuring it alone is impossible', () => {
    const p = probe.buildProbePayload(setOf('skills'), PARTS);
    expect(p.skills).toEqual(PARTS.skills);
    expect(p.tools[0].configs).toEqual([{ name: 'read', enabled: true }]);
    // …which is exactly why the Skills component is measured against
    // toolset_read and not against the floor.
    const d = probe.COMPONENT_DELTAS.find((x) => /Skills/.test(x.component));
    expect([d.minus, d.base]).toEqual(['skills', 'toolset_read']);
  });

  test('the replica carries everything 86 registers', () => {
    const p = probe.buildProbePayload(setOf('replica'), PARTS);
    expect(p.system).toBe('THE COMPOSED SYSTEM');
    expect(p.skills).toEqual(PARTS.skills);
    expect(p.tools[0]).toEqual({ type: 'agent_toolset_20260401', default_config: { enabled: true } });
    expect(p.tools.slice(1)).toEqual(PARTS.customTools);
  });

  test('a payload with no model is refused rather than registering a nameless agent', () => {
    expect(() => probe.buildProbePayload(setOf('floor'), {})).toThrow(/model is required/);
    expect(() => probe.buildProbePayload(null, PARTS)).toThrow(/set is required/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// The report
// ══════════════════════════════════════════════════════════════════════════
describe('buildProbeReport — every component is a named difference', () => {
  const M = () => ({
    floor: usage(FLOOR), system: usage(FLOOR + SYSTEM_TOK), custom_tools: usage(FLOOR + CUSTOM_TOK),
    toolset_full: usage(FLOOR + TOOLSET_FULL_TOK), toolset_read: usage(FLOOR + TOOLSET_READ_TOK),
    toolset_read_web: usage(FLOOR + TOOLSET_READ_WEB_TOK),
    skills: usage(FLOOR + TOOLSET_READ_TOK + SKILLS_TOK),
    replica: usage(FLOOR + SYSTEM_TOK + CUSTOM_TOK + TOOLSET_FULL_TOK + SKILLS_TOK),
  });
  const comp = (r, name) => r.components.find((c) => c.component === name);

  test('P1 each component comes out at its scripted size, from the pair it names', () => {
    const r = probe.buildProbeReport(M(), {}, null);
    expect(comp(r, 'composed system prompt').tokens).toBe(SYSTEM_TOK);
    expect(comp(r, 'custom tool schemas').tokens).toBe(CUSTOM_TOK);
    expect(comp(r, 'builtin toolset — ALL 8 tools').tokens).toBe(TOOLSET_FULL_TOK);
    expect(comp(r, 'builtin toolset — read only').tokens).toBe(TOOLSET_READ_TOK);
    expect(comp(r, 'builtin toolset — read+glob+grep+web').tokens).toBe(TOOLSET_READ_WEB_TOK);
    expect(comp(r, '3 Skills descriptors').tokens).toBe(SKILLS_TOK);
    expect(comp(r, '3 Skills descriptors').derived_from).toBe('skills − toolset_read');
  });

  test('the lever is readable straight off the table: what dropping to a lean toolset would save', () => {
    const r = probe.buildProbeReport(M(), {}, null);
    const full = comp(r, 'builtin toolset — ALL 8 tools').tokens;
    const lean = comp(r, 'builtin toolset — read+glob+grep+web').tokens;
    expect(full - lean).toBe(TOOLSET_FULL_TOK - TOOLSET_READ_WEB_TOK);
  });

  test('P3 the floor says it includes the probe\'s own message, not just the harness', () => {
    const r = probe.buildProbeReport(M(), {}, null);
    expect(r.floor_tokens).toBe(FLOOR);
    expect(r.floor_is).toMatch(/harness preamble/);
    expect(r.floor_is).toMatch(/own message/);
  });

  test('the residual lands on the floor when the method is sound, and says what it is', () => {
    const r = probe.buildProbeReport(M(), {}, null);
    expect(r.residual.tokens).toBe(FLOOR);
    expect(r.residual.agrees_with_floor).toBe(0);
    expect(r.residual.what_it_is).toMatch(/harness/);
  });

  test('the modelled figures ride alongside, with the difference stated', () => {
    const r = probe.buildProbeReport(M(), { composed_system_tokens: 6746, custom_tool_schema_tokens: 8894 }, null);
    expect(comp(r, 'composed system prompt').server_modelled_tokens).toBe(6746);
    expect(comp(r, 'composed system prompt').measured_minus_modelled).toBe(SYSTEM_TOK - 6746);
  });

  test('the method checks itself against the prefix a real session paid', () => {
    const r = probe.buildProbeReport(M(), {}, 67100);
    expect(r.method_check.replica_tokens).toBe(FLOOR + SYSTEM_TOK + CUSTOM_TOK + TOOLSET_FULL_TOK + SKILLS_TOK);
    expect(r.method_check.observed_on_real_agent).toBe(67100);
    expect(r.method_check.difference).toBe(r.method_check.replica_tokens - 67100);
  });

  test('P2 a set that failed makes its rows unavailable WITH a reason, and the run is not complete', () => {
    const m = M();
    m.toolset_full = { error: 'agent update refused: 400 whatever' };
    const r = probe.buildProbeReport(m, {}, null);
    const row = comp(r, 'builtin toolset — ALL 8 tools');
    expect(row.measured).toBe(false);
    expect(row.tokens).toBeNull();
    expect(row.why_unavailable).toMatch(/toolset_full/);
    expect(row.why_unavailable).toMatch(/400 whatever/);
    expect(r.complete).toBe(false);
    expect(r.why_incomplete).toMatch(/No component total is published/);
    // And no residual is invented from an incomplete attribution.
    expect(r.residual).toBeUndefined();
  });

  test('P2 a missing floor takes every row down with it rather than producing confident nonsense', () => {
    const m = M();
    delete m.floor;
    const r = probe.buildProbeReport(m, {}, null);
    expect(r.components.filter((c) => c.measured)).toHaveLength(1); // only skills − toolset_read survives
    expect(r.floor_tokens).toBeNull();
    expect(r.complete).toBe(false);
  });

  test('an empty run reports nothing as measured and does not throw', () => {
    const r = probe.buildProbeReport({}, {}, null);
    expect(r.complete).toBe(false);
    expect(r.components.every((c) => !c.measured)).toBe(true);
    expect(r.sets.every((s) => !s.measured)).toBe(true);
  });

  test('prefixTokensOf sums cold and warm — a warm agent pays the same prefix as cache_read', () => {
    expect(probe.prefixTokensOf({ cache_creation_input_tokens: 67100, cache_read_input_tokens: 0 })).toBe(67100);
    expect(probe.prefixTokensOf({ cache_creation_input_tokens: 0, cache_read_input_tokens: 67100 })).toBe(67100);
    expect(probe.prefixTokensOf({ error: 'nope' })).toBeNull();
  });

  test('MUTANT: measure the Skills against the floor and their size absorbs a read tool', () => {
    const mut = mutantCopy(PROBE_SVC, [[
      "{ component: '3 Skills descriptors', minus: 'skills', base: 'toolset_read', compare_to_modelled: null },",
      "{ component: '3 Skills descriptors', minus: 'skills', base: 'floor', compare_to_modelled: null },",
    ]]);
    const broken = require(mut);
    const r = broken.buildProbeReport(M(), {}, null);
    const row = r.components.find((c) => /Skills/.test(c.component));
    expect(row.tokens).toBe(TOOLSET_READ_TOK + SKILLS_TOK);   // 3,500, not 500
    expect(row.tokens / SKILLS_TOK).toBe(7);                  // off by 7x
  });

  test('MUTANT: declare a partial run complete and a half-measured bisection reads as a finished one', () => {
    const mut = mutantCopy(PROBE_SVC, [[
      '  report.complete = components.every((c) => c.measured)',
      '  report.complete = true; const _unused = components.every((c) => c.measured)',
    ]]);
    const broken = require(mut);
    const m = M();
    m.toolset_full = { error: 'refused' };
    const r = broken.buildProbeReport(m, {}, null);
    expect(r.complete).toBe(true);
    expect(r.components.some((c) => !c.measured)).toBe(true);  // …while rows are still missing
  });

  test('MUTANT: label the floor as the harness alone and it over-claims by the probe\'s own turn', () => {
    const mut = mutantCopy(PROBE_SVC, [[
      "    label: 'harness preamble + this probe\\'s own message',",
      "    label: 'the Anthropic harness preamble',",
    ]]);
    const broken = require(mut);
    const r = broken.buildProbeReport(M(), {}, null);
    expect(r.floor_is).toBe('the Anthropic harness preamble');
    expect(r.floor_is).not.toMatch(/own message/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// The endpoint
// ══════════════════════════════════════════════════════════════════════════
describe('POST /managed/prefix-probe', () => {
  test('ORG ADMIN cannot run it — it spends money on the platform account', async () => {
    const r = await post({}, ADMIN);
    expect(r.status).toBe(403);
    expect(sdk.agents).toHaveLength(0);
  });

  test('ONE agent, updated per set, with every session pinned to the version it was measured on', async () => {
    const r = await post({});
    expect(r.status).toBe(200);
    // One create, the rest updates — the SDK has no agents.delete, so seven
    // agents would be seven permanent rows on the account.
    expect(sdk.agents.filter((a) => a.op === 'create')).toHaveLength(1);
    expect(sdk.agents.filter((a) => a.op === 'update')).toHaveLength(probe.PROBE_SETS.length - 1);
    expect(sdk.sessions).toHaveLength(probe.PROBE_SETS.length);
    // Each session names an explicit version, so no measurement can land on
    // a version other than the one it was set up for.
    for (const s of sdk.sessions) {
      expect(s.payload.agent.type).toBe('agent');
      expect(s.payload.agent.id).toBe('agent_probe_01');
      expect(Number.isInteger(s.payload.agent.version)).toBe(true);
    }
    const versions = sdk.sessions.map((s) => s.payload.agent.version);
    expect(versions).toEqual([...new Set(versions)]);   // no two sets share a version
  });

  test('the measured report comes back with every component resolved', async () => {
    const r = await post({});
    const rep = r.body.report;
    expect(rep.complete).toBe(true);
    const byName = {};
    for (const c of rep.components) byName[c.component] = c.tokens;
    expect(byName['builtin toolset — ALL 8 tools']).toBe(TOOLSET_FULL_TOK);
    expect(byName['3 Skills descriptors']).toBe(SKILLS_TOK);
    expect(rep.floor_tokens).toBe(FLOOR);
  });

  test('every turn is one trivial message, and it is the SAME message for every set so it cancels out of the deltas', async () => {
    const r = await post({});
    expect(sdk.sent).toHaveLength(probe.PROBE_SETS.length);
    const bodies = sdk.sent.map((x) => x.body.events[0].content[0].text);
    expect([...new Set(bodies)]).toHaveLength(1);
    expect(bodies[0]).toBe(r.body.probe_message);
  });

  test('P4 a set the API refuses is recorded as a result and the run continues', async () => {
    sdk.failUpdateFor = 'ANY';
    const r = await post({ sets: ['floor', 'system'] });
    expect(r.status).toBe(200);
    // floor created fine; system's update was refused.
    expect(r.body.report.sets.find((s) => s.set === 'system').error).toMatch(/refused/);
    expect(r.body.report.complete).toBe(false);
    // The floor still measured, so the run produced something.
    expect(r.body.report.sets.find((s) => s.set === 'floor').measured).toBe(true);
  });

  test('a turn that carries no usage event is an error on that set, not a silent zero', async () => {
    sdk.emitNoUsageFor = 'system';
    const r = await post({ sets: ['floor', 'system'] });
    const row = r.body.report.sets.find((s) => s.set === 'system');
    expect(row.measured).toBe(false);
    expect(row.error).toMatch(/no span.model_request_end/);
  });

  test('P5 every session is deleted, and a FAILED archive comes back with the id and a note', async () => {
    sdk.failAgentArchive = true;
    const r = await post({});
    expect(sdk.deletedSessions).toHaveLength(probe.PROBE_SETS.length);
    expect(r.body.cleanup.sessions_deleted).toBe(probe.PROBE_SETS.length);
    expect(r.body.cleanup.agent_archive.archived).toBe(false);
    expect(r.body.cleanup.agent_archive.agent_id).toBe('agent_probe_01');
    expect(r.body.cleanup.agent_archive.note).toMatch(/still ACTIVE/);
    expect(r.body.cleanup.agent_archive.note).toMatch(/no delete/);
    // And the id is reported at the top level too, so cleanup never depends
    // on reading the nested cleanup block.
    expect(r.body.touched.agent_id).toBe('agent_probe_01');
  });

  test('a successful cleanup ARCHIVES the agent — the only disposal beta.agents offers', async () => {
    const r = await post({});
    expect(r.body.cleanup.agent_archive).toEqual({ archived: true, agent_id: 'agent_probe_01' });
    expect(sdk.archived).toEqual(['agent_probe_01']);
  });

  test('the floor is required, because every delta is measured against it', async () => {
    const r = await post({ sets: ['system', 'replica'] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/floor/);
    expect(sdk.agents).toHaveLength(0);
  });

  test('an unknown set name is refused with the list of real ones', async () => {
    const r = await post({ sets: ['not_a_set'] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/floor/);
  });

  test('a subset runs only what was asked', async () => {
    const r = await post({ sets: ['floor', 'toolset_full', 'toolset_read_web'] });
    expect(r.status).toBe(200);
    expect(sdk.sessions.map((s) => s.label)).toEqual(['floor', 'toolset_full', 'toolset_read_web']);
    const lever = r.body.report.components.find((c) => /read\+glob/.test(c.component));
    expect(lever.tokens).toBe(TOOLSET_READ_WEB_TOK);
    // The sets nobody asked for are reported as unmeasured rather than absent.
    expect(r.body.report.sets.find((s) => s.set === 'replica').measured).toBe(false);
    expect(r.body.report.complete).toBe(false);
  });
});

describe('the observed-prefix lookup, when it cannot run', () => {
  // The method check compares the replica against the prefix a REAL session
  // paid, read with the same DISTINCT ON statement the prompt-audit uses.
  // DISTINCT ON is Postgres-only and the sqlite shim cannot prepare it, so in
  // THIS harness that lookup always fails — which makes this the right place
  // to hold the thing that matters about a failed measurement: it is reported,
  // never degraded into a quiet null that reads as "no real session yet".
  // The successful path is held at the pure level, where buildProbeReport is
  // handed an observed prefix directly.
  test('the failure is REPORTED, and the report carries no method_check rather than a zero', async () => {
    engine.db.exec(`
      INSERT INTO ai_sessions (id, agent_key, entity_type, entity_id, user_id,
                               anthropic_session_id, anthropic_agent_id, session_kind)
        VALUES (900, 'job', 'job', 'j1', 11, 'ses_real', 'agent_real_86', 'user_thread');
      INSERT INTO ai_messages (id, entity_type, estimate_id, user_id, role, content, model,
                               cache_creation_input_tokens, cache_read_input_tokens,
                               session_id, organization_id, created_at)
        VALUES ('aim_real', 'job', 'j1', 11, 'assistant', 'hi', 'claude-sonnet-5',
                67100, 0, 900, 1, CURRENT_TIMESTAMP);
    `);
    const r = await post({});
    expect(r.status).toBe(200);
    expect(typeof r.body.observed_prefix_error).toBe('string');
    expect(r.body.observed_prefix_error.length).toBeGreaterThan(0);
    expect(r.body.observed_prefix_on_real_agent).toBeNull();
    expect(r.body.report.method_check).toBeUndefined();
    // …and the run still produced its measurements: one lookup failing does
    // not cost the bisection.
    expect(r.body.report.components.every((c) => c.measured)).toBe(true);
  });
});

describe('the probe tidies up after its own failures', () => {
  // There is no DELETE for agents, and the FIRST live run of this probe died
  // between create and archive on a 400 nobody had hit before — leaving an
  // active agent with eight versions on the account. A probe that needs a
  // human to clear its litter stops being run, so each run archives the
  // leftovers of earlier ones.
  test('an ACTIVE agent from an earlier run is archived, and the current one is not touched twice', async () => {
    sdk.existingAgents = [
      { id: 'agent_stale_1', name: 'P86 PREFIX PROBE (2026-10-04T04:10)' },
      { id: 'agent_stale_2', name: 'P86 PREFIX PROBE (2026-10-03T22:00)' },
      { id: 'agent_real_86', name: 'Project 86 JOB · AG Exteriors' },
      { id: 'agent_probe_01', name: 'P86 PREFIX PROBE (now)' },
    ];
    const r = await post({});
    expect(r.status).toBe(200);
    const sweep = r.body.cleanup.stale_probe_agents;
    expect(sweep.archived.sort()).toEqual(['agent_stale_1', 'agent_stale_2']);
    expect(sweep.failed).toEqual([]);
    expect(sweep.list_error).toBeNull();
    // The real 86 agent is NEVER touched — the sweep is keyed on the probe's
    // own name prefix, and nothing else.
    expect(sdk.archived).not.toContain('agent_real_86');
    // The current agent is archived exactly once, by its own cleanup.
    expect(sdk.archived.filter((id) => id === 'agent_probe_01')).toHaveLength(1);
  });

  test('a listing that fails is reported, and the run still archives its own agent', async () => {
    sdk.failAgentList = true;
    const r = await post({});
    expect(r.body.cleanup.stale_probe_agents.list_error).toMatch(/could not list/);
    expect(r.body.cleanup.agent_archive.archived).toBe(true);
  });

  test('a stale agent that will not archive is named rather than dropped', async () => {
    sdk.existingAgents = [{ id: 'agent_stale_x', name: 'P86 PREFIX PROBE (old)' }];
    sdk.failAgentArchive = true;
    const r = await post({});
    const sweep = r.body.cleanup.stale_probe_agents;
    expect(sweep.archived).toEqual([]);
    expect(sweep.failed).toEqual([{ id: 'agent_stale_x', error: expect.stringMatching(/could not archive/) }]);
  });
});
