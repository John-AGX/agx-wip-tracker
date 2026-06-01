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
// Exports:
//   start()   — arm the weekly tick
//   runOnce(opts) — fire the digest assembly now (admin button or test)
//                   opts.dayOverride lets a manual run pretend it's
//                   the Monday cron run (so a Thursday admin click
//                   still computes a Mon-Sun window)

'use strict';

const { pool } = require('./db');
const { sendForEvent } = require('./email');

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 30 * 1000;  // 30s after boot — warmup

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

// Format a "Week of …" label for the digest header. Returns the
// label for the trailing 7-day window ending today.
function weekLabel(now) {
  return now.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
}

// Compute the timestamp of next Monday 7 AM relative to now.
function msUntilNextMon7am() {
  const now = new Date();
  const out = new Date(now);
  out.setHours(7, 0, 0, 0);
  const dow = out.getDay(); // 0 = Sun, 1 = Mon
  let daysAdd;
  if (dow === 1 && out > now) daysAdd = 0;
  else if (dow === 1) daysAdd = 7;
  else if (dow === 0) daysAdd = 1;
  else daysAdd = (8 - dow);
  out.setDate(out.getDate() + daysAdd);
  return out.getTime() - now.getTime();
}

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

// ── Run-once entry point ─────────────────────────────────────────
async function runOnce() {
  const now = new Date();
  const weekStart = new Date(now.getTime() - 7 * ONE_DAY_MS);
  const label = weekLabel(now);
  const orgs = (await pool.query('SELECT id, name FROM organizations WHERE archived_at IS NULL')).rows;
  for (const org of orgs) {
    // PM digest
    try {
      const pmData = await assemblePmDigest(org.id, weekStart);
      if (pmData) {
        const pms = await recipientsForRole(org.id, 'pm');
        for (const u of pms) {
          await sendForEvent('weekly_digest_pm', Object.assign({ recipientName: u.name || 'there', week_label: label, __orgId: org.id }, pmData), { to: u.email });
        }
      }
    } catch (e) { console.warn('[weekly-digest][pm] org=' + org.id, e.message); }

    // Sales digest
    try {
      const salesData = await assembleSalesDigest(org.id, weekStart);
      if (salesData) {
        const ppl = await recipientsForRole(org.id, 'sales');
        for (const u of ppl) {
          await sendForEvent('weekly_digest_sales', Object.assign({ recipientName: u.name || 'there', week_label: label, __orgId: org.id }, salesData), { to: u.email });
        }
      }
    } catch (e) { console.warn('[weekly-digest][sales] org=' + org.id, e.message); }

    // Ops digest
    try {
      const opsData = await assembleOpsDigest(org.id);
      if (opsData) {
        const admins = await recipientsForRole(org.id, 'admin');
        for (const u of admins) {
          await sendForEvent('weekly_digest_ops', Object.assign({ recipientName: u.name || 'there', week_label: label, __orgId: org.id }, opsData), { to: u.email });
        }
      }
    } catch (e) { console.warn('[weekly-digest][ops] org=' + org.id, e.message); }
  }
  console.log('[weekly-digest] run completed for ' + orgs.length + ' org(s)');
}

let _started = false;
function start() {
  if (_started) return;
  _started = true;
  setTimeout(function() {
    // No-op warmup — digests only fire on the scheduled cadence so
    // we don't blast emails right after a deploy. The "first run"
    // here is just a log line.
    console.log('[weekly-digest] armed; next Mon 7am tick in ' + Math.round(msUntilNextMon7am() / 60000) + ' min');
  }, FIRST_RUN_DELAY_MS);
  setTimeout(function tick() {
    runOnce().catch(function(e) { console.warn('[weekly-digest] weekly run error:', e && e.message); });
    setTimeout(tick, 7 * ONE_DAY_MS);
  }, msUntilNextMon7am());
}

module.exports = { start: start, runOnce: runOnce };
