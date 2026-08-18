// ── Multi-tenant org-access helper (Wave A) ──────────────────────────────
// Centralizes "does this entity belong to the caller's org?" so by-id reads
// and mutations (attachments, change-orders, schedule, AI entity context)
// gate identically.
//
// ── THE POINTER: THE ENTITY'S OWN COLUMN ─────────────────────────────────
//
// This file used to say the scoping source of truth was the OWNER user's org
// (owner_id → users.organization_id). services/job-org-scope.js says the
// opposite, in writing: "The COLUMN is canonical (see the N1 commit)". Two
// files declaring two different sources of truth for the same fact is not a
// documentation problem — it is a row that two tenants can read through two
// code paths, and no NULL check or future NOT NULL can see it, because both
// pointers are populated and simply disagree.
//
// The older file was the wrong one. Every case below now scopes through the
// entity's own organization_id column; change_order scopes through its parent
// JOB's column. Three consequences worth naming:
//
//   * `lead` was a GUARANTEED RUNTIME ERROR. leads has no owner_id column —
//     server/db.js declares client_id, salesperson_id, job_id, created_by, and
//     no ALTER adds one — so `JOIN users u ON u.id = l.owner_id` raised 42703
//     every time and the catch below turned it into a fail-closed `false`.
//     Every lead entity check has been denying since it was written.
//   * `estimate` and `job` widen slightly: an OWNERLESS row (owner_id NULL, or
//     pointing at a deleted user) was dropped by the INNER JOIN and is now
//     reachable by the tenant its column names. Stamping widens; it cannot
//     hide.
//   * `estimate`, `lead` and `change_order` had no live callers — only `job`
//     and `schedule_entry` do — so the blast radius is small and the fix is
//     mostly forward-looking.
//
// NO-OP-FOR-AGX SAFETY: the `OR <col> IS NULL` clause keeps every check a no-op
// for AGX's current (partly un-stamped) data — it can never hide a row AGX can
// see today. It mirrors the existing change-orders/summary route. Once all rows
// are org-stamped (the Buildertrend re-import), drop the `OR ... IS NULL`
// clauses here + in the route filters to make this hard-strict before a 2nd org
// is onboarded. Search this repo for "OR-IS-NULL (org tolerance)" to find them.
//
// ── WHAT IS TOLERANCE AND WHAT IS SEMANTICS ──────────────────────────────
// That grep does NOT return every `organization_id IS NULL` in the repo, and
// it must not. Some of them mean "this row belongs to no tenant BY DESIGN":
// the shared assembly taxonomy, and the global rows in materials/assemblies
// that services/materials.js falls back to with `ORDER BY organization_id
// NULLS LAST`. Removing one of those does not tighten a boundary — it makes 86
// answer "no material matches" and price from nothing. They are marked
// ORG-SHARED-CATALOG (not tolerance) instead, so the two idioms are separable
// by grep even though they are byte-identical as SQL.
//
// ── THE TABLE-BY-TABLE CLASSIFICATION LIVES IN CODE, NOT IN THIS COMMENT ──
// services/org-table-classification.js records, for every table carrying
// organization_id, whether its tenant is its own column (direct), its parent's
// (parent), correct-as-NULL platform data (shared), or nonexistent (platform)
// — with the reason written next to each name. It is machine-readable on
// purpose: GET /api/admin/console/org-boundary enumerates the live catalog
// from information_schema and reports any table missing from that list as
// UNCLASSIFIED, by name. A prose list in a comment cannot make an omission
// visible; that one can, and "a table nobody can classify is where the next
// hole lives" is the reason to care.
//
// Four verdicts from that file are worth repeating here because they are
// counter-intuitive and someone will otherwise try to "fix" them:
//
//   users            — permanently TOLERANT for now. server/db.js seeds an
//                      admin with organization_id NULL when more than one org
//                      exists (deliberately — "it stays NULL and says so"),
//                      and sub-portal invite acceptance lands NULL when
//                      neither the sub's nor the inviter's org is known. Both
//                      are inside init(). A NOT NULL here is a BOOT CRASH
//                      LOOP, not a failed migration, and it would also delete
//                      the only exit from ORG_UNRESOLVED.
//   attachments      — PARENT-anchored, not column-anchored. NOT NULL there
//                      buys nothing the parent does not already give and costs
//                      the most, on the largest table in the database. Same
//                      for ai_messages and messages, whose anchor is user_id.
//   assembly_trades / assembly_systems / assembly_variants
//                    — NULL is CORRECT DATA, re-inserted on every boot by
//                      seedGlobalTaxonomy. Their uniqueness indexes are built
//                      on COALESCE(organization_id, 0), which only makes sense
//                      with NULLs present.
//   ai_evals / ai_eval_runs / agent_skills_versions / roles / app_settings
//                    — PLATFORM. No tenant exists to stamp, and for
//                      agent_skills_versions none can be invented: a child
//                      cannot carry a tenant its parent does not have. The
//                      control on these is the CAPABILITY (SYSTEM_ADMIN), not
//                      a predicate.
const { pool } = require('./db');

