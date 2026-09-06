// REGISTER 2 — EVERY HTTP ROUTE THE SERVER MOUNTS, THROUGH THE TWO-ORG ORACLE.
//
// ── WHAT WAS WRONG, MEASURED ─────────────────────────────────────────────
// The two-org conformance harness derived its AGENT TOOL population and then
// HARD-CODED FOUR URLS for the HTTP surface. Nothing walked `router.stack`, so
// nothing failed when a route was added. An auditor mounted a new
// `GET /portfolio-rollup` next to `/metrics` — ON THE VERY ROUTER THE HARNESS
// ALREADY REQUIRED — and it answered 200 with both tenants' estimates while
// all 165 suites stayed green.
//
// The census this file is built on:
//
//     server/index.js mounts          75  (74 routers + one rate limiter)
//     routes those routers declare   565
//     the old scaffold drove           4
//
// That is attack class A8 — a surface the enumeration does not reach — one
// layer up from where it was killed. The answer is the same answer: do not list
// the population, DERIVE IT. test/helpers/route-census.js walks what
// `server/index.js` actually mounts and what each router's own stack actually
// declares, so a route added anywhere moves a number here.
//
// ── DRIVE OR COUNTED-WAIVE, THE PATTERN test/schema-truth.test.js ALREADY USES
// 137 of the 565 are param-less GETs — reachable with nothing but a token, so
// they are DRIVEN, all of them, through the identical oracle the tool surface
// uses (test/helpers/two-org.js). The other 428 are writes, or need a path
// parameter, and they are COUNTED. The count is committed. When it moves,
// somebody writes a case or writes down why not. What must never happen again
// is a surface that is neither driven nor counted, because that is the shape
// nothing can report on.
//
// ── TWO CALLERS, BECAUSE "CROSS-TENANT" IS NOT ALWAYS A DEFECT ───────────
// Every route is driven twice from ONE caller record: once as a member of org A
// with ROLES_MANAGE, and once as the platform owner holding SYSTEM_ADMIN.
//
// For the org admin the rule is absolute: no org-B string, no org-B number.
//
// For the platform owner it INVERTS on the routes written for them — the whole
// point of `GET /api/admin/console/metrics` is to show every tenant at once,
// and a harness that called that a leak would be demanding the product be
// broken. So the platform-wide routes are an ENUMERATED, COMMITTED LEDGER that
// must match measurement IN BOTH DIRECTIONS: a route that starts serving two
// tenants to a platform owner and is not on the list is red, and a route ON the
// list that stops doing so is also red. That turns "system_admin sees cross-org
// metrics" from a sentence in a seeded role description into an assertion.
//
// ── WHAT THIS FILE DOES NOT DO ───────────────────────────────────────────
// It never reads a handler's SQL, for the reason test/helpers/two-org.js gives
// at length: a clause that does not filter does not remove rows, a comment does
// nothing at runtime, and a wrapper executes against the same engine. The
// oracle is what came back.

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const TWO = require('./helpers/two-org');
const { ORG_A, ORG_B, MARK } = TWO;
const { overlay: OVERLAY, ID } = require('./helpers/tenant-overlay');

// A SECOND ROLE THE BASE OVERLAY DOES NOT CARRY. `system_admin` is what makes
// the platform-wide arm reachable at all; without it every SYSTEM_ADMIN route
// answers 403 and the ledger below would be a list of routes nobody drove.
const OVERLAY2 = Object.assign({}, OVERLAY, {
  roles: OVERLAY.roles.concat([{
    name: 'system_admin', label: 'System Admin',
    capabilities: JSON.stringify(['ROLES_MANAGE', 'SYSTEM_ADMIN', 'ADMIN_METRICS',
      'USERS_MANAGE', 'INSIGHTS_VIEW', 'JOBS_VIEW_ALL', 'FINANCIALS_VIEW']),
  }]),
});

