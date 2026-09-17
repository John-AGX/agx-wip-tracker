// FLAG A PROBLEM (1.29) — THE THREE DOORS, MOUNTED ON THE SHARE ROUTER.
//
// ── WHAT THIS FILE PINS ───────────────────────────────────────────────────
// test/service-ticket-flag-routes.test.js drives the flag doors on a router it
// builds itself, with stand-in dependencies. This file drives them where they
// ship: registered onto server/routes/service-ticket-share-routes.js with THAT
// file's own token loader, crew gate, crew actor, name write, image pipeline,
// access check and ticket loader. So what is proved here is the wiring:
//
//   * the three routes exist on the shipped router, in the middleware order the
//     contract names, with the share file's own loadTicketShare and the
//     multerOnePhoto body parser behind flagPhotoGate;
//   * F1 raise: a view link is 403, an approved work order is 409, and a stored
//     flag's organization, ticket and link come from the rows in hand — never
//     the body;
//   * T1 (the crew read) carries `flags` as the crew whitelist, is best-effort,
//     and never shows another tenant's row;
//   * F3 resolve: another tenant's user gets 404 and the flag stays open.
//
// ── HOW ───────────────────────────────────────────────────────────────────
// The REAL routers against node:sqlite through the pg shim (tables from
// sqliteSchema), real requireAuth over a signed JWT and the real role cache.
// The office notice is replaced by a recorder. Each guard is then removed from
// a copy of the shipped file (CRLF normalised to LF, each anchor exactly once)
// and the same drive shows the outcome the guard exists to stop.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

global.__mountedPuts = [];
jest.mock('../server/storage', () => ({
  storage: {
    put: async (key) => { global.__mountedPuts.push(key); return 'https://cdn.test/' + key; },
    delete: async () => {},
  },
}));
global.__mountedNotices = [];
jest.mock('../server/services/work-order-notices', () => ({
  notifyProblemFlagged: async (db, opts) => { global.__mountedNotices.push(opts); return { sent: 0, skipped: 'test' }; },
}));

const ROUTES_DIR = path.join(__dirname, '..', 'server', 'routes');
const SHARE_ROUTES = path.join(ROUTES_DIR, 'service-ticket-share-routes.js');
const FLAG_ROUTES = path.join(ROUTES_DIR, 'service-ticket-flag-routes.js');

const TABLES = [
  'organizations', 'users', 'roles', 'jobs', 'job_access', 'leads', 'tasks', 'attachments',
  'service_tickets', 'service_ticket_events', 'service_ticket_shares', 'service_ticket_revisions',
  'service_ticket_flags',
];

const WIDE = 10;
const RIVAL = 50;
const USERS = {
  [WIDE]: { role: 'fm_wide', org: 1 },
  [RIVAL]: { role: 'fm_wide', org: 2 },
};

const TOK = { respond: 'a'.repeat(64), view: 'b'.repeat(64), approved: 'c'.repeat(64) };
const PUBLIC_KEYS = ['author_label', 'category', 'created_at', 'id', 'note', 'photos', 'resolution_note', 'resolved_at', 'status', 'task_id'];

let eng;
let auth;
let svc;
let RL;
let shareRouter;
let log;
let plants;
let jpeg;
let mutantPaths = [];

// 'YYYY-MM-DD HH:MM:SS' in UTC, the form the shim's CURRENT_TIMESTAMP writes.
function sqlTime(msAgo) {
  return new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace('T', ' ');
}
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

