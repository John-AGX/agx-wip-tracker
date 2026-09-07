// THE FIRST TOKEN WRITE — every refusal, driven through the REAL handler.
//
// The spec calls S5 the slice to review hardest, and says every refusal should
// have a test before the code merges. These are not source-level greps: a fake
// Postgres answers exactly the statements the route emits and records every
// one, so a test can assert on what did NOT run — which is how "the guest
// could not touch that" gets measured rather than asserted.
//
// The refusals pinned here, in the spec's own order:
//   a `view` share PATCHing                 -> 403
//   a revoked share                         -> 410
//   an expired share                        -> 410
//   a closed / cancelled ticket             -> 409
//   a backwards status                      -> 403 WITH a reason
//   a checklist that renames/adds/deletes   -> silently dropped, only `done` lands
//   a note                                  -> APPENDED, never an overwrite
//   a non-image upload                      -> 400
//   a PNG claiming to be a PDF              -> 400

const svc = require('../server/services/service-tickets');

// ── A fake Postgres ─────────────────────────────────────────────────────
let db;

function makeDb(opts) {
  const o = opts || {};
  const state = { log: [], ticket: null, shareUpdates: [] };

  const share = Object.assign({
    id: 'stshare_1',
    organization_id: 1,
    ticket_id: 'st_1',
    token_hash: svc.hashToken('a'.repeat(64)),
    scope: 'respond',
    hide_financials: true,
    recipient_email: 'crew@sub.com',
    recipient_name: null,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    opened_at: null,
    revoked_at: null,
  }, o.share || {});

  const ticket = Object.assign({
    id: 'st_1',
    organization_id: 1,
    job_id: 'j1',
    lead_id: null,
    title: 'Gate will not latch',
    status: 'open',
    priority: 'normal',
    scope_proposed: 'Adjust the strike plate.',
    scope_approved: 'PRICED SCOPE — must not leak',
    internal_notes: 'client is difficult',
    checklist: [{ text: 'Pull permit', done: false }, { text: 'Set forms', done: false }],
    guest_log: null,
    archived_at: null,
  }, o.ticket || {});
  state.ticket = ticket;

  const query = async (sql, params) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    state.log.push({ sql: text, params: params || [] });
    if (/FROM service_ticket_shares WHERE token_hash/i.test(text)) {
      return { rows: o.noShare ? [] : [share] };
    }
    if (/FROM service_tickets WHERE id = \$1 AND archived_at IS NULL/i.test(text)) {
      return { rows: o.noTicket ? [] : [ticket] };
    }
    if (/^UPDATE service_ticket_shares/i.test(text)) {
      state.shareUpdates.push(text);
      return { rows: [], rowCount: 1 };
    }
    if (/^UPDATE service_tickets SET/i.test(text)) {
      state.updateSql = text;
      state.updateParams = params;
      return { rows: [Object.assign({}, ticket)], rowCount: 1 };
    }
    if (/INSERT INTO service_ticket_events/i.test(text)) return { rows: [], rowCount: 1 };
    if (/FROM organizations/i.test(text)) return { rows: [{ name: 'AG Exteriors' }] };
    if (/FROM tasks/i.test(text)) return { rows: [] };
    if (/MAX\(position\)/i.test(text)) return { rows: [{ max_pos: -1 }] };
    if (/INSERT INTO attachments/i.test(text)) return { rows: [{ id: 'att_1' }] };
    throw new Error('fake pg: unhandled statement -> ' + text.slice(0, 140));
  };

  state.query = query;
  return state;
}

jest.mock('../server/db', () => ({
  pool: {
    query: async (sql, params) => global.__stDb.query(sql, params),
    connect: async () => ({ query: async (s, p) => global.__stDb.query(s, p), release() {} }),
  },
}));
jest.mock('../server/auth', () => ({
  requireAuth: (req, res, next) => next(),
  requireOrgId: (req, res, next) => { req.orgId = 1; next(); },
  requireCapability: () => (req, res, next) => next(),
}));
jest.mock('../server/email', () => ({ sendEmail: async () => {}, isEnabled: () => false }));
// The limiters are express middleware; pass-through so the handler is what is
// under test rather than the bucket.
jest.mock('../server/rate-limit', () => ({
  stShareIpLimiter: (req, res, next) => next(),
  stShareViewLimiter: (req, res, next) => next(),
  stShareWriteLimiter: (req, res, next) => next(),
}));
jest.mock('../server/services/entity-labels', () => ({
  resolveEntityLabels: async () => new Map([['job:j1', 'RV2006 Waterside 1']]),
}));
jest.mock('../server/storage', () => ({ storage: { put: async (k) => 'https://cdn/' + k } }));

