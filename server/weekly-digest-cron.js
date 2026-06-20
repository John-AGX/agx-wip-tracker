// Weekly digest cron (Wave 8 of email work).
//
// Fires every Monday at 7 AM local. For each non-archived organization,
// assembles three role-targeted digests:
//   - weekly_digest_pm     — to every user with role 'pm' or admin
//   - weekly_digest_sales  — to every user with role 'sales' or admin
//   - weekly_digest_ops    — to every admin
//
// Data assembly uses simple per-event queries scoped to the org and the
// trailing-7-days window. List HTML is pre-rendered server-side so the
// template just interpolates {{{listHtml}}} as raw.
//
// Toggle:
//   - The email event must be enabled (defaults OFF). Admins flip
//     each digest on individually under Organization → Templates → Email
//   - sendForEvent() handles the enabled gate; this module just
//     produces the payload and calls sendForEvent
//
// Multi-market: ticks HOURLY and fires each org's digest once on its own
// local Monday morning (>= 07:00 in organizations.timezone), deduped per
// org per local ISO-week. So a New York org and a Los Angeles org each get
// their digest at 7am THEIR time, not at one global UTC moment.
//
// Exports:
//   start()       — arm the hourly tick
//   runOnce(opts) — opts.dry reports the per-org plan without sending;
//                   opts.force ignores the day/hour/dedup gate (manual send)

'use strict';

const { pool } = require('./db');
const { sendForEvent } = require('./email');
const tz = require('./timezone');

