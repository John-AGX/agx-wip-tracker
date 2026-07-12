'use strict';
// Assemblies — costed recipes for estimating. An assembly prices one output
// unit of installed work as a bill of items: catalog materials (live-priced
// from the materials table), manual labor/sub/gc rates, and nested child
// assemblies. Reads = ESTIMATES_VIEW, writes = ESTIMATES_EDIT (the builder
// lives with the estimators, not admin). Org-scoped like materials.

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireCapability } = require('../auth');

const router = express.Router();

const KINDS = new Set(['material', 'labor', 'sub', 'gc', 'assembly']);
const COST_CODES = new Set(['materials', 'labor', 'sub', 'gc']);
const SOURCES = new Set(['seed', 'manual', 'learned']);
const MAX_DEPTH = 4;

// Default section-routing cost code per item kind (explicit cost_code wins).
const KIND_DEFAULT_CODE = { material: 'materials', labor: 'labor', sub: 'sub', gc: 'gc' };

const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };

// ── Org graph loader ──────────────────────────────────────────────────
// Pulls every assembly + item for the org in 3 queries so list costing and
// nested resolution never N+1. Material prices ride along for live pricing.
async function loadGraph(orgId) {
  const [aq, iq] = await Promise.all([
    pool.query(
      `SELECT id, code, name, description, trade, category, unit, source, is_hidden, notes, updated_at
         FROM assemblies WHERE organization_id = $1 OR organization_id IS NULL`, [orgId]),
    pool.query(
      `SELECT ai.*, m.description AS material_description, m.unit AS material_unit,
              m.last_unit_price, m.avg_unit_price
         FROM assembly_items ai
         LEFT JOIN materials m ON m.id = ai.material_id
        WHERE ai.assembly_id IN (
          SELECT id FROM assemblies WHERE organization_id = $1 OR organization_id IS NULL)
        ORDER BY ai.assembly_id, ai.sort_order, ai.id`, [orgId]),
  ]);
  const assemblies = new Map();
  aq.rows.forEach((a) => assemblies.set(a.id, a));
  const itemsBy = new Map();
  iq.rows.forEach((it) => {
    if (!itemsBy.has(it.assembly_id)) itemsBy.set(it.assembly_id, []);
    itemsBy.get(it.assembly_id).push(it);
  });
  return { assemblies, itemsBy };
}

// Effective unit cost of one item row (per 1 unit of the item itself).
// Material rows with NULL unit_cost pull the live catalog price.
function itemUnitCost(it) {
  if (it.unit_cost != null) return num(it.unit_cost);
  if (it.kind === 'material') {
    if (it.last_unit_price != null) return num(it.last_unit_price);
    if (it.avg_unit_price != null) return num(it.avg_unit_price);
  }
  return null; // unpriced — surfaced as incomplete, not silently $0
}

// Resolved cost of ONE output unit of assembly `id`. Cycle-safe: a repeat
// visit contributes 0 and flags the result. Returns { unitCost, incomplete,
// cycle } — incomplete = at least one leaf had no price.
function resolveCost(id, graph, seen) {
  seen = seen || new Set();
  if (seen.has(id)) return { unitCost: 0, incomplete: true, cycle: true };
  seen.add(id);
  let total = 0, incomplete = false, cycle = false;
  const items = graph.itemsBy.get(id) || [];
  for (const it of items) {
    const mult = num(it.qty_per_unit) * (1 + num(it.waste_pct) / 100);
    if (it.kind === 'assembly' && it.child_assembly_id) {
      const child = resolveCost(it.child_assembly_id, graph, new Set(seen));
      total += child.unitCost * mult;
      incomplete = incomplete || child.incomplete;
      cycle = cycle || child.cycle;
    } else {
      const uc = itemUnitCost(it);
      if (uc == null) incomplete = true;
      else total += uc * mult;
    }
  }
  return { unitCost: Math.round(total * 100) / 100, incomplete, cycle };
}

