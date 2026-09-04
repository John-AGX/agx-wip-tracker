/* ──────────────────────────────────────────────────────────────────────────
 * test/helpers/inline-handler-scan.js — read every INLINE EVENT HANDLER this
 * repo paints, out of the source that paints it.
 *
 * WHY A SOURCE SCANNER AND NOT A DOM PROBE. The handlers live in one-line
 * HTML strings built by twenty different render functions, most of which need
 * a whole screen's worth of state to reach. A behavioural test can hold two
 * of them; it cannot hold a hundred and seventy, and the ones it cannot hold
 * are exactly where the next one gets added. So this reads the SOURCE and
 * reconstructs, for every `on*="…"` attribute in the repo:
 *
 *   segments : the literal text of the attribute, JS-unescaped and
 *              entity-decoded — i.e. what the browser's JavaScript parser
 *              is actually handed
 *   holes    : every value interpolated into it, with `inString` recording
 *              whether it lands INSIDE a JS string literal in that attribute
 *
 * A hole with inString:true is the defect this repo shipped: escapeHTML maps
 * an apostrophe to &#39;, the HTML parser decodes it back BEFORE the
 * JavaScript parser sees the attribute, and the literal closes. The only
 * shape allowed there is p86Dec('<p86Enc(value)>') — see js/dom-ref.js.
 *
 * The scanner is deliberately dumb about JavaScript: it tracks quotes, template
 * literals, regexes, comments and paren depth, and nothing else. Everything it
 * cannot parse it REPORTS rather than skips (`unterminated`), because a scanner
 * that silently drops what it does not understand is a green light for the one
 * site that matters.
 * ────────────────────────────────────────────────────────────────────────── */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const SKIP_DIR = /^(node_modules|\.git|\.claude|coverage|dist|build)$/;

function walk(dir, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of ents) {
    if (SKIP_DIR.test(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.js$/i.test(e.name)) out.push(p);
  }
  return out;
}

// Every .js file the browser loads. `test/` and `server/` are excluded: neither
// paints a DOM attribute, and server/ carries SQL strings full of quotes that
// would only produce noise.
function paintingFiles() {
  return walk(REPO, [])
    .filter((p) => !/[\\/](test|server|scripts)[\\/]/i.test(p))
    .map((p) => path.relative(REPO, p).replace(/\\/g, '/'))
    .sort();
}

const ENTITIES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const n = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return isFinite(n) ? String.fromCharCode(n) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : m;
  });
}

// JS string-literal escapes, resolved to the character the parser stores.
function unescapeJs(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\') { out += s[i]; continue; }
    const c = s[++i];
    if (c === 'n') out += '\n';
    else if (c === 't') out += '\t';
    else if (c === 'r') out += '\r';
    else if (c === '0') out += '\0';
    else if (c === 'x') { out += String.fromCharCode(parseInt(s.substr(i + 1, 2), 16)); i += 2; }
    else if (c === 'u') { out += String.fromCharCode(parseInt(s.substr(i + 1, 4), 16)); i += 4; }
    else out += c;                                  // \' \" \\ \/ and friends
  }
  return out;
}

// Walk an EXPRESSION forward from `i` until the `+ '` (or `+ "`) that returns
// us to literal text, at paren depth 0. Returns { expr, next } or null.
function readExpression(src, i, quote) {
  const start = i;
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') { depth++; i++; continue; }
    if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return null;                 // ran out of the expression
      depth--; i++; continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c; i++;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
      i++; continue;
    }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i); if (i < 0) return null; i += 2; continue; }
    // A REGEX literal, distinguished from division by what precedes it.
    if (c === '/') {
      const prev = src.slice(0, i).replace(/\s+$/, '').slice(-1);
      if (prev === '' || '(,=:[!&|?{};+-*%~^'.indexOf(prev) !== -1) {
        i++;
        while (i < src.length && src[i] !== '/') {
          if (src[i] === '\\') i++;
          else if (src[i] === '[') { while (i < src.length && src[i] !== ']') { if (src[i] === '\\') i++; i++; } }
          i++;
        }
        i++; while (/[gimsuy]/.test(src[i] || '')) i++;
        continue;
      }
    }
    if (c === '+' && depth === 0) {
      const m = new RegExp('^\\+\\s*' + quote).exec(src.slice(i));
      if (m) return { expr: src.slice(start, i).trim(), next: i + m[0].length };
    }
    i++;
  }
  return null;
}

// Blank every COMMENT, preserving offsets, so a handler quoted in prose (this
// repo documents the defect by writing it out) is not mistaken for one that
// ships. Strings, template literals and regexes are stepped over so a `//`
// inside 'https://x' survives.
function blankComments(src) {
  const out = src.split('');
  let i = 0;
  const blank = (a, b) => { for (let k = a; k < b && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '; };
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      const q = c; i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') i++;
        else if (q === '`' && src[i] === '\n') { /* templates span lines */ }
        else if (src[i] === '\n' && q !== '`') break;
        i++;
      }
      i++; continue;
    }
    if (c === '/' && src[i + 1] === '/') { const s = i; while (i < src.length && src[i] !== '\n') i++; blank(s, i); continue; }
    if (c === '/' && src[i + 1] === '*') { const s = i; const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; blank(s, i); continue; }
    if (c === '/') {
      // regex vs division — only matters for skipping, so be permissive
      const prev = src.slice(0, i).replace(/\s+$/, '').slice(-1);
      if (prev === '' || '(,=:[!&|?{};+-*%~^\n'.indexOf(prev) !== -1) {
        i++;
        while (i < src.length && src[i] !== '/' && src[i] !== '\n') {
          if (src[i] === '\\') i++;
          else if (src[i] === '[') { while (i < src.length && src[i] !== ']' && src[i] !== '\n') { if (src[i] === '\\') i++; i++; } }
          i++;
        }
        i++; continue;
      }
    }
    i++;
  }
  return out.join('');
}

