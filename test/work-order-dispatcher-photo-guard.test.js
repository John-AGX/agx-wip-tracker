// 86 CANNOT BYPASS THE PHOTO PROOF GUARD (Work Orders 1.29, A2 via the payload dispatcher).
//
// The attachment doors (PUT, bulk-tag, DELETE, move) answer to
// server/services/work-order-photo-guard.js. 86 had two more ways to take a
// work order's proof away, both in server/services/payload-dispatcher.js:
//   * attachment.photo_updates REPLACES tags, so ['before'] on a completion
//     photo turned it into a before photo;
//   * system.link_ops.attach_files re-points rows with
//     UPDATE attachments SET entity_type, entity_id — a move off the work order.
// Both now run through checkWorkOrderPhotos inside the payload transaction.
//
// HOW: the real dispatcher against node:sqlite through the pg shim, over tables
// derived from server/db.js, with the real role cache. Each drive runs the
// target inside BEGIN..COMMIT (ROLLBACK on a throw) and drains the afterCommit
// buffer only after COMMIT, which is what applyPayload does; a few drives go
// through applyPayload itself. Assertions are on the refusal, the rows
// afterwards and the ticket's timeline rows.
//
// Then each wire is removed from a copy of the shipped dispatcher (CRLF
// normalised, the anchor required exactly once) and the same drive is shown to
// lose the proof again.
'use strict';

jest.setTimeout(120000);

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const SERVER = path.join(__dirname, '..', 'server');
const SERVICES = path.join(SERVER, 'services');
const DISPATCHER_FILE = path.join(SERVICES, 'payload-dispatcher.js');

const TABLES = [
  'organizations', 'users', 'roles', 'jobs', 'job_access', 'leads', 'projects', 'tasks',
  'service_tickets', 'service_ticket_events', 'attachments', 'org_tags', 'project_activity',
  // 1.30: the Scribe's report door is the second place a BUILDING photo is
  // handed out, so the WHO-MAY half below drives it too.
  'job_reports',
];

let eng;
let dispatcher;
let auth;

const OWN = { userId: 10, organizationId: 1 };
const RIVAL = { userId: 50, organizationId: 2 };
// 1.30 — THE WHO-MAY HALF. Three more approvers in org 1, none of them wide:
//   CREW   JOBS_VIEW_ASSIGNED + JOBS_EDIT_OWN, owns no job and holds no grant
//          on j1 -> the ticket rule answers `not_assigned` (hidden).
//   LEADS  LEADS_VIEW + LEADS_EDIT -> `no_capability` on a JOB work order, and
//          ok on a LEAD one. Passes the coarse 'task' capability either way,
//          which is exactly what made the building half a hole.
//   BLDG   the same narrow tier as CREW, and the ASSIGNEE of two buildings.
const CREW = { userId: 20, organizationId: 1 };
const LEADS = { userId: 30, organizationId: 1 };
const BLDG = { userId: 40, organizationId: 1 };

const LOCKED_RETAG = (status) => 'This work order is ' + status +
  ", so its completion photos can't be changed to before photos. Reopen the work order first.";
const LOCKED_MOVE = (status) => 'This work order is ' + status +
  ", so its photos are part of the record and can't be moved off it. Reopen the work order first if a photo has to go.";
const LAST = (head, ending) => 'This is the only completion photo on ' + head + ', and ' + head +
  ' is marked done. Undo ' + head + ' first, then ' + ending + '.';

