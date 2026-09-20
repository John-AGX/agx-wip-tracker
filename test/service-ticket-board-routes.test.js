// THE SERVICE TICKETS PAGE — BOARD MODE OF GET /api/service-tickets, EXECUTED.
//
// ── WHAT THIS FILE PINS ───────────────────────────────────────────────────
// The board is the job tab's own list door with board=1. So:
//   1. SAME DOOR, SAME RULE. For every kind of caller, board view=all returns
//      exactly the ids the plain list returns, and a caller who can see nothing
//      gets { tickets: [] } without a statement touching the tickets.
//   2. TWO ORGS. Nothing of another tenant is listed, counted or named, even
//      when a child row (revision, share, event, flag, user) of that tenant
//      points at one of our ticket ids or user ids, or one of our tickets
//      names that tenant's job or lead.
//   3. THE VIEWS mean what the page says: overdue, due this week, my approvals
//      (write tier plus a relation), unassigned, mine, no link sent, flagged,
//      suggestions, closed.
//   4. COUNTS EQUAL ROWS, for every caller and every counted view and status
//      pill, and a search or an explicit filter narrows both together.
//   4b. THE PAGE'S FILTERS: the status pills (the job tab's groups), priority,
//      jobs or leads, and a search that also finds the assignee and a job by
//      its name.
//   5. SORT AND PAGING are stable, and the pages add up to the whole list.
//   6. THE JOB TAB IS UNCHANGED without board=1, apart from assignee=me/none.
//   7. POSTGRES BINDS. Every statement board mode ran prepared and ran, and
//      binds exactly the parameters it references.
//
// ── HOW ───────────────────────────────────────────────────────────────────
// The real router over a signed JWT, the real role cache, pg-sqlite with the
// fixture derived from server/db.js. Each guard is then removed from a copy of
// the shipped file (the route, or the board module loaded into a route copy)
// and the same drive is shown to go wrong. Anchors are CRLF-normalised and must
// match exactly once.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');
const tz = require('../server/timezone');
const board = require('../server/services/service-ticket-board');

const TICKET_ROUTES = path.join(__dirname, '..', 'server', 'routes', 'service-ticket-routes.js');
const BOARD = path.join(__dirname, '..', 'server', 'services', 'service-ticket-board.js');

const TABLES = [
  'organizations', 'users', 'roles', 'jobs', 'job_access', 'leads', 'tasks',
  'service_tickets', 'service_ticket_events', 'service_ticket_shares',
  'service_ticket_revisions', 'service_ticket_participants', 'service_ticket_flags',
  'attachments',
];

const WIDE = 10;      // JOBS_VIEW_ALL + JOBS_EDIT_ANY + both lead caps
const CREW = 20;      // JOBS_VIEW_ASSIGNED + JOBS_EDIT_OWN
const LEADER = 30;    // lead caps only
const NOBODY = 40;    // no ticket capability
const RIVAL = 50;     // another organization, wide

const USERS = {
  [WIDE]: { role: 'st_wide', org: 1 },
  [CREW]: { role: 'st_crew', org: 1 },
  [LEADER]: { role: 'st_leads', org: 1 },
  [NOBODY]: { role: 'st_none', org: 1 },
  [RIVAL]: { role: 'st_wide', org: 2 },
};

const TODAY = () => tz.localDateInTz('America/New_York', new Date());
const day = (n) => board.addDays(TODAY(), n);

// ORG 2 KEEPS ITS OWN CALENDAR. The board resolves "today" from the viewing
// org's timezone, and org 2 below is America/Los_Angeles while org 1 (and the
// helpers above) are America/New_York. A rival row seeded with day(-1) — New
// York's yesterday — is NOT yesterday in Los Angeles between midnight and
// 03:00 Eastern, when the two zones sit on different calendar days: the
// overdue view was then correctly empty and this fixture went red for three
// hours every night. The rival's dates come from the rival's own zone.
const TODAY_RIVAL = () => tz.localDateInTz('America/Los_Angeles', new Date());
const dayRival = (n) => board.addDays(TODAY_RIVAL(), n);
const FUTURE = () => new Date(Date.now() + 3 * 86400000).toISOString();
const PAST = () => new Date(Date.now() - 3 * 86400000).toISOString();

let eng;
let auth;
let ticketRouter;

function insert(table, row) {
  const keys = Object.keys(row);
  eng.db.prepare('INSERT INTO ' + table + ' (' + keys.join(', ') + ') VALUES (' + keys.map(() => '?').join(', ') + ')')
    .run(...keys.map((k) => row[k]));
}

let seq = 0;
function ticket(id, over) {
  seq += 1;
  insert('service_tickets', Object.assign({
    id,
    organization_id: 1,
    ticket_number: 'WO-' + String(seq).padStart(4, '0'),
    title: 'Ticket ' + id,
    job_id: 'j2',
    lead_id: null,
    status: 'open',
    priority: 'normal',
    due_date: null,
    scheduled_for: null,
    assignee_user_id: null,
    created_by: null,
    street_address: null,
    city: null,
    checklist: '[]',
    scope_approved: '$48,000 PRICED SCOPE',
    internal_notes: 'OFFICE-ONLY NOTE',
    created_at: '2026-09-01 10:00:' + String(seq % 60).padStart(2, '0'),
    updated_at: '2026-09-02 10:00:' + String(seq % 60).padStart(2, '0'),
  }, over || {}));
}

function share(id, ticketId, over) {
  insert('service_ticket_shares', Object.assign({
    id, organization_id: 1, ticket_id: ticketId, token_hash: 'h_' + id, scope: 'view',
    expires_at: FUTURE(), opened_at: null, revoked_at: null, view_count: 0, created_by: null,
    created_at: '2026-09-03 09:00:00',
  }, over || {}));
}

