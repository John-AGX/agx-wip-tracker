// THE PHOTO ROSTER, DRIVEN — the real router, the real SQL, a real engine.
//
// ── WHAT THIS FILE IS PROVING ────────────────────────────────────────────
// Attachments in this app are polymorphic: one table, (entity_type, entity_id),
// with photos hanging off leads, jobs, projects and more. Only the SURFACES
// were project-shaped, and somebody asked 86 to caption the photos on a gazebo
// LEAD this week and hit exactly that — the photos existed and nothing in the
// product could list them. `GET /api/attachments/recent?roster=job|lead` is the
// missing list. The four things that can go silently wrong with it are the four
// things asserted here, each by EXECUTION:
//
//   1. THE COUNT IS THE VIEWER'S COUNT. A roster that says "12 photos" and
//      opens to 3 is the defect class this repo is built around. The expected
//      number is not typed into this file: it is computed by running
//      js/attachments.js's OWN isImageAttachment() — read out of the shipped
//      file, not copied — over the rows the viewer's own endpoint returns.
//   2. TENANCY, VARYING ONLY THE ORG. Same fixture, same caller record, same
//      role, one field different. A foreign parent must be absent AND
//      indistinguishable from one that does not exist.
//   3. CAPABILITY, VARYING ONLY THE CAPABILITY. readCapForEntity('job') is an
//      OR-list that admits the assigned-only tier. A roster is a list of job
//      NAMES, which is precisely what that tier withholds, so a caller without
//      an all-jobs capability must see only their own and their granted jobs.
//   4. ROUTE ORDER. attachment-routes.js registers GET /:entityType/:entityId
//      as a two-segment catch-all, and the file's own comments document that
//      hazard biting twice — most recently leaving My Files' "Move to" and
//      "Copy to" unreachable in production for everyone. The path is driven
//      through the real router rather than reasoned about.
//
// ── WHY THE ENGINE IS REAL ───────────────────────────────────────────────
// test/attachment-keyed-tenant-scope.test.js pairs this router with a
// hand-written pool that matches on SQL substrings. That is the right fake for
// ITS question (which doors ask the predicate at all) and the wrong one for
// this one: a roster's whole content is decided by its WHERE clause, and a fake
// that answers by string-matching would be checking the fake. So the pool here
// is test/helpers/pg-sqlite.js — the REAL emitted SQL, through a real engine,
// against a schema DERIVED from server/db.js so the fixture cannot invent a
// column.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');

const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

// ── The engine, swapped in for server/db ─────────────────────────────────
// A module-level holder so the mock factory (hoisted by jest) can reach the
// engine that is built in beforeEach.
let mockEngineRef = null;
jest.mock('../server/db', () => ({
  pool: {
    query: async (sql, params) => mockEngineRef.pool.query(sql, params),
    connect: async () => ({
      query: async (sql, params) => mockEngineRef.pool.query(sql, params),
      release: () => {},
    }),
  },
}));
jest.mock('../server/storage', () => ({
  storage: { getBuffer: async () => Buffer.from('x'), put: async () => 'u', delete: async () => {} },
}));
jest.mock('../server/anthropic-files', () => ({
  eagerUploadAttachmentById: async () => {},
  deleteAnthropicFile: async () => {},
}));

const attachmentRouter = require('../server/routes/attachment-routes');
const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');

// ── THE VIEWER'S PREDICATE, TAKEN FROM THE VIEWER ────────────────────────
// Not retyped. js/attachments.js:23 is the function the photo grid filters on;
// if someone changes it, the expected counts in this file change with it and a
// roster that stopped agreeing goes red. Retyping it here would have made this
// suite assert against a copy — which is how a count and a grid drift apart in
// the first place.
function viewerIsImageAttachment() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'attachments.js'), 'utf8');
  const m = /function isImageAttachment\(att\) \{([\s\S]*?)\n {2}\}/.exec(src);
  if (!m) throw new Error('isImageAttachment not found in js/attachments.js');
  // eslint-disable-next-line no-new-func
  return new Function('att', m[1]);
}
const isImageAttachment = viewerIsImageAttachment();

// ── The fixture ──────────────────────────────────────────────────────────
const ORG_A = 1;
const ORG_B = 2;

