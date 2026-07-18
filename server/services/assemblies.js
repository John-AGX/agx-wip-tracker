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

// ── Assembly code protocol: TRADE-SYSTEM-VARIANT (uppercase, derived from
// structured columns). VARIANT is optional; SYSTEM is optional (a bare TRADE
// code is valid). Codes are unique per org (COALESCE(org,0), UPPER(code)).
const VARIANT_RE = /^[A-Z0-9/]{0,10}$/;
const CODE_RE = /^[A-Z0-9]+(-[A-Z0-9]+)?(-[A-Z0-9/]{1,10})?$/;
// Free-text trade → registry code, for backfilling legacy hand-typed trades.
const TRADE_ALIASES = {
  roofing: 'ROOF', roof: 'ROOF', fencing: 'FENC', fence: 'FENC', decking: 'DECK', deck: 'DECK',
  stucco: 'STUC', paint: 'PAINT', painting: 'PAINT', carpentry: 'CARP', framing: 'CARP', carpenter: 'CARP',
  concrete: 'CONC', flatwork: 'CONC', drywall: 'DRYW', sheetrock: 'DRYW', siding: 'SIDG',
  gutters: 'GUTR', gutter: 'GUTR', windows: 'WIND', window: 'WIND', doors: 'DOOR', door: 'DOOR',
  electrical: 'ELEC', electric: 'ELEC', plumbing: 'PLMB', plumb: 'PLMB', hvac: 'HVAC', mechanical: 'HVAC',
  demolition: 'DEMO', demo: 'DEMO', 'general conditions': 'GEN', general: 'GEN', gc: 'GEN',
};
// Global taxonomy (organization_id NULL = shared across tenants). The full
// Central-FL library (Trades → Systems → Variants) is the generated seed
// module; edit that file to grow the catalog.
const GLOBAL_TAXONOMY = require('./assembly-taxonomy-seed');
// S0 parametric layer — the SAME formula engine the browser previews with
// (js/assembly-formula.js is UMD), so a formula can never price differently
// server-side than the editor showed.
const formulaEngine = require('../../js/assembly-formula');

const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };

// ── Parametric helpers ───────────────────────────────────────────────
const MAX_PARAMS = 12;
const PARAM_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,15}$/;

// assemblies.params arrives as a JSONB value (array) or a JSON string —
// normalize to a clean array of {key,label,unit,default,min,max} or [].
function paramDefs(assembly) {
  let p = assembly && assembly.params;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { p = null; } }
  if (!Array.isArray(p)) return [];
  return p.filter((d) => d && PARAM_KEY_RE.test(String(d.key || ''))).map((d) => ({
    key: String(d.key), label: d.label != null ? String(d.label) : String(d.key),
    unit: d.unit != null ? String(d.unit) : '',
    default: num(d.default),
    min: d.min != null && isFinite(Number(d.min)) ? Number(d.min) : null,
    max: d.max != null && isFinite(Number(d.max)) ? Number(d.max) : null,
  }));
}

// Validate + normalize a client-supplied params declaration. Returns
// { ok, params } or { ok:false, error }. Q is reserved (always in scope).
function normalizeParams(raw) {
  if (raw == null) return { ok: true, params: null };
  let p = raw;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { return { ok: false, error: 'params must be a JSON array' }; } }
  if (!Array.isArray(p)) return { ok: false, error: 'params must be an array' };
  if (p.length > MAX_PARAMS) return { ok: false, error: `At most ${MAX_PARAMS} parameters per assembly` };
  const seen = new Set();
  const out = [];
  for (const d of p) {
    const key = String((d && d.key) || '').trim();
    if (!PARAM_KEY_RE.test(key)) return { ok: false, error: `Bad parameter key "${key}" — letters/digits/underscore, starting with a letter (max 16 chars)` };
    if (key.toUpperCase() === 'Q') return { ok: false, error: 'Q is reserved — it is always the takeoff quantity in the output unit' };
    if (seen.has(key.toUpperCase())) return { ok: false, error: `Duplicate parameter "${key}"` };
    seen.add(key.toUpperCase());
    const def = Number(d.default);
    const entry = {
      key,
      label: String(d.label != null ? d.label : key).slice(0, 40),
      unit: String(d.unit != null ? d.unit : '').slice(0, 10),
      default: isFinite(def) ? def : 0,
    };
    if (d.min != null && isFinite(Number(d.min))) entry.min = Number(d.min);
    if (d.max != null && isFinite(Number(d.max))) entry.max = Number(d.max);
    out.push(entry);
  }
  return { ok: true, params: out.length ? out : null };
}

