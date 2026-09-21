// FIELD CAPTURE (Phase 3) — the crew's time, work performed and materials
// used on a work order billed after the work, and the office's accept /
// correct / reject. EXECUTED through the shipped routers.
//
// John, 2026-09-19: "we need to bill based on work performed and materials and
// mark-up after the job is done ... more info needs to be gathered from the
// service tech on these." And on who enters it: "Both: tech optional, office
// can enter."
//
// What is asserted here:
//   * the card, and the doors behind it, exist only on bill_as
//     'time_materials' — never on the displayed word, and never on the
//     tickets that predate the two kinds ('none');
//   * a crew line is a CLAIM: stored `submitted`, its org, ticket and link
//     taken from the rows in hand and never the body, one row per Send even
//     when the answer is lost and it is sent again;
//   * the office accepts, corrects or rejects it, and a correction sits BESIDE
//     the claim — the tech's number is never overwritten;
//   * a crew link sees only the lines IT sent, with a status word, and never
//     the office's numbers, notes or any total;
//   * another tenant cannot read or decide a line;
//   * THE FINISH RULE, on all three roads to Work complete — the crew's
//     Finish, the office's status door, and the last building ticked: a work
//     order billed after the work does not get there with no time on it, and
//     the office's "finish it anyway" is its own question, not the buildings'.
//
// Each guard is then removed from a copy of the shipped file and the same
// drive goes red.
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
jest.mock('../server/services/work-order-notices', () => ({
  notifyProblemFlagged: async () => ({ sent: 0 }),
  notifyAssigned: async () => ({ sent: 0 }),
  sendBackRecipients: async () => [],
  notifySentBack: async () => ({ sent: 0 }),
}));
jest.mock('../server/services/service-ticket-notify', () => ({
  notifyAwaitingApproval: async () => ({ sent: 0 }),
}));

const ROUTES_DIR = path.join(__dirname, '..', 'server', 'routes');
const SERVICES_DIR = path.join(__dirname, '..', 'server', 'services');
const FIELD_ROUTES = path.join(ROUTES_DIR, 'service-ticket-field-routes.js');
const FIELD_SERVICE = path.join(SERVICES_DIR, 'service-ticket-field-capture.js');

const fc = require('../server/services/service-ticket-field-capture');

const TABLES = [
  'organizations', 'users', 'roles', 'jobs', 'job_access', 'leads', 'tasks', 'attachments', 'clients', 'estimates',
  'service_tickets', 'service_ticket_events', 'service_ticket_shares', 'service_ticket_revisions',
  'service_ticket_flags', 'service_ticket_participants', 'service_ticket_labor', 'service_ticket_materials_used',
];

const WIDE = 10;
const RIVAL = 50;
const USERS = {
  [WIDE]: { role: 'fc_wide', org: 1 },
  [RIVAL]: { role: 'fc_wide', org: 2 },
};

// respond link and a second respond link on the T&M work order; a view link;
// a link on a ticket that bills nothing; a link on an approved T&M ticket.
const TOK = {
  tm: 'a'.repeat(64), tm2: 'b'.repeat(64), view: 'c'.repeat(64), none: 'd'.repeat(64), approved: 'e'.repeat(64),
};

let eng;
let auth;
let svc;
let shareRouter;
let ticketRouter;
let mutantPaths = [];

