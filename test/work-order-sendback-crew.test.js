// SENT BACK, ON THE CREW LINK (1.29, B3 read side).
//
// ── WHAT THIS FILE PINS ───────────────────────────────────────────────────
// When the office sends a work order back for more work, the crew link shows
// the reason and the buildings to redo until the work arrives at Work complete
// again. GET /api/service-ticket-share/:token carries it as top-level
// `send_back`: { note, at, buildings: [{ id, title, note, reopened }] } or null.
//
//   * It is DERIVED from the newest status_changed event that is a send-back or
//     an arrival at work_complete (services/work-order-review.js
//     activeSendBack), so nothing has to remember to clear it.
//   * Buildings are the ticket's CURRENT live org tasks, with their current
//     titles; a building no longer on the punch list drops out.
//   * It carries the office's reason and nothing else about the office: no
//     user id or name, no approved_by / cancelled_by, no internal notes, and
//     never a cancel reason (a cancel is not a send-back).
//   * Every link scope sees it, a view link included.
//   * Best-effort: a failed lookup costs the banner, never the work order.
//
// ── HOW ───────────────────────────────────────────────────────────────────
// The REAL router over node:sqlite through the pg shim, tables from
// sqliteSchema, events seeded with explicit times (the shim has no
// created_at default). One guard is removed from a copy of the shipped file
// and shown to go red.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const SHARE_ROUTES = path.join(__dirname, '..', 'server', 'routes', 'service-ticket-share-routes.js');
const TABLES = [
  'organizations', 'users', 'jobs', 'leads', 'tasks', 'attachments',
  'service_tickets', 'service_ticket_events', 'service_ticket_shares',
];

const SEND_BACK_NOTE = 'Rail post loose on 784. Re-photo tread 3.';

let eng;
let db;
let svc;
let shareRouter;
let respondToken;
let viewToken;
let failEvents = false;

function statusEvent(id, org, at, actorKind, detail) {
  return `('${id}', ${org}, 'st_1', 'status_changed', '${actorKind}', ${actorKind === 'user' ? 10 : 'NULL'}, ${actorKind === 'share' ? "'sh_respond'" : 'NULL'}, '${JSON.stringify(detail).replace(/'/g, "''")}', '${at}')`;
}

