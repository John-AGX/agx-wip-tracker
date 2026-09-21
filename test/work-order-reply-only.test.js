// REPLY ONLY — A WORK ORDER LINE FINISHED WITHOUT A COMPLETION PHOTO (1.50).
//
// John, 2026-09-21, on the Fairways work order: "is there a way to have a
// subtask that doesnt need a completion photo? some of these are more
// informational that would only really just need a reply". A line whose work
// is a call, an email or a confirmation has nothing to photograph, and the
// photo rule made it impossible to tick. Such a line is kind 'follow_up' — the
// task kind that already existed — and services/service-tickets.js
// subtaskNeedsPhoto is the one place that says what that means.
//
// THIS FILE: the rule itself, and the crew link — its done door, and the
// reply_only flag its read hands the page. The other doors are pinned beside
// the tests they belong with:
//   * the office's PATCH /api/tasks/:id     work-order-task-doors.test.js
//   * the photo guard's rule (c)            work-order-photo-guard.test.js
//   * the crew page's chip and done button  crew-finish-work-order.test.js
//   * the office card, switch and add box   work-order-reply-only-ui.test.js
//   * the Scribe's task_adds kind           service-ticket-payload.test.js
//
// HOW: the REAL share router against node:sqlite through the pg shim, tables
// from sqliteSchema — the harness of work-order-i2-crew-wiring.test.js. Then
// each piece is removed from a copy of the shipped file (CRLF normalised, the
// anchor required exactly once) and the same drive shows what it is for.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

jest.mock('../server/storage', () => ({
  storage: {
    put: async (key) => 'https://cdn.test/' + key,
    delete: async () => {},
  },
}));

const SERVER = path.join(__dirname, '..', 'server');
const SHARE_ROUTES = path.join(SERVER, 'routes', 'service-ticket-share-routes.js');
const WORKORDER = path.join(SERVER, 'services', 'service-ticket-workorder.js');
const TICKETS = path.join(SERVER, 'services', 'service-tickets.js');

const TABLES = [
  'organizations', 'users', 'jobs', 'leads', 'tasks', 'attachments',
  'service_tickets', 'service_ticket_events', 'service_ticket_shares', 'service_ticket_revisions', 'service_ticket_flags',
];
const PHOTO_REFUSAL = 'Add a completion photo before marking this complete.';

let eng;
let db;
let svc;
let notify;
let shareRouter;
let realNotify;
let token;
let calls;