const router = require('../server/routes/service-ticket-share-routes');

function handlerChain(method, routePath) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === routePath && l.route.methods[method]
  );
  if (!layer) throw new Error(method + ' ' + routePath + ' not found');
  return layer.route.stack.map((s) => s.handle);
}

function fakeRes() {
  const res = { statusCode: 200, body: null, headersSent: false };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.body = p; res.headersSent = true; return res; };
  res.set = () => res;
  return res;
}

// Run the whole middleware chain, so loadTicketShare's refusals are exercised
// exactly as they are in production rather than skipped.
async function run(method, routePath, req) {
  const chain = handlerChain(method, routePath);
  const res = fakeRes();
  req.params = req.params || { token: 'a'.repeat(64) };
  req.body = req.body || {};
  req.headers = req.headers || {};
  req.get = () => 'project86.net';
  for (const h of chain) {
    let advanced = false;
    await h(req, res, () => { advanced = true; });
    if (!advanced) return res;     // a middleware answered — that IS the result
  }
  return res;
}

const patch = (opts, body) => {
  global.__stDb = db = makeDb(opts);
  return run('patch', '/service-ticket-share/:token', { body });
};

describe('S5 — the guest write door refuses everything it should', () => {
  test('a VIEW share cannot write at all', async () => {
    const res = await patch({ share: { scope: 'view' } }, { note: 'let me in' });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/view-only/i);
    // And nothing was written.
    expect(db.log.some((q) => /^UPDATE service_tickets SET/i.test(q.sql))).toBe(false);
  });

  test('an UNKNOWN scope narrows to view and is refused', async () => {
    // The single most important line in the feature, exercised through the
    // real door: a row written by a future build must narrow, not widen.
    const res = await patch({ share: { scope: 'edit' } }, { note: 'hi' });
    expect(res.statusCode).toBe(403);
    expect(db.log.some((q) => /^UPDATE service_tickets SET/i.test(q.sql))).toBe(false);
  });

  test('a REVOKED share is 410 and never reaches the ticket', async () => {
    const res = await patch({ share: { revoked_at: new Date().toISOString() } }, { note: 'x' });
    expect(res.statusCode).toBe(410);
    expect(db.log.some((q) => /FROM service_tickets/i.test(q.sql))).toBe(false);
  });

  test('an EXPIRED share is 410 and never reaches the ticket', async () => {
    const res = await patch({ share: { expires_at: new Date(Date.now() - 1000).toISOString() } }, { note: 'x' });
    expect(res.statusCode).toBe(410);
    expect(db.log.some((q) => /FROM service_tickets/i.test(q.sql))).toBe(false);
  });

  test('a malformed token never costs a database query', async () => {
    global.__stDb = db = makeDb();
    const res = await run('patch', '/service-ticket-share/:token', { params: { token: 'nope' }, body: {} });
    expect(res.statusCode).toBe(404);
    expect(db.log).toHaveLength(0);
  });

  test('a CLOSED ticket refuses every write', async () => {
    const res = await patch({ ticket: { status: 'closed' } }, { note: 'still working' });
    expect(res.statusCode).toBe(409);
    expect(db.log.some((q) => /^UPDATE service_tickets SET/i.test(q.sql))).toBe(false);
  });

  test('a CANCELLED ticket refuses every write', async () => {
    const res = await patch({ ticket: { status: 'cancelled' } }, { note: 'x' });
    expect(res.statusCode).toBe(409);
  });

  test('a BACKWARDS status is 403 with a reason, not a silent no-op', async () => {
    const res = await patch({ ticket: { status: 'in_progress' } }, { status: 'open' });
    expect(res.statusCode).toBe(403);
    expect(String(res.body.error)).toMatch(/cannot move/i);
    expect(db.log.some((q) => /^UPDATE service_tickets SET/i.test(q.sql))).toBe(false);
  });

  test('a guest can never reach approved / closed / cancelled through the door', async () => {
    for (const bad of ['approved', 'closed', 'cancelled']) {
      const res = await patch({ ticket: { status: 'work_complete' } }, { status: bad });
      expect(res.statusCode).toBe(403);
    }
  });

  test('a guest CAN do the one thing a crew actually does', async () => {
    const res = await patch({ ticket: { status: 'in_progress' } }, { status: 'work_complete' });
    expect(res.statusCode).toBe(200);
    expect(db.updateSql).toMatch(/status = \$/);
    // completed_at is stamped, and COALESCEd so a second report cannot move it.
    expect(db.updateSql).toMatch(/completed_at = COALESCE\(completed_at, NOW\(\)\)/);
  });
});