const freshTwo = () => TWO.buildEngine({ overlay: OVERLAY2 });
const freshOne = () => TWO.buildEngine({ overlay: OVERLAY2, withB: false });

globalThis.__P86_R2_ACTIVE__ = freshTwo();
globalThis.__P86_R2_POOL__ = {
  query: (...a) => globalThis.__P86_R2_ACTIVE__.pool.query(...a),
  connect: (...a) => globalThis.__P86_R2_ACTIVE__.pool.connect(...a),
};
jest.mock('../server/db', () => ({ pool: globalThis.__P86_R2_POOL__ }));
jest.mock('@anthropic-ai/sdk', () => {
  function FakeAnthropic() { return { messages: {}, beta: {} }; }
  FakeAnthropic.toFile = async () => ({});
  return Object.assign(FakeAnthropic, { toFile: FakeAnthropic.toFile, default: FakeAnthropic });
});

// Several route modules arm timers at module load. Faking the clock across the
// requires and handing it straight back drops them, so the worker exits cleanly
// and cannot force-exit mid-report.
jest.useFakeTimers();
const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const census = require('./helpers/route-census');
const MOUNTS = census.mountedRouters();
jest.useRealTimers();

const ALL_ROUTES = census.allRoutes(MOUNTS);
const DRIVEABLE = ALL_ROUTES.filter((r) => r.method === 'GET' && !/:/.test(r.url));
const WAIVED = ALL_ROUTES.filter((r) => !(r.method === 'GET' && !/:/.test(r.url)));

// ── THE CALLERS. ONE RECORD, TWO ROLES, ONE ORG THAT VARIES ──────────────
const CALLER_ID = ID('users', 'A');
const BASE_CALLER = { id: CALLER_ID, email: 'a@a.a', name: 'A Admin' };

let server, baseUrl;

async function call(engine, opts) {
  const prev = globalThis.__P86_R2_ACTIVE__;
  globalThis.__P86_R2_ACTIVE__ = engine;
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
  } finally { globalThis.__P86_R2_ACTIVE__ = prev; }
}

const ORG_ADMIN = [];    // { url, status, marked, poisoned }
const PLATFORM = [];

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  for (const m of MOUNTS) if (m.router) app.use(m.mount, m.router);
  setRolePool(globalThis.__P86_R2_POOL__);
  await refreshRoleCache();
  await new Promise((r) => { server = http.createServer(app); server.listen(0, '127.0.0.1', r); });
  baseUrl = 'http://127.0.0.1:' + server.address().port;

  for (const r of DRIVEABLE) {
    const a = await call(freshTwo(), { url: r.url, orgId: ORG_A, role: 'admin' });
    const sa = TWO.scanAnswer(a);
    ORG_ADMIN.push({ url: r.url, status: a.slice(0, 3), marked: sa.marked, poisoned: sa.poisoned, head: a.slice(0, 260) });

    const p = await call(freshTwo(), { url: r.url, orgId: ORG_A, role: 'system_admin' });
    const sp = TWO.scanAnswer(p);
    PLATFORM.push({ url: r.url, status: p.slice(0, 3), marked: sp.marked, poisoned: sp.poisoned, head: p.slice(0, 260) });
  }
}, 600000);

afterAll((done) => {
  if (!server) return done();
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  server.close(() => done());
});

