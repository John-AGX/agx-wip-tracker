// "LET THE CREW LINK SHOW THE TAKEOFF FILE TOO" — THE OFFICE DOOR.
//
// ── WHAT THIS FILE PINS ───────────────────────────────────────────────────
// PUT /api/service-tickets/:id/crew-takeoff { attachment_id } on
// server/routes/service-ticket-routes.js — the one door that decides which
// file, if any, a crew link offers, and makes the PRICE-FREE COPY a link that
// hides financials gets instead of a spreadsheet. The crew side (what a link
// shows, and the bytes behind it) is pinned in
// test/service-ticket-share-takeoff.test.js.
//
//   1. WRITE access on the ticket, the same proof the Materials PATCH asks:
//      a view grant is the missing-ticket 404, no capability the 403 naming
//      it, another tenant's ticket the 404, a closed ticket 409.
//   2. The file comes from loadTicketFile — the ticket's own job, its lead
//      (LEADS_VIEW) and its estimate (ESTIMATES_VIEW). Absent, another job's,
//      another tenant's, capability-filtered and malformed ids all answer ONE
//      identical 404, and nothing is written for any of them.
//   3. A spreadsheet (xlsx, csv) is read by extractMaterials — the extractor
//      that fills the Materials list — and its lines are stored as
//      crew_takeoff.copy, through normalizeMaterials. A read that yields no
//      lines is still stored, with copy null and copy_problem in words. An old
//      .xls is never read: copy null and the one fix. A PDF or photo is never
//      read FOR LINES: copy null, copy_problem null. There is no price check
//      any more, and no has_prices.
//   3b. A NAME IS ONLY A CLAIM (review, 2026-09-14). A PDF or photo by name
//      has its BYTES read (storage.getBuffer, under the same slot) and sniffed
//      (materials-extract sniffKind). Bytes of the kind the name says keep 3.
//      A workbook behind the name is stored as the spreadsheet kind it is and
//      copied like one ('Lead Report.pdf' holding an xlsx is kind xlsx with a
//      copy); an OLE .xls is kind xls with the one fix; anything else is kind
//      'unknown' with copy null and a sentence saying only financial links
//      show it.
//   4. The read runs under the extract door's one-read-per-user slot and its
//      LAZY AI gate: the limiters run only when the extractor asks, and a
//      limiter's 429 stands with nothing stored.
//   5. A file over the crew door's size cap (materials-extract MAX_FILE_BYTES)
//      is refused before any read.
//   6. The event says a field changed — never which file.
//
// ── HOW ───────────────────────────────────────────────────────────────────
// The harness of test/service-ticket-materials-extract.test.js: the REAL
// handlers, real requireAuth over a signed JWT, real requireOrgId, the role
// cache loaded from a `roles` table, node:sqlite through the pg shim. Only the
// extractor, the storage backend and the rate limiters are mocked — the
// extractor's own rules are pinned in test/materials-extract.test.js; here
// only WHETHER and WITH WHAT the route calls it, and what it stores from the
// answer, is under test.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

// ── the mocks ─────────────────────────────────────────────────────────────
// Only extractMaterials is replaced; takeoffKind and MAX_FILE_BYTES stay the
// real rule, because which file types may be shown at all, and how big, is
// part of what this door decides.
const mockExtract = jest.fn();
jest.mock('../server/services/materials-extract', () => Object.assign(
  {}, jest.requireActual('../server/services/materials-extract.js'),
  { extractMaterials: (...args) => mockExtract(...args) }
));
const realExtract = jest.requireActual('../server/services/materials-extract.js');
const MB = 1024 * 1024;

// What storage holds, by key. A file picked as a PDF or photo is proved from
// its bytes now, so those keys hold bytes of the kind their names say; every
// other key answers 'bytes of <key>', which the spreadsheet tests read back.
// The renamed files are the review's: a priced workbook, an OLE .xls, a CSV,
// an HTML page and a PNG, each under a PDF's or a photo's name.
const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj\n<< >>\nendobj\n%%EOF\n');
const JPEG_BYTES = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.from('JFIF photo')]);
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.from('pngbody')]);
const HEIC_BYTES = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(16)]);
const XLSX_BYTES = Buffer.concat([Buffer.from([0x50, 0x4B, 0x03, 0x04]), Buffer.from('xl/workbook.xml Unit Cost $45.00')]);
const XLS_BYTES = Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
const mockBytes = {
  'orig/a_j2_p': PDF_BYTES, 'orig/a_e1': PDF_BYTES, 'orig/a_j2_plans': PDF_BYTES, 'orig/a_j2_img': JPEG_BYTES,
  'orig/a_j2_heic': HEIC_BYTES,
  'orig/a_j2_ren': XLSX_BYTES, 'orig/a_j2_renjpg': XLSX_BYTES, 'orig/a_j2_renxls': XLS_BYTES,
  'orig/a_j2_csvjpg': Buffer.from('Description,Qty,Unit Cost\r\nDrip edge,20,$45.00\r\n'),
  'orig/a_j2_htmlpdf': Buffer.from('<html><body>Unit Cost $45.00</body></html>'),
  'orig/a_j2_pngpdf': PNG_BYTES,
};
const storedBytes = async (key) => (Object.prototype.hasOwnProperty.call(mockBytes, key)
  ? mockBytes[key] : Buffer.from('bytes of ' + key));