// Per-org "already sent this local week" marker so the hourly tick fires a
// given org's digest exactly once on its local Monday morning. Keyed by
// org id → ISO-week string in the org's own timezone.
async function loadWeekLog() {
  try {
    const r = await pool.query("SELECT value FROM app_settings WHERE key = 'weekly_digest_log'");
    return (r.rows.length && r.rows[0].value) || { orgs: {} };
  } catch (e) { return { orgs: {} }; }
}
async function saveWeekLog(log) {
  try {
    await pool.query(
      "INSERT INTO app_settings (key, value) VALUES ('weekly_digest_log', $1) " +
      "ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()",
      [JSON.stringify(log)]
    );
  } catch (e) { console.warn('[weekly-digest] week-log save failed:', e.message); }
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 30 * 1000;  // 30s after boot — warmup

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

// Format a "Week of …" label for the digest header, in the org's zone.
function weekLabel(now, zone) {
  return tz.formatInTz(now, zone, { month: 'long', day: 'numeric', year: 'numeric' });
}

var ONE_HOUR_MS = 60 * 60 * 1000;
// Hour (local) at/after which the Monday digest may fire.
var DIGEST_HOUR = 7;

// Render a simple <ul><li>…</li></ul> from an array of strings.
function listHtmlOf(items) {
  if (!items || !items.length) return '';
  return '<ul style="color:#1f2937;font-size:13px;line-height:1.6;margin:8px 0;padding-left:22px;">' +
    items.map(function(s) { return '<li>' + s + '</li>'; }).join('') +
  '</ul>';
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Per-org data assemblers ──────────────────────────────────────
// Each returns the digest params payload (or null if the org has
// nothing worth sending).

async function assemblePmDigest(orgId, weekStart) {
  const sinceISO = isoDate(weekStart);
  // Jobs touched this week. Uses jobs.updated_at — the most reliable
  // signal across the various per-feature update paths.
  const jobsR = await pool.query(
    "SELECT j.id, j.data->>'jobNumber' AS job_number, j.data->>'title' AS title, " +
    "       j.data->>'status' AS status " +
    "  FROM jobs j JOIN users u ON u.id = j.owner_id " +
    " WHERE u.organization_id = $1 AND j.updated_at >= $2 " +
    " ORDER BY j.updated_at DESC LIMIT 25",
    [orgId, sinceISO]
  );
  // Schedule entries that start in the next 7 days.
  const schedR = await pool.query(
    "SELECT s.start_date, s.job_id, j.data->>'title' AS job_title, j.data->>'jobNumber' AS job_number " +
    "  FROM schedule_entries s " +
    "  JOIN jobs j ON j.id = s.job_id " +
    "  JOIN users u ON u.id = j.owner_id " +
    " WHERE u.organization_id = $1 " +
    "   AND s.start_date >= CURRENT_DATE " +
    "   AND s.start_date <  CURRENT_DATE + INTERVAL '7 days' " +
    " ORDER BY s.start_date ASC LIMIT 25",
    [orgId]
  );
  if (!jobsR.rows.length && !schedR.rows.length) return null;
  return {
    jobsTouchedCount: jobsR.rows.length,
    jobsTouchedListHtml: listHtmlOf(jobsR.rows.map(function(r) {
      return esc(r.job_number || '—') + ' — ' + esc(r.title || '(untitled)') +
        (r.status ? ' <span style="color:#6b7280;">(' + esc(r.status) + ')</span>' : '');
    })),
    scheduleNextWeekCount: schedR.rows.length,
    scheduleNextWeekListHtml: listHtmlOf(schedR.rows.map(function(r) {
      const d = new Date(r.start_date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
      return esc(d) + ' — ' + esc(r.job_number || '') + ' ' + esc(r.job_title || '(untitled)');
    }))
  };
}

async function assembleSalesDigest(orgId, weekStart) {
  const sinceISO = isoDate(weekStart);
  const leadsR = await pool.query(
    "SELECT l.id, l.data->>'title' AS title, l.data->>'status' AS status, l.data->>'client_company' AS client_company " +
    "  FROM leads l JOIN users u ON u.id = l.owner_id " +
    " WHERE u.organization_id = $1 AND l.updated_at >= $2 " +
    " ORDER BY l.updated_at DESC LIMIT 25",
    [orgId, sinceISO]
  );
  const wonR = await pool.query(
    "SELECT COUNT(*)::int AS c FROM leads l JOIN users u ON u.id = l.owner_id " +
    " WHERE u.organization_id = $1 AND l.updated_at >= $2 AND l.data->>'status' = 'Sold'",
    [orgId, sinceISO]
  );
  const estR = await pool.query(
    "SELECT COUNT(*)::int AS c FROM estimates e JOIN users u ON u.id = e.owner_id " +
    " WHERE u.organization_id = $1 AND e.updated_at >= $2 " +
    "   AND COALESCE(e.data->>'bt_export_status','') IN ('sent','accepted')",
    [orgId, sinceISO]
  );
  if (!leadsR.rows.length && !(wonR.rows[0] && wonR.rows[0].c) && !(estR.rows[0] && estR.rows[0].c)) return null;
  return {
    leadsProgressedCount: leadsR.rows.length,
    leadsProgressedListHtml: listHtmlOf(leadsR.rows.map(function(r) {
      return esc(r.title || '(untitled)') +
        (r.client_company ? ' <span style="color:#6b7280;">' + esc(r.client_company) + '</span>' : '') +
        (r.status ? ' — <strong>' + esc(r.status) + '</strong>' : '');
    })),
    leadsWonCount: (wonR.rows[0] && wonR.rows[0].c) || 0,
    estimatesSentCount: (estR.rows[0] && estR.rows[0].c) || 0
  };
}

async function assembleOpsDigest(orgId) {
  // Certs expiring in the next 30 days.
  const certsR = await pool.query(
    "SELECT s.name AS sub_name, c.cert_type, c.expiration_date " +
    "  FROM sub_certifications c " +
    "  JOIN subs s ON s.id = c.sub_id " +
    " WHERE s.organization_id = $1 " +
    "   AND c.expiration_date >= CURRENT_DATE " +
    "   AND c.expiration_date <  CURRENT_DATE + INTERVAL '30 days' " +
    " ORDER BY c.expiration_date ASC LIMIT 25",
    [orgId]
  );
  // Jobs starting next week — schedule entries first day.
  const startsR = await pool.query(
    "SELECT COUNT(DISTINCT j.id)::int AS c " +
    "  FROM schedule_entries s " +
    "  JOIN jobs j ON j.id = s.job_id " +
    "  JOIN users u ON u.id = j.owner_id " +
    " WHERE u.organization_id = $1 " +
    "   AND s.start_date >= CURRENT_DATE " +
    "   AND s.start_date <  CURRENT_DATE + INTERVAL '7 days'",
    [orgId]
  );
  if (!certsR.rows.length && !(startsR.rows[0] && startsR.rows[0].c)) return null;
  return {
    certsExpiringCount: certsR.rows.length,
    certsExpiringListHtml: listHtmlOf(certsR.rows.map(function(r) {
      const days = Math.max(0, Math.ceil((new Date(r.expiration_date) - new Date()) / (24 * 60 * 60 * 1000)));
      return esc(r.sub_name) + ' — ' + esc(r.cert_type || 'cert') + ' expires in ' + days + ' days';
    })),
    jobsStartingNextWeekCount: (startsR.rows[0] && startsR.rows[0].c) || 0
  };
}

// ── Per-org recipients ───────────────────────────────────────────
async function recipientsForRole(orgId, role) {
  // Role can be 'pm', 'sales', 'admin'. We include admins in PM and
  // sales digests so the org admin sees the same view as their team.
  let where;
  if (role === 'admin') {
    where = "role IN ('admin') ";
  } else if (role === 'pm') {
    where = "role IN ('admin','pm') ";
  } else if (role === 'sales') {
    where = "role IN ('admin','sales','salesperson') ";
  } else return [];
  const r = await pool.query(
    "SELECT id, email, name FROM users " +
    " WHERE organization_id = $1 AND " + where +
    "   AND email IS NOT NULL AND email <> '' ",
    [orgId]
  );
  return r.rows;
}

// Assemble + send all three role digests for one org. Returns the number
// of emails sent.
async function sendOrgDigests(org, weekStart, label) {
  let sent = 0;
  try {
    const pmData = await assemblePmDigest(org.id, weekStart);
    if (pmData) {
      const pms = await recipientsForRole(org.id, 'pm');
      for (const u of pms) {
        await sendForEvent('weekly_digest_pm', Object.assign({ recipientName: u.name || 'there', week_label: label, __orgId: org.id }, pmData), { to: u.email });
        sent++;
      }
    }
  } catch (e) { console.warn('[weekly-digest][pm] org=' + org.id, e.message); }
  try {
    const salesData = await assembleSalesDigest(org.id, weekStart);
    if (salesData) {
      const ppl = await recipientsForRole(org.id, 'sales');
      for (const u of ppl) {
        await sendForEvent('weekly_digest_sales', Object.assign({ recipientName: u.name || 'there', week_label: label, __orgId: org.id }, salesData), { to: u.email });
        sent++;
      }
    }
  } catch (e) { console.warn('[weekly-digest][sales] org=' + org.id, e.message); }
  try {
    const opsData = await assembleOpsDigest(org.id);
    if (opsData) {
      const admins = await recipientsForRole(org.id, 'admin');
      for (const u of admins) {
        await sendForEvent('weekly_digest_ops', Object.assign({ recipientName: u.name || 'there', week_label: label, __orgId: org.id }, opsData), { to: u.email });
        sent++;
      }
    }
  } catch (e) { console.warn('[weekly-digest][ops] org=' + org.id, e.message); }
  return sent;
}

// ── Run-once entry point ─────────────────────────────────────────
// Called hourly. Fires each org's digest once on its LOCAL Monday morning
// (>= 07:00 in the org's timezone), deduped per org per local ISO-week.
//   opts.dry   → report the per-org plan, send nothing, record nothing.
//   opts.force → ignore the Monday/hour/dedup gate (manual immediate send).
async function runOnce(opts) {
  opts = opts || {};
  const dry = !!opts.dry;
  const force = !!opts.force;
  const now = new Date();
  const weekStart = new Date(now.getTime() - 7 * ONE_DAY_MS);
  const orgs = (await pool.query(
    'SELECT id, name, timezone FROM organizations WHERE archived_at IS NULL'
  )).rows;
  const log = await loadWeekLog();
  const plan = [];
  let totalSent = 0;
  let dirty = false;

  for (const org of orgs) {
    const zone = tz.resolveTz(null, org.timezone);
    const localDow = tz.dayOfWeekInTz(zone, now);
    const localHour = tz.hourInTz(zone, now);
    const weekKey = tz.localWeekInTz(zone, now);
    const alreadySent = log.orgs[org.id] === weekKey;
    const inWindow = (localDow === 1 && localHour >= DIGEST_HOUR);
    const wouldFire = force || (inWindow && !alreadySent);
    plan.push({ orgId: org.id, name: org.name, timezone: zone, localDow: localDow, localHour: localHour, inWindow: inWindow, alreadySent: alreadySent, wouldFire: wouldFire });
    if (!wouldFire || dry) continue;
    const label = weekLabel(now, zone);
    const sent = await sendOrgDigests(org, weekStart, label);
    totalSent += sent;
    log.orgs[org.id] = weekKey;
    dirty = true;
  }

  if (dirty) await saveWeekLog(log);
  if (!dry) console.log('[weekly-digest] tick — orgs=' + orgs.length + ' fired=' + plan.filter(p => p.wouldFire).length + ' emails=' + totalSent);
  return { dry: dry, force: force, orgs: plan, emails_sent: totalSent };
}

let _started = false;
function start() {
  if (_started) return;
  _started = true;
  setTimeout(function() {
    console.log('[weekly-digest] armed; hourly tick, fires each org on its local Monday ' + DIGEST_HOUR + ':00');
  }, FIRST_RUN_DELAY_MS);
  // Hourly tick — the per-org local-time gate + per-week dedup inside
  // runOnce decide when each org actually receives its digest.
  setTimeout(function tick() {
    runOnce().catch(function(e) { console.warn('[weekly-digest] tick error:', e && e.message); });
    setTimeout(tick, ONE_HOUR_MS);
  }, ONE_HOUR_MS);
}

module.exports = { start: start, runOnce: runOnce };
