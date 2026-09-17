// The work order's read helpers (1.29), driven over node:sqlite through the pg
// shim against the schema server/db.js writes:
//   * insertEvent is strict when asked (inside a transaction a swallowed
//     failure turns COMMIT into a silent ROLLBACK) and forgiving by default;
//   * subtaskCounts counts the live org subtasks of THIS ticket in THIS org;
//   * lastStatusEvent is the newest status_changed row of this ticket and org;
//   * ticketSitePhotos lists the ticket's own images, newest first, without
//     flag photos, without another org's rows, naming the crew link or the
//     office — and never an office name on the crew read;
//   * subtaskActivity adds note ids only when asked.
// The rules are then removed from temp copies of the module and shown to fail.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const REAL = path.join(__dirname, '..', 'server', 'services', 'service-ticket-workorder.js');
const SVC_ABS = path.join(__dirname, '..', 'server', 'services', 'service-tickets.js').split(path.sep).join('/');
const W = require(REAL);
const TABLES = ['organizations', 'users', 'jobs', 'leads', 'tasks', 'attachments',
  'service_tickets', 'service_ticket_events'];

let eng;
const made = [];

beforeAll(() => {
  eng = createPgSqlite(sqliteSchema(TABLES), { jsonColumns: ['data', 'tags', 'detail', 'checklist', 'materials'] });
});
afterAll(() => {
  if (eng) eng.close();
  for (const p of made) { try { fs.unlinkSync(p); } catch (_) {} }
});

function mutant(find, replace) {
  const src = fs.readFileSync(REAL, 'utf8').replace(/\r\n/g, '\n');
  if (src.split(find).length !== 2) throw new Error('anchor not found');
  const out = src.replace(find, replace)
    .replace("require('./service-tickets')", 'require(' + JSON.stringify(SVC_ABS) + ')');
  const p = path.join(os.tmpdir(), '_p86_wor_reads_' + process.pid + '_' + Math.random().toString(36).slice(2, 9) + '.js');
  fs.writeFileSync(p, out, 'utf8');
  made.push(p);
  return require(p);
}

