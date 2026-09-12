// A project with photos must never show an empty camera icon.
//
// The Photos grid was mostly placeholders — "Waterside Gazebo · 34 photos"
// rendering the empty-state glyph — because the cover came from ONE source:
// projects.cover_attachment_id, set only by someone opening the project and
// choosing "Set as cover". Every project nobody had curated showed nothing.
//
// The route's comment claimed a safety net that did not exist:
//
//     Cover priority:
//       1. The explicit cover_attachment_id if set (LEFT JOIN cov)
//       2. Falls back client-side to the newest attachment.
//
// js/projects.js read cover_thumb_url and painted a placeholder when it was
// null. There was no step 2 anywhere. This file is step 2, executed rather
// than described — the emitted SQL is run through a real engine against a
// schema derived from server/db.js, because a fallback that cannot be run in a
// test is how the last one stayed fictional for months.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

// The exact subquery the route emits. This used to scrape the function body
// out of project-routes.js and re-evaluate it, which was the right instinct
// — never copy the SQL — but it broke the moment the route stopped owning
// the rule. The cover logic now lives in server/services/photo-cover.js,
// shared with the Jobs and Leads rosters, so the test reads it from there:
// the same function the route calls, not a fragment of it re-evaluated out
// of scope.
const { firstPhotoSql: sharedFirstPhotoSql } = require('../server/services/photo-cover');

function firstPhotoSqlFromRoute(col) {
  return sharedFirstPhotoSql(col, 'project', 'p.id');
}

const SCHEMA = sqliteSchema(['projects', 'attachments'], {
  pk: { projects: 'id', attachments: 'id' }
});

function seed(db) {   // db is the engine; db.pool.query is the pg-shaped door
  db.pool.query('INSERT INTO projects (id, organization_id, name, cover_attachment_id) VALUES ($1,$2,$3,$4)',
    ['proj_auto', 1, 'Waterside Gazebo', null]);
  db.pool.query('INSERT INTO projects (id, organization_id, name, cover_attachment_id) VALUES ($1,$2,$3,$4)',
    ['proj_set', 1, 'Citi Lakes Repaint', 'att_chosen']);
  db.pool.query('INSERT INTO projects (id, organization_id, name, cover_attachment_id) VALUES ($1,$2,$3,$4)',
    ['proj_empty', 1, 'Daily Log', null]);

  const att = (id, project, mime, thumb, takenAt, uploadedAt, markupOf, position) =>
    db.pool.query(
      'INSERT INTO attachments (id, entity_type, entity_id, filename, mime_type, size_bytes, ' +
      'thumb_url, web_url, original_url, thumb_key, web_key, original_key, position, ' +
      'taken_at, uploaded_at, markup_of) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
      [id, 'project', project, id + '.jpg', mime, 100,
       thumb, thumb ? id + '-web' : null, id + '-orig', 'tk', 'wk', 'ok',
       position || 0, takenAt, uploadedAt, markupOf]);

  // proj_auto: three photos. The MIDDLE one was uploaded first but taken last —
  // the fallback must pick by when the shutter fired, not by upload order.
  att('att_second', 'proj_auto', 'image/jpeg', 'SECOND', '2026-08-02T10:00:00Z', '2026-08-01T00:00:00Z', null, 0);
  att('att_first',  'proj_auto', 'image/jpeg', 'FIRST',  '2026-08-01T09:00:00Z', '2026-08-09T00:00:00Z', null, 0);
  att('att_third',  'proj_auto', 'image/jpeg', 'THIRD',  '2026-08-03T10:00:00Z', '2026-08-03T00:00:00Z', null, 0);

  // proj_set has photos too, but somebody chose a cover.
  att('att_chosen', 'proj_set', 'image/jpeg', 'CHOSEN', '2026-08-05T10:00:00Z', '2026-08-05T00:00:00Z', null, 0);
  att('att_other',  'proj_set', 'image/jpeg', 'OTHER',  '2026-08-01T10:00:00Z', '2026-08-01T00:00:00Z', null, 0);
}

function coverQuery() {
  return 'SELECT p.id, ' +
         '  COALESCE(cov.thumb_url, ' + firstPhotoSqlFromRoute('thumb_url') + ') AS cover_thumb_url, ' +
         '  (p.cover_attachment_id IS NULL AND ' + firstPhotoSqlFromRoute('thumb_url') + ' IS NOT NULL) AS cover_is_auto ' +
         '  FROM projects p ' +
         '  LEFT JOIN attachments cov ON cov.id = p.cover_attachment_id ' +
         ' WHERE p.organization_id = $1 ORDER BY p.id';
}

let db;
beforeEach(() => {
  db = createPgSqlite(SCHEMA, { dateColumns: ['taken_at', 'uploaded_at'] });
  seed(db);
});

async function covers() {
  const { rows } = await db.pool.query(coverQuery(), [1]);
  const out = {};
  for (const r of rows) out[r.id] = r;
  return out;
}

