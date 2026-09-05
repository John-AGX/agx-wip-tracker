// P86_TENANT_SCOPE — the one-variable rollback for the admin-console tenant
// repairs, so a lockout can be undone from a phone at 9pm without a code push.
//
// ── WHAT IT GOVERNS, AND WHAT IT DELIBERATELY DOES NOT ────────────────────
// It governs the ADMIN AGENT CONSOLE repairs in
// server/routes/admin-agents-routes.js, and nothing else:
//
//   * the six ai_messages aggregates on GET /metrics          (orgArm)
//   * the four entity_title lookups on the conversations pair (orgArm)
//   * registryScope, which backs GET /managed and /managed/audit
//
// IT DOES NOT REACH THE AGENT TOOL SURFACE. That is a deliberate limit rather
// than an oversight. Every agent read tool already refused an org-less caller
// BEFORE the repairs — `orgLessToolRefusal` predates them — so no repair on
// that surface created a way for a legitimate caller to lose access, and there
// is nothing there for a kill switch to rescue. Putting a "serve everything"
// switch behind 112 tools to buy no measured benefit would be adding the risk
// this file exists to reduce.
//
// ── WHY A SWITCH AT ALL, GIVEN THE REPAIRS WERE MEASURED INERT ────────────
// test/tenant-noop-differential.test.js proves, door by door against the
// PRE-REPAIR commit, that a one-organisation database answers the same bytes
// today as it did at 69f2cabd — across 56 agent tools and all four console
// routes. So the aggregate repairs cannot move John's numbers.
//
// ONE REAL LOCKOUT VECTOR SURVIVES THAT PROOF, and it is why this file exists.
// `registryScope` REFUSES (403) a caller who holds ROLES_MANAGE, does not hold
// SYSTEM_ADMIN, and has no resolvable organisation. Before the repair,
// GET /managed had no WHERE clause at all and served that caller every row.
// That is a genuine behaviour change for a genuine account shape, it is not
// covered by the one-org golden (which has an org), and "the app cannot see its
// own data" is the failure mode this whole wave is forbidden to introduce.
//
// ── TWO VALUES. NOT THREE. ────────────────────────────────────────────────
//   enforce  (the default when unset, and the only value CI ever runs)
//   legacy   restores the pre-repair behaviour for the enumerated sites ONLY
//
// There is no silent middle state, because a middle state is how "observe"
// becomes the finish line. `legacy` writes a console.error ON EVERY USE. It is
// meant to be loud enough that it cannot be left on by accident, and the
// graduation checklist makes retiring it a hard gate on creating org #2 — the
// day a second organisation exists, this flag stops being free.
//
// ── HOW THE LEGACY ARM IS SPELLED, AND WHY ────────────────────────────────
// `(organization_id = $n OR TRUE)`. It still NAMES the column and still BINDS
// the parameter, which matters for two practical reasons: Postgres rejects a
// bind with more parameters than the statement uses, so dropping the reference
// would break every call site; and the disabled statement then reads, in the
// logs and in `engine.log`, as exactly what it is. A reviewer who sees
// `OR TRUE` knows immediately that the predicate is switched off. There is no
// second copy of any statement body anywhere — one definition, one branch.
'use strict';

const ENFORCE = 'enforce';
const LEGACY = 'legacy';

// The sites this flag reaches. THREE CALL SITES, and the list says three
// because three is what the code has — test/tenant-scope-flag.test.js DERIVES
// the real number by grepping server/ and fails if this disagrees. A list that
// merely claims a blast radius is the same species of prose as the `owner_id`
// comment that made a guaranteed-failing INSERT look load-bearing.
//
// WHAT IS DELIBERATELY NOT HERE: the four entity_title lookups on the
// conversations pair. A refused title there degrades to the id the caller
// already typed — `entityTitle` is initialised to it — so the worst case is a
// conversation listed by id instead of by name. That is cosmetic, not a
// lockout, and a rollback switch that reaches further than the lockout it
// exists to undo is just a wider hole.
const GOVERNED_SITES = [
  'admin-agents:/metrics',                  // the six ai_messages aggregates, one orgArm definition
  'admin-agents:registryScope',             // the predicate behind /managed and /managed/audit
  'admin-agents:registryScope:no-org',      // the 403 that is the only real lockout vector
];

// Read PER CALL, never cached at module load. A cached value would mean the
// Railway restart that sets the variable is not enough — you would also need
// the process to have started after it, which is a footgun in exactly the
// situation this exists for.
function mode() {
  return String(process.env.P86_TENANT_SCOPE || '').trim().toLowerCase() === LEGACY
    ? LEGACY : ENFORCE;
}

function isLegacy() {
  return mode() === LEGACY;
}

// Loud, every time. Not sampled, not rate-limited: a flag that quietly disables
// a tenant boundary and says so once at boot is a flag somebody forgets is on.
function announce(site) {
  console.error('[TENANT-SCOPE:legacy] tenant predicate DISABLED at ' + site
    + ' — P86_TENANT_SCOPE=legacy is set. This is a rollback switch, not a setting. '
    + 'Unset it on Railway to restore enforcement.');
}

// THE ONE HELPER EVERY GOVERNED SQL SITE USES.
// enforce -> `(<col> = $n OR <col> IS NULL)`   — byte-identical to the repair
// legacy  -> `(<col> = $n OR TRUE)`            — the predicate, switched off
function orgArm(paramIndex, site, col) {
  const c = col || 'organization_id';
  if (isLegacy()) {
    announce(site);
    return '(' + c + ' = $' + paramIndex + ' OR TRUE)';
  }
  return '(' + c + ' = $' + paramIndex + ' OR ' + c + ' IS NULL)';
}

module.exports = { ENFORCE, LEGACY, GOVERNED_SITES, mode, isLegacy, announce, orgArm };
