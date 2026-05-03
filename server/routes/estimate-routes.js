const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole, requireCapability } = require('../auth');

const router = express.Router();

// GET /api/estimates - list all estimates (org-wide visibility for now;
// per-user/per-job permissions come later when we move estimates into the ERP layer)
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, owner_id, data, created_at, updated_at FROM estimates ORDER BY updated_at DESC'
    );
    // Surface created_at/updated_at on the returned estimate so the
    // list view can sort/display them. Spread data first so any
    // mistakenly-stored "updated_at" inside the JSONB blob doesn't
    // shadow the canonical column-derived value.
    const estimates = rows.map(r => ({
      ...r.data,
      id: r.id,
      owner_id: r.owner_id,
      created_at: r.created_at,
      updated_at: r.updated_at
    }));
    res.json({ estimates });
  } catch (e) {
    console.error('GET /api/estimates error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/estimates/bulk/save - upsert all estimates from the frontend appData shape.
// Mirrors /api/jobs/bulk/save: takes flat arrays and partitions lines/alternates per estimate.
// Gated on ESTIMATES_EDIT — the role-based gate (admin/pm) was loose; the
// capability is the canonical permission and what the rest of the app's
// admin/role tooling assigns. Roles without ESTIMATES_EDIT (read-only
// users, view-only field crew when that exists) are now correctly blocked.
router.put('/bulk/save', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const { estimates, estimateLines, estimateAlternates } = req.body;
    if (!Array.isArray(estimates)) {
      return res.status(400).json({ error: 'estimates array required' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const est of estimates) {
        const blob = {
          ...est,
          lines: (estimateLines || []).filter(l => l.estimateId === est.id),
        };
        // Alternates: the new full-page editor stores them inline on each
        // estimate as est.alternates (with their scope text). Older callers
        // sent alternates as a flat appData.estimateAlternates array. Keep
        // the editor's inline form when it's there; only fall back to the
        // flat array when the estimate doesn't already carry its own. This
        // was the bug behind "scope didn't save" — the inline alternates
        // were being silently overwritten by the (almost always empty)
        // filtered flat array.
        if (!Array.isArray(blob.alternates) || !blob.alternates.length) {
          blob.alternates = (estimateAlternates || []).filter(a => a.estimateId === est.id);
        }
        await client.query(
          `INSERT INTO estimates (id, owner_id, data) VALUES ($1, $2, $3)
           ON CONFLICT (id) DO UPDATE SET data = $3, updated_at = NOW()`,
          [est.id, req.user.id, JSON.stringify(blob)]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    res.json({ ok: true, count: estimates.length });
  } catch (e) {
    console.error('PUT /api/estimates/bulk/save error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/estimates/:id - admin or owner only
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT owner_id FROM estimates WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (req.user.role !== 'admin' && rows[0].owner_id !== req.user.id) {
      return res.status(403).json({ error: 'No delete access' });
    }
    await pool.query('DELETE FROM estimates WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/estimates/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
