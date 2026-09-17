// WORK ORDERS 1.29, STEP I2 — THE CREW LINK'S WIRING BETWEEN WAVES 2 AND 3.
//
// ── WHAT THIS FILE PINS ───────────────────────────────────────────────────
// Wave 2 built the parts; this step plugs three of them into
// server/routes/service-ticket-share-routes.js.
//
//   (1) Every approval notice the crew link starts is handed to
//       services/inflight.track(promise, 'ticket_approval'), so a deploy's
//       SIGTERM drain waits for it instead of cutting the office's email off
//       half way. The crew's save still never waits on it.
//
//   (2) POST /service-ticket-share/:token/subtasks/:taskId/done decides on the
//       LOCKED ticket row. loadTicketShare read the ticket a moment before; if
//       the office approves (or cancels) in between, the crew rule is asked
//       again inside setSubtaskDone (gate: subtaskDoor.crewGate) and the tick
//       is refused with 409 work_order_locked instead of finishing a building
//       on an approved work order. Refusals carry their code, and the notice
//       describes result.ticket — the locked row with its status after the
//       recount — never the copy read before the lock.
//
//   1.30 adds two more, on the two TICKET-LEVEL crew doors in the same file:
//
//   (4) The field report (PATCH) and the site photo hold the CREW rule
//       (svc.crewSubtasksWritable), not merely svc.isTerminal — so an APPROVED
//       work order refuses both, before any transaction opens and before a
//       photo is decoded, and the PATCH asks again of the locked row. The
//       revision door keeps isTerminal: it writes only to the quarantine table.
//
//   (5) The field report's note carries a client_ref, so a save that landed and
//       lost its answer does not append the crew's note to the office's field
//       log a second time.
//
//   (3) The crew's name is written to the share by one statement
//       (applyCrewName) that carries organization_id, taken from the share row
//       its token loaded. Every other share write on the doors names the
//       organization too.
//
// ── HOW ───────────────────────────────────────────────────────────────────
// The REAL router against node:sqlite through the pg shim, tables from
// sqliteSchema, the harness of crew-finish-concurrency.test.js. A race is
// INTERLEAVED: a hook runs the office's write right before the statement a
// real race would land ahead of. sqlite has one connection, so an office write
// made inside the crew's transaction is re-applied after a ROLLBACK (in
// Postgres it is another connection's committed write).
//
// The fixture has no primary keys (sqliteSchema declares none), which lets a
// rival tenant hold a share row with the SAME id: the org predicate is then
// measured by the rows that did or did not change, not by reading SQL text.
//
// Each guard is then removed from a copy of the shipped file (CRLF-normalised
// anchors that must match exactly once) and the same drive shows the outcome
// the guard exists to stop.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

jest.mock('../server/storage', () => ({
  storage: {
    put: async (key) => 'https://cdn.test/' + key,
    delete: async () => {},
  },
}));

const SHARE_ROUTES = path.join(__dirname, '..', 'server', 'routes', 'service-ticket-share-routes.js');

const TABLES = [
  'organizations', 'users', 'jobs', 'leads', 'tasks', 'attachments',
  'service_tickets', 'service_ticket_events', 'service_ticket_shares', 'service_ticket_revisions',
];

const APPROVED_REFUSAL = 'The office has approved this work order. Ask them to reopen it for changes.';
const CANCELLED_REFUSAL = 'This work order is cancelled and can no longer be updated.';
const PHOTO_REFUSAL = 'Add a completion photo before marking this complete.';
const LOCK_READ = /^\s*SELECT \* FROM service_tickets WHERE id = \$1 AND organization_id = \$2 FOR UPDATE\s*$/;

let eng;
let db;
let svc;
let notify;
let inflight;
let shareRouter;
let realConnect;
let realNotify;
let realTrack;
let token;
let proposeToken;
let jpeg;

let calls;        // what notifyAwaitingApproval was asked
let labels;       // what inflight.track was labelled
let log;          // every statement, from either path
let hooks;        // [{ re, run }] — each runs once, before its statement
let replay;       // office writes to re-apply after a ROLLBACK
let releaseNotice;

function runHooks(sql) {
  const text = String(sql);
  for (const h of hooks.slice()) {
    if (!h.re.test(text)) continue;
    hooks.splice(hooks.indexOf(h), 1);
    h.run();
    replay.push(h.run);
  }
}

