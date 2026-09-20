// ============================================================
// Project 86 — work order / service ticket numbers
// ------------------------------------------------------------
// A number is how a ticket is spoken about: "status on WO-0142?" from a
// maintenance supervisor, "done with ST-0031" from a sub. Until now the column
// existed (service_tickets.ticket_number, with its unique partial index) and
// nothing ever wrote one, so every printed work order said just "Work order".
//
// THE SERIES IS THE BILLING BASIS, not the label:
//   bill_as 'contract'  -> ST-####   a sold service job with a contract price
//   anything else       -> WO-####   an urgent call billed after, and every
//                                    ticket that predates the two kinds
// so a number can never say one thing while the record does another.
//
// NOT the job-number registry (services/job-types.js). John's rule, 2026-09-20:
// a work order that grows into a job becomes an S-series JOB with "WO" at the
// end of its title. Job numbering and ticket numbering are separate series and
// a WO-#### is always a ticket.
//
// CLAIMING. The next number is MAX(existing) + 1 for that prefix, read inside
// the caller's transaction. Two creates racing for the same number both write
// it and the unique index (uq_service_tickets_number) raises 23505 on the
// loser, which the route retries — the arrangement server/db.js already
// describes, and the reason there is no second counter registry to keep in
// step with the first.
'use strict';

const PREFIXES = Object.freeze({ contract: 'ST', time_materials: 'WO', none: 'WO' });
const PAD = 4;

// The series a ticket belongs to, from how it bills.
function prefixFor(billAs) {
  const key = String(billAs == null ? 'none' : billAs);
  return PREFIXES[key] || 'WO';
}

// 'WO' + 42 -> 'WO-0042'. Past the pad it just gets longer; a number is never
// truncated or recycled.
function formatNumber(prefix, n) {
  const p = String(prefix || 'WO').toUpperCase().replace(/[^A-Z]/g, '') || 'WO';
  let s = String(Math.max(1, Math.floor(Number(n) || 1)));
  while (s.length < PAD) s = '0' + s;
  return p + '-' + s;
}

// Is this one of ours, and which series?
function parseNumber(value) {
  const m = /^([A-Z]{1,4})-([0-9]+)$/.exec(String(value == null ? '' : value).trim().toUpperCase());
  if (!m) return null;
  return { prefix: m[1], n: Number(m[2]) };
}

// The next free number in this org's series, always org-scoped.
//
// The series is read with LIKE and the numbers are compared HERE rather than
// in SQL. Postgres could do it with substring(… from '…') and ~, but that is
// exactly the shape the test harness cannot parse, and a rule that is only
// ever exercised against the real database is a rule nobody tests. A company's
// ticket numbers are counted in hundreds, so reading the column costs nothing,
// and the unique index is the real arbiter either way.
async function nextNumber(db, orgId, billAs) {
  const prefix = prefixFor(billAs);
  // RETIRED NUMBERS COUNT TOO. A ticket that changed series left its old
  // number behind in previous_ticket_number; handing that number to a
  // different ticket later would make the one written on somebody's purchase
  // order point at the wrong work.
  const { rows } = await db.query(
    'SELECT ticket_number, previous_ticket_number FROM service_tickets' +
    ' WHERE organization_id = $1' +
    '   AND (ticket_number LIKE $2 OR previous_ticket_number LIKE $2)',
    [orgId, prefix + '-%']
  );
  let max = 0;
  for (const row of rows || []) {
    for (const value of [row && row.ticket_number, row && row.previous_ticket_number]) {
      const parsed = parseNumber(value);
      if (parsed && parsed.prefix === prefix && parsed.n > max) max = parsed.n;
    }
  }
  return formatNumber(prefix, max + 1);
}

// Give a ticket its number if it has none. Answers the number either way, so a
// caller can print it without asking again. Never renumbers: a number, once
// spoken, belongs to that ticket for good.
async function ensureNumber(db, { orgId, ticketId, billAs, current }) {
  if (current) return String(current);
  const number = await nextNumber(db, orgId, billAs);
  const { rows } = await db.query(
    'UPDATE service_tickets SET ticket_number = $3, updated_at = NOW()' +
    ' WHERE id = $1 AND organization_id = $2 AND ticket_number IS NULL' +
    ' RETURNING ticket_number',
    [ticketId, orgId, number]
  );
  // No row means another request numbered it a moment ago; read theirs rather
  // than claiming a second one.
  if (rows[0]) return rows[0].ticket_number;
  const back = await db.query(
    'SELECT ticket_number FROM service_tickets WHERE id = $1 AND organization_id = $2',
    [ticketId, orgId]
  );
  return (back.rows[0] && back.rows[0].ticket_number) || null;
}

// A draft is not issued yet and carries no number. Every other status does.
function statusWantsNumber(status) {
  return String(status || '') !== 'draft';
}

module.exports = {
  PREFIXES,
  PAD,
  prefixFor,
  formatNumber,
  parseNumber,
  nextNumber,
  ensureNumber,
  statusWantsNumber,
};
