'use strict';

/**
 * agent-eval-corpus.js — what counts as a failed turn, defined once, in code.
 *
 * WHY THIS FILE EXISTS
 *
 * Three planning documents rested on "48 of 696 assistant turns end in a
 * visible failure (6.9%)", and every probability derived from it, with no way to
 * re-run the number. That was fair: `ai_messages` has no error, status, verdict
 * or rating column — not in the CREATE TABLE and not in any of the fourteen
 * ALTER TABLE ... ADD COLUMN that followed it. So the figure was a human reading
 * transcripts, it could not be refreshed, and it could not be split by date.
 *
 * It could not be refreshed, and it was also probably WRONG by then.
 * scribe-refusal.js began writing a terminal `payloads` row and <recent_writes>
 * began reading it on 2026-09-21 — roughly mid-window for a 30-day window ending
 * 2026-10-04 — so the largest failure bucket was being repaired while it was
 * being counted. A number nobody can recompute cannot notice that.
 *
 * THE SIGNAL WAS ALREADY IN THE CODE. persistTurnError (routes/ai-routes.js)
 * stores a failed turn as:
 *
 *     (partialText ? partialText.trimEnd() + "\n\n" : "") + "⚠️ " + message
 *
 * So every persisted failure carries U+26A0, and the failure set is a column
 * predicate. The KIND is derivable too, because the messages are assembled from
 * a small fixed set of sentences this codebase writes on purpose. No new
 * capture, no classifier model, no labelling pass, and it reaches back to the
 * first row.
 *
 * Pure on purpose, exactly like services/usage-ledger.js beside it: the
 * definition of "failed" is testable without a database, and the route keeps
 * only the queries. A definition that needs production to evaluate is a
 * definition nobody checks.
 *
 * WHAT THIS IS NOT. It is not an eval RUNNER. Running fixtures through
 * runV2SessionStream creates real managed sessions, accretes real ai_messages,
 * and executes real tool calls — including scribe_write and quick_write — so a
 * runner needs a sink response AND a dry-run flag on every write tool before it
 * can be pointed at anything. This file only says what already happened.
 */

// U+26A0 WARNING SIGN. Built from a code point rather than pasted, so the
// predicate survives an editor, a console or a psql client that mangles the
// glyph — and matched WITHOUT the U+FE0F variation selector that follows it in
// the source, because only the base character is reliable across clients.
const WARNING_SIGN = String.fromCharCode(0x26A0);

/**
 * The buckets, in match order. `test` is applied to the message text.
 *
 * Each pattern is a sentence this codebase writes deliberately, so the
 * vocabulary is derived rather than invented — and when one of these strings is
 * reworded, the test that pins it here fails rather than the bucket silently
 * emptying into `other`. That failure mode is the whole reason the patterns live
 * beside a test instead of inside a SQL string in a route.
 */
const FAILURE_KINDS = [
  {
    kind: 'idle_watchdog',
    why: 'The turn made no progress for TURN_IDLE_MS and was ended. Until 2.00 '
       + 'this also left the upstream generating with no consumer.',
    test: (t) => t.indexOf('stopped responding and this turn was ended') !== -1,
  },
  {
    kind: 'stalled_mid_approval',
    why: 'Tool calls stalled after an approved change had already run, so the '
       + 'advice is "do not re-send this approval" (stallRetryAdvice).',
    // 're-send this approval' rather than the whole sentence: stallRetryAdvice
    // writes it twice with different capitalisation and different surrounding
    // words — 'Do NOT re-send this approval blind' and '— do NOT re-send this
    // approval. Ask 86 to confirm…'. Matching either full sentence sent the
    // other one to `other`, which is how a bucket empties without anyone
    // noticing.
    test: (t) => t.indexOf('was already applied') !== -1
              || t.indexOf('were already applied') !== -1
              || t.indexOf('re-send this approval') !== -1,
  },
  {
    kind: 'session_reset',
    why: 'The managed session was swapped between turns, so the ids the turn '
       + 'held belonged to an archived session.',
    test: (t) => t.indexOf('session was reset') !== -1
              || t.indexOf('chat session was reset') !== -1,
  },
  {
    kind: 'stream_open_failed',
    why: 'sessions.events.stream threw before the turn began.',
    test: (t) => t.indexOf('Failed to open session stream') !== -1,
  },
  {
    kind: 'raw_db_error_leaked',
    why: 'A Postgres message reached the user verbatim. Always a bug in the '
       + 'error path, never a legitimate explanation.',
    test: (t) => t.indexOf('duplicate key') !== -1
              || /violates .*constraint/.test(t)
              || /relation ".*" does not exist/.test(t)
              || t.indexOf('syntax error at or near') !== -1,
  },
  {
    kind: 'write_failed',
    why: 'A proposed write could not be applied. The largest bucket historically, '
       + 'and the one being repaired mid-window — check the date split before '
       + 'funding anything downstream of it.',
    test: (t) => t.indexOf('could not be applied') !== -1
              || t.indexOf('Change could not be applied') !== -1
              || t.indexOf('apply failed') !== -1,
  },
];

