'use strict';

/**
 * job-financials.js — the shared write layer for a job's financial
 * records: change orders, purchase orders, and AR invoices.
 *
 * Why this file exists
 * --------------------
 * These three record types each have exactly one home:
 *
 *   change orders   → job_change_orders
 *   purchase orders → job_purchase_orders
 *   invoices        → invoices
 *
 * The REST routes have always written there. The AI payload dispatcher
 * did not — it pushed agent-created COs/POs/invoices into
 * jobs.data.changeOrders / .purchaseOrders / .invoices, JSONB arrays no
 * reader has consulted since those tables landed. Every record 86 or
 * Scribe created that way was written successfully and then never seen
 * again. This module is the single implementation both paths call, so
 * an agent-emitted CO lands in the same table, with the same numbering,
 * the same field stripping, and the same locked/applied guards, as one
 * created from the UI.
 *
 * The contract
 * ------------
 * Every function takes an explicit `db` first argument — either the
 * pool (routes) or an open transaction client (the dispatcher, which
 * needs these writes to commit or roll back with the rest of the
 * payload). Same shape as dispatchAssembly's hand-off to
 * services/assemblies.js.
 *
 * Failures throw. Routes translate to a status code; the dispatcher
 * lets the throw abort the transaction.
 *
 * NOTE: the REST routes currently import the helpers here but still
 * carry their own copies of the create/update SQL (they also do
 * training capture, tri-state sub_id, and per-route permission checks).
 * Collapsing those handlers onto createChangeOrder/etc. is the next
 * slice — deliberately not bundled with the data-loss fix.
 */

const { sanitizeRichText } = require('../util/rich-text');

function genId(p) { return p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }
function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
function round2(n) { return Math.round(num(n) * 100) / 100; }

// AGX's standard subcontract agreement — editable per-org in the Command
// Center / org settings. Intentionally plain text so it renders in a
// textarea and in print; the org can paste richer/exact legal language.
const DEFAULT_SCOPE_TEMPLATE =
`ATTACHMENT A — SCOPE OF WORK

[Describe the job-specific scope here.]


TERMS & CONDITIONS

This Purchase Order / Subcontract Agreement ("Agreement") is entered into between Parsky LLC, dba AG Exteriors ("AGX", "Contractor") and the Subcontractor named above ("Subcontractor").

1. INVOICING & PAYMENTS. Payment terms are Net 30 from approved invoice. AGX retains ten percent (10%) retainage from each payment, released upon final completion and owner acceptance.

2. PERFORMANCE TIME & LIQUIDATED DAMAGES. Subcontractor shall complete the work by the scheduled completion date. Time is of the essence.

3. CHANGES & CHANGE ORDERS. No extra work shall be performed and no additional payment shall be due without a written, executed Change Order signed by AGX prior to the work.

4. INDEMNIFICATION. Subcontractor shall indemnify, defend, and hold harmless AGX and the Owner from claims arising out of Subcontractor's work.

5. INSURANCE. Subcontractor shall maintain: Commercial General Liability of not less than $1,000,000, naming AGX as additional insured; Workers' Compensation of not less than $500,000; and Automobile Liability of not less than $500,000.

6. WARRANTY. Subcontractor warrants its work for one (1) year from the date of the Owner's final acceptance.

7. EXECUTION & ADDITIONAL OBLIGATIONS. Subcontractor shall provide required submittals and a schedule of values, maintain a clean site (a $25/day fine applies for failure to clean up), observe a no-smoking policy ($25 fine per violation), and comply with all OSHA and safety requirements.

8. DISPUTE RESOLUTION. Disputes shall be resolved by binding arbitration administered by the American Arbitration Association (AAA).

9. ENTIRE AGREEMENT. This Agreement, including the Scope of Work above, constitutes the entire agreement between the parties.`;

// ────────────────────────────────────────────────────────────────────
// numbering — all three scan existing numbers and take max+1. Not
// gap-free and not race-free on its own; the dispatcher runs inside a
// transaction holding the job's advisory lock, and the routes are
// low-concurrency by hand.
// ────────────────────────────────────────────────────────────────────

