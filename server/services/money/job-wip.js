'use strict';

/**
 * money/job-wip.js — job WIP, computed server-side from the real tables.
 *
 * Why this file exists
 * --------------------
 * `computeJobWIP` in server/routes/ai-routes.js claimed to "mirror getJobWIP()
 * in js/wip.js so the AI sees the same numbers the PM sees on the workspace."
 * It did not. It was a much smaller formula that omitted, entirely:
 *
 *   - QuickBooks actuals (linked qb_cost_lines) — the cost source of truth
 *   - vendor/sub bills (job_vendor_bills) — incurred cost
 *   - PO accrual and sub accrual — committed cost
 *   - projectedCost / projectedProfit
 *   - displayProfit / displayMargin — the headline figures on the job card
 *
 * So 86 was quoting a job's margin from a formula the PM's screen does not
 * use. This is a port of the browser's getJobWIP (js/jobs.js), not a second
 * opinion: same order of operations, same rounding, same fallbacks. Where the
 * browser reads an appData array, this reads the table that array is loaded
 * from — a data-source swap, deliberately not a redesign.
 *
 * The node-graph values (ngActualCosts, ngRevenueEarned, ngBacklog,
 * ngAccruedCosts) are read off the jobs blob exactly as the browser reads
 * them. They are computed by a stateful graph walk in nodegraph/ui.js that
 * cannot be ported; the browser pushes them onto the job, and both sides then
 * consume them identically. When they are absent, both fall back to the same
 * local formula.
 */

const jobMoney = require('./change-order-totals');

function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }

// A CO's money only joins the contract once approved/applied. changeOrdersForJob
// already zeroes income/costs for un-approved rows, so summing is enough.
// unlinkedIncome tracks COs NOT wired to a graph node: the graph's
// ngRevenueEarned only knows about graph revenue, so an unlinked CO's earned
// share has to be added on top or it never reaches Revenue Earned.
function coTotals(changeOrders) {
  const rows = Array.isArray(changeOrders) ? changeOrders : [];
  let income = 0, costs = 0, unlinkedIncome = 0;
  for (const c of rows) {
    income += num(c.income);
    costs += num(c.costs);
    if (!c.linked_node_id) unlinkedIncome += num(c.income);
  }
  return { income, costs, unlinkedIncome, count: rows.length };
}

// Manual/wired cost from the jobs blob. Job-level `sub` is excluded when
// buildings exist because it has already been distributed to them.
function totalManualCost(job, phases, buildings) {
  let phaseCost = 0;
  for (const p of phases) {
    phaseCost += num(p.materials) + num(p.labor) + num(p.sub) + num(p.equipment);
  }
  let buildingCost = 0;
  for (const b of buildings) {
    buildingCost += num(b.materials) + num(b.labor) + num(b.sub) + num(b.equipment);
  }
  const jobSub = buildings.length > 0 ? 0 : num(job.sub);
  const jobCost = num(job.materials) + num(job.labor) + jobSub
    + num(job.equipment) + num(job.generalConditions);
  return phaseCost + buildingCost + jobCost;
}

const DEAD_BILL_STATUSES = new Set(['draft', 'void', 'cancelled', 'canceled', 'rejected']);

// What subs have actually invoiced — incurred cost, so it lands in ACTUAL.
function billedCostOf(vendorBills) {
  return (vendorBills || []).reduce(
    (s, b) => (b && !DEAD_BILL_STATUSES.has(b.status) ? s + num(b.amount) : s), 0);
}

const LIVE_PO_STATUSES = (s) => s !== 'draft' && s !== 'cancelled' && s !== 'void';

function poOrderedTotal(po) {
  return (Array.isArray(po && po.lines) ? po.lines : []).reduce((s, l) => {
    if (!l || l.section === '__section_header__') return s;
    return s + num(l.qty) * num(l.unitCost);
  }, 0);
}

// Billed against one PO, from the unified job_vendor_bills store.
function poBilled(po, vendorBills) {
  return (vendorBills || []).reduce(
    (s, b) => (b && b.po_id === po.id && b.status !== 'void' ? s + num(b.amount) : s), 0);
}

