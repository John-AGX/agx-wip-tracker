'use strict';

// BILLING A WORK ORDER (Phase 4). Office only, and every number here is one
// the crew never sees.
//
// Phase 3 recorded WHAT was done and carried no money on purpose. This turns
// an accepted field log into a DRAFT document somebody then reads, prices and
// sends — it never sends anything itself, and it never touches a client.
//
// THE FOUR DECISIONS (John, 2026-09-26), because each one had a real
// alternative and the code should say which was taken:
//
//   THE RATE is ONE number on the ticket, seeded from the market's
//   labor_rate_default. Not a rate card by trade: a labour line records
//   crew_size and hours and does NOT record who worked, so a per-trade rate
//   would be chosen at billing time out of thin air.
//
//   A MATERIAL'S COST is typed by the office, pre-filled from the materials
//   catalogue when the description matches something bought before. The crew
//   records what it USED, never what it cost; the receipt photo on the line
//   is what the price is read off. A pre-filled price is marked
//   cost_source 'catalog' so it is never mistaken for one somebody checked.
//
//   MARKUP IS PER LINE, with the ticket's default_markup_pct behind it —
//   the estimate editor's cascade, one level shorter. effectiveMarkup is the
//   only place that cascade is written down.
//
//   OVER CONTRACT IS A HARD REFUSAL. A ticket with a contract price cannot
//   be billed above it, at all. The excess is extra work and extra work is a
//   change order; there is no tick-box that lets it through, because the
//   whole point of a contract price is that it is the price.
//
// WHERE IT GOES. A ticket hangs off a job or a lead (service_tickets_parent_chk
// guarantees at least one). A job's work order bills into a DRAFT CHANGE ORDER
// on that job, because that is what added work on a job is. A lead's bills
// into a DRAFT INVOICE, because there is no contract to change.
//
// THE MATH IS NOT A SECOND OPINION. js/pricing-pipeline.js is the one
// definition of markup in this app — `sell = qty * unitCost * (1 + m/100)` —
// and lineExt/lineSell below are that expression and nothing else. The two
// destinations round differently and that is deliberate, not drift:
//
//   * a CHANGE ORDER is handed unitCost + markup and priced by the CO editor
//     through that same pipeline, so the sheet previews it the pipeline's
//     way: ext * (1 + m/100), rounded once at the end.
//   * an INVOICE is a document a client multiplies by hand. Its line reads
//     "12.5 hrs @ $109.25", so the UNIT price is rounded to cents first and
//     the amount follows from it — which is also what job-financials'
//     lineAmount recomputes on save. Rounding the other way would print a
//     line that does not multiply out.
//
//   The two can differ by pennies on the same ticket. sheet() is therefore
//   computed FOR ITS DESTINATION, so the number on screen is the number that
//   will be billed, and never an average of two answers.
//
// NOTHING HERE REACHES A CREW LINK. publicLine() in
// services/service-ticket-field-capture.js projects a crew answer by
// INCLUSION; none of these keys are on that whitelist and a test exists to
// keep it that way.
//
// TENANCY. Every statement carries organization_id from the ticket row the
// route already loaded with the caller's org, never from a body.

const CATALOG_MATCH_LIMIT = 1;
const RATE_MAX = 100000;        // $/hr. A typo of $9,500,000 is not a rate.
const COST_MAX = 10000000;      // per unit
const MARKUP_MAX = 1000;        // percent, matching the CHECK in db.js
const DESCRIPTION_MAX = 300;
const REASON_MAX = 500;
const LINE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

// A work order is billed AFTER it is approved. That rule predates this file —
// it is the "approval before billing" the 1.29 review found could be
// bypassed — and this is the door that enforces it for money.
const BILLABLE_STATUSES = Object.freeze(['approved', 'closed']);

const MSG = Object.freeze({
  notBillable: 'This ticket does not bill: it was raised before billing existed.',
  notApproved: 'Approve the work order before billing it.',
  archived: 'This ticket is archived.',
  cancelled: 'This ticket was cancelled.',
  waiting: 'Decide the time and materials still waiting before billing.',
  noRate: 'Set the labour rate before billing.',
  noCost: 'Give every material a cost before billing.',
  nothing: 'There is nothing accepted to bill.',
  noContract: 'This service ticket has no contract price to bill.',
  overContract: 'That is more than the contract price. Extra work goes on a change order.',
  alreadyBilled: 'This work order has already been billed.',
  writtenOff: 'This work order was written off.',
  noParent: 'This ticket belongs to no job and no lead, so there is nowhere to bill it.',
  rate: 'The labour rate must be a number of dollars, zero or more.',
  markup: 'Markup must be a number of percent between 0 and ' + MARKUP_MAX + '.',
  cost: 'A cost must be a number of dollars, zero or more.',
  amount: 'The amount must be a number of dollars, zero or more.',
  lineGone: 'That line is not on this work order.',
  lineDecided: 'Only an accepted line carries money.',
  reason: 'Say why it is being written off.',
});

