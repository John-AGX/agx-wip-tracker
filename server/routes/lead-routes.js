const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireCapability } = require('../auth');
const { sendForEvent } = require('../email');

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
  'job_id'
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
  ['estimated_revenue_low', 'estimated_revenue_high'].forEach(function(k) {
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
    const { rows } = await pool.query(`
      SELECT
        l.*,
        c.name AS client_name, c.company_name AS client_company,
        u.name AS salesperson_name
      FROM leads l
      LEFT JOIN clients c ON c.id = l.client_id
      LEFT JOIN users u ON u.id = l.salesperson_id
      WHERE l.id = $1
    `, [req.params.id]);
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
    const cols = ['id', 'created_by'].concat(Object.keys(fields));
    const vals = [id, req.user.id].concat(Object.keys(fields).map(k => fields[k]));
    const placeholders = cols.map((_, i) => '$' + (i + 1)).join(', ');
    await pool.query(
      `INSERT INTO leads (${cols.join(', ')}) VALUES (${placeholders})`,
      vals
    );
    res.json({ ok: true, id });
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
    const prior = await pool.query(
      'SELECT status, salesperson_id FROM leads WHERE id = $1',
      [req.params.id]
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
    await pool.query(`UPDATE leads SET ${sets.join(', ')} WHERE id = $${p}`, params);
    res.json({ ok: true });

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
    const existingLeadsRes = await pool.query('SELECT id, title FROM leads');
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
        const cols = ['id', 'created_by'].concat(Object.keys(fields));
        const vals = [id, req.user.id].concat(Object.keys(fields).map(k => fields[k]));
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

router.delete('/:id', requireAuth, requireCapability('LEADS_EDIT'), async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM leads WHERE id = $1', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Lead not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/leads/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
