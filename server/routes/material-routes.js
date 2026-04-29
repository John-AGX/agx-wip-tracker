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

function num(v) {
  if (v == null) return 0;
  const s = String(v).replace(/[$,\s]/g, '').trim();
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
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
      const rawDesc = str(r['SKU Description']);
      if (!rawDesc) { skipped++; continue; }
      const dept = str(r['Department Name']);
      if (dept.toUpperCase() === 'FEES') { skipped++; continue; }
      const cleaned = cleanDescription(rawDesc);
      const subgroup = mapHdToAgxSubgroup(dept, str(r['Class Name']), str(r['Subclass Name']));
      if (!subgroup) { skipped++; continue; }
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
         WHERE vendor = $1 AND lower(raw_description) = ANY($2::text[])`,
        [vendor, lowerDescs]
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
            `$${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`
          );
          params.push(
            e.vendor, e.sku, e.internet_sku, e.raw_description, e.description,
            e.hd_department, e.hd_class, e.hd_subclass, e.agx_subgroup, e.unit,
            e.last_unit_price, e.avg_unit_price, e.min_unit_price, e.max_unit_price,
            e.total_qty, e.purchase_count, e.first_seen, e.last_seen
          );
        }
        const { rows: ins } = await client.query(
          `INSERT INTO materials
             (vendor, sku, internet_sku, raw_description, description,
              hd_department, hd_class, hd_subclass, agx_subgroup, unit,
              last_unit_price, avg_unit_price, min_unit_price, max_unit_price,
              total_qty, purchase_count, first_seen, last_seen)
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
            `($${p++}::int, $${p++}::text, $${p++}::text, $${p++}::text, ` +
            `$${p++}::numeric, $${p++}::numeric, $${p++}::numeric, $${p++}::numeric, ` +
            `$${p++}::numeric, $${p++}::int, $${p++}::date, $${p++}::date, ` +
            `$${p++}::text, $${p++}::text, $${p++}::text, $${p++}::text, $${p++}::text)`
          );
          params.push(
            u.id, e.description, e.agx_subgroup, e.unit,
            e.last_unit_price, e.avg_unit_price, e.min_unit_price, e.max_unit_price,
            e.total_qty, e.purchase_count, e.first_seen, e.last_seen,
            e.sku, e.internet_sku, e.hd_department, e.hd_class, e.hd_subclass
          );
        }
        await client.query(
          `UPDATE materials AS m SET
             description = v.description,
             agx_subgroup = v.agx_subgroup,
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
             id, description, agx_subgroup, unit,
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
            `($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`
          );
          params.push(
            ap.material_id, ap.p.purchase_date, ap.p.store_number, ap.p.transaction_id,
            ap.p.job_name, ap.p.quantity, ap.p.unit_price, ap.p.net_unit_price,
            ap.p.is_return, sourceFile
          );
        }
        await client.query(
          `INSERT INTO material_purchases
             (material_id, purchase_date, store_number, transaction_id, job_name,
              quantity, unit_price, net_unit_price, is_return, source_file)
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

module.exports = router;
