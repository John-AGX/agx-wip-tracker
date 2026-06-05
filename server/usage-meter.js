// Usage meter — per-org, per-month accumulation (SaaS scaffold).
//
// recordUsage(orgId, metric, qty) UPSERT-increments the usage_counters
// row for the current billing month. This is PURE ACCOUNTING right now:
// we start banking usage history before any plan enforces a limit, so
// that when billing turns on there's real data to meter against and to
// render on an account/usage page.
//
// Design notes:
//   - Fire-and-forget friendly: recordUsage never throws. A metering
//     failure must never break the user action it's measuring. Callers
//     can `await` it or not; either way a DB blip just logs + drops the
//     increment.
//   - Period = 'YYYY-MM' in UTC. Keeping it a string (not a date) makes
//     the PK composite trivial and the "this month" lookup a plain
//     equality. Monthly granularity matches how subscription limits are
//     conventionally expressed (X / month).
//   - The metric vocabulary is intentionally open (just a TEXT column).
//     Keep the common ones in METRICS below for callers to reference so
//     we don't drift on spelling ('email_sends' vs 'emails_sent').

'use strict';

const { pool } = require('./db');

// Canonical metric names — reference these instead of string literals
// at call sites so the vocabulary stays consistent. Mirrors the limit
// keys in plans-catalog.js (ai_messages_per_month → 'ai_messages', etc).
const METRICS = {
  AI_MESSAGES: 'ai_messages',
  EMAIL_SENDS: 'email_sends',
  STORAGE_BYTES: 'storage_bytes',
  CAMPAIGN_SENDS: 'campaign_sends',
};

// Current billing period as 'YYYY-MM' (UTC). Pure-ish: reads the clock
// once per call. NOTE: avoid module-load-time Date capture — period
// must reflect the moment of the increment, not boot time.
function currentPeriod() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return y + '-' + m;
}

// Increment a counter. orgId null/0 (e.g. a system-scope action with no
// tenant) is a silent no-op — we only meter tenant usage. Never throws.
async function recordUsage(orgId, metric, qty) {
  const id = Number(orgId);
  if (!id || !metric) return;
  const n = Number(qty);
  const inc = Number.isFinite(n) ? Math.trunc(n) : 1;
  if (inc === 0) return;
  try {
    await pool.query(
      `INSERT INTO usage_counters (organization_id, metric, period, count, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (organization_id, metric, period)
       DO UPDATE SET count = usage_counters.count + EXCLUDED.count, updated_at = NOW()`,
      [id, String(metric), currentPeriod(), inc]
    );
  } catch (e) {
    console.warn('[usage-meter] recordUsage failed org=' + id + ' metric=' + metric + ':', e.message);
  }
}

// Read a single metric's count for the current (or given) period.
// Returns 0 when there's no row. Used by future enforcement checks +
// the account/usage page.
async function getUsage(orgId, metric, period) {
  const id = Number(orgId);
  if (!id || !metric) return 0;
  try {
    const r = await pool.query(
      'SELECT count FROM usage_counters WHERE organization_id = $1 AND metric = $2 AND period = $3',
      [id, String(metric), period || currentPeriod()]
    );
    return r.rows.length ? Number(r.rows[0].count) : 0;
  } catch (e) {
    console.warn('[usage-meter] getUsage failed:', e.message);
    return 0;
  }
}

// All counters for an org in a period, as { metric: count }. Powers the
// future usage page; cheap (one indexed query).
async function getUsageSummary(orgId, period) {
  const id = Number(orgId);
  if (!id) return {};
  try {
    const r = await pool.query(
      'SELECT metric, count FROM usage_counters WHERE organization_id = $1 AND period = $2',
      [id, period || currentPeriod()]
    );
    const out = {};
    r.rows.forEach(function (row) { out[row.metric] = Number(row.count); });
    return out;
  } catch (e) {
    console.warn('[usage-meter] getUsageSummary failed:', e.message);
    return {};
  }
}

module.exports = {
  METRICS,
  currentPeriod,
  recordUsage,
  getUsage,
  getUsageSummary,
};