// ══════════════════════════════════════════════════════════════════════════
// THE POPULATION IS DERIVED, AND ITS SHAPE IS COMMITTED
// ══════════════════════════════════════════════════════════════════════════
describe('REGISTER 2 — the route population', () => {
  test('every mount in server/index.js resolves to a router that loads', () => {
    // A module that cannot be required is a module whose routes nobody can
    // enumerate — so a load failure fails HERE, by name, rather than shrinking
    // the population in silence.
    expect(MOUNTS.failed).toEqual([]);
  });

  test('the one unresolved mount is the rate limiter, and it is named', () => {
    // `app.use('/api', ipGenericLimiter)` is middleware, not a route module.
    // Named rather than filtered, so a SECOND unresolved mount — which would be
    // a router the census silently dropped — cannot hide behind it.
    expect(MOUNTS.unresolved.map((m) => m.expr)).toEqual(['ipGenericLimiter']);
  });

  test('the mount count is committed (75 app.use with a path)', () => {
    expect(MOUNTS.length + MOUNTS.unresolved.length).toBe(75);
  });

  test('the ROUTE count is committed (565 across 74 routers)', () => {
    // THE NUMBER THE OLD SCAFFOLD DID NOT HAVE. It drove 4 routes on 1 mount
    // and nothing moved when a route was added. This fails when one is.
    expect(ALL_ROUTES.length).toBe(565);
    expect(MOUNTS.filter((m) => m.router && Array.isArray(m.router.stack)).length).toBe(74);
  });

  test('the DRIVEN / COUNTED-WAIVED split is committed (137 driven, 428 counted)', () => {
    expect({ driven: DRIVEABLE.length, waived: WAIVED.length }).toEqual({ driven: 137, waived: 428 });
  });

  test('every counted-waived route is a write or needs a path parameter — nothing else is waived', () => {
    // The waiver carries a PREDICATE, not just a count, so a param-less GET
    // cannot slip into the waived set behind a write in the same commit.
    const unexplained = WAIVED.filter((r) => r.method === 'GET' && !/:/.test(r.url));
    expect(unexplained).toEqual([]);
  });

  test('the driven set actually ran (a harness that drives nothing proves nothing)', () => {
    expect(ORG_ADMIN.length).toBe(DRIVEABLE.length);
    expect(PLATFORM.length).toBe(DRIVEABLE.length);
    expect(ORG_ADMIN.filter((r) => r.status === '200').length).toBeGreaterThan(80);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// THE ORG ADMIN — ABSOLUTE. Nothing of org B may reach them.
// ══════════════════════════════════════════════════════════════════════════
describe('REGISTER 2 — an org admin, against a second organisation', () => {
  // ── THE RESIDUAL LEDGER ─────────────────────────────────────────────────
  // Three routes serve an org-A admin rows belonging to org B TODAY, at HEAD,
  // with nothing planted. They are here BY NAME, with the reason and the price,
  // because a harness that goes red on a known, priced, declined defect gets
  // muted — and a muted harness protects nothing while wearing the costume of
  // protection. Every one of them is ALSO a hard blocker on creating org #2;
  // see docs/TENANCY-GRADUATION.md.
  //
  // THE LEDGER FAILS IN BOTH DIRECTIONS. A fourth route joining this set is
  // red. A route on this list that stops leaking is ALSO red, so an entry
  // cannot outlive the defect it describes.
  const KNOWN_CROSS_TENANT_TO_ORG_ADMIN = {
    '/api/roles':
      'roles has name TEXT PRIMARY KEY and NO organization_id, and auth.js keys its cache '
      + 'on name alone — one role catalogue for the whole platform. Graduation item 11: a '
      + 'product decision plus a schema change plus a cache re-key, not a missing predicate.',
    '/api/email/log':
      'email_log has NO organization_id column, so `SELECT … FROM email_log ORDER BY sent_at '
      + 'DESC LIMIT 100` (email-routes.js:315) has no tenant to filter on. Gated on '
      + "requireRole('admin'), i.e. every affiliate admin, and it returns recipient addresses "
      + 'and subject lines. Closing it is a MIGRATION (add the column, backfill, predicate), '
      + 'and this file is not where a migration lands.',
    '/api/admin/agents/managed/prompt-audit':
      'collectSkillsFor reads `managed_agent_skills WHERE agent_key = $1` and that table has '
      + 'NO organization_id either (admin-agents-routes.js:2762; the file says so itself at '
      + ':3657), so the skill_ids attached to one tenant\'s agent list every tenant\'s. Same '
      + 'class as the two above: a table with no tenant column, closable only by migration.',
  };

  test('the residual ledger matches measurement EXACTLY, in both directions', () => {
    const measured = ORG_ADMIN
      .filter((r) => r.marked || r.poisoned.length)
      .map((r) => r.url).sort();
    expect(measured).toEqual(Object.keys(KNOWN_CROSS_TENANT_TO_ORG_ADMIN).sort());
  });

  test('every residual entry states its reason and its price', () => {
    for (const [url, why] of Object.entries(KNOWN_CROSS_TENANT_TO_ORG_ADMIN)) {
      expect(String(why).length).toBeGreaterThan(120);
      expect(url).toMatch(/^\/api\//);
    }
  });

  test('ARM 1 (MARK) — no route outside the ledger leaks an org-B string', () => {
    const leaked = ORG_ADMIN
      .filter((r) => r.marked && !(r.url in KNOWN_CROSS_TENANT_TO_ORG_ADMIN))
      .map((r) => r.url + ' :: ' + r.head.replace(/\s+/g, ' ').slice(0, 220));
    expect(leaked).toEqual([]);
  });

  test('ARM 2 (POISON) — no route outside the ledger leaks an org-B number', () => {
    const leaked = ORG_ADMIN
      .filter((r) => r.poisoned.length && !(r.url in KNOWN_CROSS_TENANT_TO_ORG_ADMIN))
      .map((r) => r.url + ' -> ' + r.poisoned.slice(0, 6).join(',') + ' :: ' + r.head.replace(/\s+/g, ' ').slice(0, 200));
    expect(leaked).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// THE PLATFORM OWNER — WHERE CROSS-TENANT IS THE PRODUCT, AND IS ENUMERATED
// ══════════════════════════════════════════════════════════════════════════
describe('REGISTER 2 — the platform owner, and what SYSTEM_ADMIN actually buys', () => {
  // db.js:5564 seeds the system_admin description as "All admin capabilities
  // PLUS cross-tenant access (manage organizations, SEE CROSS-ORG METRICS,
  // manage Anthropic-account-wide resources)". That sentence was, until this
  // file, discharged by nothing an assertion could see. Here is the list of
  // routes that actually deliver it, measured — and it fails in both
  // directions, so the sentence and the code cannot drift apart again.
  // MEASURED, NOT GUESSED. The first draft of this list was written from
  // reading the routes and it was WRONG IN BOTH DIRECTIONS — five routes on it
  // do not in fact show a second tenant (their answers are counts and empty
  // arrays), and five that do were missing. The measurement corrected the
  // author, which is the entire argument for driving a surface instead of
  // describing it, and it is recorded here rather than quietly fixed.
  const PLATFORM_WIDE_BY_DESIGN = {
    '/api/roles':
      'The platform-wide role catalogue. NOT a system-admin privilege — this is the SAME row '
      + 'set every caller gets, because `roles` has no tenant column at all. It appears on both '
      + 'ledgers for that reason. Graduation item 11.',
    '/api/email/log':
      'email_log has no tenant column either — see the residual ledger above. Also on both '
      + 'lists, and for the same reason: nothing about SYSTEM_ADMIN is what makes it wide.',
    '/api/admin/agents/managed/prompt-audit':
      'managed_agent_skills has no tenant column (collectSkillsFor, admin-agents-routes.js:2762). '
      + 'On both lists, same reason as the two above.',
    '/api/admin/agents/managed':
      'registryScope() takes its SYSTEM_ADMIN branch and returns no WHERE clause. The panel '
      + 'exists to show the platform owner the whole registry; an org admin gets their own rows '
      + 'from the same helper.',
    '/api/admin/agents/managed/audit':
      'The same registryScope branch. Its stated purpose is to find registry rows belonging to '
      + 'NOBODY, which is not a question that can be asked one tenant at a time.',
    '/api/admin/agents/skills/versions':
      'requireSystemAdmin. agent_skills_versions is the platform-wide history of the Anthropic '
      + 'Skills catalogue, which is an Anthropic-ACCOUNT resource and has no tenant.',
    '/api/admin/agents/training-data':
      'requireSystemAdmin. Training-capture counts across the platform — the corpus being built '
      + 'is one corpus, not one per affiliate.',
    '/api/admin/agents/training-export':
      'requireSystemAdmin. Streams the JSONL of that same one corpus. The widest door on this '
      + 'list and the one most worth re-reading if SYSTEM_ADMIN is ever granted more freely.',
    '/api/admin/console/audit':
      'requireSystemAdmin — the PLATFORM tier of the audit trail. The org tier is a separate '
      + 'route with its own scoping.',
    '/api/admin/console/metrics':
      'requireSystemAdmin — THE ROUTE THAT DISCHARGES "see cross-org metrics" in the seeded '
      + 'system_admin description: one row per organisation plus a platform total. This is why '
      + '/api/admin/agents/metrics does not need a platform-wide arm.',
    '/api/admin/organizations/invites':
      'requireSystemAdmin — the outstanding affiliate invitations, which are by definition not '
      + 'yet inside any tenant.',
    '/api/admin/reminders/cron-preview':
      'requireSystemAdmin. It calls reminders-cron, cert-expiry-cron and weekly-digest-cron in '
      + 'DRY mode, and a cron sweeps every tenant by design — that is what a cron is. This is '
      + 'also the ONLY door through which any tenancy test currently reaches a cron module at '
      + 'all; see the Register 3 note in docs/TENANCY-GRADUATION.md.',
  };

  test('the platform-wide set matches measurement EXACTLY, in both directions', () => {
    const measured = PLATFORM
      .filter((r) => r.marked || r.poisoned.length)
      .map((r) => r.url).sort();
    expect(measured).toEqual(Object.keys(PLATFORM_WIDE_BY_DESIGN).sort());
  });

  test('every platform-wide route states WHY it is allowed to see two tenants', () => {
    for (const why of Object.values(PLATFORM_WIDE_BY_DESIGN)) {
      expect(String(why).length).toBeGreaterThan(60);
    }
  });

  // ── R2, ANSWERED BY EXECUTION RATHER THAN BY ARGUMENT ────────────────────
  test('GET /api/admin/agents/metrics is org-scoped for EVERY caller, system_admin included', () => {
    // The audit asked whether this route's lack of a platform-wide arm
    // contradicts the seeded system_admin description. It does not, and this is
    // the proof: the cross-org metric the description promises is served by
    // /api/admin/console/metrics, which is on the ledger above. This route is
    // the ORG admin's own panel and stays per-tenant for everyone — including a
    // platform owner, who reads their OWN tenant here and the whole platform
    // there. Two routes, two questions, neither one lying.
    const own = PLATFORM.find((r) => r.url === '/api/admin/agents/metrics');
    expect(own).toBeTruthy();
    expect(own.status).toBe('200');
    expect(own.marked).toBe(false);
    expect(own.poisoned).toEqual([]);
  });

  test('the cross-org metrics door the role description promises EXISTS and is SYSTEM_ADMIN-gated', () => {
    const cross = PLATFORM.find((r) => r.url === '/api/admin/console/metrics');
    expect(cross).toBeTruthy();
    expect(cross.status).toBe('200');
    // It must show the second tenant — otherwise the description is unmet.
    expect(cross.marked || cross.poisoned.length > 0).toBe(true);
    // …and it must refuse an org admin.
    const denied = ORG_ADMIN.find((r) => r.url === '/api/admin/console/metrics');
    expect(denied.status).toBe('403');
  });

  test('the seeded system_admin description still names cross-org metrics', () => {
    // If somebody rewrites the description, this fails and the ledger above has
    // to be revisited with it. A promise nothing checks is prose, and prose rots
    // toward the code.
    const db = fs.readFileSync(path.join(__dirname, '..', 'server', 'db.js'), 'utf8');
    expect(db).toContain('see cross-org metrics');
  });
});