const OTHER = 'other';
const NOT_A_FAILURE = null;

/**
 * Does this assistant turn's body record a failure?
 *
 * Deliberately the same predicate the SQL uses, so the in-process answer and
 * the aggregate answer cannot disagree. A turn whose partial text happened to
 * contain the sign would be a false positive; persistTurnError is the only
 * writer that puts it there, and it always precedes the message with it.
 */
function isFailure(content) {
  return typeof content === 'string' && content.indexOf(WARNING_SIGN) !== -1;
}

/**
 * The message, without whatever partial text streamed before it.
 *
 * persistTurnError joins partial text and the message with a blank line and the
 * sign, so everything from the sign onward is the explanation. Classifying the
 * whole body instead would let a user's own quoted text pick a bucket.
 */
function failureMessage(content) {
  if (!isFailure(content)) return '';
  const at = content.indexOf(WARNING_SIGN);
  return content.slice(at + 1).replace(/^️/, '').trim();
}

/**
 * kind | 'other' | null  — null means "not a failed turn at all".
 */
function classifyFailure(content) {
  if (!isFailure(content)) return NOT_A_FAILURE;
  const msg = failureMessage(content);
  for (const k of FAILURE_KINDS) {
    if (k.test(msg)) return k.kind;
  }
  return OTHER;
}

/**
 * The corpus: one row per failed assistant turn, newest first.
 *
 * Takes no parameters by design — the window is applied by the caller so this
 * can serve both "the last 30 days" and "everything, ever", and the second is
 * the one that answers whether the rate is falling.
 *
 * $1/$2 are the window bounds. chr(9888) is U+26A0; see WARNING_SIGN.
 */
function corpusSql() {
  return `
    SELECT id, session_id, entity_type, estimate_id, user_id, created_at,
           content, model_requests, turn_input_tokens
      FROM ai_messages
     WHERE role = 'assistant'
       AND position(chr(9888) in content) > 0
       AND created_at >= $1 AND created_at < $2
     ORDER BY created_at DESC`;
}

/**
 * The rate, by month. This is the query that would have caught the staleness:
 * a single 30-day figure cannot show a bucket being repaired halfway through it.
 */
function rateByMonthSql() {
  return `
    SELECT date_trunc('month', created_at)::date AS month,
           COUNT(*)::int AS assistant_turns,
           COUNT(*) FILTER (WHERE position(chr(9888) in content) > 0)::int AS failed_turns
      FROM ai_messages
     WHERE role = 'assistant'
     GROUP BY 1
     ORDER BY 1`;
}

