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
    const err = await asm.replaceItems(pool, id, items, req.user.organization_id);
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
