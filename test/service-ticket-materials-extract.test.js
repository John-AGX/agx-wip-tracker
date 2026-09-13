// "FILL FROM A JOB FILE" — WHICH FILES A WORK ORDER MAY READ A TAKEOFF FROM.
//
// ── WHAT THIS FILE PINS ───────────────────────────────────────────────────
// Two doors on server/routes/service-ticket-routes.js:
//
//   GET  /:id/materials/sources   the files the picker may offer
//   POST /:id/materials/extract   read material lines out of one of them
//
// Neither writes. What they guard is READ reach: a work order is the one
// surface the narrow tier (a crew lead with an edit grant on one job) shares
// with the office, and a takeoff can hang on the sales LEAD or the priced
// ESTIMATE as well as on the job. So:
//
//   1. WRITE access on the ticket, even for the GET — the list only exists to
//      fill an editor a viewer cannot save.
//   2. The files come from the ticket's OWN parents only: its job, its lead
//      (LEADS_VIEW, or the ticket is a lead ticket) and its estimate
//      (ESTIMATES_VIEW), each proved in this org.
//   3. The extract door puts those parent pairs in the WHERE of its attachment
//      read, then runs attachmentInOrg. Absent, foreign, another job's, and
//      capability-filtered ids all answer ONE identical 404.
//   4. The extractor is never reached on any refusal, and a rate limiter that
//      answered inside beforeAi is not answered over.
//
// ── HOW ───────────────────────────────────────────────────────────────────
// Same harness as test/service-ticket-route-access.test.js: the REAL handlers,
// real requireAuth over a signed JWT, real requireOrgId, the role cache loaded
// from a `roles` table, node:sqlite through the pg shim. Only the extractor,
// the storage backend and the rate limiters are mocked — the extractor's own
// rules are pinned in its own suite, and here only WHETHER and WITH WHAT the
// route calls it is under test.
//
// Then each guard is removed from a copy of the shipped file and the identical
// drive is shown to produce the wrong outcome. The copies go to the OS temp
// dir, never into server/, and every anchor is normalised to the file's own
// line ending (the route file is CRLF on disk).
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

// ── the mocks ─────────────────────────────────────────────────────────────
// The extractor is mocked (its own rules are pinned in materials-extract.test.js);
// what is under test here is the DOORS in front of it. The mock is keyed with
// `virtual: true` on the extension-less path, which is why mutant() below
// rewrites this one require to that path. A virtual mock would also pass if the
// real module vanished, so the first test below requires the real one.
const mockExtract = jest.fn();
jest.mock('../server/services/materials-extract', () => ({
  extractMaterials: (...args) => mockExtract(...args),
}), { virtual: true });

const mockGetBuffer = jest.fn(async (key) => Buffer.from('bytes of ' + key));
jest.mock('../server/storage', () => ({
  storage: { getBuffer: (...args) => mockGetBuffer(...args) },
}));

// Every limiter server/rate-limit.js exports, pass-through, so a router that
// destructures one at load time never gets undefined. The two AI limiters can
// be told to answer 429 themselves, the way express-rate-limit does.
const mockLimiter = { ai: false, hourly: false, calls: [] };
jest.mock('../server/rate-limit', () => {
  const pass = (req, res, next) => next();
  const answering = (name) => (req, res, next) => {
    mockLimiter.calls.push(name);
    if (mockLimiter[name]) {
      res.status(429).json({ error: 'Too many requests — please wait a moment and try again.' });
      return;
    }
    next();
  };
  return {
    stShareIpLimiter: pass, stShareViewLimiter: pass, stShareWriteLimiter: pass, stSharePropose: pass,
    ipLoginLimiter: pass, ipGenericLimiter: pass,
    aiChatLimiter: answering('ai'), aiChatHourlyLimiter: answering('hourly'),
    ingestLimiter: pass, liveJoinLimiter: pass, liveStreamLimiter: pass, liveViewLimiter: pass,
    liveRoomViewLimiter: pass, liveMirrorLimiter: pass, liveSnapLimiter: pass, liveRoomSnapLimiter: pass,
    reportShareIpLimiter: pass, reportShareViewLimiter: pass, reportShareCommentLimiter: pass,
  };
});

const EXTRACTOR_VIRTUAL_PATH = path.resolve(__dirname, '..', 'server', 'services', 'materials-extract');
const TICKET_ROUTES = path.join(__dirname, '..', 'server', 'routes', 'service-ticket-routes.js');

