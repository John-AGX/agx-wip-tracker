// Web Push subscription API (S7).
//
//   GET  /api/push/public-key   → { key, configured } (key null until VAPID env set)
//   POST /api/push/subscribe    → body: the PushSubscription JSON from the browser
//   POST /api/push/unsubscribe  → body: { endpoint }
//
// All authed; rows are scoped to the caller. The client toggle lives in the
// Background Tasks panel (js/agent-tasks.js) and hides itself when unconfigured.

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../auth');
const push = require('../push');

const router = express.Router();
console.log('[push-routes] mounted at /api/push');

router.use(requireAuth);

router.get('/public-key', (req, res) => {
  res.json({ key: push.publicKey(), configured: push.isConfigured() });
});

router.post('/subscribe', async (req, res) => {
  try {
    const sub = req.body || {};
    const endpoint = String(sub.endpoint || '');
    const keys = sub.keys || {};
    if (!endpoint.startsWith('https://') || !keys.p256dh || !keys.auth) {
      return res.status(400).json({ error: 'Invalid push subscription' });
    }
    const ua = String(req.headers['user-agent'] || '').slice(0, 300);
    await pool.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint) DO UPDATE
         SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh,
             auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent`,
      [req.user.id, endpoint, String(keys.p256dh).slice(0, 300), String(keys.auth).slice(0, 300), ua]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/push/subscribe error:', e);
    res.status(500).json({ error: 'Failed to save subscription' });
  }
});

router.post('/unsubscribe', async (req, res) => {
  try {
    const endpoint = String((req.body && req.body.endpoint) || '');
    if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
    await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2', [endpoint, req.user.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/push/unsubscribe error:', e);
    res.status(500).json({ error: 'Failed to remove subscription' });
  }
});

module.exports = router;
