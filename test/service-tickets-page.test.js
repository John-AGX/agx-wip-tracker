// THE SERVICE TICKETS PAGE — sidebar → Operations → Service Tickets.
//
// 1.29 shipped this page (js/service-tickets-page.js: the newest 200 tickets,
// filtered in the browser). 1.30 built a second company-wide list beside it
// (the Work Orders board: server-side views, counts and paging). There is now
// ONE page: the sidebar row, tab, URL and host are 1.29's, and it runs the
// board (js/work-orders-board.js over GET /api/service-tickets?board=1) with
// everything the 1.29 page had that the board lacked.
//
// ── WHAT THIS FILE PINS ───────────────────────────────────────────────────
//   1. THE LIST NAMES EACH TICKET'S PARENT AND ASSIGNEE, FROM THIS ORG ONLY.
//      GET /api/service-tickets (A1) returns job_number / job_title /
//      lead_title / assignee_name, and so does its board mode, which the page
//      reads. Each label comes from a LEFT JOIN that matches the ticket's own
//      organization, so a ticket pointed at another tenant's job, lead or user
//      shows a null label — never that tenant's name. A converted lead's
//      ticket belongs to its job, so it carries no lead_title. The joins
//      decorate; they do not change who sees what.
//   2. THE PAGE, run in jsdom against a stubbed p86Api that answers the way
//      the board does: the job tab's status pills (held to js/service-tickets.js
//      AND to the server's status groups), the priority / jobs or leads /
//      search filters, filters remembered under the 1.29 key, the saved views,
//      keyboard focus across a repaint, the empty and failure states, the
//      layout rules jsdom cannot lay out, calendar days in a REAL time zone (a
//      child node started with TZ), a job ticket opened on its job's tab
//      through the REAL js/service-tickets.js and a lead ticket on the lead,
//      the quiet refetch, the stale-response guards and ONE refetch per
//      service_ticket write. openTicket takes both of its call forms.
//   3. THE WIRING, by position rather than presence: the sidebar row sits
//      directly below the Jobs accordion inside Operations, the pane, the phone
//      More tile, the script and stylesheet, the router entry and app.js's
//      switchTab branch — and no second page: no Work Orders row, tile, pane,
//      tab or script, and /work-orders redirects to /service-tickets.
//
// ── HOW ───────────────────────────────────────────────────────────────────
// The server half drives the REAL router (requireAuth over a signed JWT, the
// real role cache) against node:sqlite through the pg shim, the same harness
// test/service-ticket-route-access.test.js uses. The page half evaluates the
// shipped browser files inside a JSDOM window. index.html is parsed with JSDOM
// (no scripts run) so the sidebar assertions are about the real DOM tree.
// test/work-orders-board-client.test.js drives the same page's requests, rows,
// crew badges, paging and mutants; test/service-ticket-board-routes.test.js
// executes the server side of every filter and count.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { JSDOM } = require('jsdom');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');
const board = require('../server/services/service-ticket-board');

const ROOT = path.join(__dirname, '..');
const readText = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. THE SERVER: A1 labels
 * ══════════════════════════════════════════════════════════════════════════*/
// service_ticket_flags and job_change_orders: the list reads each ticket's
// open problems (ATTENTION_COLUMNS) and merges the draft change orders started
// from it, so the tables production has are in the fixture too.
const TABLES = [
  'organizations', 'users', 'roles', 'jobs', 'job_access', 'leads', 'tasks',
  'service_tickets', 'service_ticket_events', 'service_ticket_shares',
  'service_ticket_revisions', 'service_ticket_participants', 'service_ticket_flags',
  'job_change_orders', 'attachments',
];

const WIDE = 10;
const LEADER = 30;
const NOBODY = 40;
const CREW = 20;
const RIVAL = 50;
const USERS = {
  [WIDE]: { role: 'stp_wide', org: 1 },
  [CREW]: { role: 'stp_crew', org: 1 },
  [LEADER]: { role: 'stp_leads', org: 1 },
  [NOBODY]: { role: 'stp_none', org: 1 },
  [RIVAL]: { role: 'stp_wide', org: 2 },
};

let eng;
let auth;
let ticketRouter;

