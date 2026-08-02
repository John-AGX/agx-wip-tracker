// Email housekeeping sweep — Premium Email Hub E3.
//
// Two jobs on one 5-minute tick: waking snoozed mail, and purging Trash
// past its retention window. They share a timer because both are coarse,
// low-volume janitorial passes and a second scheduler would be pure
// overhead — but they do NOT share a try block, because one is destructive
// and must never be able to take the other down.
//
// Snoozing a conversation stamps inbound_emails.snoozed_until and files it
// into the user's Snoozed folder. This scanner is what brings it BACK:
// every 5 minutes it finds messages whose snoozed_until has passed, clears
// the stamp, moves them to that user's Inbox, and marks them unread so the
// thread re-raises itself exactly like new mail.
//
// Design notes:
//   * The move targets the OWNER's own Inbox (a correlated subquery on
//     user_id), not one resolved id — a sweep spans every mailbox.
//   * Only messages actually sitting in Snoozed are moved. If John had
//     already dragged one somewhere else, waking it just clears the stamp
//     and leaves it where he put it; the sweep never overrides a human.
//   * is_read is forced FALSE on wake. The whole point of snoozing is
//     "show me this again", and a read row would come back invisible.
//   * A 5-minute tick is deliberately coarse: snooze targets are
//     "tomorrow 8am"-shaped, so minute-accuracy buys nothing and a tighter
//     loop is just load. Waking LATE is fine; waking early would be wrong.
//   * Self-guarding — runOnce never throws into the timer, so one bad tick
//     can't kill the scanner for the life of the process.

const { pool } = require('./db');

var TICK_MS = 5 * 60 * 1000;          // every 5 minutes
var FIRST_RUN_DELAY_MS = 45 * 1000;   // let boot settle before the first pass

async function runOnce() {
  var out = { woke: 0 };
  try {
    // One statement: clear the stamp, unread it, and re-file to the
    // owner's Inbox when (and only when) it is still in their Snoozed
    // folder. Rows whose Inbox can't be resolved keep their folder rather
    // than being set adrift.
    const r = await pool.query(
      `UPDATE inbound_emails e
          SET snoozed_until = NULL,
              is_read = FALSE,
              folder_id = COALESCE(
                CASE WHEN EXISTS (
                       SELECT 1 FROM email_folders sf
                        WHERE sf.id = e.folder_id AND sf.system AND sf.slug = 'snoozed'
                     )
                     THEN (SELECT f.id FROM email_folders f
                            WHERE f.organization_id = e.organization_id
                              AND f.user_id = e.user_id
                              AND f.system AND f.slug = 'inbox'
                            LIMIT 1)
                     ELSE e.folder_id
                END, e.folder_id)
        WHERE e.snoozed_until IS NOT NULL
          AND e.snoozed_until <= NOW()
        RETURNING e.id`
    );
    out.woke = r.rowCount;
    if (out.woke) console.log('[email-snooze] woke ' + out.woke + ' message(s)');
  } catch (e) {
    console.error('[email-snooze] sweep failed:', e && e.message);
    out.error = e.message;
  }

  // ── Trash retention (spec §1) ────────────────────────────────────
  // Deliberately its own try block: purging is destructive and must never
  // be able to take the snooze wake-up down with it, in either direction.
  try {
    const p = await purgeTrash();
    out.purged = p.purged;
  } catch (e) {
    console.error('[email-trash] purge failed:', e && e.message);
    out.purgeError = e.message;
  }
  return out;
}

// Permanently remove mail that has sat in Trash past the retention window.
//
// Keyed on trashed_at — stamped by moveMessages as a message crosses INTO
// Trash — and NOT on received_at. Mail is routinely binned long after it
// arrives, so an arrival-based rule would destroy a two-year-old thread the
// moment someone trashed it. Anything trashed before that column existed
// has a NULL stamp and is skipped rather than guessed at: it stays until a
// human moves it, which is the safe direction to be wrong in.
//
// The folder check is re-asserted in the DELETE itself. A message rescued
// from Trash has its stamp cleared, but belt-and-braces here means even a
// stale stamp cannot delete something that is no longer in the bin.
var TRASH_RETENTION_DAYS = 30;

async function purgeTrash() {
  const r = await pool.query(
    `DELETE FROM inbound_emails e
      USING email_folders f
      WHERE f.id = e.folder_id
        AND f.system
        AND f.slug = 'trash'
        AND e.trashed_at IS NOT NULL
        AND e.trashed_at < NOW() - ($1 || ' days')::interval
      RETURNING e.id`,
    [String(TRASH_RETENTION_DAYS)]
  );
  if (r.rowCount) {
    console.log('[email-trash] purged ' + r.rowCount +
      ' message(s) held past ' + TRASH_RETENTION_DAYS + ' days');
  }
  return { purged: r.rowCount };
}

var _started = false;
function start() {
  if (_started) return;
  _started = true;
  setTimeout(function () {
    runOnce().catch(function (e) { console.warn('[email-snooze] warmup error:', e && e.message); });
  }, FIRST_RUN_DELAY_MS);
  setTimeout(function tick() {
    runOnce().catch(function (e) { console.warn('[email-snooze] tick error:', e && e.message); });
    setTimeout(tick, TICK_MS);
  }, TICK_MS);
  console.log('[email-snooze] scanner armed; tick every ' + Math.round(TICK_MS / 60000) + ' min');
}

module.exports = { start: start, runOnce: runOnce, purgeTrash: purgeTrash, TRASH_RETENTION_DAYS: TRASH_RETENTION_DAYS };
