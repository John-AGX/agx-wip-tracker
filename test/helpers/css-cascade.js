/* ──────────────────────────────────────────────────────────────────────────
 * test/helpers/css-cascade.js — "what does this element get at this size?"
 *
 * A small, deliberately narrow cascade over the rules from css-rules.js, for
 * tests that ask a layout question jsdom cannot: a 390px touch phone and a
 * 700px mouse window are the same document to jsdom. The caller names the
 * element by the exact selectors that target it (a selector string, not a
 * DOM match), and an environment: { width, pointer, hover, scheme }.
 *
 *   media   — max-width / min-width in px, pointer, any-pointer, hover and
 *             prefers-color-scheme, joined by `and`, listed by `,`. Anything
 *             else (print, reduced motion, orientation) is treated as NOT
 *             matching, so an unknown query can never switch a rule on.
 *   winner  — !important first, then specificity (with :has / :not / :is
 *             counted as their most specific argument), then source order.
 *   boxes   — margin and padding shorthands are expanded to their sides, so
 *             a later `margin-right` beats an earlier `margin` and back.
 * ────────────────────────────────────────────────────────────────────────── */
'use strict';

function splitTop(text, sep) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === sep && depth === 0) { out.push(text.slice(start, i)); start = i + 1; }
  }
  out.push(text.slice(start));
  return out;
}

function feature(f, env) {
  f = f.trim();
  if (/^(all|screen)$/i.test(f)) return true;
  let m = f.match(/^\(\s*(max|min)-width\s*:\s*(\d+(?:\.\d+)?)px\s*\)$/i);
  if (m) return m[1].toLowerCase() === 'max' ? env.width <= Number(m[2]) : env.width >= Number(m[2]);
  m = f.match(/^\(\s*(?:any-)?pointer\s*:\s*(\w+)\s*\)$/i);
  if (m) return env.pointer === m[1].toLowerCase();
  m = f.match(/^\(\s*(?:any-)?hover\s*:\s*(\w+)\s*\)$/i);
  if (m) return (env.hover || (env.pointer === 'fine' ? 'hover' : 'none')) === m[1].toLowerCase();
  m = f.match(/^\(\s*prefers-color-scheme\s*:\s*(\w+)\s*\)$/i);
  if (m) return (env.scheme || 'dark') === m[1].toLowerCase();
  return false;
}

function mediaMatches(list, env) {
  return list.every((q) => splitTop(q, ',').some((one) => one.trim().split(/\s+and\s+/i).every((f) => feature(f, env))));
}

function specificity(sel) {
  let a = 0, b = 0, c = 0;
  let s = String(sel);
  // Functional pseudo-classes take their argument's specificity.
  for (let guard = 0; guard < 10; guard++) {
    const m = s.match(/:(has|not|is)\(/);
    if (!m) break;
    let depth = 1, j = m.index + m[0].length;
    for (; j < s.length && depth; j++) { if (s[j] === '(') depth++; else if (s[j] === ')') depth--; }
    const arg = s.slice(m.index + m[0].length, j - 1);
    const best = splitTop(arg, ',').map((x) => specificity(x.replace(/^\s*[>+~]\s*/, '')))
      .reduce((p, q) => (q[0] > p[0] || (q[0] === p[0] && (q[1] > p[1] || (q[1] === p[1] && q[2] > p[2]))) ? q : p), [0, 0, 0]);
    a += best[0]; b += best[1]; c += best[2];
    s = s.slice(0, m.index) + ' ' + s.slice(j);
  }
  s = s.replace(/::[\w-]+/g, () => { c++; return ' '; });
  s = s.replace(/\[[^\]]*\]/g, () => { b++; return ' '; });
  s = s.replace(/#[\w-]+/g, () => { a++; return ' '; });
  s = s.replace(/\.[\w-]+/g, () => { b++; return ' '; });
  s = s.replace(/:[\w-]+/g, () => { b++; return ' '; });
  s.split(/[\s>+~]+/).forEach((t) => { if (/^[a-z][\w-]*$/i.test(t)) c++; });
  return [a, b, c];
}

function sides(value) {
  const v = String(value).replace(/!important/i, '').trim().split(/\s+/);
  const t = v[0], r = v[1] != null ? v[1] : t, bm = v[2] != null ? v[2] : t, l = v[3] != null ? v[3] : r;
  return { top: t, right: r, bottom: bm, left: l };
}

function expand(decl) {
  const p = decl.prop;
  if (p === 'margin' || p === 'padding') {
    const s = sides(decl.value);
    return ['top', 'right', 'bottom', 'left'].map((k) => ({ prop: p + '-' + k, value: s[k], important: /!important/i.test(decl.value) }));
  }
  return [{ prop: p, value: String(decl.value).replace(/\s*!important\s*$/i, ''), important: /!important/i.test(decl.value) }];
}

// computed(rules, ['#job-service-tickets .p86-st-pills', '.p86-st-pills'], env, 'flex-wrap')
function computed(ruleList, selectors, env, prop) {
  const want = new Set(selectors);
  let best = null;
  for (const rule of ruleList) {
    if (!mediaMatches(rule.media, env)) continue;
    for (const sel of rule.selectors) {
      if (!want.has(sel)) continue;
      const sp = specificity(sel);
      rule.decls.forEach((d, di) => {
        for (const e of expand(d)) {
          if (e.prop !== prop) continue;
          const key = [e.important ? 1 : 0, sp[0], sp[1], sp[2], rule.order, di];
          if (!best || cmp(key, best.key) >= 0) best = { key, value: e.value, selector: sel, media: rule.media };
        }
      });
    }
  }
  return best;
}
function cmp(x, y) {
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

function px(v) {
  if (v == null) return 0;
  const m = String(v.value != null ? v.value : v).trim().match(/^(-?\d+(?:\.\d+)?)(px)?$/);
  return m ? Number(m[1]) : 0;
}

module.exports = { computed, mediaMatches, specificity, px };
