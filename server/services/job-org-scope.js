// One rule for every statement reachable by a caller-supplied job_id.
//
// WHY THIS EXISTS
// The tenant survey that produced the last three commits counted statements
// naming `jobs`. Every door below is keyed on job_id in a CHILD table, so none
// of them appeared in that count — and that is where the unfixed copies of the
// same defect lived: an org-A caller could inject, re-bucket, re-attribute and
// delete an org-B job's QB cost lines, and attach a schedule entry to an org-B
// job that then emailed that job's whole data blob to org-A recipients. Adding
// a predicate to a `jobs` statement fixes none of that, because these
// statements never name `jobs` at all.
//
// So the rule is stated on the KEY, not on the table:
//
//   every statement reachable by a caller-supplied job_id must prove the
//   PARENT JOB is in the caller's org before it reads or writes.
//
// THE POINTER
// The COLUMN is canonical (see the N1 commit). Some readers here scope through
// `owner_id -> users.organization_id` instead — a THIRD scoping mechanism on
// the same table family — and those are moved onto the column as they are
// touched. The `OR organization_id IS NULL` tolerance arm is preserved
// verbatim: dropping it is its own reviewed change, gated on the stamp audit
// reading zero, and dropping it here while NULL rows exist would lock AGX out
// of its own cost data.

// The set of job ids, out of `ids`, whose row is in `orgId` (or is a legacy
// NULL-org row). Ids not present in the result are either absent or another
// tenant's — the caller cannot tell those apart, which is deliberate.
async function jobIdsInOrg(runner, ids, orgId) {
  const wanted = [...new Set((ids || []).filter(Boolean).map(String))];
  if (!wanted.length) return new Set();
  const r = await runner.query(
    `SELECT id FROM jobs
      WHERE id = ANY($1::text[])
        AND (organization_id = $2 OR organization_id IS NULL)`,
    [wanted, orgId]
  );
  return new Set(r.rows.map((x) => x.id));
}

// True when this one job is reachable by this tenant.
async function jobInOrg(runner, jobId, orgId) {
  if (!jobId) return false;
  return (await jobIdsInOrg(runner, [jobId], orgId)).has(String(jobId));
}

// A SQL fragment for statements that must filter rather than pre-check —
// bulk UPDATEs and DELETEs keyed on the child row's own id, where a JS
// pre-check would be a second round-trip and a TOCTOU besides.
//
//   jobIdExpr — how the statement names its job_id column, e.g.
//               'qb_cost_lines.job_id'
//   param     — the bound placeholder holding the caller's org, e.g. '$3'
//
// The alias is deliberately obscure so it cannot collide with a caller's own.
function parentJobInOrgSql(jobIdExpr, param) {
  return `EXISTS (SELECT 1 FROM jobs j_org_scope
                   WHERE j_org_scope.id = ${jobIdExpr}
                     AND (j_org_scope.organization_id = ${param}
                          OR j_org_scope.organization_id IS NULL))`;
}

module.exports = { jobIdsInOrg, jobInOrg, parentJobInOrgSql };
