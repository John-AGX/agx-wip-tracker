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
const tz = require('./timezone');

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

var ONE_HOUR_MS = 60 * 60 * 1000;
var SCAN_HOUR = 9; // local hour at/after which an org's daily scan runs

// Scan + send cert reminders for ONE org. Returns { fired, skipped,
// candidates }. Per-cert dedup uses `localDate` so the key resets at the
// org's local midnight. Never throws.
async function scanOrg(orgId, localDate, fires) {
  var fired = 0, skipped = 0;
  var sql = [
    "SELECT sc.id AS cert_id, sc.cert_type, sc.expiration_date,",
    "       sc.reminder_days, sc.reminder_direction,",
    "       (sc.expiration_date - CURRENT_DATE) AS days_until,",
    "       s.id AS sub_id, s.name AS sub_name, s.email AS sub_email,",
    "       s.primary_contact_first",
    "FROM sub_certificates sc",
    "JOIN subs s ON s.id = sc.sub_id",
    "WHERE sc.expiration_date IS NOT NULL",
    "  AND s.organization_id = $1",
    "  AND s.email IS NOT NULL AND s.email <> ''",
    "  AND ((sc.reminder_direction = 'before' AND sc.expiration_date >= CURRENT_DATE",
    "         AND sc.expiration_date <= CURRENT_DATE + sc.reminder_days * INTERVAL '1 day')",
    "    OR (sc.reminder_direction = 'after' AND sc.expiration_date < CURRENT_DATE",
    "         AND sc.expiration_date >= CURRENT_DATE - sc.reminder_days * INTERVAL '1 day'))"
  ].join(' ');
  var r = await pool.query(sql, [orgId]);
  for (var i = 0; i < r.rows.length; i++) {
    var row = r.rows[i];
    var expIso = row.expiration_date instanceof Date ?
      row.expiration_date.toISOString().slice(0, 10) :
      String(row.expiration_date).slice(0, 10);
    var key = row.cert_id + '|' + expIso + '|' + localDate;
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
      } else {
        fires[key] = Date.now();
        fired++;
      }
    } catch (e) {
      console.warn('[cert-expiry] send failed for cert ' + row.cert_id + ':', e && e.message);
    }
  }
  return { fired: fired, skipped: skipped, candidates: r.rows.length };
}

// Called hourly. Scans each org's certs once on its LOCAL morning
// (>= 09:00 in organizations.timezone), deduped per org per local day.
//   opts.dry   → report the per-org plan, scan/send nothing.
//   opts.force → ignore the hour/dedup gate (manual immediate scan).
async function runOnce(opts) {
  opts = opts || {};
  var dry = !!opts.dry;
  var force = !!opts.force;
  var now = new Date();
  try {
    var orgs = (await pool.query(
      'SELECT id, name, timezone FROM organizations WHERE archived_at IS NULL'
    )).rows;
    var log = await loadFireLog();
    pruneFireLog(log);
    if (!log.orgRuns) log.orgRuns = {};
    var fires = log.fires;
    var plan = [];
    var totalFired = 0, totalSkipped = 0;
    var dirty = false;

    for (var i = 0; i < orgs.length; i++) {
      var org = orgs[i];
      var zone = tz.resolveTz(null, org.timezone);
      var localHour = tz.hourInTz(zone, now);
      var localDate = tz.localDateInTz(zone, now);
      var ranToday = log.orgRuns[String(org.id)] === localDate;
      var inWindow = localHour >= SCAN_HOUR;
      var wouldRun = force || (inWindow && !ranToday);
      var entry = { orgId: org.id, name: org.name, timezone: zone, localHour: localHour, inWindow: inWindow, ranToday: ranToday, wouldRun: wouldRun };
      if (wouldRun && !dry) {
        var res = await scanOrg(org.id, localDate, fires);
        entry.fired = res.fired; entry.skipped = res.skipped; entry.candidates = res.candidates;
        totalFired += res.fired; totalSkipped += res.skipped;
        log.orgRuns[String(org.id)] = localDate;
        dirty = true;
      }
      plan.push(entry);
    }

    if (dirty) await saveFireLog(log);
    if (!dry) console.log('[cert-expiry] tick — orgs=' + orgs.length + ' ran=' + plan.filter(function (p) { return p.wouldRun; }).length + ' fired=' + totalFired + ' skipped=' + totalSkipped);
    return { dry: dry, force: force, orgs: plan, fired: totalFired, skipped: totalSkipped };
  } catch (e) {
    console.error('[cert-expiry] scan failed:', e && e.message);
    return { error: e.message, fired: 0, skipped: 0 };
  }
}

var _started = false;
function start() {
  if (_started) return;
  _started = true;
  // Warmup shortly after boot (gated per-org inside runOnce, so it only
  // actually sends for orgs currently in their local morning window).
  setTimeout(function() {
    runOnce().catch(function(e) { console.warn('[cert-expiry] warmup error:', e && e.message); });
  }, FIRST_RUN_DELAY_MS);
  // Hourly tick — the per-org local-time gate + per-day dedup inside
  // runOnce decide when each org's certs are scanned.
  setTimeout(function tick() {
    runOnce().catch(function(e) { console.warn('[cert-expiry] tick error:', e && e.message); });
    setTimeout(tick, ONE_HOUR_MS);
  }, ONE_HOUR_MS);
  console.log('[cert-expiry] scanner armed; hourly tick, scans each org on its local ' + SCAN_HOUR + ':00');
}

module.exports = { start: start, runOnce: runOnce };
