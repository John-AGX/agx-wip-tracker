// FLAG A PROBLEM (1.29) — THE THREE DOORS, DRIVEN.
//
//   F1 POST /api/service-ticket-share/:token/flag
//   F2 POST /api/service-ticket-share/:token/flags/:flagId/photo
//   F3 POST /api/service-tickets/:id/flags/:flagId/resolve
//
// server/routes/service-ticket-flag-routes.js exports registerFlagRoutes and
// is wired onto the share router in a later step, so this file builds its OWN
// express router and hands it the dependencies the share router will: a
// loadTicketShare, crewGate, crewActor, applyCrewName, ticketAccessOk and
// loadOwnedTicket that copy the shipped semantics of
// server/routes/service-ticket-share-routes.js, a fake image pipeline, and a
// multer stand-in that counts every time it runs.
//
// The database is node:sqlite through the pg shim, schema derived from
// server/db.js, behind a pool that RECORDS every statement and can inject a
// failure — so a test can assert what did NOT run. Auth is the real module
// over a signed JWT and a roles table. Rate limiters are the real ones: the
// chain order is asserted by identity, and the new flag bucket is driven over
// HTTP.
//
// Every guard that matters is then removed from a copy of the shipped file
// (LF-normalised, each anchor exactly once, written to the OS temp dir) and
// the identical drive goes red.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

// ── the recording pool ────────────────────────────────────────────────────
global.__flagPool = null;
jest.mock('../server/db', () => ({
  pool: {
    query: (sql, params) => global.__flagPool.query(sql, params),
    connect: () => global.__flagPool.connect(),
  },
}));
global.__puts = [];
global.__deletes = [];
jest.mock('../server/storage', () => ({
  storage: {
    put: async (key) => { global.__puts.push(key); return 'https://cdn.test/' + key; },
    delete: async (key) => { global.__deletes.push(key); },
  },
}));
global.__flagNotice = undefined;
jest.mock('../server/services/work-order-notices', () => ({
  get notifyProblemFlagged() { return global.__flagNotice; },
}));

const REPO = path.join(__dirname, '..');
const ROUTES_FILE = path.join(REPO, 'server', 'routes', 'service-ticket-flag-routes.js');
const FLAGS_FILE = path.join(REPO, 'server', 'services', 'service-ticket-flags.js');

const svc = require('../server/services/service-tickets');
const access = require('../server/services/service-ticket-access');
const inflight = require('../server/services/inflight');
const RL = require('../server/rate-limit');
const flagRoutes = require('../server/routes/service-ticket-flag-routes');

const TABLES = [
  'organizations', 'users', 'roles', 'jobs', 'job_access', 'tasks',
  'service_tickets', 'service_ticket_events', 'service_ticket_shares',
  'service_ticket_flags', 'attachments',
];

const WIDE = 10;
const CREW = 20;     // narrow tier, VIEW grant on j1
const NOBODY = 40;   // signed in, no ticket capability
const RIVAL = 50;    // another organization
const USERS = {
  [WIDE]: { role: 'fl_wide', org: 1 },
  [CREW]: { role: 'fl_crew', org: 1 },
  [NOBODY]: { role: 'fl_none', org: 1 },
  [RIVAL]: { role: 'fl_wide', org: 2 },
};

const TOK = {
  respond: 'a'.repeat(64),
  view: 'b'.repeat(64),
  other: 'c'.repeat(64),
  revoked: 'd'.repeat(64),
  expired: 'e'.repeat(64),
  propose: 'f'.repeat(64),
};

let eng;
let auth;
let log;
let hooks;
let router;

function makePool() {
  log = [];
  hooks = [];
  async function run(sql, params) {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    const p = params || [];
    log.push({ sql: text, params: p });
    for (const h of hooks.slice()) {
      const out = await h(text, p);
      if (out !== undefined) return out;
    }
    return eng.pool.query(sql, params);
  }
  return {
    query: run,
    connect: async () => ({ query: run, release: () => {} }),
  };
}