describe('cover falls back to the first photo taken', () => {
  test('a project with photos and no chosen cover gets one', async () => {
    const c = await covers();
    expect(c.proj_auto.cover_thumb_url).not.toBeNull();
  });

  test('it is the FIRST photo TAKEN, not the first uploaded', async () => {
    // att_first was uploaded LAST (2026-08-09) and shot FIRST (2026-08-01).
    // Ordering by uploaded_at would pick att_second and look perfectly
    // reasonable — which is why this fixture exists.
    const c = await covers();
    expect(c.proj_auto.cover_thumb_url).toBe('FIRST');
  });

  test('an explicitly chosen cover still wins over the first photo', async () => {
    // proj_set's earliest photo is att_other; somebody picked att_chosen.
    const c = await covers();
    expect(c.proj_set.cover_thumb_url).toBe('CHOSEN');
  });

  test('cover_is_auto distinguishes a fallback from a deliberate choice', async () => {
    const c = await covers();
    expect(String(c.proj_auto.cover_is_auto)).toMatch(/^(1|true)$/);
    expect(String(c.proj_set.cover_is_auto)).toMatch(/^(0|false)$/);
  });

  test('a project with no photos still has no cover — nothing is invented', async () => {
    const c = await covers();
    expect(c.proj_empty.cover_thumb_url == null).toBe(true);
    expect(String(c.proj_empty.cover_is_auto)).toMatch(/^(0|false)$/);
  });
});

describe('what is NOT eligible to become a cover', () => {
  test('a PDF is never chosen, even when it is the oldest attachment', async () => {
    await db.pool.query(
      'INSERT INTO attachments (id, entity_type, entity_id, filename, mime_type, size_bytes, ' +
      'thumb_url, web_url, original_url, thumb_key, web_key, original_key, position, taken_at, uploaded_at, markup_of) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
      ['att_pdf', 'project', 'proj_auto', 'scope.pdf', 'application/pdf', 100,
       'PDFTHUMB', 'w', 'o', 'tk', 'wk', 'ok', 0, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z', null]);
    const c = await covers();
    expect(c.proj_auto.cover_thumb_url).toBe('FIRST');
  });

  test('a markup is never chosen — it is a drawing OF the site, not the site', async () => {
    await db.pool.query(
      'INSERT INTO attachments (id, entity_type, entity_id, filename, mime_type, size_bytes, ' +
      'thumb_url, web_url, original_url, thumb_key, web_key, original_key, position, taken_at, uploaded_at, markup_of) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
      ['att_markup', 'project', 'proj_auto', 'marked.jpg', 'image/jpeg', 100,
       'MARKUP', 'w', 'o', 'tk', 'wk', 'ok', 0, '2019-01-01T00:00:00Z', '2019-01-01T00:00:00Z', 'att_first']);
    const c = await covers();
    expect(c.proj_auto.cover_thumb_url).toBe('FIRST');
  });

  test('an image with no thumbnail yet is skipped rather than shown broken', async () => {
    await db.pool.query(
      'INSERT INTO attachments (id, entity_type, entity_id, filename, mime_type, size_bytes, ' +
      'thumb_url, web_url, original_url, thumb_key, web_key, original_key, position, taken_at, uploaded_at, markup_of) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
      ['att_nothumb', 'project', 'proj_auto', 'raw.jpg', 'image/jpeg', 100,
       null, 'w', 'o', 'tk', 'wk', 'ok', 0, '2018-01-01T00:00:00Z', '2018-01-01T00:00:00Z', null]);
    const c = await covers();
    expect(c.proj_auto.cover_thumb_url).toBe('FIRST');
  });

  test('another project\'s photo is never borrowed', async () => {
    // proj_empty has none of its own and must stay empty even though the org
    // has older photos elsewhere. The correlation is on entity_id.
    const c = await covers();
    expect(c.proj_empty.cover_thumb_url == null).toBe(true);
  });
});

describe('the photo with no EXIF date still counts', () => {
  test('taken_at null falls back to uploaded_at rather than dropping out', async () => {
    // Most phone uploads carry EXIF; a screenshot or a re-saved image does not.
    // Treating null as "no date" would make such a photo invisible to the
    // fallback, so a project holding only those would show a placeholder.
    await db.pool.query('DELETE FROM attachments WHERE entity_id = $1', ['proj_auto']);
    await db.pool.query(
      'INSERT INTO attachments (id, entity_type, entity_id, filename, mime_type, size_bytes, ' +
      'thumb_url, web_url, original_url, thumb_key, web_key, original_key, position, taken_at, uploaded_at, markup_of) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
      ['att_noexif', 'project', 'proj_auto', 'shot.jpg', 'image/jpeg', 100,
       'NOEXIF', 'w', 'o', 'tk', 'wk', 'ok', 0, null, '2026-08-04T00:00:00Z', null]);
    const c = await covers();
    expect(c.proj_auto.cover_thumb_url).toBe('NOEXIF');
  });
});
