// THE OFFICE STATUS DOOR (1.29) — ONE EXECUTOR, EXECUTED.
//
// POST /api/service-tickets/:id/status now runs every move through
// server/services/work-order-review.js changeStatus:
//   * a stale screen (expected_status) is told to reload, BEFORE the lattice;
//   * cancel, send back, reopen and taking back an approval need a reason,
//     stored as status_changed.detail.note;
//   * approve / cancel record who and when (in-org users only);
//   * a send-back reopens the chosen buildings, notes each one, and emails the
//     crew link's address;
//   * Work complete with subtasks still open is refused unless the office
//     overrides, and the count is taken inside the ticket's row lock;
//   * the UPDATE is guarded on the status this request saw, so a concurrent
//     move is a 409 with nothing written and nobody notified.
// GET /:id carries `review` (approved_by_name, cancelled_by_name, send_back)
// and `site_photos`, both best-effort.
//
// The REAL router runs over node:sqlite through the pg shim with a signed JWT,
// the same drive as test/service-ticket-route-access.test.js. Then each guard
// is removed from a temp copy of work-order-review.js (loaded by a temp copy of
// the routes) and the same drive goes red.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const TICKET_ROUTES = path.join(__dirname, '..', 'server', 'routes', 'service-ticket-routes.js');
const REVIEW = path.join(__dirname, '..', 'server', 'services', 'work-order-review.js');

const TABLES = [
  'organizations', 'users', 'roles', 'jobs', 'job_access', 'leads', 'tasks', 'attachments',
  'service_tickets', 'service_ticket_events', 'service_ticket_shares',
  'service_ticket_revisions', 'service_ticket_participants', 'service_ticket_flags',
];

const WIDE = 10;
const CREW = 20;
const RIVAL = 50;
const ACTAS = 70;   // a token that says org 1 for a users row that lives in org 2

const USERS = {
  [WIDE]: { role: 'st_wide', org: 1, name: 'Paula PM' },
  [CREW]: { role: 'st_crew', org: 1, name: 'Carl Crew' },
  [RIVAL]: { role: 'st_wide', org: 2, name: 'Rival Ray' },
  [ACTAS]: { role: 'st_wide', org: 1, name: 'Platform Pat' },
};

let eng;
let auth;
let db;
let ticketRouter;
let notify;
let notices;
let approvalCalls;
let sentBackCalls;
let realApproval;
let realSentBack;
const made = [];

