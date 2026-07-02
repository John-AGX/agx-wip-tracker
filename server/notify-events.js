// Notification catalog — ONE place defining every user-facing notification:
// what it's for, what it says, and which channels it rides (email / push).
// Drives (a) the senders' per-user gating and (b) the My Account settings UI
// (GET /api/push/events). The email-side gate stays the existing flat
// notification_prefs[key] === false; the push-side gate is
// notification_prefs.push[key] === false. Both opt-OUT (missing = on).
//
// This is deliberately LIGHTER than server/email-events.js — push bodies are
// one-liners composed at the call site; no templates, no org overrides. If a
// push event ever needs per-org control, mirror email's isEventEnabled then.
'use strict';

const { pool } = require('./db');

const NOTIFY_EVENTS = [
  { key: 'agent_task',          label: 'Background tasks',       desc: 'When a background task finishes, fails, or needs your answer.',              channels: { email: true, push: true } },
  { key: 'scribe_draft',        label: 'Scribe drafts',          desc: 'When the Scribe finishes drafting a change for your review.',               channels: { email: false, push: true } },
  { key: 'messages',            label: 'Direct messages',        desc: 'When a teammate sends you a direct message.',                               channels: { email: true, push: true } },
  { key: 'task_due',            label: 'Tasks due',              desc: 'Your morning digest of overdue and due-today tasks.',                       channels: { email: true, push: true } },
  { key: 'event_reminder',      label: 'Calendar reminders',     desc: 'Reminders before your calendar events start.',                              channels: { email: true, push: true } },
  { key: 'reminder',            label: 'Personal reminders',     desc: 'Your own "remind me" reminders when they come due.',                        channels: { email: true, push: true } },
  { key: 'schedule_assignment', label: 'Schedule assignments',   desc: 'When someone adds you to a production day on the Schedule page.',           channels: { email: true, push: false } },
  { key: 'job_assignment',      label: 'Job assignments',        desc: 'When you’re assigned (or reassigned) as the PM on a job.',             channels: { email: true, push: false } },
  { key: 'password_reset',      label: 'Password resets',        desc: 'When an admin resets your password. Recommended to leave on.',              channels: { email: true, push: false } }
];

function pushAllowed(prefs, key) {
  const p = (prefs && prefs.push) || {};
  return p[key] !== false;
}

// Send a push for a cataloged event, gated on the user's prefs. Loads the
// user's prefs itself when not passed (senders that already have them can pass
// to skip the query). Best-effort — never throws.
async function sendPushForEvent(userId, eventKey, payload, knownPrefs) {
  try {
    if (!userId || !eventKey) return { sent: 0 };
    let prefs = knownPrefs;
    if (prefs === undefined) {
      const r = await pool.query('SELECT notification_prefs FROM users WHERE id = $1', [userId]);
      prefs = (r.rows[0] && r.rows[0].notification_prefs) || {};
    }
    if (!pushAllowed(prefs, eventKey)) return { sent: 0, muted: true };
    const push = require('./push');
    return await push.sendPush(userId, Object.assign({ tag: eventKey }, payload || {}));
  } catch (e) {
    console.warn('[notify-events] push failed (' + eventKey + '):', e && e.message);
    return { sent: 0 };
  }
}

module.exports = { NOTIFY_EVENTS, sendPushForEvent, pushAllowed };
