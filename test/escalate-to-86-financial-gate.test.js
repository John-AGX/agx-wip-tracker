// escalate_to_86 MAY NOT HAND 86 MONEY THE CALLER'S ROLE WAS NEVER GRANTED.
//
// THE LEAK
// driveEscalateTo86 builds a "context pack" for the entity the Assistant names
// and pastes it into the FIRST user.message of 86's escalation sub-session. For
// a job that pack is buildJobContext(..., { slimForRouter:false,
// escalationLean:true }): the WIP snapshot (contract, cost, profit, margin,
// billing, backlog) plus a per-building budget rollup. For an estimate it is
// buildEstimateContext: every line's cost and markup. Neither consulted the
// caller. A sub or a crew member holding NO capability could ask the Assistant
// about a job, the Assistant escalated, and 86 was handed the job's contract
// and margin — and whatever 86 is handed, it can repeat.
//
// THE RULE IS NOT RESTATED HERE
// Through 86, who may see those figures is already decided by ONE function:
// aiToolCapabilityDenial -> consolidatedReadCapability. The pack carries what
// read_entity{job, include:['building_breakdown']} serves (FINANCIALS_VIEW) and
// what read_entity{estimate} serves (ESTIMATES_VIEW). The escalation now asks
// that function, so the day the rule moves the pack moves with it. The last
// property below pins that coupling by EXECUTION, not by reading source.
//
// WHAT IS DRIVEN
// The real /api/ai/86/chat route, the real escalate_to_86 dispatch, a fake
// Sessions transport that records the exact bytes sent. Assertions read what
// 86 was actually handed.

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-a-real-key';
process.env.AGENT_MODE_86 = 'agents';

jest.setTimeout(120000);

const express = require('express');
const http = require('http');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const TABLES = [
  'organizations', 'roles', 'users',
  'jobs', 'leads', 'estimates', 'attachments',
  'agent_jobs', 'ai_sessions', 'ai_messages', 'payloads',
  'context_load_events', 'app_settings', 'email_log', 'org_memory', 'messages'
];

const engine = createPgSqlite(
  sqliteSchema(TABLES, {
    pk: {
      organizations: 'id', roles: 'name', users: 'id', jobs: 'id',
      leads: 'id', estimates: 'id', attachments: 'id', agent_jobs: 'id',
      ai_sessions: 'id', ai_messages: 'id', payloads: 'id', app_settings: 'key',
      email_log: 'id', org_memory: 'id', messages: 'id'
    }
  }),
  {
    jsonColumns: ['data', 'capabilities', 'notification_prefs', 'tags', 'payload', 'settings', 'annotations'],
    dateColumns: ['updated_at', 'created_at', 'uploaded_at', 'last_seen_at', 'last_used_at']
  }
);
globalThis.__ENGINE__ = engine;

globalThis.__UNMODELLED__ = [];
jest.mock('../server/db', () => {
  const real = globalThis.__ENGINE__.pool;
  const q = async (sql, params) => {
    if (String(sql).includes('to_jsonb')) return { rows: [], rowCount: 1 };
    try { return await real.query(sql, params); }
    catch (e) {
      globalThis.__UNMODELLED__.push(String(sql).replace(/\s+/g, ' ').trim().slice(0, 110) + '  ||  ' + e.message);
      return { rows: [], rowCount: 0 };
    }
  };
  return { pool: { query: q, connect: async () => ({ query: q, release() {} }) } };
});
jest.mock('../server/storage', () => ({
  storage: { getBuffer: async () => Buffer.from(''), put: async (k) => 'https://cdn.test/' + k, delete: async () => {} }
}));
jest.mock('../server/anthropic-files', () => ({
  uploadAttachmentToAnthropic: async () => null,
  eagerUploadAttachmentById: async () => {},
  deleteAnthropicFile: async () => {}
}));
jest.mock('../server/routes/admin-agents-routes', () => ({
  ensureManagedEnvironment: async () => ({ anthropic_environment_id: 'env_test' }),
  ensureManagedAgent: async () => ({ anthropic_agent_id: 'agent_test' })
}));

