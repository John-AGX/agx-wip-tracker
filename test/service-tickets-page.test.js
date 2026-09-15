// THE SERVICE TICKETS PAGE — sidebar → Operations → Service Tickets.
//
// ── WHAT THIS FILE PINS ───────────────────────────────────────────────────
//   1. THE LIST NAMES EACH TICKET'S PARENT AND ASSIGNEE, FROM THIS ORG ONLY.
//      GET /api/service-tickets (A1) now returns job_number / job_title /
//      lead_title / assignee_name. Each label comes from a LEFT JOIN that
//      matches the ticket's own organization, so a ticket pointed at another
//      tenant's job, lead or user shows a null label — never that tenant's
//      name. A converted lead's ticket belongs to its job, so it carries no
//      lead_title. The joins decorate; they do not change who sees what.
//   2. THE PAGE (js/service-tickets-page.js) run in jsdom against a stubbed
//      p86Api: rows, escaping, the status pills and their counts, the priority /
//      parent / search filters, the 200-row note, the empty states, the row
//      click that opens the ticket on its job (or the lead), calendar days and
//      local days in a REAL time zone (a child node started with TZ), the pills
//      held to js/service-tickets.js's own definitions, filters restored from
//      storage, keyboard focus across a repaint, the quiet refetch and the
//      stale-response guard on both the success and the failure path.
//   3. THE WIRING, by position rather than presence: the sidebar row sits
//      directly below the Jobs accordion inside Operations, the pane, the phone
//      More tile, the script tag, the router entry, and app.js's switchTab
//      branch.
//
// ── HOW ───────────────────────────────────────────────────────────────────
// The server half drives the REAL router (requireAuth over a signed JWT, the
// real role cache) against node:sqlite through the pg shim, the same harness
// test/service-ticket-route-access.test.js uses. The page half evaluates the
// shipped browser file inside a JSDOM window. index.html is parsed with JSDOM
// (no scripts run) so the sidebar assertions are about the real DOM tree.
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

const ROOT = path.join(__dirname, '..');
const readText = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. THE SERVER: A1 labels
 * ══════════════════════════════════════════════════════════════════════════*/