function seed() {
  const caps = (list) => "'" + JSON.stringify(list) + "'";
  eng.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM roles; DELETE FROM jobs;
    DELETE FROM job_access; DELETE FROM leads; DELETE FROM tasks; DELETE FROM service_tickets;

    INSERT INTO organizations (id, name) VALUES (1, 'AGX'), (2, 'Rival Co');
    INSERT INTO roles (name, capabilities) VALUES
      ('stp_wide',  ${caps(['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'LEADS_VIEW', 'LEADS_EDIT'])}),
      ('stp_crew',  ${caps(['JOBS_VIEW_ASSIGNED'])}),
      ('stp_leads', ${caps(['LEADS_VIEW', 'LEADS_EDIT'])}),
      ('stp_none',  ${caps(['ESTIMATES_VIEW'])});
    INSERT INTO users (id, name, email, role, organization_id) VALUES
      (10, 'Wendy Wide', 'w@agx.test', 'stp_wide', 1),
      (20, 'Carl Crew', 'c@agx.test', 'stp_crew', 1),
      (30, 'Lena Leads', 'l@agx.test', 'stp_leads', 1),
      (40, 'Nora None', 'n@agx.test', 'stp_none', 1),
      (50, 'RIVAL-USER Ray', 'r@rival.test', 'stp_wide', 2);

    INSERT INTO jobs (id, owner_id, data, organization_id) VALUES
      ('j1', 10, '{"jobNumber":"RV2006","title":"Waterside Siding","name":"Old Name"}', 1),
      ('j2', 10, '{"jobNumber":"S-12","title":"","name":"Named Only"}', 1),
      ('j9', 50, '{"jobNumber":"RIVAL-9","title":"RIVAL-JOB Tower"}', 2);
    INSERT INTO leads (id, title, organization_id) VALUES
      ('l1', 'Maple St reroof', 1), ('l9', 'RIVAL-LEAD Plaza', 2);

    -- st_xjob / st_xlead / st_j1's assignee 50: an ORG-1 ticket pointed at an
    -- ORG-2 job, lead and user. The row is org 1's, so org 1 lists it; the
    -- label must not be read off org 2's row.
    INSERT INTO service_tickets (id, organization_id, title, job_id, lead_id, status, priority, assignee_user_id, checklist, created_at) VALUES
      ('st_j1',    1, 'Gate on j1',       'j1', NULL, 'open',     'high',   10,   '[]', '2026-09-01 10:00:01'),
      ('st_conv',  1, 'Converted gate',   'j1', 'l1', 'draft',    'normal', NULL, '[]', '2026-09-01 10:00:02'),
      ('st_l1',    1, 'Lead gate',        NULL, 'l1', 'open',     'low',    30,   '[]', '2026-09-01 10:00:03'),
      ('st_name',  1, 'Name fallback',    'j2', NULL, 'closed',   'normal', NULL, '[]', '2026-09-01 10:00:04'),
      ('st_xjob',  1, 'Foreign parent',   'j9', NULL, 'open',     'urgent', 50,   '[]', '2026-09-01 10:00:05'),
      ('st_xlead', 1, 'Foreign lead',     NULL, 'l9', 'open',     'normal', NULL, '[]', '2026-09-01 10:00:06'),
      ('st_b',     2, 'RIVAL ticket',     'j9', NULL, 'open',     'normal', 50,   '[]', '2026-09-01 10:00:07');
  `);
}

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

async function listTickets(router, as, query) {
  const layer = router.stack.find((l) => l.route && l.route.path === '/' && l.route.methods.get);
  if (!layer) throw new Error('GET / is not declared');
  const res = fakeRes();
  const req = {
    method: 'GET', params: {}, query: query || {}, body: {}, cookies: {},
    headers: { authorization: 'Bearer ' + tokenFor(as) },
    protocol: 'https', get: () => 'project86.test',
  };
  for (const h of layer.route.stack.map((s) => s.handle)) {
    let advanced = false;
    await h(req, res, (err) => { if (err) throw err; advanced = true; });
    if (!advanced) break;
  }
  return res;
}

const byId = (res) => {
  const out = {};
  for (const t of (res.body && res.body.tickets) || []) out[t.id] = t;
  return out;
};

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

beforeEach(() => seed());

const flushServer = () => new Promise((r) => setTimeout(r, 25));
afterAll(async () => {
  await flushServer();
  require('../server/db').pool.query = async () => ({ rows: [], rowCount: 0 });
  if (eng) eng.close();
});

describe('A1 names each ticket\'s job, lead and assignee', () => {
  test('a job ticket carries the job number, title (over the job\'s name) and assignee name', async () => {
    const r = await listTickets(ticketRouter, WIDE);
    expect(r.statusCode).toBe(200);
    const t = byId(r).st_j1;
    expect(t.job_number).toBe('RV2006');
    expect(t.job_title).toBe('Waterside Siding');
    expect(t.lead_title).toBeNull();
    expect(t.assignee_name).toBe('Wendy Wide');
    // The 1.30 reads the list gained ride along without failing it.
    expect([t.open_flags, t.pending_suggestions, t.co_draft_count, t.new_from_crew]).toEqual([0, 0, 0, false]);
  });

  test('an empty job title falls back to the job name', async () => {
    const t = byId(await listTickets(ticketRouter, WIDE)).st_name;
    expect(t.job_number).toBe('S-12');
    expect(t.job_title).toBe('Named Only');
  });

  test('a lead-only ticket carries the lead title; a converted lead\'s ticket (it has a job) does NOT', async () => {
    const wide = byId(await listTickets(ticketRouter, WIDE));
    expect(wide.st_conv.lead_id).toBe('l1');
    expect(wide.st_conv.lead_title).toBeNull();
    expect(wide.st_conv.job_number).toBe('RV2006');
    const leader = byId(await listTickets(ticketRouter, LEADER));
    expect(leader.st_l1.lead_title).toBe('Maple St reroof');
    expect(leader.st_l1.job_number).toBeNull();
    expect(leader.st_l1.assignee_name).toBe('Lena Leads');
  });

  test('a label is NEVER read off another organization\'s job, lead or user row', async () => {
    const wide = byId(await listTickets(ticketRouter, WIDE));
    expect(wide.st_xjob.job_id).toBe('j9');
    expect(wide.st_xjob.job_number).toBeNull();
    expect(wide.st_xjob.job_title).toBeNull();
    expect(wide.st_xjob.assignee_user_id).toBe(RIVAL);
    expect(wide.st_xjob.assignee_name).toBeNull();
    const leader = byId(await listTickets(ticketRouter, LEADER));
    expect(leader.st_xlead.lead_id).toBe('l9');
    expect(leader.st_xlead.lead_title).toBeNull();
    // And nothing of org 2's anywhere in either answer.
    const all = JSON.stringify(wide) + JSON.stringify(leader);
    expect(all).not.toMatch(/RIVAL-(JOB|LEAD|USER|9)/);
  });

  test('visibility is unchanged: the joins add and drop no rows', async () => {
    expect((await listTickets(ticketRouter, NOBODY)).body).toEqual({ tickets: [] });
    expect((await listTickets(ticketRouter, CREW)).body).toEqual({ tickets: [] });
    expect(Object.keys(byId(await listTickets(ticketRouter, WIDE))).sort())
      .toEqual(['st_conv', 'st_j1', 'st_l1', 'st_name', 'st_xjob', 'st_xlead']);
    expect(Object.keys(byId(await listTickets(ticketRouter, LEADER))).sort())
      .toEqual(['st_l1', 'st_xlead']);
    // Newest first still.
    expect((await listTickets(ticketRouter, WIDE)).body.tickets.map((t) => t.id))
      .toEqual(['st_xlead', 'st_xjob', 'st_name', 'st_l1', 'st_conv', 'st_j1']);
  });

  test('board mode, which the page reads, names them the same way, from this org only', async () => {
    const q = { board: '1', view: 'all', limit: '100' };
    const wide = byId(await listTickets(ticketRouter, WIDE, q));
    expect(Object.keys(wide).sort()).toEqual(['st_conv', 'st_j1', 'st_l1', 'st_name', 'st_xjob', 'st_xlead']);
    expect([wide.st_j1.job_number, wide.st_j1.job_title, wide.st_j1.assignee_name]).toEqual(['RV2006', 'Waterside Siding', 'Wendy Wide']);
    expect([wide.st_name.job_number, wide.st_name.job_title]).toEqual(['S-12', 'Named Only']);
    expect([wide.st_conv.job_number, wide.st_conv.lead_title]).toEqual(['RV2006', null]);
    expect([wide.st_xjob.job_number, wide.st_xjob.job_title, wide.st_xjob.assignee_name]).toEqual([null, null, null]);
    const leader = byId(await listTickets(ticketRouter, LEADER, q));
    expect([leader.st_l1.lead_title, leader.st_xlead.lead_title]).toEqual(['Maple St reroof', null]);
    expect(JSON.stringify(wide) + JSON.stringify(leader)).not.toMatch(/RIVAL-(JOB|LEAD|USER|9)/);
    expect((await listTickets(ticketRouter, NOBODY, q)).body).toEqual({ tickets: [] });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. THE PAGE, in jsdom
 * ══════════════════════════════════════════════════════════════════════════*/
const PAGE_SRC = readText('js/work-orders-board.js');
const TICKETS_SRC = readText('js/service-tickets.js');
const REFRESH_SRC = readText('js/refresh.js');
const JOB_LABEL = require('../js/job-label.js');

const tick = () => new Promise((r) => setTimeout(r, 0));
async function flush() { for (let i = 0; i < 8; i++) await tick(); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A stand-in for board mode that answers the way the server does: the status
// group from the server module's own STATUS_GROUPS, priority (none is
// Normal), jobs or leads, a search over title, WO #, job, lead and assignee,
// status_counts under everything but the status, and paging.
function serve(tickets, q, extra) {
  const x = extra || {};
  const needle = String(q.q || '').toLowerCase();
  const other = tickets.filter((t) => {
    if (q.priority && (t.priority || 'normal') !== q.priority) return false;
    if (q.parent === 'job' && !t.job_id) return false;
    if (q.parent === 'lead' && (t.job_id || !t.lead_id)) return false;
    if (needle && ![t.title, t.ticket_number, t.job_number, t.job_title, t.lead_title, t.assignee_name]
      .some((v) => String(v == null ? '' : v).toLowerCase().indexOf(needle) >= 0)) return false;
    return true;
  });
  const inGroup = (t, g) => !board.STATUS_GROUPS[g] || board.STATUS_GROUPS[g].indexOf(t.status) >= 0;
  const matching = other.filter((t) => !q.status_group || inGroup(t, q.status_group));
  const offset = Number(q.offset) || 0;
  const limit = Number(q.limit) || 50;
  const body = {
    tickets: matching.slice(offset, offset + limit),
    today: x.today || '2026-09-19',
    has_more: matching.length > offset + limit,
    next_offset: matching.length > offset + limit ? offset + limit : null,
  };
  if (q.include_counts) {
    body.total = matching.length;
    body.counts = Object.assign({ open: 0, my_approvals: 0, overdue: 0, due_week: 0, mine: 0, unassigned: 0, no_link: 0, flagged: 0, suggestions: 0 }, x.counts || {});
    body.status_counts = {};
    board.COUNTED_STATUS_GROUPS.forEach((g) => { body.status_counts[g] = other.filter((t) => inGroup(t, g)).length; });
  }
  return body;
}

function makePage(opts) {
  const o = opts || {};
  const dom = new JSDOM(
    '<!doctype html><html><head></head><body>' +
      '<div id="service-tickets" class="tab-content' + (o.inactive ? '' : ' active') + '"><div id="serviceTicketsHost"></div></div>' +
      (o.jobPane ? '<div id="job-service-tickets"></div>' : '') +
    '</body></html>',
    { runScripts: 'outside-only', url: 'https://project86.test' + (o.url || '/service-tickets') }
  );
  const w = dom.window;
  // Saved filters, seeded BEFORE the module is evaluated: it reads them once.
  if (o.storage != null) w.localStorage.setItem('p86_stp_filters', o.storage);
  w.p86JobLabel = JOB_LABEL;
  w.appData = { jobs: o.jobs || [{ id: 'j1', jobNumber: 'RV2006', title: 'Waterside Siding' }], leads: [] };
  const order = [];
  const listCalls = [];
  let responder = o.responder || ((q) => Promise.resolve(serve(o.tickets || [], q, o.serve)));
  w.p86Api = {
    serviceTickets: {
      list: (q) => { listCalls.push(Object.assign({}, q)); return responder(q, listCalls.length); },
    },
  };
  if (!o.noTicketsModule) w.p86ServiceTickets = { openTicket: function () { order.push(['openTicket'].concat(Array.from(arguments))); return true; } };
  w.p86Router = { go: (p) => { order.push(['go', p]); return true; }, navigate: (route) => order.push(['navigate', route]) };
  w.p86Toast = (msg, kind) => order.push(['toast', msg, kind]);
  if (o.before) o.before(w);
  w.eval(o.src || PAGE_SRC);
  const page = w.p86WorkOrdersBoard;
  page._assign = (href) => order.push(['assign', href]);
  const host = w.document.getElementById('serviceTicketsHost');
  const rows = () => Array.from(host.querySelectorAll('a.p86-wob-row'));
  const rowOf = (id) => rows().find((r) => r.getAttribute('data-id') === id) || null;
  return {
    w, dom, host, order, listCalls, page,
    setResponder: (fn) => { responder = fn; },
    render: () => page.render(host),
    rows,
    rowOf,
    rowIds: () => rows().map((r) => r.getAttribute('data-id')),
    pill: (id) => host.querySelector('.p86-wob-status [data-status="' + id + '"]'),
    view: (id) => host.querySelector('.p86-wob-views [data-view="' + id + '"]'),
    count: (el) => { const n = el && el.querySelector('.p86-st-pill-n'); return n ? Number(n.textContent) : null; },
    // A cell's text without its phone caption.
    cell: (id, c) => {
      const row = rowOf(id);
      const el = row && row.querySelector('.p86-wob-c-' + c);
      if (!el) return null;
      const copy = el.cloneNode(true);
      copy.querySelectorAll('.p86-wob-k').forEach((k) => k.remove());
      return copy.textContent;
    },
    parent: (id) => { const row = rowOf(id); return row ? row.querySelector('.p86-wob-job') : null; },
    list: () => host.querySelector('.p86-wob-list').textContent,
    last: () => listCalls[listCalls.length - 1],
    click: (el, init) => {
      const ev = new w.MouseEvent('click', Object.assign({ bubbles: true, cancelable: true, button: 0 }, init || {}));
      el.dispatchEvent(ev);
      return ev;
    },
    change: (sel, value) => {
      const el = host.querySelector(sel);
      el.value = value;
      el.dispatchEvent(new w.Event('change', { bubbles: true }));
      return el;
    },
  };
}

function ticket(over) {
  return Object.assign({
    id: 'st_x', ticket_number: null, title: 'A ticket', status: 'open', priority: 'normal',
    job_id: 'j1', lead_id: null, job_number: 'RV2006', job_title: 'Waterside Siding',
    lead_title: null, assignee_user_id: null, assignee_name: null,
    task_total: 0, task_done: 0, scheduled_for: null, due_date: null,
    links_total: 1, links_live: 1, links_opened: 0, pending_suggestions: 0, open_flags: 0,
    last_crew_at: null, office_seen_at: null, new_from_crew: false, is_overdue: false,
    updated_at: '2026-09-10T15:00:00.000Z', created_at: '2026-09-10T15:00:00.000Z',
  }, over);
}

const MIXED = () => [
  ticket({ id: 's_draft', status: 'draft', title: 'Draft one', priority: 'low' }),
  ticket({ id: 's_open', status: 'open', title: 'Open one', priority: 'urgent', assignee_name: 'Wendy Wide' }),
  ticket({ id: 's_sched', status: 'scheduled', title: 'Scheduled one', job_id: null, lead_id: 'l1', job_number: null, job_title: null, lead_title: 'Maple St reroof' }),
  ticket({ id: 's_prog', status: 'in_progress', title: 'Progress one', priority: 'high' }),
  ticket({ id: 's_done', status: 'work_complete', title: 'Awaiting one' }),
  ticket({ id: 's_appr', status: 'approved', title: 'Approved one' }),
  ticket({ id: 's_closed', status: 'closed', title: 'Closed one', job_number: 'S-40', job_title: 'Harbor Pointe' }),
  ticket({ id: 's_cancel', status: 'cancelled', title: 'Cancelled one', job_id: null, lead_id: 'l2', job_number: null, job_title: null, lead_title: 'Bay St leak' }),
];

const FIRST_REQUEST = { board: 1, view: 'all', sort: 'created', limit: 50, offset: 0, include_counts: 1 };

describe('the page renders the list', () => {
  test('first load says Loading…, asks board mode for every ticket, newest first, with counts, then renders a row per ticket', async () => {
    let resolve;
    const p = makePage({ responder: (q) => new Promise((r) => { resolve = () => r(serve(MIXED(), q)); }) });
    p.render();
    expect(p.list()).toBe('Loading service tickets…');
    await flush();
    expect(p.list()).toBe('Loading service tickets…');
    expect(p.listCalls).toEqual([FIRST_REQUEST]);
    resolve();
    await flush();
    expect(p.rowIds()).toEqual(['s_draft', 's_open', 's_sched', 's_prog', 's_done', 's_appr', 's_closed', 's_cancel']);
    expect(p.host.querySelector('h2').textContent).toBe('Service Tickets');
    expect(p.host.querySelector('.p86-wob-total').textContent).toBe('8 tickets');
    expect(p.host.textContent).not.toMatch(/Work Orders/);
  });

  test('the columns: parent label, status label, buildings, assignee, priority dot', async () => {
    const p = makePage({ tickets: [
      ticket({ id: 'a', task_total: 8, task_done: 3, assignee_name: 'Wendy Wide', priority: 'urgent', status: 'work_complete' }),
      ticket({ id: 'b', job_id: null, lead_id: 'l1', job_number: null, job_title: null, lead_title: 'Maple St reroof' }),
      ticket({ id: 'c', job_id: 'j9', job_number: null, job_title: null }),
      ticket({ id: 'd', job_id: null, lead_id: 'l9', job_number: null, job_title: null, lead_title: null }),
    ] });
    p.render();
    await flush();
    expect(p.parent('a').textContent).toBe('RV2006 Waterside Siding');
    expect(p.cell('a', 'status')).toBe('Work complete');
    expect(p.rowOf('a').querySelector('.p86-wob-c-status .p86-st-status.st-work_complete')).not.toBeNull();
    expect(p.rowOf('a').querySelector('.p86-wob-bldg-d').textContent).toBe('3/8');
    expect(p.cell('a', 'assignee')).toBe('Wendy Wide');
    expect(p.rowOf('a').querySelector('.p86-wob-c-prio .p86-st-prio.prio-urgent')).not.toBeNull();
    expect(p.parent('b').textContent).toBe('Lead · Maple St reroof');
    expect(p.cell('b', 'bldg')).toBe('—');
    expect(p.cell('b', 'assignee')).toBe('Unassigned');
    // A label the server could not name is said so — never the raw id.
    expect(p.parent('c').textContent).toBe('Job not found');
    expect(p.parent('c').classList.contains('p86-wob-missing')).toBe(true);
    expect(p.parent('d').textContent).toBe('Lead not found');
    expect(p.list()).not.toMatch(/\bj9\b|\bl9\b/);
    // Rows are real links, so a keyboard reaches them and Enter opens them.
    expect(p.rows().every((r) => r.tagName === 'A' && /^\/(jobs|leads)\//.test(r.getAttribute('href')))).toBe(true);
  });

  test('a hostile title, label and id are text, never markup', async () => {
    const evil = '<img src=x onerror="window.__pwned=1">';
    const p = makePage({ tickets: [ticket({
      id: 'st_"><b>id', title: evil, job_title: '"><script>window.__pwned=2</script>',
      assignee_name: '<i>who</i>', status: 'open',
    })] });
    p.render();
    await flush();
    expect(p.host.querySelector('img')).toBeNull();
    expect(p.host.querySelector('.p86-wob-list script, .p86-wob-list b, .p86-wob-list i')).toBeNull();
    expect(p.cell('st_"><b>id', 'assignee')).toBe('<i>who</i>');
    expect(p.host.querySelector('.p86-wob-title').textContent).toBe(evil);
    expect(p.w.__pwned).toBeUndefined();
    // The id survives the attribute intact, so the click still finds its ticket.
    p.click(p.rows()[0]);
    expect(p.order[0]).toEqual(['openTicket', 'j1', 'st_"><b>id']);
  });
});

// ── Days, in a REAL time zone ─────────────────────────────────────────────
// jest cannot change the worker's zone (test/calendar-dates-vs-instants.test.js
// measured it) and a Date faked inside the worker leaves Date.UTC, numeric
// constructors and the getters on the host's zone. So the page renders in a
// CHILD node started with TZ set: New York, where a UTC-day bug and the right
// day disagree, and UTC as the control proving the zone came from TZ.
function zoneChild() {
  const fs = require('fs');
  const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
  const { JSDOM } = require(payload.jsdom);
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="service-tickets" class="tab-content active"><div id="serviceTicketsHost"></div></div></body></html>',
    { runScripts: 'outside-only', url: 'https://project86.test/service-tickets' });
  const w = dom.window;
  w.p86JobLabel = require(payload.jobLabel);
  w.p86Api = { serviceTickets: { list: () => Promise.resolve({ tickets: payload.tickets, today: payload.today, has_more: false, next_offset: null }) } };
  w.eval(fs.readFileSync(payload.page, 'utf8'));
  const host = w.document.getElementById('serviceTicketsHost');
  Promise.resolve(w.p86WorkOrdersBoard.render(host))
    .then(() => new Promise((r) => setTimeout(r, 0)))
    .then(() => {
      const cells = {};
      host.querySelectorAll('a.p86-wob-row').forEach((row) => {
        const o = {};
        row.querySelectorAll('.p86-wob-cell').forEach((cell) => {
          const copy = cell.cloneNode(true);
          const k = copy.querySelector('.p86-wob-k');
          const label = k ? k.textContent : '';
          if (k) k.remove();
          if (label) o[label] = copy.textContent;
        });
        cells[row.getAttribute('data-id')] = o;
      });
      process.stdout.write(JSON.stringify({
        zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        rawDefect: w.eval("new Date('2026-09-20').getDate()"),
        cells: cells,
      }));
    })
    .catch((e) => { process.stderr.write(String((e && e.stack) || e)); process.exitCode = 1; });
}

function renderInZone(tz, tickets) {
  const stdout = execFileSync(process.execPath, ['-e', '(' + zoneChild.toString() + ')()'], {
    input: JSON.stringify({
      jsdom: require.resolve('jsdom'),
      jobLabel: path.join(ROOT, 'js', 'job-label.js'),
      page: path.join(ROOT, 'js', 'work-orders-board.js'),
      tickets: tickets,
      today: '2026-09-19',
    }),
    env: Object.assign({}, process.env, { TZ: tz }),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60000,
  });
  return JSON.parse(stdout);
}

describe('days in a real time zone', () => {
  const TZ_TICKETS = [
    ticket({ id: 'a', due_date: '2026-09-20', scheduled_for: '2026-09-18T00:00:00.000Z' }),
    ticket({ id: 'late', due_date: '2026-09-16T00:00:00.000Z', is_overdue: true }),
  ];
  let ny;
  let utc;
  beforeAll(() => {
    ny = renderInZone('America/New_York', TZ_TICKETS);
    utc = renderInZone('UTC', TZ_TICKETS);
  }, 120000);

  test('the zones are real: New York shows a bare new Date on a calendar day as the day before; UTC does not', () => {
    expect(ny.zone).toBe('America/New_York');
    expect(ny.rawDefect).toBe(19);
    expect(utc.rawDefect).toBe(20);
  });

  test('a calendar day is the day it names (20, not 19), in both spellings, in both zones', () => {
    for (const run of [ny, utc]) {
      expect(run.cells.a.Due).toMatch(/^Sep 20, 2026$/);
      expect(run.cells.a.Scheduled).toMatch(/^Sep 18, 2026$/);
    }
  });

  test('days late count from the server\'s today, the same in both zones', () => {
    for (const run of [ny, utc]) expect(run.cells.late.Due).toBe('Sep 16, 2026 · 3 days late');
  });
});

// The page's pills copy the job tab's. The job tab's own definitions are
// lifted out of js/service-tickets.js (by balanced brackets) and the RENDERED
// page, and the server's status groups it asks for, are held to them, so an
// edit on any side that makes a pill or a label mean something different fails.
function liftFrom(src, anchor) {
  const at = src.indexOf(anchor);
  if (at < 0) throw new Error('anchor missing: ' + anchor);
  if (src.indexOf(anchor, at + 1) >= 0) throw new Error('anchor not unique: ' + anchor);
  const close = { '{': '}', '[': ']' };
  const stack = [];
  let quote = null;
  for (let i = at + anchor.length - 1; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (close[c]) stack.push(close[c]);
    else if (c === '}' || c === ']') {
      if (stack.pop() !== c) throw new Error('unbalanced lifting ' + anchor);
      if (!stack.length) return src.slice(at, i + 1);
    }
  }
  throw new Error('unterminated: ' + anchor);
}

function jobTabDefs() {
  const src = TICKETS_SRC.replace(/\r\n/g, '\n');
  const code = [
    liftFrom(src, '  var STATUSES = ['),
    liftFrom(src, '  var STATUS_LABEL = {'),
    liftFrom(src, '  var FILTERS = ['),
    liftFrom(src, '  function matchesFilter(t) {'),
  ].join(';\n') + ';\n({ STATUSES: STATUSES, STATUS_LABEL: STATUS_LABEL, FILTERS: FILTERS, matchesFilter: matchesFilter })';
  const ME = 7;
  const sandbox = { _state: { filter: 'all' }, currentUserId: () => ME };
  const defs = vm.runInNewContext(code, sandbox);
  return {
    statuses: JSON.parse(JSON.stringify(defs.STATUSES)),
    labels: JSON.parse(JSON.stringify(defs.STATUS_LABEL)),
    filters: JSON.parse(JSON.stringify(defs.FILTERS)),
    matches: (status, filter, assignee) => {
      sandbox._state.filter = filter;
      return defs.matchesFilter({ status: status, assignee_user_id: assignee === undefined ? null : assignee });
    },
    me: ME,
  };
}

describe('status pills', () => {
  test('every pill, its label and what it lists are the job tab\'s own; every status label too', async () => {
    const tab = jobTabDefs();
    expect(tab.statuses).toHaveLength(8);
    const p = makePage({ tickets: tab.statuses.map((s) => ticket({ id: 'p_' + s, status: s })) });
    p.render();
    await flush();
    // Mine is the job tab's one person-shaped pill; here it is the Assigned to me view (next test).
    const tabPills = tab.filters.filter((f) => f.id !== 'mine');
    expect(tabPills.length).toBe(tab.filters.length - 1);
    expect(Array.from(p.host.querySelectorAll('.p86-wob-status .p86-st-pill')).map((b) => [b.getAttribute('data-status'), b.firstChild.textContent.trim()]))
      .toEqual(tabPills.map((f) => [f.id, f.label]));
    let groups = 0;
    for (const f of tabPills) {
      const want = tab.statuses.filter((s) => tab.matches(s, f.id)).map((s) => 'p_' + s);
      if (f.id !== 'all' && want.length > 1) groups++;
      p.click(p.pill(f.id));
      await flush();
      // What the page asks the server for is the group the job tab's pill matches.
      const asked = p.last().status_group;
      expect([f.id, asked === undefined ? null : asked]).toEqual([f.id, f.id === 'all' ? null : asked]);
      const served = asked ? board.STATUS_GROUPS[asked].slice() : tab.statuses.slice();
      expect([f.id, served.sort()]).toEqual([f.id, want.map((id) => id.slice(2)).sort()]);
      expect({ filter: f.id, rows: p.rowIds(), count: p.count(p.pill(f.id)), on: p.pill(f.id).getAttribute('aria-pressed') })
        .toEqual({ filter: f.id, rows: want, count: want.length, on: 'true' });
    }
    expect(groups).toBeGreaterThan(0); // Active and Closed really are groups on the job tab
    p.click(p.pill('all'));
    await flush();
    for (const s of tab.statuses) {
      expect([s, p.cell('p_' + s, 'status')]).toEqual([s, tab.labels[s]]);
      expect(p.rowOf('p_' + s).querySelector('.p86-st-status.st-' + s)).not.toBeNull();
    }
  });

  test('the job tab\'s Mine is the Assigned to me view: the same person, the same statuses', () => {
    const tab = jobTabDefs();
    expect(tab.filters.find((f) => f.id === 'mine')).toBeTruthy();
    expect(PAGE_SRC).toMatch(/\{ id: 'mine', label: 'Assigned to me',/);
    expect(board.VIEWS.mine).toEqual({ assignee: 'me', status_group: 'open' });
    const mineStatuses = tab.statuses.filter((s) => tab.matches(s, 'mine', tab.me));
    expect(board.STATUS_GROUPS.open.slice().sort()).toEqual(mineStatuses.sort());
    // Someone else's ticket is never Mine.
    expect(tab.statuses.some((s) => tab.matches(s, 'mine', tab.me + 1))).toBe(false);
  });

  test('a pill never sends `status` (the list door turns an unknown status into draft); counts come from the server', async () => {
    const p = makePage({ tickets: MIXED() });
    p.render();
    await flush();
    expect([p.count(p.pill('all')), p.count(p.pill('active')), p.count(p.pill('draft')), p.count(p.pill('scheduled')),
      p.count(p.pill('in_progress')), p.count(p.pill('work_complete')), p.count(p.pill('closed'))]).toEqual([8, 4, 1, 1, 1, 1, 2]);
    p.click(p.pill('active'));
    await flush();
    expect(p.rowIds()).toEqual(['s_open', 's_sched', 's_prog', 's_done']);
    expect(p.pill('active').classList.contains('active')).toBe(true);
    p.click(p.pill('closed'));
    await flush();
    expect(p.rowIds()).toEqual(['s_closed', 's_cancel']);
    expect(p.host.querySelector('.p86-wob-total').textContent).toBe('2 tickets');
    expect(p.listCalls.every((q) => !('status' in q))).toBe(true);
    expect(p.listCalls.map((q) => q.status_group)).toEqual([undefined, 'active', 'closed']);
    // Every change starts again from the top, with counts.
    expect(p.listCalls.every((q) => q.offset === 0 && q.include_counts === 1)).toBe(true);
  });
});

describe('priority, jobs or leads, and search', () => {
  test('each narrows the list through the server, and the pill counts follow them', async () => {
    const p = makePage({ tickets: MIXED() });
    p.render();
    await flush();
    p.change('.p86-wob-prio', 'urgent');
    await flush();
    expect(p.last()).toEqual(Object.assign({}, FIRST_REQUEST, { priority: 'urgent' }));
    expect(p.rowIds()).toEqual(['s_open']);
    expect(p.count(p.pill('all'))).toBe(1);
    p.change('.p86-wob-prio', 'all');
    await flush();

    p.change('.p86-wob-parent', 'lead');
    await flush();
    expect(p.last()).toEqual(Object.assign({}, FIRST_REQUEST, { parent: 'lead' }));
    expect(p.rowIds()).toEqual(['s_sched', 's_cancel']);
    expect(p.count(p.pill('closed'))).toBe(1);
    p.change('.p86-wob-parent', 'job');
    await flush();
    expect(p.rowIds()).toEqual(['s_draft', 's_open', 's_prog', 's_done', 's_appr', 's_closed']);
    p.change('.p86-wob-parent', 'all');
    await flush();

    const search = p.host.querySelector('.p86-wob-search');
    const type = async (v) => {
      search.value = v;
      search.dispatchEvent(new p.w.Event('input', { bubbles: true }));
      await wait(340);
      await flush();
    };
    await type('WENDY');
    expect(p.last().q).toBe('WENDY');
    expect(p.rowIds()).toEqual(['s_open']);
    await type('harbor');
    expect(p.rowIds()).toEqual(['s_closed']);
    await type('s-40');
    expect(p.rowIds()).toEqual(['s_closed']);
    await type('maple');
    expect(p.rowIds()).toEqual(['s_sched']);
    await type('progress one');
    expect(p.rowIds()).toEqual(['s_prog']);
    // The search box is not rebuilt under the caret.
    expect(p.host.querySelector('.p86-wob-search')).toBe(search);
    await type('nothing like this');
    expect(p.rowIds()).toEqual([]);
    expect(p.list()).toBe('No tickets match “nothing like this”.');
    await type('');
    p.change('.p86-wob-prio', 'low');
    p.change('.p86-wob-parent', 'lead');
    await flush();
    expect(p.list()).toBe('No tickets match these filters.');
  }, 20000);

  test('typing is debounced: one request for the word, not one per key', async () => {
    const p = makePage({ tickets: MIXED() });
    p.render();
    await flush();
    const search = p.host.querySelector('.p86-wob-search');
    for (const v of ['M', 'Ma', 'Map', 'Mapl', 'Maple']) {
      search.value = v;
      search.dispatchEvent(new p.w.Event('input', { bubbles: true }));
    }
    await wait(100);
    expect(p.listCalls).toHaveLength(1);
    await wait(300);
    await flush();
    expect(p.listCalls).toHaveLength(2);
    expect(p.last().q).toBe('Maple');
  });
});

describe('remembered filters', () => {
  test('filters survive a re-render (module state) and are kept in localStorage under the 1.29 key', async () => {
    const p = makePage({ tickets: MIXED() });
    p.render();
    await flush();
    p.click(p.pill('closed'));
    await flush();
    p.change('.p86-wob-sort', 'due');
    await flush();
    await p.render();
    await flush();
    expect(p.pill('closed').classList.contains('active')).toBe(true);
    expect(p.rowIds()).toEqual(['s_closed', 's_cancel']);
    expect(p.last()).toEqual({ board: 1, view: 'all', sort: 'due', limit: 50, offset: 0, include_counts: 1, status_group: 'closed' });
    expect(JSON.parse(p.w.localStorage.getItem('p86_stp_filters')))
      .toEqual({ status: 'closed', view: null, priority: 'all', parent: 'all', q: '', sort: 'due' });
  });

  test('filters the 1.29 page saved are RESTORED on a fresh page load', async () => {
    const p = makePage({ tickets: MIXED(), storage: JSON.stringify({ status: 'closed', priority: 'all', parent: 'lead', q: '' }) });
    p.render();
    await flush();
    expect(p.pill('closed').classList.contains('active')).toBe(true);
    expect(p.pill('all').classList.contains('active')).toBe(false);
    expect(p.host.querySelector('.p86-wob-parent').value).toBe('lead');
    expect(p.listCalls[0]).toEqual(Object.assign({}, FIRST_REQUEST, { status_group: 'closed', parent: 'lead' }));
    expect(p.rowIds()).toEqual(['s_cancel']);

    const q = makePage({ tickets: MIXED(), storage: JSON.stringify({ status: 'all', priority: 'urgent', parent: 'all', q: 'wendy' }) });
    q.render();
    await flush();
    expect(q.host.querySelector('.p86-wob-prio').value).toBe('urgent');
    expect(q.host.querySelector('.p86-wob-search').value).toBe('wendy');
    expect(q.listCalls[0]).toEqual(Object.assign({}, FIRST_REQUEST, { priority: 'urgent', q: 'wendy' }));
    expect(q.rowIds()).toEqual(['s_open']);
  });

  test('the view and the sort are remembered too', async () => {
    const p = makePage({ tickets: MIXED(), storage: JSON.stringify({ status: 'active', view: 'overdue', sort: 'priority' }) });
    p.render();
    await flush();
    expect(p.listCalls[0]).toEqual({ board: 1, view: 'overdue', sort: 'priority', limit: 50, offset: 0, include_counts: 1, status_group: 'active' });
    expect(p.view('overdue').getAttribute('aria-pressed')).toBe('true');
    expect(p.host.querySelector('.p86-wob-sort').value).toBe('priority');
  });

  test('junk in storage falls back to the defaults', async () => {
    const junk = ['{not json', JSON.stringify({ status: 'bogus', view: 'open', priority: 'x', parent: 7, q: 42, sort: 'toString' }), JSON.stringify(['closed'])];
    for (const raw of junk) {
      const p = makePage({ tickets: MIXED(), storage: raw });
      p.render();
      await flush();
      expect([raw, p.pill('all').classList.contains('active')]).toEqual([raw, true]);
      expect([raw, p.listCalls[0]]).toEqual([raw, FIRST_REQUEST]);
      expect(p.host.querySelector('.p86-wob-prio').value).toBe('all');
      expect(p.host.querySelector('.p86-wob-parent').value).toBe('all');
      expect(p.host.querySelector('.p86-wob-search').value).toBe('');
      expect(p.host.querySelectorAll('.p86-wob-views [aria-pressed="true"]')).toHaveLength(0);
      expect(p.rowIds()).toHaveLength(8);
    }
  });

  test('?view= on a full load opens that view with the other filters cleared, and leaves the address', async () => {
    for (const url of ['/service-tickets?view=my_approvals', '/work-orders?view=my_approvals']) {
      const p = makePage({ url, tickets: MIXED(), storage: JSON.stringify({ status: 'closed', priority: 'urgent', parent: 'lead', q: 'x', view: 'overdue', sort: 'due' }) });
      p.render();
      await flush();
      expect([url, p.listCalls[0]]).toEqual([url, { board: 1, view: 'my_approvals', sort: 'due', limit: 50, offset: 0, include_counts: 1 }]);
      expect(p.w.location.search).toBe('');
    }
    // A view that is not one is ignored, and still taken out of the address.
    const bad = makePage({ url: '/service-tickets?view=bogus&x=1', tickets: MIXED() });
    bad.render();
    await flush();
    expect(bad.listCalls[0]).toEqual(FIRST_REQUEST);
    expect(bad.w.location.search).toBe('?x=1');
  });
});

describe('saved views', () => {
  test('a view is pressed on and pressed again off; its count is the server\'s; a view that needs someone is marked', async () => {
    const p = makePage({ tickets: MIXED(), serve: { counts: { my_approvals: 2, overdue: 0, flagged: 1, unassigned: 5 } } });
    p.render();
    await flush();
    expect(Array.from(p.host.querySelectorAll('.p86-wob-views .p86-st-pill')).map((b) => b.getAttribute('data-view')))
      .toEqual(['my_approvals', 'overdue', 'due_week', 'mine', 'unassigned', 'no_link', 'flagged', 'suggestions']);
    expect(p.view('my_approvals').firstChild.textContent.trim()).toBe('My approvals');
    expect([p.count(p.view('my_approvals')), p.count(p.view('overdue')), p.count(p.view('unassigned'))]).toEqual([2, 0, 5]);
    expect(['my_approvals', 'overdue', 'flagged', 'unassigned'].map((v) => p.view(v).classList.contains('is-attention')))
      .toEqual([true, false, true, false]);
    p.click(p.view('unassigned'));
    await flush();
    expect(p.last()).toEqual(Object.assign({}, FIRST_REQUEST, { view: 'unassigned' }));
    expect(p.view('unassigned').getAttribute('aria-pressed')).toBe('true');
    p.click(p.view('unassigned'));
    await flush();
    expect(p.last()).toEqual(FIRST_REQUEST);
    expect(p.view('unassigned').getAttribute('aria-pressed')).toBe('false');
  });

  test('a caller who can see nothing: the empty state and no count badges', async () => {
    const p = makePage({ responder: () => Promise.resolve({ tickets: [] }) });
    p.render();
    await flush();
    expect(p.list()).toBe("No service tickets yet. Raise one from a job's Service Tickets tab or from a lead.");
    expect(p.host.querySelectorAll('.p86-st-pill-n')).toHaveLength(0);
  });
});

describe('keyboard focus survives a repaint', () => {
  test('pressing a status pill or a view keeps focus on it', async () => {
    const p = makePage({ tickets: MIXED() });
    p.render();
    await flush();
    for (const [get, attr, id] of [[p.pill, 'data-status', 'active'], [p.view, 'data-view', 'overdue']]) {
      const before = get(id);
      before.focus();
      expect(p.w.document.activeElement).toBe(before);
      p.click(before);
      expect(before.isConnected).toBe(false); // the pills really were rebuilt
      await flush();
      const now = p.w.document.activeElement;
      expect(now.isConnected).toBe(true);
      expect(now.getAttribute(attr)).toBe(id);
    }
  });

  test('a quiet refetch keeps focus on the same row', async () => {
    const p = makePage({ tickets: MIXED() });
    p.render();
    await flush();
    const row = p.rowOf('s_prog');
    row.focus();
    expect(p.w.document.activeElement).toBe(row);
    await p.page.refresh();
    await flush();
    expect(row.isConnected).toBe(false);
    expect(p.w.document.activeElement.getAttribute('data-id')).toBe('s_prog');
  });

  test('Show more with the keyboard: focus moves to the first row it added', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ticket({ id: 'm' + i }));
    const p = makePage({ tickets: many });
    p.render();
    await flush();
    const more = p.host.querySelector('.p86-wob-more');
    more.focus();
    p.click(more);
    await flush();
    expect(p.rowIds()).toHaveLength(60);
    expect(p.last()).toEqual({ board: 1, view: 'all', sort: 'created', limit: 50, offset: 50 });
    expect(p.w.document.activeElement.getAttribute('data-id')).toBe('m50');
  });
});

describe('empty and failure states', () => {
  test('a failed first load offers Try again, and says Loading… while it retries', async () => {
    const p = makePage({ responder: () => Promise.reject(new Error('<b>down</b>')) });
    p.render();
    await flush();
    expect(p.list()).toBe("Couldn't load service tickets. Try again");
    expect(p.host.querySelector('.p86-wob-list b')).toBeNull();
    let resolve;
    p.setResponder((q) => new Promise((r) => { resolve = () => r(serve(MIXED(), q)); }));
    p.click(p.host.querySelector('.p86-wob-retry'));
    await flush();
    expect(p.list()).toBe('Loading service tickets…');
    resolve();
    await flush();
    expect(p.rowIds()).toHaveLength(8);
    expect(p.host.querySelector('.p86-wob-error')).toBeNull();
  });

  test('a failed QUIET refetch keeps the list up and says so', async () => {
    const p = makePage({ tickets: MIXED() });
    p.render();
    await flush();
    p.setResponder(() => Promise.reject(new Error('blip')));
    p.render();
    await flush();
    expect(p.rowIds()).toHaveLength(8);
    expect(p.order).toContainEqual(['toast', "Couldn't refresh service tickets — showing what was loaded before.", 'error']);
  });

  test('a view with nothing in it says what the view is for', async () => {
    const p = makePage({ tickets: [], storage: JSON.stringify({ view: 'overdue' }) });
    p.render();
    await flush();
    expect(p.list()).toBe('Nothing is overdue.');
  });
});

// ── Layout rules jsdom cannot lay out ────────────────────────────────────
// jsdom has no layout engine, so these read the stylesheet's CSSOM: the rules
// that keep the desktop dot visible, the filter controls on one line and each
// phone control a finger's size.
function sheetRules() {
  const dom = new JSDOM('<!doctype html><html><head><style>' + readText('css/work-orders-board.css') + '</style></head><body></body></html>');
  const out = [];
  const walk = (list, media) => Array.from(list).forEach((r) => {
    if (r.cssRules && r.media) walk(r.cssRules, r.media.mediaText);
    else if (r.selectorText) out.push({ media: media, sels: r.selectorText.split(',').map((s) => s.trim()), style: r.style });
  });
  walk(dom.window.document.querySelector('style').sheet.cssRules, null);
  return out;
}
const declOf = (rules, sel, phone, prop) => rules
  .filter((r) => r.sels.includes(sel) && (phone ? /max-width:\s*760px/.test(r.media || '') && !/coarse/.test(r.media || '') : r.media === null))
  .map((r) => r.style.getPropertyValue(prop))
  .filter(Boolean);

describe('layout rules', () => {
  test('the priority dot is a box, the filter controls size to the row, and a phone control is finger-sized', async () => {
    const rules = sheetRules();
    // css/styles.css .p86-st-prio sizes the dot but sets no display, and an
    // empty inline span is 0x0.
    expect(declOf(rules, '.p86-wob-c-prio .p86-st-prio', false, 'display')).toEqual(['inline-block']);
    const p = makePage({ tickets: MIXED() });
    p.render();
    await flush();
    expect(p.host.querySelector('.p86-wob-c-prio > .p86-st-prio')).not.toBeNull();
    // css/styles.css gives every input and select width:100%.
    expect(declOf(rules, '.p86-wob-select', false, 'width')).toEqual(['auto']);
    expect(declOf(rules, '.p86-wob-search', false, 'width')).toEqual(['auto']);
    expect(p.host.querySelectorAll('.p86-wob-controls select.p86-wob-select')).toHaveLength(3);
    // Phone: 44px tall controls with 16px text (no zoom on focus).
    for (const sel of ['.p86-wob-select', '.p86-wob-search']) {
      expect([sel, declOf(rules, sel, true, 'min-height')]).toEqual([sel, ['44px']]);
      expect([sel, declOf(rules, sel, true, 'font-size')]).toEqual([sel, ['16px']]);
    }
  });
});

// The real job tab, in a window beside the page, driven the way the app
// drives it: the router opens the job and renders its Service Tickets tab.
function jobTabEnv(w, tickets) {
  w.appState = { currentJobId: null };
  w.p86Auth = { hasCapability: () => true, getUser: () => ({ id: 1 }) };
  w.p86Confirm = () => Promise.resolve(true);
  w.p86ConfirmTernary = () => Promise.resolve(null);
  w.HTMLElement.prototype.scrollIntoView = function () {};
  const api = w.p86Api.serviceTickets;
  const boardList = api.list;
  api.list = (q) => (q && q.board ? boardList(q) : Promise.resolve({ tickets: tickets.filter((t) => t.job_id === q.job_id) }));
  api.get = (id) => Promise.resolve({ ticket: tickets.find((t) => t.id === id), tasks: [], events: [], revisions: [], participants: [], shares: [] });
  api.assignees = () => Promise.resolve({ users: [] });
  api.shares = () => Promise.resolve({ shares: [] });
  w.p86Api.users = { list: () => Promise.resolve({ users: [] }) };
}

describe('opening a ticket', () => {
  test('a job ticket, through the REAL job tab: the job\'s Service Tickets tab opens with that ticket expanded', async () => {
    const jobTickets = [
      ticket({ id: 'st_77', title: 'Gate', status: 'closed', checklist: [] }),
      ticket({ id: 'st_78', title: 'Other', status: 'open', checklist: [] }),
    ];
    const navigated = [];
    const p = makePage({
      jobPane: true,
      noTicketsModule: true,
      tickets: jobTickets,
      before: (w) => {
        jobTabEnv(w, jobTickets);
        w.eval(TICKETS_SRC);
        w.p86Router = {
          navigate: (route) => {
            navigated.push(route);
            w.appState.currentJobId = route.jobId;
            w.renderJobServiceTickets(route.jobId);
          },
        };
      },
    });
    const opened = [];
    const real = p.w.p86ServiceTickets.openTicket;
    p.w.p86ServiceTickets.openTicket = function () { opened.push(Array.from(arguments)); return real.apply(this, arguments); };
    p.render();
    await flush();
    p.click(p.rowOf('st_77'));
    await flush();
    expect(opened).toEqual([['j1', 'st_77']]);
    expect(navigated).toEqual([{ top: 'jobs', jobId: 'j1', jobSub: 'job-service-tickets' }]);
    const open = p.w.document.querySelector('#job-service-tickets .p86-st-row.is-open');
    expect(open && open.getAttribute('data-ticket')).toBe('st_77');
    expect(p.order.filter((e) => e[0] === 'assign')).toEqual([]);
  });

  test('a lead-only ticket opens the lead, and asks the job tab for nothing', async () => {
    const p = makePage({ tickets: MIXED() });
    p.render();
    await flush();
    p.click(p.rowOf('s_sched'));
    expect(p.order).toEqual([['go', '/leads/l1']]);
  });

  test('a job this browser has not loaded is a full load of the row\'s link, which opens the ticket from ?ticket=', async () => {
    const p = makePage({ tickets: [ticket({ id: 'st_far', job_id: 'j7' })] });
    p.render();
    await flush();
    p.click(p.rowOf('st_far'));
    expect(p.order).toEqual([['assign', '/jobs/j7/job-service-tickets?ticket=st_far']]);
  });
});

describe('openTicket takes both call forms (js/service-tickets.js)', () => {
  function jobTab(tickets) {
    const dom = new JSDOM('<!doctype html><html><body><div id="job-service-tickets"></div></body></html>',
      { runScripts: 'outside-only', url: 'https://project86.test/jobs/j1/job-service-tickets' });
    const w = dom.window;
    const navigated = [];
    w.appData = { jobs: [{ id: 'j1', jobNumber: 'RV2006', title: 'Waterside' }], leads: [] };
    w.p86JobLabel = JOB_LABEL;
    w.p86Toast = () => {};
    w.p86Api = { serviceTickets: { list: () => Promise.resolve({ tickets: [] }) } };
    jobTabEnv(w, tickets);
    w.eval(TICKETS_SRC);
    w.p86Router = {
      navigate: (route) => { navigated.push(route); w.appState.currentJobId = route.jobId; w.renderJobServiceTickets(route.jobId); },
    };
    const openId = () => { const o = w.document.querySelector('.p86-st-row.is-open'); return o && o.getAttribute('data-ticket'); };
    return { w, navigated, openId };
  }
  const T = () => [
    ticket({ id: 'st_77', title: 'Gate', status: 'open', checklist: [] }),
    ticket({ id: 'st_78', title: 'Other', status: 'open', checklist: [] }),
  ];

  test('openTicket(ticketId), the 1.29 form: the ticket is marked, and the job\'s next render expands it', async () => {
    const t = jobTab(T());
    t.w.appState.currentJobId = 'j1';
    t.w.renderJobServiceTickets('j1');
    await flush();
    expect(t.openId()).toBeNull();
    // Already on this job's tab: the next render still honours it.
    expect(t.w.p86ServiceTickets.openTicket('st_78')).toBe(true);
    expect(t.navigated).toEqual([]);   // the caller navigates, as the 1.29 page did
    t.w.renderJobServiceTickets('j1');
    await flush();
    expect(t.openId()).toBe('st_78');
  });

  test('openTicket(ticketId) before any job is on screen opens on the job loaded next', async () => {
    const t = jobTab(T());
    expect(t.w.p86ServiceTickets.openTicket('st_77')).toBe(true);
    t.w.appState.currentJobId = 'j1';
    t.w.renderJobServiceTickets('j1');
    await flush();
    expect(t.openId()).toBe('st_77');
  });

  test('openTicket(jobId, ticketId) goes to the job and expands the ticket', async () => {
    const t = jobTab(T());
    expect(t.w.p86ServiceTickets.openTicket('j1', 'st_78')).toBe(true);
    await flush();
    expect(t.navigated).toEqual([{ top: 'jobs', jobId: 'j1', jobSub: 'job-service-tickets' }]);
    expect(t.openId()).toBe('st_78');
  });

  test('no ticket id, in either form, is false and opens nothing', async () => {
    const t = jobTab(T());
    const st = t.w.p86ServiceTickets;
    expect([st.openTicket(), st.openTicket(''), st.openTicket(null), st.openTicket('j1', ''), st.openTicket('', 'st_77'), st.openTicket('j1', null)])
      .toEqual([false, false, false, false, false, false]);
    expect(t.navigated).toEqual([]);
    t.w.appState.currentJobId = 'j1';
    t.w.renderJobServiceTickets('j1');
    await flush();
    expect(t.openId()).toBeNull();
  });

  test('every caller in js/ uses a form openTicket takes', () => {
    const calls = [];
    for (const f of fs.readdirSync(path.join(ROOT, 'js')).filter((n) => n.endsWith('.js'))) {
      const src = readText('js/' + f);
      for (const m of src.matchAll(/\.openTicket\(([^)]*)\)/g)) calls.push([f, m[1].trim() === '' ? 0 : m[1].split(',').length]);
    }
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((c) => c[1] < 1 || c[1] > 2)).toEqual([]);
    expect(calls.map((c) => c[0])).not.toContain('service-tickets-page.js');
  });
});

describe('refetching', () => {
  test('a later render refetches QUIETLY: the list stays up until the new data lands', async () => {
    const p = makePage({ tickets: MIXED() });
    p.render();
    await flush();
    let resolve;
    p.setResponder((q) => new Promise((r) => { resolve = () => r(serve([ticket({ id: 'fresh' })], q)); }));
    p.render();
    await flush();
    expect(p.list()).not.toMatch(/Loading/);
    expect(p.rowIds()).toHaveLength(8);
    resolve();
    await flush();
    expect(p.rowIds()).toEqual(['fresh']);
  });

  test('an older response never overwrites a newer one', async () => {
    const pending = [];
    const p = makePage({ responder: (q) => new Promise((r) => pending.push((list) => r(serve(list, q)))) });
    p.render();
    p.click(p.pill('closed'));
    await flush();
    expect(pending).toHaveLength(2);
    pending[1]([ticket({ id: 'newer', status: 'closed' })]);
    await flush();
    pending[0]([ticket({ id: 'older' })]);
    await flush();
    expect(p.rowIds()).toEqual(['newer']);
  });

  test('an older FAILED response never puts an error over a newer list', async () => {
    const pending = [];
    const p = makePage({ responder: (q) => new Promise((res, rej) => pending.push({ res: (list) => res(serve(list, q)), rej })) });
    p.render();
    p.click(p.pill('closed'));
    await flush();
    expect(pending).toHaveLength(2);
    pending[1].res([ticket({ id: 'newer', status: 'closed' })]);
    await flush();
    pending[0].rej(new Error('older failed'));
    await flush();
    expect(p.host.querySelector('.p86-wob-error')).toBeNull();
    expect(p.rowIds()).toEqual(['newer']);
  });

  test('refresh() refetches only while the page is the one on screen', async () => {
    const p = makePage({ tickets: MIXED() });
    await p.page.refresh();
    expect(p.listCalls).toHaveLength(0); // never rendered
    p.render();
    await flush();
    await p.page.refresh();
    expect(p.listCalls).toHaveLength(2);
    p.w.document.getElementById('service-tickets').classList.remove('active');
    await p.page.refresh();
    expect(p.listCalls).toHaveLength(2);
  });

  test('a service_ticket write refetches the page ONCE, with the real job tab and js/refresh.js loaded', async () => {
    const p = makePage({
      jobPane: true,
      noTicketsModule: true,
      tickets: MIXED(),
      before: (w) => { jobTabEnv(w, []); w.eval(TICKETS_SRC); w.eval(REFRESH_SRC); },
    });
    p.render();
    await flush();
    const boardCalls = () => p.listCalls.filter((q) => q.board === 1).length;
    expect(boardCalls()).toBe(1);
    await p.w.p86Refresh.now('service_ticket', { id: 's_open' });
    await flush();
    expect(boardCalls()).toBe(2);
    // And the job tab's own refresh (the change order module calls it) does not fetch the page again.
    await p.w.p86ServiceTickets.refresh();
    await flush();
    expect(boardCalls()).toBe(2);
    expect(p.w.p86Refresh.paths('service_ticket')).toEqual(['p86ServiceTickets.refresh', 'p86WorkOrdersBoard.refresh']);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. THE WIRING
 * ══════════════════════════════════════════════════════════════════════════*/
const CAPS = 'JOBS_VIEW_ALL JOBS_VIEW_ASSIGNED LEADS_VIEW';
let indexDoc;
function index() {
  if (!indexDoc) indexDoc = new JSDOM(readText('index.html')).window.document;
  return indexDoc;
}

describe('index.html', () => {
  test('the sidebar row is the next element after the Jobs accordion, directly above Schedule, in Operations', () => {
    const doc = index();
    const rows = doc.querySelectorAll('.tab-btn[data-tab="service-tickets"]');
    expect(rows).toHaveLength(1);
    const row = rows[0];
    const group = row.parentElement;
    expect(group.classList.contains('app-nav-group')).toBe(true);
    expect(group.querySelector(':scope > .app-nav-group-label').textContent.trim()).toBe('Operations');
    const prev = row.previousElementSibling;
    expect(prev.matches('.app-nav-parent[data-accordion="jobs"]')).toBe(true);
    expect(row.nextElementSibling.matches('.tab-btn[data-tab="schedule"]')).toBe(true);
    expect(row.getAttribute('data-cap')).toBe(CAPS);
    expect(row.textContent.trim()).toBe('Service Tickets');
    expect(row.hasAttribute('data-p86-icon')).toBe(true);
  });

  test('ONE company-wide page: no Work Orders row, tile, pane or host anywhere', () => {
    const doc = index();
    expect(doc.querySelectorAll('[data-tab="work-orders"]')).toHaveLength(0);
    expect(doc.getElementById('work-orders')).toBeNull();
    expect(doc.getElementById('workOrdersHost')).toBeNull();
    expect(Array.from(doc.querySelectorAll('[onclick]')).filter((b) => /work-orders/.test(b.getAttribute('onclick')))).toEqual([]);
    const live = readText('index.html').replace(/<!--[\s\S]*?-->/g, '');
    expect(live).not.toMatch(/>\s*Work Orders\s*</);
  });

  test('the pane sits with the other top-level pages and holds the host', () => {
    const doc = index();
    const pane = doc.getElementById('service-tickets');
    expect(pane.classList.contains('tab-content')).toBe(true);
    expect(pane.querySelector(':scope > #serviceTicketsHost')).not.toBeNull();
    expect(pane.parentElement).toBe(doc.getElementById('invoices').parentElement);
  });

  test('the phone More sheet: first tile under Operations, same capabilities, routes to the page', () => {
    const doc = index();
    const tile = Array.from(doc.querySelectorAll('.p86-mobile-more-tile'))
      .filter((b) => /p86MoreGo\('service-tickets'\)/.test(b.getAttribute('onclick') || ''));
    expect(tile).toHaveLength(1);
    const grid = tile[0].parentElement;
    expect(grid.hasAttribute('data-more-grid')).toBe(true);
    expect(grid.previousElementSibling.textContent.trim()).toBe('Operations');
    expect(grid.firstElementChild).toBe(tile[0]);
    expect(tile[0].getAttribute('data-cap')).toBe(CAPS);
    expect(tile[0].textContent.trim()).toBe('Service Tickets');
    expect(tile[0].nextElementSibling.getAttribute('onclick')).toMatch(/p86MoreGo\('cost-inbox'\)/);
  });

  test('the page\'s script loads once, after api.js, job-label.js and js/service-tickets.js; its stylesheet once; the 1.29 page\'s script is gone', () => {
    const scripts = Array.from(index().querySelectorAll('script[src]')).map((s) => s.getAttribute('src'));
    const at = scripts.findIndex((s) => /^js\/work-orders-board\.js\?v=\d+$/.test(s));
    expect(at).toBeGreaterThan(-1);
    expect(scripts.filter((s) => /^js\/work-orders-board\.js/.test(s))).toHaveLength(1);
    for (const dep of ['api', 'job-label', 'service-tickets']) {
      const d = scripts.findIndex((s) => new RegExp('^js/' + dep + '\\.js\\?v=').test(s));
      expect([dep, d > -1 && d < at]).toEqual([dep, true]);
    }
    expect(scripts.filter((s) => /service-tickets-page/.test(s))).toEqual([]);
    expect(fs.existsSync(path.join(ROOT, 'js', 'service-tickets-page.js'))).toBe(false);
    const links = Array.from(index().querySelectorAll('link[rel="stylesheet"][href]')).map((l) => l.getAttribute('href'));
    expect(links.filter((h) => /^css\/work-orders-board\.css\?v=\d+$/.test(h))).toHaveLength(1);
  });
});

describe('router and app.js', () => {
  function loadRouter(pathname, search) {
    const pushed = [];
    const replaced = [];
    const switched = [];
    const listeners = {};
    const win = {
      location: { pathname: pathname || '/', search: search || '', hash: '' },
      history: {
        pushState: (state, title, url) => { pushed.push(url); if (url) { win.location.pathname = url.split('?')[0]; } },
        replaceState: (state, title, url) => { replaced.push(url); if (url) { win.location.pathname = url.split('?')[0]; win.location.search = url.indexOf('?') >= 0 ? url.slice(url.indexOf('?')) : ''; } },
      },
      addEventListener: (type, fn) => { listeners[type] = fn; },
      removeEventListener: () => {},
      setTimeout: () => {},
      appState: {},
      switchTab: (tab) => switched.push(tab),
      document: {
        getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
        addEventListener: () => {}, readyState: 'complete',
      },
      console: { warn: () => {}, log: () => {}, error: () => {} },
    };
    win.window = win;
    const sandbox = {
      window: win, document: win.document, location: win.location, history: win.history,
      console: win.console, setTimeout: win.setTimeout, clearTimeout: () => {},
      setInterval: () => {}, clearInterval: () => {},
    };
    vm.createContext(sandbox);
    vm.runInContext(readText('js/router.js'), sandbox);
    return { router: win.p86Router, pushed, replaced, switched, listeners, win };
  }

  test('/service-tickets deep-links, and navigate() writes it back', () => {
    const { router, pushed, replaced } = loadRouter('/service-tickets');
    expect(router.route().top).toBe('service-tickets');
    expect(router.canGo('/service-tickets')).toBe(true);
    expect(replaced).toEqual([]);
    router.navigate({ top: 'service-tickets' });
    expect(pushed).toEqual(['/service-tickets']);
  });

  test('/work-orders redirects to /service-tickets: on load (keeping the query), through go(), and on Back', () => {
    const boot = loadRouter('/work-orders', '?view=my_approvals');
    expect(boot.replaced).toEqual(['/service-tickets?view=my_approvals']);
    expect(boot.win.location.pathname).toBe('/service-tickets');
    expect(boot.router.route()).toEqual({ top: 'service-tickets' });

    const r = loadRouter('/');
    expect(r.replaced).toEqual([]);
    expect(r.router.canGo('/work-orders')).toBe(true);
    expect(r.router.tops()).not.toContain('work-orders');
    expect(r.router.tops()).toContain('service-tickets');
    expect(r.router.go('/work-orders')).toBe(true);
    expect(r.pushed).toEqual(['/service-tickets']);
    expect(r.switched).toEqual(['service-tickets']);
    // A history entry written while the old tab existed lands on the page too.
    r.listeners.popstate({ state: { route: { top: 'work-orders' } } });
    expect(r.switched).toEqual(['service-tickets', 'service-tickets']);
    // Nothing else is redirected.
    r.router.go('/invoices');
    expect(r.pushed).toEqual(['/service-tickets', '/invoices']);
  });

  test('app.js: the title, and ONE switchTab branch that renders the page into its host', () => {
    const src = readText('js/app.js').replace(/\r\n/g, '\n');
    const titles = src.slice(src.indexOf('var TAB_TITLES = {'), src.indexOf('};', src.indexOf('var TAB_TITLES = {')));
    expect(titles).toMatch(/\n\s*'service-tickets': 'Service Tickets',\n/);
    expect(titles).not.toMatch(/work-orders/);

    const start = src.indexOf('        function switchTab(tabName) {');
    const end = src.indexOf('\n        }\n', start);
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, end);
    // No branch of its own: the retired id is folded into this page at the top.
    expect(body).not.toMatch(/else if \(tabName === 'work-orders'\)|workOrdersHost|p86ServiceTicketsPage/);
    expect(body).toMatch(/if \(tabName === 'work-orders'\) tabName = 'service-tickets';/);
    const open = "} else if (tabName === 'service-tickets') {";
    const at = body.indexOf(open);
    expect(at).toBeGreaterThan(-1);
    expect(body.indexOf(open, at + 1)).toBe(-1);
    const branch = body.slice(at + open.length, body.indexOf("} else if (tabName === ", at + open.length));
    expect(branch).toMatch(/document\.getElementById\('serviceTicketsHost'\)/);
    expect(branch).toMatch(/window\.p86WorkOrdersBoard\.render\(stHost\)/);
    expect(branch).toMatch(/Service Tickets module not loaded\./);
    expect(branch).not.toMatch(/renderJobsMain|p86JobsHubRefresh|p86JobDetailRefresh|load\w*ForJob/);
    // The final catch-all that paints the Jobs list comes AFTER the branch, so
    // the branch is what runs for this tab.
    expect(body.lastIndexOf('renderJobsMain')).toBeGreaterThan(at);
  });

  test('86 is pointed at /service-tickets only', () => {
    const src = readText('server/routes/admin-agents-routes.js');
    const plain = src.split(/\r?\n/).find((l) => l.indexOf("'- Plain pages:") >= 0);
    expect(plain).toMatch(/ \/service-tickets /);
    expect(src).not.toMatch(/\/work-orders|Work Orders page|newest 200/);
  });
});
