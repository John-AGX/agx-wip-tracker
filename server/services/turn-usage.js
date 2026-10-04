'use strict';

/**
 * turn-usage.js — the arithmetic of "what did this TURN cost", in one place.
 *
 * WHY THIS FILE EXISTS
 *
 * The managed session emits `span.model_request_end` once per MODEL REQUEST,
 * and one turn makes several: one per tool-use round, plus one per stream
 * reopen (stall nudge, builtin continuation). So "the turn's usage" is a SUM
 * over those events, and "the usage of one request" is the LAST one seen.
 * Both are legitimate numbers and they are not the same number.
 *
 * Two drivers consume that event, and they disagreed:
 *
 *   runV2SessionStream (interactive /86/chat)  — `usage = {...}`, an ASSIGN,
 *       declared inside the run loop. Every request overwrote the one before,
 *       and the row written to ai_messages therefore described the LAST
 *       request of the LAST pass as if it were the turn. The symptom was
 *       visible in the forensics for anyone who divided: 46,468 average input
 *       tokens per logged turn, against a registered prefix of 67,100 that
 *       every single turn has to read. A turn cannot cost less than its own
 *       prefix.
 *   driveSubtaskTurn (background jobs, escalations, the Scribe) — `+=`, four
 *       fields, correct, and counting no requests.
 *
 * That is the same shape as the bug `toolResultContent` was extracted to
 * stop: two copies of one rule, drifting, with the quieter copy wrong for
 * months. One writer, both callers, and the per-request snapshot named as
 * such so nobody has to infer which meaning a variable carries.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * No pricing. Tokens are counted here and priced in services/ai-pricing.js.
 * And no claim to totality: a managed-agent session is ALSO billed for
 * runtime ($0.08 per session-hour), which no token count can express.
 */

/** A fresh per-turn accumulator. model_requests starts at 0, not 1. */
function blankTurnUsage() {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    model_requests: 0
  };
}

/**
 * Add one model request's usage to a turn accumulator. Mutates and returns
 * `acc` so a caller can use it inline in an event handler.
 *
 * A missing or malformed `model_usage` adds nothing AND counts no request:
 * an event that carried no numbers is not evidence of a request we can
 * price, and inventing a zero-token request would make model_requests lie
 * in the one direction that matters (it is the field that says whether the
 * per-request columns were a floor).
 */
function addModelRequest(acc, modelUsage) {
  if (!acc) return acc;
  if (!modelUsage || typeof modelUsage !== 'object') return acc;
  const n = (v) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  };
  acc.input_tokens += n(modelUsage.input_tokens);
  acc.output_tokens += n(modelUsage.output_tokens);
  acc.cache_creation_input_tokens += n(modelUsage.cache_creation_input_tokens);
  acc.cache_read_input_tokens += n(modelUsage.cache_read_input_tokens);
  acc.model_requests += 1;
  return acc;
}

/**
 * The per-REQUEST snapshot — the shape the four long-standing ai_messages
 * columns hold, and which agent-prefix-ledger reads on purpose
 * (observed_first_turn_tokens is one request by definition; peak_turn_input
 * is a MAX over requests). Kept as its own named function so that meaning is
 * declared rather than implied by an assignment.
 */
function perRequestUsage(modelUsage) {
  if (!modelUsage || typeof modelUsage !== 'object') return null;
  return {
    input_tokens: modelUsage.input_tokens,
    output_tokens: modelUsage.output_tokens,
    cache_creation_input_tokens: modelUsage.cache_creation_input_tokens,
    cache_read_input_tokens: modelUsage.cache_read_input_tokens
  };
}

/** True when the two bases agree — i.e. the turn made one model request. */
function singleRequestTurn(acc) {
  return !!acc && acc.model_requests === 1;
}

module.exports = {
  blankTurnUsage,
  addModelRequest,
  perRequestUsage,
  singleRequestTurn
};
