/* ──────────────────────────────────────────────────────────────────────────
 * "Entity — recent jobs" WAS NOT RECENT, AND NOT EVEN A CHOICE.
 *
 * The admin prompt-preview picker (js/admin.js, populateEntityList) sorted the
 * jobs it offers with `(b.updated_at || '').localeCompare(a.updated_at || '')`.
 * GET /api/jobs does not send `updated_at`. It sends the row's updated_at as
 * `_updatedAt`, because the blob is spread first and a blob copy would shadow
 * the column (server/routes/job-routes.js). So every key was '', every pair
 * compared equal, and the sort was a no-op: the list came out in Postgres heap
 * order, which has no ORDER BY behind it.
 *
 * That is worse than a wrong order, because the very next line is
 * `rows.slice(0, 80)`. On an org with ~700 jobs the picker offered an
 * arbitrary 80 of them, and the job an admin wanted was usually not among
 * them — under a label that says "recent jobs".
 *
 * Jobs are the odd one out here, which is how it survived: estimates, change
 * orders and purchase orders all send a real `updated_at` column, and the
 * sorts beside this one that read it are correct. Those are pinned below too,
 * so "fix them all the same way" stays wrong on purpose.
 *
 * The comparator is LIFTED out of js/admin.js and run — not modelled.
 * ────────────────────────────────────────────────────────────────────────── */
'use strict';

const fs = require('fs');
const path = require('path');
const { extractFunction, compile } = require('./helpers/browser-fn');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const ADMIN = read('js/admin.js');

const byRecency = compile(
  [extractFunction(ADMIN, 'jobRecencyKey'), extractFunction(ADMIN, 'jobsByRecency')],
  [], [], 'jobsByRecency'
);
const keyOf = compile([extractFunction(ADMIN, 'jobRecencyKey')], [], [], 'jobRecencyKey');

// Exactly the shape GET /api/jobs hands the client: `_updatedAt` as an ISO
// string, and NO `updated_at` anywhere. Deliberately out of order, so a sort
// that ties every pair (the defect) leaves them as written and fails.
const API_ROWS = [
  { id: 'mid', title: 'Westshore Plaza', _updatedAt: '2026-06-01T12:00:00.000Z' },
  { id: 'newest', title: 'Harbor Pointe', _updatedAt: '2026-09-28T19:00:00.000Z' },
  { id: 'oldest', title: 'Bayside Terrace', _updatedAt: '2025-03-04T14:00:00.000Z' },
];
const ids = (rows) => rows.slice().sort(byRecency).map((r) => r.id);

describe('the key the picker reads', () => {
  test('is _updatedAt — the one the API actually sends', () => {
    expect(keyOf({ _updatedAt: '2026-09-28T19:00:00.000Z' })).toBe('2026-09-28T19:00:00.000Z');
  });

  test('falls back to the blob stamp when the row has no server version', () => {
    // jobs.updated_at is nullable, so _updatedAt can legitimately be null.
    expect(keyOf({ _updatedAt: null, updatedAt: '2026-05-05T00:00:00.000Z' })).toBe('2026-05-05T00:00:00.000Z');
    expect(keyOf({ _updatedAt: '2026-09-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' })).toBe('2026-09-01T00:00:00.000Z');
  });

  test('a job with neither sorts last, and does not throw', () => {
    expect(keyOf({})).toBe('');
    expect(keyOf(null)).toBe('');
    expect(ids([{ id: 'none' }].concat(API_ROWS))).toEqual(['newest', 'mid', 'oldest', 'none']);
  });

  test('it does NOT read updated_at — a row carrying only that sorts as unknown', () => {
    // The defect's key. If someone puts it back, this is the row that proves
    // the picker is reading a key the jobs API never sends.
    expect(keyOf({ updated_at: '2026-09-28T19:00:00.000Z' })).toBe('');
  });
});

describe('the picker orders newest first', () => {
  test('on rows shaped exactly like GET /api/jobs', () => {
    expect(ids(API_ROWS)).toEqual(['newest', 'mid', 'oldest']);
  });

  test('and the cap keeps the newest, because the sort runs BEFORE the slice', () => {
    // The 80-row cap is what turned a wrong order into a job you cannot pick.
    const i = ADMIN.indexOf('rows.sort(jobsByRecency);');
    const j = ADMIN.indexOf('rows = rows.slice(0, 80);', i);
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
  });
});

describe('why the sibling lists were left alone', () => {
  test('GET /api/jobs sends _updatedAt and never updated_at', () => {
    const src = read('server/routes/job-routes.js');
    const i = src.indexOf('const result = rows.map(j => {');
    const j = src.indexOf('res.json({ jobs: result })', i);
    expect(i).toBeGreaterThan(-1);
    const shape = src.slice(i, j);
    expect(shape).toContain('_updatedAt: j.updated_at');
    expect(shape).not.toMatch(/(^|[^_\w])updated_at:/);
  });

  test.each([
    ['server/routes/estimate-routes.js'],
    ['server/routes/change-order-routes.js'],
    ['server/routes/purchase-order-routes.js'],
  ])('%s DOES send a real updated_at, so its own sorts stay as they are', (file) => {
    expect(read(file)).toMatch(/updated_at: r\.updated_at/);
  });

  test('the two estimate pickers in admin.js still sort on updated_at', () => {
    expect((ADMIN.match(/localeCompare\(a\.updated_at \|\| ''\)/g) || []).length).toBe(2);
  });
});
