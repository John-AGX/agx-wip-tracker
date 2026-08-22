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
 * ONE CLOCK FOR CHANGE-ORDER REVENUE
 * ----------------------------------
 * The same drift recurred one level down. This file used to carry its own
 * answer to "how much of a change order have we earned?":
 *
 *     coEarned = unlinkedIncome × job.pctComplete / 100
 *
 * while the browser earned a RIDER change order at its ridden scope's own
 * percent. On RV2008 Fairway Paint & Gutters that is 74% / $20,302 on screen
 * against the job's stored percent here — the same CO, two numbers, one of them
 * quoted by 86 next to a ribbon showing the other. So the formula above is
 * DELETED, along with the `unlinkedIncome` field whose only reader it was, and
 * the clock now lives in ONE place, js/co-completion.js, which the browser
 * loads by script tag and this file require()s. Not two that agree today.
 *
 * What did NOT converge, and why, is written at the coEarned block below: the
 * base-contract term and the reported `pctComplete` still run on the stored
 * scalar, and cost accrual deliberately stays there because the browser accrues
 * there too.
 *
 * The node-graph values (ngActualCosts, ngRevenueEarned, ngBacklog,
 * ngAccruedCosts) are read off the jobs blob exactly as the browser reads
 * them. They are computed by a stateful graph walk in nodegraph/ui.js that
 * cannot be ported; the browser pushes them onto the job, and both sides then
 * consume them identically. When they are absent, both fall back to the same
 * local formula.
 */

const jobMoney = require('./change-order-totals');
const { classifyCostLine } = require('./cost-line-filters');
// THE completion clock — the same file js/jobs.js coCompletion wraps and the
// browser loads by script tag. See the "one clock" note above coEarned below.
const { coCompletion } = require('../../../js/co-completion.js');

function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }

