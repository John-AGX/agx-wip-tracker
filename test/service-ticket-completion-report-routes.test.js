// THE PRINTABLES' DOORS AND THE COMPLETION REPORT LINK — EXECUTED (1.29, B9).
//
//   GET  /api/service-tickets/:id/print/work-order
//   GET  /api/service-tickets/:id/completion-report
//   POST /api/service-tickets/:id/completion-report/send
//   POST /api/service-tickets/:id/completion-report/shares/:sid/revoke
// and the report share portal's public door, which serves a work order's
// completion report unchanged:
//   GET  /api/report-share/:token      POST /api/report-share/:token/comments
//
// Real routers over a signed JWT and the pg-sqlite engine; email and the
// sender helpers are mocked so the message itself can be read. What it pins:
//   * reading needs read access; the recipients list needs write access;
//   * nothing on either printable reads the approved scope, internal notes,
//     guest log or takeoff;
//   * a link is minted only for approved work, as a view-only report_shares
//     row stamped with the ticket's org, parent and entity, whose frozen
//     document is exactly what the office previewed;
//   * the email says the right things and carries no price; the timeline row
//     never stores the address;
//   * a double click makes ONE link and ONE email;
//   * turning a link off is pinned to this work order and this org.
// Each guard is then removed from a copy of the router and shown to go wrong.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

let mockEmails = [];
let mockEmailResult = { ok: true };
const mockReplyToCalls = [];
jest.mock('../server/email', () => ({
  sendEmail: async (m) => { mockEmails.push(m); return mockEmailResult; },
  sendForEvent: async () => ({ ok: true }),
  isEnabled: () => true,
  isDryRun: () => false,
}));
jest.mock('../server/email-sender', () => ({
  replyToForUser: async (db, userId, orgId) => { mockReplyToCalls.push([userId, orgId]); return 'wendy.reply@agx.test'; },
}));
jest.mock('../server/storage', () => ({ storage: { put: async () => 'u', getBuffer: async () => Buffer.from(''), delete: async () => {} } }));
jest.mock('../server/services/report-map-bake', () => ({ bakeDocumentMaps: async () => null }));
jest.mock('../server/services/report-pdf', () => ({ renderReportPdf: async () => Buffer.from('') }));

const ROUTES_DIR = path.join(__dirname, '..', 'server', 'routes');
const CO_PRINT_ROUTES = path.join(ROUTES_DIR, 'service-ticket-co-print-routes.js');

const TABLES = [
  'organizations', 'users', 'roles', 'jobs', 'job_access', 'leads', 'tasks',
  'service_tickets', 'service_ticket_events', 'service_ticket_shares', 'service_ticket_participants',
  'attachments', 'report_shares', 'report_share_comments',
];

const WIDE = 10;    // edits every job
const CREW = 20;    // narrow tier: only a VIEW grant on j1
const RIVAL = 50;   // wide, in org 2

const USERS = {
  [WIDE]: { role: 'cr_wide', org: 1 },
  [CREW]: { role: 'cr_crew', org: 1 },
  [RIVAL]: { role: 'cr_wide', org: 2 },
};

let eng;
let auth;
let router;
let reportShareRouter;
const tmpDirs = [];

