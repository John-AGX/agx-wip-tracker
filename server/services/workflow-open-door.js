'use strict';

/* "STILL NEEDS SOMEBODY TO ACT" — AND IT IS NOT `closed_at IS NULL`.
 *
 * job_workflow_items holds three kinds of record (RFIs, submittals,
 * transmittals) with three different status vocabularies, and `closed_at` is
 * written by exactly one rule in routes/job-workflow-routes.js: it is stamped
 * for 'closed' | 'approved' | 'rejected' | 'received' and CLEARED for
 * everything else. That rule is fine for what closed_at means. It is not a
 * synonym for "open", and two shipped readers treated it as one:
 *
 *   · GET /api/workflow-items/overdue filtered on `closed_at IS NULL` with NO
 *     type filter at all, so an RFI somebody had already ANSWERED, and a
 *     transmittal already SENT, were both listed as overdue — forever, because
 *     nothing a user can do to an answered RFI ever sets closed_at. The only
 *     escape was to close it, which is not what "answered" means.
 *   · the partial index idx_jwi_due_open (server/db.js) is defined on the same
 *     predicate, and its comment says "Overdue scanning" — it was built for a
 *     scan that had not been written yet.
 *
 * The product bug was quiet because nothing mailed anybody about it. The
 * deadline digest would have made it loud: a daily email about an RFI that was
 * answered weeks ago, with no way to stop it. So the rule is stated here ONCE,
 * and the three readers ask it instead of each spelling a predicate:
 *
 *   OPEN_STATUSES            the vocabulary, per type
 *   openSql(alias)           a parameterless SQL fragment for a WHERE clause
 *   isOpen(type, status)     the same answer in JS, for a row already in hand
 *
 * KEEP `closed_at IS NULL` ALONGSIDE openSql, never instead of it: it is what
 * makes idx_jwi_due_open applicable, and it is not wrong — it is merely not
 * sufficient. A closed record is always not-open; an open one always has a
 * NULL closed_at. Dropping the term costs the index; dropping openSql costs
 * the correctness.
 *
 * THE STATUS LITERALS BELOW ARE NEVER CALLER INPUT. They are interpolated into
 * SQL, which is safe only because this map is the whole vocabulary and nothing
 * outside this file contributes to it — the same discipline ENTITY_TABLES uses
 * in services/attachment-org-scope.js. A status that arrives on a request is
 * validated against VALID_STATUSES at the route and then bound as a parameter;
 * it never reaches this file.
 */

// Per type: the statuses that still need action. routes/job-workflow-routes.js
// imports this rather than keeping the second copy it used to have.
const OPEN_STATUSES = Object.freeze({
  rfi: Object.freeze(['open']),
  submittal: Object.freeze(['submitted', 'revise_resubmit']),
  transmittal: Object.freeze(['pending']),
});

const SAFE = /^[a-z_]+$/;

function quoted(list) {
  return list.map(function (s) {
    if (!SAFE.test(s)) throw new Error('workflow-open-door: unsafe status literal ' + s);
    return "'" + s + "'";
  }).join(', ');
}

/* A WHERE fragment, already parenthesised, carrying no bind parameters — so a
 * caller can drop it into a query without renumbering $1..$n. `alias` is the
 * table alias (or table name) the caller used. */
function openSql(alias) {
  const a = String(alias || 'job_workflow_items');
  if (!SAFE.test(a.replace(/\./g, '_'))) throw new Error('workflow-open-door: unsafe alias ' + a);
  const arms = Object.keys(OPEN_STATUSES).map(function (type) {
    const list = OPEN_STATUSES[type];
    const test = list.length === 1
      ? a + ".status = '" + list[0] + "'"
      : a + '.status IN (' + quoted(list) + ')';
    return '(' + a + ".type = '" + type + "' AND " + test + ')';
  });
  return '(' + arms.join(' OR ') + ')';
}

// The same answer for a row already read. An unknown type is NOT open: a type
// this file cannot speak for is one nobody should be mailed about.
function isOpen(type, status) {
  const list = OPEN_STATUSES[String(type)];
  return !!list && list.indexOf(String(status)) !== -1;
}

module.exports = {
  OPEN_STATUSES,
  openSql,
  isOpen,
};
