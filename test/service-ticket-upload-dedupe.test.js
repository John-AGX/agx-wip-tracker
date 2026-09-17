// THE CREW LINK'S PHOTO DOORS ON A BAD SIGNAL (1.29, A6 + A7).
//
// ── WHAT THIS FILE PINS ───────────────────────────────────────────────────
// A crew phone on one bar of signal sends a photo, the photo lands, and the
// answer never makes it back — so the page sends it again. Before 1.29 that
// stored the photo twice. And the doors answered a HEIC photo, an unreadable
// one or one over the size cap with "Something went wrong".
//
//   * upload_id: a repeat of the same id for the same parent (per org) finds
//     the first row and answers duplicate:true, storing nothing and logging
//     nothing. Two arrivals that race past the lookup meet the unique index;
//     the loser throws away the bytes it stored and answers with the winner.
//   * HEIC -> 415 with the sentence that says what to do; bytes the image
//     library cannot read -> 422; over 50 MB -> 413; a body cut off -> 408.
//     None of them leaves anything in storage.
//   * The field-log stamp (PATCH note) carries the date, time and zone in the
//     org's timezone and "· N photos" for this link's site photos since its
//     last note.
//   * The crew read carries site_photos as a whitelist, best-effort.
//
// ── HOW ───────────────────────────────────────────────────────────────────
// The REAL router over node:sqlite through the pg shim (tables from
// sqliteSchema), driven from loadTicketShare on, through the photo doors' own
// body-parser wrapper. Only the upload library underneath it is replaced (so a
// size-cap error can be planted) and storage (so every put and delete is
// counted). A wrapper around the pool plants the Postgres errors sqlite cannot
// raise. Each guard that matters is then removed from a copy of the shipped
// file and shown to go red.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const SHARE_ROUTES = path.join(__dirname, '..', 'server', 'routes', 'service-ticket-share-routes.js');
const TABLES = [
  'organizations', 'users', 'jobs', 'leads', 'tasks', 'attachments',
  'service_tickets', 'service_ticket_events', 'service_ticket_shares',
];

// The upload library under multerOnePhoto: it "parses" nothing (the drive puts
// req.file in place) and fails the way the test plants.
global.__multerError = null;
jest.mock('multer', () => {
  const lib = function () {
    return { single: () => (req, res, cb) => cb(global.__multerError || null) };
  };
  lib.memoryStorage = () => ({});
  return lib;
});
jest.mock('../server/storage', () => ({
  storage: {
    put: jest.fn(async (key) => 'https://cdn.test/' + key),
    delete: jest.fn(async () => {}),
  },
}));

const HEIC_REFUSAL = "This photo is in HEIC format (High efficiency), which can't be opened here yet. Use Take photo, or set your camera to save photos as JPEG, then add it again.";
const UPLOAD_ID = 'u3f9a1c2e7b40d51';

let eng;
let db;
let svc;
let storage;
let shareRouter;
let token;
let viewToken;
let jpeg;
// Pool-level plants: { match: RegExp, run(sql, params) } answered before sqlite.
let plants = [];

