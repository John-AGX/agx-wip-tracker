// REGISTER 2'S DRIVER — mounts every router server/index.js mounts, drives the
// param-less GETs against the two-org fixture, and prints one JSON line.
//
// ── WHY THIS IS A CHILD PROCESS AND NOT PART OF THE TEST FILE ────────────
// The first version mounted all 74 routers inside the jest worker. Measured
// over 16 runs, FOUR ENDED WITH ZERO BYTES OF OUTPUT AND NO `Tests:` LINE, exit
// code 0xC0000409 — STATUS_STACK_BUFFER_OVERRUN, a native fail-fast. Not a test
// failure: a process that dies without saying anything.
//
// That is the worst failure an instrument can have. It does not report a
// problem, it reports nothing, and the task brief this work was done under says
// in as many words to refuse any result with no `Tests:` line. A suite that
// does that one run in four gets muted, and a muted harness protects nothing
// while wearing the costume of protection.
//
// The same 137 routes, driven the same way, in a plain node process: 0 crashes
// in 10 runs, then 0 in 16. The crash needs jest's module registry and sandbox
// under 74 route modules' worth of load; it is not in the routes and it is not
// in the fixture. So the driving happens here, in a plain process, and the test
// file spawns it and asserts on the JSON.
//
// This is strictly better than what it replaces even ignoring the crash: 74
// route modules with boot timers, background sweeps and module-level state no
// longer share a process with the assertions. And if this child ever DOES die,
// the parent sees a non-zero exit and says so — a loud failure instead of a
// silent truncation.
//
// ── HOW THE POOL IS SWAPPED WITHOUT jest.mock ───────────────────────────
// `Module._load` is intercepted for exactly two specifiers: `server/db` (every
// router destructures `pool` from it at load) and `@anthropic-ai/sdk` (which is
// constructed at load and must not reach the network). The db interception
// RESOLVES THE PATH before substituting, so a module named `db` somewhere else
// in the tree cannot be caught by it.
//
// Output: ONE JSON FILE, at the path in the R2_OUT env var. Not stdout — 74 routers
// announce themselves on stdout at load ('[sms-routes] mounted at ...'), which
// turned the result into JSON followed by console noise and an unparseable
// stream. A result channel a dependency can write to is not a result channel.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const path = require('path');
const Module = require('module');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');
const DB_PATH = path.join(ROOT, 'server', 'db.js');

const TWO = require('./two-org');
const { overlay: BASE_OVERLAY, ID } = require('./tenant-overlay');

// A SECOND ROLE THE BASE OVERLAY DOES NOT CARRY. Without `system_admin` every
// platform route answers 403 and the platform pass measures nothing.
const OVERLAY = Object.assign({}, BASE_OVERLAY, {
  roles: BASE_OVERLAY.roles.concat([{
    name: 'system_admin', label: 'System Admin',
    capabilities: JSON.stringify(['ROLES_MANAGE', 'SYSTEM_ADMIN', 'ADMIN_METRICS',
      'USERS_MANAGE', 'INSIGHTS_VIEW', 'JOBS_VIEW_ALL', 'FINANCIALS_VIEW']),
  }]),
});

// ── ONE ENGINE PER PASS, NOT ONE PER ROUTE ───────────────────────────────
// A per-request engine with the active pointer restored afterwards produced a
// REPRODUCIBLE FLAKE — about one run in three, `/api/email-folders` came back
// carrying a number in the poison band, while the same route driven 30 times in
// isolation was clean every time. Several handlers keep working after they
// respond (a geocode backfill, a folder seed, a key mint), and with a
// per-request engine those continuations land in whichever world is active when
// they finally run — i.e. some later route's. That is cross-talk between
// fixtures presenting as a tenant leak, which is the most expensive kind of
// false positive: it teaches the next reader that this suite cries wolf.
//
// One engine per pass removes the class: a late continuation lands in the world
// it came from. Register 2 uses Arms 1 and 2 only — marker and magnitude —
// neither of which needs a pristine world per call. Arm 3's differential, which
// would, lives in the tool register where every door gets its own engine.
let ACTIVE = null;
const POOL = {
  query: (...a) => ACTIVE.pool.query(...a),
  connect: (...a) => ACTIVE.pool.connect(...a),
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@anthropic-ai/sdk') {
    function FakeAnthropic() { return { messages: {}, beta: {} }; }
    FakeAnthropic.toFile = async () => ({});
    return Object.assign(FakeAnthropic, { toFile: FakeAnthropic.toFile, default: FakeAnthropic });
  }
  if (/(^|[\\/])db$/.test(String(request))) {
    try {
      if (Module._resolveFilename(request, parent, isMain) === DB_PATH) return { pool: POOL };
    } catch (e) { /* not resolvable from here — fall through to the real loader */ }
  }
  return origLoad.apply(this, arguments);
};