async function nextCoNumber(db, jobId) {
  const { rows } = await db.query(
    `SELECT co_number FROM job_change_orders WHERE job_id = $1 AND co_number ~ '^CO-[0-9]+$'`,
    [jobId]
  );
  let maxN = 0;
  for (const r of rows) {
    const n = parseInt(String(r.co_number).slice(3), 10);
    if (!isNaN(n) && n > maxN) maxN = n;
  }
  return 'CO-' + (maxN + 1);
}

async function nextPoNumber(db, orgId) {
  const { rows } = await db.query(
    `SELECT po_number FROM job_purchase_orders
      WHERE (organization_id = $1 OR organization_id IS NULL)
        AND po_number ~ '^PO-[0-9]+$'`,
    [orgId]
  );
  let maxN = 0;
  for (const r of rows) {
    const n = parseInt(String(r.po_number).slice(3), 10);
    if (!isNaN(n) && n > maxN) maxN = n;
  }
  return 'PO-' + String(maxN + 1).padStart(4, '0');
}

async function nextInvoiceNumber(db, orgId) {
  const { rows } = await db.query(
    `SELECT invoice_number FROM invoices
      WHERE (organization_id = $1 OR ($1 IS NULL AND organization_id IS NULL))
        AND invoice_number ~ '^INV-[0-9]+$'`,
    [orgId]
  );
  let maxN = 0;
  for (const r of rows) {
    const n = parseInt(String(r.invoice_number).slice(4), 10);
    if (!isNaN(n) && n > maxN) maxN = n;
  }
  return 'INV-' + String(maxN + 1).padStart(4, '0');
}

async function orgScopeTemplate(db, orgId) {
  try {
    const { rows } = await db.query(
      "SELECT settings->>'po_scope_template' AS tpl FROM organizations WHERE id = $1",
      [orgId]
    );
    const tpl = rows.length ? rows[0].tpl : null;
    return (tpl && String(tpl).trim()) ? tpl : DEFAULT_SCOPE_TEMPLATE;
  } catch (e) {
    return DEFAULT_SCOPE_TEMPLATE;
  }
}

// ────────────────────────────────────────────────────────────────────
// blob cleaning — strip the canonical column fields out of an incoming
// body so they can't be smuggled in through the JSONB side.
// ────────────────────────────────────────────────────────────────────

function cleanCoData(body) {
  const data = { ...(body || {}) };
  ['id', 'job_id', 'owner_id', 'status', 'co_number', 'approved_at', 'approved_by',
   'linked_node_id', 'is_locked', 'created_at', 'updated_at'].forEach(k => delete data[k]);
  if (!Array.isArray(data.lines)) data.lines = [];
  // Rich-text fields hold sanitized HTML from the p86RichText editor; clean
  // them again server-side so a direct API POST — or an agent payload —
  // can't store unsafe markup.
  if (typeof data.scope === 'string') data.scope = sanitizeRichText(data.scope);
  if (typeof data.terms === 'string') data.terms = sanitizeRichText(data.terms);
  return data;
}

function cleanPoData(body) {
  const data = { ...(body || {}) };
  ['id', 'job_id', 'organization_id', 'owner_id', 'sub_id', 'status', 'po_number',
   'approved_at', 'approved_by', 'created_at', 'updated_at',
   'extraction'].forEach(k => delete data[k]); // 'extraction' is a training artifact, not PO data
  if (!Array.isArray(data.lines)) data.lines = [];
  return data;
}

// A line's amount: explicit `amount`, else qty × unitPrice.
function lineAmount(l) {
  if (!l) return 0;
  if (l.amount != null && l.amount !== '') return num(l.amount);
  return num(l.qty || 1) * num(l.unitPrice);
}

// Recompute an invoice's money from its lines + tax + retainage.
function computeInvoiceTotals(data, taxPct, retainageAmount) {
  const lines = Array.isArray(data.lines) ? data.lines : [];
  let subtotal = 0, taxable = 0;
  lines.forEach(l => { const a = lineAmount(l); subtotal += a; if (l.taxable) taxable += a; });
  const taxAmount = round2(taxable * num(taxPct) / 100);
  const retain = round2(num(retainageAmount));
  const total = round2(subtotal + taxAmount - retain);
  return { subtotal: round2(subtotal), taxAmount, retainageAmount: retain, total };
}

