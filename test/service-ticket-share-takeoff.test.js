// "LET THE CREW LINK SHOW THE TAKEOFF FILE TOO" — THE CREW SIDE.
//
// The office chooses one file (PUT /api/service-tickets/:id/crew-takeoff,
// pinned in test/service-ticket-crew-takeoff.test.js). This file pins what a
// LINK then does with that choice, through the REAL handlers on
// server/routes/service-ticket-share-routes.js:
//
//   GET /api/service-ticket-share/:token          the `takeoff` card data
//   GET /api/service-ticket-share/:token/takeoff  the bytes, through the token
//
// The rules, in John's words and then in the code's:
//   * off until the PM chooses                    crew_takeoff NULL -> nothing
//   * no financial info on work orders — the      a spreadsheet (xlsx, csv, xls)
//     "price-free copy" (John, 2026-09-14)        on a link that hides
//                                                 financials (the default) is
//                                                 NEVER the original: it is a
//                                                 generated xlsx built from
//                                                 crew_takeoff.copy.lines, or
//                                                 nothing when there is no copy
//                                                 (copy null, or a row stored
//                                                 before copies — has_prices)
//   * sent with financial details                 the original spreadsheet
//   * PDFs and photos, the office confirms        the original, on every link
//   * a revoked or expired link stops             loadTicketShare, 410
//   * a file removed from the job stops           the attachment is re-proved
//                                                 against the ticket's job,
//                                                 lead and estimate on EVERY
//                                                 read — the copy path too
//   * a file the door cannot send is not offered  an ORIGINAL over
//                                                 MAX_FILE_BYTES, no card
//   * the door holds no file in memory            the original is piped from
//                                                 storage.getStream; the copy
//                                                 never touches storage; one
//                                                 download per link and per
//                                                 address on both paths
//
// Harness: the guest-write style. A fake Postgres answers the statements the
// route emits and records every one, so "the file was never fetched" and "the
// door never reached the attachments table" are measured, not asserted. The
// attachment read is answered by EVALUATING the parent predicates the
// statement actually contains — which is what lets the parent-binding mutant
// below fail for the right reason instead of against a canned row. The copy
// builder (materials-extract buildMaterialsCopy) is mocked: its own rules are
// pinned in test/materials-extract.test.js, and here only WHETHER and WITH
// WHAT the routes call it is under test.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable, Writable } = require('stream');
const svc = require('../server/services/service-tickets');
const realExtract = jest.requireActual('../server/services/materials-extract.js');
const { MAX_FILE_BYTES } = realExtract;

const TOKEN = 'a'.repeat(64);
// A second link, on the same ticket, for the per-address slot.
const TOKEN_2 = 'b'.repeat(64);
const SHARE_ROUTES = path.join(__dirname, '..', 'server', 'routes', 'service-ticket-share-routes.js');

// ── A fake Postgres ─────────────────────────────────────────────────────
function makeWorld(opts) {
  const o = opts || {};
  const world = {
    log: [],
    share: Object.assign({
      id: 'stshare_1', organization_id: 1, ticket_id: 'st_1', token_hash: svc.hashToken(TOKEN),
      scope: 'view', hide_financials: true, recipient_email: 'crew@sub.test', recipient_name: 'Marco',
      expires_at: new Date(Date.now() + 86400000).toISOString(), opened_at: '2026-09-10T00:00:00Z',
      revoked_at: null, created_by: 10,
    }, o.share || {}),
    ticket: Object.assign({
      id: 'st_1', organization_id: 1, job_id: 'j1', lead_id: null, title: 'Re-roof punch list',
      status: 'scheduled', scope_approved: 'PRICED SCOPE $48,000', internal_notes: 'margin is thin',
      checklist: [], materials: null, crew_takeoff: null, archived_at: null, created_by: 10,
    }, o.ticket || {}),
    // j1 was converted from lead l1 and sold from estimate e1. j2 is another
    // job in the same org. j3 names ANOTHER tenant's lead and estimate.
    jobs: [
      { id: 'j1', organization_id: 1, lead_id: 'l1', estimate_id: 'e1' },
      { id: 'j2', organization_id: 1, lead_id: null, estimate_id: null },
      { id: 'j3', organization_id: 1, lead_id: 'l9', estimate_id: 'e9' },
      { id: 'j9', organization_id: 2, lead_id: 'l9', estimate_id: 'e9' },
    ],
    leads: [{ id: 'l1', organization_id: 1 }, { id: 'l9', organization_id: 2 }],
    estimates: [{ id: 'e1', organization_id: 1 }, { id: 'e9', organization_id: 2 }],
    attachments: [
      att('a_pdf', 'job', 'j1', 'Field takeoff.pdf', 'application/pdf'),
      att('a_xlsx', 'job', 'j1', 'Lead Report.xlsx', 'application/zip'),
      att('a_csv', 'job', 'j1', 'pull sheet.csv', 'text/csv'),
      att('a_png', 'job', 'j1', 'pull sheet photo.png', 'image/png'),
      att('a_fakejpg', 'job', 'j1', 'photo.jpg', 'image/jpeg'),
      att('a_fakepdf', 'job', 'j1', 'not really.pdf', 'application/pdf'),
      att('a_lead', 'lead', 'l1', 'lead-takeoff.xlsx', 'application/zip'),
      att('a_est', 'estimate', 'e1', 'T5 pull sheet.pdf', 'application/pdf'),
      att('a_other_job', 'job', 'j2', 'j2 takeoff.pdf', 'application/pdf'),
      att('a_rival_lead', 'lead', 'l9', 'rival.xlsx', 'application/zip', 2),
      att('a_docx', 'job', 'j1', 'contract.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
      att('a_big', 'job', 'j1', 'huge scan.pdf', 'application/pdf', 1, 30 * 1024 * 1024),
      att('a_weird', 'job', 'j1', 'Bid "final"\r\nSet-Cookie: x=1 \u2014 Caf\u00e9.pdf', 'application/pdf'),
      // An old estimating export with a Unit Cost column, and a plan set
      // between the crew cap and the 50 MB upload cap.
      att('a_xls', 'job', 'j1', 'Estimate.xls', 'application/vnd.ms-excel'),
      att('a_plans', 'job', 'j1', 'Plan set.pdf', 'application/pdf', 1, 38 * 1024 * 1024),
      // A spreadsheet renamed to .pdf after it was chosen (its bytes are still
      // the workbook), and a spreadsheet over the crew cap.
      att('a_renamed', 'job', 'j1', 'Lead Report.pdf', 'application/pdf'),
      att('a_bigsheet', 'job', 'j1', 'Whole estimate.xlsx', 'application/zip', 1, 30 * 1024 * 1024),
    ].concat(o.attachments || []),
    users: [{ id: 10, organization_id: 1 }, { id: 50, organization_id: 2 }],
  };
  if (o.mutateWorld) o.mutateWorld(world);

  const TABLES = { jobs: 'jobs', leads: 'leads', estimates: 'estimates' };

  world.query = async (sql, params) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    const p = params || [];
    world.log.push({ sql: text, params: p });
    if (o.throwOn && o.throwOn.test(text)) throw new Error('fake pg: planted failure');

    if (/FROM service_ticket_shares WHERE token_hash/i.test(text)) {
      return { rows: [world.share].concat(world.otherShares || []).filter((s) => p[0] === s.token_hash) };
    }
    if (/FROM service_tickets WHERE id = \$1 AND archived_at IS NULL/i.test(text)) {
      return { rows: p[0] === world.ticket.id ? [world.ticket] : [] };
    }
    if (/^UPDATE service_ticket_shares/i.test(text)) return { rows: [], rowCount: 1 };
    if (/^INSERT INTO service_ticket_events/i.test(text)) return { rows: [], rowCount: 1 };
    if (/FROM organizations/i.test(text)) return { rows: [{ name: 'AG Exteriors' }] };
    if (/FROM tasks/i.test(text)) return { rows: [] };
    if (/FROM service_ticket_events/i.test(text)) return { rows: [] };
    if (/FROM users WHERE id = ANY/i.test(text)) return { rows: [] };
    if (/FROM users WHERE id = \$1/i.test(text)) {
      return { rows: world.users.filter((u) => String(u.id) === String(p[0])) };
    }
    if (/FROM attachments WHERE entity_type = 'task'/i.test(text)) return { rows: [] };

    // jobs / leads / estimates keyed on id, with the org predicate honoured
    // only when the statement carries one.
    const keyed = /FROM (jobs|leads|estimates) WHERE id = \$1( AND organization_id = \$2)?/i.exec(text);
    if (keyed) {
      const rows = world[TABLES[keyed[1].toLowerCase()]].filter((r) => String(r.id) === String(p[0])
        && (!keyed[2] || String(r.organization_id) === String(p[1])));
      return { rows: rows.map((r) => Object.assign({}, r)) };
    }

    // THE attachment read: id, then whichever (entity_type, entity_id) arms
    // the statement contains, evaluated. No arms -> no parent filter at all.
    if (/FROM attachments WHERE id = \$1/i.test(text)) {
      const arms = [];
      const re = /entity_type = '([a-z_]+)' AND entity_id = \$(\d+)/g;
      let m;
      while ((m = re.exec(text))) arms.push([m[1], Number(m[2])]);
      const rows = world.attachments.filter((a) => a.id === p[0] && (!arms.length || arms.some(([type, n]) => (
        a.entity_type === type && p[n - 1] != null && String(a.entity_id) === String(p[n - 1])
      ))));
      return { rows: rows.map((r) => Object.assign({}, r)) };
    }
    throw new Error('fake pg: unhandled statement -> ' + text.slice(0, 160));
  };
  return world;
}

