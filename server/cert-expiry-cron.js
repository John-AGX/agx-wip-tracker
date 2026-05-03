// Daily cert-expiry scanner — fires `cert_expiring` notifications.
//
// Scans sub_certificates once per day. For each row whose
// expiration_date is within reminder_days of today (and the sub has an
// email on file), fires the cert_expiring email event. Gating + BCC
// merging happen inside sendForEvent — this module just decides
// "should we send today?" and provides the params.
//
// Dedupe: tracks the (cert_id, expiration_date, fire_date) triple in
// app_settings('cert_expiry_log') so the same reminder doesn't fire
// twice in one day across server restarts. The log auto-prunes
// entries older than 60 days on each run to keep the JSONB small.
//
// Schedule: runs at the next 09:00 server-local each day. First run
// also fires roughly 60s after boot so a freshly-deployed server
// catches up on anything in the window without waiting until tomorrow.

const { pool } = require('./db');
const { sendForEvent } = require('./email');
const { certTypeLabel } = require('./email-templates');

// 24h period; 60s warmup on first boot so we don't spam right after
// every redeploy if dedupe somehow fails.
var ONE_DAY_MS = 24 * 60 * 60 * 1000;
var FIRST_RUN_DELAY_MS = 60 * 1000;

function todayISO() {
  var d = new Date();
  // YYYY-MM-DD in server-local time. Comparing against DATE columns
  // works fine since Postgres stores dates without TZ.
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

async function loadFireLog() {
  try {
    var r = await pool.query("SELECT value FROM app_settings WHERE key = 'cert_expiry_log'");
    return (r.rows.length && r.rows[0].value) || { fires: {} };
  } catch (e) {
    console.warn('[cert-expiry] log load failed:', e.message);
    return { fires: {} };
  }
}

async function saveFireLog(log) {
  try {
    await pool.query(
      "INSERT INTO app_settings (key, value) VALUES ('cert_expiry_log', $1) " +
      "ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()",
      [JSON.stringify(log)]
    );
  } catch (e) {
    console.warn('[cert-expiry] log save failed:', e.message);
  }
}

// Prune entries older than 60 days so the JSONB blob doesn't grow
// unbounded across years of operation.
function pruneFireLog(log) {
  var cutoff = Date.now() - 60 * ONE_DAY_MS;
  var fires = log.fires || {};
  Object.keys(fires).forEach(function(k) {
    var t = Number(fires[k]);
    if (!t || t < cutoff) delete fires[k];
  });
  log.fires = fires;
  return log;
}

async function runOnce() {
  var fired = 0;
  var skipped = 0;
  try {
    // Scan: certs whose expiration_date is in the future or already
    // expired (we still want to nudge for recently-lapsed) and within
    // reminder_days of today. reminder_direction='before' is the only
    // mode currently used; 'after' would extend into post-expiry.
    var sql = [
      "SELECT sc.id AS cert_id, sc.cert_type, sc.expiration_date,",
      "       sc.reminder_days, sc.reminder_direction,",
      "       (sc.expiration_date - CURRENT_DATE) AS days_until,",
      "       s.id AS sub_id, s.name AS sub_name, s.email AS sub_email,",
      "       s.primary_contact_first",
      "FROM sub_certificates sc",
      "JOIN subs s ON s.id = sc.sub_id",
      "WHERE sc.expiration_date IS NOT NULL",
      "  AND s.email IS NOT NULL AND s.email <> ''",
      "  AND ((sc.reminder_direction = 'before' AND sc.expiration_date >= CURRENT_DATE",
      "         AND sc.expiration_date <= CURRENT_DATE + sc.reminder_days * INTERVAL '1 day')",
      "    OR (sc.reminder_direction = 'after' AND sc.expiration_date < CURRENT_DATE",
      "         AND sc.expiration_date >= CURRENT_DATE - sc.reminder_days * INTERVAL '1 day'))"
    ].join(' ');
    var r = await pool.query(sql);
    if (!r.rows.length) {
      console.log('[cert-expiry] no certificates in reminder window');
      return { fired: 0, skipped: 0 };
    }

    var log = await loadFireLog();
    pruneFireLog(log);
    var fires = log.fires;
    var today = todayISO();

    for (var i = 0; i < r.rows.length; i++) {
      var row = r.rows[i];
      // Dedupe key: cert id + expiration + today. Re-renewing the cert
      // (changing expiration) yields a new key, so the next reminder
      // for the new date fires correctly.
      var expIso = row.expiration_date instanceof Date ?
        row.expiration_date.toISOString().slice(0, 10) :
        String(row.expiration_date).slice(0, 10);
      var key = row.cert_id + '|' + expIso + '|' + today;
      if (fires[key]) { skipped++; continue; }

      try {
        var result = await sendForEvent('cert_expiring', {
          sub: { name: row.sub_name, primaryContactFirst: row.primary_contact_first || '' },
          cert: {
            type: certTypeLabel(row.cert_type),
            expirationDate: expIso,
            daysUntilExpiry: Number(row.days_until)
          }
        }, { to: row.sub_email, tag: 'cert_expiring' });
        if (result && result.skipped) {
          skipped++;
          // Don't record skipped sends — re-checking tomorrow is fine
          // and lets the admin enable the toggle and have it fire on
          // the next run.
        } else {
          fires[key] = Date.now();
          fired++;
        }
      } catch (e) {
        console.warn('[cert-expiry] send failed for cert ' + row.cert_id + ':', e && e.message);
      }
    }
    if (fired > 0) await saveFireLog(log);
    console.log('[cert-expiry] scan complete — fired=' + fired + ' skipped=' + skipped + ' candidates=' + r.rows.length);
    return { fired: fired, skipped: skipped, candidates: r.rows.length };
  } catch (e) {
    console.error('[cert-expiry] scan failed:', e && e.message);
    return { fired: fired, skipped: skipped, error: e.message };
  }
}

// Compute the milliseconds until the next 09:00 server-local time.
function msUntilNext9am() {
  var now = new Date();
  var next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0, 0);
  if (next <= now) next = new Date(next.getTime() + ONE_DAY_MS);
  return next.getTime() - now.getTime();
}

var _started = false;
function start() {
  if (_started) return;
  _started = true;
  // Warmup run shortly after boot.
  setTimeout(function() {
    runOnce().catch(function(e) { console.warn('[cert-expiry] warmup error:', e && e.message); });
  }, FIRST_RUN_DELAY_MS);
  // Then schedule the first daily run for the next 9 AM, then chain
  // 24h intervals from there.
  setTimeout(function tick() {
    runOnce().catch(function(e) { console.warn('[cert-expiry] daily error:', e && e.message); });
    setTimeout(tick, ONE_DAY_MS);
  }, msUntilNext9am());
  console.log('[cert-expiry] daily scanner armed; first daily run in ' +
    Math.round(msUntilNext9am() / 60000) + ' min');
}

module.exports = { start: start, runOnce: runOnce };
