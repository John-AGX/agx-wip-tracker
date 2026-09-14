// "LET THE CREW LINK SHOW THE TAKEOFF FILE TOO" — THE OFFICE DOOR.
//
// ── WHAT THIS FILE PINS ───────────────────────────────────────────────────
// PUT /api/service-tickets/:id/crew-takeoff { attachment_id } on
// server/routes/service-ticket-routes.js — the one door that decides which
// file, if any, a crew link offers. The crew side (what a link shows, and the
// bytes behind it) is pinned in test/service-ticket-share-takeoff.test.js.
//
//   1. WRITE access on the ticket, the same proof the Materials PATCH asks:
//      a view grant is the missing-ticket 404, no capability the 403 naming
//      it, another tenant's ticket the 404, a closed ticket 409.
//   2. The file comes from loadTicketFile — the ticket's own job, its lead
//      (LEADS_VIEW) and its estimate (ESTIMATES_VIEW). Absent, another job's,
//      another tenant's, capability-filtered and malformed ids all answer ONE
//      identical 404, and nothing is written for any of them.
//   3. has_prices is whatever the price check said, stored as-is; a
//      spreadsheet the check could not read is refused rather than stored as
//      "cannot be checked"; null clears the choice.
//   4. The event says a field changed — never which file.
//
// ── HOW ───────────────────────────────────────────────────────────────────
// The harness of test/service-ticket-materials-extract.test.js: the REAL
// handlers, real requireAuth over a signed JWT, real requireOrgId, the role
// cache loaded from a `roles` table, node:sqlite through the pg shim. Only the
// price check and the storage backend are mocked — the check's own rules are
// pinned in test/materials-extract.test.js; here only WHETHER and WITH WHAT
// the route calls it is under test.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

// ── the mocks ─────────────────────────────────────────────────────────────
// Only detectFilePrices is replaced; takeoffKind stays the real rule, because
// which file types may be shown at all is part of what this door decides.
const mockDetect = jest.fn();
jest.mock('../server/services/materials-extract', () => Object.assign(
  {}, jest.requireActual('../server/services/materials-extract.js'),
  { detectFilePrices: (...args) => mockDetect(...args) }
));

const mockGetBuffer = jest.fn(async (key) => Buffer.from('bytes of ' + key));
jest.mock('../server/storage', () => ({
  storage: { getBuffer: (...args) => mockGetBuffer(...args) },
}));

// Every limiter server/rate-limit.js exports, pass-through, so a router that
// destructures one at load time never gets undefined.
jest.mock('../server/rate-limit', () => {
  const pass = (req, res, next) => next();
  return {
    stShareIpLimiter: pass, stShareViewLimiter: pass, stShareWriteLimiter: pass, stSharePropose: pass,
    ipLoginLimiter: pass, ipGenericLimiter: pass, aiChatLimiter: pass, aiChatHourlyLimiter: pass,
    ingestLimiter: pass, liveJoinLimiter: pass, liveStreamLimiter: pass, liveViewLimiter: pass,
    liveRoomViewLimiter: pass, liveMirrorLimiter: pass, liveSnapLimiter: pass, liveRoomSnapLimiter: pass,
    reportShareIpLimiter: pass, reportShareViewLimiter: pass, reportShareCommentLimiter: pass,
  };
});

const TICKET_ROUTES = path.join(__dirname, '..', 'server', 'routes', 'service-ticket-routes.js');

const TABLES = [
  'organizations', 'users', 'roles', 'jobs', 'job_access', 'leads', 'estimates', 'tasks',
  'service_tickets', 'service_ticket_events', 'service_ticket_shares',
  'service_ticket_revisions', 'service_ticket_participants', 'attachments',
];

const WIDE = 10;      // jobs wide + LEADS_VIEW + ESTIMATES_VIEW
const JOBS = 15;      // jobs wide + LEADS_VIEW, NO ESTIMATES_VIEW
const CREW = 20;      // the narrow tier only
const NOBODY = 40;    // ESTIMATES_VIEW, nothing that reaches a ticket
const RIVAL = 50;     // wide, in ANOTHER organization

