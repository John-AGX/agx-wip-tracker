// FINISH WHOLE WORK ORDER, RACED — THE CREW PATCH UNDER A LOCK (1.29, A1 + A10).
//
// ── WHAT THIS FILE PINS ───────────────────────────────────────────────────
// PATCH /api/service-ticket-share/:token reads the ticket, decides, and writes
// it. Between the read and the write the office can move the ticket (cancel
// it, send it back), and before 1.29 the crew's write landed on top: a
// cancelled work order came back as Work complete and the approvers were told
// it was ready. It could also finish a work order with 18 of 21 buildings
// still open, around the punch list the crew is meant to finish.
//
// So the door now:
//   * locks the ticket row, and re-checks everything on the LOCKED row;
//   * refuses Finish while any live org building is open (409 buildings_open)
//     and then writes nothing at all;
//   * guards its UPDATE on organization_id AND the locked status, answering
//     409 status_changed when the row moved underneath it — no event, no
//     notice.
//
// ── HOW ───────────────────────────────────────────────────────────────────
// The REAL router, against node:sqlite through the pg shim, with tables from
// sqliteSchema. sqlite cannot show a real lock race (FOR UPDATE is stripped),
// so the race is INTERLEAVED: a wrapper around the pool runs the office's
// cancel right before the crew's UPDATE reaches the database, which is the
// moment a real race would land it.
//
// Then each guard is removed from a copy of the shipped file (CRLF-normalised
// anchors that must match exactly once) and the same drive is shown to produce
// the wrong outcome the guard exists to stop.
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

const STALE = 'This work order just changed. Reload to see the latest.';
const EIGHTEEN_OPEN = "18 of 21 buildings aren't finished. Finish each building on the punch list first — the office is told automatically when the last one is done.";

let eng;
let db;
let svc;
let notify;
let shareRouter;
let calls;
let realNotify;
let realConnect;
let token;

// The interleave: when set, runs once, right before the crew PATCH's UPDATE of
// service_tickets reaches the database. sqlite has ONE connection, so the
// office's write runs inside the crew's open transaction; in Postgres it is
// another connection's committed write, which the crew's ROLLBACK cannot undo.
// So an interleaved write is applied again after a ROLLBACK (it is idempotent).
let beforeTicketUpdate = null;
let committedElsewhere = [];

