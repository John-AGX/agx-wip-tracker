const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireCapability } = require('../auth');
const { sendForEvent } = require('../email');
const { geocodeAddress, geocodeViaGoogle, geocodeViaCensus } = require('../geocoder');

// ── Lead geocoding (for the leads map view) ─────────────────────────
// Compose a one-line address from the lead's address fields. Returns null
// when there isn't enough to geocode (street alone won't match anyway).
function leadAddressLine(l) {
  const parts = [l.street_address, l.city, l.state, l.zip]
    .map(s => (s == null ? '' : String(s).trim())).filter(Boolean);
  return parts.length >= 2 ? parts.join(', ') : null;
}
// Best-effort: geocode and persist real coords (US Census, free). Never
// writes 0,0; a miss marks geocode_status='failed' (sticky — the boot
// backfill skips it; re-cleared whenever the address fields change).
async function geocodeLead(id) {
  try {
    const r = await pool.query('SELECT street_address, city, state, zip FROM leads WHERE id = $1', [id]);
    if (!r.rowCount) return;
    const addr = leadAddressLine(r.rows[0]);
    if (!addr) return;
    const g = await geocodeAddress(addr);
    if (g && Number.isFinite(g.lat) && Number.isFinite(g.lng) && !(g.lat === 0 && g.lng === 0)) {
      await pool.query(
        "UPDATE leads SET geocode_lat = $1, geocode_lng = $2, geocode_status = 'ok', geocode_at = NOW() WHERE id = $3",
        [g.lat, g.lng, id]
      );
    } else {
      await pool.query(
        "UPDATE leads SET geocode_status = 'failed', geocode_at = NOW() WHERE id = $1", [id]
      );
    }
  } catch (e) { console.error('[leads] geocode error:', e && e.message); }
}
const LEAD_ADDRESS_FIELDS = ['street_address', 'city', 'state', 'zip'];

const router = express.Router();

// Editable fields whitelist — the request body can only set these.
// id / created_by / created_at / updated_at are managed server-side.
const EDITABLE_FIELDS = [
  'client_id', 'title',
  'street_address', 'city', 'state', 'zip',
  'status', 'confidence', 'projected_sale_date',
  'estimated_revenue_low', 'estimated_revenue_high',
  'source', 'project_type',
  'salesperson_id',
  'property_name', 'gate_code', 'market',
  'notes',
  'job_id',
  'geocode_lat', 'geocode_lng'   // accepted from a Places-picked address (skips Census re-geocode)
];

const VALID_STATUSES = new Set(['new', 'in_progress', 'sent', 'lost', 'sold', 'no_opportunity']);

function pickEditable(body) {
  const out = {};
  for (const k of EDITABLE_FIELDS) {
    if (body[k] !== undefined) out[k] = body[k];
  }
  // Normalize / validate
  if (out.status != null && !VALID_STATUSES.has(out.status)) {
    delete out.status;
  }
  if (out.confidence != null) {
    let n = parseInt(out.confidence, 10);
    if (isNaN(n)) n = 0;
    out.confidence = Math.max(0, Math.min(100, n));
  }
  ['estimated_revenue_low', 'estimated_revenue_high', 'geocode_lat', 'geocode_lng'].forEach(function(k) {
    if (out[k] === '' || out[k] == null) { out[k] = null; return; }
    var n = parseFloat(out[k]);
    out[k] = isNaN(n) ? null : n;
  });
  // Empty-string -> null for optional FK / date fields so Postgres accepts them
  ['client_id', 'salesperson_id', 'projected_sale_date', 'job_id'].forEach(function(k) {
    if (out[k] === '') out[k] = null;
  });
  return out;
}

