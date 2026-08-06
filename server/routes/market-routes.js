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
const { auditLog } = require('../audit');
const registry = require('../services/settings-registry');

const router = express.Router();

// Everything that points at a market.
//
// Two generations coexist: the market_id FK, and a legacy free-text market
// NAME that predates it. A hard delete has to clear BOTH — p86Markets
// .resolve() falls back to the name when market_id is null, so a row with a
// stale name keeps rendering a market that no longer exists.
//
// And the name lives in two different SHAPES: jobs and estimates are
// JSONB-blob tables (data->>'market'); leads and clients have a real column.
// Getting this wrong is not cosmetic — an UPDATE naming a column that isn't
// there aborts the transaction and the delete silently fails.
const MARKET_REFS = [
  { table: 'jobs',      text: 'market', kind: 'jsonb'  },
  { table: 'estimates', text: 'market', kind: 'jsonb'  },
  { table: 'leads',     text: 'market', kind: 'column' },
  { table: 'clients',   text: 'market', kind: 'column' },
  { table: 'subs',      text: null,     kind: null     },
  { table: 'users',     text: null,     kind: null     },
];

// "This row still carries the market's NAME", in whichever shape it lives.
function nameMatchSql(ref, idx) {
  if (!ref.text) return null;
  return ref.kind === 'jsonb'
    ? `LOWER(data->>'${ref.text}') = LOWER($${idx})`
    : `LOWER(${ref.text}) = LOWER($${idx})`;
}

// Count every row bound to this market, by id and by legacy name.
async function marketUsage(orgId, marketId, marketName) {
  const out = { total: 0, by_table: {} };
  for (const ref of MARKET_REFS) {
    const params = [orgId, marketId];
    let sql = `SELECT COUNT(*)::int AS n FROM ${ref.table}
                WHERE organization_id = $1 AND (market_id = $2`;
    if (ref.text && marketName) {
      params.push(marketName);
      sql += ' OR ' + nameMatchSql(ref, 3);
    }
    sql += ')';
    try {
      const r = await pool.query(sql, params);
      const n = (r.rows[0] && r.rows[0].n) || 0;
      if (n) { out.by_table[ref.table] = n; out.total += n; }
    } catch (e) {
      // Surface it rather than silently under-report — a table we can't read
      // is exactly the case where a blind delete would lose data.
      out.by_table[ref.table] = 'unknown';
      console.warn('[markets] usage count failed on', ref.table, '-', e && e.message);
    }
  }
  return out;
}

