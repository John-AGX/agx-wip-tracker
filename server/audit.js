// Project 86 Command Center — privileged-action audit trail.
//
// Broad authority is only safe if it's recorded. This writes one row to
// admin_audit_log per privileged action (role changes, org create/archive,
// skill/MCP edits, native Anthropic skill deletes, any system_admin op).
//
// Design:
//   • Fire-and-forget — a logging failure must NEVER break the action.
//     Callers `auditLog(req, {...})` without awaiting (or await + ignore);
//     errors are swallowed + warned, never thrown.
//   • Actor email/role are SNAPSHOTTED from the JWT so the record stays
//     readable after the user is deleted.
//   • organization_id = the TARGET org the action touched (nullable for
//     platform-level ops); actor_org_id = the actor's home org.
//
// Action naming convention: '<entity>.<verb>' — e.g.
//   user.role_change, user.password_reset, user.create, user.delete,
//   role.create, role.update, role.delete,
//   org.create, org.archive, org.invite,
//   org.mcp_server_write, org.skill_pack_write, org.memory_write,
//   anthropic.skill_delete, anthropic.skill_create.

const { pool } = require('./db');

function clientIp(req) {
  if (!req) return null;
  // trust proxy=1 in index.js makes req.ip the real client; fall back to XFF.
  return req.ip
    || (req.headers && (req.headers['x-forwarded-for'] || '').split(',')[0].trim())
    || (req.connection && req.connection.remoteAddress)
    || null;
}

// Record a privileged action. Returns a promise that always resolves
// (never rejects) so callers can `await auditLog(...)` or fire-and-forget.
async function auditLog(req, entry) {
  try {
    if (!entry || !entry.action) return;
    const u = (req && req.user) || {};
    await pool.query(
      `INSERT INTO admin_audit_log
         (actor_user_id, actor_email, actor_role, action, target_type, target_id,
          organization_id, actor_org_id, detail, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
      [
        u.id || null,
        u.email || null,
        u.role || null,
        String(entry.action).slice(0, 128),
        entry.targetType ? String(entry.targetType).slice(0, 64) : null,
        entry.targetId != null ? String(entry.targetId).slice(0, 256) : null,
        entry.organizationId != null ? entry.organizationId : null,
        u.organization_id || null,
        entry.detail !== undefined ? JSON.stringify(entry.detail) : null,
        clientIp(req),
      ]
    );
  } catch (e) {
    // Logging must never break the request it's recording.
    console.warn('[audit] write failed for action', entry && entry.action, '-', e && e.message);
  }
}

module.exports = { auditLog };
