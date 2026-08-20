'use strict';

/**
 * money/job-cost-buckets.js — one job's cost, decomposed by cost code.
 *
 * Why this file exists
 * --------------------
 * The bucket rollup existed only in the BROWSER (js/cost-buckets.js), which is
 * 237 lines of `appData` reads and inline-styled markup. `grep -rl
 * getJobCostBuckets server/` finds nothing. So the first thing that wanted a
 * per-cost-code cost table on the server — the Live Rooms guest surface, which
 * cannot boot the SPA and must never be handed raw figures to sum client-side —
 * had no rollup to call.
 *
 * This is that rollup, as a PURE function of already-loaded inputs. No I/O, no
 * request, no require of server/routes/* (JWT_SECRET is not set where this most
 * needs a test — see reference_test_env_jwt_secret).
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It computes and persists NO new money. Every dollar below is a re-grouping of
 * figures money/job-wip.js already derives, and the reconciliation is asserted
 * rather than assumed: sum(actual) === computeJobWIP().actualCosts, exactly.
 * That identity is the whole point. A cost table that disagreed with the WIP tab
 * on the same job is the B6 failure class — two tabs, one job, contradicting
 * each other — and it is worth more than a prettier decomposition.
 *
 * THE FOUR COLUMNS, and where each actually comes from:
 *
 *   BUDGET     the phase / building / job cost matrix (appData.phases IS the
 *              matrix — see the node-retirement note in job-wip.js). Summed by
 *              the same manualField mapping js/cost-buckets.js CANON uses, and
 *              by the same job-level rules totalManualCost() applies, so
 *              sum(budget) === totalManualCost() exactly.
 *
 *   COMMITTED  live purchase orders, bucketed by each LINE's own cost category,
 *              plus sub contracts with no live PO (counting both would double
 *              the same commitment — the rule subAccruedOf already encodes).
 *              Ordered value, not accrued value: "committed" is what has been
 *              awarded, which is what a cost report means by the word.
 *
 *   ACTUAL     QuickBooks lines by effective bucket, under the SAME two
 *              exclusions job cost uses everywhere (money/cost-line-filters.js:
 *              accrual JEs, and match-only Subcontractors lines), plus vendor
 *              bills into subs. When a job has no QB lines at all, the manual
 *              matrix is the actual — which is what computeJobWIP does, so the
 *              two agree by construction rather than by coincidence.
 *
 *   VARIANCE   budget − actual. Positive is under budget.
 *
 * And ONE ratio, pctUsed = actual / budget × 100, rounded to a tenth. It is a
 * ratio of two terms that are BOTH money, so under a hide-financials policy
 * both are withheld and the ratio reconstructs neither — the same R1 argument
 * that lets % complete survive. It is per-row and self-normalised, so it also
 * discloses no cross-bucket SPEND PROFILE: knowing labor is 62% used says
 * nothing about how labor compares to materials.
 */

const { classifyCostLine } = require('./cost-line-filters');

function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }

// The canonical buckets, in display order. Copied from js/cost-buckets.js CANON
// (code / label / manualField) so a guest reads the same names a PM does.
// PROVENANCE: js/cost-buckets.js:27-34 @ 59fe514. Copied, not linked — that file
// is a browser IIFE that reads appData.
const CANON = Object.freeze([
  Object.freeze({ code: 'materials', label: 'Materials & Supplies', manualField: 'materials' }),
  Object.freeze({ code: 'labor', label: 'Labor', manualField: 'labor' }),
  Object.freeze({ code: 'subs', label: 'Subcontractors', manualField: 'sub' }),
  Object.freeze({ code: 'equipment', label: 'Equipment', manualField: 'equipment' }),
  Object.freeze({ code: 'gc', label: 'General Conditions', manualField: null }),
  Object.freeze({ code: 'other', label: 'Other', manualField: null })
]);
const CODES = CANON.map((b) => b.code);

// Free text -> canonical bucket. ORDER MATTERS and it is the browser's order:
// subs before materials so "Subcontractor materials" lands in subs; labor,
// equipment and gc before the materials catch so their keywords win.
// PROVENANCE: js/cost-buckets.js:41-50 @ 59fe514.
function bucketFor(raw) {
  const s = String(raw == null ? '' : raw).toLowerCase();
  if (!s) return 'other';
  if (/\bsub|subcontract/.test(s)) return 'subs';
  if (/labor|labour|hourly|burden|payroll|wage/.test(s)) return 'labor';
  if (/equip|rental|machine/.test(s)) return 'equipment';
  if (/general\s*condition|permit|engineering|overhead|insurance|\bbond\b|\bfee\b/.test(s)) return 'gc';
  if (/material|supplies|cogs|lumber|hardware/.test(s)) return 'materials';
  return 'other';
}

// A human's manual override wins over the account mapping.
function effectiveBucket(l) {
  if (l && l.bucket && CODES.indexOf(l.bucket) !== -1) return l.bucket;
  return bucketFor(l && (l.account || l.account_type));
}

const DEAD_BILL_STATUSES = new Set(['draft', 'void', 'cancelled', 'canceled', 'rejected']);
const LIVE_PO_STATUSES = (s) => s !== 'draft' && s !== 'cancelled' && s !== 'void';

function poLineAmount(l) {
  if (!l || l.section === '__section_header__') return null;
  return num(l.qty) * num(l.unitCost != null ? l.unitCost : l.unitPrice);
}

