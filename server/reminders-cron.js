// Reminders scanner — fires task-due digests + calendar-event reminders.
//
// Two jobs, one tick (every 10 min so fine-grained event reminders land
// near their window without a per-event timer):
//
//   1. Task-due digest — ONE email per user listing their tasks that are
//      due today or overdue (status<>'done', not archived). Gated to the
//      user's LOCAL morning (07:00–22:00 in their resolved timezone) and
//      deduped per (user, local-day) so everyone gets a single "here's
//      your day" nudge in their own market's morning, not one email per
//      task and not at the server's midnight.
//
//   2. Event reminders — per calendar_events.reminder_minutes. When an
//      event's start is within reminder_minutes from now, email its owner
//      once (deduped per event+start). The email renders the start time in
//      the owner's timezone.
//
// MULTI-MARKET: every "morning" gate and every time rendered in an email
// resolves against the recipient's timezone (server/timezone.js resolveTz:
// user override → org timezone → 'America/New_York'), NOT the server's UTC.
//
// Notifications use sendEmail with inline bodies (NOT sendForEvent) — same
// posture as the task-assignment / message notifications: self-contained,
// no dependency on the email-events.js / email-templates.js catalog, still
// logged in email_log, and honoring per-user notification_prefs opt-outs
// (task_due / event_reminder). Never throws out of runOnce.
//
// Dedupe lives in app_settings('reminders_log') as { fires: { key: ts } },
// auto-pruned past 60 days each run so the JSONB stays small.
//
// Recurrence note: recurring calendar_events are reminded for their stored
// starts_at only — per-occurrence expansion is a later slice (matches the
// calendar's current non-expanded rendering).

const { pool } = require('./db');
const { sendEmail } = require('./email');
const tz = require('./timezone');

var ONE_DAY_MS = 24 * 60 * 60 * 1000;
var TICK_MS = 10 * 60 * 1000;          // 10-minute cadence
var FIRST_RUN_DELAY_MS = 60 * 1000;    // warmup ~60s after boot