// ────────────────────────────────────────────────────────────────────
// org scoping — every entry point resolves through the job so a record
// outside the caller's org is indistinguishable from one that doesn't
// exist. Jobs with a NULL organization_id are the pre-tenancy legacy
// rows and stay visible to everyone, matching the routes.
// ────────────────────────────────────────────────────────────────────

async function assertJobInOrg(db, jobId, orgId) {
  if (!jobId) throw new Error('job_id required');
  const { rowCount } = await db.query(
    'SELECT 1 FROM jobs WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)',
    [jobId, orgId == null ? null : orgId]
  );
  if (!rowCount) throw new Error(`Job not found: ${jobId}`);
}

const CO_RETURNING = `id, job_id, owner_id, status, co_number, data, approved_at,
                      approved_by, linked_node_id, is_locked, created_at, updated_at`;
const PO_RETURNING = `id, job_id, organization_id, owner_id, sub_id, status, po_number,
                      data, approved_at, approved_by, created_at, updated_at`;

// ── change orders ───────────────────────────────────────────────────

async function createChangeOrder(db, { jobId, orgId, ownerId, fields }) {
  await assertJobInOrg(db, jobId, orgId);
  const body = fields || {};
  const id = genId('co');
  const coNumber = (body.co_number && String(body.co_number).trim()) || await nextCoNumber(db, jobId);
  const data = cleanCoData(body);
  const { rows } = await db.query(
    `INSERT INTO job_change_orders (id, job_id, owner_id, status, co_number, data)
     VALUES ($1, $2, $3, 'draft', $4, $5)
     RETURNING ${CO_RETURNING}`,
    [id, jobId, ownerId || null, coNumber, JSON.stringify(data)]
  );
  return rows[0];
}

// `merge` is what separates an agent's partial op from the UI's PUT: the
// dispatcher sends only the fields it wants changed, the REST route
// replaces the blob wholesale.
async function updateChangeOrder(db, { id, orgId, fields, merge = true }) {
  if (!id) throw new Error('change_order update requires co_id');
  const existing = await db.query(
    `SELECT co.status, co.is_locked, co.data FROM job_change_orders co
       JOIN jobs j ON j.id = co.job_id
      WHERE co.id = $1 AND (j.organization_id = $2 OR j.organization_id IS NULL)`,
    [id, orgId == null ? null : orgId]
  );
  if (!existing.rowCount) throw new Error(`Change order not found: ${id}`);
  const cur = existing.rows[0];
  // Applied COs are immutable on the data side — they've already fed the
  // WIP and changing the lines would create reporting drift.
  if (cur.status === 'applied') throw new Error(`Cannot edit an applied change order: ${id}`);
  // Approved COs are locked (committed scope change). Unlock to edit.
  if (cur.is_locked) throw new Error(`Cannot edit an approved (locked) change order: ${id}`);

  const base = merge ? (cur.data || {}) : {};
  const data = cleanCoData(Object.assign({}, base, fields || {}));
  const { rows } = await db.query(
    `UPDATE job_change_orders
        SET data = $1::jsonb,
            updated_at = CASE WHEN data IS DISTINCT FROM $1::jsonb THEN NOW() ELSE updated_at END
      WHERE id = $2
      RETURNING ${CO_RETURNING}`,
    [JSON.stringify(data), id]
  );
  return rows[0];
}

async function deleteChangeOrder(db, { id, orgId }) {
  if (!id) throw new Error('change_order delete requires co_id');
  const { rows } = await db.query(
    `SELECT co.status FROM job_change_orders co
       JOIN jobs j ON j.id = co.job_id
      WHERE co.id = $1 AND (j.organization_id = $2 OR j.organization_id IS NULL)`,
    [id, orgId == null ? null : orgId]
  );
  if (!rows.length) throw new Error(`Change order not found: ${id}`);
  // Applied COs are blocked because their lines are already in the WIP —
  // deleting would silently drop revenue from the rollup.
  if (rows[0].status === 'applied') throw new Error(`Cannot delete an applied change order: ${id}`);
  await db.query('DELETE FROM job_change_orders WHERE id = $1', [id]);
  return { id };
}

