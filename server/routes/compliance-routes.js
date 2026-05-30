// Wave 3 — compliance tracking (client COIs, license renewals, lien
// waivers, WC certs). One unified table behind one route file.
//
// Endpoints:
//   GET    /api/compliance-items?entity_type=&entity_id=&type=&status=
//   POST   /api/compliance-items
//   GET    /api/compliance-items/:id
//   PUT    /api/compliance-items/:id
//   POST   /api/compliance-items/:id/archive
//   GET    /api/compliance-items/expiring?days=30
//   GET    /api/compliance-items/expired
//
// All routes are org-scoped via Wave 1.A. Per-type rules live here
// rather than in the schema so they can evolve without migrations.

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

// Per-type vocabulary. Validation happens at the route layer.
const VALID_TYPES = new Set([
  'client_coi',  // certificate of insurance for a client
  'license',     // contractor / driver / professional license
  'lien_waiver', // partial or final lien waiver, per pay period
  'wc_cert',     // workers comp insurance cert
  'other'
]);
const VALID_STATUSES = new Set(['active', 'pending', 'expired', 'archived']);
const VALID_ENTITY_TYPES = new Set(['client', 'sub', 'user', 'job']);

function clampDays(raw, def) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(365, Math.max(1, Math.floor(n)));
}

function validationError(res, msg, detail) {
  return res.status(422).json({ error: msg, detail: detail || { code: 'validation_failed' } });
}

// GET /api/compliance-items — filterable list.
router.get('/', requireAuth, async (req, res) => {
  try {
    const conds = ['(organization_id = $1 OR organization_id IS NULL)', 'archived_at IS NULL'];
    const params = [req.user.organization_id];
    let p = 2;
    if (req.query.entity_type) {
      const et = String(req.query.entity_type).toLowerCase();
      if (!VALID_ENTITY_TYPES.has(et)) {
        return validationError(res, 'invalid entity_type', {
          code: 'invalid_enum', field_path: 'entity_type', received: et, expected: [...VALID_ENTITY_TYPES]
        });
      }
      conds.push('entity_type = $' + p); params.push(et); p++;
    }
    if (req.query.entity_id) {
      conds.push('entity_id = $' + p); params.push(String(req.query.entity_id)); p++;
    }
    if (req.query.type) {
      conds.push('type = $' + p); params.push(String(req.query.type).toLowerCase()); p++;
    }
    if (req.query.status) {
      conds.push('status = $' + p); params.push(String(req.query.status).toLowerCase()); p++;
    }
    const r = await pool.query(
      `SELECT id, entity_type, entity_id, type, status, title,
              effective_date, expiration_date, file_attachment_id,
              metadata, notes, created_at, updated_at
         FROM compliance_items
        WHERE ${conds.join(' AND ')}
        ORDER BY (CASE WHEN expiration_date IS NULL THEN 1 ELSE 0 END),
                 expiration_date ASC
        LIMIT 500`,
      params
    );
    res.json({ items: r.rows });
  } catch (err) {
    console.error('[compliance] list failed:', err.message);
    res.status(500).json({ error: 'Failed to list compliance items' });
  }
});

// GET /api/compliance-items/expiring?days=30 — items with expiration_date
// in the next N days. Always sorted ascending so the most-urgent are first.
router.get('/expiring', requireAuth, async (req, res) => {
  try {
    const days = clampDays(req.query.days, 30);
    const r = await pool.query(
      `SELECT id, entity_type, entity_id, type, status, title,
              expiration_date,
              (expiration_date - CURRENT_DATE) AS days_until_expiry,
              metadata
         FROM compliance_items
        WHERE (organization_id = $1 OR organization_id IS NULL)
          AND archived_at IS NULL
          AND expiration_date IS NOT NULL
          AND expiration_date BETWEEN CURRENT_DATE AND CURRENT_DATE + ($2 || ' days')::interval
          AND status NOT IN ('expired', 'archived')
        ORDER BY expiration_date ASC`,
      [req.user.organization_id, days]
    );
    res.json({ window_days: days, items: r.rows });
  } catch (err) {
    console.error('[compliance] expiring failed:', err.message);
    res.status(500).json({ error: 'Failed to list expiring items' });
  }
});

// GET /api/compliance-items/expired — items past their expiration.
router.get('/expired', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, entity_type, entity_id, type, status, title,
              expiration_date,
              (CURRENT_DATE - expiration_date) AS days_overdue,
              metadata
         FROM compliance_items
        WHERE (organization_id = $1 OR organization_id IS NULL)
          AND archived_at IS NULL
          AND expiration_date IS NOT NULL
          AND expiration_date < CURRENT_DATE
          AND status != 'archived'
        ORDER BY expiration_date ASC`,
      [req.user.organization_id]
    );
    res.json({ items: r.rows });
  } catch (err) {
    console.error('[compliance] expired failed:', err.message);
    res.status(500).json({ error: 'Failed to list expired items' });
  }
});

// GET /:id — single item.
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM compliance_items
        WHERE id = $1
          AND (organization_id = $2 OR organization_id IS NULL)
          AND archived_at IS NULL`,
      [req.params.id, req.user.organization_id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ item: r.rows[0] });
  } catch (err) {
    console.error('[compliance] get failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch' });
  }
});