/**
 * The honest split of "turns that recorded no usage".
 *
 * The forensics page reported a single `turns_without_usage` count off
 * `input_tokens IS NULL`, which conflates three different things:
 *
 *   1. THE FALSY-ZERO BUG. `(usage && usage.input_tokens) || null` writes NULL
 *      for a legitimate input_tokens: 0 — the normal shape of a long, fully
 *      cached turn. Such a row still recorded cache reads, so it is detectable.
 *   2. FAILED TURNS, which record NULL usage *on purpose*: persistTurnError
 *      passes usage = null because "a failed turn has no trustworthy token
 *      accounting". These are not missing measurements, they are measured
 *      failures — and counting them as an undercount double-counts a number the
 *      failure taxonomy already reports.
 *   3. Genuinely unrecorded turns, which is the only population worth chasing.
 *
 * Reporting (1)+(2)+(3) as one figure is how "21% of turns record no usage"
 * became a headline. Splitting it is free.
 */
function noUsageSplitSql() {
  return `
    SELECT COUNT(*)::int AS no_input_tokens,
           COUNT(*) FILTER (WHERE cache_read_input_tokens IS NOT NULL)::int
             AS falsy_zero_artifact,
           COUNT(*) FILTER (WHERE position(chr(9888) in content) > 0)::int
             AS failed_turns_null_by_design,
           COUNT(*) FILTER (WHERE cache_read_input_tokens IS NULL
                              AND position(chr(9888) in content) = 0
                              AND model_requests IS NULL)::int
             AS genuinely_unrecorded,
           COUNT(*) FILTER (WHERE turn_input_tokens IS NOT NULL)::int
             AS has_turn_basis
      FROM ai_messages
     WHERE role = 'assistant' AND input_tokens IS NULL
       AND created_at >= $1 AND created_at < $2`;
}

/**
 * Roll the corpus rows into the taxonomy.
 *
 * Reports `assistant_turns` alongside, because a count of failures with no
 * denominator is the shape of number this whole file exists to retire. When the
 * denominator is unknown the rate is null rather than invented.
 */
function buildFailureReport(rows, assistantTurns) {
  const list = Array.isArray(rows) ? rows : [];
  const byKind = new Map();
  for (const k of FAILURE_KINDS) byKind.set(k.kind, { kind: k.kind, why: k.why, turns: 0, first_seen: null, last_seen: null });
  byKind.set(OTHER, {
    kind: OTHER,
    why: 'Carries the warning sign but matches no known sentence. A rising '
       + '`other` means a failure path was reworded or a new one was added.',
    turns: 0, first_seen: null, last_seen: null,
  });

  for (const r of list) {
    const kind = classifyFailure(r && r.content) || OTHER;
    const b = byKind.get(kind) || byKind.get(OTHER);
    b.turns++;
    const at = r && r.created_at ? r.created_at : null;
    if (at) {
      if (!b.first_seen || at < b.first_seen) b.first_seen = at;
      if (!b.last_seen || at > b.last_seen) b.last_seen = at;
    }
  }

  const kinds = Array.from(byKind.values())
    .filter(b => b.turns > 0)
    .sort((a, b) => b.turns - a.turns);

  const total = list.length;
  const denom = Number.isFinite(assistantTurns) ? assistantTurns : null;

  return {
    what_this_is:
      'Failed assistant turns, classified from the text persistTurnError wrote. '
      + 'This is a DERIVED measure over existing rows, not a captured one — '
      + 'ai_messages has no verdict column — so it is retroactive and can be '
      + 're-run after any fix. A turn is counted once, by the first sentence it '
      + 'matches.',
    failed_turns: total,
    assistant_turns: denom,
    // Null rather than zero when the denominator is unknown: a rate of 0 and a
    // rate of "we did not count the turns" are not the same claim.
    failure_pct: (denom && denom > 0) ? Math.round((total / denom) * 10000) / 100 : null,
    kinds: kinds,
    unclassified_turns: (byKind.get(OTHER) || {}).turns || 0,
  };
}

module.exports = {
  WARNING_SIGN,
  FAILURE_KINDS,
  isFailure,
  failureMessage,
  classifyFailure,
  corpusSql,
  rateByMonthSql,
  noUsageSplitSql,
  buildFailureReport,
};
