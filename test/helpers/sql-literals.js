/* Pull the SQL out of a JavaScript source file, honestly.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A REGEX.
 * The tenant-predicate invariant (test/org-write-predicate-invariant.test.js)
 * is only worth anything if it SEES every statement. The first version of that
 * scan guessed a statement's boundaries by searching backwards for the nearest
 * quote character — which lands inside the statement whenever the SQL itself
 * contains an apostrophe (`'{}'::jsonb`, `status = 'sent'`, `'__section_header__'`
 * — i.e. most of them). It found 23 of the 51 upserts in server/ and reported
 * the rest as absent rather than as unchecked.
 *
 * That is the exact failure mode this whole line of work exists to answer: a
 * scan that misses is worse than no scan, because it reports green. So the
 * file is TOKENIZED — comments, the three string forms, and template
 * substitutions — and the statements come out of the token stream rather than
 * out of a lookbehind.
 *
 * What a caller gets per literal:
 *   sql       the literal's contents with SQL `--` comments blanked out, so a
 *             predicate NAMED IN A COMMENT cannot be mistaken for one that is
 *             actually in the WHERE clause. (The bug this suite was written
 *             for is a statement that mentions organization_id on the INSERT
 *             arm and predicates on nothing.)
 *   raw       the literal's contents untouched, `${...}` included — a caller
 *             that wants to know whether a predicate was INTERPOLATED (the
 *             orgPred()/parentJobInOrgSql() helper style) reads this.
 *   trailing  the ~200 source characters that follow the literal, so a
 *             predicate concatenated on AFTER the string (`'… WHERE ' +
 *             orgPred(x)`) is still visible.
 *   line      1-based line number the literal starts on.
 */
'use strict';

const PRE_REGEX = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

function extractSqlLiterals(text) {
  const out = [];
  let i = 0;
  const n = text.length;
  let lastSignificant = '';

  function lineAt(idx) {
    let line = 1;
    for (let k = 0; k < idx && k < n; k++) if (text[k] === '\n') line++;
    return line;
  }

  while (i < n) {
    const c = text[i];

    // line comment
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    // block comment
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // regex literal — only where a regex can legally start. Getting this wrong
    // would desynchronise the quote tracking, so the heuristic is the
    // conservative one: a `/` only opens a regex directly after an operator or
    // an opening bracket, never after an identifier, number, or closing paren.
    if (c === '/' && (lastSignificant === '' || PRE_REGEX.has(lastSignificant))) {
      let j = i + 1, inClass = false, closed = false;
      while (j < n) {
        const d = text[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '\n') break;               // unterminated — not a regex
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { closed = true; j++; break; }
        j++;
      }
      if (closed) { i = j; lastSignificant = '/'; continue; }
      // fall through and treat as a division operator
    }

    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      const start = i + 1;
      let j = start;
      let depth = 0;                          // ${ } nesting inside a template
      while (j < n) {
        const d = text[j];
        if (d === '\\') { j += 2; continue; }
        if (quote === '`' && d === '$' && text[j + 1] === '{') { depth++; j += 2; continue; }
        if (quote === '`' && depth > 0) {
          if (d === '{') depth++;
          else if (d === '}') depth--;
          j++;
          continue;
        }
        if (d === quote) break;
        if (quote !== '`' && d === '\n') break;  // unterminated single-line string
        j++;
      }
      const raw = text.slice(start, j);
      if (/\b(INSERT\s+INTO|UPDATE\s+[a-z_]|DELETE\s+FROM|SELECT\s)/i.test(raw)) {
        out.push({
          raw,
          sql: raw.replace(/--[^\n]*/g, ' '),
          trailing: text.slice(j + 1, j + 201),
          line: lineAt(start),
          index: start
        });
      }
      i = j + 1;
      lastSignificant = quote;
      continue;
    }

    if (!/\s/.test(c)) lastSignificant = c;
    i++;
  }
  return out;
}

/* ── A STATEMENT IS NOT ALWAYS ONE LITERAL, AND THAT IS THE HOLE ──────────
 *
 * `extractSqlLiterals` above answers "which string literals look like SQL",
 * and that was enough for the WRITE invariant because an upsert is written as
 * one template. It is NOT enough for reads. Two real statements from
 * ai-routes.js, both of which a literal-by-literal scan is BLIND to:
 *
 *   (a) 'SELECT l.*, c.name AS client_name '   +
 *       'FROM leads l '                        +
 *       'LEFT JOIN clients c ON c.id = … '     +
 *       'WHERE l.id = $1'
 *
 *       No single fragment holds both a FROM and a WHERE. The first matches
 *       /SELECT / and comes back with no table in it, so a table-based
 *       population filter drops it; the fragment naming `leads` does not match
 *       the SQL test at all and is never returned. The statement is therefore
 *       not non-compliant and not unchecked — it is ABSENT FROM THE
 *       POPULATION. This is exactly the bare `WHERE l.id = $1` on the lead
 *       door, and it is how that door survived the first pass of the scan
 *       written to find it.
 *
 *   (b) '  FROM qb_cost_lines ' + ' WHERE ' + where.join(' AND ') + ' ORDER BY…'
 *
 *       The predicate lives in an ARRAY the handler pushed onto, and the glue
 *       expression carries its own string literal (' AND '), so any attempt to
 *       stitch fragments by reading the source BETWEEN them desynchronises on
 *       the separator — the same class of mistake as the lookbehind this
 *       file's header was written about.
 *
 * So the unit is not the literal, and it is not a guess about glue: it is THE
 * CALL. `extractQueryCalls` finds every `<x>.query(` in the file (skipping
 * matches inside comments and strings), takes the balanced source of its FIRST
 * ARGUMENT, and reports what that argument is made of:
 *
 *   argSource   the first argument's source, verbatim
 *   literals    every string literal inside it
 *   sql         those literals joined, `--` comments blanked — what the
 *               statement PROVABLY says
 *   refs        every identifier the argument references (`where`, `conds`,
 *               `sql`, `orgGuard`, …). A caller that cannot resolve one of
 *               these MUST report the statement as UNCHECKED. Dropping it is
 *               the bug this file exists to prevent.
 *   line        1-based line the call starts on
 *
 * A `.query(sql, params)` whose argument is a bare identifier comes back with
 * NO literals and one ref — which is the correct answer ("the text is not
 * here"), not a silent pass.
 */