function seed() {
  const caps = (list) => "'" + JSON.stringify(list) + "'";
  const future = '2099-01-01T00:00:00.000Z';
  eng.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM roles; DELETE FROM jobs;
    DELETE FROM job_access; DELETE FROM tasks; DELETE FROM service_tickets;
    DELETE FROM service_ticket_events; DELETE FROM service_ticket_shares;
    DELETE FROM service_ticket_flags; DELETE FROM attachments;

    INSERT INTO organizations (id, name) VALUES (1, 'AGX'), (2, 'Rival Co');
    INSERT INTO roles (name, capabilities) VALUES
      ('fl_wide', ${caps(['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'LEADS_VIEW', 'LEADS_EDIT'])}),
      ('fl_crew', ${caps(['JOBS_VIEW_ASSIGNED', 'JOBS_EDIT_OWN'])}),
      ('fl_none', ${caps(['ESTIMATES_VIEW'])});
    INSERT INTO users (id, name, email, role, organization_id) VALUES
      (10, 'Wendy Wide', 'w@agx.test', 'fl_wide', 1),
      (20, 'Carl Crew', 'c@agx.test', 'fl_crew', 1),
      (40, 'Nora None', 'n@agx.test', 'fl_none', 1),
      (50, 'Rival Ray', 'r@rival.test', 'fl_wide', 2);
    INSERT INTO jobs (id, owner_id, data, organization_id) VALUES ('j1', 10, '{}', 1), ('j9', 50, '{}', 2);
    INSERT INTO job_access (job_id, user_id, access_level) VALUES ('j1', 20, 'view');

    INSERT INTO service_tickets (id, organization_id, title, job_id, status, archived_at, created_at) VALUES
      ('st_1', 1, 'Gate', 'j1', 'in_progress', NULL, '2026-09-01 10:00:00'),
      ('st_2', 1, 'Fence', 'j1', 'in_progress', NULL, '2026-09-01 10:00:01'),
      ('st_b', 2, 'Rival gate', 'j9', 'in_progress', NULL, '2026-09-01 10:00:02');

    INSERT INTO tasks (id, organization_id, title, status, scope, owner_user_id, service_ticket_id, archived_at, created_at) VALUES
      ('k1', 1, 'Bldg 784', 'open', 'org', NULL, 'st_1', NULL, '2026-09-02 08:00:00'),
      ('k2', 1, 'Bldg 900', 'open', 'org', NULL, 'st_2', NULL, '2026-09-02 08:00:01'),
      ('kp', 1, 'PRIVATE to-do', 'open', 'personal', 20, 'st_1', NULL, '2026-09-02 08:00:02');
  `);
  const share = eng.db.prepare(
    'INSERT INTO service_ticket_shares (id, organization_id, ticket_id, token_hash, scope, recipient_email, recipient_name, expires_at, revoked_at, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)');
  share.run('sh_a', 1, 'st_1', svc.hashToken(TOK.respond), 'respond', 'crew@sub.test', null, future, null, 10);
  share.run('sh_v', 1, 'st_1', svc.hashToken(TOK.view), 'view', 'viewer@sub.test', null, future, null, 10);
  share.run('sh_c', 1, 'st_1', svc.hashToken(TOK.other), 'respond', 'other@sub.test', 'Olga', future, null, 10);
  share.run('sh_r', 1, 'st_1', svc.hashToken(TOK.revoked), 'respond', null, null, future, '2026-09-03T00:00:00.000Z', 10);
  share.run('sh_x', 1, 'st_1', svc.hashToken(TOK.expired), 'respond', null, null, '2020-01-01T00:00:00.000Z', null, 10);
  share.run('sh_p', 1, 'st_1', svc.hashToken(TOK.propose), 'propose', null, 'Pat', future, null, 10);
}

// ── the dependencies, with the share router's semantics ─────────────────
async function loadTicketShare(req, res, next) {
  const { pool } = require('../server/db');
  try {
    const token = String(req.params.token || '');
    if (!svc.isWellFormedToken(token)) return res.status(404).json({ error: 'This link is not valid.' });
    const { rows } = await pool.query('SELECT * FROM service_ticket_shares WHERE token_hash = $1', [svc.hashToken(token)]);
    if (!rows.length) return res.status(404).json({ error: 'This link is not valid.' });
    const share = rows[0];
    if (share.revoked_at) return res.status(410).json({ error: 'This link has been turned off.' });
    if (new Date(share.expires_at).getTime() < Date.now()) return res.status(410).json({ error: 'This link has expired.' });
    const t = await pool.query('SELECT * FROM service_tickets WHERE id = $1 AND archived_at IS NULL', [share.ticket_id]);
    if (!t.rows.length) return res.status(404).json({ error: 'This work order is no longer available.' });
    req.share = share;
    req.ticket = t.rows[0];
    next();
  } catch (e) {
    res.status(500).json({ error: 'Something went wrong opening this link.' });
  }
}

function crewGate(req, res) {
  if (!svc.scopeAllows(req.share.scope, 'respond')) {
    res.status(403).json({ error: 'This link is view-only.' });
    return false;
  }
  const verdict = svc.crewSubtasksWritable(req.ticket.status);
  if (!verdict.ok) {
    res.status(409).json({ error: verdict.reason });
    return false;
  }
  return true;
}

function crewActor(share) {
  return { kind: 'share', shareId: share.id, label: share.recipient_name || share.recipient_email || null };
}

async function applyCrewName(share, body) {
  const { pool } = require('../server/db');
  const newName = svc.guestNameUpdate(share.recipient_name, body && body.name);
  if (newName) {
    await pool.query('UPDATE service_ticket_shares SET recipient_name = $1 WHERE id = $2 AND recipient_name IS NULL', [newName, share.id]);
    share.recipient_name = newName;
  }
}

global.__stores = [];
async function storeShareImage(file, baseKey) {
  global.__stores.push(baseKey);
  if (!file || !file.buffer) return { error: 'No file', status: 400 };
  if (!/^image\//.test(String(file.mimetype || ''))) return { error: 'Only photos can be uploaded here', status: 400 };
  const { storage } = require('../server/storage');
  const thumbKey = baseKey + '_thumb.jpg';
  const webKey = baseKey + '_web.jpg';
  const originalKey = baseKey + '_orig.jpg';
  const thumbUrl = await storage.put(thumbKey, file.buffer, 'image/jpeg');
  const webUrl = await storage.put(webKey, file.buffer, 'image/jpeg');
  const originalUrl = await storage.put(originalKey, file.buffer, file.mimetype);
  return { buf: file.buffer, mime: file.mimetype, width: 4, height: 3, thumbUrl, webUrl, originalUrl, thumbKey, webKey, originalKey };
}

global.__multerRuns = 0;
global.__nextUpload = null;
const upload = {
  single: () => function multerSingle(req, res, next) {
    global.__multerRuns++;
    const u = global.__nextUpload || {};
    req.file = u.file;
    req.body = Object.assign({}, u.fields || {});
    next();
  },
};

async function ticketAccessOk(req, res, ticket, mode, orgId) {
  const { pool } = require('../server/db');
  const verdict = await access.mayAccessTicketParent({
    query: (sql, params) => pool.query(sql, params), user: req.user, parent: ticket, mode, orgId,
  });
  if (verdict && verdict.ok === true) return true;
  if (verdict && verdict.reason === 'not_assigned') { res.status(404).json({ error: 'Service ticket not found' }); return false; }
  if (verdict && verdict.reason === 'no_capability') {
    res.status(403).json({ error: 'Missing capability: ' + access.capsForParentKind(access.parentOf(ticket).kind, mode).join(' ') });
    return false;
  }
  res.status(403).json({ error: 'You do not have access to this service ticket' });
  return false;
}

async function loadOwnedTicket(id, orgId) {
  const { pool } = require('../server/db');
  if (!orgId) return null;
  const { rows } = await pool.query('SELECT * FROM service_tickets WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL', [String(id), orgId]);
  return rows[0] || null;
}

const DEPS = { loadTicketShare, crewGate, crewActor, applyCrewName, storeShareImage, upload, ticketAccessOk, loadOwnedTicket };

function build(mod) {
  const r = express.Router();
  (mod || flagRoutes).registerFlagRoutes(r, DEPS);
  return r;
}

// ── lifecycle ─────────────────────────────────────────────────────────────
beforeAll(async () => {
  eng = createPgSqlite(sqliteSchema(TABLES), { jsonColumns: ['capabilities', 'detail', 'tags'] });
  global.__flagPool = makePool();
  auth = require('../server/auth');
  auth.setRolePool(eng.pool);
  seed();
  await auth.refreshRoleCache();
  router = build();
});

let mutantPaths = [];
const flush = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  seed();
  log.length = 0;
  hooks.length = 0;
  global.__puts = [];
  global.__deletes = [];
  global.__stores = [];
  global.__multerRuns = 0;
  global.__nextUpload = null;
  global.__noticeCalls = [];
  global.__flagNotice = (db, opts) => { global.__noticeCalls.push(opts); return Promise.resolve({ sent: 1 }); };
  inflight._reset();
});

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
  global.__flagPool = { query: async () => ({ rows: [], rowCount: 0 }), connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) };
  if (eng) eng.close();
});

// ── mutants ───────────────────────────────────────────────────────────────
function absolutize(src, fromDir, overrides) {
  return src.replace(/require\((['"])([^'"]+)\1\)/g, (_m, _q, spec) => {
    if (overrides && overrides[spec]) return 'require(' + JSON.stringify(overrides[spec]) + ')';
    const resolved = spec.charAt(0) === '.'
      ? require.resolve(path.resolve(fromDir, spec))
      : require.resolve(spec, { paths: [fromDir] });
    return 'require(' + JSON.stringify(resolved.split(path.sep).join('/')) + ')';
  });
}

function writeMutant(file, pairs, overrides) {
  let src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  for (const [find, replace] of pairs) {
    if (src.split(find).length !== 2) throw new Error('anchor not found');
    src = src.split(find).join(replace);
  }
  const p = path.join(os.tmpdir(), '_p86_flagroutes_mutant_' + process.pid + '_' +
    Math.random().toString(36).slice(2, 10) + '.js').split(path.sep).join('/');
  fs.writeFileSync(p, absolutize(src, path.dirname(file), overrides), 'utf8');
  mutantPaths.push(p);
  return p;
}

// A router built from a mutated routes file, optionally over a mutated service.
function mutantRouter(routePairs, servicePairs) {
  const overrides = {};
  if (servicePairs) overrides['../services/service-ticket-flags'] = writeMutant(FLAGS_FILE, servicePairs);
  const p = writeMutant(ROUTES_FILE, routePairs, overrides);
  return build(require(p));
}

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

async function drive(r, routePath, o) {
  const layer = r.stack.find((l) => l.route && l.route.path === routePath && l.route.methods.post);
  if (!layer) throw new Error('route not declared: POST ' + routePath);
  let chain = layer.route.stack.map((s) => s.handle);
  if (o.fromHandler) {
    const at = chain.findIndex((h) => h.name === o.fromHandler);
    if (at < 0) throw new Error('no handler named ' + o.fromHandler);
    chain = chain.slice(at);
  }
  const res = fakeRes();
  const req = {
    method: 'POST', params: o.params || {}, query: o.query || {}, body: o.body || {}, cookies: {},
    headers: Object.assign(o.as ? { authorization: 'Bearer ' + tokenFor(o.as) } : {}, o.headers || {}),
    ip: '10.0.0.1', protocol: 'https', get: () => 'project86.test',
  };
  for (const h of chain) {
    let advanced = false;
    await h(req, res, (err) => { if (err) throw err; advanced = true; });
    if (!advanced) break;
  }
  return res;
}

const F1 = '/service-ticket-share/:token/flag';
const F2 = '/service-ticket-share/:token/flags/:flagId/photo';
const F3 = '/service-tickets/:id/flags/:flagId/resolve';

const raise = (body, token, r) => drive(r || router, F1, { params: { token: token || TOK.respond }, body, fromHandler: 'loadTicketShare' });
function photo(flagId, upl, token, r, extra) {
  global.__nextUpload = upl || { file: { buffer: Buffer.from('jpegbytes'), mimetype: 'image/jpeg', originalname: 'gate.jpg' } };
  const x = extra || {};
  return drive(r || router, F2, { params: { token: token || TOK.respond, flagId }, headers: x.headers, query: x.query, fromHandler: 'loadTicketShare' });
}
const resolve = (as, id, flagId, note, r) => drive(r || router, F3, { as, params: { id, flagId }, body: { note } });

const GOOD = { category: 'no_access', note: 'Gate is padlocked' };
const flagInserts = () => log.filter((q) => /^INSERT INTO service_ticket_flags/.test(q.sql));
const flagSql = () => log.filter((q) => /service_ticket_flags/.test(q.sql));
const nameStamps = () => log.filter((q) => /^UPDATE service_ticket_shares SET recipient_name/.test(q.sql));
const events = (kind) => eng.all('SELECT * FROM service_ticket_events WHERE kind = ? ORDER BY created_at, id', kind);
const flagRow = (id) => eng.all('SELECT * FROM service_ticket_flags WHERE id = ?', id)[0];

function insertFlag(row) {
  const r = Object.assign({
    organization_id: 1, ticket_id: 'st_1', task_id: null, share_id: 'sh_a', author_label: 'crew@sub.test',
    category: 'no_access', note: 'Gate locked', attachment_ids: '[]', status: 'open', client_ref: null,
  }, row);
  const created = r.created_at || "datetime('now')";
  delete r.created_at;
  const cols = Object.keys(r);
  eng.db.prepare('INSERT INTO service_ticket_flags (' + cols.join(', ') + ', created_at) VALUES (' +
    cols.map(() => '?').join(', ') + ', ' + created + ')').run(...cols.map((k) => r[k]));
}

async function quietly(fn) {
  const err = jest.spyOn(console, 'error').mockImplementation(() => {});
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try { return await fn(); } finally { err.mockRestore(); warn.mockRestore(); }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * WIRING
 * ══════════════════════════════════════════════════════════════════════════*/
describe('registerFlagRoutes: the doors, their middleware order and their dependencies', () => {
  const handles = (p) => router.stack.find((l) => l.route && l.route.path === p).route.stack.map((s) => s.handle);

  test('F1: IP limiter, flag limiter, loadTicketShare, handler', () => {
    const h = handles(F1);
    expect(h.slice(0, 3)).toEqual([RL.stShareIpLimiter, RL.stShareFlagLimiter, loadTicketShare]);
    expect(h.map((x) => x.name).slice(3)).toEqual(['raiseFlag']);
    expect(typeof RL.stShareFlagLimiter).toBe('function');
  });

  test('F2: the photo gate runs BEFORE multer', () => {
    const h = handles(F2);
    expect(h.slice(0, 3)).toEqual([RL.stShareIpLimiter, RL.stShareWriteLimiter, loadTicketShare]);
    expect(h.map((x) => x.name).slice(3)).toEqual(['flagPhotoGate', 'multerSingle', 'addFlagPhoto']);
  });

  test('F3: requireAuth, requireOrgId, handler', () => {
    const h = handles(F3);
    expect(h.slice(0, 2)).toEqual([auth.requireAuth, auth.requireOrgId]);
    expect(h[2].name).toBe('resolveTicketFlag');
  });

  test('exactly three routes, all POST', () => {
    expect(router.stack.map((l) => Object.keys(l.route.methods).join() + ' ' + l.route.path))
      .toEqual(['post ' + F1, 'post ' + F2, 'post ' + F3]);
  });

  test('a missing dependency is refused at registration, not at the first request', () => {
    for (const name of Object.keys(DEPS)) {
      const d = Object.assign({}, DEPS);
      delete d[name];
      expect(() => flagRoutes.registerFlagRoutes(express.Router(), d)).toThrow(name);
    }
  });
});

describe('stShareFlagLimiter: 20 an hour per address', () => {
  test('the 21st flag from one address is a 429 with the JSON body; another address is not held up', async () => {
    const app = express();
    app.set('trust proxy', 'loopback');
    app.post('/flag', RL.stShareFlagLimiter, (req, res) => res.json({ ok: true }));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = 'http://127.0.0.1:' + server.address().port + '/flag';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const post = (ip) => fetch(url, { method: 'POST', headers: { 'x-forwarded-for': ip } });
      const statuses = [];
      for (let i = 0; i < 20; i++) statuses.push((await post('203.0.113.7')).status);
      expect(statuses).toEqual(Array(20).fill(200));
      const over = await post('203.0.113.7');
      expect(over.status).toBe(429);
      const body = await over.json();
      expect(body.error).toBe('Too many requests — please wait a moment and try again.');
      expect(body.retryAfter).toBeGreaterThan(3000);
      expect((await post('198.51.100.9')).status).toBe(200);
      expect(warn.mock.calls.some((c) => /service-ticket-share flag throttle/.test(String(c[0])))).toBe(true);
    } finally {
      warn.mockRestore();
      await new Promise((r) => server.close(r));
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * F1 — RAISE
 * ══════════════════════════════════════════════════════════════════════════*/
describe('F1 refusals', () => {
  async function viewLink(r) {
    const res = await raise(Object.assign({ name: 'Viv' }, GOOD), TOK.view, r);
    return { status: res.statusCode, error: res.body.error, inserts: flagInserts().length };
  }

  test('a view link is 403 and nothing is written', async () => {
    expect(await viewLink()).toEqual({ status: 403, error: 'This link is view-only.', inserts: 0 });
    expect(nameStamps()).toHaveLength(0);
    expect(global.__noticeCalls).toHaveLength(0);
  });

  test('MUTANT: remove the crewGate call -> the view link writes a flag', async () => {
    const mut = mutantRouter([[
      '        if (!crewGate(req, res)) return;\n        const share = req.share;',
      '        const share = req.share;']]);
    expect(await viewLink(mut)).not.toEqual({ status: 403, error: 'This link is view-only.', inserts: 0 });
  });

  test('a propose link may flag (propose is respond or better)', async () => {
    expect((await raise(GOOD, TOK.propose)).statusCode).toBe(200);
  });

  test('a revoked or expired link is 410 and never reaches a flag statement', async () => {
    expect((await raise(GOOD, TOK.revoked)).statusCode).toBe(410);
    expect((await raise(GOOD, TOK.expired)).statusCode).toBe(410);
    expect((await raise(GOOD, 'nope')).statusCode).toBe(404);
    expect(flagSql()).toHaveLength(0);
  });

  test.each(['draft', 'approved', 'closed', 'cancelled'])('a %s work order is 409 with the crew reason and no INSERT', async (status) => {
    eng.db.exec(`UPDATE service_tickets SET status = '${status}' WHERE id = 'st_1'`);
    const res = await raise(GOOD);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe(svc.crewSubtasksWritable(status).reason);
    expect(flagSql()).toHaveLength(0);
  });

  test('a missing category or note is the exact 400, with no name stamped on the link', async () => {
    const a = await raise({ note: 'x', name: 'Marco' });
    const b = await raise({ category: 'safety', note: '   ', name: 'Marco' });
    expect([a.statusCode, a.body.error]).toEqual([400, 'Pick what kind of problem it is.']);
    expect([b.statusCode, b.body.error]).toEqual([400, 'Write what the problem is — the office needs a note.']);
    expect(nameStamps()).toHaveLength(0);
    expect(eng.all("SELECT recipient_name FROM service_ticket_shares WHERE id = 'sh_a'")[0].recipient_name).toBeNull();
    expect(flagSql()).toHaveLength(0);
  });

  test("another ticket's building, or a private to-do, is 404 — proved on this ticket and its org", async () => {
    const res = await raise(Object.assign({ task_id: 'k2' }, GOOD));
    expect([res.statusCode, res.body.error]).toEqual([404, 'That building is not on this work order.']);
    const proof = log.find((q) => /FROM tasks WHERE id = \$1 AND service_ticket_id = \$2 AND organization_id = \$3/.test(q.sql));
    expect(proof.params).toEqual(['k2', 'st_1', 1]);
    expect((await raise(Object.assign({ task_id: 'kp' }, GOOD))).statusCode).toBe(404);
    expect(flagInserts()).toHaveLength(0);
  });

  test('20 open flags is a 429; resolved ones and another org\'s do not count', async () => {
    for (let i = 0; i < 19; i++) insertFlag({ id: 'open_' + i });
    insertFlag({ id: 'res_1', status: 'resolved' });
    insertFlag({ id: 'rival_1', organization_id: 2 });
    expect((await raise(GOOD)).statusCode).toBe(200);
    const res = await raise(Object.assign({}, GOOD, { note: 'one more' }));
    expect([res.statusCode, res.body.error])
      .toEqual([429, 'This work order already has 20 problems waiting on the office. Call the office instead.']);
    expect(flagInserts()).toHaveLength(1);
  });
});

describe('F1 success', () => {
  const HOSTILE = {
    category: ' Extra_Damage ', note: '  Rot behind the fascia, 3 more boards  ', task_id: 'k1', name: 'Marco',
    client_ref: 'abcdef0123456789', photos_expected: 9,
    organization_id: 999, status: 'resolved', share_id: 'sh_c', attachment_ids: ['att_evil'],
    resolution_note: 'already fixed', resolved_by: 50, ticket_id: 'st_b',
  };

  async function orgScenario(r) {
    // A fresh client_ref each time, so the second drive is never answered as
    // the first one's retry.
    const body = Object.assign({}, HOSTILE, { client_ref: 'org-' + Math.random().toString(36).slice(2, 14) });
    const res = await raise(body, TOK.respond, r);
    const ins = flagInserts()[0];
    return { status: res.statusCode, org: ins ? ins.params[1] : null };
  }

  test('org, ticket and link come from the rows in hand; body keys outside the closed set never reach SQL', async () => {
    const res = await raise(HOSTILE);
    expect(res.statusCode).toBe(200);
    expect(flagInserts()).toHaveLength(1);
    const ins = flagInserts()[0];
    expect(ins.params.slice(1, 3)).toEqual([1, 'st_1']);
    for (const bad of [999, 'resolved', 'sh_c', 'already fixed', 50, 'st_b', 'att_evil']) {
      expect(ins.params).not.toContain(bad);
    }
    expect(JSON.stringify(log.map((q) => q.params))).not.toMatch(/att_evil|already fixed|"resolved"/);

    const row = flagRow(res.body.flag.id);
    expect(row).toMatchObject({
      organization_id: 1, ticket_id: 'st_1', task_id: 'k1', share_id: 'sh_a', author_label: 'Marco',
      category: 'extra_damage', note: 'Rot behind the fascia, 3 more boards', attachment_ids: '[]',
      status: 'open', resolved_by: null, resolution_note: null, client_ref: 'abcdef0123456789',
    });
    expect(res.body).toEqual({
      ok: true,
      flag: {
        id: row.id, task_id: 'k1', category: 'extra_damage', note: 'Rot behind the fascia, 3 more boards',
        author_label: 'Marco', status: 'open', created_at: row.created_at, resolved_at: null, resolution_note: null,
        photos: [],
      },
    });
    // The name is stamped once, write-once, on the link.
    expect(eng.all("SELECT recipient_name FROM service_ticket_shares WHERE id = 'sh_a'")[0].recipient_name).toBe('Marco');
    await flush();
    expect(log.some((q) => /^UPDATE service_ticket_shares SET last_used_at = NOW\(\) WHERE id = \$1 AND organization_id = \$2/.test(q.sql))).toBe(true);
  });

  test('MUTANT: take the org from the body -> the INSERT carries 999', async () => {
    expect(await orgScenario()).toEqual({ status: 200, org: 1 });
    const mut = mutantRouter(
      [['row = await insertAs(v);', 'row = await insertAs(Object.assign({}, req.body, v));']],
      [['const insertOrg = ticket.organization_id;', 'const insertOrg = (o.flag && o.flag.organization_id) || ticket.organization_id;']]);
    log.length = 0;
    expect(await orgScenario(mut)).toEqual({ status: 200, org: 999 });
  });

  test('flag_raised is the SHAPE only — no note text in the event log', async () => {
    const res = await raise(HOSTILE);
    const ev = events('flag_raised');
    expect(ev).toHaveLength(1);
    expect(ev[0].detail).toEqual({ flag_id: res.body.flag.id, category: 'extra_damage', task_id: 'k1' });
    expect([ev[0].actor_kind, ev[0].share_id, ev[0].actor_label, ev[0].organization_id]).toEqual(['share', 'sh_a', 'Marco', 1]);
    expect(JSON.stringify(eng.all('SELECT detail FROM service_ticket_events'))).not.toMatch(/fascia/);
  });

  test('the office is handed the flag exactly once, after the row is stored, and the send is tracked', async () => {
    let release;
    global.__flagNotice = (db, opts) => {
      global.__noticeCalls.push(opts);
      // The row the notice is about is already there.
      expect(flagRow(opts.flag.id)).toBeTruthy();
      return new Promise((r) => { release = r; });
    };
    const res = await raise(HOSTILE);
    expect(res.statusCode).toBe(200);
    expect(global.__noticeCalls).toHaveLength(1);
    expect(inflight.size()).toBe(1);
    const c = global.__noticeCalls[0];
    expect(c.ticket.id).toBe('st_1');
    expect(c.share).toEqual({ id: 'sh_a', created_by: 10, recipient_name: 'Marco' });
    expect(c.flag).toEqual({ id: res.body.flag.id, category: 'extra_damage', note: 'Rot behind the fascia, 3 more boards',
      task_id: 'k1', task_title: 'Bldg 784', photo_count: 6 });
    release({ sent: 2 });
    await flush();
    expect(inflight.size()).toBe(0);
  });

  test('a throwing, rejecting or missing notice still answers 200', async () => {
    await quietly(async () => {
      global.__flagNotice = () => { throw new Error('sync boom'); };
      expect((await raise(Object.assign({}, GOOD, { note: 'a' }))).statusCode).toBe(200);
      global.__flagNotice = () => Promise.reject(new Error('smtp down'));
      expect((await raise(Object.assign({}, GOOD, { note: 'b' }))).statusCode).toBe(200);
      global.__flagNotice = undefined;
      expect((await raise(Object.assign({}, GOOD, { note: 'c' }))).statusCode).toBe(200);
      await flush();
    });
    expect(flagInserts()).toHaveLength(3);
  });
});

describe('F1 retries: client_ref', () => {
  const BODY = Object.assign({ client_ref: 'retry-0123456789' }, GOOD);

  async function duplicateScenario(r) {
    const first = await raise(BODY, TOK.respond, r);
    const second = await raise(BODY, TOK.respond, r);
    await flush();
    return {
      duplicate: second.body.duplicate === true,
      sameId: !!first.body.flag && !!second.body.flag && first.body.flag.id === second.body.flag.id,
      inserts: flagInserts().length,
      notices: global.__noticeCalls.length,
      events: events('flag_raised').length,
    };
  }

  test('a retried Send answers duplicate:true with the same flag: one row, one event, one hand-off', async () => {
    expect(await duplicateScenario()).toEqual({ duplicate: true, sameId: true, inserts: 1, notices: 1, events: 1 });
  });

  test('MUTANT: remove the client_ref lookup -> a second row and a second alert', async () => {
    const mut = mutantRouter([[
      '        if (v.clientRef) {\n          const existing = await flags.findByClientRef(pool, ticket, share.id, v.clientRef);\n          if (existing) return answerDuplicate(existing);\n        }\n',
      '']]);
    expect(await duplicateScenario(mut)).not.toEqual({ duplicate: true, sameId: true, inserts: 1, notices: 1, events: 1 });
  });

  test('the duplicate answer carries the photos added since', async () => {
    const first = await raise(BODY);
    eng.db.prepare("INSERT INTO attachments (id, entity_type, entity_id, organization_id, mime_type, thumb_url, web_url, tags) VALUES ('att_dup', 'service_ticket', 'st_1', 1, 'image/jpeg', 't', 'w', '[\"flag\"]')").run();
    eng.db.prepare("UPDATE service_ticket_flags SET attachment_ids = '[\"att_dup\"]' WHERE id = ?").run(first.body.flag.id);
    const second = await raise(BODY);
    expect(second.body.flag.photos).toEqual([{ id: 'att_dup', thumb_url: 't', web_url: 'w' }]);
  });

  // Postgres: uq_service_ticket_flags_client_ref spans every link on the
  // ticket, so another link's flag with this client_ref makes the INSERT raise
  // 23505 with no same-link winner to answer with. The fixture does not build
  // that partial index, so the hook raises exactly what Postgres would.
  async function crossLinkScenario(r) {
    insertFlag({ id: 'fl_sh_a', share_id: 'sh_a', client_ref: 'retry-0123456789' });
    hooks.push((sql, params) => {
      if (!/^INSERT INTO service_ticket_flags/.test(sql) || params[8] == null) return undefined;
      const e = new Error('duplicate key value violates unique constraint "uq_service_ticket_flags_client_ref"');
      e.code = '23505';
      e.constraint = 'uq_service_ticket_flags_client_ref';
      throw e;
    });
    const other = await quietly(() => raise(BODY, TOK.other, r));
    await flush();
    const row = other.body.flag ? flagRow(other.body.flag.id) : null;
    return {
      status: other.statusCode,
      duplicate: other.body.duplicate === true,
      row: row ? { share_id: row.share_id, client_ref: row.client_ref, note: row.note } : null,
      events: events('flag_raised').length,
      notices: global.__noticeCalls.length,
    };
  }
  const CROSS_OK = { status: 200, duplicate: false, row: { share_id: 'sh_c', client_ref: null, note: 'Gate is padlocked' }, events: 1, notices: 1 };

  test("the same client_ref from ANOTHER link is not that link's duplicate: stored without a client_ref, the office told once", async () => {
    expect(await crossLinkScenario()).toEqual(CROSS_OK);
    expect(flagInserts()).toHaveLength(2);
    expect(flagInserts()[1].params[8]).toBeNull();
    expect(flagRow('fl_sh_a').client_ref).toBe('retry-0123456789');
  });

  test('MUTANT: rethrow on a cross-link client_ref clash -> the crew gets the 500', async () => {
    const mut = mutantRouter([[
      '          row = await insertAs(Object.assign({}, v, { clientRef: null }));',
      '          throw e;']]);
    const out = await crossLinkScenario(mut);
    expect(out).not.toEqual(CROSS_OK);
    expect(out.status).toBe(500);
  });

  test('two Sends racing past the lookup: the unique-index loser answers with the winner', async () => {
    let fired = false;
    hooks.push((sql) => {
      if (fired || !/^INSERT INTO service_ticket_flags/.test(sql)) return undefined;
      fired = true;
      eng.db.prepare("INSERT INTO service_ticket_flags (id, organization_id, ticket_id, share_id, category, note, attachment_ids, status, client_ref, created_at) VALUES ('stflag_winner', 1, 'st_1', 'sh_a', 'no_access', 'Gate is padlocked', '[]', 'open', 'retry-0123456789', datetime('now'))").run();
      const e = new Error('duplicate key value violates unique constraint "uq_service_ticket_flags_client_ref"');
      e.code = '23505';
      e.constraint = 'uq_service_ticket_flags_client_ref';
      throw e;
    });
    const res = await raise(BODY);
    await flush();
    expect([res.statusCode, res.body.duplicate, res.body.flag.id]).toEqual([200, true, 'stflag_winner']);
    expect(events('flag_raised')).toHaveLength(0);
    expect(global.__noticeCalls).toHaveLength(0);
  });

  test('any other insert failure is the exact 500, and nobody is alerted', async () => {
    hooks.push((sql) => {
      if (!/^INSERT INTO service_ticket_flags/.test(sql)) return undefined;
      const e = new Error('duplicate key value violates unique constraint "service_ticket_flags_pkey"');
      e.code = '23505';
      e.constraint = 'service_ticket_flags_pkey';
      throw e;
    });
    const res = await quietly(() => raise(BODY));
    expect([res.statusCode, res.body.error]).toEqual([500, 'Something went wrong sending that. Try again, or call the office.']);
    expect(global.__noticeCalls).toHaveLength(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * F2 — PHOTO
 * ══════════════════════════════════════════════════════════════════════════*/
describe('F2 refusals never reach multer or storage', () => {
  beforeEach(() => {
    insertFlag({ id: 'fl_mine' });
    insertFlag({ id: 'fl_theirs', share_id: 'sh_c' });
    insertFlag({ id: 'fl_res', status: 'resolved' });
    insertFlag({ id: 'fl_old', created_at: "datetime('now','-3 hours')" });
    insertFlag({ id: 'fl_full', attachment_ids: '["1","2","3","4","5","6"]' });
    insertFlag({ id: 'fl_rival', organization_id: 2 });
  });

  const untouched = () => ({ multer: global.__multerRuns, stores: global.__stores.length, puts: global.__puts.length });

  async function otherLinkScenario(r) {
    const res = await photo('fl_theirs', null, TOK.respond, r);
    return { status: res.statusCode, error: res.body.error, touched: untouched() };
  }

  test("another link's flag is 404, and multer never ran", async () => {
    expect(await otherLinkScenario()).toEqual({
      status: 404, error: 'That problem report is not on this work order.', touched: { multer: 0, stores: 0, puts: 0 },
    });
  });

  test('MUTANT: put upload.single before the gate -> multer runs for a refused request', async () => {
    const mut = mutantRouter([[
      "loadTicketShare, flagPhotoGate, upload.single('file'),",
      "loadTicketShare, upload.single('file'), flagPhotoGate,"]]);
    expect(await otherLinkScenario(mut)).not.toEqual({
      status: 404, error: 'That problem report is not on this work order.', touched: { multer: 0, stores: 0, puts: 0 },
    });
  });

  test.each([
    ['fl_res', 409, 'The office already resolved that problem.'],
    ['fl_old', 409, 'Photos can only be added to a problem in the first 2 hours. Flag it again with the new photos.'],
    ['fl_full', 409, 'That problem already has 6 photos.'],
    ['fl_rival', 404, 'That problem report is not on this work order.'],
    ['fl_nope', 404, 'That problem report is not on this work order.'],
    ['bad id!', 404, 'That problem report is not on this work order.'],
  ])('%s -> %i', async (flagId, status, error) => {
    const res = await photo(flagId);
    expect([res.statusCode, res.body.error]).toEqual([status, error]);
    expect(untouched()).toEqual({ multer: 0, stores: 0, puts: 0 });
  });

  // The last photo landed but its answer was lost; the page sends it again
  // with its upload id in the header, where the gate can read it.
  function seedLandedPhoto() {
    eng.db.exec("UPDATE service_ticket_flags SET attachment_ids = '[\"1\",\"2\",\"3\",\"4\",\"5\",\"att_six\"]' WHERE id = 'fl_full'");
    eng.db.exec("UPDATE service_ticket_flags SET attachment_ids = '[\"att_six\"]' WHERE id IN ('fl_res', 'fl_old')");
    eng.db.prepare("INSERT INTO attachments (id, entity_type, entity_id, organization_id, mime_type, thumb_url, web_url, client_upload_id, tags) VALUES ('att_six', 'service_ticket', 'st_1', 1, 'image/jpeg', 'ts', 'ws', 'upl-sixth001', '[\"flag\"]')").run();
    eng.db.prepare("INSERT INTO attachments (id, entity_type, entity_id, organization_id, mime_type, thumb_url, web_url, client_upload_id, tags) VALUES ('att_loose', 'service_ticket', 'st_1', 1, 'image/jpeg', 'tl', 'wl', 'upl-loose001', '[\"flag\"]')").run();
  }
  const SIXTH = { ok: true, duplicate: true, photo: { id: 'att_six', thumb_url: 'ts', web_url: 'ws' } };

  async function landedRetry(flagId, extra, r) {
    const res = await photo(flagId, null, TOK.respond, r, extra);
    return { status: res.statusCode, body: res.body, touched: untouched() };
  }

  test.each(['fl_full', 'fl_res', 'fl_old'])('%s: a photo already on the flag, retried with X-Upload-Id, is duplicate:true and never reaches multer', async (flagId) => {
    seedLandedPhoto();
    expect(await landedRetry(flagId, { headers: { 'x-upload-id': 'upl-sixth001' } }))
      .toEqual({ status: 200, body: SIXTH, touched: { multer: 0, stores: 0, puts: 0 } });
    expect(events('photo_added')).toHaveLength(0);
  });

  test('the ?upload_id= query parameter works the same way', async () => {
    seedLandedPhoto();
    expect(await landedRetry('fl_full', { query: { upload_id: 'upl-sixth001' } }))
      .toEqual({ status: 200, body: SIXTH, touched: { multer: 0, stores: 0, puts: 0 } });
  });

  test('an early upload id that is NOT on this flag still gets the refusal, as does a malformed one', async () => {
    seedLandedPhoto();
    const loose = await landedRetry('fl_full', { headers: { 'x-upload-id': 'upl-loose001' } });
    expect([loose.status, loose.body.error]).toEqual([409, 'That problem already has 6 photos.']);
    const bad = await landedRetry('fl_full', { headers: { 'x-upload-id': 'no' } });
    expect([bad.status, bad.body.error]).toEqual([409, 'That problem already has 6 photos.']);
    const other = await landedRetry('fl_theirs', { headers: { 'x-upload-id': 'upl-sixth001' } });
    expect(other.status).toBe(404);
    expect(untouched()).toEqual({ multer: 0, stores: 0, puts: 0 });
    expect(JSON.parse(flagRow('fl_full').attachment_ids)).toHaveLength(6);
  });

  test('MUTANT: drop the early duplicate check -> the landed sixth photo is refused with the cap', async () => {
    seedLandedPhoto();
    const mut = mutantRouter([['        if (row && early) {', '        if (false) {']]);
    const out = await landedRetry('fl_full', { headers: { 'x-upload-id': 'upl-sixth001' } }, mut);
    expect(out).not.toEqual({ status: 200, body: SIXTH, touched: { multer: 0, stores: 0, puts: 0 } });
    expect(out.status).toBe(409);
  });

  test('a view link, and a closed work order, are refused by the crew gate before multer', async () => {
    const v = await photo('fl_mine', null, TOK.view);
    expect([v.statusCode, v.body.error]).toEqual([403, 'This link is view-only.']);
    eng.db.exec("UPDATE service_tickets SET status = 'closed' WHERE id = 'st_1'");
    const c = await photo('fl_mine');
    expect([c.statusCode, c.body.error]).toEqual([409, svc.crewSubtasksWritable('closed').reason]);
    expect(untouched()).toEqual({ multer: 0, stores: 0, puts: 0 });
  });

  test('a file that is not a photo is a 400 and stores no row', async () => {
    const res = await photo('fl_mine', { file: { buffer: Buffer.from('%PDF-1.7'), mimetype: 'application/pdf', originalname: 'bid.pdf' } });
    expect([res.statusCode, res.body.error]).toEqual([400, 'Only photos can be uploaded here']);
    expect(eng.all('SELECT id FROM attachments')).toHaveLength(0);
    expect(JSON.parse(flagRow('fl_mine').attachment_ids)).toEqual([]);
  });
});

describe('F2 success', () => {
  beforeEach(() => insertFlag({ id: 'fl_mine', attachment_ids: null }));

  test('a ticket attachment tagged flag, org from the ticket, appended under an id + org pinned UPDATE', async () => {
    const res = await photo('fl_mine', {
      file: { buffer: Buffer.from('jpegbytes'), mimetype: 'image/jpeg', originalname: 'rot.jpg' },
      fields: { upload_id: 'upl-12345678', organization_id: 999, entity_type: 'task', tags: '["completion"]' },
    });
    expect(res.statusCode).toBe(200);
    const att = eng.all('SELECT * FROM attachments');
    expect(att).toHaveLength(1);
    expect(att[0]).toMatchObject({ entity_type: 'service_ticket', entity_id: 'st_1', organization_id: 1, uploaded_by: null,
      tags: ['flag'], client_upload_id: 'upl-12345678', filename: 'rot.jpg', mime_type: 'image/jpeg' });
    expect(res.body).toEqual({ ok: true, photo: { id: att[0].id, thumb_url: att[0].thumb_url, web_url: att[0].web_url } });
    expect(global.__stores).toEqual(['service_ticket/st_1/' + att[0].id]);

    expect(JSON.parse(flagRow('fl_mine').attachment_ids)).toEqual([att[0].id]);
    const up = log.filter((q) => /^UPDATE service_ticket_flags SET attachment_ids/.test(q.sql));
    expect(up).toHaveLength(1);
    expect(up[0].sql).toMatch(/WHERE id = \$2 AND organization_id = \$3$/);
    expect(up[0].params.slice(1)).toEqual(['fl_mine', 1]);
    const pos = log.find((q) => /MAX\(position\)/.test(q.sql));
    expect(pos.sql).toMatch(/organization_id = \$2/);

    const ev = events('photo_added');
    expect(ev).toHaveLength(1);
    expect(ev[0].detail).toEqual({ flag_id: 'fl_mine', kind: 'flag', attachment_id: att[0].id });
    expect([ev[0].actor_kind, ev[0].share_id]).toEqual(['share', 'sh_a']);
  });

  test('the same upload_id again answers duplicate:true and stores nothing new', async () => {
    const upl = () => ({ file: { buffer: Buffer.from('jpegbytes'), mimetype: 'image/jpeg', originalname: 'a.jpg' }, fields: { upload_id: 'upl-abcdefgh' } });
    const first = await photo('fl_mine', upl());
    const puts = global.__puts.length;
    const second = await photo('fl_mine', upl());
    expect(second.body).toEqual({ ok: true, duplicate: true, photo: first.body.photo });
    expect(global.__puts.length).toBe(puts);
    expect(eng.all('SELECT id FROM attachments')).toHaveLength(1);
    expect(JSON.parse(flagRow('fl_mine').attachment_ids)).toHaveLength(1);
    expect(events('photo_added')).toHaveLength(1);
    const find = log.filter((q) => /FROM attachments WHERE organization_id = \$1 AND entity_type = \$2 AND entity_id = \$3 AND client_upload_id = \$4/.test(q.sql));
    expect(find[0].params).toEqual([1, 'service_ticket', 'st_1', 'upl-abcdefgh']);
  });

  test('an upload_id race: the loser discards its stored files and answers with the winner, which ends up on the flag once', async () => {
    hooks.push((sql) => {
      if (!/^INSERT INTO attachments/.test(sql)) return undefined;
      // The winner stored its row and has not yet put it on the flag.
      eng.db.prepare("INSERT INTO attachments (id, entity_type, entity_id, organization_id, mime_type, thumb_url, web_url, client_upload_id, tags) VALUES ('att_winner', 'service_ticket', 'st_1', 1, 'image/jpeg', 'tw', 'ww', 'upl-race0001', '[\"flag\"]')").run();
      const e = new Error('duplicate key value violates unique constraint "uq_attachments_client_upload"');
      e.code = '23505';
      e.constraint = 'uq_attachments_client_upload';
      throw e;
    });
    const res = await photo('fl_mine', { file: { buffer: Buffer.from('j'), mimetype: 'image/jpeg', originalname: 'a.jpg' }, fields: { upload_id: 'upl-race0001' } });
    expect(res.body).toEqual({ ok: true, duplicate: true, photo: { id: 'att_winner', thumb_url: 'tw', web_url: 'ww' } });
    expect(global.__deletes).toHaveLength(3);
    expect(JSON.parse(flagRow('fl_mine').attachment_ids)).toEqual(['att_winner']);
    // The winner's own append then finds its id already there and writes no
    // second line (see the concurrent-retry test below).
    expect(events('photo_added')).toHaveLength(1);
  });

  test('a retry arriving while the first try is between its two writes: one photo on the flag, one event, both answered 200', async () => {
    let fired = false;
    let retry = null;
    const upl = () => ({ file: { buffer: Buffer.from('j'), mimetype: 'image/jpeg', originalname: 'a.jpg' }, fields: { upload_id: 'upl-overlap01' } });
    hooks.push(async (sql, params) => {
      if (fired || !/^INSERT INTO attachments/.test(sql)) return undefined;
      fired = true;
      const out = await eng.pool.query(sql, params);
      retry = await photo('fl_mine', upl());
      return out;
    });
    const first = await photo('fl_mine', upl());
    const att = eng.all('SELECT id FROM attachments');
    expect(att).toHaveLength(1);
    expect([first.statusCode, first.body.duplicate]).toEqual([200, undefined]);
    expect(retry.body).toEqual({ ok: true, duplicate: true, photo: first.body.photo });
    expect(JSON.parse(flagRow('fl_mine').attachment_ids)).toEqual([att[0].id]);
    expect(events('photo_added')).toHaveLength(1);
  });

  // attachPhoto throws (the connection drops on the locked SELECT) after the
  // attachment row is stored.
  const throwOnLock = (also) => {
    let fired = false;
    let landedRead = false;
    hooks.push((sql) => {
      if (!fired && /FOR UPDATE$/.test(sql) && /^SELECT id, attachment_ids FROM service_ticket_flags/.test(sql)) {
        fired = true;
        throw new Error('Connection terminated unexpectedly');
      }
      if (also === 'landed-read' && fired && !landedRead && /in_window/.test(sql)) {
        landedRead = true;
        throw new Error('Connection terminated unexpectedly');
      }
      return undefined;
    });
  };
  const uplRetry = () => ({ file: { buffer: Buffer.from('jpegbytes'), mimetype: 'image/jpeg', originalname: 'a.jpg' }, fields: { upload_id: 'upl-dropped1' } });

  async function attachThrowsScenario(r) {
    throwOnLock();
    const first = await quietly(() => photo('fl_mine', uplRetry(), TOK.respond, r));
    const afterFirst = { rows: eng.all('SELECT id FROM attachments').length, deletes: global.__deletes.length };
    const second = await photo('fl_mine', uplRetry(), TOK.respond, r);
    const att = eng.all('SELECT id FROM attachments');
    return {
      first: [first.statusCode, first.body.error],
      afterFirst,
      second: [second.statusCode, second.body.duplicate === true],
      rows: att.length,
      onFlag: JSON.parse(flagRow('fl_mine').attachment_ids || '[]').length === 1 && JSON.parse(flagRow('fl_mine').attachment_ids)[0] === (att[0] && att[0].id),
      events: events('photo_added').length,
    };
  }
  const THROWN_OK = {
    first: [500, 'Something went wrong uploading that.'], afterFirst: { rows: 0, deletes: 3 },
    second: [200, false], rows: 1, onFlag: true, events: 1,
  };

  test('attachPhoto throws: the row and its files go, and the retry lands the photo on the flag', async () => {
    expect(await attachThrowsScenario()).toEqual(THROWN_OK);
    const del = log.find((q) => /^DELETE FROM attachments/.test(q.sql));
    expect(del.sql).toBe('DELETE FROM attachments WHERE id = $1 AND organization_id = $2');
    expect(del.params[1]).toBe(1);
  });

  test('MUTANT: skip the clean-up after attachPhoto throws -> the hidden row outlives the 500', async () => {
    const mut = mutantRouter([['            if (landed === false) await removeUnattached(orgId, attId, keys);\n', '']]);
    const out = await attachThrowsScenario(mut);
    expect(out).not.toEqual(THROWN_OK);
    expect(out.first[0]).toBe(500);
    expect(out.afterFirst).toEqual({ rows: 1, deletes: 0 });
  });

  async function orphanRetryScenario(r) {
    throwOnLock('landed-read');
    const first = await quietly(() => photo('fl_mine', uplRetry(), TOK.respond, r));
    const att = eng.all('SELECT id FROM attachments');
    const puts = global.__puts.length;
    const second = await photo('fl_mine', uplRetry(), TOK.respond, r);
    return {
      first: first.statusCode,
      rowKept: att.length === 1 && global.__deletes.length === 0,
      second: second.body,
      newPuts: global.__puts.length - puts,
      ids: JSON.parse(flagRow('fl_mine').attachment_ids || '[]'),
      events: events('photo_added').map((e) => e.detail),
      attId: att[0] && att[0].id,
    };
  }

  test('a stored row that never reached the flag is put on it by the retry, with its photo_added line, before duplicate:true', async () => {
    const out = await orphanRetryScenario();
    expect(out).toEqual({
      first: 500, rowKept: true,
      second: { ok: true, duplicate: true, photo: { id: out.attId, thumb_url: expect.any(String), web_url: expect.any(String) } },
      newPuts: 0, ids: [out.attId],
      events: [{ flag_id: 'fl_mine', kind: 'flag', attachment_id: out.attId }], attId: out.attId,
    });
  });

  test('MUTANT: answer duplicate as soon as the row exists -> the photo is on no flag and nobody can see it', async () => {
    const mut = mutantRouter([['          if (flags.flagHasPhoto(flag, found.id)) {', '          if (found) {']]);
    const out = await orphanRetryScenario(mut);
    expect(out.second.duplicate).toBe(true);
    expect(out.ids).toEqual([]);
    expect(out.events).toEqual([]);
  });

  async function committedThenDroppedScenario(r) {
    let fired = false;
    hooks.push(async (sql) => {
      if (fired || sql !== 'COMMIT') return undefined;
      fired = true;
      await eng.pool.query('COMMIT');
      throw new Error('Connection terminated unexpectedly');
    });
    const res = await quietly(() => photo('fl_mine', uplRetry(), TOK.respond, r));
    const att = eng.all('SELECT id FROM attachments');
    return {
      status: res.statusCode,
      rows: att.length,
      ids: JSON.parse(flagRow('fl_mine').attachment_ids || '[]').length,
      events: events('photo_added').length,
    };
  }

  test('the append committed and only its answer was lost: a success, the row kept, one event', async () => {
    expect(await committedThenDroppedScenario()).toEqual({ status: 200, rows: 1, ids: 1, events: 1 });
    expect(global.__deletes).toHaveLength(0);
  });

  test('MUTANT: treat every attachPhoto error as a failure -> a 500 for a photo that is on the flag', async () => {
    const mut = mutantRouter([['          if (landed !== true) {', '          if (true) {']]);
    expect(await committedThenDroppedScenario(mut)).toEqual({ status: 500, rows: 1, ids: 1, events: 0 });
  });

  test("an upload id that belongs to another flag's photo, or to a site photo, is a 409 and moves nothing", async () => {
    insertFlag({ id: 'fl_two', attachment_ids: '["att_other"]' });
    eng.db.prepare("INSERT INTO attachments (id, entity_type, entity_id, organization_id, mime_type, thumb_url, web_url, client_upload_id, tags) VALUES ('att_other', 'service_ticket', 'st_1', 1, 'image/jpeg', 't', 'w', 'upl-other001', '[\"flag\"]')").run();
    eng.db.prepare("INSERT INTO attachments (id, entity_type, entity_id, organization_id, mime_type, thumb_url, web_url, client_upload_id, tags) VALUES ('att_site', 'service_ticket', 'st_1', 1, 'image/jpeg', 't', 'w', 'upl-site0001', '[]')").run();
    const a = await photo('fl_mine', { file: { buffer: Buffer.from('j'), mimetype: 'image/jpeg' }, fields: { upload_id: 'upl-other001' } });
    const b = await photo('fl_mine', { file: { buffer: Buffer.from('j'), mimetype: 'image/jpeg' }, fields: { upload_id: 'upl-site0001' } });
    expect([a.statusCode, a.body.error]).toEqual([409, 'Something went wrong uploading that.']);
    expect([b.statusCode, b.body.error]).toEqual([409, 'Something went wrong uploading that.']);
    expect(JSON.parse(flagRow('fl_mine').attachment_ids || '[]')).toEqual([]);
    expect(JSON.parse(flagRow('fl_two').attachment_ids)).toEqual(['att_other']);
    expect(global.__puts).toHaveLength(0);
    expect(events('photo_added')).toHaveLength(0);
  });

  test('an upload id sent only as the X-Upload-Id header is stored on the row', async () => {
    const res = await photo('fl_mine', null, TOK.respond, null, { headers: { 'x-upload-id': 'upl-header01' } });
    expect(res.statusCode).toBe(200);
    expect(eng.all('SELECT client_upload_id FROM attachments')[0].client_upload_id).toBe('upl-header01');
  });

  test('losing the last slot inside the lock: the attachment row and its files go, and the answer is the cap', async () => {
    eng.db.exec("UPDATE service_ticket_flags SET attachment_ids = '[\"1\",\"2\",\"3\",\"4\",\"5\"]' WHERE id = 'fl_mine'");
    hooks.push((sql) => {
      if (!/^SELECT id, attachment_ids FROM service_ticket_flags/.test(sql)) return undefined;
      eng.db.exec("UPDATE service_ticket_flags SET attachment_ids = '[\"1\",\"2\",\"3\",\"4\",\"5\",\"6\"]' WHERE id = 'fl_mine'");
      return undefined;
    });
    const res = await photo('fl_mine');
    expect([res.statusCode, res.body.error]).toEqual([409, 'That problem already has 6 photos.']);
    expect(eng.all('SELECT id FROM attachments')).toHaveLength(0);
    const del = log.find((q) => /^DELETE FROM attachments/.test(q.sql));
    expect(del.sql).toBe('DELETE FROM attachments WHERE id = $1 AND organization_id = $2');
    expect(del.params[1]).toBe(1);
    expect(global.__deletes).toHaveLength(3);
    expect(events('photo_added')).toHaveLength(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * F3 — RESOLVE
 * ══════════════════════════════════════════════════════════════════════════*/
describe('F3 resolve', () => {
  beforeEach(() => {
    insertFlag({ id: 'fl_1', task_id: 'k1', author_label: 'Marco' });
    insertFlag({ id: 'fl_b', ticket_id: 'st_b', organization_id: 2, share_id: null });
  });
  const statusOf = (id) => flagRow(id).status;

  test('a foreign ticket is the missing-ticket 404, and the flag stays open', async () => {
    const rival = await resolve(RIVAL, 'st_1', 'fl_1', 'mine now');
    expect([rival.statusCode, rival.body.error]).toEqual([404, 'Service ticket not found']);
    const wide = await resolve(WIDE, 'st_b', 'fl_b', 'mine now');
    expect([wide.statusCode, wide.body.error]).toEqual([404, 'Service ticket not found']);
    const crossed = await resolve(WIDE, 'st_1', 'fl_b', 'wrong ticket');
    expect([crossed.statusCode, crossed.body.error]).toEqual([404, 'That problem is not on this ticket, or it was already resolved.']);
    expect([statusOf('fl_1'), statusOf('fl_b')]).toEqual(['open', 'open']);
  });

  test('a caller who can only VIEW the job, or holds no capability, is refused', async () => {
    const crew = await resolve(CREW, 'st_1', 'fl_1', 'handled');
    expect([crew.statusCode, crew.body.error]).toEqual([404, 'Service ticket not found']);
    const none = await resolve(NOBODY, 'st_1', 'fl_1', 'handled');
    expect(none.statusCode).toBe(403);
    expect((await drive(router, F3, { params: { id: 'st_1', flagId: 'fl_1' }, body: { note: 'x' } })).statusCode).toBe(401);
    expect(statusOf('fl_1')).toBe('open');
    expect(flagSql().filter((q) => /^UPDATE/.test(q.sql))).toHaveLength(0);
  });

  test('an empty note is the exact 400', async () => {
    for (const note of ['', '   ', undefined, 42]) {
      const res = await resolve(WIDE, 'st_1', 'fl_1', note);
      expect([res.statusCode, res.body.error]).toEqual([400, 'Say how it was handled — the crew sees this note.']);
    }
    expect(statusOf('fl_1')).toBe('open');
  });

  test('resolves with the office shape and a flag_resolved event', async () => {
    const res = await resolve(WIDE, 'st_1', 'fl_1', '  Unlocked the gate with the super  ');
    expect(res.statusCode).toBe(200);
    const row = flagRow('fl_1');
    expect(res.body).toEqual({
      ok: true,
      flag: {
        id: 'fl_1', task_id: 'k1', task_title: 'Bldg 784', category: 'no_access', note: 'Gate locked',
        author_label: 'Marco', via_revoked_link: false, status: 'resolved', created_at: row.created_at,
        resolved_at: row.resolved_at, resolved_by_name: 'Wendy Wide', resolution_note: 'Unlocked the gate with the super',
        photos: [],
      },
    });
    expect([row.resolved_by, row.organization_id]).toEqual([10, 1]);
    const ev = events('flag_resolved');
    expect(ev).toHaveLength(1);
    expect(ev[0].detail).toEqual({ flag_id: 'fl_1', category: 'no_access', task_id: 'k1' });
    expect([ev[0].actor_kind, ev[0].actor_user_id, ev[0].organization_id]).toEqual(['user', 10, 1]);
  });

  async function doubleResolve(r) {
    const first = await resolve(WIDE, 'st_1', 'fl_1', 'Unlocked', r);
    const second = await resolve(WIDE, 'st_1', 'fl_1', 'Unlocked again', r);
    return { first: first.statusCode, second: second.statusCode, error: second.body.error };
  }

  test('a second resolve is 404, and the UPDATE is pinned to org and open', async () => {
    expect(await doubleResolve())
      .toEqual({ first: 200, second: 404, error: 'That problem is not on this ticket, or it was already resolved.' });
    const up = log.filter((q) => /^UPDATE service_ticket_flags SET status = 'resolved'/.test(q.sql));
    expect(up).toHaveLength(2);
    expect(up[0].sql).toMatch(/organization_id = \$\d/);
    expect(up[0].sql).toMatch(/status = 'open'/);
    expect(flagRow('fl_1').resolution_note).toBe('Unlocked');
    expect(events('flag_resolved')).toHaveLength(1);
  });

  test("MUTANT: drop status = 'open' from the resolve UPDATE -> a second resolve answers 200", async () => {
    const mut = mutantRouter([],
      [["      WHERE id = $3 AND ticket_id = $4 AND organization_id = $5 AND status = 'open'", '      WHERE id = $3 AND ticket_id = $4 AND organization_id = $5']]);
    expect(await doubleResolve(mut))
      .not.toEqual({ first: 200, second: 404, error: 'That problem is not on this ticket, or it was already resolved.' });
  });

  test('a closed work order can still have its problems cleared', async () => {
    eng.db.exec("UPDATE service_tickets SET status = 'closed' WHERE id = 'st_1'");
    expect((await resolve(WIDE, 'st_1', 'fl_1', 'Handled before close')).statusCode).toBe(200);
  });

  test('a nonsense flag id is the not-found answer without a flag statement', async () => {
    const res = await resolve(WIDE, 'st_1', "fl' OR 1=1 --", 'x');
    expect([res.statusCode, res.body.error]).toEqual([404, 'That problem is not on this ticket, or it was already resolved.']);
    expect(flagSql()).toHaveLength(0);
  });
});
