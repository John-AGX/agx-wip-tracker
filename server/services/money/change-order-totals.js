'use strict';

/**
 * money/change-order-totals.js — server-side CO, PO, and invoice money,
 * derived from the same pricing pipeline the browser uses.
 *
 * Why this exists
 * ---------------
 * The AI job-context builder used to read a job's change orders, purchase
 * orders, and invoices off the jobs JSONB blob (job.changeOrders,
 * .purchaseOrders, .invoices). Those arrays stopped being the record of
 * truth when job_change_orders / job_purchase_orders / invoices landed, so
 * the context block rendered "# Change orders (none recorded)" for jobs
 * carrying real, approved COs — and computeJobWIP added $0 of CO revenue
 * to the WIP it showed the model.
 *
 * Reading the real tables is the easy half. The hard half is money: a CO
 * has no flat `income` field. Its value comes from data.lines run through
 * markup → target-margin → fees → tax → round, which lived only in the
 * browser (js/pricing-pipeline.js, window.p86Pricing).
 *
 * Rather than reimplement that pipeline server-side — the exact drift the
 * pipeline module was created to end — this requires the same file. It is
 * pure math with no DOM, and now exports for both targets. A CO total the
 * server hands the model and the total the CO editor paints on screen are
 * computed by the same lines of code.
 */

const pricing = require('../../../js/pricing-pipeline.js');

// A CO joins the contract once approved or applied; before that it's a
// proposal. Mirrors getJobCOTotals() in js/jobs.js.
const COUNTED_STATUSES = new Set(['approved', 'applied']);

function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }

// The money on one CO record. `rec` is the data blob — fee/tax/markup
// fields live at its root alongside lines[], same shape the editor holds.
function changeOrderMoney(rec) {
  const r = rec || {};
  const lines = Array.isArray(r.lines) ? r.lines : [];
  const per = pricing.computeForLines(r, lines);
  let markedUp = per.markedUp;
  if (pricing.targetMarginActive(r)) markedUp = pricing.applyTargetMargin(per.subtotal, r);
  const income = pricing.applyFeesAndTax(markedUp, r).total;
  return { income, costs: per.subtotal }; // costs = raw line cost, pre-markup
}

/**
 * Change orders for a job, shaped for computeJobWIP()'s reduce
 * (`c.income` / `c.costs`) and for the context block's print loop.
 *
 * Falls back to the legacy blob array when the table has nothing for this
 * job — old pre-server COs carried flat income/estimatedCosts fields and
 * are still the truth for jobs that never migrated.
 */
async function changeOrdersForJob(db, jobId, legacyBlobArray) {
  const { rows } = await db.query(
    `SELECT id, job_id, status, co_number, linked_node_id, data
       FROM job_change_orders WHERE job_id = $1 ORDER BY created_at ASC`,
    [jobId]
  );
  if (!rows.length) return Array.isArray(legacyBlobArray) ? legacyBlobArray : [];
  return rows.map((r) => {
    const d = r.data || {};
    const counted = COUNTED_STATUSES.has(r.status);
    const m = changeOrderMoney(d);
    return {
      id: r.id,
      status: r.status,
      coNumber: r.co_number,
      linked_node_id: r.linked_node_id,
      description: d.title || d.description || '',
      lineCount: Array.isArray(d.lines) ? d.lines.length : 0,
      // Only approved/applied COs move the contract — an unapproved one
      // must not inflate the WIP. Its own value still rides along so the
      // model can see what's pending.
      income: counted ? m.income : 0,
      costs: counted ? m.costs : 0,
      proposedIncome: m.income,
      proposedCosts: m.costs,
      counted,
    };
  });
}

// A PO is a cost document — no markup, no margin. Its value is the plain
// extension of its lines.
function purchaseOrderMoney(rec) {
  const lines = Array.isArray(rec && rec.lines) ? rec.lines : [];
  return lines.reduce((sum, l) => {
    if (!l || l.section === '__section_header__') return sum;
    if (l.amount != null && l.amount !== '') return sum + num(l.amount);
    return sum + num(l.qty) * num(l.unitCost != null ? l.unitCost : l.unitPrice);
  }, 0);
}

async function purchaseOrdersForJob(db, jobId, legacyBlobArray) {
  const { rows } = await db.query(
    `SELECT po.id, po.status, po.po_number, po.sub_id, po.data, s.name AS sub_name
       FROM job_purchase_orders po
       LEFT JOIN subs s ON s.id = po.sub_id
      WHERE po.job_id = $1 ORDER BY po.created_at ASC`,
    [jobId]
  );
  if (!rows.length) return Array.isArray(legacyBlobArray) ? legacyBlobArray : [];
  return rows.map((r) => {
    const d = r.data || {};
    return {
      id: r.id,
      status: r.status,
      poNumber: r.po_number,
      subName: r.sub_name || '',
      title: d.title || '',
      amount: purchaseOrderMoney(d),
      // Only a PO that's been issued is a real commitment; a draft isn't.
      committed: r.status !== 'draft' && r.status !== 'closed',
    };
  });
}

// Invoices carry their money in real columns — already derived and stored
// by services/job-financials.js. Nothing to recompute.
async function invoicesForJob(db, jobId, legacyBlobArray) {
  const { rows } = await db.query(
    `SELECT id, status, invoice_number, issue_date, due_date, total, amount_paid
       FROM invoices WHERE job_id = $1 ORDER BY issue_date ASC NULLS LAST, created_at ASC`,
    [jobId]
  );
  if (!rows.length) return Array.isArray(legacyBlobArray) ? legacyBlobArray : [];
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    number: r.invoice_number,
    date: r.issue_date,
    dueDate: r.due_date,
    amount: num(r.total),
    amountPaid: num(r.amount_paid),
    openBalance: num(r.total) - num(r.amount_paid),
  }));
}

module.exports = {
  changeOrderMoney,
  purchaseOrderMoney,
  changeOrdersForJob,
  purchaseOrdersForJob,
  invoicesForJob,
};