describe('S5 — what a guest write may TOUCH', () => {
  test('the body keys outside the closed set are unreachable', async () => {
    const res = await patch({}, {
      note: 'real note',
      // Everything below must be ignored — the handler NAMES its keys.
      title: 'HIJACKED', scope_proposed: 'HIJACKED', scope_approved: 'HIJACKED',
      internal_notes: 'HIJACKED', organization_id: 999, job_id: 'j2', lead_id: 'l2',
      assignee_user_id: 9, ticket_number: 'X-1', created_by: 9, archived_at: 'now',
      priority: 'urgent', scheduled_for: '2030-01-01',
    });
    expect(res.statusCode).toBe(200);
    for (const banned of ['title', 'scope_proposed', 'scope_approved', 'internal_notes',
                          'organization_id', 'job_id', 'lead_id', 'assignee_user_id',
                          'ticket_number', 'created_by', 'archived_at', 'priority',
                          'scheduled_for']) {
      expect(db.updateSql).not.toMatch(new RegExp('\\b' + banned + ' = '));
    }
    // Only guest_log moved.
    expect(db.updateSql).toMatch(/guest_log = COALESCE/);
  });

  test('a note is APPENDED in SQL — never read-modify-write', async () => {
    // Two guests writing at once must not lose one another's note, which a
    // read-modify-write would do.
    const res = await patch({}, { note: 'Gate is welded shut' });
    expect(res.statusCode).toBe(200);
    expect(db.updateSql).toMatch(/guest_log = COALESCE\(guest_log, ''\) \|\| \$/);
    expect(db.updateSql).not.toMatch(/guest_log = \$\d+\s*(,|$)/);
  });

  test('a note lands in guest_log and NEVER in internal_notes', async () => {
    await patch({}, { note: 'x' });
    expect(db.updateSql).not.toMatch(/internal_notes/);
  });

  test('the appended note is attributed, never anonymous', async () => {
    await patch({ share: { recipient_name: 'Ana Ruiz' } }, { note: 'Done' });
    const appended = db.updateParams.find((p) => typeof p === 'string' && p.indexOf('Done') >= 0);
    expect(appended).toMatch(/Ana Ruiz/);
    expect(appended).toMatch(/via shared link/);
  });

  test('a name is write-once — it cannot retroactively re-attribute', async () => {
    await patch({ share: { recipient_name: 'Ana Ruiz' } }, { name: 'Someone Else', note: 'x' });
    // The share UPDATE is guarded on recipient_name IS NULL, so even the
    // attempt cannot land.
    const nameUpdate = db.shareUpdates.find((s) => /recipient_name = \$1/.test(s));
    expect(nameUpdate === undefined || /recipient_name IS NULL/.test(nameUpdate)).toBe(true);
  });

  test('CHECKLIST: only done flips land — add / delete / rename are dropped', async () => {
    const res = await patch({}, {
      checklist: [
        { text: 'Pull permit', done: true },          // a legitimate tick
        { text: 'RENAMED', done: true },              // rename attempt
        { text: 'Bill extra $5k', done: true },       // addition attempt
      ],
    });
    expect(res.statusCode).toBe(200);
    const written = JSON.parse(db.updateParams[0]);
    expect(written).toHaveLength(2);                  // no addition
    expect(written[0]).toEqual({ text: 'Pull permit', done: true });
    expect(written[1]).toEqual({ text: 'Set forms', done: false }); // rename refused
  });

  test('CHECKLIST: an empty array cannot wipe the list', async () => {
    // task-share lets [] through — it is truthy at its `if (cl)` gate and
    // replaces the whole array. That defect is not carried forward.
    const res = await patch({}, { checklist: [] });
    expect(res.statusCode).toBe(200);
    const written = JSON.parse(db.updateParams[0]);
    expect(written).toHaveLength(2);
  });

  test('an empty body writes NOTHING rather than touching updated_at', async () => {
    const res = await patch({}, {});
    expect(res.statusCode).toBe(200);
    expect(db.log.some((q) => /^UPDATE service_tickets SET/i.test(q.sql))).toBe(false);
  });

  test('the response never leaks scope_approved or internal_notes', async () => {
    const res = await patch({}, { note: 'x' });
    const json = JSON.stringify(res.body);
    expect(json).not.toContain('PRICED SCOPE');
    expect(json).not.toContain('client is difficult');
    expect(json).not.toContain('token_hash');
    expect(json).not.toMatch(/"organization_id"/);
  });
});

