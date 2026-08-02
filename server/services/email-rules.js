// server/services/email-rules.js — the E4 rules ENGINE (the IO half).
//
// Loads a user's enabled rules for one phase, asks email-rules-match
// whether each fires, and applies the actions. The matching logic — the
// part that decides whether someone's mail moves — lives next door and is
// unit-tested without a database.
//
// TWO PHASES (see the email_rules table comment):
//   runRules('inbound', …)     right after storeInboundMessage files it
//   runRules('post_triage', …) right after triage fills ai_category
//
// FAIL-SOFT, ALWAYS. This runs on the delivery path. A broken rule, a
// deleted folder, a label from another org — none of them may cost us the
// message. Every failure is logged and skipped; the mail is already
// stored by the time we get here and stays where it is.
'use strict';

const { pool } = require('../db');
const { matchesRule } = require('./email-rules-match');
const ef = require('./email-folders');

const MAX_RULES = 100;   // a runaway list must not stall the delivery path

/** The caller's enabled rules for one phase, in their chosen order. */
async function loadRules(userId, phase) {
  const r = await pool.query(
    `SELECT id, name, run_phase, enabled, match_all, stop_on_match, sort, conditions, actions
       FROM email_rules
      WHERE user_id = $1 AND run_phase = $2 AND enabled
      ORDER BY sort ASC, created_at ASC
      LIMIT ${MAX_RULES}`,
    [userId, phase]
  );
  return r.rows.map((row) => Object.assign({}, row, {
    // jsonb usually arrives parsed, but a driver/column change shouldn't
    // turn every rule into a silent no-match.
    conditions: typeof row.conditions === 'string' ? safeParse(row.conditions) : (row.conditions || []),
    actions: typeof row.actions === 'string' ? safeParse(row.actions) : (row.actions || []),
  }));
}

function safeParse(s) { try { return JSON.parse(s) || []; } catch (e) { return []; } }

/**
 * Apply ONE action to one message. Returns a short description of what it
 * did, or null when it did nothing.
 *
 * Every action re-resolves its target through the owner-scoped helpers, so
 * a rule referencing a folder or label that has since been deleted — or
 * that never belonged to this user — is a no-op rather than a write into
 * someone else's mailbox.
 */
async function applyAction(ctx, action, message) {
  const type = action && action.type;
  if (!type) return null;

  switch (type) {
    case 'move': {
      // Accept a slug ('invoices-bills') or a raw folder id, because a
      // rule authored against the system spine should keep working for
      // every user even though their folder ids differ.
      let folderId = await ef.systemFolderId(ctx.orgId, ctx.userId, String(action.folder));
      if (!folderId) {
        const f = await ef.getFolderForFiling(ctx.orgId, ctx.userId, String(action.folder));
        folderId = f ? f.id : null;
      }
      if (!folderId) return null;
      // ONLY move mail that is still where the rule expected to find it.
      // If a human has already filed it somewhere, the rule has lost its
      // claim — same principle the snooze cron follows.
      const u = await pool.query(
        `UPDATE inbound_emails SET folder_id = $1
          WHERE id = $2 AND user_id = $3
            AND (folder_id IS NULL OR folder_id = $4)`,
        [folderId, message.id, ctx.userId, message.folder_id || null]
      );
      return u.rowCount ? 'moved' : null;
    }

    case 'label': {
      const name = String(action.label || '').trim();
      if (!name) return null;
      // Idempotent create-or-fetch, matching the label API's own
      // case-insensitive uniqueness.
      const l = await pool.query(
        `INSERT INTO email_labels (organization_id, name, created_by)
              VALUES ($1, $2, $3)
         ON CONFLICT (organization_id, (LOWER(name)))
           DO UPDATE SET archived_at = NULL, updated_at = NOW()
         RETURNING id`,
        [ctx.orgId, name.slice(0, 60), ctx.userId]
      );
      if (!l.rows.length) return null;
      await pool.query(
        `INSERT INTO email_message_labels (message_id, label_id, created_by)
              VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [message.id, l.rows[0].id, ctx.userId]
      );
      return 'labelled';
    }

    case 'star':
      await pool.query('UPDATE inbound_emails SET is_starred = TRUE WHERE id = $1 AND user_id = $2',
        [message.id, ctx.userId]);
      return 'starred';

    case 'mark_read':
      await pool.query('UPDATE inbound_emails SET is_read = TRUE WHERE id = $1 AND user_id = $2',
        [message.id, ctx.userId]);
      return 'marked read';

    case 'link_entity': {
      const t = String(action.entity_type || '').trim();
      const id = String(action.entity_id || '').trim();
      if (!t || !id) return null;
      // Only fill a BLANK link — never overwrite what resolveSenderEntity
      // or a human already established.
      const u = await pool.query(
        `UPDATE inbound_emails SET entity_type = $1, entity_id = $2, entity_label = COALESCE($3, entity_label)
          WHERE id = $4 AND user_id = $5 AND entity_type IS NULL`,
        [t, id, action.entity_label || null, message.id, ctx.userId]
      );
      return u.rowCount ? 'linked' : null;
    }

    // forward / auto_reply are refused at save time (validateRule) because
    // P86 has no send path. If one is somehow stored, do nothing rather
    // than pretend.
    default:
      return null;
  }
}

/**
 * Run every enabled rule for `phase` against one message.
 * Returns { matched, applied[] } for logging; never throws.
 */
async function runRules(phase, ctx, message) {
  const out = { matched: 0, applied: [] };
  try {
    if (!ctx || !ctx.userId || !ctx.orgId || !message || !message.id) return out;
    const rules = await loadRules(ctx.userId, phase);
    if (!rules.length) return out;

    for (const rule of rules) {
      let hit = false;
      try { hit = matchesRule(rule, message); } catch (e) { hit = false; }
      if (!hit) continue;
      out.matched++;

      for (const action of (rule.actions || [])) {
        try {
          const did = await applyAction(ctx, action, message);
          if (did) out.applied.push(rule.name + ': ' + did);
        } catch (e) {
          // One bad action must not abandon the rest of the rule.
          console.warn('[email-rules] action failed (' + (action && action.type) + '):', e && e.message);
        }
      }

      // Bookkeeping is best-effort — a stats write must never be the thing
      // that breaks mail delivery.
      pool.query(
        'UPDATE email_rules SET last_matched_at = NOW(), match_count = match_count + 1 WHERE id = $1',
        [rule.id]
      ).catch(() => {});

      // A 'move' invalidates the folder_id the next rule would guard on,
      // so keep the in-memory copy honest for the rest of this pass.
      if ((rule.actions || []).some((a) => a && a.type === 'move')) {
        const fresh = await pool.query('SELECT folder_id FROM inbound_emails WHERE id = $1', [message.id]);
        if (fresh.rows.length) message.folder_id = fresh.rows[0].folder_id;
      }

      if (rule.stop_on_match) break;
    }
  } catch (e) {
    console.warn('[email-rules] runRules failed (message unaffected):', e && e.message);
  }
  return out;
}

/** Fire-and-forget — the delivery path must never await or reject on rules. */
function runRulesInBackground(phase, ctx, message) {
  Promise.resolve().then(() => runRules(phase, ctx, message)).catch(() => {});
}

module.exports = { runRules, runRulesInBackground, loadRules, applyAction, MAX_RULES };
