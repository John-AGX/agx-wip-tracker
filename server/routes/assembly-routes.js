'use strict';
// Assemblies — costed recipes for estimating. Thin REST layer over
// server/services/assemblies.js (shared with the AI read tool and the
// payload dispatcher's 'assembly' write target). Reads = ESTIMATES_VIEW,
// writes = ESTIMATES_EDIT. Org-scoped like materials.

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireCapability } = require('../auth');
const asm = require('../services/assemblies');
const matSvc = require('../services/materials'); // createResearchedMaterial + findSizedSibling (variant spin)

const router = express.Router();

// Swap a size token in a material description for variant auto-create
// (e.g. "2x6 PT board", "2X6" → "2X8" ⇒ "2x8 PT board"; append if absent).
function sizedSwapDescription(desc, oldSize, newSize) {
  var d = String(desc || '');
  if (oldSize) {
    var re = new RegExp(String(oldSize).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    if (re.test(d)) return d.replace(re, newSize);
  }
  return (d + ' ' + newSize).trim();
}

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
      const pdefs = asm.paramDefs(a);
      const aItems = graph.itemsBy.get(a.id) || [];
      out.push({
        id: a.id, code: a.code, name: a.name, description: a.description,
        trade: a.trade, system: a.system, variant: a.variant,
        category: a.category, unit: a.unit, source: a.source,
        is_hidden: a.is_hidden, notes: a.notes, updated_at: a.updated_at,
        item_count: aItems.length,
        unit_cost: cost.unitCost, incomplete: cost.incomplete, cycle: cost.cycle,
        params: pdefs.length ? pdefs : null,
        // Formula-only recipes (no declared params, formulas on Q alone)
        // must ALSO route through the parametric insert path.
        has_formulas: aItems.some((it) => !!it.qty_formula),
      });
    }
    out.sort((x, y) => (x.trade || '').localeCompare(y.trade || '') || (x.name || '').localeCompare(y.name || ''));
    res.json({ assemblies: out });
  } catch (e) {
    console.error('GET /api/assemblies error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/assemblies/suggest-code — canonical code for parts + availability
// (must be declared before /:id so it isn't captured as an id).
router.get('/suggest-code', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const header = { trade: req.query.trade, system: req.query.system, variant: req.query.variant };
    const v = await asm.validateAgainstRegistry(pool, req.user.organization_id, header, {});
    res.json({ code: v.code || null, available: !!v.ok, error: v.ok ? null : v.error });
  } catch (e) {
    console.error('GET /api/assemblies/suggest-code error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/assemblies/link-audit — every recipe row with NO catalog
// material linked (kind='material' && material_id IS NULL), grouped by
// assembly, each with up to 5 fuzzy-matched catalog suggestions. The
// worklist for driving the library to zero unlinked rows. Read-only.
// (Declared before /:id so it isn't captured as an id.)
router.get('/link-audit', requireAuth, requireCapability('ESTIMATES_VIEW'), async (req, res) => {
  try {
    const orgId = req.user.organization_id;
    const graph = await asm.loadGraph(pool, orgId);
    // Load the org catalog ONCE for in-JS fuzzy suggestions (no N queries).
    const mq = await pool.query(
      `SELECT id, description, unit, last_unit_price, agx_subgroup, price_basis
         FROM materials
        WHERE (organization_id = $1 OR organization_id IS NULL) AND is_hidden = false`, [orgId]);
    const catalog = mq.rows;
    const tokenize = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
    const catTokens = catalog.map((m) => ({ m, t: new Set(tokenize(m.description)) }));
    function suggest(desc) {
      const qt = tokenize(desc);
      if (!qt.length) return [];
      return catTokens.map((c) => {
        let hits = 0; qt.forEach((w) => { if (c.t.has(w)) hits++; });
        return { m: c.m, score: hits };
      }).filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map((x) => ({ id: x.m.id, description: x.m.description, unit: x.m.unit, last_unit_price: x.m.last_unit_price, price_basis: x.m.price_basis }));
    }
    const out = [];
    let unlinkedRows = 0;
    for (const a of graph.assemblies.values()) {
      if (a.is_hidden) continue;
      const items = graph.itemsBy.get(a.id) || [];
      const gaps = items.filter((it) => it.kind === 'material' && it.material_id == null)
        .map((it) => {
          unlinkedRows++;
          const desc = it.description || '';
          return { item_id: it.id, description: desc, cost_code: it.cost_code || 'materials', suggestions: suggest(desc) };
        });
      if (!gaps.length) continue;
      const cost = asm.resolveCost(a.id, graph);
      out.push({ id: a.id, code: a.code, name: a.name, unit: a.unit, unit_cost: cost.unitCost, incomplete: cost.incomplete, gaps });
    }
    out.sort((x, y) => y.gaps.length - x.gaps.length);
    res.json({ assemblies: out, totals: { assemblies_with_gaps: out.length, unlinked_rows: unlinkedRows } });
  } catch (e) {
    console.error('GET /api/assemblies/link-audit error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/assemblies/:id/link-item — link ONE recipe row to a catalog
// material by item id. Targeted single-row UPDATE (no full-replace race);
// org-verified on BOTH the item's assembly and the material. Returns the
// repriced unit cost so the worklist can show the before→after delta.
router.post('/:id/link-item', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const itemId = parseInt((req.body && req.body.item_id), 10);
    const materialId = parseInt((req.body && req.body.material_id), 10);
    if (!isFinite(id) || !isFinite(itemId) || !isFinite(materialId)) {
      return res.status(400).json({ error: 'id, item_id and material_id are required' });
    }
    const orgId = req.user.organization_id;
    const aq = await pool.query('SELECT 1 FROM assemblies WHERE id=$1 AND (organization_id=$2 OR organization_id IS NULL)', [id, orgId]);
    if (!aq.rows.length) return res.status(404).json({ error: 'Assembly not found' });
    const mq = await pool.query('SELECT 1 FROM materials WHERE id=$1 AND (organization_id=$2 OR organization_id IS NULL)', [materialId, orgId]);
    if (!mq.rows.length) return res.status(400).json({ error: 'material_id not in your catalog' });
    // Only a material-kind row that belongs to this assembly can be linked.
    const upd = await pool.query(
      `UPDATE assembly_items SET material_id=$1 WHERE id=$2 AND assembly_id=$3 AND kind='material' RETURNING id`,
      [materialId, itemId, id]);
    if (!upd.rows.length) return res.status(404).json({ error: 'Recipe row not found (or not a material row)' });
    await pool.query('UPDATE assemblies SET updated_at=NOW() WHERE id=$1', [id]);
    const graph = await asm.loadGraph(pool, orgId);
    const cost = asm.resolveCost(id, graph);
    res.json({ ok: true, unit_cost: cost.unitCost, incomplete: cost.incomplete });
  } catch (e) {
    console.error('POST /api/assemblies/:id/link-item error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/assemblies/bulk — create many assemblies at once, each through
// the SAME validation funnel (createAssembly + replaceItems). Each row is its
// OWN transaction so one failure can't roll back the rest — returns per-row
// { ok, id, code, unit_cost, incomplete } or { ok:false, error }. Body:
// { assemblies: [{ header, items }] }. The vehicle for loading a whole cluster
// (e.g. Cluster A re-roof) fast. (Declared before /:id.)
router.post('/bulk', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const orgId = req.user.organization_id;
    const rows = (req.body && Array.isArray(req.body.assemblies)) ? req.body.assemblies : null;
    if (!rows || !rows.length) return res.status(400).json({ error: 'assemblies[] is required' });
    if (rows.length > 200) return res.status(400).json({ error: 'Too many at once (max 200)' });
    const results = [];
    for (const row of rows) {
      const name = (row && row.header && row.header.name) || null;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const id = await asm.createAssembly(client, orgId, row.header || {}, req.user.id);
        const err = await asm.replaceItems(client, id, Array.isArray(row.items) ? row.items : [], orgId);
        if (err) { await client.query('ROLLBACK'); results.push({ ok: false, name, error: err }); continue; }
        await client.query('COMMIT');
        results.push({ ok: true, id, name });
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        results.push({ ok: false, name, error: e.message || 'create failed' });
      } finally { client.release(); }
    }
    // Reprice every created assembly in a single graph pass.
    const graph = await asm.loadGraph(pool, orgId);
    results.forEach((r) => {
      if (r.ok && r.id) { const c = asm.resolveCost(r.id, graph); const a = graph.assemblies.get(r.id); r.code = a ? a.code : null; r.unit_cost = c.unitCost; r.incomplete = c.incomplete; }
    });
    res.json({ ok: true, results, created: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
  } catch (e) {
    console.error('POST /api/assemblies/bulk error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/assemblies/:id/spin-variants — clone a base assembly into one or
// more SIZE variants, re-linking the sized material row per target. The base
// stays read-only. Body: { sized_item_id, variants: [{ variant, target_size, name? }] }.
// Per variant (own txn): copy header (new variant → new canonical code) + items;
// on the sized row, findSizedSibling(target_size) → swap material_id, else
// auto-create a researched sized material (no price yet → the variant reads
// incomplete until priced — never a silent $0) and link it. Returns per-variant
// { ok, id, code, unit_cost, incomplete, sized_material } or { ok:false, error }.
router.post('/:id/spin-variants', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const baseId = parseInt(req.params.id, 10);
    const sizedItemId = parseInt((req.body && req.body.sized_item_id), 10);
    const variants = (req.body && Array.isArray(req.body.variants)) ? req.body.variants : null;
    if (!isFinite(baseId) || !variants || !variants.length) return res.status(400).json({ error: 'variants[] is required' });
    if (variants.length > 50) return res.status(400).json({ error: 'Too many variants at once (max 50)' });
    const orgId = req.user.organization_id;
    const graph = await asm.loadGraph(pool, orgId);
    const base = graph.assemblies.get(baseId);
    if (!base) return res.status(404).json({ error: 'Base assembly not found' });
    const baseItems = graph.itemsBy.get(baseId) || [];
    const sizedRow = isFinite(sizedItemId) ? baseItems.find((it) => it.id === sizedItemId) : null;
    let baseSizedMaterial = null;
    if (sizedRow && sizedRow.material_id) {
      const mq = await pool.query('SELECT * FROM materials WHERE id=$1', [sizedRow.material_id]);
      baseSizedMaterial = mq.rows[0] || null;
    }
    const results = [];
    for (const v of variants) {
      const variantCode = String((v && (v.variant || v.target_size)) || '').trim();
      const targetSize = String((v && (v.target_size || v.variant)) || '').trim();
      if (!variantCode) { results.push({ ok: false, error: 'variant is required' }); continue; }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        let sizedMaterialId = sizedRow ? sizedRow.material_id : null;
        let sizedMaterialNote = null;
        if (sizedRow && baseSizedMaterial) {
          const sib = await matSvc.findSizedSibling(client, orgId, baseSizedMaterial, targetSize);
          if (sib) { sizedMaterialId = sib.id; sizedMaterialNote = { id: sib.id, description: sib.description, created: false }; }
          else {
            const swappedDesc = sizedSwapDescription(baseSizedMaterial.description, baseSizedMaterial.size_nominal, targetSize);
            const cr = await matSvc.createResearchedMaterial(client, orgId, {
              description: swappedDesc, unit: baseSizedMaterial.unit, agx_subgroup: baseSizedMaterial.agx_subgroup,
              size_nominal: targetSize,
              price_rationale: 'Auto-created for the ' + variantCode + ' variant of ' + base.name + ' — set a real price.'
            }, req.user.id);
            if (cr.material) { sizedMaterialId = cr.material.id; sizedMaterialNote = { id: cr.material.id, description: cr.material.description, created: cr.created }; }
          }
        }
        const header = {
          name: (v.name && String(v.name).trim()) || (base.name + ' — ' + variantCode),
          trade: base.trade, system: base.system, variant: variantCode,
          unit: base.unit, description: base.description, source: 'manual', params: base.params
        };
        const newId = await asm.createAssembly(client, orgId, header, req.user.id);
        const items = baseItems.map((it) => ({
          kind: it.kind,
          material_id: (sizedRow && it.id === sizedRow.id) ? sizedMaterialId : it.material_id,
          child_assembly_id: it.child_assembly_id, description: it.description,
          qty_per_unit: it.qty_per_unit, unit: it.unit, unit_cost: it.unit_cost,
          cost_code: it.cost_code, waste_pct: it.waste_pct, qty_formula: it.qty_formula, rationale: it.rationale
        }));
        const err = await asm.replaceItems(client, newId, items, orgId);
        if (err) { await client.query('ROLLBACK'); results.push({ ok: false, variant: variantCode, error: err }); continue; }
        await client.query('COMMIT');
        results.push({ ok: true, id: newId, variant: variantCode, sized_material: sizedMaterialNote });
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        results.push({ ok: false, variant: variantCode, error: e.message || 'spin failed' });
      } finally { client.release(); }
    }
    const g2 = await asm.loadGraph(pool, orgId);
    results.forEach((r) => {
      if (r.ok && r.id) { const c = asm.resolveCost(r.id, g2); const a = g2.assemblies.get(r.id); r.code = a ? a.code : null; r.unit_cost = c.unitCost; r.incomplete = c.incomplete; }
    });
    res.json({ ok: true, results, created: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
  } catch (e) {
    console.error('POST /api/assemblies/:id/spin-variants error:', e);
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
        trade: a.trade, system: a.system, variant: a.variant,
        category: a.category, unit: a.unit, source: a.source,
        is_hidden: a.is_hidden, notes: a.notes, updated_at: a.updated_at,
        unit_cost: cost.unitCost, incomplete: cost.incomplete, cycle: cost.cycle,
        params: (function () { const p = asm.paramDefs(a); return p.length ? p : null; })(),
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

// ── POST /api/assemblies/:id/explode — parametric quantities (S0) ────
// Body: { params: { Q: 100, H: 6, ... } }. Q = takeoff qty in the output
// unit; declared params default from the assembly. Returns FINAL leaf rows
// (qty already computed — nothing left to multiply), the priced total, and
// any formula errors (never silently $0).
router.post('/:id/explode', requireAuth, requireCapability('ESTIMATES_VIEW'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!isFinite(id)) return res.status(400).json({ error: 'Bad id' });
    const graph = await asm.loadGraph(pool, req.user.organization_id);
    const a = graph.assemblies.get(id);
    if (!a) return res.status(404).json({ error: 'Assembly not found' });
    const scope = asm.paramScope(a, (req.body && req.body.params) || {});
    const r = asm.explodeParametric(id, graph, scope);
    let total = 0, incomplete = false;
    r.rows.forEach((row) => {
      if (row.unit_cost == null) incomplete = true;
      else total += row.qty * row.unit_cost;
    });
    res.json({
      ok: true,
      rows: r.rows,
      errors: r.errors,
      warnings: r.warnings || [],
      total: Math.round(total * 100) / 100,
      incomplete,
      params_used: scope,
    });
  } catch (e) {
    console.error('POST /api/assemblies/:id/explode error:', e);
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

    // Usage — every estimate that quoted this assembly, with the
    // inserted price vs today's resolved cost (= per-estimate drift).
    // Rollup lines (they carry assemblyBreakdown) are refreshable;
    // exploded lines are line-level edited and never touched.
    let usage = { estimate_count: 0, quoted_total: 0, estimates: [] };
    try {
      const uq = await pool.query(
        `SELECT e.id, e.data->>'title' AS title, e.is_locked, e.approval_status,
                COALESCE(SUM((line->>'qty')::numeric * (line->>'unitCost')::numeric), 0) AS quoted,
                COUNT(*)::int AS line_count,
                COUNT(*) FILTER (WHERE line ? 'assemblyBreakdown')::int AS rollup_count,
                json_agg(json_build_object('bucket', line->>'assemblyBucket', 'uc', (line->>'unitCost')::numeric))
                  FILTER (WHERE line ? 'assemblyBreakdown') AS rollup_lines
           FROM estimates e, jsonb_array_elements(COALESCE(e.data->'lines', '[]'::jsonb)) AS line
          WHERE (e.organization_id = $1 OR e.organization_id IS NULL)
            AND (line->>'sourceAssemblyId')::int = $2
          GROUP BY e.id, e.data->>'title', e.is_locked, e.approval_status
          ORDER BY MAX(e.updated_at) DESC NULLS LAST`, [orgId, id]);
      usage.estimate_count = uq.rows.length;
      usage.quoted_total = uq.rows.reduce((s, r) => s + Number(r.quoted || 0), 0);
      usage.estimates = uq.rows.map((r) => {
        // Inserted price per output unit. Legacy full-rollup lines: avg
        // their unitCost. Split-bucket lines (assemblyBucket): avg per
        // bucket then SUM the buckets — that reconstructs one full
        // insert's unit cost even when the assembly was inserted as 4
        // per-section lines (or inserted more than once).
        const rl = Array.isArray(r.rollup_lines) ? r.rollup_lines : [];
        let ins = null;
        const full = rl.filter((x) => !x.bucket);
        if (full.length) {
          ins = full.reduce((s, x) => s + Number(x.uc || 0), 0) / full.length;
        } else if (rl.length) {
          const by = {};
          rl.forEach((x) => { (by[x.bucket] = by[x.bucket] || []).push(Number(x.uc || 0)); });
          ins = Object.keys(by).reduce((s, k) => s + by[k].reduce((a, b) => a + b, 0) / by[k].length, 0);
        }
        if (ins != null) ins = Math.round(ins * 10000) / 10000;
        const cur = cost.unitCost;
        return {
          id: r.id, title: r.title || '(untitled)', is_locked: !!r.is_locked,
          approval_status: r.approval_status || null,
          quoted: Number(r.quoted || 0), line_count: r.line_count,
          rollup_count: r.rollup_count,
          inserted_unit_cost: ins,
          drift_pct: (ins != null && ins > 0 && cur != null)
            ? Math.round(((cur - ins) / ins) * 1000) / 10 : null,
          refreshable: !r.is_locked && r.rollup_count > 0,
        };
      });
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

// ── POST /:id/refresh-estimates — reprice rollup lines from the recipe ─
// Body: { estimate_ids: [], reason? }. For each selected estimate (org-
// scoped, NOT locked): every line with sourceAssemblyId = :id AND an
// assemblyBreakdown snapshot gets unitCost = today's resolved cost and a
// fresh component snapshot. Exploded lines are line-level edited and are
// never touched. Locked (sold) estimates are hard-skipped.
router.post('/:id/refresh-estimates', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const ids = Array.isArray(req.body && req.body.estimate_ids) ? req.body.estimate_ids.map(String) : [];
    if (!isFinite(id) || !ids.length) return res.status(400).json({ error: 'estimate_ids required' });
    const orgId = req.user.organization_id;
    const graph = await asm.loadGraph(pool, orgId);
    const a = graph.assemblies.get(id);
    if (!a) return res.status(404).json({ error: 'Assembly not found' });
    const cost = asm.resolveCost(id, graph);
    const flat = asm.flatten(id, graph, 1);
    // Split rollup lines carry assemblyBucket — reprice each from its own
    // bucket's slice of the recipe (waste already folded into qty_per_unit).
    const bucketRows = {};
    const bucketCost = {};
    flat.forEach((f) => {
      const code = f.cost_code || 'materials';
      (bucketRows[code] = bucketRows[code] || []).push(f);
      bucketCost[code] = (bucketCost[code] || 0) + (Number(f.qty_per_unit) || 0) * (Number(f.unit_cost) || 0);
    });

    const results = [];
    for (const estId of ids) {
      const er = await pool.query(
        `SELECT id, data, is_locked FROM estimates
          WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)`, [estId, orgId]);
      if (!er.rows.length) { results.push({ id: estId, ok: false, why: 'not found' }); continue; }
      if (er.rows[0].is_locked) { results.push({ id: estId, ok: false, why: 'locked (sold)' }); continue; }
      const blob = er.rows[0].data || {};
      const lines = Array.isArray(blob.lines) ? blob.lines : [];
      let touched = 0;
      lines.forEach((l) => {
        if (Number(l.sourceAssemblyId) === id && Array.isArray(l.assemblyBreakdown)) {
          // Parametric inserts (assemblyParams) were computed from typed
          // dimensions — per-unit repricing would be WRONG for them. Skip;
          // reprice by re-inserting with the same params.
          if (l.assemblyParams) return;
          if (l.assemblyBucket) {
            l.unitCost = Math.round((bucketCost[l.assemblyBucket] || 0) * 10000) / 10000;
            l.assemblyBreakdown = bucketRows[l.assemblyBucket] || [];
          } else {
            l.unitCost = cost.unitCost;
            l.assemblyBreakdown = flat;
          }
          touched++;
        }
      });
      if (!touched) { results.push({ id: estId, ok: false, why: 'no rollup lines' }); continue; }
      blob.lines = lines;
      await pool.query('UPDATE estimates SET data = $1, updated_at = NOW() WHERE id = $2', [JSON.stringify(blob), estId]);
      results.push({ id: estId, ok: true, lines: touched, new_unit_cost: cost.unitCost });
    }
    const okCount = results.filter((r) => r.ok).length;
    if (okCount) {
      try {
        await asm.logTuning(pool, orgId, id,
          [{ field: 'refresh', new_value: okCount + ' estimate(s) repriced to $' + cost.unitCost + '/' + (a.unit || 'EA') }],
          { userId: req.user.id, source: 'manual', reason: (req.body.reason || '').slice(0, 500) || null });
      } catch (e) { /* log only */ }
    }
    res.json({ ok: true, results, new_unit_cost: cost.unitCost });
  } catch (e) {
    console.error('POST /api/assemblies/:id/refresh-estimates error:', e);
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
      if (err) {
        // Atomic create: a rejected recipe must not strand a header-only
        // assembly (its unique code would then block every retry).
        try { await pool.query('DELETE FROM assemblies WHERE id = $1', [id]); } catch (e2) { /* best effort */ }
        return res.status(400).json({ error: err });
      }
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
    let count;
    try {
      count = await asm.updateHeader(pool, req.user.organization_id, id, req.body || {});
    } catch (ve) {
      return res.status(400).json({ error: ve.message });
    }
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