function seed() {
  const caps = (list) => "'" + JSON.stringify(list) + "'";
  eng.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM roles; DELETE FROM jobs; DELETE FROM job_access;
    DELETE FROM leads; DELETE FROM tasks; DELETE FROM service_tickets; DELETE FROM service_ticket_events;
    DELETE FROM service_ticket_shares; DELETE FROM service_ticket_participants; DELETE FROM attachments;
    DELETE FROM report_shares; DELETE FROM report_share_comments;

    INSERT INTO organizations (id, name, timezone) VALUES (1, 'AG Exteriors', 'America/New_York'), (2, 'Rival Co', 'America/New_York');
    INSERT INTO roles (name, capabilities) VALUES
      ('cr_wide', ${caps(['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'LEADS_VIEW', 'LEADS_EDIT'])}),
      ('cr_crew', ${caps(['JOBS_VIEW_ASSIGNED', 'JOBS_EDIT_OWN'])});
    INSERT INTO users (id, name, email, role, organization_id, active, notification_prefs, phone_number) VALUES
      (10, 'Wendy Wide', 'w@agx.test', 'cr_wide', 1, 1, '{}', '555-0110'),
      (20, 'Carl Crew', 'c@agx.test', 'cr_crew', 1, 1, '{}', NULL),
      (50, 'Rival Ray', 'r@rival.test', 'cr_wide', 2, 1, '{}', NULL);
    INSERT INTO jobs (id, owner_id, data, organization_id) VALUES
      ('j1', 10, '{"jobNumber":"M1001","title":"Latitude 28","address":"1 Main St, Orlando, FL","contractAmount":24000}', 1),
      ('j9', 50, '{"jobNumber":"R1","title":"Rival job"}', 2);
    INSERT INTO job_access (job_id, user_id, access_level) VALUES ('j1', 20, 'view');

    INSERT INTO service_tickets (id, organization_id, ticket_number, title, job_id, status, priority, scope_proposed, scope_approved,
        internal_notes, guest_log, crew_takeoff, requested_by, checklist, materials, site_contact_name, site_contact_phone,
        access_notes, due_date, assignee_user_id, created_by, approved_by, approved_at, completed_at, archived_at, created_at) VALUES
      ('st1', 1, 'WO-1', 'Latitude 28 stairs', 'j1', 'approved', 'high', 'Replace rotten treads.', 'Approved at $4,500',
        'PM approved extra $900 — do not tell crew', 'SECRET-LOG', '{"copy":{"lines":[{"unitCost":12.5}]}}', 'Owner Olga',
        '[{"text":"Haul debris","done":true}]', '[{"description":"PT 2x12","qty":4,"unit":"ea","unitCost":12.5}]', 'Sam Super', '555-0101',
        'Gate #4321', '2026-09-20', 10, 10, 10, '2026-09-15 19:10:00', '2026-09-13 16:05:00', NULL, '2026-09-01 10:00:01'),
      ('st_ip', 1, 'WO-2', 'Still going', 'j1', 'in_progress', 'normal', 'x', NULL, NULL, NULL, NULL, NULL, '[]', NULL, NULL, NULL,
        NULL, NULL, NULL, 10, NULL, NULL, NULL, NULL, '2026-09-01 10:00:02'),
      ('st_empty', 1, 'WO-3', 'No buildings', 'j1', 'approved', 'normal', 'x', NULL, NULL, NULL, NULL, NULL, '[]', NULL, NULL, NULL,
        NULL, NULL, NULL, 10, NULL, NULL, NULL, NULL, '2026-09-01 10:00:03'),
      ('st_arch', 1, 'WO-4', 'Archived', 'j1', 'approved', 'normal', 'x', NULL, NULL, NULL, NULL, NULL, '[]', NULL, NULL, NULL,
        NULL, NULL, NULL, 10, NULL, NULL, NULL, '2026-09-10 10:00:00', '2026-09-01 10:00:04'),
      ('stb', 2, 'R-1', 'RIVAL ticket', 'j9', 'approved', 'normal', 'rival', NULL, NULL, NULL, NULL, NULL, '[]', NULL, NULL, NULL,
        NULL, NULL, NULL, 50, NULL, NULL, NULL, NULL, '2026-09-01 10:00:05');

    INSERT INTO tasks (id, organization_id, title, status, scope, service_ticket_id, entity_type, entity_id, archived_at, created_at) VALUES
      ('k1', 1, 'Bldg 784 — Side A: rail post; tread 3', 'done', 'org', 'st1', 'job', 'j1', NULL, '2026-09-02 08:00:01'),
      ('k2', 1, 'Bldg 12', 'open', 'org', 'st1', 'job', 'j1', NULL, '2026-09-02 08:00:02'),
      ('k_ip', 1, 'Bldg 1', 'open', 'org', 'st_ip', 'job', 'j1', NULL, '2026-09-02 08:00:03'),
      ('k_arch', 1, 'Bldg 2', 'done', 'org', 'st_arch', 'job', 'j1', NULL, '2026-09-02 08:00:04'),
      ('kb', 2, 'Rival bldg', 'done', 'org', 'stb', 'job', 'j9', NULL, '2026-09-02 08:00:05');

    INSERT INTO attachments (id, organization_id, entity_type, entity_id, filename, mime_type, thumb_url, web_url, caption, tags, position, uploaded_by, uploaded_at) VALUES
      ('a_c1', 1, 'task', 'k1', 'after.jpg',  'image/jpeg', 'https://cdn.test/c1_t.jpg', 'https://cdn.test/c1_w.jpg', 'Post set', '[]', 1, 10, '2026-09-12 18:00:00'),
      ('a_b1', 1, 'task', 'k1', 'before.jpg', 'image/jpeg', 'https://cdn.test/b1_t.jpg', 'https://cdn.test/b1_w.jpg', NULL, '["before"]', 0, 10, '2026-09-10 14:00:00'),
      ('a_x',  2, 'task', 'k1', 'rival.jpg',  'image/jpeg', 'https://cdn.test/RIVAL.jpg', 'https://cdn.test/RIVAL.jpg', NULL, '[]', 2, 50, '2026-09-12 18:00:01');

    INSERT INTO service_ticket_events (id, organization_id, ticket_id, kind, actor_kind, actor_label, detail, created_at) VALUES
      ('e1', 1, 'st1', 'subtask_note', 'share', 'Jose https://evil.example', '{"task_id":"k1","note":"Tread 3 was split"}', '2026-09-11 15:00:00'),
      ('e1b', 1, 'st1', 'subtask_note', 'user', 'Paula PM', '{"task_id":"k1","note":"Rail is still loose, redo it","sent_back":true}', '2026-09-11 16:00:00'),
      ('e2', 1, 'st1', 'subtask_completed', 'share', 'Jose https://evil.example', '{"task_id":"k1","title":"Bldg 784"}', '2026-09-12 18:30:00');
  `);
}

beforeAll(async () => {
  eng = createPgSqlite(sqliteSchema(TABLES), {
    jsonColumns: ['checklist', 'capabilities', 'detail', 'data', 'tags', 'notification_prefs', 'materials', 'document'],
  });
  const db = require('../server/db');
  db.pool.query = eng.pool.query;
  db.pool.connect = eng.pool.connect;
  auth = require('../server/auth');
  auth.setRolePool(eng.pool);
  seed();
  await auth.refreshRoleCache();
  router = require(CO_PRINT_ROUTES);
  reportShareRouter = require('../server/routes/report-share-routes');
});

beforeEach(() => {
  seed();
  mockEmails = [];
  mockEmailResult = { ok: true };
  mockReplyToCalls.length = 0;
});

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

async function drive(r, method, routePath, opts) {
  const o = opts || {};
  const layer = r.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
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

const workOrderPrint = (as, id, r) => drive(r || router, 'get', '/:id/print/work-order', { as, params: { id } });
const report = (as, id, query, r) => drive(r || router, 'get', '/:id/completion-report', { as, params: { id }, query });
const send = (as, id, body, r) => drive(r || router, 'post', '/:id/completion-report/send', { as, params: { id }, body });
const revoke = (as, id, sid, r) => drive(r || router, 'post', '/:id/completion-report/shares/:sid/revoke', { as, params: { id, sid } });
const publicRead = (token) => drive(reportShareRouter, 'get', '/report-share/:token', { params: { token }, fromHandler: 'loadReportShare' });
const publicComment = (token) => drive(reportShareRouter, 'post', '/report-share/:token/comments', { params: { token }, body: { body: 'Looks good' }, fromHandler: 'loadReportShare' });

const shareRows = () => eng.all('SELECT * FROM report_shares ORDER BY rowid');
const eventsOf = (id, kind) => eng.all('SELECT kind, detail, actor_user_id, organization_id FROM service_ticket_events WHERE ticket_id = ? AND kind = ? ORDER BY rowid', id, kind);
const tokenOf = (link) => /\/r\/([a-f0-9]{64})$/.exec(link)[1];
const withoutBuiltAt = (doc) => { const d = Object.assign({}, doc); delete d.built_at; return d; };

// 'redo it' and 'Paula PM' are the office's send-back reason on Bldg 784.
const POISON = ['4,500', '900', 'do not tell crew', 'SECRET-LOG', 'unitCost', 'Owner Olga', 'scope_approved', 'internal_notes', 'crew_takeoff', 'RIVAL', 'evil.example', 'redo it', 'Paula PM', 'sent_back'];
const JUST_SENT = { error: 'A completion report link for this recipient was made a moment ago. Wait a minute before trying again.', code: 'just_sent' };

function absolutizeRequires(src, fromDir) {
  return src.replace(/require\((['"])([^'"]+)\1\)/g, (_m, _q, spec) => {
    const resolved = spec.charAt(0) === '.'
      ? require.resolve(path.resolve(fromDir, spec))
      : require.resolve(spec, { paths: [fromDir] });
    return 'require(' + JSON.stringify(resolved.split(path.sep).join('/')) + ')';
  });
}

function mutant(anchor, replacement) {
  const src = fs.readFileSync(CO_PRINT_ROUTES, 'utf8').replace(/\r\n/g, '\n');
  if (src.split(anchor).length !== 2) throw new Error('anchor not found');
  const out = src.replace(anchor, () => replacement);
  if (out === src) throw new Error('mutation changed nothing');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p86-st-cr-'));
  tmpDirs.push(dir);
  const p = path.join(dir, 'service-ticket-co-print-routes.js');
  fs.writeFileSync(p, absolutizeRequires(out, ROUTES_DIR), 'utf8');
  return require(p);
}

describe('reading the printables', () => {
  test('a view grant may print both; the recipients list is only for people who can edit; another org is 404', async () => {
    const crewWo = await workOrderPrint(CREW, 'st1');
    expect(crewWo.statusCode).toBe(200);
    expect(crewWo.body.document.kind).toBe('work_order');
    const crewReport = await report(CREW, 'st1');
    expect(crewReport.statusCode).toBe(200);
    expect(crewReport.body.shares).toBeNull();
    expect(crewReport.body.document.sections.length).toBeGreaterThan(0);

    const wide = await report(WIDE, 'st1');
    expect(wide.statusCode).toBe(200);
    expect(wide.body.shares).toEqual([]);

    for (const r of [await workOrderPrint(RIVAL, 'st1'), await report(RIVAL, 'st1'), await report(WIDE, 'stb'), await workOrderPrint(WIDE, 'st_missing')]) {
      expect([r.statusCode, r.body]).toEqual([404, { error: 'Service ticket not found' }]);
    }
  });

  test('the work order carries the site, contacts and parsed buildings — and no money or office-only text', async () => {
    const { document } = (await workOrderPrint(WIDE, 'st1')).body;
    expect(document).toMatchObject({
      org_name: 'AG Exteriors', ticket_number: 'WO-1', title: 'Latitude 28 stairs', status_label: 'Approved',
      priority_label: 'High', due_label: 'Sep 20, 2026', scope: 'Replace rotten treads.',
      site: { job_number: 'M1001', name: 'Latitude 28', address: '1 Main St, Orlando, FL', gate_code: 'Gate #4321' },
      site_contact: { name: 'Sam Super', phone: '555-0101' },
      office_contact: { name: 'Wendy Wide', phone: '555-0110' },
      checklist: [{ text: 'Haul debris', done: true }],
      materials: [{ description: 'PT 2x12', qty: '4', unit: 'ea' }],
    });
    expect(document.buildings.map((b) => [b.head, b.done])).toEqual([['Bldg 784', true], ['Bldg 12', false]]);
    const json = JSON.stringify(document);
    for (const p of POISON) expect([p, json.indexOf(p)]).toEqual([p, -1]);
  });

  test('the completion report: photos in order, approval from the columns, crew names cleaned, no money', async () => {
    const { document, summary } = (await report(WIDE, 'st1')).body;
    expect(document.sections.map((s) => s.layout)).toEqual(['text-block', 'photo-grid', 'text-block', 'photo-grid', 'text-block']);
    expect(document.sections[1].photos.map((p) => [p.id, p.caption])).toEqual([['a_b1', 'Before'], ['a_c1', 'Completion — Post set']]);
    expect(document.sections[1].label).toMatch(/^Bldg 784 — finished by Jose · Sep 12, 2026 at 2:30\sPM$/);
    expect(document.sections[2].text_body).toMatch(/^Jose · Sep 11, 2026 at 11:00\sAM: Tread 3 was split$/);
    expect(document.sections[4].text_body).toMatch(/^Approved by Wendy Wide on Sep 15, 2026 at 3:10\sPM\.\nWork completed Sep 13, 2026 at 12:05\sPM\.$/);
    expect(summary).toMatchObject({
      sendable: true, buildings_total: 2, buildings_done: 1, before_photos: 1, completion_photos: 1,
      missing_completion: ['Bldg 12'], money_mentions: [], notes_included: true,
    });
    expect(summary.approved.name).toBe('Wendy Wide');
    const json = JSON.stringify(document);
    for (const p of POISON) expect([p, json.indexOf(p)]).toEqual([p, -1]);

    const quiet = (await report(WIDE, 'st1', { include_notes: '0' })).body;
    expect(quiet.document.sections.some((s) => /crew notes/.test(s.label))).toBe(false);
    expect(quiet.summary.notes_included).toBe(false);
  });

  test('without the approval columns the newest approved status event names the approver', async () => {
    eng.db.exec(`UPDATE service_tickets SET approved_by = NULL, approved_at = NULL WHERE id = 'st1';
      INSERT INTO service_ticket_events (id, organization_id, ticket_id, kind, actor_kind, actor_user_id, detail, created_at) VALUES
        ('e3', 1, 'st1', 'status_changed', 'user', 10, '{"from":"work_complete","to":"approved"}', '2026-09-14 13:00:00')`);
    const { summary } = (await report(WIDE, 'st1')).body;
    expect(summary.approved.name).toBe('Wendy Wide');
    expect(summary.approved.at_label).toMatch(/^Sep 14, 2026 at 9:00\sAM$/);
  });

  test('MUTANT: listing shares without the silent write check hands a view grant the recipients', async () => {
    const mut = mutant('    if (write && write.ok === true) shares = await listShares(ticket, input.tz);',
      '    shares = await listShares(ticket, input.tz);');
    expect((await send(WIDE, 'st1', { email: 'pm@property.test', name: 'Pat PM' })).statusCode).toBe(200);
    const r = await report(CREW, 'st1', {}, mut);
    expect(JSON.stringify(r.body.shares)).toContain('pm@property.test');
    expect((await report(CREW, 'st1')).body.shares).toBeNull();
  });
});

describe('sending the completion report', () => {
  test('refusals write nothing: not approved, archived, no buildings, a bad email, a view grant, another org', async () => {
    const cases = [
      [await send(WIDE, 'st_ip', { email: 'pm@property.test' }), 409, { error: 'Approve the work order before sending the completion report.' }],
      [await send(WIDE, 'st_arch', { email: 'pm@property.test' }), 409, { error: 'This ticket is archived.' }],
      [await send(WIDE, 'st_empty', { email: 'pm@property.test' }), 422, { error: 'This work order has no buildings to report on yet.' }],
      [await send(WIDE, 'st1', { email: 'not an email' }), 400, { error: 'Enter a valid email address, or leave it blank to get a link only.' }],
      [await send(CREW, 'st1', { email: 'pm@property.test' }), 404, { error: 'Service ticket not found' }],
      [await send(RIVAL, 'st1', { email: 'pm@property.test' }), 404, { error: 'Service ticket not found' }],
    ];
    for (const [r, status, body] of cases) expect([r.statusCode, r.body]).toEqual([status, body]);
    expect(shareRows()).toHaveLength(0);
    expect(mockEmails).toHaveLength(0);
    expect(eng.count("SELECT 1 FROM service_ticket_events WHERE kind = 'completion_report_sent'")).toBe(0);
  });

  test('an approved work order mints a view-only ticket link, emails it, and records it without the address', async () => {
    const preview = await report(WIDE, 'st1');
    const r = await send(WIDE, 'st1', { email: 'pm@property.test', name: 'Pat PM' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatchObject({ ok: true, email_sent: true, email_error: null });
    expect(r.body.link).toMatch(/^https:\/\/project86\.test\/r\/[a-f0-9]{64}$/);
    expect(r.body.share).toMatchObject({ recipient_email: 'pm@property.test', recipient_name: 'Pat PM', state: 'sent' });

    const rows = shareRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      id: r.body.share.id, organization_id: 1, report_id: null, service_ticket_id: 'st1',
      entity_type: 'service_ticket', entity_id: 'st1', scope: 'view', hide_financials: 1,
      recipient_email: 'pm@property.test', recipient_name: 'Pat PM', created_by: WIDE, view_count: 0,
    });
    expect(row.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.token_hash).not.toBe(tokenOf(r.body.link));
    expect(withoutBuiltAt(row.document)).toEqual(withoutBuiltAt(preview.body.document));

    expect(mockEmails).toHaveLength(1);
    const mail = mockEmails[0];
    expect(mail.to).toBe('pm@property.test');
    expect(mail.subject).toBe('AG Exteriors: completion report for Latitude 28 stairs');
    expect(mail.html).toContain(r.body.link.replace(/&/g, '&amp;'));
    expect(mail.html).toContain('Hi Pat PM,');
    expect(mail.html).toContain('View the completion report');
    expect(mail.html).not.toContain('$');
    expect(mail.text).toContain(r.body.link);
    expect(mail.text).not.toContain('$');
    expect(mail.tag).toBe('service_ticket_completion_report');
    expect(mail.replyTo).toBe('wendy.reply@agx.test');
    expect(mail.senderOrg).toEqual({ id: 1, name: 'AG Exteriors' });
    expect(mockReplyToCalls).toEqual([[WIDE, 1]]);

    const ev = eventsOf('st1', 'completion_report_sent');
    expect(ev).toHaveLength(1);
    expect(ev[0].detail).toEqual({ report_share_id: row.id, emailed: true, buildings: 2, photos: 2, notes_included: true });
    expect(JSON.stringify(ev[0].detail)).not.toContain('@');

    const list = (await report(WIDE, 'st1')).body.shares;
    expect(list.map((s) => [s.id, s.recipient_email, s.state, s.view_count])).toEqual([[row.id, 'pm@property.test', 'sent', 0]]);
    expect(list[0].expires_label).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
  });

  test('no email: a link only, nothing sent; a failed email still returns the link', async () => {
    const linkOnly = await send(WIDE, 'st1', { include_notes: false });
    expect(linkOnly.statusCode).toBe(200);
    expect(linkOnly.body.email_sent).toBe(false);
    expect(linkOnly.body.link).toMatch(/\/r\/[a-f0-9]{64}$/);
    expect(mockEmails).toHaveLength(0);
    expect(shareRows()[0].document.sections.some((s) => /crew notes/.test(s.label))).toBe(false);
    expect(eventsOf('st1', 'completion_report_sent')[0].detail).toMatchObject({ emailed: false, notes_included: false });

    mockEmailResult = { ok: false, error: 'smtp down' };
    const failed = await send(WIDE, 'st1', { email: 'pm@property.test' });
    expect(failed.statusCode).toBe(200);
    expect([failed.body.email_sent, failed.body.email_error]).toEqual([false, 'smtp down']);
    expect(failed.body.link).toMatch(/\/r\/[a-f0-9]{64}$/);
    expect(eventsOf('st1', 'completion_report_sent')[1].detail.emailed).toBe(false);
  });

  test('a double click makes one link and one email — at once, or one after the other', async () => {
    const [a, b] = await Promise.all([
      send(WIDE, 'st1', { email: 'pm@property.test' }),
      send(WIDE, 'st1', { email: 'pm@property.test' }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const refused = a.statusCode === 409 ? a : b;
    expect(refused.body).toEqual(JUST_SENT);
    expect(shareRows()).toHaveLength(1);
    expect(mockEmails).toHaveLength(1);

    const later = await send(WIDE, 'st1', { email: 'PM@Property.test' });
    expect([later.statusCode, later.body.code]).toEqual([409, 'just_sent']);
    expect(shareRows()).toHaveLength(1);
    expect(mockEmails).toHaveLength(1);

    // Someone else, right after, is a new send.
    const other = await send(WIDE, 'st1', { email: 'owner@property.test' });
    expect(other.statusCode).toBe(200);
    expect(shareRows()).toHaveLength(2);
  });

  test('a link-only double click is one link too', async () => {
    expect((await send(WIDE, 'st1', {})).statusCode).toBe(200);
    const again = await send(WIDE, 'st1', {});
    expect([again.statusCode, again.body]).toEqual([409, JUST_SENT]);
    expect(shareRows()).toHaveLength(1);
  });

  test('an email that failed may be retried at once; once it goes out the next click is refused', async () => {
    mockEmailResult = { ok: false, error: 'smtp down' };
    const failed = await send(WIDE, 'st1', { email: 'pm@property.test' });
    expect([failed.statusCode, failed.body.email_sent]).toEqual([200, false]);

    mockEmailResult = { ok: true };
    const retry = await send(WIDE, 'st1', { email: 'pm@property.test' });
    expect([retry.statusCode, retry.body.email_sent]).toEqual([200, true]);
    expect(shareRows()).toHaveLength(2);
    expect(mockEmails).toHaveLength(2);

    const third = await send(WIDE, 'st1', { email: 'pm@property.test' });
    expect([third.statusCode, third.body]).toEqual([409, JUST_SENT]);
    expect(shareRows()).toHaveLength(2);
    expect(mockEmails).toHaveLength(2);
  });

  function plantInFlightShare() {
    // Another server process has minted a link to this recipient and has not
    // yet recorded how its email went: no completion_report_sent event.
    eng.db.exec(`INSERT INTO report_shares (id, organization_id, report_id, service_ticket_id, entity_type, entity_id, token_hash, scope,
        hide_financials, document, recipient_email, expires_at, view_count, created_by, created_at)
      VALUES ('rs_flight', 1, NULL, 'st1', 'service_ticket', 'st1', '${'b'.repeat(64)}', 'view', 1, '{}', 'pm@property.test',
        '2099-01-01T00:00:00Z', 0, ${WIDE}, datetime('now'))`);
  }

  test('a send still in flight elsewhere (a share with no outcome yet) refuses the repeat', async () => {
    plantInFlightShare();
    const r = await send(WIDE, 'st1', { email: 'pm@property.test' });
    expect([r.statusCode, r.body]).toEqual([409, JUST_SENT]);
    expect(mockEmails).toHaveLength(0);
  });

  test('MUTANT: without the recent-send check a second click makes a second link and a second email', async () => {
    const mut = mutant("          if (recentIds.length && !retry) refusal = [409, { error: MSG.justSent, code: 'just_sent' }];\n", '');
    expect((await send(WIDE, 'st1', { email: 'pm@property.test' }, mut)).statusCode).toBe(200);
    expect((await send(WIDE, 'st1', { email: 'pm@property.test' }, mut)).statusCode).toBe(200);
    expect(shareRows()).toHaveLength(2);
    expect(mockEmails).toHaveLength(2);
  });

  test('MUTANT: a retry check that ignores the earlier outcome blocks the retry of a failed email', async () => {
    const mut = mutant('          const retry = await onlyFailedEmails(client, ticket, email, recentIds);', '          const retry = false;');
    mockEmailResult = { ok: false, error: 'smtp down' };
    expect((await send(WIDE, 'st1', { email: 'pm@property.test' }, mut)).statusCode).toBe(200);
    mockEmailResult = { ok: true };
    const retry = await send(WIDE, 'st1', { email: 'pm@property.test' }, mut);
    expect([retry.statusCode, retry.body.code]).toEqual([409, 'just_sent']);
    expect(mockEmails).toHaveLength(1);
  });

  test('MUTANT: treating a share with no outcome as a failed email lets an in-flight send be repeated', async () => {
    const mut = mutant(
      '    return emailedByShare.has(String(id)) && emailedByShare.get(String(id)) === false;',
      '    return emailedByShare.get(String(id)) !== true;');
    plantInFlightShare();
    const r = await send(WIDE, 'st1', { email: 'pm@property.test' }, mut);
    expect(r.statusCode).toBe(200);
    expect(mockEmails).toHaveLength(1);
  });
});

describe('the public door and turning a link off', () => {
  test('the report share page serves the frozen document, refuses comments, and stops after revoke', async () => {
    const sent = await send(WIDE, 'st1', { email: 'pm@property.test' });
    const token = tokenOf(sent.body.link);
    const stored = shareRows()[0].document;

    const open = await publicRead(token);
    expect(open.statusCode).toBe(200);
    expect(open.body.document).toEqual(stored);
    expect(open.body.share).toEqual({ scope: 'view', expires_at: expect.any(String), recipient_name: null, hide_financials: true });
    const json = JSON.stringify(open.body);
    for (const p of POISON) expect([p, json.indexOf(p)]).toEqual([p, -1]);

    const comment = await publicComment(token);
    expect([comment.statusCode, comment.body]).toEqual([403, { error: 'This link is view-only.' }]);
    expect(eng.count('SELECT 1 FROM report_share_comments')).toBe(0);

    const sid = sent.body.share.id;
    const wrongTicket = await revoke(WIDE, 'st_ip', sid);
    expect([wrongTicket.statusCode, wrongTicket.body]).toEqual([404, { error: 'That link is not on this work order, or it is already off.' }]);
    const crew = await revoke(CREW, 'st1', sid);
    expect(crew.statusCode).toBe(404);
    expect(shareRows()[0].revoked_at).toBeNull();

    const off = await revoke(WIDE, 'st1', sid);
    expect([off.statusCode, off.body]).toEqual([200, { ok: true, id: sid }]);
    expect(eventsOf('st1', 'completion_report_link_off').map((e) => e.detail)).toEqual([{ report_share_id: sid }]);
    const gone = await publicRead(token);
    expect([gone.statusCode, gone.body]).toEqual([410, { error: 'This link has been turned off' }]);
    const again = await revoke(WIDE, 'st1', sid);
    expect(again.statusCode).toBe(404);
    expect((await report(WIDE, 'st1')).body.shares[0].state).toBe('revoked');
  });

  function plantMisfiledShare() {
    // An org-1 link whose parent column names the rival's ticket id.
    eng.db.exec(`INSERT INTO report_shares (id, organization_id, report_id, service_ticket_id, entity_type, entity_id, token_hash, scope,
        hide_financials, document, expires_at, view_count, created_by, created_at)
      VALUES ('rs_misfiled', 1, NULL, 'stb', 'service_ticket', 'st1', '${'a'.repeat(64)}', 'view', 1, '{}', '2099-01-01T00:00:00Z', 0, 10, '2026-09-15 10:00:00')`);
  }

  test('a revoke is pinned to the caller’s org as well as the work order', async () => {
    plantMisfiledShare();
    const r = await revoke(RIVAL, 'stb', 'rs_misfiled');
    expect(r.statusCode).toBe(404);
    expect(eng.all("SELECT revoked_at FROM report_shares WHERE id = 'rs_misfiled'")[0].revoked_at).toBeNull();
  });

  test('MUTANT: without organization_id on the revoke UPDATE another org turns this org’s link off', async () => {
    plantMisfiledShare();
    const mut = mutant(
      '        WHERE id = $1 AND service_ticket_id = $2 AND organization_id = $3 AND revoked_at IS NULL',
      '        WHERE id = $1 AND service_ticket_id = $2 AND $3 IS NOT NULL AND revoked_at IS NULL');
    const r = await revoke(RIVAL, 'stb', 'rs_misfiled', mut);
    expect(r.statusCode).toBe(200);
    expect(eng.all("SELECT revoked_at FROM report_shares WHERE id = 'rs_misfiled'")[0].revoked_at).not.toBeNull();
  });
});