// The evaluation scope for an assembly: Q (takeoff qty in the output unit)
// + declared params at their defaults, overridden by caller-supplied values.
function paramScope(assembly, overrides) {
  const defs = paramDefs(assembly);
  const scope = { Q: 1 };
  defs.forEach((d) => { scope[d.key] = d.default; });
  if (overrides && typeof overrides === 'object') {
    const byUpper = {};
    Object.keys(scope).forEach((k) => { byUpper[k.toUpperCase()] = k; });
    Object.keys(overrides).forEach((k) => {
      const canon = byUpper[String(k).toUpperCase()];
      const raw = overrides[k];
      // Blank / null / boolean = "not provided" → keep the default.
      // Number('') === 0 would silently zero-price a cleared input.
      if (!canon || raw === '' || raw == null || typeof raw === 'boolean') return;
      const v = Number(raw);
      if (isFinite(v)) scope[canon] = v;
    });
  }
  // Clamp declared bounds (authoring guardrails, not hard validation).
  defs.forEach((d) => {
    if (d.min != null && scope[d.key] < d.min) scope[d.key] = d.min;
    if (d.max != null && scope[d.key] > d.max) scope[d.key] = d.max;
  });
  return scope;
}

// Parametric explode: FINAL leaf rows for a given param scope (vs flatten's
// per-1-output-unit rows). Formulas evaluate at the ROOT level only — an
// item's qty_formula computes its TOTAL quantity in the root scope, and a
// formula on a sub-assembly item sets how many child-units to flatten
// (ceil(Q/8)+1 of a "post" child). INSIDE a nested child, formulas fall back
// to the linear qty_per_unit × parent count with a warning: a nested formula
// would be an absolute total, so flattening the child twice (or ×N) would
// double-count it, and the child's own params aren't in the root scope.
function explodeParametric(id, graph, scope, _st) {
  const st = _st || {
    out: [], errors: [], warnings: [], warned: new Set(),
    mult: num(scope.Q), depth: 0, seen: new Set(),
  };
  const aName = ((graph.assemblies.get(id) || {}).name) || ('#' + id);
  if (st.seen.has(id) || st.depth > MAX_DEPTH) {
    if (!st.warned.has('depth:' + id)) {
      st.warned.add('depth:' + id);
      st.warnings.push('Nested assembly "' + aName + '" was skipped (cycle or nesting too deep) — its cost is NOT included.');
    }
    return { rows: st.out, errors: st.errors, warnings: st.warnings };
  }
  st.seen.add(id);
  const items = graph.itemsBy.get(id) || [];
  for (const it of items) {
    const desc = it.description || it.material_description || it.kind;
    let base;
    if (it.qty_formula && st.depth === 0) {
      const r = formulaEngine.evaluate(it.qty_formula, scope);
      if (!r.ok) { st.errors.push({ item: desc, formula: it.qty_formula, error: r.error }); continue; }
      base = Math.max(0, r.value);
    } else {
      if (it.qty_formula && !st.warned.has('nested:' + id)) {
        st.warned.add('nested:' + id);
        st.warnings.push('Formulas inside nested "' + aName + '" only apply when it is inserted directly — its per-unit quantities were used here.');
      }
      base = num(it.qty_per_unit) * st.mult;
    }
    const eff = base * (1 + num(it.waste_pct) / 100);
    if (it.kind === 'assembly' && it.child_assembly_id) {
      explodeParametric(it.child_assembly_id, graph, scope, {
        out: st.out, errors: st.errors, warnings: st.warnings, warned: st.warned,
        mult: eff, depth: st.depth + 1, seen: new Set(st.seen),
      });
    } else {
      const rowQty = Math.round(eff * 10000) / 10000;
      // qty_per_unit = the row's quantity PER 1 output unit (Q). The estimate
      // editor's breakdown consumers (explode / refresh-display) multiply
      // line.qty × qty_per_unit; a parametric rollup line's qty IS Q, so
      // Q × (qty/Q) reconstructs the absolute qty. Carrying both shapes keeps
      // those consumers correct without special-casing parametric rows.
      const rootQ = num(scope.Q);
      st.out.push({
        kind: it.kind,
        material_id: it.material_id,
        description: desc,
        unit: it.unit || it.material_unit || 'EA',
        qty: rowQty,
        qty_per_unit: rootQ > 0 ? Math.round((rowQty / rootQ) * 1e6) / 1e6 : rowQty,
        unit_cost: itemUnitCost(it),
        cost_code: (COST_CODES.has(it.cost_code) ? it.cost_code : KIND_DEFAULT_CODE[it.kind]) || 'materials',
        formula: it.qty_formula || null,
      });
    }
  }
  return { rows: st.out, errors: st.errors, warnings: st.warnings };
}