const TABLES = [
  'organizations', 'users', 'roles', 'jobs', 'job_access', 'leads', 'estimates', 'tasks',
  'service_tickets', 'service_ticket_events', 'attachments',
];

// Role names are deliberately not 'admin', so no adminish short-circuit can
// stand in for the capability under test.
const WIDE = 10;      // jobs wide + LEADS_VIEW + ESTIMATES_VIEW
const JOBS = 15;      // jobs wide + LEADS_VIEW, NO ESTIMATES_VIEW
const CREW = 20;      // the narrow tier only
const LEADEDIT = 30;  // LEADS_EDIT only — no LEADS_VIEW
const NOBODY = 40;    // ESTIMATES_VIEW, nothing that reaches a ticket
const RIVAL = 50;     // wide, in ANOTHER organization

const USERS = {
  [WIDE]: { role: 'mx_wide', org: 1 },
  [JOBS]: { role: 'mx_jobs', org: 1 },
  [CREW]: { role: 'mx_crew', org: 1 },
  [LEADEDIT]: { role: 'mx_leadedit', org: 1 },
  [NOBODY]: { role: 'mx_none', org: 1 },
  [RIVAL]: { role: 'mx_wide', org: 2 },
};

let eng;
let auth;
let ticketRouter;

function seed() {
  const caps = (list) => "'" + JSON.stringify(list) + "'";
  eng.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM roles; DELETE FROM jobs;
    DELETE FROM job_access; DELETE FROM leads; DELETE FROM estimates; DELETE FROM tasks;
    DELETE FROM service_tickets; DELETE FROM service_ticket_events; DELETE FROM attachments;

    INSERT INTO organizations (id, name) VALUES (1, 'AGX'), (2, 'Rival Co');
    INSERT INTO roles (name, capabilities) VALUES
      ('mx_wide',     ${caps(['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'LEADS_VIEW', 'LEADS_EDIT', 'ESTIMATES_VIEW'])}),
      ('mx_jobs',     ${caps(['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'LEADS_VIEW'])}),
      ('mx_crew',     ${caps(['JOBS_VIEW_ASSIGNED', 'JOBS_EDIT_OWN'])}),
      ('mx_leadedit', ${caps(['LEADS_EDIT'])}),
      ('mx_none',     ${caps(['ESTIMATES_VIEW'])});
    INSERT INTO users (id, name, email, role, organization_id) VALUES
      (10, 'Wendy Wide', 'w@agx.test', 'mx_wide', 1),
      (15, 'Jo Jobs', 'j@agx.test', 'mx_jobs', 1),
      (20, 'Carl Crew', 'c@agx.test', 'mx_crew', 1),
      (30, 'Lee Leadedit', 'l@agx.test', 'mx_leadedit', 1),
      (40, 'Nora None', 'n@agx.test', 'mx_none', 1),
      (50, 'Rival Ray', 'r@rival.test', 'mx_wide', 2);

    -- j1: CREW holds a VIEW grant.  j2: CREW holds an EDIT grant, and j2 was
    -- converted from lead l1 and sold from estimate e1.  j3: CREW owns it.
    -- j4 names ANOTHER tenant's lead and estimate — which no real door writes,
    -- and which is exactly why each parent is proved rather than trusted.
    INSERT INTO leads (id, title, organization_id) VALUES
      ('l1', 'Maple St reroof', 1), ('l9', 'Rival lead', 2);
    INSERT INTO estimates (id, owner_id, data, organization_id) VALUES
      ('e1', 10, '{}', 1), ('e9', 50, '{}', 2);
    INSERT INTO jobs (id, owner_id, data, organization_id, lead_id, estimate_id) VALUES
      ('j1', 10, '{}', 1, NULL, NULL),
      ('j2', 10, '{}', 1, 'l1', 'e1'),
      ('j3', 20, '{}', 1, NULL, NULL),
      ('j4', 10, '{}', 1, 'l9', 'e9'),
      ('j9', 50, '{}', 2, 'l9', 'e9');
    INSERT INTO job_access (job_id, user_id, access_level) VALUES
      ('j1', 20, 'view'), ('j2', 20, 'edit');

    INSERT INTO service_tickets (id, organization_id, title, job_id, lead_id, status, checklist, created_at) VALUES
      ('st_j1',     1, 'Gate on j1',  'j1', NULL, 'open',   '[]', '2026-09-01 10:00:01'),
      ('st_j2',     1, 'Gate on j2',  'j2', NULL, 'open',   '[]', '2026-09-01 10:00:02'),
      ('st_j3',     1, 'Gate on j3',  'j3', NULL, 'open',   '[]', '2026-09-01 10:00:03'),
      ('st_j4',     1, 'Gate on j4',  'j4', NULL, 'open',   '[]', '2026-09-01 10:00:04'),
      ('st_l1',     1, 'Lead gate',   NULL, 'l1', 'open',   '[]', '2026-09-01 10:00:05'),
      ('st_closed', 1, 'Closed gate', 'j2', NULL, 'closed', '[]', '2026-09-01 10:00:06'),
      ('st_b',      2, 'RIVAL gate',  'j9', NULL, 'open',   '[]', '2026-09-01 10:00:07');

    -- a_j2_x carries every field the picker must NOT hand out: a storage key,
    -- a CDN url and extracted text with a price in it.
    INSERT INTO attachments (id, entity_type, entity_id, filename, mime_type, size_bytes, folder, uploaded_at,
                             organization_id, uploaded_by, original_key, web_key, original_url, web_url, extracted_text) VALUES
      ('a_j2_p',    'job', 'j2', 'Field takeoff.pdf',  'application/pdf',          4096, 'Takeoffs', '2026-09-11 10:00:00', 1, 10, 'orig/a_j2_p', NULL, NULL, NULL, NULL),
      ('a_j2_x',    'job', 'j2', 'Lead Report.xlsx',   'application/zip',         20480, 'Takeoffs', '2026-09-10 10:00:00', 1, 10, 'orig/a_j2_x', NULL, 'https://cdn.test/SECRET-URL', NULL, 'SECRET-EXTRACT plywood $4,200'),
      ('a_j2_old',  'job', 'j2', 'old takeoff.xls',    'application/vnd.ms-excel', 9000, NULL,       '2026-09-09 10:00:00', 1, 10, 'orig/a_j2_old', NULL, NULL, NULL, NULL),
      ('a_j2_h',    'job', 'j2', 'IMG_0042.HEIC',      'image/heic',              80000, 'Photos',   '2026-09-08 10:00:00', 1, 10, 'orig/a_j2_h', 'web/a_j2_h', NULL, 'https://cdn.test/SECRET-WEB', NULL),
      ('a_j2_doc',  'job', 'j2', 'contract.docx',      'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 5000, NULL, '2026-09-07 10:00:00', 1, 10, 'orig/a_j2_doc', NULL, NULL, NULL, NULL),
      ('a_j2_scan', 'job', 'j2', 'scan',               'image/jpeg',              70000, NULL,       '2026-09-06 10:00:00', 1, 10, 'orig/a_j2_scan', 'web/a_j2_scan', NULL, NULL, NULL),
      ('a_j1_c',    'job', 'j1', 'hd-purchases.csv',   'application/vnd.ms-excel', 1200, NULL,       '2026-09-10 10:00:00', 1, 10, 'orig/a_j1_c', NULL, NULL, NULL, NULL),
      ('a_j3_c',    'job', 'j3', 'owner.csv',          'text/csv',                 1200, NULL,       '2026-09-10 10:00:00', 1, 20, 'orig/a_j3_c', NULL, NULL, NULL, NULL),
      ('a_j4_c',    'job', 'j4', 'j4.csv',             'text/csv',                 1200, NULL,       '2026-09-10 10:00:00', 1, 10, 'orig/a_j4_c', NULL, NULL, NULL, NULL),
      ('a_j9',      'job', 'j9', 'rival.xlsx',         'application/zip',          1200, NULL,       '2026-09-10 10:00:00', 2, 50, 'orig/a_j9', NULL, NULL, NULL, NULL),
      ('a_l1',      'lead', 'l1', 'lead-takeoff.xlsx', 'application/zip',          3000, NULL,       '2026-09-05 10:00:00', 1, 10, 'orig/a_l1', NULL, NULL, NULL, NULL),
      ('a_l9',      'lead', 'l9', 'rival-lead.xlsx',   'application/zip',          3000, NULL,       '2026-09-05 10:00:00', 2, 50, 'orig/a_l9', NULL, NULL, NULL, NULL),
      ('a_e1',      'estimate', 'e1', 'T5 pull sheet.pdf',  'application/pdf',     3000, NULL,       '2026-09-04 10:00:00', 1, 10, 'orig/a_e1', NULL, NULL, NULL, NULL),
      ('a_e9',      'estimate', 'e9', 'rival-estimate.pdf', 'application/pdf',     3000, NULL,       '2026-09-04 10:00:00', 2, 50, 'orig/a_e9', NULL, NULL, NULL, NULL);
  `);
}

beforeAll(async () => {
  eng = createPgSqlite(sqliteSchema(TABLES), {
    jsonColumns: ['checklist', 'capabilities', 'detail', 'data'],
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

// A canned extractor result. The route hands it back untouched on success.
function canned(att) {
  return {
    ok: true,
    materials: [{ description: '1/2" CDX plywood', qty: '12', unit: 'sheet' }],
    method: 'sheet',
    source: { attachment_id: att.id, filename: att.filename, sheet: 'Lead Report' },
    counts: { found: 3, kept: 1, skipped: { labor: 1, zero_qty: 1, totals: 0, sections: 0, no_description: 0 }, over_cap: 0 },
    truncated: false,
    warnings: [],
  };
}

beforeEach(() => {
  seed();
  mockExtract.mockReset();
  mockExtract.mockImplementation(async (opts) => canned(opts.att));
  mockGetBuffer.mockClear();
  mockLimiter.ai = false;
  mockLimiter.hourly = false;
  mockLimiter.calls = [];
});

// ── the drive ─────────────────────────────────────────────────────────────
// res.json THROWS on a second write, so "no double send" is enforced by the
// fake rather than hoped for, the way express would throw ERR_HTTP_HEADERS_SENT.
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

const sources = (router, as, id) => drive(router, 'get', '/:id/materials/sources', { as, params: { id } });
const extract = (router, as, id, attachmentId) => drive(router, 'post', '/:id/materials/extract',
  { as, params: { id }, body: attachmentId === undefined ? {} : { attachment_id: attachmentId } });

const answer = (r) => [r.statusCode, r.body];

test('the real extractor exists and exports extractMaterials (the virtual mock must not hide its absence)', () => {
  const real = jest.requireActual('../server/services/materials-extract.js');
  expect(typeof real.extractMaterials).toBe('function');
});
const ids = (r) => (r.body && r.body.files ? r.body.files.map((f) => f.id).sort() : r.body);
const TICKET_404 = [404, { error: 'Service ticket not found' }];
const FILE_404 = [404, { error: 'File not found' }];
const NO_WRITE_CAP = [403, { error: 'Missing capability: JOBS_EDIT_ANY JOBS_EDIT_OWN' }];

// ── mutant(): remove ONE guard from a copy of the shipped file ─────────────
function absolutizeRequires(src, fromDir) {
  return src.replace(/require\((['"])([^'"]+)\1\)/g, (_m, _q, spec) => {
    // The extractor: point at the path the virtual mock is keyed on.
    if (spec === '../services/materials-extract') {
      return 'require(' + JSON.stringify(EXTRACTOR_VIRTUAL_PATH) + ')';
    }
    const resolved = spec.charAt(0) === '.'
      ? require.resolve(path.resolve(fromDir, spec))
      : require.resolve(spec, { paths: [fromDir] });
    return 'require(' + JSON.stringify(resolved.split(path.sep).join('/')) + ')';
  });
}

function mutant(file, pairs) {
  const SOURCE = fs.readFileSync(file, 'utf8');
  const eol = SOURCE.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
  let out = SOURCE;
  for (const [find, replace] of pairs) {
    const f = String(find).replace(/\r?\n/g, eol);
    const r = String(replace).replace(/\r?\n/g, eol);
    const hits = out.split(f).length - 1;
    if (hits === 0) {
      throw new Error('MUTATION ANCHOR NOT FOUND — the guard moved or the line endings differ. Anchor:\n'
        + JSON.stringify(f.slice(0, 200)));
    }
    if (hits > 1) {
      throw new Error('MUTATION ANCHOR IS AMBIGUOUS (' + hits + ' matches). Anchor:\n' + JSON.stringify(f.slice(0, 200)));
    }
    const next = out.split(f).join(r);
    if (next === out) throw new Error('MUTATION CHANGED NO BYTES: ' + JSON.stringify(f.slice(0, 80)));
    out = next;
  }
  const p = path.join(os.tmpdir(), '_p86_mx_mutant_' + process.pid + '_'
    + Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, absolutizeRequires(out, path.dirname(file)), 'utf8');
  mutantPaths.push(p);
  return require(p);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * THE HAPPY PATH — what a PM with the office's capabilities gets
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a wide caller: every takeoff on the job, its lead and its estimate', () => {
  test('sources lists job, lead and estimate files with a kind, and drops what cannot be read', async () => {
    const r = await sources(ticketRouter, WIDE, 'st_j2');
    expect(r.statusCode).toBe(200);
    const byId = Object.fromEntries(r.body.files.map((f) => [f.id, [f.kind, f.where]]));
    expect(byId).toEqual({
      a_j2_p: ['pdf', 'job'],
      a_j2_x: ['xlsx', 'job'],       // stored as application/zip: the extension decides
      a_j2_old: ['xls', 'job'],      // offered, so the picker can say "save as .xlsx"
      a_j2_h: ['image', 'job'],
      a_j2_scan: ['image', 'job'],   // no extension: the mime decides
      a_l1: ['xlsx', 'lead'],
      a_e1: ['pdf', 'estimate'],
    });
    // Job files newest first, then the lead's, then the estimate's.
    expect(r.body.files.map((f) => f.id)).toEqual(['a_j2_p', 'a_j2_x', 'a_j2_old', 'a_j2_h', 'a_j2_scan', 'a_l1', 'a_e1']);
    const x = r.body.files.find((f) => f.id === 'a_j2_x');
    expect([x.filename, x.size_bytes, x.folder]).toEqual(['Lead Report.xlsx', 20480, 'Takeoffs']);
  });

  test('sources hands out a name, never the bytes: no extracted text, no storage key, no url', async () => {
    const r = await sources(ticketRouter, WIDE, 'st_j2');
    for (const f of r.body.files) {
      expect(Object.keys(f).sort()).toEqual(['filename', 'folder', 'id', 'kind', 'size_bytes', 'uploaded_at', 'where']);
    }
    const text = JSON.stringify(r.body);
    expect(text).not.toMatch(/SECRET|orig\/|web\/|extracted_text|_key|_url|4,200/);
  });

  test('extract hands the proved row and a storage reader to the extractor, and returns its result', async () => {
    const r = await extract(ticketRouter, WIDE, 'st_j2', 'a_j2_x');
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual(canned({ id: 'a_j2_x', filename: 'Lead Report.xlsx' }));
    expect(mockExtract).toHaveBeenCalledTimes(1);
    const opts = mockExtract.mock.calls[0][0];
    expect(opts.orgId).toBe(1);
    expect(opts.att).toMatchObject({
      id: 'a_j2_x', filename: 'Lead Report.xlsx', mime_type: 'application/zip',
      size_bytes: 20480, original_key: 'orig/a_j2_x', web_key: null,
    });
    expect(typeof opts.beforeAi).toBe('function');
    // getBuffer goes to the storage backend, keyed on whatever the extractor asks.
    const buf = await opts.getBuffer('orig/a_j2_x');
    expect(buf.toString()).toBe('bytes of orig/a_j2_x');
    expect(mockGetBuffer).toHaveBeenCalledWith('orig/a_j2_x');
  });

  test('a lead file and an estimate file on the same ticket are read too', async () => {
    expect((await extract(ticketRouter, WIDE, 'st_j2', 'a_l1')).statusCode).toBe(200);
    expect((await extract(ticketRouter, WIDE, 'st_j2', 'a_e1')).statusCode).toBe(200);
    expect(mockExtract.mock.calls.map((c) => c[0].att.id)).toEqual(['a_l1', 'a_e1']);
  });

  test('neither door writes a row — the Materials PATCH stays the only write', async () => {
    const before = eng.log.length;
    await sources(ticketRouter, WIDE, 'st_j2');
    await extract(ticketRouter, WIDE, 'st_j2', 'a_j2_x');
    const writes = eng.log.slice(before).filter((e) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(e.sql));
    expect(writes).toEqual([]);
    expect(eng.all("SELECT materials FROM service_tickets WHERE id = 'st_j2'")[0].materials).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * WHO — write access on the ticket, the narrow tier, no capability
 * ══════════════════════════════════════════════════════════════════════════*/
describe('who may use the doors: write access on the ticket', () => {
  test('the narrow tier on its EDIT-granted job and on its OWN job: 200, job files only', async () => {
    const granted = await sources(ticketRouter, CREW, 'st_j2');
    expect(granted.statusCode).toBe(200);
    expect(ids(granted)).toEqual(['a_j2_h', 'a_j2_old', 'a_j2_p', 'a_j2_scan', 'a_j2_x']);
    expect((await extract(ticketRouter, CREW, 'st_j2', 'a_j2_x')).statusCode).toBe(200);

    const owned = await sources(ticketRouter, CREW, 'st_j3');
    expect(ids(owned)).toEqual(['a_j3_c']);
    expect((await extract(ticketRouter, CREW, 'st_j3', 'a_j3_c')).statusCode).toBe(200);
  });

  test('a VIEW grant gets the missing-ticket 404 on both doors, and the extractor is not reached', async () => {
    const absent = await sources(ticketRouter, CREW, 'st_nope');
    expect(answer(absent)).toEqual(TICKET_404);
    expect(answer(await sources(ticketRouter, CREW, 'st_j1'))).toEqual(TICKET_404);
    expect(answer(await extract(ticketRouter, CREW, 'st_j1', 'a_j1_c'))).toEqual(TICKET_404);
    // Not on the job at all: indistinguishable.
    expect(answer(await sources(ticketRouter, CREW, 'st_j4'))).toEqual(TICKET_404);
    expect(answer(await extract(ticketRouter, CREW, 'st_j4', 'a_j4_c'))).toEqual(TICKET_404);
    expect(mockExtract).not.toHaveBeenCalled();
  });

  test('no job capability is the 403 naming it', async () => {
    expect(answer(await sources(ticketRouter, NOBODY, 'st_j2'))).toEqual(NO_WRITE_CAP);
    expect(answer(await extract(ticketRouter, NOBODY, 'st_j2', 'a_j2_x'))).toEqual(NO_WRITE_CAP);
    expect(mockExtract).not.toHaveBeenCalled();
  });

  test('another tenant\'s ticket is the missing-ticket 404', async () => {
    expect(answer(await sources(ticketRouter, WIDE, 'st_b'))).toEqual(TICKET_404);
    expect(answer(await extract(ticketRouter, WIDE, 'st_b', 'a_j9'))).toEqual(TICKET_404);
    expect(answer(await extract(ticketRouter, RIVAL, 'st_j2', 'a_j2_x'))).toEqual(TICKET_404);
    expect(mockExtract).not.toHaveBeenCalled();
  });

  test('a closed ticket is 409 on both doors, like the Materials PATCH', async () => {
    const s = await sources(ticketRouter, WIDE, 'st_closed');
    const x = await extract(ticketRouter, WIDE, 'st_closed', 'a_j2_x');
    for (const r of [s, x]) {
      expect(r.statusCode).toBe(409);
      expect(r.body.error).toMatch(/closed\. Reopen it/);
    }
    expect(mockExtract).not.toHaveBeenCalled();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * WHICH FILES — the ticket's own parents, each gated, one 404 for every miss
 * ══════════════════════════════════════════════════════════════════════════*/
describe('which files: the ticket\'s own job, lead and estimate — nothing else', () => {
  test('a file on another job, another tenant\'s file and an absent id answer ONE identical 404', async () => {
    const absent = await extract(ticketRouter, WIDE, 'st_j2', 'att_does_not_exist');
    expect(answer(absent)).toEqual(FILE_404);
    for (const id of ['a_j1_c', 'a_j4_c', 'a_j9', 'a_l9', 'a_e9']) {
      const r = await extract(ticketRouter, WIDE, 'st_j2', id);
      expect({ id, a: answer(r) }).toEqual({ id, a: answer(absent) });
    }
    expect(mockExtract).not.toHaveBeenCalled();
  });

  test('another tenant\'s lead and estimate named by a job are never offered, even to a wide caller', async () => {
    const r = await sources(ticketRouter, WIDE, 'st_j4');
    expect(ids(r)).toEqual(['a_j4_c']);
    expect(answer(await extract(ticketRouter, WIDE, 'st_j4', 'a_l9'))).toEqual(FILE_404);
    expect(answer(await extract(ticketRouter, WIDE, 'st_j4', 'a_e9'))).toEqual(FILE_404);
    // The same files ARE offered in their own tenant — so the refusal above is
    // the org proof, not a fixture that has no such rows.
    expect(ids(await sources(ticketRouter, RIVAL, 'st_b'))).toEqual(['a_e9', 'a_j9', 'a_l9']);
    expect(mockExtract).not.toHaveBeenCalled();
  });

  test('the lead\'s files need LEADS_VIEW on a job ticket: absent from sources, 404 on extract', async () => {
    expect(ids(await sources(ticketRouter, CREW, 'st_j2'))).not.toContain('a_l1');
    expect(answer(await extract(ticketRouter, CREW, 'st_j2', 'a_l1'))).toEqual(FILE_404);
    expect(mockExtract).not.toHaveBeenCalled();
  });

  test('the estimate\'s files need ESTIMATES_VIEW: LEADS_VIEW alone reads the lead file but not the estimate\'s', async () => {
    const r = await sources(ticketRouter, JOBS, 'st_j2');
    expect(ids(r)).toContain('a_l1');
    expect(ids(r)).not.toContain('a_e1');
    expect(answer(await extract(ticketRouter, JOBS, 'st_j2', 'a_e1'))).toEqual(FILE_404);
    expect(mockExtract).not.toHaveBeenCalled();
    expect((await extract(ticketRouter, JOBS, 'st_j2', 'a_l1')).statusCode).toBe(200);
  });

  test('a LEAD ticket reads its own lead\'s files on LEADS_EDIT alone — and nothing on any job', async () => {
    const r = await sources(ticketRouter, LEADEDIT, 'st_l1');
    expect(r.statusCode).toBe(200);
    expect(r.body.files.map((f) => [f.id, f.where])).toEqual([['a_l1', 'lead']]);
    expect((await extract(ticketRouter, LEADEDIT, 'st_l1', 'a_l1')).statusCode).toBe(200);
    expect(answer(await extract(ticketRouter, LEADEDIT, 'st_l1', 'a_j2_x'))).toEqual(FILE_404);
    expect(mockExtract).toHaveBeenCalledTimes(1);
  });

  test('an attachment id that is not an id is a 400 before any lookup', async () => {
    const before = eng.log.length;
    for (const bad of [undefined, '', '../../etc/passwd', 'a_j2_x ', 'x'.repeat(129), 123, ['a_j2_x'], { id: 'a_j2_x' }]) {
      const r = await extract(ticketRouter, WIDE, 'st_j2', bad);
      expect({ bad, s: r.statusCode }).toEqual({ bad, s: 400 });
    }
    const attachmentReads = eng.log.slice(before).filter((e) => /FROM attachments/i.test(e.sql));
    expect(attachmentReads).toEqual([]);
    expect(mockExtract).not.toHaveBeenCalled();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE EXTRACTOR'S ANSWERS — failure codes, the limiter, a throw
 * ══════════════════════════════════════════════════════════════════════════*/
describe('what the route does with the extractor\'s answer', () => {
  test('a refusal from the extractor is a 422 carrying its sentence and its code', async () => {
    mockExtract.mockImplementation(async () => ({
      ok: false, code: 'legacy_xls',
      error: 'That is an old .xls file — open it in Excel and save it as .xlsx, then pick it again.',
    }));
    const r = await extract(ticketRouter, WIDE, 'st_j2', 'a_j2_old');
    expect(answer(r)).toEqual([422, {
      error: 'That is an old .xls file — open it in Excel and save it as .xlsx, then pick it again.',
      code: 'legacy_xls',
    }]);
  });

  test('beforeAi runs both AI limiters, in order, only when the extractor asks', async () => {
    const r = await extract(ticketRouter, WIDE, 'st_j2', 'a_j2_x');
    expect(r.statusCode).toBe(200);
    expect(mockLimiter.calls).toEqual([]);   // a sheet read spends no AI budget

    mockExtract.mockImplementation(async (opts) => {
      if (!(await opts.beforeAi())) return { ok: false, code: 'rate_limited', error: 'busy' };
      return canned(opts.att);
    });
    const ai = await extract(ticketRouter, WIDE, 'st_j2', 'a_j2_p');
    expect(ai.statusCode).toBe(200);
    expect(mockLimiter.calls).toEqual(['ai', 'hourly']);
  });

  test('a limiter that answered 429 inside beforeAi is not answered over', async () => {
    mockExtract.mockImplementation(async (opts) => {
      if (!(await opts.beforeAi())) return { ok: false, code: 'rate_limited', error: 'busy' };
      return canned(opts.att);
    });
    mockLimiter.ai = true;
    const perMinute = await extract(ticketRouter, WIDE, 'st_j2', 'a_j2_p');
    expect(perMinute.statusCode).toBe(429);
    expect(perMinute.writes).toBe(1);
    expect(perMinute.body.error).toMatch(/Too many requests/);
    // The per-minute limiter refused, so the hourly one was never consulted.
    expect(mockLimiter.calls).toEqual(['ai']);

    mockLimiter.ai = false;
    mockLimiter.hourly = true;
    mockLimiter.calls = [];
    const hourly = await extract(ticketRouter, WIDE, 'st_j2', 'a_j2_p');
    expect([hourly.statusCode, hourly.writes]).toEqual([429, 1]);
    expect(mockLimiter.calls).toEqual(['ai', 'hourly']);
  });

  test('a throw inside the extractor is a 500 with a plain sentence, never the error text', async () => {
    mockExtract.mockImplementation(async () => { throw new Error('ENOENT orig/a_j2_x internal detail'); });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r = await extract(ticketRouter, WIDE, 'st_j2', 'a_j2_x');
      expect(answer(r)).toEqual([500, { error: 'Could not read materials from that file' }]);
    } finally {
      spy.mockRestore();
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * EVERY GUARD, REMOVED — the identical drive, and the defect it restores
 * ══════════════════════════════════════════════════════════════════════════*/
describe('mutants', () => {
  test('the harness refuses an absent anchor, so a mutant below cannot pass by mutating nothing', () => {
    expect(() => mutant(TICKET_ROUTES, [['this string is nowhere in the routes', 'x']]))
      .toThrow(/MUTATION ANCHOR NOT FOUND/);
  });

  test('ask the two doors for READ access and a view grant browses and reads the job\'s files', async () => {
    const head = (route) => route
      + ' requireAuth, requireOrgId, async (req, res) => {\n'
      + '  try {\n'
      + '    const orgId = req.orgId;\n'
      + '    const ticket = await loadOwnedTicket(req.params.id, orgId);\n'
      + '    if (!ticket) return res.status(404).json({ error: TICKET_NOT_FOUND });\n';
    const WRITE = "    if (!(await ticketAccessOk(req, res, ticket, 'write', orgId))) return;";
    const READ = "    if (!(await ticketAccessOk(req, res, ticket, 'read', orgId))) return;";
    const mut = mutant(TICKET_ROUTES, [
      [head("router.get('/:id/materials/sources',") + WRITE, head("router.get('/:id/materials/sources',") + READ],
      [head("router.post('/:id/materials/extract',") + WRITE, head("router.post('/:id/materials/extract',") + READ],
    ]);
    const s = await sources(mut, CREW, 'st_j1');
    expect(s.statusCode).toBe(200);
    expect(ids(s)).toEqual(['a_j1_c']);
    expect((await extract(mut, CREW, 'st_j1', 'a_j1_c')).statusCode).toBe(200);
    expect(mockExtract).toHaveBeenCalledTimes(1);
  });

  test('drop the parent pairs from the attachment read and any in-org file id is read through any ticket', async () => {
    const mut = mutant(TICKET_ROUTES, [[
      '        WHERE id = $1\n'
        + '          AND ((entity_type = $2 AND entity_id = $3)\n'
        + '            OR (entity_type = $4 AND entity_id = $5)\n'
        + '            OR (entity_type = $6 AND entity_id = $7))`,',
      '        WHERE id = $1\n'
        + '          AND (COALESCE($2, $3, $4, $5, $6, $7) IS NULL OR 1 = 1)`,',
    ]]);
    // Another job's file, through a ticket on j2.
    expect((await extract(mut, WIDE, 'st_j2', 'a_j1_c')).statusCode).toBe(200);
    // The sales lead's file, by a crew lead who holds no lead capability.
    expect((await extract(mut, CREW, 'st_j2', 'a_l1')).statusCode).toBe(200);
    // attachmentInOrg still holds the TENANT line on its own — which is the
    // point of running both: the predicate is what keeps the file on THIS job.
    expect(answer(await extract(mut, WIDE, 'st_j2', 'a_j9'))).toEqual(FILE_404);
    expect(mockExtract.mock.calls.map((c) => c[0].att.id)).toEqual(['a_j1_c', 'a_l1']);
  });

  test('drop the LEADS_VIEW check and a crew lead lists and reads the sales lead\'s files', async () => {
    const mut = mutant(TICKET_ROUTES, [[
      "  if (leadId && (leadOnly || hasCapability(user, 'LEADS_VIEW'))) {",
      '  if (leadId && (leadOnly || true)) {',
    ]]);
    expect(ids(await sources(mut, CREW, 'st_j2'))).toContain('a_l1');
    expect((await extract(mut, CREW, 'st_j2', 'a_l1')).statusCode).toBe(200);
    expect(mockExtract.mock.calls.map((c) => c[0].att.id)).toEqual(['a_l1']);
  });
});
