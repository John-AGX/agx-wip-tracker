// Platform push-key operations (SYSTEM_ADMIN).
//
// WHY THIS ROUTER EXISTS AND NOT A LINE IN admin-console-routes.
// That file's header states its own doctrine: read-only by design, "mutating
// platform ops live behind their own deliberate endpoints, each already
// audited", with exactly one argued exception. Rotating the platform's push
// signing key is a mutating platform op, so it gets its own deliberate,
// audited endpoint rather than joining that exception.
//
// ── WHAT ROTATION ACTUALLY COSTS ─────────────────────────────────────────
// server/push.js says "Rotating = delete the app_settings row (users just
// re-enable notifications)". That parenthesis is wrong in three separate
// ways, and every one of them was read out of the code rather than assumed.
// The endpoints below report each as a field so the UI cannot undersell it.
//
//  1. DELETING THE ROW CHANGES NOTHING UNTIL THE PROCESS RESTARTS.
//     push.js caches the pair in module scope (`_configured`, `_publicKey`,
//     `_initPromise`) and ensureInit() returns on `if (_configured) return
//     true` before it ever looks at the table. Nothing resets those. So the
//     running server keeps signing with the OLD — compromised — key until a
//     redeploy or restart. Rotation is not complete at the click; it is
//     complete at the next boot. -> `restart_required`.
//
//  2. EVERY EXISTING SUBSCRIPTION DIES, AND THE DEAD ROWS ARE NEVER SWEPT.
//     Each push_subscriptions row was minted by the browser against the OLD
//     public key (applicationServerKey). After the restart the server signs
//     with a new one and the push services reject the mismatch. sendPush
//     prunes a row ONLY on 404/410; a VAPID key mismatch is not either of
//     those, so the rows survive indefinitely and every future send retries
//     and logs a failure against them. -> `subscriptions_invalidated`.
//
//  3. NOTHING RE-SUBSCRIBES, AND THE USER CANNOT FIX IT FROM THE APP.
//     sw.js registers install/activate/message/push/notificationclick/fetch
//     and has NO `pushsubscriptionchange` handler. The only re-subscribe
//     control in the product is the bell in the Crew activity panel
//     (js/agent-tasks.js), and updateBellVisibility() reveals it only when
//     `reg.pushManager.getSubscription()` resolves EMPTY. After rotation the
//     browser still holds its (now unusable) subscription object, so the bell
//     stays hidden — and even if it were clicked, pushManager.subscribe()
//     with a different applicationServerKey rejects with InvalidStateError,
//     which enablePush() swallows in an empty .catch(). Push goes silent with
//     no error surfaced to anyone. -> `recovery` / `auto_resubscribe:false`.
//
// So the honest sentence is: push stops for every subscribed device, silently,
// and each device needs a manual browser-level reset to come back. The copy in
// the Danger Zone says exactly that.
//
// ── NO KEY MATERIAL, ANYWHERE ────────────────────────────────────────────
// Not in a response, not in a log, not in an error. The only statements here
// that touch app_settings('vapid_keys') are a COUNT and a DELETE — the `value`
// column is never selected, never bound, never RETURNINGed. Client errors are
// a fixed string and the server log carries an error CODE, never a message
// that could have interpolated a row into it. The whole exposure being
// rotated away was a route that served this value; the route that rotates it
// must not become the second one.

'use strict';

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireSystemAdmin } = require('../auth');
const { auditLog } = require('../audit');

const router = express.Router();
console.log('[admin-push-routes] mounted at /api/admin/push (SYSTEM_ADMIN-gated)');

// Exact, case-sensitive. Same shape as RESET_PHRASE in admin-org-reset-routes
// and the pack-name confirmation on unsync: privilege answers "may you", the
// typed phrase answers "did you mean to".
const ROTATE_PHRASE = 'ROTATE PUSH KEYS';

// A count that can come back UNKNOWN. Every number this router reports is
// either an integer or null, and null means NOT MEASURED — never 0. Reporting
// "0 devices affected" because the count threw is how a destructive button
// gets clicked on a false premise.
async function countOrNull(sql) {
  try {
    const r = await pool.query(sql);
    return r.rows.length ? Number(r.rows[0].n) : null;
  } catch (e) {
    console.warn('[admin-push] count unavailable (code ' + ((e && e.code) || '?') + ')');
    return null;
  }
}

// Presence, not content. `SELECT COUNT(*)` — never `SELECT value`.
async function vapidRowPresent() {
  try {
    const r = await pool.query("SELECT COUNT(*)::int AS n FROM app_settings WHERE key = 'vapid_keys'");
    return r.rows.length ? Number(r.rows[0].n) > 0 : null;
  } catch (e) {
    console.warn('[admin-push] vapid row presence unavailable (code ' + ((e && e.code) || '?') + ')');
    return null;
  }
}

