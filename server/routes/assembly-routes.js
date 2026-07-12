'use strict';
// Assemblies — costed recipes for estimating. Thin REST layer over
// server/services/assemblies.js (shared with the AI read tool and the
// payload dispatcher's 'assembly' write target). Reads = ESTIMATES_VIEW,
// writes = ESTIMATES_EDIT. Org-scoped like materials.

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireCapability } = require('../auth');
const asm = require('../services/assemblies');

const router = express.Router();

// ── GET /api/assemblies — list with resolved unit costs ──────────────
router.get('/', requireAuth, requireCapability('ESTIMATES_VIEW'), async (req, res) => {
  try {
    const graph = await asm.loadGraph(pool, req.user.organization_id);
    const q = String(req.query.q || '').trim().toLowerCase();
    const showHidden = req.query.show_hidden === '1';
    const out = [];
    for (const a of graph.assemblies.values()) {
      if (a.is_hidden && !showHidden) continue;
      if (q && !((a.name || '') + ' ' + (a.code || '') + ' ' + (a.trade || '')).toLowerCase().includes(q)) continue;
      const cost = asm.resolveCost(a.id, graph);
      out.push({
        id: a.id, code: a.code, name: a.name, description: a.description,
        trade: a.trade, category: a.category, unit: a.unit, source: a.source,
        is_hidden: a.is_hidden, notes: a.notes, updated_at: a.updated_at,
        item_count: (graph.itemsBy.get(a.id) || []).length,
        unit_cost: cost.unitCost, incomplete: cost.incomplete, cycle: cost.cycle,
      });
    }
    out.sort((x, y) => (x.trade || '').localeCompare(y.trade || '') || (x.name || '').localeCompare(y.name || ''));
    res.json({ assemblies: out });
  } catch (e) {
    console.error('GET /api/assemblies error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/assemblies/:id — full recipe + resolved + flattened ─────
router.get('/:id', requireAuth, requireCapability('ESTIMATES_VIEW'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!isFinite(id)) return res.status(400).json({ error: 'Bad id' });
    const graph = await asm.loadGraph(pool, req.user.organization_id);
    const a = graph.assemblies.get(id);
    if (!a) return res.status(404).json({ error: 'Assembly not found' });
    const cost = asm.resolveCost(id, graph);
    res.json({
      assembly: {
        id: a.id, code: a.code, name: a.name, description: a.description,
        trade: a.trade, category: a.category, unit: a.unit, source: a.source,
        is_hidden: a.is_hidden, notes: a.notes, updated_at: a.updated_at,
        unit_cost: cost.unitCost, incomplete: cost.incomplete, cycle: cost.cycle,
      },
      items: (graph.itemsBy.get(id) || []).map(asm.shapeItem),
      // Leaf rows per 1 output unit — the estimate drawer multiplies these
      // by the takeoff qty to explode into lines.
      flat: asm.flatten(id, graph, 1),
    });
  } catch (e) {
    console.error('GET /api/assemblies/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Tuning Center (Console → Cost Intelligence, ROLES_MANAGE) ────────
// GET /tuning/overview — health stats + worst-first queue.
router.get('/tuning/overview', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const orgId = req.user.organization_id;
    const graph = await asm.loadGraph(pool, orgId);
    // Which assemblies have ever been manually tuned (any non-seed log row)?
    const tuned = await pool.query(
      `SELECT assembly_id, MAX(created_at) AS last_at,
              COUNT(*) FILTER (WHERE source <> 'seed') AS manual_rows
         FROM assembly_tuning_log
        WHERE organization_id = $1 OR organization_id IS NULL
        GROUP BY assembly_id`, [orgId]);
    const tunedBy = new Map();
    tuned.rows.forEach((r) => tunedBy.set(r.assembly_id, r));

    const queue = [];
    let seedUntuned = 0, driftCount = 0, unlinkedTotal = 0;
    for (const a of graph.assemblies.values()) {
      if (a.is_hidden) continue;
      const items = graph.itemsBy.get(a.id) || [];
      const cost = asm.resolveCost(a.id, graph);
      let unlinked = 0, drift = 0;
      items.forEach((it) => {
        if (it.kind === 'material' && !it.material_id) unlinked++;
        if (it.kind === 'material' && it.material_id) {
          const live = it.last_unit_price != null ? Number(it.last_unit_price) : null;
          const avg = it.avg_unit_price != null ? Number(it.avg_unit_price) : null;
          if (it.unit_cost != null && live > 0 && Math.abs(Number(it.unit_cost) - live) / live > 0.10) drift++;
          else if (it.unit_cost == null && live > 0 && avg > 0 && Math.abs(live - avg) / avg > 0.10) drift++;
        }
      });
      const t = tunedBy.get(a.id);
      const isSeedUntuned = a.source === 'seed' && !(t && Number(t.manual_rows) > 0);
      if (isSeedUntuned) seedUntuned++;
      if (drift) driftCount++;
      unlinkedTotal += unlinked;
      queue.push({
        id: a.id, code: a.code, name: a.name, trade: a.trade, unit: a.unit,
        source: a.source, unit_cost: cost.unitCost, incomplete: cost.incomplete,
        item_count: items.length,
        flags: { seed_untuned: isSeedUntuned, drift_items: drift, unlinked_items: unlinked },
        last_tuned_at: t ? t.last_at : null,
        // worst-first score: drift is hottest, then seed-untuned, then unlinked
        _score: drift * 100 + (isSeedUntuned ? 40 : 0) + unlinked * 5 + (cost.incomplete ? 30 : 0),
      });
    }
    queue.sort((x, y) => y._score - x._score || (x.name || '').localeCompare(y.name || ''));
    res.json({
      stats: {
        total: queue.length, seed_untuned: seedUntuned, drift: driftCount,
        unlinked_items: unlinkedTotal, suggestions: 0, // flywheel lands in T4
      },
      queue,
    });
  } catch (e) {
    console.error('GET /api/assemblies/tuning/overview error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /:id/tuning — derivation detail: per-item price proofs (purchase
// history), rationale, usage on estimates, and the tuning log.
router.get('/:id/tuning', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!isFinite(id)) return res.status(400).json({ error: 'Bad id' });
    const orgId = req.user.organization_id;
    const graph = await asm.loadGraph(pool, orgId);
    const a = graph.assemblies.get(id);
    if (!a) return res.status(404).json({ error: 'Assembly not found' });
    const cost = asm.resolveCost(id, graph);
    const rawItems = graph.itemsBy.get(id) || [];

    // Price proofs — recent purchase rows per linked material, one query.
    const matIds = rawItems.filter((it) => it.material_id).map((it) => it.material_id);
    const purchasesBy = new Map();
    if (matIds.length) {
      const pq = await pool.query(
        `SELECT material_id, purchase_date, store_number, quantity, unit_price, net_unit_price
           FROM material_purchases
          WHERE material_id = ANY($1::int[]) AND (organization_id = $2 OR organization_id IS NULL)
          ORDER BY purchase_date DESC NULLS LAST`, [matIds, orgId]);
      pq.rows.forEach((r) => {
        if (!purchasesBy.has(r.material_id)) purchasesBy.set(r.material_id, []);
        if (purchasesBy.get(r.material_id).length < 5) purchasesBy.get(r.material_id).push(r);
      });
    }

    const items = rawItems.map((it) => {
      const shaped = asm.shapeItem(it);
      if (it.material_id) {
        const live = it.last_unit_price != null ? Number(it.last_unit_price) : null;
        const avg = it.avg_unit_price != null ? Number(it.avg_unit_price) : null;
        shaped.price_proof = {
          material_id: it.material_id,
          material_description: it.material_description,
          last: live, avg: avg,
          trend_pct: (live != null && avg > 0) ? Math.round(((live - avg) / avg) * 1000) / 10 : null,
          price_mode: it.unit_cost != null ? 'frozen' : 'live',
          purchases: purchasesBy.get(it.material_id) || [],
        };
      }
      if (it.kind === 'assembly' && it.child_assembly_id) {
        const child = graph.assemblies.get(it.child_assembly_id);
        const childCost = asm.resolveCost(it.child_assembly_id, graph);
        shaped.child = child ? { id: child.id, name: child.name, unit: child.unit, unit_cost: childCost.unitCost } : null;
      }
      return shaped;
    });

    // Usage — estimates that quoted this assembly (JSONB scan, same
    // pattern as /api/materials/recent).
    let usage = { estimate_count: 0, quoted_total: 0 };
    try {
      const uq = await pool.query(
        `SELECT e.id, COALESCE(SUM((line->>'qty')::numeric * (line->>'unitCost')::numeric), 0) AS quoted
           FROM estimates e, jsonb_array_elements(COALESCE(e.data->'lines', '[]'::jsonb)) AS line
          WHERE (e.organization_id = $1 OR e.organization_id IS NULL)
            AND (line->>'sourceAssemblyId')::int = $2
          GROUP BY e.id`, [orgId, id]);
      usage.estimate_count = uq.rows.length;
      usage.quoted_total = uq.rows.reduce((s, r) => s + Number(r.quoted || 0), 0);
    } catch (e) { /* usage is best-effort */ }

    const log = await pool.query(
      `SELECT l.item_desc, l.field, l.old_value, l.new_value, l.reason, l.source, l.created_at,
              u.name AS changed_by_name
         FROM assembly_tuning_log l LEFT JOIN users u ON u.id = l.changed_by
        WHERE l.assembly_id = $1
        ORDER BY l.created_at DESC LIMIT 50`, [id]);

    res.json({
      assembly: {
        id: a.id, code: a.code, name: a.name, description: a.description,
        trade: a.trade, unit: a.unit, source: a.source, notes: a.notes,
        unit_cost: cost.unitCost, incomplete: cost.incomplete,
      },
      items, usage, log: log.rows,
    });
  } catch (e) {
    console.error('GET /api/assemblies/:id/tuning error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/assemblies — create (header + optional items) ──────────
router.post('/', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    let id;
    try {
      id = await asm.createAssembly(pool, req.user.organization_id, req.body || {}, req.user.id);
    } catch (ve) {
      return res.status(400).json({ error: ve.message });
    }
    if (Array.isArray(req.body.items) && req.body.items.length) {
      const err = await asm.replaceItems(pool, id, req.body.items, req.user.organization_id);
      if (err) return res.status(400).json({ error: err, id });
    }
    try {
      await asm.logTuning(pool, req.user.organization_id, id,
        [{ field: 'created', new_value: (req.body.name || '') + ' (' + ((req.body.items || []).length) + ' items)' }],
        { userId: req.user.id, source: req.body.source === 'seed' ? 'seed' : 'manual' });
    } catch (e) { /* log only */ }
    res.json({ ok: true, id });
  } catch (e) {
    console.error('POST /api/assemblies error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── PUT /api/assemblies/:id — update header ───────────────────────────
router.put('/:id', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const count = await asm.updateHeader(pool, req.user.organization_id, id, req.body || {});
    if (!count) return res.status(404).json({ error: 'Assembly not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('PUT /api/assemblies/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── PUT /api/assemblies/:id/items — replace the recipe rows ──────────
router.put('/:id/items', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const items = Array.isArray(req.body && req.body.items) ? req.body.items : null;
    if (!items) return res.status(400).json({ error: 'items array required' });
    const err = await asm.replaceItems(pool, id, items, req.user.organization_id,
      { userId: req.user.id, source: 'manual', reason: (req.body.reason || '').slice(0, 500) || null });
    if (err) return res.status(400).json({ error: err });
    res.json({ ok: true });
  } catch (e) {
    console.error('PUT /api/assemblies/:id/items error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── DELETE /api/assemblies/:id — blocked while other recipes nest it ──
router.delete('/:id', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const parents = await pool.query(
      `SELECT DISTINCT a.name FROM assembly_items ai
         JOIN assemblies a ON a.id = ai.assembly_id
        WHERE ai.child_assembly_id = $1`, [id]);
    if (parents.rows.length) {
      return res.status(409).json({
        error: 'Used as a sub-assembly by: ' + parents.rows.map((r) => r.name).join(', ') + '. Remove it there first.',
      });
    }
    const r = await pool.query(
      'DELETE FROM assemblies WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)',
      [id, req.user.organization_id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Assembly not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/assemblies/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
