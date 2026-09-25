'use strict';
/**
 * money/sub-commitments.js — what a subcontractor is contracted for, and what
 * they have billed, rolled up across every job.
 *
 * WHY THIS EXISTS. The Subs directory used to read these two figures from
 * `job_subs.contract_amt` / `.billed_to_date`. Nothing writes those columns any
 * more: the only code that creates a job_subs row from a purchase order
 * (services/po-sub-access.js) inserts `0, 0` and never updates them, and the
 * per-job editor that once typed them by hand is gone. So the directory
 * reported $0 contracted for every sub while $1.36M of live purchase orders
 * sat against them — measured on the live org, 2026-09-25, 16 subs.
 *
 * The job page had already moved: js/jobs.js jobSubsFromPOs() says "a PO with a
 * sub_id IS a sub on the job (appData.subs isn't the source of truth)". This is
 * that same rule, server-side, so the directory and the job page cannot
 * disagree — they now compute from the same records with the same predicates.
 *
 * The job_subs row is still the ASSIGNMENT (which jobs a sub is on, and their
 * portal access). Only the MONEY moved.
 */

const { poEffectiveTotal } = require('../job-financials');

// A purchase order that is not yet real, or no longer real, commits nothing.
// This is a DENY list because js/jobs.js `_JB_PO_DEAD` is one, and the
// directory has to agree with the job page sub-for-sub.
//
// NOTE, and it is a real one: three PO-status predicates exist in this codebase
// and they are not the same set —
//   _JB_PO_DEAD (js/jobs.js)              deny  draft/void/cancelled/canceled/rejected
//   LIVE_PO_STATUSES (money/job-wip.js)   deny  draft/cancelled/void
//   PO_ACTIVE_STATUS (po-sub-access.js)   allow issued/approved/work_complete/closed
// On the live org today all three select the same 96 POs (statuses present:
// approved, issued, work_complete), so the drift is latent. Converging them is
// its own change with its own census; this file deliberately copies the one the
// visible surface uses rather than inventing a fourth.
const PO_DEAD = new Set(['draft', 'void', 'cancelled', 'canceled', 'rejected']);
function poIsLive(status) {
  return !PO_DEAD.has(String(status == null ? '' : status).trim().toLowerCase());
}

// Matches js/jobs.js poRowBilled, which excludes ONLY void. Deliberately not
// money/job-wip.js billedCostOf, which also drops draft/cancelled/rejected: the
// figure beside a sub on the job page is the void-only one, and a directory
// that quietly used a stricter rule would just be a second number to reconcile.
const BILL_DEAD = new Set(['void']);
function billCounts(status) {
  return !BILL_DEAD.has(String(status == null ? '' : status).trim().toLowerCase());
}

/**
 * Fold PO rows + bill rows into per-sub totals.
 *
 * poRows:   [{ id, sub_id, job_id, status, data }]  — data holds lines/baseline
 * billRows: [{ po_id, amount, status }]
 *
 * Returns Map(sub_id -> { contracted, billed, po_count, job_count }).
 * A PO with no sub_id belongs to nobody's directory row and is skipped — it is
 * still real cost on its job, it just has no subcontractor to roll up to.
 */
function rollupBySub(poRows, billRows) {
  const billedByPo = new Map();
  for (const b of billRows || []) {
    if (!b || !b.po_id || !billCounts(b.status)) continue;
    const n = Number(b.amount);
    if (!isFinite(n)) continue;
    billedByPo.set(b.po_id, (billedByPo.get(b.po_id) || 0) + n);
  }

  const out = new Map();
  const jobsBySub = new Map();
  for (const po of poRows || []) {
    if (!po || !po.sub_id || !poIsLive(po.status)) continue;
    const slot = out.get(po.sub_id) ||
      { contracted: 0, billed: 0, po_count: 0, job_count: 0 };
    slot.contracted += Number(poEffectiveTotal(po.data || {})) || 0;
    slot.billed += billedByPo.get(po.id) || 0;
    slot.po_count += 1;
    out.set(po.sub_id, slot);

    if (po.job_id) {
      const seen = jobsBySub.get(po.sub_id) || new Set();
      seen.add(po.job_id);
      jobsBySub.set(po.sub_id, seen);
    }
  }
  for (const [subId, seen] of jobsBySub) out.get(subId).job_count = seen.size;
  return out;
}

/**
 * Load the two tables and roll them up, for one org.
 *
 * Scoped through the JOB, the same way purchase-order-routes and
 * job-financials scope every PO read: a purchase order belongs to whatever
 * tenant its job belongs to, so the job's stamp is the unforgeable one.
 */
async function subCommitments(db, orgId) {
  const [pos, bills] = await Promise.all([
    db.query(
      `SELECT po.id, po.sub_id, po.job_id, po.status, po.data
         FROM job_purchase_orders po
         JOIN jobs j ON j.id = po.job_id
        WHERE po.sub_id IS NOT NULL
          AND (j.organization_id = $1 OR j.organization_id IS NULL)`,
      [orgId]
    ),
    db.query(
      `SELECT b.po_id, b.amount, b.status
         FROM job_vendor_bills b
         JOIN jobs j ON j.id = b.job_id
        WHERE b.po_id IS NOT NULL
          AND (j.organization_id = $1 OR j.organization_id IS NULL)`,
      [orgId]
    ),
  ]);
  return rollupBySub(pos.rows || [], bills.rows || []);
}

module.exports = { subCommitments, rollupBySub, poIsLive, billCounts, PO_DEAD, BILL_DEAD };