function seed() {
  token = svc.genToken();
  const exp = new Date(Date.now() + 86400000).toISOString();
  eng.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM jobs; DELETE FROM tasks; DELETE FROM attachments;
    DELETE FROM service_tickets; DELETE FROM service_ticket_events; DELETE FROM service_ticket_shares;
    DELETE FROM service_ticket_revisions; DELETE FROM service_ticket_flags;

    INSERT INTO organizations (id, name, timezone) VALUES (1, 'AGX', 'America/New_York');
    INSERT INTO users (id, name, email, organization_id) VALUES (10, 'Wendy PM', 'w@agx.test', 1);
    INSERT INTO jobs (id, owner_id, data, organization_id) VALUES ('j1', 10, '{}', 1);
    INSERT INTO service_tickets (id, organization_id, title, job_id, status, checklist, guest_log, created_by, approval_notice_attempts, created_at) VALUES
      ('st_1', 1, 'Fairways punch list', 'j1', 'in_progress', '[]', NULL, 10, 0, '2026-09-01 10:00:00');
    INSERT INTO service_ticket_shares (id, organization_id, ticket_id, token_hash, scope, hide_financials, recipient_name, expires_at, created_by, view_count, opened_at, last_used_at, created_at) VALUES
      ('sh1', 1, 'st_1', '${svc.hashToken(token)}', 'respond', 1, NULL, '${exp}', 10, 0, '2026-09-02 09:00:00', NULL, '2026-09-02 09:00:00');

    -- f1 is field work with its photo; r1 is a reply (a call to the owner) with
    -- none; t1 is field work with none. Nothing is done yet.
    INSERT INTO tasks (id, organization_id, title, status, kind, scope, service_ticket_id, entity_type, entity_id, archived_at, created_at) VALUES
      ('f1', 1, '4213 Fairway Run — slats',            'open', 'todo',      'org', 'st_1', 'job', 'j1', NULL, '2026-09-02 08:00:01'),
      ('r1', 1, 'Reply to the owner confirming items', 'open', 'follow_up', 'org', 'st_1', 'job', 'j1', NULL, '2026-09-02 08:00:02'),
      ('t1', 1, '4208 Fairway Run — leak',             'open', 'todo',      'org', 'st_1', 'job', 'j1', NULL, '2026-09-02 08:00:03');
    INSERT INTO attachments (id, entity_type, entity_id, organization_id, folder, filename, mime_type, tags, position, uploaded_at) VALUES
      ('att_f1', 'task', 'f1', 1, 'general', 'f1.jpg', 'image/jpeg', '["completion"]', 0, '2026-09-02 08:30:00');
  `);
}

beforeAll(async () => {
  eng = createPgSqlite(sqliteSchema(TABLES), {
    jsonColumns: ['checklist', 'detail', 'data', 'tags', 'fields'],
  });
  db = require('../server/db');
  db.pool.query = eng.pool.query;
  db.pool.connect = eng.pool.connect;
  svc = require('../server/services/service-tickets');
  notify = require('../server/services/service-ticket-notify');
  shareRouter = require('../server/routes/service-ticket-share-routes');
});

const flush = () => new Promise((r) => setTimeout(r, 25));

let mutantPaths = [];
beforeEach(() => {
  calls = [];
  seed();
  realNotify = notify.notifyAwaitingApproval;
  notify.notifyAwaitingApproval = async (pool, opts) => { calls.push(opts); return { sent: 0 }; };
});
afterEach(async () => {
  await flush();
  notify.notifyAwaitingApproval = realNotify;
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

// ── the drive: the whole chain from loadTicketShare on ─────────────────────
function fakeRes() {
  const res = { statusCode: 200, body: undefined, headersSent: false };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.body = p; res.headersSent = true; return res; };
  res.set = () => res;
  res.setHeader = () => res;
  return res;
}

async function drive(router, method, routePath, opts) {
  const o = opts || {};
  const layer = (router || shareRouter).stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error('route not declared: ' + method + ' ' + routePath);
  let chain = layer.route.stack.map((s) => s.handle);
  const at = chain.findIndex((h) => h.name === 'loadTicketShare');
  if (at < 0) throw new Error('no loadTicketShare on ' + routePath);
  chain = chain.slice(at);
  const res = fakeRes();
  const req = {
    method: method.toUpperCase(), params: Object.assign({ token }, o.params || {}), query: {}, body: o.body || {},
    headers: {}, protocol: 'https', get: () => 'project86.test',
  };
  for (const h of chain) {
    let advanced = false;
    await h(req, res, (err) => { if (err) throw err; advanced = true; });
    if (!advanced) break;
  }
  return res;
}

const tick = (taskId, done, router) => drive(router, 'post', '/service-ticket-share/:token/subtasks/:taskId/done',
  { params: { taskId }, body: { done: done !== false } });
const read = (router) => drive(router, 'get', '/service-ticket-share/:token');
const task = (id) => eng.all('SELECT * FROM tasks WHERE id = ? AND organization_id = 1', id)[0];
const ticketStatus = () => eng.all("SELECT status FROM service_tickets WHERE id = 'st_1'")[0].status;

// ── mutantCopy(): one piece removed from a copy of a shipped file ──────────
// `redirects` points a require of a shipped file at a mutant copy of it, so a
// service can be broken under the real route.
function mutantCopy(file, pairs, redirects) {
  let out = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const src = out;
  for (const [find, replace] of pairs) {
    if (out.split(find).length - 1 !== 1) throw new Error('anchor not found');
    out = out.split(find).join(replace);
  }
  if (pairs.length && out === src) throw new Error('MUTATION CHANGED NO BYTES');
  const fromDir = path.dirname(file);
  const redirect = redirects || {};
  out = out.replace(/require\((['"])([^'"]+)\1\)/g, (m, _q, spec) => {
    let resolved;
    try {
      resolved = spec.charAt(0) === '.'
        ? require.resolve(path.resolve(fromDir, spec))
        : require.resolve(spec, { paths: [fromDir] });
    } catch (e) {
      return m;
    }
    if (redirect[resolved]) resolved = redirect[resolved];
    return 'require(' + JSON.stringify(resolved.split(path.sep).join('/')) + ')';
  });
  const p = path.join(os.tmpdir(), '_p86_replyonly_' + process.pid + '_' + Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, out, 'utf8');
  mutantPaths.push(p);
  return p;
}

// The share router over a broken copy of the work-order service.
function routerOverWorkOrder(pairs) {
  const wo = mutantCopy(WORKORDER, pairs);
  return require(mutantCopy(SHARE_ROUTES, [], { [require.resolve(WORKORDER)]: wo }));
}

describe('the mutation harness', () => {
  test('an anchor that is absent throws, and every file is CRLF on disk so the normalisation is load-bearing', () => {
    expect(() => mutantCopy(WORKORDER, [['this text is nowhere in the file', 'x']])).toThrow('anchor not found');
    for (const f of [SHARE_ROUTES, WORKORDER, TICKETS]) expect(fs.readFileSync(f, 'utf8').indexOf('\r\n')).toBeGreaterThan(-1);
  });

  test('an unchanged copy answers exactly like the shipped router', async () => {
    const r = routerOverWorkOrder([['async function applySubtaskDone(', 'async function applySubtaskDone /* copy */(']]);
    expect((await tick('t1', true, r)).statusCode).toBe(409);
    expect((await tick('r1', true, r)).statusCode).toBe(200);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE RULE — services/service-tickets.js
 * ══════════════════════════════════════════════════════════════════════════*/
describe('subtaskNeedsPhoto / subtaskMayComplete', () => {
  const completion = [{ id: 'p', tags: ['completion'] }];

  test('only kind follow_up is reply only; every other kind, and no kind, needs its photo', () => {
    expect(svc.REPLY_ONLY_KIND).toBe('follow_up');
    expect(svc.subtaskNeedsPhoto({ kind: 'follow_up' })).toBe(false);
    for (const t of [{ kind: 'todo' }, { kind: 'punch' }, { kind: '' }, { kind: null }, {}, null, undefined, { kind: 'FOLLOW_UP' }]) {
      expect(svc.subtaskNeedsPhoto(t)).toBe(true);
    }
  });

  test('a reply-only line may complete with no photo; field work may not, as before', () => {
    expect(svc.subtaskMayComplete([], { kind: 'follow_up' })).toEqual({ ok: true });
    expect(svc.subtaskMayComplete([], { kind: 'todo' }).ok).toBe(false);
    expect(svc.subtaskMayComplete(completion, { kind: 'todo' }).ok).toBe(true);
  });

  test('a caller that passes no task gets the old rule: a photo is required', () => {
    expect(svc.subtaskMayComplete([]).ok).toBe(false);
    expect(svc.subtaskMayComplete([]).reason).toBe(PHOTO_REFUSAL);
    expect(svc.subtaskMayComplete(completion).ok).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE CREW LINK — POST /service-ticket-share/:token/subtasks/:taskId/done
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the crew finishes a reply-only line', () => {
  test('with no photo: 200, the line is done and stamped, the work order stays In progress', async () => {
    const res = await tick('r1');
    expect(res.statusCode).toBe(200);
    expect(task('r1').status).toBe('done');
    expect(task('r1').completed_at).not.toBeNull();
    expect(ticketStatus()).toBe('in_progress');
  });

  test('CONTROL: field work with no photo is still 409 completion_photo_required, and stays open', async () => {
    const res = await tick('t1');
    expect([res.statusCode, res.body]).toEqual([409, { error: PHOTO_REFUSAL, code: 'completion_photo_required' }]);
    expect(task('t1').status).toBe('open');
  });

  test('a reply-only line that is the LAST open one finishes the work order and tells the office', async () => {
    eng.db.exec("UPDATE tasks SET status = 'done' WHERE id IN ('f1', 't1')");
    const res = await tick('r1');
    expect(res.statusCode).toBe(200);
    expect(ticketStatus()).toBe('work_complete');
    await flush();
    expect(calls).toHaveLength(1);
  });

  test('undoing it needs no photo either: back to open', async () => {
    expect((await tick('r1')).statusCode).toBe(200);
    expect((await tick('r1', false)).statusCode).toBe(200);
    expect(task('r1').status).toBe('open');
  });

  test('MUTANT: the kind not handed to the rule -> the reply-only line is refused for a photo it can never have', async () => {
    const r = routerOverWorkOrder([[
      'const verdict = svc.subtaskMayComplete(photos, task);',
      'const verdict = svc.subtaskMayComplete(photos);']]);
    const res = await tick('r1', true, r);
    expect([res.statusCode, res.body.code]).toEqual([409, 'completion_photo_required']);
    expect(task('r1').status).toBe('open');
  });

  test('MUTANT: the locked read without kind -> the same refusal: the rule never sees the line is reply only', async () => {
    const r = routerOverWorkOrder([[
      '`SELECT id, title, status, completed_at, kind FROM tasks',
      '`SELECT id, title, status, completed_at FROM tasks']]);
    expect((await tick('r1', true, r)).statusCode).toBe(409);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE CREW LINK'S READ — GET /service-ticket-share/:token
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the crew read says which lines are reply only', () => {
  test('reply_only is true on the follow-up and false on field work, and the kind itself is not sent', async () => {
    const res = await read();
    expect(res.statusCode).toBe(200);
    const byId = Object.fromEntries(res.body.tasks.map((t) => [t.id, t]));
    expect([byId.f1.reply_only, byId.r1.reply_only, byId.t1.reply_only]).toEqual([false, true, false]);
    for (const t of res.body.tasks) expect(t).not.toHaveProperty('kind');
  });

  test('MUTANT: the crew SELECT without kind -> every line reads as needing a photo, and the page asks for one', async () => {
    const r = require(mutantCopy(SHARE_ROUTES, [[
      '`SELECT id, title, status, due_date, completed_at, kind FROM tasks',
      '`SELECT id, title, status, due_date, completed_at FROM tasks']]));
    const res = await read(r);
    expect(res.statusCode).toBe(200);
    expect(res.body.tasks.map((t) => t.reply_only)).toEqual([false, false, false]);
  });
});
