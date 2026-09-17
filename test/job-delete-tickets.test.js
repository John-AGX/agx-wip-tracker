// DELETING A JOB KEEPS ITS WORK ORDERS UNLESS SOMEONE SAYS OTHERWISE (A4).
//
// ── THE HOLE ──────────────────────────────────────────────────────────────
// service_tickets.job_id is ON DELETE CASCADE. DELETE /api/jobs/:id locked the
// job, un-stranded its estimate and lead, and deleted it, so every work order
// on the job went with it: open ones mid-job, and closed ones with their
// approval history, timeline and crew links. Nothing asked.
//
// ── THE RULE ──────────────────────────────────────────────────────────────
//   - an OPEN ticket (not archived, not closed or cancelled) refuses the
//     delete: 409 OPEN_TICKETS, and nothing changes;
//   - closed, cancelled or archived tickets refuse it too, 409 CLOSED_TICKETS
//     with the counts, until the caller echoes the exact total back as
//     ?confirm_closed_tickets=N;
//   - a confirmed delete leaves an admin audit row naming the tickets;
//   - another organization's tickets are never counted.
//
// ── HOW ───────────────────────────────────────────────────────────────────
// The REAL router over a signed JWT, against node:sqlite through the pg shim
// (the harness of test/service-ticket-route-access.test.js). Assertions are on
// the response and on the rows afterwards. Then each guard is removed from a
// copy of the shipped file and the identical drive goes red.
//
// Two things the shim does not do, supplied here and pinned:
//   - FOREIGN KEYS. The fixture schema is derived columns only. The cascade
//     the guard exists to stop is emulated with a trigger, and a test below
//     proves server/db.js really declares job_id ... ON DELETE CASCADE.
//   - jsonb_set. The job delete un-strands its estimate with one jsonb
//     expression; it is translated to sqlite's json_set/json_remove (same
//     document) instead of stubbed, so that step still runs for real.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const ROOT = path.join(__dirname, '..');
const JOB_ROUTES = path.join(ROOT, 'server', 'routes', 'job-routes.js');
const GUARD = path.join(ROOT, 'server', 'services', 'job-ticket-guard.js');

const TABLES = ['organizations', 'users', 'roles', 'jobs', 'leads', 'estimates',
  'service_tickets', 'admin_audit_log'];

const ADMIN = 10;       // org 1 admin
const PM = 20;          // org 1, not an admin
const RIVAL = 50;       // org 2 admin
const USERS = {
  [ADMIN]: { role: 'admin', org: 1 },
  [PM]: { role: 'pm', org: 1 },
  [RIVAL]: { role: 'admin', org: 2 },
};

// The one jsonb expression in the delete, as sqlite spells the same edit.
const JSONB_UNSTRAND = "jsonb_set(COALESCE(data, '{}'::jsonb) - 'job_id', '{status}', to_jsonb('accepted'::text))";
const SQLITE_UNSTRAND = "json_set(json_remove(COALESCE(data, '{}'), '$.job_id'), '$.status', 'accepted')";
function jsonbToSqlite(sql) {
  return String(sql).split(JSONB_UNSTRAND).join(SQLITE_UNSTRAND);
}

let eng;
let auth;
let jobRouter;
let sqlLog = null;

// Run `fn` with the transaction's statements recorded, and hand them back. The
// ordinary drives above pay nothing for this: sqlLog is null outside it.
async function recordSql(fn) {
  const outer = sqlLog;
  sqlLog = [];
  try {
    await fn();
    return sqlLog;
  } finally {
    sqlLog = outer;
  }
}

