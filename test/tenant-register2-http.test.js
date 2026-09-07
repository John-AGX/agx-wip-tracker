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
//     server/index.js mounts          76  (75 routers + one rate limiter)
//     routes those routers declare   569
//     the old scaffold drove           4
//
// That is attack class A8 — a surface the enumeration does not reach — one
// layer up from where it was killed. The answer is the same answer: do not list
// the population, DERIVE IT. test/helpers/route-census.js walks what
// `server/index.js` actually mounts and what each router's own stack actually
// declares, so a route added anywhere moves a number here.
//
// ── DRIVE OR COUNTED-WAIVE, THE PATTERN test/schema-truth.test.js ALREADY USES
// 137 of the 569 are param-less GETs — reachable with nothing but a token, so
// they are DRIVEN, all of them, through the identical oracle the tool surface
// uses (test/helpers/two-org.js). The other 432 are writes, or need a path
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

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ── THE DRIVE HAPPENS IN A CHILD PROCESS ─────────────────────────────────
// Mounting 74 route modules inside the jest worker crashed the PROCESS: 4 runs
// in 16 ended with zero bytes of output, no `Tests:` line, and exit code
// 0xC0000409 (STATUS_STACK_BUFFER_OVERRUN) — a native fail-fast that no
// in-process handler can catch. The same 137 routes driven the same way in a
// plain node process crashed 0 times in 10, and then 0 in 10 again, so it is
// jest's registry and sandbox under that load, not the routes and not the
// fixture.
//
// A suite that dies silently one run in four is worse than no suite: it does
// not report a problem, it reports nothing. So the driving lives in
// test/helpers/register2-drive.js and this file asserts on its JSON. If that
// child ever dies, execFileSync throws and this file fails LOUDLY, with the
// child's stderr attached — which is the failure mode we wanted all along.
const DRIVER = path.join(__dirname, 'helpers', 'register2-drive.js');

