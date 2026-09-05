// THE SCHEMA A TEST FIXTURE IS ALLOWED TO HAVE IS THE ONE server/db.js WRITES.
//
// WHY THIS FILE EXISTS
// `attachments` has no `created_at`. server/db.js:1239 declares
// `uploaded_at TIMESTAMPTZ DEFAULT NOW()` and no ALTER anywhere adds the other
// name. Two shipped agent tools — search_my_kb and search_org_kb — selected and
// ORDER BY'd `created_at` on that table, so both raised 42703 the moment a
// caller used them. The parent-anchor ladder in search_org_kb, which shipped as
// the fix for a cross-tenant read, HAD NEVER EXECUTED IN PRODUCTION.
//
// The suite was green the whole time, because
// test/ai-read-tenant-doors.test.js's fixture HAND-DECLARED the column:
//
//     CREATE TABLE attachments (
//       ... uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP,
//           created_at  TEXT DEFAULT CURRENT_TIMESTAMP   <- invented here
//     );
//
// A hand-written fixture is a SECOND schema. It drifts, and when it drifts it
// drifts TOWARD whatever the code under test happens to ask for — the author
// adds the column that made the test stop failing. At that point the test is no
// longer evidence about production; it is evidence about the fixture. That is
// the class this file kills, not the single instance.
//
// WHAT IT DOES
//   tableColumns()      parse server/db.js -> { table: Map(column -> type) },
//                       following CREATE TABLE bodies, ALTER ... ADD COLUMN
//                       (with or without IF NOT EXISTS, including the two
//                       wrapped in a DO $$ information_schema guard) and
//                       ALTER ... DROP COLUMN.
//   sqliteSchema(names) emit CREATE TABLE statements for those tables, in
//                       SQLite dialect, from the DERIVED column list. A fixture
//                       built from this cannot invent a column, because it
//                       never types one.
//   inventedColumns(sql) the property, for a fixture that must stay
//                       hand-written: every column it declares on a table
//                       db.js also creates has to exist in db.js.
//
// WHAT IT DELIBERATELY DOES NOT DO
// It does not reproduce Postgres types, constraints, defaults or indexes. The
// question it answers is "does this column EXIST", which is the question 42703
// asks. Types are mapped to the loose set node:sqlite accepts (see
// toSqliteType) and every column is nullable, because a fixture asserting a
// NOT NULL that production does not have is its own kind of lie and not the one
// this pass is chartered to fix.
'use strict';

const fs = require('fs');
const path = require('path');

const DB_JS = path.resolve(__dirname, '..', '..', 'server', 'db.js');

// Strip SQL `--` line comments and JS `//` line comments. db.js keeps its DDL
// in template literals whose commentary is `--`, and a commented-out
// `ALTER TABLE ... ADD COLUMN` must not read as a column that exists. Quotes
// are respected so a literal containing `--` cannot eat a line. Newlines are
// preserved so line numbers still line up for diagnostics.
function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    if (quote) {
      out += c;
      if (c === '\\') { out += (src[i + 1] || ''); i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    // COMMENT BEFORE QUOTE, and this order is the whole correctness of the
    // pass. db.js is 6,142 lines of prose commentary containing apostrophes
    // ("the client's address", "whose row is this"). Opening a string on one of
    // those swallows every `--` until the next apostrophe, and the DDL inside
    // that span reads as a string literal: the first version of this function
    // derived `leads` as five columns including a phantom named `so`, taken out
    // of the middle of the word "also". A scanner that mis-parses in the
    // permissive direction is the exact failure this file exists to end.
    if ((c === '-' && src[i + 1] === '-') || (c === '/' && src[i + 1] === '/')) {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    // A BACKTICK IS NOT A STRING HERE. Every statement in db.js lives inside a
    // JS template literal, and the SQL commentary inside it is `--`. Treating
    // the opening backtick as a quote puts the whole schema inside a "string",
    // so no `--` is ever stripped and the prose is parsed as DDL — which is how
    // the first version of this derived `leads` without city / state / zip /
    // status. The comment syntaxes are stripped uniformly, JS and SQL alike,
    // and only ' and " open a literal.
    if (c === "'" || c === '"') { quote = c; out += c; i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++; }
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// Top-level comma split inside a CREATE TABLE body.
function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let cur = '';
  let quote = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) { cur += c; if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

// Table-level constraint keywords — these clauses are not columns.
const NOT_A_COLUMN = new Set([
  'primary', 'unique', 'foreign', 'check', 'constraint', 'exclude', 'like', 'inherits',
]);

// Read the balanced body of a `(` that starts at `open` (index of the char
// AFTER the paren). Returns { body, end }.
function balanced(src, open) {
  let i = open;
  let depth = 1;
  let quote = null;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (quote) { if (c === quote) quote = null; i++; continue; }
    if (c === "'" || c === '"') { quote = c; i++; continue; }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    i++;
  }
  return { body: src.slice(open, i - 1), end: i };
}

let CACHE = null;

function tableColumns() {
  if (CACHE) return CACHE;
  const src = stripComments(fs.readFileSync(DB_JS, 'utf8'));
  const tables = new Map();   // name -> Map(col -> type)
  const order = new Map();    // name -> [col]

  const add = (t, col, type) => {
    const key = t.toLowerCase();
    if (!tables.has(key)) { tables.set(key, new Map()); order.set(key, []); }
    const m = tables.get(key);
    if (!m.has(col)) order.get(key).push(col);
    else return;                       // first declaration wins; ADDs are idempotent
    m.set(col, type);
  };

  // -- CREATE TABLE [IF NOT EXISTS] <name> ( ... );
  const ctRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_][\w]*)\s*\(/gi;
  let m;
  while ((m = ctRe.exec(src))) {
    const name = m[1];
    const { body } = balanced(src, ctRe.lastIndex);
    for (const part of splitTopLevel(body)) {
      const t = part.trim();
      if (!t) continue;
      const first = (t.match(/^([a-zA-Z_][\w]*)/) || [])[1];
      if (!first) continue;
      if (NOT_A_COLUMN.has(first.toLowerCase())) continue;
      add(name, first.toLowerCase(), t.slice(first.length).trim());
    }
  }

  // -- ALTER TABLE <name> ADD COLUMN [IF NOT EXISTS] <col> <type...>
  // Covers the bare form (the two inside DO $$ information_schema guards) as
  // well as the idempotent one.
  const acRe = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-zA-Z_][\w]*)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_][\w]*)\s+([^;,\n]*)/gi;
  while ((m = acRe.exec(src))) add(m[1], m[2].toLowerCase(), m[3].trim());

  // -- ALTER TABLE <name> DROP COLUMN [IF EXISTS] <col>
  const dcRe = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-zA-Z_][\w]*)\s+DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?([a-zA-Z_][\w]*)/gi;
  while ((m = dcRe.exec(src))) {
    const key = m[1].toLowerCase();
    const col = m[2].toLowerCase();
    if (tables.has(key)) {
      tables.get(key).delete(col);
      order.set(key, order.get(key).filter((c) => c !== col));
    }
  }

  CACHE = { tables, order };
  return CACHE;
}

