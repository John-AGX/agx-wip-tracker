// Content-derived ids for QB cost lines.
//
// Extracted from qb-cost-routes.js so the hashing can be tested without
// booting the router (which pulls in the DB pool and auth). The hash for
// the FIRST occurrence of a line MUST stay byte-identical to the original —
// every row already in qb_cost_lines is keyed by it, and any change orphans
// the lot. See the occurrence-index note on hashLineId: repeats extend the
// input, first occurrences never do.

const crypto = require('crypto');

// Stable content-hash id. Same logical QB row → same id forever.
// Includes job_id so the same vendor invoice landing on two
// different jobs gets two distinct rows.
//
// ── WHY THERE IS AN OCCURRENCE INDEX ──────────────────────────────────
// QuickBooks really does print the same row more than once: seven separate
// $50.00 City of Tampa permit expenses on RV2001, all dated 12/03/2025, all
// with a blank Num and the same memo. They are seven real charges. Keyed on
// content alone they are ONE id, so six of them never reach the table — and
// the import receipt counts them as "already on file (updated in place)" and
// paints green. On the 2026-10-01 export that was 42 rows and $4,848.01,
// concentrated enough to matter on small jobs: S2229 lost 8.5% of its cost,
// S2032 8.2%.
//
// So the CALLER counts how many times it has already seen this exact content
// within one submission and passes the index. Three properties make that safe:
//
//   * BACKWARD COMPATIBLE BY CONSTRUCTION. Index 0 hashes the original eight
//     parts, byte for byte, so every row already in qb_cost_lines keeps its
//     id. Only the 2nd and later copies — rows that were never stored at all —
//     get a new one. Nothing is orphaned and nothing is double-counted.
//   * ORDER-INDEPENDENT. The colliding rows are identical in every hashed
//     field, so it does not matter which copy gets index 0 and which gets
//     index 1: any permutation yields the same SET of ids. A re-import of the
//     same report therefore upserts in place, whatever order QB emits.
//   * STABLE ACROSS IMPORTS. Index n of a given content tuple is always the
//     same id, so next week's export updates these rows rather than adding
//     more beside them.
//
// A copy that DISAPPEARS from a later export leaves its row behind, exactly
// as a deleted line always has — this importer never deletes, by design.
function hashLineId(jobId, line, dupIndex) {
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
  // Appended ONLY for a repeat. The zeroth occurrence must hash the array
  // above unchanged — that is what keeps every existing row reachable.
  const n = Math.floor(Number(dupIndex) || 0);
  if (n > 0) parts.push('#' + n);
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
// No occurrence index, deliberately: the phantom row was written by the
// pre-fix parser, which had no index and collapsed every repeat onto one id.
// So the only stale row that can exist is the zeroth one. The caller is
// expected to ask for this on the zeroth occurrence only.
function staleZeroLineId(jobId, line) {
  return hashLineId(jobId, Object.assign({}, line, { amount: 0 }));
}

module.exports = { hashLineId, staleZeroLineId };
