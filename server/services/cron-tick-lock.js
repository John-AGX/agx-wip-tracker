'use strict';

/* ONE REPLICA RUNS A TICK, WHATEVER THE REPLICA COUNT IS.
 *
 * Every scheduled job in this server dedupes through a single JSONB row in
 * app_settings, read-modify-written with ON CONFLICT DO UPDATE — a
 * last-writer-wins whole-blob overwrite. work-order-notify-cron.js states the
 * caveat in its own header: "fine for one replica". Two replicas ticking in the
 * same minute both read a ledger without today's key, both send, and the second
 * save erases the first one's marker.
 *
 * WHETHER THIS APP RUNS ONE REPLICA IS NOT KNOWABLE FROM THIS REPOSITORY.
 * ecosystem.config.js pins `instances: 1`, but only the pm2/VPS path reads it;
 * Railway runs `npm start` and keeps the replica count in its dashboard.
 * rate-limit.js says "one Railway replica today" and db.js calls repeated room
 * takeovers "the only honest signal available that more than one replica is
 * running" — the codebase is guessing, in comments, in two places. So a cron
 * should not depend on the answer.
 *
 * ━━ THE LOCK MUST BE TAKEN ON ITS OWN CLIENT ━━
 *
 * A session-level advisory lock belongs to the CONNECTION that took it. Taken
 * through `pool.query`, the unlock can land on a different connection — leaving
 * the lock held by a connection sitting idle in the pool, so every later tick
 * fails to acquire it and THE CRON GOES QUIET FOREVER, with nothing in the log
 * to say why. That is a worse failure than the duplicate sends it was meant to
 * prevent, because it is silent.
 *
 * The one other advisory lock in this server (routes/admin-agents-routes.js)
 * does take it through the pool. It survives because that path is a one-shot
 * admin action rather than a repeating timer: if its unlock strays, the next
 * reset is the only thing affected and a human is standing there.
 *
 * ━━ IT IS A SKIP, NOT A QUEUE ━━
 *
 * A tick that cannot take the lock does nothing and says so. It does not wait:
 * these are hourly scans gated on a local-morning window several hours wide, so
 * missing one tick costs nothing and the next one picks it up. Blocking would
 * hold a pooled connection open for the length of somebody else's scan.
 *
 * USAGE
 *   const release = await tickLock.take(pool, tickLock.KEYS.certExpiry, 'cert-expiry');
 *   if (!release) return skipped();
 *   try { ...the tick... } finally { await release(); }
 *
 * The `finally` is not optional. Every caller is reviewed for it.
 */

/* Keys are assigned HERE so two crons cannot pick the same number by accident.
 *
 * They must also avoid the only other advisory lock in this server, which uses
 * `0x86 * 1000000 + orgId` — i.e. 134000001 and up for real org ids. These sit
 * well below that, in their own decade.
 */
const KEYS = Object.freeze({
  deadlineDigest: 8601986,
  certExpiry: 8601987,
});

/* Take the lock. Returns an async release function, or null when another
 * replica already holds it.
 *
 * NEVER THROWS. A database that cannot answer right now is a reason to skip
 * this tick, not to take down the timer that owns every later one — so a
 * failure to acquire reads the same as "somebody else has it".
 */
async function take(pool, key, label) {
  const who = label || 'cron';
  if (!pool || typeof pool.connect !== 'function') {
    // No pool to lock against (an offline dev boot, or a test double that only
    // provides query). Nothing to serialise, so the tick proceeds.
    return async function () {};
  }
  let client;
  try {
    client = await pool.connect();
    const r = await client.query('SELECT pg_try_advisory_lock($1) AS got', [key]);
    const got = !!(r && r.rows && r.rows[0] && r.rows[0].got);
    if (!got) {
      client.release();
      return null;
    }
    return async function release() {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [key]);
      } catch (e) {
        console.warn('[' + who + '] advisory unlock failed:', e && e.message);
      }
      try { client.release(); } catch (_) { /* already gone */ }
    };
  } catch (e) {
    console.warn('[' + who + '] advisory lock failed:', e && e.message);
    try { if (client) client.release(); } catch (_) {}
    return null;
  }
}

module.exports = { KEYS, take };