// Segment normalizers + code (de)composition.
function normalizeSeg(v) { return String(v == null ? '' : v).trim().toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function normalizeVariant(v) { return String(v == null ? '' : v).trim().toUpperCase().replace(/[^A-Z0-9/]/g, '').slice(0, 10); }
function normalizeCode(parts) {
  const t = normalizeSeg(parts && parts.trade);
  const s = normalizeSeg(parts && parts.system);
  const v = normalizeVariant(parts && parts.variant);
  return [t, s, v].filter(Boolean).join('-');
}
function parseCode(code) {
  const parts = String(code || '').trim().toUpperCase().split('-').filter(Boolean);
  return {
    trade: parts[0] ? normalizeSeg(parts[0]) : null,
    system: parts[1] ? normalizeSeg(parts[1]) : null,
    variant: parts[2] ? normalizeVariant(parts[2]) : null,
  };
}

// Merge global + org registry rows into lookup maps (org shadows global by code).
async function loadRegistry(db, orgId) {
  const [tq, sq, vq] = await Promise.all([
    db.query(`SELECT id, organization_id, code, name, sort_order FROM assembly_trades
               WHERE (organization_id = $1 OR organization_id IS NULL) AND archived_at IS NULL`, [orgId]),
    db.query(`SELECT id, organization_id, trade_code, code, name, default_unit, sort_order FROM assembly_systems
               WHERE (organization_id = $1 OR organization_id IS NULL) AND archived_at IS NULL`, [orgId]),
    db.query(`SELECT id, organization_id, trade_code, system_code, code, name, note, sort_order FROM assembly_variants
               WHERE (organization_id = $1 OR organization_id IS NULL) AND archived_at IS NULL`, [orgId]),
  ]);
  const globalFirst = (a, b) => (a.organization_id == null ? 0 : 1) - (b.organization_id == null ? 0 : 1);
  const trades = new Map();
  tq.rows.sort(globalFirst).forEach((r) => {
    const c = String(r.code).toUpperCase();
    trades.set(c, { id: r.id, code: c, name: r.name, org: r.organization_id, sort_order: r.sort_order });
  });
  const systemsByTrade = new Map();
  sq.rows.sort(globalFirst).forEach((r) => {
    const tc = String(r.trade_code).toUpperCase();
    const c = String(r.code).toUpperCase();
    if (!systemsByTrade.has(tc)) systemsByTrade.set(tc, new Map());
    systemsByTrade.get(tc).set(c, { id: r.id, code: c, name: r.name, default_unit: r.default_unit, org: r.organization_id, sort_order: r.sort_order });
  });
  const variantsBySystem = new Map(); // "TRADE|SYSTEM" → Map(varCode → row)
  vq.rows.sort(globalFirst).forEach((r) => {
    const key = String(r.trade_code).toUpperCase() + '|' + String(r.system_code).toUpperCase();
    const c = String(r.code).toUpperCase();
    if (!variantsBySystem.has(key)) variantsBySystem.set(key, new Map());
    variantsBySystem.get(key).set(c, { id: r.id, code: c, name: r.name, note: r.note, org: r.organization_id, sort_order: r.sort_order });
  });
  return { trades, systemsByTrade, variantsBySystem };
}

// Validate a header's trade/system/variant (+ optional raw code) against the
// registry and compute the canonical, unique code. Lenient for legacy rows:
// no trade at all → keep the raw code as-is (unclassified). Returns
// { ok, code, trade, system, variant, error }. Reused by every write path.
async function validateAgainstRegistry(db, orgId, header, opts) {
  opts = opts || {};
  let trade = normalizeSeg(header.trade);
  let system = normalizeSeg(header.system);
  let variant = normalizeVariant(header.variant);
  const rawCode = header.code != null ? String(header.code).trim() : '';
  const explicitTrade = !!trade;
  if (!trade && !system && !variant && rawCode) {
    const p = parseCode(rawCode);
    trade = p.trade || ''; system = p.system || ''; variant = p.variant || '';
  }
  if (!trade) {
    return { ok: true, code: rawCode || null, trade: null, system: system || null, variant: variant || null, legacy: true };
  }
  const reg = await loadRegistry(db, orgId);
  if (!reg.trades.get(trade)) {
    // Try the free-text alias map (e.g. "Roofing" → ROOF) before giving up.
    const aliased = TRADE_ALIASES[String(header.trade || '').trim().toLowerCase()];
    if (aliased && reg.trades.get(aliased)) {
      trade = aliased;
    } else {
      // Unknown trade → LENIENT legacy: keep the row saveable (store the
      // normalized trade so it still groups; keep the raw code or null). The
      // dropdown editor + 86-via-taxonomy only ever emit registry codes, so
      // this only catches the old free-text editor, direct API callers, and
      // genuinely-new trades (which the taxonomy manager can formalize later).
      return { ok: true, code: rawCode || null, trade: explicitTrade ? (trade || null) : null, system: null, variant: null, legacy: true };
    }
  }
  if (system) {
    const sysMap = reg.systemsByTrade.get(trade) || new Map();
    if (!sysMap.get(system)) {
      const valid = [...sysMap.keys()].sort();
      return { ok: false, error: `Unknown system "${system}" for trade ${trade}. Valid systems: ${valid.length ? valid.join(', ') : '(none yet — add one under Admin → Assembly Codes)'}` };
    }
  }
  if (variant && !VARIANT_RE.test(variant)) {
    return { ok: false, error: `Variant "${variant}" may only contain A–Z, 0–9 and "/" (max 10 chars).` };
  }
  const code = normalizeCode({ trade, system, variant });
  const dup = await db.query(
    `SELECT id FROM assemblies WHERE COALESCE(organization_id,0)=COALESCE($1,0) AND UPPER(code)=UPPER($2) AND id <> $3 LIMIT 1`,
    [orgId, code, opts.selfId || 0]);
  if (dup.rows.length) {
    return { ok: false, error: `Code ${code} is already used by assembly #${dup.rows[0].id}. Change the variant to make it unique.` };
  }
  return { ok: true, code, trade, system: system || null, variant: variant || null };
}

// Idempotent seed of the global (NULL-org) taxonomy — trades, systems, and the
// variant catalog. NOT-EXISTS guards make it safe on every boot / racing boots.
// It also RECONCILES: for a trade the library covers, any GLOBAL system/variant
// whose code isn't in the library is archived — so the tiny starter set is
// superseded by this library rather than shown alongside it. Org-added rows are
// never touched (this only reconciles organization_id IS NULL rows).
async function seedGlobalTaxonomy(db) {
  for (let ti = 0; ti < GLOBAL_TAXONOMY.length; ti++) {
    const t = GLOBAL_TAXONOMY[ti];
    await db.query(
      `INSERT INTO assembly_trades (organization_id, code, name, sort_order)
       SELECT NULL, $1, $2, $3
        WHERE NOT EXISTS (SELECT 1 FROM assembly_trades WHERE organization_id IS NULL AND UPPER(code)=UPPER($1))`,
      [t.code, t.name, ti]);
    const systems = t.systems || [];
    const sysCodes = systems.map((s) => String(s.code).toUpperCase());
    for (let si = 0; si < systems.length; si++) {
      const s = systems[si];
      await db.query(
        `INSERT INTO assembly_systems (organization_id, trade_code, code, name, default_unit, sort_order)
         SELECT NULL, $1, $2, $3, $4, $5
          WHERE NOT EXISTS (SELECT 1 FROM assembly_systems WHERE organization_id IS NULL AND UPPER(trade_code)=UPPER($1) AND UPPER(code)=UPPER($2))`,
        [t.code, s.code, s.name, s.unit || null, si]);
      const variants = s.variants || [];
      const varCodes = variants.map((v) => String(v.code).toUpperCase());
      for (let vi = 0; vi < variants.length; vi++) {
        const v = variants[vi];
        await db.query(
          `INSERT INTO assembly_variants (organization_id, trade_code, system_code, code, name, note, sort_order)
           SELECT NULL, $1, $2, $3, $4, $5, $6
            WHERE NOT EXISTS (SELECT 1 FROM assembly_variants WHERE organization_id IS NULL AND UPPER(trade_code)=UPPER($1) AND UPPER(system_code)=UPPER($2) AND UPPER(code)=UPPER($3))`,
          [t.code, s.code, v.code, v.name, v.note || null, vi]);
      }
      // Reconcile variants under a kept system.
      if (varCodes.length) {
        await db.query(
          `UPDATE assembly_variants SET archived_at=NOW()
            WHERE organization_id IS NULL AND UPPER(trade_code)=UPPER($1) AND UPPER(system_code)=UPPER($2)
              AND UPPER(code) <> ALL($3::text[]) AND archived_at IS NULL`,
          [t.code, s.code, varCodes]);
      }
    }
    // Reconcile: archive global systems (+ their variants) under this trade that the library dropped.
    if (sysCodes.length) {
      await db.query(
        `UPDATE assembly_systems SET archived_at=NOW()
          WHERE organization_id IS NULL AND UPPER(trade_code)=UPPER($1)
            AND UPPER(code) <> ALL($2::text[]) AND archived_at IS NULL`,
        [t.code, sysCodes]);
      await db.query(
        `UPDATE assembly_variants SET archived_at=NOW()
          WHERE organization_id IS NULL AND UPPER(trade_code)=UPPER($1)
            AND UPPER(system_code) <> ALL($2::text[]) AND archived_at IS NULL`,
        [t.code, sysCodes]);
    }
  }
}

// One-time (idempotent) migration of existing rows into the code protocol.
// Runs at boot BEFORE the assemblies unique-code index is built. No-op on the
// second boot (everything already normalized + de-duped).
async function backfillAssemblyTaxonomy(db) {
  await seedGlobalTaxonomy(db);

  // 1) Map free-text `trade` → a registry code (per org).
  const distinct = await db.query(
    `SELECT DISTINCT organization_id, trade FROM assemblies WHERE trade IS NOT NULL AND trade <> ''`);
  for (const row of distinct.rows) {
    const orgId = row.organization_id;
    const raw = String(row.trade);
    const asCode = normalizeSeg(raw);
    const reg = await loadRegistry(db, orgId);
    if (asCode && reg.trades.get(asCode)) {
      if (raw !== asCode) {
        await db.query(`UPDATE assemblies SET trade=$1 WHERE trade=$2 AND organization_id IS NOT DISTINCT FROM $3`, [asCode, raw, orgId]);
      }
      continue;
    }
    let code = TRADE_ALIASES[raw.trim().toLowerCase()];
    if (!code) {
      code = (normalizeSeg(raw).slice(0, 6)) || 'MISC';
      await db.query(
        `INSERT INTO assembly_trades (organization_id, code, name, sort_order)
         SELECT $1, $2, $3, 900
          WHERE NOT EXISTS (SELECT 1 FROM assembly_trades WHERE COALESCE(organization_id,0)=COALESCE($1,0) AND UPPER(code)=UPPER($2))`,
        [orgId, code, raw.slice(0, 60)]);
    }
    await db.query(`UPDATE assemblies SET trade=$1 WHERE trade=$2 AND organization_id IS NOT DISTINCT FROM $3`, [code, raw, orgId]);
  }

  // 2) Parse conforming hand-typed codes into system/variant (never rewrite the code).
  const coded = await db.query(
    `SELECT id, code, trade, system, variant FROM assemblies WHERE code IS NOT NULL AND code <> ''`);
  for (const a of coded.rows) {
    if (a.system != null && a.variant != null) continue;
    if (!CODE_RE.test(String(a.code).toUpperCase())) continue;
    const p = parseCode(a.code);
    const sets = [], vals = [];
    if ((a.trade == null || a.trade === '') && p.trade) { sets.push('trade'); vals.push(p.trade); }
    if (a.system == null && p.system) { sets.push('system'); vals.push(p.system); }
    if (a.variant == null && p.variant) { sets.push('variant'); vals.push(p.variant); }
    if (sets.length) {
      const setSql = sets.map((k, i) => `${k}=$${i + 1}`).join(', ');
      await db.query(`UPDATE assemblies SET ${setSql} WHERE id=$${sets.length + 1}`, [...vals, a.id]);
    }
  }

  // 3) Generate a code for rows missing one (only when trade is a known code).
  const missing = await db.query(
    `SELECT id, organization_id, trade, system, variant FROM assemblies WHERE code IS NULL OR code=''`);
  for (const a of missing.rows) {
    const trade = normalizeSeg(a.trade);
    if (!trade) continue;
    const reg = await loadRegistry(db, a.organization_id);
    if (!reg.trades.get(trade)) continue; // unclassified — leave NULL
    const code = normalizeCode({ trade, system: a.system, variant: a.variant });
    if (code) await db.query(`UPDATE assemblies SET code=$1 WHERE id=$2`, [code, a.id]);
  }

  // 4) De-dup so the unique index can build: keep the lowest id, suffix the rest.
  const dupes = await db.query(
    `SELECT COALESCE(organization_id,0) AS bucket, UPPER(code) AS uc, array_agg(id ORDER BY id) AS ids
       FROM assemblies WHERE code IS NOT NULL AND code <> ''
      GROUP BY 1, 2 HAVING COUNT(*) > 1`);
  for (const g of dupes.rows) {
    const rest = g.ids.slice(1);
    let n = 2;
    for (const id of rest) {
      let candidate;
      for (; ; n++) {
        candidate = g.uc + '-' + n;
        const t = await db.query(
          `SELECT 1 FROM assemblies WHERE COALESCE(organization_id,0)=$1 AND UPPER(code)=UPPER($2) LIMIT 1`, [g.bucket, candidate]);
        if (!t.rows.length) break;
      }
      await db.query(`UPDATE assemblies SET code=$1 WHERE id=$2`, [candidate, id]);
      n++;
    }
  }
}

// Pulls every assembly + item for the org so list costing and nested
// resolution never N+1. Material prices ride along for live pricing.
async function loadGraph(db, orgId) {
  const [aq, iq] = await Promise.all([
    db.query(
      `SELECT id, code, name, description, trade, system, variant, category, unit, source, is_hidden, notes, params, updated_at
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
    qty_formula: it.qty_formula || null,
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
  ['code', 'name', 'description', 'trade', 'system', 'variant', 'category', 'unit', 'notes'].forEach((k) => {
    if (body[k] !== undefined) out[k] = body[k] === null ? null : String(body[k]).slice(0, 500);
  });
  if (body.source !== undefined && SOURCES.has(body.source)) out.source = body.source;
  if (body.is_hidden !== undefined) out.is_hidden = !!body.is_hidden;
  return out;
}

// Insert a new assembly header. Returns the new id. Validates the code
// protocol (trade/system/variant → canonical unique code) and throws on a
// registry/uniqueness violation with an actionable message.
async function createAssembly(db, orgId, header, createdBy) {
  const h = pickHeader(header || {});
  if (!h.name || !String(h.name).trim()) throw new Error('name is required');
  const v = await validateAgainstRegistry(db, orgId, h, {});
  if (!v.ok) throw new Error(v.error);
  // params rides outside pickHeader (it's structured, not a string field).
  const pn = normalizeParams(header && header.params !== undefined ? header.params : null);
  if (!pn.ok) throw new Error(pn.error);
  const r = await db.query(
    `INSERT INTO assemblies (organization_id, code, name, description, trade, system, variant, category, unit, source, notes, params, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [orgId, v.code || null, h.name.trim(), h.description || null,
     v.trade || (h.trade || null), v.system || null, v.variant || null,
     h.category || null, h.unit || 'EA', h.source || 'manual',
     h.notes || null, pn.params ? JSON.stringify(pn.params) : null, createdBy || null]
  );
  return r.rows[0].id;
}

// Update header fields (whitelisted). Returns rowCount. When any code segment
// (trade/system/variant/code) changes, re-validates against the registry and
// writes the recomputed canonical code; throws on a violation.
async function updateHeader(db, orgId, assemblyId, header) {
  const h = pickHeader(header || {});
  // params is structured — validated + stored as JSON, never via the
  // string-slicing whitelist. Explicit null clears the declaration.
  if (header && header.params !== undefined) {
    const pn = normalizeParams(header.params);
    if (!pn.ok) throw new Error(pn.error);
    // Persisted formulas must stay valid against the NEW declaration —
    // dropping a param a saved formula references would break every explode.
    const fkeysNew = ['Q'].concat((pn.params || []).map((d) => d.key));
    const fr = await db.query(
      `SELECT description, qty_formula FROM assembly_items WHERE assembly_id = $1 AND qty_formula IS NOT NULL`,
      [assemblyId]);
    for (const row of fr.rows) {
      const ferr = formulaEngine.validate(row.qty_formula, fkeysNew);
      if (ferr) throw new Error(`That parameter change breaks the formula on "${row.description || 'an item'}": ${ferr}`);
    }
    h.params = pn.params ? JSON.stringify(pn.params) : null;
  }
  const keys = Object.keys(h);
  if (!keys.length) return 1;
  const finalH = Object.assign({}, h);
  if (['trade', 'system', 'variant', 'code'].some((k) => k in h)) {
    const cur = await db.query(
      `SELECT trade, system, variant, code FROM assemblies WHERE id=$1 AND (organization_id=$2 OR organization_id IS NULL)`,
      [assemblyId, orgId]);
    if (!cur.rows.length) return 0;
    const c = cur.rows[0];
    const merged = {
      trade: ('trade' in h) ? h.trade : c.trade,
      system: ('system' in h) ? h.system : c.system,
      variant: ('variant' in h) ? h.variant : c.variant,
      code: ('code' in h) ? h.code : c.code,
    };
    const v = await validateAgainstRegistry(db, orgId, merged, { selfId: assemblyId });
    if (!v.ok) throw new Error(v.error);
    finalH.trade = v.trade; finalH.system = v.system; finalH.variant = v.variant; finalH.code = v.code;
  }
  const fkeys = Object.keys(finalH);
  const sets = fkeys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const vals = fkeys.map((k) => finalH[k]);
  const r = await db.query(
    `UPDATE assemblies SET ${sets}, updated_at = NOW()
      WHERE id = $${fkeys.length + 1} AND (organization_id = $${fkeys.length + 2} OR organization_id IS NULL)`,
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
  // Formula rows must parse and reference only declared params (+ Q) — a
  // typo saved today is a $0 line at explode time.
  const declaredKeys = ['Q'].concat(paramDefs(graph.assemblies.get(assemblyId)).map((d) => d.key));
  for (const it of items) {
    const kind = String(it.kind || 'material');
    if (!KINDS.has(kind)) return `Bad kind "${kind}"`;
    if (it.qty_formula != null && String(it.qty_formula).trim() !== '') {
      const ferr = formulaEngine.validate(String(it.qty_formula), declaredKeys);
      if (ferr) return `Formula "${String(it.qty_formula).slice(0, 60)}": ${ferr}`;
    }
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
         qty_per_unit, unit, unit_cost, cost_code, waste_pct, notes, rationale, qty_formula)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
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
       it.rationale != null ? String(it.rationale).slice(0, 2000) : null,
       it.qty_formula != null && String(it.qty_formula).trim() !== '' ? String(it.qty_formula).slice(0, 200) : null]
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
        [['qty_per_unit', num], ['unit_cost', (v) => (v == null || v === '' ? null : num(v))], ['waste_pct', num],
         ['qty_formula', (v) => (v == null || String(v).trim() === '' ? null : String(v).trim())]].forEach(([f, cast]) => {
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
  // Parametric layer (S0)
  paramDefs, normalizeParams, paramScope, explodeParametric,
  // Code protocol
  normalizeCode, parseCode, loadRegistry, validateAgainstRegistry,
  seedGlobalTaxonomy, backfillAssemblyTaxonomy,
};
