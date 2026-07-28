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
  const result = { seeded: 0, jobs: 0, leads: 0, estimates: 0, errors: [] };

  try {
    const orgs = await pool.query('SELECT id FROM organizations');
    for (const row of orgs.rows) {
      await seedMarketsForOrg(row.id);
      result.seeded++;
    }
  } catch (e) {
    result.errors.push('seed: ' + (e && e.message));
  }

  // jobs + leads both carry the legacy `market TEXT`. LOWER(TRIM()) on both
  // sides absorbs 'tampa ' / 'Tampa'. Org-scoped so one tenant's "Tampa"
  // can never claim another's rows.
  for (const table of ['jobs', 'leads']) {
    try {
      const r = await pool.query(
        `UPDATE ${table} t
            SET market_id = m.id
           FROM markets m
          WHERE t.market_id IS NULL
            AND t.market IS NOT NULL
            AND TRIM(t.market) <> ''
            AND m.organization_id = t.organization_id
            AND LOWER(TRIM(m.name)) = LOWER(TRIM(t.market))`
      );
      result[table] = r.rowCount || 0;
    } catch (e) {
      result.errors.push(table + ': ' + (e && e.message));
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

  return result;
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

module.exports = { DEFAULT_MARKETS, seedMarketsForOrg, backfill, assertMarketForOrg };
