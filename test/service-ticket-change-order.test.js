// START A CHANGE ORDER FROM A WORK ORDER — EXECUTED (1.29, B8).
//
// POST /api/service-tickets/:id/change-orders turns extra work a crew found
// into a DRAFT change order on the job, carrying a server-owned
// data.fromWorkOrder link. What this file pins, through the real routers over
// a signed JWT and the pg-sqlite engine:
//
//   1. a start from a building note makes the next CO number on the job, with
//      one priced-at-zero line and a link naming the note, its building and
//      only the ticked, proven photos; the timeline gets change_order_started
//      with a shape-only detail;
//   2. the gates: no ESTIMATES_EDIT, a view grant, another org's ticket, a
//      lead-only ticket, a cancelled or archived ticket write nothing;
//   3. the proofs: a photo on another ticket's building, another org's photo, a
//      job file, a non-image, a note or suggestion from another work order, a
//      flag from another work order write nothing;
//   4. a second start from the same note asks first (409 naming CO-N), and
//      "Start another" makes one; ticket-level starts are never duplicates;
//   5. custody: no editor save, REST create, agent create or agent update can
//      set, change or erase the link;
//   6. linkedChangeOrders / coDraftCounts return no money and never another
//      organization's forged record;
//   7. nothing about it reaches the crew link;
//   8. the transaction's LOCK ORDER — the job row first (FOR KEY SHARE, the
//      mode the job_change_orders FK takes anyway), the work order second — so
//      a start and a concurrent DELETE /api/jobs/:id cannot form a cycle.
// Then each guard is removed from a copy of the shipped file and the same drive
// is shown to go wrong.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const ROUTES_DIR = path.join(__dirname, '..', 'server', 'routes');
const SERVICES_DIR = path.join(__dirname, '..', 'server', 'services');
const CO_PRINT_ROUTES = path.join(ROUTES_DIR, 'service-ticket-co-print-routes.js');
const CO_ROUTES = path.join(ROUTES_DIR, 'change-order-routes.js');
const CO_SERVICE = path.join(SERVICES_DIR, 'service-ticket-change-order.js');
const JOB_FIN = path.join(SERVICES_DIR, 'job-financials.js');

const TABLES = [
  'organizations', 'users', 'roles', 'jobs', 'job_access', 'leads', 'tasks',
  'service_tickets', 'service_ticket_events', 'service_ticket_revisions',
  'service_ticket_shares', 'service_ticket_participants', 'service_ticket_flags',
  'attachments', 'job_change_orders',
];

const WIDE = 10;     // edits every job, and change orders
const NOCAP = 15;    // edits every job, but not change orders
const CREW = 20;     // narrow tier with ESTIMATES_EDIT; only a VIEW grant on j1
const RIVAL = 50;    // wide, in org 2

const USERS = {
  [WIDE]: { role: 'co_wide', org: 1 },
  [NOCAP]: { role: 'co_nocap', org: 1 },
  [CREW]: { role: 'co_crew', org: 1 },
  [RIVAL]: { role: 'co_wide', org: 2 },
};

let eng;
let auth;
let coPrintRouter;
let coRouter;
let shareRouter;
let jobFin;
let ticketCo;
const tmpDirs = [];

const FWO_ST2 = JSON.stringify({ v: 1, ticketId: 'st2', source: { kind: 'ticket', id: null } });
const FWO_FORGED = JSON.stringify({ v: 1, ticketId: 'st1', ticketTitle: 'FORGED', source: { kind: 'ticket', id: null } });
// A change order data blob that CLAIMS to come from st1.
const CO_DATA_FORGED = JSON.stringify({ title: 'Forged CO', lines: [], fromWorkOrder: JSON.parse(FWO_FORGED) });

