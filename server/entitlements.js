// Entitlements — the gating seam between an org's plan and the app.
//
// THIS is the load-bearing abstraction of the SaaS scaffold. Every
// future "is this org allowed to X" / "has this org hit its Y limit"
// check routes through here, so when plans change you tune
// plans-catalog.js and nothing at the call sites moves.
//
// Today it's a NO-OP for AGX: the org is on the 'internal' plan whose
// limits + features are the UNLIMITED sentinel, so can() always returns
// true and limitFor() always returns null (unlimited). The seam exists;
// it just doesn't bite yet.
//
// Resolution order for an org's plan:
//   1. explicit organizations.plan_key (looked up in the catalog)
//   2. DEFAULT_PLAN_KEY when plan_key is null / unknown (fail-open to
//      'internal' while AGX is the only tenant)
//
// Caching: plan lookups are hot (potentially every gated request), but
// an org's plan changes rarely (only on upgrade/downgrade/Stripe
// webhook). We cache the resolved row for CACHE_TTL_MS. Call
// invalidate(orgId) after you mutate an org's plan so the change is
// seen immediately instead of waiting out the TTL.

'use strict';

const { pool } = require('./db');
const plans = require('./plans-catalog');

const CACHE_TTL_MS = 60 * 1000;
// orgId -> { at: epochMs, row: { plan_key, plan_status, trial_ends_at } }
const _cache = new Map();

function invalidate(orgId) {
  if (orgId == null) { _cache.clear(); return; }
  _cache.delete(Number(orgId));
}

// Fetch (and cache) the org's billing row. Returns a minimal shape; the
// columns are the SaaS-scaffold additions on the organizations table.
// On any DB error we fail open to the default plan so a transient blip
// never locks an org out of its own app.
async function _loadOrgPlanRow(orgId) {
  const id = Number(orgId);
  const hit = _cache.get(id);
  const now = Date.now();
  if (hit && (now - hit.at) < CACHE_TTL_MS) return hit.row;
  let row;
  try {
    const r = await pool.query(
      'SELECT plan_key, plan_status, trial_ends_at FROM organizations WHERE id = $1',
      [id]
    );
    row = r.rows[0] || null;
  } catch (e) {
    console.warn('[entitlements] plan lookup failed for org=' + id + ':', e.message);
    row = null;
  }
  if (!row) row = { plan_key: plans.DEFAULT_PLAN_KEY, plan_status: 'active', trial_ends_at: null };
  _cache.set(id, { at: now, row: row });
  return row;
}

// Resolve the full plan object for an org. Always returns a real plan
// (never null) — unknown plan_key falls back to DEFAULT_PLAN_KEY.
async function planFor(orgId) {
  const row = await _loadOrgPlanRow(orgId);
  return plans.getPlan(row.plan_key) || plans.getPlan(plans.DEFAULT_PLAN_KEY);
}

// The full entitlements snapshot for an org — what the client manifest
// surfaces and what the helpers below read. `limits` and `features` are
// normalized to plain objects even for the UNLIMITED tier so callers
// never have to know about the sentinel.
async function entitlementsFor(orgId) {
  const row = await _loadOrgPlanRow(orgId);
  const plan = plans.getPlan(row.plan_key) || plans.getPlan(plans.DEFAULT_PLAN_KEY);
  const unlimited = plan.limits === plans.UNLIMITED || plan.features === plans.UNLIMITED;
  return {
    plan_key: plan.key,
    plan_name: plan.name,
    plan_status: row.plan_status || 'active',
    trial_ends_at: row.trial_ends_at || null,
    unlimited: unlimited,
    // For the UNLIMITED tier we expose empty objects — callers should
    // use can()/limitFor() rather than reading these directly, but if
    // they do, "{}" + the unlimited flag is the honest representation.
    limits: plan.limits === plans.UNLIMITED ? {} : Object.assign({}, plan.limits),
    features: plan.features === plans.UNLIMITED ? {} : Object.assign({}, plan.features),
  };
}

// ── Synchronous predicate helpers ────────────────────────────────
// These take a resolved PLAN object (from planFor) so a caller that
// already has the plan doesn't re-hit the cache. The async wrappers
// below are the convenient form for one-off checks.

// Is `featureKey` enabled for this plan? UNLIMITED → always true.
// A feature key absent from a plan's `features` map → false (new gated
// features are off until each tier opts in).
function planHasFeature(plan, featureKey) {
  if (!plan) return false;
  if (plan.features === plans.UNLIMITED) return true;
  return plan.features[featureKey] === true;
}

// The numeric limit for `limitKey`, or null = unlimited. UNLIMITED tier
// → null. A limit key absent from a plan's `limits` map → null too
// (a new meter has no cap until you set one in the catalog).
function planLimit(plan, limitKey) {
  if (!plan) return null;
  if (plan.limits === plans.UNLIMITED) return null;
  const v = plan.limits[limitKey];
  return (v === undefined) ? null : v;
}

// ── Async one-shot helpers (resolve the org's plan, then check) ───
async function can(orgId, featureKey) {
  const plan = await planFor(orgId);
  return planHasFeature(plan, featureKey);
}

async function limitFor(orgId, limitKey) {
  const plan = await planFor(orgId);
  return planLimit(plan, limitKey);
}

// Is the org under its limit for `limitKey` given `currentCount`?
// Unlimited (null) → always true. Use this at the point you're about
// to create the N+1th thing.
async function withinLimit(orgId, limitKey, currentCount) {
  const lim = await limitFor(orgId, limitKey);
  if (lim == null) return true;             // unlimited
  return Number(currentCount) < Number(lim);
}

module.exports = {
  invalidate,
  planFor,
  entitlementsFor,
  can,
  limitFor,
  withinLimit,
  // exported for unit tests / callers holding a plan already
  planHasFeature,
  planLimit,
};