globalThis.__SENT__ = [];
globalThis.__SCRIPT__ = [];
jest.mock('@anthropic-ai/sdk', () => {
  let n = 0;
  function FakeAnthropic() {
    return {
      messages: {},
      beta: {
        sessions: {
          create: async () => ({ id: 'sess_' + (++n) }),
          archive: async () => ({}),
          events: {
            send: async (sid, body) => {
              for (const e of (body.events || [])) {
                globalThis.__SENT__.push(Object.assign({ __session: sid, __epoch: globalThis.__EPOCH__ }, e));
              }
            },
            stream: async () => {
              const turn = globalThis.__SCRIPT__.shift() || [];
              return {
                controller: { abort() {} },
                [Symbol.asyncIterator]() {
                  let i = 0;
                  return { next: async () => (i < turn.length ? { value: turn[i++], done: false } : { value: undefined, done: true }) };
                }
              };
            }
          }
        },
        files: {
          list: (function () {
            let f = 0;
            return function () {
              const id = 'file_harvest_' + (++f);
              return { [Symbol.asyncIterator]() {
                let done = false;
                return { next: async () => (done ? { done: true } : (done = true, { value: { id }, done: false })) };
              } };
            };
          })()
        }
      }
    };
  }
  FakeAnthropic.toFile = async () => ({});
  return Object.assign(FakeAnthropic, { toFile: FakeAnthropic.toFile, default: FakeAnthropic });
});

const { setRolePool, refreshRoleCache, signToken } = require('../server/auth');
const aiRoutes = require('../server/routes/ai-routes');
const { aiToolCapabilityDenial } = aiRoutes.internals;
const { pool } = require('../server/db');
setRolePool(pool);

const ORG = 900000101;

// Roles. The capability sets are explicit — '*' is not expanded by the role
// cache, so a '*' fixture would silently be a zero-capability role.
const ROLES = {
  nocaps:  [],
  crew:    ['JOBS_VIEW_ALL', 'ESTIMATES_VIEW'],        // sees jobs, NOT money
  finance: ['FINANCIALS_VIEW'],
  pm:      ['FINANCIALS_VIEW', 'JOBS_VIEW_ALL', 'ESTIMATES_VIEW'],
  leadsonly: ['LEADS_VIEW']
};
const USERS = {
  nocaps:    { id: 31, email: 'sub@x.test',   name: 'Sub',    role: 'nocaps',    organization_id: ORG },
  crew:      { id: 32, email: 'crew@x.test',  name: 'Crew',   role: 'crew',      organization_id: ORG },
  finance:   { id: 33, email: 'fin@x.test',   name: 'Fin',    role: 'finance',   organization_id: ORG },
  pm:        { id: 34, email: 'pm@x.test',    name: 'PM',     role: 'pm',        organization_id: ORG },
  leadsonly: { id: 35, email: 'leads@x.test', name: 'Leads',  role: 'leadsonly', organization_id: ORG }
};

// Salted figures: each is a number no other part of the prompt can produce.
const JOB = {
  jobNumber: 'W-7731', title: 'Salted Palms Reroof', client: 'Salted HOA',
  contractAmount: 987654, estimatedCosts: 612345,
  buildings: [{ id: 'b1', name: 'Bldg A', budget: 55511 }],
  phases: [{ id: 'p1', buildingId: 'b1', name: 'Tear-off', phaseBudget: 44433, pctComplete: 50 }]
};
const JOB_MONEY = ['987,654', '612,345', '55,511', 'WIP snapshot', 'Contract (as-sold)', 'Margin'];

const EST = {
  title: 'Salted Estimate', activeAlternateId: 'alt1',
  alternates: [{ id: 'alt1', name: 'Base' }],
  lines: [{ id: 'l1', alternateId: 'alt1', description: 'Salted shingles', qty: 3, unit: 'SQ', unitCost: 4321.87, markup: 37 }]
};