// Open PO commitment: earned by progress (ordered × job % complete) net of
// what the sub has already billed. Only the still-unbilled earned amount is
// accrued — once billed, that dollar moves to ACTUAL via billedCostOf, so the
// two never overlap and nothing is double-counted.
function poAccruedOf(purchaseOrders, vendorBills, jobPct) {
  let total = 0;
  for (const po of purchaseOrders || []) {
    if (!LIVE_PO_STATUSES(po.status)) continue;
    const earned = poOrderedTotal(po) * (jobPct / 100);
    const open = Math.max(0, earned - poBilled(po, vendorBills));
    if (open > 0) total += open;
  }
  return total;
}

// Sub accrual — earned-but-unbilled on sub contracts. A sub that already has
// a live PO is SKIPPED: its commitment is counted by poAccruedOf, and counting
// the sub contract again would overstate accrued cost and understate profit.
function subAccruedOf(job, subs, purchaseOrders, jobPct) {
  if (job.ngAccruedCosts != null) return num(job.ngAccruedCosts);
  const poSubIds = new Set();
  for (const po of purchaseOrders || []) {
    if (po.sub_id && LIVE_PO_STATUSES(po.status)) poSubIds.add(po.sub_id);
  }
  let total = 0;
  for (const sub of subs || []) {
    if (poSubIds.has(sub.id)) continue;
    const earned = num(sub.contractAmt) * (jobPct / 100);
    total += Math.max(0, earned - num(sub.billedToDate));
  }
  return total;
}

/**
 * The port. `job` is the jobs.data blob; everything else comes from its table.
 *
 * deps = { phases, buildings, subs, changeOrders, invoices, qbCostLines,
 *          vendorBills, purchaseOrders }
 */
function computeJobWIP(job, deps) {
  const d = deps || {};
  const phases = Array.isArray(d.phases) ? d.phases : [];
  const buildings = Array.isArray(d.buildings) ? d.buildings : [];
  const subs = Array.isArray(d.subs) ? d.subs : [];
  const purchaseOrders = Array.isArray(d.purchaseOrders) ? d.purchaseOrders : [];
  const vendorBills = Array.isArray(d.vendorBills) ? d.vendorBills : [];

  const co = coTotals(d.changeOrders);

  // ACTUAL counts ONLY QuickBooks lines LINKED to a cost node. Unlinked QB is
  // excluded entirely — John's rule: "if a cost from QuickBooks isn't linked,
  // don't show it in actual costs."
  let qbActualCosts = 0, qbCostLineCount = 0, qbCostsAsOf = null;
  for (const l of (d.qbCostLines || [])) {
    if (l.linked_node_id == null && l.linkedNodeId == null) continue;
    qbCostLineCount++;
    qbActualCosts += num(l.amount);
    const when = l.report_date || l.reportDate;
    if (when && (!qbCostsAsOf || String(when) > String(qbCostsAsOf))) {
      qbCostsAsOf = String(when).slice(0, 10);
    }
  }

  // ngActualCosts explicitly EXCLUDES QB (the engine no longer folds it in
  // per-node), so QB is added exactly once here regardless of graph topology.
  const baseActualCosts = job.ngActualCosts != null
    ? num(job.ngActualCosts)
    : totalManualCost(job, phases, buildings);
  const billedCost = billedCostOf(vendorBills);
  const actualCosts = baseActualCosts + qbActualCosts + billedCost;

  const contractIncome = num(job.contractAmount);
  const estimatedCosts = num(job.estimatedCosts);
  const totalIncome = contractIncome + co.income;
  const totalEstCosts = estimatedCosts + co.costs;
  const revisedCostChanges = num(job.revisedCostChanges);
  const revisedEstCosts = totalEstCosts + revisedCostChanges;

  const asSoldProfit = contractIncome - estimatedCosts;
  const asSoldMargin = contractIncome > 0 ? (asSoldProfit / contractIncome * 100) : 0;
  const revisedProfit = totalIncome - revisedEstCosts;
  const revisedMargin = totalIncome > 0 ? (revisedProfit / totalIncome * 100) : 0;

  const pctComplete = num(job.pctComplete);
  // Unlinked-CO income never reaches the graph's ngRevenueEarned, so its
  // earned share is added on top. The no-graph fallback already folds ALL CO
  // income in via totalIncome and needs nothing.
  const coEarned = co.unlinkedIncome * (pctComplete / 100);
  const revenueEarned = job.ngRevenueEarned != null
    ? num(job.ngRevenueEarned) + coEarned
    : totalIncome * (pctComplete / 100);

  // JTD stays PURE (revenue − actual) for the WIP report and the margin-drift
  // audit rule. Do NOT prefer the engine's ngJtdProfit — that is graph-manual
  // cost only (QB excluded), so it overstates profit.
  const jtdProfit = revenueEarned - actualCosts;
  const jtdMargin = revenueEarned > 0 ? (jtdProfit / revenueEarned * 100) : 0;

  const invoiced = jobMoney.invoicedToDate(d.invoices, job);
  const unbilled = revenueEarned - invoiced;
  const backlog = job.ngBacklog != null ? num(job.ngBacklog) : totalIncome - revenueEarned;
  const remainingCosts = revisedEstCosts - actualCosts;

  const poAccrued = poAccruedOf(purchaseOrders, vendorBills, pctComplete);
  const accruedCosts = subAccruedOf(job, subs, purchaseOrders, pctComplete) + poAccrued;
  const projectedCost = actualCosts + accruedCosts;
  const projectedProfit = totalIncome - projectedCost;

  // Headline figures: job-to-date once there is REAL progress, else the
  // as-sold projection, so a freshly estimate-linked job shows its expected
  // gross profit instead of $0. Gating on genuine activity rather than on
  // "the graph pushed a value" is deliberate — a Site-Plan graph pushes
  // ngJtdProfit = 0 at 0% done, a non-null zero that used to zero the card.
  const hasActuals = actualCosts > 0 || revenueEarned > 0;
  // Display nets ACCRUED out alongside actual (John's call); jtd* above stay pure.
  const displayProfit = hasActuals ? (jtdProfit - accruedCosts) : revisedProfit;
  const displayMargin = hasActuals
    ? (revenueEarned > 0 ? (displayProfit / revenueEarned * 100) : 0)
    : revisedMargin;

  return {
    contractIncome, estimatedCosts, coIncome: co.income, coCosts: co.costs,
    totalIncome, totalEstCosts, revisedCostChanges, revisedEstCosts,
    asSoldProfit, asSoldMargin, revisedProfit, revisedMargin,
    pctComplete, revenueEarned, actualCosts, jtdProfit, jtdMargin,
    displayProfit, displayMargin,
    qbActualCosts, qbCostLineCount, qbCostsAsOf,
    invoiced, unbilled, backlog, remainingCosts,
    accruedCosts, poAccrued, billedCost, projectedCost, projectedProfit,
  };
}

