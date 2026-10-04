'use strict';

/* WHO MAY SETTLE MONEY ON A JOB.
 *
 * Committing a payable — approving a vendor bill, issuing or approving a
 * purchase order — is a decision about the company's money. Recording one is
 * bookkeeping. Project 86 gated both on the same capability, ESTIMATES_EDIT,
 * which is also the capability that edits the amount, and which the builtin
 * field_crew role holds — the role whose own description reads "Estimates and
 * Cost Inbox only. NO JOBS, NO FINANCIALS."
 *
 * So the field crew could approve a vendor bill for payment or issue a purchase
 * order to a subcontractor, on any job in the company, having first edited the
 * figure. One person could key in a payable and sign it off alone.
 *
 * THE RULE, AND WHY IT IS TWO QUESTIONS AND NOT ONE
 *
 *   may you edit jobs at all?   JOBS_EDIT_ANY, or JOBS_EDIT_OWN
 *   is this one of yours?       you own it, or you hold an 'edit' job grant
 *
 * Both are required. Each one alone is wrong, in opposite directions, and both
 * mistakes were made while writing this:
 *
 *   OWNER ONLY refuses a PM who has been SHARED onto a job. job_access is a
 *   shipped feature with its own Job Sharing admin card; routes/job-routes.js
 *   canEdit admits an 'edit' grant; services/service-ticket-access.js states
 *   the narrow tier as "the jobs I own OR HAVE BEEN GRANTED"; and the
 *   owner-reassignment route documents adding a share as the way a PM keeps
 *   running a job after ownership moves. Those people are managers of that job
 *   by the product's own definition, and they could not have remedied a refusal
 *   themselves, because reassignment is admin-only.
 *
 *   A GRANT ALONE hands the right back to the field crew. Sharing a job with a
 *   crew member is an ordinary thing the office does so somebody can work on
 *   it — and if a share were sufficient, that share would also let them approve
 *   the bills on it. The hole reopens for exactly the role the gate closes.
 *
 * A grant answers WHICH JOBS. It does not answer MAY YOU EDIT JOBS AT ALL, and
 * field_crew holds no job capability of any kind.
 *
 * 'corporate' is deliberately NOT privileged here, although the change-order
 * gate in routes/change-order-routes.js does name it. That role is "read-only
 * across all jobs" and holds no ESTIMATES_EDIT, so it cannot reach these routes
 * today — and naming it would hand a read-only role settlement authority the
 * day somebody adds ESTIMATES_EDIT to it.
 *
 * ━━ THIS IS A MODULE BECAUSE THE SECOND COPY WOULD HAVE BEEN THE BUG ━━
 *
 * The rule shipped inline in bill-routes.js first and purchase orders needed
 * exactly the same thing. Two copies of an authorisation rule drift, and the
 * drift is invisible: nothing fails, one door just quietly becomes the lenient
 * one. services/notice-delivery.js makes the same argument about preferences —
 * "a user who switches a notification off must go quiet on every surface, and
 * two modules each deciding what off means is how one of them keeps writing."
 *
 * The SQL join is shared for the same reason, and it is not ceremony: a
 * mutation that dropped `AND ja.user_id = $n` from the join made ANYBODY'S
 * grant on a job admit ANY caller, and looked exactly like a working feature.
 * One copy, one place for that to be wrong.
 *
 * ━━ WHAT THIS IS NOT ━━
 *
 * It is NOT the outer door. Every caller keeps its own
 * requireCapability('ESTIMATES_EDIT'), so this can only ever REMOVE access: a
 * role that could not reach the route yesterday is not admitted by anything
 * here. And it is not a tenancy check — the caller's own query must already
 * have proved the job is in the caller's organisation, which is what makes a
 * 403 here safe to return instead of a 404.
 */

const { hasCapability } = require('../auth');

const SAFE_ALIAS = /^[a-z_][a-z0-9_]*$/;

/* The LEFT JOIN that brings the caller's own grant onto the row.
 *
 *   jobAlias   the alias of the table carrying job_id (the PO or the bill)
 *   userParam  the 1-based $n holding the CALLER's user id
 *
 * The user predicate is not optional and not a convenience: without it the join
 * matches every grant on the job, so one share to one person opens the job to
 * everybody.
 */
function jobAccessJoin(jobAlias, userParam) {
  const a = String(jobAlias || '');
  const n = Number(userParam);
  if (!SAFE_ALIAS.test(a)) throw new Error('job-money-gate: unsafe alias ' + jobAlias);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error('job-money-gate: bad param index ' + userParam);
  return 'LEFT JOIN job_access ja ON ja.job_id = ' + a + '.job_id AND ja.user_id = $' + n;
}

// The columns the verdict needs, for the caller's SELECT list.
const SELECT_COLUMNS = 'j.owner_id, ja.access_level';

/* The verdict. `row` is the joined row the caller already read: it must carry
 * owner_id and access_level (see SELECT_COLUMNS). Pure — no database, so it is
 * testable on its own and cannot fail open on a query error. */
function maySettleJobMoney(user, row) {
  if (!user || !row) return false;
  const canEditAnyJob = user.role === 'admin' || hasCapability(user, 'JOBS_EDIT_ANY');
  if (canEditAnyJob) return true;
  if (!hasCapability(user, 'JOBS_EDIT_OWN')) return false;
  // A grant of any level lets you SEE a job; only 'edit' lets you change what
  // hangs off it — the same split job-routes.js canAccess/canEdit draws, and a
  // payable hangs off a job.
  return row.owner_id === user.id || row.access_level === 'edit';
}

/* The refusal body. One wording for every money door, naming who CAN act so
 * that somebody who hits it knows what to ask for rather than being left with a
 * generic failure. `what` completes "…can <what>." */
function refusal(what) {
  return {
    error: 'Only the manager of this job, or an administrator, can ' + what + '.',
    code: 'job_money_forbidden',
  };
}

module.exports = {
  jobAccessJoin,
  SELECT_COLUMNS,
  maySettleJobMoney,
  refusal,
};