// One pass recording the spans of every comment and every string literal, so a
// later scan over the raw text can tell code from not-code. Reuses the exact
// quote / comment / regex rules above rather than restating them.
function tokenizeSpans(text) {
  const literals = [];
  const comments = [];
  let i = 0;
  const n = text.length;
  let lastSignificant = '';

  while (i < n) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      const start = i;
      while (i < n && text[i] !== '\n') i++;
      comments.push([start, i]);
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      comments.push([start, i]);
      continue;
    }
    if (c === '/' && (lastSignificant === '' || PRE_REGEX.has(lastSignificant))) {
      let j = i + 1, inClass = false, closed = false;
      while (j < n) {
        const d = text[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '\n') break;
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { closed = true; j++; break; }
        j++;
      }
      if (closed) { comments.push([i, j]); i = j; lastSignificant = '/'; continue; }
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      const start = i + 1;
      let j = start;
      let depth = 0;
      const subs = [];
      let subStart = -1;
      while (j < n) {
        const d = text[j];
        if (d === '\\') { j += 2; continue; }
        if (quote === '`' && d === '$' && text[j + 1] === '{' && depth === 0) {
          depth++; subStart = j + 2; j += 2; continue;
        }
        if (quote === '`' && depth > 0) {
          if (d === '{') depth++;
          else if (d === '}') { depth--; if (depth === 0) subs.push([subStart, j]); }
          j++; continue;
        }
        if (d === quote) break;
        if (quote !== '`' && d === '\n') break;
        j++;
      }
      literals.push({ start: i, end: j + 1, raw: text.slice(start, j), quote, subs });
      i = j + 1;
      lastSignificant = quote;
      continue;
    }
    if (!/\s/.test(c)) lastSignificant = c;
    i++;
  }
  return { literals, comments };
}

// Words that are language, not references a caller could resolve to SQL.
const JS_KEYWORDS = new Set([
  'true', 'false', 'null', 'undefined', 'new', 'typeof', 'await', 'return',
  'if', 'else', 'const', 'let', 'var', 'function', 'this', 'String', 'Number',
  'Math', 'JSON', 'Array', 'Object', 'Date', 'Boolean', 'length', 'join', 'map',
  'filter', 'slice', 'push', 'concat', 'toString', 'trim',
]);

function extractQueryCalls(text) {
  const { literals, comments } = tokenizeSpans(text);
  const spans = comments.concat(literals.map((l) => [l.start, l.end]))
    .sort((a, b) => a[0] - b[0]);
  const inSpan = (idx) => {
    let lo = 0, hi = spans.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (idx < spans[mid][0]) hi = mid - 1;
      else if (idx >= spans[mid][1]) lo = mid + 1;
      else return true;
    }
    return false;
  };
  const litAt = new Map(literals.map((l) => [l.start, l]));
  const commentAt = new Map(comments.map((c) => [c[0], c]));

  const out = [];
  const re = /\.\s*query\s*\(/g;
  let m;
  while ((m = re.exec(text))) {
    if (inSpan(m.index)) continue;
    // Balanced scan from the open paren to the first TOP-LEVEL comma (the end
    // of the first argument) or the matching close paren.
    let i = m.index + m[0].length;
    let depth = 0;
    const argStart = i;
    let argEnd = -1;
    while (i < text.length) {
      const lit = litAt.get(i);
      if (lit) { i = lit.end; continue; }
      const com = commentAt.get(i);
      if (com) { i = com[1]; continue; }
      const c = text[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' && depth === 0) { argEnd = i; break; }
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (c === ',' && depth === 0) { argEnd = i; break; }
      i++;
    }
    if (argEnd === -1) continue;
    const argSource = text.slice(argStart, argEnd);
    const argLits = literals.filter((l) => l.start >= argStart && l.end <= argEnd);
    const sql = argLits.map((l) => l.raw).join(' ').replace(/--[^\n]*/g, ' ');

    // Identifiers the argument mentions. The literals' own contents are
    // removed first (a column called `organization_id` inside the SQL is not a
    // JS reference), then template substitutions are added back, because those
    // ARE code and are the commonest way a predicate arrives from elsewhere.
    let code = '';
    let cursor = argStart;
    for (const l of argLits) {
      code += text.slice(cursor, l.start);
      for (const s of l.subs) code += ' ' + text.slice(s[0], s[1]) + ' ';
      cursor = l.end;
    }
    code += text.slice(cursor, argEnd);
    const refs = [...new Set(
      (code.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) || []).filter((w) => !JS_KEYWORDS.has(w))
    )];

    let line = 1;
    for (let k = 0; k < m.index; k++) if (text[k] === '\n') line++;
    out.push({ line, index: m.index, argStart, argEnd, argSource, sql, refs });
  }
  return out;
}

module.exports = { extractSqlLiterals, tokenizeSpans, extractQueryCalls };
