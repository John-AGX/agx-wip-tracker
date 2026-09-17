// ONE PHOTO, ONE ROW — IDEMPOTENT OFFICE UPLOADS AND HEIC, EXECUTED (Work Orders 1.29, A6/A7).
//
// On a bad signal a photo can reach POST /api/attachments/:entityType/:entityId
// and its answer never make it back, so the page sends it again with the same
// upload_id. The second arrival must find the first one's row and answer
// duplicate:true instead of storing the photo twice. A HEIC photo (which the
// server cannot decode) is refused on a task or a work order with a sentence the
// person can act on, and kept as a plain file anywhere else.
//
// HOW: the REAL attachment router over HTTP with multipart bodies (real multer,
// real sharp on a real JPEG, real requireAuth on a signed JWT) against
// node:sqlite through the pg shim, over tables derived from server/db.js.
// Then each rule is removed from a copy of the shipped router (CRLF normalised,
// anchor required exactly once) and the same drive shows the defect return.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const sharp = require('sharp');

const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

let mockEng = null;
let mockHook = null;
function mockRun(sql, params) {
  return mockHook ? mockHook(sql, params) : mockEng.pool.query(sql, params);
}
jest.mock('../server/db', () => ({
  pool: {
    query: async (sql, params) => mockRun(sql, params),
    connect: async () => ({
      query: async (sql, params) => mockRun(sql, params),
      release: () => {},
    }),
  },
}));
const mockStorageCalls = [];
jest.mock('../server/storage', () => ({
  storage: {
    getBuffer: async (k) => { mockStorageCalls.push(['get', k]); return Buffer.from('BYTES'); },
    put: async (k) => { mockStorageCalls.push(['put', k]); return 'https://cdn.test/' + k; },
    delete: async (k) => { mockStorageCalls.push(['delete', k]); },
  },
}));
jest.mock('../server/anthropic-files', () => ({
  eagerUploadAttachmentById: async () => {},
  deleteAnthropicFile: async () => {},
}));

const ROUTES_FILE = path.join(__dirname, '..', 'server', 'routes', 'attachment-routes.js');
const attachmentRouter = require('../server/routes/attachment-routes');
const { HEIC_REFUSAL } = require('../server/util/attachment-mime');
const auth = require('../server/auth');

const TABLES = [
  'organizations', 'users', 'roles', 'jobs', 'job_access', 'leads', 'tasks',
  'service_tickets', 'service_ticket_events', 'attachments', 'org_tags',
];

const WIDE = 10;
const RIVAL = 50;
const USERS = {
  [WIDE]: { role: 'upd_wide', org: 1 },
  [RIVAL]: { role: 'upd_wide', org: 2 },
};

let JPEG = null;
// An ISO base media header with the heic brand: what a Samsung HEIC starts with.
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic', 'ascii'), Buffer.alloc(40, 1)]);