// Flatten an assembly to its LEAF rows with the effective qty consumed per
// 1 output unit of the ROOT — this is what the estimate drawer explodes
// into lines (leaf qty × takeoff = line qty).
function flatten(id, graph, mult, seen, out, depth) {
  seen = seen || new Set();
  out = out || [];
  depth = depth || 0;
  if (seen.has(id) || depth > MAX_DEPTH) return out;
  seen.add(id);
  const items = graph.itemsBy.get(id) || [];
  for (const it of items) {
    const rowMult = mult * num(it.qty_per_unit) * (1 + num(it.waste_pct) / 100);
    if (it.kind === 'assembly' && it.child_assembly_id) {
      flatten(it.child_assembly_id, graph, rowMult, new Set(seen), out, depth + 1);
    } else {
      out.push({
        kind: it.kind,
        material_id: it.material_id,
        description: it.description || it.material_description || '',
        unit: it.unit || it.material_unit || 'EA',
        qty_per_unit: Math.round(rowMult * 10000) / 10000,
        unit_cost: itemUnitCost(it),
        cost_code: (COST_CODES.has(it.cost_code) ? it.cost_code : KIND_DEFAULT_CODE[it.kind]) || 'materials',
      });
    }
  }
  return out;
}

// Would adding `childId` under `parentId` create a cycle? Walk the child's
// descendant tree looking for the parent.
function wouldCycle(parentId, childId, graph) {
  if (parentId === childId) return true;
  const stack = [childId];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (cur === parentId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    (graph.itemsBy.get(cur) || []).forEach((it) => {
      if (it.kind === 'assembly' && it.child_assembly_id) stack.push(it.child_assembly_id);
    });
  }
  return false;
}

function shapeItem(it) {
  return {
    id: it.id, sort_order: it.sort_order, kind: it.kind,
    material_id: it.material_id, child_assembly_id: it.child_assembly_id,
    description: it.description || it.material_description || '',
    material_description: it.material_description || null,
    qty_per_unit: num(it.qty_per_unit), unit: it.unit || it.material_unit || '',
    unit_cost: it.unit_cost != null ? num(it.unit_cost) : null,
    live_unit_cost: itemUnitCost(it),
    cost_code: it.cost_code || KIND_DEFAULT_CODE[it.kind] || 'materials',
    waste_pct: num(it.waste_pct), notes: it.notes || '',
  };
}