function seed() {
  eng.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM roles; DELETE FROM jobs;
    DELETE FROM leads; DELETE FROM estimates; DELETE FROM service_tickets; DELETE FROM admin_audit_log;

    INSERT INTO organizations (id, name) VALUES (1, 'AGX'), (2, 'Rival Co');
    INSERT INTO users (id, name, email, role, organization_id) VALUES
      (10, 'Ada Admin', 'a@agx.test', 'admin', 1),
      (20, 'Pat PM', 'p@agx.test', 'pm', 1),
      (50, 'Rex Rival', 'r@rival.test', 'admin', 2);

    -- j_open: one live work order among retired ones.
    -- j_retired: one closed, one cancelled, one archived (archived AND closed:
    --            archived wins, so it counts once, as archived).
    -- j_clean: no tickets. Its estimate and lead are the un-strand check.
    -- j_shared: one closed ticket of its own, plus rows in ANOTHER org that
    --           point at the same job id (one open, one closed).
    -- j_rival: org 2's job with an open ticket.
    INSERT INTO jobs (id, owner_id, data, organization_id, estimate_id, lead_id) VALUES
      ('j_open', 10, '{"title":"Open job"}', 1, NULL, NULL),
      ('j_retired', 10, '{"title":"Retired job"}', 1, NULL, NULL),
      ('j_clean', 10, '{"title":"Clean job"}', 1, 'e_clean', 'l_clean'),
      ('j_shared', 10, '{"title":"Shared id"}', 1, NULL, NULL),
      ('j_rival', 50, '{"title":"Rival job"}', 2, NULL, NULL);
    INSERT INTO leads (id, title, status, job_id, organization_id) VALUES
      ('l_clean', 'Clean lead', 'sold', 'j_clean', 1);
    INSERT INTO estimates (id, data, is_locked, organization_id) VALUES
      ('e_clean', '{"job_id":"j_clean","status":"sold","name":"Clean est"}', 1, 1);

    INSERT INTO service_tickets (id, organization_id, title, job_id, status, archived_at, created_at) VALUES
      ('t_live',      1, 'Live gate',       'j_open',    'in_progress', NULL,                  '2026-09-01 10:00:01'),
      ('t_open_done', 1, 'Old gate',        'j_open',    'closed',      NULL,                  '2026-09-01 10:00:02'),
      ('t_closed',    1, 'Closed gate',     'j_retired', 'closed',      NULL,                  '2026-09-01 10:00:03'),
      ('t_cancel',    1, 'Cancelled gate',  'j_retired', 'cancelled',   NULL,                  '2026-09-01 10:00:04'),
      ('t_arch',      1, 'Archived gate',   'j_retired', 'closed',      '2026-09-02 08:00:00', '2026-09-01 10:00:05'),
      ('t_shared',    1, 'Own closed gate', 'j_shared',  'closed',      NULL,                  '2026-09-01 10:00:06'),
      ('t_ghost_open',  2, 'Rival open',    'j_shared',  'open',        NULL,                  '2026-09-01 10:00:07'),
      ('t_ghost_close', 2, 'Rival closed',  'j_shared',  'closed',      NULL,                  '2026-09-01 10:00:08'),
      ('t_rival',     2, 'Rival gate',      'j_rival',   'open',        NULL,                  '2026-09-01 10:00:09');
  `);
}

beforeAll(async () => {
  eng = createPgSqlite(sqliteSchema(TABLES), { jsonColumns: ['data', 'capabilities', 'detail'] });
  // service_tickets.job_id REFERENCES jobs(id) ON DELETE CASCADE, emulated.
  eng.db.exec(`CREATE TRIGGER fk_service_tickets_job_cascade AFTER DELETE ON jobs
    BEGIN DELETE FROM service_tickets WHERE job_id = OLD.id; END;`);
  const db = require('../server/db');
  db.pool.query = (sql, params) => eng.pool.query(jsonbToSqlite(sql), params);
  db.pool.connect = async () => {
    const c = await eng.pool.connect();
    return {
      query: (sql, params) => {
        // Every statement of the transaction, in order and AS THE ROUTE WROTE
        // IT — before jsonbToSqlite, and before the shim strips FOR UPDATE.
        // Armed only inside recordSql(); see "the lock order" at the end.
        if (sqlLog) sqlLog.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params: params });
        return c.query(jsonbToSqlite(sql), params);
      },
      release: c.release,
    };
  };
  auth = require('../server/auth');
  auth.setRolePool(db.pool);
  seed();
  jobRouter = require('../server/routes/job-routes');
});

// The audit row is fire-and-forget after COMMIT; let it land.
const flush = () => new Promise((r) => setTimeout(r, 25));

let mutantPaths = [];
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
  require('../server/db').pool.query = async () => ({ rows: [], rowCount: 0 });
  if (eng) eng.close();
});

beforeEach(() => seed());

// ── the drive ─────────────────────────────────────────────────────────────
function fakeRes() {
  const res = { statusCode: 200, body: undefined, headersSent: false };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.body = p; res.headersSent = true; return res; };
  res.set = () => res;
  return res;
}

function tokenFor(uid) {
  const u = USERS[uid];
  return auth.signToken({ id: uid, email: uid + '@t.test', name: 'U' + uid, role: u.role, organization_id: u.org });
}

async function drive(router, method, routePath, opts) {
  const o = opts || {};
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error('route not declared: ' + method + ' ' + routePath);
  const chain = layer.route.stack.map((s) => s.handle);
  const res = fakeRes();
  const req = {
    method: method.toUpperCase(),
    params: o.params || {},
    query: o.query || {},
    body: o.body || {},
    cookies: {},
    headers: o.as ? { authorization: 'Bearer ' + tokenFor(o.as) } : {},
    protocol: 'https',
    get: () => 'project86.test',
  };
  for (const h of chain) {
    let advanced = false;
    await h(req, res, (err) => { if (err) throw err; advanced = true; });
    if (!advanced) break;
  }
  return res;
}

const del = (router, as, id, query) => drive(router, 'delete', '/:id', { as, params: { id }, query });
const jobExists = (id) => eng.count('SELECT 1 FROM jobs WHERE id = ?', id) === 1;
const ticketIds = (jobId) => eng.all('SELECT id FROM service_tickets WHERE job_id = ? ORDER BY id', jobId).map((r) => r.id);
const auditRows = () => eng.all("SELECT * FROM admin_audit_log WHERE action = 'job.delete_with_service_tickets'");

// ── mutant(): remove ONE guard from a copy of the shipped file ─────────────
function absolutizeRequires(src, fromDir) {
  return src.replace(/require\((['"])([^'"]+)\1\)/g, (_m, _q, spec) => {
    const resolved = spec.charAt(0) === '.'
      ? require.resolve(path.resolve(fromDir, spec))
      : require.resolve(spec, { paths: [fromDir] });
    return 'require(' + JSON.stringify(resolved.split(path.sep).join('/')) + ')';
  });
}

function mutant(file, pairs) {
  let out = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  for (const [find, replace] of pairs) {
    if (out.split(find).length - 1 !== 1) throw new Error('anchor not found: ' + JSON.stringify(find.slice(0, 120)));
    out = out.split(find).join(replace);
  }
  const p = path.join(os.tmpdir(), '_p86_jobdel_mutant_' + process.pid + '_'
    + Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, absolutizeRequires(out, path.dirname(file)), 'utf8');
  mutantPaths.push(p);
  return require(p);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * THE FIXTURE IS TELLING THE TRUTH
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the fixture', () => {
  test('server/db.js really cascades a job delete into its service tickets', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server', 'db.js'), 'utf8').replace(/\r\n/g, '\n');
    // Concatenated so test/schema-truth.test.js's fixture scanner does not read
    // this probe as a table this file declares.
    const at = src.indexOf(['CREATE', 'TABLE IF NOT EXISTS', 'service_tickets ('].join(' '));
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 600)).toMatch(/job_id\s+TEXT REFERENCES jobs\(id\)\s+ON DELETE CASCADE/);
  });

  test('the emulated cascade fires, so a missing guard would show as missing tickets', () => {
    eng.db.exec("DELETE FROM jobs WHERE id = 'j_open'");
    expect(ticketIds('j_open')).toEqual([]);
  });

  test('the mutation harness throws on an anchor that is not in the file', () => {
    expect(() => mutant(JOB_ROUTES, [['this string is nowhere in the routes', 'x']])).toThrow(/anchor not found/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * DELETE /api/jobs/:id
 * ══════════════════════════════════════════════════════════════════════════*/
describe('an open work order blocks the delete', () => {
  test('409 OPEN_TICKETS with the exact sentence; the job and every ticket remain', async () => {
    const r = await del(jobRouter, ADMIN, 'j_open');
    expect(r.statusCode).toBe(409);
    expect(r.body).toEqual({
      error: 'This job has 1 open service ticket. Close or archive it before deleting the job.',
      code: 'OPEN_TICKETS',
      openTicketCount: 1,
    });
    expect(jobExists('j_open')).toBe(true);
    expect(ticketIds('j_open')).toEqual(['t_live', 't_open_done']);
  });

  test('confirming a closed count does not get past an open ticket', async () => {
    const r = await del(jobRouter, ADMIN, 'j_open', { confirm_closed_tickets: '1' });
    expect(r.statusCode).toBe(409);
    expect(r.body.code).toBe('OPEN_TICKETS');
    expect(ticketIds('j_open')).toEqual(['t_live', 't_open_done']);
  });

  test('plural wording', async () => {
    eng.db.exec("UPDATE service_tickets SET status = 'scheduled' WHERE id = 't_open_done'");
    const r = await del(jobRouter, ADMIN, 'j_open');
    expect(r.body.error).toBe('This job has 2 open service tickets. Close or archive them before deleting the job.');
    expect(r.body.openTicketCount).toBe(2);
  });

  test('MUTANT: without the open check the live ticket is cascaded away', async () => {
    const mut = mutant(JOB_ROUTES, [['    if (openTickets > 0) {\n', '    if (false) {\n']]);
    const r = await del(mut, ADMIN, 'j_open', { confirm_closed_tickets: '1' });
    expect(r.statusCode).toBe(200);
    expect(jobExists('j_open')).toBe(false);
    expect(ticketIds('j_open')).toEqual([]);   // t_live, mid-job, gone
  });
});

describe('closed, cancelled or archived work orders need the exact count echoed back', () => {
  test('no confirmation: 409 CLOSED_TICKETS with the counts, archived winning over status', async () => {
    const r = await del(jobRouter, ADMIN, 'j_retired');
    expect(r.statusCode).toBe(409);
    expect(r.body).toEqual({
      error: 'This job has 3 closed, cancelled or archived service tickets. Deleting the job deletes them too, with their approval history, timeline and crew links.',
      code: 'CLOSED_TICKETS',
      tickets: { total: 3, closed: 1, cancelled: 1, archived: 1 },
    });
    expect(jobExists('j_retired')).toBe(true);
    expect(ticketIds('j_retired')).toEqual(['t_arch', 't_cancel', 't_closed']);
    expect(auditRows()).toEqual([]);
  });

  test('a stale count (2 of 3) is refused and nothing changes', async () => {
    const r = await del(jobRouter, ADMIN, 'j_retired', { confirm_closed_tickets: '2' });
    expect(r.statusCode).toBe(409);
    expect(r.body.code).toBe('CLOSED_TICKETS');
    expect(r.body.tickets.total).toBe(3);
    expect(jobExists('j_retired')).toBe(true);
    expect(ticketIds('j_retired')).toHaveLength(3);
  });

  test('a junk count is refused', async () => {
    const r = await del(jobRouter, ADMIN, 'j_retired', { confirm_closed_tickets: 'all' });
    expect(r.statusCode).toBe(409);
    expect(r.body.code).toBe('CLOSED_TICKETS');
  });

  test('the exact count (3): 200, the tickets are gone, and an audit row names them', async () => {
    const r = await del(jobRouter, ADMIN, 'j_retired', { confirm_closed_tickets: '3' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(jobExists('j_retired')).toBe(false);
    expect(ticketIds('j_retired')).toEqual([]);
    await flush();
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      target_type: 'job', target_id: 'j_retired', organization_id: 1, actor_user_id: ADMIN, outcome: 'ok',
    });
    const detail = typeof rows[0].detail === 'string' ? JSON.parse(rows[0].detail) : rows[0].detail;
    expect(detail).toEqual({ ticket_ids: ['t_closed', 't_cancel', 't_arch'], closed: 1, cancelled: 1, archived: 1 });
  });

  test('singular wording', async () => {
    const r = await del(jobRouter, ADMIN, 'j_shared');
    expect(r.body.error).toBe('This job has 1 closed, cancelled or archived service ticket. Deleting the job deletes it too, with its approval history, timeline and crew links.');
  });

  test('MUTANT: without the count check, closed tickets go with no confirmation', async () => {
    const mut = mutant(JOB_ROUTES, [[
      'if (retired.total > 0 && Number(req.query && req.query.confirm_closed_tickets) !== retired.total) {',
      'if (false) {']]);
    const r = await del(mut, ADMIN, 'j_retired');
    expect(r.statusCode).toBe(200);
    expect(ticketIds('j_retired')).toEqual([]);
  });

  test('MUTANT: without the after-COMMIT audit call, there is no row', async () => {
    const mut = mutant(JOB_ROUTES, [['    if (retired.total) {\n      auditLog(req, {\n', '    if (false) {\n      auditLog(req, {\n']]);
    const r = await del(mut, ADMIN, 'j_retired', { confirm_closed_tickets: '3' });
    expect(r.statusCode).toBe(200);
    await flush();
    expect(auditRows()).toEqual([]);
  });
});

describe('a job with no work orders deletes as before', () => {
  test('200, no audit row, and the estimate and lead are un-stranded', async () => {
    const r = await del(jobRouter, ADMIN, 'j_clean');
    expect(r.statusCode).toBe(200);
    expect(jobExists('j_clean')).toBe(false);
    await flush();
    expect(auditRows()).toEqual([]);
    const est = eng.all("SELECT is_locked, data FROM estimates WHERE id = 'e_clean'")[0];
    expect(Number(est.is_locked)).toBe(0);
    expect(est.data).toEqual({ status: 'accepted', name: 'Clean est' });
    expect(eng.all("SELECT status FROM leads WHERE id = 'l_clean'")[0].status).toBe('in_progress');
  });

  test('a non-admin is still refused before anything is read', async () => {
    const r = await del(jobRouter, PM, 'j_clean');
    expect(r.statusCode).toBe(403);
    expect(jobExists('j_clean')).toBe(true);
  });
});

describe('another organization is never counted and never reachable', () => {
  test("rows in another org pointing at this job id count for nothing: 1 closed, not 1 open + 2 closed", async () => {
    const r = await del(jobRouter, ADMIN, 'j_shared');
    expect(r.statusCode).toBe(409);
    expect(r.body.code).toBe('CLOSED_TICKETS');
    expect(r.body.tickets).toEqual({ total: 1, closed: 1, cancelled: 0, archived: 0 });
    const ok = await del(jobRouter, ADMIN, 'j_shared', { confirm_closed_tickets: '1' });
    expect(ok.statusCode).toBe(200);
    await flush();
    const detail = auditRows()[0].detail;
    expect((typeof detail === 'string' ? JSON.parse(detail) : detail).ticket_ids).toEqual(['t_shared']);
  });

  test("another org's job is a 404, and its open ticket stays", async () => {
    const r = await del(jobRouter, ADMIN, 'j_rival');
    expect(r.statusCode).toBe(404);
    expect(ticketIds('j_rival')).toEqual(['t_rival']);
  });

  test('MUTANT: without the organization predicate the other org\'s open ticket blocks this delete', async () => {
    // The guard is loaded by job-routes, so the mutant guard is chained in by
    // rewriting that one require in a copy of the route.
    const guardMut = mutant(GUARD, [[
      "      WHERE job_id = ANY($1::text[])\n        AND organization_id = $2\n        AND archived_at IS NULL",
      "      WHERE job_id = ANY($1::text[])\n        AND $2 IS NOT NULL\n        AND archived_at IS NULL"]]);
    const guardPath = mutantPaths[mutantPaths.length - 1];
    expect(typeof guardMut.openTicketsOnJobs).toBe('function');
    const mut = mutant(JOB_ROUTES, [[
      "require('../services/job-ticket-guard')",
      'require(' + JSON.stringify(guardPath.split(path.sep).join('/')) + ')']]);
    const r = await del(mut, ADMIN, 'j_shared', { confirm_closed_tickets: '1' });
    expect(r.statusCode).toBe(409);
    expect(r.body.code).toBe('OPEN_TICKETS');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE GUARD MODULE ITSELF
 * ══════════════════════════════════════════════════════════════════════════*/
describe('services/job-ticket-guard', () => {
  const guard = require('../server/services/job-ticket-guard');

  test('openTicketsOnJobs counts only open, unarchived tickets in the org', async () => {
    expect(await guard.openTicketsOnJobs(eng.pool, ['j_open', 'j_retired', 'j_shared'], 1)).toBe(1);
    expect(await guard.openTicketsOnJobs(eng.pool, ['j_shared'], 2)).toBe(1);
    expect(await guard.openTicketsOnJobs(eng.pool, [], 1)).toBe(0);
  });

  test('retiredTicketsOnJobs: archived wins over status, ids in creation order', async () => {
    expect(await guard.retiredTicketsOnJobs(eng.pool, ['j_retired'], 1)).toEqual({
      total: 3, closed: 1, cancelled: 1, archived: 1, ids: ['t_closed', 't_cancel', 't_arch'],
    });
    expect(await guard.retiredTicketsOnJobs(eng.pool, null, 1)).toEqual({
      total: 0, closed: 0, cancelled: 0, archived: 0, ids: [],
    });
  });

  test('MUTANT: status read before archived counts an archived closed ticket as closed', async () => {
    const mut = mutant(GUARD, [[
      "    if (r.archived_at != null) out.archived++;\n    else if (r.status === 'cancelled') out.cancelled++;\n    else out.closed++;",
      "    if (r.status === 'closed') out.closed++;\n    else if (r.status === 'cancelled') out.cancelled++;\n    else out.archived++;"]]);
    const got = await mut.retiredTicketsOnJobs(eng.pool, ['j_retired'], 1);
    // The shipped answer above is {closed:1, cancelled:1, archived:1}.
    expect(got).toMatchObject({ total: 3, closed: 2, cancelled: 1, archived: 0 });
  });

  test('the lead delete chain uses the same guard, not a copy', () => {
    const lead = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'lead-routes.js'), 'utf8');
    expect(lead).toMatch(/const \{ openTicketsOnJobs \} = require\('\.\.\/services\/job-ticket-guard'\);/);
    expect(lead).not.toMatch(/async function openTicketsOnJobs\(/);
    // Its two call sites are unchanged. (lead-routes is not required here: it
    // arms a 12 s geocode backfill timer at load that would outlive the engine.)
    expect((lead.match(/await openTicketsOnJobs\((client|pool), jobIds, orgId\)/g) || []).length).toBe(2);
    expect(typeof guard.openTicketsOnJobs).toBe('function');
  });

  test('message builders', () => {
    expect(guard.openTicketsMessage(2)).toBe('This job has 2 open service tickets. Close or archive them before deleting the job.');
    expect(guard.closedTicketsMessage(4)).toBe('This job has 4 closed, cancelled or archived service tickets. Deleting the job deletes them too, with their approval history, timeline and crew links.');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE LOCK ORDER — JOBS FIRST, THEN THE WORK ORDERS IN SORTED id ORDER
 *
 * This delete takes two kinds of row lock, and both are load-bearing:
 *
 *   - jobs FOR UPDATE, FIRST. FOR UPDATE conflicts with the FOR KEY SHARE that
 *     an INSERT INTO service_tickets takes on the jobs row for its job_id FK,
 *     which is exactly what "no new ticket can attach to a locked job" means.
 *     Weaken it and a work order created in the gap is never row-locked, so it
 *     can be opened between the OPEN_TICKETS count and the DELETE and then get
 *     cascaded away — the guard above defeated.
 *   - service_tickets FOR UPDATE, SECOND, and ORDER BY id. Nothing reads that
 *     result set; the ORDER BY is the lock discipline. Unordered, the rows are
 *     taken in Postgres heap order, while every other door that locks more than
 *     one work order walks them sorted (services/service-ticket-subtask-door.js
 *     lockTickets: "Tickets are always locked in sorted id order, so two
 *     requests moving tasks between the same two tickets cannot deadlock").
 *     Two orders over one row set is a cycle, and Postgres answers 40P01.
 *
 * sqlite has no row locks and the shim strips FOR UPDATE, so what is pinned
 * here is the statement the route ISSUES: which rows, in which order, in which
 * mode, under which organization predicate.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the lock order', () => {
  const JOB_LOCK = 'SELECT estimate_id, lead_id FROM jobs WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL) FOR UPDATE';
  const TICKET_LOCK = 'SELECT id FROM service_tickets WHERE job_id = $1 AND organization_id = $2 ORDER BY id FOR UPDATE';
  const at = (log, sql) => log.findIndex((e) => e.sql === sql);

  function recordedDelete(router) {
    return recordSql(async () => {
      const r = await del(router || jobRouter, ADMIN, 'j_retired', { confirm_closed_tickets: '3' });
      expect([r.statusCode, r.body]).toEqual([200, { ok: true }]);
    });
  }

  test('BEGIN, the job row, then its work orders, then the DELETE and COMMIT', async () => {
    const log = await recordedDelete();
    const begin = at(log, 'BEGIN');
    const job = at(log, JOB_LOCK);
    const tickets = at(log, TICKET_LOCK);
    const commit = at(log, 'COMMIT');
    expect(begin).toBeGreaterThan(-1);
    expect(job).toBe(begin + 1);
    expect(tickets).toBeGreaterThan(job);
    expect(commit).toBeGreaterThan(tickets);
    // Both are scoped to this job and this organization.
    expect(log[job].params).toEqual(['j_retired', 1]);
    expect(log[tickets].params).toEqual(['j_retired', 1]);
  });

  test('the work-order lock is ordered by id, and the job lock is FOR UPDATE', async () => {
    const log = await recordedDelete();
    expect(log[at(log, TICKET_LOCK)].sql).toMatch(/ORDER BY id FOR UPDATE$/);
    // FOR UPDATE, not a weaker mode: see the block comment above.
    expect(log[at(log, JOB_LOCK)].sql).toMatch(/ FOR UPDATE$/);
    expect(log[at(log, JOB_LOCK)].sql).not.toMatch(/FOR (KEY SHARE|NO KEY UPDATE|SHARE)/);
  });

  test('MUTANT: without ORDER BY the work orders are locked in heap order', async () => {
    const mut = mutant(JOB_ROUTES, [[TICKET_LOCK, TICKET_LOCK.replace(' ORDER BY id', '')]]);
    const log = await recordedDelete(mut);
    // The delete still lands — this never was a visible-behaviour bug. The
    // ORDER is the whole defect, and without it the discipline is broken.
    expect(jobExists('j_retired')).toBe(false);
    expect(at(log, TICKET_LOCK)).toBe(-1);
    expect(log.some((e) => /FROM service_tickets WHERE job_id = \$1 AND organization_id = \$2 FOR UPDATE$/.test(e.sql))).toBe(true);
  });

  test('the sorted-id rule is the one the punch-list door already states', () => {
    const door = fs.readFileSync(path.join(ROOT, 'server', 'services', 'service-ticket-subtask-door.js'), 'utf8');
    expect(door).toMatch(/Tickets are always locked in sorted id order/);
    // lockTickets sorts the ids before it walks them; this delete now sorts in
    // SQL. Two doors, one order, no cycle.
    expect(door).toMatch(/\.map\(String\)\)\)\.sort\(\)/);
  });

  test('the change-order door agrees: it takes this job row BEFORE the work order', () => {
    // The other half of the pair. startChangeOrder used to lock the work order
    // first and reach the jobs row only at COMMIT, through the
    // job_change_orders.job_id FK — the opposite order to this delete. It now
    // takes the jobs row first, in the FK's own FOR KEY SHARE mode.
    const co = fs.readFileSync(path.join(ROOT, 'server', 'services', 'service-ticket-change-order.js'), 'utf8');
    const jobsAt = co.indexOf("'SELECT 1 FROM jobs WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL) FOR KEY SHARE'");
    const ticketAt = co.indexOf("'SELECT id, status, archived_at, job_id FROM service_tickets WHERE id = $1 AND organization_id = $2 FOR UPDATE'");
    expect(jobsAt).toBeGreaterThan(-1);
    expect(ticketAt).toBeGreaterThan(jobsAt);
  });
});