function columnsFor(table) {
  const { tables } = tableColumns();
  const m = tables.get(String(table).toLowerCase());
  return m ? new Set(m.keys()) : null;
}

function hasTable(table) {
  return tableColumns().tables.has(String(table).toLowerCase());
}

function tableNames() {
  return [...tableColumns().tables.keys()].sort();
}

// Postgres types the shim's engine has to survive. node:sqlite is dynamically
// typed, so this only has to be a token it will parse.
function toSqliteType(pgType) {
  const t = String(pgType || '').toUpperCase();
  if (/\bBIGSERIAL\b|\bSERIAL\b/.test(t)) return 'INTEGER';
  if (/\bBOOLEAN\b/.test(t)) return 'INTEGER';
  if (/\bJSONB?\b/.test(t)) return 'TEXT';
  if (/\bTIMESTAMPTZ\b|\bTIMESTAMP\b|\bDATE\b|\bTIME\b/.test(t)) return 'TEXT';
  if (/\bNUMERIC\b|\bDECIMAL\b|\bREAL\b|\bDOUBLE\b|\bFLOAT\b/.test(t)) return 'REAL';
  if (/\bINTEGER\b|\bBIGINT\b|\bSMALLINT\b|\bINT\b/.test(t)) return 'INTEGER';
  return 'TEXT';
}

// Emit SQLite DDL for the named tables, from the DERIVED columns.
// `pk` optionally names the primary-key column per table; everything else is
// nullable on purpose — see the header. `extraColumns` is for a column a test
// genuinely owns (a scratch marker), and it is spelled out at the call site so
// it can never be mistaken for something db.js creates.
function sqliteSchema(names, opts) {
  const { tables, order } = tableColumns();
  const pk = (opts && opts.pk) || {};
  const extra = (opts && opts.extraColumns) || {};
  const out = [];
  for (const name of names) {
    const key = String(name).toLowerCase();
    const cols = tables.get(key);
    if (!cols) throw new Error('db-schema: server/db.js does not create table "' + name + '"');
    const defs = [];
    for (const col of order.get(key)) {
      const type = toSqliteType(cols.get(col));
      if (pk[key] === col) defs.push(col + ' ' + type + ' PRIMARY KEY');
      else defs.push(col + ' ' + type);
    }
    for (const [col, type] of Object.entries(extra[key] || {})) defs.push(col + ' ' + type);
    out.push('CREATE TABLE ' + key + ' (\n  ' + defs.join(',\n  ') + '\n);');
  }
  return out.join('\n');
}

// THE PROPERTY, for a fixture that stays hand-written.
// Returns [{ table, column }] for every column the fixture declares on a table
// db.js also creates, that db.js does not create. Tables db.js does not know
// about (a test-only scratch table) are ignored — this asserts AGREEMENT, not
// coverage.
function inventedColumns(fixtureSql) {
  const src = stripComments(String(fixtureSql));
  const found = [];
  const ctRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_][\w]*)\s*\(/gi;
  let m;
  while ((m = ctRe.exec(src))) {
    const name = m[1].toLowerCase();
    const { body } = balanced(src, ctRe.lastIndex);
    const real = columnsFor(name);
    if (!real) continue;   // test-only table — not a divergence
    for (const part of splitTopLevel(body)) {
      const t = part.trim();
      if (!t) continue;
      const first = (t.match(/^([a-zA-Z_][\w]*)/) || [])[1];
      if (!first || NOT_A_COLUMN.has(first.toLowerCase())) continue;
      if (!real.has(first.toLowerCase())) found.push({ table: name, column: first.toLowerCase() });
    }
  }
  return found;
}

module.exports = {
  tableColumns, columnsFor, hasTable, tableNames,
  sqliteSchema, toSqliteType, inventedColumns, stripComments,
};
