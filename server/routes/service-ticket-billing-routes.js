// BILLING A WORK ORDER (Phase 4). Office only — there is no share-link door
// on this router at all, and that is the point: every number behind these
// five doors is a price, a cost or a markup.
//
//   GET  /api/service-tickets/:id/billing                        BL1 the sheet (READ)
//   PUT  /api/service-tickets/:id/billing                        BL2 rate + default markup (WRITE)
//   PUT  /api/service-tickets/:id/billing/:kind/:lineId          BL3 one line's cost + markup (WRITE)
//   POST /api/service-tickets/:id/billing/bill                   BL4 raise the draft (WRITE)
//   POST /api/service-tickets/:id/billing/write-off              BL5 a call that will not be charged (WRITE)
//
// BL4 IS THE ONLY DOOR THAT WRITES MONEY ANYWHERE ELSE, and what it writes is
// a DRAFT: a draft change order on the job, or a draft invoice for a ticket
// that hangs off a lead. Nothing is sent, nothing is approved, and no client
// hears anything. Somebody opens the draft, reads it and decides.
//
// RE-READ UNDER THE LOCK. BL4 computes the sheet twice: once to answer the
// blockers and once inside the transaction, from rows read after
// `SELECT ... FOR UPDATE`. A line decided, a rate changed or a bill raised by
// another tab between the two is caught by the second pass, which is the one
// that counts. The first pass exists only to fail fast with a good sentence.
//
// LOCK ORDER: jobs FIRST (FOR KEY SHARE), then service_tickets (FOR UPDATE).
// Never the other way. This is the same ordering — and the same reason — as
// services/service-ticket-change-order.js: createChangeOrder's job_id FK check
// takes FOR KEY SHARE on the job row LATE, once the transaction is already
// sitting on the ticket, while DELETE /api/jobs/:id walks jobs-then-tickets.
// Two transactions in opposite orders is a cycle and Postgres kills one with
// 40P01. Taking the job lock up front is not a new lock: it is the mode the FK
// takes anyway, moved to the front.
//
// TENANCY. organization_id, ticket_id and every id come from the rows
// loadOwnedTicket already selected with the caller's org, never from a body.
'use strict';

const { pool } = require('../db');
const { requireAuth, requireOrgId } = require('../auth');
const { callerOrgId } = require('../org-access');
const bill = require('../services/service-ticket-billing');
const fc = require('../services/service-ticket-field-capture');
const jobFin = require('../services/job-financials');
const workOrder = require('../services/service-ticket-workorder');

const TICKET_NOT_FOUND = 'Service ticket not found';
const REQUIRED_DEPS = ['loadOwnedTicket', 'ticketAccessOk'];

// The URL word for each kind of priced line, matching the field-capture doors.
const KIND_OF = Object.freeze({ labor: 'labor', 'materials-used': 'material' });

/**
 * The whole sheet, plus the market's offer and any catalogue pre-fill. Kept
 * in one function because BL1 answers it and BL2/BL3/BL4 all answer it back
 * so a screen never has to guess what its own write did.
 */
async function sheetFor(db, ticket, opts) {
  const [log, rate] = await Promise.all([
    fc.listOfficeLines(db, ticket),
    bill.marketRate(db, ticket),
  ]);
  const sheet = bill.billingSheet(ticket, log, { marketRate: rate });
  sheet.waiting_lines = log.summary ? log.summary.waiting : 0;
  if (!(opts && opts.skipCatalog)) await offerCatalogPrices(db, ticket, sheet);
  return sheet;
}

/**
 * A material with no cost yet gets the catalogue's price OFFERED beside the
 * empty box — never written into it. The office types the cost; a pre-filled
 * number that nobody chose is the one an eye slides over, and the whole point
 * of cost_source is to be able to tell the two apart afterwards.
 *
 * Skipped inside the billing transaction (skipCatalog): a suggestion cannot
 * change what is billed, so it is not worth a query per line under a lock.
 */