function refuse(status, error, extra) {
  return Object.assign({ ok: false, status: status, error: error }, extra || {});
}

function round2(n) {
  // Away from zero at the half, the way money rounds on a printed document.
  // Number.EPSILON scaling is what keeps 1.005 from arriving as 1.00499999.
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.sign(x) * Math.round((Math.abs(x) + Number.EPSILON) * 100) / 100;
}

function numberOr(v, fallback) {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// ── what bills, and where ────────────────────────────────────────────────

/** A ticket raised before billing existed bills nowhere. */
function billingOn(ticket) {
  return !!ticket && String(ticket.bill_as || '') !== 'none';
}

function billsFromTheField(ticket) {
  return !!ticket && String(ticket.bill_as || '') === 'time_materials';
}

function billsAContract(ticket) {
  return !!ticket && String(ticket.bill_as || '') === 'contract';
}

/**
 * destinationFor(ticket) -> {kind:'change_order', job_id} | {kind:'invoice', lead_id} | null
 * A job's work order is a change order on that job. A lead's is an invoice,
 * because there is no contract to change. The job wins when a ticket somehow
 * carries both: the change order keeps the money on the job it belongs to.
 */
function destinationFor(ticket) {
  if (!ticket) return null;
  if (ticket.job_id) return { kind: 'change_order', job_id: String(ticket.job_id) };
  if (ticket.lead_id) return { kind: 'invoice', lead_id: String(ticket.lead_id) };
  return null;
}

// ── the markup cascade ───────────────────────────────────────────────────

/**
 * effectiveMarkup(line, ticket) -> percent
 * The line's own markup, else the ticket's default, else nothing. One level
 * shorter than the estimate editor's line → section → header, and written
 * down exactly once so a screen and a bill can never disagree.
 */
function effectiveMarkup(line, ticket) {
  const own = numberOr(line && line.markup_pct, null);
  if (own != null) return own;
  const dflt = numberOr(ticket && ticket.default_markup_pct, null);
  return dflt != null ? dflt : 0;
}

/** qty × unitCost — the cost side, before any markup. */
function lineExt(qty, unitCost) {
  return numberOr(qty, 0) * numberOr(unitCost, 0);
}

/** The pipeline's formula, and nothing else. */
function lineSell(ext, markupPct) {
  return numberOr(ext, 0) * (1 + numberOr(markupPct, 0) / 100);
}

// ── the sheet ────────────────────────────────────────────────────────────

/** One labour line as money. Priced off the TICKET's rate — there is one. */
function laborMoney(line, ticket, rate, dest) {
  const qty = numberOr(line.person_hours, null);
  const markup = effectiveMarkup(line, ticket);
  const unitCost = numberOr(rate, null);
  return priced({
    kind: 'labor',
    id: line.id,
    description: line.work_performed || 'Labour',
    work_date: line.work_date || null,
    task_title: line.task_title || null,
    qty: qty,
    unit: 'hr',
    unit_cost: unitCost,
    cost_source: unitCost == null ? null : 'rate',
    markup_pct: numberOr(line.markup_pct, null),
    effective_markup_pct: markup,
    receipts: 0,
  }, dest);
}

/** One material line as money. Its cost is the office's, typed or catalogued. */
function materialMoney(line, ticket, dest) {
  const markup = effectiveMarkup(line, ticket);
  return priced({
    kind: 'material',
    id: line.id,
    description: line.description || 'Material',
    work_date: null,
    task_title: line.task_title || null,
    qty: numberOr(line.billable_quantity, null),
    unit: line.unit || null,
    unit_cost: numberOr(line.unit_cost, null),
    cost_source: line.cost_source || null,
    markup_pct: numberOr(line.markup_pct, null),
    effective_markup_pct: markup,
    receipts: Array.isArray(line.receipts) ? line.receipts.length : 0,
  }, dest);
}

/**
 * The money on one row, computed FOR ITS DESTINATION (see the header). A row
 * missing its quantity or its cost is `ready:false` and contributes nothing —
 * it is not a zero, because a zero would quietly bill as free.
 */
function priced(row, dest) {
  const ready = row.qty != null && row.unit_cost != null;
  if (!ready) {
    return Object.assign(row, { ready: false, ext: null, unit_sell: null, total: null });
  }
  const ext = lineExt(row.qty, row.unit_cost);
  const m = row.effective_markup_pct;
  if (dest === 'invoice') {
    // The unit price is what a client multiplies, so it rounds first.
    const unitSell = round2(lineSell(row.unit_cost, m));
    return Object.assign(row, {
      ready: true, ext: round2(ext), unit_sell: unitSell, total: round2(row.qty * unitSell),
    });
  }
  // A change order is priced by the CO editor through the shared pipeline.
  return Object.assign(row, {
    ready: true, ext: round2(ext), unit_sell: round2(lineSell(row.unit_cost, m)), total: round2(lineSell(ext, m)),
  });
}

/**
 * billingSheet(ticket, officeLog, opts) -> the whole billing screen as data.
 * PURE. opts = { marketRate } — the market's default, offered when the ticket
 * has no rate of its own yet; it is never silently applied.
 */
function billingSheet(ticket, officeLog, opts) {
  const o = opts || {};
  const log = officeLog || {};
  const dest = destinationFor(ticket);
  const destKind = dest ? dest.kind : null;
  const rate = numberOr(ticket && ticket.labor_rate, null);
  const contract = billsAContract(ticket) ? numberOr(ticket.contract_amount, null) : null;

  const accepted = function (arr) {
    return (Array.isArray(arr) ? arr : []).filter(function (l) { return l.status === 'accepted'; });
  };
  const waiting = (Array.isArray(log.labor) ? log.labor : [])
    .concat(Array.isArray(log.materials) ? log.materials : [])
    .filter(function (l) { return l.status === 'submitted'; }).length;

  let lines = [];
  if (billsFromTheField(ticket)) {
    lines = accepted(log.labor).map(function (l) { return laborMoney(l, ticket, rate, destKind); })
      .concat(accepted(log.materials).map(function (m) { return materialMoney(m, ticket, destKind); }));
  } else if (contract != null) {
    // A contract ticket bills its price, as one line. There is no field log
    // behind it — fieldCaptureOn() is time_materials only — so there is
    // nothing to add up and nothing to mark up.
    lines = [{
      kind: 'contract', id: 'contract', description: contractLineText(ticket),
      work_date: null, task_title: null, qty: 1, unit: null,
      unit_cost: contract, cost_source: ticket.contract_source || null,
      markup_pct: null, effective_markup_pct: 0, receipts: 0,
      ready: true, ext: round2(contract), unit_sell: round2(contract), total: round2(contract),
    }];
  }

  let cost = 0, price = 0;
  lines.forEach(function (l) { if (l.ready) { cost += l.ext; price += l.total; } });
  cost = round2(cost); price = round2(price);

  return {
    enabled: billingOn(ticket),
    bill_as: ticket ? ticket.bill_as : null,
    destination: dest,
    rate: { value: rate, source: (ticket && ticket.labor_rate_source) || null, market_default: numberOr(o.marketRate, null) },
    default_markup_pct: numberOr(ticket && ticket.default_markup_pct, null),
    lines: lines,
    totals: { cost: cost, markup: round2(price - cost), price: price },
    contract: contract == null ? null : { amount: round2(contract), remaining: round2(contract - price) },
    waiting: waiting,
    billed: billedRecord(ticket),
    blockers: blockersFor(ticket, { lines: lines, waiting: waiting, price: price, contract: contract, dest: dest }),
  };
}

function contractLineText(ticket) {
  const n = ticket && ticket.ticket_number ? ticket.ticket_number + ' — ' : '';
  return (n + (ticket && ticket.title ? ticket.title : 'Contracted work')).slice(0, DESCRIPTION_MAX);
}

/** What the ticket became, or null. Read from the LINK, not from the word. */
function billedRecord(ticket) {
  if (!ticket) return null;
  if (String(ticket.billing_status || '') === 'written_off') {
    return { kind: 'written_off', reason: ticket.write_off_reason || null, at: ticket.billed_at || null };
  }
  if (ticket.billed_change_order_id) return { kind: 'change_order', id: String(ticket.billed_change_order_id), at: ticket.billed_at || null };
  if (ticket.billed_invoice_id) return { kind: 'invoice', id: String(ticket.billed_invoice_id), at: ticket.billed_at || null };
  return null;
}

/**
 * Everything standing between this ticket and a bill, as a list rather than
 * the first one found — the office should see all of it at once and fix it in
 * one pass, not discover a second problem after solving the first.
 */
function blockersFor(ticket, s) {
  const out = [];
  const add = function (code, message, extra) { out.push(Object.assign({ code: code, message: message }, extra || {})); };
  if (!billingOn(ticket)) { add('not_billable', MSG.notBillable); return out; }
  if (ticket.archived_at) add('archived', MSG.archived);
  if (ticket.status === 'cancelled') add('cancelled', MSG.cancelled);
  else if (BILLABLE_STATUSES.indexOf(String(ticket.status || '')) === -1) add('not_approved', MSG.notApproved);

  const rec = billedRecord(ticket);
  if (rec && rec.kind === 'written_off') add('written_off', MSG.writtenOff);
  else if (rec) add('already_billed', MSG.alreadyBilled, { billed: rec });

  if (!s.dest) add('no_parent', MSG.noParent);
  if (s.waiting > 0) add('waiting', MSG.waiting, { count: s.waiting });

  if (billsAContract(ticket)) {
    if (s.contract == null) add('no_contract', MSG.noContract);
  } else {
    if (!s.lines.length) add('nothing', MSG.nothing);
    const needRate = s.lines.some(function (l) { return l.kind === 'labor' && l.unit_cost == null; });
    if (needRate) add('no_rate', MSG.noRate);
    const noCost = s.lines.filter(function (l) { return l.kind === 'material' && l.unit_cost == null; });
    if (noCost.length) add('no_cost', MSG.noCost, { count: noCost.length, ids: noCost.map(function (l) { return l.id; }) });
  }
  return out;
}

/**
 * overContract(ticket, amount) -> null | refusal
 * THE HARD REFUSAL. A contract price is the price; there is no override and
 * no tick-box, and the sentence names the road that is open instead.
 */
function overContract(ticket, amount) {
  if (!billsAContract(ticket)) return null;
  const cap = numberOr(ticket.contract_amount, null);
  if (cap == null) return refuse(409, MSG.noContract);
  const want = round2(amount);
  if (want <= round2(cap)) return null;
  return refuse(409, MSG.overContract, { contract_amount: round2(cap), attempted: want, over_by: round2(want - cap) });
}

// ── validation (pure) ────────────────────────────────────────────────────

function validateRate(v) {
  if (v === null || v === '' || v === undefined) return { ok: true, value: null };
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > RATE_MAX) return { ok: false, error: MSG.rate };
  return { ok: true, value: round2(n) };
}

