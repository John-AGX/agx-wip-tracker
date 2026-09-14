/* ──────────────────────────────────────────────────────────────────────────
 * test/helpers/css-rules.js — a stylesheet as a flat list of rules.
 *
 * jsdom has no layout and applies no media queries, so a test about which
 * rows swipe on a touch phone, or what colour sits on a filled button, reads
 * the stylesheet itself. This is just enough CSS to do that honestly:
 * comments stripped, @media nesting kept as a list of conditions on each
 * rule, other at-rules (keyframes, font-face, supports) skipped, and
 * declarations split on semicolons outside parentheses (a data: URL carries
 * one). Every rule keeps its source order, which is the cascade's tiebreak.
 * ────────────────────────────────────────────────────────────────────────── */
'use strict';

function splitTop(text, sep) {
  const out = [];
  let depth = 0, quote = null, start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote && text[i - 1] !== '\\') quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === sep && depth === 0) { out.push(text.slice(start, i)); start = i + 1; }
  }
  out.push(text.slice(start));
  return out;
}

function parseDecls(body) {
  const decls = [];
  for (const part of splitTop(body, ';')) {
    const at = part.indexOf(':');
    if (at === -1) continue;
    const prop = part.slice(0, at).trim().toLowerCase();
    const value = part.slice(at + 1).trim();
    if (prop) decls.push({ prop, value });
  }
  return decls;
}

// Index of the brace that closes the one opened just before `from`.
function closeOf(text, from) {
  let depth = 1, quote = null;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote && text[i - 1] !== '\\') quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  throw new Error('unbalanced braces in stylesheet');
}

function rules(css) {
  const text = String(css).replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  (function walk(chunk, media) {
    let i = 0;
    while (i < chunk.length) {
      const open = chunk.indexOf('{', i);
      if (open === -1) break;
      // A statement at-rule (@import, @charset) ends in ';' before the brace.
      let prelude = chunk.slice(i, open);
      const semi = prelude.lastIndexOf(';');
      if (semi !== -1) prelude = prelude.slice(semi + 1);
      prelude = prelude.trim();
      const close = closeOf(chunk, open + 1);
      const body = chunk.slice(open + 1, close);
      if (/^@media\b/i.test(prelude)) {
        walk(body, media.concat(prelude.replace(/^@media\s*/i, '').replace(/\s+/g, ' ')));
      } else if (!/^@/.test(prelude)) {
        out.push({
          media: media,
          selectors: splitTop(prelude, ',').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean),
          decls: parseDecls(body),
          order: out.length,
        });
      }
      i = close + 1;
    }
  })(text, []);
  return out;
}

// The last value a rule list gives a property, or null.
function lastDecl(rule, prop) {
  let v = null;
  for (const d of rule.decls) if (d.prop === prop) v = d.value;
  return v;
}

// The contents of every <style> element in an HTML page.
function styleOf(html) {
  const out = [];
  const re = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(String(html)))) out.push(m[1]);
  return out.join('\n');
}

// WCAG 2 relative luminance and contrast ratio for #rgb / #rrggbb.
function luminance(hex) {
  let h = String(hex).trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) throw new Error('not a hex colour: ' + hex);
  const c = [0, 2, 4].map((i) => parseInt(h.substr(i, 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// var(--x) / var(--x, fallback) against a token map, down to a hex colour.
function resolveColor(value, tokens) {
  let v = String(value).trim();
  for (let guard = 0; guard < 10; guard++) {
    const m = v.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)$/);
    if (!m) break;
    if (Object.prototype.hasOwnProperty.call(tokens, m[1])) v = String(tokens[m[1]]).trim();
    else if (m[2] != null) v = m[2].trim();
    else throw new Error('unresolved token ' + m[1]);
  }
  const named = { white: '#ffffff', black: '#000000' };
  return named[v.toLowerCase()] || v;
}

module.exports = { rules, lastDecl, styleOf, contrast, resolveColor };
