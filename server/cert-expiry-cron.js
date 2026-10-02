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
// Schedule: an hourly tick; each org is scanned on the first tick at or
// after 09:00 in ITS OWN timezone, deduped per org per local day. A warmup
// fires ~60s after boot so a freshly-deployed server catches up on anything
// already inside the window without waiting until tomorrow.
//
// ── FOUR CORRECTIONS, 1.88 ────────────────────────────────────────────
//
// This file is the model every later cron was written from, so its bugs were
// on their way to being copied. Writing deadline-digest-cron.js next door is
// what surfaced them.
//
// 1. THE DRY RUN COULD NOT ANSWER THE ONLY QUESTION WORTH ASKING. runOnce
//    took opts.dry and then guarded the scan with `if (wouldRun && !dry)`, so
//    a dry run never called scanOrg at all and reported `candidates`
//    undefined for every org. The preview for a mail-out told you WHICH orgs
//    were in their window and nothing whatever about how many emails they
//    were about to send. A dry run now runs the whole scan and stops at the
//    send, which is what /api/admin/reminders/cron-preview has always
//    implied it was showing you.
//
// 2. A THROW RE-SENT EVERY ORG ALREADY MAILED IN THAT TICK. saveFireLog ran
//    ONCE, after the org loop. scanOrg catches a failed send, but not its own
//    pool.query or replyToForOrgAdmin — so a database blip on org 7 threw
//    past the loop, the log was never written, and orgs 1-6 (whose mail had
//    gone out) had no orgRuns marker. The next tick mailed all of them again.
//    The log is now saved after each org, which is the same trade
//    deadline-digest-cron.js makes: one small write per org per day against
//    never re-mailing a subcontractor.
//
// 3. THE DEDUPE KEY WAS OFF BY A DAY WEST OF UTC. The key was built with
//    `expiration_date.toISOString().slice(0, 10)`, and node-postgres hands a
//    DATE back as LOCAL midnight — so toISOString read the UTC day off a
//    local-midnight Date and named the PREVIOUS day on any server west of
//    UTC. Postgres now formats it, with to_char, and no Date is involved.
//    services/notice-text.js:calendarDayLabel states the same rule.
//
// 4. TWO REPLICAS BOTH SENT. The fire log is one JSONB row rewritten whole,
//    which is safe for one replica and nothing else, and nothing in this
//    repository knows the replica count. A real tick now holds an advisory
//    lock (services/cron-tick-lock.js). This cron mails SUBCONTRACTORS, so a
//    duplicate is not an internal annoyance, it is a customer-facing one.
//
// Also deleted: a todayISO() helper that nothing has ever called, whose
// comment was being quoted as this repo's reasoning about CURRENT_DATE.

const { pool } = require('./db');
const { sendForEvent } = require('./email');
const emailSender = require('./email-sender');
const { certTypeLabel } = require('./email-templates');
const tz = require('./timezone');
const tickLock = require('./services/cron-tick-lock');

// 24h period; 60s warmup on first boot so we don't spam right after
// every redeploy if dedupe somehow fails.
var ONE_DAY_MS = 24 * 60 * 60 * 1000;
// Named so the test can ask for it rather than retyping the string, and so
// services/app-settings-keys.js and this file cannot drift apart silently.
var FIRE_LOG_KEY = 'cert_expiry_log';
var FIRST_RUN_DELAY_MS = 60 * 1000;

async function loadFireLog() {
  try {
    var r = await pool.query('SELECT value FROM app_settings WHERE key = $1', [FIRE_LOG_KEY]);
    return (r.rows.length && r.rows[0].value) || { fires: {} };
  } catch (e) {
    console.warn('[cert-expiry] log load failed:', e.message);
    return { fires: {} };
  }
}