function seed() {
  const db = engine.db;
  for (const t of TABLES) db.exec('DELETE FROM ' + t + ';');
  db.prepare('INSERT INTO organizations (id,name,slug) VALUES (?,?,?)').run(ORG, 'AG Exteriors', 'agx');
  const r = db.prepare('INSERT INTO roles (name,label,capabilities) VALUES (?,?,?)');
  for (const [name, caps] of Object.entries(ROLES)) r.run(name, name, JSON.stringify(caps));
  const u = db.prepare('INSERT INTO users (id,email,name,role,organization_id,active) VALUES (?,?,?,?,?,1)');
  for (const x of Object.values(USERS)) u.run(x.id, x.email, x.name, x.role, x.organization_id);
  db.prepare('INSERT INTO jobs (id,owner_id,organization_id,data) VALUES (?,?,?,?)')
    .run('j-salt', 34, ORG, JSON.stringify(JOB));
  db.prepare('INSERT INTO estimates (id,owner_id,organization_id,data) VALUES (?,?,?,?)')
    .run('e-salt', 34, ORG, JSON.stringify(EST));
}

let epochSeq = 0;
function resetWire() {
  globalThis.__SENT__ = [];
  globalThis.__SCRIPT__ = [];
  globalThis.__UNMODELLED__ = [];
  globalThis.__EPOCH__ = ++epochSeq;
  return globalThis.__EPOCH__;
}

const toolTurn = (id, name, input) => ([
  { type: 'agent.custom_tool_use', id, tool_name: name, input },
  { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: [id] } }
]);
const finalTurn = (text) => ([
  { type: 'agent.message', content: [{ type: 'text', text }] },
  { type: 'session.status_idle', stop_reason: { type: 'end_turn' } }
]);

const { aiChatLimiter, aiChatHourlyLimiter } = require('../server/rate-limit');
let server, baseUrl;
beforeAll(async () => {
  seed();
  await refreshRoleCache();
  await new Promise((done) => {
    const app = express();
    app.use(express.json({ limit: '20mb' }));
    app.use('/api/ai', aiRoutes);
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => { baseUrl = 'http://127.0.0.1:' + server.address().port; done(); });
  });
});
beforeEach(() => { seed(); });
afterAll((done) => { server.close(() => done()); });

// Drive: the outer agent calls escalate_to_86 naming the entity; the inner 86
// session answers immediately. Returns the text of the escalation's opening
// user.message — exactly what 86 was handed.
async function escalationPrompt(user, entityType, entityId) {
  const epoch = resetWire();
  globalThis.__SCRIPT__ = [
    toolTurn('evt_esc', 'escalate_to_86', {
      question: 'How is this ' + entityType + ' doing on margin?',
      entity_type: entityType, entity_id: entityId
    }),
    finalTurn('Inner answer.'),
    finalTurn('Relayed.')
  ];
  for (const l of [aiChatLimiter, aiChatHourlyLimiter]) { try { l.resetKey('u:' + user.id); } catch (_) {} }
  const res = await fetch(baseUrl + '/api/ai/86/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + signToken(user) },
    body: JSON.stringify({ message: 'How is ' + entityId + ' doing?' })
  });
  const body = await res.text();
  if (res.status !== 200) throw new Error('/86/chat answered ' + res.status + ': ' + body.slice(0, 200));
  const msgs = globalThis.__SENT__.filter(e => e.__epoch === epoch && e.type === 'user.message')
    .map(e => (e.content || []).filter(b => b && b.type === 'text').map(b => b.text).join('\n'))
    .filter(t => t.includes('FOCUSED escalation'));
  // Exactly one escalation opened, or the property below proves nothing.
  if (msgs.length !== 1) throw new Error('expected ONE escalation prompt, saw ' + msgs.length);
  return msgs[0];
}

describe('P0 — the fixture reaches the code under test', () => {
  test('an unrestricted-enough caller DOES get the salted WIP figures (the pack is not empty for everyone)', async () => {
    const p = await escalationPrompt(USERS.pm, 'job', 'j-salt');
    for (const m of JOB_MONEY) expect(p).toContain(m);
    expect(p).toContain('<entity_index>');
  });
  // The estimate pack is attached for an estimate reader, but its CONTENT is
  // currently "[object Object],[object Object]": driveEscalateTo86 takes
  // buildEstimateContext().system, which is a block ARRAY, not a string (the
  // live chat path unwraps it with ctxDynamicText). That is a separate,
  // pre-existing defect and NOT fixed here, because fixing it would make the
  // shown set bigger. So the estimate properties below key on whether the
  // index is attached at all, which is the thing the gate decides.
  test('an estimate reader gets an entity index for the estimate', async () => {
    const p = await escalationPrompt(USERS.pm, 'estimate', 'e-salt');
    expect(p).toContain('<entity_index>');
    expect(p).not.toMatch(/No entity index is attached/);
  });
  test('the job number resolves to the row (the Assistant names jobs by number)', async () => {
    const p = await escalationPrompt(USERS.pm, 'job', 'W-7731');
    expect(p).toContain('987,654');
  });
});