// Fire-and-forget continuations in real handlers reject under a SQL shim that
// cannot translate every Postgres idiom. Recorded, not swallowed: the parent
// asserts that each one is a shim artefact and fails on anything else.
const UNHANDLED = [];
process.on('unhandledRejection', (e) => {
  UNHANDLED.push(String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 200));
});

const express = require(path.join(ROOT, 'node_modules', 'express'));
const { signToken, setRolePool, refreshRoleCache } = require(path.join(ROOT, 'server', 'auth'));
const census = require('./route-census');

const CALLER_ID = ID('users', 'A');
const BASE_CALLER = { id: CALLER_ID, email: 'a@a.a', name: 'A Admin' };

async function main() {
  const mounts = census.mountedRouters();
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  for (const m of mounts) if (m.router) app.use(m.mount, m.router);
  // A world must exist before the role cache is warmed — refreshRoleCache reads
  // `roles` through the same pool, and a null ACTIVE there is a crash before a
  // single route is driven.
  ACTIVE = TWO.buildEngine({ overlay: OVERLAY });
  setRolePool(POOL);
  await refreshRoleCache();

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = 'http://127.0.0.1:' + server.address().port;

  const all = census.allRoutes(mounts);
  const driveable = all.filter((r) => r.method === 'GET' && !/:/.test(r.url));

  async function call(opts) {
    try {
      const token = signToken(Object.assign({}, BASE_CALLER, {
        role: opts.role, organization_id: opts.orgId,
      }));
      const res = await fetch(baseUrl + opts.url, {
        headers: { authorization: 'Bearer ' + token, connection: 'close' },
        signal: AbortSignal.timeout(10000),
      });
      let body = '';
      try { body = await res.text(); } catch (e) { body = ''; }
      return res.status + ' ' + String(body);
    } catch (e) {
      return 'ERR ' + (e && e.message);
    }
  }

  async function pass(role, withB) {
    // CLOSE THE PREVIOUS WORLD FIRST. DatabaseSync is a native handle; leaving
    // them open for the GC to finalize at an arbitrary moment is what made this
    // process die with 0xC0000409 and no output at all.
    const previous = ACTIVE;
    ACTIVE = TWO.buildEngine({ overlay: OVERLAY, withB: withB !== false });
    if (previous && previous.close) previous.close();
    const out = [];
    for (const r of driveable) {
      const answer = await call({ url: r.url, orgId: TWO.ORG_A, role });
      const s = TWO.scanAnswer(answer);
      out.push({
        url: r.url, status: answer.slice(0, 3),
        marked: s.marked, poisoned: s.poisoned,
        head: answer.slice(0, 260),
      });
    }
    return out;
  }

  const orgAdmin = await pass('admin');
  const platform = await pass('system_admin');

  const OUT = process.env.R2_OUT;
  if (!OUT) throw new Error('R2_OUT is required — this driver writes its result to a file, not to stdout');
  require('fs').writeFileSync(OUT, JSON.stringify({
    ok: true,
    mounts: mounts.length,
    unresolved: mounts.unresolved.map((m) => m.expr),
    failed: mounts.failed,
    routers: mounts.filter((m) => m.router && Array.isArray(m.router.stack)).length,
    routes: all.length,
    driveable: driveable.length,
    waived: all.length - driveable.length,
    waivedParamlessGets: all.filter((r) => r.method === 'GET' && !/:/.test(r.url)).length - driveable.length,
    orgAdmin,
    platform,
    unhandled: UNHANDLED,
  }));
  if (ACTIVE && ACTIVE.close) ACTIVE.close();
  server.close();
  // The routers hold timers this process never wants to wait on, and the whole
  // point of this file is a result that always arrives.
  process.exit(0);
}

main().catch((e) => {
  try { require('fs').writeFileSync(process.env.R2_OUT || 'r2-error.json', JSON.stringify({ ok: false, error: String((e && e.stack) || e) })); } catch (_) {}
  console.error(String((e && e.stack) || e));
  process.exit(1);
});