describe('S5 — the photo door', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const pdf = Buffer.from('%PDF-1.4\n');

  // multer is mocked out of the chain by driving the handler directly with a
  // req that already carries req.file — the upload middleware itself is
  // library code, and what is under test is what happens to the BYTES.
  async function photo(opts, file) {
    global.__stDb = db = makeDb(opts);
    const chain = handlerChain('post', '/service-ticket-share/:token/photo');
    const res = fakeRes();
    const req = { params: { token: 'a'.repeat(64) }, body: {}, headers: {}, file: file };
    // Skip multer (index 2 in the chain: ip, write, loadTicketShare, upload, handler)
    for (const h of chain) {
      if (h.name === 'multerMiddleware' || String(h).indexOf('multer') >= 0) continue;
      let advanced = false;
      await h(req, res, () => { advanced = true; });
      if (!advanced) return res;
    }
    return res;
  }

  test('a PDF is refused even when it claims to be a PNG', async () => {
    const res = await photo({}, { buffer: pdf, mimetype: 'image/png', originalname: 'sneaky.png' });
    expect(res.statusCode).toBe(400);
    expect(db.log.some((q) => /INSERT INTO attachments/i.test(q.sql))).toBe(false);
  });

  test('a PDF honestly declared is still refused — images only', async () => {
    const res = await photo({}, { buffer: pdf, mimetype: 'application/pdf', originalname: 'doc.pdf' });
    expect(res.statusCode).toBe(400);
    expect(db.log.some((q) => /INSERT INTO attachments/i.test(q.sql))).toBe(false);
  });

  test('a VIEW share cannot upload', async () => {
    const res = await photo({ share: { scope: 'view' } },
      { buffer: png, mimetype: 'image/png', originalname: 'a.png' });
    expect(res.statusCode).toBe(403);
  });

  test('a closed ticket cannot receive a photo', async () => {
    const res = await photo({ ticket: { status: 'closed' } },
      { buffer: png, mimetype: 'image/png', originalname: 'a.png' });
    expect(res.statusCode).toBe(409);
  });

  test('no file is a 400, not a crash', async () => {
    const res = await photo({}, undefined);
    expect(res.statusCode).toBe(400);
  });
});

describe('S5 — the source shape the tests above cannot see', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'routes', 'service-ticket-share-routes.js'), 'utf8');

  test('the guest PATCH never loops over req.body', () => {
    // The closed set is enforced by NAMING each key. A loop is how a field
    // added later becomes writable by a stranger just because it exists.
    const handler = src.slice(src.indexOf("router.patch('/service-ticket-share/:token'"),
                              src.indexOf("router.post('/service-ticket-share/:token/photo'"));
    expect(handler).not.toMatch(/for \(const \w+ of Object\.keys\(body\)/);
    expect(handler).not.toMatch(/Object\.keys\(req\.body\)/);
    for (const named of ['body.name', 'body.checklist', 'body.note', 'body.status']) {
      expect(handler).toContain(named);
    }
  });

  test('the scope is re-derived from the STORED row on every write', () => {
    const handler = src.slice(src.indexOf("router.patch('/service-ticket-share/:token'"),
                              src.indexOf("router.post('/service-ticket-share/:token/photo'"));
    // share.scope comes off the row loadTicketShare selected — never the body,
    // and never inferred from the page having hidden a control.
    expect(handler).toMatch(/scopeAllows\(share\.scope, 'respond'\)/);
    expect(handler).not.toMatch(/body\.scope/);
  });

  test('the photo sniffs the bytes BEFORE anything is stored', () => {
    const handler = src.slice(src.indexOf("router.post('/service-ticket-share/:token/photo'"));
    const sniff = handler.indexOf('mimeFamilyMatches');
    const store = handler.indexOf('storage.put');
    expect(sniff).toBeGreaterThan(-1);
    expect(store).toBeGreaterThan(sniff);
  });

  test("the attachment's org is stamped from the TICKET, never the request", () => {
    const handler = src.slice(src.indexOf("router.post('/service-ticket-share/:token/photo'"));
    expect(handler).toContain('ticket.organization_id');
    expect(handler).not.toMatch(/req\.body\.organization_id|req\.orgId/);
  });
});
