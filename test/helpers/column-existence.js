// DOES THE COLUMN THIS STATEMENT NAMES ACTUALLY EXIST?
//
// The companion to test/helpers/db-schema.js. That file answers "what does
// server/db.js create"; this one asks the question the other way round — for
// every statement in a source file, is every column it names one that db.js
// creates? A `no` is a 42703 at runtime: the statement does not return the
// wrong rows, it THROWS, and every caller above it sees a 500 or a swallowed
// catch.
//
// This is not a hypothetical. `search_my_kb` and `search_org_kb` both ordered
// by `attachments.created_at`, a column server/db.js has never created
// (`uploaded_at` is the real one), so BOTH tools raised 42703 on every call —
// and the parent-anchor tenant ladder inside search_org_kb, shipped in
// a4d2cd85 as a security fix, had therefore never executed in production. The
// suite was green because the test fixture hand-declared the column.
//
// ── HOW IT STAYS HONEST ───────────────────────────────────────────────────
// A scanner that guesses is worse than none, so this one refuses rather than
// guesses. A statement is SKIPPED — reported as unjudgeable, never as clean —
// when:
//   • its argument is interpolated (`${…}`), so the text is not final;
//   • any FROM / JOIN / UPDATE / INTO / USING names something db.js does not
//     create (a CTE, a set-returning function, a table from another schema);
//   • it declares a CTE at all, since a CTE name is a table this cannot resolve.
// Bare (unqualified) identifiers are judged ONLY in single-table statements,
// where there is exactly one place a bare name can come from. In a multi-table
// statement only `alias.column` is judged, because a bare name there could
// belong to any of the joined tables.
//
// Output aliases are collected first (`… AS total`, and the trailing-identifier
// form `COUNT(*) c`) and excluded everywhere, since `ORDER BY total` names a
// result column and not a table column.
'use strict';

const fs = require('fs');
const path = require('path');
// extractSqlCalls, NOT extractQueryCalls. The ledger IS the count, and a
// ledger that undercounts is worse than none — `.query(` misses every
// statement handed to a wrapper, and this repo has three of those running 66
// statements between them (`safeCount` in org-manifest-routes.js,
// `countOrNull` in admin-push-routes.js, and `run = q(client)` in
// services/email-folders.js), two of which SWALLOW the error a missing column
// raises. The re-derivation is mechanical rather than a patched-in extra
// entry, because the entry that was missing was missing for a structural
// reason and the next one would be too. See the header over extractSqlCalls
// in ./sql-literals.js.
const { extractSqlCalls } = require('./sql-literals');
const schema = require('./db-schema');

// Reserved words and built-ins that can appear where an identifier would.
const SQL_WORDS = new Set((`
select from where and or not in is null as on join left right full inner outer
cross group by order limit offset having union all distinct case when then else
end asc desc count sum avg min max coalesce nullif cast exists any some between
like ilike similar to insert into values update set delete returning conflict do
nothing excluded with recursive over partition row_number rank dense_rank lateral
using natural true false unknown interval extract now current_timestamp
current_date current_user substr substring position length lower upper trim
concat array unnest jsonb json to_char to_number to_jsonb jsonb_agg json_agg
jsonb_set jsonb_build_object json_build_object jsonb_array_elements
jsonb_array_elements_text json_each greatest least filter within nulls first last
for share of no key text integer bigint boolean numeric date timestamp
timestamptz float real int smallint char varchar uuid interval abs round floor
ceil nullif date_trunc age justify_hours string_agg regexp_replace split_part
md5 encode decode gen_random_uuid statement only default constraint primary
foreign references cascade restrict exclude at time zone local
`).trim().split(/\s+/));

// Blank every single-quoted SQL literal, keeping length so offsets hold.
// Without this, `INTERVAL '90 days'`, `jsonb_set(…, '{clientId}', …)`,
// `to_char(d, 'YYYY-MM-DD')` and `co_number ~ '^CO-[0-9]+$'` all read as
// column references and the scan drowns in its own noise — at which point
// somebody turns it off, which is the real failure.
function blankLiterals(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === "'") {
      // The escape-string prefix in E'...' is part of the literal, not an alias.
      if (out.length && /[Ee]$/.test(out) && !/[\w$][Ee]$/.test(out)) out = out.slice(0, -1) + ' ';
      out += ' ';
      i++;
      while (i < sql.length) {
        if (sql[i] === '\\') { out += '  '; i += 2; continue; }   // E'\n' form
        if (sql[i] === "'" && sql[i + 1] === "'") { out += '  '; i += 2; continue; }
        if (sql[i] === "'") { out += ' '; i++; break; }
        out += (sql[i] === '\n' ? '\n' : ' ');
        i++;
      }
      continue;
    }
    out += sql[i];
    i++;
  }
  return out;
}

// Blank `${…}` spans, keeping length. Balanced so a substitution containing
// braces (`${x ? 'a' : '{b}'}`) is consumed whole.
function blankInterpolations(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === '$' && sql[i + 1] === '{') {
      let depth = 1;
      out += '  ';
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === '{') depth++;
        else if (sql[i] === '}') depth--;
        out += (sql[i] === '\n' ? '\n' : ' ');
        i++;
      }
      continue;
    }
    out += sql[i];
    i++;
  }
  return out;
}

