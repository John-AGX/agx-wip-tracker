// Snooze wake-up sweep — Premium Email Hub E3.
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
  return out;
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

module.exports = { start: start, runOnce: runOnce };