const TABLES = ['attachments', 'jobs', 'leads', 'job_access', 'roles', 'users'];
const SCHEMA = sqliteSchema(TABLES, {
  pk: { attachments: 'id', jobs: 'id', leads: 'id', roles: 'name', users: 'id' },
});

// Callers. THE ONLY DIFFERENCE between ADMIN_A and ADMIN_B is organization_id;
// the only difference between ADMIN_A and CREW_A is role (and therefore
// capability). Everything else — id shape, name, email — is held constant so a
// difference in the answer can only have come from the field being varied.
const ADMIN_A = { id: 10, email: 'a@x.test', name: 'Ada', role: 'admin_all', organization_id: ORG_A };
const ADMIN_B = { id: 10, email: 'a@x.test', name: 'Ada', role: 'admin_all', organization_id: ORG_B };
const CREW_A  = { id: 10, email: 'a@x.test', name: 'Ada', role: 'crew_assigned', organization_id: ORG_A };
const DESK_A  = { id: 10, email: 'a@x.test', name: 'Ada', role: 'desk_no_jobs', organization_id: ORG_A };

const ROLES = [
  // Holds the all-jobs tier.
  ['admin_all',     ['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'LEADS_VIEW', 'LEADS_EDIT']],
  // The assigned-only tier, and NOTHING wider. This is the field user the
  // capability arm exists for.
  ['crew_assigned', ['JOBS_VIEW_ASSIGNED', 'JOBS_EDIT_OWN', 'LEADS_VIEW']],
  // May see leads, may not see jobs at all.
  ['desk_no_jobs',  ['LEADS_VIEW']],
];

let nextPos = 0;
function att(db, id, type, entityId, opts) {
  const o = opts || {};
  db.pool.query(
    'INSERT INTO attachments (id, entity_type, entity_id, filename, mime_type, size_bytes, ' +
    ' thumb_url, web_url, original_url, position, taken_at, uploaded_at, markup_of, organization_id) ' +
    ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
    [id, type, entityId, id + (o.mime === 'application/pdf' ? '.pdf' : '.jpg'),
     o.mime || 'image/jpeg', 100,
     o.thumb === null ? null : (o.thumb || id + '-thumb'),
     o.thumb === null ? null : (id + '-web'),
     id + '-orig', nextPos++, o.takenAt || null, o.uploadedAt || '2026-08-01T00:00:00Z',
     o.markupOf || null,
     // The row's OWN stamp is deliberately WRONG on two rows below, to prove
     // the roster anchors on the parent and not on this column.
     o.orgStamp === undefined ? ORG_A : o.orgStamp]);
}

function seed(db) {
  for (const [name, caps] of ROLES) {
    db.pool.query('INSERT INTO roles (name, label, capabilities) VALUES ($1,$2,$3)',
      [name, name, JSON.stringify(caps)]);
  }
  db.pool.query('INSERT INTO users (id, email, name, role, organization_id) VALUES ($1,$2,$3,$4,$5)',
    [10, 'a@x.test', 'Ada', 'admin_all', ORG_A]);

  // ── LEADS ──────────────────────────────────────────────────────────────
  // THE USER'S CASE, by name. A lead with photos on it.
  db.pool.query('INSERT INTO leads (id, title, organization_id, status) VALUES ($1,$2,$3,$4)',
    ['lead_gazebo', 'Waterside Gazebo', ORG_A, 'new']);
  // Three rows the viewer WILL show, and three it will not.
  att(db, 'att_gz_2', 'lead', 'lead_gazebo', { takenAt: '2026-08-04T10:00:00Z' });
  att(db, 'att_gz_1', 'lead', 'lead_gazebo', { takenAt: '2026-08-02T09:00:00Z' });  // FIRST taken -> cover
  att(db, 'att_gz_mk', 'lead', 'lead_gazebo', { takenAt: '2026-08-09T10:00:00Z', markupOf: 'att_gz_1' });
  att(db, 'att_gz_pdf', 'lead', 'lead_gazebo', { mime: 'application/pdf', takenAt: '2026-08-10T10:00:00Z' });
  att(db, 'att_gz_nothumb', 'lead', 'lead_gazebo', { thumb: null, takenAt: '2026-08-11T10:00:00Z' });

  // A lead with NO images at all — must be absent from the roster.
  db.pool.query('INSERT INTO leads (id, title, organization_id, status) VALUES ($1,$2,$3,$4)',
    ['lead_dry', 'Paperwork Only', ORG_A, 'new']);
  att(db, 'att_dry_pdf', 'lead', 'lead_dry', { mime: 'application/pdf' });

  // ORG B's lead, with photos. Its attachments are stamped ORG_A on purpose:
  // if the roster anchored on the attachment row's own column instead of the
  // parent, this lead's photos would pull it into org A's list.
  db.pool.query('INSERT INTO leads (id, title, organization_id, status) VALUES ($1,$2,$3,$4)',
    ['lead_bravo', 'Bravo Clubhouse', ORG_B, 'new']);
  att(db, 'att_bv_1', 'lead', 'lead_bravo', { takenAt: '2026-08-20T10:00:00Z', orgStamp: ORG_A });
  att(db, 'att_bv_2', 'lead', 'lead_bravo', { takenAt: '2026-08-21T10:00:00Z', orgStamp: ORG_A });

  // ── JOBS ───────────────────────────────────────────────────────────────
  const job = (id, org, ownerId, num, title) =>
    db.pool.query('INSERT INTO jobs (id, owner_id, data, organization_id) VALUES ($1,$2,$3,$4)',
      [id, ownerId, JSON.stringify({ jobNumber: num, title }), org]);

  job('job_owned', ORG_A, 10, 'RV2006', 'Waterside 1 Siding Replacement');
  att(db, 'att_jo_1', 'job', 'job_owned', { takenAt: '2026-08-05T10:00:00Z' });
  att(db, 'att_jo_2', 'job', 'job_owned', { takenAt: '2026-08-06T10:00:00Z' });

  job('job_granted', ORG_A, 99, 'RV2007', 'Indigo West Roof');
  db.pool.query('INSERT INTO job_access (job_id, user_id, access_level) VALUES ($1,$2,$3)',
    ['job_granted', 10, 'view']);
  att(db, 'att_jg_1', 'job', 'job_granted', { takenAt: '2026-08-07T10:00:00Z' });

  // Neither owned nor granted. An assigned-only caller must never learn this
  // job's NAME from a photo roster.
  job('job_other', ORG_A, 99, 'RV2008', 'Citi Lakes Repaint');
  att(db, 'att_jx_1', 'job', 'job_other', { takenAt: '2026-08-08T10:00:00Z' });
  att(db, 'att_jx_2', 'job', 'job_other', { takenAt: '2026-08-09T10:00:00Z' });

  job('job_bravo', ORG_B, 10, 'BV1000', 'Bravo Job');
  att(db, 'att_jb_1', 'job', 'job_bravo', { takenAt: '2026-08-22T10:00:00Z', orgStamp: ORG_A });

  job('job_dry', ORG_A, 10, 'RV2009', 'No Photos Job');
}

// ── The server ───────────────────────────────────────────────────────────
let server, baseUrl;

beforeEach(async () => {
  mockEngineRef = createPgSqlite(SCHEMA, {
    jsonColumns: ['data', 'capabilities', 'tags'],
    dateColumns: ['taken_at', 'uploaded_at', 'created_at', 'updated_at'],
  });
  seed(mockEngineRef);
  setRolePool(mockEngineRef.pool);
  await refreshRoleCache();

  const app = express();
  app.use(express.json());
  app.use('/api/attachments', attachmentRouter);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = 'http://127.0.0.1:' + server.address().port;
});

afterEach(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (mockEngineRef && mockEngineRef.close) mockEngineRef.close();
  mockEngineRef = null;
});

async function call(user, url) {
  const res = await fetch(baseUrl + url, {
    headers: { authorization: 'Bearer ' + signToken(user), connection: 'close' },
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (e) { /* leave null, the raw text is asserted */ }
  return { status: res.status, body, text };
}

const names = (r) => (r.body.parents || []).map((p) => p.name).sort();
const ids = (r) => (r.body.parents || []).map((p) => p.entity_id).sort();

// ══════════════════════════════════════════════════════════════════════════
describe('1 — THE USER\'S CASE, end to end', () => {
  test('a LEAD with photos is listed, with a true count, a cover and a date', async () => {
    const r = await call(ADMIN_A, '/api/attachments/recent?roster=lead');
    expect(r.status).toBe(200);
    // Only the gazebo. lead_dry has a PDF and no images; lead_bravo is org B.
    expect(names(r)).toEqual(['Waterside Gazebo']);

    const row = r.body.parents[0];
    expect(row.entity_type).toBe('lead');
    expect(row.entity_id).toBe('lead_gazebo');

    // THE COUNT, AGAINST THE VIEWER'S OWN PREDICATE ON THE SAME FIXTURE.
    // This is the endpoint js/attachments.js actually fetches when the row is
    // clicked, filtered by the function it actually filters with.
    const viewer = await call(ADMIN_A, '/api/attachments/lead/lead_gazebo');
    expect(viewer.status).toBe(200);
    const shown = viewer.body.attachments.filter(isImageAttachment);
    expect(row.photo_count).toBe(shown.length);
    // And it is not vacuously equal because both are zero, nor equal to the
    // naive COUNT(*) that would have included the PDF and the thumbnail-less
    // image.
    expect(row.photo_count).toBe(3);
    expect(viewer.body.attachments.length).toBe(5);

    // THE COVER: the first photo TAKEN, excluding the markup. Same rule, same
    // SQL, as the project list 7bc0c225 shipped.
    expect(row.cover_thumb_url).toBe('att_gz_1-thumb');
    expect(row.cover_is_auto).toBe(true);

    // The most recent photo DATE is the newest of the counted rows — the
    // markup included, because the viewer shows it.
    expect(String(row.last_photo_at)).toContain('2026-08-09');
  });

  test('clicking through shows THOSE photos in the existing viewer', async () => {
    const roster = await call(ADMIN_A, '/api/attachments/recent?roster=lead');
    const row = roster.body.parents[0];
    const viewer = await call(ADMIN_A, '/api/attachments/' + row.entity_type + '/' + row.entity_id);
    expect(viewer.status).toBe(200);
    expect(viewer.body.attachments.filter(isImageAttachment).map((a) => a.id).sort())
      .toEqual(['att_gz_1', 'att_gz_2', 'att_gz_mk']);
  });

  test('a JOB roster does the same, with the forward-facing job name', async () => {
    const r = await call(ADMIN_A, '/api/attachments/recent?roster=job');
    expect(r.status).toBe(200);
    // jobNumber + ' ' + title, through the one shared formatter. Never a raw id.
    expect(names(r)).toEqual([
      'RV2006 Waterside 1 Siding Replacement',
      'RV2007 Indigo West Roof',
      'RV2008 Citi Lakes Repaint',
    ]);
    // job_dry has no photos and is absent.
    expect(ids(r)).not.toContain('job_dry');

    const owned = r.body.parents.find((p) => p.entity_id === 'job_owned');
    const viewer = await call(ADMIN_A, '/api/attachments/job/job_owned');
    expect(owned.photo_count).toBe(viewer.body.attachments.filter(isImageAttachment).length);
    expect(owned.photo_count).toBe(2);
  });

  test('most-recent-first, and paged', async () => {
    const r = await call(ADMIN_A, '/api/attachments/recent?roster=job');
    expect(ids(r).length).toBe(3);
    expect(r.body.parents.map((p) => p.entity_id)).toEqual(['job_other', 'job_granted', 'job_owned']);

    const p1 = await call(ADMIN_A, '/api/attachments/recent?roster=job&limit=2&offset=0');
    const p2 = await call(ADMIN_A, '/api/attachments/recent?roster=job&limit=2&offset=2');
    expect(p1.body.parents.map((p) => p.entity_id)).toEqual(['job_other', 'job_granted']);
    expect(p2.body.parents.map((p) => p.entity_id)).toEqual(['job_owned']);
  });

  test('an empty roster is empty, not an error', async () => {
    mockEngineRef.pool.query('DELETE FROM attachments WHERE entity_type = $1', ['lead']);
    const r = await call(ADMIN_A, '/api/attachments/recent?roster=lead');
    expect(r.status).toBe(200);
    expect(r.body.parents).toEqual([]);
  });

  test('the search box means the same thing on a roster tab', async () => {
    const r = await call(ADMIN_A, '/api/attachments/recent?roster=job&q=Indigo');
    expect(ids(r)).toEqual(['job_granted']);
    const byNumber = await call(ADMIN_A, '/api/attachments/recent?roster=job&q=RV2006');
    expect(byNumber.body.parents.map((p) => p.entity_id)).toEqual(['job_owned']);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('2 — TENANCY, varying ONLY the organization', () => {
  test('own org lists; the foreign parent is absent from every roster', async () => {
    const a = await call(ADMIN_A, '/api/attachments/recent?roster=lead');
    const b = await call(ADMIN_B, '/api/attachments/recent?roster=lead');
    expect(names(a)).toEqual(['Waterside Gazebo']);
    expect(names(b)).toEqual(['Bravo Clubhouse']);
    expect(a.text).not.toContain('Bravo');
    expect(b.text).not.toContain('Waterside');

    const ja = await call(ADMIN_A, '/api/attachments/recent?roster=job');
    const jb = await call(ADMIN_B, '/api/attachments/recent?roster=job');
    expect(ids(ja)).not.toContain('job_bravo');
    expect(ids(jb)).toEqual(['job_bravo']);
    expect(ja.text).not.toContain('BV1000');
  });

  test('the anchor is the PARENT, not the attachment row\'s own stamp', async () => {
    // Every org-B attachment in the fixture is stamped organization_id = ORG_A.
    // A roster that scoped on the attachment column — or on the uploader, the
    // way GET /recent's flat mode does — would list org B's lead and job to
    // org A. Assert the stamp really is what it claims, so this is a property
    // of the query and not of a mis-seeded fixture.
    const stamped = await mockEngineRef.pool.query(
      'SELECT organization_id FROM attachments WHERE id = $1', ['att_bv_1']);
    expect(String(stamped.rows[0].organization_id)).toBe(String(ORG_A));

    const a = await call(ADMIN_A, '/api/attachments/recent?roster=lead');
    expect(ids(a)).toEqual(['lead_gazebo']);
  });

  test('absent is INDISTINGUISHABLE from another tenant\'s', async () => {
    // In a roster, absence IS the refusal — there is no per-row status to
    // differ. Stated on the list, and then again on the door the row hands
    // off to, which is where a distinguishable 403 would rebuild the
    // existence oracle the 404 convention exists to prevent.
    const a = await call(ADMIN_A, '/api/attachments/recent?roster=lead');
    expect(ids(a)).not.toContain('lead_bravo');
    expect(ids(a)).not.toContain('lead_does_not_exist');

    const foreign = await call(ADMIN_A, '/api/attachments/lead/lead_bravo');
    const absent  = await call(ADMIN_A, '/api/attachments/lead/lead_nonexistent');
    expect(foreign.status).toBe(absent.status);
    expect(foreign.text).toBe(absent.text);
    expect(foreign.status).toBe(404);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('3 — CAPABILITY, varying ONLY the capability', () => {
  test('assigned-only job access sees ONLY its own and granted jobs', async () => {
    const wide = await call(ADMIN_A, '/api/attachments/recent?roster=job');
    const narrow = await call(CREW_A, '/api/attachments/recent?roster=job');

    expect(wide.status).toBe(200);
    expect(narrow.status).toBe(200);
    // job_owned: owner_id = 10. job_granted: a job_access row for user 10.
    expect(ids(narrow)).toEqual(['job_granted', 'job_owned']);
    // job_other is in the SAME ORG and has photos. The only reason it is
    // missing is the capability.
    expect(ids(wide)).toContain('job_other');
    expect(ids(narrow)).not.toContain('job_other');
    // And the NAME did not leak either — the whole point of the tier.
    expect(narrow.text).not.toContain('Citi Lakes');
    expect(narrow.text).not.toContain('RV2008');
  });

  test('the narrowing does not touch the LEAD roster, which has no such tier', async () => {
    const wide = await call(ADMIN_A, '/api/attachments/recent?roster=lead');
    const narrow = await call(CREW_A, '/api/attachments/recent?roster=lead');
    expect(ids(narrow)).toEqual(ids(wide));
  });

  test('no job capability at all is refused, not quietly emptied', async () => {
    const r = await call(DESK_A, '/api/attachments/recent?roster=job');
    expect(r.status).toBe(403);
    // An empty 200 would read to the client as "you have no jobs with photos",
    // which is a different and wrong thing to tell a user.
    expect(r.body && r.body.parents).toBeUndefined();

    const leads = await call(DESK_A, '/api/attachments/recent?roster=lead');
    expect(leads.status).toBe(200);
  });

  test('a caller with NO id is refused, not silently un-narrowed', async () => {
    // The fail-open this closes: `assignedOnlyUserId = req.user.id` yields
    // undefined, the service guards with `!= null`, and `undefined != null`
    // is FALSE — so the narrowing clause is never added and this caller gets
    // every job name in the org. Driven through the real router, not reasoned
    // about.
    const noId = { email: CREW_A.email, name: CREW_A.name, role: CREW_A.role, organization_id: CREW_A.organization_id };
    const r = await call(noId, '/api/attachments/recent?roster=job');
    expect(r.status).toBe(403);
    expect(r.body && r.body.parents).toBeUndefined();
    // The name of the job the tier exists to withhold must not be in the body.
    expect(r.text).not.toContain('Citi Lakes');
    expect(r.text).not.toContain('RV2008');
  });

  test('id 0 is a real id, not a missing one', async () => {
    // The refusal above must not be spelled `if (!req.user.id)`, which would
    // also refuse user 0. This is the distinction callerOrgId already makes.
    const zero = await call({ ...CREW_A, id: 0 }, '/api/attachments/recent?roster=job');
    expect(zero.status).toBe(200);
    expect(ids(zero)).toEqual([]);
  });

  test('an unknown roster is refused rather than guessed at', async () => {
    const r = await call(ADMIN_A, '/api/attachments/recent?roster=estimate');
    expect(r.status).toBe(400);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('4 — ROUTE ORDER: the path is not shadowed by the catch-all', () => {
  test('the roster answers the roster, driven through the real router', async () => {
    const r = await call(ADMIN_A, '/api/attachments/recent?roster=job');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.parents)).toBe(true);
    // The shadowed failure has a SIGNATURE: GET /:entityType/:entityId with
    // entityType='recent' fails entityTypeOk and answers 400 "Bad entity type",
    // which is exactly what My Files' move/copy answered for months. Name it,
    // so a future reordering that reintroduces it cannot pass as a generic
    // failure.
    expect(r.text).not.toContain('Bad entity type');
  });

  test('and the reason it CANNOT be shadowed is structural, in the real stack', async () => {
    const layers = attachmentRouter.stack.filter((l) => l.route);
    const at = (m, p) => layers.findIndex(
      (l) => l.route.path === p && l.route.methods[m]);

    const recentAt = at('get', '/recent');
    const catchAllAt = at('get', '/:entityType/:entityId');
    expect(recentAt).toBeGreaterThanOrEqual(0);
    expect(catchAllAt).toBeGreaterThanOrEqual(0);

    // /recent is registered AFTER the catch-all and is reachable anyway,
    // because Express cannot match a TWO-segment pattern against ONE segment.
    // That is the whole reason the roster is a mode of this route rather than a
    // new two-segment path: '/tags/suggest', '/:id/move' and '/:id/copy' are
    // all two segments and all had to be hoisted above the catch-all after
    // being dead in production. Assert both halves — the ordering AND the
    // segment counts — so this stays a proof and not a coincidence.
    expect(recentAt).toBeGreaterThan(catchAllAt);
    expect('/recent'.split('/').filter(Boolean).length).toBe(1);
    expect('/:entityType/:entityId'.split('/').filter(Boolean).length).toBe(2);

    // The three that DID have to be hoisted, still hoisted.
    for (const [m, p] of [['get', '/tags/suggest'], ['post', '/:id/move'], ['post', '/:id/copy']]) {
      expect(at(m, p)).toBeLessThan(at(m === 'get' ? 'get' : 'post',
        m === 'get' ? '/:entityType/:entityId' : '/:entityType/:entityId'));
    }
  });

  test('the flat /recent widget is byte-identically unchanged with no roster param', async () => {
    const r = await call(ADMIN_A, '/api/attachments/recent');
    expect(r.status).toBe(200);
    // The census drives this URL. It must still answer the flat widget's shape.
    expect(Array.isArray(r.body.attachments)).toBe(true);
    expect(r.body.parents).toBeUndefined();
    expect(r.body.roster).toBeUndefined();
  });
});