function seed() {
  const caps = (list) => "'" + JSON.stringify(list) + "'";
  mockEng.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM roles; DELETE FROM jobs;
    DELETE FROM job_access; DELETE FROM leads; DELETE FROM tasks; DELETE FROM service_tickets;
    DELETE FROM service_ticket_events; DELETE FROM attachments; DELETE FROM org_tags;

    INSERT INTO organizations (id, name) VALUES (1, 'AGX'), (2, 'Rival Co');
    INSERT INTO roles (name, capabilities) VALUES
      ('upd_wide', ${caps(['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'LEADS_VIEW', 'LEADS_EDIT'])});
    INSERT INTO users (id, name, email, role, organization_id) VALUES
      (10, 'Wendy Wide', 'w@agx.test', 'upd_wide', 1),
      (50, 'Rival Ray', 'r@rival.test', 'upd_wide', 2);
    INSERT INTO jobs (id, owner_id, data, organization_id) VALUES ('j1', 10, '{}', 1), ('j9', 50, '{}', 2);
    INSERT INTO service_tickets (id, organization_id, title, job_id, lead_id, status, checklist) VALUES
      ('st_1', 1, 'Roof punch list', 'j1', NULL, 'in_progress', '[]');
    INSERT INTO tasks (id, organization_id, title, status, scope, service_ticket_id, entity_type, entity_id) VALUES
      ('t1', 1, 'Bldg 1', 'open', 'org', 'st_1', 'job', 'j1'),
      ('t2', 1, 'Bldg 2', 'open', 'org', 'st_1', 'job', 'j1'),
      ('t9', 2, 'Rival bldg', 'open', 'org', NULL, 'job', 'j9');
  `);
}

beforeAll(async () => {
  JPEG = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#c0392b' } }).jpeg().toBuffer();
  mockEng = createPgSqlite(sqliteSchema(TABLES), {
    jsonColumns: ['checklist', 'capabilities', 'data', 'tags', 'annotations', 'detail'],
  });
  mockEng.db.function('hashtext', (s) => { let h = 0; const t = String(s); for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0; return h; });
  mockEng.db.function('pg_advisory_xact_lock', () => 1);
  auth.setRolePool(mockEng.pool);
  seed();
  await auth.refreshRoleCache();
});

beforeEach(() => { seed(); mockStorageCalls.length = 0; mockHook = null; });

const flush = () => new Promise((r) => setTimeout(r, 30));

let mutantPaths = [];
let servers = [];
afterEach(async () => {
  mockHook = null;
  await flush();
  for (const s of servers) await new Promise((r) => s.close(r));
  servers = [];
  for (const p of mutantPaths) {
    try { delete require.cache[require.resolve(p)]; } catch (e) { /* never loaded */ }
    try { fs.unlinkSync(p); } catch (e) { /* already gone */ }
  }
  mutantPaths = [];
});

afterAll(async () => {
  await flush();
  const eng = mockEng;
  mockEng = { pool: { query: async () => ({ rows: [], rowCount: 0 }) } };
  if (eng) eng.close();
});

function tokenFor(uid) {
  const u = USERS[uid];
  return auth.signToken({ id: uid, email: uid + '@t.test', name: 'U' + uid, role: u.role, organization_id: u.org });
}

async function serve(router) {
  const app = express();
  app.use(express.json());
  app.use('/api/attachments', router || attachmentRouter);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return 'http://127.0.0.1:' + server.address().port;
}

async function upload(base, uid, entity, opts) {
  const o = opts || {};
  const fd = new FormData();
  if (o.uploadId !== undefined) fd.append('upload_id', o.uploadId);
  fd.append('file', new Blob([o.bytes || JPEG], { type: o.type || 'image/jpeg' }), o.name || 'photo.jpg');
  const res = await fetch(base + '/api/attachments/' + entity, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + tokenFor(uid), connection: 'close' },
    body: fd,
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, body };
}

const rowsOn = (type, id) => mockEng.all('SELECT * FROM attachments WHERE entity_type = ? AND entity_id = ? ORDER BY rowid', type, id);
const puts = () => mockStorageCalls.filter((c) => c[0] === 'put');
const UID = 'u1a2b3c4d5e6f7a8';

// ═══════════════════════════════════════════════════════════════════════════
describe('upload_id dedupe on POST /api/attachments/:entityType/:entityId', () => {
  test('the same upload_id twice on one task: one row, the second answer is duplicate:true with that row', async () => {
    const b = await serve();
    const first = await upload(b, WIDE, 'task/t1', { uploadId: UID });
    expect(first.status).toBe(200);
    expect(first.body.duplicate).toBeUndefined();
    expect(first.body.attachment).toMatchObject({ entity_type: 'task', entity_id: 't1', client_upload_id: UID, organization_id: 1 });
    const putsAfterFirst = puts().length;
    expect(putsAfterFirst).toBe(3);

    const again = await upload(b, WIDE, 'task/t1', { uploadId: UID });
    expect(again.status).toBe(200);
    expect(again.body.ok).toBe(true);
    expect(again.body.duplicate).toBe(true);
    expect(again.body.attachment.id).toBe(first.body.attachment.id);
    expect(rowsOn('task', 't1').length).toBe(1);
    // Nothing stored the second time.
    expect(puts().length).toBe(putsAfterFirst);
  });

  test('the lookup is answered before the count cap and carries the caller\'s organization', async () => {
    const b = await serve();
    await upload(b, WIDE, 'task/t1', { uploadId: UID });
    const before = mockEng.log.length;
    await upload(b, WIDE, 'task/t1', { uploadId: UID });
    const ran = mockEng.log.slice(before);
    const lookup = ran.find((e) => /FROM attachments WHERE organization_id = \$1 AND entity_type = \$2 AND entity_id = \$3 AND client_upload_id = \$4/.test(e.sql));
    expect(lookup).toBeDefined();
    expect(lookup.params).toEqual([1, 'task', 't1', UID]);
    expect(ran.some((e) => /COUNT\(\*\)::int AS c FROM attachments/.test(e.sql))).toBe(false);
    expect(ran.some((e) => /^INSERT INTO attachments/.test(e.sql))).toBe(false);
  });

  test('the same upload_id on ANOTHER task, or from another org, is a new upload', async () => {
    const b = await serve();
    expect((await upload(b, WIDE, 'task/t1', { uploadId: UID })).body.duplicate).toBeUndefined();
    const other = await upload(b, WIDE, 'task/t2', { uploadId: UID });
    expect(other.status).toBe(200);
    expect(other.body.duplicate).toBeUndefined();
    expect([rowsOn('task', 't1').length, rowsOn('task', 't2').length]).toEqual([1, 1]);

    const before = mockEng.log.length;
    const rival = await upload(b, RIVAL, 'task/t9', { uploadId: UID });
    expect(rival.status).toBe(200);
    expect(rival.body.duplicate).toBeUndefined();
    const lookup = mockEng.log.slice(before).find((e) => /client_upload_id = \$4/.test(e.sql));
    expect(lookup.params[0]).toBe(2);
  });

  test('a malformed upload_id is ignored: two normal uploads, no id stored', async () => {
    const b = await serve();
    for (const bad of ['short', 'has spaces in it!', 'x'.repeat(65)]) {
      expect((await upload(b, WIDE, 'task/t1', { uploadId: bad })).body.duplicate).toBeUndefined();
    }
    const rows = rowsOn('task', 't1');
    expect(rows.length).toBe(3);
    expect(rows.map((r) => r.client_upload_id)).toEqual([null, null, null]);
  });

  test('no upload_id: behaves as before, and the INSERT stores NULL', async () => {
    const b = await serve();
    await upload(b, WIDE, 'job/j1');
    await upload(b, WIDE, 'job/j1');
    expect(rowsOn('job', 'j1').map((r) => r.client_upload_id)).toEqual([null, null]);
  });

  test('two arrivals racing past the lookup: the loser\'s bytes are discarded and it answers with the winner', async () => {
    const b = await serve();
    mockHook = async (sql, params) => {
      if (/^\s*INSERT INTO attachments/.test(sql)) {
        mockHook = null;
        // The other arrival commits first...
        mockEng.db.exec(`INSERT INTO attachments (id, entity_type, entity_id, filename, mime_type, client_upload_id, organization_id, uploaded_by, tags, position)
                         VALUES ('att_winner', 'task', 't1', 'photo.jpg', 'image/jpeg', '${UID}', 1, 10, '[]', 0)`);
        // ...so this INSERT hits the unique index.
        const e = new Error('duplicate key value violates unique constraint "uq_attachments_client_upload"');
        e.code = '23505';
        e.constraint = 'uq_attachments_client_upload';
        throw e;
      }
      return mockEng.pool.query(sql, params);
    };
    const r = await upload(b, WIDE, 'task/t1', { uploadId: UID });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, duplicate: true, attachment: { id: 'att_winner' } });
    const stored = puts().map((c) => c[1]).sort();
    const discarded = mockStorageCalls.filter((c) => c[0] === 'delete').map((c) => c[1]).sort();
    expect(stored.length).toBe(3);
    expect(discarded).toEqual(stored);
    expect(rowsOn('task', 't1').map((row) => row.id)).toEqual(['att_winner']);
  });

  test('a unique violation on some OTHER index is not mistaken for a duplicate upload', async () => {
    const b = await serve();
    mockHook = async (sql, params) => {
      if (/^\s*INSERT INTO attachments/.test(sql)) {
        const e = new Error('duplicate key value violates unique constraint "attachments_pkey"');
        e.code = '23505';
        e.constraint = 'attachments_pkey';
        throw e;
      }
      return mockEng.pool.query(sql, params);
    };
    const r = await upload(b, WIDE, 'task/t1', { uploadId: UID });
    expect(r.status).toBe(500);
    expect(mockStorageCalls.filter((c) => c[0] === 'delete')).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('HEIC photos on the office upload door', () => {
  test('on a task: 415 with the refusal sentence, nothing stored, no row', async () => {
    const b = await serve();
    const r = await upload(b, WIDE, 'task/t1', { bytes: HEIC, type: 'image/heic', name: 'IMG_0001.HEIC' });
    expect([r.status, r.body]).toEqual([415, { error: HEIC_REFUSAL }]);
    expect(puts()).toEqual([]);
    expect(rowsOn('task', 't1')).toEqual([]);
  });

  test('on a work order: 415 as well', async () => {
    const b = await serve();
    const r = await upload(b, WIDE, 'service_ticket/st_1', { bytes: HEIC, type: 'image/heic', name: 'IMG_0002.heic' });
    expect([r.status, r.body]).toEqual([415, { error: HEIC_REFUSAL }]);
    expect(rowsOn('service_ticket', 'st_1')).toEqual([]);
  });

  test('on a job: kept as a plain file — the original only, no thumbnail or web copy', async () => {
    const b = await serve();
    const r = await upload(b, WIDE, 'job/j1', { bytes: HEIC, type: 'image/heic', name: 'IMG_0003.HEIC' });
    expect(r.status).toBe(200);
    expect(r.body.attachment).toMatchObject({ entity_type: 'job', mime_type: 'image/heic', thumb_key: null, web_key: null, thumb_url: null, web_url: null });
    expect(r.body.attachment.original_key).toMatch(/_orig\.heic$/);
    expect(puts().map((c) => c[1])).toEqual([r.body.attachment.original_key]);
  });

  test('a HEIC sent with no type is known by its name', async () => {
    const b = await serve();
    const bytes = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftyphevc', 'ascii'), Buffer.alloc(40, 1)]);
    const r = await upload(b, WIDE, 'task/t1', { bytes, type: 'application/octet-stream', name: 'IMG_0004.heic' });
    expect([r.status, r.body]).toEqual([415, { error: HEIC_REFUSAL }]);
  });

  test('CONTROL: a JPEG on a task still gets its thumbnail and web copy', async () => {
    const b = await serve();
    const r = await upload(b, WIDE, 'task/t1', { uploadId: UID });
    expect(r.status).toBe(200);
    expect(r.body.attachment.thumb_key).toMatch(/_thumb\.jpg$/);
    expect(r.body.attachment.web_key).toMatch(/_web\.jpg$/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MUTANTS
// ═══════════════════════════════════════════════════════════════════════════
function mutantRouter(pairs) {
  let out = fs.readFileSync(ROUTES_FILE, 'utf8').replace(/\r\n/g, '\n');
  for (const [find, replace] of pairs) {
    if (out.split(find).length - 1 !== 1) throw new Error('anchor not found');
    out = out.split(find).join(replace);
  }
  const fromDir = path.dirname(ROUTES_FILE);
  out = out.replace(/require\((['"])([^'"]+)\1\)/g, (m, _q, spec) => {
    try {
      const resolved = spec.charAt(0) === '.'
        ? require.resolve(path.resolve(fromDir, spec))
        : require.resolve(spec, { paths: [fromDir] });
      return 'require(' + JSON.stringify(resolved.split(path.sep).join('/')) + ')';
    } catch (e) {
      return m;
    }
  });
  const p = path.join(os.tmpdir(), '_p86_upd_mutant_' + process.pid + '_' + Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, out, 'utf8');
  mutantPaths.push(p);
  return require(p);
}

describe('MUTANT: each rule removed', () => {
  test('harness: an absent anchor throws; an unchanged copy still dedupes', async () => {
    expect(() => mutantRouter([['not in the router at all', 'x']])).toThrow('anchor not found');
    const b = await serve(mutantRouter([['function sendGuardRefusal(', 'function sendGuardRefusal /* copy */(']]));
    await upload(b, WIDE, 'task/t1', { uploadId: UID });
    expect((await upload(b, WIDE, 'task/t1', { uploadId: UID })).body.duplicate).toBe(true);
  });

  test('the dedupe lookup dropped: a resent photo is stored twice', async () => {
    const b = await serve(mutantRouter([[
      '        if (prior) return res.json({ ok: true, attachment: prior, duplicate: true });',
      '        /* MUTANT */']]));
    await upload(b, WIDE, 'task/t1', { uploadId: UID });
    const again = await upload(b, WIDE, 'task/t1', { uploadId: UID });
    expect(again.body.duplicate).toBeUndefined();
    expect(rowsOn('task', 't1').length).toBe(2);
    expect(puts().length).toBe(6);
  });

  test('the HEIC refusal dropped: a task takes a HEIC it can never show as proof', async () => {
    const b = await serve(mutantRouter([[
      "      if (heic && (entityType === 'task' || entityType === 'service_ticket')) {",
      '      if (false) {']]));
    const r = await upload(b, WIDE, 'task/t1', { bytes: HEIC, type: 'image/heic', name: 'IMG_0001.HEIC' });
    expect(r.status).not.toBe(415);
    expect(rowsOn('task', 't1').length).toBe(1);
  });

  test('the HEIC document branch dropped: a HEIC on a job fails in the image pipeline again', async () => {
    const b = await serve(mutantRouter([['      if (isImageMime(mime) && !heic) {', '      if (isImageMime(mime)) {']]));
    const r = await upload(b, WIDE, 'job/j1', { bytes: HEIC, type: 'image/heic', name: 'IMG_0003.HEIC' });
    expect(r.status).toBe(500);
    expect(rowsOn('job', 'j1')).toEqual([]);
  });

  test('the race handling dropped: the loser answers 500 and leaves its bytes behind', async () => {
    const b = await serve(mutantRouter([[
      '        if (!uploadId || !isUploadIdConflict(e)) throw e;',
      '        throw e;']]));
    mockHook = async (sql, params) => {
      if (/^\s*INSERT INTO attachments/.test(sql)) {
        mockHook = null;
        const e = new Error('duplicate key value violates unique constraint "uq_attachments_client_upload"');
        e.code = '23505';
        e.constraint = 'uq_attachments_client_upload';
        throw e;
      }
      return mockEng.pool.query(sql, params);
    };
    const r = await upload(b, WIDE, 'task/t1', { uploadId: UID });
    expect(r.status).toBe(500);
    expect(mockStorageCalls.filter((c) => c[0] === 'delete')).toEqual([]);
  });
});
