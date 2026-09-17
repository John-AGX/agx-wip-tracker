// WORK-ORDER PHOTOS FOLLOW THE TICKET'S PARENT — EVERY ATTACHMENT DOOR, EXECUTED.
//
// ── THE DEFECT ────────────────────────────────────────────────────────────
// Attachments are polymorphic, and 'service_ticket' is one of the entity types
// (crew photos from the guest work-order page land there). The capability for
// an attachment's entity type comes from services/attachment-entity-access.js,
// whose readCapForEntity / writeCapForEntity had no service_ticket arm, so the
// type fell through to their LEADS_VIEW / LEADS_EDIT default. A ticket has no
// capability of its own — it inherits its PARENT's (services/service-ticket-
// access.js) — so every attachment door answered the wrong question:
//
//   * a LEADS_VIEW-only user listed and downloaded the photos on a JOB ticket
//     they cannot open;
//   * a JOBS_VIEW_ALL user without LEADS_VIEW was refused their own job's
//     work-order photos;
//   * the narrow job tier (JOBS_VIEW_ASSIGNED / JOBS_EDIT_OWN) was never
//     narrowed to the jobs the caller is actually on.
//
// ── THE SAME DEFECT, THE OTHER HALF (1.30) ────────────────────────────────
// A work order's BUILDINGS are task rows, and the crew's before / completion
// photos hang on entity_type 'task'. The ticket rule short-circuited for every
// entity type but the ticket itself, so the building half kept the coarse
// 'task' string — JOBS_* plus LEADS_VIEW / LEADS_EDIT, org-wide, no job check.
// A leads-only user listed and downloaded every building photo on a job they
// cannot open; a PM off that job moved a completion photo onto a lead of their
// own, or deleted it, on any work order the 1.29 photo guard does not lock.
// ticketParentOk now resolves a task through the photo guard (task ->
// service_ticket_id -> ticket, org-scoped) and asks the ticket's rule, with ONE
// exception: on the WRITE half, the building's own assignee passes, because
// service-ticket-subtask-door.js lets them finish a building without the right
// to edit the job and finishing means uploading its completion photo. A task on
// no ticket keeps its own rule, untouched.
//
// ── THE FIX UNDER TEST ────────────────────────────────────────────────────
// The flat functions now return the COARSE list for 'service_ticket' (the
// necessary pre-gate), and every door — list, raw bytes, tag suggest, upload,
// caption PUT, DELETE, bulk-tag, move and copy sources, all five file-folders
// doors, and the Scribe's attachment.photo_updates — loads the ticket by id AND
// organization and asks mayAccessTicketParent. not_assigned and a missing or
// foreign ticket take the door's own not-found answer, byte for byte;
// no_capability takes the door's existing 403 — the same classification the
// ticket REST doors give (test/service-ticket-route-access.test.js pins a
// leads-only user on a job ticket at 403 there too).
//
// ── HOW ───────────────────────────────────────────────────────────────────
// The REAL routers run over HTTP — real requireAuth on a signed JWT, the real
// role cache loaded from a `roles` table — against node:sqlite through the pg
// shim, over a schema derived from server/db.js. Assertions are on status,
// body and the rows afterwards. No route source is read as a pass condition.
//
// Then each new check is REMOVED from a copy of the shipped file and the
// identical drive is shown to produce the defect again. The copies live in the
// OS temp dir (other suites census server/ for source), every require in them is
// rewritten to an absolute path so they load the same mocked db, the same auth
// cache and the same modules, and the harness THROWS when an anchor is absent,
// matches more than once, or moves no bytes — the repo is CRLF on disk and an
// LF anchor that silently fails to apply is a mutation test that proved nothing.
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

// ── the engine, swapped in for server/db ──────────────────────────────────
let mockEng = null;
jest.mock('../server/db', () => ({
  pool: {
    query: async (sql, params) => mockEng.pool.query(sql, params),
    connect: async () => ({
      query: async (sql, params) => mockEng.pool.query(sql, params),
      release: () => {},
    }),
  },
}));
// DELETE destroys the blob before the row, so the spy is part of the evidence
// that a refused delete touched nothing.
const mockStorageCalls = [];
jest.mock('../server/storage', () => ({
  storage: {
    getBuffer: async (k) => { mockStorageCalls.push(['get', k]); return Buffer.from('BYTES:' + k); },
    put: async (k) => { mockStorageCalls.push(['put', k]); return 'https://cdn.test/' + k; },
    delete: async (k) => { mockStorageCalls.push(['delete', k]); },
  },
}));
jest.mock('../server/anthropic-files', () => ({
  eagerUploadAttachmentById: async () => {},
  deleteAnthropicFile: async () => {},
}));

const SERVER = path.join(__dirname, '..', 'server');
const ROUTES_FILE = path.join(SERVER, 'routes', 'attachment-routes.js');
const FOLDERS_FILE = path.join(SERVER, 'routes', 'file-folders-routes.js');
const ACCESS_FILE = path.join(SERVER, 'services', 'attachment-entity-access.js');
const DISPATCHER_FILE = path.join(SERVER, 'services', 'payload-dispatcher.js');

const attachmentRouter = require('../server/routes/attachment-routes');
const foldersRouter = require('../server/routes/file-folders-routes');
const entityAccess = require('../server/services/attachment-entity-access');
const ticketAccess = require('../server/services/service-ticket-access');
const dispatcher = require('../server/services/payload-dispatcher');
const auth = require('../server/auth');

const TABLES = [
  'organizations', 'users', 'roles', 'jobs', 'job_access', 'leads', 'tasks',
  'service_tickets', 'service_ticket_events', 'attachments', 'file_folders', 'org_tags',
];

// ── the people ────────────────────────────────────────────────────────────
// Role names are deliberately not 'admin' / 'system_admin', so no adminish
// short-circuit anywhere can stand in for the capability under test.
const WIDE = 10;      // every job and lead capability
const JOBS = 11;      // JOBS_VIEW_ALL + JOBS_EDIT_ANY, and NO lead capability
const JOBVIEW = 12;   // JOBS_VIEW_ALL only
const CREW = 20;      // the narrow tier: JOBS_VIEW_ASSIGNED + JOBS_EDIT_OWN
const LEADS = 30;     // LEADS_VIEW + LEADS_EDIT
const LEADVIEW = 31;  // LEADS_VIEW only — the user the finding names
const NOBODY = 40;    // signed in, no ticket-relevant capability
const RIVAL = 50;     // every capability, in ANOTHER organization

const USERS = {
  [WIDE]: { role: 'sta_wide', org: 1 },
  [JOBS]: { role: 'sta_jobs', org: 1 },
  [JOBVIEW]: { role: 'sta_jobview', org: 1 },
  [CREW]: { role: 'sta_crew', org: 1 },
  [LEADS]: { role: 'sta_leads', org: 1 },
  [LEADVIEW]: { role: 'sta_leadview', org: 1 },
  [NOBODY]: { role: 'sta_none', org: 1 },
  [RIVAL]: { role: 'sta_wide', org: 2 },
};

// Which ticket / photo each named target is. 'absent' is the control every
// hidden refusal is compared against, byte for byte.
const TICKET = {
  j1: 'st_j1',            // job j1 — CREW holds a VIEW grant
  j2: 'st_j2',            // job j2 — CREW holds an EDIT grant
  j3: 'st_j3',            // job j3 — CREW holds nothing
  l1: 'st_l1',            // lead l1
  foreign: 'st_b',        // org 2's ticket
  unowned: 'st_unowned',  // a ticket row that names no organization at all
  orphan: 'st_gone',      // a ticket that no longer exists
  absent: 'st_nope',
};
const PHOTO = {
  j1: 'att_j1', j2: 'att_j2', j3: 'att_j3', l1: 'att_l1',
  foreign: 'att_b', unowned: 'att_unowned', orphan: 'att_orphan', absent: 'att_nope',
};
// The BUILDINGS of those work orders — where the before / completion photos
// actually live (entity_type 'task'). `asg` is a building on job j3, assigned
// to CREW, who holds no grant on j3: the assignee exception, and nothing else.
// `plain` is an ordinary org to-do on no ticket — the control that must not move.
const BUILDING = {
  j1: 'tk_j1', j2: 'tk_j2', j3: 'tk_j3', l1: 'tk_l1',
  asg: 'tk_asg', plain: 'tk_plain', foreign: 'tk_b', absent: 'tk_nope',
};
const BPHOTO = {
  j1: 'att_tk_j1', j2: 'att_tk_j2', j3: 'att_tk_j3', l1: 'att_tk_l1',
  asg: 'att_tk_asg', plain: 'att_tk_plain', foreign: 'att_tk_b', absent: 'att_nope',
};

