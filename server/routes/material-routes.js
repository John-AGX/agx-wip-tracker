// Materials catalog — built from Project 86's vendor purchase history
// (Home Depot to start). Drives the AG `search_materials` tool so the
// estimator can ground line-item proposals in actual descriptions and
// Project 86-side prices instead of guessing.
//
// Import flow: admin uploads a vendor CSV; the client (admin.js) parses
// it browser-side via SheetJS and POSTs the row array here as JSON. We
// dedupe, net returns, recompute aggregates, and write back. Description
// cleanup (regex) is local — HD's all-caps abbreviated descriptions get
// title-cased + unit-expanded so AG can quote them in proposals.

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireCapability } = require('../auth');
// Training flywheel — admin normalization overrides become examples (PUT /:id).
const { captureExample, TASKS } = require('../services/training-capture');
// Shared create-researched-material helper (also used by assembly variant-spin).
const matSvc = require('../services/materials');

const router = express.Router();

// Startup fingerprint — lets us verify from deploy logs whether this
// file is in the running image (vs a stale cached build).
console.log('[material-routes] mounted at /api/materials (Phase 1 — catalog ingest + browse)');

// ──────────────────────────────────────────────────────────────────
// Description cleanup (regex, no AI). Handles ~95% of HD's screaming-
// caps descriptions cleanly. Admins can fix the remaining 5% by hand
// in the Materials browser.
// ──────────────────────────────────────────────────────────────────

// Brand names that should keep their proper case. HD ships everything
// uppercase; this list pulls them back to TitleCase.
const KNOWN_BRANDS = [
  '3M', 'AMERIMIX', 'BEHR', 'DAP', 'DEWALT', 'FROGTAPE', 'GORILLA',
  'HENRY', 'HUSKY', 'KILZ', 'LIQUID NAILS', 'LOCTITE', 'MILWAUKEE',
  'PURDY', 'QUIKRETE', 'RUST-OLEUM', 'RUSTOLEUM', 'SAKRETE', 'SHEETROCK',
  'SHERWIN', 'SHERWIN-WILLIAMS', 'SIKA', 'SIKACRYL', 'SIKAFLEX',
  'TAPCON', 'TITEBOND', 'WHIRLPOOL', 'WOOSTER', 'XYLON', 'ZINSSER'
];
// Aliases — alternate spellings or compounds to clean up
const COMPOUND_FIXES = [
  [/\bREADYMIX\b/gi, 'Ready-Mix'],
  [/\bPRE-?BLEND\b/gi, 'Pre-Blend'],
  [/\bMULTI-?PURP\b/gi, 'Multi-Purpose'],
  [/\bHVY DUTY\b/gi, 'Heavy Duty'],
  [/\bDRYWAL\b/gi, 'Drywall'],
  [/\bSANDNG\b/gi, 'Sanding'],
  [/\bCNSTRCTN\b/gi, 'Construction'],
  [/\bSEALAN\b/gi, 'Sealant'],
  [/\bLMST\b/gi, 'Limestone'],
  [/\bFINE\/MED\b/gi, 'Fine/Medium'],
  [/\bSADL\b/gi, 'Saddle'],
  [/\bCMNT\b/gi, 'Cement'],
  [/\bASSY\b/gi, 'Assembly'],
  [/\bPK\b/gi, 'Pack'],
  [/\bPCS\b/gi, 'pcs'],
  [/\bGAL\b/g, 'gal'],
  [/\bQT\b/g, 'qt'],
  [/\bOZ\b/g, 'oz'],
  [/\bLB\b/g, 'lb'],
  [/\bFT\b/g, 'ft'],
  [/\bIN\b/g, 'in']
];

