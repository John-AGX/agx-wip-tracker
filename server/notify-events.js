// Notification catalog — ONE place defining every user-facing notification:
// what it's for, what it says, and which channels it rides (email / push).
// Drives (a) the senders' per-user gating and (b) the My Account settings UI
// (GET /api/push/events). The email-side gate stays the existing flat
// notification_prefs[key] === false; the push-side gate is
// notification_prefs.push[key] === false. Both opt-OUT (missing = on).
//
// An event may carry an optional `group` (a heading, e.g. 'Work orders'). Rows
// of one group stay contiguous in this list; My Account prints the heading
// once, above the first row of the group (js/account.js renderPrefRows).
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
  // Work orders — six contiguous rows under one heading in My Account.
  { key: 'ticket_approval',      group: 'Work orders', label: 'Work orders to approve',     desc: 'When a work order you can approve reaches Work complete: on a job you run, one you raised, sent the crew link for, are assigned to or are watching, or on a lead you sell. If nobody on the work order can approve it, the company admins are told. A notice that doesn\'t go through is tried again.', channels: { email: true, push: true } },
  { key: 'ticket_waiting',       group: 'Work orders', label: 'Work orders still waiting',  desc: 'A morning reminder when a work order you can approve has waited more than 2 business days (your company can change the number). If your work orders digest is on, they are in the digest instead.', channels: { email: true, push: true } },
  { key: 'ticket_assignment',    group: 'Work orders', label: 'Work order assignments',     desc: 'When someone assigns a work order to you.', channels: { email: true, push: true } },
  { key: 'ticket_problem',       group: 'Work orders', label: 'Problems flagged by crews',  desc: 'Right away, when a crew flags a problem on a work order you run, sent the link for, are assigned to or are watching: no access, extra damage, material short, a safety issue or something else.', channels: { email: true, push: true } },
  { key: 'ticket_crew_activity', group: 'Work orders', label: 'Crew activity',              desc: 'What crews do on the crew link: opening it the first time, starting work, finishing or reopening buildings, photos, notes and suggestions. At most one notice per work order every 30 minutes.', channels: { email: true, push: true } },
  { key: 'work_order_digest',    group: 'Work orders', label: 'Work orders morning digest', desc: 'One message on weekday mornings, only when a work order needs you: waiting for your approval, overdue, scheduled today or tomorrow with the crew link not opened, a crew link about to expire, suggestions or flagged problems waiting.', channels: { email: true, push: true } },
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