// SELECT-1 existence check per entity type. Returns true iff the entity is in
// (or compatible with) the caller's org. Fail-closed on missing ids/errors.
async function assertEntityInOrg(entityType, entityId, orgId) {
  if (entityId == null || orgId == null) return false;
  let sql;
  switch (entityType) {
    // OR-IS-NULL (org tolerance) on all four. The POINTER changed (owner join
    // → own column); the tolerance did not.
    case 'job':
      sql = `SELECT 1 FROM jobs j
             WHERE j.id = $1 AND (j.organization_id = $2 OR j.organization_id IS NULL) LIMIT 1`;
      break;
    case 'estimate':
      sql = `SELECT 1 FROM estimates e
             WHERE e.id = $1 AND (e.organization_id = $2 OR e.organization_id IS NULL) LIMIT 1`;
      break;
    case 'lead':
      // leads has NO owner_id column. The previous form was a 42703 on every
      // call, swallowed by the catch below into a fail-closed `false`.
      sql = `SELECT 1 FROM leads l
             WHERE l.id = $1 AND (l.organization_id = $2 OR l.organization_id IS NULL) LIMIT 1`;
      break;
    case 'change_order':
      // Through the parent JOB'S COLUMN — job_change_orders carries its own
      // organization_id too, but the job is the anchor (see
      // services/org-table-classification.js: parent).
      sql = `SELECT 1 FROM job_change_orders co
               JOIN jobs j ON j.id = co.job_id
             WHERE co.id = $1 AND (j.organization_id = $2 OR j.organization_id IS NULL) LIMIT 1`;
      break;
    case 'schedule_entry':
      // `OR s.job_id IS NULL` was an UNCONDITIONAL open arm: it named neither
      // the caller nor the caller's org, so every standalone schedule entry in
      // every tenant passed this check for everybody — and this gates PUT and
      // DELETE on schedule-routes. The two arms are now explicitly disjoint on
      // s.job_id, which also stops the LEFT JOIN from re-creating the same hole
      // (a job-less entry makes j.organization_id NULL, and the tolerance arm
      // would then pass it unconditionally all over again).
      //
      // Job-linked entries scope through the JOB'S COLUMN — the canonical
      // pointer — rather than through the job owner's org. Entries with no job
      // fall back to their own stamped column, then to their creator's org, so
      // standalone entries created before that column was stamped aren't lost.
      sql = `SELECT 1 FROM schedule_entries s
               LEFT JOIN jobs j ON j.id = s.job_id
               LEFT JOIN users uc ON uc.id = s.created_by
             WHERE s.id = $1 AND (
                   (s.job_id IS NOT NULL AND
                      (j.organization_id = $2 OR j.organization_id IS NULL))
                OR (s.job_id IS NULL AND
                      (s.organization_id = $2 OR s.organization_id IS NULL
                       OR uc.organization_id = $2 OR uc.organization_id IS NULL))
             ) LIMIT 1`;
      break;
    case 'project':
      sql = `SELECT 1 FROM projects
             WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL) LIMIT 1`;
      break;
    default:
      return false;
  }
  try {
    const { rows } = await pool.query(sql, [entityId, orgId]);
    return rows.length > 0;
  } catch (e) {
    console.error('[org-access] assertEntityInOrg failed', entityType, e.message);
    return false; // fail-closed
  }
}

// Caller's org id from the JWT (mirrors org-manifest-routes.callerOrgId).
function callerOrgId(req) {
  const oid = req && req.user && req.user.organization_id;
  return oid != null ? oid : null;
}

module.exports = { assertEntityInOrg, callerOrgId };
