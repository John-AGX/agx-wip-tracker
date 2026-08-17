// One rule for every statement reachable by a caller-supplied SUB id — and
// the grant target beside it.
//
// WHY THIS EXISTS
// `services/job-org-scope.js` states the rule on the job key. sub-routes.js is
// keyed on BOTH: job_id on the assignment doors, sub_id on the directory,
// certificate and grant doors. Neither key was proved anywhere in the file.
//
// THE SHARP PART. Commit a243b76 ("money rows are born inside a tenant")
// modified the very INSERTs that were open here: it added
// `(SELECT organization_id FROM jobs WHERE id = $2)` to the job_subs inserts,
// and in the same commit scoped notifySubAssigned because "unscoped, an
// assignment against a foreign job id mailed that job's identity
// off-platform." The author was looking straight at the door, closed the email
// leak, and left the write open.
//
// The net effect on DETECTION was negative. Before that stamp, a forged
// assignment landed organization_id NULL and the boot stamp audit could count
// it. After it, the subselect reads the org off the PARENT JOB — org B — so a
// row an org-A admin planted lands stamped org B and is indistinguishable from
// org B's own data. This is the interaction already named for N4: stamping the
// INSERT removed the orphaned-NULL tell. It recurred one table over, inside the
// commit written to answer it, because the rule was applied to the STAMP and
// not to the DOOR.
//
// So: prove the key at the DOOR. A stamp is where the row says which tenant it
// is in. A predicate is where the server decides.

// The tables an attachment grant may point at. A WHITELIST, mapping the
// caller's entity_type to a table name — the type is never interpolated into
// SQL from the request, only looked up here. Every one of these carries
// organization_id directly.
const ENTITY_TABLES = {
  job: 'jobs',
  lead: 'leads',
  estimate: 'estimates',
  client: 'clients',
  sub: 'subs',
};

// True when this one sub is reachable by this tenant.
//
// The `OR organization_id IS NULL` arm is the same tolerance every read in
// this repo carries, and `GET /api/subs/:id` has scoped exactly this way since
// Wave A — this makes the write agree with the read that was already right.
async function subInOrg(runner, subId, orgId) {
  if (!subId) return false;
  const r = await runner.query(
    `SELECT 1 FROM subs
      WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)
      LIMIT 1`,
    [String(subId), orgId]
  );
  return r.rows.length > 0;
}

// True when the entity an attachment grant names is reachable by this tenant.
// An unknown entity_type is FALSE, not an error and not a pass: a grant that
// cannot be scoped is a grant that must not be written.
async function grantEntityInOrg(runner, entityType, entityId, orgId) {
  const table = ENTITY_TABLES[String(entityType || '')];
  if (!table || !entityId) return false;
  const r = await runner.query(
    `SELECT 1 FROM ${table}
      WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)
      LIMIT 1`,
    [String(entityId), orgId]
  );
  return r.rows.length > 0;
}

// A SQL fragment for statements that must filter rather than pre-check —
// UPDATEs and DELETEs keyed on the child row's own id, where a JS pre-check
// would be a second round-trip and a TOCTOU besides. Mirrors
// parentJobInOrgSql; the alias is deliberately obscure so it cannot collide.
function parentSubInOrgSql(subIdExpr, param) {
  return `EXISTS (SELECT 1 FROM subs s_org_scope
                   WHERE s_org_scope.id = ${subIdExpr}
                     AND (s_org_scope.organization_id = ${param}
                          OR s_org_scope.organization_id IS NULL))`;
}

module.exports = { subInOrg, grantEntityInOrg, parentSubInOrgSql, ENTITY_TABLES };
