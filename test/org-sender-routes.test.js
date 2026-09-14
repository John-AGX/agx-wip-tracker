// "Add the company name and reply-to" (John) — the in-tenant notices.
//
// WHAT THIS FILE HOLDS
// Seven doors email someone on a tenant's behalf: a job reassigned, a DM, a
// crew member put on the schedule, a task assigned, a task shared with an
// outside worker, a report shared with a client, and a sub put on a job. Each
// now asks server/email.js for the company's name on the From line
// (`senderOrg`) and names a Reply-To (`replyTo`) — the person who caused the
// mail, read FRESH from users in the org being mailed, or `false` when there is
// no such person. The email module is mocked and CAPTURES those options, so
// the assertion is on what the route asked to send.
//
// AND THE HOLES THIS WOULD HAVE AMPLIFIED
// Putting a company name and a staff address on mail is only safe if that mail
// stays inside the tenant. Three recipient reads did not:
//   * a DM's recipient came from a caller-typed thread key, with no org term;
//   * schedule crew ids came from the body, validated for existence only;
//   * a task share's sub_id filled in any tenant's sub email as the recipient.
// Each is driven here with another tenant's id, and the proof is that nobody
// in that tenant is emailed.
//
// THE POOL IS A RECORDER WITH A FEW TABLES BEHIND IT. The users, subs and jobs
// reads are answered from rows, applying the org term the route actually
// bound (read off the statement), so a predicate that is dropped stops
// filtering here and the tests go red. Nothing else is simulated.

const express = require('express');
const http = require('http');

let queries;
let tables;

jest.mock('../server/db', () => ({
  pool: {
    query: async (sql, params) => mockRunQuery(sql, params),
    connect: async () => ({
      query: async (sql, params) => mockRunQuery(sql, params),
      release: () => {}
    })
  }
}));

const sent = [];     // sendEmail option objects
const events = [];   // [eventKey, params, opts] for sendForEvent
const pushes = [];
jest.mock('../server/email', () => ({
  sendEmail: async (m) => { sent.push(m); return { ok: true }; },
  sendForEvent: async (k, p, o) => { events.push([k, p, o]); return { ok: true }; },
  isEnabled: () => true
}));
jest.mock('../server/notify-events', () => ({
  sendPushForEvent: async (userId, key, payload) => { pushes.push({ userId, key, payload }); return { sent: 1 }; },
  pushAllowed: () => true,
  NOTIFY_EVENTS: []
}));
jest.mock('../server/storage', () => ({ storage: { put: async () => 'u', getBuffer: async () => Buffer.from(''), delete: async () => {} } }));
jest.mock('../server/services/entity-labels', () => ({
  resolveEntityLabels: async () => new Map(),
  attachEntityLabels: async () => {}
}));
jest.mock('../server/services/markets', () => ({ loadMarketMap: async () => ({ byName: {} }), resolveMarketId: () => null }));
jest.mock('../server/services/report-document', () => ({ loadReportDocument: async () => ({ sections: [] }) }));
jest.mock('../server/services/report-map-bake', () => ({ bakeDocumentMaps: async () => null }));
jest.mock('../server/services/report-pdf', () => ({ renderReportPdf: async () => Buffer.from('') }));

function rowsOf(n) { return tables[n] || []; }

// ids a statement keyed on: `id = ANY($1…)` or `id = $1`.
function keyedIds(text, p) {
  if (/\bid = ANY\(\$1/.test(text)) return (p[0] || []).map(String);
  if (/\bid = \$1\b/.test(text)) return [String(p[0])];
  return null;
}

// Apply whichever org term the statement carries, the way Postgres would.
function orgFilter(text, p, rows) {
  const strict = /(?:^|[^.\w])organization_id = \$(\d+)(?! OR organization_id IS NULL)/.exec(text);
  // (An alias is allowed: services/sub-org-scope.js parentSubInOrgSql writes
  // `s_org_scope.organization_id = $2 OR s_org_scope.organization_id IS NULL`.)
  const tolerant = /organization_id = \$(\d+) OR (?:\w+\.)?organization_id IS NULL/.exec(text);
  if (tolerant) {
    const v = p[Number(tolerant[1]) - 1];
    return rows.filter((r) => r.organization_id == null || String(r.organization_id) === String(v));
  }
  if (strict) {
    const v = p[Number(strict[1]) - 1];
    return rows.filter((r) => r.organization_id != null && String(r.organization_id) === String(v));
  }
  return rows;
}

function fromTable(name, text, p) {
  const ids = keyedIds(text, p);
  let rows = rowsOf(name).filter((r) => !ids || ids.indexOf(String(r.id)) !== -1);
  rows = orgFilter(text, p, rows);
  if (/active = TRUE/i.test(text)) rows = rows.filter((r) => r.active);
  return { rows: rows.map((r) => Object.assign({}, r)) };
}

// Bind `INSERT INTO t (a, b) VALUES ($1, $2)` into a row.
function insertedRow(text, p) {
  const m = /INSERT INTO \w+ \(([^)]*)\) VALUES \(([^)]*)\)/.exec(text);
  const row = {};
  if (!m) return row;
  const cols = m[1].split(',').map((s) => s.trim());
  const vals = m[2].split(',').map((s) => s.trim());
  cols.forEach((c, i) => {
    const ph = /^\$(\d+)/.exec(vals[i] || '');
    row[c] = ph ? p[Number(ph[1]) - 1] : null;
  });
  return row;
}