function att(id, entityType, entityId, filename, mime, org, size) {
  return {
    id, entity_type: entityType, entity_id: entityId, organization_id: org || 1, uploaded_by: 10,
    filename, mime_type: mime, size_bytes: size || 4096, original_key: 'orig/' + id,
    original_url: 'https://cdn.test/PUBLIC-STORAGE-URL/' + id,
  };
}

// The bytes storage hands back, by key. Each is padded to the 4096 bytes the
// attachment rows record: the door sends the STORED size as Content-Length and
// refuses a file whose bytes disagree with it.
const pad = (b) => Buffer.concat([b, Buffer.alloc(4096 - b.length, 0x20)]);
const PDF = pad(Buffer.from('%PDF-1.4\n1 0 obj\n<< >>\nendobj\n%%EOF\n'));
const PNG = pad(Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.from('pngbody')]));
const XLSX = pad(Buffer.concat([Buffer.from([0x50, 0x4B, 0x03, 0x04]), Buffer.from('xl/workbook.xml Unit Cost $45.00')]));
const XLS = pad(Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]));
const CSV = pad(Buffer.from('Description,Qty,Unit Cost\r\nDrip edge,20,$45.00\r\n'));
const BYTES = {
  'orig/a_pdf': PDF, 'orig/a_xlsx': XLSX, 'orig/a_csv': CSV,
  'orig/a_png': PNG, 'orig/a_fakejpg': pad(Buffer.from('<html><script>alert(1)</script></html>')),
  'orig/a_fakepdf': pad(Buffer.from('<svg onload="alert(1)"></svg>')), 'orig/a_lead': XLSX, 'orig/a_est': PDF,
  'orig/a_other_job': PDF, 'orig/a_weird': PDF, 'orig/a_big': PDF, 'orig/a_xls': XLS, 'orig/a_plans': PDF,
  'orig/a_renamed': XLSX,
};

// A storage stream the test feeds by hand: `push` a chunk, `end` it. Its
// destroy is immediate, like an fs or R2 body stream.
function handFed() {
  const stream = new Readable({ read() {} });
  return { stream, push: (b) => stream.push(b), end: () => stream.push(null) };
}

global.__takeoffWorld = null;
jest.mock('../server/db', () => ({
  pool: {
    query: async (sql, params) => global.__takeoffWorld.query(sql, params),
    connect: async () => ({ query: async (s, p) => global.__takeoffWorld.query(s, p), release() {} }),
  },
}));
jest.mock('../server/auth', () => ({
  requireAuth: (req, res, next) => next(),
  requireOrgId: (req, res, next) => { req.orgId = 1; next(); },
  requireCapability: () => (req, res, next) => next(),
}));
jest.mock('../server/email', () => ({ sendEmail: async () => {}, isEnabled: () => false }));
// Every limiter server/rate-limit.js exports, pass-through — omitting one a
// router destructures makes express throw at load and the suite report 0 tests.
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
jest.mock('../server/services/entity-labels', () => ({
  resolveEntityLabels: async () => new Map([['job:j1', 'RV2006 Waterside 1']]),
}));
// getBuffer stays on the mock so a door that went back to reading the whole
// file would be CAUGHT calling it, not fail on a missing method.
const mockGetBuffer = jest.fn();
const mockGetStream = jest.fn();
jest.mock('../server/storage', () => ({
  storage: {
    put: async (k) => 'https://cdn/' + k,
    getBuffer: (...args) => mockGetBuffer(...args),
    getStream: (...args) => mockGetStream(...args),
  },
}));
jest.mock('../server/services/service-ticket-notify', () => ({
  notifyAwaitingApproval: async () => ({ sent: 0 }),
}));
// Only the copy builder is replaced; takeoffKind and MAX_FILE_BYTES stay the
// real rule the routes share with the office's PUT.
const mockBuild = jest.fn();
jest.mock('../server/services/materials-extract', () => Object.assign(
  {}, jest.requireActual('../server/services/materials-extract.js'),
  { buildMaterialsCopy: (...args) => mockBuild(...args) }
));

const router = require('../server/routes/service-ticket-share-routes');

// What the mocked builder hands back: bytes that name how many lines went in,
// and the contract's "Materials - <base name>.xlsx".
const copyBytes = (n) => Buffer.concat([Buffer.from([0x50, 0x4B, 0x03, 0x04]), Buffer.from('price-free copy of ' + n + ' lines')]);

beforeEach(() => {
  mockGetBuffer.mockReset();
  mockGetBuffer.mockImplementation(async (key) => {
    if (!Object.prototype.hasOwnProperty.call(BYTES, key)) throw new Error('no such key ' + key);
    return BYTES[key];
  });
  mockGetStream.mockReset();
  mockGetStream.mockImplementation(async (key) => {
    if (!Object.prototype.hasOwnProperty.call(BYTES, key)) throw new Error('no such key ' + key);
    return { stream: Readable.from([BYTES[key]]), size: BYTES[key].length };
  });
  mockBuild.mockReset();
  mockBuild.mockImplementation(async ({ lines, sourceName }) => ({
    buffer: copyBytes(lines.length),
    filename: 'Materials - ' + String(sourceName).replace(/\.[^.]*$/, '') + '.xlsx',
  }));
});
// What storage was asked for, by either read.
const fetched = () => mockGetStream.mock.calls.length + mockGetBuffer.mock.calls.length;

const mutantPaths = [];
afterAll(() => {
  for (const p of mutantPaths) { try { fs.unlinkSync(p); } catch (e) { /* already gone */ } }
});