function validateMarkup(v) {
  if (v === null || v === '' || v === undefined) return { ok: true, value: null };
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > MARKUP_MAX) return { ok: false, error: MSG.markup };
  return { ok: true, value: Math.round(n * 1000) / 1000 };
}

function validateCost(v) {
  if (v === null || v === '' || v === undefined) return { ok: true, value: null };
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > COST_MAX) return { ok: false, error: MSG.cost };
  return { ok: true, value: round2(n) };
}

function validateAmount(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > COST_MAX) return { ok: false, error: MSG.amount };
  return { ok: true, value: round2(n) };
}

function validLineId(v) {
  return typeof v === 'string' && LINE_ID_RE.test(v);
}

// ── the two destination payloads ─────────────────────────────────────────

const TABLE_OF = Object.freeze({
  labor: 'service_ticket_labor',
  material: 'service_ticket_materials_used',
});

/** "Labour — 14 Sep: rebuilt the rail" / "Material — 2x4 PT stud". */
function lineText(l) {
  const head = l.kind === 'labor' ? 'Labour' : 'Material';
  const when = l.work_date ? ' — ' + l.work_date : '';
  const where = l.task_title ? ' — ' + l.task_title : '';
  return (head + when + where + ': ' + String(l.description || '').replace(/\s+/g, ' ').trim())
    .slice(0, DESCRIPTION_MAX);
}