function seed() {
  const caps = (list) => "'" + JSON.stringify(list) + "'";
  const future = '2099-01-01T00:00:00.000Z';
  eng.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM roles; DELETE FROM jobs; DELETE FROM job_access;
    DELETE FROM leads; DELETE FROM tasks; DELETE FROM attachments; DELETE FROM clients; DELETE FROM estimates;
    DELETE FROM service_tickets; DELETE FROM service_ticket_events; DELETE FROM service_ticket_shares;
    DELETE FROM service_ticket_revisions; DELETE FROM service_ticket_flags; DELETE FROM service_ticket_participants;
    DELETE FROM service_ticket_labor; DELETE FROM service_ticket_materials_used;

    INSERT INTO organizations (id, name, timezone) VALUES (1, 'AGX', 'America/New_York'), (2, 'Rival Co', 'America/New_York');
    INSERT INTO roles (name, capabilities) VALUES
      ('fc_wide', ${caps(['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'LEADS_VIEW', 'LEADS_EDIT'])});
    INSERT INTO users (id, name, email, role, organization_id, active) VALUES
      (10, 'Wendy Wide', 'w@agx.test', 'fc_wide', 1, 1),
      (50, 'Rival Ray', 'r@rival.test', 'fc_wide', 2, 1);
    INSERT INTO jobs (id, owner_id, data, organization_id) VALUES ('j1', 10, '{}', 1), ('j9', 50, '{}', 2);

    INSERT INTO service_tickets (id, organization_id, title, job_id, status, bill_as, ticket_kind, checklist, created_by, approval_notice_attempts, archived_at, created_at) VALUES
      ('st_tm',   1, 'Pump room leak',   'j1', 'in_progress', 'time_materials', 'work_order', '[]', 10, 0, NULL, '2026-09-01 10:00:00'),
      ('st_none', 1, 'Old rails ticket', 'j1', 'in_progress', 'none',           'work_order', '[]', 10, 0, NULL, '2026-09-01 10:00:01'),
      ('st_ap',   1, 'Approved T&M',     'j1', 'approved',    'time_materials', 'work_order', '[]', 10, 0, NULL, '2026-09-01 10:00:02'),
      ('st_b',    2, 'Rival T&M',        'j9', 'in_progress', 'time_materials', 'work_order', '[]', 50, 0, NULL, '2026-09-01 10:00:03');

    INSERT INTO tasks (id, organization_id, title, status, scope, owner_user_id, service_ticket_id, entity_type, entity_id, archived_at, created_at) VALUES
      ('k1', 1, 'Bldg 4 pump room', 'open', 'org', NULL, 'st_tm', 'job', 'j1', NULL, '2026-09-02 08:00:00'),
      ('kn', 1, 'Bldg 9 rails',     'open', 'org', NULL, 'st_none', 'job', 'j1', NULL, '2026-09-02 08:00:01'),
      ('kx', 1, 'Some other ticket building', 'open', 'org', NULL, 'st_ap', 'job', 'j1', NULL, '2026-09-02 08:00:02');
  `);
  // A completion photo on each building, so ticking it is allowed.
  const att = eng.db.prepare(
    'INSERT INTO attachments (id, entity_type, entity_id, organization_id, folder, filename, mime_type, thumb_url, web_url, original_url, tags, position, uploaded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  att.run('att_k1', 'task', 'k1', 1, 'general', 'done.jpg', 'image/jpeg', 'https://cdn.test/t', 'https://cdn.test/w', 'https://cdn.test/o', '[]', 0, '2026-09-03 10:00:00');
  att.run('att_kn', 'task', 'kn', 1, 'general', 'done.jpg', 'image/jpeg', 'https://cdn.test/t', 'https://cdn.test/w', 'https://cdn.test/o', '[]', 0, '2026-09-03 10:00:00');
  const share = eng.db.prepare(
    'INSERT INTO service_ticket_shares (id, organization_id, ticket_id, token_hash, scope, hide_financials, recipient_email, recipient_name, expires_at, revoked_at, created_by, view_count, opened_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  share.run('sh_tm', 1, 'st_tm', svc.hashToken(TOK.tm), 'respond', 1, 'marco@sub.test', 'Marco', future, null, 10, 0, '2026-09-02 09:00:00', '2026-09-02 09:00:00');
  share.run('sh_tm2', 1, 'st_tm', svc.hashToken(TOK.tm2), 'respond', 1, 'luis@sub.test', 'Luis', future, null, 10, 0, '2026-09-02 09:00:00', '2026-09-02 09:00:00');
  share.run('sh_view', 1, 'st_tm', svc.hashToken(TOK.view), 'view', 1, 'pm@client.test', null, future, null, 10, 0, '2026-09-02 09:00:00', '2026-09-02 09:00:00');
  share.run('sh_none', 1, 'st_none', svc.hashToken(TOK.none), 'respond', 1, 'marco@sub.test', 'Marco', future, null, 10, 0, '2026-09-02 09:00:00', '2026-09-02 09:00:00');
  share.run('sh_ap', 1, 'st_ap', svc.hashToken(TOK.approved), 'respond', 1, 'marco@sub.test', 'Marco', future, null, 10, 0, '2026-09-02 09:00:00', '2026-09-02 09:00:00');
}

beforeAll(async () => {
  eng = createPgSqlite(sqliteSchema(TABLES), {
    jsonColumns: ['checklist', 'capabilities', 'detail', 'fields', 'data', 'tags', 'materials', 'crew_takeoff'],
  });
  const db = require('../server/db');
  db.pool.query = eng.pool.query;
  db.pool.connect = eng.pool.connect;
  svc = require('../server/services/service-tickets');
  auth = require('../server/auth');
  auth.setRolePool(eng.pool);
  seed();
  await auth.refreshRoleCache();
  shareRouter = require('../server/routes/service-ticket-share-routes');
  ticketRouter = require('../server/routes/service-ticket-routes');
});

beforeEach(() => seed());

afterEach(() => {
  for (const p of mutantPaths) {
    try { delete require.cache[require.resolve(p)]; } catch (e) { /* never loaded */ }
    try { fs.unlinkSync(p); } catch (e) { /* already gone */ }
  }
  mutantPaths = [];
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 25));
  require('../server/db').pool.query = async () => ({ rows: [], rowCount: 0 });
  if (eng) eng.close();
});

// ── the drive ─────────────────────────────────────────────────────────────
function fakeRes() {
  const res = { statusCode: 200, body: undefined, headersSent: false };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.body = p; res.headersSent = true; return res; };
  res.set = () => res;
  res.setHeader = () => res;
  return res;
}

function tokenFor(uid) {
  const u = USERS[uid];
  return auth.signToken({ id: uid, email: uid + '@t.test', name: 'U' + uid, role: u.role, organization_id: u.org });
}

// Runs the declared chain from `fromHandler` on — the rate limiters in front
// of a public door are the library's, and are asserted by the route census.
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
    query: {},
    body: o.body || {},
    cookies: {},
    headers: o.as ? { authorization: 'Bearer ' + tokenFor(o.as) } : {},
    protocol: 'https',
    ip: '127.0.0.1',
    get: () => 'project86.test',
  };
  for (const h of chain) {
    let advanced = false;
    await h(req, res, (err) => { if (err) throw err; advanced = true; });
    if (!advanced) break;
  }
  return res;
}

const TODAY = require('../server/timezone').localDateInTz('America/New_York');
const LABOR = { work_date: TODAY, crew_size: 2, hours: '6.5', work_performed: 'Replaced the failed check valve and re-primed the pump.' };
const MATERIAL = { description: '2" PVC check valve', quantity: '1', unit: 'ea' };

const crewSend = (router, token, kind, body) => drive(router || shareRouter, 'post',
  '/service-ticket-share/:token/' + (kind === 'labor' ? 'labor' : 'materials-used'),
  { params: { token }, body, fromHandler: 'loadTicketShare' });
const crewRead = (router, token) => drive(router || shareRouter, 'get', '/service-ticket-share/:token',
  { params: { token }, fromHandler: 'loadTicketShare' });
const crewPatch = (token, body) => drive(shareRouter, 'patch', '/service-ticket-share/:token',
  { params: { token }, body, fromHandler: 'loadTicketShare' });
const crewTick = (token, taskId) => drive(shareRouter, 'post', '/service-ticket-share/:token/subtasks/:taskId/done',
  { params: { token, taskId }, body: { done: true }, fromHandler: 'loadTicketShare' });
const officeEnter = (as, id, kind, body, router) => drive(router || shareRouter, 'post',
  '/service-tickets/:id/' + (kind === 'labor' ? 'labor' : 'materials-used'), { as, params: { id }, body });
const officeDecide = (as, id, kind, lineId, body) => drive(shareRouter, 'post',
  '/service-tickets/:id/' + (kind === 'labor' ? 'labor' : 'materials-used') + '/:lineId/decide',
  { as, params: { id, lineId }, body });
const fieldLog = (as, id) => drive(shareRouter, 'get', '/service-tickets/:id/field-log', { as, params: { id } });
const officeStatus = (as, id, body) => drive(ticketRouter, 'post', '/:id/status', { as, params: { id }, body });

const laborRows = () => eng.all('SELECT * FROM service_ticket_labor ORDER BY created_at, id');
const materialRows = () => eng.all('SELECT * FROM service_ticket_materials_used ORDER BY created_at, id');
const ticket = (id) => eng.all('SELECT * FROM service_tickets WHERE id = ?', id)[0];
const events = (kind) => eng.all('SELECT * FROM service_ticket_events WHERE kind = ?', kind);
const answer = (r) => [r.statusCode, r.body && r.body.error];
const parsed = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

// ── mutants ───────────────────────────────────────────────────────────────
function absolutize(src, fromDir) {
  return src.replace(/require\((['"])([^'"]+)\1\)/g, (_m, _q, spec) => {
    const resolved = spec.charAt(0) === '.'
      ? require.resolve(path.resolve(fromDir, spec))
      : require.resolve(spec, { paths: [fromDir] });
    return 'require(' + JSON.stringify(resolved.split(path.sep).join('/')) + ')';
  });
}
function writeMutant(file, pairs) {
  let out = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  for (const [find, replace] of pairs) {
    const hits = out.split(find).length - 1;
    if (hits !== 1) throw new Error('anchor ' + (hits ? 'ambiguous' : 'not found') + ': ' + JSON.stringify(find.slice(0, 100)));
    out = out.split(find).join(replace);
  }
  out = absolutize(out, path.dirname(file));
  const p = path.join(os.tmpdir(), '_p86_fc_mutant_' + process.pid + '_' + Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, out, 'utf8');
  mutantPaths.push(p);
  return p;
}
// The field routes with one guard removed, registered on a fresh router with
// the shipped share file's own dependencies (taken off the shipped router's
// flag doors is not possible, so they are rebuilt from the share file's
// exports of behaviour: the same module, loaded again, registers them).
function mutantFieldRouter(pairs) {
  const mutantRoutes = require(writeMutant(FIELD_ROUTES, pairs));
  const express = require('express');
  const r = express.Router();
  const lt = shareRouter.stack.find((l) => l.route && l.route.path === '/service-ticket-share/:token/labor');
  const loadTicketShare = lt.route.stack.map((s) => s.handle).find((h) => h.name === 'loadTicketShare');
  mutantRoutes.registerFieldCaptureRoutes(r, {
    loadTicketShare,
    crewGate: (req, res) => {
      if (!svc.scopeAllows(req.share.scope, 'respond')) { res.status(403).json({ error: 'view-only' }); return false; }
      const v = svc.crewSubtasksWritable(req.ticket.status);
      if (!v.ok) { res.status(409).json({ error: v.reason }); return false; }
      return true;
    },
    crewActor: (share) => ({ kind: 'share', shareId: share.id, label: share.recipient_name || null }),
    applyCrewName: async () => {},
    ticketAccessOk: async () => true,
    loadOwnedTicket: async (id, orgId) => eng.all('SELECT * FROM service_tickets WHERE id = ? AND organization_id = ?', id, orgId)[0] || null,
  });
  return r;
}

// ── 1. the rules, with no database ────────────────────────────────────────

describe('what a line is allowed to say', () => {
  test('a time line needs a real day, a crew, hours and what was done', () => {
    expect(fc.validateLabor(LABOR, { today: TODAY })).toMatchObject({ ok: true, crewSize: 2, hours: 6.5 });
    const refuse = (b) => fc.validateLabor(Object.assign({}, LABOR, b), { today: '2026-09-21' }).field;
    expect(refuse({ work_date: '2026-02-30' })).toBe('work_date');
    expect(refuse({ work_date: '2026-09-25' })).toBe('work_date');       // not happened yet
    expect(refuse({ work_date: '2025-01-01' })).toBe('work_date');       // over a year ago
    expect(refuse({ crew_size: 0 })).toBe('crew_size');
    expect(refuse({ crew_size: 51 })).toBe('crew_size');
    expect(refuse({ crew_size: '2.5' })).toBe('crew_size');
    expect(refuse({ hours: '0' })).toBe('hours');
    expect(refuse({ hours: '25' })).toBe('hours');
    expect(refuse({ hours: '6.555' })).toBe('hours');
    expect(refuse({ hours: '-3' })).toBe('hours');
    expect(refuse({ work_performed: '   ' })).toBe('work_performed');
  });

  test('tomorrow is allowed — a crew finishing past midnight is still writing up today', () => {
    expect(fc.validateLabor(Object.assign({}, LABOR, { work_date: '2026-09-22' }), { today: '2026-09-21' }).ok).toBe(true);
  });

  test('a material needs what it was and how much', () => {
    expect(fc.validateMaterial(MATERIAL)).toMatchObject({ ok: true, quantity: 1, unit: 'ea' });
    expect(fc.validateMaterial({ quantity: '1' }).field).toBe('description');
    expect(fc.validateMaterial({ description: 'Valve', quantity: '1,200' }).field).toBe('quantity');
    expect(fc.validateMaterial({ description: 'Valve', quantity: '0' }).field).toBe('quantity');
  });

  test('a correction equal to the claim is not a correction', () => {
    const d = fc.validateDecision('labor', { decision: 'accept', hours: '6.5', crew_size: 2 }, { hours: 6.5, crew_size: 2 });
    expect(d.office).toEqual({ office_hours: null, office_crew_size: null });
    const c = fc.validateDecision('labor', { decision: 'accept', hours: '6' }, { hours: 6.5, crew_size: 2 });
    expect(c.office).toEqual({ office_hours: 6, office_crew_size: null });
  });

  test('a rejection clears any correction, so a rejected line bills nothing', () => {
    expect(fc.validateDecision('material', { decision: 'reject', quantity: '4' }, { quantity: 1 }))
      .toEqual({ ok: true, status: 'rejected', office: { office_quantity: null }, note: null });
    expect(fc.validateDecision('labor', { decision: 'maybe' }, {}).field).toBe('decision');
  });

  test('the crew word never carries the office number', () => {
    expect(fc.crewStatusWord({ status: 'submitted' })).toBe('sent');
    expect(fc.crewStatusWord({ status: 'accepted' })).toBe('accepted');
    expect(fc.crewStatusWord({ status: 'accepted', office_hours: 6 })).toBe('changed');
    expect(fc.crewStatusWord({ status: 'rejected', office_hours: 6 })).toBe('not_accepted');
  });

  test('person-hours are the office number when it corrected one, and nothing when rejected', () => {
    expect(fc.officeLine('labor', { status: 'accepted', crew_size: 2, hours: 6.5 }).person_hours).toBe(13);
    expect(fc.officeLine('labor', { status: 'accepted', crew_size: 2, hours: 6.5, office_hours: 6 }).person_hours).toBe(12);
    expect(fc.officeLine('labor', { status: 'rejected', crew_size: 2, hours: 6.5 }).person_hours).toBeNull();
  });

  test('only ACCEPTED lines count toward the office total; waiting ones are counted apart', () => {
    const s = fc.officeSummary([
      { status: 'accepted', person_hours: 13 },
      { status: 'submitted', person_hours: 40 },
      { status: 'rejected', person_hours: null },
    ], [{ status: 'submitted' }]);
    expect(s).toEqual({ waiting: 2, accepted_person_hours: 13, accepted_labor: 1, accepted_materials: 0 });
  });

  test('the switch is bill_as alone, never the word on the screen', () => {
    expect(fc.fieldCaptureOn({ bill_as: 'time_materials', ticket_kind: 'work_order' })).toBe(true);
    expect(fc.fieldCaptureOn({ bill_as: 'none', ticket_kind: 'work_order' })).toBe(false);
    expect(fc.fieldCaptureOn({ bill_as: 'contract', ticket_kind: 'service_ticket' })).toBe(false);
    expect(fc.fieldCaptureOn({ ticket_kind: 'work_order' })).toBe(false);
  });
});

// ── 2. the crew sends lines ───────────────────────────────────────────────

describe('a crew link sends its time and what it used', () => {
  test('stored as a claim, with the org, ticket and link from the rows in hand — never the body', async () => {
    const r = await crewSend(null, TOK.tm, 'labor', Object.assign({}, LABOR, {
      task_id: 'k1', organization_id: 2, ticket_id: 'st_b', share_id: 'sh_none', status: 'accepted',
      source: 'office', office_hours: 99, client_ref: 'ref-labor-0001',
    }));
    expect(r.statusCode).toBe(200);
    const [row] = laborRows();
    expect(row).toMatchObject({
      organization_id: 1, ticket_id: 'st_tm', share_id: 'sh_tm', task_id: 'k1', source: 'crew',
      status: 'submitted', crew_size: 2, hours: 6.5, author_label: 'Marco', office_hours: null,
    });
    expect(events('labor_sent')).toHaveLength(1);
    // The answer is the crew whitelist.
    expect(Object.keys(r.body.line).sort())
      .toEqual(['created_at', 'crew_size', 'hours', 'id', 'status', 'task_id', 'work_date', 'work_performed']);
  });

  test('a Send whose answer was lost, sent again, stores ONE line and one event', async () => {
    const body = Object.assign({ client_ref: 'ref-retry-0001' }, MATERIAL);
    const first = await crewSend(null, TOK.tm, 'material', body);
    const again = await crewSend(null, TOK.tm, 'material', body);
    expect([first.statusCode, again.statusCode, again.body.duplicate]).toEqual([200, 200, true]);
    expect(again.body.line.id).toBe(first.body.line.id);
    expect(materialRows()).toHaveLength(1);
    expect(events('material_sent')).toHaveLength(1);
  });

  test('a work order that bills nothing has no such door, and nothing is written', async () => {
    expect(answer(await crewSend(null, TOK.none, 'labor', LABOR))).toEqual([409, fc.MSG.notTimeAndMaterials]);
    expect(answer(await crewSend(null, TOK.none, 'material', MATERIAL))).toEqual([409, fc.MSG.notTimeAndMaterials]);
    expect(laborRows().length + materialRows().length).toBe(0);
  });

  test('a view link, and an approved work order, cannot send', async () => {
    expect((await crewSend(null, TOK.view, 'labor', LABOR)).statusCode).toBe(403);
    expect((await crewSend(null, TOK.approved, 'labor', LABOR)).statusCode).toBe(409);
    expect(laborRows()).toHaveLength(0);
  });

  test("a building from another work order is 'not on this work order'", async () => {
    const r = await crewSend(null, TOK.tm, 'labor', Object.assign({}, LABOR, { task_id: 'kx' }));
    expect(answer(r)).toEqual([404, fc.MSG.buildingNotFound]);
    expect(laborRows()).toHaveLength(0);
  });

  test('a bad line is refused by name, before anything is written', async () => {
    const r = await crewSend(null, TOK.tm, 'labor', Object.assign({}, LABOR, { hours: '30' }));
    expect([r.statusCode, r.body.field]).toEqual([400, 'hours']);
    expect(laborRows()).toHaveLength(0);
  });
});

// ── 3. what a crew link sees ──────────────────────────────────────────────

describe('a crew link sees only what it sent, and never the office numbers', () => {
  test('no card at all on a work order that bills nothing', async () => {
    const r = await crewRead(null, TOK.none);
    expect(r.statusCode).toBe(200);
    expect(r.body.field_capture).toBeNull();
  });

  test('its own lines only — not the other link’s, not the office’s', async () => {
    await crewSend(null, TOK.tm, 'labor', LABOR);
    await crewSend(null, TOK.tm2, 'labor', Object.assign({}, LABOR, { hours: '3' }));
    await officeEnter(WIDE, 'st_tm', 'labor', Object.assign({}, LABOR, { hours: '1' }));
    const r = await crewRead(null, TOK.tm);
    expect(r.body.field_capture.on).toBe(true);
    expect(r.body.field_capture.labor.map((l) => l.hours)).toEqual([6.5]);
  });

  test('after the office corrects it the crew sees "changed", and never the corrected number or the note', async () => {
    const sent = await crewSend(null, TOK.tm, 'labor', LABOR);
    await officeDecide(WIDE, 'st_tm', 'labor', sent.body.line.id,
      { decision: 'accept', hours: '5', note: 'Billed at $95/hr per the MSA' });
    const r = await crewRead(null, TOK.tm);
    const line = r.body.field_capture.labor[0];
    expect(line.status).toBe('changed');
    expect(line.hours).toBe(6.5);
    const text = JSON.stringify(r.body.field_capture);
    expect(text).not.toMatch(/office|\$95|MSA|person_hours|"5"/);
  });
});

// ── 4. the office ─────────────────────────────────────────────────────────

describe('the office enters, accepts, corrects and rejects', () => {
  test('a line the office types is born accepted, and says the office entered it', async () => {
    const r = await officeEnter(WIDE, 'st_tm', 'labor', Object.assign({}, LABOR, { by: 'Marco (phoned in)' }));
    expect(r.statusCode).toBe(200);
    expect(r.body.line).toMatchObject({ source: 'office', status: 'accepted', author_label: 'Marco (phoned in)', person_hours: 13 });
    expect(laborRows()[0]).toMatchObject({ source: 'office', share_id: null, entered_by: 10, decided_by: 10 });
    expect(events('labor_entered')).toHaveLength(1);
  });

  test('correcting a line leaves the claim beside the correction', async () => {
    const sent = await crewSend(null, TOK.tm, 'labor', LABOR);
    const d = await officeDecide(WIDE, 'st_tm', 'labor', sent.body.line.id, { decision: 'accept', hours: '6' });
    expect(d.statusCode).toBe(200);
    expect(laborRows()[0]).toMatchObject({ hours: 6.5, office_hours: 6, status: 'accepted', decided_by: 10 });
    expect(d.body.line.person_hours).toBe(12);
    const ev = events('field_line_decided')[0];
    expect(parsed(ev.detail)).toMatchObject({ kind: 'labor', decision: 'accepted', corrected: true });
  });

  test('the field log totals only what was accepted', async () => {
    const a = await crewSend(null, TOK.tm, 'labor', LABOR);                                   // 2 x 6.5
    await crewSend(null, TOK.tm2, 'labor', Object.assign({}, LABOR, { crew_size: 1, hours: '8' })); // waiting
    await officeDecide(WIDE, 'st_tm', 'labor', a.body.line.id, { decision: 'accept' });
    await crewSend(null, TOK.tm, 'material', MATERIAL);
    const r = await fieldLog(WIDE, 'st_tm');
    expect(r.statusCode).toBe(200);
    expect(r.body.summary).toEqual({ waiting: 2, accepted_person_hours: 13, accepted_labor: 1, accepted_materials: 0 });
    // Waiting lines first.
    expect(r.body.labor[0].status).toBe('submitted');
  });

  test('a work order that bills nothing takes no office line either', async () => {
    expect(answer(await officeEnter(WIDE, 'st_none', 'material', MATERIAL))).toEqual([409, fc.MSG.notTimeAndMaterials]);
  });

  test("another tenant cannot read or decide a line, and the line is untouched", async () => {
    const sent = await crewSend(null, TOK.tm, 'labor', LABOR);
    expect((await fieldLog(RIVAL, 'st_tm')).statusCode).toBe(404);
    expect((await officeDecide(RIVAL, 'st_tm', 'labor', sent.body.line.id, { decision: 'reject' })).statusCode).toBe(404);
    expect(laborRows()[0].status).toBe('submitted');
  });

  test("a line from another work order is not found through this one", async () => {
    eng.db.prepare(
      "INSERT INTO service_ticket_labor (id, organization_id, ticket_id, source, work_date, crew_size, hours, work_performed, status, created_at) VALUES ('lab_other', 1, 'st_ap', 'crew', ?, 1, 2, 'x', 'submitted', '2026-09-03 10:00:00')"
    ).run(TODAY);
    const r = await officeDecide(WIDE, 'st_tm', 'labor', 'lab_other', { decision: 'reject' });
    expect(answer(r)).toEqual([404, fc.MSG.lineNotFound]);
    expect(eng.all("SELECT status FROM service_ticket_labor WHERE id = 'lab_other'")[0].status).toBe('submitted');
  });
});

// ── 5. the finish rule, on all three roads ────────────────────────────────

describe('a work order billed after the work does not finish without time', () => {
  test("the crew's Finish is refused with no time, and allowed once there is some", async () => {
    await crewTickDone();
    const refused = await crewPatch(TOK.tm, { status: 'work_complete' });
    expect([refused.statusCode, refused.body.code]).toEqual([409, 'time_missing']);
    expect(ticket('st_tm').status).toBe('in_progress');
    await crewSend(null, TOK.tm2, 'labor', LABOR);          // any link's time counts
    const ok = await crewPatch(TOK.tm, { status: 'work_complete' });
    expect(ok.statusCode).toBe(200);
    expect(ticket('st_tm').status).toBe('work_complete');
  });

  test('time the office rejected does not count', async () => {
    await crewTickDone();
    const sent = await crewSend(null, TOK.tm, 'labor', LABOR);
    await officeDecide(WIDE, 'st_tm', 'labor', sent.body.line.id, { decision: 'reject' });
    expect((await crewPatch(TOK.tm, { status: 'work_complete' })).body.code).toBe('time_missing');
  });

  test('a work order that bills nothing finishes exactly as it always did', async () => {
    const ticked = await crewTick(TOK.none, 'kn');
    expect(ticked.statusCode).toBe(200);
    expect(ticket('st_none').status).toBe('work_complete');
  });

  test('the last building ticked does not carry a T&M work order to Work complete with no time', async () => {
    const r = await crewTick(TOK.tm, 'k1');
    expect(r.statusCode).toBe(200);
    expect(ticket('st_tm').status).toBe('in_progress');
  });

  test("the office's status door refuses, and its own override is the only yes", async () => {
    await crewTickDone();
    const refused = await officeStatus(WIDE, 'st_tm', { status: 'work_complete' });
    expect([refused.statusCode, refused.body.code]).toEqual([409, 'time_missing']);
    // The BUILDINGS override is not an answer to a question about time.
    const wrongYes = await officeStatus(WIDE, 'st_tm', { status: 'work_complete', override: true });
    expect(wrongYes.body.code).toBe('time_missing');
    const yes = await officeStatus(WIDE, 'st_tm', { status: 'work_complete', override_time: true });
    expect(yes.statusCode).toBe(200);
    const ev = events('status_changed').map((e) => parsed(e.detail)).find((d) => d.to === 'work_complete');
    expect(ev.override_time).toBe(true);
  });

  test('and with time on it the office door needs no override at all', async () => {
    await crewTickDone();
    await officeEnter(WIDE, 'st_tm', 'labor', LABOR);
    expect((await officeStatus(WIDE, 'st_tm', { status: 'work_complete' })).statusCode).toBe(200);
  });
});

// Ticking the only building on the T&M work order, which (with no time) leaves
// it in progress — the state every finish test starts from.
async function crewTickDone() {
  const r = await crewTick(TOK.tm, 'k1');
  expect(r.statusCode).toBe(200);
  expect(ticket('st_tm').status).toBe('in_progress');
}

// ── 6. every guard, removed ───────────────────────────────────────────────

describe('each guard is load-bearing', () => {
  test('without the bill_as gate, a ticket that bills nothing starts collecting time', async () => {
    const r = mutantFieldRouter([[
      "        if (!fc.fieldCaptureOn(ticket)) return res.status(409).json({ error: fc.MSG.notTimeAndMaterials });\n        const body = req.body || {};\n\n        const today = kind === 'labor' ? await orgToday(ticket.organization_id) : null;",
      "        const body = req.body || {};\n\n        const today = kind === 'labor' ? await orgToday(ticket.organization_id) : null;",
    ]]);
    expect((await crewSend(r, TOK.none, 'labor', LABOR)).statusCode).toBe(200);
    expect(laborRows()).toHaveLength(1);
  });

  test('without the client_ref lookup, a retried Send stores the line twice', async () => {
    const r = mutantFieldRouter([[
      "        if (v.clientRef) {\n          const existing = await fc.findByClientRef(pool, kind, ticket, share.id, v.clientRef);\n          if (existing) return answerDuplicate(existing);\n        }\n",
      '',
    ]]);
    const body = Object.assign({ client_ref: 'ref-retry-0002' }, MATERIAL);
    await crewSend(r, TOK.tm, 'material', body);
    await crewSend(r, TOK.tm, 'material', body);
    expect(materialRows()).toHaveLength(2);
  });

  test("without the link predicate, a crew link reads another link's hours", async () => {
    const mutantSvc = require(writeMutant(FIELD_SERVICE, [[
      "        WHERE ticket_id = $1 AND organization_id = $2 AND share_id = $3 AND source = 'crew'\n        ORDER BY created_at DESC, id DESC\n        LIMIT ${CREW_LIST_LIMIT}`,\n      [ticket.id, ticket.organization_id, String(shareId)]",
      "        WHERE ticket_id = $1 AND organization_id = $2 AND $3 = $3\n        ORDER BY created_at DESC, id DESC\n        LIMIT ${CREW_LIST_LIMIT}`,\n      [ticket.id, ticket.organization_id, String(shareId)]",
    ]]));
    await crewSend(null, TOK.tm, 'labor', LABOR);
    await crewSend(null, TOK.tm2, 'labor', Object.assign({}, LABOR, { hours: '3' }));
    const t = ticket('st_tm');
    const leaked = await mutantSvc.listCrewLines(require('../server/db').pool, t, 'sh_tm', ['k1']);
    expect(leaked.labor.map((l) => l.hours).sort()).toEqual([3, 6.5]);
    const shipped = await fc.listCrewLines(require('../server/db').pool, t, 'sh_tm', ['k1']);
    expect(shipped.labor.map((l) => l.hours)).toEqual([6.5]);
  });

  test('without the rejected-time exclusion, rejected time would let a work order finish', async () => {
    const mutantSvc = require(writeMutant(FIELD_SERVICE, [[
      "WHERE ticket_id = $1 AND organization_id = $2 AND status IN ('submitted', 'accepted')`,",
      'WHERE ticket_id = $1 AND organization_id = $2`,',
    ]]));
    const sent = await crewSend(null, TOK.tm, 'labor', LABOR);
    await officeDecide(WIDE, 'st_tm', 'labor', sent.body.line.id, { decision: 'reject' });
    const t = ticket('st_tm');
    const pool = require('../server/db').pool;
    expect(await mutantSvc.hasUsableTime(pool, t)).toBe(true);
    expect(await fc.hasUsableTime(pool, t)).toBe(false);
  });

  test('the claimed columns are never in the decision UPDATE', () => {
    const src = fs.readFileSync(FIELD_SERVICE, 'utf8');
    const body = src.slice(src.indexOf('async function decideLine'), src.indexOf('async function loadClaim'));
    expect(body).not.toMatch(/'hours = |'crew_size = |'quantity = |sets\.push\('(hours|crew_size|quantity)/);
  });
});
