// THE CREW BUILDING DOOR DECIDES ON THE LOCKED ROW (1.29, A1).
//
// POST /api/service-ticket-share/:token/subtasks/:taskId/done
//
// loadTicketShare reads the ticket, then the door opens a transaction and
// setSubtaskDone locks the row. The office can approve, close or cancel in
// between. The crew rule (svc.crewSubtasksWritable, through
// subtaskDoor.crewGate) is asked again of the LOCKED row, so a crew phone that
// loaded the work order while it was In progress cannot finish, or take back,
// a building on a work order the office has since approved:
//
//   409 { error: <the crew rule's sentence>, code: 'work_order_locked' }
//
// and nothing is written: the building keeps its state, the ticket keeps its
// status and completion time, no timeline line, no approval notice, and the
// transaction rolls back.
//
// ── HOW ───────────────────────────────────────────────────────────────────
// The REAL share router against node:sqlite through the pg shim, tables from
// sqliteSchema. The drive starts at the door's handler with req.share and
// req.ticket put in place as loadTicketShare would have left them a moment
// earlier (the ticket In progress), while the database row already says what
// the office saved. Then the gate is removed from a copy of the route file,
// and the crew rule is loosened in a copy of the door module, and the same
// drive finishes a building on an approved work order.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

jest.mock('../server/storage', () => ({
  storage: { put: async (key) => 'https://cdn.test/' + key, delete: async () => {} },
}));

const SHARE_ROUTES = path.join(__dirname, '..', 'server', 'routes', 'service-ticket-share-routes.js');
const SUBTASK_DOOR = path.join(__dirname, '..', 'server', 'services', 'service-ticket-subtask-door.js');

const TABLES = [
  'organizations', 'users', 'jobs', 'leads', 'tasks', 'attachments',
  'service_tickets', 'service_ticket_events', 'service_ticket_shares', 'service_ticket_revisions',
  'service_ticket_flags',
];

let eng;
let svc;
let notify;
let shareRouter;
let log;
let calls;
let realNotify;
let mutantPaths = [];