/**
 * changeOrderFields(ticket, sheet) -> the fields jobFin.createChangeOrder takes.
 * Cost + markup, never a total: the CO editor prices it through the shared
 * pipeline, so the office can still move a markup and watch the number follow.
 */
function changeOrderFields(ticket, sheet) {
  return {
    title: coTitle(ticket),
    status: 'draft',
    lines: sheet.lines.filter(function (l) { return l.ready; }).map(function (l) {
      return {
        description: lineText(l),
        qty: l.qty,
        unit: l.unit || '',
        unitCost: l.unit_cost,
        markup: l.effective_markup_pct === 0 ? '' : l.effective_markup_pct,
        markupMode: 'percent',
      };
    }),
  };
}

function coTitle(ticket) {
  const n = ticket && ticket.ticket_number ? ticket.ticket_number : 'Work order';
  return (n + ' — ' + (ticket && ticket.title ? ticket.title : 'work performed')).slice(0, 200);
}

/**
 * invoiceFields(ticket, sheet, billTo) -> the fields jobFin.createInvoice takes.
 * unitPrice, because an invoice is read by a client: the line has to multiply
 * out on the page. The markup is folded in and is not shown — a client is
 * quoted a price, never a cost and a percentage.
 */
function invoiceFields(ticket, sheet, billTo) {
  return {
    client_id: ticket && ticket.client_id != null ? String(ticket.client_id) : null,
    terms: 'Net 30',
    notes: 'Work order ' + (ticket && ticket.ticket_number ? ticket.ticket_number : '') + ' — time and materials.',
    billTo: billTo || null,
    lines: sheet.lines.filter(function (l) { return l.ready; }).map(function (l) {
      return {
        description: lineText(l),
        qty: l.qty,
        unitPrice: l.unit_sell,
        amount: l.total,
        taxable: l.kind === 'material',
      };
    }),
  };
}

