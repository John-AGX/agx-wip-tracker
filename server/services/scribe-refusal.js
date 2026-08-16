// scribe-refusal.js — turn a Scribe REFUSAL into a row the Writes ledger
// can show.
//
// WHY THIS EXISTS
// The Scribe write path has three endings, and until now only two of them
// left a trace anyone could look at later:
//
//   1. it drafts            → payloads row, status 'ready'      ✔ in the ledger
//   2. it drafts, we apply  → payloads row, status 'applied'    ✔ in the ledger
//   3. it can't             → NOTHING                           ✘ invisible
//
// Ending 3 is not rare and it is not a crash. driveScribeWrite deletes the
// draft on a dry-run validation failure (`DELETE FROM payloads WHERE id = $1`)
// and, when the Scribe never authors an acceptable payload across all its
// retries, no row is ever written at all. The user got a chat message and a
// push — both of which scroll away — and the ledger, asked "what did the
// coworker do today?", answered with a list containing only its successes.
//
// A ledger that lists only wins is the same lie the Live Writer was built to
// end, moved into a new place. So a refusal is recorded as what it is: a
// TERMINAL payload row, status 'failed', apply_error = the reason, and an
// empty targets array — which is precisely what distinguishes it from an
// apply that blew up. Every surface reads it off the same feed, with no new
// table and no new endpoint.
//
// Kept in services/ (not routes/) on purpose: routes/* can only be required
// where JWT_SECRET is set, and this is pure enough to test without one.

// The reason string is written by a model and read by a human in a rail
// 236px wide. Collapse it, strip anything that looks like markup, and cap it.
function tidyReason(err) {
  const s = String(err == null ? '' : err)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return 'The Scribe did not produce a usable change, and gave no reason.';
  return s.length > 800 ? (s.slice(0, 800) + '…') : s;
}

// The instruction 86 handed over. Shown as the row's summary so the ledger
// says what was ASKED for, not just that something failed — "couldn't draft
// that" with no subject is only marginally better than silence.
function tidyInstruction(instr) {
  const s = String(instr == null ? '' : instr).replace(/\s+/g, ' ').trim();
  if (!s) return 'A change the Scribe was asked to draft.';
  return s.length > 400 ? (s.slice(0, 400) + '…') : s;
}

// A short, human title for the rail. First clause of the instruction, so a
// day of refusals doesn't read as twenty identical rows.
function refusalTitle(instr) {
  const s = String(instr == null ? '' : instr).replace(/\s+/g, ' ').trim();
  if (!s) return "Scribe couldn't draft a change";
  const head = s.split(/(?<=[.!?])\s|—|;/)[0].trim() || s;
  const clipped = head.length > 90 ? (head.slice(0, 90) + '…') : head;
  return "Couldn't draft: " + clipped;
}

/* buildRefusalRow({ id, orgId, userId, sessionId, instruction, error })
 *   → { text, params } for a single INSERT, or null when it must not be
 *     written.
 *
 * Returns null without an org or an id: payloads.organization_id is NOT NULL
 * and it is the tenant boundary. A refusal we cannot attribute is one we do
 * not record — an unscoped ledger row is worse than a missing one.
 *
 * status is 'failed' and applied_at stays NULL, so the row is terminal on
 * arrival: claimable() refuses anything that isn't 'ready'/'applying', so
 * nothing here can be approved, applied, or re-run. targets is '[]' — the
 * flag every surface reads to tell a refusal from a failed apply.
 */
function buildRefusalRow(opts) {
  const o = opts || {};
  if (!o.id || !o.orgId) return null;
  const title = refusalTitle(o.instruction);
  const summary = tidyInstruction(o.instruction);
  const reason = tidyReason(o.error);
  // file_content is NOT NULL. It holds the record of the attempt rather than
  // a fabricated payload body — nothing downstream may mistake this for a
  // change that could be applied.
  const fileContent = {
    kind: 'scribe_refusal',
    instruction: summary,
    error: reason,
    recorded_at: new Date().toISOString()
  };
  return {
    text:
      `INSERT INTO payloads
         (id, organization_id, user_id, session_id, source, emitting_agent_key,
          filename, file_content, targets, title, summary, status, apply_error)
       VALUES ($1, $2, $3, $4, 'scribe', 'scribe', $5, $6::jsonb, '[]'::jsonb, $7, $8, 'failed', $9)
       ON CONFLICT (id) DO NOTHING`,
    params: [
      o.id,
      o.orgId,
      o.userId || null,
      o.sessionId || null,
      o.id + '.refusal.json',
      JSON.stringify(fileContent),
      title,
      summary,
      reason
    ]
  };
}

module.exports = { buildRefusalRow, refusalTitle, tidyReason, tidyInstruction };
