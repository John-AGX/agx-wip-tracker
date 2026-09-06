// REGISTER 2 — THE HTTP ROUTE POPULATION, DERIVED FROM WHAT server/index.js
// ACTUALLY MOUNTS AND FROM WHAT EACH ROUTER ACTUALLY DECLARES.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
// The two-org conformance harness derived its AGENT TOOL population and then
// hard-coded FOUR URLS for the HTTP surface. Nothing walked `router.stack`, so
// nothing failed when a route was added: an auditor mounted a new
// `GET /portfolio-rollup` next to `/metrics`, ON THE VERY ROUTER THE HARNESS
// REQUIRES, and it answered 200 with both tenants' estimates while all 165
// suites stayed green.
//
// That is the same attack the tool population was rebuilt to kill (A8: a
// surface the enumeration does not reach), one layer up. The answer is the same
// answer: DO NOT LIST THE POPULATION. Derive it.
//
//   * THE MOUNTS come from `server/index.js` — every `app.use('<path>', X)`,
//     with `X` resolved back to the `require('./routes/…')` it was declared
//     from. 75 of them today.
//   * THE ROUTES come from each router's own `stack`. Express records one layer
//     per `router.METHOD(path, …)`, so this is what the process will actually
//     serve — not a regex over source, which `router[verb](...)` or a loop
//     would defeat.
//
// 565 routes across 74 routers, measured. A route added anywhere in the server
// moves a committed number in test/tenant-conformance.test.js, and somebody has
// to look at it.
//
// ── WHAT THIS FILE REFUSES TO DO ─────────────────────────────────────────
// It does not decide whether a route is safe, and it never reads a handler's
// SQL. It answers exactly one question — WHAT CAN BE REACHED OVER HTTP — and
// hands that list to the oracle that already exists. Parsing `index.js` is a
// POPULATION step, not a verdict step: the worst a mis-parse can do is leave a
// mount out, and `mountedRouters().unresolved` reports that by name so it
// cannot be silent.
'use strict';

const fs = require('fs');
const path = require('path');

const SERVER_DIR = path.join(__dirname, '..', '..', 'server');

function indexSource() {
  return fs.readFileSync(path.join(SERVER_DIR, 'index.js'), 'utf8');
}

// `const x = require('./routes/y')` and `const x = require('./routes/y').z`
function declarations(src) {
  const decl = {};
  const re = /(?:const|let)\s+([A-Za-z0-9_$]+)\s*=\s*require\(\s*'(\.\/routes\/[^']+)'\s*\)\s*(?:\.([A-Za-z0-9_$]+))?\s*;/g;
  let m;
  while ((m = re.exec(src))) decl[m[1]] = { mod: m[2], prop: m[3] || null };
  return decl;
}

// Every `app.use('<path>', <expr>);` in mount order.
function mountExpressions(src) {
  const out = [];
  const re = /app\.use\(\s*'([^']+)'\s*,\s*([^\n]*?)\)\s*;/g;
  let m;
  while ((m = re.exec(src))) out.push({ mount: m[1], expr: m[2].trim() });
  return out;
}

// Resolve one mount expression to { mod, prop } or null.
function resolveExpr(expr, decl) {
  const req = /require\(\s*'(\.\/routes\/[^']+)'\s*\)(?:\.([A-Za-z0-9_$]+))?/.exec(expr);
  if (req) return { mod: req[1], prop: req[2] || null };
  if (decl[expr]) return decl[expr];
  const dotted = /^([A-Za-z0-9_$]+)\.([A-Za-z0-9_$]+)$/.exec(expr);
  if (dotted && decl[dotted[1]]) return { mod: decl[dotted[1]].mod, prop: dotted[2] };
  return null;
}

// THE MOUNTS, WITH THEIR ROUTERS LOADED.
//
// Loading is the point: a router object's `stack` is the only place the real
// path list lives, and a module that cannot be required is a module whose
// routes nobody can enumerate — so a load failure is REPORTED BY NAME rather
// than skipped. `unresolved` carries mounts whose second argument is not a
// route module at all (the `/api` rate limiter is the only one today).
//
// The caller is responsible for having installed whatever module-level mocks
// these routers need (`server/db`, the SDK) BEFORE calling this — every one of
// them destructures `pool` at load.
function mountedRouters() {
  const src = indexSource();
  const decl = declarations(src);
  const out = [];
  const unresolved = [];
  const failed = [];
  for (const mt of mountExpressions(src)) {
    const target = resolveExpr(mt.expr, decl);
    if (!target) { unresolved.push(mt); continue; }
    let router = null;
    try {
      const loaded = require(path.join(SERVER_DIR, target.mod));
      router = target.prop ? loaded[target.prop] : loaded;
    } catch (e) {
      failed.push({ mount: mt.mount, mod: target.mod, error: e && e.message });
      continue;
    }
    out.push({ mount: mt.mount, mod: target.mod, prop: target.prop, router });
  }
  out.unresolved = unresolved;
  out.failed = failed;
  return out;
}

// Every (method, url) express will serve, derived from the routers' own stacks.
// `url` is the mount path joined to the route path, with the duplicate slash a
// router-level `'/'` produces collapsed — that is the string a caller types.
function allRoutes(mounts) {
  const seen = new Set();
  const out = [];
  for (const m of mounts) {
    const stack = m.router && m.router.stack;
    if (!Array.isArray(stack)) continue;
    for (const layer of stack) {
      if (!layer.route) continue;
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const p of paths) {
        const url = (m.mount + p).replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
        for (const verb of Object.keys(layer.route.methods || {})) {
          if (!layer.route.methods[verb]) continue;
          const key = verb.toUpperCase() + ' ' + url;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ method: verb.toUpperCase(), url, mount: m.mount, mod: m.mod });
        }
      }
    }
  }
  return out;
}

module.exports = { mountedRouters, allRoutes, indexSource, mountExpressions, declarations };