function tablesIn(sql) {
  const map = new Map();
  const tables = [];
  const re = /\b(?:FROM|JOIN|UPDATE|INTO|USING)\s+(?:ONLY\s+)?([a-z_][a-z0-9_]*)\s*(?:(?:AS\s+)?([a-z_][a-z0-9_]*))?/gi;
  let m;
  while ((m = re.exec(sql))) {
    const t = m[1].toLowerCase();
    if (SQL_WORDS.has(t)) continue;             // e.g. `INSERT INTO … SELECT`
    if (!schema.hasTable(t)) return null;       // unresolvable — skip the statement
    tables.push(t);
    let alias = (m[2] || '').toLowerCase();
    if (SQL_WORDS.has(alias)) alias = '';
    if (alias) map.set(alias, t);
    map.set(t, t);
  }
  if (!tables.length) return null;
  return { map, tables: [...new Set(tables)] };
}

function aliasesIn(sql) {
  const out = new Set();
  let m;
  // Three alias forms, all of which name a RESULT and not a table column:
  //   `… AS total`          explicit
  //   `COUNT(*)::int c`     trailing, no AS — and `) t` on a derived table
  //   `FROM unnest($1) m`   a set-returning function's alias
  for (const re of [
    /\bAS\s+([a-z_][a-z0-9_]*)/gi,
    /\)\s*(?:AS\s+)?([a-z_][a-z0-9_]*)/gi,
    /::\s*[a-z_][a-z0-9_]*(?:\[\])?\s+([a-z_][a-z0-9_]*)/gi,
  ]) {
    while ((m = re.exec(sql))) { const a = m[1].toLowerCase(); if (!SQL_WORDS.has(a)) out.add(a); }
  }
  return out;
}

// Findings for one file, relative to `repo`.
function scanFile(repo, rel) {
  return scanText(fs.readFileSync(path.join(repo, rel), 'utf8'), rel);
}

// The same scan over source held in memory, so the scanner can be shown a
// statement with a KNOWN defect and asserted to report it. Without this the
// ledger's derivation could be narrowed back to `<x>.query(` and every
// assertion over it would still pass by finding nothing — which is the exact
// failure mode this whole family of tests exists to refuse.
function scanText(text, rel) {
  let calls;
  try { calls = extractSqlCalls(text); } catch (e) { return []; }
  const out = [];
  for (const c of calls) {
    if (!c.sql || !/\S/.test(c.sql)) continue;
    // AN INTERPOLATED STATEMENT IS JUDGED ON WHAT IS STILL VISIBLE, not
    // dropped. `${…}` spans are blanked and the rest is scanned. Skipping the
    // whole statement is how search_org_kb's `ORDER BY a.created_at` would have
    // stayed invisible — its predicate is assembled with `${entityTypeWhere}`,
    // so a scan that abandons interpolated text would miss the very statement
    // this helper was written for. What is INSIDE the interpolation stays
    // unjudged; that is a smaller gap than the whole statement, and it is
    // recorded on the finding rather than glossed.
    const sql = blankLiterals(blankInterpolations(c.sql));
    if (/\bWITH\b[\s\S]*?\bAS\s*\(/i.test(sql)) continue;   // CTE names are not tables
    const info = tablesIn(sql);
    if (!info) continue;
    const alias = aliasesIn(sql);
    const seen = new Set();
    const push = (table, col, bare) => {
      const key = table + '.' + col;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        file: rel, line: c.line, table, column: col, bare: !!bare, key,
        head: c.sql.replace(/\s+/g, ' ').trim().slice(0, 120),
      });
    };

    // qualified: alias.column
    let m;
    const qref = /\b([a-z_][a-z0-9_]*)\s*\.\s*([a-z_][a-z0-9_]*)\b/gi;
    while ((m = qref.exec(sql))) {
      const t = info.map.get(m[1].toLowerCase());
      if (!t) continue;
      const col = m[2].toLowerCase();
      const cols = schema.columnsFor(t);
      if (cols && !cols.has(col)) push(t, col, false);
    }

    // bare identifiers, single-table statements only
    if (info.tables.length === 1) {
      const t = info.tables[0];
      const cols = schema.columnsFor(t);
      const bare = /(^|[^.\w$'"])([a-z_][a-z0-9_]*)/gi;
      while ((m = bare.exec(sql))) {
        const col = m[2].toLowerCase();
        const at = m.index + m[1].length;
        if (SQL_WORDS.has(col)) continue;
        if (alias.has(col)) continue;
        if (info.map.has(col)) continue;
        if (cols.has(col)) continue;
        if (sql[at + col.length] === '(') continue;                 // function call
        if (sql[at + col.length] === '.') continue;                 // a table alias (`p.*`)
        if (/\bAS\s*$/i.test(sql.slice(Math.max(0, at - 4), at))) continue;
        // a ->> / -> json path key is quoted, so it never reaches here
        push(t, col, true);
      }
    }
  }
  return out;
}

module.exports = { scanFile, scanText, tablesIn, aliasesIn, SQL_WORDS };
