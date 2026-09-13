// A DEAL'S FIGURES REACH A REST CALLER ONLY BY THE RULE 86'S <deal_memory>
// BLOCK USES, AND A DEAL THREAD HUNG FROM ANOTHER TENANT'S LINEAGE IS
// ARCHIVED ON BOOT AND REFUSED ON LOAD.
//
// THE LEAKS (on leak2-builder 31d779ea)
//   1. GET /api/ai/sessions, GET /api/ai/sessions/search, GET /:id and
//      POST /:id/export {format:'json'} returned deal_memory.numbers — a job
//      deal's contract / CO income / % complete, an estimate deal's proposal
//      total / base cost / blended markup, a lead deal's revenue — to EVERY
//      role, while /86/chat withheld the same figures from the same caller.
//   2. Their LEFT JOIN deal_memory had no organization predicate, so a thread
//      keyed on another tenant's lineage joined that tenant's figures.
//   3. GET /:id and the export read ai_messages with no organization predicate.
//   4. Deal threads minted on a foreign lineage before the walk was scoped
//      stayed listed and loadable by session_id.
//
// THE RULE IS NOT RESTATED HERE: `allowed` executes aiToolCapabilityDenial with
// the same read_entity inputs turnContextMoneyDenial builds.
//
// DEALREST_DUMP=<file> writes every allowed-caller response captured in the
// fixed drive order so a base tree can be byte-compared with this one.

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-a-real-key';
process.env.AGENT_MODE_86 = 'agents';
process.env.DEAL_THREADS = 'on';

jest.setTimeout(120000);

const fs = require('fs');
const express = require('express');
const http = require('http');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const TABLES = ['organizations', 'roles', 'users', 'jobs', 'leads', 'estimates', 'clients',
  'ai_sessions', 'ai_messages', 'deal_memory', 'app_settings'];

const engine = createPgSqlite(
  sqliteSchema(TABLES, {
    pk: { organizations: 'id', roles: 'name', users: 'id', jobs: 'id', leads: 'id', estimates: 'id',
      clients: 'id', ai_sessions: 'id', ai_messages: 'id', deal_memory: 'lineage_root', app_settings: 'key' }
  }),
  {
    jsonColumns: ['data', 'capabilities', 'numbers', 'deal_numbers', 'notes', 'inline_image_blocks', 'output_files', 'settings'],
    dateColumns: ['updated_at', 'created_at', 'last_used_at', 'archived_at', 'numbers_at']
  }
);
globalThis.__ENGINE__ = engine;