function seed() {
  eng.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM tasks;
    DELETE FROM attachments; DELETE FROM service_tickets; DELETE FROM service_ticket_events;
    INSERT INTO organizations (id, name) VALUES (1, 'AGX'), (2, 'Rival');
    INSERT INTO users (id, name, email, role, organization_id) VALUES
      (10, 'Jason Salinas', 'j@agx.test', 'pm', 1),
      (50, 'Ray Rival', 'r@rival.test', 'pm', 2);
    INSERT INTO service_tickets (id, organization_id, title, job_id, status, checklist, created_by) VALUES
      ('st1', 1, 'Latitude 28 punch list', 'j1', 'work_complete', '[]', 10),
      ('st2', 1, 'Other ticket', 'j1', 'open', '[]', 10);
    INSERT INTO tasks (id, organization_id, title, status, scope, service_ticket_id, entity_type, entity_id, archived_at) VALUES
      ('t782', 1, 'Bldg 782', 'done', 'org', 'st1', 'job', 'j1', NULL),
      ('t784', 1, 'Bldg 784', 'open', 'org', 'st1', 'job', 'j1', NULL),
      ('t786', 1, 'Bldg 786', 'done', 'org', 'st1', 'job', 'j1', NULL),
      ('tarch', 1, 'archived building', 'done', 'org', 'st1', 'job', 'j1', '2026-09-01'),
      ('tpriv', 1, 'private to-do', 'done', 'personal', 'st1', 'job', 'j1', NULL),
      ('tother', 1, 'another ticket', 'done', 'org', 'st2', 'job', 'j1', NULL),
      ('trival', 2, 'rival org, same ticket id', 'done', 'org', 'st1', 'job', 'j9', NULL);
  `);
}
beforeEach(seed);

const ticket = (id) => eng.all('SELECT * FROM service_tickets WHERE id = ?', id)[0];
const eventRows = () => eng.all('SELECT kind, organization_id, detail FROM service_ticket_events ORDER BY rowid');

function ev(id, org, ticketId, kind, actorKind, opts) {
  const o = opts || {};
  eng.db.prepare(
    'INSERT INTO service_ticket_events (id, organization_id, ticket_id, kind, actor_kind, share_id, actor_label, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, org, ticketId, kind, actorKind, o.share_id || null, o.label || null, JSON.stringify(o.detail || {}), o.at || '2026-09-15 10:00:00');
}

function sitePhoto(id, opts) {
  const o = opts || {};
  eng.db.prepare(
    "INSERT INTO attachments (id, entity_type, entity_id, filename, mime_type, thumb_url, web_url, original_url, tags, uploaded_by, uploaded_at, organization_id, position) VALUES (?, ?, ?, ?, ?, 'https://cdn/t', 'https://cdn/w', 'https://cdn/o', ?, ?, ?, ?, 0)"
  ).run(id, o.entity_type || 'service_ticket', o.entity_id || 'st1', o.filename || (id + '.jpg'), o.mime || 'image/jpeg',
    JSON.stringify(o.tags || []), o.by == null ? null : o.by, o.at || '2026-09-15 10:00:00', o.org == null ? 1 : o.org);
}

describe('insertEvent', () => {
  const broken = {
    query: async () => { const e = new Error('relation "service_ticket_events" is broken'); e.code = '42P01'; throw e; },
  };
  let errSpy;
  beforeEach(() => { errSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { errSpy.mockRestore(); });

  test('strict rethrows; the default logs and carries on', async () => {
    const t = ticket('st1');
    await expect(W.insertEvent(broken, t, 'status_changed', { kind: 'user', userId: 10 }, { from: 'a', to: 'b' }, { strict: true }))
      .rejects.toThrow(/broken/);
    await expect(W.insertEvent(broken, t, 'status_changed', { kind: 'user', userId: 10 }, {})).resolves.toBeUndefined();
    await expect(W.insertEvent(broken, t, 'status_changed', null, {}, { strict: false })).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
  });

  test('it writes the org and the ticket from the ticket row', async () => {
    await W.insertEvent(eng.pool, ticket('st1'), 'note_added', { kind: 'share', shareId: 'sh1', label: 'Marco' }, { photo_count: 2 }, { strict: true });
    expect(eventRows()).toEqual([{ kind: 'note_added', organization_id: 1, detail: { photo_count: 2 } }]);
  });

  test('MUTANT: without the rethrow, a strict insert is swallowed', async () => {
    const M = mutant('    if (opts && opts.strict) throw e;\n', '');
    await expect(M.insertEvent(broken, ticket('st1'), 'status_changed', null, {}, { strict: true })).resolves.toBeUndefined();
  });
});

describe('subtaskCounts', () => {
  test('counts the live org subtasks of this ticket, in this org', async () => {
    expect(await W.subtaskCounts(eng.pool, ticket('st1'))).toEqual({ total: 3, done: 2 });
    expect(await W.subtaskCounts(eng.pool, ticket('st2'))).toEqual({ total: 1, done: 1 });
    expect(await W.subtaskCounts(eng.pool, Object.assign({}, ticket('st1'), { organization_id: 2 }))).toEqual({ total: 1, done: 1 });
  });

  test('no ticket, or no org on it, counts nothing and asks nothing', async () => {
    const before = eng.log.length;
    expect(await W.subtaskCounts(eng.pool, null)).toEqual({ total: 0, done: 0 });
    expect(await W.subtaskCounts(eng.pool, { id: 'st1', organization_id: null })).toEqual({ total: 0, done: 0 });
    expect(eng.log.length).toBe(before);
  });

  test('MUTANT: without the archived filter an archived building counts', async () => {
    const find = "      WHERE service_ticket_id = $1 AND organization_id = $2 AND archived_at IS NULL AND scope = 'org'`,\n    [ticket.id, ticket.organization_id]\n  );\n  const c = r.rows[0] || {};";
    const M = mutant(find, find.replace('AND archived_at IS NULL ', ''));
    expect(await M.subtaskCounts(eng.pool, ticket('st1'))).toEqual({ total: 4, done: 3 });
  });
});

describe('lastStatusEvent', () => {
  test('the newest status_changed row of this ticket and org, with its detail', async () => {
    ev('e1', 1, 'st1', 'status_changed', 'user', { detail: { from: 'open', to: 'in_progress' }, at: '2026-09-15 09:00:00' });
    ev('e2', 1, 'st1', 'status_changed', 'share', { share_id: 'sh1', detail: { from: 'in_progress', to: 'work_complete', reason: 'marked_complete' }, at: '2026-09-15 10:00:00' });
    ev('e3', 1, 'st1', 'note_added', 'share', { share_id: 'sh1', at: '2026-09-15 11:00:00' });
    ev('e4', 1, 'st2', 'status_changed', 'user', { detail: { to: 'cancelled' }, at: '2026-09-15 12:00:00' });
    ev('e5', 2, 'st1', 'status_changed', 'user', { detail: { to: 'approved' }, at: '2026-09-15 13:00:00' });
    const last = await W.lastStatusEvent(eng.pool, ticket('st1'));
    expect(last).toEqual({
      actor_kind: 'share', share_id: 'sh1',
      detail: { from: 'in_progress', to: 'work_complete', reason: 'marked_complete' },
      created_at: '2026-09-15 10:00:00',
    });
    expect(await W.lastStatusEvent(eng.pool, ticket('st2'))).toMatchObject({ detail: { to: 'cancelled' } });
  });

  test('a ticket with no status history has no last event', async () => {
    expect(await W.lastStatusEvent(eng.pool, ticket('st1'))).toBeNull();
  });

  test('MUTANT: without the org predicate the rival org\'s event is read as ours', async () => {
    ev('e2', 1, 'st1', 'status_changed', 'share', { share_id: 'sh1', detail: { to: 'work_complete', reason: 'marked_complete' }, at: '2026-09-15 10:00:00' });
    ev('e5', 2, 'st1', 'status_changed', 'user', { detail: { to: 'approved' }, at: '2026-09-15 13:00:00' });
    const find = "      WHERE ticket_id = $1 AND organization_id = $2 AND kind = 'status_changed'\n      ORDER BY created_at DESC, id DESC LIMIT 1`,";
    const M = mutant(find, find.replace('organization_id = $2', '$2 = $2'));
    expect((await M.lastStatusEvent(eng.pool, ticket('st1'))).detail.to).toBe('approved');
    expect((await W.lastStatusEvent(eng.pool, ticket('st1'))).detail.to).toBe('work_complete');
  });
});

