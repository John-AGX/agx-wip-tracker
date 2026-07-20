'use strict';
// Shared materials helpers for the Assembly Cost Library linkage.
// createResearchedMaterial is the ONE code path for minting a single material
// with a researched placeholder price — used by POST /api/materials (estimator
// inline create), the variant-family spin auto-create, and (later) 86's
// material payload target. MONEY-SAFE: writes NO material_purchases row (a
// researched price is a guess, not a purchase); the resolver reads
// last_unit_price LIVE so a real purchase supersedes it automatically.

const SUBGROUPS = ['materials', 'labor', 'gc', 'sub'];

function tokenize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
}

// `db` is any queryable (pool or a txn client). Throws Error (with .status=400)
// on bad input. Idempotent on the natural key (org, vendor, lower(raw_description))
// — returns the existing row (created:false) on collision, never double-creates.
async function createResearchedMaterial(db, orgId, fields, userId) {
  const b = fields || {};
  const description = String(b.description || '').trim();
  if (!description) { const e = new Error('A material description is required.'); e.status = 400; throw e; }
  const vendor = (String(b.vendor || 'home_depot').trim().toLowerCase()) || 'home_depot';
  const rawDescription = (String(b.raw_description || description).trim()) || description;
  const unit = b.unit != null && String(b.unit).trim() !== '' ? String(b.unit).trim() : null;
  const subgroup = SUBGROUPS.includes(String(b.agx_subgroup || '').toLowerCase())
    ? String(b.agx_subgroup).toLowerCase() : 'materials';
  const category = b.category != null && String(b.category).trim() !== '' ? String(b.category).trim() : null;
  const sizeNominal = b.size_nominal != null && String(b.size_nominal).trim() !== '' ? String(b.size_nominal).trim().toUpperCase() : null;
  const rationale = b.price_rationale != null && String(b.price_rationale).trim() !== '' ? String(b.price_rationale).trim() : null;
  const sourceUrl = b.price_source_url != null && String(b.price_source_url).trim() !== '' ? String(b.price_source_url).trim() : null;
  const notesVal = b.notes != null && String(b.notes).trim() !== '' ? String(b.notes).trim() : null;

  let price = null;
  if (b.last_unit_price != null && b.last_unit_price !== '') {
    const n = Number(b.last_unit_price);
    if (!Number.isFinite(n) || n < 0) { const e = new Error('Price must be a number of 0 or more.'); e.status = 400; throw e; }
    price = Math.round(n * 100) / 100;
  }
  const hasPrice = price != null;
  const priceBasis = hasPrice ? 'researched' : 'catalog';

  const ins = await db.query(
    `INSERT INTO materials
       (organization_id, vendor, raw_description, description, unit, agx_subgroup, category,
        last_unit_price, researched_price, price_basis, price_rationale, price_source_url,
        researched_at, researched_by, needs_pricing, size_nominal, manual_override, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NOW(), $13, $14, $15, true, $16)
     ON CONFLICT (organization_id, vendor, lower(raw_description)) DO NOTHING
     RETURNING id`,
    [orgId, vendor, rawDescription, description, unit, subgroup, category,
     price, hasPrice ? price : null, priceBasis, rationale, sourceUrl,
     userId || null, !hasPrice, sizeNominal, notesVal]
  );
  if (ins.rows[0]) {
    const got = await db.query('SELECT * FROM materials WHERE id = $1', [ins.rows[0].id]);
    return { material: got.rows[0], created: true };
  }
  const got = await db.query(
    `SELECT * FROM materials
      WHERE (organization_id = $1 OR organization_id IS NULL)
        AND vendor = $2 AND lower(raw_description) = lower($3)
      ORDER BY organization_id NULLS LAST LIMIT 1`,
    [orgId, vendor, rawDescription]
  );
  return { material: got.rows[0] || null, created: false };
}

// Best-effort: find a catalog material that is the SAME item as `baseMaterial`
// but in `targetSize` (variant-family spin re-links the sized row to it). No
// structured family key yet, so the heuristic is: within the same subgroup,
// an exact size_nominal match wins outright; otherwise a row whose description
// contains the target size token AND shares ≥1 non-numeric word with the base.
// Returns the row or null (caller auto-creates a researched sized material).
async function findSizedSibling(db, orgId, baseMaterial, targetSize) {
  if (!baseMaterial || !targetSize) return null;
  const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const targetNorm = norm(targetSize);
  if (!targetNorm) return null;
  const subgroup = baseMaterial.agx_subgroup || 'materials';
  const q = await db.query(
    `SELECT id, description, unit, last_unit_price, size_nominal, agx_subgroup, price_basis
       FROM materials
      WHERE (organization_id = $1 OR organization_id IS NULL) AND is_hidden = false
        AND COALESCE(agx_subgroup,'materials') = $2 AND id <> $3`,
    [orgId, subgroup, baseMaterial.id]);
  const baseWords = new Set(tokenize(baseMaterial.description).filter((w) => !/^\d/.test(w)));
  let best = null, bestScore = -1;
  for (const m of q.rows) {
    if (m.size_nominal && norm(m.size_nominal) === targetNorm) return m; // exact structured size
    if (norm(m.description).indexOf(targetNorm) === -1) continue;        // must contain the size token
    let overlap = 0; tokenize(m.description).forEach((w) => { if (baseWords.has(w)) overlap++; });
    if (overlap > bestScore) { bestScore = overlap; best = m; }
  }
  return bestScore >= 1 ? best : null;
}

module.exports = { createResearchedMaterial, findSizedSibling, tokenize, SUBGROUPS };