function seed() {
  token = svc.genToken();
  proposeToken = svc.genToken();
  const exp = new Date(Date.now() + 86400000).toISOString();
  // The rival tenant's share rows reuse the ids sh1 and sh2 on purpose (see
  // the header): only an organization predicate tells them apart.
  eng.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM jobs; DELETE FROM tasks; DELETE FROM attachments;
    DELETE FROM service_tickets; DELETE FROM service_ticket_events; DELETE FROM service_ticket_shares;
    DELETE FROM service_ticket_revisions;

    INSERT INTO organizations (id, name, timezone) VALUES (1, 'AGX', 'America/New_York'), (2, 'Rival Co', 'America/New_York');
    INSERT INTO users (id, name, email, organization_id) VALUES (10, 'Wendy PM', 'w@agx.test', 1), (20, 'Rex Rival', 'r@rival.test', 2);
    INSERT INTO jobs (id, owner_id, data, organization_id) VALUES ('j1', 10, '{}', 1), ('j9', 20, '{}', 2);
    INSERT INTO service_tickets (id, organization_id, title, job_id, status, checklist, guest_log, created_by, approval_notice_attempts, created_at) VALUES
      ('st_1', 1, 'Latitude 28 rails', 'j1', 'in_progress', '[]', NULL, 10, 0, '2026-09-01 10:00:00'),
      ('st_r', 2, 'Rival rails', 'j9', 'in_progress', '[]', NULL, 20, 0, '2026-09-01 10:00:00');
    INSERT INTO service_ticket_shares (id, organization_id, ticket_id, token_hash, scope, hide_financials, recipient_name, expires_at, created_by, view_count, opened_at, last_used_at, created_at) VALUES
      ('sh1', 1, 'st_1', '${svc.hashToken(token)}', 'respond', 1, NULL, '${exp}', 10, 0, '2026-09-02 09:00:00', NULL, '2026-09-02 09:00:00'),
      ('sh2', 1, 'st_1', '${svc.hashToken(proposeToken)}', 'propose', 1, NULL, '${exp}', 10, 0, '2026-09-02 09:00:00', NULL, '2026-09-02 09:00:00'),
      ('sh1', 2, 'st_r', '${svc.hashToken(svc.genToken())}', 'respond', 1, NULL, '${exp}', 20, 0, '2026-09-02 09:00:00', NULL, '2026-09-02 09:00:00'),
      ('sh2', 2, 'st_r', '${svc.hashToken(svc.genToken())}', 'propose', 1, NULL, '${exp}', 20, 0, '2026-09-02 09:00:00', NULL, '2026-09-02 09:00:00');
  `);
}

// n buildings on st_1, the first `done` of them done; every building carries a
// completion photo unless photos is false.
function buildings(n, done, photos) {
  const rows = [];
  const atts = [];
  for (let i = 0; i < n; i += 1) {
    rows.push(`('k${i}', 1, 'Bldg ${700 + i}', '${i < done ? 'done' : 'open'}', 'org', 'st_1', 'job', 'j1', NULL, '2026-09-02 08:00:${String(i).padStart(2, '0')}')`);
    atts.push(`('att_k${i}', 'task', 'k${i}', 1, 'general', 'k${i}.jpg', 'image/jpeg', '["completion"]', 0, '2026-09-02 08:30:00')`);
  }
  eng.db.exec('INSERT INTO tasks (id, organization_id, title, status, scope, service_ticket_id, entity_type, entity_id, archived_at, created_at) VALUES ' + rows.join(', '));
  if (photos !== false) {
    eng.db.exec('INSERT INTO attachments (id, entity_type, entity_id, organization_id, folder, filename, mime_type, tags, position, uploaded_at) VALUES ' + atts.join(', '));
  }
}

beforeAll(async () => {
  eng = createPgSqlite(sqliteSchema(TABLES), {
    jsonColumns: ['checklist', 'detail', 'data', 'tags', 'fields'],
  });
  db = require('../server/db');
  db.pool.query = async (sql, params) => {
    log.push({ sql: String(sql), params: params || [] });
    runHooks(sql);
    return eng.pool.query(sql, params);
  };
  realConnect = eng.pool.connect;
  db.pool.connect = async () => {
    const client = await realConnect();
    return {
      release: client.release,
      query: async (sql, params) => {
        log.push({ sql: String(sql), params: params || [] });
        runHooks(sql);
        const out = await client.query(sql, params);
        if (/^\s*ROLLBACK\s*$/i.test(String(sql))) replay.forEach((fn) => fn());
        return out;
      },
    };
  };
  svc = require('../server/services/service-tickets');
  notify = require('../server/services/service-ticket-notify');
  inflight = require('../server/services/inflight');
  shareRouter = require('../server/routes/service-ticket-share-routes');
  jpeg = await require('sharp')({ create: { width: 8, height: 8, channels: 3, background: '#557799' } }).jpeg().toBuffer();
});

const flush = () => new Promise((r) => setTimeout(r, 25));

let mutantPaths = [];
beforeEach(() => {
  log = [];
  hooks = [];
  replay = [];
  calls = [];
  labels = [];
  releaseNotice = null;
  seed();
  realNotify = notify.notifyAwaitingApproval;
  notify.notifyAwaitingApproval = async (pool, opts) => { calls.push(opts); return { sent: 0 }; };
  inflight._reset();
  realTrack = inflight.track;
  inflight.track = (promise, label) => { labels.push(label); return realTrack(promise, label); };
});
afterEach(async () => {
  if (releaseNotice) releaseNotice();
  await flush();
  await inflight.drain(500);
  inflight.track = realTrack;
  inflight._reset();
  notify.notifyAwaitingApproval = realNotify;
  for (const p of mutantPaths) {
    try { delete require.cache[require.resolve(p)]; } catch (e) { /* never loaded */ }
    try { fs.unlinkSync(p); } catch (e) { /* already gone */ }
  }
  mutantPaths = [];
});
afterAll(async () => {
  await flush();
  db.pool.query = async () => ({ rows: [], rowCount: 0 });
  if (eng) eng.close();
});

// A notice that stays in flight until the test lets it go.
function holdNotices() {
  let release;
  const gate = new Promise((r) => { release = r; });
  releaseNotice = release;
  notify.notifyAwaitingApproval = async (pool, opts) => { calls.push(opts); await gate; return { sent: 1 }; };
}

// ── the drive: the whole chain from loadTicketShare on ─────────────────────
function fakeRes() {
  const res = { statusCode: 200, body: undefined, headersSent: false };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.body = p; res.headersSent = true; return res; };
  res.set = () => res;
  res.setHeader = () => res;
  return res;
}

async function drive(router, method, routePath, opts) {
  const o = opts || {};
  const layer = (router || shareRouter).stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error('route not declared: ' + method + ' ' + routePath);
  let chain = layer.route.stack.map((s) => s.handle);
  const at = chain.findIndex((h) => h.name === 'loadTicketShare');
  if (at < 0) throw new Error('no loadTicketShare on ' + routePath);
  // The body parser is multer's; the drive puts req.file in place itself.
  chain = chain.slice(at).filter((h) => h.name !== 'multerOnePhoto');
  const res = fakeRes();
  const req = {
    method: method.toUpperCase(), params: Object.assign({ token }, o.params || {}), query: {}, body: o.body || {},
    headers: {}, protocol: 'https', get: () => 'project86.test', file: o.file,
  };
  for (const h of chain) {
    let advanced = false;
    await h(req, res, (err) => { if (err) throw err; advanced = true; });
    if (!advanced) break;
  }
  return res;
}

const tick = (router, taskId, body) => drive(router, 'post', '/service-ticket-share/:token/subtasks/:taskId/done',
  { params: { taskId }, body: body || { done: true } });
const finish = (router, body) => drive(router, 'patch', '/service-ticket-share/:token',
  { body: body || { status: 'work_complete' } });
const sitePhoto = (router, body) => drive(router, 'post', '/service-ticket-share/:token/photo',
  { body: body || {}, file: { buffer: jpeg, mimetype: 'image/jpeg', originalname: 'site.jpg', size: jpeg.length } });

const ticketRow = () => eng.all("SELECT * FROM service_tickets WHERE id = 'st_1' AND organization_id = 1")[0];
const taskStatus = (id) => eng.all('SELECT status FROM tasks WHERE id = ? AND organization_id = 1', id)[0].status;
const eventKinds = () => eng.all("SELECT kind FROM service_ticket_events WHERE ticket_id = 'st_1' AND organization_id = 1").map((e) => e.kind);
const shareRow = (id, org) => eng.all('SELECT * FROM service_ticket_shares WHERE id = ? AND organization_id = ?', id, org)[0];
const nameWrites = () => log.filter((q) => /UPDATE service_ticket_shares SET recipient_name/.test(q.sql));
const officeDoes = (sql) => () => eng.db.exec(sql);

// ── mutant(): one guard removed from a copy of the shipped file ────────────
function mutateSource(pairs) {
  let out = fs.readFileSync(SHARE_ROUTES, 'utf8').replace(/\r\n/g, '\n');
  for (const [find, replace] of pairs) {
    const hits = out.split(find).length - 1;
    if (hits !== 1) throw new Error('anchor not found' + (hits > 1 ? ' (ambiguous: ' + hits + ')' : '') + ': ' + JSON.stringify(find.slice(0, 120)));
    out = out.split(find).join(replace);
  }
  return out;
}

function mutant(pairs) {
  let out = mutateSource(pairs);
  const dir = path.dirname(SHARE_ROUTES);
  out = out.replace(/require\((['"])([^'"]+)\1\)/g, (_m, _q, spec) => {
    const resolved = spec.charAt(0) === '.'
      ? require.resolve(path.resolve(dir, spec))
      : require.resolve(spec, { paths: [dir] });
    return 'require(' + JSON.stringify(resolved.split(path.sep).join('/')) + ')';
  });
  const p = path.join(os.tmpdir(), '_p86_i2_crew_mutant_' + process.pid + '_' + Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, out, 'utf8');
  mutantPaths.push(p);
  return require(p);
}

const UNTRACKED_BUILDING_NOTICE = [
  '        inflight.track(ticketNotify.notifyAwaitingApproval(pool, {\n          ticket: result.ticket,',
  '        (ticketNotify.notifyAwaitingApproval(pool, {\n          ticket: result.ticket,',
];
const UNTRACKED_FINISH_NOTICE = [
  '        inflight.track(ticketNotify.notifyAwaitingApproval(pool, {\n          ticket: row,',
  '        (ticketNotify.notifyAwaitingApproval(pool, {\n          ticket: row,',
];
const OLD_BUILDING_LABEL = [
  "          reason: 'all_subtasks_done',\n          sharedBy: share.created_by,\n        }), 'ticket_approval');",
  "          reason: 'all_subtasks_done',\n          sharedBy: share.created_by,\n        }), 'approval notice (crew building)');",
];
const NO_LOCKED_GATE = [
  '        gate: subtaskDoor.crewGate,\n',
  '',
];
const NO_REFUSAL_CODE = [
  '        if (result.code) refusal.code = result.code;\n',
  '',
];
const PRE_LOCK_NOTICE_TICKET = [
  '          ticket: result.ticket,\n',
  '          ticket: req.ticket,\n',
];
const NAME_WITHOUT_ORG = [
  "      'UPDATE service_ticket_shares SET recipient_name = $1 WHERE id = $2 AND organization_id = $3 AND recipient_name IS NULL',\n      [newName, share.id, share.organization_id]",
  "      'UPDATE service_ticket_shares SET recipient_name = $1 WHERE id = $2 AND recipient_name IS NULL',\n      [newName, share.id]",
];
const NOTE_BUMP_WITHOUT_ORG = [
  "      if (!result.ok) return res.status(result.status).json({ error: result.error });\n      pool.query('UPDATE service_ticket_shares SET last_used_at = NOW() WHERE id = $1 AND organization_id = $2',\n        [share.id, req.ticket.organization_id]).catch(function () {});",
  "      if (!result.ok) return res.status(result.status).json({ error: result.error });\n      pool.query('UPDATE service_ticket_shares SET last_used_at = NOW() WHERE id = $1',\n        [share.id]).catch(function () {});",
];
const ALL_ANCHORS = [UNTRACKED_BUILDING_NOTICE, UNTRACKED_FINISH_NOTICE, OLD_BUILDING_LABEL, NO_LOCKED_GATE,
  NO_REFUSAL_CODE, PRE_LOCK_NOTICE_TICKET, NAME_WITHOUT_ORG, NOTE_BUMP_WITHOUT_ORG];

describe('the mutation harness', () => {
  test('an anchor that is not in the file throws instead of passing quietly', () => {
    expect(() => mutant([['this string is nowhere in the routes', 'x']])).toThrow(/anchor not found/);
  });
  test('every anchor is in the shipped file exactly once', () => {
    const src = fs.readFileSync(SHARE_ROUTES, 'utf8').replace(/\r\n/g, '\n');
    for (const [find] of ALL_ANCHORS) expect([find.slice(0, 60), src.split(find).length - 1]).toEqual([find.slice(0, 60), 1]);
  });
});

// ── (1) the shutdown drain covers every approval notice ─────────────────────
// Every call of ticketNotify.notifyAwaitingApproval( in the file: whether the
// line opens inflight.track( around it, and the label after the options close.
function noticeCalls(src) {
  const out = [];
  const needle = 'ticketNotify.notifyAwaitingApproval(';
  let i = src.indexOf(needle);
  while (i >= 0) {
    const lineStart = src.lastIndexOf('\n', i) + 1;
    const close = src.indexOf('})', i);
    const m = /^\}\),\s*'([^']*)'\);/.exec(src.slice(close, close + 60));
    out.push({
      line: src.slice(0, i).split('\n').length,
      tracked: /inflight\.track\($/.test(src.slice(lineStart, i)),
      label: m ? m[1] : null,
    });
    i = src.indexOf(needle, i + 1);
  }
  return out;
}
const untracked = (src) => noticeCalls(src).filter((c) => !c.tracked || c.label !== 'ticket_approval');

describe('(1) every approval notice on the crew link is tracked for the shutdown drain', () => {
  test('ledger: both notices in the file (the crew finish and the last building) are track(…, \'ticket_approval\')', () => {
    const src = fs.readFileSync(SHARE_ROUTES, 'utf8').replace(/\r\n/g, '\n');
    const found = noticeCalls(src);
    expect(found).toHaveLength(2);
    expect(untracked(src)).toEqual([]);
  });

  test('ledger MUTANTS: an untracked call or another label is named', () => {
    expect(untracked(mutateSource([UNTRACKED_BUILDING_NOTICE]))).toHaveLength(1);
    expect(untracked(mutateSource([UNTRACKED_FINISH_NOTICE]))).toHaveLength(1);
    expect(untracked(mutateSource([OLD_BUILDING_LABEL]))).toEqual([expect.objectContaining({ tracked: true, label: 'approval notice (crew building)' })]);
  });

  test('the last building: the crew is answered at once, and the notice stays in the drain until it settles', async () => {
    buildings(2, 1);
    holdNotices();
    const res = await tick(null, 'k1');
    expect([res.statusCode, res.body]).toEqual([200, { ok: true, done: true, ticket_status: 'work_complete' }]);
    expect(calls).toHaveLength(1);
    expect(labels).toEqual(['ticket_approval']);
    expect(inflight.size()).toBe(1);
    expect(await inflight.drain(20)).toBe(1);      // a deploy would wait on it
    releaseNotice();
    expect(await inflight.drain(1000)).toBe(0);
  });

  test('MUTANT: the building notice untracked -> the drain does not know the email is still going', async () => {
    const mut = mutant([UNTRACKED_BUILDING_NOTICE]);
    buildings(2, 1);
    holdNotices();
    const res = await tick(mut, 'k1');
    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);                  // the send is under way…
    expect(inflight.size()).toBe(0);                // …and SIGTERM would not wait for it
    expect(await inflight.drain(20)).toBe(0);
  });

  test('MUTANT: the old label -> the notice is tracked under a name the shutdown log does not use', async () => {
    const mut = mutant([OLD_BUILDING_LABEL]);
    buildings(2, 1);
    expect((await tick(mut, 'k1')).statusCode).toBe(200);
    expect(labels).toEqual(['approval notice (crew building)']);
  });

  test('Finish whole work order: the same, tracked as ticket_approval', async () => {
    buildings(2, 2);
    holdNotices();
    const res = await finish();
    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].reason).toBe('marked_complete');
    expect(labels).toEqual(['ticket_approval']);
    expect(inflight.size()).toBe(1);
    releaseNotice();
    expect(await inflight.drain(1000)).toBe(0);
  });

  test('MUTANT: the finish notice untracked -> nothing in the drain', async () => {
    const mut = mutant([UNTRACKED_FINISH_NOTICE]);
    buildings(2, 2);
    holdNotices();
    expect((await finish(mut)).statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(inflight.size()).toBe(0);
  });

  test('a tick that leaves buildings open starts no notice and tracks nothing', async () => {
    buildings(3, 1);
    expect((await tick(null, 'k1')).statusCode).toBe(200);
    expect([calls.length, labels.length, inflight.size()]).toEqual([0, 0, 0]);
  });
});

// ── (2) the crew done door decides on the locked row ───────────────────────
describe('(2) the crew building door asks the crew rule again of the LOCKED ticket', () => {
  test('the office approves between the link loading and the lock: 409 work_order_locked, nothing written, nobody told', async () => {
    buildings(2, 1);
    hooks.push({ re: LOCK_READ, run: officeDoes("UPDATE service_tickets SET status = 'approved' WHERE id = 'st_1' AND organization_id = 1") });
    const res = await tick(null, 'k1');
    expect([res.statusCode, res.body]).toEqual([409, { error: APPROVED_REFUSAL, code: 'work_order_locked' }]);
    expect(hooks).toHaveLength(0);                   // the interleave really ran
    await flush();
    expect(taskStatus('k1')).toBe('open');
    expect(ticketRow().status).toBe('approved');
    expect(eventKinds()).toEqual([]);
    expect(calls).toHaveLength(0);
    // It went through the transaction and rolled back.
    expect(log.map((q) => q.sql.trim()).filter((s) => /^(BEGIN|COMMIT|ROLLBACK)$/.test(s))).toEqual(['BEGIN', 'ROLLBACK']);
  });

  test('the office cancels in the same gap: 409 work_order_locked with the cancelled sentence', async () => {
    buildings(2, 0);
    hooks.push({ re: LOCK_READ, run: officeDoes("UPDATE service_tickets SET status = 'cancelled' WHERE id = 'st_1' AND organization_id = 1") });
    const res = await tick(null, 'k0');
    expect([res.statusCode, res.body]).toEqual([409, { error: CANCELLED_REFUSAL, code: 'work_order_locked' }]);
    expect(taskStatus('k0')).toBe('open');
  });

  test('the crew undoing a tick after the office approved is refused the same way', async () => {
    buildings(2, 2);
    hooks.push({ re: LOCK_READ, run: officeDoes("UPDATE service_tickets SET status = 'approved' WHERE id = 'st_1' AND organization_id = 1") });
    const res = await tick(null, 'k1', { done: false });
    expect([res.statusCode, res.body.code]).toEqual([409, 'work_order_locked']);
    expect(taskStatus('k1')).toBe('done');
  });

  test('control: with no interleave the same tick lands', async () => {
    buildings(2, 0);
    const res = await tick(null, 'k1');
    expect([res.statusCode, res.body]).toEqual([200, { ok: true, done: true, ticket_status: 'in_progress' }]);
    expect(taskStatus('k1')).toBe('done');
    expect(eventKinds()).toEqual(['subtask_completed']);
  });

  test('MUTANT: no gate on the locked row -> a building is finished on a work order the office just approved', async () => {
    const mut = mutant([NO_LOCKED_GATE]);
    buildings(2, 1);
    hooks.push({ re: LOCK_READ, run: officeDoes("UPDATE service_tickets SET status = 'approved' WHERE id = 'st_1' AND organization_id = 1") });
    const res = await tick(mut, 'k1');
    expect(res.statusCode).toBe(200);
    expect(taskStatus('k1')).toBe('done');
    expect(ticketRow().status).toBe('approved');
    expect(eventKinds()).toEqual(['subtask_completed']);
  });

  test('the pre-lock check still answers a view link with 403 before any transaction opens', async () => {
    buildings(1, 0);
    eng.db.exec("UPDATE service_ticket_shares SET scope = 'view' WHERE id = 'sh1' AND organization_id = 1");
    const res = await tick(null, 'k0');
    expect([res.statusCode, res.body]).toEqual([403, { error: 'This link is view-only.' }]);
    expect(log.some((q) => /^\s*BEGIN\s*$/.test(q.sql))).toBe(false);
  });

  test('a refusal carries its code: no completion photo is 409 completion_photo_required', async () => {
    buildings(1, 0, false);
    const res = await tick(null, 'k0');
    expect([res.statusCode, res.body]).toEqual([409, { error: PHOTO_REFUSAL, code: 'completion_photo_required' }]);
    expect(taskStatus('k0')).toBe('open');
  });

  test('a building that is not on this work order is 404 with no code', async () => {
    buildings(1, 0);
    const res = await tick(null, 'k_nowhere');
    expect([res.statusCode, res.body]).toEqual([404, { error: 'That subtask is not on this work order.' }]);
  });

  test('MUTANT: the code dropped -> the page cannot tell a missing photo from any other refusal', async () => {
    const mut = mutant([NO_REFUSAL_CODE]);
    buildings(1, 0, false);
    const res = await tick(mut, 'k0');
    expect([res.statusCode, res.body]).toEqual([409, { error: PHOTO_REFUSAL }]);
  });

  test('the notice describes the locked row after the recount, not the copy loaded before the lock', async () => {
    buildings(2, 1);
    hooks.push({ re: LOCK_READ, run: officeDoes("UPDATE service_tickets SET title = 'Latitude 28 rails, north gate', assignee_user_id = 10 WHERE id = 'st_1' AND organization_id = 1") });
    const res = await tick(null, 'k1');
    expect(res.statusCode).toBe(200);
    expect(hooks).toHaveLength(0);
    expect(calls).toHaveLength(1);
    const t = calls[0].ticket;
    expect([t.id, t.status, t.title, Number(t.assignee_user_id)]).toEqual(['st_1', 'work_complete', 'Latitude 28 rails, north gate', 10]);
    expect([calls[0].reason, calls[0].sharedBy, calls[0].actor.kind, calls[0].actor.shareId]).toEqual(['all_subtasks_done', 10, 'share', 'sh1']);
  });

  test('MUTANT: the pre-lock ticket -> the office is told about a work order still In progress, under its old title', async () => {
    const mut = mutant([PRE_LOCK_NOTICE_TICKET]);
    buildings(2, 1);
    hooks.push({ re: LOCK_READ, run: officeDoes("UPDATE service_tickets SET title = 'Latitude 28 rails, north gate' WHERE id = 'st_1' AND organization_id = 1") });
    expect((await tick(mut, 'k1')).statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect([calls[0].ticket.status, calls[0].ticket.title]).toEqual(['in_progress', 'Latitude 28 rails']);
  });
});

// ── (3) the crew name write names the organization ─────────────────────────
// Every share UPDATE statement in the file, with the text up to its parameter
// list.
function shareUpdates(src) {
  const out = [];
  let i = src.indexOf('UPDATE service_ticket_shares');
  while (i >= 0) {
    out.push({ line: src.slice(0, i).split('\n').length, text: src.slice(i, src.indexOf('[', i)) });
    i = src.indexOf('UPDATE service_ticket_shares', i + 1);
  }
  return out;
}
const unscopedShareUpdates = (src) => shareUpdates(src).filter((u) => !/\borganization_id = \$\d+/.test(u.text));

describe('(3) the crew name, and every other share write, carries the organization', () => {
  test('the site photo door (T3): the name lands on this link\'s row and not on a rival tenant\'s row with the same id', async () => {
    const res = await sitePhoto(null, { name: 'Marco' });
    expect(res.statusCode).toBe(200);
    expect(res.body.photo.kind).toBe('site');
    expect(shareRow('sh1', 1).recipient_name).toBe('Marco');
    expect(shareRow('sh1', 2).recipient_name).toBeNull();
    const w = nameWrites();
    expect(w).toHaveLength(1);
    expect(w[0].sql).toBe('UPDATE service_ticket_shares SET recipient_name = $1 WHERE id = $2 AND organization_id = $3 AND recipient_name IS NULL');
    expect(w[0].params).toEqual(['Marco', 'sh1', 1]);
  });

  test('MUTANT: the org predicate dropped -> the rival tenant\'s link is renamed too', async () => {
    const mut = mutant([NAME_WITHOUT_ORG]);
    expect((await sitePhoto(mut, { name: 'Marco' })).statusCode).toBe(200);
    expect(shareRow('sh1', 1).recipient_name).toBe('Marco');
    expect(shareRow('sh1', 2).recipient_name).toBe('Marco');
  });

  test('behaviour unchanged: the name is still write-once, and an unnamed save writes no name', async () => {
    eng.db.exec("UPDATE service_ticket_shares SET recipient_name = 'Ana Ruiz' WHERE id = 'sh1' AND organization_id = 1");
    expect((await sitePhoto(null, { name: 'Someone Else' })).statusCode).toBe(200);
    expect(shareRow('sh1', 1).recipient_name).toBe('Ana Ruiz');
    expect(nameWrites()).toHaveLength(0);
    eng.db.exec("UPDATE service_ticket_shares SET recipient_name = NULL WHERE id = 'sh1' AND organization_id = 1");
    log = [];
    expect((await sitePhoto(null, {})).statusCode).toBe(200);
    expect(nameWrites()).toHaveLength(0);
    expect(shareRow('sh1', 1).recipient_name).toBeNull();
  });

  const DOORS = [
    ['the field report (PATCH)', () => drive(null, 'patch', '/service-ticket-share/:token', { body: { name: 'Marco', note: 'Rails set' } }), 'sh1'],
    ['a building note', () => drive(null, 'post', '/service-ticket-share/:token/subtasks/:taskId/note', { params: { taskId: 'k0' }, body: { name: 'Marco', note: 'Post rotted' } }), 'sh1'],
    ['a building tick', () => tick(null, 'k0', { name: 'Marco', done: true }), 'sh1'],
    ['a suggested change (T4)', () => drive(null, 'post', '/service-ticket-share/:token/revision', { params: { token: proposeToken }, body: { name: 'Marco', fields: { scope_proposed: 'Replace rail 3' } } }), 'sh2'],
  ];
  for (const [what, run, shareId] of DOORS) {
    test(what + ': the same one write, scoped to the link\'s organization', async () => {
      buildings(1, 0);
      const res = await run();
      expect(res.statusCode).toBe(200);
      await flush();
      expect(shareRow(shareId, 1).recipient_name).toBe('Marco');
      expect(shareRow(shareId, 2).recipient_name).toBeNull();
      expect(nameWrites().map((q) => q.params)).toEqual([['Marco', shareId, 1]]);
      // The link's own bookkeeping lands on its row only.
      expect(shareRow(shareId, 1).last_used_at).not.toBeNull();
      expect(shareRow(shareId, 2).last_used_at).toBeNull();
    });
  }

  test('opening the link (T1) counts the view on this link\'s row only', async () => {
    const res = await drive(null, 'get', '/service-ticket-share/:token', {});
    expect(res.statusCode).toBe(200);
    await flush();
    expect(Number(shareRow('sh1', 1).view_count)).toBe(1);
    expect(Number(shareRow('sh1', 2).view_count)).toBe(0);
    expect(shareRow('sh1', 2).last_used_at).toBeNull();
  });

  test('MUTANT: the building note\'s bookkeeping without the org -> the rival tenant\'s link is marked used', async () => {
    const mut = mutant([NOTE_BUMP_WITHOUT_ORG]);
    buildings(1, 0);
    const res = await drive(mut, 'post', '/service-ticket-share/:token/subtasks/:taskId/note', { params: { taskId: 'k0' }, body: { note: 'Post rotted' } });
    expect(res.statusCode).toBe(200);
    await flush();
    expect(shareRow('sh1', 2).last_used_at).not.toBeNull();
  });

  test('ledger: one name write in the file, and every share UPDATE names the organization', () => {
    const src = fs.readFileSync(SHARE_ROUTES, 'utf8').replace(/\r\n/g, '\n');
    expect(src.split('UPDATE service_ticket_shares SET recipient_name').length - 1).toBe(1);
    expect(shareUpdates(src).length).toBeGreaterThanOrEqual(7);
    expect(unscopedShareUpdates(src)).toEqual([]);
  });

  test('ledger MUTANTS: an unscoped share UPDATE is named', () => {
    expect(unscopedShareUpdates(mutateSource([NAME_WITHOUT_ORG])).map((u) => u.text)).toEqual([
      "UPDATE service_ticket_shares SET recipient_name = $1 WHERE id = $2 AND recipient_name IS NULL',\n      ",
    ]);
    expect(unscopedShareUpdates(mutateSource([NOTE_BUMP_WITHOUT_ORG]))).toHaveLength(1);
  });
});

// ── (4) the ticket-level crew doors hold the CREW rule, not just "not terminal"
// ───────────────────────────────────────────────────────────────────────────
// 1.30. The field report (PATCH) and the site photo (T3) used to ask only
// svc.isTerminal(), which is closed|cancelled — so a link that is still live
// could write a photo and a field-log note onto an APPROVED work order. The
// office then could not take the photo off again: work-order-photo-guard makes
// a site photo on an approved work order undeletable, and the only way out is
// to unapprove, which NULLs approved_at and approved_by. Both doors now ask
// svc.crewSubtasksWritable, the same rule crewGate asks on the building and
// flag doors, and the PATCH asks it AGAIN of the locked row.
const NOT_ISSUED_REFUSAL = 'This work order has not been issued yet.';
const CLOSED_REFUSAL = 'This work order is closed and can no longer be updated.';
const PATCH_LOCK_READ = /SELECT \* FROM service_tickets WHERE id = \$1 AND organization_id = \$2 AND archived_at IS NULL FOR UPDATE/;

const TERMINAL_ONLY_PATCH = [
  '      const gate = svc.crewSubtasksWritable(ticket.status);\n      if (!gate.ok) {\n        return res.status(409).json({ error: gate.reason });\n      }\n\n      const body = req.body || {};',
  "      if (svc.isTerminal(ticket.status)) {\n        return res.status(409).json({ error: 'This work order is ' + ticket.status + ' and can no longer be updated.' });\n      }\n\n      const body = req.body || {};",
];
const TERMINAL_ONLY_LOCKED = [
  '      const lockedGate = svc.crewSubtasksWritable(locked.status);\n      if (!lockedGate.ok) {\n        return refuse(409, { error: lockedGate.reason });\n      }',
  "      if (svc.isTerminal(locked.status)) {\n        return refuse(409, { error: 'This work order is ' + locked.status + ' and can no longer be updated.' });\n      }",
];
const TERMINAL_ONLY_PHOTO = [
  '      const gate = svc.crewSubtasksWritable(ticket.status);\n      if (!gate.ok) {\n        return res.status(409).json({ error: gate.reason });\n      }\n      await applyCrewName(share, req.body);',
  "      if (svc.isTerminal(ticket.status)) {\n        return res.status(409).json({ error: 'This work order is ' + ticket.status + ' and can no longer be updated.' });\n      }\n      await applyCrewName(share, req.body);",
];

const setStatus = (s) => eng.db.exec("UPDATE service_tickets SET status = '" + s + "' WHERE id = 'st_1' AND organization_id = 1");
const guestLog = () => ticketRow().guest_log;
const siteAttachments = () => eng.all("SELECT * FROM attachments WHERE entity_type = 'service_ticket' AND entity_id = 'st_1'");
const report = (router, body) => drive(router, 'patch', '/service-ticket-share/:token', { body: body });
const opened = () => log.map((q) => q.sql.trim()).filter((s) => /^(BEGIN|COMMIT|ROLLBACK)$/.test(s));

describe('(4) an APPROVED work order is the office\'s: the field report and the site photo refuse it', () => {
  test('the field report: 409 with the approved sentence, no transaction, nothing in the field log', async () => {
    setStatus('approved');
    const res = await report(null, { note: 'Touched up the north rail after sign-off' });
    expect([res.statusCode, res.body]).toEqual([409, { error: APPROVED_REFUSAL }]);
    expect(guestLog()).toBeNull();
    expect(eventKinds()).toEqual([]);
    expect(opened()).toEqual([]);          // refused before any transaction opened
  });

  test('a checklist tick and a status move on an approved work order are refused by the same door', async () => {
    setStatus('approved');
    for (const body of [{ checklist: [{ text: 'Pull permit', done: true }] }, { status: 'work_complete' }, { status: 'in_progress' }]) {
      log = [];
      const res = await report(null, body);
      expect([body, res.statusCode, res.body]).toEqual([body, 409, { error: APPROVED_REFUSAL }]);
    }
    expect(ticketRow().status).toBe('approved');
  });

  test('the site photo door: 409 with the approved sentence, and the photo is never decoded or stored', async () => {
    setStatus('approved');
    const res = await sitePhoto(null, {});
    expect([res.statusCode, res.body]).toEqual([409, { error: APPROVED_REFUSAL }]);
    expect(siteAttachments()).toEqual([]);
    // The refusal lands BEFORE storeShareImage: no position read, no insert.
    expect(log.some((q) => /MAX\(position\)/i.test(q.sql))).toBe(false);
    expect(log.some((q) => /INSERT INTO attachments/i.test(q.sql))).toBe(false);
    expect(eventKinds()).toEqual([]);
  });

  test('the office approves BETWEEN the link loading and the lock: refused on the locked row, rolled back, nothing written', async () => {
    hooks.push({ re: PATCH_LOCK_READ, run: officeDoes("UPDATE service_tickets SET status = 'approved' WHERE id = 'st_1' AND organization_id = 1") });
    const res = await report(null, { note: 'Rails set on side A' });
    expect([res.statusCode, res.body]).toEqual([409, { error: APPROVED_REFUSAL }]);
    expect(hooks).toHaveLength(0);                   // the interleave really ran
    expect(guestLog()).toBeNull();
    expect(eventKinds()).toEqual([]);
    expect(opened()).toEqual(['BEGIN', 'ROLLBACK']);
  });

  test('a DRAFT work order gets the crew\'s own sentence, and closed still says what it always said', async () => {
    setStatus('draft');
    expect((await report(null, { note: 'x' })).body).toEqual({ error: NOT_ISSUED_REFUSAL });
    expect((await sitePhoto(null, {})).body).toEqual({ error: NOT_ISSUED_REFUSAL });
    setStatus('closed');
    log = [];
    expect((await report(null, { note: 'x' })).body).toEqual({ error: CLOSED_REFUSAL });
    expect((await sitePhoto(null, {})).body).toEqual({ error: CLOSED_REFUSAL });
    expect(guestLog()).toBeNull();
  });

  test('control: on a live work order both doors still work', async () => {
    const res = await report(null, { note: 'Rails set on side A' });
    expect(res.statusCode).toBe(200);
    expect(guestLog()).toContain('Rails set on side A');
    const ph = await sitePhoto(null, {});
    expect(ph.statusCode).toBe(200);
    expect(siteAttachments()).toHaveLength(1);
  });

  test('MUTANT: the field report back on isTerminal -> the crew\'s note lands in an approved work order\'s field log', async () => {
    const mut = mutant([TERMINAL_ONLY_PATCH, TERMINAL_ONLY_LOCKED]);
    setStatus('approved');
    const res = await report(mut, { note: 'Touched up the north rail after sign-off' });
    expect(res.statusCode).toBe(200);
    expect(guestLog()).toContain('Touched up the north rail after sign-off');
    expect(eventKinds()).toEqual(['note_added']);
  });

  test('MUTANT: only the PRE-LOCK gate reverted -> the locked gate still refuses, but a transaction had to open to find out', async () => {
    const mut = mutant([TERMINAL_ONLY_PATCH]);
    setStatus('approved');
    const res = await report(mut, { note: 'Touched up the north rail after sign-off' });
    expect([res.statusCode, res.body]).toEqual([409, { error: APPROVED_REFUSAL }]);
    expect(guestLog()).toBeNull();
    // The cheap answer is what the pre-lock gate is for: the shipped file gives
    // it with no BEGIN at all (the first test in this block).
    expect(opened()).toEqual(['BEGIN', 'ROLLBACK']);
  });

  test('MUTANT: the LOCKED gate back on isTerminal -> an approval that commits mid-save is written over', async () => {
    const mut = mutant([TERMINAL_ONLY_LOCKED]);
    hooks.push({ re: PATCH_LOCK_READ, run: officeDoes("UPDATE service_tickets SET status = 'approved' WHERE id = 'st_1' AND organization_id = 1") });
    const res = await report(mut, { note: 'Rails set on side A' });
    expect(res.statusCode).toBe(200);
    expect(guestLog()).toContain('Rails set on side A');
  });

  test('MUTANT: the site photo door back on isTerminal -> a photo the office cannot delete lands on an approved work order', async () => {
    const mut = mutant([TERMINAL_ONLY_PHOTO]);
    setStatus('approved');
    const res = await sitePhoto(mut, {});
    expect(res.statusCode).toBe(200);
    expect(siteAttachments()).toHaveLength(1);
  });

  test('ledger: the revision door (T4) keeps isTerminal — it writes only to the quarantine table', async () => {
    const src = fs.readFileSync(SHARE_ROUTES, 'utf8').replace(/\r\n/g, '\n');
    expect(src.split('svc.isTerminal(').length - 1).toBe(1);
    setStatus('approved');
    const res = await drive(null, 'post', '/service-ticket-share/:token/revision',
      { params: { token: proposeToken }, body: { fields: { scope_proposed: 'Replace rail 3' } } });
    expect(res.statusCode).toBe(200);
    expect(eng.all("SELECT * FROM service_ticket_revisions WHERE ticket_id = 'st_1' AND organization_id = 1")).toHaveLength(1);
    expect(guestLog()).toBeNull();
  });
});

// ── (5) a retried field report appends the crew's note ONCE ────────────────
// 1.30. On a bad signal the PATCH can land and its answer never reach the
// phone: the page keeps the note in the box, the crew taps Save again, and the
// office's field log used to read the same line twice under two timestamps.
// The page mints one client_ref per unsent note; the door looks for the
// note_added event this link already wrote under that key, under the same FOR
// UPDATE that holds the ticket row, and appends nothing the second time.
const NO_NOTE_DEDUPE = [
  '      let noteAlreadyStored = false;\n      if (wantsNote && noteRef) {',
  '      let noteAlreadyStored = false;\n      if (false && noteRef) {',
];

const REF = 'a1b2c3d4e5f60718';
const noteEvents = () => eng.all("SELECT detail FROM service_ticket_events WHERE ticket_id = 'st_1' AND organization_id = 1 AND kind = 'note_added'")
  .map((r) => (typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail));
const countIn = (hay, needle) => String(hay == null ? '' : hay).split(needle).length - 1;

describe('(5) the note door is idempotent: a retried Save report is one note', () => {
  test('the same note sent twice under the same client_ref lands once, and the retry still answers ok', async () => {
    const body = { note: 'Rail post replaced, tread 3 re-cut', client_ref: REF };
    const first = await report(null, body);
    const again = await report(null, Object.assign({}, body));
    expect([first.statusCode, again.statusCode]).toEqual([200, 200]);
    expect(countIn(guestLog(), 'Rail post replaced, tread 3 re-cut')).toBe(1);
    expect(eventKinds()).toEqual(['note_added']);
    expect(noteEvents()).toEqual([{ fields: ['note'], client_ref: REF }]);
  });

  test('the key is on the event, and the lookup carries the ticket, the organization and the link', async () => {
    await report(null, { note: 'Rails set', client_ref: REF });
    const lookups = log.filter((q) => /kind = 'note_added' AND detail->>'client_ref'/.test(q.sql));
    expect(lookups).toHaveLength(1);
    expect(lookups[0].params).toEqual(['st_1', 1, 'sh1', REF]);
    expect(lookups[0].sql).toMatch(/organization_id = \$2/);
  });

  test('a DIFFERENT link sending the same key still writes: the lookup is this link\'s own', async () => {
    await report(null, { note: 'Rails set', client_ref: REF });
    const other = await drive(null, 'patch', '/service-ticket-share/:token',
      { params: { token: proposeToken }, body: { note: 'Stringer shimmed', client_ref: REF } });
    expect(other.statusCode).toBe(200);
    expect(guestLog()).toContain('Stringer shimmed');
    expect(eventKinds()).toEqual(['note_added', 'note_added']);
  });

  test('a NEW note under a new key still lands, and an old page with no key keeps writing', async () => {
    await report(null, { note: 'First note', client_ref: REF });
    await report(null, { note: 'Second note', client_ref: 'ffffffff00000000' });
    expect(countIn(guestLog(), 'First note')).toBe(1);
    expect(countIn(guestLog(), 'Second note')).toBe(1);
    // No key at all (a page cached before 1.30): the door must still write.
    await report(null, { note: 'Legacy note' });
    await report(null, { note: 'Legacy note' });
    expect(countIn(guestLog(), 'Legacy note')).toBe(2);
  });

  test('a retried "Yes, finish it" with a note: the status is already there and the note is not doubled', async () => {
    buildings(2, 2);
    const body = { status: 'work_complete', note: 'All six stair runs done', client_ref: REF };
    expect((await report(null, body)).statusCode).toBe(200);
    expect((await report(null, Object.assign({}, body))).statusCode).toBe(200);
    expect(ticketRow().status).toBe('work_complete');
    expect(countIn(guestLog(), 'All six stair runs done')).toBe(1);
    expect(eventKinds().filter((k) => k === 'note_added')).toHaveLength(1);
    await flush();
    // The second arrival moves no status, so the office is told once.
    expect(calls).toHaveLength(1);
  });

  test('a retry that also ticks the checklist: the tick lands, the note does not repeat', async () => {
    eng.db.exec('UPDATE service_tickets SET checklist = \'[{"text":"Pull permit","done":false}]\' WHERE id = \'st_1\' AND organization_id = 1');
    await report(null, { note: 'Permit pulled', client_ref: REF });
    const again = await report(null, { note: 'Permit pulled', client_ref: REF, checklist: [{ text: 'Pull permit', done: true }] });
    expect(again.statusCode).toBe(200);
    expect(countIn(guestLog(), 'Permit pulled')).toBe(1);
    const cl = ticketRow().checklist;
    expect(typeof cl === 'string' ? JSON.parse(cl) : cl).toEqual([{ text: 'Pull permit', done: true }]);
    expect(eventKinds()).toEqual(['note_added', 'field_changed']);
  });

  test('MUTANT: no dedupe lookup -> the retried report is two lines in the office\'s field log', async () => {
    const mut = mutant([NO_NOTE_DEDUPE]);
    const body = { note: 'Rail post replaced, tread 3 re-cut', client_ref: REF };
    await report(mut, body);
    await report(mut, Object.assign({}, body));
    expect(countIn(guestLog(), 'Rail post replaced, tread 3 re-cut')).toBe(2);
    expect(eventKinds()).toEqual(['note_added', 'note_added']);
  });

  test('a client_ref that is not a key is ignored, and the note is written', async () => {
    for (const bad of ['short', '   ', 'x'.repeat(65), 'has spaces here', 42, null]) {
      seed();
      const res = await report(null, { note: 'Bad key note', client_ref: bad });
      expect([bad, res.statusCode]).toEqual([bad, 200]);
      expect(countIn(guestLog(), 'Bad key note')).toBe(1);
      expect(noteEvents()).toEqual([{ fields: ['note'] }]);
    }
  });
});
