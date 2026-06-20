// Admin manual-trigger for the reminders scanner.
//
//   GET /api/admin/reminders/run        → run the scanner now (real send)
//   GET /api/admin/reminders/run?dry=1  → dry run: report candidates only,
//                                          send nothing, record nothing
//
// System-admin only. The scanner is normally driven by reminders-cron's
// 10-minute tick; this lets an admin fire it on demand (and verify the
// candidate selection without sending) instead of waiting for the tick.

const express = require('express');
const { requireAuth, requireSystemAdmin } = require('../auth');
const reminders = require('../reminders-cron');

const router = express.Router();

router.get('/run', requireAuth, requireSystemAdmin, async (req, res) => {
  try {
    const dry = req.query.dry === '1' || req.query.dry === 'true';
    const result = await reminders.runOnce({ dry: dry });
    res.json(result);
  } catch (e) {
    console.error('GET /api/admin/reminders/run error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