describe('ticketSitePhotos', () => {
  function seedPhotos() {
    sitePhoto('pOffice', { by: 10, at: '2026-09-15 09:00:00' });
    sitePhoto('pCrew', { by: null, at: '2026-09-15 10:00:00' });
    sitePhoto('pAnon', { by: null, at: '2026-09-15 11:00:00' });
    sitePhoto('pFlag', { by: null, tags: ['flag'], at: '2026-09-15 12:00:00' });
    sitePhoto('pDoc', { by: 10, mime: 'application/pdf', at: '2026-09-15 13:00:00' });
    sitePhoto('pTask', { by: 10, entity_type: 'task', entity_id: 't782', at: '2026-09-15 14:00:00' });
    sitePhoto('pRival', { by: 50, org: 2, at: '2026-09-15 15:00:00' });
    sitePhoto('pOther', { by: 10, entity_id: 'st2', at: '2026-09-15 16:00:00' });
    ev('ph1', 1, 'st1', 'photo_added', 'share', { label: 'Marco', share_id: 'sh1', detail: { mime: 'image/jpeg', attachment_id: 'pCrew' } });
    ev('ph2', 2, 'st1', 'photo_added', 'share', { label: 'Rival crew', share_id: 'shx', detail: { mime: 'image/jpeg', attachment_id: 'pAnon' } });
  }

  test('the office read: images on this ticket in this org, newest first, flag photos left out, with names', async () => {
    seedPhotos();
    const photos = await W.ticketSitePhotos(eng.pool, 1, 'st1', { withNames: true });
    expect(photos.map((p) => [p.id, p.by, p.via_link])).toEqual([
      ['pAnon', 'Crew link', true],     // the rival org's event label is not ours to read
      ['pCrew', 'Marco', true],
      ['pOffice', 'Jason Salinas', false],
    ]);
    expect(Object.keys(photos[0]).sort()).toEqual(
      ['by', 'filename', 'id', 'mime_type', 'original_url', 'thumb_url', 'uploaded_at', 'via_link', 'web_url']);
  });

  test('the crew read never names the office', async () => {
    seedPhotos();
    const photos = await W.ticketSitePhotos(eng.pool, 1, 'st1', { withNames: false });
    expect(photos.map((p) => [p.id, p.by])).toEqual([['pAnon', 'Crew link'], ['pCrew', 'Marco'], ['pOffice', 'Office']]);
    expect(JSON.stringify(photos)).not.toMatch(/Jason/);
  });

  test('a rival org with the same ticket id sees only its own photo', async () => {
    seedPhotos();
    const photos = await W.ticketSitePhotos(eng.pool, 2, 'st1', { withNames: true });
    expect(photos.map((p) => [p.id, p.by])).toEqual([['pRival', 'Ray Rival']]);
  });

  test('no org asks nothing and returns nothing', async () => {
    seedPhotos();
    const before = eng.log.length;
    expect(await W.ticketSitePhotos(eng.pool, null, 'st1', { withNames: true })).toEqual([]);
    expect(eng.log.length).toBe(before);
  });

  test('at most 60, even when flag photos crowd the newest rows', async () => {
    for (let i = 0; i < 20; i++) sitePhoto('flag' + i, { by: 10, tags: ['Flag'], at: '2026-09-20 10:' + String(i).padStart(2, '0') + ':00' });
    for (let i = 0; i < 70; i++) sitePhoto('site' + i, { by: 10, at: '2026-09-10 10:' + String(i).padStart(2, '0') + ':00' });
    const photos = await W.ticketSitePhotos(eng.pool, 1, 'st1', {});
    expect(photos.length).toBe(60);
    expect(photos.every((p) => p.id.indexOf('site') === 0)).toBe(true);
    expect(photos[0].id).toBe('site69');
  });

  // 130 flag photos on one ticket is inside what the flag routes allow:
  // FLAG_OPEN_CAP (20) open flags x FLAG_PHOTO_CAP (6) photos is 120 at any one
  // moment, and a RESOLVED flag keeps its photos on the same parent forever.
  // They are all newer than every field-report photo, which is what a ticket
  // looks like after a run of flagged problems.
  const wall = (day, i) => day + ' ' + String(10 + Math.floor(i / 60)).padStart(2, '0') +
    ':' + String(i % 60).padStart(2, '0') + ':00';
  function seedWallOfFlags() {
    for (let i = 0; i < 130; i++) sitePhoto('fl' + i, { by: 10, tags: ['flag'], at: wall('2026-09-20', i) });
    for (let i = 0; i < 70; i++) sitePhoto('site' + i, { by: 10, at: wall('2026-09-10', i) });
  }

  test('a wall of flag photos cannot empty the card: the exclusion is in the WHERE, not after the LIMIT', async () => {
    seedWallOfFlags();
    const photos = await W.ticketSitePhotos(eng.pool, 1, 'st1', {});
    expect(photos.length).toBe(60);
    expect(photos.every((p) => p.id.indexOf('site') === 0)).toBe(true);
    expect(photos[0].id).toBe('site69');
  });

  test('MUTANT: with the flag exclusion out of the WHERE, the LIMIT throws the site photos away and the card is empty', async () => {
    seedWallOfFlags();
    const M = mutant("        AND NOT ($3 = ANY (SELECT jsonb_array_elements_text(tags)))\n",
      '        AND ($3 = $3)\n');
    expect(await M.ticketSitePhotos(eng.pool, 1, 'st1', {})).toEqual([]);
  });

  test('MUTANT: without the org predicate a rival org\'s photo on the same ticket id shows up', async () => {
    seedPhotos();
    const find = "      WHERE a.entity_type = 'service_ticket' AND a.entity_id = $1 AND a.organization_id = $2\n";
    const M = mutant(find, "      WHERE a.entity_type = 'service_ticket' AND a.entity_id = $1 AND $2 = $2\n");
    const ids = (await M.ticketSitePhotos(eng.pool, 1, 'st1', { withNames: true })).map((p) => p.id);
    expect(ids).toContain('pRival');
  });

  test('a hand-typed \'Flag\' is kept out too: the WHERE has the canonical spelling, the JS filter the rest', async () => {
    seedPhotos();
    sitePhoto('pFlagCaps', { by: null, tags: ['Flag'], at: '2026-09-15 12:30:00' });
    const ids = (await W.ticketSitePhotos(eng.pool, 1, 'st1', { withNames: true })).map((p) => p.id);
    expect(ids).not.toContain('pFlag');
    expect(ids).not.toContain('pFlagCaps');
  });

  test('MUTANT: without the JS filter the hand-typed \'Flag\' lands in Site photos', async () => {
    seedPhotos();
    sitePhoto('pFlagCaps', { by: null, tags: ['Flag'], at: '2026-09-15 12:30:00' });
    const M = mutant("    .filter(function (row) { return tagList(row.tags).indexOf('flag') < 0; })\n", '');
    const ids = (await M.ticketSitePhotos(eng.pool, 1, 'st1', { withNames: true })).map((p) => p.id);
    expect(ids).toContain('pFlagCaps');
    // normalizeTagsInput preserves the case a retag typed, so the WHERE alone
    // does not catch it — but the canonical spelling never gets this far.
    expect(ids).not.toContain('pFlag');
  });
});

describe('subtaskActivity', () => {
  test('note ids only when asked; the default output is unchanged', async () => {
    ev('n1', 1, 'st1', 'subtask_note', 'share', { label: 'Marco', detail: { task_id: 't782', note: 'Post rotted' }, at: '2026-09-15 10:00:00' });
    ev('c1', 1, 'st1', 'subtask_completed', 'share', { label: 'Marco', detail: { task_id: 't782' }, at: '2026-09-15 11:00:00' });
    ev('nx', 2, 'st1', 'subtask_note', 'user', { label: 'Rival', detail: { task_id: 't782', note: 'rival note' }, at: '2026-09-15 12:00:00' });
    const plain = await W.subtaskActivity(eng.pool, 1, 'st1');
    expect(plain.get('t782')).toEqual({
      notes: [{ note: 'Post rotted', by: 'Marco', at: '2026-09-15 10:00:00' }],
      completed_by: 'Marco', completed_at: '2026-09-15 11:00:00',
    });
    const withIds = await W.subtaskActivity(eng.pool, 1, 'st1', { withIds: true });
    expect(withIds.get('t782').notes).toEqual([{ id: 'n1', note: 'Post rotted', by: 'Marco', at: '2026-09-15 10:00:00' }]);
  });
});