function seed() {
  const caps = (list) => "'" + JSON.stringify(list) + "'";
  const exp = new Date(Date.now() + 7 * 86400000).toISOString();
  eng.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM roles; DELETE FROM jobs;
    DELETE FROM job_access; DELETE FROM leads; DELETE FROM tasks; DELETE FROM attachments;
    DELETE FROM service_tickets; DELETE FROM service_ticket_events; DELETE FROM service_ticket_shares;
    DELETE FROM service_ticket_revisions; DELETE FROM service_ticket_participants;
    DELETE FROM service_ticket_flags;

    INSERT INTO organizations (id, name) VALUES (1, 'AGX'), (2, 'Rival Co');
    INSERT INTO roles (name, capabilities) VALUES
      ('st_wide', ${caps(['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'LEADS_VIEW', 'LEADS_EDIT'])}),
      ('st_crew', ${caps(['JOBS_VIEW_ASSIGNED', 'JOBS_EDIT_OWN'])});
    INSERT INTO users (id, name, email, role, organization_id, active) VALUES
      (10, 'Paula PM', 'p@agx.test', 'st_wide', 1, 1),
      (20, 'Carl Crew', 'c@agx.test', 'st_crew', 1, 1),
      (50, 'Rival Ray', 'r@rival.test', 'st_wide', 2, 1),
      (70, 'Platform Pat', 'pat@platform.test', 'st_wide', 2, 1);
    INSERT INTO jobs (id, owner_id, data, organization_id) VALUES
      ('j1', 10, '{}', 1), ('j9', 50, '{}', 2);
    INSERT INTO job_access (job_id, user_id, access_level) VALUES ('j1', 20, 'edit');

    INSERT INTO service_tickets (id, organization_id, title, job_id, status, priority, checklist,
        scope_proposed, scope_approved, approval_notified_at, approval_notice_attempts,
        approved_at, approved_by, cancelled_at, cancelled_by, created_at) VALUES
      ('st_open', 1, 'Open one',       'j1', 'open',          'normal', '[]', NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, '2026-09-01 10:00:01'),
      ('st_ip',   1, 'Two buildings',  'j1', 'in_progress',   'normal', '[]', NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, '2026-09-01 10:00:02'),
      ('st_ip0',  1, 'No buildings',   'j1', 'in_progress',   'normal', '[]', NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, '2026-09-01 10:00:03'),
      ('st_done', 1, 'All done',       'j1', 'in_progress',   'normal', '[]', NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, '2026-09-01 10:00:04'),
      ('st_wc',   1, 'Rail repair',    'j1', 'work_complete', 'normal', '[]', 'Replace the loose rail posts.', NULL, '2026-09-10 09:00:00', 0, NULL, NULL, NULL, NULL, '2026-09-01 10:00:05'),
      ('st_wc2',  1, 'Blank scope',    'j1', 'work_complete', 'normal', '[]', '   ', 'SIGNED OFF TEXT', NULL, 0, NULL, NULL, NULL, NULL, '2026-09-01 10:00:06'),
      ('st_ap',   1, 'Approved one',   'j1', 'approved',      'normal', '[]', NULL, NULL, NULL, 0, '2026-09-11 09:00:00', 10, NULL, NULL, '2026-09-01 10:00:07'),
      ('st_cl',   1, 'Closed one',     'j1', 'closed',        'normal', '[]', NULL, NULL, NULL, 0, '2026-09-11 09:00:00', 10, NULL, NULL, '2026-09-01 10:00:08'),
      ('st_ca',   1, 'Cancelled one',  'j1', 'cancelled',     'normal', '[]', NULL, NULL, NULL, 0, NULL, NULL, '2026-09-11 09:00:00', 10, '2026-09-01 10:00:09'),
      ('st_x',    1, 'Other ticket',   'j1', 'work_complete', 'normal', '[]', NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, '2026-09-01 10:00:10'),
      ('st_b',    2, 'RIVAL ticket',   'j9', 'work_complete', 'normal', '[]', NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, '2026-09-01 10:00:11');

    INSERT INTO tasks (id, organization_id, title, status, scope, owner_user_id, service_ticket_id, entity_type, entity_id, created_at) VALUES
      ('k_a',   1, 'Bldg 1', 'done', 'org', NULL, 'st_ip',   'job', 'j1', '2026-09-02 08:00:01'),
      ('k_b',   1, 'Bldg 2', 'open', 'org', NULL, 'st_ip',   'job', 'j1', '2026-09-02 08:00:02'),
      ('k_c1',  1, 'Bldg 3', 'done', 'org', NULL, 'st_done', 'job', 'j1', '2026-09-02 08:00:03'),
      ('k_c2',  1, 'Bldg 4', 'done', 'org', NULL, 'st_done', 'job', 'j1', '2026-09-02 08:00:04'),
      ('k_w1',  1, 'Bldg 784 — Side A', 'done', 'org', NULL, 'st_wc', 'job', 'j1', '2026-09-02 08:00:05'),
      ('k_w2',  1, 'Bldg 790',          'done', 'org', NULL, 'st_wc', 'job', 'j1', '2026-09-02 08:00:06'),
      ('k_w3',  1, 'Bldg 800',          'open', 'org', NULL, 'st_wc', 'job', 'j1', '2026-09-02 08:00:07'),
      ('k_pers',1, 'PM private to-do',  'done', 'personal', 10, 'st_wc', 'job', 'j1', '2026-09-02 08:00:08'),
      ('k_ap',  1, 'Bldg 900',          'open', 'org', NULL, 'st_ap', 'job', 'j1', '2026-09-02 08:00:09'),
      ('k_x',   1, 'Bldg on another ticket', 'done', 'org', NULL, 'st_x', 'job', 'j1', '2026-09-02 08:00:10'),
      ('k_rv',  2, 'Rival bldg',        'done', 'org', NULL, 'st_b', 'job', 'j9', '2026-09-02 08:00:11');

    INSERT INTO service_ticket_events (id, organization_id, ticket_id, kind, actor_kind, actor_label, detail) VALUES
      ('ste_seed_1', 1, 'st_wc', 'subtask_completed', 'share', 'Jose', '{"task_id":"k_w1","title":"Bldg 784 — Side A"}');

    INSERT INTO service_ticket_shares (id, organization_id, ticket_id, token_hash, scope, recipient_email, recipient_name, expires_at, view_count, created_at) VALUES
      ('sh_wc', 1, 'st_wc', 'hash_wc', 'respond', 'jose@crew.test', 'Jose', '${exp}', 0, '2026-09-03 09:00:00');

    -- Crew problems. 'flg_tw' is an org-2 row pointing at the SAME ticket id:
    -- only the org predicate inside resolveOpenFlagsOnClose keeps it out.
    INSERT INTO service_ticket_flags (id, organization_id, ticket_id, task_id, share_id, author_label,
        category, note, attachment_ids, status, resolved_by, resolved_at, resolution_note, client_ref, created_at) VALUES
      ('flg_ap1', 1, 'st_ap',   'k_ap', NULL, 'Jose',  'no_access', 'Gate locked, SECRET crew words', '[]', 'open',     NULL, NULL, NULL, NULL, '2026-09-10 08:00:01'),
      ('flg_ap2', 1, 'st_ap',   NULL,   NULL, 'Jose',  'safety',    'Loose rail post',                '[]', 'open',     NULL, NULL, NULL, NULL, '2026-09-10 08:00:02'),
      ('flg_ap3', 1, 'st_ap',   NULL,   NULL, 'Jose',  'other',     'Handled on site',                '[]', 'resolved', 10,   '2026-09-10 09:00:00', 'Sorted earlier', NULL, '2026-09-10 08:00:03'),
      ('flg_op',  1, 'st_open', NULL,   NULL, 'Marco', 'no_access', 'Nobody on site',                 '[]', 'open',     NULL, NULL, NULL, NULL, '2026-09-10 08:00:04'),
      ('flg_wc',  1, 'st_wc',   'k_w3', NULL, 'Jose',  'extra_damage', 'Panel cracked',               '[]', 'open',     NULL, NULL, NULL, NULL, '2026-09-10 08:00:05'),
      ('flg_x',   1, 'st_x',    NULL,   NULL, 'Jose',  'no_access', 'Another work order',             '[]', 'open',     NULL, NULL, NULL, NULL, '2026-09-10 08:00:06'),
      ('flg_tw',  2, 'st_ap',   NULL,   NULL, 'Ray',   'no_access', 'RIVAL row, same ticket id',      '[]', 'open',     NULL, NULL, NULL, NULL, '2026-09-10 08:00:07');
  `);
}

beforeAll(async () => {
  eng = createPgSqlite(sqliteSchema(TABLES), {
    jsonColumns: ['checklist', 'capabilities', 'detail', 'fields', 'data', 'tags'],
  });
  db = require('../server/db');
  db.pool.query = eng.pool.query;
  db.pool.connect = eng.pool.connect;
  auth = require('../server/auth');
  auth.setRolePool(eng.pool);
  seed();
  await auth.refreshRoleCache();
  ticketRouter = require('../server/routes/service-ticket-routes');
  notify = require('../server/services/service-ticket-notify');
  notices = require('../server/services/work-order-notices');
});

const flush = () => new Promise((r) => setTimeout(r, 25));

beforeEach(() => {
  seed();
  approvalCalls = [];
  sentBackCalls = [];
  realApproval = notify.notifyAwaitingApproval;
  realSentBack = notices.notifySentBack;
  notify.notifyAwaitingApproval = async (pool, opts) => { approvalCalls.push(opts); return { sent: 0 }; };
  notices.notifySentBack = async (pool, opts) => { sentBackCalls.push(opts); return { sent: 1, failed: 0 }; };
  db.pool.query = eng.pool.query;
  db.pool.connect = eng.pool.connect;
});

afterEach(async () => {
  await flush();
  jest.restoreAllMocks();
  notify.notifyAwaitingApproval = realApproval;
  notices.notifySentBack = realSentBack;
  db.pool.query = eng.pool.query;
  db.pool.connect = eng.pool.connect;
});

afterAll(async () => {
  await flush();
  db.pool.query = async () => ({ rows: [], rowCount: 0 });
  if (eng) eng.close();
  for (const p of made) {
    try { delete require.cache[require.resolve(p)]; } catch (_) { /* never loaded */ }
    try { fs.unlinkSync(p); } catch (_) { /* already gone */ }
  }
});

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
  return auth.signToken({ id: uid, email: uid + '@t.test', name: u.name, role: u.role, organization_id: u.org });
}

async function drive(router, method, routePath, opts) {
  const o = opts || {};
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error('route not declared: ' + method + ' ' + routePath);
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
  for (const h of layer.route.stack.map((s) => s.handle)) {
    let advanced = false;
    await h(req, res, (err) => { if (err) throw err; advanced = true; });
    if (!advanced) break;
  }
  return res;
}

const move = (router, id, body, as) => drive(router, 'post', '/:id/status', { as: as || WIDE, params: { id }, body });
const archive = (router, id, as) => drive(router, 'delete', '/:id', { as: as || WIDE, params: { id } });
const readTicket = (router, id, as) => drive(router, 'get', '/:id', { as: as || WIDE, params: { id } });
const row = (id) => eng.all('SELECT * FROM service_tickets WHERE id = ? AND organization_id = 1', id)[0];
const task = (id, org) => eng.all('SELECT * FROM tasks WHERE id = ? AND organization_id = ?', id, org || 1)[0];
const events = (ticketId) => eng.all('SELECT kind, actor_user_id, detail FROM service_ticket_events WHERE ticket_id = ? ORDER BY rowid', ticketId);
const statusEvents = (ticketId) => events(ticketId).filter((e) => e.kind === 'status_changed');
const flag = (id) => eng.all('SELECT * FROM service_ticket_flags WHERE id = ?', id)[0];
const openFlagIds = () => eng.all("SELECT id FROM service_ticket_flags WHERE status = 'open' ORDER BY id").map((r) => r.id);
const allEvents = () => eng.count('SELECT 1 FROM service_ticket_events');

// Interleave: run `sql` on the engine right before (or after) the first
// statement matching `re` that a transaction client runs.
function interleave(re, sql, when) {
  let fired = false;
  db.pool.connect = async () => {
    const c = await eng.pool.connect();
    return {
      query: async (text, params) => {
        const hit = !fired && re.test(String(text));
        if (hit && when !== 'after') { fired = true; eng.db.exec(sql); }
        const out = await c.query(text, params);
        if (hit && when === 'after') { fired = true; eng.db.exec(sql); }
        return out;
      },
      release: () => c.release(),
    };
  };
  return () => fired;
}

// ── mutants: a temp copy of work-order-review.js, loaded by a temp routes copy ──
function absolutize(src, fromDir) {
  return src.replace(/require\((['"])([^'"]+)\1\)/g, (_m, _q, spec) => {
    const resolved = spec.charAt(0) === '.'
      ? require.resolve(path.resolve(fromDir, spec))
      : require.resolve(spec, { paths: [fromDir] });
    return 'require(' + JSON.stringify(resolved.split(path.sep).join('/')) + ')';
  });
}

function writeCopy(file, edits, redirects) {
  let src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  for (const [find, replace] of edits) {
    if (src.split(find).length !== 2) throw new Error('anchor not found');
    src = src.split(find).join(replace);
  }
  src = absolutize(src, path.dirname(file));
  for (const [from, to] of Object.entries(redirects || {})) {
    const ref = 'require(' + JSON.stringify(from.split(path.sep).join('/')) + ')';
    if (src.split(ref).length < 2) throw new Error('anchor not found');
    src = src.split(ref).join('require(' + JSON.stringify(to.split(path.sep).join('/')) + ')');
  }
  const p = path.join(os.tmpdir(), '_p86_wors_' + process.pid + '_' + Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, src, 'utf8');
  made.push(p);
  return p;
}

function reviewMutant(edits) {
  const copy = writeCopy(REVIEW, edits);
  return require(writeCopy(TICKET_ROUTES, [], { [require.resolve(REVIEW)]: copy }));
}

// The archive door lives in the ROUTES file, not the executor, so its guard is
// removed from a copy of the routes themselves.
const routesMutant = (edits) => require(writeCopy(TICKET_ROUTES, edits));

/* ═══════════════════════════════════════════════════════════════════════════
 * THE MUTATION HARNESS, FIRST
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the mutation harness', () => {
  test('an anchor that is not in the file throws', () => {
    expect(() => reviewMutant([['this text is nowhere in the executor', 'x']])).toThrow('anchor not found');
  });

  test('a loaded mutant is a different router over the same database and loads the mutated executor', async () => {
    const mut = reviewMutant([[
      "const STALE_ERROR = 'This work order just changed. Reload to see the latest.';",
      "const STALE_ERROR = 'MUTANT stale';"]]);
    expect(mut).not.toBe(ticketRouter);
    const r = await move(mut, 'st_ip', { status: 'work_complete', expected_status: 'open' });
    expect([r.statusCode, r.body.error]).toEqual([409, 'MUTANT stale']);
  });

  test('work-order-review.js is CRLF on disk, so the anchors are normalised', () => {
    expect(fs.readFileSync(REVIEW, 'utf8').indexOf('\r\n')).toBeGreaterThan(-1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * REASONS AND STAMPS
 * ══════════════════════════════════════════════════════════════════════════*/
describe('cancel', () => {
  test('without a reason is 400 and nothing moves; with one it records who, when and why', async () => {
    const before = allEvents();
    const r = await move(ticketRouter, 'st_open', { status: 'cancelled' });
    expect([r.statusCode, r.body]).toEqual([400, { error: 'Say why this work order is being cancelled.' }]);
    expect(row('st_open').status).toBe('open');
    expect(allEvents()).toBe(before);

    const ok = await move(ticketRouter, 'st_open', { status: 'cancelled', reason: '  Community pulled the work  ' });
    expect(ok.statusCode).toBe(200);
    expect(ok.body.ticket).toMatchObject({ id: 'st_open', status: 'cancelled', cancelled_by: WIDE });
    expect(ok.body.send_back).toBeUndefined();
    const stored = row('st_open');
    expect([stored.status, stored.cancelled_by]).toEqual(['cancelled', WIDE]);
    expect(stored.cancelled_at).not.toBeNull();
    expect(statusEvents('st_open').map((e) => [e.actor_user_id, e.detail])).toEqual([
      [WIDE, { from: 'open', to: 'cancelled', action: 'cancel', note: 'Community pulled the work' }],
    ]);
  });

  test('the legacy `note` body key is read when `reason` is absent', async () => {
    const r = await move(ticketRouter, 'st_open', { status: 'cancelled', note: 'old client' });
    expect(r.statusCode).toBe(200);
    expect(statusEvents('st_open')[0].detail.note).toBe('old client');
  });

  test('reopen_tasks on a cancel is 400 and nothing moves', async () => {
    const r = await move(ticketRouter, 'st_wc', { status: 'cancelled', reason: 'x', reopen_tasks: ['k_w1'] });
    expect([r.statusCode, r.body]).toEqual([400, { error: 'Buildings can only be reopened when sending work back.' }]);
    expect(row('st_wc').status).toBe('work_complete');
  });
});

describe('approve and take back an approval', () => {
  test('approve records who and when; copy_scope copies the proposed scope', async () => {
    const r = await move(ticketRouter, 'st_wc', { status: 'approved', expected_status: 'work_complete', copy_scope: true, reason: 'Looks right' });
    expect(r.statusCode).toBe(200);
    const stored = row('st_wc');
    expect([stored.status, stored.approved_by, stored.scope_approved]).toEqual(['approved', WIDE, 'Replace the loose rail posts.']);
    expect(stored.approved_at).not.toBeNull();
    expect(statusEvents('st_wc').map((e) => e.detail)).toEqual([
      { from: 'work_complete', to: 'approved', action: 'approve', note: 'Looks right', scope_copied: true },
    ]);
    // No reopen, no crew email, no approval notice on an approval.
    expect([approvalCalls.length, sentBackCalls.length]).toEqual([0, 0]);
  });

  test('a blank proposed scope never wipes the approved scope, and scope_copied is absent', async () => {
    const r = await move(ticketRouter, 'st_wc2', { status: 'approved', copy_scope: true });
    expect(r.statusCode).toBe(200);
    expect(row('st_wc2').scope_approved).toBe('SIGNED OFF TEXT');
    expect(statusEvents('st_wc2')[0].detail).toEqual({ from: 'work_complete', to: 'approved', action: 'approve' });
  });

  test('without copy_scope the approved scope is untouched', async () => {
    expect((await move(ticketRouter, 'st_wc', { status: 'approved' })).statusCode).toBe(200);
    expect(row('st_wc').scope_approved).toBeNull();
  });

  test('taking back an approval needs a reason, clears the stamps, and skips the open-buildings check', async () => {
    const bare = await move(ticketRouter, 'st_ap', { status: 'work_complete' });
    expect([bare.statusCode, bare.body]).toEqual([400, { error: 'Say why the approval is being taken back.' }]);
    expect(row('st_ap').approved_by).toBe(WIDE);

    // st_ap still has an open building (k_ap): no buildings_open on the way back.
    const r = await move(ticketRouter, 'st_ap', { status: 'work_complete', reason: 'Wrong building approved' });
    expect(r.statusCode).toBe(200);
    const stored = row('st_ap');
    expect([stored.status, stored.approved_by, stored.approved_at]).toEqual(['work_complete', null, null]);
    expect(statusEvents('st_ap')[0].detail).toEqual({ from: 'approved', to: 'work_complete', action: 'unapprove', note: 'Wrong building approved' });
    expect(approvalCalls).toHaveLength(1);
  });

  test('an act-as actor whose users row is in another org stores approved_by NULL', async () => {
    const r = await move(ticketRouter, 'st_wc', { status: 'approved' }, ACTAS);
    expect(r.statusCode).toBe(200);
    const stored = row('st_wc');
    expect([stored.status, stored.approved_by]).toEqual(['approved', null]);
    expect(stored.approved_at).not.toBeNull();
  });
});

describe('reopen', () => {
  test('closed -> open needs a reason and clears the approval and cancel stamps', async () => {
    const bare = await move(ticketRouter, 'st_cl', { status: 'open' });
    expect([bare.statusCode, bare.body]).toEqual([400, { error: 'Say why this work order is being reopened.' }]);
    const r = await move(ticketRouter, 'st_cl', { status: 'open', reason: 'Leak came back' });
    expect(r.statusCode).toBe(200);
    const stored = row('st_cl');
    expect([stored.status, stored.approved_by, stored.approved_at, stored.closed_at]).toEqual(['open', null, null, null]);
  });

  test('cancelled -> open clears cancelled_by and cancelled_at', async () => {
    expect((await move(ticketRouter, 'st_ca', { status: 'open', reason: 'Back on' })).statusCode).toBe(200);
    const stored = row('st_ca');
    expect([stored.status, stored.cancelled_by, stored.cancelled_at]).toEqual(['open', null, null]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * SEND BACK
 * ══════════════════════════════════════════════════════════════════════════*/
describe('send back', () => {
  const SEND_BACK = {
    status: 'in_progress',
    expected_status: 'work_complete',
    reason: 'Rail post on 784 is still loose.',
    reopen_tasks: [{ id: 'k_w1', note: 'Re-set the post' }, { id: 'k_w3', note: 'Not started' }],
  };

  test('needs a reason', async () => {
    const r = await move(ticketRouter, 'st_wc', { status: 'in_progress' });
    expect([r.statusCode, r.body]).toEqual([400, { error: 'Say what needs fixing. The crew sees this on their link.' }]);
    expect(row('st_wc').status).toBe('work_complete');
  });

  test('reopens only listed buildings that were done, notes each, clears the notice window and emails the link', async () => {
    const r = await move(ticketRouter, 'st_wc', SEND_BACK);
    expect(r.statusCode).toBe(200);
    expect(r.body.send_back).toEqual({ reopened: 1, crew_emailing: 1 });
    const stored = row('st_wc');
    expect([stored.status, stored.approval_notified_at, stored.completed_at]).toEqual(['in_progress', null, null]);
    expect([task('k_w1').status, task('k_w1').completed_at]).toEqual(['open', null]);
    expect(task('k_w2').status).toBe('done');
    expect(task('k_w3').status).toBe('open');

    const kinds = events('st_wc').filter((e) => e.kind !== 'subtask_completed');
    expect(kinds.map((e) => [e.kind, e.detail])).toEqual([
      ['subtask_reopened', { task_id: 'k_w1', title: 'Bldg 784 — Side A', via: 'send_back' }],
      ['subtask_note', { task_id: 'k_w1', note: 'Re-set the post', sent_back: true }],
      ['subtask_note', { task_id: 'k_w3', note: 'Not started', sent_back: true }],
      ['status_changed', {
        from: 'work_complete', to: 'in_progress', action: 'send_back', note: 'Rail post on 784 is still loose.',
        buildings: [
          { task_id: 'k_w1', title: 'Bldg 784 — Side A', note: 'Re-set the post', reopened: true },
          { task_id: 'k_w3', title: 'Bldg 800', note: 'Not started', reopened: false },
        ],
      }],
    ]);

    expect(sentBackCalls).toHaveLength(1);
    expect(sentBackCalls[0].recipients.map((x) => x.email)).toEqual(['jose@crew.test']);
    expect(sentBackCalls[0].sendBack.note).toBe('Rail post on 784 is still loose.');
    expect(sentBackCalls[0].ticket.status).toBe('in_progress');
    expect(approvalCalls).toHaveLength(0);

    const read = await readTicket(ticketRouter, 'st_wc');
    const k1 = read.body.tasks.find((t) => t.id === 'k_w1');
    expect([k1.status, k1.completed_by]).toEqual(['open', null]);
    expect(read.body.review.send_back).toMatchObject({
      note: 'Rail post on 784 is still loose.',
      buildings: [
        { id: 'k_w1', title: 'Bldg 784 — Side A', note: 'Re-set the post', reopened: true },
        { id: 'k_w3', title: 'Bldg 800', note: 'Not started', reopened: false },
      ],
    });
  });

  test('with no emailed link the answer says nobody is being emailed and no send starts', async () => {
    eng.db.exec("UPDATE service_ticket_shares SET scope = 'view' WHERE id = 'sh_wc'");
    const r = await move(ticketRouter, 'st_wc', { status: 'in_progress', reason: 'Redo it' });
    expect(r.statusCode).toBe(200);
    expect(r.body.send_back).toEqual({ reopened: 0, crew_emailing: 0 });
    expect(sentBackCalls).toHaveLength(0);
  });

  for (const [name, id] of [['another ticket', 'k_x'], ['another org', 'k_rv'], ['a personal to-do', 'k_pers'], ['no such task', 'k_nope']]) {
    test('a building from ' + name + ' is 400 and NOTHING is written', async () => {
      const before = allEvents();
      const r = await move(ticketRouter, 'st_wc', Object.assign({}, SEND_BACK, { reopen_tasks: ['k_w1', id] }));
      expect([r.statusCode, r.body]).toEqual([400, { error: 'One of those buildings is not on this work order.' }]);
      expect(row('st_wc').status).toBe('work_complete');
      expect([task('k_w1').status, task('k_x').status, task('k_rv', 2).status]).toEqual(['done', 'done', 'done']);
      expect(allEvents()).toBe(before);
      expect(sentBackCalls).toHaveLength(0);
    });
  }

  test('a malformed reopen list is 400', async () => {
    const r = await move(ticketRouter, 'st_wc', Object.assign({}, SEND_BACK, { reopen_tasks: 'k_w1' }));
    expect([r.statusCode, r.body]).toEqual([400, { error: 'Buildings to reopen must be a list.' }]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * STALE SCREENS AND CONCURRENT MOVES (A10)
 * ══════════════════════════════════════════════════════════════════════════*/
describe('stale screens and concurrent moves', () => {
  test('expected_status "open" while the row is in_progress: 409 status_changed, no event, no notice', async () => {
    const before = allEvents();
    const r = await move(ticketRouter, 'st_ip0', { status: 'work_complete', expected_status: 'open' });
    expect([r.statusCode, r.body]).toEqual([409, {
      error: 'This work order just changed. Reload to see the latest.', code: 'status_changed', current_status: 'in_progress',
    }]);
    expect(row('st_ip0').status).toBe('in_progress');
    expect(allEvents()).toBe(before);
    expect(approvalCalls).toHaveLength(0);
  });

  test('the stale check comes BEFORE the lattice: a move the stale screen offered reads "reload", not 403', async () => {
    // The row is now approved; the screen still thought Work complete and
    // offered In progress, which approved cannot do.
    const r = await move(ticketRouter, 'st_ap', { status: 'in_progress', expected_status: 'work_complete', reason: 'x' });
    expect([r.statusCode, r.body.code, r.body.current_status]).toEqual([409, 'status_changed', 'approved']);
    // Without expected_status the lattice still answers.
    const bare = await move(ticketRouter, 'st_ap', { status: 'in_progress', reason: 'x' });
    expect([bare.statusCode, bare.body]).toEqual([403, { error: 'A ticket cannot move from approved to in_progress.' }]);
  });

  test('the same status is a no-op: 200, no event', async () => {
    const before = allEvents();
    const r = await move(ticketRouter, 'st_open', { status: 'open', expected_status: 'open' });
    expect([r.statusCode, r.body.ok, r.body.ticket.id]).toEqual([200, true, 'st_open']);
    expect(allEvents()).toBe(before);
  });

  test('the row flips just before the guarded UPDATE: 409, no event, no notice', async () => {
    const fired = interleave(/^\s*UPDATE service_tickets SET status/i,
      "UPDATE service_tickets SET status = 'cancelled' WHERE id = 'st_ip0'");
    const before = allEvents();
    const r = await move(ticketRouter, 'st_ip0', { status: 'work_complete', expected_status: 'in_progress' });
    expect(fired()).toBe(true);
    expect([r.statusCode, r.body.code, r.body.error]).toEqual([409, 'status_changed', 'This work order just changed. Reload to see the latest.']);
    expect(row('st_ip0').status).not.toBe('work_complete');
    expect(allEvents()).toBe(before);
    expect(approvalCalls).toHaveLength(0);
  });

  test('a rival-org caller gets 404 on the status door and nothing moves', async () => {
    const r = await move(ticketRouter, 'st_open', { status: 'cancelled', reason: 'x' }, RIVAL);
    expect([r.statusCode, r.body]).toEqual([404, { error: 'Service ticket not found' }]);
    expect(row('st_open').status).toBe('open');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * WORK COMPLETE WITH BUILDINGS STILL OPEN (A1 office)
 * ══════════════════════════════════════════════════════════════════════════*/
describe('Work complete with subtasks still open', () => {
  test('2 subtasks, 1 done: 409 buildings_open with the count, nothing written', async () => {
    const before = allEvents();
    const r = await move(ticketRouter, 'st_ip', { status: 'work_complete', expected_status: 'in_progress' });
    expect([r.statusCode, r.body]).toEqual([409, {
      error: "1 of 2 subtasks isn't done yet.", code: 'buildings_open', open: 1, total: 2,
    }]);
    expect(row('st_ip').status).toBe('in_progress');
    expect(allEvents()).toBe(before);
    expect(approvalCalls).toHaveLength(0);
  });

  test('with override: 200, the event records the override and the count, one approval notice', async () => {
    const r = await move(ticketRouter, 'st_ip', { status: 'work_complete', expected_status: 'in_progress', override: true });
    expect(r.statusCode).toBe(200);
    expect(row('st_ip').status).toBe('work_complete');
    expect(statusEvents('st_ip').map((e) => e.detail)).toEqual([
      { from: 'in_progress', to: 'work_complete', override: 'buildings_open', open: 1, total: 2 },
    ]);
    expect(approvalCalls).toHaveLength(1);
    expect([approvalCalls[0].ticket.id, approvalCalls[0].reason, approvalCalls[0].actor.userId]).toEqual(['st_ip', 'office_moved', WIDE]);
  });

  test('override must be literally true', async () => {
    expect((await move(ticketRouter, 'st_ip', { status: 'work_complete', override: 'yes' })).statusCode).toBe(409);
  });

  test('every subtask done: no override needed, and no override recorded', async () => {
    expect((await move(ticketRouter, 'st_done', { status: 'work_complete' })).statusCode).toBe(200);
    expect(statusEvents('st_done')[0].detail).toEqual({ from: 'in_progress', to: 'work_complete' });
  });

  test('the count is taken inside the row lock: a building reopened just after the lock is seen', async () => {
    const fired = interleave(/FOR\s+UPDATE/i, "UPDATE tasks SET status = 'open' WHERE id = 'k_c2'", 'after');
    const r = await move(ticketRouter, 'st_done', { status: 'work_complete' });
    expect(fired()).toBe(true);
    expect([r.statusCode, r.body.code, r.body.open, r.body.total]).toEqual([409, 'buildings_open', 1, 2]);
    expect(approvalCalls).toHaveLength(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE READ
 * ══════════════════════════════════════════════════════════════════════════*/
describe('GET /:id review and site photos', () => {
  test('names who approved and who cancelled, from this org only', async () => {
    const ap = await readTicket(ticketRouter, 'st_ap');
    expect(ap.body.review).toEqual({ approved_by_name: 'Paula PM', cancelled_by_name: null, send_back: null });
    expect(ap.body.ticket).toMatchObject({ approved_by: WIDE, cancelled_by: null });
    const ca = await readTicket(ticketRouter, 'st_ca');
    expect(ca.body.review).toEqual({ approved_by_name: null, cancelled_by_name: 'Paula PM', send_back: null });
    expect(Array.isArray(ap.body.site_photos)).toBe(true);
  });

  test('the send-back banner is gone once the work arrives at Work complete again', async () => {
    expect((await move(ticketRouter, 'st_wc', { status: 'in_progress', reason: 'Redo 784', reopen_tasks: ['k_w1'] })).statusCode).toBe(200);
    expect((await readTicket(ticketRouter, 'st_wc')).body.review.send_back).toMatchObject({ note: 'Redo 784' });
    expect((await move(ticketRouter, 'st_wc', { status: 'work_complete', override: true })).statusCode).toBe(200);
    expect((await readTicket(ticketRouter, 'st_wc')).body.review.send_back).toBeNull();
  });

  test('site photos list the ticket\'s own images with who added them', async () => {
    eng.db.exec(`INSERT INTO attachments (id, entity_type, entity_id, filename, mime_type, tags, organization_id, uploaded_by, uploaded_at, position) VALUES
      ('a_site', 'service_ticket', 'st_wc', 'gate.jpg', 'image/jpeg', '[]', 1, 10, '2026-09-12 10:00:00', 0)`);
    const r = await readTicket(ticketRouter, 'st_wc');
    expect(r.body.site_photos.map((p) => [p.id, p.by, p.via_link])).toEqual([['a_site', 'Paula PM', false]]);
  });

  test('a failing review or site-photo read leaves them empty and the ticket still opens', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    db.pool.query = async (sql, params) => {
      const text = String(sql);
      if (/detail->>'action'/.test(text) || /entity_type = 'service_ticket'/.test(text)) throw new Error('boom');
      return eng.pool.query(sql, params);
    };
    const r = await readTicket(ticketRouter, 'st_ip0');
    expect(r.statusCode).toBe(200);
    expect(r.body.review).toEqual({ approved_by_name: null, cancelled_by_name: null, send_back: null });
    expect(r.body.site_photos).toEqual([]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * ENDING A WORK ORDER CLEARS THE CREW PROBLEMS STILL OPEN ON IT
 *
 * The office only gets a Resolve box while a ticket is still editable, so an
 * open flag left on a closed or cancelled work order could never be cleared
 * and kept the job's Service Tickets chip red for good. Closing and
 * cancelling now resolve them inside the same transaction as the move.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('open crew problems on a terminal move', () => {
  test('closing resolves this ticket\'s open flags, and nothing else', async () => {
    const r = await move(ticketRouter, 'st_ap', { status: 'closed' });
    expect(r.statusCode).toBe(200);
    expect(row('st_ap').status).toBe('closed');

    for (const id of ['flg_ap1', 'flg_ap2']) {
      const f = flag(id);
      expect([f.status, f.resolved_by, f.resolution_note])
        .toEqual(['resolved', WIDE, 'Closed with the work order.']);
      expect(f.resolved_at).toBeTruthy();
    }
    // An already-resolved flag keeps the words and the hand that closed it.
    expect([flag('flg_ap3').resolved_by, flag('flg_ap3').resolution_note]).toEqual([10, 'Sorted earlier']);
    // Another work order, another ticket of this job, and the rival org's row
    // on the SAME ticket id are all still open.
    expect(openFlagIds()).toEqual(['flg_op', 'flg_tw', 'flg_wc', 'flg_x']);
  });

  test('the flag lines are shape-only and land before the status line', async () => {
    expect((await move(ticketRouter, 'st_ap', { status: 'closed' })).statusCode).toBe(200);
    const ev = events('st_ap');
    expect(ev.map((e) => e.kind)).toEqual(['flag_resolved', 'flag_resolved', 'status_changed']);
    const resolved = ev.filter((e) => e.kind === 'flag_resolved');
    expect(resolved.map((e) => e.actor_user_id)).toEqual([WIDE, WIDE]);
    expect(resolved.map((e) => e.detail).sort((a, b) => (a.flag_id < b.flag_id ? -1 : 1))).toEqual([
      { flag_id: 'flg_ap1', category: 'no_access', task_id: 'k_ap' },
      { flag_id: 'flg_ap2', category: 'safety', task_id: null },
    ]);
    // The crew's words never reach the timeline, only the shape.
    expect(JSON.stringify(resolved)).not.toContain('SECRET');
  });

  test('cancelling says so in the resolution note', async () => {
    const r = await move(ticketRouter, 'st_open', { status: 'cancelled', reason: 'Community pulled the work' });
    expect(r.statusCode).toBe(200);
    const f = flag('flg_op');
    expect([f.status, f.resolved_by, f.resolution_note])
      .toEqual(['resolved', WIDE, 'Cancelled with the work order.']);
    expect(events('st_open').map((e) => e.kind)).toEqual(['flag_resolved', 'status_changed']);
  });

  test('a move that is not an ending leaves the problem open; the close after it clears it', async () => {
    expect((await move(ticketRouter, 'st_wc', { status: 'approved' })).statusCode).toBe(200);
    expect(flag('flg_wc').status).toBe('open');
    expect(events('st_wc').some((e) => e.kind === 'flag_resolved')).toBe(false);

    expect((await move(ticketRouter, 'st_wc', { status: 'closed' })).statusCode).toBe(200);
    expect([flag('flg_wc').status, flag('flg_wc').resolution_note])
      .toEqual(['resolved', 'Closed with the work order.']);
  });

  test('reopening a closed work order writes no flag line', async () => {
    expect((await move(ticketRouter, 'st_cl', { status: 'open', reason: 'Leak came back' })).statusCode).toBe(200);
    expect(events('st_cl').map((e) => e.kind)).toEqual(['status_changed']);
  });

  test('a refused ending clears nothing: no reason, and a stale screen', async () => {
    const bare = await move(ticketRouter, 'st_open', { status: 'cancelled' });
    expect(bare.statusCode).toBe(400);
    expect(flag('flg_op').status).toBe('open');

    const stale = await move(ticketRouter, 'st_ap', { status: 'closed', expected_status: 'work_complete' });
    expect([stale.statusCode, stale.body.code]).toEqual([409, 'status_changed']);
    expect(openFlagIds()).toEqual(['flg_ap1', 'flg_ap2', 'flg_op', 'flg_tw', 'flg_wc', 'flg_x']);
    expect(eng.count("SELECT 1 FROM service_ticket_events WHERE kind = 'flag_resolved'")).toBe(0);
  });

  test('a rival-org caller never reaches the flags', async () => {
    const r = await move(ticketRouter, 'st_ap', { status: 'closed' }, RIVAL);
    expect(r.statusCode).toBe(404);
    expect(flag('flg_ap1').status).toBe('open');
  });

  test('a failed flag line rolls the whole move back rather than half-applying it', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    db.pool.connect = async () => {
      const c = await eng.pool.connect();
      return {
        query: async (sql, params) => {
          const p = params || [];
          if (/INSERT INTO service_ticket_events/i.test(String(sql)) && p[3] === 'flag_resolved') {
            throw new Error('flag line refused');
          }
          return c.query(sql, params);
        },
        release: () => c.release(),
      };
    };
    const r = await move(ticketRouter, 'st_ap', { status: 'closed' });
    expect(r.statusCode).toBe(500);
    expect(row('st_ap').status).toBe('approved');
    expect([flag('flg_ap1').status, flag('flg_ap2').status]).toEqual(['open', 'open']);
    expect(statusEvents('st_ap')).toHaveLength(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * ARCHIVING IS THE OTHER ENDING, AND IT CLEARS THEM TOO
 *
 * DELETE /api/service-tickets/:id is a soft archive. An archived work order is
 * off every office screen, so an open flag left on one is even less reachable
 * than an open flag on a closed one — nobody can ever press Resolve again.
 * Same helper as the close path, same flag_resolved line, its own words.
 *
 * Unlike the close path this one is BEST EFFORT: the archive UPDATE has
 * already landed on its own row before the flags are touched, so a failure to
 * tidy them must not turn a successful archive into a 500 the caller retries
 * against an already-archived row.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('archiving a work order clears the crew problems still open on it', () => {
  test('archiving resolves this ticket\'s open flags, and nothing else', async () => {
    const r = await archive(ticketRouter, 'st_ap');
    expect([r.statusCode, r.body]).toEqual([200, { ok: true }]);
    expect(row('st_ap').archived_at).toBeTruthy();

    for (const id of ['flg_ap1', 'flg_ap2']) {
      const f = flag(id);
      expect([f.status, f.resolved_by, f.resolution_note])
        .toEqual(['resolved', WIDE, 'Archived with the work order.']);
      expect(f.resolved_at).toBeTruthy();
    }
    // An already-resolved flag keeps the words and the hand that closed it.
    expect([flag('flg_ap3').resolved_by, flag('flg_ap3').resolution_note]).toEqual([10, 'Sorted earlier']);
    // Another work order, another ticket of this job, and the RIVAL org's row
    // on the same ticket id are all still open — only the org predicate inside
    // resolveOpenFlagsOnClose keeps flg_tw out.
    expect(openFlagIds()).toEqual(['flg_op', 'flg_tw', 'flg_wc', 'flg_x']);
  });

  test('the flag lines are shape-only and land before the archive line', async () => {
    expect((await archive(ticketRouter, 'st_ap')).statusCode).toBe(200);
    const ev = events('st_ap');
    expect(ev.map((e) => e.kind)).toEqual(['flag_resolved', 'flag_resolved', 'field_changed']);
    const resolved = ev.filter((e) => e.kind === 'flag_resolved');
    expect(resolved.map((e) => e.actor_user_id)).toEqual([WIDE, WIDE]);
    expect(resolved.map((e) => e.detail).sort((a, b) => (a.flag_id < b.flag_id ? -1 : 1))).toEqual([
      { flag_id: 'flg_ap1', category: 'no_access', task_id: 'k_ap' },
      { flag_id: 'flg_ap2', category: 'safety', task_id: null },
    ]);
    // The crew's words never reach the timeline, only the shape.
    expect(JSON.stringify(resolved)).not.toContain('SECRET');
    expect(ev[2].detail).toEqual({ fields: ['archived_at'] });
  });

  test('a second archive is a 404 and writes no second round of flag lines', async () => {
    expect((await archive(ticketRouter, 'st_ap')).statusCode).toBe(200);
    const again = await archive(ticketRouter, 'st_ap');
    expect([again.statusCode, again.body]).toEqual([404, { error: 'Service ticket not found' }]);
    expect(events('st_ap').map((e) => e.kind)).toEqual(['flag_resolved', 'flag_resolved', 'field_changed']);
  });

  test('a rival-org caller never reaches the flags', async () => {
    const r = await archive(ticketRouter, 'st_ap', RIVAL);
    expect(r.statusCode).toBe(404);
    expect(row('st_ap').archived_at).toBeFalsy();
    expect(openFlagIds()).toEqual(['flg_ap1', 'flg_ap2', 'flg_op', 'flg_tw', 'flg_wc', 'flg_x']);
  });

  test('a flag clean-up that fails still archives the work order', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const real = eng.pool.query;
    db.pool.query = async (sql, params) => {
      if (/UPDATE service_ticket_flags/i.test(String(sql))) throw new Error('flags offline');
      return real(sql, params);
    };
    const r = await archive(ticketRouter, 'st_ap');
    expect([r.statusCode, r.body]).toEqual([200, { ok: true }]);
    expect(row('st_ap').archived_at).toBeTruthy();
    expect(flag('flg_ap1').status).toBe('open');
    // The archive still says what it did.
    expect(events('st_ap').map((e) => e.kind)).toEqual(['field_changed']);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * EVERY GUARD, REMOVED
 * ══════════════════════════════════════════════════════════════════════════*/
describe('mutants', () => {
  test('drop `AND status = $n` from the guarded UPDATE and the concurrent cancel is overwritten', async () => {
    const mut = reviewMutant([[" AND status = ' + statusRef +", " AND ' + statusRef + ' IS NOT NULL' +"]]);
    interleave(/^\s*UPDATE service_tickets SET status/i,
      "UPDATE service_tickets SET status = 'cancelled' WHERE id = 'st_ip0'");
    const r = await move(mut, 'st_ip0', { status: 'work_complete', expected_status: 'in_progress' });
    expect(r.statusCode).toBe(200);
    expect(row('st_ip0').status).toBe('work_complete');
    expect(approvalCalls).toHaveLength(1);
  });

  test('drop organization_id from the reopen UPDATE and another org\'s row with the same id is reopened', async () => {
    // A row in org 2 that shares the id and the ticket id: only the reopen
    // UPDATE's own org predicate keeps it out.
    const twin = "INSERT INTO tasks (id, organization_id, title, status, scope, service_ticket_id, entity_type, entity_id) VALUES ('k_w1', 2, 'RIVAL twin', 'done', 'org', 'st_wc', 'job', 'j9')";
    eng.db.exec(twin);
    expect((await move(ticketRouter, 'st_wc', { status: 'in_progress', reason: 'Redo', reopen_tasks: ['k_w1'] })).statusCode).toBe(200);
    expect([task('k_w1', 1).status, task('k_w1', 2).status]).toEqual(['open', 'done']);

    seed();
    eng.db.exec(twin);
    const mut = reviewMutant([[
      "          WHERE id = ANY($1::text[]) AND service_ticket_id = $2 AND organization_id = $3\n            AND archived_at IS NULL AND scope = 'org' AND status = 'done'",
      "          WHERE id = ANY($1::text[]) AND service_ticket_id = $2 AND $3 IS NOT NULL\n            AND archived_at IS NULL AND scope = 'org' AND status = 'done'"]]);
    expect((await move(mut, 'st_wc', { status: 'in_progress', reason: 'Redo', reopen_tasks: ['k_w1'] })).statusCode).toBe(200);
    expect([task('k_w1', 1).status, task('k_w1', 2).status]).toEqual(['open', 'open']);
  });

  test('make reasonRule never required and a reason-less cancel lands', async () => {
    const mut = reviewMutant([[
      '  const rule = reasonRule(from, next);',
      '  const rule = Object.assign({}, reasonRule(from, next), { required: false });']]);
    const r = await move(mut, 'st_open', { status: 'cancelled' });
    expect(r.statusCode).toBe(200);
    expect(row('st_open').status).toBe('cancelled');
  });

  test('drop the override check and Work complete lands with a building open and no override', async () => {
    const mut = reviewMutant([['        if (o.override !== true) {', '        if (false) {']]);
    const r = await move(mut, 'st_ip', { status: 'work_complete' });
    expect(r.statusCode).toBe(200);
    expect(row('st_ip').status).toBe('work_complete');
  });

  test('check the lattice before expected_status and a stale screen gets a 403 instead of "reload"', async () => {
    const mut = reviewMutant([
      ['  if (expected && svc.normalizeStatus(expected) !== from) return stale(from);\n', ''],
      ["  if (!verdict.ok) return refusal(403, verdict.reason);\n",
        "  if (!verdict.ok) return refusal(403, verdict.reason);\n  if (expected && svc.normalizeStatus(expected) !== from) return stale(from);\n"],
    ]);
    const r = await move(mut, 'st_ap', { status: 'in_progress', expected_status: 'work_complete', reason: 'x' });
    expect(r.statusCode).toBe(403);
  });

  test('drop the terminal flag clean-up and the closed work order keeps a problem nobody can resolve', async () => {
    const mut = reviewMutant([["    if (next === 'closed' || next === 'cancelled') {", '    if (false) {']]);
    expect((await move(mut, 'st_ap', { status: 'closed' })).statusCode).toBe(200);
    expect(row('st_ap').status).toBe('closed');
    expect(flag('flg_ap1').status).toBe('open');
    expect(openFlagIds()).toEqual(['flg_ap1', 'flg_ap2', 'flg_op', 'flg_tw', 'flg_wc', 'flg_x']);
  });

  test('drop the clean-up from the ARCHIVE door and the archived work order keeps its problems open', async () => {
    const mut = routesMutant([[
      "      await flagSvc.resolveOpenFlagsOnClose(pool, ticket, actorOf(req), 'Archived with the work order.');",
      '      await Promise.resolve();']]);
    expect((await archive(mut, 'st_ap')).statusCode).toBe(200);
    expect(row('st_ap').archived_at).toBeTruthy();
    expect(flag('flg_ap1').status).toBe('open');
    expect(openFlagIds()).toEqual(['flg_ap1', 'flg_ap2', 'flg_op', 'flg_tw', 'flg_wc', 'flg_x']);
  });

  test('drop organization_id from the archive clean-up and the RIVAL org\'s flag on the same ticket id is resolved too', async () => {
    const flags = require.resolve(path.join(__dirname, '..', 'server', 'services', 'service-ticket-flags.js'));
    const flagsCopy = writeCopy(flags, [[
      "AND organization_id = $4 AND status = 'open'",
      "AND $4 IS NOT NULL AND status = 'open'"]]);
    const mut = require(writeCopy(TICKET_ROUTES, [], { [flags]: flagsCopy }));
    expect((await archive(mut, 'st_ap')).statusCode).toBe(200);
    expect(flag('flg_tw').status).toBe('resolved');
  });
});