function appUrl() {
  var u = process.env.APP_URL;
  if (typeof u === 'string' && /^https?:\/\//.test(u.trim())) {
    return u.trim().replace(/\/$/, '');
  }
  return 'https://project86.net';
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// A pure calendar date ('YYYY-MM-DD') is timezone-agnostic — a task due
// "June 20" is June 20 everywhere — so we render it WITHOUT tz conversion
// (anchoring at noon UTC dodges any off-by-one day shift).
function fmtDueLabel(dueIso) {
  if (!dueIso) return '';
  var d = new Date(String(dueIso).slice(0, 10) + 'T12:00:00Z');
  if (isNaN(d.getTime())) return String(dueIso).slice(0, 10);
  return tz.formatInTz(d, 'UTC', { weekday: 'short', month: 'short', day: 'numeric' });
}

// An event start is a real instant (TIMESTAMPTZ) → render in the
// recipient's timezone so "2:30 PM" means 2:30 PM where they are.
function fmtEventTime(ts, zone) {
  if (!ts) return '';
  return tz.formatInTz(ts, zone, {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit'
  });
}

// ── Dedupe log ───────────────────────────────────────────────────────
async function loadFireLog() {
  try {
    var r = await pool.query("SELECT value FROM app_settings WHERE key = 'reminders_log'");
    return (r.rows.length && r.rows[0].value) || { fires: {} };
  } catch (e) {
    console.warn('[reminders] log load failed:', e.message);
    return { fires: {} };
  }
}
async function saveFireLog(log) {
  try {
    await pool.query(
      "INSERT INTO app_settings (key, value) VALUES ('reminders_log', $1) " +
      "ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()",
      [JSON.stringify(log)]
    );
  } catch (e) {
    console.warn('[reminders] log save failed:', e.message);
  }
}
function pruneFireLog(log) {
  var cutoff = Date.now() - 60 * ONE_DAY_MS;
  var fires = log.fires || {};
  Object.keys(fires).forEach(function (k) {
    var t = Number(fires[k]);
    if (!t || t < cutoff) delete fires[k];
  });
  log.fires = fires;
  return log;
}

// ── Task-due digest ──────────────────────────────────────────────────
// Pull all candidate tasks (due on/before tomorrow-UTC so no user's local
// "today" is missed near the date boundary), grouped by assignee, with the
// assignee's resolved timezone. Per-user local-day filtering happens in
// runOnce against each user's own zone.
async function gatherTaskDigests() {
  var sql = [
    'SELECT t.assignee_user_id AS uid, u.email, u.name, u.notification_prefs,',
    '       u.timezone AS user_tz, o.timezone AS org_tz,',
    "       t.id, t.title, t.priority, t.entity_type,",
    "       to_char(t.due_date, 'YYYY-MM-DD') AS due_iso",
    'FROM tasks t',
    'JOIN users u ON u.id = t.assignee_user_id',
    'LEFT JOIN organizations o ON o.id = u.organization_id',
    "WHERE t.archived_at IS NULL AND t.status <> 'done' AND t.scope = 'org'",
    "  AND t.due_date IS NOT NULL AND t.due_date <= CURRENT_DATE + INTERVAL '1 day'",
    '  AND u.active = TRUE AND u.email IS NOT NULL AND u.email <> %3',
    'ORDER BY t.assignee_user_id, t.due_date ASC'
  ].join(' ').replace('%3', "''");
  var r = await pool.query(sql);
  var byUser = {};
  r.rows.forEach(function (row) {
    var k = String(row.uid);
    if (!byUser[k]) {
      byUser[k] = {
        uid: row.uid, email: row.email, name: row.name,
        prefs: row.notification_prefs || {},
        zone: tz.resolveTz(row.user_tz, row.org_tz),
        tasks: []
      };
    }
    byUser[k].tasks.push(row);
  });
  return byUser;
}

function buildTaskDigestEmail(user, overdue, dueToday) {
  var base = appUrl();
  var hostLabel = base.replace(/^https?:\/\//, '');

  function rowHtml(t) {
    var pr = (t.priority && t.priority !== 'normal') ? t.priority : '';
    var prChip = pr
      ? '<span style="display:inline-block;margin-left:6px;font-size:10px;text-transform:uppercase;font-weight:700;color:' +
        (pr === 'urgent' ? '#dc2626' : pr === 'high' ? '#d97706' : '#6b7280') + ';">' + escHtml(pr) + '</span>'
      : '';
    return '<tr><td style="padding:6px 10px;border-bottom:1px solid #eef0f3;font-size:14px;">' +
      escHtml(t.title || '(untitled task)') + prChip +
      '<span style="display:block;font-size:11px;color:#6b7280;margin-top:1px;">Due ' + escHtml(fmtDueLabel(t.due_iso)) + '</span>' +
      '</td></tr>';
  }
  function section(label, list, color) {
    if (!list.length) return '';
    return '<div style="margin:14px 0 4px 0;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.4px;color:' + color + ';">' +
      escHtml(label) + ' (' + list.length + ')</div>' +
      '<table style="width:100%;border-collapse:collapse;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;">' +
      list.map(rowHtml).join('') + '</table>';
  }

  var total = overdue.length + dueToday.length;
  var subject = (overdue.length ? '[' + overdue.length + ' overdue] ' : '') +
    'Your tasks for today (' + total + ')';

  var html =
    '<!doctype html><html><body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;">' +
      '<div style="max-width:560px;margin:24px auto;padding:24px;background:#fff;border-radius:10px;color:#1f2937;line-height:1.5;">' +
        '<div style="margin-bottom:12px;"><img src="' + base + '/images/logo-color.png" alt="Project 86" style="height:40px;display:block;" /></div>' +
        '<h2 style="margin:0 0 4px 0;color:#111827;font-size:20px;">Good morning' + (user.name ? ', ' + escHtml(String(user.name).split(' ')[0]) : '') + '</h2>' +
        '<p style="margin:0 0 4px 0;color:#6b7280;">You have <strong>' + total + '</strong> task' + (total === 1 ? '' : 's') + ' that need attention.</p>' +
        section('Overdue', overdue, '#dc2626') +
        section('Due today', dueToday, '#2563eb') +
        '<p style="margin-top:18px;"><a href="' + base + '" style="display:inline-block;background:#4f8cff;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600;">Open My Tasks</a></p>' +
        '<div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;">' +
          'Project 86 &middot; <a href="' + base + '" style="color:#4f8cff;text-decoration:none;">' + escHtml(hostLabel) + '</a><br/>' +
          'You\'re receiving this daily task summary because you have tasks assigned on Project 86. ' +
          'Toggle notifications in <strong>My Account &rarr; Notifications</strong>.' +
        '</div>' +
      '</div>' +
    '</body></html>';

  var text =
    'Your tasks for today (' + total + ')\n\n' +
    (overdue.length ? 'OVERDUE (' + overdue.length + '):\n' + overdue.map(function (t) { return '  - ' + (t.title || '(untitled)') + ' (due ' + fmtDueLabel(t.due_iso) + ')'; }).join('\n') + '\n\n' : '') +
    (dueToday.length ? 'DUE TODAY (' + dueToday.length + '):\n' + dueToday.map(function (t) { return '  - ' + (t.title || '(untitled)'); }).join('\n') + '\n\n' : '') +
    'Open My Tasks: ' + base + '\n\n' +
    'Toggle notifications in My Account → Notifications.';

  return { subject: subject, html: html, text: text };
}

// ── Event reminders ──────────────────────────────────────────────────
async function gatherEventReminders() {
  var sql = [
    'SELECT ce.id, ce.title, ce.starts_at, ce.location, ce.reminder_minutes, ce.all_day,',
    '       u.id AS uid, u.email, u.name, u.notification_prefs,',
    '       u.timezone AS user_tz, o.timezone AS org_tz',
    'FROM calendar_events ce',
    'JOIN users u ON u.id = ce.user_id',
    'LEFT JOIN organizations o ON o.id = u.organization_id',
    'WHERE ce.reminder_minutes IS NOT NULL AND ce.reminder_minutes > 0',
    "  AND ce.status <> 'canceled'",
    '  AND u.active = TRUE AND u.email IS NOT NULL AND u.email <> %3',
    '  AND ce.starts_at > NOW()',
    "  AND ce.starts_at <= NOW() + (ce.reminder_minutes || ' minutes')::interval"
  ].join(' ').replace('%3', "''");
  var r = await pool.query(sql);
  return r.rows;
}

function buildEventReminderEmail(ev, zone) {
  var base = appUrl();
  var hostLabel = base.replace(/^https?:\/\//, '');
  var when = ev.all_day ? (fmtDueLabel(ev.starts_at) + ' (all day)') : fmtEventTime(ev.starts_at, zone);
  var title = ev.title || '(untitled event)';
  var subject = 'Reminder: ' + title + ' — ' + when;

  var detailRows = [];
  detailRows.push('<tr><td style="padding:5px 10px;color:#6b7280;">When</td><td style="padding:5px 10px;font-weight:600;">' + escHtml(when) + '</td></tr>');
  if (ev.location) detailRows.push('<tr><td style="padding:5px 10px;color:#6b7280;">Where</td><td style="padding:5px 10px;">' + escHtml(ev.location) + '</td></tr>');

  var html =
    '<!doctype html><html><body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;">' +
      '<div style="max-width:560px;margin:24px auto;padding:24px;background:#fff;border-radius:10px;color:#1f2937;line-height:1.5;">' +
        '<div style="margin-bottom:12px;"><img src="' + base + '/images/logo-color.png" alt="Project 86" style="height:40px;display:block;" /></div>' +
        '<h2 style="margin:0 0 12px 0;color:#111827;font-size:20px;">&#9200; ' + escHtml(title) + '</h2>' +
        '<p>Hi ' + escHtml(ev.name || 'there') + ', this is a reminder for an upcoming event.</p>' +
        '<table style="width:100%;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;margin:16px 0;font-size:14px;border-collapse:collapse;">' +
          detailRows.join('') +
        '</table>' +
        '<p><a href="' + base + '" style="display:inline-block;background:#4f8cff;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600;">Open Schedule</a></p>' +
        '<div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;">' +
          'Project 86 &middot; <a href="' + base + '" style="color:#4f8cff;text-decoration:none;">' + escHtml(hostLabel) + '</a><br/>' +
          'You set a reminder for this event on your Project 86 calendar. ' +
          'Toggle notifications in <strong>My Account &rarr; Notifications</strong>.' +
        '</div>' +
      '</div>' +
    '</body></html>';

  var text =
    'Reminder: ' + title + '\n\n' +
    'When: ' + when + '\n' +
    (ev.location ? 'Where: ' + ev.location + '\n' : '') +
    '\nOpen Schedule: ' + base + '\n\n' +
    'Toggle notifications in My Account → Notifications.';

  return { subject: subject, html: html, text: text };
}

// ── Orchestration ────────────────────────────────────────────────────
// opts.dry = true → report candidates, send nothing, record nothing.
async function runOnce(opts) {
  opts = opts || {};
  var dry = !!opts.dry;
  var out = {
    dry: dry,
    tasks: { candidates: 0, sent: 0, skipped: 0 },
    events: { candidates: 0, sent: 0, skipped: 0 }
  };
  try {
    var log = await loadFireLog();
    pruneFireLog(log);
    var fires = log.fires;
    var dirty = false;

    // 1) Task-due digests (one per user), gated to EACH user's local
    //    morning (07:00–22:00 in their resolved timezone), deduped per
    //    their local day.
    var byUser = await gatherTaskDigests();
    var userKeys = Object.keys(byUser);
    for (var i = 0; i < userKeys.length; i++) {
      var u = byUser[userKeys[i]];
      var localToday = tz.localDateInTz(u.zone);
      // Filter to tasks due on/before the user's LOCAL today.
      var relevant = u.tasks.filter(function (t) { return t.due_iso && t.due_iso <= localToday; });
      if (!relevant.length) continue;
      out.tasks.candidates++;
      if (u.prefs && u.prefs.task_due === false) { out.tasks.skipped++; continue; }
      var localHour = tz.hourInTz(u.zone);
      var inWindow = localHour >= 7 && localHour < 22;
      if (!inWindow && !dry) { out.tasks.skipped++; continue; }
      var dkey = 'taskdigest|' + u.uid + '|' + localToday;
      if (fires[dkey]) { out.tasks.skipped++; continue; }
      if (dry) { out.tasks.sent++; continue; } // would-send count
      try {
        var overdue = relevant.filter(function (t) { return t.due_iso < localToday; });
        var dueToday = relevant.filter(function (t) { return t.due_iso === localToday; });
        var de = buildTaskDigestEmail(u, overdue, dueToday);
        await sendEmail({ to: u.email, subject: de.subject, html: de.html, text: de.text, tag: 'task_due' });
        fires[dkey] = Date.now();
        dirty = true;
        out.tasks.sent++;
      } catch (e) {
        console.warn('[reminders] task digest send failed for user ' + u.uid + ':', e && e.message);
      }
    }

    // 2) Event reminders (one per event), rendered in the owner's zone.
    var events = await gatherEventReminders();
    out.events.candidates = events.length;
    for (var j = 0; j < events.length; j++) {
      var ev = events[j];
      var prefs = ev.notification_prefs || {};
      if (prefs.event_reminder === false) { out.events.skipped++; continue; }
      var startIso = ev.starts_at instanceof Date ? ev.starts_at.toISOString() : String(ev.starts_at);
      var ekey = 'event|' + ev.id + '|' + startIso;
      if (fires[ekey]) { out.events.skipped++; continue; }
      if (dry) { out.events.sent++; continue; }
      try {
        var zone = tz.resolveTz(ev.user_tz, ev.org_tz);
        var ee = buildEventReminderEmail(ev, zone);
        await sendEmail({ to: ev.email, subject: ee.subject, html: ee.html, text: ee.text, tag: 'event_reminder' });
        fires[ekey] = Date.now();
        dirty = true;
        out.events.sent++;
      } catch (e) {
        console.warn('[reminders] event reminder send failed for event ' + ev.id + ':', e && e.message);
      }
    }

    if (dirty) await saveFireLog(log);
    console.log('[reminders] scan complete — tasks(sent=' + out.tasks.sent + ' skipped=' + out.tasks.skipped +
      ' cand=' + out.tasks.candidates + ') events(sent=' + out.events.sent + ' skipped=' + out.events.skipped +
      ' cand=' + out.events.candidates + ') dry=' + dry);
    return out;
  } catch (e) {
    console.error('[reminders] scan failed:', e && e.message);
    out.error = e.message;
    return out;
  }
}

var _started = false;
function start() {
  if (_started) return;
  _started = true;
  setTimeout(function () {
    runOnce().catch(function (e) { console.warn('[reminders] warmup error:', e && e.message); });
  }, FIRST_RUN_DELAY_MS);
  setTimeout(function tick() {
    runOnce().catch(function (e) { console.warn('[reminders] tick error:', e && e.message); });
    setTimeout(tick, TICK_MS);
  }, TICK_MS);
  console.log('[reminders] scanner armed; tick every ' + Math.round(TICK_MS / 60000) + ' min');
}

module.exports = { start: start, runOnce: runOnce };
