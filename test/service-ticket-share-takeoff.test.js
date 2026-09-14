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
//   * no financial info on work orders            has_prices true is withheld
//                                                 from every link that hides
//                                                 financials (the default)
//   * PDFs and photos cannot be checked           has_prices null shows on
//                                                 every link
//   * a revoked or expired link stops             loadTicketShare, 410
//   * a file removed from the job stops           the attachment is re-proved
//                                                 against the ticket's job,
//                                                 lead and estimate on EVERY
//                                                 read
//   * a spreadsheet that was never checked        has_prices null on an .xls,
//                                                 .xlsx or CSV is withheld
//                                                 from a default link
//   * a file the door cannot send is not offered  over MAX_FILE_BYTES, no card
//   * the door holds no file in memory            piped from storage.getStream,
//                                                 one download per link and
//                                                 per address
//
// Harness: the guest-write style. A fake Postgres answers the statements the
// route emits and records every one, so "the file was never fetched" and "the
// door never reached the attachments table" are measured, not asserted. The
// attachment read is answered by EVALUATING the parent predicates the
// statement actually contains — which is what lets the parent-binding mutant
// below fail for the right reason instead of against a canned row.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable, Writable } = require('stream');
const svc = require('../server/services/service-tickets');
const { MAX_FILE_BYTES } = jest.requireActual('../server/services/materials-extract.js');

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
      // The findings' files: an old estimating export with a Unit Cost column,
      // and a plan set between the crew cap and the 50 MB upload cap.
      att('a_xls', 'job', 'j1', 'Estimate.xls', 'application/vnd.ms-excel'),
      att('a_plans', 'job', 'j1', 'Plan set.pdf', 'application/pdf', 1, 38 * 1024 * 1024),
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
const XLSX = pad(Buffer.concat([Buffer.from([0x50, 0x4B, 0x03, 0x04]), Buffer.from('xl/workbook.xml')]));
const XLS = pad(Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]));
const BYTES = {
  'orig/a_pdf': PDF, 'orig/a_xlsx': XLSX, 'orig/a_csv': pad(Buffer.from('Description,Qty\r\nDrip edge,20\r\n')),
  'orig/a_png': PNG, 'orig/a_fakejpg': pad(Buffer.from('<html><script>alert(1)</script></html>')),
  'orig/a_fakepdf': pad(Buffer.from('<svg onload="alert(1)"></svg>')), 'orig/a_lead': XLSX, 'orig/a_est': PDF,
  'orig/a_other_job': PDF, 'orig/a_weird': PDF, 'orig/a_big': PDF, 'orig/a_xls': XLS, 'orig/a_plans': PDF,
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

const router = require('../server/routes/service-ticket-share-routes');

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

const chosen = (attachmentId, hasPrices, extra) => Object.assign({
  attachment_id: attachmentId, filename: 'whatever it was called', kind: 'pdf',
  has_prices: hasPrices, set_at: '2026-09-13T12:00:00.000Z', set_by: 10,
}, extra || {});

const read = (r, opts) => run(r, '/service-ticket-share/:token', makeWorld(opts));
const open = (r, opts) => {
  const world = makeWorld(opts);
  return run(r, '/service-ticket-share/:token/takeoff', world).then((res) => Object.assign(res, { world }));
};
const DEFAULT_LINK = { hide_financials: true };
const FINANCIAL_LINK = { hide_financials: false };
const touchedAttachments = (world) => world.log.some((q) => /FROM attachments WHERE id/i.test(q.sql));
const NO_TAKEOFF = [404, { error: 'There is no takeoff file on this work order.' }];

/* ═══════════════════════════════════════════════════════════════════════════
 * THE CARD — GET /service-ticket-share/:token
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the link read carries a takeoff only when this link may show it', () => {
  test('nothing chosen: takeoff is null and the attachments table is never read', async () => {
    const world = makeWorld();
    const res = await run(router, '/service-ticket-share/:token', world);
    expect(res.statusCode).toBe(200);
    expect(res.body.takeoff).toBeNull();
    expect(touchedAttachments(world)).toBe(false);
  });

  test('a checked file with no prices shows on a default link — a name, a kind and a size, nothing else', async () => {
    const res = await read(router, { ticket: { crew_takeoff: chosen('a_csv', false, { kind: 'csv' }) }, share: DEFAULT_LINK });
    expect(res.statusCode).toBe(200);
    expect(res.body.takeoff).toEqual({ filename: 'pull sheet.csv', kind: 'csv', size_bytes: 4096 });
    const json = JSON.stringify(res.body);
    expect(json).not.toMatch(/a_csv|orig\/|PUBLIC-STORAGE-URL|attachment_id|has_prices|set_by/);
    // crew_takeoff itself is not in publicTicket's whitelist.
    expect(res.body.ticket).not.toHaveProperty('crew_takeoff');
  });

  test('a PRICED file is withheld from a default link, and never looked up', async () => {
    const world = makeWorld({ ticket: { crew_takeoff: chosen('a_xlsx', true, { kind: 'xlsx' }) }, share: DEFAULT_LINK });
    const res = await run(router, '/service-ticket-share/:token', world);
    expect(res.statusCode).toBe(200);
    expect(res.body.takeoff).toBeNull();
    expect(touchedAttachments(world)).toBe(false);
  });

  test('...and shown on a link minted with financial details', async () => {
    const res = await read(router, { ticket: { crew_takeoff: chosen('a_xlsx', true, { kind: 'xlsx' }) }, share: FINANCIAL_LINK });
    expect(res.body.takeoff).toEqual({ filename: 'Lead Report.xlsx', kind: 'xlsx', size_bytes: 4096 });
  });

  test('a PDF or photo (has_prices null) shows on both kinds of link', async () => {
    for (const share of [DEFAULT_LINK, FINANCIAL_LINK]) {
      const res = await read(router, { ticket: { crew_takeoff: chosen('a_pdf', null) }, share });
      expect(res.body.takeoff).toEqual({ filename: 'Field takeoff.pdf', kind: 'pdf', size_bytes: 4096 });
    }
  });

  test('a verdict that is not exactly false or null NARROWS: a default link does not show it', async () => {
    for (const verdict of [undefined, 'no', 0, 'true']) {
      const ct = chosen('a_pdf', null);
      if (verdict === undefined) delete ct.has_prices; else ct.has_prices = verdict;
      const res = await read(router, { ticket: { crew_takeoff: ct }, share: DEFAULT_LINK });
      expect({ verdict, takeoff: res.body.takeoff }).toEqual({ verdict, takeoff: null });
    }
    // A share row with hide_financials missing is a default link too.
    const res = await read(router, { ticket: { crew_takeoff: chosen('a_xlsx', true) }, share: { hide_financials: undefined } });
    expect(res.body.takeoff).toBeNull();
  });

  test('the job\'s lead and the estimate it was sold from are the ticket\'s files too', async () => {
    const lead = await read(router, { ticket: { crew_takeoff: chosen('a_lead', false) } });
    expect(lead.body.takeoff).toMatchObject({ filename: 'lead-takeoff.xlsx', kind: 'xlsx' });
    const est = await read(router, { ticket: { crew_takeoff: chosen('a_est', null) } });
    expect(est.body.takeoff).toMatchObject({ filename: 'T5 pull sheet.pdf', kind: 'pdf' });
  });

  test('a file removed from the job, moved to another job, or never on it stops showing', async () => {
    const gone = await read(router, { ticket: { crew_takeoff: chosen('a_deleted', null) } });
    expect(gone.body.takeoff).toBeNull();
    const other = await read(router, { ticket: { crew_takeoff: chosen('a_other_job', null) } });
    expect(other.body.takeoff).toBeNull();
    const moved = await read(router, {
      ticket: { crew_takeoff: chosen('a_pdf', null) },
      mutateWorld: (w) => { w.attachments.find((a) => a.id === 'a_pdf').entity_id = 'j2'; },
    });
    expect(moved.body.takeoff).toBeNull();
  });

  test('another tenant\'s lead named by the job contributes nothing', async () => {
    const res = await read(router, { ticket: { job_id: 'j3', crew_takeoff: chosen('a_rival_lead', false) } });
    expect(res.body.takeoff).toBeNull();
  });

  test('a file renamed to something that is not a takeoff stops showing', async () => {
    const res = await read(router, { ticket: { crew_takeoff: chosen('a_docx', null) } });
    expect(res.body.takeoff).toBeNull();
  });

  test('a LEAD ticket shows a file on its own lead', async () => {
    const res = await read(router, { ticket: { job_id: null, lead_id: 'l1', crew_takeoff: chosen('a_lead', false) } });
    expect(res.body.takeoff).toMatchObject({ filename: 'lead-takeoff.xlsx' });
  });

  test('a failure looking the file up costs the card, never the work order', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await read(router, { ticket: { crew_takeoff: chosen('a_pdf', null) }, throwOn: /FROM attachments WHERE id/i });
      expect(res.statusCode).toBe(200);
      expect(res.body.ticket.title).toBe('Re-roof punch list');
      expect(res.body.takeoff).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE BYTES — GET /service-ticket-share/:token/takeoff
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the takeoff door serves the chosen file through the token', () => {
  const SECURITY = {
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-robots-tag': 'noindex, nofollow',
  };

  test('a PDF opens inline with every no-store / no-sniff header, and NO CSP (a sandbox blanks Chrome\'s viewer)', async () => {
    const res = await open(router, { ticket: { crew_takeoff: chosen('a_pdf', null) } });
    expect(res.statusCode).toBe(200);
    expect(res.ended).toEqual(PDF);
    expect(mockGetStream.mock.calls).toEqual([['orig/a_pdf']]);
    expect(mockGetBuffer).not.toHaveBeenCalled();
    expect(res.headers).toMatchObject(Object.assign({
      'content-type': 'application/pdf',
      'content-length': String(PDF.length),
      'content-disposition': 'inline; filename="Field takeoff.pdf"; filename*=UTF-8\'\'Field%20takeoff.pdf',
    }, SECURITY));
    // Served inline only because its BYTES are a PDF; the viewer needs what a CSP would deny.
    expect(res.headers['content-security-policy']).toBeUndefined();
  });

  test('an xlsx downloads as a spreadsheet, never inline', async () => {
    const res = await open(router, { ticket: { crew_takeoff: chosen('a_xlsx', false) } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="Lead Report\.xlsx"/);
    expect(res.headers['content-security-policy']).toMatch(/sandbox/);
    expect(res.headers).toMatchObject(SECURITY);
  });

  test('a CSV downloads as text/csv with a charset', async () => {
    const res = await open(router, { ticket: { crew_takeoff: chosen('a_csv', false) } });
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
  });

  test('a photo\'s type comes from its bytes; bytes that are not a photo download opaque', async () => {
    const png = await open(router, { ticket: { crew_takeoff: chosen('a_png', null) } });
    expect([png.headers['content-type'], png.headers['content-disposition'].split(';')[0]]).toEqual(['image/png', 'inline']);
    expect(png.headers['content-security-policy']).toBe("default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    const html = await open(router, { ticket: { crew_takeoff: chosen('a_fakejpg', null) } });
    expect([html.headers['content-type'], html.headers['content-disposition'].split(';')[0]]).toEqual(['application/octet-stream', 'attachment']);
    expect(html.headers).toMatchObject(SECURITY);
  });

  test('a ".pdf" that does not start like a PDF is not rendered either', async () => {
    const res = await open(router, { ticket: { crew_takeoff: chosen('a_fakepdf', null) } });
    expect([res.headers['content-type'], res.headers['content-disposition'].split(';')[0]]).toEqual(['application/octet-stream', 'attachment']);
  });

  test('a filename with quotes, a CR/LF and non-ASCII cannot break or add a header', async () => {
    const res = await open(router, { ticket: { crew_takeoff: chosen('a_weird', null) } });
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

  test('a priced file on a default link is the no-takeoff 404, and storage is never touched', async () => {
    const res = await open(router, { ticket: { crew_takeoff: chosen('a_xlsx', true) }, share: DEFAULT_LINK });
    expect([res.statusCode, res.body]).toEqual(NO_TAKEOFF);
    expect(fetched()).toBe(0);
    expect(touchedAttachments(res.world)).toBe(false);
    // The same file on a financial link opens.
    const fin = await open(router, { ticket: { crew_takeoff: chosen('a_xlsx', true) }, share: FINANCIAL_LINK });
    expect(fin.statusCode).toBe(200);
  });

  test('nothing chosen, or a file no longer on the job, is the same 404 without a fetch', async () => {
    for (const ct of [null, chosen('a_other_job', null), chosen('a_deleted', null)]) {
      const res = await open(router, { ticket: { crew_takeoff: ct } });
      expect([res.statusCode, res.body]).toEqual(NO_TAKEOFF);
    }
    expect(fetched()).toBe(0);
  });

  test('over 25 MB is the no-takeoff 404 before the fetch; storage holding more than the cap is 413', async () => {
    // crewTakeoffFor refuses a file the door would refuse, so the page never
    // offers it and the door answers as if nothing was chosen.
    const big = await open(router, { ticket: { crew_takeoff: chosen('a_big', null) } });
    expect([big.statusCode, big.body]).toEqual(NO_TAKEOFF);
    expect(fetched()).toBe(0);

    // The stored size is a claim written at upload time; storage saying the
    // object is bigger than the cap is refused before a header goes out.
    mockGetStream.mockImplementation(async () => ({ stream: Readable.from([PDF]), size: MAX_FILE_BYTES + 1 }));
    const lied = await open(router, { ticket: { crew_takeoff: chosen('a_pdf', null) } });
    expect([lied.statusCode, lied.body]).toEqual([413, { error: 'That file is too large to open here — ask the office for it.' }]);
    expect(lied.ended).toBeNull();
    expect(lied.headers['content-length']).toBeUndefined();
  });

  test('a revoked or expired link is 410 before the ticket is read; a malformed token costs no query', async () => {
    for (const share of [{ revoked_at: '2026-09-12T00:00:00Z' }, { expires_at: new Date(Date.now() - 1000).toISOString() }]) {
      const res = await open(router, { share, ticket: { crew_takeoff: chosen('a_pdf', null) } });
      expect(res.statusCode).toBe(410);
      expect(res.world.log.some((q) => /FROM service_tickets/i.test(q.sql))).toBe(false);
    }
    const world = makeWorld({ ticket: { crew_takeoff: chosen('a_pdf', null) } });
    const bad = await run(router, '/service-ticket-share/:token/takeoff', world, 'nope');
    expect(bad.statusCode).toBe(404);
    expect(world.log).toHaveLength(0);
    expect(fetched()).toBe(0);
  });

  test('a storage failure is a plain 500, never the error text', async () => {
    mockGetStream.mockImplementation(async () => { throw new Error('R2 NoSuchKey orig/a_pdf bucket=secret'); });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await open(router, { ticket: { crew_takeoff: chosen('a_pdf', null) } });
      expect([res.statusCode, res.body]).toEqual([500, { error: 'Something went wrong opening that file.' }]);
    } finally {
      spy.mockRestore();
    }
  });

  test('opening the file records nothing and writes nothing', async () => {
    const res = await open(router, { ticket: { crew_takeoff: chosen('a_pdf', null) } });
    expect(res.statusCode).toBe(200);
    expect(res.world.log.filter((q) => /^(INSERT|UPDATE|DELETE)\b/i.test(q.sql))).toEqual([]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * AN UNCHECKED SPREADSHEET — a row stored before the PUT refused one. The PUT
 * used to store has_prices null for an old .xls ("Estimate.xls" from an older
 * estimating export, Unit Cost column and all), and null passed every default
 * link as if it were a PDF the office had been warned about.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a spreadsheet with a null verdict stays off a link that hides financials', () => {
  test('the finding\'s row — Estimate.xls, has_prices null — is no card and the no-takeoff 404, with no lookup and no fetch', async () => {
    const opts = { ticket: { crew_takeoff: chosen('a_xls', null, { kind: 'xls' }) }, share: DEFAULT_LINK };
    const world = makeWorld(opts);
    const card = await run(router, '/service-ticket-share/:token', world);
    expect(card.statusCode).toBe(200);
    expect(card.body.takeoff).toBeNull();
    // Decided on the stored kind, before the attachments table is read.
    expect(touchedAttachments(world)).toBe(false);
    const door = await open(router, opts);
    expect([door.statusCode, door.body]).toEqual(NO_TAKEOFF);
    expect(fetched()).toBe(0);
  });

  test('the same for an .xlsx or a CSV stored with a null verdict', async () => {
    for (const [id, kind] of [['a_xlsx', 'xlsx'], ['a_csv', 'csv'], ['a_lead', 'xlsx']]) {
      const opts = { ticket: { crew_takeoff: chosen(id, null, { kind }) }, share: DEFAULT_LINK };
      expect({ id, takeoff: (await read(router, opts)).body.takeoff }).toEqual({ id, takeoff: null });
      expect({ id, status: (await open(router, opts)).statusCode }).toEqual({ id, status: 404 });
    }
    expect(fetched()).toBe(0);
  });

  test('decided again on the kind the file has NOW: a null row stored as a PDF, or with no kind, whose file is an .xls', async () => {
    const asPdf = chosen('a_xls', null, { kind: 'pdf' });
    const noKind = chosen('a_xls', null);
    delete noKind.kind;
    for (const ct of [asPdf, noKind]) {
      const opts = { ticket: { crew_takeoff: ct }, share: DEFAULT_LINK };
      expect((await read(router, opts)).body.takeoff).toBeNull();
      expect([(await open(router, opts)).statusCode, fetched()]).toEqual([404, 0]);
    }
    // A PDF chosen as a PDF is untouched by this rule.
    expect((await read(router, { ticket: { crew_takeoff: chosen('a_pdf', null, { kind: 'pdf' }) }, share: DEFAULT_LINK })).body.takeoff)
      .toEqual({ filename: 'Field takeoff.pdf', kind: 'pdf', size_bytes: 4096 });
  });

  test('a link minted WITH financial details still shows and serves it', async () => {
    const opts = { ticket: { crew_takeoff: chosen('a_xls', null, { kind: 'xls' }) }, share: FINANCIAL_LINK };
    expect((await read(router, opts)).body.takeoff).toEqual({ filename: 'Estimate.xls', kind: 'xls', size_bytes: 4096 });
    const res = await open(router, opts);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.ms-excel');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="Estimate\.xls"/);
    expect(res.ended).toEqual(XLS);
  });

  test('an .xls the check read to the end with no prices (false) shows on a default link', async () => {
    const res = await read(router, { ticket: { crew_takeoff: chosen('a_xls', false, { kind: 'xls' }) }, share: DEFAULT_LINK });
    expect(res.body.takeoff).toMatchObject({ filename: 'Estimate.xls', kind: 'xls' });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE SIZE CAP — a file the door cannot send is never offered. Uploads allow
 * 50 MB; a 38 MB plan set stored before the PUT refused one showed the crew
 * "Open the takeoff" and a 413 behind it on every attempt.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a file over the crew link\'s cap is not offered', () => {
  test('the finding\'s 38 MB plan-set PDF (has_prices null): no card, the no-takeoff 404, no fetch', async () => {
    for (const share of [DEFAULT_LINK, FINANCIAL_LINK]) {
      const opts = { ticket: { crew_takeoff: chosen('a_plans', null) }, share };
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
      ticket: { crew_takeoff: chosen('a_pdf', null) },
      mutateWorld: (w) => { w.attachments.find((a) => a.id === 'a_pdf').size_bytes = size; },
    });
    expect((await at(MAX_FILE_BYTES)).body.takeoff).toEqual({ filename: 'Field takeoff.pdf', kind: 'pdf', size_bytes: MAX_FILE_BYTES });
    expect((await at(MAX_FILE_BYTES + 1)).body.takeoff).toBeNull();
    // A pg BIGINT arrives as a string, and is read the same way.
    expect((await at(String(MAX_FILE_BYTES + 1))).body.takeoff).toBeNull();
    expect((await at('4096')).body.takeoff).toMatchObject({ size_bytes: 4096 });
  });

  test('a row with no usable size is not offered: the door could not name a length for it', async () => {
    for (const size of [null, undefined, 'abc', -1, 1.5, Infinity]) {
      const res = await read(router, {
        ticket: { crew_takeoff: chosen('a_pdf', null) },
        mutateWorld: (w) => { w.attachments.find((a) => a.id === 'a_pdf').size_bytes = size; },
      });
      expect({ size, takeoff: res.body.takeoff }).toEqual({ size, takeoff: null });
    }
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
    const world = makeWorld({ ticket: { crew_takeoff: chosen('a_pdf', null) } });
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
    const world = makeWorld({ ticket: { crew_takeoff: chosen('a_pdf', null) } });
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
      ticket: { crew_takeoff: chosen('a_pdf', null) },
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

  test('a reader who goes away mid-download gives the slot back, and storage is let go', async () => {
    const feed = handFed();
    mockGetStream.mockImplementationOnce(async () => ({ stream: feed.stream, size: PDF.length }));
    const world = makeWorld({ ticket: { crew_takeoff: chosen('a_pdf', null) } });
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
    const world = makeWorld({ ticket: { crew_takeoff: chosen('a_pdf', null) } });
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
    const world = makeWorld({ ticket: { crew_takeoff: chosen('a_pdf', null) } });
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
      const res = await open(router, { ticket: { crew_takeoff: chosen('a_pdf', null) } });
      expect(answer(res)).toEqual([500, { error: 'Something went wrong opening that file.' }]);
      expect(res.headers['content-length']).toBeUndefined();
      expect(feed.stream.destroyed).toBe(true);
    } finally {
      spy.mockRestore();
    }
    // ...and the slot is back.
    expect((await open(router, { ticket: { crew_takeoff: chosen('a_pdf', null) } })).statusCode).toBe(200);
  });

  test('a stream that runs PAST the stored size, or ends SHORT of it, drops the response instead of finishing it', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // Storage reports no length (R2 without ContentLength), so only the count catches it.
      for (const body of [Buffer.concat([PDF, Buffer.from('extra')]), PDF.subarray(0, 4000)]) {
        mockGetStream.mockImplementationOnce(async () => ({ stream: Readable.from([body.subarray(0, 2048), body.subarray(2048)]), size: null }));
        const res = await open(router, { ticket: { crew_takeoff: chosen('a_pdf', null) } });
        expect({ n: body.length, ended: res.ended, destroyed: res.destroyed }).toEqual({ n: body.length, ended: null, destroyed: true });
        // Never more on the wire than the Content-Length it named.
        expect(res.received().length).toBeLessThanOrEqual(4096);
      }
    } finally {
      spy.mockRestore();
    }
    expect((await open(router, { ticket: { crew_takeoff: chosen('a_pdf', null) } })).statusCode).toBe(200);
  });

  test('the type is still decided from the first bytes when storage yields them a few at a time', async () => {
    const trickle = (buf, n) => {
      const parts = [];
      for (let i = 0; i < buf.length; i += n) parts.push(buf.subarray(i, i + n));
      return Readable.from(parts);
    };
    mockGetStream.mockImplementationOnce(async () => ({ stream: trickle(PDF, 3), size: PDF.length }));
    const pdf = await open(router, { ticket: { crew_takeoff: chosen('a_pdf', null) } });
    expect([pdf.headers['content-type'], pdf.ended && pdf.ended.equals(PDF)]).toEqual(['application/pdf', true]);
    mockGetStream.mockImplementationOnce(async () => ({ stream: trickle(PNG, 5), size: PNG.length }));
    const png = await open(router, { ticket: { crew_takeoff: chosen('a_png', null) } });
    expect([png.headers['content-type'], png.ended && png.ended.equals(PNG)]).toEqual(['image/png', true]);
  });

  test('a file smaller than the sniff window is typed from all of it and sent whole', async () => {
    const tiny = Buffer.from('%PDF-1.4\n%%EOF\n');
    mockGetStream.mockImplementationOnce(async () => ({ stream: Readable.from([tiny]), size: tiny.length }));
    const res = await open(router, {
      ticket: { crew_takeoff: chosen('a_pdf', null) },
      mutateWorld: (w) => { w.attachments.find((a) => a.id === 'a_pdf').size_bytes = tiny.length; },
    });
    expect([res.statusCode, res.headers['content-type'], res.headers['content-length']]).toEqual([200, 'application/pdf', String(tiny.length)]);
    expect(res.ended).toEqual(tiny);
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

  test('drop the hide-financials gate and a priced spreadsheet is served on a default link', async () => {
    const opts = { ticket: { crew_takeoff: chosen('a_xlsx', true) }, share: DEFAULT_LINK };
    expect((await open(router, opts)).statusCode).toBe(404);
    const mut = mutant([[
      '  if (chosen.has_prices !== false && chosen.has_prices !== null && svc.hidesFinancials(share)) return null;',
      '  // MUTANT: no financial gate',
    ]]);
    const res = await open(mut, opts);
    expect(res.statusCode).toBe(200);
    expect(res.ended).toEqual(XLSX);
    expect((await read(mut, opts)).body.takeoff).toMatchObject({ filename: 'Lead Report.xlsx' });
  });

  test('drop the parent binding and a file moved to another job is still served', async () => {
    const opts = {
      ticket: { crew_takeoff: chosen('a_pdf', null) },
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
    const rival = await open(mut, { ticket: { crew_takeoff: chosen('a_rival_lead', false) } });
    expect(rival.statusCode).toBe(404);
  });

  test('drop the unchecked-spreadsheet gate and the finding\'s Estimate.xls (null) is served on a default link', async () => {
    const opts = { ticket: { crew_takeoff: chosen('a_xls', null, { kind: 'xls' }) }, share: DEFAULT_LINK };
    expect((await open(router, opts)).statusCode).toBe(404);
    const mut = mutant([
      ['  if (uncheckedSheet(chosen.kind)) return null;', '  // MUTANT: stored kind not checked'],
      ['  if (uncheckedSheet(kind)) return null;', '  // MUTANT: current kind not checked'],
    ]);
    expect((await read(mut, opts)).body.takeoff).toMatchObject({ filename: 'Estimate.xls', kind: 'xls' });
    const res = await open(mut, opts);
    expect(res.statusCode).toBe(200);
    expect(res.ended).toEqual(XLS);
  });

  test('check only the STORED kind and a null row stored as a PDF whose file is now an .xls is served', async () => {
    const opts = { ticket: { crew_takeoff: chosen('a_xls', null, { kind: 'pdf' }) }, share: DEFAULT_LINK };
    expect((await read(router, opts)).body.takeoff).toBeNull();
    const mut = mutant([['  if (uncheckedSheet(kind)) return null;', '  // MUTANT: current kind not checked']]);
    expect((await read(mut, opts)).body.takeoff).toMatchObject({ filename: 'Estimate.xls' });
  });

  test('drop the size cap and the 38 MB plan set is offered — a card whose door the crew can never open', async () => {
    const opts = { ticket: { crew_takeoff: chosen('a_plans', null) } };
    expect((await read(router, opts)).body.takeoff).toBeNull();
    const mut = mutant([[
      '  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) return null;',
      '  // MUTANT: no size cap',
    ]]);
    expect((await read(mut, opts)).body.takeoff).toEqual({ filename: 'Plan set.pdf', kind: 'pdf', size_bytes: 38 * 1024 * 1024 });
  });

  test('never take the download slot and sixty requests from one address open storage sixty times', async () => {
    const mut = mutant([[
      '      release = takeTakeoffSlot(req);\n      if (!release) return res.status(429).json({ error: TAKEOFF_BUSY });',
      '      release = () => {};',
    ]]);
    const feed = handFed();
    mockGetStream.mockImplementation(async () => ({ stream: feed.stream, size: PDF.length }));
    const world = makeWorld({ ticket: { crew_takeoff: chosen('a_pdf', null) } });
    const reqs = [];
    for (let i = 0; i < 60; i++) reqs.push(start(mut, DOOR, world, { ip: '198.51.100.30' }));
    await until(() => mockGetStream.mock.calls.length === 60, 'sixty storage opens');
    expect(reqs.filter((r) => r.res.body)).toEqual([]);
    for (const r of reqs) r.res.destroy();
    feed.stream.destroy();
    await Promise.all(reqs.map((r) => r.done));
  });

  test('drop the close listener and a reader who leaves while storage stalls holds the link\'s slot', async () => {
    const mut = mutant([[
      "      res.on('close', () => { if (!res.writableFinished && !stream.destroyed) stream.destroy(); });",
      '      // MUTANT: the storage stream is not let go',
    ]]);
    const feed = handFed();
    mockGetStream.mockImplementationOnce(async () => ({ stream: feed.stream, size: PDF.length }));
    const world = makeWorld({ ticket: { crew_takeoff: chosen('a_pdf', null) } });
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
    const world = makeWorld({ ticket: { crew_takeoff: chosen('a_pdf', null) } });
    expect((await start(mut, DOOR, world, { ip: '198.51.100.40' }).done).statusCode).toBe(200);
    expect(answer(await start(mut, DOOR, world, { ip: '198.51.100.41' }).done)).toEqual(BUSY);
  });
});
