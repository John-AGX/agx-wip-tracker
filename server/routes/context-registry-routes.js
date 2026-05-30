// Wave 1.B — Context Registry admin endpoints.
//
// Reads from context_load_events (the cross-layer observation table)
// and joins to the source tables (ai_memories, etc.) for "what's
// stale" queries — i.e. items that EXIST in their layer but have NOT
// appeared in context_load_events recently.
//
// All endpoints require ROLES_MANAGE — mirrors the admin-agents
// gate. These are observation-only reads; they never mutate.
//
// Endpoints:
//   GET /api/admin/context-registry/summary?days=7
//        Aggregate rollup per layer (load_count, distinct_items,
//        top items by frequency).
//   GET /api/admin/context-registry/items?layer=memory&days=30&limit=50
//        Recent event list filtered by layer. Joins user email for
//        the actor column.
//   GET /api/admin/context-registry/stale?layer=memory&days=30
//        Items that exist in their source table but did NOT load
//        in the last N days. The "what to prune" view.
//   GET /api/admin/context-registry/item/:layer/:itemId/timeline?days=90
//        Per-item event timeline. For drilling into one memory or
//        entity to see its load pattern.

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireCapability } = require('../auth');

const router = express.Router();

// All endpoints below require auth + ROLES_MANAGE.
router.use(requireAuth);
router.use(requireCapability('ROLES_MANAGE'));

// Helpers
function clampDays(raw, def) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(365, Math.max(1, Math.floor(n)));
}
function clampLimit(raw, def) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(500, Math.max(1, Math.floor(n)));
}

// GET /summary — load_count + distinct_items + top items per layer.
router.get('/summary', async (req, res) => {
  const days = clampDays(req.query.days, 7);
  const orgId = req.user.organization_id;
  try {
    // Layer-level rollup.
    const layerRollup = await pool.query(`
      SELECT layer,
             COUNT(*)::int AS load_count,
             COUNT(DISTINCT item_id)::int AS distinct_items,
             MAX(loaded_at) AS most_recent_load
        FROM context_load_events
       WHERE organization_id = $1
         AND loaded_at >= NOW() - ($2 || ' days')::interval
       GROUP BY layer
       ORDER BY load_count DESC
    `, [orgId, days]);

    // Top 5 items per layer — one query with window function.
    const topItems = await pool.query(`
      WITH ranked AS (
        SELECT layer, item_id, item_name,
               COUNT(*)::int AS load_count,
               MAX(loaded_at) AS last_loaded,
               ROW_NUMBER() OVER (PARTITION BY layer ORDER BY COUNT(*) DESC) AS rk
          FROM context_load_events
         WHERE organization_id = $1
           AND loaded_at >= NOW() - ($2 || ' days')::interval
           AND item_id IS NOT NULL
         GROUP BY layer, item_id, item_name
      )
      SELECT layer, item_id, item_name, load_count, last_loaded
        FROM ranked
       WHERE rk <= 5
       ORDER BY layer, load_count DESC
    `, [orgId, days]);

    // Merge top_items into the layer rollup.
    const itemsByLayer = {};
    for (const r of topItems.rows) {
      if (!itemsByLayer[r.layer]) itemsByLayer[r.layer] = [];
      itemsByLayer[r.layer].push({
        item_id: r.item_id,
        item_name: r.item_name,
        load_count: r.load_count,
        last_loaded: r.last_loaded
      });
    }

    res.json({
      window_days: days,
      layers: layerRollup.rows.map(row => ({
        layer: row.layer,
        load_count: row.load_count,
        distinct_items: row.distinct_items,
        most_recent_load: row.most_recent_load,
        top_items: itemsByLayer[row.layer] || []
      }))
    });
  } catch (err) {
    console.error('[context-registry] summary failed:', err.message);
    res.status(500).json({ error: 'Failed to compute summary' });
  }
});

