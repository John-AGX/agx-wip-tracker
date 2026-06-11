const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole, requireCapability } = require('../auth');

const router = express.Router();

// GET /api/estimates - list all estimates (org-wide visibility for now;
// per-user/per-job permissions come later when we move estimates into the ERP layer)
router.get('/', requireAuth, async (req, res) => {
  try {
    // Wave 1.A Phase 2 — org-scoped list. NULL org_id retained for
    // unbackfilled legacy until NOT NULL tightening.
    const { rows } = await pool.query(
      'SELECT id, owner_id, data, created_at, updated_at FROM estimates WHERE organization_id = $1 OR organization_id IS NULL ORDER BY updated_at DESC',
      [req.user.organization_id]
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
    // P3 — cap bulk sizes before opening the txn. These are far above any
    // realistic full-portfolio save (the handler sends every estimate on
    // each save), so they only stop a runaway / abusive payload.
    if (estimates.length > 5000 ||
        (Array.isArray(estimateLines) && estimateLines.length > 200000) ||
        (Array.isArray(estimateAlternates) && estimateAlternates.length > 20000)) {
      return res.status(400).json({ error: 'Bulk save payload too large' });
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
        // Strip computed-on-render fields before persisting. These are
        // re-derived every time the list renders (computeEstimateTotals),
        // so storing them does two bad things:
        //  1. Bloats the JSONB row with stale numbers.
        //  2. Causes spurious "data changed" diffs that bump updated_at
        //     on every save even when nothing real changed (because the
        //     __totals payload may shift by a fraction-of-a-cent between
        //     renders).
        delete blob.__totals;
        // Canonical column-derived metadata — the server hydrates these
        // onto the response from the dedicated columns (see GET /
        // above), and the client mirrors them into the in-memory
        // estimate object. If we let them ride along inside the JSONB
        // blob, every save's stored blob carries a slightly different
        // `updated_at` from the next round-trip's blob, the upsert's
        // `IS DISTINCT FROM` fires on the timestamp drift alone, and
        // `updated_at` resets to NOW() on every save. That's the
        // bug behind every Estimates-list row showing today's date.
        // Strip them so the comparison only sees real edits.
        delete blob.updated_at;
        delete blob.created_at;
        delete blob.owner_id;
        // Only bump updated_at when the JSONB actually differs from what's
        // stored. The frontend bulk-save sends EVERY estimate on every
        // save, so without this gate, opening any one estimate would
        // refresh the Updated column for the entire list. Postgres'
        // JSONB equality is normalized (key order / whitespace
        // independent), so IS DISTINCT FROM correctly catches real edits.
        // Wave 1.A — include organization_id on new estimates so the
        // org-filtering routes (next commit) find them. Existing rows
        // keep their backfilled value through the ON CONFLICT path.
        await client.query(
          `INSERT INTO estimates (id, owner_id, data, organization_id) VALUES ($1, $2, $3, $4)
           ON CONFLICT (id) DO UPDATE
             SET data = EXCLUDED.data,
                 updated_at = CASE
                   WHEN estimates.data IS DISTINCT FROM EXCLUDED.data THEN NOW()
                   ELSE estimates.updated_at
                 END`,
          [est.id, req.user.id, JSON.stringify(blob), req.user.organization_id]
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

// ──────────────────────────────────────────────────────────────────
// Workspace persistence — surgical jsonb_set on data.workbook
//
// The legacy bulk-save endpoint replaces the entire data blob, which
// races with workbook saves and forces the client to ship the whole
// estimate every keystroke. These endpoints touch ONLY the workbook
// slot under data, so the editor can save independently from the
// line-items grid and 86 can read the workbook without pulling the
// rest of the estimate's payload.
//
// Shape on the wire: the workbook JSON the client serializes is a
// versioned object { version, activeSheetId, sheets, workbookGroupActive }
// — see workspace.js saveWorkspace(). Server-side we don't interpret
// the shape, just store it as a JSONB sub-tree.
// ──────────────────────────────────────────────────────────────────

// GET /api/estimates/:id/workbook — returns null when the slot is empty.
router.get('/:id/workbook', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT data->'workbook' AS workbook
         FROM estimates
        WHERE id = $1
          AND (organization_id = $2 OR organization_id IS NULL)`,
      [req.params.id, req.user.organization_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Estimate not found' });
    res.json({ workbook: rows[0].workbook || null });
  } catch (e) {
    console.error('GET /api/estimates/:id/workbook error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/estimates/:id/workbook — body is the workbook JSON itself,
// not wrapped. ESTIMATES_EDIT-gated because the workbook is part of
// the estimate's takeoff data, not a separate object.
router.put('/:id/workbook', requireAuth, requireCapability('ESTIMATES_EDIT'), async (req, res) => {
  try {
    const wb = req.body;
    if (!wb || typeof wb !== 'object') {
      return res.status(400).json({ error: 'workbook body required' });
    }
    const u = await pool.query(
      `UPDATE estimates
          SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{workbook}', $1::jsonb, true),
              updated_at = NOW()
        WHERE id = $2
          AND (organization_id = $3 OR organization_id IS NULL)`,
      [JSON.stringify(wb), req.params.id, req.user.organization_id]
    );
    if (u.rowCount === 0) return res.status(404).json({ error: 'Estimate not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('PUT /api/estimates/:id/workbook error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/estimates/:id - admin or owner only
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    // Wave 1.A Phase 2 — org-scoped read + delete. Cross-org 404.
    const { rows } = await pool.query(
      'SELECT owner_id FROM estimates WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)',
      [req.params.id, req.user.organization_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (req.user.role !== 'admin' && rows[0].owner_id !== req.user.id) {
      return res.status(403).json({ error: 'No delete access' });
    }
    await pool.query(
      'DELETE FROM estimates WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)',
      [req.params.id, req.user.organization_id]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/estimates/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