function seed() {
  const caps = (list) => "'" + JSON.stringify(list) + "'";
  const future = '2099-01-01T00:00:00.000Z';
  eng.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM roles; DELETE FROM jobs; DELETE FROM job_access;
    DELETE FROM leads; DELETE FROM tasks; DELETE FROM attachments; DELETE FROM service_tickets;
    DELETE FROM service_ticket_events; DELETE FROM service_ticket_shares; DELETE FROM service_ticket_revisions;
    DELETE FROM service_ticket_flags;

    INSERT INTO organizations (id, name, timezone) VALUES (1, 'AGX', 'America/New_York'), (2, 'Rival Co', 'America/New_York');
    INSERT INTO roles (name, capabilities) VALUES
      ('fm_wide', ${caps(['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'LEADS_VIEW', 'LEADS_EDIT'])});
    INSERT INTO users (id, name, email, role, organization_id) VALUES
      (10, 'Wendy Wide', 'w@agx.test', 'fm_wide', 1),
      (50, 'Rival Ray', 'r@rival.test', 'fm_wide', 2);
    INSERT INTO jobs (id, owner_id, data, organization_id) VALUES ('j1', 10, '{}', 1), ('j9', 50, '{}', 2);

    INSERT INTO service_tickets (id, organization_id, title, job_id, status, checklist, created_by, approval_notice_attempts, archived_at, created_at) VALUES
      ('st_1',  1, 'Latitude 28 rails', 'j1', 'in_progress', '[]', 10, 0, NULL, '2026-09-01 10:00:00'),
      ('st_ap', 1, 'Approved rails',    'j1', 'approved',    '[]', 10, 0, NULL, '2026-09-01 10:00:01'),
      ('st_b',  2, 'Rival rails',       'j9', 'in_progress', '[]', 50, 0, NULL, '2026-09-01 10:00:02');

    INSERT INTO tasks (id, organization_id, title, status, scope, owner_user_id, service_ticket_id, entity_type, entity_id, archived_at, created_at) VALUES
      ('k1', 1, 'Bldg 784', 'open', 'org', NULL, 'st_1', 'job', 'j1', NULL, '2026-09-02 08:00:00'),
      ('kp', 1, 'PRIVATE to-do', 'open', 'personal', 10, 'st_1', 'job', 'j1', NULL, '2026-09-02 08:00:01');
  `);
  const share = eng.db.prepare(
    'INSERT INTO service_ticket_shares (id, organization_id, ticket_id, token_hash, scope, hide_financials, recipient_email, recipient_name, expires_at, revoked_at, created_by, view_count, opened_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  share.run('sh_a', 1, 'st_1', svc.hashToken(TOK.respond), 'respond', 1, 'crew@sub.test', null, future, null, 10, 0, '2026-09-02 09:00:00', '2026-09-02 09:00:00');
  share.run('sh_v', 1, 'st_1', svc.hashToken(TOK.view), 'view', 1, 'viewer@sub.test', null, future, null, 10, 0, '2026-09-02 09:00:00', '2026-09-02 09:00:00');
  share.run('sh_ap', 1, 'st_ap', svc.hashToken(TOK.approved), 'respond', 1, 'crew@sub.test', null, future, null, 10, 0, '2026-09-02 09:00:00', '2026-09-02 09:00:00');
}

// Flags already on the work order, for the crew read and the office resolve.
function seedFlags() {
  const flag = eng.db.prepare(
    'INSERT INTO service_ticket_flags (id, organization_id, ticket_id, task_id, share_id, author_label, category, note, attachment_ids, status, resolved_by, resolved_at, resolution_note, client_ref, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  flag.run('f_open', 1, 'st_1', 'k1', 'sh_a', 'Marco', 'safety', 'Loose rail on stair 2', '["att_f1"]', 'open', null, null, null, 'ref-open-0001', sqlTime(HOUR));
  flag.run('f_recent', 1, 'st_1', 'kp', 'sh_a', 'Marco', 'no_access', 'Gate locked', '[]', 'resolved', 10, sqlTime(3 * DAY), 'Code is 4411', null, sqlTime(4 * DAY));
  flag.run('f_old', 1, 'st_1', null, 'sh_a', 'Marco', 'other', 'Old news', '[]', 'resolved', 10, sqlTime(20 * DAY), 'Handled', null, sqlTime(21 * DAY));
  // Another tenant's row that names this ticket id: only an org predicate keeps it out.
  flag.run('f_rival', 2, 'st_1', null, null, 'Rex', 'other', 'RIVAL NOTE', '[]', 'open', null, null, null, null, sqlTime(HOUR));
  eng.db.prepare(
    'INSERT INTO attachments (id, entity_type, entity_id, organization_id, folder, filename, mime_type, thumb_url, web_url, original_url, tags, position, uploaded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run('att_f1', 'service_ticket', 'st_1', 1, 'general', 'rail.jpg', 'image/jpeg', 'https://cdn.test/f1_t', 'https://cdn.test/f1_w', 'https://cdn.test/f1_o', '["flag"]', 0, sqlTime(HOUR));
}

beforeAll(async () => {
  eng = createPgSqlite(sqliteSchema(TABLES), {
    jsonColumns: ['checklist', 'capabilities', 'detail', 'fields', 'data', 'tags'],
  });
  const db = require('../server/db');
  db.pool.query = async (sql, params) => {
    const text = String(sql);
    log.push({ sql: text, params: params || [] });
    for (const p of plants) if (p.match.test(text)) p.run();
    return eng.pool.query(sql, params);
  };
  const realConnect = eng.pool.connect;
  db.pool.connect = async () => {
    const client = await realConnect();
    return {
      release: client.release,
      query: async (sql, params) => {
        log.push({ sql: String(sql), params: params || [] });
        return client.query(sql, params);
      },
    };
  };
  svc = require('../server/services/service-tickets');
  auth = require('../server/auth');
  auth.setRolePool(eng.pool);
  log = [];
  plants = [];
  seed();
  await auth.refreshRoleCache();
  RL = require('../server/rate-limit');
  shareRouter = require('../server/routes/service-ticket-share-routes');
  jpeg = await require('sharp')({ create: { width: 8, height: 8, channels: 3, background: '#557799' } }).jpeg().toBuffer();
});

const flush = () => new Promise((r) => setTimeout(r, 25));

beforeEach(() => {
  log = [];
  plants = [];
  global.__mountedPuts = [];
  global.__mountedNotices = [];
  seed();
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

function layerOf(router, method, routePath) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error('route not declared: ' + method + ' ' + routePath);
  return layer;
}

// Runs the declared chain from `fromHandler` on (the limiters in front of it
// are the library's). The multipart parser is skipped: the drive puts
// req.file and req.body in place itself.
async function drive(router, method, routePath, opts) {
  const o = opts || {};
  let chain = layerOf(router || shareRouter, method, routePath).route.stack.map((s) => s.handle);
  if (o.fromHandler) {
    const at = chain.findIndex((h) => h.name === o.fromHandler);
    if (at < 0) throw new Error('no handler named ' + o.fromHandler + ' on ' + routePath);
    chain = chain.slice(at);
  }
  chain = chain.filter((h) => h.name !== 'multerOnePhoto');
  const res = fakeRes();
  const req = {
    method: method.toUpperCase(),
    params: o.params || {},
    query: {},
    body: o.body || {},
    cookies: {},
    headers: o.as ? { authorization: 'Bearer ' + tokenFor(o.as) } : {},
    protocol: 'https',
    get: () => 'project86.test',
    file: o.file,
  };
  for (const h of chain) {
    let advanced = false;
    await h(req, res, (err) => { if (err) throw err; advanced = true; });
    if (!advanced) break;
  }
  return res;
}

const raise = (router, token, body) => drive(router, 'post', '/service-ticket-share/:token/flag',
  { params: { token }, body, fromHandler: 'loadTicketShare' });
const readLink = (router, token) => drive(router, 'get', '/service-ticket-share/:token',
  { params: { token: token || TOK.respond }, fromHandler: 'loadTicketShare' });
const resolve = (router, as, id, flagId, note) => drive(router, 'post', '/service-tickets/:id/flags/:flagId/resolve',
  { as, params: { id, flagId }, body: { note } });
const flagPhoto = (router, token, flagId) => drive(router, 'post', '/service-ticket-share/:token/flags/:flagId/photo',
  { params: { token, flagId }, fromHandler: 'loadTicketShare', file: { buffer: jpeg, mimetype: 'image/jpeg', originalname: 'rail.jpg', size: jpeg.length } });

const rows = (sql, ...args) => eng.all(sql, ...args);
const flagRows = () => rows('SELECT * FROM service_ticket_flags ORDER BY id');
const eventRows = () => rows('SELECT * FROM service_ticket_events ORDER BY created_at');
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

// ── mutant(): one guard removed from a copy of a shipped file ──────────────
function absolutize(src, fromDir) {
  return src.replace(/require\((['"])([^'"]+)\1\)/g, (_m, _q, spec) => {
    const resolved = spec.charAt(0) === '.'
      ? require.resolve(path.resolve(fromDir, spec))
      : require.resolve(spec, { paths: [fromDir] });
    return 'require(' + JSON.stringify(resolved.split(path.sep).join('/')) + ')';
  });
}

function mutateSource(file, pairs) {
  let out = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  for (const [find, replace] of pairs) {
    const hits = out.split(find).length - 1;
    if (hits !== 1) throw new Error('anchor not found' + (hits > 1 ? ' (ambiguous: ' + hits + ')' : '') + ': ' + JSON.stringify(find.slice(0, 120)));
    out = out.split(find).join(replace);
  }
  return out;
}

// redirects: { absolutePathOfShippedModule: absolutePathOfReplacement }
function writeMutant(file, pairs, redirects) {
  let out = absolutize(mutateSource(file, pairs), path.dirname(file));
  for (const [from, to] of Object.entries(redirects || {})) {
    const fromRef = 'require(' + JSON.stringify(from.split(path.sep).join('/')) + ')';
    if (out.split(fromRef).length - 1 !== 1) throw new Error('redirect not found: ' + fromRef);
    out = out.split(fromRef).join('require(' + JSON.stringify(to.split(path.sep).join('/')) + ')');
  }
  const p = path.join(os.tmpdir(), '_p86_flag_mounted_mutant_' + process.pid + '_' + Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, out, 'utf8');
  mutantPaths.push(p);
  return p;
}

const mutantShare = (pairs, redirects) => require(writeMutant(SHARE_ROUTES, pairs, redirects));

// The flag module with F1's crew gate removed, loaded through a share-router copy.
const F1_NO_GATE = [
  '        if (!crewGate(req, res)) return;\n        const share = req.share;\n        const ticket = req.ticket;\n        const body = req.body || {};\n',
  '        const share = req.share;\n        const ticket = req.ticket;\n        const body = req.body || {};\n',
];
const T1_FLAGS_NOT_BEST_EFFORT = [
  "      let flags = [];\n      try {\n        flags = await flagSvc.listCrewFlags(pool, ticket, tasks.rows.map((t) => t.id));\n      } catch (e) {\n        console.warn('[service-ticket-share] flags lookup failed', e && e.message);\n      }\n",
  '      const flags = await flagSvc.listCrewFlags(pool, ticket, tasks.rows.map((t) => t.id));\n',
];
const T1_NO_FLAGS_KEY = [
  '        send_back: sendBack,\n        flags: flags,\n',
  '        send_back: sendBack,\n',
];
const NOT_REGISTERED = [
  "require('./service-ticket-flag-routes').registerFlagRoutes(router, {\n",
  '({\n',
];
const RAW_UPLOAD = [
  '  upload: { single: () => multerOnePhoto },\n',
  '  upload,\n',
];
const SHARE_ANCHORS = [T1_FLAGS_NOT_BEST_EFFORT, T1_NO_FLAGS_KEY, NOT_REGISTERED, RAW_UPLOAD];

describe('the mutation harness', () => {
  test('an anchor that is not in the file throws instead of passing quietly', () => {
    expect(() => mutateSource(SHARE_ROUTES, [['this string is nowhere in the routes', 'x']])).toThrow(/anchor not found/);
  });
  test('every anchor is in its shipped file exactly once', () => {
    const share = fs.readFileSync(SHARE_ROUTES, 'utf8').replace(/\r\n/g, '\n');
    for (const [find] of SHARE_ANCHORS) expect([find.slice(0, 60), share.split(find).length - 1]).toEqual([find.slice(0, 60), 1]);
    const flag = fs.readFileSync(FLAG_ROUTES, 'utf8').replace(/\r\n/g, '\n');
    expect(flag.split(F1_NO_GATE[0]).length - 1).toBe(1);
  });
});

// ── the three doors are on the shipped router ──────────────────────────────
describe('mounted: the flag doors live on the share router, with its own dependencies', () => {
  test('F1, F2 and F3 are declared with the contract\'s middleware order', () => {
    const f1 = layerOf(shareRouter, 'post', '/service-ticket-share/:token/flag').route.stack.map((s) => s.handle);
    const f2 = layerOf(shareRouter, 'post', '/service-ticket-share/:token/flags/:flagId/photo').route.stack.map((s) => s.handle);
    const f3 = layerOf(shareRouter, 'post', '/service-tickets/:id/flags/:flagId/resolve').route.stack.map((s) => s.handle);
    const loader = layerOf(shareRouter, 'get', '/service-ticket-share/:token').route.stack.map((s) => s.handle)
      .find((h) => h.name === 'loadTicketShare');

    expect(f1.slice(0, 3)).toEqual([RL.stShareIpLimiter, RL.stShareFlagLimiter, loader]);
    expect(f1.map((h) => h.name).slice(2)).toEqual(['loadTicketShare', 'raiseFlag']);

    expect(f2.slice(0, 3)).toEqual([RL.stShareIpLimiter, RL.stShareWriteLimiter, loader]);
    // The gate runs BEFORE the body parser, and the parser is the share file's
    // own wrapper, which answers a too-large or cut-off photo in words.
    expect(f2.map((h) => h.name).slice(2)).toEqual(['loadTicketShare', 'flagPhotoGate', 'multerOnePhoto', 'addFlagPhoto']);
    const sitePhotoParser = layerOf(shareRouter, 'post', '/service-ticket-share/:token/photo').route.stack.map((s) => s.handle)
      .find((h) => h.name === 'multerOnePhoto');
    expect(f2[4]).toBe(sitePhotoParser);

    expect(f3.map((h) => h.name)).toEqual(['requireAuth', 'requireOrgId', 'resolveTicketFlag']);
  });

  test('MUTANT: the registration removed -> none of the three doors exists', () => {
    const mut = mutantShare([NOT_REGISTERED]);
    expect(() => layerOf(mut, 'post', '/service-ticket-share/:token/flag')).toThrow(/route not declared/);
    expect(() => layerOf(mut, 'post', '/service-ticket-share/:token/flags/:flagId/photo')).toThrow(/route not declared/);
    expect(() => layerOf(mut, 'post', '/service-tickets/:id/flags/:flagId/resolve')).toThrow(/route not declared/);
  });

  test('MUTANT: the raw upload middleware handed over -> the photo door loses the worded parser', () => {
    const mut = mutantShare([RAW_UPLOAD]);
    const f2 = layerOf(mut, 'post', '/service-ticket-share/:token/flags/:flagId/photo').route.stack.map((s) => s.handle.name);
    expect(f2).not.toContain('multerOnePhoto');
    expect(f2.indexOf('flagPhotoGate')).toBe(3);
  });
});

// ── F1 raise ──────────────────────────────────────────────────────────────
describe('F1 raise, through the share router', () => {
  const BODY = {
    category: 'safety', note: 'Loose rail on stair 2', task_id: 'k1', client_ref: 'abcdef123456',
    photos_expected: 2, name: 'Marco',
    // Keys a stranger might send. None of them may reach the row.
    organization_id: 2, share_id: 'sh_v', ticket_id: 'st_b', status: 'resolved',
    attachment_ids: ['att_x'], resolution_note: 'already handled',
  };

  test('a view link is 403 "This link is view-only." and nothing is written', async () => {
    const res = await raise(null, TOK.view, BODY);
    expect([res.statusCode, res.body]).toEqual([403, { error: 'This link is view-only.' }]);
    await flush();
    expect(flagRows()).toEqual([]);
    expect(eventRows()).toEqual([]);
    expect(rows("SELECT recipient_name FROM service_ticket_shares WHERE id = 'sh_v'")[0].recipient_name).toBeNull();
    expect(global.__mountedNotices).toHaveLength(0);
  });

  test('an approved work order is 409 with the crew rule\'s own sentence and nothing is written', async () => {
    const res = await raise(null, TOK.approved, BODY);
    expect([res.statusCode, res.body]).toEqual([409, { error: svc.crewSubtasksWritable('approved').reason }]);
    expect(res.body.error).toBe('The office has approved this work order. Ask them to reopen it for changes.');
    await flush();
    expect(flagRows()).toEqual([]);
    expect(eventRows()).toEqual([]);
  });

  test('success: the row\'s organization, ticket and link come from the rows in hand, never the body', async () => {
    const res = await raise(null, TOK.respond, BODY);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Object.keys(res.body.flag).sort()).toEqual(PUBLIC_KEYS);
    expect(res.body.flag).toEqual(expect.objectContaining({
      task_id: 'k1', category: 'safety', note: 'Loose rail on stair 2', author_label: 'Marco',
      status: 'open', resolved_at: null, resolution_note: null, photos: [],
    }));
    await flush();

    const stored = flagRows();
    expect(stored).toHaveLength(1);
    const row = stored[0];
    expect([Number(row.organization_id), row.ticket_id, row.share_id, row.task_id, row.status]).toEqual([1, 'st_1', 'sh_a', 'k1', 'open']);
    expect([row.resolution_note, row.resolved_at, row.resolved_by, row.client_ref]).toEqual([null, null, null, 'abcdef123456']);
    expect(parse(row.attachment_ids)).toEqual([]);
    expect(res.body.flag.id).toBe(row.id);

    // The timeline line is shape only, on this ticket in this org, by this link.
    const ev = eventRows();
    expect(ev.map((e) => e.kind)).toEqual(['flag_raised']);
    expect([Number(ev[0].organization_id), ev[0].ticket_id, ev[0].actor_kind, ev[0].share_id]).toEqual([1, 'st_1', 'share', 'sh_a']);
    expect(parse(ev[0].detail)).toEqual({ flag_id: row.id, category: 'safety', task_id: 'k1' });

    // The name lands on this link, and the office is told once.
    expect(rows("SELECT recipient_name FROM service_ticket_shares WHERE id = 'sh_a'")[0].recipient_name).toBe('Marco');
    expect(global.__mountedNotices).toHaveLength(1);
    expect(global.__mountedNotices[0].flag.id).toBe(row.id);
    expect(global.__mountedNotices[0].ticket.id).toBe('st_1');
  });

  test('a building from another ticket is 404 and nothing is stored', async () => {
    const res = await raise(null, TOK.respond, Object.assign({}, BODY, { task_id: 'kp' }));
    expect([res.statusCode, res.body]).toEqual([404, { error: 'That building is not on this work order.' }]);
    expect(flagRows()).toEqual([]);
  });

  test('MUTANT: F1 without crewGate -> a view link stores a flag', async () => {
    const flagMutant = writeMutant(FLAG_ROUTES, [F1_NO_GATE]);
    const mut = mutantShare([], { [require.resolve(FLAG_ROUTES)]: flagMutant });
    const res = await raise(mut, TOK.view, BODY);
    expect(res.statusCode).toBe(200);
    await flush();
    expect(flagRows().map((r) => [r.share_id, r.status])).toEqual([['sh_v', 'open']]);
  });

  test('MUTANT: F1 without crewGate -> an approved work order takes a flag', async () => {
    const flagMutant = writeMutant(FLAG_ROUTES, [F1_NO_GATE]);
    const mut = mutantShare([], { [require.resolve(FLAG_ROUTES)]: flagMutant });
    const res = await raise(mut, TOK.approved, Object.assign({}, BODY, { task_id: null }));
    expect(res.statusCode).toBe(200);
    await flush();
    expect(flagRows().map((r) => r.ticket_id)).toEqual(['st_ap']);
  });
});

// ── F2 one photo, through the share router ────────────────────────────────
describe('F2 flag photo, through the share router', () => {
  test('a photo from the link that raised the flag lands on the flag as a ticket photo tagged flag', async () => {
    seedFlags();
    const res = await flagPhoto(null, TOK.respond, 'f_open');
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    const id = res.body.photo.id;
    expect(Object.keys(res.body.photo).sort()).toEqual(['id', 'thumb_url', 'web_url']);
    await flush();
    const att = rows('SELECT * FROM attachments WHERE id = ?', id)[0];
    expect([att.entity_type, att.entity_id, Number(att.organization_id), parse(att.tags), att.uploaded_by]).toEqual(['service_ticket', 'st_1', 1, ['flag'], null]);
    expect(parse(rows("SELECT attachment_ids FROM service_ticket_flags WHERE id = 'f_open'")[0].attachment_ids)).toEqual(['att_f1', id]);
    const ev = eventRows().filter((e) => e.kind === 'photo_added');
    expect(ev.map((e) => parse(e.detail))).toEqual([{ flag_id: 'f_open', kind: 'flag', attachment_id: id }]);
  });

  test('a view link is 403 and nothing reaches storage', async () => {
    seedFlags();
    const res = await flagPhoto(null, TOK.view, 'f_open');
    expect([res.statusCode, res.body]).toEqual([403, { error: 'This link is view-only.' }]);
    expect(global.__mountedPuts).toEqual([]);
  });
});

// ── T1 the crew read carries flags ─────────────────────────────────────────
describe('T1: the crew read lists flags as the crew whitelist', () => {
  test('open and recently resolved flags, newest first, whitelisted; another tenant\'s row and old resolved ones are absent', async () => {
    seedFlags();
    const res = await readLink(null, TOK.respond);
    expect(res.statusCode).toBe(200);
    const flags = res.body.flags;
    expect(flags.map((f) => f.id)).toEqual(['f_open', 'f_recent']);
    for (const f of flags) expect(Object.keys(f).sort()).toEqual(PUBLIC_KEYS);
    expect(flags[0]).toEqual(expect.objectContaining({
      task_id: 'k1', category: 'safety', note: 'Loose rail on stair 2', author_label: 'Marco', status: 'open',
      photos: [{ id: 'att_f1', thumb_url: 'https://cdn.test/f1_t', web_url: 'https://cdn.test/f1_w' }],
    }));
    // A private to-do is not a live building on the link: the flag reads as ticket-level.
    expect([flags[1].task_id, flags[1].status, flags[1].resolution_note]).toEqual([null, 'resolved', 'Code is 4411']);
    const json = JSON.stringify(flags);
    for (const leak of ['sh_a', 'ref-open-0001', 'RIVAL NOTE', 'f1_o', 'rail.jpg', 'organization_id', 'resolved_by', 'client_ref', 'attachment_ids', 'share_id']) {
      expect(json).not.toContain(leak);
    }
  });

  test('a view link sees the flags too', async () => {
    seedFlags();
    const res = await readLink(null, TOK.view);
    expect(res.statusCode).toBe(200);
    expect(res.body.flags.map((f) => f.id)).toEqual(['f_open', 'f_recent']);
  });

  test('no flags reads as an empty list', async () => {
    const res = await readLink(null, TOK.respond);
    expect([res.statusCode, res.body.flags]).toEqual([200, []]);
  });

  test('a failing flags read costs the list, never the work order, and only warns', async () => {
    seedFlags();
    plants.push({ match: /FROM service_ticket_flags/, run: () => { throw new Error('planted: flags unavailable'); } });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    let res;
    try {
      res = await readLink(null, TOK.respond);
      expect(warn.mock.calls.some((c) => c[0] === '[service-ticket-share] flags lookup failed')).toBe(true);
      expect(err.mock.calls.some((c) => /flags/.test(String(c[0])))).toBe(false);
    } finally {
      warn.mockRestore();
      err.mockRestore();
    }
    expect(res.statusCode).toBe(200);
    expect(res.body.flags).toEqual([]);
    expect(res.body.tasks.map((t) => t.id)).toEqual(['k1']);
  });

  test('MUTANT: the flags read not best-effort -> one failed lookup takes down the whole crew read', async () => {
    const mut = mutantShare([T1_FLAGS_NOT_BEST_EFFORT]);
    plants.push({ match: /FROM service_ticket_flags/, run: () => { throw new Error('planted: flags unavailable'); } });
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    let res;
    try { res = await readLink(mut, TOK.respond); } finally { err.mockRestore(); }
    expect(res.statusCode).toBe(500);
  });

  test('MUTANT: the flags key dropped from the answer -> the crew page has nothing to show', async () => {
    seedFlags();
    const mut = mutantShare([T1_NO_FLAGS_KEY]);
    const res = await readLink(mut, TOK.respond);
    expect(res.statusCode).toBe(200);
    expect(res.body.flags).toBeUndefined();
  });
});

// ── F3 resolve ────────────────────────────────────────────────────────────
describe('F3 resolve, through the share router', () => {
  test('another tenant\'s user is 404 and the flag stays open', async () => {
    seedFlags();
    const res = await resolve(null, RIVAL, 'st_1', 'f_open', 'Rival says done');
    expect([res.statusCode, res.body]).toEqual([404, { error: 'Service ticket not found' }]);
    await flush();
    const row = rows("SELECT status, resolved_by, resolution_note FROM service_ticket_flags WHERE id = 'f_open'")[0];
    expect([row.status, row.resolved_by, row.resolution_note]).toEqual(['open', null, null]);
    expect(eventRows().filter((e) => e.kind === 'flag_resolved')).toEqual([]);
  });

  test('another tenant\'s user cannot reach its own org\'s row planted under this ticket id either', async () => {
    seedFlags();
    const res = await resolve(null, RIVAL, 'st_1', 'f_rival', 'Rival says done');
    expect(res.statusCode).toBe(404);
    expect(rows("SELECT status FROM service_ticket_flags WHERE id = 'f_rival'")[0].status).toBe('open');
  });

  test('control: the org\'s own editor resolves it, in the office shape, with a timeline line', async () => {
    seedFlags();
    const res = await resolve(null, WIDE, 'st_1', 'f_open', 'Rail re-fastened');
    expect(res.statusCode).toBe(200);
    expect(res.body.flag).toEqual(expect.objectContaining({
      id: 'f_open', status: 'resolved', resolution_note: 'Rail re-fastened', resolved_by_name: 'Wendy Wide', task_title: 'Bldg 784',
    }));
    await flush();
    const row = rows("SELECT status, resolved_by FROM service_ticket_flags WHERE id = 'f_open'")[0];
    expect([row.status, Number(row.resolved_by)]).toEqual(['resolved', 10]);
    const ev = eventRows().filter((e) => e.kind === 'flag_resolved');
    expect(ev.map((e) => [Number(e.actor_user_id), parse(e.detail)])).toEqual([[10, { flag_id: 'f_open', category: 'safety', task_id: 'k1' }]]);
  });
});