function seed() {
  token = svc.genToken();
  eng.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM jobs; DELETE FROM tasks;
    DELETE FROM service_tickets; DELETE FROM service_ticket_events; DELETE FROM service_ticket_shares;
    DELETE FROM attachments;

    INSERT INTO organizations (id, name, timezone) VALUES (1, 'AGX', 'America/New_York'), (2, 'Rival Co', 'America/New_York');
    INSERT INTO users (id, name, email, organization_id) VALUES (10, 'Wendy PM', 'w@agx.test', 1);
    INSERT INTO jobs (id, owner_id, data, organization_id) VALUES ('j1', 10, '{}', 1);
    INSERT INTO service_tickets (id, organization_id, title, job_id, status, checklist, guest_log, created_by, approval_notice_attempts, created_at) VALUES
      ('st_1', 1, 'Latitude 28 rails', 'j1', 'in_progress', '[]', NULL, 10, 0, '2026-09-01 10:00:00');
    INSERT INTO service_ticket_shares (id, organization_id, ticket_id, token_hash, scope, hide_financials, recipient_name, expires_at, created_by, view_count, opened_at, created_at) VALUES
      ('sh1', 1, 'st_1', '${svc.hashToken(token)}', 'respond', 1, 'Marco', '${new Date(Date.now() + 86400000).toISOString()}', 10, 0, '2026-09-02 09:00:00', '2026-09-02 09:00:00');
  `);
}

// n buildings on st_1, the first `done` of them done. Plus a rival org's open
// task pointing at the same ticket id and an archived open one: neither is on
// this work order's punch list, so neither may hold the finish back.
function buildings(n, done) {
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    rows.push(`('k${i}', 1, 'Bldg ${700 + i}', '${i < done ? 'done' : 'open'}', 'org', 'st_1', 'job', 'j1', NULL, '2026-09-02 08:00:${String(i).padStart(2, '0')}')`);
  }
  rows.push("('k_rival', 2, 'Rival building', 'open', 'org', 'st_1', 'job', 'j9', NULL, '2026-09-02 08:01:00')");
  rows.push("('k_archived', 1, 'Old building', 'open', 'org', 'st_1', 'job', 'j1', '2026-09-03 08:00:00', '2026-09-02 08:02:00')");
  eng.db.exec('INSERT INTO tasks (id, organization_id, title, status, scope, service_ticket_id, entity_type, entity_id, archived_at, created_at) VALUES ' + rows.join(', '));
}

beforeAll(async () => {
  eng = createPgSqlite(sqliteSchema(TABLES), {
    jsonColumns: ['checklist', 'detail', 'data', 'tags'],
  });
  db = require('../server/db');
  db.pool.query = eng.pool.query;
  realConnect = eng.pool.connect;
  db.pool.connect = async () => {
    const client = await realConnect();
    return {
      release: client.release,
      query: async (sql, params) => {
        if (beforeTicketUpdate && /^\s*UPDATE service_tickets SET/i.test(String(sql))) {
          const hook = beforeTicketUpdate;
          beforeTicketUpdate = null;
          hook();
          committedElsewhere.push(hook);
        }
        const out = await client.query(sql, params);
        if (/^\s*ROLLBACK\s*$/i.test(String(sql))) committedElsewhere.forEach((h) => h());
        return out;
      },
    };
  };
  svc = require('../server/services/service-tickets');
  notify = require('../server/services/service-ticket-notify');
  shareRouter = require('../server/routes/service-ticket-share-routes');
});

const flush = () => new Promise((r) => setTimeout(r, 25));

let mutantPaths = [];
beforeEach(() => {
  seed();
  beforeTicketUpdate = null;
  committedElsewhere = [];
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
  db.pool.query = async () => ({ rows: [], rowCount: 0 });
  if (eng) eng.close();
});

// ── the drive: the whole chain from loadTicketShare on ─────────────────────
function fakeRes() {
  const res = { statusCode: 200, body: undefined, headersSent: false };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.body = p; res.headersSent = true; return res; };
  res.set = () => res;
  return res;
}

async function drive(router, method, routePath, opts) {
  const o = opts || {};
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error('route not declared: ' + method + ' ' + routePath);
  let chain = layer.route.stack.map((s) => s.handle);
  const at = chain.findIndex((h) => h.name === 'loadTicketShare');
  if (at < 0) throw new Error('no loadTicketShare on ' + routePath);
  chain = chain.slice(at);
  const res = fakeRes();
  const req = {
    method: method.toUpperCase(), params: o.params || {}, query: {}, body: o.body || {},
    headers: {}, protocol: 'https', get: () => 'project86.test',
  };
  for (const h of chain) {
    let advanced = false;
    await h(req, res, (err) => { if (err) throw err; advanced = true; });
    if (!advanced) break;
  }
  return res;
}

const finish = (router, body) => drive(router || shareRouter, 'patch', '/service-ticket-share/:token',
  { params: { token }, body: body || { status: 'work_complete' } });
const ticketRow = () => eng.all("SELECT * FROM service_tickets WHERE id = 'st_1'")[0];
const eventKinds = () => eng.all("SELECT kind FROM service_ticket_events WHERE ticket_id = 'st_1'").map((e) => e.kind);
const officeCancels = () => eng.db.exec("UPDATE service_tickets SET status = 'cancelled' WHERE id = 'st_1' AND organization_id = 1");

// ── mutant(): one guard removed from a copy of the shipped file ────────────
function mutant(pairs) {
  const SOURCE = fs.readFileSync(SHARE_ROUTES, 'utf8');
  let out = SOURCE.replace(/\r\n/g, '\n');
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
  const p = path.join(os.tmpdir(), '_p86_crew_finish_mutant_' + process.pid + '_' + Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, out, 'utf8');
  mutantPaths.push(p);
  return require(p);
}

const STATUS_GUARD = [
  "        ' AND status = $' + params.length + ' RETURNING *',",
  "        ' AND $' + params.length + ' IS NOT NULL RETURNING *',",
];
const BUILDINGS_GUARD = [
  '              if (counts.total > 0 && counts.done < counts.total) {',
  '              if (false) {',
];

describe('the mutation harness', () => {
  test('an anchor that is not in the file throws instead of passing quietly', () => {
    expect(() => mutant([['this string is nowhere in the routes', 'x']])).toThrow(/anchor not found/);
  });
  test('both anchors are in the shipped file exactly once', () => {
    const src = fs.readFileSync(SHARE_ROUTES, 'utf8').replace(/\r\n/g, '\n');
    for (const [find] of [STATUS_GUARD, BUILDINGS_GUARD]) expect(src.split(find).length - 1).toBe(1);
  });
});

describe('the office cancels while the crew is finishing', () => {
  test('the crew finish lands on nothing: 409 status_changed, the row stays cancelled, nobody is told', async () => {
    buildings(2, 2);
    beforeTicketUpdate = officeCancels;
    const res = await finish(null, { status: 'work_complete', note: 'All done, gate latches' });
    expect([res.statusCode, res.body]).toEqual([409, { error: STALE, code: 'status_changed' }]);
    await flush();
    expect(ticketRow().status).toBe('cancelled');
    expect(ticketRow().completed_at).toBeNull();
    expect(ticketRow().guest_log).toBeNull();
    expect(eventKinds()).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(beforeTicketUpdate).toBeNull();   // the interleave really ran
  });

  test('control: with no interleave the same finish lands and the office is told once', async () => {
    buildings(2, 2);
    const res = await finish();
    expect(res.statusCode).toBe(200);
    await flush();
    expect(ticketRow().status).toBe('work_complete');
    expect(ticketRow().completed_at).not.toBeNull();
    const ev = eng.all("SELECT kind, actor_kind, share_id, detail FROM service_ticket_events WHERE ticket_id = 'st_1'");
    expect(ev.map((e) => [e.kind, e.actor_kind, e.share_id])).toEqual([['status_changed', 'share', 'sh1']]);
    expect(ev[0].detail).toEqual({ from: 'in_progress', to: 'work_complete', reason: 'marked_complete' });
    expect(calls).toHaveLength(1);
    expect([calls[0].ticket.id, calls[0].ticket.status, calls[0].reason, calls[0].sharedBy]).toEqual(['st_1', 'work_complete', 'marked_complete', 10]);
  });

  test('MUTANT: drop the status guard from the UPDATE and the cancelled work order comes back as Work complete, with a notice', async () => {
    const mut = mutant([STATUS_GUARD]);
    buildings(2, 2);
    beforeTicketUpdate = officeCancels;
    const res = await finish(mut);
    expect(res.statusCode).toBe(200);
    await flush();
    expect(ticketRow().status).toBe('work_complete');
    expect(calls).toHaveLength(1);
  });
});

describe('Finish whole work order waits for the punch list', () => {
  test('18 of 21 open: 409 buildings_open with the exact sentence; the typed note is not written either', async () => {
    buildings(21, 3);
    const res = await finish(null, { status: 'work_complete', note: 'Finished the rails' });
    expect([res.statusCode, res.body]).toEqual([409, { error: EIGHTEEN_OPEN, code: 'buildings_open', open: 18, total: 21 }]);
    await flush();
    expect(ticketRow().status).toBe('in_progress');
    expect(ticketRow().guest_log).toBeNull();
    expect(eventKinds()).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test('the rival org\'s task and the archived building do not count toward the punch list', async () => {
    buildings(3, 3);
    const res = await finish();
    expect(res.statusCode).toBe(200);
    expect(ticketRow().status).toBe('work_complete');
  });

  test('MUTANT: drop the buildings check and the work order finishes with 18 buildings open', async () => {
    const mut = mutant([BUILDINGS_GUARD]);
    buildings(21, 3);
    const res = await finish(mut);
    expect(res.statusCode).toBe(200);
    await flush();
    expect(ticketRow().status).toBe('work_complete');
    expect(calls).toHaveLength(1);
  });
});

describe('the crew takes back its own finish, against the real rows', () => {
  test('finish, then undo: back to in_progress with completed_at cleared, and the undo tells nobody', async () => {
    buildings(1, 1);
    expect((await finish()).statusCode).toBe(200);
    await flush();
    expect(calls).toHaveLength(1);
    // pg-sqlite stores no created_at default; give the finish its moment so
    // "the newest status event" is well defined, as it is in Postgres.
    eng.db.exec("UPDATE service_ticket_events SET created_at = '2026-09-15 14:00:00' WHERE ticket_id = 'st_1'");
    const undo = await finish(null, { status: 'in_progress' });
    expect(undo.statusCode).toBe(200);
    await flush();
    expect([ticketRow().status, ticketRow().completed_at]).toEqual(['in_progress', null]);
    const last = eng.all("SELECT detail FROM service_ticket_events WHERE ticket_id = 'st_1' AND created_at IS NULL")[0];
    expect(last.detail).toEqual({ from: 'work_complete', to: 'in_progress', reason: 'crew_undid_finish' });
    expect(calls).toHaveLength(1);
  });

  test('after the office moved it, the same undo is finish_not_yours and nothing changes', async () => {
    eng.db.exec(`
      UPDATE service_tickets SET status = 'work_complete' WHERE id = 'st_1';
      INSERT INTO service_ticket_events (id, organization_id, ticket_id, kind, actor_kind, actor_user_id, share_id, detail, created_at) VALUES
        ('e1', 1, 'st_1', 'status_changed', 'share', NULL, 'sh1', '{"from":"in_progress","to":"work_complete","reason":"marked_complete"}', '2026-09-15 14:00:00'),
        ('e2', 1, 'st_1', 'status_changed', 'user', 10, NULL, '{"from":"work_complete","to":"in_progress","action":"send_back","note":"Rail loose"}', '2026-09-15 15:00:00'),
        ('e3', 1, 'st_1', 'status_changed', 'user', 10, NULL, '{"from":"in_progress","to":"work_complete"}', '2026-09-15 16:00:00');
    `);
    const res = await finish(null, { status: 'in_progress' });
    expect([res.statusCode, res.body.code]).toEqual([409, 'finish_not_yours']);
    expect(ticketRow().status).toBe('work_complete');
  });
});