function seed(status) {
  const exp = new Date(Date.now() + 86400000).toISOString();
  eng.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM jobs; DELETE FROM tasks; DELETE FROM attachments;
    DELETE FROM service_tickets; DELETE FROM service_ticket_events; DELETE FROM service_ticket_shares;
    DELETE FROM service_ticket_revisions; DELETE FROM service_ticket_flags;

    INSERT INTO organizations (id, name, timezone) VALUES (1, 'AGX', 'America/New_York');
    INSERT INTO users (id, name, email, organization_id) VALUES (10, 'Wendy PM', 'w@agx.test', 1);
    INSERT INTO jobs (id, owner_id, data, organization_id) VALUES ('j1', 10, '{}', 1);
    INSERT INTO service_tickets (id, organization_id, title, job_id, status, checklist, created_by, completed_at, approval_notice_attempts, created_at) VALUES
      ('st_1', 1, 'Latitude 28 rails', 'j1', '${status}', '[]', 10, NULL, 0, '2026-09-01 10:00:00');
    INSERT INTO service_ticket_shares (id, organization_id, ticket_id, token_hash, scope, hide_financials, recipient_name, expires_at, created_by, view_count, created_at) VALUES
      ('sh1', 1, 'st_1', '${svc.hashToken(svc.genToken())}', 'respond', 1, 'Marco', '${exp}', 10, 0, '2026-09-02 09:00:00');
    INSERT INTO tasks (id, organization_id, title, status, scope, service_ticket_id, entity_type, entity_id, archived_at, completed_at, created_at) VALUES
      ('k0', 1, 'Bldg 700', 'done', 'org', 'st_1', 'job', 'j1', NULL, '2026-09-03 08:00:00', '2026-09-02 08:00:00'),
      ('k1', 1, 'Bldg 701', 'open', 'org', 'st_1', 'job', 'j1', NULL, NULL, '2026-09-02 08:00:01');
    INSERT INTO attachments (id, entity_type, entity_id, organization_id, folder, filename, mime_type, tags, position, uploaded_at) VALUES
      ('att_k0', 'task', 'k0', 1, 'general', 'k0.jpg', 'image/jpeg', '["completion"]', 0, '2026-09-02 08:30:00'),
      ('att_k1', 'task', 'k1', 1, 'general', 'k1.jpg', 'image/jpeg', '["completion"]', 0, '2026-09-02 08:30:00');
  `);
}

beforeAll(() => {
  eng = createPgSqlite(sqliteSchema(TABLES), { jsonColumns: ['checklist', 'detail', 'data', 'tags', 'fields'] });
  const db = require('../server/db');
  db.pool.query = async (sql, params) => {
    log.push(String(sql));
    return eng.pool.query(sql, params);
  };
  const realConnect = eng.pool.connect;
  db.pool.connect = async () => {
    const client = await realConnect();
    return {
      release: client.release,
      query: async (sql, params) => { log.push(String(sql)); return client.query(sql, params); },
    };
  };
  svc = require('../server/services/service-tickets');
  notify = require('../server/services/service-ticket-notify');
  shareRouter = require('../server/routes/service-ticket-share-routes');
});

const flush = () => new Promise((r) => setTimeout(r, 25));

beforeEach(() => {
  log = [];
  calls = [];
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
  require('../server/db').pool.query = async () => ({ rows: [], rowCount: 0 });
  if (eng) eng.close();
});

// ── the drive ─────────────────────────────────────────────────────────────
function fakeRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.body = p; return res; };
  return res;
}

// The door as loadTicketShare hands it on: req.share and req.ticket are the
// rows read BEFORE the lock. `staleStatus` is the status that read saw.
async function tick(router, taskId, done, staleStatus) {
  const layer = router.stack.find((l) => l.route && l.route.path === '/service-ticket-share/:token/subtasks/:taskId/done' && l.route.methods.post);
  if (!layer) throw new Error('route not declared');
  const chain = layer.route.stack.map((s) => s.handle);
  const at = chain.findIndex((h) => h.name === 'loadTicketShare');
  if (at < 0) throw new Error('no loadTicketShare on the done door');
  const handler = chain[at + 1];
  const share = eng.all("SELECT * FROM service_ticket_shares WHERE id = 'sh1' AND organization_id = 1")[0];
  const ticket = Object.assign({}, eng.all("SELECT * FROM service_tickets WHERE id = 'st_1' AND organization_id = 1")[0], { status: staleStatus });
  const req = { params: { token: 'x', taskId }, body: { done }, headers: {}, share, ticket };
  const res = fakeRes();
  await handler(req, res, () => { throw new Error('the handler called next()'); });
  return res;
}

const ticketRow = () => eng.all("SELECT status, completed_at FROM service_tickets WHERE id = 'st_1' AND organization_id = 1")[0];
const taskRow = (id) => eng.all('SELECT status, completed_at FROM tasks WHERE id = ? AND organization_id = 1', id)[0];
const eventKinds = () => eng.all("SELECT kind FROM service_ticket_events WHERE ticket_id = 'st_1'").map((e) => e.kind);
const txLog = () => log.map((s) => s.trim()).filter((s) => /^(BEGIN|COMMIT|ROLLBACK)$/i.test(s));

// Everything the refusal must leave exactly as it was.
function snapshot() {
  return { ticket: ticketRow(), k0: taskRow('k0'), k1: taskRow('k1'), events: eventKinds(), attachments: eng.all('SELECT id FROM attachments ORDER BY id') };
}

// ── mutants ───────────────────────────────────────────────────────────────
function absolutize(src, fromDir) {
  return src.replace(/require\((['"])([^'"]+)\1\)/g, (_m, _q, spec) => {
    const resolved = spec.charAt(0) === '.'
      ? require.resolve(path.resolve(fromDir, spec))
      : require.resolve(spec, { paths: [fromDir] });
    return 'require(' + JSON.stringify(resolved.split(path.sep).join('/')) + ')';
  });
}

function writeMutant(file, pairs, redirects) {
  let out = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  for (const [find, replace] of pairs) {
    const hits = out.split(find).length - 1;
    if (hits !== 1) throw new Error('anchor not found' + (hits > 1 ? ' (ambiguous: ' + hits + ')' : '') + ': ' + JSON.stringify(find.slice(0, 120)));
    out = out.split(find).join(replace);
  }
  out = absolutize(out, path.dirname(file));
  for (const [from, to] of Object.entries(redirects || {})) {
    const ref = 'require(' + JSON.stringify(from.split(path.sep).join('/')) + ')';
    if (out.split(ref).length - 1 !== 1) throw new Error('redirect not found: ' + ref);
    out = out.split(ref).join('require(' + JSON.stringify(to.split(path.sep).join('/')) + ')');
  }
  const p = path.join(os.tmpdir(), '_p86_crew_lock_gate_mutant_' + process.pid + '_' + Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, out, 'utf8');
  mutantPaths.push(p);
  return p;
}

const NO_GATE = [
  '        // The crew rule again, on the row setSubtaskDone holds locked.\n        gate: subtaskDoor.crewGate,\n',
  '',
];
const DOOR_ALWAYS_OK = [
  'function crewGate(lockedRow) {\n  const crew = svc.crewSubtasksWritable(lockedRow && lockedRow.status);\n  return crew.ok ? { ok: true } : locked(crew.reason);\n',
  'function crewGate(lockedRow) {\n  return { ok: true };\n',
];

describe('the mutation harness', () => {
  test('an anchor that is not in the file throws', () => {
    expect(() => writeMutant(SHARE_ROUTES, [['nowhere in the routes', 'x']])).toThrow(/anchor not found/);
  });
  test('each anchor is in its shipped file exactly once', () => {
    expect(fs.readFileSync(SHARE_ROUTES, 'utf8').replace(/\r\n/g, '\n').split(NO_GATE[0]).length - 1).toBe(1);
    expect(fs.readFileSync(SUBTASK_DOOR, 'utf8').replace(/\r\n/g, '\n').split(DOOR_ALWAYS_OK[0]).length - 1).toBe(1);
  });
});

describe('the crew rule on the locked row', () => {
  test('subtaskDoor.crewGate: approved, closed, cancelled and draft are work_order_locked with the crew sentence; the rest pass', () => {
    const door = require('../server/services/service-ticket-subtask-door');
    for (const s of ['approved', 'closed', 'cancelled', 'draft']) {
      expect([s, door.crewGate({ status: s })]).toEqual([s, {
        ok: false, status: 409, error: svc.crewSubtasksWritable(s).reason, code: 'work_order_locked',
      }]);
    }
    for (const s of ['open', 'scheduled', 'in_progress', 'work_complete']) {
      expect([s, door.crewGate({ status: s })]).toEqual([s, { ok: true }]);
    }
  });
});

describe('POST /service-ticket-share/:token/subtasks/:taskId/done on a stale copy', () => {
  test('the page loaded it In progress, the office approved since: 409 work_order_locked and nothing is written', async () => {
    seed('approved');
    const before = snapshot();
    const res = await tick(shareRouter, 'k1', true, 'in_progress');
    expect([res.statusCode, res.body]).toEqual([409, {
      error: 'The office has approved this work order. Ask them to reopen it for changes.',
      code: 'work_order_locked',
    }]);
    await flush();
    expect(snapshot()).toEqual(before);
    expect(calls).toHaveLength(0);
    expect(txLog()).toEqual(['BEGIN', 'ROLLBACK']);
    expect(log.some((s) => /^\s*UPDATE tasks/i.test(s))).toBe(false);
    expect(log.some((s) => /INSERT INTO service_ticket_events/i.test(s))).toBe(false);
  });

  test('taking a building back after the office approved is refused the same way', async () => {
    seed('approved');
    const before = snapshot();
    const res = await tick(shareRouter, 'k0', false, 'in_progress');
    expect([res.statusCode, res.body.code]).toEqual([409, 'work_order_locked']);
    await flush();
    expect(snapshot()).toEqual(before);
  });

  test('closed or cancelled since: the same refusal with that status\'s sentence', async () => {
    for (const status of ['closed', 'cancelled']) {
      seed(status);
      const before = snapshot();
      const res = await tick(shareRouter, 'k1', true, 'in_progress');
      expect([status, res.statusCode, res.body]).toEqual([status, 409, {
        error: 'This work order is ' + status + ' and can no longer be updated.', code: 'work_order_locked',
      }]);
      expect(snapshot()).toEqual(before);
    }
  });

  test('control: the row still In progress, the last building lands and the work order moves to Work complete', async () => {
    seed('in_progress');
    const res = await tick(shareRouter, 'k1', true, 'in_progress');
    expect([res.statusCode, res.body]).toEqual([200, { ok: true, done: true, ticket_status: 'work_complete' }]);
    await flush();
    expect(taskRow('k1').status).toBe('done');
    expect(ticketRow().status).toBe('work_complete');
    expect(calls).toHaveLength(1);
    expect(txLog()).toEqual(['BEGIN', 'COMMIT']);
  });

  test('MUTANT: the gate dropped from the door -> the building is finished on an approved work order', async () => {
    const mut = require(writeMutant(SHARE_ROUTES, [NO_GATE]));
    seed('approved');
    const res = await tick(mut, 'k1', true, 'in_progress');
    expect(res.statusCode).toBe(200);
    await flush();
    expect(taskRow('k1').status).toBe('done');
    expect(ticketRow().status).toBe('approved');
    expect(eventKinds()).toEqual(['subtask_completed']);
  });

  test('MUTANT: the crew rule loosened in the door module -> the same building lands', async () => {
    const door = writeMutant(SUBTASK_DOOR, [DOOR_ALWAYS_OK]);
    const mut = require(writeMutant(SHARE_ROUTES, [], { [require.resolve(SUBTASK_DOOR)]: door }));
    seed('approved');
    const res = await tick(mut, 'k0', false, 'in_progress');
    expect(res.statusCode).toBe(200);
    await flush();
    expect(taskRow('k0').status).toBe('open');
    expect(eventKinds()).toEqual(['subtask_reopened']);
  });
});