function mockRunQuery(sql, params) {
  const text = String(sql).replace(/\s+/g, ' ').trim();
  const p = params || [];
  queries.push({ sql: text, params: p });

  if (text.includes('SELECT name, capabilities FROM roles')) return { rows: rowsOf('roles') };
  if (text.startsWith('SELECT name FROM organizations WHERE id = $1')) return fromTable('organizations', text, p);

  // ── writes: record, hand back what RETURNING would ──────────────────────
  if (text.startsWith('INSERT INTO schedule_entries')) {
    return { rows: [{ id: p[0], job_id: p[1], start_date_iso: p[2], days: p[3], crew: JSON.parse(p[4]),
      includes_weekends: p[5], status: p[6], notes: p[7], created_by: p[8] }] };
  }
  if (text.startsWith('UPDATE schedule_entries SET')) {
    const crew = JSON.parse(p[0]);
    return { rows: [{ id: p[p.length - 1], job_id: 'j1', start_date_iso: '2026-09-14', days: 1, crew, status: 'planned' }] };
  }
  if (text.startsWith('SELECT crew FROM schedule_entries')) return { rows: [{ crew: [] }] };
  if (text.includes('FROM schedule_entries s')) return { rows: [{ '?column?': 1 }] };
  if (text.startsWith('INSERT INTO tasks')) {
    const row = insertedRow(text, p);
    return { rows: [Object.assign({ scope: 'org', priority: 'normal' }, row)] };
  }
  if (text.startsWith('INSERT INTO task_shares')) {
    tables.task_shares.push(insertedRow(text, p));
    return { rows: [], rowCount: 1 };
  }
  if (text.startsWith('INSERT INTO report_shares') || text.startsWith('INSERT INTO sub_invites')) return { rows: [], rowCount: 1 };
  if (text.includes('INSERT INTO job_subs')) return { rows: [{ id: p[0], job_id: p[1], sub_id: p[2] }] };
  if (text.startsWith('INSERT INTO messages') || text.startsWith('INSERT INTO message_reads')) return { rows: [], rowCount: 1 };
  if (text.includes('FROM messages m')) return { rows: [{ id: p[0], body: 'hi' }] };
  if (text.startsWith('UPDATE jobs')) return { rows: [], rowCount: 1 };

  // ── reads answered from rows ────────────────────────────────────────────
  if (/FROM users\b/.test(text) && !/JOIN/.test(text)) return fromTable('users', text, p);
  if (/FROM subs\b/.test(text)) return fromTable('subs', text, p);
  if (/FROM jobs\b/.test(text)) return fromTable('jobs', text, p);
  if (/FROM tasks WHERE id = \$1/.test(text)) return fromTable('tasks', text, p);
  if (/FROM projects WHERE id = \$1/.test(text)) return fromTable('projects', text, p);
  if (text.startsWith('SELECT * FROM job_reports')) return { rows: [{ id: p[0], title: 'Site report', sections: [] }] };
  return { rows: [], rowCount: 0 };
}

const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const { pool } = require('../server/db');
const emailSender = require('../server/email-sender');
setRolePool(pool);

let server, baseUrl;

// The admin's JWT carries a STALE email; the users row carries the current one.
// A Reply-To built from the claim would show here as the wrong address.
const ADMIN_A = { id: 10, email: 'stale-claim@a.test', role: 'admin', name: 'Ann Admin', organization_id: 1 };
// Platform staff acting as org A: the token names org 1, the person's own row
// lives in org 2. Their address must never reach org A's mail.
const STAFF_AS_A = { id: 90, email: 'staff@platform.test', role: 'admin', name: 'Staff', organization_id: 1 };

