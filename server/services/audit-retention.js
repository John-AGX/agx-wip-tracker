'use strict';
// Retention for admin_audit_log — the ONE code path allowed to delete evidence.
//
// TWO FORCES PULL AGAINST EACH OTHER AND THE RESOLUTION MATTERS.
//
// Retention is in tension with the question that started this. "If no one got
// the keys yet, is it safe now?" was about SEVEN WEEKS. Any window shorter than
// the longest plausible "did anyone touch this?" investigation reintroduces the
// exact failure it was built to fix — a 30-day window would already have been
// useless here. And deleting an audit row is itself a privileged act: this file
// is the only thing in the codebase that can erase the record.
//
// So the policy is expressed on `tier` and `outcome`, which are columns, not on
// an action-name allowlist in a script that drifts the moment somebody adds an
// action:
//
//   tier A                       — NEVER DELETED. Privilege, impersonation,
//                                  cross-tenant, secret/platform access,
//                                  destructive ops.
//   tier B, outcome <> 'ok'      — 3 years. Denials and failed logins are the
//                                  enumeration record; they outlive the noise.
//   tier B, outcome = 'ok'       — 400 days. A >1-year lookback, eight times
//                                  the seven weeks that prompted all of this.
//
// Rows written before the tier column existed have tier IS NULL. They are
// treated as tier A — NEVER deleted. Guessing a retention class for a row whose
// class was never recorded is exactly the "NULL stamps skipped rather than
// guessed" rule the one other genuine retention job in this server
// (email-snooze-cron purgeTrash) already follows.
//
// SHAPE COPIED FROM purgeTrash DELIBERATELY: keyed on the event's own
// timestamp, NULLs skipped rather than guessed, and wrapped in its own try so a
// destructive purge can never take its caller down in either direction.
//
// THE PURGE AUDITS ITSELF, FAIL-CLOSED, BEFORE IT DELETES. The one path that
// can erase evidence must leave evidence, and it must leave it even if it then
// crashes. `audit.purge` is in TIER_A_ACTIONS, so its own row is never eligible
// for deletion by a later run.

const { pool } = require('../db');
const { auditActorCritical } = require('../audit');

const DENIED_RETENTION_DAYS = 365 * 3;
const ROUTINE_RETENTION_DAYS = 400;

// The append-only trigger on admin_audit_log raises on any UPDATE or DELETE
// unless the session sets app.audit_purge. SET LOCAL scopes it to this
// transaction, so the escape hatch cannot leak to another statement on a pooled
// connection — which is the whole reason the trigger is worth having.
const UNLOCK = "SET LOCAL app.audit_purge = 'on'";

async function purgeExpiredAudit(opts) {
  const dryRun = !!(opts && opts.dryRun);
  const client = await pool.connect();
  try {
    // Count first, on the same connection, so the audit row the purge writes
    // about itself carries the real blast radius rather than an estimate.
    const counts = await client.query(
      `SELECT
         COUNT(*) FILTER (WHERE tier = 'B' AND outcome <> 'ok'
                            AND created_at < NOW() - ($1 || ' days')::interval)::int AS denied,
         COUNT(*) FILTER (WHERE tier = 'B' AND outcome =  'ok'
                            AND created_at < NOW() - ($2 || ' days')::interval)::int AS routine
       FROM admin_audit_log`,
      [String(DENIED_RETENTION_DAYS), String(ROUTINE_RETENTION_DAYS)]
    );
    const plan = {
      denied_expired: counts.rows[0].denied,
      routine_expired: counts.rows[0].routine,
      denied_retention_days: DENIED_RETENTION_DAYS,
      routine_retention_days: ROUTINE_RETENTION_DAYS,
    };
    if (dryRun) return { ok: true, dry_run: true, deleted: 0, plan: plan };
    if (!plan.denied_expired && !plan.routine_expired) {
      console.log('[audit-purge] nothing expired', JSON.stringify(plan));
      return { ok: true, deleted: 0, plan: plan };
    }

    await client.query('BEGIN');
    // Fail-closed, and BEFORE the DELETE. If the record of the purge cannot be
    // written, nothing is purged — the transaction rolls back and the rows stay.
    await auditActorCritical(
      { actorKind: 'system', actorLabel: 'audit-retention' },
      {
        action: 'audit.purge', tier: 'A', scope: 'platform',
        targetType: 'admin_audit_log', targetId: 'retention',
        detail: plan,
      },
      { client: client }
    );
    await client.query(UNLOCK);
    const d = await client.query(
      `DELETE FROM admin_audit_log
        WHERE tier = 'B'
          AND ( (outcome <> 'ok' AND created_at < NOW() - ($1 || ' days')::interval)
             OR (outcome =  'ok' AND created_at < NOW() - ($2 || ' days')::interval) )`,
      [String(DENIED_RETENTION_DAYS), String(ROUTINE_RETENTION_DAYS)]
    );
    await client.query('COMMIT');
    console.log('[audit-purge] deleted ' + (d.rowCount || 0) + ' expired rows', JSON.stringify(plan));
    return { ok: true, deleted: d.rowCount || 0, plan: plan };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* connection already gone */ }
    console.error('[audit-purge] FAILED — nothing was deleted:', e && e.message);
    return { ok: false, error: e && e.message, deleted: 0 };
  } finally {
    client.release();
  }
}

module.exports = {
  purgeExpiredAudit,
  DENIED_RETENTION_DAYS,
  ROUTINE_RETENTION_DAYS,
};
