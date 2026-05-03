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
  'salutation',
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

// ──────────────────────────────────────────────────────────────────
// Agent notes — small, structured bullets that get auto-injected into
// AI agent system prompts (AG, CRA) when their work touches this
// client. Both the user and the AI agents (with approval) can write
// these. Stored on clients.agent_notes as a JSONB array.
//
// Shape:
//   { id, body, created_at, created_by_user_id, source_agent }
//   source_agent ∈ { null (user), 'ag', 'cra' }
//
// Anyone with ESTIMATES_EDIT can add/remove (same surface as updating
// other client fields). The agent path goes through tool execution,
// which uses these same endpoints under the hood.
// ──────────────────────────────────────────────────────────────────
function newNoteId() {
  return 'note_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

router.post('/:id/notes', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const body = (req.body && typeof req.body.body === 'string') ? req.body.body.trim() : '';
    if (!body) return res.status(400).json({ error: 'body is required' });
    if (body.length > 2000) return res.status(400).json({ error: 'note body cannot exceed 2000 chars' });
    const sourceAgent = (req.body && typeof req.body.source_agent === 'string') ? req.body.source_agent : null;
    if (sourceAgent && sourceAgent !== 'ag' && sourceAgent !== 'cra') {
      return res.status(400).json({ error: 'source_agent must be "ag", "cra", or omitted' });
    }
    const exists = await pool.query('SELECT id FROM clients WHERE id = $1', [req.params.id]);
    if (!exists.rows.length) return res.status(404).json({ error: 'Client not found' });
    const note = {
      id: newNoteId(),
      body,
      created_at: new Date().toISOString(),
      created_by_user_id: req.user ? req.user.id : null,
      source_agent: sourceAgent
    };
    await pool.query(
      `UPDATE clients
         SET agent_notes = COALESCE(agent_notes, '[]'::jsonb) || $1::jsonb,
             updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify([note]), req.params.id]
    );
    res.json({ ok: true, note });
  } catch (e) {
    console.error('POST /api/clients/:id/notes error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/:id/notes/:noteId', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const exists = await pool.query('SELECT id FROM clients WHERE id = $1', [req.params.id]);
    if (!exists.rows.length) return res.status(404).json({ error: 'Client not found' });
    const r = await pool.query(
      `UPDATE clients
         SET agent_notes = COALESCE((
           SELECT jsonb_agg(elem) FROM jsonb_array_elements(agent_notes) elem
            WHERE elem->>'id' <> $1
         ), '[]'::jsonb),
             updated_at = NOW()
       WHERE id = $2
       RETURNING agent_notes`,
      [req.params.noteId, req.params.id]
    );
    res.json({ ok: true, agent_notes: r.rows[0].agent_notes });
  } catch (e) {
    console.error('DELETE /api/clients/:id/notes/:noteId error:', e);
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

// POST /api/clients/import — bulk insert/update clients from a Buildertrend
// export. The client parses the xlsx browser-side (via SheetJS) and POSTs
// a normalized rows array. We dedupe by case-insensitive name, auto-create
// parent clients from any unique `company_name` values, and link children.
//
// Body: { rows: [{ name, company_name?, community_name?, ... }] }
// Returns: { inserted, updated, parentsCreated, total, errors[] }
router.post('/import', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const incoming = Array.isArray(req.body && req.body.rows) ? req.body.rows : null;
    if (!incoming || !incoming.length) {
      return res.status(400).json({ error: 'rows array is required' });
    }

    // Build a name -> id index of the existing directory for case-insensitive
    // dedupe. We do this once up front and keep it in sync as we go.
    const existing = await pool.query('SELECT id, name FROM clients');
    const byName = new Map();
    for (const r of existing.rows) byName.set(String(r.name).trim().toLowerCase(), r.id);

    // Phase 1: ensure a parent client exists for every unique company_name
    // that appears in the incoming rows. If no client with that name exists
    // yet, create a minimal one (just the company name) — its details will
    // be filled in later if a row in the import has its own data for the
    // company (e.g. when the company itself is also exported as a row).
    const companyNames = new Set();
    for (const row of incoming) {
      const c = row.company_name && String(row.company_name).trim();
      if (c) companyNames.add(c);
    }
    let parentsCreated = 0;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const company of companyNames) {
        const key = company.toLowerCase();
        if (byName.has(key)) continue;
        const id = 'client_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        await client.query(
          `INSERT INTO clients (id, name, company_name, client_type)
           VALUES ($1, $2, $2, 'Property Mgmt')`,
          [id, company]
        );
        byName.set(key, id);
        parentsCreated++;
      }

      // Phase 2: per-row upsert. We match by name (case-insensitive) and
      // either UPDATE existing or INSERT new. parent_client_id is resolved
      // from byName via the row's company_name (or null if none / row IS
      // the company itself).
      let inserted = 0;
      let updated = 0;
      const errors = [];
      for (let i = 0; i < incoming.length; i++) {
        const row = incoming[i] || {};
        const name = (row.name || '').trim();
        if (!name) { errors.push({ row: i, error: 'missing name' }); continue; }

        // Resolve parent — a row whose name equals its own company_name is
        // the company itself, so it has no parent.
        let parentId = null;
        if (row.company_name && row.company_name.trim().toLowerCase() !== name.toLowerCase()) {
          parentId = byName.get(row.company_name.trim().toLowerCase()) || null;
        }

        const key = name.toLowerCase();
        const fields = pickEditable(row);
        fields.activation_status = (fields.activation_status || 'active').toLowerCase();

        if (byName.has(key)) {
          // UPDATE: only set non-empty fields so partial rows don't blank
          // out richer existing data.
          const existingId = byName.get(key);
          const sets = [];
          const params = [];
          let p = 1;
          for (const k of Object.keys(fields)) {
            if (fields[k] === '' || fields[k] == null) continue;
            sets.push(k + ' = $' + p++);
            params.push(fields[k]);
          }
          if (parentId) {
            sets.push('parent_client_id = $' + p++);
            params.push(parentId);
          }
          if (sets.length) {
            sets.push('updated_at = NOW()');
            params.push(existingId);
            try {
              await client.query(`UPDATE clients SET ${sets.join(', ')} WHERE id = $${p}`, params);
              updated++;
            } catch (e) {
              errors.push({ row: i, name, error: e.message });
            }
          }
        } else {
          const id = 'client_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
          const cols = ['id', 'name', 'parent_client_id'];
          const vals = [id, name, parentId];
          for (const k of Object.keys(fields)) {
            if (k === 'name') continue;
            if (fields[k] === '' || fields[k] == null) continue;
            cols.push(k);
            vals.push(fields[k]);
          }
          const placeholders = cols.map((_, i) => '$' + (i + 1)).join(', ');
          try {
            await client.query(`INSERT INTO clients (${cols.join(', ')}) VALUES (${placeholders})`, vals);
            byName.set(key, id);
            inserted++;
          } catch (e) {
            errors.push({ row: i, name, error: e.message });
          }
        }
      }

      await client.query('COMMIT');
      res.json({
        ok: true,
        total: incoming.length,
        inserted,
        updated,
        parentsCreated,
        errors
      });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('POST /api/clients/import error:', e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

module.exports = router;
