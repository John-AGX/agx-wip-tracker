'use strict';
// PO-driven sub portal access — ONE grant, two doors.
//
// Moved here from routes/purchase-order-routes.js so the Buildertrend sync
// (services/clickr/sync-apply.js) grants a sub exactly what the PO page grants.
// The PO page calls it after its status and update writes; the sync calls it
// after a purchase-order transaction COMMITS, with the PO row re-read from the
// database. It writes through the pool, never inside a caller's transaction,
// so it can only ever act on a PO write that persisted.
//
// "This file" in the security note below is routes/purchase-order-routes.js,
// where the hole was found and closed; the note moved with the code it guards.

const { pool } = require('../db');
const fileFolders = require('./file-folders');
// The tenant boundary on a caller-supplied SUB id. See the block comment above
// grantSubAccessForPO.
const { subInOrg } = require('./sub-org-scope');

// ── #4: PO-driven sub access ────────────────────────────────────────
// When a PO is ISSUED to a sub (or a sub is re-assigned on an already-
// issued PO), the sub auto-gains (a) a job-level job_subs assignment and
// (b) view/upload access to the JOB's folders — so the job they're
// working shows up in their portal. Granted at ISSUE, never on a draft,
// so shopping a PO around can't leak access. Idempotent + best-effort:
// safe to call from multiple hooks, and it never blocks the PO write.
//
// THE HOLE THIS CLOSES. sub_id arrives in the REQUEST BODY on both the create
// and the update door, and this file contained no subInOrg / parentSubInOrgSql
// anywhere — the only thing it proved was that the JOB belongs to the caller.
// So an admin in org A could name org B's sub id on a PO, issue it, and this
// function would write org B's sub an attachment_folder_grants row pointed at
// org A's job folder. The sub portal then reads grants BY sub_id alone
// (sub-portal-routes.js), so that is a DURABLE cross-tenant read channel into
// a job's files — created by a normal, authorized-looking PO issue.
//
// Note what stamping could not have fixed: the job_subs INSERT below already
// reads organization_id off the PARENT JOB, so a forged assignment lands
// stamped org A and is indistinguishable from org A's own data. Stamping the
// row REMOVED the orphaned-NULL tell. The rule (services/sub-org-scope.js) is
// to prove the key at the DOOR: a stamp is where the row says which tenant it
// is in; a predicate is where the server decides.
const PO_ACTIVE_STATUS = new Set(['issued', 'approved', 'work_complete', 'closed']);
async function grantSubAccessForPO(poRow, userId, orgId) {
  try {
    if (!poRow || !poRow.sub_id || !poRow.job_id) return;
    if (!PO_ACTIVE_STATUS.has(String(poRow.status || ''))) return;
    const subId = poRow.sub_id, jobId = poRow.job_id;
    // Fail CLOSED: no org, or a sub outside it, grants nothing. This is
    // best-effort by design (it never blocks the PO write), so the refusal is
    // logged rather than thrown — but it is logged, because a silently skipped
    // grant and a silently granted foreign sub look identical from outside.
    if (orgId == null || !(await subInOrg(pool, subId, orgId))) {
      console.warn('[po sub-access] refused: sub ' + subId + ' is not in org ' + orgId +
        ' — no job_subs assignment and no folder grant written for job ' + jobId);
      return;
    }
    // (a) idempotent job-level assignment (building/phase stay node-driven)
    await pool.query(
      // organization_id off the PARENT JOB, never off the caller. A job_subs
      // row belongs to whatever tenant its job belongs to, so reading the stamp
      // from the row makes it unforgeable. It used to land NULL and be healed by
      // the boot backfill; gating that backfill (9c1626a) was correct and turned
      // this into a STANDING null, visible to every tenant through the tolerance
      // arm on every read. Stamp at insert instead — never un-gate the backfill.
      `INSERT INTO job_subs (id, job_id, sub_id, level, building_id, phase_id,
                             contract_amt, billed_to_date, status, notes, organization_id)
       VALUES ($1, $2, $3, 'job', NULL, NULL, 0, 0, 'active', NULL,
               (SELECT organization_id FROM jobs WHERE id = $2))
       ON CONFLICT (job_id, sub_id) DO NOTHING`,
      ['jsub_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), jobId, subId]
    );
    // (b) job folder grant — this row is what surfaces the job in the sub portal
    let folderId = null;
    try {
      const leaf = await fileFolders.ensureFolderChain('job', jobId, 'general');
      if (leaf && leaf.id) folderId = leaf.id;
    } catch (e) { /* folder_id NULL still resolves via the string match */ }
    await pool.query(
      `INSERT INTO attachment_folder_grants
         (id, sub_id, entity_type, entity_id, folder, folder_id, granted_by)
       VALUES ($1, $2, 'job', $3, 'general', $4, $5)
       ON CONFLICT (sub_id, entity_type, entity_id, folder) DO UPDATE
         SET granted_at = NOW(), granted_by = EXCLUDED.granted_by,
             folder_id = COALESCE(EXCLUDED.folder_id, attachment_folder_grants.folder_id)`,
      ['afg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), subId, jobId, folderId, userId || null]
    );
    // Both rows are written: the sub has portal access to the job's files. The
    // PO page ignores this; the Buildertrend sync reports it (results[].subAccess).
    return true;
  } catch (e) {
    console.warn('[po sub-access] auto-grant failed (non-fatal):', e && e.message);
  }
}

module.exports = { PO_ACTIVE_STATUS, grantSubAccessForPO };
