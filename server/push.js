// Web Push (S7) — phone/desktop notifications when the app is closed.
//
// VAPID keys resolve in priority order:
//   1. Railway env (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY) — manual override.
//   2. app_settings('vapid_keys') — SELF-GENERATED on first boot and persisted, so
//      push works with ZERO manual setup (no terminal command, no dashboard step,
//      no secrets handled by anyone). Generation is race-safe across instances:
//      INSERT ... ON CONFLICT DO NOTHING, then re-read — every instance converges
//      on the winner's pair. Rotating = delete the app_settings row (users just
//      re-enable notifications).
//
// sendPush(userId, payload) fans out to every device subscription the user has;
// 404/410 responses (expired/revoked subscriptions) prune the row. Never throws.
'use strict';

const { pool } = require('./db');

let _webpush = null;
let _configured = false;
let _publicKey = null;
let _initPromise = null;

const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:notifications@project86.net';

async function ensureInit() {
  if (_configured) return true;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    try {
      _webpush = require('web-push');
      let pub = process.env.VAPID_PUBLIC_KEY;
      let priv = process.env.VAPID_PRIVATE_KEY;
      if (!pub || !priv) {
        // Load-or-generate from app_settings. ON CONFLICT DO NOTHING + re-read
        // makes concurrent first boots converge on one pair.
        const r = await pool.query("SELECT value FROM app_settings WHERE key = 'vapid_keys'");
        if (r.rows.length && r.rows[0].value && r.rows[0].value.publicKey) {
          pub = r.rows[0].value.publicKey;
          priv = r.rows[0].value.privateKey;
        } else {
          const fresh = _webpush.generateVAPIDKeys();
          await pool.query(
            "INSERT INTO app_settings (key, value, updated_at) VALUES ('vapid_keys', $1::jsonb, NOW()) ON CONFLICT (key) DO NOTHING",
            [JSON.stringify({ publicKey: fresh.publicKey, privateKey: fresh.privateKey })]
          );
          const r2 = await pool.query("SELECT value FROM app_settings WHERE key = 'vapid_keys'");
          pub = r2.rows[0].value.publicKey;
          priv = r2.rows[0].value.privateKey;
          console.log('[push] generated + persisted VAPID keys (app_settings)');
        }
      }
      _webpush.setVapidDetails(SUBJECT, pub, priv);
      _publicKey = pub;
      _configured = true;
      console.log('[push] web push configured');
      return true;
    } catch (e) {
      console.warn('[push] init failed:', e && e.message);
      _initPromise = null;   // allow a later retry (e.g. DB not ready at first call)
      return false;
    }
  })();
  return _initPromise;
}

function isConfigured() { return _configured; }

async function getPublicKey() {
  await ensureInit();
  return _publicKey;
}

// Send a notification to every subscription the user has. payload:
// { title, body, url?, tag? }. Best-effort by design — never throws.
async function sendPush(userId, payload) {
  if (!userId) return { sent: 0 };
  if (!(await ensureInit())) return { sent: 0 };
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

module.exports = { isConfigured, getPublicKey, sendPush, ensureInit };