// ── reads + writes ───────────────────────────────────────────────────────

function ticketOk(ticket) {
  return !!ticket && ticket.id != null && ticket.organization_id != null;
}

/**
 * marketRate(db, ticket) -> number | null
 * The market's labor_rate_default, which has been inert since it shipped.
 * This is the one path that reads it, and only to OFFER it: the rate is
 * STAMPED onto the ticket when it is set, so a market edited later never
 * silently re-prices a work order somebody has already looked at.
 *
 * A ticket carries no market of its own — only jobs, leads, estimates,
 * clients, subs and users do — so it inherits its parent's, job first, for
 * the same reason destinationFor() prefers the job.
 */
async function marketRate(db, ticket) {
  if (!ticketOk(ticket)) return null;
  let marketId = null;
  if (ticket.job_id) {
    // The org predicate matches assertJobInOrg's, legacy NULL-org jobs included.
    const j = await db.query(
      'SELECT market_id FROM jobs WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)',
      [String(ticket.job_id), ticket.organization_id]
    );
    marketId = j.rows[0] ? j.rows[0].market_id : null;
  }
  if (marketId == null && ticket.lead_id) {
    const l = await db.query(
      'SELECT market_id FROM leads WHERE id = $1 AND organization_id = $2',
      [String(ticket.lead_id), ticket.organization_id]
    );
    marketId = l.rows[0] ? l.rows[0].market_id : null;
  }
  if (marketId == null) return null;
  const r = await db.query(
    'SELECT labor_rate_default FROM markets WHERE id = $1 AND organization_id = $2',
    [marketId, ticket.organization_id]
  );
  return r.rows[0] ? numberOr(r.rows[0].labor_rate_default, null) : null;
}

/**
 * catalogCost(db, orgId, description) -> {unit_cost, unit, matched} | null
 * The materials catalogue holds real purchase prices. An exact, case-folded
 * description match only: a fuzzy match that pre-fills the WRONG price is
 * worse than no pre-fill, because the office's eye slides over a filled box.
 *
 * ORG-SCOPED. What a company paid for a valve is its own business, and the
 * catalogue carries organization_id. The predicate is the one the rest of the
 * app reads this table with (assembly-routes.js, ai-routes.js): this org's
 * rows, plus the legacy NULL-org rows that are shared reference data.
 */
async function catalogCost(db, orgId, description) {
  const d = String(description == null ? '' : description).trim();
  if (!d || orgId == null) return null;
  const r = await db.query(
    `SELECT description, unit, last_unit_price, avg_unit_price
       FROM materials
      WHERE LOWER(description) = LOWER($1) AND is_hidden = FALSE
        AND (organization_id = $2 OR organization_id IS NULL)
      ORDER BY last_seen DESC NULLS LAST
      LIMIT ${CATALOG_MATCH_LIMIT}`,
    [d, orgId]
  );
  const row = r.rows[0];
  if (!row) return null;
  const price = numberOr(row.last_unit_price, numberOr(row.avg_unit_price, null));
  if (price == null) return null;
  return { unit_cost: round2(price), unit: row.unit || null, matched: row.description };
}