function freshTables() {
  return {
    roles: [{ name: 'admin', capabilities: ['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'LEADS_VIEW', 'LEADS_EDIT', 'USERS_MANAGE', 'ROLES_MANAGE'] }],
    organizations: [
      { id: 1, name: 'AG Exteriors' },
      { id: 2, name: 'Rival Roofing' },
      { id: 3, name: null }
    ],
    users: [
      { id: 10, name: 'Ann Admin', email: 'ann@a.test', organization_id: 1, active: true, notification_prefs: {} },
      { id: 20, name: 'Bo Builder', email: 'bo@a.test', organization_id: 1, active: true, notification_prefs: {} },
      { id: 21, name: 'Cy Crew', email: 'cy@a.test', organization_id: 1, active: true, notification_prefs: {} },
      { id: 30, name: 'Nia Noorg', email: 'nia@x.test', organization_id: 3, active: true, notification_prefs: {} },
      { id: 50, name: 'Rex Rival', email: 'rex@b.test', organization_id: 2, active: true, notification_prefs: {} },
      { id: 90, name: 'Staff', email: 'staff@platform.test', organization_id: 2, active: true, notification_prefs: {} }
    ],
    jobs: [
      { id: 'j1', owner_id: 10, organization_id: 1, data: { title: 'Latitude', jobNumber: 'M1001' } },
      { id: 'jB', owner_id: 50, organization_id: 2, data: { title: 'Theirs', jobNumber: 'B1' } }
    ],
    subs: [
      { id: 'sub_A', name: 'Alpha Drywall', email: 'alpha@a.test', primary_contact_first: 'Al', organization_id: 1 },
      { id: 'sub_B', name: 'Beta Drywall', email: 'beta@b.test', primary_contact_first: 'Bea', organization_id: 2 }
    ],
    tasks: [
      { id: 'task_A', title: 'Fix railing', organization_id: 1 },
      { id: 'task_N', title: 'Nameless org task', organization_id: 3 }
    ],
    projects: [
      { id: 'p1', name: 'Latitude', address_text: '828 Orienta', organization_id: 1 },
      { id: 'p3', name: 'Unnamed', address_text: '', organization_id: 3 }
    ],
    task_shares: []
  };
}

beforeAll(async () => {
  queries = []; tables = freshTables();
  await refreshRoleCache();
  const app = express();
  app.use(express.json());
  // Share doors first: they live on '/api' and one of them is under /tasks.
  app.use('/api', require('../server/routes/task-share-routes'));
  app.use('/api', require('../server/routes/report-share-routes'));
  app.use('/api/jobs', require('../server/routes/job-routes'));
  app.use('/api/messages', require('../server/routes/message-routes'));
  app.use('/api/schedule', require('../server/routes/schedule-routes'));
  app.use('/api/tasks', require('../server/routes/tasks-routes'));
  app.use('/api/subs', require('../server/routes/sub-routes'));
  await new Promise((done) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => { baseUrl = 'http://127.0.0.1:' + server.address().port; done(); });
  });
});

afterAll((done) => { server.close(() => done()); });

beforeEach(() => {
  queries = []; tables = freshTables();
  sent.length = 0; events.length = 0; pushes.length = 0;
  emailSender._clearOrgNameCache();
});

async function call(method, path, user, body) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + signToken(user) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  const text = await res.text();
  try { json = JSON.parse(text); } catch (e) { /* non-JSON */ }
  return { status: res.status, body: json, text };
}

