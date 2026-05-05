// Admin SMS — observability for the SMS scheduling agent.
//
// One endpoint:
//   GET  /api/admin/sms/log  — recent inbound + outbound texts
//
// Admin-gated by ROLES_MANAGE. Read-only — the audit log itself
// is written from server/routes/sms-routes.js as workers text in.

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireCapability } = require('../auth');

const router = express.Router();

console.log('[admin-sms-routes] mounted at /api/admin/sms');

// GET /api/admin/sms/log?limit=N
// Default 100, max 500. Returns newest-first with the user's name
// joined in so the UI doesn't have to do a second lookup.
router.get('/log', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 100));
    const sql =
      'SELECT s.id, s.direction, s.from_number, s.to_number, s.body, ' +
      '       s.user_id, s.intent, s.twilio_sid, s.error, s.created_at, ' +
      '       u.name AS user_name, u.email AS user_email ' +
      'FROM sms_log s ' +
      'LEFT JOIN users u ON u.id = s.user_id ' +
      'ORDER BY s.id DESC ' +
      'LIMIT $1';
    const { rows } = await pool.query(sql, [limit]);
    res.json({ entries: rows });
  } catch (e) {
    console.error('GET /api/admin/sms/log error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