async function offerCatalogPrices(db, ticket, sheet) {
  const need = sheet.lines.filter(function (l) { return l.kind === 'material' && l.unit_cost == null; });
  if (!need.length) return;
  const seen = new Map();
  for (const line of need) {
    const key = String(line.description || '').trim().toLowerCase();
    if (!seen.has(key)) seen.set(key, await bill.catalogCost(db, ticket.organization_id, line.description));
    const hit = seen.get(key);
    if (hit) line.catalog = hit;
  }
}

function registerBillingRoutes(router, deps) {
  REQUIRED_DEPS.forEach(function (k) {
    if (typeof deps[k] !== 'function') throw new Error('billing routes need ' + k);
  });
  const { loadOwnedTicket, ticketAccessOk } = deps;

  // Load + prove + refuse, the three lines every door here starts with.
  async function owned(req, res, mode) {
    const orgId = mode === 'write' ? req.orgId : callerOrgId(req);
    const ticket = await loadOwnedTicket(req.params.id, orgId);
    if (!ticket) { res.status(404).json({ error: TICKET_NOT_FOUND }); return null; }
    if (!(await ticketAccessOk(req, res, ticket, mode, orgId))) return null;
    if (!bill.billingOn(ticket)) { res.status(409).json({ error: bill.MSG.notBillable }); return null; }
    return ticket;
  }

  // ── BL1: the sheet ──────────────────────────────────────────────────
  router.get('/:id/billing', requireAuth, async function readBilling(req, res) {
    try {
      const ticket = await owned(req, res, 'read');
      if (!ticket) return;
      res.json(Object.assign({ ok: true }, await sheetFor(pool, ticket)));
    } catch (e) {
      console.error('[service-ticket-billing] read failed', e);
      res.status(500).json({ error: 'Failed to load the billing sheet' });
    }
  });

  // ── BL2: the rate and the markup behind every line ──────────────────
  // `use_market_rate: true` copies the market's number ONTO the ticket and
  // records that that is where it came from. It is a copy on purpose: a
  // market edited next month must not re-price a work order.
  router.put('/:id/billing', requireAuth, requireOrgId, async function setBilling(req, res) {
    try {
      const ticket = await owned(req, res, 'write');
      if (!ticket) return;
      const b = req.body || {};
      const patch = {};

      if (b.use_market_rate === true) {
        const offered = await bill.marketRate(pool, ticket);
        if (offered == null) return res.status(409).json({ error: 'This ticket’s market has no default labour rate.' });
        patch.labor_rate = offered;
        patch.labor_rate_source = 'market';
      } else if (Object.prototype.hasOwnProperty.call(b, 'labor_rate')) {
        const v = bill.validateRate(b.labor_rate);
        if (!v.ok) return res.status(400).json({ error: v.error });
        patch.labor_rate = v.value;
        patch.labor_rate_source = 'typed';
      }
      if (Object.prototype.hasOwnProperty.call(b, 'default_markup_pct')) {
        const v = bill.validateMarkup(b.default_markup_pct);
        if (!v.ok) return res.status(400).json({ error: v.error });
        patch.default_markup_pct = v.value;
      }
      if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to set.' });

      await bill.setTicketBilling(pool, ticket, patch);
      const fresh = await loadOwnedTicket(req.params.id, req.orgId);
      res.json(Object.assign({ ok: true }, await sheetFor(pool, fresh || ticket)));
    } catch (e) {
      console.error('[service-ticket-billing] set failed', e);
      res.status(500).json({ error: 'Failed to save the rate' });
    }
  });

  // ── BL3: one line's cost and markup ─────────────────────────────────
  // A labour line takes markup only: labour prices off the ticket's one rate.
  // A material line takes a cost as well, and says where the cost came from.
  router.put('/:id/billing/:kind/:lineId', requireAuth, requireOrgId,
    async function setLine(req, res) {
      try {
        const kind = KIND_OF[String(req.params.kind || '')];
        if (!kind) return res.status(404).json({ error: 'Unknown line kind' });
        const ticket = await owned(req, res, 'write');
        if (!ticket) return;
        if (!bill.billsFromTheField(ticket)) {
          return res.status(409).json({ error: fc.MSG.notTimeAndMaterials });
        }
        if (!bill.validLineId(req.params.lineId)) return res.status(404).json({ error: bill.MSG.lineGone });

        const b = req.body || {};
        const patch = {};
        if (Object.prototype.hasOwnProperty.call(b, 'markup_pct')) {
          const v = bill.validateMarkup(b.markup_pct);
          if (!v.ok) return res.status(400).json({ error: v.error });
          patch.markup_pct = v.value;
        }
        if (kind === 'material' && Object.prototype.hasOwnProperty.call(b, 'unit_cost')) {
          const v = bill.validateCost(b.unit_cost);
          if (!v.ok) return res.status(400).json({ error: v.error });
          patch.unit_cost = v.value;
          patch.cost_source = b.cost_source === 'catalog' ? 'catalog' : 'typed';
        }
        if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to set.' });

        const n = await bill.setLineMoney(pool, kind, ticket, req.params.lineId, patch);
        if (!n) {
          // Either it is not on this ticket, or it is not accepted. Tell the
          // two apart, so "only an accepted line carries money" is a sentence
          // somebody can act on rather than a 404 they retry.
          const line = await fc.loadOfficeLine(pool, kind, ticket, req.params.lineId);
          if (!line) return res.status(404).json({ error: bill.MSG.lineGone });
          return res.status(409).json({ error: bill.MSG.lineDecided, status: line.status });
        }
        res.json(Object.assign({ ok: true }, await sheetFor(pool, ticket)));
      } catch (e) {
        console.error('[service-ticket-billing] line failed', e);
        res.status(500).json({ error: 'Failed to price that line' });
      }
    });

  // ── BL4: raise the draft ────────────────────────────────────────────
  router.post('/:id/billing/bill', requireAuth, requireOrgId,
    async function billIt(req, res) {
      try {
        const ticket = await owned(req, res, 'write');
        if (!ticket) return;
        const first = await sheetFor(pool, ticket);
        if (first.blockers.length) {
          return res.status(409).json({ error: first.blockers[0].message, blockers: first.blockers, sheet: first });
        }

        // A contract ticket may be billed for LESS than its price — a job
        // part-done, a goodwill reduction — but never for more. The amount
        // defaults to the contract price when the body is silent.
        let amount = first.totals.price;
        if (bill.billsAContract(ticket) && Object.prototype.hasOwnProperty.call(req.body || {}, 'amount')) {
          const v = bill.validateAmount(req.body.amount);
          if (!v.ok) return res.status(400).json({ error: v.error });
          amount = v.value;
        }
        const over = bill.overContract(ticket, amount);
        if (over) return res.status(over.status).json(over);

        const out = await raise(req, ticket, first, amount);
        if (!out.ok) return res.status(out.status).json(out);
        res.json(out);
      } catch (e) {
        console.error('[service-ticket-billing] bill failed', e);
        res.status(500).json({ error: 'Failed to raise the draft' });
      }
    });

  /** The transaction. Everything decided again under the lock. */
  async function raise(req, ticket, preview, amount) {
    const dest = bill.destinationFor(ticket);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      try {
        // jobs FIRST — see the header. A job that is gone or in another
        // tenant matches no row and takes no lock; the ticket re-read below
        // is what answers 404.
        if (dest.kind === 'change_order') {
          await client.query(
            'SELECT 1 FROM jobs WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL) FOR KEY SHARE',
            [dest.job_id, ticket.organization_id]
          );
        }
        const locked = await bill.lockTicketForBilling(client, ticket);
        if (!locked) { await client.query('ROLLBACK'); return bill.refuse(404, TICKET_NOT_FOUND); }

        // THE SECOND PASS. The blockers are recomputed from rows read under
        // the lock, so a bill raised in another tab a moment ago is caught
        // here even though the first pass saw an unbilled ticket.
        const under = Object.assign({}, ticket, locked);
        const sheet = await sheetFor(client, under, { skipCatalog: true });
        if (sheet.blockers.length) {
          await client.query('ROLLBACK');
          return bill.refuse(409, sheet.blockers[0].message, { blockers: sheet.blockers, sheet: sheet });
        }
        const over = bill.overContract(under, amount);
        if (over) { await client.query('ROLLBACK'); return over; }

        let made, what;
        if (dest.kind === 'change_order') {
          made = await jobFin.createChangeOrder(client, {
            jobId: dest.job_id,
            orgId: ticket.organization_id,
            ownerId: req.user.id,
            fields: bill.changeOrderFields(under, sheet),
          });
          what = { kind: 'change_order', id: made.id, number: made.co_number || null };
        } else {
          made = await jobFin.createInvoice(client, {
            jobId: null,
            orgId: ticket.organization_id,
            ownerId: req.user.id,
            fields: bill.invoiceFields(under, sheet, billToFor(ticket)),
          });
          what = { kind: 'invoice', id: made.id, number: made.invoice_number || null };
        }

        await bill.markBilled(client, ticket, req.user, what);
        await workOrder.insertEvent(client, ticket, 'billed',
          { kind: 'user', userId: req.user.id || null, label: req.user.name || null },
          {
            destination: what.kind,
            document_id: what.id,
            document_number: what.number,
            lines: sheet.lines.filter(function (l) { return l.ready; }).length,
            cost: sheet.totals.cost,
            price: bill.billsAContract(under) ? amount : sheet.totals.price,
          },
          { strict: true });
        await client.query('COMMIT');
        return { ok: true, billed: what, sheet: sheet };
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) { /* the throw below is the news */ }
        throw e;
      }
    } finally {
      client.release();
    }
  }

  // ── BL5: written off ────────────────────────────────────────────────
  // A real call that will not be charged — a warranty return, a goodwill
  // visit, a job that should never have been raised. NOT the same as
  // bill_as 'none', which is a ticket from before billing existed and
  // appears in no billing view at all.
  router.post('/:id/billing/write-off', requireAuth, requireOrgId,
    async function writeOff(req, res) {
      try {
        const ticket = await owned(req, res, 'write');
        if (!ticket) return;
        const reason = String((req.body && req.body.reason) || '').trim().slice(0, bill.REASON_MAX);
        if (!reason) return res.status(400).json({ error: bill.MSG.reason });

        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          try {
            const locked = await bill.lockTicketForBilling(client, ticket);
            if (!locked) { await client.query('ROLLBACK'); return res.status(404).json({ error: TICKET_NOT_FOUND }); }
            const rec = bill.billedRecord(Object.assign({}, ticket, locked));
            if (rec) {
              await client.query('ROLLBACK');
              return res.status(409).json({
                error: rec.kind === 'written_off' ? bill.MSG.writtenOff : bill.MSG.alreadyBilled, billed: rec,
              });
            }
            await bill.markWrittenOff(client, ticket, req.user, reason);
            await workOrder.insertEvent(client, ticket, 'written_off',
              { kind: 'user', userId: req.user.id || null, label: req.user.name || null },
              { reason: reason }, { strict: true });
            await client.query('COMMIT');
          } catch (e) {
            try { await client.query('ROLLBACK'); } catch (_) { /* the throw below is the news */ }
            throw e;
          }
        } finally { client.release(); }

        const fresh = await loadOwnedTicket(req.params.id, req.orgId);
        res.json(Object.assign({ ok: true }, await sheetFor(pool, fresh || ticket)));
      } catch (e) {
        console.error('[service-ticket-billing] write-off failed', e);
        res.status(500).json({ error: 'Failed to write it off' });
      }
    });
}

/** The invoice's bill-to snapshot, from what the ticket already carries. */
function billToFor(ticket) {
  const name = ticket && (ticket.client_name || ticket.site_name);
  if (!name) return null;
  return { name: String(name), address: ticket.site_address ? String(ticket.site_address) : null };
}

module.exports = { registerBillingRoutes, KIND_OF, sheetFor, billToFor };