// ── GET /api/assemblies — list with resolved unit costs ──────────────
router.get('/', requireAuth, requireCapability('ESTIMATES_VIEW'), async (req, res) => {
  try {
    const graph = await loadGraph(req.user.organization_id);
    const q = String(req.query.q || '').trim().toLowerCase();
    const showHidden = req.query.show_hidden === '1';
    const out = [];
    for (const a of graph.assemblies.values()) {
      if (a.is_hidden && !showHidden) continue;
      if (q && !((a.name || '') + ' ' + (a.code || '') + ' ' + (a.trade || '')).toLowerCase().includes(q)) continue;
      const cost = resolveCost(a.id, graph);
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
    const graph = await loadGraph(req.user.organization_id);
    const a = graph.assemblies.get(id);
    if (!a) return res.status(404).json({ error: 'Assembly not found' });
    const cost = resolveCost(id, graph);
    res.json({
      assembly: {
        id: a.id, code: a.code, name: a.name, description: a.description,
        trade: a.trade, category: a.category, unit: a.unit, source: a.source,
        is_hidden: a.is_hidden, notes: a.notes, updated_at: a.updated_at,
        unit_cost: cost.unitCost, incomplete: cost.incomplete, cycle: cost.cycle,
      },
      items: (graph.itemsBy.get(id) || []).map(shapeItem),
      // Leaf rows per 1 output unit — the estimate drawer multiplies these
      // by the takeoff qty to explode into lines.
      flat: flatten(id, graph, 1),
    });
  } catch (e) {
    console.error('GET /api/assemblies/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

function pickHeader(body) {
  const out = {};
  ['code', 'name', 'description', 'trade', 'category', 'unit', 'notes'].forEach((k) => {
    if (body[k] !== undefined) out[k] = body[k] === null ? null : String(body[k]).slice(0, 500);
  });
  if (body.source !== undefined && SOURCES.has(body.source)) out.source = body.source;
  if (body.is_hidden !== undefined) out.is_hidden = !!body.is_hidden;
  return out;
}

// ── POST /api/assemblies — create (header + optional items) ──────────
router.post('/', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const h = pickHeader(req.body || {});
    if (!h.name || !String(h.name).trim()) return res.status(400).json({ error: 'name is required' });
    const r = await pool.query(
      `INSERT INTO assemblies (organization_id, code, name, description, trade, category, unit, source, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [req.user.organization_id, h.code || null, h.name.trim(), h.description || null,
       h.trade || null, h.category || null, h.unit || 'EA', h.source || 'manual',
       h.notes || null, req.user.id]
    );
    const id = r.rows[0].id;
    if (Array.isArray(req.body.items) && req.body.items.length) {
      const err = await replaceItems(id, req.body.items, req.user.organization_id);
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
    const h = pickHeader(req.body || {});
    const keys = Object.keys(h);
    if (!keys.length) return res.json({ ok: true });
    const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const vals = keys.map((k) => h[k]);
    const r = await pool.query(
      `UPDATE assemblies SET ${sets}, updated_at = NOW()
        WHERE id = $${keys.length + 1} AND (organization_id = $${keys.length + 2} OR organization_id IS NULL)`,
      [...vals, id, req.user.organization_id]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Assembly not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('PUT /api/assemblies/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Shared item-array validator + writer (full replace — the editor saves the
// whole recipe). Returns an error string or null on success.
async function replaceItems(assemblyId, items, orgId) {
  const graph = await loadGraph(orgId);
  if (!graph.assemblies.get(assemblyId)) return 'Assembly not found';
  for (const it of items) {
    const kind = String(it.kind || 'material');
    if (!KINDS.has(kind)) return `Bad kind "${kind}"`;
    if (kind === 'assembly') {
      const cid = parseInt(it.child_assembly_id, 10);
      if (!isFinite(cid) || !graph.assemblies.get(cid)) return 'child_assembly_id missing or not in your org';
      if (wouldCycle(assemblyId, cid, graph)) return 'That nesting would create a cycle';
    }
    if (kind === 'material' && it.material_id != null) {
      const mid = parseInt(it.material_id, 10);
      const m = await pool.query(
        'SELECT 1 FROM materials WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)',
        [mid, orgId]);
      if (!m.rows.length) return 'material_id not found in your catalog';
    }
    if (it.cost_code != null && it.cost_code !== '' && !COST_CODES.has(it.cost_code)) return `Bad cost_code "${it.cost_code}"`;
  }
  await pool.query('DELETE FROM assembly_items WHERE assembly_id = $1', [assemblyId]);
  let sort = 0;
  for (const it of items) {
    const kind = String(it.kind || 'material');
    await pool.query(
      `INSERT INTO assembly_items
        (assembly_id, sort_order, kind, material_id, child_assembly_id, description,
         qty_per_unit, unit, unit_cost, cost_code, waste_pct, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [assemblyId, sort++, kind,
       kind === 'material' && it.material_id != null ? parseInt(it.material_id, 10) : null,
       kind === 'assembly' ? parseInt(it.child_assembly_id, 10) : null,
       it.description != null ? String(it.description).slice(0, 500) : null,
       num(it.qty_per_unit) || 1,
       it.unit != null ? String(it.unit).slice(0, 20) : null,
       it.unit_cost != null && it.unit_cost !== '' ? num(it.unit_cost) : null,
       COST_CODES.has(it.cost_code) ? it.cost_code : (KIND_DEFAULT_CODE[kind] || 'materials'),
       num(it.waste_pct) || 0,
       it.notes != null ? String(it.notes).slice(0, 500) : null]
    );
  }
  await pool.query('UPDATE assemblies SET updated_at = NOW() WHERE id = $1', [assemblyId]);
  return null;
}

// ── PUT /api/assemblies/:id/items — replace the recipe rows ──────────
router.put('/:id/items', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const items = Array.isArray(req.body && req.body.items) ? req.body.items : null;
    if (!items) return res.status(400).json({ error: 'items array required' });
    const err = await replaceItems(id, items, req.user.organization_id);
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
