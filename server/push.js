// Web Push (S7) — phone/desktop notifications when the app is closed.
//
// VAPID keys come from Railway env (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY /
// VAPID_SUBJECT). DESIGNED TO NO-OP GRACEFULLY when the keys aren't set yet:
// isConfigured() gates every path, sendPush resolves silently, and the client's
// "enable notifications" toggle hides itself when /api/push/public-key says
// unconfigured. The moment the env vars land, push lights up — no code change.
//
// sendPush(userId, payload) fans out to every device subscription the user has;
// 404/410 responses (expired/revoked subscriptions) prune the row.
'use strict';

const { pool } = require('./db');

let _webpush = null;
let _configured = false;

function init() {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:notifications@project86.net';
  if (!pub || !priv) {
    console.log('[push] VAPID keys not set — web push disabled (set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY to enable)');
    return;
  }
  try {
    _webpush = require('web-push');
    _webpush.setVapidDetails(subject, pub, priv);
    _configured = true;
    console.log('[push] web push configured');
  } catch (e) {
    console.warn('[push] init failed:', e && e.message);
  }
}
init();

function isConfigured() { return _configured; }
function publicKey() { return _configured ? process.env.VAPID_PUBLIC_KEY : null; }

// Send a notification to every subscription the user has. payload:
// { title, body, url?, tag? }. Never throws — push is best-effort by design.
async function sendPush(userId, payload) {
  if (!_configured || !userId) return { sent: 0 };
  let rows;
  try {
    const r = await pool.query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1', [userId]);
    rows = r.rows;
  } catch (e) {
    console.warn('[push] subscription lookup failed:', e && e.message);
    return { sent: 0 };
  }
  if (!rows.length) return { sent: 0 };
  const body = JSON.stringify({
    title: String(payload && payload.title || 'Project 86'),
    body: String(payload && payload.body || '').slice(0, 500),
    url: String(payload && payload.url || '/'),
    tag: String(payload && payload.tag || 'p86')
  });
  let sent = 0;
  for (const s of rows) {
    try {
      await _webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        body,
        { TTL: 60 * 60 * 12 }
      );
      sent++;
      pool.query('UPDATE push_subscriptions SET last_used_at = NOW() WHERE id = $1', [s.id]).catch(() => {});
    } catch (e) {
      const code = e && e.statusCode;
      if (code === 404 || code === 410) {
        // Subscription expired or revoked — prune it.
        pool.query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]).catch(() => {});
      } else {
        console.warn('[push] send failed (' + (code || 'no-code') + '):', e && e.message);
      }
    }
  }
  return { sent };
}

module.exports = { isConfigured, publicKey, sendPush };
