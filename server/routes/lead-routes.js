const express = require('express');
const { pool } = require('../db');
// requireOrgId — see the note in client-routes.js. POST /api/leads bound
// req.user.organization_id straight into the INSERT with no gate, on the plain
// HTTP path, no agent involved: an org-less caller landed a NULL-org lead that
// every tenant could then read through the tolerance arm.
const { requireAuth, requireCapability, requireOrgId, isAdminish } = require('../auth');
// Deleting a lead can now cascade a whole job away (POs, bills, COs, pay apps,
// cost lines, schedule, reports…). That is far too destructive to leave no
// record of, so both delete routes write an audit row. Fire-and-forget.
const { auditLog } = require('../audit');
const { sendForEvent } = require('../email');
const { geocodeAddress, geocodeViaGoogle, geocodeViaCensus } = require('../geocoder');
// Training flywheel — PDF-extraction-vs-saved pairs (see POST / create).
const { captureExample, TASKS } = require('../services/training-capture');

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
  'lost_reason', 'next_followup_at',   // lifecycle: loss category + scheduled next contact
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
  ['client_id', 'salesperson_id', 'projected_sale_date', 'job_id', 'next_followup_at'].forEach(function(k) {
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

router.post('/', requireAuth, requireCapability('LEADS_EDIT'), requireOrgId, async (req, res) => {
  try {
    const fields = pickEditable(req.body || {});
    if (!fields.title) return res.status(400).json({ error: 'title is required' });
    if (!fields.status) fields.status = 'new';

    const id = (req.body && req.body.id) || ('lead_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
    // Wave 1.A — include organization_id on new leads so org-filtering
    // (next commit) finds them. Prepended to the cols/vals arrays.
    const cols = ['id', 'created_by', 'organization_id'].concat(Object.keys(fields));
    const vals = [id, req.user.id, req.orgId].concat(Object.keys(fields).map(k => fields[k]));
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
    // Lead created from a PDF extraction (client rode the raw AI output
    // along, mirroring receipts' b.ocr): log extraction-vs-saved as a
    // training example. accepted = every field the model proposed was
    // kept as-is. Fire-and-forget; after the response.
    const extraction = req.body && req.body.extraction;
    if (extraction && typeof extraction === 'object' && !Array.isArray(extraction)) {
      const norm = (v) => (v == null ? null : String(v).trim().toLowerCase());
      const proposed = pickEditable(extraction);
      const kept = Object.keys(proposed).every((k) => norm(proposed[k]) === norm(fields[k]));
      captureExample({
        id: 'tex_lead_' + id,
        orgId: req.user.organization_id,
        task: TASKS.LEAD_EXTRACT,
        sourceKind: 'lead',
        sourceId: id,
        input: { source: 'bt_lead_print_pdf' },
        modelOutput: proposed,
        humanFinal: fields,
        accepted: kept,
        model: process.env.AI_MODEL || 'claude-opus-4-8'
      });
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
    // Lifecycle auto-stamps on a real status change (literal SQL, no params).
    // status_changed_at bumps every time; converted_at/lost_at stamp on entry
    // to a terminal stage (COALESCE = first time); moving back to an active
    // stage clears the terminal stamps so a re-opened lead reads correctly.
    if (fields.status && fields.status !== oldStatus) {
      sets.push('status_changed_at = NOW()');
      if (fields.status === 'sold') sets.push('converted_at = COALESCE(converted_at, NOW())');
      else if (fields.status === 'lost' || fields.status === 'no_opportunity') sets.push('lost_at = COALESCE(lost_at, NOW())');
      else { sets.push('converted_at = NULL'); sets.push('lost_at = NULL'); }
    }
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
router.post('/import', requireAuth, requireCapability('LEADS_EDIT'), requireOrgId, async (req, res) => {
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
      // Every title we refused to import, so the caller can SEE what was
      // dropped. Previously this was a bare count: a legitimate lead that
      // happened to share a title with an existing one vanished with no
      // record of which one it was.
      //
      // Real case (2026-08-11 BT export): 'Waterside I Siding Replacement'
      // exists twice — one is live job RV2006, the other a separate ~$381k
      // open opportunity with no job attached. Title-matching drops the
      // second. Repeat work at the same property is normal here, so a title
      // collision is a QUESTION for a human, never a verdict.
      const skippedTitles = [];

      for (let i = 0; i < incoming.length; i++) {
        const row = incoming[i] || {};
        const title = (row.title || '').trim();
        if (!title) { errors.push({ row: i, error: 'missing title' }); continue; }
        if (existingByTitle.has(title.toLowerCase())) {
          skipped++;
          skippedTitles.push(title);
          continue;
        }

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
        const vals = [id, req.user.id, req.orgId].concat(Object.keys(fields).map(k => fields[k]));
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
      if (skippedTitles.length) {
        console.warn('[leads/import] skipped ' + skippedTitles.length +
          ' row(s) on title collision — NOT necessarily duplicates: ' +
          skippedTitles.slice(0, 25).join(' | ') +
          (skippedTitles.length > 25 ? ' …+' + (skippedTitles.length - 25) + ' more' : ''));
      }
      res.json({ ok: true, total: incoming.length, inserted, skipped, skippedTitles, errors });
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
      hasGoogleKey: !!(process.env.GEOCODING_API_KEY || process.env.GOOGLE_MAPS_API_KEY),
      keySource: process.env.GEOCODING_API_KEY ? 'GEOCODING_API_KEY' : (process.env.GOOGLE_MAPS_API_KEY ? 'GOOGLE_MAPS_API_KEY' : 'none'),
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

// Which of these leads still carry an UNCONVERTED service ticket?
//
// service_tickets.lead_id is ON DELETE SET NULL, so deleting a lead nulls it.
// For a ticket that has already been converted that is harmless — job_id is
// set, so service_tickets_parent_chk still holds. For a ticket that never
// became a job it is fatal: both parents end up NULL, the CHECK fires, and
// Postgres raises. Unguarded, that surfaces as a blank 500 on a delete the
// user has no way to understand.
//
// So this is a READABLE refusal, not a fix for a crash — the same posture the
// sub-delete guard takes. The org predicate is on the ticket, not inferred
// from the lead, so this cannot be used to probe another tenant's rows.
async function leadsBlockedByTickets(ids, orgId) {
  if (!ids || !ids.length) return [];
  const { rows } = await pool.query(
    `SELECT lead_id, COUNT(*)::int AS n
       FROM service_tickets
      WHERE lead_id = ANY($1::text[])
        AND organization_id = $2
        AND job_id IS NULL
        AND archived_at IS NULL
      GROUP BY lead_id`,
    [ids, orgId]
  );
  return rows;
}

// The guard above lets an ARCHIVED ticket through, because the refusal it
// raises says "close or archive them first" and that has to be true. But an
// archived row is still a row: its lead_id is still set, SET NULL still fires,
// both parents still end up NULL, and the CHECK still raises — so archiving
// alone turned the 409 into a 500. (Found by driving the real doors; the
// source-level tests could not see it.)
//
// So the delete takes its own dead weight with it. An archived ticket that
// never became a job has no meaning once its only parent is gone; a LIVE one
// still blocks, and a CONVERTED one survives untouched because job_id keeps
// the CHECK satisfied. Runs in the caller's transaction so a failed lead
// delete cannot leave tickets already removed.
async function purgeArchivedTicketsForLeads(client, ids, orgId) {
  if (!ids || !ids.length) return 0;
  const r = await client.query(
    `DELETE FROM service_tickets
      WHERE lead_id = ANY($1::text[])
        AND organization_id = $2
        AND job_id IS NULL
        AND archived_at IS NOT NULL`,
    [ids, orgId]
  );
  return r.rowCount || 0;
}

// Cascade the opportunity chain when a lead is deleted. A lead is the TOP of
// lead → estimate(s) → job, so deleting it takes its estimate(s) AND its
// converted job with it. Runs inside the caller's transaction. Estimates link
// to the lead ONLY via the JSONB blob (data->>'lead_id') and to the job via
// data->>'job_id' — no FK — so they must be matched by those, then deleted.
// The job (real column jobs.lead_id) is deleted directly; its structured
// children (POs/COs/bills/pay-apps/subs/cost-lines/schedule/workflow items/
// reports/service tickets/node graph/access) drop via their ON DELETE CASCADE
// FKs, exactly as a direct job delete does. Polymorphic satellites (receipts,
// tasks, attachments, AR invoices) keep their current behavior — not touched
// here (receipts are deliberately preserved).
// SQL fragment: the job(s) a set of leads converted to. The lead↔job link is
// BIDIRECTIONAL (db.js: "lead.job_id <-> jobs.lead_id") and NOTHING keeps the
// halves in step — POST /api/jobs and the bulk upsert never write jobs.lead_id,
// and leads.job_id is directly writable via EDITABLE_FIELDS. Resolving from one
// side alone left the safety apparatus blind (admin gate passed, impact showed
// no job, the job orphaned), so every caller resolves from BOTH.
const LEAD_JOBS_PREDICATE =
  `(lead_id = ANY($1::text[])
    OR id IN (SELECT job_id FROM leads
               WHERE id = ANY($1::text[]) AND job_id IS NOT NULL))
   AND (organization_id = $2 OR organization_id IS NULL)`;

// Open (non-archived, non-terminal) service tickets that cascading these JOBS
// would destroy. db.js states the invariant plainly: "after conversion a ticket
// is about the JOB, and deleting the originating lead must not take the job's
// live work order with it." leadsBlockedByTickets only sees tickets with
// job_id IS NULL, so converted work orders need their own guard. Statuses:
// draft|open|scheduled|in_progress|work_complete|approved|closed|cancelled.
async function openTicketsOnJobs(q, jobIds, orgId) {
  if (!jobIds || !jobIds.length) return 0;
  const { rows } = await q.query(
    `SELECT COUNT(*)::int AS n FROM service_tickets
      WHERE job_id = ANY($1::text[])
        AND organization_id = $2
        AND archived_at IS NULL
        AND status NOT IN ('closed', 'cancelled')`,
    [jobIds, orgId]
  );
  return rows[0] ? rows[0].n : 0;
}

async function deleteLeadChain(client, leadIds, orgId, opts) {
  opts = opts || {};
  if (!leadIds || !leadIds.length) return { estimates: 0, jobs: 0, jobIds: [] };
  // Lock the jobs FIRST — the same order every other route in this chain takes
  // (jobs → estimates → leads), so two concurrent chain deletes can't deadlock,
  // and /link-estimate can't attach a new estimate to a job mid-cascade.
  const jr = await client.query(
    `SELECT id FROM jobs WHERE ${LEAD_JOBS_PREDICATE} FOR UPDATE`,
    [leadIds, orgId]
  );
  const jobIds = jr.rows.map(function (r) { return r.id; });

  // Authoritative, IN-TRANSACTION gate. The pre-flight check runs on a separate
  // pooled connection before BEGIN, so a /convert committing in between would
  // slip a brand-new job past it. Re-decide here against the rows just locked.
  if (jobIds.length && !opts.canDeleteJobs) {
    const e = new Error('This lead has a converted job — an admin must delete it (or delete the job first).');
    e.p86Code = 'ADMIN_REQUIRED';
    throw e;
  }
  // A live work order on the cascaded job would be destroyed by
  // service_tickets.job_id ON DELETE CASCADE. Refuse, matching the wording the
  // lead-side ticket guard already uses.
  const openTickets = await openTicketsOnJobs(client, jobIds, orgId);
  if (openTickets) {
    const e = new Error('The job on this lead has ' + openTickets + ' open service ticket' +
      (openTickets === 1 ? '' : 's') + '. Close or archive ' + (openTickets === 1 ? 'it' : 'them') +
      ' before deleting the lead.');
    e.p86Code = 'OPEN_TICKETS';
    throw e;
  }

  let jobsDeleted = 0;
  if (jobIds.length) {
    const dr = await client.query(
      'DELETE FROM jobs WHERE id = ANY($1::text[]) AND (organization_id = $2 OR organization_id IS NULL)',
      [jobIds, orgId]
    );
    jobsDeleted = dr.rowCount || 0;
  }
  // Estimates last. Match via the lead OR the (now-deleted) job — but NEVER take
  // one a SURVIVING job still depends on: that estimate is another job's cost
  // source and is_locked by the boot backfill, so deleting it here would bypass
  // BOTH the 409 lock refusal and the blob scrub the estimate route performs,
  // leaving that job pointing at a row that is gone. Because the cascade's jobs
  // are already deleted above, any job still referencing an estimate IS a
  // survivor — no id-exclusion list needed.
  const er = await client.query(
    `DELETE FROM estimates
      WHERE (data->>'lead_id' = ANY($1::text[]) OR data->>'job_id' = ANY($2::text[]))
        AND (organization_id = $3 OR organization_id IS NULL)
        AND NOT EXISTS (
              SELECT 1 FROM jobs j
               WHERE j.estimate_id = estimates.id
                  OR j.data->>'estimate_id' = estimates.id)`,
    [leadIds, jobIds, orgId]
  );
  return { estimates: er.rowCount || 0, jobs: jobsDeleted, jobIds: jobIds };
}

// Which of these leads have a converted job? Deleting such a lead cascades the
// job, and direct job deletion is admin-only — so the indirect path is gated to
// admins too. Read-only pre-flight (the authoritative check is in-transaction,
// inside deleteLeadChain). Resolves from BOTH halves of the lead↔job link.
async function leadsWithJobs(ids, orgId) {
  if (!ids || !ids.length) return [];
  const { rows } = await pool.query(
    `SELECT DISTINCT l.id AS lead_id
       FROM leads l
      WHERE l.id = ANY($1::text[])
        AND (l.organization_id = $2 OR l.organization_id IS NULL)
        AND (l.job_id IS NOT NULL
             OR EXISTS (SELECT 1 FROM jobs j
                         WHERE j.lead_id = l.id
                           AND (j.organization_id = $2 OR j.organization_id IS NULL)))`,
    [ids, orgId]
  );
  return rows.map(function (r) { return r.lead_id; });
}

// POST /api/leads/delete-impact — preview what deleting these lead(s) will take
// with them, so the client can show an authoritative warning (not one built from
// a possibly-stale browser cache) and decide when to demand a type-to-confirm.
// A job is "live" when it carries real work or money: POs, vendor bills, change
// orders, AR invoices, QB cost lines, pay applications, captured receipts, or an
// open service ticket. Gated on LEADS_EDIT (it exists to serve a delete — a
// read-only role has no business enumerating financial-liveness). Org-scoped.
router.post('/delete-impact', requireAuth, requireCapability('LEADS_EDIT'), async (req, res) => {
  try {
    const ids = Array.isArray(req.body && req.body.ids)
      ? req.body.ids.filter(function (x) { return typeof x === 'string' && x; })
      : null;
    if (!ids || !ids.length) return res.status(400).json({ error: 'ids array is required' });
    const orgId = req.user.organization_id;
    // Resolve the cascaded jobs from BOTH halves of the lead↔job link — the same
    // predicate deleteLeadChain uses, so the preview and the cascade can't drift.
    const jobs = await pool.query(
      `SELECT j.id,
              COALESCE(j.data->>'jobNumber', '') AS number,
              COALESCE(NULLIF(j.data->>'title', ''), NULLIF(j.data->>'name', ''), '') AS name,
              (EXISTS (SELECT 1 FROM job_purchase_orders p WHERE p.job_id = j.id)
                OR EXISTS (SELECT 1 FROM job_vendor_bills b WHERE b.job_id = j.id)
                OR EXISTS (SELECT 1 FROM job_change_orders c WHERE c.job_id = j.id)
                OR EXISTS (SELECT 1 FROM invoices i WHERE i.job_id = j.id)
                OR EXISTS (SELECT 1 FROM qb_cost_lines q WHERE q.job_id = j.id)
                OR EXISTS (SELECT 1 FROM pay_applications a WHERE a.job_id = j.id)
                OR EXISTS (SELECT 1 FROM receipts rc WHERE rc.entity_type = 'job' AND rc.entity_id = j.id)
                OR EXISTS (SELECT 1 FROM service_tickets t WHERE t.job_id = j.id
                             AND t.archived_at IS NULL AND t.status NOT IN ('closed', 'cancelled'))) AS is_live
         FROM jobs j
        WHERE ${LEAD_JOBS_PREDICATE}`,
      [ids, orgId]
    );
    const jobRows = jobs.rows.map(function (r) {
      return { id: r.id, name: r.name || r.number || 'job', number: r.number || '', isLive: !!r.is_live };
    });
    const jobIds = jobRows.map(function (j) { return j.id; });
    // Estimate count uses the SAME predicate as the cascade — both link arms,
    // minus any a surviving job still depends on (those are deliberately kept).
    const est = await pool.query(
      `SELECT COUNT(*)::int AS n FROM estimates
        WHERE (data->>'lead_id' = ANY($1::text[]) OR data->>'job_id' = ANY($2::text[]))
          AND (organization_id = $3 OR organization_id IS NULL)
          AND NOT EXISTS (
                SELECT 1 FROM jobs j
                 WHERE (j.estimate_id = estimates.id OR j.data->>'estimate_id' = estimates.id)
                   AND j.id <> ALL($2::text[]))`,
      [ids, jobIds, orgId]
    );
    // Open work orders on the cascaded jobs BLOCK the delete (they'd be
    // cascade-deleted with the job). Surface them so the client can say why.
    const openTickets = await openTicketsOnJobs(pool, jobIds, orgId);
    res.json({
      leadCount: ids.length,
      estimateCount: est.rows[0] ? est.rows[0].n : 0,
      jobs: jobRows,
      hasLiveJob: jobRows.some(function (j) { return j.isLive; }),
      openTicketCount: openTickets,
      // The client can refuse up front instead of spending the type-to-confirm
      // on someone the server will 403 anyway.
      canDelete: (jobRows.length === 0 || isAdminish(req.user)) && openTickets === 0
    });
  } catch (e) {
    console.error('POST /api/leads/delete-impact error:', e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// POST /api/leads/bulk-delete — delete many leads in one shot (bulk purge from
// the leads list). Org-scoped like the single DELETE; LEADS_EDIT-gated (a user
// who can delete one lead can delete many). Uses id = ANY(...) so it's a single
// statement regardless of count. Returns the number actually removed.
router.post('/bulk-delete', requireAuth, requireCapability('LEADS_EDIT'), async (req, res) => {
  try {
    const ids = Array.isArray(req.body && req.body.ids)
      ? req.body.ids.filter(function (x) { return typeof x === 'string' && x; })
      : null;
    if (!ids || !ids.length) return res.status(400).json({ error: 'ids array is required' });
    if (ids.length > 5000) return res.status(400).json({ error: 'Too many ids (max 5000)' });
    // Refuse the WHOLE batch rather than deleting the deletable ones: a
    // partial success that reports "deleted" leaves the user believing leads
    // are gone that are not.
    const blocked = await leadsBlockedByTickets(ids, req.user.organization_id);
    if (blocked.length) {
      const n = blocked.reduce(function (a, b) { return a + b.n; }, 0);
      return res.status(409).json({
        error: blocked.length === 1
          ? 'One of these leads has ' + n + ' open service ticket' + (n === 1 ? '' : 's') +
            '. Close or archive them first.'
          : blocked.length + ' of these leads have open service tickets (' + n +
            ' in total). Close or archive them first.',
        blocked_lead_ids: blocked.map(function (b) { return b.lead_id; })
      });
    }
    // Deleting leads that have converted jobs cascades those jobs — admin-gated
    // like direct job deletion (bulk is exactly where over-deletion is riskiest).
    // Pre-flight for a fast 403; deleteLeadChain re-decides inside the tx.
    const canDeleteJobs = isAdminish(req.user);
    const withJobs = await leadsWithJobs(ids, req.user.organization_id);
    if (withJobs.length && !canDeleteJobs) {
      return res.status(403).json({
        error: withJobs.length + ' of these leads have a converted job — an admin must delete them (or delete those jobs first).',
        blocked_lead_ids: withJobs
      });
    }
    // Same atomic pairing as the single delete above.
    const client = await pool.connect();
    let r;
    try {
      await client.query('BEGIN');
      await purgeArchivedTicketsForLeads(client, ids, req.user.organization_id);
      // Chain cascade: estimate(s) + converted job(s) for every selected lead,
      // in the same tx, before the lead rows themselves.
      const chain = await deleteLeadChain(client, ids, req.user.organization_id, { canDeleteJobs: canDeleteJobs });
      r = await client.query(
        'DELETE FROM leads WHERE id = ANY($1::text[]) AND (organization_id = $2 OR organization_id IS NULL)',
        [ids, req.user.organization_id]
      );
      await client.query('COMMIT');
      auditLog(req, {
        action: 'lead.bulk_delete_cascade',
        targetType: 'lead',
        targetId: String(ids.length) + ' leads',
        organizationId: req.user.organization_id,
        detail: { lead_ids: ids, estimates: chain.estimates, jobs: chain.jobs, job_ids: chain.jobIds }
      });
    } catch (inner) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      if (inner && inner.p86Code === 'ADMIN_REQUIRED') return res.status(403).json({ error: inner.message });
      if (inner && inner.p86Code === 'OPEN_TICKETS') return res.status(409).json({ error: inner.message });
      throw inner;
    } finally {
      client.release();
    }
    res.json({ ok: true, deleted: r.rowCount });
  } catch (e) {
    console.error('POST /api/leads/bulk-delete error:', e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// ── Lead survey Site Plan graph ─────────────────────────────────────
// The pre-sale mirror of the job graph routes (job-routes.js /:id/graph),
// backed by lead_graphs instead of node_graphs. Survey geometry only
// (footprints + measurements + photo pins). Org-scoped via the lead row;
// on lead→job conversion this blob is copied into node_graphs.
router.get('/:id/graph', requireAuth, requireCapability('LEADS_VIEW'), async (req, res) => {
  try {
    // Confirm the lead is in the caller's org before returning its graph.
    const lead = await pool.query(
      'SELECT 1 FROM leads WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)',
      [req.params.id, req.user.organization_id]
    );
    if (!lead.rows.length) return res.status(404).json({ error: 'Lead not found' });
    const { rows } = await pool.query('SELECT data FROM lead_graphs WHERE lead_id = $1', [req.params.id]);
    res.json({ graph: rows.length ? rows[0].data : null });
  } catch (e) {
    console.error('GET /api/leads/:id/graph error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/:id/graph', requireAuth, requireCapability('LEADS_EDIT'), async (req, res) => {
  try {
    const lead = await pool.query(
      'SELECT 1 FROM leads WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)',
      [req.params.id, req.user.organization_id]
    );
    if (!lead.rows.length) return res.status(404).json({ error: 'Lead not found' });
    await pool.query(
      `INSERT INTO lead_graphs (lead_id, data) VALUES ($1, $2)
       ON CONFLICT (lead_id) DO UPDATE SET data = $2, updated_at = NOW()`,
      [req.params.id, JSON.stringify(req.body)]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('PUT /api/leads/:id/graph error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/:id', requireAuth, requireCapability('LEADS_EDIT'), async (req, res) => {
  try {
    // An unconverted service ticket on this lead would leave the ticket with
    // no parent at all — see leadsBlockedByTickets. Refuse readably rather
    // than letting the CHECK surface as a 500.
    const blocked = await leadsBlockedByTickets([req.params.id], req.user.organization_id);
    if (blocked.length) {
      const n = blocked[0].n;
      return res.status(409).json({
        error: 'This lead has ' + n + ' open service ticket' + (n === 1 ? '' : 's') +
          '. Close or archive ' + (n === 1 ? 'it' : 'them') + ' before deleting the lead.'
      });
    }
    // Deleting a lead that has a converted job cascades that job — and direct
    // job deletion is admin-only, so the indirect path must clear the same bar.
    // Cheap pre-flight for a fast 403; deleteLeadChain re-decides AUTHORITATIVELY
    // inside the transaction (a /convert can commit between the two).
    const canDeleteJobs = isAdminish(req.user);
    const withJobs = await leadsWithJobs([req.params.id], req.user.organization_id);
    if (withJobs.length && !canDeleteJobs) {
      return res.status(403).json({ error: 'This lead has a converted job — an admin must delete it (or delete the job first).' });
    }
    // Atomic: the chain cascade, archived-ticket purge and lead delete stand or
    // fall together, so a failed delete cannot leave the chain half-removed.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await purgeArchivedTicketsForLeads(client, [req.params.id], req.user.organization_id);
      // Chain cascade: this lead's estimate(s) + its converted job go first,
      // inside the same tx, before the lead row itself.
      const chain = await deleteLeadChain(client, [req.params.id], req.user.organization_id, { canDeleteJobs: canDeleteJobs });
      // Wave 1.A Phase 2 — org-scoped DELETE.
      const r = await client.query(
        'DELETE FROM leads WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)',
        [req.params.id, req.user.organization_id]
      );
      if (!r.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Lead not found' });
      }
      await client.query('COMMIT');
      auditLog(req, {
        action: 'lead.delete_cascade',
        targetType: 'lead',
        targetId: req.params.id,
        organizationId: req.user.organization_id,
        detail: { estimates: chain.estimates, jobs: chain.jobs, job_ids: chain.jobIds }
      });
      res.json({ ok: true });
    } catch (inner) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      // Guards raised from inside the transaction map to real status codes
      // rather than falling through to a bare 500.
      if (inner && inner.p86Code === 'ADMIN_REQUIRED') return res.status(403).json({ error: inner.message });
      if (inner && inner.p86Code === 'OPEN_TICKETS') return res.status(409).json({ error: inner.message });
      throw inner;
    } finally {
      client.release();
    }
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