// GET /api/markets/registry — the field declarations the admin pane and the
// assistant both render from. Read-only and non-sensitive (it is a schema of
// labels and types, not values), so plain requireAuth.
//
// Served from the SAME module the server validates against, so a form can't
// drift from what the API will accept — the usual failure being a field that
// renders, submits, and is silently dropped.
router.get('/registry', requireAuth, (req, res) => {
  res.json({
    scope: 'market',
    title: registry.REGISTRY.market.title,
    describe: registry.REGISTRY.market.describe,
    groups: registry.groupsFor('market'),
    settings: registry.MARKET_SETTINGS,
  });
});

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
// GET /api/markets/:id/usage — what would break if this market went away.
// The delete UI calls this first so the admin sees the blast radius BEFORE
// committing, rather than discovering it afterwards as silently blanked rows.
router.get('/:id/usage', requireAuth, requireAdmin, async (req, res) => {
  try {
    const orgId = req.user.organization_id;
    const m = await pool.query(
      'SELECT id, name FROM markets WHERE id = $1 AND organization_id = $2',
      [req.params.id, orgId]
    );
    if (!m.rows.length) return res.status(404).json({ error: 'Market not found' });
    const usage = await marketUsage(orgId, m.rows[0].id, m.rows[0].name);
    res.json({ market: m.rows[0], usage });
  } catch (e) {
    console.error('[markets] usage error:', e && e.stack || e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/markets/:id
//   default            → deactivate (soft). Existing behaviour, unchanged.
//   ?hard=1            → really remove the row.
//   ?hard=1&reassign_to=<id|none>
//                      → move every attached record first, then remove.
//
// A hard delete of a market that is still in use is REFUSED (409 + the
// counts) unless reassign_to is supplied. The FK is ON DELETE SET NULL, so
// without this guard the delete would "succeed" and quietly strip the market
// off live jobs, leads, estimates and clients with no record of what they had.
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  const orgId = req.user.organization_id;
  const hard = String(req.query.hard || '') === '1';

  if (!hard) {
    try {
      const r = await pool.query(
        `UPDATE markets SET active = FALSE, updated_at = NOW()
          WHERE id = $1 AND organization_id = $2 RETURNING id, name, active`,
        [req.params.id, orgId]
      );
      if (!r.rows.length) return res.status(404).json({ error: 'Market not found' });
      auditLog(req, {
        action: 'market.deactivate', targetType: 'market', targetId: String(r.rows[0].id),
        organizationId: orgId, detail: { name: r.rows[0].name },
      });
      return res.json({ ok: true, market: r.rows[0] });
    } catch (e) {
      console.error('[markets] DELETE(soft) error:', e && e.stack || e);
      return res.status(500).json({ error: 'Server error' });
    }
  }

  const client = await pool.connect();
  try {
    const m = await client.query(
      'SELECT id, name FROM markets WHERE id = $1 AND organization_id = $2',
      [req.params.id, orgId]
    );
    if (!m.rows.length) return res.status(404).json({ error: 'Market not found' });
    const market = m.rows[0];

    const usage = await marketUsage(orgId, market.id, market.name);
    const raw = req.query.reassign_to;
    const wantsReassign = raw !== undefined && raw !== '';
    const toNone = wantsReassign && String(raw) === 'none';
    let target = null;

    if (usage.total > 0 && !wantsReassign) {
      return res.status(409).json({
        error: 'Market is still in use', usage,
        hint: 'Pass reassign_to=<marketId> to move these records, or reassign_to=none to leave them unassigned.',
      });
    }
    if (wantsReassign && !toNone) {
      const t = await client.query(
        'SELECT id, name FROM markets WHERE id = $1 AND organization_id = $2',
        [raw, orgId]
      );
      if (!t.rows.length) return res.status(400).json({ error: 'reassign_to is not a market in this organization' });
      if (String(t.rows[0].id) === String(market.id)) {
        return res.status(400).json({ error: 'Cannot reassign a market to itself' });
      }
      target = t.rows[0];
    }

    await client.query('BEGIN');
    const moved = {};
    for (const ref of MARKET_REFS) {
      // $1 org, $2 this market's id, $3 the new market_id (or NULL)
      const params = [orgId, market.id, target ? target.id : null];
      const sets = ['market_id = $3'];

      if (ref.text) {
        params.push(market.name);                   // $4 — the name to match
        const nameIdx = params.length;
        let newName = null;
        if (target) { params.push(target.name); newName = '$' + params.length; }  // $5
        if (ref.kind === 'jsonb') {
          sets.push(newName
            ? `data = jsonb_set(COALESCE(data,'{}'::jsonb), '{${ref.text}}', to_jsonb(${newName}::text))`
            : `data = COALESCE(data,'{}'::jsonb) - '${ref.text}'`);
        } else {
          sets.push(`${ref.text} = ${newName || 'NULL'}`);
        }
        var whereName = ' OR ' + nameMatchSql(ref, nameIdx);
      }

      let sql = `UPDATE ${ref.table} SET ${sets.join(', ')}
                  WHERE organization_id = $1 AND (market_id = $2`;
      if (ref.text) sql += whereName;
      sql += ')';
      try {
        const r = await client.query(sql, params);
        if (r.rowCount) moved[ref.table] = r.rowCount;
      } catch (e) {
        await client.query('ROLLBACK');
        console.error('[markets] hard-delete reassign failed on', ref.table, e && e.message);
        return res.status(500).json({ error: 'Could not move records off ' + ref.table + ' — nothing was deleted' });
      }
    }
    const del = await client.query(
      'DELETE FROM markets WHERE id = $1 AND organization_id = $2 RETURNING id, name',
      [market.id, orgId]
    );
    if (!del.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Market not found' }); }
    await client.query('COMMIT');

    auditLog(req, {
      action: 'market.delete', targetType: 'market', targetId: String(market.id),
      organizationId: orgId,
      detail: { name: market.name, reassigned_to: target ? target.name : (toNone ? '(unassigned)' : null), moved: moved, usage_before: usage },
    });
    res.json({ ok: true, deleted: del.rows[0], moved: moved, reassigned_to: target || null });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (e2) {}
    console.error('[markets] DELETE(hard) error:', e && e.stack || e);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
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
