const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireCapability } = require('../auth');

const router = express.Router();

// Editable client fields. Whitelisted so request bodies can't sneak in
// columns like id/created_at/parent_client_id (parent has its own check).
const EDITABLE_FIELDS = [
  'name', 'client_type', 'activation_status',
  'first_name', 'last_name', 'email',
  'phone', 'cell',
  'address', 'city', 'state', 'zip',
  'company_name', 'community_name', 'market',
  'property_address', 'property_phone', 'website',
  'gate_code', 'additional_pocs',
  'community_manager', 'cm_email', 'cm_phone',
  'maintenance_manager', 'mm_email', 'mm_phone',
  'notes'
];

function pickEditable(body) {
  const out = {};
  for (const k of EDITABLE_FIELDS) {
    if (body[k] !== undefined) out[k] = body[k];
  }
  return out;
}

// GET /api/clients — list all clients with their parent linkage.
// Anyone with ESTIMATES_VIEW can see the directory (estimates point at
// clients, so the same audience needs to read the list).
router.get('/', requireAuth, requireCapability('ESTIMATES_VIEW'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM clients ORDER BY name');
    res.json({ clients: rows });
  } catch (e) {
    console.error('GET /api/clients error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/clients/:id — single client + count of direct children
router.get('/:id', requireAuth, requireCapability('ESTIMATES_VIEW'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM clients WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Client not found' });
    const children = await pool.query(
      'SELECT COUNT(*)::int AS c FROM clients WHERE parent_client_id = $1',
      [req.params.id]
    );
    res.json({ client: rows[0], childCount: children.rows[0].c });
  } catch (e) {
    console.error('GET /api/clients/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/clients — create. parent_client_id is validated against the
// existing set so we don't end up with dangling parents.
router.post('/', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const fields = pickEditable(req.body || {});
    if (!fields.name) return res.status(400).json({ error: 'name is required' });

    const id = (req.body && req.body.id) || ('client_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
    const parentId = req.body && req.body.parent_client_id ? req.body.parent_client_id : null;
    if (parentId) {
      const parent = await pool.query('SELECT id FROM clients WHERE id = $1', [parentId]);
      if (!parent.rows.length) return res.status(400).json({ error: 'parent_client_id does not exist' });
      if (parentId === id) return res.status(400).json({ error: 'A client cannot be its own parent' });
    }

    const cols = ['id', 'parent_client_id'].concat(Object.keys(fields));
    const vals = [id, parentId].concat(Object.keys(fields).map(k => fields[k]));
    const placeholders = cols.map((_, i) => '$' + (i + 1)).join(', ');
    await pool.query(
      `INSERT INTO clients (${cols.join(', ')}) VALUES (${placeholders})`,
      vals
    );
    res.json({ ok: true, id });
  } catch (e) {
    console.error('POST /api/clients error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/clients/:id — update editable fields. parent_client_id can be
// changed (or set to null to detach), with the same validation as create.
router.put('/:id', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const exists = await pool.query('SELECT id FROM clients WHERE id = $1', [req.params.id]);
    if (!exists.rows.length) return res.status(404).json({ error: 'Client not found' });

    const fields = pickEditable(req.body || {});
    const sets = [];
    const params = [];
    let p = 1;
    for (const k of Object.keys(fields)) {
      sets.push(k + ' = $' + p++);
      params.push(fields[k]);
    }
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'parent_client_id')) {
      const parentId = req.body.parent_client_id || null;
      if (parentId) {
        if (parentId === req.params.id) return res.status(400).json({ error: 'A client cannot be its own parent' });
        const parent = await pool.query('SELECT id FROM clients WHERE id = $1', [parentId]);
        if (!parent.rows.length) return res.status(400).json({ error: 'parent_client_id does not exist' });
      }
      sets.push('parent_client_id = $' + p++);
      params.push(parentId);
    }
    if (!sets.length) return res.json({ ok: true, unchanged: true });
    sets.push('updated_at = NOW()');
    params.push(req.params.id);
    await pool.query(`UPDATE clients SET ${sets.join(', ')} WHERE id = $${p}`, params);
    res.json({ ok: true });
  } catch (e) {
    console.error('PUT /api/clients/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/clients/:id — children are detached (parent_client_id -> NULL
// via the FK on-delete rule), not deleted. Estimates referencing this client
// are not modified here yet (no FK exists yet); will be tightened when
// estimates gain a client_id column.
router.delete('/:id', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM clients WHERE id = $1', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Client not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/clients/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
