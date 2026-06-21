'use strict';
// Danger Zone — org "clean slate" hard reset. SYSTEM_ADMIN only.
//   GET  /api/admin/org-reset/preview  → counts of what WOULD be deleted (read-only)
//   POST /api/admin/org-reset/execute  → HARD DELETE (requires typed confirmation)
//
// The destructive work + full scope/safety notes live in
// server/services/org-reset.js. This router is just the gate: system_admin +
// an exact typed confirmation phrase, scoped to the caller's own organization.

const express = require('express');
const { requireAuth, requireSystemAdmin } = require('../auth');
const { previewOrgData, resetOrgData } = require('../services/org-reset');

const router = express.Router();
const CONFIRM_PHRASE = 'RESET MY WORKSPACE';

function orgOf(req) {
  const o = req.user && req.user.organization_id;
  return o ? Number(o) : null;
}

// GET /preview — counts only, ZERO writes.
router.get('/preview', requireAuth, requireSystemAdmin, async (req, res) => {
  try {
    const orgId = orgOf(req);
    if (!orgId) return res.status(400).json({ error: 'No organization on caller' });
    const counts = await previewOrgData(orgId);
    res.json({ ok: true, organization_id: orgId, confirm_phrase: CONFIRM_PHRASE, counts: counts });
  } catch (e) {
    console.error('GET /api/admin/org-reset/preview error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /execute — DESTRUCTIVE + PERMANENT. Hard-deletes leads/jobs/estimates/
// projects + all attached data for the caller's org. Requires the exact typed
// confirmation phrase so it can never fire by accident.
router.post('/execute', requireAuth, requireSystemAdmin, async (req, res) => {
  try {
    const orgId = orgOf(req);
    if (!orgId) return res.status(400).json({ error: 'No organization on caller' });
    const confirm = String((req.body && req.body.confirm) || '');
    if (confirm !== CONFIRM_PHRASE) {
      return res.status(400).json({ error: 'Confirmation phrase mismatch. Type "' + CONFIRM_PHRASE + '" exactly to proceed.' });
    }
    console.warn('[org-reset] HARD RESET requested by user ' + req.user.id + ' for org ' + orgId);
    const result = await resetOrgData(orgId);
    if (!result.ok) {
      console.error('[org-reset] FAILED for org ' + orgId + ':', result.error);
      return res.status(500).json({ ok: false, error: result.error, deleted: result.deleted, skipped: result.skipped });
    }
    console.warn('[org-reset] COMPLETE for org ' + orgId +
      ' — deleted=' + JSON.stringify(result.deleted) + ' skipped=' + JSON.stringify(result.skipped));
    res.json(result);
  } catch (e) {
    console.error('POST /api/admin/org-reset/execute error:', e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

module.exports = router;
