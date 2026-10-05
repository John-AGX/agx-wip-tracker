'use strict';

/**
 * correction-ledger.js — what a correction IS, and how to read the pairs back.
 *
 * WHY THIS FILE EXISTS
 *
 * The decision not to train a model (see the brain analysis) rests on one
 * number: five corrected examples in the 104-day life of the training capture,
 * against the lowest threshold the repo sets for itself, 300. But volume was
 * never the binding problem — SHAPE was, and the shape was a defect, not a
 * verdict about the business:
 *
 *   payload-routes.js recorded ai_training_examples.human_final as
 *   `accepted ? { targets, apply_summary } : null`, where `targets` IS the
 *   model's own output. So an approve stored the model's answer as the human's
 *   answer (self-distillation — the feature vector is a constant), and a reject
 *   stored nothing, which the export then filtered out entirely
 *   (`human_final IS NOT NULL`).
 *
 * And there was no way to say "almost right". The only mutating routes were
 * /shown, /reject and /apply, so a near-miss had to be REJECTED — which
 * destroys the one piece of information worth keeping and records no reason.
 *
 * So the asset this file creates is the only genuine (wrong structured output,
 * right structured output) pair the business produces, on its highest-value
 * task. It is also the one asset that does not go obsolete when the next
 * frontier model ships: a fine-tune bets the next release will not subsume your
 * task, while a labelled correction gets MORE valuable with a stronger reasoner,
 * because a better reasoner does more with the same facts.
 *
 * THE CONTRACT: A CLAIM IS NEVER OVERWRITTEN.
 * `targets` keeps what the model proposed. `human_targets` holds what the human
 * actually wanted. Taken verbatim from service-ticket-field-capture.js, one of
 * only two places in this 97-table schema that already works this way — "the
 * claimed number is never overwritten, so 'the tech said 8, it was 6' stays
 * readable." A correction stored beside its claim cannot rot, because nothing
 * has to stay in step with anything.
 *
 * Pure, like usage-ledger.js, agent-eval-corpus.js and
 * agent-capability-ledger.js beside it. The routes keep the queries.
 */

/**
 * Is this edit actually a correction, or the same thing reshaped?
 *
 * A pair where the human's targets equal the model's teaches nothing and would
 * re-create the exact defect this file exists to fix — a human_final that is
 * really the model's output. So an unchanged edit is recorded as an ACCEPT, not
 * as a correction.
 *
 * Compared on a canonical form rather than with deep-equal on the raw values,
 * because the client round-trips JSON: key order and whitespace differ for
 * reasons that have nothing to do with intent, and an ordering difference
 * logged as a correction is a false positive in the one dataset that must not
 * have any.
 */
function canonical(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function isCorrection(modelTargets, humanTargets) {
  if (humanTargets === null || humanTargets === undefined) return false;
  return canonical(modelTargets) !== canonical(humanTargets);
}

/**
 * Validate an incoming edit before it touches a row.
 *
 * Deliberately strict about SHAPE and deliberately silent about CONTENT: the
 * dispatcher is the authority on whether a target is applicable, and duplicating
 * its rules here would be a second source of truth that drifts. This only
 * refuses what could never be a payload at all.
 *
 * The op-level check matters because the correction is the training label. A
 * target with no entity_type is not a usable label even if the dispatcher
 * happens to tolerate it, so it is refused at the door rather than stored and
 * filtered later.
 */
const MAX_TARGETS = 200;

function validateEdit(humanTargets) {
  if (!Array.isArray(humanTargets)) {
    return { error: 'targets must be an array.' };
  }
  if (!humanTargets.length) {
    return { error: 'targets must not be empty — reject the card instead of emptying it.' };
  }
  if (humanTargets.length > MAX_TARGETS) {
    return { error: 'targets must be ' + MAX_TARGETS + ' or fewer.' };
  }
  for (let i = 0; i < humanTargets.length; i++) {
    const t = humanTargets[i];
    if (!t || typeof t !== 'object' || Array.isArray(t)) {
      return { error: 'target ' + i + ' must be an object.' };
    }
    if (!t.entity_type || typeof t.entity_type !== 'string') {
      return { error: 'target ' + i + ' needs an entity_type.' };
    }
  }
  return { ok: true };
}

/**
 * The pairs, for export or for counting.
 *
 * $1 is the organization. Scoped by organization_id and nothing else, because
 * every other predicate here would be a filter someone has to remember — and
 * the whole point of the partial index idx_payloads_corrected is that this is
 * cheap over the full history.
 *
 * Returns the model's proposal and the human's, so the consumer can re-derive
 * isCorrection rather than trust a stored flag that could go stale.
 */
function pairsSql() {
  return `
    SELECT id, created_at, corrected_at, corrected_by, emitting_agent_key,
           title, summary, rationale,
           targets        AS model_targets,
           human_targets  AS human_targets
      FROM payloads
     WHERE organization_id = $1
       AND human_targets IS NOT NULL
     ORDER BY corrected_at DESC NULLS LAST`;
}

/**
 * The rejected-then-corrected successor join: the OTHER half of the asset, and
 * the retroactive one.
 *
 * You reject a card, say what you actually wanted, the Scribe authors a SECOND
 * payload in the same session, and that one applies. Both rows are already in
 * `payloads`; nothing has ever joined them. idx_payloads_session
 * (session_id, created_at DESC) makes the successor lookup an index seek.
 *
 * This needs no new capture and no migration — it reads rows that already
 * exist. Which also means it is the only query here whose RESULT can change the
 * plan: if the count is near zero, the forward-looking half above is the whole
 * of M4 and the retroactive story was wishful.
 */
function successorPairsSql() {
  return `
    WITH rejected AS (
      SELECT id, session_id, created_at, targets, title
        FROM payloads
       WHERE organization_id = $1
         AND status = 'rejected'
         AND session_id IS NOT NULL
    )
    SELECT r.id          AS rejected_id,
           r.created_at  AS rejected_at,
           r.title       AS rejected_title,
           r.targets     AS rejected_targets,
           a.id          AS successor_id,
           a.created_at  AS successor_at,
           a.targets     AS successor_targets
      FROM rejected r
      CROSS JOIN LATERAL (
        SELECT p.id, p.created_at, p.targets
          FROM payloads p
         WHERE p.session_id = r.session_id
           AND p.created_at > r.created_at
           AND p.status IN ('applied', 'ready')
         ORDER BY p.created_at ASC
         LIMIT 1
      ) a
     ORDER BY r.created_at DESC`;
}

/**
 * Roll pairs into a report.
 *
 * `usable` re-derives isCorrection per row instead of counting rows with a
 * non-null human_targets, because an edit that changed nothing is stored (it is
 * still a verdict) and must not be counted as a label.
 */
function buildCorrectionReport(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let usable = 0;
  for (const r of list) {
    if (r && isCorrection(r.model_targets, r.human_targets)) usable++;
  }
  return {
    what_this_is:
      'Payloads whose proposal was CORRECTED rather than approved or rejected. '
      + 'targets is what the model proposed and human_targets is what the human '
      + 'wanted; neither overwrites the other. `usable` re-derives the '
      + 'difference per row, so an edit that changed nothing is recorded as a '
      + 'verdict but never counted as a training label.',
    edited_rows: list.length,
    usable_pairs: usable,
    unchanged_edits: list.length - usable,
  };
}

module.exports = {
  canonical,
  isCorrection,
  validateEdit,
  pairsSql,
  successorPairsSql,
  buildCorrectionReport,
  MAX_TARGETS,
};
