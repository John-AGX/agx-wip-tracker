'use strict';

/**
 * usage-ledger.js — assembles the usage-forensics grand ledger, and is the
 * place the honesty contract for it lives.
 *
 * WHY THIS FILE EXISTS
 *
 * /api/admin/console/usage-forensics is the instrument this deployment tunes
 * 86 by, and it was narrower than its own label in three independent ways:
 *
 *   1. Its header said "EVERY Anthropic consumer the server records" and it
 *      published a field called `everything_total_in`. It summed FIVE lanes.
 *      Around nine other files call the API — email triage (one call per
 *      inbound email), receipt OCR, bulk document OCR, attachment OCR,
 *      caption tidy, materials extraction, session labels, SMS — and none of
 *      them persists a token count anywhere this endpoint can read.
 *   2. The background lane's TOTAL was summed from the `LIMIT 20` query that
 *      feeds the display list, so it reported "the 20 most expensive jobs"
 *      under the label "the lane".
 *   3. A managed-agent session is ALSO billed for RUNTIME ($0.08 per
 *      session-hour). No token ledger can express that, and this one did not
 *      say so.
 *
 * services/agent-prefix-ledger.js already set the contract for exactly this
 * situation, for the prompt side: a ledger may be incomplete, it may NOT be
 * incomplete and silent about it; a total exists only when it is complete;
 * everything unmeasured is named with a reason. This is that contract applied
 * to the spend side, as a pure function so it can be tested without a
 * database and without a Postgres dialect the test shim has to learn.
 */

// The lanes that call Anthropic and record nothing this endpoint can read.
// Each entry names WHERE it is and WHY it cannot be counted, so the list
// cannot rot into a vague disclaimer. Adding a model call site to this repo
// means adding it here or wiring it into a lane that records.
const UNMEASURED_LANES = [
  { lane: 'email triage', where: 'services/email-triage.js', trigger: 'one model call per inbound email, fire-and-forget from the webhook', why_not_measured: 'persists no token count' },
  { lane: 'receipt OCR', where: 'routes/receipt-routes.js', trigger: 'per receipt image', why_not_measured: 'persists no token count' },
  { lane: 'document OCR (bulk import)', where: 'routes/doc-import-routes.js', trigger: 'per imported PO/CO/invoice page set', why_not_measured: 'persists no token count' },
  { lane: 'attachment OCR', where: 'services/attachment-ocr.js', trigger: 'per attachment text extraction', why_not_measured: 'persists no token count' },
  { lane: 'caption tidy', where: 'services/caption-tidy.js', trigger: 'per photo caption pass', why_not_measured: 'persists no token count' },
  { lane: 'materials extraction', where: 'services/materials-extract.js', trigger: 'per takeoff/spreadsheet extraction', why_not_measured: 'increments usage_counters, which is an EVENT count for billing limits, not tokens' },
  { lane: 'session label', where: 'routes/ai-routes.js maybeGenerateSessionLabel', trigger: 'one Haiku call per new session', why_not_measured: 'persists no token count' },
  { lane: 'SMS', where: 'server/sms.js', trigger: 'per SMS handled', why_not_measured: 'persists no token count' },
  { lane: 'managed-agent session RUNTIME', where: 'Anthropic billing — not a token lane at all', trigger: '$0.08 per session-hour of running status, on every 86 session', why_not_measured: 'the server records no session runtime; rate is MANAGED_SESSION_RUNTIME_USD_PER_HOUR in services/ai-pricing.js' },
];

const sumBy = (rows, key) => (Array.isArray(rows) ? rows : [])
  .reduce((a, r) => a + Number((r && r[key]) || 0), 0);

/**
 * Build the ledger.
 *
 * @param {object} p
 * @param {Array}  p.chatBySurface   one row per entity_type: input_tokens, cache_creation, cache_read, output_tokens
 * @param {object} p.agentJobsTotal  the UNLIMITED aggregate over agent_jobs: { n, total_in, output_tokens }
 * @param {Array}  p.subtasks        ai_subtasks aggregate rows
 * @param {Array}  p.replays         ai_replays aggregate rows
 * @param {Array}  p.watchRuns       the retired watch lane, reported but never summed into the subtotal
 * @param {object} p.turnBasis       per-turn column sums + the row counts on each basis
 */
function buildGrandLedger(p) {
  const o = p || {};
  const chat = o.chatBySurface || [];
  const aj = o.agentJobsTotal || {};
  const tb = o.turnBasis || {};

  const grand = {
    chat_total_in: sumBy(chat, 'input_tokens') + sumBy(chat, 'cache_creation') + sumBy(chat, 'cache_read'),
    chat_output: sumBy(chat, 'output_tokens'),
    // From the UNLIMITED aggregate. A caller that passes the display list's
    // rows here is re-introducing defect (2) above.
    agent_jobs_total_in: Number(aj.total_in || 0),
    agent_jobs_output: Number(aj.output_tokens || 0),
    agent_jobs_n: Number(aj.n || 0),
    subtasks_total_in: sumBy(o.subtasks, 'input_tokens') + sumBy(o.subtasks, 'cache_creation') + sumBy(o.subtasks, 'cache_read'),
    replays_in: sumBy(o.replays, 'input_tokens'),
  };

  // A SUBTOTAL. The name says so, and `ledger_complete` is false for as long
  // as anything sits in unmeasured_lanes — which is not a temporary state to
  // be cleared by deleting the list.
  grand.recorded_total_in = grand.chat_total_in + grand.agent_jobs_total_in
    + grand.subtasks_total_in + grand.replays_in;

  // The chat lane on BOTH bases. model_requests > rows_turn_basis is the
  // proof that the per-request columns were a floor: that many extra model
  // requests happened inside turns that each filed only one.
  grand.chat_turn_basis = {
    rows_turn_basis: Number(tb.rows_turn_basis || 0),
    rows_request_basis_only: Number(tb.rows_request_basis_only || 0),
    total_in: Number(tb.turn_input_tokens || 0) + Number(tb.turn_cache_creation || 0) + Number(tb.turn_cache_read || 0),
    output: Number(tb.turn_output_tokens || 0),
    model_requests: Number(tb.model_requests || 0),
    tool_calls_executed: Number(tb.tool_calls_executed || 0),
    note: 'turn_* columns exist from 2026-10-04. Rows before that carry only the per-REQUEST four, '
      + 'so these sums cover rows_turn_basis rows and NOT rows_request_basis_only.',
  };

  grand.unmeasured_lanes = UNMEASURED_LANES;
  grand.ledger_complete = UNMEASURED_LANES.length === 0;

  // The retired lane stays QUERIED — a lane claimed to be zero should be
  // proven zero, not assumed — but it is reported beside the subtotal rather
  // than padding it.
  grand.retired_lanes_confirmed_zero = {
    watches_total_in: sumBy(o.watchRuns, 'input_tokens') + sumBy(o.watchRuns, 'cache_creation') + sumBy(o.watchRuns, 'cache_read'),
    note: 'proactive watches retired 2026-07-03; tables kept. Non-zero here means the scheduler came back.',
  };

  return grand;
}

module.exports = { buildGrandLedger, UNMEASURED_LANES };