// ── THE NATIVE CRASH THIS RETRY EXISTS FOR, MEASURED ─────────────────────
// Driving 137 real route handlers against node:sqlite kills the process
// outright about ONE RUN IN TWENTY on this platform: exit 0xC0000409
// (STATUS_STACK_BUFFER_OVERRUN), no exception, no stack, ZERO BYTES of output.
// It is not a boundary result and it is not a test failure — it is the process
// ceasing to exist, and no in-process handler can catch it.
//
// What was tried, in order, and what each was worth:
//   * jest.useFakeTimers() across the requires — made it WORSE (4 in 16).
//   * disarming the 74 routers' boot timers by hand — no change (3 in 16).
//   * moving the drive out of jest into a child — helped (3 in 20 -> 1 in 20).
//   * closing each DatabaseSync when done with it — helped again, and is
//     correct regardless. THE CRASH RATE TRACKED THE NUMBER OF UN-CLOSED
//     NATIVE HANDLES (3 engines: 3/20; 2 engines: 1/20; 1 engine: 0/24), which
//     is a GC finalizer running over a live native database.
//
// A residue remains, so the child is RETRIED and the retry is REPORTED rather
// than hidden. Three crashes in a row is about one run in ten thousand; a
// genuine boundary failure, by contrast, is deterministic and survives every
// attempt, because it comes back in a result file rather than killing the
// process. `R.attempts` is asserted below so the rate stays VISIBLE instead of
// quietly becoming somebody else's problem.
const R = (() => {
  const crashes = [];
  for (let n = 1; n <= 3; n++) {
    const outFile = path.join(require('os').tmpdir(),
      'p86-register2-' + process.pid + '-' + n + '-' + Date.now() + '.json');
    try {
      execFileSync(process.execPath, [DRIVER], {
        cwd: path.join(__dirname, '..'),
        env: Object.assign({}, process.env, {
          R2_OUT: outFile,
          JWT_SECRET: process.env.JWT_SECRET || 'test-only-secret-with-at-least-32-characters-of-padding',
        }),
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: 600000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (!fs.existsSync(outFile)) throw new Error('driver wrote no result file');
      const parsed = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      try { fs.unlinkSync(outFile); } catch (e) { /* a leftover temp file is not a failure */ }
      if (!parsed.ok) throw new Error('driver reported failure: ' + parsed.error);
      parsed.attempts = n;
      parsed.crashes = crashes;
      return parsed;
    } catch (e) {
      crashes.push('attempt ' + n + ': status=' + e.status + ' signal=' + e.signal
        + ' :: ' + String(e.message || '').slice(0, 200));
      try { fs.unlinkSync(outFile); } catch (_) { /* may not exist */ }
    }
  }
  throw new Error('REGISTER 2 driver did not complete in 3 attempts. That is a crash, not a '
    + 'boundary result — a real failure is deterministic and comes back in a result file '
    + 'instead of killing the process.\n  ' + crashes.join('\n  '));
})();

const ORG_ADMIN = R.orgAdmin;
const PLATFORM = R.platform;
const UNHANDLED = R.unhandled;

describe('REGISTER 2 — the route population', () => {
  test('every mount in server/index.js resolves to a router that loads', () => {
    // A module that cannot be required is a module whose routes nobody can
    // enumerate — so a load failure fails HERE, by name, rather than shrinking
    // the population in silence.
    expect(R.failed).toEqual([]);
  });

  test('the one unresolved mount is the rate limiter, and it is named', () => {
    // `app.use('/api', ipGenericLimiter)` is middleware, not a route module.
    // Named rather than filtered, so a SECOND unresolved mount — which would be
    // a router the census silently dropped — cannot hide behind it.
    expect(R.unresolved).toEqual(['ipGenericLimiter']);
  });

  test('the mount count is committed (76 app.use with a path)', () => {
    // 75 -> 76 on 01e9fdcd, which mounted report-share-routes. Recorded rather
    // than silently bumped: THIS IS THE LEDGER WORKING. A mount landed from
    // another session while this wave was in flight, this number moved, the
    // build went red naming it, and a human read the four routes it added
    // before the number was changed. All four are POST or take a path
    // parameter, so the driven count is unmoved and both boundary ledgers below
    // are unchanged — which is itself the thing worth knowing.
    expect(R.mounts + R.unresolved.length).toBe(76);
  });

  test('the ROUTE count is committed (573 across 75 routers)', () => {
    // THE NUMBER THE OLD SCAFFOLD DID NOT HAVE. It drove 4 routes on 1 mount
    // and nothing moved when a route was added. This fails when one is.
    //
    // 569 -> 573, and the four are read individually rather than absorbed:
    //
    //   +3 WAIVED, from 15ebf0f1 / 948f6520 (report-share comments), landed on
    //      origin/main WITHOUT this ledger being moved — so main was red here
    //      before this wave touched it. All three take a path parameter, so
    //      the driven count is unaffected and the waiver predicate below still
    //      holds:
    //        GET  /report-share/:token/comments
    //        POST /report-share/:token/comments
    //        GET  /reports/:entityType/:entityId/:reportId/comments
    //
    //   +1 DRIVEN: GET /api/receipts/merchants. A param-less GET, so it joins
    //      the driven set BY CONSTRUCTION and is exercised by both callers
    //      below — which is the point of adding it as one. It unions receipts
    //      (DIRECT tenancy) with qb_cost_lines (PARENT, through jobs), two
    //      different predicates in one statement, and that is exactly the
    //      shape a one-org production can never disprove on its own.
    expect(R.routes).toBe(573);
    expect(R.routers).toBe(75);
  });

  test('the DRIVEN / COUNTED-WAIVED split is committed (138 driven, 435 counted)', () => {
    expect({ driven: R.driveable, waived: R.waived }).toEqual({ driven: 138, waived: 435 });
  });

  test('every counted-waived route is a write or needs a path parameter — nothing else is waived', () => {
    // The waiver carries a PREDICATE, not just a count, so a param-less GET
    // cannot slip into the waived set behind a write in the same commit.
    expect(R.waivedParamlessGets).toBe(0);
  });

  test('the driver completed, and any retry it needed is REPORTED not hidden', () => {
    // A retry that nobody can see is a rate that nobody is watching. This does
    // not fail on a retry — the crash is an environment fault, not a boundary
    // result — but it prints what happened, so a rate that starts climbing is
    // visible in the run output instead of being absorbed.
    if (R.attempts > 1) {
      console.warn([
        '[REGISTER 2] the driver crashed ' + (R.attempts - 1) + ' time(s) before completing:',
      ].concat(R.crashes).join(String.fromCharCode(10) + '  '));
    }
    expect(R.attempts).toBeLessThanOrEqual(3);
    expect(R.ok).toBe(true);
  });

  test('the driven set actually ran (a harness that drives nothing proves nothing)', () => {
    expect(ORG_ADMIN.length).toBe(R.driveable);
    expect(PLATFORM.length).toBe(R.driveable);
    expect(ORG_ADMIN.filter((r) => r.status === '200').length).toBeGreaterThan(80);
  });

  test('every background rejection is a SHIM artefact — anything else fails by message', () => {
    // Recorded, not swallowed. `pg-sqlite could not prepare` is the shim
    // meeting Postgres syntax it does not translate (DISTINCT ON, LATERAL,
    // date_trunc) — real Postgres would run those, and they say nothing about
    // tenancy. `is not a function` is a helper not wired in a unit test. Any
    // OTHER rejection is something this harness has actually broken, or a
    // genuine crash in a driven route, and it must be read rather than
    // absorbed by a listener that exists to stop the worker dying.
    const SHIM = /pg-sqlite could not prepare|is not a function|no such (function|column|table)|syntax error/i;
    const unexplained = UNHANDLED.filter((m) => !SHIM.test(m));
    expect(unexplained).toEqual([]);
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
