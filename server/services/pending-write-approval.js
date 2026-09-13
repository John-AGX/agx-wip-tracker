'use strict';

// pending-write-approval.js — which staged AI write, if any, a "yes" applies.
//
// John, 2026-09-12. A spoken or typed yes applies a LOW-risk change with no
// card — but only when all of this holds, and the server decides it, not the
// model:
//
//   1. The draft was ON THE USER'S SCREEN before they said yes. The compact
//      card reports itself (POST /api/payloads/:id/shown → draft_shown_at), and
//      the yes is the latest user message in this chat, which the chat route
//      saves before the turn runs. A yes typed before the line appeared — "do
//      it" in the same breath as the request — is a yes to something the user
//      never saw, so it does not count (John's decision 2).
//   2. It is in THIS conversation, for THIS user, in THIS org, still ready.
//   3. Exactly ONE such draft. Two on screen means a bare "yes" is ambiguous,
//      and guessing which one is how the wrong change lands.
//   4. It is low risk: draft_risk says so AND the live gate still agrees (the
//      caller re-checks isHighRiskPayload on the row's targets). Deletes,
//      status changes on money records, money edits and % complete are
//      click-only (John's decision 3), and so is a row with no draft_risk.
//
// The model never chooses a payload id. There is no input to get wrong.

const REASONS = Object.freeze({
  no_chat: 'no_chat',
  none: 'none',
  not_shown: 'not_shown',
  several: 'several',
  click_only: 'click_only',
});

/**
 * findApprovableDraft(db, { orgId, userId, sessionId })
 *   -> { ok: true, row } | { ok: false, reason, count? }
 *
 * row carries id, draft_summary, draft_risk, targets.
 */
async function findApprovableDraft(db, { orgId, userId, sessionId }) {
  if (orgId == null || userId == null || sessionId == null) return { ok: false, reason: REASONS.no_chat };
  const yes = await db.query(
    `SELECT created_at FROM ai_messages
      WHERE session_id = $1 AND user_id = $2 AND organization_id = $3 AND role = 'user'
      ORDER BY created_at DESC LIMIT 1`,
    // organization_id: the chat route stamps the yes it saves; an un-stamped
    // message (an org-less account) is not a yes this org can act on.
    [sessionId, userId, orgId]
  );
  if (!yes.rows.length || yes.rows[0].created_at == null) return { ok: false, reason: REASONS.no_chat };

  // "Shown before the yes" is compared INSIDE the statement, against the same
  // latest-user-message read, never by handing a timestamp back in as a
  // parameter: a driver may return it as a Date, a string or a number, and a
  // comparison that silently coerces is a gate that silently opens or shuts.
  const r = await db.query(
    `SELECT id, draft_summary, draft_risk, targets,
            CASE WHEN draft_shown_at IS NOT NULL AND draft_shown_at < (
                   SELECT MAX(m.created_at) FROM ai_messages m
                    WHERE m.session_id = $3 AND m.user_id = $2 AND m.organization_id = $1 AND m.role = 'user'
                 ) THEN 1 ELSE 0 END AS shown_before_yes
       FROM payloads
      WHERE organization_id = $1 AND user_id = $2 AND session_id = $3
        AND status = 'ready' AND draft_summary IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 10`,
    [orgId, userId, sessionId]
  );
  const rows = r.rows || [];
  if (!rows.length) return { ok: false, reason: REASONS.none };
  const shown = rows.filter((row) => Number(row.shown_before_yes) === 1);
  if (!shown.length) return { ok: false, reason: REASONS.not_shown };
  if (shown.length > 1) return { ok: false, reason: REASONS.several, count: shown.length };
  const row = shown[0];
  if (row.draft_risk !== 'low') return { ok: false, reason: REASONS.click_only, row };
  return { ok: true, row };
}

// What 86 is told for each refusal. Plain, and never a payload id.
const REFUSAL_TEXT = {
  no_chat: 'approve_pending_write only works inside a conversation with the user. Nothing was applied.',
  none: 'Nothing in this conversation is waiting for approval (a draft may still be composing — its one-line card appears when it is ready). Nothing was applied. Tell the user that in one short line.',
  not_shown: 'The draft was not on the user\'s screen yet when they said yes, so that yes cannot approve it. Nothing was applied. Tell the user in one short line: the change is ready now — check the line above the chat box and say yes again or tap Approve.',
  several: 'Several drafts are waiting in this conversation, so a plain yes is ambiguous. Nothing was applied. Tell the user in one short line to tap Approve on the one they mean.',
  click_only: 'This change needs a tap — deletes, status changes, money and % complete are never applied from a chat yes. Nothing was applied. Tell the user in one short line to tap Approve on the card above the chat box.',
};

module.exports = { findApprovableDraft, REASONS, REFUSAL_TEXT };
