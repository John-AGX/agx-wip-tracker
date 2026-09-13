// A REFERENCE SHEET'S ROWS REACH 86 ONLY THROUGH search_reference_sheet, AND
// THAT TOOL ANSWERS ONLY A ROLE THAT MAY SEE FINANCIALS.
//
// THE LEAK (on dr-a 1a37e687 / leak2-builder 31d779ea)
//   1. buildReferenceLinksBlock (admin-agents-routes.js) concatenated every
//      pinned (inject_mode='inline') sheet's last_fetched_text into the
//      REGISTERED per-org agent prompt via composedAgentSystem. That prompt is
//      shared by every user of the org, so a pinned WIP report reached `sub`
//      and zero-capability roles on every turn.
//   2. search_reference_sheet had no AI_TOOL_CAPABILITY entry, so any role
//      could read every enabled sheet, pinned or lookup.
//
// THE RULE IS NOT RESTATED HERE: who may read is decided by EXECUTING
// aiToolCapabilityDenial, and the drive shows the served / refused split
// follows it (and that it is not one-sided).

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-a-real-key';
process.env.AGENT_MODE_86 = 'agents';
process.env.DEAL_THREADS = 'off';

jest.setTimeout(300000);

const express = require('express');
const http = require('http');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const TABLES = [
  'organizations', 'roles', 'users', 'agent_reference_links',
  'jobs', 'leads', 'estimates', 'clients', 'attachments',
  'agent_jobs', 'ai_sessions', 'ai_messages', 'payloads', 'deal_memory', 'tasks',
  'context_load_events', 'app_settings', 'email_log', 'org_memory', 'messages'
];

const engine = createPgSqlite(
  sqliteSchema(TABLES, {
    pk: {
      organizations: 'id', roles: 'name', users: 'id', agent_reference_links: 'id', jobs: 'id', leads: 'id',
      estimates: 'id', clients: 'id', attachments: 'id', agent_jobs: 'id', ai_sessions: 'id', ai_messages: 'id',
      payloads: 'id', deal_memory: 'lineage_root', tasks: 'id', app_settings: 'key', email_log: 'id',
      org_memory: 'id', messages: 'id'
    }
  }),
  {
    jsonColumns: ['data', 'capabilities', 'notification_prefs', 'tags', 'payload', 'settings',
      'annotations', 'agent_notes', 'numbers', 'notes', 'metadata'],
    dateColumns: ['updated_at', 'created_at', 'uploaded_at', 'last_seen_at', 'last_used_at', 'last_fetched_at']
  }
);
globalThis.__ENGINE__ = engine;

