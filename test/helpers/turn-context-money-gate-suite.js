// THE PER-TURN CONTEXT 86 IS HANDED MAY NOT CARRY MONEY THE CALLER'S ROLE WAS
// NEVER GRANTED, NOR ANY OTHER TENANT'S ROWS.
//
// Shared body of two test files, one per value of DEAL_THREADS (the flag is
// read once, at module load, so one file cannot drive both):
//   test/turn-context-money-gate.test.js       DEAL_THREADS=off
//   test/turn-context-money-gate-deal.test.js  DEAL_THREADS=on  (production)
//
// THE LEAKS (all on origin/main 8f5b2b31)
//   1. POST /api/ai/86/chat with current_context {estimate} pasted
//      buildEstimateContext into <turn_context> for EVERY caller: every line's
//      unit cost and markup, per-group subtotals, tax and fee settings.
//   2. ... with {job}: the job header's target margin, for every caller.
//   3. ... with {lead}: the lead's estimated revenue, for every caller.
//   4. DEAL_THREADS=on: the <deal_memory> block (job contract + CO income +
//      % complete; estimate proposal total + base cost + blended markup; lead
//      estimated revenue) for every caller -- AND resolveLineageRoot read the
//      job / estimate / lead by bare id, so a user in org A naming org B's job
//      in current_context was handed org B's contract and deal notes.
//   5. buildEstimateContext read the estimate blob's client_id and lead_id by
//      bare id, so an org-A estimate whose blob names an org-B client or lead
//      put that client's agent notes and that lead's revenue and notes into
//      org A's turn.
//
// THE RULE IS NOT RESTATED HERE
// Who may see a figure through 86 is decided by aiToolCapabilityDenial: the
// figure is gated on the read 86's own tools would use to serve it.
//   job money      read_entity{job, include:['building_breakdown']}  FINANCIALS_VIEW
//   estimate       read_entity{estimate}                             ESTIMATES_VIEW
//   lead revenue   read_entity{lead}                                 LEADS_VIEW
// The last describe executes that function for every role and requires the
// context to agree with it, so a copy of the rule that drifts fails here.
//
// WHAT IS DRIVEN
// The real /api/ai/86/chat route through a fake Sessions transport that records
// every event sent. Assertions read what the session was actually handed.
// MONEY_CTX_DUMP=<file> writes every captured turn to JSON so the same drive
// run on a pristine tree can be byte-compared with this one.

'use strict';