const TABLES = [
  'organizations', 'users', 'roles', 'jobs', 'job_access', 'leads', 'tasks',
  'service_tickets', 'service_ticket_events', 'service_ticket_shares',
  'service_ticket_revisions', 'service_ticket_participants', 'attachments',
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

async function listTickets(router, as) {
  const layer = router.stack.find((l) => l.route && l.route.path === '/' && l.route.methods.get);
  if (!layer) throw new Error('GET / is not declared');
  const res = fakeRes();
  const req = {
    method: 'GET', params: {}, query: {}, body: {}, cookies: {},
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
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. THE PAGE, in jsdom
 * ══════════════════════════════════════════════════════════════════════════*/
const PAGE_SRC = readText('js/service-tickets-page.js');
const JOB_LABEL = require('../js/job-label.js');

const tick = () => new Promise((r) => setTimeout(r, 0));
async function flush() { for (let i = 0; i < 6; i++) await tick(); }

function makePage(opts) {
  const o = opts || {};
  const dom = new JSDOM(
    '<!doctype html><html><head></head><body>' +
      '<div id="service-tickets" class="tab-content' + (o.inactive ? '' : ' active') + '"><div id="serviceTicketsHost"></div></div>' +
    '</body></html>',
    { runScripts: 'outside-only', url: 'https://project86.test/service-tickets' }
  );
  const w = dom.window;
  // Saved filters, seeded BEFORE the module is evaluated: it reads them once.
  if (o.storage != null) w.localStorage.setItem('p86_stp_filters', o.storage);
  w.p86JobLabel = JOB_LABEL;
  const order = [];
  const listCalls = [];
  let responder = o.responder || (() => Promise.resolve({ tickets: (o.tickets || []).slice() }));
  w.p86Api = {
    serviceTickets: {
      list: (q) => { listCalls.push(q); return responder(q, listCalls.length); },
    },
  };
  if (!o.noTicketsModule) w.p86ServiceTickets = { openTicket: (id) => order.push(['openTicket', id]) };
  w.p86Router = { navigate: (route) => order.push(['navigate', route]) };
  w.eval(o.src || PAGE_SRC);
  const host = w.document.getElementById('serviceTicketsHost');
  return {
    w, dom, host, order, listCalls,
    setResponder: (fn) => { responder = fn; },
    render: () => w.p86ServiceTicketsPage.render(host),
    rows: () => Array.from(host.querySelectorAll('tr.stp-row')),
    rowIds: () => Array.from(host.querySelectorAll('tr.stp-row')).map((r) => r.getAttribute('data-ticket')),
    pill: (id) => host.querySelector('.stp-pill[data-filter="' + id + '"]'),
    count: (id) => Number(host.querySelector('.stp-pill[data-filter="' + id + '"] .stp-pill-n').textContent),
    cell: (id, label) => {
      const row = Array.from(host.querySelectorAll('tr.stp-row')).find((r) => r.getAttribute('data-ticket') === id);
      return row ? row.querySelector('td[data-label="' + label + '"]') : null;
    },
    body: () => host.querySelector('.stp-body').textContent,
  };
}

function ticket(over) {
  return Object.assign({
    id: 'st_x', title: 'A ticket', status: 'open', priority: 'normal',
    job_id: 'j1', lead_id: null, job_number: 'RV2006', job_title: 'Waterside Siding',
    lead_title: null, assignee_user_id: null, assignee_name: null,
    task_total: 0, task_done: 0, scheduled_for: null, due_date: null,
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

describe('the page renders the list', () => {
  test('first load says Loading…, fetches the newest 200 once, then renders a row per ticket', async () => {
    let resolve;
    const p = makePage({ responder: () => new Promise((r) => { resolve = r; }) });
    p.render();
    expect(p.body()).toMatch(/Loading…/);
    await flush();
    expect(p.body()).toMatch(/Loading…/);
    expect(p.listCalls).toEqual([{ limit: 200 }]);
    resolve({ tickets: MIXED() });
    await flush();
    expect(p.rowIds()).toEqual(['s_draft', 's_open', 's_sched', 's_prog', 's_done', 's_appr', 's_closed', 's_cancel']);
    expect(p.host.querySelector('.stp-title').textContent).toBe('Service Tickets');
    expect(p.host.querySelector('.stp-summary').textContent).toBe('8 tickets');
  });

  test('the columns: parent label, status label, tasks, assignee, priority dot', async () => {
    const p = makePage({ tickets: [
      ticket({ id: 'a', task_total: 8, task_done: 3, assignee_name: 'Wendy Wide', priority: 'urgent', status: 'work_complete' }),
      ticket({ id: 'b', job_id: null, lead_id: 'l1', job_number: null, job_title: null, lead_title: 'Maple St reroof' }),
      ticket({ id: 'c', job_number: null, job_title: null }),
      ticket({ id: 'd', job_id: null, lead_id: 'l9', job_number: null, job_title: null, lead_title: null }),
    ] });
    p.render();
    await flush();
    expect(p.cell('a', 'Job / Lead').textContent).toBe('RV2006 Waterside Siding');
    expect(p.cell('a', 'Status').textContent).toBe('Work complete');
    expect(p.cell('a', 'Status').querySelector('.p86-st-status.st-work_complete')).not.toBeNull();
    expect(p.cell('a', 'Tasks').textContent).toBe('3/8');
    expect(p.cell('a', 'Assignee').textContent).toBe('Wendy Wide');
    expect(p.cell('a', 'Priority').querySelector('.p86-st-prio.prio-urgent')).not.toBeNull();
    expect(p.cell('b', 'Job / Lead').textContent).toBe('Lead · Maple St reroof');
    expect(p.cell('b', 'Tasks').textContent).toBe('—');
    expect(p.cell('b', 'Assignee').textContent).toBe('—');
    // A label the server could not name is said so — never the raw id.
    expect(p.cell('c', 'Job / Lead').textContent).toBe('Job not found');
    expect(p.cell('d', 'Job / Lead').textContent).toBe('Lead not found');
    expect(p.host.querySelector('tbody').textContent).not.toMatch(/\bj1\b|\bl9\b/);
    // Rows are keyboard-reachable links.
    expect(p.rows().every((r) => r.getAttribute('tabindex') === '0' && r.getAttribute('role') === 'link')).toBe(true);
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
    expect(p.host.querySelector('tbody script, tbody b, tbody i')).toBeNull();
    expect(p.cell('st_"><b>id', 'Assignee').textContent).toBe('<i>who</i>');
    expect(p.host.querySelector('.stp-c-title').textContent).toBe(evil);
    expect(p.w.__pwned).toBeUndefined();
    // The id survives the attribute intact, so the click still finds its ticket.
    p.rows()[0].click();
    expect(p.order[0]).toEqual(['openTicket', 'st_"><b>id']);
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
  w.p86Api = { serviceTickets: { list: () => Promise.resolve({ tickets: payload.tickets }) } };
  w.eval(fs.readFileSync(payload.page, 'utf8'));
  const host = w.document.getElementById('serviceTicketsHost');
  Promise.resolve(w.p86ServiceTicketsPage.render(host))
    .then(() => new Promise((r) => setTimeout(r, 0)))
    .then(() => {
      const cells = {};
      host.querySelectorAll('tr.stp-row').forEach((row) => {
        const o = {};
        row.querySelectorAll('td[data-label]').forEach((td) => { o[td.getAttribute('data-label')] = td.textContent; });
        cells[row.getAttribute('data-ticket')] = o;
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
      page: path.join(ROOT, 'js', 'service-tickets-page.js'),
      tickets: tickets,
    }),
    env: Object.assign({}, process.env, { TZ: tz }),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60000,
  });
  return JSON.parse(stdout);
}

describe('days in a real time zone', () => {
  // 01:30 UTC on Sep 11 is 9:30pm on Sep 10 in New York: the UTC day and the
  // viewer's local day disagree.
  const TZ_TICKETS = [
    ticket({ id: 'a', due_date: '2026-09-20', scheduled_for: '2026-09-18T00:00:00.000Z', updated_at: '2026-09-11T01:30:00.000Z' }),
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
      expect(run.cells.a.Due).toMatch(/^Sep 20(, 2026)?$/);
      expect(run.cells.a.Scheduled).toMatch(/^Sep 18(, 2026)?$/);
    }
  });

  test('updated_at is the viewer\'s LOCAL day: Sep 10 in New York, Sep 11 in UTC', () => {
    expect(ny.cells.a.Updated).toMatch(/^Sep 10(, 2026)?$/);
    expect(utc.cells.a.Updated).toMatch(/^Sep 11(, 2026)?$/);
  });
});

// The page copies STATUS_LABEL, FILTERS and the pill matching from the job
// tab. The job tab's own definitions are lifted out of js/service-tickets.js
// (by balanced brackets) and the RENDERED page is held to them, so an edit on
// either side that makes a pill or a label mean something different fails.
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
  const src = readText('js/service-tickets.js').replace(/\r\n/g, '\n');
  const code = [
    liftFrom(src, '  var STATUSES = ['),
    liftFrom(src, '  var STATUS_LABEL = {'),
    liftFrom(src, '  var FILTERS = ['),
    liftFrom(src, '  function matchesFilter(t) {'),
  ].join(';\n') + ';\n({ STATUSES: STATUSES, STATUS_LABEL: STATUS_LABEL, FILTERS: FILTERS, matchesFilter: matchesFilter })';
  const sandbox = { _state: { filter: 'all' } };
  const defs = vm.runInNewContext(code, sandbox);
  return {
    statuses: JSON.parse(JSON.stringify(defs.STATUSES)),
    labels: JSON.parse(JSON.stringify(defs.STATUS_LABEL)),
    filters: JSON.parse(JSON.stringify(defs.FILTERS)),
    matches: (status, filter) => { sandbox._state.filter = filter; return defs.matchesFilter({ status: status }); },
  };
}

describe('filters', () => {
  test('status pills: counts, and Active / Awaiting approval / Closed match what the job tab matches', async () => {
    const p = makePage({ tickets: MIXED() });
    p.render();
    await flush();
    expect(Array.from(p.host.querySelectorAll('.stp-pill')).map((b) => b.getAttribute('data-filter')))
      .toEqual(['all', 'active', 'draft', 'scheduled', 'in_progress', 'work_complete', 'closed']);
    expect(p.pill('work_complete').firstChild.textContent.trim()).toBe('Awaiting approval');
    expect([p.count('all'), p.count('active'), p.count('draft'), p.count('scheduled'),
      p.count('in_progress'), p.count('work_complete'), p.count('closed')]).toEqual([8, 4, 1, 1, 1, 1, 2]);

    p.pill('active').click();
    expect(p.rowIds()).toEqual(['s_open', 's_sched', 's_prog', 's_done']);
    expect(p.pill('active').classList.contains('active')).toBe(true);
    p.pill('work_complete').click();
    expect(p.rowIds()).toEqual(['s_done']);
    p.pill('closed').click();
    expect(p.rowIds()).toEqual(['s_closed', 's_cancel']);
    expect(p.host.querySelector('.stp-summary').textContent).toBe('Showing 2 of 8 tickets');
    p.pill('all').click();
    expect(p.rowIds()).toHaveLength(8);
  });

  test('the status filter is client-side: the server is never sent a status', async () => {
    const p = makePage({ tickets: MIXED() });
    p.render();
    await flush();
    p.pill('active').click();
    p.pill('closed').click();
    await p.render();
    await flush();
    expect(p.listCalls.every((q) => JSON.stringify(q) === JSON.stringify({ limit: 200 }))).toBe(true);
  });

  test('priority, parent and search narrow the list, and the pill counts follow them', async () => {
    const p = makePage({ tickets: MIXED() });
    p.render();
    await flush();
    const prio = p.host.querySelector('.stp-prio');
    prio.value = 'urgent';
    prio.dispatchEvent(new p.w.Event('change', { bubbles: true }));
    expect(p.rowIds()).toEqual(['s_open']);
    expect(p.count('all')).toBe(1);
    prio.value = 'all';
    prio.dispatchEvent(new p.w.Event('change', { bubbles: true }));

    const parent = p.host.querySelector('.stp-parent');
    parent.value = 'lead';
    parent.dispatchEvent(new p.w.Event('change', { bubbles: true }));
    expect(p.rowIds()).toEqual(['s_sched', 's_cancel']);
    expect(p.count('closed')).toBe(1);
    parent.value = 'job';
    parent.dispatchEvent(new p.w.Event('change', { bubbles: true }));
    expect(p.rowIds()).toEqual(['s_draft', 's_open', 's_prog', 's_done', 's_appr', 's_closed']);
    parent.value = 'all';
    parent.dispatchEvent(new p.w.Event('change', { bubbles: true }));

    const search = p.host.querySelector('.stp-search');
    const type = (v) => { search.value = v; search.dispatchEvent(new p.w.Event('input', { bubbles: true })); };
    type('WENDY');
    expect(p.rowIds()).toEqual(['s_open']);
    type('harbor');
    expect(p.rowIds()).toEqual(['s_closed']);
    type('s-40');
    expect(p.rowIds()).toEqual(['s_closed']);
    type('maple');
    expect(p.rowIds()).toEqual(['s_sched']);
    type('progress one');
    expect(p.rowIds()).toEqual(['s_prog']);
    // The search box is not rebuilt under the caret.
    expect(p.host.querySelector('.stp-search')).toBe(search);
    type('nothing like this');
    expect(p.rowIds()).toEqual([]);
    expect(p.body()).toBe('No tickets match these filters.');
  });

  test('every pill, its label, what it matches and every status label are the job tab\'s own (js/service-tickets.js)', async () => {
    const tab = jobTabDefs();
    expect(tab.statuses).toHaveLength(8);
    const p = makePage({ tickets: tab.statuses.map((s) => ticket({ id: 'p_' + s, status: s })) });
    p.render();
    await flush();
    expect(Array.from(p.host.querySelectorAll('.stp-pill')).map((b) => [b.getAttribute('data-filter'), b.firstChild.textContent.trim()]))
      .toEqual(tab.filters.map((f) => [f.id, f.label]));
    let groups = 0;
    for (const f of tab.filters) {
      const want = tab.statuses.filter((s) => tab.matches(s, f.id)).map((s) => 'p_' + s);
      if (f.id !== 'all' && want.length > 1) groups++;
      p.pill(f.id).click();
      expect({ filter: f.id, rows: p.rowIds(), count: p.count(f.id) }).toEqual({ filter: f.id, rows: want, count: want.length });
    }
    expect(groups).toBeGreaterThan(0); // Active and Closed really are groups on the job tab
    p.pill('all').click();
    for (const s of tab.statuses) {
      const cell = p.cell('p_' + s, 'Status');
      expect([s, cell.textContent]).toEqual([s, tab.labels[s]]);
      expect(cell.querySelector('.p86-st-status.st-' + s)).not.toBeNull();
    }
  });

  test('filters survive a re-render (module state) and are kept in localStorage', async () => {
    const p = makePage({ tickets: MIXED() });
    p.render();
    await flush();
    p.pill('closed').click();
    await p.render();
    await flush();
    expect(p.pill('closed').classList.contains('active')).toBe(true);
    expect(p.rowIds()).toEqual(['s_closed', 's_cancel']);
    expect(JSON.parse(p.w.localStorage.getItem('p86_stp_filters')).status).toBe('closed');
  });

  test('saved filters are RESTORED on a fresh page load', async () => {
    const p = makePage({ tickets: MIXED(), storage: JSON.stringify({ status: 'closed', priority: 'all', parent: 'lead', q: '' }) });
    p.render();
    await flush();
    expect(p.pill('closed').classList.contains('active')).toBe(true);
    expect(p.pill('all').classList.contains('active')).toBe(false);
    expect(p.host.querySelector('.stp-parent').value).toBe('lead');
    expect(p.rowIds()).toEqual(['s_cancel']);

    const q = makePage({ tickets: MIXED(), storage: JSON.stringify({ status: 'all', priority: 'urgent', parent: 'all', q: 'wendy' }) });
    q.render();
    await flush();
    expect(q.host.querySelector('.stp-prio').value).toBe('urgent');
    expect(q.host.querySelector('.stp-search').value).toBe('wendy');
    expect(q.rowIds()).toEqual(['s_open']);
  });

  test('junk in storage falls back to the defaults', async () => {
    const junk = ['{not json', JSON.stringify({ status: 'bogus', priority: 'x', parent: 7, q: 42 }), JSON.stringify(['closed'])];
    for (const raw of junk) {
      const p = makePage({ tickets: MIXED(), storage: raw });
      p.render();
      await flush();
      expect([raw, p.pill('all').classList.contains('active')]).toEqual([raw, true]);
      expect(p.host.querySelector('.stp-prio').value).toBe('all');
      expect(p.host.querySelector('.stp-parent').value).toBe('all');
      expect(p.host.querySelector('.stp-search').value).toBe('');
      expect(p.rowIds()).toHaveLength(8);
    }
  });
});

describe('keyboard focus survives a repaint', () => {
  test('pressing a status pill keeps focus on that pill', async () => {
    const p = makePage({ tickets: MIXED() });
    p.render();
    await flush();
    const before = p.pill('active');
    before.focus();
    expect(p.w.document.activeElement).toBe(before);
    before.click();
    expect(before.isConnected).toBe(false); // the pills really were rebuilt
    const now = p.w.document.activeElement;
    expect(now.isConnected).toBe(true);
    expect(now.getAttribute('data-filter')).toBe('active');
  });

  test('a quiet refetch keeps focus on the same row', async () => {
    const p = makePage({ tickets: MIXED() });
    p.render();
    await flush();
    const row = p.rows().find((r) => r.getAttribute('data-ticket') === 's_prog');
    row.focus();
    expect(p.w.document.activeElement).toBe(row);
    await p.w.p86ServiceTicketsPage.refresh();
    await flush();
    expect(row.isConnected).toBe(false);
    expect(p.w.document.activeElement.getAttribute('data-ticket')).toBe('s_prog');
  });
});

describe('notes and empty states', () => {
  test('exactly 200 rows says it is showing the newest 200; 199 does not', async () => {
    const many = (n) => Array.from({ length: n }, (_, i) => ticket({ id: 'st_' + i }));
    const p = makePage({ tickets: many(200) });
    p.render();
    await flush();
    expect(p.body()).toMatch(/Showing the newest 200 tickets\./);
    const q = makePage({ tickets: many(199) });
    q.render();
    await flush();
    expect(q.body()).not.toMatch(/newest 200/);
  });

  test('no tickets at all', async () => {
    const p = makePage({ tickets: [] });
    p.render();
    await flush();
    expect(p.body()).toBe("No service tickets yet. Raise one from a job's Service Tickets tab or from a lead.");
  });

  test('a failed load says so, escaped', async () => {
    const p = makePage({ responder: () => Promise.reject(new Error('<b>down</b>')) });
    p.render();
    await flush();
    expect(p.body()).toBe('Could not load service tickets: <b>down</b>');
    expect(p.host.querySelector('.stp-body b')).toBeNull();
  });

  test('coming back after a failed first load says Loading… while it retries, not the old error', async () => {
    const p = makePage({ responder: () => Promise.reject(new Error('down')) });
    p.render();
    await flush();
    expect(p.body()).toBe('Could not load service tickets: down');
    let resolve;
    p.setResponder(() => new Promise((r) => { resolve = r; }));
    p.render();
    await flush();
    expect(p.body()).toBe('Loading…');
    resolve({ tickets: MIXED() });
    await flush();
    expect(p.rowIds()).toHaveLength(8);
    expect(p.host.querySelector('.stp-error')).toBeNull();
  });

  test('a failed QUIET refetch keeps the list up, with the error above it', async () => {
    const p = makePage({ tickets: MIXED() });
    p.render();
    await flush();
    p.setResponder(() => Promise.reject(new Error('blip')));
    p.render();
    await flush();
    expect(p.rowIds()).toHaveLength(8);
    expect(p.host.querySelector('.stp-body .stp-error').textContent).toBe('Could not load service tickets: blip');
  });
});

// ── Layout rules jsdom cannot lay out ────────────────────────────────────
// jsdom has no layout engine, so these read the injected sheet's CSSOM: the
// three rules that keep the desktop dot visible, the filter controls on one
// line and the phone card free of a stray caption.
function stpRules(p) {
  const out = [];
  const walk = (list, media) => Array.from(list).forEach((r) => {
    if (r.cssRules && r.media) walk(r.cssRules, r.media.mediaText);
    else if (r.selectorText) out.push({ media: media, sels: r.selectorText.split(',').map((s) => s.trim()), style: r.style });
  });
  walk(p.w.document.getElementById('p86stp-styles').sheet.cssRules, null);
  return out;
}
const declOf = (rules, sel, phone, prop) => rules
  .filter((r) => r.sels.includes(sel) && (phone ? /max-width:\s*760px/.test(r.media || '') : r.media === null))
  .map((r) => r.style.getPropertyValue(prop))
  .filter(Boolean);

describe('layout rules', () => {
  test('the priority dot is a box in a table cell, the filter controls size to their content, and a phone card has no Priority caption', async () => {
    const p = makePage({ tickets: MIXED() });
    p.render();
    await flush();
    const rules = stpRules(p);
    // css/styles.css .p86-st-prio sizes the dot but sets no display, and an
    // empty inline span in a table cell is 0x0.
    expect(declOf(rules, '.stp-table .p86-st-prio', false, 'display')).toEqual(['inline-block']);
    expect(p.host.querySelector('.stp-table td.stp-c-prio > .p86-st-prio')).not.toBeNull();
    // css/styles.css gives every input and select width:100%.
    expect(declOf(rules, '.stp-select', false, 'width')).toEqual(['auto']);
    expect(declOf(rules, '.stp-search', false, 'width')).toEqual(['auto']);
    // The phone rule captions every td[data-label]; the priority cell is
    // pinned top-right beside the title and must not be.
    expect(declOf(rules, '.stp-table td[data-label]::before', true, 'content')).toHaveLength(1);
    expect(declOf(rules, '.stp-table td.stp-c-prio::before', true, 'display')).toEqual(['none']);
  });
});

describe('opening a ticket', () => {
  test('a job ticket: openTicket(id) FIRST, then the router opens the job\'s Service Tickets tab', async () => {
    const p = makePage({ tickets: MIXED() });
    p.render();
    await flush();
    p.rows().find((r) => r.getAttribute('data-ticket') === 's_open').click();
    expect(p.order).toEqual([
      ['openTicket', 's_open'],
      ['navigate', { top: 'jobs', jobId: 'j1', jobSub: 'job-service-tickets' }],
    ]);
  });

  test('a lead-only ticket opens the lead, and asks the job tab for nothing', async () => {
    const p = makePage({ tickets: MIXED() });
    p.render();
    await flush();
    p.rows().find((r) => r.getAttribute('data-ticket') === 's_sched').click();
    expect(p.order).toEqual([['navigate', { top: 'estimates', estSub: 'leads', leadId: 'l1' }]]);
  });

  test('Enter and Space on a focused row open it; other keys do not', async () => {
    const p = makePage({ tickets: MIXED() });
    p.render();
    await flush();
    const row = p.rows().find((r) => r.getAttribute('data-ticket') === 's_prog');
    row.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(p.order).toEqual([]);
    row.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    row.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(p.order.filter((e) => e[0] === 'navigate')).toHaveLength(2);
  });

  test('openTicket really opens the ticket on the job tab (js/service-tickets.js consumes it in reload)', async () => {
    // The real job-tab module, driven the way switchJobSubTab drives it.
    const dom = new JSDOM('<!doctype html><html><body><div id="job-service-tickets"></div></body></html>',
      { runScripts: 'outside-only', url: 'https://project86.test/jobs/j1/job-service-tickets' });
    const w = dom.window;
    const t = { id: 'st_77', title: 'Gate', status: 'open', priority: 'normal', job_id: 'j1', checklist: [] };
    w.appState = { currentJobId: 'j1' };
    w.appData = { jobs: [{ id: 'j1', jobNumber: 'RV2006', title: 'Waterside' }], leads: [] };
    w.p86JobLabel = JOB_LABEL;
    w.p86Api = { serviceTickets: {
      list: () => Promise.resolve({ tickets: [t, Object.assign({}, t, { id: 'st_78', title: 'Other' })] }),
      get: () => Promise.resolve({ ticket: t, tasks: [], events: [], revisions: [], participants: [], shares: [] }),
    } };
    w.p86Toast = () => {};
    w.eval(readText('js/service-tickets.js'));
    w.renderJobServiceTickets('j1');
    await flush();
    expect(w.document.querySelector('.p86-st-row.is-open')).toBeNull();
    // Already on this job's tab: the next render still honours it.
    w.p86ServiceTickets.openTicket('st_78');
    w.renderJobServiceTickets('j1');
    await flush();
    const open = w.document.querySelector('.p86-st-row.is-open');
    expect(open && open.getAttribute('data-ticket')).toBe('st_78');
  });
});

describe('refetching', () => {
  test('a later render refetches QUIETLY: the list stays up until the new data lands', async () => {
    const p = makePage({ tickets: MIXED() });
    p.render();
    await flush();
    let resolve;
    p.setResponder(() => new Promise((r) => { resolve = r; }));
    p.render();
    await flush();
    expect(p.body()).not.toMatch(/Loading/);
    expect(p.rowIds()).toHaveLength(8);
    resolve({ tickets: [ticket({ id: 'fresh' })] });
    await flush();
    expect(p.rowIds()).toEqual(['fresh']);
  });

  test('an older response never overwrites a newer one', async () => {
    const pending = [];
    const p = makePage({ responder: () => new Promise((r) => pending.push(r)) });
    p.render();
    p.render();
    await flush();
    expect(pending).toHaveLength(2);
    pending[1]({ tickets: [ticket({ id: 'newer' })] });
    await flush();
    pending[0]({ tickets: [ticket({ id: 'older' })] });
    await flush();
    expect(p.rowIds()).toEqual(['newer']);
  });

  test('an older FAILED response never puts an error over a newer list', async () => {
    const pending = [];
    const p = makePage({ responder: () => new Promise((res, rej) => pending.push({ res, rej })) });
    p.render();
    p.render();
    await flush();
    expect(pending).toHaveLength(2);
    pending[1].res({ tickets: [ticket({ id: 'newer' })] });
    await flush();
    pending[0].rej(new Error('older failed'));
    await flush();
    expect(p.host.querySelector('.stp-body .stp-error')).toBeNull();
    expect(p.body()).not.toMatch(/older failed/);
    expect(p.rowIds()).toEqual(['newer']);
  });

  test('refresh() refetches only while the page is the one on screen', async () => {
    const p = makePage({ tickets: MIXED() });
    await p.w.p86ServiceTicketsPage.refresh();
    expect(p.listCalls).toHaveLength(0); // never rendered
    p.render();
    await flush();
    await p.w.p86ServiceTicketsPage.refresh();
    expect(p.listCalls).toHaveLength(2);
    p.w.document.getElementById('service-tickets').classList.remove('active');
    await p.w.p86ServiceTicketsPage.refresh();
    expect(p.listCalls).toHaveLength(2);
  });

  test('js/service-tickets.js refresh() calls the page\'s refresh', async () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'https://project86.test/' });
    const w = dom.window;
    let called = 0;
    w.appState = { currentJobId: null };
    w.p86ServiceTicketsPage = { refresh: () => { called++; return Promise.resolve(); } };
    w.eval(readText('js/service-tickets.js'));
    await w.p86ServiceTickets.refresh();
    expect(called).toBe(1);
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
    expect(tile[0].nextElementSibling.getAttribute('onclick')).toMatch(/p86MoreGo\('cost-inbox'\)/);
  });

  test('the script loads after api.js and job-label.js, right after jobs-hub.js, with a cache-buster', () => {
    const scripts = Array.from(index().querySelectorAll('script[src]')).map((s) => s.getAttribute('src'));
    const at = scripts.findIndex((s) => /^js\/service-tickets-page\.js\?v=\d+$/.test(s));
    expect(at).toBeGreaterThan(-1);
    expect(scripts[at - 1]).toMatch(/^js\/jobs-hub\.js\?v=\d+$/);
    expect(scripts.findIndex((s) => /^js\/api\.js\?v=/.test(s))).toBeLessThan(at);
    expect(scripts.findIndex((s) => /^js\/job-label\.js\?v=/.test(s))).toBeLessThan(at);
  });
});

describe('router and app.js', () => {
  function loadRouter(pathname) {
    const pushed = [];
    const win = {
      location: { pathname: pathname || '/', search: '', hash: '' },
      history: {
        pushState: (state, title, url) => { pushed.push(url); if (url) win.location.pathname = url; },
        replaceState: (state, title, url) => { if (url) win.location.pathname = url; },
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      setTimeout: () => {},
      appState: {},
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
    return { router: win.p86Router, pushed };
  }

  test('/service-tickets deep-links, and navigate() writes it back', () => {
    const { router, pushed } = loadRouter('/service-tickets');
    expect(router.route().top).toBe('service-tickets');
    expect(router.canGo('/service-tickets')).toBe(true);
    router.navigate({ top: 'service-tickets' });
    expect(pushed).toEqual(['/service-tickets']);
  });

  test('app.js: the title, and a switchTab branch that renders the page into its host', () => {
    const src = readText('js/app.js').replace(/\r\n/g, '\n');
    const titles = src.slice(src.indexOf('var TAB_TITLES = {'), src.indexOf('};', src.indexOf('var TAB_TITLES = {')));
    expect(titles).toMatch(/\n\s*'service-tickets': 'Service Tickets',\n/);

    const start = src.indexOf('        function switchTab(tabName) {');
    const end = src.indexOf('\n        }\n', start);
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, end);
    const open = "} else if (tabName === 'service-tickets') {";
    const at = body.indexOf(open);
    expect(at).toBeGreaterThan(-1);
    expect(body.indexOf(open, at + 1)).toBe(-1);
    const branch = body.slice(at + open.length, body.indexOf("} else if (tabName === ", at + open.length));
    expect(branch).toMatch(/document\.getElementById\('serviceTicketsHost'\)/);
    expect(branch).toMatch(/window\.p86ServiceTicketsPage\.render\(stHost\)/);
    expect(branch).toMatch(/Service Tickets module not loaded\./);
    expect(branch).not.toMatch(/renderJobsMain|p86JobsHubRefresh|p86JobDetailRefresh|load\w*ForJob/);
    // The final catch-all that paints the Jobs list comes AFTER the branch, so
    // the branch is what runs for this tab.
    expect(body.lastIndexOf('renderJobsMain')).toBeGreaterThan(at);
  });
});