const mockGetBuffer = jest.fn(storedBytes);
jest.mock('../server/storage', () => ({
  storage: { getBuffer: (...args) => mockGetBuffer(...args) },
}));

// Every limiter server/rate-limit.js exports, pass-through, so a router that
// destructures one at load time never gets undefined. The two AI limiters
// record that they ran and can be told to answer 429 themselves, the way
// express-rate-limit does.
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
      ('a_j2_img', 'job', 'j2', 'pull sheet photo.jpg',      'image/jpeg',        4096, '2026-09-11 10:00:00', 1, 10, 'orig/a_j2_img'),
      ('a_j2_c',   'job', 'j2', 'pull sheet.csv',            'text/csv',          1200, '2026-09-11 10:00:00', 1, 10, 'orig/a_j2_c'),
      ('a_j2_old', 'job', 'j2', 'Estimate.xls',              'application/vnd.ms-excel', 9000, '2026-09-09 10:00:00', 1, 10, 'orig/a_j2_old'),
      ('a_j2_doc', 'job', 'j2', 'contract.docx',             'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 5000, '2026-09-07 10:00:00', 1, 10, 'orig/a_j2_doc'),
      ('a_j1_c',   'job', 'j1', 'j1.csv',                    'text/csv',          1200, '2026-09-10 10:00:00', 1, 10, 'orig/a_j1_c'),
      ('a_j9',     'job', 'j9', 'rival.xlsx',                'application/zip',   1200, '2026-09-10 10:00:00', 2, 50, 'orig/a_j9'),
      ('a_l1',     'lead', 'l1', 'lead-takeoff.xlsx',        'application/zip',   3000, '2026-09-05 10:00:00', 1, 10, 'orig/a_l1'),
      ('a_e1',     'estimate', 'e1', 'priced estimate.pdf',  'application/pdf',   3000, '2026-09-04 10:00:00', 1, 10, 'orig/a_e1'),
      ('a_j2_plans', 'job', 'j2', 'Plan set.pdf',  'application/pdf',          ${38 * MB}, '2026-09-08 10:00:00', 1, 10, 'orig/a_j2_plans'),
      ('a_j2_heic', 'job', 'j2', 'IMG_0412.heic',            'image/heic',        4096, '2026-09-11 10:00:00', 1, 10, 'orig/a_j2_heic'),
      ('a_j2_ren',  'job', 'j2', 'Lead Report.pdf',          'application/zip',   4096, '2026-09-12 10:00:00', 1, 10, 'orig/a_j2_ren'),
      ('a_j2_renjpg', 'job', 'j2', 'Smith bid.jpg',          'application/zip',   4096, '2026-09-12 10:00:00', 1, 10, 'orig/a_j2_renjpg'),
      ('a_j2_renxls', 'job', 'j2', 'Old bid.pdf',            'application/octet-stream', 4096, '2026-09-12 10:00:00', 1, 10, 'orig/a_j2_renxls'),
      ('a_j2_csvjpg', 'job', 'j2', 'pull sheet.jpg',         'image/jpeg',        4096, '2026-09-12 10:00:00', 1, 10, 'orig/a_j2_csvjpg'),
      ('a_j2_htmlpdf', 'job', 'j2', 'quote.pdf',             'application/pdf',   4096, '2026-09-12 10:00:00', 1, 10, 'orig/a_j2_htmlpdf'),
      ('a_j2_pngpdf', 'job', 'j2', 'scan.pdf',               'application/pdf',   4096, '2026-09-12 10:00:00', 1, 10, 'orig/a_j2_pngpdf');
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

// What the extractor reads out of a takeoff: two lines, the way admitLine
// leaves them. A CSV has no sheet name.
const LINES = [
  { description: 'Drip edge 10 ft', qty: '20', unit: 'pc' },
  { description: 'Synthetic underlayment', qty: '6', unit: 'roll' },
];
function readOk(att, extra) {
  const csv = /\.csv$/i.test(String(att && att.filename));
  return Object.assign({
    ok: true,
    materials: LINES.map((l) => Object.assign({}, l)),
    method: csv ? 'csv' : 'sheet',
    source: { attachment_id: att.id, filename: att.filename, sheet: csv ? null : 'Takeoff' },
    counts: { found: 2, kept: 2, skipped: {}, over_cap: 0 },
    truncated: false,
    warnings: [],
  }, extra || {});
}

beforeEach(() => {
  seed();
  mockExtract.mockReset();
  mockExtract.mockImplementation(async (opts) => readOk(opts.att));
  mockGetBuffer.mockReset();
  mockGetBuffer.mockImplementation(storedBytes);
  mockLimiter.ai = false;
  mockLimiter.hourly = false;
  mockLimiter.calls = [];
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
const XLS_PROBLEM = 'Old .xls files can\'t be read — save it as .xlsx for a price-free copy.';
const NO_LINES_PROBLEM = 'No material lines could be read from that file, so links that hide financial details will not show it.';
const NOT_READABLE_PROBLEM = 'This file isn\'t a readable PDF, photo or spreadsheet, so it only shows on links sent with financial details.';
const TOO_LARGE_422 = [422, { error: 'That file is too large for the crew link (over 25 MB) — ask the office to send it another way.' }];
const NO_WRITE_CAP = [403, { error: 'Missing capability: JOBS_EDIT_ANY JOBS_EDIT_OWN' }];
const LIMITER_429 = [429, { error: 'Too many requests — please wait a moment and try again.' }];

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
 * CHOOSING A FILE — and the price-free copy made from a spreadsheet
 * ══════════════════════════════════════════════════════════════════════════*/
describe('choosing the file: what is stored, and the copy made from a spreadsheet', () => {
  test('nothing is shown until someone chooses: a fresh ticket has crew_takeoff null, and the office read carries it', async () => {
    expect(stored('st_j2')).toBeNull();
    const r = await readTicket(ticketRouter, WIDE, 'st_j2');
    expect(r.statusCode).toBe(200);
    expect(r.body.ticket).toHaveProperty('crew_takeoff', null);
  });

  test('an xlsx: the extractor reads the proved row, and its lines are stored as the copy — no has_prices', async () => {
    const r = await choose(ticketRouter, WIDE, 'st_j2', 'a_j2_x');
    expect(r.statusCode).toBe(200);
    expect(r.body.ok).toBe(true);
    const ct = r.body.crew_takeoff;
    expect(ct).toEqual({
      attachment_id: 'a_j2_x', filename: 'Lead Report.xlsx', kind: 'xlsx',
      set_at: expect.any(String), set_by: WIDE,
      copy: { lines: LINES, sheet: 'Takeoff', method: 'sheet', made_at: expect.any(String) },
      copy_problem: null,
    });
    expect(ct).not.toHaveProperty('has_prices');
    expect(Number.isNaN(Date.parse(ct.set_at))).toBe(false);
    expect(Number.isNaN(Date.parse(ct.copy.made_at))).toBe(false);
    expect(stored('st_j2')).toEqual(ct);
    expect(r.body.ticket.crew_takeoff).toEqual(ct);

    // WITH WHAT the extractor is called: the proved row, a storage reader, the
    // ticket's org, and the lazy AI gate.
    expect(mockExtract).toHaveBeenCalledTimes(1);
    const opts = mockExtract.mock.calls[0][0];
    expect(opts.att).toMatchObject({ id: 'a_j2_x', filename: 'Lead Report.xlsx', original_key: 'orig/a_j2_x', size_bytes: 20480 });
    expect(opts.orgId).toBe(1);
    expect(typeof opts.beforeAi).toBe('function');
    expect((await opts.getBuffer('orig/a_j2_x')).toString()).toBe('bytes of orig/a_j2_x');
    expect(mockGetBuffer).toHaveBeenCalledWith('orig/a_j2_x');

    // The office read carries it back.
    expect((await readTicket(ticketRouter, WIDE, 'st_j2')).body.ticket.crew_takeoff).toEqual(ct);
  });

  test('a CSV: the copy carries the csv method and no sheet', async () => {
    const r = await choose(ticketRouter, WIDE, 'st_j2', 'a_j2_c');
    expect(r.statusCode).toBe(200);
    expect(stored('st_j2')).toEqual({
      attachment_id: 'a_j2_c', filename: 'pull sheet.csv', kind: 'csv',
      set_at: expect.any(String), set_by: WIDE,
      copy: { lines: LINES, sheet: null, method: 'csv', made_at: expect.any(String) },
      copy_problem: null,
    });
  });

  test('the copy is normalizeMaterials\' shape: three strings a line, at most 100, blank descriptions dropped', async () => {
    const many = [];
    many.push({ description: '   ', qty: '1', unit: 'ea' });
    many.push({ description: 'Coil nails', qty: 12, unit: 'box', unit_cost: '$45.00', total: 540 });
    for (let i = 0; i < 150; i++) many.push({ description: 'Line ' + i, qty: String(i), unit: 'ea' });
    mockExtract.mockImplementation(async (opts) => readOk(opts.att, { materials: many }));
    expect((await choose(ticketRouter, WIDE, 'st_j2', 'a_j2_x')).statusCode).toBe(200);
    const lines = stored('st_j2').copy.lines;
    expect(lines).toHaveLength(100);
    expect(lines[0]).toEqual({ description: 'Coil nails', qty: '12', unit: 'box' });
    expect(lines.every((l) => Object.keys(l).sort().join() === 'description,qty,unit')).toBe(true);
    expect(lines.every((l) => typeof l.qty === 'string' && typeof l.unit === 'string')).toBe(true);
    expect(JSON.stringify(stored('st_j2'))).not.toMatch(/unit_cost|\$45|"total"/);
  });

  test('a read that answers ok with no usable line is copy null and a problem, not an empty copy', async () => {
    mockExtract.mockImplementation(async (opts) => readOk(opts.att, { materials: [{ description: '' }, null] }));
    const r = await choose(ticketRouter, WIDE, 'st_j2', 'a_j2_x');
    expect(r.statusCode).toBe(200);
    expect(stored('st_j2')).toMatchObject({ attachment_id: 'a_j2_x', kind: 'xlsx', copy: null, copy_problem: NO_LINES_PROBLEM });
  });

  test('a spreadsheet the extractor cannot copy is STORED with copy null and its words — unreadable, not a takeoff, no lines', async () => {
    for (const [code, error] of [
      ['unreadable', 'Lead Report.xlsx could not be opened — it may be damaged or password-protected.'],
      ['not_a_takeoff', 'Lead Report.xlsx does not look like a takeoff.'],
      ['no_lines', 'No material lines were found in Lead Report.xlsx.'],
    ]) {
      mockExtract.mockImplementation(async () => ({ ok: false, code, error }));
      const r = await choose(ticketRouter, WIDE, 'st_j2', 'a_j2_x');
      expect({ code, status: r.statusCode }).toEqual({ code, status: 200 });
      expect(stored('st_j2')).toEqual({
        attachment_id: 'a_j2_x', filename: 'Lead Report.xlsx', kind: 'xlsx',
        set_at: expect.any(String), set_by: WIDE, copy: null, copy_problem: error,
      });
      expect(r.body.crew_takeoff).toEqual(stored('st_j2'));
    }
    // An answer with no words of its own still gets a sentence.
    mockExtract.mockImplementation(async () => ({ ok: false, code: 'unreadable' }));
    await choose(ticketRouter, WIDE, 'st_j2', 'a_j2_c');
    expect(stored('st_j2')).toMatchObject({ copy: null, copy_problem: NO_LINES_PROBLEM });
  });

  test('an old .xls is allowed again: copy null, the one fix in words, and the file is never read', async () => {
    const r = await choose(ticketRouter, WIDE, 'st_j2', 'a_j2_old');
    expect(r.statusCode).toBe(200);
    expect(stored('st_j2')).toEqual({
      attachment_id: 'a_j2_old', filename: 'Estimate.xls', kind: 'xls',
      set_at: expect.any(String), set_by: WIDE, copy: null, copy_problem: XLS_PROBLEM,
    });
    expect(mockExtract).not.toHaveBeenCalled();
    expect(mockGetBuffer).not.toHaveBeenCalled();
  });

  test('a PDF or a photo is never read for lines: its bytes prove its name, copy null and copy_problem null', async () => {
    for (const [id, kind, filename] of [
      ['a_j2_p', 'pdf', 'Smith job - 48k bid.pdf'],
      ['a_j2_img', 'image', 'pull sheet photo.jpg'],
      // An iPhone original: a photo by its ftyp brand, though no browser type.
      ['a_j2_heic', 'image', 'IMG_0412.heic'],
    ]) {
      expect((await choose(ticketRouter, WIDE, 'st_j2', id)).statusCode).toBe(200);
      expect(stored('st_j2')).toEqual({
        attachment_id: id, filename, kind, set_at: expect.any(String), set_by: WIDE, copy: null, copy_problem: null,
      });
    }
    expect(mockExtract).not.toHaveBeenCalled();
    // Read once each, to be sniffed — and nothing more.
    expect(mockGetBuffer.mock.calls).toEqual([['orig/a_j2_p'], ['orig/a_j2_img'], ['orig/a_j2_heic']]);
    expect(mockLimiter.calls).toEqual([]);
  });

  test('a file that is not a takeoff type is 422, and nothing is read', async () => {
    const r = await choose(ticketRouter, WIDE, 'st_j2', 'a_j2_doc');
    expect(answer(r)).toEqual([422, { error: 'That file type cannot be shown on the crew link.' }]);
    expect(mockExtract).not.toHaveBeenCalled();
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
    expect(mockExtract).toHaveBeenCalledTimes(1);
  });

  test('the event names the FIELD, never the file or the copy', async () => {
    const before = eng.log.length;
    await choose(ticketRouter, WIDE, 'st_j2', 'a_j2_p');
    await choose(ticketRouter, WIDE, 'st_j2', 'a_j2_x');
    await choose(ticketRouter, WIDE, 'st_j2', null);
    const events = eng.all("SELECT kind, actor_user_id, detail FROM service_ticket_events WHERE ticket_id = 'st_j2'");
    expect(events.map((e) => [e.kind, e.actor_user_id, e.detail])).toEqual([
      ['field_changed', WIDE, { fields: ['crew_takeoff'] }],
      ['field_changed', WIDE, { fields: ['crew_takeoff'] }],
      ['field_changed', WIDE, { fields: ['crew_takeoff'] }],
    ]);
    const eventWrites = writesSince(before).filter((e) => /service_ticket_events/.test(e.sql));
    expect(JSON.stringify(eventWrites)).not.toMatch(/48k|Smith|\.pdf|a_j2_p|Lead Report|Drip edge/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * A NAME IS ONLY A CLAIM (review, 2026-09-14). The finding: a priced workbook
 * that reached the job as "Lead Report.pdf" or "Smith bid.jpg" (an inbound
 * email attachment keeps the sender's name; an octet-stream upload passes the
 * family check) was a "pdf" by takeoffKind, so the PUT never opened it and
 * stored {kind:'pdf', copy:null} — and every crew link, financials hidden or
 * not, was then handed the workbook itself. The bytes decide now.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a PDF or photo by name is proved from its bytes', () => {
  test('the review\'s repro: "Lead Report.pdf" holding a workbook with Unit Cost $45.00 is stored as an xlsx WITH its copy', async () => {
    const r = await choose(ticketRouter, WIDE, 'st_j2', 'a_j2_ren');
    expect(r.statusCode).toBe(200);
    expect(stored('st_j2')).toEqual({
      attachment_id: 'a_j2_ren', filename: 'Lead Report.pdf', kind: 'xlsx',
      set_at: expect.any(String), set_by: WIDE,
      copy: { lines: LINES, sheet: 'Takeoff', method: 'sheet', made_at: expect.any(String) },
      copy_problem: null,
    });
    expect(r.body.crew_takeoff).toEqual(stored('st_j2'));
    // The extractor read the proved row, and was handed the SAME bytes the
    // sniff read: the file left storage once.
    expect(mockExtract).toHaveBeenCalledTimes(1);
    const opts = mockExtract.mock.calls[0][0];
    expect(opts.att).toMatchObject({ id: 'a_j2_ren', filename: 'Lead Report.pdf', original_key: 'orig/a_j2_ren' });
    expect(await opts.getBuffer('orig/a_j2_ren')).toBe(XLSX_BYTES);
    expect(mockGetBuffer.mock.calls).toEqual([['orig/a_j2_ren']]);
    // Nothing of the workbook's but the three scrubbed strings a line.
    expect(JSON.stringify(stored('st_j2'))).not.toMatch(/Unit Cost|\$45/);
  });

  test('a real exceljs workbook with Unit Price and Total columns, named "Smith job - 48k bid.pdf", sniffs as the xlsx it is', async () => {
    const ExcelJS = jest.requireActual('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Takeoff');
    ws.addRow(['Description', 'Qty', 'Unit', 'Unit Price', 'Total']);
    ws.addRow(['Drip edge 10 ft', 20, 'pc', 45, 900]);
    const real = Buffer.from(await wb.xlsx.writeBuffer());
    mockGetBuffer.mockImplementation(async (key) => (key === 'orig/a_j2_p' ? real : storedBytes(key)));
    expect((await choose(ticketRouter, WIDE, 'st_j2', 'a_j2_p')).statusCode).toBe(200);
    expect(stored('st_j2')).toMatchObject({ attachment_id: 'a_j2_p', kind: 'xlsx', copy: { lines: LINES }, copy_problem: null });
    expect(await mockExtract.mock.calls[0][0].getBuffer('orig/a_j2_p')).toBe(real);
  });

  test('the same under a photo\'s name: "Smith bid.jpg" holding a workbook is an xlsx with its copy', async () => {
    expect((await choose(ticketRouter, WIDE, 'st_j2', 'a_j2_renjpg')).statusCode).toBe(200);
    expect(stored('st_j2')).toMatchObject({
      attachment_id: 'a_j2_renjpg', filename: 'Smith bid.jpg', kind: 'xlsx', copy: { lines: LINES }, copy_problem: null,
    });
    expect(mockExtract).toHaveBeenCalledTimes(1);
  });

  test('a renamed workbook the extractor cannot copy is still the xlsx it is: copy null and the extractor\'s words', async () => {
    mockExtract.mockImplementation(async () => ({ ok: false, code: 'not_a_takeoff', error: 'Lead Report.pdf does not look like a takeoff.' }));
    expect((await choose(ticketRouter, WIDE, 'st_j2', 'a_j2_ren')).statusCode).toBe(200);
    expect(stored('st_j2')).toMatchObject({ kind: 'xlsx', copy: null, copy_problem: 'Lead Report.pdf does not look like a takeoff.' });
  });

  test('an OLE .xls behind a PDF\'s name is kind xls with the one fix, and is not handed to the extractor', async () => {
    expect((await choose(ticketRouter, WIDE, 'st_j2', 'a_j2_renxls')).statusCode).toBe(200);
    expect(stored('st_j2')).toEqual({
      attachment_id: 'a_j2_renxls', filename: 'Old bid.pdf', kind: 'xls',
      set_at: expect.any(String), set_by: WIDE, copy: null, copy_problem: XLS_PROBLEM,
    });
    expect(mockExtract).not.toHaveBeenCalled();
  });

  test('bytes that are neither the name\'s kind nor a spreadsheet are kind unknown: copy null and the sentence', async () => {
    for (const [id, filename] of [
      ['a_j2_csvjpg', 'pull sheet.jpg'],     // a CSV under a photo's name
      ['a_j2_htmlpdf', 'quote.pdf'],         // an HTML page under a PDF's name
      ['a_j2_pngpdf', 'scan.pdf'],           // a photo under a PDF's name
    ]) {
      expect({ id, status: (await choose(ticketRouter, WIDE, 'st_j2', id)).statusCode }).toEqual({ id, status: 200 });
      expect(stored('st_j2')).toEqual({
        attachment_id: id, filename, kind: 'unknown',
        set_at: expect.any(String), set_by: WIDE, copy: null, copy_problem: NOT_READABLE_PROBLEM,
      });
    }
    expect(mockExtract).not.toHaveBeenCalled();
    expect(mockLimiter.calls).toEqual([]);
  });

  test('a storage failure proving a PDF is a plain 500: nothing stored, and the slot comes back', async () => {
    mockGetBuffer.mockImplementationOnce(async () => { throw new Error('R2 NoSuchKey orig/a_j2_p'); });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(answer(await choose(ticketRouter, WIDE, 'st_j2', 'a_j2_p'))).toEqual([500, { error: 'Failed to change the crew link takeoff' }]);
    } finally {
      spy.mockRestore();
    }
    expect(stored('st_j2')).toBeNull();
    expect((await choose(ticketRouter, WIDE, 'st_j2', 'a_j2_p')).statusCode).toBe(200);
    expect(stored('st_j2')).toMatchObject({ kind: 'pdf', copy: null, copy_problem: null });
  });

  test('a limiter\'s 429 while copying a renamed workbook stands, with nothing stored', async () => {
    mockLimiter.ai = true;
    mockExtract.mockImplementation(async (opts) => {
      const go = await opts.beforeAi();
      return go ? readOk(opts.att) : { ok: false, code: 'rate_limited', error: '86 is busy — try again in a minute.' };
    });
    const before = eng.log.length;
    expect(answer(await choose(ticketRouter, WIDE, 'st_j2', 'a_j2_ren'))).toEqual(LIMITER_429);
    expect(writesSince(before)).toEqual([]);
    expect(stored('st_j2')).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE LAZY AI GATE — the extract door's. A spreadsheet the header read can map
 * costs no AI allowance; one the extractor has to hand to the model runs the
 * limiters first, and a limiter's refusal stands with nothing stored.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the AI limiters run only when the extractor asks', () => {
  test('an extractor that never reaches for the model runs no limiter', async () => {
    expect((await choose(ticketRouter, WIDE, 'st_j2', 'a_j2_x')).statusCode).toBe(200);
    expect(mockLimiter.calls).toEqual([]);
  });

  test('an extractor that asks runs both limiters once, and its lines are stored', async () => {
    mockExtract.mockImplementation(async (opts) => {
      const go = await opts.beforeAi();
      return go ? readOk(opts.att, { method: 'ai-text' }) : { ok: false, code: 'rate_limited', error: '86 is busy — try again in a minute.' };
    });
    expect((await choose(ticketRouter, WIDE, 'st_j2', 'a_j2_x')).statusCode).toBe(200);
    expect(mockLimiter.calls).toEqual(['ai', 'hourly']);
    expect(stored('st_j2')).toMatchObject({ copy: { lines: LINES, method: 'ai-text' }, copy_problem: null });
  });

  test('a limiter that answers 429 inside beforeAi: its answer stands, nothing is stored, the slot comes back', async () => {
    mockExtract.mockImplementation(async (opts) => {
      const go = await opts.beforeAi();
      return go ? readOk(opts.att) : { ok: false, code: 'rate_limited', error: '86 is busy — try again in a minute.' };
    });
    for (const which of ['ai', 'hourly']) {
      mockLimiter.ai = which === 'ai';
      mockLimiter.hourly = which === 'hourly';
      const before = eng.log.length;
      const r = await choose(ticketRouter, WIDE, 'st_j2', 'a_j2_x');
      expect({ which, a: answer(r), writes: r.writes }).toEqual({ which, a: LIMITER_429, writes: 1 });
      expect(writesSince(before)).toEqual([]);
      expect(stored('st_j2')).toBeNull();
    }
    mockLimiter.ai = false;
    mockLimiter.hourly = false;
    expect((await choose(ticketRouter, WIDE, 'st_j2', 'a_j2_x')).statusCode).toBe(200);
  });

  test('a limiter that FAILED rather than refused (rate_limited, nothing written) is a 429, not a stored problem', async () => {
    mockExtract.mockImplementation(async () => ({ ok: false, code: 'rate_limited', error: '86 is busy — try again in a minute.' }));
    const before = eng.log.length;
    expect(answer(await choose(ticketRouter, WIDE, 'st_j2', 'a_j2_x'))).toEqual([429, { error: '86 is busy — try again in a minute.' }]);
    expect(writesSince(before)).toEqual([]);
    expect(stored('st_j2')).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE CREW DOOR'S SIZE CAP — a file the crew door cannot send is refused, of
 * every kind, before any read.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a file over the crew link\'s size cap is refused before it is read', () => {
  test('the 38 MB plan-set PDF: 422, no read, no storage fetch, nothing written', async () => {
    const before = eng.log.length;
    expect(answer(await choose(ticketRouter, WIDE, 'st_j2', 'a_j2_plans'))).toEqual(TOO_LARGE_422);
    expect(mockExtract).not.toHaveBeenCalled();
    expect(mockGetBuffer).not.toHaveBeenCalled();
    expect(writesSince(before)).toEqual([]);
    expect(stored('st_j2')).toBeNull();
  });

  test('the cap is materials-extract\'s MAX_FILE_BYTES, the number the share side reads: at it passes, one byte over is refused', async () => {
    expect(realExtract.MAX_FILE_BYTES).toBe(25 * MB);
    eng.db.exec(`UPDATE attachments SET size_bytes = ${realExtract.MAX_FILE_BYTES} WHERE id = 'a_j2_plans'`);
    expect((await choose(ticketRouter, WIDE, 'st_j2', 'a_j2_plans')).statusCode).toBe(200);
    expect(stored('st_j2')).toMatchObject({ attachment_id: 'a_j2_plans', kind: 'pdf', copy: null });

    eng.db.exec(`UPDATE attachments SET size_bytes = ${realExtract.MAX_FILE_BYTES + 1} WHERE id = 'a_j2_plans'`);
    expect(answer(await choose(ticketRouter, WIDE, 'st_j2', 'a_j2_plans'))).toEqual(TOO_LARGE_422);
    // A refusal leaves the earlier choice as it was.
    expect(stored('st_j2')).toMatchObject({ attachment_id: 'a_j2_plans' });
  });

  test('an oversized SPREADSHEET is the same size refusal, before the slot or the read', async () => {
    eng.db.exec(`UPDATE attachments SET size_bytes = ${30 * MB} WHERE id = 'a_j2_x'`);
    expect(answer(await choose(ticketRouter, WIDE, 'st_j2', 'a_j2_x'))).toEqual(TOO_LARGE_422);
    expect(mockExtract).not.toHaveBeenCalled();
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

  test('a VIEW grant is the missing-ticket 404, and nothing is read or written', async () => {
    const before = eng.log.length;
    expect(answer(await choose(ticketRouter, CREW, 'st_j1', 'a_j1_c'))).toEqual(TICKET_404);
    expect(answer(await choose(ticketRouter, CREW, 'st_nope', 'a_j1_c'))).toEqual(TICKET_404);
    expect(answer(await choose(ticketRouter, CREW, 'st_j1', null))).toEqual(TICKET_404);
    expect(writesSince(before)).toEqual([]);
    expect(mockExtract).not.toHaveBeenCalled();
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
    expect(mockExtract).not.toHaveBeenCalled();
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
    expect(mockExtract).not.toHaveBeenCalled();
  });

  test('the lead\'s file needs LEADS_VIEW and the estimate\'s ESTIMATES_VIEW — the same gates as the picker', async () => {
    expect(answer(await choose(ticketRouter, CREW, 'st_j2', 'a_l1'))).toEqual(FILE_404);
    expect(answer(await choose(ticketRouter, CREW, 'st_j2', 'a_e1'))).toEqual(FILE_404);
    expect(answer(await choose(ticketRouter, JOBS, 'st_j2', 'a_e1'))).toEqual(FILE_404);
    expect(mockExtract).not.toHaveBeenCalled();
    expect((await choose(ticketRouter, JOBS, 'st_j2', 'a_l1')).statusCode).toBe(200);
    expect(stored('st_j2')).toMatchObject({ attachment_id: 'a_l1', kind: 'xlsx', copy: { lines: LINES } });
    expect((await choose(ticketRouter, WIDE, 'st_j2', 'a_e1')).statusCode).toBe(200);
    expect(stored('st_j2')).toMatchObject({ attachment_id: 'a_e1', kind: 'pdf', copy: null, copy_problem: null });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * ONE READ PER USER — making the copy pulls the file out of storage and
 * parses it, so it shares the extract door's one-read-per-user slot, taken
 * before the fetch and given back as soon as the extractor answers.
 * ══════════════════════════════════════════════════════════════════════════*/
const BUSY = [429, { error: 'Still reading your last file — try again in a moment.' }];

function gate() {
  let open;
  const shut = new Promise((resolve) => { open = resolve; });
  return { shut, open };
}

async function until(cond) {
  for (let i = 0; i < 5000 && !cond(); i++) await new Promise((r) => setImmediate(r));
  if (!cond()) throw new Error('the first request never reached the extractor');
}

describe('one file read per user at a time', () => {
  test('a second spreadsheet choice by the same user while a read is in flight is a 429, and nothing is written', async () => {
    const g = gate();
    let calls = 0;
    mockExtract.mockImplementation(async (opts) => { calls += 1; if (calls === 1) await g.shut; return readOk(opts.att); });
    const first = choose(ticketRouter, WIDE, 'st_j2', 'a_j2_c');
    await until(() => mockExtract.mock.calls.length === 1);

    const before = eng.log.length;
    expect(answer(await choose(ticketRouter, WIDE, 'st_j2', 'a_j2_x'))).toEqual(BUSY);
    // The extract door is the same slot.
    expect(answer(await drive(ticketRouter, 'post', '/:id/materials/extract',
      { as: WIDE, params: { id: 'st_j2' }, body: { attachment_id: 'a_j2_x' } }))).toEqual(BUSY);
    expect(writesSince(before)).toEqual([]);
    expect(mockExtract).toHaveBeenCalledTimes(1);

    // A PDF or a photo is read now, to prove its name from its bytes, so it
    // takes the slot too — busy, and nothing written, not even a sniff.
    for (const id of ['a_j2_p', 'a_j2_img', 'a_j2_ren']) {
      expect({ id, a: answer(await choose(ticketRouter, WIDE, 'st_j2', id)) }).toEqual({ id, a: BUSY });
    }
    expect(mockGetBuffer).not.toHaveBeenCalled();
    expect(writesSince(before)).toEqual([]);
    // An old .xls reads no file, and clearing reads none, so neither takes it.
    for (const id of ['a_j2_old', null]) {
      expect({ id, status: (await choose(ticketRouter, WIDE, 'st_j2', id)).statusCode }).toEqual({ id, status: 200 });
    }
    // Another user is not held up.
    expect((await choose(ticketRouter, CREW, 'st_j2', 'a_j2_c')).statusCode).toBe(200);

    g.open();
    expect((await first).statusCode).toBe(200);
    expect((await choose(ticketRouter, WIDE, 'st_j2', 'a_j2_x')).statusCode).toBe(200);
    expect(stored('st_j2')).toMatchObject({ attachment_id: 'a_j2_x', copy: { lines: LINES } });
  });

  test('a read that throws is a plain 500 and still gives the slot back', async () => {
    mockExtract.mockImplementationOnce(async () => { throw new Error('storage fell over'); });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(answer(await choose(ticketRouter, WIDE, 'st_j2', 'a_j2_c'))).toEqual([500, { error: 'Failed to change the crew link takeoff' }]);
    } finally {
      spy.mockRestore();
    }
    expect(stored('st_j2')).toBeNull();
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

  test('never give the read slot back and the user\'s next spreadsheet choice is refused as busy', async () => {
    const mut = mutant(TICKET_ROUTES, [[
      '              beforeAi: lazyAiGate(req, res),\n'
        + '            });\n'
        + '          }\n'
        + '        } finally {\n'
        + '          release();\n'
        + '        }',
      '              beforeAi: lazyAiGate(req, res),\n'
        + '            });\n'
        + '          }\n'
        + '        } finally {\n'
        + '        }',
    ]]);
    expect((await choose(mut, WIDE, 'st_j2', 'a_j2_c')).statusCode).toBe(200);
    expect(answer(await choose(mut, WIDE, 'st_j2', 'a_j2_c'))).toEqual(BUSY);
    expect(mockExtract).toHaveBeenCalledTimes(1);
  });

  test('store the extractor\'s lines as they came and a price the extractor carried lands in the copy', async () => {
    mockExtract.mockImplementation(async (opts) => readOk(opts.att, {
      materials: [{ description: 'Drip edge 10 ft', qty: '20', unit: 'pc', unit_cost: '$45.00' }],
    }));
    expect((await choose(ticketRouter, WIDE, 'st_j2', 'a_j2_x')).statusCode).toBe(200);
    expect(stored('st_j2').copy.lines).toEqual([{ description: 'Drip edge 10 ft', qty: '20', unit: 'pc' }]);
    const mut = mutant(TICKET_ROUTES, [[
      '    const lines = svc.normalizeMaterials(result.materials);',
      '    const lines = result.materials;',
    ]]);
    expect((await choose(mut, WIDE, 'st_j2', 'a_j2_x')).statusCode).toBe(200);
    expect(stored('st_j2').copy.lines).toEqual([{ description: 'Drip edge 10 ft', qty: '20', unit: 'pc', unit_cost: '$45.00' }]);
  });

  test('store a failed limiter as the file\'s problem and "86 is busy" lands on the choice', async () => {
    mockExtract.mockImplementation(async () => ({ ok: false, code: 'rate_limited', error: '86 is busy — try again in a minute.' }));
    const mut = mutant(TICKET_ROUTES, [[
      "        if (result && result.ok !== true && result.code === 'rate_limited') {",
      '        if (false) {',
    ]]);
    expect((await choose(mut, WIDE, 'st_j2', 'a_j2_x')).statusCode).toBe(200);
    expect(stored('st_j2')).toMatchObject({ copy: null, copy_problem: '86 is busy — try again in a minute.' });
  });

  test('drop the byte sniff and "Lead Report.pdf" holding a priced workbook is stored as a PDF with no copy — the review\'s finding', async () => {
    expect((await choose(ticketRouter, WIDE, 'st_j2', 'a_j2_ren')).statusCode).toBe(200);
    expect(stored('st_j2')).toMatchObject({ kind: 'xlsx', copy: { lines: LINES } });
    const mut = mutant(TICKET_ROUTES, [[
      '            kind = kindFromBytes(kind, sniffKind(held, att.filename, att.mime_type));',
      '            // MUTANT: the name decides',
    ]]);
    mockExtract.mockClear();
    expect((await choose(mut, WIDE, 'st_j2', 'a_j2_ren')).statusCode).toBe(200);
    // The shape the share side then trusted as a PDF on every link.
    expect(stored('st_j2')).toMatchObject({ attachment_id: 'a_j2_ren', kind: 'pdf', copy: null, copy_problem: null });
    expect(mockExtract).not.toHaveBeenCalled();
    // The CSV under a photo's name is let through as a photo the same way.
    expect((await choose(mut, WIDE, 'st_j2', 'a_j2_csvjpg')).statusCode).toBe(200);
    expect(stored('st_j2')).toMatchObject({ kind: 'image', copy_problem: null });
  });

  test('keep the name when the bytes are a spreadsheet and the workbook is stored as a "pdf" again', async () => {
    const mut = mutant(TICKET_ROUTES, [[
      "  if (byteKind === 'xlsx' || byteKind === 'xls' || byteKind === 'csv') return byteKind;\n  return 'unknown';",
      "  if (byteKind === 'xlsx' || byteKind === 'xls' || byteKind === 'csv') return nameKind;\n  return 'unknown';",
    ]]);
    expect((await choose(mut, WIDE, 'st_j2', 'a_j2_ren')).statusCode).toBe(200);
    expect(stored('st_j2')).toMatchObject({ kind: 'pdf', copy: null, copy_problem: null });
  });

  test('drop the size cap and the 38 MB plan set is stored for a door that will never send it', async () => {
    const mut = mutant(TICKET_ROUTES, [[
      '      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) {',
      '      if (false) {',
    ]]);
    expect((await choose(mut, WIDE, 'st_j2', 'a_j2_plans')).statusCode).toBe(200);
    expect(stored('st_j2')).toMatchObject({ attachment_id: 'a_j2_plans', kind: 'pdf', copy: null });
  });
});