describe('P1 — a caller without FINANCIALS_VIEW is handed no job money', () => {
  test.each([['nocaps'], ['crew'], ['leadsonly']])('%s: no WIP, no budgets, no index', async (who) => {
    for (const id of ['j-salt', 'W-7731']) {
      const p = await escalationPrompt(USERS[who], 'job', id);
      for (const m of JOB_MONEY) expect([who, id, m, p.includes(m)]).toEqual([who, id, m, false]);
      expect(p).not.toContain('<entity_index>');
      expect(p).not.toContain('Salted Palms');
      expect(p).toMatch(/No entity index is attached/);   // no pack at all, not a trimmed one
      // 86 is told why, so it does not narrate figures it was never given.
      expect(p).toMatch(/FINANCIALS_VIEW/);
    }
  });
});

describe('P2 — a FINANCIALS_VIEW holder still gets the figures (harden, not lock out)', () => {
  test.each([['finance'], ['pm']])('%s: WIP snapshot is present', async (who) => {
    const p = await escalationPrompt(USERS[who], 'job', 'j-salt');
    for (const m of JOB_MONEY) expect(p).toContain(m);
    expect(p).not.toMatch(/No entity index is attached/);
  });
});

describe('P3 — the estimate pack follows the estimate read rule', () => {
  test.each([['nocaps'], ['finance'], ['leadsonly']])('%s (no ESTIMATES_VIEW): no lines, no costs', async (who) => {
    const p = await escalationPrompt(USERS[who], 'estimate', 'e-salt');
    expect(p).not.toContain('<entity_index>');
    expect(p).not.toContain('Salted shingles');
    expect(p).not.toContain('4321');
    expect(p).toMatch(/ESTIMATES_VIEW/);
  });
  test('crew (ESTIMATES_VIEW) still gets the estimate index', async () => {
    const p = await escalationPrompt(USERS.crew, 'estimate', 'e-salt');
    expect(p).toContain('<entity_index>');
  });
});

describe('P4 — ONE rule: the pack follows aiToolCapabilityDenial, not a copy of it', () => {
  test('the role matrix is not one-sided (each gate admits some role and refuses another)', () => {
    const j = Object.values(USERS).map(u => !aiToolCapabilityDenial('read_entity', { entity_type: 'job', id: 'j-salt', include: ['building_breakdown'] }, u));
    const e = Object.values(USERS).map(u => !aiToolCapabilityDenial('read_entity', { entity_type: 'estimate', id: 'e-salt' }, u));
    expect(new Set(j)).toEqual(new Set([true, false]));
    expect(new Set(e)).toEqual(new Set([true, false]));
  });
  // Executed across every role: "gets the job pack" must equal "the 86 read
  // gate admits read_entity{job, building_breakdown}", and likewise for the
  // estimate. A second opinion that drifts from the gate fails here.
  test.each(Object.keys(USERS))('%s', async (who) => {
    const u = USERS[who];
    const jobAllowed = !aiToolCapabilityDenial('read_entity',
      { entity_type: 'job', id: 'j-salt', include: ['building_breakdown'] }, u);
    const estAllowed = !aiToolCapabilityDenial('read_entity', { entity_type: 'estimate', id: 'e-salt' }, u);
    const pj = await escalationPrompt(u, 'job', 'j-salt');
    const pe = await escalationPrompt(u, 'estimate', 'e-salt');
    expect([who, 'job', pj.includes('987,654')]).toEqual([who, 'job', jobAllowed]);
    expect([who, 'estimate', pe.includes('<entity_index>')]).toEqual([who, 'estimate', estAllowed]);
  });
});