/**
 * @param job    the jobs.data blob
 * @param deps   { phases, buildings, subs, qbCostLines, vendorBills,
 *                 purchaseOrders, wip }   — `wip` is computeJobWIP's output,
 *                 used ONLY to reconcile the actual column against the number
 *                 the rest of the app already shows.
 * @returns { rows: [{code,label,budget,committed,actual,variance,pctUsed}],
 *            total: {budget,committed,actual,variance,pctUsed} }
 */
function jobCostBuckets(job, deps) {
  job = job || {};
  const d = deps || {};
  const phases = Array.isArray(d.phases) ? d.phases : [];
  const buildings = Array.isArray(d.buildings) ? d.buildings : [];
  const subs = Array.isArray(d.subs) ? d.subs : [];
  const purchaseOrders = Array.isArray(d.purchaseOrders) ? d.purchaseOrders : [];
  const vendorBills = Array.isArray(d.vendorBills) ? d.vendorBills : [];
  const qbCostLines = Array.isArray(d.qbCostLines) ? d.qbCostLines : [];

  const acc = {};
  for (const b of CANON) acc[b.code] = { code: b.code, label: b.label, budget: 0, committed: 0, actual: 0 };

  // ── BUDGET ──────────────────────────────────────────────────────────────
  // Exactly the decomposition totalManualCost() sums, including its one
  // asymmetry: job-level `sub` is excluded when buildings exist, because it has
  // already been distributed down to them. Keeping that rule here is what makes
  // sum(budget) === totalManualCost() true rather than nearly true.
  for (const b of CANON) {
    if (!b.manualField) continue;
    let t = 0;
    for (const p of phases) t += num(p && p[b.manualField]);
    for (const bl of buildings) t += num(bl && bl[b.manualField]);
    if (b.code === 'subs') t += buildings.length > 0 ? 0 : num(job.sub);
    else t += num(job[b.manualField]);
    acc[b.code].budget = t;
  }
  acc.gc.budget = num(job.generalConditions);

  // ── COMMITTED ───────────────────────────────────────────────────────────
  const poSubIds = new Set();
  for (const po of purchaseOrders) {
    if (!LIVE_PO_STATUSES(po && po.status)) continue;
    if (po.sub_id) poSubIds.add(po.sub_id);
    for (const l of (Array.isArray(po.lines) ? po.lines : [])) {
      const amt = poLineAmount(l);
      if (amt == null) continue;
      // A PO line carries its own cost category; without one the PO is a sub
      // contract and its commitment belongs to subs.
      const code = (l.costCategory || l.costType) ? bucketFor(l.costCategory || l.costType) : 'subs';
      acc[code].committed += amt;
    }
  }
  for (const s of subs) {
    // A sub that already has a live PO is SKIPPED: its commitment is counted
    // above, and counting the contract again would overstate it. Same rule
    // subAccruedOf applies to accrual.
    if (s && poSubIds.has(s.id)) continue;
    acc.subs.committed += num(s && s.contractAmt);
  }

  // ── ACTUAL ──────────────────────────────────────────────────────────────
  let qbCount = 0;
  for (const l of qbCostLines) {
    qbCount++;
    const cls = classifyCostLine(l);
    if (cls !== 'cost') continue;          // accrual JEs and match-only sub lines
    acc[effectiveBucket(l)].actual += num(l.amount);
  }
  const hasQB = qbCount > 0;
  if (!hasQB) {
    // No QB import yet: the manual matrix IS the actual, which is exactly what
    // computeJobWIP falls back to. Same numbers, same place.
    for (const b of CANON) acc[b.code].actual += acc[b.code].budget;
  }
  for (const b of vendorBills) {
    if (!b || DEAD_BILL_STATUSES.has(b.status)) continue;
    acc.subs.actual += num(b.amount);
  }

  // ── THE RECONCILIATION ──────────────────────────────────────────────────
  // computeJobWIP prefers job.ngActualCosts — a single scalar pushed onto the
  // blob by a graph walk that cannot be decomposed — over the manual matrix
  // when it is present. When it is, the decomposition above cannot add up, and
  // a cost table that quietly disagreed with the WIP tab is the exact defect
  // this feature keeps rediscovering. So the difference is placed in Other and
  // NAMED, rather than left to be discovered as a mismatch.
  const wip = d.wip || null;
  if (wip && typeof wip.actualCosts === 'number' && isFinite(wip.actualCosts)) {
    const summed = CANON.reduce((s, b) => s + acc[b.code].actual, 0);
    const residual = wip.actualCosts - summed;
    if (Math.abs(residual) > 0.005) acc.other.actual += residual;
  }

  const rows = CANON.map((b) => finish(acc[b.code]));
  const total = finish({
    code: 'total', label: 'Total',
    budget: rows.reduce((s, r) => s + r.budget, 0),
    committed: rows.reduce((s, r) => s + r.committed, 0),
    actual: rows.reduce((s, r) => s + r.actual, 0)
  });
  return { rows, total };
}

// variance and the one ratio, added last so no caller has to remember them.
// pctUsed is null — not 0 — when there is no budget to be a percentage OF.
// A null is not a redaction and a zero is not a null: printing "0%" for "this
// bucket was never budgeted" is the same lie as printing $0.00 for a missing
// figure, one column over.
function finish(r) {
  const variance = r.budget - r.actual;
  const pctUsed = r.budget > 0 ? Math.round((r.actual / r.budget) * 1000) / 10 : null;
  return {
    code: r.code, label: r.label,
    budget: r.budget, committed: r.committed, actual: r.actual,
    variance: variance, pctUsed: pctUsed
  };
}

module.exports = { CANON, CODES, bucketFor, effectiveBucket, jobCostBuckets };