// ── purchase orders ─────────────────────────────────────────────────

async function createPurchaseOrder(db, { jobId, orgId, ownerId, fields }) {
  await assertJobInOrg(db, jobId, orgId);
  const body = fields || {};
  const id = genId('po');
  const poNumber = (body.po_number && String(body.po_number).trim()) || await nextPoNumber(db, orgId);
  const subId = body.sub_id || null;
  const data = cleanPoData(body);
  if (!data.scope || !String(data.scope).trim()) data.scope = await orgScopeTemplate(db, orgId);
  const { rows } = await db.query(
    `INSERT INTO job_purchase_orders (id, job_id, organization_id, owner_id, sub_id, status, po_number, data)
     VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7)
     RETURNING ${PO_RETURNING}`,
    [id, jobId, orgId == null ? null : orgId, ownerId || null, subId, poNumber, JSON.stringify(data)]
  );
  return rows[0];
}

async function updatePurchaseOrder(db, { id, orgId, fields, merge = true }) {
  if (!id) throw new Error('purchase_order update requires po_id');
  const existing = await db.query(
    `SELECT po.status, po.data FROM job_purchase_orders po
       JOIN jobs j ON j.id = po.job_id
      WHERE po.id = $1 AND (j.organization_id = $2 OR j.organization_id IS NULL)`,
    [id, orgId == null ? null : orgId]
  );
  if (!existing.rowCount) throw new Error(`Purchase order not found: ${id}`);
  if (existing.rows[0].status === 'closed') {
    throw new Error(`Cannot edit a closed purchase order: ${id}`);
  }
  const body = fields || {};
  const base = merge ? (existing.rows[0].data || {}) : {};
  const data = cleanPoData(Object.assign({}, base, body));
  // sub_id is tri-state: absent leaves it alone, present-but-empty clears it.
  const subProvided = Object.prototype.hasOwnProperty.call(body, 'sub_id');
  const subId = subProvided ? (body.sub_id || null) : null;
  const { rows } = await db.query(
    `UPDATE job_purchase_orders
        SET data = $1::jsonb,
            sub_id = CASE WHEN $2::boolean THEN $3 ELSE sub_id END,
            updated_at = CASE
              WHEN data IS DISTINCT FROM $1::jsonb
                OR ($2::boolean AND sub_id IS DISTINCT FROM $3) THEN NOW()
              ELSE updated_at END
      WHERE id = $4
      RETURNING ${PO_RETURNING}`,
    [JSON.stringify(data), !!subProvided, subId, id]
  );
  return rows[0];
}

async function deletePurchaseOrder(db, { id, orgId }) {
  if (!id) throw new Error('purchase_order delete requires po_id');
  const { rows } = await db.query(
    `SELECT po.status FROM job_purchase_orders po
       JOIN jobs j ON j.id = po.job_id
      WHERE po.id = $1 AND (j.organization_id = $2 OR j.organization_id IS NULL)`,
    [id, orgId == null ? null : orgId]
  );
  if (!rows.length) throw new Error(`Purchase order not found: ${id}`);
  if (rows[0].status === 'closed') throw new Error(`Cannot delete a closed purchase order: ${id}`);
  await db.query('DELETE FROM job_purchase_orders WHERE id = $1', [id]);
  return { id };
}

// ── invoices (AR) ───────────────────────────────────────────────────
// Money columns are derived, never taken from the caller: subtotal, tax,
// and total are always recomputed from the lines. An agent can propose
// lines; it cannot assert a total.

const INV_RETURNING = `id, organization_id, owner_id, job_id, client_id, pay_application_id,
                       invoice_number, status, issue_date, due_date, terms, subtotal,
                       tax_pct, tax_amount, retainage_amount, total, amount_paid, data,
                       created_at, updated_at`;

