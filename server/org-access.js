// ── Multi-tenant org-access helper (Wave A) ──────────────────────────────
// Centralizes "does this entity belong to the caller's org?" so by-id reads
// and mutations (attachments, change-orders, schedule, AI entity context)
// gate identically.
//
// Scoping source of truth = the OWNER user's org (owner_id → users.organization_id)
// for owner-scoped tables, or the direct organization_id column for projects.
//
// NO-OP-FOR-AGX SAFETY: the `OR <col> IS NULL` clause keeps every check a no-op
// for AGX's current (partly un-stamped) data — it can never hide a row AGX can
// see today. It mirrors the existing change-orders/summary route. Once all rows
// are org-stamped (the Buildertrend re-import), drop the `OR ... IS NULL`
// clauses here + in the route filters to make this hard-strict before a 2nd org
// is onboarded. Search this repo for "OR-IS-NULL (org tolerance)" to find them.
const { pool } = require('./db');

// SELECT-1 existence check per entity type. Returns true iff the entity is in
// (or compatible with) the caller's org. Fail-closed on missing ids/errors.
async function assertEntityInOrg(entityType, entityId, orgId) {
  if (entityId == null || orgId == null) return false;
  let sql;
  switch (entityType) {
    case 'job':
      sql = `SELECT 1 FROM jobs j JOIN users u ON u.id = j.owner_id
             WHERE j.id = $1 AND (u.organization_id = $2 OR u.organization_id IS NULL) LIMIT 1`;
      break;
    case 'estimate':
      sql = `SELECT 1 FROM estimates e JOIN users u ON u.id = e.owner_id
             WHERE e.id = $1 AND (u.organization_id = $2 OR u.organization_id IS NULL) LIMIT 1`;
      break;
    case 'lead':
      sql = `SELECT 1 FROM leads l JOIN users u ON u.id = l.owner_id
             WHERE l.id = $1 AND (u.organization_id = $2 OR u.organization_id IS NULL) LIMIT 1`;
      break;
    case 'change_order':
      sql = `SELECT 1 FROM job_change_orders co
               JOIN jobs j ON j.id = co.job_id
               JOIN users u ON u.id = j.owner_id
             WHERE co.id = $1 AND (u.organization_id = $2 OR u.organization_id IS NULL) LIMIT 1`;
      break;
    case 'schedule_entry':
      // Job-linked entries scope through the job's owner; entries with no job
      // fall back to their own creator's org so standalone entries aren't lost.
      sql = `SELECT 1 FROM schedule_entries s
               LEFT JOIN jobs j ON j.id = s.job_id
               LEFT JOIN users uj ON uj.id = j.owner_id
               LEFT JOIN users uc ON uc.id = s.created_by
             WHERE s.id = $1 AND (
                   uj.organization_id = $2 OR uj.organization_id IS NULL
                OR uc.organization_id = $2 OR uc.organization_id IS NULL
                OR s.job_id IS NULL
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
