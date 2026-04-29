// Materials catalog — built from AGX's vendor purchase history
// (Home Depot to start). Drives the AG `search_materials` tool so the
// estimator can ground line-item proposals in actual descriptions and
// AGX-side prices instead of guessing.
//
// Import flow: admin uploads a vendor CSV; the client (admin.js) parses
// it browser-side via SheetJS and POSTs the row array here as JSON. We
// dedupe, net returns, recompute aggregates, and write back. Description
// cleanup (regex) is local — HD's all-caps abbreviated descriptions get
// title-cased + unit-expanded so AG can quote them in proposals.

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireCapability } = require('../auth');

const router = express.Router();

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

function num(v) {
  if (v == null) return 0;
  const s = String(v).replace(/[$,\s]/g, '').trim();
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
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
    const limit = Math.min(parseInt(req.query.limit || '200', 10) || 200, 1000);

    const where = [];
    const params = [];
    let p = 1;
    if (!showHidden) where.push('is_hidden = false');
    if (subgroup) { where.push('agx_subgroup = $' + p++); params.push(subgroup); }
    if (q) {
      // Simple ILIKE match for now — gin index will get used when we move
      // to to_tsvector @@ plainto_tsquery later. Catalog should stay
      // small enough that ILIKE is fine.
      where.push('(description ILIKE $' + p + ' OR raw_description ILIKE $' + p + ' OR sku ILIKE $' + p + ')');
      params.push('%' + q + '%');
      p++;
    }
    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT id, vendor, sku, description, raw_description,
              hd_department, hd_class, hd_subclass, agx_subgroup, unit,
              last_unit_price, avg_unit_price, min_unit_price, max_unit_price,
              total_qty, purchase_count, first_seen, last_seen,
              is_hidden, manual_override, notes, updated_at
       FROM materials
       ${whereClause}
       ORDER BY purchase_count DESC, last_seen DESC NULLS LAST
       LIMIT $${p}`,
      params
    );
    const totalQ = await pool.query('SELECT COUNT(*)::int AS c FROM materials');
    res.json({ materials: rows, totalInDb: totalQ.rows[0].c });
  } catch (e) {
    console.error('GET /api/materials error:', e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

// PUT /api/materials/:id — admin can fix description, subgroup, hidden,
// notes. Sets manual_override so subsequent re-imports don't clobber.
router.put('/:id', requireAuth, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const allowed = ['description', 'agx_subgroup', 'unit', 'is_hidden', 'notes'];
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
    sets.push('manual_override = true');
    sets.push('updated_at = NOW()');
    params.push(req.params.id);
    await pool.query(`UPDATE materials SET ${sets.join(', ')} WHERE id = $${p}`, params);
    res.json({ ok: true });
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

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ─── PASS 1: clean + group rows by natural key ────────────────
    // Skip rejects (fees, blanks, $0 lines) but keep returns — they net
    // against positive purchases below.
    const grouped = new Map(); // key = vendor + lower(rawDesc)
    let skipped = 0;
    for (const r of rows) {
      const rawDesc = (r['SKU Description'] || '').trim();
      if (!rawDesc) { skipped++; continue; }
      const dept = (r['Department Name'] || '').trim();
      if (dept.toUpperCase() === 'FEES') { skipped++; continue; }
      const cleaned = cleanDescription(rawDesc);
      const subgroup = mapHdToAgxSubgroup(dept, r['Class Name'], r['Subclass Name']);
      if (!subgroup) { skipped++; continue; }
      const key = vendor + '|' + rawDesc.toLowerCase();
      if (!grouped.has(key)) {
        grouped.set(key, {
          vendor,
          sku: (r['SKU Number'] || '').trim() || null,
          internet_sku: (r['Internet SKU'] || '').trim() || null,
          raw_description: rawDesc,
          description: cleaned,
          hd_department: dept || null,
          hd_class: (r['Class Name'] || '').trim() || null,
          hd_subclass: (r['Subclass Name'] || '').trim() || null,
          agx_subgroup: subgroup,
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
      const date = r['Date'] ? String(r['Date']).slice(0, 10) : null;
      entry.purchases.push({
        purchase_date: date,
        store_number: (r['Store Number'] || '').toString() || null,
        transaction_id: (r['Transaction ID'] || '').toString() || null,
        job_name: (r['Job Name'] || '').trim() || null,
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

    // ─── PASS 3: upsert into materials ────────────────────────────
    let inserted = 0, updated = 0, protected_ = 0;
    for (const entry of grouped.values()) {
      // Check if this row already exists + has manual_override
      const existing = await client.query(
        `SELECT id, manual_override FROM materials
         WHERE vendor = $1 AND lower(raw_description) = lower($2)`,
        [entry.vendor, entry.raw_description]
      );
      if (existing.rows.length) {
        const m = existing.rows[0];
        // Always refresh price stats + counts. Only refresh description /
        // subgroup / unit when admin hasn't manually curated this row.
        if (m.manual_override) {
          await client.query(
            `UPDATE materials SET
               last_unit_price=$1, avg_unit_price=$2, min_unit_price=$3, max_unit_price=$4,
               total_qty=$5, purchase_count=$6, first_seen=$7, last_seen=$8, sku=$9,
               internet_sku=$10, hd_department=$11, hd_class=$12, hd_subclass=$13,
               updated_at=NOW()
             WHERE id=$14`,
            [entry.last_unit_price, entry.avg_unit_price, entry.min_unit_price, entry.max_unit_price,
             entry.total_qty, entry.purchase_count, entry.first_seen, entry.last_seen, entry.sku,
             entry.internet_sku, entry.hd_department, entry.hd_class, entry.hd_subclass, m.id]
          );
          protected_++;
        } else {
          await client.query(
            `UPDATE materials SET
               description=$1, agx_subgroup=$2, unit=$3,
               last_unit_price=$4, avg_unit_price=$5, min_unit_price=$6, max_unit_price=$7,
               total_qty=$8, purchase_count=$9, first_seen=$10, last_seen=$11, sku=$12,
               internet_sku=$13, hd_department=$14, hd_class=$15, hd_subclass=$16,
               updated_at=NOW()
             WHERE id=$17`,
            [entry.description, entry.agx_subgroup, entry.unit,
             entry.last_unit_price, entry.avg_unit_price, entry.min_unit_price, entry.max_unit_price,
             entry.total_qty, entry.purchase_count, entry.first_seen, entry.last_seen, entry.sku,
             entry.internet_sku, entry.hd_department, entry.hd_class, entry.hd_subclass, m.id]
          );
          updated++;
        }
        // Upsert purchases too — best-effort; we don't dedupe per
        // (transaction_id, material_id, date) here since the import is
        // all-or-nothing per upload. If you re-upload the same CSV, you
        // get duplicate purchase rows. Future: add a UNIQUE constraint.
        for (const p of entry.purchases) {
          await client.query(
            `INSERT INTO material_purchases
               (material_id, purchase_date, store_number, transaction_id, job_name,
                quantity, unit_price, net_unit_price, is_return, source_file)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [m.id, p.purchase_date, p.store_number, p.transaction_id, p.job_name,
             p.quantity, p.unit_price, p.net_unit_price, p.is_return, sourceFile]
          );
        }
      } else {
        const { rows: ins } = await client.query(
          `INSERT INTO materials
             (vendor, sku, internet_sku, raw_description, description,
              hd_department, hd_class, hd_subclass, agx_subgroup, unit,
              last_unit_price, avg_unit_price, min_unit_price, max_unit_price,
              total_qty, purchase_count, first_seen, last_seen)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
           RETURNING id`,
          [entry.vendor, entry.sku, entry.internet_sku, entry.raw_description, entry.description,
           entry.hd_department, entry.hd_class, entry.hd_subclass, entry.agx_subgroup, entry.unit,
           entry.last_unit_price, entry.avg_unit_price, entry.min_unit_price, entry.max_unit_price,
           entry.total_qty, entry.purchase_count, entry.first_seen, entry.last_seen]
        );
        const newId = ins[0].id;
        for (const p of entry.purchases) {
          await client.query(
            `INSERT INTO material_purchases
               (material_id, purchase_date, store_number, transaction_id, job_name,
                quantity, unit_price, net_unit_price, is_return, source_file)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [newId, p.purchase_date, p.store_number, p.transaction_id, p.job_name,
             p.quantity, p.unit_price, p.net_unit_price, p.is_return, sourceFile]
          );
        }
        inserted++;
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

module.exports = router;