async function createInvoice(db, { jobId, orgId, ownerId, fields }) {
  const b = fields || {};
  if (jobId) await assertJobInOrg(db, jobId, orgId);
  const data = {
    lines: Array.isArray(b.lines) ? b.lines : [],
    notes: b.notes || '',
    billTo: b.billTo || null,
  };
  const t = computeInvoiceTotals(data, b.tax_pct, b.retainage_amount);
  const id = genId('inv');
  const number = (b.invoice_number && String(b.invoice_number).trim())
    || await nextInvoiceNumber(db, orgId);
  const { rows } = await db.query(
    `INSERT INTO invoices (id, organization_id, owner_id, job_id, client_id, pay_application_id,
        invoice_number, status, issue_date, due_date, terms,
        subtotal, tax_pct, tax_amount, retainage_amount, total, amount_paid, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8,$9,$10,$11,$12,$13,$14,$15,0,$16)
     RETURNING ${INV_RETURNING}`,
    [id, orgId == null ? null : orgId, ownerId || null, jobId || null,
     b.client_id != null ? String(b.client_id) : null, b.pay_application_id || null,
     number, b.issue_date || null, b.due_date || null, b.terms || null,
     t.subtotal, num(b.tax_pct), t.taxAmount, t.retainageAmount, t.total,
     JSON.stringify(data)]
  );
  return rows[0];
}

async function updateInvoice(db, { id, orgId, fields, merge = true }) {
  if (!id) throw new Error('invoice update requires invoice_id');
  const existing = await db.query(
    `SELECT * FROM invoices
      WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)`,
    [id, orgId == null ? null : orgId]
  );
  if (!existing.rowCount) throw new Error(`Invoice not found: ${id}`);
  const cur = existing.rows[0];
  // A paid or voided invoice is a closed book — payments are already
  // applied against its total.
  if (cur.status === 'paid' || cur.status === 'void') {
    throw new Error(`Cannot edit a ${cur.status} invoice: ${id}`);
  }
  const b = fields || {};
  const curData = (merge && cur.data) ? cur.data : {};
  const data = {
    lines: Array.isArray(b.lines) ? b.lines : (Array.isArray(curData.lines) ? curData.lines : []),
    notes: b.notes !== undefined ? (b.notes || '') : (curData.notes || ''),
    billTo: b.billTo !== undefined ? (b.billTo || null) : (curData.billTo || null),
  };
  const taxPct = b.tax_pct !== undefined ? b.tax_pct : cur.tax_pct;
  const retain = b.retainage_amount !== undefined ? b.retainage_amount : cur.retainage_amount;
  const t = computeInvoiceTotals(data, taxPct, retain);
  const { rows } = await db.query(
    `UPDATE invoices
        SET job_id = COALESCE($2, job_id),
            client_id = COALESCE($3, client_id),
            issue_date = COALESCE($4, issue_date),
            due_date = COALESCE($5, due_date),
            terms = COALESCE($6, terms),
            subtotal = $7, tax_pct = $8, tax_amount = $9,
            retainage_amount = $10, total = $11,
            data = $12::jsonb, updated_at = NOW()
      WHERE id = $1
      RETURNING ${INV_RETURNING}`,
    [id, b.job_id || null, b.client_id != null ? String(b.client_id) : null,
     b.issue_date || null, b.due_date || null, b.terms || null,
     t.subtotal, num(taxPct), t.taxAmount, t.retainageAmount, t.total,
     JSON.stringify(data)]
  );
  return rows[0];
}

async function deleteInvoice(db, { id, orgId }) {
  if (!id) throw new Error('invoice delete requires invoice_id');
  const { rows } = await db.query(
    `SELECT status, amount_paid FROM invoices
      WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)`,
    [id, orgId == null ? null : orgId]
  );
  if (!rows.length) throw new Error(`Invoice not found: ${id}`);
  if (num(rows[0].amount_paid) > 0) {
    throw new Error(`Cannot delete an invoice with payments applied: ${id} — void it instead`);
  }
  await db.query('DELETE FROM invoices WHERE id = $1', [id]);
  return { id };
}

module.exports = {
  DEFAULT_SCOPE_TEMPLATE,
  nextCoNumber, nextPoNumber, nextInvoiceNumber, orgScopeTemplate,
  cleanCoData, cleanPoData, lineAmount, computeInvoiceTotals,
  createChangeOrder, updateChangeOrder, deleteChangeOrder,
  createPurchaseOrder, updatePurchaseOrder, deletePurchaseOrder,
  createInvoice, updateInvoice, deleteInvoice,
};