// The notices are fire-and-forget: the response returns before the send.
// Wait for the mail to land, or for the notify path to have gone quiet.
async function settle(pred) {
  for (let i = 0; i < 100; i++) {
    if (pred && pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * job-routes — job reassigned
 * ══════════════════════════════════════════════════════════════════════════*/
describe('job assigned / reassigned', () => {
  test('from the company, metered to it, and a reply reaches the assigner’s current address', async () => {
    const r = await call('PUT', '/api/jobs/j1/owner', ADMIN_A, { ownerId: 20, notify: true });
    expect(r.status).toBe(200);
    await settle(() => sent.length);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: 'bo@a.test', tag: 'job_assignment', organizationId: 1,
      senderOrg: { id: 1 }, replyTo: 'ann@a.test'
    });
    // The recipient read carries the tenant, not just the door before it.
    const recipientRead = queries.find((q) => /SELECT email, name, notification_prefs FROM users/.test(q.sql));
    expect(recipientRead.sql).toMatch(/organization_id = \$2/);
    expect(recipientRead.params).toEqual([20, 1]);
  });

  test('act-as: platform staff reassigning in org A put no address of theirs on the mail', async () => {
    const r = await call('PUT', '/api/jobs/j1/owner', STAFF_AS_A, { ownerId: 20, notify: true });
    expect(r.status).toBe(200);
    await settle(() => sent.length);
    expect(sent).toHaveLength(1);
    expect(sent[0].replyTo).toBe(false);
    expect(JSON.stringify(sent[0])).not.toContain('staff@platform.test');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * message-routes — direct message
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a direct message', () => {
  test('to a teammate: from the company, and a reply reaches the sender', async () => {
    const r = await call('POST', '/api/messages/dm:10:20', ADMIN_A, { body: 'Can you check bldg 4?' });
    expect(r.status).toBe(200);
    await settle(() => sent.length && pushes.length);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: 'bo@a.test', tag: 'message', organizationId: 1, senderOrg: { id: 1 }, replyTo: 'ann@a.test'
    });
  });

  test('HOLE: a thread key naming ANOTHER tenant’s user emails and pushes nobody', async () => {
    // isForbiddenDm only proves the SENDER is a participant; the other id is typed.
    const r = await call('POST', '/api/messages/dm:10:50', ADMIN_A, { body: 'hello stranger' });
    expect(r.status).toBe(200);
    await settle(() => queries.some((q) => /FROM users WHERE id = \$1 AND organization_id = \$2 AND active = TRUE/.test(q.sql)));
    await settle();
    expect(sent).toEqual([]);
    expect(pushes).toEqual([]);
    expect(JSON.stringify(queries)).not.toMatch(/rex@b\.test/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * schedule-routes — crew added to an entry
 * ══════════════════════════════════════════════════════════════════════════*/
describe('schedule crew notice', () => {
  test('HOLE: another tenant’s user id in crew is dropped, never saved and never emailed', async () => {
    const r = await call('POST', '/api/schedule', ADMIN_A,
      { jobId: 'j1', startDate: '2026-09-14', days: 1, crew: [20, 50], notify: true });
    expect(r.status).toBe(201);
    expect(r.body.entry.crew).toEqual([20]);
    await settle(() => sent.length);
    await settle();
    expect(sent.map((m) => m.to)).toEqual(['bo@a.test']);
    expect(sent[0]).toMatchObject({
      tag: 'schedule_assignment', organizationId: 1, senderOrg: { id: 1 }, replyTo: 'ann@a.test'
    });
    const ins = queries.find((q) => q.sql.startsWith('INSERT INTO schedule_entries'));
    expect(JSON.parse(ins.params[4])).toEqual([20]);
  });

  test('PATCH: resolved tenant, foreign crew dropped, newly added in-org crew notified', async () => {
    const r = await call('PATCH', '/api/schedule/sch_1', ADMIN_A, { crew: [21, 50], notify: true });
    expect(r.status).toBe(200);
    expect(r.body.entry.crew).toEqual([21]);
    await settle(() => sent.length);
    await settle();
    expect(sent.map((m) => m.to)).toEqual(['cy@a.test']);
    expect(sent[0]).toMatchObject({ senderOrg: { id: 1 }, replyTo: 'ann@a.test' });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * tasks-routes — task assigned
 * ══════════════════════════════════════════════════════════════════════════*/
describe('task assigned', () => {
  test('from the company, and a reply reaches the assigner’s current in-org address', async () => {
    const r = await call('POST', '/api/tasks', ADMIN_A, { title: 'Fix railing', assignee_user_id: 20 });
    expect(r.status).toBe(200);
    await settle(() => sent.length);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: 'bo@a.test', tag: 'task_assignment', organizationId: 1, senderOrg: { id: 1 }, replyTo: 'ann@a.test'
    });
    expect(sent[0].text).toContain('Ann Admin assigned to you');
  });

  test('act-as: no platform staff name or address reaches the tenant’s mail', async () => {
    const r = await call('POST', '/api/tasks', STAFF_AS_A, { title: 'Fix railing', assignee_user_id: 20 });
    expect(r.status).toBe(200);
    await settle(() => sent.length);
    expect(sent).toHaveLength(1);
    expect(sent[0].replyTo).toBe(false);
    expect(sent[0].text).toContain('A teammate assigned to you');
    expect(JSON.stringify(sent[0])).not.toContain('staff@platform.test');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * task-share-routes — a task sent to an outside worker
 * ══════════════════════════════════════════════════════════════════════════*/
describe('task share', () => {
  test('to my own sub: the company’s name, and a reply reaches the office user who shared it', async () => {
    const r = await call('POST', '/api/tasks/task_A/share', ADMIN_A, { sub_id: 'sub_A' });
    expect(r.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: 'alpha@a.test', tag: 'task_share', organizationId: 1,
      senderOrg: { id: 1, name: 'AG Exteriors' }, replyTo: 'ann@a.test'
    });
    expect(sent[0].subject).toBe('AG Exteriors sent you a task: Fix railing');
  });

  test('HOLE: another tenant’s sub_id fills in nothing — no email to their vendor, no request', async () => {
    const r = await call('POST', '/api/tasks/task_A/share', ADMIN_A, { sub_id: 'sub_B' });
    expect(r.status).toBe(400);
    expect(sent).toEqual([]);
    expect(tables.task_shares).toEqual([]);
    expect(r.text).not.toContain('beta@b.test');
  });

  test('HOLE: a foreign sub_id beside a typed address is not stamped onto the share row', async () => {
    const r = await call('POST', '/api/tasks/task_A/share', ADMIN_A, { sub_id: 'sub_B', email: 'crew@a.test' });
    expect(r.status).toBe(200);
    expect(sent.map((m) => m.to)).toEqual(['crew@a.test']);
    expect(tables.task_shares[0].sub_id).toBeNull();
    expect(JSON.stringify(sent)).not.toMatch(/Bea|beta@b\.test/);
  });

  test('an org with no name never sends as "Project 86 via Project 86"', async () => {
    const NIA = { id: 30, email: 'nia@x.test', role: 'admin', name: 'Nia', organization_id: 3 };
    const r = await call('POST', '/api/tasks/task_N/share', NIA, { email: 'crew@x.test' });
    expect(r.status).toBe(200);
    expect(sent[0].senderOrg).toEqual({ id: 3 });
    expect(sent[0].subject).toBe('Project 86 sent you a task: Nameless org task');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * report-share-routes — a report shared with a client
 * ══════════════════════════════════════════════════════════════════════════*/
describe('report share', () => {
  test('the company’s name, and a reply reaches the sharer — never the typed recipient', async () => {
    const r = await call('POST', '/api/reports/project/p1/rep1/share', ADMIN_A, { email: 'client@c.test', name: 'Cli' });
    expect(r.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: 'client@c.test', tag: 'report_share', organizationId: 1,
      senderOrg: { id: 1, name: 'AG Exteriors' }, replyTo: 'ann@a.test'
    });
  });

  test('an org with no name keeps the words in the copy but brands nothing', async () => {
    const NIA = { id: 30, email: 'nia@x.test', role: 'admin', name: 'Nia', organization_id: 3 };
    const r = await call('POST', '/api/reports/project/p3/rep1/share', NIA, { email: 'client@c.test' });
    expect(r.status).toBe(200);
    expect(sent[0].senderOrg).toEqual({ id: 3 });
    expect(sent[0].subject).toBe('Project 86 shared a report: Site report');
    expect(sent[0].replyTo).toBe('nia@x.test');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * sub-routes — sub_assigned
 * ══════════════════════════════════════════════════════════════════════════*/
describe('sub assigned to a job', () => {
  test('the event carries the org (branding, override, metering) and the assigner as Reply-To', async () => {
    const r = await call('POST', '/api/subs/jobs/j1', ADMIN_A, { subId: 'sub_A', contract_amt: 1200 });
    expect(r.status).toBe(200);
    await settle(() => events.length);
    expect(events).toHaveLength(1);
    const [key, params, opts] = events[0];
    expect(key).toBe('sub_assigned');
    expect(params.__orgId).toBe(1);
    expect(params.assignedBy).toEqual({ name: 'Ann Admin' });
    expect(opts).toEqual({ to: 'alpha@a.test', tag: 'sub_assigned', replyTo: 'ann@a.test' });
  });

  test('no hard-coded tenant name: a caller with no name or email is shown as the org', async () => {
    const r = await call('POST', '/api/subs/jobs/j1', { id: 10, email: '', role: 'admin', name: '', organization_id: 1 },
      { subId: 'sub_A' });
    expect(r.status).toBe(200);
    await settle(() => events.length);
    expect(events[0][1].assignedBy).toEqual({ name: 'AG Exteriors' });
    expect(JSON.stringify(events[0])).not.toContain('AGX');
  });

  test('the sub read inside the notice carries the tenant too', async () => {
    await call('POST', '/api/subs/jobs/j1', ADMIN_A, { subId: 'sub_A' });
    await settle(() => events.length);
    const subRead = queries.find((q) => /SELECT id, name, email, primary_contact_first FROM subs/.test(q.sql));
    expect(subRead.sql).toMatch(/s_org_scope\.organization_id = \$2 OR s_org_scope\.organization_id IS NULL/);
    expect(subRead.params).toEqual(['sub_A', 1]);
  });
});