function cleanDescription(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  // Decimal-number unit fixes: "10.1OZ" → "10.1 oz", "5LB" → "5 lb",
  // "8FT" → "8 ft", "1QT" → "1 qt", "50LB" → "50 lb", "1/2IN" → "1/2 in".
  // Run BEFORE the title-case pass so the unit suffix is still uppercase
  // and matches the regex.
  s = s.replace(/(\d+(?:\.\d+)?(?:\/\d+)?)(OZ|LB|QT|GAL|FT|IN|YD|SF|LF|CY|MM|CM)\b/g,
    (m, num, unit) => num + ' ' + unit.toLowerCase());
  // "6FTX8FT" → "6 ft x 8 ft" (after the above already split out units)
  s = s.replace(/(\d+(?:\.\d+)?\s*(?:oz|lb|qt|gal|ft|in|yd|sf|lf|cy|mm|cm))X(\d)/gi,
    (m, p1, p2) => p1 + ' x ' + p2);
  // Title-case everything as a baseline
  s = s.split(/\s+/).map(w => {
    if (!w) return w;
    // Preserve fractions and decimals as-is
    if (/^\d+(\.\d+)?(\/\d+)?$/.test(w)) return w;
    // Mixed-case words that already include a lowercase letter (post-unit-fix)
    // shouldn't be re-cased — preserves "qt", "ft" etc.
    if (/[a-z]/.test(w)) return w;
    // Words that are abbreviation-like (3+ caps) → title case
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(' ');
  // Brand re-capitalization. Title-case might've turned "SIKAFLEX" into
  // "Sikaflex" already (good), but "3M" → "3m" needs fixing back.
  KNOWN_BRANDS.forEach(brand => {
    const proper = brand.split(' ').map(w =>
      // "3M" stays "3M"; "BEHR" -> "Behr"; "RUST-OLEUM" -> "Rust-Oleum"
      w.split('-').map(p => /^\d/.test(p) ? p.toUpperCase() : (p.charAt(0) + p.slice(1).toLowerCase())).join('-')
    ).join(' ');
    s = s.replace(new RegExp('\\b' + brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi'), proper);
  });
  // Compound-word and abbreviation fixes
  COMPOUND_FIXES.forEach(([re, rep]) => { s = s.replace(re, rep); });
  return s.replace(/\s+/g, ' ').trim();
}

// Pull the unit out of the cleaned description so AG can match against
// proposed line items. Returns 'ea' when no unit is detectable.
function inferUnit(cleanedDesc) {
  if (!cleanedDesc) return 'ea';
  // Match numeric-prefixed unit, e.g. "1 qt", "10.1 oz", "5 lb"
  const m = cleanedDesc.match(/\b\d+(?:\.\d+)?(?:\/\d+)?\s*(qt|gal|oz|lb|ft|in|yd|sf|lf|cy)\b/i);
  return m ? m[1].toLowerCase() : 'ea';
}

// Map HD's three-level taxonomy to one of AGX's four standard subgroups
// (the cost categories AG uses on every estimate). Anything we can't
// classify defaults to 'materials' — admins can re-bucket per row.
function mapHdToAgxSubgroup(department, klass, subclass) {
  const dept = String(department || '').toUpperCase().trim();
  if (dept === 'TOOL RENTAL') return 'gc';
  if (dept === 'FEES' || dept === '') return null; // skip
  // Almost everything else from HD is a Materials buy
  if ([
    'PAINT', 'BLDG. MATERIALS', 'LUMBER', 'MILLWORK', 'HARDWARE',
    'PLUMBING', 'ELECTRICAL', 'WALL&FLOOR COVER.', 'KIT/BATH',
    'GARDEN/SEASONAL'
  ].includes(dept)) return 'materials';
  return 'materials';
}

// AGX-natural category — finer-grained than agx_subgroup. Drives the
// Materials browser filter and (in Phase 2) gives AG a way to ask
// "show me everything in 'Caulks & Sealants' under $10". Mapping is
// derived from HD's class/subclass distribution observed in AGX's
// actual purchase history — see CSV department×class breakdown.
function mapHdToCategory(department, klass, subclass) {
  const d = String(department || '').toUpperCase().trim();
  const c = String(klass || '').toUpperCase().trim();
  const s = String(subclass || '').toUpperCase().trim();

  if (d === 'TOOL RENTAL') return 'Tool Rental';
  if (d === 'PLUMBING' || d === 'KIT/BATH') return 'Plumbing';
  if (d === 'ELECTRICAL') return 'Electrical';
  if (d === 'WALL&FLOOR COVER.') return 'Flooring';
  if (d === 'MILLWORK') return 'Doors & Windows';

  if (d === 'LUMBER') return 'Lumber & Decking';

  if (d === 'BLDG. MATERIALS') {
    if (c === 'CONCRETE') return 'Concrete & Stucco';
    if (c === 'GYPSUM') return 'Drywall & Patch';
    if (c === 'ROOFING') return 'Roofing';
    if (c === 'METAL PRODUCTS') return 'Metal Products';
    if (c === 'INSULATION') return 'Insulation';
    return 'Building Materials';
  }

  if (d === 'PAINT') {
    if (c === 'CAULKS' || c === 'SEALANTS') return 'Caulks & Sealants';
    if (c === 'EXTERIOR PAINT' || c === 'INTERIOR PAINT' || c === 'PRIMERS' || c === 'PAINT' || c === 'STAIN/CLEAR FINISH') return 'Paint';
    if (c === 'PATCHING & REPAIR' || c === 'PATCH/REPAIR') return 'Drywall & Patch';
    return 'Paint Tools & Supplies'; // applicators, tape, sheeting, solvents, tarps, etc.
  }

  if (d === 'HARDWARE') {
    if (c === 'FASTENERS') return 'Fasteners';
    if (c === 'SECURITY/SAFETY' || c === 'SAFETY') return 'Safety & PPE';
    if (c === 'POWER TOOL ACCESSORIES' || c === 'PORTABLE POWER' || c === 'HAND TOOLS') return 'Tools & Accessories';
    return 'Hardware';
  }

  if (d === 'GARDEN/SEASONAL') {
    if (c === 'HARDSCAPES') return 'Hardscapes & Site';
    if (c === 'CLEANING' || c === 'CONVENIENCE') return 'Cleaning & Consumables';
    return 'Cleaning & Consumables';
  }

  return 'Other';
}

// Canonical list (for the admin filter dropdown). Order roughly by how
// often AGX uses each category on Central-FL exterior work.
const KNOWN_CATEGORIES = [
  'Lumber & Decking',
  'Paint',
  'Caulks & Sealants',
  'Paint Tools & Supplies',
  'Fasteners',
  'Hardware',
  'Tools & Accessories',
  'Safety & PPE',
  'Concrete & Stucco',
  'Drywall & Patch',
  'Roofing',
  'Metal Products',
  'Insulation',
  'Plumbing',
  'Electrical',
  'Flooring',
  'Doors & Windows',
  'Hardscapes & Site',
  'Cleaning & Consumables',
  'Building Materials',
  'Tool Rental',
  'Other'
];

// Accounting parentheses mean negative — "(12.34)" is -12.34, not 0.
// SheetJS hands us formatted text, so a credit/return line arrives
// wrapped rather than signed, and a bare parseFloat yields NaN which the
// isNaN guard would silently turn into 0. Same trap that made the QB cost
// importer swallow $548,611.24 of credits; see js/job-costs-import.js.
function num(v) {
  if (v == null) return 0;
  let s = String(v).replace(/[$,\s]/g, '').replace(/−/g, '-').trim(); // U+2212 → ASCII minus
  const paren = /^\(.*\)$/.test(s);
  if (paren) s = s.slice(1, -1);
  const n = parseFloat(s);
  if (isNaN(n)) return 0;
  return paren ? -Math.abs(n) : n;
}

// Safe string coercion — SheetJS returns numeric columns (SKU Number,
// Internet SKU, etc.) as JS numbers, so .trim() on them throws. This
// helper converts anything to a trimmed string and treats null/undefined
// as ''.
function str(v) {
  if (v == null) return '';
  return String(v).trim();
}

// ──────────────────────────────────────────────────────────────────
// GET /api/materials — browse with filters. Supports search + subgroup
// + hidden filtering. Capped at 200 by default to keep responses snappy
// when the catalog grows large.
// ──────────────────────────────────────────────────────────────────
router.get('/', requireAuth, requireCapability('ESTIMATES_VIEW'), async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const subgroup = (req.query.subgroup || '').trim();
    const showHidden = req.query.show_hidden === '1';
    const favoritesOnly = req.query.favorites_only === '1';
    const limit = Math.min(parseInt(req.query.limit || '200', 10) || 200, 1000);

    const category = (req.query.category || '').trim();
    const where = [];
    const params = [];
    let p = 1;
    // Per-org catalog (tolerant OR-IS-NULL during rollout).
    const orgId = req.user.organization_id;
    where.push('(m.organization_id = $' + p++ + ' OR m.organization_id IS NULL)'); params.push(orgId);
    if (!showHidden) where.push('m.is_hidden = false');
    if (subgroup) { where.push('m.agx_subgroup = $' + p++); params.push(subgroup); }
    if (category) { where.push('m.category = $' + p++); params.push(category); }
    if (q) {
      // Simple ILIKE match for now — gin index will get used when we move
      // to to_tsvector @@ plainto_tsquery later. Catalog should stay
      // small enough that ILIKE is fine.
      where.push('(m.description ILIKE $' + p + ' OR m.raw_description ILIKE $' + p + ' OR m.sku ILIKE $' + p + ')');
      params.push('%' + q + '%');
      p++;
    }
    // Materials Catalog Drawer phase 2 — favorites filter chip. Inner-
    // joins-by-filter through the LEFT JOIN below: f.user_id is the
    // foreign key, so requiring it non-null restricts to rows the
    // current user has starred.
    if (favoritesOnly) {
      where.push('f.user_id IS NOT NULL');
    }
    // Phase 2 — every row carries is_favorited so the drawer can
    // render the star state without a second round-trip. LEFT JOIN
    // keyed by the current user keeps the cardinality stable (one
    // row per material, regardless of favorite state).
    params.push(req.user.id);
    const userIdParam = p++;
    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    params.push(limit);
    const limitParam = p++;
    const { rows } = await pool.query(
      `SELECT m.id, m.vendor, m.sku, m.description, m.raw_description,
              m.hd_department, m.hd_class, m.hd_subclass, m.agx_subgroup, m.category, m.unit,
              m.last_unit_price, m.avg_unit_price, m.min_unit_price, m.max_unit_price,
              m.total_qty, m.purchase_count, m.first_seen, m.last_seen,
              m.is_hidden, m.manual_override, m.notes, m.updated_at,
              m.price_basis, m.price_rationale, m.researched_price, m.needs_pricing, m.size_nominal,
              (f.user_id IS NOT NULL) AS is_favorited
       FROM materials m
       LEFT JOIN user_material_favorites f
         ON f.material_id = m.id AND f.user_id = $${userIdParam}
       ${whereClause}
       ORDER BY (f.user_id IS NOT NULL) DESC,
                m.purchase_count DESC,
                m.last_seen DESC NULLS LAST
       LIMIT $${limitParam}`,
      params
    );
    const totalQ = await pool.query('SELECT COUNT(*)::int AS c FROM materials WHERE (organization_id = $1 OR organization_id IS NULL)', [orgId]);
    res.json({ materials: rows, totalInDb: totalQ.rows[0].c });
  } catch (e) {
    console.error('GET /api/materials error:', e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

// ──────────────────────────────────────────────────────────────────
// POST /api/materials — create a SINGLE material inline (Assembly Cost
// Library linkage). Unlike /import (bulk, admin), this is the ESTIMATOR-
// facing path: when a recipe row has no catalog material to link, create
// one here with a RESEARCHED placeholder price + rationale, then link it.
// Gated ESTIMATES_EDIT (John's call: estimators mint materials on the fly).
//
// Idempotent on the natural key (organization_id, vendor, lower(raw_description))
// — ON CONFLICT DO NOTHING then SELECT, so a collision returns the EXISTING
// row (never double-creates, never double-links).
//
// MONEY-SAFETY: writes NO material_purchases row — a researched price is a
// guess, not a purchase, and must never pollute the actuals feed or
// purchase_count. It lands as last_unit_price with price_basis='researched';
// the resolver (itemUnitCost) reads last_unit_price LIVE, so the moment a
// real purchase recomputes the aggregate the researched value is superseded
// automatically. researched_price keeps the original guess as an immutable
// snapshot. Never freezes an item unit_cost (that would decouple from
// supersession — that decision stays out of this endpoint).
// ──────────────────────────────────────────────────────────────────
router.post('/', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const { material, created } = await matSvc.createResearchedMaterial(pool, req.user.organization_id, req.body || {}, req.user.id);
    if (!material) return res.status(500).json({ error: 'Could not create the material.' });
    res.json({ ok: true, created, material });
  } catch (e) {
    if (e && e.status === 400) return res.status(400).json({ error: e.message });
    console.error('POST /api/materials error:', e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

// ──────────────────────────────────────────────────────────────────
// Materials Catalog Drawer phase 2 — per-user favorites.
//   POST /api/materials/:id/favorite    — pin a SKU
//   DELETE /api/materials/:id/favorite  — unpin
//   GET /api/materials/favorites        — list pinned material_ids
//                                          (drawer uses GET / with
//                                          favorites_only=1 for full
//                                          rows; this is a thin id
//                                          list for cache-warming /
//                                          quick reconciliation)
// All gated on ESTIMATES_VIEW since the drawer is part of the
// estimating workflow. Composite-key INSERT is idempotent via
// ON CONFLICT DO NOTHING.
// ──────────────────────────────────────────────────────────────────

router.post('/:id/favorite', requireAuth, requireCapability('ESTIMATES_VIEW'), async (req, res) => {
  try {
    const materialId = parseInt(req.params.id, 10);
    if (!Number.isFinite(materialId)) return res.status(400).json({ error: 'invalid material id' });
    await pool.query(
      `INSERT INTO user_material_favorites (user_id, material_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, material_id) DO NOTHING`,
      [req.user.id, materialId]
    );
    res.json({ ok: true, material_id: materialId, is_favorited: true });
  } catch (e) {
    console.error('POST /api/materials/:id/favorite error:', e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

router.delete('/:id/favorite', requireAuth, requireCapability('ESTIMATES_VIEW'), async (req, res) => {
  try {
    const materialId = parseInt(req.params.id, 10);
    if (!Number.isFinite(materialId)) return res.status(400).json({ error: 'invalid material id' });
    await pool.query(
      `DELETE FROM user_material_favorites WHERE user_id = $1 AND material_id = $2`,
      [req.user.id, materialId]
    );
    res.json({ ok: true, material_id: materialId, is_favorited: false });
  } catch (e) {
    console.error('DELETE /api/materials/:id/favorite error:', e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

// GET /api/materials/recent — materials this user has recently put on
// an estimate. Derived from estimates.data->'lines' (JSONB blob)
// where the user owns the estimate and any line carries a
// sourceMaterialId — only drawer-added (or sourced) lines since the
// catalog correlation column was added in Phase 2 of the drawer.
// Used by the drawer's empty-search default state so the next time
// the PM opens the drawer they see what they reach for most.
//
// Limit defaults to 25 (small enough for a comfortable scroll-free
// list); window defaults to the last 30 days. Returns the same row
// shape as GET / so the drawer can drop these into its result list
// without a different render path.
router.get('/recent', requireAuth, requireCapability('ESTIMATES_VIEW'), async (req, res) => {
  try {
    const days = Math.max(1, Math.min(180, parseInt(req.query.days || '30', 10) || 30));
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit || '25', 10) || 25));
    // Walk every estimate owned by this user touched within the
    // window, extract every line that has a sourceMaterialId, group
    // by material id, sort by recency + count. The CTE keeps the
    // jsonb_array_elements explode out of the SELECT so the LEFT
    // JOIN on materials is a clean equality join.
    const { rows } = await pool.query(
      `WITH recent_uses AS (
         SELECT
           (line->>'sourceMaterialId')::int AS material_id,
           COUNT(*) AS use_count,
           MAX(e.updated_at)  AS last_used_at
         FROM estimates e,
              LATERAL jsonb_array_elements(COALESCE(e.data->'lines', '[]'::jsonb)) line
         WHERE e.owner_id = $1
           AND e.updated_at >= NOW() - ($2 || ' days')::interval
           AND (line->>'sourceMaterialId') IS NOT NULL
           AND (line->>'sourceMaterialId') ~ '^[0-9]+$'
         GROUP BY (line->>'sourceMaterialId')::int
       )
       SELECT m.id, m.vendor, m.sku, m.description, m.raw_description,
              m.hd_department, m.hd_class, m.hd_subclass, m.agx_subgroup, m.category, m.unit,
              m.last_unit_price, m.avg_unit_price, m.min_unit_price, m.max_unit_price,
              m.total_qty, m.purchase_count, m.first_seen, m.last_seen,
              m.is_hidden, m.manual_override, m.notes, m.updated_at,
              (f.user_id IS NOT NULL) AS is_favorited,
              r.use_count, r.last_used_at
         FROM recent_uses r
         JOIN materials m ON m.id = r.material_id AND m.is_hidden = false
                         AND (m.organization_id = $4 OR m.organization_id IS NULL)
         LEFT JOIN user_material_favorites f
           ON f.material_id = m.id AND f.user_id = $1
        ORDER BY r.last_used_at DESC, r.use_count DESC
        LIMIT $3`,
      [req.user.id, String(days), limit, req.user.organization_id]
    );
    res.json({ materials: rows });
  } catch (e) {
    console.error('GET /api/materials/recent error:', e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

router.get('/favorites', requireAuth, requireCapability('ESTIMATES_VIEW'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT material_id, created_at
         FROM user_material_favorites
        WHERE user_id = $1
        ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json({ favorites: rows });
  } catch (e) {
    console.error('GET /api/materials/favorites error:', e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

// ──────────────────────────────────────────────────────────────────
// Materials Consolidation — group catalog "likes" (the same real product
// wearing different HD descriptions) so an estimator can mint ONE canonical
// "part" with a buy-count-weighted blended price + a clean unit. This is the
// READ-ONLY suggestion pass (Slice 1); POST /consolidate (Slice 3) does the
// write. Heuristic + human-ratified: dimensioned lumber clusters HIGH-conf by
// dimension|length|treatment (four "2x4x8 stud" descriptions → one part);
// everything else clusters MEDIUM by a normalized significant-token signature.
// ──────────────────────────────────────────────────────────────────
const _NOISE = new Set(['gc', 'wshld', 'weathershield', '2p', 'ea', 'ft', 'lf', 'pc', 'pk', 'pcs', 'the', 'and', 'for', 'with', 'in', 'sng', 'prem', 'premium', 'prime', 'grade', 'each']);
const _STUD_INCH = { '92': 8, '93': 8, '96': 8, '104': 9, '105': 9, '108': 9, '116': 10, '117': 10, '120': 10 };
// Canonical dimensional-lumber / sheet-good nominals, thin x wide orientation
// ONLY (real callouts are 2x4, never 4x2). A dimension NOT in this set is
// almost always a fastener/hardware spec (1/4 x 2 lag screw, 4 x 3/8 roller)
// that must NOT masquerade as lumber.
const _LUMBER_DIMS = new Set([
  '1x2', '1x3', '1x4', '1x6', '1x8', '1x10', '1x12',
  '2x2', '2x3', '2x4', '2x6', '2x8', '2x10', '2x12',
  '4x4', '4x6', '6x6', '6x8', '8x8',
  '4x8', '4x9', '4x10', '4x12'          // sheet goods
]);
const _SHEET_DIMS = new Set(['4x8', '4x9', '4x10', '4x12']);
const _WOOD_RE = /LUMBER|BOARD|STUD|PLYWOOD|\bOSB\b|SUBFLOOR|SHEATH|\bPLY\b|\bMDF\b|\bRTD\b|\bP\.?T\b|PINE|CEDAR|\bFIR\b|SPRUCE|\bSPF\b|\bSYP\b|WHITEWOOD|TIMBER|FURRING|PICKET|\bLVL\b/;
function _dimOf(s) {
  // first number NOT preceded by a digit or slash (rejects 1/4 -> 4), second
  // number NOT followed by a slash or digit (rejects 4 X 3/8) -> only whole
  // NxM callouts survive; fastener fractions are filtered out.
  const m = String(s || '').match(/(?:^|[^0-9\/])([1-9])\s*[xX]\s*([0-9]{1,2})(?![0-9\/])/);
  return m ? (m[1] + 'x' + m[2]) : null;
}
function _treatOf(s) {
  const u = String(s || '').toUpperCase();
  if (/\bP\.?T\b|TREAT|GROUND CONTACT|\bGC\b|WEATHERSHIELD|WSHLD|PRESSURE/.test(u)) return 'PT';
  if (/STUD|\bKD\b|WHITEWOOD|\bWW\b|#2|PRIME|\bSYP\b|SPRUCE|\bFIR\b/.test(u)) return 'STD';
  return '';
}
function _lenFtOf(s) {
  const u = String(s || '').toUpperCase();
  let m = u.match(/\b([0-9]{1,2})\s*(?:FT|')\b/) || u.match(/-([0-9]{1,2})\b(?!\s*\/)/);
  if (m) { const n = parseInt(m[1], 10); if (n >= 2 && n <= 28) return n; }
  const im = u.match(/\b(9[0-9]|1[0-1][0-9]|12[0-9])\b/);
  if (im) { const inch = parseInt(im[1], 10); if (_STUD_INCH[String(inch)]) return _STUD_INCH[String(inch)]; if (inch >= 36) return Math.round(inch / 12); }
  return null;
}
function _thickOf(s) { const m = String(s || '').match(/(?:^|\s)(\d{1,2}\/\d{1,2})(?=\s|"|IN\b)/i); return m ? m[1] : ''; }
function _sigTokens(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 1 && !_NOISE.has(w)).sort();
}
function _clusterKey(m) {
  const raw = (m.raw_description || m.description || '');
  const dim = _dimOf(raw);
  if (dim && _LUMBER_DIMS.has(dim)) {
    const t = _treatOf(raw);
    const wood = _WOOD_RE.test(raw.toUpperCase());
    if (t || wood) {                                   // real wood context required to earn "high"
      if (_SHEET_DIMS.has(dim)) {                       // sheets differ by THICKNESS, not length
        const th = _thickOf(raw);
        return { key: 'SHT|' + dim + '|' + (th || '?'), conf: 'high', dim: dim, len: null, treat: '', thick: th, sheet: true };
      }
      const L = _lenFtOf(raw);
      return { key: 'LUM|' + dim + '|' + (L || '?') + '|' + (t || '?'), conf: 'high', dim: dim, len: L, treat: t };
    }
  }
  const sig = _sigTokens(raw).slice(0, 6).join(' ');
  return { key: 'TOK|' + sig, conf: 'medium', dim: null, len: null, treat: '' };
}
router.get('/consolidation-candidates', requireAuth, requireCapability('ESTIMATES_VIEW'), async (req, res) => {
  try {
    const orgId = req.user.organization_id;
    const { rows } = await pool.query(
      `SELECT id, description, raw_description, unit, category, agx_subgroup,
              last_unit_price, avg_unit_price, purchase_count, price_basis, size_nominal
         FROM materials
        WHERE (organization_id = $1 OR organization_id IS NULL) AND is_hidden = false`,
      [orgId]
    );
    const groups = new Map();
    for (const m of rows) {
      const ck = _clusterKey(m);
      if (!groups.has(ck.key)) groups.set(ck.key, { meta: ck, members: [] });
      groups.get(ck.key).members.push(m);
    }
    const candidates = [];
    for (const g of groups.values()) {
      if (g.members.length < 2) continue;                       // a group of 1 isn't a consolidation
      let wsum = 0, psum = 0, buys = 0; const unitCt = {}, catCt = {};
      for (const m of g.members) {
        const price = Number(m.avg_unit_price != null ? m.avg_unit_price : m.last_unit_price);
        const w = Math.max(Number(m.purchase_count) || 0, 1);
        if (Number.isFinite(price) && price >= 0) { wsum += w; psum += price * w; }
        buys += Number(m.purchase_count) || 0;
        const u = (m.unit || 'ea'); unitCt[u] = (unitCt[u] || 0) + w;
        if (m.category) catCt[m.category] = (catCt[m.category] || 0) + 1;
      }
      const blended = wsum > 0 ? Math.round(psum / wsum * 100) / 100 : null;
      const suggestedUnit = Object.keys(unitCt).sort((a, b) => unitCt[b] - unitCt[a])[0] || 'ea';
      const category = Object.keys(catCt).sort((a, b) => catCt[b] - catCt[a])[0] || null;
      let suggestedName;
      if (g.meta.sheet) {
        suggestedName = (g.meta.thick && g.meta.thick !== '?' ? (g.meta.thick + '" ') : '') + g.meta.dim.replace('x', '×');
      } else if (g.meta.dim) {
        const treatLabel = g.meta.treat === 'PT' ? 'PT' : (g.meta.treat === 'STD' ? 'Stud' : '');
        suggestedName = (g.meta.dim.replace('x', '×')) + (g.meta.len ? ('×' + g.meta.len) : '') + (treatLabel ? (' ' + treatLabel) : '');
      } else {
        const top = g.members.slice().sort((a, b) => (b.purchase_count || 0) - (a.purchase_count || 0))[0];
        suggestedName = String(top.description || top.raw_description || '').slice(0, 60);
      }
      candidates.push({
        key: g.meta.key, confidence: g.meta.conf, suggestedName: suggestedName,
        suggestedUnit: suggestedUnit, blendedPrice: blended, totalBuys: buys, category: category,
        members: g.members.map((m) => ({
          id: m.id, description: m.description, raw_description: m.raw_description,
          unit: m.unit, last_unit_price: m.last_unit_price, avg_unit_price: m.avg_unit_price,
          purchase_count: m.purchase_count, price_basis: m.price_basis
        }))
      });
    }
    const cw = (g) => (g.confidence === 'high' ? 1 : 0);        // high-confidence lumber/sheets lead
    candidates.sort((a, b) => (cw(b) - cw(a)) || (b.totalBuys - a.totalBuys) || (b.members.length - a.members.length));
    res.json({ scanned: rows.length, groupCount: candidates.length, candidates: candidates.slice(0, 80) });
  } catch (e) {
    console.error('GET /api/materials/consolidation-candidates error:', e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

// POST /api/materials/consolidate — fold catalog "likes" into ONE canonical
// "part". MONEY-SAFE: mints a researched material (createResearchedMaterial
// writes NO material_purchases row), hides the member SKUs (reversible — never
// deleted), and re-points any assembly recipe rows onto the new part so no
// recipe is left pointing at a hidden material. Org-owned members ONLY — a
// shared/global (organization_id IS NULL) row is never mutated (that would leak
// across orgs). Single transaction; rolls back on any failure.
router.post('/consolidate', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  const orgId = req.user.organization_id;
  const userId = req.user.id;
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const unit = (b.unit != null && String(b.unit).trim() !== '') ? String(b.unit).trim() : null;
  const category = (b.category != null && String(b.category).trim() !== '') ? String(b.category).trim() : null;
  let blended = null;
  if (b.blendedPrice != null && b.blendedPrice !== '') {
    const n = Number(b.blendedPrice);
    if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'Price must be a number of 0 or more.' });
    blended = Math.round(n * 100) / 100;
  }
  const memberIds = Array.isArray(b.memberIds)
    ? b.memberIds.map((x) => parseInt(x, 10)).filter((x) => Number.isFinite(x)) : [];
  if (!name) return res.status(400).json({ error: 'A part name is required.' });
  if (!memberIds.length) return res.status(400).json({ error: 'Select at least one catalog SKU to consolidate.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Load ONLY this org's members (strict organization_id — never a shared/
    // global row). Any selected id that isn't an org-owned material fails loud.
    const mem = await client.query(
      `SELECT id, agx_subgroup FROM materials WHERE id = ANY($1::int[]) AND organization_id = $2`,
      [memberIds, orgId]
    );
    const foundIds = mem.rows.map((r) => r.id);
    const missing = memberIds.filter((id) => foundIds.indexOf(id) === -1);
    if (missing.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Some selected SKUs aren\'t in your catalog (shared or removed items can\'t be consolidated).', missing: missing });
    }
    // Canonical part lives in its own vendor namespace ('agx_standard') so it
    // never collides with a real home_depot purchase row; createResearchedMaterial
    // is idempotent on (org, vendor, lower(raw_description)).
    const subCt = {};
    mem.rows.forEach((r) => { const s = r.agx_subgroup || 'materials'; subCt[s] = (subCt[s] || 0) + 1; });
    const subgroup = Object.keys(subCt).sort((a, c) => subCt[c] - subCt[a])[0] || 'materials';
    const mk = await matSvc.createResearchedMaterial(client, orgId, {
      description: name,
      raw_description: name,
      vendor: 'agx_standard',
      unit: unit,
      category: category,
      agx_subgroup: subgroup,
      last_unit_price: blended,
      price_rationale: 'AGX standard part — buy-count-weighted blend of ' + memberIds.length + ' purchased SKU' + (memberIds.length === 1 ? '' : 's') + '.',
      notes: 'Consolidated part (Materials Consolidation).'
    }, userId);
    const part = mk.material;
    if (!part || !part.id) { await client.query('ROLLBACK'); return res.status(500).json({ error: 'Could not create the canonical part.' }); }
    const newId = part.id;
    const foldIds = memberIds.filter((id) => id !== newId);          // never fold a part into itself
    let repointed = 0;
    if (foldIds.length) {
      // Re-point recipe rows members -> canonical part (keeps every recipe on a
      // visible, priced material instead of a soon-to-be-hidden one).
      const rp = await client.query(
        `UPDATE assembly_items SET material_id = $1 WHERE material_id = ANY($2::int[])`,
        [newId, foldIds]
      );
      repointed = rp.rowCount || 0;
      // Hide the folded members (reversible; record where they went).
      await client.query(
        `UPDATE materials
            SET is_hidden = true, manual_override = true,
                notes = COALESCE(notes || ' | ', '') || $3::text
          WHERE id = ANY($2::int[]) AND organization_id = $1`,
        [orgId, foldIds, '→ consolidated into #' + newId + ' (' + name + ')']
      );
    }
    await client.query('COMMIT');
    res.json({ material: part, created: mk.created, memberCount: foldIds.length, repointed: repointed });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (e2) {}
    console.error('POST /api/materials/consolidate error:', e);
    res.status(e.status || 500).json({ error: e.message || 'Server error' });
  } finally {
    client.release();
  }
});

// PUT /api/materials/:id — admin can fix description, subgroup, hidden,
// notes. Sets manual_override so subsequent re-imports don't clobber.
router.put('/:id', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const allowed = ['description', 'agx_subgroup', 'category', 'unit', 'is_hidden', 'notes'];
    const sets = [];
    const params = [];
    let p = 1;
    for (const k of allowed) {
      if (Object.prototype.hasOwnProperty.call(req.body, k)) {
        sets.push(k + ' = $' + p++);
        params.push(req.body[k]);
      }
    }
    if (!sets.length) return res.json({ ok: true, unchanged: true });
    // Normalization-field edits become training examples (raw vendor text →
    // human-corrected clean form). Read the pre-edit machine values first —
    // UPDATE..RETURNING only yields post-update values.
    const NORMALIZE_FIELDS = ['description', 'agx_subgroup', 'category', 'unit'];
    const touchesNormalize = NORMALIZE_FIELDS.some((k) => Object.prototype.hasOwnProperty.call(req.body, k));
    let prior = null;
    if (touchesNormalize) {
      const pr = await pool.query(
        `SELECT raw_description, description, agx_subgroup, category, unit, hd_department, hd_class, hd_subclass, vendor
           FROM materials WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)`,
        [req.params.id, req.user.organization_id]
      );
      prior = pr.rows[0] || null;
    }
    sets.push('manual_override = true');
    sets.push('updated_at = NOW()');
    params.push(req.params.id);
    params.push(req.user.organization_id);
    // SAFE: column names iterate the hardcoded `allowed` array above (description / agx_subgroup / category / unit / is_hidden / notes).
    await pool.query(`UPDATE materials SET ${sets.join(', ')} WHERE id = $${p} AND (organization_id = $${p + 1} OR organization_id IS NULL)`, params);
    res.json({ ok: true });
    if (prior && prior.raw_description) {
      const finals = {};
      NORMALIZE_FIELDS.forEach((k) => {
        finals[k] = Object.prototype.hasOwnProperty.call(req.body, k) ? req.body[k] : prior[k];
      });
      captureExample({
        // Latest correction wins per material: timestamped id (no dedupe) —
        // an admin refining twice yields two examples, both real signal.
        orgId: req.user.organization_id,
        task: TASKS.MATERIAL_NORMALIZE,
        sourceKind: 'material',
        sourceId: String(req.params.id),
        input: {
          raw_description: prior.raw_description,
          vendor: prior.vendor || null,
          hd_department: prior.hd_department || null,
          hd_class: prior.hd_class || null,
          hd_subclass: prior.hd_subclass || null
        },
        modelOutput: { description: prior.description, agx_subgroup: prior.agx_subgroup, category: prior.category, unit: prior.unit },
        humanFinal: finals,
        accepted: false, // an override IS a correction by definition
        model: null // current normalizer is deterministic (cleanDescription), not a model
      });
    }
  } catch (e) {
    console.error('PUT /api/materials/:id error:', e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

// POST /api/materials/import — bulk ingest from a parsed vendor CSV.
// Body: { vendor: 'home_depot', source_file: 'filename.csv', rows: [...] }
// Each row matches HD's column headers (Date, SKU Number, SKU Description,
// Quantity, Unit Price, Net Unit Price, Department Name, Class Name,
// Subclass Name, Job Name, Store Number, Transaction ID).
//
// What it does:
//   1. Skip $0 fees (delivery, etc.) and rows with no description
//   2. Insert a material_purchases row per CSV row (incl. returns)
//   3. Group by cleaned-description; upsert into materials with rolled-up
//      stats (last/avg/min/max price, total qty net of returns, first/last
//      seen, purchase count)
//   4. Don't overwrite description/subgroup/unit on materials that have
//      manual_override = true (admin already curated them)
router.post('/import', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  const vendor = (req.body && req.body.vendor) || 'home_depot';
  const sourceFile = (req.body && req.body.source_file) || null;
  const rows = (req.body && Array.isArray(req.body.rows)) ? req.body.rows : null;
  if (!rows || !rows.length) return res.status(400).json({ error: 'rows array is required' });
  // Per-org catalog: stamp every imported material + purchase with the
  // caller's org, and match the natural-key upsert within that org only.
  const orgId = req.user && req.user.organization_id;
  if (!orgId) return res.status(400).json({ error: 'No organization context' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ─── PASS 1: clean + group rows by natural key ────────────────
    // Skip rejects (fees, blanks, $0 lines) but keep returns — they net
    // against positive purchases below.
    const grouped = new Map(); // key = vendor + lower(rawDesc)
    let skipped = 0;
    for (const r of rows) {
      const rawDesc = str(r['SKU Description']);
      if (!rawDesc) { skipped++; continue; }
      const dept = str(r['Department Name']);
      if (dept.toUpperCase() === 'FEES') { skipped++; continue; }
      const cleaned = cleanDescription(rawDesc);
      const subgroup = mapHdToAgxSubgroup(dept, str(r['Class Name']), str(r['Subclass Name']));
      if (!subgroup) { skipped++; continue; }
      const category = mapHdToCategory(dept, str(r['Class Name']), str(r['Subclass Name']));
      const key = vendor + '|' + rawDesc.toLowerCase();
      if (!grouped.has(key)) {
        grouped.set(key, {
          vendor,
          sku: str(r['SKU Number']) || null,
          internet_sku: str(r['Internet SKU']) || null,
          raw_description: rawDesc,
          description: cleaned,
          hd_department: dept || null,
          hd_class: str(r['Class Name']) || null,
          hd_subclass: str(r['Subclass Name']) || null,
          agx_subgroup: subgroup,
          category: category,
          unit: inferUnit(cleaned),
          purchases: [],
          // Aggregates filled below
          last_unit_price: null,
          avg_unit_price: null,
          min_unit_price: null,
          max_unit_price: null,
          total_qty: 0,
          purchase_count: 0,
          first_seen: null,
          last_seen: null
        });
      }
      const entry = grouped.get(key);
      const qty = num(r['Quantity']);
      const unitPrice = num(r['Unit Price']);
      const netUnitPrice = num(r['Net Unit Price']);
      const isReturn = qty < 0 || unitPrice < 0;
      // Robust date coercion: HD's CSV ships ISO dates ("2026-04-29")
      // but a misbehaving client (e.g., SheetJS without raw:false) might
      // send a JS Date object whose toString is "Wed Apr 29 2026 ...".
      // Match either by extracting a YYYY-MM-DD substring.
      let date = null;
      if (r['Date']) {
        const dStr = String(r['Date']);
        const m = dStr.match(/(\d{4}-\d{2}-\d{2})/);
        if (m) {
          date = m[1];
        } else {
          // Fall back to JS Date parsing for native Date objects / unusual formats
          const parsed = new Date(dStr);
          if (!isNaN(parsed.getTime())) {
            date = parsed.toISOString().slice(0, 10);
          }
        }
      }
      entry.purchases.push({
        purchase_date: date,
        store_number: str(r['Store Number']) || null,
        transaction_id: str(r['Transaction ID']) || null,
        job_name: str(r['Job Name']) || null,
        quantity: qty,
        unit_price: Math.abs(unitPrice),
        net_unit_price: Math.abs(netUnitPrice) || Math.abs(unitPrice),
        is_return: isReturn
      });
    }

    // ─── PASS 2: compute aggregates per material ──────────────────
    let priceTouched = 0;
    for (const entry of grouped.values()) {
      const positives = entry.purchases.filter(p => !p.is_return);
      if (positives.length) {
        const prices = positives.map(p => p.net_unit_price).filter(x => x > 0);
        if (prices.length) {
          entry.last_unit_price = positives.slice().sort((a, b) =>
            String(b.purchase_date).localeCompare(String(a.purchase_date))
          )[0].net_unit_price;
          entry.avg_unit_price = +(prices.reduce((s, n) => s + n, 0) / prices.length).toFixed(2);
          entry.min_unit_price = Math.min(...prices);
          entry.max_unit_price = Math.max(...prices);
          priceTouched++;
        }
      }
      // Net qty = positives - returns
      let netQty = 0;
      entry.purchases.forEach(p => { netQty += p.is_return ? -Math.abs(p.quantity) : Math.abs(p.quantity); });
      entry.total_qty = +netQty.toFixed(2);
      entry.purchase_count = positives.length;
      const dates = entry.purchases.map(p => p.purchase_date).filter(Boolean).sort();
      entry.first_seen = dates[0] || null;
      entry.last_seen = dates[dates.length - 1] || null;
    }

    // ─── PASS 3: bulk upsert into materials (batched) ─────────────
    // Old loop did one SELECT + one UPDATE/INSERT + N purchase INSERTs
    // per material — for AGX's first import (~1,500 materials, ~5,600
    // purchases) that was ~7,000 round-trips and tripped Railway's
    // first-byte timeout. This pass collapses it to ~6 queries:
    //   1. one SELECT for ALL existing materials at once
    //   2. one bulk INSERT for new materials (returning ids)
    //   3. one bulk UPDATE for existing materials
    //   4. one bulk INSERT for material_purchases (chunked)
    let inserted = 0, updated = 0, protected_ = 0;

    // Step 3a: load all existing materials by raw_description
    const allEntries = Array.from(grouped.values());
    const lowerDescs = allEntries.map(e => e.raw_description.toLowerCase());
    const existingMap = new Map(); // lower(raw_description) -> {id, manual_override}
    if (lowerDescs.length) {
      const existRes = await client.query(
        `SELECT id, manual_override, lower(raw_description) AS key
         FROM materials
         WHERE organization_id = $1 AND vendor = $2 AND lower(raw_description) = ANY($3::text[])`,
        [orgId, vendor, lowerDescs]
      );
      for (const row of existRes.rows) {
        existingMap.set(row.key, { id: row.id, manual_override: row.manual_override });
      }
    }

    // Partition entries into insert / update / protected lists
    const toInsert = [];
    const toUpdateFull = [];      // refresh description/subgroup/unit + stats
    const toUpdateStatsOnly = []; // protected — only refresh stats
    for (const entry of allEntries) {
      const key = entry.raw_description.toLowerCase();
      const ex = existingMap.get(key);
      if (!ex) {
        toInsert.push(entry);
      } else if (ex.manual_override) {
        toUpdateStatsOnly.push({ entry, id: ex.id });
      } else {
        toUpdateFull.push({ entry, id: ex.id });
      }
    }

    // Step 3b: bulk INSERT new materials. We chunk to keep prepared-
    // statement parameter counts under PG's 65535-param limit (each row
    // is 18 cols, so ~3,600 rows per chunk is the ceiling — pick 500
    // for safety).
    const newIds = []; // parallel array to toInsert giving each its new id
    if (toInsert.length) {
      const CHUNK = 500;
      for (let i = 0; i < toInsert.length; i += CHUNK) {
        const slice = toInsert.slice(i, i + CHUNK);
        const placeholders = [];
        const params = [];
        let p = 1;
        for (const e of slice) {
          placeholders.push(
            `($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, ` +
            `$${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`
          );
          params.push(
            e.vendor, e.sku, e.internet_sku, e.raw_description, e.description,
            e.hd_department, e.hd_class, e.hd_subclass, e.agx_subgroup, e.category, e.unit,
            e.last_unit_price, e.avg_unit_price, e.min_unit_price, e.max_unit_price,
            e.total_qty, e.purchase_count, e.first_seen, e.last_seen, orgId
          );
        }
        const { rows: ins } = await client.query(
          `INSERT INTO materials
             (vendor, sku, internet_sku, raw_description, description,
              hd_department, hd_class, hd_subclass, agx_subgroup, category, unit,
              last_unit_price, avg_unit_price, min_unit_price, max_unit_price,
              total_qty, purchase_count, first_seen, last_seen, organization_id)
           VALUES ${placeholders.join(',')}
           RETURNING id`,
          params
        );
        for (const r of ins) newIds.push(r.id);
        inserted += slice.length;
      }
    }

    // Step 3c: bulk UPDATE — full (description + subgroup + unit + stats)
    // for non-protected rows. Use a single UPDATE ... FROM (VALUES ...)
    // pattern so all rows update in one round-trip.
    if (toUpdateFull.length) {
      const CHUNK = 500;
      for (let i = 0; i < toUpdateFull.length; i += CHUNK) {
        const slice = toUpdateFull.slice(i, i + CHUNK);
        const valuesRows = [];
        const params = [];
        let p = 1;
        for (const u of slice) {
          const e = u.entry;
          valuesRows.push(
            `($${p++}::int, $${p++}::text, $${p++}::text, $${p++}::text, $${p++}::text, ` +
            `$${p++}::numeric, $${p++}::numeric, $${p++}::numeric, $${p++}::numeric, ` +
            `$${p++}::numeric, $${p++}::int, $${p++}::date, $${p++}::date, ` +
            `$${p++}::text, $${p++}::text, $${p++}::text, $${p++}::text, $${p++}::text)`
          );
          params.push(
            u.id, e.description, e.agx_subgroup, e.category, e.unit,
            e.last_unit_price, e.avg_unit_price, e.min_unit_price, e.max_unit_price,
            e.total_qty, e.purchase_count, e.first_seen, e.last_seen,
            e.sku, e.internet_sku, e.hd_department, e.hd_class, e.hd_subclass
          );
        }
        await client.query(
          `UPDATE materials AS m SET
             description = v.description,
             agx_subgroup = v.agx_subgroup,
             category = v.category,
             unit = v.unit,
             last_unit_price = v.last_unit_price,
             avg_unit_price = v.avg_unit_price,
             min_unit_price = v.min_unit_price,
             max_unit_price = v.max_unit_price,
             total_qty = v.total_qty,
             purchase_count = v.purchase_count,
             first_seen = v.first_seen,
             last_seen = v.last_seen,
             sku = v.sku,
             internet_sku = v.internet_sku,
             hd_department = v.hd_department,
             hd_class = v.hd_class,
             hd_subclass = v.hd_subclass,
             updated_at = NOW()
           FROM (VALUES ${valuesRows.join(',')}) AS v(
             id, description, agx_subgroup, category, unit,
             last_unit_price, avg_unit_price, min_unit_price, max_unit_price,
             total_qty, purchase_count, first_seen, last_seen,
             sku, internet_sku, hd_department, hd_class, hd_subclass
           )
           WHERE m.id = v.id`,
          params
        );
        updated += slice.length;
      }
    }

    // Step 3d: bulk UPDATE — stats-only for admin-protected rows.
    if (toUpdateStatsOnly.length) {
      const CHUNK = 500;
      for (let i = 0; i < toUpdateStatsOnly.length; i += CHUNK) {
        const slice = toUpdateStatsOnly.slice(i, i + CHUNK);
        const valuesRows = [];
        const params = [];
        let p = 1;
        for (const u of slice) {
          const e = u.entry;
          valuesRows.push(
            `($${p++}::int, $${p++}::numeric, $${p++}::numeric, $${p++}::numeric, $${p++}::numeric, ` +
            `$${p++}::numeric, $${p++}::int, $${p++}::date, $${p++}::date, ` +
            `$${p++}::text, $${p++}::text, $${p++}::text, $${p++}::text, $${p++}::text)`
          );
          params.push(
            u.id,
            e.last_unit_price, e.avg_unit_price, e.min_unit_price, e.max_unit_price,
            e.total_qty, e.purchase_count, e.first_seen, e.last_seen,
            e.sku, e.internet_sku, e.hd_department, e.hd_class, e.hd_subclass
          );
        }
        await client.query(
          `UPDATE materials AS m SET
             last_unit_price = v.last_unit_price,
             avg_unit_price = v.avg_unit_price,
             min_unit_price = v.min_unit_price,
             max_unit_price = v.max_unit_price,
             total_qty = v.total_qty,
             purchase_count = v.purchase_count,
             first_seen = v.first_seen,
             last_seen = v.last_seen,
             sku = v.sku,
             internet_sku = v.internet_sku,
             hd_department = v.hd_department,
             hd_class = v.hd_class,
             hd_subclass = v.hd_subclass,
             updated_at = NOW()
           FROM (VALUES ${valuesRows.join(',')}) AS v(
             id, last_unit_price, avg_unit_price, min_unit_price, max_unit_price,
             total_qty, purchase_count, first_seen, last_seen,
             sku, internet_sku, hd_department, hd_class, hd_subclass
           )
           WHERE m.id = v.id`,
          params
        );
        protected_ += slice.length;
      }
    }

    // Step 3e: bulk INSERT material_purchases. Build the (material_id,
    // purchase) pairs first, then chunk into multi-row INSERTs.
    const allPurchases = [];
    for (let i = 0; i < toInsert.length; i++) {
      const e = toInsert[i];
      const newId = newIds[i];
      for (const p of e.purchases) allPurchases.push({ material_id: newId, p });
    }
    for (const u of toUpdateFull) {
      for (const p of u.entry.purchases) allPurchases.push({ material_id: u.id, p });
    }
    for (const u of toUpdateStatsOnly) {
      for (const p of u.entry.purchases) allPurchases.push({ material_id: u.id, p });
    }
    if (allPurchases.length) {
      const CHUNK = 500;
      for (let i = 0; i < allPurchases.length; i += CHUNK) {
        const slice = allPurchases.slice(i, i + CHUNK);
        const placeholders = [];
        const params = [];
        let p = 1;
        for (const ap of slice) {
          placeholders.push(
            `($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`
          );
          params.push(
            ap.material_id, ap.p.purchase_date, ap.p.store_number, ap.p.transaction_id,
            ap.p.job_name, ap.p.quantity, ap.p.unit_price, ap.p.net_unit_price,
            ap.p.is_return, sourceFile, orgId
          );
        }
        await client.query(
          `INSERT INTO material_purchases
             (material_id, purchase_date, store_number, transaction_id, job_name,
              quantity, unit_price, net_unit_price, is_return, source_file, organization_id)
           VALUES ${placeholders.join(',')}`,
          params
        );
      }
    }

    await client.query('COMMIT');
    res.json({
      ok: true,
      total_rows: rows.length,
      skipped,
      unique_materials: grouped.size,
      inserted,
      updated,
      protected_admin_edits: protected_,
      with_pricing: priceTouched
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('POST /api/materials/import error:', e);
    res.status(500).json({ error: e.message || 'Server error' });
  } finally {
    client.release();
  }
});

// GET /api/materials/categories — canonical list + counts. Drives the
// admin browser's filter dropdown. Counts include only non-hidden rows.
router.get('/meta/categories', requireAuth, requireCapability('ESTIMATES_VIEW'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT category, COUNT(*)::int AS n
       FROM materials
       WHERE is_hidden = false AND category IS NOT NULL
         AND (organization_id = $1 OR organization_id IS NULL)
       GROUP BY category
       ORDER BY n DESC`,
      [req.user.organization_id]
    );
    const counts = new Map(rows.map(r => [r.category, r.n]));
    // Merge canonical list with observed categories so the dropdown
    // always shows every category (with 0 counts for ones not yet
    // present in the catalog) — useful when the user is starting fresh
    // and we want to show what's possible.
    const merged = KNOWN_CATEGORIES.map(name => ({ name, n: counts.get(name) || 0 }));
    // Plus any categories present in DB that aren't in our canonical
    // list (e.g., admin renamed one) — append at the end.
    for (const r of rows) {
      if (!KNOWN_CATEGORIES.includes(r.category)) {
        merged.push({ name: r.category, n: r.n });
      }
    }
    res.json({ categories: merged });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/materials/recategorize — re-runs mapHdToCategory across
// every existing row that doesn't have manual_override. Useful after
// a schema upgrade or rule tweak; faster than re-importing the whole
// CSV. Admin-only.
router.post('/recategorize', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, hd_department, hd_class, hd_subclass
       FROM materials
       WHERE manual_override = false
         AND (organization_id = $1 OR organization_id IS NULL)`,
      [req.user.organization_id]
    );
    let touched = 0;
    // Group by category so we can batch updates by target value — turns
    // ~1,500 individual UPDATEs into ~15 (one per category bucket).
    const byCategory = new Map();
    for (const r of rows) {
      const cat = mapHdToCategory(r.hd_department, r.hd_class, r.hd_subclass);
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat).push(r.id);
    }
    for (const [cat, ids] of byCategory.entries()) {
      if (!ids.length) continue;
      await pool.query(
        `UPDATE materials SET category = $1, updated_at = NOW()
         WHERE id = ANY($2::int[])`,
        [cat, ids]
      );
      touched += ids.length;
    }
    res.json({ ok: true, touched, distinct_categories: byCategory.size });
  } catch (e) {
    console.error('POST /api/materials/recategorize error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
