// PHOTO PROOF STAYS PUT — THE WORK-ORDER PHOTO GUARD, EXECUTED (Work Orders 1.29, A2).
//
// A work order's photos are its proof. The attachment doors used to let that
// proof disappear under a building that still said "done": delete the only
// completion photo, move it to another job, retag it as a before photo — and
// after approval, remove any photo from the record at all.
//
// HOW: the REAL attachment router over HTTP (real requireAuth on a signed JWT,
// the real role cache from a `roles` table) against node:sqlite through the pg
// shim, over tables derived from server/db.js. Assertions are on status, body,
// the rows afterwards, the storage calls and the ticket's timeline rows.
//
// Then each guard is removed from a copy of the shipped file (CRLF normalised,
// the anchor required exactly once) and the same drive is shown to lose the
// proof again.
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

// ── the engine, swapped in for server/db, with an optional interleave hook ──
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
// Each storage.delete records whether the attachment row still existed at that
// moment: the blobs may only go after the row delete has committed.
const mockStorageCalls = [];
jest.mock('../server/storage', () => ({
  storage: {
    getBuffer: async (k) => { mockStorageCalls.push(['get', k]); return Buffer.from('BYTES:' + k); },
    put: async (k) => { mockStorageCalls.push(['put', k]); return 'https://cdn.test/' + k; },
    delete: async (k) => {
      const attId = String(k).replace(/^k\//, '').replace(/_(orig|web|thumb)\.jpg$/, '');
      const rowLeft = mockEng.all('SELECT id FROM attachments WHERE id = ?', attId).length;
      mockStorageCalls.push(['delete', k, rowLeft]);
    },
  },
}));
jest.mock('../server/anthropic-files', () => ({
  eagerUploadAttachmentById: async () => {},
  deleteAnthropicFile: async () => {},
}));

const SERVER = path.join(__dirname, '..', 'server');
const ROUTES_FILE = path.join(SERVER, 'routes', 'attachment-routes.js');
const GUARD_FILE = path.join(SERVER, 'services', 'work-order-photo-guard.js');

const attachmentRouter = require('../server/routes/attachment-routes');
const guard = require('../server/services/work-order-photo-guard');
const auth = require('../server/auth');

const TABLES = [
  'organizations', 'users', 'roles', 'jobs', 'job_access', 'leads', 'tasks',
  'service_tickets', 'service_ticket_events', 'attachments', 'org_tags',
];

const WIDE = 10;
// The narrow tier, holding no grant on j1: CREW is the person st_prog and
// st_appr are ASSIGNED TO (1.35), which is the only reason the attachment doors
// let them write a building's photos at all. NONE is the same tier assigned
// nothing — the control that never gets past the door.
const CREW = 20;
const NONE = 21;
const RIVAL = 50;
const USERS = {
  [WIDE]: { role: 'wog_wide', org: 1, name: 'Wendy Wide' },
  [CREW]: { role: 'wog_crew', org: 1, name: 'Carl Crew' },
  [NONE]: { role: 'wog_crew', org: 1, name: 'Nate None' },
  [RIVAL]: { role: 'wog_wide', org: 2, name: 'Rival Ray' },
};

const LOCKED_DELETE = "This work order is approved, so its photos are part of the record and can't be deleted. Reopen the work order first if a photo has to go.";
const LOCKED_MOVE = "This work order is approved, so its photos are part of the record and can't be moved off it. Reopen the work order first if a photo has to go.";
const LOCKED_RETAG = "This work order is approved, so its completion photos can't be changed to before photos. Reopen the work order first.";
const LAST = (ending) => 'This is the only completion photo on Bldg 784, and Bldg 784 is marked done. Undo Bldg 784 first, then ' + ending + '.';

function seed() {
  const caps = (list) => "'" + JSON.stringify(list) + "'";
  const photo = (id, type, entity, tags, org, mime) =>
    `('${id}', '${type}', '${entity}', '${id}.jpg', '${mime || 'image/jpeg'}', 10, 'k/${id}_orig.jpg', 'k/${id}_web.jpg', 'k/${id}_thumb.jpg', '${tags}', ${org}, 10, 0)`;
  const C = '[]';
  const B = '["before"]';
  mockEng.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM roles; DELETE FROM jobs;
    DELETE FROM job_access; DELETE FROM leads; DELETE FROM tasks; DELETE FROM service_tickets;
    DELETE FROM service_ticket_events; DELETE FROM attachments; DELETE FROM org_tags;

    INSERT INTO organizations (id, name) VALUES (1, 'AGX'), (2, 'Rival Co');
    INSERT INTO roles (name, capabilities) VALUES
      ('wog_wide', ${caps(['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'LEADS_VIEW', 'LEADS_EDIT'])}),
      ('wog_crew', ${caps(['JOBS_VIEW_ASSIGNED', 'JOBS_EDIT_OWN'])});
    INSERT INTO users (id, name, email, role, organization_id) VALUES
      (10, 'Wendy Wide', 'w@agx.test', 'wog_wide', 1),
      (20, 'Carl Crew', 'c@agx.test', 'wog_crew', 1),
      (21, 'Nate None', 'n@agx.test', 'wog_crew', 1),
      (50, 'Rival Ray', 'r@rival.test', 'wog_wide', 2);
    INSERT INTO jobs (id, owner_id, data, organization_id) VALUES ('j1', 10, '{}', 1), ('j9', 50, '{}', 2);

    -- assignee_user_id is the RECORD's, and it is the whole of who is
    -- responsible: no building below names anybody (1.35), and CREW holds no
    -- job_access row on j1.
    INSERT INTO service_tickets (id, organization_id, title, job_id, lead_id, status, checklist, assignee_user_id) VALUES
      ('st_prog',   1, 'Roof punch list', 'j1', NULL, 'in_progress', '[]', 20),
      ('st_appr',   1, 'Approved list',   'j1', NULL, 'approved',    '[]', 20),
      ('st_closed', 1, 'Closed list',     'j1', NULL, 'closed',      '[]', NULL),
      ('st_cancel', 1, 'Cancelled list',  'j1', NULL, 'cancelled',   '[]', NULL),
      ('st_draft',  1, 'Draft list',      'j1', NULL, 'draft',       '[]', NULL),
      ('st_b',      2, 'Rival list',      'j9', NULL, 'in_progress', '[]', NULL);

    INSERT INTO tasks (id, organization_id, title, status, scope, service_ticket_id, entity_type, entity_id, archived_at) VALUES
      ('t_784',    1, 'Bldg 784 — north side', 'done', 'org', 'st_prog',   'job', 'j1', NULL),
      ('t_785',    1, 'Bldg 785',              'done', 'org', 'st_prog',   'job', 'j1', NULL),
      ('t_786',    1, 'Bldg 786',              'open', 'org', 'st_prog',   'job', 'j1', NULL),
      ('t_900',    1, 'Bldg 900',              'done', 'org', 'st_appr',   'job', 'j1', NULL),
      ('t_700',    1, 'Bldg 700',              'done', 'org', 'st_cancel', 'job', 'j1', NULL),
      ('t_plain',  1, 'Plain task',            'done', 'org', NULL,        'job', 'j1', NULL),
      ('t_rival',  2, 'Rival bldg',            'done', 'org', 'st_b',      'job', 'j9', NULL);

    INSERT INTO attachments (id, entity_type, entity_id, filename, mime_type, size_bytes,
                             original_key, web_key, thumb_key, tags, organization_id, uploaded_by, position) VALUES
      ${photo('a_only', 'task', 't_784', C, 1)},
      ${photo('a_before784', 'task', 't_784', B, 1)},
      ${photo('a_c1', 'task', 't_785', C, 1)},
      ${photo('a_c2', 'task', 't_785', C, 1)},
      ${photo('a_open', 'task', 't_786', C, 1)},
      ${photo('a_appr_before', 'task', 't_900', B, 1)},
      ${photo('a_appr_c1', 'task', 't_900', C, 1)},
      ${photo('a_appr_c2', 'task', 't_900', C, 1)},
      ${photo('a_appr_doc', 'task', 't_900', C, 1, 'application/pdf')},
      ${photo('a_cancel_only', 'task', 't_700', C, 1)},
      ${photo('a_cancel_before', 'task', 't_700', B, 1)},
      ${photo('a_plain', 'task', 't_plain', C, 1)},
      ${photo('a_site_prog', 'service_ticket', 'st_prog', '["roof"]', 1)},
      ${photo('a_site_appr', 'service_ticket', 'st_appr', '["roof"]', 1)},
      ${photo('a_site_closed', 'service_ticket', 'st_closed', '["roof"]', 1)},
      ${photo('a_site_draft', 'service_ticket', 'st_draft', '["roof"]', 1)},
      ${photo('a_job', 'job', 'j1', C, 1)},
      ${photo('a_rival', 'task', 't_rival', C, 2)};
  `);
}

beforeAll(async () => {
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
  mockEng = { pool: { query: async () => ({ rows: [], rowCount: 0 }) }, all: () => [] };
  if (eng) eng.close();
});

// ── the drive ─────────────────────────────────────────────────────────────
function tokenFor(uid) {
  const u = USERS[uid];
  return auth.signToken({ id: uid, email: uid + '@t.test', name: u.name, role: u.role, organization_id: u.org });
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

async function call(base, uid, method, url, json) {
  const headers = { authorization: 'Bearer ' + tokenFor(uid), connection: 'close' };
  let body;
  if (json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
  const res = await fetch(base + url, { method, headers, body });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, body: parsed };
}

const del = (b, id, uid) => call(b, uid || WIDE, 'DELETE', '/api/attachments/' + id);
const putTags = (b, id, tags, uid) => call(b, uid || WIDE, 'PUT', '/api/attachments/' + id, { tags });
const bulk = (b, ids, add, remove) => call(b, WIDE, 'POST', '/api/attachments/bulk-tag', { ids, add, remove, skip_catalog: true });
const move = (b, id) => call(b, WIDE, 'POST', '/api/attachments/' + id + '/move', { entity_type: 'job', entity_id: 'j1' });

const exists = (id) => mockEng.all('SELECT id FROM attachments WHERE id = ?', id).length === 1;
const row = (id) => mockEng.all('SELECT * FROM attachments WHERE id = ?', id)[0];
const tagsOf = (id) => row(id).tags;
const events = () => mockEng.all('SELECT ticket_id, kind, actor_kind, actor_user_id, actor_label, detail, organization_id FROM service_ticket_events ORDER BY rowid');
const deletes = () => mockStorageCalls.filter((c) => c[0] === 'delete');

// ═══════════════════════════════════════════════════════════════════════════
describe('DELETE /api/attachments/:id on a work-order photo', () => {
  test('a BEFORE photo on an approved work order: 409 photo_locked, the row and its blobs stay, no event', async () => {
    const b = await serve();
    const r = await del(b, 'a_appr_before');
    expect([r.status, r.body]).toEqual([409, { error: LOCKED_DELETE, code: 'photo_locked' }]);
    expect(exists('a_appr_before')).toBe(true);
    expect(deletes()).toEqual([]);
    expect(events()).toEqual([]);
  });

  test('a SITE photo on a closed work order: 409 photo_locked, worded for closed', async () => {
    const b = await serve();
    const r = await del(b, 'a_site_closed');
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: LOCKED_DELETE.replace('is approved', 'is closed'), code: 'photo_locked' });
    expect(exists('a_site_closed')).toBe(true);
    expect(deletes()).toEqual([]);
  });

  test('a site photo on an approved work order is refused too', async () => {
    const b = await serve();
    expect((await del(b, 'a_site_appr')).body.code).toBe('photo_locked');
    expect(exists('a_site_appr')).toBe(true);
  });

  test('the ONLY completion photo on a done building: 409 last_completion_photo with the exact sentence', async () => {
    const b = await serve();
    const r = await del(b, 'a_only');
    expect([r.status, r.body]).toEqual([409, { error: LAST('delete the photo'), code: 'last_completion_photo' }]);
    expect(exists('a_only')).toBe(true);
    expect(deletes()).toEqual([]);
    expect(events()).toEqual([]);
  });

  test('its BEFORE photo still goes: before photos are not completion proof', async () => {
    const b = await serve();
    expect((await del(b, 'a_before784')).status).toBe(200);
    expect(exists('a_before784')).toBe(false);
    expect(events().map((e) => e.detail.kind)).toEqual(['before']);
  });

  test('one of TWO completion photos: 200, photo_removed on the timeline, blobs deleted after the row', async () => {
    const b = await serve();
    const r = await del(b, 'a_c1');
    expect([r.status, r.body]).toEqual([200, { ok: true }]);
    expect(exists('a_c1')).toBe(false);
    expect(exists('a_c2')).toBe(true);
    // Every blob call saw the row already gone.
    expect(deletes().map((c) => c[1]).sort()).toEqual(['k/a_c1_orig.jpg', 'k/a_c1_thumb.jpg', 'k/a_c1_web.jpg']);
    expect(deletes().every((c) => c[2] === 0)).toBe(true);
    expect(events()).toEqual([{
      ticket_id: 'st_prog', kind: 'photo_removed', actor_kind: 'user', actor_user_id: WIDE, actor_label: 'Wendy Wide',
      organization_id: 1,
      detail: { attachment_id: 'a_c1', task_id: 't_785', title: 'Bldg 785', kind: 'completion', how: 'deleted' },
    }]);
  });

  test('the check runs under the ticket lock, before the row delete', async () => {
    const b = await serve();
    const before = mockEng.log.length;
    await del(b, 'a_c1');
    const sqls = mockEng.log.slice(before).map((e) => e.sql);
    const lock = sqls.findIndex((s) => /FROM service_tickets WHERE id = \$1 AND organization_id = \$2 FOR UPDATE/.test(s));
    const count = sqls.findIndex((s) => /SELECT id, tags FROM attachments WHERE entity_type = 'task'/.test(s));
    const remove = sqls.findIndex((s) => /^DELETE FROM attachments WHERE id = \$1 AND organization_id = \$2$/.test(s));
    expect(lock).toBeGreaterThan(-1);
    expect(sqls.indexOf('BEGIN')).toBeLessThan(lock);
    expect(lock).toBeLessThan(count);
    expect(count).toBeLessThan(remove);
    expect(remove).toBeLessThan(sqls.indexOf('COMMIT'));
  });

  test('a site photo on a draft work order goes, logged as a site photo', async () => {
    const b = await serve();
    expect((await del(b, 'a_site_draft')).status).toBe(200);
    expect(events()).toEqual([expect.objectContaining({
      ticket_id: 'st_draft', kind: 'photo_removed',
      detail: { attachment_id: 'a_site_draft', task_id: null, title: null, kind: 'site', how: 'deleted' },
    })]);
  });

  test('an OPEN building\'s only completion photo goes: nothing is marked done on it', async () => {
    const b = await serve();
    expect((await del(b, 'a_open')).status).toBe(200);
    expect(exists('a_open')).toBe(false);
  });

  test('a timeline write that fails never undoes the delete', async () => {
    const b = await serve();
    mockHook = async (sql, params) => {
      if (/INSERT INTO service_ticket_events/.test(sql)) throw new Error('events table is down');
      return mockEng.pool.query(sql, params);
    };
    expect((await del(b, 'a_c1')).status).toBe(200);
    expect(exists('a_c1')).toBe(false);
  });

  test('INTERLEAVE: the building is marked done while the delete waits for the lock — the check sees it', async () => {
    const b = await serve();
    mockHook = async (sql, params) => {
      const out = await mockEng.pool.query(sql, params);
      if (/FROM service_tickets WHERE id = \$1 AND organization_id = \$2 FOR UPDATE/.test(sql)) {
        mockEng.db.exec("UPDATE tasks SET status = 'done' WHERE id = 't_786'");
      }
      return out;
    };
    const r = await del(b, 'a_open');
    expect(r.body).toEqual({ error: LAST('delete the photo').split('Bldg 784').join('Bldg 786'), code: 'last_completion_photo' });
    expect(exists('a_open')).toBe(true);
  });

  test('CONTROLS: a cancelled work order, a document, a plain task and a job photo are not guarded', async () => {
    const b = await serve();
    expect((await del(b, 'a_cancel_before')).status).toBe(200);
    expect((await del(b, 'a_cancel_only')).status).toBe(200);
    expect((await del(b, 'a_appr_doc')).status).toBe(200);
    expect((await del(b, 'a_plain')).status).toBe(200);
    expect((await del(b, 'a_job')).status).toBe(200);
    for (const id of ['a_cancel_before', 'a_cancel_only', 'a_appr_doc', 'a_plain', 'a_job']) expect(exists(id)).toBe(false);
    // Only the two cancelled work-order photos are timeline news.
    expect(events().map((e) => e.detail.attachment_id).sort()).toEqual(['a_cancel_before', 'a_cancel_only']);
  });

  test('a plain task\'s photo with no organization stamp still deletes and moves: it never enters the guarded path', async () => {
    mockEng.db.exec("UPDATE attachments SET organization_id = NULL WHERE id IN ('a_plain', 'a_job')");
    const b = await serve();
    expect((await putTags(b, 'a_plain', ['before'])).status).toBe(200);
    expect(tagsOf('a_plain')).toEqual(['before']);
    expect((await move(b, 'a_plain')).status).toBe(200);
    expect((await del(b, 'a_job')).status).toBe(200);
    expect(exists('a_job')).toBe(false);
    expect(events()).toEqual([]);
  });

  test('isWorkOrderPhoto: an image on a work order or one of its buildings, nothing else', async () => {
    const b = [];
    for (const id of ['a_c1', 'a_site_prog', 'a_appr_doc', 'a_plain', 'a_job']) b.push(await guard.isWorkOrderPhoto(mockEng.pool, row(id), 1));
    expect(b).toEqual([true, true, false, false, false]);
    expect(await guard.isWorkOrderPhoto(mockEng.pool, row('a_c1'), 2)).toBe(false);
  });

  test('another org\'s photo answers not-found before the guard runs, and stays', async () => {
    const b = await serve();
    expect((await del(b, 'a_rival', WIDE)).status).toBe(404);
    expect((await del(b, 'a_c1', RIVAL)).status).toBe(404);
    expect(exists('a_rival')).toBe(true);
    expect(exists('a_c1')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('retagging: PUT /api/attachments/:id tags and POST /bulk-tag', () => {
  test('PUT before on the last completion photo of a done building: 409, tags unchanged', async () => {
    const b = await serve();
    const r = await putTags(b, 'a_only', ['before']);
    expect([r.status, r.body]).toEqual([409, { error: LAST('change it to a before photo'), code: 'last_completion_photo' }]);
    expect(tagsOf('a_only')).toEqual([]);
  });

  test('PUT before on an approved building\'s completion photo, even with another left: 409 photo_locked', async () => {
    const b = await serve();
    const r = await putTags(b, 'a_appr_c1', ['before']);
    expect([r.status, r.body]).toEqual([409, { error: LOCKED_RETAG, code: 'photo_locked' }]);
    expect(tagsOf('a_appr_c1')).toEqual([]);
  });

  test('PUT before on one of two completion photos: 200 and photo_retagged completion -> before', async () => {
    const b = await serve();
    expect((await putTags(b, 'a_c1', ['before'])).status).toBe(200);
    expect(tagsOf('a_c1')).toEqual(['before']);
    expect(events()).toEqual([expect.objectContaining({
      ticket_id: 'st_prog', kind: 'photo_retagged', actor_user_id: WIDE,
      detail: { attachment_id: 'a_c1', task_id: 't_785', title: 'Bldg 785', from: 'completion', to: 'before' },
    })]);
  });

  test('before -> completion on an approved work order is allowed and logged', async () => {
    const b = await serve();
    expect((await putTags(b, 'a_appr_before', ['roof'])).status).toBe(200);
    expect(tagsOf('a_appr_before')).toEqual(['roof']);
    expect(events().map((e) => [e.kind, e.detail.from, e.detail.to])).toEqual([['photo_retagged', 'before', 'completion']]);
  });

  test('tags that do not change what a photo proves, and a caption, save as before on an approved work order', async () => {
    const b = await serve();
    expect((await putTags(b, 'a_appr_c1', ['roof', 'north'])).status).toBe(200);
    expect(tagsOf('a_appr_c1')).toEqual(['roof', 'north']);
    expect((await call(b, WIDE, 'PUT', '/api/attachments/a_appr_c2', { caption: 'Ridge cap' })).status).toBe(200);
    expect((await putTags(b, 'a_site_appr', ['before'])).status).toBe(200);
    expect(events()).toEqual([]);
  });

  test('bulk-tag add before across a done building\'s photos: 409, nothing written', async () => {
    const b = await serve();
    const r = await bulk(b, ['a_only', 'a_before784'], ['before']);
    expect([r.status, r.body]).toEqual([409, { error: LAST('change it to a before photo'), code: 'last_completion_photo' }]);
    expect(tagsOf('a_only')).toEqual([]);
    expect(events()).toEqual([]);
  });

  test('bulk-tag add before on both completion photos of a building: refused — none would be left', async () => {
    const b = await serve();
    const r = await bulk(b, ['a_c1', 'a_c2'], ['before']);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('last_completion_photo');
    expect([tagsOf('a_c1'), tagsOf('a_c2')]).toEqual([[], []]);
  });

  test('bulk-tag add before on one of two: 200, one retag event; bulk remove before on approved: allowed', async () => {
    const b = await serve();
    expect((await bulk(b, ['a_c1'], ['before'])).body).toMatchObject({ ok: true, changed: 1 });
    expect(tagsOf('a_c1')).toEqual(['before']);
    expect((await bulk(b, ['a_appr_before'], [], ['before'])).status).toBe(200);
    expect(tagsOf('a_appr_before')).toEqual([]);
    expect(events().map((e) => [e.detail.attachment_id, e.detail.from, e.detail.to])).toEqual([
      ['a_c1', 'completion', 'before'], ['a_appr_before', 'before', 'completion'],
    ]);
  });

  test('bulk-tag add before on an approved building: 409 photo_locked', async () => {
    const b = await serve();
    const r = await bulk(b, ['a_appr_c1'], ['before']);
    expect([r.status, r.body]).toEqual([409, { error: LOCKED_RETAG, code: 'photo_locked' }]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('POST /api/attachments/:id/move off a work order', () => {
  test('the last completion photo: 409 "then move the photo", still on the building', async () => {
    const b = await serve();
    const r = await move(b, 'a_only');
    expect([r.status, r.body]).toEqual([409, { error: LAST('move the photo'), code: 'last_completion_photo' }]);
    expect(row('a_only').entity_type).toBe('task');
  });

  test('any photo on an approved work order: 409 with the move wording', async () => {
    const b = await serve();
    expect(await move(b, 'a_appr_before')).toEqual({ status: 409, body: { error: LOCKED_MOVE, code: 'photo_locked' } });
    expect(row('a_appr_before').entity_id).toBe('t_900');
  });

  test('one of two: 200, moved, photo_removed how moved', async () => {
    const b = await serve();
    expect((await move(b, 'a_c1')).status).toBe(200);
    expect([row('a_c1').entity_type, row('a_c1').entity_id]).toEqual(['job', 'j1']);
    expect(events()).toEqual([expect.objectContaining({
      kind: 'photo_removed',
      detail: { attachment_id: 'a_c1', task_id: 't_785', title: 'Bldg 785', kind: 'completion', how: 'moved' },
    })]);
  });

  test('CONTROL: a cancelled work order\'s photo and a plain task photo move', async () => {
    const b = await serve();
    expect((await move(b, 'a_cancel_only')).status).toBe(200);
    expect((await move(b, 'a_plain')).status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE RECORD'S ASSIGNEE IS NOT EXEMPT FROM THE GUARD (1.35).
//
// routes/attachment-routes.js widens the WRITE half of a building's photos to
// the person its WORK ORDER is assigned to — without that, the crew lead who
// may tick a building could never upload the completion photo the tick demands.
// It widens WHO MAY WRITE and nothing else: what may happen to the PROOF is
// still the guard's to say, and this is where that is executed.
//
// Every refusal below is a 409 from the guard, which is also the evidence the
// access door let them through: a caller the door refuses is answered 404 or
// 403 and never reaches the guard at all. NONE, the same tier assigned nothing,
// is that control.
describe('the work order\'s assignee reaches the guard, and the guard still refuses', () => {
  test('the only completion photo on a done building: the guard\'s 409, not the door\'s 404', async () => {
    const b = await serve();
    const r = await del(b, 'a_only', CREW);
    expect([r.status, r.body]).toEqual([409, { error: LAST('delete the photo'), code: 'last_completion_photo' }]);
    expect(exists('a_only')).toBe(true);
    expect(deletes()).toEqual([]);
    expect(events()).toEqual([]);
  });

  test('a photo on the APPROVED work order they are assigned: photo_locked, delete and retag alike', async () => {
    const b = await serve();
    expect((await del(b, 'a_appr_c1', CREW)).body).toEqual({ error: LOCKED_DELETE, code: 'photo_locked' });
    expect(exists('a_appr_c1')).toBe(true);
    expect((await putTags(b, 'a_appr_c1', ['before'], CREW)).body).toEqual({ error: LOCKED_RETAG, code: 'photo_locked' });
    expect(tagsOf('a_appr_c1')).toEqual([]);
    expect(deletes()).toEqual([]);
    expect(events()).toEqual([]);
  });

  test('what the guard DOES allow them is allowed: one of two completion photos goes, with the timeline row', async () => {
    const b = await serve();
    const r = await del(b, 'a_c1', CREW);
    expect([r.status, r.body]).toEqual([200, { ok: true }]);
    expect(exists('a_c1')).toBe(false);
    expect(exists('a_c2')).toBe(true);
    // Attributed to the crew lead, on the work order that named them.
    expect(events().map((e) => [e.ticket_id, e.kind, e.actor_user_id])).toEqual([['st_prog', 'photo_removed', CREW]]);
  });

  test('CONTROL: the same tier assigned NOTHING is answered like an absent photo and never reaches the guard', async () => {
    const b = await serve();
    // The guard would say last_completion_photo / photo_locked here. The door
    // answers first, and says only that there is nothing to see.
    expect(await del(b, 'a_only', NONE)).toEqual({ status: 404, body: { error: 'Attachment not found' } });
    expect(await del(b, 'a_appr_c1', NONE)).toEqual({ status: 404, body: { error: 'Attachment not found' } });
    expect(await putTags(b, 'a_appr_c1', ['before'], NONE)).toEqual({ status: 404, body: { error: 'Attachment not found' } });
    expect(exists('a_only')).toBe(true);
    expect(exists('a_appr_c1')).toBe(true);
    expect(tagsOf('a_appr_c1')).toEqual([]);
    expect(deletes()).toEqual([]);
    expect(events()).toEqual([]);
  });

  test('and no building row carries an assignee — the widening is the record\'s or it is nothing', () => {
    expect(mockEng.all('SELECT id FROM tasks WHERE assignee_user_id IS NOT NULL')).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('the module, for callers outside the HTTP doors', () => {
  const attRow = (id) => row(id);
  // The engine's pool, with connect counted: an argument error must be thrown
  // before a client is taken.
  const watchedPool = () => ({
    query: (sql, params) => mockEng.pool.query(sql, params),
    connect: jest.fn(() => mockEng.pool.connect()),
  });

  test('subtaskHead: the part before the first dash, at most 80 characters, with a fallback', () => {
    expect(guard.subtaskHead('Bldg 784 — north side')).toBe('Bldg 784');
    expect(guard.subtaskHead('Bldg 12 – east - roof')).toBe('Bldg 12');
    expect(guard.subtaskHead('Unit 5 - roof — rear')).toBe('Unit 5');
    expect(guard.subtaskHead('X'.repeat(120))).toBe('X'.repeat(80));
    expect(guard.subtaskHead('   ')).toBe('this subtask');
    expect(guard.subtaskHead(null)).toBe('this subtask');
  });

  test('workOrderOf: no query for other entity types; null for a task on no ticket or in another org', async () => {
    const before = mockEng.log.length;
    expect(await guard.workOrderOf(mockEng.pool, attRow('a_job'), 1)).toBeNull();
    expect(mockEng.log.length).toBe(before);
    expect(await guard.workOrderOf(mockEng.pool, attRow('a_plain'), 1)).toBeNull();
    expect(await guard.workOrderOf(mockEng.pool, attRow('a_c1'), 2)).toBeNull();
    const wo = await guard.workOrderOf(mockEng.pool, attRow('a_c1'), 1, { lock: true });
    expect(wo.ticket).toMatchObject({ id: 'st_prog', organization_id: 1, status: 'in_progress' });
    expect(wo.task).toMatchObject({ id: 't_785', status: 'done', service_ticket_id: 'st_prog' });
    // Every statement it ran named the organization.
    for (const e of mockEng.log.slice(before)) expect(e.sql).toMatch(/organization_id = \$2/);
  });

  test('changeWorkOrderPhotos: an apply that throws rolls back; an apply that answers ok:false is returned', async () => {
    const opts = (apply) => ({ orgId: 1, atts: [attRow('a_c1')], op: 'delete', actor: { kind: 'user', userId: WIDE }, apply });
    await expect(guard.changeWorkOrderPhotos(mockEng.pool, opts(async (c) => {
      await c.query('DELETE FROM attachments WHERE id = $1 AND organization_id = $2', ['a_c1', 1]);
      throw new Error('storage is down');
    }))).rejects.toThrow('storage is down');
    expect(exists('a_c1')).toBe(true);
    const out = await guard.changeWorkOrderPhotos(mockEng.pool, opts(async (c) => {
      await c.query('DELETE FROM attachments WHERE id = $1 AND organization_id = $2', ['a_c1', 1]);
      return { ok: false, status: 404, error: 'Attachment not found' };
    }));
    expect(out).toEqual({ ok: false, status: 404, error: 'Attachment not found' });
    expect(exists('a_c1')).toBe(true);
    expect(events()).toEqual([]);
  });

  test('checkWorkOrderPhotos inside a caller\'s transaction: null, and the events wait for afterCommit', async () => {
    const client = await mockEng.pool.connect();
    await client.query('BEGIN');
    const afterCommit = [];
    const verdict = await guard.checkWorkOrderPhotos(client, {
      orgId: 1, atts: [attRow('a_c1')], op: 'retag', nextTags: ['before'],
      actor: { kind: 'user', userId: WIDE, label: '86' }, afterCommit,
    });
    expect(verdict).toBeNull();
    await client.query('UPDATE attachments SET tags = $1 WHERE id = $2 AND organization_id = $3', ['["before"]', 'a_c1', 1]);
    expect(events()).toEqual([]);
    await client.query('COMMIT');
    expect(afterCommit.length).toBe(1);
    for (const fn of afterCommit) await fn();
    expect(events()).toEqual([expect.objectContaining({
      kind: 'photo_retagged', actor_label: '86',
      detail: { attachment_id: 'a_c1', task_id: 't_785', title: 'Bldg 785', from: 'completion', to: 'before' },
    })]);
  });

  test('checkWorkOrderPhotos refuses a move off an approved work order and schedules nothing', async () => {
    const client = await mockEng.pool.connect();
    await client.query('BEGIN');
    const afterCommit = [];
    const collected = [];
    const verdict = await guard.checkWorkOrderPhotos(client, {
      orgId: 1, atts: [attRow('a_appr_c1'), attRow('a_job')], op: 'move', afterCommit, events: collected,
    });
    await client.query('ROLLBACK');
    expect(verdict).toMatchObject({ ok: false, status: 409, code: 'photo_locked', error: LOCKED_MOVE, attachment_id: 'a_appr_c1', task_id: 't_900' });
    expect(afterCommit).toEqual([]);
    expect(collected).toEqual([]);
  });

  test('checkWorkOrderPhotos over photos on two work orders locks both tickets in id order', async () => {
    const client = await mockEng.pool.connect();
    await client.query('BEGIN');
    const before = mockEng.log.length;
    const collected = [];
    const verdict = await guard.checkWorkOrderPhotos(client, {
      orgId: 1, atts: [attRow('a_site_prog'), attRow('a_site_draft')], op: 'delete', events: collected,
    });
    await client.query('ROLLBACK');
    expect(verdict).toBeNull();
    const locked = mockEng.log.slice(before)
      .filter((e) => /FROM service_tickets WHERE id = \$1 AND organization_id = \$2 FOR UPDATE/.test(e.sql))
      .map((e) => e.params[0]);
    expect(locked).toEqual(['st_draft', 'st_prog']);
    expect(collected.map((e) => [e.kind, e.detail.attachment_id, e.detail.kind])).toEqual([
      ['photo_removed', 'a_site_draft', 'site'], ['photo_removed', 'a_site_prog', 'site'],
    ]);
  });

  test('an unknown op is a programming error, not a pass', async () => {
    await expect(guard.checkWorkOrderPhotos(mockEng.pool, { orgId: 1, atts: [attRow('a_c1')], op: 'purge' }))
      .rejects.toThrow(/op must be delete, move or retag/);
  });

  // FAIL CLOSED: a retag that does not say what the tags become, or a call with
  // no org, would otherwise find nothing to refuse and let the change through.
  test('a retag with no nextTags, or a mis-shaped one, throws on every way in — nothing is locked or applied', async () => {
    const wo = await guard.workOrderOf(mockEng.pool, attRow('a_appr_c1'), 1, { lock: false });
    const bad = [undefined, null, 7, true, 'before', '"before"', 'not json', new Date(), Object.create({ x: 1 })];
    for (const nextTags of bad) {
      const client = await mockEng.pool.connect();
      await client.query('BEGIN');
      const before = mockEng.log.length;
      await expect(guard.checkWorkOrderPhotos(client, { orgId: 1, atts: [attRow('a_appr_c1')], op: 'retag', nextTags }))
        .rejects.toThrow(/a retag needs nextTags/);
      expect(mockEng.log.length).toBe(before);
      await client.query('ROLLBACK');
      let applied = false;
      const pool = watchedPool();
      await expect(guard.changeWorkOrderPhotos(pool, {
        orgId: 1, atts: [attRow('a_appr_c1')], op: 'retag', nextTags, apply: async () => { applied = true; return { ok: true }; },
      })).rejects.toThrow(/a retag needs nextTags/);
      expect([applied, pool.connect.mock.calls.length]).toEqual([false, 0]);
      await expect(guard.proofVerdict(mockEng.pool, wo, { orgId: 1, removing: [attRow('a_appr_c1')], op: 'retag', nextTags }))
        .rejects.toThrow(/a retag needs nextTags/);
      await expect(guard.planPhotoChange(mockEng.pool, { orgId: 1, atts: [attRow('a_appr_c1')], op: 'retag', nextTags }))
        .rejects.toThrow(/a retag needs nextTags/);
    }
    expect(tagsOf('a_appr_c1')).toEqual([]);
    expect(events()).toEqual([]);
  });

  test('the shared-contract call shape proofVerdict(db, wo, {orgId, removing, op}) for a retag is an error, not a pass', async () => {
    const wo = await guard.workOrderOf(mockEng.pool, attRow('a_only'), 1, { lock: false });
    await expect(guard.proofVerdict(mockEng.pool, wo, { orgId: 1, removing: [attRow('a_only')], op: 'retag' }))
      .rejects.toThrow(TypeError);
    // With the new tags it answers the refusal.
    expect(await guard.proofVerdict(mockEng.pool, wo, { orgId: 1, removing: [attRow('a_only')], op: 'retag', nextTags: ['before'] }))
      .toMatchObject({ ok: false, code: 'last_completion_photo', error: LAST('change it to a before photo') });
  });

  test('nextTags as the JSON string bound for $n::jsonb, top level or keyed, still refuses', async () => {
    const client = await mockEng.pool.connect();
    await client.query('BEGIN');
    expect(await guard.checkWorkOrderPhotos(client, {
      orgId: 1, atts: [attRow('a_appr_c1')], op: 'retag', nextTags: '["before"]', events: [],
    })).toMatchObject({ ok: false, status: 409, code: 'photo_locked', error: LOCKED_RETAG, attachment_id: 'a_appr_c1' });
    expect(await guard.checkWorkOrderPhotos(client, {
      orgId: 1, atts: [attRow('a_only')], op: 'retag', nextTags: '{"a_only":["before"]}', events: [],
    })).toMatchObject({ ok: false, code: 'last_completion_photo' });
    // A per-photo value may itself be the JSON text.
    expect(await guard.checkWorkOrderPhotos(client, {
      orgId: 1, atts: [attRow('a_only')], op: 'retag', nextTags: new Map([['a_only', '["before"]']]), events: [],
    })).toMatchObject({ ok: false, code: 'last_completion_photo' });
    await client.query('ROLLBACK');
    expect([tagsOf('a_appr_c1'), tagsOf('a_only')]).toEqual([[], []]);
  });

  test('keyed nextTags that name no tags for a photo it is asked about throw instead of keeping the old tags', async () => {
    const client = await mockEng.pool.connect();
    await client.query('BEGIN');
    await expect(guard.checkWorkOrderPhotos(client, {
      orgId: 1, atts: [attRow('a_only')], op: 'retag', nextTags: { a_c1: ['before'] }, events: [],
    })).rejects.toThrow(/nextTags names no tags for attachment a_only/);
    await expect(guard.checkWorkOrderPhotos(client, {
      orgId: 1, atts: [attRow('a_appr_c1')], op: 'retag', nextTags: new Map([['a_c1', ['before']]]), events: [],
    })).rejects.toThrow(/nextTags names no tags for attachment a_appr_c1/);
    await client.query('ROLLBACK');
  });

  test('delete and move need no nextTags; a delete of a document or a job photo still runs no verdict', async () => {
    const client = await mockEng.pool.connect();
    await client.query('BEGIN');
    expect(await guard.checkWorkOrderPhotos(client, { orgId: 1, atts: [attRow('a_appr_c1')], op: 'move', events: [] }))
      .toMatchObject({ code: 'photo_locked', error: LOCKED_MOVE });
    expect(await guard.checkWorkOrderPhotos(client, { orgId: 1, atts: [attRow('a_job'), attRow('a_appr_doc')], op: 'delete', events: [] }))
      .toBeNull();
    await client.query('ROLLBACK');
  });

  test('a missing orgId throws on every way in — the guard never skips its verdict for want of an org', async () => {
    for (const orgId of [undefined, null, '']) {
      for (const op of ['delete', 'move', 'retag']) {
        const client = await mockEng.pool.connect();
        await client.query('BEGIN');
        const before = mockEng.log.length;
        await expect(guard.checkWorkOrderPhotos(client, { orgId, atts: [attRow('a_only')], op, nextTags: ['before'], events: [] }))
          .rejects.toThrow(/orgId is required/);
        expect(mockEng.log.length).toBe(before);
        await client.query('ROLLBACK');
        let applied = false;
        const pool = watchedPool();
        await expect(guard.changeWorkOrderPhotos(pool, {
          orgId, atts: [attRow('a_only')], op, nextTags: ['before'], apply: async () => { applied = true; return { ok: true }; },
        })).rejects.toThrow(/orgId is required/);
        expect([applied, pool.connect.mock.calls.length]).toEqual([false, 0]);
        await expect(guard.planPhotoChange(mockEng.pool, { orgId, atts: [attRow('a_only')], op, nextTags: ['before'] }))
          .rejects.toThrow(/orgId is required/);
      }
    }
    expect(exists('a_only')).toBe(true);
    expect(tagsOf('a_only')).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MUTANTS — each guard removed from a copy, the proof shown to disappear.
// ═══════════════════════════════════════════════════════════════════════════
function mutantCopy(file, pairs, redirects) {
  let out = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  for (const [find, replace] of pairs) {
    if (out.split(find).length - 1 !== 1) throw new Error('anchor not found');
    out = out.split(find).join(replace);
  }
  const fromDir = path.dirname(file);
  const redirect = redirects || {};
  out = out.replace(/require\((['"])([^'"]+)\1\)/g, (m, _q, spec) => {
    let resolved;
    try {
      resolved = spec.charAt(0) === '.'
        ? require.resolve(path.resolve(fromDir, spec))
        : require.resolve(spec, { paths: [fromDir] });
    } catch (e) {
      return m;
    }
    if (redirect[resolved]) resolved = redirect[resolved];
    return 'require(' + JSON.stringify(resolved.split(path.sep).join('/')) + ')';
  });
  const p = path.join(os.tmpdir(), '_p86_wog_mutant_' + process.pid + '_' + Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, out, 'utf8');
  mutantPaths.push(p);
  return p;
}

async function serveMutant(routePairs, guardPairs) {
  const redirects = {};
  if (guardPairs) redirects[require.resolve(GUARD_FILE)] = mutantCopy(GUARD_FILE, guardPairs);
  return serve(require(mutantCopy(ROUTES_FILE, routePairs || [], redirects)));
}

describe('mutant harness', () => {
  test('an anchor that is absent, or present twice, throws', () => {
    expect(() => mutantCopy(ROUTES_FILE, [['this text is nowhere in the router', 'x']])).toThrow('anchor not found');
    expect(() => mutantCopy(ROUTES_FILE, [["    if (await photoGuard.isWorkOrderPhoto(pool, att, ", 'x']])).toThrow('anchor not found');
  });

  test('an unchanged copy refuses exactly like the shipped router', async () => {
    const b = await serveMutant([['function sendGuardRefusal(', 'function sendGuardRefusal /* copy */(']]);
    expect((await del(b, 'a_appr_before')).body.code).toBe('photo_locked');
  });
});

describe('MUTANT: the guards removed', () => {
  test('DELETE door without the guard: an approved work order loses a photo and its blobs', async () => {
    const b = await serveMutant([[
      "    if (await photoGuard.isWorkOrderPhoto(pool, att, callerOrgId(req))) {\n      const guardOrgId = callerOrgId(req);\n      const outcome = await photoGuard.changeWorkOrderPhotos(pool, {\n        orgId: guardOrgId,\n        atts: [att],\n        op: 'delete',",
      "    if (false) {\n      const guardOrgId = callerOrgId(req);\n      const outcome = await photoGuard.changeWorkOrderPhotos(pool, {\n        orgId: guardOrgId,\n        atts: [att],\n        op: 'delete',",
    ]]);
    const r = await del(b, 'a_appr_before');
    expect(r.status).toBe(200);
    expect(exists('a_appr_before')).toBe(false);
    expect(deletes().map((c) => c[1])).toContain('k/a_appr_before_orig.jpg');
    // ...and the last completion photo on a done building goes with it.
    expect((await del(b, 'a_only')).status).toBe(200);
    expect(exists('a_only')).toBe(false);
  });

  test('rule (a) removed: an approved work order\'s before photo is deleted', async () => {
    const b = await serveMutant([], [[
      "    if (op !== 'retag') return refusal('photo_locked', lockedMessage(status, op), images[0], wo);",
      '    /* MUTANT */']]);
    expect((await del(b, 'a_appr_before')).status).toBe(200);
    expect(exists('a_appr_before')).toBe(false);
  });

  test('rule (b) removed: an approved building\'s completion photo becomes a before photo', async () => {
    const b = await serveMutant([], [[
      "    if (losing.length) return refusal('photo_locked', lockedMessage(status, op), losing[0], wo);",
      '    /* MUTANT */']]);
    // a_appr_c2 is still a completion photo, so rule (c) cannot stand in for (b).
    expect((await putTags(b, 'a_appr_c1', ['before'])).status).toBe(200);
    expect(tagsOf('a_appr_c1')).toEqual(['before']);
    expect(tagsOf('a_appr_c2')).toEqual([]);
  });

  test('retag without nextTags no longer throwing: the approved photo\'s retag passes silently', async () => {
    const mg = require(mutantCopy(GUARD_FILE, [[
      "  throw new TypeError('work-order-photo-guard: a retag needs nextTags — the new tags as an array, a Map or object ' +\n    'keyed by attachment id, or a function(att) (got ' + (v === null ? 'null' : typeof nextTags) + ')');",
      '  return function (att) { return att.tags; };']]));
    const client = await mockEng.pool.connect();
    await client.query('BEGIN');
    expect(await mg.checkWorkOrderPhotos(client, { orgId: 1, atts: [row('a_appr_c1')], op: 'retag', events: [] })).toBeNull();
    expect(await mg.checkWorkOrderPhotos(client, { orgId: 1, atts: [row('a_only')], op: 'retag', nextTags: '"before"', events: [] })).toBeNull();
    await client.query('ROLLBACK');
  });

  test('a null orgId no longer throwing: the guard finds no work order and the last completion photo is deleted', async () => {
    const mg = require(mutantCopy(GUARD_FILE, [[
      "  if (orgId == null || orgId === '') {\n    throw new TypeError('work-order-photo-guard: orgId is required",
      "  if (false) {\n    throw new TypeError('work-order-photo-guard: orgId is required"]]));
    const out = await mg.changeWorkOrderPhotos(mockEng.pool, {
      orgId: null, atts: [row('a_only')], op: 'delete',
      apply: async (c) => {
        await c.query('DELETE FROM attachments WHERE id = $1 AND organization_id = $2', ['a_only', 1]);
        return { ok: true };
      },
    });
    expect(out).toMatchObject({ ok: true });
    expect(exists('a_only')).toBe(false);
  });

  test('rule (c) removed: the only completion photo on a done building is deleted', async () => {
    const b = await serveMutant([], [['    if (left === 0) {', '    if (false) {']]);
    expect((await del(b, 'a_only')).status).toBe(200);
    expect(exists('a_only')).toBe(false);
  });

  test('the task NOT read again under the lock: the interleaved done building loses its photo', async () => {
    const b = await serveMutant([], [[
      '    if (!lock) return { ticket: ticket, task: task };',
      '    return { ticket: ticket, task: task };']]);
    mockHook = async (sql, params) => {
      const out = await mockEng.pool.query(sql, params);
      if (/FROM service_tickets WHERE id = \$1 AND organization_id = \$2 FOR UPDATE/.test(sql)) {
        mockEng.db.exec("UPDATE tasks SET status = 'done' WHERE id = 't_786'");
      }
      return out;
    };
    expect((await del(b, 'a_open')).status).toBe(200);
    expect(exists('a_open')).toBe(false);
  });

  test('PUT without the retag guard: the last completion photo becomes a before photo', async () => {
    const b = await serveMutant([[
      '    if (nextTagsForCatalog && photoGuard.retagChangesProof(att, nextTagsForCatalog) &&\n        await photoGuard.isWorkOrderPhoto(pool, att, callerOrgId(req))) {',
      '    if (false) {']]);
    expect((await putTags(b, 'a_only', ['before'])).status).toBe(200);
    expect(tagsOf('a_only')).toEqual(['before']);
  });

  test('bulk-tag without the retag guard: the same, through the batch door', async () => {
    const b = await serveMutant([['    if (retagged.length && await photoGuard.isWorkOrderPhoto(', '    if (false && await photoGuard.isWorkOrderPhoto(']]);
    expect((await bulk(b, ['a_appr_c1'], ['before'])).status).toBe(200);
    expect(tagsOf('a_appr_c1')).toEqual(['before']);
  });

  test('move without the guard: the last completion photo walks off the building', async () => {
    const b = await serveMutant([[
      "    if (await photoGuard.isWorkOrderPhoto(pool, att, orgId)) {\n      const outcome = await photoGuard.changeWorkOrderPhotos(pool, {\n        orgId,\n        atts: [att],\n        op: 'move',",
      "    if (false) {\n      const outcome = await photoGuard.changeWorkOrderPhotos(pool, {\n        orgId,\n        atts: [att],\n        op: 'move',",
    ]]);
    expect((await move(b, 'a_only')).status).toBe(200);
    expect(row('a_only').entity_type).toBe('job');
  });
});
