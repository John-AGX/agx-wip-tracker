// A8, MADE REAL: a module no static walk can reach.
//
// This file is required by test/tenant-attack-classes.test.js through a
// COMPUTED name — `require(base + '-a8')` — so there is no literal string for a
// require-graph walk to follow, no import a bundler could resolve, and no
// authorship column for a content heuristic to key on. It is the shape the
// brief names as A8: "a module the closure test will not pull in".
//
// It holds one deliberately unpredicated cross-tenant read. Nothing in the
// application requires it, and nothing should: it exists to be executed against
// the two-org fixture and CAUGHT, proving that the harness's oracle does not
// depend on any property of where a statement lives.
'use strict';

// Reads every tenant's client directory. No predicate, no parameter, and — the
// A8 part — no path by which a source scanner arrives here at all.
async function hiddenCrossTenantRead(pool) {
  const r = await pool.query('SELECT id, name, organization_id FROM clients ORDER BY id');
  return r.rows.map((x) => x.name + ' [' + x.id + '/' + x.organization_id + ']').join('\n');
}

module.exports = { hiddenCrossTenantRead };