// Statements the chat route runs against tables this fixture does not model
// answer empty. The reference-sheet reads are NOT allowed to fall into that
// hole: every served assertion below requires the salted row to come back, so
// a read that failed to execute cannot pass as a refusal's twin.
jest.mock('../server/db', () => {
  const real = globalThis.__ENGINE__.pool;
  const q = async (sql, params) => {
    const s = String(sql);
    if (s.includes('to_jsonb')) return { rows: [], rowCount: 1 };
    if (s.includes('agent_reference_links')) return real.query(sql, params);
    try { return await real.query(sql, params); } catch (_) { return { rows: [], rowCount: 0 }; }
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
// The chat route needs the managed-agent helpers stubbed; the prompt composer
// needs the REAL buildReferenceLinksBlock. It is loaded with requireActual
// under a fake clock (the module arms a timeout and an interval at load).
jest.mock('../server/routes/admin-agents-routes', () => ({
  ensureManagedEnvironment: async () => ({ anthropic_environment_id: 'env_test' }),
  ensureManagedAgent: async () => ({ anthropic_agent_id: 'agent_test' }),
  buildReferenceLinksBlock: (...a) => globalThis.__REAL_AGENTS__.buildReferenceLinksBlock(...a)
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
              return { data: (body.events || []).map((e, i) => ({ type: e.type, id: 'sevt_' + i })) };
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
const I = aiRoutes.internals;
const { pool } = require('../server/db');
setRolePool(pool);
jest.useFakeTimers();
globalThis.__REAL_AGENTS__ = jest.requireActual('../server/routes/admin-agents-routes');
jest.useRealTimers();

const ORGS = { A: 900000501, B: 900000502, C: 900000503 };
// Explicit capability sets; the builtin rows are copied from server/db.js
// BUILTIN_ROLES so the report can say which real roles keep access.
const ROLES = {
  nocaps: [],
  sub: ['SUB_PORTAL_VIEW', 'SUB_PORTAL_UPLOAD'],
  field_crew: ['ESTIMATES_VIEW', 'ESTIMATES_EDIT'],
  crew: ['JOBS_VIEW_ALL', 'PROGRESS_UPDATE'],
  leadsonly: ['LEADS_VIEW'],
  finance: ['FINANCIALS_VIEW'],
  pm: ['JOBS_VIEW_ALL', 'JOBS_EDIT_OWN', 'FINANCIALS_VIEW', 'PROGRESS_UPDATE', 'ESTIMATES_VIEW', 'ESTIMATES_EDIT',
    'LEADS_VIEW', 'LEADS_EDIT', 'INSIGHTS_VIEW'],
  corporate: ['JOBS_VIEW_ALL', 'FINANCIALS_VIEW', 'ESTIMATES_VIEW', 'LEADS_VIEW', 'INSIGHTS_VIEW'],
  admin: ['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'JOBS_DELETE', 'JOBS_GO_LIVE', 'JOBS_REASSIGN',
    'FINANCIALS_VIEW', 'PROGRESS_UPDATE', 'ESTIMATES_VIEW', 'ESTIMATES_EDIT',
    'LEADS_VIEW', 'LEADS_EDIT', 'USERS_MANAGE', 'ROLES_MANAGE', 'INSIGHTS_VIEW', 'ADMIN_METRICS']
};
const ROLE_NAMES = Object.keys(ROLES);
const USERS = {};
let uid = 600;
for (const r of ROLE_NAMES) {
  USERS[r] = { id: ++uid, email: r + '@rs.test', name: 'RS ' + r, role: r, organization_id: ORGS.A };
}
USERS.bAdmin = { id: ++uid, email: 'badmin@rs.test', name: 'RS B admin', role: 'admin', organization_id: ORGS.B };

// Salted sheet bodies. Every salt is a string only that sheet's rows print.
const SHEETS = [
  // [id, org, title, mode, text]
  ['rl-a-wip', ORGS.A, 'WIP Report A', 'inline',
    '| Job | Contract | Margin |\n| A-7731 SALTWIP-A | 987654.31 | 41.3% |\n| A-7732 | 123456.78 | 22.0% |'],
  ['rl-a-jobs', ORGS.A, 'Job Numbers A', 'lookup',
    '| Job | Community |\n| A-7731 | SALTJOB-A Latitude |'],
  ['rl-b-wip', ORGS.B, 'WIP Report B', 'inline',
    '| Job | Contract |\n| B-1 SALTWIP-B | 555321.09 |'],
  ['rl-c-jobs', ORGS.C, 'Job Numbers C', 'lookup',
    '| Job |\n| C-1 SALTJOB-C |']
];
const A_SALTS = ['SALTWIP-A', '987654.31', 'SALTJOB-A'];
const B_SALTS = ['SALTWIP-B', '555321.09'];

function seed() {
  const db = engine.db;
  for (const t of TABLES) db.exec('DELETE FROM ' + t + ';');
  const o = db.prepare('INSERT INTO organizations (id,name,slug) VALUES (?,?,?)');
  o.run(ORGS.A, 'RS Org A', 'rsa'); o.run(ORGS.B, 'RS Org B', 'rsb'); o.run(ORGS.C, 'RS Org C', 'rsc');
  const r = db.prepare('INSERT INTO roles (name,label,capabilities) VALUES (?,?,?)');
  for (const [name, caps] of Object.entries(ROLES)) r.run(name, name, JSON.stringify(caps));
  const u = db.prepare('INSERT INTO users (id,email,name,role,organization_id,active) VALUES (?,?,?,?,?,1)');
  for (const x of Object.values(USERS)) u.run(x.id, x.email, x.name, x.role, x.organization_id);
  const s = db.prepare(`INSERT INTO agent_reference_links (id,organization_id,title,url,description,enabled,max_rows,
      inject_mode,last_fetch_status,last_fetched_text,last_fetched_row_count,created_at,updated_at)
    VALUES (?,?,?,?,?,1,200,?,'ok',?,?,?,?)`);
  SHEETS.forEach(([id, org, title, mode, text], i) => {
    const when = '2026-09-01 12:0' + i + ':00';
    s.run(id, org, title, 'https://sheets.test/' + id, 'DESC-' + id, mode, text, text.split('\n').length, when, when);
  });
}

let epochSeq = 0;
function resetWire() {
  globalThis.__SENT__ = [];
  globalThis.__SCRIPT__ = [];
  globalThis.__EPOCH__ = ++epochSeq;
  return globalThis.__EPOCH__;
}
const finalTurn = (text) => ([
  { type: 'agent.message', content: [{ type: 'text', text }] },
  { type: 'session.status_idle', stop_reason: { type: 'end_turn' } }
]);
const toolTurn = (id, name, input) => ([
  { type: 'agent.custom_tool_use', id, tool_name: name, input },
  { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: [id] } }
]);

const { aiChatLimiter, aiChatHourlyLimiter } = require('../server/rate-limit');
let server, baseUrl;

// One /86/chat turn whose model asks for the sheet with a query and with no
// arguments (the listing), directly or through escalate_to_86 (whose inner 86
// dispatches through the same gate). Returns each tool result's text.
async function drive(userKey, viaEscalation) {
  const user = USERS[userKey];
  const epoch = resetWire();
  const reads = [
    toolTurn('t_q', 'search_reference_sheet', { query: 'A-7731' }),
    toolTurn('t_b', 'search_reference_sheet', { query: '-1' }),
    toolTurn('t_l', 'search_reference_sheet', {})
  ];
  globalThis.__SCRIPT__ = viaEscalation
    ? [toolTurn('t_e', 'escalate_to_86', { question: 'What does the WIP sheet say for A-7731?' })].concat(reads, [finalTurn('inner'), finalTurn('outer')])
    : reads.concat([finalTurn('outer')]);
  for (const l of [aiChatLimiter, aiChatHourlyLimiter]) { try { l.resetKey('u:' + user.id); } catch (_) {} }
  const res = await fetch(baseUrl + '/api/ai/86/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + signToken(user) },
    body: JSON.stringify({ message: 'what is the contract on A-7731?' })
  });
  await res.text();
  const out = {};
  for (const e of globalThis.__SENT__.filter(x => x.__epoch === epoch && x.type === 'user.custom_tool_result')) {
    out[e.custom_tool_use_id] = (e.content || []).map(b => (b && b.text) || '').join('\n');
  }
  // Every user.message this turn handed a session — the per-turn text must not
  // carry a sheet row either.
  out.__messages = globalThis.__SENT__.filter(x => x.__epoch === epoch && x.type === 'user.message')
    .map(e => (e.content || []).map(b => (b && b.text) || '').join('\n')).join('\n');
  return out;
}

async function execTool(userKey, input) {
  const res = await fetch(baseUrl + '/api/ai/exec-tool', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + signToken(USERS[userKey]) },
    body: JSON.stringify({ name: 'search_reference_sheet', input })
  });
  return { status: res.status, body: await res.text() };
}

// Who the gate admits, EXECUTED — not a capability name copied into the test.
const admitted = (r) => I.aiToolCapabilityDenial('search_reference_sheet', { query: 'x' }, USERS[r]) === null;

const RES = {};
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
  for (const r of ROLE_NAMES) {
    RES[r + ':direct'] = await drive(r, false);
    RES[r + ':esc'] = await drive(r, true);
  }
});
afterAll((done) => { server.close(() => { try { engine.close(); } catch (_) {} done(); }); });