function seed() {
  const caps = (list) => JSON.stringify(list);
  seq = 0;
  eng.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM roles; DELETE FROM jobs;
    DELETE FROM job_access; DELETE FROM leads; DELETE FROM tasks; DELETE FROM service_tickets;
    DELETE FROM service_ticket_events; DELETE FROM service_ticket_shares;
    DELETE FROM service_ticket_revisions; DELETE FROM service_ticket_participants;
    DELETE FROM service_ticket_flags;
  `);
  insert('organizations', { id: 1, name: 'AGX', timezone: 'America/New_York' });
  insert('organizations', { id: 2, name: 'Other Co', timezone: 'America/Los_Angeles' });
  insert('roles', { name: 'st_wide', capabilities: caps(['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'LEADS_VIEW', 'LEADS_EDIT']) });
  insert('roles', { name: 'st_crew', capabilities: caps(['JOBS_VIEW_ASSIGNED', 'JOBS_EDIT_OWN']) });
  insert('roles', { name: 'st_leads', capabilities: caps(['LEADS_VIEW', 'LEADS_EDIT']) });
  insert('roles', { name: 'st_none', capabilities: caps(['ESTIMATES_VIEW']) });
  for (const [id, name, role, org] of [
    [WIDE, 'Wendy Wide', 'st_wide', 1], [CREW, 'Carl Crew', 'st_crew', 1],
    [LEADER, 'Lena Leads', 'st_leads', 1], [NOBODY, 'Nora None', 'st_none', 1],
    [RIVAL, 'RIVAL Ray', 'st_wide', 2],
    // Another tenant's user whose id an org-1 ticket names as its assignee.
    [70, 'RIVAL Twin', 'st_wide', 2],
  ]) insert('users', { id, name, email: id + '@t.test', role, organization_id: org });

  // j1: CREW has a VIEW grant.  j2: CREW has an EDIT grant.  j3: CREW owns it.
  insert('jobs', { id: 'j1', owner_id: WIDE, organization_id: 1, data: JSON.stringify({ jobNumber: 'RV2001', title: 'Waterside 1' }) });
  insert('jobs', { id: 'j2', owner_id: WIDE, organization_id: 1, data: JSON.stringify({ jobNumber: 'RV2002', title: 'Harbor Pointe' }) });
  insert('jobs', { id: 'j3', owner_id: CREW, organization_id: 1, data: JSON.stringify({ jobNumber: 'RV2003', title: 'Crew Owned' }) });
  insert('jobs', { id: 'j9', owner_id: RIVAL, organization_id: 2, data: JSON.stringify({ jobNumber: 'RV2001', title: 'Waterside 1' }) });
  // A job whose title is blank: the label falls back to its name, as the plain list's does.
  insert('jobs', { id: 'j4', owner_id: WIDE, organization_id: 1, data: JSON.stringify({ jobNumber: 'S-12', title: '', name: 'Named Only' }) });
  insert('job_access', { job_id: 'j1', user_id: CREW, access_level: 'view' });
  insert('job_access', { job_id: 'j2', user_id: CREW, access_level: 'edit' });
  insert('leads', { id: 'l1', title: 'Maple St reroof', salesperson_id: LEADER, organization_id: 1 });
  insert('leads', { id: 'l9', title: 'RIVAL lead', salesperson_id: RIVAL, organization_id: 2 });

  // ── overdue and due this week
  ticket('od_prog', { status: 'in_progress', due_date: day(-1) });
  ticket('od_open', { status: 'open', due_date: day(-1) });
  ticket('od_sched', { status: 'scheduled', due_date: day(-1) });
  ticket('due_today', { status: 'open', due_date: day(0) });
  ticket('od_wc', { status: 'work_complete', due_date: day(-1) });
  ticket('od_closed', { status: 'closed', due_date: day(-1) });
  ticket('od_draft', { status: 'draft', due_date: day(-1) });
  ticket('wk_6', { status: 'scheduled', due_date: day(6) });
  ticket('wk_7', { status: 'open', due_date: day(7) });
  ticket('cancelled', { status: 'cancelled' });

  // ── my approvals
  ticket('ap_pm', { status: 'work_complete' });                                         // WIDE runs j2
  ticket('ap_creator', { status: 'work_complete', job_id: 'j3', created_by: WIDE });
  ticket('ap_assignee', { status: 'work_complete', job_id: 'j3', assignee_user_id: WIDE });
  ticket('ap_sender', { status: 'work_complete', job_id: 'j3' });
  share('sh_ap_sender', 'ap_sender', { created_by: WIDE });
  ticket('ap_unrelated', { status: 'work_complete', job_id: 'j3', created_by: CREW });
  ticket('crew_sent_j2', { status: 'work_complete', job_id: 'j2' });
  share('sh_crew_sent', 'crew_sent_j2', { created_by: CREW });
  ticket('crew_view_j1', { status: 'work_complete', job_id: 'j1', assignee_user_id: CREW });
  ticket('lead_ap', { status: 'work_complete', job_id: null, lead_id: 'l1' });
  ticket('lead_open', { status: 'open', job_id: null, lead_id: 'l1', street_address: '415 Bayshore Blvd', city: 'Tampa' });

  // ── assignment
  ticket('mine_crew', { status: 'in_progress', job_id: 'j3', assignee_user_id: CREW });
  ticket('assigned_wide_draft', { status: 'draft', assignee_user_id: WIDE });
  ticket('named_job', { status: 'approved', job_id: 'j4', priority: 'high' });

  // ── crew links
  ticket('nl_never', { status: 'open' });
  ticket('nl_revoked', { status: 'open' });
  share('sh_revoked', 'nl_revoked', { revoked_at: PAST() });
  ticket('nl_expired', { status: 'scheduled' });
  share('sh_expired', 'nl_expired', { expires_at: PAST() });
  ticket('nl_live', { status: 'in_progress' });
  share('sh_live', 'nl_live', { opened_at: PAST() });

  // ── suggestions and flags
  ticket('sg_pending', { status: 'open' });
  insert('service_ticket_revisions', { id: 'rev_p', organization_id: 1, ticket_id: 'sg_pending', fields: '{}', status: 'pending', created_at: '2026-09-03 09:00:00' });
  ticket('sg_accepted', { status: 'open' });
  insert('service_ticket_revisions', { id: 'rev_a', organization_id: 1, ticket_id: 'sg_accepted', fields: '{}', status: 'accepted', created_at: '2026-09-03 09:00:00' });
  ticket('fl_open', { status: 'in_progress' });
  insert('service_ticket_flags', { id: 'flag_o', organization_id: 1, ticket_id: 'fl_open', category: 'safety', note: 'x', attachment_ids: '[]', status: 'open', created_at: '2026-09-03 09:00:00' });
  ticket('fl_resolved', { status: 'in_progress' });
  insert('service_ticket_flags', { id: 'flag_r', organization_id: 1, ticket_id: 'fl_resolved', category: 'safety', note: 'x', attachment_ids: '[]', status: 'resolved', resolved_at: PAST(), created_at: '2026-09-03 09:00:00' });

  // ── crew activity
  ticket('crew_active', { status: 'in_progress', office_seen_at: '2026-09-04 08:00:00' });
  insert('service_ticket_events', { id: 'ev1', organization_id: 1, ticket_id: 'crew_active', kind: 'note_added', actor_kind: 'share', detail: '{}', created_at: '2026-09-05 08:00:00' });
  insert('service_ticket_events', { id: 'ev2', organization_id: 1, ticket_id: 'crew_active', kind: 'share_opened', actor_kind: 'share', detail: '{}', created_at: '2026-09-06 08:00:00' });
  ticket('crew_opened_only', { status: 'in_progress' });
  insert('service_ticket_events', { id: 'ev3', organization_id: 1, ticket_id: 'crew_opened_only', kind: 'share_opened', actor_kind: 'share', detail: '{}', created_at: '2026-09-06 08:00:00' });

  // ── search and sort (every title carries SORTME)
  ticket('srt_d', { title: 'SORTME d', due_date: day(1), priority: 'low', created_at: '2026-08-01 10:00:00' });
  ticket('srt_b', { title: 'SORTME b', due_date: day(2), priority: 'urgent', created_at: '2026-08-01 10:00:00' });
  ticket('srt_a', { title: 'SORTME a', due_date: day(2), priority: 'normal', created_at: '2026-08-01 10:00:00' });
  ticket('srt_e', { title: 'SORTME e', due_date: day(2), priority: 'normal', created_at: '2026-08-01 10:00:00' });
  ticket('srt_c', { title: 'SORTME c', due_date: null, priority: 'urgent', created_at: '2026-08-01 10:00:00' });

  // ── the child-org plants: all organization_id = 2, all pointing at st_plain
  ticket('st_plain', { status: 'in_progress', job_id: 'j1', assignee_user_id: 70 });
  insert('service_ticket_revisions', { id: 'rev_x', organization_id: 2, ticket_id: 'st_plain', fields: '{}', status: 'pending', created_at: '2026-09-03 09:00:00' });
  share('sh_x', 'st_plain', { organization_id: 2, opened_at: PAST() });
  insert('service_ticket_events', { id: 'ev_x', organization_id: 2, ticket_id: 'st_plain', kind: 'note_added', actor_kind: 'share', detail: '{}', created_at: '2026-09-05 08:00:00' });
  insert('service_ticket_flags', { id: 'flag_x', organization_id: 2, ticket_id: 'st_plain', category: 'safety', note: 'x', attachment_ids: '[]', status: 'open', created_at: '2026-09-03 09:00:00' });
  // Org-1 tickets whose job_id and lead_id name the other tenant's job j9 and
  // lead l9: the row labels must stay empty, never that tenant's number or title.
  ticket('xorg_job', { status: 'open', job_id: 'j9' });
  ticket('xorg_lead', { status: 'open', job_id: null, lead_id: 'l9' });
  // A subtask for the counts: one org task done, and a PM's private to-do.
  insert('tasks', { id: 'k1', organization_id: 1, title: 'Bldg 1', status: 'done', scope: 'org', service_ticket_id: 'st_plain', entity_type: 'job', entity_id: 'j1', created_at: '2026-09-02 08:00:01' });
  insert('tasks', { id: 'k2', organization_id: 1, title: 'Bldg 2', status: 'open', scope: 'org', service_ticket_id: 'st_plain', entity_type: 'job', entity_id: 'j1', created_at: '2026-09-02 08:00:02' });
  insert('tasks', { id: 'k3', organization_id: 1, title: 'PRIVATE', status: 'open', scope: 'personal', owner_user_id: CREW, service_ticket_id: 'st_plain', entity_type: 'job', entity_id: 'j1', created_at: '2026-09-02 08:00:03' });

  // ── the other tenant: overdue, a suggestion, a live link, crew activity
  ticket('st_rival', { organization_id: 2, job_id: 'j9', status: 'in_progress', due_date: dayRival(-1), assignee_user_id: RIVAL, title: 'RIVAL overdue gate' });
  insert('service_ticket_revisions', { id: 'rev_r', organization_id: 2, ticket_id: 'st_rival', fields: '{}', status: 'pending', created_at: '2026-09-03 09:00:00' });
  share('sh_r', 'st_rival', { organization_id: 2, opened_at: PAST() });
  insert('service_ticket_events', { id: 'ev_r', organization_id: 2, ticket_id: 'st_rival', kind: 'note_added', actor_kind: 'share', detail: '{}', created_at: '2026-09-05 08:00:00' });
  insert('service_ticket_flags', { id: 'flag_rv', organization_id: 2, ticket_id: 'st_rival', category: 'safety', note: 'x', attachment_ids: '[]', status: 'open', created_at: '2026-09-03 09:00:00' });
}

beforeAll(async () => {
  eng = createPgSqlite(sqliteSchema(TABLES), {
    jsonColumns: ['checklist', 'capabilities', 'detail', 'fields', 'data'],
  });
  const db = require('../server/db');
  db.pool.query = eng.pool.query;
  db.pool.connect = eng.pool.connect;
  auth = require('../server/auth');
  auth.setRolePool(eng.pool);
  seed();
  await auth.refreshRoleCache();
  ticketRouter = require('../server/routes/service-ticket-routes');
});

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

const list = (router, as, query) => drive(router, 'get', '/', { as, query });
const boardOf = (router, as, query) => list(router, as, Object.assign({ board: '1', limit: '100' }, query || {}));
const ids = (res) => (res.body && res.body.tickets ? res.body.tickets.map((t) => t.id) : res.body);
const sorted = (res) => ids(res).slice().sort();
const rowOf = (res, id) => res.body.tickets.find((t) => t.id === id);

// ── mutant(): one guard removed from a copy of the shipped file ────────────
function absolutizeRequires(src, fromDir) {
  return src.replace(/require\((['"])([^'"]+)\1\)/g, (_m, _q, spec) => {
    const resolved = spec.charAt(0) === '.'
      ? require.resolve(path.resolve(fromDir, spec))
      : require.resolve(spec, { paths: [fromDir] });
    return 'require(' + JSON.stringify(resolved.split(path.sep).join('/')) + ')';
  });
}

function writeMutant(file, pairs, redirects) {
  // Normalised to LF, anchors written LF, each anchor exactly once.
  let out = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  for (const [find, replace] of pairs) {
    if (out.split(find).length !== 2) throw new Error('anchor not found');
    out = out.split(find).join(replace);
  }
  let copy = absolutizeRequires(out, path.dirname(file));
  for (const [from, to] of Object.entries(redirects || {})) {
    const ref = 'require(' + JSON.stringify(from.split(path.sep).join('/')) + ')';
    if (copy.split(ref).length < 2) throw new Error('anchor not found');
    copy = copy.split(ref).join('require(' + JSON.stringify(to.split(path.sep).join('/')) + ')');
  }
  const p = path.join(os.tmpdir(), '_p86_board_mutant_' + process.pid + '_' + Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, copy, 'utf8');
  mutantPaths.push(p);
  return p;
}

const routesMutant = (pairs, redirects) => require(writeMutant(TICKET_ROUTES, pairs, redirects));
// A route copy that loads a MUTATED board module.
const boardMutant = (pairs) => routesMutant([], { [require.resolve(BOARD)]: writeMutant(BOARD, pairs) });

describe('the mutation harness', () => {
  test('an absent anchor and an ambiguous anchor both throw', () => {
    expect(() => writeMutant(BOARD, [['this text is nowhere in the board', 'x']])).toThrow('anchor not found');
    expect(() => writeMutant(BOARD, [['organization_id = t.organization_id', 'x']])).toThrow('anchor not found');
  });

  test('both files are CRLF on disk, so the normalisation is load-bearing', () => {
    for (const f of [TICKET_ROUTES, BOARD]) expect(fs.readFileSync(f, 'utf8').indexOf('\r\n')).toBeGreaterThan(-1);
  });

  test('a board mutant is loaded by a DIFFERENT router over the same database', async () => {
    const mut = boardMutant([["out.error = 'Unknown sort';", "out.error = 'MUTANT sort';"]]);
    expect(mut).not.toBe(ticketRouter);
    expect((await boardOf(mut, WIDE, { sort: 'nope' })).body).toEqual({ error: 'MUTANT sort' });
    expect((await boardOf(ticketRouter, WIDE, { sort: 'nope' })).body).toEqual({ error: 'Unknown sort' });
  });
});

// ── 1. same door, same rule ───────────────────────────────────────────────
describe('the board lists exactly what the job tab list lists', () => {
  test('for every caller, board view=all ids equal the plain list ids', async () => {
    for (const as of [WIDE, CREW, LEADER, NOBODY, RIVAL]) {
      const plain = await list(ticketRouter, as, {});
      const all = await boardOf(ticketRouter, as, { view: 'all' });
      expect([as, all.statusCode]).toEqual([as, 200]);
      expect([as, sorted(all)]).toEqual([as, ids(plain).slice().sort()]);
    }
    // And the population is real, so the equality is not two empties.
    expect(ids(await boardOf(ticketRouter, WIDE, { view: 'all' })).length).toBeGreaterThan(30);
    expect(sorted(await boardOf(ticketRouter, LEADER, { view: 'all' }))).toEqual(['lead_ap', 'lead_open', 'xorg_lead']);
    expect(sorted(await boardOf(ticketRouter, RIVAL, { view: 'all' }))).toEqual(['st_rival']);
  });

  test('a caller who can see nothing gets { tickets: [] } and no ticket or org statement runs', async () => {
    const before = eng.log.length;
    const r = await boardOf(ticketRouter, NOBODY, { include_counts: '1' });
    expect([r.statusCode, r.body]).toEqual([200, { tickets: [] }]);
    expect(eng.log.slice(before).filter((e) => /service_tickets|organizations/i.test(e.sql))).toEqual([]);
  });
});

// ── 2. two orgs ───────────────────────────────────────────────────────────
describe('another tenant is never listed, counted or named', () => {
  test('every view and the counts, for every org-1 caller', async () => {
    for (const as of [WIDE, CREW, LEADER]) {
      for (const view of Object.keys(board.VIEWS)) {
        const r = await boardOf(ticketRouter, as, { view, include_counts: '1' });
        expect([as, view, r.statusCode]).toEqual([as, view, 200]);
        expect([as, view, JSON.stringify(r.body).indexOf('RIVAL')]).toEqual([as, view, -1]);
        expect(ids(r)).not.toContain('st_rival');
      }
    }
  });

  test('child rows of another org that point at our ticket are not counted, and its user is not named', async () => {
    const r = await boardOf(ticketRouter, WIDE, { view: 'all' });
    const t = rowOf(r, 'st_plain');
    expect([t.pending_suggestions, t.links_total, t.links_live, t.links_opened, t.open_flags])
      .toEqual([0, 0, 0, 0, 0]);
    expect([t.last_crew_at, t.assignee_name, t.new_from_crew]).toEqual([null, null, false]);
    expect(t.assignee_user_id).toBe(70);
    expect(ids(await boardOf(ticketRouter, WIDE, { view: 'flagged' }))).not.toContain('st_plain');
    expect(ids(await boardOf(ticketRouter, WIDE, { view: 'suggestions' }))).not.toContain('st_plain');
    expect(ids(await boardOf(ticketRouter, WIDE, { view: 'no_link' }))).toContain('st_plain');
  });

  test('a ticket whose job or lead id names another tenant\'s record carries no label from it', async () => {
    for (const as of [WIDE, LEADER]) {
      const r = await boardOf(ticketRouter, as, { view: 'all' });
      const lead = rowOf(r, 'xorg_lead');
      expect([as, lead.lead_id, lead.lead_title]).toEqual([as, 'l9', null]);
      expect(JSON.stringify(r.body)).not.toContain('RIVAL lead');
    }
    const job = rowOf(await boardOf(ticketRouter, WIDE, { view: 'all' }), 'xorg_job');
    expect([job.job_id, job.job_number, job.job_title]).toEqual(['j9', null, null]);
    // The same job number of our own j1 is labelled, so the null is the org rule, not a broken join.
    expect(rowOf(await boardOf(ticketRouter, WIDE, { view: 'all' }), 'crew_view_j1').job_number).toBe('RV2001');
  });

  test('the other org sees its own ticket, labelled and counted, and none of ours', async () => {
    const r = await boardOf(ticketRouter, RIVAL, { view: 'overdue', include_counts: '1' });
    expect(ids(r)).toEqual(['st_rival']);
    const t = rowOf(r, 'st_rival');
    expect([t.job_number, t.assignee_name, t.pending_suggestions, t.links_live, t.links_opened, t.open_flags, t.is_overdue])
      .toEqual(['RV2001', 'RIVAL Ray', 1, 1, 1, 1, true]);
    expect(r.body.counts.overdue).toBe(1);
    expect(r.body.today).toBe(tz.localDateInTz('America/Los_Angeles', new Date()));
  });
});

// ── 3. the views ──────────────────────────────────────────────────────────
describe('the views mean what the page says', () => {
  test('overdue: due before today and the crew not finished', async () => {
    const got = ids(await boardOf(ticketRouter, WIDE, { view: 'overdue' }));
    expect(got.slice().sort()).toEqual(['od_open', 'od_prog', 'od_sched']);
    for (const out of ['due_today', 'od_wc', 'od_closed', 'od_draft']) expect(got).not.toContain(out);
  });

  test('due this week: today through today+6, crew statuses', async () => {
    const got = ids(await boardOf(ticketRouter, WIDE, { view: 'due_week' }));
    expect(got).toEqual(expect.arrayContaining(['due_today', 'wk_6']));
    for (const out of ['wk_7', 'od_open', 'od_prog']) expect(got).not.toContain(out);
  });

  test('my approvals: work complete, the caller can edit it, and is on it', async () => {
    expect(sorted(await boardOf(ticketRouter, WIDE, { view: 'my_approvals' })))
      .toEqual(['ap_assignee', 'ap_creator', 'ap_pm', 'ap_sender', 'crew_sent_j2', 'crew_view_j1', 'od_wc'].sort());
    // CREW: j3 is theirs (PM of all four), j2 is an edit grant they sent the link
    // for; j1 is a VIEW grant, so being its assignee does not make it theirs to approve.
    expect(sorted(await boardOf(ticketRouter, CREW, { view: 'my_approvals' })))
      .toEqual(['ap_assignee', 'ap_creator', 'ap_sender', 'ap_unrelated', 'crew_sent_j2'].sort());
    expect(sorted(await boardOf(ticketRouter, LEADER, { view: 'my_approvals' }))).toEqual(['lead_ap']);
  });

  test('mine and unassigned', async () => {
    const mine = sorted(await boardOf(ticketRouter, CREW, { view: 'mine' }));
    expect(mine).toEqual(['crew_view_j1', 'mine_crew']);
    const un = ids(await boardOf(ticketRouter, WIDE, { view: 'unassigned' }));
    expect(un).toEqual(expect.arrayContaining(['od_draft', 'nl_never', 'od_prog']));
    for (const out of ['mine_crew', 'assigned_wide_draft', 'ap_pm', 'od_closed']) expect(un).not.toContain(out);
    expect(sorted(await boardOf(ticketRouter, WIDE, { view: 'mine' }))).toEqual(['ap_assignee', 'assigned_wide_draft']);
  });

  test('no link sent: never shared, revoked only and expired only are in; a live link is out', async () => {
    const got = ids(await boardOf(ticketRouter, WIDE, { view: 'no_link' }));
    expect(got).toEqual(expect.arrayContaining(['nl_never', 'nl_revoked', 'nl_expired']));
    expect(got).not.toContain('nl_live');
    expect(got).not.toContain('ap_pm');   // work complete is not "in the field"
    const live = rowOf(await boardOf(ticketRouter, WIDE, { view: 'all' }), 'nl_live');
    expect([live.links_total, live.links_live, live.links_opened]).toEqual([1, 1, 1]);
    const revoked = rowOf(await boardOf(ticketRouter, WIDE, { view: 'all' }), 'nl_revoked');
    expect([revoked.links_total, revoked.links_live]).toEqual([1, 0]);
  });

  test('suggestions, flagged and closed', async () => {
    expect(ids(await boardOf(ticketRouter, WIDE, { view: 'suggestions' }))).toEqual(['sg_pending']);
    expect(ids(await boardOf(ticketRouter, WIDE, { view: 'flagged' }))).toEqual(['fl_open']);
    expect(sorted(await boardOf(ticketRouter, WIDE, { view: 'closed' }))).toEqual(['cancelled', 'od_closed']);
    const all = await boardOf(ticketRouter, WIDE, { view: 'all' });
    expect([rowOf(all, 'fl_open').open_flags, rowOf(all, 'fl_resolved').open_flags]).toEqual([1, 0]);
    expect([rowOf(all, 'sg_pending').pending_suggestions, rowOf(all, 'sg_accepted').pending_suggestions]).toEqual([1, 0]);
  });

  test('crew activity skips share_opened, and New from crew compares it with the office\'s last look', async () => {
    const all = await boardOf(ticketRouter, WIDE, { view: 'all' });
    const active = rowOf(all, 'crew_active');
    expect(String(active.last_crew_at)).toMatch(/^2026-09-05/);
    expect(active.new_from_crew).toBe(true);
    expect([rowOf(all, 'crew_opened_only').last_crew_at, rowOf(all, 'crew_opened_only').new_from_crew]).toEqual([null, false]);
  });

  test('explicit primitives AND with the view', async () => {
    expect(ids(await boardOf(ticketRouter, WIDE, { view: 'open', due: 'overdue', status_group: 'crew' })).slice().sort())
      .toEqual(['od_open', 'od_prog', 'od_sched']);
    expect(ids(await boardOf(ticketRouter, WIDE, { view: 'closed', status_group: 'open' }))).toEqual([]);
  });

  test('rows are slim: labels, counts and dates, never scope, notes or prices', async () => {
    const r = await boardOf(ticketRouter, WIDE, { view: 'all' });
    for (const t of r.body.tickets) expect(Object.keys(t)).toEqual(board.BOARD_ROW_KEYS.slice());
    const body = JSON.stringify(r.body);
    expect(body).not.toContain('PRICED SCOPE');
    expect(body).not.toContain('OFFICE-ONLY');
    const plain = rowOf(r, 'st_plain');
    expect([plain.job_number, plain.job_title, plain.task_total, plain.task_done]).toEqual(['RV2001', 'Waterside 1', 2, 1]);
    expect(rowOf(r, 'lead_open').lead_title).toBe('Maple St reroof');
    expect(rowOf(r, 'od_prog').is_overdue).toBe(true);
    expect(rowOf(r, 'od_wc').is_overdue).toBe(false);
    expect(r.body.today).toBe(TODAY());
  });
});

// ── 4. counts equal rows ──────────────────────────────────────────────────
describe('every count is the length of its view', () => {
  test('for every caller and every counted view, and total is the selected view', async () => {
    for (const as of [WIDE, CREW, LEADER]) {
      const first = await boardOf(ticketRouter, as, { view: 'due_week', include_counts: '1' });
      expect(Object.keys(first.body.counts)).toEqual(board.COUNTED_VIEWS.slice());
      for (const view of board.COUNTED_VIEWS) {
        const rows = await boardOf(ticketRouter, as, { view });
        expect([as, view, first.body.counts[view]]).toEqual([as, view, rows.body.tickets.length]);
      }
      expect(first.body.total).toBe(first.body.tickets.length);
    }
    const w = (await boardOf(ticketRouter, WIDE, { include_counts: '1' })).body.counts;
    expect(w.overdue).toBe(3);
    expect(w.my_approvals).toBe(7);
  });

  test('a search narrows the counts and the rows together', async () => {
    const r = await boardOf(ticketRouter, WIDE, { view: 'open', q: 'SORTME', include_counts: '1' });
    expect(r.body.total).toBe(5);
    expect(r.body.counts.open).toBe(5);
    expect(r.body.counts.due_week).toBe(4);
    expect(r.body.counts.overdue).toBe(0);
  });

  test('explicit filters narrow every count the way they narrow that view\'s rows', async () => {
    for (const as of [WIDE, CREW, LEADER]) {
      for (const explicit of [{ due: 'overdue' }, { flags: 'open' }, { status_group: 'crew', link: 'none' }]) {
        const first = await boardOf(ticketRouter, as, Object.assign({ view: 'open', include_counts: '1' }, explicit));
        for (const view of board.COUNTED_VIEWS) {
          const rows = await boardOf(ticketRouter, as, Object.assign({ view }, explicit));
          expect([as, explicit, view, first.body.counts[view]]).toEqual([as, explicit, view, rows.body.tickets.length]);
        }
        expect(first.body.total).toBe(first.body.tickets.length);
      }
    }
    // Not vacuous: the overdue filter takes the open count from dozens to three.
    const w = (await boardOf(ticketRouter, WIDE, { view: 'open', due: 'overdue', include_counts: '1' })).body.counts;
    expect([w.open, w.unassigned, w.overdue, w.flagged]).toEqual([3, 3, 3, 0]);
    expect((await boardOf(ticketRouter, WIDE, { include_counts: '1' })).body.counts.open).toBeGreaterThan(20);
  });

  test('counts come only on request', async () => {
    const r = await boardOf(ticketRouter, WIDE, {});
    expect(Object.keys(r.body).sort()).toEqual(['has_more', 'next_offset', 'tickets', 'today']);
  });
});

// ── 4b. the page's filters ────────────────────────────────────────────────
describe('status pills, priority, jobs or leads', () => {
  test('each status group lists exactly the plain list\'s tickets in that group', async () => {
    for (const as of [WIDE, CREW, LEADER]) {
      const plain = (await list(ticketRouter, as, {})).body.tickets;
      for (const group of board.COUNTED_STATUS_GROUPS) {
        const want = plain.filter((t) => !board.STATUS_GROUPS[group] || board.STATUS_GROUPS[group].indexOf(t.status) >= 0).map((t) => t.id).sort();
        const got = sorted(await boardOf(ticketRouter, as, { view: 'all', status_group: group }));
        expect([as, group, got]).toEqual([as, group, want]);
      }
    }
    // Not vacuous: Active is four statuses and leaves draft, approved and closed out.
    const active = ids(await boardOf(ticketRouter, WIDE, { view: 'all', status_group: 'active' }));
    expect(active).toEqual(expect.arrayContaining(['od_prog', 'od_open', 'od_sched', 'od_wc']));
    for (const out of ['od_draft', 'named_job', 'od_closed', 'cancelled']) expect(active).not.toContain(out);
    expect(sorted(await boardOf(ticketRouter, WIDE, { view: 'all', status_group: 'closed' }))).toEqual(['cancelled', 'od_closed']);
  });

  test('priority and jobs or leads', async () => {
    expect(sorted(await boardOf(ticketRouter, WIDE, { view: 'all', q: 'SORTME', priority: 'urgent' }))).toEqual(['srt_b', 'srt_c']);
    expect(sorted(await boardOf(ticketRouter, WIDE, { view: 'all', priority: 'high' }))).toEqual(['named_job']);
    expect(sorted(await boardOf(ticketRouter, WIDE, { view: 'all', parent: 'lead' }))).toEqual(['lead_ap', 'lead_open', 'xorg_lead']);
    const jobs = ids(await boardOf(ticketRouter, WIDE, { view: 'all', parent: 'job' }));
    const every = ids(await boardOf(ticketRouter, WIDE, { view: 'all' }));
    expect(jobs.slice().sort()).toEqual(every.filter((id) => ['lead_ap', 'lead_open', 'xorg_lead'].indexOf(id) < 0).sort());
    expect((await boardOf(ticketRouter, WIDE, { priority: 'extreme' })).body).toEqual({ error: 'Unknown filter: priority' });
    expect((await boardOf(ticketRouter, WIDE, { parent: 'both' })).body).toEqual({ error: 'Unknown filter: parent' });
  });

  test('status counts equal rows, under a view and the other filters, for every caller', async () => {
    const queries = [
      { view: 'all' },
      { view: 'overdue' },
      { view: 'all', priority: 'normal', parent: 'job' },
      { view: 'unassigned', status_group: 'active' },
      { view: 'all', q: 'SORTME', status_group: 'closed' },
    ];
    for (const as of [WIDE, CREW, LEADER]) {
      for (const query of queries) {
        const first = await boardOf(ticketRouter, as, Object.assign({ include_counts: '1' }, query));
        expect(Object.keys(first.body.status_counts)).toEqual(board.COUNTED_STATUS_GROUPS.slice());
        for (const group of board.COUNTED_STATUS_GROUPS) {
          const rows = await boardOf(ticketRouter, as, Object.assign({}, query, { status_group: group }));
          expect([as, query, group, first.body.status_counts[group]]).toEqual([as, query, group, rows.body.tickets.length]);
        }
        for (const view of board.COUNTED_VIEWS) {
          const rows = await boardOf(ticketRouter, as, Object.assign({}, query, { view }));
          expect([as, query, view, first.body.counts[view]]).toEqual([as, query, view, rows.body.tickets.length]);
        }
        expect(first.body.total).toBe(first.body.tickets.length);
      }
    }
    // Not vacuous: the pills tell the groups apart.
    const w = (await boardOf(ticketRouter, WIDE, { view: 'all', include_counts: '1' })).body.status_counts;
    expect(w.closed).toBe(2);
    expect(w.all).toBeGreaterThan(w.active);
    expect(w.awaiting_approval).toBeGreaterThan(0);
  });

  test('a blank job title is labelled by the job\'s name, and a job ticket carries no lead title', async () => {
    const r = await boardOf(ticketRouter, WIDE, { view: 'all' });
    expect([rowOf(r, 'named_job').job_number, rowOf(r, 'named_job').job_title, rowOf(r, 'named_job').lead_title]).toEqual(['S-12', 'Named Only', null]);
  });
});

// ── 5. sort and paging ────────────────────────────────────────────────────
describe('sort and paging', () => {
  test('due sort: null due last, urgent before normal on a date, id breaks the tie', async () => {
    expect(ids(await boardOf(ticketRouter, WIDE, { q: 'SORTME' }))).toEqual(['srt_d', 'srt_b', 'srt_a', 'srt_e', 'srt_c']);
    expect(ids(await boardOf(ticketRouter, WIDE, { q: 'SORTME', sort: 'priority' }))).toEqual(['srt_b', 'srt_c', 'srt_a', 'srt_e', 'srt_d']);
  });

  test('pages of two add up to the whole list, with has_more and next_offset', async () => {
    const whole = ids(await boardOf(ticketRouter, WIDE, { q: 'SORTME' }));
    const got = [];
    const shape = [];
    for (const offset of [0, 2, 4]) {
      const r = await list(ticketRouter, WIDE, { board: '1', q: 'SORTME', limit: '2', offset: String(offset) });
      got.push(...ids(r));
      shape.push([r.body.has_more, r.body.next_offset]);
    }
    expect(got).toEqual(whole);
    expect(shape).toEqual([[true, 2], [true, 4], [false, null]]);
  });

  test('every sort runs for every view', async () => {
    for (const sort of Object.keys(board.SORTS)) {
      for (const view of Object.keys(board.VIEWS)) {
        expect([sort, view, (await boardOf(ticketRouter, CREW, { sort, view, include_counts: '1' })).statusCode])
          .toEqual([sort, view, 200]);
      }
    }
  });
});

// ── 6. search ─────────────────────────────────────────────────────────────
describe('board search', () => {
  test('job number, job title, address and lead title — never another org\'s job', async () => {
    const byNumber = ids(await boardOf(ticketRouter, WIDE, { view: 'all', q: 'RV2001' }));
    expect(byNumber.slice().sort()).toEqual(['crew_view_j1', 'st_plain']);
    expect(ids(await boardOf(ticketRouter, WIDE, { view: 'all', q: 'waterside' })).slice().sort()).toEqual(['crew_view_j1', 'st_plain']);
    expect(ids(await boardOf(ticketRouter, WIDE, { view: 'all', q: 'Bayshore' }))).toEqual(['lead_open']);
    expect(ids(await boardOf(ticketRouter, WIDE, { view: 'all', q: 'Maple' })).slice().sort()).toEqual(['lead_ap', 'lead_open']);
    expect(ids(await boardOf(ticketRouter, RIVAL, { view: 'all', q: 'RV2001' }))).toEqual(['st_rival']);
  });

  test('the assignee\'s name and a job\'s name — never another org\'s user', async () => {
    expect(sorted(await boardOf(ticketRouter, WIDE, { view: 'all', q: 'carl crew' }))).toEqual(['crew_view_j1', 'mine_crew']);
    expect(ids(await boardOf(ticketRouter, WIDE, { view: 'all', q: 'Named Only' }))).toEqual(['named_job']);
    // st_plain's assignee id is another tenant's user named RIVAL Twin.
    expect(ids(await boardOf(ticketRouter, WIDE, { view: 'all', q: 'Twin' }))).toEqual([]);
  });

  test('the plain list keeps its narrow search', async () => {
    expect(ids(await list(ticketRouter, WIDE, { q: 'RV2001' }))).toEqual([]);
  });
});

// ── 7. refusals and the job tab ───────────────────────────────────────────
describe('refusals, and the job tab is unchanged', () => {
  test('400 for an unknown view, sort or primitive, before any statement', async () => {
    const before = eng.log.length;
    expect([(await boardOf(ticketRouter, WIDE, { view: 'bogus' })).statusCode, (await boardOf(ticketRouter, WIDE, { view: 'bogus' })).body])
      .toEqual([400, { error: 'Unknown work order view' }]);
    expect((await boardOf(ticketRouter, WIDE, { sort: 'bogus' })).body).toEqual({ error: 'Unknown sort' });
    expect((await boardOf(ticketRouter, WIDE, { due: 'soon' })).body).toEqual({ error: 'Unknown filter: due' });
    expect(eng.log.length).toBe(before);
  });

  test('assignee=me and assignee=none work on the plain list too', async () => {
    expect(ids(await list(ticketRouter, CREW, { assignee: 'me' })).slice().sort()).toEqual(['crew_view_j1', 'mine_crew']);
    const none = ids(await list(ticketRouter, WIDE, { assignee: 'none' }));
    expect(none).toContain('nl_never');
    expect(none).not.toContain('mine_crew');
    expect(none).not.toContain('st_plain');
    expect(ids(await list(ticketRouter, WIDE, { assignee: String(WIDE) })).slice().sort()).toEqual(['ap_assignee', 'assigned_wide_draft']);
  });

  test('the plain list: body is { tickets }, TICKET_COLS plus the counts, newest first, private to-dos uncounted', async () => {
    const r = await list(ticketRouter, WIDE, {});
    expect(Object.keys(r.body)).toEqual(['tickets']);
    const t = rowOf(r, 'st_plain');
    expect(t).toHaveProperty('scope_approved');
    expect(t).toHaveProperty('internal_notes');
    expect([t.task_total, t.task_done]).toEqual([2, 1]);
    const created = r.body.tickets.map((x) => x.created_at);
    expect(created).toEqual(created.slice().sort().reverse());
    expect(r.body.tickets).toHaveLength(ids(await boardOf(ticketRouter, WIDE, { view: 'all' })).length);
  });
});

// ── 8. postgres binds ─────────────────────────────────────────────────────
describe('every board statement prepares, runs and binds exactly what it references', () => {
  const referenced = (sql) => [...new Set((sql.match(/\$(\d+)\b/g) || []).map((m) => Number(m.slice(1))))].sort((a, b) => a - b);

  test('with the page\'s filters on, for every caller and view', async () => {
    for (const as of [WIDE, CREW, LEADER]) {
      for (const view of Object.keys(board.VIEWS)) {
        const before = eng.log.length;
        const r = await boardOf(ticketRouter, as, { view, include_counts: '1', q: 'a', status_group: 'active', priority: 'high', parent: 'job' });
        expect([as, view, r.statusCode]).toEqual([as, view, 200]);
        const ran = eng.log.slice(before);
        expect(ran).toHaveLength(3);
        for (const e of ran) {
          expect([as, view, e.ok]).toEqual([as, view, true]);
          expect([as, view, referenced(e.sql)]).toEqual([as, view, e.params.map((_p, i) => i + 1)]);
        }
      }
    }
  });

  test('rows, counts and the date read, for every caller and view', async () => {
    for (const as of [WIDE, CREW, LEADER]) {
      for (const view of Object.keys(board.VIEWS)) {
        const before = eng.log.length;
        await boardOf(ticketRouter, as, { view, include_counts: '1', q: 'a' });
        const ran = eng.log.slice(before);
        expect(ran).toHaveLength(3);
        for (const e of ran) {
          expect([as, view, e.ok]).toEqual([as, view, true]);
          const refs = referenced(e.sql);
          expect([as, view, refs]).toEqual([as, view, e.params.map((_p, i) => i + 1)]);
        }
      }
    }
  });
});

// ── mutants ───────────────────────────────────────────────────────────────
describe('mutants', () => {
  test('a. drop the route\'s visibility gate and board=1 lists every org-1 ticket to a no-capability caller', async () => {
    const mut = routesMutant([[
      "    if (!visible.length) return res.json({ tickets: [] });\n    where.push('(' + visible.join(' OR ') + ')');",
      '    // MUTANT: no visibility gate']]);
    const every = sorted(await boardOf(ticketRouter, WIDE, { view: 'all' }));
    expect(sorted(await boardOf(mut, NOBODY, { view: 'all' }))).toEqual(every);
    expect(sorted(await boardOf(ticketRouter, NOBODY, { view: 'all' }))).toEqual([]);
  });

  test('b. drop the org predicate from pending_suggestions and the planted revision is counted', async () => {
    const mut = boardMutant([[
      "service_ticket_revisions r WHERE r.ticket_id = t.id AND r.organization_id = t.organization_id AND r.status = 'pending'",
      "service_ticket_revisions r WHERE r.ticket_id = t.id AND r.status = 'pending'"]]);
    expect(rowOf(await boardOf(mut, WIDE, { view: 'all' }), 'st_plain').pending_suggestions).toBe(1);
  });

  test('c. drop the write tier from My approvals and a view grant approves', async () => {
    const mut = boardMutant([[
      "return \"(t.status = 'work_complete' AND \" + tier + ' AND ' +",
      "return \"(t.status = 'work_complete' AND \" +"]]);
    expect(ids(await boardOf(mut, CREW, { view: 'my_approvals' }))).toContain('crew_view_j1');
    expect(ids(await boardOf(ticketRouter, CREW, { view: 'my_approvals' }))).not.toContain('crew_view_j1');
  });

  test('d. overdue < becomes <= and a ticket due today is overdue', async () => {
    const mut = boardMutant([[
      "return '(t.due_date IS NOT NULL AND t.due_date < ' + b.p('today', env.today)",
      "return '(t.due_date IS NOT NULL AND t.due_date <= ' + b.p('today', env.today)"]]);
    expect(ids(await boardOf(mut, WIDE, { view: 'overdue' }))).toContain('due_today');
  });

  test('e. drop revoked_at from No link sent and a revoked-only ticket leaves the view', async () => {
    const mut = boardMutant([[' AND sn.revoked_at IS NULL', '']]);
    expect(ids(await boardOf(mut, WIDE, { view: 'no_link' }))).not.toContain('nl_revoked');
  });

  test('f. counts built from the org predicate alone overcount a narrow-tier caller', async () => {
    const mut = boardMutant([
      ["const countsWhere = o.where.join(' AND ');", 'const countsWhere = o.where[0];'],
      ['const b = binder(o.baseParams);', 'const b = binder(o.baseParams.slice(0, 1));'],
    ]);
    const r = await boardOf(mut, CREW, { view: 'open', include_counts: '1' });
    expect(r.body.counts.open).toBeGreaterThan(r.body.tickets.length);
    const shipped = await boardOf(ticketRouter, CREW, { view: 'open', include_counts: '1' });
    expect(shipped.body.counts.open).toBe(shipped.body.tickets.length);
  });

  test('g. drop the org predicate from the assignee join and another tenant\'s user is named', async () => {
    const mut = boardMutant([[
      'LEFT JOIN users ua ON ua.id = t.assignee_user_id AND ua.organization_id = t.organization_id',
      'LEFT JOIN users ua ON ua.id = t.assignee_user_id']]);
    expect(rowOf(await boardOf(mut, WIDE, { view: 'all' }), 'st_plain').assignee_name).toBe('RIVAL Twin');
  });

  test('h. read last crew activity from every share event and a link opening counts as crew work', async () => {
    const mut = boardMutant([[" AND e.kind <> 'share_opened'", '']]);
    expect(rowOf(await boardOf(mut, WIDE, { view: 'all' }), 'crew_opened_only').last_crew_at).not.toBeNull();
  });

  test('i. put the route\'s caller id into the counts params and the bind check goes red', async () => {
    const mut = routesMutant([['    const baseParams = params.slice();', '    const baseParams = params.concat([null]);']]);
    const before = eng.log.length;
    await boardOf(mut, WIDE, { view: 'open', include_counts: '1' });
    const counts = eng.log.slice(before).find((e) => /FILTER/.test(e.sql));
    const refs = [...new Set((counts.sql.match(/\$(\d+)\b/g) || []).map((m) => Number(m.slice(1))))];
    expect(refs.length).not.toBe(counts.params.length);
  });

  test('j. drop the org predicate from the job label join and another tenant\'s job is named', async () => {
    const mut = boardMutant([[
      'LEFT JOIN jobs jl ON jl.id = t.job_id AND jl.organization_id = t.organization_id',
      'LEFT JOIN jobs jl ON jl.id = t.job_id']]);
    const job = rowOf(await boardOf(mut, WIDE, { view: 'all' }), 'xorg_job');
    expect([job.job_number, job.job_title]).toEqual(['RV2001', 'Waterside 1']);
  });

  test('k. drop the org predicate from the lead label join and another tenant\'s lead is named', async () => {
    const mut = boardMutant([[
      'LEFT JOIN leads ll ON ll.id = t.lead_id AND ll.organization_id = t.organization_id',
      'LEFT JOIN leads ll ON ll.id = t.lead_id']]);
    const r = await boardOf(mut, LEADER, { view: 'all' });
    expect(rowOf(r, 'xorg_lead').lead_title).toBe('RIVAL lead');
    expect(JSON.stringify(r.body)).toContain('RIVAL');
  });

  test('l. a narrow write arm that accepts any grant level lets a view grant approve', async () => {
    const mut = boardMutant([[" AND aw.access_level = 'edit')))", ')))']]);
    expect(ids(await boardOf(mut, CREW, { view: 'my_approvals' }))).toContain('crew_view_j1');
    expect(ids(await boardOf(ticketRouter, CREW, { view: 'my_approvals' }))).not.toContain('crew_view_j1');
  });

  test('m. counts that ignore the explicit filters overcount against the rows', async () => {
    const mut = boardMutant([["'(COUNT(*) FILTER (WHERE x.v_' + key + ' AND x.p_status AND x.p_other))::int AS c_' + key", "'(COUNT(*) FILTER (WHERE x.v_' + key + '))::int AS c_' + key"]]);
    const r = await boardOf(mut, WIDE, { view: 'open', due: 'overdue', include_counts: '1' });
    const rows = await boardOf(mut, WIDE, { view: 'unassigned', due: 'overdue' });
    expect(r.body.counts.unassigned).toBeGreaterThan(rows.body.tickets.length);
  });

  test('n. status counts that ignore the other filters overcount against the rows', async () => {
    const mut = boardMutant([["'(COUNT(*) FILTER (WHERE x.p_view AND x.g_' + group + ' AND x.p_other))::int AS s_' + group", "'(COUNT(*) FILTER (WHERE x.p_view AND x.g_' + group + '))::int AS s_' + group"]]);
    const r = await boardOf(mut, WIDE, { view: 'all', priority: 'urgent', include_counts: '1' });
    const rows = await boardOf(mut, WIDE, { view: 'all', priority: 'urgent', status_group: 'active' });
    expect(r.body.status_counts.active).toBeGreaterThan(rows.body.tickets.length);
    const shipped = await boardOf(ticketRouter, WIDE, { view: 'all', priority: 'urgent', include_counts: '1' });
    expect(shipped.body.status_counts.active).toBe(rows.body.tickets.length);
  });

  test('o. a status pill count that keeps the selected status says every pill has the selected rows', async () => {
    const mut = boardMutant([["'(COUNT(*) FILTER (WHERE x.p_view AND x.g_' + group + ' AND x.p_other))::int AS s_' + group", "'(COUNT(*) FILTER (WHERE x.p_view AND x.p_status AND x.p_other))::int AS s_' + group"]]);
    const r = await boardOf(mut, WIDE, { view: 'all', status_group: 'closed', include_counts: '1' });
    expect(r.body.status_counts.active).toBe(2);
    const shipped = await boardOf(ticketRouter, WIDE, { view: 'all', status_group: 'closed', include_counts: '1' });
    expect(shipped.body.status_counts.active).toBe(ids(await boardOf(ticketRouter, WIDE, { view: 'all', status_group: 'active' })).length);
    expect(shipped.body.status_counts.active).toBeGreaterThan(2);
  });

});