// A CO's money only joins the contract once approved/applied. changeOrdersForJob
// already zeroes income/costs for un-approved rows, so summing is enough.
//
// `unlinkedIncome` USED TO LIVE HERE and is deliberately gone. Its only reader
// was the old `coEarned = unlinkedIncome × job.pctComplete / 100` — a second,
// live-but-unread definition of "CO money that needs a percentage applied",
// which is exactly the seed that grew into the two-clock defect. Earned is now
// computed per CO, by that CO's own completion mode, in computeJobWIP.
function coTotals(changeOrders) {
  const rows = Array.isArray(changeOrders) ? changeOrders : [];
  let income = 0, costs = 0;
  for (const c of rows) {
    income += num(c.income);
    costs += num(c.costs);
  }
  return { income, costs, count: rows.length };
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

  // ACTUAL cost = QB import for materials/labor/GC/equipment (node retirement:
  // every line counts, linked or not — the old "only linked QB counts" rule is
  // retired). The two exclusions — match-only QB "Subcontractors" lines and
  // month-end accrual journal entries — now live in ONE place,
  // money/cost-line-filters.js, because this rule had drifted into four copies
  // and the AI's per-turn job context had no copy at all. classifyCostLine
  // carries the ordering (accrual tested before sub) that the comment there
  // explains. Mirrors js/jobs.js getJobWIP.
  let qbActualCosts = 0, qbCostLineCount = 0, qbCostsAsOf = null, qbSubMatch = 0, qbAccrual = 0;
  for (const l of (d.qbCostLines || [])) {
    qbCostLineCount++;
    const amt = num(l.amount);
    const cls = classifyCostLine(l);
    if (cls === 'accrual') { qbAccrual += amt; continue; }
    if (cls === 'sub') { qbSubMatch += amt; continue; }
    qbActualCosts += amt;
    const when = l.report_date || l.reportDate;
    if (when && (!qbCostsAsOf || String(when) > String(qbCostsAsOf))) {
      qbCostsAsOf = String(when).slice(0, 10);
    }
  }
  const hasQB = qbCostLineCount > 0;

  // Graph/manual base — the fallback when a job has NO QB lines yet.
  const baseActualCosts = job.ngActualCosts != null
    ? num(job.ngActualCosts)
    : totalManualCost(job, phases, buildings);
  const billedCost = billedCostOf(vendorBills);
  // QB non-sub total REPLACES the graph/manual base when QB exists; subcontractor
  // cost comes from billed (PO/invoicing). Mirrors js/jobs.js getJobWIP.
  const actualCosts = (hasQB ? qbActualCosts : baseActualCosts) + billedCost;

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

  // ── TWO CLOCKS, NAMED AND KEPT APART ──────────────────────────────────────
  // `storedPct` is the jobs-blob scalar: round(calcJobPctComplete × 10)/10,
  // written ONLY when a browser renders the job detail and only when the job is
  // not pctCompleteManual. It is a 0.1-precision, possibly stale, possibly
  // hand-frozen cache — and it is what COST accrual runs on, on BOTH sides
  // (js/jobs.js poAccrued/subAccrued read the same scalar). It stays the cost
  // clock here for exactly that reason: moving cost to the scope clock
  // server-side alone would CREATE a browser/server split where none exists.
  // See the bottom of this block — it must never reach revenue, and the live
  // scope clock must never reach poAccruedOf/subAccruedOf.
  const storedPct = num(job.pctComplete);

  // ── REVENUE: the CO term now runs on the SCOPE clock, per CO ──────────────
  // Was: `coEarned = co.unlinkedIncome × storedPct/100` — one blunt formula for
  // every change order, with no idea the rider concept existed. A rider CO
  // exists BECAUSE its work is the ridden scope's work; measuring it against a
  // job-wide average that includes unrelated scopes made a CO's earned revenue
  // move when a DIFFERENT scope progressed. That is a category error, not a
  // rounding difference. js/co-completion.js is now the single implementation
  // and the browser wraps the same file, so this figure and the one on the CO
  // editor's P&L strip are produced by the same lines.
  //
  // The exclusion predicate is UNCHANGED from the deleted unlinkedIncome:
  // `!c.linked_node_id` — a graph-linked CO's earned already lives in
  // ngRevenueEarned. NOTE the pre-existing gap this preserves rather than
  // repairs: a raw legacy blob CO (ai-routes read_wip_summary falls back to
  // `d.changeOrders` unshaped) carries `linkedNodeId`, not `linked_node_id`, so
  // it reads as unlinked here — as it always has. Normalizing the key would
  // move org-wide revenue inside a port, so it is reported, not fixed.
  //
  // sell/cost come off the shaped row (income/costs), never from the pricing
  // pipeline: this file has never heard of the pricing model and must not start.
  // A draft/void CO already carries income 0 from shapeChangeOrderRow, so it
  // earns 0 with no status check needed here.
  let coEarned = 0;
  for (const c of (Array.isArray(d.changeOrders) ? d.changeOrders : [])) {
    if (!c || c.linked_node_id) continue;
    coEarned += num(coCompletion(c, {
      sell: num(c.income),
      cost: num(c.costs),
      phases,
      buildings,
      storedPct,
    }).earned);
  }
  // The base-contract term is UNCHANGED in this pass. It disagrees with the
  // browser too (browser: Σ cell revenue × cell %; here: ngRevenueEarned, else
  // totalIncome × storedPct), and converging it would promote the progress
  // core's NULL phaseRevenue chain to the authority over the company WIP, 86's
  // per-turn context and the guest-visible Live Rooms chip — on legacy
  // {asSoldRevenue: 0, asSoldPhaseBudget: N} rows that reads $0. That move
  // needs a census of affected rows first (scripts/co-clock-census.js), so it
  // is deliberately NOT in this commit.
  //
  // On the ngRevenueEarned == null branch coEarned is computed and DISCARDED —
  // the fallback already folds all CO income into totalIncome × pct. True on
  // both sides today (js/jobs.js does the same), preserved here.
  const revenueEarned = job.ngRevenueEarned != null
    ? num(job.ngRevenueEarned) + coEarned
    : totalIncome * (storedPct / 100);

  // JTD stays PURE (revenue − actual) for the WIP report and the margin-drift
  // audit rule. Do NOT prefer the engine's ngJtdProfit — that is graph-manual
  // cost only (QB excluded), so it overstates profit.
  const jtdProfit = revenueEarned - actualCosts;
  const jtdMargin = revenueEarned > 0 ? (jtdProfit / revenueEarned * 100) : 0;

  const invoiced = jobMoney.invoicedToDate(d.invoices, job);
  const unbilled = revenueEarned - invoiced;
  const backlog = job.ngBacklog != null ? num(job.ngBacklog) : totalIncome - revenueEarned;
  const remainingCosts = revisedEstCosts - actualCosts;

  // THE COST CLOCK STAYS STORED. `storedPct` and nothing else reaches these two
  // — the browser accrues on the same scalar, so switching them to the scope
  // clock here would manufacture a split. Letting one variable feed both
  // revenue and cost is how the two-clock defect happened the first time.
  const poAccrued = poAccruedOf(purchaseOrders, vendorBills, storedPct);
  const accruedCosts = subAccruedOf(job, subs, purchaseOrders, storedPct) + poAccrued;
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
    // The REPORTED percent is still the stored scalar. The browser reports the
    // live weighted percent here instead, so this field still disagrees — and
    // it is the "single survivor" of Live Rooms money redaction, the one figure
    // an outside owner sees in a redacted room. Converging it is a
    // guest-visible change and belongs with the base-contract term above and
    // its census, not inside this commit.
    pctComplete: storedPct, revenueEarned, actualCosts, jtdProfit, jtdMargin,
    displayProfit, displayMargin,
    qbActualCosts, qbCostLineCount, qbCostsAsOf, qbSubMatch, qbAccrual,
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
      `SELECT job_id, amount, linked_node_id, report_date, account, account_type, bucket
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
