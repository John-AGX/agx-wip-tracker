// The sub directory's name uniqueness is per TENANT, not global.
//
// WHAT THIS FILE EXISTS FOR
// `CREATE UNIQUE INDEX idx_subs_name_lower ON subs(lower(name))` was global.
// POST /api/subs catches 23505 and answers 409 "A sub with that name already
// exists", so an org-A admin could learn, one probe per name, exactly which
// companies sit in org B's vendor directory — while every route-level lookup
// around it (sub-routes.js:728, :799) had already been org-scoped, leaving the
// INDEX as the only thing still answering across the boundary.
//
// The leak is the smaller half. The larger half is that two tenants could not
// both carry "ABC Drywall": a hard functional collision on the most
// collision-prone string in a construction directory, with no operator
// resolution. field_tools already got the per-org treatment
// (idx_field_tools_org_name). subs did not.
//
// This is a SCHEMA assertion, so it reads the DDL rather than a live database.
// The properties that matter are structural and checkable that way: which index
// exists, which is gone, that the un-stamped population keeps exactly the
// constraint it has today, and that the two statements are idempotent and in an
// order that cannot fail.

const fs = require('fs');
const path = require('path');

const db = fs.readFileSync(path.join(__dirname, '..', 'server', 'db.js'), 'utf8');

// Statements only — a mention inside a `--` comment must not satisfy any of
// these, or the test passes on prose.
function statements(src) {
  return src
    .split('\n')
    .filter((l) => !/^\s*(--|\/\/|\*)/.test(l))
    .join('\n');
}
const sql = statements(db);

describe('the global unique index is gone', () => {
  test('nothing still CREATEs subs(lower(name)) unqualified', () => {
    expect(sql).not.toMatch(/CREATE UNIQUE INDEX[^;]*idx_subs_name_lower[^;]*ON subs\s*\(\s*lower\(name\)\s*\)/i);
  });

  test('it is explicitly dropped, idempotently', () => {
    expect(sql).toMatch(/DROP INDEX IF EXISTS idx_subs_name_lower/i);
  });
});

describe('the replacement is per-org and does not loosen the legacy population', () => {
  const created = sql.match(/CREATE UNIQUE INDEX IF NOT EXISTS idx_subs_org_name_lower[\s\S]{0,200}?;/i);

  test('it exists and is idempotent', () => {
    expect(created).not.toBeNull();
  });

  test('it is UNIQUE on the org AND the lowercased name', () => {
    expect(created[0]).toMatch(/ON subs\s*\(/i);
    expect(created[0]).toMatch(/organization_id/i);
    expect(created[0]).toMatch(/lower\(name\)/i);
  });

  test('un-stamped rows share ONE namespace — NULLs must not compare as distinct', () => {
    // A plain (organization_id, lower(name)) pair would let unlimited
    // same-named rows exist while organization_id is NULL, which is the whole
    // legacy population until the backfill runs. That would be a LOOSENING
    // shipped as a tightening.
    expect(created[0]).toMatch(/COALESCE\s*\(\s*organization_id\s*,\s*0\s*\)/i);
  });
});

describe('the two statements are in an order that cannot fail', () => {
  test('the new index is created BEFORE the old one is dropped', () => {
    const create = sql.search(/CREATE UNIQUE INDEX IF NOT EXISTS idx_subs_org_name_lower/i);
    const drop = sql.search(/DROP INDEX IF EXISTS idx_subs_name_lower/i);
    expect(create).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(create);
    // The old index is strictly stricter, so any data satisfying it satisfies
    // the new one — the CREATE cannot fail while the old is still in place.
    // Reversing these would open a window where a duplicate could land.
  });

  test('both run after subs and its organization_id column exist', () => {
    const table = sql.search(/CREATE TABLE IF NOT EXISTS subs\s*\(/i);
    const column = sql.search(/ALTER TABLE subs\s+ADD COLUMN IF NOT EXISTS organization_id/i);
    const create = sql.search(/CREATE UNIQUE INDEX IF NOT EXISTS idx_subs_org_name_lower/i);
    expect(table).toBeGreaterThan(-1);
    expect(column).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(table);
    expect(create).toBeGreaterThan(column);
  });
});

describe('the route-level lookups this index sat behind are still org-scoped', () => {
  const subRoutes = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'routes', 'sub-routes.js'), 'utf8');

  test('every lower(name) lookup carries an org term', () => {
    // If one of these ever loses its predicate, the per-org index stops being
    // the last line and the oracle comes back through the dedupe path instead.
    const lookups = subRoutes.match(/lower\(name\)[\s\S]{0,160}/g) || [];
    const sqlLookups = lookups.filter((l) => /WHERE|AND/.test(l));
    expect(sqlLookups.length).toBeGreaterThan(0);
    for (const l of sqlLookups) {
      expect(l).toMatch(/organization_id/);
    }
  });
});