// The list query's last-message LATERAL is the one statement the shim cannot
// translate; it is rewritten to the correlated scalar subquery it is equivalent
// to (same row, same 120-char snippet). Nothing else is rewritten, and a
// statement that fails to prepare THROWS — no swallowing.
jest.mock('../server/db', () => {
  const real = globalThis.__ENGINE__.pool;
  const lateral = /substr\(lm\.content, 1, 120\) AS last_snippet([\s\S]*?)LEFT JOIN LATERAL \(\s*SELECT content FROM ai_messages m\s*WHERE m\.session_id = s\.id\s*ORDER BY m\.created_at DESC LIMIT 1\s*\) lm ON true/;
  const q = async (sql, params) => {
    let s = String(sql);
    if (lateral.test(s)) {
      s = s.replace(lateral, (_m, mid) =>
        'substr((SELECT content FROM ai_messages m WHERE m.session_id = s.id ORDER BY m.created_at DESC LIMIT 1), 1, 120) AS last_snippet' + mid);
    }
    return real.query(s, params);
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
jest.mock('@anthropic-ai/sdk', () => {
  function FakeAnthropic() {
    return { messages: {}, beta: { sessions: { create: async () => ({ id: 'sess_x' }), archive: async () => ({}) } } };
  }
  return Object.assign(FakeAnthropic, { default: FakeAnthropic, toFile: async () => ({}) });
});

const { setRolePool, refreshRoleCache, signToken } = require('../server/auth');
const aiRoutes = require('../server/routes/ai-routes');
const aiSessionsRoutes = require('../server/routes/ai-sessions-routes');
const { aiToolCapabilityDenial } = aiRoutes.internals;
const { pool } = require('../server/db');
setRolePool(pool);

const ORGS = { A: 900000401, B: 900000402 };
const ROLES = {
  nocaps: [],
  crew: ['JOBS_VIEW_ALL', 'PROGRESS_UPDATE'],
  estonly: ['ESTIMATES_VIEW'],
  leadsonly: ['LEADS_VIEW'],
  sub: ['SUB_PORTAL_VIEW', 'SUB_PORTAL_UPLOAD'],
  finance: ['FINANCIALS_VIEW'],
  admin: ['JOBS_VIEW_ALL', 'FINANCIALS_VIEW', 'ESTIMATES_VIEW', 'LEADS_VIEW', 'USERS_MANAGE', 'ROLES_MANAGE']
};
const ROLE_NAMES = Object.keys(ROLES);
const USERS = {};
let uid = 700;
for (const r of ROLE_NAMES) {
  USERS[r] = { id: ++uid, email: r + '@dr.test', name: 'DR ' + r, role: r, organization_id: ORGS.A };
}
USERS.bAdmin = { id: ++uid, email: 'badmin@dr.test', name: 'DR B admin', role: 'admin', organization_id: ORGS.B };
USERS.orgless = { id: ++uid, email: 'orgless@dr.test', name: 'DR orgless', role: 'admin', organization_id: null };

// Salted figures — strings nothing else in a response can produce.
const FIG = {
  job: { contract: 987654.31, coIncome: 11223.44, totalContract: 998877.75, pctComplete: 37 },
  est: { proposalTotal: 43210.57, baseCost: 31415.92, blendedMarkupPct: 27.3 },
  lead: { estRevenueLow: 71113.13, estRevenueHigh: 72227.27, confidence: 64 },
  foreign: { contract: 555321.09 }
};
const FIGURE_STRINGS = ['987654.31', '11223.44', '998877.75', '43210.57', '31415.92', '27.3', '71113.13', '72227.27'];
const FOREIGN_STRINGS = ['555321.09', 'FOREIGN-HISTORY-555321', '444333.21'];

const T0 = '2026-09-01 12:00:00';
let sessionSeq = 5000;
const SID = {};   // `${userKey}:${kind}` -> session id

function seed() {
  const db = engine.db;
  for (const t of TABLES) db.exec('DELETE FROM ' + t + ';');
  db.prepare('INSERT INTO organizations (id,name,slug) VALUES (?,?,?)').run(ORGS.A, 'DR Org A', 'dra');
  db.prepare('INSERT INTO organizations (id,name,slug) VALUES (?,?,?)').run(ORGS.B, 'DR Org B', 'drb');
  const r = db.prepare('INSERT INTO roles (name,label,capabilities) VALUES (?,?,?)');
  for (const [name, caps] of Object.entries(ROLES)) r.run(name, name, JSON.stringify(caps));
  const u = db.prepare('INSERT INTO users (id,email,name,role,organization_id,active) VALUES (?,?,?,?,?,1)');
  for (const x of Object.values(USERS)) u.run(x.id, x.email, x.name, x.role, x.organization_id);

  const lead = db.prepare('INSERT INTO leads (id,title,status,organization_id,updated_at) VALUES (?,?,?,?,?)');
  const est = db.prepare('INSERT INTO estimates (id,owner_id,organization_id,data,updated_at) VALUES (?,?,?,?,?)');
  const job = db.prepare('INSERT INTO jobs (id,owner_id,organization_id,lead_id,estimate_id,data,updated_at) VALUES (?,?,?,?,?,?,?)');
  const owner = USERS.admin.id;
  lead.run('lead-dra1', 'Salted Deal Lead One', 'won', ORGS.A, T0);
  est.run('est-dra1', owner, ORGS.A, JSON.stringify({ title: 'Salted Deal Estimate One', lead_id: 'lead-dra1' }), T0);
  job.run('job-dra1', owner, ORGS.A, 'lead-dra1', 'est-dra1', JSON.stringify({ jobNumber: 'DRA-1', title: 'Salted Deal Job One' }), T0);
  lead.run('lead-dra2', 'Salted Deal Lead Two', 'proposal', ORGS.A, T0);
  est.run('est-dra2', owner, ORGS.A, JSON.stringify({ title: 'Salted Deal Estimate Two', lead_id: 'lead-dra2' }), T0);
  lead.run('lead-dra3', 'Salted Deal Lead Three', 'new', ORGS.A, T0);
  lead.run('lead-drb1', 'Other Tenant Lead', 'won', ORGS.B, T0);
  job.run('job-drb1', USERS.bAdmin.id, ORGS.B, 'lead-drb1', null, JSON.stringify({ jobNumber: 'DRB-1', title: 'Other Tenant Job' }), T0);

  const dm = db.prepare('INSERT INTO deal_memory (lineage_root,root_type,organization_id,numbers,numbers_stage,notes) VALUES (?,?,?,?,?,?)');
  dm.run('lead-dra1', 'lead', ORGS.A, JSON.stringify(Object.assign({ stage: 'job', jobId: 'job-dra1', wipPending: true }, FIG.job)), 'job', '[]');
  dm.run('lead-dra2', 'lead', ORGS.A, JSON.stringify(Object.assign({ stage: 'estimate', estimateId: 'est-dra2' }, FIG.est)), 'estimate', '[]');
  dm.run('lead-dra3', 'lead', ORGS.A, JSON.stringify(Object.assign({ stage: 'lead', leadId: 'lead-dra3', status: 'new' }, FIG.lead)), 'lead', '[]');
  dm.run('lead-drb1', 'lead', ORGS.B, JSON.stringify({ stage: 'job', jobId: 'job-drb1', contract: FIG.foreign.contract, pctComplete: 5 }), 'job', '[]');

  const ses = db.prepare(`INSERT INTO ai_sessions (id,agent_key,entity_type,entity_id,user_id,anthropic_session_id,anthropic_agent_id,
      created_at,last_used_at,label,session_kind,lineage_root,turn_count,pinned,total_cost_usd)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,0,0)`);
  const msg = db.prepare(`INSERT INTO ai_messages (id,estimate_id,user_id,role,content,entity_type,session_id,organization_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const mk = (userKey, kind, entityType, entityId, lineageRoot, label, minute) => {
    const id = ++sessionSeq;
    SID[userKey + ':' + kind] = id;
    const when = '2026-09-01 12:' + String(minute).padStart(2, '0') + ':00';
    ses.run(id, 'job', entityType, entityId, USERS[userKey].id, 'sess_' + id, 'agent_test', T0, when,
      label, lineageRoot ? 'deal_thread' : 'user_thread', lineageRoot);
    return id;
  };
  for (const key of ROLE_NAMES) {
    const jobT = mk(key, 'job', 'job', 'job-dra1', 'lead-dra1', 'Saltdeal job thread', 10);
    const estT = mk(key, 'est', 'estimate', 'est-dra2', 'lead-dra2', 'Saltdeal estimate thread', 11);
    const leadT = mk(key, 'lead', 'lead', 'lead-dra3', 'lead-dra3', 'Saltdeal lead thread', 12);
    msg.run('m-' + jobT, 'job-dra1', USERS[key].id, 'user', 'own job turn', 'job', jobT, ORGS.A, T0);
    msg.run('m-' + estT, 'est-dra2', USERS[key].id, 'user', 'own estimate turn', 'estimate', estT, ORGS.A, T0);
    msg.run('m-' + leadT, 'lead-dra3', USERS[key].id, 'user', 'own lead turn', 'lead', leadT, ORGS.A, T0);
  }
  // DEALREST_NO_CROSS=1 seeds own-org rows only, for the byte-identity capture
  // (a cross-org row is excluded from the identity claim by definition).
  if (process.env.DEALREST_NO_CROSS === '1') return;
  // The production state leak2 left behind: an org-A admin's deal thread keyed
  // on org B's lineage, whose history carries org B's figure.
  const foreign = mk('admin', 'foreign', 'job', 'job-drb1', 'lead-drb1', 'Saltdeal foreign thread', 13);
  msg.run('m-foreign', 'job-drb1', USERS.admin.id, 'assistant', 'FOREIGN-HISTORY-555321 contract', 'job', foreign, ORGS.A, T0);
  // A message the admin wrote under ANOTHER org on the same entity key as the
  // admin's own job thread (a user who moved tenants).
  msg.run('m-otherorg', 'job-dra1', USERS.admin.id, 'user', 'OTHER-ORG-MESSAGE-BODY', 'job', null, ORGS.B, T0);
  // The join vector on its own: a thread whose lineage root exists in NO entity
  // table (so it is not 'foreign' and not refused) while a deal_memory row keyed
  // on that id belongs to org B. Only the join's org arm keeps B's figure out.
  mk('admin', 'ghost', 'lead', 'lead-ghost-b', 'lead-ghost-b', 'Saltdeal ghost thread', 14);
  dm.run('lead-ghost-b', 'lead', ORGS.B, JSON.stringify({ stage: 'lead', leadId: 'lead-ghost-b', estRevenueLow: 444333.21, estRevenueHigh: 444333.21 }), 'lead', '[]');
  // An account with no organization, owning an ordinary thread.
  mk('orgless', 'plain', 'general', 'global', null, 'Orgless thread', 15);
}

let server, baseUrl;
async function call(userKey, method, path, body) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + signToken(USERS[userKey]) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  return { status: res.status, text, json: (() => { try { return JSON.parse(text); } catch (_) { return null; } })() };
}

// Who the ONE rule admits for each deal stage, executed.
const allowed = {
  job: (u) => !aiToolCapabilityDenial('read_entity', { entity_type: 'job', id: 'job-dra1', include: ['building_breakdown'] }, u),
  est: (u) => !aiToolCapabilityDenial('read_entity', { entity_type: 'estimate', id: 'est-dra2' }, u),
  lead: (u) => !aiToolCapabilityDenial('read_entity', { entity_type: 'lead', id: 'lead-dra3' }, u)
};
const FIGS_BY_KIND = { job: ['987654.31', '11223.44', '998877.75'], est: ['43210.57', '31415.92', '27.3'], lead: ['71113.13', '72227.27'] };
const STAGE_ID = { job: ['job', 'jobId', 'job-dra1'], est: ['estimate', 'estimateId', 'est-dra2'], lead: ['lead', 'leadId', 'lead-dra3'] };

const R = {};   // captured responses, fixed order
beforeAll(async () => {
  seed();
  await refreshRoleCache();
  await new Promise((done) => {
    const app = express();
    app.use(express.json());
    app.use('/api/ai/sessions', aiSessionsRoutes);
    app.use('/api/ai', aiRoutes);
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => { baseUrl = 'http://127.0.0.1:' + server.address().port; done(); });
  });
  for (const key of ROLE_NAMES) {
    R[key + '|list'] = await call(key, 'GET', '/api/ai/sessions');
    R[key + '|search'] = await call(key, 'GET', '/api/ai/sessions/search?q=Saltdeal');
    for (const kind of ['job', 'est', 'lead']) {
      R[key + '|get|' + kind] = await call(key, 'GET', '/api/ai/sessions/' + SID[key + ':' + kind]);
      R[key + '|export|' + kind] = await call(key, 'POST', '/api/ai/sessions/' + SID[key + ':' + kind] + '/export', { format: 'json' });
      R[key + '|md|' + kind] = await call(key, 'POST', '/api/ai/sessions/' + SID[key + ':' + kind] + '/export', { format: 'markdown' });
    }
  }
  if (process.env.DEALREST_DUMP) {
    const out = {};
    for (const [k, v] of Object.entries(R)) out[k] = { status: v.status, text: v.text };
    fs.writeFileSync(process.env.DEALREST_DUMP, JSON.stringify(out, null, 1));
  }
});
afterAll((done) => { server.close(() => done()); });

const row = (resp, sid) => {
  const j = resp.json || {};
  if (Array.isArray(j.sessions)) return j.sessions.find((s) => String(s.id) === String(sid));
  if (Array.isArray(j.results)) return j.results.find((s) => String(s.id) === String(sid));
  return j.session;
};

describe('P0 — the fixture reaches the code under test', () => {
  test('admin sees every salted figure through every REST door', () => {
    for (const kind of ['job', 'est', 'lead']) {
      const sid = SID['admin:' + kind];
      for (const door of ['list', 'search']) {
        const r = row(R['admin|' + door], sid);
        expect([door, kind, !!r, FIGS_BY_KIND[kind].every((f) => JSON.stringify(r).includes(f))]).toEqual([door, kind, true, true]);
      }
      for (const door of ['get', 'export']) {
        const t = R['admin|' + door + '|' + kind].text;
        expect([door, kind, FIGS_BY_KIND[kind].every((f) => t.includes(f))]).toEqual([door, kind, true]);
      }
    }
  });
  test('the rule matrix is not one-sided for any stage', () => {
    for (const kind of ['job', 'est', 'lead']) {
      const seen = new Set(ROLE_NAMES.map((k) => allowed[kind](USERS[k])));
      expect([kind, [...seen].sort()]).toEqual([kind, [false, true]]);
    }
  });
});

describe('P1 — deal figures follow the <deal_memory> rule on every REST door', () => {
  for (const key of ROLE_NAMES) {
    test(key + ': list, search, get, export json', () => {
      for (const kind of ['job', 'est', 'lead']) {
        const ok = allowed[kind](USERS[key]);
        const sid = SID[key + ':' + kind];
        const [stage, idKey, idVal] = STAGE_ID[kind];
        const rows = [row(R[key + '|list'], sid), row(R[key + '|search'], sid),
          row(R[key + '|get|' + kind], sid), row(R[key + '|export|' + kind], sid)];
        rows.forEach((r, i) => {
          const where = [key, kind, ['list', 'search', 'get', 'export'][i]];
          expect([...where, !!r]).toEqual([...where, true]);
          const s = JSON.stringify(r.deal_numbers);
          if (ok) {
            expect([...where, FIGS_BY_KIND[kind].every((f) => s.includes(f)), r.deal_numbers_withheld]).toEqual([...where, true, undefined]);
          } else {
            expect([...where, FIGS_BY_KIND[kind].some((f) => s.includes(f)), r.deal_numbers_withheld,
              r.deal_numbers.stage, r.deal_numbers[idKey]]).toEqual([...where, false, true, stage, idVal]);
          }
        });
        // Nothing anywhere in the whole response body for a denied caller.
        if (!ok) {
          for (const door of ['get|' + kind, 'export|' + kind, 'md|' + kind]) {
            expect([key, door, FIGS_BY_KIND[kind].some((f) => R[key + '|' + door].text.includes(f))]).toEqual([key, door, false]);
          }
        }
      }
    });
  }
  test('a denied caller still gets its whole list (no 403) and every row', () => {
    for (const key of ROLE_NAMES) {
      expect([key, R[key + '|list'].status, R[key + '|list'].json.sessions.length]).toEqual([key, 200, key === 'admin' ? 5 : 3]);
    }
  });
  test('the list for sub and nocaps carries no figure string at all', () => {
    for (const key of ['sub', 'nocaps']) {
      expect([key, FIGURE_STRINGS.filter((f) => R[key + '|list'].text.includes(f))]).toEqual([key, []]);
      expect([key, FIGURE_STRINGS.filter((f) => R[key + '|search'].text.includes(f))]).toEqual([key, []]);
    }
  });
});

describe('P2 — joins and reads are organization-scoped; foreign lineage is refused', () => {
  test('the foreign thread lists (archived view) with NO other-tenant figure, even for admin', async () => {
    const r = await call('admin', 'GET', '/api/ai/sessions?include_archived=1');
    const fr = row(r, SID['admin:foreign']);
    expect([r.status, !!fr, FOREIGN_STRINGS.some((f) => r.text.includes(f))]).toEqual([200, true, false]);
    expect([fr.foreign_lineage, fr.last_snippet, fr.deal_numbers]).toEqual([true, null, null]);
    // An in-org row is not marked.
    expect(row(r, SID['admin:job']).foreign_lineage).toBeUndefined();
  });
  test('search by the foreign history body returns the thread without the body', async () => {
    const r = await call('admin', 'GET', '/api/ai/sessions/search?q=FOREIGN-HISTORY');
    const fr = row(r, SID['admin:foreign']);
    expect([r.status, !!fr, fr && fr.foreign_lineage, FOREIGN_STRINGS.some((f) => r.text.includes(f))]).toEqual([200, true, true, false]);
  });
  test('GET /:id, export, branch, /86/messages and restore refuse the foreign thread', async () => {
    const sid = SID['admin:foreign'];
    const doors = [
      await call('admin', 'GET', '/api/ai/sessions/' + sid),
      await call('admin', 'POST', '/api/ai/sessions/' + sid + '/export', { format: 'json' }),
      await call('admin', 'POST', '/api/ai/sessions/' + sid + '/export', { format: 'markdown' }),
      await call('admin', 'POST', '/api/ai/sessions/' + sid + '/branch', { from_message_id: 'm-foreign' }),
      await call('admin', 'GET', '/api/ai/86/messages?session_id=' + sid),
      await call('admin', 'PATCH', '/api/ai/sessions/' + sid, { archived: false })
    ];
    doors.forEach((d, i) => {
      expect([i, d.status, d.json && d.json.code, FOREIGN_STRINGS.some((f) => d.text.includes(f))])
        .toEqual([i, 409, 'DEAL_THREAD_FOREIGN_LINEAGE', false]);
    });
    // Archiving it is still allowed.
    const arch = await call('admin', 'PATCH', '/api/ai/sessions/' + sid, { archived: true });
    expect(arch.status).toBe(200);
  });
  test('an in-org deal thread still loads through /86/messages', async () => {
    const d = await call('admin', 'GET', '/api/ai/86/messages?session_id=' + SID['admin:job']);
    expect([d.status, d.text.includes('own job turn')]).toEqual([200, true]);
  });
  test('GET /:id and export do not return a message stamped with another org', () => {
    for (const door of ['get|job', 'export|job', 'md|job']) {
      expect([door, R['admin|' + door].text.includes('own job turn'), R['admin|' + door].text.includes('OTHER-ORG-MESSAGE-BODY')])
        .toEqual([door, true, false]);
    }
  });
});

describe('P2b — the deal_memory join is org-scoped on every door', () => {
  test('a thread keyed on an id whose deal_memory row is org B carries no B figure', async () => {
    const sid = SID['admin:ghost'];
    const doors = [
      await call('admin', 'GET', '/api/ai/sessions'),
      await call('admin', 'GET', '/api/ai/sessions/search?q=Saltdeal%20ghost'),
      await call('admin', 'GET', '/api/ai/sessions/' + sid),
      await call('admin', 'POST', '/api/ai/sessions/' + sid + '/export', { format: 'json' })
    ];
    doors.forEach((d, i) => {
      const r = row(d, sid);
      expect([i, d.status, !!r, r && r.deal_numbers, d.text.includes('444333.21')]).toEqual([i, 200, true, null, false]);
    });
  });
  test('an account with no organization is refused history, out loud', async () => {
    const sid = SID['orgless:plain'];
    for (const d of [await call('orgless', 'GET', '/api/ai/sessions/' + sid),
      await call('orgless', 'POST', '/api/ai/sessions/' + sid + '/export', { format: 'json' })]) {
      expect([d.status, d.json && d.json.code]).toEqual([409, 'ORG_UNRESOLVED']);
    }
  });
});

describe('P3 — fail closed', () => {
  const withholdDealFigures = (...args) => aiSessionsRoutes.internals.withholdDealFigures(...args);
  const sample = () => ({ session_kind: 'deal_thread', deal_numbers: Object.assign({ stage: 'job', jobId: 'job-dra1' }, FIG.job) });
  test('a missing user is denied', () => {
    const r = withholdDealFigures(sample(), null);
    expect([r.deal_numbers_withheld, JSON.stringify(r.deal_numbers)]).toEqual([true, '{"stage":"job","jobId":"job-dra1"}']);
  });
  test('a role-less user is denied', () => {
    expect(withholdDealFigures(sample(), { id: 1 }).deal_numbers_withheld).toBe(true);
  });
  test('an unrecognised stage is withheld even for admin', () => {
    const r = withholdDealFigures({ deal_numbers: { stage: 'mystery', contract: 1 } }, USERS.admin);
    expect([r.deal_numbers_withheld, r.deal_numbers]).toEqual([true, { stage: 'mystery' }]);
  });
  test('a figure-less numbers object is untouched; admin row untouched', () => {
    const empty = { deal_numbers: {} };
    expect(withholdDealFigures(empty, null)).toEqual({ deal_numbers: {} });
    const a = sample(); const before = JSON.stringify(a);
    expect(JSON.stringify(withholdDealFigures(a, USERS.admin))).toBe(before);
  });
});

describe('P4 — after the boot archive the foreign thread leaves the sidebar and stays refused', () => {
  test('archive, list, restore-refusal, load-refusal', async () => {
    const { archiveForeignDealThreads } = require('../server/services/deal-thread-archive');
    const sid = SID['admin:foreign'];
    engine.db.prepare('UPDATE ai_sessions SET archived_at = NULL WHERE id = ?').run(sid);
    const counts = await archiveForeignDealThreads(engine.pool, { log: () => {} });
    expect([counts.archived, counts.pairs]).toEqual([1, { [ORGS.A + '->' + ORGS.B]: 1 }]);
    const again = await archiveForeignDealThreads(engine.pool, { log: () => {} });
    expect(again.archived).toBe(0);
    const list = await call('admin', 'GET', '/api/ai/sessions');
    expect([list.status, !!row(list, sid), list.json.sessions.length]).toEqual([200, false, 4]);
    const msgs = await call('admin', 'GET', '/api/ai/86/messages?session_id=' + sid);
    expect([msgs.status, msgs.json.code]).toEqual([409, 'DEAL_THREAD_FOREIGN_LINEAGE']);
    const restore = await call('admin', 'PATCH', '/api/ai/sessions/' + sid, { archived: false });
    expect(restore.status).toBe(409);
    expect(engine.db.prepare('SELECT archived_at FROM ai_sessions WHERE id = ?').get(sid).archived_at).not.toBeNull();
    // Nothing deleted.
    expect(engine.db.prepare('SELECT COUNT(*) AS n FROM ai_messages WHERE session_id = ?').get(sid).n).toBe(1);
  });
});