function seed() {
  const caps = (list) => "'" + JSON.stringify(list) + "'";
  eng.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM roles; DELETE FROM jobs; DELETE FROM job_access;
    DELETE FROM leads; DELETE FROM tasks; DELETE FROM service_tickets; DELETE FROM service_ticket_events;
    DELETE FROM service_ticket_revisions; DELETE FROM service_ticket_shares; DELETE FROM service_ticket_participants;
    DELETE FROM service_ticket_flags; DELETE FROM attachments; DELETE FROM job_change_orders;

    INSERT INTO organizations (id, name, timezone) VALUES (1, 'AG Exteriors', 'America/New_York'), (2, 'Rival Co', 'America/New_York');
    INSERT INTO roles (name, capabilities) VALUES
      ('co_wide',  ${caps(['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'LEADS_VIEW', 'LEADS_EDIT', 'ESTIMATES_VIEW', 'ESTIMATES_EDIT'])}),
      ('co_nocap', ${caps(['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'LEADS_VIEW', 'LEADS_EDIT', 'ESTIMATES_VIEW'])}),
      ('co_crew',  ${caps(['JOBS_VIEW_ASSIGNED', 'JOBS_EDIT_OWN', 'ESTIMATES_EDIT'])});
    INSERT INTO users (id, name, email, role, organization_id, active, notification_prefs) VALUES
      (10, 'Wendy Wide', 'w@agx.test', 'co_wide', 1, 1, '{}'),
      (15, 'Nick Nocap', 'n@agx.test', 'co_nocap', 1, 1, '{}'),
      (20, 'Carl Crew', 'c@agx.test', 'co_crew', 1, 1, '{}'),
      (50, 'Rival Ray', 'r@rival.test', 'co_wide', 2, 1, '{}');
    INSERT INTO jobs (id, owner_id, data, organization_id) VALUES
      ('j1', 10, '{"jobNumber":"M1001","title":"Latitude 28","contractAmount":24000}', 1),
      ('j2', 10, '{"jobNumber":"M1002","title":"Pines"}', 1),
      ('j9', 50, '{"jobNumber":"R1","title":"Rival job"}', 2);
    INSERT INTO job_access (job_id, user_id, access_level) VALUES ('j1', 20, 'view');
    INSERT INTO leads (id, title, organization_id) VALUES ('l1', 'Maple St', 1);

    INSERT INTO service_tickets (id, organization_id, ticket_number, title, job_id, lead_id, status, checklist, created_by, archived_at, created_at) VALUES
      ('st1', 1, 'WO-1', 'Latitude 28 stairs', 'j1', NULL, 'in_progress', '[]', 10, NULL, '2026-09-01 10:00:01'),
      ('st2', 1, 'WO-2', 'Pines gutters',      'j2', NULL, 'open',        '[]', 10, NULL, '2026-09-01 10:00:02'),
      ('stc', 1, 'WO-3', 'Cancelled one',      'j1', NULL, 'cancelled',   '[]', 10, NULL, '2026-09-01 10:00:03'),
      ('sta', 1, 'WO-4', 'Archived one',       'j1', NULL, 'open',        '[]', 10, '2026-09-02 10:00:00', '2026-09-01 10:00:04'),
      ('stx', 1, 'WO-5', 'Closed one',         'j1', NULL, 'closed',      '[]', 10, NULL, '2026-09-01 10:00:05'),
      ('stl', 1, 'WO-6', 'Lead only',          NULL, 'l1', 'open',        '[]', 10, NULL, '2026-09-01 10:00:06'),
      ('stb', 2, 'R-1',  'RIVAL ticket',       'j9', NULL, 'open',        '[]', 50, NULL, '2026-09-01 10:00:07');

    INSERT INTO tasks (id, organization_id, title, status, scope, service_ticket_id, entity_type, entity_id, archived_at, created_at) VALUES
      ('k1', 1, 'Bldg 784 — Side A: rail post; tread 3', 'open', 'org', 'st1', 'job', 'j1', NULL, '2026-09-02 08:00:01'),
      ('k2', 1, 'Bldg 12', 'open', 'org', 'st1', 'job', 'j1', NULL, '2026-09-02 08:00:02'),
      ('k9', 1, 'Bldg 9', 'open', 'org', 'st2', 'job', 'j2', NULL, '2026-09-02 08:00:03'),
      ('kr', 2, 'Rival bldg', 'open', 'org', 'stb', 'job', 'j9', NULL, '2026-09-02 08:00:04');

    INSERT INTO attachments (id, organization_id, entity_type, entity_id, filename, mime_type, thumb_url, web_url, tags, position, uploaded_at) VALUES
      ('p_b',     1, 'task',           'k1',  'before.jpg', 'image/jpeg', 'https://cdn.test/b_t.jpg', 'https://cdn.test/b_w.jpg', '["before"]', 0, '2026-09-03 09:00:01'),
      ('p_c',     1, 'task',           'k1',  'after.jpg',  'image/jpeg', 'https://cdn.test/c_t.jpg', 'https://cdn.test/c_w.jpg', '[]', 1, '2026-09-03 09:00:02'),
      ('p_site',  1, 'service_ticket', 'st1', 'site.jpg',   'image/jpeg', 'https://cdn.test/s_t.jpg', 'https://cdn.test/s_w.jpg', '[]', 0, '2026-09-03 09:00:03'),
      ('p_other', 1, 'task',           'k9',  'other.jpg',  'image/jpeg', 'https://cdn.test/o_t.jpg', 'https://cdn.test/o_w.jpg', '[]', 0, '2026-09-03 09:00:04'),
      ('p_rival', 2, 'task',           'k1',  'rival.jpg',  'image/jpeg', 'https://cdn.test/r_t.jpg', 'https://cdn.test/r_w.jpg', '[]', 0, '2026-09-03 09:00:05'),
      ('p_job',   1, 'job',            'j1',  'job.jpg',    'image/jpeg', 'https://cdn.test/j_t.jpg', 'https://cdn.test/j_w.jpg', '[]', 0, '2026-09-03 09:00:06'),
      ('p_pdf',   1, 'task',           'k1',  'plan.pdf',   'application/pdf', NULL, 'https://cdn.test/plan.pdf', '[]', 2, '2026-09-03 09:00:07');

    INSERT INTO service_ticket_events (id, organization_id, ticket_id, kind, actor_kind, actor_label, detail, created_at) VALUES
      ('ev_note',  1, 'st1', 'subtask_note', 'share', 'Jose', '{"task_id":"k1","note":"More rot under tread 3"}', '2026-09-04 10:00:00'),
      ('ev_other', 1, 'st2', 'subtask_note', 'share', 'Jose', '{"task_id":"k9","note":"Other ticket"}', '2026-09-04 10:00:01'),
      ('ev_stat',  1, 'st1', 'status_changed', 'user', 'Wendy', '{"from":"open","to":"in_progress"}', '2026-09-04 10:00:02');

    INSERT INTO service_ticket_revisions (id, organization_id, ticket_id, author_label, fields, note, status, created_at) VALUES
      ('rev1',     1, 'st1', 'Jose', '{"scope_proposed":"Add a rail"}', 'Stair needs a rail', 'pending', '2026-09-04 11:00:00'),
      ('rev_oth',  1, 'st2', 'Jose', '{"scope_proposed":"x"}', 'Other', 'pending', '2026-09-04 11:00:01');

    INSERT INTO service_ticket_flags (id, organization_id, ticket_id, task_id, category, note, attachment_ids, status, created_at) VALUES
      ('fl1',    1, 'st1', 'k1', 'extra_damage', 'Joist is rotten', '["p_site"]', 'open', '2026-09-04 12:00:00'),
      ('fl_oth', 1, 'st2', 'k9', 'safety', 'Other ticket', '[]', 'open', '2026-09-04 12:00:01');

    INSERT INTO job_change_orders (id, job_id, owner_id, status, co_number, data, organization_id, is_locked, created_at, updated_at) VALUES
      ('co_old', 'j1', 10, 'approved', 'CO-1', '{"title":"Old CO","lines":[]}', 1, 0, '2026-09-01 09:00:00', '2026-09-01 09:00:00');
  `);
}

// TWO dialect rewrites on top of the shared shim.
//
// (a) jobFin.nextCoNumber's `co_number ~ '^CO-[0-9]+$'` — a Postgres regex
//     match the shim does not translate. GLOB 'CO-[0-9]*' selects the same
//     CO-N rows here, and the JS that reads them parses the number and skips
//     anything else either way.
// (b) the `FOR KEY SHARE` clause on the jobs lock that opens startChangeOrder's
//     transaction. test/helpers/pg-sqlite.js already strips `FOR UPDATE` and
//     states the reason: a row-lock hint cannot appear in, and cannot change, a
//     WHERE clause, so the rows the statement selects are identical with and
//     without it. FOR KEY SHARE is that same hint in a weaker mode, and the
//     shim does not know it yet — so it is stripped here, the way
//     test/job-delete-tickets.test.js supplies the jsonb_set the shim lacks.
//     STRIPPED, never stubbed: the statement still runs, with its real
//     predicate and its real parameters. And the log below records each
//     statement as the door WROTE it, before either rewrite, so section (8)
//     pins the lock order and the lock MODE on the SQL that ships — not on
//     whatever sqlite was handed.
function toSqliteDialect(sql) {
  return String(sql)
    .replace(/co_number\s*~\s*'\^CO-\[0-9\]\+\$'/g, "co_number GLOB 'CO-[0-9]*'")
    .replace(/\s+FOR\s+KEY\s+SHARE\b/gi, '');
}

// Every statement issued through the app's pool, in order, as written. Armed
// only inside recordSql(), so the ordinary drives above pay nothing for it.
let sqlLog = null;
function withDialect(query) {
  return (sql, params) => {
    if (sqlLog) sqlLog.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params: params });
    return query(toSqliteDialect(sql), params);
  };
}
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

beforeAll(async () => {
  eng = createPgSqlite(sqliteSchema(TABLES), {
    jsonColumns: ['checklist', 'capabilities', 'detail', 'fields', 'data', 'tags', 'attachment_ids', 'notification_prefs', 'materials'],
  });
  const db = require('../server/db');
  db.pool.query = withDialect(eng.pool.query);
  db.pool.connect = async () => {
    const c = await eng.pool.connect();
    return { query: withDialect(c.query), release: c.release };
  };
  auth = require('../server/auth');
  auth.setRolePool(eng.pool);
  seed();
  await auth.refreshRoleCache();
  coPrintRouter = require(CO_PRINT_ROUTES);
  coRouter = require(CO_ROUTES);
  shareRouter = require('../server/routes/service-ticket-share-routes');
  jobFin = require(JOB_FIN);
  ticketCo = require(CO_SERVICE);
});

beforeEach(() => seed());

const flush = () => new Promise((r) => setTimeout(r, 25));

afterAll(async () => {
  await flush();
  require('../server/db').pool.query = async () => ({ rows: [], rowCount: 0 });
  if (eng) eng.close();
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* gone */ } }
});

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
  let chain = layer.route.stack.map((s) => s.handle);
  if (o.fromHandler) {
    const at = chain.findIndex((h) => h.name === o.fromHandler);
    if (at < 0) throw new Error('no handler named ' + o.fromHandler + ' on ' + routePath);
    chain = chain.slice(at);
  }
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

const start = (as, id, body, router) => drive(router || coPrintRouter, 'post', '/:id/change-orders', { as, params: { id }, body });
const NOTE_BODY = {
  source: { kind: 'building_note', id: 'ev_note' },
  title: 'Extra work — Bldg 784',
  description: 'More rot under tread 3.\nReplace the stringer too.',
  qty: 2,
  unit: 'lf',
  photo_ids: ['p_b', 'p_c'],
  terms: '<p>Net 30</p>',
};
const TICKET_BODY = { source: { kind: 'ticket' }, title: 'Extra work — Latitude 28 stairs', description: 'Extra rail' };

const coRows = () => eng.all('SELECT * FROM job_change_orders ORDER BY rowid');
const newCoCount = () => eng.count("SELECT 1 FROM job_change_orders WHERE id <> 'co_old'");
const eventsOf = (id, kind) => eng.all('SELECT kind, detail, actor_user_id, organization_id FROM service_ticket_events WHERE ticket_id = ? AND kind = ? ORDER BY rowid', id, kind);

function absolutizeRequires(src, fromDir) {
  return src.replace(/require\((['"])([^'"]+)\1\)/g, (_m, _q, spec) => {
    const resolved = spec.charAt(0) === '.'
      ? require.resolve(path.resolve(fromDir, spec))
      : require.resolve(spec, { paths: [fromDir] });
    return 'require(' + JSON.stringify(resolved.split(path.sep).join('/')) + ')';
  });
}

// A copy of `file` with ONE change, loaded from a temp dir. The anchor must
// occur exactly once in the CRLF-normalised source. `redirects` points a
// require of a shipped module at another copy.
function writeMutant(file, anchor, replacement, redirects) {
  const src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  if (src.split(anchor).length !== 2) throw new Error('anchor not found');
  const out = src.replace(anchor, () => replacement);
  if (out === src) throw new Error('mutation changed nothing');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p86-st-co-'));
  tmpDirs.push(dir);
  let copy = absolutizeRequires(out, path.dirname(file));
  for (const [from, to] of Object.entries(redirects || {})) {
    const ref = 'require(' + JSON.stringify(from.split(path.sep).join('/')) + ')';
    if (copy.split(ref).length < 2) throw new Error('redirect not found');
    copy = copy.split(ref).join('require(' + JSON.stringify(to.split(path.sep).join('/')) + ')');
  }
  const p = path.join(dir, path.basename(file));
  fs.writeFileSync(p, copy, 'utf8');
  return p;
}

const mutant = (file, anchor, replacement, redirects) => require(writeMutant(file, anchor, replacement, redirects));

describe('the harness', () => {
  test('an anchor that is not in the file throws', () => {
    expect(() => writeMutant(CO_PRINT_ROUTES, 'nowhere in this file', 'x')).toThrow('anchor not found');
  });
  test('the files under test are CRLF on disk', () => {
    for (const f of [CO_PRINT_ROUTES, CO_ROUTES, CO_SERVICE, JOB_FIN]) {
      expect([f, fs.readFileSync(f, 'utf8').indexOf('\r\n') > -1]).toEqual([f, true]);
    }
  });
});

describe('(1) a start from a building note', () => {
  test('makes CO-2 on the job: a draft with a zero-cost line and a server-owned link', async () => {
    const res = await start(WIDE, 'st1', NOTE_BODY);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    const co = res.body.change_order;
    expect(co).toMatchObject({ job_id: 'j1', co_number: 'CO-2', status: 'draft', title: 'Extra work — Bldg 784' });

    const row = coRows().find((r) => r.id === co.id);
    expect([row.job_id, row.organization_id, row.status, row.co_number, row.owner_id]).toEqual(['j1', 1, 'draft', 'CO-2', WIDE]);
    expect(row.data.title).toBe('Extra work — Bldg 784');
    expect(row.data.scope).toBe('<p>More rot under tread 3.<br>Replace the stringer too.</p>');
    expect(row.data.lines).toHaveLength(1);
    expect(row.data.lines[0]).toMatchObject({ qty: 2, unit: 'lf', unitCost: 0, description: 'More rot under tread 3. Replace the stringer too.' });
    expect(row.data.costPending).toBeUndefined();

    const link = row.data.fromWorkOrder;
    expect(Object.keys(link).sort()).toEqual(['photos', 'source', 'startedAt', 'startedBy', 'ticketId', 'ticketNumber', 'ticketTitle', 'v'].sort());
    expect(link).toMatchObject({ v: 1, ticketId: 'st1', ticketTitle: 'Latitude 28 stairs', ticketNumber: 'WO-1', startedBy: WIDE });
    expect(link.source).toEqual({ kind: 'building_note', id: 'ev_note', taskId: 'k1', building: 'Bldg 784', category: null });
    expect(link.photos.map((p) => [p.attachment_id, p.entity_type, p.entity_id, p.kind, p.building])).toEqual([
      ['p_b', 'task', 'k1', 'before', 'Bldg 784'],
      ['p_c', 'task', 'k1', 'completion', 'Bldg 784'],
    ]);
    expect(JSON.stringify(link)).not.toMatch(/price|cost|total|amount/i);

    const ev = eventsOf('st1', 'change_order_started');
    expect(ev).toHaveLength(1);
    expect(Object.keys(ev[0].detail)).toEqual(['co_id', 'co_number', 'source_kind', 'source_id', 'task_id', 'photos']);
    expect(ev[0].detail).toEqual({ co_id: co.id, co_number: 'CO-2', source_kind: 'building_note', source_id: 'ev_note', task_id: 'k1', photos: 2 });
    expect([ev[0].actor_user_id, ev[0].organization_id]).toEqual([WIDE, 1]);

    expect(res.body.change_orders.map((c) => [c.co_number, c.source_kind, c.task_id])).toEqual([['CO-2', 'building_note', 'k1']]);
  });

  test('a flag start names the flag category, and a site photo is a site photo', async () => {
    const res = await start(WIDE, 'st1', { source: { kind: 'flag', id: 'fl1' }, title: 'Extra damage — Bldg 784', description: 'Joist', photo_ids: ['p_site'] });
    expect(res.statusCode).toBe(200);
    const link = coRows().find((r) => r.id === res.body.change_order.id).data.fromWorkOrder;
    expect(link.source).toEqual({ kind: 'flag', id: 'fl1', taskId: 'k1', building: 'Bldg 784', category: 'extra_damage' });
    expect(link.photos.map((p) => [p.attachment_id, p.entity_type, p.kind, p.building])).toEqual([['p_site', 'service_ticket', 'site', null]]);
    expect(ticketCo.FLAG_CATEGORY_LABEL.other).toBe('Problem');
    expect(ticketCo.FLAG_CATEGORY_LABEL.extra_damage).toBe('Extra damage');
  });

  test('a suggestion start, and a closed work order may still start one', async () => {
    const rev = await start(WIDE, 'st1', { source: { kind: 'revision', id: 'rev1' }, title: 'Rail', description: 'Add a rail' });
    expect([rev.statusCode, rev.body.change_order && rev.body.change_order.co_number]).toEqual([200, 'CO-2']);
    const closed = await start(WIDE, 'stx', TICKET_BODY);
    expect([closed.statusCode, closed.body.change_order && closed.body.change_order.co_number]).toEqual([200, 'CO-3']);
  });

  test('the body is validated before anything is read', async () => {
    const cases = [
      [{ ...TICKET_BODY, title: '  ' }, 'Give the change order a title.'],
      [{ ...TICKET_BODY, description: '' }, 'Describe the extra work.'],
      [{ ...TICKET_BODY, qty: 0 }, 'Quantity must be a number above zero.'],
      [{ ...TICKET_BODY, qty: 'lots' }, 'Quantity must be a number above zero.'],
      [{ ...TICKET_BODY, photo_ids: Array.from({ length: 25 }, (_, i) => 'p' + i) }, 'Pick up to 24 photos.'],
      [{ ...TICKET_BODY, source: { kind: 'estimate' } }, 'Unknown source.'],
    ];
    for (const [body, error] of cases) {
      const res = await start(WIDE, 'st1', body);
      expect([res.statusCode, res.body]).toEqual([400, { error }]);
    }
    expect(newCoCount()).toBe(0);
  });
});

describe('(2) the gates write nothing', () => {
  test('no ESTIMATES_EDIT is 403; a view grant, another org and a missing id are 404', async () => {
    const nocap = await start(NOCAP, 'st1', TICKET_BODY);
    expect([nocap.statusCode, nocap.body]).toEqual([403, { error: 'Missing capability: ESTIMATES_EDIT' }]);
    const view = await start(CREW, 'st1', TICKET_BODY);
    expect([view.statusCode, view.body]).toEqual([404, { error: 'Service ticket not found' }]);
    const rival = await start(RIVAL, 'st1', TICKET_BODY);
    expect([rival.statusCode, rival.body]).toEqual([404, { error: 'Service ticket not found' }]);
    const foreign = await start(WIDE, 'stb', TICKET_BODY);
    expect([foreign.statusCode, foreign.body]).toEqual([404, { error: 'Service ticket not found' }]);
    expect(newCoCount()).toBe(0);
    expect(eng.count("SELECT 1 FROM service_ticket_events WHERE kind = 'change_order_started'")).toBe(0);
  });

  test('a lead-only, a cancelled and an archived work order are 409', async () => {
    const lead = await start(WIDE, 'stl', TICKET_BODY);
    expect([lead.statusCode, lead.body]).toEqual([409, { error: 'Change orders belong to a job. Convert this lead to a job first.' }]);
    const cancelled = await start(WIDE, 'stc', TICKET_BODY);
    expect([cancelled.statusCode, cancelled.body]).toEqual([409, { error: 'This ticket was cancelled. Reopen it before starting a change order.' }]);
    const archived = await start(WIDE, 'sta', TICKET_BODY);
    expect([archived.statusCode, archived.body]).toEqual([409, { error: 'This ticket is archived.' }]);
    expect(newCoCount()).toBe(0);
  });

  test('MUTANT: without the ESTIMATES_EDIT check a user who cannot edit change orders creates one', async () => {
    const mut = mutant(CO_PRINT_ROUTES, '    if (!hasCapability(req.user, CO_CAPABILITY)) {', '    if (false) {');
    const res = await start(NOCAP, 'st1', TICKET_BODY, mut);
    expect(res.statusCode).toBe(200);
    expect(newCoCount()).toBe(1);
  });
});

describe('(3) every id is proved to be on this work order', () => {
  const PHOTO_404 = { error: 'One of those photos is not on this work order.' };
  test.each([
    ['a photo on another work order’s building', 'p_other'],
    ['another organization’s photo row', 'p_rival'],
    ['a job file', 'p_job'],
    ['a document that is not an image', 'p_pdf'],
    ['an id that does not exist', 'p_nope'],
  ])('%s is 404 and nothing is written', async (_label, bad) => {
    const res = await start(WIDE, 'st1', { ...NOTE_BODY, photo_ids: ['p_b', bad] });
    expect([res.statusCode, res.body]).toEqual([404, PHOTO_404]);
    expect(newCoCount()).toBe(0);
  });

  test('a note, a suggestion or a flag from another work order is 404 and nothing is written', async () => {
    const note = await start(WIDE, 'st1', { ...TICKET_BODY, source: { kind: 'building_note', id: 'ev_other' } });
    expect([note.statusCode, note.body]).toEqual([404, { error: 'That note is not on this work order.' }]);
    const notNote = await start(WIDE, 'st1', { ...TICKET_BODY, source: { kind: 'building_note', id: 'ev_stat' } });
    expect([notNote.statusCode, notNote.body]).toEqual([404, { error: 'That note is not on this work order.' }]);
    const rev = await start(WIDE, 'st1', { ...TICKET_BODY, source: { kind: 'revision', id: 'rev_oth' } });
    expect([rev.statusCode, rev.body]).toEqual([404, { error: 'That suggestion is not on this work order.' }]);
    const flag = await start(WIDE, 'st1', { ...TICKET_BODY, source: { kind: 'flag', id: 'fl_oth' } });
    expect([flag.statusCode, flag.body]).toEqual([404, { error: 'That flag is not on this work order.' }]);
    const junk = await start(WIDE, 'st1', { ...TICKET_BODY, source: { kind: 'flag', id: "x' OR 1=1" } });
    expect([junk.statusCode, junk.body]).toEqual([404, { error: 'That flag is not on this work order.' }]);
    expect(newCoCount()).toBe(0);
  });

  test('MUTANT: without the parent predicate in provePhotos a photo from another work order is accepted', async () => {
    const mut = mutant(CO_SERVICE,
      "        AND ((entity_type = 'service_ticket' AND entity_id = $3)\n          OR (entity_type = 'task' AND entity_id = ANY($4::text[])))`,",
      "        AND ($3 IS NOT NULL OR $4 IS NOT NULL)`,");
    const ticket = eng.all("SELECT * FROM service_tickets WHERE id = 'st1'")[0];
    const r = await mut.startChangeOrder(require('../server/db').pool, {
      ticket, user: { id: WIDE, name: 'Wendy Wide' }, body: { ...NOTE_BODY, photo_ids: ['p_other'] },
    });
    expect(r.ok).toBe(true);
    expect(newCoCount()).toBe(1);
  });
});

describe('(4) duplicates', () => {
  test('the same note twice asks first; Start another makes a second', async () => {
    const first = await start(WIDE, 'st1', NOTE_BODY);
    expect(first.statusCode).toBe(200);
    const again = await start(WIDE, 'st1', NOTE_BODY);
    expect(again.statusCode).toBe(409);
    expect(again.body).toEqual({
      error: 'A change order was already started from this — CO-2.',
      existing: { id: first.body.change_order.id, co_number: 'CO-2', status: 'draft' },
    });
    expect(newCoCount()).toBe(1);
    const another = await start(WIDE, 'st1', { ...NOTE_BODY, allow_duplicate: true });
    expect([another.statusCode, another.body.change_order.co_number]).toEqual([200, 'CO-3']);
    expect(newCoCount()).toBe(2);
  });

  test('ticket-level starts are never duplicates', async () => {
    expect((await start(WIDE, 'st1', TICKET_BODY)).statusCode).toBe(200);
    expect((await start(WIDE, 'st1', TICKET_BODY)).statusCode).toBe(200);
    expect(newCoCount()).toBe(2);
  });
});

describe('(5) custody: nobody else can set, change or erase the link', () => {
  const put = (id, body, router) => drive(router || coRouter, 'put', '/change-orders/:id', { as: WIDE, params: { id }, body });

  async function started() {
    const res = await start(WIDE, 'st1', NOTE_BODY);
    expect(res.statusCode).toBe(200);
    return res.body.change_order.id;
  }
  const linkOf = (id) => coRows().find((r) => r.id === id).data.fromWorkOrder;

  test('an editor save without the link keeps it; a forged one is ignored', async () => {
    const id = await started();
    const original = linkOf(id);
    const plain = await put(id, { title: 'Edited', lines: [{ id: 'l1', description: 'x', qty: 1, unitCost: 0 }] });
    expect(plain.statusCode).toBe(200);
    expect(plain.body.change_order.fromWorkOrder).toEqual(original);
    expect(linkOf(id)).toEqual(original);
    const forged = await put(id, { title: 'Forged', lines: [], fromWorkOrder: { v: 1, ticketId: 'st2' } });
    expect(forged.statusCode).toBe(200);
    expect(linkOf(id)).toEqual(original);
    expect(coRows().find((r) => r.id === id).data.title).toBe('Forged');
  });

  test('an editor save never adds a link to a change order that had none', async () => {
    const res = await put('co_old', { title: 'Old CO', lines: [], fromWorkOrder: JSON.parse(FWO_ST2) });
    expect(res.statusCode).toBe(200);
    expect(coRows().find((r) => r.id === 'co_old').data.fromWorkOrder).toBeUndefined();
  });

  test('the REST create door stores no link', async () => {
    const res = await drive(coRouter, 'post', '/jobs/:jobId/change-orders', {
      as: WIDE, params: { jobId: 'j1' }, body: { title: 'By hand', lines: [], fromWorkOrder: JSON.parse(FWO_FORGED) },
    });
    expect(res.statusCode).toBe(200);
    expect(coRows().find((r) => r.id === res.body.change_order.id).data.fromWorkOrder).toBeUndefined();
  });

  test('the shared service: create ignores fields.fromWorkOrder; update keeps the stored link, merged or replaced', async () => {
    const pool = require('../server/db').pool;
    const made = await jobFin.createChangeOrder(pool, { jobId: 'j1', orgId: 1, ownerId: WIDE, fields: { title: 'Agent CO', lines: [], fromWorkOrder: JSON.parse(FWO_FORGED) } });
    expect(coRows().find((r) => r.id === made.id).data.fromWorkOrder).toBeUndefined();

    const id = await started();
    const original = linkOf(id);
    await jobFin.updateChangeOrder(pool, { id, orgId: 1, jobId: 'j1', fields: { title: 'Agent edit', fromWorkOrder: JSON.parse(FWO_ST2) } });
    expect(linkOf(id)).toEqual(original);
    await jobFin.updateChangeOrder(pool, { id, orgId: 1, jobId: 'j1', fields: { title: 'Replaced', lines: [] }, merge: false });
    expect(linkOf(id)).toEqual(original);
    expect(coRows().find((r) => r.id === id).data.title).toBe('Replaced');
  });

  test('MUTANT: without the PUT re-apply an editor save erases the link', async () => {
    const id = await started();
    const mut = mutant(CO_ROUTES,
      "    if (storedLink && typeof storedLink === 'object' && !Array.isArray(storedLink)) data.fromWorkOrder = storedLink;\n",
      '');
    const res = await put(id, { title: 'Edited', lines: [] }, mut);
    expect(res.statusCode).toBe(200);
    expect(linkOf(id)).toBeUndefined();
  });

  test('MUTANT: without the strip in createChangeOrder an agent payload forges a link', async () => {
    const mut = mutant(JOB_FIN, '  delete body.fromWorkOrder;\n', '');
    const made = await mut.createChangeOrder(require('../server/db').pool, {
      jobId: 'j1', orgId: 1, ownerId: WIDE, fields: { title: 'Agent CO', lines: [], fromWorkOrder: JSON.parse(FWO_FORGED) },
    });
    expect(coRows().find((r) => r.id === made.id).data.fromWorkOrder).toMatchObject({ ticketId: 'st1', ticketTitle: 'FORGED' });
  });
});

describe('(6) the linked list and the draft counts', () => {
  function plantRivalForgery() {
    // Another organization's row that names this org's job and ticket.
    eng.db.exec(`INSERT INTO job_change_orders (id, job_id, owner_id, status, co_number, data, organization_id, is_locked, created_at, updated_at)
      VALUES ('co_rival', 'j1', 50, 'draft', 'CO-99', '${CO_DATA_FORGED}', 2, 0, '2026-09-05 09:00:00', '2026-09-05 09:00:00')`);
  }
  const ticketRow = (id) => eng.all('SELECT * FROM service_tickets WHERE id = ?', id)[0];

  test('linkedChangeOrders carries no lines and no money, and never another org’s forged row', async () => {
    const first = await start(WIDE, 'st1', NOTE_BODY);
    expect(first.statusCode).toBe(200);
    plantRivalForgery();
    const pool = require('../server/db').pool;
    const list = await ticketCo.linkedChangeOrders(pool, ticketRow('st1'));
    expect(list).toHaveLength(1);
    expect(Object.keys(list[0])).toEqual(['id', 'co_number', 'status', 'title', 'source_kind', 'source_id', 'task_id', 'created_at']);
    expect(list[0]).toMatchObject({ co_number: 'CO-2', status: 'draft', title: 'Extra work — Bldg 784', source_kind: 'building_note', source_id: 'ev_note', task_id: 'k1' });
    expect(await ticketCo.linkedChangeOrders(pool, ticketRow('stl'))).toEqual([]);
  });

  test('coDraftCounts counts this org’s drafts on the ticket’s own job only', async () => {
    expect((await start(WIDE, 'st1', NOTE_BODY)).statusCode).toBe(200);
    plantRivalForgery();
    // A same-org record on another job naming st1 is not st1's either.
    eng.db.exec(`INSERT INTO job_change_orders (id, job_id, owner_id, status, co_number, data, organization_id, is_locked)
      VALUES ('co_j2', 'j2', 10, 'draft', 'CO-1', '${CO_DATA_FORGED}', 1, 0)`);
    const pool = require('../server/db').pool;
    const counts = await ticketCo.coDraftCounts(pool, 1, [ticketRow('st1'), ticketRow('st2'), ticketRow('stl')]);
    expect(counts).toEqual({ st1: 1 });
  });

  test('both answer empty rather than throw when the table is missing', async () => {
    const broken = { query: async () => { throw new Error('no such table: job_change_orders'); } };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await ticketCo.linkedChangeOrders(broken, ticketRow('st1'))).toEqual([]);
      expect(await ticketCo.coDraftCounts(broken, 1, [ticketRow('st1')])).toEqual({});
    } finally {
      warn.mockRestore();
    }
  });

  test('MUTANT: without the org predicate linkedChangeOrders lists the rival forgery', async () => {
    expect((await start(WIDE, 'st1', NOTE_BODY)).statusCode).toBe(200);
    plantRivalForgery();
    const mut = mutant(CO_SERVICE,
      "        WHERE co.job_id = $1 AND co.organization_id = $2\n          AND co.data->'fromWorkOrder'->>'ticketId' = $3\n        ORDER BY co.created_at ASC`,",
      "        WHERE co.job_id = $1 AND $2 IS NOT NULL\n          AND co.data->'fromWorkOrder'->>'ticketId' = $3\n        ORDER BY co.created_at ASC`,");
    const list = await mut.linkedChangeOrders(require('../server/db').pool, ticketRow('st1'));
    expect(list.map((c) => c.co_number).sort()).toEqual(['CO-2', 'CO-99']);
  });

  test('MUTANT: without the org predicate coDraftCounts counts the rival forgery', async () => {
    expect((await start(WIDE, 'st1', NOTE_BODY)).statusCode).toBe(200);
    plantRivalForgery();
    const mut = mutant(CO_SERVICE,
      "WHERE co.organization_id = $1 AND co.status = 'draft' AND co.job_id = ANY($2::text[])",
      "WHERE $1 IS NOT NULL AND co.status = 'draft' AND co.job_id = ANY($2::text[])");
    expect(await mut.coDraftCounts(require('../server/db').pool, 1, [ticketRow('st1')])).toEqual({ st1: 2 });
  });
});

describe('(7) nothing reaches the crew link', () => {
  test('after a start, the share read carries no change order', async () => {
    const svc = require('../server/services/service-tickets');
    expect((await start(WIDE, 'st1', NOTE_BODY)).statusCode).toBe(200);
    const token = svc.genToken();
    eng.db.exec("INSERT INTO service_ticket_shares (id, organization_id, ticket_id, token_hash, scope, hide_financials, expires_at, view_count, created_by, created_at) VALUES " +
      "('sh1', 1, 'st1', '" + svc.hashToken(token) + "', 'respond', 1, '" + new Date(Date.now() + 86400000).toISOString() + "', 0, 10, '2026-09-03 09:00:00')");
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let r;
    try {
      r = await drive(shareRouter, 'get', '/service-ticket-share/:token', { params: { token }, fromHandler: 'loadTicketShare' });
    } finally {
      warn.mockRestore();
    }
    expect(r.statusCode).toBe(200);
    expect(r.body.tasks.map((t) => t.title)).toContain('Bldg 784 — Side A: rail post; tread 3');
    const json = JSON.stringify(r.body);
    for (const s of ['fromWorkOrder', 'change_order', 'CO-2', 'Extra work']) expect([s, json.indexOf(s)]).toEqual([s, -1]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * (8) LOCK ORDER — THE JOB ROW FIRST, THE WORK ORDER SECOND
 *
 * createChangeOrder INSERTs into job_change_orders, and that INSERT fires the
 * job_id -> jobs(id) FK check, which takes FOR KEY SHARE on the job row and
 * holds it to COMMIT. assertJobInOrg is a bare SELECT 1 and takes no lock at
 * all, so before this section the door reached the jobs row LATE — after it was
 * already holding the work order FOR UPDATE. DELETE /api/jobs/:id runs the
 * other way round: jobs FOR UPDATE first, then every work order on the job.
 * Opposite orders over the same two rows, and FOR KEY SHARE conflicts with
 * FOR UPDATE: Postgres kills one of the two with 40P01, and the office sees a
 * 500 on a change order that was refused for no reason it can act on.
 *
 * The lock itself cannot be exercised here — sqlite has no row locks, and the
 * shim says so. What is pinned is the thing that was actually wrong: WHICH
 * statement the door issues, in WHAT order, in WHAT mode, against WHICH job.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('(8) the transaction locks the job before the work order', () => {
  const JOBS_LOCK = 'SELECT 1 FROM jobs WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL) FOR KEY SHARE';
  const TICKET_LOCK = 'SELECT id, status, archived_at, job_id FROM service_tickets WHERE id = $1 AND organization_id = $2 FOR UPDATE';
  const at = (log, sql) => log.findIndex((e) => e.sql === sql);

  function shippedStart() {
    return recordSql(async () => {
      const res = await start(WIDE, 'st1', NOTE_BODY);
      expect([res.statusCode, res.body.ok]).toEqual([200, true]);
    });
  }

  test('BEGIN, then the jobs row, then the work order row, then COMMIT', async () => {
    const log = await shippedStart();
    const begin = at(log, 'BEGIN');
    const jobs = at(log, JOBS_LOCK);
    const ticket = at(log, TICKET_LOCK);
    const commit = at(log, 'COMMIT');
    expect(begin).toBeGreaterThan(-1);
    expect(jobs).toBeGreaterThan(begin);
    expect(ticket).toBeGreaterThan(jobs);
    expect(commit).toBeGreaterThan(ticket);
    // And it is the FIRST statement in the transaction: no other lock can get
    // in ahead of it and reintroduce the inversion.
    expect(jobs).toBe(begin + 1);
  });

  test('it locks THIS work order’s job, in THIS organization', async () => {
    const log = await shippedStart();
    expect(log[at(log, JOBS_LOCK)].params).toEqual(['j1', 1]);
    expect(log[at(log, TICKET_LOCK)].params).toEqual(['st1', 1]);
  });

  test('the mode is FOR KEY SHARE — never FOR UPDATE', async () => {
    // Not decoration. FOR KEY SHARE is exactly what the FK check takes anyway,
    // so taking it early adds no conflict this transaction did not already
    // have. FOR UPDATE would block the FK check of every concurrent INSERT that
    // references this job, and would build a FRESH cycle with the punch-list
    // door, which locks a work order and then writes a task whose job_id FK
    // wants this very row.
    const log = await shippedStart();
    const jobLocks = log.filter((e) => /\bFROM jobs\b/.test(e.sql) && /\bFOR\s+(UPDATE|KEY SHARE|NO KEY UPDATE|SHARE)\b/.test(e.sql));
    expect(jobLocks.map((e) => e.sql)).toEqual([JOBS_LOCK]);
  });

  test('MUTANT: without it the work order is locked first — the cycle is back', async () => {
    const mut = mutant(CO_SERVICE,
      "      await client.query(\n        '" + JOBS_LOCK + "',\n        [String(ticket.job_id), ticket.organization_id]\n      );\n",
      '');
    const ticket = eng.all("SELECT * FROM service_tickets WHERE id = 'st1'")[0];
    const log = await recordSql(async () => {
      const r = await mut.startChangeOrder(require('../server/db').pool, {
        ticket: ticket, user: { id: WIDE, name: 'Wendy Wide' }, body: NOTE_BODY,
      });
      expect(r.ok).toBe(true);
    });
    // The draft is still written — this never was a visible-behaviour bug. The
    // ORDER is the whole defect, and without the lock it is back: the work
    // order row is taken first and the jobs row only later, by the FK check.
    expect(newCoCount()).toBe(1);
    expect(at(log, JOBS_LOCK)).toBe(-1);
    expect(at(log, TICKET_LOCK)).toBe(at(log, 'BEGIN') + 1);
  });

  test('the job delete walks the same way: jobs first, then its work orders in id order', () => {
    // The other half of the pair, pinned from here too so moving either side on
    // its own goes red. The delete itself is driven in
    // test/job-delete-tickets.test.js.
    const del = fs.readFileSync(path.join(SERVICES_DIR, '..', 'routes', 'job-routes.js'), 'utf8');
    const jobsLock = del.indexOf("'SELECT estimate_id, lead_id FROM jobs WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL) FOR UPDATE'");
    const ticketLock = del.indexOf("'SELECT id FROM service_tickets WHERE job_id = $1 AND organization_id = $2 ORDER BY id FOR UPDATE'");
    expect(jobsLock).toBeGreaterThan(-1);
    expect(ticketLock).toBeGreaterThan(jobsLock);
  });
});
