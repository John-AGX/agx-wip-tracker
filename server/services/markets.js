// ────────────────────────────────────────────────────────────────
// Markets (multi-market model, M1).
//
// AGX runs Tampa / Orlando / Denver / Arizona / Texas out of ONE
// organization. A market is a first-class DIMENSION — it owns a
// timezone, tax rate, labor rate, license and P&L — not a saved-view
// filter. Hierarchy: organization -> market -> job.
//
// organization_id remains the TENANT + SECURITY boundary. Market is the
// operating unit inside it. Never swap an org check for a market check.
//
// See docs/multi-market.md for the full spec + build order.
// ────────────────────────────────────────────────────────────────
const { pool } = require('../db');

// The five markets AGX operates. Seeded per organization, idempotent.
//
// ⚠ Arizona is America/Phoenix — Arizona does NOT observe DST. Folding
// it into Denver/Mountain makes every time-gated cron (reminders, My Day,
// digests) fire an hour off for ~8 months of the year. This is the single
// most important line in this file.
const DEFAULT_MARKETS = [
  { name: 'Tampa',   code: 'TPA', state: 'FL', timezone: 'America/New_York', color: '#378add', sort: 10 },
  { name: 'Orlando', code: 'ORL', state: 'FL', timezone: 'America/New_York', color: '#1d9e75', sort: 20 },
  { name: 'Denver',  code: 'DEN', state: 'CO', timezone: 'America/Denver',   color: '#d98a1f', sort: 30 },
  { name: 'Arizona', code: 'PHX', state: 'AZ', timezone: 'America/Phoenix',  color: '#d85a30', sort: 40 },
  { name: 'Texas',   code: 'TEX', state: 'TX', timezone: 'America/Chicago',  color: '#7f77dd', sort: 50 },
  // Jacksonville was NOT in the original five — it was found in the live
  // data (2 jobs already carry it). Seeding it means those jobs map on the
  // backfill instead of silently staying market-less.
  { name: 'Jacksonville', code: 'JAX', state: 'FL', timezone: 'America/New_York', color: '#d4537e', sort: 25 },
];

// Seed the five markets for one org. Idempotent: ON CONFLICT against the
// case-insensitive name index, so a re-run (or a rename to a different
// case) can never mint a duplicate market. Existing rows are left ALONE —
// once John edits Tampa's tax rate we must not stomp it on next boot.
async function seedMarketsForOrg(orgId, client) {
  const db = client || pool;
  for (const m of DEFAULT_MARKETS) {
    await db.query(
      `INSERT INTO markets (organization_id, name, code, state, timezone, color, sort)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (organization_id, (LOWER(name))) DO NOTHING`,
      [orgId, m.name, m.code, m.state, m.timezone, m.color, m.sort]
    );
  }
}