async function saveFireLog(log) {
  try {
    await pool.query(
      'INSERT INTO app_settings (key, value) VALUES ($1, $2)'
      + ' ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()',
      [FIRE_LOG_KEY, JSON.stringify(log)]
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
//
// opts.dry counts what WOULD be sent and sends nothing, so a preview can
// report real numbers. It is passed down rather than guarded at the caller,
// which is the shape that produced bug 1 above.
async function scanOrg(orgId, localDate, fires, opts) {
  var dry = !!(opts && opts.dry);
  var fired = 0, skipped = 0;
  var sql = [
    // to_char, NOT the Date: node-postgres hands a DATE back as LOCAL
    // midnight, and toISOString then reads the UTC day off that instant.
    //
    // THE SLIP IS EAST OF UTC, NOT WEST, which is worth stating because the
    // opposite is written in several comments in this repo and was checked
    // here: at UTC-4, local midnight on the 12th is 04:00Z on the 12th and
    // toISOString says the 12th — correct. At UTC+2 it is 22:00Z on the 11th
    // and toISOString says the ELEVENTH. So the bug is latent on this
    // deployment (Railway runs UTC, where the two agree) and real on any dev
    // machine or region east of Greenwich. Latent is not fixed: the string
    // Postgres prints is the calendar day on the record, in every zone.
    "SELECT sc.id AS cert_id, sc.cert_type, sc.expiration_date,",
    "       to_char(sc.expiration_date, 'YYYY-MM-DD') AS expiration_iso,",
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
  // Sender + Reply-To, resolved once per org and only when there is
  // something to send. __orgId below makes sendForEvent send the reminder
  // as "<Org> via Project 86" (and applies the org's template override and
  // metering). The copy asks the sub to "reply to this email" with an
  // updated certificate, and no human wrote it — so replies go to the org's
  // earliest-created active admin. With no such admin: no Reply-To at all
  // (false), never the platform's EMAIL_REPLY_TO, never the sub.
  var replyTo = false;
  if (r.rows.length && !dry) {
    replyTo = (await emailSender.replyToForOrgAdmin(pool, orgId)) || false;
  }
  for (var i = 0; i < r.rows.length; i++) {
    var row = r.rows[i];
    var expIso = row.expiration_iso;
    var key = row.cert_id + '|' + expIso + '|' + localDate;
    if (fires[key]) { skipped++; continue; }
    // A dry run stops HERE: past the dedupe, before the send, so the count
    // it reports is the number of emails a real tick would actually put out.
    if (dry) { fired++; continue; }
    try {
      var result = await sendForEvent('cert_expiring', {
        sub: { name: row.sub_name, primaryContactFirst: row.primary_contact_first || '' },
        cert: {
          type: certTypeLabel(row.cert_type),
          expirationDate: expIso,
          daysUntilExpiry: Number(row.days_until)
        },
        __orgId: orgId
      }, { to: row.sub_email, tag: 'cert_expiring', replyTo: replyTo });
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
  // opts.now places the clock. Without it the per-org window gate can only
  // be exercised by waiting until morning, which is why it had no test.
  var now = opts.now instanceof Date ? opts.now : (opts.now ? new Date(opts.now) : new Date());

  // A dry run takes no lock: it sends nothing and records nothing, so two of
  // them cost nobody anything — and a preview you cannot run while a tick is
  // in progress is not a preview you would trust.
  var release = null;
  if (!dry) {
    release = await tickLock.take(pool, tickLock.KEYS.certExpiry, 'cert-expiry');
    if (!release) {
      console.log('[cert-expiry] tick skipped — another replica holds the lock');
      return { dry: dry, force: force, orgs: [], fired: 0, skipped: 0, skippedTick: 'locked' };
    }
  }

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
      if (wouldRun) {
        // THE SCAN RUNS ON A DRY PASS TOO. It used to be guarded by
        // `wouldRun && !dry`, so a preview reported no counts at all — see
        // correction 1 in the header. scanOrg stops before the send instead.
        var res = await scanOrg(org.id, localDate, fires, { dry: dry });
        entry.fired = res.fired; entry.skipped = res.skipped; entry.candidates = res.candidates;
        totalFired += res.fired; totalSkipped += res.skipped;
        if (!dry) {
          log.orgRuns[String(org.id)] = localDate;
          dirty = true;
        }
      }
      plan.push(entry);

      // SAVED AFTER EACH ORG, not once after the loop. scanOrg catches a
      // failed send but not its own pool.query, so a blip on org 7 threw past
      // this loop and orgs 1-6 — whose mail had gone out — kept no marker. The
      // next tick mailed every one of them again. See correction 2.
      if (dirty) { await saveFireLog(log); dirty = false; }
    }

    if (dirty) await saveFireLog(log);
    if (!dry) console.log('[cert-expiry] tick — orgs=' + orgs.length + ' ran=' + plan.filter(function (p) { return p.wouldRun; }).length + ' fired=' + totalFired + ' skipped=' + totalSkipped);
    return { dry: dry, force: force, orgs: plan, fired: totalFired, skipped: totalSkipped };
  } catch (e) {
    console.error('[cert-expiry] scan failed:', e && e.message);
    return { error: e.message, fired: 0, skipped: 0 };
  } finally {
    if (release) await release();
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

module.exports = {
  start: start,
  runOnce: runOnce,
  // exported so a test can name the window without reaching into the module
  SCAN_HOUR: SCAN_HOUR,
  FIRE_LOG_KEY: FIRE_LOG_KEY,
};
