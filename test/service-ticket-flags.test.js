// FLAG A PROBLEM (1.29) — THE RULES AND THE READS BEHIND THE THREE DOORS.
//
// server/services/service-ticket-flags.js holds every decision the flag doors
// make that is not HTTP: which category counts, what a crew link may see of a
// flag, when a flag may still take a photo, the office's attention columns,
// and the org-pinned statements. The pure rules are driven directly; the
// statements run against node:sqlite through the pg shim with a schema derived
// from server/db.js, seeded across two organizations.
//
// Each rule that matters is then REMOVED from a copy of the shipped file and
// the same drive is shown to go red. The copy is normalised to LF, every
// anchor must occur exactly once, and the copy lives in the OS temp dir.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

// The notice module is only a hand-off target here: what it is CALLED with is
// under test, not what it sends (test/work-order-notices.test.js pins that).
global.__flagNotice = undefined;
jest.mock('../server/services/work-order-notices', () => ({
  get notifyProblemFlagged() { return global.__flagNotice; },
}));

const REPO = path.join(__dirname, '..');
const FLAGS_FILE = path.join(REPO, 'server', 'services', 'service-ticket-flags.js');
const ROUTES_FILE = path.join(REPO, 'server', 'routes', 'service-ticket-flag-routes.js');
const flags = require('../server/services/service-ticket-flags');
const inflight = require('../server/services/inflight');
const svc = require('../server/services/service-tickets');

const TABLES = [
  'organizations', 'users', 'roles', 'jobs', 'job_access', 'tasks',
  'service_tickets', 'service_ticket_events', 'service_ticket_shares',
  'service_ticket_revisions', 'service_ticket_flags', 'attachments',
];

let eng;
let auth;

// ── mutants ───────────────────────────────────────────────────────────────
let mutantPaths = [];

