'use strict';
// Shared assembly logic — used by routes/assembly-routes.js (REST), the AI
// read tool (ai-routes read_assemblies), and the payload dispatcher's
// 'assembly' target. Every function takes `db` (anything with .query — the
// pool OR an open transaction client) so the dispatcher can run writes
// inside its single-transaction apply.

const KINDS = new Set(['material', 'labor', 'sub', 'gc', 'assembly']);
const COST_CODES = new Set(['materials', 'labor', 'sub', 'gc']);
const SOURCES = new Set(['seed', 'manual', 'learned']);
const MAX_DEPTH = 4;
const KIND_DEFAULT_CODE = { material: 'materials', labor: 'labor', sub: 'sub', gc: 'gc' };

const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };

// Pulls every assembly + item for the org so list costing and nested
// resolution never N+1. Material prices ride along for live pricing.
async function loadGraph(db, orgId) {
  const [aq, iq] = await Promise.all([
    db.query(
      `SELECT id, code, name, description, trade, category, unit, source, is_hidden, notes, updated_at
         FROM assemblies WHERE organization_id = $1 OR organization_id IS NULL`, [orgId]),
    db.query(
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

// Effective unit cost of one item row. Material rows with NULL unit_cost
// pull the live catalog price.
function itemUnitCost(it) {
  if (it.unit_cost != null) return num(it.unit_cost);
  if (it.kind === 'material') {
    if (it.last_unit_price != null) return num(it.last_unit_price);
    if (it.avg_unit_price != null) return num(it.avg_unit_price);
  }
  return null; // unpriced — surfaced as incomplete, never silent $0
}

// Resolved cost of ONE output unit. Cycle-safe. { unitCost, incomplete, cycle }
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

// Flatten to LEAF rows with the effective qty per 1 output unit of the root —
// what an estimate insert multiplies by the takeoff qty.
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

// Would adding `childId` under `parentId` create a cycle?
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
    rationale: it.rationale || '',
  };
}

// Display identity for a recipe row — used to match old↔new rows when
// diffing a full-replace save into tuning-log entries.
function itemKey(it) {
  return [it.kind || 'material', it.material_id || '', it.child_assembly_id || '',
          String(it.description || '').trim().toLowerCase()].join('|');
}

// Write tuning-log rows. entries: [{item_desc?, field, old_value?, new_value?, evidence?}]
async function logTuning(db, orgId, assemblyId, entries, opts) {
  opts = opts || {};
  for (const e of entries) {
    await db.query(
      `INSERT INTO assembly_tuning_log
         (organization_id, assembly_id, item_desc, field, old_value, new_value, reason, evidence, source, changed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [orgId, assemblyId, e.item_desc || null, e.field,
       e.old_value != null ? String(e.old_value) : null,
       e.new_value != null ? String(e.new_value) : null,
       opts.reason || null,
       e.evidence ? JSON.stringify(e.evidence) : null,
       opts.source || 'manual', opts.userId || null]
    );
  }
}

// Header field whitelist for create/update.
function pickHeader(body) {
  const out = {};
  ['code', 'name', 'description', 'trade', 'category', 'unit', 'notes'].forEach((k) => {
    if (body[k] !== undefined) out[k] = body[k] === null ? null : String(body[k]).slice(0, 500);
  });
  if (body.source !== undefined && SOURCES.has(body.source)) out.source = body.source;
  if (body.is_hidden !== undefined) out.is_hidden = !!body.is_hidden;
  return out;
}

// Insert a new assembly header. Returns the new id.
async function createAssembly(db, orgId, header, createdBy) {
  const h = pickHeader(header || {});
  if (!h.name || !String(h.name).trim()) throw new Error('name is required');
  const r = await db.query(
    `INSERT INTO assemblies (organization_id, code, name, description, trade, category, unit, source, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [orgId, h.code || null, h.name.trim(), h.description || null,
     h.trade || null, h.category || null, h.unit || 'EA', h.source || 'manual',
     h.notes || null, createdBy || null]
  );
  return r.rows[0].id;
}

// Update header fields (whitelisted). Returns rowCount.
async function updateHeader(db, orgId, assemblyId, header) {
  const h = pickHeader(header || {});
  const keys = Object.keys(h);
  if (!keys.length) return 1;
  const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const vals = keys.map((k) => h[k]);
  const r = await db.query(
    `UPDATE assemblies SET ${sets}, updated_at = NOW()
      WHERE id = $${keys.length + 1} AND (organization_id = $${keys.length + 2} OR organization_id IS NULL)`,
    [...vals, assemblyId, orgId]
  );
  return r.rowCount;
}

// Full-replace the recipe rows. Validates kinds, org ownership of linked
// materials/children, and the cycle guard. Returns an error string or null.
// opts {userId, source, reason} — when present, the old→new field diffs are
// written to assembly_tuning_log (the Tuning Center's evidence trail).
async function replaceItems(db, assemblyId, items, orgId, opts) {
  const graph = await loadGraph(db, orgId);
  if (!graph.assemblies.get(assemblyId)) return 'Assembly not found';
  const oldItems = (graph.itemsBy.get(assemblyId) || []).slice();
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
      const m = await db.query(
        'SELECT 1 FROM materials WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)',
        [mid, orgId]);
      if (!m.rows.length) return 'material_id not found in your catalog';
    }
    if (it.cost_code != null && it.cost_code !== '' && !COST_CODES.has(it.cost_code)) return `Bad cost_code "${it.cost_code}"`;
  }
  await db.query('DELETE FROM assembly_items WHERE assembly_id = $1', [assemblyId]);
  let sort = 0;
  for (const it of items) {
    const kind = String(it.kind || 'material');
    await db.query(
      `INSERT INTO assembly_items
        (assembly_id, sort_order, kind, material_id, child_assembly_id, description,
         qty_per_unit, unit, unit_cost, cost_code, waste_pct, notes, rationale)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [assemblyId, sort++, kind,
       kind === 'material' && it.material_id != null ? parseInt(it.material_id, 10) : null,
       kind === 'assembly' ? parseInt(it.child_assembly_id, 10) : null,
       it.description != null ? String(it.description).slice(0, 500) : null,
       num(it.qty_per_unit) || 1,
       it.unit != null ? String(it.unit).slice(0, 20) : null,
       it.unit_cost != null && it.unit_cost !== '' ? num(it.unit_cost) : null,
       COST_CODES.has(it.cost_code) ? it.cost_code : (KIND_DEFAULT_CODE[kind] || 'materials'),
       num(it.waste_pct) || 0,
       it.notes != null ? String(it.notes).slice(0, 500) : null,
       it.rationale != null ? String(it.rationale).slice(0, 2000) : null]
    );
  }
  await db.query('UPDATE assemblies SET updated_at = NOW() WHERE id = $1', [assemblyId]);

  // Diff old→new into the tuning log (best-effort — a log failure must never
  // fail the save itself, nor poison a shared transaction).
  if (opts && (opts.userId || opts.source)) {
    let entries = [];
    try {
      const oldBy = new Map();
      oldItems.forEach((o) => oldBy.set(itemKey(o), o));
      const seenKeys = new Set();
      items.forEach((n) => {
        const key = itemKey(n);
        seenKeys.add(key);
        const o = oldBy.get(key);
        const desc = n.description || (o && (o.description || o.material_description)) || n.kind;
        if (!o) {
          entries.push({ item_desc: desc, field: 'items', new_value: '+ added' });
          return;
        }
        [['qty_per_unit', num], ['unit_cost', (v) => (v == null || v === '' ? null : num(v))], ['waste_pct', num]].forEach(([f, cast]) => {
          const ov = cast(o[f]); const nv = cast(n[f]);
          if (String(ov) !== String(nv)) entries.push({ item_desc: desc, field: f, old_value: ov, new_value: nv });
        });
        const or = (o.rationale || '').trim(); const nr = (n.rationale || '').trim();
        if (or !== nr && nr) entries.push({ item_desc: desc, field: 'rationale', old_value: or || null, new_value: nr });
      });
      oldItems.forEach((o) => {
        if (!seenKeys.has(itemKey(o))) {
          entries.push({ item_desc: o.description || o.material_description || o.kind, field: 'items', new_value: '− removed' });
        }
      });
    } catch (e) { entries = []; /* diff building is pure-JS; ignore */ }
    // Write the log OUTSIDE the diff try/catch. Inside a shared transaction
    // (opts.inTxn — the payload dispatcher) a raw failure here would poison the
    // txn and make the eventual COMMIT silently ROLLBACK the whole assembly
    // write, so isolate it in a SAVEPOINT. In autocommit there is no open txn
    // to poison, so a plain swallow is safe.
    if (entries.length) {
      if (opts.inTxn) {
        await bestEffortInTxn(db, 'asm_log_items', () => logTuning(db, orgId, assemblyId, entries, opts));
      } else {
        try { await logTuning(db, orgId, assemblyId, entries, opts); } catch (e) { /* autocommit: nothing to poison */ }
      }
    }
  }
  return null;
}

// Run a best-effort side-write inside a SAVEPOINT so its failure rolls back
// ONLY that write, never the outer transaction. The SAVEPOINT statement is
// issued un-guarded on purpose: if it throws, the outer txn is ALREADY aborted
// (25P02) and we must let it propagate so the caller surfaces it — silently
// masking a poisoned txn is exactly what turns a failed side-write into a lost
// COMMIT reported as success. Only call inside an open transaction. spName must
// be a hardcoded literal (interpolated into SQL — never pass user input).
async function bestEffortInTxn(db, spName, fn) {
  await db.query('SAVEPOINT ' + spName);
  try {
    await fn();
    await db.query('RELEASE SAVEPOINT ' + spName);
  } catch (e) {
    try {
      await db.query('ROLLBACK TO SAVEPOINT ' + spName);
      await db.query('RELEASE SAVEPOINT ' + spName);
    } catch (e2) { /* connection gone; the outer apply will surface it */ }
  }
}

module.exports = {
  KINDS, COST_CODES, SOURCES, KIND_DEFAULT_CODE, MAX_DEPTH,
  loadGraph, itemUnitCost, resolveCost, flatten, wouldCycle, shapeItem,
  pickHeader, createAssembly, updateHeader, replaceItems, logTuning, bestEffortInTxn,
};