module.exports = function defineSuite({ dealThreads }) {
  process.env.JWT_SECRET = process.env.JWT_SECRET
    || 'test-only-secret-with-at-least-32-characters-of-padding';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-a-real-key';
  process.env.AGENT_MODE_86 = 'agents';
  process.env.DEAL_THREADS = dealThreads ? 'on' : 'off';

  jest.setTimeout(300000);

  const fs = require('fs');
  const express = require('express');
  const http = require('http');
  const { createPgSqlite } = require('./pg-sqlite');
  const { sqliteSchema } = require('./db-schema');

  const TABLES = [
    'organizations', 'roles', 'users',
    'jobs', 'leads', 'estimates', 'clients', 'attachments',
    'agent_jobs', 'ai_sessions', 'ai_messages', 'payloads', 'deal_memory', 'tasks',
    'context_load_events', 'app_settings', 'email_log', 'org_memory', 'messages',
    'receipts', 'job_workflow_items', 'compliance_items', 'invoices', 'qb_cost_lines',
    'job_vendor_bills', 'materials', 'assemblies'
  ];

  const engine = createPgSqlite(
    sqliteSchema(TABLES, {
      pk: {
        organizations: 'id', roles: 'name', users: 'id', jobs: 'id', leads: 'id', estimates: 'id',
        clients: 'id', attachments: 'id', agent_jobs: 'id', ai_sessions: 'id', ai_messages: 'id',
        payloads: 'id', deal_memory: 'lineage_root', tasks: 'id', app_settings: 'key', email_log: 'id',
        org_memory: 'id', messages: 'id', receipts: 'id', job_workflow_items: 'id',
        compliance_items: 'id', invoices: 'id', qb_cost_lines: 'id', job_vendor_bills: 'id',
        materials: 'id', assemblies: 'id'
      }
    }),
    {
      jsonColumns: ['data', 'capabilities', 'notification_prefs', 'tags', 'payload', 'settings',
        'annotations', 'agent_notes', 'numbers', 'notes', 'metadata'],
      dateColumns: ['updated_at', 'created_at', 'uploaded_at', 'last_seen_at', 'last_used_at', 'numbers_at']
    }
  );
  globalThis.__ENGINE__ = engine;
  globalThis.__UNMODELLED__ = [];

  jest.mock('../../server/db', () => {
    const real = globalThis.__ENGINE__.pool;
    const q = async (sql, params) => {
      if (String(sql).includes('to_jsonb')) return { rows: [], rowCount: 1 };
      try { return await real.query(sql, params); }
      catch (e) {
        globalThis.__UNMODELLED__.push(String(sql).replace(/\s+/g, ' ').trim().slice(0, 140) + '  ||  ' + e.message);
        return { rows: [], rowCount: 0 };
      }
    };
    return { pool: { query: q, connect: async () => ({ query: q, release() {} }) } };
  });
  jest.mock('../../server/storage', () => ({
    storage: { getBuffer: async () => Buffer.from(''), put: async (k) => 'https://cdn.test/' + k, delete: async () => {} }
  }));
  jest.mock('../../server/anthropic-files', () => ({
    uploadAttachmentToAnthropic: async () => null,
    eagerUploadAttachmentById: async () => {},
    deleteAnthropicFile: async () => {}
  }));
  jest.mock('../../server/routes/admin-agents-routes', () => ({
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
            // One file per listing, so the post-turn output-file harvest stops
            // after its first attempt instead of sleeping through three.
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

  const { setRolePool, refreshRoleCache, signToken } = require('../../server/auth');
  const aiRoutes = require('../../server/routes/ai-routes');
  const { aiToolCapabilityDenial } = aiRoutes.internals;
  const { pool } = require('../../server/db');
  setRolePool(pool);

  const ORGS = { A: 900000301, B: 900000302 };

  // Explicit capability sets. '*' is not expanded by the role cache, so a '*'
  // fixture would silently be a zero-capability role.
  const ROLES = {
    nocaps:    [],
    crew:      ['JOBS_VIEW_ALL', 'PROGRESS_UPDATE'],       // sees jobs, no money
    estonly:   ['ESTIMATES_VIEW'],
    leadsonly: ['LEADS_VIEW'],
    sub:       ['SUB_PORTAL_VIEW', 'SUB_PORTAL_UPLOAD'],  // the builtin sub role
    finance:   ['FINANCIALS_VIEW'],
    admin:     ['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'JOBS_DELETE', 'JOBS_GO_LIVE', 'JOBS_REASSIGN',
                'FINANCIALS_VIEW', 'PROGRESS_UPDATE', 'ESTIMATES_VIEW', 'ESTIMATES_EDIT',
                'LEADS_VIEW', 'LEADS_EDIT', 'USERS_MANAGE', 'ROLES_MANAGE', 'INSIGHTS_VIEW', 'ADMIN_METRICS']
  };
  const ROLE_NAMES = Object.keys(ROLES);
  const USERS = {};
  let uid = 400;
  for (const org of ['A', 'B']) {
    for (const r of ROLE_NAMES) {
      USERS[org + ':' + r] = {
        id: ++uid, email: r + '.' + org.toLowerCase() + '@x.test', name: r + ' ' + org,
        role: r, organization_id: ORGS[org]
      };
    }
  }

  // Salted figures: numbers no other part of the prompt can produce.
  const SALT = {
    A: { contract: 987654, margin: 41.3, co: 0, l1: [71113, 72227], l2: [81113, 82227], l3: [91113, 92227],
      e1Cost: 4321.87, e1Markup: 37, e2Cost: 6543.21, e2Markup: 29 },
    B: { contract: 555321, margin: 23.9, co: 0, l1: [61113, 62227], l2: [51113, 52227], l3: [41113, 42227],
      e1Cost: 7777.77, e1Markup: 31, e2Cost: 8888.89, e2Markup: 19 }
  };
  const money = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const ids = (org) => {
    const o = org.toLowerCase();
    return {
      lead1: 'lead-' + o + '1', lead2: 'lead-' + o + '2', lead3: 'lead-' + o + '3',
      est1: 'est-' + o + '1', est2: 'est-' + o + '2', job1: 'job-' + o + '1', cli1: 'cli-' + o + '1',
      estX: 'est-' + o + 'x'
    };
  };

  // Markers per money kind. A marker is a string only that figure prints.
  function markers(org) {
    const s = SALT[org];
    return {
      jobMoney: ['Target margin', s.margin + '%'],
      // Figures only: the stage word also appears on a withheld line.
      dealJob: ['contract $' + money(s.contract)],
      estLines: [s.e1Cost.toFixed(2), 'markup ' + s.e1Markup + '%', 'Salted Estimate ' + org + '1'],
      dealEst: ['base cost $' + money(s.e2Cost * 2)],
      leadMoney: [money(s.l1[0]), money(s.l1[1])],
      dealLead: ['est. revenue $' + money(s.l3[0])],
      lead3Money: [money(s.l3[0])],
      clientNote: ['CLIENT-NOTE-' + org],
      leadNote: ['LEAD-NOTE-' + org],
      dealNote: ['DEAL-NOTE-' + org],
      jobTitle: ['Salted Palms ' + org]
    };
  }

  function seed() {
    const db = engine.db;
    for (const t of TABLES) db.exec('DELETE FROM ' + t + ';');
    const orgIns = db.prepare('INSERT INTO organizations (id,name,slug) VALUES (?,?,?)');
    orgIns.run(ORGS.A, 'Org A Builders', 'orga');
    orgIns.run(ORGS.B, 'Org B Builders', 'orgb');
    const r = db.prepare('INSERT INTO roles (name,label,capabilities) VALUES (?,?,?)');
    for (const [name, caps] of Object.entries(ROLES)) r.run(name, name, JSON.stringify(caps));
    const u = db.prepare('INSERT INTO users (id,email,name,role,organization_id,active) VALUES (?,?,?,?,?,1)');
    for (const x of Object.values(USERS)) u.run(x.id, x.email, x.name, x.role, x.organization_id);

    const lead = db.prepare(`INSERT INTO leads (id,title,status,confidence,estimated_revenue_low,estimated_revenue_high,notes,job_id,organization_id,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    const est = db.prepare('INSERT INTO estimates (id,owner_id,organization_id,data,updated_at) VALUES (?,?,?,?,?)');
    const job = db.prepare('INSERT INTO jobs (id,owner_id,organization_id,lead_id,estimate_id,data,updated_at) VALUES (?,?,?,?,?,?,?)');
    const cli = db.prepare('INSERT INTO clients (id,name,community_manager,agent_notes,organization_id,updated_at) VALUES (?,?,?,?,?,?)');
    const dm = db.prepare('INSERT INTO deal_memory (lineage_root,root_type,organization_id,numbers,numbers_stage,notes) VALUES (?,?,?,?,?,?)');
    for (const org of ['A', 'B']) {
      const s = SALT[org]; const I = ids(org); const orgId = ORGS[org];
      const owner = USERS[org + ':admin'].id;
      const T = '2026-09-01 12:00:00';
      cli.run(I.cli1, 'Client ' + org + '1', 'CAM ' + org, JSON.stringify([{ body: 'CLIENT-NOTE-' + org }]), orgId, T);
      // job-stage lineage: lead1 -> est1 -> job1
      lead.run(I.lead1, 'Salted Lead ' + org + '1', 'won', 80, s.l1[0], s.l1[1], 'LEAD-NOTE-' + org, I.job1, orgId, T);
      est.run(I.est1, owner, orgId, JSON.stringify({
        title: 'Salted Estimate ' + org + '1', lead_id: I.lead1, client_id: I.cli1, activeAlternateId: 'alt1',
        alternates: [{ id: 'alt1', name: 'Base' }],
        lines: [{ id: 'l1', alternateId: 'alt1', description: 'Salted shingles ' + org, qty: 3, unit: 'SQ', unitCost: s.e1Cost, markup: s.e1Markup }]
      }), T);
      job.run(I.job1, owner, orgId, I.lead1, I.est1, JSON.stringify({
        jobNumber: org + '-7731', title: 'Salted Palms ' + org, client: 'Salted HOA ' + org,
        contractAmount: s.contract, targetMarginPct: s.margin, pctComplete: 12
      }), T);
      // estimate-stage lineage: lead2 -> est2
      lead.run(I.lead2, 'Salted Lead ' + org + '2', 'proposal', 60, s.l2[0], s.l2[1], null, null, orgId, T);
      est.run(I.est2, owner, orgId, JSON.stringify({
        title: 'Salted Estimate ' + org + '2', lead_id: I.lead2, activeAlternateId: 'alt1',
        alternates: [{ id: 'alt1', name: 'Base' }],
        lines: [{ id: 'l1', alternateId: 'alt1', description: 'Salted decking ' + org, qty: 2, unit: 'EA', unitCost: s.e2Cost, markup: s.e2Markup }]
      }), T);
      // lead-stage lineage: lead3 alone
      lead.run(I.lead3, 'Salted Lead ' + org + '3', 'new', 30, s.l3[0], s.l3[1], null, null, orgId, T);
      // deal notes on the job-stage lineage
      dm.run(I.lead1, 'lead', orgId, JSON.stringify({}), 'lead', JSON.stringify([{ id: 'dn1', text: 'DEAL-NOTE-' + org }]));
      // A document on lead1 — the estimate context lists a linked lead's docs.
      db.prepare(`INSERT INTO attachments (id,entity_type,entity_id,filename,mime_type,size_bytes,organization_id,position,uploaded_at)
        VALUES (?,'lead',?,?,'application/pdf',2048,?,0,'2026-09-01 12:00:00')`).run('att-' + org, I.lead1, 'LEAD-DOC-' + org + '.pdf', orgId);
      // Cost Inbox receipt, RFI and COI on the job (P3).
      db.prepare(`INSERT INTO receipts (id,organization_id,entity_type,entity_id,amount,vendor,cost_code,status,purchased_at)
        VALUES (?,?,'job',?,?,?,'materials','processed','2026-09-01')`).run('rcpt-' + org, orgId, I.job1, org === 'A' ? 4747.47 : 3636.36, 'SALTVENDOR-' + org);
      db.prepare(`INSERT INTO job_workflow_items (id,organization_id,job_id,type,number,subject,status)
        VALUES (?,?,?,'rfi','RFI-01',?,'open')`).run('wf-' + org, orgId, I.job1, 'SALTRFI-' + org);
      db.prepare(`INSERT INTO compliance_items (id,organization_id,entity_type,entity_id,type,status,title,expiration_date)
        VALUES (?,?,'sub','s1','coi','active',?,date('now','+5 day'))`).run('coi-' + org, orgId, 'SALTCOI-' + org);
    }
    // The blob vector: an org-A estimate whose blob names org B's client and
    // lead. estimates.data is writable by the tenant's own users.
    est.run(ids('A').estX, USERS['A:admin'].id, ORGS.A, JSON.stringify({
      title: 'Crossed Estimate', lead_id: ids('B').lead1, client_id: ids('B').cli1, activeAlternateId: 'alt1',
      alternates: [{ id: 'alt1', name: 'Base' }],
      lines: [{ id: 'l1', alternateId: 'alt1', description: 'Crossed line', qty: 1, unit: 'EA', unitCost: 10, markup: 10 }]
    }), '2026-09-01 12:00:00');
    // The job-column vector: an org-A job whose estimate_id column names org
    // B's estimate. (jobs.estimate_id is set by link/convert routes.)
    job.run('job-ax', USERS['A:admin'].id, ORGS.A, null, ids('B').est1, JSON.stringify({
      jobNumber: 'A-9999', title: 'Crossed Job', contractAmount: 1234, pctComplete: 1
    }), '2026-09-01 12:00:00');
    // The lead-column vector: an org-A lead whose job_id column names org B's
    // job. (leads.job_id is set by the convert / link routes.)
    lead.run('lead-ax', 'Crossed Lead', 'won', 50, 1111, 2222, null, ids('B').job1, ORGS.A, '2026-09-01 12:00:00');
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

  const { aiChatLimiter, aiChatHourlyLimiter } = require('../../server/rate-limit');
  let server, baseUrl;

  // One /86/chat turn on a surface. Returns the text of the user.message the
  // session was handed for THIS turn (exactly one, or the property proves
  // nothing).
  async function turnText(userKey, entityType, entityId) {
    const user = USERS[userKey];
    const epoch = resetWire();
    globalThis.__SCRIPT__ = [finalTurn('ok')];
    for (const l of [aiChatLimiter, aiChatHourlyLimiter]) { try { l.resetKey('u:' + user.id); } catch (_) {} }
    const marker = 'QMARK-' + epoch;
    const res = await fetch(baseUrl + '/api/ai/86/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + signToken(user) },
      body: JSON.stringify({ message: marker, current_context: entityType ? { entity_type: entityType, entity_id: entityId } : null })
    });
    const body = await res.text();
    if (res.status !== 200) throw new Error('/86/chat answered ' + res.status + ': ' + body.slice(0, 200));
    const msgs = globalThis.__SENT__.filter(e => e.__epoch === epoch && e.type === 'user.message')
      .map(e => (e.content || []).filter(b => b && b.type === 'text').map(b => b.text).join('\n'))
      .filter(t => t.includes(marker));
    if (msgs.length !== 1) throw new Error('expected ONE turn message, saw ' + msgs.length + ' — body: ' + body.slice(0, 300));
    return msgs[0].replace(marker, 'QMARK');
  }

  // EVERY turn is driven up front, in one fixed order, before any assertion
  // runs. Two reasons: a failing expect must not stop the capture (the dump is
  // compared byte-for-byte against a pristine tree, and a partial dump would
  // compare only what happened to run), and the order has to be identical on
  // both trees because deal threads persist sessions and deal_memory rows.
  const TEXT = {};
  const key = (userKey, type, id) => [userKey, type, id].join('|');
  const T = (userKey, type, id) => {
    const k = key(userKey, type, id);
    if (!(k in TEXT)) throw new Error('turn was not driven: ' + k);
    return TEXT[k];
  };
  function plan() {
    const out = [];
    for (const org of ['A', 'B']) {
      const own = ids(org), other = ids(org === 'A' ? 'B' : 'A');
      for (const r of ROLE_NAMES) {
        const u = org + ':' + r;
        out.push([u, 'job', own.job1], [u, 'estimate', own.est1], [u, 'estimate', own.est2],
          [u, 'lead', own.lead1], [u, 'lead', own.lead3], [u, 'client', null]);
        out.push([u, 'job', other.job1], [u, 'estimate', other.est1], [u, 'estimate', other.est2],
          [u, 'lead', other.lead1], [u, 'lead', other.lead3]);
      }
    }
    out.push(['A:admin', 'estimate', ids('A').estX], ['A:admin', 'job', 'job-ax'], ['A:admin', 'lead', 'lead-ax']);
    return out;
  }

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
    for (const [u, type, id] of plan()) TEXT[key(u, type, id)] = await turnText(u, type, id);
    if (process.env.MONEY_CTX_DUMP) {
      fs.writeFileSync(process.env.MONEY_CTX_DUMP, JSON.stringify(TEXT, null, 1));
    }
  });
  afterAll((done) => { server.close(() => { try { engine.close(); } catch (_) {} done(); }); });

  // Who the ONE rule admits, per money kind, executed rather than restated.
  const allowed = {
    job: (u, id) => !aiToolCapabilityDenial('read_entity', { entity_type: 'job', id, include: ['building_breakdown'] }, u),
    estimate: (u, id) => !aiToolCapabilityDenial('read_entity', { entity_type: 'estimate', id }, u),
    lead: (u, id) => !aiToolCapabilityDenial('read_entity', { entity_type: 'lead', id }, u)
  };
  const has = (text, list) => list.every(m => text.includes(m));
  const none = (text, list) => list.every(m => !text.includes(m));

  const label = dealThreads ? '[DEAL_THREADS=on]' : '[DEAL_THREADS=off]';

  describe(label + ' P0 — the fixture reaches the code under test', () => {
    test('admin in each org gets every salted figure on its own surfaces', () => {
      for (const org of ['A', 'B']) {
        const M = markers(org); const I = ids(org); const u = org + ':admin';
        const j = T(u, 'job', I.job1), e = T(u, 'estimate', I.est1), l = T(u, 'lead', I.lead1);
        expect([org, has(j, M.jobMoney), has(e, M.estLines), has(e, M.clientNote), has(e, M.leadNote),
          has(l, M.leadMoney), e.includes('LEAD-DOC-' + org)]).toEqual([org, true, true, true, true, true, true]);
        if (dealThreads) {
          expect([org, has(j, M.dealJob), has(j, M.dealNote), has(T(u, 'estimate', I.est2), M.dealEst),
            has(T(u, 'lead', I.lead3), M.dealLead), j.includes('Stage JOB')]).toEqual([org, true, true, true, true, true]);
        } else {
          expect(j).not.toContain('<deal_memory>');
        }
      }
    });
    test('the role matrix is not one-sided for any gate', () => {
      for (const k of ['job', 'estimate', 'lead']) {
        const seen = new Set(ROLE_NAMES.map(r => allowed[k](USERS['A:' + r], 'x')));
        expect([k, [...seen].sort()]).toEqual([k, [false, true]]);
      }
    });
  });

  // ── Every role, both orgs, own-org entities ────────────────────────────────
  describe(label + ' P1 — each surface follows the read rule, every role, org A and org B', () => {
    const cases = [];
    for (const org of ['A', 'B']) for (const r of ROLE_NAMES) cases.push([org, r]);
    test.each(cases)('org %s, role %s', (org, r) => {
      const uk = org + ':' + r; const u = USERS[uk]; const M = markers(org); const I = ids(org);
      const jobOk = allowed.job(u, I.job1), estOk = allowed.estimate(u, I.est1), leadOk = allowed.lead(u, I.lead1);

      // job surface
      const j = T(uk, 'job', I.job1);
      expect([r, 'job money', has(j, M.jobMoney)]).toEqual([r, 'job money', jobOk]);
      expect([r, 'job money gone', none(j, M.jobMoney)]).toEqual([r, 'job money gone', !jobOk]);
      expect(j).toContain('Salted Palms ' + org);          // identity is not money; it stays
      if (dealThreads) {
        expect([r, 'deal job', has(j, M.dealJob)]).toEqual([r, 'deal job', jobOk]);
        expect([r, 'deal job gone', none(j, M.dealJob)]).toEqual([r, 'deal job gone', !jobOk]);
        expect(j).toContain('DEAL-NOTE-' + org);            // prose notes are not money
      }
      if (!jobOk) {
        expect(j).toMatch(/FINANCIALS_VIEW/);
        expect(j).toMatch(/Do NOT state, estimate or infer/);
      }

      // estimate surface (job-stage lineage) and estimate-stage lineage
      const e = T(uk, 'estimate', I.est1);
      expect([r, 'est lines', has(e, M.estLines)]).toEqual([r, 'est lines', estOk]);
      expect([r, 'est lines gone', none(e, M.estLines)]).toEqual([r, 'est lines gone', !estOk]);
      if (!estOk) {
        expect(e).toMatch(/ESTIMATES_VIEW/);
        expect(e).toMatch(/Do NOT state, estimate or infer/);
      }
      const e2 = T(uk, 'estimate', I.est2);
      if (dealThreads) {
        // est1's lineage is at JOB stage: its deal numbers follow the job rule.
        expect([r, 'deal via est', has(e, M.dealJob)]).toEqual([r, 'deal via est', jobOk]);
        expect([r, 'deal via est gone', none(e, M.dealJob)]).toEqual([r, 'deal via est gone', !jobOk]);
        expect([r, 'deal est', has(e2, M.dealEst)]).toEqual([r, 'deal est', estOk]);
        expect([r, 'deal est gone', none(e2, M.dealEst)]).toEqual([r, 'deal est gone', !estOk]);
      }

      // lead surface
      const l = T(uk, 'lead', I.lead1);
      expect([r, 'lead money', has(l, M.leadMoney)]).toEqual([r, 'lead money', leadOk]);
      expect([r, 'lead money gone', none(l, M.leadMoney)]).toEqual([r, 'lead money gone', !leadOk]);
      if (!leadOk) expect(l).toMatch(/LEADS_VIEW/);
      const l3 = T(uk, 'lead', I.lead3);
      expect([r, 'lead3 money gone', none(l3, M.lead3Money)]).toEqual([r, 'lead3 money gone', !leadOk]);
      if (dealThreads) {
        expect([r, 'deal via lead', has(l, M.dealJob)]).toEqual([r, 'deal via lead', jobOk]);
        expect([r, 'deal lead', has(l3, M.dealLead)]).toEqual([r, 'deal lead', leadOk]);
      }

      // client surface carries no money; it stays tenant-scoped
      const c = T(uk, 'client', null);
      expect(c).toContain('CLIENT-NOTE-' + org);
      expect(c).not.toContain('CLIENT-NOTE-' + (org === 'A' ? 'B' : 'A'));
    });
  });

  // ── Across tenants: no role, not even admin, sees the other org ────────────
  describe(label + ' P2 — no caller reads another tenant through the turn context', () => {
    const cases = [];
    for (const org of ['A', 'B']) for (const r of ROLE_NAMES) cases.push([org, r]);
    test.each(cases)('org %s, role %s names the OTHER org\'s entities', (org, r) => {
      const other = org === 'A' ? 'B' : 'A';
      const M = markers(other); const I = ids(other);
      const everyMarker = [].concat(M.jobMoney, M.dealJob, M.estLines, M.dealEst, M.leadMoney, M.dealLead,
        M.clientNote, M.leadNote, M.dealNote, M.jobTitle, M.lead3Money);
      for (const [type, id] of [['job', I.job1], ['estimate', I.est1], ['estimate', I.est2], ['lead', I.lead1], ['lead', I.lead3]]) {
        const t = T(org + ':' + r, type, id);
        for (const m of everyMarker) expect([r, type, id, m, t.includes(m)]).toEqual([r, type, id, m, false]);
        expect(t).not.toContain('<deal_memory>');
      }
    });

    test('no user holds a deal thread keyed on another tenant\'s lineage', () => {
      const rows = engine.all("SELECT s.user_id, s.lineage_root FROM ai_sessions s WHERE s.session_kind = 'deal_thread'");
      if (dealThreads) expect(rows.length).toBeGreaterThan(0);        // threads were minted at all
      for (const r of rows) {
        const u = Object.values(USERS).find(x => x.id === Number(r.user_id));
        const other = u.organization_id === ORGS.A ? 'b' : 'a';
        expect([u.email, r.lineage_root, new RegExp('-' + other + '\\d').test(String(r.lineage_root))])
          .toEqual([u.email, r.lineage_root, false]);
      }
    });

    test('an org-A estimate whose BLOB names org B\'s client and lead hands org A nothing of org B', () => {
      const M = markers('B');
      const t = T('A:admin', 'estimate', ids('A').estX);
      expect(t).toContain('Crossed Estimate');       // the estimate itself is org A's and renders
      // ids('B').lead1 too: a deal rooted on another tenant's lead id would key
      // this org's deal notes to that tenant's lineage even with no figure shown.
      for (const m of [].concat(M.clientNote, M.leadNote, M.leadMoney, M.dealJob, M.dealNote, ['Client B1', 'LEAD-DOC-B', ids('B').lead1])) {
        expect([m, t.includes(m)]).toEqual([m, false]);
      }
    });

    test('an org-A job whose estimate_id COLUMN names org B\'s estimate roots no deal on it', () => {
      const t = T('A:admin', 'job', 'job-ax');
      const M = markers('B');
      expect(t).toContain('Crossed Job');
      for (const m of [].concat(M.estLines, M.dealEst, M.dealJob, M.dealNote, [ids('B').est1])) {
        expect([m, t.includes(m)]).toEqual([m, false]);
      }
      if (dealThreads) expect(t).toContain('contract $1,234');   // its own deal still renders
    });

    test('an org-A lead whose job_id COLUMN names org B\'s job walks no deal into it', () => {
      const t = T('A:admin', 'lead', 'lead-ax');
      const M = markers('B');
      expect(t).toContain('Crossed Lead');
      for (const m of [].concat(M.dealJob, M.dealNote, M.jobMoney, M.jobTitle, [ids('B').job1])) {
        expect([m, t.includes(m)]).toEqual([m, false]);
      }
      // Its own lead-stage deal still renders, from its own row.
      if (dealThreads) expect(t).toContain('est. revenue $1,111');
    });
  });

  // ── Fail closed: no user, no org ──────────────────────────────────────────
  describe(label + ' P4 — a missing caller or a missing tenant gets nothing, never everything', () => {
    const dealMemory = require('../../server/services/deal-memory');
    const { buildTurnContext } = aiRoutes.internals;
    const orgA = { id: ORGS.A, name: 'Org A Builders', slug: 'orga' };
    test('buildTurnContext with no gateUser attaches no estimate lines, job margin or lead revenue', async () => {
      const M = markers('A'); const I = ids('A');
      const e = await buildTurnContext({ entityType: 'estimate', entityId: I.est1, aiPhase: 'edit', organization: orgA });
      const j = await buildTurnContext({ entityType: 'job', entityId: I.job1, aiPhase: 'edit', organization: orgA });
      const l = await buildTurnContext({ entityType: 'lead', entityId: I.lead1, aiPhase: 'edit', organization: orgA });
      expect(none(e.turnContextText, M.estLines)).toBe(true);
      expect(e.turnContextText).toMatch(/ESTIMATES_VIEW/);
      expect(none(j.turnContextText, M.jobMoney)).toBe(true);
      expect(j.turnContextText).toContain('Salted Palms A');
      expect(none(l.turnContextText, M.leadMoney)).toBe(true);
      // ...and the same call WITH an allowed user does carry them (not vacuous).
      const e2 = await buildTurnContext({ entityType: 'estimate', entityId: I.est1, aiPhase: 'edit', organization: orgA, gateUser: USERS['A:admin'] });
      expect(has(e2.turnContextText, M.estLines)).toBe(true);
    });
    test('resolveLineageRoot / refreshDealNumbers resolve nothing without a tenant, and nothing across one', async () => {
      const I = ids('A');
      expect(await dealMemory.resolveLineageRoot(pool, 'job', I.job1, null)).toBeNull();
      expect(await dealMemory.resolveLineageRoot(pool, 'job', I.job1, undefined)).toBeNull();
      expect(await dealMemory.refreshDealNumbers(pool, 'job', I.job1, null)).toBeNull();
      expect(await dealMemory.resolveLineageRoot(pool, 'job', I.job1, ORGS.B)).toBeNull();
      const own = await dealMemory.resolveLineageRoot(pool, 'job', I.job1, ORGS.A);
      expect(own && own.lineage_root).toBe(I.lead1);
      const nums = await dealMemory.computeNumbers(pool, own, null);
      expect(nums).toEqual({ stage: 'job' });
      // An UN-STAMPED legacy row matches the tolerance arm for any org — so
      // without the explicit null check a caller with no org would resolve it.
      engine.db.prepare("INSERT INTO jobs (id,owner_id,organization_id,data) VALUES ('job-legacy',1,NULL,?)")
        .run(JSON.stringify({ title: 'Legacy', contractAmount: 5 }));
      try {
        expect(await dealMemory.resolveLineageRoot(pool, 'job', 'job-legacy', null)).toBeNull();
        const legacy = await dealMemory.resolveLineageRoot(pool, 'job', 'job-legacy', ORGS.A);
        expect(legacy && legacy.lineage_root).toBe('job-legacy');   // the arm itself still tolerates it
      } finally {
        engine.db.exec("DELETE FROM jobs WHERE id = 'job-legacy'");
      }
    });
    test('a deal_memory row stamped for ANOTHER org under an in-org key is neither shown nor overwritten', async () => {
      // Runs after every captured turn; the row it plants is removed again, and a
      // later refresh re-seeds lead3's own row.
      const I = ids('A');
      engine.db.exec("DELETE FROM deal_memory WHERE lineage_root = '" + I.lead3 + "'");
      engine.db.prepare('INSERT INTO deal_memory (lineage_root,root_type,organization_id,numbers,numbers_stage,notes) VALUES (?,?,?,?,?,?)')
        .run(I.lead3, 'lead', ORGS.B, JSON.stringify({ stage: 'lead', marker: 'FOREIGN-NUMBERS' }), 'lead',
          JSON.stringify([{ id: 'fx', text: 'FOREIGN-NOTE' }]));
      try {
        const dm = await dealMemory.refreshDealNumbers(pool, 'lead', I.lead3, ORGS.A);
        expect(dealMemory.renderDealBlock(dm)).not.toContain('FOREIGN-NOTE');
        const row = engine.all("SELECT numbers FROM deal_memory WHERE lineage_root = ?", I.lead3)[0];
        expect(JSON.stringify(row.numbers)).toContain('FOREIGN-NUMBERS');     // not overwritten
      } finally {
        engine.db.exec("DELETE FROM deal_memory WHERE lineage_root = '" + I.lead3 + "'");
      }
    });
    test('renderDealBlock with numbersWithheld prints no figure and says why', async () => {
      const dm = await dealMemory.refreshDealNumbers(pool, 'job', ids('A').job1, ORGS.A);
      const open = dealMemory.renderDealBlock(dm);
      const shut = dealMemory.renderDealBlock(dm, { numbersWithheld: 'Permission denied: FINANCIALS_VIEW' });
      expect(open).toContain('contract $987,654');
      expect(shut).not.toContain('987,654');
      expect(shut).toContain('Do NOT state, estimate or infer');
      expect(shut).toContain('DEAL-NOTE-A');
    });
  });

  // ── (C) Cost Inbox, RFIs, COIs — through escalate_to_86 and direct ─────────
  // On 8f5b2b31 a zero-capability caller got the Cost Inbox's dollar totals
  // and vendor names and every RFI on a job, both through escalate_to_86 (the
  // escalation's 86 dispatches through the same gate) and directly. The floor
  // refuses a caller holding no internal view capability; every other role is
  // served as before, and never across tenants.
  describe(label + ' P3 — receipts, RFIs and COIs follow the tool gate, through escalation and direct', () => {
    const toolTurn = (id, name, input) => ([
      { type: 'agent.custom_tool_use', id, tool_name: name, input },
      { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: [id] } }
    ]);
    const RES = {};
    async function drive(userKey, viaEscalation) {
      const user = USERS[userKey];
      const epoch = resetWire();
      const I = ids(user.organization_id === ORGS.A ? 'A' : 'B');
      const reads = [
        toolTurn('t_r', 'read_receipts', { limit: 10 }),
        toolTurn('t_w', 'list_workflow_items', { job_id: I.job1 }),
        toolTurn('t_c', 'list_compliance_expiring', {})
      ];
      globalThis.__SCRIPT__ = viaEscalation
        ? [toolTurn('t_e', 'escalate_to_86', { question: 'What is in the cost inbox, RFIs and COIs?' })].concat(reads, [finalTurn('inner'), finalTurn('outer')])
        : reads.concat([finalTurn('outer')]);
      for (const l of [aiChatLimiter, aiChatHourlyLimiter]) { try { l.resetKey('u:' + user.id); } catch (_) {} }
      const res = await fetch(baseUrl + '/api/ai/86/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + signToken(user) },
        body: JSON.stringify({ message: 'cost inbox?' })
      });
      await res.text();
      const out = {};
      for (const e of globalThis.__SENT__.filter(x => x.__epoch === epoch && x.type === 'user.custom_tool_result')) {
        out[e.custom_tool_use_id] = (e.content || []).map(b => (b && b.text) || '').join('\n');
      }
      return out;
    }
    beforeAll(async () => {
      for (const org of ['A', 'B']) for (const r of ROLE_NAMES) {
        RES[org + ':' + r + ':esc'] = await drive(org + ':' + r, true);
        RES[org + ':' + r + ':direct'] = await drive(org + ':' + r, false);
      }
    });
    const cases = [];
    for (const org of ['A', 'B']) for (const r of ROLE_NAMES) for (const via of ['esc', 'direct']) cases.push([org, r, via]);
    test.each(cases)('org %s, role %s, %s', (org, r, via) => {
      const out = RES[org + ':' + r + ':' + via];
      const other = org === 'A' ? 'B' : 'A';
      // The escalation really ran: its inner reads answered, and the outer
      // escalate_to_86 got the inner answer back.
      if (via === 'esc') expect(out.t_e).toBe('inner');
      for (const id of ['t_r', 't_w', 't_c']) expect([r, via, id, typeof out[id]]).toEqual([r, via, id, 'string']);
      const floor = ['ESTIMATES_VIEW', 'JOBS_VIEW_ALL', 'JOBS_VIEW_ASSIGNED', 'FINANCIALS_VIEW', 'LEADS_VIEW'];
      const ok = floor.some(c => ROLES[r].includes(c));
      expect([r, via, 'receipts', out.t_r.includes('SALTVENDOR-' + org)]).toEqual([r, via, 'receipts', ok]);
      expect([r, via, 'rfi', out.t_w.includes('SALTRFI-' + org)]).toEqual([r, via, 'rfi', ok]);
      expect([r, via, 'coi refused', /Permission denied/.test(out.t_c)]).toEqual([r, via, 'coi refused', !ok]);
      if (!ok) for (const id of ['t_r', 't_w', 't_c']) expect(out[id]).toMatch(/Permission denied/);
      for (const id of ['t_r', 't_w', 't_c']) {
        expect(out[id]).not.toContain('SALTVENDOR-' + other);
        expect(out[id]).not.toContain('SALTRFI-' + other);
      }
    });
    test('the floor is not one-sided: some roles are served, some refused', () => {
      const served = ROLE_NAMES.filter(r => RES['A:' + r + ':direct'].t_r.includes('SALTVENDOR-A'));
      expect(served.length).toBeGreaterThan(0);
      expect(served.length).toBeLessThan(ROLE_NAMES.length);
    });
  });

  // ── A deal thread minted BEFORE the fix, on another tenant's lineage ───────
  // Production has run DEAL_THREADS=on with the unscoped lineage walk, so a row
  // like the one planted here can already exist: user in org A, session_kind
  // deal_thread, lineage_root = org B's lead. On origin/main the resolver finds
  // it by that lineage_root and resumes it, and the turn re-renders org B's
  // <deal_memory>. The scoped walk resolves nothing for org B's id, so the
  // thread is never selected and nothing of org B reaches the turn.
  describe(label + ' P5 — a pre-existing deal thread on another tenant\'s lineage is never resumed', () => {
    const FOREIGN_SID = 'sess_foreign_deal_thread';
    const FOREIGN_ROW = 990001;
    let turn = null;
    let history = null;
    beforeAll(async () => {
      const u = USERS['A:admin']; const B = ids('B');
      engine.db.prepare(`INSERT INTO ai_sessions (id, agent_key, entity_type, entity_id, user_id, anthropic_session_id,
          anthropic_agent_id, session_kind, lineage_root, turn_count, created_at, last_used_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(FOREIGN_ROW, 'job', 'job', B.job1, u.id, FOREIGN_SID, 'agent_test', 'deal_thread', B.lead1, 3,
          '2026-09-01 12:00:00', '2099-01-01 00:00:00');
      engine.db.prepare(`INSERT INTO ai_messages (id, entity_type, estimate_id, user_id, role, content, session_id, organization_id, created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run('aim_foreign_1', 'job', B.job1, u.id, 'assistant', 'FOREIGN-THREAD-HISTORY', FOREIGN_ROW, ORGS.A, '2026-09-01 12:00:01');
      const epoch = resetWire();
      globalThis.__SCRIPT__ = [finalTurn('ok')];
      for (const l of [aiChatLimiter, aiChatHourlyLimiter]) { try { l.resetKey('u:' + u.id); } catch (_) {} }
      const marker = 'QMARK-P5-' + epoch;
      const res = await fetch(baseUrl + '/api/ai/86/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + signToken(u) },
        // The chat client always sends the thread it is showing; send the
        // foreign one, the strongest way a caller can ask to resume it.
        body: JSON.stringify({ message: marker, session_id: FOREIGN_ROW, current_context: { entity_type: 'job', entity_id: B.job1 } })
      });
      await res.text();
      const sent = globalThis.__SENT__.filter(e => e.__epoch === epoch && e.type === 'user.message');
      turn = {
        status: res.status,
        sessions: sent.map(e => e.__session),
        text: sent.map(e => (e.content || []).filter(b => b && b.type === 'text').map(b => b.text).join('\n')).join('\n')
      };
      const h = await fetch(baseUrl + '/api/ai/86/messages?entity_type=job&entity_id=' + encodeURIComponent(B.job1), {
        headers: { Authorization: 'Bearer ' + signToken(u) }
      });
      history = { status: h.status, body: await h.text() };
    });
    test('the turn is driven (not vacuous) and is NOT sent to the foreign deal thread', () => {
      expect(turn.status).toBe(200);
      expect(turn.sessions.length).toBe(1);
      expect(turn.text).toContain('QMARK-P5-');
      expect(turn.sessions).not.toContain(FOREIGN_SID);
    });
    test('nothing of org B reaches the turn: no deal block, no figure, no note', () => {
      const M = markers('B');
      expect(turn.text).not.toContain('<deal_memory>');
      for (const m of [].concat(M.dealJob, M.dealNote, M.jobMoney, M.jobTitle)) {
        expect([m, turn.text.includes(m)]).toEqual([m, false]);
      }
    });
    test('GET /86/messages on org B\'s job does not resolve to the foreign thread', () => {
      expect(history.status).toBe(200);
      expect(history.body).not.toContain('FOREIGN-THREAD-HISTORY');
      expect(history.body).not.toContain('"deal_thread_id"');
    });
  });

  return { T, USERS, ids, markers, allowed, engine };
};