function seed() {
  const caps = (list) => "'" + JSON.stringify(list) + "'";
  const photo = (id, type, entity, tags, org, mime) =>
    `('${id}', '${type}', '${entity}', '${id}.jpg', '${mime || 'image/jpeg'}', 10, '${tags}', ${org == null ? 'NULL' : org}, 10, 0, '2026-09-08 08:00:00')`;
  const C = '[]';
  const B = '["before"]';
  eng.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM roles; DELETE FROM jobs;
    DELETE FROM job_access; DELETE FROM leads; DELETE FROM projects; DELETE FROM tasks;
    DELETE FROM service_tickets; DELETE FROM service_ticket_events; DELETE FROM attachments;
    DELETE FROM org_tags; DELETE FROM project_activity; DELETE FROM job_reports;

    INSERT INTO organizations (id, name) VALUES (1, 'AGX'), (2, 'Rival Co');
    INSERT INTO roles (name, capabilities) VALUES
      ('wodg_wide', ${caps(['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'LEADS_VIEW', 'LEADS_EDIT'])}),
      ('wodg_crew', ${caps(['JOBS_VIEW_ASSIGNED', 'JOBS_EDIT_OWN'])}),
      ('wodg_leads', ${caps(['LEADS_VIEW', 'LEADS_EDIT'])});
    INSERT INTO users (id, name, email, role, organization_id) VALUES
      (10, 'Wendy Wide', 'w@agx.test', 'wodg_wide', 1),
      (20, 'Carl Crew', 'c@agx.test', 'wodg_crew', 1),
      (30, 'Lena Leads', 'l@agx.test', 'wodg_leads', 1),
      (40, 'Andy Assignee', 'a@agx.test', 'wodg_crew', 1),
      (50, 'Rival Ray', 'r@rival.test', 'wodg_wide', 2);
    INSERT INTO jobs (id, owner_id, data, organization_id) VALUES ('j1', 10, '{}', 1), ('j9', 50, '{}', 2);
    INSERT INTO leads (id, title, organization_id, status) VALUES ('l1', 'Roof lead', 1, 'new');
    INSERT INTO projects (id, name, organization_id) VALUES ('p1', 'Maple St', 1), ('p9', 'Rival Site', 2);
    INSERT INTO projects (id, name) VALUES ('p_legacy', 'No org stamp');

    INSERT INTO service_tickets (id, organization_id, title, job_id, lead_id, status, checklist) VALUES
      ('st_prog',   1, 'Roof punch list', 'j1', NULL, 'in_progress', '[]'),
      ('st_appr',   1, 'Approved list',   'j1', NULL, 'approved',    '[]'),
      ('st_closed', 1, 'Closed list',     'j1', NULL, 'closed',      '[]'),
      ('st_cancel', 1, 'Cancelled list',  'j1', NULL, 'cancelled',   '[]'),
      ('st_lead',   1, 'Lead survey',     NULL, 'l1', 'in_progress', '[]'),
      ('st_b',      2, 'Rival list',      'j9', NULL, 'in_progress', '[]');

    INSERT INTO tasks (id, organization_id, title, status, scope, service_ticket_id, entity_type, entity_id, archived_at, assignee_user_id) VALUES
      ('t_784',    1, 'Bldg 784 — north side', 'done', 'org', 'st_prog',   'job', 'j1', NULL, 40),
      ('t_785',    1, 'Bldg 785',              'done', 'org', 'st_prog',   'job', 'j1', NULL, NULL),
      ('t_786',    1, 'Bldg 786',              'open', 'org', 'st_prog',   'job', 'j1', NULL, 40),
      ('t_787',    1, 'Bldg 787',              'done', 'org', 'st_prog',   'job', 'j1', NULL, NULL),
      ('t_900',    1, 'Bldg 900',              'done', 'org', 'st_appr',   'job', 'j1', NULL, NULL),
      ('t_950',    1, 'Bldg 950',              'done', 'org', 'st_closed', 'job', 'j1', NULL, NULL),
      ('t_700',    1, 'Bldg 700',              'done', 'org', 'st_cancel', 'job', 'j1', NULL, NULL),
      ('t_plain',  1, 'Plain task',            'done', 'org', NULL,        'job', 'j1', NULL, NULL),
      ('t_lead',   1, 'Lead bldg',             'open', 'org', 'st_lead',   'lead', 'l1', NULL, NULL),
      ('t_rival',  2, 'Rival bldg',            'done', 'org', 'st_b',      'job', 'j9', NULL, NULL);
    INSERT INTO tasks (id, title, status, scope, service_ticket_id, entity_type, entity_id, archived_at) VALUES
      ('t_legacy', 'Legacy bldg', 'done', 'org', 'st_prog', 'job', 'j1', NULL);

    INSERT INTO attachments (id, entity_type, entity_id, filename, mime_type, size_bytes, tags,
                             organization_id, uploaded_by, position, uploaded_at) VALUES
      ${photo('a_only', 'task', 't_784', C, 1)},
      ${photo('a_before784', 'task', 't_784', B, 1)},
      ${photo('a_c1', 'task', 't_785', C, 1)},
      ${photo('a_c2', 'task', 't_785', C, 1)},
      ${photo('a_open', 'task', 't_786', C, 1)},
      ${photo('a_ghost', 'task', 't_787', C, null)},
      ${photo('a_ghost_doc', 'task', 't_787', C, null, 'application/pdf')},
      ${photo('a_appr_before', 'task', 't_900', B, 1)},
      ${photo('a_appr_c1', 'task', 't_900', C, 1)},
      ${photo('a_appr_c2', 'task', 't_900', C, 1)},
      ${photo('a_appr_doc', 'task', 't_900', C, 1, 'application/pdf')},
      ${photo('a_closed_c1', 'task', 't_950', C, 1)},
      ${photo('a_closed_c2', 'task', 't_950', C, 1)},
      ${photo('a_cancel_only', 'task', 't_700', C, 1)},
      ${photo('a_plain', 'task', 't_plain', C, 1)},
      ${photo('a_ghost_plain', 'task', 't_plain', C, null)},
      ${photo('a_legacy', 'task', 't_legacy', C, null)},
      ${photo('a_site_prog', 'service_ticket', 'st_prog', '["roof"]', 1)},
      ${photo('a_ghost_site', 'service_ticket', 'st_prog', C, null)},
      ${photo('a_site_appr', 'service_ticket', 'st_appr', '["roof"]', 1)},
      ${photo('a_site_closed', 'service_ticket', 'st_closed', '["roof"]', 1)},
      ${photo('a_proj', 'project', 'p1', C, 1)},
      ${photo('a_lead_bldg', 'task', 't_lead', C, 1)},
      ${photo('a_rival', 'task', 't_rival', C, 2)};
  `);
}

beforeAll(async () => {
  eng = createPgSqlite(sqliteSchema(TABLES), {
    jsonColumns: ['checklist', 'capabilities', 'data', 'tags', 'detail', 'sections', 'cover_page'],
  });
  eng.db.function('hashtext', (s) => { let h = 0; const t = String(s); for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0; return h; });
  eng.db.function('pg_advisory_xact_lock', (_k) => 1);
  // The org tag catalog's upsert targets db.js's case-insensitive expression
  // index; db-schema.js emits columns only, so the index is added here (as
  // test/attachment-photo-updates.test.js does) to keep a project retag quiet.
  eng.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_org_tags_ci_name ON org_tags (organization_id, LOWER(name))');
  const db = require('../server/db');
  db.pool.query = eng.pool.query;
  db.pool.connect = eng.pool.connect;
  auth = require('../server/auth');
  auth.setRolePool(eng.pool);
  dispatcher = require('../server/services/payload-dispatcher');
  seed();
  await auth.refreshRoleCache();
});

beforeEach(() => seed());

const flush = () => new Promise((r) => setTimeout(r, 25));

let mutantPaths = [];
afterEach(async () => {
  await flush();
  for (const p of mutantPaths) {
    try { delete require.cache[require.resolve(p)]; } catch (e) { /* not loaded */ }
    try { fs.unlinkSync(p); } catch (e) { /* already gone */ }
  }
  mutantPaths = [];
});

afterAll(async () => {
  await flush();
  require('../server/db').pool.query = async () => ({ rows: [], rowCount: 0 });
  if (eng) eng.close();
});

// ── the drives ────────────────────────────────────────────────────────────
// BEGIN, dispatch, COMMIT, then drain afterCommit — or ROLLBACK and never drain.
async function inTxn(mod, target, dispatch, ctx) {
  try { mod.validateTarget(target, 0); }
  catch (e) { return { stage: 'emit', name: e.name, message: e.message, detail: e.detail || {} }; }
  const client = await eng.pool.connect();
  const afterCommit = [];
  await client.query('BEGIN');
  let res;
  try {
    res = await dispatch(client, target, {}, Object.assign({}, ctx, { afterCommit }));
  } catch (e) {
    await client.query('ROLLBACK');
    return { stage: 'refused', name: e.name, message: e.message, detail: e.detail || {} };
  }
  await client.query('COMMIT');
  const queued = afterCommit.length;
  for (const fn of afterCommit) await fn();
  return { stage: 'applied', res, queued };
}

function photoUpdates(updates, ctx, mod) {
  const m = mod || dispatcher;
  return inTxn(m, { entity_type: 'attachment', ops: { photo_updates: updates } },
    (c, t, r, x) => m.internals.dispatchAttachment(c, t, r, x), ctx || OWN);
}

function attachFiles(ids, destType, destId, ctx, mod) {
  const m = mod || dispatcher;
  return inTxn(m, { entity_type: 'system', ops: { link_ops: [{
    op: 'attach_files', attachment_ids: ids, target_entity_type: destType, target_entity_id: destId,
  }] } }, (c, t, r, x) => m.internals.dispatchSystem(c, t, r, x), ctx || OWN);
}

const rowOf = (id) => eng.all('SELECT entity_type, entity_id, tags, caption FROM attachments WHERE id = ?', id)[0];
const tagsOf = (id) => rowOf(id).tags;
const parentOf = (id) => { const r = rowOf(id); return r.entity_type + ':' + r.entity_id; };
const events = (ticketId) => eng.all(
  'SELECT ticket_id, organization_id, kind, actor_kind, actor_user_id, detail FROM service_ticket_events' +
  (ticketId ? ' WHERE ticket_id = ?' : '') + ' ORDER BY rowid', ...(ticketId ? [ticketId] : []));
const photoEvents = () => events().filter((e) => e.kind === 'photo_retagged' || e.kind === 'photo_removed');

// ── mutants ───────────────────────────────────────────────────────────────
const abs = (p) => p.split(path.sep).join('/');
function absolutizeRequires(src) {
  return src
    .replace(/require\('\.\/([^']+)'\)/g, (_m, p) => `require('${abs(SERVICES)}/${p}')`)
    .replace(/require\('\.\.\/([^']+)'\)/g, (_m, p) => `require('${abs(SERVER)}/${p}')`);
}
function mutantDispatcher(pairs) {
  let src = fs.readFileSync(DISPATCHER_FILE, 'utf8').replace(/\r\n/g, '\n');
  for (const [find, replace] of pairs) {
    const anchor = String(find).replace(/\r\n/g, '\n');
    if (src.split(anchor).length !== 2) throw new Error('anchor not found');
    src = src.replace(anchor, () => String(replace));
  }
  const p = path.join(os.tmpdir(), '_p86_wodg_mutant_' + process.pid + '_' +
    Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, absolutizeRequires(src), 'utf8');
  mutantPaths.push(p);
  return require(p);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * attachment.photo_updates — a retag that takes proof away is refused
 * ══════════════════════════════════════════════════════════════════════════*/
describe('photo_updates: a completion photo cannot become a before photo when it is proof', () => {
  test('an approved work order refuses, names the photo, and saves nothing', async () => {
    const r = await photoUpdates([{ attachment_id: 'a_appr_c1', tags: ['before'] }]);
    expect(r.stage).toBe('refused');
    expect(r.name).toBe('PayloadValidationError');
    expect(r.message).toBe('attachment.ops.photo_updates[0]: ' + LOCKED_RETAG('approved') + ' Nothing was saved.');
    expect(r.detail).toMatchObject({ code: 'photo_locked', retryable: false,
      field_path: 'attachment.ops.photo_updates[0].tags', received: 'a_appr_c1' });
    expect(tagsOf('a_appr_c1')).toEqual([]);
    expect(photoEvents()).toEqual([]);
  });

  test('a closed work order refuses with its own status in the sentence', async () => {
    const r = await photoUpdates([{ attachment_id: 'a_closed_c2', tags: ['Before'] }]);
    expect(r.stage).toBe('refused');
    expect(r.message).toContain(LOCKED_RETAG('closed'));
    expect(r.detail.code).toBe('photo_locked');
    expect(tagsOf('a_closed_c2')).toEqual([]);
  });

  test('the last completion photo on a done building refuses (in progress)', async () => {
    const r = await photoUpdates([{ attachment_id: 'a_only', tags: ['before', 'roof'] }]);
    expect(r.stage).toBe('refused');
    expect(r.message).toBe('attachment.ops.photo_updates[0]: ' +
      LAST('Bldg 784', 'change it to a before photo') + ' Nothing was saved.');
    expect(r.detail.code).toBe('last_completion_photo');
    expect(tagsOf('a_only')).toEqual([]);
    expect(photoEvents()).toEqual([]);
  });

  test('two photos that together leave a done building with none refuse, naming the right item', async () => {
    const r = await photoUpdates([
      { attachment_id: 'a_open', caption: 'first item writes nothing either' },
      { attachment_id: 'a_c1', tags: ['before'] },
      { attachment_id: 'a_c2', tags: ['before'] }]);
    expect(r.stage).toBe('refused');
    expect(r.detail.code).toBe('last_completion_photo');
    expect(r.message).toMatch(/^attachment\.ops\.photo_updates\[1\]: /);
    expect(r.message).toContain(LAST('Bldg 785', 'change it to a before photo'));
    // All or nothing: the caption on the first item is not written either.
    expect(rowOf('a_open').caption).toBeNull();
    expect([tagsOf('a_c1'), tagsOf('a_c2')]).toEqual([[], []]);
  });

  test('the ticket is locked and the verdict read BEFORE the tags are written', async () => {
    const start = eng.log.length;
    const r = await photoUpdates([{ attachment_id: 'a_c1', tags: ['before'] }]);
    expect(r.stage).toBe('applied');
    const log = eng.log.slice(start).map((q) => q.sql);
    const lock = log.findIndex((s) => /FROM service_tickets WHERE id = \$1 AND organization_id = \$2 FOR UPDATE/.test(s));
    const write = log.findIndex((s) => /^UPDATE attachments SET tags = /.test(s));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(write).toBeGreaterThan(lock);
  });
});

describe('photo_updates: every other retag still writes, and a proof change is on the timeline', () => {
  test('a done building with another completion photo: written, photo_retagged recorded after COMMIT', async () => {
    const r = await photoUpdates([{ attachment_id: 'a_c1', tags: ['before'] }]);
    expect(r.stage).toBe('applied');
    expect(r.res.tags_written).toBe(1);
    expect(tagsOf('a_c1')).toEqual(['before']);
    expect(r.queued).toBe(1);
    expect(events('st_prog')).toEqual([{
      ticket_id: 'st_prog', organization_id: 1, kind: 'photo_retagged', actor_kind: 'agent', actor_user_id: 10,
      detail: { attachment_id: 'a_c1', task_id: 't_785', title: 'Bldg 785', from: 'completion', to: 'before' },
    }]);
  });

  test('the timeline row is not written inside the transaction — only the drain writes it', async () => {
    const client = await eng.pool.connect();
    const afterCommit = [];
    await client.query('BEGIN');
    await dispatcher.internals.dispatchAttachment(client,
      { entity_type: 'attachment', ops: { photo_updates: [{ attachment_id: 'a_open', tags: ['before'] }] } },
      {}, Object.assign({ afterCommit }, OWN));
    await client.query('COMMIT');
    expect(afterCommit).toHaveLength(1);
    expect(photoEvents()).toEqual([]);
    for (const fn of afterCommit) await fn();
    expect(photoEvents().map((e) => [e.kind, e.detail.attachment_id, e.detail.from, e.detail.to]))
      .toEqual([['photo_retagged', 'a_open', 'completion', 'before']]);
  });

  test('an approved work order still takes a before photo becoming a completion photo, and captions', async () => {
    const r = await photoUpdates([
      { attachment_id: 'a_appr_before', tags: ['roof'] },
      { attachment_id: 'a_appr_c1', caption: 'North face, after' },
      { attachment_id: 'a_appr_c2', tags: ['roof', 'gutter'] },
      { attachment_id: 'a_appr_doc', tags: ['before'] }]);
    expect(r.stage).toBe('applied');
    expect(tagsOf('a_appr_before')).toEqual(['roof']);
    expect(rowOf('a_appr_c1').caption).toBe('North face, after');
    expect(tagsOf('a_appr_c2')).toEqual(['roof', 'gutter']);
    expect(tagsOf('a_appr_doc')).toEqual(['before']);
    // Only the photo whose kind changed is on the timeline.
    expect(photoEvents().map((e) => [e.ticket_id, e.detail.attachment_id, e.detail.from, e.detail.to]))
      .toEqual([['st_appr', 'a_appr_before', 'before', 'completion']]);
  });

  test('a cancelled work order is not locked and keeps no last-photo rule', async () => {
    const r = await photoUpdates([{ attachment_id: 'a_cancel_only', tags: ['before'] }]);
    expect(r.stage).toBe('applied');
    expect(tagsOf('a_cancel_only')).toEqual(['before']);
    expect(photoEvents().map((e) => [e.ticket_id, e.detail.attachment_id])).toEqual([['st_cancel', 'a_cancel_only']]);
  });

  test('photos that are not work-order proof are untouched by the guard', async () => {
    const r = await photoUpdates([
      { attachment_id: 'a_plain', tags: ['before'] },        // a task on no work order
      { attachment_id: 'a_proj', tags: ['before'] },         // a project photo
      { attachment_id: 'a_site_appr', tags: ['before'] },    // a site photo stays a site photo
      { attachment_id: 'a_site_closed', caption: 'from the street' }]);
    expect(r.stage).toBe('applied');
    expect([tagsOf('a_plain'), tagsOf('a_proj'), tagsOf('a_site_appr')]).toEqual([['before'], ['before'], ['before']]);
    expect(rowOf('a_site_closed').caption).toBe('from the street');
    expect(photoEvents()).toEqual([]);
  });

  test('two organizations: the rival org is held to its own done building', async () => {
    const own = await photoUpdates([{ attachment_id: 'a_rival', tags: ['before'] }], OWN);
    expect([own.stage, own.detail.code]).toEqual(['refused', 'unresolvable_id']);
    const rival = await photoUpdates([{ attachment_id: 'a_rival', tags: ['before'] }], RIVAL);
    expect(rival.stage).toBe('refused');
    expect(rival.detail.code).toBe('last_completion_photo');
    expect(rival.message).toContain(LAST('Rival bldg', 'change it to a before photo'));
    expect(tagsOf('a_rival')).toEqual([]);
  });

  test('with no organization a building photo cannot change kind at all', async () => {
    // An un-stamped task passes the tenancy look with no org; the guard cannot
    // find a work order without one, so the dispatcher refuses by name.
    const r = await photoUpdates([{ attachment_id: 'a_legacy', tags: ['before'] }], { userId: 10 });
    expect(r.stage).toBe('refused');
    expect(r.detail.code).toBe('missing_organization');
    expect(tagsOf('a_legacy')).toEqual([]);
    const caption = await photoUpdates([{ attachment_id: 'a_legacy', caption: 'still fine' }], { userId: 10 });
    expect(caption.stage).toBe('applied');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * system.link_ops.attach_files — a move off the work order is refused
 * ══════════════════════════════════════════════════════════════════════════*/
describe('attach_files: a photo cannot be moved off a work order that needs it', () => {
  test('an approved work order refuses any photo, before photos included', async () => {
    const r = await attachFiles(['a_appr_before'], 'project', 'p1');
    expect(r.stage).toBe('refused');
    expect(r.name).toBe('PayloadValidationError');
    expect(r.message).toBe('attach_files: attachment a_appr_before: ' + LOCKED_MOVE('approved') + ' Nothing was saved.');
    expect(r.detail).toMatchObject({ code: 'photo_locked', retryable: false,
      field_path: 'system.link_ops[0].attachment_ids', received: 'a_appr_before' });
    expect(parentOf('a_appr_before')).toBe('task:t_900');
    expect(photoEvents()).toEqual([]);
  });

  test('a closed work order refuses its site photo', async () => {
    const r = await attachFiles(['a_site_closed'], 'job', 'j1');
    expect(r.stage).toBe('refused');
    expect(r.message).toContain(LOCKED_MOVE('closed'));
    expect(r.detail.code).toBe('photo_locked');
    expect(parentOf('a_site_closed')).toBe('service_ticket:st_closed');
  });

  test('the last completion photo on a done building refuses', async () => {
    const r = await attachFiles(['a_only'], 'project', 'p1');
    expect(r.stage).toBe('refused');
    expect(r.message).toContain(LAST('Bldg 784', 'move the photo'));
    expect(r.detail.code).toBe('last_completion_photo');
    expect(parentOf('a_only')).toBe('task:t_784');
  });

  test('one refused photo in the list moves none of them', async () => {
    const r = await attachFiles(['a_c1', 'a_proj', 'a_appr_c2'], 'job', 'j1');
    expect(r.stage).toBe('refused');
    expect(r.detail.code).toBe('photo_locked');
    expect([parentOf('a_c1'), parentOf('a_proj'), parentOf('a_appr_c2')])
      .toEqual(['task:t_785', 'project:p1', 'task:t_900']);
  });

  test('allowed moves go through and each is on its work order timeline as moved', async () => {
    const r = await attachFiles(['a_c1', 'a_before784', 'a_site_prog', 'a_open'], 'project', 'p1');
    expect(r.stage).toBe('applied');
    expect(r.res.updated[0]).toMatchObject({ kind: 'attach_files', count: 4 });
    expect(['a_c1', 'a_before784', 'a_site_prog', 'a_open'].map(parentOf)).toEqual(Array(4).fill('project:p1'));
    expect(r.queued).toBe(1);
    const got = photoEvents().map((e) => [e.ticket_id, e.kind, e.actor_kind, e.actor_user_id, e.detail]);
    expect(got).toHaveLength(4);
    expect(got).toEqual(expect.arrayContaining([
      ['st_prog', 'photo_removed', 'agent', 10, { attachment_id: 'a_c1', task_id: 't_785', title: 'Bldg 785', kind: 'completion', how: 'moved' }],
      ['st_prog', 'photo_removed', 'agent', 10, { attachment_id: 'a_before784', task_id: 't_784', title: 'Bldg 784 — north side', kind: 'before', how: 'moved' }],
      ['st_prog', 'photo_removed', 'agent', 10, { attachment_id: 'a_site_prog', task_id: null, title: null, kind: 'site', how: 'moved' }],
      ['st_prog', 'photo_removed', 'agent', 10, { attachment_id: 'a_open', task_id: 't_786', title: 'Bldg 786', kind: 'completion', how: 'moved' }],
    ]));
  });

  test('a cancelled work order lets its only completion photo move', async () => {
    const r = await attachFiles(['a_cancel_only'], 'project', 'p1');
    expect(r.stage).toBe('applied');
    expect(photoEvents().map((e) => [e.ticket_id, e.detail.how])).toEqual([['st_cancel', 'moved']]);
  });

  test('files that are not work-order proof move exactly as before, with no timeline row', async () => {
    const r = await attachFiles(['a_plain', 'a_proj', 'a_appr_doc'], 'job', 'j1');
    expect(r.stage).toBe('applied');
    expect([parentOf('a_plain'), parentOf('a_proj'), parentOf('a_appr_doc')]).toEqual(['job:j1', 'job:j1', 'job:j1']);
    expect(photoEvents()).toEqual([]);
  });

  test('an un-stamped work-order image cannot slip past the look; an un-stamped document still moves', async () => {
    const photo = await attachFiles(['a_ghost'], 'project', 'p1');
    expect(photo.stage).toBe('refused');
    expect(photo.message).toMatch(/1 of 1 attachment\(s\) could not be attached — 'a_ghost'/);
    expect(parentOf('a_ghost')).toBe('task:t_787');
    const doc = await attachFiles(['a_ghost_doc'], 'project', 'p1');
    expect(doc.stage).toBe('applied');
    expect(parentOf('a_ghost_doc')).toBe('project:p1');
  });

  test('an un-stamped photo on a PLAIN task — a task on no work order — still moves', async () => {
    // The 1.29 clause asked `entity_type NOT IN ('task', 'service_ticket')`,
    // which cannot tell a BUILDING from an ordinary job to-do without a join,
    // so it froze this row too and rolled the WHOLE payload back with "They do
    // not exist, or are not yours" — false on both counts, while POST
    // /api/attachments/:id/move went on moving it and the comment in the arm
    // promised it was untouched. The question is the guard's own:
    // tasks.service_ticket_id IS NOT NULL.
    const r = await attachFiles(['a_ghost_plain'], 'job', 'j1');
    expect(r.stage).toBe('applied');
    expect(r.res.updated[0]).toMatchObject({ kind: 'attach_files', count: 1 });
    expect(parentOf('a_ghost_plain')).toBe('job:j1');
    expect(photoEvents()).toEqual([]);
  });

  test('an un-stamped photo on the TICKET itself is still refused', async () => {
    const r = await attachFiles(['a_ghost_site'], 'project', 'p1');
    expect(r.stage).toBe('refused');
    expect(r.message).toMatch(/could not be attached — 'a_ghost_site'/);
    expect(parentOf('a_ghost_site')).toBe('service_ticket:st_prog');
  });

  test('one un-stamped building photo in the list still refuses the plain-task one beside it', async () => {
    const r = await attachFiles(['a_ghost_plain', 'a_ghost'], 'job', 'j1');
    expect(r.stage).toBe('refused');
    expect(r.message).toMatch(/1 of 2 attachment\(s\) could not be attached — 'a_ghost'/);
    expect([parentOf('a_ghost_plain'), parentOf('a_ghost')]).toEqual(['task:t_plain', 'task:t_787']);
  });

  test('with no organization no work-order image moves; a project photo and a plain to-do\'s still do', async () => {
    const photo = await attachFiles(['a_c1'], 'project', 'p_legacy', { userId: 10 });
    expect(photo.stage).toBe('refused');
    expect(photo.message).toMatch(/could not be attached — 'a_c1'/);
    expect(parentOf('a_c1')).toBe('task:t_785');
    const proj = await attachFiles(['a_proj'], 'project', 'p_legacy', { userId: 10 });
    expect(proj.stage).toBe('applied');
    expect(parentOf('a_proj')).toBe('project:p_legacy');
    // Nothing can be proven about a WORK ORDER with no org — but a photo on a
    // task that is on no work order was never the work order's proof.
    const plain = await attachFiles(['a_plain'], 'project', 'p_legacy', { userId: 10 });
    expect(plain.stage).toBe('applied');
    expect(parentOf('a_plain')).toBe('project:p_legacy');
  });

  test('two organizations: org 2 is refused on its own done building and never reads org 1', async () => {
    const r = await attachFiles(['a_rival'], 'project', 'p9', RIVAL);
    expect(r.stage).toBe('refused');
    expect(r.detail.code).toBe('last_completion_photo');
    expect(r.message).toContain(LAST('Rival bldg', 'move the photo'));
    const cross = await attachFiles(['a_appr_c1'], 'project', 'p9', RIVAL);
    expect(cross.stage).toBe('refused');
    expect(cross.detail.code).toBeUndefined();
    expect(cross.message).toMatch(/could not be attached/);
    expect(parentOf('a_appr_c1')).toBe('task:t_900');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 1.30 — WHO MAY TOUCH A BUILDING'S PHOTO AT ALL
 *
 * The blocks above are the PROOF rules: what may happen to a work order's
 * photos. These are the ACCESS rule: WHOSE photos they are. Both agent-side
 * gates in the dispatcher asked their ticket question of
 * `entity_type === TICKET_ENTITY_TYPE` alone, so a photo on a BUILDING — a task
 * row, which is where the crew's before / completion proof actually lives —
 * skipped it and landed on the coarse 'task' capability: JOBS_EDIT_ANY /
 * JOBS_EDIT_OWN / LEADS_EDIT, org-wide, with no question about the job. The
 * same half routes/attachment-routes.js closed on the HTTP doors.
 *
 * Driven against real role capabilities, with the parent varied and nothing
 * else, and with the un-guarded shape restored as a mutant each time.
 * ══════════════════════════════════════════════════════════════════════════*/
const captionOf = (id) => rowOf(id).caption;
const stmts = (t0) => eng.log.slice(t0).map((q) => q.sql);

describe('photo_updates: a building photo follows its work order, not the coarse task capability', () => {
  test('a leads-only approver is refused on a JOB work order\'s building, and the refusal names the WORK ORDER\'s capabilities', async () => {
    const r = await photoUpdates([{ attachment_id: 'a_open', caption: 'North face' }], LEADS);
    expect(r.stage).toBe('refused');
    expect(r.name).toBe('PayloadValidationError');
    expect(r.message).toBe('attachment.ops.photo_updates[0]: you do not have permission to edit photos on ' +
      "a work order's building (requires JOBS_EDIT_ANY or JOBS_EDIT_OWN). Nothing was saved.");
    expect(r.detail).toMatchObject({ code: 'missing_capability', retryable: false,
      field_path: 'attachment.ops.photo_updates[0]', received: 'JOBS_EDIT_ANY JOBS_EDIT_OWN' });
    expect(captionOf('a_open')).toBeNull();
  });

  test('varying ONLY the parent flips the verdict: the same approver writes a LEAD work order\'s building', async () => {
    const r = await photoUpdates([{ attachment_id: 'a_lead_bldg', caption: 'Front elevation' }], LEADS);
    expect(r.stage).toBe('applied');
    expect(captionOf('a_lead_bldg')).toBe('Front elevation');
    // …and the wide approver still writes the job one, so this is a rule, not a wall.
    const wide = await photoUpdates([{ attachment_id: 'a_open', caption: 'North face' }], OWN);
    expect(wide.stage).toBe('applied');
    expect(captionOf('a_open')).toBe('North face');
  });

  test('a narrow-tier approver who is not on the job gets the ABSENT-ID refusal, word for word', async () => {
    const hidden = await photoUpdates([{ attachment_id: 'a_open', caption: 'x' }], CREW);
    const absent = await photoUpdates([{ attachment_id: 'no_such_att', caption: 'x' }], CREW);
    expect([hidden.stage, absent.stage]).toEqual(['refused', 'refused']);
    expect(hidden.detail.code).toBe('unresolvable_id');
    expect(hidden.message.split('a_open').join('<ID>')).toBe(absent.message.split('no_such_att').join('<ID>'));
    expect(hidden.detail.field_path).toBe(absent.detail.field_path);
    expect(captionOf('a_open')).toBeNull();
  });

  test('a grant on the job opens it, and the ticket is read under the caller\'s org', async () => {
    eng.db.exec("INSERT INTO job_access (job_id, user_id, access_level) VALUES ('j1', 20, 'edit')");
    const t0 = eng.log.length;
    const r = await photoUpdates([{ attachment_id: 'a_open', caption: 'North face' }], CREW);
    expect(r.stage).toBe('applied');
    expect(captionOf('a_open')).toBe('North face');
    // The task -> ticket join and the ticket load both carry organization_id.
    const sql = stmts(t0);
    expect(sql.some((s) => /FROM tasks\s+WHERE id = \$1 AND organization_id = \$2[\s\S]*service_ticket_id IS NOT NULL/.test(s))).toBe(true);
    expect(sql.some((s) => /FROM service_tickets WHERE id = \$1 AND organization_id = \$2/.test(s))).toBe(true);
  });

  test('the ticket rule is asked BEFORE anything is written', async () => {
    const t0 = eng.log.length;
    await photoUpdates([{ attachment_id: 'a_open', caption: 'North face' }], OWN);
    const sql = stmts(t0);
    const rule = sql.findIndex((s) => /SELECT id, job_id, lead_id FROM service_tickets/.test(s));
    const write = sql.findIndex((s) => /^UPDATE attachments SET caption/.test(s));
    expect(rule).toBeGreaterThanOrEqual(0);
    expect(write).toBeGreaterThan(rule);
  });

  test('a photo that is NOT work-order proof keeps exactly the rule it had', async () => {
    // G3's regression, pinned from this side too: a plain job to-do and a
    // legacy un-stamped image on one are not a work order's proof and must not
    // start answering to a ticket that does not exist.
    const r = await photoUpdates([
      { attachment_id: 'a_plain', caption: 'ordinary to-do' },
      { attachment_id: 'a_ghost_plain', caption: 'legacy, plain task' },
      { attachment_id: 'a_legacy', caption: 'legacy, un-stamped task row' },
      { attachment_id: 'a_proj', caption: 'a project photo' }], LEADS);
    expect(r.stage).toBe('applied');
    expect(['a_plain', 'a_ghost_plain', 'a_legacy', 'a_proj'].map(captionOf))
      .toEqual(['ordinary to-do', 'legacy, plain task', 'legacy, un-stamped task row', 'a project photo']);
  });

  test('the ticket\'s OWN site photos are unchanged by this — the half that already worked', async () => {
    const refused = await photoUpdates([{ attachment_id: 'a_site_prog', caption: 'x' }], LEADS);
    expect(refused.stage).toBe('refused');
    expect(refused.message).toContain('edit photos on a service_ticket (requires JOBS_EDIT_ANY or JOBS_EDIT_OWN)');
    const ok = await photoUpdates([{ attachment_id: 'a_site_prog', caption: 'from the street' }], OWN);
    expect(ok.stage).toBe('applied');
  });
});

describe('photo_updates: the building\'s ASSIGNEE keeps the one exception the crew door needs', () => {
  test('the assignee fixes their own building\'s photo without any right to edit the job', async () => {
    const t0 = eng.log.length;
    const r = await photoUpdates([{ attachment_id: 'a_open', caption: 'North face, after' }], BLDG);
    expect(r.stage).toBe('applied');
    expect(captionOf('a_open')).toBe('North face, after');
    // The assignee lookup is org-scoped on the CALLER's proven organization.
    const hit = eng.log.slice(t0).find((q) => /SELECT assignee_user_id FROM tasks/.test(q.sql));
    expect(hit).toBeDefined();
    expect(hit.sql).toBe('SELECT assignee_user_id FROM tasks WHERE id = $1 AND organization_id = $2');
    expect(hit.params).toEqual(['t_786', 1]);
  });

  test('it is THEIR building, not every building: the same user is refused on one they are not assigned', async () => {
    const r = await photoUpdates([{ attachment_id: 'a_c1', caption: 'x' }], BLDG);
    expect(r.stage).toBe('refused');
    expect(r.detail.code).toBe('unresolvable_id');
    expect(captionOf('a_c1')).toBeNull();
  });

  test('it is a BUILDING\'s exception, never the work order\'s own site photos', async () => {
    const r = await photoUpdates([{ attachment_id: 'a_site_prog', caption: 'x' }], BLDG);
    expect(r.stage).toBe('refused');
    expect(r.detail.code).toBe('unresolvable_id');
    expect(captionOf('a_site_prog')).toBeNull();
  });

  test('it widens WHO may write, never what may happen to the proof', async () => {
    // Andy IS assigned t_784, so the access rule lets him through — and the
    // photo guard still refuses to take the last completion photo off it.
    const r = await photoUpdates([{ attachment_id: 'a_only', tags: ['before'] }], BLDG);
    expect(r.stage).toBe('refused');
    expect(r.detail.code).toBe('last_completion_photo');
    expect(r.message).toContain(LAST('Bldg 784', 'change it to a before photo'));
    expect(tagsOf('a_only')).toEqual([]);
  });

  test('the exception is asked only AFTER the ticket rule — an allowed caller never triggers the lookup', async () => {
    const t0 = eng.log.length;
    const r = await photoUpdates([{ attachment_id: 'a_open', caption: 'North face' }], OWN);
    expect(r.stage).toBe('applied');
    expect(stmts(t0).some((s) => /SELECT assignee_user_id FROM tasks/.test(s))).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * The SECOND door: a Scribe-written report attaches photo ids, and the report
 * hydrates them into storage URLs for whoever opens it. Same defect, read half.
 * ══════════════════════════════════════════════════════════════════════════*/
const reportSection = (ids) => ({
  label: 'Photos', layout: 'photo-grid', photo_ids: ids,
  captions: Object.fromEntries(ids.map((i) => [i, 'CAP-' + i])),
});
const reportTarget = (ids) => ({ entity_type: 'report',
  ops: { op: 'create', template_type: 'walkthrough', parent_id: 'p1', title: 'Scribe walk',
    sections: [reportSection(ids)] } });
const newReportIds = () => {
  const rows = eng.all('SELECT sections FROM job_reports ORDER BY rowid');
  return rows.length ? rows[rows.length - 1].sections.map((s) => s.photo_ids) : null;
};
async function makeReport(ids, ctx, mod) {
  const m = mod || dispatcher;
  return m.applyPayload({ id: 'pl_rpt', targets: [JSON.parse(JSON.stringify(reportTarget(ids)))] },
    { userId: ctx.userId, organizationId: ctx.organizationId });
}

describe('report photo ids: a building photo the writer may not read is not attached', () => {
  const ALL = ['a_proj', 'a_plain', 'a_open', 'a_lead_bldg'];

  test('a leads-only approver keeps the project, the plain to-do and the LEAD work order — the JOB building drops', async () => {
    const out = await makeReport(ALL, LEADS);
    expect(newReportIds()).toEqual([['a_proj', 'a_plain', 'a_lead_bldg']]);
    expect(out.affected_targets[0].photos_dropped).toBe(1);
    // The count is a number; no filename and no id ever reaches the summary.
    expect(out.apply_summary).toBe('Report created (template=walkthrough, 1 section(s), 1 photo(s) not attached — not visible to the approver)');
    expect(out.apply_summary).not.toMatch(/a_open|\.jpg/);
  });

  test('a narrow-tier approver who is not on the job drops it too', async () => {
    const out = await makeReport(ALL, CREW);
    expect(newReportIds()).toEqual([['a_proj', 'a_plain']]);
    expect(out.affected_targets[0].photos_dropped).toBe(2);
  });

  test('the wide approver keeps every one of them, so the rule is not a wall', async () => {
    const out = await makeReport(ALL, OWN);
    expect(newReportIds()).toEqual([ALL]);
    expect(out.affected_targets[0].photos_dropped).toBeUndefined();
  });

  test('the assignee exception does NOT cross to the read half', async () => {
    // Andy may fix his own building's photo (above). Pulling it into a report
    // other people read is not the same act, and he is still not on this job.
    const out = await makeReport(['a_proj', 'a_open'], BLDG);
    expect(newReportIds()).toEqual([['a_proj']]);
    expect(out.affected_targets[0].photos_dropped).toBe(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * applyPayload — the real transaction
 * ══════════════════════════════════════════════════════════════════════════*/
describe('through applyPayload', () => {
  const RETAG = { entity_type: 'attachment', ops: { photo_updates: [{ attachment_id: 'a_c1', tags: ['before'] }] } };
  const MOVE_OK = { entity_type: 'system', ops: { link_ops: [{ op: 'attach_files', attachment_ids: ['a_open'], target_entity_type: 'project', target_entity_id: 'p1' }] } };
  const MOVE_LOCKED = { entity_type: 'system', ops: { link_ops: [{ op: 'attach_files', attachment_ids: ['a_appr_c1'], target_entity_type: 'project', target_entity_id: 'p1' }] } };

  test('a committed payload writes both changes and records both timeline rows', async () => {
    const out = await dispatcher.applyPayload({ id: 'pl_ok', targets: [RETAG, MOVE_OK] }, OWN);
    expect(out.ok).toBe(true);
    expect(tagsOf('a_c1')).toEqual(['before']);
    expect(parentOf('a_open')).toBe('project:p1');
    expect(photoEvents().map((e) => [e.kind, e.detail.attachment_id])).toEqual([
      ['photo_retagged', 'a_c1'], ['photo_removed', 'a_open']]);
  });

  test('a refused move rolls the earlier retag back and records nothing', async () => {
    let err = null;
    try { await dispatcher.applyPayload({ id: 'pl_rb', targets: [RETAG, MOVE_LOCKED] }, OWN); }
    catch (e) { err = e; }
    expect(err && err.detail).toMatchObject({ code: 'photo_locked', target_index: 1 });
    expect(err.message).toContain(LOCKED_MOVE('approved'));
    expect(tagsOf('a_c1')).toEqual([]);
    expect(parentOf('a_appr_c1')).toBe('task:t_900');
    expect(photoEvents()).toEqual([]);
  });

  test('a dry run records nothing', async () => {
    const out = await dispatcher.applyPayload({ id: 'pl_dry', targets: [RETAG, MOVE_OK] }, Object.assign({ dryRun: true }, OWN));
    expect(out.dry_run).toBe(true);
    expect(tagsOf('a_c1')).toEqual([]);
    expect(parentOf('a_open')).toBe('task:t_786');
    expect(photoEvents()).toEqual([]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * MUTANTS — each wire removed from a copy of the shipped dispatcher
 * ══════════════════════════════════════════════════════════════════════════*/
describe('mutants: payload-dispatcher.js', () => {
  test('the harness refuses an anchor that is missing or not unique', () => {
    expect(() => mutantDispatcher([['this text is nowhere in the dispatcher', 'x']])).toThrow('anchor not found');
    expect(() => mutantDispatcher([['const ', 'let ']])).toThrow('anchor not found');
  });

  test('photo_updates guard call removed: an approved completion photo becomes a before photo', async () => {
    const mod = mutantDispatcher([['  if (proofRetags.length) {\n', '  if (false) {\n']]);
    const r = await photoUpdates([{ attachment_id: 'a_appr_c1', tags: ['before'] }], OWN, mod);
    expect(r.stage).toBe('applied');
    expect(tagsOf('a_appr_c1')).toEqual(['before']);
    expect(photoEvents()).toEqual([]);
  });

  test('photo_updates filter reads the old tags: the last completion photo on a done building is retagged', async () => {
    const mod = mutantDispatcher([[
      "photoGuard.retagChangesProof(att, normalizeTagsInput(u.tags)));",
      'photoGuard.retagChangesProof(att, att.tags));']]);
    const r = await photoUpdates([{ attachment_id: 'a_only', tags: ['before'] }], OWN, mod);
    expect(r.stage).toBe('applied');
    expect(tagsOf('a_only')).toEqual(['before']);
  });

  test('photo_updates refusal swallowed: the closed work order is retagged', async () => {
    const mod = mutantDispatcher([['    if (refusal) {\n      const hit = ', '    if (false) {\n      const hit = ']]);
    const r = await photoUpdates([{ attachment_id: 'a_closed_c1', tags: ['before'] }], OWN, mod);
    expect(r.stage).toBe('applied');
    expect(tagsOf('a_closed_c1')).toEqual(['before']);
  });

  test('photo_updates afterCommit not handed over: the retag lands with no timeline row', async () => {
    const mod = mutantDispatcher([[
      "      actor: { kind: 'agent', userId: actorId, label: null },\n      afterCommit: ctx && Array.isArray(ctx.afterCommit) ? ctx.afterCommit : undefined,\n",
      "      actor: { kind: 'agent', userId: actorId, label: null },\n"]]);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await photoUpdates([{ attachment_id: 'a_c1', tags: ['before'] }], OWN, mod);
      expect(r.stage).toBe('applied');
      expect(photoEvents()).toEqual([]);
    } finally { warn.mockRestore(); }
  });

  test('photo_updates no-org refusal removed: the named refusal is gone', async () => {
    const mod = mutantDispatcher([['    if (orgId == null) {\n      // The guard cannot find', '    if (false) {\n      // The guard cannot find']]);
    const r = await photoUpdates([{ attachment_id: 'a_legacy', tags: ['before'] }], { userId: 10 }, mod);
    expect(r.detail.code).not.toBe('missing_organization');
  });

  test('attach_files guard call removed: an approved work order photo is moved off it', async () => {
    const mod = mutantDispatcher([['          if (onWorkOrders.rows.length) {\n', '          if (false) {\n']]);
    const r = await attachFiles(['a_appr_c1'], 'project', 'p1', OWN, mod);
    expect(r.stage).toBe('applied');
    expect(parentOf('a_appr_c1')).toBe('project:p1');
    expect(photoEvents()).toEqual([]);
  });

  test('attach_files asks the guard about a delete instead of a move: the timeline says deleted', async () => {
    const mod = mutantDispatcher([["              op: 'move',\n              actor: afActor,", "              op: 'delete',\n              actor: afActor,"]]);
    const r = await attachFiles(['a_c1'], 'project', 'p1', OWN, mod);
    expect(r.stage).toBe('applied');
    expect(photoEvents().map((e) => e.detail.how)).toEqual(['deleted']);
    seed();
    const refused = await attachFiles(['a_only'], 'project', 'p1', OWN, mod);
    expect(refused.message).not.toContain(LAST('Bldg 784', 'move the photo'));
  });

  test('attach_files afterCommit not handed over: the move lands with no photo_removed row', async () => {
    const mod = mutantDispatcher([[
      '              actor: afActor,\n              afterCommit: ctx && Array.isArray(ctx.afterCommit) ? ctx.afterCommit : undefined,\n',
      '              actor: afActor,\n']]);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await attachFiles(['a_c1'], 'project', 'p1', OWN, mod);
      expect(r.stage).toBe('applied');
      expect(parentOf('a_c1')).toBe('project:p1');
      expect(photoEvents()).toEqual([]);
    } finally { warn.mockRestore(); }
  });

  test('attach_files blocked-id clause removed: an un-stamped only completion photo is moved off a done building', async () => {
    const mod = mutantDispatcher([[
      "\n                  AND NOT (id = ANY($5::text[])) RETURNING id`,\n              [et, String(eid), ids, afOrgId, afBlocked])",
      " RETURNING id`,\n              [et, String(eid), ids, afOrgId])"]]);
    const r = await attachFiles(['a_ghost'], 'project', 'p1', OWN, mod);
    expect(r.stage).toBe('applied');
    expect(parentOf('a_ghost')).toBe('project:p1');
  });

  test('attach_files no-org clause removed: a work-order image moves with no organization', async () => {
    const mod = mutantDispatcher([[
      "\n                  AND NOT (id = ANY($4::text[])) RETURNING id`,\n              [et, String(eid), ids, afBlocked]);",
      " RETURNING id`,\n              [et, String(eid), ids]);"]]);
    const r = await attachFiles(['a_c1'], 'project', 'p_legacy', { userId: 10 }, mod);
    expect(r.stage).toBe('applied');
    expect(parentOf('a_c1')).toBe('project:p_legacy');
  });

  test('photo_updates asks its ticket question of the TICKET type again: the crew\'s building photo is captioned by a leads-only approver', async () => {
    // The shipped shape before 1.30, restored exactly: the ticket rule for a
    // ticket's own photos, nothing at all for a building's.
    const mod = mutantDispatcher([[
      '    const wo = await ticketOf(att);\n    let ticketVerdict = wo',
      '    const wo = att.entity_type === TICKET_ENTITY_TYPE ? { ticketId: att.entity_id, taskId: null } : null;\n    let ticketVerdict = wo']]);
    const r = await photoUpdates([{ attachment_id: 'a_open', caption: 'North face' }], LEADS, mod);
    expect(r.stage).toBe('applied');
    expect(captionOf('a_open')).toBe('North face');
  });

  test('photo_updates assignee exception removed: the building\'s own assignee can no longer fix its photo', async () => {
    const mod = mutantDispatcher([[
      '    if (ticketVerdict && !ticketVerdict.ok && wo.taskId != null &&\n' +
      '        await isBuildingAssignee(dbClient, wo.taskId, orgId, actor)) {\n' +
      '      ticketVerdict = { ok: true };\n' +
      '    }',
      '    /* MUTANT: the assignee exception removed */']]);
    const r = await photoUpdates([{ attachment_id: 'a_open', caption: 'North face' }], BLDG, mod);
    expect(r.stage).toBe('refused');
    expect(r.detail.code).toBe('unresolvable_id');
    expect(captionOf('a_open')).toBeNull();
  });

  test('report photo ids ask the TICKET type again: the crew\'s building photo is attached to the report', async () => {
    const mod = mutantDispatcher([[
      '      const wo = await ticketOf(att);\n      if (!wo) { readable.add(String(att.id)); continue; }',
      "      const wo = att.entity_type !== TICKET_ENTITY_TYPE ? null : { ticketId: att.entity_id, taskId: null };\n" +
      '      if (!wo) { readable.add(String(att.id)); continue; }']]);
    const out = await makeReport(['a_proj', 'a_open'], LEADS, mod);
    expect(newReportIds()).toEqual([['a_proj', 'a_open']]);
    expect(out.affected_targets[0].photos_dropped).toBeUndefined();
  });

  test('attach_files asks only "is it on a task" again: a plain to-do\'s legacy photo is refused', async () => {
    // The rule that separates a BUILDING from an ordinary to-do. Without it the
    // block is the over-broad 1.29 one and the legacy row is unmovable again.
    const mod = mutantDispatcher([[' AND service_ticket_id IS NOT NULL`', '`']]);
    const r = await attachFiles(['a_ghost_plain'], 'job', 'j1', OWN, mod);
    expect(r.stage).toBe('refused');
    expect(r.message).toMatch(/could not be attached — 'a_ghost_plain'/);
    expect(parentOf('a_ghost_plain')).toBe('task:t_plain');
  });
});