// GET /items — recent event list filtered by layer.
router.get('/items', async (req, res) => {
  const days = clampDays(req.query.days, 7);
  const limit = clampLimit(req.query.limit, 100);
  const layer = req.query.layer ? String(req.query.layer).toLowerCase() : null;
  const orgId = req.user.organization_id;
  try {
    const params = [orgId, days, limit];
    let layerFilter = '';
    if (layer) {
      params.push(layer);
      layerFilter = `AND e.layer = $${params.length}`;
    }
    const r = await pool.query(`
      SELECT e.id, e.layer, e.item_id, e.item_name, e.item_meta,
             e.loaded_at, e.user_id,
             u.email AS user_email
        FROM context_load_events e
        LEFT JOIN users u ON u.id = e.user_id
       WHERE e.organization_id = $1
         AND e.loaded_at >= NOW() - ($2 || ' days')::interval
         ${layerFilter}
       ORDER BY e.loaded_at DESC
       LIMIT $3
    `, params);
    res.json({
      window_days: days,
      layer: layer,
      events: r.rows
    });
  } catch (err) {
    console.error('[context-registry] items failed:', err.message);
    res.status(500).json({ error: 'Failed to list items' });
  }
});

// GET /stale — items registered in their source table but NOT loaded
// in the last N days. The "what to prune" view. Per-layer logic differs
// because each layer's source table is different.
router.get('/stale', async (req, res) => {
  const days = clampDays(req.query.days, 30);
  const layer = req.query.layer ? String(req.query.layer).toLowerCase() : 'memory';
  const orgId = req.user.organization_id;
  try {
    if (layer === 'memory') {
      // Memories that exist (not archived) but have no load events
      // in the last N days. Includes "never recalled" memories.
      // Uses NOT EXISTS for the staleness predicate (cleaner than
      // GROUP BY + HAVING when the only aggregate is the existence
      // check itself).
      const r = await pool.query(`
        SELECT m.id, m.topic, m.kind, m.scope, m.importance,
               m.last_recalled_at, m.created_at, m.updated_at,
               (SELECT MAX(loaded_at) FROM context_load_events e
                 WHERE e.organization_id = m.organization_id
                   AND e.layer = 'memory'
                   AND e.item_id = m.id) AS last_load_event
          FROM ai_memories m
         WHERE m.organization_id = $1
           AND m.archived_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM context_load_events e
              WHERE e.organization_id = m.organization_id
                AND e.layer = 'memory'
                AND e.item_id = m.id
                AND e.loaded_at >= NOW() - ($2 || ' days')::interval
           )
         ORDER BY COALESCE(m.last_recalled_at, m.created_at) ASC
         LIMIT 200
      `, [orgId, days]);
      res.json({ layer: 'memory', window_days: days, stale_items: r.rows });
      return;
    }
    if (layer === 'skill') {
      // Skill packs that exist but didn't appear in load events in N
      // days. Skills don't have a dedicated load instrument yet (Wave
      // 1.B Phase 2 — Anthropic doesn't report skill attach), so for
      // now this returns all active skills.
      const r = await pool.query(`
        SELECT id, name, description, category, created_at, updated_at
          FROM org_skill_packs
         WHERE organization_id = $1
           AND archived_at IS NULL
         ORDER BY created_at ASC
      `, [orgId]);
      res.json({
        layer: 'skill',
        window_days: days,
        stale_items: r.rows,
        note: 'Skill attach instrumentation pending — returns all active skills for now.'
      });
      return;
    }
    res.status(400).json({ error: 'Unsupported layer for stale check: ' + layer });
  } catch (err) {
    console.error('[context-registry] stale failed:', err.message);
    res.status(500).json({ error: 'Failed to compute stale items' });
  }
});

// GET /item/:layer/:itemId/timeline — per-item event series.
router.get('/item/:layer/:itemId/timeline', async (req, res) => {
  const days = clampDays(req.query.days, 90);
  const layer = String(req.params.layer).toLowerCase();
  const itemId = String(req.params.itemId);
  const orgId = req.user.organization_id;
  try {
    const r = await pool.query(`
      SELECT e.id, e.loaded_at, e.user_id, e.item_meta,
             u.email AS user_email
        FROM context_load_events e
        LEFT JOIN users u ON u.id = e.user_id
       WHERE e.organization_id = $1
         AND e.layer = $2
         AND e.item_id = $3
         AND e.loaded_at >= NOW() - ($4 || ' days')::interval
       ORDER BY e.loaded_at DESC
       LIMIT 500
    `, [orgId, layer, itemId, days]);
    res.json({ layer, item_id: itemId, window_days: days, events: r.rows });
  } catch (err) {
    console.error('[context-registry] timeline failed:', err.message);
    res.status(500).json({ error: 'Failed to compute timeline' });
  }
});

module.exports = router;
