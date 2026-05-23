// Admin Files — wraps Anthropic's beta.files API for caching photos
// and documents that AG repeatedly references across chat turns.
//
// Today's slice: manual upload trigger via the admin UI. Once an
// attachment has anthropic_file_id set, a future commit can switch
// loadPhotoAsBlock (in ai-routes.js) to reference it by id instead
// of base64-encoding the bytes on every turn — that change requires
// migrating from messages.stream() to beta.messages.stream() because
// file_id image sources only work via the beta path.
//
// Endpoints:
//   POST /api/admin/files/upload-attachment/:id  upload one attachment
//   POST /api/admin/files/upload-recent          bulk upload last N image attachments
//   GET  /api/admin/files/stats                  count uploaded vs not
//
// Admin-gated by ROLES_MANAGE.

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireOrg, requireCapability } = require('../auth');
const { uploadAttachmentToAnthropic } = require('../anthropic-files');

const router = express.Router();

console.log('[admin-files-routes] mounted at /api/admin/files');

// POST /api/admin/files/upload-attachment/:id
router.post('/upload-attachment/:id', requireAuth, requireOrg, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    // Tenant isolation: scope attachment lookup by uploaded_by → users.organization_id.
    // Attachments without an uploaded_by (rare — only when the uploader user
    // was hard-deleted) cannot be targeted by an org-scoped admin call;
    // those need platform-admin tooling. Audit finding C1.
    const r = await pool.query(
      `SELECT a.* FROM attachments a
         JOIN users u ON u.id = a.uploaded_by
        WHERE a.id = $1 AND u.organization_id = $2`,
      [req.params.id, req.organization.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Attachment not found' });
    const att = r.rows[0];
    const fileId = await uploadAttachmentToAnthropic(att);
    res.json({ ok: true, attachment_id: att.id, anthropic_file_id: fileId });
  } catch (e) {
    console.error('POST /api/admin/files/upload-attachment/:id error:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
});

// POST /api/admin/files/upload-recent  body: { limit?: number }
//   Uploads the last N image attachments that don't yet have an
//   anthropic_file_id. Default 25 — keep modest so a single click
//   doesn't drown the API or the admin's wallet. Sequential to
//   keep cost predictable.
router.post('/upload-recent', requireAuth, requireOrg, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, parseInt((req.body && req.body.limit), 10) || 25));
    // Tenant isolation: scope by uploaded_by → users.organization_id.
    // Also: the column is `mime_type` (not `mime`) and `uploaded_at`
    // (not `created_at`) — the prior query referenced two columns
    // that don't exist on this table, so the route was a latent bug
    // alongside the tenant-leak issue. Audit finding C1.
    const r = await pool.query(
      `SELECT a.* FROM attachments a
         JOIN users u ON u.id = a.uploaded_by
        WHERE u.organization_id = $1
          AND a.web_key IS NOT NULL
          AND a.anthropic_file_id IS NULL
          AND COALESCE(a.mime_type, '') LIKE 'image/%'
        ORDER BY a.uploaded_at DESC
        LIMIT $2`,
      [req.organization.id, limit]
    );
    const results = [];
    for (const att of r.rows) {
      try {
        const fileId = await uploadAttachmentToAnthropic(att);
        results.push({ attachment_id: att.id, ok: true, anthropic_file_id: fileId });
      } catch (e) {
        results.push({ attachment_id: att.id, ok: false, error: e.message });
      }
    }
    const okCount = results.filter(x => x.ok).length;
    res.json({ uploaded: okCount, attempted: results.length, results });
  } catch (e) {
    console.error('POST /api/admin/files/upload-recent error:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
});

// GET /api/admin/files/stats
//   Image-attachment summary: how many uploaded to Anthropic vs not.
router.get('/stats', requireAuth, requireOrg, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    // Tenant isolation + correct column name (mime_type, not mime).
    // Audit finding C1 + latent column bug fix.
    const r = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE a.web_key IS NOT NULL AND COALESCE(a.mime_type,'') LIKE 'image/%') AS total_images,
         COUNT(*) FILTER (WHERE a.anthropic_file_id IS NOT NULL) AS uploaded,
         COUNT(*) FILTER (WHERE a.web_key IS NOT NULL AND COALESCE(a.mime_type,'') LIKE 'image/%' AND a.anthropic_file_id IS NULL) AS not_uploaded
         FROM attachments a
         JOIN users u ON u.id = a.uploaded_by
        WHERE u.organization_id = $1`,
      [req.organization.id]
    );
    const row = r.rows[0] || {};
    res.json({
      total_images: Number(row.total_images || 0),
      uploaded: Number(row.uploaded || 0),
      not_uploaded: Number(row.not_uploaded || 0)
    });
  } catch (e) {
    console.error('GET /api/admin/files/stats error:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
});

module.exports = router;
