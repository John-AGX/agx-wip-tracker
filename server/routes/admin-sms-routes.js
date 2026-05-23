// Admin SMS — observability for the SMS scheduling agent.
//
// One endpoint:
//   GET  /api/admin/sms/log  — recent inbound + outbound texts
//
// Admin-gated by ROLES_MANAGE. Read-only — the audit log itself
// is written from server/routes/sms-routes.js as workers text in.

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireOrg, requireCapability } = require('../auth');

const router = express.Router();

console.log('[admin-sms-routes] mounted at /api/admin/sms');

// GET /api/admin/sms/log?limit=N
// Default 100, max 500. Returns newest-first with the user's name
// joined in so the UI doesn't have to do a second lookup.
router.get('/log', requireAuth, requireOrg, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 100));
    // Tenant isolation: scope sms_log by user.organization_id.
    // Inbound entries with user_id=NULL (texts from numbers we don't
    // recognize) are NOT returned to scoped admins — those land in a
    // separate "unknown sender" bucket for platform admins only.
    // Audit finding C1.
    const sql =
      'SELECT s.id, s.direction, s.from_number, s.to_number, s.body, ' +
      '       s.user_id, s.intent, s.twilio_sid, s.error, s.created_at, ' +
      '       u.name AS user_name, u.email AS user_email ' +
      'FROM sms_log s ' +
      'JOIN users u ON u.id = s.user_id ' +
      'WHERE u.organization_id = $1 ' +
      'ORDER BY s.id DESC ' +
      'LIMIT $2';
    const { rows } = await pool.query(sql, [req.organization.id, limit]);
    res.json({ entries: rows });
  } catch (e) {
    console.error('GET /api/admin/sms/log error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
