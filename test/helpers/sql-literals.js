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

module.exports = { extractSqlLiterals };
