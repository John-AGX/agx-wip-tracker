// server/services/money/overbill.js — the over-billing decision.
//
// A vendor bill's amount had no enforced relationship to the PO it bills
// against (KNOWN_ISSUES INT-4), so a sub could be paid past their
// commitment and nothing in the system would say so. The PO editor
// already *displayed* billed-vs-total; it just never stopped anyone.
//
// Pure on purpose. The route does the IO (load the PO, sum the sibling
// bills) and calls this with three numbers, so the money math is
// testable without booting auth or a database — and so there is exactly
// one place that decides what "over-billed" means.
'use strict';

// One cent. A bill and a PO are both exact figures; anything past
// float-representation noise is a real overage. Deliberately not a
// percentage — a percentage tolerance on a large PO silently authorizes
// a large overage.
const OVERBILL_TOLERANCE = 0.01;

/**
 * @param {number} poTotal       the PO's COMMITTED total — see note below
 * @param {number} alreadyBilled sum of other non-void bills on this PO
 * @param {number} newAmount     the bill being written
 * @returns {object|null} null when fine, else a 409-shaped body
 *
 * poTotal must come from poEffectiveTotal() — the frozen baseline plus
 * APPROVED addendum deltas — not the raw line sum. A PO under revision
 * carries unapproved pending changes, and billing against a price nobody
 * approved is precisely the hole this guard exists to close.
 */
function overbillVerdict(poTotal, alreadyBilled, newAmount) {
  poTotal = Number(poTotal) || 0;
  alreadyBilled = Number(alreadyBilled) || 0;
  newAmount = Number(newAmount) || 0;
  // A $0 or unpriced PO authorizes nothing, so there is no ceiling to
  // exceed. Guarding here also stops a PO whose lines haven't been filled
  // in yet from blocking every bill against it — the guard must not
  // become the problem.
  if (!(poTotal > 0)) return null;
  const total = alreadyBilled + newAmount;
  if (total <= poTotal + OVERBILL_TOLERANCE) return null;
  return {
    error: 'Over-billing the purchase order',
    code: 'OVERBILL',
    po_total: Math.round(poTotal * 100) / 100,
    already_billed: Math.round(alreadyBilled * 100) / 100,
    this_bill: Math.round(newAmount * 100) / 100,
    would_total: Math.round(total * 100) / 100,
    over_by: Math.round((total - poTotal) * 100) / 100,
    hint: 'Raise the PO (or add an approved addendum) if the extra work is real. To record it anyway, resend with allow_overbill: true.'
  };
}

module.exports = { overbillVerdict, OVERBILL_TOLERANCE };