const USERS = {
  [WIDE]: { role: 'ct_wide', org: 1 },
  [JOBS]: { role: 'ct_jobs', org: 1 },
  [CREW]: { role: 'ct_crew', org: 1 },
  [NOBODY]: { role: 'ct_none', org: 1 },
  [RIVAL]: { role: 'ct_wide', org: 2 },
};

let eng;
let auth;
let ticketRouter;

function seed() {
  const caps = (list) => "'" + JSON.stringify(list) + "'";
  eng.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM roles; DELETE FROM jobs;
    DELETE FROM job_access; DELETE FROM leads; DELETE FROM estimates; DELETE FROM tasks;
    DELETE FROM service_tickets; DELETE FROM service_ticket_events; DELETE FROM service_ticket_shares;
    DELETE FROM service_ticket_revisions; DELETE FROM service_ticket_participants; DELETE FROM attachments;

    INSERT INTO organizations (id, name) VALUES (1, 'AGX'), (2, 'Rival Co');
    INSERT INTO roles (name, capabilities) VALUES
      ('ct_wide', ${caps(['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'LEADS_VIEW', 'LEADS_EDIT', 'ESTIMATES_VIEW'])}),
      ('ct_jobs', ${caps(['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'LEADS_VIEW'])}),
      ('ct_crew', ${caps(['JOBS_VIEW_ASSIGNED', 'JOBS_EDIT_OWN'])}),
      ('ct_none', ${caps(['ESTIMATES_VIEW'])});
    INSERT INTO users (id, name, email, role, organization_id) VALUES
      (10, 'Wendy Wide', 'w@agx.test', 'ct_wide', 1),
      (15, 'Jo Jobs', 'j@agx.test', 'ct_jobs', 1),
      (20, 'Carl Crew', 'c@agx.test', 'ct_crew', 1),
      (40, 'Nora None', 'n@agx.test', 'ct_none', 1),
      (50, 'Rival Ray', 'r@rival.test', 'ct_wide', 2);

    -- j1: CREW holds a VIEW grant.  j2: CREW holds an EDIT grant, and j2 was
    -- converted from lead l1 and sold from estimate e1.
    INSERT INTO leads (id, title, organization_id) VALUES ('l1', 'Maple St reroof', 1), ('l9', 'Rival lead', 2);
    INSERT INTO estimates (id, owner_id, data, organization_id) VALUES ('e1', 10, '{}', 1), ('e9', 50, '{}', 2);
    INSERT INTO jobs (id, owner_id, data, organization_id, lead_id, estimate_id) VALUES
      ('j1', 10, '{}', 1, NULL, NULL),
      ('j2', 10, '{}', 1, 'l1', 'e1'),
      ('j9', 50, '{}', 2, 'l9', 'e9');
    INSERT INTO job_access (job_id, user_id, access_level) VALUES ('j1', 20, 'view'), ('j2', 20, 'edit');

    INSERT INTO service_tickets (id, organization_id, title, job_id, lead_id, status, checklist, created_at) VALUES
      ('st_j1',     1, 'Gate on j1',  'j1', NULL, 'open',   '[]', '2026-09-01 10:00:01'),
      ('st_j2',     1, 'Gate on j2',  'j2', NULL, 'open',   '[]', '2026-09-01 10:00:02'),
      ('st_closed', 1, 'Closed gate', 'j2', NULL, 'closed', '[]', '2026-09-01 10:00:03'),
      ('st_b',      2, 'RIVAL gate',  'j9', NULL, 'open',   '[]', '2026-09-01 10:00:04');

    INSERT INTO attachments (id, entity_type, entity_id, filename, mime_type, size_bytes, uploaded_at,
                             organization_id, uploaded_by, original_key) VALUES
      ('a_j2_x',   'job', 'j2', 'Lead Report.xlsx',          'application/zip',  20480, '2026-09-10 10:00:00', 1, 10, 'orig/a_j2_x'),
      ('a_j2_p',   'job', 'j2', 'Smith job - 48k bid.pdf',   'application/pdf',   4096, '2026-09-11 10:00:00', 1, 10, 'orig/a_j2_p'),
      ('a_j2_c',   'job', 'j2', 'pull sheet.csv',            'text/csv',          1200, '2026-09-11 10:00:00', 1, 10, 'orig/a_j2_c'),
      ('a_j2_old', 'job', 'j2', 'old takeoff.xls',           'application/vnd.ms-excel', 9000, '2026-09-09 10:00:00', 1, 10, 'orig/a_j2_old'),
      ('a_j2_doc', 'job', 'j2', 'contract.docx',             'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 5000, '2026-09-07 10:00:00', 1, 10, 'orig/a_j2_doc'),
      ('a_j1_c',   'job', 'j1', 'j1.csv',                    'text/csv',          1200, '2026-09-10 10:00:00', 1, 10, 'orig/a_j1_c'),
      ('a_j9',     'job', 'j9', 'rival.xlsx',                'application/zip',   1200, '2026-09-10 10:00:00', 2, 50, 'orig/a_j9'),
      ('a_l1',     'lead', 'l1', 'lead-takeoff.xlsx',        'application/zip',   3000, '2026-09-05 10:00:00', 1, 10, 'orig/a_l1'),
      ('a_e1',     'estimate', 'e1', 'priced estimate.pdf',  'application/pdf',   3000, '2026-09-04 10:00:00', 1, 10, 'orig/a_e1');
  `);
}

beforeAll(async () => {
  eng = createPgSqlite(sqliteSchema(TABLES), {
    jsonColumns: ['checklist', 'capabilities', 'detail', 'fields', 'data', 'crew_takeoff'],
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

beforeEach(() => {
  seed();
  mockDetect.mockReset();
  mockDetect.mockImplementation(async () => false);
  mockGetBuffer.mockClear();
});

// ── the drive ─────────────────────────────────────────────────────────────
function fakeRes() {
  const res = { statusCode: 200, body: undefined, headersSent: false, writes: 0 };
  res.status = (c) => { if (!res.headersSent) res.statusCode = c; return res; };
  res.json = (p) => {
    res.writes += 1;
    if (res.headersSent) throw new Error('response written twice');
    res.body = p;
    res.headersSent = true;
    return res;
  };
  res.set = () => res;
  res.setHeader = () => res;
  res.getHeader = () => undefined;
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

const put = (router, as, id, body) => drive(router, 'put', '/:id/crew-takeoff', { as, params: { id }, body });
const choose = (router, as, id, attachmentId) => put(router, as, id, { attachment_id: attachmentId });
const readTicket = (router, as, id) => drive(router, 'get', '/:id', { as, params: { id } });

const answer = (r) => [r.statusCode, r.body];
const stored = (id) => {
  const v = eng.all('SELECT crew_takeoff FROM service_tickets WHERE id = ?', id)[0].crew_takeoff;
  return typeof v === 'string' ? JSON.parse(v) : v;
};
const writesSince = (n) => eng.log.slice(n).filter((e) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(e.sql));
const TICKET_404 = [404, { error: 'Service ticket not found' }];
const FILE_404 = [404, { error: 'File not found' }];
const NO_WRITE_CAP = [403, { error: 'Missing capability: JOBS_EDIT_ANY JOBS_EDIT_OWN' }];

function mutant(file, pairs) {
  const SOURCE = fs.readFileSync(file, 'utf8');
  const eol = SOURCE.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
  let out = SOURCE;
  for (const [find, replace] of pairs) {
    const f = String(find).replace(/\r?\n/g, eol);
    const r = String(replace).replace(/\r?\n/g, eol);
    const hits = out.split(f).length - 1;
    if (hits === 0) throw new Error('MUTATION ANCHOR NOT FOUND:\n' + JSON.stringify(f.slice(0, 200)));
    if (hits > 1) throw new Error('MUTATION ANCHOR IS AMBIGUOUS (' + hits + ' matches):\n' + JSON.stringify(f.slice(0, 200)));
    out = out.split(f).join(r);
  }
  const dir = path.dirname(file);
  out = out.replace(/require\((['"])([^'"]+)\1\)/g, (_m, _q, spec) => {
    const resolved = spec.charAt(0) === '.'
      ? require.resolve(path.resolve(dir, spec))
      : require.resolve(spec, { paths: [dir] });
    return 'require(' + JSON.stringify(resolved.split(path.sep).join('/')) + ')';
  });
  const p = path.join(os.tmpdir(), '_p86_ct_mutant_' + process.pid + '_' + Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, out, 'utf8');
  mutantPaths.push(p);
  return require(p);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * CHOOSING A FILE
 * ══════════════════════════════════════════════════════════════════════════*/
describe('choosing the file: what is stored, and what the price check decided', () => {
  test('nothing is shown until someone chooses: a fresh ticket has crew_takeoff null, and the office read carries it', async () => {
    expect(stored('st_j2')).toBeNull();
    const r = await readTicket(ticketRouter, WIDE, 'st_j2');
    expect(r.statusCode).toBe(200);
    expect(r.body.ticket).toHaveProperty('crew_takeoff', null);
  });

  test('a spreadsheet with no prices: has_prices false, the proved row and a storage reader go to the check', async () => {
    const r = await choose(ticketRouter, WIDE, 'st_j2', 'a_j2_c');
    expect(r.statusCode).toBe(200);
    expect(r.body.ok).toBe(true);
    const ct = r.body.crew_takeoff;
    expect(ct).toEqual({
      attachment_id: 'a_j2_c', filename: 'pull sheet.csv', kind: 'csv', has_prices: false,
      set_at: expect.any(String), set_by: WIDE,
    });
    expect(Number.isNaN(Date.parse(ct.set_at))).toBe(false);
    expect(stored('st_j2')).toEqual(ct);
    expect(r.body.ticket.crew_takeoff).toEqual(ct);

    expect(mockDetect).toHaveBeenCalledTimes(1);
    const opts = mockDetect.mock.calls[0][0];
    expect(opts.att).toMatchObject({ id: 'a_j2_c', filename: 'pull sheet.csv', original_key: 'orig/a_j2_c', size_bytes: 1200 });
    expect((await opts.getBuffer('orig/a_j2_c')).toString()).toBe('bytes of orig/a_j2_c');
    expect(mockGetBuffer).toHaveBeenCalledWith('orig/a_j2_c');

    // The office read carries it back.
    expect((await readTicket(ticketRouter, WIDE, 'st_j2')).body.ticket.crew_takeoff).toEqual(ct);
  });

  test('a priced spreadsheet is stored has_prices true — the share side withholds it from default links', async () => {
    mockDetect.mockImplementation(async () => true);
    const r = await choose(ticketRouter, WIDE, 'st_j2', 'a_j2_x');
    expect(r.statusCode).toBe(200);
    expect(stored('st_j2')).toMatchObject({ attachment_id: 'a_j2_x', kind: 'xlsx', has_prices: true });
  });

  test('a PDF cannot be checked: has_prices null, stored', async () => {
    mockDetect.mockImplementation(async () => null);
    const r = await choose(ticketRouter, WIDE, 'st_j2', 'a_j2_p');
    expect(r.statusCode).toBe(200);
    expect(stored('st_j2')).toMatchObject({ attachment_id: 'a_j2_p', kind: 'pdf', has_prices: null });
  });

  test('an old binary .xls is shown as it is, and null too', async () => {
    mockDetect.mockImplementation(async () => null);
    expect((await choose(ticketRouter, WIDE, 'st_j2', 'a_j2_old')).statusCode).toBe(200);
    expect(stored('st_j2')).toMatchObject({ kind: 'xls', has_prices: null });
  });

  test('a SPREADSHEET the check could not read is refused, not stored as "cannot be checked"', async () => {
    mockDetect.mockImplementation(async () => null);
    const before = eng.log.length;
    const r = await choose(ticketRouter, WIDE, 'st_j2', 'a_j2_x');
    expect(r.statusCode).toBe(422);
    expect(r.body.error).toMatch(/could not be checked for prices/);
    expect(writesSince(before)).toEqual([]);
    expect(stored('st_j2')).toBeNull();
  });

  test('a file that is not a takeoff type is 422, and the check never runs', async () => {
    const r = await choose(ticketRouter, WIDE, 'st_j2', 'a_j2_doc');
    expect(answer(r)).toEqual([422, { error: 'That file type cannot be shown on the crew link.' }]);
    expect(mockDetect).not.toHaveBeenCalled();
    expect(stored('st_j2')).toBeNull();
  });

  test('null clears it, and a later read shows nothing', async () => {
    await choose(ticketRouter, WIDE, 'st_j2', 'a_j2_c');
    expect(stored('st_j2')).not.toBeNull();
    const r = await choose(ticketRouter, WIDE, 'st_j2', null);
    expect(r.statusCode).toBe(200);
    expect(r.body.crew_takeoff).toBeNull();
    expect(r.body.ticket.crew_takeoff).toBeNull();
    expect(stored('st_j2')).toBeNull();
    expect(mockDetect).toHaveBeenCalledTimes(1);
  });

  test('the event names the FIELD, never the file', async () => {
    mockDetect.mockImplementation(async () => null);
    const before = eng.log.length;
    await choose(ticketRouter, WIDE, 'st_j2', 'a_j2_p');
    await choose(ticketRouter, WIDE, 'st_j2', null);
    const events = eng.all("SELECT kind, actor_user_id, detail FROM service_ticket_events WHERE ticket_id = 'st_j2'");
    expect(events.map((e) => [e.kind, e.actor_user_id, e.detail])).toEqual([
      ['field_changed', WIDE, { fields: ['crew_takeoff'] }],
      ['field_changed', WIDE, { fields: ['crew_takeoff'] }],
    ]);
    const eventWrites = writesSince(before).filter((e) => /service_ticket_events/.test(e.sql));
    expect(JSON.stringify(eventWrites)).not.toMatch(/48k|Smith|\.pdf|a_j2_p/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * WHO
 * ══════════════════════════════════════════════════════════════════════════*/
describe('who may choose: write access on the ticket', () => {
  test('the narrow tier on its EDIT-granted job may', async () => {
    const r = await choose(ticketRouter, CREW, 'st_j2', 'a_j2_c');
    expect(r.statusCode).toBe(200);
    expect(stored('st_j2')).toMatchObject({ attachment_id: 'a_j2_c', set_by: CREW });
  });

  test('a VIEW grant is the missing-ticket 404, and nothing is checked or written', async () => {
    const before = eng.log.length;
    expect(answer(await choose(ticketRouter, CREW, 'st_j1', 'a_j1_c'))).toEqual(TICKET_404);
    expect(answer(await choose(ticketRouter, CREW, 'st_nope', 'a_j1_c'))).toEqual(TICKET_404);
    expect(answer(await choose(ticketRouter, CREW, 'st_j1', null))).toEqual(TICKET_404);
    expect(writesSince(before)).toEqual([]);
    expect(mockDetect).not.toHaveBeenCalled();
  });

  test('no job capability is the 403 naming it', async () => {
    expect(answer(await choose(ticketRouter, NOBODY, 'st_j2', 'a_j2_c'))).toEqual(NO_WRITE_CAP);
    expect(stored('st_j2')).toBeNull();
  });

  test('another tenant\'s ticket is the missing-ticket 404, from either side', async () => {
    expect(answer(await choose(ticketRouter, WIDE, 'st_b', 'a_j9'))).toEqual(TICKET_404);
    expect(answer(await choose(ticketRouter, RIVAL, 'st_j2', 'a_j2_c'))).toEqual(TICKET_404);
    expect(stored('st_j2')).toBeNull();
    expect(stored('st_b')).toBeNull();
  });

  test('a closed ticket is 409 — for a choice and for a clear', async () => {
    for (const id of ['a_j2_c', null]) {
      const r = await choose(ticketRouter, WIDE, 'st_closed', id);
      expect(r.statusCode).toBe(409);
      expect(r.body.error).toMatch(/closed\. Reopen it/);
    }
    expect(mockDetect).not.toHaveBeenCalled();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * WHICH FILES
 * ══════════════════════════════════════════════════════════════════════════*/
describe('which files: the ticket\'s own job, lead and estimate — one 404 for every miss', () => {
  test('absent, another job\'s, another tenant\'s and malformed ids answer the identical 404 and write nothing', async () => {
    const before = eng.log.length;
    const absent = await choose(ticketRouter, WIDE, 'st_j2', 'att_does_not_exist');
    expect(answer(absent)).toEqual(FILE_404);
    for (const id of ['a_j1_c', 'a_j9', '../../etc/passwd', 'x'.repeat(129), 123, ['a_j2_c'], { id: 'a_j2_c' }, undefined, '']) {
      const r = await put(ticketRouter, WIDE, 'st_j2', id === undefined ? {} : { attachment_id: id });
      expect({ id, a: answer(r) }).toEqual({ id, a: answer(absent) });
    }
    expect(writesSince(before)).toEqual([]);
    expect(mockDetect).not.toHaveBeenCalled();
  });

  test('the lead\'s file needs LEADS_VIEW and the estimate\'s ESTIMATES_VIEW — the same gates as the picker', async () => {
    expect(answer(await choose(ticketRouter, CREW, 'st_j2', 'a_l1'))).toEqual(FILE_404);
    expect(answer(await choose(ticketRouter, CREW, 'st_j2', 'a_e1'))).toEqual(FILE_404);
    expect(answer(await choose(ticketRouter, JOBS, 'st_j2', 'a_e1'))).toEqual(FILE_404);
    expect(mockDetect).not.toHaveBeenCalled();
    expect((await choose(ticketRouter, JOBS, 'st_j2', 'a_l1')).statusCode).toBe(200);
    mockDetect.mockImplementation(async () => null);
    expect((await choose(ticketRouter, WIDE, 'st_j2', 'a_e1')).statusCode).toBe(200);
    expect(stored('st_j2')).toMatchObject({ attachment_id: 'a_e1', kind: 'pdf', has_prices: null });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * ONE READ PER USER — the price check pulls the file out of storage and parses
 * it, so it shares the extract door's one-read-per-user slot, taken before
 * the fetch and given back as soon as the check answers.
 * ══════════════════════════════════════════════════════════════════════════*/
const BUSY = [429, { error: 'Still reading your last file — try again in a moment.' }];

function gate() {
  let open;
  const shut = new Promise((resolve) => { open = resolve; });
  return { shut, open };
}

async function until(cond) {
  for (let i = 0; i < 5000 && !cond(); i++) await new Promise((r) => setImmediate(r));
  if (!cond()) throw new Error('the first request never reached the price check');
}

describe('one file read per user at a time', () => {
  test('a second choice by the same user while a check is in flight is a 429, and nothing is written', async () => {
    const g = gate();
    let calls = 0;
    mockDetect.mockImplementation(async () => { calls += 1; if (calls === 1) await g.shut; return false; });
    const first = choose(ticketRouter, WIDE, 'st_j2', 'a_j2_c');
    await until(() => mockDetect.mock.calls.length === 1);

    const before = eng.log.length;
    expect(answer(await choose(ticketRouter, WIDE, 'st_j2', 'a_j2_x'))).toEqual(BUSY);
    // The extract door is the same slot.
    expect(answer(await drive(ticketRouter, 'post', '/:id/materials/extract',
      { as: WIDE, params: { id: 'st_j2' }, body: { attachment_id: 'a_j2_x' } }))).toEqual(BUSY);
    expect(writesSince(before)).toEqual([]);
    expect(mockDetect).toHaveBeenCalledTimes(1);
    expect(mockGetBuffer).not.toHaveBeenCalled();

    // Clearing the choice reads no file, so it takes no slot.
    expect((await choose(ticketRouter, WIDE, 'st_j2', null)).statusCode).toBe(200);
    // Another user is not held up.
    expect((await choose(ticketRouter, CREW, 'st_j2', 'a_j2_c')).statusCode).toBe(200);

    g.open();
    expect((await first).statusCode).toBe(200);
    expect((await choose(ticketRouter, WIDE, 'st_j2', 'a_j2_x')).statusCode).toBe(200);
    expect(stored('st_j2')).toMatchObject({ attachment_id: 'a_j2_x' });
  });

  test('a check that throws still gives the slot back', async () => {
    mockDetect.mockImplementationOnce(async () => { throw new Error('storage fell over'); });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await choose(ticketRouter, WIDE, 'st_j2', 'a_j2_c')).statusCode).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect((await choose(ticketRouter, WIDE, 'st_j2', 'a_j2_c')).statusCode).toBe(200);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * GUARDS, REMOVED
 * ══════════════════════════════════════════════════════════════════════════*/
describe('mutants', () => {
  test('the harness refuses an absent anchor', () => {
    expect(() => mutant(TICKET_ROUTES, [['this string is nowhere in the routes', 'x']])).toThrow(/ANCHOR NOT FOUND/);
  });

  test('ask the door for READ access and a view grant puts a file on the crew link', async () => {
    const HEAD = "router.put('/:id/crew-takeoff', requireAuth, requireOrgId, async (req, res) => {\n"
      + '  try {\n'
      + '    const orgId = req.orgId;\n'
      + '    const ticket = await loadOwnedTicket(req.params.id, orgId);\n'
      + '    if (!ticket) return res.status(404).json({ error: TICKET_NOT_FOUND });\n';
    const mut = mutant(TICKET_ROUTES, [[
      HEAD + "    if (!(await ticketAccessOk(req, res, ticket, 'write', orgId))) return;",
      HEAD + "    if (!(await ticketAccessOk(req, res, ticket, 'read', orgId))) return;",
    ]]);
    expect((await choose(mut, CREW, 'st_j1', 'a_j1_c')).statusCode).toBe(200);
    expect(stored('st_j1')).toMatchObject({ attachment_id: 'a_j1_c' });
  });

  test('never give the read slot back and the user\'s next choice is refused as busy', async () => {
    const mut = mutant(TICKET_ROUTES, [[
      '        hasPrices = await detectFilePrices({ att, getBuffer: (key) => storage.getBuffer(key) });\n'
        + '      } finally {\n'
        + '        release();\n'
        + '      }',
      '        hasPrices = await detectFilePrices({ att, getBuffer: (key) => storage.getBuffer(key) });\n'
        + '      } finally {\n'
        + '      }',
    ]]);
    expect((await choose(mut, WIDE, 'st_j2', 'a_j2_c')).statusCode).toBe(200);
    expect(answer(await choose(mut, WIDE, 'st_j2', 'a_j2_c'))).toEqual(BUSY);
    expect(mockDetect).toHaveBeenCalledTimes(1);
  });

  test('refuse nothing on an unreadable spreadsheet and a priced xlsx lands on every link as "cannot be checked"', async () => {
    mockDetect.mockImplementation(async () => null);
    const mut = mutant(TICKET_ROUTES, [[
      "      if (hasPrices === null && (kind === 'xlsx' || kind === 'csv')) {",
      '      if (false) {',
    ]]);
    expect((await choose(mut, WIDE, 'st_j2', 'a_j2_x')).statusCode).toBe(200);
    expect(stored('st_j2')).toMatchObject({ kind: 'xlsx', has_prices: null });
  });
});
