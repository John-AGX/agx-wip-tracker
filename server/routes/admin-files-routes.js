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

// GET /api/admin/files/sub-grants-consistency
//   Sub-access test rig. For every attachment-folder grant on a sub in
//   this org, compare the two ways a grant resolves to files:
//     • legacy STRING join (a.folder = g.folder)
//     • folder_id join     (a.folder_id = g.folder_id)
//   and report any grant where the two sets disagree. In steady state
//   they must be identical (the folder string is dual-written = path),
//   so a clean run is the proof that enforcement could move to folder_id
//   with zero lockouts. The live read/upload paths use the UNION of the
//   two (additive OR), so a disagreement here is a heads-up, never an
//   outage. Org-scoped + ROLES_MANAGE-gated like the rest of this file.
router.get('/sub-grants-consistency', requireAuth, requireOrg, requireCapability('ROLES_MANAGE'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `WITH org_subs AS (
         SELECT id FROM subs WHERE organization_id = $1
       ),
       gr AS (
         SELECT g.id, g.sub_id, g.entity_type, g.entity_id, g.folder, g.folder_id
           FROM attachment_folder_grants g
           JOIN org_subs s ON s.id = g.sub_id
       )
       SELECT gr.id AS grant_id, gr.sub_id, gr.entity_type, gr.entity_id, gr.folder,
              (gr.folder_id IS NOT NULL) AS has_folder_id,
              COUNT(a.id) FILTER (
                WHERE a.folder = gr.folder
                  AND NOT (gr.folder_id IS NOT NULL AND a.folder_id IS NOT NULL AND a.folder_id = gr.folder_id)
              ) AS only_string,
              COUNT(a.id) FILTER (
                WHERE (gr.folder_id IS NOT NULL AND a.folder_id IS NOT NULL AND a.folder_id = gr.folder_id)
                  AND a.folder <> gr.folder
              ) AS only_folderid,
              COUNT(a.id) FILTER (
                WHERE a.folder = gr.folder
                  AND (gr.folder_id IS NOT NULL AND a.folder_id IS NOT NULL AND a.folder_id = gr.folder_id)
              ) AS both
         FROM gr
         LEFT JOIN attachments a
           ON a.entity_type = gr.entity_type
          AND a.entity_id   = gr.entity_id
          AND ( a.folder = gr.folder
                OR (gr.folder_id IS NOT NULL AND a.folder_id = gr.folder_id) )
        GROUP BY gr.id, gr.sub_id, gr.entity_type, gr.entity_id, gr.folder, gr.folder_id
        ORDER BY gr.entity_type, gr.entity_id, gr.folder`,
      [req.organization.id]
    );

    const norm = r => ({
      grant_id: r.grant_id, sub_id: r.sub_id,
      entity_type: r.entity_type, entity_id: r.entity_id, folder: r.folder,
      has_folder_id: !!r.has_folder_id,
      only_string: Number(r.only_string || 0),
      only_folderid: Number(r.only_folderid || 0),
      both: Number(r.both || 0)
    });
    const all = rows.map(norm);
    const inconsistent = all.filter(r => r.only_string > 0 || r.only_folderid > 0);
    const withId = all.filter(r => r.has_folder_id);

    res.json({
      org_id: req.organization.id,
      summary: {
        grants_total: all.length,
        grants_with_folder_id: withId.length,
        grants_without_folder_id: all.length - withId.length,
        grants_inconsistent: inconsistent.length
      },
      // Cap the detail list so a pathological org can't return a huge body.
      inconsistencies: inconsistent.slice(0, 200),
      verdict: inconsistent.length === 0
        ? 'CONSISTENT — string-join and folder_id-join return identical file sets for every grant; folder_id enforcement is lockout-safe.'
        : 'INCONSISTENT — ' + inconsistent.length + ' grant(s) resolve to different file sets by string vs folder_id. The live additive (string OR folder_id) read returns the union, so subs are not locked out; investigate the listed grants.'
    });
  } catch (e) {
    console.error('GET /api/admin/files/sub-grants-consistency error:', e);
    res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
});

module.exports = router;
