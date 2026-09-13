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
const svc = require('../server/services/service-tickets');

const TOKEN = 'a'.repeat(64);
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
      return { rows: p[0] === world.share.token_hash ? [world.share] : [] };
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

// The bytes storage hands back, by key.
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< >>\nendobj\n%%EOF\n');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.from('pngbody')]);
const XLSX = Buffer.concat([Buffer.from([0x50, 0x4B, 0x03, 0x04]), Buffer.from('xl/workbook.xml')]);
const BYTES = {
  'orig/a_pdf': PDF, 'orig/a_xlsx': XLSX, 'orig/a_csv': Buffer.from('Description,Qty\r\nDrip edge,20\r\n'),
  'orig/a_png': PNG, 'orig/a_fakejpg': Buffer.from('<html><script>alert(1)</script></html>'),
  'orig/a_fakepdf': Buffer.from('<svg onload="alert(1)"></svg>'), 'orig/a_lead': XLSX, 'orig/a_est': PDF,
  'orig/a_other_job': PDF, 'orig/a_weird': PDF, 'orig/a_big': PDF,
};

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
const mockGetBuffer = jest.fn();
jest.mock('../server/storage', () => ({
  storage: {
    put: async (k) => 'https://cdn/' + k,
    getBuffer: (...args) => mockGetBuffer(...args),
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
});

const mutantPaths = [];
afterAll(() => {
  for (const p of mutantPaths) { try { fs.unlinkSync(p); } catch (e) { /* already gone */ } }
});

// ── the drive ─────────────────────────────────────────────────────────────
function fakeRes() {
  const res = { statusCode: 200, body: null, headersSent: false, headers: {}, ended: null, writes: 0 };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => {
    res.writes += 1;
    if (res.headersSent) throw new Error('response written twice');
    res.body = p; res.headersSent = true; return res;
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
  res.end = (buf) => {
    res.writes += 1;
    if (res.headersSent) throw new Error('response written twice');
    res.ended = buf; res.headersSent = true; return res;
  };
  return res;
}

async function run(r, routePath, world, token) {
  global.__takeoffWorld = world;
  const layer = r.stack.find((l) => l.route && l.route.path === routePath && l.route.methods.get);
  if (!layer) throw new Error('GET ' + routePath + ' not found');
  const res = fakeRes();
  const req = { params: { token: token || TOKEN }, body: {}, headers: {}, get: () => 'project86.test' };
  for (const h of layer.route.stack.map((s) => s.handle)) {
    let advanced = false;
    await h(req, res, () => { advanced = true; });
    if (!advanced) break;
  }
  return res;
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
    expect(res.ended).toBe(PDF);
    expect(mockGetBuffer.mock.calls).toEqual([['orig/a_pdf']]);
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
    expect(mockGetBuffer).not.toHaveBeenCalled();
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
    expect(mockGetBuffer).not.toHaveBeenCalled();
  });

  test('over 25 MB is 413 before the fetch; a fetch that comes back over is 413 too', async () => {
    const big = await open(router, { ticket: { crew_takeoff: chosen('a_big', null) } });
    expect([big.statusCode, big.body]).toEqual([413, { error: 'That file is too large to open here — ask the office for it.' }]);
    expect(mockGetBuffer).not.toHaveBeenCalled();

    mockGetBuffer.mockImplementation(async () => Buffer.alloc(25 * 1024 * 1024 + 1));
    const lied = await open(router, { ticket: { crew_takeoff: chosen('a_pdf', null) } });
    expect(lied.statusCode).toBe(413);
    expect(lied.ended).toBeNull();
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
    expect(mockGetBuffer).not.toHaveBeenCalled();
  });

  test('a storage failure is a plain 500, never the error text', async () => {
    mockGetBuffer.mockImplementation(async () => { throw new Error('R2 NoSuchKey orig/a_pdf bucket=secret'); });
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
    expect(res.ended).toBe(XLSX);
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
    expect(res.ended).toBe(PDF);
    // attachmentInOrg alone still holds the TENANT line — which is why both
    // run: the predicate is what keeps the file on THIS ticket's job.
    const rival = await open(mut, { ticket: { crew_takeoff: chosen('a_rival_lead', false) } });
    expect(rival.statusCode).toBe(404);
  });
});