// ── the drive ─────────────────────────────────────────────────────────────
// A REAL Writable, because the door pipes into the response: backpressure,
// a reader going away (destroy) and a body that never finishes all behave as
// they do on an http.ServerResponse. `ended` is the body, once it FINISHED;
// a response that was dropped part way keeps `ended` null.
function fakeRes() {
  const chunks = [];
  const res = new Writable({
    write(chunk, enc, cb) {
      res.headersSent = true;
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  Object.assign(res, { statusCode: 200, body: null, headersSent: false, headers: {}, ended: null, timeout: null });
  res.on('error', () => { /* a dropped response; the door's pipeline saw it */ });
  res.on('finish', () => { if (res.body === null) res.ended = Buffer.concat(chunks); });
  res.received = () => Buffer.concat(chunks);
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => {
    if (res.headersSent) throw new Error('response written twice');
    res.body = p; res.headersSent = true;
    Writable.prototype.end.call(res);
    return res;
  };
  res.set = () => res;
  res.setHeader = (k, v) => {
    if (res.headersSent) throw new Error('header after send');
    // Node refuses a CR or LF in a header value with ERR_INVALID_CHAR; the
    // fake refuses it too, so a filename cannot split a header here either.
    if (/[\r\n]/.test(String(v))) throw new Error('invalid header char in ' + k);
    res.headers[k.toLowerCase()] = String(v);
    return res;
  };
  res.getHeader = (k) => res.headers[k.toLowerCase()];
  res.setTimeout = (ms, cb) => { res.timeout = { ms, cb }; return res; };
  return res;
}

// Starts one request and hands back the response while it is still in flight.
function start(r, routePath, world, opts) {
  const o = opts || {};
  global.__takeoffWorld = world;
  const layer = r.stack.find((l) => l.route && l.route.path === routePath && l.route.methods.get);
  if (!layer) throw new Error('GET ' + routePath + ' not found');
  const res = fakeRes();
  const req = { params: { token: o.token || TOKEN }, body: {}, headers: {}, ip: o.ip, get: () => 'project86.test' };
  const done = (async () => {
    for (const h of layer.route.stack.map((s) => s.handle)) {
      let advanced = false;
      await h(req, res, () => { advanced = true; });
      if (!advanced) break;
    }
    return res;
  })();
  return { res, done };
}

async function run(r, routePath, world, token) {
  return start(r, routePath, world, { token }).done;
}

// ── crew_takeoff rows, as the office's PUT writes them ───────────────────
// The lines a spreadsheet's copy is built from.
const COPY_LINES = [
  { description: 'Drip edge 10 ft', qty: '20', unit: 'pc' },
  { description: 'Synthetic underlayment', qty: '6', unit: 'roll' },
];
const row = (attachmentId, kind, extra) => Object.assign({
  attachment_id: attachmentId, filename: 'whatever it was called', kind: kind,
  set_at: '2026-09-13T12:00:00.000Z', set_by: 10, copy: null, copy_problem: null,
}, extra || {});
// A PDF or photo: never read, no copy.
const fileRow = (attachmentId, kind) => row(attachmentId, kind || 'pdf');
// A spreadsheet the PUT read. lines null is a copy it could not make.
const sheetRow = (attachmentId, kind, lines) => row(attachmentId, kind || 'xlsx', lines === null
  ? { copy: null, copy_problem: 'Lead Report.xlsx does not look like a takeoff.' }
  : { copy: { lines: lines || COPY_LINES, sheet: 'Takeoff', method: 'sheet', made_at: '2026-09-14T09:00:00.000Z' } });
// A row stored before copies existed: has_prices, and no copy key at all.
const legacyRow = (attachmentId, kind, hasPrices) => ({
  attachment_id: attachmentId, filename: 'whatever it was called', kind: kind,
  has_prices: hasPrices, set_at: '2026-09-13T12:00:00.000Z', set_by: 10,
});

const read = (r, opts) => run(r, '/service-ticket-share/:token', makeWorld(opts));
const open = (r, opts) => {
  const world = makeWorld(opts);
  return run(r, '/service-ticket-share/:token/takeoff', world).then((res) => Object.assign(res, { world }));
};
const DEFAULT_LINK = { hide_financials: true };
const FINANCIAL_LINK = { hide_financials: false };
const touchedAttachments = (world) => world.log.some((q) => /FROM attachments WHERE id/i.test(q.sql));
const NO_TAKEOFF = [404, { error: 'There is no takeoff file on this work order.' }];
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const COPY_CSP = "default-src 'none'; sandbox";
const copyCard = (filename, lines) => ({ filename, kind: 'xlsx', size_bytes: null, copy: true, lines });
const originalCard = (filename, kind, size) => ({ filename, kind, size_bytes: size || 4096, copy: false, lines: null });

/* ═══════════════════════════════════════════════════════════════════════════
 * THE CARD — GET /service-ticket-share/:token
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the link read carries a takeoff only when this link may show it', () => {
  test('nothing chosen: takeoff is null, the attachments table is never read, and no copy is built', async () => {
    const world = makeWorld();
    const res = await run(router, '/service-ticket-share/:token', world);
    expect(res.statusCode).toBe(200);
    expect(res.body.takeoff).toBeNull();
    expect(touchedAttachments(world)).toBe(false);
    expect(mockBuild).not.toHaveBeenCalled();
  });

  test('a spreadsheet on a default link is the PRICE-FREE COPY: the builder\'s name, copy true, a line count — nothing else', async () => {
    const world = makeWorld({ ticket: { crew_takeoff: sheetRow('a_xlsx') }, share: DEFAULT_LINK });
    const res = await run(router, '/service-ticket-share/:token', world);
    expect(res.statusCode).toBe(200);
    expect(res.body.takeoff).toEqual(copyCard('Materials - Lead Report.xlsx', 2));
    // Built from the stored lines, named from the file as it is now.
    expect(mockBuild.mock.calls).toEqual([[{ lines: COPY_LINES, sourceName: 'Lead Report.xlsx' }]]);
    // The original is never opened — but the file is still re-proved.
    expect(fetched()).toBe(0);
    expect(touchedAttachments(world)).toBe(true);
    const json = JSON.stringify(res.body);
    expect(json).not.toMatch(/a_xlsx|orig\/|PUBLIC-STORAGE-URL|attachment_id|has_prices|set_by|copy_problem|made_at|Drip edge|Synthetic|4096/);
    // crew_takeoff itself is not in publicTicket's whitelist.
    expect(res.body.ticket).not.toHaveProperty('crew_takeoff');
  });

  test('the same for a CSV, an .xls and a lead\'s xlsx that carry a copy', async () => {
    for (const [id, kind, name] of [
      ['a_csv', 'csv', 'Materials - pull sheet.xlsx'],
      ['a_xls', 'xls', 'Materials - Estimate.xlsx'],
      ['a_lead', 'xlsx', 'Materials - lead-takeoff.xlsx'],
    ]) {
      const res = await read(router, { ticket: { crew_takeoff: sheetRow(id, kind) }, share: DEFAULT_LINK });
      expect({ id, takeoff: res.body.takeoff }).toEqual({ id, takeoff: copyCard(name, 2) });
    }
    expect(fetched()).toBe(0);
  });

  test('on a link sent WITH financial details a spreadsheet is the ORIGINAL — and no copy is built', async () => {
    for (const ct of [sheetRow('a_xlsx'), sheetRow('a_xlsx', 'xlsx', null), legacyRow('a_xlsx', 'xlsx', true), legacyRow('a_xlsx', 'xlsx', false)]) {
      const res = await read(router, { ticket: { crew_takeoff: ct }, share: FINANCIAL_LINK });
      expect(res.body.takeoff).toEqual(originalCard('Lead Report.xlsx', 'xlsx'));
    }
    const xls = await read(router, { ticket: { crew_takeoff: legacyRow('a_xls', 'xls', null) }, share: FINANCIAL_LINK });
    expect(xls.body.takeoff).toEqual(originalCard('Estimate.xls', 'xls'));
    expect(mockBuild).not.toHaveBeenCalled();
  });

  test('a spreadsheet with NO copy stays off a default link — copy null, or a row stored before copies — decided before any lookup', async () => {
    const noCopy = [
      sheetRow('a_xlsx', 'xlsx', null),
      sheetRow('a_xlsx', 'xlsx', []),
      sheetRow('a_xlsx', 'xlsx', [{ description: '   ', qty: '1' }, null]),
      row('a_xlsx', 'xlsx', { copy: 'Drip edge, 20' }),
      row('a_xlsx', 'xlsx', { copy: { lines: 'Drip edge' } }),
      // Rows stored before this change, whatever their price verdict said.
      legacyRow('a_xlsx', 'xlsx', false),
      legacyRow('a_xls', 'xls', null),
      legacyRow('a_csv', 'csv', true),
    ];
    for (const ct of noCopy) {
      const world = makeWorld({ ticket: { crew_takeoff: ct }, share: DEFAULT_LINK });
      const res = await run(router, '/service-ticket-share/:token', world);
      expect({ ct, status: res.statusCode, takeoff: res.body.takeoff, looked: touchedAttachments(world) })
        .toEqual({ ct, status: 200, takeoff: null, looked: false });
    }
    // A share row with hide_financials missing is a default link too.
    const res = await read(router, { ticket: { crew_takeoff: legacyRow('a_xlsx', 'xlsx', false) }, share: { hide_financials: undefined } });
    expect(res.body.takeoff).toBeNull();
    expect(mockBuild).not.toHaveBeenCalled();
    expect(fetched()).toBe(0);
  });

  test('a stored kind that is not exactly "pdf" or "image" is a spreadsheet: no card on a default link, the original on a financial one', async () => {
    for (const kind of [undefined, null, 'PDF', 'doc', 'spreadsheet']) {
      const ct = row('a_pdf', kind);
      if (kind === undefined) delete ct.kind;
      const def = await read(router, { ticket: { crew_takeoff: ct }, share: DEFAULT_LINK });
      expect({ kind, takeoff: def.body.takeoff }).toEqual({ kind, takeoff: null });
      const fin = await read(router, { ticket: { crew_takeoff: ct }, share: FINANCIAL_LINK });
      expect({ kind, takeoff: fin.body.takeoff }).toEqual({ kind, takeoff: originalCard('Field takeoff.pdf', 'pdf') });
    }
  });

  test('decided again on the file as it is NOW: a "PDF" whose file is now an .xlsx is no card; a copied sheet renamed .pdf stays the copy', async () => {
    // Chosen as a PDF, the file is now a spreadsheet: there is no copy of it.
    const asPdf = await read(router, { ticket: { crew_takeoff: fileRow('a_xlsx', 'pdf') }, share: DEFAULT_LINK });
    expect(asPdf.body.takeoff).toBeNull();
    // Chosen as a spreadsheet and copied, the file is now named .pdf: still the
    // copy, never the workbook's bytes under a PDF's name.
    const renamed = await read(router, { ticket: { crew_takeoff: sheetRow('a_renamed', 'xlsx') }, share: DEFAULT_LINK });
    expect(renamed.body.takeoff).toEqual(copyCard('Materials - Lead Report.xlsx', 2));
    expect(fetched()).toBe(0);
  });

  test('a PDF or photo is the ORIGINAL on both kinds of link — and so is one stored before copies', async () => {
    for (const share of [DEFAULT_LINK, FINANCIAL_LINK]) {
      const pdf = await read(router, { ticket: { crew_takeoff: fileRow('a_pdf') }, share });
      expect(pdf.body.takeoff).toEqual(originalCard('Field takeoff.pdf', 'pdf'));
      const png = await read(router, { ticket: { crew_takeoff: fileRow('a_png', 'image') }, share });
      expect(png.body.takeoff).toEqual(originalCard('pull sheet photo.png', 'image'));
      const legacy = await read(router, { ticket: { crew_takeoff: legacyRow('a_pdf', 'pdf', null) }, share });
      expect(legacy.body.takeoff).toEqual(originalCard('Field takeoff.pdf', 'pdf'));
    }
    expect(mockBuild).not.toHaveBeenCalled();
  });

  test('the job\'s lead and the estimate it was sold from are the ticket\'s files too', async () => {
    const lead = await read(router, { ticket: { crew_takeoff: sheetRow('a_lead') } });
    expect(lead.body.takeoff).toEqual(copyCard('Materials - lead-takeoff.xlsx', 2));
    const est = await read(router, { ticket: { crew_takeoff: fileRow('a_est') } });
    expect(est.body.takeoff).toMatchObject({ filename: 'T5 pull sheet.pdf', kind: 'pdf', copy: false });
  });

  test('a file removed from the job, moved to another job, or never on it stops showing — the COPY too, and nothing is built', async () => {
    for (const ct of [fileRow('a_deleted'), sheetRow('a_deleted'), fileRow('a_other_job'), sheetRow('a_other_job')]) {
      expect({ ct, takeoff: (await read(router, { ticket: { crew_takeoff: ct } })).body.takeoff }).toEqual({ ct, takeoff: null });
    }
    for (const [id, ct] of [['a_pdf', fileRow('a_pdf')], ['a_xlsx', sheetRow('a_xlsx')]]) {
      const moved = await read(router, {
        ticket: { crew_takeoff: ct },
        mutateWorld: (w) => { w.attachments.find((a) => a.id === id).entity_id = 'j2'; },
      });
      expect({ id, takeoff: moved.body.takeoff }).toEqual({ id, takeoff: null });
    }
    expect(mockBuild).not.toHaveBeenCalled();
  });

  test('another tenant\'s lead named by the job contributes nothing, on either kind of link', async () => {
    for (const share of [DEFAULT_LINK, FINANCIAL_LINK]) {
      const res = await read(router, { ticket: { job_id: 'j3', crew_takeoff: sheetRow('a_rival_lead') }, share });
      expect(res.body.takeoff).toBeNull();
    }
    expect(mockBuild).not.toHaveBeenCalled();
  });

  test('a file renamed to something that is not a takeoff stops showing — copied or not', async () => {
    for (const ct of [fileRow('a_docx'), sheetRow('a_docx')]) {
      expect((await read(router, { ticket: { crew_takeoff: ct } })).body.takeoff).toBeNull();
    }
  });

  test('a LEAD ticket shows a file on its own lead', async () => {
    const res = await read(router, { ticket: { job_id: null, lead_id: 'l1', crew_takeoff: sheetRow('a_lead') } });
    expect(res.body.takeoff).toEqual(copyCard('Materials - lead-takeoff.xlsx', 2));
  });

  test('the stored lines are re-shaped before the builder sees them: three strings a line, at most 100', async () => {
    const lines = [{ description: '', qty: '1', unit: 'ea' }, { description: 'Coil nails', qty: 12, unit: 'box', unit_cost: '$45.00' }];
    for (let i = 0; i < 150; i++) lines.push({ description: 'Line ' + i, qty: String(i), unit: 'ea' });
    const res = await read(router, { ticket: { crew_takeoff: sheetRow('a_xlsx', 'xlsx', lines) } });
    expect(res.body.takeoff).toEqual(copyCard('Materials - Lead Report.xlsx', 100));
    const given = mockBuild.mock.calls[0][0].lines;
    expect(given).toHaveLength(100);
    expect(given[0]).toEqual({ description: 'Coil nails', qty: '12', unit: 'box' });
    expect(given.every((l) => Object.keys(l).sort().join() === 'description,qty,unit')).toBe(true);
  });

  test('a failure looking the file up, or a copy that will not build, costs the card — never the work order', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await read(router, { ticket: { crew_takeoff: fileRow('a_pdf') }, throwOn: /FROM attachments WHERE id/i });
      expect(res.statusCode).toBe(200);
      expect(res.body.ticket.title).toBe('Re-roof punch list');
      expect(res.body.takeoff).toBeNull();

      for (const broken of [
        async () => { throw new Error('exceljs fell over'); },
        async () => ({ buffer: Buffer.alloc(0), filename: 'Materials - x.xlsx' }),
        async () => null,
      ]) {
        mockBuild.mockImplementationOnce(broken);
        const built = await read(router, { ticket: { crew_takeoff: sheetRow('a_xlsx') } });
        expect([built.statusCode, built.body.ticket.title, built.body.takeoff]).toEqual([200, 'Re-roof punch list', null]);
      }
    } finally {
      spy.mockRestore();
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE BYTES — GET /service-ticket-share/:token/takeoff
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the takeoff door serves the chosen file, or its price-free copy, through the token', () => {
  const SECURITY = {
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-robots-tag': 'noindex, nofollow',
  };

  test('a spreadsheet on a default link downloads the COPY: an xlsx attachment under the sandbox CSP — the original is never opened', async () => {
    const res = await open(router, { ticket: { crew_takeoff: sheetRow('a_xlsx') }, share: DEFAULT_LINK });
    expect(res.statusCode).toBe(200);
    expect(res.ended).toEqual(copyBytes(2));
    expect(res.headers).toMatchObject(Object.assign({
      'content-type': XLSX_TYPE,
      'content-length': String(copyBytes(2).length),
      'content-disposition': 'attachment; filename="Materials - Lead Report.xlsx"; filename*=UTF-8\'\'Materials%20-%20Lead%20Report.xlsx',
      'content-security-policy': COPY_CSP,
    }, SECURITY));
    expect(mockBuild.mock.calls).toEqual([[{ lines: COPY_LINES, sourceName: 'Lead Report.xlsx' }]]);
    expect(mockGetStream).not.toHaveBeenCalled();
    expect(mockGetBuffer).not.toHaveBeenCalled();
    // Nothing of the original's reaches the response.
    expect(res.received().toString('latin1')).not.toMatch(/Unit Cost|\$45/);
  });

  test('a CSV and an .xls with a copy download the copy too, as an xlsx', async () => {
    for (const [id, kind, name] of [['a_csv', 'csv', 'Materials - pull sheet.xlsx'], ['a_xls', 'xls', 'Materials - Estimate.xlsx']]) {
      const res = await open(router, { ticket: { crew_takeoff: sheetRow(id, kind) }, share: DEFAULT_LINK });
      expect({ id, status: res.statusCode, type: res.headers['content-type'], csp: res.headers['content-security-policy'] })
        .toEqual({ id, status: 200, type: XLSX_TYPE, csp: COPY_CSP });
      expect(res.headers['content-disposition']).toMatch(new RegExp('^attachment; filename="' + name.replace(/\./g, '\\.') + '"'));
      expect(res.ended).toEqual(copyBytes(2));
    }
    expect(fetched()).toBe(0);
  });

  test('the copy\'s name is sanitised like any other, and a builder that names nothing gives "Materials.xlsx"', async () => {
    mockBuild.mockImplementationOnce(async () => ({
      buffer: copyBytes(2),
      filename: 'Materials - Bid "final"' + String.fromCharCode(13, 10) + 'Set-Cookie: x=1.xlsx',
    }));
    const res = await open(router, { ticket: { crew_takeoff: sheetRow('a_xlsx') } });
    expect(res.statusCode).toBe(200);
    const cd = res.headers['content-disposition'];
    expect(/^[\x20-\x7E]+$/.test(cd)).toBe(true);
    expect(/filename="([^"]*)"/.exec(cd)[1]).toBe('Materials - Bid _final_ Set-Cookie: x=1.xlsx');
    expect(Object.keys(res.headers)).not.toContain('set-cookie');

    mockBuild.mockImplementationOnce(async () => ({ buffer: copyBytes(2), filename: '  ' }));
    const unnamed = await open(router, { ticket: { crew_takeoff: sheetRow('a_xlsx') } });
    expect(unnamed.headers['content-disposition']).toMatch(/^attachment; filename="Materials\.xlsx"/);
  });

  test('a PDF opens inline with every no-store / no-sniff header, and NO CSP (a sandbox blanks Chrome\'s viewer)', async () => {
    const res = await open(router, { ticket: { crew_takeoff: fileRow('a_pdf') } });
    expect(res.statusCode).toBe(200);
    expect(res.ended).toEqual(PDF);
    expect(mockGetStream.mock.calls).toEqual([['orig/a_pdf']]);
    expect(mockGetBuffer).not.toHaveBeenCalled();
    expect(mockBuild).not.toHaveBeenCalled();
    expect(res.headers).toMatchObject(Object.assign({
      'content-type': 'application/pdf',
      'content-length': String(PDF.length),
      'content-disposition': 'inline; filename="Field takeoff.pdf"; filename*=UTF-8\'\'Field%20takeoff.pdf',
    }, SECURITY));
    // Served inline only because its BYTES are a PDF; the viewer needs what a CSP would deny.
    expect(res.headers['content-security-policy']).toBeUndefined();
  });

  test('an xlsx on a FINANCIAL link downloads the original spreadsheet, never inline, and no copy is built', async () => {
    for (const ct of [sheetRow('a_xlsx'), legacyRow('a_xlsx', 'xlsx', true)]) {
      const res = await open(router, { ticket: { crew_takeoff: ct }, share: FINANCIAL_LINK });
      expect(res.statusCode).toBe(200);
      expect(res.ended).toEqual(XLSX);
      expect(res.headers['content-type']).toBe(XLSX_TYPE);
      expect(res.headers['content-disposition']).toMatch(/^attachment; filename="Lead Report\.xlsx"/);
      expect(res.headers['content-security-policy']).toMatch(/sandbox/);
      expect(res.headers).toMatchObject(SECURITY);
    }
    expect(mockGetStream.mock.calls).toEqual([['orig/a_xlsx'], ['orig/a_xlsx']]);
    expect(mockBuild).not.toHaveBeenCalled();
  });

  test('a CSV and an old .xls on a FINANCIAL link download as themselves', async () => {
    const csv = await open(router, { ticket: { crew_takeoff: sheetRow('a_csv', 'csv') }, share: FINANCIAL_LINK });
    expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(csv.headers['content-disposition']).toMatch(/^attachment;/);
    expect(csv.ended).toEqual(CSV);
    const xls = await open(router, { ticket: { crew_takeoff: sheetRow('a_xls', 'xls', null) }, share: FINANCIAL_LINK });
    expect(xls.statusCode).toBe(200);
    expect(xls.headers['content-type']).toBe('application/vnd.ms-excel');
    expect(xls.headers['content-disposition']).toMatch(/^attachment; filename="Estimate\.xls"/);
    expect(xls.ended).toEqual(XLS);
  });

  test('a photo\'s type comes from its bytes; bytes that are not a photo download opaque', async () => {
    const png = await open(router, { ticket: { crew_takeoff: fileRow('a_png', 'image') } });
    expect([png.headers['content-type'], png.headers['content-disposition'].split(';')[0]]).toEqual(['image/png', 'inline']);
    expect(png.headers['content-security-policy']).toBe("default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    const html = await open(router, { ticket: { crew_takeoff: fileRow('a_fakejpg', 'image') } });
    expect([html.headers['content-type'], html.headers['content-disposition'].split(';')[0]]).toEqual(['application/octet-stream', 'attachment']);
    expect(html.headers).toMatchObject(SECURITY);
  });

  test('a ".pdf" that does not start like a PDF is not rendered either', async () => {
    const res = await open(router, { ticket: { crew_takeoff: fileRow('a_fakepdf') } });
    expect([res.headers['content-type'], res.headers['content-disposition'].split(';')[0]]).toEqual(['application/octet-stream', 'attachment']);
  });

  test('a filename with quotes, a CR/LF and non-ASCII cannot break or add a header', async () => {
    const res = await open(router, { ticket: { crew_takeoff: fileRow('a_weird') } });
    expect(res.statusCode).toBe(200);
    const cd = res.headers['content-disposition'];
    expect(cd).not.toMatch(/[\r\n]/);
    expect(cd).toMatch(/[\x20-\x7E]*/);
    expect(/^[\x20-\x7E]+$/.test(cd)).toBe(true);
    const plain = /filename="([^"]*)"/.exec(cd)[1];
    expect(plain).toBe('Bid _final_ Set-Cookie: x=1 _ Caf_.pdf');
    const star = /filename\*=UTF-8''(.+)$/.exec(cd)[1];
    expect(decodeURIComponent(star)).toBe('Bid "final"  Set-Cookie: x=1 \u2014 Caf\u00e9.pdf');
    expect(star).toContain('%C3%A9');
    expect(star).not.toMatch(/['()*\s"]/);
    expect(Object.keys(res.headers)).not.toContain('set-cookie');
  });

  test('a spreadsheet with no copy on a default link is the no-takeoff 404: no lookup, no fetch, no build', async () => {
    for (const ct of [sheetRow('a_xlsx', 'xlsx', null), legacyRow('a_xlsx', 'xlsx', false), legacyRow('a_xls', 'xls', null), sheetRow('a_xls', 'xls', null)]) {
      const res = await open(router, { ticket: { crew_takeoff: ct }, share: DEFAULT_LINK });
      expect({ ct, a: [res.statusCode, res.body], looked: touchedAttachments(res.world) }).toEqual({ ct, a: NO_TAKEOFF, looked: false });
    }
    expect(fetched()).toBe(0);
    expect(mockBuild).not.toHaveBeenCalled();
  });

  test('nothing chosen, or a file no longer on the job, is the same 404 without a fetch or a build — copy or not', async () => {
    for (const ct of [null, fileRow('a_other_job'), fileRow('a_deleted'), sheetRow('a_other_job'), sheetRow('a_deleted')]) {
      const res = await open(router, { ticket: { crew_takeoff: ct } });
      expect({ ct, a: [res.statusCode, res.body] }).toEqual({ ct, a: NO_TAKEOFF });
    }
    const moved = await open(router, {
      ticket: { crew_takeoff: sheetRow('a_xlsx') },
      mutateWorld: (w) => { w.attachments.find((a) => a.id === 'a_xlsx').entity_id = 'j2'; },
    });
    expect([moved.statusCode, moved.body]).toEqual(NO_TAKEOFF);
    expect(fetched()).toBe(0);
    expect(mockBuild).not.toHaveBeenCalled();
  });

  test('over 25 MB is the no-takeoff 404 before the fetch; storage holding more than the cap is 413', async () => {
    // crewTakeoffFor refuses a file the door would refuse, so the page never
    // offers it and the door answers as if nothing was chosen.
    const big = await open(router, { ticket: { crew_takeoff: fileRow('a_big') } });
    expect([big.statusCode, big.body]).toEqual(NO_TAKEOFF);
    expect(fetched()).toBe(0);

    // The stored size is a claim written at upload time; storage saying the
    // object is bigger than the cap is refused before a header goes out.
    mockGetStream.mockImplementation(async () => ({ stream: Readable.from([PDF]), size: MAX_FILE_BYTES + 1 }));
    const lied = await open(router, { ticket: { crew_takeoff: fileRow('a_pdf') } });
    expect([lied.statusCode, lied.body]).toEqual([413, { error: 'That file is too large to open here — ask the office for it.' }]);
    expect(lied.ended).toBeNull();
    expect(lied.headers['content-length']).toBeUndefined();
  });

  test('the cap is the ORIGINAL\'s: an over-cap spreadsheet with a copy is its copy on a default link, and nothing on a financial one', async () => {
    const def = await open(router, { ticket: { crew_takeoff: sheetRow('a_bigsheet') }, share: DEFAULT_LINK });
    expect([def.statusCode, def.headers['content-type'], def.ended]).toEqual([200, XLSX_TYPE, copyBytes(2)]);
    const fin = await open(router, { ticket: { crew_takeoff: sheetRow('a_bigsheet') }, share: FINANCIAL_LINK });
    expect([fin.statusCode, fin.body]).toEqual(NO_TAKEOFF);
    expect(fetched()).toBe(0);
  });

  test('a revoked or expired link is 410 before the ticket is read — copy or original; a malformed token costs no query', async () => {
    for (const ct of [fileRow('a_pdf'), sheetRow('a_xlsx')]) {
      for (const share of [{ revoked_at: '2026-09-12T00:00:00Z' }, { expires_at: new Date(Date.now() - 1000).toISOString() }]) {
        const res = await open(router, { share, ticket: { crew_takeoff: ct } });
        expect(res.statusCode).toBe(410);
        expect(res.world.log.some((q) => /FROM service_tickets/i.test(q.sql))).toBe(false);
        const card = await read(router, { share, ticket: { crew_takeoff: ct } });
        expect(card.statusCode).toBe(410);
      }
    }
    const world = makeWorld({ ticket: { crew_takeoff: sheetRow('a_xlsx') } });
    const bad = await run(router, '/service-ticket-share/:token/takeoff', world, 'nope');
    expect(bad.statusCode).toBe(404);
    expect(world.log).toHaveLength(0);
    expect(fetched()).toBe(0);
    expect(mockBuild).not.toHaveBeenCalled();
  });

  test('a storage failure is a plain 500, never the error text', async () => {
    mockGetStream.mockImplementation(async () => { throw new Error('R2 NoSuchKey orig/a_pdf bucket=secret'); });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await open(router, { ticket: { crew_takeoff: fileRow('a_pdf') } });
      expect([res.statusCode, res.body]).toEqual([500, { error: 'Something went wrong opening that file.' }]);
    } finally {
      spy.mockRestore();
    }
  });

  test('a copy that will not build is a plain 500 with no header of the copy\'s, and never the original instead', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const broken of [
        async () => { throw new Error('exceljs exploded at /srv/secret'); },
        async () => ({ buffer: Buffer.alloc(0), filename: 'Materials - x.xlsx' }),
        async () => ({ buffer: 'not bytes', filename: 'Materials - x.xlsx' }),
      ]) {
        mockBuild.mockImplementationOnce(broken);
        const res = await open(router, { ticket: { crew_takeoff: sheetRow('a_xlsx') } });
        expect([res.statusCode, res.body]).toEqual([500, { error: 'Something went wrong opening that file.' }]);
        expect(res.headers['content-disposition']).toBeUndefined();
      }
    } finally {
      spy.mockRestore();
    }
    expect(fetched()).toBe(0);
    // ...and the slot is back.
    expect((await open(router, { ticket: { crew_takeoff: sheetRow('a_xlsx') } })).statusCode).toBe(200);
  });

  test('opening the file, or its copy, records nothing and writes nothing', async () => {
    for (const ct of [fileRow('a_pdf'), sheetRow('a_xlsx')]) {
      const res = await open(router, { ticket: { crew_takeoff: ct } });
      expect(res.statusCode).toBe(200);
      expect(res.world.log.filter((q) => /^(INSERT|UPDATE|DELETE)\b/i.test(q.sql))).toEqual([]);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE REAL BUILDER, through the door — only once materials-extract exports
 * buildMaterialsCopy (its own suite pins its rules). The door must hand the
 * crew a workbook a spreadsheet program opens, holding only strings.
 * ══════════════════════════════════════════════════════════════════════════*/
const REAL_BUILD = typeof realExtract.buildMaterialsCopy === 'function';
describe('the copy the crew downloads, with the real builder', () => {
  (REAL_BUILD ? test : test.skip)('opens as an xlsx: Material | Qty | Unit, every cell a string, a formula-looking line kept as text', async () => {
    mockBuild.mockImplementation((o) => realExtract.buildMaterialsCopy(o));
    const lines = [
      { description: '=HYPERLINK("http://example.test","Drip edge")', qty: '20', unit: 'pc' },
      { description: 'Synthetic underlayment', qty: '6', unit: 'roll' },
    ];
    const res = await open(router, { ticket: { crew_takeoff: sheetRow('a_xlsx', 'xlsx', lines) } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="Materials - Lead Report\.xlsx"/);
    const ExcelJS = jest.requireActual('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.ended);
    const ws = wb.getWorksheet('Materials');
    expect(ws).toBeTruthy();
    const rows = [];
    let formulas = 0;
    let nonStrings = 0;
    ws.eachRow({ includeEmpty: false }, (r) => {
      const cells = [];
      r.eachCell({ includeEmpty: false }, (c) => {
        if (c.formula || c.type === ExcelJS.ValueType.Formula) formulas += 1;
        if (typeof c.value !== 'string') nonStrings += 1;
        cells.push(c.value);
      });
      rows.push(cells);
    });
    expect(formulas).toBe(0);
    expect(nonStrings).toBe(0);
    expect(rows).toContainEqual(['Material', 'Qty', 'Unit']);
    expect(rows).toContainEqual(['=HYPERLINK("http://example.test","Drip edge")', '20', 'pc']);
    expect(rows).toContainEqual(['Synthetic underlayment', '6', 'roll']);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * NO FILE HELD IN MEMORY — the door pipes the stored object, one download per
 * link and per address. The finding: every GET read up to 25 MB whole
 * (getBuffer; twice that on R2), with no in-flight limit, so sixty downloads
 * started at once from one address — inside the 60-a-minute IP limiter — held
 * about 1.5 GB on the one replica.
 * ══════════════════════════════════════════════════════════════════════════*/
function gate() {
  let open;
  const shut = new Promise((resolve) => { open = resolve; });
  return { shut, open };
}

async function until(cond, what) {
  for (let i = 0; i < 5000 && !cond(); i++) await new Promise((r) => setImmediate(r));
  if (!cond()) throw new Error('never happened: ' + (what || 'condition'));
}

const BUSY = [429, { error: 'This file is already downloading — try again in a moment.' }];
const DOOR = '/service-ticket-share/:token/takeoff';
const answer = (r) => [r.statusCode, r.body];

describe('the takeoff door streams, and holds one download per link and per address', () => {
  test('the bytes go on as storage yields them: headers and the first chunk leave before storage has finished', async () => {
    const feed = handFed();
    mockGetStream.mockImplementation(async () => ({ stream: feed.stream, size: PDF.length }));
    const world = makeWorld({ ticket: { crew_takeoff: fileRow('a_pdf') } });
    const req = start(router, DOOR, world, { ip: '203.0.113.7' });
    await until(() => mockGetStream.mock.calls.length === 1, 'storage opened');

    feed.push(PDF.subarray(0, 2048));
    await until(() => req.res.received().length === 2048, 'first chunk sent');
    // In flight: the response has the headers and half the file, and storage
    // has not been asked for the rest — nothing waited for the whole file.
    expect(req.res.headers['content-type']).toBe('application/pdf');
    expect(req.res.headers['content-length']).toBe('4096');
    expect(req.res.ended).toBeNull();

    feed.push(PDF.subarray(2048));
    feed.end();
    const res = await req.done;
    expect(res.statusCode).toBe(200);
    expect(res.ended).toEqual(PDF);
    expect(mockGetBuffer).not.toHaveBeenCalled();
  });

  test('the finding: sixty downloads started at once from one address open storage ONCE; fifty-nine are the busy 429', async () => {
    const feed = handFed();
    mockGetStream.mockImplementationOnce(async () => ({ stream: feed.stream, size: PDF.length }));
    const world = makeWorld({ ticket: { crew_takeoff: fileRow('a_pdf') } });
    const reqs = [];
    for (let i = 0; i < 60; i++) reqs.push(start(router, DOOR, world, { ip: '198.51.100.20' }));
    await until(() => mockGetStream.mock.calls.length === 1 && reqs.filter((r) => r.res.body).length === 59, 'fifty-nine refusals');

    const refused = reqs.filter((r) => r.res.body);
    expect(refused.map((r) => [r.res.statusCode, r.res.body])).toEqual(Array(59).fill(BUSY));
    // Refused before the storage fetch, and no header of the file's.
    expect(refused.every((r) => r.res.headers['content-length'] === undefined)).toBe(true);
    expect(mockGetStream).toHaveBeenCalledTimes(1);

    feed.push(PDF);
    feed.end();
    const results = await Promise.all(reqs.map((r) => r.done));
    expect(results.filter((r) => r.statusCode === 200 && r.ended && r.ended.equals(PDF))).toHaveLength(1);

    // The slot is back once that download finished.
    const next = await start(router, DOOR, world, { ip: '198.51.100.20' }).done;
    expect([next.statusCode, next.ended && next.ended.equals(PDF)]).toEqual([200, true]);
  });

  test('one per LINK across addresses, and one per ADDRESS across links', async () => {
    const feed = handFed();
    mockGetStream.mockImplementationOnce(async () => ({ stream: feed.stream, size: PDF.length }));
    const world = makeWorld({
      ticket: { crew_takeoff: fileRow('a_pdf') },
      mutateWorld: (w) => {
        w.otherShares = [Object.assign({}, w.share, { id: 'stshare_2', token_hash: svc.hashToken(TOKEN_2) })];
      },
    });
    const first = start(router, DOOR, world, { ip: '192.0.2.1' });
    await until(() => mockGetStream.mock.calls.length === 1, 'first download open');

    // The same link from another address.
    expect(answer(await start(router, DOOR, world, { ip: '192.0.2.99' }).done)).toEqual(BUSY);
    // Another link from the same address.
    expect(answer(await start(router, DOOR, world, { ip: '192.0.2.1', token: TOKEN_2 }).done)).toEqual(BUSY);
    expect(mockGetStream).toHaveBeenCalledTimes(1);
    // Another link from another address is not held up.
    const other = await start(router, DOOR, world, { ip: '192.0.2.99', token: TOKEN_2 }).done;
    expect(other.statusCode).toBe(200);
    expect(other.ended).toEqual(PDF);

    feed.push(PDF);
    feed.end();
    expect((await first.done).statusCode).toBe(200);
  });

  test('the COPY takes the same slots: one build per link and per address, and storage is never opened', async () => {
    const g = gate();
    let calls = 0;
    mockBuild.mockImplementation(async ({ lines }) => {
      calls += 1;
      if (calls === 1) await g.shut;
      return { buffer: copyBytes(lines.length), filename: 'Materials - Lead Report.xlsx' };
    });
    const world = makeWorld({
      ticket: { crew_takeoff: sheetRow('a_xlsx') },
      mutateWorld: (w) => {
        w.otherShares = [Object.assign({}, w.share, { id: 'stshare_2', token_hash: svc.hashToken(TOKEN_2) })];
      },
    });
    const first = start(router, DOOR, world, { ip: '192.0.2.31' });
    await until(() => mockBuild.mock.calls.length === 1, 'first build started');

    // The same link from another address, and another link from the same one.
    expect(answer(await start(router, DOOR, world, { ip: '192.0.2.32' }).done)).toEqual(BUSY);
    expect(answer(await start(router, DOOR, world, { ip: '192.0.2.31', token: TOKEN_2 }).done)).toEqual(BUSY);
    expect(mockBuild).toHaveBeenCalledTimes(1);
    // Another link from another address is not held up.
    const other = await start(router, DOOR, world, { ip: '192.0.2.32', token: TOKEN_2 }).done;
    expect([other.statusCode, other.ended]).toEqual([200, copyBytes(2)]);

    g.open();
    const done = await first.done;
    expect([done.statusCode, done.ended]).toEqual([200, copyBytes(2)]);
    // A copy reader that stops reading is on the same generous idle timer.
    expect(done.timeout.ms).toBeGreaterThanOrEqual(30 * 1000);
    expect(fetched()).toBe(0);
    // ...and the slots are back.
    expect((await start(router, DOOR, world, { ip: '192.0.2.31' }).done).statusCode).toBe(200);
  });

  test('a reader who goes away while the copy is being built gives the slot back', async () => {
    const g = gate();
    mockBuild.mockImplementationOnce(async ({ lines }) => { await g.shut; return { buffer: copyBytes(lines.length), filename: 'Materials.xlsx' }; });
    const world = makeWorld({ ticket: { crew_takeoff: sheetRow('a_xlsx') } });
    const req = start(router, DOOR, world, { ip: '192.0.2.33' });
    await until(() => mockBuild.mock.calls.length === 1, 'build started');
    req.res.destroy();
    g.open();
    const res = await req.done;
    expect(res.ended).toBeNull();
    const again = await start(router, DOOR, world, { ip: '192.0.2.33' }).done;
    expect([again.statusCode, again.ended]).toEqual([200, copyBytes(2)]);
  });

  test('a reader who goes away mid-download gives the slot back, and storage is let go', async () => {
    const feed = handFed();
    mockGetStream.mockImplementationOnce(async () => ({ stream: feed.stream, size: PDF.length }));
    const world = makeWorld({ ticket: { crew_takeoff: fileRow('a_pdf') } });
    const req = start(router, DOOR, world, { ip: '192.0.2.5' });
    await until(() => mockGetStream.mock.calls.length === 1, 'download open');
    feed.push(PDF.subarray(0, 2048));
    await until(() => req.res.received().length === 2048, 'first chunk sent');

    req.res.destroy();
    const res = await req.done;
    expect(res.ended).toBeNull();
    expect(feed.stream.destroyed).toBe(true);
    const again = await start(router, DOOR, world, { ip: '192.0.2.5' }).done;
    expect([again.statusCode, again.ended && again.ended.equals(PDF)]).toEqual([200, true]);
  });

  test('a reader who stops reading is cut off once the socket sits idle, and the slot comes back', async () => {
    const feed = handFed();
    mockGetStream.mockImplementationOnce(async () => ({ stream: feed.stream, size: PDF.length }));
    const world = makeWorld({ ticket: { crew_takeoff: fileRow('a_pdf') } });
    const req = start(router, DOOR, world, { ip: '192.0.2.6' });
    await until(() => mockGetStream.mock.calls.length === 1, 'download open');
    // Generous: a phone on one bar still moves a chunk well inside it.
    expect(req.res.timeout.ms).toBeGreaterThanOrEqual(30 * 1000);

    req.res.timeout.cb();                       // the socket's idle timer fires
    const res = await req.done;
    expect(res.destroyed).toBe(true);
    expect(res.ended).toBeNull();
    expect((await start(router, DOOR, world, { ip: '192.0.2.6' }).done).statusCode).toBe(200);
  });

  test('a storage failure gives the slot back', async () => {
    mockGetStream.mockImplementationOnce(async () => { throw new Error('R2 fell over'); });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const world = makeWorld({ ticket: { crew_takeoff: fileRow('a_pdf') } });
    try {
      expect(answer(await start(router, DOOR, world, { ip: '192.0.2.8' }).done))
        .toEqual([500, { error: 'Something went wrong opening that file.' }]);
    } finally {
      spy.mockRestore();
    }
    expect((await start(router, DOOR, world, { ip: '192.0.2.8' }).done).statusCode).toBe(200);
  });

  test('storage and the stored size disagree: refused before a header, and the stream is let go', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const feed = handFed();
      mockGetStream.mockImplementationOnce(async () => ({ stream: feed.stream, size: 5000 }));
      const res = await open(router, { ticket: { crew_takeoff: fileRow('a_pdf') } });
      expect(answer(res)).toEqual([500, { error: 'Something went wrong opening that file.' }]);
      expect(res.headers['content-length']).toBeUndefined();
      expect(feed.stream.destroyed).toBe(true);
    } finally {
      spy.mockRestore();
    }
    // ...and the slot is back.
    expect((await open(router, { ticket: { crew_takeoff: fileRow('a_pdf') } })).statusCode).toBe(200);
  });

  test('a stream that runs PAST the stored size, or ends SHORT of it, drops the response instead of finishing it', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // Storage reports no length (R2 without ContentLength), so only the count catches it.
      for (const body of [Buffer.concat([PDF, Buffer.from('extra')]), PDF.subarray(0, 4000)]) {
        mockGetStream.mockImplementationOnce(async () => ({ stream: Readable.from([body.subarray(0, 2048), body.subarray(2048)]), size: null }));
        const res = await open(router, { ticket: { crew_takeoff: fileRow('a_pdf') } });
        expect({ n: body.length, ended: res.ended, destroyed: res.destroyed }).toEqual({ n: body.length, ended: null, destroyed: true });
        // Never more on the wire than the Content-Length it named.
        expect(res.received().length).toBeLessThanOrEqual(4096);
      }
    } finally {
      spy.mockRestore();
    }
    expect((await open(router, { ticket: { crew_takeoff: fileRow('a_pdf') } })).statusCode).toBe(200);
  });

  test('the type is still decided from the first bytes when storage yields them a few at a time', async () => {
    const trickle = (buf, n) => {
      const parts = [];
      for (let i = 0; i < buf.length; i += n) parts.push(buf.subarray(i, i + n));
      return Readable.from(parts);
    };
    mockGetStream.mockImplementationOnce(async () => ({ stream: trickle(PDF, 3), size: PDF.length }));
    const pdf = await open(router, { ticket: { crew_takeoff: fileRow('a_pdf') } });
    expect([pdf.headers['content-type'], pdf.ended && pdf.ended.equals(PDF)]).toEqual(['application/pdf', true]);
    mockGetStream.mockImplementationOnce(async () => ({ stream: trickle(PNG, 5), size: PNG.length }));
    const png = await open(router, { ticket: { crew_takeoff: fileRow('a_png', 'image') } });
    expect([png.headers['content-type'], png.ended && png.ended.equals(PNG)]).toEqual(['image/png', true]);
  });

  test('a file smaller than the sniff window is typed from all of it and sent whole', async () => {
    const tiny = Buffer.from('%PDF-1.4\n%%EOF\n');
    mockGetStream.mockImplementationOnce(async () => ({ stream: Readable.from([tiny]), size: tiny.length }));
    const res = await open(router, {
      ticket: { crew_takeoff: fileRow('a_pdf') },
      mutateWorld: (w) => { w.attachments.find((a) => a.id === 'a_pdf').size_bytes = tiny.length; },
    });
    expect([res.statusCode, res.headers['content-type'], res.headers['content-length']]).toEqual([200, 'application/pdf', String(tiny.length)]);
    expect(res.ended).toEqual(tiny);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE SIZE CAP — an original the door cannot send is never offered. Uploads
 * allow 50 MB; a 38 MB plan set stored before the PUT refused one showed the
 * crew "Open the takeoff" and a 413 behind it on every attempt.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('an original over the crew link\'s cap is not offered', () => {
  test('the finding\'s 38 MB plan-set PDF: no card, the no-takeoff 404, no fetch', async () => {
    for (const share of [DEFAULT_LINK, FINANCIAL_LINK]) {
      const opts = { ticket: { crew_takeoff: fileRow('a_plans') }, share };
      const card = await read(router, opts);
      expect(card.statusCode).toBe(200);
      expect(card.body.takeoff).toBeNull();
      const door = await open(router, opts);
      expect([door.statusCode, door.body]).toEqual(NO_TAKEOFF);
    }
    expect(fetched()).toBe(0);
  });

  test('the cap is materials-extract\'s MAX_FILE_BYTES: exactly at it is offered, one byte over is not', async () => {
    expect(MAX_FILE_BYTES).toBe(25 * 1024 * 1024);
    const at = (size) => read(router, {
      ticket: { crew_takeoff: fileRow('a_pdf') },
      mutateWorld: (w) => { w.attachments.find((a) => a.id === 'a_pdf').size_bytes = size; },
    });
    expect((await at(MAX_FILE_BYTES)).body.takeoff).toEqual(originalCard('Field takeoff.pdf', 'pdf', MAX_FILE_BYTES));
    expect((await at(MAX_FILE_BYTES + 1)).body.takeoff).toBeNull();
    // A pg BIGINT arrives as a string, and is read the same way.
    expect((await at(String(MAX_FILE_BYTES + 1))).body.takeoff).toBeNull();
    expect((await at('4096')).body.takeoff).toMatchObject({ size_bytes: 4096 });
  });

  test('a row with no usable size is not offered: the door could not name a length for it', async () => {
    for (const size of [null, undefined, 'abc', -1, 1.5, Infinity]) {
      const res = await read(router, {
        ticket: { crew_takeoff: fileRow('a_pdf') },
        mutateWorld: (w) => { w.attachments.find((a) => a.id === 'a_pdf').size_bytes = size; },
      });
      expect({ size, takeoff: res.body.takeoff }).toEqual({ size, takeoff: null });
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE STORAGE BACKENDS' STREAMING READ — the real methods, not the mock.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('storage.getStream on both backends', () => {
  let real;
  let dir;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), '_p86_sto_disk_'));
    const prev = process.env.UPLOAD_DIR;
    process.env.UPLOAD_DIR = dir;                 // never the repo's own uploads/
    try {
      real = jest.requireActual('../server/storage');
    } finally {
      if (prev === undefined) delete process.env.UPLOAD_DIR; else process.env.UPLOAD_DIR = prev;
    }
  });
  afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* already gone */ } });

  const drain = async (stream) => {
    const parts = [];
    for await (const c of stream) parts.push(c);
    return Buffer.concat(parts);
  };

  test('local disk: the bytes and their size, from one open file; a missing key rejects', async () => {
    const disk = new real.LocalDiskStorage(dir, '/uploads');
    await disk.put(path.join('orig', 'a_pdf'), PDF);
    const got = await disk.getStream(path.join('orig', 'a_pdf'));
    expect(got.size).toBe(PDF.length);
    expect(await drain(got.stream)).toEqual(PDF);
    await expect(disk.getStream(path.join('orig', 'nope'))).rejects.toThrow();
  });

  test('R2: the S3 body handed on uncollected, with ContentLength (or null without one)', async () => {
    const body = Readable.from([Buffer.from('r2 bytes')]);
    const sent = [];
    const r2 = Object.create(real.R2Storage.prototype);
    r2.bucket = 'bucket';
    r2._GetObjectCommand = function GetObjectCommand(input) { this.input = input; };
    let reply = { Body: body, ContentLength: 8 };
    r2.client = { send: async (cmd) => { sent.push(cmd.input); return reply; } };

    const got = await r2.getStream('orig/a_pdf');
    expect(sent).toEqual([{ Bucket: 'bucket', Key: 'orig/a_pdf' }]);
    expect(got.stream).toBe(body);
    expect(got.size).toBe(8);

    reply = { Body: Readable.from([]) };
    expect((await r2.getStream('k')).size).toBeNull();
    reply = { Body: null };
    await expect(r2.getStream('k')).rejects.toThrow(/empty body/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * EACH GUARD, REMOVED
 * ══════════════════════════════════════════════════════════════════════════*/
function mutant(pairs) {
  const SOURCE = fs.readFileSync(SHARE_ROUTES, 'utf8');
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
  const dir = path.dirname(SHARE_ROUTES);
  out = out.replace(/require\((['"])([^'"]+)\1\)/g, (_m, _q, spec) => {
    const resolved = spec.charAt(0) === '.'
      ? require.resolve(path.resolve(dir, spec))
      : require.resolve(spec, { paths: [dir] });
    return 'require(' + JSON.stringify(resolved.split(path.sep).join('/')) + ')';
  });
  const p = path.join(os.tmpdir(), '_p86_sto_mutant_' + process.pid + '_' + Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, out, 'utf8');
  mutantPaths.push(p);
  return require(p);
}

describe('mutants', () => {
  test('the harness refuses an absent anchor', () => {
    expect(() => mutant([['this string is nowhere in the routes', 'x']])).toThrow(/ANCHOR NOT FOUND/);
  });

  test('serve the original on a default link and the priced spreadsheet goes to the crew instead of its copy', async () => {
    const MAY_SHOW = '  const originalMayShow = (kind) => !hides || ORIGINAL_ON_EVERY_LINK.has(kind);';
    const copied = { ticket: { crew_takeoff: sheetRow('a_xlsx') }, share: DEFAULT_LINK };
    const legacy = { ticket: { crew_takeoff: legacyRow('a_xlsx', 'xlsx', false) }, share: DEFAULT_LINK };
    const shipped = await open(router, copied);
    expect([shipped.statusCode, shipped.ended]).toEqual([200, copyBytes(2)]);
    expect((await open(router, legacy)).statusCode).toBe(404);
    expect(fetched()).toBe(0);

    const mut = mutant([[MAY_SHOW, '  const originalMayShow = (kind) => true;']]);
    const res = await open(mut, copied);
    expect([res.statusCode, res.ended]).toEqual([200, XLSX]);
    expect((await read(mut, copied)).body.takeoff).toEqual(originalCard('Lead Report.xlsx', 'xlsx'));
    const old = await open(mut, legacy);
    expect([old.statusCode, old.ended]).toEqual([200, XLSX]);
  });

  test('skip the attachment re-proof on the copy path and a copy of a file taken off the job is still served', async () => {
    const moved = {
      ticket: { crew_takeoff: sheetRow('a_xlsx') },
      mutateWorld: (w) => { w.attachments.find((a) => a.id === 'a_xlsx').entity_id = 'j2'; },
    };
    const deleted = { ticket: { crew_takeoff: sheetRow('a_deleted') } };
    expect((await open(router, moved)).statusCode).toBe(404);
    expect((await read(router, deleted)).body.takeoff).toBeNull();
    expect(mockBuild).not.toHaveBeenCalled();

    const PRE = '  // A spreadsheet with no copy on a default link: decided before any lookup.\n'
      + '  if (!originalMayShow(chosen.kind) && !copyLines.length) return null;\n';
    const mut = mutant([[PRE, PRE
      + "  if (!originalMayShow(chosen.kind)) return { att: { filename: chosen.filename }, copyLines: copyLines, takeoff: { filename: null, kind: 'xlsx', size_bytes: null, copy: true, lines: copyLines.length } };\n"]]);
    const res = await open(mut, moved);
    expect([res.statusCode, res.headers['content-type']]).toEqual([200, XLSX_TYPE]);
    expect((await read(mut, deleted)).body.takeoff).toMatchObject({ copy: true, lines: 2 });
  });

  test('drop the parent binding and a file moved to another job is still served', async () => {
    const opts = {
      ticket: { crew_takeoff: fileRow('a_pdf') },
      mutateWorld: (w) => { w.attachments.find((a) => a.id === 'a_pdf').entity_id = 'j2'; },
    };
    expect((await open(router, opts)).statusCode).toBe(404);
    const mut = mutant([[
      "        AND ((entity_type = 'job' AND entity_id = $2)\n"
        + "          OR (entity_type = 'lead' AND entity_id = $3)\n"
        + "          OR (entity_type = 'estimate' AND entity_id = $4))`,",
      "        AND COALESCE($2, $3, $4, '') IS NOT NULL`,",
    ]]);
    const res = await open(mut, opts);
    expect(res.statusCode).toBe(200);
    expect(res.ended).toEqual(PDF);
    // attachmentInOrg alone still holds the TENANT line — which is why both
    // run: the predicate is what keeps the file on THIS ticket's job.
    const rival = await open(mut, { ticket: { crew_takeoff: sheetRow('a_rival_lead') } });
    expect(rival.statusCode).toBe(404);
  });

  test('decide on the STORED kind only and a "PDF" whose file is now a spreadsheet is served as the original', async () => {
    const opts = { ticket: { crew_takeoff: fileRow('a_xlsx', 'pdf') }, share: DEFAULT_LINK };
    expect((await read(router, opts)).body.takeoff).toBeNull();
    const mut = mutant([[
      '  if (!(originalMayShow(chosen.kind) && originalMayShow(kind))) {',
      '  if (!originalMayShow(chosen.kind)) {',
    ]]);
    const res = await open(mut, opts);
    expect([res.statusCode, res.ended]).toEqual([200, XLSX]);
  });

  test('decide on the kind the file has NOW only and a copied spreadsheet renamed .pdf is served as the original', async () => {
    const opts = { ticket: { crew_takeoff: sheetRow('a_renamed', 'xlsx') }, share: DEFAULT_LINK };
    expect((await open(router, opts)).ended).toEqual(copyBytes(2));
    const mut = mutant([[
      '  if (!(originalMayShow(chosen.kind) && originalMayShow(kind))) {',
      '  if (!originalMayShow(kind)) {',
    ]]);
    const res = await open(mut, opts);
    expect([res.statusCode, res.ended]).toEqual([200, XLSX]);
  });

  test('hand the builder the stored lines as they are and a price written into the row reaches the copy', async () => {
    const lines = [{ description: 'Drip edge 10 ft', qty: '20', unit: 'pc', unit_cost: '$45.00' }];
    const opts = { ticket: { crew_takeoff: sheetRow('a_xlsx', 'xlsx', lines) } };
    await open(router, opts);
    expect(mockBuild.mock.calls[0][0].lines).toEqual([{ description: 'Drip edge 10 ft', qty: '20', unit: 'pc' }]);
    const mut = mutant([['  return svc.normalizeMaterials(copy.lines);', '  return copy.lines;']]);
    await open(mut, opts);
    expect(mockBuild.mock.calls[1][0].lines).toEqual(lines);
  });

  test('drop the size cap and the 38 MB plan set is offered — a card whose door the crew can never open', async () => {
    const opts = { ticket: { crew_takeoff: fileRow('a_plans') } };
    expect((await read(router, opts)).body.takeoff).toBeNull();
    const mut = mutant([[
      '  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) return null;',
      '  // MUTANT: no size cap',
    ]]);
    expect((await read(mut, opts)).body.takeoff).toEqual(originalCard('Plan set.pdf', 'pdf', 38 * 1024 * 1024));
  });

  test('never take the download slot and sixty requests from one address open storage sixty times', async () => {
    const mut = mutant([[
      '      release = takeTakeoffSlot(req);\n      if (!release) return res.status(429).json({ error: TAKEOFF_BUSY });',
      '      release = () => {};',
    ]]);
    const feed = handFed();
    mockGetStream.mockImplementation(async () => ({ stream: feed.stream, size: PDF.length }));
    const world = makeWorld({ ticket: { crew_takeoff: fileRow('a_pdf') } });
    const reqs = [];
    for (let i = 0; i < 60; i++) reqs.push(start(mut, DOOR, world, { ip: '198.51.100.30' }));
    await until(() => mockGetStream.mock.calls.length === 60, 'sixty storage opens');
    expect(reqs.filter((r) => r.res.body)).toEqual([]);
    for (const r of reqs) r.res.destroy();
    feed.stream.destroy();
    await Promise.all(reqs.map((r) => r.done));
  });

  test('never take the slot on the COPY path and twenty requests from one address run twenty builds', async () => {
    const mut = mutant([[
      '        release = takeTakeoffSlot(req);\n'
        + '        if (!release) return res.status(429).json({ error: TAKEOFF_BUSY });\n'
        + '        const built = await buildCrewCopy(found);',
      '        release = () => {};\n'
        + '        const built = await buildCrewCopy(found);',
    ]]);
    const g = gate();
    mockBuild.mockImplementation(async ({ lines }) => { await g.shut; return { buffer: copyBytes(lines.length), filename: 'Materials.xlsx' }; });
    const world = makeWorld({ ticket: { crew_takeoff: sheetRow('a_xlsx') } });
    const reqs = [];
    for (let i = 0; i < 20; i++) reqs.push(start(mut, DOOR, world, { ip: '198.51.100.35' }));
    await until(() => mockBuild.mock.calls.length === 20, 'twenty builds');
    expect(reqs.filter((r) => r.res.body)).toEqual([]);
    g.open();
    expect((await Promise.all(reqs.map((r) => r.done))).map((r) => r.statusCode)).toEqual(Array(20).fill(200));

    // The shipped door: one build, nineteen told to wait.
    const g2 = gate();
    mockBuild.mockReset();
    mockBuild.mockImplementation(async ({ lines }) => { await g2.shut; return { buffer: copyBytes(lines.length), filename: 'Materials.xlsx' }; });
    const shipped = [];
    for (let i = 0; i < 20; i++) shipped.push(start(router, DOOR, world, { ip: '198.51.100.36' }));
    await until(() => mockBuild.mock.calls.length === 1 && shipped.filter((r) => r.res.body).length === 19, 'nineteen refusals');
    g2.open();
    const codes = (await Promise.all(shipped.map((r) => r.done))).map((r) => r.statusCode).sort();
    expect(codes).toEqual([200].concat(Array(19).fill(429)));
  });

  test('drop the close listener and a reader who leaves while storage stalls holds the link\'s slot', async () => {
    const mut = mutant([[
      "      res.on('close', () => { if (!res.writableFinished && !stream.destroyed) stream.destroy(); });",
      '      // MUTANT: the storage stream is not let go',
    ]]);
    const feed = handFed();
    mockGetStream.mockImplementationOnce(async () => ({ stream: feed.stream, size: PDF.length }));
    const world = makeWorld({ ticket: { crew_takeoff: fileRow('a_pdf') } });
    const req = start(mut, DOOR, world, { ip: '198.51.100.50' });
    await until(() => mockGetStream.mock.calls.length === 1, 'download open');
    feed.push(PDF.subarray(0, 2048));
    await until(() => req.res.received().length === 2048, 'first chunk sent');
    req.res.destroy();
    for (let i = 0; i < 200; i++) await new Promise((r) => setImmediate(r));
    expect(feed.stream.destroyed).toBe(false);
    expect(answer(await start(mut, DOOR, world, { ip: '198.51.100.51' }).done)).toEqual(BUSY);
    // Let the stalled download end so nothing outlives the test.
    feed.stream.destroy();
    await req.done;
  });

  test('never give the download slot back and the link\'s next download is refused as busy', async () => {
    const mut = mutant([[
      '    } finally {\n'
        + '      if (source && !source.destroyed && typeof source.destroy === \'function\') source.destroy();\n'
        + '      if (release) release();\n'
        + '    }',
      '    } finally {\n'
        + '      if (source && !source.destroyed && typeof source.destroy === \'function\') source.destroy();\n'
        + '    }',
    ]]);
    const world = makeWorld({ ticket: { crew_takeoff: fileRow('a_pdf') } });
    expect((await start(mut, DOOR, world, { ip: '198.51.100.40' }).done).statusCode).toBe(200);
    expect(answer(await start(mut, DOOR, world, { ip: '198.51.100.41' }).done)).toEqual(BUSY);
  });
});
