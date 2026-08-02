// ────────────────────────────────────────────────────────────────
// Markets API (multi-market model, M1).
//
//   GET    /api/markets            list this org's markets (+ counts)
//   POST   /api/markets            create              (admin)
//   PATCH  /api/markets/:id        rename / restyle / retune (admin)
//   DELETE /api/markets/:id        deactivate          (admin)
//
// EVERY query is scoped by req.user.organization_id. Market is an
// OPERATING dimension, never a security boundary — the org check is what
// keeps tenants apart, and it must stay on every statement even though a
// market id also appears. See docs/multi-market.md.
// ────────────────────────────────────────────────────────────────
const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

async function requireAdmin(req, res, next) {
  if (req.user && (req.user.role === 'admin' || req.user.role === 'system_admin')) return next();
  return res.status(403).json({ error: 'Admin only' });
}

// A market is never hard-deleted (jobs point at it and the FK is
// ON DELETE SET NULL — a hard delete would silently orphan history).
// Deactivating hides it from pickers while every existing link survives.

// The optional columns a caller may set, listed ONCE. Create and update
// both build from this, because two hand-maintained field lists is how a
// column ends up settable on PATCH but silently dropped on POST — you
// create a market, the value vanishes, and nothing errors.
//
// name / code / timezone are deliberately absent: they are required and
// validated separately.
const SETTING_FIELDS = [
  'state', 'address', 'phone', 'color', 'sort',
  // identity + compliance (per state, so per market)
  'license_no', 'license_expiry', 'state_registration_no',
  'insurance_carrier', 'insurance_policy_no', 'insurance_expiry',
  'workers_comp_carrier', 'workers_comp_policy_no', 'workers_comp_expiry',
  'bond_carrier', 'bond_amount', 'bond_expiry',
  // money/ops defaults — INERT: nothing reads these yet (see db.js)
  'sales_tax_rate', 'labor_rate_default', 'target_margin_pct',
  'overhead_pct', 'default_markup_pct', 'travel_minimum', 'mobilization_fee',
];

// Empty string from a cleared form field means "unset", not the literal
// "". Without this a blanked DATE input becomes '' and Postgres rejects
// the whole update with a type error the user can't act on.
function normalize(v) {
  if (v === '' || v === undefined) return null;
  return typeof v === 'string' ? v.trim() : v;
}

// GET /api/markets  — ?include_inactive=true to see deactivated ones.
// Returns live job/lead counts so the admin UI can warn before deactivating
// a market that still has work in it.
router.get('/', requireAuth, async (req, res) => {
  try {
    const orgId = req.user.organization_id;
    const includeInactive = String(req.query.include_inactive || '') === 'true';
    const r = await pool.query(
      `SELECT m.*,
              (SELECT COUNT(*) FROM jobs  j WHERE j.market_id = m.id) AS job_count,
              (SELECT COUNT(*) FROM leads l WHERE l.market_id = m.id) AS lead_count
         FROM markets m
        WHERE m.organization_id = $1
          AND ($2::boolean OR m.active)
        ORDER BY m.sort, LOWER(m.name)`,
      [orgId, includeInactive]
    );
    res.json({ markets: r.rows });
  } catch (e) {
    console.error('[markets] GET / error:', e && e.stack || e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const orgId = req.user.organization_id;
    const b = req.body || {};
    const name = String(b.name || '').trim();
    const code = String(b.code || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (!code) return res.status(400).json({ error: 'code is required' });
    // A market without a timezone would silently inherit the org's and fire
    // every cron in the wrong hour — make it explicit, not a default.
    const timezone = String(b.timezone || '').trim();
    if (!timezone) return res.status(400).json({ error: 'timezone is required (IANA, e.g. America/Phoenix)' });
    // Built from SETTING_FIELDS so a new column is settable at CREATE the
    // moment it's added to the list — no second place to forget.
    const cols = ['organization_id', 'name', 'code', 'timezone'];
    const vals = [orgId, name, code, timezone];
    for (const f of SETTING_FIELDS) {
      if (b[f] === undefined) continue;
      cols.push(f);
      vals.push(f === 'sort' ? (normalize(b[f]) ?? 0) : normalize(b[f]));
    }
    const r = await pool.query(
      `INSERT INTO markets (${cols.join(', ')})
            VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')})
         RETURNING *`,
      vals
    );
    res.status(201).json({ market: r.rows[0] });
  } catch (e) {
    if (e && e.code === '23505') {
      return res.status(409).json({ error: 'A market with that name or code already exists' });
    }
    console.error('[markets] POST / error:', e && e.stack || e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const orgId = req.user.organization_id;
    const b = req.body || {};
    const sets = [];
    const params = [];
    let p = 1;
    const FIELDS = ['name', 'code', 'timezone', 'active'].concat(SETTING_FIELDS);
    for (const f of FIELDS) {
      if (b[f] === undefined) continue;
      // Never let a required field be blanked into nothing.
      if ((f === 'name' || f === 'code' || f === 'timezone') && !String(b[f] || '').trim()) {
        return res.status(400).json({ error: f + ' cannot be empty' });
      }
      sets.push(`${f} = $${p++}`);
      // Required fields keep raw trim (they can never be null here, the
      // guard above already rejected empties); optional ones go through
      // normalize so a cleared input becomes NULL rather than ''.
      params.push((f === 'name' || f === 'code' || f === 'timezone' || f === 'active')
        ? (typeof b[f] === 'string' ? b[f].trim() : b[f])
        : normalize(b[f]));
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    sets.push('updated_at = NOW()');
    params.push(req.params.id, orgId);
    const r = await pool.query(
      `UPDATE markets SET ${sets.join(', ')}
        WHERE id = $${p++} AND organization_id = $${p}
        RETURNING *`,
      params
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Market not found' });
    res.json({ market: r.rows[0] });
  } catch (e) {
    if (e && e.code === '23505') {
      return res.status(409).json({ error: 'A market with that name or code already exists' });
    }
    console.error('[markets] PATCH error:', e && e.stack || e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Deactivate (soft). Existing jobs/leads keep pointing at it — we only take
// it out of the pickers. Reactivate via PATCH { active: true }.
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const orgId = req.user.organization_id;
    const r = await pool.query(
      `UPDATE markets SET active = FALSE, updated_at = NOW()
        WHERE id = $1 AND organization_id = $2 RETURNING id, name, active`,
      [req.params.id, orgId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Market not found' });
    res.json({ ok: true, market: r.rows[0] });
  } catch (e) {
    console.error('[markets] DELETE error:', e && e.stack || e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/markets/backfill — re-run the seed + legacy-text mapping and
// REPORT what it did. Idempotent (only fills market_id IS NULL). This exists
// because a boot backfill that swallows its own errors is unverifiable: the
// first deploy looked clean and had in fact mapped nothing.
router.post('/backfill', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await require('../services/markets').backfill();
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[markets] backfill error:', e && e.stack || e);
    res.status(500).json({ error: e && e.message || 'Backfill failed' });
  }
});

module.exports = router;