/** The ticket's own billing columns, locked for a write. */
async function lockTicketForBilling(client, ticket) {
  const r = await client.query(
    `SELECT id, status, archived_at, bill_as, job_id, lead_id, billing_status,
            billed_change_order_id, billed_invoice_id, contract_amount
       FROM service_tickets WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
    [ticket.id, ticket.organization_id]
  );
  return r.rows[0] || null;
}

/** Set the ticket's rate and/or its default markup. Only keys that were sent. */
async function setTicketBilling(db, ticket, patch) {
  const sets = [];
  const params = [ticket.id, ticket.organization_id];
  if (Object.prototype.hasOwnProperty.call(patch, 'labor_rate')) {
    params.push(patch.labor_rate);
    sets.push('labor_rate = $' + params.length);
    params.push(patch.labor_rate == null ? null : (patch.labor_rate_source || 'typed'));
    sets.push('labor_rate_source = $' + params.length);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'default_markup_pct')) {
    params.push(patch.default_markup_pct);
    sets.push('default_markup_pct = $' + params.length);
  }
  if (!sets.length) return false;
  const r = await db.query(
    `UPDATE service_tickets SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $1 AND organization_id = $2`,
    params
  );
  return r.rowCount > 0;
}

/**
 * setLineMoney(db, kind, ticket, lineId, patch) -> rowCount
 * ONLY an accepted line takes money, and the claimed columns are never in the
 * SET — the same rule decideLine follows. A rejected line bills nothing, so
 * pricing one would be a number with nowhere to go.
 */
async function setLineMoney(db, kind, ticket, lineId, patch) {
  const table = TABLE_OF[kind];
  if (!table) throw new Error('unknown billing line kind: ' + kind);
  const sets = [];
  const params = [String(lineId), ticket.id, ticket.organization_id];
  const push = function (col, val) { params.push(val); sets.push(col + ' = $' + params.length); };
  if (Object.prototype.hasOwnProperty.call(patch, 'markup_pct')) push('markup_pct', patch.markup_pct);
  if (kind === 'material' && Object.prototype.hasOwnProperty.call(patch, 'unit_cost')) {
    push('unit_cost', patch.unit_cost);
    push('cost_source', patch.unit_cost == null ? null : (patch.cost_source || 'typed'));
  }
  if (!sets.length) return 0;
  const r = await db.query(
    `UPDATE ${table} SET ${sets.join(', ')}
      WHERE id = $1 AND ticket_id = $2 AND organization_id = $3 AND status = 'accepted'`,
    params
  );
  return r.rowCount;
}

/** Stamp what the ticket became. Called inside the billing transaction. */
async function markBilled(client, ticket, user, what) {
  const col = what.kind === 'change_order' ? 'billed_change_order_id' : 'billed_invoice_id';
  await client.query(
    `UPDATE service_tickets
        SET billing_status = 'billed', billed_at = NOW(), billed_by = $3, ${col} = $4, updated_at = NOW()
      WHERE id = $1 AND organization_id = $2`,
    [ticket.id, ticket.organization_id, (user && user.id) || null, String(what.id)]
  );
}

/** Written off: a real call that will not be charged. Not the same as 'none'. */
async function markWrittenOff(client, ticket, user, reason) {
  await client.query(
    `UPDATE service_tickets
        SET billing_status = 'written_off', billed_at = NOW(), billed_by = $3,
            write_off_reason = $4, updated_at = NOW()
      WHERE id = $1 AND organization_id = $2`,
    [ticket.id, ticket.organization_id, (user && user.id) || null, reason]
  );
}

module.exports = {
  MSG, RATE_MAX, COST_MAX, MARKUP_MAX, DESCRIPTION_MAX, REASON_MAX, BILLABLE_STATUSES, TABLE_OF,
  round2, refuse,
  billingOn, billsFromTheField, billsAContract, destinationFor,
  effectiveMarkup, lineExt, lineSell, priced, lineText,
  billingSheet, blockersFor, billedRecord, overContract, contractLineText, coTitle,
  validateRate, validateMarkup, validateCost, validateAmount, validLineId,
  changeOrderFields, invoiceFields,
  marketRate, catalogCost, lockTicketForBilling, setTicketBilling, setLineMoney,
  markBilled, markWrittenOff,
};