function seed() {
  token = svc.genToken();
  viewToken = svc.genToken();
  const exp = new Date(Date.now() + 86400000).toISOString();
  eng.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM jobs; DELETE FROM leads; DELETE FROM tasks;
    DELETE FROM attachments; DELETE FROM service_tickets; DELETE FROM service_ticket_events; DELETE FROM service_ticket_shares;

    INSERT INTO organizations (id, name, timezone) VALUES (1, 'AGX', 'America/Chicago'), (2, 'Rival Co', 'America/New_York');
    INSERT INTO users (id, name, email, organization_id) VALUES (10, 'Wendy PM', 'w@agx.test', 1), (50, 'Rival Ray', 'r@rival.test', 2);
    INSERT INTO jobs (id, owner_id, data, organization_id) VALUES ('j1', 10, '{}', 1);
    INSERT INTO service_tickets (id, organization_id, title, job_id, status, checklist, internal_notes, created_by, approval_notice_attempts, created_at) VALUES
      ('st_1', 1, 'Latitude 28 rails', 'j1', 'in_progress', '[]', 'office only', 10, 0, '2026-09-01 10:00:00'),
      ('st_2', 1, 'Another work order', 'j1', 'in_progress', '[]', NULL, 10, 0, '2026-09-01 10:00:01');
    INSERT INTO tasks (id, organization_id, title, status, scope, service_ticket_id, entity_type, entity_id, created_at) VALUES
      ('k1', 1, 'Bldg 784', 'open', 'org', 'st_1', 'job', 'j1', '2026-09-02 08:00:01'),
      ('k2', 1, 'Bldg 785', 'open', 'org', 'st_1', 'job', 'j1', '2026-09-02 08:00:02'),
      ('k_other', 1, 'Bldg 900', 'open', 'org', 'st_2', 'job', 'j1', '2026-09-02 08:00:03');
    INSERT INTO service_ticket_shares (id, organization_id, ticket_id, token_hash, scope, hide_financials, recipient_name, expires_at, created_by, view_count, opened_at, created_at) VALUES
      ('sh1', 1, 'st_1', '${svc.hashToken(token)}', 'respond', 1, 'Marco', '${exp}', 10, 0, '2026-09-02 09:00:00', '2026-09-02 09:00:00'),
      ('sh_view', 1, 'st_1', '${svc.hashToken(viewToken)}', 'view', 1, NULL, '${exp}', 10, 0, '2026-09-02 09:00:00', '2026-09-02 09:00:00');
  `);
}

beforeAll(async () => {
  eng = createPgSqlite(sqliteSchema(TABLES), { jsonColumns: ['checklist', 'detail', 'data', 'tags'] });
  db = require('../server/db');
  const planted = (sql, params, fallthrough) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    const plant = plants.find((p) => p.match.test(text));
    if (plant) {
      plants = plants.filter((p) => p !== plant || p.keep);
      return plant.run(text, params || []);
    }
    return fallthrough(sql, params);
  };
  db.pool.query = async (sql, params) => planted(sql, params, eng.pool.query);
  db.pool.connect = async () => {
    const client = await eng.pool.connect();
    return { release: client.release, query: async (sql, params) => planted(sql, params, client.query) };
  };
  svc = require('../server/services/service-tickets');
  storage = require('../server/storage').storage;
  shareRouter = require('../server/routes/service-ticket-share-routes');
  jpeg = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#556677' } }).jpeg().toBuffer();
});

const flush = () => new Promise((r) => setTimeout(r, 25));
let mutantPaths = [];
beforeEach(() => {
  seed();
  plants = [];
  global.__multerError = null;
  storage.put.mockClear();
  storage.delete.mockClear();
  eng.log.length = 0;
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
  db.pool.query = async () => ({ rows: [], rowCount: 0 });
  if (eng) eng.close();
});

// ── the drive ─────────────────────────────────────────────────────────────
function fakeRes() {
  const res = { statusCode: 200, body: undefined, headersSent: false };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.body = p; res.headersSent = true; return res; };
  res.set = () => res;
  return res;
}

async function drive(router, method, routePath, opts) {
  const o = opts || {};
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error('route not declared: ' + method + ' ' + routePath);
  let chain = layer.route.stack.map((s) => s.handle);
  const at = chain.findIndex((h) => h.name === 'loadTicketShare');
  if (at < 0) throw new Error('no loadTicketShare on ' + routePath);
  chain = chain.slice(at);
  const res = fakeRes();
  const req = {
    method: method.toUpperCase(), params: Object.assign({ token: o.token || token }, o.params || {}),
    query: {}, body: o.body || {}, file: o.file, headers: {}, protocol: 'https', get: () => 'project86.test',
  };
  res.ran = [];
  for (const h of chain) {
    let advanced = false;
    res.ran.push(h.name || 'handler');
    await h(req, res, (err) => { if (err) throw err; advanced = true; });
    if (!advanced) break;
  }
  return res;
}

const photoFile = (name, mime, buffer) => ({ originalname: name, mimetype: mime, buffer: buffer, size: buffer.length });
const buildingPhoto = (router, taskId, body, file, tok) => drive(router || shareRouter, 'post',
  '/service-ticket-share/:token/subtasks/:taskId/photo',
  { token: tok, params: { taskId }, body, file: file === undefined ? photoFile('IMG_1.jpg', 'image/jpeg', jpeg) : file });
const sitePhoto = (router, body, file, tok) => drive(router || shareRouter, 'post', '/service-ticket-share/:token/photo',
  { token: tok, body, file: file === undefined ? photoFile('IMG_2.jpg', 'image/jpeg', jpeg) : file });
const patchNote = (router, body) => drive(router || shareRouter, 'patch', '/service-ticket-share/:token', { body });
const readLink = (router) => drive(router || shareRouter, 'get', '/service-ticket-share/:token', {});

const rows = (sql, ...a) => eng.all(sql, ...a);
const photoEvents = () => rows("SELECT detail FROM service_ticket_events WHERE kind = 'photo_added'").map((e) => e.detail);
const lookups = () => eng.log.filter((q) => /client_upload_id = \$4/.test(q.sql));

function mutant(pairs) {
  let out = fs.readFileSync(SHARE_ROUTES, 'utf8').replace(/\r\n/g, '\n');
  for (const [find, replace] of pairs) {
    const hits = out.split(find).length - 1;
    if (hits !== 1) throw new Error('anchor not found' + (hits > 1 ? ' (ambiguous: ' + hits + ')' : '') + ': ' + JSON.stringify(find.slice(0, 120)));
    out = out.split(find).join(replace);
  }
  const dir = path.dirname(SHARE_ROUTES);
  out = out.replace(/require\((['"])([^'"]+)\1\)/g, (_m, _q, spec) => {
    const resolved = spec.charAt(0) === '.'
      ? require.resolve(path.resolve(dir, spec))
      : require.resolve(spec, { paths: [dir] });
    return 'require(' + JSON.stringify(resolved.split(path.sep).join('/')) + ')';
  });
  const p = path.join(os.tmpdir(), '_p86_st_upload_mutant_' + process.pid + '_' + Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, out, 'utf8');
  mutantPaths.push(p);
  return require(p);
}

// Plant the unique-index race: the other request's row lands first, then this
// INSERT raises what Postgres raises.
function plantRace(entityType, entityId, winnerId) {
  plants.push({
    match: /^INSERT INTO attachments/i,
    run: () => {
      eng.db.exec(`INSERT INTO attachments (id, entity_type, entity_id, filename, mime_type, thumb_url, web_url, original_url, tags, organization_id, client_upload_id, uploaded_at, position)
        VALUES ('${winnerId}', '${entityType}', '${entityId}', 'IMG_1.jpg', 'image/jpeg', 'https://cdn.test/w_thumb', 'https://cdn.test/w_web', 'https://cdn.test/w_orig', '["completion"]', 1, '${UPLOAD_ID}', '2026-09-15 14:00:00', 0)`);
      const e = new Error('duplicate key value violates unique constraint "uq_attachments_client_upload"');
      e.code = '23505';
      e.constraint = 'uq_attachments_client_upload';
      throw e;
    },
  });
}

describe('the mutation harness', () => {
  test('an absent anchor throws', () => {
    expect(() => mutant([['this string is nowhere in the routes', 'x']])).toThrow(/anchor not found/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * A BUILDING PHOTO SENT TWICE (T5)
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a building photo sent twice is stored once', () => {
  test('the repeat answers duplicate:true with the same photo: one row, one set of puts, one event', async () => {
    const first = await buildingPhoto(null, 'k1', { kind: 'completion', upload_id: UPLOAD_ID });
    expect(first.statusCode).toBe(200);
    expect(first.body.duplicate).toBeUndefined();
    expect(storage.put).toHaveBeenCalledTimes(3);
    const second = await buildingPhoto(null, 'k1', { kind: 'completion', upload_id: UPLOAD_ID });
    expect(second.statusCode).toBe(200);
    expect(second.body).toEqual({
      ok: true, duplicate: true,
      photo: { id: first.body.photo.id, kind: 'completion', thumb_url: first.body.photo.thumb_url, web_url: first.body.photo.web_url },
    });
    expect(storage.put).toHaveBeenCalledTimes(3);
    expect(rows("SELECT id, client_upload_id, organization_id FROM attachments WHERE entity_type = 'task'")).toEqual([
      { id: first.body.photo.id, client_upload_id: UPLOAD_ID, organization_id: 1 },
    ]);
    expect(photoEvents()).toEqual([{ task_id: 'k1', kind: 'completion', attachment_id: first.body.photo.id }]);
  });

  test('the lookup is scoped by the TICKET row\'s org and the proved subtask', async () => {
    await buildingPhoto(null, 'k1', { upload_id: UPLOAD_ID });
    expect(lookups().map((q) => q.params)).toEqual([[1, 'task', 'k1', UPLOAD_ID]]);
  });

  test('the same id from another tenant\'s row, or on another building, is not a duplicate', async () => {
    eng.db.exec(`INSERT INTO attachments (id, entity_type, entity_id, filename, mime_type, organization_id, client_upload_id, position)
      VALUES ('att_rival', 'task', 'k1', 'x.jpg', 'image/jpeg', 2, '${UPLOAD_ID}', 0)`);
    const one = await buildingPhoto(null, 'k1', { upload_id: UPLOAD_ID });
    const two = await buildingPhoto(null, 'k2', { upload_id: UPLOAD_ID });
    expect([one.body.duplicate, two.body.duplicate]).toEqual([undefined, undefined]);
    expect(rows("SELECT entity_id FROM attachments WHERE organization_id = 1 ORDER BY entity_id").map((r) => r.entity_id)).toEqual(['k1', 'k2']);
  });

  test('a before photo found again reports its kind', async () => {
    await buildingPhoto(null, 'k1', { kind: 'before', upload_id: UPLOAD_ID });
    const again = await buildingPhoto(null, 'k1', { kind: 'before', upload_id: UPLOAD_ID });
    expect([again.body.duplicate, again.body.photo.kind]).toEqual([true, 'before']);
  });

  test('a malformed upload_id is ignored: no lookup, a normal insert, no id stored', async () => {
    const res = await buildingPhoto(null, 'k1', { upload_id: 'bad id!' });
    expect(res.statusCode).toBe(200);
    expect(lookups()).toHaveLength(0);
    expect(rows("SELECT client_upload_id FROM attachments")).toEqual([{ client_upload_id: null }]);
    const ins = eng.log.find((q) => /^INSERT INTO attachments/i.test(q.sql));
    expect(ins.params[18]).toBeNull();
  });

  test('a subtask that is not on this work order is refused before any lookup', async () => {
    eng.db.exec(`INSERT INTO attachments (id, entity_type, entity_id, filename, mime_type, organization_id, client_upload_id, position)
      VALUES ('att_other', 'task', 'k_other', 'x.jpg', 'image/jpeg', 1, '${UPLOAD_ID}', 0)`);
    const res = await buildingPhoto(null, 'k_other', { upload_id: UPLOAD_ID });
    expect([res.statusCode, res.body]).toEqual([404, { error: 'That subtask is not on this work order.' }]);
    expect(lookups()).toHaveLength(0);
  });

  test('RACE: the INSERT meets the unique index -> the stored keys are discarded and the winner answers', async () => {
    plantRace('task', 'k1', 'att_winner');
    const res = await buildingPhoto(null, 'k1', { kind: 'completion', upload_id: UPLOAD_ID });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      ok: true, duplicate: true,
      photo: { id: 'att_winner', kind: 'completion', thumb_url: 'https://cdn.test/w_thumb', web_url: 'https://cdn.test/w_web' },
    });
    const put = storage.put.mock.calls.map((c) => c[0]).sort();
    expect(put).toHaveLength(3);
    expect(storage.delete.mock.calls.map((c) => c[0]).sort()).toEqual(put);
    expect(rows('SELECT id FROM attachments')).toEqual([{ id: 'att_winner' }]);
    expect(photoEvents()).toEqual([]);
  });

  test('a unique violation on some OTHER constraint is not mistaken for a duplicate', async () => {
    plants.push({ match: /^INSERT INTO attachments/i, run: () => { const e = new Error('duplicate key value violates unique constraint "attachments_pkey"'); e.code = '23505'; e.constraint = 'attachments_pkey'; throw e; } });
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await buildingPhoto(null, 'k1', { upload_id: UPLOAD_ID });
    err.mockRestore();
    expect([res.statusCode, res.body]).toEqual([500, { error: 'Something went wrong uploading that.' }]);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  test('MUTANT: drop the lookup and the repeat is stored a second time', async () => {
    const mut = mutant([['        if (prior) return res.json(duplicateAnswer(prior));\n', '']]);
    await buildingPhoto(mut, 'k1', { upload_id: UPLOAD_ID });
    const again = await buildingPhoto(mut, 'k1', { upload_id: UPLOAD_ID });
    expect(again.body.duplicate).toBeUndefined();
    expect(rows("SELECT id FROM attachments WHERE entity_id = 'k1'")).toHaveLength(2);
    expect(storage.put).toHaveBeenCalledTimes(6);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * A SITE PHOTO SENT TWICE (T3)
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a site photo sent twice is stored once', () => {
  test('first arrival: the row, the event naming the attachment, the org-scoped position read, and the photo answer', async () => {
    const res = await sitePhoto(null, { upload_id: UPLOAD_ID, name: 'Marco' });
    expect(res.statusCode).toBe(200);
    const id = res.body.attachment.id;
    expect(Object.keys(res.body.photo).sort()).toEqual(['id', 'kind', 'thumb_url', 'uploaded_at', 'web_url']);
    expect([res.body.photo.id, res.body.photo.kind]).toEqual([id, 'site']);
    expect(res.body.photo.uploaded_at).toBeTruthy();
    expect(Object.keys(res.body.attachment).sort()).toEqual(['filename', 'id', 'original_url', 'thumb_url', 'web_url']);
    expect(rows("SELECT entity_type, entity_id, organization_id, client_upload_id, uploaded_by FROM attachments")).toEqual([
      { entity_type: 'service_ticket', entity_id: 'st_1', organization_id: 1, client_upload_id: UPLOAD_ID, uploaded_by: null },
    ]);
    expect(photoEvents()).toEqual([{ mime: 'image/jpeg', attachment_id: id }]);
    const pos = eng.log.find((q) => /MAX\(position\)/.test(q.sql));
    expect(pos.sql).toContain("entity_type = 'service_ticket' AND entity_id = $1 AND organization_id = $2");
    expect(pos.params).toEqual(['st_1', 1]);
    expect(lookups().map((q) => q.params)).toEqual([[1, 'service_ticket', 'st_1', UPLOAD_ID]]);
  });

  test('the repeat: duplicate:true with the same attachment and photo, no second put, row or event', async () => {
    const first = await sitePhoto(null, { upload_id: UPLOAD_ID });
    const again = await sitePhoto(null, { upload_id: UPLOAD_ID });
    expect(again.statusCode).toBe(200);
    expect(again.body.duplicate).toBe(true);
    expect(again.body.attachment).toEqual(first.body.attachment);
    expect([again.body.photo.id, again.body.photo.kind]).toEqual([first.body.photo.id, 'site']);
    expect(storage.put).toHaveBeenCalledTimes(3);
    expect(rows('SELECT id FROM attachments')).toHaveLength(1);
    expect(photoEvents()).toHaveLength(1);
  });

  test('the gates still come first: a view link is refused before any lookup', async () => {
    const res = await sitePhoto(null, { upload_id: UPLOAD_ID }, undefined, viewToken);
    expect(res.statusCode).toBe(403);
    expect(lookups()).toHaveLength(0);
    expect(storage.put).not.toHaveBeenCalled();
  });

  test('RACE on the site photo door: discard, then the winner', async () => {
    plantRace('service_ticket', 'st_1', 'att_site_winner');
    const res = await sitePhoto(null, { upload_id: UPLOAD_ID });
    expect([res.statusCode, res.body.duplicate, res.body.photo.id]).toEqual([200, true, 'att_site_winner']);
    expect(storage.delete).toHaveBeenCalledTimes(3);
    expect(photoEvents()).toEqual([]);
  });

  test('MUTANT: drop the site photo lookup and the repeat is stored twice', async () => {
    const mut = mutant([['        if (prior) return res.json(sitePhotoAnswer(prior, true));\n', '']]);
    await sitePhoto(mut, { upload_id: UPLOAD_ID });
    await sitePhoto(mut, { upload_id: UPLOAD_ID });
    expect(rows('SELECT id FROM attachments')).toHaveLength(2);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * PHOTOS THAT CAN NEVER GO: HEIC, UNREADABLE, TOO LARGE, CUT OFF
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a photo that cannot be used is refused in words, with nothing stored', () => {
  const heicBytes = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(32)]);

  test('HEIC on a building: 415 with the HEIC sentence, no put, no row', async () => {
    const res = await buildingPhoto(null, 'k1', { upload_id: UPLOAD_ID }, photoFile('IMG_0412.HEIC', 'image/heic', heicBytes));
    expect([res.statusCode, res.body]).toEqual([415, { error: HEIC_REFUSAL }]);
    expect(storage.put).not.toHaveBeenCalled();
    expect(rows('SELECT id FROM attachments')).toHaveLength(0);
  });

  test('HEIC as a site photo, and a HEIC the browser sent with no type', async () => {
    let res = await sitePhoto(null, {}, photoFile('IMG_0412.heic', 'image/heic', heicBytes));
    expect([res.statusCode, res.body]).toEqual([415, { error: HEIC_REFUSAL }]);
    const unbranded = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyphevc'), Buffer.alloc(32)]);
    res = await sitePhoto(null, {}, photoFile('IMG_0413.heic', 'application/octet-stream', unbranded));
    expect([res.statusCode, res.body]).toEqual([415, { error: HEIC_REFUSAL }]);
    expect(storage.put).not.toHaveBeenCalled();
  });

  test('a real JPEG that is merely NAMED .heic is a photo, not a refusal', async () => {
    const res = await sitePhoto(null, {}, photoFile('IMG_0414.heic', 'image/jpeg', jpeg));
    expect(res.statusCode).toBe(200);
  });

  test('garbage bytes under an image type: 422, not 500, and nothing stored', async () => {
    const garbage = Buffer.from('this is not a photo at all, only some text bytes');
    let res = await buildingPhoto(null, 'k1', {}, photoFile('IMG_9.jpg', 'image/jpeg', garbage));
    expect([res.statusCode, res.body]).toEqual([422, { error: "That photo couldn't be read. Take it again, or pick a different photo." }]);
    res = await sitePhoto(null, {}, photoFile('IMG_9.jpg', 'image/jpeg', garbage));
    expect(res.statusCode).toBe(422);
    // A JPEG cut off after its header: the size can be read, the picture cannot.
    res = await sitePhoto(null, {}, photoFile('IMG_10.jpg', 'image/jpeg', jpeg.subarray(0, 40)));
    expect(res.statusCode).toBe(422);
    expect(storage.put).not.toHaveBeenCalled();
    expect(rows('SELECT id FROM attachments')).toHaveLength(0);
  });

  test('over the size cap is 413, and a body cut off is 408, on both photo doors, before the handler runs', async () => {
    const tooLarge = Object.assign(new Error('File too large'), { name: 'MulterError', code: 'LIMIT_FILE_SIZE' });
    const cutOff = Object.assign(new Error('Unexpected end of form'), {});
    for (const send of [() => sitePhoto(null, {}), () => buildingPhoto(null, 'k1', {})]) {
      global.__multerError = tooLarge;
      let res = await send();
      expect([res.statusCode, res.body]).toEqual([413, { error: "That photo is over 50 MB and can't be sent. Take it again, or pick a smaller photo." }]);
      expect(res.ran[res.ran.length - 1]).toBe('multerOnePhoto');
      global.__multerError = cutOff;
      res = await send();
      expect([res.statusCode, res.body]).toEqual([408, { error: 'The upload was cut off before it finished. Try again.' }]);
    }
    expect(storage.put).not.toHaveBeenCalled();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE FIELD-LOG STAMP: WHEN, AND HOW MANY PHOTOS WENT WITH THE NOTE
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the field report note says when, and how many site photos went with it', () => {
  const ev = (id, kind, share, at, detail) =>
    `('${id}', 1, 'st_1', '${kind}', 'share', ${share ? "'" + share + "'" : 'NULL'}, '${JSON.stringify(detail || {})}', '${at}')`;
  const seedEvents = (list) => eng.db.exec(
    'INSERT INTO service_ticket_events (id, organization_id, ticket_id, kind, actor_kind, share_id, detail, created_at) VALUES ' + list.join(', '));
  const guestLog = () => rows("SELECT guest_log FROM service_tickets WHERE id = 'st_1'")[0].guest_log;
  const noteEvent = () => rows("SELECT detail FROM service_ticket_events WHERE kind = 'note_added'").map((e) => e.detail).pop();
  // "Sep 15, 2026, 2:32 PM CDT" — ICU may put a narrow no-break space before PM.
  const WHEN = '[A-Z][a-z]{2} \\d{1,2}, \\d{4}, \\d{1,2}:\\d{2}\\s[AP]M ';

  test('two site photos from this link since its last note -> "· 2 photos", in the org\'s timezone', async () => {
    seedEvents([
      ev('e0', 'photo_added', 'sh1', '2026-09-15 12:00:00', { mime: 'image/jpeg', attachment_id: 'old' }),
      ev('e1', 'note_added', 'sh1', '2026-09-15 13:00:00', { fields: ['note'] }),
      ev('e2', 'photo_added', 'sh1', '2026-09-15 14:00:00', { mime: 'image/jpeg', attachment_id: 'a1' }),
      ev('e3', 'photo_added', 'sh1', '2026-09-15 14:05:00', { mime: 'image/jpeg', attachment_id: 'a2' }),
      ev('e4', 'photo_added', 'sh2', '2026-09-15 14:06:00', { mime: 'image/jpeg', attachment_id: 'other-link' }),
      ev('e5', 'photo_added', 'sh1', '2026-09-15 14:07:00', { task_id: 'k1', kind: 'completion', attachment_id: 'bldg' }),
      ev('e6', 'photo_added', 'sh1', '2026-09-15 14:08:00', { flag_id: 'fl1', kind: 'flag', attachment_id: 'flag' }),
    ]);
    const res = await patchNote(null, { note: 'Resident refused access to 784' });
    expect(res.statusCode).toBe(200);
    expect(guestLog()).toMatch(new RegExp('^\\n\\n— Marco \\(via shared link\\) · ' + WHEN + 'C[DS]T · 2 photos: Resident refused access to 784$'));
    expect(noteEvent()).toEqual({ fields: ['note'], photo_count: 2 });
    const count = eng.log.find((q) => /kind IN \('photo_added', 'note_added'\)/.test(q.sql));
    expect(count.sql).toContain('WHERE ticket_id = $1 AND organization_id = $2 AND share_id = $3');
    expect(count.params).toEqual(['st_1', 1, 'sh1']);
  });

  test('one photo reads in the singular; none leaves the count off but keeps the time', async () => {
    seedEvents([ev('e1', 'photo_added', 'sh1', '2026-09-15 14:00:00', { mime: 'image/png', attachment_id: 'a1' })]);
    await patchNote(null, { note: 'first' });
    expect(guestLog()).toMatch(/ · 1 photo: first$/);
    // That note is now the newest note_added (created_at is NULL in sqlite,
    // which sorts last), so give it its moment before the next one.
    eng.db.exec("UPDATE service_ticket_events SET created_at = '2026-09-15 15:00:00' WHERE kind = 'note_added'");
    await patchNote(null, { note: 'second' });
    const second = guestLog().split('\n\n').pop();
    expect(second).toMatch(new RegExp('^— Marco \\(via shared link\\) · ' + WHEN + 'C[DS]T: second$'));
    expect(noteEvent()).toEqual({ fields: ['note'] });
  });

  test('the org timezone cannot be read -> the note still saves, stamped in the default zone', async () => {
    plants.push({ match: /^SELECT timezone FROM organizations/i, run: () => { throw new Error('planted: no timezone column'); } });
    const res = await patchNote(null, { note: 'still saved' });
    expect(res.statusCode).toBe(200);
    expect(guestLog()).toMatch(new RegExp('^\\n\\n— Marco \\(via shared link\\) · ' + WHEN + 'E[DS]T: still saved$'));
  });

  test('MUTANT: count past the last note and earlier photos are claimed for this note', async () => {
    const mut = mutant([["    if (e.kind === 'note_added') break;", "    if (e.kind === 'note_added') continue;"]]);
    seedEvents([
      ev('e0', 'photo_added', 'sh1', '2026-09-15 12:00:00', { mime: 'image/jpeg', attachment_id: 'old' }),
      ev('e1', 'note_added', 'sh1', '2026-09-15 13:00:00', { fields: ['note'] }),
      ev('e2', 'photo_added', 'sh1', '2026-09-15 14:00:00', { mime: 'image/jpeg', attachment_id: 'a1' }),
    ]);
    await patchNote(mut, { note: 'x' });
    expect(guestLog()).toMatch(/ · 2 photos: x$/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * SITE PHOTOS ON THE CREW READ
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the crew read carries the work order\'s site photos, as a whitelist', () => {
  function seedSitePhotos() {
    eng.db.exec(`
      INSERT INTO attachments (id, entity_type, entity_id, filename, mime_type, thumb_url, web_url, original_url, original_key, uploaded_by, uploaded_at, tags, organization_id, position) VALUES
        ('s_crew', 'service_ticket', 'st_1', 'IMG_1.jpg', 'image/jpeg', 'https://cdn.test/s1_t', 'https://cdn.test/s1_w', 'https://cdn.test/s1_o', 'k/s1', NULL, '2026-09-15 10:00:00', '[]', 1, 0),
        ('s_office', 'service_ticket', 'st_1', 'Wendy site.jpg', 'image/jpeg', 'https://cdn.test/s2_t', 'https://cdn.test/s2_w', 'https://cdn.test/s2_o', 'k/s2', 10, '2026-09-15 11:00:00', NULL, 1, 1),
        ('s_flag', 'service_ticket', 'st_1', 'flag.jpg', 'image/jpeg', 'https://cdn.test/f_t', 'https://cdn.test/f_w', 'https://cdn.test/f_o', 'k/f', NULL, '2026-09-15 12:00:00', '["flag"]', 1, 2),
        ('s_rival', 'service_ticket', 'st_1', 'rival.jpg', 'image/jpeg', 'https://cdn.test/r_t', 'https://cdn.test/r_w', 'https://cdn.test/r_o', 'k/r', NULL, '2026-09-15 13:00:00', '[]', 2, 3),
        ('s_pdf', 'service_ticket', 'st_1', 'permit.pdf', 'application/pdf', NULL, NULL, 'https://cdn.test/p_o', 'k/p', 10, '2026-09-15 14:00:00', '[]', 1, 4);
      INSERT INTO service_ticket_events (id, organization_id, ticket_id, kind, actor_kind, share_id, actor_label, detail, created_at) VALUES
        ('pe1', 1, 'st_1', 'photo_added', 'share', 'sh1', 'Marco', '{"mime":"image/jpeg","attachment_id":"s_crew"}', '2026-09-15 10:00:01');
    `);
  }

  test('newest first; exactly id, thumb_url, web_url, uploaded_at, by; flag, PDF and other-tenant rows left out', async () => {
    seedSitePhotos();
    const res = await readLink();
    expect(res.statusCode).toBe(200);
    expect(res.body.site_photos.map((p) => [p.id, p.by])).toEqual([['s_office', 'Office'], ['s_crew', 'Marco']]);
    for (const p of res.body.site_photos) {
      expect(Object.keys(p).sort()).toEqual(['by', 'id', 'thumb_url', 'uploaded_at', 'web_url']);
    }
    const json = JSON.stringify(res.body.site_photos);
    for (const leak of ['Wendy site.jpg', 's1_o', 's2_o', 'original_url', 'filename', 'uploaded_by']) expect(json).not.toContain(leak);
    expect(JSON.stringify(res.body)).not.toContain('office only');
  });

  test('a failing site photo lookup still answers the work order, with no site photos', async () => {
    seedSitePhotos();
    plants.push({ match: /FROM attachments a WHERE a\.entity_type = 'service_ticket'/i, run: () => { throw new Error('planted: attachments unavailable'); } });
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await readLink();
    err.mockRestore();
    expect(res.statusCode).toBe(200);
    expect(res.body.site_photos).toEqual([]);
    expect(res.body.tasks.map((t) => t.id)).toEqual(['k1', 'k2']);
  });

  test('MUTANT: hand back the helper\'s rows as they are and the office-only fields reach the crew', async () => {
    const mut = mutant([[
      '            return { id: p.id, thumb_url: p.thumb_url, web_url: p.web_url, uploaded_at: p.uploaded_at, by: p.by };',
      '            return p;',
    ]]);
    seedSitePhotos();
    const res = await readLink(mut);
    expect(JSON.stringify(res.body.site_photos)).toContain('original_url');
  });
});