// The two env vars, as BOOLEANS. If both are set, push.js takes path 1 and
// never reads the table — which means deleting the row would rotate NOTHING,
// and a UI that offered the button anyway would be lying by omission.
function envOverride() {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

const RECOVERY_STEPS = [
  'Each device opens the site in its browser, clears the notification permission / site data for it (or unregisters the service worker), and reloads.',
  'The bell in the Crew activity panel reappears once the browser no longer holds a subscription.',
  'The user clicks it and grants permission again.'
];

function statusPayload(extra) {
  return Object.assign({
    confirm_phrase: ROTATE_PHRASE,
    env_override: envOverride(),
    restart_required: true,
    restart_note:
      'Deleting the row does not re-key the running server. push.js caches the pair in module memory and ' +
      'ensureInit() returns before reading the table, so the old key stays in use until a redeploy or restart. ' +
      'Rotation completes at the next boot, which regenerates and persists a new pair on its own.',
    auto_resubscribe: false,
    resubscribe_note:
      'No automatic recovery exists. sw.js has no pushsubscriptionchange handler, and the only re-subscribe ' +
      'control (the Crew activity bell) is shown only when the browser reports NO subscription — after rotation ' +
      'it still reports one, so the bell stays hidden. Push goes silent with no error shown to the user.',
    stale_rows_note:
      'Invalidated subscriptions are NOT cleaned up. sendPush prunes a row only on HTTP 404/410, and a VAPID key ' +
      'mismatch is neither, so the rows remain and every later send fails against them.',
    recovery: RECOVERY_STEPS
  }, extra || {});
}

// GET /api/admin/push/vapid-status — everything needed to decide, and not one
// byte of the keypair. Pure read.
router.get('/vapid-status', requireAuth, requireSystemAdmin, async (req, res) => {
  try {
    const [present, subs, devices, users] = await Promise.all([
      vapidRowPresent(),
      countOrNull('SELECT COUNT(*)::int AS n FROM push_subscriptions'),
      countOrNull('SELECT COUNT(DISTINCT endpoint)::int AS n FROM push_subscriptions'),
      countOrNull('SELECT COUNT(DISTINCT user_id)::int AS n FROM push_subscriptions')
    ]);
    res.json(statusPayload({
      stored_row_present: present,
      subscriptions: subs,
      devices: devices,
      users_affected: users,
      rotatable: present === true && !envOverride()
    }));
  } catch (e) {
    console.error('GET /api/admin/push/vapid-status failed (code ' + ((e && e.code) || '?') + ')');
    res.status(500).json({ error: 'Could not read push key status.' });
  }
});

// POST /api/admin/push/rotate-vapid — DESTRUCTIVE.
//
// Deleting the row IS the whole operation. Key generation is not reimplemented
// here: push.js regenerates and persists a fresh pair on the next boot, and
// duplicating that would put a second generator on a key this endpoint exists
// to protect.
router.post('/rotate-vapid', requireAuth, requireSystemAdmin, async (req, res) => {
  // The confirmation is checked BEFORE anything is read or deleted, so a
  // refusal leaves the row byte-identical. Same ordering as the unsync door.
  const confirm = (req.body && typeof req.body.confirm === 'string') ? req.body.confirm : '';
  if (confirm !== ROTATE_PHRASE) {
    return res.status(400).json(statusPayload({
      error: 'Confirmation phrase mismatch. Type "' + ROTATE_PHRASE + '" exactly to proceed.',
      rotated: false
    }));
  }

  try {
    // Measured BEFORE the delete — this is the blast radius, and it has to be
    // the number as it stood when the operator authorised it.
    const subsBefore = await countOrNull('SELECT COUNT(*)::int AS n FROM push_subscriptions');
    const usersBefore = await countOrNull('SELECT COUNT(DISTINCT user_id)::int AS n FROM push_subscriptions');

    // No RETURNING. The value column must not travel anywhere.
    const del = await pool.query("DELETE FROM app_settings WHERE key = 'vapid_keys'");
    const removed = typeof del.rowCount === 'number' ? del.rowCount : null;

    // Fire-and-forget by contract, but awaited so the row is on disk before
    // the operator is told the key is gone.
    await auditLog(req, {
      action: 'push.vapid_rotate',
      targetType: 'app_settings',
      targetId: 'vapid_keys',
      detail: {
        rows_removed: removed,
        subscriptions_invalidated: subsBefore,
        users_affected: usersBefore,
        env_override: envOverride(),
        restart_required: true
      }
    });

    // Deliberately warn-level and deliberately contentless.
    console.warn('[admin-push] VAPID row deleted by user ' + ((req.user && req.user.id) || '?') +
      ' — rows_removed=' + removed + ' subscriptions_invalidated=' + subsBefore +
      ' (new pair is generated on next boot; no key material is logged)');

    res.json(statusPayload({
      rotated: true,
      rows_removed: removed,
      stored_row_present: false,
      subscriptions_invalidated: subsBefore,
      users_affected: usersBefore,
      note: removed === 0
        ? 'No stored row existed, so nothing was deleted. If VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are set, the ' +
          'signing key lives in the environment and rotating it means changing those variables, not this row.'
        : 'The stored keypair is gone. The running server still holds it in memory — restart or redeploy to ' +
          'generate the new pair, and expect push to be silent until every device re-subscribes by hand.'
    }));
  } catch (e) {
    console.error('POST /api/admin/push/rotate-vapid failed (code ' + ((e && e.code) || '?') + ')');
    res.status(500).json({ error: 'Rotation failed. The stored keypair was not changed.' });
  }
});

module.exports = router;
module.exports.ROTATE_PHRASE = ROTATE_PHRASE;
