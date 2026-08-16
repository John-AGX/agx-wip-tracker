'use strict';

/**
 * money/cost-line-filters.js — the two exclusions that separate a raw QB
 * cost line from job cost. ONE definition, because every copy of this rule
 * has drifted from the one before it.
 *
 * There were four copies when this file was written: js/cost-buckets.js,
 * js/jobs.js, server/services/money/job-wip.js, and — the one that caused
 * the trouble — no copy at all in the per-turn AI job context, which summed
 * `amount` with no exclusions and printed the result to 86 as a job total.
 * A vendor rollup that silently includes match-only sub lines and month-end
 * accruals overstates cost, and 86 quotes it before it calls anything.
 *
 * The two rules:
 *
 *   isAccrualLine — month-end accrual / reversal journal entries. Accounting
 *     artifacts, not job cost. They net to $0 inside a full export window and
 *     strand real dollars in cost when the window cuts between the halves.
 *
 *   isSubLine — QB "Subcontractors" accounts. Subcontractor cost lives on the
 *     PO + vendor-bill side, so these lines are MATCH-ONLY: counting them as
 *     cost double-counts every sub against its bills.
 *
 * ORDER IS PART OF THE RULE. Accrual is tested FIRST: most JE lines carry the
 * Subcontractors account, and routing them to the sub bucket skews the
 * reconciliation against vendor bills into a false over-billing flag.
 * `classifyCostLine` is the ordered form — prefer it over calling the two
 * predicates yourself, so a caller cannot reintroduce the ordering bug.
 *
 * An explicit `bucket` means a human classified the line — both rules respect
 * it and step aside.
 */

// Month-end accrual / reversal journal entry. Measured live 2026-08-12:
// all 87 JE lines on the pilot were accrual pairs ("To record month-end WIP
// adjustment", JE 251 / 251R), $310,269.88 accrued against $310,269.88
// reversed, netting to $0.00 per job. A 6/30 cutoff would have left
// $22,455.12 of adjustments counted as real cost.
function isAccrualLine(l) {
  if (!l || l.bucket) return false; // manual classification wins
  return String(l.txn_type || l.txnType || '').trim() === 'Journal Entry';
}

// QB "Subcontractors" line — match-only, excluded from cost.
function isSubLine(l) {
  if (!l) return false;
  if (l.bucket) return l.bucket === 'subs';
  return /\bsub|subcontract/i.test(String(l.account || l.account_type || ''));
}

// The ordered classification. Returns 'accrual' | 'sub' | 'cost'.
// 'cost' is the only bucket that counts toward job cost.
function classifyCostLine(l) {
  if (isAccrualLine(l)) return 'accrual';
  if (isSubLine(l)) return 'sub';
  return 'cost';
}

module.exports = { isAccrualLine, isSubLine, classifyCostLine };
