/* A real SQL engine standing in for Postgres, so a claim about BLAST RADIUS
 * is executed rather than asserted.
 *
 * WHY THIS EXISTS. The findings this file supports are all of the form "an
 * unscoped DELETE removed rows belonging to other tenants". A hand-written
 * fake pool answers that question by whatever its author wrote in the filter
 * callback, which means the test is checking the fake, not the statement. The
 * one thing that must not be mocked here is the WHERE clause. So the SQL the
 * route actually emits is handed to node:sqlite and the rows that survive are
 * counted afterwards.
 *
 * It is a SHIM, not a Postgres. It translates only what these routes emit:
 *   $n            -> ?          (positional parameters)
 *   ::jsonb/::int/::text[]      -> dropped (sqlite is dynamically typed)
 *   NOW()         -> CURRENT_TIMESTAMP
 *   RETURNING     -> supported natively by SQLite 3.35+
 *   ON CONFLICT .. DO UPDATE .. EXCLUDED  -> supported natively
 * Anything it cannot translate throws loudly rather than silently returning
 * `{ rows: [] }`, because a swallowed statement is how a "scoped" DELETE gets
 * a passing test.
 *
 * JSON columns: Postgres hands `jsonb` back as a parsed object and the routes
 * rely on that (`r.rows[0].value.skills`). SQLite hands back the text. Columns
 * named in JSON_COLUMNS are parsed on the way out and stringified on the way
 * in, which is exactly the pg driver's behaviour for those columns.
 */
'use strict';

const { DatabaseSync } = require('node:sqlite');

const JSON_COLUMNS = new Set(['value', 'detail', 'capabilities']);

// Per-engine additions to the set above. `data` is the jsonb blob on jobs /
// estimates / invoices / payments and the routes read it as a PARSED OBJECT
// (`r.data.applications`), so leaving it as text does not fail — it silently
// reads as empty, and a money assertion built on it passes for the wrong
// reason. It is opt-in rather than global so the existing consumers of this
// shim keep exactly the decoding they were written against, and it is held PER
// ENGINE rather than in a module variable — a module variable would be reset
// by the next createPgSqlite() call anywhere in the same test file, which is a
// silent decoding change and therefore a silent assertion change.
const EMPTY = new Set();

function translate(sql) {
  let s = String(sql);

  // The one Postgres JSON idiom these routes use: membership in a jsonb array
  // column. `x = ANY (SELECT jsonb_array_elements_text(col))` becomes sqlite's
  // json_each. Rewritten rather than stubbed out, because the routes that use
  // it are the ones asserting an org admin can still READ their own surface —
  // a query quietly reduced to TRUE would make that assertion meaningless.
  s = s.replace(
    /(\$\d+|\?)(?:::text)?\s*=\s*ANY\s*\(\s*SELECT\s+jsonb_array_elements_text\(\s*([a-z_]+)\s*\)\s*\)/gi,
    (_m, param, col) => 'EXISTS (SELECT 1 FROM json_each(' + col + ') WHERE json_each.value = ' + param + ')'
  );

  // The other direction of the same idiom: `col = ANY($n::text[])`, i.e. "is
  // this column one of the values in the array parameter". The org-tier audit
  // read uses it for its action ALLOWLIST, and the property under test there is
  // that an action NOT on the list is not served — so a rule that quietly
  // reduced this to TRUE would make the assertion meaningless. encodeParam
  // already JSON-stringifies array parameters, which is exactly what json_each
  // wants.
  s = s.replace(
    /([a-z_][a-z_0-9]*(?:\.[a-z_][a-z_0-9]*)?)\s*=\s*ANY\s*\(\s*(\$\d+)(?:::[a-z_]+(?:\[\])?)?\s*\)/gi,
    (_m, col, param) => 'EXISTS (SELECT 1 FROM json_each(' + param + ') WHERE json_each.value = ' + col + ')'
  );

  // Casts. Postgres-only, and meaningless to a dynamically typed engine.
  s = s.replace(/::text\[\]/g, '').replace(/::jsonb/g, '').replace(/::json/g, '')
       .replace(/::int\b/g, '').replace(/::integer\b/g, '').replace(/::text\b/g, '');
  s = s.replace(/\bNOW\(\)/gi, 'CURRENT_TIMESTAMP');

  // `FOR UPDATE` is a ROW-LOCK HINT. It cannot appear in, and cannot change,
  // a WHERE clause — which is the only thing this shim exists to keep honest.
  // Stripping it is the same class of faithful rewrite as NOW() above: the
  // rows the statement selects are identical with and without it. Left in
  // place, sqlite refuses to prepare and the statement throws, which would
  // make every route that reads-then-writes under a lock untestable here —
  // and those are exactly the routes where the tenant predicate goes missing.
  s = s.replace(/\s+FOR\s+UPDATE(\s+(?:NOWAIT|SKIP\s+LOCKED))?\b/gi, '');

  // $1 $2 ... -> ?1 ?2 ... — sqlite's NUMBERED parameters, not anonymous ones,
  // so a statement that uses the same parameter twice (several of these do)
  // binds correctly instead of silently shifting every later argument.
  s = s.replace(/\$(\d+)\b/g, (_m, n) => '?' + n);
  return s;
}

function decodeRow(row, extra) {
  const ex = extra || EMPTY;
  const out = {};
  Object.keys(row).forEach((k) => {
    let v = row[k];
    if ((JSON_COLUMNS.has(k) || ex.has(k)) && typeof v === 'string') {
      try { v = JSON.parse(v); } catch (e) { /* leave the raw text */ }
    }
    out[k] = v;
  });
  return out;
}

function encodeParam(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

function createPgSqlite(schemaSql, opts) {
  const db = new DatabaseSync(':memory:');
  db.exec(schemaSql);
  const extraJson = new Set((opts && opts.jsonColumns) || []);

  // Every statement the routes ran, in order — so a test can assert that a
  // door did NOT reach the database at all, which is a different (and
  // stronger) claim than "no rows changed".
  const log = [];

  function query(sql, params) {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    log.push({ sql: text, params: params || [] });
    const translated = translate(sql);
    const args = (params || []).map(encodeParam);
    let stmt;
    try {
      stmt = db.prepare(translated);
    } catch (e) {
      throw new Error('pg-sqlite could not prepare: ' + translated + '\n  from: ' + text + '\n  ' + e.message);
    }
    const isSelect = /^\s*(SELECT|WITH)/i.test(translated);
    const returning = /\bRETURNING\b/i.test(translated);
    if (isSelect || returning) {
      const rows = stmt.all(...args).map((r) => decodeRow(r, extraJson));
      return { rows, rowCount: rows.length };
    }
    const info = stmt.run(...args);
    return { rows: [], rowCount: Number(info.changes || 0) };
  }

  const pool = {
    query: async (sql, params) => query(sql, params),
    connect: async () => ({
      query: async (sql, params) => query(sql, params),
      release: () => {}
    })
  };

  return {
    pool,
    db,
    log,
    // Synchronous escape hatch for assertions — never used by route code.
    all: (sql, ...args) => db.prepare(sql).all(...args).map((r) => decodeRow(r, extraJson)),
    count: (sql, ...args) => {
      const r = db.prepare(sql).all(...args);
      return r.length;
    },
    reset: (sql) => { db.exec(sql); }
  };
}

module.exports = { createPgSqlite };