// GET /api/leads — list. Optional filters: ?status=new&client_id=X.
// Joins client and salesperson labels so the UI doesn't need extra lookups.
router.get('/', requireAuth, requireCapability('LEADS_VIEW'), async (req, res) => {
  try {
    const filters = [];
    const params = [];
    let p = 1;
    if (req.query.status) {
      filters.push('l.status = $' + p++);
      params.push(req.query.status);
    }
    if (req.query.client_id) {
      filters.push('l.client_id = $' + p++);
      params.push(req.query.client_id);
    }
    // Wave 1.A Phase 2 — org filter on the list. NULL allowed for
    // unbackfilled legacy rows until NOT NULL tightening.
    filters.push('(l.organization_id = $' + p + ' OR l.organization_id IS NULL)');
    params.push(req.user.organization_id);
    p++;
    const where = filters.length ? 'WHERE ' + filters.join(' AND ') : '';
    const { rows } = await pool.query(`
      SELECT
        l.*,
        c.name AS client_name, c.company_name AS client_company,
        u.name AS salesperson_name
      FROM leads l
      LEFT JOIN clients c ON c.id = l.client_id
      LEFT JOIN users u ON u.id = l.salesperson_id
      ${where}
      ORDER BY l.created_at DESC
    `, params);
    res.json({ leads: rows });
  } catch (e) {
    console.error('GET /api/leads error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/leads/:id — single lead with the same joined labels.
router.get('/:id', requireAuth, requireCapability('LEADS_VIEW'), async (req, res) => {
  try {
    // Wave 1.A Phase 2 — org-scoped GET by id.
    const { rows } = await pool.query(`
      SELECT
        l.*,
        c.name AS client_name, c.company_name AS client_company,
        u.name AS salesperson_name
      FROM leads l
      LEFT JOIN clients c ON c.id = l.client_id
      LEFT JOIN users u ON u.id = l.salesperson_id
      WHERE l.id = $1 AND (l.organization_id = $2 OR l.organization_id IS NULL)
    `, [req.params.id, req.user.organization_id]);
    if (!rows.length) return res.status(404).json({ error: 'Lead not found' });
    res.json({ lead: rows[0] });
  } catch (e) {
    console.error('GET /api/leads/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/', requireAuth, requireCapability('LEADS_EDIT'), async (req, res) => {
  try {
    const fields = pickEditable(req.body || {});
    if (!fields.title) return res.status(400).json({ error: 'title is required' });
    if (!fields.status) fields.status = 'new';

    const id = (req.body && req.body.id) || ('lead_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
    // Wave 1.A — include organization_id on new leads so org-filtering
    // (next commit) finds them. Prepended to the cols/vals arrays.
    const cols = ['id', 'created_by', 'organization_id'].concat(Object.keys(fields));
    const vals = [id, req.user.id, req.user.organization_id].concat(Object.keys(fields).map(k => fields[k]));
    const placeholders = cols.map((_, i) => '$' + (i + 1)).join(', ');
    await pool.query(
      `INSERT INTO leads (${cols.join(', ')}) VALUES (${placeholders})`,
      vals
    );
    res.json({ ok: true, id });
    // Geocode after the response — the map picks the pin up on next load.
    // Skip when the client already supplied real (Places-picked) coords.
    if (LEAD_ADDRESS_FIELDS.some(k => fields[k]) && fields.geocode_lat == null) {
      geocodeLead(id).catch(() => {});
    }
  } catch (e) {
    console.error('POST /api/leads error:', e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

router.put('/:id', requireAuth, requireCapability('LEADS_EDIT'), async (req, res) => {
  try {
    // Fetch the prior status (and salesperson_id) so we can detect a
    // status transition after the UPDATE — drives lead_status_sold /
    // lead_status_lost notification triggers.
    // Wave 1.A Phase 2 — org-scoped read for prior-status check.
    const prior = await pool.query(
      'SELECT status, salesperson_id FROM leads WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)',
      [req.params.id, req.user.organization_id]
    );
    if (!prior.rows.length) return res.status(404).json({ error: 'Lead not found' });
    const oldStatus = prior.rows[0].status;

    const fields = pickEditable(req.body || {});
    const sets = [];
    const params = [];
    let p = 1;
    for (const k of Object.keys(fields)) {
      sets.push(k + ' = $' + p++);
      params.push(fields[k]);
    }
    if (!sets.length) return res.json({ ok: true, unchanged: true });
    sets.push('updated_at = NOW()');
    params.push(req.params.id);
    // Wave 1.A Phase 2 — org filter on the UPDATE WHERE.
    params.push(req.user.organization_id);
    // SAFE: column names sourced from pickEditable(req.body) which iterates the constant EDITABLE_FIELDS allowlist.
    const u = await pool.query(
      `UPDATE leads SET ${sets.join(', ')} WHERE id = $${p} AND (organization_id = $${p + 1} OR organization_id IS NULL)`,
      params
    );
    if (u.rowCount === 0) return res.status(404).json({ error: 'Lead not found' });
    res.json({ ok: true });

    // Address fields changed → re-geocode (after the response; sticky-failed
    // status is overwritten with the fresh result).
    if (LEAD_ADDRESS_FIELDS.some(k => Object.prototype.hasOwnProperty.call(fields, k)) && fields.geocode_lat == null) {
      geocodeLead(req.params.id).catch(() => {});
    }

    // Fire status-change notifications (gated by isEventEnabled).
    // Sold: any prior status → 'sold'. Lost: any prior non-lost/no-opp
    // status → 'lost' or 'no_opportunity'. Skip if status didn't move.
    if (fields.status && fields.status !== oldStatus) {
      var newStatus = fields.status;
      if (newStatus === 'sold' && oldStatus !== 'sold') {
        notifyLeadStatusChange(req.params.id, 'sold', req.user, req.body || {})
          .catch(function(e) { console.warn('[lead_status_sold] notify failed:', e && e.message); });
      } else if ((newStatus === 'lost' || newStatus === 'no_opportunity') &&
                  oldStatus !== 'lost' && oldStatus !== 'no_opportunity') {
        notifyLeadStatusChange(req.params.id, newStatus, req.user, req.body || {})
          .catch(function(e) { console.warn('[lead_status_lost] notify failed:', e && e.message); });
      }
    }
  } catch (e) {
    console.error('PUT /api/leads/:id error:', e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// Build the lead-status-change params payload + recipient and dispatch.
// Recipient is the salesperson assigned to the lead; falls back to the
// user who made the change if no salesperson is set (so the event isn't
// silently swallowed when assignments haven't been filled in yet).
async function notifyLeadStatusChange(leadId, newStatus, changedByUser, body) {
  var sql =
    'SELECT l.id, l.title, l.estimated_revenue_high, l.notes, ' +
    '       c.company_name AS client_company, ' +
    '       u.email AS salesperson_email, u.name AS salesperson_name ' +
    'FROM leads l ' +
    'LEFT JOIN clients c ON c.id = l.client_id ' +
    'LEFT JOIN users u ON u.id = l.salesperson_id ' +
    'WHERE l.id = $1';
  var r = await pool.query(sql, [leadId]);
  if (!r.rows.length) return;
  var row = r.rows[0];
  var to = row.salesperson_email || (changedByUser && changedByUser.email);
  if (!to) return;

  var eventKey = newStatus === 'sold' ? 'lead_status_sold' : 'lead_status_lost';
  var params = {
    lead: {
      title: row.title || '',
      client_company: row.client_company || '',
      estimated_revenue_high: row.estimated_revenue_high
    },
    salesperson: { name: row.salesperson_name || '' },
    changedBy: { name: (changedByUser && changedByUser.name) || (changedByUser && changedByUser.email) || 'someone' }
  };
  if (eventKey === 'lead_status_lost') {
    params.status = newStatus;
    // Use latest notes as the "reason" surface — admin can override
    // template to use any other lead field.
    params.reason = (body && body.notes) || row.notes || '';
  }
  return sendForEvent(eventKey, params, { to: to, tag: eventKey });
}

// POST /api/leads/import — bulk insert leads from a Buildertrend Leads
// xlsx export. The client parses the workbook with SheetJS and POSTs a
// normalized rows array. Each row contains the BT column values; we resolve
// client_id by matching the row's client_name (case-insensitive) against the
// existing clients directory, map BT lead statuses to our enum, and dedupe
// by lowercase title (since BT opportunity titles are unique-ish).
//
// Body: { rows: [{ title, status, confidence, client_name, ... }] }
// Returns: { inserted, skipped, total, errors[] }
router.post('/import', requireAuth, requireCapability('LEADS_EDIT'), async (req, res) => {
  try {
    const incoming = Array.isArray(req.body && req.body.rows) ? req.body.rows : null;
    if (!incoming || !incoming.length) {
      return res.status(400).json({ error: 'rows array is required' });
    }
    if (incoming.length > 5000) { // P3 — cap import batch size (BT imports are far smaller)
      return res.status(400).json({ error: 'Import batch too large (max 5000 rows)' });
    }

    // Build a name -> client.id index for fast lookup. We match either
    // client.name or client.company_name so BT's "ProCura - La Hacienda
    // Condominiums" can resolve even if the directory has only "ProCura".
    const clientsRes = await pool.query('SELECT id, name, company_name FROM clients');
    const clientByName = new Map();
    for (const c of clientsRes.rows) {
      if (c.name) clientByName.set(String(c.name).trim().toLowerCase(), c.id);
      if (c.company_name) {
        const k = String(c.company_name).trim().toLowerCase();
        if (!clientByName.has(k)) clientByName.set(k, c.id);
      }
    }

    // Existing leads keyed by lowercase title — used for dedupe so re-running
    // an import doesn't double-insert the same opportunity.
    // Wave A (A7): scope dedup to the caller's org so a re-import can't match
    // (or skip against) another org's lead. OR-IS-NULL = no-op for AGX.
    const existingLeadsRes = await pool.query(
      'SELECT id, title FROM leads WHERE (organization_id = $1 OR organization_id IS NULL)',
      [req.user.organization_id]
    );
    const existingByTitle = new Map();
    for (const l of existingLeadsRes.rows) {
      if (l.title) existingByTitle.set(String(l.title).trim().toLowerCase(), l.id);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let inserted = 0;
      let skipped = 0;
      const errors = [];

      for (let i = 0; i < incoming.length; i++) {
        const row = incoming[i] || {};
        const title = (row.title || '').trim();
        if (!title) { errors.push({ row: i, error: 'missing title' }); continue; }
        if (existingByTitle.has(title.toLowerCase())) { skipped++; continue; }

        const fields = pickEditable(row);
        fields.title = title;
        if (!fields.status) fields.status = 'new';
        // Resolve client_id from a client_name string passed through by the
        // client-side parser. Leaves null if no match — admin can fix later.
        if (!fields.client_id && row.client_name) {
          const k = String(row.client_name).trim().toLowerCase();
          if (clientByName.has(k)) fields.client_id = clientByName.get(k);
        }

        const id = 'lead_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        // Wave A (A7): stamp organization_id on import so re-imported BT rows
        // carry the right tenant from the start (don't wait for a boot backfill).
        const cols = ['id', 'created_by', 'organization_id'].concat(Object.keys(fields));
        const vals = [id, req.user.id, req.user.organization_id].concat(Object.keys(fields).map(k => fields[k]));
        const placeholders = cols.map((_, idx) => '$' + (idx + 1)).join(', ');
        try {
          await client.query(
            `INSERT INTO leads (${cols.join(', ')}) VALUES (${placeholders})`,
            vals
          );
          existingByTitle.set(title.toLowerCase(), id);
          inserted++;
        } catch (e) {
          errors.push({ row: i, title, error: e.message });
        }
      }

      await client.query('COMMIT');
      res.json({ ok: true, total: incoming.length, inserted, skipped, errors });
      // Geocode the freshly-imported leads in the background so they land on the
      // leads/combined map without waiting for the next boot backfill. The
      // single-create/edit paths geocode inline; the bulk path didn't, which left
      // imported leads address-only (no pin). Best-effort + throttled inside.
      if (inserted > 0) { setTimeout(() => { backfillLeadGeocodes().catch(() => {}); }, 500); }
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('POST /api/leads/import error:', e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// POST /api/leads/geocode-backfill — on-demand kick of the lead geocode
// backfill (handy right after a bulk BT import, since the boot backfill only
// runs at startup). Fire-and-forget; returns the current count of leads still
// needing coords so the caller can poll until it reaches 0. Capped at 300/run
// and throttled inside backfillLeadGeocodes(); re-entrancy-guarded.
router.post('/geocode-backfill', requireAuth, requireCapability('LEADS_EDIT'), async (req, res) => {
  try {
    const retryFailed = !!(req.body && req.body.retryFailed);
    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS pending FROM leads " +
      "WHERE (organization_id = $1 OR organization_id IS NULL) " +
      "AND (street_address IS NOT NULL OR city IS NOT NULL) " +
      "AND (geocode_lat IS NULL OR geocode_lng IS NULL OR (geocode_lat = 0 AND geocode_lng = 0)) " +
      (retryFailed ? "" : "AND geocode_status IS DISTINCT FROM 'failed'"),
      [req.user.organization_id]
    );
    setTimeout(() => { backfillLeadGeocodes({ includeFailed: retryFailed }).catch(() => {}); }, 100);
    res.json({ ok: true, started: true, retryFailed: retryFailed, pending: rows[0] ? rows[0].pending : 0 });
  } catch (e) {
    console.error('POST /api/leads/geocode-backfill error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/leads/geocode-selftest — diagnose geocoding without touching data.
// Surfaces Google's raw status so we can tell if the existing GOOGLE_MAPS_API_KEY
// works server-side (status 'OK') or is blocked ('REQUEST_DENIED' = HTTP-referrer
// restriction or the Geocoding API not enabled on the key). Body: { address? }.
router.post('/geocode-selftest', requireAuth, requireCapability('LEADS_EDIT'), async (req, res) => {
  try {
    const address = ((req.body && req.body.address) || '1201 S Highland Ave, Clearwater, FL 33756').toString().trim();
    const google = await geocodeViaGoogle(address);
    const census = await geocodeViaCensus(address);
    res.json({
      address,
      hasGoogleKey: !!process.env.GOOGLE_MAPS_API_KEY,
      census: census ? { lat: census.lat, lng: census.lng } : null,
      google: (google && google.ok)
        ? { ok: true, lat: google.lat, lng: google.lng }
        : { ok: false, status: google && google.status, error: google && google.error }
    });
  } catch (e) {
    console.error('POST /api/leads/geocode-selftest error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/:id', requireAuth, requireCapability('LEADS_EDIT'), async (req, res) => {
  try {
    // Wave 1.A Phase 2 — org-scoped DELETE.
    const r = await pool.query(
      'DELETE FROM leads WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)',
      [req.params.id, req.user.organization_id]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Lead not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/leads/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── One-time-ish backfill ───────────────────────────────────────────
// Geocode existing leads that have address fields but no usable coords.
// Best-effort + throttled (free Census geocoder); 'failed' rows are skipped
// so unmatchable addresses aren't retried every restart.
let _geocodeBackfillRunning = false;
async function backfillLeadGeocodes(opts) {
  if (_geocodeBackfillRunning) return 0;   // don't overlap boot + on-demand runs
  _geocodeBackfillRunning = true;
  // includeFailed: also retry sticky-'failed' rows — used after adding the
  // Google fallback so Census misses get a second shot at a real provider.
  const includeFailed = !!(opts && opts.includeFailed);
  try {
    const { rows } = await pool.query(
      "SELECT id FROM leads " +
      "WHERE (street_address IS NOT NULL OR city IS NOT NULL) " +
      "AND (geocode_lat IS NULL OR geocode_lng IS NULL OR (geocode_lat = 0 AND geocode_lng = 0)) " +
      (includeFailed ? "" : "AND geocode_status IS DISTINCT FROM 'failed' ") +
      "LIMIT 300"
    );
    for (const l of rows) {
      await geocodeLead(l.id);
      await new Promise(r => setTimeout(r, 250));
    }
    if (rows.length) console.log('[leads] geocode backfill: processed ' + rows.length + ' lead(s)');
    return rows.length;
  } catch (e) { console.error('[leads] geocode backfill error:', e && e.message); return 0; }
  finally { _geocodeBackfillRunning = false; }
}
setTimeout(() => { backfillLeadGeocodes(); }, 12000);   // after boot settles (offset from the projects backfill)

module.exports = router;