// Read ONE attribute value starting at `i` (just past the opening quote),
// splitting it into literal segments and interpolated holes. `jsQuote` is the
// delimiter of the JS string the attribute is written inside: ' or " means the
// holes are written as ' + expr + ', a backtick means they are ${expr}.
function readAttr(src, i, jsQuote, escaped) {
  const segments = [];
  const holes = [];
  let lit = '';
  let guard = 0;
  while (i < src.length && guard++ < 20000) {
    const c = src[i];
    if (c === '\\' && escaped && src[i + 1] === '"') { segments.push(lit); return { ok: true, segments, holes }; }
    if (c === '"' && !escaped) { segments.push(lit); return { ok: true, segments, holes }; }
    if (c === '\\') { lit += c + (src[i + 1] || ''); i += 2; continue; }
    if (c === '\n' && jsQuote !== '`') break;   // a literal newline ends a quoted JS string
    if (c === '$' && src[i + 1] === '{') {
      let d = 1, j = i + 2;
      while (j < src.length && d > 0) {
        if (src[j] === '{') d++;
        else if (src[j] === '}') d--;
        else if (src[j] === "'" || src[j] === '"' || src[j] === '`') {
          const q = src[j]; j++;
          while (j < src.length && src[j] !== q) { if (src[j] === '\\') j++; j++; }
        }
        j++;
      }
      if (d !== 0) break;
      segments.push(lit); lit = '';
      holes.push({ expr: src.slice(i + 2, j - 1).trim(), start: i + 2, end: j - 1 });
      i = j;
      continue;
    }
    if (c === jsQuote && jsQuote !== '`') {
      // The JS string literal closed: an interpolation begins.
      const plus = /^\s*\+\s*/.exec(src.slice(i + 1));
      if (!plus) break;
      const exprStart = i + 1 + plus[0].length;
      const e = readExpression(src, exprStart, jsQuote);
      if (!e) break;
      segments.push(lit); lit = '';
      holes.push({ expr: e.expr, start: exprStart, end: exprStart + e.expr.length });
      i = e.next;
      continue;
    }
    lit += c; i++;
  }
  return { ok: false, segments: [], holes: [] };
}

const ATTR_OPEN = /\b(on[a-z]{3,20})\s*=\s*(\\?)"/gi;

// Every inline handler attribute in one file.
function scanFile(rel) {
  // Comments blanked, offsets preserved — so `start`/`end` on a hole still
  // index the file on disk and a rewrite can slice straight into it.
  const src = blankComments(fs.readFileSync(path.join(REPO, rel), 'utf8'));
  const out = [];
  let m;
  ATTR_OPEN.lastIndex = 0;
  while ((m = ATTR_OPEN.exec(src))) {
    // Which JS quote is the surrounding string literal written in? An attribute
    // opened as \" sits inside a DOUBLE-quoted JS string; a bare " sits inside
    // a single-quoted one — or inside a TEMPLATE literal, where ' is ordinary
    // text and the holes are ${…}. Try the quoted reading first and fall back
    // to the template reading when it does not terminate, rather than
    // reporting a handler this scanner simply could not spell.
    const escaped = m[2] === '\\';
    const attr = m[1].toLowerCase();
    const line = src.slice(0, m.index).split('\n').length;
    const read = (jsQuote) => readAttr(src, m.index + m[0].length, jsQuote, escaped);
    let r = read(escaped ? '"' : "'");
    if (!r.ok) { const t = read('`'); if (t.ok) r = t; }
    if (!r.ok) { out.push({ file: rel, line, attr, unterminated: true, holes: [], text: null }); continue; }
    const segments = r.segments, holes = r.holes;

    // Rebuild the attribute the browser sees, and decide for each hole whether
    // it lands inside a JS string literal in that attribute.
    const pieces = segments.map((s) => decodeEntities(unescapeJs(s)));
    let text = '';
    let inStr = null;
    for (let s = 0; s < pieces.length; s++) {
      const piece = pieces[s];
      for (let k = 0; k < piece.length; k++) {
        const ch = piece[k];
        if (inStr) { if (ch === inStr) inStr = null; else if (ch === '\\') k++; }
        else if (ch === "'" || ch === '"' || ch === '`') inStr = ch;
      }
      text += piece;
      if (s < holes.length) {
        holes[s].inString = !!inStr;
        holes[s].before = piece;                       // what the parser reads just before
        holes[s].after = pieces[s + 1] || '';          // …and just after
        text += 'p86X';
      }
    }
    out.push({ file: rel, line, attr, unterminated: false, holes, text });
  }
  return out;
}

function scanRepo() {
  const all = [];
  paintingFiles().forEach((rel) => { scanFile(rel).forEach((h) => all.push(h)); });
  return all;
}

// Does this handler's JavaScript still parse, with each hole standing in as a
// plain identifier? `p86X` is a valid identifier AND valid inside a string, so
// it parses in either position — which means a failure here is a real syntax
// error in the painted markup, not an artefact of the substitution.
function parses(text) {
  try { new Function(text); return true; } catch (e) { return false; }
}

// The one shape allowed for a value that lands inside a JS string literal:
// the parser must read p86Dec('  …the encoded bytes…  ') and nothing else, so
// the only thing it ever compiles is a call and an alphabet.
function isSafeHole(hole) {
  if (!hole.inString) return true;
  return /p86Dec\(\s*'$/.test(hole.before || '') && /^'\s*\)/.test(hole.after || '');
}

module.exports = { REPO, paintingFiles, scanFile, scanRepo, parses, isSafeHole, decodeEntities, unescapeJs, blankComments };