function seed() {
  const caps = (list) => "'" + JSON.stringify(list) + "'";
  mockEng.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM roles; DELETE FROM jobs;
    DELETE FROM job_access; DELETE FROM leads; DELETE FROM tasks; DELETE FROM service_tickets;
    DELETE FROM service_ticket_events;
    DELETE FROM attachments; DELETE FROM file_folders; DELETE FROM org_tags;

    INSERT INTO organizations (id, name) VALUES (1, 'AGX'), (2, 'Rival Co');
    INSERT INTO roles (name, capabilities) VALUES
      ('sta_wide',     ${caps(['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'LEADS_VIEW', 'LEADS_EDIT'])}),
      ('sta_jobs',     ${caps(['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY'])}),
      ('sta_jobview',  ${caps(['JOBS_VIEW_ALL'])}),
      ('sta_crew',     ${caps(['JOBS_VIEW_ASSIGNED', 'JOBS_EDIT_OWN'])}),
      ('sta_leads',    ${caps(['LEADS_VIEW', 'LEADS_EDIT'])}),
      ('sta_leadview', ${caps(['LEADS_VIEW'])}),
      ('sta_none',     ${caps(['ESTIMATES_VIEW'])});
    INSERT INTO users (id, name, email, role, organization_id) VALUES
      (10, 'Wendy Wide', 'w@agx.test', 'sta_wide', 1),
      (11, 'Jake Jobs', 'j@agx.test', 'sta_jobs', 1),
      (12, 'Vic View', 'v@agx.test', 'sta_jobview', 1),
      (20, 'Carl Crew', 'c@agx.test', 'sta_crew', 1),
      (30, 'Lena Leads', 'l@agx.test', 'sta_leads', 1),
      (31, 'Lou Leadview', 'lv@agx.test', 'sta_leadview', 1),
      (40, 'Nora None', 'n@agx.test', 'sta_none', 1),
      (50, 'Rival Ray', 'r@rival.test', 'sta_wide', 2);

    INSERT INTO jobs (id, owner_id, data, organization_id) VALUES
      ('j1', 10, '{}', 1), ('j2', 10, '{}', 1), ('j3', 10, '{}', 1), ('j9', 50, '{}', 2);
    INSERT INTO job_access (job_id, user_id, access_level) VALUES
      ('j1', 20, 'view'), ('j2', 20, 'edit');
    INSERT INTO leads (id, title, organization_id) VALUES
      ('l1', 'Maple St reroof', 1), ('l9', 'Rival lead', 2);

    INSERT INTO service_tickets (id, organization_id, title, job_id, lead_id, status, checklist) VALUES
      ('st_j1', 1, 'Gate on j1', 'j1', NULL, 'open', '[]'),
      ('st_j2', 1, 'Gate on j2', 'j2', NULL, 'open', '[]'),
      ('st_j3', 1, 'Gate on j3', 'j3', NULL, 'open', '[]'),
      ('st_l1', 1, 'Lead gate',  NULL, 'l1', 'open', '[]'),
      ('st_b',  2, 'RIVAL gate', 'j9', NULL, 'open', '[]'),
      ('st_unowned', NULL, 'No tenant named', 'j1', NULL, 'open', '[]');

    -- The buildings on those work orders. tk_asg is assigned to CREW (20), who
    -- holds no grant on j3; tk_plain hangs on no ticket at all.
    INSERT INTO tasks (id, organization_id, title, status, scope, service_ticket_id,
                       entity_type, entity_id, assignee_user_id, archived_at) VALUES
      ('tk_j1',    1, 'Bldg 1 — j1',   'open', 'org', 'st_j1', 'job',  'j1', NULL, NULL),
      ('tk_j2',    1, 'Bldg 2 — j2',   'open', 'org', 'st_j2', 'job',  'j2', NULL, NULL),
      ('tk_j3',    1, 'Bldg 3 — j3',   'open', 'org', 'st_j3', 'job',  'j3', NULL, NULL),
      ('tk_l1',    1, 'Bldg L — l1',   'open', 'org', 'st_l1', 'lead', 'l1', NULL, NULL),
      ('tk_asg',   1, 'Bldg 9 — j3',   'open', 'org', 'st_j3', 'job',  'j3', 20,   NULL),
      ('tk_plain', 1, 'Office to-do',  'open', 'org', NULL,    'job',  'j1', NULL, NULL),
      ('tk_b',     2, 'Rival bldg',    'open', 'org', 'st_b',  'job',  'j9', NULL, NULL);

    -- Crew photos, written the way the guest door writes them: uploaded_by
    -- NULL, organization stamp copied off the ticket.
    INSERT INTO attachments (id, entity_type, entity_id, filename, mime_type, size_bytes,
                             original_key, web_key, caption, tags, organization_id, uploaded_by, position) VALUES
      ('att_j1', 'service_ticket', 'st_j1', 'CREW-J1.jpg', 'image/jpeg', 10, 'k/j1_orig.jpg', 'k/j1_web.jpg', NULL, '["roof"]', 1, NULL, 0),
      ('att_j2', 'service_ticket', 'st_j2', 'CREW-J2.jpg', 'image/jpeg', 10, 'k/j2_orig.jpg', 'k/j2_web.jpg', NULL, '["roof"]', 1, NULL, 0),
      ('att_j3', 'service_ticket', 'st_j3', 'CREW-J3.jpg', 'image/jpeg', 10, 'k/j3_orig.jpg', 'k/j3_web.jpg', NULL, '["roof"]', 1, NULL, 0),
      ('att_l1', 'service_ticket', 'st_l1', 'CREW-L1.jpg', 'image/jpeg', 10, 'k/l1_orig.jpg', 'k/l1_web.jpg', NULL, '["roof"]', 1, NULL, 0),
      ('att_b',  'service_ticket', 'st_b',  'RIVAL.jpg',   'image/jpeg', 10, 'k/b_orig.jpg',  'k/b_web.jpg',  NULL, '["roof"]', 2, NULL, 0),
      ('att_unowned', 'service_ticket', 'st_unowned', 'UNOWNED.jpg', 'image/jpeg', 10, 'k/u_orig.jpg', 'k/u_web.jpg', NULL, '["roof"]', 1, NULL, 0),
      ('att_orphan',  'service_ticket', 'st_gone',    'ORPHAN.jpg',  'image/jpeg', 10, 'k/o_orig.jpg', 'k/o_web.jpg', NULL, '["roof"]', 1, NULL, 0),
      -- CONTROLS: the same shape on a lead and on a job. Their rules must not move.
      ('att_lead', 'lead', 'l1', 'LEAD.jpg', 'image/jpeg', 10, 'k/ld_orig.jpg', 'k/ld_web.jpg', NULL, '["roof"]', 1, 10, 0),
      ('att_job',  'job',  'j1', 'JOB.jpg',  'image/jpeg', 10, 'k/jb_orig.jpg', 'k/jb_web.jpg', NULL, '["roof"]', 1, 10, 0),
      -- BUILDING photos: one per building, tags [] (a completion photo).
      ('att_tk_j1',    'task', 'tk_j1',    'BLDG-J1.jpg',    'image/jpeg', 10, 'k/tj1_orig.jpg', 'k/tj1_web.jpg', NULL, '[]', 1, NULL, 0),
      ('att_tk_j2',    'task', 'tk_j2',    'BLDG-J2.jpg',    'image/jpeg', 10, 'k/tj2_orig.jpg', 'k/tj2_web.jpg', NULL, '[]', 1, NULL, 0),
      ('att_tk_j3',    'task', 'tk_j3',    'BLDG-J3.jpg',    'image/jpeg', 10, 'k/tj3_orig.jpg', 'k/tj3_web.jpg', NULL, '[]', 1, NULL, 0),
      ('att_tk_l1',    'task', 'tk_l1',    'BLDG-L1.jpg',    'image/jpeg', 10, 'k/tl1_orig.jpg', 'k/tl1_web.jpg', NULL, '[]', 1, NULL, 0),
      ('att_tk_asg',   'task', 'tk_asg',   'BLDG-ASG.jpg',   'image/jpeg', 10, 'k/tas_orig.jpg', 'k/tas_web.jpg', NULL, '[]', 1, NULL, 0),
      ('att_tk_plain', 'task', 'tk_plain', 'BLDG-PLAIN.jpg', 'image/jpeg', 10, 'k/tpl_orig.jpg', 'k/tpl_web.jpg', NULL, '[]', 1, 10,   0),
      ('att_tk_b',     'task', 'tk_b',     'BLDG-RIVAL.jpg', 'image/jpeg', 10, 'k/tb_orig.jpg',  'k/tb_web.jpg',  NULL, '[]', 2, NULL, 0);
  `);
}

beforeAll(async () => {
  mockEng = createPgSqlite(sqliteSchema(TABLES), {
    // 'detail' is service_ticket_events' jsonb — the photo guard's timeline
    // rows, written when a building photo is deleted or moved.
    jsonColumns: ['checklist', 'capabilities', 'data', 'tags', 'annotations', 'detail'],
  });
  // attachment-tags.js serialises catalog writes with an advisory lock; sqlite
  // has neither function. Only reached on a successful tag write.
  mockEng.db.function('hashtext', (s) => { let h = 0; const t = String(s); for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0; return h; });
  mockEng.db.function('pg_advisory_xact_lock', () => 1);
  // services/file-folders.js matches sibling names with Postgres string
  // functions sqlite lacks. Same semantics, for the one pattern it uses — so a
  // folder create that PASSES the gate can be observed succeeding rather than
  // dying at prepare, which would read as a refusal.
  mockEng.db.function('translate', (s, from, to) => {
    if (s == null) return null;
    const f = String(from); const t = String(to);
    return String(s).split('').map((c) => { const i = f.indexOf(c); return i < 0 ? c : (t[i] || ''); }).join('');
  });
  mockEng.db.function('btrim', (s) => (s == null ? null : String(s).trim()));
  mockEng.db.function('regexp_replace', (s, pat, rep, flags) => {
    if (s == null) return null;
    const re = new RegExp(String(pat).split('[[:space:]]').join('\\s'), String(flags || '').indexOf('g') >= 0 ? 'g' : '');
    return String(s).replace(re, String(rep));
  });
  auth.setRolePool(mockEng.pool);
  seed();
  await auth.refreshRoleCache();
});

beforeEach(() => { seed(); mockStorageCalls.length = 0; });

const flush = () => new Promise((r) => setTimeout(r, 30));

let mutantPaths = [];
let servers = [];
afterEach(async () => {
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
  // project-routes.js (required lazily by the attachment router) schedules an
  // unref'd boot timer; point the pool at a silent stub before closing so a late
  // query cannot log after the suite.
  const eng = mockEng;
  mockEng = { pool: { query: async () => ({ rows: [], rowCount: 0 }) } };
  if (eng) eng.close();
});

// ── the drive ─────────────────────────────────────────────────────────────
function tokenFor(uid) {
  const u = USERS[uid];
  return auth.signToken({ id: uid, email: uid + '@t.test', name: 'U' + uid, role: u.role, organization_id: u.org });
}

async function serve(attRouter, ffRouter) {
  const app = express();
  app.use(express.json());
  app.use('/api/attachments', attRouter || attachmentRouter);
  app.use('/api/file-folders', ffRouter || foldersRouter);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return 'http://127.0.0.1:' + server.address().port;
}

let shippedBase = null;
async function shipped() {
  // One server per test (afterEach closes them); cheap, and it keeps a mutant's
  // server from ever answering a shipped assertion.
  shippedBase = await serve();
  return shippedBase;
}

async function call(base, uid, method, url, opts) {
  const o = opts || {};
  const headers = { authorization: 'Bearer ' + tokenFor(uid), connection: 'close' };
  let body;
  if (o.form) body = o.form;
  else if (o.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(o.json); }
  const res = await fetch(base + url, { method, headers, body });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* bytes, asserted as text */ }
  return { status: res.status, body: json, text };
}

const answer = (r) => [r.status, r.body];
const caption = (id) => (mockEng.all('SELECT caption FROM attachments WHERE id = ?', id)[0] || {}).caption;
const exists = (id) => mockEng.all('SELECT id FROM attachments WHERE id = ?', id).length === 1;
const where = (id) => (mockEng.all('SELECT entity_type, entity_id FROM attachments WHERE id = ?', id)[0]);

function uploadForm() {
  const fd = new FormData();
  fd.append('file', new Blob(['crew note'], { type: 'text/plain' }), 'note.txt');
  return fd;
}

// Every door, keyed on a named target. `ok(r)` is what an allowed call answers.
const READ_DOORS = {
  list: {
    go: (b, u, t) => call(b, u, 'GET', '/api/attachments/service_ticket/' + TICKET[t]),
    ok: (r) => r.status === 200 && Array.isArray(r.body.attachments) && r.body.attachments.length === 1,
  },
  raw: {
    go: (b, u, t) => call(b, u, 'GET', '/api/attachments/raw/' + PHOTO[t]),
    ok: (r) => r.status === 200 && /^BYTES:k\//.test(r.text),
  },
  tagSuggest: {
    // The handler's own statement (`FROM attachments a,
    // jsonb_array_elements_text(a.tags) AS t` projecting the bare alias) is one
    // test/helpers/pg-sqlite.js cannot translate — it fails at prepare and the
    // handler answers 500. So "allowed" is proven by the statement the gate let
    // the request REACH, which the engine logs before it prepares, and every
    // refusal below is additionally a door that never reached it.
    go: async (b, u, t) => {
      const before = mockEng.log.length;
      const r = await call(b, u, 'GET', '/api/attachments/tags/suggest?entity_type=service_ticket&entity_id=' + TICKET[t]);
      r.reachedTagQuery = mockEng.log.slice(before).some((e) => /jsonb_array_elements_text\(a\.tags\)/.test(e.sql));
      return r;
    },
    ok: (r) => r.reachedTagQuery === true,
  },
  foldersList: {
    go: (b, u, t) => call(b, u, 'GET', '/api/file-folders/service_ticket/' + TICKET[t]),
    ok: (r) => r.status === 200 && Array.isArray(r.body.folders),
  },
};

const WRITE_DOORS = {
  upload: {
    go: (b, u, t) => call(b, u, 'POST', '/api/attachments/service_ticket/' + TICKET[t], { form: uploadForm() }),
    ok: (r) => r.status === 200 && r.body.ok === true && r.body.attachment && r.body.attachment.entity_type === 'service_ticket',
  },
  caption: {
    go: (b, u, t) => call(b, u, 'PUT', '/api/attachments/' + PHOTO[t], { json: { caption: 'WRITTEN' } }),
    ok: (r) => r.status === 200 && r.body.ok === true,
    rowKeyed: true,
  },
  delete: {
    go: (b, u, t) => call(b, u, 'DELETE', '/api/attachments/' + PHOTO[t]),
    ok: (r) => r.status === 200 && r.body.ok === true,
    rowKeyed: true,
  },
  bulkTag: {
    go: (b, u, t) => call(b, u, 'POST', '/api/attachments/bulk-tag', { json: { ids: [PHOTO[t]], add: ['checked'], skip_catalog: true } }),
    ok: (r) => r.status === 200 && r.body.ok === true && r.body.changed === 1,
    rowKeyed: true,
  },
  foldersCreate: {
    go: (b, u, t) => call(b, u, 'POST', '/api/file-folders/service_ticket/' + TICKET[t], { json: { name: 'Before' } }),
    ok: (r) => r.status === 200 && r.body.folder && r.body.folder.name === 'Before',
  },
  foldersPatch: {
    go: (b, u, t) => call(b, u, 'PATCH', '/api/file-folders/service_ticket/' + TICKET[t] + '/ff_none', { json: {} }),
    // Past the gate, an empty patch is the handler's own 400.
    ok: (r) => r.status === 400 && /Nothing to update/.test(r.body.error),
  },
  foldersDelete: {
    go: (b, u, t) => call(b, u, 'DELETE', '/api/file-folders/service_ticket/' + TICKET[t] + '/ff_none'),
    // Past the gate, the handler's own "Folder not found" — a different body
    // from the gate's "Not found", which is what makes the two tellable apart.
    ok: (r) => r.status === 404 && r.body.error === 'Folder not found',
  },
  foldersMoveFiles: {
    go: (b, u, t) => call(b, u, 'POST', '/api/file-folders/service_ticket/' + TICKET[t] + '/move-files', { json: { ids: ['att_x'], folder_id: null } }),
    ok: (r) => r.status === 200 && r.body.ok === true,
  },
};

// The same doors, on a BUILDING of a work order (entity_type 'task') — where
// the before / completion photos are. Keyed on the same named targets.
const BUILDING_READ_DOORS = {
  list: {
    go: (b, u, t) => call(b, u, 'GET', '/api/attachments/task/' + BUILDING[t]),
    ok: (r) => r.status === 200 && Array.isArray(r.body.attachments) && r.body.attachments.length === 1,
  },
  raw: {
    go: (b, u, t) => call(b, u, 'GET', '/api/attachments/raw/' + BPHOTO[t]),
    ok: (r) => r.status === 200 && /^BYTES:k\//.test(r.text),
  },
  tagSuggest: {
    // Same reason as the ticket's tag-suggest door: the handler's own statement
    // is one the sqlite shim cannot prepare, so "allowed" is the statement the
    // gate let the request REACH. See the note there.
    go: async (b, u, t) => {
      const before = mockEng.log.length;
      const r = await call(b, u, 'GET', '/api/attachments/tags/suggest?entity_type=task&entity_id=' + BUILDING[t]);
      r.reachedTagQuery = mockEng.log.slice(before).some((e) => /jsonb_array_elements_text\(a\.tags\)/.test(e.sql));
      return r;
    },
    ok: (r) => r.reachedTagQuery === true,
  },
  foldersList: {
    go: (b, u, t) => call(b, u, 'GET', '/api/file-folders/task/' + BUILDING[t]),
    ok: (r) => r.status === 200 && Array.isArray(r.body.folders),
  },
};

const BUILDING_WRITE_DOORS = {
  upload: {
    go: (b, u, t) => call(b, u, 'POST', '/api/attachments/task/' + BUILDING[t], { form: uploadForm() }),
    ok: (r) => r.status === 200 && r.body.ok === true && r.body.attachment && r.body.attachment.entity_type === 'task',
  },
  caption: {
    go: (b, u, t) => call(b, u, 'PUT', '/api/attachments/' + BPHOTO[t], { json: { caption: 'WRITTEN' } }),
    ok: (r) => r.status === 200 && r.body.ok === true,
    rowKeyed: true,
  },
  delete: {
    go: (b, u, t) => call(b, u, 'DELETE', '/api/attachments/' + BPHOTO[t]),
    ok: (r) => r.status === 200 && r.body.ok === true,
    rowKeyed: true,
  },
  bulkTag: {
    go: (b, u, t) => call(b, u, 'POST', '/api/attachments/bulk-tag', { json: { ids: [BPHOTO[t]], add: ['checked'], skip_catalog: true } }),
    ok: (r) => r.status === 200 && r.body.ok === true && r.body.changed === 1,
    rowKeyed: true,
  },
  foldersCreate: {
    go: (b, u, t) => call(b, u, 'POST', '/api/file-folders/task/' + BUILDING[t], { json: { name: 'Before' } }),
    ok: (r) => r.status === 200 && r.body.folder && r.body.folder.name === 'Before',
  },
};

// ═══════════════════════════════════════════════════════════════════════════
describe('the mutation harness is not the thing being fooled', () => {
  test('an anchor that is not in the file THROWS', () => {
    expect(() => mutantFile(ROUTES_FILE, [['this string is nowhere in the router', 'x']]))
      .toThrow(/MUTATION ANCHOR NOT FOUND/);
  });
  test('an anchor that matches MORE THAN ONCE throws — PUT and DELETE share a line', () => {
    expect(() => mutantFile(ROUTES_FILE, [[
      "    if (!(await ticketParentOk(req, res, att.entity_type, att.entity_id, 'write',\n      { error: 'Attachment not found' }))) return;",
      '',
    ]])).toThrow(/MATCHED 2 TIMES/);
  });
  test('a replacement that moves no bytes THROWS', () => {
    const same = 'function ticketParentOk(';
    expect(() => mutantFile(ROUTES_FILE, [[same, same]])).toThrow(/CHANGED NO BYTES/);
  });
  test('an LF-written anchor still applies to the CRLF file (the anchors below are LF)', () => {
    const src = fs.readFileSync(ROUTES_FILE, 'utf8');
    expect(src.indexOf('\r\n')).toBeGreaterThan(-1);
    expect(() => mutantFile(ROUTES_FILE, [[
      "  const wo = await workOrderTicketFor(req, entityType, entityId);\n  if (!wo) return true;",
      "  const wo = await workOrderTicketFor(req, entityType, entityId);\n  /* moved */ if (!wo) return true;",
    ]])).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('the flat capability functions: coarse for a ticket, unchanged for everything else', () => {
  test('service_ticket answers the coarse list the access module defines, per mode', () => {
    expect(entityAccess.readCapForEntity('service_ticket')).toBe(ticketAccess.coarseCaps('read').join(' '));
    expect(entityAccess.writeCapForEntity('service_ticket')).toBe(ticketAccess.coarseCaps('write').join(' '));
    // Not the LEADS fallback it used to fall through to.
    expect(entityAccess.readCapForEntity('service_ticket')).not.toBe('LEADS_VIEW');
    expect(entityAccess.writeCapForEntity('service_ticket')).not.toBe('LEADS_EDIT');
  });

  test('every other entity type answers exactly what it answered before', () => {
    expect(['lead', 'job', 'project', 'task', 'estimate', 'client', 'sub', 'user', 'org', 'purchase_order', 'bill']
      .map((t) => [t, entityAccess.readCapForEntity(t), entityAccess.writeCapForEntity(t)])).toEqual([
      ['lead', 'LEADS_VIEW', 'LEADS_EDIT'],
      ['job', 'JOBS_VIEW_ALL JOBS_VIEW_ASSIGNED JOBS_EDIT_ANY JOBS_EDIT_OWN', 'JOBS_EDIT_ANY JOBS_EDIT_OWN'],
      ['project', 'LEADS_VIEW', 'LEADS_EDIT'],
      ['task', 'JOBS_VIEW_ALL JOBS_VIEW_ASSIGNED JOBS_EDIT_ANY JOBS_EDIT_OWN LEADS_VIEW LEADS_EDIT', 'JOBS_EDIT_ANY JOBS_EDIT_OWN LEADS_EDIT'],
      ['estimate', 'ESTIMATES_VIEW', 'ESTIMATES_EDIT'],
      ['client', 'ESTIMATES_VIEW', 'ESTIMATES_EDIT'],
      ['sub', 'JOBS_VIEW_ALL JOBS_VIEW_ASSIGNED JOBS_EDIT_ANY JOBS_EDIT_OWN', 'JOBS_EDIT_ANY JOBS_EDIT_OWN'],
      ['user', '__owner__', '__owner__'],
      ['org', '__org_member__', 'USERS_MANAGE ROLES_MANAGE SYSTEM_ADMIN'],
      ['purchase_order', 'LEADS_VIEW', 'LEADS_EDIT'],
      ['bill', 'LEADS_VIEW', 'LEADS_EDIT'],
    ]);
  });

  test('the router re-exports the same functions file-folders-routes.js consumes', () => {
    expect(attachmentRouter.entityAccess.readCapForEntity).toBe(entityAccess.readCapForEntity);
    expect(attachmentRouter.entityAccess.writeCapForEntity).toBe(entityAccess.writeCapForEntity);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('ticketAttachmentAccess — the per-ticket half, at the module', () => {
  const ask = (uid, t, mode) => entityAccess.ticketAttachmentAccess({
    query: (sql, params) => mockEng.pool.query(sql, params),
    user: { id: uid, role: USERS[uid].role, organization_id: USERS[uid].org },
    ticketId: TICKET[t],
    orgId: USERS[uid].org,
    mode,
  });

  test('absent, foreign and tenant-less tickets are all the same hidden not_found', async () => {
    for (const t of ['absent', 'foreign', 'unowned', 'orphan']) {
      expect(await ask(WIDE, t, 'read')).toEqual({ ok: false, hidden: true, reason: 'not_found' });
    }
    expect(await ask(RIVAL, 'j1', 'read')).toEqual({ ok: false, hidden: true, reason: 'not_found' });
  });

  test('the narrow tier off its job is HIDDEN; a missing capability is NOT', async () => {
    expect(await ask(CREW, 'j3', 'read')).toEqual({ ok: false, hidden: true, reason: 'not_assigned' });
    expect(await ask(CREW, 'j1', 'write')).toEqual({ ok: false, hidden: true, reason: 'not_assigned' });
    expect(await ask(LEADVIEW, 'j1', 'read')).toEqual({ ok: false, hidden: false, reason: 'no_capability', kind: 'job' });
    expect(await ask(JOBVIEW, 'l1', 'read')).toEqual({ ok: false, hidden: false, reason: 'no_capability', kind: 'lead' });
  });

  test('the parent decides the allow', async () => {
    expect(await ask(JOBVIEW, 'j1', 'read')).toEqual({ ok: true });
    expect(await ask(CREW, 'j1', 'read')).toEqual({ ok: true });
    expect(await ask(CREW, 'j2', 'write')).toEqual({ ok: true });
    expect(await ask(LEADVIEW, 'l1', 'read')).toEqual({ ok: true });
  });

  test('a missing or unknown mode never defaults to either half', async () => {
    expect(await ask(WIDE, 'j1', undefined)).toEqual({ ok: false, hidden: false, reason: 'bad_mode' });
    expect(await ask(WIDE, 'j1', 'admin')).toEqual({ ok: false, hidden: false, reason: 'bad_mode' });
  });

  test('no org, or no query function, is not found — never a pass', async () => {
    const base = { query: (s, p) => mockEng.pool.query(s, p), user: { id: WIDE, role: 'sta_wide' }, ticketId: 'st_j1', mode: 'read' };
    expect(await entityAccess.ticketAttachmentAccess(Object.assign({}, base, { orgId: null }))).toMatchObject({ ok: false, hidden: true });
    expect(await entityAccess.ticketAttachmentAccess(Object.assign({}, base, { orgId: 1, query: null }))).toMatchObject({ ok: false, hidden: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe.each(Object.keys(READ_DOORS))('READ door %s on a work-order photo', (name) => {
  const door = READ_DOORS[name];

  test('THE FINDING: a LEADS_VIEW-only user is refused a JOB ticket\'s photos (403, as the ticket REST door answers)', async () => {
    const b = await shipped();
    const r = await door.go(b, LEADVIEW, 'j1');
    expect(answer(r)).toEqual([403, { error: 'Forbidden' }]);
    expect(r.text).not.toMatch(/CREW-J1|BYTES:/);
    expect(door.ok(r)).toBe(false);
  });

  test('a JOBS_VIEW_ALL user with NO lead capability reads them', async () => {
    const b = await shipped();
    expect(door.ok(await door.go(b, JOBVIEW, 'j1'))).toBe(true);
  });

  test('the narrow tier reads the job it holds a grant on, and not the one it does not', async () => {
    const b = await shipped();
    expect(door.ok(await door.go(b, CREW, 'j1'))).toBe(true);
    const off = await door.go(b, CREW, 'j3');
    expect(answer(off)).toEqual(answer(await door.go(b, CREW, 'absent')));
    expect(off.status).toBe(404);
  });

  test('a LEAD ticket follows LEADS_VIEW, not the job capabilities', async () => {
    const b = await shipped();
    expect(door.ok(await door.go(b, LEADVIEW, 'l1'))).toBe(true);
    expect(answer(await door.go(b, JOBVIEW, 'l1'))).toEqual([403, { error: 'Forbidden' }]);
  });

  test('another org\'s ticket, a tenant-less ticket and an absent one answer identically', async () => {
    const b = await shipped();
    const none = answer(await door.go(b, WIDE, 'absent'));
    expect(none[0]).toBe(404);
    expect(answer(await door.go(b, WIDE, 'foreign'))).toEqual(none);
    expect(answer(await door.go(b, WIDE, 'unowned'))).toEqual(none);
    expect(answer(await door.go(b, RIVAL, 'j1'))).toEqual(answer(await door.go(b, RIVAL, 'absent')));
  });

  test('a caller with no ticket capability at all is refused', async () => {
    const b = await shipped();
    expect((await door.go(b, NOBODY, 'j1')).status).toBe(403);
  });
});

describe('READ controls — the same doors on a lead and a job photo did not move', () => {
  test('lead photo: LEADS_VIEW reads, JOBS_VIEW_ALL is refused; job photo: the reverse', async () => {
    const b = await shipped();
    expect((await call(b, LEADVIEW, 'GET', '/api/attachments/raw/att_lead')).status).toBe(200);
    expect((await call(b, JOBVIEW, 'GET', '/api/attachments/raw/att_lead')).status).toBe(403);
    expect((await call(b, JOBVIEW, 'GET', '/api/attachments/raw/att_job')).status).toBe(200);
    expect((await call(b, LEADVIEW, 'GET', '/api/attachments/raw/att_job')).status).toBe(403);
    // A job's narrow tier is still the coarse check on job attachments — the
    // ticket rule did not leak onto other types.
    expect((await call(b, CREW, 'GET', '/api/attachments/job/j3')).status).toBe(200);
  });

  test('an ORPHAN work-order photo (its ticket is gone) answers like an absent photo', async () => {
    const b = await shipped();
    expect(answer(await READ_DOORS.raw.go(b, WIDE, 'orphan'))).toEqual(answer(await READ_DOORS.raw.go(b, WIDE, 'absent')));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe.each(Object.keys(WRITE_DOORS))('WRITE door %s on a work-order photo', (name) => {
  const door = WRITE_DOORS[name];

  test('a LEADS_EDIT user is refused on a JOB ticket (403), and nothing changed', async () => {
    const b = await shipped();
    const r = await door.go(b, LEADS, 'j1');
    expect(r.status).toBe(403);
    expect(caption('att_j1')).toBeNull();
    expect(exists('att_j1')).toBe(true);
    expect(mockStorageCalls.filter((c) => c[0] !== 'get')).toEqual([]);
    expect(mockEng.all("SELECT COUNT(*) AS n FROM attachments WHERE entity_id = 'st_j1'")[0].n).toBe(1);
  });

  test('a JOBS_EDIT_ANY user with NO lead capability may write', async () => {
    const b = await shipped();
    expect(door.ok(await door.go(b, JOBS, 'j1'))).toBe(true);
  });

  test('a VIEW grant reads but cannot write — answered like an absent id', async () => {
    const b = await shipped();
    const r = await door.go(b, CREW, 'j1');
    expect(r.status).toBe(404);
    expect(answer(r)).toEqual(answer(await door.go(b, CREW, 'absent')));
    expect(caption('att_j1')).toBeNull();
    expect(exists('att_j1')).toBe(true);
  });

  test('an EDIT grant may write', async () => {
    const b = await shipped();
    expect(door.ok(await door.go(b, CREW, 'j2'))).toBe(true);
  });

  test('a LEAD ticket follows LEADS_EDIT', async () => {
    const b = await shipped();
    expect((await door.go(b, JOBS, 'l1')).status).toBe(403);
    expect(door.ok(await door.go(b, LEADS, 'l1'))).toBe(true);
  });

  test('another org\'s ticket and a tenant-less ticket answer exactly like an absent one', async () => {
    const b = await shipped();
    const none = answer(await door.go(b, WIDE, 'absent'));
    expect(none[0]).toBe(404);
    expect(answer(await door.go(b, WIDE, 'foreign'))).toEqual(none);
    expect(answer(await door.go(b, WIDE, 'unowned'))).toEqual(none);
    if (door.rowKeyed) expect(answer(await door.go(b, WIDE, 'orphan'))).toEqual(none);
    expect(exists('att_b')).toBe(true);
    expect(exists('att_unowned')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('move and copy — the SOURCE is a work-order photo', () => {
  const move = (b, u, photo, type, id) => call(b, u, 'POST', '/api/attachments/' + photo + '/move', { json: { entity_type: type, entity_id: id } });
  const copy = (b, u, photo, type, id) => call(b, u, 'POST', '/api/attachments/' + photo + '/copy', { json: { entity_type: type, entity_id: id } });

  test('move: a leads user cannot pull a JOB ticket\'s photo onto a lead', async () => {
    const b = await shipped();
    expect(answer(await move(b, LEADS, 'att_j1', 'lead', 'l1'))).toEqual([403, { error: 'No write access on source entity' }]);
    expect(where('att_j1')).toEqual({ entity_type: 'service_ticket', entity_id: 'st_j1' });
  });

  test('move: a view grant is answered like an absent photo; an edit grant moves', async () => {
    const b = await shipped();
    expect(answer(await move(b, CREW, 'att_j1', 'job', 'j2'))).toEqual(answer(await move(b, CREW, 'att_nope', 'job', 'j2')));
    expect((await move(b, CREW, 'att_j1', 'job', 'j2')).status).toBe(404);
    expect((await move(b, CREW, 'att_j2', 'job', 'j2')).status).toBe(200);
    expect(where('att_j2')).toEqual({ entity_type: 'job', entity_id: 'j2' });
    expect((await move(b, JOBS, 'att_j1', 'job', 'j1')).status).toBe(200);
    expect((await move(b, LEADS, 'att_l1', 'lead', 'l1')).status).toBe(200);
  });

  test('copy: reading the source bytes needs the ticket read rule', async () => {
    const b = await shipped();
    expect(answer(await copy(b, LEADS, 'att_j1', 'lead', 'l1'))).toEqual([403, { error: 'No read access on source attachment' }]);
    expect(mockStorageCalls).toEqual([]);
    expect(answer(await copy(b, CREW, 'att_j3', 'job', 'j2'))).toEqual(answer(await copy(b, CREW, 'att_nope', 'job', 'j2')));
    expect((await copy(b, CREW, 'att_j1', 'job', 'j2')).status).toBe(200);   // a VIEW grant READS
    expect((await copy(b, JOBS, 'att_j1', 'job', 'j1')).status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE BUILDING HALF (1.30). Everything above, on entity_type 'task' — the
// rows the crew's before / completion photos actually hang on.
// ═══════════════════════════════════════════════════════════════════════════
describe.each(Object.keys(BUILDING_READ_DOORS))('READ door %s on a work order BUILDING photo', (name) => {
  const door = BUILDING_READ_DOORS[name];

  test('THE FINDING: a LEADS_VIEW-only user is refused a building on a JOB work order', async () => {
    const b = await shipped();
    const r = await door.go(b, LEADVIEW, 'j1');
    expect(answer(r)).toEqual([403, { error: 'Forbidden' }]);
    expect(r.text).not.toMatch(/BLDG-J1|BYTES:/);
    expect(door.ok(r)).toBe(false);
  });

  test('a JOBS_VIEW_ALL user with NO lead capability reads it', async () => {
    const b = await shipped();
    expect(door.ok(await door.go(b, JOBVIEW, 'j1'))).toBe(true);
  });

  test('the narrow tier reads the building on the job it holds a grant on, and not the one it does not', async () => {
    const b = await shipped();
    expect(door.ok(await door.go(b, CREW, 'j1'))).toBe(true);
    const off = await door.go(b, CREW, 'j3');
    expect(off.status).toBe(404);
    expect(answer(off)).toEqual(answer(await door.go(b, CREW, 'absent')));
  });

  test('a building on a LEAD work order follows LEADS_VIEW, not the job capabilities', async () => {
    const b = await shipped();
    expect(door.ok(await door.go(b, LEADVIEW, 'l1'))).toBe(true);
    expect(answer(await door.go(b, JOBVIEW, 'l1'))).toEqual([403, { error: 'Forbidden' }]);
  });

  test('another org\'s building and an absent one answer identically', async () => {
    const b = await shipped();
    const none = answer(await door.go(b, WIDE, 'absent'));
    expect(none[0]).toBe(404);
    expect(answer(await door.go(b, WIDE, 'foreign'))).toEqual(none);
    expect(answer(await door.go(b, RIVAL, 'j1'))).toEqual(answer(await door.go(b, RIVAL, 'absent')));
  });

  test('CONTROL: a task on NO work order keeps the coarse task rule, untouched', async () => {
    const b = await shipped();
    expect(door.ok(await door.go(b, LEADVIEW, 'plain'))).toBe(true);
    expect(door.ok(await door.go(b, JOBVIEW, 'plain'))).toBe(true);
  });
});

describe.each(Object.keys(BUILDING_WRITE_DOORS))('WRITE door %s on a work order BUILDING photo', (name) => {
  const door = BUILDING_WRITE_DOORS[name];

  test('THE FINDING: a LEADS_EDIT user is refused on a JOB work order\'s building, and the proof is untouched', async () => {
    const b = await shipped();
    const r = await door.go(b, LEADS, 'j1');
    expect(r.status).toBe(403);
    expect(caption('att_tk_j1')).toBeNull();
    expect(exists('att_tk_j1')).toBe(true);
    expect(where('att_tk_j1')).toEqual({ entity_type: 'task', entity_id: 'tk_j1' });
    expect(mockStorageCalls.filter((c) => c[0] !== 'get')).toEqual([]);
    expect(mockEng.all("SELECT COUNT(*) AS n FROM attachments WHERE entity_id = 'tk_j1'")[0].n).toBe(1);
  });

  test('a JOBS_EDIT_ANY user with NO lead capability may write', async () => {
    const b = await shipped();
    expect(door.ok(await door.go(b, JOBS, 'j1'))).toBe(true);
  });

  test('a VIEW grant reads but cannot write — answered like an absent id', async () => {
    const b = await shipped();
    const r = await door.go(b, CREW, 'j1');
    expect(r.status).toBe(404);
    expect(answer(r)).toEqual(answer(await door.go(b, CREW, 'absent')));
    expect(caption('att_tk_j1')).toBeNull();
    expect(exists('att_tk_j1')).toBe(true);
  });

  test('an EDIT grant may write', async () => {
    const b = await shipped();
    expect(door.ok(await door.go(b, CREW, 'j2'))).toBe(true);
  });

  test('a building on a LEAD work order follows LEADS_EDIT', async () => {
    const b = await shipped();
    expect((await door.go(b, JOBS, 'l1')).status).toBe(403);
    expect(door.ok(await door.go(b, LEADS, 'l1'))).toBe(true);
  });

  test('another org\'s building and an absent one answer exactly alike', async () => {
    const b = await shipped();
    const none = answer(await door.go(b, WIDE, 'absent'));
    expect(none[0]).toBe(404);
    expect(answer(await door.go(b, WIDE, 'foreign'))).toEqual(none);
    expect(exists('att_tk_b')).toBe(true);
  });

  test('CONTROL: a task on NO work order keeps the coarse task rule, untouched', async () => {
    const b = await shipped();
    expect(door.ok(await door.go(b, LEADS, 'plain'))).toBe(true);
  });
});

describe('move and copy — the SOURCE is a BUILDING photo', () => {
  const move = (b, u, photo, type, id) => call(b, u, 'POST', '/api/attachments/' + photo + '/move', { json: { entity_type: type, entity_id: id } });
  const copy = (b, u, photo, type, id) => call(b, u, 'POST', '/api/attachments/' + photo + '/copy', { json: { entity_type: type, entity_id: id } });

  test('THE FINDING: a leads user cannot lift a completion photo off a job\'s work order onto their own lead', async () => {
    const b = await shipped();
    expect(answer(await move(b, LEADS, 'att_tk_j1', 'lead', 'l1'))).toEqual([403, { error: 'No write access on source entity' }]);
    expect(where('att_tk_j1')).toEqual({ entity_type: 'task', entity_id: 'tk_j1' });
  });

  test('a view grant is answered like an absent photo; an edit grant moves', async () => {
    const b = await shipped();
    expect(answer(await move(b, CREW, 'att_tk_j1', 'job', 'j2'))).toEqual(answer(await move(b, CREW, 'att_nope', 'job', 'j2')));
    expect(where('att_tk_j1')).toEqual({ entity_type: 'task', entity_id: 'tk_j1' });
    expect((await move(b, CREW, 'att_tk_j2', 'job', 'j2')).status).toBe(200);
    expect(where('att_tk_j2')).toEqual({ entity_type: 'job', entity_id: 'j2' });
    expect((await move(b, JOBS, 'att_tk_j1', 'job', 'j1')).status).toBe(200);
  });

  test('copy: reading a building photo\'s bytes needs the ticket read rule', async () => {
    const b = await shipped();
    expect(answer(await copy(b, LEADS, 'att_tk_j1', 'lead', 'l1'))).toEqual([403, { error: 'No read access on source attachment' }]);
    expect(mockStorageCalls).toEqual([]);
    expect(answer(await copy(b, CREW, 'att_tk_j3', 'job', 'j2'))).toEqual(answer(await copy(b, CREW, 'att_nope', 'job', 'j2')));
    expect((await copy(b, CREW, 'att_tk_j1', 'job', 'j2')).status).toBe(200);   // a VIEW grant READS
  });

  test('CONTROL: a photo on a task with no work order still moves on the coarse rule', async () => {
    const b = await shipped();
    expect((await move(b, LEADS, 'att_tk_plain', 'lead', 'l1')).status).toBe(200);
    expect(where('att_tk_plain')).toEqual({ entity_type: 'lead', entity_id: 'l1' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE ONE EXCEPTION. services/service-ticket-subtask-door.js lets a building's
// ASSIGNEE finish it without the right to edit the job, and finishing means
// uploading its completion photo — so the assignee passes the WRITE half on
// THEIR building. Nothing else moves: not the read half, not another building
// on the same job, and not what the photo guard says may happen to the proof.
describe('the building ASSIGNEE — the write half only', () => {
  const assigneeQueries = () => mockEng.log.filter((e) => /SELECT assignee_user_id FROM tasks/.test(e.sql));

  test('CREW is not on job j3 at all: the READ half still refuses the building they are assigned', async () => {
    const b = await shipped();
    for (const name of Object.keys(BUILDING_READ_DOORS)) {
      const door = BUILDING_READ_DOORS[name];
      const r = await door.go(b, CREW, 'asg');
      expect([name, r.status]).toEqual([name, 404]);
      expect(answer(r)).toEqual(answer(await door.go(b, CREW, 'absent')));
    }
  });

  test('...but may upload the completion photo that finishing the building requires, and fix it', async () => {
    const b = await shipped();
    const up = await BUILDING_WRITE_DOORS.upload.go(b, CREW, 'asg');
    expect(BUILDING_WRITE_DOORS.upload.ok(up)).toBe(true);
    expect(up.body.attachment.entity_id).toBe('tk_asg');
    expect(BUILDING_WRITE_DOORS.caption.ok(await BUILDING_WRITE_DOORS.caption.go(b, CREW, 'asg'))).toBe(true);
    expect(caption('att_tk_asg')).toBe('WRITTEN');
    expect(BUILDING_WRITE_DOORS.bulkTag.ok(await BUILDING_WRITE_DOORS.bulkTag.go(b, CREW, 'asg'))).toBe(true);
    expect(BUILDING_WRITE_DOORS.delete.ok(await BUILDING_WRITE_DOORS.delete.go(b, CREW, 'asg'))).toBe(true);
    expect(exists('att_tk_asg')).toBe(false);
  });

  test('the exception is the building they are assigned, not the job: the next building over is refused', async () => {
    const b = await shipped();
    const r = await BUILDING_WRITE_DOORS.upload.go(b, CREW, 'j3');
    expect(answer(r)).toEqual(answer(await BUILDING_WRITE_DOORS.upload.go(b, CREW, 'absent')));
    expect(r.status).toBe(404);
    expect(answer(await BUILDING_WRITE_DOORS.caption.go(b, CREW, 'j3'))).toEqual([404, { error: 'Attachment not found' }]);
    expect(caption('att_tk_j3')).toBeNull();
  });

  test('it is the ASSIGNEE, not anyone: a leads user is still refused that same building', async () => {
    const b = await shipped();
    expect((await BUILDING_WRITE_DOORS.caption.go(b, LEADS, 'asg')).status).toBe(403);
    expect((await BUILDING_WRITE_DOORS.delete.go(b, LEADS, 'asg')).status).toBe(403);
    expect(caption('att_tk_asg')).toBeNull();
    expect(exists('att_tk_asg')).toBe(true);
  });

  test('the assignee lookup is asked only when the ticket rule already refused, and carries the org predicate', async () => {
    const b = await shipped();
    // A caller the ticket rule ALLOWS never reaches the lookup.
    mockEng.log.length = 0;
    expect(BUILDING_WRITE_DOORS.caption.ok(await BUILDING_WRITE_DOORS.caption.go(b, JOBS, 'j1'))).toBe(true);
    expect(assigneeQueries()).toEqual([]);
    // Nor does a READ the rule refused — the exception is the write half only.
    mockEng.log.length = 0;
    await BUILDING_READ_DOORS.list.go(b, CREW, 'asg');
    expect(assigneeQueries()).toEqual([]);
    // The write the rule refused asks it, in the caller's organization.
    mockEng.log.length = 0;
    await BUILDING_WRITE_DOORS.caption.go(b, CREW, 'asg');
    const asked = assigneeQueries();
    expect(asked.length).toBe(1);
    expect(asked[0].sql).toMatch(/WHERE id = \$1 AND organization_id = \$2/);
    expect(asked[0].params).toEqual(['tk_asg', 1]);
  });

  test('the photo guard still governs what the assignee may remove', async () => {
    const b = await shipped();
    mockEng.db.exec("UPDATE tasks SET status = 'done' WHERE id = 'tk_asg'");
    const r = await BUILDING_WRITE_DOORS.delete.go(b, CREW, 'asg');
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('last_completion_photo');
    expect(exists('att_tk_asg')).toBe(true);
    expect(mockStorageCalls.filter((c) => c[0] === 'delete')).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FINDING K. move and copy validated the BODY and the DESTINATION before they
// proved the SOURCE, so a source that must answer like an absent id did not
// when the body was bad or the destination absent: the absent id got
// 'Attachment not found' (its row lookup answers first) while a hidden ticket
// photo — or another tenant's file — got the body's 400 or the destination's
// 'Not found'. Two answers for "you may not know this exists".
const moveBody = (b, u, photo, json) => call(b, u, 'POST', '/api/attachments/' + photo + '/move', { json });
const copyBody = (b, u, photo, json) => call(b, u, 'POST', '/api/attachments/' + photo + '/copy', { json });
const ABSENT_DEST = { entity_type: 'job', entity_id: 'j_nope' };
// Every body shape that is refused before the destination is proved.
const BAD_BODIES = [{}, { entity_type: 'job' }, { entity_type: 'wormhole', entity_id: 'x' }, { entity_type: 'job', entity_id: '../etc' }];
const NOT_THERE = [404, { error: 'Attachment not found' }];

describe('move and copy — a refused SOURCE answers before the body or destination is read', () => {
  test('move: a hidden work-order photo with an ABSENT destination answers exactly like an absent photo', async () => {
    const b = await shipped();
    const absent = answer(await moveBody(b, CREW, 'att_nope', ABSENT_DEST));
    expect(absent).toEqual(NOT_THERE);
    // Not on the job at all, and a VIEW grant asking to write — both hidden.
    expect(answer(await moveBody(b, CREW, 'att_j3', ABSENT_DEST))).toEqual(absent);
    expect(answer(await moveBody(b, CREW, 'att_j1', ABSENT_DEST))).toEqual(absent);
    // ...and another tenant's photo, through attachmentInOrg.
    expect(answer(await moveBody(b, WIDE, 'att_b', ABSENT_DEST))).toEqual(answer(await moveBody(b, WIDE, 'att_nope', ABSENT_DEST)));
    expect(mockEng.all("SELECT entity_type FROM attachments WHERE id IN ('att_j1','att_j3','att_b')").map((r) => r.entity_type))
      .toEqual(['service_ticket', 'service_ticket', 'service_ticket']);
  });

  test('move: a hidden or foreign photo with a BAD body answers exactly like an absent photo', async () => {
    const b = await shipped();
    for (const body of BAD_BODIES) {
      const absent = answer(await moveBody(b, CREW, 'att_nope', body));
      expect(absent).toEqual(NOT_THERE);
      expect(answer(await moveBody(b, CREW, 'att_j3', body))).toEqual(absent);
      expect(answer(await moveBody(b, WIDE, 'att_b', body))).toEqual(answer(await moveBody(b, WIDE, 'att_nope', body)));
    }
  });

  test('copy: the same, for the read rule — and no byte is read', async () => {
    const b = await shipped();
    const absent = answer(await copyBody(b, CREW, 'att_nope', ABSENT_DEST));
    expect(absent).toEqual(NOT_THERE);
    expect(answer(await copyBody(b, CREW, 'att_j3', ABSENT_DEST))).toEqual(absent);
    expect(answer(await copyBody(b, WIDE, 'att_b', ABSENT_DEST))).toEqual(answer(await copyBody(b, WIDE, 'att_nope', ABSENT_DEST)));
    for (const body of BAD_BODIES) {
      expect(answer(await copyBody(b, CREW, 'att_j3', body))).toEqual(answer(await copyBody(b, CREW, 'att_nope', body)));
      expect(answer(await copyBody(b, WIDE, 'att_b', body))).toEqual(answer(await copyBody(b, WIDE, 'att_nope', body)));
    }
    expect(mockStorageCalls).toEqual([]);
  });

  test('CONTROL: a source the caller may use still gets the body\'s 400 and the destination\'s 404', async () => {
    const b = await shipped();
    expect(answer(await moveBody(b, JOBS, 'att_job', {}))).toEqual([400, { error: 'entity_type and entity_id are required' }]);
    expect(answer(await moveBody(b, JOBS, 'att_job', { entity_type: 'wormhole', entity_id: 'x' }))).toEqual([400, { error: 'invalid entity_type' }]);
    expect(answer(await moveBody(b, JOBS, 'att_job', ABSENT_DEST))).toEqual([404, { error: 'Not found' }]);
    expect(answer(await copyBody(b, JOBS, 'att_job', {}))).toEqual([400, { error: 'entity_type and entity_id are required' }]);
    expect(answer(await copyBody(b, JOBS, 'att_job', ABSENT_DEST))).toEqual([404, { error: 'Not found' }]);
    // A VISIBLE ticket refusal (a capability, not an existence question) keeps
    // its 403 — it now simply comes before the body is looked at.
    expect(answer(await moveBody(b, LEADS, 'att_j1', {}))).toEqual([403, { error: 'No write access on source entity' }]);
    expect(where('att_job')).toEqual({ entity_type: 'job', entity_id: 'j1' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FINDING A. GET /api/attachments/recent in flat mode ran no ticket rule and
// admitted any row whose UPLOADER had no organization — which, through the LEFT
// JOIN, is every row with no uploader at all. The guest work-order door writes
// uploaded_by NULL, so every tenant's Recent Files listed every tenant's crew
// photos, with their storage URLs.
//
// AND THE SIBLING IT LEFT OPEN (1.30). Finding A's exclusion named ONE bound
// type, so it covered the ticket's own site photos and not the BUILDINGS' —
// entity_type 'task', where the crew's before / completion photos actually
// live. A caller refused a building's completion photo at every door above
// still read it here, with its unsigned thumb_url / web_url / original_url.
// The widget now asks the tasks table instead of a type name: a task carrying
// a service_ticket_id IS a work order's building, so its photos are listed to
// nobody, exactly as the ticket's are. A task on no ticket is untouched.
const recentIds = async (b, uid) => {
  const r = await call(b, uid, 'GET', '/api/attachments/recent?limit=24');
  expect(r.status).toBe(200);
  return { ids: r.body.attachments.map((a) => a.id).sort(), text: r.text };
};
const TICKET_PHOTO_IDS = Object.values(PHOTO).filter((id) => id !== 'att_nope');
// The building photos that ARE a work order's proof. BPHOTO.plain is left out
// deliberately: tk_plain hangs on no ticket, so its photo is an ordinary task
// upload that must go on being listed — the control that says this predicate
// excludes BUILDINGS, not tasks.
const BUILDING_PHOTO_IDS = [BPHOTO.j1, BPHOTO.j2, BPHOTO.j3, BPHOTO.l1, BPHOTO.asg, BPHOTO.foreign];
function seedRecentExtras() {
  // Beside the work-order photos seed() already writes (all uploaded_by NULL):
  mockEng.db.exec(`
    INSERT INTO attachments (id, entity_type, entity_id, filename, mime_type, size_bytes,
                             original_key, tags, organization_id, uploaded_by, position) VALUES
      -- a task-share guest upload: no uploader, stamped with its task's org.
      -- t1 / t9 are task ids with NO tasks row behind them, so the building
      -- subquery finds nothing and these answer exactly what they answered.
      ('att_guest_task',   'task', 't1', 'GUEST-TASK-A.jpg', 'image/jpeg', 10, 'k/gt_a.jpg', '[]', 1,    NULL, 0),
      ('att_guest_task_b', 'task', 't9', 'GUEST-TASK-B.jpg', 'image/jpeg', 10, 'k/gt_b.jpg', '[]', 2,    NULL, 0),
      -- no uploader AND no stamp: nothing names a tenant, so no tenant lists it
      ('att_nobody',       'job',  'j1', 'NOBODY.jpg',       'image/jpeg', 10, 'k/nb.jpg',   '[]', NULL, NULL, 0),
      -- an ordinary upload whose row stamp is missing: the UPLOADER arm, unchanged
      ('att_legacy',       'job',  'j1', 'LEGACY.jpg',       'image/jpeg', 10, 'k/lg.jpg',   '[]', NULL, 10,   0),
      -- a BUILDING photo an in-org USER uploaded: the uploader arm admits it,
      -- so ONLY the tasks subquery keeps it off. att_st_by_user's mirror.
      ('att_tk_by_user',   'task', 'tk_j3', 'BLDG-BY-USER.jpg', 'image/jpeg', 10, 'k/tbu.jpg', '[]', 1, 10, 0);
  `);
}

// Org 2's BUILDING photo, uploaded by a user carrying no organization stamp.
// The tolerance arm admits that row to every tenant, and the CALLER's own org
// can never see tk_b as a building — only the attachment row's own stamp can.
function seedForeignBuildingRow() {
  mockEng.db.exec(`
    INSERT INTO users (id, name, email, role, organization_id) VALUES
      (61, 'Ulf Unstamped', 'u61@nowhere.test', 'sta_wide', NULL);
    INSERT INTO attachments (id, entity_type, entity_id, filename, mime_type, size_bytes,
                             original_key, tags, organization_id, uploaded_by, position) VALUES
      ('att_tk_b_tolerated', 'task', 'tk_b', 'BLDG-RIVAL-TOLERATED.jpg', 'image/jpeg', 10, 'k/tbt.jpg', '[]', 2, 61, 0);
  `);
}

describe('GET /api/attachments/recent (flat mode) never lists a work-order photo', () => {
  test('THE FINDING: a guest-uploaded ticket photo is not listed to ANOTHER TENANT', async () => {
    seedRecentExtras();
    const b = await shipped();
    const rival = await recentIds(b, RIVAL);
    for (const id of TICKET_PHOTO_IDS) expect(rival.ids).not.toContain(id);
    expect(rival.text).not.toMatch(/CREW-J1|CREW-J2|CREW-J3|CREW-L1|UNOWNED|ORPHAN|GUEST-TASK-A|NOBODY/);
    // ...nor org 1's BUILDING photos, whose rows name org 1 and no uploader.
    expect(rival.text).not.toMatch(/BLDG-J1|BLDG-J2|BLDG-J3|BLDG-L1|BLDG-ASG|BLDG-PLAIN/);
    // Its own tenant's guest upload, and nothing else: org 2's OWN building
    // photo is off the widget for org 2, exactly as org 1's are for org 1.
    expect(rival.ids).toEqual(['att_guest_task_b']);
    expect(rival.text).not.toContain('BLDG-RIVAL.jpg');
  });

  test('...nor to an in-org user who FAILS the ticket rule — nor to one who passes it', async () => {
    seedRecentExtras();
    const b = await shipped();
    // LEADVIEW cannot open job j1's ticket; CREW is not on j3.
    const leadview = await recentIds(b, LEADVIEW);
    expect(leadview.ids).not.toContain('att_j1');
    expect(leadview.text).not.toContain('CREW-J1');
    const crew = await recentIds(b, CREW);
    expect(crew.ids).not.toContain('att_j3');
    // A flat list cannot ask the rule row by row, so it lists NO work-order
    // photo to anyone; the roster and the ticket detail are where they live.
    const wide = await recentIds(b, WIDE);
    for (const id of TICKET_PHOTO_IDS) expect(wide.ids).not.toContain(id);
    // The BUILDINGS' before / completion photos are the same proof under
    // another entity type, and they go on the same terms.
    for (const id of BUILDING_PHOTO_IDS) {
      expect(wide.ids).not.toContain(id);
      expect(leadview.ids).not.toContain(id);
      expect(crew.ids).not.toContain(id);
    }
    expect(leadview.text).not.toMatch(/BLDG-J1|BLDG-J2|BLDG-J3|BLDG-L1|BLDG-ASG|BLDG-BY-USER/);
  });

  test('ordinary in-org uploads still appear, exactly as before', async () => {
    seedRecentExtras();
    const b = await shipped();
    // No filter any more — this is the WHOLE list. A task on no ticket
    // (att_tk_plain) and a task with no tasks row at all (att_guest_task) are
    // both still in it; every work-order building's photo is not.
    const expected = ['att_guest_task', 'att_job', 'att_lead', 'att_legacy', 'att_tk_plain'];
    expect((await recentIds(b, WIDE)).ids).toEqual(expected);
    expect((await recentIds(b, LEADVIEW)).ids).toEqual(expected);
    expect((await recentIds(b, NOBODY)).ids).toEqual(expected);
    // And never another tenant's, uploader-stamped or not.
    expect((await recentIds(b, WIDE)).ids).not.toContain('att_guest_task_b');
  });

  // THE SIBLING GAP, CLOSED (1.30). Finding A's exclusion was a bound parameter
  // naming ONE type — TICKET_ENTITY_TYPE — so a work order's BUILDING photos
  // (entity_type 'task') were still listed here, with their unsigned storage
  // URLs, to any in-org caller the ticket rule refuses at the doors above. A
  // type name cannot say which task is a building, so the widget asks the
  // tasks table: a task carrying a service_ticket_id is one.
  test('THE GAP: a BUILDING photo is not listed to the caller its own door refuses', async () => {
    const b = await shipped();
    const leadview = await recentIds(b, LEADVIEW);
    expect(leadview.ids).not.toContain('att_tk_j1');
    expect(leadview.text).not.toContain('BLDG-J1.jpg');
    // The door for that very photo refuses the same caller — and the widget
    // now agrees with it instead of handing the file over behind its back.
    expect((await BUILDING_READ_DOORS.list.go(b, LEADVIEW, 'j1')).status).toBe(403);
    // ...and the ticket's own photos are excluded, as finding A left them.
    for (const id of TICKET_PHOTO_IDS) expect(leadview.ids).not.toContain(id);
  });

  test('...nor to a caller who PASSES the ticket rule, exactly as a ticket photo is not', async () => {
    const b = await shipped();
    // JOBS really can read j1's buildings at their own door.
    expect(BUILDING_READ_DOORS.list.ok(await BUILDING_READ_DOORS.list.go(b, JOBS, 'j1'))).toBe(true);
    // The flat list still cannot ask the rule row by row, so it lists the
    // proof to nobody; the roster and the ticket's detail are where it lives.
    const jobs = await recentIds(b, JOBS);
    for (const id of BUILDING_PHOTO_IDS) expect(jobs.ids).not.toContain(id);
    expect(jobs.text).not.toMatch(/BLDG-J1|BLDG-J2|BLDG-J3|BLDG-L1|BLDG-ASG/);
  });

  test('a building photo an in-org USER uploaded goes too — the uploader arm would have admitted it', async () => {
    seedRecentExtras();
    const b = await shipped();
    // Nothing but the tasks subquery is keeping this row off: its uploader is
    // user 10, stamped org 1, which is the caller's own organization.
    for (const uid of [WIDE, LEADVIEW, CREW, NOBODY]) {
      const r = await recentIds(b, uid);
      expect(r.ids).not.toContain('att_tk_by_user');
      expect(r.text).not.toContain('BLDG-BY-USER.jpg');
    }
  });

  test('a task on NO ticket is not a building: its photo is listed exactly as before', async () => {
    const b = await shipped();
    const wide = await recentIds(b, WIDE);
    expect(wide.ids).toContain('att_tk_plain');
    expect(wide.text).toContain('BLDG-PLAIN.jpg');
    // ...to every in-org caller, since the widget runs no per-entity rule on it.
    expect((await recentIds(b, NOBODY)).ids).toContain('att_tk_plain');
  });

  test("a FOREIGN tenant's building photo riding the uploader tolerance is excluded by the row's own stamp", async () => {
    seedForeignBuildingRow();
    const b = await shipped();
    // Its uploader has no organization, so the tolerance arm admits the row to
    // every tenant; the task it hangs on belongs to org 2.
    for (const uid of [WIDE, LEADVIEW, NOBODY]) {
      const r = await recentIds(b, uid);
      expect(r.ids).not.toContain('att_tk_b_tolerated');
      expect(r.text).not.toContain('BLDG-RIVAL-TOLERATED.jpg');
    }
    // Nor to its own tenant, which sees tk_b as the building it is.
    expect((await recentIds(b, RIVAL)).ids).not.toContain('att_tk_b_tolerated');
  });

  test('roster mode is a different door and is untouched by this', async () => {
    const b = await shipped();
    const r = await call(b, WIDE, 'GET', '/api/attachments/recent?roster=job');
    expect(r.status).toBe(200);
    expect(r.body.attachments).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The Scribe's door. Same rule, same classification, same refusal text for a
// hidden ticket as for an absent photo.
async function photoUpdate(mod, uid, attId, cap) {
  const client = await mockEng.pool.connect();
  const target = { entity_type: 'attachment', ops: { photo_updates: [{ attachment_id: attId, caption: cap || 'SCRIBED' }] } };
  try {
    const res = await mod.internals.dispatchAttachment(client, target, {}, { userId: uid, organizationId: USERS[uid].org, afterCommit: [] });
    return { stage: 'applied', res };
  } catch (e) {
    return {
      stage: 'refused', message: e.message,
      code: e.detail && e.detail.code, received: e.detail && e.detail.received,
      // Recorded as it came back — `undefined` stays undefined, so an absent
      // flag cannot pass an assertion for false.
      retryable: e.detail ? e.detail.retryable : 'NO DETAIL',
    };
  }
}
// The absent-id refusal names the id it was given; everything else must match.
const sansId = (r, id) => ({ stage: r.stage, code: r.code, message: String(r.message).split(id).join('<id>') });

describe('attachment.photo_updates (payload dispatcher) on a work-order photo', () => {
  test('a LEADS_EDIT approver is refused a JOB ticket\'s photo, naming the JOB capabilities', async () => {
    const r = await photoUpdate(dispatcher, LEADS, 'att_j1');
    expect(r.stage).toBe('refused');
    expect(r.code).toBe('missing_capability');
    expect(r.message).toContain('requires JOBS_EDIT_ANY or JOBS_EDIT_OWN');
    expect(caption('att_j1')).toBeNull();
  });

  test('the capability refusal is NOT retryable; the hidden refusal carries the absent id\'s retryable:true', async () => {
    // A retry cannot grant a capability, so the Scribe must not be told to
    // re-address and try again — while the hidden refusal must carry EXACTLY
    // what an absent id carries, or the flag itself is the oracle.
    const refused = await photoUpdate(dispatcher, LEADS, 'att_j1');
    expect([refused.code, refused.retryable]).toEqual(['missing_capability', false]);
    const lead = await photoUpdate(dispatcher, JOBS, 'att_l1');
    expect([lead.code, lead.retryable]).toEqual(['missing_capability', false]);
    const hidden = await photoUpdate(dispatcher, CREW, 'att_j1');
    const absent = await photoUpdate(dispatcher, CREW, 'att_nope');
    expect([hidden.code, hidden.retryable]).toEqual(['unresolvable_id', true]);
    expect(hidden.retryable).toBe(absent.retryable);
    expect((await photoUpdate(dispatcher, WIDE, 'att_b')).retryable).toBe(absent.retryable);
  });

  test('a JOBS_EDIT_ANY approver with no lead capability captions it', async () => {
    const r = await photoUpdate(dispatcher, JOBS, 'att_j1');
    expect(r.stage).toBe('applied');
    expect(caption('att_j1')).toBe('SCRIBED');
  });

  test('a VIEW grant is refused exactly as an absent photo is; an EDIT grant writes', async () => {
    const hidden = await photoUpdate(dispatcher, CREW, 'att_j1');
    const absent = await photoUpdate(dispatcher, CREW, 'att_nope');
    expect(hidden.code).toBe('unresolvable_id');
    expect(sansId(hidden, 'att_j1')).toEqual(sansId(absent, 'att_nope'));
    expect(caption('att_j1')).toBeNull();
    expect((await photoUpdate(dispatcher, CREW, 'att_j2')).stage).toBe('applied');
    expect(caption('att_j2')).toBe('SCRIBED');
  });

  test('a lead ticket follows LEADS_EDIT', async () => {
    const r = await photoUpdate(dispatcher, JOBS, 'att_l1');
    expect(r.code).toBe('missing_capability');
    expect(r.message).toContain('requires LEADS_EDIT)');
    expect((await photoUpdate(dispatcher, LEADS, 'att_l1')).stage).toBe('applied');
  });

  test('another org\'s and a tenant-less ticket\'s photo read exactly like an absent one', async () => {
    const absent = sansId(await photoUpdate(dispatcher, WIDE, 'att_nope'), 'att_nope');
    expect(sansId(await photoUpdate(dispatcher, WIDE, 'att_b'), 'att_b')).toEqual(absent);
    expect(sansId(await photoUpdate(dispatcher, WIDE, 'att_unowned'), 'att_unowned')).toEqual(absent);
    expect(caption('att_unowned')).toBeNull();
  });

  test('CONTROL: a lead photo keeps its message and its answer, byte for byte', async () => {
    const r = await photoUpdate(dispatcher, JOBS, 'att_lead');
    expect([r.code, r.received, r.message]).toEqual(['missing_capability', 'LEADS_EDIT',
      'attachment.ops.photo_updates[0]: you do not have permission to edit photos on a lead (requires LEADS_EDIT). Nothing was saved.']);
    expect((await photoUpdate(dispatcher, LEADS, 'att_lead')).stage).toBe('applied');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MUTANTS — each new check removed, the defect shown to return.
// ═══════════════════════════════════════════════════════════════════════════
function mutantFile(file, pairs, redirects) {
  const SOURCE = fs.readFileSync(file, 'utf8');
  const eol = SOURCE.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
  let out = SOURCE;
  for (const [find, replace] of pairs) {
    const f = String(find).replace(/\r?\n/g, eol);
    const r = String(replace).replace(/\r?\n/g, eol);
    const hits = out.split(f).length - 1;
    if (hits === 0) {
      throw new Error('MUTATION ANCHOR NOT FOUND — the guard moved or the line endings differ. Anchor:\n'
        + JSON.stringify(f.slice(0, 200)));
    }
    if (hits > 1) throw new Error('MUTATION ANCHOR MATCHED ' + hits + ' TIMES: ' + JSON.stringify(f.slice(0, 120)));
    const next = out.split(f).join(r);
    if (next === out) throw new Error('MUTATION CHANGED NO BYTES: ' + JSON.stringify(f.slice(0, 120)));
    out = next;
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
      return m;   // an optional dependency this box lacks; the original try/catch handles it
    }
    if (redirect[resolved]) resolved = redirect[resolved];
    return 'require(' + JSON.stringify(resolved.split(path.sep).join('/')) + ')';
  });
  const p = path.join(os.tmpdir(), '_p86_sta_mutant_' + process.pid + '_' + Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, out, 'utf8');
  mutantPaths.push(p);
  return p;
}

// A mutant attachment router (optionally built over a mutant access module),
// plus a file-folders router that requires THAT router, served together.
async function serveMutant(opts) {
  const o = opts || {};
  const redirects = {};
  if (o.accessPairs) redirects[require.resolve(ACCESS_FILE)] = mutantFile(ACCESS_FILE, o.accessPairs);
  const routesPath = (o.routePairs || o.accessPairs)
    // No route pairs with access pairs: an unmodified router copy, rewired to
    // the mutant access module.
    ? mutantFile(ROUTES_FILE, o.routePairs || [], redirects)
    : ROUTES_FILE;
  const ffRedirects = Object.assign({}, redirects);
  if (routesPath !== ROUTES_FILE) ffRedirects[require.resolve(ROUTES_FILE)] = routesPath;
  const ffPath = (o.folderPairs || routesPath !== ROUTES_FILE)
    ? mutantFile(FOLDERS_FILE, o.folderPairs || [], ffRedirects)
    : FOLDERS_FILE;
  return serve(require(routesPath), require(ffPath));
}

const MIDDLEWARE_CHECK = "      if (!(await ticketParentOk(req, res, req.params.entityType, req.params.entityId, mode))) return;";

describe('MUTANT: each attachment door\'s ticket check, removed', () => {
  test('harness: a mutant built with NO change to the checks still refuses — it runs the same engine', async () => {
    const b = await serveMutant({ routePairs: [['function ticketParentOk(', 'function ticketParentOk /* copy */(']] });
    expect(answer(await READ_DOORS.list.go(b, LEADVIEW, 'j1'))).toEqual([403, { error: 'Forbidden' }]);
    expect(READ_DOORS.list.ok(await READ_DOORS.list.go(b, JOBVIEW, 'j1'))).toBe(true);
  });

  test('requireDynamicCapability (list, upload, all five file-folders doors)', async () => {
    const b = await serveMutant({ routePairs: [[MIDDLEWARE_CHECK, '      /* MUTANT */']] });
    // The finding, back: a leads-only user lists a job ticket's photos...
    const listed = await READ_DOORS.list.go(b, LEADVIEW, 'j1');
    expect(listed.status).toBe(200);
    expect(listed.text).toContain('CREW-J1.jpg');
    // ...a leads-edit user reorganises its folders...
    expect(WRITE_DOORS.foldersCreate.ok(await WRITE_DOORS.foldersCreate.go(b, LEADS, 'j1'))).toBe(true);
    // ...and a crew lead with only a VIEW grant uploads onto it.
    expect(WRITE_DOORS.upload.ok(await WRITE_DOORS.upload.go(b, CREW, 'j1'))).toBe(true);
  });

  test('GET /raw/:id — the bytes', async () => {
    const b = await serveMutant({ routePairs: [[
      "    if (!(await ticketParentOk(req, res, att.entity_type, att.entity_id, 'read'))) return;", '    /* MUTANT */']] });
    const r = await READ_DOORS.raw.go(b, LEADVIEW, 'j1');
    expect([r.status, r.text]).toEqual([200, 'BYTES:k/j1_web.jpg']);
  });

  test('GET /tags/suggest', async () => {
    const b = await serveMutant({ routePairs: [[
      "    if (!(await ticketParentOk(req, res, entityType, entityId, 'read'))) return;", '    /* MUTANT */']] });
    const r = await READ_DOORS.tagSuggest.go(b, LEADVIEW, 'j1');
    expect(r.status).not.toBe(403);
    expect(r.reachedTagQuery).toBe(true);
  });

  test('POST /bulk-tag', async () => {
    const b = await serveMutant({ routePairs: [[
      "    if (!(await ticketParentOk(req, res, firstType, firstId, 'write',\n      { error: 'One or more attachments not found' }))) return;", '    /* MUTANT */']] });
    expect(WRITE_DOORS.bulkTag.ok(await WRITE_DOORS.bulkTag.go(b, LEADS, 'j1'))).toBe(true);
    expect(mockEng.all("SELECT tags FROM attachments WHERE id = 'att_j1'")[0].tags).toEqual(['roof', 'checked']);
  });

  test('DELETE /:id — the blob goes first', async () => {
    const b = await serveMutant({ routePairs: [[
      "    // Before storage.delete() destroys a crew photo's blob: the ticket's parent.\n    if (!(await ticketParentOk(req, res, att.entity_type, att.entity_id, 'write',\n      { error: 'Attachment not found' }))) return;",
      '    /* MUTANT */']] });
    expect(WRITE_DOORS.delete.ok(await WRITE_DOORS.delete.go(b, LEADS, 'j1'))).toBe(true);
    expect(exists('att_j1')).toBe(false);
    expect(mockStorageCalls).toContainEqual(['delete', 'k/j1_orig.jpg']);
  });

  test('PUT /:id — caption', async () => {
    const b = await serveMutant({ routePairs: [[
      "    // proofread mode below inherits this too, by living inside this route.\n    if (!(await ticketParentOk(req, res, att.entity_type, att.entity_id, 'write',\n      { error: 'Attachment not found' }))) return;",
      '    /* MUTANT */']] });
    expect(WRITE_DOORS.caption.ok(await WRITE_DOORS.caption.go(b, LEADS, 'j1'))).toBe(true);
    expect(caption('att_j1')).toBe('WRITTEN');
  });

  test('POST /:id/move — source', async () => {
    const b = await serveMutant({ routePairs: [[
      "    if (!(await ticketParentOk(req, res, att.entity_type, att.entity_id, 'write',\n      { error: 'Attachment not found' }, { error: 'No write access on source entity' }))) return;",
      '    /* MUTANT */']] });
    const r = await call(b, LEADS, 'POST', '/api/attachments/att_j1/move', { json: { entity_type: 'lead', entity_id: 'l1' } });
    expect(r.status).toBe(200);
    expect(mockEng.all("SELECT entity_type FROM attachments WHERE id = 'att_j1'")[0].entity_type).toBe('lead');
  });

  test('POST /:id/copy — source', async () => {
    const b = await serveMutant({ routePairs: [[
      "    if (!(await ticketParentOk(req, res, src.entity_type, src.entity_id, 'read',\n      { error: 'Attachment not found' }, { error: 'No read access on source attachment' }))) return;",
      '    /* MUTANT */']] });
    const r = await call(b, LEADS, 'POST', '/api/attachments/att_j1/copy', { json: { entity_type: 'lead', entity_id: 'l1' } });
    expect(r.status).toBe(200);
    expect(mockStorageCalls).toContainEqual(['get', 'k/j1_orig.jpg']);
  });

  test('ticketParentOk\'s hidden -> 404 arm: a crew lead learns an unassigned work order exists', async () => {
    const b = await serveMutant({ routePairs: [[
      "  if (verdict.hidden) res.status(404).json(notFoundBody || { error: 'Not found' });",
      "  if (false) res.status(404).json(notFoundBody || { error: 'Not found' });"]] });
    expect((await READ_DOORS.list.go(b, CREW, 'j3')).status).toBe(403);
    expect((await READ_DOORS.list.go(b, CREW, 'absent')).status).toBe(404);
  });
});

describe('MUTANT: the BUILDING half of the rule (1.30)', () => {
  test('the task arm removed — the shipped short-circuit back: leads-only reads, and a leads editor takes the proof', async () => {
    const b = await serveMutant({ routePairs: [[
      '  if (entityType !== WORK_ORDER_TASK_ENTITY_TYPE) return null;', '  return null;']] });
    // Reads every building photo on a job they cannot open...
    const listed = await BUILDING_READ_DOORS.list.go(b, LEADVIEW, 'j1');
    expect(listed.status).toBe(200);
    expect(listed.text).toContain('BLDG-J1.jpg');
    expect((await BUILDING_READ_DOORS.raw.go(b, LEADVIEW, 'j1')).text).toBe('BYTES:k/tj1_web.jpg');
    // ...moves a completion photo onto a lead of their own...
    const moved = await call(b, LEADS, 'POST', '/api/attachments/att_tk_j3/move', { json: { entity_type: 'lead', entity_id: 'l1' } });
    expect(moved.status).toBe(200);
    expect(where('att_tk_j3')).toEqual({ entity_type: 'lead', entity_id: 'l1' });
    // ...and deletes another outright, blob and all.
    expect(BUILDING_WRITE_DOORS.delete.ok(await BUILDING_WRITE_DOORS.delete.go(b, LEADS, 'j1'))).toBe(true);
    expect(exists('att_tk_j1')).toBe(false);
    expect(mockStorageCalls).toContainEqual(['delete', 'k/tj1_orig.jpg']);
  });

  test('the ticket half is unharmed by the task arm — the mutant still refuses a ticket photo', async () => {
    const b = await serveMutant({ routePairs: [[
      '  if (entityType !== WORK_ORDER_TASK_ENTITY_TYPE) return null;', '  return null;']] });
    expect(answer(await READ_DOORS.list.go(b, LEADVIEW, 'j1'))).toEqual([403, { error: 'Forbidden' }]);
  });

  test('the assignee exception removed: the building\'s own assignee can no longer finish it', async () => {
    const b = await serveMutant({ routePairs: [[
      "  if (mode === 'write' && wo.taskId != null && await isBuildingAssignee(req, wo.taskId)) return true;",
      '  /* MUTANT */']] });
    const r = await BUILDING_WRITE_DOORS.upload.go(b, CREW, 'asg');
    expect(r.status).toBe(404);
    expect(BUILDING_WRITE_DOORS.upload.ok(r)).toBe(false);
    expect((await BUILDING_WRITE_DOORS.caption.go(b, CREW, 'asg')).status).toBe(404);
  });

  test('the exception widened to anyone: a leads editor writes a building they were never assigned', async () => {
    const b = await serveMutant({ routePairs: [[
      '  return Number(row.assignee_user_id) === uid;', '  return true;']] });
    expect(BUILDING_WRITE_DOORS.caption.ok(await BUILDING_WRITE_DOORS.caption.go(b, LEADS, 'asg'))).toBe(true);
    expect(caption('att_tk_asg')).toBe('WRITTEN');
  });

  test('the exception widened to the READ half: the assignee reads a job they are not on', async () => {
    const b = await serveMutant({ routePairs: [[
      "  if (mode === 'write' && wo.taskId != null && await isBuildingAssignee(req, wo.taskId)) return true;",
      '  if (wo.taskId != null && await isBuildingAssignee(req, wo.taskId)) return true;']] });
    expect(BUILDING_READ_DOORS.list.ok(await BUILDING_READ_DOORS.list.go(b, CREW, 'asg'))).toBe(true);
    // The shipped file answers the same call like an absent id.
    const s = await shipped();
    expect((await BUILDING_READ_DOORS.list.go(s, CREW, 'asg')).status).toBe(404);
  });
});

describe('MUTANT: file-folders-routes.js — the MODE each gate names', () => {
  const CREATE_GATE = "router.post('/:entityType/:entityId',\n  requireAuth,\n  requireDynamicCapability(req => entityTypeOk(req.params.entityType) ? writeCapForEntity(req.params.entityType) : null, 'write'),";

  test('create folder asking the READ half lets a view-grant crew lead restructure a work order', async () => {
    const b = await serveMutant({ folderPairs: [[CREATE_GATE, CREATE_GATE.replace(", 'write'),", ", 'read'),")]] });
    expect(WRITE_DOORS.foldersCreate.ok(await WRITE_DOORS.foldersCreate.go(b, CREW, 'j1'))).toBe(true);
  });

  test('a gate with the mode DROPPED refuses everyone on a ticket — never a default', async () => {
    const b = await serveMutant({ folderPairs: [[
      "  requireDynamicCapability(req => entityTypeOk(req.params.entityType) ? readCapForEntity(req.params.entityType) : null, 'read'),",
      "  requireDynamicCapability(req => entityTypeOk(req.params.entityType) ? readCapForEntity(req.params.entityType) : null),"]] });
    expect(answer(await READ_DOORS.foldersList.go(b, WIDE, 'j1'))).toEqual([403, { error: 'Forbidden' }]);
    // ...and only on a ticket: a job's folders are untouched by the mode.
    expect((await call(b, WIDE, 'GET', '/api/file-folders/job/j1')).status).toBe(200);
  });
});

describe('MUTANT: attachment-entity-access.js', () => {
  test('the coarse READ arm removed: service_ticket falls back to LEADS_VIEW and a jobs-only user is refused again', async () => {
    const b = await serveMutant({ accessPairs: [[
      "  if (entityType === TICKET_ENTITY_TYPE) return ticketAccess.coarseCaps('read').join(' ');", '']] });
    expect(answer(await READ_DOORS.list.go(b, JOBVIEW, 'j1'))).toEqual([403, { error: 'Forbidden' }]);
  });

  test('the coarse WRITE arm removed: a jobs-only editor is refused their own job ticket\'s caption', async () => {
    const b = await serveMutant({ accessPairs: [[
      "  if (entityType === TICKET_ENTITY_TYPE) return ticketAccess.coarseCaps('write').join(' ');", '']] });
    expect(answer(await WRITE_DOORS.caption.go(b, JOBS, 'j1'))).toEqual([403, { error: 'Forbidden' }]);
  });

  test('the ticket loaded WITHOUT its organization: another tenant downloads the bytes', async () => {
    const b = await serveMutant({ accessPairs: [
      ["'SELECT id, job_id, lead_id FROM service_tickets WHERE id = $1 AND organization_id = $2',", "'SELECT id, job_id, lead_id FROM service_tickets WHERE id = $1',"],
      ['    [ticketId, o.orgId]\n  );', '    [ticketId]\n  );'],
    ] });
    const r = await READ_DOORS.raw.go(b, RIVAL, 'unowned');
    expect([r.status, r.text]).toEqual([200, 'BYTES:k/u_web.jpg']);
  });

  test('not_assigned no longer hidden: the narrow tier gets a 403 that confirms the ticket', async () => {
    const b = await serveMutant({ accessPairs: [[
      "  if (reason === 'not_assigned') return { ok: false, hidden: true, reason };", '']] });
    expect((await READ_DOORS.list.go(b, CREW, 'j3')).status).toBe(403);
  });

  test('a ticket that does not load no longer hidden: an orphan photo answers 403, not the absent 404', async () => {
    const b = await serveMutant({ accessPairs: [[
      "  if (!ticket) return { ok: false, hidden: true, reason: 'not_found' };", '']] });
    const orphan = await READ_DOORS.raw.go(b, WIDE, 'orphan');
    expect(orphan.status).toBe(403);
    expect(answer(orphan)).not.toEqual(answer(await READ_DOORS.raw.go(b, WIDE, 'absent')));
  });
});

describe('MUTANT: payload-dispatcher.js dispatchAttachment', () => {
  const loadDispatcher = (pairs) => require(mutantFile(DISPATCHER_FILE, pairs));

  test('the ticket verdict never computed: a leads approver captions a JOB ticket\'s photo', async () => {
    const mod = loadDispatcher([[
      "    let ticketVerdict = wo\n",
      "    let ticketVerdict = false\n"]]);
    expect((await photoUpdate(mod, LEADS, 'att_j1')).stage).toBe('applied');
    expect(caption('att_j1')).toBe('SCRIBED');
  });

  test('the hidden arm removed: a view-grant crew lead is told the photo exists', async () => {
    const mod = loadDispatcher([[
      "    if (ticketVerdict && !ticketVerdict.ok && ticketVerdict.hidden) {\n      throw await unresolvable();\n    }",
      '    /* MUTANT */',
    ]]);
    const r = await photoUpdate(mod, CREW, 'att_j1');
    expect(r.code).toBe('missing_capability');
    expect(sansId(r, 'att_j1')).not.toEqual(sansId(await photoUpdate(mod, CREW, 'att_nope'), 'att_nope'));
  });

  test('the visible refusal removed: the coarse LEADS_EDIT passes and the caption is written', async () => {
    const mod = loadDispatcher([[
      "    if (ticketVerdict && !ticketVerdict.ok) {",
      "    if (false) {"]]);
    expect((await photoUpdate(mod, LEADS, 'att_j1')).stage).toBe('applied');
    expect(caption('att_j1')).toBe('SCRIBED');
  });

  test('retryable flipped on the ticket capability refusal: the value the shipped assertion pins moves', async () => {
    const mod = loadDispatcher([[
      "{ code: 'missing_capability', field_path: where, received: parentCaps.join(' '), retryable: false }",
      "{ code: 'missing_capability', field_path: where, received: parentCaps.join(' '), retryable: true }"]]);
    const r = await photoUpdate(mod, LEADS, 'att_j1');
    expect([r.stage, r.code, r.retryable]).toEqual(['refused', 'missing_capability', true]);
    // Only that arm moved: the ordinary lead-photo refusal still says false.
    expect((await photoUpdate(mod, JOBS, 'att_lead')).retryable).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MUTANTS for finding K — the old order put back, the oracle shown to return.
// The body-and-destination block is removed from below the source proof and
// re-inserted directly after the row loads, which is precisely the shipped
// order before this fix. Anchored per door by the refusal line in front of it,
// because the block itself is byte-identical in move and copy.
const VALIDATE_BLOCK =
  "    const newType = String(req.body && req.body.entity_type || '').trim();\n" +
  "    const newId   = String(req.body && req.body.entity_id   || '').trim();\n" +
  "    if (!newType || !newId) return res.status(400).json({ error: 'entity_type and entity_id are required' });\n" +
  "    const VALID = ['lead', 'estimate', 'client', 'job', 'sub', 'user'];\n" +
  "    if (VALID.indexOf(newType) === -1) return res.status(400).json({ error: 'invalid entity_type' });\n" +
  "    if (!entityIdOk(newId)) return res.status(400).json({ error: 'Invalid entity_id' }); // P1-4\n" +
  "\n" +
  "    if (!(await attachmentEntityInOrg(pool, newType, newId, orgId))) {\n" +
  "      return notFound(res);\n" +
  "    }\n";
const EARLY_BLOCK = VALIDATE_BLOCK
  .replace('attachmentEntityInOrg(pool, newType, newId, orgId)', 'attachmentEntityInOrg(pool, newType, newId, callerOrgId(req))');

function reorderPairs(door) {
  if (door === 'move') {
    return [
      ["{ error: 'No write access on source entity' }))) return;\n\n" + VALIDATE_BLOCK,
        "{ error: 'No write access on source entity' }))) return;\n\n"],
      ["    if (!rows.length) return res.status(404).json({ error: 'Attachment not found' });\n    const att = rows[0];\n\n    // PREDICATE FIRST, both keys, before either capability is consulted.",
        "    if (!rows.length) return res.status(404).json({ error: 'Attachment not found' });\n    const att = rows[0];\n\n" + EARLY_BLOCK + "    // PREDICATE FIRST, both keys, before either capability is consulted."],
    ];
  }
  return [
    ["{ error: 'No read access on source attachment' }))) return;\n\n" + VALIDATE_BLOCK,
      "{ error: 'No read access on source attachment' }))) return;\n\n"],
    ["    const src = srcR.rows[0];\n\n", "    const src = srcR.rows[0];\n\n" + EARLY_BLOCK],
  ];
}

describe('MUTANT: move / copy validating the body BEFORE the source is proved (finding K)', () => {
  test('move, old order: a hidden ticket photo is tellable from an absent one by the destination and by the body', async () => {
    const b = await serveMutant({ routePairs: reorderPairs('move') });
    // The mutant is a working router: an allowed move still moves.
    expect((await moveBody(b, JOBS, 'att_j1', { entity_type: 'job', entity_id: 'j1' })).status).toBe(200);
    const absent = answer(await moveBody(b, CREW, 'att_nope', ABSENT_DEST));
    const hidden = answer(await moveBody(b, CREW, 'att_j3', ABSENT_DEST));
    expect(absent).toEqual(NOT_THERE);
    expect(hidden).toEqual([404, { error: 'Not found' }]);
    expect(answer(await moveBody(b, CREW, 'att_j3', {}))).not.toEqual(answer(await moveBody(b, CREW, 'att_nope', {})));
    expect(answer(await moveBody(b, WIDE, 'att_b', {}))).toEqual([400, { error: 'entity_type and entity_id are required' }]);
  });

  test('copy, old order: the same oracle', async () => {
    const b = await serveMutant({ routePairs: reorderPairs('copy') });
    expect((await copyBody(b, JOBS, 'att_j1', { entity_type: 'job', entity_id: 'j1' })).status).toBe(200);
    expect(answer(await copyBody(b, CREW, 'att_j3', ABSENT_DEST))).toEqual([404, { error: 'Not found' }]);
    expect(answer(await copyBody(b, CREW, 'att_nope', ABSENT_DEST))).toEqual(NOT_THERE);
    expect(answer(await copyBody(b, WIDE, 'att_b', { entity_type: 'wormhole', entity_id: 'x' }))).toEqual([400, { error: 'invalid entity_type' }]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MUTANTS for finding A.
const BUILDING_EXCLUSION =
  "          AND NOT EXISTS (SELECT 1 FROM tasks t\n" +
  "                           WHERE a.entity_type = $4 AND t.id = a.entity_id\n" +
  "                             AND t.service_ticket_id IS NOT NULL\n" +
  "                             AND t.organization_id IN ($2, a.organization_id))\n";
const RECENT_WHERE =
  "        WHERE a.entity_type <> $3\n" +
  BUILDING_EXCLUSION +
  "          AND ((a.uploaded_by IS NOT NULL AND (u.organization_id = $2 OR u.organization_id IS NULL))\n" +
  "               OR (a.uploaded_by IS NULL AND a.organization_id = $2))";

// The flat predicate exactly as it shipped before finding A. $3 AND $4 are
// kept referenced: both are still bound, and an engine counts what it binds.
const ORIGINAL_WHERE = "        WHERE ($3 = $3) AND ($4 = $4) AND (u.organization_id = $2 OR u.organization_id IS NULL)";
const recentFull = async (base, uid) => {
  const r = await call(base, uid, 'GET', '/api/attachments/recent?limit=24');
  expect(r.status).toBe(200);
  return r.body.attachments;
};
function seedUploaderRows() {
  seedRecentExtras();
  mockEng.db.exec(`
    INSERT INTO users (id, name, email, role, organization_id) VALUES
      (60, 'Una Unstamped', 'u@nowhere.test', 'sta_wide', NULL);
    INSERT INTO attachments (id, entity_type, entity_id, filename, mime_type, size_bytes,
                             original_key, tags, organization_id, uploaded_by, position) VALUES
      -- an uploader with no org: the tolerance arm, for every tenant, as before
      ('att_unstamped_user', 'job', 'j1', 'UNSTAMPED-USER.jpg', 'image/jpeg', 10, 'k/uu.jpg', '[]', 1, 60, 0),
      -- a rival user's upload stamped with org 1: the UPLOADER's org decides, as before
      ('att_rival_upload',   'job', 'j9', 'RIVAL-UPLOAD.jpg',   'image/jpeg', 10, 'k/ru.jpg', '[]', 1, 50, 0),
      -- a work-order photo an in-org USER uploaded: the uploader arm admits it,
      -- so only the type exclusion keeps it off the widget
      ('att_st_by_user',     'service_ticket', 'st_j3', 'ST-BY-USER.jpg', 'image/jpeg', 10, 'k/su.jpg', '[]', 1, 10, 0);
  `);
}
// The two rows the exclusions are ABOUT, set aside so the comparison below is
// about everything else. Each is asserted by name in the test that uses this.
const EXCLUDED_BY_DESIGN = ['att_st_by_user', 'att_tk_by_user'];
// For each caller: the uploader-stamped rows `candidate` lists that are not
// work-order proof, compared field for field with what `original` lists.
// Sorted by id, because the fixture's rows share an uploaded_at and a tie's
// order is the engine's, not the predicate's. Returns the callers who differ.
async function uploaderRowsThatMoved(candidate, original) {
  const keep = (rows) => rows
    .filter((a) => a.uploaded_by != null && EXCLUDED_BY_DESIGN.indexOf(a.id) < 0)
    .sort((x, y) => (x.id < y.id ? -1 : 1));
  const moved = [];
  for (const uid of [WIDE, LEADVIEW, CREW, NOBODY, RIVAL]) {
    const before = keep(await recentFull(original, uid));
    const after = keep(await recentFull(candidate, uid));
    expect(before.length).toBeGreaterThan(0);
    if (JSON.stringify(after) !== JSON.stringify(before)) moved.push(uid);
  }
  return moved;
}

describe('MUTANT: GET /recent flat mode (finding A)', () => {
  test('the ORIGINAL predicate put back: another tenant lists a guest crew photo', async () => {
    seedRecentExtras();
    const b = await serveMutant({ routePairs: [[RECENT_WHERE, ORIGINAL_WHERE]] });
    const rival = await recentIds(b, RIVAL);
    expect(rival.ids).toContain('att_j1');
    expect(rival.text).toContain('CREW-J1.jpg');
  });

  test('ticket exclusion removed: an in-org user who fails the ticket rule lists its photo', async () => {
    seedRecentExtras();
    const b = await serveMutant({ routePairs: [["        WHERE a.entity_type <> $3\n", "        WHERE ($3 = $3)\n"]] });
    expect((await recentIds(b, LEADVIEW)).ids).toContain('att_j1');
    expect((await recentIds(b, CREW)).ids).toContain('att_j3');
    // ...and the building exclusion held on its own.
    expect((await recentIds(b, LEADVIEW)).ids).not.toContain('att_tk_j1');
  });

  // 1.30: the sibling gap, reopened.
  test('BUILDING exclusion removed: a caller the doors refuse lists the building photo again', async () => {
    seedRecentExtras();
    const b = await serveMutant({ routePairs: [[BUILDING_EXCLUSION, "          AND ($4 = $4)\n"]] });
    const leadview = await recentIds(b, LEADVIEW);
    expect(leadview.ids).toEqual(expect.arrayContaining(['att_tk_j1', 'att_tk_by_user']));
    expect(leadview.text).toContain('BLDG-J1.jpg');
    // ...while that photo's own door goes on refusing the same caller. That
    // disagreement IS the gap: the door says no and the widget hands it over.
    expect((await BUILDING_READ_DOORS.list.go(b, LEADVIEW, 'j1')).status).toBe(403);
    // The ticket exclusion held on its own, as it did before.
    for (const id of TICKET_PHOTO_IDS) expect(leadview.ids).not.toContain(id);
  });

  test('the building exclusion is not a blanket task ban: drop `service_ticket_id IS NOT NULL` and an ordinary to-do loses its photo', async () => {
    const b = await serveMutant({ routePairs: [[
      "                             AND t.service_ticket_id IS NOT NULL\n", '']] });
    expect((await recentIds(b, WIDE)).ids).not.toContain('att_tk_plain');
    // The shipped statement lists it — the mutant lost a row the fix keeps.
    expect((await recentIds(await shipped(), WIDE)).ids).toContain('att_tk_plain');
  });

  test("the row's own stamp dropped from the subquery's org predicate: a foreign building photo rides the tolerance arm in", async () => {
    seedForeignBuildingRow();
    const b = await serveMutant({ routePairs: [[
      "                             AND t.organization_id IN ($2, a.organization_id))\n",
      "                             AND t.organization_id IN ($2))\n"]] });
    const wide = await recentIds(b, WIDE);
    expect(wide.ids).toContain('att_tk_b_tolerated');
    expect(wide.text).toContain('BLDG-RIVAL-TOLERATED.jpg');
    // Its own tenant never saw it either way — the caller's own org arm.
    expect((await recentIds(b, RIVAL)).ids).not.toContain('att_tk_b_tolerated');
  });

  test('DIFFERENTIAL: every row WITH an uploader answers what the original predicate answered, for every caller', async () => {
    seedUploaderRows();
    const original = await serveMutant({ routePairs: [[RECENT_WHERE, ORIGINAL_WHERE]] });
    const b = await shipped();
    expect(await uploaderRowsThatMoved(b, original)).toEqual([]);
    for (const uid of [WIDE, LEADVIEW, CREW, NOBODY]) {
      // The two uploader rows the comparison sets aside really were listed by
      // the original to this org, and really are gone now: the ticket's own
      // photo (finding A) and a BUILDING's (1.30).
      for (const id of EXCLUDED_BY_DESIGN) {
        expect((await recentFull(original, uid)).map((a) => a.id)).toContain(id);
        expect((await recentFull(b, uid)).map((a) => a.id)).not.toContain(id);
      }
    }
    // The fixture exercises both uploader arms, or the equality proves little.
    expect((await recentFull(b, RIVAL)).map((a) => a.id)).toEqual(expect.arrayContaining(['att_unstamped_user', 'att_rival_upload']));
    expect((await recentFull(b, WIDE)).map((a) => a.id)).toContain('att_unstamped_user');
    expect((await recentFull(b, WIDE)).map((a) => a.id)).not.toContain('att_rival_upload');
  });

  test('the differential is not vacuous: drop the uploader arm\'s tolerance and it names every caller that lost a row', async () => {
    seedUploaderRows();
    const original = await serveMutant({ routePairs: [[RECENT_WHERE, ORIGINAL_WHERE]] });
    const b = await serveMutant({ routePairs: [[
      "          AND ((a.uploaded_by IS NOT NULL AND (u.organization_id = $2 OR u.organization_id IS NULL))\n",
      "          AND ((a.uploaded_by IS NOT NULL AND (u.organization_id = $2))\n"]] });
    // att_unstamped_user (an uploader with no org) was every tenant's; now it is nobody's.
    expect(await uploaderRowsThatMoved(b, original)).toEqual([WIDE, LEADVIEW, CREW, NOBODY, RIVAL]);
  });

  test('the no-uploader anchor removed: another tenant lists an uploader-less upload', async () => {
    seedRecentExtras();
    const b = await serveMutant({ routePairs: [[
      "               OR (a.uploaded_by IS NULL AND a.organization_id = $2))",
      "               OR (a.uploaded_by IS NULL))"]] });
    const rival = await recentIds(b, RIVAL);
    expect(rival.ids).toContain('att_guest_task');
    expect(rival.ids).toContain('att_nobody');
    // The ticket exclusion still held on its own.
    expect(rival.ids).not.toContain('att_j1');
  });

  test('the uploader arm no longer requires an uploader: a row with NO uploader rides the tolerance arm to every tenant', async () => {
    seedRecentExtras();
    const b = await serveMutant({ routePairs: [[
      "          AND ((a.uploaded_by IS NOT NULL AND (u.organization_id = $2 OR u.organization_id IS NULL))\n",
      "          AND (((u.organization_id = $2 OR u.organization_id IS NULL))\n"]] });
    const rival = await recentIds(b, RIVAL);
    // Org 1's guest task upload and the unstamped, uploader-less row: the LEFT
    // JOIN finds no user, u.organization_id is NULL, and the tolerance admits them.
    expect(rival.ids).toEqual(expect.arrayContaining(['att_guest_task', 'att_nobody']));
    expect(rival.text).toContain('GUEST-TASK-A.jpg');
    // The ticket exclusion still held on its own.
    expect(rival.ids).not.toContain('att_j1');
  });
});