describe('R1 — the registered per-org prompt carries pinned sheet TITLES, never a row', () => {
  const BASE = 'BASELINE-PROMPT';
  test('org A: its pinned title is indexed, and no row of any sheet is in the prompt', async () => {
    const sys = await I.composedAgentSystem('job', BASE, { id: ORGS.A });
    expect(sys.startsWith(BASE)).toBe(true);
    expect(sys).toContain('# Live reference sheets');
    expect(sys).toContain('\n- WIP Report A');
    expect(sys).toContain('search_reference_sheet');
    for (const salt of A_SALTS.concat(B_SALTS, ['SALTJOB-C', '123456.78', 'A-7731'])) expect([salt, sys.includes(salt)]).toEqual([salt, false]);
    // lookup sheets were never named in the prompt and still are not.
    expect(sys).not.toContain('Job Numbers A');
    // Nothing of another tenant.
    expect(sys).not.toContain('WIP Report B');
  });
  test('org B composes only its own title', async () => {
    const sys = await I.composedAgentSystem('job', BASE, { id: ORGS.B });
    expect(sys).toContain('\n- WIP Report B');
    expect(sys).not.toContain('WIP Report A');
    for (const salt of A_SALTS.concat(B_SALTS)) expect(sys).not.toContain(salt);
  });
  test('an org with no pinned sheet composes no block at all (bare baseline)', async () => {
    expect(await I.composedAgentSystem('job', BASE, { id: ORGS.C })).toBe(BASE);
  });
  test('the audit breakdown measures the same title-only block', async () => {
    const b = await I.composedAgentSystemBreakdown('job', BASE, { id: ORGS.A });
    const part = b.parts.find(p => /reference-links/.test(p.name));
    const block = (await globalThis.__REAL_AGENTS__.buildReferenceLinksBlock(ORGS.A)).trim();
    expect(part.chars).toBe(block.length);
    expect(block).not.toContain('SALTWIP-A');
  });
  test('a data-only refresh of a pinned sheet does not change the prompt (no re-registration)', async () => {
    const before = await I.composedAgentSystem('job', BASE, { id: ORGS.A });
    engine.db.prepare("UPDATE agent_reference_links SET last_fetched_text = ? WHERE id = 'rl-a-wip'")
      .run('| Job | Contract |\n| A-7731 SALTWIP-A-REFRESHED | 111.11 |');
    const after = await I.composedAgentSystem('job', BASE, { id: ORGS.A });
    engine.db.prepare("UPDATE agent_reference_links SET last_fetched_text = ? WHERE id = 'rl-a-wip'").run(SHEETS[0][4]);
    expect(after).toBe(before);
  });
  test('the index is bounded: titles past the cap are named by count', async () => {
    const ins = engine.db.prepare(`INSERT INTO agent_reference_links (id,organization_id,title,url,enabled,max_rows,inject_mode,
        last_fetch_status,last_fetched_text,created_at,updated_at) VALUES (?,?,?,?,1,200,'inline','ok','x SALTMANY','2026-09-02 00:00:00','2026-09-02 00:00:00')`);
    for (let i = 0; i < 120; i++) ins.run('rl-many-' + i, ORGS.C, 'Pinned sheet number ' + i + ' ' + 'T'.repeat(40), 'https://x/' + i);
    try {
      const block = await globalThis.__REAL_AGENTS__.buildReferenceLinksBlock(ORGS.C);
      expect(block.length).toBeLessThan(4200);
      expect(block).toMatch(/\(\d+ more — call `search_reference_sheet` with no arguments/);
      expect(block).not.toContain('SALTMANY');
    } finally {
      engine.db.exec("DELETE FROM agent_reference_links WHERE id LIKE 'rl-many-%'");
    }
  });
  test('no organization composes nothing', async () => {
    expect(await globalThis.__REAL_AGENTS__.buildReferenceLinksBlock(null)).toBe('');
  });
});

describe('R2 — search_reference_sheet through /86/chat, direct and through escalate_to_86', () => {
  const cases = [];
  for (const r of ROLE_NAMES) for (const via of ['direct', 'esc']) cases.push([r, via]);
  test.each(cases)('role %s, %s', (r, via) => {
    const out = RES[r + ':' + via];
    if (via === 'esc') expect(out.t_e).toBe('inner');
    for (const id of ['t_q', 't_b', 't_l']) expect([r, via, id, typeof out[id]]).toEqual([r, via, id, 'string']);
    const ok = admitted(r);
    expect([r, via, 'query served', out.t_q.includes('SALTWIP-A') && out.t_q.includes('987654.31')]).toEqual([r, via, 'query served', ok]);
    expect([r, via, 'listing served', out.t_l.includes('WIP Report A')]).toEqual([r, via, 'listing served', ok]);
    if (!ok) for (const id of ['t_q', 't_b', 't_l']) expect([r, via, id, out[id]]).toEqual([r, via, id, expect.stringMatching(/^Permission denied/)]);
    // Never another tenant's row, for anyone.
    for (const id of ['t_q', 't_b', 't_l']) for (const salt of B_SALTS) expect(out[id]).not.toContain(salt);
    // The turn's own messages never carry a row either.
    for (const salt of A_SALTS.concat(B_SALTS)) expect([r, via, salt, out.__messages.includes(salt)]).toEqual([r, via, salt, false]);
  });
  // The owner's rule in its own words, independent of what the gate answers:
  // an external sub and a zero-capability role never receive a sheet row, by
  // any door driven here. (The per-role cases above follow the executed gate,
  // so on a tree whose gate admits everyone they would agree with it.)
  test('sub and a zero-capability role never receive a row, directly or through escalation', () => {
    for (const r of ['sub', 'nocaps']) for (const via of ['direct', 'esc']) {
      const out = RES[r + ':' + via];
      for (const id of ['t_q', 't_b', 't_l']) {
        for (const salt of A_SALTS.concat(['WIP Report A', 'Job Numbers A'])) {
          expect([r, via, id, salt, String(out[id]).includes(salt)]).toEqual([r, via, id, salt, false]);
        }
      }
    }
  });
  test('the gate is not one-sided, and it follows the financials rule on the builtin roles', () => {
    const served = ROLE_NAMES.filter(r => RES[r + ':direct'].t_q.includes('SALTWIP-A'));
    expect(served.sort()).toEqual(['admin', 'corporate', 'finance', 'pm']);
    expect(ROLE_NAMES.filter(r => !served.includes(r)).sort()).toEqual(['crew', 'field_crew', 'leadsonly', 'nocaps', 'sub']);
  });
});

describe('R3 — the other doors and fail-closed callers', () => {
  test('POST /exec-tool: an ESTIMATES_VIEW role without financials is refused, an allowed role is served', async () => {
    const crew = await execTool('field_crew', { query: 'A-7731' });
    expect(crew.status).toBe(403);
    expect(crew.body).toMatch(/Permission denied/);
    expect(crew.body).not.toContain('SALTWIP-A');
    const pm = await execTool('pm', { query: 'A-7731' });
    expect(pm.status).toBe(200);
    expect(pm.body).toContain('SALTWIP-A');
    expect(pm.body).not.toContain('SALTWIP-B');
  });
  test('a missing or role-less user is denied', () => {
    expect(I.aiToolCapabilityDenial('search_reference_sheet', {}, null)).toMatch(/^Permission denied/);
    expect(I.aiToolCapabilityDenial('search_reference_sheet', {}, { id: 1, organization_id: ORGS.A })).toMatch(/^Permission denied/);
  });
  test('the requirement is read_wip_summary\'s, not a second opinion', () => {
    expect(I.aiToolRequiredCapability('search_reference_sheet', { query: 'x' }))
      .toEqual(I.aiToolRequiredCapability('read_wip_summary', {}));
  });
});