// Boot backfill:
//   1. seed the 5 markets for every org
//   2. map the LEGACY free-text `market` column on jobs + leads onto the
//      new market_id FK (matched case-insensitively, org-scoped)
//
// The legacy TEXT column is deliberately LEFT IN PLACE — dual-read for one
// release. Dropping it here would make a rollback lossy.
//
// Only fills market_id IS NULL, so a market someone has since reassigned
// by hand is never dragged back to the text value.
// Each step is INDEPENDENTLY guarded. A single bad query must never abort
// the rest of the backfill — that exact failure mode (an estimates join on
// a column that doesn't exist) silently swallowed the jobs+leads mapping on
// the first deploy and left every job unassigned. Returns per-step counts so
// the caller (and the admin re-run route) can SEE what actually happened
// instead of trusting a silent "no error".
async function backfill() {
  const result = { seeded: 0, jobs: 0, leads: 0, clients: 0, estimates: 0, estimates_from_lead: 0, errors: [] };

  try {
    const orgs = await pool.query('SELECT id FROM organizations');
    for (const row of orgs.rows) {
      await seedMarketsForOrg(row.id);
      result.seeded++;
    }
  } catch (e) {
    result.errors.push('seed: ' + (e && e.message));
  }

  // The legacy market string does NOT live in the same place on every table:
  //   leads / clients -> a real `market TEXT` column
  //   jobs            -> inside the JSONB blob, data->>'market'
  //                      (jobs is id/owner_id/data — there is no market column,
  //                       which is why a uniform `t.market` threw here)
  // LOWER(TRIM()) on both sides absorbs 'tampa ' / 'Tampa'. Org-scoped so one
  // tenant's "Tampa" can never claim another's rows.
  const SOURCES = [
    { table: 'leads',   expr: 't.market' },
    { table: 'clients', expr: 't.market' },
    { table: 'jobs',    expr: "t.data->>'market'" },
  ];
  for (const src of SOURCES) {
    try {
      const r = await pool.query(
        `UPDATE ${src.table} t
            SET market_id = m.id
           FROM markets m
          WHERE t.market_id IS NULL
            AND ${src.expr} IS NOT NULL
            AND TRIM(${src.expr}) <> ''
            AND m.organization_id = t.organization_id
            AND LOWER(TRIM(m.name)) = LOWER(TRIM(${src.expr}))`
      );
      result[src.table] = r.rowCount || 0;
    } catch (e) {
      result.errors.push(src.table + ': ' + (e && e.message));
    }
  }

  // Estimates inherit their job's market. NOTE: estimates has NO job_id —
  // the link runs the OTHER way, jobs.estimate_id -> estimates.id (see the
  // schema note at db.js "estimate.data.job_id <-> jobs.estimate_id").
  // Joining on e.job_id throws and was what aborted this whole function.
  try {
    const r = await pool.query(
      `UPDATE estimates e
          SET market_id = j.market_id
         FROM jobs j
        WHERE e.market_id IS NULL
          AND j.market_id IS NOT NULL
          AND j.estimate_id = e.id`
    );
    result.estimates = r.rowCount || 0;
  } catch (e) {
    result.errors.push('estimates: ' + (e && e.message));
  }

  // M3 — estimates inherit their LEAD's market too. The job-linked step
  // above only reaches estimates that have already been CONVERTED, which
  // in live data was 1 of 25: an estimate spends most of its life
  // pre-conversion, so "inherit from the job" resolves almost nothing.
  // The lead link is the earlier (and far more common) one, and it lives
  // in the JSONB blob — estimates has no lead_id column, so this reads
  // data->>'lead_id' (TEXT) against leads.id (also TEXT).
  //
  // Runs AFTER the job step so a converted estimate keeps its JOB's
  // market if the two ever disagree (the job is the later, realized
  // truth). Still only fills NULLs, so neither step re-rates a row.
  try {
    const r = await pool.query(
      `UPDATE estimates e
          SET market_id = l.market_id
         FROM leads l
        WHERE e.market_id IS NULL
          AND l.market_id IS NOT NULL
          AND l.id = e.data->>'lead_id'
          -- STRICT org match. The earlier
          --   OR e.organization_id IS NULL OR l.organization_id IS NULL
          -- escape let an estimate with a NULL org inherit a market from
          -- ANOTHER TENANT's lead. Org is the security boundary and market
          -- never relaxes it (see AUDIT Wave A + docs/multi-market.md).
          -- A null-org row simply doesn't backfill — that's the safe
          -- failure; it stays unassigned and shows under "All markets".
          AND e.organization_id = l.organization_id`
    );
    result.estimates_from_lead = r.rowCount || 0;
  } catch (e) {
    result.errors.push('estimates_from_lead: ' + (e && e.message));
  }

  return result;
}

// ── Write-path market resolution ─────────────────────────────────────
// The backfill above is a catch-up; these keep NEW rows from ever
// needing one. Both take the org's market list ONCE (loadMarketMap) so a
// bulk save resolving 200 jobs still costs a single query.
//
// A market NAME is what the job/lead blobs carry (the legacy TEXT
// field the pickers still write), so the map is keyed both ways.
async function loadMarketMap(orgId, client) {
  const db = client || pool;
  const r = await db.query(
    'SELECT id, name FROM markets WHERE organization_id = $1',
    [orgId]
  );
  const byName = new Map();
  const ids = new Set();
  for (const m of r.rows) {
    byName.set(String(m.name || '').trim().toLowerCase(), m.id);
    ids.add(String(m.id));
  }
  return { byName, ids };
}

// Resolve a record's market id from an explicit market_id (validated
// against THIS org — a foreign id resolves to null, never leaks) or from
// its market NAME. Returns null when nothing resolves, which is a valid
// "unassigned" state, not an error: market is additive and nullable.
function resolveMarketId(map, rec) {
  if (!map || !rec) return null;
  const explicit = rec.market_id != null && rec.market_id !== '' ? String(rec.market_id) : null;
  if (explicit) return map.ids.has(explicit) ? explicit : null;
  const name = String(rec.market || '').trim().toLowerCase();
  if (!name) return null;
  return map.byName.get(name) || null;
}

// Resolve + validate a market id for a write. Returns the id when it
// belongs to this org, null when unset. THROWS on a foreign/unknown id so
// a caller can never quietly file a Tampa job under another tenant's market.
async function assertMarketForOrg(marketId, orgId, client) {
  if (marketId === null || marketId === undefined || marketId === '') return null;
  const db = client || pool;
  const r = await db.query(
    'SELECT id FROM markets WHERE id = $1 AND organization_id = $2',
    [marketId, orgId]
  );
  if (!r.rows.length) {
    const err = new Error('Unknown market for this organization');
    err.status = 400;
    throw err;
  }
  return r.rows[0].id;
}

module.exports = {
  DEFAULT_MARKETS, seedMarketsForOrg, backfill, assertMarketForOrg,
  loadMarketMap, resolveMarketId,
};