// POST /api/compliance-items — create.
router.post('/', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const entity_type = String(body.entity_type || '').toLowerCase();
    const type = String(body.type || '').toLowerCase();
    if (!VALID_ENTITY_TYPES.has(entity_type)) {
      return validationError(res, 'invalid entity_type', {
        code: 'invalid_enum', field_path: 'entity_type',
        received: entity_type, expected: [...VALID_ENTITY_TYPES]
      });
    }
    if (!VALID_TYPES.has(type)) {
      return validationError(res, 'invalid type', {
        code: 'invalid_enum', field_path: 'type',
        received: type, expected: [...VALID_TYPES]
      });
    }
    if (!body.entity_id) {
      return validationError(res, 'entity_id required', {
        code: 'missing_field', field_path: 'entity_id'
      });
    }
    if (!body.title || !String(body.title).trim()) {
      return validationError(res, 'title required', {
        code: 'missing_field', field_path: 'title'
      });
    }
    const status = body.status ? String(body.status).toLowerCase() : 'active';
    if (!VALID_STATUSES.has(status)) {
      return validationError(res, 'invalid status', {
        code: 'invalid_enum', field_path: 'status',
        received: status, expected: [...VALID_STATUSES]
      });
    }
    const id = 'cmp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const r = await pool.query(
      `INSERT INTO compliance_items
         (id, organization_id, entity_type, entity_id, type, status, title,
          effective_date, expiration_date, file_attachment_id, metadata, notes,
          created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
       RETURNING *`,
      [
        id, req.user.organization_id,
        entity_type, String(body.entity_id),
        type, status, String(body.title).trim(),
        body.effective_date || null,
        body.expiration_date || null,
        body.file_attachment_id || null,
        JSON.stringify(body.metadata || {}),
        body.notes ? String(body.notes) : null,
        req.user.id
      ]
    );
    res.json({ ok: true, item: r.rows[0] });
  } catch (err) {
    console.error('[compliance] create failed:', err.message);
    res.status(500).json({ error: 'Failed to create' });
  }
});

// PUT /:id — update.
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const existing = await pool.query(
      `SELECT id, type, metadata FROM compliance_items
        WHERE id = $1
          AND (organization_id = $2 OR organization_id IS NULL)
          AND archived_at IS NULL`,
      [req.params.id, req.user.organization_id]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Not found' });
    const cur = existing.rows[0];
    const sets = [];
    const params = [];
    let p = 1;
    function set(col, val) { sets.push(`${col} = $${p}`); params.push(val); p++; }
    if (body.title != null) set('title', String(body.title).trim());
    if (body.status != null) {
      const s = String(body.status).toLowerCase();
      if (!VALID_STATUSES.has(s)) {
        return validationError(res, 'invalid status', {
          code: 'invalid_enum', field_path: 'status',
          received: s, expected: [...VALID_STATUSES]
        });
      }
      set('status', s);
    }
    if (body.effective_date !== undefined) set('effective_date', body.effective_date || null);
    if (body.expiration_date !== undefined) set('expiration_date', body.expiration_date || null);
    if (body.file_attachment_id !== undefined) set('file_attachment_id', body.file_attachment_id || null);
    if (body.notes !== undefined) set('notes', body.notes ? String(body.notes) : null);
    if (body.metadata && typeof body.metadata === 'object') {
      const merged = Object.assign({}, cur.metadata || {}, body.metadata);
      set('metadata', JSON.stringify(merged));
      sets[sets.length - 1] = sets[sets.length - 1] + '::jsonb';
    }
    if (!sets.length) return res.json({ ok: true, unchanged: true });
    sets.push('updated_at = NOW()');
    params.push(req.params.id);
    params.push(req.user.organization_id);
    const r = await pool.query(
      `UPDATE compliance_items SET ${sets.join(', ')}
        WHERE id = $${p} AND (organization_id = $${p + 1} OR organization_id IS NULL)
        RETURNING *`,
      params
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, item: r.rows[0] });
  } catch (err) {
    console.error('[compliance] update failed:', err.message);
    res.status(500).json({ error: 'Failed to update' });
  }
});

// POST /:id/archive — soft delete.
router.post('/:id/archive', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE compliance_items SET archived_at = NOW(), status = 'archived', updated_at = NOW()
        WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)
          AND archived_at IS NULL
        RETURNING id`,
      [req.params.id, req.user.organization_id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found or already archived' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[compliance] archive failed:', err.message);
    res.status(500).json({ error: 'Failed to archive' });
  }
});

module.exports = router;
