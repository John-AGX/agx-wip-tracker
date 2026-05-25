// Project before/after pairs — CompanyCam's signature feature.
//
// A pair couples two attachments (both must belong to the same
// project, entity_type='project'). The pair surfaces in the photo
// feed as a single tile with a draggable slider that reveals before
// vs after.
//
// Mounted under /api/projects/:projectId/pairs via mergeParams.
//
// Capability: LEADS_VIEW for read, LEADS_EDIT for write — same as
// the parent projects router.

'use strict';

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireCapability } = require('../auth');
const { recordActivity } = require('./project-routes');

const router = express.Router({ mergeParams: true });

function newPairId() {
  return 'pair_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function callerOrgId(req) {
  const oid = req.user && req.user.organization_id;
  if (!oid) return null;
  return Number(oid);
}

// Confirm the project belongs to this caller's org before exposing
// or mutating its pairs. Returns true on match, false otherwise.
async function projectIsInCallerOrg(projectId, orgId) {
  const r = await pool.query(
    'SELECT 1 FROM projects WHERE id = $1 AND organization_id = $2',
    [projectId, orgId]
  );
  return r.rowCount > 0;
}

// GET /api/projects/:projectId/pairs
// List pairs for a project, hydrated with both photos' display
// metadata (filename, thumb_url, web_url, mime_type).
router.get('/', requireAuth, requireCapability('LEADS_VIEW'), async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.json({ pairs: [] });
    if (!(await projectIsInCallerOrg(req.params.projectId, orgId))) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const { rows } = await pool.query(
      'SELECT pp.id, pp.project_id, pp.label, pp.created_at, ' +
      '       pp.created_by, u.name AS created_by_name, ' +
      '       pp.before_attachment_id, ' +
      '       ba.filename   AS before_filename, ' +
      '       ba.mime_type  AS before_mime, ' +
      '       ba.thumb_url  AS before_thumb_url, ' +
      '       ba.web_url    AS before_web_url, ' +
      '       ba.uploaded_at AS before_uploaded_at, ' +
      '       pp.after_attachment_id, ' +
      '       aa.filename   AS after_filename, ' +
      '       aa.mime_type  AS after_mime, ' +
      '       aa.thumb_url  AS after_thumb_url, ' +
      '       aa.web_url    AS after_web_url, ' +
      '       aa.uploaded_at AS after_uploaded_at ' +
      '  FROM project_pairs pp ' +
      '  JOIN attachments ba ON ba.id = pp.before_attachment_id ' +
      '  JOIN attachments aa ON aa.id = pp.after_attachment_id ' +
      '  LEFT JOIN users u ON u.id = pp.created_by ' +
      ' WHERE pp.project_id = $1 ' +
      ' ORDER BY pp.created_at DESC',
      [req.params.projectId]
    );
    res.json({ pairs: rows });
  } catch (e) {
    console.error('GET /api/projects/:projectId/pairs error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/projects/:projectId/pairs
// Body: { before_attachment_id, after_attachment_id, label? }
//
// Both attachments must:
//   - exist
//   - have entity_type='project'
//   - have entity_id = this project's id
// (Prevents pairing photos from different projects or unrelated
// entities, which would render nonsensical in the feed.)
router.post('/', requireAuth, requireCapability('LEADS_EDIT'), async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(404).json({ error: 'Project not found' });
    const projectId = req.params.projectId;
    if (!(await projectIsInCallerOrg(projectId, orgId))) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const body = req.body || {};
    const beforeId = String(body.before_attachment_id || '').trim();
    const afterId = String(body.after_attachment_id || '').trim();
    if (!beforeId || !afterId) {
      return res.status(400).json({ error: 'before_attachment_id and after_attachment_id required' });
    }
    if (beforeId === afterId) {
      return res.status(400).json({ error: 'before and after must be different attachments' });
    }
    const label = typeof body.label === 'string' ? body.label.trim().slice(0, 200) : null;

    // Verify both attachments are this project's photos.
    const check = await pool.query(
      'SELECT id, entity_type, entity_id FROM attachments WHERE id = ANY($1::text[])',
      [[beforeId, afterId]]
    );
    if (check.rowCount !== 2) {
      return res.status(404).json({ error: 'One or both attachments not found' });
    }
    for (let i = 0; i < check.rows.length; i++) {
      const a = check.rows[i];
      if (a.entity_type !== 'project' || a.entity_id !== projectId) {
        return res.status(400).json({ error: 'Both attachments must belong to this project' });
      }
    }

    const id = newPairId();
    await pool.query(
      'INSERT INTO project_pairs (id, project_id, before_attachment_id, after_attachment_id, label, created_by) ' +
      'VALUES ($1, $2, $3, $4, $5, $6)',
      [id, projectId, beforeId, afterId, label, req.user.id]
    );

    // Bump the project's updated_at so list views re-sort with the
    // new pair as recent activity.
    await pool.query(
      'UPDATE projects SET updated_at = NOW() WHERE id = $1',
      [projectId]
    );

    if (typeof recordActivity === 'function') {
      recordActivity(projectId, req.user.id, 'pair_created', {
        pair_id: id,
        label: label,
        before_attachment_id: beforeId,
        after_attachment_id: afterId
      });
    }

    // Return the hydrated row so the caller can render immediately
    // without a second GET.
    const { rows } = await pool.query(
      'SELECT pp.id, pp.project_id, pp.label, pp.created_at, ' +
      '       pp.created_by, u.name AS created_by_name, ' +
      '       pp.before_attachment_id, ba.thumb_url AS before_thumb_url, ba.web_url AS before_web_url, ba.filename AS before_filename, ' +
      '       pp.after_attachment_id, aa.thumb_url AS after_thumb_url, aa.web_url AS after_web_url, aa.filename AS after_filename ' +
      '  FROM project_pairs pp ' +
      '  JOIN attachments ba ON ba.id = pp.before_attachment_id ' +
      '  JOIN attachments aa ON aa.id = pp.after_attachment_id ' +
      '  LEFT JOIN users u ON u.id = pp.created_by ' +
      ' WHERE pp.id = $1',
      [id]
    );
    res.json({ pair: rows[0] });
  } catch (e) {
    console.error('POST /api/projects/:projectId/pairs error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/projects/:projectId/pairs/:pairId
// Removes the pair. Underlying photos stay attached to the project.
router.delete('/:pairId', requireAuth, requireCapability('LEADS_EDIT'), async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(404).json({ error: 'Pair not found' });
    if (!(await projectIsInCallerOrg(req.params.projectId, orgId))) {
      return res.status(404).json({ error: 'Pair not found' });
    }
    const r = await pool.query(
      'DELETE FROM project_pairs WHERE id = $1 AND project_id = $2',
      [req.params.pairId, req.params.projectId]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Pair not found' });
    if (typeof recordActivity === 'function') {
      recordActivity(req.params.projectId, req.user.id, 'pair_deleted', {
        pair_id: req.params.pairId
      });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/projects/:projectId/pairs/:pairId error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
