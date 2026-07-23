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
function shapeChangeOrderRow(r) {
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
}

// The fallback is deliberately all-or-nothing: table rows win outright and
// legacy blob rows are NOT merged in. Merging would double-count any CO
// that exists in both stores, and the two carry money in incompatible
// shapes (flat income vs derived-from-lines) with no reliable key to
// dedupe on. When a job holds both, the hidden count is reported on the
// returned array so callers can say so out loud instead of silently
// dropping records.
function withLegacyFallback(rows, legacyBlobArray) {
  const legacy = Array.isArray(legacyBlobArray) ? legacyBlobArray : [];
  if (!rows.length) return legacy;
  const out = rows.map(shapeChangeOrderRow);
  if (legacy.length) {
    Object.defineProperty(out, 'legacyHiddenCount', {
      value: legacy.length, enumerable: false,
    });
  }
  return out;
}

async function changeOrdersForJob(db, jobId, legacyBlobArray) {
  const { rows } = await db.query(
    `SELECT id, job_id, status, co_number, linked_node_id, data
       FROM job_change_orders WHERE job_id = $1 ORDER BY created_at ASC`,
    [jobId]
  );
  return withLegacyFallback(rows, legacyBlobArray);
}

/**
 * Batched form for callers that loop every job in the org (the company-wide
 * WIP rollup). One query instead of N — the per-job form inside a map()
 * would put a round trip in the loop.
 *
 * Returns a Map of jobId -> shaped rows. Jobs with no table rows are absent
 * from the map; the caller applies its own legacy blob fallback.
 */
async function changeOrdersForJobs(db, jobIds) {
  const out = new Map();
  const ids = (jobIds || []).filter(Boolean);
  if (!ids.length) return out;
  const { rows } = await db.query(
    `SELECT id, job_id, status, co_number, linked_node_id, data
       FROM job_change_orders WHERE job_id = ANY($1) ORDER BY created_at ASC`,
    [ids]
  );
  for (const r of rows) {
    if (!out.has(r.job_id)) out.set(r.job_id, []);
    out.get(r.job_id).push(shapeChangeOrderRow(r));
  }
  return out;
}

/** Same batching for invoices — the WIP rollup needs invoiced-to-date. */
async function invoicesForJobs(db, jobIds) {
  const out = new Map();
  const ids = (jobIds || []).filter(Boolean);
  if (!ids.length) return out;
  const { rows } = await db.query(
    `SELECT id, job_id, status, invoice_number, issue_date, due_date, total, amount_paid
       FROM invoices WHERE job_id = ANY($1)
      ORDER BY issue_date ASC NULLS LAST, created_at ASC`,
    [ids]
  );
  for (const r of rows) {
    if (!out.has(r.job_id)) out.set(r.job_id, tagFromTable([]));
    out.get(r.job_id).push(shapeInvoiceRow(r));
  }
  return out;
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
      // A CLOSED PO still counts — the work was committed and the cost is
      // real, so excluding it understated the ordered total.
      //
      // NOTE this is NOT the ACCRUED figure on the job tile. getJobPOAccrued
      // is progress-weighted and net of billings (ordered × pct − billed);
      // this is total ordered face value excluding drafts. Do not reconcile
      // the two, and do not add this to actual costs.
      committed: r.status !== 'draft',
    };
  });
}

// Invoices carry their money in real columns — already derived and stored
// by services/job-financials.js. Nothing to recompute.
// Marks an array as having come from a real table rather than a legacy blob
// fallback. Non-enumerable so it survives .map/spread/length/JSON untouched.
function tagFromTable(arr) {
  Object.defineProperty(arr, 'fromTable', { value: true, enumerable: false });
  return arr;
}

// An invoice counts as billed once it has actually gone out. 'draft' has not
// been issued to the owner and 'void' never was — matching the AR aging
// predicate in invoice-routes.js rather than inventing a second rule.
const BILLED_STATUSES = new Set(['sent', 'partial', 'paid', 'overdue']);

function shapeInvoiceRow(r) {
  return {
    id: r.id,
    status: r.status,
    number: r.invoice_number,
    date: r.issue_date,
    dueDate: r.due_date,
    amount: num(r.total),
    amountPaid: num(r.amount_paid),
    openBalance: num(r.total) - num(r.amount_paid),
  };
}

async function invoicesForJob(db, jobId, legacyBlobArray) {
  const { rows } = await db.query(
    `SELECT id, status, invoice_number, issue_date, due_date, total, amount_paid
       FROM invoices WHERE job_id = $1 ORDER BY issue_date ASC NULLS LAST, created_at ASC`,
    [jobId]
  );
  if (!rows.length) return Array.isArray(legacyBlobArray) ? legacyBlobArray : [];
  return tagFromTable(rows.map(shapeInvoiceRow));
}

/**
 * Invoiced-to-date for the WIP math.
 *
 * ONLY rows that came from the `invoices` table may drive this number. The
 * legacy fallback array is jobs.data.invoices — the OLD PER-JOB VENDOR
 * INVOICE LIST, which js/jobs.js saveInvoice() still writes and which the
 * bulk save round-trips. Those are accounts PAYABLE. Their field happens to
 * be named `amount` and their statuses ('Draft'/'Sent'/'Paid') never equal
 * 'void', so summing them here would silently report what AGX OWES as what
 * AGX HAS BILLED — on exactly the legacy jobs the fallback exists for.
 *
 * So: untagged array => keep the hand-typed scalar the browser also shows.
 */
function invoicedToDate(invoiceRows, job) {
  if (!Array.isArray(invoiceRows) || !invoiceRows.fromTable) {
    return num(job && job.invoicedToDate);
  }
  return invoiceRows.reduce(
    (s, i) => s + (BILLED_STATUSES.has(i.status) ? num(i.amount) : 0), 0);
}

module.exports = {
  changeOrderMoney,
  purchaseOrderMoney,
  changeOrdersForJob,
  changeOrdersForJobs,
  purchaseOrdersForJob,
  invoicesForJob,
  invoicesForJobs,
  invoicedToDate,
};
