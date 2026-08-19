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
const { auditLog, auditCritical } = require('../audit');

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
      auditLog(req, {
        action: 'org.hard_reset', outcome: 'denied', reason: 'confirm_mismatch', tier: 'A',
        targetType: 'organization', targetId: String(orgId), organizationId: orgId,
      });
      return res.status(400).json({ error: 'Confirmation phrase mismatch. Type "' + CONFIRM_PHRASE + '" exactly to proceed.' });
    }
    console.warn('[org-reset] HARD RESET requested by user ' + req.user.id + ' for org ' + orgId);

    // THE MOST DESTRUCTIVE OPERATION IN THE CODEBASE, and until now its only
    // trace was two console.warn lines that Railway's retention does not keep.
    // A typed confirmation phrase and requireSystemAdmin are AUTHORISATION;
    // neither is EVIDENCE.
    //
    // Fail closed, and BEFORE the point of no return. resetOrgData runs on its
    // own connection inside its own transaction, so the row cannot join it —
    // and a row written afterwards would be a row that only exists when the
    // destruction happened to succeed. So: an 'attempted' row is written and
    // awaited first (if it cannot be written, NOTHING is deleted), and the
    // terminal ok/error row follows. An 'attempted' with no partner means the
    // process died mid-reset, which is precisely the state you would want to
    // find out about from the trail rather than from a user.
    try {
      await auditCritical(req, {
        action: 'org.hard_reset', outcome: 'attempted', tier: 'A',
        targetType: 'organization', targetId: String(orgId), organizationId: orgId,
        detail: { confirmed: true },
      });
    } catch (auditErr) {
      return res.status(503).json({ error: 'Action refused: it could not be recorded.' });
    }

    const result = await resetOrgData(orgId);
    if (!result.ok) {
      console.error('[org-reset] FAILED for org ' + orgId + ':', result.error);
      auditLog(req, {
        action: 'org.hard_reset', outcome: 'error', reason: 'reset_failed', tier: 'A',
        targetType: 'organization', targetId: String(orgId), organizationId: orgId,
        detail: { deleted: result.deleted, skipped: result.skipped },
      });
      return res.status(500).json({ ok: false, error: result.error, deleted: result.deleted, skipped: result.skipped });
    }
    console.warn('[org-reset] COMPLETE for org ' + orgId +
      ' — deleted=' + JSON.stringify(result.deleted) + ' skipped=' + JSON.stringify(result.skipped));
    // Blast radius, which the handler already has: counts per table, never a row.
    auditLog(req, {
      action: 'org.hard_reset', outcome: 'ok', tier: 'A',
      targetType: 'organization', targetId: String(orgId), organizationId: orgId,
      detail: { deleted: result.deleted, skipped: result.skipped },
    });
    res.json(result);
  } catch (e) {
    console.error('POST /api/admin/org-reset/execute error:', e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

module.exports = router;