function seed(status) {
  respondToken = svc.genToken();
  viewToken = svc.genToken();
  const exp = new Date(Date.now() + 86400000).toISOString();
  eng.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM jobs; DELETE FROM tasks; DELETE FROM attachments;
    DELETE FROM service_tickets; DELETE FROM service_ticket_events; DELETE FROM service_ticket_shares;

    INSERT INTO organizations (id, name, timezone) VALUES (1, 'AGX', 'America/New_York'), (2, 'Rival Co', 'America/New_York');
    INSERT INTO users (id, name, email, organization_id) VALUES (10, 'Wendy PM', 'w@agx.test', 1);
    INSERT INTO jobs (id, owner_id, data, organization_id) VALUES ('j1', 10, '{}', 1);
    INSERT INTO service_tickets (id, organization_id, title, job_id, status, checklist, internal_notes,
        approved_by, approved_at, cancelled_by, cancelled_at, created_by, approval_notice_attempts, created_at) VALUES
      ('st_1', 1, 'Latitude 28 rails', 'j1', '${status || 'in_progress'}', '[]', 'INTERNAL: margin is thin',
        10, '2026-09-12 10:00:00', 10, '2026-09-10 10:00:00', 10, 0, '2026-09-01 10:00:00');
    INSERT INTO tasks (id, organization_id, title, status, scope, service_ticket_id, entity_type, entity_id, archived_at, created_at) VALUES
      ('k784', 1, 'Bldg 784 — Side A', 'open', 'org', 'st_1', 'job', 'j1', NULL, '2026-09-02 08:00:01'),
      ('k790', 1, 'Bldg 790', 'done', 'org', 'st_1', 'job', 'j1', NULL, '2026-09-02 08:00:02'),
      ('k_archived', 1, 'Bldg 999', 'open', 'org', 'st_1', 'job', 'j1', '2026-09-14 08:00:00', '2026-09-02 08:00:03');
    INSERT INTO service_ticket_shares (id, organization_id, ticket_id, token_hash, scope, hide_financials, recipient_name, expires_at, created_by, view_count, opened_at, created_at) VALUES
      ('sh_respond', 1, 'st_1', '${svc.hashToken(respondToken)}', 'respond', 1, 'Marco', '${exp}', 10, 0, '2026-09-02 09:00:00', '2026-09-02 09:00:00'),
      ('sh_view', 1, 'st_1', '${svc.hashToken(viewToken)}', 'view', 1, 'Inspector', '${exp}', 10, 0, '2026-09-02 09:00:00', '2026-09-02 09:00:00');
    INSERT INTO service_ticket_events (id, organization_id, ticket_id, kind, actor_kind, actor_user_id, share_id, detail, created_at) VALUES
      ${statusEvent('ev_cancel', 1, '2026-09-10 10:00:00', 'user', { from: 'open', to: 'cancelled', action: 'cancel', note: 'CANCEL REASON: the client pays late' })},
      ${statusEvent('ev_reopen', 1, '2026-09-11 10:00:00', 'user', { from: 'cancelled', to: 'open', action: 'reopen', note: 'They paid' })},
      ${statusEvent('ev_arrive', 1, '2026-09-14 10:00:00', 'share', { from: 'in_progress', to: 'work_complete', reason: 'all_subtasks_done' })},
      ${statusEvent('ev_send_back', 1, '2026-09-15 09:00:00', 'user', {
        from: 'work_complete', to: 'in_progress', action: 'send_back', note: SEND_BACK_NOTE,
        buildings: [
          { task_id: 'k784', title: 'Bldg 784 (as it was titled then)', note: 'Post still loose', reopened: true },
          { task_id: 'k_archived', title: 'Bldg 999', note: 'gone since', reopened: true },
          { task_id: 'k_nowhere', title: 'Bldg 000', note: null, reopened: true },
          { task_id: 'k790', title: 'Bldg 790', note: null, reopened: false },
        ],
      })},
      ${statusEvent('ev_rival', 2, '2026-09-15 20:00:00', 'user', { from: 'work_complete', to: 'in_progress', action: 'send_back', note: 'RIVAL TENANT NOTE' })};
  `);
}

beforeAll(async () => {
  eng = createPgSqlite(sqliteSchema(TABLES), { jsonColumns: ['checklist', 'detail', 'data', 'tags'] });
  db = require('../server/db');
  db.pool.query = async (sql, params) => {
    if (failEvents && /detail->>'action' = 'send_back'/.test(String(sql))) throw new Error('planted: events unavailable');
    return eng.pool.query(sql, params);
  };
  db.pool.connect = eng.pool.connect;
  svc = require('../server/services/service-tickets');
  shareRouter = require('../server/routes/service-ticket-share-routes');
});

const flush = () => new Promise((r) => setTimeout(r, 25));
let mutantPaths = [];
beforeEach(() => { failEvents = false; seed(); });
afterEach(async () => {
  await flush();
  for (const p of mutantPaths) {
    try { delete require.cache[require.resolve(p)]; } catch (e) { /* never loaded */ }
    try { fs.unlinkSync(p); } catch (e) { /* already gone */ }
  }
  mutantPaths = [];
});
afterAll(async () => {
  await flush();
  db.pool.query = async () => ({ rows: [], rowCount: 0 });
  if (eng) eng.close();
});

function fakeRes() {
  const res = { statusCode: 200, body: undefined, headersSent: false };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.body = p; res.headersSent = true; return res; };
  res.set = () => res;
  return res;
}

async function read(router, tok) {
  const layer = (router || shareRouter).stack.find((l) => l.route && l.route.path === '/service-ticket-share/:token' && l.route.methods.get);
  let chain = layer.route.stack.map((s) => s.handle);
  const at = chain.findIndex((h) => h.name === 'loadTicketShare');
  if (at < 0) throw new Error('no loadTicketShare');
  chain = chain.slice(at);
  const res = fakeRes();
  const req = { method: 'GET', params: { token: tok || respondToken }, query: {}, body: {}, headers: {}, protocol: 'https', get: () => 'project86.test' };
  for (const h of chain) {
    let advanced = false;
    await h(req, res, (err) => { if (err) throw err; advanced = true; });
    if (!advanced) break;
  }
  return res;
}

function mutant(pairs) {
  let out = fs.readFileSync(SHARE_ROUTES, 'utf8').replace(/\r\n/g, '\n');
  for (const [find, replace] of pairs) {
    const hits = out.split(find).length - 1;
    if (hits !== 1) throw new Error('anchor not found' + (hits > 1 ? ' (ambiguous: ' + hits + ')' : '') + ': ' + JSON.stringify(find.slice(0, 120)));
    out = out.split(find).join(replace);
  }
  const dir = path.dirname(SHARE_ROUTES);
  out = out.replace(/require\((['"])([^'"]+)\1\)/g, (_m, _q, spec) => {
    const resolved = spec.charAt(0) === '.'
      ? require.resolve(path.resolve(dir, spec))
      : require.resolve(spec, { paths: [dir] });
    return 'require(' + JSON.stringify(resolved.split(path.sep).join('/')) + ')';
  });
  const p = path.join(os.tmpdir(), '_p86_sendback_mutant_' + process.pid + '_' + Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, out, 'utf8');
  mutantPaths.push(p);
  return require(p);
}

describe('the crew link shows what the office sent back', () => {
  test('send_back carries the reason, when, and the buildings still on the punch list with their current titles', async () => {
    const res = await read();
    expect(res.statusCode).toBe(200);
    const sb = res.body.send_back;
    expect(Object.keys(sb).sort()).toEqual(['at', 'buildings', 'note']);
    expect(sb.note).toBe(SEND_BACK_NOTE);
    expect(String(sb.at)).toMatch(/^2026-09-15/);
    expect(sb.buildings).toEqual([
      { id: 'k784', title: 'Bldg 784 — Side A', note: 'Post still loose', reopened: true },
      { id: 'k790', title: 'Bldg 790', note: null, reopened: false },
    ]);
  });

  test('nothing else about the office rides along: no approver, no canceller, no internal notes, no cancel reason, no other tenant', async () => {
    const res = await read();
    const whole = JSON.stringify(res.body);
    for (const leak of ['approved_by', 'cancelled_by', 'approved_at', 'cancelled_at', 'internal_notes',
      'INTERNAL: margin', 'CANCEL REASON', 'RIVAL TENANT NOTE', 'actor_user_id', 'They paid']) {
      expect(whole).not.toContain(leak);
    }
    expect(Object.keys(res.body.ticket)).not.toEqual(expect.arrayContaining(['approved_by']));
  });

  test('a view link sees the same banner', async () => {
    const view = await read(null, viewToken);
    const respond = await read();
    expect(view.statusCode).toBe(200);
    expect(view.body.send_back).toEqual(respond.body.send_back);
  });

  test('once the work arrives at Work complete again the banner is gone — and stays gone after a crew undo', async () => {
    eng.db.exec(`INSERT INTO service_ticket_events (id, organization_id, ticket_id, kind, actor_kind, actor_user_id, share_id, detail, created_at) VALUES
      ${statusEvent('ev_arrive_2', 1, '2026-09-15 12:00:00', 'share', { from: 'in_progress', to: 'work_complete', reason: 'marked_complete' })}`);
    eng.db.exec("UPDATE service_tickets SET status = 'work_complete' WHERE id = 'st_1'");
    expect((await read()).body.send_back).toBeNull();
    eng.db.exec(`INSERT INTO service_ticket_events (id, organization_id, ticket_id, kind, actor_kind, actor_user_id, share_id, detail, created_at) VALUES
      ${statusEvent('ev_undo', 1, '2026-09-15 12:30:00', 'share', { from: 'work_complete', to: 'in_progress', reason: 'crew_undid_finish' })}`);
    eng.db.exec("UPDATE service_tickets SET status = 'in_progress' WHERE id = 'st_1'");
    const res = await read();
    expect(res.statusCode).toBe(200);
    expect(res.body.send_back).toBeNull();
  });

  test('approved, closed or cancelled: no banner', async () => {
    for (const status of ['approved', 'closed', 'cancelled', 'work_complete']) {
      seed(status);
      const res = await read();
      expect([status, res.statusCode, res.body.send_back]).toEqual([status, 200, null]);
    }
  });

  test('a failed lookup costs the banner, never the work order', async () => {
    failEvents = true;
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await read();
    err.mockRestore();
    expect(res.statusCode).toBe(200);
    expect(res.body.send_back).toBeNull();
    expect(res.body.tasks.map((t) => t.id)).toEqual(['k784', 'k790']);
  });

  test('MUTANT: read the banner without the best-effort wrapper and a failed lookup takes down the whole crew read', async () => {
    const mut = mutant([[
      "        bestEffort('send-back banner', () => review.activeSendBack(pool, ticket, tasks.rows), null),",
      '        review.activeSendBack(pool, ticket, tasks.rows),',
    ]]);
    failEvents = true;
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await read(mut);
    err.mockRestore();
    expect(res.statusCode).toBe(500);
  });
});