/**
 * Load the table-backed halves of `deps` for a set of jobs in one pass.
 * Returns Map(jobId -> {qbCostLines, vendorBills, purchaseOrders}); the blob
 * halves (phases/buildings/subs) come from jobs.data, which callers already
 * hold. Batched so the company-wide rollup does not put queries in a loop.
 */
async function loadWipInputs(db, jobIds) {
  const ids = (jobIds || []).filter(Boolean);
  const out = new Map();
  if (!ids.length) return out;
  const slot = (id) => {
    if (!out.has(id)) out.set(id, { qbCostLines: [], vendorBills: [], purchaseOrders: [] });
    return out.get(id);
  };
  const [qb, bills, pos] = await Promise.all([
    db.query(
      `SELECT job_id, amount, linked_node_id, report_date
         FROM qb_cost_lines WHERE job_id = ANY($1)`, [ids]),
    db.query(
      `SELECT job_id, po_id, amount, status
         FROM job_vendor_bills WHERE job_id = ANY($1)`, [ids]),
    db.query(
      `SELECT id, job_id, sub_id, status, data
         FROM job_purchase_orders WHERE job_id = ANY($1)`, [ids]),
  ]);
  for (const r of qb.rows) slot(r.job_id).qbCostLines.push(r);
  for (const r of bills.rows) slot(r.job_id).vendorBills.push(r);
  for (const r of pos.rows) {
    const d = r.data || {};
    slot(r.job_id).purchaseOrders.push({
      id: r.id, sub_id: r.sub_id, status: r.status,
      lines: Array.isArray(d.lines) ? d.lines : [],
      title: d.title || '',
    });
  }
  return out;
}

module.exports = {
  computeJobWIP,
  coTotals,
  loadWipInputs,
  totalManualCost,
  billedCostOf,
  poOrderedTotal,
  poAccruedOf,
  subAccruedOf,
};