function absolutize(src, fromDir) {
  return src.replace(/require\((['"])([^'"]+)\1\)/g, (_m, _q, spec) => {
    const resolved = spec.charAt(0) === '.'
      ? require.resolve(path.resolve(fromDir, spec))
      : require.resolve(spec, { paths: [fromDir] });
    return 'require(' + JSON.stringify(resolved.split(path.sep).join('/')) + ')';
  });
}

function mutant(file, pairs) {
  let src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  for (const [find, replace] of pairs) {
    if (src.split(find).length !== 2) throw new Error('anchor not found');
    const next = src.split(find).join(replace);
    if (next === src) throw new Error('anchor not found');
    src = next;
  }
  const p = path.join(os.tmpdir(), '_p86_flags_mutant_' + process.pid + '_' +
    Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, absolutize(src, path.dirname(file)), 'utf8');
  mutantPaths.push(p);
  return require(p);
}

// ── fixture ───────────────────────────────────────────────────────────────
const T1 = { id: 'st_1', organization_id: 1, job_id: 'j1', lead_id: null, status: 'in_progress' };
const T2 = { id: 'st_2', organization_id: 1, job_id: 'j1', lead_id: null, status: 'in_progress' };
const TB = { id: 'st_b', organization_id: 2, job_id: 'j9', lead_id: null, status: 'in_progress' };

function seed() {
  const caps = (list) => "'" + JSON.stringify(list) + "'";
  eng.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM roles; DELETE FROM jobs;
    DELETE FROM job_access; DELETE FROM tasks; DELETE FROM service_tickets;
    DELETE FROM service_ticket_events; DELETE FROM service_ticket_shares;
    DELETE FROM service_ticket_revisions; DELETE FROM service_ticket_flags; DELETE FROM attachments;

    INSERT INTO organizations (id, name) VALUES (1, 'AGX'), (2, 'Rival Co');
    INSERT INTO roles (name, capabilities) VALUES
      ('fl_wide', ${caps(['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'LEADS_VIEW', 'LEADS_EDIT'])}),
      ('fl_crew', ${caps(['JOBS_VIEW_ASSIGNED', 'JOBS_EDIT_OWN'])});
    INSERT INTO users (id, name, email, role, organization_id) VALUES
      (10, 'Wendy Wide', 'w@agx.test', 'fl_wide', 1),
      (20, 'Carl Crew', 'c@agx.test', 'fl_crew', 1),
      (50, 'Rival Ray', 'r@rival.test', 'fl_wide', 2);
    INSERT INTO jobs (id, owner_id, data, organization_id) VALUES ('j1', 10, '{}', 1), ('j9', 50, '{}', 2);
    INSERT INTO job_access (job_id, user_id, access_level) VALUES ('j1', 20, 'view');

    INSERT INTO service_tickets (id, organization_id, title, job_id, status, office_seen_at, created_at) VALUES
      ('st_1', 1, 'Gate', 'j1', 'in_progress', NULL, '2026-09-01 10:00:00'),
      ('st_2', 1, 'Fence', 'j1', 'in_progress', NULL, '2026-09-01 10:00:01'),
      ('st_b', 2, 'Rival', 'j9', 'in_progress', NULL, '2026-09-01 10:00:02');

    INSERT INTO tasks (id, organization_id, title, status, scope, service_ticket_id, created_at) VALUES
      ('k1', 1, 'Bldg 784', 'open', 'org', 'st_1', '2026-09-02 08:00:00'),
      ('k2', 1, 'Bldg 900', 'open', 'org', 'st_2', '2026-09-02 08:00:01'),
      ('kp', 1, 'PRIVATE to-do', 'open', 'personal', 'st_1', '2026-09-02 08:00:02');

    INSERT INTO service_ticket_shares (id, organization_id, ticket_id, scope, revoked_at, created_by) VALUES
      ('sh_a', 1, 'st_1', 'respond', NULL, 10),
      ('sh_off', 1, 'st_1', 'respond', '2026-09-03 09:00:00', 10);
  `);
}

beforeAll(async () => {
  eng = createPgSqlite(sqliteSchema(TABLES), { jsonColumns: ['capabilities', 'detail', 'tags'] });
  auth = require('../server/auth');
  auth.setRolePool(eng.pool);
  seed();
  await auth.refreshRoleCache();
});

beforeEach(() => {
  seed();
  eng.log.length = 0;
  global.__flagNotice = undefined;
  inflight._reset();
});

const flush = () => new Promise((r) => setTimeout(r, 20));

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
  if (eng) eng.close();
});

function insertFlag(row) {
  const r = Object.assign({
    organization_id: 1, ticket_id: 'st_1', task_id: null, share_id: 'sh_a', author_label: 'Marco',
    category: 'no_access', note: 'Gate locked', attachment_ids: '[]', status: 'open',
    resolved_by: null, resolved_at: null, resolution_note: null, client_ref: null,
    created_at: null,
  }, row);
  const cols = Object.keys(r).filter((k) => k !== 'created_at' && k !== 'resolved_at');
  const created = r.created_at == null ? "datetime('now')" : r.created_at;
  const resolved = r.resolved_at == null ? 'NULL' : r.resolved_at;
  eng.db.prepare(
    'INSERT INTO service_ticket_flags (' + cols.join(', ') + ', created_at, resolved_at) VALUES (' +
    cols.map(() => '?').join(', ') + ', ' + created + ', ' + resolved + ')'
  ).run(...cols.map((k) => r[k]));
}

function insertPhoto(row) {
  const r = Object.assign({
    entity_type: 'service_ticket', entity_id: 'st_1', organization_id: 1, mime_type: 'image/jpeg',
    filename: 'p.jpg', thumb_url: 'https://cdn/t', web_url: 'https://cdn/w', original_url: 'https://cdn/o',
    tags: '["flag"]', uploaded_at: '2026-09-10 10:00:00',
  }, row);
  const cols = Object.keys(r);
  eng.db.prepare('INSERT INTO attachments (' + cols.join(', ') + ') VALUES (' + cols.map(() => '?').join(', ') + ')')
    .run(...cols.map((k) => r[k]));
}

const FORBIDDEN_CREW_KEYS = ['share_id', 'resolved_by', 'attachment_ids', 'client_ref', 'organization_id'];

/* ═══════════════════════════════════════════════════════════════════════════
 * THE MUTATION HARNESS
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the mutation harness cannot be fooled', () => {
  test('an anchor that is not in the file throws', () => {
    expect(() => mutant(FLAGS_FILE, [['this text is nowhere in the module', 'x']])).toThrow('anchor not found');
  });
  test('an anchor that occurs twice throws', () => {
    expect(() => mutant(FLAGS_FILE, [['ticket.organization_id', 'x']])).toThrow('anchor not found');
  });
  test('the shipped files are CRLF, so the LF normalisation is load-bearing', () => {
    for (const f of [FLAGS_FILE, ROUTES_FILE]) {
      expect(fs.readFileSync(f, 'utf8').indexOf('\r\n')).toBeGreaterThan(-1);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * PURE RULES
 * ══════════════════════════════════════════════════════════════════════════*/
describe('normalizeFlagCategory: an exact key or nothing', () => {
  const NULLS = ['', '   ', 'Other stuff', 'edit', 'no access', null, undefined, {}, [], 5, 'other '.repeat(2)];

  test('accepts the five keys, case and surrounding space tolerant', () => {
    expect(['no_access', 'extra_damage', 'material_short', 'safety', 'other'].map(flags.normalizeFlagCategory))
      .toEqual(['no_access', 'extra_damage', 'material_short', 'safety', 'other']);
    expect(flags.normalizeFlagCategory('  No_Access ')).toBe('no_access');
    expect(flags.normalizeFlagCategory('SAFETY')).toBe('safety');
  });

  test('returns null for anything else — it never defaults to other', () => {
    expect(NULLS.map(flags.normalizeFlagCategory)).toEqual(NULLS.map(() => null));
  });

  test('MUTANT: default to other -> the null cases go red', () => {
    const mut = mutant(FLAGS_FILE, [[
      'return FLAG_CATEGORIES.indexOf(k) >= 0 ? k : null;',
      "return FLAG_CATEGORIES.indexOf(k) >= 0 ? k : 'other';"]]);
    expect(NULLS.map(mut.normalizeFlagCategory)).not.toEqual(NULLS.map(() => null));
  });
});

describe('validateCrewFlag: the closed set of body keys', () => {
  test('a missing category is the exact 400, checked before the note', () => {
    expect(flags.validateCrewFlag({ note: 'x' })).toEqual({ ok: false, status: 400, error: 'Pick what kind of problem it is.' });
    expect(flags.validateCrewFlag({})).toEqual({ ok: false, status: 400, error: 'Pick what kind of problem it is.' });
    expect(flags.validateCrewFlag(null).error).toBe('Pick what kind of problem it is.');
  });

  test('a missing, blank or non-string note is the exact 400', () => {
    for (const note of [undefined, '', '   \n ', 42, { text: 'x' }]) {
      expect(flags.validateCrewFlag({ category: 'safety', note }))
        .toEqual({ ok: false, status: 400, error: 'Write what the problem is — the office needs a note.' });
    }
  });

  test('the note is trimmed and capped at 2000', () => {
    expect(flags.validateCrewFlag({ category: 'safety', note: '  Live wire  ' }).note).toBe('Live wire');
    expect(flags.validateCrewFlag({ category: 'safety', note: 'n'.repeat(2500) }).note).toHaveLength(2000);
  });

  test('a malformed client_ref is dropped, a good one kept', () => {
    for (const bad of ['short', 'has space in it', 'x'.repeat(65), 'abc$%^&*()1234', 12345678, null]) {
      expect(flags.validateCrewFlag({ category: 'other', note: 'n', client_ref: bad }).clientRef).toBeNull();
    }
    expect(flags.validateCrewFlag({ category: 'other', note: 'n', client_ref: 'a1b2c3d4e5f6a7b8' }).clientRef)
      .toBe('a1b2c3d4e5f6a7b8');
  });

  test('photos_expected is clamped to a whole number 0..6', () => {
    const pe = (v) => flags.validateCrewFlag({ category: 'other', note: 'n', photos_expected: v }).photosExpected;
    expect([pe(-3), pe(0), pe(2), pe('3'), pe(2.7), pe(99), pe('x'), pe(undefined), pe(null)])
      .toEqual([0, 0, 2, 3, 2, 6, 0, 0, 0]);
  });

  test('task_id is trimmed, or null when absent', () => {
    expect(flags.validateCrewFlag({ category: 'other', note: 'n', task_id: ' k1 ' }).taskId).toBe('k1');
    expect(flags.validateCrewFlag({ category: 'other', note: 'n', task_id: '' }).taskId).toBeNull();
    expect(flags.validateCrewFlag({ category: 'other', note: 'n' }).taskId).toBeNull();
  });

  test('nothing outside the closed set survives into the answer', () => {
    const v = flags.validateCrewFlag({
      category: 'other', note: 'n', status: 'resolved', organization_id: 999, share_id: 'x',
      attachment_ids: ['a'], resolution_note: 'done',
    });
    expect(Object.keys(v).sort()).toEqual(['category', 'clientRef', 'note', 'ok', 'photosExpected', 'taskId']);
    expect(flags.CREW_FLAG_FIELDS).toEqual(['category', 'note', 'task_id', 'client_ref', 'photos_expected', 'name']);
  });
});

describe('publicFlag: the crew link whitelist', () => {
  const ROW = {
    id: 'stflag_1', organization_id: 1, ticket_id: 'st_1', task_id: 'k1', share_id: 'sh_a',
    author_label: 'Marco', category: 'safety', note: 'Live wire', attachment_ids: '["a1"]', status: 'resolved',
    resolved_by: 10, resolved_at: '2026-09-10 11:00:00', resolution_note: 'Made safe', client_ref: 'a1b2c3d4e5f6',
    created_at: '2026-09-10 10:00:00',
  };
  const PHOTOS = [{ id: 'a1', thumb_url: 't', web_url: 'w', original_url: 'o', filename: 'secret.jpg', uploaded_by: 3 }];

  test('never share_id, resolved_by, attachment_ids, client_ref or organization_id', () => {
    const out = flags.publicFlag(ROW, PHOTOS, ['k1']);
    for (const k of FORBIDDEN_CREW_KEYS) expect(out).not.toHaveProperty(k);
    expect(Object.keys(out).sort()).toEqual(['author_label', 'category', 'created_at', 'id', 'note', 'photos',
      'resolution_note', 'resolved_at', 'status', 'task_id']);
    expect(out.photos).toEqual([{ id: 'a1', thumb_url: 't', web_url: 'w' }]);
  });

  test('task_id survives only when it is a live task of this ticket', () => {
    expect(flags.publicFlag(ROW, [], ['k1']).task_id).toBe('k1');
    expect(flags.publicFlag(ROW, [], new Set(['k1'])).task_id).toBe('k1');
    expect(flags.publicFlag(ROW, [], ['k2']).task_id).toBeNull();
    expect(flags.publicFlag(ROW, [], undefined).task_id).toBeNull();
  });

  test('MUTANT: add share_id to the whitelist -> red', () => {
    const mut = mutant(FLAGS_FILE, [[
      '    id: r.id,\n    task_id: taskId,',
      '    id: r.id,\n    share_id: r.share_id,\n    task_id: taskId,']]);
    const out = mut.publicFlag(ROW, PHOTOS, ['k1']);
    expect(FORBIDDEN_CREW_KEYS.filter((k) => k in out)).not.toEqual([]);
  });
});

describe('officeFlag: the office shape', () => {
  test('carries the office keys and nulls a task that is not on this ticket', () => {
    const base = {
      id: 'f', task_id: 'k1', task_live_id: 'k1', task_title: 'Bldg 784', category: 'other', note: 'n',
      author_label: 'M', via_revoked_link: 1, status: 'open', created_at: 'c', resolved_at: null,
      resolved_by_name: null, resolution_note: null, attachment_ids: '[]', client_ref: 'zzzzzzzz', organization_id: 1,
    };
    const out = flags.officeFlag(base, [{ id: 'a', filename: 'f.jpg', mime_type: 'image/jpeg', thumb_url: 't', web_url: 'w', original_url: 'o', uploaded_at: 'u', uploaded_by: 7 }]);
    expect(Object.keys(out).sort()).toEqual(['author_label', 'category', 'created_at', 'id', 'note', 'photos',
      'resolution_note', 'resolved_at', 'resolved_by_name', 'status', 'task_id', 'task_title', 'via_revoked_link']);
    expect(out.via_revoked_link).toBe(true);
    expect(out.photos[0]).toEqual({ id: 'a', filename: 'f.jpg', mime_type: 'image/jpeg', thumb_url: 't', web_url: 'w', original_url: 'o', uploaded_at: 'u' });
    const off = flags.officeFlag(Object.assign({}, base, { task_live_id: null, via_revoked_link: 0 }), []);
    expect([off.task_id, off.task_title, off.via_revoked_link]).toEqual([null, null, false]);
  });
});

describe('flagMayTakePhoto: open, within 2 hours, under 6', () => {
  const NOW = Date.parse('2026-09-15T12:00:00Z');
  const open = (extra) => Object.assign({ status: 'open', created_at: '2026-09-15 11:00:00', attachment_ids: '[]' }, extra);

  test('a fresh open flag with room may take a photo', () => {
    expect(flags.flagMayTakePhoto(open(), NOW)).toEqual({ ok: true });
    expect(flags.flagMayTakePhoto(open({ attachment_ids: ['1', '2', '3', '4', '5'] }), NOW)).toEqual({ ok: true });
    expect(flags.flagMayTakePhoto(open({ attachment_ids: null }), NOW)).toEqual({ ok: true });
  });

  test('refuses a missing flag, a resolved one, one over 2 hours old, one with 6 photos', () => {
    expect(flags.flagMayTakePhoto(null, NOW)).toEqual({ ok: false, status: 404, error: 'That problem report is not on this work order.' });
    expect(flags.flagMayTakePhoto(open({ status: 'resolved' }), NOW))
      .toEqual({ ok: false, status: 409, error: 'The office already resolved that problem.' });
    expect(flags.flagMayTakePhoto(open({ created_at: '2026-09-15 09:59:00' }), NOW))
      .toEqual({ ok: false, status: 409, error: 'Photos can only be added to a problem in the first 2 hours. Flag it again with the new photos.' });
    expect(flags.flagMayTakePhoto(open({ attachment_ids: '["1","2","3","4","5","6"]' }), NOW))
      .toEqual({ ok: false, status: 409, error: 'That problem already has 6 photos.' });
  });

  test('a zone-less database timestamp is UTC, whatever the server time zone', () => {
    // 10:30 UTC is 1.5 h before NOW. Read as local time in any zone west of
    // UTC it would look hours older (or in the future east of it).
    expect(flags.flagMayTakePhoto(open({ created_at: '2026-09-15 10:30:00' }), NOW).ok).toBe(true);
  });

  test("the database's own window verdict wins over the app clock", () => {
    expect(flags.flagMayTakePhoto(open({ in_window: 0, created_at: '2026-09-15 11:59:00' }), NOW).status).toBe(409);
    expect(flags.flagMayTakePhoto(open({ in_window: true, created_at: '2020-01-01 00:00:00' }), NOW).ok).toBe(true);
    expect(flags.flagMayTakePhoto(open({ in_window: null }), NOW).status).toBe(409);
  });
});

describe('cleanResolution, isNewFromCrew, withAttention', () => {
  test('cleanResolution trims, caps at 1000 and refuses non-strings', () => {
    expect(flags.cleanResolution('  Unlocked the gate  ')).toBe('Unlocked the gate');
    expect(flags.cleanResolution('r'.repeat(1200))).toHaveLength(1000);
    expect([flags.cleanResolution(null), flags.cleanResolution(5), flags.cleanResolution('   ')]).toEqual(['', '', '']);
  });

  test('isNewFromCrew', () => {
    expect(flags.isNewFromCrew(null, '2026-09-15 10:00:00')).toBe(false);
    expect(flags.isNewFromCrew(null, null)).toBe(false);
    expect(flags.isNewFromCrew('2026-09-15 10:00:00', null)).toBe(true);
    expect(flags.isNewFromCrew('2026-09-15 10:00:00', '2026-09-15 10:00:00')).toBe(false);
    expect(flags.isNewFromCrew('2026-09-15 09:00:00', '2026-09-15 10:00:00')).toBe(false);
    expect(flags.isNewFromCrew('2026-09-15 10:00:01', '2026-09-15 10:00:00')).toBe(true);
    expect(flags.isNewFromCrew(new Date('2026-09-15T10:00:01Z'), '2026-09-15 10:00:00')).toBe(true);
  });

  test('withAttention coerces the counts, adds new_from_crew and leaves the row alone', () => {
    const row = { id: 'st_1', open_flags: '2', pending_suggestions: null, last_crew_at: '2026-09-15 10:00:00', office_seen_at: null };
    const out = flags.withAttention(row);
    expect(out).toEqual({ id: 'st_1', open_flags: 2, pending_suggestions: 0, last_crew_at: '2026-09-15 10:00:00', office_seen_at: null, new_from_crew: true });
    expect(row).not.toHaveProperty('new_from_crew');
  });
});

describe('the code lists match the database CHECKs', () => {
  const DB = fs.readFileSync(path.join(REPO, 'server', 'db.js'), 'utf8');
  const listIn = (name, col) => {
    const m = new RegExp('ADD CONSTRAINT ' + name + '\\s+CHECK \\(' + col + ' IN \\(([^)]*)\\)\\)').exec(DB);
    if (!m) throw new Error('CHECK not found: ' + name);
    return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
  };
  test('FLAG_CATEGORIES and FLAG_STATUSES', () => {
    expect(flags.FLAG_CATEGORIES.slice()).toEqual(listIn('service_ticket_flags_category_chk', 'category'));
    expect(flags.FLAG_STATUSES.slice()).toEqual(listIn('service_ticket_flags_status_chk', 'status'));
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * ATTENTION_COLUMNS — the office list's badges
 * ══════════════════════════════════════════════════════════════════════════*/
describe('ATTENTION_COLUMNS', () => {
  const TOLERANCE = 'organization_id ' + 'IS NULL';

  test('every correlated subquery carries its own org predicate, and no tolerance arm anywhere', () => {
    const cols = flags.ATTENTION_COLUMNS;
    const refs = cols.match(/FROM (service_ticket_(?:flags|revisions|events)) ([a-z]+) WHERE ([^)]*)\)/g) || [];
    expect(refs).toHaveLength(3);
    for (const ref of refs) {
      const m = /FROM (\S+) ([a-z]+) WHERE (.*)$/.exec(ref);
      expect(m[3]).toContain(m[2] + '.organization_id = t.organization_id');
    }
    expect(cols).toContain("f.status = 'open'");
    expect(cols).toContain("e.kind <> 'share_opened'");
    for (const f of [FLAGS_FILE, ROUTES_FILE]) expect(fs.readFileSync(f, 'utf8')).not.toContain(TOLERANCE);
  });

  function seedAttention() {
    eng.db.exec(`
      INSERT INTO service_ticket_revisions (id, organization_id, ticket_id, status, created_at) VALUES
        ('rv1', 1, 'st_1', 'pending', '2026-09-10 10:00:00'),
        ('rv2', 1, 'st_1', 'accepted', '2026-09-10 10:00:00'),
        ('rv3', 2, 'st_1', 'pending', '2026-09-10 10:00:00');
      INSERT INTO service_ticket_events (id, organization_id, ticket_id, kind, actor_kind, created_at) VALUES
        ('ev1', 1, 'st_2', 'share_opened', 'share', '2026-09-12 10:00:00'),
        ('ev2', 1, 'st_1', 'subtask_note', 'share', '2026-09-12 09:00:00'),
        ('ev3', 1, 'st_1', 'note_added', 'user', '2026-09-12 11:00:00'),
        ('ev4', 2, 'st_2', 'subtask_note', 'share', '2026-09-12 12:00:00');
    `);
    insertFlag({ id: 'fa1', status: 'open' });
    insertFlag({ id: 'fa2', status: 'open', task_id: 'k1' });
    insertFlag({ id: 'fa3', status: 'resolved' });
    // PLANTED: an org-2-stamped row whose ticket_id is an org-1 ticket.
    insertFlag({ id: 'fa4', status: 'open', organization_id: 2 });
  }

  async function listWith(mod) {
    const r = await eng.pool.query(
      `SELECT t.id, ${mod.ATTENTION_COLUMNS} FROM service_tickets t WHERE t.organization_id = $1 ORDER BY t.id`, [1]);
    return r.rows.map(mod.withAttention);
  }

  test('counts only this org\'s open flags and pending suggestions, and ignores a link being opened', async () => {
    seedAttention();
    const rows = await listWith(flags);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect([byId.st_1.open_flags, byId.st_1.pending_suggestions]).toEqual([2, 1]);
    expect([byId.st_2.open_flags, byId.st_2.pending_suggestions]).toEqual([0, 0]);
    // st_1: a crew note, nobody has opened it since -> new. st_2: only the
    // link was opened (and a rival-stamped note) -> not new.
    expect(byId.st_1.new_from_crew).toBe(true);
    expect(byId.st_2.last_crew_at).toBeNull();
    expect(byId.st_2.new_from_crew).toBe(false);
    eng.db.exec("UPDATE service_tickets SET office_seen_at = '2026-09-12 10:00:00' WHERE id = 'st_1'");
    expect((await listWith(flags)).find((r) => r.id === 'st_1').new_from_crew).toBe(false);
  });

  test('MUTANT: drop the flags subquery org predicate -> the planted row is counted', async () => {
    seedAttention();
    const mut = mutant(FLAGS_FILE, [['f.ticket_id = t.id AND f.organization_id = t.organization_id AND ', 'f.ticket_id = t.id AND ']]);
    expect((await listWith(mut)).find((r) => r.id === 'st_1').open_flags).not.toBe(2);
  });

  test("MUTANT: stop excluding share_opened -> a link being opened reads as new from crew", async () => {
    seedAttention();
    const mut = mutant(FLAGS_FILE, [[" AND e.kind <> 'share_opened'", '']]);
    expect((await listWith(mut)).find((r) => r.id === 'st_2').new_from_crew).not.toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE READS
 * ══════════════════════════════════════════════════════════════════════════*/
describe('listCrewFlags', () => {
  test('newest first; open plus resolved in the last 14 days; this org and ticket only; photos pinned', async () => {
    insertFlag({ id: 'c_old_open', created_at: "datetime('now','-40 days')", attachment_ids: '["ph1","ph_task","ph_rival","ph_other_ticket"]' });
    insertFlag({ id: 'c_recent_res', status: 'resolved', resolved_at: "datetime('now','-2 days')", created_at: "datetime('now','-3 days')", resolution_note: 'Opened it', task_id: 'k1' });
    insertFlag({ id: 'c_stale_res', status: 'resolved', resolved_at: "datetime('now','-20 days')", created_at: "datetime('now','-21 days')" });
    insertFlag({ id: 'c_new', created_at: "datetime('now','-1 hours')", task_id: 'k2' });
    insertFlag({ id: 'c_rival', organization_id: 2, created_at: "datetime('now')" });
    insertFlag({ id: 'c_other_ticket', ticket_id: 'st_2', created_at: "datetime('now')" });
    insertPhoto({ id: 'ph1' });
    insertPhoto({ id: 'ph_task', entity_type: 'task', entity_id: 'k1' });
    insertPhoto({ id: 'ph_rival', organization_id: 2 });
    insertPhoto({ id: 'ph_other_ticket', entity_id: 'st_2' });

    const out = await flags.listCrewFlags(eng.pool, T1, ['k1']);
    expect(out.map((f) => f.id)).toEqual(['c_new', 'c_recent_res', 'c_old_open']);
    expect(out.find((f) => f.id === 'c_old_open').photos).toEqual([{ id: 'ph1', thumb_url: 'https://cdn/t', web_url: 'https://cdn/w' }]);
    // k2 is another ticket's building; k1 is live here.
    expect(out.find((f) => f.id === 'c_new').task_id).toBeNull();
    expect(out.find((f) => f.id === 'c_recent_res').task_id).toBe('k1');
    for (const f of out) for (const k of FORBIDDEN_CREW_KEYS) expect(f).not.toHaveProperty(k);
    for (const q of eng.log) expect(q.sql).toMatch(/organization_id = \$/);
  });
});

describe('listOfficeFlags, loadFlag and the office joins', () => {
  beforeEach(() => {
    eng.db.exec(`
      INSERT INTO service_ticket_shares (id, organization_id, ticket_id, scope, revoked_at) VALUES
        ('sh_rival', 2, 'st_b', 'respond', '2026-09-03 09:00:00');
    `);
    insertFlag({ id: 'o_res', status: 'resolved', resolved_by: 10, resolved_at: "datetime('now','-1 hours')", resolution_note: 'Fixed', created_at: "datetime('now')", task_id: 'k1' });
    insertFlag({ id: 'o_open_old', created_at: "datetime('now','-5 days')", share_id: 'sh_off', attachment_ids: '["op1"]' });
    insertFlag({ id: 'o_open_new', created_at: "datetime('now','-1 days')", task_id: 'k2', share_id: 'sh_rival', resolved_by: 50 });
    insertFlag({ id: 'o_rival', organization_id: 2, created_at: "datetime('now')" });
    insertPhoto({ id: 'op1' });
  });

  test('open first, then newest; titles, revoked links and resolver names from this org only', async () => {
    const out = await flags.listOfficeFlags(eng.pool, T1);
    expect(out.map((f) => f.id)).toEqual(['o_open_new', 'o_open_old', 'o_res']);
    const by = Object.fromEntries(out.map((f) => [f.id, f]));
    expect([by.o_res.task_id, by.o_res.task_title, by.o_res.resolved_by_name]).toEqual(['k1', 'Bldg 784', 'Wendy Wide']);
    expect(by.o_open_old.via_revoked_link).toBe(true);
    expect(by.o_open_old.photos.map((p) => p.id)).toEqual(['op1']);
    // k2 is on another ticket; sh_rival and user 50 are another org's.
    expect([by.o_open_new.task_id, by.o_open_new.task_title, by.o_open_new.via_revoked_link])
      .toEqual([null, null, false]);
  });

  test('loadFlag: org-pinned, with photo ids and photos; nonsense and foreign ids are null', async () => {
    const f = await flags.loadFlag(eng.pool, T1, 'o_open_old');
    expect(f).toEqual({
      id: 'o_open_old', task_id: null, category: 'no_access', note: 'Gate locked', status: 'open',
      photo_ids: ['op1'], photos: [{ id: 'op1', thumb_url: 'https://cdn/t', web_url: 'https://cdn/w' }],
      created_at: expect.anything(),
    });
    expect(await flags.loadFlag(eng.pool, T1, 'o_rival')).toBeNull();
    expect(await flags.loadFlag(eng.pool, TB, 'o_open_old')).toBeNull();
    expect(await flags.loadFlag(eng.pool, T1, "x' OR '1'='1")).toBeNull();
  });
});

describe('the crew-side lookups', () => {
  test('findByClientRef is pinned to the link; countOpen to open rows of this org', async () => {
    insertFlag({ id: 'cr1', client_ref: 'ref-12345678' });
    insertFlag({ id: 'cr2', client_ref: 'ref-other-link', share_id: 'sh_off' });
    insertFlag({ id: 'cr3', status: 'resolved' });
    insertFlag({ id: 'cr4', organization_id: 2 });
    expect((await flags.findByClientRef(eng.pool, T1, 'sh_a', 'ref-12345678')).id).toBe('cr1');
    expect(await flags.findByClientRef(eng.pool, T1, 'sh_a', 'ref-other-link')).toBeNull();
    expect(await flags.findByClientRef(eng.pool, TB, 'sh_a', 'ref-12345678')).toBeNull();
    expect(await flags.countOpen(eng.pool, T1)).toBe(2);
  });

  test('insertCrewFlag writes org and ticket from the ticket row, and status, photos and time explicitly', async () => {
    const v = flags.validateCrewFlag({ category: 'safety', note: 'Live wire', client_ref: 'abcdefgh1234' });
    const row = await flags.insertCrewFlag(eng.pool, { ticket: T1, share: { id: 'sh_a' }, task: { id: 'k1' }, flag: v, authorLabel: 'Marco' });
    const stored = eng.all('SELECT * FROM service_ticket_flags WHERE id = ?', row.id)[0];
    expect(stored).toMatchObject({ organization_id: 1, ticket_id: 'st_1', task_id: 'k1', share_id: 'sh_a', author_label: 'Marco',
      category: 'safety', note: 'Live wire', attachment_ids: '[]', status: 'open', client_ref: 'abcdefgh1234', resolved_by: null });
    expect(stored.created_at).toBeTruthy();
    expect(row.id).toMatch(/^stflag_/);
  });

  test('loadCrewFlagForPhoto: another link\'s flag is not found, and the 2-hour window is the database\'s', async () => {
    insertFlag({ id: 'p_fresh', created_at: "datetime('now','-30 minutes')" });
    insertFlag({ id: 'p_old', created_at: "datetime('now','-3 hours')" });
    insertFlag({ id: 'p_other', share_id: 'sh_off' });
    const fresh = await flags.loadCrewFlagForPhoto(eng.pool, T1, 'sh_a', 'p_fresh');
    const old = await flags.loadCrewFlagForPhoto(eng.pool, T1, 'sh_a', 'p_old');
    expect(flags.flagMayTakePhoto(fresh)).toEqual({ ok: true });
    expect(flags.flagMayTakePhoto(old).error).toMatch(/first 2 hours/);
    expect(await flags.loadCrewFlagForPhoto(eng.pool, T1, 'sh_a', 'p_other')).toBeNull();
    expect(await flags.loadCrewFlagForPhoto(eng.pool, TB, 'sh_a', 'p_fresh')).toBeNull();
    expect(await flags.loadCrewFlagForPhoto(eng.pool, T1, 'sh_a', 'bad id!')).toBeNull();
  });
});

describe('flagHasPhoto, isFlagPhotoRow, photoHolder', () => {
  test('flagHasPhoto reads text, arrays and null lists', () => {
    expect(flags.flagHasPhoto({ attachment_ids: '["att_1","att_2"]' }, 'att_2')).toBe(true);
    expect(flags.flagHasPhoto({ attachment_ids: ['att_1'] }, 'att_1')).toBe(true);
    expect(flags.flagHasPhoto({ attachment_ids: null }, 'att_1')).toBe(false);
    expect(flags.flagHasPhoto({ attachment_ids: '["att_1"]' }, 'att_9')).toBe(false);
    expect(flags.flagHasPhoto(null, 'att_1')).toBe(false);
    expect(flags.flagHasPhoto({ attachment_ids: '[""]' }, '')).toBe(false);
  });

  test('isFlagPhotoRow: tagged flag, as an array or JSON text', () => {
    expect(flags.isFlagPhotoRow({ tags: ['flag'] })).toBe(true);
    expect(flags.isFlagPhotoRow({ tags: '["before","flag"]' })).toBe(true);
    expect(flags.isFlagPhotoRow({ tags: ['completion'] })).toBe(false);
    expect(flags.isFlagPhotoRow({ tags: null })).toBe(false);
    expect(flags.isFlagPhotoRow(null)).toBe(false);
  });

  test('photoHolder finds the flag of this ticket and org holding the photo', async () => {
    insertFlag({ id: 'ph_a', attachment_ids: '["att_x"]' });
    insertFlag({ id: 'ph_b', attachment_ids: '["att_y"]', ticket_id: 'st_2' });
    insertFlag({ id: 'ph_r', attachment_ids: '["att_z"]', organization_id: 2 });
    expect(await flags.photoHolder(eng.pool, T1, 'att_x')).toBe('ph_a');
    expect(await flags.photoHolder(eng.pool, T1, 'att_y')).toBeNull();
    expect(await flags.photoHolder(eng.pool, T1, 'att_z')).toBeNull();
    expect(await flags.photoHolder(eng.pool, T1, 'att_none')).toBeNull();
    const q = eng.log.filter((x) => /FROM service_ticket_flags WHERE ticket_id = \$1 AND organization_id = \$2$/.test(x.sql));
    expect(q).toHaveLength(4);
    expect(q[0].params).toEqual(['st_1', 1]);
    eng.log.length = 0;
    expect(await flags.photoHolder(eng.pool, T1, '')).toBeNull();
    expect(await flags.photoHolder(eng.pool, { id: 'st_1' }, 'att_x')).toBeNull();
    expect(eng.log).toHaveLength(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE WRITES
 * ══════════════════════════════════════════════════════════════════════════*/
describe('attachPhoto', () => {
  test('appends under the lock, parses text or null ids, and the UPDATE is pinned to id + org', async () => {
    insertFlag({ id: 'ap1', attachment_ids: null });
    expect(await flags.attachPhoto(eng.pool, T1, 'ap1', 'att_1')).toEqual({ ok: true, added: true });
    expect(await flags.attachPhoto(eng.pool, T1, 'ap1', 'att_2')).toEqual({ ok: true, added: true });
    expect(await flags.attachPhoto(eng.pool, T1, 'ap1', 'att_2')).toEqual({ ok: true, added: false });
    expect(JSON.parse(eng.all("SELECT attachment_ids FROM service_ticket_flags WHERE id = 'ap1'")[0].attachment_ids))
      .toEqual(['att_1', 'att_2']);
    const up = eng.log.filter((q) => /^UPDATE service_ticket_flags SET attachment_ids/.test(q.sql));
    expect(up).toHaveLength(2);
    expect(up[0].sql).toMatch(/WHERE id = \$2 AND organization_id = \$3$/);
    expect(up[0].params.slice(1)).toEqual(['ap1', 1]);
    expect(eng.log.filter((q) => q.sql === 'COMMIT')).toHaveLength(2);
  });

  test('a photo already on a full flag is ok and not added again (the id check comes before the cap)', async () => {
    insertFlag({ id: 'ap_full2', attachment_ids: '["1","2","3","4","5","6"]' });
    expect(await flags.attachPhoto(eng.pool, T1, 'ap_full2', '6')).toEqual({ ok: true, added: false });
    expect(eng.log.filter((q) => /^UPDATE/.test(q.sql))).toHaveLength(0);
  });

  test('refuses a sixth photo, a resolved flag and another org\'s flag', async () => {
    insertFlag({ id: 'ap_full', attachment_ids: '["1","2","3","4","5","6"]' });
    insertFlag({ id: 'ap_res', status: 'resolved' });
    insertFlag({ id: 'ap_rival', organization_id: 2 });
    expect(await flags.attachPhoto(eng.pool, T1, 'ap_full', 'att_7'))
      .toEqual({ ok: false, status: 409, error: 'That problem already has 6 photos.' });
    expect((await flags.attachPhoto(eng.pool, T1, 'ap_res', 'att_7')).status).toBe(409);
    expect((await flags.attachPhoto(eng.pool, T1, 'ap_rival', 'att_7')).ok).toBe(false);
    expect(eng.log.filter((q) => /^UPDATE/.test(q.sql))).toHaveLength(0);
    expect(eng.log.filter((q) => q.sql === 'ROLLBACK')).toHaveLength(3);
  });

  test('ids that arrive already parsed are read too, and the client is released on a failure', async () => {
    let released = 0;
    const calls = [];
    const fake = {
      connect: async () => ({
        query: async (sql, params) => {
          calls.push(String(sql).replace(/\s+/g, ' ').trim());
          if (/^SELECT/.test(calls[calls.length - 1])) return { rows: [{ id: 'x', attachment_ids: ['1', '2', '3', '4', '5', '6'] }] };
          return { rows: [] };
        },
        release: () => { released++; },
      }),
    };
    expect((await flags.attachPhoto(fake, T1, 'x', 'att')).error).toBe('That problem already has 6 photos.');
    const boom = { connect: async () => ({ query: async (sql) => { if (/^\s*SELECT/.test(sql)) throw new Error('down'); return { rows: [] }; }, release: () => { released++; } }) };
    await expect(flags.attachPhoto(boom, T1, 'x', 'att')).rejects.toThrow('down');
    expect(released).toBe(2);
  });
});

describe('resolveFlag, resolveOpenFlagsOnClose, logFlagEvent', () => {
  test('resolveFlag resolves an open flag once, in this org only', async () => {
    insertFlag({ id: 'rs1', task_id: 'k1' });
    insertFlag({ id: 'rs_rival', organization_id: 2 });
    const r = await flags.resolveFlag(eng.pool, { ticket: T1, flagId: 'rs1', userId: 10, note: '  Unlocked  ' });
    expect(r).toEqual({ id: 'rs1', task_id: 'k1', category: 'no_access', status: 'resolved' });
    expect(eng.all("SELECT status, resolved_by, resolution_note FROM service_ticket_flags WHERE id = 'rs1'")[0])
      .toEqual({ status: 'resolved', resolved_by: 10, resolution_note: 'Unlocked' });
    expect(await flags.resolveFlag(eng.pool, { ticket: T1, flagId: 'rs1', userId: 10, note: 'again' })).toBeNull();
    expect(await flags.resolveFlag(eng.pool, { ticket: T1, flagId: 'rs_rival', userId: 10, note: 'x' })).toBeNull();
    expect(eng.all("SELECT status FROM service_ticket_flags WHERE id = 'rs_rival'")[0].status).toBe('open');
  });

  test('resolveOpenFlagsOnClose clears this ticket\'s open flags with shape-only events', async () => {
    insertFlag({ id: 'cl1', note: 'SECRET crew words' });
    insertFlag({ id: 'cl2', task_id: 'k1' });
    insertFlag({ id: 'cl3', status: 'resolved' });
    insertFlag({ id: 'cl_rival', organization_id: 2 });
    const rows = await flags.resolveOpenFlagsOnClose(eng.pool, T1, { kind: 'user', userId: 10 }, 'Closed with the work order.');
    expect(rows.map((r) => r.id).sort()).toEqual(['cl1', 'cl2']);
    expect(eng.all("SELECT id FROM service_ticket_flags WHERE status = 'open'").map((r) => r.id)).toEqual(['cl_rival']);
    const ev = eng.all("SELECT kind, actor_user_id, organization_id, detail FROM service_ticket_events WHERE kind = 'flag_resolved' ORDER BY id");
    expect(ev).toHaveLength(2);
    for (const e of ev) {
      expect(Object.keys(e.detail).sort()).toEqual(['category', 'flag_id', 'task_id']);
      expect([e.actor_user_id, e.organization_id]).toEqual([10, 1]);
      expect(JSON.stringify(e.detail)).not.toContain('SECRET');
    }
  });

  // work-order-review.js changeStatus calls this on every close and cancel, so
  // the ticket-and-org predicate now decides what a routine close touches.
  test('resolveOpenFlagsOnClose with nothing open writes nothing at all', async () => {
    insertFlag({ id: 'cl_done', status: 'resolved' });
    insertFlag({ id: 'cl_other', ticket_id: 'st_2' });
    expect(await flags.resolveOpenFlagsOnClose(eng.pool, T1, { kind: 'user', userId: 10 }, 'Closed with the work order.'))
      .toEqual([]);
    expect(eng.count("SELECT 1 FROM service_ticket_events WHERE kind = 'flag_resolved'")).toBe(0);
    expect(eng.all("SELECT id FROM service_ticket_flags WHERE status = 'open'").map((r) => r.id)).toEqual(['cl_other']);
  });

  test("MUTANT: drop the org predicate from the close-out and another tenant's flag goes with it", async () => {
    insertFlag({ id: 'cl1' });
    insertFlag({ id: 'cl_rival', organization_id: 2 });
    const mut = mutant(FLAGS_FILE, [[
      "      WHERE ticket_id = $3 AND organization_id = $4 AND status = 'open'",
      "      WHERE ticket_id = $3 AND $4 IS NOT NULL AND status = 'open'"]]);
    await mut.resolveOpenFlagsOnClose(eng.pool, T1, { kind: 'user', userId: 10 }, 'Closed with the work order.');
    expect(eng.all("SELECT id FROM service_ticket_flags WHERE status = 'open'").map((r) => r.id)).not.toEqual(['cl_rival']);
  });

  test('MUTANT: drop the ticket predicate and closing one work order clears the whole job', async () => {
    insertFlag({ id: 'cl1' });
    insertFlag({ id: 'cl_other', ticket_id: 'st_2' });
    const mut = mutant(FLAGS_FILE, [[
      "      WHERE ticket_id = $3 AND organization_id = $4 AND status = 'open'",
      "      WHERE $3 IS NOT NULL AND organization_id = $4 AND status = 'open'"]]);
    await mut.resolveOpenFlagsOnClose(eng.pool, T1, { kind: 'user', userId: 10 }, 'Closed with the work order.');
    expect(eng.all("SELECT id FROM service_ticket_flags WHERE status = 'open'").map((r) => r.id)).not.toEqual(['cl_other']);
  });

  test('logFlagEvent writes the shape only, whatever detail it is handed', async () => {
    await flags.logFlagEvent(eng.pool, T1, 'flag_raised', { kind: 'share', shareId: 'sh_a', label: 'Marco' },
      { flag_id: 'f1', category: 'safety', task_id: null, note: 'Live wire', photos: 3 });
    const e = eng.all("SELECT * FROM service_ticket_events WHERE kind = 'flag_raised'")[0];
    expect(e.detail).toEqual({ flag_id: 'f1', category: 'safety', task_id: null });
    expect([e.actor_kind, e.share_id, e.actor_label, e.organization_id, e.ticket_id]).toEqual(['share', 'sh_a', 'Marco', 1, 'st_1']);
  });
});

describe('markOfficeSeen', () => {
  const WIDE = { id: 10, role: 'fl_wide', organization_id: 1 };
  const CREW = { id: 20, role: 'fl_crew', organization_id: 1 };
  const RIVAL = { id: 50, role: 'fl_wide', organization_id: 2 };
  const seen = (id) => eng.all('SELECT office_seen_at FROM service_tickets WHERE id = ?', id)[0].office_seen_at;

  test('a caller who can edit stamps it; a view grant does not', async () => {
    expect(await flags.markOfficeSeen(eng.pool, CREW, T1, 1)).toBe(false);
    expect(seen('st_1')).toBeNull();
    expect(await flags.markOfficeSeen(eng.pool, WIDE, T1, 1)).toBe(true);
    expect(seen('st_1')).toBeTruthy();
    const up = eng.log.filter((q) => /^UPDATE service_tickets SET office_seen_at/.test(q.sql));
    expect(up).toHaveLength(1);
    expect(up[0].sql).toMatch(/WHERE id = \$1 AND organization_id = \$2$/);
    expect(up[0].sql).not.toMatch(/updated_at/);
  });

  test('another org never stamps it, and a failure is false, never a throw', async () => {
    expect(await flags.markOfficeSeen(eng.pool, RIVAL, T1, 2)).toBe(false);
    expect(seen('st_1')).toBeNull();
    const broken = { query: async () => { throw new Error('db down'); } };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await flags.markOfficeSeen(broken, WIDE, T1, 1)).toBe(false);
      expect(await flags.markOfficeSeen(eng.pool, null, T1, 1)).toBe(false);
    } finally { warn.mockRestore(); }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE HAND-OFF
 * ══════════════════════════════════════════════════════════════════════════*/
describe('handOffRaised', () => {
  const SHARE = { id: 'sh_a', created_by: 10, recipient_name: 'Marco', token_hash: 'SECRET-HASH', scope: 'respond' };
  const payload = (extra) => Object.assign({
    ticket: T1, share: SHARE,
    flag: { id: 'stflag_9', category: 'safety', note: 'Live wire', task_id: 'k1', task_title: 'Bldg 784', created_at: 'c' },
    photosExpected: 9,
  }, extra);

  test('calls notifyProblemFlagged once, with the flag shape, and tracks it', async () => {
    const calls = [];
    let release;
    global.__flagNotice = (db, opts) => { calls.push([db, opts]); return new Promise((r) => { release = r; }); };
    const tracked = flags.handOffRaised(eng.pool, payload());
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(eng.pool);
    expect(calls[0][1]).toEqual({
      ticket: T1,
      share: { id: 'sh_a', created_by: 10, recipient_name: 'Marco' },
      flag: { id: 'stflag_9', category: 'safety', note: 'Live wire', task_id: 'k1', task_title: 'Bldg 784', photo_count: 6 },
    });
    expect(inflight.size()).toBe(1);
    release({ sent: 1 });
    await expect(tracked).resolves.toEqual({ sent: 1 });
    expect(inflight.size()).toBe(0);
  });

  test('a rejecting, throwing or missing notice never throws', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      global.__flagNotice = async () => { throw new Error('smtp down'); };
      await expect(flags.handOffRaised(eng.pool, payload())).resolves.toBeUndefined();
      global.__flagNotice = () => { throw new Error('sync boom'); };
      expect(flags.handOffRaised(eng.pool, payload())).toBeNull();
      global.__flagNotice = undefined;
      expect(flags.handOffRaised(eng.pool, payload())).toBeNull();
      let called = 0;
      global.__flagNotice = () => { called++; return Promise.resolve(); };
      expect(flags.handOffRaised(eng.pool, payload({ flag: {} }))).toBeNull();
      expect(flags.handOffRaised(eng.pool, null)).toBeNull();
      expect(called).toBe(0);
    } finally { warn.mockRestore(); }
  });
});

describe('the module itself', () => {
  test('every exported message is the spec wording', () => {
    expect(flags.MSG).toEqual({
      pickCategory: 'Pick what kind of problem it is.',
      noteRequired: 'Write what the problem is — the office needs a note.',
      buildingNotFound: 'That building is not on this work order.',
      openCap: 'This work order already has 20 problems waiting on the office. Call the office instead.',
      sendFailed: 'Something went wrong sending that. Try again, or call the office.',
      photoFlagNotFound: 'That problem report is not on this work order.',
      photoResolved: 'The office already resolved that problem.',
      photoWindow: 'Photos can only be added to a problem in the first 2 hours. Flag it again with the new photos.',
      photoCap: 'That problem already has 6 photos.',
      photoFailed: 'Something went wrong uploading that.',
      resolveNoteRequired: 'Say how it was handled — the crew sees this note.',
      resolveNotFound: 'That problem is not on this ticket, or it was already resolved.',
      resolveFailed: 'Failed to resolve the problem',
    });
    expect([flags.FLAG_OPEN_CAP, flags.FLAG_PHOTO_CAP, flags.FLAG_NOTE_MAX, flags.FLAG_RESOLUTION_MAX, flags.FLAG_PHOTO_WINDOW_MS])
      .toEqual([20, 6, 2000, 1000, 2 * 60 * 60 * 1000]);
    expect(svc.genId('stflag')).toMatch(/^stflag_/);
  });

  test('no statement in the module or the routes reads a money column', () => {
    for (const f of [FLAGS_FILE, ROUTES_FILE]) {
      const src = fs.readFileSync(f, 'utf8');
      expect(src).not.toMatch(/scope_approved|internal_notes|guest_log|crew_takeoff|unit_?cost|contract_amount|hide_financials/i);
    }
  });
});
