// Content-derived ids for QB cost lines.
//
// Extracted from qb-cost-routes.js so the hashing can be tested without
// booting the router (which pulls in the DB pool and auth). The hash
// MUST stay byte-identical to the original — every row already in
// qb_cost_lines is keyed by it, and any change orphans the lot.

const crypto = require('crypto');

// Stable content-hash id. Same logical QB row → same id forever.
// Includes job_id so the same vendor invoice landing on two
// different jobs gets two distinct rows.
function hashLineId(jobId, line) {
  const parts = [
    String(jobId || ''),
    String(line.vendor || '').trim().toLowerCase(),
    String(line.date || '').trim(),
    String(line.txnType || '').trim().toLowerCase(),
    String(line.num || '').trim(),
    String(line.account || '').trim(),
    String(line.memo || '').trim(),
    Number(line.amount || 0).toFixed(2)
  ];
  const h = crypto.createHash('sha256');
  h.update(parts.join('␟')); // unit-separator char so legitimate "|" in memos doesn't collide
  return 'qbc_' + h.digest('hex').slice(0, 16);
}

// The id this same line WOULD have carried when the client parser was
// zeroing credits.
//
// QB formats negative amounts in accounting parentheses — "(1,234.56)" —
// and the pre-fix client toNumber() turned that into NaN and then 0. So
// every credit already in the table is stored under the hash of "this
// line with amount 0.00". Because amount is part of the hash, the
// corrected row (-1234.56) gets a DIFFERENT id, which means the import's
// ON CONFLICT upsert can't reach the old row — it would linger forever
// as a phantom $0.00 line next to the corrected one.
//
// Totals are unaffected (a $0 row adds nothing), but the line lists look
// wrong. This lets the importer delete precisely the superseded row and
// nothing else: same job, same vendor/date/type/num/account/memo, amount
// exactly 0.
function staleZeroLineId(jobId, line) {
  return hashLineId(jobId, Object.assign({}, line, { amount: 0 }));
}

module.exports = { hashLineId, staleZeroLineId };
