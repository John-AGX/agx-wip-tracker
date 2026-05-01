// Email admin routes — Phase 1 of the notifications feature.
//
// Two endpoints, both admin-only:
//   POST /api/email/test   — send a hardcoded test message to a given
//                             address. Useful for verifying provider
//                             config + DNS during initial setup.
//   GET  /api/email/log    — recent send log (last 100 rows, filterable
//                             by ?status=sent|failed|... and ?tag=...)
//
// Future phases will add per-user notification preferences and
// per-event triggers, but neither needs admin gating — only this
// diagnostic surface does.

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { sendEmail, isEnabled, isDryRun } = require('../email');

const router = express.Router();

console.log('[email-routes] mounted at /api/email');

// POST /api/email/test  body: { to, subject?, html? }
router.post('/test',
  requireAuth, requireRole('admin'),
  async (req, res) => {
    try {
      const to = (req.body && req.body.to) || (req.user && req.user.email);
      if (!to) return res.status(400).json({ error: 'to required' });
      const subject = (req.body && req.body.subject) ||
        'AGX email test — ' + new Date().toLocaleString();
      const html = (req.body && req.body.html) ||
        '<div style="font-family:Arial,sans-serif;color:#1f2937;">' +
          '<h2 style="color:#4f8cff;margin:0 0 12px 0;">AGX notifications are working &#x2713;</h2>' +
          '<p>This is a test email from the AGX WIP Tracker.</p>' +
          '<p style="color:#6b7280;font-size:13px;">' +
            'Sent by: ' + (req.user.name || req.user.email) + '<br/>' +
            'Server time: ' + new Date().toISOString() +
          '</p>' +
        '</div>';
      const text = (req.body && req.body.text) ||
        'AGX notifications are working.\n\nSent by: ' + (req.user.name || req.user.email) +
        '\nServer time: ' + new Date().toISOString();
      const result = await sendEmail({
        to: to,
        subject: subject,
        html: html,
        text: text,
        tag: 'admin_test'
      });
      // Surface the configuration state so the admin can see at a
      // glance whether the env is set up correctly.
      res.json({
        ok: result.ok,
        id: result.id,
        providerId: result.providerId,
        error: result.error,
        dryRun: result.dryRun,
        configured: isEnabled(),
        dryRunMode: isDryRun()
      });
    } catch (e) {
      console.error('POST /api/email/test error:', e);
      res.status(500).json({ error: 'Server error', detail: e.message });
    }
  }
);

// GET /api/email/log
router.get('/log',
  requireAuth, requireRole('admin'),
  async (req, res) => {
    try {
      const params = [];
      const where = [];
      if (req.query.status) {
        params.push(String(req.query.status));
        where.push('status = $' + params.length);
      }
      if (req.query.tag) {
        params.push(String(req.query.tag));
        where.push('tag = $' + params.length);
      }
      if (req.query.to) {
        params.push('%' + String(req.query.to).toLowerCase() + '%');
        where.push('lower(to_address) LIKE $' + params.length);
      }
      const sql =
        'SELECT id, to_address, subject, tag, status, provider_id, error, dry_run, sent_at ' +
        'FROM email_log ' +
        (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') +
        'ORDER BY sent_at DESC LIMIT 100';
      const { rows } = await pool.query(sql, params);
      res.json({
        rows: rows,
        configured: isEnabled(),
        dryRunMode: isDryRun()
      });
    } catch (e) {
      console.error('GET /api/email/log error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

module.exports = router;
